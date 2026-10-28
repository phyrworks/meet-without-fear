/**
 * Stream Turn Model Execution
 *
 * The two-pass model flow for a streaming chat turn, extracted
 * (behavior-preserving) from `sendMessageStream`:
 *
 * 1. A non-visible **state capture pass** that asks the model to call
 *    `update_session_state`, with a legacy micro-tag parse as fallback when
 *    the model answers with prose instead of a tool call.
 * 2. The **visible response pass**, streamed through `StreamTagSanitizer` so
 *    hidden reasoning/tag content never reaches the client, with a further
 *    defense-in-depth tag strip and planner-prose scrub per chunk.
 *
 * Prompt augmentation for both passes lives here. The caller supplies
 * `emitVisibleChunk` (the SSE `chunk` frame) and `isClientDisconnected`, so
 * this service performs no transport work of its own.
 *
 * Structured state is only ever taken from the validated tool input or the
 * micro-tag parser — never from free model prose.
 */

import { logger } from '../lib/logger';
import { getModelCompletionWithTools, getSonnetStreamingResponse, BrainActivityCallType } from '../lib/bedrock';
import { parseMicroTagResponse } from '../utils/micro-tag-parser';
import {
  getToolsForStage,
  parseSessionStateToolInput,
  SESSION_STATE_TOOL_NAME,
  type SessionStateToolInput,
} from './stage-tools';
import { StreamTagSanitizer, type CapturedHiddenTags } from './stream-tag-sanitizer';
import { scrubVisibleAIText } from '../utils/visible-text';

export interface StreamTurnModelParams {
  requestId: string;
  sessionId: string;
  turnId: string;
  currentStage: number;
  isInvitationPhase: boolean;
  /** 1-based count of user turns including the one just saved. */
  userTurnCount: number;
  prompt: { staticBlock: string; dynamicBlock: string };
  messagesWithContext: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Emits one visible text chunk to the client (the SSE `chunk` frame). */
  emitVisibleChunk: (text: string) => void;
  /** Read at each emission point; suppresses output once the client is gone. */
  isClientDisconnected: () => boolean;
}

export interface StreamTurnModelResult {
  /** Visible text actually emitted to the client this turn. */
  accumulatedText: string;
  /** Structured state from the capture pass merged with in-stream tool calls. */
  metadata: SessionStateToolInput;
  /** Hidden-tag content captured by the sanitizer, for post-stream resolution. */
  captured: CapturedHiddenTags;
}

export async function runStreamTurnModel(params: StreamTurnModelParams): Promise<StreamTurnModelResult> {
  const {
    requestId,
    sessionId,
    turnId,
    currentStage,
    isInvitationPhase,
    userTurnCount,
    prompt,
    messagesWithContext,
    emitVisibleChunk,
    isClientDisconnected,
  } = params;

  let accumulatedText = '';
  let metadata: SessionStateToolInput = {};

  // The three-phase hidden-tag trap (thinking trap → tag trap → normal
  // streaming with late-tag buffering) lives in StreamTagSanitizer; this
  // service only routes deltas through it and emits what it returns.
  const sanitizer = new StreamTagSanitizer({
    info: message => logger.info(`[sendMessageStream:${requestId}] ${message}`),
    warn: message => logger.warn(`[sendMessageStream:${requestId}] ${message}`),
  });

  const stateCapturePrompt = {
    staticBlock: prompt.staticBlock,
    dynamicBlock: `${prompt.dynamicBlock}

STATE CAPTURE PASS:
Call update_session_state with any persisted state required by the latest user turn. Do not write conversational prose in this pass.`,
  };
  const stateCapture = await getModelCompletionWithTools('sonnet', {
    systemPrompt: stateCapturePrompt,
    messages: messagesWithContext,
    tools: getToolsForStage(currentStage),
    maxTokens: 1024,
    sessionId,
    turnId,
    operation: 'structured-state-capture',
    callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
  });
  const sessionStateTool = stateCapture?.toolInvocations.find(tool => tool.name === SESSION_STATE_TOOL_NAME);
  if (sessionStateTool) {
    metadata = { ...metadata, ...parseSessionStateToolInput(sessionStateTool.input) };
    logger.info(`[sendMessageStream:${requestId}] [PRESTREAM TOOL ${sessionStateTool.name}]:`, {
      topicFrame: Boolean(metadata.topicFrame),
      proposedNeed: Boolean(metadata.proposedNeed),
      needAction: metadata.needAction?.type ?? null,
      stage4ProposalCount: metadata.stage4Proposals?.length ?? 0,
      stage4WalkthroughAction: metadata.stage4WalkthroughAction?.action ?? null,
      offerFeelHeardCheck: metadata.offerFeelHeardCheck,
      offerReadyToShare: metadata.offerReadyToShare,
    });
  } else if (stateCapture?.text) {
    const parsedStateFallback = parseMicroTagResponse(stateCapture.text);
    metadata.offerFeelHeardCheck = parsedStateFallback.offerFeelHeardCheck;
    metadata.offerReadyToShare = parsedStateFallback.offerReadyToShare;
    if (currentStage === 3 && parsedStateFallback.proposedNeed)
      metadata.proposedNeed = parsedStateFallback.proposedNeed;
    if (currentStage === 3 && parsedStateFallback.needAction) metadata.needAction = parsedStateFallback.needAction;
    if (currentStage === 3 && parsedStateFallback.proposedNeeds.length > 0)
      metadata.proposedNeeds = parsedStateFallback.proposedNeeds;
    if (currentStage === 4 && parsedStateFallback.stage4ProposalBlockPresent)
      metadata.stage4Proposals = parsedStateFallback.stage4Proposals;
    if (currentStage === 4 && parsedStateFallback.stage4WalkthroughAction)
      metadata.stage4WalkthroughAction = parsedStateFallback.stage4WalkthroughAction;
    if ((currentStage === 0 || isInvitationPhase) && parsedStateFallback.topicFrame)
      metadata.topicFrame = parsedStateFallback.topicFrame;
    if (currentStage === 2 && parsedStateFallback.draft) metadata.proposedEmpathyStatement = parsedStateFallback.draft;
    logger.warn(
      `[sendMessageStream:${requestId}] Structured state capture returned text without tool; parsed legacy fallback.`,
    );
  }

  const visiblePrompt = {
    staticBlock: prompt.staticBlock,
    dynamicBlock: `${prompt.dynamicBlock}

VISIBLE RESPONSE PASS:
Persisted state has already been captured for this turn. The update_session_state tool is intentionally unavailable now. Ignore any instruction to call it in this pass.
Captured state summary for your private context: ${JSON.stringify({
      topicFrame: metadata.topicFrame,
      offerFeelHeardCheck: metadata.offerFeelHeardCheck,
      offerReadyToShare: metadata.offerReadyToShare,
      proposedEmpathyStatement: metadata.proposedEmpathyStatement ? '[captured]' : undefined,
      proposedNeed: metadata.proposedNeed,
      needAction: metadata.needAction,
      stage4ProposalCount: metadata.stage4Proposals?.length,
      stage4WalkthroughAction: metadata.stage4WalkthroughAction,
    })}
Write only the user-facing conversational response. Do not include tool JSON, XML tags beyond the normal hidden <thinking> protocol, or state summaries.`,
  };
  const streamGenerator = getSonnetStreamingResponse({
    systemPrompt: visiblePrompt,
    messages: messagesWithContext,
    maxTokens: 1536,
    sessionId,
    turnId,
    operation: 'streaming-response',
    callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    // For E2E mock mode: response index is 0-based (userTurnCount is 1-based after save)
    mockResponseIndex: Math.max(0, userTurnCount - 1),
  });

  const streamStartTime = Date.now();
  let firstChunkTime: number | null = null;
  let lastChunkTime: number | null = null;
  let thinkingEndTime: number | null = null;

  /**
   * Helper to strip tags and send clean text to client
   * NOTE: Do NOT use .trim() on every chunk - it removes spaces between words when streaming
   * BUT we DO trimStart() on the FIRST chunk to remove leading newlines after </thinking>
   */
  const sendCleanText = (text: string) => {
    if (!text || isClientDisconnected()) return;

    // Strip ALL semantic tags as defense-in-depth (thinking trap should catch these,
    // but this prevents leaks if the trap fails due to stream errors or chunk splitting)
    let cleanText = text
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '') // Complete thinking blocks
      .replace(/<thinking>[\s\S]*/gi, '') // Unclosed thinking (strip to end)
      .replace(/<\/thinking>/gi, '') // Orphaned closing tag
      .replace(/<draft>[\s\S]*?<\/draft>/gi, '')
      .replace(/<need>[\s\S]*?<\/need>/gi, '')
      .replace(/<need-action\b[^>]*>[\s\S]*?<\/need-action>/gi, '')
      .replace(/<need-action\b[^>]*\/>/gi, '')
      .replace(/<needs>[\s\S]*?<\/needs>/gi, '')
      .replace(/<stage4_proposals>[\s\S]*?<\/stage4_proposals>/gi, '')
      .replace(/<stage4_proposals>[\s\S]*/gi, '')
      .replace(/<\/stage4_proposals>/gi, '')
      .replace(/<stage4_walkthrough>[\s\S]*?<\/stage4_walkthrough>/gi, '')
      .replace(/<stage4_walkthrough>[\s\S]*/gi, '')
      .replace(/<\/stage4_walkthrough>/gi, '')
      .replace(/<dispatch>[\s\S]*?<\/dispatch>/gi, '');

    // Trim LEADING whitespace only on the FIRST chunk (after </thinking> tag removal)
    // This removes newlines at the start without breaking word spacing in subsequent chunks
    if (!firstChunkTime && cleanText.length > 0) {
      cleanText = cleanText.trimStart();
    }

    const scrubbed = scrubVisibleAIText(cleanText, { preserveBoundaryWhitespace: true });
    cleanText = scrubbed.text;

    if (cleanText.length > 0) {
      if (!firstChunkTime) firstChunkTime = Date.now();
      accumulatedText += cleanText;
      emitVisibleChunk(cleanText);
    }
  };

  for await (const event of streamGenerator) {
    if (event.type === 'text') {
      lastChunkTime = Date.now();
      const wasInsideThinking = sanitizer.insideThinking;
      sendCleanText(sanitizer.push(event.text));
      // Timing parity with the original inline machine: the thinking phase
      // only "completes" when a real </thinking> closed (opener confirmed),
      // not when the no-thinking bail-out leaves the trap.
      if (
        wasInsideThinking &&
        !sanitizer.insideThinking &&
        sanitizer.confirmedThinkingOpener &&
        thinkingEndTime === null
      ) {
        thinkingEndTime = Date.now();
        logger.info(
          `[sendMessageStream:${requestId}] [TIMING] Thinking phase complete at ${thinkingEndTime - streamStartTime}ms`,
        );
      }
    }
    if (event.type === 'tool_use') {
      if (event.name === SESSION_STATE_TOOL_NAME) {
        const toolMetadata = parseSessionStateToolInput(event.input);
        metadata = { ...metadata, ...toolMetadata };
        logger.info(`[sendMessageStream:${requestId}] [TOOL ${event.name}]:`, {
          topicFrame: Boolean(toolMetadata.topicFrame),
          stage4ProposalCount: toolMetadata.stage4Proposals?.length ?? 0,
          stage4WalkthroughAction: toolMetadata.stage4WalkthroughAction?.action ?? null,
          proposedNeed: Boolean(toolMetadata.proposedNeed),
          needAction: toolMetadata.needAction?.type ?? null,
          offerFeelHeardCheck: toolMetadata.offerFeelHeardCheck,
          offerReadyToShare: toolMetadata.offerReadyToShare,
        });
      } else {
        logger.warn(`[sendMessageStream:${requestId}] Ignoring unknown tool call: ${event.name}`);
      }
      continue;
    }

    // Check for done event with error flag (generator catches errors internally
    // and yields a done event with an error string instead of throwing)
    if (event.type === 'done' && event.error) {
      throw new Error(event.error);
    }
  }

  // ===========================================================================
  // SAFETY FLUSH: If the stream ends while still waiting for </thinking>,
  // keep that content hidden. It is more important to avoid leaking
  // internal reasoning/tool planning than to salvage malformed output.
  // ===========================================================================
  // (Unterminated-thinking hiding vs. visible flush is decided inside the
  // sanitizer; a hidden buffer yields '' here and stays in captured.thinking.)
  sendCleanText(sanitizer.flush());

  const streamEndTime = Date.now();
  logger.info(
    `[sendMessageStream:${requestId}] [TIMING] Stream complete:`,
    `total=${streamEndTime - streamStartTime}ms`,
    `thinkingEnd=${thinkingEndTime ? thinkingEndTime - streamStartTime : 'none'}ms`,
    `firstVisibleChunk=${firstChunkTime ? firstChunkTime - streamStartTime : 'none'}ms`,
    `lastChunk=${lastChunkTime ? lastChunkTime - streamStartTime : 'none'}ms`,
  );

  return { accumulatedText, metadata, captured: sanitizer.captured };
}
