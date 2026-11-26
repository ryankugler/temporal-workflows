/**
 * Third-party provider activities (mocked). Each runs on its own task queue, rate limited to the vendor's
 * quota, and every call goes through that vendor's circuit breaker (see providerHealth.ts).
 *
 * Error classification is what drives behaviour:
 *  - retryable ApplicationFailure     -> Temporal retries with backoff, bounded by scheduleToCloseTimeout
 *  - 429 with Retry-After             -> retryable with nextRetryDelay, following the provider's hint
 *  - CircuitOpen (non-retryable)      -> fail fast; the parent parks the application and tries later
 *  - non-retryable business errors    -> returned to the workflow at once (SubjectNotFound, InvalidInput)
 * Every call carries an idempotency key (the workflow ID), so a retried call is never billed twice.
 */
import { ApplicationFailure, Context } from '@temporalio/activity';
import type {
  CreditReport, DebtVerification, FraudResult, IdentityResult, LoanApplication, VehicleValuation,
} from '../shared/types';
import type { ProviderHealth } from './providerHealth';

export interface ProviderCall { applicationId: string; application: LoanApplication }

const latency = () => Context.current().sleep(15 + Math.random() * 60);
export const shortHash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);

/** Per-application simulated outage (demo only). With outageUntil it is a blip that recovers. */
function simulatedOutage(app: LoanApplication, provider: 'credit' | 'identity' | 'fraud') {
  const sim = app.simulate;
  if (sim?.outage !== provider) return;
  if (sim.outageUntil && Date.now() >= Date.parse(sim.outageUntil)) return;
  throw ApplicationFailure.retryable(`${provider} provider unavailable (503)`, 'ProviderUnavailable');
}

export function createProviderActivities(health: ProviderHealth) {
  return {
    async fetchCreditReport({ applicationId, application: app }: ProviderCall): Promise<CreditReport> {
      return health.guard('credit-bureau', async () => {
        const { attempt } = Context.current().info;
        simulatedOutage(app, 'credit');
        const failures = app.simulate?.creditFailures ?? 0;
        if (attempt <= failures) {
          if (attempt === 1) {
            throw ApplicationFailure.create({ message: '429 Too Many Requests', type: 'RateLimited', nextRetryDelay: '300ms' });
          }
          throw ApplicationFailure.retryable('upstream connection reset', 'ProviderTransientError');
        }
        await latency();
        return { score: app.simulate?.creditScore ?? 730, delinquencies: 0, bureauRef: `cb-${shortHash(applicationId)}` };
      });
    },

    async verifyIdentity({ applicationId, application: app }: ProviderCall): Promise<IdentityResult> {
      return health.guard('identity', async () => {
        simulatedOutage(app, 'identity');
        if (app.simulate?.identityNotFound) {
          throw ApplicationFailure.nonRetryable('No identity record matches the applicant', 'SubjectNotFound');
        }
        await latency();
        return { verified: true, matchScore: 0.97, providerRef: `idv-${shortHash(applicationId)}` };
      });
    },

    async checkFraud({ application: app }: ProviderCall): Promise<FraudResult> {
      return health.guard('fraud', async () => {
        simulatedOutage(app, 'fraud');
        await latency();
        return app.simulate?.fraudFlag
          ? { riskScore: 0.91, flagged: true, signals: ['DEVICE_VELOCITY', 'EMAIL_AGE_LT_7D'] }
          : { riskScore: 0.04, flagged: false, signals: [] };
      });
    },

    async valueVehicle({ application: app }: ProviderCall): Promise<VehicleValuation> {
      return health.guard('vehicle-valuation', async () => {
        if (!app.vehicle) throw ApplicationFailure.nonRetryable('No vehicle on the application', 'InvalidInput');
        await latency();
        return { vin: app.vehicle.vin, marketValue: app.simulate?.vehicleValue ?? app.vehicle.purchasePrice };
      });
    },

    async verifyDebts({ application: app }: ProviderCall): Promise<DebtVerification> {
      return health.guard('debt-verification', async () => {
        await latency();
        const debts = app.debtsToConsolidate ?? [];
        return { verifiedTotal: debts.reduce((s, d) => s + d.balance, 0), accounts: debts.length };
      });
    },
  };
}
