-- Verification for the cuid_to_uuidv7 migration.
--
-- Two phases against the same database, with the migration in between:
--
--   psql "$URL" -v phase=before -f scripts/verify-uuid-migration.sql
--   DATABASE_URL="$URL" npx prisma migrate deploy
--   psql "$URL" -v phase=after  -f scripts/verify-uuid-migration.sql
--
-- `before` snapshots facts into schema uuid_verify (the migration only touches
-- public). `after` compares, prints a report, RAISEs if any hard check fails
-- (psql exits non-zero), and drops uuid_verify. Use it on a scratch database
-- or a restored production backup; never on production itself.
--
-- The central check is identity, not just counts: every row is rendered with
-- each id it holds replaced by a hash of the *content* of the row that id
-- names (a row's non-id columns). If any foreign key, array element, soft
-- reference, embedded id or JSON id now names a different row, or nothing, the
-- multiset of renderings changes and the column is reported.

\set ON_ERROR_STOP on
\pset footer off

\if :{?phase}
\else
  \echo 'usage: psql "$URL" -v phase=before|after -f scripts/verify-uuid-migration.sql'
  \quit
\endif

SELECT :'phase' = 'before' AS is_before, :'phase' = 'after' AS is_after \gset

\if :is_before
-- ==========================================================================
-- BEFORE
-- ==========================================================================
DROP SCHEMA IF EXISTS uuid_verify CASCADE;
CREATE SCHEMA uuid_verify;

-- Tables keyed by `id` (text now, uuid after).
CREATE TABLE uuid_verify.keyed AS
SELECT c.relname AS tbl
FROM pg_constraint k
JOIN pg_class c ON c.oid = k.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
WHERE n.nspname = 'public' AND k.contype = 'p' AND array_length(k.conkey, 1) = 1
  AND a.attname = 'id' AND a.atttypid = 'text'::regtype;

CREATE TABLE uuid_verify.row_counts (tbl text PRIMARY KEY, n bigint);
DO $$
DECLARE t text; n bigint;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    INSERT INTO uuid_verify.row_counts VALUES (t, n);
  END LOOP;
END $$;

-- Constraints and indexes on every public table, by name, with definitions.
CREATE TABLE uuid_verify.constraints_before AS
SELECT c.relname AS tbl, k.conname, k.contype::text, pg_get_constraintdef(k.oid) AS def
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public';
CREATE TABLE uuid_verify.indexes_before AS
SELECT tablename AS tbl, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public';

-- Id-bearing columns: the PK, every FK column, and every text / text[] / jsonb
-- column whose data contains a cuid-shaped token. Data-driven, so a column the
-- migration's author missed is still checked.
CREATE TABLE uuid_verify.idcols (tbl text, col text, why text, PRIMARY KEY (tbl, col));
INSERT INTO uuid_verify.idcols SELECT tbl, 'id', 'pk' FROM uuid_verify.keyed;
INSERT INTO uuid_verify.idcols
SELECT DISTINCT c.relname, a.attname, 'fk'
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (k.conkey)
WHERE n.nspname = 'public' AND k.contype = 'f' AND a.atttypid = 'text'::regtype
ON CONFLICT DO NOTHING;
DO $$
DECLARE r record; hit boolean;
BEGIN
  FOR r IN SELECT table_name AS t, column_name AS c FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
             AND udt_name IN ('text', '_text', 'jsonb') LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I::text ~ ''(?<![a-z0-9])c[a-z0-9]{24}(?![a-z0-9])'')', r.t, r.c) INTO hit;
    IF hit THEN
      INSERT INTO uuid_verify.idcols VALUES (r.t, r.c, 'data') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Columns the migration deliberately leaves alone. Their ids dangle after the
-- migration by design, so they are reported but do not fail the run.
CREATE TABLE uuid_verify.expected_dangling (tbl text, col text, reason text);
INSERT INTO uuid_verify.expected_dangling VALUES
  ('BrainActivity', 'input',          'LLM call log; left alone by design'),
  ('BrainActivity', 'output',         'LLM call log; left alone by design'),
  ('BrainActivity', 'metadata',       'LLM call log; left alone by design'),
  ('BrainActivity', 'structuredOutput', 'LLM call log; left alone by design'),
  ('BrainActivity', 'turnId',         'log correlation string; left alone by design'),
  -- Rebuilt with the new ids re-sorted, so its token ORDER changes by design;
  -- checked against the application's formula below instead.
  ('TendingCoordinationCycle', 'coordinationKey', 'rebuilt and re-sorted; checked by formula');

-- Functions shared by both phases.
CREATE TABLE uuid_verify.rowhash (phase text, tbl text, id text, h text);
CREATE INDEX ON uuid_verify.rowhash (phase, id);

CREATE FUNCTION uuid_verify.hash_rows(p_phase text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text; ex text[];
BEGIN
  DELETE FROM uuid_verify.rowhash WHERE phase = p_phase;
  FOR t IN SELECT tbl FROM uuid_verify.keyed LOOP
    SELECT array_agg(col) INTO ex FROM uuid_verify.idcols WHERE tbl = t;
    EXECUTE format('INSERT INTO uuid_verify.rowhash SELECT %L, %L, x.id::text, md5((to_jsonb(x) - %L::text[])::text) FROM %I x',
                   p_phase, t, ex, t);
  END LOOP;
END $$;

-- A value that is itself a row id (whatever its shape: the state factory once
-- minted `reconciler-<sessionId>-<ms>`) becomes <hash of that row>. Otherwise
-- every cuid- or uuid-shaped token in it that is a row id is replaced the same way.
CREATE FUNCTION uuid_verify.resolve(p_phase text, p_text text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE tok text; h text; out text := p_text;
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;
  SELECT rh.h INTO h FROM uuid_verify.rowhash rh WHERE rh.phase = p_phase AND rh.id = p_text LIMIT 1;
  IF h IS NOT NULL THEN RETURN '<' || h || '>'; END IF;
  FOR tok IN SELECT DISTINCT m[1] FROM regexp_matches(p_text,
      '(?<![0-9a-z])(c[a-z0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-z])', 'g') AS m LOOP
    SELECT rh.h INTO h FROM uuid_verify.rowhash rh WHERE rh.phase = p_phase AND rh.id = tok LIMIT 1;
    IF h IS NOT NULL THEN
      out := replace(out, tok, '<' || h || '>');
    END IF;
  END LOOP;
  RETURN out;
END $$;

-- Per id-bearing column: the multiset of (row content, resolved column value).
CREATE TABLE uuid_verify.renderings (phase text, tbl text, col text, r text);
CREATE FUNCTION uuid_verify.render(p_phase text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c record; ex text[];
BEGIN
  DELETE FROM uuid_verify.renderings WHERE phase = p_phase;
  FOR c IN SELECT tbl, col FROM uuid_verify.idcols ORDER BY 1, 2 LOOP
    SELECT array_agg(col) INTO ex FROM uuid_verify.idcols WHERE tbl = c.tbl;
    EXECUTE format(
      'INSERT INTO uuid_verify.renderings SELECT %L, %L, %L,
         md5((to_jsonb(x) - %L::text[])::text) || '' '' || coalesce(uuid_verify.resolve(%L, x.%I::text), ''<null>'')
       FROM %I x', p_phase, c.tbl, c.col, ex, p_phase, c.col, c.tbl);
  END LOOP;
END $$;

SELECT uuid_verify.hash_rows('before');
SELECT uuid_verify.render('before');

\echo
\echo 'before: snapshot taken in schema uuid_verify'
SELECT count(*) AS keyed_tables FROM uuid_verify.keyed;
SELECT why, count(*) AS id_bearing_columns FROM uuid_verify.idcols GROUP BY why ORDER BY why;
SELECT tbl || '.' || col AS data_detected_id_columns FROM uuid_verify.idcols WHERE why = 'data' ORDER BY 1;
SELECT sum(n) AS total_rows FROM uuid_verify.row_counts;
\endif

\if :is_after
-- ==========================================================================
-- AFTER
-- ==========================================================================
CREATE TEMP TABLE failures (check_name text, detail text);

\echo
\echo '== 1. Row counts (every table) =='
CREATE TEMP TABLE counts_after (tbl text, before bigint, after bigint);
DO $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT * FROM uuid_verify.row_counts LOOP
    EXECUTE format('SELECT count(*) FROM %I', r.tbl) INTO n;
    INSERT INTO counts_after VALUES (r.tbl, r.n, n);
  END LOOP;
END $$;
INSERT INTO failures SELECT 'row count', tbl || ': ' || before || ' -> ' || after FROM counts_after WHERE before <> after;
SELECT count(*) AS tables, sum(before) AS rows_before, sum(after) AS rows_after,
       count(*) FILTER (WHERE before <> after) AS tables_changed FROM counts_after;
SELECT tbl, before, after FROM counts_after WHERE before > 0 ORDER BY tbl;

\echo
\echo '== 2. Orphan foreign keys (LEFT JOIN every FK; count non-null values with no parent) =='
CREATE TEMP TABLE orphans (conname text, n bigint);
DO $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT k.conname, c.relname AS child, a.attname AS col, p.relname AS parent, pa.attname AS pcol
           FROM pg_constraint k
           JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
           JOIN pg_attribute pa ON pa.attrelid = p.oid AND pa.attnum = k.confkey[1]
           WHERE ns.nspname = 'public' AND k.contype = 'f' LOOP
    EXECUTE format('SELECT count(*) FROM %I c LEFT JOIN %I p ON p.%I = c.%I WHERE c.%I IS NOT NULL AND p.%I IS NULL',
                   r.child, r.parent, r.pcol, r.col, r.col, r.pcol) INTO n;
    INSERT INTO orphans VALUES (r.conname, n);
  END LOOP;
END $$;
INSERT INTO failures SELECT 'orphan fk', conname || ': ' || n FROM orphans WHERE n > 0;
SELECT count(*) AS foreign_keys, coalesce(sum(n), 0) AS orphan_rows FROM orphans;

\echo
\echo '== 3. Id arrays: every element resolves to a row =='
CREATE TEMP TABLE all_ids AS SELECT id FROM uuid_verify.rowhash WHERE false;
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tbl FROM uuid_verify.keyed LOOP
    EXECUTE format('INSERT INTO all_ids SELECT id::text FROM %I', t);
  END LOOP;
END $$;
CREATE INDEX ON all_ids (id);
CREATE TEMP TABLE array_check (col text, elements bigint, unresolved bigint);
DO $$
DECLARE r record; n bigint; u bigint;
BEGIN
  FOR r IN SELECT table_name AS t, column_name AS c FROM information_schema.columns
           WHERE table_schema = 'public' AND udt_name = '_uuid' ORDER BY 1, 2 LOOP
    EXECUTE format('SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM all_ids a WHERE a.id = e::text))
                    FROM %I x, unnest(x.%I) e WHERE e IS NOT NULL', r.t, r.c) INTO n, u;
    INSERT INTO array_check VALUES (r.t || '.' || r.c, n, u);
  END LOOP;
END $$;
INSERT INTO failures SELECT 'array element', col || ': ' || unresolved FROM array_check WHERE unresolved > 0;
SELECT * FROM array_check;

\echo
\echo '== 4. JSON id keys resolve =='
CREATE TEMP TABLE json_check AS
WITH ids AS (
  SELECT 'StageProgress.gatesSatisfied.stage4Walkthrough.currentNeedId' AS path, "gatesSatisfied" #>> '{stage4Walkthrough,currentNeedId}' AS v FROM "StageProgress"
  UNION ALL SELECT 'StageProgress.gatesSatisfied.stage4Walkthrough.coveredNeedIds[]', e FROM "StageProgress", jsonb_array_elements_text(CASE WHEN jsonb_typeof("gatesSatisfied" #> '{stage4Walkthrough,coveredNeedIds}') = 'array' THEN "gatesSatisfied" #> '{stage4Walkthrough,coveredNeedIds}' ELSE '[]' END) e
  UNION ALL SELECT 'StageProgress.gatesSatisfied.stage4Walkthrough.skippedNeedIds[]', e FROM "StageProgress", jsonb_array_elements_text(CASE WHEN jsonb_typeof("gatesSatisfied" #> '{stage4Walkthrough,skippedNeedIds}') = 'array' THEN "gatesSatisfied" #> '{stage4Walkthrough,skippedNeedIds}' ELSE '[]' END) e
  UNION ALL SELECT 'Stage4ProposalRevision.before.agreementId', before ->> 'agreementId' FROM "Stage4ProposalRevision" WHERE jsonb_typeof(before) = 'object'
  UNION ALL SELECT 'Stage4ProposalRevision.after.agreementId', after ->> 'agreementId' FROM "Stage4ProposalRevision" WHERE jsonb_typeof(after) = 'object'
  UNION ALL SELECT 'Stage4ProposalRevision.before.removedByUserId', before ->> 'removedByUserId' FROM "Stage4ProposalRevision" WHERE jsonb_typeof(before) = 'object'
  UNION ALL SELECT 'Stage4ProposalRevision.after.removedByUserId', after ->> 'removedByUserId' FROM "Stage4ProposalRevision" WHERE jsonb_typeof(after) = 'object'
)
SELECT path, count(v) AS ids, count(v) FILTER (WHERE NOT EXISTS (SELECT 1 FROM all_ids a WHERE a.id = v)) AS unresolved
FROM ids GROUP BY path ORDER BY path;
INSERT INTO failures SELECT 'json id', path || ': ' || unresolved FROM json_check WHERE unresolved > 0;
SELECT * FROM json_check;

\echo
\echo '== 5. Constraints and indexes: same names and definitions as before =='
CREATE TEMP TABLE constraints_after AS
SELECT c.relname AS tbl, k.conname, k.contype::text, pg_get_constraintdef(k.oid) AS def
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public';
CREATE TEMP TABLE indexes_after AS
SELECT tablename AS tbl, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public';
CREATE TEMP TABLE schema_diff AS
SELECT 'constraint only before' AS side, tbl, conname AS name, def FROM (SELECT * FROM uuid_verify.constraints_before EXCEPT SELECT * FROM constraints_after) d
UNION ALL SELECT 'constraint only after', tbl, conname, def FROM (SELECT * FROM constraints_after EXCEPT SELECT * FROM uuid_verify.constraints_before) d
UNION ALL SELECT 'index only before', tbl, indexname, indexdef FROM (SELECT * FROM uuid_verify.indexes_before EXCEPT SELECT * FROM indexes_after) d
UNION ALL SELECT 'index only after', tbl, indexname, indexdef FROM (SELECT * FROM indexes_after EXCEPT SELECT * FROM uuid_verify.indexes_before) d;
INSERT INTO failures SELECT 'schema', side || ': ' || tbl || '.' || name FROM schema_diff;
SELECT (SELECT count(*) FROM uuid_verify.constraints_before) AS constraints_before,
       (SELECT count(*) FROM constraints_after) AS constraints_after,
       (SELECT count(*) FROM uuid_verify.indexes_before) AS indexes_before,
       (SELECT count(*) FROM indexes_after) AS indexes_after,
       (SELECT count(*) FROM schema_diff) AS differences;
SELECT * FROM schema_diff ORDER BY 1, 2, 3;

\echo
\echo '== 6. Identity: every id still names the same row (content-hash renderings) =='
SELECT uuid_verify.hash_rows('after');
SELECT uuid_verify.render('after');
CREATE TEMP TABLE identity AS
SELECT i.tbl, i.col, i.why,
  (SELECT count(*) FROM (SELECT r FROM uuid_verify.renderings WHERE phase = 'before' AND tbl = i.tbl AND col = i.col
                         EXCEPT ALL
                         SELECT r FROM uuid_verify.renderings WHERE phase = 'after' AND tbl = i.tbl AND col = i.col) d) AS changed_rows,
  (SELECT count(*) FROM uuid_verify.renderings WHERE phase = 'before' AND tbl = i.tbl AND col = i.col) AS rows,
  e.reason AS expected
FROM uuid_verify.idcols i LEFT JOIN uuid_verify.expected_dangling e ON e.tbl = i.tbl AND e.col = i.col;
INSERT INTO failures SELECT 'identity', tbl || '.' || col || ': ' || changed_rows || ' row(s)' FROM identity WHERE changed_rows > 0 AND expected IS NULL;
SELECT why, count(*) AS columns, sum(rows) AS rows_checked, sum(changed_rows) FILTER (WHERE expected IS NULL) AS changed_unexpected
FROM identity GROUP BY why ORDER BY why;
SELECT tbl, col, why, rows, changed_rows, expected FROM identity WHERE changed_rows > 0 OR expected IS NOT NULL ORDER BY 1, 2;

\echo
\echo '== 7. TendingCoordinationCycle.coordinationKey matches the application formula =='
-- services/tending.service.ts: `${sessionId}:${[...entryIds].sort().join('|')}`
CREATE TEMP TABLE key_check AS
SELECT count(*) AS cycles,
       count(*) FILTER (WHERE "coordinationKey" IS DISTINCT FROM
         "sessionId"::text || ':' || coalesce((SELECT string_agg(e::text, '|' ORDER BY e::text COLLATE "C") FROM unnest("entryIds") e), '')) AS mismatched
FROM "TendingCoordinationCycle" WHERE "coordinationKey" IS NOT NULL;
INSERT INTO failures SELECT 'coordinationKey', mismatched || ' mismatched' FROM key_check WHERE mismatched > 0;
SELECT * FROM key_check;

\echo
\echo '== 8. Old ids left anywhere (cuid tokens that were row ids before) =='
CREATE TEMP TABLE leftovers (tbl text, col text, n bigint);
DO $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT table_name AS t, column_name AS c FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' AND udt_name IN ('text', '_text', 'jsonb') LOOP
    EXECUTE format('SELECT count(*) FROM %I x WHERE EXISTS (
                      SELECT 1 FROM regexp_matches(x.%I::text, ''(?<![a-z0-9])(c[a-z0-9]{24})(?![a-z0-9])'', ''g'') m
                      JOIN uuid_verify.rowhash rh ON rh.phase = ''before'' AND rh.id = m[1])', r.t, r.c) INTO n;
    IF n > 0 THEN INSERT INTO leftovers VALUES (r.t, r.c, n); END IF;
  END LOOP;
END $$;
INSERT INTO failures SELECT 'leftover old id', l.tbl || '.' || l.col || ': ' || l.n
FROM leftovers l WHERE NOT EXISTS (SELECT 1 FROM uuid_verify.expected_dangling e WHERE e.tbl = l.tbl AND e.col = l.col);
SELECT l.*, e.reason AS expected FROM leftovers l LEFT JOIN uuid_verify.expected_dangling e USING (tbl, col) ORDER BY 1, 2;

\echo
\echo '== 9. Id time = creation time, and id order = creation order =='
CREATE TEMP TABLE time_check (tbl text, col text, rows bigint, max_skew_ms numeric, order_inversions bigint);
DO $$
DECLARE r record; n bigint; skew numeric; inv bigint;
BEGIN
  FOR r IN SELECT k.tbl, c.column_name AS col FROM uuid_verify.keyed k
           JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = k.tbl
           WHERE c.column_name = (SELECT column_name FROM information_schema.columns c2
                                  WHERE c2.table_schema = 'public' AND c2.table_name = k.tbl
                                    AND c2.column_name IN ('createdAt', 'timestamp')
                                  ORDER BY c2.column_name = 'createdAt' DESC LIMIT 1)
           ORDER BY 1 LOOP
    EXECUTE format(
      'SELECT count(*), max(abs(extract(epoch FROM (uuid_extract_timestamp(id) - (%I AT TIME ZONE ''UTC''))) * 1000)),
              (SELECT count(*) FROM (SELECT %I AS t, lag(%I) OVER (ORDER BY id) AS prev FROM %I) s WHERE t < prev)
       FROM %I', r.col, r.col, r.col, r.tbl, r.tbl) INTO n, skew, inv;
    INSERT INTO time_check VALUES (r.tbl, r.col, n, round(skew, 3), inv);
  END LOOP;
END $$;
INSERT INTO failures SELECT 'id time', tbl || ': skew ' || max_skew_ms || 'ms, inversions ' || order_inversions
FROM time_check WHERE max_skew_ms > 1000 OR order_inversions > 0;
SELECT count(*) AS tables, sum(rows) AS rows, max(max_skew_ms) AS max_skew_ms, sum(order_inversions) AS order_inversions
FROM time_check WHERE rows > 0;

\echo
\echo '== Result =='
SELECT check_name, detail FROM failures ORDER BY 1, 2;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM failures;
  IF n > 0 THEN
    RAISE EXCEPTION 'verify-uuid-migration: % check(s) failed (listed above)', n;
  END IF;
  RAISE NOTICE 'verify-uuid-migration: all checks passed';
END $$;

\if :{?keep}
\else
DROP SCHEMA uuid_verify CASCADE;
\endif
\endif
