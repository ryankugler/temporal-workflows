/**
 * Scenario profiles: the single source of demo and synthetic applications, shared by the CLI, the UI,
 * the tests and the synthesizer workflow. Pure and deterministic given an RNG, so it is safe to import
 * into workflow code.
 */
import type { Channel, DocumentType, LoanApplication, ProductType, Simulation, Timing } from '../shared/types';

export type Rng = () => number;

/** Small seeded PRNG (mulberry32) for repeatable synthetic runs. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Avery', 'Jordan', 'Priya', 'Mateo', 'Chloe', 'Wei', 'Fatima', 'Liam', 'Sofia', 'Noah', 'Amara', 'Ethan', 'Yuki', 'Omar', 'Grace', 'Diego', 'Hana', 'Lucas', 'Zara', 'Kai'];
const LAST = ['Patel', 'Nguyen', 'Okafor', 'Silva', 'Tremblay', 'Chen', 'Haddad', 'Kowalski', 'Martin', 'Singh', 'Rossi', 'Kim', 'Dubois', 'Mensah', 'Lopez', 'Novak', 'Ahmed', 'Walsh', 'Ito', 'Moreau'];
const CREDITORS = ['Northline Card', 'Maple Credit', 'Harbor Auto Finance', 'Summit Line of Credit', 'Cobalt Card'];
const pick = <T>(rng: Rng, xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
const between = (rng: Rng, lo: number, hi: number, step = 1) => Math.round((lo + rng() * (hi - lo)) / step) * step;

export const REQUIRED_DOCS: Record<ProductType, DocumentType[]> = {
  PERSONAL: ['GOV_ID', 'PAYSTUB'],
  AUTO: ['GOV_ID', 'PAYSTUB', 'VEHICLE_PURCHASE_AGREEMENT'],
  DEBT_CONSOLIDATION: ['GOV_ID', 'PAYSTUB', 'DEBT_STATEMENTS'],
};

/** A clean, policy-compliant application for the given product. */
export function baseApplication(rng: Rng, opts: { ref: string; product?: ProductType; channel?: Channel }): LoanApplication {
  const product = opts.product ?? pick(rng, ['PERSONAL', 'PERSONAL', 'AUTO', 'DEBT_CONSOLIDATION'] as const);
  const channel = opts.channel ?? pick(rng, ['PORTAL', 'PORTAL', 'BROKER_EMAIL', 'AGGREGATOR'] as const);
  const first = pick(rng, FIRST);
  const last = pick(rng, LAST);
  const income = between(rng, 62_000, 140_000, 1000);
  const app: LoanApplication = {
    externalRef: opts.ref,
    channel,
    productType: product,
    applicant: {
      applicantId: `appl-${opts.ref}`,
      fullName: `${first} ${last}`,
      dateOfBirth: `${between(rng, 1965, 2001)}-0${between(rng, 1, 9)}-1${between(rng, 0, 9)}`,
      email: `${first}.${last}@example.com`.toLowerCase(),
      annualIncome: income,
      monthlyDebtPayments: between(rng, 150, 650, 10),
    },
    amount: between(rng, 4_000, 22_000, 500),
    termMonths: pick(rng, [36, 48, 60]),
    documents: [...REQUIRED_DOCS[product]],
    brokerId: channel === 'BROKER_EMAIL' ? pick(rng, ['broker@summitlending.example', 'deals@northbrokers.example']) : undefined,
    simulate: { creditScore: between(rng, 690, 800) },
  };
  if (product === 'AUTO') {
    app.amount = between(rng, 12_000, 38_000, 500);
    app.termMonths = pick(rng, [48, 60, 72]);
    app.vehicle = { vin: `1HGCV${Math.floor(rng() * 1e11).toString().padStart(11, '0')}`.slice(0, 17), purchasePrice: Math.round(app.amount * 1.15) };
  }
  if (product === 'DEBT_CONSOLIDATION') {
    const a = between(rng, 3_000, 9_000, 100);
    const b = between(rng, 2_000, 8_000, 100);
    app.debtsToConsolidate = [{ creditor: pick(rng, CREDITORS), balance: a }, { creditor: pick(rng, CREDITORS), balance: b }];
    app.amount = a + b;
  }
  return app;
}

export interface ScenarioProfile {
  name: string;
  title: string;
  expected: string;
  /** True when the outcome needs a person (CLI/UI) unless the run auto-resolves. */
  needsHuman?: boolean;
  apply(app: LoanApplication, rng: Rng, autoResolve: boolean, now: number): void;
  /**
   * Timer overrides for this scenario, merged over the run's timing. The SLA scenarios use a shortened SLA
   * so a breach, or an at-risk flag, happens within a minute instead of 48 hours (or 4 minutes in the demo).
   */
  timing?: Partial<Timing>;
}

/** Long enough that nothing else times out while an SLA scenario sits on the board. */
const HOLD: Partial<Timing> = { reviewTimeout: '15m', docsReminder: '10m', docsTimeout: '10m', signatureReminder: '10m', signatureTimeout: '10m' };

/** Merge a scenario's own timer overrides over the run's timing. */
export const timingFor = (scenario: string | undefined, base: Partial<Timing> | undefined): Partial<Timing> | undefined =>
  scenario && SCENARIOS[scenario]?.timing ? { ...base, ...SCENARIOS[scenario].timing } : base;

const sim = (app: LoanApplication, s: Simulation) => { app.simulate = { ...app.simulate, ...s }; };
const asProduct = (app: LoanApplication, rng: Rng, product: ProductType) => {
  const fresh = baseApplication(rng, { ref: app.externalRef, product, channel: app.channel });
  Object.assign(app, { ...fresh, applicant: app.applicant, simulate: { ...fresh.simulate, ...app.simulate } });
};
const reviewer = (auto: boolean, decision: 'APPROVE' | 'DECLINE' | 'REQUEST_INFO', rng: Rng) =>
  auto ? { reviewer: { decision, afterMs: between(rng, 1500, 9000) } } : {};

export const SCENARIOS: Record<string, ScenarioProfile> = {
  happy: {
    name: 'happy', title: 'Happy path', expected: 'FUNDED in about a second',
    apply: () => {},
  },
  'auto-happy': {
    name: 'auto-happy', title: 'Auto loan', expected: 'Vehicle valuation in the auto child, then FUNDED',
    apply: (app, rng) => asProduct(app, rng, 'AUTO'),
  },
  'debtcon-happy': {
    name: 'debtcon-happy', title: 'Debt consolidation', expected: 'Debt verification in its own child, then FUNDED',
    apply: (app, rng) => asProduct(app, rng, 'DEBT_CONSOLIDATION'),
  },
  flaky: {
    name: 'flaky', title: 'Flaky credit bureau', expected: 'A 429 and two resets are retried, then FUNDED',
    apply: (app) => sim(app, { creditFailures: 3 }),
  },
  'missing-docs': {
    name: 'missing-docs', title: 'Missing paystub', expected: 'AWAITING_DOCS until uploaded, then FUNDED', needsHuman: true,
    apply: (app, rng, auto) => {
      app.documents = app.documents.filter((d) => d !== 'PAYSTUB');
      if (auto) sim(app, { applicant: { uploadsDocsAfterMs: between(rng, 1500, 6000) } });
    },
  },
  abandon: {
    name: 'abandon', title: 'Applicant never uploads', expected: 'Reminder, then DECLINED (abandoned)',
    apply: (app) => { app.documents = app.documents.filter((d) => d !== 'GOV_ID'); },
  },
  'low-credit': {
    name: 'low-credit', title: 'Low credit score', expected: 'DECLINED by product rules',
    apply: (app, rng) => sim(app, { creditScore: between(rng, 480, 550) }),
  },
  fraud: {
    name: 'fraud', title: 'Fraud signals', expected: 'HUMAN_REVIEW; approve or decline', needsHuman: true,
    apply: (app, rng, auto) => sim(app, { fraudFlag: true, ...reviewer(auto, rng() < 0.55 ? 'APPROVE' : 'DECLINE', rng) }),
  },
  'four-eyes': {
    name: 'four-eyes', title: 'Large loan (four-eyes)', expected: 'Needs two different approvers, then FUNDED', needsHuman: true,
    apply: (app, rng, auto) => {
      app.productType = 'PERSONAL';
      app.documents = [...REQUIRED_DOCS.PERSONAL];
      app.vehicle = undefined;
      app.debtsToConsolidate = undefined;
      app.amount = between(rng, 36_000, 48_000, 1000);
      app.applicant.annualIncome = 190_000;
      sim(app, reviewer(auto, 'APPROVE', rng));
    },
  },
  'provider-blip': {
    name: 'provider-blip', title: 'Credit bureau down ~20s', expected: 'Parks in AWAITING_PROVIDER, retries, recovers, FUNDED',
    apply: (app, _rng, _auto, now) => sim(app, { outage: 'credit', outageUntil: new Date(now + 20_000).toISOString() }),
  },
  outage: {
    name: 'outage', title: 'Identity provider down (long)', expected: 'Parks, retries until the outage budget is spent, then HUMAN_REVIEW', needsHuman: true,
    apply: (app, rng, auto) => sim(app, { outage: 'identity', ...reviewer(auto, 'APPROVE', rng) }),
  },
  'banking-blip': {
    name: 'banking-blip', title: 'Core banking down ~15s', expected: 'Disbursement retries through the outage, then FUNDED',
    apply: (app, _rng, _auto, now) => sim(app, { bankingDownUntil: new Date(now + 15_000).toISOString() }),
  },
  'identity-not-found': {
    name: 'identity-not-found', title: 'Identity not found', expected: 'Non-retryable, straight to HUMAN_REVIEW', needsHuman: true,
    apply: (app, rng, auto) => sim(app, { identityNotFound: true, ...reviewer(auto, 'DECLINE', rng) }),
  },
  'request-info': {
    name: 'request-info', title: 'Reviewer requests info', expected: 'Review asks for a bank statement, then re-underwrites', needsHuman: true,
    apply: (app, rng, auto) => sim(app, {
      fraudFlag: true,
      ...reviewer(auto, 'REQUEST_INFO', rng),
      ...(auto ? { applicant: { uploadsDocsAfterMs: between(rng, 1500, 5000) } } : {}),
    }),
  },
  esign: {
    name: 'esign', title: 'Waits for signature', expected: 'AWAITING_SIGNATURE until signed', needsHuman: true,
    apply: (app, rng, auto) => sim(app, { applicant: auto ? { signs: 'auto', signDelayMs: between(rng, 2000, 8000) } : { signs: 'manual' } }),
  },
  'offer-lapse': {
    name: 'offer-lapse', title: 'Never signs', expected: 'Reminder, then DECLINED (offer lapsed)',
    apply: (app) => sim(app, { applicant: { signs: 'manual' } }),
  },
  withdraw: {
    name: 'withdraw', title: 'Applicant withdraws', expected: 'Asked for docs, withdraws, DECLINED (withdrawn)',
    apply: (app) => {
      app.documents = app.documents.filter((d) => d !== 'PAYSTUB');
      sim(app, { applicant: { withdrawsAfterMs: 2500 } });
    },
  },
  'payout-reject': {
    name: 'payout-reject', title: 'Payout rejected', expected: 'ESCALATED with the bank\'s reason',
    apply: (app) => sim(app, { payoutRejected: true }),
  },
  'sanctions-hit': {
    name: 'sanctions-hit', title: 'Sanctions potential match', expected: 'Signed, then the pre-payout screen matches: ESCALATED to compliance',
    apply: (app) => sim(app, { sanctionsHit: true }),
  },
  // ---- SLA pressure: applications waiting on a person, on a short SLA clock, for the SLA watch board ----
  'sla-breach-review': {
    name: 'sla-breach-review', title: 'SLA breach: review nobody picks up', expected: 'In review, unclaimed; breaches the SLA after about 40s and stays breached',
    apply: (app) => sim(app, { fraudFlag: true }),
    timing: { ...HOLD, overallSla: '40s', slaAtRiskAfter: '20s' },
  },
  'sla-breach-docs': {
    name: 'sla-breach-docs', title: 'SLA breach: applicant never sends documents', expected: 'Waiting on documents; breaches the SLA after about 40s',
    apply: (app) => { app.documents = app.documents.filter((d) => d !== 'PAYSTUB'); },
    timing: { ...HOLD, overallSla: '40s', slaAtRiskAfter: '20s' },
  },
  'sla-breach-signature': {
    name: 'sla-breach-signature', title: 'SLA breach: agreement never signed', expected: 'Approved, waiting on the signature; breaches the SLA after about 40s',
    apply: (app) => sim(app, { applicant: { signs: 'manual' } }),
    timing: { ...HOLD, overallSla: '40s', slaAtRiskAfter: '20s' },
  },
  'sla-at-risk-review': {
    name: 'sla-at-risk-review', title: 'SLA at risk: review waiting', expected: 'In review; flagged at risk after about 20s, breaches only after 5 minutes',
    apply: (app) => sim(app, { fraudFlag: true }),
    timing: { ...HOLD, overallSla: '5m', slaAtRiskAfter: '20s' },
  },
  'sla-at-risk-docs': {
    name: 'sla-at-risk-docs', title: 'SLA at risk: documents outstanding', expected: 'Waiting on documents; flagged at risk after about 20s',
    apply: (app) => { app.documents = app.documents.filter((d) => d !== 'GOV_ID'); },
    timing: { ...HOLD, overallSla: '5m', slaAtRiskAfter: '20s' },
  },
  'sla-stale-review': {
    name: 'sla-stale-review', title: 'SLA watch: review going stale', expected: 'In review with plenty of SLA left; shows as stale after 45s of no activity',
    apply: (app) => sim(app, { fraudFlag: true }),
    timing: { ...HOLD, overallSla: '15m', slaAtRiskAfter: '12m' },
  },
  'rules-error': {
    name: 'rules-error', title: 'Bad rules deploy', expected: 'Underwriting child fails, ESCALATED as a system failure',
    apply: (app) => sim(app, { rulesEngineError: true }),
  },
  'under-18': {
    name: 'under-18', title: 'Applicant under 18', expected: 'DECLINED at validation',
    apply: (app) => { app.applicant.dateOfBirth = '2011-04-02'; },
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

export const MIXES: Record<string, Record<string, number>> = {
  realistic: {
    happy: 36, 'auto-happy': 4, 'debtcon-happy': 4, flaky: 8, 'provider-blip': 2, 'banking-blip': 1, withdraw: 1, 'missing-docs': 12, abandon: 3, 'low-credit': 8, fraud: 6, 'four-eyes': 4, outage: 2,
    'identity-not-found': 2, 'request-info': 3, esign: 3, 'offer-lapse': 2, 'payout-reject': 2, 'rules-error': 1,
  },
  stress: {
    happy: 10, flaky: 12, 'provider-blip': 8, 'banking-blip': 5, withdraw: 3, 'missing-docs': 10, abandon: 8, 'low-credit': 8, fraud: 10, 'four-eyes': 5, outage: 8,
    'identity-not-found': 5, 'request-info': 5, 'offer-lapse': 5, 'payout-reject': 3, 'rules-error': 3,
  },
  happy: { happy: 90, flaky: 10 },
};

/**
 * Scenario packs: a fixed list of scenarios started together, one per path, so a single click shows the
 * whole system. Items marked autoResolve:false are left for you to drive (review queue, signature).
 */
export interface PackItem { scenario: string; autoResolve?: boolean; product?: ProductType; channel?: Channel; duplicateOf?: number; note?: string }

export const PACKS: Record<string, { title: string; description: string; items: PackItem[] }> = {
  'sla-pressure': {
    title: 'SLA pressure (10 scenarios)',
    description: 'Fills the SLA watch board in about a minute: three applications that breach (a review, documents, a signature), three flagged at risk, two going stale, and two that fund normally for contrast. Nothing auto-resolves.',
    items: [
      { scenario: 'sla-breach-review', autoResolve: false, product: 'PERSONAL', note: 'Breaches: review nobody picks up' },
      { scenario: 'sla-breach-docs', autoResolve: false, channel: 'BROKER_EMAIL', note: 'Breaches: documents never arrive' },
      { scenario: 'sla-breach-signature', autoResolve: false, note: 'Breaches: never signed' },
      { scenario: 'sla-at-risk-review', autoResolve: false, product: 'AUTO', note: 'At risk: review waiting' },
      { scenario: 'sla-at-risk-review', autoResolve: false, product: 'DEBT_CONSOLIDATION', note: 'At risk: review waiting' },
      { scenario: 'sla-at-risk-docs', autoResolve: false, note: 'At risk: documents outstanding' },
      { scenario: 'sla-stale-review', autoResolve: false, note: 'Stale: review with time left' },
      { scenario: 'sla-stale-review', autoResolve: false, product: 'AUTO', note: 'Stale: review with time left' },
      { scenario: 'happy', note: 'Funds normally' },
      { scenario: 'auto-happy', note: 'Funds normally' },
    ],
  },
  showcase: {
    title: 'Showcase: every path (20 scenarios)',
    description: 'One application per path: happy paths for all three products and channels, retries, provider and core-banking downtime, missing docs, declines, review (some left for you), e-sign, withdrawal, escalations and a duplicate delivery.',
    items: [
      { scenario: 'happy', product: 'PERSONAL', channel: 'PORTAL', note: 'Portal personal loan' },
      { scenario: 'auto-happy', channel: 'BROKER_EMAIL', note: 'Broker auto loan' },
      { scenario: 'debtcon-happy', channel: 'AGGREGATOR', note: 'Aggregator debt consolidation' },
      { scenario: 'flaky', note: '429 then resets, retried' },
      { scenario: 'provider-blip', note: 'Credit bureau down, parks and recovers' },
      { scenario: 'outage', note: 'Identity down past the outage budget, then review' },
      { scenario: 'banking-blip', note: 'Core banking down, payout waits it out' },
      { scenario: 'identity-not-found', note: 'Permanent provider answer, straight to review' },
      { scenario: 'missing-docs', note: 'Docs requested, applicant uploads' },
      { scenario: 'abandon', note: 'Applicant never uploads' },
      { scenario: 'withdraw', note: 'Applicant withdraws while asked for docs' },
      { scenario: 'low-credit', note: 'Declined by product rules' },
      { scenario: 'under-18', note: 'Declined at validation' },
      { scenario: 'request-info', note: 'Reviewer asks for a bank statement' },
      { scenario: 'fraud', autoResolve: false, note: 'Left in the review queue for you' },
      { scenario: 'four-eyes', autoResolve: false, note: 'Needs two of you to approve' },
      { scenario: 'esign', autoResolve: false, note: 'Waits for you to sign' },
      { scenario: 'offer-lapse', note: 'Never signs, offer lapses' },
      { scenario: 'payout-reject', note: 'Core banking rejects the payout' },
      { scenario: 'rules-error', note: 'Bad rules deploy, child fails' },
      { scenario: 'happy', duplicateOf: 0, note: 'Same portal submission delivered again: absorbed' },
    ],
  },
};

export function pickWeighted(rng: Rng, weights: Record<string, number>): string {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const [k, w] of Object.entries(weights)) { if ((r -= w) < 0) return k; }
  return Object.keys(weights)[0];
}

export function buildScenario(name: string, opts: { ref: string; rng?: Rng; autoResolve?: boolean; channel?: Channel; product?: ProductType; now?: number }): LoanApplication {
  const profile = SCENARIOS[name];
  if (!profile) throw new Error(`Unknown scenario "${name}". Known: ${SCENARIO_NAMES.join(', ')}`);
  const rng = opts.rng ?? Math.random;
  const app = baseApplication(rng, { ref: opts.ref, channel: opts.channel, product: opts.product });
  profile.apply(app, rng, opts.autoResolve ?? false, opts.now ?? Date.now());
  app.scenario = name;
  return app;
}
