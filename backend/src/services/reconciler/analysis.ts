/**
 * Reconciler Analysis Module
 *
 * Core AI gap analysis: analyzes the gap between what one person guessed
 * about the other's feelings vs what they actually expressed.
 *
 * Target shape (TS-10, spec §1.2): the analysis is computed here and persisted
 * by `persistAnalysis` through the JOB connection — `reconciler_result`
 * (subject-only, one current per attempt, `superseded_at` on re-analysis) and
 * `reconciler_guidance` (the abstract hints the author may see). Inputs are
 * read through the JOB connection too (Ruling R35, `reader()` below): the
 * AI's "reconciler reader" column grants in trailer T7 (TS-10 block) — the
 * parties' MAIN-conversation chat, the subject's NOTABLE_FACTS, the author's
 * attempt, the stored analysis — are all it may read. `runReconciler` returns
 * to its caller only what the caller may see: results where the caller is the
 * subject.
 */

import { getAiPrisma } from '../../lib/prisma';
import { encryptColumnValue } from '../../lib/prisma-encryption-middleware';
import { logger } from '../../lib/logger';
import { getSonnetResponse, getHaikuJson, BrainActivityCallType } from '../../lib/bedrock';
import { getCurrentUserId } from '../../lib/request-context';
import {
  buildReconcilerEvidencePacket,
  buildReconcilerPrompt,
  type ReconcilerContext,
  type PromptBlocks,
} from '../stage-prompts';
import { type CategorizedFact } from '../partner-session-classifier';
import { extractJsonFromResponse } from '../../utils/json-extractor';
import type { ReconcilerResult } from '@meet-without-fear/shared';
import { currentAttempt, sessionParties, type SessionParty } from '../empathy-store';
import { stageAt, type MilestoneReached } from '../stage-shim';
import type { Seat } from '../participant-resolver';
import {
  guidanceAreaOf,
  guidancePhrases,
  type AbstractGuidance,
  type GuidanceArea,
  type GuidanceType,
} from './guidance-phrases';

/**
 * Ruling R35: the reconciler runs as the JOB. Every read and write of the
 * analysis path goes through the AI connection, whose column grants (tables.sql,
 * [TS-10] / [TS-10 I4], "reconciler reader") are the whole of what it may see. The
 * request that triggered an analysis never reads the other participant's rows
 * on its own (app) connection; it gets back only its caller-visible projection
 * (`runReconciler` with `viewerUserId`). The context builder stays the one
 * cross-participant reader on the app connection.
 */
const reader = () => getAiPrisma();

/** A participant's milestones (key, reached_at) through the AI — the stage shim's input. */
async function milestonesOf(seat: Seat): Promise<MilestoneReached[]> {
  const rows = await reader().participantMilestone.findMany({
    where: { sessionId: seat.sessionId, userId: seat.userId },
    orderBy: [{ reachedAt: 'asc' }, { milestoneKey: 'asc' }],
    select: { milestoneKey: true, reachedAt: true },
  });
  return rows.map(r => ({ key: r.milestoneKey, reachedAt: r.reachedAt }));
}

// ============================================================================
// Types (shared across reconciler modules)
// ============================================================================

export interface UserInfo {
  /** The participant's user id — with the session, its participant key (work-k5fk.3). */
  id: string;
  name: string;
}

export interface SessionParticipants {
  userA: UserInfo;
  userB: UserInfo;
}

export interface WitnessingContent {
  /** Combined user messages from Stage 1 */
  userMessages: string;
  /** Key themes/feelings extracted */
  themes: string[];
}

export interface EmpathyData {
  /** The empathy statement they shared */
  statement: string;
  /** When it was shared */
  sharedAt: Date;
  /** The attempt (current round), its status and the status version an analysis starts from. */
  attemptId: string;
  statusVersion: number;
  status: string;
}

export interface ReconcilerAnalysisInput {
  sessionId: string;
  guesser: UserInfo;
  subject: UserInfo;
  empathyStatement: string;
  witnessingContent: WitnessingContent;
  /** The attempt the analysis is about; its current result is reused. */
  attemptId?: string;
}

export function toUserInfo(p: SessionParty, fallback: string): UserInfo {
  return { id: p.userId, name: p.name || fallback };
}

// ============================================================================
// Helper: Get Sonnet JSON response (shared across reconciler modules)
// ============================================================================

/**
 * Get a JSON response from Sonnet, parsing the result.
 */
export async function getSonnetJson<T>(options: {
  systemPrompt: string | PromptBlocks;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  sessionId?: string;
  operation?: string;
  turnId?: string;
}): Promise<T | null> {
  const effectiveSessionId = options.sessionId || 'reconciler';
  const effectiveTurnId =
    options.turnId || (options.sessionId ? `${options.sessionId}-${Date.now()}` : `reconciler-${Date.now()}`);
  const effectiveOperation = options.operation || 'reconciler';

  logger.debug('Starting AI request', { operation: effectiveOperation });

  const response = await getSonnetResponse({
    ...options,
    sessionId: effectiveSessionId,
    turnId: effectiveTurnId,
    operation: effectiveOperation,
    callType: BrainActivityCallType.RECONCILER_ANALYSIS,
  });

  if (!response) {
    logger.warn('No AI response received', { operation: effectiveOperation });
    return null;
  }

  try {
    const json = extractJsonFromResponse(response) as T;
    logger.debug('Parsed AI JSON response', { operation: effectiveOperation });
    return json;
  } catch (error) {
    logger.warn('Failed to parse AI JSON response', {
      operation: effectiveOperation,
      error: (error as Error).message,
      responseLength: response.length,
    });
    return null;
  }
}

function normalizeCategorizedFacts(rawFacts: unknown): CategorizedFact[] | undefined {
  if (!Array.isArray(rawFacts)) return undefined;
  const facts = rawFacts
    .filter((fact): fact is { category: string; fact: string } => {
      if (typeof fact !== 'object' || fact === null) return false;
      const candidate = fact as Record<string, unknown>;
      return typeof candidate.category === 'string' && typeof candidate.fact === 'string';
    })
    .map(fact => ({ category: fact.category.trim(), fact: fact.fact.trim() }))
    .filter(fact => fact.category.length > 0 && fact.fact.length > 0);
  return facts.length > 0 ? facts : undefined;
}

/** The subject's own NOTABLE_FACTS (ai_memory) — for the subject-side analysis only. */
async function loadSubjectFacts(subject: Seat): Promise<CategorizedFact[] | undefined> {
  // One per (session, user, kind): the sql_ partial unique index (no Prisma unique on ai_memory).
  const row = await reader().aiMemory.findFirst({
    where: { sessionId: subject.sessionId, userId: subject.userId, kind: 'NOTABLE_FACTS' },
    select: { doc: true },
  });
  return normalizeCategorizedFacts((row?.doc as { facts?: unknown } | null)?.facts);
}

/** A participant's MAIN-conversation chat rows, each with the stage it was written in (stage shim). */
async function stagedChat(
  seat: Seat,
): Promise<Array<{ role: 'USER' | 'AI'; content: string; stage: number; senderUserId: string | null }>> {
  const [rows, reached] = await Promise.all([
    reader().message.findMany({
      where: {
        conversation: { sessionId: seat.sessionId, userId: seat.userId, kind: 'MAIN' },
        kind: 'CHAT',
        role: { in: ['USER', 'AI'] },
      },
      orderBy: { seq: 'asc' },
      select: { role: true, content: true, createdAt: true, senderUserId: true },
    }),
    milestonesOf(seat),
  ]);
  return rows.map(r => ({
    role: r.role as 'USER' | 'AI',
    content: r.content,
    // Not pending, by construction: the reconciler runs for participants in stage 2+, and the shim holds
    // an inviter with an unsent invitation at stage 0; once invitation_sent exists the later-of rule needs
    // no option. (Reading it would need an AI grant on invitation this reader has no other use for.)
    stage: stageAt(reached, r.createdAt, { invitationPending: false }),
    senderUserId: r.senderUserId,
  }));
}

export async function loadRecentSubjectStage2Turns(
  subject: Seat,
  maxSubjectUserTurns = 5,
): Promise<Array<{ role: 'user' | 'assistant'; content: string; stage: number }>> {
  const messages = (await stagedChat(subject)).filter(m => m.stage === 2);

  const subjectUserIndexes = messages
    .map((message, index) => (message.role === 'USER' ? index : -1))
    .filter(index => index >= 0)
    .slice(-maxSubjectUserTurns);

  const selectedIndexes = new Set<number>();
  for (const userIndex of subjectUserIndexes) {
    if (messages[userIndex - 1]?.role === 'AI') selectedIndexes.add(userIndex - 1);
    selectedIndexes.add(userIndex);
  }

  return Array.from(selectedIndexes)
    .sort((a, b) => a - b)
    .map(index => {
      const message = messages[index];
      return {
        role: message.role === 'AI' ? ('assistant' as const) : ('user' as const),
        content: message.content,
        stage: message.stage,
      };
    });
}

// ============================================================================
// Helper: Get empathy data (shared across reconciler modules)
// ============================================================================

/**
 * The author's current round about the subject (the analysis input). Read by
 * the reconciler only; never returned to the subject.
 */
export async function getEmpathyData(
  sessionId: string,
  authorUserId: string,
  subjectUserId: string,
): Promise<EmpathyData | null> {
  const attempt = await currentAttempt(sessionId, authorUserId, subjectUserId, reader());
  if (!attempt) return null;
  return {
    statement: attempt.content,
    sharedAt: attempt.submittedAt,
    attemptId: attempt.id,
    statusVersion: attempt.statusVersion,
    status: attempt.status,
  };
}

// ============================================================================
// Helper: Get witnessing content (shared across reconciler modules)
// ============================================================================

/** The subject's Stage 1 turns: their own chat turns written while they were in stage 1. */
export async function getWitnessingContent(sessionId: string, subjectUserId: string): Promise<WitnessingContent> {
  const messages = (await stagedChat({ sessionId, userId: subjectUserId })).filter(
    m => m.stage === 1 && m.role === 'USER' && m.senderUserId === subjectUserId,
  );
  const userMessages = messages.map(m => m.content).join('\n\n');
  // The target has no per-message extracted emotions (review F4.2): themes come
  // from the quick AI pass.
  const themes = userMessages.length > 0 ? await extractThemes(userMessages, sessionId, subjectUserId) : [];
  return { userMessages, themes };
}

async function extractThemes(content: string, sessionId: string, userId?: string): Promise<string[]> {
  const effectiveUserId = userId || getCurrentUserId() || 'system';
  const turnId = `${sessionId}-${effectiveUserId}-extract-themes-${Date.now()}`;
  const result = await getHaikuJson<{ themes: string[] }>({
    systemPrompt: `Extract 3-5 key emotional themes or feelings from this witnessing content. Return as JSON: {"themes": ["theme1", "theme2", ...]}`,
    messages: [{ role: 'user', content }],
    maxTokens: 256,
    sessionId,
    turnId,
    operation: 'reconciler-extract-themes',
    callType: BrainActivityCallType.THEME_EXTRACTION,
  });
  return result?.themes || [];
}

// ============================================================================
// Abstract Guidance
// ============================================================================

export {
  GUIDANCE_AREA_PHRASES,
  guidanceAreaOf,
  guidancePhrases,
  type AbstractGuidance,
  type GuidanceArea,
  type GuidanceType,
} from './guidance-phrases';
/**
 * Generate abstract guidance for refinement conversation. General themes,
 * never the partner's specific content.
 */
export function generateAbstractGuidance(result: ReconcilerResult): AbstractGuidance {
  if (result.gaps.severity === 'none' || result.gaps.severity === 'minor') {
    return { areaHint: null, guidanceType: null, promptSeed: null };
  }

  let area: GuidanceArea | null = null;
  if (result.gaps.missedFeelings.length > 0) {
    const feelingText = result.gaps.missedFeelings.join(' ').toLowerCase();
    if (feelingText.includes('work') || feelingText.includes('effort') || feelingText.includes('appreciate')) {
      area = 'work_effort';
    } else if (feelingText.includes('connect') || feelingText.includes('close') || feelingText.includes('together')) {
      area = 'connection_closeness';
    } else if (feelingText.includes('safe') || feelingText.includes('secure') || feelingText.includes('trust')) {
      area = 'safety_security';
    } else if (feelingText.includes('hear') || feelingText.includes('listen') || feelingText.includes('understand')) {
      area = 'heard_understood';
    } else if (feelingText.includes('respect') || feelingText.includes('value')) {
      area = 'respect_value';
    } else {
      area = 'deeper_emotions';
    }
  }

  let guidanceType: GuidanceType;
  if (result.gaps.misattributions.length > 0) guidanceType = 'challenge_assumptions';
  else if (result.gaps.missedFeelings.length > 2) guidanceType = 'explore_breadth';
  else guidanceType = 'explore_deeper_feelings';

  return guidancePhrases({ areaHint: area, guidanceType });
}

// ============================================================================
// DB Result Conversion (shared across reconciler modules)
// ============================================================================

const SEVERITY_TO_DB = { none: 'NONE', minor: 'MINOR', moderate: 'MODERATE', significant: 'SIGNIFICANT' } as const;

/** The shape both the stored row and the DTO conversion read. */
export interface StoredReconcilerResult {
  id: string;
  attemptId: string;
  subjectUserId: string;
  iteration: number;
  alignmentScore: number;
  alignmentSummary: string;
  correctlyIdentified: string[];
  gapSeverity: string;
  gapSummary: string;
  missedFeelings: string[];
  misattributions: string[];
  mostImportantGap: string | null;
  recommendedAction: string;
  rationale: string;
  sharingWouldHelp: boolean;
  suggestedShareFocus: string | null;
  suggestedShareContent: string | null;
  suggestedShareReason: string | null;
  createdAt: Date;
}

export const RESULT_SELECT = {
  id: true,
  attemptId: true,
  subjectUserId: true,
  iteration: true,
  alignmentScore: true,
  alignmentSummary: true,
  correctlyIdentified: true,
  gapSeverity: true,
  gapSummary: true,
  missedFeelings: true,
  misattributions: true,
  mostImportantGap: true,
  recommendedAction: true,
  rationale: true,
  sharingWouldHelp: true,
  suggestedShareFocus: true,
  suggestedShareContent: true,
  suggestedShareReason: true,
  createdAt: true,
} as const;

/**
 * Convert a stored result (plus its guidance, when the caller may see it) to
 * the shared ReconcilerResult type.
 */
export function dbResultToReconcilerResult(
  db: Pick<
    StoredReconcilerResult,
    | 'alignmentScore'
    | 'alignmentSummary'
    | 'correctlyIdentified'
    | 'gapSeverity'
    | 'gapSummary'
    | 'missedFeelings'
    | 'misattributions'
    | 'mostImportantGap'
    | 'recommendedAction'
    | 'rationale'
    | 'sharingWouldHelp'
    | 'suggestedShareFocus'
  >,
  guidance?: AbstractGuidance | null,
): ReconcilerResult {
  return {
    alignment: { score: db.alignmentScore, summary: db.alignmentSummary, correctlyIdentified: db.correctlyIdentified },
    gaps: {
      severity: db.gapSeverity.toLowerCase() as 'none' | 'minor' | 'moderate' | 'significant',
      summary: db.gapSummary,
      missedFeelings: db.missedFeelings,
      misattributions: db.misattributions,
      mostImportantGap: db.mostImportantGap,
    },
    recommendation: {
      action: db.recommendedAction as 'PROCEED' | 'OFFER_OPTIONAL' | 'OFFER_SHARING',
      rationale: db.rationale,
      sharingWouldHelp: db.sharingWouldHelp,
      suggestedShareFocus: db.suggestedShareFocus,
    },
    abstractGuidance: guidance ?? { areaHint: null, guidanceType: null, promptSeed: null },
  };
}

/** The current result of an attempt (subject-side data: the AI, reconciler paths only — R35). */
export async function currentResultFor(attemptId: string): Promise<StoredReconcilerResult | null> {
  return reader().reconcilerResult.findFirst({
    where: { attemptId, supersededAt: null },
    select: RESULT_SELECT,
  }) as Promise<StoredReconcilerResult | null>;
}

/** The guidance of a result (author + subject may read it). */
export async function guidanceFor(resultId: string): Promise<AbstractGuidance | null> {
  const row = await reader().reconcilerGuidance.findUnique({
    where: { resultId },
    select: { areaHint: true, guidanceType: true },
  });
  return row ? guidancePhrases(row) : null;
}

/**
 * Get default reconciler result when AI fails.
 */
export function getDefaultReconcilerResult(): ReconcilerResult {
  return {
    alignment: {
      score: 70,
      summary: 'Unable to fully analyze the empathy exchange.',
      correctlyIdentified: [],
    },
    gaps: {
      severity: 'minor',
      summary: 'Analysis unavailable - defaulting to minor gaps.',
      missedFeelings: [],
      misattributions: [],
      mostImportantGap: null,
    },
    recommendation: {
      action: 'PROCEED',
      rationale: 'Defaulting to proceed due to analysis unavailability.',
      sharingWouldHelp: false,
      suggestedShareFocus: null,
    },
  };
}

// ============================================================================
// Persisting an analysis (AI connection)
// ============================================================================

/**
 * Write one analysis of an attempt: supersede the attempt's current result
 * (re-analysis), insert the new one with the next iteration, and its guidance
 * when there is any. JOB connection, one transaction, exactly the columns
 * tables.sql grants mwf_ai ([TS-10]). T-result-live-attempt refuses a result on
 * a SUPERSEDED round; that refusal is returned as null (a late result for a
 * retired round is dropped, spec §1.2).
 */
export async function persistAnalysis(opts: {
  attemptId: string;
  /** The attempt's session; author and subject are participants of it. */
  sessionId: string;
  authorUserId: string;
  subjectUserId: string;
  result: ReconcilerResult;
  guidance: AbstractGuidance;
  suggestion?: { content: string; reason: string } | null;
  circuitBreakerTripped?: boolean;
}): Promise<string | null> {
  const r = opts.result;
  try {
    return await getAiPrisma().$transaction(async tx => {
      await tx.$executeRaw`UPDATE reconciler_result SET superseded_at = now()
        WHERE attempt_id = ${opts.attemptId}::uuid AND superseded_at IS NULL`;
      const rows = await tx.$queryRaw<
        Array<{ id: string }>
      >`INSERT INTO reconciler_result (attempt_id, session_id, author_user_id, subject_user_id, iteration, alignment_score,
          alignment_summary, gap_summary, gap_severity, correctly_identified, missed_feelings, misattributions, most_important_gap,
          recommended_action, rationale, sharing_would_help, suggested_share_focus, suggested_share_content,
          suggested_share_reason, circuit_breaker_tripped)
        VALUES (${opts.attemptId}::uuid, ${opts.sessionId}::uuid, ${opts.authorUserId}::uuid, ${opts.subjectUserId}::uuid,
          coalesce((SELECT max(x.iteration) FROM reconciler_result x WHERE x.attempt_id = ${opts.attemptId}::uuid), 0) + 1,
          ${Math.max(0, Math.min(100, Math.round(r.alignment.score)))},
          ${encryptColumnValue('reconciler_result', 'alignment_summary', r.alignment.summary)},
          ${encryptColumnValue('reconciler_result', 'gap_summary', r.gaps.summary)},
          ${SEVERITY_TO_DB[r.gaps.severity] ?? 'MINOR'}::gap_severity,
          ${encryptColumnValue('reconciler_result', 'correctly_identified', r.alignment.correctlyIdentified)}::text[],
          ${encryptColumnValue('reconciler_result', 'missed_feelings', r.gaps.missedFeelings)}::text[],
          ${encryptColumnValue('reconciler_result', 'misattributions', r.gaps.misattributions)}::text[],
          ${encryptColumnValue('reconciler_result', 'most_important_gap', r.gaps.mostImportantGap)},
          ${r.recommendation.action}::recommender_action,
          ${encryptColumnValue('reconciler_result', 'rationale', r.recommendation.rationale)},
          ${r.recommendation.sharingWouldHelp},
          ${encryptColumnValue('reconciler_result', 'suggested_share_focus', r.recommendation.suggestedShareFocus)},
          ${encryptColumnValue('reconciler_result', 'suggested_share_content', opts.suggestion?.content ?? null)},
          ${encryptColumnValue('reconciler_result', 'suggested_share_reason', opts.suggestion?.reason ?? null)},
          ${opts.circuitBreakerTripped ?? false})
        RETURNING id`;
      const resultId = rows[0].id;
      // Q4 (work-k5fk.9): the area is stored as its guidance_area label; the prompt seed is derived from the type.
      const g = opts.guidance;
      const area = guidanceAreaOf(g.areaHint);
      if (g.areaHint && !area) logger.warn('Dropped a guidance area outside guidance_area', { attemptId: opts.attemptId });
      if (area || g.guidanceType) {
        await tx.$executeRaw`INSERT INTO reconciler_guidance (result_id, session_id, author_user_id, subject_user_id,
                                                         area_hint, guidance_type)
          VALUES (${resultId}::uuid, ${opts.sessionId}::uuid, ${opts.authorUserId}::uuid, ${opts.subjectUserId}::uuid,
                  ${area}::guidance_area, ${g.guidanceType}::guidance_type)`;
      }
      return resultId;
    });
  } catch (err) {
    if (String((err as Error)?.message ?? '').includes('needs a live attempt')) {
      logger.info('Dropped a late reconciler result for a retired round', { attemptId: opts.attemptId });
      return null;
    }
    throw err;
  }
}

/**
 * Retire an attempt's current result (AI): a resubmitted round's analysis is
 * no longer current — the new round gets its own. `superseded_at` is the one
 * column a result ever changes (spec §1.2).
 */
export async function supersedeCurrentResult(attemptId: string): Promise<void> {
  await getAiPrisma().$executeRaw`UPDATE reconciler_result SET superseded_at = now()
    WHERE attempt_id = ${attemptId}::uuid AND superseded_at IS NULL`;
}

// ============================================================================
// Core Analysis Function
// ============================================================================

/**
 * Analyze the empathy gap for one direction (guesser -> subject). Returns the
 * analysis and whether it is a fresh one that still has to be persisted
 * (`persistAnalysis`); a current stored result is reused as is.
 */
export async function analyzeEmpathyGap(
  input: ReconcilerAnalysisInput,
): Promise<ReconcilerResult & { storedResultId?: string; fresh?: boolean }> {
  logger.info('Analyzing empathy gap', {
    guesserId: input.guesser.id,
    subjectId: input.subject.id,
    themes: input.witnessingContent.themes,
  });

  if (input.attemptId) {
    const existing = await currentResultFor(input.attemptId);
    if (existing) {
      logger.info('Using cached reconciler result', { guesserId: input.guesser.id, subjectId: input.subject.id });
      return { ...dbResultToReconcilerResult(existing, await guidanceFor(existing.id)), storedResultId: existing.id };
    }
  }

  const turnId = `${input.sessionId}-${Date.now()}`;
  const [subjectFacts, recentSubjectTurns] = await Promise.all([
    loadSubjectFacts({ sessionId: input.sessionId, userId: input.subject.id }),
    loadRecentSubjectStage2Turns({ sessionId: input.sessionId, userId: input.subject.id }),
  ]);

  const context: ReconcilerContext = {
    guesserName: input.guesser.name,
    subjectName: input.subject.name,
    empathyStatement: input.empathyStatement,
    witnessingContent: input.witnessingContent.userMessages,
    extractedThemes: input.witnessingContent.themes,
    subjectFacts,
    recentSubjectTurns,
  };

  const prompt = buildReconcilerPrompt(context);
  const evidencePacket = buildReconcilerEvidencePacket(context);

  const result = await getSonnetJson<ReconcilerResult>({
    systemPrompt: prompt,
    messages: [{ role: 'user', content: evidencePacket }],
    maxTokens: 2048,
    sessionId: input.sessionId,
    turnId,
    operation: 'reconciler-analysis',
  });

  if (!result) {
    // Fallback result if AI fails (not persisted, as before).
    logger.warn('AI analysis failed, using fallback result');
    return getDefaultReconcilerResult();
  }

  result.abstractGuidance = generateAbstractGuidance(result);
  logger.info('AI analysis complete', {
    alignmentScore: result.alignment.score,
    gapSeverity: result.gaps.severity,
    action: result.recommendation.action,
  });
  return { ...result, fresh: true };
}

// ============================================================================
// Main Function: runReconciler
// ============================================================================

/**
 * Run the reconciler for both directions of a two-party session.
 *
 * With `viewerUserId`, the returned analyses are filtered to what that
 * participant may read (spec §1.2: `reconciler_result` is subject-only): a
 * direction's analysis is returned only where the caller is its SUBJECT. The
 * readiness verdict over a hidden direction is computed from its status
 * (`v_empathy_direction_status`'s content-free projection), never from its
 * analysis.
 */
export async function runReconciler(
  sessionId: string,
  forUserId?: string,
  opts: {
    /** The participant (of `sessionId`) the result is filtered for — what they may read. */
    viewerUserId?: string;
    /**
     * Store fresh analyses here (m6: `POST /reconciler/run` paid for an LLM
     * analysis and threw it away). The Stage 2 trigger leaves it off: it
     * persists each direction itself, with that direction's suggestion.
     */
    persist?: boolean;
  } = {},
): Promise<{
  aUnderstandingB: ReconcilerResult | null;
  bUnderstandingA: ReconcilerResult | null;
  bothCompleted: boolean;
  readyToProceed: boolean;
  blockingReason: string | null;
  /** Per direction (A→B, B→A): the attempt analysed and whether its analysis is new (to persist). */
  directions: Array<{
    guesser: UserInfo;
    subject: UserInfo;
    data: EmpathyData;
    result: ReconcilerResult & { fresh?: boolean; storedResultId?: string };
  } | null>;
}> {
  logger.info('Starting reconciliation', { sessionId });

  const parties = await sessionParties(sessionId, reader());
  if (parties.length !== 2) {
    throw new Error(`Session ${sessionId} does not have exactly 2 participants`);
  }
  const userA = toUserInfo(parties[0], 'User A');
  const userB = toUserInfo(parties[1], 'User B');

  const [aEmpathy, bEmpathy] = await Promise.all([
    getEmpathyData(sessionId, userA.id, userB.id),
    getEmpathyData(sessionId, userB.id, userA.id),
  ]);

  if (!aEmpathy || !bEmpathy) {
    return {
      aUnderstandingB: null,
      bUnderstandingA: null,
      bothCompleted: false,
      readyToProceed: false,
      blockingReason: !aEmpathy
        ? `${userA.name} has not shared their empathy statement yet`
        : `${userB.name} has not shared their empathy statement yet`,
      directions: [null, null],
    };
  }

  const [aWitnessing, bWitnessing] = await Promise.all([
    getWitnessingContent(sessionId, userA.id),
    getWitnessingContent(sessionId, userB.id),
  ]);

  let aUnderstandingB: (ReconcilerResult & { fresh?: boolean; storedResultId?: string }) | null = null;
  let bUnderstandingA: (ReconcilerResult & { fresh?: boolean; storedResultId?: string }) | null = null;

  if (!forUserId || forUserId === userA.id) {
    aUnderstandingB = await analyzeEmpathyGap({
      sessionId,
      guesser: userA,
      subject: userB,
      empathyStatement: aEmpathy.statement,
      witnessingContent: bWitnessing,
      attemptId: aEmpathy.attemptId,
    });
  }
  if (!forUserId || forUserId === userB.id) {
    bUnderstandingA = await analyzeEmpathyGap({
      sessionId,
      guesser: userB,
      subject: userA,
      empathyStatement: bEmpathy.statement,
      witnessingContent: aWitnessing,
      attemptId: bEmpathy.attemptId,
    });
  }

  if (opts.persist) {
    const store = async (
      r: (ReconcilerResult & { fresh?: boolean; storedResultId?: string }) | null,
      author: UserInfo,
      subject: UserInfo,
      attemptId: string,
    ) => {
      if (!r?.fresh) return;
      const id = await persistAnalysis({
        attemptId,
        sessionId,
        authorUserId: author.id,
        subjectUserId: subject.id,
        result: r,
        guidance: r.abstractGuidance ?? generateAbstractGuidance(r),
      });
      if (id) {
        r.storedResultId = id;
        r.fresh = false;
      }
    };
    await store(aUnderstandingB, userA, userB, aEmpathy.attemptId);
    await store(bUnderstandingA, userB, userA, bEmpathy.attemptId);
  }

  const isDirectionReady = (result: ReconcilerResult | null): boolean => {
    if (!result) return true;
    const { action, suggestedShareFocus } = result.recommendation;
    if (action === 'PROCEED') return true;
    if (action === 'OFFER_OPTIONAL' && !suggestedShareFocus) return true;
    return false;
  };
  const statusReady = (status: string): boolean => status !== 'AWAITING_SHARING' && status !== 'REFINING';

  const caller = opts.viewerUserId;
  // What the caller may see: a direction's analysis only as its subject.
  const visibleA = !caller || caller === userB.id ? aUnderstandingB : null;
  const visibleB = !caller || caller === userA.id ? bUnderstandingA : null;
  // Readiness: from the analysis where the caller may see it, else from the
  // direction's status alone.
  const aReady = !caller || visibleA ? isDirectionReady(aUnderstandingB) : statusReady(aEmpathy.status);
  const bReady = !caller || visibleB ? isDirectionReady(bUnderstandingA) : statusReady(bEmpathy.status);
  const readyToProceed = aReady && bReady;

  const strip = (
    r: (ReconcilerResult & { fresh?: boolean; storedResultId?: string }) | null,
  ): ReconcilerResult | null => {
    if (!r) return null;
    const { fresh: _f, storedResultId: _s, ...rest } = r;
    void _f;
    void _s;
    return rest;
  };

  return {
    aUnderstandingB: strip(visibleA),
    bUnderstandingA: strip(visibleB),
    bothCompleted: true,
    readyToProceed,
    blockingReason: readyToProceed ? null : 'There are empathy gaps that could benefit from additional sharing',
    directions: [
      aUnderstandingB ? { guesser: userA, subject: userB, data: aEmpathy, result: aUnderstandingB } : null,
      bUnderstandingA ? { guesser: userB, subject: userA, data: bEmpathy, result: bUnderstandingA } : null,
    ],
  };
}
