/**
 * Replay tests: the safety net for changing workflow code while applications are in flight.
 *
 * The fixtures are real histories recorded from the parent workflow *before* the sanctions screen was
 * added. Replaying them against today's code must not raise a non-determinism error. That only holds
 * because the new step is gated with patched('sanctions-screen-before-disbursement'). Remove the guard
 * and these tests fail, which is exactly the failure a deploy would hit on every in-flight application.
 *
 * In CI this would replay a rolling sample of recent production histories on every change.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Worker } from '@temporalio/worker';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils';
import { workflowBundle } from '../src/workers/createWorkers';

// Child workflow IDs derive from the parent's ID, so a replay must use the recorded workflow ID.
const workflowIds = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'index.json'), 'utf8')) as Record<string, string>;
const fixture = (name: string) => historyFromJSON(JSON.parse(readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8')));

describe('versioning: replay of pre-patch histories', () => {
  for (const name of ['pre-patch-funded', 'pre-patch-four-eyes']) {
    it(`${name} replays cleanly against the current workflow code`, async () => {
      const history = fixture(name);
      // The recorded run never scheduled the screening activity...
      const activities = history.events!.filter((e) => e.activityTaskScheduledEventAttributes).map((e) => e.activityTaskScheduledEventAttributes!.activityType!.name);
      expect(activities).not.toContain('screenSanctions');
      expect(activities).toContain('sendEnvelope');
      // ...and still replays without a determinism violation.
      await expect(Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, history, workflowIds[name])).resolves.toBeUndefined();
    }, 60_000);
  }
});
