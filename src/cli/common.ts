import { Client, Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '../shared/env';

export async function connectClient(): Promise<Client> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  return new Client({ connection, namespace: TEMPORAL_NAMESPACE });
}

/** Tiny argv parser: positional args plus --flag value / --flag. */
export function parseArgs(argv = process.argv.slice(2)) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export const run = (main: () => Promise<void>) =>
  main().then(() => process.exit(0), (e) => { console.error(e?.message ?? e); process.exit(1); });
