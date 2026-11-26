import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditStore } from '../src/activities/auditStore';
import type { StoredAuditEvent } from '../src/activities/auditStore';
import { buildCases, buildFlow, casesToCsv, filterCases, filterEvents } from '../src/reports/flow';
import { auditReport, caseReport } from '../src/reports/pdf';
import type { ApplicationStatus } from '../src/shared/types';

let n = 0;
function caseEvents(id: string, path: ApplicationStatus[], o: { product?: 'PERSONAL' | 'AUTO'; reviewer?: string; reason?: string; at?: number } = {}): StoredAuditEvent[] {
  const base = { applicationId: id, runId: 'run-1', productType: o.product ?? 'PERSONAL', channel: 'PORTAL' as const, recordedAt: '' };
  const at = (i: number) => new Date(Date.UTC(2026, 10, 26, 10, o.at ?? 0, i)).toISOString();
  const evs: StoredAuditEvent[] = [{ ...base, type: 'APPLICATION_RECEIVED', actor: 'channel:portal', at: at(0), to: 'RECEIVED', details: { applicantName: `Name ${id}`, amount: 12_000 }, eventKey: String(++n) }];
  let from: ApplicationStatus = 'RECEIVED';
  path.forEach((to, i) => {
    if (to === 'AWAITING_SIGNATURE' && o.reviewer) evs.push({ ...base, type: 'REVIEW_DECISION', actor: `reviewer:${o.reviewer}`, at: at(i + 1), reason: 'ok', details: { decision: 'APPROVE' }, eventKey: String(++n) });
    evs.push({ ...base, type: 'TRANSITION', actor: 'system', at: at(i + 1), from, to, reason: i === path.length - 1 ? o.reason : undefined, eventKey: String(++n) });
    from = to;
  });
  return evs;
}

const events = [
  ...caseEvents('a', ['VALIDATING', 'ENRICHING', 'UNDERWRITING', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED'], { reason: 'FUNDED: loan LN-1' }),
  ...caseEvents('b', ['VALIDATING', 'ENRICHING', 'UNDERWRITING', 'HUMAN_REVIEW', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED'], { reviewer: 'alice', product: 'AUTO', at: 5 }),
  ...caseEvents('c', ['VALIDATING', 'DECLINED'], { reason: 'VALIDATION_FAILED: APPLICANT_UNDER_18', at: 10 }),
  ...caseEvents('d', ['VALIDATING', 'ENRICHING', 'AWAITING_PROVIDER'], { at: 15 }),
];

describe('audit reporting', () => {
  it('folds the log into cases with latest reason and reviewers', () => {
    const cases = buildCases(events);
    expect(cases.find((c) => c.applicationId === 'b')).toMatchObject({ status: 'FUNDED', reviewers: ['alice'], productType: 'AUTO' });
    expect(cases.find((c) => c.applicationId === 'c')?.lastReason).toMatch(/UNDER_18/);
  });

  it('filters cases by state, open, product, date range and free text', () => {
    const cases = buildCases(events);
    const ids = (f: Parameters<typeof filterCases>[1]) => filterCases(cases, f).map((c) => c.applicationId).sort();
    expect(ids({ status: 'FUNDED' })).toEqual(['a', 'b']);
    expect(ids({ status: 'OPEN' })).toEqual(['d']);
    expect(ids({ product: 'AUTO' })).toEqual(['b']);
    expect(ids({ from: '2026-11-26T10:09:00.000Z' })).toEqual(['c', 'd']);
    expect(ids({ q: 'alice' })).toEqual(['b']);
    expect(ids({ q: 'under_18' })).toEqual(['c']);
    expect(filterEvents(events, { actor: 'reviewer:' }).map((e) => e.applicationId)).toEqual(['b']);
  });

  it('summarises state distribution and outcomes', () => {
    const s = buildFlow(buildCases(events));
    expect(s.byStatus).toMatchObject({ FUNDED: 2, DECLINED: 1, AWAITING_PROVIDER: 1 });
    expect(s).toMatchObject({ total: 4, inFlight: 1, manuallyReviewed: 1, fundedVolume: 24_000 });
    expect(s.fundingRate).toBeCloseTo(2 / 3);
    expect(s.outcomes.find((o) => o.status === 'DECLINED')?.reason).toBe('VALIDATION_FAILED');
    expect(casesToCsv(buildCases(events)).split('\n')[0]).toContain('reviewers');
  });

  it('renders a multi-page audit report with the case table and trail', async () => {
    const many = Array.from({ length: 80 }, (_, i) => caseEvents(`bulk-${i}`, ['VALIDATING', 'ENRICHING', 'UNDERWRITING', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED'], { at: i % 50 })).flat();
    const cases = buildCases(many);
    const pdf = await auditReport({ flow: buildFlow(cases), cases, events: many, filterLabel: 'none' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(3);
  });

  it('renders a per-case report with lifecycle and audit trail', async () => {
    const evs = events.filter((e) => e.applicationId === 'b');
    const pdf = await caseReport({ record: buildCases(evs)[0], events: evs });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5_000);
  });
});

describe('audit log rotation (demo reset)', () => {
  it('archives the whole file untouched and starts a new one with only the kept events', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rotate-'));
    const store = new AuditStore(path.join(dir, 'audit.jsonl'));
    const ev = (applicationId: string, i: number) => ({ applicationId, runId: 'r', type: 'TRANSITION', actor: 'system', at: `2026-11-26T10:00:0${i}.000Z`, productType: 'PERSONAL' as const, channel: 'PORTAL' as const });
    store.append(ev('keep-1', 1), 'k1'); store.append(ev('syn-1', 2), 's1'); store.append(ev('keep-1', 3), 'k2');
    const r = store.rotate((e) => !e.applicationId.startsWith('syn-'));
    expect(r).toMatchObject({ keptEvents: 2, removedEvents: 1 });
    expect(store.readAll().map((e) => e.eventKey)).toEqual(['k1', 'k2']);
    const archived = readdirSync(path.join(dir, 'archive'));
    expect(archived).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'archive', archived[0]), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(store.append(ev('syn-1', 4), 's2')).toBe(true); // the store keeps working after rotation
  });
});
