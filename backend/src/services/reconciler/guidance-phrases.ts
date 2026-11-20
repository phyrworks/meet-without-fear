/**
 * The reconciler's abstract guidance (reconciler_guidance), stored as labels and carried as phrases
 * (work-k5fk.9, Q4). The database holds the area as a guidance_area label and the guidance_type; the
 * prompts and the wire (refinementHint) carry the phrases below, and the prompt seed is derived from the
 * type, never stored. Pure: no imports, so any reader can use it.
 */

/** The abstract hints the author may see (reconciler_guidance). */
export interface AbstractGuidance {
  areaHint: string | null;
  guidanceType: string | null;
  promptSeed: string | null;
}

/** The guidance_type enum (reconciler_guidance.guidance_type). */
export type GuidanceType = 'challenge_assumptions' | 'explore_breadth' | 'explore_deeper_feelings';

/**
 * The guidance_area enum (reconciler_guidance.area_hint, work-k5fk.9 Q4) and the phrase each label stands for:
 * the database stores the label, the prompts and the wire carry the phrase.
 */
export const GUIDANCE_AREA_PHRASES = {
  work_effort: 'work and effort',
  connection_closeness: 'connection and closeness',
  safety_security: 'safety and security',
  heard_understood: 'being heard and understood',
  respect_value: 'respect and value',
  deeper_emotions: 'deeper emotional experiences',
} as const;
export type GuidanceArea = keyof typeof GUIDANCE_AREA_PHRASES;

/** The refinement prompt's seed phrase: a pure function of guidance_type, so it is derived, never stored (Q4). */
const PROMPT_SEEDS: Record<GuidanceType, string> = {
  challenge_assumptions: 'what might be different from your initial understanding',
  explore_breadth: 'other aspects of their experience',
  explore_deeper_feelings: 'what might be underneath the surface',
};

/** The guidance_area label of an area phrase (generateAbstractGuidance's), or null for any other text. */
export function guidanceAreaOf(phrase: string | null): GuidanceArea | null {
  if (phrase === null) return null;
  const hit = (Object.keys(GUIDANCE_AREA_PHRASES) as GuidanceArea[]).find(k => GUIDANCE_AREA_PHRASES[k] === phrase);
  return hit ?? null;
}

/** A stored guidance row (area label, type) as the phrases the prompts and the DTOs carry. */
export function guidancePhrases(row: { areaHint: GuidanceArea | null; guidanceType: GuidanceType | null }): AbstractGuidance {
  return {
    areaHint: row.areaHint ? GUIDANCE_AREA_PHRASES[row.areaHint] : null,
    guidanceType: row.guidanceType,
    promptSeed: row.guidanceType ? PROMPT_SEEDS[row.guidanceType] : null,
  };
}
