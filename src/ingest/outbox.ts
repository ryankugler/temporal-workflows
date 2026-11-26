/**
 * Ingest-side resilience for when Temporal itself (or the network to it) is down.
 *
 * 1. submitApplication retries the start with exponential backoff and jitter on transient gRPC errors
 *    (UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, connection refused). Safe because the workflow
 *    ID is the idempotency key: if an attempt actually landed, the retry just reports "already started".
 * 2. If Temporal is still unreachable, the application goes to a local durable outbox and the caller
 *    gets 202 Accepted with the workflow ID it will have. Nothing a channel sends is dropped.
 * 3. A drainer re-submits outbox entries in order once Temporal is reachable again.
 *
 * Demo: a JSONL file next to the audit log. Production: a transactional outbox table in the ingest
 * service's database (or a durable queue), drained by the same loop.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Client } from '@temporalio/client';
import { dataDir } from '../activities/providerHealth';
import { loanWorkflowId } from '../shared/config';
import type { LoanApplication, Timing } from '../shared/types';
import { startLoanApplication, type StartResult } from './start';

const TRANSIENT_GRPC = new Set([4, 8, 14]); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, UNAVAILABLE

export function isTransientTemporalError(err: unknown): boolean {
  let e = err as { code?: unknown; cause?: unknown; message?: string } | undefined;
  for (let depth = 0; e && depth < 5; depth++) {
    if (typeof e.code === 'number' && TRANSIENT_GRPC.has(e.code)) return true;
    if (typeof e.code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(e.code)) return true;
    if (e.message && /ECONNREFUSED|UNAVAILABLE|Connection refused|failed to connect|transport error|deadline/i.test(e.message)) return true;
    e = e.cause as typeof e;
  }
  return false;
}

export interface RetryOptions { attempts: number; initialMs: number; maxMs: number; sleep?: (ms: number) => Promise<void> }
export const DEFAULT_RETRY: RetryOptions = { attempts: 4, initialMs: 250, maxMs: 2000 };

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = DEFAULT_RETRY): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let delay = opts.initialMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts || !isTransientTemporalError(err)) throw err;
      await sleep(delay / 2 + Math.random() * (delay / 2)); // jitter so recovering callers don't stampede
      delay = Math.min(delay * 2, opts.maxMs);
    }
  }
}

interface OutboxEntry { workflowId: string; application: LoanApplication; timing?: Partial<Timing>; queuedAt: string; attempts: number; lastError?: string }

export class IngestOutbox {
  constructor(readonly path = join(dataDir(), 'ingest-outbox.jsonl')) { mkdirSync(dirname(path), { recursive: true }); }

  list(): OutboxEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }

  enqueue(application: LoanApplication, timing: Partial<Timing> | undefined, error: string): OutboxEntry {
    const entry: OutboxEntry = {
      workflowId: loanWorkflowId(application.channel, application.externalRef), application, timing,
      queuedAt: new Date().toISOString(), attempts: 1, lastError: error,
    };
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
    return entry;
  }

  private rewrite(entries: OutboxEntry[]) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    renameSync(tmp, this.path);
  }

  /** Re-submits queued applications in order; stops at the first transient failure (Temporal still down). */
  async drain(client: Client): Promise<{ submitted: number; remaining: number }> {
    const entries = this.list();
    let submitted = 0;
    while (entries.length) {
      const e = entries[0];
      try {
        await startLoanApplication(client, e.application, e.timing);
        entries.shift();
        submitted++;
      } catch (err) {
        if (!isTransientTemporalError(err)) { entries.shift(); console.error(`outbox: dropping ${e.workflowId}: ${(err as Error).message}`); continue; }
        e.attempts++;
        e.lastError = (err as Error).message;
        break;
      }
    }
    this.rewrite(entries);
    return { submitted, remaining: entries.length };
  }

  /** Background drainer; returns a stop function. */
  startDrainer(client: Client, everyMs = 3000): () => void {
    let busy = false;
    const t = setInterval(async () => {
      if (busy || !this.list().length) return;
      busy = true;
      try {
        const r = await this.drain(client);
        if (r.submitted) console.log(`outbox: re-submitted ${r.submitted}, ${r.remaining} left`);
      } finally { busy = false; }
    }, everyMs);
    t.unref?.();
    return () => clearInterval(t);
  }
}

export type SubmitResult = StartResult & { queued: boolean };

/** The ingest API's entry point: retry, then fall back to the outbox. Never loses an application. */
export async function submitApplication(
  client: Client, application: LoanApplication, timing: Partial<Timing> | undefined, outbox: IngestOutbox, retry: RetryOptions = DEFAULT_RETRY,
): Promise<SubmitResult> {
  try {
    const r = await withRetry(() => startLoanApplication(client, application, timing), retry);
    return { ...r, queued: false };
  } catch (err) {
    if (!isTransientTemporalError(err)) throw err;
    const entry = outbox.enqueue(application, timing, (err as Error).message);
    return { workflowId: entry.workflowId, duplicate: false, queued: true };
  }
}
