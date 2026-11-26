import type { Duration } from '@temporalio/common';

export type Channel = 'PORTAL' | 'BROKER_EMAIL' | 'AGGREGATOR';
export const CHANNELS: readonly Channel[] = ['PORTAL', 'BROKER_EMAIL', 'AGGREGATOR'];
export type ProductType = 'PERSONAL' | 'AUTO' | 'DEBT_CONSOLIDATION';
export const PRODUCT_TYPES: readonly ProductType[] = ['PERSONAL', 'AUTO', 'DEBT_CONSOLIDATION'];
export type DocumentType = 'GOV_ID' | 'PAYSTUB' | 'BANK_STATEMENT' | 'VEHICLE_PURCHASE_AGREEMENT' | 'DEBT_STATEMENTS';

export type ApplicationStatus =
  | 'RECEIVED'
  | 'VALIDATING'
  | 'AWAITING_DOCS'
  | 'ENRICHING'
  | 'AWAITING_PROVIDER'
  | 'UNDERWRITING'
  | 'HUMAN_REVIEW'
  | 'AWAITING_SIGNATURE'
  | 'DISBURSING'
  // terminal
  | 'FUNDED'
  | 'DECLINED'
  | 'ESCALATED';

export const ALL_STATUSES: readonly ApplicationStatus[] = [
  'RECEIVED', 'VALIDATING', 'AWAITING_DOCS', 'ENRICHING', 'AWAITING_PROVIDER', 'UNDERWRITING', 'HUMAN_REVIEW',
  'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED', 'DECLINED', 'ESCALATED',
];
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = ['FUNDED', 'DECLINED', 'ESCALATED'];
export const isTerminal = (s: ApplicationStatus) => TERMINAL_STATUSES.includes(s);

export interface Applicant {
  applicantId: string;
  fullName: string;
  dateOfBirth: string; // YYYY-MM-DD
  email: string;
  annualIncome: number;
  monthlyDebtPayments: number;
}

/**
 * Demo-only knobs. They make the mocked providers misbehave and drive the simulated applicant and
 * reviewer, so every path can be exercised. In production this field does not exist.
 */
export interface Simulation {
  creditScore?: number;
  /** Credit bureau fails this many attempts (the first with a 429) before succeeding. */
  creditFailures?: number;
  /** Provider is down for this application (until outageUntil, or for the whole run). */
  outage?: 'credit' | 'identity' | 'fraud';
  /** ISO time the per-application outage ends (a "blip"). */
  outageUntil?: string;
  /** ISO time until which core banking rejects connections (disbursement waits it out). */
  bankingDownUntil?: string;
  fraudFlag?: boolean;
  identityNotFound?: boolean;
  vehicleValue?: number;
  payoutRejected?: boolean;
  /** The rules engine keeps throwing (a bad rules deploy). The child fails and the parent escalates. */
  rulesEngineError?: boolean;
  /** Sanctions screening returns a potential match (added via patched(); see the parent workflow). */
  sanctionsHit?: boolean;
  notificationsDown?: boolean;
  /** Simulated applicant. Defaults: never uploads missing docs, signs ~300ms after the envelope is sent. */
  applicant?: {
    uploadsDocsAfterMs?: number;
    signs?: 'auto' | 'manual';
    signDelayMs?: number;
    /** Withdraws this long after being asked for documents. */
    withdrawsAfterMs?: number;
  };
  /** Simulated reviewer. Without it, reviews wait for a person (CLI or UI). */
  reviewer?: {
    decision: 'APPROVE' | 'DECLINE' | 'REQUEST_INFO';
    afterMs: number;
  };
}

/** The single normalized contract every ingestion channel produces. */
export interface LoanApplication {
  externalRef: string;
  channel: Channel;
  productType: ProductType;
  applicant: Applicant;
  amount: number;
  termMonths: number;
  documents: DocumentType[];
  brokerId?: string;
  vehicle?: { vin: string; purchasePrice: number };
  debtsToConsolidate?: { creditor: string; balance: number }[];
  /** Scenario that produced it (demo and synthesizer runs); shown in the UI. */
  scenario?: string;
  simulate?: Simulation;
}

export interface Timing {
  /** Overall funding SLA. A breach raises an alert; it does not stop the workflow. */
  overallSla: Duration;
  docsReminder: Duration;
  /** Abandoned this long after the reminder. */
  docsTimeout: Duration;
  /** Time a case may sit in human review before it is escalated. */
  reviewTimeout: Duration;
  /** Total budget per third-party call, across all retries. */
  providerBudget: Duration;
  providerRetryInitialInterval: Duration;
  signatureReminder: Duration;
  /** The offer lapses this long after the reminder. */
  signatureTimeout: Duration;
  /** Provider downtime: first wait before re-trying failed checks, doubling up to the max. */
  providerParkInitial: Duration;
  providerParkMax: Duration;
  /** Total time an application may wait on a provider outage before going to human review. */
  providerOutageBudget: Duration;
  /** Total time a payout keeps retrying through a core-banking outage before escalating. */
  bankingBudget: Duration;
  /**
   * A reviewer's claim on a case is a lease, like a web session: it lasts claimLease, the reviewer is
   * reminded claimReminderBefore it ends, and an unrenewed claim lapses so the case returns to the queue.
   * The application itself never dies with a session; only the claim does.
   */
  claimLease: Duration;
  claimReminderBefore: Duration;
  /** When an open application is flagged as at risk of breaching the overall SLA. */
  slaAtRiskAfter: Duration;
  /** The SLA board calls an application stale after this long without any activity. */
  staleAfter: Duration;
}

export const DEFAULT_TIMING: Timing = {
  overallSla: '48h',
  docsReminder: '12h',
  docsTimeout: '24h',
  reviewTimeout: '8h',
  providerBudget: '30m',
  providerRetryInitialInterval: '2s',
  signatureReminder: '12h',
  signatureTimeout: '60h',
  providerParkInitial: '5m',
  providerParkMax: '30m',
  providerOutageBudget: '4h',
  bankingBudget: '24h',
  claimLease: '30m',
  claimReminderBefore: '5m',
  slaAtRiskAfter: '36h',
  staleAfter: '4h',
};

/** Shortened timers so a demo reaches every terminal state within a few minutes. */
export const DEMO_TIMING: Timing = {
  overallSla: '4m',
  docsReminder: '45s',
  docsTimeout: '90s',
  reviewTimeout: '10m',
  providerBudget: '12s',
  providerRetryInitialInterval: '500ms',
  signatureReminder: '45s',
  signatureTimeout: '90s',
  providerParkInitial: '4s',
  providerParkMax: '15s',
  providerOutageBudget: '45s',
  bankingBudget: '3m',
  claimLease: '3m',
  claimReminderBefore: '45s',
  slaAtRiskAfter: '150s',
  staleAfter: '45s',
};

export interface LoanWorkflowInput {
  application: LoanApplication;
  timing?: Partial<Timing>;
}

// ---- validation ---------------------------------------------------------

export type EnrichmentCheck = 'credit' | 'identity' | 'fraud';

export interface ValidationResult {
  hardFailures: string[];
  missingDocuments: DocumentType[];
  /** Product-driven: which shared third-party checks the enrichment child should run. */
  enrichmentChecks: EnrichmentCheck[];
  policyVersion: string;
}

// ---- enrichment child ---------------------------------------------------

export interface CreditReport { score: number; delinquencies: number; bureauRef: string }
export interface IdentityResult { verified: boolean; matchScore: number; providerRef: string }
export interface FraudResult { riskScore: number; flagged: boolean; signals: string[] }
/**
 * UNAVAILABLE: the provider is down or throttling (budget spent, circuit open). Worth waiting for.
 * PERMANENT: a business answer (subject not found, bad input). Waiting won't change it.
 */
export interface ProviderFailure { provider: string; check?: string; error: string; kind?: 'UNAVAILABLE' | 'PERMANENT' }

export interface EnrichmentInput {
  applicationId: string;
  application: LoanApplication;
  checks: EnrichmentCheck[];
  timing: Timing;
}

export interface EnrichmentResult {
  credit?: CreditReport;
  identity?: IdentityResult;
  fraud?: FraudResult;
  failures: ProviderFailure[];
}

// ---- underwriting child (one type per product) --------------------------

export interface VehicleValuation { vin: string; marketValue: number }
export interface DebtVerification { verifiedTotal: number; accounts: number }

export interface ProductChecks {
  vehicle?: VehicleValuation;
  debts?: DebtVerification;
}

export interface UnderwritingInput {
  applicationId: string;
  application: LoanApplication;
  enrichment: EnrichmentResult;
  timing: Timing;
}

export interface PolicyDecision {
  outcome: 'APPROVE' | 'DECLINE' | 'REFER';
  reasons: string[];
  /** More than 1 means four-eyes: that many distinct reviewers must approve. */
  requiredApprovals: number;
  metrics: Record<string, number>;
}

export interface UnderwritingResult extends PolicyDecision {
  policyVersion: string;
  productChecks: ProductChecks;
  failures: ProviderFailure[];
}

// ---- disbursement child -------------------------------------------------

export interface DisbursementInput {
  applicationId: string;
  application: LoanApplication;
  envelopeId: string;
  timing: Timing;
}

export type DisbursementResult =
  | { status: 'FUNDED'; loanNumber: string; payoutRef: string }
  | { status: 'REJECTED'; loanNumber: string; reason: string };

// ---- human and external input -------------------------------------------

export interface ReviewDecision {
  decision: 'APPROVE' | 'DECLINE' | 'REQUEST_INFO';
  reviewerId: string;
  reason: string;
  requestedDocuments?: DocumentType[];
}

export interface ClaimRequest {
  reviewerId: string;
  /** claim (or renew your own), extend (renew your own), release (give it back). */
  action: 'claim' | 'extend' | 'release';
}

export interface ReviewClaim { reviewerId: string; claimedAt: string; expiresAt: string; reminded: boolean }

export interface ReviewAck {
  accepted: true;
  approvalsReceived: number;
  approvalsRequired: number;
  status: ApplicationStatus;
}

export interface DocumentsUploaded { documents: DocumentType[]; uploadedBy: string }
export interface AgreementSigned { envelopeId: string; signerName: string; signedAt: string }
export interface Withdrawal { reason: string; requestedBy: string }
export interface RetryProvidersNow { requestedBy: string }

// ---- status and audit ---------------------------------------------------

export interface Transition {
  from: ApplicationStatus;
  to: ApplicationStatus;
  at: string;
  actor: string;
  reason?: string;
}

// ---- billing --------------------------------------------------------------

/** A funded loan is a billable workflow: exactly one charge per application, priced by a versioned tariff. */
export interface BillingInput {
  applicationId: string;
  application: LoanApplication;
  loanNumber: string;
  payoutRef: string;
  fundedAt: string;
}

export interface BillingCharge {
  chargeId: string;
  applicationId: string;
  /** Who is billed: the lending business line that owns the product. */
  account: string;
  productType: ProductType;
  channel: Channel;
  brokerId?: string;
  principal: number;
  fee: number;
  breakdown: { flat: number; variable: number; bps: number; minApplied: boolean; capApplied: boolean };
  currency: 'USD';
  tariffVersion: string;
  loanNumber: string;
  payoutRef: string;
  fundedAt: string;
  /** Invoice period, YYYY-MM. */
  period: string;
}

export interface ChildRun { stage: 'enrichment' | 'underwriting' | 'disbursement' | 'billing'; workflowId: string; workflowType: string; taskQueue: string }

export interface StatusView {
  applicationId: string;
  applicantName: string;
  productType: ProductType;
  channel: Channel;
  amount: number;
  scenario?: string;
  status: ApplicationStatus;
  pendingAction?: string;
  missingDocuments: DocumentType[];
  reasons: string[];
  slaDeadline: string;
  slaBreached: boolean;
  approvals: { reviewerId: string; reason: string }[];
  approvalsRequired: number;
  claim?: ReviewClaim;
  reviewDeadline?: string;
  enrichment?: EnrichmentResult;
  underwriting?: UnderwritingResult;
  signature?: { envelopeId: string; signedAt?: string; signerName?: string };
  disbursement?: DisbursementResult;
  billing?: BillingCharge;
  slaAtRisk?: boolean;
  providerWait?: { providers: string[]; attempts: number; since: string; nextRetryAt?: string; deadline: string };
  children: ChildRun[];
  history: Transition[];
}

export interface AuditEvent {
  applicationId: string;
  runId: string;
  type: string;
  actor: string;
  /** Deterministic workflow time of the event. */
  at: string;
  productType: ProductType;
  channel: Channel;
  from?: ApplicationStatus;
  to?: ApplicationStatus;
  reason?: string;
  details?: Record<string, unknown>;
}
