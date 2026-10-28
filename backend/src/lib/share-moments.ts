/**
 * The W13 re-encryption hook (TS-13; ruling R26, R41).
 *
 * The writer-principal rule (spec Conventions "Encryption keys"): content written
 * for the owner's own eyes is under that participant's key; anything delivered
 * to, or readable by, a co-participant is written — or re-encrypted at the
 * share moment — under the session key by the job. Today every key class is
 * the one `FIELD_ENCRYPTION_KEY` (lib/prisma-encryption-middleware.ts), so there
 * is nothing to re-encrypt and `reencryptForSession` does nothing.
 *
 * It is called at every share moment the rule names, inside the transaction
 * that makes the content visible (passed as `client`), with the rows that become
 * readable by the co-participant. It is the single place W13 changes: decrypt
 * each named column under the owner's participant key and write it back under
 * the session key (same plaintext; `mwf_job` is exempt from the immutability
 * triggers for exactly this).
 *
 * | moment                  | caller                                        | rows that become session-readable |
 * |-------------------------|-----------------------------------------------|-----------------------------------|
 * | empathy-reveal          | reconciler/state.ts checkAndRevealBothIfReady | empathy_attempt.content (participant → session); the subject's EMPATHY_STATEMENT message copy, which `app.empathy_set_status` writes with the attempt's ciphertext verbatim |
 * | need-share              | needs-share.ts shareNeeds, controllers/consent.ts | need_share.shared_text (written by the job under the session key from the start) |
 * | share-offer-delivery    | reconciler/sharing.ts deliverAcceptedShare    | context_share_offer.shared_content and its SHARED_CONTEXT message copy |
 * | checkin-shared-submit   | tending.service.ts insertCheckin (SHARED scope) | follow_up_checkin.payload / reflection_summary, and the follow_up_note rows copied into it |
 * | choices-shared          | stage4-store.ts shareChoices                  | proposal_choice.note of the participant |
 */

export type ShareMoment =
  | 'empathy-reveal'
  | 'need-share'
  | 'share-offer-delivery'
  | 'checkin-shared-submit'
  | 'choices-shared';

/** A row whose encrypted columns become readable by the co-participant at the moment. */
export interface SharedRow {
  table: string;
  /** The row's key value — of `by`, `id` by default (proposal_choice: every choice of a participant). */
  id: string;
  by?: string;
  /** Narrows the rows `by` selects (e.g. the subject's copy among a source attempt's messages). */
  scope?: string;
}

export interface ShareMomentEvent {
  moment: ShareMoment;
  sessionId: string | null;
  rows: SharedRow[];
}

/**
 * Re-encrypt the rows of a share moment under the session key. A no-op under
 * the single key (W13 prerequisite): the ciphertext is already readable by
 * every participant. `client` is the transaction the moment runs in (the
 * job's, or the participant's own for a check-in or a choices share), so W13's
 * re-encryption commits with the share.
 */
export async function reencryptForSession(_event: ShareMomentEvent, _client?: unknown): Promise<void> {
  // Single key: nothing to re-encrypt. W13: for each row, decrypt its
  // participant-keyed columns and write them back under the session key of
  // `sessionId`, through `_client`.
}
