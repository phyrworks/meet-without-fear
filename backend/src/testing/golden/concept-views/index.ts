/**
 * Golden harness — `old_concept_*` views.
 *
 * The goldens recorded byte-for-byte (`__golden__/<scenario>.json`) are shaped
 * like today's tables, so the data-layer rebuild reddens them wholesale on the
 * first rename. The concept views are the shape-independent oracle that
 * survives it: a SQL file the harness applies to each run database projects the
 * old tables into the target schema's participant-centred vocabulary
 * (`current-shape.sql`), and after the rebuild a target-shape file with the
 * same view names and column sets replaces it. The normalised baselines
 * (`__golden__/<scenario>.concept.json`) are recorded through these views and
 * compared under a per-scenario allow-list (`../allow-lists`), never
 * byte-for-byte.
 *
 * The views are harness-owned (TS-4 ruling R9): never a Prisma migration.
 *
 * `CONCEPT_VIEWS` is the shape-independent half of the contract: which views
 * exist, and per view the row identity (for diffs) and the natural ordering key
 * (views have no primary key, and Postgres gives no order without ORDER BY).
 * It belongs to the concept, not to either SQL file, so both files are checked
 * against it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DbTarget, withClient } from '../db';
import { Snapshot, takeSnapshot } from '../snapshot';

export const CONCEPT_VIEW_PREFIX = 'old_concept_';
/** Views that list states the mapping cannot represent. Must be empty. */
export const CONCEPT_CHECK_PREFIX = 'concept_check_';

export const CURRENT_SHAPE_SQL = path.join(__dirname, 'current-shape.sql');

export interface ConceptViewSpec {
  /** Columns that identify one row — the diff key. Must be unique per row. */
  identity: string[];
  /** Natural ordering for snapshots; `identity` is appended as the tiebreak. */
  orderBy: string[];
}

/**
 * Every concept view, by target table name.
 *
 * Identity is the target's primary key: `id` for entity tables (kept across the
 * rebuild for renamed tables, minted for new ones — see `current-shape.sql`'s
 * header), the composite key for junctions.
 */
export const CONCEPT_VIEWS = {
  user: { identity: ['id'], orderBy: ['email'] },
  session: { identity: ['id'], orderBy: ['created_at'] },
  participant: { identity: ['id'], orderBy: ['session_id', 'user_id'] },
  conversation: { identity: ['id'], orderBy: ['participant_id', 'kind'] },
  participant_milestone: { identity: ['participant_id', 'milestone_key'], orderBy: [] },
  message: { identity: ['id'], orderBy: ['conversation_id', 'created_at'] },
  empathy_attempt: { identity: ['id'], orderBy: ['author_participant_id', 'subject_participant_id', 'round'] },
  empathy_review: { identity: ['id'], orderBy: ['attempt_id', 'reviewer_participant_id'] },
  reconciler_result: { identity: ['id'], orderBy: ['attempt_id', 'iteration'] },
  reconciler_guidance: { identity: ['result_id'], orderBy: [] },
  context_share_offer: { identity: ['id'], orderBy: ['attempt_id', 'iteration'] },
  draft: { identity: ['id'], orderBy: ['participant_id', 'kind'] },
  consent: { identity: ['id'], orderBy: ['participant_id', 'created_at'] },
  need: { identity: ['id'], orderBy: ['participant_id', 'created_at'] },
  need_share: { identity: ['need_id'], orderBy: [] },
  need_disposition: { identity: ['participant_id', 'need_id'], orderBy: [] },
  proposal: { identity: ['id'], orderBy: ['session_id', 'created_at'] },
  proposal_need: { identity: ['proposal_id', 'need_id'], orderBy: [] },
  proposal_choice: { identity: ['proposal_id', 'participant_id'], orderBy: [] },
  agreement: { identity: ['id'], orderBy: ['session_id', 'proposal_id'] },
  agreement_party: { identity: ['agreement_id', 'participant_id'], orderBy: [] },
  reflection: { identity: ['id'], orderBy: ['user_id', 'created_at'] },
  reflection_message: { identity: ['id'], orderBy: ['reflection_id', 'created_at'] },
  takeaway: { identity: ['id'], orderBy: ['reflection_id', 'position'] },
  takeaway_link: { identity: ['source_id', 'target_id'], orderBy: [] },
} as const satisfies Record<string, ConceptViewSpec>;

export type ConceptName = keyof typeof CONCEPT_VIEWS;
export const CONCEPT_NAMES = Object.keys(CONCEPT_VIEWS) as ConceptName[];

export function viewName(concept: ConceptName): string {
  return `${CONCEPT_VIEW_PREFIX}${concept}`;
}

export function conceptOf(view: string): ConceptName {
  const name = view.startsWith(CONCEPT_VIEW_PREFIX) ? view.slice(CONCEPT_VIEW_PREFIX.length) : view;
  if (!(name in CONCEPT_VIEWS)) throw new Error(`Not a concept view: ${view}`);
  return name as ConceptName;
}

/**
 * The view names a concept SQL file creates, read from its text. Used to hold
 * the file and `CONCEPT_VIEWS` to each other (unit test + `applyConceptViews`).
 */
export function viewsDefinedIn(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-z_][a-z0-9_]*)/gim)) {
    names.add(m[1].toLowerCase());
  }
  return [...names].sort();
}

/**
 * Apply a concept SQL file to a run database, in one transaction, and verify it
 * created exactly the declared views.
 *
 * Runs on a harness connection, which `withClient` mutes, so neither the DDL
 * nor any later snapshot of the views reaches the SQL trace.
 */
export async function applyConceptViews(
  target: DbTarget,
  database: string,
  sqlPath: string = CURRENT_SHAPE_SQL,
): Promise<void> {
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await withClient(
    target,
    async c => {
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Applying ${path.basename(sqlPath)} failed: ${(e as Error).message}`);
      }
      const r = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views
         WHERE table_schema = 'public' AND table_name LIKE '${CONCEPT_VIEW_PREFIX}%'`,
      );
      const created = new Set(r.rows.map(x => x.table_name));
      const declared = new Set(CONCEPT_NAMES.map(viewName));
      // `old_concept_*` helper views are not allowed: every one is a concept,
      // snapshotted and compared, or it is invisible to the oracle.
      const missing = [...declared].filter(v => !created.has(v));
      const extra = [...created].filter(v => !declared.has(v));
      if (missing.length || extra.length) {
        throw new Error(
          `${path.basename(sqlPath)} does not match CONCEPT_VIEWS.\n` +
            (missing.length ? `  declared but not created: ${missing.join(', ')}\n` : '') +
            (extra.length ? `  created but not declared: ${extra.join(', ')}\n` : ''),
        );
      }
    },
    database,
  );
}

/**
 * Snapshot every concept view, ordered by its natural key, and fail if any
 * `concept_check_*` view reports a state the mapping cannot represent.
 */
export async function takeConceptSnapshot(target: DbTarget, database: string): Promise<Snapshot> {
  await assertConceptChecksEmpty(target, database);
  const keys: Record<string, { identity: string[]; orderBy: string[] }> = {};
  for (const name of CONCEPT_NAMES) {
    const spec: ConceptViewSpec = CONCEPT_VIEWS[name];
    keys[viewName(name)] = { identity: [...spec.identity], orderBy: [...spec.orderBy] };
  }
  return takeSnapshot({ target, database, tables: CONCEPT_NAMES.map(viewName), keys });
}

async function assertConceptChecksEmpty(target: DbTarget, database: string): Promise<void> {
  const problems = await withClient(
    target,
    async c => {
      const views = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views
         WHERE table_schema = 'public' AND table_name LIKE '${CONCEPT_CHECK_PREFIX}%' ORDER BY 1`,
      );
      const out: string[] = [];
      for (const { table_name } of views.rows) {
        const r = await c.query(`SELECT * FROM "${table_name}"`);
        if (r.rows.length) out.push(`${table_name}: ${JSON.stringify(r.rows)}`);
      }
      return out;
    },
    database,
  );
  if (problems.length) {
    throw new Error(
      `The concept views cannot represent this database's state (a migration precheck would RAISE):\n  ` +
        problems.join('\n  '),
    );
  }
}
