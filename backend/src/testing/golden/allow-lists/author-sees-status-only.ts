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
import type { AllowList, AllowRule, RefusedStepRule } from './types';

/**
 * Fix round 1, m1: on the target Bob cannot save a validation-feedback draft
 * about Ada's UNREVEALED round — the subject never reads an unrevealed row,
 * not even for its id, so the endpoint answers 404 and writes no draft. The
 * baseline recorded the draft (today's code read the row). Paired with the
 * scenario's step-0 assertion ("the probes are live", target branch). The
 * `unsent feedback` probe stays in PROBES; on the target nothing can hold it
 * before the reveal (review-visibility.target.test.ts covers an unsent draft
 * after the reveal).
 */
export const R6_REFUSED_UNREVEALED_DRAFT: RefusedStepRule = {
  kind: 'refusedStep',
  at: 'steps',
  mustMatch: true,
  label: 'unsent feedback draft as bob',
  status: 404,
  code: 'NOT_FOUND',
  droppedWrites: [
    { table: 'ValidationFeedbackDraft', kind: 'added' },
    { table: 'draft', kind: 'added' },
  ],
  why: 'fix round 1 m1: a draft never points at an unrevealed round; the target refuses the step the baseline recorded.',
};

/** Step layout: [draft 0, full read 1–31 (empathy status 8, reconciler status 12, summary 14), run 32, turn 33]. */
const bodyRules = (concept: boolean): AllowRule[] => [
  ...READ_DTO_RULES,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  R6_REFUSED_UNREVEALED_DRAFT,
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
    ...targetByteRules({
      addedTables: [{ step: 33, table: 'draft', kind: 'changed', count: 1, why: 'the mock response’s proposed statement (mockTurnIndex)' }],
    }),
  ],
};

/** Observed against the current code; see `privacy.ts` for the contract. All closed on the target (TS-10). */
export const AUTHOR_SEES_STATUS_ONLY_KNOWN_LEAKS: KnownLeak[] = [];
