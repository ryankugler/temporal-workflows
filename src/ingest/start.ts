/**
 * The single start path every channel uses. The workflow ID is the idempotency key, so a re-delivered
 * email, a double-submitted form or a re-sent batch row collapses into the existing application.
 * Temporal enforces it; there is no dedupe table to maintain.
 */
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { applicationMemo, loanWorkflowId, SA, TaskQueues } from '../shared/config';
import type { LoanApplication, Timing } from '../shared/types';
import { loanApplicationWorkflow } from '../workflows/loanApplication';

export interface StartResult { workflowId: string; duplicate: boolean }

export async function startLoanApplication(client: Client, application: LoanApplication, timing?: Partial<Timing>): Promise<StartResult> {
  const workflowId = loanWorkflowId(application.channel, application.externalRef);
  try {
    await client.workflow.start(loanApplicationWorkflow, {
      workflowId,
      taskQueue: TaskQueues.orchestration,
      args: [{ application, timing }],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      memo: applicationMemo(application),
      typedSearchAttributes: [
        { key: SA.status, value: 'RECEIVED' }, { key: SA.product, value: application.productType },
        { key: SA.channel, value: application.channel }, { key: SA.slaBreached, value: false },
      ],
    });
    return { workflowId, duplicate: false };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return { workflowId, duplicate: true };
    throw err;
  }
}
