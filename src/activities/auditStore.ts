import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AuditEvent } from '../shared/types';

/**
 * Append-only audit log. The demo writes JSON lines to a file; production would be an insert-only
 * Postgres table or S3 with Object Lock. Readers (UI, reports, Sankey) only ever read.
 */
export interface StoredAuditEvent extends AuditEvent {
  /** Wall-clock time the event was persisted (distinct from deterministic workflow time). */
  recordedAt: string;
  /** Dedupe key: activity retries of the same event must not double-write. */
  eventKey: string;
}

export class AuditStore {
  readonly path: string;
  private seen = new Set<string>();
  private cache: { size: number; events: StoredAuditEvent[] } | null = null;

  constructor(path = process.env.AUDIT_LOG ?? resolve(process.cwd(), 'audit/audit.jsonl')) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    for (const e of this.readAll()) this.seen.add(e.eventKey);
  }

  append(event: AuditEvent, eventKey: string): boolean {
    if (this.seen.has(eventKey)) return false;
    const stored: StoredAuditEvent = { ...event, recordedAt: new Date().toISOString(), eventKey };
    appendFileSync(this.path, JSON.stringify(stored) + '\n');
    this.seen.add(eventKey);
    return true;
  }

  /** Reads the whole log, cached by file size. Fine for a demo; production queries the audit table. */
  readAll(): StoredAuditEvent[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf8');
    if (this.cache && this.cache.size === raw.length) return this.cache.events;
    const events = raw
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => { try { return [JSON.parse(line) as StoredAuditEvent]; } catch { return []; } });
    this.cache = { size: raw.length, events };
    return events;
  }

  /**
   * Rotation, used by the demo reset: the current file is archived untouched and a new file starts with
   * only the events `keep` accepts. Nothing is edited in place. Production would partition instead.
   */
  rotate(keep: (e: StoredAuditEvent) => boolean): { archivedTo: string | null; keptEvents: number; removedEvents: number } {
    const all = this.readAll();
    if (!existsSync(this.path)) return { archivedTo: null, keptEvents: 0, removedEvents: 0 };
    const dir = join(dirname(this.path), 'archive');
    mkdirSync(dir, { recursive: true });
    const archivedTo = join(dir, `audit-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    const kept = all.filter(keep);
    renameSync(this.path, archivedTo);
    writeFileSync(this.path, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
    this.cache = null;
    this.seen = new Set(kept.map((e) => e.eventKey));
    return { archivedTo, keptEvents: kept.length, removedEvents: all.length - kept.length };
  }

  forApplication(applicationId: string): StoredAuditEvent[] {
    return this.readAll().filter((e) => e.applicationId === applicationId);
  }
}
