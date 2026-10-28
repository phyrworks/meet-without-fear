/**
 * Needs Assessment Controller ("Am I OK?")
 *
 * Handles the 19 core human needs assessment system:
 * - GET /needs/reference - Get all 19 needs
 * - GET /needs/state - Get user's assessment state and current scores
 * - POST /needs/baseline - Submit initial baseline assessment
 * - POST /needs/:needId/check-in - Update a single need score
 * - GET /needs/:needId/history - Get score history for a need
 * - PATCH /needs/preferences - Update check-in preferences
 *
 * Target shape (TS-12): the taxonomy is the shared constant (NEEDS); a user's
 * scores and state are their `needs_assessment` feature document (scores[],
 * state), read-modify-write under a row lock; the DISTINCT ON / ROW_NUMBER()
 * reads are reductions (services/needs-reduction.ts).
 */

import { Request, Response } from 'express';
import { readFeature, updateFeature, newEntryId } from '../services/feature-state';
import { latestNeedScores, previousNeedScores, needHistory } from '../services/needs-reduction';
import { getUser } from '../middleware/auth';
import { asyncHandler, ValidationError } from '../middleware/errors';
import {
  ApiResponse,
  NeedDTO,
  NeedWithScoreDTO,
  NeedsAssessmentStateDTO,
  NeedsSummaryDTO,
  NeedScoreDTO,
  GetNeedsReferenceResponse,
  GetNeedsStateResponse,
  SubmitBaselineResponse,
  CheckInNeedResponse,
  GetNeedHistoryResponse,
  UpdateNeedsPreferencesResponse,
  NeedsCategory,
  NEEDS_CATEGORY_NAMES,
  NEEDS,
  needById,
  type NeedScoreDoc,
} from '@meet-without-fear/shared';
import { z } from 'zod';

// ============================================================================
// Validation Schemas
// ============================================================================

const submitBaselineSchema = z.object({
  scores: z
    .array(
      z.object({
        needId: z.number().int().min(1).max(19),
        score: z.number().int().min(0).max(2),
        clarification: z.string().max(2000).optional(),
      }),
    )
    .min(19)
    .max(19),
});

const checkInNeedSchema = z.object({
  score: z.number().int().min(0).max(2),
  clarification: z.string().max(2000).optional(),
});

const updatePreferencesSchema = z.object({
  checkInFrequencyDays: z.number().int().min(1).max(30).optional(),
});

const needHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

// ============================================================================
// Helper Functions
// ============================================================================

function mapNeedToDTO(need: {
  id: number;
  name: string;
  slug: string;
  description: string;
  category: string;
  order: number;
}): NeedDTO {
  return {
    id: need.id,
    name: need.name,
    slug: need.slug,
    description: need.description,
    category: need.category as NeedsCategory,
    order: need.order,
  };
}

function mapScoreToDTO(score: NeedScoreDoc): NeedScoreDTO {
  return {
    id: score.id,
    needId: score.needId,
    score: score.score,
    clarification: score.clarification,
    createdAt: score.createdAt,
  };
}

function calculateTrend(currentScore: number, previousScore: number | null): 'up' | 'down' | 'stable' {
  if (previousScore === null) return 'stable';
  if (currentScore > previousScore) return 'up';
  if (currentScore < previousScore) return 'down';
  return 'stable';
}

function calculateNextCheckInDate(frequencyDays: number): Date {
  const next = new Date();
  next.setDate(next.getDate() + frequencyDays);
  return next;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * GET /api/v1/needs/reference
 * Returns all 19 needs with their metadata.
 */
export const getNeedsReference = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  // Auth required but no user-specific data needed
  getUser(req);

  const needs = NEEDS;

  const response: ApiResponse<GetNeedsReferenceResponse> = {
    success: true,
    data: {
      needs: needs.map(mapNeedToDTO),
    },
  };
  res.json(response);
});

/**
 * GET /api/v1/needs/state
 * Returns user's assessment state and current scores.
 */
export const getNeedsState = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // The assessment document (a user with none reads the defaults; no row is created)
  const doc = await readFeature(user.id, 'needs_assessment');
  const state = doc.state;

  const needs = NEEDS;

  // Latest and previous score per need (were DISTINCT ON / ROW_NUMBER() = 2)
  const scoreMap = new Map(
    latestNeedScores(doc.scores).map(s => [s.needId, { score: s.score, date: new Date(s.createdAt) }]),
  );
  const previousScoreMap = new Map([...previousNeedScores(doc.scores)].map(([id, s]) => [id, s.score]));

  // Build current scores with trends
  const currentScores: NeedWithScoreDTO[] = needs.map(need => {
    const latest = scoreMap.get(need.id);
    const previous = previousScoreMap.get(need.id);

    return {
      ...mapNeedToDTO(need),
      currentScore: latest?.score ?? null,
      lastScoreDate: latest?.date?.toISOString() ?? null,
      trend: latest ? calculateTrend(latest.score, previous ?? null) : null,
    };
  });

  // Determine next check-in need
  let nextCheckInNeed: NeedDTO | null = null;
  if (state.baselineCompleted) {
    // Find the need with the oldest score or lowest score among stale ones
    const staleNeeds = currentScores
      .filter(n => n.lastScoreDate !== null)
      .sort((a, b) => {
        const dateA = a.lastScoreDate ? new Date(a.lastScoreDate).getTime() : 0;
        const dateB = b.lastScoreDate ? new Date(b.lastScoreDate).getTime() : 0;
        // First sort by date (oldest first)
        if (dateA !== dateB) return dateA - dateB;
        // Then by score (lowest first)
        return (a.currentScore ?? 0) - (b.currentScore ?? 0);
      });

    if (staleNeeds.length > 0) {
      const need = needs.find(n => n.id === staleNeeds[0].id);
      if (need) {
        nextCheckInNeed = mapNeedToDTO(need);
      }
    }
  }

  const stateDTO: NeedsAssessmentStateDTO = {
    baselineCompleted: state.baselineCompleted,
    baselineCompletedAt: state.baselineCompletedAt,
    checkInFrequencyDays: state.checkInFrequencyDays,
    lastCheckInAt: state.lastCheckInAt,
    nextCheckInAt: state.nextCheckInAt,
    nextCheckInNeed,
  };

  const response: ApiResponse<GetNeedsStateResponse> = {
    success: true,
    data: {
      state: stateDTO,
      currentScores,
    },
  };
  res.json(response);
});

/**
 * POST /api/v1/needs/baseline
 * Submit the initial baseline assessment (all 19 needs).
 */
export const submitBaseline = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = submitBaselineSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid baseline data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { scores } = parseResult.data;

  // Verify all 19 needs are included
  const needIds = new Set(scores.map(s => s.needId));
  if (needIds.size !== 19) {
    throw new ValidationError('All 19 needs must be scored');
  }

  // Get all needs for summary calculation
  const needMap = new Map(NEEDS.map(n => [n.id, n]));

  // All scores and the state in one document write
  const now = new Date().toISOString();
  await updateFeature(user.id, 'needs_assessment', doc => {
    for (const s of scores) {
      doc.scores.push({
        id: newEntryId(),
        needId: s.needId,
        score: s.score,
        clarification: s.clarification ?? null,
        createdAt: now,
      });
    }
    doc.state = {
      ...doc.state,
      baselineCompleted: true,
      baselineCompletedAt: now,
      lastCheckInAt: now,
      nextCheckInAt: calculateNextCheckInDate(7).toISOString(),
    };
  });

  // Calculate summary
  const byCategory: NeedsSummaryDTO['byCategory'] = [];
  const categories = ['FOUNDATION', 'EMOTIONAL', 'RELATIONAL', 'INTEGRATION', 'TRANSCENDENCE'] as const;

  let overallNotMet = 0;
  let overallSomewhatMet = 0;
  let overallFullyMet = 0;

  for (const category of categories) {
    const categoryNeeds = scores.filter(s => needMap.get(s.needId)?.category === category);
    const notMet = categoryNeeds.filter(s => s.score === 0).length;
    const somewhatMet = categoryNeeds.filter(s => s.score === 1).length;
    const fullyMet = categoryNeeds.filter(s => s.score === 2).length;

    overallNotMet += notMet;
    overallSomewhatMet += somewhatMet;
    overallFullyMet += fullyMet;

    byCategory.push({
      category: category as NeedsCategory,
      categoryName: NEEDS_CATEGORY_NAMES[category as NeedsCategory],
      totalNeeds: categoryNeeds.length,
      notMet,
      somewhatMet,
      fullyMet,
    });
  }

  const summary: NeedsSummaryDTO = {
    totalNeeds: 19,
    byCategory,
    overall: {
      notMet: overallNotMet,
      somewhatMet: overallSomewhatMet,
      fullyMet: overallFullyMet,
    },
  };

  const response: ApiResponse<SubmitBaselineResponse> = {
    success: true,
    data: {
      success: true,
      summary,
    },
  };
  res.status(201).json(response);
});

/**
 * POST /api/v1/needs/:needId/check-in
 * Update a single need score during check-in.
 */
export const checkInNeed = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const needId = parseInt(req.params.needId, 10);

  if (isNaN(needId) || needId < 1 || needId > 19) {
    throw new ValidationError('Invalid need ID');
  }

  const parseResult = checkInNeedSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid check-in data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { score, clarification } = parseResult.data;

  // Get the need info
  const need = needById(needId);

  if (!need) {
    throw new ValidationError('Need not found');
  }

  // The previous score and the new one in one locked read-modify-write
  const previousScore = await updateFeature(user.id, 'needs_assessment', doc => {
    const previous = needHistory(doc.scores, needId, 1)[0] ?? null;
    const now = new Date().toISOString();
    doc.scores.push({ id: newEntryId(), needId, score, clarification: clarification ?? null, createdAt: now });
    doc.state = {
      ...doc.state,
      lastCheckInNeedId: needId,
      lastCheckInAt: now,
      nextCheckInAt: calculateNextCheckInDate(7).toISOString(),
    };
    return previous;
  });

  const trend = calculateTrend(score, previousScore?.score ?? null);

  const response: ApiResponse<CheckInNeedResponse> = {
    success: true,
    data: {
      success: true,
      previousScore: previousScore?.score ?? null,
      newScore: score,
      trend,
      needId,
      needName: need.name,
    },
  };
  res.json(response);
});

/**
 * GET /api/v1/needs/:needId/history
 * Get score history for a specific need.
 */
export const getNeedHistory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const needId = parseInt(req.params.needId, 10);

  if (isNaN(needId) || needId < 1 || needId > 19) {
    throw new ValidationError('Invalid need ID');
  }

  const parseResult = needHistoryQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    throw new ValidationError('Invalid query parameters', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { limit } = parseResult.data;

  // Get the need info
  const need = needById(needId);

  if (!need) {
    throw new ValidationError('Need not found');
  }

  // Get score history
  const history = needHistory((await readFeature(user.id, 'needs_assessment')).scores, needId, limit);

  const response: ApiResponse<GetNeedHistoryResponse> = {
    success: true,
    data: {
      needId,
      needName: need.name,
      history: history.map(mapScoreToDTO),
    },
  };
  res.json(response);
});

/**
 * PATCH /api/v1/needs/preferences
 * Update check-in preferences.
 */
export const updatePreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = updatePreferencesSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid preferences data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { checkInFrequencyDays } = parseResult.data;

  // Update or create assessment state
  const state = await updateFeature(user.id, 'needs_assessment', doc => {
    if (checkInFrequencyDays) {
      doc.state = {
        ...doc.state,
        checkInFrequencyDays,
        nextCheckInAt: calculateNextCheckInDate(checkInFrequencyDays).toISOString(),
      };
    }
    return doc.state;
  });

  const response: ApiResponse<UpdateNeedsPreferencesResponse> = {
    success: true,
    data: {
      success: true,
      checkInFrequencyDays: state.checkInFrequencyDays,
    },
  };
  res.json(response);
});
