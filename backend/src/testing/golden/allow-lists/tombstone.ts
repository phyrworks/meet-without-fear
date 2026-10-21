/**
 * Allow-list and known deviations for `tombstone` (golden R5).
 *
 * Plan §4 R5: account deletion leaves delivered messages, revealed attempts,
 * `need_share` and agreements readable to the partner; private rows gone;
 * `participant.display_name` NULL; `brain_activity` for the leaver gone; live
 * session ABANDONED. Spec §4 `app.anonymize_user_account` (the complete walk).
 */

import type { KnownLeak } from '../privacy';
import { deliveredStatementCopy, READ_DTO_RULES } from './common';
import type { AllowList } from './types';

/**
 * Step layout (the scenario asserts it): 30 reads before (the full read minus
 * `strategies`, which shuffles), the deletion at index 30, 30 reads after.
 * Rules that only the post-deletion state may trigger are pinned to those
 * indices, never to `steps.*`.
 */
export const TOMBSTONE_DELETION_STEP = 30;
const AFTER_STEPS = Array.from({ length: TOMBSTONE_DELETION_STEP }, (_, i) => TOMBSTONE_DELETION_STEP + 1 + i);
const after = (suffix: string): string[] => AFTER_STEPS.map(i => `steps.${i}.${suffix}`);

export const TOMBSTONE_ALLOW: AllowList = {
  scenario: 'tombstone',
  rules: [
    ...READ_DTO_RULES,
    // Both attempts were revealed in the fixture: the migration inserts their
    // delivered copies into the restored state (plan step 9).
    deliveredStatementCopy('ada', 'bob', 'initial'),
    deliveredStatementCopy('bob', 'ada', 'initial'),
    // Today the views cannot represent anything from the deletion on (known
    // deviation): those steps record `unrepresentable` instead of `changes`.
    // On the target the state is representable — `unrepresentable` goes and
    // `changes` appears (unasserted against this baseline: there is nothing to
    // compare it with). The scenario's rule check "the concept views represent
    // the state after the deletion" is what requires the key to go.
    {
      kind: 'mayBeAbsent',
      at: [`steps.${TOMBSTONE_DELETION_STEP}`, ...after('').map(p => p.replace(/\.$/, ''))],
      keys: ['unrepresentable'],
      mustMatch: true,
      why: 'spec §4 anonymize walk: the target leaves a state the views represent (tombstoned user and participant).',
    },
    {
      kind: 'addedKeys',
      at: [`steps.${TOMBSTONE_DELETION_STEP}`, ...after('').map(p => p.replace(/\.$/, ''))],
      keys: ['changes'],
      mustMatch: true,
      why: 'the concept changes exist on the target where today the state is unrepresentable (see above).',
    },
    // What fixing each known deviation changes in Bob's post-deletion reads.
    {
      kind: 'mayDiffer',
      at: [`steps.${TOMBSTONE_DELETION_STEP}.body.data.summary`],
      mustMatch: true,
      why: 'spec §4: the deletion is app.anonymize_user_account; its counts are not today’s cascade counts.',
    },
    {
      kind: 'mayDiffer',
      at: [...after('body.data.attempt'), ...after('body.data.partnerStatus')],
      mustMatch: true,
      why: 'spec §7: the revealed attempt stays readable to its subject after its author leaves (deviation: empathy/partner).',
    },
    {
      kind: 'mayDiffer',
      at: [...after('body.data.partnerNeeds'), ...after('body.data.myNeeds'), ...after('body.data.analysisComplete')],
      mustMatch: true,
      why: 'spec §4 walk: need_share survives the leaver (deviation: needs comparison is empty today).',
    },
    {
      kind: 'mayDiffer',
      at: [...after('body.data.**.partner.name'), ...after('body.data.**.partner.nickname')],
      mustMatch: true,
      why: 'spec §7 v_participant: the leaver’s display_name is NULL; the partner sees the fallback, not the name.',
    },
  ],
};

const dev = (at: string, finding: string, evidence: string): KnownLeak => ({ at, finding, evidence });
const AFTER = "Bob's reads after the deletion ✗";

/** Rules of the walk today's deletion breaks. `at` = `tombstone ⊃ <rule>` or `<scope> ✗ ⊃ <probe>`. */
export const TOMBSTONE_KNOWN_DEVIATIONS: KnownLeak[] = [
  dev(
    `${AFTER} ⊃ Ada's revealed statement`,
    'R5: after account deletion the partner can no longer read the leaver’s revealed empathy statement',
    'GET empathy/partner as Bob → {attempt: null, partnerStatus: null}: the leaver’s EmpathyAttempt survives with ' +
      'sourceUserId SET NULL (schema onDelete) and the read looks it up by the partner’s user id, which is gone ' +
      '(RelationshipMember cascaded). Spec §7: the revealed row stays in the subject’s SELECT arm forever.',
  ),
  dev(
    'tombstone ⊃ revealed attempt keeps its author (the tombstone)',
    'R5: account deletion SET NULLs EmpathyAttempt.sourceUserId, so a revealed attempt loses its author',
    'after DELETE /auth/me the leaver’s attempt row has sourceUserId NULL (prisma schema EmpathyAttempt.sourceUser ' +
      'onDelete: SetNull); the target keeps author_participant_id → the tombstoned participant.',
  ),
  ...[1, 2].map(i =>
    dev(
      `${AFTER} ⊃ Ada's shared need ${i}`,
      'R5: after account deletion the partner can no longer read the leaver’s shared needs',
      'GET needs/comparison as Bob → empty: the leaver’s IdentifiedNeed rows cascade with her UserVessel, shared or ' +
        'not (and today no shared text exists to keep — F2). Spec §4 walk: need_share survives; shared needs keep their row.',
    ),
  ),
  dev(
    'tombstone ⊃ shared needs survive',
    'R5: account deletion hard-deletes the leaver’s shared needs (UserVessel → IdentifiedNeed cascade)',
    'after DELETE /auth/me no IdentifiedNeed row of Ada’s remains though both were shared (GRANTED IDENTIFIED_NEED ' +
      'consents, also cascaded with the user).',
  ),
  dev(
    "tombstone ⊃ leaver's own conversation is gone",
    'R5: account deletion leaves the leaver’s private chat messages in the database',
    'Message.forUserId is text with no FK, so Ada’s own conversation (her USER lines and the AI replies to her) ' +
      'survives User deletion; plan §3 step 4a deletes such rows only at migration time. Spec §4 walk step 3 deletes ' +
      'the participant’s conversation.',
  ),
  dev(
    "tombstone ⊃ leaver's brain_activity is gone",
    'R5: account deletion leaves the leaver’s session-turn BrainActivity (full prompt in input)',
    'the reflection-scoped capture cascades with InnerWorkSession, but the session-scoped capture of Ada’s turn has ' +
      'no user link (sessionId only) and survives with her private lines in input. Spec §4 walk step 4 deletes by ' +
      'participant_id — which plan §3 step 18 leaves NULL for every migrated row (finding F6).',
  ),
  dev(
    "tombstone ⊃ the partner no longer reads the leaver's name",
    'R5: after account deletion the partner still reads the leaver’s name (RelationshipMember.nickname)',
    'GET sessions/:id, sessions/:id/state and the session list as Bob carry partner {id: "", name: "Ada Lovelace", ' +
      'nickname: "Ada Lovelace"}: Bob’s own member row keeps the nickname. Spec §7: display_name NULL, the partner UI ' +
      'falls back to "Former participant".',
  ),
  dev(
    'tombstone ⊃ user row is tombstoned, not deleted',
    'R5: account deletion hard-deletes the User row (target: scrub to a tombstone, never delete)',
    'services/account-deletion.ts prisma.user.delete; spec §4 walk step 6 scrubs clerk_id/email/names and sets ' +
      'deleted_at; §7 "a user row is never hard-deleted" (FK RESTRICT).',
  ),
  dev(
    'tombstone ⊃ the concept views represent the state after the deletion',
    'R5/plan §3 step 4a+11: the state today’s account deletion leaves cannot be migrated — the leaver’s attempt has no author',
    'from the deletion on, old_concept_empathy_attempt RAISEs (its subject subquery finds two participants for an ' +
      'attempt whose sourceUserId is NULL); step 4a’s vanished-member evidence does not include EmpathyAttempt and step 11 ' +
      'would RAISE (author NOT NULL). Recorded as `unrepresentable` in the concept baseline.',
  ),
];
