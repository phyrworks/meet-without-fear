/**
 * Session DTOs
 *
 * Data Transfer Objects for session-related API operations.
 */

import { SessionStatus, Stage, StageStatus } from '../enums';

// ============================================================================
// Session Summary (for lists and cards)
// ============================================================================

/**
 * Status summary for display in session list.
 * Generated server-side to provide meaningful, human-readable status messages.
 */
export interface SessionStatusSummary {
  /** What the user should know about their own status, e.g., "You've shared your perspective" */
  userStatus: string;
  /** What's happening with the partner, e.g., "Waiting for Jason to share theirs" */
  partnerStatus: string;
}

export interface SessionSummaryDTO {
  id: string;
  status: SessionStatus;
  createdAt: string; // ISO 8601
  updatedAt: string;

  // Partner info (minimal - just what's needed for display)
  partner: {
    id: string;
    name: string | null;
    nickname: string | null; // What I call my partner: my own contact entry (invite name, or PATCH /contacts/:userId/nickname)
  };

  // Stage progress (both users)
  myProgress: StageProgressDTO;
  partnerProgress: StageProgressDTO;

  // Human-readable status summary for session list display
  statusSummary: SessionStatusSummary;

  // Computed helpers for UI (kept for backwards compatibility)
  selfActionNeeded: string[]; // Gate keys the user still needs
  partnerActionNeeded: string[]; // Gate keys partner must satisfy to unlock next stage

  // Unread tracking - indicates if there's new content since user last viewed
  hasUnread: boolean;
  // When user last viewed this session (null = never viewed)
  lastViewedAt: string | null;
  // ID of last chat item seen (for "new messages" line placement in chat)
  lastSeenChatItemId: string | null;
}

export interface StageProgressDTO {
  stage: Stage;
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
}

// ============================================================================
// Session Detail (full session view)
// ============================================================================

export interface SessionDetailDTO extends SessionSummaryDTO {
  // Stage gate status (for current stage)
  currentGates: StageGateDTO[];

  // Resolution info (if resolved)
  resolvedAt: string | null;

  selfActionNeeded: string[];
  partnerActionNeeded: string[];
}

export interface StageGateDTO {
  id: string;
  description: string;
  satisfied: boolean;
  requiredForAdvance: boolean;
}

// ============================================================================
// Session Creation
// ============================================================================

export interface CreateSessionRequest {
  // Either invite an existing person or provide a name
  personId?: string;

  // OR provide a display name for the new person
  inviteName?: string; // What you call them (nickname)

  // Optional: initial context
  context?: string; // What this session is about (private to creator)

  // Optional: link to Inner Thoughts session that originated this partner session
  innerThoughtsId?: string;
  // Optional: Inner Thoughts message where the user tapped the start-session action
  linkedAtMessageId?: string;

  // Explicit confirmation that the user wants another session despite an active one
  forceCreate?: boolean;
}

export interface CreateSessionResponse {
  session: SessionSummaryDTO;
  invitationId: string;
  invitationUrl: string;
}

// ============================================================================
// Session Invitation
// ============================================================================

export interface InvitationDTO {
  id: string;
  sessionId: string;
  invitedBy: {
    id: string;
    name: string | null;
  };
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  /** Whether the user has confirmed the invitation message */
  messageConfirmed?: boolean;
  /** When the user confirmed the invitation message (for chat indicator positioning) */
  messageConfirmedAt?: string | null;
  /** AI-finalized neutral topic frame shown to the invited user */
  topicFrame?: string | null;
  /** When the topic frame was finalized */
  topicFrameConfirmedAt?: string | null;
  /**
   * The inviter's view only, while the invitation is PENDING or DECLINED: who opened it first and
   * so is its invitee (work-k5fk.10.8). Absent until it is claimed, and once accepted.
   */
  claimedBy?: InvitationClaimantDTO;
}

/**
 * The first signed-in person other than the inviter to open an invitation: its invitee, the only
 * one who may accept or decline it (work-k5fk.10.8). Shown to the inviter.
 */
export interface InvitationClaimantDTO {
  id: string;
  name: string | null;
  claimedAt: string;
}

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  EXPIRED = 'EXPIRED',
}

export interface AcceptInvitationRequest {
  invitationId: string;
}

export interface AcceptInvitationResponse {
  session: SessionSummaryDTO;
}

export interface DeclineInvitationRequest {
  reason?: string;
}

export interface DeclineInvitationResponse {
  declined: boolean;
  declinedAt: string;
}

export interface ResendInvitationResponse {
  sent: boolean;
  sentAt: string;
  expiresAt: string;
}

// ============================================================================
// Session Read State
// ============================================================================

/**
 * Request to mark a session as viewed (updates lastViewedAt and lastSeenChatItemId)
 */
export interface MarkSessionViewedRequest {
  /**
   * Optional: the seq of the newest message of the caller's conversation visible to
   * them (for the "new messages" line; work-k5fk.4). The response's
   * lastSeenChatItemId is that message's id, or null when it is not one.
   */
  lastSeenSeq?: number;
}

/**
 * Response after marking session as viewed
 */
export interface MarkSessionViewedResponse {
  success: boolean;
  lastViewedAt: string;
  lastSeenChatItemId: string | null;
}

/**
 * Request to mark a received shared frame ("Context from X" / "Feedback from X")
 * as shown on the recipient's screen. POST /sessions/:id/shared-context-viewed
 */
export interface MarkSharedContextViewedRequest {
  /** The SHARED_CONTEXT / VALIDATION_FEEDBACK message delivered to the caller */
  messageId: string;
}

/**
 * Response after marking a shared frame viewed.
 */
export interface MarkSharedContextViewedResponse {
  success: boolean;
  /** False when the frame was already covered (nothing written, nothing published) */
  advanced: boolean;
  /** The caller's stored viewed instant (covers this frame and every older one) */
  lastViewedSharedContextAt: string;
}

/**
 * Response for getting unread session count (for tab badge)
 */
export interface UnreadSessionCountResponse {
  count: number;
}

// ============================================================================
// Contact Nickname — PATCH /contacts/:userId/nickname (work-k5fk.2)
//
// What the caller calls another user they share a session with: the caller's
// own contact entry, never shown to that user.
// ============================================================================

export interface UpdateNicknameRequest {
  nickname: string | null;
}

export interface UpdateNicknameResponse {
  nickname: string | null;
}

// ============================================================================
// People (the other humans the user shares sessions with)
// ============================================================================

export interface PersonSummaryDTO {
  id: string;
  name: string;
  nickname: string | null;
  initials: string;
  connectedSince: string;
  lastSession: {
    id: string;
    status: string;
    updatedAt: string;
  } | null;
  /** Number of active (non-terminal) sessions with this person */
  activeSessionCount: number;
}

export interface ListPeopleResponse {
  people: PersonSummaryDTO[];
}

// ============================================================================
// Archive Session
// ============================================================================

export interface ArchiveSessionResponse {
  archived: boolean;
  archivedAt: string;
}
