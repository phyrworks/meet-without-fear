/**
 * Allow-list and known leaks for `author-sees-status-only` (golden R6).
 *
 * Plan §4 R6 (P1-15): the author's full read and prompt context contain no
 * `reconciler_result` detail, no `context_share_offer` text, no unsent
 * `empathy_review.feedback`; only `v_empathy_direction_status` rows and
 * `reconciler_guidance`.
 *
 * The target re-record may change only what every read carries (DTO rules).
 * The known leaks below are today's code; each must disappear on the target,
 * at which point the scenario fails until the entry is removed.
 */

import type { KnownLeak } from '../privacy';
import { READ_DTO_RULES } from './common';
import type { AllowList } from './types';

export const AUTHOR_SEES_STATUS_ONLY_ALLOW: AllowList = {
  scenario: 'author-sees-status-only',
  rules: [...READ_DTO_RULES],
};

const F_STATUS =
  'R6/P1-15: GET /sessions/:id/empathy/status returns the author her own reconciler gapSummary (myReconcilerResult)';
const F_RECONCILER_STATUS =
  'R6/P1-15: GET /sessions/:id/reconciler/status returns the full reconciler_result of the caller-authored direction (alignment, gaps, missed feelings, rationale, share focus) to its author';
const F_RECONCILER_RUN =
  'R6/P1-15: POST /sessions/:id/reconciler/run returns both directions’ full analysis to any participant, author included';

const leak = (at: string, finding: string, evidence: string): KnownLeak => ({ at, finding, evidence });

/** Observed against the current code; see `privacy.ts` for the contract. */
export const AUTHOR_SEES_STATUS_ONLY_KNOWN_LEAKS: KnownLeak[] = [
  leak(
    'author: empathy status as ada@e2e.test ⊃ result.gapSummary',
    F_STATUS,
    'body.data.myReconcilerResult = {gapSeverity, action, analyzedAt, gapSummary} — gapSummary is reconciler_result detail ' +
      '(controllers/stage2.ts getEmpathyStatus via services/empathy-status.ts)',
  ),
  ...[
    'result.alignmentSummary',
    'result.gapSummary',
    'result.missedFeelings',
    'result.mostImportantGap',
    'result.rationale',
    'result.suggestedShareFocus',
  ].flatMap(probe => [
    leak(
      `author: reconciler status as ada@e2e.test ⊃ ${probe}`,
      F_RECONCILER_STATUS,
      'body.data.aUnderstandingB.result = the whole analysis of Ada→Bob (controllers/reconciler.ts getReconcilerStatusHandler)',
    ),
    leak(
      `reconciler run as ada@e2e.test ⊃ ${probe}`,
      F_RECONCILER_RUN,
      'body.data.aUnderstandingB.result (and bUnderstandingA) = the analysis, returned to the caller ' +
        '(controllers/reconciler.ts runReconcilerHandler)',
    ),
  ]),
];
