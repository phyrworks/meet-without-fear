import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { successResponse, errorResponse } from '../utils/response';
import {
  createTendingBetweenPeriodNote,
  createPassiveReentry,
  listTendingBetweenPeriodNotes,
  listTendingCoordinationCycles,
  listTendingEntries,
  listTendingHistory,
  setIndividualEntryShare,
  submitTendingCheckin,
  submitTendingResponse,
  TendingForbiddenError,
  TendingInvalidStateError,
  TendingNotFoundError,
} from '../services/tending.service';
import {
  ContinueChoice,
  PartialClosureResolution,
  TendingBlockerCategory,
  TendingFollowThroughStatus,
  TendingHelpfulnessStatus,
  TendingNeedResolutionStatus,
  TendingNextAction,
  TendingReminderScope,
} from '@meet-without-fear/shared';

const tendingResponseStatuses = ['CHECKIN', 'WORKED', 'PARTLY', 'DID_NOT_WORK', 'DID_NOT_TRY', 'OTHER'] as const;

const submitTendingResponseSchema = z.object({
  status: z.enum(tendingResponseStatuses),
  reflection: z.string().max(2000).optional(),
  continueChoice: z.nativeEnum(ContinueChoice).optional(),
});

const orientationSchema = z.object({
  reflection: z.string().max(4000).default(''),
  perEntryNotes: z.record(z.string(), z.string().max(2000)).optional(),
});

const submitTendingCheckinSchema = z.object({
  orientations: z.object({
    whatWorked: orientationSchema,
    whereMoreSupport: orientationSchema,
    whatComesNext: z.object({
      continueChoice: z.nativeEnum(ContinueChoice),
      nextAction: z.nativeEnum(TendingNextAction).optional(),
      partialClosure: z.record(z.string(), z.nativeEnum(PartialClosureResolution)).optional(),
      reminders: z
        .array(
          z.object({
            tendingEntryId: z.string().optional(),
            scope: z.nativeEnum(TendingReminderScope),
            remindAt: z.string().datetime(),
            cadence: z.string().max(80).optional(),
            note: z.string().max(1000).optional(),
          }),
        )
        .optional(),
    }),
  }),
  entryOutcomes: z
    .array(
      z.object({
        tendingEntryId: z.string(),
        followThroughStatus: z.nativeEnum(TendingFollowThroughStatus),
        helpfulnessStatus: z.nativeEnum(TendingHelpfulnessStatus).optional(),
        blockerCategories: z.array(z.nativeEnum(TendingBlockerCategory)).optional(),
        whatHappened: z.string().max(2000).optional(),
        helpedNeed: z.string().max(2000).optional(),
        blockerNote: z.string().max(2000).optional(),
        stillWorthTrying: z.boolean().optional(),
        note: z.string().max(2000).optional(),
      }),
    )
    .optional(),
  needOutcomes: z
    .array(
      z.object({
        needId: z.string().optional(),
        needLabel: z.string().min(1).max(500),
        sourceUserId: z.string().optional(),
        resolutionStatus: z.nativeEnum(TendingNeedResolutionStatus),
        note: z.string().max(2000).optional(),
        changedNeedLabel: z.string().max(500).optional(),
        nextAction: z.nativeEnum(TendingNextAction).optional(),
      }),
    )
    .optional(),
  reminders: z
    .array(
      z.object({
        tendingEntryId: z.string().optional(),
        scope: z.nativeEnum(TendingReminderScope),
        remindAt: z.string().datetime(),
        cadence: z.string().max(80).optional(),
        note: z.string().max(1000).optional(),
      }),
    )
    .optional(),
  adjustments: z
    .array(
      z.object({
        tendingEntryId: z.string(),
        privacyScope: z.nativeEnum(TendingReminderScope).optional(),
        revisedCommitmentText: z.string().max(2000).optional(),
        revisedCadence: z.string().max(200).optional(),
        revisedScope: z.string().max(1000).optional(),
        revisedSuccessCriteria: z.string().max(1000).optional(),
        reason: z.string().max(2000).optional(),
        blockerAddressed: z.array(z.nativeEnum(TendingBlockerCategory)).optional(),
      }),
    )
    .optional(),
  includedBetweenPeriodNoteIds: z.array(z.string()).optional(),
  shareBetweenPeriodNoteIds: z.array(z.string()).optional(),
  nextAction: z.nativeEnum(TendingNextAction).optional(),
  resolvedEnoughOverride: z.boolean().optional(),
  resolvedEnoughOverrideNote: z.string().max(1000).optional(),
});

const createTendingReentrySchema = z.object({
  intent: z.string().max(1000).optional(),
});

const createTendingBetweenPeriodNoteSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export async function getTendingEntries(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const [entries, coordinationCycles, betweenPeriodNotes] = await Promise.all([
      listTendingEntries(req.params.id, user.id),
      listTendingCoordinationCycles(req.params.id, user.id),
      listTendingBetweenPeriodNotes(req.params.id, user.id),
    ]);
    successResponse(res, { entries, coordinationCycles, betweenPeriodNotes });
  } catch (error) {
    if (error instanceof TendingNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    logger.error('[getTendingEntries] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get Tending entries', 500);
  }
}

export async function getTendingHistory(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const cycles = await listTendingHistory(req.params.id, user.id);
    successResponse(res, { cycles });
  } catch (error) {
    if (error instanceof TendingNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    logger.error('[getTendingHistory] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get Tending history', 500);
  }
}

export async function postTendingResponse(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const parseResult = submitTendingResponseSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const entry = await submitTendingResponse({
      entryId: req.params.entryId,
      userId: user.id,
      ...parseResult.data,
    });
    successResponse(res, { entry });
  } catch (error) {
    if (error instanceof TendingNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Tending entry not found', 404);
      return;
    }
    if (error instanceof TendingInvalidStateError) {
      errorResponse(res, 'VALIDATION_ERROR', error.message, 400);
      return;
    }
    logger.error('[postTendingResponse] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to submit Tending response', 500);
  }
}

async function handleShareToggle(req: Request, res: Response, optedInShared: boolean): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const entry = await setIndividualEntryShare({
      entryId: req.params.entryId,
      userId: user.id,
      optedInShared,
    });
    successResponse(res, { entry });
  } catch (error) {
    if (error instanceof TendingNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Tending entry not found', 404);
      return;
    }
    if (error instanceof TendingForbiddenError) {
      errorResponse(res, 'FORBIDDEN', 'Only the owner can change sharing on this entry', 403);
      return;
    }
    if (error instanceof TendingInvalidStateError) {
      errorResponse(res, 'VALIDATION_ERROR', error.message, 400);
      return;
    }
    logger.error('[handleShareToggle] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to update Tending entry sharing', 500);
  }
}

export async function postTendingEntryShare(req: Request, res: Response): Promise<void> {
  await handleShareToggle(req, res, true);
}

export async function postTendingEntryUnshare(req: Request, res: Response): Promise<void> {
  await handleShareToggle(req, res, false);
}

export async function postTendingCheckin(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const parseResult = submitTendingCheckinSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const result = await submitTendingCheckin({
      sessionId: req.params.id,
      userId: user.id,
      orientations: parseResult.data.orientations,
      entryOutcomes: parseResult.data.entryOutcomes,
      needOutcomes: parseResult.data.needOutcomes,
      reminders: parseResult.data.reminders,
      adjustments: parseResult.data.adjustments,
      includedBetweenPeriodNoteIds: parseResult.data.includedBetweenPeriodNoteIds,
      shareBetweenPeriodNoteIds: parseResult.data.shareBetweenPeriodNoteIds,
      nextAction: parseResult.data.nextAction,
      resolvedEnoughOverride: parseResult.data.resolvedEnoughOverride,
      resolvedEnoughOverrideNote: parseResult.data.resolvedEnoughOverrideNote,
    });
    successResponse(res, {
      entries: result.entries,
      checkin: result.checkin,
      coordinationCycle: result.coordinationCycle,
      newSessionId: result.newSessionId,
      continueChoice: result.continueChoice,
      nextScheduledFor: result.nextScheduledFor ? result.nextScheduledFor.toISOString() : null,
    });
  } catch (error) {
    if (error instanceof TendingNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (error instanceof TendingInvalidStateError) {
      errorResponse(res, 'VALIDATION_ERROR', error.message, 400);
      return;
    }
    logger.error('[postTendingCheckin] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to submit Tending check-in', 500);
  }
}

export async function postTendingBetweenPeriodNote(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const parseResult = createTendingBetweenPeriodNoteSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const note = await createTendingBetweenPeriodNote({
      sessionId: req.params.id,
      userId: user.id,
      content: parseResult.data.content,
    });
    successResponse(res, { note }, 201);
  } catch (error) {
    if (error instanceof TendingNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (error instanceof TendingInvalidStateError) {
      errorResponse(res, 'VALIDATION_ERROR', error.message, 400);
      return;
    }
    logger.error('[postTendingBetweenPeriodNote] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to create Tending between-period note', 500);
  }
}

export async function postTendingReentry(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const parseResult = createTendingReentrySchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const entry = await createPassiveReentry({
      sessionId: req.params.id,
      userId: user.id,
      intent: parseResult.data.intent,
    });
    successResponse(res, { entry }, 201);
  } catch (error) {
    if (error instanceof TendingNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (error instanceof TendingInvalidStateError) {
      errorResponse(res, 'VALIDATION_ERROR', error.message, 400);
      return;
    }
    logger.error('[postTendingReentry] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to create Tending re-entry', 500);
  }
}
