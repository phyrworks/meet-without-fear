/**
 * Allow-list and known leaks for `author-sees-status-only` (golden R6).
 *
 * Plan §4 R6 (P1-15): the author's full read and prompt context contain no
 * `reconciler_result` detail, no `context_share_offer` text, no unsent
 * `empathy_review.feedback`; only `v_empathy_direction_status` rows and
 * `reconciler_guidance`.
 *
 * The target re-record may change only what every read carries (DTO rules).
 * The known leaks of today's code (work-a39h.11.22) are CLOSED on the target
 * (TS-10) and their entries deleted: the author's `myReconcilerResult`
 * (empathy/status), the analysis of her direction in reconciler/status and
 * reconciler/run, and every trace of the offer's existence
 * (`pendingShareOffers`, `recommendation`, `action: OFFER_SHARING`). Each
 * closure is a pinned `mayDiffer` (`authorAnalysisClosed`) paired with the
 * probes, which must now find nothing.
 */

import type { KnownLeak } from '../privacy';
import {
  byteLabelShift,
  mockTurnIndex,
  TARGET_ROUND_KEYS_RULE,
  authorAnalysisClosed,
  empathySubmittedMilestone,
  READ_DTO_RULES,
  targetByteRules,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_USER_NAME_RULE,
} from './common';
import type { AllowList, AllowRule, PendingClusterRule } from './types';

/**
 * Ruling R31: the author's full read includes reads of clusters not yet on
 * this branch, which answer 500 on the target until they land. The leak
 * probes still scan them; their bodies (an error envelope) cannot carry a
 * probe. Delete each entry when its cluster lands (a listed read answering
 * 200 fails).
 */
export const R6_R7_PENDING_CLUSTER: PendingClusterRule = {
  kind: 'pendingCluster',
  at: 'steps',
  mustMatch: true,
  reads: [
    { read: 'emotions', owner: 'TS-12' },
    { read: 'needs', owner: 'TS-11' },
    { read: 'needs comparison', owner: 'TS-11' },
    { read: 'stage4', owner: 'TS-11' },
    { read: 'strategies', owner: 'TS-11' },
    { read: 'agreements', owner: 'TS-11' },
    { read: 'tending', owner: 'TS-11' },
    { read: 'tending history', owner: 'TS-11' },
    { read: 'inner thoughts', owner: 'TS-12' },
    { read: 'inner thoughts list', owner: 'TS-12' },
    { read: 'inner work list', owner: 'TS-12' },
    { read: 'knowledge base recent', owner: 'TS-12' },
    { read: 'knowledge base themes', owner: 'TS-12' },
  ],
  why:
    'ruling R31: these reads belong to TS-11 (needs, repair, follow-up) and TS-12 (reflection, wellbeing), which are ' +
    'not on this branch; on the target they answer 500 until their cluster lands.',
};

/** Step layout: [draft 0, full read 1–31 (empathy status 8, reconciler status 12, summary 14), run 32, turn 33]. */
const bodyRules = (concept: boolean): AllowRule[] => [
  ...READ_DTO_RULES,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  R6_R7_PENDING_CLUSTER,
  TARGET_ROUND_KEYS_RULE,
  ...authorAnalysisClosed({ empathyStatus: [8], reconcilerStatus: [12], reconcilerRun: [32], summary: [14], concept }),
  ...mockTurnIndex(33, concept, 'ada'),
];

export const AUTHOR_SEES_STATUS_ONLY_ALLOW: AllowList = {
  scenario: 'author-sees-status-only',
  rules: [
    ...bodyRules(true),
    TARGET_USER_NAME_RULE,
    empathySubmittedMilestone('ada', 'initial', '<ts:14>'),
    empathySubmittedMilestone('bob', 'initial', '<ts:24>'),
  ],
};

/** The byte-level golden on the TARGET shape (TS-10): body rules + changesMapped (ruling R32). */
export const AUTHOR_SEES_STATUS_ONLY_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'author-sees-status-only',
  rules: [
    ...bodyRules(false),
    byteLabelShift(['steps.16.body.data.records.0.id'], 'consent'),
    {
      kind: 'mayDiffer',
      at: ['steps.0.body.data.draftId'],
      mustMatch: true,
      why:
        'byte-level label scheme: the target labels the one VALIDATION_FEEDBACK draft per (participant, attempt) ' +
        '<feedbackDraft:bob>; today’s table had a per-session row (#1). The concept golden pins it structurally.',
    },
    ...targetByteRules({
      addedTables: [{ step: 33, table: 'draft', kind: 'changed', count: 1, why: 'the mock response’s proposed statement (mockTurnIndex)' }],
    }),
  ],
};

/** Observed against the current code; see `privacy.ts` for the contract. All closed on the target (TS-10). */
export const AUTHOR_SEES_STATUS_ONLY_KNOWN_LEAKS: KnownLeak[] = [];
