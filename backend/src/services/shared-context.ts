/**
 * Shared Content Context Service
 *
 * The two prompt sections about the session as a whole — what has been shared
 * ("## What has been shared in this conversation") and the participant's
 * process milestones — for callers that hold a (session, user) pair.
 *
 * Target shape (TS-9): this module reads nothing itself. Both sections come
 * from `buildContextForParticipant` (context-assembler.ts), the single code
 * path that may read another participant's rows, and only from its shared
 * vessel. The ad-hoc partner reads that lived here (every REVEALED attempt of
 * the session, every delivered share offer, every EMPATHY_STATEMENT /
 * SHARED_CONTEXT message by recipient or sender, every active consented
 * content row) are gone.
 */

import { buildContextForParticipant, formatSharedContentHistory } from './context-assembler';
import { resolveParticipant } from './participant-resolver';
import type { MemoryIntentResult } from './memory-intent';

/** The minimal intent: the two sections need no conversation or memory depth. */
const SECTIONS_ONLY: MemoryIntentResult = {
  intent: 'stage_enforcement',
  depth: 'none',
  reason: 'shared-context sections',
  threshold: 1,
  maxCrossSession: 0,
  allowCrossSession: false,
  surfaceStyle: 'silent',
};

async function sections(sessionId: string, userId: string) {
  const participant = await resolveParticipant(sessionId, userId);
  if (!participant) return null;
  return buildContextForParticipant(participant.id, { intent: SECTIONS_ONLY });
}

/**
 * The participant's process milestones (Invitation Sent, compact signed,
 * feel heard, …) for injection into AI prompts, or null if none.
 */
export async function getMilestoneContext(sessionId: string, userId: string): Promise<string | null> {
  return (await sections(sessionId, userId))?.milestoneContext ?? null;
}

/**
 * What has been shared in the session, from this participant's point of view:
 * revealed empathy statements, shared context, shared needs. Null if nothing.
 */
export async function getSharedContentContext(sessionId: string, userId: string): Promise<string | null> {
  const ctx = await sections(sessionId, userId);
  if (!ctx) return null;
  // The section exists from Stage 2 on; asked for explicitly here, so build it
  // whatever the current stage (the callers gate on stage themselves).
  return formatSharedContentHistory(ctx.sharedVessel);
}
