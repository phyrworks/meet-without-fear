/**
 * Cross-Feature Intelligence Service
 *
 * Gathers context from across all Inner Work features to enable
 * pattern recognition, contradiction detection, and insights.
 *
 * Target shape (TS-12): needs, gratitude, meditation and people are the
 * user's feature documents (spec §1.7), reduced in memory — the DISTINCT ON
 * over NeedScore is latestNeedScores. Active conflicts are the user's own
 * present participants; the partner is named by the user's nickname for them
 * or the co-participant's display name (never the partner's user row), and
 * the stage comes from the stage shim (v_current_stage).
 */

import { prisma } from '../lib/prisma';
import { readFeature } from './feature-state';
import { latestNeedScores } from './needs-reduction';
import { getCoParticipants } from './participant-resolver';
import { loadCurrentStages } from './stage-shim';
import { needById } from '@meet-without-fear/shared';
import {
  CrossFeatureContextDTO,
  ContradictionDTO,
  CorrelationDTO,
  GapDTO,
  GetCrossFeatureContextResponse,
} from '@meet-without-fear/shared';

// ============================================================================
// Types
// ============================================================================

interface NeedsContext {
  needsScores: { needId: number; name: string; score: number; lastUpdated: Date }[];
  lowNeeds: string[];
  highNeeds: string[];
}

interface GratitudeContext {
  recentGratitudeThemes: string[];
  gratitudeFrequencyByPerson: { name: string; count: number }[];
  gratitudeSentimentTrend: 'positive' | 'negative' | 'stable';
}

interface MeditationContext {
  meditationStreak: number;
  recentMeditationFocuses: string[];
  meditationFrequencyTrend: 'increasing' | 'decreasing' | 'stable';
}

interface ConflictContext {
  activeConflicts: { partnerName: string; stage: number; topic?: string }[];
  recentConflictThemes: string[];
}

interface PeopleContext {
  frequentlyMentioned: { name: string; contexts: string[] }[];
  rarelyMentionedInGratitude: string[];
}

// Helper: subtract days from a date
function subDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() - days);
  return result;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Gather cross-feature context for a user.
 * This data can be used in prompts to provide richer, more connected responses.
 */
export async function gatherCrossFeatureContext(
  userId: string,
  options?: { includePatterns?: boolean }
): Promise<GetCrossFeatureContextResponse> {
  // Parallel queries for efficiency
  const [needsData, gratitudeData, meditationData, conflictData, peopleData] = await Promise.all([
    fetchNeedsContext(userId),
    fetchGratitudeContext(userId),
    fetchMeditationContext(userId),
    fetchConflictContext(userId),
    fetchPeopleContext(userId),
  ]);

  const context: CrossFeatureContextDTO = {
    // Needs
    needsScores: needsData.needsScores.map((n) => ({
      needId: n.needId,
      name: n.name,
      score: n.score,
      lastUpdated: n.lastUpdated.toISOString(),
    })),
    lowNeeds: needsData.lowNeeds,
    highNeeds: needsData.highNeeds,

    // Gratitude
    recentGratitudeThemes: gratitudeData.recentGratitudeThemes,
    gratitudeFrequencyByPerson: gratitudeData.gratitudeFrequencyByPerson,
    gratitudeSentimentTrend: gratitudeData.gratitudeSentimentTrend,

    // Meditation
    meditationStreak: meditationData.meditationStreak,
    recentMeditationFocuses: meditationData.recentMeditationFocuses,
    meditationFrequencyTrend: meditationData.meditationFrequencyTrend,

    // Conflicts
    activeConflicts: conflictData.activeConflicts,
    recentConflictThemes: conflictData.recentConflictThemes,

    // People
    frequentlyMentioned: peopleData.frequentlyMentioned,
    rarelyMentionedInGratitude: peopleData.rarelyMentionedInGratitude,
  };

  // Patterns (more expensive to compute)
  let patterns: GetCrossFeatureContextResponse['patterns'] = {
    contradictions: [],
    correlations: [],
    gaps: [],
  };

  if (options?.includePatterns) {
    patterns = {
      contradictions: await detectContradictions(userId, context),
      correlations: await detectCorrelations(userId, context),
      gaps: await detectGaps(userId, context),
    };
  }

  return { context, patterns };
}

// ============================================================================
// Context Fetchers
// ============================================================================

async function fetchNeedsContext(userId: string): Promise<NeedsContext> {
  const needs = await readFeature(userId, 'needs_assessment');

  if (!needs.state.baselineCompleted) {
    return { needsScores: [], lowNeeds: [], highNeeds: [] };
  }

  // Latest score for each need (was a DISTINCT ON)
  const latestScores = latestNeedScores(needs.scores).map(s => ({
    needId: s.needId,
    name: needById(s.needId)?.name ?? `Need ${s.needId}`,
    score: s.score,
    lastUpdated: new Date(s.createdAt),
  }));

  return {
    needsScores: latestScores,
    lowNeeds: latestScores.filter((s) => s.score <= 1).map((s) => s.name),
    highNeeds: latestScores.filter((s) => s.score === 2).map((s) => s.name),
  };
}

async function fetchGratitudeContext(userId: string): Promise<GratitudeContext> {
  const thirtyDaysAgo = subDays(new Date(), 30);

  const entries = (await readFeature(userId, 'gratitude')).entries
    .filter((e) => new Date(e.createdAt) >= thirtyDaysAgo)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);

  // Aggregate themes
  const themeCounts = new Map<string, number>();
  entries.forEach((e) => {
    (e.extractedThemes as string[]).forEach((t) => {
      themeCounts.set(t, (themeCounts.get(t) || 0) + 1);
    });
  });

  // Aggregate people
  const personCounts = new Map<string, number>();
  entries.forEach((e) => {
    (e.extractedPeople as string[]).forEach((p) => {
      personCounts.set(p, (personCounts.get(p) || 0) + 1);
    });
  });

  // Calculate sentiment trend
  const sentiments = entries.filter((e) => e.sentimentScore !== null).map((e) => e.sentimentScore!);
  const avgSentiment = sentiments.length > 0 ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length : 0;

  return {
    recentGratitudeThemes: Array.from(themeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([theme]) => theme),
    gratitudeFrequencyByPerson: Array.from(personCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    gratitudeSentimentTrend: avgSentiment > 0.3 ? 'positive' : avgSentiment < -0.3 ? 'negative' : 'stable',
  };
}

async function fetchMeditationContext(userId: string): Promise<MeditationContext> {
  const meditation = await readFeature(userId, 'meditation');
  const stats = meditation.stats;

  const thirtyDaysAgo = subDays(new Date(), 30);
  const fifteenDaysAgo = subDays(new Date(), 15);

  // Get recent sessions for focus areas
  const recentSessions = meditation.sessions
    .filter((s) => s.completed && new Date(s.startedAt) >= thirtyDaysAgo)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20)
    .map((s) => ({ focusArea: s.focusArea, startedAt: new Date(s.startedAt) }));

  // Extract unique focus areas
  const focusAreas = [...new Set(recentSessions.filter((s) => s.focusArea).map((s) => s.focusArea!))];

  // Calculate frequency trend
  const recentCount = recentSessions.filter((s) => s.startedAt >= fifteenDaysAgo).length;
  const olderCount = recentSessions.filter((s) => s.startedAt < fifteenDaysAgo).length;
  const trend = recentCount > olderCount * 1.2 ? 'increasing' : recentCount < olderCount * 0.8 ? 'decreasing' : 'stable';

  return {
    meditationStreak: stats?.currentStreak ?? 0,
    recentMeditationFocuses: focusAreas.slice(0, 5),
    meditationFrequencyTrend: trend,
  };
}

async function fetchConflictContext(userId: string): Promise<ConflictContext> {
  // The user's present participants in live sessions
  const mine = await prisma.participant.findMany({
    where: { userId, leftAt: null, session: { status: { in: ['CREATED', 'INVITED', 'ACTIVE'] } } },
    select: {
      id: true,
      session: { select: { relationship: { select: { members: { where: { userId }, select: { nickname: true } } } } } },
    },
    take: 5,
  });

  if (mine.length === 0) {
    return { activeConflicts: [], recentConflictThemes: [] };
  }

  const stages = await loadCurrentStages(mine.map((p) => p.id));
  const activeConflicts: { partnerName: string; stage: number; topic?: string }[] = [];

  for (const p of mine) {
    const partner = (await getCoParticipants(p.id)).find((c) => c.kind === 'human' && !c.leftAt);
    const partnerName = p.session.relationship.members[0]?.nickname || partner?.displayName || 'Partner';

    activeConflicts.push({
      partnerName,
      stage: stages.get(p.id)?.stage || 1,
      topic: undefined, // Could extract from session data
    });
  }

  // Get recent session themes (could be extracted from messages)
  // For now, return empty - could be enhanced later
  const recentConflictThemes: string[] = [];

  return {
    activeConflicts,
    recentConflictThemes,
  };
}

async function fetchPeopleContext(userId: string): Promise<PeopleContext> {
  // Get frequently mentioned people
  const people = [...(await readFeature(userId, 'people')).persons]
    .sort(
      (a, b) =>
        b.mentionCountInnerThoughts - a.mentionCountInnerThoughts ||
        b.mentionCountGratitude - a.mentionCountGratitude ||
        b.mentionCountConflict - a.mentionCountConflict,
    )
    .slice(0, 10);

  const frequentlyMentioned = people.slice(0, 5).map((p) => ({
    name: p.name,
    contexts: getTopContexts(p),
  }));

  // Find people in conflicts but rarely in gratitude
  const rarelyMentionedInGratitude = people
    .filter((p) => p.mentionCountConflict > 0 && p.mentionCountGratitude < 2)
    .map((p) => p.name);

  return {
    frequentlyMentioned,
    rarelyMentionedInGratitude,
  };
}

function getTopContexts(person: {
  mentionCountInnerThoughts: number;
  mentionCountGratitude: number;
  mentionCountNeeds: number;
  mentionCountConflict: number;
}): string[] {
  const contexts: { name: string; count: number }[] = [
    { name: 'Inner Thoughts', count: person.mentionCountInnerThoughts },
    { name: 'Gratitude', count: person.mentionCountGratitude },
    { name: 'Needs', count: person.mentionCountNeeds },
    { name: 'Conflict', count: person.mentionCountConflict },
  ];

  return contexts
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((c) => c.name);
}

// ============================================================================
// Pattern Detection
// ============================================================================

async function detectContradictions(userId: string, context: CrossFeatureContextDTO): Promise<ContradictionDTO[]> {
  const contradictions: ContradictionDTO[] = [];

  // Check for high needs but negative patterns
  for (const need of context.needsScores.filter((n) => n.score === 2)) {
    // Look for this need in low mentions in gratitude or high in conflict
    const hasConflictMentions = context.frequentlyMentioned.some(
      (p) => p.contexts.includes('Conflict') && !p.contexts.includes('Gratitude')
    );

    if (hasConflictMentions && ['trust', 'respect', 'connection', 'belonging'].includes(need.name.toLowerCase())) {
      contradictions.push({
        type: 'needs_vs_behavior',
        needId: need.needId,
        needName: need.name,
        description: `${need.name} is marked as fully met, but there are ongoing conflicts that might relate to this need`,
        evidence: ['Active conflicts without corresponding gratitude patterns'],
        confidence: 0.6,
      });
    }
  }

  // Check gratitude patterns vs partner conflicts
  for (const conflict of context.activeConflicts) {
    const gratitudeCount =
      context.gratitudeFrequencyByPerson.find((p) =>
        p.name.toLowerCase().includes(conflict.partnerName.toLowerCase())
      )?.count || 0;

    if (gratitudeCount < 2 && context.gratitudeFrequencyByPerson.length > 3) {
      contradictions.push({
        type: 'stated_vs_observed',
        description: `Rarely expresses gratitude about ${conflict.partnerName} despite ongoing relationship work`,
        evidence: [`${gratitudeCount} gratitudes about ${conflict.partnerName} in 30 days`],
        confidence: 0.7,
      });
    }
  }

  return contradictions;
}

async function detectCorrelations(userId: string, context: CrossFeatureContextDTO): Promise<CorrelationDTO[]> {
  const correlations: CorrelationDTO[] = [];

  // Meditation frequency vs conflict occurrence
  if (context.meditationFrequencyTrend === 'decreasing' && context.activeConflicts.length > 0) {
    correlations.push({
      type: 'meditation_conflict',
      description: 'Meditation practice has decreased while conflicts are active',
      dataPoints: [
        { x: 'Meditation', y: 'decreasing' },
        { x: 'Active Conflicts', y: String(context.activeConflicts.length) },
      ],
      strength: 0.6,
    });
  }

  // Gratitude themes connecting to high needs
  const needThemeMapping: Record<string, string[]> = {
    connection: ['friends', 'family', 'togetherness', 'relationships'],
    nature: ['nature', 'outdoors', 'environment', 'beauty'],
    growth: ['learning', 'achievement', 'progress', 'development'],
    peace: ['calm', 'quiet', 'rest', 'relaxation'],
    creativity: ['art', 'music', 'creation', 'expression'],
  };

  for (const highNeed of context.highNeeds) {
    const themes = needThemeMapping[highNeed.toLowerCase()] || [];
    const matchingThemes = context.recentGratitudeThemes.filter((t) =>
      themes.some((theme) => t.toLowerCase().includes(theme))
    );

    if (matchingThemes.length >= 2) {
      correlations.push({
        type: 'gratitude_needs',
        description: `Gratitude themes (${matchingThemes.join(', ')}) connect to ${highNeed} being well met`,
        dataPoints: matchingThemes.map((t) => ({ x: t, y: highNeed })),
        strength: matchingThemes.length / 5,
      });
    }
  }

  return correlations;
}

async function detectGaps(userId: string, context: CrossFeatureContextDTO): Promise<GapDTO[]> {
  const gaps: GapDTO[] = [];
  const twoWeeksAgo = subDays(new Date(), 14);

  // Partner with conflicts but no gratitude
  for (const conflict of context.activeConflicts) {
    const hasGratitude = context.gratitudeFrequencyByPerson.some((p) =>
      p.name.toLowerCase().includes(conflict.partnerName.toLowerCase())
    );

    if (!hasGratitude) {
      gaps.push({
        type: 'missing_gratitude',
        description: `No gratitudes expressed about ${conflict.partnerName}`,
        suggestion: `Consider: is there anything you appreciate about ${conflict.partnerName}, even amid the difficulty?`,
      });
    }
  }

  // Low need without recent check-in
  for (const need of context.needsScores.filter((n) => n.score <= 1)) {
    const lastUpdated = new Date(need.lastUpdated);
    if (lastUpdated < twoWeeksAgo) {
      gaps.push({
        type: 'missing_checkin',
        description: `${need.name} scored low but hasn't been checked in 2+ weeks`,
        suggestion: `Would you like to check in on how ${need.name} is feeling?`,
      });
    }
  }

  // No meditation with active conflicts
  if (context.meditationStreak === 0 && context.activeConflicts.length > 0) {
    gaps.push({
      type: 'missing_meditation',
      description: 'No recent meditation practice during active conflict work',
      suggestion: 'A brief meditation might help with emotional regulation during this challenging time',
    });
  }

  return gaps;
}

// ============================================================================
// Prompt Building Helper
// ============================================================================

/**
 * Format cross-feature context for inclusion in AI prompts.
 * Returns a condensed string suitable for system prompts.
 */
export function formatCrossFeatureContextForPrompt(response: GetCrossFeatureContextResponse): string {
  const { context, patterns } = response;
  const sections: string[] = [];

  // Needs landscape
  if (context.needsScores.length > 0) {
    sections.push(`NEEDS LANDSCAPE:
- Low (struggling): ${context.lowNeeds.join(', ') || 'None'}
- High (thriving): ${context.highNeeds.join(', ') || 'None'}`);
  }

  // Gratitude themes
  if (context.recentGratitudeThemes.length > 0) {
    sections.push(`RECENT GRATITUDE THEMES: ${context.recentGratitudeThemes.join(', ')}`);
  }

  // Meditation state
  if (context.meditationStreak > 0 || context.recentMeditationFocuses.length > 0) {
    sections.push(`MEDITATION:
- Current streak: ${context.meditationStreak} days
- Recent focuses: ${context.recentMeditationFocuses.join(', ') || 'None'}
- Trend: ${context.meditationFrequencyTrend}`);
  }

  // Active conflicts
  if (context.activeConflicts.length > 0) {
    sections.push(`ACTIVE CONFLICTS:
${context.activeConflicts.map((c) => `- Working through something with ${c.partnerName} (Stage ${c.stage})`).join('\n')}`);
  }

  // Key people
  if (context.frequentlyMentioned.length > 0) {
    sections.push(`KEY PEOPLE:
${context.frequentlyMentioned.map((p) => `- ${p.name} (mentioned in: ${p.contexts.join(', ')})`).join('\n')}`);
  }

  // Detected patterns (use carefully)
  if (patterns.contradictions.length > 0) {
    sections.push(`PATTERNS TO POTENTIALLY EXPLORE (use judgment on when to surface):
${patterns.contradictions.map((c) => `- ${c.description}`).join('\n')}`);
  }

  if (patterns.gaps.length > 0) {
    sections.push(`GAPS TO CONSIDER:
${patterns.gaps.map((g) => `- ${g.suggestion}`).join('\n')}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `
---
CROSS-FEATURE CONTEXT:
${sections.join('\n\n')}

Use this context to:
- Notice connections between what user says and their needs
- Gently surface patterns when appropriate
- Recognize when gratitude themes or conflicts are relevant
- Do NOT dump all this context on the user - weave it in naturally
---`;
}
