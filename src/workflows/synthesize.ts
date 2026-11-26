/**
 * Scenario synthesizer: starts N applications drawn from a weighted mix of scenario profiles, at a bounded
 * rate. Every application is an independent parent workflow running in parallel; this workflow only
 * starts them (ParentClosePolicy.ABANDON) and never waits for their outcomes.
 *
 * With autoResolve, the simulated applicant and reviewer answer docs requests, reviews and signatures,
 * so the run drains to terminal states on its own and the flow view fills in.
 */
import * as wf from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { buildScenario, MIXES, PACKS, pickWeighted, seededRng, timingFor, type PackItem } from '../ingest/scenarios';
import { applicationMemo, loanWorkflowId, SA, TaskQueues } from '../shared/config';
import type { Timing } from '../shared/types';
import { loanApplicationWorkflow } from './loanApplication';

export interface SynthesizeInput {
  count: number;
  mix?: string;
  /** A named scenario pack: start exactly its items, in order, instead of a weighted random mix. */
  pack?: string;
  ratePerSecond?: number;
  autoResolve?: boolean;
  seed?: number;
  timing?: Partial<Timing>;
  /** Internal: continueAsNew bookkeeping. */
  startIndex?: number;
  started?: Record<string, number>;
  duplicatesAbsorbed?: number;
}

export interface SynthesizeProgress {
  runTag: string; total: number; startedSoFar: number; byScenario: Record<string, number>;
  duplicatesAbsorbed: number; workflowIds: string[];
}

export const synthesizeProgressQuery = wf.defineQuery<SynthesizeProgress>('progress');

const PER_RUN = 250;

export async function synthesizeWorkflow(input: SynthesizeInput): Promise<SynthesizeProgress> {
  const runTag = wf.workflowInfo().workflowId.replace(/^synth-/, '');
  const mix = MIXES[input.mix ?? 'realistic'] ?? MIXES.realistic;
  const rate = Math.max(1, input.ratePerSecond ?? 10);
  const started = input.started ?? {};
  const startIndex = input.startIndex ?? 0;
  const packItems: PackItem[] | undefined = input.pack ? PACKS[input.pack]?.items : undefined;
  if (input.pack && !packItems) throw wf.ApplicationFailure.nonRetryable(`Unknown pack ${input.pack}`);
  const total = packItems ? packItems.length : input.count;
  let duplicatesAbsorbed = input.duplicatesAbsorbed ?? 0;
  const workflowIds: string[] = [];
  // Seed with the start index so continueAsNew segments don't repeat the same applicants.
  const rng = seededRng((input.seed ?? 42) + startIndex * 7919);
  let i = startIndex;
  const count = () => Object.values(started).reduce((a, b) => a + b, 0);
  const progress = (): SynthesizeProgress => ({ runTag, total, startedSoFar: count() + duplicatesAbsorbed, byScenario: started, duplicatesAbsorbed, workflowIds });
  wf.setHandler(synthesizeProgressQuery, progress);

  const end = Math.min(total, startIndex + PER_RUN);
  while (i < end) {
    const batch = Math.min(rate, end - i);
    await Promise.all(Array.from({ length: batch }, async (_, k) => {
      const n = i + k;
      const item: PackItem = packItems?.[n] ?? { scenario: pickWeighted(rng, mix) };
      const scenario = item.scenario;
      // A duplicate re-delivers an earlier item's exact submission; the idempotent ID absorbs it.
      const ref = item.duplicateOf !== undefined ? `syn-${runTag}-${String(item.duplicateOf + 1).padStart(4, '0')}` : `syn-${runTag}-${String(n + 1).padStart(4, '0')}`;
      const app = buildScenario(scenario, {
        ref, rng: item.duplicateOf !== undefined ? seededRng((input.seed ?? 42) + item.duplicateOf) : rng,
        autoResolve: item.autoResolve ?? input.autoResolve ?? true, product: item.product, channel: item.channel ?? (packItems ? packItems[item.duplicateOf ?? n]?.channel : undefined),
      });
      try {
        await wf.startChild(loanApplicationWorkflow, {
          workflowId: loanWorkflowId(app.channel, app.externalRef),
          taskQueue: TaskQueues.orchestration,
          args: [{ application: app, timing: timingFor(scenario, input.timing) }],
          parentClosePolicy: 'ABANDON',
          memo: applicationMemo(app),
          typedSearchAttributes: [
            { key: SA.status, value: 'RECEIVED' }, { key: SA.product, value: app.productType },
            { key: SA.channel, value: app.channel }, { key: SA.slaBreached, value: false },
          ],
        });
        started[scenario] = (started[scenario] ?? 0) + 1;
        workflowIds.push(loanWorkflowId(app.channel, app.externalRef));
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
        duplicatesAbsorbed++;
      }
    }));
    i += batch;
    if (i < end) await wf.sleep(1000);
  }

  if (end < total) {
    await wf.continueAsNew<typeof synthesizeWorkflow>({ ...input, startIndex: end, started, duplicatesAbsorbed });
  }
  return progress();
}
