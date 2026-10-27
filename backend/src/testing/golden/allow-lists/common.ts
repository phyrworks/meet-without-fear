/**
 * Allow-list rules every TS-5 privacy scenario carries, because each one
 * reads DTOs the target changes for reasons unrelated to the scenario.
 *
 * They restate `session-read`'s two DTO rules (plan §4 "Golden harness" row)
 * without `mustMatch`: a scenario's reads may or may not include a body with
 * `gatesSatisfied` or a consent DTO, and the rule must not go vacuous-fails
 * where it simply has nothing to match.
 */

import type { AddedEntriesRule, AllowRule, ChangesMappedRule, ReplacedEntryRule } from './types';

export const READ_DTO_RULES: AllowRule[] = [
  {
    kind: 'absentKeys',
    at: 'steps.*.body.**.gatesSatisfied',
    keys: ['feelHeardCheckOffered', 'readyToRank', 'rankingSubmitted', 'finalEmotionalReading'],
    why:
      'plan §3 step 7: feelHeardCheckOffered (AI hint) and finalEmotionalReading (always null) are dropped; ' +
      'readyToRank/rankingSubmitted are dropped with ranking. gatesSatisfied becomes derived from participant_milestone.',
  },
  // --- tiedOrder (fix round 3): endpoints that sort on ONE timestamp ---------
  // Audit of every TS-5 response array whose rows one request can write:
  {
    kind: 'tiedOrder',
    at: 'steps.*.body.data.records',
    key: 'createdAt',
    why:
      'GET consent/history orders by createdAt alone (controllers/consent.ts); POST needs/consent writes every ' +
      'need’s consent in one transaction with one `now` (stage3.ts consentToShareNeeds), so they tie and come back ' +
      'in heap order — measured flipping at needs-hidden-until-shared step 29.',
  },
  {
    kind: 'tiedOrder',
    at: ['steps.*.body.data.messages', 'steps.*.body.data.messages.messages'],
    key: 'timestamp',
    why:
      'GET messages and the state DTO order a conversation by timestamp alone (controllers/messages.ts); a stream ' +
      'turn, a share acceptance, a resubmit or a reveal writes 2–3 messages for one reader in one request, which can ' +
      'land in one millisecond. Only rows with the same RAW timestamp tie (fix round 4); rows a millisecond apart keep ' +
      'their order even though both normalise to <ts:fresh>.',
  },
  {
    kind: 'valuesSubset',
    at: ['steps.*.body.**.targetType', 'steps.*.body.**.contentType'],
    why:
      'spec §3 consent_target: 7 ConsentContentType values become 5 real targets. A value may disappear, none may appear.',
  },
];

/**
 * The delivered `EMPATHY_STATEMENT` copy the target writes into the SUBJECT's
 * conversation when `author`'s attempt is revealed (plan §3 step 9 for
 * migrated reveals, `app.empathy_set_status` for live ones; spec §7 "what the
 * partner saw stays readable to them"). Pinned completely — structural key,
 * audience, lineage, sender — so a copy into the author's own conversation, a
 * duplicate, or the wrong lineage is still a violation (TS-4 review probe).
 *
 * `where` = 'initial' for an attempt revealed in the fixture (the migration
 * inserts the copy into the restored state), or the index of the step whose
 * reveal inserts it — pinned to that one step, so a duplicate copy written by
 * any other step is a violation and "exactly once" holds on the target too.
 * `round` is the revealed attempt's round (its lineage).
 */
export function deliveredStatementCopy(
  author: string,
  subject: string,
  where: 'initial' | number,
  round = 1,
): AddedEntriesRule {
  const key = `<message:${subject}@main/EMPATHY_STATEMENT:${author}#1>`;
  const row = {
    'kind': 'EMPATHY_STATEMENT',
    'role': 'USER',
    'conversation_id': `<conversation:${subject}@main/MAIN>`,
    'sender_participant_id': `<participant:${author}@main>`,
    'source_attempt_id': `<empathyAttempt:${author}→${subject}@main#${round}>`,
  };
  return where === 'initial'
    ? {
        kind: 'addedEntries',
        at: 'initial.message',
        where: { $key: key, ...row },
        why:
          `plan §3 step 9: for every REVEALED/VALIDATED attempt the migration inserts ${author}'s EMPATHY_STATEMENT ` +
          `into the subject's (${subject}'s) conversation; today's data has none (P0-2).`,
      }
    : {
        kind: 'addedEntries',
        at: `steps.${where}.changes`,
        where: {
          view: 'message',
          kind: 'added',
          key,
          ...Object.fromEntries(Object.entries(row).map(([k, v]) => [`after.${k}`, v])),
        },
        why:
          `spec §4 app.empathy_set_status: on → REVEALED the reveal writes ${author}'s EMPATHY_STATEMENT into the ` +
          `subject's (${subject}'s) conversation; today it is written only into the author's own chat (P0-2).`,
      };
}

// ============================================================================
// TS-10 — target-shape rules the Stage 2 scenarios share
// ============================================================================

/**
 * The target fixture's user names (FIDELITY, fixture-scenarios/target-shape.ts
 * header): the whole name in `first_name`, `last_name` NULL, so `name` (and the
 * app's display name) equal the old fixture's; the current-shape view shows
 * NULL first/last. `name` itself stays compared. Holds trivially on the
 * current shape.
 */
export const TARGET_USER_NAME_RULE: AllowRule = {
  kind: 'mayDiffer',
  at: [
    'initial.user.*.first_name',
    'initial.user.*.last_name',
    'steps.*.changes.*.before.first_name',
    'steps.*.changes.*.before.last_name',
    'steps.*.changes.*.after.first_name',
    'steps.*.changes.*.after.last_name',
  ],
  why:
    'spec §1.7 user: `name` is GENERATED from first/last; the old factory wrote only `name`. The target writer ' +
    'puts the whole name in first_name (FIDELITY), so `name` — compared, not on this list — is equal.',
};

/**
 * A participant's `empathy_submitted` milestone (spec §1.1 milestone seed; TS-7
 * step 7 derives it from EmpathyAttempt.sharedAt). The current-shape view
 * decodes only gate keys and omits it; the target stores it.
 *  - `initial` with `reachedAt` = a fixture submission (the attempt's
 *    submitted_at rank);
 *  - a step index for a submission the run makes (TS-10 consentToShare writes
 *    it at the round's submitted_at — the scenario asserts the instant).
 */
export function empathySubmittedMilestone(who: string, where: 'initial' | number, reachedAt: string): AddedEntriesRule {
  const row = { milestone_key: 'empathy_submitted', participant_id: `<participant:${who}@main>`, reached_at: reachedAt };
  const key = `<milestone:${who}@main/empathy_submitted>`;
  return where === 'initial'
    ? {
        kind: 'addedEntries',
        at: 'initial.participant_milestone',
        where: { $key: key, ...row },
        why: `${who} submitted an attempt in the fixture; the target stores empathy_submitted (the view omits it).`,
      }
    : {
        kind: 'addedEntries',
        at: `steps.${where}.changes`,
        where: {
          view: 'participant_milestone',
          kind: 'added',
          key,
          ...Object.fromEntries(Object.entries(row).map(([k, v]) => [`after.${k}`, v])),
        },
        why: `${who}'s submission at this step reaches empathy_submitted (TS-10 consentToShare, job), at the round's submitted_at.`,
      };
}

/**
 * Ruling R32: there is no ANALYZING status on the target, so a round revealed
 * by the symmetric path goes HELD → READY → REVEALED: status_version 2 where
 * the current shape recorded 3. Pinned to the step and the attempt row, paired
 * with the scenario's DB assertion (every revealed round's status_version is 2).
 * `kind` is the row's change kind at that step ('changed' for a fixture round,
 * 'added' for a round the step inserted).
 */
export function statusVersionTwo(step: number, author: string, subject: string, kind: 'changed' | 'added'): ReplacedEntryRule {
  return {
    kind: 'replacedEntry',
    at: `steps.${step}.changes`,
    where: { view: 'empathy_attempt', kind, key: `<empathyAttempt:${author}→${subject}@main#1>`, 'after.status_version': 3 },
    with: { 'after.status_version': 2 },
    mustMatch: true,
    why: 'ruling R32: no ANALYZING on the target — HELD → READY → REVEALED is two status moves (app.empathy_set_status).',
  };
}

/**
 * A message's DTO `stage` (TS-9's session-read rule 2, restated for the Stage 2
 * scenarios): the target has no stage column; the shim computes the owner's
 * stage at the message instant, and the fixtures tag messages with phases that
 * run ahead of their milestone instants. Paired with `targetMessageStageChecks`
 * (scenario-checks.ts), which asserts every message's stage from the owner's
 * milestones.
 */
export const TARGET_MESSAGE_STAGE_RULE: AllowRule = {
  kind: 'mayDiffer',
  at: ['steps.*.body.data.messages.*.stage', 'steps.*.body.data.messages.messages.*.stage'],
  why:
    'spec §1.1 message: `stage` is dropped ("derivable from participant_milestone"); the DTO stage is the owner\'s ' +
    'stage at the message instant (stage shim). The scenario asserts exactly that for every message.',
};

/**
 * The delivered EMPATHY_STATEMENT copy in the SUBJECT's own messages read
 * (`GET /messages`, `GET /state`) after a reveal (spec §7 "what the partner
 * saw stays readable to them"; app.empathy_set_status writes it). Pinned to the
 * read step and to role, sender and the exact statement. `id` is pinned only
 * in the concept golden (structural label); the byte-level label is a global
 * created_at rank.
 */
export function deliveredCopyInRead(
  step: number,
  author: string,
  subject: string,
  content: string,
  opts: { byteLevel?: boolean; at?: string } = {},
): AddedEntriesRule {
  return {
    kind: 'addedEntries',
    at: opts.at ?? `steps.${step}.body.data.messages`,
    where: {
      role: 'EMPATHY_STATEMENT',
      senderId: `<user:${author}>`,
      content,
      ...(opts.byteLevel ? {} : { id: `<message:${subject}@main/EMPATHY_STATEMENT:${author}#1>` }),
    },
    why:
      `spec §7: after the reveal ${subject}'s own conversation holds ${author}'s statement (the delivered copy ` +
      'app.empathy_set_status writes); today it existed only in the author\'s chat (P0-2).',
  };
}

/**
 * The current shape's relations → the target tables holding the same facts
 * (spec §1 "Absorbs" lines). For `traceMapped` (relations) and
 * `changesMapped` (physical tables).
 */
export const TARGET_RELATION_MAP: Record<string, string[]> = {
  Message: ['message'],
  Session: ['session'],
  Relationship: ['relationship'],
  RelationshipMember: ['relationship_member'],
  User: ['user', 'user_preferences'],
  StageProgress: ['participant_milestone', 'milestone'],
  UserVessel: ['conversation_read_state', 'ai_memory'],
  Invitation: ['invitation'],
  InnerWorkSession: ['reflection'],
  InnerWorkMessage: ['reflection_message'],
  EmpathyAttempt: ['empathy_attempt'],
  EmpathyDraft: ['draft'],
  ValidationFeedbackDraft: ['draft'],
  EmpathyValidation: ['empathy_review'],
  ConsentRecord: ['consent'],
  ReconcilerResult: ['reconciler_result', 'reconciler_guidance'],
  ReconcilerShareOffer: ['context_share_offer'],
  RefinementAttemptCounter: ['empathy_attempt'],
  BrainActivity: ['brain_activity'],
  EmotionalReading: ['mood_reading'],
  UserMemory: ['user_memory'],
  GlobalFacts: ['ai_memory'],
};

/** Physical tables (changesMapped): the same map, `user` only (preferences are never written here). */
export const TARGET_TABLE_MAP: Record<string, string[]> = { ...TARGET_RELATION_MAP, User: ['user'] };

/** Relations the target's Stage 2 / reconciler reads add, each with its reason (traceMapped). */
export const TARGET_ADDED_RELATIONS: Record<string, string> = {
  participant: 'membership and the caller are the participant row (requireSessionAccess; v_co_participant; sessionParties)',
  conversation: "the audience of a read or a delivered row is a participant's MAIN conversation",
  participant_milestone: "a message's DTO stage and the stage-2 gates are derived from milestones (stage shim)",
  milestone: 'v_current_stage joins the milestone lookup',
  empathy_attempt: 'v_empathy_direction_status (the waiting state) reads the attempt rows through app.empathy_direction_status',
  reconciler_guidance: 'the author-visible abstract hints of a result (P3 D8a split)',
  context_share_offer: "the subject's own offers (pending actions, badge, empathy status)",
  consent: 'the submission consent of an attempt (empathy draft read)',
  empathy_review: "the subject's verdict (empathy status, partner empathy)",
  draft: 'the Stage 2 drafts (EmpathyDraft, ValidationFeedbackDraft)',
  reconciler_result: "the subject's own analysis (reconciler status, the reveal notice's gap severity)",
  conversation_read_state: "the Share-tab instant (unviewed context, the subject's delivery status)",
  session: 'the session status (Stage 2 writers; the reveal locks the session row)',
  ai_memory: "the subject's own NOTABLE_FACTS (reconciler analysis input)",
  user: 'display names of the session parties',
  relationship_member: "the viewer's nickname for the partner (share continuation)",
  message: "a participant's own conversation rows (messages, shared context)",
};

/**
 * The byte-level rules every TS-10 write scenario adds on the target: the
 * trace through the relation map, and the physical row changes through the
 * table map with the scenario's named additions (ruling R32).
 */
export function targetByteRules(opts: {
  addedTables: ChangesMappedRule['addedTables'];
  trace?: boolean;
}): AllowRule[] {
  const rules: AllowRule[] = [
    {
      kind: 'changesMapped',
      at: ['steps.*.changes', 'steps.*.changesAtResponse'],
      tableMap: TARGET_TABLE_MAP,
      addedTables: opts.addedTables,
      why:
        'byte-level changes are keyed by physical tables and columns, which are shape-bound; the row values are ' +
        "asserted by the same step's concept comparison (ruling R32).",
    },
  ];
  if (opts.trace) {
    rules.push({
      kind: 'traceMapped',
      at: 'steps.*.trace',
      mustMatch: true,
      relationMap: TARGET_RELATION_MAP,
      addedRelations: TARGET_ADDED_RELATIONS,
      sameRowsRead: [],
      why:
        'relation names and plans are shape-bound (README "Reading a trace diff during the migration"); kept: ' +
        'completeness, bind-parameter protocol for data statements, isolation, relations ⊆ the mapped set.',
    });
  }
  return rules;
}
