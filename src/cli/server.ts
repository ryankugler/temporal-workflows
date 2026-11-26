/**
 * Local Temporal dev server with the custom search attributes registered, for machines without the
 * Temporal CLI. Equivalent to:
 *   temporal server start-dev --search-attribute ApplicationStatus=Keyword --search-attribute ProductType=Keyword \
 *     --search-attribute Channel=Keyword --search-attribute SlaBreached=Bool
 */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { ALL_SEARCH_ATTRIBUTES } from '../shared/config';

async function main() {
  const env = await TestWorkflowEnvironment.createLocal({
    server: { ip: '127.0.0.1', port: 7233, ui: true, uiPort: 8233, searchAttributes: ALL_SEARCH_ATTRIBUTES },
  });
  console.log('Temporal dev server on localhost:7233, Temporal UI at http://localhost:8233 (Ctrl+C to stop)');
  const stop = async () => { await env.teardown(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => { console.error(e); process.exit(1); });
