import { Client, Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '../shared/env';
import { createUiServer } from '../ui/server';

async function main() {
  // Lazy: the console (and its ingest outbox) starts even while Temporal is down, and reconnects on its own.
  const connection = Connection.lazy({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  const port = Number(process.env.PORT ?? 3000);
  createUiServer({ client }).listen(port, () => console.log(`Lending Ops console on http://localhost:${port}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
