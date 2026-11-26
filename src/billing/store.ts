/**
 * Billing ledger: one charge per funded application. Appends are idempotent on the application ID, so a
 * retried billing activity (or a replayed workflow) can never bill a loan twice.
 *
 * Demo: JSON lines next to the audit log. Production: a billing system or an insert-only table with a
 * unique constraint on application ID.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BillingCharge } from '../shared/types';

export interface StoredCharge extends BillingCharge { recordedAt: string }

export class BillingStore {
  private cache: { size: number; charges: StoredCharge[] } | null = null;

  constructor(readonly path = join(dirname(process.env.AUDIT_LOG ?? join(process.cwd(), 'audit/audit.jsonl')), 'billing.jsonl')) {
    mkdirSync(dirname(path), { recursive: true });
  }

  readAll(): StoredCharge[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf8');
    if (this.cache && this.cache.size === raw.length) return this.cache.charges;
    const charges = raw.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as StoredCharge]; } catch { return []; } });
    this.cache = { size: raw.length, charges };
    return charges;
  }

  find(applicationId: string): StoredCharge | undefined {
    return this.readAll().find((c) => c.applicationId === applicationId);
  }

  /** Records the charge unless this application was already billed; returns the charge on file either way. */
  record(charge: BillingCharge): { charge: StoredCharge; duplicate: boolean } {
    const existing = this.find(charge.applicationId);
    if (existing) return { charge: existing, duplicate: true };
    const stored: StoredCharge = { ...charge, recordedAt: new Date().toISOString() };
    appendFileSync(this.path, JSON.stringify(stored) + '\n');
    this.cache = null;
    return { charge: stored, duplicate: false };
  }

  /** Demo reset: archive the ledger untouched and start a new one with the charges `keep` accepts. */
  rotate(keep: (c: StoredCharge) => boolean): { archivedTo: string | null; keptCharges: number; removedCharges: number } {
    const all = this.readAll();
    if (!existsSync(this.path)) return { archivedTo: null, keptCharges: 0, removedCharges: 0 };
    const dir = join(dirname(this.path), 'archive');
    mkdirSync(dir, { recursive: true });
    const archivedTo = join(dir, `billing-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    const kept = all.filter(keep);
    renameSync(this.path, archivedTo);
    writeFileSync(this.path, kept.map((c) => JSON.stringify(c)).join('\n') + (kept.length ? '\n' : ''));
    this.cache = null;
    return { archivedTo, keptCharges: kept.length, removedCharges: all.length - kept.length };
  }
}
