import type {
  DocumentType, EnrichmentCheck, EnrichmentResult, LoanApplication, PolicyDecision, ProductChecks, ProductType,
} from '../shared/types';

/**
 * Everything product-specific lives behind this interface. Adding a product means adding a policy and an
 * underwriting child type; the parent workflow and the shared children never change.
 */
export interface ProductPolicy {
  product: ProductType;
  /** Recorded with every decision, e.g. "auto-2026.11.1". */
  version: string;
  requiredDocuments: DocumentType[];
  limits: { minAmount: number; maxAmount: number; minTermMonths: number; maxTermMonths: number };
  /** Shared third-party checks the enrichment child runs for this product. */
  enrichmentChecks: EnrichmentCheck[];
  /** At or above this amount, two distinct reviewers must approve. */
  fourEyesAmount: number;
  evaluate(input: { application: LoanApplication; enrichment: EnrichmentResult; productChecks: ProductChecks }): PolicyDecision;
}

/** Monthly payment for an amortizing loan, used for debt-to-income. */
export function monthlyPayment(amount: number, termMonths: number, annualRate: number): number {
  const r = annualRate / 12;
  return r === 0 ? amount / termMonths : (amount * r) / (1 - Math.pow(1 + r, -termMonths));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Shared skeleton most products follow: fraud and identity gates, then credit and DTI bands.
 * Products pass their own thresholds and can add product-specific rules.
 */
export function bandedDecision(
  input: Parameters<ProductPolicy['evaluate']>[0],
  t: { declineBelowScore: number; referBelowScore: number; maxDti: number; referDti: number; rate: number; fourEyesAmount: number },
  extra: (reasons: { decline: string[]; refer: string[] }, metrics: Record<string, number>) => void = () => {},
): PolicyDecision {
  const { application: app, enrichment: e } = input;
  const decline: string[] = [];
  const refer: string[] = [];
  const score = e.credit?.score ?? 0;
  const payment = monthlyPayment(app.amount, app.termMonths, t.rate);
  const monthlyIncome = app.applicant.annualIncome / 12;
  const dti = monthlyIncome > 0 ? (app.applicant.monthlyDebtPayments + payment) / monthlyIncome : 99;
  const metrics: Record<string, number> = { creditScore: score, dti: round2(dti), monthlyPayment: round2(payment) };
  if (e.fraud) metrics.fraudRisk = e.fraud.riskScore;

  if (e.fraud?.flagged) refer.push(`FRAUD_SIGNALS:${e.fraud.signals.join('+')}`);
  if (e.identity && !e.identity.verified) refer.push('IDENTITY_UNVERIFIED');
  if (score < t.declineBelowScore) decline.push(`CREDIT_SCORE_BELOW_${t.declineBelowScore}`);
  else if (score < t.referBelowScore) refer.push(`CREDIT_SCORE_BORDERLINE`);
  if (dti > t.maxDti) decline.push(`DTI_ABOVE_${Math.round(t.maxDti * 100)}PCT`);
  else if (dti > t.referDti) refer.push('DTI_BORDERLINE');
  extra({ decline, refer }, metrics);

  if (decline.length) return { outcome: 'DECLINE', reasons: decline, requiredApprovals: 0, metrics };
  const fourEyes = app.amount >= t.fourEyesAmount;
  if (refer.length || fourEyes) {
    return {
      outcome: 'REFER',
      reasons: fourEyes ? [...refer, `FOUR_EYES_AMOUNT_GTE_${t.fourEyesAmount}`] : refer,
      requiredApprovals: fourEyes ? 2 : 1,
      metrics,
    };
  }
  return { outcome: 'APPROVE', reasons: ['AUTO_APPROVED_WITHIN_POLICY'], requiredApprovals: 0, metrics };
}
