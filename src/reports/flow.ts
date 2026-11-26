/**
 * Flow aggregation for the Sankey: how applications moved between states, built from the audit log's
 * transitions (Visibility only knows the current state, not the path).
 *
 * Loops (docs re-requested, review asked for more info) would make the graph cyclic, which a Sankey can't
 * draw. Every loop returns through VALIDATING, so each return starts a new "round" and in-flight states are
 * keyed by (state, round). Round 2 is the "rework" pass; later rounds fold into it (their re-entry edge is
 * dropped). Within a round states only move forward, so the graph is acyclic. Terminals are shared.
 */
import { isTerminal, type ApplicationStatus, type Channel, type ProductType } from '../shared/types';
import type { StoredAuditEvent } from '../activities/auditStore';

export interface CaseFilter {
  product?: ProductType;
  channel?: Channel;
  /** ISO timestamps on the application's received time. */
  from?: string;
  to?: string;
  q?: string;
  /** Current state, or OPEN for anything not yet terminal. */
  status?: ApplicationStatus | 'OPEN';
}

export interface CaseRecord {
  applicationId: string;
  applicantName: string;
  productType: ProductType;
  channel: Channel;
  amount: number;
  scenario?: string;
  receivedAt: string;
  updatedAt: string;
  status: ApplicationStatus;
  path: ApplicationStatus[];
  lastReason?: string;
  lastActor?: string;
  reviewers: string[];
  slaBreached: boolean;
  /** From the received event (absent on applications recorded before it was added). */
  slaDeadline?: string;
  slaAtRiskAt?: string;
  /** The workflow raised SLA_AT_RISK. */
  slaAtRisk: boolean;
  approvalsRequired?: number;
  eventCount: number;
  billed?: { fee: number; account: string };
  /** Last time something actually happened: system flags and reminders don't count as activity. */
  lastActivityAt: string;
}

const NOT_ACTIVITY = new Set(['SLA_AT_RISK', 'SLA_BREACHED', 'CLAIM_EXPIRY_REMINDER', 'DOCS_REMINDER_SENT', 'SIGNATURE_REMINDER_SENT', 'NOTIFICATION_FAILED']);

/** Fold the audit log into one record per application. */
export function buildCases(events: StoredAuditEvent[]): CaseRecord[] {
  const byId = new Map<string, CaseRecord>();
  for (const e of events) {
    let c = byId.get(e.applicationId);
    if (!c) {
      const d = (e.details ?? {}) as { applicantName?: string; amount?: number; scenario?: string; slaDeadline?: string; slaAtRiskAt?: string };
      c = {
        applicationId: e.applicationId, applicantName: d.applicantName ?? '', productType: e.productType, channel: e.channel,
        amount: d.amount ?? 0, scenario: d.scenario, receivedAt: e.at, updatedAt: e.at, status: 'RECEIVED', path: ['RECEIVED'],
        reviewers: [], slaBreached: false, slaDeadline: d.slaDeadline, slaAtRiskAt: d.slaAtRiskAt, slaAtRisk: false, eventCount: 0, lastActivityAt: e.at,
      };
      byId.set(e.applicationId, c);
    }
    c.eventCount++;
    if (!NOT_ACTIVITY.has(e.type) && e.at > c.lastActivityAt) c.lastActivityAt = e.at;
    if (e.at > c.updatedAt) c.updatedAt = e.at;
    if (e.type === 'TRANSITION' && e.to) {
      c.status = e.to;
      c.path.push(e.to);
      c.lastReason = e.reason;
      c.lastActor = e.actor;
      if (e.to === 'HUMAN_REVIEW') c.approvalsRequired = (e.details as { approvalsRequired?: number })?.approvalsRequired;
    }
    if (e.type === 'REVIEW_DECISION') c.reviewers.push(e.actor.replace(/^reviewer:/, ''));
    if (e.type === 'SLA_BREACHED') c.slaBreached = true;
    if (e.type === 'SLA_AT_RISK') c.slaAtRisk = true;
    if (e.type === 'BILLED') { const b = e.details as { fee: number; account: string }; c.billed = { fee: b.fee, account: b.account }; }
  }
  return [...byId.values()];
}

export function filterCases(cases: CaseRecord[], f: CaseFilter): CaseRecord[] {
  const q = f.q?.trim().toLowerCase();
  return cases.filter((c) =>
    (!f.product || c.productType === f.product) &&
    (!f.channel || c.channel === f.channel) &&
    (!f.from || c.receivedAt >= f.from) &&
    (!f.to || c.receivedAt <= f.to) &&
    (!f.status || (f.status === 'OPEN' ? !isTerminal(c.status) : c.status === f.status)) &&
    (!q || [c.applicationId, c.applicantName, c.lastReason, c.scenario, ...c.reviewers].some((s) => s?.toLowerCase().includes(q))));
}

export function casesToCsv(cases: CaseRecord[]): string {
  const cols = ['applicationId', 'applicantName', 'productType', 'channel', 'amount', 'status', 'lastReason', 'lastActor', 'reviewers', 'slaBreached', 'receivedAt', 'updatedAt', 'eventCount', 'scenario'] as const;
  return [cols.join(','), ...cases.map((c) => cols.map((k) => csvCell(k === 'reviewers' ? c.reviewers.join(' ') : c[k])).join(','))].join('\n') + '\n';
}

export interface FlowNode { id: string; state: ApplicationStatus; visit: number; count: number; terminal: boolean }
export interface FlowLink { source: string; target: string; value: number }

export interface FlowSummary {
  total: number;
  inFlight: number;
  terminal: Record<'FUNDED' | 'DECLINED' | 'ESCALATED', number>;
  byStatus: Partial<Record<ApplicationStatus, number>>;
  fundingRate: number | null;
  fundedVolume: number;
  slaBreached: number;
  needsReview: number;
  /** Applications a person reviewed (ever reached HUMAN_REVIEW). */
  manuallyReviewed: number;
  medianSecondsToClose: number | null;
  nodes: FlowNode[];
  links: FlowLink[];
  /** Top terminal reasons, grouped by reason code. */
  outcomes: { status: 'FUNDED' | 'DECLINED' | 'ESCALATED'; reason: string; count: number }[];
}

export const reasonCode = (r?: string) => (r ?? 'UNKNOWN').split(/[:;(]/)[0].trim();

export function buildFlow(cases: CaseRecord[]): FlowSummary {
  const nodes = new Map<string, FlowNode>();
  const links = new Map<string, FlowLink>();
  const byStatus: FlowSummary['byStatus'] = {};
  const terminal = { FUNDED: 0, DECLINED: 0, ESCALATED: 0 };
  const outcomes = new Map<string, FlowSummary['outcomes'][number]>();
  const closeTimes: number[] = [];
  let fundedVolume = 0;

  for (const c of cases) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    let round = 0;
    let prev: string | undefined;
    const seen = new Set<string>();
    // RECEIVED is always 100% of the flow, so the Sankey starts at the first real stage.
    const path = c.path.length > 1 ? c.path.slice(1) : c.path;
    for (const state of path) {
      if (state === 'VALIDATING') round++;
      const visit = isTerminal(state) ? 1 : Math.min(2, Math.max(1, round));
      const id = visit === 1 ? state : `${state}#${visit}`;
      const node = nodes.get(id) ?? { id, state, visit, count: 0, terminal: isTerminal(state) };
      if (!seen.has(id)) { node.count++; seen.add(id); }
      nodes.set(id, node);
      // Third and later rounds fold into the rework round; their re-entry edge is dropped to stay acyclic.
      if (prev === id || (round > 2 && state === 'VALIDATING')) { prev = id; continue; }
      if (prev) {
        const key = `${prev}->${id}`;
        const link = links.get(key) ?? { source: prev, target: id, value: 0 };
        link.value++;
        links.set(key, link);
      }
      prev = id;
    }
    if (c.status === 'FUNDED' || c.status === 'DECLINED' || c.status === 'ESCALATED') {
      terminal[c.status]++;
      if (c.status === 'FUNDED') fundedVolume += c.amount;
      closeTimes.push((Date.parse(c.updatedAt) - Date.parse(c.receivedAt)) / 1000);
      const code = reasonCode(c.lastReason);
      const key = `${c.status}|${code}`;
      const o = outcomes.get(key) ?? { status: c.status, reason: code, count: 0 };
      o.count++;
      outcomes.set(key, o);
    }
  }

  const closed = terminal.FUNDED + terminal.DECLINED + terminal.ESCALATED;
  closeTimes.sort((a, b) => a - b);
  return {
    total: cases.length,
    inFlight: cases.length - closed,
    terminal,
    byStatus,
    fundingRate: closed ? terminal.FUNDED / closed : null,
    fundedVolume,
    slaBreached: cases.filter((c) => c.slaBreached).length,
    needsReview: byStatus.HUMAN_REVIEW ?? 0,
    manuallyReviewed: cases.filter((c) => c.path.includes('HUMAN_REVIEW')).length,
    medianSecondsToClose: closeTimes.length ? Math.round(closeTimes[Math.floor(closeTimes.length / 2)]) : null,
    nodes: [...nodes.values()],
    links: [...links.values()],
    outcomes: [...outcomes.values()].sort((a, b) => b.count - a.count),
  };
}

// ---- audit event filtering -------------------------------------------

export interface EventFilter extends CaseFilter {
  type?: string;
  actor?: string;
  state?: ApplicationStatus;
  applicationId?: string;
}

export function filterEvents(events: StoredAuditEvent[], f: EventFilter): StoredAuditEvent[] {
  const q = f.q?.trim().toLowerCase();
  const actor = f.actor?.trim().toLowerCase();
  return events.filter((e) =>
    (!f.applicationId || e.applicationId === f.applicationId) &&
    (!f.product || e.productType === f.product) &&
    (!f.channel || e.channel === f.channel) &&
    (!f.type || e.type === f.type) &&
    (!f.state || e.to === f.state || e.from === f.state) &&
    (!actor || e.actor.toLowerCase().includes(actor)) &&
    (!f.from || e.at >= f.from) &&
    (!f.to || e.at <= f.to) &&
    (!q || [e.applicationId, e.reason, e.actor, e.type, JSON.stringify(e.details ?? {})].some((s) => s?.toLowerCase().includes(q))));
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function eventsToCsv(events: StoredAuditEvent[]): string {
  const cols = ['at', 'applicationId', 'runId', 'productType', 'channel', 'type', 'from', 'to', 'actor', 'reason', 'details', 'recordedAt'] as const;
  return [cols.join(','), ...events.map((e) => cols.map((c) => csvCell(e[c])).join(','))].join('\n') + '\n';
}
