/**
 * Allow-list and known leaks for `needs-hidden-until-shared` (golden R4,
 * needs half).
 *
 * Plan §4 R4: `need.label/evidence` never readable by the partner;
 * `proposal_need`, `v_need_coverage`, `v_session_closure_items` name only
 * `need_share` ids. Spec §7: a shared need is visible to co-participants only
 * as its transformed text and category (`need_share`) — the private row is
 * never reachable.
 *
 * Target changes this scenario's bodies by design, beyond the DTO rules: the
 * partner's needs in `needs comparison` come from `v_need_shared` — the shared
 * text, not the label. On today's shape they ARE the label (known leak below),
 * so the partner-need text values may differ on the target; nothing else.
 */

import type { KnownLeak } from '../privacy';
import {
  READ_DTO_RULES,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_FEEL_HEARD_MASK,
  TARGET_USER_NAME_RULE,
  empathySubmittedMilestone,
  targetByteRules,
} from './common';
import type { AllowList, AllowRule } from './types';

// ============================================================================
// TS-11 — the byte-level golden on the TARGET shape
// ============================================================================
//
// Recorded on the current shape, never re-recorded (runner): compared under
// the concept rules above plus what the target computes differently by design
// (ruling R29 / Q3): the Stage 4 state is computed from v_need_coverage over
// need_share, so once both have shared (steps 32, 43) the walkthrough,
// inventory and coverage audit list the four shared needs where today's
// fixture had no coverage rows. Every rule is keyed by exact DTO keys under
// the enumerated Stage 4 paths, over the named Stage 4 read steps; each
// newly visible need is one pinned `addedEntries`. The scenario asserts the
// real values (target-only checks in the test). The step changes
// (`changes`/`changesAtResponse`, in the current shape's table names) are
// compared by TS-10's `changesMapped` (rulings R28/R32), with the share
// steps' need_share rows named and the StageProgress gate updates named as
// dropped (`droppedTables`: they are participant_milestone inserts now).

/** The Stage 4 reads of this scenario (the step layout the test pins). */
export const NEEDS_STAGE4_READ_STEPS = { nothingShared: 8, bobShared: 20, bothAda: 32, bothBob: 43 } as const;

/** The partner's shared text under MOCK_LLM: the job's category fallback (services/needs-share.ts). */
const SHARED_TEXT: Record<string, string> = {
  SAFETY: 'Feeling safe and settled',
  RECOGNITION: 'Being seen and appreciated',
  AUTONOMY: 'Having room to choose for myself',
};

/**
 * `concept`: the concept golden labels a need `<need:ada@main#1>`; the byte
 * golden `<need:ada#1>`. Post-merge: also step 20 — once Bob has shared, Ada
 * (who has not) reads HIS shared needs (need_share is readable by every
 * co-participant from the share on, spec §1.4 v_need_shared), so her
 * walkthrough opens on the partner phase; her own needs are not listed yet.
 */
function stage4SharedNeedRules(concept: boolean): AllowRule[] {
  const own = (step: number) => `steps.${step}.body.data`;
  const id = (who: string, i: number) => (concept ? `<need:${who}@main#${i}>` : `<need:${who}#${i}>`);
  const needs = {
    ada: [
      { id: id('ada', 1), label: 'Rest without having to earn it first', category: 'AUTONOMY' },
      { id: id('ada', 2), label: 'Being thanked out loud for the invisible work', category: 'RECOGNITION' },
    ],
    bob: [
      { id: id('bob', 1), label: 'A quiet first hour after work', category: 'SAFETY' },
      { id: id('bob', 2), label: 'Credit for the effort even when the result is late', category: 'RECOGNITION' },
    ],
  };
  const rules: AllowRule[] = [];
  for (const [step, reader, partner, readerShared] of [
    [NEEDS_STAGE4_READ_STEPS.bobShared, 'ada', 'bob', false],
    [NEEDS_STAGE4_READ_STEPS.bothAda, 'ada', 'bob', true],
    [NEEDS_STAGE4_READ_STEPS.bothBob, 'bob', 'ada', true],
  ] as const) {
    const base = own(step);
    const named = [
      ...(readerShared ? needs[reader].map(n => ({ id: n.id, label: n.label, source: 'YOU' })) : []),
      ...needs[partner].map(n => ({ id: n.id, label: SHARED_TEXT[n.category], source: 'PARTNER' })),
    ];
    rules.push({
      kind: 'mayDiffer',
      at: [`${base}.walkthrough.currentNeed`, `${base}.walkthrough.phase`, `${base}.walkthrough.totalInPhase`, `${base}.coverageAudit.updatedAt`],
      mustMatch: true,
      why: readerShared
        ? 'R29: the walkthrough starts on the reader’s first shared need (MY_NEEDS) instead of the empty QUALITY_REVIEW today’s coverage-less fixture gives.'
        : 'R29: the reader has shared nothing, the partner has — the walkthrough starts on the partner’s first shared need (PARTNER_NEEDS).',
    });
    if (!readerShared) {
      rules.push({
        kind: 'mayDiffer',
        at: ['key', 'title', 'readOnly'].map(k => `${base}.walkthrough.proposalGroups.*.${k}`),
        mustMatch: true,
        why: 'R29: the proposal groups follow the walkthrough phase — PARTNER_NEEDS shows the partner-phase groups (the test asserts the phase).',
      });
    }
    for (const n of named) {
      const list = n.source === 'YOU' ? 'ownNeeds' : 'partnerNeeds';
      rules.push({
        kind: 'addedEntries',
        at: `${base}.walkthrough.${list}`,
        where: { id: n.id, label: n.label, source: n.source },
        why: `R29: ${n.id} is a shared need (need_share) the walkthrough lists — ${n.source === 'YOU' ? 'by the owner’s label' : 'by its shared text'}.`,
      });
      for (const at of [`${base}.coverageAudit.open`, `${base}.inventory.unaddressedNeeds`]) {
        rules.push({
          kind: 'addedEntries',
          at,
          where: { id: n.id, label: n.label, source: n.source },
          why: `R29: ${n.id} is a shared need no proposal covers (v_need_coverage OPEN); its coverage note is dropped (no table).`,
        });
      }
    }
  }
  return rules;
}

/**
 * The step layout (the test pins it): per phase the eleven NEED_READS, in
 * fullRead's order — session, state, progress, messages, pending consent,
 * consent history, needs, needs comparison, stage4, strategies, session list
 * — with the shares between: nothing shared 0–10, Bob shares 11, Bob shared
 * 12–22, Ada shares 23, both shared as Ada 24–34 and as Bob 35–45.
 */
export const NEEDS_STEPS = {
  bobShares: 11,
  adaShares: 23,
  state: { none: 1, bobShared: 13, bothAda: 25, bothBob: 36 },
  progress: { none: 2, bobShared: 14, bothAda: 26, bothBob: 37 },
  consentHistory: { bothAda: 29, bothBob: 40 },
  sessionList: { none: 10, bobShared: 22 },
} as const;

/**
 * TS-11 post-merge: the NEEDS_CONFIRMED fixture's REPRESENTATION deltas (not
 * behaviour), as session-read's TS-9 deltas: facts the current-shape fixture
 * encoded in a fixture-only spelling the app never read, which the target
 * holds as milestones the stage shim decodes. Each is paired with an
 * assertion of the target value (needs-hidden-until-shared.golden.test.ts,
 * "fixture deltas").
 */
function stage3FixtureDeltas(): AllowRule[] {
  const S = NEEDS_STEPS;
  return [
    TARGET_FEEL_HEARD_MASK,
    {
      kind: 'mayBeAbsent',
      keys: ['needsIdentified', 'needsIdentifiedAt'],
      at: [
        `steps.${S.state.none}.body.data.progress.myProgress.gatesSatisfied`,
        `steps.${S.state.bobShared}.body.data.progress.myProgress.gatesSatisfied`,
        ...[S.progress.none, S.progress.bobShared].flatMap(n => [
          `steps.${n}.body.data.myProgress.gatesSatisfied`,
          `steps.${n}.body.data.partnerProgress.gatesSatisfied`,
        ]),
      ],
      mustMatch: true,
      why:
        'current-shape.ts GATE_ENCODING: the fixtures spelled the needs_confirmed gate `needsIdentified` (production ' +
        'and the stage shim: `needsConfirmed`). The target stores the milestone; the shim names it needsConfirmed.',
    },
    {
      kind: 'addedKeys',
      keys: ['needsConfirmed', 'needsConfirmedAt'],
      at: [
        `steps.${S.state.none}.body.data.progress.myProgress.gatesSatisfied`,
        `steps.${S.state.bobShared}.body.data.progress.myProgress.gatesSatisfied`,
        ...[S.progress.none, S.progress.bobShared].flatMap(n => [
          `steps.${n}.body.data.myProgress.gatesSatisfied`,
          `steps.${n}.body.data.partnerProgress.gatesSatisfied`,
        ]),
      ],
      mustMatch: true,
      why: 'the same gate under its production key (stage shim gatesFor(3)); the test asserts the instant is needs_confirmed.reached_at.',
    },
    {
      kind: 'mayDiffer',
      at: [
        `steps.${S.state.bothAda}.body.data.progress.myProgress.gatesSatisfied`,
        `steps.${S.state.bothBob}.body.data.progress.myProgress.gatesSatisfied`,
        ...[S.progress.bothAda, S.progress.bothBob].flatMap(n => [
          `steps.${n}.body.data.myProgress.gatesSatisfied`,
          `steps.${n}.body.data.partnerProgress.gatesSatisfied`,
        ]),
      ],
      mustMatch: true,
      why:
        'after both shares the participants are in stage 4. The old share created the stage-4 StageProgress rows with ' +
        'no gates (null); the target derives a stage’s gates from its milestones (stage shim) — {} until choices_shared.',
    },
    {
      kind: 'mayDiffer',
      at: [`steps.${S.sessionList.none}.body.data.items.0.hasUnread`, `steps.${S.sessionList.bobShared}.body.data.items.0.hasUnread`],
      mustMatch: true,
      why:
        'TS-9: unread comes from v_conversation_unread (messages after last_viewed_at not sent by the reader); the old ' +
        'list called a never-viewed ACTIVE session unread. Ada’s conversation holds no partner/AI message yet.',
    },
  ];
}

/**
 * Ruling R33 (accepted, owner-visible §10.2): `needs_shared` is reached by
 * everyone once ALL present humans have shared — not by the first sharer at
 * their share. So after Bob shares (and until Ada does) Bob is still in stage
 * 3 IN_PROGRESS on Ada's reads, with no needsShared gate, and Ada's list says
 * he is still exploring. The test asserts the milestone instants.
 */
function r33NeedsSharedForAll(): AllowRule[] {
  const S = NEEDS_STEPS;
  return [
    {
      kind: 'mayBeAbsent',
      keys: ['needsShared', 'sharedAt'],
      at: `steps.${S.progress.bobShared}.body.data.partnerProgress.gatesSatisfied`,
      mustMatch: true,
      why: 'R33: Bob has shared, but needs_shared is reached by both only once Ada has shared too.',
    },
    {
      kind: 'mayDiffer',
      at: [
        `steps.${S.state.bobShared}.body.data.progress.partnerProgress.status`,
        `steps.${S.progress.bobShared}.body.data.partnerProgress.status`,
        `steps.${S.sessionList.bobShared}.body.data.items.0.partnerProgress.status`,
        `steps.${S.sessionList.bobShared}.body.data.items.0.statusSummary.partnerStatus`,
        `steps.${S.sessionList.bobShared}.body.data.items.0.partnerActionNeeded`,
      ],
      mustMatch: true,
      why:
        'R33: Bob is IN_PROGRESS in stage 3 (not GATE_PENDING) until both have shared — the old GATE_PENDING came from ' +
        'his own needs_shared; the list summary and partner action follow the status.',
    },
  ];
}

/** Concept-only: the milestone R33 moves from Bob's share to Ada's. */
function r33ConceptChanges(): AllowRule[] {
  return [
    {
      kind: 'removedEntry',
      at: `steps.${NEEDS_STEPS.bobShares}.changes`,
      where: { view: 'participant_milestone', kind: 'added', key: '<milestone:bob@main/needs_shared>' },
      mustMatch: true,
      why: 'R33: Bob reaches needs_shared at Ada’s share (step 23, below), not at his own.',
    },
    {
      kind: 'addedEntries',
      at: `steps.${NEEDS_STEPS.adaShares}.changes`,
      where: {
        view: 'participant_milestone',
        kind: 'added',
        key: '<milestone:bob@main/needs_shared>',
        'after.milestone_key': 'needs_shared',
        'after.participant_id': '<participant:bob@main>',
        'after.reached_at': '<ts:fresh>',
      },
      mustMatch: true,
      why: 'R33: once Ada has shared, both reach needs_shared in the same write (the test asserts one instant).',
    },
  ];
}

/** Concept-only: the fixture's `initial` image (TS-9 representation deltas). */
function initialFixtureDeltas(): AllowRule[] {
  return [
    // Ranks measured: the attempts' submitted_at are <ts:4> (Ada) and <ts:5> (Bob).
    empathySubmittedMilestone('ada', 'initial', '<ts:4>'),
    empathySubmittedMilestone('bob', 'initial', '<ts:5>'),
    {
      kind: 'mayDiffer',
      at: [
        'initial.empathy_attempt.<empathyAttempt:ada→bob@main#1>.revealed_at',
        'initial.empathy_attempt.<empathyAttempt:bob→ada@main#1>.revealed_at',
      ],
      mustMatch: true,
      why:
        'target-shape.ts revealedAtFor (FIDELITY DEVIATION): the fixture’s VALIDATED attempts carry no reveal instant, ' +
        'which the target CHECK forbids; the writer takes the submission instant (no new rank). The test asserts it.',
    },
  ];
}

const SHARED_RULES = (concept: boolean): AllowRule[] => [
    ...READ_DTO_RULES,
    TARGET_USER_NAME_RULE,
    TARGET_COMPACT_SIGNED_MASK,
    ...stage3FixtureDeltas(),
    ...r33NeedsSharedForAll(),
    {
      kind: 'mayDiffer',
      at: 'steps.*.body.data.partnerNeeds.*.need',
      mustMatch: true,
      why:
        'spec §1.4 v_need_shared / §7: the partner reads need_share.shared_text, never need.label. The scenario’s ' +
        'probe assertion pins that the label is gone; this rule only lets the text differ.',
    },
    ...stage4SharedNeedRules(concept),
];

export const NEEDS_HIDDEN_UNTIL_SHARED_ALLOW: AllowList = {
  scenario: 'needs-hidden-until-shared',
  rules: [
    ...SHARED_RULES(true),
    ...initialFixtureDeltas(),
    ...r33ConceptChanges(),
    // The share steps write the need_share rows the target reads (spec §1.4,
    // `app.need_share()`); today they write none (finding F2). One rule per
    // need, pinned by structural key and owner.
    ...(['ada', 'bob'] as const).flatMap(who =>
      [1, 2].map(i => ({
        kind: 'addedEntries' as const,
        at: 'steps.*.changes',
        where: {
          view: 'need_share',
          kind: 'added',
          key: `<need:${who}@main#${i}>`,
          'after.need_id': `<need:${who}@main#${i}>`,
          'after.participant_id': `<participant:${who}@main>`,
        },
        why: `spec §1.4 need_share: ${who}'s share of need ${i} is a need_share row (plan step 12; today none — F2).`,
      })),
    ),
  ],
  targetOnly: [
    {
      assertion:
        'After both shares, need_share holds the four shared needs and every need_id that proposal_need / ' +
        'need_disposition name is one of them; assert need_share NON-EMPTY (the current-shape check is tautological ' +
        'and the scenario only pins today’s empty rows).',
      why:
        'The current-shape views join old_concept_need_share and production’s share writes none (F2 — a finding ' +
        'against the plan text; TS-7b is changing the migration so ConsentRecord-only shares become need_share).',
    },
    {
      assertion:
        'After both partners share, each partner reads the other’s needs as need_share.shared_text with its category; ' +
        'the comparison never carries need.label or need.evidence, and v_need_coverage / v_session_closure_items / ' +
        'proposal_need name only need_share ids.',
      why:
        'Spec §1.4 need_share, §7. Today the comparison returns the partner’s IdentifiedNeed.need (the label) — the ' +
        'known leak — and production’s needs share writes no ConsentedContent, so plan step 12 would migrate no ' +
        'need_share rows at all (TS-5 finding F2): the target re-record of the shared phase cannot be byte-compared ' +
        'to this baseline and must be re-asserted against the shared texts the migration (or a fixed share) writes.',
    },
  ],
};

/**
 * Observed against the current code; see `privacy.ts` for the contract.
 *
 * TS-11 (work-a39h.11.21): EMPTY on the target. The four entries recorded
 * `both shared: needs comparison as <reader> ⊃ <owner> need <i> label`
 * (finding "R4: GET /sessions/:id/needs/comparison returns the partner's
 * IdentifiedNeed.need (the private label)"); the target's comparison reads
 * the partner's needs from v_need_shared (shared text and category only), so
 * they are closed and deleted — any reappearance fails the scenario.
 */
export const NEEDS_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS: KnownLeak[] = [];

/**
 * Not a leak but the reason the target cannot reproduce the shared phase from
 * migrated data: after both shares the session has 4 GRANTED IDENTIFIED_NEED
 * consents and no ConsentedContent, so `old_concept_need_share` (plan step
 * 12's source) is empty. Asserted as a known finding in the scenario.
 */
export const NEEDS_SHARE_WRITES_NO_NEED_SHARE =
  'F2: production’s needs share (POST /needs/consent → stage3.ts consentToShareNeeds) writes GRANTED IDENTIFIED_NEED ' +
  'ConsentRecords and no ConsentedContent; plan §3 step 12 builds need_share from ConsentedContent alone, so every ' +
  'need shared in production migrates as unshared.';

export const NEEDS_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'needs-hidden-until-shared',
  rules: [
    ...SHARED_RULES(false),
    {
      kind: 'mayDiffer',
      at: [0, 1].flatMap(i => [NEEDS_STEPS.consentHistory.bothAda, NEEDS_STEPS.consentHistory.bothBob].map(n => `steps.${n}.body.data.records.${i}.id`)),
      mustMatch: true,
      why:
        'byte-level consent labels encode the old target type (IDENTIFIED_NEED, by need index); the target’s arc names the ' +
        'need (spec §1.3 consent_target NEED). The concept golden compares the rows under their structural labels.',
    },
    ...targetByteRules({
      addedTables: [NEEDS_STEPS.bobShares, NEEDS_STEPS.adaShares].map(step => ({
        step,
        table: 'need_share',
        kind: 'added' as const,
        count: 2,
        why: 'the sharer’s two need_share rows (app.need_share, spec §1.4; today none — F2)',
      })),
      droppedTables: [
        {
          step: NEEDS_STEPS.bobShares,
          table: 'StageProgress',
          kind: 'changed',
          why: 'R33: the old share completed Bob’s stage-3 row; the target reaches needs_shared for both at Ada’s share',
        },
        {
          step: NEEDS_STEPS.adaShares,
          table: 'StageProgress',
          kind: 'changed',
          why:
            'a stage-3 gate update / completion is a participant_milestone INSERT on the target (needs_shared ×2, ' +
            'needs_validated ×2 — the image of the StageProgress rows the step adds)',
        },
      ],
    }),
  ],
};
