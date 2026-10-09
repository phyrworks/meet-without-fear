/**
 * Stream Turn Actions
 *
 * Stage-specific state application for a streaming chat turn, extracted
 * (behavior-preserving) from `sendMessageStream`:
 *
 * - `applyStage3NeedActions` runs after the model stream ends and BEFORE the
 *   `text_complete` frame is emitted, so captured-need metadata rides along
 *   on the wire.
 * - `persistTurnState` runs after the AI message row is created and persists
 *   Stage 1 gates, the Stage 0 topic frame, the Stage 2/2B empathy draft, and
 *   the Stage 4 structured capture/walkthrough/auto-closure.
 *
 * Every mutation here is driven by validated structured metadata
 * (`SessionStateToolInput` — the shared StreamMetadata contract), never by
 * raw model prose.
 */

import { Prisma } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { publishSessionEvent, publishTopicFrameUpdated } from './realtime';
import { captureProposedNeedsForUser, captureSingleNeedForUser } from './needs';
import { applyNeedAction, applyNeedEdits } from './needs-edit-applier.service';
import { interpretNeedEditRequest } from './needs-edit-interpreter.service';
import { captureStage4Turn } from './stage4-capture.service';
import { applyStage4AutoClosureFromSignal } from './stage4-auto-closure.service';
import { getStage4State as buildStage4State } from './stage4-state';
import type { SessionStateToolInput } from './stage-tools';
import type { ParsedStage4WalkthroughAction } from '../utils/micro-tag-parser';

export interface RefiningNeedContext {
  id: string;
  need: string;
  category?: string;
}

// ============================================================================
// Stage 3 — need capture / refinement (pre-text_complete)
// ============================================================================

export interface Stage3NeedActionParams {
  requestId: string;
  sessionId: string;
  userId: string;
  currentStage: number;
  refiningNeedContext: RefiningNeedContext | null;
  /** The user's message content for this turn. */
  userContent: string;
  /** The assistant's visible response text (post-sanitize). */
  aiResponseText: string;
  /** Mutated in place: needsCaptured is set when a mutation applies. */
  metadata: SessionStateToolInput;
}

export async function applyStage3NeedActions(params: Stage3NeedActionParams): Promise<void> {
  const { requestId, sessionId, userId, currentStage, refiningNeedContext, userContent, aiResponseText, metadata } = params;

  if (currentStage !== 3) return;

  if (metadata.needParseError) {
    logger.warn(`[sendMessageStream:${requestId}] Ignoring invalid Stage 3 need tag: ${metadata.needParseError}`);
  }

  if (
    refiningNeedContext &&
    !metadata.proposedNeed &&
    !metadata.needAction &&
    (!metadata.proposedNeeds || metadata.proposedNeeds.length === 0)
  ) {
    try {
      const interpretedEdit = await interpretNeedEditRequest(sessionId, userId, {
        targetNeedId: refiningNeedContext.id,
        request: [
          `The user is refining this need: "${refiningNeedContext.need}".`,
          `Their message was: "${userContent}".`,
          `The assistant response was: "${aiResponseText.trim()}".`,
          'If the assistant response contains a clearer wording for this same need, return an updateNeedText operation for the target need. If it does not contain a clear revision, ask for clarification.',
        ].join('\n'),
      });

      if (interpretedEdit.plan?.operations?.length) {
        const applied = await applyNeedEdits(sessionId, userId, interpretedEdit.plan.operations);
        metadata.needsCaptured = true;
        logger.info(`[sendMessageStream:${requestId}] Applied ${applied.applied.length} fallback need refinement operation(s) for ${refiningNeedContext.id}`);

        for (const affected of applied.applied) {
          const updatedNeed = affected.needId
            ? applied.needs.find((need) => need.id === affected.needId)
            : undefined;
          const eventType = affected.operation === 'remove'
            ? 'need.deleted'
            : affected.operation === 'add'
              ? 'need.captured'
              : 'need.refined';
          await publishSessionEvent(sessionId, eventType, {
            forUserId: userId,
            userId,
            need: updatedNeed,
            affectedNeed: affected,
          }).catch((err) =>
            logger.warn(`[sendMessageStream:${requestId}] Failed to publish ${eventType}:`, err)
          );
        }
      }
    } catch (error) {
      logger.warn(`[sendMessageStream:${requestId}] Fallback need refinement did not apply`, error);
    }
  }

  if (metadata.proposedNeed) {
    const captured = await captureSingleNeedForUser(sessionId, userId, metadata.proposedNeed);
    metadata.needsCaptured = true;
    logger.info(`[sendMessageStream:${requestId}] Captured single need ${captured.need.id} for user ${userId}`);

    await publishSessionEvent(sessionId, 'need.captured', {
      forUserId: userId,
      userId,
      need: captured.need,
      capturedAt: captured.capturedAt.toISOString(),
    }).catch((err) =>
      logger.warn(`[sendMessageStream:${requestId}] Failed to publish need.captured:`, err)
    );
  } else if (metadata.needAction) {
    const applied = await applyNeedAction(sessionId, userId, metadata.needAction);
    metadata.needsCaptured = applied.action === 'refine';
    const eventType = applied.action === 'refine'
      ? 'need.refined'
      : applied.action === 'delete'
        ? 'need.deleted'
        : 'need.locked';
    await publishSessionEvent(sessionId, eventType, {
      forUserId: userId,
      userId,
      oldId: applied.oldNeed?.id,
      oldNeed: applied.oldNeed,
      newId: applied.action === 'refine' ? applied.need?.id : undefined,
      need: applied.need,
    }).catch((err) =>
      logger.warn(`[sendMessageStream:${requestId}] Failed to publish ${eventType}:`, err)
    );
  } else if (metadata.proposedNeeds && metadata.proposedNeeds.length > 0) {
    const captured = await captureProposedNeedsForUser(sessionId, userId, metadata.proposedNeeds);
    metadata.needsCaptured = captured.needs.length > 0;
    logger.info(`[sendMessageStream:${requestId}] Captured ${captured.needs.length} proposed needs for user ${userId}`);

    await publishSessionEvent(sessionId, 'session.needs_extracted', {
      forUserId: userId,
      userId,
      needsCount: captured.needs.length,
      capturedAt: captured.capturedAt.toISOString(),
    }).catch((err) =>
      logger.warn(`[sendMessageStream:${requestId}] Failed to publish needs_extracted:`, err)
    );
  }
}

// ============================================================================
// Stage 4 — walkthrough action application
// ============================================================================

export async function applyStage4WalkthroughAction(
  sessionId: string,
  userId: string,
  action: ParsedStage4WalkthroughAction
): Promise<boolean> {
  if (action.action === 'NONE') return false;

  const before = await buildStage4State(sessionId, userId);
  const currentNeed = before.walkthrough.currentNeed;
  if (!currentNeed) return false;
  if (before.walkthrough.phase !== 'MY_NEEDS' && before.walkthrough.phase !== 'PARTNER_NEEDS') {
    return false;
  }
  if (currentNeed.status === 'covered' || currentNeed.status === 'skipped') return false;
  if (action.needId && action.needId !== currentNeed.id) {
    logger.warn('[applyStage4WalkthroughAction] Ignoring action for non-current need', {
      sessionId,
      userId,
      actionNeedId: action.needId,
      currentNeedId: currentNeed.id,
    });
    return false;
  }

  const progress = await prisma.stageProgress.findUnique({
    where: { sessionId_userId_stage: { sessionId, userId, stage: 4 } },
    select: { gatesSatisfied: true },
  });
  const gates = (progress?.gatesSatisfied as Record<string, unknown> | null) ?? {};
  const existing =
    gates.stage4Walkthrough &&
    typeof gates.stage4Walkthrough === 'object' &&
    !Array.isArray(gates.stage4Walkthrough)
      ? (gates.stage4Walkthrough as Record<string, unknown>)
      : {};
  const covered = new Set(
    Array.isArray(existing.coveredNeedIds)
      ? existing.coveredNeedIds.filter((id): id is string => typeof id === 'string')
      : []
  );
  const skipped = new Set(
    Array.isArray(existing.skippedNeedIds)
      ? existing.skippedNeedIds.filter((id): id is string => typeof id === 'string')
      : []
  );
  if (action.action === 'COVERED') {
    covered.add(currentNeed.id);
    skipped.delete(currentNeed.id);
  } else {
    skipped.add(currentNeed.id);
    covered.delete(currentNeed.id);
  }

  const remainingOwn = before.walkthrough.ownNeeds.find(
    (need) => !covered.has(need.id) && !skipped.has(need.id)
  );
  const remainingPartner = before.walkthrough.partnerNeeds.find(
    (need) => !covered.has(need.id) && !skipped.has(need.id)
  );
  const phase =
    before.walkthrough.phase === 'MY_NEEDS' && remainingOwn
      ? 'MY_NEEDS'
      : before.walkthrough.phase === 'MY_NEEDS' && remainingPartner
        ? 'PARTNER_NEEDS'
        : before.walkthrough.phase === 'PARTNER_NEEDS' && remainingPartner
          ? 'PARTNER_NEEDS'
          : remainingOwn
            ? 'MY_NEEDS'
            : remainingPartner
              ? 'PARTNER_NEEDS'
              : 'QUALITY_REVIEW';
  const currentNeedId =
    phase === 'MY_NEEDS'
      ? remainingOwn?.id ?? null
      : phase === 'PARTNER_NEEDS'
        ? remainingPartner?.id ?? null
        : null;

  await prisma.stageProgress.update({
    where: { sessionId_userId_stage: { sessionId, userId, stage: 4 } },
    data: {
      gatesSatisfied: {
        ...gates,
        stage4Walkthrough: {
          phase,
          currentNeedId,
          coveredNeedIds: [...covered],
          skippedNeedIds: [...skipped],
          updatedAt: new Date().toISOString(),
          updatedFrom: 'ai_walkthrough_action',
          lastAction: action.action,
          lastReason: action.reason ?? null,
        },
      } satisfies Prisma.InputJsonValue,
    },
  });

  logger.info('[applyStage4WalkthroughAction] Advanced Stage 4 walkthrough from model action', {
    sessionId,
    userId,
    needId: currentNeed.id,
    action: action.action,
    nextPhase: phase,
    nextNeedId: currentNeedId,
  });
  return true;
}

// ============================================================================
// Post-persist turn state (stage gates, topic frame, empathy draft, Stage 4)
// ============================================================================

export interface PersistTurnStateParams {
  requestId: string;
  sessionId: string;
  userId: string;
  currentStage: number;
  effectiveStage: number;
  isInvitationPhase: boolean;
  session: { topicFrame: string | null; topicFrameConfirmedAt: Date | null };
  progress: { id: string; gatesSatisfied: unknown } | null;
  userMessageId: string;
  userContent: string;
  aiMessageContent: string;
  /** Mutated in place: stage4Capture summary is attached here. */
  metadata: SessionStateToolInput;
}

export async function persistTurnState(params: PersistTurnStateParams): Promise<void> {
  const {
    requestId,
    sessionId,
    userId,
    currentStage,
    effectiveStage,
    isInvitationPhase,
    session,
    progress,
    userMessageId,
    userContent,
    aiMessageContent,
    metadata,
  } = params;

  if (currentStage === 1 && progress?.id && metadata.offerFeelHeardCheck) {
    const currentGates = (progress.gatesSatisfied as Record<string, unknown>) ?? {};
    await prisma.stageProgress.update({
      where: { id: progress.id },
      data: {
        gatesSatisfied: {
          ...currentGates,
          feelHeardCheckOffered: true,
        },
      },
    });
  }

  // Save topic frame (Stage 0 / invitation phase) - only if not already confirmed
  if ((currentStage === 0 || isInvitationPhase) && metadata.topicFrame) {
    try {
      const newTopicFrame = metadata.topicFrame.trim();
      if (newTopicFrame && !session.topicFrameConfirmedAt && newTopicFrame !== session.topicFrame) {
        await prisma.session.update({
          where: { id: sessionId },
          data: { topicFrame: newTopicFrame },
        });
        logger.info(`[sendMessageStream:${requestId}] Stage 0: Persisted topic frame "${newTopicFrame}"`);
        publishTopicFrameUpdated(sessionId, newTopicFrame, false).catch((err) =>
          logger.warn(`[sendMessageStream:${requestId}] Failed to publish topic_frame_updated:`, err)
        );
      }
    } catch (err) {
      logger.error(`[sendMessageStream:${requestId}] Failed to persist topic frame:`, err);
    }
  }

  // Save empathy draft (Stage 2 or Stage 2B)
  if ((effectiveStage === 2 || effectiveStage === 21) && metadata.offerReadyToShare && metadata.proposedEmpathyStatement) {
    await prisma.empathyDraft.upsert({
      where: {
        sessionId_userId: { sessionId, userId },
      },
      create: {
        sessionId,
        userId,
        content: metadata.proposedEmpathyStatement,
        readyToShare: false,
        version: 1,
      },
      update: {
        content: metadata.proposedEmpathyStatement,
        version: { increment: 1 },
      },
    });
  }

  // Stage 4 structured capture. ProposedStrategy micro-tags remain only as a
  // compatibility fallback feeding the same capture/apply path.
  if (currentStage === 4) {
    const captureResult = await captureStage4Turn({
      sessionId,
      userId,
      messageId: userMessageId,
      userMessage: userContent,
      aiResponse: aiMessageContent,
      structuredProposals: metadata.stage4Proposals,
      compatibilityProposedStrategies: metadata.proposedStrategies,
      topicFrame: session.topicFrame || undefined,
    });
    const stage4CaptureMetadata: NonNullable<SessionStateToolInput['stage4Capture']> = {
      appliedOperationCount: captureResult.appliedOperationCount,
      skippedOperationCount: captureResult.skippedOperationCount,
      selectionCaptured: Boolean(captureResult.selection),
      closureSignalCaptured: Boolean(captureResult.closureSignal?.readyToClose),
      confidence: captureResult.confidence,
    };
    metadata.stage4Capture = stage4CaptureMetadata;

    if (captureResult.appliedOperationCount > 0 || captureResult.selection) {
      logger.info(`[sendMessageStream:${requestId}] Stage 4 capture applied`, {
        appliedOperationCount: captureResult.appliedOperationCount,
        skippedOperationCount: captureResult.skippedOperationCount,
        selectionCaptured: Boolean(captureResult.selection),
      });

      await publishSessionEvent(sessionId, 'session.strategies_updated', {
        stage: 4,
        updatedBy: userId,
        appliedOperationCount: captureResult.appliedOperationCount,
        skippedOperationCount: captureResult.skippedOperationCount,
        selectionCaptured: Boolean(captureResult.selection),
      });
    }

    if (metadata.stage4WalkthroughAction) {
      const advanced = await applyStage4WalkthroughAction(
        sessionId,
        userId,
        metadata.stage4WalkthroughAction
      );
      if (advanced) {
        await publishSessionEvent(sessionId, 'session.strategies_updated', {
          stage: 4,
          updatedBy: userId,
          walkthroughUpdated: true,
          action: metadata.stage4WalkthroughAction.action,
          needId: metadata.stage4WalkthroughAction.needId ?? null,
        });
      }
    }

    const autoClosure = await applyStage4AutoClosureFromSignal({
      sessionId,
      userId,
      signal: captureResult.closureSignal,
    });
    if (autoClosure.closed) {
      stage4CaptureMetadata.autoClosed = true;
      logger.info(`[sendMessageStream:${requestId}] Stage 4 closed from conversation signal`, {
        reason: autoClosure.reason,
      });
    }
  }
}
