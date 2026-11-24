-- verify.sql — read-only checks of a TARGET-SHAPE database after a deploy or a restore (work-k5fk.14).
--
--   psql -X -U postgres -d <db> -v ON_ERROR_STOP=1 < verify.sql
--
-- Run as the superuser (restore.sh does): row-level security is FORCEd on every table, so any other role would
-- count no rows. Every failed check RAISEs, so ON_ERROR_STOP stops at the first one; the SELECTs print evidence.
-- Upstream starts from an empty database on the target shape (owner decision OD7: no data move), so this file
-- knows that shape only: an old-shape database fails the first check. On a fresh deploy every user table is empty
-- and only the baseline's seeds have rows. The baseline's own step-20 assertions (trailer.sql T8) ran when it was
-- applied; these re-check what a restore or a later hand change could have lost.
SELECT current_database(), version();
SELECT extname, extversion FROM pg_extension ORDER BY extname;

-- 1. The target shape and nothing else: the baseline's tables exist, the old shape's do not.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(t, ', ') INTO bad FROM unnest(ARRAY['public."user"', 'public.session', 'public.participant',
    'public.conversation', 'public.message', 'public.live_session_pair', 'public.brain_activity', 'app.json_schema',
    'public.milestone']) t WHERE to_regclass(t) IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'verify: not the target shape, missing %', bad; END IF;
  SELECT string_agg(t, ', ') INTO bad FROM unnest(ARRAY['public."User"', 'public."Session"', 'public."Message"'])
    t WHERE to_regclass(t) IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'verify: old-shape table(s) present: %', bad; END IF;
END
$$;

-- 2. Migrations: every row finished and none rolled back or failed; the baseline is among them.
SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
FROM "_prisma_migrations" ORDER BY migration_name;
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(migration_name, ', ' ORDER BY migration_name) INTO bad FROM public."_prisma_migrations"
  WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'verify: unfinished or rolled-back migration(s): %', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."_prisma_migrations" WHERE migration_name LIKE '%\_target\_shape\_baseline') THEN
    RAISE EXCEPTION 'verify: the target-shape baseline migration is not recorded';
  END IF;
END
$$;

-- 3. Row counts per table (evidence; zero everywhere but the seeds on a fresh deploy).
SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;', schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname IN ('public', 'app') ORDER BY schemaname, tablename \gexec

-- 4. The seeds the app reads (trailer.sql's step 20 counted them at the deploy; a restore must have kept them).
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.milestone;
  IF n <> 13 THEN RAISE EXCEPTION 'verify: % milestone rows, expected 13', n; END IF;
  SELECT count(*) INTO n FROM app.json_schema;
  IF n < 4 THEN RAISE EXCEPTION 'verify: % app.json_schema rows, expected at least 4', n; END IF;
END
$$;

-- 5. Foreign keys: revalidate every one (a restore loads data with triggers off), then none unvalidated.
SELECT format('ALTER TABLE %s VALIDATE CONSTRAINT %I;', conrelid::regclass, conname) FROM pg_constraint WHERE contype = 'f' \gexec
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint WHERE contype = 'f' AND NOT convalidated;
  IF n > 0 THEN RAISE EXCEPTION 'verify: % unvalidated foreign key(s)', n; END IF;
END
$$;

-- 6. Row-level security: every table of public and app has it enabled AND forced (a table no runtime role is
-- granted — session_key — has no policy, and needs none: nobody but a definer reads it).
SELECT count(*) AS policies FROM pg_policy;
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY n.nspname, c.relname) INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'app') AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'verify: table(s) without forced row-level security: %', bad; END IF;
END
$$;

-- 7. Roles: the runtime logins are plain logins (no superuser, no BYPASSRLS — under FORCE that would read every
-- row), own nothing, and no policy is written for the owner (work-k5fk.10.31: a data migration's own policy is
-- created and dropped inside that migration; one left behind is a hole).
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO bad FROM pg_roles r
  WHERE r.rolname IN ('mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth', 'mwf_clinician', 'slam_bot_readonly')
    AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'verify: runtime login(s) with a privileged attribute: %', bad; END IF;
  SELECT string_agg(DISTINCT pg_get_userbyid(c.relowner), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'app')
    AND pg_get_userbyid(c.relowner) IN ('mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth', 'mwf_clinician', 'slam_bot_readonly');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'verify: runtime login(s) own relations: %', bad; END IF;
  SELECT string_agg(p.polname || ' ON ' || p.polrelid::regclass::text, ', ') INTO bad FROM pg_policy p
  WHERE p.polname LIKE 'migration\_%'
     OR EXISTS (SELECT 1 FROM unnest(p.polroles) x(oid) WHERE x.oid = 0 OR pg_get_userbyid(x.oid) = 'mwf_migrator');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'verify: policy(ies) for PUBLIC, the owner or a data migration left behind: %', bad; END IF;
END
$$;

-- 8. Production has no E2E-bypass identity (work-k5fk.1): the e2e provider is written only by the E2E tooling
-- connection (E2E_AUTH_BYPASS, never production); a row here means the bypass ran.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.user_identity WHERE provider = 'e2e';
  IF n > 0 THEN RAISE EXCEPTION 'verify: % user_identity row(s) of provider e2e in production', n; END IF;
END
$$;

-- 9. Representative reads on the target's keys (each must plan and run; empty on a fresh deploy).
SELECT id, kind, created_at FROM "user" ORDER BY id LIMIT 1;
SELECT session_id, user_id, kind FROM participant ORDER BY session_id, user_id LIMIT 1;
SELECT conversation_id, seq, session_id FROM message ORDER BY conversation_id, seq LIMIT 1;
-- message numbering: no conversation's counter is at or behind one of its lines (work-k5fk.4, .25)
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.conversation c
  WHERE c.next_seq <= (SELECT max(m.seq) FROM public.message m WHERE m.conversation_id = c.id);
  IF n > 0 THEN RAISE EXCEPTION 'verify: % conversation(s) whose next_seq is not past its last message', n; END IF;
END
$$;
