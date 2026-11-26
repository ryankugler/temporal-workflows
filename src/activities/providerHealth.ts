/**
 * Provider downtime handling, activity side.
 *
 * Layer 1 (Temporal retry policy): blips of seconds to minutes are retried with backoff inside one
 *   activity call, bounded by scheduleToCloseTimeout.
 * Layer 2 (this file, circuit breaker): when a vendor keeps failing, stop sending it traffic. Calls fail
 *   fast with a non-retryable CircuitOpen instead of thousands of workflows hammering a dead API. After a
 *   cooldown one probe is let through (half-open); success closes the circuit.
 * Layer 3 (parent workflow): the application parks in AWAITING_PROVIDER and re-tries only the failed
 *   checks on a widening schedule, then goes to human review if the outage outlasts its budget.
 *
 * The demo keeps breaker state per worker process and mirrors it to a JSON file for the console. In
 * production it would live in a shared store (Redis) so every worker sees the same circuit.
 *
 * ProviderStatusStore is the demo's chaos switch: the console or CLI marks a vendor "down" globally.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';

export const PROVIDERS = ['credit-bureau', 'identity', 'fraud', 'vehicle-valuation', 'debt-verification', 'core-banking'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderStatus { down: boolean; since?: string; note?: string }
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export interface CircuitSnapshot { state: CircuitState; recentFailures: number; openedAt?: string; reopensAt?: string; trips: number; lastError?: string }

export const dataDir = () => dirname(process.env.AUDIT_LOG ?? join(process.cwd(), 'audit/audit.jsonl'));

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback; } catch { return fallback; }
}

/** Global "is this vendor down" switch shared by the console (writer) and workers (readers). */
export class ProviderStatusStore {
  private cache: { at: number; value: Record<string, ProviderStatus> } | null = null;
  constructor(readonly path = join(dataDir(), 'provider-status.json')) {}

  all(): Record<ProviderName, ProviderStatus> {
    if (this.cache && Date.now() - this.cache.at < 250) return this.cache.value as Record<ProviderName, ProviderStatus>;
    const value = readJson<Record<string, ProviderStatus>>(this.path, {});
    this.cache = { at: Date.now(), value };
    return Object.fromEntries(PROVIDERS.map((p) => [p, value[p] ?? { down: false }])) as Record<ProviderName, ProviderStatus>;
  }

  isDown(p: ProviderName): boolean { return !!this.all()[p]?.down; }

  set(p: ProviderName, down: boolean, note?: string) {
    const value = readJson<Record<string, ProviderStatus>>(this.path, {});
    value[p] = down ? { down, since: new Date().toISOString(), note } : { down: false };
    writeJsonAtomic(this.path, value);
    this.cache = null;
  }
}

export class CircuitBreaker {
  state: CircuitState = 'CLOSED';
  private failures: number[] = [];
  private openedAt = 0;
  private probeInFlight = false;
  trips = 0;
  lastError?: string;

  constructor(
    readonly name: string,
    private readonly opts = { failureThreshold: 5, windowMs: 30_000, cooldownMs: 10_000 },
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws CircuitOpen (non-retryable) when the circuit is open; lets one probe through after cooldown. */
  before(): void {
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt < this.opts.cooldownMs) throw this.openError();
      this.state = 'HALF_OPEN';
      this.probeInFlight = false;
      this.onChange();
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) throw this.openError();
      this.probeInFlight = true;
    }
  }

  success(): void {
    const changed = this.state !== 'CLOSED';
    this.state = 'CLOSED';
    this.failures = [];
    this.probeInFlight = false;
    if (changed) this.onChange();
  }

  failure(error: string): void {
    const now = this.now();
    this.lastError = error;
    this.failures = [...this.failures.filter((t) => now - t < this.opts.windowMs), now];
    if (this.state === 'HALF_OPEN' || (this.state === 'CLOSED' && this.failures.length >= this.opts.failureThreshold)) {
      this.state = 'OPEN';
      this.openedAt = now;
      this.probeInFlight = false;
      this.trips++;
    }
    this.onChange();
  }

  /** A probe that ended in a non-provider error (bad input) neither closes nor reopens the circuit. */
  releaseProbe(): void { this.probeInFlight = false; }

  snapshot(): CircuitSnapshot {
    const now = this.now();
    return {
      state: this.state,
      recentFailures: this.failures.filter((t) => now - t < this.opts.windowMs).length,
      openedAt: this.state === 'CLOSED' ? undefined : new Date(this.openedAt).toISOString(),
      reopensAt: this.state === 'OPEN' ? new Date(this.openedAt + this.opts.cooldownMs).toISOString() : undefined,
      trips: this.trips,
      lastError: this.lastError,
    };
  }

  private openError() {
    const retryInMs = Math.max(0, this.opts.cooldownMs - (this.now() - this.openedAt));
    return ApplicationFailure.create({
      type: 'CircuitOpen',
      message: `${this.name} circuit open: failing fast for ${Math.ceil(retryInMs / 1000)}s instead of calling a provider that keeps failing`,
      nonRetryable: true,
      details: [{ provider: this.name, retryInMs }],
    });
  }
}

/** One breaker per provider, plus the global status switch. Shared by all provider activities. */
export class ProviderHealth {
  readonly breakers: Record<string, CircuitBreaker>;
  readonly status: ProviderStatusStore;
  private readonly snapshotPath: string;

  constructor(opts: { dir?: string; breaker?: ConstructorParameters<typeof CircuitBreaker>[1] } = {}) {
    const dir = opts.dir ?? dataDir();
    this.status = new ProviderStatusStore(join(dir, 'provider-status.json'));
    this.snapshotPath = join(dir, 'circuits.json');
    this.breakers = Object.fromEntries(PROVIDERS.map((p) => [p, new CircuitBreaker(p, opts.breaker, () => this.persist())]));
    this.persist();
  }

  persist() {
    writeJsonAtomic(this.snapshotPath, { updatedAt: new Date().toISOString(), circuits: this.snapshot() });
  }

  snapshot(): Record<string, CircuitSnapshot> {
    return Object.fromEntries(Object.entries(this.breakers).map(([k, b]) => [k, b.snapshot()]));
  }

  /**
   * Wraps one vendor call. A global outage counts toward the breaker; per-application simulated faults
   * inside `call` do not, so one demo scenario can't open the circuit for every other application.
   */
  async guard<T>(provider: ProviderName, call: () => Promise<T>): Promise<T> {
    const breaker = this.breakers[provider];
    breaker.before();
    if (this.status.isDown(provider)) {
      breaker.failure('503 Service Unavailable');
      throw ApplicationFailure.retryable(`${provider} unavailable (503, provider outage)`, 'ProviderUnavailable');
    }
    try {
      const result = await call();
      breaker.success();
      return result;
    } catch (err) {
      breaker.releaseProbe();
      throw err;
    }
  }
}

export function readCircuitSnapshot(dir = dataDir()): { updatedAt?: string; circuits: Record<string, CircuitSnapshot> } {
  return readJson(join(dir, 'circuits.json'), { circuits: {} });
}
