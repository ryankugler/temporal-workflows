/**
 * Billing child workflow (queue: billing). Runs once a loan is FUNDED: prices it with the current tariff
 * and records exactly one charge against the business line that owns the product.
 *
 * Owned by finance, so it has its own queue and can be versioned and deployed alone. Both activities are
 * safe to retry (pricing is pure; the ledger write is idempotent on the application ID), so they retry
 * until they succeed: a funded loan must never go unbilled.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../activities';
import { TaskQueues } from '../shared/config';
import type { BillingCharge, BillingInput } from '../shared/types';

const finance = proxyActivities<Activities>({
  taskQueue: TaskQueues.billing,
  startToCloseTimeout: '10s',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '1m' },
});

export async function billingWorkflow(input: BillingInput): Promise<BillingCharge> {
  const app = input.application;
  const price = await finance.priceFundedLoan({ productType: app.productType, principal: app.amount });
  const charge: BillingCharge = {
    chargeId: `chg-${input.applicationId}`,
    applicationId: input.applicationId,
    account: price.account,
    productType: app.productType,
    channel: app.channel,
    brokerId: app.brokerId,
    principal: app.amount,
    fee: price.fee,
    breakdown: price.breakdown,
    currency: 'USD',
    tariffVersion: price.tariffVersion,
    loanNumber: input.loanNumber,
    payoutRef: input.payoutRef,
    fundedAt: input.fundedAt,
    period: input.fundedAt.slice(0, 7),
  };
  return finance.recordCharge({ charge });
}
