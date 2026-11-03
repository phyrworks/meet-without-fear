/**
 * Consolidated Session State DTO
 *
 * Single response containing core session data for efficient initial load.
 * Reduces multiple API calls to a single request.
 *
 * Stage-specific data (empathy drafts, needs, strategies, agreements) are
 * still fetched via individual endpoints to avoid duplicating complex logic.
 */

import { SessionStatus, StageStatus } from '../enums';
import { CompactStatusResponse } from './stage';
import { MessageDTO } from './message';
import type { MilestoneMap } from './milestones';

// ============================================================================
// Consolidated Session State
// ============================================================================

/**
 * Core session data returned by GET /sessions/:id/state
 *
 * Combines essential data needed to render the session view in a single request.
 */
export interface SessionStateResponse {
  // Core session data
  session: {
    id: string;
    status: SessionStatus;
    currentStage: number;
    stageStatus: StageStatus;
    relationshipId: string;
    partner: {
      id: string;
      name: string | null;
      nickname: string | null;
    };
    myProgress: {
      stage: number;
      status: StageStatus;
    };
    createdAt: string;
    resolvedAt: string | null;
    // When the user last viewed this session (for cross-device animation/read boundaries)
    lastViewedAt: string | null;
    // When the other person last viewed this session (for presence details)
    partnerLastViewedAt: string | null;
    // When the other person last actively did something in this session
    partnerLastActiveAt: string | null;
    // ID of last chat item seen (for "new messages" line placement)
    lastSeenChatItemId: string | null;
    // Originating Inner Thoughts session, when this partner session was started from one.
    sourceInnerThoughts: {
      id: string;
      title: string | null;
      summary: string | null;
      theme: string | null;
      contextSummarySnapshot: string | null;
    } | null;
  };

  // Stage progress
  progress: {
    sessionId: string;
    myProgress: {
      stage: number;
      status: string;
      startedAt: string | null;
      completedAt: string | null;
      /** Every milestone the caller has reached (key → reachedAt ISO). */
      milestones: MilestoneMap;
    };
    partnerProgress: {
      stage: number;
      status: string;
      startedAt: string | null;
      completedAt: string | null;
    };
    canAdvance: boolean;
    /** See GetProgressResponse.witnessStartedAt. */
    witnessStartedAt: string | null;
  };

  // Messages (initial page)
  messages: {
    messages: MessageDTO[];
    hasMore: boolean;
    cursor?: string;
  };

  // Stage 0: Onboarding
  invitation: {
    id: string;
    sessionId: string;
    invitedBy: { id: string; name: string | null };
    status: string;
    createdAt: string;
    expiresAt: string;
    messageConfirmed?: boolean;
    messageConfirmedAt?: string | null;
    topicFrame?: string | null;
    topicFrameConfirmedAt?: string | null;
    acceptedAt?: string | null;
    isInviter: boolean;
  } | null;
  compact: CompactStatusResponse;
}
