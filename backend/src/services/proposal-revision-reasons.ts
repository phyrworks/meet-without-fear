/**
 * `proposal_revision.reason` — a closed set of app markers (TS-13 fix round 2,
 * ruling R47).
 *
 * `reason` is plaintext: controllers/stage4.ts filters revisions by it (the
 * legacy agreement markers), which a random-IV cipher cannot serve. So it may
 * hold only these fixed strings, never user- or model-derived text. Text that
 * explains a revision (the participant's chat turn, a removal reason, the
 * coach's proposal text) goes into the revision's encrypted `after` (or
 * `before`) envelope instead (lib/prisma-encryption-middleware.ts,
 * proposal_revision.before/after, R46).
 *
 * Every writer passes a member (lib/__tests__/proposal-revision-reason.test.ts
 * checks the source); a raw writer binds `proposalRevisionReason(…)`, which
 * refuses anything else at run time.
 */

export const PROPOSAL_REVISION_REASONS = {
  /** controllers/stage4.ts legacy agreement flow: a participant proposed the proposal as an agreement. */
  LEGACY_PROPOSED: 'Proposed as an agreement',
  /** controllers/stage4.ts legacy agreement flow: the partner confirmed it. */
  LEGACY_CONFIRMED: 'Confirmed as an agreement',
  /** stage4-store insertAgreementsTx default: converted at the mutual-willingness closure. */
  MUTUAL_CLOSURE: 'Mutual Stage 4 willingness closure',
  /** controllers/stage4.ts: converted once every party confirmed. */
  EVERY_PARTY_CONFIRMED: 'Every party confirmed the agreement',
} as const;

export type ProposalRevisionReason = (typeof PROPOSAL_REVISION_REASONS)[keyof typeof PROPOSAL_REVISION_REASONS];

const ALLOWED = new Set<string>(Object.values(PROPOSAL_REVISION_REASONS));

/** The value to store in `proposal_revision.reason`: a member of the set, or null. Throws on anything else. */
export function proposalRevisionReason(reason: string | null | undefined): ProposalRevisionReason | null {
  if (reason == null) return null;
  if (!ALLOWED.has(reason)) {
    throw new Error('[proposal_revision.reason] not an app marker; free text belongs in the encrypted after envelope');
  }
  return reason as ProposalRevisionReason;
}
