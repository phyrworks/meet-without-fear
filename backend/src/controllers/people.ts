/**
 * People Controller
 *
 * Handles people tracking for cross-feature intelligence:
 * - GET /people - List tracked people
 * - GET /people/:id - Get person details with patterns
 * - PATCH /people/:id - Update person info
 * - POST /people/:id/merge - Merge two people
 * - DELETE /people/:id - Delete person
 */

import { Request, Response } from 'express';
import { MentionSourceType as PrismaMentionSourceType } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { getUser } from '../middleware/auth';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors';
import {
  ApiResponse,
  PersonDTO,
  PersonDetailDTO,
  PersonMentionDTO,
  ListTrackedPeopleResponse,
  GetPersonResponse,
  UpdatePersonResponse,
  MergePeopleResponse,
  DeletePersonResponse,
  MentionSourceType,
} from '@meet-without-fear/shared';
import { z } from 'zod';
import { mergePeople as mergePersonsService } from '../services/people-extractor';

// ============================================================================
// Validation Schemas
// ============================================================================

const listPeopleSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  sortBy: z.enum(['recent', 'frequent', 'name']).optional().default('recent'),
});

const updatePersonSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  relationship: z.string().max(50).optional(),
  aliases: z.array(z.string().max(100)).optional(),
});

const mergePersonSchema = z.object({
  mergeIntoId: z.string().min(1),
});

// ============================================================================
// Helpers
// ============================================================================

function toPersonDTO(person: {
  id: string;
  name: string;
  aliases: string[];
  relationship: string | null;
  firstMentioned: Date;
  lastMentioned: Date;
  mentionCountInnerThoughts: number;
  mentionCountGratitude: number;
  mentionCountNeeds: number;
  mentionCountConflict: number;
}): PersonDTO {
  return {
    id: person.id,
    name: person.name,
    aliases: person.aliases,
    relationship: person.relationship,
    firstMentioned: person.firstMentioned.toISOString(),
    lastMentioned: person.lastMentioned.toISOString(),
    mentionCounts: {
      innerThoughts: person.mentionCountInnerThoughts,
      gratitude: person.mentionCountGratitude,
      needs: person.mentionCountNeeds,
      conflict: person.mentionCountConflict,
      total:
        person.mentionCountInnerThoughts +
        person.mentionCountGratitude +
        person.mentionCountNeeds +
        person.mentionCountConflict,
    },
  };
}

function toPersonMentionDTO(mention: {
  id: string;
  sourceType: PrismaMentionSourceType;
  sourceId: string;
  context: string | null;
  sentiment: number | null;
  createdAt: Date;
}): PersonMentionDTO {
  return {
    id: mention.id,
    sourceType: mention.sourceType as MentionSourceType,
    sourceId: mention.sourceId,
    context: mention.context,
    sentiment: mention.sentiment,
    createdAt: mention.createdAt.toISOString(),
  };
}

function prismaSourceTypeToShared(sourceType: PrismaMentionSourceType): MentionSourceType {
  // Map Prisma enum to shared enum (they have the same values)
  return sourceType as unknown as MentionSourceType;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * GET /people
 * List user's tracked people.
 */
export const listPeople = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const { limit, sortBy } = listPeopleSchema.parse(req.query);

  const orderBy: Record<string, 'asc' | 'desc'> =
    sortBy === 'recent'
      ? { lastMentioned: 'desc' }
      : sortBy === 'name'
        ? { name: 'asc' }
        : { mentionCountInnerThoughts: 'desc' }; // 'frequent' - TODO: sum all counts

  const [people, total] = await Promise.all([
    prisma.person.findMany({
      where: { userId: user.id },
      orderBy,
      take: limit,
    }),
    prisma.person.count({ where: { userId: user.id } }),
  ]);

  const response: ApiResponse<ListTrackedPeopleResponse> = {
    success: true,
    data: {
      people: people.map(toPersonDTO),
      total,
    },
  };

  res.json(response);
});

/**
 * GET /people/:id
 * Get person details with patterns.
 */
export const getPerson = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const { id } = req.params;

  const person = await prisma.person.findFirst({
    where: { id, userId: user.id },
  });

  if (!person) {
    throw new NotFoundError('Person not found');
  }

  // Get recent mentions
  const recentMentions = await prisma.personMention.findMany({
    where: { personId: id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  // Calculate patterns
  const mentionsByType = await prisma.personMention.groupBy({
    by: ['sourceType'],
    where: { personId: id },
    _count: true,
  });

  const topContexts = mentionsByType.map((m) => ({
    sourceType: prismaSourceTypeToShared(m.sourceType),
    count: m._count,
  }));

  // Calculate average sentiment
  const sentimentMentions = recentMentions.filter((m) => m.sentiment !== null);
  const avgSentiment =
    sentimentMentions.length > 0
      ? sentimentMentions.reduce((sum, m) => sum + (m.sentiment ?? 0), 0) / sentimentMentions.length
      : null;

  // Get needs connections from person's needsConnections JSON
  const needsConnections = Object.entries((person.needsConnections as Record<string, number>) || {}).map(
    ([needName, count]) => ({
      needName,
      count: count as number,
    })
  );

  // Fetch sessions where this person is mentioned (KNOW-02, INTEL-02)
  const innerThoughtsMentions = await prisma.personMention.findMany({
    where: {
      personId: id,
      sourceType: 'INNER_THOUGHTS',
    },
    select: { sourceId: true },
  });

  const sessionIds = [...new Set(innerThoughtsMentions.map((m) => m.sourceId))];
  const mentionedSessions =
    sessionIds.length > 0
      ? await prisma.innerWorkSession.findMany({
          where: {
            id: { in: sessionIds },
            userId: user.id,
            status: { not: 'ARCHIVED' },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, title: true, theme: true, createdAt: true },
        })
      : [];

  const detailDTO: PersonDetailDTO = {
    ...toPersonDTO(person),
    recentMentions: recentMentions.map(toPersonMentionDTO),
    patterns: {
      topContexts,
      needsConnections,
      averageSentiment: avgSentiment,
    },
    sessions: mentionedSessions.map((s) => ({
      sessionId: s.id,
      title: s.title,
      theme: s.theme,
      createdAt: s.createdAt.toISOString(),
    })),
  };

  const response: ApiResponse<GetPersonResponse> = {
    success: true,
    data: {
      person: detailDTO,
    },
  };

  res.json(response);
});

/**
 * PATCH /people/:id
 * Update person info.
 */
export const updatePerson = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const { id } = req.params;
  const body = updatePersonSchema.parse(req.body);

  // Verify ownership
  const existing = await prisma.person.findFirst({
    where: { id, userId: user.id },
  });

  if (!existing) {
    throw new NotFoundError('Person not found');
  }

  // Check for name uniqueness if changing name
  if (body.name && body.name !== existing.name) {
    const duplicate = await prisma.person.findFirst({
      where: {
        userId: user.id,
        name: body.name,
        id: { not: id },
      },
    });

    if (duplicate) {
      throw new ValidationError('A person with this name already exists');
    }
  }

  const updated = await prisma.person.update({
    where: { id },
    data: {
      ...(body.name && { name: body.name }),
      ...(body.relationship !== undefined && { relationship: body.relationship || null }),
      ...(body.aliases && { aliases: body.aliases }),
    },
  });

  const response: ApiResponse<UpdatePersonResponse> = {
    success: true,
    data: {
      person: toPersonDTO(updated),
    },
  };

  res.json(response);
});

/**
 * POST /people/:id/merge
 * Merge another person into this one.
 */
export const mergePerson = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const { id } = req.params; // Target person (keeps this one)
  const { mergeIntoId } = mergePersonSchema.parse(req.body); // Source person (deletes this one)

  // Verify ownership of both people
  const [target, source] = await Promise.all([
    prisma.person.findFirst({ where: { id, userId: user.id } }),
    prisma.person.findFirst({ where: { id: mergeIntoId, userId: user.id } }),
  ]);

  if (!target) {
    throw new NotFoundError('Target person not found');
  }
  if (!source) {
    throw new NotFoundError('Source person not found');
  }

  // Count mentions being merged for the response
  const mergedCount = await prisma.personMention.count({
    where: { personId: mergeIntoId },
  });

  // Merge source into target
  const merged = await mergePersonsService(mergeIntoId, id);

  const response: ApiResponse<MergePeopleResponse> = {
    success: true,
    data: {
      person: toPersonDTO(merged),
      mergedCount,
    },
  };

  res.json(response);
});

/**
 * DELETE /people/:id
 * Delete person and their mentions.
 */
export const deletePerson = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const { id } = req.params;

  // Verify ownership
  const existing = await prisma.person.findFirst({
    where: { id, userId: user.id },
  });

  if (!existing) {
    throw new NotFoundError('Person not found');
  }

  // Delete mentions first (cascade), then person
  await prisma.personMention.deleteMany({
    where: { personId: id },
  });

  await prisma.person.delete({
    where: { id },
  });

  const response: ApiResponse<DeletePersonResponse> = {
    success: true,
    data: {
      success: true,
    },
  };

  res.json(response);
});
