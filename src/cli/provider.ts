/**
 * Demo chaos switch for third-party outages.
 *   npm run provider                      show provider status and circuit breakers
 *   npm run provider -- credit-bureau down
 *   npm run provider -- credit-bureau up  (also nudges parked applications to retry now)
 */
import { PROVIDERS, ProviderStatusStore, readCircuitSnapshot, type ProviderName } from '../activities/providerHealth';
import { retryProvidersNowSignal } from '../workflows/definitions';
import { connectClient, fail, parseArgs, run } from './common';

run(async () => {
  const { positional: [name, state] } = parseArgs();
  const store = new ProviderStatusStore();
  if (name) {
    if (!PROVIDERS.includes(name as ProviderName) || !['up', 'down'].includes(state)) fail(`usage: npm run provider -- <${PROVIDERS.join('|')}> up|down`);
    store.set(name as ProviderName, state === 'down', 'set from CLI');
    console.log(`${name} is now ${state}`);
    if (state === 'up') {
      const client = await connectClient();
      let n = 0;
      for await (const w of client.workflow.list({ query: "ApplicationStatus='AWAITING_PROVIDER' AND ExecutionStatus='Running'" })) {
        await client.workflow.getHandle(w.workflowId).signal(retryProvidersNowSignal, { requestedBy: 'cli' }); n++;
      }
      console.log(`Nudged ${n} parked application(s) to retry now`);
    }
  }
  const status = store.all();
  const circuits = readCircuitSnapshot().circuits;
  for (const p of PROVIDERS) {
    const c = circuits[p];
    console.log(`${p.padEnd(18)} ${status[p].down ? 'DOWN' : 'up  '}   circuit ${c?.state ?? 'CLOSED'}${c?.trips ? ` (tripped ${c.trips}x)` : ''}`);
  }
});
