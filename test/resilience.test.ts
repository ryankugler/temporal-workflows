import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { CircuitBreaker } from '../src/activities/providerHealth';
import { IngestOutbox, isTransientTemporalError, submitApplication, withRetry } from '../src/ingest/outbox';
import { buildScenario, seededRng } from '../src/ingest/scenarios';

describe('circuit breaker', () => {
  it('opens after the threshold, fails fast, lets one probe through after cooldown, and closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker('credit-bureau', { failureThreshold: 3, windowMs: 1000, cooldownMs: 500 }, () => {}, () => now);
    b.before(); b.failure('503'); b.before(); b.failure('503');
    expect(b.state).toBe('CLOSED');
    b.before(); b.failure('503');
    expect(b.state).toBe('OPEN');
    expect(() => b.before()).toThrow(/circuit open/);
    now = 600;
    b.before(); // the probe
    expect(b.state).toBe('HALF_OPEN');
    expect(() => b.before()).toThrow(/circuit open/); // only one probe at a time
    b.success();
    expect(b.state).toBe('CLOSED');
    expect(b.snapshot().trips).toBe(1);
  });

  it('a failed probe reopens the circuit; old failures age out of the window', () => {
    let now = 0;
    const b = new CircuitBreaker('identity', { failureThreshold: 2, windowMs: 100, cooldownMs: 50 }, () => {}, () => now);
    b.failure('x'); now = 200; b.failure('x');
    expect(b.state).toBe('CLOSED'); // the first failure aged out
    b.failure('x');
    expect(b.state).toBe('OPEN');
    now = 300; b.before(); b.failure('still down');
    expect(b.state).toBe('OPEN');
    expect(b.snapshot().trips).toBe(2);
  });
});

describe('ingest when Temporal is down', () => {
  const unavailable = Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
  const app = () => buildScenario('happy', { ref: `ob-${Math.random().toString(36).slice(2)}`, rng: seededRng(3) });

  it('classifies transient gRPC failures', () => {
    expect(isTransientTemporalError(unavailable)).toBe(true);
    expect(isTransientTemporalError(new Error('wrapped', { cause: unavailable }))).toBe(true);
    expect(isTransientTemporalError(new Error('invalid argument'))).toBe(false);
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(async () => { if (++calls < 3) throw unavailable; return 'ok'; }, { attempts: 4, initialMs: 1, maxMs: 2, sleep: async () => {} });
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('queues the application in the outbox when Temporal stays down, and drains it when it is back', async () => {
    const outbox = new IngestOutbox(path.join(mkdtempSync(path.join(tmpdir(), 'outbox-')), 'outbox.jsonl'));
    let up = false;
    const started: string[] = [];
    const client = { workflow: { start: async (_wf: unknown, o: { workflowId: string }) => { if (!up) throw unavailable; started.push(o.workflowId); return {}; } } } as unknown as Client;
    const a = app();
    const r = await submitApplication(client, a, undefined, outbox, { attempts: 2, initialMs: 1, maxMs: 1, sleep: async () => {} });
    expect(r.queued).toBe(true);
    expect(r.workflowId).toBe(`loan-${a.channel.toLowerCase().replace('_', '-')}-${a.externalRef}`);
    expect(outbox.list()).toHaveLength(1);
    expect(await outbox.drain(client)).toEqual({ submitted: 0, remaining: 1 }); // still down: kept
    up = true;
    expect(await outbox.drain(client)).toEqual({ submitted: 1, remaining: 0 });
    expect(started).toEqual([r.workflowId]);
    expect(outbox.list()).toHaveLength(0);
  });

  it('does not queue on a non-transient error', async () => {
    const outbox = new IngestOutbox(path.join(mkdtempSync(path.join(tmpdir(), 'outbox-')), 'outbox.jsonl'));
    const client = { workflow: { start: async () => { throw new Error('bad request'); } } } as unknown as Client;
    await expect(submitApplication(client, app(), undefined, outbox)).rejects.toThrow('bad request');
    expect(outbox.list()).toHaveLength(0);
  });
});
