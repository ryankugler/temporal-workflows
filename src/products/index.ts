import type { ProductType } from '../shared/types';
import { bandedDecision, round2, type ProductPolicy } from './policy';

export const personalLoanPolicy: ProductPolicy = {
  product: 'PERSONAL',
  version: 'personal-2026.11.1',
  requiredDocuments: ['GOV_ID', 'PAYSTUB'],
  limits: { minAmount: 1_000, maxAmount: 50_000, minTermMonths: 12, maxTermMonths: 60 },
  enrichmentChecks: ['credit', 'identity', 'fraud'],
  fourEyesAmount: 35_000,
  evaluate: (input) =>
    bandedDecision(input, { declineBelowScore: 580, referBelowScore: 660, maxDti: 0.45, referDti: 0.38, rate: 0.11, fourEyesAmount: 35_000 }),
};

export const autoLoanPolicy: ProductPolicy = {
  product: 'AUTO',
  version: 'auto-2026.11.1',
  requiredDocuments: ['GOV_ID', 'PAYSTUB', 'VEHICLE_PURCHASE_AGREEMENT'],
  limits: { minAmount: 5_000, maxAmount: 90_000, minTermMonths: 24, maxTermMonths: 84 },
  enrichmentChecks: ['credit', 'identity', 'fraud'],
  fourEyesAmount: 60_000,
  evaluate: (input) =>
    bandedDecision(
      input,
      { declineBelowScore: 560, referBelowScore: 640, maxDti: 0.5, referDti: 0.42, rate: 0.07, fourEyesAmount: 60_000 },
      ({ decline, refer }, metrics) => {
        // Collateral: loan-to-value against the independent valuation.
        const value = input.productChecks.vehicle?.marketValue;
        if (!value) { refer.push('NO_VEHICLE_VALUATION'); return; }
        const ltv = input.application.amount / value;
        metrics.ltv = round2(ltv);
        if (ltv > 1.25) decline.push('LTV_ABOVE_125PCT');
        else if (ltv > 1.1) refer.push('LTV_BORDERLINE');
      },
    ),
};

export const debtConsolidationPolicy: ProductPolicy = {
  product: 'DEBT_CONSOLIDATION',
  version: 'debtcon-2026.11.1',
  requiredDocuments: ['GOV_ID', 'PAYSTUB', 'DEBT_STATEMENTS'],
  limits: { minAmount: 2_000, maxAmount: 60_000, minTermMonths: 12, maxTermMonths: 72 },
  enrichmentChecks: ['credit', 'identity', 'fraud'],
  fourEyesAmount: 40_000,
  evaluate: (input) =>
    bandedDecision(
      input,
      // Consolidation replaces existing payments, so the DTI bands are looser.
      { declineBelowScore: 600, referBelowScore: 670, maxDti: 0.55, referDti: 0.45, rate: 0.12, fourEyesAmount: 40_000 },
      ({ decline, refer }, metrics) => {
        const verified = input.productChecks.debts?.verifiedTotal ?? 0;
        metrics.verifiedDebt = verified;
        if (verified === 0) decline.push('NO_VERIFIED_DEBTS_TO_CONSOLIDATE');
        else if (input.application.amount > verified * 1.1) refer.push('AMOUNT_EXCEEDS_VERIFIED_DEBT');
      },
    ),
};

export const POLICIES: Record<ProductType, ProductPolicy> = {
  PERSONAL: personalLoanPolicy,
  AUTO: autoLoanPolicy,
  DEBT_CONSOLIDATION: debtConsolidationPolicy,
};

export const policyFor = (p: ProductType) => POLICIES[p];
