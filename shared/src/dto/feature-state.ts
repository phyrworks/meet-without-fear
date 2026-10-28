/**
 * Wellbeing feature documents — one `feature_state(user_id, feature, doc)`
 * row per feature per user (spec §1.7 feature_state, assumption A-Q4; TS-12).
 *
 * One zod contract per feature. The documents mirror the old tables row for
 * row (the DTOs map from them unchanged); instants are ISO 8601 strings. A
 * document is parsed with its schema on every read and validated before every
 * write, so a missing key takes its default (an empty `{}` document is a new
 * user's state) and a malformed write never reaches the database.
 *
 * Shapes (spec §1.7):
 *   meditation        sessions[], scripts[] (SavedMeditation), preferences, stats
 *                     — plus favorites[] (MeditationFavorite), which the spec's
 *                     key list omits but the Absorbs line names
 *   gratitude         entries[], preferences
 *   needs_assessment  scores[], state
 *   people            persons[] with mentions[]
 */

import { z } from 'zod';

/** The CHECK on feature_state.feature. */
export const FEATURES = ['meditation', 'gratitude', 'needs_assessment', 'people'] as const;
export type Feature = (typeof FEATURES)[number];

const iso = z.string().datetime({ offset: true });
const isoOrNull = iso.nullable();

// ============================================================================
// meditation (MeditationSession, SavedMeditation, MeditationFavorite,
// MeditationPreferences, MeditationStats)
// ============================================================================

export const meditationSessionDocSchema = z.object({
  id: z.string(),
  type: z.enum(['GUIDED', 'UNGUIDED']),
  durationMinutes: z.number().int(),
  focusArea: z.string().nullable(),
  completed: z.boolean(),
  startedAt: iso,
  completedAt: isoOrNull,
  scriptGenerated: z.string().nullable(),
  voiceId: z.string().nullable(),
  backgroundSound: z.string().nullable(),
  savedAsFavorite: z.boolean(),
  favoriteType: z.enum(['EXACT', 'THEME']).nullable(),
  postNotes: z.string().nullable(),
});

export const savedMeditationDocSchema = z.object({
  id: z.string(),
  title: z.string(),
  script: z.string(),
  durationSeconds: z.number().int(),
  conversationId: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const meditationFavoriteDocSchema = z.object({
  id: z.string(),
  name: z.string(),
  focusArea: z.string(),
  durationMinutes: z.number().int(),
  favoriteType: z.enum(['EXACT', 'THEME']),
  script: z.string().nullable(),
  savedAt: iso,
});

export const MEDITATION_PREFERENCE_DEFAULTS = {
  preferredVoice: 'default',
  voiceSpeed: 1.0,
  defaultDuration: 10,
  backgroundSound: 'silence',
  reminderEnabled: false,
  reminderTime: null,
};

export const meditationPreferencesDocSchema = z.object({
  preferredVoice: z.string().default(MEDITATION_PREFERENCE_DEFAULTS.preferredVoice),
  voiceSpeed: z.number().default(MEDITATION_PREFERENCE_DEFAULTS.voiceSpeed),
  defaultDuration: z.number().int().default(MEDITATION_PREFERENCE_DEFAULTS.defaultDuration),
  backgroundSound: z.string().default(MEDITATION_PREFERENCE_DEFAULTS.backgroundSound),
  reminderEnabled: z.boolean().default(MEDITATION_PREFERENCE_DEFAULTS.reminderEnabled),
  reminderTime: z.string().nullable().default(null),
});

export const meditationStatsDocSchema = z.object({
  totalSessions: z.number().int().default(0),
  guidedCount: z.number().int().default(0),
  unguidedCount: z.number().int().default(0),
  totalMinutes: z.number().int().default(0),
  currentStreak: z.number().int().default(0),
  longestStreak: z.number().int().default(0),
  streakStartDate: isoOrNull.default(null),
  lastSessionDate: isoOrNull.default(null),
  /** focus area → completed-session count */
  favoriteFocusAreas: z.record(z.string(), z.number()).default({}),
});

export const meditationDocSchema = z.object({
  sessions: z.array(meditationSessionDocSchema).default([]),
  scripts: z.array(savedMeditationDocSchema).default([]),
  favorites: z.array(meditationFavoriteDocSchema).default([]),
  preferences: meditationPreferencesDocSchema.default(() => meditationPreferencesDocSchema.parse({})),
  stats: meditationStatsDocSchema.default(() => meditationStatsDocSchema.parse({})),
});

// ============================================================================
// gratitude (GratitudeEntry, GratitudePreferences)
// ============================================================================

export const gratitudeEntryDocSchema = z.object({
  id: z.string(),
  content: z.string(),
  voiceRecorded: z.boolean(),
  createdAt: iso,
  extractedPeople: z.array(z.string()).default([]),
  extractedPlaces: z.array(z.string()).default([]),
  extractedActivities: z.array(z.string()).default([]),
  extractedEmotions: z.array(z.string()).default([]),
  extractedThemes: z.array(z.string()).default([]),
  linkedNeedIds: z.array(z.number().int()).default([]),
  linkedConflictId: z.string().nullable().default(null),
  sentimentScore: z.number().nullable().default(null),
  aiResponse: z.string().nullable().default(null),
});

export const gratitudePreferencesDocSchema = z.object({
  enabled: z.boolean().default(true),
  frequency: z.number().int().default(1),
  preferredTimes: z.array(z.string()).default(['20:00']),
  weekdayOnly: z.boolean().default(false),
  quietHoursStart: z.string().nullable().default(null),
  quietHoursEnd: z.string().nullable().default(null),
});

export const gratitudeDocSchema = z.object({
  entries: z.array(gratitudeEntryDocSchema).default([]),
  preferences: gratitudePreferencesDocSchema.default(() => gratitudePreferencesDocSchema.parse({})),
});

// ============================================================================
// needs_assessment (NeedScore, NeedsAssessmentState; the Need taxonomy is
// shared/src/constants/needs.ts)
// ============================================================================

export const needScoreDocSchema = z.object({
  id: z.string(),
  needId: z.number().int().min(1).max(19),
  /** 0 = not met, 1 = somewhat met, 2 = fully met */
  score: z.number().int().min(0).max(2),
  clarification: z.string().nullable(),
  createdAt: iso,
});

export const needsAssessmentStateDocSchema = z.object({
  baselineCompleted: z.boolean().default(false),
  baselineCompletedAt: isoOrNull.default(null),
  checkInFrequencyDays: z.number().int().default(7),
  lastCheckInNeedId: z.number().int().nullable().default(null),
  lastCheckInAt: isoOrNull.default(null),
  nextCheckInAt: isoOrNull.default(null),
});

export const needsAssessmentDocSchema = z.object({
  scores: z.array(needScoreDocSchema).default([]),
  state: needsAssessmentStateDocSchema.default(() => needsAssessmentStateDocSchema.parse({})),
});

// ============================================================================
// people (Person, PersonMention)
// ============================================================================

export const personMentionDocSchema = z.object({
  id: z.string(),
  sourceType: z.enum(['INNER_THOUGHTS', 'GRATITUDE', 'NEEDS_CHECKIN', 'PARTNER_SESSION']),
  sourceId: z.string(),
  context: z.string().nullable(),
  sentiment: z.number().nullable(),
  createdAt: iso,
});

export const personDocSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  relationship: z.string().nullable().default(null),
  firstMentioned: iso,
  lastMentioned: iso,
  mentionCountInnerThoughts: z.number().int().default(0),
  mentionCountGratitude: z.number().int().default(0),
  mentionCountNeeds: z.number().int().default(0),
  mentionCountConflict: z.number().int().default(0),
  /** need name → count */
  needsConnections: z.record(z.string(), z.number()).default({}),
  mentions: z.array(personMentionDocSchema).default([]),
});

export const peopleDocSchema = z.object({
  persons: z.array(personDocSchema).default([]),
});

// ============================================================================
// The registry
// ============================================================================

export const FEATURE_DOC_SCHEMAS = {
  meditation: meditationDocSchema,
  gratitude: gratitudeDocSchema,
  needs_assessment: needsAssessmentDocSchema,
  people: peopleDocSchema,
} as const;

export type MeditationDoc = z.infer<typeof meditationDocSchema>;
export type MeditationSessionDoc = z.infer<typeof meditationSessionDocSchema>;
export type SavedMeditationDoc = z.infer<typeof savedMeditationDocSchema>;
export type MeditationFavoriteDoc = z.infer<typeof meditationFavoriteDocSchema>;
export type GratitudeDoc = z.infer<typeof gratitudeDocSchema>;
export type GratitudeEntryDoc = z.infer<typeof gratitudeEntryDocSchema>;
export type NeedsAssessmentDoc = z.infer<typeof needsAssessmentDocSchema>;
export type NeedScoreDoc = z.infer<typeof needScoreDocSchema>;
export type PeopleDoc = z.infer<typeof peopleDocSchema>;
export type PersonDoc = z.infer<typeof personDocSchema>;
export type PersonMentionDoc = z.infer<typeof personMentionDocSchema>;

export interface FeatureDocs {
  meditation: MeditationDoc;
  gratitude: GratitudeDoc;
  needs_assessment: NeedsAssessmentDoc;
  people: PeopleDoc;
}

/** Parse a stored document (or `{}` for none) into its full shape; throws on a malformed document. */
export function parseFeatureDoc<F extends Feature>(feature: F, raw: unknown): FeatureDocs[F] {
  return FEATURE_DOC_SCHEMAS[feature].parse(raw ?? {}) as FeatureDocs[F];
}
