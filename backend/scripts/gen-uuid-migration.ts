/**
 * Generator for the `cuid_to_uuidv7` migration.
 *
 *   cd backend
 *   DATABASE_URL=postgresql://…/<db at the pre-conversion schema> \
 *     npx tsx scripts/gen-uuid-migration.ts prisma/migrations/<ts>_cuid_to_uuidv7/migration.sql
 *
 * It reads the catalog of a database that is at the migration *before* this
 * one (an empty database is fine — only the catalog is read, never rows) and
 * emits a static, reviewable SQL file. Nothing in the emitted file inspects the
 * catalog at deploy time: what the owner reviewed is what runs.
 *
 * Catalog-derived (so nothing can drift from the real schema):
 *   - the converted tables: every public table whose primary key is `id text`
 *   - the column whose time becomes each new id's uuidv7 timestamp
 *   - every foreign key that references a converted table, with its exact
 *     definition from pg_get_constraintdef (name, columns, ON DELETE/UPDATE)
 *   - the row-count list (every public table except _prisma_migrations)
 *
 * Hand-declared below, because the catalog cannot know them. Each entry names
 * the production writer that proves what the column holds:
 *   - ARRAY_COLUMNS: text[] columns of ids, converted to uuid[]
 *   - SOFT_REFS: text columns holding one id, with no foreign key; stay text
 *   - EMBEDDED: text columns with ids inside a larger string; stay text
 *   - CUSTOM: JSON documents and composite keys, as hand-written SQL
 *
 * The generator refuses to run against a database that is already converted.
 */

import * as fs from 'fs';
import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Hand-declared id-bearing columns the catalog cannot see
// ---------------------------------------------------------------------------

/** Ids in `Stage4NeedCoverage`-derived lists are `row.needId ?? row.id` (services/stage4-state.ts:347). */
const NEED_SPACES = ['IdentifiedNeed', 'Stage4NeedCoverage'];

interface ArrayColumn {
  table: string;
  column: string;
  /** Tables an element may be an id of. Old ids are globally unique (asserted), so a set is unambiguous. */
  references: string[];
  writer: string;
}

/** text[] columns of ids. Converted to uuid[] in place; every element must resolve, order is kept. */
const ARRAY_COLUMNS: ArrayColumn[] = [
  { table: 'Stage4Closure', column: 'individualProposalIds', references: ['StrategyProposal'], writer: 'controllers/stage4.ts:1469' },
  { table: 'Stage4Closure', column: 'openNeedIds', references: NEED_SPACES, writer: 'controllers/stage4.ts:1470 (row.needId ?? row.id)' },
  { table: 'Stage4Closure', column: 'sharedAgreementIds', references: ['Agreement'], writer: 'controllers/stage4.ts:1468' },
  { table: 'Stage4NeedCoverage', column: 'coveringProposalIds', references: ['StrategyProposal'], writer: 'services/stage4-coverage.service.ts:231' },
  { table: 'StrategyRanking', column: 'rankedIds', references: ['StrategyProposal'], writer: 'controllers/stage4.ts:1861' },
  { table: 'TendingCoordinationCycle', column: 'entryIds', references: ['TendingEntry'], writer: 'services/tending.service.ts:1064' },
  { table: 'TendingCoordinationCycle', column: 'participantUserIds', references: ['User'], writer: 'services/tending.service.ts:1065' },
  { table: 'TendingCoordinationCycle', column: 'submittedUserIds', references: ['User'], writer: 'services/tending.service.ts:1066, 1089' },
];

interface SoftRef {
  table: string;
  column: string;
  /** Tables the value may be an id of; `null` = any converted table (polymorphic). */
  references: string[] | null;
  writer: string;
}

/**
 * text columns that hold exactly one id but have no foreign key. They stay
 * `text` (the schema change is scoped to relation fields and id arrays) but
 * their values are rewritten, or each would dangle silently. A value with no
 * mapping is left unchanged and counted in a NOTICE: these columns were never
 * constrained, so a dangling or non-id value may legitimately predate this.
 */
const SOFT_REFS: SoftRef[] = [
  { table: 'ConsentRecord', column: 'targetId', references: ['EmpathyDraft', 'IdentifiedNeed'], writer: 'controllers/stage2.ts:682, stage3.ts:762' },
  { table: 'GratitudeEntry', column: 'linkedConflictId', references: ['Session'], writer: 'none (never written)' },
  { table: 'MeditationSession', column: 'linkedConflictId', references: ['Session'], writer: 'none (never written)' },
  { table: 'Message', column: 'forUserId', references: ['User'], writer: 'controllers/stage2.ts, stage3.ts (user/partner ids)' },
  { table: 'PersonMention', column: 'sourceId', references: null, writer: 'services/people-extractor.ts:241 (by sourceType)' },
  { table: 'PersonMention', column: 'userId', references: ['User'], writer: 'services/people-extractor.ts:249' },
  { table: 'PreSessionMessage', column: 'associatedSessionId', references: ['Session'], writer: 'none today; existing rows' },
  { table: 'PreSessionMessage', column: 'userId', references: ['User'], writer: 'none today; existing rows' },
  { table: 'ReconcilerResult', column: 'guesserId', references: ['User'], writer: 'services/reconciler/analysis.ts:547' },
  { table: 'ReconcilerResult', column: 'subjectId', references: ['User'], writer: 'services/reconciler/analysis.ts:552' },
  { table: 'ReconcilerShareOffer', column: 'userId', references: ['User'], writer: 'services/reconciler/sharing.ts:575, 1349' },
  { table: 'SavedMeditation', column: 'conversationId', references: ['InnerWorkSession'], writer: 'controllers/meditation.ts:998 (client string)' },
  { table: 'Stage4Closure', column: 'closedByUserId', references: ['User'], writer: 'controllers/stage4.ts:1471' },
  { table: 'Stage4NeedCoverage', column: 'needId', references: ['IdentifiedNeed'], writer: 'services/stage4-coverage.service.ts:227' },
  { table: 'Stage4NeedCoverage', column: 'sourceUserId', references: ['User'], writer: 'services/stage4-coverage.service.ts:229' },
  { table: 'Stage4NeedDeclination', column: 'needId', references: NEED_SPACES, writer: 'controllers/stage4.ts:1108 (client; either space)' },
  { table: 'Stage4NeedDeclination', column: 'userId', references: ['User'], writer: 'controllers/stage4.ts:1111' },
  { table: 'Stage4ProposalRevision', column: 'actorUserId', references: ['User'], writer: 'services/stage4-capture.service.ts, controllers/stage4.ts:1433' },
  { table: 'Stage4ProposalRevision', column: 'messageId', references: ['Message'], writer: 'services/stage4-capture.service.ts:113' },
  { table: 'Stage4ProposalRevision', column: 'sessionId', references: ['Session'], writer: 'services/stage4-capture.service.ts:649' },
  { table: 'Stage4SubChat', column: 'anchorId', references: [...NEED_SPACES, 'StrategyProposal'], writer: 'services/stage4-subchat.service.ts:195 (client)' },
  { table: 'StrategyProposal', column: 'capturedFromMessageId', references: ['Message'], writer: 'services/stage4-capture.service.ts:726' },
  { table: 'StrategyProposal', column: 'parentProposalId', references: ['StrategyProposal'], writer: 'none (always null)' },
  { table: 'TendingEntry', column: 'ownerUserId', references: ['User'], writer: 'services/tending.service.ts:374' },
  { table: 'TendingNeedOutcome', column: 'needId', references: NEED_SPACES, writer: 'services/tending.service.ts:1202 (client; either space)' },
  { table: 'TendingNeedOutcome', column: 'sourceUserId', references: ['User'], writer: 'controllers/tending.ts:74 (client)' },
];

interface Embedded {
  table: string;
  column: string;
  holds: string;
}

/**
 * text columns with ids inside a larger string. Every cuid-shaped token that
 * is an old id of any converted table is replaced; everything else is kept.
 */
const EMBEDDED: Embedded[] = [
  { table: 'RefinementAttemptCounter', column: 'direction', holds: '`${guesserId}->${subjectId}`, rebuilt as a lookup key (services/reconciler/circuit-breaker.ts:23, 46)' },
  { table: 'TendingCoordinationCycle', column: 'resultSummary', holds: '"Missing participant(s): <userIds>" on timeout (services/tending.service.ts:1622)' },
  { table: 'User', column: 'clerkId', holds: '`e2e_${userId}` from the E2E auth bypass (dev/e2e databases only; production holds Clerk ids)' },
  { table: 'UserVessel', column: 'lastSeenChatItemId', holds: 'a Message id, or a client chat-item id like `context-shared-${messageId}` (controllers/sessions.ts:1091)' },
];

interface Custom {
  table: string;
  column: string;
  holds: string;
  sql: string;
}

const CUSTOM: Custom[] = [
  {
    table: 'StageProgress',
    column: 'gatesSatisfied',
    holds:
      'stage4Walkthrough.{currentNeedId, coveredNeedIds[], skippedNeedIds[]}, need ids in either space ' +
      '(controllers/stage4.ts:501, services/stream-turn-actions.ts:243). No other gate key holds an id.',
    sql: `
UPDATE "StageProgress"
SET "gatesSatisfied" = jsonb_set(
  "gatesSatisfied", '{stage4Walkthrough}',
  "_jsonb_map_keys"("gatesSatisfied" -> 'stage4Walkthrough',
                    ARRAY['currentNeedId', 'coveredNeedIds', 'skippedNeedIds'],
                    ARRAY['IdentifiedNeed', 'Stage4NeedCoverage']))
WHERE jsonb_typeof("gatesSatisfied" -> 'stage4Walkthrough') = 'object';`,
  },
  {
    table: 'Stage4ProposalRevision',
    column: 'before, after',
    holds:
      'proposal snapshots: agreementId (Agreement), removedByUserId (User), and needsAddressed, which is need ' +
      'labels but tolerated as ids by its readers, so any element that is a need id is mapped too ' +
      '(controllers/stage4.ts:1429, services/stage4-capture.service.ts:600)',
    sql: `
UPDATE "Stage4ProposalRevision"
SET "before" = "_jsonb_map_keys"("_jsonb_map_keys"("_jsonb_map_keys"("before",
                 ARRAY['agreementId'], ARRAY['Agreement']),
                 ARRAY['removedByUserId'], ARRAY['User']),
                 ARRAY['needsAddressed'], ARRAY['IdentifiedNeed', 'Stage4NeedCoverage']),
    "after"  = "_jsonb_map_keys"("_jsonb_map_keys"("_jsonb_map_keys"("after",
                 ARRAY['agreementId'], ARRAY['Agreement']),
                 ARRAY['removedByUserId'], ARRAY['User']),
                 ARRAY['needsAddressed'], ARRAY['IdentifiedNeed', 'Stage4NeedCoverage'])
WHERE jsonb_typeof("before") = 'object' OR jsonb_typeof("after") = 'object';`,
  },
  {
    table: 'StrategyProposal',
    column: 'needsAddressed',
    holds:
      'need LABELS (services/stage-tools.ts:100 tells the model "never use internal IDs"); readers also match ' +
      'elements against need ids (services/stage4-coverage.service.ts:156), so an element that is a need id is ' +
      'mapped and every label is kept. Stays text[].',
    sql: `
UPDATE "StrategyProposal"
SET "needsAddressed" = ARRAY(
  SELECT "_uuid_text_or_keep"(ARRAY['IdentifiedNeed', 'Stage4NeedCoverage'], e)
  FROM unnest("needsAddressed") WITH ORDINALITY AS u(e, ord) ORDER BY ord)
WHERE "needsAddressed" && (SELECT array_agg(old_id) FROM "_id_map"
                           WHERE table_name IN ('IdentifiedNeed', 'Stage4NeedCoverage'));`,
  },
  {
    table: 'TendingCoordinationCycle',
    column: 'coordinationKey',
    holds:
      '`${sessionId}:${[...entryIds].sort().join("|")}`, a lookup key (services/tending.service.ts:40). Rebuilt ' +
      'from its own parts: mapping in place would keep the OLD sort order, and the app re-derives the key with ' +
      'JavaScript sort (UTF-16 code units = COLLATE "C" for hex and "-").',
    sql: `
UPDATE "TendingCoordinationCycle"
SET "coordinationKey" =
  "_uuid_text_or_keep"(ARRAY['Session'], split_part("coordinationKey", ':', 1)) || ':' ||
  coalesce((SELECT string_agg(k, '|' ORDER BY k COLLATE "C")
            FROM (SELECT "_uuid_text_or_keep"(ARRAY['TendingEntry'], e) AS k
                  FROM unnest(string_to_array(substr("coordinationKey", strpos("coordinationKey", ':') + 1), '|')) AS e
                  WHERE e <> '') s), '')
WHERE "coordinationKey" LIKE '%:%';`,
  },
];

/**
 * Columns deliberately NOT rewritten, recorded so the decision is reviewable.
 * (Printed into the migration header.)
 */
const LEFT_ALONE = [
  'BrainActivity.input/output/metadata/structuredOutput: an LLM call log. input.userId (services/context-retriever.ts:593) is the only structured id; it is telemetry, never read back as a reference.',
  'BrainActivity.turnId: a log correlation string (`${sessionId}-${n}`, `${sessionId}-${Date.now()}`, randomUUID, literals); nothing parses it.',
  'UserVessel.notableFacts[].id: fact-local randomUUID()s (services/partner-session-classifier.ts:71), not entity ids.',
  'User.*Preferences, User.globalFacts, Person.needsConnections, MeditationStats.favoriteFocusAreas, Insight.data, ConsentRecord.metadata, StrategyProposal.coverageSummary: no ids (audited writers).',
  'MeditationSession.voiceId: a TTS voice name.',
];

/** Tables where the catalog rule below picks no column or the wrong one. */
const TIME_COLUMN_OVERRIDES: Record<string, { column: string; reason: string }> = {
  // Two NOT NULL DEFAULT CURRENT_TIMESTAMP columns; lastMentioned moves on every mention.
  Person: { column: 'firstMentioned', reason: 'set once at creation; lastMentioned moves' },
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface TableInfo {
  name: string;
  /** Column whose value becomes the uuidv7 timestamp, or null for plain uuidv7(). */
  timeColumn: string | null;
  timeReason: string;
}

interface ForeignKey {
  name: string;
  table: string;
  column: string;
  references: string;
  definition: string;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const litArr = (xs: string[] | null) => (xs ? `ARRAY[${xs.map(lit).join(', ')}]` : 'NULL');

async function readCatalog(client: Client) {
  const alreadyUuid = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'id' AND data_type = 'uuid'`);
  if (alreadyUuid.rowCount) {
    throw new Error('This database already has uuid id columns; point the generator at the pre-conversion schema.');
  }

  const converted = await client.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_constraint k
    JOIN pg_class c      ON c.oid = k.conrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
    WHERE n.nspname = 'public' AND k.contype = 'p'
      AND array_length(k.conkey, 1) = 1 AND a.attname = 'id'
      AND a.atttypid = 'text'::regtype
    ORDER BY c.relname`);

  // Creation-time column per table. Preference: an override, createdAt, then
  // timestamp, then the one NOT NULL timestamp column defaulting to
  // CURRENT_TIMESTAMP (Prisma `@default(now())`: the table's creation time under
  // another name — joinedAt, sharedAt, submittedAt, ...).
  const cols = await client.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
    ORDER BY table_name, ordinal_position`);

  const tables: TableInfo[] = converted.rows.map(({ table_name }) => {
    const tcols = cols.rows.filter((c) => c.table_name === table_name);
    const byName = (n: string) => tcols.find((c) => c.column_name === n);
    const override = TIME_COLUMN_OVERRIDES[table_name];
    if (override) {
      if (!byName(override.column)) throw new Error(`override column missing: ${table_name}.${override.column}`);
      return { name: table_name, timeColumn: override.column, timeReason: `"${override.column}" (${override.reason})` };
    }
    const created = byName('createdAt') ?? byName('timestamp');
    if (created) {
      if (created.is_nullable !== 'NO') throw new Error(`${table_name}.${created.column_name} is nullable`);
      return { name: table_name, timeColumn: created.column_name, timeReason: `"${created.column_name}"` };
    }
    const defaulted = tcols.filter(
      (c) => c.is_nullable === 'NO' && /CURRENT_TIMESTAMP|now\(\)/i.test(c.column_default ?? '') && c.column_name !== 'updatedAt',
    );
    if (defaulted.length === 1) {
      return {
        name: table_name,
        timeColumn: defaulted[0].column_name,
        timeReason: `"${defaulted[0].column_name}" (NOT NULL DEFAULT CURRENT_TIMESTAMP; no createdAt)`,
      };
    }
    return { name: table_name, timeColumn: null, timeReason: 'no creation-time column, so plain uuidv7() in old-id order' };
  });

  const fks = await client.query<ForeignKey>(`
    SELECT k.conname AS name, c.relname AS table, a.attname AS column,
           r.relname AS references, pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k
    JOIN pg_class c      ON c.oid = k.conrelid
    JOIN pg_class r      ON r.oid = k.confrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
    WHERE n.nspname = 'public' AND k.contype = 'f'
      AND r.relname = ANY($1::text[])
    ORDER BY c.relname, k.conname`, [tables.map((t) => t.name)]);
  for (const fk of fks.rows) {
    if (!/^FOREIGN KEY \("[^"]+"\) REFERENCES "[^"]+"\(id\)/.test(fk.definition)) {
      throw new Error(`Unexpected FK shape (expected single column -> id): ${fk.name}: ${fk.definition}`);
    }
  }

  // Every hand-declared column must exist with the type the SQL assumes.
  const declared = [
    ...ARRAY_COLUMNS.map((a) => ({ ...a, type: 'ARRAY' })),
    ...SOFT_REFS.map((s) => ({ ...s, type: 'text' })),
    ...EMBEDDED.map((e) => ({ ...e, type: 'text' })),
  ];
  for (const d of declared) {
    const r = await client.query<{ data_type: string; udt_name: string }>(
      `SELECT data_type, udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [d.table, d.column]);
    const row = r.rows[0];
    if (!row) throw new Error(`declared column missing: ${d.table}.${d.column}`);
    const ok = d.type === 'ARRAY' ? row.udt_name === '_text' : row.data_type === 'text';
    if (!ok) throw new Error(`declared column ${d.table}.${d.column} is ${row.data_type}/${row.udt_name}, expected ${d.type}`);
    if (fks.rows.some((f) => f.table === d.table && f.column === d.column)) {
      throw new Error(`declared column ${d.table}.${d.column} has a foreign key; it is converted by the catalog pass`);
    }
  }

  const all = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name`);

  return { tables, fks: fks.rows, allTables: all.rows.map((r) => r.table_name) };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function section(title: string, body: string[]): string {
  const bar = '-- ' + '='.repeat(76);
  return [bar, `-- ${title}`, bar, '', ...body, ''].join('\n');
}

const HELPERS = `CREATE TABLE "_id_map" (
  table_name text NOT NULL,
  old_id     text NOT NULL,
  new_id     uuid NOT NULL UNIQUE,
  PRIMARY KEY (table_name, old_id)
);
CREATE INDEX "_id_map_old_id_idx" ON "_id_map" (old_id);

CREATE TABLE "_row_counts" (
  table_name text PRIMARY KEY,
  n          bigint NOT NULL
);

-- The new id of row p_old in table p_table. NULL in, NULL out (STRICT).
-- A non-null id that maps to nothing is an error, never a silent NULL.
CREATE FUNCTION "_uuid_for"(p_table text, p_old text) RETURNS uuid
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  v uuid;
BEGIN
  SELECT new_id INTO v FROM "_id_map" WHERE table_name = p_table AND old_id = p_old;
  IF v IS NULL THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: no % row has id %', p_table, p_old;
  END IF;
  RETURN v;
END $$;

-- Element-wise lookup for id arrays: each element must be an id of one of
-- p_tables (old ids are globally unique, so at most one matches). Order and
-- NULL elements are kept; an unmapped element is an error.
CREATE FUNCTION "_uuids_for"(p_tables text[], p_old text[]) RETURNS uuid[]
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  e   text;
  v   uuid;
  out uuid[] := '{}';
BEGIN
  FOREACH e IN ARRAY p_old LOOP
    IF e IS NULL THEN
      out := out || NULL::uuid;
      CONTINUE;
    END IF;
    SELECT new_id INTO v FROM "_id_map" WHERE table_name = ANY (p_tables) AND old_id = e;
    IF v IS NULL THEN
      RAISE EXCEPTION 'cuid_to_uuidv7: array element % is not an id of %', e, p_tables;
    END IF;
    out := out || v;
  END LOOP;
  RETURN out;
END $$;

-- For unconstrained text: the new id (as text) if p_old is an old id of one of
-- p_tables (of any converted table when p_tables is NULL), else p_old as it was.
-- Never raises: these values were never constrained.
CREATE FUNCTION "_uuid_text_or_keep"(p_tables text[], p_old text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT new_id::text FROM "_id_map"
      WHERE old_id = p_old AND (p_tables IS NULL OR table_name = ANY (p_tables))),
    p_old)
$$;

-- Replace every cuid-shaped token in p_text that is an old id of any converted
-- table; leave all other text alone.
CREATE FUNCTION "_rewrite_embedded_ids"(p_text text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tok text;
  out text := p_text;
BEGIN
  IF p_text IS NULL THEN
    RETURN NULL;
  END IF;
  FOR tok IN SELECT DISTINCT m[1] FROM regexp_matches(p_text, '(?<![a-z0-9])(c[a-z0-9]{24})(?![a-z0-9])', 'g') AS m LOOP
    -- tok is [a-z0-9] only, so it is safe inside the pattern.
    out := regexp_replace(out, '(?<![a-z0-9])' || tok || '(?![a-z0-9])', "_uuid_text_or_keep"(NULL, tok), 'g');
  END LOOP;
  RETURN out;
END $$;

-- In a JSON object, map the value of each key in p_keys: a string that is an
-- old id of one of p_tables becomes the new id; an array has each such string
-- element mapped. Anything else, and any key that is absent, is left exactly as
-- it was. A non-object document is returned unchanged.
CREATE FUNCTION "_jsonb_map_keys"(p_doc jsonb, p_keys text[], p_tables text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  k   text;
  v   jsonb;
  out jsonb := p_doc;
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'object' THEN
    RETURN p_doc;
  END IF;
  FOREACH k IN ARRAY p_keys LOOP
    CONTINUE WHEN NOT (out ? k);
    v := out -> k;
    IF jsonb_typeof(v) = 'string' THEN
      out := jsonb_set(out, ARRAY[k], to_jsonb("_uuid_text_or_keep"(p_tables, v #>> '{}')));
    ELSIF jsonb_typeof(v) = 'array' THEN
      out := jsonb_set(out, ARRAY[k], (
        SELECT coalesce(jsonb_agg(
                 CASE WHEN jsonb_typeof(x) = 'string'
                      THEN to_jsonb("_uuid_text_or_keep"(p_tables, x #>> '{}'))
                      ELSE x END ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(v) WITH ORDINALITY AS a(x, ord)));
    END IF;
  END LOOP;
  RETURN out;
END $$;

-- RAISE unless every non-null value of p_table.p_col is an id of p_ref.
CREATE FUNCTION "_assert_mapped"(p_table text, p_col text, p_ref text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE format(
    'SELECT count(*) FROM %I t WHERE t.%I IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "_id_map" m WHERE m.table_name = %L AND m.old_id = t.%I)',
    p_table, p_col, p_ref, p_col) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: %.% has % value(s) that are not % ids', p_table, p_col, n, p_ref;
  END IF;
END $$;

-- RAISE unless every non-null element of the array p_table.p_col is an id of one of p_refs.
CREATE FUNCTION "_assert_array_mapped"(p_table text, p_col text, p_refs text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE format(
    'SELECT count(*) FROM %I t, unnest(t.%I) AS e WHERE e IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "_id_map" m WHERE m.table_name = ANY (%L::text[]) AND m.old_id = e)',
    p_table, p_col, p_refs) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: %.% has % element(s) that are not ids of %', p_table, p_col, n, p_refs;
  END IF;
END $$;

-- RAISE unless every row of p_table has exactly one mapping.
CREATE FUNCTION "_assert_fully_mapped"(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n_rows bigint;
  n_map  bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I', p_table) INTO n_rows;
  SELECT count(*) INTO n_map FROM "_id_map" WHERE table_name = p_table;
  IF n_rows <> n_map THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: % has % rows but % mappings', p_table, n_rows, n_map;
  END IF;
END $$;

-- RAISE unless p_table has exactly the row count recorded in _row_counts.
CREATE FUNCTION "_assert_row_count"(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  before bigint;
  after  bigint;
BEGIN
  SELECT n INTO before FROM "_row_counts" WHERE table_name = p_table;
  EXECUTE format('SELECT count(*) FROM %I', p_table) INTO after;
  IF before IS DISTINCT FROM after THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: % had % rows before, % after', p_table, before, after;
  END IF;
END $$;`;

function emit(cat: Awaited<ReturnType<typeof readCatalog>>): string {
  const { tables, fks, allTables } = cat;
  const converted = new Set(tables.map((t) => t.name));
  const refsOk = (xs: string[] | null) => (xs ?? []).every((x) => converted.has(x));
  for (const a of ARRAY_COLUMNS) if (!refsOk(a.references)) throw new Error(`array target not converted: ${a.references}`);
  for (const s of SOFT_REFS) if (!refsOk(s.references)) throw new Error(`soft-ref target not converted: ${s.references}`);

  const out: string[] = [];

  out.push(`-- cuid_to_uuidv7
--
-- Converts every cuid primary key to a database-minted UUIDv7 in a native uuid
-- column, and every reference to those keys with it:
--   ${tables.length} primary keys, ${fks.length} foreign-key columns, ${ARRAY_COLUMNS.length} id arrays (text[] -> uuid[]),
--   ${SOFT_REFS.length} unconstrained id columns and ${EMBEDDED.length} with embedded ids (stay text, values rewritten),
--   ${CUSTOM.length} JSON documents / composite keys (hand-written SQL in section 6b).
--
-- GENERATED by backend/scripts/gen-uuid-migration.ts from the catalog of a
-- database at the previous migration. Do not hand-edit: change the generator,
-- regenerate, and review the diff. Verification: backend/scripts/verify-uuid-migration.sql.
--
-- How it works
--   1. Helpers, and _id_map(table_name, old_id, new_id).
--   2. Row counts of every table are recorded.
--   3. _id_map gets one row per existing row of every converted table:
--      new_id = uuidv7(<creation time> - clock_timestamp()), so the uuid's
--      embedded time is the row's original creation time and ids sort in
--      creation order.
--   4. Assertions, before anything is altered: every table fully mapped, no old
--      id in two tables, every non-null foreign-key value and id-array element
--      is an id of the table it points at.
--   5. Foreign keys referencing converted tables are dropped.
--   6. One ALTER TABLE per table changes id, foreign-key and id-array columns to
--      uuid / uuid[] in place, USING a lookup that raises on an unmapped value.
--      An in-place type change keeps each column's position and has Postgres
--      rebuild the primary key, unique constraints and indexes on it under their
--      existing names and definitions, so no index DDL is copied by hand.
--      id gets DEFAULT uuidv7(): the database mints ids from now on.
--   6b. Unconstrained id columns, embedded ids, JSON documents and composite
--      keys are rewritten.
--   7. Foreign keys are re-added from their exact pg_get_constraintdef text
--      (same names, same ON DELETE / ON UPDATE). Adding one validates every row.
--   8. Assertions after: row counts unchanged; every id is one minted here.
--   9. Helpers and _id_map are dropped.
--
-- Prisma runs a migration file in one transaction: any RAISE aborts it and
-- leaves the database exactly as it was. There is no COMMIT in this file.
--
-- Audited and deliberately left alone:
${LEFT_ALONE.map((l) => `--   - ${l}`).join('\n')}
`);

  // --- 1. helpers -------------------------------------------------------------
  out.push(section('1. Mapping table and helpers (all dropped in section 9)', [HELPERS]));

  // --- 2. row counts ------------------------------------------------------------
  out.push(section(`2. Row counts before (all ${allTables.length} tables; checked again in section 8)`, [
    `INSERT INTO "_row_counts" (table_name, n) VALUES\n` +
      allTables.map((t) => `  (${lit(t)}, (SELECT count(*) FROM ${q(t)}))`).join(',\n') + ';',
  ]));

  // --- 3. mint --------------------------------------------------------------------
  const mint: string[] = [
    `-- One INSERT per table. uuidv7(interval) shifts the clock by the interval, so`,
    `-- uuidv7(t - clock_timestamp()) embeds time t. Prisma's timestamp(3) columns`,
    `-- hold UTC without a zone; AT TIME ZONE 'UTC' reads them as such whatever the`,
    `-- session TimeZone is. Rows are minted in creation order, ties by old id.`,
    '',
  ];
  for (const t of tables) {
    mint.push(`-- ${t.name}: time from ${t.timeReason}`);
    if (t.timeColumn) {
      mint.push(
        `INSERT INTO "_id_map" (table_name, old_id, new_id)`,
        `SELECT ${lit(t.name)}, id, uuidv7((${q(t.timeColumn)} AT TIME ZONE 'UTC') - clock_timestamp())`,
        `FROM ${q(t.name)} ORDER BY ${q(t.timeColumn)}, id;`,
      );
    } else {
      mint.push(
        `INSERT INTO "_id_map" (table_name, old_id, new_id)`,
        `SELECT ${lit(t.name)}, id, uuidv7()`,
        `FROM ${q(t.name)} ORDER BY id;`,
      );
    }
    mint.push('');
  }
  out.push(section(`3. Mint new ids (${tables.length} tables)`, mint));

  // --- 4. assertions before ---------------------------------------------------------
  out.push(section('4. Assertions before any change', [
    '-- Every row of every converted table has exactly one mapping.',
    ...tables.map((t) => `SELECT "_assert_fully_mapped"(${lit(t.name)});`),
    '',
    '-- cuids are globally unique, which the multi-table and any-table lookups',
    '-- (arrays, section 6b) rely on. Prove it rather than assume it.',
    `DO $$
DECLARE
  dup text;
BEGIN
  SELECT old_id INTO dup FROM "_id_map" GROUP BY old_id HAVING count(*) > 1 LIMIT 1;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: old id % is the id of rows in more than one table', dup;
  END IF;
END $$;`,
    '',
    `-- Every non-null foreign-key value is an id of the referenced table (${fks.length}).`,
    ...fks.map((f) => `SELECT "_assert_mapped"(${lit(f.table)}, ${lit(f.column)}, ${lit(f.references)});`),
    '',
    `-- Every id-array element is an id of a table it may point at (${ARRAY_COLUMNS.length}).`,
    ...ARRAY_COLUMNS.map((a) => `SELECT "_assert_array_mapped"(${lit(a.table)}, ${lit(a.column)}, ${litArr(a.references)});`),
  ]));

  // --- 5. drop FKs ----------------------------------------------------------------
  out.push(section(`5. Drop the ${fks.length} foreign keys that reference converted tables (re-added in section 7)`,
    fks.map((f) => `ALTER TABLE ${q(f.table)} DROP CONSTRAINT ${q(f.name)};`)));

  // --- 6. convert ------------------------------------------------------------------
  const conv: string[] = [];
  const fkByTable = new Map<string, ForeignKey[]>();
  for (const f of fks) fkByTable.set(f.table, [...(fkByTable.get(f.table) ?? []), f]);
  const arraysByTable = new Map<string, ArrayColumn[]>();
  for (const a of ARRAY_COLUMNS) arraysByTable.set(a.table, [...(arraysByTable.get(a.table) ?? []), a]);
  const touched = [...new Set([...tables.map((t) => t.name), ...fkByTable.keys(), ...arraysByTable.keys()])].sort();
  for (const name of touched) {
    const clauses: string[] = [];
    if (converted.has(name)) {
      clauses.push(`  ALTER COLUMN "id" TYPE uuid USING "_uuid_for"(${lit(name)}, "id")`);
      clauses.push(`  ALTER COLUMN "id" SET DEFAULT uuidv7()`);
    }
    for (const f of fkByTable.get(name) ?? []) {
      clauses.push(`  ALTER COLUMN ${q(f.column)} TYPE uuid USING "_uuid_for"(${lit(f.references)}, ${q(f.column)})`);
    }
    for (const a of arraysByTable.get(name) ?? []) {
      clauses.push(`  ALTER COLUMN ${q(a.column)} TYPE uuid[] USING "_uuids_for"(${litArr(a.references)}, ${q(a.column)})`);
    }
    conv.push(`-- ${name}`, `ALTER TABLE ${q(name)}`, clauses.join(',\n') + ';', '');
  }
  out.push(section(`6. Convert id, foreign-key and id-array columns in place (${touched.length} tables)`, conv));

  // --- 6b. soft refs, embedded, custom -----------------------------------------------
  const soft: string[] = [
    `-- Unconstrained id columns (${SOFT_REFS.length}). Stay text; a value that is an old id of a`,
    `-- listed table becomes the new id, anything else is kept and reported below.`,
    '',
  ];
  for (const s of SOFT_REFS) {
    soft.push(
      `-- ${s.table}.${s.column} -> ${s.references ? s.references.join(' | ') : 'any converted table (polymorphic by sourceType)'}. Writer: ${s.writer}`,
      `UPDATE ${q(s.table)} SET ${q(s.column)} = "_uuid_text_or_keep"(${litArr(s.references)}, ${q(s.column)})`,
      `WHERE ${q(s.column)} IS NOT NULL;`,
      '',
    );
  }
  soft.push(`-- Report, without failing, any unconstrained value that matched no id.
DO $$
DECLARE
  r record;
  n bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES
${SOFT_REFS.map((s) => `    (${lit(s.table)}, ${lit(s.column)})`).join(',\n')}
  ) AS v(t, c) LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''',
      r.t, r.c, r.c) INTO n;
    IF n > 0 THEN
      RAISE NOTICE 'cuid_to_uuidv7: %.% kept % value(s) that are not ids of any row', r.t, r.c, n;
    END IF;
  END LOOP;
END $$;`, '');

  soft.push(`-- Embedded ids (${EMBEDDED.length}). Every cuid-shaped token that is an old id is replaced.`, '');
  for (const e of EMBEDDED) {
    soft.push(
      `-- ${e.table}.${e.column}: ${e.holds}`,
      `UPDATE ${q(e.table)} SET ${q(e.column)} = "_rewrite_embedded_ids"(${q(e.column)})`,
      `WHERE ${q(e.column)} ~ 'c[a-z0-9]{24}';`,
      '',
    );
  }

  soft.push(`-- JSON documents and composite keys (${CUSTOM.length}).`, '');
  for (const c of CUSTOM) {
    soft.push(`-- ${c.table}.${c.column}: ${c.holds}`, c.sql.trim(), '');
  }
  out.push(section('6b. Rewrite ids held outside foreign keys', soft));

  // --- 7. re-add FKs ------------------------------------------------------------------
  out.push(section(`7. Re-add the ${fks.length} foreign keys exactly as they were (validates every row)`,
    fks.map((f) => `ALTER TABLE ${q(f.table)} ADD CONSTRAINT ${q(f.name)} ${f.definition};`)));

  // --- 8. assertions after --------------------------------------------------------------
  out.push(section('8. Assertions after', [
    '-- Row counts unchanged, every table.',
    ...allTables.map((t) => `SELECT "_assert_row_count"(${lit(t)});`),
    '',
    '-- Every id is one this migration minted for that table.',
    `DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
${tables.map((t) => `    ${lit(t.name)}`).join(',\n')}
  ] LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE NOT EXISTS (SELECT 1 FROM "_id_map" m WHERE m.table_name = %L AND m.new_id = x.id)',
      t, t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'cuid_to_uuidv7: % has % id(s) this migration did not mint', t, n;
    END IF;
  END LOOP;
END $$;`,
  ]));

  // --- 9. cleanup -------------------------------------------------------------------------
  out.push(section('9. Drop helpers and the mapping', [
    `DROP FUNCTION "_assert_row_count"(text);
DROP FUNCTION "_assert_fully_mapped"(text);
DROP FUNCTION "_assert_array_mapped"(text, text, text[]);
DROP FUNCTION "_assert_mapped"(text, text, text);
DROP FUNCTION "_jsonb_map_keys"(jsonb, text[], text[]);
DROP FUNCTION "_rewrite_embedded_ids"(text);
DROP FUNCTION "_uuid_text_or_keep"(text[], text);
DROP FUNCTION "_uuids_for"(text[], text[]);
DROP FUNCTION "_uuid_for"(text, text);
DROP TABLE "_row_counts";
DROP TABLE "_id_map";`,
  ]));

  return out.join('\n');
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('Usage: gen-uuid-migration.ts <output migration.sql>');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to a database at the pre-conversion schema.');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const cat = await readCatalog(client);
    fs.writeFileSync(outPath, emit(cat));
    process.stderr.write(
      `wrote ${outPath}: ${cat.tables.length} tables, ${cat.fks.length} FKs, ${ARRAY_COLUMNS.length} arrays, ` +
        `${SOFT_REFS.length} soft refs, ${EMBEDDED.length} embedded, ${CUSTOM.length} custom\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
