/**
 * In-memory reductions over a user's needs-assessment scores (TS-12).
 *
 * The four raw `DISTINCT ON ("needId") … ORDER BY "needId", "createdAt" DESC`
 * queries over NeedScore (meditation, gratitude ×2, cross-feature context) and
 * the ROW_NUMBER() "previous score" query (needs state) become these pure
 * functions over the `needs_assessment` document's `scores[]` (spec §6
 * "Wellbeing → documents").
 */

import type { NeedScoreDoc } from '@meet-without-fear/shared';

/** Scores of one need, newest first (createdAt desc; ties by id, deterministic). */
function newestFirst(scores: NeedScoreDoc[]): NeedScoreDoc[] {
  return [...scores].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** The latest score of every scored need, ordered by need id — the DISTINCT ON. */
export function latestNeedScores(scores: NeedScoreDoc[]): NeedScoreDoc[] {
  const latest = new Map<number, NeedScoreDoc>();
  for (const s of newestFirst(scores)) if (!latest.has(s.needId)) latest.set(s.needId, s);
  return [...latest.values()].sort((a, b) => a.needId - b.needId);
}

/** The second-latest score of every need that has one — the ROW_NUMBER() = 2 query. */
export function previousNeedScores(scores: NeedScoreDoc[]): Map<number, NeedScoreDoc> {
  const seen = new Map<number, number>();
  const previous = new Map<number, NeedScoreDoc>();
  for (const s of newestFirst(scores)) {
    const n = (seen.get(s.needId) ?? 0) + 1;
    seen.set(s.needId, n);
    if (n === 2) previous.set(s.needId, s);
  }
  return previous;
}

/** One need's history, newest first, at most `limit`. */
export function needHistory(scores: NeedScoreDoc[], needId: number, limit: number): NeedScoreDoc[] {
  return newestFirst(scores.filter(s => s.needId === needId)).slice(0, limit);
}
