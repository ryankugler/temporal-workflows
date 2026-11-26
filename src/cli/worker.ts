import { NativeConnection } from '@temporalio/worker';
import { AuditStore } from '../activities';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '../shared/env';
import { createWorkers, runWorkers } from '../workers/createWorkers';
import { connectClient } from './common';

async function main() {
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  const client = await connectClient(); // only for the simulated applicant/reviewer
  const audit = new AuditStore();
  const workers = await createWorkers({ connection, namespace: TEMPORAL_NAMESPACE, deps: { audit, client } });
  console.log(`${workers.length} workers polling: ${workers.map((w) => w.options.taskQueue).join(', ')}`);
  console.log(`Audit log: ${audit.path}`);
  const stop = () => workers.forEach((w) => w.shutdown());
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await runWorkers(workers);
}

main().catch((e) => { console.error(e); process.exit(1); });
