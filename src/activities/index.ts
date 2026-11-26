import { createProviderActivities } from './providers';
import { createCoreActivities, type ActivityDeps } from './core';
import { ProviderHealth } from './providerHealth';

export function createActivities(deps: ActivityDeps) {
  const health = deps.health ?? new ProviderHealth();
  return { ...createProviderActivities(health), ...createCoreActivities({ ...deps, health }) };
}

export type Activities = ReturnType<typeof createActivities>;
export type { ActivityDeps };
export { AuditStore } from './auditStore';
export { ProviderHealth } from './providerHealth';
export { BillingStore } from '../billing/store';
