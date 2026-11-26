/**
 * Branded PDF reports (pdfkit, generated server-side so every operator gets an identical, archivable record).
 *   auditReport: KPIs, outcome summary and the filtered audit trail
 *   caseReport:  one application: facts, decisions, children, lifecycle and its full audit trail
 */
import { existsSync, readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import type { StoredAuditEvent } from '../activities/auditStore';
import { ALL_STATUSES, type StatusView } from '../shared/types';
import { BRAND, STATUS_COLORS } from './brand';
import type { CaseRecord, FlowSummary } from './flow';
import type { StoredCharge } from '../billing/store';

type Doc = PDFKit.PDFDocument;
const C = BRAND.colors;
const M = 40;
const HEADER_H = 56;
const FOOTER_H = 30;

const nice = (s?: string) => String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const money = (n?: number) => (n == null ? '-' : '$' + Math.round(n).toLocaleString('en-US'));
const dt = (iso?: string) => (iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : '-');

/** The logo is plain filled paths, so it is drawn natively as vectors. */
const logoPaths: { d: string; fill: string }[] = (() => {
  if (!existsSync(BRAND.logoPath)) return [];
  const svg = readFileSync(BRAND.logoPath, 'utf8');
  return [...svg.matchAll(/<path\s+d="([^"]+)"\s+fill="([^"]+)"/g)].map((m) => ({ d: m[1], fill: m[2] }));
})();

function drawLogo(doc: Doc, x: number, y: number, height: number) {
  if (!logoPaths.length) {
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.blue).text(BRAND.name, x, y + 2, { lineBreak: false });
    return 110;
  }
  const scale = height / 62; // viewBox 264 x 62
  doc.save().translate(x, y).scale(scale);
  for (const p of logoPaths) doc.path(p.d).fill(p.fill);
  doc.restore();
  return 264 * scale;
}

function newDoc(title: string, layout: 'portrait' | 'landscape'): Doc {
  return new PDFDocument({
    size: 'LETTER', layout, bufferPages: true,
    margins: { top: M + HEADER_H, bottom: M + FOOTER_H, left: M, right: M },
    info: { Title: title, Author: `${BRAND.name} ${BRAND.product}`, Subject: `${title} (${BRAND.tagline})` },
  });
}

const width = (doc: Doc) => doc.page.width - M * 2;

function decorate(doc: Doc, title: string, generatedAt: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const w = doc.page.width;
    const h = doc.page.height;
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow writing in the footer area
    const logoW = drawLogo(doc, M, M - 6, 22);
    doc.font('Helvetica').fontSize(9).fillColor(C.muted)
      .text(`${BRAND.product} · ${BRAND.tagline}`, M + logoW + 10, M + 1, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text(title, M, M - 2, { width: w - M * 2, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(`Generated ${dt(generatedAt)}`, M, M + 13, { width: w - M * 2, align: 'right' });
    doc.moveTo(M, M + 30).lineTo(w - M, M + 30).lineWidth(1.5).strokeColor(C.blue).stroke();
    doc.moveTo(M, h - M - 14).lineTo(w - M, h - M - 14).lineWidth(0.5).strokeColor(C.divider).stroke();
    doc.fontSize(7.5).fillColor(C.muted)
      .text('Confidential: contains applicant data. Case study demo, not a PocketHealth product.', M, h - M - 8, { lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, M, h - M - 8, { width: w - M * 2, align: 'right' });
    doc.page.margins.bottom = bottom;
  }
}

function heading(doc: Doc, text: string) {
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(text, M);
  doc.moveDown(0.3);
}

function kpis(doc: Doc, items: [string, string][]) {
  const gap = 8;
  const w = (width(doc) - gap * (items.length - 1)) / items.length;
  const y = doc.y;
  items.forEach(([label, value], i) => {
    const x = M + i * (w + gap);
    doc.roundedRect(x, y, w, 46, 6).fillAndStroke(C.surface, C.divider);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(label.toUpperCase(), x + 8, y + 8, { width: w - 16, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(C.ink).text(value, x + 8, y + 21, { width: w - 16, lineBreak: false });
  });
  doc.y = y + 56;
  doc.x = M;
}

interface Col<T> { title: string; width: number; get: (row: T) => string; color?: (row: T) => string | undefined }

function table<T>(doc: Doc, cols: Col<T>[], rows: T[]) {
  const total = cols.reduce((a, c) => a + c.width, 0);
  const scale = width(doc) / total;
  const ws = cols.map((c) => c.width * scale);
  const header = () => {
    const y = doc.y;
    doc.rect(M, y, width(doc), 18).fill(C.blueTint);
    let x = M;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink);
    cols.forEach((c, i) => { doc.text(c.title, x + 4, y + 5, { width: ws[i] - 8, lineBreak: false }); x += ws[i]; });
    doc.y = y + 20;
  };
  header();
  doc.font('Helvetica').fontSize(7.5);
  rows.forEach((row, r) => {
    const cells = cols.map((c) => c.get(row));
    const h = Math.max(14, ...cells.map((t, i) => doc.heightOfString(t, { width: ws[i] - 8 }) + 6));
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); header(); doc.font('Helvetica').fontSize(7.5); }
    const y = doc.y;
    if (r % 2) doc.rect(M, y, width(doc), h).fill(C.surface);
    let x = M;
    cols.forEach((c, i) => {
      doc.fillColor(c.color?.(row) ?? C.text).text(cells[i], x + 4, y + 3, { width: ws[i] - 8 });
      x += ws[i];
    });
    doc.y = y + h;
  });
  doc.x = M;
}

function statusBar(doc: Doc, byStatus: FlowSummary['byStatus'], total: number) {
  if (!total) return;
  const y = doc.y;
  let x = M;
  for (const s of ALL_STATUSES) {
    const n = byStatus[s] ?? 0;
    if (!n) continue;
    const w = (n / total) * width(doc);
    doc.rect(x, y, w, 12).fill(STATUS_COLORS[s]);
    x += w;
  }
  doc.y = y + 18;
  let lx = M;
  doc.fontSize(7.5);
  for (const s of ALL_STATUSES) {
    const n = byStatus[s] ?? 0;
    if (!n) continue;
    const label = `${nice(s)} ${n}`;
    const lw = doc.widthOfString(label) + 18;
    if (lx + lw > M + width(doc)) { lx = M; doc.y += 12; }
    doc.rect(lx, doc.y + 1, 7, 7).fill(STATUS_COLORS[s]);
    doc.fillColor(C.text).text(label, lx + 10, doc.y, { lineBreak: false });
    lx += lw;
  }
  doc.y += 16;
  doc.x = M;
}

function finish(doc: Doc, title: string): Promise<Buffer> {
  decorate(doc, title, new Date().toISOString());
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  return new Promise((resolve) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.end(); });
}

export function auditReport(opts: { flow: FlowSummary; cases: CaseRecord[]; events: StoredAuditEvent[]; filterLabel: string }): Promise<Buffer> {
  const { flow, events } = opts;
  const title = 'Audit report';
  const doc = newDoc(title, 'landscape');
  doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(`Filters: ${opts.filterLabel}`, M);
  doc.moveDown(0.5);
  kpis(doc, [
    ['Applications', String(flow.total)],
    ['In flight', String(flow.inFlight)],
    ['Funded', String(flow.terminal.FUNDED)],
    ['Declined', String(flow.terminal.DECLINED)],
    ['Escalated', String(flow.terminal.ESCALATED)],
    ['Funding rate', flow.fundingRate == null ? '-' : `${Math.round(flow.fundingRate * 100)}%`],
    ['Funded volume', money(flow.fundedVolume)],
    ['SLA breaches', String(flow.slaBreached)],
  ]);
  heading(doc, 'Current state distribution');
  statusBar(doc, flow.byStatus, flow.total);
  const median = flow.medianSecondsToClose == null ? '-' : flow.medianSecondsToClose < 120 ? `${flow.medianSecondsToClose}s` : `${Math.round(flow.medianSecondsToClose / 60)}m`;
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
    .text(`Manually reviewed: ${flow.manuallyReviewed}   ·   Median time to a terminal state: ${median}   ·   Waiting on a reviewer now: ${flow.needsReview}`, M);
  heading(doc, 'Outcomes by reason');
  table(doc, [
    { title: 'Outcome', width: 1, get: (o) => nice(o.status), color: (o) => STATUS_COLORS[o.status] },
    { title: 'Reason code', width: 3, get: (o) => o.reason },
    { title: 'Applications', width: 1, get: (o) => String(o.count) },
  ], flow.outcomes.slice(0, 12));
  const cases = [...opts.cases].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  heading(doc, `Cases (${cases.length}${cases.length > 600 ? ', newest 600 shown' : ''})`);
  table(doc, [
    { title: 'Applicant / case', width: 2.6, get: (c) => `${c.applicantName || '(unparsed)'}\n${c.applicationId}` },
    { title: 'Product', width: 1.2, get: (c) => nice(c.productType) },
    { title: 'Channel', width: 1, get: (c) => nice(c.channel) },
    { title: 'Amount', width: 0.9, get: (c) => money(c.amount) },
    { title: 'State', width: 1.2, get: (c) => nice(c.status) + (c.slaBreached ? ' (SLA)' : ''), color: (c) => STATUS_COLORS[c.status] },
    { title: 'Latest reason', width: 3, get: (c) => c.lastReason ?? '' },
    { title: 'Reviewers', width: 1.4, get: (c) => c.reviewers.join(', ') },
    { title: 'Received', width: 1.3, get: (c) => dt(c.receivedAt) },
    { title: 'Events', width: 0.8, get: (c) => String(c.eventCount) },
  ], cases.slice(0, 600));
  doc.addPage();
  heading(doc, `Audit trail (${events.length} events${events.length > 1500 ? ', first 1500 shown' : ''})`);
  table(doc, [
    { title: 'Time (workflow)', width: 1.3, get: (e) => dt(e.at) },
    { title: 'Application', width: 2.2, get: (e) => e.applicationId },
    { title: 'Event', width: 1.9, get: (e) => e.type },
    { title: 'Transition', width: 1.8, get: (e) => (e.to ? `${nice(e.from ?? '')} > ${nice(e.to)}` : ''), color: (e) => (e.to ? STATUS_COLORS[e.to] : undefined) },
    { title: 'Actor', width: 1.6, get: (e) => e.actor },
    { title: 'Reason', width: 3.2, get: (e) => e.reason ?? '' },
  ], events.slice(0, 1500));
  return finish(doc, title);
}

export function caseReport(opts: { status?: StatusView; record?: CaseRecord; events: StoredAuditEvent[] }): Promise<Buffer> {
  const { status: s, record: r, events } = opts;
  const id = s?.applicationId ?? r?.applicationId ?? events[0]?.applicationId ?? 'unknown';
  const title = 'Application audit record';
  const doc = newDoc(title, 'portrait');
  const current = s?.status ?? r?.status ?? 'RECEIVED';
  doc.font('Helvetica-Bold').fontSize(16).fillColor(C.ink).text(s?.applicantName ?? r?.applicantName ?? id, M);
  doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(id, M);
  doc.moveDown(0.4);
  const y = doc.y;
  doc.roundedRect(M, y, 110, 20, 10).fill(STATUS_COLORS[current]);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white).text(nice(current), M, y + 6, { width: 110, align: 'center' });
  doc.y = y + 28;
  doc.x = M;

  const facts: [string, string][] = [
    ['Product', nice(s?.productType ?? r?.productType)],
    ['Channel', nice(s?.channel ?? r?.channel)],
    ['Amount', money(s?.amount ?? r?.amount)],
    ['Received', dt(r?.receivedAt ?? s?.history[0]?.at)],
    ['SLA', s ? `${dt(s.slaDeadline)}${s.slaBreached ? ' (breached)' : ''}` : r?.slaBreached ? 'Breached' : '-'],
    ['Outcome reason', s?.reasons.join('; ') || r?.lastReason || '-'],
  ];
  table(doc, [{ title: 'Field', width: 1, get: (f) => f[0] }, { title: 'Value', width: 4, get: (f) => f[1] }], facts);

  if (s?.underwriting) {
    heading(doc, 'Underwriting decision');
    const u = s.underwriting;
    table(doc, [{ title: 'Field', width: 1, get: (f) => f[0] }, { title: 'Value', width: 4, get: (f) => f[1] }], [
      ['Outcome', u.outcome], ['Policy version', u.policyVersion], ['Reasons', u.reasons.join('; ')],
      ['Metrics', Object.entries(u.metrics).map(([k, v]) => `${k}=${v}`).join(', ')],
    ]);
  }
  if (s?.approvals.length) {
    heading(doc, 'Reviewer approvals');
    table(doc, [{ title: 'Reviewer', width: 1, get: (a) => a.reviewerId }, { title: 'Reason', width: 4, get: (a) => a.reason }], s.approvals);
  }
  if (s?.children.length) {
    heading(doc, 'Child workflows');
    table(doc, [
      { title: 'Stage', width: 1, get: (c) => c.stage }, { title: 'Workflow type', width: 2, get: (c) => c.workflowType },
      { title: 'Task queue', width: 2, get: (c) => c.taskQueue }, { title: 'Workflow ID', width: 3, get: (c) => c.workflowId },
    ], s.children);
  }
  heading(doc, 'Audit trail');
  table(doc, [
    { title: 'Time (workflow)', width: 1.5, get: (e) => dt(e.at) },
    { title: 'Event', width: 2.1, get: (e) => e.type },
    { title: 'Transition', width: 2, get: (e) => (e.to ? `${nice(e.from ?? '')} > ${nice(e.to)}` : ''), color: (e) => (e.to ? STATUS_COLORS[e.to] : undefined) },
    { title: 'Actor', width: 1.8, get: (e) => e.actor },
    { title: 'Reason / details', width: 3.2, get: (e) => [e.reason, e.details && !e.to ? JSON.stringify(e.details).slice(0, 160) : ''].filter(Boolean).join('  ') },
  ], events);
  doc.moveDown(0.6).font('Helvetica').fontSize(7.5).fillColor(C.muted)
    .text(`Run IDs: ${[...new Set(events.map((e) => e.runId))].join(', ')}. Source: append-only audit log; Temporal event history holds the step-level record.`, M);
  return finish(doc, title);
}

/** Invoice for one billing account and period: one line per funded loan, priced by the recorded tariff. */
export function invoiceReport(opts: { account: string; period: string; charges: StoredCharge[] }): Promise<Buffer> {
  const { account, period, charges } = opts;
  const title = `Invoice · ${account} · ${period}`;
  const doc = newDoc(title, 'portrait');
  const total = Math.round(charges.reduce((s, c) => s + c.fee, 0) * 100) / 100;
  doc.font('Helvetica-Bold').fontSize(16).fillColor(C.ink).text(`${account}`, M);
  doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(`Billing period ${period} · ${charges.length} funded loan${charges.length === 1 ? '' : 's'} · tariff ${[...new Set(charges.map((c) => c.tariffVersion))].join(', ') || '-'}`, M);
  doc.moveDown(0.6);
  kpis(doc, [
    ['Funded loans', String(charges.length)],
    ['Principal', money(charges.reduce((s, c) => s + c.principal, 0))],
    ['Amount due', `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
  ]);
  heading(doc, 'Charges');
  table(doc, [
    { title: 'Funded (UTC)', width: 1.4, get: (c) => dt(c.fundedAt) },
    { title: 'Application', width: 2.6, get: (c) => `${c.applicationId}\n${c.loanNumber}` },
    { title: 'Channel', width: 1, get: (c) => nice(c.channel) },
    { title: 'Principal', width: 1, get: (c) => money(c.principal) },
    { title: 'Fee basis', width: 1.6, get: (c) => `$${c.breakdown.flat} + ${c.breakdown.bps} bps${c.breakdown.minApplied ? ' (min)' : c.breakdown.capApplied ? ' (cap)' : ''}` },
    { title: 'Fee', width: 0.9, get: (c) => `$${c.fee.toFixed(2)}` },
  ], charges);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text(`Total due: $${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`, M, doc.y, { width: width(doc), align: 'right' });
  doc.moveDown(0.4).font('Helvetica').fontSize(7.5).fillColor(C.muted)
    .text('Illustrative tariff for the case study. One charge per funded application, keyed on the application ID; declined and escalated applications are not billable.', M);
  return finish(doc, title);
}
