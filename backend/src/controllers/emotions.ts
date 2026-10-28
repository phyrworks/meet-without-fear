import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { ApiResponse, ErrorCode } from '@meet-without-fear/shared';
import { loadMilestones, messageStage } from '../services/stage-shim';

/*
 * Target shape (TS-12): readings are `mood_reading` rows of the caller's
 * participant (req.participant, resolved once by requireSessionAccess) — a
 * reading carries no stage; the DTO's `stage` is the participant's stage at
 * the reading's instant (stage shim). `User.lastMoodIntensity` is gone (the
 * latest reading is the last mood). Exercises are `regulation_event` rows.
 */

// Validation schemas aligned with shared types
const recordEmotionSchema = z.object({
  intensity: z.number().int().min(1, 'Intensity must be at least 1').max(10, 'Intensity must be at most 10'),
  context: z.string().max(500, 'Context too long').optional(),
});

const completeExerciseSchema = z.object({
  type: z.enum(['BREATHING_EXERCISE', 'BODY_SCAN', 'GROUNDING', 'PAUSE_SESSION']),
  intensityBefore: z.number().int().min(1).max(10).optional(),
  intensityAfter: z.number().int().min(1).max(10).optional(),
});

// Response types
interface EmotionalReadingResponse {
  id: string;
  intensity: number;
  timestamp: Date;
}

interface RecordEmotionData {
  reading: EmotionalReadingResponse;
  suggestExercise: boolean;
}

interface ReadingItem {
  id: string;
  intensity: number;
  context: string | null;
  stage: number;
  timestamp: Date;
}

interface GetEmotionsData {
  readings: ReadingItem[];
}

interface ExerciseCompletionData {
  logged: boolean;
  completion: {
    id: string;
    type: string;
    completedAt: Date;
    intensityDelta: number | null;
  };
}

/**
 * POST /sessions/:id/emotions
 * Record an emotional reading for the current user in a session
 */
export async function recordEmotion(req: Request, res: Response): Promise<void> {
  // Validate request body
  const parseResult = recordEmotionSchema.safeParse(req.body);
  if (!parseResult.success) {
    const response: ApiResponse<never> = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid request body',
        details: parseResult.error.flatten(),
      },
    };
    res.status(400).json(response);
    return;
  }

  const { intensity, context } = parseResult.data;

  try {
    // The caller's participant in this session
    const participant = req.participant;

    if (!participant) {
      const response: ApiResponse<never> = {
        success: false,
        error: { code: ErrorCode.NOT_FOUND, message: 'Session not found or you are not a participant' },
      };
      res.status(404).json(response);
      return;
    }

    // The reading (the user's last mood is now simply their latest reading)
    const reading = await prisma.moodReading.create({
      data: {
        participantId: participant.id,
        intensity,
        context: context ?? null,
      },
      select: { id: true, intensity: true, recordedAt: true },
    });

    // Check if intervention is needed (intensity >= 8)
    const needsIntervention = intensity >= 8;

    const response: ApiResponse<RecordEmotionData> = {
      success: true,
      data: {
        reading: {
          id: reading.id,
          intensity: reading.intensity,
          timestamp: reading.recordedAt,
        },
        suggestExercise: needsIntervention,
      },
    };
    res.json(response);
  } catch (error) {
    logger.error('Error recording emotion:', error);
    const response: ApiResponse<never> = {
      success: false,
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Failed to record emotion' },
    };
    res.status(500).json(response);
  }
}

/**
 * GET /sessions/:id/emotions
 * Get emotion history for the current user in a session
 */
export async function getEmotions(req: Request, res: Response): Promise<void> {
  try {
    // The caller's participant in this session
    const participant = req.participant;

    if (!participant) {
      const response: ApiResponse<never> = {
        success: false,
        error: { code: ErrorCode.NOT_FOUND, message: 'Session not found or you are not a participant' },
      };
      res.status(404).json(response);
      return;
    }

    // Get readings (only the participant's own readings for privacy)
    const [readings, milestones] = await Promise.all([
      prisma.moodReading.findMany({
        where: { participantId: participant.id },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { id: true, intensity: true, context: true, recordedAt: true },
      }),
      loadMilestones([participant.id]),
    ]);

    const response: ApiResponse<GetEmotionsData> = {
      success: true,
      data: {
        readings: readings.map(r => ({
          id: r.id,
          intensity: r.intensity,
          context: r.context,
          stage: messageStage(milestones.get(participant.id) ?? [], r.recordedAt),
          timestamp: r.recordedAt,
        })),
      },
    };
    res.json(response);
  } catch (error) {
    logger.error('Error getting emotions:', error);
    const response: ApiResponse<never> = {
      success: false,
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Failed to get emotions' },
    };
    res.status(500).json(response);
  }
}

/**
 * POST /sessions/:id/exercises/complete
 * Log completion of an emotional regulation exercise
 */
export async function completeExercise(req: Request, res: Response): Promise<void> {
  // Validate request body
  const parseResult = completeExerciseSchema.safeParse(req.body);
  if (!parseResult.success) {
    const response: ApiResponse<never> = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid request body',
        details: parseResult.error.flatten(),
      },
    };
    res.status(400).json(response);
    return;
  }

  const { type, intensityBefore, intensityAfter } = parseResult.data;

  try {
    // Verify user is participant in session
    const participant = req.participant;

    if (!participant) {
      const response: ApiResponse<never> = {
        success: false,
        error: { code: ErrorCode.NOT_FOUND, message: 'Session not found or you are not a participant' },
      };
      res.status(404).json(response);
      return;
    }

    // Log exercise completion (regulation_event)
    const completion = await prisma.regulationEvent.create({
      data: {
        participantId: participant.id,
        type,
        intensityBefore: intensityBefore ?? null,
        intensityAfter: intensityAfter ?? null,
      },
      select: { id: true, type: true, completedAt: true },
    });

    const response: ApiResponse<ExerciseCompletionData> = {
      success: true,
      data: {
        logged: true,
        completion: {
          id: completion.id,
          type: completion.type,
          completedAt: completion.completedAt,
          intensityDelta: intensityBefore != null && intensityAfter != null ? intensityBefore - intensityAfter : null,
        },
      },
    };
    res.json(response);
  } catch (error) {
    logger.error('Error completing exercise:', error);
    const response: ApiResponse<never> = {
      success: false,
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Failed to log exercise completion' },
    };
    res.status(500).json(response);
  }
}
