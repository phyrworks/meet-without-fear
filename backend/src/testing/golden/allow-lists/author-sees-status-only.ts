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
import type { AllowList, AllowRule, PendingClusterRule, RankShift, RefusedStepRule } from './types';

/**
 * Ruling R31: the author's full read includes reads of clusters not yet on
 * this branch, which answer 500 on the target until they land. The leak
 * probes still scan them; their bodies (an error envelope) cannot carry a
 * probe. Delete each entry when its cluster lands (a listed read answering
 * 200 fails).
 *
 * Ruling R37: only status and the error body are blurred. A carried timestamp
 * that the 500 shifts in its step's changes is pinned here, by step and path
 * (`rankShifts`), per scenario: the `stage4` read touches `user.updated_at`,
 * and without the 200 body's instants the user's `created_at` ranks one lower.
 */
const PENDING_READS: PendingClusterRule['reads'] = [
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
];

/** The `stage4` read's one shifted rank (measured: `<ts:2>` → `<ts:1>`), at the named steps. */
export const stage4UserCreatedAtShift = (steps: string[]): RankShift[] =>
  steps.flatMap(step =>
    (['changes.0.after.created_at', 'changes.0.before.created_at'] as const).map(at => ({
      step,
      at,
      from: '<ts:2>' as const,
      to: '<ts:1>' as const,
    })),
  );

export const r6r7PendingCluster = (shifts: Partial<Record<string, RankShift[]>> = {}): PendingClusterRule => ({
  kind: 'pendingCluster',
  at: 'steps',
  mustMatch: true,
  reads: PENDING_READS.map(r => (shifts[r.read] ? { ...r, rankShifts: shifts[r.read] } : r)),
  why:
    'ruling R31: these reads belong to TS-11 (needs, repair, follow-up) and TS-12 (reflection, wellbeing), which are ' +
    'not on this branch; on the target they answer 500 until their cluster lands. Ruling R37: rank shifts pinned.',
});

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
  r6r7PendingCluster(concept ? { stage4: stage4UserCreatedAtShift(['author: stage4 as ada@e2e.test']) } : {}),
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
