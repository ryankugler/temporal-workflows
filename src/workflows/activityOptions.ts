import { proxyActivities, type ActivityOptions } from '@temporalio/workflow';
import type { Activities } from '../activities';
import type { Timing } from '../shared/types';

/** Third-party calls: a total time budget across retries, so an outage ends in a decision, not a stall. */
export function providerProxy(taskQueue: string, timing: Timing) {
  return proxyActivities<Activities>({
    taskQueue,
    startToCloseTimeout: '20s',
    scheduleToCloseTimeout: timing.providerBudget,
    retry: {
      initialInterval: timing.providerRetryInitialInterval,
      backoffCoefficient: 2,
      maximumInterval: '1m',
      nonRetryableErrorTypes: ['SubjectNotFound', 'InvalidInput'],
    },
  });
}

export const shortLocal: ActivityOptions = { startToCloseTimeout: '10s', retry: { maximumAttempts: 3 } };
