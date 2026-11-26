/**
 * Worker topology. One worker per task queue; in production each line is its own deployment, scaled and
 * versioned independently. Here they share one process and one workflow bundle for convenience.
 *
 *   loan-orchestration         parent, batch and synthesizer workflows + validation, audit, notify, e-sign
 *   enrichment                 enrichmentWorkflow (activities run on the provider queues)
 *   underwriting-<product> x3  that product's underwriting workflow + evaluateRules
 *   disbursement               disbursementWorkflow + core-banking activities
 *   billing                    billingWorkflow + pricing and the billing ledger
 *   provider-<vendor> x5       one vendor's activities, rate limited to its quota
 */
import { NativeConnection, Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import path from 'node:path';
import { createActivities, type ActivityDeps } from '../activities';
import { PROVIDER_RATE_LIMITS, TaskQueues } from '../shared/config';
import { PRODUCT_TYPES } from '../shared/types';

let bundlePromise: Promise<WorkflowBundleWithSourceMap> | undefined;
export function workflowBundle() {
  bundlePromise ??= bundleWorkflowCode({ workflowsPath: path.join(__dirname, '../workflows/index.ts'), logger: quietLogger });
  return bundlePromise;
}

const quietLogger = { trace() {}, debug() {}, info() {}, warn: console.warn, error: console.error, log() {} } as never;

export async function createWorkers(opts: { connection: NativeConnection; namespace?: string; deps: ActivityDeps }) {
  const { connection, namespace = 'default' } = opts;
  const acts = createActivities(opts.deps);
  const bundle = await workflowBundle();
  const pick = <K extends keyof typeof acts>(...keys: K[]) => Object.fromEntries(keys.map((k) => [k, acts[k]])) as Pick<typeof acts, K>;

  const specs: Parameters<typeof Worker.create>[0][] = [
    {
      taskQueue: TaskQueues.orchestration, workflowBundle: bundle,
      activities: pick('validateApplication', 'recordAuditEvent', 'notify', 'sendEnvelope', 'screenSanctions', 'readBatchPage'),
    },
    { taskQueue: TaskQueues.enrichment, workflowBundle: bundle },
    ...PRODUCT_TYPES.map((p) => ({ taskQueue: TaskQueues.underwriting(p), workflowBundle: bundle, activities: pick('evaluateRules') })),
    { taskQueue: TaskQueues.disbursement, workflowBundle: bundle, activities: pick('bookLoan', 'disburseFunds', 'confirmFunding') },
    { taskQueue: TaskQueues.billing, workflowBundle: bundle, activities: pick('priceFundedLoan', 'recordCharge') },
    { taskQueue: TaskQueues.creditBureau, activities: pick('fetchCreditReport') },
    { taskQueue: TaskQueues.identity, activities: pick('verifyIdentity') },
    { taskQueue: TaskQueues.fraud, activities: pick('checkFraud') },
    { taskQueue: TaskQueues.vehicleValuation, activities: pick('valueVehicle') },
    { taskQueue: TaskQueues.debtVerification, activities: pick('verifyDebts') },
  ];

  return Promise.all(specs.map((s) => Worker.create({
    connection,
    namespace,
    ...s,
    // Server-side, cluster-wide throttle: scaling out workers can never exceed the vendor's quota.
    maxTaskQueueActivitiesPerSecond: PROVIDER_RATE_LIMITS[s.taskQueue],
  })));
}

/** Run all workers until the signal aborts (or one fails). */
export async function runWorkers(workers: Worker[]) {
  await Promise.all(workers.map((w) => w.run()));
}
