/**
 * Billing tariff: what one funded loan costs the business line that owns it. Illustrative numbers,
 * versioned like product rules, and recorded on every charge so an invoice can be explained later.
 *
 * fee = clamp(flat + principal × bps / 10,000, min, cap), rounded to cents.
 * Only FUNDED applications are billable; declined and escalated ones cost nothing and bill nothing,
 * which is why the funding rate is the number the lending team watches.
 */
import type { ProductType } from '../shared/types';

export interface TariffLine { account: string; flat: number; bps: number; min: number; cap: number }

export const TARIFF_VERSION = 'tariff-2026.11';

export const TARIFF: Record<ProductType, TariffLine> = {
  PERSONAL: { account: 'Personal Lending', flat: 95, bps: 50, min: 150, cap: 1_500 },
  AUTO: { account: 'Auto Lending', flat: 75, bps: 35, min: 125, cap: 1_200 },
  DEBT_CONSOLIDATION: { account: 'Debt Consolidation', flat: 95, bps: 60, min: 150, cap: 1_500 },
};

const cents = (n: number) => Math.round(n * 100) / 100;

export function priceLoan(product: ProductType, principal: number) {
  const line = TARIFF[product];
  const variable = cents((principal * line.bps) / 10_000);
  const raw = line.flat + variable;
  const fee = cents(Math.min(line.cap, Math.max(line.min, raw)));
  return {
    account: line.account,
    fee,
    breakdown: { flat: line.flat, variable, bps: line.bps, minApplied: raw < line.min, capApplied: raw > line.cap },
    tariffVersion: TARIFF_VERSION,
  };
}

/** Expected fee for an application that hasn't funded yet: the pipeline value the SLA board shows. */
export const expectedFee = (product: ProductType, principal: number) => priceLoan(product, principal).fee;
