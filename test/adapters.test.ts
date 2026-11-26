import { describe, expect, it } from 'vitest';
import { fromBrokerEmail, fromPortal } from '../src/ingest/adapters';
import { sampleBrokerEmail, samplePortalSubmission } from '../src/ingest/samples';
import { buildScenario, seededRng } from '../src/ingest/scenarios';

describe('channel adapters', () => {
  it('normalizes a broker email leniently and classifies attachments', () => {
    const app = fromBrokerEmail(sampleBrokerEmail('<abc.123@brokers.example>'));
    expect(app).toMatchObject({ channel: 'BROKER_EMAIL', productType: 'AUTO', amount: 24_000, termMonths: 60, externalRef: 'abc.123_brokers.example', brokerId: 'deals@northbrokers.example' });
    expect(app.applicant).toMatchObject({ fullName: 'Daniel Wright', annualIncome: 104_000 });
    expect(app.documents.sort()).toEqual(['GOV_ID', 'VEHICLE_PURCHASE_AGREEMENT']); // paystub missing -> surfaces in the workflow
  });

  it('normalizes a portal submission', () => {
    expect(fromPortal(samplePortalSubmission('web-1'))).toMatchObject({ channel: 'PORTAL', productType: 'PERSONAL', externalRef: 'web-1' });
  });

  it('builds the same synthetic application from the same seed', () => {
    const a = buildScenario('fraud', { ref: 'x', rng: seededRng(5), autoResolve: true });
    const b = buildScenario('fraud', { ref: 'x', rng: seededRng(5), autoResolve: true });
    expect(a).toEqual(b);
    expect(a.simulate?.fraudFlag).toBe(true);
    expect(a.simulate?.reviewer).toBeTruthy();
  });
});
