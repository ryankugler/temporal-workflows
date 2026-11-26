import { msToNumber } from '@temporalio/common/lib/time';
import { describe, expect, it } from 'vitest';
import { PACKS, SCENARIOS, timingFor } from '../src/ingest/scenarios';
import { DEMO_TIMING } from '../src/shared/types';
import { priceLoan, TARIFF } from '../src/billing/tariff';
import { billingSummary } from '../src/reports/billing';
import type { CaseRecord } from '../src/reports/flow';
import { buildSlaBoard } from '../src/reports/sla';
import type { StoredCharge } from '../src/billing/store';

describe('tariff', () => {
  it('prices flat + bps, clamped to the minimum and cap', () => {
    expect(priceLoan('PERSONAL', 20_000)).toMatchObject({ account: 'Personal Lending', fee: 195, breakdown: { flat: 95, variable: 100, minApplied: false, capApplied: false } });
    expect(priceLoan('PERSONAL', 5_000).fee).toBe(150); // 95 + 25 = 120, raised to the 150 minimum
    expect(priceLoan('PERSONAL', 5_000).breakdown.minApplied).toBe(true);
    expect(priceLoan('DEBT_CONSOLIDATION', 400_000).fee).toBe(TARIFF.DEBT_CONSOLIDATION.cap);
    expect(priceLoan('AUTO', 30_000).fee).toBe(180); // 75 + 105
  });
});

const now = Date.parse('2026-11-26T12:00:00.000Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const caseRec = (id: string, o: Partial<CaseRecord>): CaseRecord => ({
  applicationId: id, applicantName: id, productType: 'PERSONAL', channel: 'PORTAL', amount: 10_000, receivedAt: at(0), updatedAt: at(0),
  status: 'HUMAN_REVIEW', path: [], reviewers: [], slaBreached: false, slaAtRisk: false, eventCount: 1, lastActivityAt: o.updatedAt ?? at(0), ...o,
});

describe('SLA risk board', () => {
  const cfg = { overallSlaMs: 240_000, atRiskAfterMs: 150_000, staleAfterMs: 45_000 };

  it('sorts open applications into breached, at risk and stale, least time left first', () => {
    const board = buildSlaBoard([
      caseRec('breached', { receivedAt: at(300_000), updatedAt: at(10_000) }),
      caseRec('flagged', { receivedAt: at(60_000), updatedAt: at(1_000), slaAtRisk: true }),
      caseRec('past-risk-point', { receivedAt: at(200_000), updatedAt: at(1_000), status: 'AWAITING_DOCS' }),
      caseRec('stale', { receivedAt: at(80_000), updatedAt: at(60_000), status: 'AWAITING_PROVIDER' }),
      caseRec('fresh', { receivedAt: at(20_000), updatedAt: at(5_000) }),
      caseRec('done', { receivedAt: at(900_000), updatedAt: at(900_000), status: 'FUNDED' }),
    ], now, cfg);
    expect(board.breached.map((i) => i.applicationId)).toEqual(['breached']);
    expect(board.atRisk.map((i) => i.applicationId)).toEqual(['past-risk-point', 'flagged']); // less time left first
    expect(board.stale.map((i) => i.applicationId)).toEqual(['stale']);
    expect(board.stale[0]).toMatchObject({ waitingOn: 'Provider recovery', needsPerson: false });
    expect(board.atRisk[0]).toMatchObject({ waitingOn: 'Applicant documents', needsPerson: true });
    expect(board.counts).toMatchObject({ breached: 1, atRisk: 2, stale: 1 });
    expect(board.feesAtStake).toBe(4 * priceLoan('PERSONAL', 10_000).fee);
  });

  it('uses the deadline recorded by the workflow when there is one', () => {
    const board = buildSlaBoard([caseRec('custom', { receivedAt: at(10_000), updatedAt: at(1_000), slaDeadline: at(-5_000), slaAtRiskAt: at(1) })], now, cfg);
    expect(board.atRisk[0]).toMatchObject({ applicationId: 'custom', msLeft: 5_000 });
  });
});

describe('billing summary', () => {
  it('puts billed revenue next to applications that closed without funding', () => {
    const charge = (id: string, fee: number, account: string): StoredCharge => ({
      chargeId: `chg-${id}`, applicationId: id, account, productType: 'PERSONAL', channel: 'PORTAL', principal: 10_000, fee, currency: 'USD',
      breakdown: { flat: 95, variable: 50, bps: 50, minApplied: false, capApplied: false }, tariffVersion: 't', loanNumber: 'LN', payoutRef: 'PO',
      fundedAt: '2026-11-26T10:00:00.000Z', period: '2026-11', recordedAt: '',
    });
    const s = billingSummary([charge('a', 150, 'Personal Lending'), charge('b', 200, 'Auto Lending'), charge('c', 175, 'Personal Lending')], [
      caseRec('a', { status: 'FUNDED' }), caseRec('b', { status: 'FUNDED' }), caseRec('c', { status: 'FUNDED' }),
      caseRec('d', { status: 'DECLINED' }), caseRec('e', { status: 'ESCALATED' }), caseRec('f', { status: 'HUMAN_REVIEW' }),
    ]);
    expect(s.totals).toMatchObject({ charges: 3, billed: 525, averageFee: 175 });
    expect(s.outcomes).toMatchObject({ closed: 5, funded: 3, notBillable: 2, declined: 1, escalated: 1 });
    expect(s.outcomes.billableRate).toBeCloseTo(0.6);
    expect(s.byAccount[0]).toMatchObject({ key: 'Personal Lending', charges: 2, billed: 325 });
    expect(s.pipeline.open).toBe(1);
  });
});

describe('SLA pressure scenarios', () => {
  it('the pack only uses real scenarios, and each SLA scenario breaches long before anything else times out', () => {
    for (const item of PACKS['sla-pressure'].items) expect(SCENARIOS[item.scenario]).toBeDefined();
    for (const name of ['sla-breach-review', 'sla-breach-docs', 'sla-breach-signature', 'sla-at-risk-review', 'sla-at-risk-docs']) {
      const t = { ...DEMO_TIMING, ...timingFor(name, DEMO_TIMING) };
      const sla = msToNumber(t.overallSla);
      expect(msToNumber(t.slaAtRiskAfter)).toBeLessThan(sla);
      for (const other of [t.reviewTimeout, t.docsReminder, t.signatureReminder]) expect(msToNumber(other)).toBeGreaterThan(name.includes('breach') ? sla : msToNumber(t.slaAtRiskAfter));
    }
    expect(timingFor('happy', DEMO_TIMING)).toBe(DEMO_TIMING); // normal scenarios keep the run's timing
  });
});
