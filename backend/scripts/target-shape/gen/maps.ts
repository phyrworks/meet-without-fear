// ---------------------------------------------------------------------------
// Reference data and helpers for the target_shape_baseline generator
// (backend/scripts/gen-target-migration.ts). The data-move tables of TS-7/7b
// (old table/enum lists, gatesSatisfied key map, dropped-table lists) were
// removed with the data move (OD7, 2026-10-26); git history keeps them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// milestone seed (spec §1.1 milestone; keys from the fixture vocabulary
// scenario-model.ts MILESTONE_KEYS). ordinal = stage * 100 + position, in
// today's stage order, so floor(ordinal / 100) is the old stage number;
// `paused` is off the journey (ordinal 0, ignored by v_current_stage).
// stage_label = shared/src/enums.ts STAGE_FRIENDLY_NAMES (spec example "Your Story").
// self_assertable per spec §1.1 participant_milestone RLS; scope 'session' for
// the milestones every participant must reach before the session advances.
// ---------------------------------------------------------------------------

export const MILESTONES: Array<[key: string, ordinal: number, label: string, scope: 'participant' | 'session', selfAssertable: boolean]> = [
  ['paused', 0, 'Paused', 'participant', false],
  ['invitation_sent', 10, 'Getting Started', 'participant', false],
  ['compact_signed', 20, 'Getting Started', 'session', true],
  ['feel_heard', 110, 'Your Story', 'participant', true],
  ['empathy_submitted', 210, 'Walking in Their Shoes', 'participant', false],
  ['empathy_ready', 220, 'Walking in Their Shoes', 'participant', false],
  ['empathy_validated', 230, 'Walking in Their Shoes', 'session', false],
  ['needs_confirmed', 310, 'What Matters Most', 'participant', true],
  ['needs_validated', 320, 'What Matters Most', 'session', false],
  ['needs_shared', 330, 'What Matters Most', 'session', false],
  ['repair_walkthrough_started', 410, 'What Comes Next', 'participant', false],
  ['choices_shared', 420, 'What Comes Next', 'session', true],
  ['closed', 430, 'What Comes Next', 'session', false],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function section(title: string, body: string): string {
  const bar = '-- ' + '='.repeat(76);
  return `${bar}\n-- ${title}\n${bar}\n\n${body.trim()}\n`;
}

export function milestoneSeed(): string {
  const rows = MILESTONES.map(([k, o, l, s, a]) => `  (${lit(k)}, ${o}, ${lit(l)}, ${lit(s)}, ${a})`).join(',\n');
  return `INSERT INTO milestone (key, ordinal, stage_label, scope, self_assertable) VALUES\n${rows};`;
}
