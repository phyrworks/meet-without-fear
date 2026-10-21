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
import type { AllowList } from './types';

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

const F_LABEL =
  'R4: GET /sessions/:id/needs/comparison returns the partner’s IdentifiedNeed.need (the private label) — there is no shared text in today’s shape';

/** Observed against the current code; see `privacy.ts` for the contract. */
export const NEEDS_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS: KnownLeak[] = [
  ...(
    [
      ['ada', 'bob'],
      ['bob', 'ada'],
    ] as const
  ).flatMap(([reader, owner]) =>
    [1, 2].map(i => ({
      at: `both shared: needs comparison as ${reader}@e2e.test ⊃ ${owner} need ${i} label`,
      finding: F_LABEL,
      evidence:
        `body.data.partnerNeeds[${i - 1}].need = ${owner}'s IdentifiedNeed.need verbatim (controllers/stage3.ts ` +
        'getNeedsComparison maps partner needs from IdentifiedNeed); evidence is not returned.',
    })),
  ),
];

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
