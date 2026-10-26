import { prisma } from '../lib/prisma';
import { loadStageStates } from '../services/stage-shim';

interface StageInterval {
  stage: number;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * Resolves which stage a session was in at a given time.
 * Returns a map of sessionId -> stage intervals sorted by start.
 *
 * Target shape (TS-9): there are no StageProgress rows; each participant's
 * old per-stage rows are reconstructed from `participant_milestone` by the
 * stage shim (`loadStageStates`), and every participant's intervals of a
 * session are merged, as every member's StageProgress rows were.
 */
export async function resolveStageIntervalsForSessions(
  sessionIds: string[],
): Promise<Map<string, StageInterval[]>> {
  if (sessionIds.length === 0) return new Map();

  const participants = await prisma.participant.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true, sessionId: true, joinedAt: true },
  });
  const states = await loadStageStates(participants.map(p => ({ id: p.id, joinedAt: p.joinedAt })));

  const sessionIntervals = new Map<string, StageInterval[]>();
  for (const p of participants) {
    const state = states.get(p.id);
    if (!state) continue;
    const list = sessionIntervals.get(p.sessionId) ?? [];
    for (const row of state.rows) {
      if (row.startedAt) list.push({ stage: row.stage, startedAt: row.startedAt, endedAt: row.completedAt });
    }
    sessionIntervals.set(p.sessionId, list);
  }
  for (const list of sessionIntervals.values()) list.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  return sessionIntervals;
}

/**
 * Given stage intervals for a session, resolves the stage active at a specific timestamp.
 * Falls back to stage 0 if no stage progress exists.
 */
export function resolveStageForTimestamp(
  intervals: StageInterval[] | undefined,
  timestamp: Date,
): number {
  if (!intervals || intervals.length === 0) return 0;

  // Find the latest stage that started before or at this timestamp
  let resolvedStage = 0;
  for (const interval of intervals) {
    if (interval.startedAt <= timestamp) {
      resolvedStage = interval.stage;
    }
  }
  return resolvedStage;
}
