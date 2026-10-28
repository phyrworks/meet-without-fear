/**
 * Stream Turn Resolution
 *
 * Post-stream resolution for a streaming chat turn, extracted
 * (behavior-preserving) from `sendMessageStream`. It runs after the model
 * stream ends and before the `metadata`/`text_complete` frames are emitted:
 *
 * - reassembles the captured hidden tags into a full response and re-parses
 *   it with the legacy micro-tag parser (compatibility fallback only — tool
 *   calls captured during the stream always win);
 * - merges parsed values into `metadata` under fixed precedence rules;
 * - applies the Stage 4 clarification guard, which cancels a captured
 *   walkthrough action when the visible response is actually a clarifying
 *   question;
 * - runs dispatch handling, which may replace the visible response entirely;
 * - enforces the empty-response guard by throwing, so the caller's stream
 *   error path deletes the user message and surfaces a retryable failure.
 */

import { logger } from '../lib/logger';
import { parseMicroTagResponse } from '../utils/micro-tag-parser';
import { scrubVisibleAIText } from '../utils/visible-text';
import { handleDispatch, type DispatchContext } from './dispatch-handler';
import type { SessionStateToolInput } from './stage-tools';
import type { CapturedHiddenTags } from './stream-tag-sanitizer';

function isClarifyingStage4Response(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.endsWith('?')) return false;

  return /\b(?:do you mean|what do you mean|which|or something else|clarify|more specific|can you say more|are you saying)\b/i.test(
    trimmed,
  );
}

export interface StreamTurnResolutionParams {
  requestId: string;
  sessionId: string;
  turnId: string;
  currentStage: number;
  isInvitationPhase: boolean;
  /** The user's message content for this turn. */
  content: string;
  /** Chronological recent history, used to build the dispatch context. */
  history: Array<{ role: string; content: string }>;
  userName: string;
  partnerName: string | undefined;
  session: { status: string };
  /** Visible text emitted during the stream. */
  accumulatedText: string;
  /** Mutated in place and returned; the caller emits it on the wire. */
  metadata: SessionStateToolInput;
  captured: CapturedHiddenTags;
  /** Emits one text chunk to the client (the SSE `chunk` frame). */
  emitVisibleChunk: (text: string) => void;
}

export interface StreamTurnResolution {
  /** Final visible text to persist and (for dispatch) already re-emitted. */
  accumulatedText: string;
  metadata: SessionStateToolInput;
  /** True when a known dispatch tag produced the response (skips background jobs). */
  isDispatchMessage: boolean;
}

export async function resolveStreamTurn(params: StreamTurnResolutionParams): Promise<StreamTurnResolution> {
  const {
    requestId,
    sessionId,
    turnId,
    currentStage,
    isInvitationPhase,
    content,
    history,
    userName,
    partnerName,
    session,
    metadata,
    captured,
    emitVisibleChunk,
  } = params;

  let accumulatedText = params.accumulatedText;
  let isDispatchMessage = false; // Track if this is a dispatch response (skip processing)

  // ===========================================================================
  // Parse accumulated response for metadata (semantic router format)
  // The thinking content has flags like FeelHeardCheck:Y, ReadyShare:Y
  // The accumulated text may contain <draft>...</draft> that needs stripping
  // ===========================================================================
  const needsBlock = captured.needs ? `<needs>${captured.needs}</needs>\n` : '';
  const needBlock = captured.need ? `<need>${captured.need}</need>\n` : '';
  const needActionBlock = captured.needAction ? `${captured.needAction}\n` : '';
  const stage4ProposalsBlock = captured.stage4Proposals
    ? `<stage4_proposals>${captured.stage4Proposals}</stage4_proposals>\n`
    : '';
  const stage4WalkthroughBlock = captured.stage4Walkthrough
    ? `<stage4_walkthrough>${captured.stage4Walkthrough}</stage4_walkthrough>\n`
    : '';
  const fullResponse = `<thinking>${captured.thinking}</thinking>\n${needBlock}${needActionBlock}${needsBlock}${stage4ProposalsBlock}${stage4WalkthroughBlock}${accumulatedText}`;
  const parsed = parseMicroTagResponse(fullResponse);

  // Extract metadata from parsed response
  if (metadata.offerFeelHeardCheck === undefined) {
    metadata.offerFeelHeardCheck = parsed.offerFeelHeardCheck;
  }
  if (metadata.offerReadyToShare === undefined) {
    metadata.offerReadyToShare = parsed.offerReadyToShare;
  }
  if (parsed.proposedStrategies.length > 0) {
    metadata.proposedStrategies = parsed.proposedStrategies;
  }
  if (currentStage === 4 && parsed.stage4ProposalBlockPresent && !metadata.stage4Proposals) {
    metadata.stage4Proposals = parsed.stage4Proposals;
  }
  if (currentStage === 4 && parsed.stage4WalkthroughAction && !metadata.stage4WalkthroughAction) {
    metadata.stage4WalkthroughAction = parsed.stage4WalkthroughAction;
  }
  if (currentStage === 3 && parsed.proposedNeeds.length > 0 && !metadata.proposedNeeds) {
    metadata.proposedNeeds = parsed.proposedNeeds;
  }
  if (currentStage === 3 && parsed.proposedNeed && !metadata.proposedNeed) {
    metadata.proposedNeed = parsed.proposedNeed;
  }
  if (currentStage === 3 && parsed.needAction && !metadata.needAction) {
    metadata.needAction = parsed.needAction;
  }
  if (currentStage === 3 && parsed.needParseError) {
    metadata.needParseError = parsed.needParseError;
  }

  // Use the draft captured during streaming (more reliable than re-parsing)
  const draft = captured.draft || parsed.draft;
  if (draft && currentStage === 2 && !metadata.proposedEmpathyStatement) {
    // Draft is used for empathy statement (stage 2).
    metadata.proposedEmpathyStatement = draft;
  } else if (draft && (currentStage === 0 || isInvitationPhase) && !metadata.topicFrame) {
    // Stage 0: <draft> contains the proposed topic frame.
    metadata.topicFrame = draft.trim();
  }

  logger.info(`[sendMessageStream:${requestId}] Parsed metadata:`, {
    offerFeelHeardCheck: metadata.offerFeelHeardCheck,
    offerReadyToShare: metadata.offerReadyToShare,
    hasDraft: !!parsed.draft,
    proposedNeedsCount: metadata.proposedNeeds?.length ?? 0,
    proposedNeed: !!metadata.proposedNeed,
    needAction: metadata.needAction?.type ?? null,
    needParseError: metadata.needParseError ?? null,
    stage4ProposalCount: metadata.stage4Proposals?.length ?? 0,
    dispatchTag: captured.dispatch || parsed.dispatchTag,
  });

  // Clean accumulated text (strip <draft> and <dispatch> tags if they leaked through)
  const scrubbedResponse = scrubVisibleAIText(parsed.response);
  accumulatedText = scrubbedResponse.text;
  if (
    currentStage === 4 &&
    metadata.stage4WalkthroughAction &&
    metadata.stage4WalkthroughAction.action !== 'NONE' &&
    isClarifyingStage4Response(accumulatedText)
  ) {
    logger.warn(
      `[sendMessageStream:${requestId}] Ignoring Stage 4 state capture because visible response asks for clarification`,
      {
        action: metadata.stage4WalkthroughAction.action,
        needId: metadata.stage4WalkthroughAction.needId ?? null,
        stage4ProposalCount: metadata.stage4Proposals?.length ?? 0,
      },
    );
    metadata.stage4WalkthroughAction = {
      ...metadata.stage4WalkthroughAction,
      action: 'NONE',
      reason: 'visible_response_requested_clarification',
    };
    metadata.stage4Proposals = undefined;
  }

  // ===========================================================================
  // DISPATCH HANDLING: If dispatch tag detected, get and stream dispatched response
  // Dispatch messages are system responses - skip classifier/embeddings
  // Use the dispatch tag captured during streaming (more reliable than re-parsing)
  // ===========================================================================
  const dispatchTag = captured.dispatch || parsed.dispatchTag;
  if (dispatchTag) {
    logger.info(`[sendMessageStream:${requestId}] Dispatch detected: ${dispatchTag}`);
    isDispatchMessage = true;

    // Build dispatch context with conversation history and session state
    const dispatchContext: DispatchContext = {
      userMessage: content,
      conversationHistory: history.map(m => ({
        role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      })),
      userName,
      partnerName,
      sessionId,
      turnId,
      currentStage,
      invitationSent: session.status !== 'CREATED', // INVITED or ACTIVE means sent
      partnerJoined: session.status === 'ACTIVE',
    };

    const dispatchedResponse = await handleDispatch(dispatchTag, dispatchContext);

    if (dispatchedResponse !== null) {
      // Use ONLY the dispatch response - ignore any acknowledgment text the AI may have sent
      // (The prompt instructs AI to not send visible text, but in case it does, we ignore it)
      logger.info(`[sendMessageStream:${requestId}] Dispatch response only (ignoring any streamed acknowledgment)`);
      emitVisibleChunk(dispatchedResponse);
      accumulatedText = dispatchedResponse;
    } else {
      // Unknown dispatch tag — fall through and use the AI's original streamed response
      logger.info(
        `[sendMessageStream:${requestId}] Unknown dispatch tag "${dispatchTag}" — using original AI response`,
      );
      isDispatchMessage = false;
    }
  }

  // Guard: empty AI response after parsing + dispatch means the model emitted
  // no usable user-facing text, or the upstream stream failed without
  // producing text. Treat this as a failed turn so the frontend can show its
  // retry/error state instead of saving a misleading canned response.
  if (!accumulatedText.trim()) {
    logger.error(`[sendMessageStream:${requestId}] Empty AI response after tag stripping`, {
      dispatchTag: dispatchTag ?? null,
      scrubbedPlannerText: scrubbedResponse.scrubbed,
    });
    throw new Error('AI response was empty after tag stripping');
  }

  return { accumulatedText, metadata, isDispatchMessage };
}
