import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { clearPushTokenAsJob, pushTokensAsJob } from './user-settings';
import { currentRow, loadStageStates } from './stage-shim';
import type { SessionEvent } from './realtime';
import { Stage, STAGE_FRIENDLY_NAMES } from '@meet-without-fear/shared';

/**
 * Expo SDK instance for sending push notifications.
 * Only created if we actually need to send notifications.
 */
let expoClient: Expo | null = null;

function getExpo(): Expo {
  if (!expoClient) {
    expoClient = new Expo({
      accessToken: process.env.EXPO_ACCESS_TOKEN,
    });
  }
  return expoClient;
}

/**
 * Reset the Expo client (useful for testing).
 */
export function resetExpoClient(): void {
  expoClient = null;
}

interface PushMessageTemplate {
  title: string;
  body: string;
}

interface PushMessageContext {
  actorName: string;
  actorNamePossessive: string;
  stageName: string;
}

interface StageProgressSnapshot {
  stage: number;
  status: string;
}

interface PushMessageSelectionContext {
  userId: string;
  event: SessionEvent;
  data: Record<string, unknown>;
  sessionId: string;
  actorUserId: string | null;
}

/**
 * Push notification message templates for each session event type.
 * Use {actor} for the other person's display name. The send path resolves it
 * from the recipient's relationship nickname when available.
 */
export const PUSH_MESSAGES: Record<SessionEvent, PushMessageTemplate> = {
  'partner.signed_compact': {
    title: '{actor} is ready',
    body: 'You can start the session when you are ready.',
  },
  'partner.stage_completed': {
    title: '{actor} is progressing',
    body: '{actor} moved forward. Come back and keep going when you are ready.',
  },
  'partner.advanced': {
    title: 'Next step is ready',
    body: '{actor} is ready for the next step with you.',
  },
  'partner.empathy_shared': {
    title: '{actor} shared empathy',
    body: "We're checking it now and will show it when it is ready to read.",
  },
  'partner.additional_context_shared': {
    title: 'More context shared',
    body: '{actor} added context to help you understand them better.',
  },
  'partner.needs_confirmed': {
    title: '{actor} confirmed needs',
    body: '{actor} confirmed their needs. Keep going when you are ready.',
  },
  'partner.needs_validated': {
    title: '{actor} checked the needs list',
    body: 'Check the needs list when you are ready.',
  },
  'partner.needs_shared': {
    title: '{actorPossessive} needs are ready',
    body: 'Review the needs list when you are ready.',
  },
  'session.strategies_updated': {
    title: '{actor} reviewed repair ideas',
    body: '{actor} made progress on repair ideas. Come back when you are ready.',
  },
  'partner.ranking_submitted': {
    title: '{actor} ranked repair ideas',
    body: 'Open the session to compare rankings when you are ready.',
  },
  'partner.ready_to_rank': {
    title: '{actor} is ready to rank',
    body: 'Finish your review, then start ranking repair ideas when you are ready.',
  },
  'partner.consent_granted': {
    title: 'Content shared',
    body: '{actor} shared content for this session.',
  },
  'partner.consent_revoked': {
    title: 'Content withdrawn',
    body: '{actor} withdrew shared content from this session.',
  },
  'agreement.proposed': {
    title: '{actor} proposed an agreement',
    body: 'Review the agreement and decide whether it works for you.',
  },
  'agreement.confirmed': {
    title: '{actor} confirmed an agreement',
    body: "Take a look when you're ready.",
  },
  'session.paused': {
    title: 'Session paused',
    body: '{actor} needs a moment. The session is paused.',
  },
  'session.resumed': {
    title: 'Session resumed',
    body: '{actor} resumed the session. Come back when you are ready.',
  },
  'session.resolved': {
    title: 'Session complete',
    body: 'Your conversation has been resolved.',
  },
  'session.joined': {
    title: '{actor} joined',
    body: '{actor} accepted your invitation. Open the session to continue together.',
  },
  'session.needs_reveal_ready': {
    title: 'Ready to reveal',
    body: 'You are both ready to reveal needs side by side.',
  },
  'invitation.declined': {
    title: 'Invitation declined',
    body: '{actor} has declined the session invitation.',
  },
  'invitation.confirmed': {
    title: 'Invitation confirmed',
    body: '{actor} confirmed the invitation message.',
  },
  // Empathy reconciler events
  'partner.empathy_revealed': {
    title: '{actorPossessive} empathy is visible',
    body: 'Open the session to read it.',
  },
  'partner.skipped_refinement': {
    title: '{actor} accepted the current understanding',
    body: '{actor} is ready to keep moving. Come back when you are ready.',
  },
  'empathy.share_suggestion': {
    title: 'Help {actor} understand',
    body: 'You can share a little more context when you are ready.',
  },
  'empathy.context_shared': {
    title: '{actor} shared more context',
    body: 'Use the new context to refine your empathy when you are ready.',
  },
  'empathy.revealed': {
    title: 'Empathy exchange is ready',
    body: 'You can now read what {actor} understood about your experience.',
  },
  'empathy.refining': {
    title: 'New context to consider',
    body: '{actor} shared something to help you refine your empathy.',
  },
  'empathy.status_updated': {
    title: 'Empathy step updated',
    body: 'Open the session to see what is ready now.',
  },
  'notification.pending_action': {
    title: 'Review needed',
    body: 'You have a new item to review in your activity menu.',
  },
  'empathy.resubmitted': {
    title: 'Updated empathy',
    body: '{actor} refined their understanding of your experience.',
  },
};

function possessive(name: string): string {
  if (name === 'They') {
    return 'Their';
  }
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function getActorUserId(data: Record<string, unknown>): string | null {
  const candidate =
    data.triggeredByUserId ??
    data.signedBy ??
    data.completedBy ??
    data.sharedBy ??
    data.confirmedBy ??
    data.validatedBy ??
    data.submittedBy ??
    data.readyBy ??
    data.pausedBy ??
    data.resumedBy ??
    data.resolvedBy ??
    data.proposedBy ??
    data.joinedBy;

  return typeof candidate === 'string' ? candidate : null;
}

function getStageName(data: Record<string, unknown>): string {
  switch (data.stage) {
    case Stage.ONBOARDING:
      return STAGE_FRIENDLY_NAMES[Stage.ONBOARDING];
    case Stage.WITNESS:
      return STAGE_FRIENDLY_NAMES[Stage.WITNESS];
    case Stage.PERSPECTIVE_STRETCH:
      return STAGE_FRIENDLY_NAMES[Stage.PERSPECTIVE_STRETCH];
    case Stage.NEED_MAPPING:
      return STAGE_FRIENDLY_NAMES[Stage.NEED_MAPPING];
    case Stage.STRATEGIC_REPAIR:
      return STAGE_FRIENDLY_NAMES[Stage.STRATEGIC_REPAIR];
    case Stage.INFORMED_EMPATHY:
      return STAGE_FRIENDLY_NAMES[Stage.INFORMED_EMPATHY];
    default:
      return 'the current step';
  }
}

async function getSessionProgressContext(
  userId: string,
  actorUserId: string | null,
  sessionId: string,
): Promise<{ recipient: StageProgressSnapshot | null; actor: StageProgressSnapshot | null }> {
  if (!actorUserId || actorUserId === userId) {
    return { recipient: null, actor: null };
  }

  try {
    // Both participants' current stage rows from their milestones (stage shim; TS-12)
    const participants = await prisma.participant.findMany({
      where: { sessionId, userId: { in: [userId, actorUserId] } },
      select: { id: true, userId: true, joinedAt: true },
    });
    const states = await loadStageStates(participants.map(p => ({ id: p.id, joinedAt: p.joinedAt })));
    const snapshotOf = (uid: string): StageProgressSnapshot | null => {
      const p = participants.find(x => x.userId === uid);
      const state = p ? states.get(p.id) : undefined;
      if (!state) return null;
      const row = currentRow(state);
      return { stage: row.stage, status: row.status };
    };

    return {
      recipient: snapshotOf(userId),
      actor: snapshotOf(actorUserId),
    };
  } catch (error) {
    logger.warn(`[Push] Failed to resolve progress context for session ${sessionId}:`, error);
    return { recipient: null, actor: null };
  }
}

function isWaitingAt(progress: StageProgressSnapshot | null, stage: number): boolean {
  return progress?.stage === stage && (progress.status === 'GATE_PENDING' || progress.status === 'COMPLETED');
}

function isStillWorkingAtOrPast(progress: StageProgressSnapshot | null, stage: number): boolean {
  return !!progress && progress.stage >= stage && progress.status === 'IN_PROGRESS';
}

async function getStageCompletedTemplate(context: PushMessageSelectionContext): Promise<PushMessageTemplate> {
  const completedStage = typeof context.data.stage === 'number' ? context.data.stage : null;
  const progress = await getSessionProgressContext(context.userId, context.actorUserId, context.sessionId);

  if (completedStage === Stage.WITNESS) {
    if (isWaitingAt(progress.recipient, Stage.WITNESS)) {
      return {
        title: 'Ready to continue',
        body: '{actor} felt heard, so the next step is ready when you are.',
      };
    }

    if (isStillWorkingAtOrPast(progress.recipient, Stage.PERSPECTIVE_STRETCH)) {
      return {
        title: '{actor} is progressing',
        body: '{actor} felt heard and moved forward. Come back and keep going when you are ready.',
      };
    }

    return {
      title: '{actor} moved forward',
      body: '{actor} felt heard. Keep going at your own pace.',
    };
  }

  if (completedStage === Stage.PERSPECTIVE_STRETCH) {
    if (isWaitingAt(progress.recipient, Stage.PERSPECTIVE_STRETCH)) {
      return {
        title: 'Ready to continue',
        body: '{actor} finished the empathy step. The next step is ready when you are.',
      };
    }

    return {
      title: '{actor} is progressing',
      body: '{actor} finished the empathy step. Come back and keep going when you are ready.',
    };
  }

  return {
    title: '{actor} is progressing',
    body: '{actor} moved forward. Come back and keep going when you are ready.',
  };
}

async function getPushMessageTemplate(
  userId: string,
  event: SessionEvent,
  data: Record<string, unknown>,
  sessionId: string,
): Promise<PushMessageTemplate> {
  const actorUserId = getActorUserId(data);

  if (event === 'partner.signed_compact') {
    if (actorUserId && actorUserId !== userId) {
      const invitation = await prisma.invitation.findFirst({
        where: {
          sessionId,
          invitedByParticipant: { userId },
          status: 'ACCEPTED',
        },
        select: {
          id: true,
        },
      });

      if (invitation) {
        return {
          title: '{actor} accepted your invitation',
          body: '{actor} accepted your invitation and started the session. Come back when you are ready.',
        };
      }
    }
  }

  if (event === 'partner.stage_completed') {
    return getStageCompletedTemplate({ userId, event, data, sessionId, actorUserId });
  }

  if (event === 'partner.advanced') {
    return {
      title: 'Next step is ready',
      body: 'You are both ready for the next part of the session.',
    };
  }

  if (event === 'partner.ready_to_rank') {
    const progress = await getSessionProgressContext(userId, actorUserId, sessionId);
    if (isWaitingAt(progress.recipient, Stage.STRATEGIC_REPAIR)) {
      return {
        title: '{actor} is ready to rank',
        body: 'You can start ranking repair ideas when you are ready.',
      };
    }
  }

  if (event === 'empathy.context_shared') {
    const progress = await getSessionProgressContext(userId, actorUserId, sessionId);
    if (isWaitingAt(progress.recipient, Stage.PERSPECTIVE_STRETCH)) {
      return {
        title: '{actor} shared more context',
        body: 'Use the new context to refine your empathy when you are ready.',
      };
    }
  }

  return (
    PUSH_MESSAGES[event] || {
      title: 'Meet Without Fear',
      body: 'You have an update',
    }
  );
}

async function getNotificationActorName(
  recipientUserId: string,
  sessionId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const actorUserId = getActorUserId(data);
  if (!actorUserId || actorUserId === recipientUserId) {
    return 'They';
  }

  try {
    // The recipient's own name for the actor, then the actor's display name
    // (participant.display_name — never the actor's user row, spec §7).
    const [session, actor] = await Promise.all([
      prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          relationship: { select: { members: { where: { userId: recipientUserId }, select: { nickname: true } } } },
        },
      }),
      prisma.participant.findUnique({
        where: { sessionId_userId: { sessionId, userId: actorUserId } },
        select: { displayName: true },
      }),
    ]);

    return session?.relationship.members[0]?.nickname || actor?.displayName || 'They';
  } catch (error) {
    logger.warn(`[Push] Failed to resolve notification actor name for session ${sessionId}:`, error);
    return 'They';
  }
}

function renderPushMessage(template: PushMessageTemplate, context: PushMessageContext): PushMessageTemplate {
  const render = (value: string) =>
    value
      .replace(/\{actor\}/g, context.actorName)
      .replace(/\{actorPossessive\}/g, context.actorNamePossessive)
      .replace(/\{stageName\}/g, context.stageName);

  return {
    title: render(template.title),
    body: render(template.body),
  };
}

/**
 * Sends a push notification to a user.
 * Fetches the user's push token from the database and sends the notification via Expo.
 *
 * @param userId - The user ID to send the notification to
 * @param event - The session event type (determines message content)
 * @param data - Additional data to include in the notification payload
 * @param sessionId - The session ID for deep linking
 * @returns Promise<boolean> - true if notification was sent successfully
 */
export async function sendPushNotification(
  userId: string,
  event: SessionEvent,
  data: Record<string, unknown>,
  sessionId: string,
): Promise<boolean> {
  try {
    // The recipient's devices (user_device), read by the job: the push is
    // delivered to another user than the caller (services/user-settings.ts)
    const tokens = (await pushTokensAsJob(userId)).filter(token => {
      if (Expo.isExpoPushToken(token)) return true;
      logger.warn(`[Push] Invalid push token format for user ${userId}: ${token}`);
      return false;
    });

    if (tokens.length === 0) {
      logger.info(`[Push] No push token for user ${userId}`);
      return false;
    }

    const template = await getPushMessageTemplate(userId, event, data, sessionId);
    const actorName = await getNotificationActorName(userId, sessionId, data);
    const message = renderPushMessage(template, {
      actorName,
      actorNamePossessive: possessive(actorName),
      stageName: getStageName(data),
    });

    // One notification per device
    const pushMessages: ExpoPushMessage[] = tokens.map(to => ({
      to,
      sound: 'default',
      title: message.title,
      body: message.body,
      data: {
        screen: 'session',
        sessionId,
        event,
        ...data,
      },
    }));

    // Send the notifications via Expo
    const expo = getExpo();
    const tickets = await expo.sendPushNotificationsAsync(pushMessages);

    let sent = false;
    for (const [i, ticket] of tickets.entries()) {
      if (ticket.status === 'ok') {
        sent = true;
        continue;
      }
      logger.error(`[Push] Failed to send notification to user ${userId}:`, ticket.message);
      // An unregistered device's token is cleared
      if (ticket.details?.error === 'DeviceNotRegistered' || ticket.details?.error === 'InvalidCredentials') {
        logger.info(`[Push] Clearing invalid token for user ${userId}`);
        await clearPushTokenAsJob(userId, tokens[i]);
      }
    }
    if (sent) logger.info(`[Push] Sent ${event} notification to user ${userId}`);
    return sent;
  } catch (error) {
    logger.error(`[Push] Error sending notification to user ${userId}:`, error);
    return false;
  }
}

/**
 * Sends push notifications to multiple users.
 *
 * @param userIds - Array of user IDs to notify
 * @param event - The session event type
 * @param data - Additional data for the notification
 * @param sessionId - The session ID
 * @returns Promise<number> - Number of successfully sent notifications
 */
export async function sendPushNotifications(
  userIds: string[],
  event: SessionEvent,
  data: Record<string, unknown>,
  sessionId: string,
): Promise<number> {
  const results = await Promise.all(userIds.map(userId => sendPushNotification(userId, event, data, sessionId)));
  return results.filter(Boolean).length;
}

export interface TestPushNotificationResult {
  sent: boolean;
  reason?: string;
}

/**
 * Sends a diagnostic push notification with fixed content.
 */
export async function sendTestPushNotification(userId: string): Promise<TestPushNotificationResult> {
  try {
    // The caller's own most recently seen device (the test is sent to oneself)
    const [pushToken] = await pushTokensAsJob(userId);

    if (!pushToken) {
      logger.info(`[Push] No push token for test notification user ${userId}`);
      return { sent: false, reason: 'No push token is registered for this account' };
    }

    if (!Expo.isExpoPushToken(pushToken)) {
      logger.warn(`[Push] Invalid test push token format for user ${userId}: ${pushToken}`);
      return { sent: false, reason: 'The stored push token is not a valid Expo token' };
    }

    const expo = getExpo();
    const tickets = await expo.sendPushNotificationsAsync([
      {
        to: pushToken,
        sound: 'default',
        title: 'Push notification test',
        body: 'This is your scheduled Meet Without Fear test notification.',
        data: {
          screen: 'settings',
          event: 'test.push_notification',
        },
      },
    ]);

    const ticket = tickets[0];
    if (ticket.status === 'ok') {
      logger.info(`[Push] Sent test notification to user ${userId}`);
      return { sent: true };
    }

    logger.error(`[Push] Failed to send test notification to user ${userId}:`, ticket.message);
    if (ticket.details?.error === 'DeviceNotRegistered' || ticket.details?.error === 'InvalidCredentials') {
      await clearPushTokenAsJob(userId, pushToken);
    }
    return { sent: false, reason: ticket.message };
  } catch (error) {
    logger.error(`[Push] Error sending test notification to user ${userId}:`, error);
    return {
      sent: false,
      reason: error instanceof Error ? error.message : 'Unknown push notification error',
    };
  }
}

/**
 * Validates if a string is a valid Expo push token.
 *
 * @param token - The token to validate
 * @returns boolean - true if valid
 */
export function isValidPushToken(token: string): boolean {
  return Expo.isExpoPushToken(token);
}
