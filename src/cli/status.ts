/**
 *   npm run status                         applications grouped by state (Visibility)
 *   npm run status -- --query "ApplicationStatus='HUMAN_REVIEW'"
 *   npm run status -- <workflowId>         full status view (query)
 */
import { SA } from '../shared/config';
import { getStatusQuery } from '../workflows/definitions';
import { connectClient, parseArgs, run } from './common';

run(async () => {
  const { positional: [workflowId], flags } = parseArgs();
  const client = await connectClient();

  if (workflowId) {
    const s = await client.workflow.getHandle(workflowId).query(getStatusQuery);
    console.log(`${s.applicationId}  ${s.productType}  $${s.amount.toLocaleString()}  ${s.applicantName}`);
    console.log(`status: ${s.status}${s.pendingAction ? `  (waiting: ${s.pendingAction})` : ''}${s.slaBreached ? '  SLA BREACHED' : ''}`);
    if (s.reasons.length) console.log(`reasons: ${s.reasons.join('; ')}`);
    if (s.underwriting) console.log(`underwriting: ${s.underwriting.outcome} under ${s.underwriting.policyVersion} ${JSON.stringify(s.underwriting.metrics)}`);
    if (s.approvalsRequired) console.log(`approvals: ${s.approvals.map((a) => a.reviewerId).join(', ') || 'none'} (${s.approvals.length}/${s.approvalsRequired})`);
    console.log('children:');
    for (const c of s.children) console.log(`  ${c.stage.padEnd(13)} ${c.workflowType.padEnd(30)} ${c.taskQueue.padEnd(28)} ${c.workflowId}`);
    console.log('history:');
    for (const h of s.history) console.log(`  ${h.at.slice(11, 19)}  ${h.from.padEnd(18)} -> ${h.to.padEnd(18)} ${h.actor}${h.reason ? `  ${h.reason}` : ''}`);
    return;
  }

  const query = String(flags.query ?? "WorkflowType='loanApplicationWorkflow'");
  const rows: string[][] = [];
  for await (const w of client.workflow.list({ query })) {
    const sa = w.typedSearchAttributes;
    rows.push([
      String(sa.get(SA.status) ?? '?'), String(sa.get(SA.product) ?? ''), String(sa.get(SA.channel) ?? ''),
      sa.get(SA.slaBreached) ? 'SLA!' : '', w.workflowId, String((w.memo as { applicantName?: string })?.applicantName ?? ''),
    ]);
    if (rows.length >= 500) break;
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r[0]]: (m[r[0]] ?? 0) + 1 }), {});
  console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('   '));
  for (const r of rows) console.log(`${r[0].padEnd(19)} ${r[1].padEnd(19)} ${r[2].padEnd(13)} ${r[3].padEnd(5)} ${r[4].padEnd(52)} ${r[5]}`);
});
