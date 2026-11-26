/**
 * DEMO ONLY: the simulated people and vendors outside the system. Notifications are the world's input:
 * when the workflow emails an applicant or pages a reviewer, the simulated actor may answer later by
 * sending the same signal or update a real person would. Timers are in-process (not durable), which is
 * fine for a demo and keeps all simulation code out of the workflows.
 */
import type { Client } from '@temporalio/client';
import {
  agreementSignedSignal, documentsUploadedSignal, submitReviewDecisionUpdate, withdrawSignal,
} from '../workflows/definitions';
import type { DocumentType, LoanApplication } from '../shared/types';

export type NotificationTemplate =
  | 'DOCS_REQUESTED' | 'DOCS_REMINDER' | 'REVIEW_REQUESTED' | 'AGREEMENT_SENT' | 'SIGNATURE_REMINDER'
  | 'DECISION' | 'SLA_BREACHED' | 'ESCALATED' | 'PROVIDER_OUTAGE' | 'CLAIM_EXPIRING' | 'SLA_AT_RISK';

export interface WorldEvent {
  applicationId: string;
  application: LoanApplication;
  template: NotificationTemplate;
  data: Record<string, unknown>;
}

const SIM_REVIEWERS = ['sim-reviewer-avery', 'sim-reviewer-blake'];

export class SimulatedWorld {
  constructor(private readonly client: Client | undefined) {}

  private later(ms: number, fn: () => Promise<unknown>) {
    const t = setTimeout(() => { fn().catch(() => { /* the case moved on; a real person would see a stale screen */ }); }, ms);
    t.unref?.();
  }

  onNotification(e: WorldEvent): void {
    if (!this.client) return;
    const handle = this.client.workflow.getHandle(e.applicationId);
    const sim = e.application.simulate ?? {};

    switch (e.template) {
      case 'DOCS_REQUESTED': {
        const withdrawAfter = sim.applicant?.withdrawsAfterMs;
        if (withdrawAfter !== undefined) {
          this.later(withdrawAfter, () => handle.signal(withdrawSignal, { reason: 'Found a better rate elsewhere', requestedBy: 'applicant (simulated)' }));
          return;
        }
        const after = sim.applicant?.uploadsDocsAfterMs;
        if (after === undefined) return;
        const documents = (e.data.missing as DocumentType[]) ?? [];
        this.later(after, () => handle.signal(documentsUploadedSignal, { documents, uploadedBy: 'applicant (simulated)' }));
        return;
      }
      case 'AGREEMENT_SENT': {
        if ((sim.applicant?.signs ?? 'auto') !== 'auto') return;
        const envelopeId = e.data.envelopeId as string;
        this.later(sim.applicant?.signDelayMs ?? 300, () =>
          handle.signal(agreementSignedSignal, {
            envelopeId,
            signerName: e.application.applicant.fullName,
            signedAt: new Date().toISOString(),
          }));
        return;
      }
      case 'REVIEW_REQUESTED': {
        if (!sim.reviewer || e.data.returnedToQueue) return;
        const round = (e.data.reviewRound as number) ?? 1;
        // Ask for more information at most once, then decide; otherwise the demo would loop forever.
        const decision = sim.reviewer.decision === 'REQUEST_INFO' && round > 1 ? 'APPROVE' : sim.reviewer.decision;
        const required = Math.max(1, (e.data.approvalsRequired as number) ?? 1);
        const reviewers = decision === 'APPROVE' ? SIM_REVIEWERS.slice(0, required) : SIM_REVIEWERS.slice(0, 1);
        reviewers.forEach((reviewerId, i) =>
          this.later(sim.reviewer!.afterMs + i * 400, () =>
            handle.executeUpdate(submitReviewDecisionUpdate, {
              args: [{
                decision,
                reviewerId,
                reason: decision === 'APPROVE'
                  ? 'Simulated review: risk signals explained by supporting documents'
                  : decision === 'DECLINE'
                    ? 'Simulated review: risk not acceptable for this product'
                    : 'Simulated review: need recent bank statement to verify income',
                requestedDocuments: decision === 'REQUEST_INFO' ? ['BANK_STATEMENT'] : undefined,
              }],
            })));
        return;
      }
      default:
        return;
    }
  }
}
