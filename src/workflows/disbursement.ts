/**
 * Disbursement child workflow (queue: disbursement). Same payout path for every product, owned by the
 * payments side. Non-interactive: it runs only after the agreement is signed (the wait lives in the parent).
 *
 * book loan -> disburse (idempotent on the application ID, heartbeating) -> confirm. Core-banking
 * outages are retried with backoff for up to bankingBudget.
 * A non-retryable payout rejection comes back as a REJECTED result, not an exception, so the parent can
 * record exactly why and escalate.
 */
import { ActivityFailure, ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../activities';
import { TaskQueues } from '../shared/config';
import type { DisbursementInput, DisbursementResult } from '../shared/types';

/**
 * Core-banking downtime is waited out, not escalated: money movement should be late rather than bounced
 * to a person. Retries back off to 30s and stop at bankingBudget; only then does the parent escalate.
 * Safe because every call is idempotent on the application ID.
 */
function bankingProxy(timing: DisbursementInput['timing']) {
  return proxyActivities<Activities>({
    taskQueue: TaskQueues.disbursement,
    startToCloseTimeout: '60s',
    heartbeatTimeout: '20s',
    scheduleToCloseTimeout: timing.bankingBudget,
    retry: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '30s', nonRetryableErrorTypes: ['PayoutRejected'] },
  });
}

export async function disbursementWorkflow(input: DisbursementInput): Promise<DisbursementResult> {
  const banking = bankingProxy(input.timing);
  const { loanNumber } = await banking.bookLoan({ applicationId: input.applicationId, application: input.application });
  try {
    const { payoutRef } = await banking.disburseFunds({ applicationId: input.applicationId, loanNumber, application: input.application });
    await banking.confirmFunding({ applicationId: input.applicationId, payoutRef });
    return { status: 'FUNDED', loanNumber, payoutRef };
  } catch (err) {
    if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure && err.cause.type === 'PayoutRejected') {
      return { status: 'REJECTED', loanNumber, reason: err.cause.message };
    }
    throw err;
  }
}
