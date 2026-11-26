/**
 * Underwriting child workflows: one workflow type per product, each on its own task queue
 * (underwriting-personal / -auto / -debt-consolidation). A product can be deployed, scaled, versioned and
 * monitored on its own; a bad auto-loan deploy can't touch personal loans.
 *
 * Each product runs its own extra checks (vehicle valuation, debt verification), then that product's
 * rules in an activity. Rules failures that exhaust retries fail the child; the parent escalates.
 */
import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from '../activities';
import { TaskQueues } from '../shared/config';
import type { ProductChecks, ProductType, ProviderFailure, UnderwritingInput, UnderwritingResult } from '../shared/types';
import { providerProxy } from './activityOptions';
import { failureKind, rootMessage } from './enrichment';

function rulesFor(product: ProductType) {
  return proxyActivities<Activities>({
    taskQueue: TaskQueues.underwriting(product),
    startToCloseTimeout: '10s',
    retry: { maximumAttempts: 3, initialInterval: '200ms' },
  });
}

async function decide(input: UnderwritingInput, productChecks: ProductChecks, failures: ProviderFailure[]): Promise<UnderwritingResult> {
  const { policyVersion, ...decision } = await rulesFor(input.application.productType).evaluateRules({
    application: input.application,
    enrichment: input.enrichment,
    productChecks,
  });
  return { ...decision, policyVersion, productChecks, failures };
}

export async function personalLoanUnderwriting(input: UnderwritingInput): Promise<UnderwritingResult> {
  return decide(input, {}, []);
}

export async function autoLoanUnderwriting(input: UnderwritingInput): Promise<UnderwritingResult> {
  const failures: ProviderFailure[] = [];
  const checks: ProductChecks = {};
  try {
    checks.vehicle = await providerProxy(TaskQueues.vehicleValuation, input.timing)
      .valueVehicle({ applicationId: input.applicationId, application: input.application });
  } catch (err) {
    failures.push({ provider: 'vehicle-valuation', error: rootMessage(err), kind: failureKind(err) }); // the policy refers without a valuation
  }
  return decide(input, checks, failures);
}

export async function debtConsolidationUnderwriting(input: UnderwritingInput): Promise<UnderwritingResult> {
  const failures: ProviderFailure[] = [];
  const checks: ProductChecks = {};
  try {
    checks.debts = await providerProxy(TaskQueues.debtVerification, input.timing)
      .verifyDebts({ applicationId: input.applicationId, application: input.application });
  } catch (err) {
    failures.push({ provider: 'debt-verification', error: rootMessage(err), kind: failureKind(err) });
  }
  return decide(input, checks, failures);
}

export const UNDERWRITING_WORKFLOWS = {
  PERSONAL: personalLoanUnderwriting,
  AUTO: autoLoanUnderwriting,
  DEBT_CONSOLIDATION: debtConsolidationUnderwriting,
} as const;
