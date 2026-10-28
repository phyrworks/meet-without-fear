import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getOpsPrisma } from '../lib/prisma';
import type { BrainActivity, Prisma, ReflectionStatus, SessionStatus } from '../generated/prisma/client';
import { errorResponse, successResponse } from '../utils/response';
import { assembleContextBundle, type ContextBundle } from '../services/context-assembler';
import { determineMemoryIntent } from '../services/memory-intent';
import { resolveStageIntervalsForSessions, resolveStageForTimestamp } from '../utils/stage-resolver';
import { loadStageStates } from '../services/stage-shim';
import { verifyToken } from '@clerk/express';
import { logger } from '../lib/logger';
import { fieldEncryptionEnabled } from '../utils/field-encryption';

/**
 * A brain_activity jsonb column (input / output / metadata) as the dashboard reads it: arbitrary
 * JSON written by every LLM call site, read field by field with optional chaining.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary jsonb, read defensively
type ActivityBlob = any;

/*
 * Neural Monitor dashboard (TS-12, spec §6 "Brain dashboard"). Read-only,
 * through the `mwf_ops` role (OPS_DATABASE_URL; trailer T7 grants it SELECT on
 * exactly the tables read here). `brain_activity` rows are attributed at
 * capture by the job (`participant_id`, `reflection_id`); a reflection's
 * telemetry carries `reflection_id`, not `session_id`, so the dashboard keys an
 * activity by its session, else its reflection.
 */
const db = () => getOpsPrisma();

const router = Router();

// ============================================================================
// Dashboard Auth Middleware
// ============================================================================

/**
 * Authentication middleware for the Neural Monitor dashboard.
 * Accepts either:
 *   - X-Dashboard-Secret header matching DASHBOARD_API_SECRET env var
 *   - Clerk JWT Bearer token (verified via @clerk/express) with an allowed
 *     email or Clerk user id when allowlists are configured
 * If neither DASHBOARD_API_SECRET nor CLERK_SECRET_KEY is configured, allows
 * local development and rejects production requests.
 */
async function requireDashboardAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const dashboardSecret = process.env.DASHBOARD_API_SECRET;
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;

  // If no auth configured: allow in development, reject in production
  if (!dashboardSecret && !clerkSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      errorResponse(res, 'FORBIDDEN', 'Dashboard auth not configured', 403);
      return;
    }
    next();
    return;
  }

  // Check X-Dashboard-Secret header (timing-safe comparison)
  if (dashboardSecret) {
    const headerSecret = req.headers['x-dashboard-secret'] as string | undefined;
    if (headerSecret && headerSecret.length === dashboardSecret.length) {
      const a = Buffer.from(headerSecret);
      const b = Buffer.from(dashboardSecret);
      if (timingSafeEqual(a, b)) {
        next();
        return;
      }
    }
  }

  // Check Clerk JWT Bearer token
  if (clerkSecretKey) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const payload = await verifyToken(token, { secretKey: clerkSecretKey });

        const allowedUserIds = process.env.DASHBOARD_ALLOWED_USER_IDS;
        const allowedEmails = process.env.DASHBOARD_ALLOWED_EMAILS;

        if (allowedUserIds || allowedEmails) {
          const userIdAllowList =
            allowedUserIds
              ?.split(',')
              .map(id => id.trim())
              .filter(Boolean) ?? [];
          const emailAllowList =
            allowedEmails
              ?.split(',')
              .map(e => e.trim().toLowerCase())
              .filter(Boolean) ?? [];
          const userId = payload.sub;
          const claims = payload as { email?: string; sub_email?: string };
          const email = claims?.email || claims?.sub_email;

          const userIdAllowed = Boolean(userId && userIdAllowList.includes(userId));
          const emailAllowed = Boolean(email && emailAllowList.includes(email.toLowerCase()));

          if (!userIdAllowed && !emailAllowed) {
            errorResponse(res, 'FORBIDDEN', 'Not authorized for dashboard access', 403);
            return;
          }
        }

        next();
        return;
      } catch {
        // Token invalid, fall through to 401
      }
    }
  }

  errorResponse(res, 'UNAUTHORIZED', 'Dashboard authentication required', 401);
}

// Apply dashboard auth to all brain routes
router.use(requireDashboardAuth);

// ============================================================================
// Helpers
// ============================================================================

function getPeriodStartDate(period: string): Date {
  const now = new Date();
  switch (period) {
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
}

function normalizeModel(model: string): string {
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('titan')) return 'titan';
  return 'other';
}

const TOKEN_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  sonnet: { input: 0.003 / 1000, output: 0.015 / 1000, cacheRead: 0.0003 / 1000, cacheWrite: 0.00375 / 1000 },
  haiku: { input: 0.001 / 1000, output: 0.005 / 1000, cacheRead: 0.0001 / 1000, cacheWrite: 0.00125 / 1000 },
  titan: { input: 0.00002 / 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function getModelPrices(model: string) {
  return TOKEN_PRICES[normalizeModel(model)] || TOKEN_PRICES.sonnet;
}

const VALID_PERIODS = new Set(['24h', '7d', '30d']);

const TOKEN_BUDGET_LIMIT = 150_000;

function extractCacheTokens(metadata: unknown): { cacheRead: number; cacheWrite: number } {
  if (!metadata || typeof metadata !== 'object') return { cacheRead: 0, cacheWrite: 0 };
  const m = metadata as Record<string, unknown>;
  return {
    cacheRead: (m.cacheReadInputTokens as number) ?? 0,
    cacheWrite: (m.cacheWriteInputTokens as number) ?? 0,
  };
}

function formatDateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** `cost` is numeric(10,6) on the target (a Prisma Decimal): the dashboard works in numbers. */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** The key an activity is grouped under: its session, else its reflection (inner work). */
const activityKey = (a: { sessionId: string | null; reflectionId?: string | null }): string | null =>
  a.sessionId ?? a.reflectionId ?? null;

/** An activity as the dashboard reads it (cost as a number). */
function activityDTO(a: BrainActivity) {
  return { ...a, cost: num(a.cost) };
}

/** "A & B" per session from its participants' display names (falling back to the user's name). */
async function participantLabels(sessionIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  const rows = await db().participant.findMany({
    where: { sessionId: { in: sessionIds } },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: { sessionId: true, displayName: true, user: { select: { name: true, deletedAt: true } } },
  });
  const names = new Map<string, string[]>();
  for (const r of rows) {
    const name = r.displayName || (r.user?.deletedAt ? 'Former participant' : r.user?.name) || 'Unknown';
    names.set(r.sessionId, [...(names.get(r.sessionId) ?? []), name]);
  }
  for (const id of sessionIds) out.set(id, (names.get(id) ?? []).join(' & ') || 'No Participants');
  return out;
}

/** User chat turns per session: USER/CHAT messages each participant sent in their own MAIN conversation. */
async function userTurnCounts(sessionIds: string[]): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db().$queryRaw<Array<{ session_id: string; n: number }>>`SELECT p.session_id, count(*)::int AS n
    FROM message m
    JOIN conversation c ON c.id = m.conversation_id AND c.kind = 'MAIN'
    JOIN participant p ON p.id = c.participant_id
    WHERE p.session_id = ANY(${sessionIds}::uuid[]) AND m.role = 'USER' AND m.kind = 'CHAT' AND m.sender_participant_id = p.id
    GROUP BY p.session_id`;
  return new Map(rows.map(r => [r.session_id, Number(r.n)]));
}

/** USER turns per reflection. */
async function reflectionTurnCounts(reflectionIds: string[]): Promise<Map<string, number>> {
  if (reflectionIds.length === 0) return new Map();
  const rows = await db().reflectionMessage.groupBy({
    by: ['reflectionId'],
    where: { reflectionId: { in: reflectionIds }, role: 'USER' },
    _count: { id: true },
  });
  return new Map(rows.map(r => [r.reflectionId, r._count.id]));
}

/** The furthest stage any participant of each session is in (v_current_stage; was max StageProgress.stage). */
async function maxStages(sessionIds: string[]): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db().$queryRaw<
    Array<{ session_id: string; stage: number }>
  >`SELECT session_id, max(least(active_stage, 4))::int AS stage
    FROM v_current_stage WHERE session_id = ANY(${sessionIds}::uuid[]) GROUP BY session_id`;
  return new Map(rows.map(r => [r.session_id, Number(r.stage)]));
}

/** Cost / token / count totals of each key's activities (by session id, or by reflection id). */
async function activityStats(
  ids: string[],
  by: 'sessionId' | 'reflectionId',
): Promise<Map<string, { cost: number; tokens: number; count: number }>> {
  if (ids.length === 0) return new Map();
  const where = by === 'sessionId' ? { sessionId: { in: ids } } : { reflectionId: { in: ids } };
  const rows = await db().brainActivity.groupBy({
    by: [by],
    where,
    _sum: { cost: true, tokenCountInput: true, tokenCountOutput: true },
    _count: { id: true },
  });
  return new Map(
    rows.map(r => [
      String((r as Record<string, unknown>)[by]),
      {
        cost: num(r._sum.cost),
        tokens: (r._sum.tokenCountInput ?? 0) + (r._sum.tokenCountOutput ?? 0),
        count: r._count.id,
      },
    ]),
  );
}

// ============================================================================
// Response Types
// ============================================================================

interface ContextUserData {
  userId: string;
  userName: string;
  context: ContextBundle;
}

interface ContextResponse {
  sessionId: string;
  sessionType: 'partner' | 'inner_thoughts';
  assembledAt: string;
  users: ContextUserData[];
}

// ============================================================================
// Dashboard aggregate metrics
// ============================================================================
router.get('/dashboard', async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    const periodStart = getPeriodStartDate(period);

    // 1. Active sessions count (live partner sessions; the target's WAITING is ACTIVE)
    const activeSessions = await db().session.count({
      where: { status: 'ACTIVE' },
    });

    // 2. Fetch all activities in period for aggregation
    const activities = await db().brainActivity.findMany({
      where: { createdAt: { gte: periodStart } },
      select: {
        cost: true,
        tokenCountInput: true,
        tokenCountOutput: true,
        durationMs: true,
        model: true,
        metadata: true,
        createdAt: true,
        sessionId: true,
      },
    });

    // 3. Compute aggregate metrics
    let periodCost = 0;
    let totalDurationMs = 0;
    let totalCacheRead = 0;
    let totalInput = 0;

    // Cost trend by date
    const costByDate = new Map<string, { cost: number; cacheRead: number; cacheWrite: number; uncached: number }>();
    // Model distribution
    const modelMap = new Map<string, { count: number; cost: number }>();

    for (const a of activities) {
      const cost = num(a.cost);
      periodCost += cost;
      totalDurationMs += a.durationMs;
      totalInput += a.tokenCountInput;

      const { cacheRead, cacheWrite } = extractCacheTokens(a.metadata);
      totalCacheRead += cacheRead;

      // Cost trend
      const dateKey = formatDateKey(a.createdAt);
      const dayEntry = costByDate.get(dateKey) || { cost: 0, cacheRead: 0, cacheWrite: 0, uncached: 0 };
      dayEntry.cost += cost;
      dayEntry.cacheRead += cacheRead;
      dayEntry.cacheWrite += cacheWrite;
      dayEntry.uncached += Math.max(0, a.tokenCountInput - cacheRead - cacheWrite);
      costByDate.set(dateKey, dayEntry);

      // Model distribution
      const modelNorm = normalizeModel(a.model);
      const modelEntry = modelMap.get(modelNorm) || { count: 0, cost: 0 };
      modelEntry.count += 1;
      modelEntry.cost += cost;
      modelMap.set(modelNorm, modelEntry);
    }

    const cacheHitRate = totalInput > 0 ? (totalCacheRead / totalInput) * 100 : 0;
    const avgResponseMs = activities.length > 0 ? totalDurationMs / activities.length : 0;

    const costTrend = Array.from(costByDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({ date, ...data }));

    const modelDistribution = Array.from(modelMap.entries()).map(([model, data]) => ({ model, ...data }));

    // 4. Recent sessions (last 10 by updatedAt)
    const recentPartnerSessions = await db().session.findMany({
      take: 10,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, status: true, createdAt: true },
    });

    // Get cost stats, turn counts, names and stages for recent sessions
    const recentSessionIds = recentPartnerSessions.map(s => s.id);
    const [recentStats, recentTurnCounts, labels, stages] = await Promise.all([
      activityStats(recentSessionIds, 'sessionId'),
      userTurnCounts(recentSessionIds),
      participantLabels(recentSessionIds),
      maxStages(recentSessionIds),
    ]);

    const recentSessions = recentPartnerSessions.map(session => ({
      id: session.id,
      participants: labels.get(session.id) ?? 'No Participants',
      status: session.status,
      stage: stages.get(session.id) ?? 0,
      turns: recentTurnCounts.get(session.id) ?? 0,
      cost: recentStats.get(session.id)?.cost ?? 0,
      age: session.createdAt.toISOString(),
    }));

    return successResponse(res, {
      activeSessions,
      periodCost,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      avgResponseMs: Math.round(avgResponseMs),
      costTrend,
      modelDistribution,
      recentSessions,
    });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch dashboard:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch dashboard metrics', 500);
  }
});

// ============================================================================
// Cost analytics
// ============================================================================
router.get('/costs', async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    const periodStart = getPeriodStartDate(period);
    const from = req.query.from ? new Date(req.query.from as string) : periodStart;
    const to = req.query.to ? new Date(req.query.to as string) : new Date();

    // Calculate previous period for comparison
    const periodDurationMs = to.getTime() - from.getTime();
    const previousPeriodStart = new Date(from.getTime() - periodDurationMs);
    const previousPeriodEnd = from;

    // Fetch current period activities
    const activities = (
      await db().brainActivity.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: {
          cost: true,
          tokenCountInput: true,
          tokenCountOutput: true,
          durationMs: true,
          model: true,
          metadata: true,
          createdAt: true,
          sessionId: true,
          reflectionId: true,
          callType: true,
        },
      })
    ).map(a => ({ ...a, cost: num(a.cost), sessionId: activityKey(a) }));

    // Fetch previous period total for comparison
    const prevAggregate = await db().brainActivity.aggregate({
      where: { createdAt: { gte: previousPeriodStart, lt: previousPeriodEnd } },
      _sum: { cost: true },
    });

    const periodTotal = activities.reduce((sum, a) => sum + a.cost, 0);
    const previousPeriodTotal = num(prevAggregate._sum.cost);
    const changePercent =
      previousPeriodTotal > 0 ? ((periodTotal - previousPeriodTotal) / previousPeriodTotal) * 100 : 0;

    // Unique sessions for per-session average
    const uniqueSessions = new Set(activities.map(a => a.sessionId));
    const perSessionAvg = uniqueSessions.size > 0 ? periodTotal / uniqueSessions.size : 0;

    // Cost timeline by date, split by model
    const timelineMap = new Map<string, { sonnetCost: number; haikuCost: number; titanCost: number; total: number }>();
    // Model breakdown
    const modelBreakdownMap = new Map<
      string,
      { count: number; cost: number; inputTokens: number; outputTokens: number }
    >();
    // Call type breakdown
    const callTypeMap = new Map<string, { count: number; cost: number; totalDuration: number }>();
    // Cache metrics
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalUncached = 0;

    // Session costs
    const sessionCostMap = new Map<
      string,
      { sonnetCost: number; haikuCost: number; titanCost: number; totalCost: number; activityCount: number }
    >();

    for (const a of activities) {
      const modelNorm = normalizeModel(a.model);
      const { cacheRead, cacheWrite } = extractCacheTokens(a.metadata);
      const uncached = Math.max(0, a.tokenCountInput - cacheRead - cacheWrite);

      totalCacheRead += cacheRead;
      totalCacheWrite += cacheWrite;
      totalUncached += uncached;

      // Timeline
      const dateKey = formatDateKey(a.createdAt);
      const dayEntry = timelineMap.get(dateKey) || { sonnetCost: 0, haikuCost: 0, titanCost: 0, total: 0 };
      if (modelNorm === 'sonnet') dayEntry.sonnetCost += a.cost;
      else if (modelNorm === 'haiku') dayEntry.haikuCost += a.cost;
      else if (modelNorm === 'titan') dayEntry.titanCost += a.cost;
      dayEntry.total += a.cost;
      timelineMap.set(dateKey, dayEntry);

      // Model breakdown
      const modelEntry = modelBreakdownMap.get(modelNorm) || { count: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
      modelEntry.count += 1;
      modelEntry.cost += a.cost;
      modelEntry.inputTokens += a.tokenCountInput;
      modelEntry.outputTokens += a.tokenCountOutput;
      modelBreakdownMap.set(modelNorm, modelEntry);

      // Call type breakdown
      const ct = a.callType || 'UNKNOWN';
      const ctEntry = callTypeMap.get(ct) || { count: 0, cost: 0, totalDuration: 0 };
      ctEntry.count += 1;
      ctEntry.cost += a.cost;
      ctEntry.totalDuration += a.durationMs;
      callTypeMap.set(ct, ctEntry);

      // Session costs — group by sessionId, treating null/empty as 'unattributed'
      const sessKey = a.sessionId || 'unattributed';
      const sessEntry = sessionCostMap.get(sessKey) || {
        sonnetCost: 0,
        haikuCost: 0,
        titanCost: 0,
        totalCost: 0,
        activityCount: 0,
      };
      if (modelNorm === 'sonnet') sessEntry.sonnetCost += a.cost;
      else if (modelNorm === 'haiku') sessEntry.haikuCost += a.cost;
      else if (modelNorm === 'titan') sessEntry.titanCost += a.cost;
      sessEntry.totalCost += a.cost;
      sessEntry.activityCount += 1;
      sessionCostMap.set(sessKey, sessEntry);
    }

    // Estimate cache savings (what it would have cost without caching)
    // Use sonnet prices as default for estimation
    const prices = TOKEN_PRICES.sonnet;
    const cacheSavings = totalCacheRead * (prices.input - prices.cacheRead);

    const costTimeline = Array.from(timelineMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({ date, ...data }));

    const modelBreakdown = Array.from(modelBreakdownMap.entries()).map(([model, data]) => ({
      model,
      ...data,
      percentage: periodTotal > 0 ? Math.round((data.cost / periodTotal) * 10000) / 100 : 0,
    }));

    const callTypeBreakdown = Array.from(callTypeMap.entries()).map(([callType, data]) => ({
      callType,
      count: data.count,
      cost: data.cost,
      percentage: periodTotal > 0 ? Math.round((data.cost / periodTotal) * 10000) / 100 : 0,
      avgDuration: data.count > 0 ? Math.round(data.totalDuration / data.count) : 0,
    }));

    const totalInputTokens = totalCacheRead + totalCacheWrite + totalUncached;
    const cacheMetrics = {
      hitRate: totalInputTokens > 0 ? Math.round((totalCacheRead / totalInputTokens) * 10000) / 100 : 0,
      readTokens: totalCacheRead,
      writeTokens: totalCacheWrite,
      uncachedTokens: totalUncached,
      estimatedSavings: Math.round(cacheSavings * 1000000) / 1000000,
    };

    // Participant names and user turn counts: partner sessions first, the rest as reflections
    const sessionIds = Array.from(sessionCostMap.keys()).filter(id => id !== 'unattributed');
    const sessionParticipants = new Map<string, string>();
    const sessionTurnCounts = new Map<string, number>();
    if (sessionIds.length > 0) {
      const sessions = await db().session.findMany({ where: { id: { in: sessionIds } }, select: { id: true } });
      const partnerIds = sessions.map(s => s.id);
      const [labels, turns] = await Promise.all([participantLabels(partnerIds), userTurnCounts(partnerIds)]);
      for (const [id, label] of labels) sessionParticipants.set(id, label);
      for (const [id, n] of turns) sessionTurnCounts.set(id, n);

      const foundPartnerIds = new Set(partnerIds);
      const missingIds = sessionIds.filter(id => !foundPartnerIds.has(id));
      if (missingIds.length > 0) {
        const reflections = await db().reflection.findMany({
          where: { id: { in: missingIds } },
          select: { id: true, user: { select: { name: true } } },
        });
        for (const r of reflections) sessionParticipants.set(r.id, r.user?.name || 'Unknown');
        for (const [id, n] of await reflectionTurnCounts(reflections.map(r => r.id))) sessionTurnCounts.set(id, n);
      }
    }

    const sessionCosts = Array.from(sessionCostMap.entries())
      .sort(([, a], [, b]) => b.totalCost - a.totalCost)
      .slice(0, 20)
      .map(([sessionId, data]) => ({
        sessionId,
        participants: sessionId === 'unattributed' ? 'Unattributed' : sessionParticipants.get(sessionId) || sessionId,
        ...data,
        turnCount: sessionTurnCounts.get(sessionId) ?? 0,
      }));

    return successResponse(res, {
      summary: {
        periodTotal: Math.round(periodTotal * 1000000) / 1000000,
        previousPeriodTotal: Math.round(previousPeriodTotal * 1000000) / 1000000,
        changePercent: Math.round(changePercent * 100) / 100,
        perSessionAvg: Math.round(perSessionAvg * 1000000) / 1000000,
        cacheSavings: Math.round(cacheSavings * 1000000) / 1000000,
      },
      costTimeline,
      modelBreakdown,
      callTypeBreakdown,
      cacheMetrics,
      sessionCosts,
    });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch costs:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch cost analytics', 500);
  }
});

// ============================================================================
// Cache heatmap (stage x day)
// ============================================================================
router.get('/costs/cache-heatmap', async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    if (!VALID_PERIODS.has(period)) {
      return errorResponse(res, 'INVALID_PARAMETER', `Invalid period "${period}". Must be one of: 24h, 7d, 30d`, 400);
    }
    const periodStart = getPeriodStartDate(period);

    const activities = await db().brainActivity.findMany({
      where: { createdAt: { gte: periodStart } },
      select: {
        sessionId: true,
        tokenCountInput: true,
        metadata: true,
        createdAt: true,
      },
    });

    // Resolve stage intervals for all sessions
    const sessionIds = [...new Set(activities.map(a => a.sessionId).filter((id): id is string => id !== null))];
    const stageIntervals = await resolveStageIntervalsForSessions(sessionIds, db());

    // Aggregate by (stage, day)
    const cellMap = new Map<string, { totalTokens: number; cacheReadTokens: number }>();

    for (const a of activities) {
      const stage = resolveStageForTimestamp(stageIntervals.get(a.sessionId ?? ''), a.createdAt);
      const day = formatDateKey(a.createdAt);
      const key = `${stage}|${day}`;
      const { cacheRead } = extractCacheTokens(a.metadata);

      const entry = cellMap.get(key) || { totalTokens: 0, cacheReadTokens: 0 };
      entry.totalTokens += a.tokenCountInput;
      entry.cacheReadTokens += cacheRead;
      cellMap.set(key, entry);
    }

    const cells = Array.from(cellMap.entries()).map(([key, data]) => {
      const [stageStr, day] = key.split('|');
      return {
        stage: parseInt(stageStr, 10),
        day,
        hitRate: data.totalTokens > 0 ? Math.round((data.cacheReadTokens / data.totalTokens) * 10000) / 100 : 0,
        totalTokens: data.totalTokens,
        cacheReadTokens: data.cacheReadTokens,
      };
    });

    return successResponse(res, { cells });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch cache heatmap:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch cache heatmap', 500);
  }
});

// ============================================================================
// Cost by stage
// ============================================================================
router.get('/costs/by-stage', async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    if (!VALID_PERIODS.has(period)) {
      return errorResponse(res, 'INVALID_PARAMETER', `Invalid period "${period}". Must be one of: 24h, 7d, 30d`, 400);
    }
    const periodStart = getPeriodStartDate(period);

    const activities = (
      await db().brainActivity.findMany({
        where: { createdAt: { gte: periodStart } },
        select: {
          sessionId: true,
          cost: true,
          model: true,
          createdAt: true,
        },
      })
    ).map(a => ({ ...a, cost: num(a.cost) }));

    // Resolve stage intervals
    const sessionIds = [...new Set(activities.map(a => a.sessionId).filter((id): id is string => id !== null))];
    const stageIntervals = await resolveStageIntervalsForSessions(sessionIds, db());

    // Aggregate by stage
    const stageMap = new Map<number, { sonnetCost: number; haikuCost: number; titanCost: number; totalCost: number }>();

    for (const a of activities) {
      const stage = resolveStageForTimestamp(stageIntervals.get(a.sessionId ?? ''), a.createdAt);
      const modelNorm = normalizeModel(a.model);

      const entry = stageMap.get(stage) || { sonnetCost: 0, haikuCost: 0, titanCost: 0, totalCost: 0 };
      if (modelNorm === 'sonnet') entry.sonnetCost += a.cost;
      else if (modelNorm === 'haiku') entry.haikuCost += a.cost;
      else if (modelNorm === 'titan') entry.titanCost += a.cost;
      entry.totalCost += a.cost;
      stageMap.set(stage, entry);
    }

    const stages = Array.from(stageMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([stage, data]) => ({
        stage,
        sonnetCost: Math.round(data.sonnetCost * 1000000) / 1000000,
        haikuCost: Math.round(data.haikuCost * 1000000) / 1000000,
        titanCost: Math.round(data.titanCost * 1000000) / 1000000,
        totalCost: Math.round(data.totalCost * 1000000) / 1000000,
      }));

    return successResponse(res, { stages });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch cost by stage:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch cost by stage', 500);
  }
});

// ============================================================================
// Cost flow (Sankey diagram data)
// ============================================================================
router.get('/costs/flow', async (req, res) => {
  try {
    const period = (req.query.period as string) || '7d';
    if (!VALID_PERIODS.has(period)) {
      return errorResponse(res, 'INVALID_PARAMETER', `Invalid period "${period}". Must be one of: 24h, 7d, 30d`, 400);
    }
    const periodStart = getPeriodStartDate(period);

    const activities = (
      await db().brainActivity.findMany({
        where: { createdAt: { gte: periodStart } },
        select: {
          sessionId: true,
          cost: true,
          model: true,
          callType: true,
          createdAt: true,
        },
      })
    ).map(a => ({ ...a, cost: num(a.cost) }));

    // Resolve stage intervals
    const sessionIds = [...new Set(activities.map(a => a.sessionId).filter((id): id is string => id !== null))];
    const stageIntervals = await resolveStageIntervalsForSessions(sessionIds, db());

    // Build Sankey: Stage -> Model -> Call Type
    const stageNames = new Map<number, string>([
      [0, 'Pre-Session'],
      [1, 'Feel Heard'],
      [2, 'Perspective'],
      [3, 'Needs'],
      [4, 'Resolution'],
    ]);

    const nodeSet = new Map<string, number>();
    const linkMap = new Map<string, number>();

    const getNodeIndex = (name: string): number => {
      if (!nodeSet.has(name)) {
        nodeSet.set(name, nodeSet.size);
      }
      return nodeSet.get(name)!;
    };

    for (const a of activities) {
      const stage = resolveStageForTimestamp(stageIntervals.get(a.sessionId ?? ''), a.createdAt);
      const stageName = stageNames.get(stage) || `Stage ${stage}`;
      const modelNorm = normalizeModel(a.model);
      const modelName = modelNorm.charAt(0).toUpperCase() + modelNorm.slice(1);
      const callType = (a.callType || 'UNKNOWN').replace(/_/g, ' ');

      const stageIdx = getNodeIndex(stageName);
      const modelIdx = getNodeIndex(modelName);
      const callIdx = getNodeIndex(callType);

      // Stage -> Model link
      const smKey = `${stageIdx}-${modelIdx}`;
      linkMap.set(smKey, (linkMap.get(smKey) || 0) + a.cost);

      // Model -> Call Type link
      const mcKey = `${modelIdx}-${callIdx}`;
      linkMap.set(mcKey, (linkMap.get(mcKey) || 0) + a.cost);
    }

    const nodes = Array.from(nodeSet.keys()).map(name => ({ name }));
    const links = Array.from(linkMap.entries())
      .filter(([, value]) => value > 0)
      .map(([key, value]) => {
        const [source, target] = key.split('-').map(Number);
        return { source, target, value: Math.round(value * 1000000) / 1000000 };
      });

    return successResponse(res, { nodes, links });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch cost flow:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch cost flow', 500);
  }
});

// ============================================================================
// Prompt detail for a single BrainActivity
// ============================================================================
router.get('/activity/:activityId/prompt', async (req, res) => {
  try {
    const { activityId } = req.params;

    const activity = await db().brainActivity.findUnique({
      where: { id: activityId },
    });

    if (!activity) {
      return errorResponse(res, 'NOT_FOUND', 'Activity not found', 404);
    }

    const input = activity.input as ActivityBlob;
    const output = activity.output as ActivityBlob;
    const metadata = activity.metadata as ActivityBlob;

    // Parse system prompt blocks
    const systemPromptBlocks: Array<{ type: string; content: string; tokenCount: number; cached: boolean }> = [];
    if (input?.systemPrompt) {
      const sysPrompt = input.systemPrompt;
      if (typeof sysPrompt === 'string') {
        systemPromptBlocks.push({
          type: 'static',
          content: sysPrompt,
          tokenCount: Math.ceil(sysPrompt.length / 4), // rough estimate
          cached: true,
        });
      } else if (sysPrompt.staticBlock || sysPrompt.dynamicBlock) {
        if (sysPrompt.staticBlock) {
          systemPromptBlocks.push({
            type: 'static',
            content: sysPrompt.staticBlock,
            tokenCount: Math.ceil(sysPrompt.staticBlock.length / 4),
            cached: true,
          });
        }
        if (sysPrompt.dynamicBlock) {
          systemPromptBlocks.push({
            type: 'dynamic',
            content: sysPrompt.dynamicBlock,
            tokenCount: Math.ceil(sysPrompt.dynamicBlock.length / 4),
            cached: false,
          });
        }
      }
    }

    // Parse messages
    const messages = Array.isArray(input?.messages)
      ? input.messages.map((m: ActivityBlob) => ({
          role: m.role || 'unknown',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          hasCacheControl: !!m.cache_control,
        }))
      : [];

    // Parse response - extract thinking/draft/dispatch tags
    const responseText = output?.text || output?.streaming ? output?.text || '' : '';
    let thinking: string | null = null;
    let draft: string | null = null;
    let dispatch: string | null = null;

    if (typeof responseText === 'string') {
      const thinkMatch = responseText.match(/<thinking>([\s\S]*?)<\/thinking>/);
      if (thinkMatch) thinking = thinkMatch[1].trim();

      const draftMatch = responseText.match(/<draft>([\s\S]*?)<\/draft>/);
      if (draftMatch) draft = draftMatch[1].trim();

      const dispatchMatch = responseText.match(/<dispatch>([\s\S]*?)<\/dispatch>/);
      if (dispatchMatch) dispatch = dispatchMatch[1].trim();
    }

    // Token breakdown
    const { cacheRead, cacheWrite } = extractCacheTokens(metadata);
    const uncached = Math.max(0, activity.tokenCountInput - cacheRead - cacheWrite);

    // Cost breakdown
    const modelPrices = getModelPrices(activity.model);
    const inputCost = uncached * modelPrices.input;
    const outputCost = activity.tokenCountOutput * modelPrices.output;
    const cacheReadCost = cacheRead * modelPrices.cacheRead;
    const cacheWriteCost = cacheWrite * modelPrices.cacheWrite;
    const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    const savings = cacheRead * (modelPrices.input - modelPrices.cacheRead);

    return successResponse(res, {
      systemPrompt: { blocks: systemPromptBlocks },
      messages,
      response: {
        text: responseText,
        thinking,
        draft,
        dispatch,
      },
      tokens: {
        input: activity.tokenCountInput,
        output: activity.tokenCountOutput,
        cacheRead,
        cacheWrite,
        uncached,
      },
      cost: {
        inputCost: Math.round(inputCost * 1000000) / 1000000,
        outputCost: Math.round(outputCost * 1000000) / 1000000,
        cacheReadCost: Math.round(cacheReadCost * 1000000) / 1000000,
        cacheWriteCost: Math.round(cacheWriteCost * 1000000) / 1000000,
        total: Math.round(totalCost * 1000000) / 1000000,
        savings: Math.round(savings * 1000000) / 1000000,
      },
      timing: {
        durationMs: activity.durationMs,
        model: activity.model,
        callType: activity.callType,
        status: activity.status,
      },
      ...(metadata?.contextSizes
        ? {
            contextWindow: {
              pinnedTokens: metadata.contextSizes.pinnedTokens ?? 0,
              summaryTokens: metadata.contextSizes.summaryTokens ?? 0,
              recentTokens: metadata.contextSizes.recentTokens ?? 0,
              ragTokens: metadata.contextSizes.ragTokens ?? 0,
              totalUsed:
                (metadata.contextSizes.pinnedTokens ?? 0) +
                (metadata.contextSizes.summaryTokens ?? 0) +
                (metadata.contextSizes.recentTokens ?? 0) +
                (metadata.contextSizes.ragTokens ?? 0),
              budgetLimit: TOKEN_BUDGET_LIMIT,
              utilizationPercent:
                Math.round(
                  (((metadata.contextSizes.pinnedTokens ?? 0) +
                    (metadata.contextSizes.summaryTokens ?? 0) +
                    (metadata.contextSizes.recentTokens ?? 0) +
                    (metadata.contextSizes.ragTokens ?? 0)) /
                    TOKEN_BUDGET_LIMIT) *
                    10000,
                ) / 100,
            },
          }
        : {}),
    });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch prompt detail:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch prompt detail', 500);
  }
});

// Get all brain activities for a session
router.get('/activity/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // The session's activities, or a reflection's (inner work telemetry carries reflection_id)
    const activities = (
      await db().brainActivity.findMany({
        where: { OR: [{ sessionId }, { reflectionId: sessionId }] },
        orderBy: { createdAt: 'asc' },
      })
    ).map(activityDTO);

    // Partner session: every participant's own chat turns (their MAIN conversation)
    let messages: Array<{ id: string; content: string; timestamp: Date; senderId: string | null }> = (
      await db().message.findMany({
        where: { role: 'USER', kind: 'CHAT', conversation: { kind: 'MAIN', participant: { sessionId } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, content: true, createdAt: true, senderParticipant: { select: { userId: true } } },
      })
    ).map(m => ({
      id: m.id,
      content: m.content,
      timestamp: m.createdAt,
      senderId: m.senderParticipant?.userId ?? null,
    }));

    // If no messages found, it might be a reflection
    if (messages.length === 0) {
      messages = (
        await db().reflectionMessage.findMany({
          where: { reflectionId: sessionId, role: 'USER' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, content: true, createdAt: true },
        })
      ).map(m => ({ id: m.id, content: m.content, timestamp: m.createdAt, senderId: null }));
    }

    // Notable facts: every participant's NOTABLE_FACTS document of this session (ai_memory)
    const facts = await db().aiMemory.findMany({
      where: { kind: 'NOTABLE_FACTS', participant: { sessionId } },
      select: { doc: true },
    });
    const notableFacts = facts.flatMap(f => {
      const list = (f.doc as { facts?: unknown } | null)?.facts;
      return Array.isArray(list) ? list : [];
    });

    // Calculate summary stats
    const totalCost = activities.reduce((sum, a) => sum + a.cost, 0);
    const totalTokens = activities.reduce((sum, a) => sum + a.tokenCountInput + a.tokenCountOutput, 0);

    return successResponse(res, {
      activities,
      messages,
      notableFacts,
      summary: {
        totalCost,
        totalTokens,
        count: activities.length,
      },
    });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch activities:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch session activity', 500);
  }
});

// Get assembled context bundle for a session
// This endpoint assembles the full context bundle for each user in the session,
// allowing the Neural Monitor dashboard to display exactly what context the AI receives.
router.get('/sessions/:sessionId/context', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // First try as partner session: its human participants
    const participants = await db().participant.findMany({
      where: { sessionId, kind: 'human', userId: { not: null } },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, userId: true, displayName: true, joinedAt: true, user: { select: { name: true } } },
    });

    if (participants.length > 0) {
      // Partner session - assemble context for every participant
      const now = new Date().toISOString();
      const states = await loadStageStates(
        participants.map(p => ({ id: p.id, joinedAt: p.joinedAt })),
        db(),
      );

      const contextResults = await Promise.all(
        participants.map(
          async (member): Promise<{ userId: string; userName: string; context: ContextBundle | null }> => {
            const userId = member.userId!;
            const userName = member.displayName || member.user?.name || 'Unknown';
            const stage = states.get(member.id)?.current.stage || 1;

            try {
              // Emotional intensity: the participant's latest mood reading
              const latestReading = await db().moodReading.findFirst({
                where: { participantId: member.id },
                orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
                select: { intensity: true },
              });
              const emotionalIntensity = latestReading?.intensity ?? 5; // Default moderate intensity

              // Turn count: the participant's own chat turns
              const turnCount = await db().message.count({
                where: { senderParticipantId: member.id, role: 'USER', kind: 'CHAT' },
              });

              // Determine memory intent (required for context assembly)
              const intent = determineMemoryIntent({
                stage,
                emotionalIntensity,
                userMessage: '', // Empty - we're just assembling current context
                turnCount,
                isFirstTurnInSession: turnCount === 0,
              });

              // Assemble the context bundle — the app's single context builder, per
              // participant (TODO(TS-16): under RLS it reads as that participant's
              // identity; the dashboard has none, so it needs a definer path).
              const context = await assembleContextBundle(sessionId, userId, stage, intent);

              return { userId, userName, context };
            } catch (error) {
              logger.error(`[BrainRoutes] Failed to assemble context for user ${userId}:`, error);
              // Return placeholder for failed user
              return { userId, userName, context: null };
            }
          },
        ),
      );

      const response: ContextResponse = {
        sessionId,
        sessionType: 'partner',
        assembledAt: now,
        users: contextResults.filter((r): r is ContextUserData => r.context !== null),
      };

      return successResponse(res, response);
    }

    // Try as a reflection (inner work)
    const innerWorkSession = await db().reflection.findUnique({
      where: { id: sessionId },
      select: { userId: true, user: { select: { name: true } } },
    });

    if (innerWorkSession) {
      // Inner work sessions don't use assembleContextBundle (different flow)
      // Return a simplified response indicating this is an inner thoughts session
      const response: ContextResponse = {
        sessionId,
        sessionType: 'inner_thoughts',
        assembledAt: new Date().toISOString(),
        users: [
          {
            userId: innerWorkSession.userId,
            userName: innerWorkSession.user.name || 'Unknown',
            // For inner work sessions, create a minimal context bundle
            // This could be enhanced later if needed
            context: {
              conversationContext: {
                recentTurns: [],
                turnCount: 0,
                sessionDurationMinutes: 0,
              },
              emotionalThread: {
                initialIntensity: null,
                currentIntensity: null,
                trend: 'unknown',
                notableShifts: [],
              },
              stageContext: {
                stage: 0,
                gatesSatisfied: {},
              },
              userName: innerWorkSession.user.name || 'Unknown',
              intent: {
                intent: 'avoid_recall',
                depth: 'none',
                allowCrossSession: false,
                surfaceStyle: 'silent',
                reason: 'Inner work sessions have different context flow',
                threshold: 0.5,
                maxCrossSession: 0,
              },
              assembledAt: new Date().toISOString(),
            },
          },
        ],
      };

      return successResponse(res, response);
    }

    // Session not found
    return errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch session context:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch session context', 500);
  }
});

// ============================================================================
// Turn trace (pipeline timing)
// ============================================================================
router.get('/turn/:turnId/trace', async (req, res) => {
  try {
    const { turnId } = req.params;

    const activity = await db().brainActivity.findFirst({
      where: {
        turnId,
        callType: 'ORCHESTRATED_RESPONSE',
      },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });

    if (!activity) {
      return errorResponse(res, 'NOT_FOUND', 'No orchestrated response found for this turn', 404);
    }

    const metadata = activity.metadata as ActivityBlob;
    const turnTrace = metadata?.turnTrace ?? null;

    if (!turnTrace) {
      return errorResponse(res, 'NOT_FOUND', 'No trace data available for this turn', 404);
    }

    return successResponse(res, turnTrace);
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch turn trace:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch turn trace', 500);
  }
});

// Get sessions list with filter/search/sort support
router.get('/sessions', async (req, res) => {
  try {
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const fetchLimit = limit + 1; // Fetch one extra to detect next page

    // Filter params
    const statusFilter = req.query.status as string | undefined; // comma-separated
    const typeFilter = req.query.type as string | undefined; // PARTNER or INNER_WORK
    const stageFilter = req.query.stage as string | undefined; // comma-separated stage numbers
    const search = req.query.search as string | undefined;
    const fromDate = req.query.from ? new Date(req.query.from as string) : undefined;
    const toDate = req.query.to ? new Date(req.query.to as string) : undefined;
    const sort = (req.query.sort as string) || 'age';
    const order = (req.query.order as string) || 'desc';

    const statusValues = statusFilter ? statusFilter.split(',').map(s => s.trim()) : undefined;
    const stageValues = stageFilter
      ? stageFilter
          .split(',')
          .map(s => parseInt(s, 10))
          .filter(n => !isNaN(n))
      : undefined;

    // Determine which session types to fetch
    const fetchPartner = !typeFilter || typeFilter === 'PARTNER';
    const fetchInnerWork = !typeFilter || typeFilter === 'INNER_WORK';

    // Build partner session where clause
    const partnerWhere: Prisma.SessionWhereInput = {};
    if (cursor) partnerWhere.updatedAt = { lt: new Date(cursor) };
    if (fromDate || toDate)
      partnerWhere.createdAt = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) };
    if (statusValues) partnerWhere.status = { in: statusValues as SessionStatus[] };

    // Build reflection where clause
    const innerWhere: Prisma.ReflectionWhereInput = {};
    if (cursor) innerWhere.updatedAt = { lt: new Date(cursor) };
    if (fromDate || toDate)
      innerWhere.createdAt = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) };
    if (statusValues) innerWhere.status = { in: statusValues as ReflectionStatus[] };

    // Search filter - partner sessions by a participant's name/email or the session id; reflections also by title
    // (by title only while content is unencrypted — see below)
    const titleSearch: 'applied' | 'unavailable-when-encrypted' | undefined = search
      ? fieldEncryptionEnabled()
        ? 'unavailable-when-encrypted'
        : 'applied'
      : undefined;
    if (search) {
      const isId = /^[0-9a-f-]{36}$/i.test(search);
      partnerWhere.OR = [
        ...(isId ? [{ id: search }] : []),
        { participants: { some: { displayName: { contains: search, mode: 'insensitive' } } } },
        { participants: { some: { user: { name: { contains: search, mode: 'insensitive' } } } } },
        { participants: { some: { user: { email: { contains: search, mode: 'insensitive' } } } } },
      ];
      innerWhere.OR = [
        ...(isId ? [{ id: search }] : []),
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        // reflection.title is encrypted with a random IV (TS-13): with a key set,
        // SQL cannot match it, so the arm is skipped explicitly and the response
        // says so (ruling R45) rather than silently matching nothing. Restoring it
        // means decrypt-then-filter in the app, which W13 (per-user keys) decides.
        ...(titleSearch === 'applied' ? [{ title: { contains: search, mode: 'insensitive' as const } }] : []),
      ];
    }

    // 1. Fetch Partner Sessions
    let partnerSessions: Array<{ id: string; status: string; createdAt: Date; updatedAt: Date }> = [];
    if (fetchPartner) {
      partnerSessions = await db().session.findMany({
        take: fetchLimit,
        where: partnerWhere,
        orderBy: { updatedAt: 'desc' },
        select: { id: true, status: true, createdAt: true, updatedAt: true },
      });
    }
    const partnerSessionIds = partnerSessions.map(s => s.id);
    const [stages, labels, partnerTurns, partnerStats] = await Promise.all([
      maxStages(partnerSessionIds),
      participantLabels(partnerSessionIds),
      userTurnCounts(partnerSessionIds),
      activityStats(partnerSessionIds, 'sessionId'),
    ]);

    // Post-filter by stage if needed (stage is per participant, so the session's max)
    if (stageValues && stageValues.length > 0) {
      partnerSessions = partnerSessions.filter(s => stageValues.includes(stages.get(s.id) ?? 0));
    }

    // 2. Fetch reflections (inner work)
    let innerWorkSessions: Array<{
      id: string;
      status: string;
      title: string | null;
      createdAt: Date;
      updatedAt: Date;
      user: { id: string; name: string | null; email: string };
    }> = [];
    if (fetchInnerWork) {
      innerWorkSessions = await db().reflection.findMany({
        take: fetchLimit,
        where: innerWhere,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          status: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      });
    }
    const innerSessionIds = innerWorkSessions.map(s => s.id);
    const [innerTurns, innerStats] = await Promise.all([
      reflectionTurnCounts(innerSessionIds),
      activityStats(innerSessionIds, 'reflectionId'),
    ]);

    // 3. Map and Merge
    const mappedPartnerSessions = partnerSessions.map(session => {
      const stat = partnerStats.get(session.id);
      return {
        id: session.id,
        type: 'PARTNER' as const,
        status: session.status,
        stage: stages.get(session.id) ?? 0,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        title: null,
        participants: labels.get(session.id) ?? 'No Participants',
        relationship: null,
        stats: {
          totalCost: stat?.cost ?? 0,
          totalTokens: stat?.tokens ?? 0,
          activityCount: stat?.count ?? 0,
          turnCount: partnerTurns.get(session.id) ?? 0,
        },
      };
    });

    const mappedInnerSessions = innerWorkSessions.map(session => {
      const stat = innerStats.get(session.id);
      return {
        id: session.id,
        type: 'INNER_WORK' as const,
        status: session.status,
        stage: 0, // Inner work doesn't have stages
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        title: session.title || 'Untitled Session',
        participants: session.user?.name || 'Unknown',
        relationship: null,
        user: session.user,
        stats: {
          totalCost: stat?.cost ?? 0,
          totalTokens: stat?.tokens ?? 0,
          activityCount: stat?.count ?? 0,
          turnCount: innerTurns.get(session.id) ?? 0,
        },
      };
    });

    // Combine
    let allSessions = [...mappedPartnerSessions, ...mappedInnerSessions];

    // Apply sort
    const sortOrder = order === 'asc' ? 1 : -1;
    allSessions.sort((a, b) => {
      switch (sort) {
        case 'participants':
          return sortOrder * (a.participants || '').localeCompare(b.participants || '');
        case 'status':
          return sortOrder * a.status.localeCompare(b.status);
        case 'stage':
          return sortOrder * (a.stage - b.stage);
        case 'turns':
          return sortOrder * (a.stats.turnCount - b.stats.turnCount);
        case 'cost':
          return sortOrder * (a.stats.totalCost - b.stats.totalCost);
        case 'age':
        default:
          return sortOrder * (b.updatedAt.getTime() - a.updatedAt.getTime());
      }
    });

    // Paginate
    const hasNextPage = allSessions.length > limit;
    if (hasNextPage) {
      allSessions = allSessions.slice(0, limit);
    }

    const nextCursor =
      hasNextPage && allSessions.length > 0 ? allSessions[allSessions.length - 1].updatedAt.toISOString() : null;

    return successResponse(res, {
      sessions: allSessions,
      nextCursor,
      ...(titleSearch ? { titleSearch } : {}),
    });
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch sessions:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch sessions', 500);
  }
});

// ============================================================================
// Single session detail
// ============================================================================
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Try as partner session first
    const partnerSession = await db().session.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, createdAt: true, updatedAt: true },
    });

    if (partnerSession) {
      const [stats, turns, labels, stages] = await Promise.all([
        activityStats([sessionId], 'sessionId'),
        userTurnCounts([sessionId]),
        participantLabels([sessionId]),
        maxStages([sessionId]),
      ]);
      const stat = stats.get(sessionId);

      return successResponse(res, {
        id: partnerSession.id,
        type: 'PARTNER' as const,
        status: partnerSession.status,
        stage: stages.get(sessionId) ?? 0,
        createdAt: partnerSession.createdAt,
        updatedAt: partnerSession.updatedAt,
        title: null,
        participants: labels.get(sessionId) ?? 'No Participants',
        relationship: null,
        stats: {
          totalCost: stat?.cost ?? 0,
          totalTokens: stat?.tokens ?? 0,
          activityCount: stat?.count ?? 0,
          turnCount: turns.get(sessionId) ?? 0,
        },
      });
    }

    // Try as a reflection (inner work)
    const innerSession = await db().reflection.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    if (innerSession) {
      const [stats, turns] = await Promise.all([
        activityStats([sessionId], 'reflectionId'),
        reflectionTurnCounts([sessionId]),
      ]);
      const stat = stats.get(sessionId);

      return successResponse(res, {
        id: innerSession.id,
        type: 'INNER_WORK' as const,
        status: innerSession.status,
        stage: 0,
        createdAt: innerSession.createdAt,
        updatedAt: innerSession.updatedAt,
        title: innerSession.title || 'Untitled Session',
        participants: innerSession.user?.name || 'Unknown',
        relationship: null,
        user: innerSession.user,
        stats: {
          totalCost: stat?.cost ?? 0,
          totalTokens: stat?.tokens ?? 0,
          activityCount: stat?.count ?? 0,
          turnCount: turns.get(sessionId) ?? 0,
        },
      });
    }

    return errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
  } catch (error) {
    logger.error('[BrainRoutes] Failed to fetch session:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to fetch session', 500);
  }
});

// ============================================================================
// Ably Token Auth (for dashboard realtime)
// ============================================================================
router.get('/ably-token', async (_req, res) => {
  try {
    const ablyApiKey = process.env.ABLY_API_KEY;
    if (!ablyApiKey) {
      return errorResponse(res, 'NOT_CONFIGURED', 'Ably not configured', 503);
    }

    const Ably = await import('ably');
    const rest = new Ably.default.Rest(ablyApiKey);

    const tokenRequest = await rest.auth.createTokenRequest({
      capability: { 'ai-audit-stream': ['subscribe'] },
      ttl: 60 * 60 * 1000, // 1 hour
    });

    return successResponse(res, tokenRequest);
  } catch (error) {
    logger.error('[BrainRoutes] Failed to create Ably token:', error);
    return errorResponse(res, 'INTERNAL_ERROR', 'Failed to create Ably token', 500);
  }
});

export default router;
