/**
 * Aggregator batch: one workflow per file. Reads pages through an activity and starts each valid row as
 * its own loan workflow (ParentClosePolicy.ABANDON: the row outlives the file job). Bad rows are rejected
 * individually; re-delivered rows collapse onto the existing workflow via the idempotent ID.
 * continueAsNew every few pages keeps history bounded for very large files.
 */
import * as wf from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { Activities } from '../activities';
import { applicationMemo, loanWorkflowId, SA, TaskQueues } from '../shared/config';
import type { Timing } from '../shared/types';
import { shortLocal } from './activityOptions';
import { loanApplicationWorkflow } from './loanApplication';

const { readBatchPage } = wf.proxyActivities<Activities>({ taskQueue: TaskQueues.orchestration, ...shortLocal });

export interface BatchInput {
  filePath: string;
  pageSize?: number;
  offset?: number;
  timing?: Partial<Timing>;
  totals?: BatchTotals;
}

export interface BatchTotals { started: number; duplicates: number; rejected: { rowRef: string; error: string }[] }

const PAGES_PER_RUN = 10;

export async function batchIngestWorkflow(input: BatchInput): Promise<BatchTotals> {
  const pageSize = input.pageSize ?? 25;
  const totals: BatchTotals = input.totals ?? { started: 0, duplicates: 0, rejected: [] };
  let offset: number | null = input.offset ?? 0;

  for (let page = 0; offset !== null && page < PAGES_PER_RUN; page++) {
    const res: Awaited<ReturnType<typeof readBatchPage>> = await readBatchPage({ filePath: input.filePath, offset, pageSize });
    await Promise.all(res.rows.map(async (row) => {
      if (!row.application) { totals.rejected.push({ rowRef: row.rowRef, error: row.error ?? 'unparseable' }); return; }
      const app = row.application;
      try {
        await wf.startChild(loanApplicationWorkflow, {
          workflowId: loanWorkflowId(app.channel, app.externalRef),
          taskQueue: TaskQueues.orchestration,
          args: [{ application: app, timing: input.timing }],
          parentClosePolicy: 'ABANDON',
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          memo: applicationMemo(app),
          typedSearchAttributes: [
            { key: SA.status, value: 'RECEIVED' }, { key: SA.product, value: app.productType },
            { key: SA.channel, value: app.channel }, { key: SA.slaBreached, value: false },
          ],
        });
        totals.started++;
      } catch (err) {
        if (err instanceof WorkflowExecutionAlreadyStartedError) totals.duplicates++;
        else throw err;
      }
    }));
    offset = res.nextOffset;
  }

  if (offset !== null) {
    await wf.continueAsNew<typeof batchIngestWorkflow>({ ...input, offset, totals });
  }
  return totals;
}
