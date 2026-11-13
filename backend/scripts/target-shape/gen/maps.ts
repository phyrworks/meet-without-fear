// ---------------------------------------------------------------------------
// Reference data and helpers for the target_shape_baseline generator
// (backend/scripts/gen-target-migration.ts). The data-move tables of TS-7/7b
// (old table/enum lists, gatesSatisfied key map, dropped-table lists) were
// removed with the data move (OD7, 2026-10-26); git history keeps them. The
// milestone seed moved into tables.sql, next to its table (work-k5fk.6).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function section(title: string, body: string): string {
  const bar = '-- ' + '='.repeat(76);
  return `${bar}\n-- ${title}\n${bar}\n\n${body.trim()}\n`;
}
