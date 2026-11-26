/**
 * The parent workflow's external API. Every interactive input targets the parent, never a child, so
 * callers (UI, webhooks, CLI) only ever need the application's workflow ID.
 */
import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type {
  AgreementSigned, ClaimRequest, DocumentsUploaded, RetryProvidersNow, ReviewAck, ReviewClaim, ReviewDecision, StatusView, Withdrawal,
} from '../shared/types';

/** Applicant uploaded documents (portal or broker reply). Fire-and-forget. */
export const documentsUploadedSignal = defineSignal<[DocumentsUploaded]>('documentsUploaded');

/** E-sign provider webhook. Fire-and-forget: the provider can't act on a rejection. */
export const agreementSignedSignal = defineSignal<[AgreementSigned]>('agreementSigned');

/** Applicant withdraws. Honoured at the next wait or stage boundary, never once payout has started. */
export const withdrawSignal = defineSignal<[Withdrawal]>('withdraw');

/** Operator: a provider is back, re-try the failed checks now instead of waiting for the next scheduled retry. */
export const retryProvidersNowSignal = defineSignal<[RetryProvidersNow]>('retryProvidersNow');

/** Reviewer decision. An Update so the validator can reject bad input and the reviewer gets an answer. */
export const submitReviewDecisionUpdate = defineUpdate<ReviewAck, [ReviewDecision]>('submitReviewDecision');

/**
 * Reviewer claims a case for a limited time (a lease), renews it, or releases it. While claimed, only
 * the claimant can decide. A lapsed claim returns the case to the queue; the application keeps waiting.
 * Returns the claim (null after a release).
 */
export const claimReviewUpdate = defineUpdate<ReviewClaim | null, [ClaimRequest]>('claimReview');

export const getStatusQuery = defineQuery<StatusView>('getStatus');
