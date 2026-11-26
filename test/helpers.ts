import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, type Worker } from '@temporalio/worker';

try { Runtime.install({ logger: new DefaultLogger('WARN') }); } catch { /* already installed */ }
import { AuditStore, BillingStore, ProviderHealth } from '../src/activities';
import { buildScenario, seededRng } from '../src/ingest/scenarios';
import { startLoanApplication } from '../src/ingest/start';
import { ALL_SEARCH_ATTRIBUTES } from '../src/shared/config';
import type { ApplicationStatus, LoanApplication, StatusView, Timing } from '../src/shared/types';
import { createWorkers } from '../src/workers/createWorkers';
import { getStatusQuery } from '../src/workflows/definitions';

/** Seconds-scale timers so every timeout path runs in a test. */
export const TEST_TIMING: Timing = {
  overallSla: '20s',
  docsReminder: '1s',
  docsTimeout: '1500ms',
  reviewTimeout: '3s',
  providerBudget: '8s',
  providerRetryInitialInterval: '100ms',
  signatureReminder: '1s',
  signatureTimeout: '1500ms',
  providerParkInitial: '500ms',
  providerParkMax: '1s',
  providerOutageBudget: '3s',
  bankingBudget: '30s',
  claimLease: '20s',
  claimReminderBefore: '5s',
  slaAtRiskAfter: '15s',
  staleAfter: '5s',
};

export interface Harness {
  env: TestWorkflowEnvironment;
  client: Client;
  audit: AuditStore;
  health: ProviderHealth;
  billing: BillingStore;
  workers: Worker[];
  running: Promise<unknown>;
  teardown(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const env = await TestWorkflowEnvironment.createLocal({ server: { searchAttributes: ALL_SEARCH_ATTRIBUTES } });
  const dir = mkdtempSync(path.join(tmpdir(), 'loan-audit-'));
  const audit = new AuditStore(path.join(dir, 'audit.jsonl'));
  const health = new ProviderHealth({ dir, breaker: { failureThreshold: 3, windowMs: 10_000, cooldownMs: 1_000 } });
  const billing = new BillingStore(path.join(dir, 'billing.jsonl'));
  const workers = await createWorkers({ connection: env.nativeConnection, deps: { audit, client: env.client, health, billing } });
  const running = Promise.all(workers.map((w) => w.run()));
  return {
    env, client: env.client, audit, health, billing, workers, running,
    async teardown() {
      workers.forEach((w) => w.shutdown());
      await running.catch(() => {});
      await env.teardown();
    },
  };
}

let seq = 0;
export function scenario(name: string, mutate?: (a: LoanApplication) => void): LoanApplication {
  const app = buildScenario(name, { ref: `${name}-${Date.now().toString(36)}-${++seq}`, rng: seededRng(1000 + seq), product: 'PERSONAL', channel: 'PORTAL' });
  mutate?.(app);
  return app;
}

export async function start(h: Harness, app: LoanApplication, timing: Partial<Timing> = TEST_TIMING) {
  const res = await startLoanApplication(h.client, app, timing);
  return { ...res, handle: h.client.workflow.getHandle(res.workflowId) };
}

export async function result(h: Harness, workflowId: string): Promise<StatusView> {
  return h.client.workflow.getHandle(workflowId).result();
}

export async function waitForStatus(h: Harness, workflowId: string, status: ApplicationStatus, timeoutMs = 15_000): Promise<StatusView> {
  const handle = h.client.workflow.getHandle(workflowId);
  const deadline = Date.now() + timeoutMs;
  let last: StatusView | undefined;
  while (Date.now() < deadline) {
    try {
      last = await handle.query(getStatusQuery);
      if (last.status === status) return last;
    } catch { /* not started yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${status}; last status ${last?.status}`);
}

export const path_ = (s: StatusView) => s.history.map((h) => h.to);
