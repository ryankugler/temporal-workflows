/**
 * Enrichment child workflow (queue: enrichment). Shared by every product and reusable for any client:
 * the caller passes which checks it needs and gets back whatever succeeded plus a list of failures.
 *
 * - Checks fan out in parallel, each on its provider's rate-limited queue.
 * - Promise.allSettled: a completed result is durable in history, so when one provider fails the others
 *   are never called (or billed) again.
 * - Never throws for provider exhaustion. Partial data is a business situation; the parent decides.
 * - Each failure is classified: UNAVAILABLE (outage, circuit open, retry budget spent: worth waiting
 *   for) or PERMANENT (a business answer such as SubjectNotFound: waiting won't change it).
 */
import { TaskQueues } from '../shared/config';
import type { EnrichmentCheck, EnrichmentInput, EnrichmentResult } from '../shared/types';
import { providerProxy } from './activityOptions';

const PROVIDER_NAMES: Record<EnrichmentCheck, string> = {
  credit: 'credit-bureau',
  identity: 'identity',
  fraud: 'fraud',
};

export async function enrichmentWorkflow(input: EnrichmentInput): Promise<EnrichmentResult> {
  const call = { applicationId: input.applicationId, application: input.application };
  const runners: Record<EnrichmentCheck, () => Promise<unknown>> = {
    credit: () => providerProxy(TaskQueues.creditBureau, input.timing).fetchCreditReport(call),
    identity: () => providerProxy(TaskQueues.identity, input.timing).verifyIdentity(call),
    fraud: () => providerProxy(TaskQueues.fraud, input.timing).checkFraud(call),
  };

  const settled = await Promise.allSettled(input.checks.map((c) => runners[c]()));
  const result: EnrichmentResult = { failures: [] };
  settled.forEach((s, i) => {
    const check = input.checks[i];
    if (s.status === 'fulfilled') (result as unknown as Record<string, unknown>)[check] = s.value;
    else result.failures.push({ provider: PROVIDER_NAMES[check], check, error: rootMessage(s.reason), kind: failureKind(s.reason) });
  });
  return result;
}

const PERMANENT_TYPES = new Set(['SubjectNotFound', 'InvalidInput']);

/** Walks the failure chain: a non-retryable business type is PERMANENT, everything else is availability. */
export function failureKind(err: unknown): 'UNAVAILABLE' | 'PERMANENT' {
  let e = err as { cause?: unknown; type?: string } | undefined;
  while (e) {
    if (e.type && PERMANENT_TYPES.has(e.type)) return 'PERMANENT';
    e = e.cause as typeof e;
  }
  return 'UNAVAILABLE';
}

export function rootMessage(err: unknown): string {
  let e = err as { cause?: unknown; message?: string; type?: string } | undefined;
  while (e?.cause) e = e.cause as typeof e;
  return e?.type ? `${e.type}: ${e.message}` : (e?.message ?? String(err));
}
