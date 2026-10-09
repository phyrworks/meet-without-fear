/**
 * Shared Content Context Service
 *
 * Fetches and formats information about what has been shared in a session
 * so the AI has full awareness of the shared content history.
 */

import prisma from '../lib/prisma';
import { EmpathyStatus, SharedContentDeliveryStatus, InvitationStatus } from '../generated/prisma/client';

/**
 * Gates stored in StageProgress.gatesSatisfied for Stage 0
 */
interface Stage0Gates {
  compactSigned?: boolean;
  signedAt?: string;
}

/**
 * Gates stored in StageProgress.gatesSatisfied for Stage 1
 */
interface Stage1Gates {
  feelHeardConfirmed?: boolean;
  feelHeardConfirmedAt?: string;
}

/**
 * Get formatted milestone context for a user in a session.
 * These are the "lines" shown on the user's screen (Invitation Sent, Feel Heard, etc.)
 *
 * @param sessionId - The session ID
 * @param userId - The current user's ID
 * @returns Formatted string for injection into AI prompts, or null if no milestones
 */
export async function getMilestoneContext(
  sessionId: string,
  userId: string
): Promise<string | null> {
  const milestones: { label: string; timestamp: Date }[] = [];

  // 1. Get invitation data
  const invitation = await prisma.invitation.findFirst({
    where: { sessionId },
    select: {
      invitedById: true,
      messageConfirmedAt: true,
      acceptedAt: true,
      status: true,
    },
  });

  if (invitation) {
    const isInviter = invitation.invitedById === userId;

    // Invitation Sent (for inviter)
    if (isInviter && invitation.messageConfirmedAt) {
      milestones.push({
        label: 'Invitation ready',
        timestamp: invitation.messageConfirmedAt,
      });
    }

    // Invitation Accepted (for invitee, or when partner accepted for inviter)
    if (invitation.acceptedAt && invitation.status === InvitationStatus.ACCEPTED) {
      milestones.push({
        label: isInviter ? 'Partner accepted invitation' : 'You accepted the invitation',
        timestamp: invitation.acceptedAt,
      });
    }
  }

  // 2. Get Stage 0 progress for compact signed milestone
  const stage0Progress = await prisma.stageProgress.findFirst({
    where: {
      sessionId,
      userId,
      stage: 0,
    },
    select: {
      gatesSatisfied: true,
    },
  });

  if (stage0Progress?.gatesSatisfied) {
    const gates = stage0Progress.gatesSatisfied as Stage0Gates;
    if (gates.compactSigned && gates.signedAt) {
      milestones.push({
        label: 'You signed the curiosity compact',
        timestamp: new Date(gates.signedAt),
      });
    }
  }

  // 3. Get Stage 1 progress for feel-heard milestone
  const stage1Progress = await prisma.stageProgress.findFirst({
    where: {
      sessionId,
      userId,
      stage: 1,
    },
    select: {
      gatesSatisfied: true,
      completedAt: true,
    },
  });

  if (stage1Progress?.gatesSatisfied) {
    const gates = stage1Progress.gatesSatisfied as Stage1Gates;
    if (gates.feelHeardConfirmed && gates.feelHeardConfirmedAt) {
      milestones.push({
        label: 'You confirmed feeling heard',
        timestamp: new Date(gates.feelHeardConfirmedAt),
      });
    }
  }

  if (milestones.length === 0) {
    return null;
  }

  // Sort by timestamp
  milestones.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Format as simple list
  const lines = ['## Process milestones:'];
  for (const m of milestones) {
    lines.push(`- ${m.label}`);
  }

  return lines.join('\n');
}

/**
 * Shared content item for formatting
 */
interface SharedContentItem {
  timestamp: Date;
  type: 'empathy_statement' | 'additional_context' | 'partner_perspective';
  content: string;
  sharedBy: 'user' | 'partner';
}

/**
 * Get formatted shared content context for a user in a session.
 * This includes:
 * - EmpathyAttempt with status REVEALED (shared empathy statements)
 * - ReconcilerShareOffer with deliveryStatus DELIVERED (shared context)
 * - Messages with role SHARED_CONTEXT or EMPATHY_STATEMENT
 * - ConsentedContent with consentActive true
 *
 * @param sessionId - The session ID
 * @param userId - The current user's ID (to determine perspective)
 * @returns Formatted string for injection into AI prompts, or null if no content
 */
export async function getSharedContentContext(
  sessionId: string,
  userId: string
): Promise<string | null> {
  const sharedItems: SharedContentItem[] = [];

  // 1. Get EmpathyAttempts that have been REVEALED
  const empathyAttempts = await prisma.empathyAttempt.findMany({
    where: {
      sessionId,
      status: EmpathyStatus.REVEALED,
    },
    select: {
      content: true,
      revealedAt: true,
      sourceUserId: true,
    },
    orderBy: { revealedAt: 'asc' },
  });

  for (const attempt of empathyAttempts) {
    if (attempt.revealedAt) {
      sharedItems.push({
        timestamp: attempt.revealedAt,
        type: 'empathy_statement',
        content: attempt.content,
        sharedBy: attempt.sourceUserId === userId ? 'user' : 'partner',
      });
    }
  }

  // 2. Get ReconcilerShareOffers that have been DELIVERED
  const shareOffers = await prisma.reconcilerShareOffer.findMany({
    where: {
      result: { sessionId },
      deliveryStatus: SharedContentDeliveryStatus.DELIVERED,
      sharedContent: { not: null },
    },
    select: {
      sharedContent: true,
      sharedAt: true,
      userId: true,
    },
    orderBy: { sharedAt: 'asc' },
  });

  for (const offer of shareOffers) {
    if (offer.sharedAt && offer.sharedContent) {
      sharedItems.push({
        timestamp: offer.sharedAt,
        type: 'additional_context',
        content: offer.sharedContent,
        sharedBy: offer.userId === userId ? 'user' : 'partner',
      });
    }
  }

  // 3. Get Messages with special sharing roles
  // CRITICAL: Only include messages directed TO this user or sent BY this user.
  // Without this filter, partner's empathy statements leak into the other user's prompt.
  const sharedMessages = await prisma.message.findMany({
    where: {
      sessionId,
      role: { in: ['EMPATHY_STATEMENT', 'SHARED_CONTEXT'] },
      OR: [
        { forUserId: userId },  // Messages directed to this user
        { senderId: userId },   // Messages sent by this user
      ],
    },
    select: {
      content: true,
      timestamp: true,
      role: true,
      senderId: true,
    },
    orderBy: { timestamp: 'asc' },
  });

  for (const msg of sharedMessages) {
    sharedItems.push({
      timestamp: msg.timestamp,
      type: msg.role === 'EMPATHY_STATEMENT' ? 'empathy_statement' : 'additional_context',
      content: msg.content,
      sharedBy: msg.senderId === userId ? 'user' : 'partner',
    });
  }

  // 4. Get ConsentedContent that is active
  // First need to find SharedVessel for the session
  const sharedVessels = await prisma.sharedVessel.findMany({
    where: { sessionId },
    select: { id: true },
  });

  if (sharedVessels.length > 0) {
    const consentedContent = await prisma.consentedContent.findMany({
      where: {
        sharedVesselId: { in: sharedVessels.map((v) => v.id) },
        consentActive: true,
      },
      select: {
        transformedContent: true,
        consentedAt: true,
        sourceUserId: true,
      },
      orderBy: { consentedAt: 'asc' },
    });

    for (const content of consentedContent) {
      sharedItems.push({
        timestamp: content.consentedAt,
        type: 'partner_perspective',
        content: content.transformedContent,
        sharedBy: content.sourceUserId === userId ? 'user' : 'partner',
      });
    }
  }

  // If no shared content, return null
  if (sharedItems.length === 0) {
    return null;
  }

  // Sort all items by timestamp
  sharedItems.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Format as prompt section
  const lines: string[] = ['## What has been shared in this conversation:'];

  for (const item of sharedItems) {
    const timeStr = item.timestamp.toISOString();
    const who = item.sharedBy === 'user' ? 'You' : 'Your partner';

    switch (item.type) {
      case 'empathy_statement':
        lines.push(`- [${timeStr}] ${who} shared an empathy statement: "${item.content}"`);
        break;
      case 'additional_context':
        lines.push(`- [${timeStr}] ${who} shared additional context: "${item.content}"`);
        break;
      case 'partner_perspective':
        lines.push(`- [${timeStr}] ${who} shared their perspective: "${item.content}"`);
        break;
    }
  }

  return lines.join('\n');
}
