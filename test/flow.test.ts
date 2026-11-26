import { describe, expect, it } from 'vitest';
import type { StoredAuditEvent } from '../src/activities/auditStore';
import { buildCases, buildFlow, eventsToCsv, filterCases } from '../src/reports/flow';
import type { ApplicationStatus } from '../src/shared/types';

let n = 0;
function app(id: string, path: ApplicationStatus[], extra: Partial<StoredAuditEvent> = {}): StoredAuditEvent[] {
  const base = { applicationId: id, runId: 'r', productType: 'PERSONAL' as const, channel: 'PORTAL' as const, recordedAt: '', ...extra };
  const at = (i: number) => new Date(Date.UTC(2026, 10, 26, 12, 0, i)).toISOString();
  const evs: StoredAuditEvent[] = [{ ...base, type: 'APPLICATION_RECEIVED', actor: 'channel:portal', at: at(0), to: 'RECEIVED', details: { applicantName: id, amount: 1000 }, eventKey: `${++n}` }];
  let from: ApplicationStatus = 'RECEIVED';
  path.forEach((to, i) => { evs.push({ ...base, type: 'TRANSITION', actor: 'system', at: at(i + 1), from, to, reason: to === 'DECLINED' ? 'ABANDONED_MISSING_DOCUMENTS' : undefined, eventKey: `${++n}` }); from = to; });
  return evs;
}

describe('flow aggregation', () => {
  const events = [
    ...app('a', ['VALIDATING', 'ENRICHING', 'UNDERWRITING', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED']),
    ...app('b', ['VALIDATING', 'AWAITING_DOCS', 'VALIDATING', 'AWAITING_DOCS', 'DECLINED']),
    ...app('c', ['VALIDATING', 'ENRICHING', 'HUMAN_REVIEW'], { productType: 'AUTO' }),
  ];

  it('numbers repeat visits so loops stay acyclic, and counts terminal states', () => {
    const flow = buildFlow(buildCases(events));
    const ids = flow.nodes.map((x) => x.id);
    expect(ids).toContain('VALIDATING#2');
    expect(ids).toContain('AWAITING_DOCS#2');
    expect(ids).not.toContain('VALIDATING#3');
    expect(flow.links.find((l) => l.source === 'AWAITING_DOCS' && l.target === 'VALIDATING#2')?.value).toBe(1);
    expect(flow.terminal).toEqual({ FUNDED: 1, DECLINED: 1, ESCALATED: 0 });
    expect(flow.inFlight).toBe(1);
    expect(flow.needsReview).toBe(1);
    expect(flow.fundingRate).toBe(0.5);
    expect(flow.outcomes.find((o) => o.status === 'DECLINED')?.reason).toBe('ABANDONED_MISSING_DOCUMENTS');
    // Every link points forward: no node is both an ancestor and a descendant.
    const node = new Set(ids);
    for (const l of flow.links) { expect(node.has(l.source) && node.has(l.target)).toBe(true); expect(l.source).not.toBe(l.target); }
  });

  it('stays acyclic when docs loops and request-info loops mix', () => {
    const mixed = [
      ...app('d', ['VALIDATING', 'ENRICHING', 'UNDERWRITING', 'HUMAN_REVIEW', 'AWAITING_DOCS', 'VALIDATING', 'ENRICHING', 'UNDERWRITING', 'HUMAN_REVIEW', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED']),
      ...app('e', ['VALIDATING', 'AWAITING_DOCS', 'VALIDATING', 'ENRICHING', 'UNDERWRITING', 'HUMAN_REVIEW', 'AWAITING_DOCS', 'VALIDATING', 'ENRICHING', 'UNDERWRITING', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED']),
      ...events,
    ];
    const { nodes, links } = buildFlow(buildCases(mixed));
    // Kahn's algorithm: every node is removed only if the graph has no cycle.
    const indeg = new Map(nodes.map((x) => [x.id, 0]));
    for (const l of links) indeg.set(l.target, indeg.get(l.target)! + 1);
    const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
    let removed = 0;
    while (queue.length) {
      const id = queue.shift()!;
      removed++;
      for (const l of links.filter((x) => x.source === id)) { indeg.set(l.target, indeg.get(l.target)! - 1); if (indeg.get(l.target) === 0) queue.push(l.target); }
    }
    expect(removed).toBe(nodes.length);
    expect(nodes.find((x) => x.id === 'FUNDED')?.count).toBe(3);
  });

  it('filters by product and exports CSV', () => {
    const cases = filterCases(buildCases(events), { product: 'AUTO' });
    expect(cases.map((c) => c.applicationId)).toEqual(['c']);
    const csv = eventsToCsv(events.slice(0, 2));
    expect(csv.split('\n')[0]).toBe('at,applicationId,runId,productType,channel,type,from,to,actor,reason,details,recordedAt');
    expect(csv).toContain('"{""applicantName"":""a"",""amount"":1000}"');
  });
});
