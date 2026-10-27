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

/**
 * Physical tables (changesMapped): the same map, `user` only (preferences are
 * never written here), plus the repair-stage tables TS-11's write scenarios
 * touch (spec §1.4 Absorbs: Stage4ProposalSelection → proposal_choice,
 * Stage4NeedDeclination → need_disposition, IdentifiedNeed → need).
 */
export const TARGET_TABLE_MAP: Record<string, string[]> = {
  ...TARGET_RELATION_MAP,
  User: ['user'],
  IdentifiedNeed: ['need'],
  Stage4ProposalSelection: ['proposal_choice'],
  Stage4NeedDeclination: ['need_disposition'],
};

/**
 * Relations the target's reads add, each with its reason (traceMapped) —
 * exactly the ones a run needed (measured on empathy-reveal by emptying the
 * list: participant and conversation on 8 steps, participant_milestone on 2).
 */
export const TARGET_ADDED_RELATIONS: Record<string, string> = {
  participant: 'membership and the caller are the participant row (requireSessionAccess; v_co_participant; sessionParties)',
  conversation: "the audience of a read or a delivered row is a participant's MAIN conversation",
  participant_milestone: "a message's DTO stage and the Stage 2 stage checks are derived from milestones (stage shim)",
};

/**
 * The byte-level rules every TS-10 write scenario adds on the target: the
 * trace through the relation map, and the physical row changes through the
 * table map with the scenario's named additions (ruling R32).
 */
export function targetByteRules(opts: {
  addedTables: ChangesMappedRule['addedTables'];
  /** TS-11: baseline writes with no image at their exact step (see ChangesMappedRule). */
  droppedTables?: ChangesMappedRule['droppedTables'];
  trace?: boolean;
}): AllowRule[] {
  const rules: AllowRule[] = [
    {
      kind: 'changesMapped',
      at: ['steps.*.changes', 'steps.*.changesAtResponse'],
      tableMap: TARGET_TABLE_MAP,
      addedTables: opts.addedTables,
      ...(opts.droppedTables ? { droppedTables: opts.droppedTables } : {}),
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

/**
 * TS-9's session-read fixture delta 1, restated for the Stage 2 scenarios'
 * `state` reads: the current-shape fixture spells the compact gate
 * `compactSignedAt`, so today's DTO says null; the target holds the instant
 * (`compact_signed.reached_at`). Masked before normalisation (a new instant
 * renumbers every later `<ts:N>` of the step), paired with
 * `targetCompactSignedChecks` (scenario-checks.ts), which asserts the value.
 */
export const TARGET_COMPACT_SIGNED_MASK: AllowRule = {
  kind: 'fixtureMask',
  at: [
    'steps.*.body.data.compact.mySignedAt',
    'steps.*.body.data.compact.partnerSignedAt',
    // GET /compact/status returns the same two keys at the top of `data`.
    'steps.*.body.data.mySignedAt',
    'steps.*.body.data.partnerSignedAt',
  ],
  expect: 'isoTimestamp',
  baseline: null,
  why:
    "TS-9 session-read rule 1: the fixture's compact gate key (`compactSignedAt`) is not the app's (`signedAt`); " +
    'the target holds participant_milestone compact_signed.reached_at and the shim returns it.',
};

/**
 * TS-11 post-merge, the Stage 3/4 fixtures' stage-1 gate: the current-shape
 * fixture wrote `feelHeardConfirmed` without its instant (gatesToJson writes
 * the gate value only), so today's DTO says null; the target holds
 * feel_heard.reached_at and the shim returns it. A new instant renumbers every
 * later <ts:N> of the step, so it is masked; paired with a scenario assertion
 * that the raw value is the reader's feel_heard instant.
 */
export const TARGET_FEEL_HEARD_MASK: AllowRule = {
  kind: 'fixtureMask',
  at: ['steps.*.body.data.milestones.feelHeardConfirmedAt', 'steps.*.body.data.progress.milestones.feelHeardConfirmedAt'],
  expect: 'isoTimestamp',
  baseline: null,
  why:
    'the current-shape fixture wrote the stage-1 gate `feelHeardConfirmed` without its instant; the target holds ' +
    'feel_heard.reached_at and the shim returns it (masked: a new instant renumbers the step’s later ranks).',
};

/**
 * Consent DTO `targetId` (ruling R32 mapping): the current shape's empathy
 * consent targeted the DRAFT (`targetType EMPATHY_DRAFT, targetId = draft id`);
 * the target's arc names the ATTEMPT (`consent.empathy_attempt_id`, spec §1.3).
 * Paired with `targetConsentTargetChecks`, which asserts every record's
 * targetId is its row's arc id.
 */
export const TARGET_CONSENT_TARGET_ID_RULE: AllowRule = {
  kind: 'mayDiffer',
  at: ['steps.*.body.data.records.*.targetId', 'steps.*.body.data.pendingRequests.*.targetId'],
  why:
    'spec §1.3 consent: the arc names the attempt (empathy_attempt_id); the old record named the draft. The ' +
    "scenario asserts each targetId equals the row's arc id.",
};

/**
 * `reconciler/status` `hasRun` for a participant who sees no analysis (spec
 * §1.2: a result is its subject's only). Today any result in the session
 * counts — including one on the caller's own attempt, which is its subject's.
 * Pinned to the exact reads; the scenario's leak probes assert nothing else of
 * the analysis reaches the caller.
 */
export function hasRunForAuthor(steps: number[]): AllowRule {
  return {
    kind: 'mayDiffer',
    at: steps.map(s => `steps.${s}.body.data.hasRun`),
    mustMatch: true,
    why:
      "spec §1.2 reconciler_result is subject-only: the author's reconciler/status no longer counts the analysis of " +
      'their own attempt (it is the subject’s), so hasRun is false until an analysis they may see exists.',
  };
}

/** The reveal payloads' additive keys (plan §4: exactly `round`, `attemptId`). */
export const TARGET_ROUND_KEYS_RULE: AllowRule = {
  kind: 'addedKeys',
  at: ['steps.*.body.data.myAttempt', 'steps.*.body.data.partnerAttempt', 'steps.*.body.data.attempt'],
  keys: ['round', 'attemptId'],
  why: 'spec §1.2 empathy_attempt: revisionCount becomes rows with a round; a reveal payload names its round and row.',
};

/**
 * MOCK_LLM picks a streamed turn's canned response by the caller's turn
 * count (`mockResponseIndex = userTurnCount - 1`, stream-turn-model.ts).
 * Today's count excluded the fixture's own turns (they carry a recipient,
 * `forUserId`), so the mock served response 0; the target counts all of the
 * participant's own turns (TS-9 countOwnTurns), so it serves the response at
 * her real turn count — whose metadata also proposes an empathy statement,
 * which updates her draft. A fixture × mock artefact, not a privacy change:
 * pinned to the one streamed step; `mockIndexChecks` asserts the served
 * response is the fixture's at her turn count, and the leak probes still scan
 * the stream and the captured prompt.
 */
export function mockTurnIndex(step: number, concept: boolean, draftOwner: string): AllowRule[] {
  const rules: AllowRule[] = [
    {
      kind: 'mayDiffer',
      at: [`steps.${step}.sse.*.data.text`, `steps.${step}.sse.*.data.metadata.offerReadyToShare`],
      mustMatch: true,
      why: 'MOCK_LLM serves the canned response at the caller’s own turn count (TS-9 counts every own turn).',
    },
    {
      kind: 'addedKeys',
      at: `steps.${step}.sse.*.data.metadata`,
      keys: ['proposedEmpathyStatement'],
      why: 'the served canned response proposes an empathy statement (its metadata).',
    },
  ];
  if (concept) {
    rules.push({
      kind: 'mayDiffer',
      // After the admitted draft row, the step's third change is the AI reply.
      at: [`steps.${step}.changes.2.after.content`, `steps.${step}.changes.2.after.content_hash`],
      mustMatch: true,
      why: "the AI reply's row holds the served canned response (and its hash).",
    });
    rules.push({
      kind: 'addedEntries',
      at: `steps.${step}.changes`,
      where: {
        view: 'draft',
        kind: 'changed',
        key: `<draft:${draftOwner}@main/EMPATHY>`,
        'after.kind': 'EMPATHY',
        'after.participant_id': `<participant:${draftOwner}@main>`,
      },
      why: "the served canned response's proposed statement updates the caller's own EMPATHY draft (persistTurnState).",
    });
  }
  return rules;
}

/**
 * Byte-level labels that move for a reason the concept golden pins
 * structurally (TS-10). `consent` byte labels carry the old target type
 * (`EMPATHY_DRAFT/empathyDraft:…`), the arc names the attempt; `message` byte
 * labels are global created_at ranks, which the delivered copies a reveal
 * writes shift by two for every later row. Only the exact `id` paths listed;
 * the concept comparison of the same reads compares those rows by their
 * structural labels.
 */
export function byteLabelShift(paths: string[], what: 'consent' | 'message'): AllowRule {
  return {
    kind: 'mayDiffer',
    at: paths,
    mustMatch: true,
    why:
      what === 'consent'
        ? "byte-level consent labels encode the old target type and target (the draft); the arc names the attempt " +
          '(spec §1.3). The concept golden compares the row under its structural label; targetConsentTargetChecks pins targetId.'
        : 'byte-level message labels are global created_at ranks; the two delivered copies of the reveal precede the ' +
          'reveal notices, so each notice ranks two later. The concept golden compares the notices structurally.',
  };
}

/**
 * R6 / R7 closures (work-a39h.11.22) at the AUTHOR's reads, wherever a
 * scenario reads them on RECONCILER_SHOWN_B (the analysis of the author's own
 * attempt is its subject's — spec §1.2, P3 D8a; P1-4 for the offer):
 *  - `empathyStatus`: `myReconcilerResult` is null. Its `analyzedAt` was the
 *    step's only carried instant between the attempt's and the user row's, so
 *    the user row's `created_at` ranks one lower (`<ts:4>` → `<ts:3>`): those
 *    two concept paths, `concept: true` only (byte-level changes are not
 *    compared by value);
 *  - `reconcilerStatus`: no analysis of the caller-authored direction, no
 *    count of the subject's offers, and `hasRun` only for an analysis the
 *    caller may see;
 *  - `reconcilerRun`: only the directions the caller is the subject of;
 *  - `summary`: the 400's reason follows (`has not run yet`).
 * Paired with `authorClosureChecks` (scenario-checks.ts): the exact values.
 */
export function authorAnalysisClosed(opts: {
  empathyStatus?: number[];
  reconcilerStatus?: number[];
  reconcilerRun?: number[];
  summary?: number[];
  concept: boolean;
}): AllowRule[] {
  const at = (steps: number[] | undefined, paths: string[]) => (steps ?? []).flatMap(s => paths.map(p => `steps.${s}.${p}`));
  const rules: AllowRule[] = [];
  const empathy = at(opts.empathyStatus, [
    'body.data.myReconcilerResult',
    ...(opts.concept ? ['changes.0.before.created_at', 'changes.0.after.created_at'] : []),
  ]);
  if (empathy.length) {
    rules.push({
      kind: 'mayDiffer',
      at: empathy,
      mustMatch: true,
      why:
        'R6 (work-a39h.11.22): the author reads no reconciler_result of her own attempt (subject-only); the closed ' +
        "field's carried instant no longer ranks, so the user row's created_at ranks one lower.",
    });
  }
  const status = at(opts.reconcilerStatus, ['body.data.aUnderstandingB', 'body.data.hasRun', 'body.data.pendingShareOffers']);
  if (status.length) {
    rules.push({
      kind: 'mayDiffer',
      at: status,
      mustMatch: true,
      why:
        'R6/R7 (work-a39h.11.22): reconciler/status returns the caller only her own subject-side analyses and her own ' +
        'offers; the author sees neither the analysis of her attempt nor that an offer exists.',
    });
  }
  const run = at(opts.reconcilerRun, ['body.data.aUnderstandingB']);
  if (run.length) {
    rules.push({
      kind: 'mayDiffer',
      at: run,
      mustMatch: true,
      why: 'R6 (work-a39h.11.22): reconciler/run returns the caller only the directions she is the subject of.',
    });
  }
  const summary = at(opts.summary, ['body.error.message']);
  if (summary.length) {
    rules.push({
      kind: 'mayDiffer',
      at: summary,
      mustMatch: true,
      why: 'R6: the summary gate follows the caller-visible hasRun (no analysis she may see yet → "has not run yet").',
    });
  }
  return rules;
}

/**
 * The notification path writes `delivery_notified_at` (spec §1.2
 * context_share_offer; review F4.2): the subject's first pending-actions read
 * after the delivery counts the update and stamps it (job), so it is counted
 * once. `stampStep`: that read — its offer row gains the stamp; `laterReads`:
 * the subject's later pending-actions reads, whose `sentTabUpdates` is 0 where
 * the never-written column kept it at 1. Paired with `notifiedOnceChecks`.
 */
export function notifiedOnce(stampStep: number, laterReads: number[], concept: boolean): AllowRule[] {
  const rules: AllowRule[] = [
    {
      kind: 'mayDiffer',
      at: laterReads.map(s => `steps.${s}.body.data.sentTabUpdates`),
      mustMatch: true,
      why: 'review F4.2 / spec §1.2: delivery_notified_at is written by the notification path; an update is counted once.',
    },
  ];
  if (concept) {
    rules.push({
      kind: 'addedEntries',
      at: `steps.${stampStep}.changes`,
      where: {
        view: 'context_share_offer',
        kind: 'changed',
        key: '<shareOffer:ada→bob@main#1/i1>',
        changedFields: ['delivery_notified_at', 'updated_at'],
        'after.delivery_notified_at': '<ts:fresh>',
        'after.status': 'ACCEPTED',
      },
      why: "the subject's pending-actions read surfaces the delivery and stamps delivery_notified_at (job).",
    });
  }
  return rules;
}

/**
 * Round 2 is its own row (spec §1.2): its `submitted_at` is the resubmission
 * instant (fresh), where today's rewritten row kept the first submission's. A
 * fresh instant leaves the carried ranks, so the other carried instants of
 * those steps rank one lower. Exact paths only, paired with
 * `roundInstantChecks`: each DTO instant equals its row's submitted_at.
 */
export function roundTwoInstants(paths: string[]): AllowRule {
  return {
    kind: 'mayDiffer',
    at: paths,
    mustMatch: true,
    why:
      'spec §1.2 immutable rounds: round 2 carries its own submitted_at (the resubmit); with it fresh, the other ' +
      'carried instants of the step rank one lower.',
  };
}

/** The subject's consent naming the offer (spec §1.3: no requester), written by the step that answers it. */
export function declineConsent(step: number, decision: 'DENIED' | 'GRANTED' = 'DENIED'): AddedEntriesRule {
  const key = '<consent:bob@main/SHARE_OFFER/shareOffer:ada→bob@main#1/i1>';
  return {
    kind: 'addedEntries',
    at: `steps.${step}.changes`,
    where: {
      view: 'consent',
      kind: 'added',
      key,
      'after.id': key,
      'after.participant_id': '<participant:bob@main>',
      'after.requested_by_participant_id': null,
      'after.share_offer_id': '<shareOffer:ada→bob@main#1/i1>',
      'after.target_kind': 'SHARE_OFFER',
      'after.decision': decision,
      'after.revoked_at': null,
    },
    why:
      "spec §1.3/§1.2: the subject's answer is a consent row naming the offer, with no requester (CHECK), so the " +
      'author can never read the decision (P1-4).',
  };
}

/**
 * The subject's own consent history after declining: the DENIED share-offer
 * consent is a record of the SUBJECT's (spec §1.3: S mine(participant_id)
 * only), with the target-only content type CONTEXT_SHARE_OFFER (ruling R32).
 * Pinned to the read step and to the exact record; never in the author's reads.
 */
export function subjectDeclineRecord(step: number, byteLevel: boolean, decision: 'DENIED' | 'GRANTED' = 'DENIED'): AddedEntriesRule {
  return {
    kind: 'addedEntries',
    at: `steps.${step}.body.data.records`,
    where: {
      contentType: 'CONTEXT_SHARE_OFFER',
      decision,
      revokedAt: null,
      id: byteLevel ? '<consent:bob/SHARE_OFFER/shareOffer:bob#1>' : '<consent:bob@main/SHARE_OFFER/shareOffer:ada→bob@main#1/i1>',
      ...(byteLevel ? {} : { targetId: '<shareOffer:ada→bob@main#1/i1>' }),
    },
    why:
      "spec §1.3: the subject's answer to the offer is the subject's own consent row (DENIED, no requester), listed in " +
      'the subject’s own history only.',
  };
}
