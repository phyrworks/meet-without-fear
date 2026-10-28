/**
 * People Extractor Service
 *
 * Extracts mentions of people from user content and tracks them
 * for cross-feature intelligence.
 *
 * Target shape (TS-12): people and their mentions live in the user's `people`
 * feature document (persons[] with mentions[]); every change is one
 * read-modify-write under the row lock (services/feature-state.ts), so a
 * mention recorded from two features at once is never lost.
 */

import { BrainCallType as BrainActivityCallType } from '../generated/prisma/client';
import type { PersonDoc, PeopleDoc, PersonMentionDoc } from '@meet-without-fear/shared';
import { logger } from '../lib/logger';
import { readFeature, updateFeature, newEntryId } from './feature-state';
import { getHaikuJson } from '../lib/bedrock';
import { NotFoundError } from '../middleware/errors';
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

type MentionSourceType = PersonMentionDoc['sourceType'];
type Person = PersonDoc;

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
  const existingPeople = providedPeople || (await readFeature(userId, 'people')).persons;

  // Determine session ID for cost tracking
  const sessionId = sourceType === 'PARTNER_SESSION' || sourceType === 'INNER_THOUGHTS' ? sourceId : undefined;

  // Extract names using AI
  const extracted = await extractNamesWithAI(content, existingPeople, sessionId);

  if (!extracted || extracted.names.length === 0) {
    return { people: [], newPeople: [] };
  }

  // Apply every mention in one locked document write. Matching runs against
  // the document as locked (a person another writer just added is matched,
  // not duplicated); the AI's ids refer to the list it was shown.
  return updateFeature(userId, 'people', doc => {
    const results: ExtractionResult = { people: [], newPeople: [] };
    for (const name of extracted.names) {
      const normalizedName = normalizeName(name);

      // Check if AI already matched to existing
      const matchedId = extracted.matchedToExisting[name];
      const aiMatch = matchedId ? doc.persons.find(p => p.id === matchedId) : undefined;
      const match = aiMatch ?? findMatchingPerson(normalizedName, doc.persons);
      if (match) {
        recordMention(match, params, extracted.sentiment[name], true);
        results.people.push(match.name);
      } else {
        // Create new person
        const relationship = extracted.relationships[name] || null;
        const newPerson = createPerson(doc, normalizedName, relationship);
        recordMention(newPerson, params, extracted.sentiment[name], false);
        results.newPeople.push(newPerson.name);
        results.people.push(newPerson.name);
      }
    }
    return results;
  });
}

// ============================================================================
// AI Extraction
// ============================================================================

async function extractNamesWithAI(
  content: string,
  existingPeople: Person[],
  sessionId?: string,
): Promise<ExtractedPeople | null> {
  const existingPeopleList =
    existingPeople.length > 0
      ? existingPeople
          .map(
            p =>
              `- ${p.name} (id: ${p.id})${p.aliases.length ? ` [aliases: ${p.aliases.join(', ')}]` : ''}${p.relationship ? ` [${p.relationship}]` : ''}`,
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
  const exactMatch = existingPeople.find(p => p.name.toLowerCase() === normalized);
  if (exactMatch) return exactMatch;

  // Alias match
  const aliasMatch = existingPeople.find(p => p.aliases.some(a => a.toLowerCase() === normalized));
  if (aliasMatch) return aliasMatch;

  // Partial match (first name only, but only if unique)
  const firstName = normalized.split(' ')[0];
  if (firstName.length >= 3) {
    const partialMatches = existingPeople.filter(p => p.name.toLowerCase().split(' ')[0] === firstName);
    if (partialMatches.length === 1) {
      return partialMatches[0];
    }
  }

  return null;
}

// ============================================================================
// Document operations (inside the caller's locked read-modify-write)
// ============================================================================

function createPerson(doc: PeopleDoc, name: string, relationship: string | null): Person {
  const now = new Date().toISOString();
  const person: Person = {
    id: newEntryId(),
    name,
    aliases: [],
    relationship,
    firstMentioned: now,
    lastMentioned: now,
    mentionCountInnerThoughts: 0,
    mentionCountGratitude: 0,
    mentionCountNeeds: 0,
    mentionCountConflict: 0,
    needsConnections: {},
    mentions: [],
  };
  doc.persons.push(person);
  return person;
}

/** One mention: the record (first 200 chars as context), the count, and — for a known person — lastMentioned. */
function recordMention(person: Person, params: ExtractionParams, sentiment: number | undefined, known: boolean): void {
  const { sourceType, sourceId, content } = params;
  const now = new Date().toISOString();
  person.mentions.push({
    id: newEntryId(),
    sourceType,
    sourceId,
    context: content.substring(0, 200), // Store first 200 chars for context
    sentiment: sentiment ?? null,
    createdAt: now,
  });
  switch (sourceType) {
    case 'INNER_THOUGHTS':
      person.mentionCountInnerThoughts += 1;
      break;
    case 'GRATITUDE':
      person.mentionCountGratitude += 1;
      break;
    case 'NEEDS_CHECKIN':
      person.mentionCountNeeds += 1;
      break;
    case 'PARTNER_SESSION':
      person.mentionCountConflict += 1;
      break;
  }
  if (known) person.lastMentioned = now;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Merge two of the user's people into one. All mentions from sourcePerson are
 * transferred to targetPerson, then sourcePerson is deleted — one document
 * write. Throws NOT FOUND (as the old "Person not found") when either is not
 * the user's.
 */
export async function mergePeople(
  userId: string,
  sourcePersonId: string,
  targetPersonId: string,
): Promise<{ person: Person; mergedCount: number }> {
  return updateFeature(userId, 'people', doc => {
    const source = doc.persons.find(p => p.id === sourcePersonId);
    const target = doc.persons.find(p => p.id === targetPersonId);
    if (!target) throw new NotFoundError('Target person not found');
    if (!source) throw new NotFoundError('Source person not found');

    const mergedCount = source.mentions.length;
    target.mentions.push(...source.mentions);
    // Merge aliases (add source name and aliases to target)
    target.aliases = [...new Set([...target.aliases, source.name, ...source.aliases])];
    // Combine mention counts
    target.mentionCountInnerThoughts += source.mentionCountInnerThoughts;
    target.mentionCountGratitude += source.mentionCountGratitude;
    target.mentionCountNeeds += source.mentionCountNeeds;
    target.mentionCountConflict += source.mentionCountConflict;
    target.firstMentioned =
      source.firstMentioned < target.firstMentioned ? source.firstMentioned : target.firstMentioned;
    target.lastMentioned = source.lastMentioned > target.lastMentioned ? source.lastMentioned : target.lastMentioned;
    // Delete source person
    doc.persons.splice(doc.persons.indexOf(source), 1);
    return { person: { ...target }, mergedCount };
  });
}
