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
--       are handed to mwf_job (GRANT CREATE → ALTER OWNER → REVOKE CREATE)
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
-- the owner (mwf_job), so the test reads session_user — the role that logged
-- in — and is exactly session_user IN ('mwf_job', 'mwf_migrator') (spec
-- Conventions `job`). No catalog is read and no superuser arm exists (Phase 3
-- §1: rolsuper must be false); local tooling that needs the job connects as
-- mwf_job (JOB_DATABASE_URL, docs/development/local-setup.md).
--
-- Every self-arm is NULL-safe: an unset identity (app.current_user_id() IS
-- NULL) or a modeled participant (user_id IS NULL) is never "self".
-- ---------------------------------------------------------------------------

-- Invoker helper: updated_at on every UPDATE (owner decision 2026-10-21; not moddatetime).
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- The two TS-1 helpers, with TS-1's signatures, over participant. Created
-- here like every other definer helper and handed to mwf_job below (there is
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
-- mwf_app: no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app. mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.is_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO mwf_job;

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
      ON other.session_id = me.session_id AND other.id <> me.id AND other.kind = 'human'
    WHERE me.session_id = partner_user_id.session
      AND me.user_id = app.current_user_id()
      AND (SELECT count(*) FROM public.participant c WHERE c.session_id = me.session_id AND c.kind = 'human') = 2
  $$;
-- mwf_app: no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app. mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.partner_user_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.partner_user_id(uuid) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.partner_user_id(uuid) TO mwf_job;

-- Does the caller share this participant's session?
CREATE FUNCTION app.is_co_participant(participant uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.participant them
      JOIN public.participant me ON me.session_id = them.session_id
      WHERE them.id = is_co_participant.participant AND me.user_id = app.current_user_id()
    )
  $$;
-- mwf_app: no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app. mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.is_co_participant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_co_participant(uuid) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.is_co_participant(uuid) TO mwf_job;

-- The caller's participant id in this session (NULL if none).
CREATE FUNCTION app.my_participant(session uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT p.id FROM public.participant p
    WHERE p.session_id = my_participant.session AND p.user_id = app.current_user_id()
  $$;
-- mwf_app: no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app. mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.my_participant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_participant(uuid) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.my_participant(uuid) TO mwf_job;

-- Content-free status of every empathy direction in the caller's sessions
-- (the latest round per direction): what both parties may see while neither
-- may read an unrevealed row (P0-2). Behind v_empathy_direction_status.
CREATE FUNCTION app.empathy_direction_status()
  RETURNS TABLE (author_participant_id uuid, subject_participant_id uuid, round integer, status public.empathy_status,
                 submitted_at timestamptz, revealed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT DISTINCT ON (a.author_participant_id, a.subject_participant_id)
           a.author_participant_id, a.subject_participant_id, a.round, a.status, a.submitted_at, a.revealed_at
    FROM public.empathy_attempt a
    JOIN public.participant au ON au.id = a.author_participant_id
    WHERE EXISTS (SELECT 1 FROM public.participant me
                  WHERE me.session_id = au.session_id AND me.user_id = app.current_user_id())
    ORDER BY a.author_participant_id, a.subject_participant_id, a.round DESC
  $$;
-- mwf_app: the identity-bound read behind v_empathy_direction_status. mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.empathy_direction_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empathy_direction_status() TO mwf_app;
GRANT EXECUTE ON FUNCTION app.empathy_direction_status() TO mwf_job;

-- The only writer of session.status (spec §1.1 transition set). Members or
-- the job; T-cardinality-1 (trigger) still refuses → ACTIVE without two
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
    IF NOT FOUND OR NOT (v_job OR coalesce(app.is_member(session_set_status.session), false)) THEN
      RAISE EXCEPTION 'session not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_from = session_set_status.status THEN
      RETURN;
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
        resolved_at = CASE WHEN session_set_status.status = 'RESOLVED' THEN coalesce(s.resolved_at, now()) ELSE s.resolved_at END
    WHERE s.id = session_set_status.session;
  END
  $$;
-- mwf_app: invitations.ts accept, on the app transaction. mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) TO mwf_job;

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
    SELECT p.session_id INTO v_session
    FROM public.empathy_attempt e JOIN public.participant p ON p.id = e.author_participant_id
    WHERE e.id = empathy_set_status.attempt;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM 1 FROM public.session s WHERE s.id = v_session FOR NO KEY UPDATE;
    SELECT * INTO a FROM public.empathy_attempt e WHERE e.id = empathy_set_status.attempt FOR NO KEY UPDATE;
    SELECT p.user_id, p.left_at INTO v_author_user, v_author_left FROM public.participant p WHERE p.id = a.author_participant_id;
    SELECT p.user_id, p.left_at INTO v_subject_user, v_subject_left FROM public.participant p WHERE p.id = a.subject_participant_id;
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
      INSERT INTO public.empathy_attempt (author_participant_id, subject_participant_id, round, supersedes_attempt_id, content, status)
      VALUES (a.author_participant_id, a.subject_participant_id, a.round + 1, a.id, empathy_set_status.content, 'HELD')
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
               JOIN public.participant y ON y.session_id = x.session_id AND y.id <> x.id
               WHERE x.session_id = v_session
                 AND x.kind = 'human' AND x.left_at IS NULL AND y.kind = 'human' AND y.left_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM public.empathy_attempt e
                                 WHERE e.author_participant_id = x.id AND e.subject_participant_id = y.id
                                   AND e.status IN ('READY', 'REVEALED', 'VALIDATED')))
        INTO v_gate;
      IF NOT v_gate THEN
        RAISE EXCEPTION 'reveal gate not met: every direction must be READY first' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE public.empathy_attempt
      SET status = 'REVEALED', revealed_at = coalesce(revealed_at, now()), status_version = status_version + 1
      WHERE id = a.id;
      INSERT INTO public.message (conversation_id, sender_participant_id, role, kind, content, source_attempt_id)
      SELECT c.id, a.author_participant_id, 'USER', 'EMPATHY_STATEMENT', a.content, a.id
      FROM public.conversation c
      WHERE c.participant_id = a.subject_participant_id AND c.kind = 'MAIN'
        AND NOT EXISTS (SELECT 1 FROM public.message m
                        WHERE m.conversation_id = c.id AND m.source_attempt_id = a.id AND m.kind = 'EMPATHY_STATEMENT');
    ELSE
      UPDATE public.empathy_attempt SET status = empathy_set_status.status, status_version = status_version + 1 WHERE id = a.id;
    END IF;
    RETURN a.id;
  END
  $$;
-- mwf_app: the request-path writer (work-k5fk.10.2). mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) TO mwf_job;

-- need_share is written only here, by the job (it holds the session key that
-- encrypts shared_text; EXECUTE is the job's alone), after the owner's
-- GRANTED consent, for a need that is neither deleted nor superseded;
-- participant_id and session_id come from the need, never from the caller
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
                   WHERE c.need_id = need_share.need AND c.participant_id = n.participant_id AND c.decision = 'GRANTED') THEN
      RAISE EXCEPTION 'need has no GRANTED consent by its owner' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.need_share (need_id, participant_id, session_id, category, shared_text)
    SELECT n.id, n.participant_id, p.session_id, n.category, need_share.shared_text
    FROM public.need n JOIN public.participant p ON p.id = n.participant_id
    WHERE n.id = need_share.need
    ON CONFLICT (need_id) DO NOTHING;
  END
  $$;
-- Not mwf_app: the job's. mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.need_share(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.need_share(uuid, text) TO mwf_job;

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
              SELECT 1 FROM public.need n JOIN public.participant p ON p.id = n.participant_id
              WHERE n.id = need_revoke_share.need AND p.user_id = v_me))) THEN
      RAISE EXCEPTION 'need not found' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.need_share SET revoked_at = now() WHERE need_id = need_revoke_share.need AND revoked_at IS NULL;
    UPDATE public.consent SET decision = 'REVOKED', revoked_at = now()
    WHERE need_id = need_revoke_share.need AND decision = 'GRANTED';
  END
  $$;
-- mwf_app: the request-path writer (work-k5fk.10.2). mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.need_revoke_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.need_revoke_share(uuid) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.need_revoke_share(uuid) TO mwf_job;

-- app.anonymize_user_in_session(session, participant): steps 1–4 and 7
-- (participant key) of the account walk for one session (spec §4). The
-- participant's own user (identity-bound, never NULL) or the job.
CREATE FUNCTION app.anonymize_user_in_session(session uuid, participant uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_job  boolean := session_user IN ('mwf_job', 'mwf_migrator');
    v_me   uuid := app.current_user_id();
    v_user uuid;
    pid    uuid := anonymize_user_in_session.participant;
  BEGIN
    SELECT p.user_id INTO v_user FROM public.participant p
    WHERE p.id = pid AND p.session_id = anonymize_user_in_session.session;
    IF NOT FOUND OR NOT (v_job OR coalesce(v_me IS NOT NULL AND v_user = v_me, false)) THEN
      RAISE EXCEPTION 'participant not found' USING ERRCODE = 'P0002';
    END IF;
    -- 1. a live session → ABANDONED (closes the invite-accept path; lets T-cardinality-2 accept the leave)
    IF (SELECT s.status FROM public.session s WHERE s.id = anonymize_user_in_session.session) IN ('CREATED', 'INVITED', 'ACTIVE') THEN
      PERFORM app.session_set_status(anonymize_user_in_session.session, 'ABANDONED');
    END IF;
    -- 2. the only PII a co-participant sees
    UPDATE public.participant SET display_name = NULL, left_at = coalesce(left_at, now()) WHERE id = pid;
    -- 3. the leaver's private-only rows (D9)
    DELETE FROM public.conversation WHERE participant_id = pid;           -- cascades its messages
    DELETE FROM public.conversation_read_state WHERE participant_id = pid;
    DELETE FROM public.draft WHERE participant_id = pid;
    DELETE FROM public.ai_memory WHERE participant_id = pid;
    DELETE FROM public.mood_reading WHERE participant_id = pid;
    DELETE FROM public.regulation_event WHERE participant_id = pid;
    DELETE FROM public.need_disposition WHERE participant_id = pid;
    DELETE FROM public.follow_up_note WHERE participant_id = pid;
    DELETE FROM public.need n WHERE n.participant_id = pid
      AND NOT EXISTS (SELECT 1 FROM public.need_share s WHERE s.need_id = n.id);
    DELETE FROM public.proposal_choice c WHERE c.participant_id = pid
      AND NOT EXISTS (SELECT 1 FROM public.participant_milestone m WHERE m.participant_id = pid AND m.milestone_key = 'choices_shared');
    DELETE FROM public.follow_up_checkin c USING public.follow_up f
      WHERE c.follow_up_id = f.id AND f.scope = 'INDIVIDUAL' AND c.participant_id = pid;
    DELETE FROM public.empathy_attempt WHERE author_participant_id = pid AND revealed_at IS NULL;  -- cascades results, offers, reviews
    -- 4. full prompts in plaintext: the participant's own rows, and (ruling
    -- R17) every row of the session with no participant — migrated history
    -- (BrainActivity had no user column) cannot be attributed; deleting the
    -- partner's telemetry too is acceptable, leaking the leaver's prompts is not
    DELETE FROM public.brain_activity
    WHERE participant_id = pid
       OR (session_id = anonymize_user_in_session.session AND participant_id IS NULL);
    -- 7. the participant-key shred
    UPDATE public.participant_key SET destroyed_at = now() WHERE participant_id = pid AND destroyed_at IS NULL;
  END
  $$;
-- Not mwf_app: the job is its only caller (session-deletion.ts). mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.anonymize_user_in_session(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.anonymize_user_in_session(uuid, uuid) TO mwf_job;

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
       OR NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = v_uid) THEN
      RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
    END IF;
    -- 1–4, 7 (participant keys) per session
    FOR r IN SELECT p.id, p.session_id FROM public.participant p WHERE p.user_id = v_uid ORDER BY p.session_id LOOP
      PERFORM app.anonymize_user_in_session(r.session_id, r.id);
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
    -- 6. the tombstone
    UPDATE public."user"
    SET clerk_id = NULL, email = 'deleted+' || v_uid::text, first_name = NULL, last_name = NULL, deleted_at = coalesce(deleted_at, now())
    WHERE id = v_uid;
    -- 7. the user-key shred
    UPDATE public.user_key SET destroyed_at = now() WHERE user_id = v_uid AND destroyed_at IS NULL;
  END
  $$;
-- Not mwf_app: the job is its only caller (account-deletion.ts). mwf_job: its own writer, from a job connection.
REVOKE EXECUTE ON FUNCTION app.anonymize_user_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.anonymize_user_account(uuid) TO mwf_job;

-- Pre-identity bootstrap (P3 §5): resolve a Clerk id; create the user for a
-- first login (mwf_auth only, INSERT only).
CREATE FUNCTION app.resolve_user_by_clerk_id(clerk_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT u.id FROM public."user" u WHERE u.clerk_id = resolve_user_by_clerk_id.clerk_id AND u.deleted_at IS NULL
  $$;
-- mwf_auth: the lookup that precedes first-login creation (pre-identity bootstrap). No app caller.
REVOKE EXECUTE ON FUNCTION app.resolve_user_by_clerk_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_user_by_clerk_id(text) TO mwf_auth;

CREATE FUNCTION app.create_user_for_clerk(clerk_id text, email text, first_name text DEFAULT NULL, last_name text DEFAULT NULL)
  RETURNS uuid
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    INSERT INTO public."user" (clerk_id, email, first_name, last_name)
    VALUES (create_user_for_clerk.clerk_id, create_user_for_clerk.email, create_user_for_clerk.first_name, create_user_for_clerk.last_name)
    RETURNING id
  $$;
-- mwf_auth only: first-login creation.
REVOKE EXECUTE ON FUNCTION app.create_user_for_clerk(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_user_for_clerk(text, text, text, text) TO mwf_auth;

-- Hand the definer functions to mwf_job (TS-1 order, measured there with a
-- non-superuser migrator): CREATE on the schema for the hand-over only. Their
-- EXECUTE grants were issued above, next to each function, by the migrator as
-- owner; ALTER OWNER rewrites each ACL to the new owner (grantee and grantor),
-- which is exactly what issuing them AS mwf_job after the hand-over produced
-- before work-k5fk.7 (app-grants.target.test.ts privilege matrix; pg_proc.proacl
-- byte-identical).
GRANT CREATE ON SCHEMA app TO mwf_job;
ALTER FUNCTION app.is_member(uuid) OWNER TO mwf_job;
ALTER FUNCTION app.partner_user_id(uuid) OWNER TO mwf_job;
ALTER FUNCTION app.is_co_participant(uuid) OWNER TO mwf_job;
ALTER FUNCTION app.my_participant(uuid) OWNER TO mwf_job;
ALTER FUNCTION app.empathy_direction_status() OWNER TO mwf_job;
ALTER FUNCTION app.session_set_status(uuid, public.session_status) OWNER TO mwf_job;
ALTER FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) OWNER TO mwf_job;
ALTER FUNCTION app.need_share(uuid, text) OWNER TO mwf_job;
ALTER FUNCTION app.need_revoke_share(uuid) OWNER TO mwf_job;
ALTER FUNCTION app.anonymize_user_in_session(uuid, uuid) OWNER TO mwf_job;
ALTER FUNCTION app.anonymize_user_account(uuid) OWNER TO mwf_job;
ALTER FUNCTION app.resolve_user_by_clerk_id(text) OWNER TO mwf_job;
ALTER FUNCTION app.create_user_for_clerk(text, text, text, text) OWNER TO mwf_job;
REVOKE CREATE ON SCHEMA app FROM mwf_job;

-- ---------------------------------------------------------------------------
-- T5. Triggers (spec §5 "Lives only in migration SQL"; §7). Invoker rights
-- throughout — T-consent-owner must be (N-4), and the others need no more
-- than their caller can see — with search_path pinned and every relation
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

-- T-message-immutable: routing columns and the once-only dedupe_key (work-fdc1)
-- never change; content of AI/SYSTEM rows and of every delivered kind never
-- changes, except by the job (W13 re-encryption).
CREATE FUNCTION app.t_message_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.sender_participant_id IS DISTINCT FROM OLD.sender_participant_id
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
-- rows 9d–9g) these do. Keyed on current_user, not session_user: a SECURITY DEFINER function
-- the app calls (app.empathy_set_status, owned by mwf_job) writes the subject's delivered copy
-- with the owner's rights, and that write is the job's, not the app's.
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
-- the referencing table — message — so current_user there is mwf_migrator and the early return
-- lets it through. Were mwf_app the owner again, every cascade (the job's session retention, account
-- deletion) would run as mwf_app and be refused here: the triggers assume no runtime role owns them.
-- app.current_user_id() is read only after the mwf_app early return, so other roles (§7 row 9a's
-- capability roles) need no EXECUTE on it to write.
CREATE FUNCTION app.t_message_app_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_owner      uuid;
    v_owner_user uuid;
    v_me         uuid;
  BEGIN
    IF current_user <> 'mwf_app' THEN
      RETURN NEW;
    END IF;
    v_me := app.current_user_id();
    IF NEW.role <> 'USER' OR NEW.kind NOT IN ('CHAT', 'EMPATHY_STATEMENT') THEN
      RAISE EXCEPTION 'the app writes only its own USER turns and statement copies, not % %', NEW.role, NEW.kind
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT c.participant_id, p.user_id INTO v_owner, v_owner_user
    FROM public.conversation c JOIN public.participant p ON p.id = c.participant_id
    WHERE c.id = NEW.conversation_id;
    IF NEW.sender_participant_id IS DISTINCT FROM v_owner
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
    IF current_user <> 'mwf_app' THEN
      RETURN OLD;
    END IF;
    v_me := app.current_user_id();
    SELECT c.participant_id, p.user_id INTO v_owner, v_owner_user
    FROM public.conversation c JOIN public.participant p ON p.id = c.participant_id
    WHERE c.id = OLD.conversation_id;
    IF NOT ((OLD.role = 'USER' AND OLD.kind = 'CHAT' AND OLD.sender_participant_id = v_owner)
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

-- T-same-session: author and subject belong to the same session.
CREATE FUNCTION app.t_attempt_same_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF (SELECT p.session_id FROM public.participant p WHERE p.id = NEW.author_participant_id)
       IS DISTINCT FROM (SELECT p.session_id FROM public.participant p WHERE p.id = NEW.subject_participant_id) THEN
      RAISE EXCEPTION 'author and subject must share a session' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_attempt_same_session() FROM PUBLIC;
CREATE TRIGGER t_same_session BEFORE INSERT OR UPDATE OF author_participant_id, subject_participant_id ON public.empathy_attempt
  FOR EACH ROW EXECUTE FUNCTION app.t_attempt_same_session();

-- T-review-subject: the reviewer of an attempt is its subject (spec §1.2 "trigger-checked").
CREATE FUNCTION app.t_review_subject() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.empathy_attempt a
                   WHERE a.id = NEW.attempt_id AND a.subject_participant_id = NEW.reviewer_participant_id) THEN
      RAISE EXCEPTION 'only the subject of an attempt reviews it' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_review_subject() FROM PUBLIC;
CREATE TRIGGER t_review_subject BEFORE INSERT OR UPDATE OF attempt_id, reviewer_participant_id ON public.empathy_review
  FOR EACH ROW EXECUTE FUNCTION app.t_review_subject();

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
      SELECT n.participant_id INTO v_owner FROM public.need n WHERE n.id = NEW.need_id;
    ELSIF NEW.empathy_attempt_id IS NOT NULL THEN
      SELECT a.author_participant_id INTO v_owner FROM public.empathy_attempt a WHERE a.id = NEW.empathy_attempt_id;
    ELSIF NEW.proposal_id IS NOT NULL THEN
      SELECT p.created_by_participant_id INTO v_owner FROM public.proposal p WHERE p.id = NEW.proposal_id;
    ELSIF NEW.share_offer_id IS NOT NULL THEN
      SELECT o.subject_participant_id INTO v_owner FROM public.context_share_offer o WHERE o.id = NEW.share_offer_id;
    ELSIF NEW.review_id IS NOT NULL THEN
      SELECT r.reviewer_participant_id INTO v_owner FROM public.empathy_review r WHERE r.id = NEW.review_id;
    END IF;
    IF v_owner IS NULL OR v_owner <> NEW.participant_id THEN
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

-- T-need-share-owner: participant_id/session_id are the need owner's (N-1).
CREATE FUNCTION app.t_need_share_owner() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.need n JOIN public.participant p ON p.id = n.participant_id
                   WHERE n.id = NEW.need_id AND n.participant_id = NEW.participant_id AND p.session_id = NEW.session_id) THEN
      RAISE EXCEPTION 'need_share must carry its need owner''s participant and session' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_need_share_owner() FROM PUBLIC;
CREATE TRIGGER t_need_share_owner BEFORE INSERT OR UPDATE ON public.need_share
  FOR EACH ROW EXECUTE FUNCTION app.t_need_share_owner();

-- T-need-share-terminal: the delivered text and its pins never change;
-- revoked_at moves only NULL → value (P3 §4, re-homed).
CREATE FUNCTION app.t_need_share_terminal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.need_id IS DISTINCT FROM OLD.need_id OR NEW.shared_text IS DISTINCT FROM OLD.shared_text
       OR NEW.participant_id IS DISTINCT FROM OLD.participant_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
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

-- T-result-live-attempt: no result on a SUPERSEDED round; subject = the attempt's subject.
CREATE FUNCTION app.t_result_live_attempt() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.empathy_attempt a
                   WHERE a.id = NEW.attempt_id AND a.status <> 'SUPERSEDED' AND a.subject_participant_id = NEW.subject_participant_id) THEN
      RAISE EXCEPTION 'a reconciler result needs a live attempt with the same subject' USING ERRCODE = 'check_violation';
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
        OR (SELECT NOT EXISTS (SELECT ap.participant_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id
                               EXCEPT SELECT p.id FROM public.participant p
                                      WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                        AND (p.left_at IS NULL OR p.left_at > ag.created_at))
               AND NOT EXISTS (SELECT p.id FROM public.participant p
                               WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                 AND (p.left_at IS NULL OR p.left_at > ag.created_at)
                               EXCEPT SELECT ap.participant_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id)
               AND NOT EXISTS (SELECT 1 FROM public.agreement_party ap
                               WHERE ap.agreement_id = ag.id
                                 AND NOT EXISTS (SELECT 1 FROM public.proposal_choice c
                                                 WHERE c.proposal_id = ag.proposal_id AND c.participant_id = ap.participant_id
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
        OR (SELECT NOT EXISTS (SELECT ap.participant_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id
                               EXCEPT SELECT p.id FROM public.participant p
                                      WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                        AND (p.left_at IS NULL OR p.left_at > ag.created_at))
               AND NOT EXISTS (SELECT p.id FROM public.participant p
                               WHERE p.session_id = ag.session_id AND p.kind = 'human'
                                 AND (p.left_at IS NULL OR p.left_at > ag.created_at)
                               EXCEPT SELECT ap.participant_id FROM public.agreement_party ap WHERE ap.agreement_id = ag.id)
               AND NOT EXISTS (SELECT 1 FROM public.agreement_party ap
                               WHERE ap.agreement_id = ag.id
                                 AND NOT EXISTS (SELECT 1 FROM public.proposal_choice c
                                                 WHERE c.proposal_id = ag.proposal_id AND c.participant_id = ap.participant_id
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

-- touch_updated_at on the 35 tables that have updated_at (T8 asserts the set
-- equals the catalog's). message and takeaway_link have none.
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON agreement FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON ai_memory FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON brain_activity FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON consent FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON context_share_offer FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON conversation FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
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
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON relationship FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON relationship_member FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON reminder FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON session FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON session_key FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON takeaway FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
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
-- (owned by mwf_job, identity-bound) that returns participant_id + the masked
-- last_active_at (+ last_mood if the product wants it), with no default-true
-- over an invisible row; this view then serves only the caller's own rows.
CREATE VIEW v_participant WITH (security_invoker = true) AS
SELECT p.id AS participant_id, p.session_id, p.user_id, p.kind,
       coalesce(p.display_name, CASE WHEN u.deleted_at IS NULL THEN u.name END) AS display_name,
       (u.deleted_at IS NOT NULL) AS is_tombstone,
       p.joined_at, p.left_at,
       c.id AS main_conversation_id,
       r.last_viewed_at, r.last_seen_message_id, r.last_viewed_share_tab_at, r.archived_at,
       CASE WHEN p.user_id = app.current_user_id()
              OR coalesce((up.doc -> 'privacy' ->> 'showActivityStatus')::boolean, true)
            THEN r.last_active_at END AS last_active_at,
       (SELECT m.intensity::integer FROM mood_reading m WHERE m.participant_id = p.id ORDER BY m.recorded_at DESC, m.id DESC LIMIT 1) AS last_mood
FROM participant p
LEFT JOIN "user" u ON u.id = p.user_id
LEFT JOIN conversation c ON c.participant_id = p.id AND c.kind = 'MAIN'
LEFT JOIN conversation_read_state r ON r.participant_id = p.id
LEFT JOIN user_preferences up ON up.user_id = p.user_id;
GRANT SELECT ON v_participant TO mwf_app;

-- Every other participant of the same session, one row per ordered pair (N-safe).
CREATE VIEW v_co_participant WITH (security_invoker = true) AS
SELECT p.id AS participant_id, p.session_id, o.id AS co_participant_id, o.kind AS co_kind, o.display_name AS co_display_name,
       o.left_at AS co_left_at
FROM participant p
JOIN participant o ON o.session_id = p.session_id AND o.id <> p.id;
GRANT SELECT ON v_co_participant TO mwf_app;

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
  SELECT array_agg(p.id ORDER BY p.joined_at, p.id)::uuid[] AS waiting_on
  FROM participant p
  WHERE p.session_id = s.id AND p.kind = 'human' AND p.left_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM participant_milestone pm WHERE pm.participant_id = p.id AND pm.milestone_key = m.key)
) w ON true
WHERE m.scope = 'session';
GRANT SELECT ON v_session_readiness TO mwf_app;

-- Per participant: the furthest milestone reached (by ordinal; paused, ordinal
-- 0, is off the journey) and its stage label; the next milestone; and two
-- stage numbers (ordinal / 100 encodes the old stage): reached_stage, of the
-- furthest milestone, and active_stage, of the next one — the stage the
-- participant is working in, i.e. the old IN_PROGRESS StageProgress.stage (4
-- once the journey's last milestone is reached). The DTO shim reads active_stage.
CREATE VIEW v_current_stage WITH (security_invoker = true) AS
SELECT p.id AS participant_id, p.session_id,
       cur.key AS milestone_key, cur.ordinal, coalesce(cur.stage_label, nxt.stage_label) AS stage_label,
       coalesce(cur.ordinal / 100, 0) AS reached_stage,
       nxt.key AS next_milestone_key,
       coalesce(nxt.ordinal / 100, cur.ordinal / 100, 0) AS active_stage
FROM participant p
LEFT JOIN LATERAL (
  SELECT m.key, m.ordinal, m.stage_label
  FROM participant_milestone pm JOIN milestone m ON m.key = pm.milestone_key
  WHERE pm.participant_id = p.id AND m.ordinal > 0
  ORDER BY m.ordinal DESC LIMIT 1
) cur ON true
LEFT JOIN LATERAL (
  SELECT n.key, n.ordinal, n.stage_label FROM milestone n
  WHERE n.ordinal > coalesce(cur.ordinal, 0)
  ORDER BY n.ordinal LIMIT 1
) nxt ON true;
GRANT SELECT ON v_current_stage TO mwf_app;
-- mwf_ops: the Neural Monitor dashboard's stage column (routes/brain.ts, stage-shim.ts).
GRANT SELECT ON v_current_stage TO mwf_ops;

-- Per direction: the current attempt (the live row, else the latest round)
-- with its current reconciler result, open share offer and review.
CREATE VIEW v_empathy_direction WITH (security_invoker = true) AS
SELECT a.author_participant_id, a.subject_participant_id, a.id AS attempt_id, a.round, a.status, a.revealed_at,
       r.id AS result_id, r.recommended_action, r.alignment_score,
       o.id AS share_offer_id, o.status AS share_offer_status,
       v.id AS review_id, v.validated
FROM (
  SELECT DISTINCT ON (author_participant_id, subject_participant_id) *
  FROM empathy_attempt
  ORDER BY author_participant_id, subject_participant_id, (status NOT IN ('SUPERSEDED', 'VALIDATED')) DESC, round DESC
) a
LEFT JOIN reconciler_result r ON r.attempt_id = a.id AND r.superseded_at IS NULL
LEFT JOIN LATERAL (
  SELECT * FROM context_share_offer x WHERE x.attempt_id = a.id AND x.status IN ('PENDING', 'OFFERED') ORDER BY x.iteration DESC LIMIT 1
) o ON true
LEFT JOIN empathy_review v ON v.attempt_id = a.id AND v.reviewer_participant_id = a.subject_participant_id;
GRANT SELECT ON v_empathy_direction TO mwf_app;

-- need_share alone — never joins need (pass 2 N-1).
CREATE VIEW v_need_shared WITH (security_invoker = true) AS
SELECT need_id, participant_id, session_id, category, shared_text, shared_at
FROM need_share
WHERE revoked_at IS NULL;
GRANT SELECT ON v_need_shared TO mwf_app;

CREATE VIEW v_empathy_direction_status WITH (security_invoker = true) AS
SELECT * FROM app.empathy_direction_status();
GRANT SELECT ON v_empathy_direction_status TO mwf_app;

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
SELECT ns.session_id, ns.need_id, ns.participant_id AS need_owner_participant_id,
       coalesce(cov.proposal_ids, '{}') AS covering_proposal_ids,
       coalesce(w.willing, '{}') AS willing_participant_ids,
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
  SELECT array_agg(DISTINCT c.participant_id)::uuid[] AS willing
  FROM proposal_need pn
  JOIN proposal pr ON pr.id = pn.proposal_id AND pr.status IN ('ACTIVE', 'REVISED', 'CONVERTED_TO_AGREEMENT')
  JOIN proposal_choice c ON c.proposal_id = pr.id AND c.decision = 'WILLING'
  JOIN participant p ON p.id = c.participant_id AND p.kind = 'human' AND p.left_at IS NULL
  WHERE pn.need_id = ns.need_id
) w ON true
CROSS JOIN LATERAL (
  SELECT count(*) AS n FROM participant p WHERE p.session_id = ns.session_id AND p.kind = 'human' AND p.left_at IS NULL
) h
WHERE ns.revoked_at IS NULL;
GRANT SELECT ON v_need_coverage TO mwf_app;

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
                               WHERE c.proposal_id = pr.id AND c.participant_id = pr.created_by_participant_id AND c.decision = 'WILLING')),
                '{}') AS individual_commitment_ids,
       coalesce((SELECT array_agg(ns.need_id ORDER BY ns.shared_at, ns.need_id)::uuid[]
                 FROM need_share ns
                 WHERE ns.session_id = s.id AND ns.revoked_at IS NULL
                   AND (EXISTS (SELECT 1 FROM need_disposition d WHERE d.need_id = ns.need_id AND d.status = 'OPEN')
                        OR NOT EXISTS (SELECT 1 FROM proposal_need pn JOIN proposal pr ON pr.id = pn.proposal_id AND pr.status IN ('ACTIVE', 'REVISED', 'CONVERTED_TO_AGREEMENT')
                                       WHERE pn.need_id = ns.need_id))),
                '{}') AS open_need_ids
FROM session s;
GRANT SELECT ON v_session_closure_items TO mwf_app;

-- The coordination state of a follow-up (replaces TendingCoordinationCycle).
CREATE VIEW v_follow_up_cycle WITH (security_invoker = true) AS
SELECT f.id AS follow_up_id, f.session_id, x.expected AS participant_ids, x.submitted AS submitted_participant_ids,
       x.waiting AS waiting_on, f.response_deadline_at,
       CASE WHEN f.status IN ('COMPLETED', 'CANCELLED') THEN 'RESOLVED'
            WHEN f.status = 'EXPIRED' THEN 'TIMED_OUT'
            WHEN cardinality(x.waiting) = 0 THEN 'READY_TO_RESOLVE'
            WHEN f.response_deadline_at IS NOT NULL AND f.response_deadline_at < now() THEN 'TIMED_OUT'
            ELSE 'WAITING_FOR_PARTNER' END AS status
FROM follow_up f
CROSS JOIN LATERAL (
  SELECT coalesce(array_agg(p.id ORDER BY p.joined_at, p.id)::uuid[], '{}') AS expected,
         coalesce(array_agg(p.id ORDER BY p.joined_at, p.id) FILTER (WHERE ck.id IS NOT NULL)::uuid[], '{}') AS submitted,
         coalesce(array_agg(p.id ORDER BY p.joined_at, p.id) FILTER (WHERE ck.id IS NULL)::uuid[], '{}') AS waiting
  FROM participant p
  LEFT JOIN follow_up_checkin ck ON ck.follow_up_id = f.id AND ck.participant_id = p.id
  WHERE p.session_id = f.session_id AND p.kind = 'human' AND p.left_at IS NULL
    AND (f.scope = 'SHARED' OR p.id = f.owner_participant_id)
) x;
GRANT SELECT ON v_follow_up_cycle TO mwf_app;

-- Per participant: messages in the MAIN conversation after last_viewed_at
-- (not counting the participant's own), and the latest message time.
CREATE VIEW v_conversation_unread WITH (security_invoker = true) AS
SELECT p.id AS participant_id, p.session_id, c.id AS conversation_id,
       (SELECT count(*) FROM message m
        WHERE m.conversation_id = c.id AND m.created_at > coalesce(r.last_viewed_at, '-infinity')
          AND m.sender_participant_id IS DISTINCT FROM p.id) AS unread_count,
       (SELECT max(m.created_at) FROM message m WHERE m.conversation_id = c.id) AS latest_message_at
FROM participant p
JOIN conversation c ON c.participant_id = p.id AND c.kind = 'MAIN'
LEFT JOIN conversation_read_state r ON r.participant_id = p.id;
GRANT SELECT ON v_conversation_unread TO mwf_app;

-- Per (user, theme): reflections and the latest activity (replaces RecurringTheme).
CREATE VIEW v_reflection_theme WITH (security_invoker = true) AS
SELECT user_id, theme, count(*) AS reflection_count, max(updated_at) AS latest_updated_at
FROM reflection
WHERE theme IS NOT NULL
GROUP BY user_id, theme;
GRANT SELECT ON v_reflection_theme TO mwf_app;

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

  -- Every uuid column of a table is a uuid7 (tables.sql): 33 primary keys
  -- defaulting to uuidv7() and the 95 columns that reference them.
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

  -- touch_updated_at on exactly the tables that have updated_at (35).
  SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO bad
  FROM (SELECT c.table_name FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
        EXCEPT
        SELECT c.relname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'touch_updated_at') d;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: tables with updated_at but no touch_updated_at: %', bad; END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgname = 'touch_updated_at';
  IF n <> 35 THEN RAISE EXCEPTION 'step 20: % touch_updated_at triggers, expected 35', n; END IF;

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

  -- Every SECURITY DEFINER function in schema app is owned by mwf_job (TS-1 hand-over).
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND p.prosecdef AND pg_get_userbyid(p.proowner) <> 'mwf_job';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: SECURITY DEFINER function(s) not owned by mwf_job: %', bad; END IF;

  -- The milestone seed is in.
  SELECT count(*) INTO n FROM milestone;
  IF n <> 13 THEN RAISE EXCEPTION 'step 20: % milestone rows, expected 13', n; END IF;
END
$$;
