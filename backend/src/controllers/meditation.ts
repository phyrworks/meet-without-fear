/**
 * Meditation Controller ("Develop Loving Awareness")
 *
 * Handles guided and unguided meditation features:
 * - POST /meditation/sessions - Create new session
 * - PATCH /meditation/sessions/:id - Update session
 * - GET /meditation/sessions - List sessions
 * - POST /meditation/suggest - Get AI suggestion
 * - POST /meditation/generate-script - Generate meditation script
 * - GET /meditation/stats - Get aggregated stats
 * - GET /meditation/favorites - List favorites
 * - POST /meditation/favorites - Save as favorite
 * - DELETE /meditation/favorites/:id - Delete favorite
 * - GET /meditation/preferences - Get preferences
 * - PATCH /meditation/preferences - Update preferences
 *
 * Target shape (TS-12): the caller's `meditation` feature document (sessions[],
 * scripts[] = saved meditations, favorites[], preferences, stats —
 * shared/src/dto/feature-state.ts), read-modify-write under a row lock
 * (services/feature-state.ts). Low needs are a reduction over the
 * `needs_assessment` document (no DISTINCT ON).
 */

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { readFeature, updateFeature, newEntryId } from '../services/feature-state';
import { latestNeedScores } from '../services/needs-reduction';
import { getUser } from '../middleware/auth';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors';
import {
  ApiResponse,
  MeditationSessionDTO,
  MeditationSessionSummaryDTO,
  MeditationStatsDTO,
  MeditationFavoriteDTO,
  MeditationPreferencesDTO,
  SavedMeditationDTO,
  SavedMeditationSummaryDTO,
  CreateMeditationSessionResponse,
  UpdateMeditationSessionResponse,
  ListMeditationSessionsResponse,
  GetMeditationSuggestionResponse,
  GenerateScriptRequest,
  GenerateScriptResponse,
  GetMeditationStatsResponse,
  ListMeditationFavoritesResponse,
  CreateMeditationFavoriteResponse,
  DeleteMeditationFavoriteResponse,
  GetMeditationPreferencesResponse,
  UpdateMeditationPreferencesResponse,
  ListSavedMeditationsResponse,
  GetSavedMeditationResponse,
  CreateSavedMeditationResponse,
  UpdateSavedMeditationResponse,
  DeleteSavedMeditationResponse,
  ParseMeditationTextResponse,
  MeditationType,
  FavoriteType,
  calculateDuration,
  needById,
  type MeditationDoc,
  type MeditationSessionDoc,
  type MeditationFavoriteDoc,
  type SavedMeditationDoc,
} from '@meet-without-fear/shared';
import { z } from 'zod';
import { getCompletion } from '../lib/bedrock';

// ============================================================================
// Validation Schemas
// ============================================================================

const createSessionSchema = z.object({
  type: z.enum(['GUIDED', 'UNGUIDED']),
  durationMinutes: z.number().int().min(5).max(60),
  focusArea: z.string().max(100).optional(),
  voiceId: z.string().max(50).optional(),
  backgroundSound: z.string().max(50).optional(),
});

const updateSessionSchema = z.object({
  completed: z.boolean().optional(),
  postNotes: z.string().max(2000).optional(),
  savedAsFavorite: z.boolean().optional(),
  favoriteType: z.enum(['EXACT', 'THEME']).optional(),
});

const listSessionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
  type: z.enum(['GUIDED', 'UNGUIDED']).optional(),
});

const generateScriptSchema = z.object({
  focusArea: z.string().min(1).max(100),
  durationMinutes: z.number().int().min(5).max(60),
  context: z
    .object({
      preparingForConflict: z.boolean().optional(),
      recentEmotions: z.array(z.string()).optional(),
      lowNeeds: z.array(z.string()).optional(),
    })
    .optional(),
});

const createFavoriteSchema = z.object({
  sessionId: z.string(),
  name: z.string().max(100).optional(),
});

const updatePreferencesSchema = z.object({
  preferredVoice: z.string().max(50).optional(),
  voiceSpeed: z.number().min(0.8).max(1.2).optional(),
  defaultDuration: z.number().int().min(5).max(60).optional(),
  backgroundSound: z.string().max(50).optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional(),
});

// ============================================================================
// Helper Functions
// ============================================================================

function mapSessionToDTO(session: MeditationSessionDoc): MeditationSessionDTO {
  return {
    id: session.id,
    type: session.type as MeditationType,
    durationMinutes: session.durationMinutes,
    focusArea: session.focusArea,
    completed: session.completed,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    scriptGenerated: session.scriptGenerated,
    voiceId: session.voiceId,
    backgroundSound: session.backgroundSound,
    savedAsFavorite: session.savedAsFavorite,
    favoriteType: session.favoriteType as FavoriteType | null,
    postNotes: session.postNotes,
  };
}

function mapSessionToSummaryDTO(session: MeditationSessionDoc): MeditationSessionSummaryDTO {
  return {
    id: session.id,
    type: session.type as MeditationType,
    durationMinutes: session.durationMinutes,
    focusArea: session.focusArea,
    completed: session.completed,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
  };
}

function mapFavoriteToDTO(fav: MeditationFavoriteDoc): MeditationFavoriteDTO {
  return {
    id: fav.id,
    name: fav.name,
    focusArea: fav.focusArea,
    durationMinutes: fav.durationMinutes,
    favoriteType: fav.favoriteType as FavoriteType,
    script: fav.script,
    savedAt: fav.savedAt,
  };
}

function mapPreferencesToDTO(prefs: MeditationDoc['preferences']): MeditationPreferencesDTO {
  return prefs;
}

/** Newest first by an ISO instant key (ties by id — deterministic). */
function newestFirst<T extends { id: string }>(rows: T[], key: (r: T) => string): T[] {
  return [...rows].sort((a, b) => key(b).localeCompare(key(a)) || b.id.localeCompare(a.id));
}

/** The stats after one session is counted (the old MeditationStats upsert, in memory). */
function updateStats(stats: MeditationDoc['stats'], session: MeditationSessionDoc): void {
  const today = new Date().toISOString().split('T')[0];
  const sessionDate = session.startedAt.split('T')[0];
  const lastDate = stats.lastSessionDate?.split('T')[0];

  // Calculate streak
  let currentStreak = stats.currentStreak;
  let longestStreak = stats.longestStreak;
  let streakStartDate = stats.streakStartDate;

  if (session.completed) {
    if (!lastDate) {
      // First session ever
      currentStreak = 1;
      streakStartDate = session.startedAt;
    } else if (sessionDate === today) {
      // Session today
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      if (lastDate === yesterday) {
        // Continuing streak from yesterday
        currentStreak++;
      } else if (lastDate !== today) {
        // Streak broken, starting new
        currentStreak = 1;
        streakStartDate = session.startedAt;
      }
      // If lastDate === today, streak already counted
    }

    if (currentStreak > longestStreak) {
      longestStreak = currentStreak;
    }
  }

  // Update focus areas
  const favoriteFocusAreas = { ...stats.favoriteFocusAreas };
  if (session.focusArea) {
    favoriteFocusAreas[session.focusArea] = (favoriteFocusAreas[session.focusArea] || 0) + 1;
  }

  stats.totalSessions += 1;
  if (session.type === 'GUIDED') stats.guidedCount += 1;
  if (session.type === 'UNGUIDED') stats.unguidedCount += 1;
  if (session.completed) stats.totalMinutes += session.durationMinutes;
  stats.currentStreak = currentStreak;
  stats.longestStreak = longestStreak;
  stats.streakStartDate = streakStartDate;
  if (session.completed) stats.lastSessionDate = session.startedAt;
  stats.favoriteFocusAreas = favoriteFocusAreas;
}

/** Up to three of the user's currently low needs (score <= 1), by need id — was a DISTINCT ON. */
async function lowNeedNames(userId: string): Promise<string[]> {
  const { scores } = await readFeature(userId, 'needs_assessment');
  return latestNeedScores(scores)
    .filter(s => s.score <= 1)
    .slice(0, 3)
    .map(s => needById(s.needId)?.name ?? `Need ${s.needId}`);
}

// ============================================================================
// Script Generation
// ============================================================================

async function generateMeditationScript(
  focusArea: string,
  durationMinutes: number,
  userId: string,
  context?: GenerateScriptRequest['context'],
): Promise<string> {
  const totalWords = durationMinutes * 100; // ~100 wpm with pauses

  const prompt = `Generate a ${durationMinutes}-minute guided meditation script.

FOCUS: ${focusArea}

${context?.lowNeeds?.length ? `USER CONTEXT:\n- Low-scoring needs: ${context.lowNeeds.join(', ')}` : ''}
${context?.recentEmotions?.length ? `- Recent emotions: ${context.recentEmotions.join(', ')}` : ''}
${context?.preparingForConflict ? '- Preparing for a difficult conversation' : ''}

STRUCTURE (total ~${totalWords} words including pause markers):

OPENING (${Math.round(durationMinutes * 0.1)} min):
- Begin with [BELL]
- Welcome and settling
- Posture guidance
- Initial breath awareness

CORE PRACTICE (${Math.round(durationMinutes * 0.75)} min):
- Main technique/focus
- Include [PAUSE:30s] and [PAUSE:60s] markers generously
- Guided awareness with spacious silence
- Gentle redirecting for wandering mind
- More silence than words

INTEGRATION (${Math.round(durationMinutes * 0.1)} min):
- Widening awareness
- Bringing practice into daily life
${context?.preparingForConflict ? '- Connection to upcoming difficult conversations' : ''}

CLOSING (${Math.round(durationMinutes * 0.05)} min):
- Gentle return
- [BELL]
- Brief acknowledgment

TONE GUIDANCE:
${
  focusArea.toLowerCase().includes('rest') || focusArea.toLowerCase().includes('grounding')
    ? '- Softer, slower voice'
    : focusArea.toLowerCase().includes('courage') || focusArea.toLowerCase().includes('clarity')
      ? '- Steadier, firmer voice'
      : focusArea.toLowerCase().includes('compassion')
        ? '- Warmer, gentler voice'
        : '- Calm, neutral voice'
}

REQUIREMENTS:
- Use specific sensory language (embodied, not intellectual)
- Include appropriate pauses - silence is essential
- Don't over-explain or be too wordy
- Natural pacing with room to breathe
- End with something grounding they can take forward

OUTPUT FORMAT:
- Use exactly this format for pauses: [PAUSE:30s] or [PAUSE:60s] (colon after PAUSE, number, then 's')
- Use exactly this format for bells: [BELL]
- Place pause markers on their own lines or at the end of sentences
- Include generous pauses throughout, especially during core practice
- Output ONLY the script text with these markers - no metadata, no commentary, no explanations
- Example format:
  [BELL]

  Welcome to this practice.

  [PAUSE:10s]

  Begin by noticing your breath.

  [PAUSE:30s]

  Let your attention settle...

  [PAUSE:60s]`;

  // Generate synthetic IDs for standalone feature
  const syntheticSessionId = `meditation-${userId}`;
  const syntheticTurnId = `${syntheticSessionId}-${Date.now()}`;

  const script = await getCompletion({
    systemPrompt: prompt,
    messages: [{ role: 'user', content: `Generate a ${durationMinutes}-minute meditation on ${focusArea}` }],
    maxTokens: 4000,
    operation: 'meditation-script',
    sessionId: syntheticSessionId,
    turnId: syntheticTurnId,
  });

  return script || generateFallbackScript(focusArea, durationMinutes);
}

function generateFallbackScript(focusArea: string, durationMinutes: number): string {
  return `[BELL]

Welcome. Find a comfortable position and let your body settle.
There's nowhere you need to be right now except here.

[PAUSE:10s]

Begin by noticing your breath. Not changing it, just noticing.

[PAUSE:20s]

Let your attention settle on the sensations of breathing.
The rise and fall. The natural rhythm.

[PAUSE:30s]

Now, gently bring your awareness to ${focusArea}.

[PAUSE:60s]

Whatever arises, just notice it. There's nothing to fix or change.

[PAUSE:60s]

${durationMinutes >= 10 ? `[PAUSE:60s]\n\nContinue resting in this awareness.\n\n[PAUSE:60s]\n` : ''}

Now, begin to widen your awareness. Include the sounds around you.
The feeling of your body in space.

[PAUSE:20s]

As you prepare to return, carry this sense of presence with you.

[PAUSE:10s]

When you're ready, gently open your eyes.

[BELL]`;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * POST /api/v1/meditation/sessions
 * Create a new meditation session.
 */
export const createSession = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = createSessionSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid session data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { type, durationMinutes, focusArea, voiceId, backgroundSound } = parseResult.data;

  let script: string | null = null;
  if (type === 'GUIDED' && focusArea) {
    // Get user context for personalization
    script = await generateMeditationScript(focusArea, durationMinutes, user.id, {
      lowNeeds: await lowNeedNames(user.id),
    });
  }

  const session: MeditationSessionDoc = {
    id: newEntryId(),
    type,
    durationMinutes,
    focusArea: focusArea ?? null,
    completed: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
    scriptGenerated: script,
    voiceId: voiceId ?? null,
    backgroundSound: backgroundSound ?? null,
    savedAsFavorite: false,
    favoriteType: null,
    postNotes: null,
  };
  await updateFeature(user.id, 'meditation', doc => {
    doc.sessions.push(session);
  });

  const response: ApiResponse<CreateMeditationSessionResponse> = {
    success: true,
    data: {
      session: mapSessionToDTO(session),
      script: script ?? undefined,
    },
  };
  res.status(201).json(response);
});

/**
 * PATCH /api/v1/meditation/sessions/:id
 * Update a meditation session.
 */
export const updateSession = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const { id } = req.params;

  const parseResult = updateSessionSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid update data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { completed, postNotes, savedAsFavorite, favoriteType } = parseResult.data;

  // The session, its stats and a favorite change in one locked document write.
  const session = await updateFeature(user.id, 'meditation', doc => {
    const current = doc.sessions.find(s => s.id === id);
    if (!current) return null;
    const existing = { ...current };

    if (completed !== undefined) current.completed = completed;
    if (completed) current.completedAt = new Date().toISOString();
    if (postNotes !== undefined) current.postNotes = postNotes;
    if (savedAsFavorite !== undefined) current.savedAsFavorite = savedAsFavorite;
    if (favoriteType !== undefined) current.favoriteType = favoriteType;

    // Update stats if completed
    if (completed && !existing.completed) {
      updateStats(doc.stats, current);
    }

    // Create favorite if requested
    if (savedAsFavorite && favoriteType && !existing.savedAsFavorite) {
      doc.favorites.push({
        id: newEntryId(),
        name: current.focusArea || 'Meditation',
        focusArea: current.focusArea || 'general',
        durationMinutes: current.durationMinutes,
        favoriteType,
        script: favoriteType === 'EXACT' ? current.scriptGenerated : null,
        savedAt: new Date().toISOString(),
      });
    }
    return { ...current };
  });

  if (!session) {
    throw new NotFoundError('Session not found');
  }

  const response: ApiResponse<UpdateMeditationSessionResponse> = {
    success: true,
    data: { session: mapSessionToDTO(session) },
  };
  res.json(response);
});

/**
 * GET /api/v1/meditation/sessions
 * List meditation sessions.
 */
export const listSessions = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = listSessionsSchema.safeParse(req.query);
  if (!parseResult.success) {
    throw new ValidationError('Invalid query parameters', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { limit, offset, type } = parseResult.data;

  const matching = newestFirst(
    (await readFeature(user.id, 'meditation')).sessions.filter(s => !type || s.type === type),
    s => s.startedAt,
  );
  const total = matching.length;
  const sessions = matching.slice(offset, offset + limit);

  const response: ApiResponse<ListMeditationSessionsResponse> = {
    success: true,
    data: {
      sessions: sessions.map(mapSessionToSummaryDTO),
      total,
      hasMore: offset + sessions.length < total,
    },
  };
  res.json(response);
});

/**
 * POST /api/v1/meditation/suggest
 * Get AI suggestion for meditation.
 */
export const getSuggestion = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Get user's needs state
  const lowNeeds = await lowNeedNames(user.id);

  // Check for recent conflicts: a live session of the caller's from the last week
  const recentConflict = await prisma.session.findFirst({
    where: {
      participants: { some: { userId: user.id, leftAt: null } },
      status: 'ACTIVE',
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
  });

  let suggestedFocus = 'grounding and presence';
  let reasoning = 'A practice to help you feel centered and connected to the present moment.';
  let suggestedDuration = 10;

  if (recentConflict) {
    suggestedFocus = 'grounding and inner steadiness';
    reasoning =
      "Given you're working through something with someone, a grounding practice could help you feel more steady and clear.";
    suggestedDuration = 15;
  } else if (lowNeeds.length > 0) {
    const needNames = lowNeeds.map(n => n.toLowerCase());
    if (needNames.some(n => n.includes('rest') || n.includes('calm'))) {
      suggestedFocus = 'rest and restoration';
      reasoning = `I notice rest and calm feel unmet right now. A restful practice might offer some ease.`;
      suggestedDuration = 15;
    } else if (needNames.some(n => n.includes('compassion'))) {
      suggestedFocus = 'self-compassion';
      reasoning = `Self-compassion seems like it could use some attention. A loving-kindness practice might feel supportive.`;
      suggestedDuration = 15;
    }
  }

  const response: ApiResponse<GetMeditationSuggestionResponse> = {
    success: true,
    data: {
      suggestedFocus,
      reasoning,
      suggestedDuration,
    },
  };
  res.json(response);
});

/**
 * POST /api/v1/meditation/generate-script
 * Generate a meditation script.
 */
export const generateScript = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = generateScriptSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { focusArea, durationMinutes, context } = parseResult.data;

  const script = await generateMeditationScript(focusArea, durationMinutes, user.id, context);

  const response: ApiResponse<GenerateScriptResponse> = {
    success: true,
    data: {
      script,
      estimatedMinutes: durationMinutes,
    },
  };
  res.json(response);
});

/**
 * GET /api/v1/meditation/stats
 * Get meditation stats.
 */
export const getStats = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const stats = (await readFeature(user.id, 'meditation')).stats;

  const favoriteFocusAreas = stats.favoriteFocusAreas;
  const sortedAreas = Object.entries(favoriteFocusAreas)
    .sort((a, b) => b[1] - a[1])
    .map(([focusArea, count]) => ({ focusArea, count }));

  const statsDTO: MeditationStatsDTO = {
    totalSessions: stats.totalSessions,
    guidedCount: stats.guidedCount,
    unguidedCount: stats.unguidedCount,
    totalMinutes: stats.totalMinutes,
    currentStreak: stats.currentStreak,
    longestStreak: stats.longestStreak,
    streakStartDate: stats.streakStartDate,
    lastSessionDate: stats.lastSessionDate,
    favoriteFocusAreas: sortedAreas,
  };

  const response: ApiResponse<GetMeditationStatsResponse> = {
    success: true,
    data: { stats: statsDTO },
  };
  res.json(response);
});

/**
 * GET /api/v1/meditation/favorites
 * List meditation favorites.
 */
export const listFavorites = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const favorites = newestFirst((await readFeature(user.id, 'meditation')).favorites, f => f.savedAt);

  const response: ApiResponse<ListMeditationFavoritesResponse> = {
    success: true,
    data: { favorites: favorites.map(mapFavoriteToDTO) },
  };
  res.json(response);
});

/**
 * POST /api/v1/meditation/favorites
 * Save a session as favorite.
 */
export const createFavorite = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = createFavoriteSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { sessionId, name } = parseResult.data;

  const favorite = await updateFeature(user.id, 'meditation', doc => {
    const session = doc.sessions.find(s => s.id === sessionId);
    if (!session) return null;
    const created: MeditationFavoriteDoc = {
      id: newEntryId(),
      name: name || session.focusArea || 'Meditation',
      focusArea: session.focusArea || 'general',
      durationMinutes: session.durationMinutes,
      favoriteType: session.favoriteType || 'THEME',
      script: session.favoriteType === 'EXACT' ? session.scriptGenerated : null,
      savedAt: new Date().toISOString(),
    };
    doc.favorites.push(created);
    return created;
  });

  if (!favorite) {
    throw new NotFoundError('Session not found');
  }

  const response: ApiResponse<CreateMeditationFavoriteResponse> = {
    success: true,
    data: { favorite: mapFavoriteToDTO(favorite) },
  };
  res.status(201).json(response);
});

/**
 * DELETE /api/v1/meditation/favorites/:id
 * Delete a favorite.
 */
export const deleteFavorite = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const { id } = req.params;

  const removed = await updateFeature(user.id, 'meditation', doc => {
    const i = doc.favorites.findIndex(f => f.id === id);
    if (i < 0) return false;
    doc.favorites.splice(i, 1);
    return true;
  });

  if (!removed) {
    throw new NotFoundError('Favorite not found');
  }

  const response: ApiResponse<DeleteMeditationFavoriteResponse> = {
    success: true,
    data: { success: true },
  };
  res.json(response);
});

/**
 * GET /api/v1/meditation/preferences
 * Get meditation preferences.
 */
export const getPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const prefs = (await readFeature(user.id, 'meditation')).preferences;

  const response: ApiResponse<GetMeditationPreferencesResponse> = {
    success: true,
    data: { preferences: mapPreferencesToDTO(prefs) },
  };
  res.json(response);
});

/**
 * PATCH /api/v1/meditation/preferences
 * Update meditation preferences.
 */
export const updatePreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = updatePreferencesSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid preferences', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const prefs = await updateFeature(user.id, 'meditation', doc => {
    const patch = Object.fromEntries(Object.entries(parseResult.data).filter(([, v]) => v !== undefined));
    doc.preferences = { ...doc.preferences, ...patch };
    return doc.preferences;
  });

  const response: ApiResponse<UpdateMeditationPreferencesResponse> = {
    success: true,
    data: { preferences: mapPreferencesToDTO(prefs) },
  };
  res.json(response);
});

// ============================================================================
// Saved Meditations
// ============================================================================

const createSavedMeditationSchema = z.object({
  title: z.string().min(1).max(100),
  script: z.string().min(1).max(50000),
  conversationId: z.string().optional(),
});

const updateSavedMeditationSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  script: z.string().min(1).max(50000).optional(),
});

const parseMeditationTextSchema = z.object({
  text: z.string().min(1).max(50000),
});

function mapSavedMeditationToDTO(meditation: SavedMeditationDoc): SavedMeditationDTO {
  return {
    id: meditation.id,
    title: meditation.title,
    script: meditation.script,
    durationSeconds: meditation.durationSeconds,
    conversationId: meditation.conversationId,
    createdAt: meditation.createdAt,
    updatedAt: meditation.updatedAt,
  };
}

function mapSavedMeditationToSummaryDTO(meditation: SavedMeditationDoc): SavedMeditationSummaryDTO {
  return {
    id: meditation.id,
    title: meditation.title,
    durationSeconds: meditation.durationSeconds,
    createdAt: meditation.createdAt,
  };
}

/**
 * GET /api/v1/meditation/saved
 * List user's saved meditations.
 */
export const listSavedMeditations = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const meditations = newestFirst((await readFeature(user.id, 'meditation')).scripts, m => m.createdAt);
  const total = meditations.length;

  const response: ApiResponse<ListSavedMeditationsResponse> = {
    success: true,
    data: {
      meditations: meditations.map(mapSavedMeditationToSummaryDTO),
      total,
    },
  };
  res.json(response);
});

/**
 * GET /api/v1/meditation/saved/:id
 * Get a specific saved meditation.
 */
export const getSavedMeditation = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const { id } = req.params;

  const meditation = (await readFeature(user.id, 'meditation')).scripts.find(m => m.id === id);

  if (!meditation) {
    throw new NotFoundError('Saved meditation not found');
  }

  const response: ApiResponse<GetSavedMeditationResponse> = {
    success: true,
    data: { meditation: mapSavedMeditationToDTO(meditation) },
  };
  res.json(response);
});

/**
 * POST /api/v1/meditation/saved
 * Save a custom meditation.
 */
export const createSavedMeditation = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = createSavedMeditationSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid meditation data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { title, script, conversationId } = parseResult.data;
  const durationSeconds = calculateDuration(script);

  const now = new Date().toISOString();
  const meditation: SavedMeditationDoc = {
    id: newEntryId(),
    title,
    script,
    durationSeconds,
    conversationId: conversationId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await updateFeature(user.id, 'meditation', doc => {
    doc.scripts.push(meditation);
  });

  const response: ApiResponse<CreateSavedMeditationResponse> = {
    success: true,
    data: { meditation: mapSavedMeditationToDTO(meditation) },
  };
  res.status(201).json(response);
});

/**
 * PATCH /api/v1/meditation/saved/:id
 * Update a saved meditation.
 */
export const updateSavedMeditation = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const { id } = req.params;

  const parseResult = updateSavedMeditationSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid update data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { title, script } = parseResult.data;

  // Recalculate duration if script changed
  const durationSeconds = script ? calculateDuration(script) : undefined;

  const meditation = await updateFeature(user.id, 'meditation', doc => {
    const current = doc.scripts.find(m => m.id === id);
    if (!current) return null;
    if (title) current.title = title;
    if (script) current.script = script;
    if (durationSeconds !== undefined) current.durationSeconds = durationSeconds;
    current.updatedAt = new Date().toISOString();
    return { ...current };
  });

  if (!meditation) {
    throw new NotFoundError('Saved meditation not found');
  }

  const response: ApiResponse<UpdateSavedMeditationResponse> = {
    success: true,
    data: { meditation: mapSavedMeditationToDTO(meditation) },
  };
  res.json(response);
});

/**
 * DELETE /api/v1/meditation/saved/:id
 * Delete a saved meditation.
 */
export const deleteSavedMeditation = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const { id } = req.params;

  const removed = await updateFeature(user.id, 'meditation', doc => {
    const i = doc.scripts.findIndex(m => m.id === id);
    if (i < 0) return false;
    doc.scripts.splice(i, 1);
    return true;
  });

  if (!removed) {
    throw new NotFoundError('Saved meditation not found');
  }

  const response: ApiResponse<DeleteSavedMeditationResponse> = {
    success: true,
    data: { success: true },
  };
  res.json(response);
});

/**
 * POST /api/v1/meditation/parse
 * Parse user-provided text into a structured meditation script with timing tokens.
 */
export const parseMeditationText = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = parseMeditationTextSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { text } = parseResult.data;

  // Use AI to convert raw text to structured script with timing tokens
  const syntheticSessionId = `meditation-parse-${user.id}`;
  const syntheticTurnId = `${syntheticSessionId}-${Date.now()}`;

  const prompt = `You are a meditation script formatter. Your task is to take user-provided meditation text and convert it to a structured format with proper timing tokens.

INPUT TEXT:
${text}

INSTRUCTIONS:
1. Preserve all spoken content exactly as provided (do not edit the meditation text itself)
2. Add [PAUSE:Xs] tokens where pauses should occur:
   - [PAUSE:3s] - short breath pause after a sentence
   - [PAUSE:5s] to [PAUSE:10s] - medium pause between sections or after instructions
   - [PAUSE:30s] to [PAUSE:60s] - longer pauses for practice/silence periods
3. Add [BELL] token at the beginning and/or end if not already present
4. Look for cues like "pause", "moment of silence", "take time to...", "..." and convert to appropriate pause durations
5. If timing is ambiguous, use reasonable defaults and note the ambiguity

RESPOND IN THIS EXACT JSON FORMAT:
{
  "script": "the formatted script with [PAUSE:Xs] and [BELL] tokens",
  "suggestedTitle": "a short descriptive title based on the content",
  "hasAmbiguousPauses": true/false,
  "ambiguityQuestions": ["array of questions if timing was unclear, empty array if no ambiguity"]
}

Output only valid JSON, no markdown or explanation.`;

  const rawResponse = await getCompletion({
    systemPrompt: prompt,
    messages: [{ role: 'user', content: 'Convert this meditation text to structured format.' }],
    maxTokens: 8000,
    operation: 'meditation-parse',
    sessionId: syntheticSessionId,
    turnId: syntheticTurnId,
  });

  // Parse the AI response
  let parsedResult: {
    script: string;
    suggestedTitle: string;
    hasAmbiguousPauses: boolean;
    ambiguityQuestions: string[];
  };

  try {
    // Try to extract JSON from the response
    const jsonMatch = rawResponse?.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    parsedResult = JSON.parse(jsonMatch[0]);
  } catch {
    // Fallback: treat the text as-is with default pauses
    parsedResult = {
      script: `[BELL]\n\n${text}\n\n[BELL]`,
      suggestedTitle: 'Custom Meditation',
      hasAmbiguousPauses: true,
      ambiguityQuestions: [
        'Could not automatically detect pause timing. Please review and add [PAUSE:Xs] tokens manually.',
      ],
    };
  }

  const durationSeconds = calculateDuration(parsedResult.script);

  const response: ApiResponse<ParseMeditationTextResponse> = {
    success: true,
    data: {
      script: parsedResult.script,
      durationSeconds,
      suggestedTitle: parsedResult.suggestedTitle,
      hasAmbiguousPauses: parsedResult.hasAmbiguousPauses,
      ambiguityQuestions: parsedResult.ambiguityQuestions.length > 0 ? parsedResult.ambiguityQuestions : undefined,
    },
  };
  res.json(response);
});
