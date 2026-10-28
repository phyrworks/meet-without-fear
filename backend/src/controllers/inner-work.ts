/**
 * Inner Thoughts Controller (formerly Inner Work)
 *
 * Handles Inner Thoughts (solo self-reflection) session operations:
 * - POST /inner-thoughts - Create new session (optionally linked to partner session)
 * - GET /inner-thoughts - List sessions
 * - GET /inner-thoughts/:id - Get session with messages
 * - POST /inner-thoughts/:id/messages - Send message and get AI response
 * - PATCH /inner-thoughts/:id - Update session (title, status)
 * - DELETE /inner-thoughts/:id - Archive session
 *
 * Sessions can be linked to partner sessions for context-aware reflection.
 * When linked, the AI has access to partner session context.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { distillSession } from '../services/distillation';
import { getUser } from '../middleware/auth';
import { asyncHandler, ValidationError } from '../middleware/errors';
import {
  ApiResponse,
  InnerWorkSessionSummaryDTO,
  InnerWorkSessionDetailDTO,
  InnerWorkMessageDTO,
  CreateInnerWorkSessionResponse,
  ListInnerWorkSessionsResponse,
  GetInnerWorkSessionResponse,
  SendInnerWorkMessageResponse,
  UpdateInnerWorkSessionResponse,
  ArchiveInnerWorkSessionResponse,
  GenerateContextResponse,
  GetInnerWorkOverviewResponse,
  GetInsightsResponse,
  InsightDTO,
  InnerWorkStatus,
  InsightType,
  createInnerWorkSessionRequestSchema,
  sendInnerWorkMessageRequestSchema,
  updateInnerWorkSessionRequestSchema,
  listInnerWorkSessionsQuerySchema,
} from '@meet-without-fear/shared';
import { getSonnetResponse, getHaikuJson, getCompletion, BrainActivityCallType } from '../lib/bedrock';
import {
  buildInnerWorkPrompt,
  buildInnerWorkInitialMessagePrompt,
  buildLinkedInnerThoughtsInitialMessagePrompt,
  buildInnerWorkSummaryPrompt,
  buildLinkedInnerThoughtsPrompt,
  LinkedPartnerSessionContext,
  PromptBlocks,
} from '../services/stage-prompts';
import { extractJsonSafe } from '../utils/json-extractor';
import { embedInnerWorkSessionContent, searchTakeaways } from '../services/embedding';
import {
  updateInnerThoughtsSummary,
  getInnerThoughtsSummary,
  formatInnerThoughtsSummaryForPrompt,
  INNER_THOUGHTS_SUMMARIZATION_CONFIG,
} from '../services/conversation-summarizer';
import { detectMemoryIntent } from '../services/memory-detector';
import type { MemorySuggestion } from '@meet-without-fear/shared';
import { updateContext } from '../lib/request-context';
import { retrieveContext, formatRetrievedContext } from '../services/context-retriever';
import { resolveParticipant, getCoParticipants } from '../services/participant-resolver';
import { loadCurrentStages } from '../services/stage-shim';
import { loadSharedVesselFor } from '../services/context-assembler';

// ============================================================================
// Helper Functions
// ============================================================================

/** A `reflection` row (spec §1.6) as the unchanged Inner Work summary DTO. */
function mapSessionToSummary(session: {
  id: string;
  title: string | null;
  summary: string | null;
  theme: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  distilledAt?: Date | null;
  linkedSessionId?: string | null;
  contextSnapshot?: string | null;
  _count?: { messages: number };
}): InnerWorkSessionSummaryDTO {
  return {
    id: session.id,
    title: session.title,
    summary: session.summary,
    theme: session.theme,
    status: session.status as InnerWorkStatus,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    distilledAt: session.distilledAt?.toISOString() ?? null,
    messageCount: session._count?.messages ?? 0,
    linkedPartnerSessionId: session.linkedSessionId ?? null,
    // The target does not carry the branching message (spec §1.6 reflection Absorbs).
    linkedAtMessageId: null,
    contextSummarySnapshot: session.contextSnapshot ?? null,
  };
}

function mapMessageToDTO(message: { id: string; role: string; content: string; createdAt: Date }): InnerWorkMessageDTO {
  return {
    id: message.id,
    role: message.role as 'USER' | 'AI',
    content: message.content,
    timestamp: message.createdAt.toISOString(),
  };
}

/**
 * Get recent themes from user's inner work sessions for context.
 */
async function getRecentThemes(userId: string, excludeSessionId?: string): Promise<string[]> {
  const recentSessions = await prisma.reflection.findMany({
    where: {
      userId,
      theme: { not: null },
      id: excludeSessionId ? { not: excludeSessionId } : undefined,
    },
    orderBy: { updatedAt: 'desc' },
    take: 5,
    select: { theme: true },
  });

  return recentSessions.map(s => s.theme).filter((t): t is string => t !== null);
}

/**
 * Generate and update session metadata (title, summary, theme) after new messages.
 * Uses Haiku for fast, non-blocking updates on every message.
 */
async function updateSessionMetadata(sessionId: string, turnId: string): Promise<void> {
  try {
    // Messages are a separate findMany rather than a nested `take: 20` include:
    // Prisma 7 does not push a nested to-many `take` into SQL, so the include read
    // every message of the session on every message sent. This emits LIMIT.
    const [session, messages] = await Promise.all([
      prisma.reflection.findUnique({ where: { id: sessionId } }),
      prisma.reflectionMessage.findMany({
        where: { reflectionId: sessionId },
        orderBy: { createdAt: 'asc' },
        take: 20, // Last 20 messages for context
      }),
    ]);

    if (!session || messages.length < 2) {
      // Need at least a user message to summarize
      return;
    }

    const prompt = buildInnerWorkSummaryPrompt(
      messages.map(m => ({
        role: m.role === 'USER' ? 'user' : 'assistant',
        content: m.content,
      })),
    );

    const parsed = await getHaikuJson<{ title?: string; summary?: string; theme?: string }>({
      systemPrompt: prompt,
      messages: [{ role: 'user', content: 'Generate the metadata.' }],
      maxTokens: 256,
      innerWorkSessionId: sessionId,
      turnId,
      operation: 'inner-work-metadata',
    });

    if (parsed && (parsed.title || parsed.summary || parsed.theme)) {
      await prisma.reflection.update({
        where: { id: sessionId },
        data: {
          title: parsed.title || session.title,
          summary: parsed.summary || session.summary,
          theme: parsed.theme || session.theme,
        },
      });
    }
  } catch (error) {
    logger.error('[Inner Work] Failed to update metadata:', error);
    // Non-fatal - don't throw
  }
}

/**
 * Fetch context from a linked partner session for Inner Thoughts AI.
 * Only the user's own side of the session: their participant's MAIN
 * conversation, their own empathy draft and attempt, and — through the shared
 * vessel (the context builder, R35) — the partner's statement once REVEALED.
 * Never the partner's private rows.
 */
async function fetchLinkedPartnerSessionContext(
  userId: string,
  partnerSessionId: string,
): Promise<LinkedPartnerSessionContext | null> {
  try {
    const me = await resolveParticipant(partnerSessionId, userId);
    if (!me) return null;

    const [session, myMember, coParticipants, stages, vessel] = await Promise.all([
      prisma.session.findUnique({
        where: { id: partnerSessionId },
        select: { relationshipId: true, topicFrame: true },
      }),
      prisma.relationshipMember.findFirst({
        where: { userId, relationship: { sessions: { some: { id: partnerSessionId } } } },
        select: { nickname: true },
      }),
      getCoParticipants(me.id),
      loadCurrentStages([me.id]),
      loadSharedVesselFor(me.id),
    ]);
    if (!session) return null;

    // MY nickname for the partner (what I call them), then their display name.
    const partner = coParticipants.find(c => c.kind === 'human' && !c.leftAt) ?? coParticipants[0];
    const partnerName = myMember?.nickname || partner?.displayName || 'Partner';

    const currentStage = stages.get(me.id)?.stage || 1;

    // The user's conversation view: their own turns and the AI's replies to them.
    const [userMessages, aiMessages] = me.mainConversationId
      ? await Promise.all([
          prisma.message.findMany({
            where: { conversationId: me.mainConversationId, senderParticipantId: me.id, role: 'USER', kind: 'CHAT' },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { role: true, content: true, createdAt: true },
          }),
          prisma.message.findMany({
            where: { conversationId: me.mainConversationId, role: 'AI', kind: 'CHAT' },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { role: true, content: true, createdAt: true },
          }),
        ])
      : [[], []];
    const combinedMessages = [...userMessages, ...aiMessages]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(m => ({
        role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      }));

    const userDraft = await prisma.draft.findFirst({
      where: { participantId: me.id, kind: 'EMPATHY' },
      orderBy: { updatedAt: 'desc' },
      select: { content: true, readyToShare: true },
    });
    const empathyDraft = userDraft?.content;
    const empathyShared = userDraft?.readyToShare || false;

    // The partner's statement about me, only once revealed (the vessel admits nothing else).
    const partnerAttempt = vessel?.empathyAttempts.filter(a => a.direction === 'partner_to_user' && a.revealedAt).pop();
    const partnerEmpathy = partnerAttempt?.content;

    let waitingStatus: string | undefined;
    if (currentStage === 2 && empathyShared && !partnerEmpathy) {
      waitingStatus = `Waiting for ${partnerName} to share their empathy statement`;
    }

    return {
      partnerName,
      currentStage,
      waitingStatus,
      userMessages: combinedMessages,
      empathyDraft,
      empathyShared,
      partnerEmpathy,
      sessionTopic: session.topicFrame || undefined,
    };
  } catch (error) {
    logger.error('[Inner Thoughts] Failed to fetch partner context:', error);
    return null;
  }
}

// ============================================================================
// POST /inner-thoughts - Create new Inner Thoughts session
// ============================================================================

export const createInnerWorkSession = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate request body (with optional linked session fields)
  const parseResult = createInnerWorkSessionRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  // linkedAtStage / linkedTrigger are accepted and dropped: the target keeps
  // only when the link was made (spec §1.6 reflection, linked_at).
  const { title, initialMessage, linkedPartnerSessionId } = parseResult.data;

  // If linking to a partner session, verify it exists and user is a participant
  if (linkedPartnerSessionId) {
    // A present participant of the session (the link is context only: it
    // grants no visibility either way — spec §1.6 linked_session_id).
    const me = await resolveParticipant(linkedPartnerSessionId, user.id);
    if (!me) {
      throw new ValidationError('Partner session not found or you are not a participant');
    }
  }

  // Create the session
  const session = await prisma.reflection.create({
    data: {
      userId: user.id,
      title,
      status: 'ACTIVE',
      linkedSessionId: linkedPartnerSessionId,
      linkedAt: linkedPartnerSessionId ? new Date() : null,
    },
    include: {
      _count: { select: { messages: true } },
    },
  });

  const userName = user.firstName || user.name || 'there';
  const turnId = `${session.id}-inner-work-create`;

  // If initialMessage is provided, save user message first then generate AI response
  if (initialMessage) {
    // Save the user's initial message
    const userMessage = await prisma.reflectionMessage.create({
      data: {
        reflectionId: session.id,
        role: 'USER',
        content: initialMessage,
      },
    });

    // Build prompt for responding to user's message (not a greeting prompt)
    // Universal Retrieval for Initial Message
    const retrievedContext = await retrieveContext({
      userId: user.id,
      currentMessage: initialMessage,
      turnId,
      includeInnerThoughts: true,
      excludeInnerThoughtsSessionId: session.id,
      linkedPartnerSessionId: linkedPartnerSessionId,
      skipDetection: true,
      maxCrossSessionMessages: 10,
      similarityThreshold: 0.4,
      includePreSession: false,
    }).catch(err => {
      logger.warn('[Inner Work] Initial retrieval failed:', err);
      return null;
    });

    let prompt: string | PromptBlocks;
    if (linkedPartnerSessionId) {
      const linkedContext = await fetchLinkedPartnerSessionContext(user.id, linkedPartnerSessionId);
      if (linkedContext) {
        prompt = buildLinkedInnerThoughtsPrompt({
          userName,
          turnCount: 1,
          emotionalIntensity: 5,
          linkedContext,
        });
      } else {
        prompt = buildInnerWorkPrompt({
          userName,
          turnCount: 1,
          emotionalIntensity: 5,
        });
      }
    } else {
      prompt = buildInnerWorkPrompt({
        userName,
        turnCount: 1,
        emotionalIntensity: 5,
      });
    }

    // Inject context if found
    let messagesForLLM = [{ role: 'user' as const, content: initialMessage }];

    if (retrievedContext && retrievedContext.relevantFromOtherSessions.length > 0) {
      const formattedContext = formatRetrievedContext({
        ...retrievedContext,
        conversationHistory: [],
        preSessionMessages: [],
      });

      if (formattedContext.trim()) {
        logger.info(
          `[Inner Work] Injecting ${retrievedContext.relevantFromOtherSessions.length} retrieved messages into initial context`,
        );
        messagesForLLM = [
          {
            role: 'user' as const,
            content: `[Retrieved context:\n${formattedContext}]\n\n${initialMessage}`,
          },
        ];
      }
    }

    const fallbackResponse = "I hear you. Tell me more about what you're experiencing.";
    const aiResponse = await getSonnetResponse({
      systemPrompt: prompt,
      messages: messagesForLLM,
      maxTokens: 1024,
      innerWorkSessionId: session.id,
      turnId,
      operation: 'inner-work-initial-response',
      callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    });
    const parsed = extractJsonSafe<{
      response?: string;
      suggestedActions?: Array<{
        type: string;
        label: string;
        personName?: string;
        context?: string;
      }>;
    }>(aiResponse || '', {
      response: fallbackResponse,
    });

    const aiMessage = await prisma.reflectionMessage.create({
      data: {
        reflectionId: session.id,
        role: 'AI',
        content: parsed.response || fallbackResponse,
      },
    });

    // Embed session content (non-blocking)
    // Per fact-ledger architecture, we embed at session level
    embedInnerWorkSessionContent(session.id, turnId).catch((err: unknown) =>
      logger.warn('[Inner Work] Failed to embed session content:', err),
    );

    // Update session metadata (non-blocking)
    updateSessionMetadata(session.id, turnId).catch(err => logger.warn('[Inner Work] Failed to update metadata:', err));

    // Validate and map suggested actions from AI response
    const validActionTypes = ['start_partner_session', 'start_meditation', 'add_gratitude', 'check_need'] as const;
    const suggestedActions = (parsed.suggestedActions || [])
      .filter(
        (action): action is typeof action & { type: (typeof validActionTypes)[number] } =>
          validActionTypes.includes(action.type as (typeof validActionTypes)[number]) &&
          typeof action.label === 'string' &&
          action.label.length > 0,
      )
      .map(action => ({
        type: action.type as (typeof validActionTypes)[number],
        label: action.label,
        personName: action.personName,
        context: action.context || 'AI suggestion',
      }));

    const response: ApiResponse<CreateInnerWorkSessionResponse> = {
      success: true,
      data: {
        session: mapSessionToSummary({ ...session, _count: { messages: 2 } }),
        initialMessage: mapMessageToDTO(aiMessage),
        userMessage: mapMessageToDTO(userMessage),
        suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
      },
    };

    res.status(201).json(response);
    return;
  }

  // Standard flow: AI generates greeting first
  let prompt: string | PromptBlocks;
  let fallbackMessage = "Hey there. What's on your mind today?";

  if (linkedPartnerSessionId) {
    const linkedContext = await fetchLinkedPartnerSessionContext(user.id, linkedPartnerSessionId);
    if (linkedContext) {
      prompt = buildLinkedInnerThoughtsInitialMessagePrompt(userName, linkedContext);
      fallbackMessage = `This is your private space to process what's happening with ${linkedContext.partnerName}. What's on your mind right now?`;
    } else {
      prompt = buildInnerWorkInitialMessagePrompt(userName);
    }
  } else {
    prompt = buildInnerWorkInitialMessagePrompt(userName);
  }

  const aiResponse = await getSonnetResponse({
    systemPrompt: prompt,
    messages: [{ role: 'user', content: 'Start the conversation.' }],
    maxTokens: 256,
    innerWorkSessionId: session.id,
    turnId,
    operation: 'inner-work-initial',
    callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
  });
  const parsed = extractJsonSafe<{ response?: string }>(aiResponse || '', {
    response: fallbackMessage,
  });

  const aiMessage = await prisma.reflectionMessage.create({
    data: {
      reflectionId: session.id,
      role: 'AI',
      content: parsed.response || fallbackMessage,
    },
  });

  // Embed session content (non-blocking)
  // Per fact-ledger architecture, we embed at session level
  embedInnerWorkSessionContent(session.id, turnId).catch((err: unknown) =>
    logger.warn('[Inner Work] Failed to embed session content:', err),
  );

  const response: ApiResponse<CreateInnerWorkSessionResponse> = {
    success: true,
    data: {
      session: mapSessionToSummary({ ...session, _count: { messages: 1 } }),
      initialMessage: mapMessageToDTO(aiMessage),
    },
  };

  res.status(201).json(response);
});

// ============================================================================
// GET /inner-work - List inner work sessions
// ============================================================================

export const listInnerWorkSessions = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate query params
  const parseResult = listInnerWorkSessionsQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    throw new ValidationError('Invalid query parameters', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { status, limit = 20, offset = 0 } = parseResult.data;

  // Build where clause - use Prisma's enum type for 'not' filter
  const whereClause = {
    userId: user.id,
    status: status || { not: 'ARCHIVED' as const }, // Default: exclude archived
  };

  // Get total count for pagination
  const total = await prisma.reflection.count({ where: whereClause });

  // Fetch sessions sorted by updatedAt (which tracks last message time)
  const sessions = await prisma.reflection.findMany({
    where: whereClause,
    orderBy: { updatedAt: 'desc' },
    take: limit,
    skip: offset,
    include: {
      _count: { select: { messages: true } },
    },
  });

  const response: ApiResponse<ListInnerWorkSessionsResponse> = {
    success: true,
    data: {
      sessions: sessions.map(mapSessionToSummary),
      total,
      hasMore: offset + sessions.length < total,
    },
  };

  res.json(response);
});

// ============================================================================
// GET /inner-work/:id - Get inner work session with messages
// ============================================================================

export const getInnerWorkSession = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const sessionId = req.params.id;

  const session = await prisma.reflection.findFirst({
    where: {
      id: sessionId,
      userId: user.id,
    },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
      _count: { select: { messages: true } },
    },
  });

  if (!session) {
    throw new ValidationError('Session not found');
  }

  const detail: InnerWorkSessionDetailDTO = {
    ...mapSessionToSummary(session),
    messages: session.messages.map(mapMessageToDTO),
  };

  const response: ApiResponse<GetInnerWorkSessionResponse> = {
    success: true,
    data: {
      session: detail,
    },
  };

  res.json(response);
});

// ============================================================================
// POST /inner-work/:id/messages - Send message and get AI response
// ============================================================================

export const sendInnerWorkMessage = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const sessionId = req.params.id;

  // Validate request body
  const parseResult = sendInnerWorkMessageRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid message data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { content } = parseResult.data;

  // Verify session exists and belongs to user
  // Fetch ALL messages for accurate count, but we'll only use recent ones + summary for context
  const session = await prisma.reflection.findFirst({
    where: {
      id: sessionId,
      userId: user.id,
    },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!session) {
    throw new ValidationError('Session not found');
  }

  if (session.status !== 'ACTIVE') {
    throw new ValidationError('Session is not active');
  }

  // Save user message
  const userMessage = await prisma.reflectionMessage.create({
    data: {
      reflectionId: sessionId,
      role: 'USER',
      content,
    },
  });

  // Calculate total turn count (all messages, not just recent)
  const totalTurnCount = session.messages.length + 1;
  const userName = user.firstName || user.name || 'there';

  // Generate turnId early - needed for retrieval and LLM calls
  const turnId = `${sessionId}-${user.id}-inner-work-${totalTurnCount}`;

  // =========================================================================
  // PARALLEL PRE-LLM OPERATIONS (Performance Optimization)
  // Run all these in parallel to minimize latency
  // =========================================================================
  const [summaryData, recentThemes, linkedContext, retrievedContext, priorTakeaways] = await Promise.all([
    // 1. Get conversation summary if it exists
    getInnerThoughtsSummary(sessionId),
    // 2. Get recent themes
    getRecentThemes(user.id, sessionId),
    // 3. Fetch linked partner session context (if applicable)
    session.linkedSessionId
      ? fetchLinkedPartnerSessionContext(user.id, session.linkedSessionId)
      : Promise.resolve(null),
    // 4. Run semantic retrieval for cross-session context
    // Search on every message (as requested)
    retrieveContext({
      userId: user.id,
      currentMessage: content,
      turnId,
      includeInnerThoughts: true, // Search both partner sessions AND inner thoughts
      excludeInnerThoughtsSessionId: sessionId, // Don't include current session
      linkedPartnerSessionId: session.linkedSessionId || undefined, // Boost linked session
      skipDetection: true, // Always search - no Haiku gating for Inner Thoughts
      includePreSession: false,
      similarityThreshold: 0.4,
    }),
    // 5. Search prior takeaways relevant to the current message (Phase 23 — CONTEXT-01)
    searchTakeaways(user.id, content, 5, 0.45, turnId).catch(() => []),
  ]);

  const conversationSummaryText = summaryData ? formatInnerThoughtsSummaryForPrompt(summaryData) : undefined;

  // Build conversation history: use only recent messages for the prompt
  // If we have a summary, we keep fewer messages; otherwise keep more
  const recentMessageCount = summaryData ? INNER_THOUGHTS_SUMMARIZATION_CONFIG.recentMessagesToKeep : 20; // Keep more if no summary exists

  const recentMessages = session.messages.slice(-recentMessageCount);
  const history = recentMessages.map(m => ({
    role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
    content: m.content,
  }));

  // Build the rich session summary that includes conversation summary if available
  const richSessionSummary = conversationSummaryText
    ? `${conversationSummaryText}${session.summary ? `\n\nSession theme: ${session.summary}` : ''}`
    : session.summary || undefined;

  // Build prompt - use linked prompt if this session is connected to a partner session
  let prompt: string | PromptBlocks;

  if (linkedContext) {
    // Use the linked Inner Thoughts prompt with partner session context
    prompt = buildLinkedInnerThoughtsPrompt({
      userName,
      turnCount: totalTurnCount,
      emotionalIntensity: 5,
      sessionSummary: richSessionSummary,
      recentThemes: recentThemes.length > 0 ? recentThemes : undefined,
      linkedContext,
    });
  } else {
    // Not linked or context fetch failed - use regular Inner Thoughts prompt
    prompt = buildInnerWorkPrompt({
      userName,
      turnCount: totalTurnCount,
      emotionalIntensity: 5,
      sessionSummary: richSessionSummary,
      recentThemes: recentThemes.length > 0 ? recentThemes : undefined,
    });
  }

  // Build context prefix with prior takeaways and retrieved context
  let contextPrefix = '';

  // Inject prior takeaways (Phase 23 — CONTEXT-01)
  if (priorTakeaways.length > 0) {
    const takeawayLines = priorTakeaways
      .map(t => `- ${t.content.slice(0, 200)}${t.theme ? ` (${t.theme})` : ''}`)
      .join('\n');
    contextPrefix += `[YOUR PRIOR INSIGHTS:\n${takeawayLines}]\n\n`;
    logger.info(`[Inner Thoughts] Injecting ${priorTakeaways.length} prior takeaways into context`);
  }

  // Inject retrieved context into history if we have relevant results
  if (retrievedContext && retrievedContext.relevantFromOtherSessions.length > 0) {
    const formattedContext = formatRetrievedContext({
      ...retrievedContext,
      conversationHistory: [], // Don't duplicate - already in history
      preSessionMessages: [],
    });

    if (formattedContext.trim()) {
      contextPrefix += `[Retrieved context:\n${formattedContext}]\n\n`;
      logger.info(
        `[Inner Thoughts] Injecting ${retrievedContext.relevantFromOtherSessions.length} retrieved messages into context`,
      );
    }
  }

  const messagesForLLM = contextPrefix
    ? [...history, { role: 'user' as const, content: `${contextPrefix}${content}` }]
    : [...history, { role: 'user' as const, content }];
  // Update request context so all downstream code can access this turnId
  updateContext({ turnId, sessionId, userId: user.id });

  const fallbackResponse = "I'm here with you. Tell me more about what's on your mind.";
  const aiResponse = await getSonnetResponse({
    systemPrompt: prompt,
    messages: messagesForLLM,
    maxTokens: 1024,
    innerWorkSessionId: sessionId,
    turnId,
    operation: 'inner-work-response',
    callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
  });
  const parsed = extractJsonSafe<{
    response?: string;
    analysis?: string;
    suggestedActions?: Array<{
      type: string;
      label: string;
      personName?: string;
      context?: string;
    }>;
  }>(aiResponse || '', {
    response: fallbackResponse,
  });

  // Use parsed response, never raw JSON
  const aiContent = parsed.response || fallbackResponse;

  // Save AI message
  const aiMessage = await prisma.reflectionMessage.create({
    data: {
      reflectionId: sessionId,
      role: 'AI',
      content: aiContent,
    },
  });

  // Update session timestamp
  await prisma.reflection.update({
    where: { id: sessionId },
    data: { updatedAt: new Date() },
  });

  // Update session metadata with Haiku (non-blocking, runs on every message)
  updateSessionMetadata(sessionId, turnId).catch((err: unknown) =>
    logger.warn('[Inner Work] Failed to update metadata:', err),
  );

  // Update conversation summary and embed session content (non-blocking)
  // Per fact-ledger architecture, we embed at session level after summary updates
  updateInnerThoughtsSummary(sessionId, turnId)
    .then(() => embedInnerWorkSessionContent(sessionId, turnId))
    .catch((err: unknown) => logger.warn('[Inner Work] Failed to update summary/embedding:', err));

  // Run memory detection on user message
  // For Inner Thoughts, we allow detection from turn 2+ (more relaxed than partner sessions)
  let memorySuggestion: MemorySuggestion | null = null;
  if (totalTurnCount >= 2) {
    logger.info(`[Inner Thoughts] Running memory detection (turn ${totalTurnCount})`);
    try {
      // Include recent conversation history for context (last 5 messages to resolve pronouns/references)
      const recentMessagesForMemory = history.slice(-5);
      const memoryResult = await detectMemoryIntent(
        content,
        sessionId,
        turnId,
        'inner-thoughts',
        recentMessagesForMemory,
      );
      if (memoryResult.hasMemoryIntent && memoryResult.suggestions.length > 0) {
        memorySuggestion = memoryResult.suggestions[0];
        logger.info(`[Inner Thoughts] Memory suggestion detected:`, {
          category: memorySuggestion.category,
          content: memorySuggestion.suggestedContent,
          confidence: memorySuggestion.confidence,
        });
      } else {
        logger.info(`[Inner Thoughts] No memory intent detected`);
      }
    } catch (err) {
      logger.warn('[Inner Thoughts] Memory detection failed:', err);
    }
  } else {
    logger.info(`[Inner Thoughts] Skipping memory detection (turn ${totalTurnCount} < 2)`);
  }

  // Validate and map suggested actions from AI response
  const validActionTypes = ['start_partner_session', 'start_meditation', 'add_gratitude', 'check_need'] as const;
  const suggestedActions = (parsed.suggestedActions || [])
    .filter(
      (action): action is typeof action & { type: (typeof validActionTypes)[number] } =>
        validActionTypes.includes(action.type as (typeof validActionTypes)[number]) &&
        typeof action.label === 'string' &&
        action.label.length > 0,
    )
    .map(action => ({
      type: action.type as (typeof validActionTypes)[number],
      label: action.label,
      personName: action.personName,
      context: action.context || 'AI suggestion',
    }));

  const response: ApiResponse<SendInnerWorkMessageResponse> = {
    success: true,
    data: {
      userMessage: mapMessageToDTO(userMessage),
      aiMessage: mapMessageToDTO(aiMessage),
      memorySuggestion,
      suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
    },
  };

  res.json(response);
});

// ============================================================================
// PATCH /inner-work/:id - Update session (title, status)
// ============================================================================

export const updateInnerWorkSession = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const sessionId = req.params.id;

  // Validate request body
  const parseResult = updateInnerWorkSessionRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid update data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { title, status } = parseResult.data;

  // Verify session exists and belongs to user
  const existing = await prisma.reflection.findFirst({
    where: {
      id: sessionId,
      userId: user.id,
    },
  });

  if (!existing) {
    throw new ValidationError('Session not found');
  }

  // Update session
  const session = await prisma.reflection.update({
    where: { id: sessionId },
    data: {
      title: title !== undefined ? title : undefined,
      status: status !== undefined ? status : undefined,
    },
    include: {
      _count: { select: { messages: true } },
    },
  });

  // Fire-and-forget distillation on session close (DIST-01)
  // CRITICAL: Never await — must not slow down PATCH response
  if (status === 'COMPLETED') {
    const distillTurnId = crypto.randomUUID();
    distillSession({ sessionId, userId: user.id, turnId: distillTurnId }).catch((err: unknown) =>
      logger.warn('[InnerWork] Auto-distillation failed:', err),
    );
  }

  const response: ApiResponse<UpdateInnerWorkSessionResponse> = {
    success: true,
    data: {
      session: mapSessionToSummary(session),
    },
  };

  res.json(response);
});

// ============================================================================
// DELETE /inner-work/:id - Archive session
// ============================================================================

export const archiveInnerWorkSession = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const sessionId = req.params.id;

  // Verify session exists and belongs to user
  const existing = await prisma.reflection.findFirst({
    where: {
      id: sessionId,
      userId: user.id,
    },
  });

  if (!existing) {
    throw new ValidationError('Session not found');
  }

  // Archive (soft delete)
  const now = new Date();
  await prisma.reflection.update({
    where: { id: sessionId },
    data: { status: 'ARCHIVED' },
  });

  const response: ApiResponse<ArchiveInnerWorkSessionResponse> = {
    success: true,
    data: {
      archived: true,
      archivedAt: now.toISOString(),
    },
  };

  res.json(response);
});

// ============================================================================
// POST /inner-thoughts/:id/generate-context - Generate context for partner session (US-3)
// ============================================================================

export const generateContext = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const sessionId = req.params.id;

  // Fetch session with messages
  const session = await prisma.reflection.findFirst({
    where: {
      id: sessionId,
      userId: user.id,
    },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!session) {
    throw new ValidationError('Session not found');
  }

  // If session already has summary and theme, use those
  if (session.summary && session.theme) {
    const response: ApiResponse<GenerateContextResponse> = {
      success: true,
      data: {
        contextSummary: session.summary,
        themes: [session.theme],
        innerThoughtsSessionId: sessionId,
      },
    };
    res.json(response);
    return;
  }

  // Generate context summary from messages
  const userName = user.firstName || user.name || 'User';
  const messageHistory = session.messages.map(msg => ({
    role: msg.role === 'USER' ? 'user' : ('assistant' as const),
    content: msg.content,
  }));

  const turnId = `${sessionId}-generate-context`;

  const prompt = `You are analyzing an Inner Thoughts session to help prepare the user for a conversation with someone.

Analyze the conversation below and extract:
1. A brief contextual summary (2-3 sentences) that captures what ${userName} has been processing
2. The name of the person they want to talk with (if mentioned)
3. Key themes or emotions present

User's conversation:
${messageHistory.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n')}

Respond ONLY with JSON:
{
  "contextSummary": "A brief summary focused on what the user wants to discuss",
  "personName": "The person's name if mentioned, or null",
  "themes": ["theme1", "theme2"]
}`;

  const aiResponse = await getCompletion({
    systemPrompt: prompt,
    messages: [{ role: 'user', content: 'Generate the context summary.' }],
    maxTokens: 512,
    innerWorkSessionId: sessionId,
    turnId,
    operation: 'inner-work-context',
  });

  const parsed = extractJsonSafe<{
    contextSummary?: string;
    personName?: string | null;
    themes?: string[];
  }>(aiResponse || '', {
    contextSummary: session.summary || 'User has been reflecting on their thoughts.',
    themes: session.theme ? [session.theme] : [],
  });

  // Update session with generated summary if not already set
  if (!session.summary || !session.theme) {
    await prisma.reflection.update({
      where: { id: sessionId },
      data: {
        summary: parsed.contextSummary || session.summary,
        theme: parsed.themes && parsed.themes.length > 0 ? parsed.themes[0] : session.theme,
      },
    });
  }

  const response: ApiResponse<GenerateContextResponse> = {
    success: true,
    data: {
      contextSummary: parsed.contextSummary || 'User has been reflecting on their thoughts.',
      personName: parsed.personName || undefined,
      themes: parsed.themes || [],
      innerThoughtsSessionId: sessionId,
    },
  };

  res.json(response);
});

// ============================================================================
// GET /sessions/:id/inner-thoughts - Get linked Inner Thoughts session
// ============================================================================

export const getLinkedInnerThoughts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const partnerSessionId = req.params.id;

  // Verify user is a participant in the partner session
  const me = await resolveParticipant(partnerSessionId, user.id);
  if (!me) {
    throw new ValidationError('Partner session not found or you are not a participant');
  }

  // The caller's OWN reflection linked to this session (reflection.user_id = me, R1).
  const linkedSession = await prisma.reflection.findFirst({
    where: {
      userId: user.id,
      linkedSessionId: partnerSessionId,
      status: { not: 'ARCHIVED' },
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });

  const response: ApiResponse<{ innerThoughtsSessionId: string | null }> = {
    success: true,
    data: {
      innerThoughtsSessionId: linkedSession?.id || null,
    },
  };

  res.json(response);
});

// ============================================================================
// Insights: the `Insight` table is dropped on the target (spec §1.7
// feature_state Absorbs: "never populated"). The routes stay and answer as an
// account with no insights does.
// ============================================================================

const NO_INSIGHTS: InsightDTO[] = [];

// ============================================================================
// GET /inner-work/overview - Get Inner Work hub overview
// ============================================================================

export const getInnerWorkOverview = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  getUser(req);

  // For now, return stub data for other features since they're not yet fully implemented
  const response: ApiResponse<GetInnerWorkOverviewResponse> = {
    success: true,
    data: {
      overview: {
        needsAssessment: {
          baselineCompleted: false,
          overallScore: null,
          lowNeedsCount: 0,
          nextCheckInDue: null,
        },
        gratitude: {
          totalEntries: 0,
          streakDays: 0,
          lastEntryDate: null,
        },
        meditation: {
          totalSessions: 0,
          currentStreak: 0,
          totalMinutes: 0,
          lastSessionDate: null,
        },
        people: {
          totalTracked: 0,
          recentlyMentioned: [],
        },
        recentInsights: NO_INSIGHTS,
      },
    },
  };

  res.json(response);
});

// ============================================================================
// GET /inner-work/insights - Get user insights
// ============================================================================

export const getInsights = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  getUser(req);
  const type = req.query.type as InsightType | undefined;
  void type;

  const response: ApiResponse<GetInsightsResponse> = {
    success: true,
    data: {
      insights: NO_INSIGHTS,
      hasMore: false,
    },
  };

  res.json(response);
});

// ============================================================================
// POST /inner-work/insights/:id/dismiss - Dismiss an insight
// ============================================================================

export const dismissInsight = asyncHandler(async (req: Request, _res: Response): Promise<void> => {
  getUser(req);
  // No insight exists on the target, so none belongs to the caller.
  throw new ValidationError('Insight not found');
});
