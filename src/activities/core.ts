import { readFileSync } from 'node:fs';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { Client } from '@temporalio/client';
import { policyFor } from '../products';
import { fromAggregatorRow, type AggregatorRowResult } from '../ingest/adapters';
import type {
  AuditEvent, DocumentType, EnrichmentResult, LoanApplication, PolicyDecision, ProductChecks, ValidationResult,
} from '../shared/types';
import { AuditStore } from './auditStore';
import { shortHash } from './providers';
import type { ProviderHealth } from './providerHealth';
import { BillingStore } from '../billing/store';
import { priceLoan } from '../billing/tariff';
import type { BillingCharge, ProductType } from '../shared/types';
import { SimulatedWorld, type NotificationTemplate } from './simulatedWorld';

export interface ActivityDeps {
  audit: AuditStore;
  /** Provider circuit breakers and the global outage switch. Created on demand if omitted. */
  health?: ProviderHealth;
  /** Only needed by the simulated world (demo actors that answer notifications). */
  client?: Client;
  /** Billing ledger. Created on demand if omitted. */
  billing?: BillingStore;
}

const ageOn = (dob: string, now: Date) => {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return -1;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
};

export function createCoreActivities({ audit, client, health, billing = new BillingStore() }: ActivityDeps & { health: ProviderHealth }) {
  const world = new SimulatedWorld(client);
  /** Mock core-banking ledger. The real idempotency guarantee must come from the bank's payout API. */
  const payouts = new Map<string, string>();

  /** Core-banking downtime is retryable: the disbursement child waits it out within bankingBudget. */
  function bankingAvailable(app: LoanApplication) {
    const until = app.simulate?.bankingDownUntil;
    if (health.status.isDown('core-banking') || (until && Date.now() < Date.parse(until))) {
      throw ApplicationFailure.retryable('core banking unavailable (connection refused)', 'BankingUnavailable');
    }
  }

  return {
    /** Schema checks, product hard limits and the product's document checklist. */
    async validateApplication(input: { application: LoanApplication; providedDocuments: DocumentType[] }): Promise<ValidationResult> {
      const { application: app } = input;
      const policy = policyFor(app.productType);
      const hardFailures: string[] = [];
      const { minAmount, maxAmount, minTermMonths, maxTermMonths } = policy.limits;
      if (!app.applicant.fullName) hardFailures.push('APPLICANT_NAME_MISSING');
      if (!app.applicant.email) hardFailures.push('APPLICANT_EMAIL_MISSING');
      const age = ageOn(app.applicant.dateOfBirth, new Date());
      if (age < 0) hardFailures.push('DATE_OF_BIRTH_INVALID');
      else if (age < 18) hardFailures.push('APPLICANT_UNDER_18');
      if (app.amount < minAmount || app.amount > maxAmount) hardFailures.push(`AMOUNT_OUTSIDE_${minAmount}_${maxAmount}`);
      if (app.termMonths < minTermMonths || app.termMonths > maxTermMonths) hardFailures.push(`TERM_OUTSIDE_${minTermMonths}_${maxTermMonths}`);
      if (app.applicant.annualIncome <= 0) hardFailures.push('INCOME_MISSING');
      if (app.productType === 'AUTO' && !app.vehicle) hardFailures.push('VEHICLE_DETAILS_MISSING');
      const have = new Set(input.providedDocuments);
      return {
        hardFailures,
        missingDocuments: policy.requiredDocuments.filter((d) => !have.has(d)),
        enrichmentChecks: policy.enrichmentChecks,
        policyVersion: policy.version,
      };
    },

    /** Product rules run in an activity, so changing a threshold can never break workflow replay. */
    async evaluateRules(input: { application: LoanApplication; enrichment: EnrichmentResult; productChecks: ProductChecks }):
      Promise<PolicyDecision & { policyVersion: string }> {
      if (input.application.simulate?.rulesEngineError) {
        throw ApplicationFailure.retryable('rules engine returned 500 (bad rules deploy)', 'RulesEngineError');
      }
      const policy = policyFor(input.application.productType);
      return { ...policy.evaluate(input), policyVersion: policy.version };
    },

    /** Append-only decision log. Retried without limit by the workflow: no decision goes unrecorded. */
    async recordAuditEvent(input: { event: AuditEvent; eventKey: string }): Promise<void> {
      audit.append(input.event, input.eventKey);
    },

    /** Best-effort notification (email, SMS, reviewer queue page). Also the simulated world's input. */
    async notify(input: {
      applicationId: string; application: LoanApplication; recipient: 'applicant' | 'reviewer' | 'ops';
      template: NotificationTemplate; data?: Record<string, unknown>;
    }): Promise<{ delivered: true }> {
      if (input.application.simulate?.notificationsDown) {
        throw ApplicationFailure.retryable('notification service unavailable', 'NotificationUnavailable');
      }
      world.onNotification({ ...input, data: input.data ?? {} });
      return { delivered: true };
    },

    /** E-sign envelope. The envelope ID is decided by the workflow, so a retried send is a no-op. */
    /** Pre-disbursement sanctions screen (mock). In production: a watchlist vendor, cached per applicant. */
    async screenSanctions(input: { applicationId: string; application: LoanApplication }): Promise<{ match: boolean; list: string; screenedAt: string; ref: string }> {
      await Context.current().sleep(15);
      return {
        match: !!input.application.simulate?.sanctionsHit,
        list: input.application.simulate?.sanctionsHit ? 'OFAC SDN (name and DOB)' : 'OFAC SDN, UN, EU consolidated',
        screenedAt: new Date().toISOString(),
        ref: `scr-${shortHash(input.applicationId)}`,
      };
    },

    async sendEnvelope(input: { applicationId: string; envelopeId: string; application: LoanApplication }): Promise<{ envelopeId: string }> {
      await Context.current().sleep(20);
      return { envelopeId: input.envelopeId };
    },

    // ---- disbursement child activities ----------------------------------

    async bookLoan(input: { applicationId: string; application: LoanApplication }): Promise<{ loanNumber: string }> {
      bankingAvailable(input.application);
      await Context.current().sleep(20);
      return { loanNumber: `LN-${shortHash(input.applicationId).toUpperCase()}` };
    },

    async disburseFunds(input: { applicationId: string; loanNumber: string; application: LoanApplication }): Promise<{ payoutRef: string }> {
      Context.current().heartbeat('submitting payout');
      const existing = payouts.get(input.applicationId);
      if (existing) return { payoutRef: existing }; // idempotent on the application ID: never pay twice
      bankingAvailable(input.application);
      if (input.application.simulate?.payoutRejected) {
        throw ApplicationFailure.nonRetryable('Payout rejected by core banking: destination account closed', 'PayoutRejected');
      }
      await Context.current().sleep(30);
      const payoutRef = `PO-${shortHash(input.applicationId + input.loanNumber).toUpperCase()}`;
      payouts.set(input.applicationId, payoutRef);
      return { payoutRef };
    },

    async confirmFunding(input: { applicationId: string; payoutRef: string }): Promise<{ confirmed: true }> {
      await Context.current().sleep(10);
      return { confirmed: true };
    },

    // ---- billing (queue: billing) ----------------------------------------

    /** Pure pricing from the versioned tariff; an activity so a tariff change never affects replay. */
    async priceFundedLoan(input: { productType: ProductType; principal: number }) {
      return priceLoan(input.productType, input.principal);
    },

    /** Idempotent on the application ID: a retry returns the charge already on file. */
    async recordCharge(input: { charge: BillingCharge }): Promise<BillingCharge> {
      const stored = billing.record(input.charge).charge;
      const out: BillingCharge & { recordedAt?: string } = { ...stored };
      delete out.recordedAt;
      return out;
    },

    // ---- aggregator batch -----------------------------------------------

    async readBatchPage(input: { filePath: string; offset: number; pageSize: number }):
      Promise<{ rows: AggregatorRowResult[]; nextOffset: number | null; total: number }> {
      const lines = readFileSync(input.filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      const header = lines[0].split(',').map((h) => h.trim());
      const body = lines.slice(1);
      const page = body.slice(input.offset, input.offset + input.pageSize);
      const rows = page.map((line, i) => fromAggregatorRow(header, line, input.offset + i + 2));
      const next = input.offset + input.pageSize;
      return { rows, nextOffset: next < body.length ? next : null, total: body.length };
    },
  };
}
