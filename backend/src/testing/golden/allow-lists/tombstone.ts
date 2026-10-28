/**
 * Allow-list for `tombstone` (golden R5).
 *
 * Plan §4 R5: account deletion leaves delivered messages, revealed attempts,
 * `need_share` and agreements readable to the partner; private rows gone;
 * `participant.display_name` NULL; `brain_activity` for the leaver gone; live
 * session ABANDONED. Spec §4 `app.anonymize_user_account` (the complete walk).
 *
 * TS-12: every KNOWN deviation of today's deletion (work-a39h.11.23) is closed
 * on the target — the walk does it — and their entries are deleted, with the
 * name leak of the partner's three name-bearing reads (F-R5-6). The run is
 * compared to the current-shape baselines (never re-recorded, R39) under the
 * pinned rules below; each names its cause and its scenario pair
 * (tombstone.golden.test.ts):
 *   - the fixture-representation rules every TS-9/10/11 read carries (DTO
 *     rules, compact instants, message stage, user first_name, round keys,
 *     consent arc targets, the author-side analysis closure — Bob is the
 *     author of the round Ada is the subject of);
 *   - TOMBSTONE_READY is a finished LEGACY journey: Stage 4 recorded COMPLETED
 *     in StageProgress (with the legacy agreement gates) and rankings, no
 *     session closure. The target derives Stage 4 completion from the
 *     `closed` milestone (stage shim), so Stage 4 is IN_PROGRESS with the
 *     migrated selection gate; the migrated shares and choices fill the needs
 *     comparison and the Stage 4 state, which were empty on today's code;
 *   - after the deletion: what survives is ATTRIBUTED to the tombstone (the
 *     user row is scrubbed, never deleted — spec §4 walk step 6): the partner's
 *     id, the delivered rows' sender, the invitation; and the departed
 *     partner's revealed round is readable again (deviation closed).
 */

import { TOMBSTONE_TEXT } from '../../fixture-scenarios/scenarios';
import { KnownLeak, SESSION_READS, USER_READS } from '../privacy';
import {
  authorAnalysisClosed,
  byteLabelShift,
  deliveredStatementCopy,
  empathySubmittedMilestone,
  READ_DTO_RULES,
  targetByteRules,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_ROUND_KEYS_RULE,
  TARGET_USER_NAME_RULE,
} from './common';
import { isTargetShape } from '../shape';
import type { AllowList, AllowRule } from './types';

/**
 * Bob's full read leaves out `strategies`: GET /strategies shuffles its list
 * on every call (controllers/stage4.ts shuffleArray) and this fixture has two
 * proposals, so its order is not a baseline (measured flipping).
 */
export const TOMBSTONE_READ_EXCEPT = ['strategies'];
const READ_NAMES = [...SESSION_READS, ...USER_READS].map(([n]) => n).filter(n => !TOMBSTONE_READ_EXCEPT.includes(n));

/**
 * Step layout (the scenario asserts it): the 30 reads before, the deletion at
 * index 30, the same 30 reads after. Rules only the post-deletion state may
 * trigger are pinned to the exact step of the read they concern, never to
 * `steps.*`.
 */
export const TOMBSTONE_DELETION_STEP = READ_NAMES.length;
const AFTER_STEPS = READ_NAMES.map((_, i) => TOMBSTONE_DELETION_STEP + 1 + i);
const readIndex = (read: string): number => {
  const i = READ_NAMES.indexOf(read);
  if (i < 0) throw new Error(`tombstone allow-list: no read named ${read}`);
  return i;
};
/** The step of a read before the deletion, and after it. */
export const beforeRead = (read: string): number => readIndex(read);
export const afterRead = (read: string): number => TOMBSTONE_DELETION_STEP + 1 + readIndex(read);
const at = (read: string, suffix: string): string => `steps.${afterRead(read)}.${suffix}`;
const atBefore = (read: string, suffix: string): string => `steps.${beforeRead(read)}.${suffix}`;
const atBoth = (read: string, suffixes: string[]): string[] => suffixes.flatMap(x => [atBefore(read, x), at(read, x)]);

/** Every step but the deletion (whose changes are the walk: pinned and asserted against the database). */
const NON_DELETION_STEPS = [...READ_NAMES.map((_, i) => i), ...AFTER_STEPS];

/**
 * TS-12, target only: TOMBSTONE_READY's Stage 4 is a LEGACY completion (see the
 * header). Exactly the progress fields the stage shim computes differently —
 * status IN_PROGRESS, no completedAt, no advance — and the gate keys: the
 * legacy agreement/ranking gates are absent, the migrated selection gate is
 * added. Pair: "stage 4 completion pair" (no `closed` milestone; both reached
 * `choices_shared`; every listed status is IN_PROGRESS with selectionSubmitted).
 */
function legacyStage4Completion(): AllowRule[] {
  const progress = (p: string) => [`${p}.status`, `${p}.completedAt`];
  return [
    {
      kind: 'mayDiffer',
      at: [
        ...atBoth('session', ['body.data.session.myProgress.status', 'body.data.session.stageStatus']),
        ...atBoth('state', [
          'body.data.progress.canAdvance',
          ...progress('body.data.progress.myProgress'),
          'body.data.session.myProgress.status',
          'body.data.session.stageStatus',
        ]),
        ...progress(atBefore('state', 'body.data.progress.partnerProgress')),
        atBefore('state', 'body.data.session.partnerLastActiveAt'),
        ...atBoth('progress', progress('body.data.myProgress')),
        ...progress(atBefore('progress', 'body.data.partnerProgress')),
        ...atBoth('session list', [...progress('body.data.items.0.myProgress'), 'body.data.items.0.selfActionNeeded']),
        ...progress(atBefore('session list', 'body.data.items.0.partnerProgress')),
        atBefore('session list', 'body.data.items.0.partnerActionNeeded'),
        atBefore('session list', 'body.data.items.0.statusSummary.userStatus'),
        atBefore('session list', 'body.data.items.0.statusSummary.partnerStatus'),
      ],
      mustMatch: true,
      why:
        'TOMBSTONE_READY is a legacy completion: StageProgress stage 4 COMPLETED without a session closure. The ' +
        'target (stage shim) completes Stage 4 at the `closed` milestone, which the legacy journey never reached, so ' +
        'Stage 4 is IN_PROGRESS (no completedAt, no advance; the list asks both to complete it, and its copy ' +
        'follows). The partner-activity instant is the shim\'s newest own turn, not the legacy stage row.',
    },
    {
      kind: 'absentKeys',
      at: [
        ...atBoth('state', ['body.data.progress.myProgress.gatesSatisfied']),
        ...atBoth('progress', ['body.data.myProgress.gatesSatisfied']),
        atBefore('progress', 'body.data.partnerProgress.gatesSatisfied'),
      ],
      keys: ['agreementConfirmed', 'agreementCreated', 'strategiesRanked'],
      mustMatch: true,
      why: 'spec §1.4: legacy agreement/ranking gates have no target milestone (ranking is gone, R25); the shim reports the target gates.',
    },
    {
      kind: 'addedKeys',
      at: [
        ...atBoth('state', ['body.data.progress.myProgress.gatesSatisfied']),
        ...atBoth('progress', ['body.data.myProgress.gatesSatisfied']),
        atBefore('progress', 'body.data.partnerProgress.gatesSatisfied'),
      ],
      keys: ['selectionSubmitted', 'selectionSubmittedAt'],
      mustMatch: true,
      why: 'the migrated rankings are `proposal_choice` rows with `choices_shared` (plan §3): the Stage 4 selection gate holds.',
    },
  ];
}

/**
 * TS-12, target only: the needs comparison and the Stage 4 state of a legacy
 * journey whose shares and rankings the migration carries over (need_share,
 * proposal_choice). Today's code returned both empty for this fixture (no
 * shared text existed to keep — F2; legacy rankings are not Stage 4
 * selections). Pairs: "needs comparison pair" (partnerNeeds are Ada's
 * need_share texts, myNeeds Bob's own needs) and "stage 4 state pair" (the
 * selections are the choice rows; the open needs are the four shares no
 * proposal covers).
 */
function migratedRepairState(): AllowRule[] {
  const stage4 = [
    'body.data.coverageAudit.open',
    'body.data.coverageAudit.updatedAt',
    'body.data.inventory.unaddressedNeeds',
    'body.data.mySelectionStatus',
    'body.data.mySelections',
    'body.data.partnerSelectionStatus',
    'body.data.partnerSelections',
    'body.data.phase',
    'body.data.walkthrough.currentNeed',
    'body.data.walkthrough.ownNeeds',
    'body.data.walkthrough.partnerNeeds',
    'body.data.walkthrough.phase',
    'body.data.walkthrough.qualityWarnings',
    'body.data.walkthrough.totalInPhase',
  ];
  return [
    {
      kind: 'mayDiffer',
      at: [
        atBefore('needs comparison', 'body.data.analysisComplete'),
        atBefore('needs comparison', 'body.data.myNeeds'),
        atBefore('needs comparison', 'body.data.partnerNeeds'),
        ...atBoth('stage4', stage4),
        at('stage4', 'body.data.inventory.updatedAt'),
      ],
      mustMatch: true,
      why:
        'the migrated need_share and proposal_choice rows (plan §3; spec §1.4) fill the needs comparison and the Stage 4 ' +
        'state that today returned empty for this legacy journey; the walkthrough and phase follow from them.',
    },
    {
      kind: 'addedKeys',
      at: atBefore('needs comparison', 'body.data'),
      keys: ['canAdvance', 'myValidated', 'partnerValidated'],
      mustMatch: true,
      why: 'the needs comparison of a journey whose needs are validated and shared carries its gate flags (TS-11 DTO).',
    },
    {
      kind: 'addedKeys',
      at: atBoth('stage4', ['body.data.inventory.sharedProposals.1']),
      keys: ['myDecision', 'partnerDecisionVisible'],
      mustMatch: true,
      why: 'the proposal both chose (proposal_choice WILLING, both choices_shared) shows both decisions (TS-11 DTO).',
    },
    {
      kind: 'addedKeys',
      at: atBoth('agreements', ['body.data.agreements.0']),
      keys: ['proposalId'],
      mustMatch: true,
      why: 'spec §1.4 agreement.proposal_id NOT NULL: the agreement names the proposal it converts (TS-11 DTO).',
    },
  ];
}

/**
 * TS-12, target only: after the deletion, what survives stays ATTRIBUTED to
 * the tombstone (spec §4 walk step 6 scrubs the user row and never deletes
 * it; today the cascade deleted the user, the member row and the invitation).
 * Pair: "tombstone attribution pair" (the partner id and the delivered rows'
 * sender are Ada's user id; her user row is the scrubbed tombstone; the
 * invitation row is the fixture's).
 */
function tombstoneAttribution(): AllowRule[] {
  return [
    {
      kind: 'mayDiffer',
      at: [
        at('session', 'body.data.session.partner.id'),
        at('state', 'body.data.session.partner.id'),
        at('session list', 'body.data.items.0.partner.id'),
        at('state', 'body.data.messages.messages.3.senderId'),
        at('state', 'body.data.messages.messages.4.senderId'),
        at('messages', 'body.data.messages.3.senderId'),
        at('messages', 'body.data.messages.4.senderId'),
        at('state', 'body.data.invitation'),
      ],
      mustMatch: true,
      why:
        'spec §4: the leaver is a tombstone, not a hole — the partner id is the tombstone user, the delivered rows keep ' +
        'their sender, the invitation survives (today: "", null, null after the cascade).',
    },
    {
      kind: 'mayDiffer',
      at: [
        at('empathy status', 'body.data.partnerAttempt.id'),
        at('empathy status', 'body.data.partnerAttempt.content'),
        at('empathy status', 'body.data.partnerAttempt.sourceUserId'),
        at('empathy status', 'body.data.partnerCompletedStage1'),
        at('partner empathy', 'body.data.waitingForPartner'),
      ],
      mustMatch: true,
      why:
        'spec §7: the revealed round stays in its subject\'s SELECT arm forever (deviation closed): Bob reads Ada\'s ' +
        'revealed round. Today the partner lookup lost her and the read showed Bob his own round as the partner\'s. ' +
        'Paired with the "Ada\'s revealed statement" survives-probe.',
    },
  ];
}

/**
 * TS-12, target only: `<ts:N>` ranks that move, each at its exact path (a rank
 * is the step's own order of instants), measured from the run's normalised
 * output. Pair: the comparison of the same rows under their structural labels.
 *   - Bob's empathy status before the deletion (both goldens): the closed
 *     analysis's `analyzedAt` (authorAnalysisClosed) no longer ranks, so the
 *     later instants of the step rank one lower;
 *   - Bob's reads after the deletion (concept golden only): on the target
 *     they have concept `changes` (the reader's own user row, the addedKeys
 *     rule above) where today the state was unrepresentable; that row's
 *     created_at is the step's oldest instant, so every body instant ranks
 *     one higher — except Bob's empathy status after the deletion, where his
 *     own round's sharedAt ranks after Ada's round (today the read showed
 *     Bob's own round as the partner's, so both shared one instant).
 */
function rankShifts(concept: boolean): AllowRule {
  return {
    kind: 'mayDiffer',
    at: [
      atBefore('empathy status', 'body.data.myAttempt.revealedAt'),
      atBefore('empathy status', 'body.data.partnerAttempt.revealedAt'),
      atBefore('empathy status', 'body.data.sharedContext.sharedAt'),
      at('empathy status', 'body.data.myAttempt.sharedAt'),
      ...(concept
        ? [
            at('session', 'body.data.session.createdAt'),
            at('state', 'body.data.session.createdAt'),
            at('empathy draft', 'body.data.draft.updatedAt'),
            at('consent history', 'body.data.records.0.createdAt'),
            at('consent history', 'body.data.records.1.createdAt'),
            at('consent history', 'body.data.records.2.createdAt'),
            at('agreements', 'body.data.agreements.0.agreedAt'),
            at('agreements', 'body.data.agreements.0.followUpDate'),
            at('session list', 'body.data.items.0.createdAt'),
          ]
        : []),
    ],
    mustMatch: true,
    why: 'rank shifts of the closed analysis instant (before) and of the after-reads\' new concept changes (after); see rankShifts().',
  };
}

/** The rows the target's restored state holds that today's view did not (concept `initial`). */
function initialTargetRows(): AllowRule[] {
  const share = (who: string, n: number, text: string): AllowRule => ({
    kind: 'addedEntries',
    at: 'initial.need_share',
    where: { $key: `<need:${who}@main#${n}>`, need_id: `<need:${who}@main#${n}>`, participant_id: `<participant:${who}@main>`, shared_text: text },
    why: `plan §3: ${who}'s shared need becomes a need_share row with its shared text (the TS-4 view had no shares).`,
  });
  const choice = (who: string): AllowRule => ({
    kind: 'addedEntries',
    at: 'initial.proposal_choice',
    where: {
      $key: `<proposalChoice:proposal:main#1/participant:${who}@main>`,
      decision: 'WILLING',
      participant_id: `<participant:${who}@main>`,
      proposal_id: '<proposal:main#1>',
    },
    why: `plan §3 (R25): ${who}'s legacy ranking of the agreed proposal becomes a WILLING choice.`,
  });
  return [
    ...TOMBSTONE_TEXT.adaNeedShares.map((t, i) => share('ada', i + 1, t)),
    ...TOMBSTONE_TEXT.bobNeedShares.map((t, i) => share('bob', i + 1, t)),
    choice('ada'),
    choice('bob'),
    empathySubmittedMilestone('ada', 'initial', '<ts:14>'),
    empathySubmittedMilestone('bob', 'initial', '<ts:15>'),
    {
      kind: 'mayDiffer',
      at: 'initial.brain_activity.*.cost',
      mustMatch: true,
      why: 'spec §1.8: brain_activity.cost is numeric(10,6) (pg returns it as text); the scenario asserts each is numerically 0.',
    },
    {
      // Pair: "initial rank pair" — the target writer stamps the offer's
      // updated_at at its created_at, so one instant fewer ranks.
      kind: 'mayDiffer',
      at: [
        'initial.context_share_offer.*.updated_at',
        'initial.proposal.*.updated_at',
        'initial.reflection.*.linked_at',
        'initial.reflection.*.updated_at',
        'initial.invitation.*.accepted_at',
        'initial.invitation.*.created_at',
        'initial.invitation.*.expires_at',
        'initial.invitation.*.message_confirmed_at',
        'initial.agreement_party.*.agreed_at',
        'initial.participant_milestone.<milestone:ada@main/choices_shared>.reached_at',
        'initial.participant_milestone.<milestone:bob@main/choices_shared>.reached_at',
        'initial.agreement.*.follow_up_at',
      ],
      mustMatch: true,
      why:
        'the TS-10 target writer stamps context_share_offer.updated_at = created_at (the offer is written once), so ' +
        'the baseline\'s <ts:48> has no instant and every later initial rank is one lower (measured: all and only these).',
    },
  ];
}

/** What fixing each known deviation changes in Bob's post-deletion reads (both goldens). */
const DEVIATION_FIX_RULES: AllowRule[] = [
  {
    kind: 'mayDiffer',
    at: [`steps.${TOMBSTONE_DELETION_STEP}.body.data.summary`],
    mustMatch: true,
    why: 'spec §4: the deletion is app.anonymize_user_account; its counts are not today’s cascade counts.',
  },
  {
    // Null today, the revealed round on the target: a null cannot be
    // narrowed field by field. Paired with the "Ada's revealed statement"
    // survives-probe and the private-material probes over the same read.
    kind: 'mayDiffer',
    at: [at('partner empathy', 'body.data.attempt'), at('partner empathy', 'body.data.partnerStatus')],
    mustMatch: true,
    why: 'spec §7: the revealed attempt stays readable to its subject after its author leaves (deviation: empathy/partner).',
  },
  {
    // Only the partner's side: myNeeds is Bob's own data and must not move
    // (if the target's comparison fills it, that is a re-declaration, not this rule).
    kind: 'mayDiffer',
    at: [at('needs comparison', 'body.data.partnerNeeds'), at('needs comparison', 'body.data.analysisComplete')],
    mustMatch: true,
    why: 'spec §4 walk: need_share survives the leaver (deviation: the comparison is empty today). Paired with the ' +
      '"Ada\'s shared need" survives-probes and the need label/evidence private probes.',
  },
  {
    kind: 'mayDiffer',
    at: ['session', 'state', 'session list'].flatMap(r => [
      at(r, 'body.data.**.partner.name'),
      at(r, 'body.data.**.partner.nickname'),
    ]),
    mustMatch: true,
    why: 'spec §7 v_participant: the leaver’s display_name is NULL; the partner sees the fallback, not the name. ' +
      'Paired with the rule check "the partner no longer reads the leaver\'s name" (name and nickname).',
  },
];

/** The target-only read rules (see the header); `concept` adds the closure's concept-only rank paths. */
/**
 * TARGET_COMPACT_SIGNED_MASK, except the PARTNER's instant after the deletion:
 * the partner has left and the read shows no instant for them (null, as the
 * baseline); a mask expecting an instant there would fail. Pair:
 * targetFixtureDeltaChecks with partnerLeftFromStep.
 */
const COMPACT_MASK: AllowRule = {
  ...TARGET_COMPACT_SIGNED_MASK,
  at: [
    'steps.*.body.data.compact.mySignedAt',
    'steps.*.body.data.mySignedAt',
    ...READ_NAMES.map((_, i) => `steps.${i}.body.data.compact.partnerSignedAt`),
    ...READ_NAMES.map((_, i) => `steps.${i}.body.data.partnerSignedAt`),
  ],
};

const targetReadRules = (concept: boolean): AllowRule[] => [
  COMPACT_MASK,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_ROUND_KEYS_RULE,
  TARGET_CONSENT_TARGET_ID_RULE,
  TARGET_USER_NAME_RULE,
  ...authorAnalysisClosed({
    empathyStatus: [beforeRead('empathy status'), afterRead('empathy status')],
    reconcilerStatus: [beforeRead('reconciler status'), afterRead('reconciler status')],
    summary: [beforeRead('reconciler summary'), afterRead('reconciler summary')],
    concept,
  }),
  ...legacyStage4Completion(),
  ...migratedRepairState(),
  ...tombstoneAttribution(),
  rankShifts(concept),
];

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
      at: [`steps.${TOMBSTONE_DELETION_STEP}`, ...AFTER_STEPS.map(i => `steps.${i}`)],
      keys: ['unrepresentable'],
      mustMatch: true,
      why: 'spec §4 anonymize walk: the target leaves a state the views represent (tombstoned user and participant).',
    },
    // The deletion step's concept changes are the walk itself. They have no
    // baseline to compare with; the scenario's rule check ("every rule of the
    // tombstone walk holds") asserts them against the database instead.
    {
      kind: 'addedKeys',
      at: `steps.${TOMBSTONE_DELETION_STEP}`,
      keys: ['changes'],
      mustMatch: true,
      why: 'the walk’s concept changes exist on the target where today the state is unrepresentable.',
    },
    // A read after the deletion may change exactly what a read before it
    // changed: the reader's own user row stamped by the auth bypass. Anything
    // else a read writes is a violation (fix round 1, I1).
    {
      kind: 'addedKeys',
      at: AFTER_STEPS.map(i => `steps.${i}`),
      keys: ['changes'],
      each: { view: 'user', kind: 'changed', key: '<user:bob>', changedFields: ['updated_at'] },
      mustMatch: true,
      why: 'a GET writes nothing but the auth bypass’s User.updatedAt (measured on all 30 pre-deletion reads).',
    },
    ...DEVIATION_FIX_RULES,
    ...(isTargetShape() ? [...targetReadRules(true), ...initialTargetRows()] : []),
  ],
};

/**
 * The byte-level golden on the TARGET shape (TS-12): the read rules plus the
 * physical-table map (ruling R32) for every step but the deletion. The
 * deletion step's byte changes are today's cascade (User and its rows
 * deleted); on the target they are the walk, pinned here and asserted against
 * the database by the scenario's rule check ("every rule of the tombstone walk
 * holds", target branch).
 */
export const TOMBSTONE_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'tombstone',
  rules: [
    ...READ_DTO_RULES,
    ...DEVIATION_FIX_RULES,
    ...targetReadRules(false),
    byteLabelShift(
      [0, 1, 2].flatMap(i => [
        `steps.${beforeRead('consent history')}.body.data.records.${i}.id`,
        `steps.${afterRead('consent history')}.body.data.records.${i}.id`,
      ]),
      'consent',
    ),
    {
      kind: 'mayDiffer',
      at: [atBefore('empathy status', 'body.data.partnerAttempt.id'), atBefore('partner empathy', 'body.data.attempt.id')],
      mustMatch: true,
      why:
        "byte-level attempt labels: today's labeller names an attempt by a user its fixture row left null " +
        '(<empathyAttempt:null>); the target labels it by its author. The concept golden compares the round structurally.',
    },
    {
      kind: 'mayDiffer',
      at: [`steps.${TOMBSTONE_DELETION_STEP}.changes`, `steps.${TOMBSTONE_DELETION_STEP}.changesAtResponse`],
      mustMatch: true,
      why: 'the deletion step’s writes are the walk (spec §4), asserted row by row against the database by the scenario.',
    },
    ...targetByteRules({ addedTables: [], steps: NON_DELETION_STEPS }),
  ],
};

/** Ada's private material found in Bob's post-deletion reads, today. */
export const TOMBSTONE_PRIVATE_KNOWN_LEAKS: KnownLeak[] = [];

/**
 * Rules of the walk today's deletion broke (work-a39h.11.23). TS-12: all
 * closed on the target — the walk is app.anonymize_user_account on the job
 * connection, the partner's reads resolve the departed partner's tombstone,
 * and the partner DTOs show a partner who left without a name.
 */
export const TOMBSTONE_KNOWN_DEVIATIONS: KnownLeak[] = [];

/** The leaver's email / names on the partner's three name-bearing reads after the deletion (F-R5-6: closed in TS-12). */
export const TOMBSTONE_NAME_KNOWN_LEAKS: KnownLeak[] = [];
