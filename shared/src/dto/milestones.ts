/**
 * Participant milestones — the single source of truth for progress.
 *
 * The target schema stores progress as `participant_milestone` rows keyed by
 * the `milestone` reference table (seeded by the target_shape_baseline
 * migration). These are those keys, in `milestone.ordinal` order; a test in
 * backend pins this list to the migration's seed so the two cannot drift.
 *
 * Scope matters when reading them: a `session`-scoped milestone that gates a
 * stage (empathy_validated, needs_validated, needs_shared, choices_shared,
 * closed) is written for every participant only once it holds for the whole
 * session. `needs_shared` therefore means "everyone has shared", not "I
 * shared" — the caller's own share is `GetNeedsResponse.sharedAt`.
 */
export const MILESTONE_KEYS = [
  'paused',
  'invitation_sent',
  'compact_signed',
  'feel_heard',
  'empathy_submitted',
  'empathy_ready',
  'empathy_validated',
  'needs_confirmed',
  'needs_validated',
  'needs_shared',
  'repair_walkthrough_started',
  'choices_shared',
  'closed',
] as const;

export type MilestoneKey = (typeof MILESTONE_KEYS)[number];

/** Reached milestones of one participant: key → reachedAt (ISO 8601). Absent = not reached. */
export type MilestoneMap = Partial<Record<MilestoneKey, string>>;

/**
 * The PARTNER's visible milestones (`partnerProgress.milestones`): instants,
 * except `invitation_sent`, which is `true` when reached — the old partner
 * gate JSON carried `invitationSent: true` with no instant, and the partner's
 * invitation instant stays unexposed (strict parity, work-keq6). Which keys
 * appear at all is the backend's PARTNER_VISIBLE_MILESTONES.
 */
export type PartnerMilestoneMap = Partial<Record<Exclude<MilestoneKey, 'invitation_sent'>, string>> & {
  invitation_sent?: true;
};

export function isMilestoneKey(value: string): value is MilestoneKey {
  return (MILESTONE_KEYS as readonly string[]).includes(value);
}
