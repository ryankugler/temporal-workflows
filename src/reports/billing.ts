/**
 * Billing reports from the billing ledger (charges) and the audit log (outcomes). Only funded loans are
 * billable, so the report puts billed revenue next to the applications that closed without funding.
 */
import type { StoredCharge } from '../billing/store';
import { expectedFee } from '../billing/tariff';
import { isTerminal } from '../shared/types';
import type { CaseRecord } from './flow';

export interface BillingFilter { account?: string; product?: string; channel?: string; period?: string; from?: string; to?: string }

export function filterCharges(charges: StoredCharge[], f: BillingFilter): StoredCharge[] {
  return charges.filter((c) =>
    (!f.account || c.account === f.account) &&
    (!f.product || c.productType === f.product) &&
    (!f.channel || c.channel === f.channel) &&
    (!f.period || c.period === f.period) &&
    (!f.from || c.fundedAt >= f.from) &&
    (!f.to || c.fundedAt <= f.to));
}

const money = (n: number) => Math.round(n * 100) / 100;

function group<K extends string>(charges: StoredCharge[], key: (c: StoredCharge) => K) {
  const m = new Map<K, { key: K; charges: number; billed: number; principal: number }>();
  for (const c of charges) {
    const k = key(c);
    const g = m.get(k) ?? { key: k, charges: 0, billed: 0, principal: 0 };
    g.charges++;
    g.billed = money(g.billed + c.fee);
    g.principal += c.principal;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.billed - a.billed);
}

export function billingSummary(charges: StoredCharge[], cases: CaseRecord[]) {
  const billed = money(charges.reduce((s, c) => s + c.fee, 0));
  const closed = cases.filter((c) => isTerminal(c.status));
  const funded = closed.filter((c) => c.status === 'FUNDED').length;
  const open = cases.filter((c) => !isTerminal(c.status));
  return {
    totals: {
      charges: charges.length,
      billed,
      principal: charges.reduce((s, c) => s + c.principal, 0),
      averageFee: charges.length ? money(billed / charges.length) : 0,
    },
    outcomes: {
      closed: closed.length,
      funded,
      notBillable: closed.length - funded,
      declined: closed.filter((c) => c.status === 'DECLINED').length,
      escalated: closed.filter((c) => c.status === 'ESCALATED').length,
      billableRate: closed.length ? funded / closed.length : null,
    },
    pipeline: { open: open.length, expectedFees: money(open.reduce((s, c) => s + expectedFee(c.productType, c.amount), 0)) },
    byAccount: group(charges, (c) => c.account),
    byChannel: group(charges, (c) => c.channel),
    byPeriod: group(charges, (c) => c.period).sort((a, b) => b.key.localeCompare(a.key)),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function chargesToCsv(charges: StoredCharge[]): string {
  const cols = ['chargeId', 'applicationId', 'account', 'productType', 'channel', 'brokerId', 'principal', 'fee', 'currency', 'tariffVersion', 'loanNumber', 'payoutRef', 'fundedAt', 'period', 'recordedAt'] as const;
  return [cols.join(','), ...charges.map((c) => cols.map((k) => csvCell(c[k])).join(','))].join('\n') + '\n';
}
