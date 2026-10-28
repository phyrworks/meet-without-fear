/**
 * People Controller
 *
 * Handles people tracking for cross-feature intelligence:
 * - GET /people - List tracked people
 * - GET /people/:id - Get person details with patterns
 * - PATCH /people/:id - Update person info
 * - POST /people/:id/merge - Merge two people
 * - DELETE /people/:id - Delete person
 *
 * Target shape (TS-12): the caller's `people` feature document (persons[] with
 * mentions[] — shared/src/dto/feature-state.ts), read-modify-write under a row
 * lock; mention patterns are reductions over the document (no groupBy).
 */

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { readFeature, updateFeature } from '../services/feature-state';
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
  type PersonDoc,
  type PersonMentionDoc,
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

function toPersonDTO(person: PersonDoc): PersonDTO {
  return {
    id: person.id,
    name: person.name,
    aliases: person.aliases,
    relationship: person.relationship,
    firstMentioned: person.firstMentioned,
    lastMentioned: person.lastMentioned,
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

function toPersonMentionDTO(mention: PersonMentionDoc): PersonMentionDTO {
  return {
    id: mention.id,
    sourceType: mention.sourceType as MentionSourceType,
    sourceId: mention.sourceId,
    context: mention.context,
    sentiment: mention.sentiment,
    createdAt: mention.createdAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const compare: (a: PersonDoc, b: PersonDoc) => number =
    sortBy === 'recent'
      ? (a, b) => b.lastMentioned.localeCompare(a.lastMentioned)
      : sortBy === 'name'
        ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => b.mentionCountInnerThoughts - a.mentionCountInnerThoughts; // 'frequent' - TODO: sum all counts

  const { persons } = await readFeature(user.id, 'people');
  const total = persons.length;
  const people = [...persons].sort((a, b) => compare(a, b) || a.id.localeCompare(b.id)).slice(0, limit);

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

  const person = (await readFeature(user.id, 'people')).persons.find(p => p.id === id);

  if (!person) {
    throw new NotFoundError('Person not found');
  }

  // Recent mentions, newest first
  const mentions = [...person.mentions].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const recentMentions = mentions.slice(0, 20);

  // Mentions by source type (was a groupBy)
  const byType = new Map<string, number>();
  for (const m of mentions) byType.set(m.sourceType, (byType.get(m.sourceType) ?? 0) + 1);
  const topContexts = [...byType].map(([sourceType, count]) => ({
    sourceType: sourceType as MentionSourceType,
    count,
  }));

  // Calculate average sentiment
  const sentimentMentions = recentMentions.filter(m => m.sentiment !== null);
  const avgSentiment =
    sentimentMentions.length > 0
      ? sentimentMentions.reduce((sum, m) => sum + (m.sentiment ?? 0), 0) / sentimentMentions.length
      : null;

  // Needs connections from the person's needsConnections map
  const needsConnections = Object.entries(person.needsConnections).map(([needName, count]) => ({ needName, count }));

  // Reflections where this person is mentioned (KNOW-02, INTEL-02) — the caller's own only
  // (a mention's sourceId is free text in the document; only a uuid can name a reflection)
  const sessionIds = [
    ...new Set(mentions.filter(m => m.sourceType === 'INNER_THOUGHTS' && UUID.test(m.sourceId)).map(m => m.sourceId)),
  ];
  const mentionedSessions =
    sessionIds.length > 0
      ? await prisma.reflection.findMany({
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
    sessions: mentionedSessions.map(s => ({
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

  const updated = await updateFeature(user.id, 'people', doc => {
    // Verify ownership
    const existing = doc.persons.find(p => p.id === id);
    if (!existing) throw new NotFoundError('Person not found');

    // Check for name uniqueness if changing name (the old UNIQUE (userId, name))
    if (body.name && body.name !== existing.name && doc.persons.some(p => p.id !== id && p.name === body.name)) {
      throw new ValidationError('A person with this name already exists');
    }

    if (body.name) existing.name = body.name;
    if (body.relationship !== undefined) existing.relationship = body.relationship || null;
    if (body.aliases) existing.aliases = body.aliases;
    return { ...existing };
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

  // Merge source into target (both must be the caller's own: the merge reads one document)
  const { person: merged, mergedCount } = await mergePersonsService(user.id, mergeIntoId, id);

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

  // The person and their mentions leave the document together
  const removed = await updateFeature(user.id, 'people', doc => {
    const i = doc.persons.findIndex(p => p.id === id);
    if (i < 0) return false;
    doc.persons.splice(i, 1);
    return true;
  });

  if (!removed) {
    throw new NotFoundError('Person not found');
  }

  const response: ApiResponse<DeletePersonResponse> = {
    success: true,
    data: {
      success: true,
    },
  };

  res.json(response);
});
