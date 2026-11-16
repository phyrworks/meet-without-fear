-- ============================================================================
-- trailer.sql — section 3 of the target_shape_baseline migration (TS-7c;
-- built by TS-7, re-based on an empty database by OD7, 2026-10-26).
-- Hand-maintained; backend/scripts/gen-target-migration.ts appends it after
-- the preamble and tables.sql (which ends each table with its seed and grants), and splices
-- backend/scripts/target-shape/sql-only.sql in, verbatim, at the
-- `-- @@include sql-only.sql` line. It never runs alone: it runs in the same
-- transaction, so a failure here rolls the whole baseline back.
--
-- Spec: docs/backend/data-model/schema-target-2026-10.md §1 (Keys lines), §4
-- (views, functions, the anonymisation walk), §7 (invariants);
-- phase3-design-summary.md §4–§6 where the spec re-bases them.
--
-- Contents, in order (T1 and T3 are gone: since work-a39h.11.40 the domains,
-- the generated columns and every CHECK live inline in tables.sql):
--   T2  sql-only.sql (sql_ partial / expression indexes)
--   T4  app.* functions — invoker helpers, then the SECURITY DEFINER helpers and
--       writers, each followed by its REVOKE / GRANT EXECUTE; then the definers
--       are handed to the NOLOGIN mwf_definer (GRANT CREATE → ALTER OWNER → REVOKE CREATE)
--   T5  triggers (the T-* set and touch_updated_at ×35), each function followed
--       by its REVOKE EXECUTE FROM PUBLIC
--   T6  views (security_invoker = true), each followed by its SELECT grants
--   T7  (empty since work-k5fk.7: every grant sits next to its object)
--   T8  catalog assertions (plan step 20). The database is empty, so there are
--       no existing rows to re-check: every invariant is enforced by its
--       trigger or CHECK from the first write on.
--
-- Not here: RLS ENABLE/FORCE and policies (TS-16); the milestone seed (in
-- tables.sql, after the milestone table); schema app and app.current_user_id()
-- (preamble.sql); the tables, their constraints, the domains and every table
-- grant (tables.sql).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- T2. sql-only.sql, verbatim (TS-6): the sql_ indexes.
-- ---------------------------------------------------------------------------
-- @@include sql-only.sql

-- ---------------------------------------------------------------------------
-- T4. app.* functions (spec §4; P3 §5).
--
-- Every SECURITY DEFINER function and every trigger function pins
-- search_path = pg_catalog, public, pg_temp (pg_temp last, so a caller's temp
-- objects can never shadow a catalog or a table) and qualifies every relation.
--
-- "Is the caller the job?" inside a SECURITY DEFINER function: current_user is
-- the owner (mwf_definer), so the test reads session_user — the role that logged
-- in — and is exactly session_user IN ('mwf_job', 'mwf_migrator') (spec
-- Conventions `job`). No catalog is read and no superuser arm exists (Phase 3
-- §1: rolsuper must be false); local tooling that needs the job connects as
-- mwf_job (JOB_DATABASE_URL, docs/development/local-setup.md).
--
-- Every self-arm is NULL-safe: an unset identity (app.current_user_id() IS
-- NULL) is never "self" (participant.user_id is NOT NULL since work-k5fk.3).
-- ---------------------------------------------------------------------------

-- Invoker helper: updated_at on every UPDATE (owner decision 2026-10-21; not moddatetime).
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Invoker helpers: the JSON-schema subset validator (work-k5fk.8; owner
-- decision Q11: PL/pgSQL, no extension). The subset and why it is enough:
-- tables.sql app.json_schema_wellformed (the CHECK on every seeded schema)
-- and docs/backend/data-model/jsonb-shapes-2026-11.md. Semantics are JSON
-- Schema's: object keywords (required, properties, additionalProperties) say
-- nothing about a non-object, items nothing about a non-array; integer is a
-- number with no fraction (1.0 is one); a key present with a JSON null value
-- is present. A violation is reported as a JSONPath-like location and a
-- reason. A value is never quoted — a leaf of ai_memory.doc is ciphertext or
-- private text — but a key name is (keys are the document's structure,
-- plaintext even in ai_memory.doc). The first violation found wins.
-- search_path: pg_catalog and pg_temp only; every app object is qualified.
CREATE FUNCTION app.jsonb_schema_violation(doc jsonb, schema jsonb, path text DEFAULT '$') RETURNS text
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE
    t CONSTANT text := coalesce(jsonb_typeof(doc), 'SQL NULL');
    want jsonb;
    k text;
    v jsonb;
    i bigint;
    r text;
  BEGIN
    IF schema ? 'type' THEN
      want := CASE jsonb_typeof(schema -> 'type') WHEN 'array' THEN schema -> 'type' ELSE jsonb_build_array(schema -> 'type') END;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(want) w
                     WHERE w = t OR (w = 'integer' AND CASE WHEN t = 'number' THEN doc::numeric = trunc(doc::numeric) ELSE false END)) THEN
        RETURN format('%s: expected %s, got %s', path,
                      (SELECT string_agg(x.w, ' or ' ORDER BY x.o) FROM jsonb_array_elements_text(want) WITH ORDINALITY x(w, o)), t);
      END IF;
    END IF;
    IF schema ? 'enum' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(schema -> 'enum') e WHERE e = doc) THEN
      RETURN format('%s: not one of the allowed values', path);
    END IF;
    IF t = 'object' THEN
      SELECT x.req INTO k FROM jsonb_array_elements_text(coalesce(schema -> 'required', '[]')) WITH ORDINALITY x(req, o)
      WHERE NOT doc ? x.req ORDER BY x.o LIMIT 1;
      IF k IS NOT NULL THEN
        RETURN format('%s: missing required key %s', path, k);
      END IF;
      FOR k, v IN SELECT d.key, d.value FROM jsonb_each(doc) d LOOP
        IF coalesce(schema -> 'properties' ? k, false) THEN
          r := app.jsonb_schema_violation(v, schema -> 'properties' -> k, path || '.' || k);
        ELSIF jsonb_typeof(schema -> 'additionalProperties') = 'object' THEN
          r := app.jsonb_schema_violation(v, schema -> 'additionalProperties', path || '.' || k);
        ELSIF schema -> 'additionalProperties' = 'false'::jsonb THEN
          r := format('%s: unexpected key %s', path, k);
        ELSE
          r := NULL;
        END IF;
        IF r IS NOT NULL THEN RETURN r; END IF;
      END LOOP;
    ELSIF t = 'array' AND schema ? 'items' THEN
      FOR v, i IN SELECT a.value, a.ordinality - 1 FROM jsonb_array_elements(doc) WITH ORDINALITY a(value, ordinality) LOOP
        r := app.jsonb_schema_violation(v, schema -> 'items', format('%s[%s]', path, i));
        IF r IS NOT NULL THEN RETURN r; END IF;
      END LOOP;
    END IF;
    RETURN NULL;
  END
  $$;
COMMENT ON FUNCTION app.jsonb_schema_violation(jsonb, jsonb, text) IS 'The first way doc fails the JSON schema (the app.json_schema_wellformed subset), as "<path>: <reason>" (e.g. $.facts[1]: missing required key fact), or NULL when it matches. Never quotes a value; key names, which are structure, do appear. Pure; the core of app.jsonb_violation.';

-- The violation of doc against the seeded schema (name, version). An unknown
-- schema is refused with SQLSTATE MWJ01 (class MW is this app's: MWA0x the
-- session archive, MWF0x sign-in, MWJ0x the jsonb validators; the codes are
-- listed in docs/backend/data-model/jsonb-shapes-2026-11.md §2). Not 23503:
-- Prisma would report that as P2003 "Foreign key constraint failed". Reads
-- app.json_schema with the caller's rights (SELECT: app_access, job_access —
-- tables.sql).
CREATE FUNCTION app.jsonb_violation(doc jsonb, name text, version public.schema_version) RETURNS text
  LANGUAGE plpgsql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE
    s jsonb;
  BEGIN
    SELECT j.schema INTO s FROM app.json_schema j
    WHERE j.name = jsonb_violation.name AND j.version = jsonb_violation.version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'json_schema % version % does not exist', jsonb_violation.name, jsonb_violation.version
        USING ERRCODE = 'MWJ01';
    END IF;
    RETURN app.jsonb_schema_violation(doc, s);
  END
  $$;
COMMENT ON FUNCTION app.jsonb_violation(jsonb, text, public.schema_version) IS 'app.jsonb_schema_violation against the app.json_schema row (name, version); raises MWJ01 for an unknown one. What the t_doc_schema trigger reports.';
-- app_access, job_access (mwf_app's and mwf_job's): the t_doc_schema trigger calls it with the writer's rights.
REVOKE EXECUTE ON FUNCTION app.jsonb_violation(jsonb, text, public.schema_version) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jsonb_violation(jsonb, text, public.schema_version) TO app_access;
GRANT EXECUTE ON FUNCTION app.jsonb_violation(jsonb, text, public.schema_version) TO job_access;

-- Does doc match the seeded schema (name, version)? (MWJ01 for an unknown one.)
CREATE FUNCTION app.jsonb_matches(doc jsonb, name text, version public.schema_version) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  RETURN app.jsonb_violation(doc, name, version) IS NULL;
COMMENT ON FUNCTION app.jsonb_matches(jsonb, text, public.schema_version) IS 'True when doc matches the app.json_schema row (name, version); raises MWJ01 for an unknown one. For ad-hoc checks and tests; the trigger uses app.jsonb_violation for its message.';
-- app_access, job_access (mwf_app's and mwf_job's): the capabilities that read the schemas (no app caller today; the caller tests use it).
REVOKE EXECUTE ON FUNCTION app.jsonb_matches(jsonb, text, public.schema_version) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jsonb_matches(jsonb, text, public.schema_version) TO app_access;
GRANT EXECUTE ON FUNCTION app.jsonb_matches(jsonb, text, public.schema_version) TO job_access;

-- The envelope rule for the five jsonb-envelope columns (t_jsonb_envelope, T5).
-- Lenient exactly as the ciphertext domain is: with no FIELD_ENCRYPTION_KEY
-- (keyless dev/test, and production until REQUIRE_FIELD_ENCRYPTION)
-- sealFieldValue stores the plain document, and follow_up_checkin's DEFAULT
-- writes '{}'; so an object WITHOUT a "$enc" key passes. One WITH it is an
-- envelope and must be well formed: "$enc" its only key, a string, starting
-- enc: (plaintext in the envelope is refused — the domain alone would let it
-- through) and castable to ciphertext (a malformed ciphertext is refused).
-- A non-object is refused here too, before the column's jsonb_typeof CHECK
-- could echo it. The strict variant (every document an envelope) lands with
-- the strict ciphertext domain (work-k5fk.11). Returns the reason, never the
-- value; NULL when the document passes.
CREATE FUNCTION app.jsonb_envelope_violation(doc jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF doc IS NULL THEN RETURN NULL; END IF;
    IF jsonb_typeof(doc) <> 'object' THEN RETURN 'not an object, got ' || jsonb_typeof(doc); END IF;
    IF NOT doc ? '$enc' THEN RETURN NULL; END IF;
    IF doc - '$enc' <> '{}'::jsonb THEN RETURN 'a sealed document has "$enc" as its only key'; END IF;
    IF jsonb_typeof(doc -> '$enc') <> 'string' THEN RETURN '"$enc" is not a string, got ' || jsonb_typeof(doc -> '$enc'); END IF;
    IF doc ->> '$enc' NOT LIKE 'enc:%' THEN RETURN '"$enc" is not a ciphertext (plaintext in an envelope)'; END IF;
    BEGIN
      PERFORM (doc ->> '$enc')::public.ciphertext;
    EXCEPTION WHEN check_violation THEN
      RETURN '"$enc" is a malformed ciphertext';
    END;
    RETURN NULL;
  END
  $$;
COMMENT ON FUNCTION app.jsonb_envelope_violation(jsonb) IS 'Why a jsonb-envelope document is refused, or NULL: a document with "$enc" must be exactly {"$enc": <a v1 ciphertext>}; a non-object is refused; an object without "$enc" passes (keyless plaintext, as the ciphertext domain lets plaintext through). Never quotes the value. What the t_jsonb_envelope trigger reports.';
-- app_access, job_access (mwf_app's and mwf_job's): the t_jsonb_envelope trigger calls it with the writer's rights.
REVOKE EXECUTE ON FUNCTION app.jsonb_envelope_violation(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jsonb_envelope_violation(jsonb) TO app_access;
GRANT EXECUTE ON FUNCTION app.jsonb_envelope_violation(jsonb) TO job_access;

-- The TS-1 helpers over participant. (work-k5fk.3: app.is_co_participant and
-- app.my_participant went with participant.id: every session-scoped row carries
-- session_id, so app.is_member(session_id) is the co-participant test, and the
-- caller's participant is (session, app.current_user_id()).) Created
-- here like every other definer helper and handed to mwf_definer below (there is
-- no earlier definition to replace: OD7 baseline).

-- Does the caller have a participant row in this session? (left_at does not
-- matter: a leaver keeps reading the shared vessel; spec §1.1 participant.)
CREATE FUNCTION app.is_member(session uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.participant p
      WHERE p.session_id = is_member.session AND p.user_id = app.current_user_id()
    )
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.touch_updated_at() FROM PUBLIC;
-- mwf_app (app_access): no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app. mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.is_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO app_access;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO job_access;

-- The caller's co-participant's user id: NULL unless the caller is a
-- participant and the session has exactly two human participants (kept for
-- the two-party job paths; v_co_participant is the N-safe read).
CREATE FUNCTION app.partner_user_id(session uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT other.user_id
    FROM public.participant me
    JOIN public.participant other
      ON other.session_id = me.session_id AND other.user_id <> me.user_id AND other.kind = 'human'
    WHERE me.session_id = partner_user_id.session
      AND me.user_id = app.current_user_id()
      AND (SELECT count(*) FROM public.participant c WHERE c.session_id = me.session_id AND c.kind = 'human') = 2
  $$;
-- mwf_app (app_access): no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app. mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.partner_user_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.partner_user_id(uuid) TO app_access;
GRANT EXECUTE ON FUNCTION app.partner_user_id(uuid) TO job_access;

-- Content-free status of every empathy direction in the caller's sessions
-- (the latest round per direction): what both parties may see while neither
-- may read an unrevealed row (P0-2). Behind v_empathy_direction_status.
CREATE FUNCTION app.empathy_direction_status()
  RETURNS TABLE (session_id uuid, author_user_id uuid, subject_user_id uuid, round integer, status public.empathy_status,
                 submitted_at timestamptz, revealed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT DISTINCT ON (a.session_id, a.author_user_id, a.subject_user_id)
           a.session_id, a.author_user_id, a.subject_user_id, a.round, a.status, a.submitted_at, a.revealed_at
    FROM public.empathy_attempt a
    WHERE EXISTS (SELECT 1 FROM public.participant me
                  WHERE me.session_id = a.session_id AND me.user_id = app.current_user_id())
    ORDER BY a.session_id, a.author_user_id, a.subject_user_id, a.round DESC
  $$;
-- mwf_app (app_access): the identity-bound read behind v_empathy_direction_status. mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.empathy_direction_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empathy_direction_status() TO app_access;
GRANT EXECUTE ON FUNCTION app.empathy_direction_status() TO job_access;

-- The writer of session.status (spec §1.1 transition set), but for a
-- participant's archive (app.session_archive, below). The job, or a CURRENT
-- participant (left_at IS NULL; not app.is_member, which counts leavers so
-- they keep reading — work-k5fk.10.12: a leaver must not move the session);
-- anyone else: 'session not found'. → ARCHIVED is the job's only (retention:
-- RESOLVED / ABANDONED → ARCHIVED, stamping archived_at with no archiver).
-- T-cardinality-1 (trigger) still refuses → ACTIVE without two
-- participants. Locks the session row FOR NO KEY UPDATE (lock order: session,
-- then attempt; NO KEY so child-row INSERTs, which take KEY SHARE on session
-- through their FK, are not blocked — status/resolved_at are not key columns).
CREATE FUNCTION app.session_set_status(session uuid, status public.session_status) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_from public.session_status;
    v_job  boolean := session_user IN ('mwf_job', 'mwf_migrator');
  BEGIN
    SELECT s.status INTO v_from FROM public.session s WHERE s.id = session_set_status.session FOR NO KEY UPDATE;
    IF NOT FOUND OR NOT (v_job OR EXISTS (
          SELECT 1 FROM public.participant p
          WHERE p.session_id = session_set_status.session AND p.user_id = app.current_user_id() AND p.left_at IS NULL)) THEN
      RAISE EXCEPTION 'session not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_from = session_set_status.status THEN
      RETURN;
    END IF;
    IF session_set_status.status = 'ARCHIVED' AND NOT v_job THEN
      RAISE EXCEPTION 'only the job archives through session_set_status; a participant uses app.session_archive'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT ((v_from, session_set_status.status) IN (
              ('CREATED'::public.session_status, 'INVITED'::public.session_status), ('INVITED', 'ACTIVE'),
              ('CREATED', 'ABANDONED'), ('INVITED', 'ABANDONED'), ('ACTIVE', 'ABANDONED'),
              ('ACTIVE', 'RESOLVED'), ('RESOLVED', 'ARCHIVED'), ('ABANDONED', 'ARCHIVED'))) THEN
      RAISE EXCEPTION 'session status % → % is not a permitted transition', v_from, session_set_status.status
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.session s
    SET status = session_set_status.status,
        resolved_at = CASE WHEN session_set_status.status = 'RESOLVED' THEN coalesce(s.resolved_at, now()) ELSE s.resolved_at END,
        archived_at = CASE WHEN session_set_status.status = 'ARCHIVED' THEN now() ELSE s.archived_at END
    WHERE s.id = session_set_status.session;
  END
  $$;
-- mwf_app (app_access): invitations.ts accept, on the app transaction. mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) TO app_access;
GRANT EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) TO job_access;

-- A participant archives a session (work-k5fk.10.12, owner decision option A,
-- 2026-11-13): the caller must be a CURRENT participant (a human participant
-- whose user is the identity, left_at NULL) — not an invitee who never
-- joined, not one who left — and the session in an archivable state:
-- CREATED, INVITED (a pending invitation withdrawn), RESOLVED or ABANDONED.
-- Records the archiver and the instant; returns the instant. Identity-bound
-- only: a job or migrator login is refused (insufficient_privilege) — the
-- owner role would otherwise archive for any user; retention archives
-- through session_set_status.
-- Refusals carry their own SQLSTATEs (class MW, not a standard class), so a
-- grant drift (42501) or an unrelated CHECK (23514) is never read as one:
--   MWA00  no identity bound (a server fault, not the caller's)
--   MWA01  no such session, or the caller is not a participant of it (as not
--          found, so the session's existence is not revealed)
--   MWA02  the caller is a participant who left
--   MWA03  the session is not archivable from its state (ACTIVE, ARCHIVED)
-- Locks the session row FOR NO KEY UPDATE, as session_set_status does, so of
-- two concurrent archives the second sees ARCHIVED (MWA03) and the first
-- archiver stays recorded.
CREATE FUNCTION app.session_archive(session uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me   uuid := app.current_user_id();
    v_from public.session_status;
    v_left timestamptz;
    v_part boolean;
    v_at   timestamptz;
  BEGIN
    IF session_user IN ('mwf_job', 'mwf_migrator') THEN
      RAISE EXCEPTION 'session_archive is identity-bound: a job or migrator login cannot archive for a user'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_me IS NULL THEN
      RAISE EXCEPTION 'session_archive: no identity bound' USING ERRCODE = 'MWA00';
    END IF;
    SELECT s.status INTO v_from FROM public.session s WHERE s.id = session_archive.session FOR NO KEY UPDATE;
    SELECT true, p.left_at INTO v_part, v_left FROM public.participant p
    WHERE p.session_id = session_archive.session AND p.user_id = v_me;
    IF v_from IS NULL OR v_part IS NULL THEN
      RAISE EXCEPTION 'session not found' USING ERRCODE = 'MWA01';
    END IF;
    IF v_left IS NOT NULL THEN
      RAISE EXCEPTION 'a participant who left cannot archive the session' USING ERRCODE = 'MWA02';
    END IF;
    IF v_from NOT IN ('CREATED', 'INVITED', 'RESOLVED', 'ABANDONED') THEN
      RAISE EXCEPTION 'a session in status % cannot be archived', v_from USING ERRCODE = 'MWA03';
    END IF;
    UPDATE public.session s
    SET status = 'ARCHIVED', archived_at = now(), archived_by_user_id = v_me
    WHERE s.id = session_archive.session
    RETURNING s.archived_at INTO v_at;
    RETURN v_at;
  END
  $$;
COMMENT ON FUNCTION app.session_archive(uuid) IS 'Archive a session as a current participant of it (identity-bound; job and migrator logins refused): CREATED, INVITED, RESOLVED or ABANDONED -> ARCHIVED, recording archived_at and archived_by_user_id; returns archived_at. Refusals: MWA00 no identity, MWA01 not found / not a participant, MWA02 participant left, MWA03 not archivable. The only way mwf_app archives (no UPDATE of session.status).';
-- mwf_app (app_access): invitations.ts archiveSession, identity-bound. No EXECUTE grant to mwf_job (the function itself refuses a
-- job login as well); retention archives through session_set_status.
REVOKE EXECUTE ON FUNCTION app.session_archive(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_archive(uuid) TO app_access;

-- The only writer of empathy_attempt.status (spec §1.2 transition table; P3 §5).
-- Actors (P3 §5: a non-author never moves a row into a disclosing state):
--   the AUTHOR (identity-bound) or the job: HELD → AWAITING_SHARING | READY,
--     AWAITING_SHARING → REFINING | READY, REFINING → READY | AWAITING_SHARING
--     (the stage2.ts in-request writers), and SUPERSEDED (resubmission);
--   the job only: READY → REVEALED, and only when the reveal gate holds;
--   the SUBJECT (identity-bound) or the job: REVEALED → VALIDATED | REFINING.
-- Anyone else: 'attempt not found'. Locks the session row, then the attempt,
-- so a concurrent resubmit of the reverse direction cannot slip between the
-- gate read and the reveal. On → REVEALED: stamps revealed_at once and writes
-- the EMPATHY_STATEMENT into the SUBJECT's MAIN conversation (the author keeps
-- their own copy); re-encrypting content under the session key is the job's,
-- in the application (keys never reach SQL). → SUPERSEDED inserts round n+1
-- (HELD) with p_content and returns its id; a retried call returns that id.
CREATE FUNCTION app.empathy_set_status(attempt uuid, status public.empathy_status, content text DEFAULT NULL) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    a              public.empathy_attempt%ROWTYPE;
    v_me           uuid := app.current_user_id();
    v_job          boolean := session_user IN ('mwf_job', 'mwf_migrator');
    v_session      uuid;
    v_author_user  uuid;
    v_author_left  timestamptz;
    v_subject_user uuid;
    v_subject_left timestamptz;
    v_is_author    boolean;
    v_is_subject   boolean;
    v_gate         boolean;
    v_new          uuid;
  BEGIN
    SELECT e.session_id INTO v_session FROM public.empathy_attempt e WHERE e.id = empathy_set_status.attempt;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM 1 FROM public.session s WHERE s.id = v_session FOR NO KEY UPDATE;
    SELECT * INTO a FROM public.empathy_attempt e WHERE e.id = empathy_set_status.attempt FOR NO KEY UPDATE;
    SELECT p.user_id, p.left_at INTO v_author_user, v_author_left FROM public.participant p
    WHERE p.session_id = a.session_id AND p.user_id = a.author_user_id;
    SELECT p.user_id, p.left_at INTO v_subject_user, v_subject_left FROM public.participant p
    WHERE p.session_id = a.session_id AND p.user_id = a.subject_user_id;
    v_is_author  := v_me IS NOT NULL AND v_author_user IS NOT NULL AND v_me = v_author_user;
    v_is_subject := v_me IS NOT NULL AND v_subject_user IS NOT NULL AND v_me = v_subject_user;
    IF NOT (v_job OR v_is_author OR v_is_subject) THEN
      RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
    END IF;

    IF empathy_set_status.status = 'SUPERSEDED' THEN
      IF NOT (v_job OR v_is_author) THEN
        RAISE EXCEPTION 'only the author resubmits' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF a.status = 'SUPERSEDED' THEN
        -- A retried resubmission: return the round that superseded this one.
        SELECT e.id INTO v_new FROM public.empathy_attempt e WHERE e.supersedes_attempt_id = a.id ORDER BY e.round DESC LIMIT 1;
        RETURN coalesce(v_new, a.id);
      END IF;
      IF a.status = 'VALIDATED' THEN
        RAISE EXCEPTION 'a VALIDATED attempt cannot be superseded' USING ERRCODE = 'check_violation';
      END IF;
      IF empathy_set_status.content IS NULL THEN
        RAISE EXCEPTION 'resubmission needs the new round''s content' USING ERRCODE = 'null_value_not_allowed';
      END IF;
      UPDATE public.empathy_attempt SET status = 'SUPERSEDED', status_version = status_version + 1 WHERE id = a.id;
      INSERT INTO public.empathy_attempt (session_id, author_user_id, subject_user_id, round, supersedes_attempt_id, content, status)
      VALUES (a.session_id, a.author_user_id, a.subject_user_id, a.round + 1, a.id, empathy_set_status.content, 'HELD')
      RETURNING id INTO v_new;
      RETURN v_new;
    END IF;

    IF a.status = empathy_set_status.status THEN
      RETURN a.id;
    END IF;

    IF (a.status, empathy_set_status.status) IN (
         ('HELD'::public.empathy_status, 'AWAITING_SHARING'::public.empathy_status), ('HELD', 'READY'),
         ('AWAITING_SHARING', 'REFINING'), ('AWAITING_SHARING', 'READY'),
         ('REFINING', 'READY'), ('REFINING', 'AWAITING_SHARING')) THEN
      IF NOT (v_job OR v_is_author) THEN
        RAISE EXCEPTION 'only the author or the job moves this attempt' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF (a.status, empathy_set_status.status) = ('READY'::public.empathy_status, 'REVEALED'::public.empathy_status) THEN
      IF NOT v_job THEN
        RAISE EXCEPTION 'only the job reveals' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF (a.status, empathy_set_status.status) IN (
         ('REVEALED'::public.empathy_status, 'VALIDATED'::public.empathy_status), ('REVEALED', 'REFINING')) THEN
      IF NOT (v_job OR v_is_subject) THEN
        RAISE EXCEPTION 'only the subject reviews a revealed attempt' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSE
      RAISE EXCEPTION 'empathy status % → % is not a permitted transition', a.status, empathy_set_status.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF empathy_set_status.status = 'REVEALED' THEN
      -- The reveal gate (never vacuous): author and subject are both present,
      -- and every ordered pair of present human participants has a live
      -- attempt at READY or later.
      SELECT v_author_left IS NULL AND v_subject_left IS NULL
         AND NOT EXISTS (
               SELECT 1
               FROM public.participant x
               JOIN public.participant y ON y.session_id = x.session_id AND y.user_id <> x.user_id
               WHERE x.session_id = v_session
                 AND x.kind = 'human' AND x.left_at IS NULL AND y.kind = 'human' AND y.left_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM public.empathy_attempt e
                                 WHERE e.session_id = x.session_id AND e.author_user_id = x.user_id AND e.subject_user_id = y.user_id
                                   AND e.status IN ('READY', 'REVEALED', 'VALIDATED')))
        INTO v_gate;
      IF NOT v_gate THEN
        RAISE EXCEPTION 'reveal gate not met: every direction must be READY first' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE public.empathy_attempt
      SET status = 'REVEALED', revealed_at = coalesce(revealed_at, now()), status_version = status_version + 1
      WHERE id = a.id;
      INSERT INTO public.message (conversation_id, session_id, sender_user_id, role, kind, content, source_attempt_id)
      SELECT c.id, a.session_id, a.author_user_id, 'USER', 'EMPATHY_STATEMENT', a.content, a.id
      FROM public.conversation c
      WHERE c.session_id = a.session_id AND c.user_id = a.subject_user_id AND c.kind = 'MAIN'
        AND NOT EXISTS (SELECT 1 FROM public.message m
                        WHERE m.conversation_id = c.id AND m.source_attempt_id = a.id AND m.kind = 'EMPATHY_STATEMENT');
    ELSE
      UPDATE public.empathy_attempt SET status = empathy_set_status.status, status_version = status_version + 1 WHERE id = a.id;
    END IF;
    RETURN a.id;
  END
  $$;
-- mwf_app (app_access): the request-path writer (work-k5fk.10.2). mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) TO app_access;
GRANT EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) TO job_access;

-- need_share is written only here, by the job (it holds the session key that
-- encrypts shared_text; EXECUTE is the job's alone), after the owner's
-- GRANTED consent, for a need that is neither deleted nor superseded;
-- session_id and user_id come from the need, never from the caller
-- (spec §1.4, N-1, N-7). Idempotent: a need already shared is left as it is.
CREATE FUNCTION app.need_share(need uuid, shared_text text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NOT (session_user IN ('mwf_job', 'mwf_migrator')) THEN
      RAISE EXCEPTION 'need_share is the job''s' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.need n
                   WHERE n.id = need_share.need AND n.deleted_at IS NULL AND n.superseded_by_need_id IS NULL) THEN
      RAISE EXCEPTION 'need not found, deleted or superseded' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.consent c JOIN public.need n ON n.id = c.need_id
                   WHERE c.need_id = need_share.need AND c.user_id = n.user_id AND c.decision = 'GRANTED') THEN
      RAISE EXCEPTION 'need has no GRANTED consent by its owner' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.need_share (need_id, session_id, user_id, category, shared_text)
    SELECT n.id, n.session_id, n.user_id, n.category, need_share.shared_text
    FROM public.need n
    WHERE n.id = need_share.need
    ON CONFLICT (need_id) DO NOTHING;
  END
  $$;
-- Not mwf_app: the job's. mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.need_share(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.need_share(uuid, text) TO job_access;

-- Revoke a shared need: need_share.revoked_at and the consent's REVOKED in
-- one transaction (spec §1.4). The need's owner (identity-bound) or the job.
CREATE FUNCTION app.need_revoke_share(need uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_job boolean := session_user IN ('mwf_job', 'mwf_migrator');
    v_me  uuid := app.current_user_id();
  BEGIN
    IF NOT (v_job OR (v_me IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.need n WHERE n.id = need_revoke_share.need AND n.user_id = v_me))) THEN
      RAISE EXCEPTION 'need not found' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.need_share SET revoked_at = now() WHERE need_id = need_revoke_share.need AND revoked_at IS NULL;
    UPDATE public.consent SET decision = 'REVOKED', revoked_at = now()
    WHERE need_id = need_revoke_share.need AND decision = 'GRANTED';
  END
  $$;
-- mwf_app (app_access): the request-path writer (work-k5fk.10.2). mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.need_revoke_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.need_revoke_share(uuid) TO app_access;
GRANT EXECUTE ON FUNCTION app.need_revoke_share(uuid) TO job_access;

-- app.anonymize_user_in_session(session, user): steps 1–4 and 7 (participant
-- key) of the account walk for one session (spec §4), for the participant
-- (session, user) (work-k5fk.3). That user (identity-bound, never NULL) or the job.
CREATE FUNCTION app.anonymize_user_in_session(session uuid, "user" uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_job  boolean := session_user IN ('mwf_job', 'mwf_migrator');
    v_me   uuid := app.current_user_id();
    sid    uuid := anonymize_user_in_session.session;
    uid    uuid := anonymize_user_in_session."user";
  BEGIN
    PERFORM 1 FROM public.participant p WHERE p.session_id = sid AND p.user_id = uid;
    IF NOT FOUND OR NOT (v_job OR coalesce(v_me IS NOT NULL AND uid = v_me, false)) THEN
      RAISE EXCEPTION 'participant not found' USING ERRCODE = 'P0002';
    END IF;
    -- 1. a live session → ABANDONED (closes the invite-accept path; lets T-cardinality-2 accept the leave)
    IF (SELECT s.status FROM public.session s WHERE s.id = anonymize_user_in_session.session) IN ('CREATED', 'INVITED', 'ACTIVE') THEN
      PERFORM app.session_set_status(anonymize_user_in_session.session, 'ABANDONED');
    END IF;
    -- 2. the only PII a co-participant sees
    UPDATE public.participant SET display_name = NULL, left_at = coalesce(left_at, now()) WHERE session_id = sid AND user_id = uid;
    -- 3. the leaver's private-only rows (D9)
    DELETE FROM public.conversation WHERE session_id = sid AND user_id = uid;           -- cascades its messages
    DELETE FROM public.conversation_read_state WHERE session_id = sid AND user_id = uid;
    DELETE FROM public.draft WHERE session_id = sid AND user_id = uid;
    DELETE FROM public.ai_memory WHERE session_id = sid AND user_id = uid;
    DELETE FROM public.mood_reading WHERE session_id = sid AND user_id = uid;
    DELETE FROM public.regulation_event WHERE session_id = sid AND user_id = uid;
    DELETE FROM public.need_disposition WHERE session_id = sid AND user_id = uid;
    DELETE FROM public.follow_up_note WHERE session_id = sid AND user_id = uid;
    DELETE FROM public.need n WHERE n.session_id = sid AND n.user_id = uid
      AND NOT EXISTS (SELECT 1 FROM public.need_share s WHERE s.need_id = n.id);
    DELETE FROM public.proposal_choice c WHERE c.session_id = sid AND c.user_id = uid
      AND NOT EXISTS (SELECT 1 FROM public.participant_milestone m
                      WHERE m.session_id = sid AND m.user_id = uid AND m.milestone_key = 'choices_shared');
    DELETE FROM public.follow_up_checkin c USING public.follow_up f
      WHERE c.follow_up_id = f.id AND f.scope = 'INDIVIDUAL' AND c.session_id = sid AND c.user_id = uid;
    DELETE FROM public.empathy_attempt WHERE session_id = sid AND author_user_id = uid AND revealed_at IS NULL;  -- cascades results, offers, reviews
    -- 4. full prompts in plaintext: the participant's own rows, and (ruling
    -- R17) every row of the session with no participant — migrated history
    -- (BrainActivity had no user column) cannot be attributed; deleting the
    -- partner's telemetry too is acceptable, leaking the leaver's prompts is not
    DELETE FROM public.brain_activity
    WHERE session_id = sid AND (participant_user_id = uid OR participant_user_id IS NULL);
    -- 7. the participant-key shred
    UPDATE public.participant_key SET destroyed_at = now() WHERE session_id = sid AND user_id = uid AND destroyed_at IS NULL;
  END
  $$;
-- Not mwf_app: the job is its only caller (session-deletion.ts). mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.anonymize_user_in_session(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.anonymize_user_in_session(uuid, uuid) TO job_access;

-- app.anonymize_user_account(user): the complete walk (spec §4, P1-13).
-- The user themself (identity-bound, never NULL) or the job.
CREATE FUNCTION app.anonymize_user_account("user" uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_job boolean := session_user IN ('mwf_job', 'mwf_migrator');
    v_me  uuid := app.current_user_id();
    v_uid uuid := anonymize_user_account."user";
    r     record;
  BEGIN
    IF NOT (v_job OR coalesce(v_me IS NOT NULL AND v_uid = v_me, false))
       OR NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = v_uid AND u.kind = 'human') THEN
      -- only an account is deleted: the AI row and a persona are not (a persona goes with its owner, 6b)
      RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
    END IF;
    -- 1–4, 7 (participant keys) per session
    FOR r IN SELECT p.session_id FROM public.participant p WHERE p.user_id = v_uid ORDER BY p.session_id LOOP
      PERFORM app.anonymize_user_in_session(r.session_id, v_uid);
    END LOOP;
    -- 4. reflection telemetry (participant telemetry went per session)
    DELETE FROM public.brain_activity b USING public.reflection x WHERE b.reflection_id = x.id AND x.user_id = v_uid;
    -- 5. U-class material
    DELETE FROM public.reflection WHERE user_id = v_uid;          -- cascades messages, takeaways, links
    DELETE FROM public.feature_state WHERE user_id = v_uid;
    DELETE FROM public.user_memory WHERE user_id = v_uid;
    DELETE FROM public.user_device WHERE user_id = v_uid;
    DELETE FROM public.user_preferences WHERE user_id = v_uid;
    DELETE FROM public.reminder WHERE user_id = v_uid;
    DELETE FROM public.ai_memory WHERE user_id = v_uid;
    -- work-k5fk.2: the user's own nicknames for others (user_contact; the old relationship_member row went with the
    -- account). A contact's entry FOR this user is the contact's own data and stays.
    DELETE FROM public.user_contact WHERE user_id = v_uid;
    -- 6. the tombstone: the sign-in identities go (the subject can never
    -- resolve again; a later sign-in with it is a new first login), the row is scrubbed
    DELETE FROM public.user_identity WHERE user_id = v_uid;
    UPDATE public."user"
    SET email = 'deleted+' || v_uid::text || '@invalid', first_name = NULL, last_name = NULL, deleted_at = coalesce(deleted_at, now())
    WHERE id = v_uid;
    -- 6b. the user's personas: their names are the owner's words about someone; scrubbed and soft-deleted with the owner
    UPDATE public."user" u
    SET first_name = NULL, last_name = NULL, deleted_at = coalesce(u.deleted_at, now())
    FROM public.persona p
    WHERE p.owner_user_id = v_uid AND u.id = p.user_id;
    -- 7. the user-key shred
    UPDATE public.user_key SET destroyed_at = now() WHERE user_id = v_uid AND destroyed_at IS NULL;
  END
  $$;
-- Not mwf_app: the job is its only caller (account-deletion.ts). mwf_job (job_access): the job's calls; the body runs as its owner, mwf_definer.
REVOKE EXECUTE ON FUNCTION app.anonymize_user_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.anonymize_user_account(uuid) TO job_access;

-- Pre-identity bootstrap (P3 §5; work-k5fk.1): resolve a (provider, subject)
-- to its live user; create the user and its identity for a first login
-- (mwf_auth only). Neither ever re-binds: an identity is attached only to the
-- user created with it (work-jv9y, work-bp5m).
CREATE FUNCTION app.resolve_user(provider public.identity_provider, subject text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT u.id FROM public.user_identity i JOIN public."user" u ON u.id = i.user_id
    WHERE i.provider = resolve_user.provider AND i.subject = resolve_user.subject AND u.deleted_at IS NULL
  $$;
COMMENT ON FUNCTION app.resolve_user(public.identity_provider, text) IS 'The live (not deleted) user a sign-in identity belongs to, or NULL. mwf_auth''s per-request lookup (middleware/auth.ts); mwf_app has no privilege on user_identity.';
-- mwf_auth (auth_access): every authenticated request's lookup, and the one that precedes first-login creation. No app caller.
REVOKE EXECUTE ON FUNCTION app.resolve_user(public.identity_provider, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_user(public.identity_provider, text) TO auth_access;

-- app.create_user: the human row and its identity, in one call, for the
-- clerk provider only (the E2E bypass's e2e identities are written by the
-- tooling connection, never through this function: refused with MWF02). A
-- unique_violation is resolved in exactly one way: the SAME identity of a live
-- user was created by a concurrent first login — return its user. If the
-- email belongs to another account, refuse with SQLSTATE MWF01 and the
-- holder's id as DETAIL (for the caller's auth.identity_conflict log only —
-- never a decision input, never the email); nothing is re-bound. If neither
-- holds any more (the holder was tombstoned in between), the insert is tried
-- once more; a second collision re-raises the original unique_violation.
-- Class MW is the app's own (session_archive uses MWA00–MWA03).
-- The INSERTs into "user" and user_identity are the owner's (mwf_definer,
-- NOLOGIN; work-k5fk.10.4): no runtime login holds INSERT on either, so no
-- login can create or re-bind an account outside this function.
CREATE FUNCTION app.create_user(provider public.identity_provider, subject text, email text,
                                first_name text DEFAULT NULL, last_name text DEFAULT NULL)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_id     uuid;
    v_holder uuid;
  BEGIN
    IF create_user.provider IS DISTINCT FROM 'clerk' THEN
      RAISE EXCEPTION 'create_user: only the clerk provider signs up here' USING ERRCODE = 'MWF02';
    END IF;
    FOR attempt IN 1..2 LOOP
      BEGIN
        INSERT INTO public."user" (email, first_name, last_name)
        VALUES (create_user.email, create_user.first_name, create_user.last_name)
        RETURNING id INTO v_id;
        INSERT INTO public.user_identity (provider, subject, user_id)
        VALUES (create_user.provider, create_user.subject, v_id);
        RETURN v_id;
      EXCEPTION WHEN unique_violation THEN
        SELECT u.id INTO v_id FROM public.user_identity i JOIN public."user" u ON u.id = i.user_id
        WHERE i.provider = create_user.provider AND i.subject = create_user.subject AND u.deleted_at IS NULL;
        IF FOUND THEN RETURN v_id; END IF;
        SELECT u.id INTO v_holder FROM public."user" u WHERE u.email = create_user.email;
        IF FOUND THEN
          RAISE EXCEPTION 'first login refused: the email belongs to another account'
            USING ERRCODE = 'MWF01', DETAIL = v_holder::text;
        END IF;
        IF attempt = 2 THEN RAISE; END IF;
      END;
    END LOOP;
    RETURN NULL;  -- not reached: the second attempt returns or raises
  END
  $$;
COMMENT ON FUNCTION app.create_user(public.identity_provider, text, text, text, text) IS 'First login (clerk only; MWF02 otherwise): a human user (canonical email) and its identity. The same identity of a live user created concurrently returns that user; an email held by another account raises MWF01 with the holder''s id as DETAIL (for logging only) — never a re-bind.';
-- mwf_auth (auth_access) only: first-login creation.
REVOKE EXECUTE ON FUNCTION app.create_user(public.identity_provider, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_user(public.identity_provider, text, text, text, text) TO auth_access;

-- The message counter (work-k5fk.4, design note §5): the next seq of a
-- conversation, taken under its row's lock by one UPDATE … RETURNING, so two
-- inserts into one conversation queue and a rolled-back insert returns its
-- number with the rest of its transaction. Definer, so the counter column is
-- written by its owner only: no runtime role holds UPDATE (next_seq) but the
-- owner, and none is granted EXECUTE — the one caller is t_message_seq (T5),
-- itself owned by mwf_definer. A missing conversation returns NULL, and the NOT
-- NULL on message.seq refuses the row (the FK would refuse it anyway).
CREATE FUNCTION app.next_message_seq(conversation uuid) RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    UPDATE public.conversation SET next_seq = next_seq + 1 WHERE id = next_message_seq.conversation
    RETURNING next_seq - 1
  $$;
COMMENT ON FUNCTION app.next_message_seq(uuid) IS 'The next message seq of a conversation (work-k5fk.4): advances conversation.next_seq under the row''s lock and returns the number taken. Called only by t_message_seq; no runtime role may EXECUTE it.';
-- No grant: t_message_seq (owned by mwf_definer, as this is) is its only caller.
REVOKE EXECUTE ON FUNCTION app.next_message_seq(uuid) FROM PUBLIC;

-- Hand the definer functions to the NOLOGIN mwf_definer (work-k5fk.10.4; TS-1 order, measured there with a
-- non-superuser migrator): CREATE on the schema for the hand-over only. Their
-- EXECUTE grants were issued above, next to each function, by the migrator as
-- owner; ALTER OWNER rewrites each ACL to the new owner (grantee and grantor),
-- which is exactly what issuing them AS the owner after the hand-over produced
-- before work-k5fk.7 (app-grants.target.test.ts privilege matrix; pg_proc.proacl
-- byte-identical).
GRANT CREATE ON SCHEMA app TO mwf_definer;
ALTER FUNCTION app.is_member(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.partner_user_id(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.empathy_direction_status() OWNER TO mwf_definer;
ALTER FUNCTION app.session_set_status(uuid, public.session_status) OWNER TO mwf_definer;
ALTER FUNCTION app.session_archive(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) OWNER TO mwf_definer;
ALTER FUNCTION app.need_share(uuid, text) OWNER TO mwf_definer;
ALTER FUNCTION app.need_revoke_share(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.anonymize_user_in_session(uuid, uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.anonymize_user_account(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.resolve_user(public.identity_provider, text) OWNER TO mwf_definer;
ALTER FUNCTION app.create_user(public.identity_provider, text, text, text, text) OWNER TO mwf_definer;
ALTER FUNCTION app.next_message_seq(uuid) OWNER TO mwf_definer;
REVOKE CREATE ON SCHEMA app FROM mwf_definer;

-- ---------------------------------------------------------------------------
-- T5. Triggers (spec §5 "Lives only in migration SQL"; §7). Invoker rights
-- throughout — T-consent-owner must be (N-4), and the others need no more
-- than their caller can see — except work-k5fk.2's three participant / pair
-- triggers (definer, said where they are), with search_path pinned and every relation
-- qualified, so a caller's temp table cannot stand in for a real one. No
-- caller needs EXECUTE on a trigger function (PostgreSQL checks it only at
-- CREATE TRIGGER); EXECUTE is revoked from PUBLIC below.
-- ---------------------------------------------------------------------------

-- T-cardinality-1: → ACTIVE needs ≥2 participants with ≥1 live human (D1).
CREATE FUNCTION app.t_session_cardinality() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.status = 'ACTIVE' AND OLD.status IS DISTINCT FROM 'ACTIVE'
       AND ((SELECT count(*) FROM public.participant p WHERE p.session_id = NEW.id) < 2
            OR NOT EXISTS (SELECT 1 FROM public.participant p WHERE p.session_id = NEW.id AND p.kind = 'human' AND p.left_at IS NULL)) THEN
      RAISE EXCEPTION 'a session becomes ACTIVE only with two participants, one of them a present human'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_session_cardinality() FROM PUBLIC;
CREATE TRIGGER t_cardinality_1 BEFORE UPDATE OF status ON public.session
  FOR EACH ROW EXECUTE FUNCTION app.t_session_cardinality();

-- T-cardinality-2 (deferred): a non-terminal session never loses its last present human.
CREATE FUNCTION app.t_participant_cardinality() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.session s WHERE s.id = OLD.session_id AND s.status NOT IN ('RESOLVED', 'ABANDONED', 'ARCHIVED'))
       AND NOT EXISTS (SELECT 1 FROM public.participant p WHERE p.session_id = OLD.session_id AND p.kind = 'human' AND p.left_at IS NULL) THEN
      RAISE EXCEPTION 'a live session must keep a present human participant' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_participant_cardinality() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER t_cardinality_2 AFTER DELETE OR UPDATE OF kind, user_id, left_at ON public.participant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.t_participant_cardinality();

-- T-message-immutable: routing columns (the key (conversation_id, seq) among them, work-k5fk.4) and the once-only dedupe_key (work-fdc1)
-- never change; content of AI/SYSTEM rows and of every delivered kind never
-- changes, except by the job (W13 re-encryption).
CREATE FUNCTION app.t_message_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.seq IS DISTINCT FROM OLD.seq
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
       OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key THEN
      RAISE EXCEPTION 'message routing is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.content IS DISTINCT FROM OLD.content AND (OLD.role IN ('AI', 'SYSTEM') OR OLD.kind <> 'CHAT')
       AND session_user NOT IN ('mwf_job', 'mwf_migrator') THEN
      RAISE EXCEPTION 'this message''s content is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_message_immutable() FROM PUBLIC;
CREATE TRIGGER t_message_immutable BEFORE UPDATE ON public.message
  FOR EACH ROW EXECUTE FUNCTION app.t_message_immutable();

-- T-message-app (work-k5fk.10.2, review round 1 M2): the rows mwf_app may insert into and
-- delete from message. Its grants (tables.sql) cannot narrow rows; until RLS (design note §6,
-- rows 9d–9g) these do. They bind every role that holds app_access's privileges (work-k5fk.10.22:
-- pg_has_role USAGE — a member with INHERIT, or app_access itself after a SET ROLE), not the login
-- named mwf_app, so a second login mapped onto app_access is narrowed too; a superuser (fixtures,
-- tooling) is not. Keyed on current_user, not session_user: a SECURITY DEFINER function the app
-- calls (app.empathy_set_status, owned by mwf_definer, a member of nothing) writes the subject's
-- delivered copy with the owner's rights, and that write is the job's, not the app's.
--   INSERT: only the participant's own USER turn (CHAT; message-store createParticipantMessage)
--     and its own EMPATHY_STATEMENT copy (empathy-messages ownStatementCopy), sent by the
--     participant that owns the conversation;
--   DELETE: only that participant's own USER CHAT turn (a failed stream turn,
--     stream-turn-persistence.ts) or a SHARE_SUGGESTION (reconciler/sharing.ts decline/accept).
-- Both also require, when the request's identity is bound (app.current_user_id() not NULL),
-- that the conversation's participant is that user. FINDING: with identity binding off — the
-- default outside e2e/goldens until §7 row 9c turns DB_IDENTITY_BINDING on — "whose
-- conversation" is not determinable in the database, so the row shape is all these enforce.
-- Both rely on mwf_migrator (not a runtime role) owning message: a cascaded delete (session /
-- conversation ON DELETE CASCADE) runs its referential-integrity DELETE on message as the owner of
-- the referencing table — message — so current_user there is mwf_migrator (no member of app_access)
-- and the early return lets it through. Were mwf_app the owner again, every cascade (the job's session retention, account
-- deletion) would run as mwf_app and be refused here: the triggers assume no runtime role owns them.
-- app.current_user_id() is read only after the early return, so other roles (job_access, and the
-- ai_access / worker_access of §7 row 9b) need no EXECUTE on it to write.
CREATE FUNCTION app.t_message_app_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_owner      uuid;
    v_owner_user uuid;
    v_me         uuid;
  BEGIN
    IF NOT pg_catalog.pg_has_role(current_user, 'app_access', 'USAGE')
       OR (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN NEW;
    END IF;
    v_me := app.current_user_id();
    IF NEW.role <> 'USER' OR NEW.kind NOT IN ('CHAT', 'EMPATHY_STATEMENT') THEN
      RAISE EXCEPTION 'the app writes only its own USER turns and statement copies, not % %', NEW.role, NEW.kind
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT c.user_id INTO v_owner FROM public.conversation c WHERE c.id = NEW.conversation_id;
    v_owner_user := v_owner;
    IF NEW.sender_user_id IS DISTINCT FROM v_owner
       OR (v_me IS NOT NULL AND v_owner_user IS DISTINCT FROM v_me) THEN
      RAISE EXCEPTION 'the app writes only as the participant that owns the conversation'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_message_app_insert() FROM PUBLIC;
CREATE TRIGGER t_message_app_insert BEFORE INSERT ON public.message
  FOR EACH ROW EXECUTE FUNCTION app.t_message_app_insert();

CREATE FUNCTION app.t_message_app_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_owner      uuid;
    v_owner_user uuid;
    v_me         uuid;
  BEGIN
    IF NOT pg_catalog.pg_has_role(current_user, 'app_access', 'USAGE')
       OR (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN OLD;
    END IF;
    v_me := app.current_user_id();
    SELECT c.user_id INTO v_owner FROM public.conversation c WHERE c.id = OLD.conversation_id;
    v_owner_user := v_owner;
    IF NOT ((OLD.role = 'USER' AND OLD.kind = 'CHAT' AND OLD.sender_user_id = v_owner)
            OR OLD.kind = 'SHARE_SUGGESTION')
       OR (v_me IS NOT NULL AND v_owner_user IS DISTINCT FROM v_me) THEN
      RAISE EXCEPTION 'the app deletes only its own failed turn or a share suggestion of its own conversation'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_message_app_delete() FROM PUBLIC;
CREATE TRIGGER t_message_app_delete BEFORE DELETE ON public.message
  FOR EACH ROW EXECUTE FUNCTION app.t_message_app_delete();

-- Retired by work-k5fk.3: t_attempt_same_session (author and subject share a
-- session), t_review_subject (the reviewer is the attempt's subject),
-- t_need_share_owner (a share carries its need owner's session and user) and
-- t_participant_kind (participant.kind is the user's) are keys now: every
-- participant reference is FOREIGN KEY (session_id, x_user_id) REFERENCES
-- participant (session_id, user_id), so two references on one row share its one
-- session_id; empathy_review / need_share pin to empathy_attempt (id, session_id,
-- subject_user_id) / need (id, session_id, user_id); participant (user_id, kind)
-- references "user" (id, kind) (tables.sql). participant-key.target.test.ts keeps
-- each retired trigger's refusal.

-- T-consent-owner: the decider owns the arc target. Invoker rights, so under
-- the caller's RLS a partner's row and a missing row look the same; one fixed
-- message with no ids (N-4).
CREATE FUNCTION app.t_consent_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_owner uuid;
  BEGIN
    IF NEW.need_id IS NOT NULL THEN
      SELECT n.user_id INTO v_owner FROM public.need n WHERE n.id = NEW.need_id;
    ELSIF NEW.empathy_attempt_id IS NOT NULL THEN
      SELECT a.author_user_id INTO v_owner FROM public.empathy_attempt a WHERE a.id = NEW.empathy_attempt_id;
    ELSIF NEW.proposal_id IS NOT NULL THEN
      SELECT p.created_by_user_id INTO v_owner FROM public.proposal p WHERE p.id = NEW.proposal_id;
    ELSIF NEW.share_offer_id IS NOT NULL THEN
      SELECT o.subject_user_id INTO v_owner FROM public.context_share_offer o WHERE o.id = NEW.share_offer_id;
    ELSIF NEW.review_id IS NOT NULL THEN
      SELECT r.reviewer_user_id INTO v_owner FROM public.empathy_review r WHERE r.id = NEW.review_id;
    END IF;
    -- the target is of the consent's session by key (the arc FKs carry session_id), so the owner's user decides
    IF v_owner IS NULL OR v_owner <> NEW.user_id THEN
      RAISE EXCEPTION 'consent target is not yours' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_consent_owner() FROM PUBLIC;
CREATE TRIGGER t_consent_owner BEFORE INSERT OR UPDATE ON public.consent
  FOR EACH ROW EXECUTE FUNCTION app.t_consent_owner();

-- T-consent-transitions: decision moves only NULL → GRANTED | DENIED,
-- GRANTED → REVOKED; decided_at moves only with the first decision and
-- revoked_at only with the revocation (both are otherwise pinned).
CREATE FUNCTION app.t_consent_transitions() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.decision = 'REVOKED' OR NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'a consent is not created revoked' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.decision IS NOT DISTINCT FROM OLD.decision THEN
      IF NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'decided_at and revoked_at change only with the decision' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.decision IS NULL AND NEW.decision IN ('GRANTED', 'DENIED') THEN
      IF NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'a first decision is not a revocation' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.decision = 'GRANTED' AND NEW.decision = 'REVOKED' THEN
      IF NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'a revocation keeps decided_at and records revoked_at' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'consent decision % → % is not permitted', OLD.decision, NEW.decision USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_consent_transitions() FROM PUBLIC;
CREATE TRIGGER t_consent_transitions BEFORE INSERT OR UPDATE ON public.consent
  FOR EACH ROW EXECUTE FUNCTION app.t_consent_transitions();

-- T-need-share-terminal: the delivered text and its pins never change;
-- revoked_at moves only NULL → value (P3 §4, re-homed).
CREATE FUNCTION app.t_need_share_terminal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.need_id IS DISTINCT FROM OLD.need_id OR NEW.shared_text IS DISTINCT FROM OLD.shared_text
       OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.category IS DISTINCT FROM OLD.category OR NEW.shared_at IS DISTINCT FROM OLD.shared_at
       OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION 'a shared need is immutable; revocation is terminal' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_need_share_terminal() FROM PUBLIC;
CREATE TRIGGER t_need_share_terminal BEFORE UPDATE ON public.need_share
  FOR EACH ROW EXECUTE FUNCTION app.t_need_share_terminal();

-- T-result-live-attempt: no result on a SUPERSEDED round. (The subject = the attempt's
-- subject half is a key since work-k5fk.3 (6a): reconciler_result (attempt_id,
-- session_id, subject_user_id) REFERENCES empathy_attempt (id, session_id, subject_user_id).)
CREATE FUNCTION app.t_result_live_attempt() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.empathy_attempt a
                   WHERE a.id = NEW.attempt_id AND a.status <> 'SUPERSEDED') THEN
      RAISE EXCEPTION 'a reconciler result needs a live attempt' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_result_live_attempt() FROM PUBLIC;
CREATE TRIGGER t_result_live_attempt BEFORE INSERT ON public.reconciler_result
  FOR EACH ROW EXECUTE FUNCTION app.t_result_live_attempt();

-- T-agreement-parties (deferred): at commit, the parties of an agreement are
-- exactly the session's human participants present when it was created
-- (left_at IS NULL or later than created_at — a leaver/tombstone who was
-- present stays a party, spec §4 "what survives … agreement_party"), each
-- WILLING on the proposal (D4; "what the 2-participant system does, applied
-- across N"). The predicate is app.agreement_parties_ok, used by the trigger
-- (inlined, so no caller needs EXECUTE on it); kept as a callable predicate
-- for operators and tests.
CREATE FUNCTION app.agreement_parties_ok(agreement uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT NOT EXISTS (SELECT 1 FROM public.agreement ag WHERE ag.id = agreement_parties_ok.agreement)
        OR (SELECT NOT EXISTS (SELECT ap.user_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id
                               EXCEPT SELECT p.user_id FROM public.participant p
                                      WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                        AND (p.left_at IS NULL OR p.left_at > ag.created_at))
               AND NOT EXISTS (SELECT p.user_id FROM public.participant p
                               WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                 AND (p.left_at IS NULL OR p.left_at > ag.created_at)
                               EXCEPT SELECT ap.user_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id)
               AND NOT EXISTS (SELECT 1 FROM public.agreement_party ap
                               WHERE ap.agreement_id = ag.id
                                 AND NOT EXISTS (SELECT 1 FROM public.proposal_choice c
                                                 WHERE c.proposal_id = ag.proposal_id AND c.user_id = ap.user_id
                                                   AND c.decision = 'WILLING'))
            FROM public.agreement ag WHERE ag.id = agreement_parties_ok.agreement)
  $$;
-- No caller needs EXECUTE on the predicate of T-agreement-parties.
REVOKE EXECUTE ON FUNCTION app.agreement_parties_ok(uuid) FROM PUBLIC;
CREATE FUNCTION app.t_agreement_parties() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_agreement uuid;
    v_ok        boolean;
  BEGIN
    -- IF, not CASE: plpgsql plans a CASE as one expression, and NEW of an
    -- agreement_party row has no id (nor any NEW on DELETE).
    IF TG_TABLE_NAME = 'agreement' THEN
      v_agreement := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
      v_agreement := OLD.agreement_id;
    ELSE
      v_agreement := NEW.agreement_id;
    END IF;
    SELECT NOT EXISTS (SELECT 1 FROM public.agreement ag WHERE ag.id = v_agreement)
        OR (SELECT NOT EXISTS (SELECT ap.user_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id
                               EXCEPT SELECT p.user_id FROM public.participant p
                                      WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                        AND (p.left_at IS NULL OR p.left_at > ag.created_at))
               AND NOT EXISTS (SELECT p.user_id FROM public.participant p
                               WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                 AND (p.left_at IS NULL OR p.left_at > ag.created_at)
                               EXCEPT SELECT ap.user_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id)
               AND NOT EXISTS (SELECT 1 FROM public.agreement_party ap
                               WHERE ap.agreement_id = ag.id
                                 AND NOT EXISTS (SELECT 1 FROM public.proposal_choice c
                                                 WHERE c.proposal_id = ag.proposal_id AND c.user_id = ap.user_id
                                                   AND c.decision = 'WILLING'))
            FROM public.agreement ag WHERE ag.id = v_agreement)
      INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'an agreement names every present participant, each WILLING' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_agreement_parties() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER t_agreement_parties AFTER INSERT OR UPDATE OR DELETE ON public.agreement_party
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.t_agreement_parties();
CREATE CONSTRAINT TRIGGER t_agreement_parties_on_agreement AFTER INSERT ON public.agreement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.t_agreement_parties();

-- T-doc-schema (work-k5fk.8): the two plaintext app documents match their
-- seeded JSON schema, by the row's doc_schema_version — user_preferences.doc
-- against user_preferences, ai_memory.doc against ai_memory.<kind> (summary,
-- notable_facts, global_facts: the kind picks the schema, so a change of kind
-- re-checks). A BEFORE trigger, not a CHECK: it reads app.json_schema (a
-- CHECK must not read a table), and its message carries a location and a
-- reason but never the row (a CHECK's DETAIL would echo it). A BEFORE INSERT
-- trigger sees the proposed row, before ON CONFLICT is considered; the
-- DO UPDATE of an upsert fires it again as an UPDATE. The name is the table
-- plus, when the row has a kind, '.' and the kind in lower case (read through
-- to_jsonb(NEW), so one function serves both tables).
-- A future v2: seed (name, 2), and the writer sends doc_schema_version 2 —
-- on an upsert, SET doc_schema_version = EXCLUDED.doc_schema_version too.
CREATE FUNCTION app.t_doc_schema() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_name text := TG_TABLE_NAME || coalesce('.' || lower(to_jsonb(NEW) ->> 'kind'), '');
    v_err text;
  BEGIN
    v_err := app.jsonb_violation(NEW.doc, v_name, NEW.doc_schema_version);
    IF v_err IS NOT NULL THEN
      RAISE EXCEPTION '%.doc does not match json_schema % v%: %', TG_TABLE_NAME, v_name, NEW.doc_schema_version, v_err
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
COMMENT ON FUNCTION app.t_doc_schema() IS 'Trigger function of t_doc_schema: refuses (check_violation) a doc that does not match app.json_schema (<table>[.<kind>], doc_schema_version), with the location and reason only; MWJ01 for an unknown version.';
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_doc_schema() FROM PUBLIC;
CREATE TRIGGER t_doc_schema BEFORE INSERT OR UPDATE OF doc, doc_schema_version ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION app.t_doc_schema();
COMMENT ON TRIGGER t_doc_schema ON public.user_preferences IS 'doc matches app.json_schema user_preferences at doc_schema_version (work-k5fk.8).';
CREATE TRIGGER t_doc_schema BEFORE INSERT OR UPDATE OF kind, doc, doc_schema_version ON public.ai_memory
  FOR EACH ROW EXECUTE FUNCTION app.t_doc_schema();
COMMENT ON TRIGGER t_doc_schema ON public.ai_memory IS 'doc''s structure matches app.json_schema ai_memory.<kind> at doc_schema_version (work-k5fk.8); its string leaves are ciphertext, so only keys, types and shape are checked.';

-- T-jsonb-envelope (work-k5fk.8 review): each jsonb-envelope column named in
-- TG_ARGV is a well-formed envelope or keyless plaintext
-- (app.jsonb_envelope_violation). A trigger rather than a CHECK because a
-- CHECK refusal's DETAIL ("Failing row contains …") echoes the whole row —
-- the very plaintext this rule catches — to the client error and the server
-- log; this refusal names the column and the reason, with no DETAIL. It runs
-- before the columns' jsonb_typeof CHECKs, and refuses a non-object itself,
-- so those never see (and echo) a refused document either.
CREATE FUNCTION app.t_jsonb_envelope() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_row CONSTANT jsonb := to_jsonb(NEW);
    v_col text;
    v_err text;
  BEGIN
    FOREACH v_col IN ARRAY TG_ARGV LOOP
      -- to_jsonb renders an SQL NULL column as JSON null; both are "no document" here (a stored
      -- JSON null is left to the column's jsonb_typeof CHECK, whose echo of `null` carries nothing).
      v_err := app.jsonb_envelope_violation(nullif(v_row -> v_col, 'null'::jsonb));
      IF v_err IS NOT NULL THEN
        RAISE EXCEPTION '%.% is not a well-formed envelope: %', TG_TABLE_NAME, v_col, v_err
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END
  $$;
COMMENT ON FUNCTION app.t_jsonb_envelope() IS 'Trigger function of t_jsonb_envelope: refuses (check_violation) a jsonb-envelope column (named in the trigger arguments) that app.jsonb_envelope_violation refuses, with the column and the reason only, never the value.';
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_jsonb_envelope() FROM PUBLIC;
CREATE TRIGGER t_jsonb_envelope BEFORE INSERT OR UPDATE OF before, after ON public.proposal_revision
  FOR EACH ROW EXECUTE FUNCTION app.t_jsonb_envelope('before', 'after');
COMMENT ON TRIGGER t_jsonb_envelope ON public.proposal_revision IS 'before and after are well-formed envelopes (or keyless plaintext); work-k5fk.8.';
CREATE TRIGGER t_jsonb_envelope BEFORE INSERT OR UPDATE OF payload ON public.follow_up_checkin
  FOR EACH ROW EXECUTE FUNCTION app.t_jsonb_envelope('payload');
COMMENT ON TRIGGER t_jsonb_envelope ON public.follow_up_checkin IS 'payload is a well-formed envelope (or keyless plaintext); work-k5fk.8.';
CREATE TRIGGER t_jsonb_envelope BEFORE INSERT OR UPDATE OF summary_doc ON public.reflection
  FOR EACH ROW EXECUTE FUNCTION app.t_jsonb_envelope('summary_doc');
COMMENT ON TRIGGER t_jsonb_envelope ON public.reflection IS 'summary_doc is a well-formed envelope (or keyless plaintext); work-k5fk.8.';
CREATE TRIGGER t_jsonb_envelope BEFORE INSERT OR UPDATE OF doc ON public.feature_state
  FOR EACH ROW EXECUTE FUNCTION app.t_jsonb_envelope('doc');
COMMENT ON TRIGGER t_jsonb_envelope ON public.feature_state IS 'doc is a well-formed envelope (or keyless plaintext); work-k5fk.8.';

-- ---------------------------------------------------------------------------
-- work-k5fk.2: who is in a session, without relationship. Four trigger
-- functions are SECURITY DEFINER (owned by mwf_definer, handed over below), the
-- exception to T5's invoker rule: they read rows the inserting caller has no
-- grant on (persona) or will not see under RLS ("user" is own-row only,
-- design note §6), and they write live_session_pair, which no caller may write.
-- ---------------------------------------------------------------------------

-- T-participant-added-by: the adder (an FK-pinned participant of the same
-- session) is a human, and a persona is seated only by its owner.
-- It refuses with ONE message ('participant refused', check_violation), so a
-- refusal is no oracle for a persona's owner (review round 1, F8). The kind is
-- pinned by the FK (user_id, kind) -> "user" (work-k5fk.3), whose refusal is a
-- 23503 naming the pair: only a caller that already names a user and a kind
-- learns that they do not match, and seating is the app's own write (one per
-- path: createSession, accept, the linked process).
CREATE FUNCTION app.t_participant_added_by() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.added_by_user_id IS NULL THEN
      RETURN NEW;  -- the initiator (sql_participant_one_initiator: one per session)
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.participant a
                   WHERE a.session_id = NEW.session_id AND a.user_id = NEW.added_by_user_id AND a.kind = 'human') THEN
      RAISE EXCEPTION 'participant refused' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.persona x WHERE x.user_id = NEW.user_id AND x.owner_user_id <> NEW.added_by_user_id) THEN
      RAISE EXCEPTION 'participant refused' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
COMMENT ON FUNCTION app.t_participant_added_by() IS 'Trigger (work-k5fk.2): a participant''s adder is a human participant of the same session, and a persona''s adder is its owner.';
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_participant_added_by() FROM PUBLIC;
CREATE TRIGGER t_participant_added_by BEFORE INSERT OR UPDATE OF added_by_user_id, user_id ON public.participant
  FOR EACH ROW EXECUTE FUNCTION app.t_participant_added_by();

-- T-live-session-pair (A-Q3, owner decision Q3: DB-enforced at the second
-- human's join): a human joining a live session pairs with every other
-- present human of it. It first takes the session row FOR NO KEY UPDATE —
-- the lock session_set_status and session_archive take before a status move
-- (review round 1, F1) — so:
--   * a join and a status move on the same session serialise: a join that
--     waits behind an archive re-reads the status and pairs nothing; a status
--     move that waits behind a join sees its pair rows and releases them
--     (t_live_session_pair_end);
--   * two humans joining one session at once serialise too, so the later sees
--     the earlier's participant row and their mutual pair is written.
-- Across sessions the PRIMARY KEY of live_session_pair is the serialisation
-- point: of two sessions whose second humans join at once, the later INSERT
-- fails with unique_violation (23505, live_session_pair_pkey) and its whole
-- transaction (the accept) rolls back. Lock order is the accept's: invitation
-- (lockInvitationForAccept), then session. INSERT only: a participant's user
-- and kind never change once seated (they are the primary key and its kind pin;
-- the pair's FKs hold a paired user_id in place); a later left_at does not
-- release a pair (work-k5fk follow-up for N-party leave).
CREATE FUNCTION app.t_live_session_pair() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    PERFORM 1 FROM public.session s
    WHERE s.id = NEW.session_id AND s.status NOT IN ('RESOLVED', 'ABANDONED', 'ARCHIVED')
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN NULL;  -- not a live session (or it stopped being one while we waited): nothing to pair
    END IF;
    INSERT INTO public.live_session_pair (user_a, user_b, session_id)
    SELECT least(NEW.user_id, o.user_id), greatest(NEW.user_id, o.user_id), NEW.session_id
    FROM public.participant o
    WHERE o.session_id = NEW.session_id AND o.kind = 'human' AND o.left_at IS NULL AND o.user_id <> NEW.user_id;
    RETURN NULL;
  END
  $$;
COMMENT ON FUNCTION app.t_live_session_pair() IS 'Trigger (work-k5fk.2): a human joining a live session inserts one live_session_pair row per other present human of it; a second live session for the same pair fails there with unique_violation (live_session_pair_pkey).';
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_live_session_pair() FROM PUBLIC;
CREATE TRIGGER t_live_session_pair AFTER INSERT ON public.participant
  FOR EACH ROW WHEN (NEW.kind = 'human' AND NEW.left_at IS NULL) EXECUTE FUNCTION app.t_live_session_pair();

-- T-live-session-pair-end: a session that stops being live releases its
-- pairs. Nothing leaves RESOLVED, ABANDONED or ARCHIVED for a live state
-- (session_set_status), so a released pair never comes back.
CREATE FUNCTION app.t_live_session_pair_end() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    DELETE FROM public.live_session_pair p WHERE p.session_id = NEW.id;
    RETURN NULL;
  END
  $$;
COMMENT ON FUNCTION app.t_live_session_pair_end() IS 'Trigger (work-k5fk.2): when a session goes RESOLVED, ABANDONED or ARCHIVED its live_session_pair rows are deleted, so the pair may start a new session.';
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_live_session_pair_end() FROM PUBLIC;
CREATE TRIGGER t_live_session_pair_end AFTER UPDATE OF status ON public.session
  FOR EACH ROW WHEN (NEW.status IN ('RESOLVED', 'ABANDONED', 'ARCHIVED') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.t_live_session_pair_end();

-- The hand-over of the three definer trigger functions (as T4's, above).
GRANT CREATE ON SCHEMA app TO mwf_definer;
ALTER FUNCTION app.t_participant_added_by() OWNER TO mwf_definer;
ALTER FUNCTION app.t_live_session_pair() OWNER TO mwf_definer;
ALTER FUNCTION app.t_live_session_pair_end() OWNER TO mwf_definer;
REVOKE CREATE ON SCHEMA app FROM mwf_definer;

-- ---------------------------------------------------------------------------
-- work-k5fk.4: a message is (conversation_id, seq). t_message_seq numbers an
-- INSERT that leaves seq NULL — every runtime writer: no role is granted
-- INSERT (seq) — from app.next_message_seq. SECURITY DEFINER (owned by mwf_definer)
-- like the k5fk.2 triggers above, the exception to T5's invoker rule: the
-- helper is executable by its owner alone, so neither the app nor the job
-- login can take numbers outside an INSERT (a taken number with no row is a
-- hole). It runs after t_message_app_insert (name order), which reads
-- nothing seq-dependent. An ON CONFLICT DO NOTHING insert (createFacilitatorMessageOnce)
-- takes its number before the conflict is found, so a duplicate once-only
-- line leaves a hole too: seq orders, it does not count.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.t_message_seq() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    NEW.seq := app.next_message_seq(NEW.conversation_id);
    RETURN NEW;
  END
  $$;
COMMENT ON FUNCTION app.t_message_seq() IS 'Trigger (work-k5fk.4): a message inserted without seq takes its conversation''s next one (app.next_message_seq).';
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_message_seq() FROM PUBLIC;
CREATE TRIGGER t_message_seq BEFORE INSERT ON public.message
  FOR EACH ROW WHEN (NEW.seq IS NULL) EXECUTE FUNCTION app.t_message_seq();
COMMENT ON TRIGGER t_message_seq ON public.message IS 'Numbers the line in its conversation (work-k5fk.4).';
GRANT CREATE ON SCHEMA app TO mwf_definer;
ALTER FUNCTION app.t_message_seq() OWNER TO mwf_definer;
REVOKE CREATE ON SCHEMA app FROM mwf_definer;

-- T-conversation-seq-start: a new conversation's counter starts at 1, whatever
-- the INSERT sent (a Prisma create sends the column's @default; mwf_app holds
-- INSERT (next_seq) for that, so the trigger, not the grant, is the rule).
CREATE FUNCTION app.t_conversation_seq_start() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$ BEGIN NEW.next_seq := 1; RETURN NEW; END $$;
COMMENT ON FUNCTION app.t_conversation_seq_start() IS 'Trigger (work-k5fk.4): conversation.next_seq is 1 on insert.';
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_conversation_seq_start() FROM PUBLIC;
CREATE TRIGGER t_conversation_seq_start BEFORE INSERT ON public.conversation
  FOR EACH ROW EXECUTE FUNCTION app.t_conversation_seq_start();
COMMENT ON TRIGGER t_conversation_seq_start ON public.conversation IS 'A new conversation numbers its messages from 1 (work-k5fk.4).';

-- touch_updated_at on the 34 tables that have updated_at (T8 asserts the set
-- equals the catalog's). message and takeaway_link have none.
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON agreement FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON ai_memory FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON brain_activity FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON consent FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON context_share_offer FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- conversation: not when the update is the message counter (app.next_message_seq; work-k5fk.4) — a new line is not a change of the thread
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON conversation
  FOR EACH ROW WHEN (OLD.next_seq IS NOT DISTINCT FROM NEW.next_seq) EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON conversation_read_state FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON draft FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON empathy_attempt FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON empathy_review FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON feature_state FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON follow_up FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON follow_up_note FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON invitation FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON milestone FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON need FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON need_disposition FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON need_share FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON participant FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON participant_key FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON proposal FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON proposal_choice FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON reconciler_result FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON reflection FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON reminder FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON session FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON session_key FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON takeaway FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON user_contact FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON user_device FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON user_key FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON user_memory FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- T6. Views (spec §4): plain views, security_invoker = true, so the RLS of
-- the underlying tables applies to the caller (TS-16 writes the policies).
-- ---------------------------------------------------------------------------

-- participant ⋈ user ⋈ MAIN conversation ⋈ read state; last_mood = the
-- participant's latest mood_reading; last_active_at masked unless it is the
-- caller's own row or the owner allows it (privacy.showActivityStatus,
-- default true — DEFAULT_PRIVACY_PREFERENCES).
-- TS-16 NOTE: under owner-only RLS on conversation_read_state, user_preferences,
-- "user" and mood_reading, a co-participant reading this view gets NULL for
-- last_active_at, last_mood and the read state, and is_tombstone = false — and
-- coalesce(showActivityStatus, true) would default to true over a row it cannot
-- see. The partner-facing columns need a SECURITY DEFINER table function
-- (owned by mwf_definer, identity-bound) that returns (session_id, user_id) + the masked
-- last_active_at (+ last_mood if the product wants it), with no default-true
-- over an invisible row; this view then serves only the caller's own rows.
CREATE VIEW v_participant WITH (security_invoker = true) AS
SELECT p.session_id, p.user_id, p.kind,
       coalesce(p.display_name, CASE WHEN u.deleted_at IS NULL THEN u.name END) AS display_name,
       (u.deleted_at IS NOT NULL) AS is_tombstone,
       p.joined_at, p.left_at,
       c.id AS main_conversation_id,
       r.last_viewed_at, r.last_seen_conversation_id, r.last_seen_seq, r.last_viewed_share_tab_at, r.archived_at,
       CASE WHEN p.user_id = app.current_user_id()
              OR coalesce((up.doc -> 'privacy' ->> 'showActivityStatus')::boolean, true)
            THEN r.last_active_at END AS last_active_at,
       (SELECT m.intensity::integer FROM mood_reading m WHERE m.session_id = p.session_id AND m.user_id = p.user_id
        ORDER BY m.recorded_at DESC, m.id DESC LIMIT 1) AS last_mood
FROM participant p
LEFT JOIN "user" u ON u.id = p.user_id
LEFT JOIN conversation c ON c.session_id = p.session_id AND c.user_id = p.user_id AND c.kind = 'MAIN'
LEFT JOIN conversation_read_state r ON r.session_id = p.session_id AND r.user_id = p.user_id
LEFT JOIN user_preferences up ON up.user_id = p.user_id;
GRANT SELECT ON v_participant TO app_access;

-- Every other participant of the same session, one row per ordered pair (N-safe).
CREATE VIEW v_co_participant WITH (security_invoker = true) AS
SELECT p.session_id, p.user_id, o.user_id AS co_user_id, o.kind AS co_kind, o.display_name AS co_display_name,
       o.left_at AS co_left_at, o.joined_at AS co_joined_at
FROM participant p
JOIN participant o ON o.session_id = p.session_id AND o.user_id <> p.user_id;
GRANT SELECT ON v_co_participant TO app_access;

-- Session-scoped milestones: reached by every present human participant?
-- The array_agg(… uuid7 column …)::uuid[] casts in the views below keep the
-- array columns uuid[]: uncast they are uuid7[] (see the uuid7 domain, tables.sql).
CREATE VIEW v_session_readiness WITH (security_invoker = true) AS
SELECT s.id AS session_id, m.key AS milestone_key,
       coalesce(w.waiting_on, '{}') = '{}' AS all_reached,
       coalesce(w.waiting_on, '{}') AS waiting_on
FROM session s
CROSS JOIN milestone m
LEFT JOIN LATERAL (
  SELECT array_agg(p.user_id ORDER BY p.joined_at, p.user_id)::uuid[] AS waiting_on
  FROM participant p
  WHERE p.session_id = s.id AND p.kind = 'human' AND p.left_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM participant_milestone pm
                    WHERE pm.session_id = p.session_id AND pm.user_id = p.user_id AND pm.milestone_key = m.key)
) w ON true
WHERE m.scope = 'session';
GRANT SELECT ON v_session_readiness TO app_access;

-- Per participant: the furthest milestone reached (by ordinal; paused, ordinal
-- 0, is off the journey) and its stage label; the next milestone; and two
-- stage numbers (ordinal / 100 encodes the old stage): reached_stage, of the
-- furthest milestone, and active_stage, of the next one — the stage the
-- participant is working in, i.e. the old IN_PROGRESS StageProgress.stage (4
-- once the journey's last milestone is reached). The DTO shim reads active_stage.
CREATE VIEW v_current_stage WITH (security_invoker = true) AS
SELECT p.session_id, p.user_id,
       cur.key AS milestone_key, cur.ordinal, coalesce(cur.stage_label, nxt.stage_label) AS stage_label,
       coalesce(cur.ordinal / 100, 0) AS reached_stage,
       nxt.key AS next_milestone_key,
       coalesce(nxt.ordinal / 100, cur.ordinal / 100, 0) AS active_stage
FROM participant p
LEFT JOIN LATERAL (
  SELECT m.key, m.ordinal, m.stage_label
  FROM participant_milestone pm JOIN milestone m ON m.key = pm.milestone_key
  WHERE pm.session_id = p.session_id AND pm.user_id = p.user_id AND m.ordinal > 0
  ORDER BY m.ordinal DESC LIMIT 1
) cur ON true
LEFT JOIN LATERAL (
  SELECT n.key, n.ordinal, n.stage_label FROM milestone n
  WHERE n.ordinal > coalesce(cur.ordinal, 0)
  ORDER BY n.ordinal LIMIT 1
) nxt ON true;
GRANT SELECT ON v_current_stage TO app_access;
-- mwf_ops: the Neural Monitor dashboard's stage column (routes/brain.ts, stage-shim.ts).
GRANT SELECT ON v_current_stage TO ops_access;

-- Per direction: the current attempt (the live row, else the latest round)
-- with its current reconciler result, open share offer and review.
CREATE VIEW v_empathy_direction WITH (security_invoker = true) AS
SELECT a.session_id, a.author_user_id, a.subject_user_id, a.id AS attempt_id, a.round, a.status, a.revealed_at,
       r.id AS result_id, r.recommended_action, r.alignment_score,
       o.id AS share_offer_id, o.status AS share_offer_status,
       v.id AS review_id, v.validated
FROM (
  SELECT DISTINCT ON (session_id, author_user_id, subject_user_id) *
  FROM empathy_attempt
  ORDER BY session_id, author_user_id, subject_user_id, (status NOT IN ('SUPERSEDED', 'VALIDATED')) DESC, round DESC
) a
LEFT JOIN reconciler_result r ON r.attempt_id = a.id AND r.superseded_at IS NULL
LEFT JOIN LATERAL (
  SELECT * FROM context_share_offer x WHERE x.attempt_id = a.id AND x.status IN ('PENDING', 'OFFERED') ORDER BY x.iteration DESC LIMIT 1
) o ON true
LEFT JOIN empathy_review v ON v.attempt_id = a.id AND v.reviewer_user_id = a.subject_user_id;
GRANT SELECT ON v_empathy_direction TO app_access;

-- need_share alone — never joins need (pass 2 N-1).
CREATE VIEW v_need_shared WITH (security_invoker = true) AS
SELECT need_id, session_id, user_id, category, shared_text, shared_at
FROM need_share
WHERE revoked_at IS NULL;
GRANT SELECT ON v_need_shared TO app_access;

CREATE VIEW v_empathy_direction_status WITH (security_invoker = true) AS
SELECT * FROM app.empathy_direction_status();
GRANT SELECT ON v_empathy_direction_status TO app_access;

-- Per shared need: covering proposals and who is WILLING on one; COVERED
-- when every present human is, PARTIAL when some are, OPEN otherwise.
-- Ruling R20 (2026-10-21; owner may veto): a proposal covers while ACTIVE,
-- REVISED or CONVERTED_TO_AGREEMENT. An agreed proposal covers at least as
-- much as an active one: stage4.ts ~1426 converts the agreed proposals in
-- the closure transaction. REVISED is a live state: the old app revises the
-- same row in place (stage4-capture.service.ts:675-684, :841-855), its links
-- move with it (:707, :877), and its readers treat REVISED as ACTIVE (:291,
-- :494).
CREATE VIEW v_need_coverage WITH (security_invoker = true) AS
SELECT ns.session_id, ns.need_id, ns.user_id AS need_owner_user_id,
       coalesce(cov.proposal_ids, '{}') AS covering_proposal_ids,
       coalesce(w.willing, '{}') AS willing_user_ids,
       CASE WHEN cardinality(coalesce(w.willing, '{}')) = 0 THEN 'OPEN'
            WHEN cardinality(w.willing) >= h.n THEN 'COVERED'
            ELSE 'PARTIAL' END AS status
FROM need_share ns
LEFT JOIN LATERAL (
  SELECT array_agg(pr.id ORDER BY pr.created_at, pr.id)::uuid[] AS proposal_ids
  FROM proposal_need pn JOIN proposal pr ON pr.id = pn.proposal_id
  WHERE pn.need_id = ns.need_id AND pr.status IN ('ACTIVE', 'REVISED', 'CONVERTED_TO_AGREEMENT')
) cov ON true
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT c.user_id)::uuid[] AS willing
  FROM proposal_need pn
  JOIN proposal pr ON pr.id = pn.proposal_id AND pr.status IN ('ACTIVE', 'REVISED', 'CONVERTED_TO_AGREEMENT')
  JOIN proposal_choice c ON c.proposal_id = pr.id AND c.decision = 'WILLING'
  JOIN participant p ON p.session_id = c.session_id AND p.user_id = c.user_id AND p.kind = 'human' AND p.left_at IS NULL
  WHERE pn.need_id = ns.need_id
) w ON true
CROSS JOIN LATERAL (
  SELECT count(*) AS n FROM participant p WHERE p.session_id = ns.session_id AND p.kind = 'human' AND p.left_at IS NULL
) h
WHERE ns.revoked_at IS NULL;
GRANT SELECT ON v_need_coverage TO app_access;

-- The three Stage4Closure arrays, computed (never an unshared need id). An
-- open need is a live share with an OPEN disposition or no covering proposal
-- (ACTIVE, REVISED or CONVERTED_TO_AGREEMENT; ruling R20, above).
CREATE VIEW v_session_closure_items WITH (security_invoker = true) AS
SELECT s.id AS session_id,
       coalesce((SELECT array_agg(ag.id ORDER BY ag.created_at, ag.id)::uuid[] FROM agreement ag WHERE ag.session_id = s.id), '{}') AS agreement_ids,
       coalesce((SELECT array_agg(pr.id ORDER BY pr.created_at, pr.id)::uuid[]
                 FROM proposal pr
                 WHERE pr.session_id = s.id AND pr.kind = 'INDIVIDUAL_COMMITMENT' AND pr.status <> 'REMOVED'
                   AND EXISTS (SELECT 1 FROM proposal_choice c
                               WHERE c.proposal_id = pr.id AND c.user_id = pr.created_by_user_id AND c.decision = 'WILLING')),
                '{}') AS individual_commitment_ids,
       coalesce((SELECT array_agg(ns.need_id ORDER BY ns.shared_at, ns.need_id)::uuid[]
                 FROM need_share ns
                 WHERE ns.session_id = s.id AND ns.revoked_at IS NULL
                   AND (EXISTS (SELECT 1 FROM need_disposition d WHERE d.need_id = ns.need_id AND d.status = 'OPEN')
                        OR NOT EXISTS (SELECT 1 FROM proposal_need pn JOIN proposal pr ON pr.id = pn.proposal_id AND pr.status IN ('ACTIVE', 'REVISED', 'CONVERTED_TO_AGREEMENT')
                                       WHERE pn.need_id = ns.need_id))),
                '{}') AS open_need_ids
FROM session s;
GRANT SELECT ON v_session_closure_items TO app_access;

-- The coordination state of a follow-up (replaces TendingCoordinationCycle).
CREATE VIEW v_follow_up_cycle WITH (security_invoker = true) AS
SELECT f.id AS follow_up_id, f.session_id, x.expected AS user_ids, x.submitted AS submitted_user_ids,
       x.waiting AS waiting_on, f.response_deadline_at,
       CASE WHEN f.status IN ('COMPLETED', 'CANCELLED') THEN 'RESOLVED'
            WHEN f.status = 'EXPIRED' THEN 'TIMED_OUT'
            WHEN cardinality(x.waiting) = 0 THEN 'READY_TO_RESOLVE'
            WHEN f.response_deadline_at IS NOT NULL AND f.response_deadline_at < now() THEN 'TIMED_OUT'
            ELSE 'WAITING_FOR_PARTNER' END AS status
FROM follow_up f
CROSS JOIN LATERAL (
  SELECT coalesce(array_agg(p.user_id ORDER BY p.joined_at, p.user_id)::uuid[], '{}') AS expected,
         coalesce(array_agg(p.user_id ORDER BY p.joined_at, p.user_id) FILTER (WHERE ck.id IS NOT NULL)::uuid[], '{}') AS submitted,
         coalesce(array_agg(p.user_id ORDER BY p.joined_at, p.user_id) FILTER (WHERE ck.id IS NULL)::uuid[], '{}') AS waiting
  FROM participant p
  LEFT JOIN follow_up_checkin ck ON ck.follow_up_id = f.id AND ck.session_id = p.session_id AND ck.user_id = p.user_id
  WHERE p.session_id = f.session_id AND p.kind = 'human' AND p.left_at IS NULL
    AND (f.scope = 'SHARED' OR p.user_id = f.owner_user_id)
) x;
GRANT SELECT ON v_follow_up_cycle TO app_access;

-- Per participant: messages in the MAIN conversation after last_viewed_at
-- (not counting the participant's own), and the latest message time.
CREATE VIEW v_conversation_unread WITH (security_invoker = true) AS
SELECT p.session_id, p.user_id, c.id AS conversation_id,
       (SELECT count(*) FROM message m
        WHERE m.conversation_id = c.id AND m.created_at > coalesce(r.last_viewed_at, '-infinity')
          AND m.sender_user_id IS DISTINCT FROM p.user_id) AS unread_count,
       (SELECT max(m.created_at) FROM message m WHERE m.conversation_id = c.id) AS latest_message_at
FROM participant p
JOIN conversation c ON c.session_id = p.session_id AND c.user_id = p.user_id AND c.kind = 'MAIN'
LEFT JOIN conversation_read_state r ON r.session_id = p.session_id AND r.user_id = p.user_id;
GRANT SELECT ON v_conversation_unread TO app_access;

-- Per (user, theme): reflections and the latest activity (replaces RecurringTheme).
CREATE VIEW v_reflection_theme WITH (security_invoker = true) AS
SELECT user_id, theme, count(*) AS reflection_count, max(updated_at) AS latest_updated_at
FROM reflection
WHERE theme IS NOT NULL
GROUP BY user_id, theme;
GRANT SELECT ON v_reflection_theme TO app_access;

-- ---------------------------------------------------------------------------
-- T7. Grants: none here (work-k5fk.7). Every grant sits next to its object:
-- table grants (every role) after each table in tables.sql, schema public's
-- USAGE before the tables there, view grants after each view (T6), EXECUTE
-- grants after each function (T4, T5), schema app's in preamble.sql.
-- app-grants.target.test.ts snapshots the privilege matrix of every role.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- T8. Catalog assertions (plan step 20). The tables are empty (OD7 baseline),
-- so the TS-7 invariant re-checks over migrated rows are gone: every
-- invariant is a trigger or a CHECK that sees every row from the first write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
  n   bigint;
BEGIN
  -- Every FK to "user" is ON DELETE RESTRICT (P3 D9).
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ' ORDER BY conname) INTO bad
  FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public."user"'::regclass AND confdeltype <> 'r';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: FK(s) to user not RESTRICT: %', bad; END IF;

  -- need_share → need is RESTRICT (N-3).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'public.need_share'::regclass
                 AND confrelid = 'public.need'::regclass AND confdeltype = 'r') THEN
    RAISE EXCEPTION 'step 20: need_share → need is not RESTRICT';
  END IF;

  -- No FK into reflection* except brain_activity.reflection_id (D2).
  SELECT string_agg(conrelid::regclass || '.' || conname, ', ' ORDER BY conname) INTO bad
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid IN ('public.reflection'::regclass, 'public.reflection_message'::regclass,
                      'public.takeaway'::regclass, 'public.takeaway_link'::regclass)
    AND conrelid NOT IN ('public.reflection'::regclass, 'public.reflection_message'::regclass,
                         'public.takeaway'::regclass, 'public.takeaway_link'::regclass)
    AND NOT (conrelid = 'public.brain_activity'::regclass AND confrelid = 'public.reflection'::regclass);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: FK(s) into reflection*: %', bad; END IF;

  -- Every jsonb column has a jsonb_typeof CHECK (inline in its CREATE TABLE in
  -- tables.sql; the catalog, not the source, is what this reads).
  SELECT string_agg(c.table_name || '.' || c.column_name, ', ' ORDER BY c.table_name, c.column_name) INTO bad
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.data_type = 'jsonb'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                    WHERE k.contype = 'c' AND k.conrelid = format('public.%I', c.table_name)::regclass
                      AND pg_get_constraintdef(k.oid) ~ ('jsonb_typeof\(' || c.column_name || '\) (= |= ANY )'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: jsonb column(s) without a jsonb_typeof CHECK: %', bad; END IF;

  -- work-k5fk.8: every jsonb-envelope column (its COMMENT says 'jsonb envelope') is guarded
  -- by a t_jsonb_envelope trigger that both fires on it (UPDATE OF) and checks it (an
  -- argument); no other column is; there are @@JSONB_ENVELOPES@@ (gen-target-migration.ts
  -- JSONB_ENVELOPES; the jest test encryption-at-rest-schema ties the set to SENSITIVE_FIELD_MAP).
  SELECT string_agg(coalesce(e.col, g.col), ', ' ORDER BY coalesce(e.col, g.col)) INTO bad
  FROM (SELECT c.relname || '.' || a.attname AS col
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        JOIN pg_catalog.pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_catalog.pg_class'::regclass AND d.objsubid = a.attnum
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'pg_catalog.jsonb'::regtype AND d.description ~ '^encrypted \([a-z-]+\): jsonb envelope') e
  FULL JOIN (SELECT c.relname || '.' || a.attname AS col
             FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (t.tgattr::int2[])
             WHERE t.tgname = 't_jsonb_envelope' AND NOT t.tgisinternal
               AND t.tgtype & (4 | 16) = (4 | 16)  -- INSERT and UPDATE
               AND a.attname = ANY (regexp_split_to_array(encode(t.tgargs, 'escape'), '\\000'))) g ON g.col = e.col
  WHERE e.col IS NULL OR g.col IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: jsonb envelope column(s) and t_jsonb_envelope triggers differ: %', bad; END IF;
  SELECT sum(t.tgnargs) INTO n FROM pg_catalog.pg_trigger t WHERE t.tgname = 't_jsonb_envelope';
  IF n IS DISTINCT FROM @@JSONB_ENVELOPES@@ THEN RAISE EXCEPTION 'step 20: t_jsonb_envelope guards % columns, expected @@JSONB_ENVELOPES@@', n; END IF;
  -- and no CHECK echoes a refused envelope's row: the rule is the trigger's alone.
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ') INTO bad FROM pg_catalog.pg_constraint
  WHERE contype = 'c' AND pg_get_constraintdef(oid) ~ 'jsonb_envelope';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: envelope CHECK(s) (their DETAIL echoes the row): %', bad; END IF;

  -- work-k5fk.8: t_doc_schema validates exactly user_preferences and ai_memory, each with a
  -- doc_schema_version; every name the trigger can derive has a version-1 schema.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE t.tgname = 't_doc_schema';
  IF bad IS DISTINCT FROM 'ai_memory, user_preferences' THEN RAISE EXCEPTION 'step 20: t_doc_schema on %, expected ai_memory, user_preferences', bad; END IF;
  SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO bad FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'doc_schema_version';
  IF bad IS DISTINCT FROM 'ai_memory, user_preferences' THEN RAISE EXCEPTION 'step 20: doc_schema_version on %, expected ai_memory, user_preferences', bad; END IF;
  SELECT string_agg(x.name, ', ' ORDER BY x.name) INTO bad
  FROM (SELECT 'user_preferences' AS name UNION ALL SELECT 'ai_memory.' || lower(e::text) FROM unnest(enum_range(NULL::ai_memory_kind)) e) x
  WHERE NOT EXISTS (SELECT 1 FROM app.json_schema j WHERE j.name = x.name AND j.version = 1);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: no version-1 json_schema for: %', bad; END IF;
  SELECT count(*) INTO n FROM app.json_schema;
  IF n <> 4 THEN RAISE EXCEPTION 'step 20: % json_schema rows, expected 4', n; END IF;

  -- Every uuid column of a table is a uuid7 (tables.sql): 32 primary keys
  -- defaulting to uuidv7() and the 103 columns that reference them.
  SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname) INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'pg_catalog.uuid'::regtype;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: uuid column(s) not typed uuid7: %', bad; END IF;
  SELECT count(*) INTO n
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'public.uuid7'::regtype;
  IF n <> @@UUID7_COLUMNS@@ THEN RAISE EXCEPTION 'step 20: % uuid7 columns, expected @@UUID7_COLUMNS@@', n; END IF;

  -- The encrypted columns (SENSITIVE_FIELD_MAP; tables.sql): @@CIPHERTEXT_COLUMNS@@ text
  -- columns typed ciphertext and @@CIPHERTEXT_ARRAYS@@ text[] columns CHECKed by
  -- app.all_ciphertext. The jest test encryption-at-rest-schema ties both sets
  -- to the map by name; these counts catch a retype here.
  SELECT count(*) INTO n
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'public.ciphertext'::regtype;
  IF n <> @@CIPHERTEXT_COLUMNS@@ THEN RAISE EXCEPTION 'step 20: % ciphertext columns, expected @@CIPHERTEXT_COLUMNS@@', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint k
  WHERE k.contype = 'c' AND pg_get_constraintdef(k.oid) ~ 'app\.all_ciphertext\(';
  IF n <> @@CIPHERTEXT_ARRAYS@@ THEN RAISE EXCEPTION 'step 20: % all_ciphertext CHECKs, expected @@CIPHERTEXT_ARRAYS@@', n; END IF;

  -- Every timestamp column of a table is a ts_ms (tables.sql): none is a plain
  -- timestamptz or timestamp (Prisma's own _prisma_migrations aside).
  SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname) INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND c.relname <> '_prisma_migrations'
    AND a.atttypid IN ('pg_catalog.timestamptz'::regtype, 'pg_catalog.timestamp'::regtype);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: timestamp column(s) not typed ts_ms: %', bad; END IF;

  -- No column (table, view, composite) and no function argument or result has
  -- an array-of-domain type: array_agg over a uuid7 column is uuid7[], which
  -- node-postgres cannot parse (the app would read the string '{…}'). Cast it
  -- back with ::uuid[] (the uuid7 domain in tables.sql explains).
  SELECT string_agg(s.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, NULL), ', '
                    ORDER BY s.nspname, c.relname, a.attname) INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid JOIN pg_type e ON e.oid = t.typelem
  WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_'
    AND a.attnum > 0 AND NOT a.attisdropped AND t.typcategory = 'A' AND e.typtype = 'd';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: column(s) of an array-of-domain type (cast to the base array, e.g. ::uuid[]): %', bad; END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO bad
  FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
  WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_'
    AND EXISTS (SELECT 1 FROM unnest(p.prorettype || coalesce(p.proallargtypes, p.proargtypes::oid[])) AS x(typ)
                JOIN pg_type t ON t.oid = x.typ JOIN pg_type e ON e.oid = t.typelem
                WHERE t.typcategory = 'A' AND e.typtype = 'd');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: function(s) with an array-of-domain argument or result (use the base array, e.g. uuid[]): %', bad; END IF;

  -- touch_updated_at on exactly the tables that have updated_at (34).
  SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO bad
  FROM (SELECT c.table_name FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
        EXCEPT
        SELECT c.relname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'touch_updated_at') d;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: tables with updated_at but no touch_updated_at: %', bad; END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgname = 'touch_updated_at';
  IF n <> 34 THEN RAISE EXCEPTION 'step 20: % touch_updated_at triggers, expected 34', n; END IF;

  -- Views are security_invoker.
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'v' AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: view(s) without security_invoker: %', bad; END IF;

  -- Every SECURITY DEFINER function and every trigger function in schema app
  -- pins search_path with pg_temp last (C1/I4: no temp-object shadowing).
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND (p.prosecdef OR p.prorettype = 'pg_catalog.trigger'::regtype)
    AND NOT coalesce('search_path=pg_catalog, public, pg_temp' = ANY (p.proconfig), false);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: app function(s) without a pinned search_path: %', bad; END IF;

  -- No SECURITY DEFINER function and no trigger function is executable by PUBLIC.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND (p.prosecdef OR p.prorettype = 'pg_catalog.trigger'::regtype)
    AND has_function_privilege('public', p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: app function(s) executable by PUBLIC: %', bad; END IF;

  -- Roles (work-k5fk.10.4; design note §6 "Roles — one per kind of actor", Q13/Q16/Q18). The runtime logins and
  -- their one capability each: grants target the capability, the login only inherits them. mwf_job -> job_access is
  -- the interim until §7 row 9b retires mwf_job. Roles are cluster-level (infra/aws/roles.sql, init-db.sh), so these
  -- read the cluster as the migration finds it and refuse a baseline over a cluster that drifted.
  DECLARE
    v_logins CONSTANT text[] := ARRAY['mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth', 'mwf_clinician', 'mwf_job'];
    v_caps   CONSTANT text[] := ARRAY['app_access', 'ai_access', 'worker_access', 'ops_access', 'auth_access',
                                      'clinician_access', 'job_access'];
    -- Reserved (review 9a F4): NOLOGIN until a call site (§7 row 9b: mwf_ai, mwf_worker) or the clinician portal
    -- (Q18) uses them; 9b flips mwf_ai / mwf_worker to LOGIN here and in roles.sql.
    v_reserved CONSTANT text[] := ARRAY['mwf_ai', 'mwf_worker', 'mwf_clinician'];
    -- What the definer bodies write (T4/T5; review 9a F3): mwf_definer's INSERT / UPDATE / DELETE grants, exactly.
    -- Reads are pinned by app-grants.target.test.ts's privilege matrix; a write beyond these widens what a
    -- definer bug, or an injection into one, can change.
    v_definer_writes CONSTANT text[] := ARRAY[
      'ai_memory:DELETE', 'brain_activity:DELETE', 'consent:UPDATE', 'conversation:DELETE', 'conversation:UPDATE',
      'conversation_read_state:DELETE', 'draft:DELETE', 'empathy_attempt:DELETE', 'empathy_attempt:INSERT',
      'empathy_attempt:UPDATE', 'feature_state:DELETE', 'follow_up_checkin:DELETE', 'follow_up_note:DELETE',
      'live_session_pair:DELETE', 'live_session_pair:INSERT', 'message:INSERT', 'mood_reading:DELETE', 'need:DELETE',
      'need_disposition:DELETE', 'need_share:INSERT', 'need_share:UPDATE', 'participant:UPDATE',
      'participant_key:UPDATE', 'proposal_choice:DELETE', 'reflection:DELETE', 'regulation_event:DELETE',
      'reminder:DELETE', 'session:UPDATE', 'user:INSERT', 'user:UPDATE', 'user_contact:DELETE', 'user_device:DELETE',
      'user_identity:DELETE', 'user_identity:INSERT', 'user_key:UPDATE', 'user_memory:DELETE',
      'user_preferences:DELETE'];
  BEGIN

  -- Every SECURITY DEFINER function in public/app is owned by the NOLOGIN mwf_definer, and it owns nothing else.
  SELECT string_agg(p.oid::regprocedure::text || ' (' || pg_get_userbyid(p.proowner) || ')', ', ' ORDER BY p.oid::regprocedure::text) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'app') AND p.prosecdef IS DISTINCT FROM (pg_get_userbyid(p.proowner) = 'mwf_definer');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: SECURITY DEFINER function(s) not owned by mwf_definer, or an invoker one owned by it: %', bad;
  END IF;
  SELECT string_agg(x.object, ', ' ORDER BY x.object) INTO bad FROM (
    SELECT 'relation ' || c.oid::regclass::text AS object FROM pg_class c WHERE c.relowner = 'mwf_definer'::regrole
    UNION ALL SELECT 'type ' || t.oid::regtype::text FROM pg_type t WHERE t.typowner = 'mwf_definer'::regrole
    UNION ALL SELECT 'schema ' || s.nspname FROM pg_namespace s WHERE s.nspowner = 'mwf_definer'::regrole) x;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: mwf_definer owns more than the definer functions: %', bad; END IF;

  -- The capability roles and mwf_definer cannot log in, carry no attribute, and are members of no role.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO bad
  FROM pg_roles r
  WHERE r.rolname IN (SELECT unnest(v_caps) UNION ALL SELECT 'mwf_definer')
    AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
         OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: capability role(s) that can log in, carry an attribute or are a member of a role: %', bad;
  END IF;

  -- Every runtime login carries no attribute — the active ones LOGIN, the reserved ones NOLOGIN — and reaches exactly
  -- one role, its capability, through pg_auth_members, directly or not (pg_has_role MEMBER: SET ROLE needs no
  -- inheritance), holding it WITH INHERIT and without SET (review 9a F1: SET ROLE app_access would make current_user
  -- the capability, which is not the login any login-keyed check expects) or ADMIN.
  SELECT string_agg(l.login || ' -> ' || coalesce(
           (SELECT string_agg(r.rolname, '+' ORDER BY r.rolname) FROM pg_roles r
            WHERE r.oid <> lr.oid AND pg_has_role(lr.oid, r.oid, 'MEMBER')), 'nothing'), ', ' ORDER BY l.login) INTO bad
  FROM unnest(v_logins, v_caps) AS l(login, capability) JOIN pg_roles lr ON lr.rolname = l.login
  WHERE lr.rolcanlogin = (l.login = ANY (v_reserved))
     OR lr.rolsuper OR lr.rolbypassrls OR lr.rolcreaterole OR lr.rolcreatedb OR lr.rolreplication
     OR ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid <> lr.oid AND pg_has_role(lr.oid, r.oid, 'MEMBER'))
        IS DISTINCT FROM ARRAY[l.capability::text]
     OR NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles c ON c.oid = m.roleid
                    WHERE m.member = lr.oid AND c.rolname = l.capability AND m.inherit_option AND NOT m.set_option
                      AND NOT m.admin_option);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: runtime login(s) not a plain member (INHERIT, no SET/ADMIN; LOGIN unless reserved) of exactly one capability (login -> reaches): %', bad;
  END IF;

  -- From the other side (review 9a F2): each capability's only member is its login, INHERIT, no SET/ADMIN; and
  -- mwf_definer's only member is mwf_migrator, SET (to hand functions over) without INHERIT or ADMIN.
  SELECT string_agg(x.role || ' <- ' || coalesce(x.members, 'nobody'), '; ' ORDER BY x.role) INTO bad FROM (
    SELECT w.role, w.want,
           (SELECT string_agg(mr.rolname || CASE WHEN m.inherit_option THEN ' inherit' ELSE '' END
                              || CASE WHEN m.set_option THEN ' set' ELSE '' END
                              || CASE WHEN m.admin_option THEN ' admin' ELSE '' END, ', ' ORDER BY mr.rolname)
            FROM pg_auth_members m JOIN pg_roles mr ON mr.oid = m.member JOIN pg_roles r ON r.oid = m.roleid
            WHERE r.rolname = w.role) AS members
    FROM (SELECT c AS role, l || ' inherit' AS want FROM unnest(v_caps, v_logins) AS u(c, l)
          UNION ALL SELECT 'mwf_definer', 'mwf_migrator set') w) x
  WHERE x.members IS DISTINCT FROM x.want;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: capability / mwf_definer members other than expected (role <- members): %', bad;
  END IF;

  -- Review 9a F3: no runtime login, capability or mwf_definer may CREATE in the database or in schema public / app
  -- (directly or inherited), and a runtime login or capability holds no ACL entry on the database but CONNECT.
  SELECT string_agg(DISTINCT r.rolname, ', ') INTO bad
  FROM pg_roles r
  WHERE r.rolname IN (SELECT unnest(v_logins || v_caps) UNION ALL SELECT 'mwf_definer')
    AND (has_database_privilege(r.oid, current_database(), 'CREATE')
         OR has_schema_privilege(r.oid, 'public', 'CREATE') OR has_schema_privilege(r.oid, 'app', 'CREATE')
         OR EXISTS (SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
                    WHERE d.datname = current_database() AND a.grantee = r.oid
                      AND (a.privilege_type <> 'CONNECT' OR r.rolname IN (SELECT unnest(v_caps) UNION ALL SELECT 'mwf_definer'))));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: role(s) that may CREATE in the database or schema public/app, or hold a database grant: %', bad;
  END IF;

  -- Review 9a F3: no runtime login or capability may EXECUTE app.next_message_seq (the counter; t_message_seq is its
  -- one caller) or any trigger function (EXECUTE is checked only at CREATE TRIGGER; a definer trigger function
  -- called directly would run as mwf_definer).
  SELECT string_agg(r.rolname || ' ' || p.oid::regprocedure::text, ', ' ORDER BY r.rolname, p.oid::regprocedure::text) INTO bad
  FROM pg_roles r, pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE r.rolname IN (SELECT unnest(v_logins || v_caps)) AND n.nspname = 'app'
    AND (p.proname = 'next_message_seq' OR p.prorettype = 'pg_catalog.trigger'::regtype)
    AND has_function_privilege(r.oid, p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: runtime role(s) that may EXECUTE an owner-only function: %', bad; END IF;

  -- Review 9a F3: mwf_definer writes exactly v_definer_writes (and holds no TRUNCATE / REFERENCES / TRIGGER).
  SELECT string_agg(coalesce(g.w, '-' || e.w) || CASE WHEN e.w IS NULL THEN ' (unexpected)' ELSE '' END, ', '
                    ORDER BY coalesce(g.w, e.w)) INTO bad
  FROM (SELECT DISTINCT c.relname || ':' || a.privilege_type AS w
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
             LATERAL (SELECT x.grantee, x.privilege_type FROM aclexplode(c.relacl) x
                      UNION ALL SELECT x.grantee, x.privilege_type FROM pg_attribute att, aclexplode(att.attacl) x
                      WHERE att.attrelid = c.oid) a
        WHERE n.nspname IN ('public', 'app') AND a.grantee = 'mwf_definer'::regrole
          AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')) g
  FULL JOIN (SELECT unnest(v_definer_writes) AS w) e ON e.w = g.w
  WHERE g.w IS NULL OR e.w IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: mwf_definer''s writes differ from the definers'' (-missing, unexpected): %', bad;
  END IF;

  -- No runtime login or capability owns the database, schema public/app or any object in them (§6 layer 1).
  SELECT string_agg(x.object || ' (' || pg_get_userbyid(x.owner) || ')', ', ' ORDER BY x.object) INTO bad FROM (
    SELECT d.datdba AS owner, 'database' AS object FROM pg_database d WHERE d.datname = current_database()
    UNION ALL SELECT s.nspowner, 'schema ' || s.nspname FROM pg_namespace s WHERE s.nspname IN ('public', 'app')
    UNION ALL SELECT c.relowner, 'relation ' || c.oid::regclass::text FROM pg_class c
              JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname IN ('public', 'app')
    UNION ALL SELECT p.proowner, 'routine ' || p.oid::regprocedure::text FROM pg_proc p
              JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname IN ('public', 'app')
    UNION ALL SELECT t.typowner, 'type ' || t.oid::regtype::text FROM pg_type t
              JOIN pg_namespace s ON s.oid = t.typnamespace WHERE s.nspname IN ('public', 'app')) x
  WHERE pg_get_userbyid(x.owner) IN (SELECT unnest(v_logins || v_caps));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: object(s) owned by a runtime login or capability: %', bad; END IF;

  -- A runtime login holds no privilege of its own on what this migration creates: every grant is its capability's.
  SELECT string_agg(x.object || ' (' || pg_get_userbyid(x.grantee) || ')', ', ' ORDER BY x.object) INTO bad FROM (
    SELECT a.grantee, 'schema ' || s.nspname AS object FROM pg_namespace s, aclexplode(s.nspacl) a
    WHERE s.nspname IN ('public', 'app')
    UNION ALL SELECT a.grantee, 'relation ' || c.oid::regclass::text FROM pg_class c
              JOIN pg_namespace s ON s.oid = c.relnamespace, aclexplode(c.relacl) a WHERE s.nspname IN ('public', 'app')
    UNION ALL SELECT a.grantee, 'column ' || c.oid::regclass::text || '.' || att.attname FROM pg_attribute att
              JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace, aclexplode(att.attacl) a
              WHERE s.nspname IN ('public', 'app')
    UNION ALL SELECT a.grantee, 'routine ' || p.oid::regprocedure::text FROM pg_proc p
              JOIN pg_namespace s ON s.oid = p.pronamespace, aclexplode(p.proacl) a WHERE s.nspname IN ('public', 'app')
    UNION ALL SELECT a.grantee, 'type ' || t.oid::regtype::text FROM pg_type t
              JOIN pg_namespace s ON s.oid = t.typnamespace, aclexplode(t.typacl) a WHERE s.nspname IN ('public', 'app')) x
  WHERE pg_get_userbyid(x.grantee) IN (SELECT unnest(v_logins));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: privilege(s) granted to a login instead of its capability: %', bad; END IF;

  -- clinician_access holds nothing until the consent model exists (Q18); ai_access and worker_access get their
  -- grants with their call sites (§7 row 9b). Read over the whole catalog of this database.
  SELECT string_agg(DISTINCT pg_get_userbyid(x.grantee), ', ') INTO bad FROM (
    SELECT a.grantee FROM pg_namespace s, aclexplode(s.nspacl) a
    UNION ALL SELECT a.grantee FROM pg_class c, aclexplode(c.relacl) a
    UNION ALL SELECT a.grantee FROM pg_attribute att, aclexplode(att.attacl) a
    UNION ALL SELECT a.grantee FROM pg_proc p, aclexplode(p.proacl) a
    UNION ALL SELECT a.grantee FROM pg_type t, aclexplode(t.typacl) a) x
  WHERE pg_get_userbyid(x.grantee) IN ('clinician_access', 'ai_access', 'worker_access');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: role(s) that hold nothing yet hold a privilege: %', bad; END IF;

  -- work-k5fk.10.4.1: t_doc_schema and t_jsonb_envelope run with the writer's rights, so every role that may fire
  -- one (INSERT on the table, or UPDATE of a column the trigger names) can run the validator it calls — or its first
  -- write fails inside the trigger. The table's owner, superusers and the predefined pg_* roles (pg_write_all_data
  -- writes everything and is granted to no one: the role guard refuses any membership but the capability) are exempt.
  SELECT string_agg(DISTINCT r.rolname || ' on ' || c.relname, ', ') INTO bad
  FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid CROSS JOIN pg_roles r
  WHERE tg.tgname IN ('t_doc_schema', 't_jsonb_envelope') AND NOT r.rolsuper AND NOT pg_has_role(r.oid, c.relowner, 'USAGE')
    AND r.rolname !~ '^pg_'
    AND (has_any_column_privilege(r.oid, c.oid, 'INSERT')
         OR EXISTS (SELECT 1 FROM unnest(tg.tgattr::int2[]) a(attnum) WHERE has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE')))
    AND NOT (has_schema_privilege(r.oid, 'app', 'USAGE') AND CASE tg.tgname
               WHEN 't_doc_schema' THEN has_table_privilege(r.oid, 'app.json_schema', 'SELECT')
                 AND has_function_privilege(r.oid, 'app.jsonb_violation(jsonb, text, public.schema_version)', 'EXECUTE')
               ELSE has_function_privilege(r.oid, 'app.jsonb_envelope_violation(jsonb)', 'EXECUTE') END);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: role(s) that may write a validated column but cannot run its validator: %', bad;
  END IF;

  -- The message counter moves only through app.next_message_seq (work-k5fk.4): no role but its owner mwf_definer
  -- (and the table's owner) may UPDATE conversation.next_seq.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO bad
  FROM pg_roles r JOIN pg_class c ON c.oid = 'public.conversation'::regclass
  WHERE NOT r.rolsuper AND r.rolname <> 'mwf_definer' AND r.rolname !~ '^pg_' AND NOT pg_has_role(r.oid, c.relowner, 'USAGE')
    AND has_column_privilege(r.oid, c.oid, 'next_seq', 'UPDATE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: role(s) other than mwf_definer that may UPDATE conversation.next_seq: %', bad; END IF;
  END;

  -- work-k5fk.4 (k5fk.21, .23): the column-list SET NULL keys, which Prisma reads as plain SetNull — so the
  -- drift gate passes a full SET NULL (that would null session_id, NOT NULL) and only this catches it.
  SELECT string_agg(w.want, '; ') INTO bad
  FROM (VALUES ('message', 'need', '{refining_need_id}'),
               ('message', 'empathy_attempt', '{source_attempt_id}'),
               ('conversation_read_state', 'message', '{last_seen_conversation_id,last_seen_seq}')) x(rel, ref, cols),
       LATERAL (SELECT x.rel || ' -> ' || x.ref || ' ON DELETE SET NULL ' || x.cols AS want) w
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid = ('public.' || x.rel)::regclass AND c.confrelid = ('public.' || x.ref)::regclass
      AND c.confdeltype = 'n'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.confdelsetcols) s(attnum)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = s.attnum)::text = x.cols)
    OR (SELECT count(*) FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conrelid = ('public.' || x.rel)::regclass AND c.confrelid = ('public.' || x.ref)::regclass) <> 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: expected exactly one key: %', bad; END IF;

  -- The milestone seed is in.
  SELECT count(*) INTO n FROM milestone;
  IF n <> 13 THEN RAISE EXCEPTION 'step 20: % milestone rows, expected 13', n; END IF;
END
$$;
