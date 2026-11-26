/**
 *   npm run review -- <workflowId> claim|extend|release --reviewer alice
 *   npm run review -- <workflowId> approve|decline|request-info --reviewer alice --reason "..." [--docs BANK_STATEMENT] [--request-id r1]
 *
 * --request-id makes a decision safe to retry: Temporal deduplicates updates by ID, so running the same
 * command again (say, after a timeout) returns the first result instead of recording a second decision.
 */
import { randomUUID } from 'node:crypto';
import { claimReviewUpdate, submitReviewDecisionUpdate } from '../workflows/definitions';
import type { ClaimRequest, DocumentType, ReviewDecision } from '../shared/types';
import { connectClient, fail, parseArgs, run } from './common';

const DECISIONS: Record<string, ReviewDecision['decision']> = { approve: 'APPROVE', decline: 'DECLINE', 'request-info': 'REQUEST_INFO' };
const CLAIMS: Record<string, ClaimRequest['action']> = { claim: 'claim', extend: 'extend', release: 'release' };

run(async () => {
  const { positional: [workflowId, d], flags } = parseArgs();
  const decision = DECISIONS[d ?? ''];
  const claimAction = CLAIMS[d ?? ''];
  if (!workflowId || (!decision && !claimAction)) {
    fail('usage: npm run review -- <workflowId> claim|extend|release|approve|decline|request-info --reviewer <id> [--reason "<why>"]');
  }
  const client = await connectClient();
  const handle = client.workflow.getHandle(workflowId);
  const reviewerId = String(flags.reviewer ?? 'cli-reviewer');
  const updateId = String(flags['request-id'] ?? randomUUID());
  try {
    if (claimAction) {
      const claim = await handle.executeUpdate(claimReviewUpdate, { args: [{ reviewerId, action: claimAction }], updateId: `claim-${updateId}` });
      console.log(claim ? `Claimed by ${claim.reviewerId} until ${claim.expiresAt}` : 'Claim released; the case is back in the queue');
      return;
    }
    const ack = await handle.executeUpdate(submitReviewDecisionUpdate, {
      args: [{
        decision,
        reviewerId,
        reason: String(flags.reason ?? ''),
        requestedDocuments: flags.docs ? (String(flags.docs).split(',') as DocumentType[]) : undefined,
      }],
      updateId: `decision-${updateId}`,
    });
    console.log(`Accepted: ${ack.approvalsReceived}/${ack.approvalsRequired} approvals, status ${ack.status} (request ${updateId})`);
  } catch (e) {
    fail(`Rejected: ${(e as Error).cause ? ((e as Error).cause as Error).message : (e as Error).message}`);
  }
});
