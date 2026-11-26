/**
 * Parent workflow: one per application, on the loan-orchestration queue.
 *
 * Owns the lifecycle state machine, the 48h SLA watchdog, every wait on a person or outside party
 * (documents, review, signature, withdraw), audit emission and search attributes. Delegates the
 * non-interactive stages to child workflows:
 *
 *   enrichmentWorkflow            shared credit / identity / fraud fan-out    (queue: enrichment)
 *   <product>Underwriting         product checks + product rules              (queue: underwriting-<product>)
 *   disbursementWorkflow          book, pay out, confirm                      (queue: disbursement)
 *   billingWorkflow               price and record the charge once funded     (queue: billing)
 */
import type { Duration } from '@temporalio/common';
import { msToNumber } from '@temporalio/common/lib/time';
import * as wf from '@temporalio/workflow';
import type { Activities } from '../activities';
import type { NotificationTemplate } from '../activities/simulatedWorld';
import { childWorkflowId, SA, TaskQueues } from '../shared/config';
import {
  DEFAULT_TIMING, isTerminal,
  type ApplicationStatus, type AuditEvent, type ChildRun, type DocumentType, type EnrichmentCheck, type EnrichmentResult, type LoanWorkflowInput,
  type ClaimRequest, type ReviewAck, type ReviewDecision, type StatusView,
} from '../shared/types';
import { shortLocal } from './activityOptions';
import {
  agreementSignedSignal, claimReviewUpdate, documentsUploadedSignal, getStatusQuery, retryProvidersNowSignal, submitReviewDecisionUpdate, withdrawSignal,
} from './definitions';
import { billingWorkflow } from './billing';
import { disbursementWorkflow } from './disbursement';
import { enrichmentWorkflow, rootMessage } from './enrichment';
import { UNDERWRITING_WORKFLOWS } from './underwriting';

const acts = wf.proxyActivities<Activities>({ taskQueue: TaskQueues.orchestration, ...shortLocal });
/** Audit writes retry forever: a decision without an audit record is not acceptable. */
const auditActs = wf.proxyActivities<Activities>({
  taskQueue: TaskQueues.orchestration,
  startToCloseTimeout: '5s',
  retry: { initialInterval: '500ms', maximumInterval: '30s' },
});
/** Notifications are best effort: three attempts, then the failure is audited and the workflow moves on. */
const notifyActs = wf.proxyActivities<Activities>({
  taskQueue: TaskQueues.orchestration,
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 3, initialInterval: '200ms' },
});

type ReviewResult =
  | { kind: 'APPROVED'; reviewers: string[] }
  | { kind: 'DECLINED'; reviewerId: string; reason: string }
  | { kind: 'REQUEST_INFO'; reviewerId: string; reason: string; documents: DocumentType[] }
  | { kind: 'TIMEOUT' }
  | { kind: 'WITHDRAWN' };

export async function loanApplicationWorkflow(input: LoanWorkflowInput): Promise<StatusView> {
  const timing = { ...DEFAULT_TIMING, ...input.timing };
  const app = input.application;
  const info = wf.workflowInfo();
  const id = info.workflowId;

  // ---- state ------------------------------------------------------------
  const view: StatusView = {
    applicationId: id,
    applicantName: app.applicant.fullName || '(unparsed)',
    productType: app.productType,
    channel: app.channel,
    amount: app.amount,
    scenario: app.scenario,
    status: 'RECEIVED',
    missingDocuments: [],
    reasons: [],
    slaDeadline: new Date(Date.now() + msToNumber(timing.overallSla)).toISOString(),
    slaBreached: false,
    approvals: [],
    approvalsRequired: 0,
    children: [],
    history: [],
  };
  const provided = new Set<DocumentType>(app.documents);
  const extraRequired = new Set<DocumentType>();
  let withdrawal: { reason: string; requestedBy: string } | undefined;
  let reviewOutcome: Exclude<ReviewResult, { kind: 'APPROVED' | 'TIMEOUT' | 'WITHDRAWN' }> | undefined;
  const reviewersInFlight = new Set<string>();
  let retryNowRequested: string | undefined;
  /** Bumped whenever the claim changes, so the review wait recomputes its next deadline. */
  let claimGen = 0;
  const activeClaim = () => (view.claim && Date.now() < Date.parse(view.claim.expiresAt) ? view.claim : undefined);
  let auditSeq = 0;

  // ---- helpers ----------------------------------------------------------
  async function audit(type: string, fields: Partial<Omit<AuditEvent, 'type'>> & { actor: string }): Promise<void> {
    const seq = ++auditSeq; // deterministic, so an activity retry dedupes on the same key
    await auditActs.recordAuditEvent({
      eventKey: `${id}:${info.runId}:${seq}`,
      event: {
        applicationId: id, runId: info.runId, at: new Date().toISOString(),
        productType: app.productType, channel: app.channel, type, ...fields,
      },
    });
  }

  async function transition(to: ApplicationStatus, actor: string, reason?: string, details?: Record<string, unknown>) {
    const from = view.status;
    view.status = to;
    view.history.push({ from, to, at: new Date().toISOString(), actor, reason });
    if (reason) view.reasons = [reason];
    view.pendingAction = undefined;
    wf.upsertSearchAttributes([{ key: SA.status, value: to }]);
    await audit('TRANSITION', { from, to, actor, reason, details });
  }

  async function notify(recipient: 'applicant' | 'reviewer' | 'ops', template: NotificationTemplate, data: Record<string, unknown> = {}) {
    try {
      await notifyActs.notify({ applicationId: id, application: app, recipient, template, data });
    } catch (err) {
      await audit('NOTIFICATION_FAILED', { actor: 'system', reason: `${template} to ${recipient}: ${rootMessage(err)}` });
    }
  }

  async function finish(to: 'FUNDED' | 'DECLINED' | 'ESCALATED', actor: string, reason: string, details?: Record<string, unknown>) {
    await transition(to, actor, reason, details);
    // A funded loan is a billable workflow. Added while applications were in flight, so it is gated with
    // patched(): runs that funded before this change replay without it. Billing can't undo funding: a
    // billing failure is audited and alerted, and the application stays FUNDED.
    if (to === 'FUNDED' && wf.patched('bill-funded-loans')) {
      const payout = details as { loanNumber: string; payoutRef: string };
      try {
        view.billing = await runChild('billing', billingWorkflow, TaskQueues.billing, 1, {
          applicationId: id, application: app, loanNumber: payout.loanNumber, payoutRef: payout.payoutRef, fundedAt: new Date().toISOString(),
        });
        await audit('BILLED', {
          actor: `billing:${view.billing.tariffVersion}`,
          reason: `${view.billing.account}: $${view.billing.fee.toFixed(2)} on $${view.billing.principal.toLocaleString('en-US')}`,
          details: { chargeId: view.billing.chargeId, fee: view.billing.fee, account: view.billing.account, period: view.billing.period },
        });
      } catch (err) {
        if (wf.isCancellation(err)) throw err;
        await audit('BILLING_FAILED', { actor: 'system', reason: rootMessage(err) });
        await notify('ops', 'ESCALATED', { reason: `Billing failed for a funded loan: ${rootMessage(err)}` });
      }
    }
    if (to === 'ESCALATED') await notify('ops', 'ESCALATED', { reason });
    else await notify('applicant', 'DECISION', { outcome: to, reason });
  }

  function runChild<F extends wf.Workflow>(stage: ChildRun['stage'], fn: F, taskQueue: string, round: number, arg: Parameters<F>[0], suffix = '') {
    const workflowId = childWorkflowId(id, stage, round) + suffix;
    view.children.push({ stage, workflowId, workflowType: fn.name, taskQueue });
    return wf.executeChild<wf.Workflow>(fn.name, { workflowId, taskQueue, args: [arg] }) as ReturnType<F>;
  }

  /** A closure-friendly read: signal handlers change this between awaits, which TS narrowing can't see. */
  const isWithdrawn = () => withdrawal !== undefined;
  const finishWithdrawn = () => finish('DECLINED', `applicant:${withdrawal!.requestedBy}`, `WITHDRAWN: ${withdrawal!.reason}`);

  /** Wait for a condition with a reminder, then a hard timeout. Used for docs and signature. */
  async function waitWithReminder(done: () => boolean, reminder: () => Promise<void>, firstWait: Duration, secondWait: Duration) {
    if (await wf.condition(() => done() || !!withdrawal, firstWait)) return true;
    await reminder();
    return wf.condition(() => done() || !!withdrawal, secondWait);
  }

  // ---- external API -----------------------------------------------------
  wf.setHandler(getStatusQuery, () => view);

  wf.setHandler(documentsUploadedSignal, async ({ documents, uploadedBy }) => {
    documents.forEach((d) => provided.add(d));
    await audit('DOCUMENTS_UPLOADED', { actor: `applicant:${uploadedBy}`, details: { documents } });
  });

  wf.setHandler(agreementSignedSignal, async (s) => {
    if (!view.signature || view.signature.envelopeId !== s.envelopeId || view.signature.signedAt) {
      await audit('WEBHOOK_IGNORED', { actor: 'provider:esign', reason: `stale or duplicate envelope ${s.envelopeId}` });
      return;
    }
    view.signature = { ...view.signature, signedAt: s.signedAt, signerName: s.signerName };
    await audit('AGREEMENT_SIGNED', { actor: 'provider:esign', details: { ...s } });
  });

  wf.setHandler(retryProvidersNowSignal, async ({ requestedBy }) => {
    if (view.status !== 'AWAITING_PROVIDER') return;
    retryNowRequested = requestedBy;
    await audit('PROVIDER_RETRY_REQUESTED', { actor: `ops:${requestedBy}` });
  });

  wf.setHandler(withdrawSignal, async (w) => {
    if (isTerminal(view.status) || view.status === 'DISBURSING' || withdrawal) return;
    withdrawal = w;
    await audit('WITHDRAWAL_REQUESTED', { actor: `applicant:${w.requestedBy}`, reason: w.reason });
  });

  wf.setHandler(
    submitReviewDecisionUpdate,
    async (d: ReviewDecision): Promise<ReviewAck> => {
      reviewersInFlight.add(d.reviewerId);
      try {
        await audit('REVIEW_DECISION', {
          actor: `reviewer:${d.reviewerId}`, reason: d.reason,
          details: { decision: d.decision, requestedDocuments: d.requestedDocuments, approvalsRequired: view.approvalsRequired },
        });
        if (d.decision === 'APPROVE') view.approvals.push({ reviewerId: d.reviewerId, reason: d.reason });
        else if (d.decision === 'DECLINE') reviewOutcome = { kind: 'DECLINED', reviewerId: d.reviewerId, reason: d.reason };
        else reviewOutcome = { kind: 'REQUEST_INFO', reviewerId: d.reviewerId, reason: d.reason, documents: d.requestedDocuments ?? [] };
        // A decision ends the claim, so a second reviewer can pick up a four-eyes case.
        if (view.claim) { view.claim = undefined; claimGen++; }
      } finally {
        reviewersInFlight.delete(d.reviewerId);
      }
      return { accepted: true, approvalsReceived: view.approvals.length, approvalsRequired: view.approvalsRequired, status: view.status };
    },
    {
      validator: (d: ReviewDecision) => {
        if (view.status !== 'HUMAN_REVIEW') throw new Error(`Application is not awaiting review (status: ${view.status})`);
        if (reviewOutcome) throw new Error('A decision has already been recorded for this review');
        if (!d.reviewerId?.trim()) throw new Error('reviewerId is required');
        if (!d.reason || d.reason.trim().length < 5) throw new Error('A reason (5+ characters) is required for the audit trail');
        if (!['APPROVE', 'DECLINE', 'REQUEST_INFO'].includes(d.decision)) throw new Error(`Unknown decision ${d.decision}`);
        if (d.decision === 'REQUEST_INFO' && !d.requestedDocuments?.length) throw new Error('REQUEST_INFO must list requestedDocuments');
        if (view.approvals.some((a) => a.reviewerId === d.reviewerId) || reviewersInFlight.has(d.reviewerId)) {
          throw new Error(`Four-eyes: ${d.reviewerId} has already approved; a different reviewer must decide`);
        }
        const claim = activeClaim();
        if (claim && claim.reviewerId !== d.reviewerId) {
          throw new Error(`Claimed by ${claim.reviewerId} until ${claim.expiresAt.slice(11, 19)} UTC; only they can decide until the claim ends`);
        }
      },
    },
  );

  // A claim is a lease on the case, like a web session: time-boxed, renewable, and it lapses on its own.
  wf.setHandler(
    claimReviewUpdate,
    async ({ reviewerId, action }: ClaimRequest) => {
      if (action === 'release') {
        view.claim = undefined;
        claimGen++;
        await audit('CLAIM_RELEASED', { actor: `reviewer:${reviewerId}` });
        return null;
      }
      const renewing = activeClaim()?.reviewerId === reviewerId;
      const now = Date.now();
      view.claim = { reviewerId, claimedAt: new Date(now).toISOString(), expiresAt: new Date(now + msToNumber(timing.claimLease)).toISOString(), reminded: false };
      claimGen++;
      await audit(renewing ? 'CLAIM_EXTENDED' : 'CLAIMED', { actor: `reviewer:${reviewerId}`, details: { expiresAt: view.claim.expiresAt } });
      return view.claim;
    },
    {
      validator: ({ reviewerId, action }: ClaimRequest) => {
        if (view.status !== 'HUMAN_REVIEW') throw new Error(`Application is not awaiting review (status: ${view.status})`);
        if (!reviewerId?.trim()) throw new Error('reviewerId is required');
        if (!['claim', 'extend', 'release'].includes(action)) throw new Error(`Unknown claim action ${action}`);
        const claim = activeClaim();
        if (claim && claim.reviewerId !== reviewerId) {
          throw new Error(`Already claimed by ${claim.reviewerId} until ${claim.expiresAt.slice(11, 19)} UTC`);
        }
        if ((action === 'extend' || action === 'release') && !claim) throw new Error('You hold no active claim on this case');
        if (action !== 'release' && view.approvals.some((a) => a.reviewerId === reviewerId)) {
          throw new Error(`Four-eyes: ${reviewerId} has already approved; a different reviewer must take it`);
        }
      },
    },
  );

  // ---- SLA watchdog: warns, then alerts; never cancels ------------------
  void (async () => {
    // The at-risk warning was added while applications were in flight: patched() keeps old runs on the
    // single-timer path they recorded.
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

  // ---- stages -----------------------------------------------------------
  async function validateAndCollectDocs(): Promise<EnrichmentCheck[] | 'DONE'> {
    for (;;) {
      if (isWithdrawn()) { await finishWithdrawn(); return 'DONE'; }
      await transition('VALIDATING', 'system');
      const v = await acts.validateApplication({ application: app, providedDocuments: [...provided] });
      if (v.hardFailures.length) {
        await finish('DECLINED', `rules:${v.policyVersion}`, `VALIDATION_FAILED: ${v.hardFailures.join(', ')}`);
        return 'DONE';
      }
      const missing = [...new Set([...v.missingDocuments, ...[...extraRequired].filter((d) => !provided.has(d))])];
      view.missingDocuments = missing;
      if (!missing.length) return v.enrichmentChecks;

      await transition('AWAITING_DOCS', 'system', `MISSING_DOCUMENTS: ${missing.join(', ')}`);
      view.pendingAction = `Applicant to upload: ${missing.join(', ')}`;
      await notify('applicant', 'DOCS_REQUESTED', { missing });
      const received = await waitWithReminder(
        () => missing.every((d) => provided.has(d)),
        async () => { await notify('applicant', 'DOCS_REMINDER', { missing }); await audit('DOCS_REMINDER_SENT', { actor: 'system' }); },
        timing.docsReminder, timing.docsTimeout,
      );
      if (!received) { await finish('DECLINED', 'system', 'ABANDONED_MISSING_DOCUMENTS'); return 'DONE'; }
      // withdrawn or documents in: loop back to re-validate
    }
  }

  async function humanReview(reasons: string[], required: number, round: number): Promise<ReviewResult> {
    view.approvals = [];
    view.approvalsRequired = required;
    reviewOutcome = undefined;
    await transition('HUMAN_REVIEW', 'system', reasons.join('; '), { approvalsRequired: required });
    view.reasons = reasons;
    view.pendingAction = required > 1 ? `Awaiting ${required} distinct reviewer approvals` : 'Awaiting reviewer decision';
    await notify('reviewer', 'REVIEW_REQUESTED', { reasons, approvalsRequired: required, reviewRound: round });

    // Wait for a decision. Meanwhile manage the claim lease: remind its holder before it ends, and let it
    // lapse so the case goes back to the queue. Only the overall review timeout escalates the application.
    const reviewDeadline = Date.now() + msToNumber(timing.reviewTimeout);
    view.reviewDeadline = new Date(reviewDeadline).toISOString();
    const reminderMs = msToNumber(timing.claimReminderBefore);
    const isDecided = () => !!withdrawal || !!reviewOutcome || view.approvals.length >= required;
    let decided = false;
    for (;;) {
      const seenGen = claimGen;
      const claim = view.claim;
      const claimEnd = claim ? Date.parse(claim.expiresAt) : Infinity;
      const nextClaimEvent = claim ? (claim.reminded ? claimEnd : claimEnd - reminderMs) : Infinity;
      const wakeAt = Math.min(reviewDeadline, nextClaimEvent);
      decided = await wf.condition(() => isDecided() || claimGen !== seenGen, Math.max(1, wakeAt - Date.now()));
      if (isDecided()) { decided = true; break; }
      if (claimGen !== seenGen) continue; // claimed, extended or released: recompute
      if (Date.now() >= reviewDeadline) { decided = false; break; }
      if (claim && view.claim === claim && !claim.reminded && Date.now() >= claimEnd - reminderMs) {
        claim.reminded = true;
        await notify('reviewer', 'CLAIM_EXPIRING', { reviewerId: claim.reviewerId, expiresAt: claim.expiresAt });
        await audit('CLAIM_EXPIRY_REMINDER', { actor: 'system', reason: `${claim.reviewerId}'s claim ends at ${claim.expiresAt.slice(11, 19)} UTC` });
      } else if (claim && view.claim === claim && Date.now() >= claimEnd) {
        view.claim = undefined;
        claimGen++;
        await audit('CLAIM_EXPIRED', { actor: 'system', reason: `${claim.reviewerId}'s claim lapsed; case returned to the queue` });
        await notify('reviewer', 'REVIEW_REQUESTED', { reasons, approvalsRequired: required, reviewRound: round, returnedToQueue: true });
      }
    }
    view.claim = undefined;
    if (!decided) return { kind: 'TIMEOUT' };
    if (reviewOutcome) return reviewOutcome;
    if (view.approvals.length >= required) return { kind: 'APPROVED', reviewers: view.approvals.map((a) => a.reviewerId) };
    return { kind: 'WITHDRAWN' };
  }

  /**
   * Provider downtime, workflow side. The application parks in AWAITING_PROVIDER (durable, no worker held),
   * then re-runs a fresh enrichment child for the failed checks only, waiting providerParkInitial, doubling
   * up to providerParkMax, until the checks succeed or providerOutageBudget is spent. Results that already
   * succeeded are kept, so nothing is re-pulled or re-billed. Ops can force an immediate retry.
   * Returns the merged result; any failures left go to human review.
   */
  async function waitOutProviderOutage(first: EnrichmentResult, checks: EnrichmentCheck[], round: number): Promise<EnrichmentResult | 'WITHDRAWN'> {
    let result = first;
    const unavailable = () => result.failures.filter((f) => f.kind === 'UNAVAILABLE');
    if (!unavailable().length) return result;

    const since = Date.now();
    const deadline = since + msToNumber(timing.providerOutageBudget);
    let delay = msToNumber(timing.providerParkInitial);
    let attempt = 0;
    const providers = () => [...new Set(unavailable().map((f) => f.provider))];
    // Fill in the wait details before the state flips, so a status query never sees one without the other.
    view.providerWait = {
      providers: providers(), attempts: 0, since: new Date(since).toISOString(),
      nextRetryAt: new Date(since + delay).toISOString(), deadline: new Date(deadline).toISOString(),
    };
    await transition('AWAITING_PROVIDER', 'system', `PROVIDER_UNAVAILABLE: ${providers().join(', ')}`, { failures: result.failures });
    await notify('ops', 'PROVIDER_OUTAGE', { providers: providers() });

    while (unavailable().length && Date.now() < deadline) {
      const wait = Math.min(delay, deadline - Date.now());
      view.providerWait = {
        providers: providers(), attempts: attempt, since: new Date(since).toISOString(),
        nextRetryAt: new Date(Date.now() + wait).toISOString(), deadline: new Date(deadline).toISOString(),
      };
      view.pendingAction = `Waiting for ${providers().join(', ')} to recover (retry ${attempt + 1} in ${Math.round(wait / 1000)}s)`;
      await wf.condition(() => !!retryNowRequested || isWithdrawn(), wait);
      if (isWithdrawn()) return 'WITHDRAWN';
      const forcedBy = retryNowRequested;
      retryNowRequested = undefined;
      attempt++;
      const retryChecks = checks.filter((c) => unavailable().some((f) => f.check === c));
      await audit('PROVIDER_RETRY', {
        actor: forcedBy ? `ops:${forcedBy}` : 'system',
        reason: `attempt ${attempt}: ${retryChecks.join(', ')}`,
        details: { attempt, checks: retryChecks, forced: !!forcedBy },
      });
      const retry = await runChild('enrichment', enrichmentWorkflow, TaskQueues.enrichment, round, {
        applicationId: id, application: app, checks: retryChecks, timing,
      }, `.retry-${attempt}`);
      const kept = result.failures.filter((f) => !retryChecks.includes(f.check as EnrichmentCheck));
      result = { ...result, ...retry, failures: [...kept, ...retry.failures] };
      view.enrichment = result;
      delay = Math.min(delay * 2, msToNumber(timing.providerParkMax));
    }
    view.providerWait = view.providerWait && { ...view.providerWait, attempts: attempt, nextRetryAt: undefined };
    await audit(unavailable().length ? 'PROVIDER_OUTAGE_BUDGET_EXHAUSTED' : 'PROVIDER_RECOVERED', {
      actor: 'system', details: { attempts: attempt, waitedMs: Date.now() - since, failures: result.failures },
    });
    return result;
  }

  async function run(): Promise<void> {
    wf.upsertSearchAttributes([
      { key: SA.status, value: 'RECEIVED' }, { key: SA.product, value: app.productType },
      { key: SA.channel, value: app.channel }, { key: SA.slaBreached, value: false },
    ]);
    await audit('APPLICATION_RECEIVED', {
      actor: `channel:${app.channel.toLowerCase()}`, to: 'RECEIVED',
      details: {
        applicantName: view.applicantName, amount: app.amount, termMonths: app.termMonths, documents: app.documents, brokerId: app.brokerId,
        scenario: app.scenario, slaDeadline: view.slaDeadline,
        slaAtRiskAt: new Date(Date.parse(view.slaDeadline) - msToNumber(timing.overallSla) + Math.min(msToNumber(timing.slaAtRiskAfter), msToNumber(timing.overallSla))).toISOString(),
      },
    });

    let round = 0;
    let reviewRound = 0;
    let approval: { actor: string; reason: string } | undefined;

    for (;;) {
      const checks = await validateAndCollectDocs();
      if (checks === 'DONE') return;
      view.missingDocuments = [];
      round++;

      if (isWithdrawn()) return finishWithdrawn();
      await transition('ENRICHING', 'system', undefined, { checks, round });
      const firstPass = await runChild('enrichment', enrichmentWorkflow, TaskQueues.enrichment, round, {
        applicationId: id, application: app, checks, timing,
      });
      view.enrichment = firstPass;
      const enrichment = await waitOutProviderOutage(firstPass, checks, round);
      if (enrichment === 'WITHDRAWN') return finishWithdrawn();

      let review: { reasons: string[]; required: number } | undefined;
      if (enrichment.failures.length) {
        await audit('ENRICHMENT_PARTIAL', { actor: 'system', details: { failures: enrichment.failures } });
        review = { reasons: enrichment.failures.map((f) => `ENRICHMENT_FAILED(${f.provider}): ${f.error}`), required: 1 };
      } else {
        if (isWithdrawn()) return finishWithdrawn();
        await transition('UNDERWRITING', 'system', undefined, { round });
        const uw = await runChild('underwriting', UNDERWRITING_WORKFLOWS[app.productType], TaskQueues.underwriting(app.productType), round, {
          applicationId: id, application: app, enrichment, timing,
        });
        view.underwriting = uw;
        const rulesActor = `rules:${uw.policyVersion}`;
        await audit('UNDERWRITING_DECISION', {
          actor: rulesActor, reason: uw.reasons.join('; '),
          details: { outcome: uw.outcome, metrics: uw.metrics, requiredApprovals: uw.requiredApprovals, failures: uw.failures },
        });
        if (uw.outcome === 'DECLINE') return finish('DECLINED', rulesActor, uw.reasons.join('; '), { metrics: uw.metrics });
        if (uw.outcome === 'REFER') {
          review = {
            reasons: [...uw.reasons, ...uw.failures.map((f) => `CHECK_FAILED(${f.provider})`)],
            required: Math.max(1, uw.requiredApprovals),
          };
        } else {
          approval = { actor: rulesActor, reason: uw.reasons.join('; ') };
        }
      }

      if (review) {
        reviewRound++;
        const r = await humanReview(review.reasons, review.required, reviewRound);
        if (r.kind === 'TIMEOUT') return finish('ESCALATED', 'system', `REVIEW_TIMEOUT: no decision within ${timing.reviewTimeout}`);
        if (r.kind === 'WITHDRAWN') return finishWithdrawn();
        if (r.kind === 'DECLINED') return finish('DECLINED', `reviewer:${r.reviewerId}`, `REVIEWER_DECLINED: ${r.reason}`);
        if (r.kind === 'REQUEST_INFO') {
          r.documents.forEach((d) => { extraRequired.add(d); provided.delete(d); });
          continue; // back through validation, document collection and fresh enrichment/underwriting children
        }
        approval = { actor: `reviewer:${r.reviewers.join('+')}`, reason: `REVIEWER_APPROVED (${r.reviewers.length}/${review.required})` };
      }
      break;
    }

    // ---- agreement e-signature (an outside wait, so it lives here) -------
    if (isWithdrawn()) return finishWithdrawn();
    const envelopeId = `${id}-agreement-${round}`; // decided in the workflow: a retried send can't create a second envelope
    await acts.sendEnvelope({ applicationId: id, envelopeId, application: app });
    view.signature = { envelopeId };
    await transition('AWAITING_SIGNATURE', approval!.actor, approval!.reason, { envelopeId });
    view.pendingAction = 'Applicant to sign the loan agreement';
    await notify('applicant', 'AGREEMENT_SENT', { envelopeId });
    const signed = await waitWithReminder(
      () => !!view.signature?.signedAt,
      async () => { await notify('applicant', 'SIGNATURE_REMINDER', { envelopeId }); await audit('SIGNATURE_REMINDER_SENT', { actor: 'system' }); },
      timing.signatureReminder, timing.signatureTimeout,
    );
    if (!signed) return finish('DECLINED', 'system', 'OFFER_LAPSED_AGREEMENT_NOT_SIGNED');
    if (isWithdrawn()) return finishWithdrawn();

    // ---- sanctions screen (added while applications were already in flight) ----
    // patched() is true for new runs and for old runs that haven't reached this point yet. Runs that
    // already passed it replay without it, so their recorded history (no screening activity) still
    // matches the code: no non-determinism error, no stuck workflows. test/versioning.test.ts replays
    // histories recorded before this change. Once no pre-patch runs remain: deprecatePatch(), then
    // remove the branch.
    if (wf.patched('sanctions-screen-before-disbursement')) {
      const screen = await acts.screenSanctions({ applicationId: id, application: app });
      await audit('SANCTIONS_SCREENED', { actor: 'provider:sanctions', reason: screen.match ? `potential match on ${screen.list}` : 'no match', details: { ...screen } });
      if (screen.match) {
        return finish('ESCALATED', 'provider:sanctions', `SANCTIONS_POTENTIAL_MATCH: ${screen.list} (compliance must clear before payout)`);
      }
    }

    // ---- money movement: not interruptible from here --------------------
    await transition('DISBURSING', 'system');
    const payout = await runChild('disbursement', disbursementWorkflow, TaskQueues.disbursement, 1, {
      applicationId: id, application: app, envelopeId, timing,
    });
    view.disbursement = payout;
    if (payout.status === 'FUNDED') {
      return finish('FUNDED', 'system', `FUNDED: loan ${payout.loanNumber}, payout ${payout.payoutRef}`, { ...payout });
    }
    return finish('ESCALATED', 'system', `PAYOUT_REJECTED: ${payout.reason}`, { ...payout });
  }

  try {
    await run();
  } catch (err) {
    // A Temporal failure that escaped a stage (child failed, activity out of retries) must still end in a
    // terminal state. Plain code bugs are not caught: they fail the workflow task, Temporal retries it,
    // and the run resumes once a fix is deployed.
    if (wf.isCancellation(err) || !(err instanceof wf.ChildWorkflowFailure || err instanceof wf.ActivityFailure)) throw err;
    await finish('ESCALATED', 'system', `SYSTEM_FAILURE_IN_${view.status}: ${rootMessage(err)}`);
  }
  await wf.condition(wf.allHandlersFinished); // don't drop an in-flight update or signal handler
  return view;
}
