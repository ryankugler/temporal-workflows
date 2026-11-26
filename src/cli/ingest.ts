/**
 * Start demo applications.
 *   npm run ingest                          list scenarios
 *   npm run ingest -- happy                 one application from a scenario profile
 *   npm run ingest -- fraud --auto          ...with the simulated reviewer answering
 *   npm run ingest -- portal | email        through the real channel adapters
 *   npm run ingest -- duplicate             the same broker email delivered twice -> one workflow
 *   npm run ingest -- batch [file.csv]      aggregator file through batchIngestWorkflow
 *   npm run ingest -- showcase              scenario pack: ~20 scenarios, one per path, started together
 */
import path from 'node:path';
import { fromBrokerEmail, fromPortal } from '../ingest/adapters';
import { sampleBrokerEmail, samplePortalSubmission } from '../ingest/samples';
import { buildScenario, PACKS, SCENARIOS, timingFor } from '../ingest/scenarios';
import { IngestOutbox, submitApplication } from '../ingest/outbox';
import { startLoanApplication } from '../ingest/start';
import { TaskQueues } from '../shared/config';
import { DEMO_TIMING } from '../shared/types';
import { connectClient, parseArgs, run } from './common';

const stamp = () => Date.now().toString(36);

run(async () => {
  const { positional, flags } = parseArgs();
  const name = positional[0];
  if (!name) {
    console.log('Scenarios:');
    for (const s of Object.values(SCENARIOS)) console.log(`  ${s.name.padEnd(20)} ${s.title}: ${s.expected}`);
    console.log('  portal / email       through the channel adapters\n  duplicate            same email twice\n  batch [file]         aggregator CSV');
    console.log('Packs:');
    for (const [k, p] of Object.entries(PACKS)) console.log(`  ${k.padEnd(20)} ${p.title}`);
    return;
  }
  const client = await connectClient();

  if (name === 'batch') {
    const filePath = path.resolve(positional[1] ?? 'samples/aggregator-feed.csv');
    const handle = await client.workflow.start('batchIngestWorkflow', {
      workflowId: `batch-${path.basename(filePath)}-${stamp()}`, taskQueue: TaskQueues.orchestration,
      args: [{ filePath, timing: DEMO_TIMING }],
    });
    console.log(`Batch ${handle.workflowId} started; waiting for the file to be fanned out...`);
    console.log(JSON.stringify(await handle.result(), null, 2));
    return;
  }

  if (PACKS[name]) {
    const handle = await client.workflow.start('synthesizeWorkflow', {
      workflowId: `synth-${name}-${stamp()}`, taskQueue: TaskQueues.orchestration,
      args: [{ count: PACKS[name].items.length, pack: name, ratePerSecond: 25, autoResolve: true, seed: Date.now() % 100000, timing: DEMO_TIMING }],
    });
    const r = await handle.result();
    console.log(`${PACKS[name].title}: started ${r.workflowIds.length}, duplicates absorbed ${r.duplicatesAbsorbed}`);
    PACKS[name].items.forEach((item, i) => console.log(`  ${String(i + 1).padStart(2)}. ${item.scenario.padEnd(20)} ${item.note ?? ''}`));
    console.log('Watch them: http://localhost:3000/#/flow   (npm run status)');
    return;
  }

  if (name === 'duplicate') {
    const email = fromBrokerEmail(sampleBrokerEmail(`<dup-${stamp()}@northbrokers.example>`));
    email.documents.push('PAYSTUB');
    const first = await startLoanApplication(client, email, DEMO_TIMING);
    const second = await startLoanApplication(client, email, DEMO_TIMING);
    console.log(`first delivery:  ${first.workflowId} (duplicate=${first.duplicate})`);
    console.log(`second delivery: ${second.workflowId} (duplicate=${second.duplicate}) -> collapsed into the same application`);
    return;
  }

  const app =
    name === 'portal' ? fromPortal(samplePortalSubmission(`web-${stamp()}`))
    : name === 'email' ? fromBrokerEmail(sampleBrokerEmail(`<${stamp()}@northbrokers.example>`))
    : buildScenario(name, { ref: `${name}-${stamp()}`, autoResolve: !!flags.auto });
  const res = await submitApplication(client, app, timingFor(name, DEMO_TIMING), new IngestOutbox());
  console.log(`${res.queued ? 'Temporal unreachable; queued in the ingest outbox as' : res.duplicate ? 'Duplicate of' : 'Started'} ${res.workflowId}`);
  if (SCENARIOS[name]) console.log(`Expect: ${SCENARIOS[name].expected}`);
  console.log(`Status: npm run status -- ${res.workflowId}`);
});
