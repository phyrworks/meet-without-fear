/**
 * work-k5fk.2 (design note §2, §7 row 5): `relationship` and
 * `relationship_member` are dropped. Every baseline was recorded on the
 * current shape (R39) and is never re-recorded on the target (the runner
 * refuses it); what the drop changes is carried here, one paragraph per
 * baseline, as the README's "never in bulk, every accepted change needs a
 * written reason" requires.
 *
 * What moves, in every baseline alike:
 *   - the session DTOs lose `relationshipId` — GET /sessions/:id and
 *     GET /sessions/:id/state (`data.session`), GET /sessions
 *     (`data.items.*`), GET /people (`data.people.*`). It named a row that no
 *     longer exists; mobile never read it (design note §2: 0 reads). The rule
 *     is `absentKeys`, so a run that still carried it would fail, and
 *     `mustMatch` keeps it from going vacuous where the baseline has the key.
 *   - the partner's nickname moves from relationship_member to the caller's
 *     own user_contact row: the trace relation map sends RelationshipMember to
 *     user_contact (common.ts TARGET_RELATION_MAP; session-read's own map),
 *     and Relationship to nothing. The fixture writer copies the old members'
 *     nicknames into user_contact one for one, so every partner.name /
 *     partner.nickname value is unchanged — no rule admits a change there, so
 *     a moved name fails the run.
 *   - the concept view `old_concept_session` has no `relationship_id` any
 *     more (review round 1, F5: a synthesised id compared equal whatever it
 *     was, because the labeller mapped it to <relationship:main>, so it
 *     asserted nothing). RELATIONSHIP_ID_CONCEPT_RULE compares the restored
 *     session row's relationship_id as absent, in every concept allow-list
 *     (empathy-reveal's included); concept-views.target.test names the column in
 *     DROPPED_COLUMNS.
 *   - participant rows gain `added_by_user_id`; the concept participant view
 *     does not project it, and no scenario step writes a participant, so no
 *     baseline sees it.
 *
 * Anything else that moves in a golden on this branch is a bug, not an
 * allowance (measured on the first run: every failure was one of the
 * relationshipId paths below, or session-read's trace touching user_contact).
 */

import type { AbsentKeysRule } from './types';

/**
 * Concept allow-lists only: the restored session row (`initial.session.*`)
 * has no relationship_id on the target (the view dropped it). Every recorded
 * concept baseline holds exactly one such value, there; no recorded step
 * changes a session row.
 */
export const RELATIONSHIP_ID_CONCEPT_RULE: AbsentKeysRule = {
  kind: 'absentKeys',
  at: 'initial.session.*',
  keys: ['relationship_id'],
  mustMatch: true,
  why:
    'work-k5fk.2: old_concept_session.relationship_id named the relationship row, which the target no longer has; ' +
    'the view drops the column and the restored session row is compared without it (relationship-dropped.ts).',
};

/** Where a DTO carried relationshipId (the four reads listed above). */
export const RELATIONSHIP_ID_AT = [
  'steps.*.body.data.session',
  'steps.*.body.data.items.*',
  'steps.*.body.data.people.*',
];

/**
 * Per baseline: what the drop changes in it, measured on the first target
 * run of this branch (paths missing their relationshipId, per baseline, in
 * the concept and byte-level comparisons alike).
 */
export const RELATIONSHIP_DROPPED_WHY = {
  'session-read':
    'session-read (FEEL_HEARD_B, scoped to three tables): its two "session state" reads (Ada, Bob) carried ' +
    'data.session.relationshipId = <relationship:main>; on the target it is absent. Its byte-level trace read ' +
    'RelationshipMember for the nickname each reader gave the other; the target reads the reader’s own ' +
    'user_contact row instead (relation map RelationshipMember → user_contact). Partner names and nicknames are ' +
    'byte-identical (the fixture copies the member nicknames into user_contact). Nothing else moves: its scope ' +
    'never held a relationship table.',
  'empathy-reveal':
    'empathy-reveal (FEEL_HEARD_B, whole-database scope): reads no session DTO, so no body moves; the restored ' +
    'session row’s relationship_id is gone from old_concept_session (RELATIONSHIP_ID_CONCEPT_RULE, its one rule ' +
    'here), and no step wrote Relationship or RelationshipMember.',
  'reflection-never-crosses':
    'reflection-never-crosses (INNER_WORK_LINKED_A): its full reads before and after Ada’s turn — session, state, ' +
    'session list and people, for each reader — carried relationshipId (8 paths); all absent on the target. ' +
    'The people list is now derived from shared sessions (participant) with the caller’s user_contact ' +
    'nickname: same ids, names, initials and session summaries. The privacy probes are unaffected.',
  'unrevealed-attempt-hidden':
    'unrevealed-attempt-hidden (RECONCILER_SHOWN_B): the session, state and session-list reads at the four phases ' +
    '(awaiting sharing, refining, ready, revealed; two readers at the first and last) carried relationshipId ' +
    '(18 paths); all absent on the target. No attempt, status or reveal value moves.',
  'reveal-all-ready-ada-first':
    'reveal-all-ready-ada-first (FEEL_HEARD_B): the session, state and session-list reads of both readers after ' +
    'Ada is READY and after the reveal carried relationshipId (12 paths); all absent on the target. The reveal ' +
    'itself, its delivered copies and its instants are unchanged.',
  'reveal-all-ready-bob-first':
    'reveal-all-ready-bob-first (RECONCILER_SHOWN_B): as the Ada-first order — the session, state and session-list ' +
    'reads of both readers after Bob is READY and after the reveal carried relationshipId (12 paths); all absent ' +
    'on the target, nothing else moves.',
  'needs-hidden-until-shared':
    'needs-hidden-until-shared (NEEDS_CONFIRMED): the session, state and session-list reads at nothing shared, ' +
    'Bob shared and both shared (both readers at the last) carried relationshipId (12 paths); all absent on the ' +
    'target. Need labels, evidence and their visibility are unchanged.',
  'choices-hidden-until-shared':
    'choices-hidden-until-shared (STAGE4_REDESIGN_PARTNER_INACTIVE): Ada’s session, state and session-list reads ' +
    'before Bob chooses, after he chose and after he shared carried relationshipId (9 paths); all absent on the ' +
    'target. The choices and their visibility are unchanged.',
  tombstone:
    'tombstone (TOMBSTONE_READY): the session, state, session-list and people reads before the deletion and the ' +
    'session, state and session-list reads after it carried relationshipId (7 paths; the after-deletion people ' +
    'list was already empty — a tombstone is not a person); all absent on the target. The walk (step 30, pinned ' +
    'by its own mayDiffer) removed Ada’s RelationshipMember row — her nickname for Bob — on the current shape; ' +
    'on the target app.anonymize_user_account deletes her own user_contact rows, the same fact, asserted row by ' +
    'row by the scenario ("the leaver’s own user_contact entries are gone"; Bob’s entry for her is his own and ' +
    'stays).',
  'author-sees-status-only':
    'author-sees-status-only (RECONCILER_SHOWN_B): the author’s session, state, session-list and people reads ' +
    'carried relationshipId (4 paths); all absent on the target. No status or analysis value moves.',
  'declined-offer-no-trace':
    'declined-offer-no-trace (RECONCILER_SHOWN_B): the author’s session, state, session-list and people reads ' +
    'before and after the decline carried relationshipId (8 paths); all absent on the target, so the "reads ' +
    'unchanged by the decline" comparison still holds between the two phases.',
} as const;

export type RelationshipDroppedScenario = keyof typeof RELATIONSHIP_DROPPED_WHY;

/** The one rule a baseline whose DTOs carried relationshipId gets (see the module comment). */
export function relationshipIdDropped(
  scenario: Exclude<RelationshipDroppedScenario, 'empathy-reveal'>,
): AbsentKeysRule {
  return {
    kind: 'absentKeys',
    at: RELATIONSHIP_ID_AT,
    keys: ['relationshipId'],
    mustMatch: true,
    why: `work-k5fk.2 (relationship dropped): ${RELATIONSHIP_DROPPED_WHY[scenario]}`,
  };
}
