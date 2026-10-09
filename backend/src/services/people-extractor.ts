/**
 * People Extractor Service
 *
 * Extracts mentions of people from user content and tracks them
 * for cross-feature intelligence.
 */

import { MentionSourceType, Person, BrainActivityCallType } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getHaikuJson } from '../lib/bedrock';
import { getCurrentUserId } from '../lib/request-context';

// ============================================================================
// Types
// ============================================================================

interface ExtractedPeople {
  names: string[];
  matchedToExisting: Record<string, string>; // name -> personId
  newPeople: string[];
  relationships: Record<string, string>; // name -> relationship type
  sentiment: Record<string, number>; // name -> sentiment (-1 to 1)
}

interface ExtractionParams {
  userId: string;
  content: string;
  sourceType: MentionSourceType;
  sourceId: string;
  existingPeople?: Person[];
}

interface ExtractionResult {
  people: string[];
  newPeople: string[];
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Extract people from content and track mentions.
 * Returns list of people mentioned (existing and new).
 */
export async function extractAndTrackPeople(params: ExtractionParams): Promise<ExtractionResult> {
  const { userId, content, sourceType, sourceId, existingPeople: providedPeople } = params;

  // Skip if content is too short
  if (!content || content.length < 10) {
    return { people: [], newPeople: [] };
  }

  // Get user's existing people for matching
  const existingPeople =
    providedPeople ||
    (await prisma.person.findMany({
      where: { userId },
    }));

  // Determine session ID for cost tracking
  const sessionId = (sourceType === 'PARTNER_SESSION' || sourceType === 'INNER_THOUGHTS')
    ? sourceId
    : undefined;

  // Extract names using AI
  const extracted = await extractNamesWithAI(content, existingPeople, sessionId);

  if (!extracted || extracted.names.length === 0) {
    return { people: [], newPeople: [] };
  }

  const results: ExtractionResult = { people: [], newPeople: [] };

  // Process each extracted name
  for (const name of extracted.names) {
    const normalizedName = normalizeName(name);

    // Check if AI already matched to existing
    const matchedId = extracted.matchedToExisting[name];
    if (matchedId) {
      const existingPerson = existingPeople.find((p) => p.id === matchedId);
      if (existingPerson) {
        await updatePersonMention(existingPerson.id, params, extracted.sentiment[name]);
        results.people.push(existingPerson.name);
        continue;
      }
    }

    // Try local matching
    const match = findMatchingPerson(normalizedName, existingPeople);
    if (match) {
      await updatePersonMention(match.id, params, extracted.sentiment[name]);
      results.people.push(match.name);
    } else {
      // Create new person
      const relationship = extracted.relationships[name] || null;
      const newPerson = await createPerson(userId, normalizedName, relationship);
      await createMention(newPerson.id, userId, params, extracted.sentiment[name]);
      results.newPeople.push(newPerson.name);
      results.people.push(newPerson.name);
    }
  }

  return results;
}

// ============================================================================
// AI Extraction
// ============================================================================

async function extractNamesWithAI(content: string, existingPeople: Person[], sessionId?: string): Promise<ExtractedPeople | null> {
  const existingPeopleList =
    existingPeople.length > 0
      ? existingPeople
        .map(
          (p) =>
            `- ${p.name} (id: ${p.id})${p.aliases.length ? ` [aliases: ${p.aliases.join(', ')}]` : ''}${p.relationship ? ` [${p.relationship}]` : ''}`
        )
        .join('\n')
      : '(none yet)';

  const prompt = `Extract people mentioned in this text.

EXISTING PEOPLE (match to these if possible):
${existingPeopleList}

TEXT:
"${content}"

INSTRUCTIONS:
1. Identify all people mentioned by name or relationship reference
2. Match to existing people where confident (Sarah = my friend Sarah)
3. For new people, infer relationship if clear from context
4. Skip generic references ("someone", "people", "they", "a friend")
5. Include specific relationship references:
   - "my partner" → match to existing partner if one exists
   - "my mom" → specific person even if name unknown
   - "a coworker" → too vague, skip
6. Sentiment: -1 (negative), 0 (neutral), 1 (positive)

OUTPUT (JSON):
{
  "names": ["Sarah", "my partner"],
  "matchedToExisting": {
    "Sarah": "existing_person_id",
    "my partner": "partner_id_if_exists"
  },
  "newPeople": ["Tom"],
  "relationships": {
    "Tom": "coworker",
    "my mom": "parent"
  },
  "sentiment": {
    "Sarah": 0.7,
    "Tom": -0.3
  }
}`;

  // Generate turnId - use request context for userId attribution
  const effectiveSessionId = sessionId || 'people-extraction';
  const effectiveUserId = getCurrentUserId() || 'system';
  const turnId = sessionId
    ? `${sessionId}-${effectiveUserId}-people-extract-${Date.now()}`
    : `people-extraction-${effectiveUserId}-${Date.now()}`;

  try {
    const result = await getHaikuJson<ExtractedPeople>({
      systemPrompt: prompt,
      messages: [{ role: 'user', content: 'Extract people from the text above.' }],
      operation: 'people-extraction',
      sessionId: effectiveSessionId,
      turnId,
      callType: BrainActivityCallType.PEOPLE_EXTRACTION,
    });

    return result;
  } catch (error) {
    logger.warn('[People Extractor] AI extraction failed:', error);
    return null;
  }
}

// ============================================================================
// Matching Logic
// ============================================================================

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function findMatchingPerson(name: string, existingPeople: Person[]): Person | null {
  const normalized = name.toLowerCase().trim();

  // Exact name match
  const exactMatch = existingPeople.find((p) => p.name.toLowerCase() === normalized);
  if (exactMatch) return exactMatch;

  // Alias match
  const aliasMatch = existingPeople.find((p) => p.aliases.some((a) => a.toLowerCase() === normalized));
  if (aliasMatch) return aliasMatch;

  // Partial match (first name only, but only if unique)
  const firstName = normalized.split(' ')[0];
  if (firstName.length >= 3) {
    const partialMatches = existingPeople.filter((p) => p.name.toLowerCase().split(' ')[0] === firstName);
    if (partialMatches.length === 1) {
      return partialMatches[0];
    }
  }

  return null;
}

// ============================================================================
// Database Operations
// ============================================================================

async function createPerson(userId: string, name: string, relationship: string | null): Promise<Person> {
  return prisma.person.create({
    data: {
      userId,
      name,
      relationship,
      firstMentioned: new Date(),
      lastMentioned: new Date(),
    },
  });
}

async function createMention(
  personId: string,
  userId: string,
  params: ExtractionParams,
  sentiment: number | undefined
): Promise<void> {
  const { sourceType, sourceId, content } = params;

  // Create mention record
  await prisma.personMention.create({
    data: {
      personId,
      userId,
      sourceType,
      sourceId,
      context: content.substring(0, 200), // Store first 200 chars for context
      sentiment: sentiment ?? null,
    },
  });

  // Update mention counts on person
  await updateMentionCount(personId, sourceType);
}

async function updatePersonMention(personId: string, params: ExtractionParams, sentiment: number | undefined): Promise<void> {
  const { userId, sourceType, sourceId, content } = params;

  // Create mention record
  await prisma.personMention.create({
    data: {
      personId,
      userId,
      sourceType,
      sourceId,
      context: content.substring(0, 200),
      sentiment: sentiment ?? null,
    },
  });

  // Update last mentioned and counts
  await updateMentionCount(personId, sourceType);

  await prisma.person.update({
    where: { id: personId },
    data: { lastMentioned: new Date() },
  });
}

async function updateMentionCount(personId: string, sourceType: MentionSourceType): Promise<void> {
  const countField = getCountFieldForSourceType(sourceType);
  if (countField) {
    await prisma.person.update({
      where: { id: personId },
      data: { [countField]: { increment: 1 } },
    });
  }
}

function getCountFieldForSourceType(sourceType: MentionSourceType): string | null {
  switch (sourceType) {
    case 'INNER_THOUGHTS':
      return 'mentionCountInnerThoughts';
    case 'GRATITUDE':
      return 'mentionCountGratitude';
    case 'NEEDS_CHECKIN':
      return 'mentionCountNeeds';
    case 'PARTNER_SESSION':
      return 'mentionCountConflict';
    default:
      return null;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Merge two people into one. All mentions from sourcePerson are
 * transferred to targetPerson, then sourcePerson is deleted.
 */
export async function mergePeople(sourcePersonId: string, targetPersonId: string): Promise<Person> {
  // Get both people
  const [source, target] = await Promise.all([
    prisma.person.findUnique({ where: { id: sourcePersonId } }),
    prisma.person.findUnique({ where: { id: targetPersonId } }),
  ]);

  if (!source || !target) {
    throw new Error('Person not found');
  }

  if (source.userId !== target.userId) {
    throw new Error('Cannot merge people from different users');
  }

  // Transfer all mentions to target
  await prisma.personMention.updateMany({
    where: { personId: sourcePersonId },
    data: { personId: targetPersonId },
  });

  // Merge aliases (add source name and aliases to target)
  const newAliases = [...new Set([...target.aliases, source.name, ...source.aliases])];

  // Combine mention counts
  const updatedTarget = await prisma.person.update({
    where: { id: targetPersonId },
    data: {
      aliases: newAliases,
      mentionCountInnerThoughts: target.mentionCountInnerThoughts + source.mentionCountInnerThoughts,
      mentionCountGratitude: target.mentionCountGratitude + source.mentionCountGratitude,
      mentionCountNeeds: target.mentionCountNeeds + source.mentionCountNeeds,
      mentionCountConflict: target.mentionCountConflict + source.mentionCountConflict,
      firstMentioned: source.firstMentioned < target.firstMentioned ? source.firstMentioned : target.firstMentioned,
      lastMentioned: source.lastMentioned > target.lastMentioned ? source.lastMentioned : target.lastMentioned,
    },
  });

  // Delete source person
  await prisma.person.delete({ where: { id: sourcePersonId } });

  return updatedTarget;
}
