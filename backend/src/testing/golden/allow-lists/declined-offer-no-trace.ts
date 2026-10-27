/**
 * Allow-list, permitted status paths and known traces for
 * `declined-offer-no-trace` (golden R7).
 *
 * Plan §4 R7: after the subject declines, the author's reads (incl.
 * `consent`) are unchanged from before the offer. Spec §7: declining a share
 * suggestion leaves no author-visible trace (`consent` has no requester read
 * arm; share-offer consents have no requester at all; `context_share_offer`
 * is subject-only — P1-4).
 *
 * The target re-record may change only what every read carries. The one known
 * trace of today's code (the author's reconciler/status `pendingShareOffers`
 * dropping 1 → 0, work-a39h.11.22) is CLOSED on the target (TS-10) and its
 * entry deleted: the author's reconciler/status counts only her own offers.
 */

import type { KnownLeak } from '../privacy';
import { r6r7PendingCluster, stage4UserCreatedAtShift } from './author-sees-status-only';
import {
  authorAnalysisClosed,
  byteLabelShift,
  declineConsent,
  empathySubmittedMilestone,
  READ_DTO_RULES,
  targetByteRules,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_ROUND_KEYS_RULE,
  TARGET_USER_NAME_RULE,
} from './common';
import type { AllowList, AllowRule } from './types';

/** Step layout: [before 0–30 (empathy status 7, reconciler status 11, summary 13), decline 31, after 32–62 (+32)]. */
const DECLINE_STEP = 31;

const bodyRules = (concept: boolean): AllowRule[] => [
  ...READ_DTO_RULES,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  TARGET_ROUND_KEYS_RULE,
  r6r7PendingCluster(
    concept
      ? { stage4: stage4UserCreatedAtShift(['before decline: stage4 as ada@e2e.test', 'after decline: stage4 as ada@e2e.test']) }
      : {},
  ),
  ...authorAnalysisClosed({ empathyStatus: [7, 39], reconcilerStatus: [11, 43], summary: [13, 45], concept }),
];

export const DECLINED_OFFER_NO_TRACE_ALLOW: AllowList = {
  scenario: 'declined-offer-no-trace',
  rules: [
    ...bodyRules(true),
    TARGET_USER_NAME_RULE,
    empathySubmittedMilestone('ada', 'initial', '<ts:14>'),
    empathySubmittedMilestone('bob', 'initial', '<ts:24>'),
    declineConsent(DECLINE_STEP),
  ],
  targetOnly: [
    {
      assertion:
        'Compare the author’s reads after the decline with her reads BEFORE THE OFFER WAS MADE (a fixture without a ' +
        'reconciler result), not only before the decline.',
      why:
        'Gap recorded in fix round 1 (I5): this baseline already contains the offer (the fixture restores with it, and ' +
        'MOCK_LLM never makes one), so a trace that is constant from offer to decline — one that proves an offer ' +
        'EXISTS — passes this scenario. TS-10 implements it: after the recorded steps the analysis of Ada’s attempt ' +
        '(with its offer and Bob’s consent) is removed and Ada reads again; the two reads must be equal.',
    },
  ],
};

/** The byte-level golden on the TARGET shape (TS-10): body rules + changesMapped (ruling R32). */
export const DECLINED_OFFER_NO_TRACE_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'declined-offer-no-trace',
  rules: [
    ...bodyRules(false),
    byteLabelShift(['steps.15.body.data.records.0.id', 'steps.47.body.data.records.0.id'], 'consent'),
    ...targetByteRules({
      addedTables: [{ step: DECLINE_STEP, table: 'consent', kind: 'added', count: 1, why: "the subject's DENIED consent naming the offer" }],
    }),
  ],
};

/**
 * The direction's status, which the author may see change (it is
 * `v_empathy_direction_status`): `<read name>` + normalised body path.
 */
export const DECLINE_STATUS_PATHS: Array<{ read: string; path: string }> = [
  // AWAITING_SHARING → READY: the author's own direction status.
  { read: 'empathy status as ada@e2e.test', path: 'body.data.myAttempt.status' },
  // The DTO's boolean restatement of that status (`status === AWAITING_SHARING`).
  { read: 'empathy status as ada@e2e.test', path: 'body.data.awaitingSharing' },
];

/** Differences observed against the current code that are traces of the decline. All closed on the target (TS-10). */
export const DECLINED_OFFER_NO_TRACE_KNOWN_TRACES: KnownLeak[] = [];
