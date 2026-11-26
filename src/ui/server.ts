/**
 * Ops UI: a small JSON API over the Temporal client and the audit log, plus static files (no build step).
 *   Flow / KPIs / audit views  <- audit log (the path history; Visibility only knows current state)
 *   Case list / review queue   <- Visibility (search attributes + memo), no per-workflow queries
 *   Case detail                <- getStatus query + audit events
 *   Actions                    <- the same update/signals the CLI and webhooks use
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WorkflowExecutionAlreadyStartedError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import { AuditStore } from '../activities/auditStore';
import { fromBrokerEmail, fromPortal } from '../ingest/adapters';
import { sampleBrokerEmail, samplePortalSubmission } from '../ingest/samples';
import { buildScenario, MIXES, PACKS, SCENARIOS, timingFor } from '../ingest/scenarios';
import { IngestOutbox, isTransientTemporalError, submitApplication, withRetry } from '../ingest/outbox';
import { PROVIDERS, ProviderStatusStore, readCircuitSnapshot, type ProviderName } from '../activities/providerHealth';
import { SA, TaskQueues } from '../shared/config';
import { TEMPORAL_UI_URL, TEMPORAL_NAMESPACE } from '../shared/env';
import { DEMO_TIMING, type ApplicationStatus, type Channel, type ClaimRequest, type DocumentType, type ProductType, type ReviewDecision } from '../shared/types';
import { agreementSignedSignal, claimReviewUpdate, documentsUploadedSignal, getStatusQuery, retryProvidersNowSignal, submitReviewDecisionUpdate, withdrawSignal } from '../workflows/definitions';
import { BRAND, STATUS_COLORS } from '../reports/brand';
import { buildCases, buildFlow, casesToCsv, eventsToCsv, filterCases, filterEvents, type CaseFilter, type EventFilter } from '../reports/flow';
import { auditReport, caseReport, invoiceReport } from '../reports/pdf';
import { BillingStore } from '../billing/store';
import { TARIFF, TARIFF_VERSION } from '../billing/tariff';
import { billingSummary, chargesToCsv, filterCharges, type BillingFilter } from '../reports/billing';
import { buildSlaBoard } from '../reports/sla';
import { msToNumber } from '@temporalio/common/lib/time';

const PUBLIC = path.join(__dirname, 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function caseFilter(q: URLSearchParams): CaseFilter {
  const range = q.get('range');
  const from = q.get('from') || (range && range !== 'all' ? new Date(Date.now() - Number(range) * 60_000).toISOString() : undefined);
  return {
    product: (q.get('product') || undefined) as ProductType | undefined,
    channel: (q.get('channel') || undefined) as Channel | undefined,
    from, to: q.get('to') || undefined, q: q.get('q') || undefined,
    status: (q.get('status') || undefined) as CaseFilter['status'],
  };
}

function eventFilter(q: URLSearchParams): EventFilter {
  return { ...caseFilter(q), type: q.get('type') || undefined, actor: q.get('actor') || undefined, state: (q.get('state') || undefined) as ApplicationStatus | undefined };
}

const filterLabel = (q: URLSearchParams) =>
  [...q.entries()].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || 'none (all applications)';

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const stamp = () => Date.now().toString(36);
/** A client-supplied request ID makes a POST safe to retry: the same ID always maps to the same effect. */
const requestRef = (body: Record<string, unknown>) => {
  const r = typeof body.requestId === 'string' ? body.requestId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  return r || stamp();
};
const CHILD_TYPES = ['enrichmentWorkflow', 'personalLoanUnderwriting', 'autoLoanUnderwriting', 'debtConsolidationUnderwriting', 'disbursementWorkflow', 'billingWorkflow'];

export function createUiServer(opts: { client: Client; audit?: AuditStore; outbox?: IngestOutbox; providerStatus?: ProviderStatusStore; billing?: BillingStore; temporalUiUrl?: string }) {
  const temporalUiUrl = opts.temporalUiUrl ?? TEMPORAL_UI_URL;
  const { client } = opts;
  const audit = opts.audit ?? new AuditStore();
  const billing = opts.billing ?? new BillingStore();
  const billingFilter = (q: URLSearchParams): BillingFilter => ({
    account: q.get('account') || undefined, product: q.get('product') || undefined, channel: q.get('channel') || undefined,
    period: q.get('period') || undefined, from: q.get('from') || undefined, to: q.get('to') || undefined,
  });
  const outbox = opts.outbox ?? new IngestOutbox();
  const providerStatus = opts.providerStatus ?? new ProviderStatusStore();
  outbox.startDrainer(client);

  async function temporalReachable(): Promise<{ ok: boolean; error?: string }> {
    try {
      await Promise.race([
        client.workflowService.getSystemInfo({}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 2s')), 2000)),
      ]);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  // Temporal deletes closed executions asynchronously (about 30 seconds on the dev server), so cleared IDs
  // are hidden from Visibility-backed lists until they are really gone.
  const cleared = new Map<string, number>();
  const isCleared = (workflowId: string) => {
    const at = cleared.get(workflowId.split('/')[0]);
    if (at === undefined) return false;
    if (Date.now() - at > 5 * 60_000) { cleared.delete(workflowId.split('/')[0]); return false; }
    return true;
  };

  async function listIds(query: string) {
    const ids: string[] = [];
    for await (const w of client.workflow.list({ query })) if (!isCleared(w.workflowId)) ids.push(w.workflowId);
    return ids;
  }

  /** Synthesized = started by a scenario, a pack or the synthesizer (they all carry a scenario in the memo). */
  async function listSynthesized() {
    const out: { id: string; running: boolean }[] = [];
    for await (const w of client.workflow.list({ query: "WorkflowType='loanApplicationWorkflow'" })) {
      if ((w.memo as { scenario?: string | null } | undefined)?.scenario && !isCleared(w.workflowId)) out.push({ id: w.workflowId, running: w.status.name === 'RUNNING' });
    }
    return out;
  }

  /**
   * Demo reset: delete synthesized applications (parents, their child workflows, and the synthesizer runs)
   * from Temporal, then rotate the audit log. The log is never edited in place: the full file is archived
   * and a new one starts with every event that isn't synthesized. Portal, email and batch samples stay.
   */
  async function clearSynthesized() {
    const apps = await listSynthesized();
    const parents = new Set(apps.map((a) => a.id));
    const children = (await listIds(CHILD_TYPES.map((t) => `WorkflowType='${t}'`).join(' OR '))).filter((id) => parents.has(id.split('/')[0]));
    const drivers = await listIds("WorkflowType='synthesizeWorkflow'");
    const failed: { workflowId: string; error: string }[] = [];
    const del = async (workflowId: string) => {
      await client.workflowService.deleteWorkflowExecution({ namespace: client.options.namespace, workflowExecution: { workflowId } })
        .catch((e: Error) => { if (!/not found/i.test(e.message)) failed.push({ workflowId, error: e.message }); });
    };
    const run = async (ids: string[]) => { for (let i = 0; i < ids.length; i += 25) await Promise.all(ids.slice(i, i + 25).map(del)); };
    const now = Date.now();
    [...parents, ...drivers].forEach((id) => cleared.set(id, now));
    await run([...parents]); // deleting a running parent also ends its running children
    await run(children);
    await run(drivers);
    await new Promise((r) => setTimeout(r, 1000)); // let in-flight audit writes from deleted runs land before rotating
    const rotated = audit.rotate((e) => !parents.has(e.applicationId));
    const billingRotated = billing.rotate((c) => !parents.has(c.applicationId));
    return { removedCharges: billingRotated.removedCharges, deletedApplications: parents.size - failed.filter((f) => parents.has(f.workflowId)).length, deletedChildWorkflows: children.length, deletedSynthesizerRuns: drivers.length, failed: failed.slice(0, 20), ...rotated };
  }

  async function signalParked(requestedBy: string) {
    let n = 0;
    for await (const w of client.workflow.list({ query: "WorkflowType='loanApplicationWorkflow' AND ApplicationStatus='AWAITING_PROVIDER' AND ExecutionStatus='Running'" })) {
      await client.workflow.getHandle(w.workflowId).signal(retryProvidersNowSignal, { requestedBy }).then(() => n++, () => {});
    }
    return n;
  }
  const temporalLink = (id: string) => `${temporalUiUrl}/namespaces/${TEMPORAL_NAMESPACE}/workflows/${encodeURIComponent(id)}`;

  async function listCases(query: string, limit = 1000) {
    const rows = [];
    for await (const w of client.workflow.list({ query })) {
      if (isCleared(w.workflowId)) continue;
      const sa = w.typedSearchAttributes;
      const memo = (w.memo ?? {}) as { applicantName?: string; amount?: number; scenario?: string };
      rows.push({
        applicationId: w.workflowId,
        status: sa.get(SA.status) ?? 'RECEIVED',
        productType: sa.get(SA.product),
        channel: sa.get(SA.channel),
        slaBreached: !!sa.get(SA.slaBreached),
        applicantName: memo.applicantName ?? '',
        amount: memo.amount ?? 0,
        scenario: memo.scenario ?? null,
        startTime: w.startTime.toISOString(),
        closeTime: w.closeTime?.toISOString() ?? null,
        executionStatus: w.status.name,
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  const routes: [string, RegExp, (m: RegExpMatchArray, q: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>][] = [
    ['GET', /^\/api\/config$/, async () => ({
      brand: BRAND.name, product: BRAND.product, tagline: BRAND.tagline, temporalUiUrl, namespace: TEMPORAL_NAMESPACE,
      statusColors: STATUS_COLORS,
      scenarios: Object.values(SCENARIOS).map((s) => ({ name: s.name, title: s.title, expected: s.expected, needsHuman: !!s.needsHuman })),
      packs: Object.entries(PACKS).map(([name, p]) => ({ name, title: p.title, description: p.description, size: p.items.length })),
      timing: { claimLease: DEMO_TIMING.claimLease, claimReminderBefore: DEMO_TIMING.claimReminderBefore, reviewTimeout: DEMO_TIMING.reviewTimeout },
      mixes: Object.keys(MIXES),
    })],

    ['GET', /^\/api\/health$/, async () => {
      const [temporal, parked] = await Promise.all([
        temporalReachable(),
        client.workflow.count("WorkflowType='loanApplicationWorkflow' AND ApplicationStatus='AWAITING_PROVIDER' AND ExecutionStatus='Running'").then((c) => c.count, () => null),
      ]);
      const circuits = readCircuitSnapshot().circuits;
      const status = providerStatus.all();
      return {
        temporal,
        outbox: { depth: outbox.list().length, oldest: outbox.list()[0]?.queuedAt ?? null },
        parked,
        providers: PROVIDERS.map((p) => ({ name: p, ...status[p], circuit: circuits[p] ?? { state: 'CLOSED', recentFailures: 0, trips: 0 } })),
      };
    }],

    ['POST', /^\/api\/providers\/([a-z-]+)$/, async (m, _q, req) => {
      const name = m[1] as ProviderName;
      if (!PROVIDERS.includes(name)) throw new HttpError(404, `Unknown provider ${name}`);
      const { down } = (await readBody(req)) as { down?: boolean };
      providerStatus.set(name, !!down, 'set from ops console');
      // When a provider comes back, nudge parked applications instead of waiting for their next retry.
      const nudged = !down ? await signalParked('ops-console') : 0;
      return { name, down: !!down, nudged };
    }],

    ['POST', /^\/api\/providers-retry$/, async () => ({ nudged: await signalParked('ops-console') })],

    ['GET', /^\/api\/flow$/, async (_m, q) => {
      const cases = filterCases(buildCases(audit.readAll()), caseFilter(q));
      return buildFlow(cases);
    }],

    ['GET', /^\/api\/cases$/, async (_m, q) => {
      const clauses = ["WorkflowType='loanApplicationWorkflow'"];
      const status = q.get('status');
      if (status === 'OPEN') clauses.push("ExecutionStatus='Running'");
      else if (status === 'SLA') clauses.push('SlaBreached=true');
      else if (status) clauses.push(`ApplicationStatus='${status.replace(/[^A-Z_]/g, '')}'`);
      if (q.get('product')) clauses.push(`ProductType='${q.get('product')!.replace(/[^A-Z_]/g, '')}'`);
      if (q.get('channel')) clauses.push(`Channel='${q.get('channel')!.replace(/[^A-Z_]/g, '')}'`);
      let rows = await listCases(clauses.join(' AND '));
      const text = q.get('q')?.toLowerCase();
      if (text) rows = rows.filter((r) => [r.applicationId, r.applicantName, r.scenario].some((s) => s?.toLowerCase().includes(text)));
      return { query: clauses.join(' AND '), rows };
    }],

    ['GET', /^\/api\/review-queue$/, async () => {
      const rows = await listCases("WorkflowType='loanApplicationWorkflow' AND ApplicationStatus='HUMAN_REVIEW' AND ExecutionStatus='Running'", 300);
      const cases = new Map(buildCases(audit.readAll()).map((c) => [c.applicationId, c]));
      const events = audit.readAll();
      const claims = new Map(await Promise.all(rows.map(async (r) => [r.applicationId,
        await client.workflow.getHandle(r.applicationId).query(getStatusQuery).then((st) => st.claim ?? null, () => null)] as const)));
      return rows
        .map((r) => {
          const c = cases.get(r.applicationId);
          const enteredReview = [...events].reverse().find((e) => e.applicationId === r.applicationId && e.type === 'TRANSITION' && e.to === 'HUMAN_REVIEW');
          const approvals = events.filter((e) => e.applicationId === r.applicationId && e.type === 'REVIEW_DECISION' && enteredReview && e.at >= enteredReview.at && (e.details as { decision?: string })?.decision === 'APPROVE');
          return { ...r, reason: enteredReview?.reason ?? c?.lastReason, since: enteredReview?.at, approvalsRequired: c?.approvalsRequired ?? 1, approvals: approvals.map((a) => a.actor.replace('reviewer:', '')), claim: claims.get(r.applicationId) ?? null };
        })
        .sort((a, b) => String(a.since).localeCompare(String(b.since)));
    }],

    ['GET', /^\/api\/cases\/([^/]+)$/, async (m) => {
      const id = decodeURIComponent(m[1]);
      const handle = client.workflow.getHandle(id);
      const [status, desc] = await Promise.all([handle.query(getStatusQuery).catch(() => null), handle.describe().catch(() => null)]);
      if (!status && !desc) throw new HttpError(404, `No application ${id}`);
      return {
        status, events: audit.forApplication(id), temporalUrl: temporalLink(id),
        executionStatus: desc?.status.name, childLinks: Object.fromEntries((status?.children ?? []).map((c) => [c.workflowId, temporalLink(c.workflowId)])),
      };
    }],

    // Decisions carry the client's request ID as the Temporal update ID. The server deduplicates updates by
    // ID, so a retry after a dropped connection or an expired session returns the first result instead of
    // recording the decision twice.
    ['POST', /^\/api\/cases\/([^/]+)\/review$/, async (m, _q, req) => {
      const body = await readBody(req);
      const { requestId: _r, ...decision } = body as unknown as ReviewDecision & { requestId?: string };
      try {
        return await client.workflow.getHandle(decodeURIComponent(m[1])).executeUpdate(submitReviewDecisionUpdate, {
          args: [decision as ReviewDecision], updateId: `decision-${requestRef(body)}`,
        });
      } catch (e) {
        if (e instanceof WorkflowUpdateFailedError) throw new HttpError(409, (e.cause as Error)?.message ?? e.message);
        throw e;
      }
    }],

    ['POST', /^\/api\/cases\/([^/]+)\/claim$/, async (m, _q, req) => {
      const body = await readBody(req);
      const { reviewerId, action } = body as unknown as ClaimRequest;
      try {
        return { claim: await client.workflow.getHandle(decodeURIComponent(m[1])).executeUpdate(claimReviewUpdate, {
          args: [{ reviewerId, action }], updateId: `claim-${requestRef(body)}`,
        }) };
      } catch (e) {
        if (e instanceof WorkflowUpdateFailedError) throw new HttpError(409, (e.cause as Error)?.message ?? e.message);
        throw e;
      }
    }],

    ['POST', /^\/api\/cases\/([^/]+)\/docs$/, async (m, _q, req) => {
      const { documents } = (await readBody(req)) as { documents: DocumentType[] };
      await client.workflow.getHandle(decodeURIComponent(m[1])).signal(documentsUploadedSignal, { documents, uploadedBy: 'ops-console' });
      return { ok: true };
    }],

    ['POST', /^\/api\/cases\/([^/]+)\/sign$/, async (m) => {
      const handle = client.workflow.getHandle(decodeURIComponent(m[1]));
      const s = await handle.query(getStatusQuery);
      if (!s.signature) throw new HttpError(409, 'No agreement has been sent yet');
      await handle.signal(agreementSignedSignal, { envelopeId: s.signature.envelopeId, signerName: s.applicantName, signedAt: new Date().toISOString() });
      return { ok: true };
    }],

    ['POST', /^\/api\/cases\/([^/]+)\/retry-providers$/, async (m) => {
      await client.workflow.getHandle(decodeURIComponent(m[1])).signal(retryProvidersNowSignal, { requestedBy: 'ops-console' });
      return { ok: true };
    }],

    ['POST', /^\/api\/cases\/([^/]+)\/withdraw$/, async (m, _q, req) => {
      const { reason } = (await readBody(req)) as { reason?: string };
      await client.workflow.getHandle(decodeURIComponent(m[1])).signal(withdrawSignal, { reason: reason || 'Withdrawn by applicant', requestedBy: 'ops-console' });
      return { ok: true };
    }],

    ['GET', /^\/api\/cases\/([^/]+)\/report\.pdf$/, async (m, _q, _req, res) => {
      const id = decodeURIComponent(m[1]);
      const status = await client.workflow.getHandle(id).query(getStatusQuery).catch(() => undefined);
      const record = buildCases(audit.forApplication(id))[0];
      const pdf = await caseReport({ status, record, events: audit.forApplication(id) });
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${id}.pdf"` });
      res.end(pdf);
      return undefined;
    }],

    // The request ID becomes the application's external reference, so retrying the same click lands on the
    // same workflow ID and is absorbed as a duplicate instead of starting a second application.
    ['POST', /^\/api\/scenarios\/([a-z0-9-]+)$/, async (m, _q, req) => {
      const body = await readBody(req);
      const name = m[1];
      const ref = requestRef(body);
      const app = name === 'portal' ? fromPortal(samplePortalSubmission(`web-${ref}`))
        : name === 'email' ? fromBrokerEmail(sampleBrokerEmail(`<${ref}@northbrokers.example>`))
        : buildScenario(name, { ref: `${name}-${ref}`, autoResolve: !!body.auto });
      app.scenario ??= name; // everything started from the console counts as synthesized demo data
      return submitApplication(client, app, timingFor(name, DEMO_TIMING), outbox);
    }],

    ['POST', /^\/api\/packs\/([a-z0-9-]+)$/, async (m) => {
      const pack = PACKS[m[1]];
      if (!pack) throw new HttpError(404, `Unknown pack ${m[1]}`);
      const workflowId = `synth-${m[1]}-${stamp()}`;
      await withRetry(() => client.workflow.start('synthesizeWorkflow', {
        workflowId, taskQueue: TaskQueues.orchestration,
        args: [{ count: pack.items.length, pack: m[1], ratePerSecond: 25, autoResolve: true, seed: Date.now() % 100000, timing: DEMO_TIMING }],
      }));
      return { workflowId, count: pack.items.length, title: pack.title, temporalUrl: temporalLink(workflowId) };
    }],

    // Synthesize many: a random mix (count, mix, rate) or a named scenario pack. The request ID is the
    // synthesizer's workflow ID, so a retried click can't start a second batch.
    ['POST', /^\/api\/synthesize$/, async (_m, _q, req) => {
      const b = (await readBody(req)) as { count?: number; mix?: string; rate?: number; autoResolve?: boolean; pack?: string; requestId?: string };
      const pack = b.pack ? PACKS[b.pack] : undefined;
      if (b.pack && !pack) throw new HttpError(404, `Unknown pack ${b.pack}`);
      const count = pack ? pack.items.length : Math.min(2000, Math.max(1, Number(b.count ?? 100)));
      const workflowId = `synth-${requestRef(b as Record<string, unknown>)}`;
      try {
        await withRetry(() => client.workflow.start('synthesizeWorkflow', {
          workflowId, taskQueue: TaskQueues.orchestration,
          args: [{ count, mix: b.mix ?? 'realistic', pack: b.pack, ratePerSecond: pack ? 25 : Number(b.rate ?? 10), autoResolve: b.autoResolve ?? true, seed: Date.now() % 100000, timing: DEMO_TIMING }],
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
        }));
      } catch (e) {
        if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
      }
      return { workflowId, count, title: pack?.title ?? `${count} applications`, temporalUrl: temporalLink(workflowId) };
    }],

    // ---- billing -----------------------------------------------------------
    ['GET', /^\/api\/billing$/, async (_m, q) => {
      const f = billingFilter(q);
      const charges = filterCharges(billing.readAll(), f).sort((a, b) => b.fundedAt.localeCompare(a.fundedAt));
      const cases = filterCases(buildCases(audit.readAll()), { product: f.product as ProductType | undefined, channel: f.channel as Channel | undefined });
      return {
        ...billingSummary(charges, cases),
        tariff: { version: TARIFF_VERSION, lines: TARIFF },
        periods: [...new Set(billing.readAll().map((c) => c.period))].sort().reverse(),
        charges: charges.slice(0, 500),
      };
    }],

    ['GET', /^\/api\/billing\.csv$/, async (_m, q, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="charges-${new Date().toISOString().slice(0, 10)}.csv"` });
      res.end(chargesToCsv(filterCharges(billing.readAll(), billingFilter(q))));
      return undefined;
    }],

    ['GET', /^\/api\/billing\/invoice\.pdf$/, async (_m, q, _req, res) => {
      const account = q.get('account');
      const period = q.get('period') || new Date().toISOString().slice(0, 7);
      if (!account) throw new HttpError(400, 'account is required');
      const charges = filterCharges(billing.readAll(), { account, period }).sort((a, b) => a.fundedAt.localeCompare(b.fundedAt));
      const pdf = await invoiceReport({ account, period, charges });
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="invoice-${account.replace(/\W+/g, '-')}-${period}.pdf"` });
      res.end(pdf);
      return undefined;
    }],

    // ---- SLA risk board -------------------------------------------------
    ['GET', /^\/api\/sla-board$/, async (_m, q) => {
      const cases = filterCases(buildCases(audit.readAll()), caseFilter(q));
      const board = buildSlaBoard(cases, Date.now(), {
        overallSlaMs: msToNumber(DEMO_TIMING.overallSla), atRiskAfterMs: msToNumber(DEMO_TIMING.slaAtRiskAfter), staleAfterMs: msToNumber(DEMO_TIMING.staleAfter),
      });
      // Claims matter for review items: who already holds it, so reviewers don't collide.
      const reviewIds = [...board.breached, ...board.atRisk, ...board.stale].filter((i) => i.status === 'HUMAN_REVIEW').slice(0, 150).map((i) => i.applicationId);
      const claims = Object.fromEntries(await Promise.all(reviewIds.map(async (id) => [id,
        await client.workflow.getHandle(id).query(getStatusQuery).then((s) => s.claim ?? null, () => null)] as const)));
      return { ...board, claims, timing: { overallSla: DEMO_TIMING.overallSla, slaAtRiskAfter: DEMO_TIMING.slaAtRiskAfter, staleAfter: DEMO_TIMING.staleAfter } };
    }],

    // ---- demo data -------------------------------------------------------
    ['GET', /^\/api\/demo\/summary$/, async () => {
      const apps = await listSynthesized();
      return { applications: apps.length, running: apps.filter((a) => a.running).length, drivers: (await listIds("WorkflowType='synthesizeWorkflow'")).length };
    }],

    ['POST', /^\/api\/demo\/clear$/, async () => clearSynthesized()],

    ['GET', /^\/api\/synthesize\/([^/]+)$/, async (m) =>
      client.workflow.getHandle(decodeURIComponent(m[1])).query('progress')],

    ['GET', /^\/api\/audit$/, async (_m, q) => {
      const events = filterEvents(audit.readAll(), eventFilter(q));
      const limit = Math.min(5000, Number(q.get('limit') ?? 500));
      return { total: events.length, events: events.slice(-limit).reverse(), types: [...new Set(audit.readAll().map((e) => e.type))].sort() };
    }],

    // Case-level audit dashboard: one row per application. The state bar ignores the state filter so its
    // legend stays clickable as a filter.
    ['GET', /^\/api\/audit\/cases$/, async (_m, q) => {
      const all = buildCases(audit.readAll());
      const f = caseFilter(q);
      const summary = buildFlow(filterCases(all, { ...f, status: undefined }));
      const cases = filterCases(all, f).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      const { nodes: _n, links: _l, ...rest } = summary;
      return { summary: rest, total: cases.length, cases: cases.slice(0, 1000) };
    }],

    ['GET', /^\/api\/audit\/cases\.csv$/, async (_m, q, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cases-${new Date().toISOString().slice(0, 10)}.csv"` });
      res.end(casesToCsv(filterCases(buildCases(audit.readAll()), caseFilter(q))));
      return undefined;
    }],

    ['GET', /^\/api\/audit\.csv$/, async (_m, q, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"` });
      res.end(eventsToCsv(filterEvents(audit.readAll(), eventFilter(q))));
      return undefined;
    }],

    ['GET', /^\/api\/audit\.pdf$/, async (_m, q, _req, res) => {
      const all = audit.readAll();
      const cases = filterCases(buildCases(all), caseFilter(q));
      const ids = new Set(cases.map((c) => c.applicationId));
      const events = filterEvents(all, eventFilter(q)).filter((e) => ids.has(e.applicationId));
      const pdf = await auditReport({ flow: buildFlow(cases), cases, events, filterLabel: filterLabel(q) });
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="audit-report.pdf"` });
      res.end(pdf);
      return undefined;
    }],
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) {
          const out = await handler(m, url.searchParams, req, res);
          if (out !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
          return;
        }
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      createReadStream(file).pipe(res);
    } catch (e) {
      // Temporal unreachable is a temporary condition: tell the caller when to retry instead of a bare 500.
      const transient = !(e instanceof HttpError) && isTransientTemporalError(e);
      const status = e instanceof HttpError ? e.status : transient ? 503 : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', ...(transient ? { 'retry-after': '3' } : {}) });
      res.end(JSON.stringify({ error: transient ? `Temporal is unreachable, retry shortly (${(e as Error).message})` : (e as Error).message, retryable: transient }));
    }
  });
}
