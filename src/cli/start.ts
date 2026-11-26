/**
 * One command to run everything locally:
 *   npm start            Temporal dev server + all workers + the ops console, in this one terminal
 *   npm run demo         the same, then loads the Showcase pack so the console has data straight away
 *
 * The first run downloads the Temporal dev server (one time, cached afterwards). Ports can be changed with
 * PORT (console, default 3000), TEMPORAL_PORT (default 7233) and TEMPORAL_UI_PORT (default 8233).
 * Ctrl+C stops everything.
 */
import net from 'node:net';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { AuditStore } from '../activities';
import { ALL_SEARCH_ATTRIBUTES, TaskQueues } from '../shared/config';
import { DEMO_TIMING } from '../shared/types';
import { createUiServer } from '../ui/server';
import { createWorkers } from '../workers/createWorkers';

const consolePort = Number(process.env.PORT ?? 3000);
const temporalPort = Number(process.env.TEMPORAL_PORT ?? 7233);
const temporalUiPort = Number(process.env.TEMPORAL_UI_PORT ?? 8233);
const withDemoData = process.argv.includes('--with-demo-data');

const bindable = (port: number, host?: string) => new Promise<boolean>((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(port, host);
});
/** Free only if it can be bound both on localhost and on all interfaces (the console listens on the latter). */
const free = async (port: number) => (await bindable(port, '127.0.0.1')) && (await bindable(port));

const step = (msg: string) => console.log(`  • ${msg}`);

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) throw new Error(`Node 20 or newer is needed (you have ${process.versions.node}). Install it from https://nodejs.org and try again.`);

  for (const [port, name, env] of [[consolePort, 'the console', 'PORT'], [temporalPort, 'Temporal', 'TEMPORAL_PORT'], [temporalUiPort, 'the Temporal UI', 'TEMPORAL_UI_PORT']] as const) {
    if (!(await free(port))) {
      throw new Error(`Port ${port} (for ${name}) is already in use. Stop whatever is using it (maybe another copy of this app), or pick another port, for example: ${env}=${port + 1} npm start`);
    }
  }

  // Keep the terminal readable: only errors from the Temporal SDK. The scenarios fail activities on purpose
  // (outages, 429s), and those retries show in the console and the Temporal UI rather than as stack traces here.
  Runtime.install({ logger: new DefaultLogger('ERROR') });

  console.log('\nLending Ops: starting everything (Ctrl+C to stop)\n');
  step('Starting the Temporal dev server (the first run downloads it once; this can take a minute)…');
  const env = await TestWorkflowEnvironment.createLocal({
    server: { ip: '127.0.0.1', port: temporalPort, ui: true, uiPort: temporalUiPort, searchAttributes: ALL_SEARCH_ATTRIBUTES, extraArgs: ['--log-level', 'never'] },
  });

  step('Starting the workers…');
  const audit = new AuditStore();
  const workers = await createWorkers({ connection: env.nativeConnection, deps: { audit, client: env.client } });
  const running = Promise.all(workers.map((w) => w.run()));

  step('Starting the ops console…');
  const server = createUiServer({ client: env.client, audit, temporalUiUrl: `http://localhost:${temporalUiPort}` });
  await new Promise<void>((resolve) => server.listen(consolePort, resolve));

  if (withDemoData) {
    step('Loading demo data (the Showcase pack: 20 applications, one per path)…');
    await env.client.workflow.start('synthesizeWorkflow', {
      workflowId: `synth-showcase-${Date.now().toString(36)}`, taskQueue: TaskQueues.orchestration,
      args: [{ count: 0, pack: 'showcase', ratePerSecond: 25, autoResolve: true, seed: Date.now() % 100000, timing: DEMO_TIMING }],
    });
  }

  console.log(`
  Ready.

    Ops console   http://localhost:${consolePort}      ← open this
    Temporal UI   http://localhost:${temporalUiPort}      (the engine underneath, optional)

  Records are written to ${audit.path.replace(process.cwd() + '/', '')}. Data in Temporal lasts until you stop this command.
  Press Ctrl+C to stop.
`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping…');
    server.close();
    workers.forEach((w) => w.shutdown());
    await running.catch(() => {});
    await env.teardown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(`\nCould not start: ${(e as Error).message}\n`);
  process.exit(1);
});
