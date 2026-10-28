/**
 * Session Helper Utilities
 *
 * Centralized session-related utilities used across controllers.
 */

import { prisma } from '../lib/prisma';
import { getPartnerUserIdFor, resolveParticipant } from '../services/participant-resolver';
import {
  SessionSummaryDTO,
  SessionStatusSummary,
  StageProgressDTO,
  SessionStatus,
  Stage,
  StageStatus,
  STAGE_FRIENDLY_NAMES,
} from '@meet-without-fear/shared';

// Type for session with includes (from Prisma)
type SessionWithIncludes = {
  id: string;
  relationshipId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  relationship: {
    members: Array<{
      userId: string;
      nickname: string | null;
      user: {
        id: string;
        name: string | null;
        firstName: string | null;
      };
    }>;
  };
  stageProgress: Array<{
    userId: string;
    stage: number;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    gatesSatisfied?: unknown;
  }>;
  // Optional: empathy attempts for Stage 2 status display
  empathyAttempts?: Array<{
    sourceUserId: string | null;
    status?: string;
  }>;
  // Optional: user vessel for read state tracking
  userVessels?: Array<{
    userId: string;
    lastViewedAt: Date | null;
    lastActiveAt?: Date | null;
    lastSeenChatItemId: string | null;
  }>;
};

/**
 * TS-12 (R5, spec §7 v_participant): the users who have LEFT each session —
 * account deletion and leaving set participant.left_at (and NULL its
 * display_name) through app.anonymize_user_in_session. The partner DTOs show
 * such a partner without a name or nickname (the relationship member row keeps
 * the caller's old nickname for them), and the status copy calls them
 * FORMER_PARTICIPANT_NAME. Keyed `${sessionId}:${userId}`.
 */
export async function departedParticipantUsers(sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await prisma.participant.findMany({
    where: { sessionId: { in: sessionIds }, leftAt: { not: null }, userId: { not: null } },
    select: { sessionId: true, userId: true },
  });
  return new Set(rows.map(r => `${r.sessionId}:${r.userId}`));
}

/** How the status copy names a partner who has left (spec §7: the UI's fallback). */
export const FORMER_PARTICIPANT_NAME = 'Former participant';

/**
 * Records that a participant actively did something in their session — the
 * `last_active_at` of their `conversation_read_state` (target shape, TS-9).
 *
 * This is intentionally separate from lastViewedAt, which is read-state used
 * for unread indicators and chat animation boundaries.
 */
export async function touchParticipantActivity(participantId: string, at: Date = new Date()): Promise<void> {
  await prisma.conversationReadState.upsert({
    where: { participantId },
    update: { lastActiveAt: at },
    create: { participantId, lastActiveAt: at },
  });
}

/**
 * (session, user) form of `touchParticipantActivity`, for callers that do not
 * hold the participant. A user with no participant in the session is ignored.
 */
export async function touchUserSessionActivity(
  sessionId: string,
  userId: string,
  at: Date = new Date()
): Promise<void> {
  const participant = await resolveParticipant(sessionId, userId);
  if (participant) await touchParticipantActivity(participant.id, at);
}

/**
 * Gets the partner's user ID from a session: the one other present human
 * participant, through `v_co_participant` (participant-resolver). Null when
 * the caller is not a participant or there is no single partner.
 */
export async function getPartnerUserId(
  sessionId: string,
  currentUserId: string
): Promise<string | null> {
  return getPartnerUserIdFor(sessionId, currentUserId);
}

/**
 * Checks if a user is the creator of a session (the one who sent the invitation).
 * Used to allow the creator to work on Stages 0-1 while waiting for partner to accept.
 */
export async function isSessionCreator(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const invitation = await prisma.invitation.findFirst({
    where: { sessionId, invitedByParticipant: { userId } },
    select: { id: true },
  });

  return invitation !== null;
}

/**
 * Options for status summary generation
 */
interface StatusSummaryOptions {
  /** Whether the current user has sent their empathy (EmpathyAttempt exists) */
  userHasSentEmpathy?: boolean;
  /** Whether the partner has sent their empathy (EmpathyAttempt exists) */
  partnerHasSentEmpathy?: boolean;
}

/**
 * Generate human-readable status summary for session list display.
 *
 * This function creates contextual messages about:
 * 1. What the user has done / where they are
 * 2. What's happening with the partner
 *
 * Examples:
 * - "You've shared your story" / "Jason is working on their story"
 * - "Sharing your story" / "Jason is getting ready"
 * - "Invitation sent" / "Jason hasn't joined yet"
 */
export function generateSessionStatusSummary(
  sessionStatus: SessionStatus,
  myProgress: StageProgressDTO,
  partnerProgress: StageProgressDTO,
  partnerName: string,
  options: StatusSummaryOptions = {}
): SessionStatusSummary {
  const name = partnerName || 'Partner';

  // Handle non-active session statuses first
  if (sessionStatus === SessionStatus.CREATED) {
    return {
      userStatus: 'Draft invitation',
      partnerStatus: 'Not sent yet',
    };
  }

  if (sessionStatus === SessionStatus.INVITED) {
    // Check if partner has actually joined and made progress
    // (This handles cases where session status wasn't updated but partner has progress)
    const hasPartnerProgress =
      partnerProgress.stage > Stage.ONBOARDING ||
      partnerProgress.status === StageStatus.IN_PROGRESS ||
      partnerProgress.status === StageStatus.GATE_PENDING ||
      partnerProgress.status === StageStatus.COMPLETED;

    // If partner has made progress, treat as active session
    if (hasPartnerProgress) {
      // Fall through to active session logic below
    } else {
      // Partner hasn't joined yet - show invitation status
      // Check if creator has made progress while waiting for partner to accept
      const hasUserProgress =
        myProgress.stage > Stage.ONBOARDING ||
        myProgress.status === StageStatus.IN_PROGRESS ||
        myProgress.status === StageStatus.GATE_PENDING ||
        myProgress.status === StageStatus.COMPLETED;

      if (hasUserProgress) {
        // Show actual progress status for creator, partner is still pending acceptance
        const userStatus =
          myProgress.status === StageStatus.IN_PROGRESS
            ? getInProgressStageMessage(myProgress.stage, options.userHasSentEmpathy)
            : myProgress.status === StageStatus.GATE_PENDING ||
                myProgress.status === StageStatus.COMPLETED
              ? getCompletedStageMessage(myProgress.stage)
              : `Ready for ${STAGE_FRIENDLY_NAMES[myProgress.stage]}`;

        return {
          userStatus,
          partnerStatus: `${name} hasn't joined yet`,
        };
      }

      return {
        userStatus: 'Invitation ready',
        partnerStatus: `${name} hasn't joined yet`,
      };
    }
  }

  if (sessionStatus === SessionStatus.PAUSED) {
    return {
      userStatus: 'Session paused',
      partnerStatus: 'Take a break and return when ready',
    };
  }

  if (sessionStatus === SessionStatus.RESOLVED) {
    return {
      userStatus: 'Session complete',
      partnerStatus: 'You both reached resolution',
    };
  }

  if (sessionStatus === SessionStatus.ABANDONED) {
    return {
      userStatus: 'Session ended',
      partnerStatus: 'This conversation was not completed',
    };
  }

  // For active/waiting sessions, generate stage-specific messages
  const myStage = myProgress.stage;
  const myStatus = myProgress.status;
  const partnerStage = partnerProgress.stage;
  const partnerStatus = partnerProgress.status;

  // Get user-friendly stage name
  const myFriendlyName = STAGE_FRIENDLY_NAMES[myStage];

  // Generate user status based on their progress
  let userStatus: string;
  switch (myStatus) {
    case StageStatus.NOT_STARTED:
      userStatus = `Ready for ${myFriendlyName}`;
      break;
    case StageStatus.IN_PROGRESS:
      userStatus = getInProgressStageMessage(myStage, options.userHasSentEmpathy);
      break;
    case StageStatus.GATE_PENDING:
      userStatus = getCompletedStageMessage(myStage);
      break;
    case StageStatus.COMPLETED:
      userStatus = getCompletedStageMessage(myStage);
      break;
    default:
      userStatus = `Working on ${myFriendlyName}`;
  }

  // Generate partner status based on their progress
  let partnerStatusMsg: string;

  // If partner is behind
  if (partnerStage < myStage) {
    const partnerFriendlyName = STAGE_FRIENDLY_NAMES[partnerStage];
    if (partnerStatus === StageStatus.NOT_STARTED) {
      partnerStatusMsg = `${name} will begin when ready`;
    } else if (partnerStatus === StageStatus.IN_PROGRESS) {
      partnerStatusMsg = `${name} is working on ${partnerFriendlyName}`;
    } else {
      partnerStatusMsg = `${name} is working at their own pace`;
    }
  }
  // If partner is on the same stage
  else if (partnerStage === myStage) {
    if (partnerStatus === StageStatus.GATE_PENDING || partnerStatus === StageStatus.COMPLETED) {
      // Both ready to advance
      partnerStatusMsg = `${name} is also ready`;
    } else if (partnerStatus === StageStatus.NOT_STARTED) {
      partnerStatusMsg = `${name} will join when ready`;
    } else {
      partnerStatusMsg = getWaitingForPartnerMessage(myStage, name);
    }
  }
  // If partner is ahead (user is behind)
  else {
    partnerStatusMsg = `You can continue when you're ready`;
    // Update user status to reflect encouragement without pressure
    if (myStatus === StageStatus.NOT_STARTED) {
      userStatus = `Ready for ${myFriendlyName} when you are`;
    } else if (myStatus === StageStatus.IN_PROGRESS) {
      userStatus = `You're making progress on ${myFriendlyName}`;
    }
  }

  return {
    userStatus,
    partnerStatus: partnerStatusMsg,
  };
}

/**
 * Get a message describing what the user is currently doing in their stage.
 * @param stage - The current stage
 * @param hasSentEmpathy - For Stage 2, whether the user has already sent their empathy message
 */
function getInProgressStageMessage(stage: Stage, hasSentEmpathy?: boolean): string {
  switch (stage) {
    case Stage.ONBOARDING:
      return "Reviewing the agreement";
    case Stage.WITNESS:
      return "Sharing your story";
    case Stage.PERSPECTIVE_STRETCH:
      return hasSentEmpathy ? "You've shared your understanding" : "Working on understanding their perspective";
    case Stage.NEED_MAPPING:
      return "Exploring what matters to you";
    case Stage.STRATEGIC_REPAIR:
      return "Considering next steps";
    default:
      return 'Working on current stage';
  }
}

/**
 * Get a message describing what the user has completed for their current stage.
 */
function getCompletedStageMessage(stage: Stage): string {
  switch (stage) {
    case Stage.ONBOARDING:
      return "You've signed the agreement";
    case Stage.WITNESS:
      return "You've shared your story";
    case Stage.PERSPECTIVE_STRETCH:
      return "You've shared your understanding";
    case Stage.NEED_MAPPING:
      return "You've explored what matters to you";
    case Stage.STRATEGIC_REPAIR:
      return "You've shared your ideas for next steps";
    default:
      return 'Stage complete';
  }
}

/**
 * Get a message about waiting for partner based on the current stage.
 */
function getWaitingForPartnerMessage(stage: Stage, partnerName: string): string {
  switch (stage) {
    case Stage.ONBOARDING:
      return `${partnerName} is reviewing the agreement`;
    case Stage.WITNESS:
      return `${partnerName} is working on their story`;
    case Stage.PERSPECTIVE_STRETCH:
      return `${partnerName} is working on their perspective`;
    case Stage.NEED_MAPPING:
      return `${partnerName} is exploring what matters to them`;
    case Stage.STRATEGIC_REPAIR:
      return `${partnerName} is thinking about next steps`;
    default:
      return `${partnerName} is still working`;
  }
}

/**
 * Map a session with includes to a SessionSummaryDTO
 */
export function mapSessionToSummary(
  session: SessionWithIncludes,
  currentUserId: string
): SessionSummaryDTO {
  // Find partner member
  const partnerMember = session.relationship.members.find(
    (m) => m.userId !== currentUserId
  );
  const myMember = session.relationship.members.find(
    (m) => m.userId === currentUserId
  );

  // Find progress for each user
  const myProgressRecords = session.stageProgress.filter(
    (p) => p.userId === currentUserId
  );
  const partnerProgressRecords = session.stageProgress.filter(
    (p) => p.userId !== currentUserId
  );

  // Get current stage progress (highest stage)
  const myCurrentProgress = myProgressRecords.reduce(
    (max, p) => (p.stage > (max?.stage ?? -1) ? p : max),
    myProgressRecords[0]
  );
  const partnerCurrentProgress = partnerProgressRecords.reduce(
    (max, p) => (p.stage > (max?.stage ?? -1) ? p : max),
    partnerProgressRecords[0]
  );

  const myProgress: StageProgressDTO = myCurrentProgress
    ? {
        stage: myCurrentProgress.stage as Stage,
        status: myCurrentProgress.status as StageStatus,
        startedAt: myCurrentProgress.startedAt.toISOString(),
        completedAt: myCurrentProgress.completedAt?.toISOString() ?? null,
      }
    : {
        stage: Stage.ONBOARDING,
        status: StageStatus.NOT_STARTED,
        startedAt: null,
        completedAt: null,
      };

  const partnerProgress: StageProgressDTO = partnerCurrentProgress
    ? {
        stage: partnerCurrentProgress.stage as Stage,
        status: partnerCurrentProgress.status as StageStatus,
        startedAt: partnerCurrentProgress.startedAt.toISOString(),
        completedAt: partnerCurrentProgress.completedAt?.toISOString() ?? null,
      }
    : {
        stage: Stage.ONBOARDING,
        status: StageStatus.NOT_STARTED,
        startedAt: null,
        completedAt: null,
      };

  // Compute action needed based on gates (kept for backwards compatibility)
  const selfActionNeeded: string[] = [];
  const partnerActionNeeded: string[] = [];

  // User hasn't started their current stage → they can act
  if (myProgress.status === StageStatus.NOT_STARTED) {
    selfActionNeeded.push('start_stage');
  }

  // User is actively working → they still have things to do
  // But for Stage 2 (Perspective Stretch), check empathy sub-state to avoid
  // showing "Ready for you" when user is actually waiting on partner/system
  if (myProgress.status === StageStatus.IN_PROGRESS) {
    if (myProgress.stage === Stage.PERSPECTIVE_STRETCH && session.empathyAttempts?.length) {
      const userEmpathy = session.empathyAttempts.find(
        (a) => a.sourceUserId === currentUserId
      );
      const partnerEmpathy = session.empathyAttempts.find(
        (a) => a.sourceUserId !== currentUserId
      );

      // User has action if:
      // - Their empathy needs refinement
      // - Partner's empathy is revealed (needs validation)
      // - Partner's empathy is awaiting sharing (user must respond)
      const userNeedsToRefine =
        userEmpathy?.status === 'REFINING' || userEmpathy?.status === 'NEEDS_WORK';
      const userNeedsToValidate = partnerEmpathy?.status === 'REVEALED';
      const userNeedsToRespondToShare = partnerEmpathy?.status === 'AWAITING_SHARING';

      if (userNeedsToRefine || userNeedsToValidate || userNeedsToRespondToShare) {
        selfActionNeeded.push('continue_stage');
      }
      // If user hasn't sent empathy yet, they still have work to do
      else if (!userEmpathy) {
        selfActionNeeded.push('continue_stage');
      }
      // Otherwise: user is waiting on partner/system — no selfActionNeeded
    } else {
      selfActionNeeded.push('continue_stage');
    }
  }

  // User at gate, waiting for partner to also reach gate
  if (myProgress.status === StageStatus.GATE_PENDING) {
    if (
      partnerProgress.status !== StageStatus.GATE_PENDING &&
      partnerProgress.status !== StageStatus.COMPLETED
    ) {
      // Partner hasn't reached the gate yet — waiting on them
      partnerActionNeeded.push('complete_stage');
    }
    // If both at gate: neither has action needed (auto-advances)
  }

  // Get partner display name (prefer nickname, then firstName, then name)
  const partnerDisplayName =
    myMember?.nickname ??
    partnerMember?.user.firstName ??
    partnerMember?.user.name ??
    'Partner';

  // Check for empathy attempts (if included in query)
  const userHasSentEmpathy = session.empathyAttempts?.some(
    (a) => a.sourceUserId === currentUserId
  ) ?? false;
  const partnerHasSentEmpathy = session.empathyAttempts?.some(
    (a) => a.sourceUserId !== currentUserId
  ) ?? false;

  // Generate human-readable status summary
  const statusSummary = generateSessionStatusSummary(
    session.status as SessionStatus,
    myProgress,
    partnerProgress,
    partnerDisplayName,
    { userHasSentEmpathy, partnerHasSentEmpathy }
  );

  // Get user's read state from UserVessel (if included)
  const userVessel = session.userVessels?.find((v) => v.userId === currentUserId);
  const lastViewedAt = userVessel?.lastViewedAt ?? null;
  const lastSeenChatItemId = userVessel?.lastSeenChatItemId ?? null;

  // Determine if there's unread content:
  // - If never viewed (lastViewedAt is null), consider unread if session has any activity
  // - If viewed, compare session's updatedAt with lastViewedAt
  const hasUnread = lastViewedAt === null
    ? session.status !== SessionStatus.CREATED // Unread if not a fresh draft
    : session.updatedAt > lastViewedAt;

  return {
    id: session.id,
    relationshipId: session.relationshipId,
    status: session.status as SessionStatus,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    partner: {
      id: partnerMember?.userId ?? '',
      name: partnerMember?.user.firstName ?? partnerMember?.user.name ?? null,
      nickname: myMember?.nickname ?? null, // What I call my partner
    },
    myProgress,
    partnerProgress,
    statusSummary,
    selfActionNeeded,
    partnerActionNeeded,
    hasUnread,
    lastViewedAt: lastViewedAt?.toISOString() ?? null,
    lastSeenChatItemId,
  };
}
