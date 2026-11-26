import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderStatusStore } from '../src/activities/providerHealth';
import { IngestOutbox } from '../src/ingest/outbox';
import { createUiServer } from '../src/ui/server';
import { priceLoan } from '../src/billing/tariff';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowUpdateFailedError } from '@temporalio/client';
import { fromBrokerEmail } from '../src/ingest/adapters';
import { sampleBrokerEmail } from '../src/ingest/samples';
import { TaskQueues } from '../src/shared/config';
import type { ReviewDecision } from '../src/shared/types';
import type { SynthesizeProgress } from '../src/workflows/synthesize';
import {
  agreementSignedSignal, claimReviewUpdate, documentsUploadedSignal, retryProvidersNowSignal, submitReviewDecisionUpdate, withdrawSignal,
} from '../src/workflows/definitions';
import { path_, result, scenario, start, startHarness, TEST_TIMING, waitForStatus, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h?.teardown(); });

const review = (workflowId: string, d: Partial<ReviewDecision>) =>
  h.client.workflow.getHandle(workflowId).executeUpdate(submitReviewDecisionUpdate, {
    args: [{ decision: 'APPROVE', reviewerId: 'alice', reason: 'Looks fine after call', ...d } as ReviewDecision],
  });

async function rejection(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(WorkflowUpdateFailedError);
    return ((e as Error).cause as Error).message;
  }
  throw new Error('expected the update to be rejected');
}

describe('happy and automated paths', () => {
  it('auto-approves, collects the signature and funds through three child workflows', async () => {
    const { workflowId } = await start(h, scenario('happy'));
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(path_(s)).toEqual(['VALIDATING', 'ENRICHING', 'UNDERWRITING', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED']);
    expect(s.children.map((c) => [c.stage, c.workflowType, c.taskQueue])).toEqual([
      ['enrichment', 'enrichmentWorkflow', TaskQueues.enrichment],
      ['underwriting', 'personalLoanUnderwriting', 'underwriting-personal'],
      ['disbursement', 'disbursementWorkflow', TaskQueues.disbursement],
      ['billing', 'billingWorkflow', TaskQueues.billing],
    ]);
    // Children are real executions with deterministic IDs.
    const child = await h.client.workflow.getHandle(`${workflowId}/enrichment`).describe();
    expect(child.status.name).toBe('COMPLETED');
    expect(child.parentExecution?.workflowId).toBe(workflowId);
    expect(s.disbursement?.status).toBe('FUNDED');
    expect(s.signature?.signedAt).toBeTruthy();
  });

  it('runs product-specific underwriting children (auto and debt consolidation)', async () => {
    const auto = await start(h, scenario('happy', (a) => {
      a.productType = 'AUTO'; a.amount = 20_000; a.termMonths = 60;
      a.vehicle = { vin: '1HGCV1F30LA000001', purchasePrice: 24_000 };
      a.documents = ['GOV_ID', 'PAYSTUB', 'VEHICLE_PURCHASE_AGREEMENT'];
    }));
    const debt = await start(h, scenario('happy', (a) => {
      a.productType = 'DEBT_CONSOLIDATION'; a.amount = 9_000; a.termMonths = 36;
      a.debtsToConsolidate = [{ creditor: 'Card A', balance: 5_000 }, { creditor: 'Card B', balance: 4_000 }];
      a.documents = ['GOV_ID', 'PAYSTUB', 'DEBT_STATEMENTS'];
    }));
    const [a, d] = await Promise.all([result(h, auto.workflowId), result(h, debt.workflowId)]);
    expect(a.status).toBe('FUNDED');
    expect(a.children[1]).toMatchObject({ workflowType: 'autoLoanUnderwriting', taskQueue: 'underwriting-auto' });
    expect(a.underwriting?.metrics.ltv).toBeCloseTo(0.83, 2);
    expect(a.underwriting?.policyVersion).toMatch(/^auto-/);
    expect(d.status).toBe('FUNDED');
    expect(d.children[1]).toMatchObject({ workflowType: 'debtConsolidationUnderwriting', taskQueue: 'underwriting-debt-consolidation' });
    expect(d.underwriting?.metrics.verifiedDebt).toBe(9_000);
  });

  it('retries a flaky credit bureau (429 then resets) without re-calling the other providers', async () => {
    const { workflowId } = await start(h, scenario('flaky'));
    const s = await result(h, workflowId);
    expect(s.status).toBe("FUNDED");
    const history = await h.client.workflow.getHandle(`${workflowId}/enrichment`).fetchHistory();
    const scheduled = history.events!.filter((e) => e.activityTaskScheduledEventAttributes).map((e) => e.activityTaskScheduledEventAttributes!.activityType!.name);
    expect(scheduled.sort()).toEqual(['checkFraud', 'fetchCreditReport', 'verifyIdentity']); // scheduled once each
    const completed = history.events!.find((e) => e.activityTaskStartedEventAttributes?.attempt === 4);
    expect(completed).toBeTruthy(); // credit succeeded on attempt 4
  });

  it('declines on product rules (low credit)', async () => {
    const s = await result(h, (await start(h, scenario('low-credit'))).workflowId);
    expect(s.status).toBe('DECLINED');
    expect(s.reasons[0]).toMatch(/CREDIT_SCORE_BELOW_580/);
    expect(s.history.at(-1)?.actor).toMatch(/^rules:personal-/);
  });

  it('declines at validation (under 18) before any provider is called', async () => {
    const { workflowId } = await start(h, scenario('under-18'));
    const s = await result(h, workflowId);
    expect(path_(s)).toEqual(['VALIDATING', 'DECLINED']);
    expect(s.reasons[0]).toMatch(/APPLICANT_UNDER_18/);
    expect(s.children).toEqual([]); // no enrichment child, so no credit pull or other paid call
    const history = await h.client.workflow.getHandle(workflowId).fetchHistory();
    const activities = history.events!.filter((e) => e.activityTaskScheduledEventAttributes).map((e) => e.activityTaskScheduledEventAttributes!.activityType!.name);
    expect(activities.filter((a) => !['recordAuditEvent', 'notify'].includes(a ?? ''))).toEqual(['validateApplication']);
  });

  it('screens sanctions before money moves (new step, gated with patched)', async () => {
    const funded = await result(h, (await start(h, scenario('happy'))).workflowId);
    expect(h.audit.forApplication(funded.applicationId).find((e) => e.type === 'SANCTIONS_SCREENED')?.reason).toBe('no match');
    const { workflowId } = await start(h, scenario('sanctions-hit'));
    const s = await result(h, workflowId);
    expect(s.status).toBe('ESCALATED');
    expect(s.reasons[0]).toMatch(/SANCTIONS_POTENTIAL_MATCH/);
    expect(s.signature?.signedAt).toBeTruthy(); // signed, but no payout
    expect(s.children.map((c) => c.stage)).not.toContain('disbursement');
  });
});

describe('human in the loop', () => {
  it('fraud signals pause for review; approval resumes to FUNDED', async () => {
    const { workflowId } = await start(h, scenario('fraud'));
    const paused = await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    expect(paused.reasons.join()).toMatch(/FRAUD_SIGNALS/);
    const ack = await review(workflowId, { decision: 'APPROVE', reviewerId: 'alice', reason: 'Device change explained by applicant' });
    expect(ack).toMatchObject({ accepted: true, approvalsReceived: 1, approvalsRequired: 1 });
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(s.history.find((t) => t.to === 'AWAITING_SIGNATURE')?.actor).toBe('reviewer:alice');
  });

  it('reviewer decline ends DECLINED with the reviewer as actor', async () => {
    const { workflowId } = await start(h, scenario('fraud'));
    await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    await review(workflowId, { decision: 'DECLINE', reviewerId: 'bob', reason: 'Synthetic identity pattern' });
    const s = await result(h, workflowId);
    expect(s.status).toBe('DECLINED');
    expect(s.history.at(-1)).toMatchObject({ actor: 'reviewer:bob' });
  });

  it('validator rejects bad decisions; four-eyes needs two distinct reviewers', async () => {
    const { workflowId } = await start(h, scenario('four-eyes'));
    const paused = await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    expect(paused.approvalsRequired).toBe(2);
    expect(await rejection(review(workflowId, { reason: '' }))).toMatch(/reason/);
    expect(await rejection(review(workflowId, { decision: 'REQUEST_INFO' }))).toMatch(/requestedDocuments/);
    await review(workflowId, { reviewerId: 'alice' });
    expect(await rejection(review(workflowId, { reviewerId: 'alice' }))).toMatch(/Four-eyes/);
    expect((await waitForStatus(h, workflowId, 'HUMAN_REVIEW')).approvals).toHaveLength(1);
    await review(workflowId, { reviewerId: 'carol', reason: 'Second approval: income verified' });
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(s.history.find((t) => t.to === 'AWAITING_SIGNATURE')?.actor).toBe('reviewer:alice+carol');
    // A closed application accepts no further decisions.
    await expect(review(workflowId, { reviewerId: 'dave' })).rejects.toThrow();
  });

  it('request-info loops back through docs and runs fresh enrichment and underwriting children', async () => {
    const { workflowId, handle } = await start(h, scenario('fraud'));
    await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    await review(workflowId, { decision: 'REQUEST_INFO', reason: 'Need a recent bank statement', requestedDocuments: ['BANK_STATEMENT'] });
    const waiting = await waitForStatus(h, workflowId, 'AWAITING_DOCS');
    expect(waiting.missingDocuments).toEqual(['BANK_STATEMENT']);
    await handle.signal(documentsUploadedSignal, { documents: ['BANK_STATEMENT'], uploadedBy: 'test' });
    await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    await review(workflowId, { reviewerId: 'bob', reason: 'Bank statement confirms income' });
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(s.children.map((c) => c.workflowId.split('/')[1])).toEqual(['enrichment', 'underwriting', 'enrichment-2', 'underwriting-2', 'disbursement', 'billing']);
  });

  it('escalates when nobody reviews in time', async () => {
    const { workflowId } = await start(h, scenario('fraud'));
    const s = await result(h, workflowId);
    expect(s.status).toBe('ESCALATED');
    expect(s.reasons[0]).toMatch(/REVIEW_TIMEOUT/);
  });

  it('the simulated reviewer answers through the same update a person would use', async () => {
    const { workflowId } = await start(h, scenario('four-eyes', (a) => { a.simulate = { ...a.simulate, reviewer: { decision: 'APPROVE', afterMs: 200 } }; }));
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(s.approvals.map((a) => a.reviewerId)).toEqual(['sim-reviewer-avery', 'sim-reviewer-blake']);
  });
});

describe('third-party failures', () => {
  it('a long provider outage parks the application, retries only the failed check, then goes to review', async () => {
    const { workflowId } = await start(h, scenario('outage'));
    const parked = await waitForStatus(h, workflowId, 'AWAITING_PROVIDER', 20_000);
    expect(parked.reasons[0]).toMatch(/PROVIDER_UNAVAILABLE: identity/);
    expect(parked.enrichment?.credit).toBeTruthy(); // successful calls are kept while parked
    const inReview = await waitForStatus(h, workflowId, 'HUMAN_REVIEW', 60_000);
    expect(inReview.reasons[0]).toMatch(/ENRICHMENT_FAILED\(identity\)/);
    const retries = inReview.children.filter((c) => c.workflowId.includes('.retry-'));
    expect(retries.length).toBeGreaterThan(0);
    expect(inReview.children.some((c) => c.stage === 'underwriting')).toBe(false); // underwriting skipped
    const retryHistory = await h.client.workflow.getHandle(retries[0].workflowId).fetchHistory();
    const retried = retryHistory.events!.filter((e) => e.activityTaskScheduledEventAttributes).map((e) => e.activityTaskScheduledEventAttributes!.activityType!.name);
    expect([...new Set(retried)]).toEqual(['verifyIdentity']); // credit and fraud are not re-pulled
    expect(h.audit.forApplication(workflowId).map((e) => e.type)).toContain('PROVIDER_OUTAGE_BUDGET_EXHAUSTED');
    await review(workflowId, { reason: 'Identity verified manually by phone' });
    expect((await result(h, workflowId)).status).toBe('FUNDED');
  }, 120_000);

  it('a provider blip parks the application, then it recovers and funds on its own', async () => {
    const { workflowId } = await start(h, scenario('provider-blip', (a) => { a.simulate!.outageUntil = new Date(Date.now() + 9_500).toISOString(); }), { ...TEST_TIMING, providerOutageBudget: '30s' });
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(path_(s)).toContain('AWAITING_PROVIDER');
    expect(path_(s)[path_(s).indexOf('AWAITING_PROVIDER') + 1]).toBe('UNDERWRITING');
    expect(h.audit.forApplication(workflowId).map((e) => e.type)).toContain('PROVIDER_RECOVERED');
  }, 60_000);

  it('a global outage trips the circuit breaker; switching the provider back on resumes parked applications', async () => {
    h.health.status.set('fraud', true);
    try {
      const apps = await Promise.all([1, 2, 3, 4].map(() => start(h, scenario('happy'), { ...TEST_TIMING, providerOutageBudget: '60s', providerParkInitial: '30s' })));
      await Promise.all(apps.map((a) => waitForStatus(h, a.workflowId, 'AWAITING_PROVIDER', 30_000)));
      expect(h.health.breakers.fraud.trips).toBeGreaterThan(0); // stopped hammering the vendor
      const parked = await waitForStatus(h, apps[0].workflowId, 'AWAITING_PROVIDER');
      expect(parked.providerWait?.providers).toEqual(['fraud']);
      h.health.status.set('fraud', false);
      await new Promise((r) => setTimeout(r, 1100)); // let the circuit's cooldown pass
      // The scheduled retry is 30s away; an operator nudge retries now.
      await Promise.all(apps.map((a) => a.handle.signal(retryProvidersNowSignal, { requestedBy: 'test' })));
      const done = await Promise.all(apps.map((a) => result(h, a.workflowId)));
      expect(done.map((d) => d.status)).toEqual(['FUNDED', 'FUNDED', 'FUNDED', 'FUNDED']);
      expect(h.health.breakers.fraud.state).toBe('CLOSED');
      expect(h.audit.forApplication(apps[0].workflowId).find((e) => e.type === 'PROVIDER_RETRY')?.actor).toBe('ops:test');
    } finally {
      h.health.status.set('fraud', false);
    }
  }, 90_000);

  it('core-banking downtime is waited out by the disbursement child, not escalated', async () => {
    const { workflowId } = await start(h, scenario('banking-blip', (a) => { a.simulate!.bankingDownUntil = new Date(Date.now() + 4_000).toISOString(); }));
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    const history = await h.client.workflow.getHandle(`${workflowId}/disbursement`).fetchHistory();
    const attempts = history.events!.filter((e) => e.activityTaskStartedEventAttributes).map((e) => e.activityTaskStartedEventAttributes!.attempt ?? 1);
    expect(Math.max(...attempts)).toBeGreaterThan(1);
  }, 60_000);

  it('a non-retryable identity miss goes straight to review', async () => {
    const started = Date.now();
    const { workflowId } = await start(h, scenario('identity-not-found'));
    const paused = await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    expect(Date.now() - started).toBeLessThan(2500); // no retry budget spent
    expect(paused.reasons[0]).toMatch(/SubjectNotFound/);
  });

  it('a failing underwriting child escalates as a system failure', async () => {
    const s = await result(h, (await start(h, scenario('rules-error'))).workflowId);
    expect(s.status).toBe('ESCALATED');
    expect(s.reasons[0]).toMatch(/SYSTEM_FAILURE_IN_UNDERWRITING: .*RulesEngineError/);
  });

  it('a rejected payout escalates with the bank reason', async () => {
    const s = await result(h, (await start(h, scenario('payout-reject'))).workflowId);
    expect(s.status).toBe('ESCALATED');
    expect(s.reasons[0]).toMatch(/PAYOUT_REJECTED: .*account closed/);
  });

  it('notification outages are audited but never block the application', async () => {
    const { workflowId } = await start(h, scenario('happy', (a) => { a.simulate = { ...a.simulate, notificationsDown: true, applicant: { signs: 'manual' } }; }));
    const waiting = await waitForStatus(h, workflowId, 'AWAITING_SIGNATURE');
    await h.client.workflow.getHandle(workflowId).signal(agreementSignedSignal, { envelopeId: waiting.signature!.envelopeId, signerName: 'x', signedAt: new Date().toISOString() });
    expect((await result(h, workflowId)).status).toBe('FUNDED');
    expect(h.audit.forApplication(workflowId).some((e) => e.type === 'NOTIFICATION_FAILED')).toBe(true);
  });
});

describe('documents, signature and withdrawal', () => {
  it('waits for missing documents, then continues', async () => {
    const { workflowId, handle } = await start(h, scenario('missing-docs'));
    const waiting = await waitForStatus(h, workflowId, 'AWAITING_DOCS');
    expect(waiting.missingDocuments).toEqual(['PAYSTUB']);
    await handle.signal(documentsUploadedSignal, { documents: ['PAYSTUB'], uploadedBy: 'test' });
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(path_(s).slice(0, 3)).toEqual(['VALIDATING', 'AWAITING_DOCS', 'VALIDATING']);
  });

  it('declines as abandoned after a reminder', async () => {
    const { workflowId } = await start(h, scenario('abandon'));
    const s = await result(h, workflowId);
    expect(s.status).toBe('DECLINED');
    expect(s.reasons[0]).toBe('ABANDONED_MISSING_DOCUMENTS');
    expect(h.audit.forApplication(workflowId).map((e) => e.type)).toContain('DOCS_REMINDER_SENT');
  });

  it('ignores a stale signature webhook and lapses the offer when nobody signs', async () => {
    const { workflowId, handle } = await start(h, scenario('offer-lapse'));
    await waitForStatus(h, workflowId, 'AWAITING_SIGNATURE');
    await handle.signal(agreementSignedSignal, { envelopeId: 'some-other-envelope', signerName: 'x', signedAt: new Date().toISOString() });
    const s = await result(h, workflowId);
    expect(s.status).toBe('DECLINED');
    expect(s.reasons[0]).toBe('OFFER_LAPSED_AGREEMENT_NOT_SIGNED');
    expect(h.audit.forApplication(workflowId).map((e) => e.type)).toContain('WEBHOOK_IGNORED');
  });

  it('honours a withdrawal at the next wait', async () => {
    const { workflowId, handle } = await start(h, scenario('missing-docs'));
    await waitForStatus(h, workflowId, 'AWAITING_DOCS');
    await handle.signal(withdrawSignal, { reason: 'Found a better rate', requestedBy: 'applicant' });
    const s = await result(h, workflowId);
    expect(s.status).toBe('DECLINED');
    expect(s.reasons[0]).toBe('WITHDRAWN: Found a better rate');
  });

  it('a withdrawal while a child stage is running is honoured at the next boundary, before any money moves', async () => {
    // A flaky bureau keeps the enrichment child busy for a second or so: withdraw while it runs.
    const { workflowId, handle } = await start(h, scenario('flaky'));
    await waitForStatus(h, workflowId, 'ENRICHING');
    await handle.signal(withdrawSignal, { reason: 'Changed my mind', requestedBy: 'applicant' });
    const s = await result(h, workflowId);
    expect(s.status).toBe('DECLINED');
    expect(s.reasons[0]).toBe('WITHDRAWN: Changed my mind');
    expect(path_(s)).toEqual(['VALIDATING', 'ENRICHING', 'DECLINED']); // stopped before underwriting
    expect(s.children.map((c) => c.stage)).toEqual(['enrichment']);
    expect(s.disbursement).toBeUndefined();
  });

  it('the simulated applicant can withdraw while asked for documents', async () => {
    const s = await result(h, (await start(h, scenario('withdraw'))).workflowId);
    expect(s.status).toBe('DECLINED');
    expect(s.reasons[0]).toMatch(/^WITHDRAWN/);
  });

  it('flags an SLA breach without cancelling anything', async () => {
    const { workflowId, handle } = await start(h, scenario('esign'), { ...TEST_TIMING, overallSla: '1s', signatureReminder: '5s' });
    await waitForStatus(h, workflowId, 'AWAITING_SIGNATURE');
    await new Promise((r) => setTimeout(r, 1500));
    const mid = await waitForStatus(h, workflowId, 'AWAITING_SIGNATURE');
    expect(mid.slaBreached).toBe(true);
    await handle.signal(agreementSignedSignal, { envelopeId: mid.signature!.envelopeId, signerName: 'x', signedAt: new Date().toISOString() });
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(s.slaBreached).toBe(true);
  });
});

describe('ingestion', () => {
  it('collapses a re-delivered broker email into the same workflow', async () => {
    const app = fromBrokerEmail(sampleBrokerEmail(`<dup-${Date.now()}@brokers.example>`));
    const first = await start(h, app);
    const second = await start(h, app);
    expect(second.workflowId).toBe(first.workflowId);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    await first.handle.terminate('test cleanup');
  });

  it('fans out an aggregator file: valid rows start, bad rows are rejected, duplicate rows absorbed', async () => {
    const handle = await h.client.workflow.start('batchIngestWorkflow', {
      workflowId: `batch-test-${Date.now()}`, taskQueue: TaskQueues.orchestration,
      args: [{ filePath: path.resolve('samples/aggregator-feed.csv'), pageSize: 2, timing: TEST_TIMING }],
    });
    const totals = await handle.result();
    expect(totals.started).toBe(4);
    expect(totals.duplicates).toBe(1);
    expect(totals.rejected).toEqual([{ rowRef: 'ratehub-r1004', error: 'invalid amount "not-a-number"' }]);
    const s = await result(h, 'loan-aggregator-ratehub-r1001');
    expect(s.status).toBe('FUNDED');
  });

  it('the synthesizer starts many applications that run in parallel to terminal states', async () => {
    const handle = await h.client.workflow.start('synthesizeWorkflow', {
      workflowId: `synth-t${Date.now().toString(36)}`, taskQueue: TaskQueues.orchestration,
      args: [{ count: 12, mix: 'happy', ratePerSecond: 12, autoResolve: true, seed: 7, timing: TEST_TIMING }],
    });
    const progress = await handle.result();
    expect(progress.startedSoFar).toBe(12);
    const ids: string[] = [];
    for await (const w of h.client.workflow.list({ query: `WorkflowId STARTS_WITH 'loan-' AND ExecutionStatus='Running'` })) ids.push(w.workflowId);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => `syn-${progress.runTag}-${String(i + 1).padStart(4, '0')}`)
        .map(async (ref) => {
          for (const ch of ['portal', 'broker-email', 'aggregator']) {
            try { return await result(h, `loan-${ch}-${ref}`); } catch { /* try next channel */ }
          }
          throw new Error(`no workflow for ${ref}`);
        }),
    );
    expect(results.every((r) => r.status === 'FUNDED')).toBe(true);
  });
});

describe('scenario packs', () => {
  it('the showcase pack starts every scenario at once, absorbs its duplicate, and every application terminates', async () => {
    const handle = await h.client.workflow.start('synthesizeWorkflow', {
      workflowId: `synth-showcase-t${Date.now().toString(36)}`, taskQueue: TaskQueues.orchestration,
      // Simulated people answer within ~9s (reviews) and ~5s (uploads), so widen those windows for this test.
      args: [{ count: 0, pack: 'showcase', ratePerSecond: 25, seed: 11, timing: { ...TEST_TIMING, reviewTimeout: '12s', docsReminder: '4s', docsTimeout: '4s' } }],
    });
    const progress = (await handle.result()) as SynthesizeProgress;
    expect(progress.total).toBe(21);
    expect(progress.workflowIds).toHaveLength(20);
    expect(progress.duplicatesAbsorbed).toBe(1);
    expect(Object.keys(progress.byScenario).length).toBe(20);
    const finals = await Promise.all(progress.workflowIds.map((id) => result(h, id)));
    expect(finals.every((f) => ['FUNDED', 'DECLINED', 'ESCALATED'].includes(f.status))).toBe(true);
    const by = Object.fromEntries(finals.map((f) => [f.scenario, f.status]));
    expect(by).toMatchObject({
      happy: 'FUNDED', 'auto-happy': 'FUNDED', 'debtcon-happy': 'FUNDED', flaky: 'FUNDED', 'banking-blip': 'FUNDED',
      'missing-docs': 'FUNDED', 'request-info': 'FUNDED',
      abandon: 'DECLINED', withdraw: 'DECLINED', 'low-credit': 'DECLINED', 'under-18': 'DECLINED', 'offer-lapse': 'DECLINED',
      'payout-reject': 'ESCALATED', 'rules-error': 'ESCALATED',
    });
  }, 120_000);
});

describe('audit', () => {
  it('records every transition and decision with actor and reason', async () => {
    const { workflowId } = await start(h, scenario('fraud'));
    await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    await review(workflowId, { reviewerId: 'erin', reason: 'Verified with applicant' });
    await result(h, workflowId);
    const events = h.audit.forApplication(workflowId);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('APPLICATION_RECEIVED');
    expect(types).toContain('UNDERWRITING_DECISION');
    expect(types).toContain('REVIEW_DECISION');
    expect(types).toContain('AGREEMENT_SIGNED');
    expect(events.find((e) => e.type === 'REVIEW_DECISION')).toMatchObject({ actor: 'reviewer:erin', reason: 'Verified with applicant' });
    const transitions = events.filter((e) => e.type === 'TRANSITION').map((e) => e.to);
    expect(transitions.at(-1)).toBe('FUNDED');
    // The review decision is recorded before the transition it caused.
    expect(types.indexOf('REVIEW_DECISION')).toBeLessThan(events.findIndex((e) => e.to === 'AWAITING_SIGNATURE'));
    expect(new Set(events.map((e) => e.eventKey)).size).toBe(events.length);
  });
});

describe('review claims (leases) and safe retries', () => {
  const claimFor = (workflowId: string, reviewerId: string, action: 'claim' | 'extend' | 'release') =>
    h.client.workflow.getHandle(workflowId).executeUpdate(claimReviewUpdate, { args: [{ reviewerId, action }] });

  it('only the claimant can decide while a claim is active; deciding ends the claim', async () => {
    const { workflowId } = await start(h, scenario('four-eyes'));
    await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    const claim = await claimFor(workflowId, 'bob', 'claim');
    expect(claim?.reviewerId).toBe('bob');
    expect(await rejection(claimFor(workflowId, 'alice', 'claim'))).toMatch(/Already claimed by bob/);
    expect(await rejection(review(workflowId, { reviewerId: 'alice' }))).toMatch(/Claimed by bob/);
    await review(workflowId, { reviewerId: 'bob', reason: 'Income verified' });
    const after = await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    expect(after.claim).toBeUndefined(); // free for the second reviewer
    expect(await rejection(claimFor(workflowId, 'bob', 'claim'))).toMatch(/Four-eyes/);
    await claimFor(workflowId, 'carol', 'claim');
    await review(workflowId, { reviewerId: 'carol', reason: 'Second approval' });
    expect((await result(h, workflowId)).status).toBe('FUNDED');
  });

  it('reminds the claimant before the lease ends, then returns the case to the queue', async () => {
    const { workflowId } = await start(h, scenario('fraud'), { ...TEST_TIMING, reviewTimeout: '30s', claimLease: '3s', claimReminderBefore: '1500ms' });
    await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    const first = await claimFor(workflowId, 'bob', 'claim');
    const extended = await claimFor(workflowId, 'bob', 'extend');
    expect(Date.parse(extended!.expiresAt)).toBeGreaterThanOrEqual(Date.parse(first!.expiresAt));
    await new Promise((r) => setTimeout(r, 4500));
    const s = await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    expect(s.claim).toBeUndefined(); // lapsed: back in the queue, the application itself still waiting
    const types = h.audit.forApplication(workflowId).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['CLAIMED', 'CLAIM_EXTENDED', 'CLAIM_EXPIRY_REMINDER', 'CLAIM_EXPIRED']));
    expect(types.indexOf('CLAIM_EXPIRY_REMINDER')).toBeLessThan(types.indexOf('CLAIM_EXPIRED'));
    await claimFor(workflowId, 'alice', 'claim'); // anyone can pick it up now
    await review(workflowId, { reviewerId: 'alice', reason: 'Picked up after the lapse' });
    expect((await result(h, workflowId)).status).toBe('FUNDED');
  });

  it('a retried decision with the same request ID is applied once', async () => {
    const { workflowId } = await start(h, scenario('four-eyes'));
    await waitForStatus(h, workflowId, 'HUMAN_REVIEW');
    const handle = h.client.workflow.getHandle(workflowId);
    const send = () => handle.executeUpdate(submitReviewDecisionUpdate, {
      args: [{ decision: 'APPROVE', reviewerId: 'alice', reason: 'Verified income' }], updateId: 'decision-retry-test',
    });
    const [a, b] = [await send(), await send()];
    expect(a.approvalsReceived).toBe(1);
    expect(b.approvalsReceived).toBe(1); // the second call got the first call's result back
    expect(h.audit.forApplication(workflowId).filter((e) => e.type === 'REVIEW_DECISION')).toHaveLength(1);
    await handle.terminate('test cleanup');
  });
});

describe('ops console API', () => {
  it('Clear synthesized deletes scenario applications and their children, rotates the audit log, and keeps the rest', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ui-'));
    const server = createUiServer({ client: h.client, audit: h.audit, billing: h.billing, outbox: new IngestOutbox(path.join(dir, 'outbox.jsonl')), providerStatus: new ProviderStatusStore(path.join(dir, 'ps.json')) });
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      // A synthesized application (scenario set) and an adapter sample with no scenario.
      const synthetic = await start(h, scenario('happy'));
      const sample = await start(h, fromBrokerEmail(sampleBrokerEmail(`<keep-${Date.now()}@brokers.example>`)));
      await result(h, synthetic.workflowId);
      await waitForStatus(h, sample.workflowId, 'AWAITING_DOCS');
      await new Promise((r) => setTimeout(r, 1500)); // Visibility is eventually consistent
      const summary = (await (await fetch(`${base}/api/demo/summary`)).json()) as { applications: number };
      expect(summary.applications).toBeGreaterThan(0);
      const res = (await (await fetch(`${base}/api/demo/clear`, { method: 'POST', body: '{}' })).json()) as { deletedApplications: number; deletedChildWorkflows: number; archivedTo: string };
      expect((res as unknown as { failed: unknown[] }).failed).toEqual([]);
      expect(res.deletedApplications).toBe(summary.applications);
      expect(res.deletedChildWorkflows).toBeGreaterThanOrEqual(4); // enrichment, underwriting, disbursement, billing
      // The console hides cleared applications at once...
      const listed = (await (await fetch(`${base}/api/cases`)).json()) as { rows: { applicationId: string }[] };
      expect(listed.rows.map((r) => r.applicationId)).not.toContain(synthetic.workflowId);
      expect(listed.rows.map((r) => r.applicationId)).toContain(sample.workflowId);
      // ...while Temporal deletes closed executions asynchronously (about 30s on the dev server).
      const gone = async (id: string) => {
        for (let i = 0; i < 300; i++) {
          try { await h.client.workflow.getHandle(id).describe(); } catch { return true; }
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      expect(await gone(synthetic.workflowId)).toBe(true);
      expect(await gone(`${synthetic.workflowId}/enrichment`)).toBe(true);
      expect(await gone(`${synthetic.workflowId}/billing`)).toBe(true);
      expect((await h.client.workflow.getHandle(sample.workflowId).describe()).workflowId).toBe(sample.workflowId); // sample kept
      expect(h.audit.forApplication(synthetic.workflowId)).toHaveLength(0);
      expect(h.billing.find(synthetic.workflowId)).toBeUndefined(); // its charge went with it
      expect(h.audit.forApplication(sample.workflowId).length).toBeGreaterThan(0);
      expect(res.archivedTo).toMatch(/archive\/audit-.*\.jsonl$/);
    } finally {
      server.close();
    }
  }, 120_000);
});

describe('billing and SLA risk', () => {
  it('a funded loan is billed exactly once by the billing child workflow', async () => {
    const { workflowId } = await start(h, scenario('happy'));
    const s = await result(h, workflowId);
    expect(s.status).toBe('FUNDED');
    expect(s.children.map((c) => c.stage)).toEqual(['enrichment', 'underwriting', 'disbursement', 'billing']);
    const expected = priceLoan('PERSONAL', s.amount);
    expect(s.billing).toMatchObject({ account: 'Personal Lending', fee: expected.fee, tariffVersion: expected.tariffVersion, chargeId: `chg-${workflowId}` });
    const charges = h.billing.readAll().filter((c) => c.applicationId === workflowId);
    expect(charges).toHaveLength(1);
    expect(h.audit.forApplication(workflowId).find((e) => e.type === 'BILLED')?.actor).toBe(`billing:${expected.tariffVersion}`);
    // A repeated ledger write (as a retried activity would make) returns the charge on file.
    expect(h.billing.record({ ...s.billing!, fee: 999 }).duplicate).toBe(true);
    expect(h.billing.find(workflowId)?.fee).toBe(expected.fee);
  });

  it('declined and escalated applications are not billable', async () => {
    const declined = await result(h, (await start(h, scenario('low-credit'))).workflowId);
    const escalated = await result(h, (await start(h, scenario('payout-reject'))).workflowId);
    expect([declined.status, escalated.status]).toEqual(['DECLINED', 'ESCALATED']);
    expect(h.billing.find(declined.applicationId)).toBeUndefined();
    expect(h.billing.find(escalated.applicationId)).toBeUndefined();
  });

  it('flags an open application as at risk before it breaches the SLA', async () => {
    const { workflowId, handle } = await start(h, scenario('esign'), { ...TEST_TIMING, overallSla: '3s', slaAtRiskAfter: '1s', signatureReminder: '10s' });
    await waitForStatus(h, workflowId, 'AWAITING_SIGNATURE');
    await new Promise((r) => setTimeout(r, 3600));
    const s = await waitForStatus(h, workflowId, 'AWAITING_SIGNATURE');
    expect(s.slaAtRisk).toBe(true);
    expect(s.slaBreached).toBe(true);
    const types = h.audit.forApplication(workflowId).map((e) => e.type);
    expect(types.indexOf('SLA_AT_RISK')).toBeGreaterThan(-1);
    expect(types.indexOf('SLA_AT_RISK')).toBeLessThan(types.indexOf('SLA_BREACHED'));
    await handle.signal(agreementSignedSignal, { envelopeId: s.signature!.envelopeId, signerName: 'x', signedAt: new Date().toISOString() });
    expect((await result(h, workflowId)).status).toBe('FUNDED'); // a warning, never a cancellation
  });
});
