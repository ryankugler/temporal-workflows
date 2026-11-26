/**
 * SLA risk board: open applications that are breaching, about to breach, or have gone stale, so reviewers
 * can see at a glance which ones need a person now.
 *
 *   BREACHED  past the overall SLA deadline
 *   AT_RISK   the workflow flagged SLA_AT_RISK, or the at-risk point has passed
 *   STALE     no activity for staleAfter (nothing has happened to it, so someone probably needs to act)
 *
 * Within each column the least time left comes first. Built from the audit log (received time, deadline,
 * last activity), so it costs no per-workflow queries; claims are added for review items by the caller.
 */
import { expectedFee } from '../billing/tariff';
import { isTerminal, type ApplicationStatus } from '../shared/types';
import type { CaseRecord } from './flow';

export type SlaRisk = 'BREACHED' | 'AT_RISK' | 'STALE';

export interface SlaItem {
  applicationId: string;
  applicantName: string;
  productType: CaseRecord['productType'];
  channel: CaseRecord['channel'];
  amount: number;
  status: ApplicationStatus;
  waitingOn: string;
  needsPerson: boolean;
  receivedAt: string;
  slaDeadline: string;
  msLeft: number;
  pctUsed: number;
  lastActivityAt: string;
  staleMs: number;
  risk: SlaRisk;
  expectedFee: number;
}

const WAITING_ON: Partial<Record<ApplicationStatus, { label: string; person: boolean }>> = {
  HUMAN_REVIEW: { label: 'Reviewer decision', person: true },
  AWAITING_DOCS: { label: 'Applicant documents', person: true },
  AWAITING_SIGNATURE: { label: 'Applicant signature', person: true },
  AWAITING_PROVIDER: { label: 'Provider recovery', person: false },
};

export function buildSlaBoard(cases: CaseRecord[], now: number, cfg: { overallSlaMs: number; atRiskAfterMs: number; staleAfterMs: number }) {
  const items: SlaItem[] = [];
  for (const c of cases) {
    if (isTerminal(c.status)) continue;
    const received = Date.parse(c.receivedAt);
    const deadline = c.slaDeadline ? Date.parse(c.slaDeadline) : received + cfg.overallSlaMs;
    const total = Math.max(1, deadline - received);
    const atRiskAt = c.slaAtRiskAt ? Date.parse(c.slaAtRiskAt) : received + Math.min(cfg.atRiskAfterMs, total);
    const msLeft = deadline - now;
    const staleMs = now - Date.parse(c.lastActivityAt ?? c.updatedAt);
    const risk: SlaRisk | null =
      msLeft <= 0 || c.slaBreached ? 'BREACHED'
        : c.slaAtRisk || now >= atRiskAt ? 'AT_RISK'
          : staleMs >= cfg.staleAfterMs ? 'STALE'
            : null;
    if (!risk) continue;
    const w = WAITING_ON[c.status] ?? { label: 'System (processing)', person: false };
    items.push({
      applicationId: c.applicationId, applicantName: c.applicantName, productType: c.productType, channel: c.channel, amount: c.amount,
      status: c.status, waitingOn: w.label, needsPerson: w.person, receivedAt: c.receivedAt, slaDeadline: new Date(deadline).toISOString(),
      msLeft, pctUsed: Math.round(((now - received) / total) * 100), lastActivityAt: c.lastActivityAt ?? c.updatedAt, staleMs, risk,
      expectedFee: expectedFee(c.productType, c.amount),
    });
  }
  items.sort((a, b) => a.msLeft - b.msLeft);
  const col = (r: SlaRisk) => items.filter((i) => i.risk === r);
  return {
    breached: col('BREACHED'),
    atRisk: col('AT_RISK'),
    stale: col('STALE'),
    counts: { breached: col('BREACHED').length, atRisk: col('AT_RISK').length, stale: col('STALE').length, reviews: items.filter((i) => i.status === 'HUMAN_REVIEW').length },
    /** Fees that would be billed if these applications fund: what is at stake. */
    feesAtStake: Math.round(items.reduce((s, i) => s + i.expectedFee, 0) * 100) / 100,
  };
}
