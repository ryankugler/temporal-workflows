import { describe, expect, it } from 'vitest';
import { POLICIES } from '../src/products';
import { buildScenario, seededRng } from '../src/ingest/scenarios';
import type { EnrichmentResult, LoanApplication, ProductChecks } from '../src/shared/types';

const clean: EnrichmentResult = {
  credit: { score: 740, delinquencies: 0, bureauRef: 'cb' },
  identity: { verified: true, matchScore: 0.97, providerRef: 'id' },
  fraud: { riskScore: 0.04, flagged: false, signals: [] },
  failures: [],
};
const app = (product: LoanApplication['productType'], over: Partial<LoanApplication> = {}): LoanApplication => ({
  ...buildScenario('happy', { ref: 'p', rng: seededRng(1), product }), ...over,
  applicant: { applicantId: 'a', fullName: 'Test', dateOfBirth: '1990-01-01', email: 't@example.com', annualIncome: 120_000, monthlyDebtPayments: 300 },
});
const evaluate = (a: LoanApplication, e: Partial<EnrichmentResult> = {}, checks: ProductChecks = {}) =>
  POLICIES[a.productType].evaluate({ application: a, enrichment: { ...clean, ...e }, productChecks: checks });

describe('product policies (isolated per product)', () => {
  it('personal: auto-approves within policy, refers borderline credit, declines low credit', () => {
    expect(evaluate(app('PERSONAL', { amount: 10_000, termMonths: 36 })).outcome).toBe('APPROVE');
    expect(evaluate(app('PERSONAL', { amount: 10_000, termMonths: 36 }), { credit: { score: 640, delinquencies: 0, bureauRef: 'x' } })).toMatchObject({ outcome: 'REFER', reasons: ['CREDIT_SCORE_BORDERLINE'] });
    expect(evaluate(app('PERSONAL', { amount: 10_000, termMonths: 36 }), { credit: { score: 540, delinquencies: 0, bureauRef: 'x' } })).toMatchObject({ outcome: 'DECLINE', reasons: ['CREDIT_SCORE_BELOW_580'] });
  });

  it('personal: four-eyes above the threshold, fraud signals always refer', () => {
    expect(evaluate(app('PERSONAL', { amount: 40_000, termMonths: 60 }))).toMatchObject({ outcome: 'REFER', requiredApprovals: 2 });
    expect(evaluate(app('PERSONAL', { amount: 10_000, termMonths: 36 }), { fraud: { riskScore: 0.9, flagged: true, signals: ['DEVICE_VELOCITY'] } }).reasons[0]).toMatch(/FRAUD_SIGNALS/);
  });

  it('auto: loan-to-value bands against the independent valuation', () => {
    const a = app('AUTO', { amount: 20_000, termMonths: 60, vehicle: { vin: 'v', purchasePrice: 20_000 } });
    expect(evaluate(a, {}, { vehicle: { vin: 'v', marketValue: 25_000 } })).toMatchObject({ outcome: 'APPROVE', metrics: { ltv: 0.8 } });
    expect(evaluate(a, {}, { vehicle: { vin: 'v', marketValue: 17_500 } }).reasons).toContain('LTV_BORDERLINE');
    expect(evaluate(a, {}, { vehicle: { vin: 'v', marketValue: 15_000 } })).toMatchObject({ outcome: 'DECLINE', reasons: ['LTV_ABOVE_125PCT'] });
    expect(evaluate(a).reasons).toContain('NO_VEHICLE_VALUATION');
  });

  it('debt consolidation: the verified debt bounds the amount', () => {
    const a = app('DEBT_CONSOLIDATION', { amount: 10_000, termMonths: 36 });
    expect(evaluate(a, {}, { debts: { verifiedTotal: 10_000, accounts: 2 } }).outcome).toBe('APPROVE');
    expect(evaluate(a, {}, { debts: { verifiedTotal: 8_000, accounts: 2 } })).toMatchObject({ outcome: 'REFER', reasons: ['AMOUNT_EXCEEDS_VERIFIED_DEBT'] });
    expect(evaluate(a, {}, { debts: { verifiedTotal: 0, accounts: 0 } })).toMatchObject({ outcome: 'DECLINE', reasons: ['NO_VERIFIED_DEBTS_TO_CONSOLIDATE'] });
  });

  it('the same applicant gets each product\'s own thresholds (no bleed between products)', () => {
    const credit = { score: 590, delinquencies: 0, bureauRef: 'x' };
    expect(evaluate(app('PERSONAL', { amount: 10_000, termMonths: 36 }), { credit }).outcome).toBe('REFER'); // personal declines below 580
    expect(evaluate(app('DEBT_CONSOLIDATION', { amount: 10_000, termMonths: 36 }), { credit }, { debts: { verifiedTotal: 10_000, accounts: 1 } }).outcome).toBe('DECLINE'); // debt-con declines below 600
    expect(new Set(Object.values(POLICIES).map((p) => p.version)).size).toBe(3);
  });
});
