/**
 *   npm run synthesize -- --count 200 --mix realistic --rate 10 [--manual]
 * Mixes: realistic | stress | happy. Auto-resolve is on unless --manual.
 */
import { TaskQueues } from '../shared/config';
import { DEMO_TIMING } from '../shared/types';
import { MIXES } from '../ingest/scenarios';
import { connectClient, fail, parseArgs, run } from './common';

run(async () => {
  const { flags } = parseArgs();
  const count = Number(flags.count ?? 100);
  const mix = String(flags.mix ?? 'realistic');
  if (!MIXES[mix]) fail(`Unknown mix "${mix}". Known: ${Object.keys(MIXES).join(', ')}`);
  const client = await connectClient();
  const runTag = Date.now().toString(36);
  const handle = await client.workflow.start('synthesizeWorkflow', {
    workflowId: `synth-${runTag}`,
    taskQueue: TaskQueues.orchestration,
    args: [{ count, mix, ratePerSecond: Number(flags.rate ?? 10), autoResolve: !flags.manual, seed: Number(flags.seed ?? Date.now() % 100000), timing: DEMO_TIMING }],
  });
  console.log(`Synthesizer ${handle.workflowId}: starting ${count} applications (${mix} mix)...`);
  const result = await handle.result();
  console.log(JSON.stringify(result, null, 2));
  console.log('Watch them flow: http://localhost:3000/#/flow');
});
