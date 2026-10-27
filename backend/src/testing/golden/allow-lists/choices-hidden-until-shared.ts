/**
 * Allow-list and known leaks for `choices-hidden-until-shared` (golden R4,
 * choices half).
 *
 * Plan §4 R4: partner `proposal_choice` invisible before `choices_shared`;
 * `proposal_need`, `v_need_coverage`, `v_session_closure_items` name only
 * `need_share` ids. Spec §7: "partner choices stay hidden until the chooser
 * reaches choices_shared" (`proposal_choice` RLS arm over
 * `participant_milestone`).
 *
 * Beyond the DTO rules, the target may change the need text the Stage 4 state
 * shows: every need it names comes from `need_share` (shared text) instead of
 * `Stage4NeedCoverage.needLabel` (a copy of the private label). Nothing about
 * choices may change.
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

/**
 * Step layout (the scenario asserts it): Ada's 9 reads (0–8), Bob chooses
 * twice (9, 10), Ada's 9 reads (11–19), Bob sets aside a need (20) and shares
 * (21), Ada's 9 reads (22–30).
 */
export const ADA_READ_STEPS = [0, 11, 22].flatMap(start => Array.from({ length: 9 }, (_, i) => start + i));
export const BOB_WRITE_STEPS = [9, 10, 20, 21];

// ============================================================================
// TS-11 — the byte-level golden on the TARGET shape
// ============================================================================
//
// Recorded on the current shape, never re-recorded: compared under the
// concept rules above plus what the target computes differently by design
// (ruling R29 / Q3). The Stage 4 state is built from v_need_coverage over
// need_share (no Stage4NeedCoverage table): need ids are need_share ids, the
// coverage buckets are computed (Partnership is PARTIAL while only Ada is
// WILLING), the coverage note is dropped, and Bob's "Understanding" appears
// because "pause" covers it. The rules are keyed by exact DTO keys under the
// enumerated Stage 4 paths, over the named Stage 4 steps (Ada's three Stage 4
// reads and Bob's four write responses, whose `state` is the same DTO). The
// scenario asserts the real values (the target-only checks in the test).
// The step changes are compared by TS-10's `changesMapped` (R28/R32), with
// the repair tables mapped (TARGET_TABLE_MAP) and the selectionSubmitted gate
// update named as dropped for its milestone insert; each newly visible need
// is one pinned `addedEntries` (stage4NewlyVisible).

/** Ada's Stage 4 reads (the 6th read of each block of nine). */
export const ADA_STAGE4_READ_STEPS = [5, 16, 27];

/** Every Stage 4 state DTO of the scenario, as a path prefix. */
export const STAGE4_STATE_ROOTS = [
  ...ADA_STAGE4_READ_STEPS.map(i => `steps.${i}.body.data`),
  ...BOB_WRITE_STEPS.map(i => `steps.${i}.body.data.state`),
];

function stage4ComputedRules(): AllowRule[] {
  const needKeys = (prefix: string, keys: string[]) => keys.map(k => `${prefix}.${k}`);
  const at = STAGE4_STATE_ROOTS.flatMap(r => [
    ...needKeys(`${r}.walkthrough.currentNeed`, ['id', 'label', 'status']),
    ...needKeys(`${r}.walkthrough.ownNeeds.*`, ['id', 'label', 'status']),
    ...needKeys(`${r}.walkthrough.partnerNeeds.*`, ['id', 'label', 'status']),
    ...needKeys(`${r}.walkthrough.proposalGroups.*.proposals.*.needsAddressed.*`, ['id', 'label', 'coverage']),
    ...needKeys(`${r}.inventory.sharedProposals.*.needsAddressed.*`, ['id', 'label', 'coverage']),
    ...needKeys(`${r}.inventory.individualCommitments.*.needsAddressed.*`, ['id', 'label', 'coverage']),
    ...needKeys(`${r}.inventory.unaddressedNeeds.*`, ['id', 'label', 'note']),
    // The coverage status buckets and their instant are computed (v_need_coverage).
    ...needKeys(`${r}.coverageAudit`, ['covered', 'partial', 'open', 'updatedAt']),
  ]);
  return [
    {
      kind: 'mayDiffer',
      at,
      mustMatch: true,
      why:
        'R29: a need named in the Stage 4 state is a need_share id, named by the reader’s own label or the partner’s ' +
        'shared text; coverage is computed from v_need_coverage over the choices the reader may see (R20), and its ' +
        'note has no table.',
    },
    {
      // The proposalGroups order question (post-merge, pinned — the product
      // order is unchanged this round): the walkthrough's current need is the
      // reader's first shared need in the NEED's creation order (Appreciation),
      // where the fixture's coverage rows put Partnership first, so each group
      // lists the proposals addressing that need. The test asserts exactly that.
      kind: 'mayDiffer',
      at: STAGE4_STATE_ROOTS.map(r => `${r}.walkthrough.proposalGroups.*.proposals`),
      mustMatch: true,
      why:
        'R29 + the walkthrough order: the groups show the proposals addressing the current need, which is the first ' +
        'shared need by creation (need.created_at), not the fixture’s coverage-row order.',
    },
    {
      kind: 'addedKeys',
      at: STAGE4_STATE_ROOTS.map(r => `${r}.inventory.individualCommitments.*.needsAddressed.*`),
      keys: ['id'],
      why: 'R29: the individual commitment’s need is a proposal_need link (a need_share id) — today a bare label with no id.',
    },
  ];
}

/** Ada's session-list reads (the 8th read of each block of nine). */
export const ADA_SESSION_LIST_STEPS = [7, 18, 29];

const NEED_LABEL_RULE: AllowRule = {
      // Only the keys that name a need in the Stage 4 state — never a
      // proposal's text or source label. Paired with the scenario's probe of
      // the partner's need labels (KNOWN leaks below): on the target the text
      // may change, the label may not reappear.
      // Fix round 2: pinned to Ada's READ steps (the probed ones); Bob's write
      // responses (which carry Ada's labels) are compared byte for byte.
      kind: 'mayDiffer',
      at: ADA_READ_STEPS.flatMap(i =>
        [
          'walkthrough.currentNeed.label',
          'walkthrough.ownNeeds.*.label',
          'walkthrough.partnerNeeds.*.label',
          '**.needsAddressed.*.label',
          'inventory.unaddressedNeeds.*.label',
          'coverageAudit.*.*.label',
        ].map(s => `steps.${i}.body.data.${s}`),
      ),
      mustMatch: true,
      why:
        'spec §1.4 v_need_coverage over need_share: a need named in Stage 4 is its shared text, not the label ' +
        'Stage4NeedCoverage copied (plan step 8: coverage is computed, not copied).',
};

/**
 * TS-11 post-merge — the rules both comparisons carry on the target: the
 * TS-9/TS-10 fixture deltas (user name, compact and feel-heard instants, the
 * list's unread flag) and the Stage 4 state computed from v_need_coverage
 * (R29). Defined below; a function so the declarations after it are
 * initialised when it runs.
 */
/**
 * R29 post-merge: the needs the target's Stage 4 state lists that today's
 * coverage-less fixture did not — each pinned at its step and list (one
 * `addedEntries` per need), and the instants whose RANK moves because the
 * fixture's coverage rows (and the stage-4 row's startedAt) carried an instant
 * the target computes instead. `concept`: the concept golden labels needs
 * `<need:bob@main#2>`, the byte golden `<need:bob#2>`.
 *
 *  - Ada's reads (5, 16, 27): Bob's "Support" is a shared need, listed by its
 *    shared text in her partner phase; Bob's "Understanding" is OPEN in her
 *    inventory until Bob's choices are shared (5, 16) — at 27 his WILLING on
 *    "pause" covers it.
 *  - Bob's write responses (9, 10, 20, 21): his own "Support" in his phase.
 *  - Bob's write responses no longer list Ada's UNSHARED individual
 *    commitment (spec §1.4 proposal RLS: an INDIVIDUAL_COMMITMENT is its
 *    author's until shared_at) — a privacy fix, owner-visible.
 */
function stage4NewlyVisible(concept: boolean): AllowRule[] {
  const id = (who: string, i: number) => (concept ? `<need:${who}@main#${i}>` : `<need:${who}#${i}>`);
  const rules: AllowRule[] = [];
  for (const n of ADA_STAGE4_READ_STEPS) {
    rules.push({
      kind: 'addedEntries',
      at: `steps.${n}.body.data.walkthrough.partnerNeeds`,
      where: { id: id('bob', 2), label: 'Having backup when things pile up', source: 'PARTNER' },
      mustMatch: true,
      why: 'R29: Bob’s shared need (need_share) is listed in Ada’s partner phase by its shared text.',
    });
  }
  for (const n of ADA_STAGE4_READ_STEPS.slice(0, 2)) {
    rules.push({
      kind: 'addedEntries',
      at: `steps.${n}.body.data.inventory.unaddressedNeeds`,
      where: { id: id('bob', 1), label: 'Being heard all the way through', source: 'PARTNER' },
      mustMatch: true,
      why: 'R29: Bob’s shared "Understanding" is OPEN on Ada’s read (v_need_coverage over the choices she may see) until his choices are shared.',
    });
  }
  for (const n of BOB_WRITE_STEPS) {
    rules.push({
      kind: 'addedEntries',
      at: `steps.${n}.body.data.state.walkthrough.ownNeeds`,
      where: { id: id('bob', 2), label: 'Support', source: 'YOU' },
      mustMatch: true,
      why: 'R29: Bob’s own shared need, by his own label, in his own phase.',
    });
    rules.push({
      kind: 'removedEntry',
      at: `steps.${n}.body.data.state.inventory.individualCommitments`,
      where: { id: '<proposal:main#3>', kind: 'INDIVIDUAL_COMMITMENT' },
      mustMatch: true,
      why:
        'spec §1.4 proposal RLS: Ada’s INDIVIDUAL_COMMITMENT is hers until shared (shared_at NULL) — Bob’s state no ' +
        'longer lists it (today it did). The test asserts Bob never reads it.',
    });
  }
  rules.push({
    kind: 'mayDiffer',
    at: STAGE4_STATE_ROOTS.map(r => `${r}.walkthrough.totalInPhase`),
    mustMatch: true,
    why: 'R29: the phase counts the shared needs listed above.',
  });
  rules.push({
    kind: 'mayDiffer',
    at: [
      ...ADA_STAGE4_READ_STEPS.map(n => `steps.${n}.body.data.mySelections.0.updatedAt`),
      'steps.21.body.data.state.partnerSelections.0.selectedAt',
      'steps.21.body.data.state.partnerSelections.0.updatedAt',
      'steps.21.body.data.state.inventory.updatedAt',
    ],
    mustMatch: true,
    why:
      'rank shifts: the coverage rows’ instant (coverageAudit.updatedAt, computed on the target) and the stage-4 row’s ' +
      'startedAt (a milestone on the target) were instants of these steps, so the later ranks move down. The test ' +
      'asserts the raw values are their rows’ instants.',
  });
  return rules;
}

const SHARED_RULES = (concept: boolean): AllowRule[] => [
  ...READ_DTO_RULES,
  TARGET_USER_NAME_RULE,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_FEEL_HEARD_MASK,
  NEED_LABEL_RULE,
  {
    kind: 'mayDiffer',
    at: ADA_SESSION_LIST_STEPS.map(n => `steps.${n}.body.data.items.0.hasUnread`),
    mustMatch: true,
    why:
      'TS-9: unread comes from v_conversation_unread (messages after last_viewed_at not sent by the reader); the old ' +
      'list called a never-viewed ACTIVE session unread. The test asserts the flag equals the view.',
  },
  ...stage4ComputedRules(),
  ...stage4NewlyVisible(concept),
];

/**
 * TS-11 post-merge, ruling R30: the repair fixture's `initial` image. The
 * target writer writes the shared needs the target's repair stage needs
 * (need_share + the owner's GRANTED consent, stamped at the share instant so
 * no new rank appears) and links each proposal to its needs (proposal_need)
 * where today's rows kept the labels unresolved. The current-shape writer is
 * byte-unchanged (`unconsentedNeedShares`; fixture-scenarios unit test). Plus
 * the TS-9 attempt deltas (empathy_submitted, revealed_at).
 */
function initialRepairFixtureDeltas(): AllowRule[] {
  const who = (k: string) => (k.startsWith('ada') ? 'ada' : 'bob');
  const needs = ['ada@main#1', 'ada@main#2', 'bob@main#1', 'bob@main#2'];
  const links: Array<[number, string]> = [
    [1, 'ada@main#2'],
    [1, 'bob@main#2'],
    [2, 'bob@main#1'],
    [3, 'ada@main#1'],
    [4, 'ada@main#2'],
  ];
  return [
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
    ...needs.map(n => ({
      kind: 'addedEntries' as const,
      at: 'initial.need_share',
      where: { $key: `<need:${n}>`, need_id: `<need:${n}>`, participant_id: `<participant:${who(n)}@main>`, revoked_at: null },
      mustMatch: true,
      why: `R30: ${n} is shared in the repair fixture (scenario \`shared: { text }\`); the target writes its need_share row.`,
    })),
    ...needs.map(n => ({
      kind: 'addedEntries' as const,
      at: 'initial.consent',
      where: {
        $key: `<consent:${who(n)}@main/NEED/need:${n}>`,
        need_id: `<need:${n}>`,
        decision: 'GRANTED',
        participant_id: `<participant:${who(n)}@main>`,
      },
      mustMatch: true,
      why: `R30: the owner’s GRANTED consent for sharing ${n} (the target’s share needs it; today’s fixture wrote none).`,
    })),
    ...links.map(([i, n]) => ({
      kind: 'addedEntries' as const,
      at: 'initial.proposal_need',
      where: { $key: `<proposalNeed:proposal:main#${i}/need:${n}>`, proposal_id: `<proposal:main#${i}>`, need_id: `<need:${n}>` },
      mustMatch: true,
      why: `R30: proposal ${i} addresses ${n} — a proposal_need over need_share (today an unresolved label).`,
    })),
    {
      kind: 'mayDiffer',
      at: [1, 2, 3, 4].map(i => `initial.proposal.<proposal:main#${i}>.unresolved_need_labels`),
      mustMatch: true,
      why:
        'R30: the labels today’s rows left unresolved are resolved on the target (the proposal_need rows above); the ' +
        'test asserts each proposal’s run value is [] and its links name exactly the baseline’s labels.',
    },
  ];
}

export const CHOICES_HIDDEN_UNTIL_SHARED_ALLOW: AllowList = {
  scenario: 'choices-hidden-until-shared',
  rules: [
    ...SHARED_RULES(true),
    ...initialRepairFixtureDeltas(),
    {
      kind: 'addedEntries',
      at: 'steps.20.changes',
      where: {
        view: 'need_disposition',
        kind: 'added',
        key: '<needDisposition:participant:bob@main/need:ada@main#1>',
        'after.need_id': '<need:ada@main#1>',
        'after.participant_id': '<participant:bob@main>',
        'after.status': 'DECLINED',
      },
      mustMatch: true,
      why:
        'Bob sets aside Ada’s shared need: a need_disposition row over need_share (spec §1.4). The current-shape view ' +
        'joins old_concept_need_share, which this fixture lacks (F2), so the baseline recorded none.',
    },
  ],
  targetOnly: [
    {
      assertion:
        'proposal_need and need_disposition are NON-EMPTY after the share, and every need_id they name is a need_share ' +
        'id (spec §7 "can never name an unshared need").',
      why:
        'On the current shape the check is tautological: the views join old_concept_need_share, so they can only name ' +
        'need_share ids, and this fixture has none (the scenario pins that they are empty). Only the target can make ' +
        'the assertion bite.',
    },
    {
      assertion:
        'v_session_closure_items names only need_share ids: close Stage 4 with an open shared need and an unshared ' +
        'one; the closure items list the shared one only.',
      why:
        'Closing needs every open need addressed or set aside and both partners’ choices shared; on today’s fixtures ' +
        'no need has a need_share row (TS-5 finding F2), so the "unshared vs shared" distinction the assertion needs ' +
        'cannot be built on the current shape. Recorded for the target re-record.',
    },
  ],
};

/** Choices: observed against the current code (none); see `privacy.ts` for the contract. */
export const CHOICES_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS: KnownLeak[] = [];

/**
 * The partner's need labels in Ada's reads — TS-11 (work-a39h.11.21): EMPTY.
 * The three entries recorded `<phase>: stage4 as ada@e2e.test ⊃ bob need label
 * Support` (finding "R4: GET /sessions/:id/stage4 shows a partner's private
 * need label (Stage4NeedCoverage.needLabel)"); on the target a partner's need
 * is named by its need_share.shared_text, so they are closed and deleted.
 */
export const CHOICES_NEED_LABEL_KNOWN_LEAKS: KnownLeak[] = [];

/**
 * Ada's need labels in Bob's write responses — TS-11 (work-a39h.11.21): EMPTY.
 * The eight entries recorded `<write step> ⊃ ada need label Partnership|Appreciation`
 * (finding F-R4-3, "Stage 4 write responses return the Stage 4 state with the
 * partner's private need labels"); closed on the target the same way.
 */
export const CHOICES_BOB_WRITES_KNOWN_LEAKS: KnownLeak[] = [];

export const CHOICES_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'choices-hidden-until-shared',
  rules: [
    ...SHARED_RULES(false),
    ...targetByteRules({
      addedTables: [
        { step: 21, table: 'participant_milestone', kind: 'added', count: 1, why: 'Bob’s choices_shared milestone (the old selectionSubmitted gate)' },
      ],
      droppedTables: [
        { step: 21, table: 'StageProgress', kind: 'changed', why: 'the selectionSubmitted gate update is a participant_milestone INSERT on the target' },
      ],
    }),
  ],
};
