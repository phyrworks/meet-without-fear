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
import { READ_DTO_RULES } from './common';
import type { AllowList, AllowRule } from './types';

export const NEEDS_HIDDEN_UNTIL_SHARED_ALLOW: AllowList = {
  scenario: 'needs-hidden-until-shared',
  rules: [
    ...READ_DTO_RULES,
    {
      kind: 'mayDiffer',
      at: 'steps.*.body.data.partnerNeeds.*.need',
      mustMatch: true,
      why:
        'spec §1.4 v_need_shared / §7: the partner reads need_share.shared_text, never need.label. The scenario’s ' +
        'probe assertion pins that the label is gone; this rule only lets the text differ.',
    },
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
// compared by TS-10's `changesMapped` once phoenix/target-shape carries it
// (rulings R27/R28) — added in the post-merge round.

/** The Stage 4 reads of this scenario (the step layout the test pins). */
export const NEEDS_STAGE4_READ_STEPS = { nothingShared: 8, bobShared: 20, bothAda: 32, bothBob: 43 } as const;

/** The partner's shared text under MOCK_LLM: the job's category fallback (services/needs-share.ts). */
const SHARED_TEXT: Record<string, string> = {
  SAFETY: 'Feeling safe and settled',
  RECOGNITION: 'Being seen and appreciated',
  AUTONOMY: 'Having room to choose for myself',
};

function stage4SharedNeedRules(): AllowRule[] {
  const own = (step: number) => `steps.${step}.body.data`;
  const needs = {
    ada: [
      { id: '<need:ada#1>', label: 'Rest without having to earn it first', category: 'AUTONOMY' },
      { id: '<need:ada#2>', label: 'Being thanked out loud for the invisible work', category: 'RECOGNITION' },
    ],
    bob: [
      { id: '<need:bob#1>', label: 'A quiet first hour after work', category: 'SAFETY' },
      { id: '<need:bob#2>', label: 'Credit for the effort even when the result is late', category: 'RECOGNITION' },
    ],
  };
  const rules: AllowRule[] = [];
  for (const [step, reader, partner] of [
    [NEEDS_STAGE4_READ_STEPS.bothAda, 'ada', 'bob'],
    [NEEDS_STAGE4_READ_STEPS.bothBob, 'bob', 'ada'],
  ] as const) {
    const base = own(step);
    const named = [
      ...needs[reader].map(n => ({ id: n.id, label: n.label, source: 'YOU' })),
      ...needs[partner].map(n => ({ id: n.id, label: SHARED_TEXT[n.category], source: 'PARTNER' })),
    ];
    rules.push({
      kind: 'mayDiffer',
      at: [`${base}.walkthrough.currentNeed`, `${base}.walkthrough.phase`, `${base}.walkthrough.totalInPhase`, `${base}.coverageAudit.updatedAt`],
      mustMatch: true,
      why: 'R29: the walkthrough starts on the reader’s first shared need (MY_NEEDS) instead of the empty QUALITY_REVIEW today’s coverage-less fixture gives.',
    });
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

export const NEEDS_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'needs-hidden-until-shared',
  rules: [...NEEDS_HIDDEN_UNTIL_SHARED_ALLOW.rules, ...stage4SharedNeedRules()],
};
