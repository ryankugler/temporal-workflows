import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';
import type { LoanApplication, ProductType } from './types';

/**
 * Task queue topology. A queue is the unit of deployment, scaling and rate limiting:
 *  - one queue for parent workflows, one per child stage, one per product
 *  - one per third-party provider, so each can be throttled to its vendor's quota
 */
export const TaskQueues = {
  orchestration: 'loan-orchestration',
  enrichment: 'enrichment',
  underwriting: (p: ProductType) => `underwriting-${p.toLowerCase().replace('_', '-')}`,
  disbursement: 'disbursement',
  billing: 'billing',
  creditBureau: 'provider-credit-bureau',
  identity: 'provider-identity',
  fraud: 'provider-fraud',
  vehicleValuation: 'provider-vehicle-valuation',
  debtVerification: 'provider-debt-verification',
} as const;

/** Vendor quotas, enforced server-side across all workers on each provider queue. */
export const PROVIDER_RATE_LIMITS: Record<string, number> = {
  [TaskQueues.creditBureau]: 20,
  [TaskQueues.identity]: 25,
  [TaskQueues.fraud]: 40,
  [TaskQueues.vehicleValuation]: 10,
  [TaskQueues.debtVerification]: 10,
};

/** Custom search attributes: the operator's list and filter dimensions. */
export const SA = {
  status: defineSearchAttributeKey('ApplicationStatus', SearchAttributeType.KEYWORD),
  product: defineSearchAttributeKey('ProductType', SearchAttributeType.KEYWORD),
  channel: defineSearchAttributeKey('Channel', SearchAttributeType.KEYWORD),
  slaBreached: defineSearchAttributeKey('SlaBreached', SearchAttributeType.BOOL),
};
export const ALL_SEARCH_ATTRIBUTES = Object.values(SA);

/** Idempotency key: the same submission always maps to the same workflow ID. */
export const loanWorkflowId = (channel: string, externalRef: string) =>
  `loan-${channel.toLowerCase().replace('_', '-')}-${externalRef}`;

export const childWorkflowId = (parentId: string, stage: string, round = 1) =>
  round === 1 ? `${parentId}/${stage}` : `${parentId}/${stage}-${round}`;

/** Small, non-sensitive summary kept in the memo so list views need no per-workflow query. */
export const applicationMemo = (a: LoanApplication) => ({
  applicantName: a.applicant.fullName || '(unparsed)',
  amount: a.amount,
  scenario: a.scenario ?? null,
  brokerId: a.brokerId ?? null,
});
