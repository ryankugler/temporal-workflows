# Code samples

These are the pieces of code that define the architecture, each with the reason it matters. The excerpts are lightly trimmed (marked `…`); the links go to the full source. They follow the case study's structure: the three architecture asks, then the six "things to consider", then the extras.

| # | Sample | Answers |
|---|---|---|
| 1 | [The parent workflow's lifecycle](#1-the-parent-workflow-owns-the-lifecycle) | Workflow definition, state machine |
| 2 | [Child workflows at isolation seams](#2-child-workflows-at-isolation-seams) | Workflow definition, product isolation |
| 3 | [The external API: signals, updates, a query](#3-the-external-api-signals-updates-and-a-query) | Human in the loop |
| 4 | [Review decision: an Update with a validator](#4-the-review-decision-an-update-with-a-validator) | Human in the loop, four-eyes |
| 5 | [Claims as leases (session expiry)](#5-review-claims-are-leases-like-a-web-session) | Human in the loop, hand-offs |
| 6 | [One idempotent start path for all channels](#6-one-idempotent-start-path-for-three-channels) | Ingestion |
| 7 | [Aggregator files: fan-out with continueAsNew](#7-aggregator-files-fan-out-with-continueasnew) | Ingestion at scale |
| 8 | [Activity design: retry policy by kind of call](#8-activity-design-a-retry-policy-for-each-kind-of-call) | Activity design, third-party failures |
| 9 | [Rate limits per vendor queue](#9-rate-limits-one-task-queue-per-vendor) | Rate limits |
| 10 | [Partial failure: allSettled enrichment](#10-partial-failure-enrichment-with-allsettled) | Partial failures |
| 11 | [Circuit breaker, then parking](#11-outages-circuit-breaker-then-parking-in-awaiting_provider) | Outages |
| 12 | [Money moves once](#12-money-moves-exactly-once) | Third-party failures, safe retries |
| 13 | [Product policies](#13-product-logic-behind-one-interface) | Product isolation |
| 14 | [SLA watchdog and audit](#14-knowing-when-something-is-broken-sla-watchdog-and-audit) | Observability, auditability |
| 15 | [Changing code with applications in flight](#15-changing-code-with-applications-in-flight) | Versioning |
| 16 | [A funded loan is billed once](#16-a-funded-loan-is-billed-exactly-once) | Billing constraint |

---

## Workflow definition

### 1. The parent workflow owns the lifecycle

[`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L415-L541)

One workflow per application. It walks the state machine, owns every wait on a person, and hands the non-interactive stages to child workflows. The `REQUEST_INFO` loop goes back through validation with fresh children. The `try/catch` guarantees a terminal state: a Temporal failure that escapes a stage becomes `ESCALATED` with its root cause. Plain code bugs are deliberately not caught: Temporal retries the workflow task until a fix is deployed, and the application resumes.

```ts
for (;;) {
  const checks = await validateAndCollectDocs();          // VALIDATING ⇄ AWAITING_DOCS, or DECLINED
  if (checks === 'DONE') return;
  round++;

  await transition('ENRICHING', 'system', undefined, { checks, round });
  const firstPass = await runChild('enrichment', enrichmentWorkflow, TaskQueues.enrichment, round, { … });
  const enrichment = await waitOutProviderOutage(firstPass, checks, round);   // AWAITING_PROVIDER if needed
  …
  await transition('UNDERWRITING', 'system', undefined, { round });
  const uw = await runChild('underwriting', UNDERWRITING_WORKFLOWS[app.productType], TaskQueues.underwriting(app.productType), round, { … });
  if (uw.outcome === 'DECLINE') return finish('DECLINED', rulesActor, uw.reasons.join('; '), { metrics: uw.metrics });
  …
  if (review) {
    const r = await humanReview(review.reasons, review.required, reviewRound);
    if (r.kind === 'TIMEOUT') return finish('ESCALATED', 'system', `REVIEW_TIMEOUT: no decision within ${timing.reviewTimeout}`);
    if (r.kind === 'DECLINED') return finish('DECLINED', `reviewer:${r.reviewerId}`, `REVIEWER_DECLINED: ${r.reason}`);
    if (r.kind === 'REQUEST_INFO') { …; continue; }   // back through validation and fresh children
  }
  break;
}
// AWAITING_SIGNATURE → sanctions screen → DISBURSING → FUNDED | ESCALATED
```

```ts
try {
  await run();
} catch (err) {
  if (wf.isCancellation(err) || !(err instanceof wf.ChildWorkflowFailure || err instanceof wf.ActivityFailure)) throw err;
  await finish('ESCALATED', 'system', `SYSTEM_FAILURE_IN_${view.status}: ${rootMessage(err)}`);
}
await wf.condition(wf.allHandlersFinished); // don't drop an in-flight update or signal handler
```

Every state change goes through one helper, so the state, the search attribute operators filter on, and the audit record can't drift apart:

```ts
async function transition(to: ApplicationStatus, actor: string, reason?: string, details?: Record<string, unknown>) {
  const from = view.status;
  view.status = to;
  view.history.push({ from, to, at: new Date().toISOString(), actor, reason });
  wf.upsertSearchAttributes([{ key: SA.status, value: to }]);
  await audit('TRANSITION', { from, to, actor, reason, details });
}
```

### 2. Child workflows at isolation seams

[`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L145-L149), [`src/shared/config.ts`](../src/shared/config.ts#L41-L45), [`src/workflows/underwriting.ts`](../src/workflows/underwriting.ts#L33-L65)

Children are used only where there is a real seam: a different owner, task queue, deploy cadence or failure domain. Child IDs are derived from the parent's ID, so a retry or replay finds the same child instead of starting a second one, and an operator can find every child of an application from its ID.

```ts
export const childWorkflowId = (parentId: string, stage: string, round = 1) =>
  round === 1 ? `${parentId}/${stage}` : `${parentId}/${stage}-${round}`;

function runChild<F extends wf.Workflow>(stage: ChildRun['stage'], fn: F, taskQueue: string, round: number, arg: Parameters<F>[0], suffix = '') {
  const workflowId = childWorkflowId(id, stage, round) + suffix;
  view.children.push({ stage, workflowId, workflowType: fn.name, taskQueue });
  return wf.executeChild<wf.Workflow>(fn.name, { workflowId, taskQueue, args: [arg] }) as ReturnType<F>;
}
```

Underwriting is one workflow type per product, each on its own queue, so a bad auto-loan deploy can't touch personal loans:

```ts
export async function autoLoanUnderwriting(input: UnderwritingInput): Promise<UnderwritingResult> {
  const failures: ProviderFailure[] = [];
  const checks: ProductChecks = {};
  try {
    checks.vehicle = await providerProxy(TaskQueues.vehicleValuation, input.timing)
      .valueVehicle({ applicationId: input.applicationId, application: input.application });
  } catch (err) {
    failures.push({ provider: 'vehicle-valuation', error: rootMessage(err), kind: failureKind(err) }); // the policy refers without a valuation
  }
  return decide(input, checks, failures);
}

export const UNDERWRITING_WORKFLOWS = {
  PERSONAL: personalLoanUnderwriting,
  AUTO: autoLoanUnderwriting,
  DEBT_CONSOLIDATION: debtConsolidationUnderwriting,
} as const;
```

---

## Human in the loop

### 3. The external API: signals, updates and a query

[`src/workflows/definitions.ts`](../src/workflows/definitions.ts)

Every input from outside targets the **parent**, never a child, so the console, webhooks and CLI only ever need the application's workflow ID. Each input uses the primitive that fits who is sending it: fire-and-forget **signals** for webhooks that can't act on a rejection, **updates** where the sender needs an answer, and a **query** for reads.

```ts
/** E-sign provider webhook. Fire-and-forget: the provider can't act on a rejection. */
export const agreementSignedSignal = defineSignal<[AgreementSigned]>('agreementSigned');

/** Applicant withdraws. Honoured at the next wait or stage boundary, never once payout has started. */
export const withdrawSignal = defineSignal<[Withdrawal]>('withdraw');

/** Reviewer decision. An Update so the validator can reject bad input and the reviewer gets an answer. */
export const submitReviewDecisionUpdate = defineUpdate<ReviewAck, [ReviewDecision]>('submitReviewDecision');

/** Reviewer claims a case for a limited time (a lease), renews it, or releases it. */
export const claimReviewUpdate = defineUpdate<ReviewClaim | null, [ClaimRequest]>('claimReview');

export const getStatusQuery = defineQuery<StatusView>('getStatus');
```

### 4. The review decision: an Update with a validator

[`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L191-L227)

The validator runs before anything is written to history. An invalid decision is rejected straight back to the reviewer and leaves no trace. A valid one is recorded durably and acknowledged. Four-eyes (two different approvers for large loans) is enforced here, inside the workflow, so no client can bypass it. The console sends a request ID as the Update ID, so a double-click or a retry after a dropped connection counts once.

```ts
wf.setHandler(submitReviewDecisionUpdate, async (d: ReviewDecision): Promise<ReviewAck> => {
  await audit('REVIEW_DECISION', { actor: `reviewer:${d.reviewerId}`, reason: d.reason, details: { decision: d.decision, … } });
  if (d.decision === 'APPROVE') view.approvals.push({ reviewerId: d.reviewerId, reason: d.reason });
  else if (d.decision === 'DECLINE') reviewOutcome = { kind: 'DECLINED', reviewerId: d.reviewerId, reason: d.reason };
  else reviewOutcome = { kind: 'REQUEST_INFO', … };
  …
  return { accepted: true, approvalsReceived: view.approvals.length, approvalsRequired: view.approvalsRequired, status: view.status };
}, {
  validator: (d: ReviewDecision) => {
    if (view.status !== 'HUMAN_REVIEW') throw new Error(`Application is not awaiting review (status: ${view.status})`);
    if (reviewOutcome) throw new Error('A decision has already been recorded for this review');
    if (!d.reason || d.reason.trim().length < 5) throw new Error('A reason (5+ characters) is required for the audit trail');
    if (view.approvals.some((a) => a.reviewerId === d.reviewerId) || reviewersInFlight.has(d.reviewerId)) {
      throw new Error(`Four-eyes: ${d.reviewerId} has already approved; a different reviewer must decide`);
    }
    const claim = activeClaim();
    if (claim && claim.reviewerId !== d.reviewerId) throw new Error(`Claimed by ${claim.reviewerId} …`);
  },
});
```

### 5. Review claims are leases, like a web session

[`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L313-L355)

While waiting for a decision, the workflow pauses durably on a timer, holding no worker. It also manages the claim: it reminds the holder before the claim ends, then lets it lapse so the case goes back to the queue. Only the overall review timeout escalates the application. A forgotten browser tab never strands a case.

```ts
for (;;) {
  const seenGen = claimGen;
  const claim = view.claim;
  const claimEnd = claim ? Date.parse(claim.expiresAt) : Infinity;
  const nextClaimEvent = claim ? (claim.reminded ? claimEnd : claimEnd - reminderMs) : Infinity;
  const wakeAt = Math.min(reviewDeadline, nextClaimEvent);
  decided = await wf.condition(() => isDecided() || claimGen !== seenGen, Math.max(1, wakeAt - Date.now()));
  if (isDecided()) { decided = true; break; }
  if (claimGen !== seenGen) continue;                    // claimed, extended or released: recompute
  if (Date.now() >= reviewDeadline) { decided = false; break; }
  if (claim && !claim.reminded && Date.now() >= claimEnd - reminderMs) {
    claim.reminded = true;
    await notify('reviewer', 'CLAIM_EXPIRING', { reviewerId: claim.reviewerId, expiresAt: claim.expiresAt });
  } else if (claim && Date.now() >= claimEnd) {
    view.claim = undefined;
    claimGen++;
    await audit('CLAIM_EXPIRED', { actor: 'system', reason: `${claim.reviewerId}'s claim lapsed; case returned to the queue` });
  }
}
```

---

## How do you reliably ingest from three very different input channels?

### 6. One idempotent start path for three channels

[`src/ingest/start.ts`](../src/ingest/start.ts), [`src/ingest/adapters.ts`](../src/ingest/adapters.ts)

Each channel has an adapter (`fromPortal`, `fromBrokerEmail`, `fromAggregatorRow`) that turns its format into one `LoanApplication`. They all start workflows the same way. The workflow ID is built from the channel and the channel's own reference, so it is the idempotency key: a re-delivered email, a double-submitted form or a re-sent batch row collapses onto the existing application. Temporal enforces this, so there is no dedupe table and no queue in front of it.

```ts
export async function startLoanApplication(client: Client, application: LoanApplication, timing?: Partial<Timing>): Promise<StartResult> {
  const workflowId = loanWorkflowId(application.channel, application.externalRef);   // e.g. loan-broker-email-<message-id>
  try {
    await client.workflow.start(loanApplicationWorkflow, {
      workflowId,
      taskQueue: TaskQueues.orchestration,
      args: [{ application, timing }],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      memo: applicationMemo(application),
      typedSearchAttributes: [{ key: SA.status, value: 'RECEIVED' }, { key: SA.product, value: application.productType }, … ],
    });
    return { workflowId, duplicate: false };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return { workflowId, duplicate: true };
    throw err;
  }
}
```

If Temporal itself is unreachable, [`src/ingest/outbox.ts`](../src/ingest/outbox.ts) retries the start with backoff, then writes the application to a local outbox that a drainer submits later, under the same ID.

### 7. Aggregator files: fan-out with continueAsNew

[`src/workflows/batchIngest.ts`](../src/workflows/batchIngest.ts#L29-L65)

One workflow per file reads it in pages and starts each valid row as its own application. A bad row is rejected on its own and never blocks the file. `ABANDON` lets the applications outlive the file job, and `continueAsNew` keeps history bounded for very large files.

```ts
for (let page = 0; offset !== null && page < PAGES_PER_RUN; page++) {
  const res = await readBatchPage({ filePath: input.filePath, offset, pageSize });
  await Promise.all(res.rows.map(async (row) => {
    if (!row.application) { totals.rejected.push({ rowRef: row.rowRef, error: row.error ?? 'unparseable' }); return; }
    try {
      await wf.startChild(loanApplicationWorkflow, {
        workflowId: loanWorkflowId(app.channel, app.externalRef),
        parentClosePolicy: 'ABANDON',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        …
      });
      totals.started++;
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) totals.duplicates++;
      else throw err;
    }
  }));
  offset = res.nextOffset;
}
if (offset !== null) await wf.continueAsNew<typeof batchIngestWorkflow>({ ...input, offset, totals });
```

---

## Activity design, and how third-party failures, rate limits and partial failures are handled

### 8. Activity design: a retry policy for each kind of call

[`src/workflows/activityOptions.ts`](../src/workflows/activityOptions.ts), [`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L33-L45), [`src/activities/providers.ts`](../src/activities/providers.ts#L33-L58)

Activities are where side effects live; workflows only decide. Each kind of call gets the retry policy its consequences call for:

```ts
/** Third-party calls: a total time budget across retries, so an outage ends in a decision, not a stall. */
export function providerProxy(taskQueue: string, timing: Timing) {
  return proxyActivities<Activities>({
    taskQueue,
    startToCloseTimeout: '20s',
    scheduleToCloseTimeout: timing.providerBudget,
    retry: { initialInterval: timing.providerRetryInitialInterval, backoffCoefficient: 2, maximumInterval: '1m',
             nonRetryableErrorTypes: ['SubjectNotFound', 'InvalidInput'] },   // business answers: retrying won't help
  });
}

/** Audit writes retry forever: a decision without an audit record is not acceptable. */
const auditActs = wf.proxyActivities<Activities>({ taskQueue: TaskQueues.orchestration, startToCloseTimeout: '5s',
  retry: { initialInterval: '500ms', maximumInterval: '30s' } });

/** Notifications are best effort: three attempts, then the failure is audited and the workflow moves on. */
const notifyActs = wf.proxyActivities<Activities>({ taskQueue: TaskQueues.orchestration, startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3, initialInterval: '200ms' } });
```

Activities classify their errors, and the classification drives behaviour. A 429 follows the vendor's `Retry-After`. A missing identity record is a business answer and is never retried:

```ts
throw ApplicationFailure.create({ message: '429 Too Many Requests', type: 'RateLimited', nextRetryDelay: '300ms' });
throw ApplicationFailure.retryable('upstream connection reset', 'ProviderTransientError');
throw ApplicationFailure.nonRetryable('No identity record matches the applicant', 'SubjectNotFound');
```

### 9. Rate limits: one task queue per vendor

[`src/workers/createWorkers.ts`](../src/workers/createWorkers.ts#L32-L54), [`src/shared/config.ts`](../src/shared/config.ts#L23-L29)

Each vendor's activities run on their own task queue with a **server-side** rate limit. However many workers you add, a vendor never sees more than its quota, and a slow vendor backs up only its own queue.

```ts
export const PROVIDER_RATE_LIMITS: Record<string, number> = {
  [TaskQueues.creditBureau]: 20, [TaskQueues.identity]: 25, [TaskQueues.fraud]: 40,
  [TaskQueues.vehicleValuation]: 10, [TaskQueues.debtVerification]: 10,
};

return Promise.all(specs.map((s) => Worker.create({
  connection, namespace, ...s,
  // Server-side, cluster-wide throttle: scaling out workers can never exceed the vendor's quota.
  maxTaskQueueActivitiesPerSecond: PROVIDER_RATE_LIMITS[s.taskQueue],
})));
```

### 10. Partial failure: enrichment with allSettled

[`src/workflows/enrichment.ts`](../src/workflows/enrichment.ts#L22-L50)

The three checks run in parallel. A completed result is durable in history, so when one provider fails, the others are never called (or billed) again. The child never throws for a provider failure: partial data is a business situation, and the parent decides what to do. Each failure is classified, because "the vendor is down" and "the vendor says no such person" call for different responses.

```ts
const settled = await Promise.allSettled(input.checks.map((c) => runners[c]()));
const result: EnrichmentResult = { failures: [] };
settled.forEach((s, i) => {
  const check = input.checks[i];
  if (s.status === 'fulfilled') result[check] = s.value;
  else result.failures.push({ provider: PROVIDER_NAMES[check], check, error: rootMessage(s.reason), kind: failureKind(s.reason) });
});
return result;

/** Walks the failure chain: a non-retryable business type is PERMANENT, everything else is availability. */
export function failureKind(err: unknown): 'UNAVAILABLE' | 'PERMANENT' { … }
```

### 11. Outages: circuit breaker, then parking in AWAITING_PROVIDER

[`src/activities/providerHealth.ts`](../src/activities/providerHealth.ts#L165-L181), [`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L364-L413)

Outages are handled in three layers. Retries (sample 8) absorb blips. When a vendor keeps failing, its circuit opens and calls fail fast instead of thousands of workflows hammering a dead API:

```ts
async guard<T>(provider: ProviderName, call: () => Promise<T>): Promise<T> {
  const breaker = this.breakers[provider];
  breaker.before();                       // throws a non-retryable CircuitOpen while the circuit is open
  …
  try {
    const result = await call();
    breaker.success();
    return result;
  } catch (err) { breaker.releaseProbe(); throw err; }
}
```

Then the application **parks**. It moves to `AWAITING_PROVIDER` (a durable wait that holds no worker) and re-runs a fresh enrichment child for the failed checks only, on a widening schedule. Checks that already succeeded are kept, so nothing is re-pulled or re-billed. If the outage outlasts its budget, the application goes to a person rather than waiting forever. Ops can force a retry with a signal.

```ts
while (unavailable().length && Date.now() < deadline) {
  const wait = Math.min(delay, deadline - Date.now());
  await wf.condition(() => !!retryNowRequested || isWithdrawn(), wait);
  …
  const retryChecks = checks.filter((c) => unavailable().some((f) => f.check === c));
  const retry = await runChild('enrichment', enrichmentWorkflow, TaskQueues.enrichment, round, { …, checks: retryChecks }, `.retry-${attempt}`);
  const kept = result.failures.filter((f) => !retryChecks.includes(f.check as EnrichmentCheck));
  result = { ...result, ...retry, failures: [...kept, ...retry.failures] };
  delay = Math.min(delay * 2, msToNumber(timing.providerParkMax));
}
```

### 12. Money moves exactly once

[`src/workflows/disbursement.ts`](../src/workflows/disbursement.ts#L20-L43), [`src/activities/core.ts`](../src/activities/core.ts#L126-L138)

Core-banking downtime is waited out, not escalated: a payout should be late rather than bounced to a person. That is only safe because every banking call is idempotent on the application ID. A rejected payout comes back as a result, not an exception, so the parent records exactly why it escalated.

```ts
function bankingProxy(timing: DisbursementInput['timing']) {
  return proxyActivities<Activities>({
    taskQueue: TaskQueues.disbursement,
    startToCloseTimeout: '60s', heartbeatTimeout: '20s',
    scheduleToCloseTimeout: timing.bankingBudget,
    retry: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '30s', nonRetryableErrorTypes: ['PayoutRejected'] },
  });
}

async disburseFunds(input) {
  Context.current().heartbeat('submitting payout');
  const existing = payouts.get(input.applicationId);
  if (existing) return { payoutRef: existing }; // idempotent on the application ID: never pay twice
  …
}
```

The e-sign envelope follows the same rule: its ID is decided in the workflow (`${id}-agreement-${round}`), so a retried send can't create a second envelope.

---

## How do you isolate loan product logic so one product's behavior doesn't bleed into another?

### 13. Product logic behind one interface

[`src/products/policy.ts`](../src/products/policy.ts#L9-L20), [`src/products/index.ts`](../src/products/index.ts)

Everything product-specific lives behind `ProductPolicy`: required documents, limits, checks, four-eyes threshold, rules, and a version that is recorded with every decision. Adding a product means adding a policy and an underwriting child type; the parent and the shared children don't change. At runtime each product's underwriting runs in its own workflow type on its own queue (sample 2). There are unit tests that assert no product's thresholds bleed into another's.

```ts
export interface ProductPolicy {
  product: ProductType;
  version: string;                       // recorded with every decision, e.g. "auto-2026.11.1"
  requiredDocuments: DocumentType[];
  limits: { minAmount: number; maxAmount: number; minTermMonths: number; maxTermMonths: number };
  enrichmentChecks: EnrichmentCheck[];
  fourEyesAmount: number;                // at or above this amount, two distinct reviewers must approve
  evaluate(input: { application: LoanApplication; enrichment: EnrichmentResult; productChecks: ProductChecks }): PolicyDecision;
}

export const autoLoanPolicy: ProductPolicy = {
  product: 'AUTO', version: 'auto-2026.11.1',
  requiredDocuments: ['GOV_ID', 'PAYSTUB', 'VEHICLE_PURCHASE_AGREEMENT'],
  fourEyesAmount: 60_000,
  evaluate: (input) => bandedDecision(input, { declineBelowScore: 560, referBelowScore: 640, maxDti: 0.5, … },
    ({ decline, refer }, metrics) => {
      const value = input.productChecks.vehicle?.marketValue;          // collateral: loan-to-value
      if (!value) { refer.push('NO_VEHICLE_VALUATION'); return; }
      const ltv = input.application.amount / value;
      if (ltv > 1.25) decline.push('LTV_ABOVE_125PCT'); else if (ltv > 1.1) refer.push('LTV_BORDERLINE');
    }),
  …
};
```

---

## How do you know when something is broken, and how does an operator investigate?

### 14. Knowing when something is broken: SLA watchdog and audit

[`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L263-L284), [`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L90-L99), [`src/activities/auditStore.ts`](../src/activities/auditStore.ts#L27-L33)

Each application carries its own SLA timer, running alongside the lifecycle. It raises `SLA_AT_RISK`, then `SLA_BREACHED`, and alerts ops. It never cancels, because a hard stop could interrupt a payout. The breach is also a search attribute, so `SlaBreached = true` is one Visibility query away.

```ts
void (async () => {
  const total = msToNumber(timing.overallSla);
  const warnAt = msToNumber(timing.slaAtRiskAfter);
  if (wf.patched('sla-at-risk-warning') && warnAt < total) {
    await wf.sleep(warnAt);
    if (isTerminal(view.status)) return;
    view.slaAtRisk = true;
    await audit('SLA_AT_RISK', { actor: 'system', reason: `${Math.round((warnAt / total) * 100)}% of the SLA used; still ${view.status}` });
    await notify('ops', 'SLA_AT_RISK', { status: view.status, slaDeadline: view.slaDeadline });
    await wf.sleep(total - warnAt);
  } else {
    await wf.sleep(timing.overallSla);
  }
  if (isTerminal(view.status)) return;
  view.slaBreached = true;
  wf.upsertSearchAttributes([{ key: SA.slaBreached, value: true }]);
  await audit('SLA_BREACHED', { actor: 'system', reason: `Open after ${timing.overallSla} (status ${view.status})` });
  await notify('ops', 'SLA_BREACHED', { status: view.status });
})();
```

Every decision, automated or human, is written with a deterministic key, so an activity retry can never write it twice. The store is append-only. Operators investigate from the console (case detail, audit filters and exports) and drill down to the exact workflow history in the Temporal UI.

```ts
async function audit(type: string, fields: Partial<Omit<AuditEvent, 'type'>> & { actor: string }): Promise<void> {
  const seq = ++auditSeq; // deterministic, so an activity retry dedupes on the same key
  await auditActs.recordAuditEvent({ eventKey: `${id}:${info.runId}:${seq}`, event: { applicationId: id, runId: info.runId, type, … } });
}

append(event: AuditEvent, eventKey: string): boolean {
  if (this.seen.has(eventKey)) return false;
  appendFileSync(this.path, JSON.stringify({ ...event, recordedAt: new Date().toISOString(), eventKey }) + '\n');
  …
}
```

---

## Extras

### 15. Changing code with applications in flight

[`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L506-L518), [`test/versioning.test.ts`](../test/versioning.test.ts)

Applications run for days, so workflow code changes while they're mid-flight. A new step (the sanctions screen) is gated with `patched()`. Runs that already passed that point replay without it, so their history still matches the code. A replay test proves it against histories recorded before the change; remove the guard and the test fails with the non-determinism error a real deploy would hit.

```ts
if (wf.patched('sanctions-screen-before-disbursement')) {
  const screen = await acts.screenSanctions({ applicationId: id, application: app });
  await audit('SANCTIONS_SCREENED', { actor: 'provider:sanctions', reason: screen.match ? `potential match on ${screen.list}` : 'no match', … });
  if (screen.match) return finish('ESCALATED', 'provider:sanctions', `SANCTIONS_POTENTIAL_MATCH: ${screen.list} (compliance must clear before payout)`);
}
```

```ts
for (const name of ['pre-patch-funded', 'pre-patch-four-eyes']) {
  it(`${name} replays cleanly against the current workflow code`, async () => {
    const history = fixture(name);
    // The recorded run never scheduled the screening activity...
    const activities = history.events!.filter((e) => e.activityTaskScheduledEventAttributes).map((e) => e.activityTaskScheduledEventAttributes!.activityType!.name);
    expect(activities).not.toContain('screenSanctions');
    // ...and still replays without a determinism violation.
    await expect(Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, workflowIds[name])).resolves.toBeUndefined();
  });
}
```

### 16. A funded loan is billed exactly once

[`src/workflows/loanApplication.ts`](../src/workflows/loanApplication.ts#L119-L143), [`src/workflows/billing.ts`](../src/workflows/billing.ts)

The brief says the lending team bills on disbursed loans. Billing is a child workflow on its own queue, because finance owns it. Both activities are safe to retry (pricing is pure, and the ledger write is idempotent on the application ID), so they retry until they succeed and no funded loan goes unbilled. A billing failure is alerted but never undoes funding.

```ts
if (to === 'FUNDED' && wf.patched('bill-funded-loans')) {
  try {
    view.billing = await runChild('billing', billingWorkflow, TaskQueues.billing, 1, { applicationId: id, application: app, … });
    await audit('BILLED', { actor: `billing:${view.billing.tariffVersion}`, reason: `${view.billing.account}: $${view.billing.fee.toFixed(2)} …` });
  } catch (err) {
    if (wf.isCancellation(err)) throw err;
    await audit('BILLING_FAILED', { actor: 'system', reason: rootMessage(err) });
    await notify('ops', 'ESCALATED', { reason: `Billing failed for a funded loan: ${rootMessage(err)}` });
  }
}
```

```ts
export async function billingWorkflow(input: BillingInput): Promise<BillingCharge> {
  const price = await finance.priceFundedLoan({ productType: app.productType, principal: app.amount });
  const charge: BillingCharge = { chargeId: `chg-${input.applicationId}`, …, fee: price.fee, tariffVersion: price.tariffVersion };
  return finance.recordCharge({ charge });   // idempotent on the application ID
}
```

---

## Running a workflow locally

```bash
npm install
```

```bash
npm run demo
```

Open http://localhost:3000. Step-by-step instructions are in [HOW-TO-USE.md](../HOW-TO-USE.md). From the command line, `npm run ingest -- fraud` starts one application that stops in human review, and `npm run review -- <id> approve --reviewer alice --reason "Explained"` resumes it. `npm test` runs 69 tests, 40 of them end-to-end against a real Temporal dev server.
