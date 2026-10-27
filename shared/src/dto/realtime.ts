/**
 * Realtime DTOs
 *
 * Data Transfer Objects for real-time WebSocket events between partners.
 */

// ============================================================================
// Partner Presence
// ============================================================================

export enum PresenceStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  AWAY = 'AWAY',
}

export interface PresenceData {
  userId: string;
  status: PresenceStatus;
  lastSeen: number;
  currentStage?: number;
}

export interface PartnerPresenceEvent {
  type: 'presence';
  userId: string;
  status: PresenceStatus;
  timestamp: number;
}

// ============================================================================
// Typing Indicators
// ============================================================================

export interface TypingEvent {
  type: 'typing';
  userId: string;
  sessionId: string;
  isTyping: boolean;
  timestamp: number;
}

// ============================================================================
// Stage Progress
// ============================================================================

export interface StageProgressEvent {
  type: 'stage_progress';
  userId: string;
  sessionId: string;
  stage: number;
  status: 'in_progress' | 'gate_pending' | 'completed';
  timestamp: number;
}

// ============================================================================
// Session State Updates
// ============================================================================

export interface SessionStateEvent {
  type: 'session_state';
  sessionId: string;
  state: 'active' | 'paused' | 'waiting' | 'resolved';
  pausedBy?: string;
  reason?: string;
  timestamp: number;
}

// ============================================================================
// Session Events (existing + enhanced)
// ============================================================================

export type SessionEventType =
  // Partner actions
  | 'partner.signed_compact'
  | 'partner.stage_completed'
  | 'partner.advanced'
  | 'partner.empathy_shared'
  | 'partner.additional_context_shared' // Reconciler: partner shared additional context
  | 'partner.empathy_revealed' // Reconciler: empathy statement was revealed to recipient
  | 'partner.session_viewed' // Partner viewed the session (for delivery status updates)
  | 'partner.share_tab_viewed' // Partner viewed the Share tab (for "seen" delivery status)
  | 'partner.activity' // Partner actively did something in the session
  | 'partner.skipped_refinement' // Partner skipped refinement (agreement to disagree)
  // Empathy reconciler events
  | 'empathy.share_suggestion' // Subject receives suggestion to share context with guesser
  | 'empathy.revealed' // Guesser's empathy was revealed (direction: 'outgoing' | 'incoming')
  | 'empathy.refining' // Guesser should refine their empathy (new context available)
  | 'empathy.context_shared' // Subject shared context with guesser
  | 'empathy.status_updated' // Reconciler completed, empathy statuses changed
  // Stage 3: Need Mapping events
  | 'session.needs_extracted' // Current user's structured needs were captured
  | 'need.captured'
  | 'need.refined'
  | 'need.locked'
  | 'need.deleted'
  | 'partner.needs_confirmed' // Partner confirmed their identified needs
  | 'partner.needs_shared' // Partner consented to share needs
  | 'partner.needs_validated' // Partner validated or rejected side-by-side needs
  | 'session.needs_reveal_ready' // Both users consented; side-by-side needs reveal is ready
  | 'session.common_ground_ready' // Legacy alias for side-by-side needs reveal readiness
  | 'partner.common_ground_confirmed' // Legacy alias for needs validation
  // Stage 4: Strategic Repair events
  | 'session.strategies_updated'
  | 'partner.ranking_submitted'
  | 'partner.ready_to_rank'
  | 'partner.consent_granted'
  | 'partner.consent_revoked'
  // Agreements
  | 'agreement.proposed'
  | 'agreement.confirmed'
  // Session lifecycle
  | 'session.joined'
  | 'session.paused'
  | 'session.resumed'
  | 'session.resolved'
  | 'session.abandoned'
  | 'session.topic_frame_updated' // Stage 0: AI proposed/revised a topic frame draft
  // Invitations
  | 'invitation.declined'
  | 'invitation.confirmed'
  // Presence (new)
  | 'presence.online'
  | 'presence.offline'
  | 'presence.away'
  // Typing (new)
  | 'typing.start'
  | 'typing.stop'
  // Stage sync (new)
  | 'stage.progress'
  | 'stage.waiting'
  // Memory (new)
  | 'memory.suggested'
  // Fire-and-forget message events (new)
  | 'message.ai_response'
  | 'message.error'
  // Context assembly events (for Neural Monitor dashboard)
  | 'context.updated'
  // Notification events (for activity menu badges)
  | 'notification.pending_action'
  | 'empathy.resubmitted';

export interface SessionEventData {
  sessionId: string;
  userId?: string;
  stage?: number;
  timestamp: number;
  excludeUserId?: string;
  [key: string]: unknown;
}

// ============================================================================
// Realtime Channel Names
// ============================================================================

export const REALTIME_CHANNELS = {
  /** Main session channel for events */
  session: (sessionId: string) => `meetwithoutfear:session:${sessionId}`,
  /** Presence channel for a session */
  presence: (sessionId: string) => `meetwithoutfear:presence:${sessionId}`,
  /** User's private channel */
  user: (userId: string) => `meetwithoutfear:user:${userId}`,
} as const;

// ============================================================================
// User-Level Events (for home/sessions list updates)
// ============================================================================

export type UserEventType =
  | 'session.new_message' // New message in a session
  | 'session.updated' // Session state changed (status, stage, etc.)
  | 'memory.suggested'; // AI suggested a memory for the user to approve

export interface UserEventData {
  sessionId: string;
  timestamp: number;
  [key: string]: unknown;
}

// ============================================================================
// Realtime Event Payloads
// ============================================================================

export interface RealtimeEventBase {
  sessionId: string;
  timestamp: number;
}

export interface PartnerOnlinePayload extends RealtimeEventBase {
  userId: string;
  name?: string;
}

export interface PartnerTypingPayload extends RealtimeEventBase {
  userId: string;
  isTyping: boolean;
}

export interface StageUpdatePayload extends RealtimeEventBase {
  userId: string;
  stage: number;
  status: 'in_progress' | 'gate_pending' | 'completed';
}

export interface SessionPausedPayload extends RealtimeEventBase {
  pausedBy: string;
  reason?: string;
}

export interface SessionResumedPayload extends RealtimeEventBase {
  resumedBy: string;
}

// ============================================================================
// Aggregate Realtime Event Type
// ============================================================================

export type RealtimeEvent =
  | { event: 'presence.online'; data: PartnerOnlinePayload }
  | { event: 'presence.offline'; data: PartnerOnlinePayload }
  | { event: 'typing.start'; data: PartnerTypingPayload }
  | { event: 'typing.stop'; data: PartnerTypingPayload }
  | { event: 'stage.progress'; data: StageUpdatePayload }
  | { event: 'stage.waiting'; data: StageUpdatePayload }
  | { event: 'session.paused'; data: SessionPausedPayload }
  | { event: 'session.resumed'; data: SessionResumedPayload }
  | { event: SessionEventType; data: SessionEventData };

// ============================================================================
// Connection Status
// ============================================================================

export enum ConnectionStatus {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  SUSPENDED = 'suspended',
  FAILED = 'failed',
}

export interface ConnectionState {
  status: ConnectionStatus;
  error?: string;
  lastConnected?: number;
  reconnectAttempts: number;
}

// ============================================================================
// Fire-and-Forget Message Events
// ============================================================================

import type { MessageDTO } from './message';

/**
 * Payload for message.ai_response event.
 * Sent when AI response is ready after fire-and-forget message processing.
 */
export interface MessageAIResponsePayload extends RealtimeEventBase {
  /** The user ID this response is for (fire-and-forget is per-user) */
  forUserId: string;
  /**
   * The AI response message. Omitted on the session channel since TS-12 (R36:
   * that channel reaches every participant's device): the addressed client
   * refetches its conversation; `messageId` names the reply.
   */
  message?: MessageDTO;
  /** The AI response message's id (TS-12) */
  messageId?: string;
  /** Stage 1: AI recommends showing feel-heard confirmation */
  offerFeelHeardCheck?: boolean;
  /** Stage 2: AI recommends showing ready-to-share confirmation */
  offerReadyToShare?: boolean;
  /** Stage 2: Proposed empathy statement */
  proposedEmpathyStatement?: string | null;
  /** Whether the AI expects a follow-up turn (ships on the wire via the metadata spread) */
  expectingMore?: boolean;
}

/**
 * Payload for message.error event.
 * Sent when AI processing fails for a user's message.
 */
export interface MessageErrorPayload extends RealtimeEventBase {
  /** The user ID this error is for */
  forUserId: string;
  /** The user message ID that failed */
  userMessageId: string;
  /** User-friendly error message */
  error: string;
  /** Whether the user can retry sending the message */
  canRetry: boolean;
}

// ============================================================================
// Context Assembly Events (for Neural Monitor)
// ============================================================================

/**
 * Payload for context.updated event.
 * Sent when context has been assembled for a user in a session.
 * Used by Neural Monitor dashboard to trigger context display refresh.
 */
export interface ContextUpdatedPayload extends RealtimeEventBase {
  /** The user ID whose context was assembled */
  userId: string;
  /** When the context was assembled */
  assembledAt: string;
}

// ============================================================================
// Empathy Events (Data-With-Events Pattern)
// ============================================================================

import type {
  EmpathyExchangeStatusResponse,
  GetShareSuggestionResponse,
  EmpathyAttemptDTO,
} from './empathy';

/**
 * Payload for empathy.status_updated event.
 * Contains the full empathy exchange status for the recipient to update their cache.
 */
export interface EmpathyStatusUpdatedPayload extends RealtimeEventBase {
  /** The user ID this update is for (recipient should check this matches their ID) */
  forUserId: string;
  /** The user ID who triggered this update (for filtering) */
  triggeredByUserId?: string;
  /** Full empathy exchange status for the recipient */
  empathyStatus: EmpathyExchangeStatusResponse;
  /** Human-readable status message */
  message?: string;
  /** The status that triggered this event */
  status?: string;
}

/**
 * Payload for empathy.share_suggestion event.
 * Contains the full share suggestion for the subject.
 */
export interface EmpathyShareSuggestionPayload extends RealtimeEventBase {
  /** The user ID this suggestion is for (the subject who should share) */
  forUserId: string;
  /** Full share suggestion data */
  shareOffer: GetShareSuggestionResponse;
  /** Updated empathy status for the subject */
  empathyStatus: EmpathyExchangeStatusResponse;
}

/**
 * Payload for empathy.context_shared event.
 * Contains the updated status for the guesser after subject shared context.
 */
export interface EmpathyContextSharedPayload extends RealtimeEventBase {
  /** The user ID this update is for (the guesser who receives the context) */
  forUserId: string;
  /** The user ID who shared the context (for filtering on frontend) */
  sharedByUserId: string;
  /** Updated empathy status for the guesser */
  empathyStatus: EmpathyExchangeStatusResponse;
  /** The shared content (for display) */
  sharedContent?: string;
  /** The shared message details (for cache update) */
  sharedMessage?: {
    id: string;
    content: string;
    timestamp: string;
    stage: number;
  };
}

/**
 * Payload for empathy.revealed event.
 * Contains the partner's empathy attempt for the subject to validate.
 */
export interface EmpathyRevealedPayload extends RealtimeEventBase {
  /** The user ID this is for (the subject who should see the empathy) */
  forUserId: string;
  /** The guesser's user ID (who wrote the empathy statement) */
  guesserUserId: string;
  /** The revealed empathy attempt */
  partnerEmpathy: EmpathyAttemptDTO;
  /** Updated empathy status */
  empathyStatus: EmpathyExchangeStatusResponse;
}

/**
 * Payload for notification.pending_action event.
 * Notifies a user that a new pending action is available in their activity menu.
 */
export interface NotificationPendingActionPayload extends RealtimeEventBase {
  /** The user ID this notification is for */
  forUserId: string;
  /** The type of pending action */
  actionType: 'share_offer' | 'validate_empathy' | 'context_received';
  /** ID of the action item */
  actionId: string;
}

/**
 * Payload for empathy.resubmitted event.
 * Notifies the subject that the guesser has resubmitted a refined empathy attempt.
 */
export interface EmpathyResubmittedPayload extends RealtimeEventBase {
  /** The user ID this is for (the subject who should see the updated empathy) */
  forUserId: string;
  /** The guesser who resubmitted */
  guesserUserId: string;
  /** Updated empathy status */
  empathyStatus: EmpathyExchangeStatusResponse;
}

/**
 * Payload for partner.empathy_shared event.
 * Contains the empathy statement message for display.
 */
export interface PartnerEmpathySharedPayload extends RealtimeEventBase {
  /** The user ID who shared their empathy */
  sharedByUserId: string;
  /** Updated empathy status for recipient */
  empathyStatus: EmpathyExchangeStatusResponse;
  /** The empathy statement as a message for chat display */
  empathyMessage?: {
    id: string;
    content: string;
    timestamp: string;
    stage: number;
  };
}
