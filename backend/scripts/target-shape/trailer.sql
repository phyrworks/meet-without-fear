-- ============================================================================
-- trailer.sql — section 3 of the target_shape_baseline migration (TS-7c;
-- built by TS-7, re-based on an empty database by OD7, 2026-10-26).
-- Hand-maintained; backend/scripts/gen-target-migration.ts appends it after
-- the preamble, the Prisma DDL and the milestone seed, and splices
-- backend/scripts/target-shape/sql-only.sql in, verbatim, at the
-- `-- @@include sql-only.sql` line. It never runs alone: it runs in the same
-- transaction, so a failure here rolls the whole baseline back.
--
-- Spec: docs/backend/data-model/schema-target-2026-10.md §1 (Keys lines), §4
-- (views, functions, the anonymisation walk), §7 (invariants);
-- phase3-design-summary.md §4–§6 where the spec re-bases them.
--
-- Contents, in order:
--   T1  the intensity domain, and the three columns the spec types with it
--   T2  sql-only.sql (generated columns, sql_ partial / expression indexes)
--   T3  CHECK constraints (every §1 Keys CHECK; jsonb_typeof on every jsonb column)
--   T4  app.* functions — invoker helpers, then the SECURITY DEFINER helpers and
--       writers handed to mwf_job in the TS-1 order (GRANT CREATE → ALTER OWNER
--       → REVOKE CREATE → SET ROLE mwf_job for REVOKE/GRANT EXECUTE → RESET ROLE)
--   T5  triggers (the T-* set and touch_updated_at ×35)
--   T6  views (security_invoker = true), SELECT to mwf_app
--   T7  grants (mwf_job, mwf_ops, mwf_auth; mwf_app: views and EXECUTE only)
--   T8  catalog assertions (plan step 20). The database is empty, so there are
--       no existing rows to re-check: every invariant is enforced by its
--       trigger or CHECK from the first write on.
--
-- Not here: RLS ENABLE/FORCE and policies (TS-16); the milestone seed (its
-- own section, before this one); schema app and app.current_user_id()
-- (preamble.sql).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- T1. intensity domain (spec §3): int 1..10. The tables are empty, so the
-- retype cannot fail on data.
-- ---------------------------------------------------------------------------
CREATE DOMAIN intensity AS integer CHECK (VALUE BETWEEN 1 AND 10);
ALTER TABLE mood_reading ALTER COLUMN intensity TYPE intensity;
ALTER TABLE regulation_event
  ALTER COLUMN intensity_before TYPE intensity,
  ALTER COLUMN intensity_after TYPE intensity;

-- ---------------------------------------------------------------------------
-- T2. sql-only.sql, verbatim (TS-6): generated columns, then sql_ indexes.
-- ---------------------------------------------------------------------------
-- @@include sql-only.sql

-- ---------------------------------------------------------------------------
-- T3. CHECK constraints. Names: chk_<table>_<rule>. (The [Pnn] tags name the
-- TS-7 data-move prechecks that guarded each rule; kept as cross-references.)
-- ---------------------------------------------------------------------------

-- §1.1 session [P12]
ALTER TABLE session ADD CONSTRAINT chk_session_resolved_at CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL);
-- §1.1 participant
ALTER TABLE participant ADD CONSTRAINT chk_participant_kind_user CHECK ((kind = 'modeled') = (user_id IS NULL));
-- §1.1 conversation (anchor columns are SUBCHAT-only)
ALTER TABLE conversation
  ADD CONSTRAINT chk_conversation_anchor_kind CHECK ((kind = 'MAIN') = (anchor_kind IS NULL)),
  ADD CONSTRAINT chk_conversation_anchor_proposal CHECK (kind = 'SUBCHAT' OR anchor_proposal_id IS NULL);
-- §1.1 message [P02] — P3 §6, "humans can't author as the facilitator"
ALTER TABLE message
  ADD CONSTRAINT chk_message_user_has_sender CHECK (role <> 'USER' OR sender_participant_id IS NOT NULL),
  ADD CONSTRAINT chk_message_ai_has_no_sender CHECK (role NOT IN ('AI', 'SYSTEM') OR sender_participant_id IS NULL);
-- §1.1 draft — exclusive arc, and the arm matches the kind
ALTER TABLE draft
  ADD CONSTRAINT chk_draft_one_arc CHECK (num_nonnulls(about_participant_id, attempt_id, share_offer_id) = 1),
  ADD CONSTRAINT chk_draft_arc_matches_kind CHECK (
        (kind = 'EMPATHY') = (about_participant_id IS NOT NULL)
    AND (kind = 'VALIDATION_FEEDBACK') = (attempt_id IS NOT NULL)
    AND (kind = 'SHARE_CONTEXT') = (share_offer_id IS NOT NULL));
-- §1.1 ai_memory [P28a, P28b]
ALTER TABLE ai_memory
  ADD CONSTRAINT chk_ai_memory_one_owner CHECK (num_nonnulls(participant_id, user_id) = 1),
  ADD CONSTRAINT chk_ai_memory_global_is_user CHECK ((kind = 'GLOBAL_FACTS') = (user_id IS NOT NULL)),
  ADD CONSTRAINT chk_ai_memory_doc_object CHECK (jsonb_typeof(doc) = 'object'),
  ADD CONSTRAINT chk_ai_memory_doc_keys CHECK (
    CASE kind WHEN 'SUMMARY' THEN doc ?& ARRAY['text', 'messageCount', 'generatedAt']
              ELSE jsonb_typeof(doc -> 'facts') = 'array' END);
-- §1.1 invitation [P14a, P14b] — P3 §6
ALTER TABLE invitation ADD CONSTRAINT chk_invitation_accepted CHECK (
  status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL));
-- §1.2 empathy_attempt [P15b, P15d]
ALTER TABLE empathy_attempt
  ADD CONSTRAINT chk_empathy_attempt_not_self CHECK (author_participant_id <> subject_participant_id),
  ADD CONSTRAINT chk_empathy_attempt_revealed_at CHECK (status NOT IN ('REVEALED', 'VALIDATED') OR revealed_at IS NOT NULL);
-- §1.2 empathy_review
ALTER TABLE empathy_review ADD CONSTRAINT chk_empathy_review_feedback_sent CHECK (feedback IS NULL OR feedback_sent_at IS NOT NULL);
-- §1.2 reconciler_result [P17f]
ALTER TABLE reconciler_result ADD CONSTRAINT chk_reconciler_result_score CHECK (alignment_score BETWEEN 0 AND 100);
-- §1.2 context_share_offer [P18a]
ALTER TABLE context_share_offer
  ADD CONSTRAINT chk_context_share_offer_accepted CHECK ((status = 'ACCEPTED') = (shared_at IS NOT NULL)),
  ADD CONSTRAINT chk_context_share_offer_declined CHECK ((status = 'DECLINED') = (declined_at IS NOT NULL));
-- §1.3 consent [P07, P19] — exclusive arc; dated decisions (P3 §6); terminal
-- revocation; a share-offer or feedback consent has no requester (P1-4)
ALTER TABLE consent
  ADD CONSTRAINT chk_consent_one_target CHECK (num_nonnulls(need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id) = 1),
  ADD CONSTRAINT chk_consent_decision_dated CHECK ((decision IS NULL) = (decided_at IS NULL)),
  ADD CONSTRAINT chk_consent_revoked CHECK (revoked_at IS NULL OR decision = 'REVOKED'),
  ADD CONSTRAINT chk_consent_requester CHECK (requested_by_participant_id IS NULL OR target_kind IN ('NEED', 'PROPOSAL', 'EMPATHY_ATTEMPT'));
-- §1.4 need [P30]
ALTER TABLE need ADD CONSTRAINT chk_need_confidence CHECK (ai_confidence BETWEEN 0 AND 1);
-- §1.4 need_share [P20c]
ALTER TABLE need_share ADD CONSTRAINT chk_need_share_revoked_after_shared CHECK (revoked_at IS NULL OR revoked_at >= shared_at);
-- §1.4 proposal [P21]
ALTER TABLE proposal
  ADD CONSTRAINT chk_proposal_removed CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL)),
  ADD CONSTRAINT chk_proposal_shared_individual CHECK (kind = 'INDIVIDUAL_COMMITMENT' OR shared_at IS NULL);
-- §1.4 proposal_revision [P23c]
ALTER TABLE proposal_revision
  ADD CONSTRAINT chk_proposal_revision_before_object CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  ADD CONSTRAINT chk_proposal_revision_after_object CHECK (after IS NULL OR jsonb_typeof(after) = 'object');
-- §1.5 follow_up [P24a]
ALTER TABLE follow_up
  ADD CONSTRAINT chk_follow_up_individual_owner CHECK ((scope = 'INDIVIDUAL') = (owner_participant_id IS NOT NULL)),
  ADD CONSTRAINT chk_follow_up_one_subject CHECK (num_nonnulls(agreement_id, proposal_id) <= 1);
-- §1.5 follow_up_checkin
ALTER TABLE follow_up_checkin ADD CONSTRAINT chk_follow_up_checkin_payload_object CHECK (jsonb_typeof(payload) = 'object');
-- §1.6 reflection, takeaway_link [P31]
ALTER TABLE reflection ADD CONSTRAINT chk_reflection_summary_doc_object CHECK (summary_doc IS NULL OR jsonb_typeof(summary_doc) = 'object');
ALTER TABLE takeaway_link ADD CONSTRAINT chk_takeaway_link_not_self CHECK (source_id <> target_id);
-- §1.7 user — a tombstone is scrubbed (P3 D9)
ALTER TABLE "user" ADD CONSTRAINT chk_user_tombstone_scrubbed CHECK (deleted_at IS NULL OR (clerk_id IS NULL AND email LIKE 'deleted+%'));
-- §1.7 user_preferences
ALTER TABLE user_preferences ADD CONSTRAINT chk_user_preferences_doc CHECK (
  jsonb_typeof(doc) = 'object' AND doc ?& ARRAY['memory', 'notifications', 'privacy']);
-- §1.7 feature_state
ALTER TABLE feature_state
  ADD CONSTRAINT chk_feature_state_feature CHECK (feature IN ('meditation', 'gratitude', 'needs_assessment', 'people')),
  ADD CONSTRAINT chk_feature_state_doc_object CHECK (jsonb_typeof(doc) = 'object');
-- §1.8 brain_activity [P28c]
ALTER TABLE brain_activity
  ADD CONSTRAINT chk_brain_activity_input_json CHECK (input IS NULL OR jsonb_typeof(input) IN ('object', 'array')),
  ADD CONSTRAINT chk_brain_activity_output_json CHECK (output IS NULL OR jsonb_typeof(output) IN ('object', 'array')),
  ADD CONSTRAINT chk_brain_activity_metadata_json CHECK (metadata IS NULL OR jsonb_typeof(metadata) IN ('object', 'array')),
  ADD CONSTRAINT chk_brain_activity_structured_output_json CHECK (structured_output IS NULL OR jsonb_typeof(structured_output) IN ('object', 'array'));

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

-- The caller's participant id in this session (NULL if none).
CREATE FUNCTION app.my_participant(session uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT p.id FROM public.participant p
    WHERE p.session_id = my_participant.session AND p.user_id = app.current_user_id()
  $$;

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

-- Pre-identity bootstrap (P3 §5): resolve a Clerk id; create the user for a
-- first login (mwf_auth only, INSERT only).
CREATE FUNCTION app.resolve_user_by_clerk_id(clerk_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT u.id FROM public."user" u WHERE u.clerk_id = resolve_user_by_clerk_id.clerk_id AND u.deleted_at IS NULL
  $$;

CREATE FUNCTION app.create_user_for_clerk(clerk_id text, email text, first_name text DEFAULT NULL, last_name text DEFAULT NULL)
  RETURNS uuid
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    INSERT INTO public."user" (clerk_id, email, first_name, last_name)
    VALUES (create_user_for_clerk.clerk_id, create_user_for_clerk.email, create_user_for_clerk.first_name, create_user_for_clerk.last_name)
    RETURNING id
  $$;

-- Hand the definer functions to mwf_job (TS-1 order, measured there with a
-- non-superuser migrator): CREATE on the schema for the hand-over only; then
-- the EXECUTE grants issued AS mwf_job, the owner.
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

SET ROLE mwf_job;
REVOKE EXECUTE ON FUNCTION
  app.is_member(uuid), app.partner_user_id(uuid),
  app.is_co_participant(uuid), app.my_participant(uuid), app.empathy_direction_status(),
  app.session_set_status(uuid, public.session_status), app.empathy_set_status(uuid, public.empathy_status, text),
  app.need_share(uuid, text), app.need_revoke_share(uuid),
  app.anonymize_user_in_session(uuid, uuid), app.anonymize_user_account(uuid),
  app.resolve_user_by_clerk_id(text), app.create_user_for_clerk(text, text, text, text)
  FROM PUBLIC;
-- mwf_app: the identity-bound reads and the request-path writers (is_member
-- and partner_user_id: as TS-1 granted them).
GRANT EXECUTE ON FUNCTION
  app.is_member(uuid), app.partner_user_id(uuid), app.is_co_participant(uuid), app.my_participant(uuid), app.empathy_direction_status(),
  app.session_set_status(uuid, public.session_status), app.empathy_set_status(uuid, public.empathy_status, text),
  app.need_revoke_share(uuid), app.anonymize_user_in_session(uuid, uuid), app.anonymize_user_account(uuid),
  app.resolve_user_by_clerk_id(text)
  TO mwf_app;
-- mwf_job: its own writers when called from a job connection.
GRANT EXECUTE ON FUNCTION
  app.is_member(uuid), app.partner_user_id(uuid), app.is_co_participant(uuid), app.my_participant(uuid),
  app.empathy_direction_status(), app.session_set_status(uuid, public.session_status),
  app.empathy_set_status(uuid, public.empathy_status, text), app.need_share(uuid, text), app.need_revoke_share(uuid),
  app.anonymize_user_in_session(uuid, uuid), app.anonymize_user_account(uuid)
  TO mwf_job;
-- mwf_auth: first-login creation only (and the lookup that precedes it).
GRANT EXECUTE ON FUNCTION app.create_user_for_clerk(text, text, text, text), app.resolve_user_by_clerk_id(text) TO mwf_auth;
RESET ROLE;

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
CREATE CONSTRAINT TRIGGER t_cardinality_2 AFTER DELETE OR UPDATE OF kind, user_id, left_at ON public.participant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.t_participant_cardinality();

-- T-message-immutable: routing columns never change; content of AI/SYSTEM rows
-- and of every delivered kind never changes, except by the job (W13 re-encryption).
CREATE FUNCTION app.t_message_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.sender_participant_id IS DISTINCT FROM OLD.sender_participant_id
       OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'message routing is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.content IS DISTINCT FROM OLD.content AND (OLD.role IN ('AI', 'SYSTEM') OR OLD.kind <> 'CHAT')
       AND session_user NOT IN ('mwf_job', 'mwf_migrator') THEN
      RAISE EXCEPTION 'this message''s content is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER t_message_immutable BEFORE UPDATE ON public.message
  FOR EACH ROW EXECUTE FUNCTION app.t_message_immutable();

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
CREATE CONSTRAINT TRIGGER t_agreement_parties AFTER INSERT OR UPDATE OR DELETE ON public.agreement_party
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.t_agreement_parties();
CREATE CONSTRAINT TRIGGER t_agreement_parties_on_agreement AFTER INSERT ON public.agreement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.t_agreement_parties();

-- No caller needs EXECUTE on a trigger function or on the agreement_parties_ok predicate.
REVOKE EXECUTE ON FUNCTION
  app.touch_updated_at(), app.t_session_cardinality(), app.t_participant_cardinality(), app.t_message_immutable(),
  app.t_attempt_same_session(), app.t_review_subject(), app.t_consent_owner(), app.t_consent_transitions(),
  app.t_need_share_owner(), app.t_need_share_terminal(), app.t_result_live_attempt(), app.t_agreement_parties(),
  app.agreement_parties_ok(uuid)
  FROM PUBLIC;

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

-- Every other participant of the same session, one row per ordered pair (N-safe).
CREATE VIEW v_co_participant WITH (security_invoker = true) AS
SELECT p.id AS participant_id, p.session_id, o.id AS co_participant_id, o.kind AS co_kind, o.display_name AS co_display_name,
       o.left_at AS co_left_at
FROM participant p
JOIN participant o ON o.session_id = p.session_id AND o.id <> p.id;

-- Session-scoped milestones: reached by every present human participant?
CREATE VIEW v_session_readiness WITH (security_invoker = true) AS
SELECT s.id AS session_id, m.key AS milestone_key,
       coalesce(w.waiting_on, '{}') = '{}' AS all_reached,
       coalesce(w.waiting_on, '{}') AS waiting_on
FROM session s
CROSS JOIN milestone m
LEFT JOIN LATERAL (
  SELECT array_agg(p.id ORDER BY p.joined_at, p.id) AS waiting_on
  FROM participant p
  WHERE p.session_id = s.id AND p.kind = 'human' AND p.left_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM participant_milestone pm WHERE pm.participant_id = p.id AND pm.milestone_key = m.key)
) w ON true
WHERE m.scope = 'session';

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

-- need_share alone — never joins need (pass 2 N-1).
CREATE VIEW v_need_shared WITH (security_invoker = true) AS
SELECT need_id, participant_id, session_id, category, shared_text, shared_at
FROM need_share
WHERE revoked_at IS NULL;

CREATE VIEW v_empathy_direction_status WITH (security_invoker = true) AS
SELECT * FROM app.empathy_direction_status();

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
  SELECT array_agg(pr.id ORDER BY pr.created_at, pr.id) AS proposal_ids
  FROM proposal_need pn JOIN proposal pr ON pr.id = pn.proposal_id
  WHERE pn.need_id = ns.need_id AND pr.status IN ('ACTIVE', 'REVISED', 'CONVERTED_TO_AGREEMENT')
) cov ON true
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT c.participant_id) AS willing
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

-- The three Stage4Closure arrays, computed (never an unshared need id). An
-- open need is a live share with an OPEN disposition or no covering proposal
-- (ACTIVE, REVISED or CONVERTED_TO_AGREEMENT; ruling R20, above).
CREATE VIEW v_session_closure_items WITH (security_invoker = true) AS
SELECT s.id AS session_id,
       coalesce((SELECT array_agg(ag.id ORDER BY ag.created_at, ag.id) FROM agreement ag WHERE ag.session_id = s.id), '{}') AS agreement_ids,
       coalesce((SELECT array_agg(pr.id ORDER BY pr.created_at, pr.id)
                 FROM proposal pr
                 WHERE pr.session_id = s.id AND pr.kind = 'INDIVIDUAL_COMMITMENT' AND pr.status <> 'REMOVED'
                   AND EXISTS (SELECT 1 FROM proposal_choice c
                               WHERE c.proposal_id = pr.id AND c.participant_id = pr.created_by_participant_id AND c.decision = 'WILLING')),
                '{}') AS individual_commitment_ids,
       coalesce((SELECT array_agg(ns.need_id ORDER BY ns.shared_at, ns.need_id)
                 FROM need_share ns
                 WHERE ns.session_id = s.id AND ns.revoked_at IS NULL
                   AND (EXISTS (SELECT 1 FROM need_disposition d WHERE d.need_id = ns.need_id AND d.status = 'OPEN')
                        OR NOT EXISTS (SELECT 1 FROM proposal_need pn JOIN proposal pr ON pr.id = pn.proposal_id AND pr.status IN ('ACTIVE', 'REVISED', 'CONVERTED_TO_AGREEMENT')
                                       WHERE pn.need_id = ns.need_id))),
                '{}') AS open_need_ids
FROM session s;

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
  SELECT coalesce(array_agg(p.id ORDER BY p.joined_at, p.id), '{}') AS expected,
         coalesce(array_agg(p.id ORDER BY p.joined_at, p.id) FILTER (WHERE ck.id IS NOT NULL), '{}') AS submitted,
         coalesce(array_agg(p.id ORDER BY p.joined_at, p.id) FILTER (WHERE ck.id IS NULL), '{}') AS waiting
  FROM participant p
  LEFT JOIN follow_up_checkin ck ON ck.follow_up_id = f.id AND ck.participant_id = p.id
  WHERE p.session_id = f.session_id AND p.kind = 'human' AND p.left_at IS NULL
    AND (f.scope = 'SHARED' OR p.id = f.owner_participant_id)
) x;

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

-- Per (user, theme): reflections and the latest activity (replaces RecurringTheme).
CREATE VIEW v_reflection_theme WITH (security_invoker = true) AS
SELECT user_id, theme, count(*) AS reflection_count, max(updated_at) AS latest_updated_at
FROM reflection
WHERE theme IS NOT NULL
GROUP BY user_id, theme;

GRANT SELECT ON v_participant, v_co_participant, v_session_readiness, v_current_stage, v_empathy_direction,
                v_need_shared, v_empathy_direction_status, v_need_coverage, v_session_closure_items,
                v_follow_up_cycle, v_conversation_unread, v_reflection_theme
  TO mwf_app;

-- ---------------------------------------------------------------------------
-- T7. Grants (mwf_app's table privileges are unchanged: it owns the tables in
-- production; RLS and per-tier grants are TS-16).
-- ---------------------------------------------------------------------------

-- mwf_job: exactly what the definer helpers and writers it owns read and
-- write — mwf_job is also the job's login role, so these are its direct
-- privileges too. Column lists everywhere a column list exists: SELECT only
-- the id / FK / filter columns a function reads (an UPDATE or DELETE with a
-- WHERE needs SELECT on what it reads), UPDATE only the columns a function
-- writes — never a routing column (participant.user_id/session_id,
-- empathy_attempt.author/subject; Phase 3 §4). DELETE cannot be narrowed.
GRANT USAGE ON SCHEMA public TO mwf_job;
-- is_member, partner_user_id, is_co_participant, my_participant, every self/membership test, T-cardinality-*, T-same-session, reveal gate
GRANT SELECT (id, session_id, user_id, kind, left_at) ON participant TO mwf_job;
-- anonymize_user_in_session step 2
GRANT UPDATE (display_name, left_at) ON participant TO mwf_job;
-- empathy_set_status reads the row (%ROWTYPE) and RETURNING id; empathy_direction_status; T-consent-owner; anonymize (revealed_at filter)
GRANT SELECT ON empathy_attempt TO mwf_job;
-- empathy_set_status: status moves, the reveal stamp (delivery columns for the job's delivery path)
GRANT UPDATE (status, status_version, revealed_at, delivery_status, delivered_at, seen_at) ON empathy_attempt TO mwf_job;
-- empathy_set_status: round n+1 on resubmission
GRANT INSERT (author_participant_id, subject_participant_id, round, supersedes_attempt_id, content, status) ON empathy_attempt TO mwf_job;
-- session_set_status, empathy_set_status (row lock), anonymize step 1
GRANT SELECT (id, status, resolved_at) ON session TO mwf_job;
GRANT UPDATE (status, resolved_at) ON session TO mwf_job;
-- empathy_set_status: the subject's MAIN conversation; anonymize step 3
GRANT SELECT (id, participant_id, kind) ON conversation TO mwf_job;
-- empathy_set_status: the delivered copy, and its duplicate probe
GRANT SELECT (conversation_id, source_attempt_id, kind) ON message TO mwf_job;
GRANT INSERT (conversation_id, sender_participant_id, role, kind, content, source_attempt_id) ON message TO mwf_job;
-- need_share (owner, category, live), need_revoke_share (owner), T-consent-owner, T-need-share-owner, anonymize step 3
GRANT SELECT (id, participant_id, category, deleted_at, superseded_by_need_id) ON need TO mwf_job;
-- need_share (the only writer), need_revoke_share, anonymize step 3 (shared needs survive)
GRANT SELECT (need_id, revoked_at) ON need_share TO mwf_job;
GRANT INSERT (need_id, participant_id, session_id, category, shared_text) ON need_share TO mwf_job;
GRANT UPDATE (revoked_at) ON need_share TO mwf_job;
-- need_share (the owner's GRANTED consent), need_revoke_share (→ REVOKED)
GRANT SELECT (need_id, participant_id, decision) ON consent TO mwf_job;
GRANT UPDATE (decision, revoked_at) ON consent TO mwf_job;
-- T-consent-owner (owner of a proposal / share offer / review target), fired by need_revoke_share
GRANT SELECT (id, created_by_participant_id) ON proposal TO mwf_job;
GRANT SELECT (id, subject_participant_id) ON context_share_offer TO mwf_job;
GRANT SELECT (id, reviewer_participant_id) ON empathy_review TO mwf_job;
-- resolve_user_by_clerk_id, create_user_for_clerk (RETURNING id), anonymize_user_account (existence, tombstone)
GRANT SELECT (id, clerk_id, deleted_at) ON "user" TO mwf_job;
GRANT INSERT (clerk_id, email, first_name, last_name) ON "user" TO mwf_job;
GRANT UPDATE (clerk_id, email, first_name, last_name, deleted_at) ON "user" TO mwf_job;
-- anonymize_user_in_session step 3: unshared choices (choices_shared milestone), INDIVIDUAL check-ins
GRANT SELECT (participant_id, milestone_key) ON participant_milestone TO mwf_job;
GRANT SELECT (id, scope) ON follow_up TO mwf_job;
-- anonymize_*: the filter columns of every private-row delete (steps 3–5)
GRANT SELECT (participant_id) ON conversation_read_state, draft, mood_reading, regulation_event, need_disposition, follow_up_note, proposal_choice TO mwf_job;
GRANT SELECT (participant_id, user_id) ON ai_memory TO mwf_job;
GRANT SELECT (follow_up_id, participant_id) ON follow_up_checkin TO mwf_job;
GRANT SELECT (session_id, participant_id, reflection_id) ON brain_activity TO mwf_job;  -- session_id: R17 (step 4, NULL-participant history)
GRANT SELECT (id, user_id) ON reflection TO mwf_job;
GRANT SELECT (user_id) ON feature_state, user_memory, user_device, user_preferences, reminder TO mwf_job;
GRANT DELETE ON conversation, conversation_read_state, draft, ai_memory, mood_reading, regulation_event, need_disposition,
                follow_up_note, need, proposal_choice, follow_up_checkin, empathy_attempt, brain_activity, reflection,
                feature_state, user_memory, user_device, user_preferences, reminder
  TO mwf_job;
-- anonymize step 7: the crypto-shred
GRANT SELECT (participant_id, destroyed_at) ON participant_key TO mwf_job;
GRANT UPDATE (destroyed_at) ON participant_key TO mwf_job;
GRANT SELECT (user_id, destroyed_at) ON user_key TO mwf_job;
GRANT UPDATE (destroyed_at) ON user_key TO mwf_job;

-- TS-9: the job connection's own writers in the app (spec §1.1 message
-- "Key per row" — AI/SYSTEM rows and every delivered kind are mwf_job's;
-- participant_milestone — system keys are mwf_job's; ai_memory — "in practice
-- written by mwf_job").
-- message-store createFacilitatorMessage / deliverMessage: the dedupe hash, the
-- refining need a facilitator reply answers, and an explicit instant (fixtures, replays)
GRANT INSERT (content_hash, refining_need_id, created_at) ON message TO mwf_job;
-- message-store insert() returns the written row's id and instant (INSERT … RETURNING id, created_at);
-- getInitialMessage's Serializable idempotency probe reads the first message's id. Never content.
GRANT SELECT (id, created_at) ON message TO mwf_job;
-- milestone-writer reachMilestone: system keys (invitation_sent, empathy_*, needs_shared, closed, paused …)
GRANT INSERT (participant_id, milestone_key, reached_at) ON participant_milestone TO mwf_job;
-- sessions.ts resumeSession: un-reaching `paused` is a DELETE by mwf_job (spec §1.1)
GRANT DELETE ON participant_milestone TO mwf_job;
-- conversation-summarizer updateSessionSummary: the participant's SUMMARY document (INSERT … ON CONFLICT DO UPDATE)
GRANT SELECT (kind) ON ai_memory TO mwf_job;
GRANT INSERT (participant_id, kind, doc) ON ai_memory TO mwf_job;
GRANT UPDATE (doc) ON ai_memory TO mwf_job;

-- TS-10: the reconciler's and the reveal's job writers (spec §1.2 — reconciler_result
-- "I/U job", reconciler_guidance "I job", context_share_offer "I job … mwf_job for
-- delivery/notification columns"; services/reconciler/*, controllers/notifications.ts).
-- reconciler/analysis.ts persistAnalysis: one current result per attempt — the next
-- iteration (max(iteration) of the attempt), RETURNING id, and the re-analysis
-- supersede (WHERE attempt_id … AND superseded_at IS NULL). Never the analysis text.
GRANT SELECT (id, attempt_id, iteration, superseded_at) ON reconciler_result TO mwf_job;
-- persistAnalysis: the analysis row itself (id, created_at, updated_at are column defaults)
GRANT INSERT (attempt_id, subject_participant_id, iteration, alignment_score, alignment_summary, gap_summary,
              gap_severity, correctly_identified, missed_feelings, misattributions, most_important_gap,
              recommended_action, rationale, sharing_would_help, suggested_share_focus, suggested_share_content,
              suggested_share_reason, circuit_breaker_tripped) ON reconciler_result TO mwf_job;
-- persistAnalysis: re-analysis of the same attempt retires the current result
GRANT UPDATE (superseded_at) ON reconciler_result TO mwf_job;
-- persistAnalysis: the author-visible abstract hints of a result (P3 D8a split)
GRANT INSERT (result_id, author_participant_id, subject_participant_id, area_hint, guidance_type, prompt_seed)
  ON reconciler_guidance TO mwf_job;
-- reconciler/sharing.ts insertOffer: the next iteration of an attempt's offers (max(iteration)),
-- RETURNING id; triggerStage3Transition: open offers (status) of the session's participants expire
GRANT SELECT (attempt_id, iteration, status) ON context_share_offer TO mwf_job;
-- sharing.ts deliverAcceptedShare (fix1 I2): the delivery is idempotent — it locks the offer
-- (SELECT … FOR UPDATE) and delivers only while delivery_status is PENDING. Never the shared text.
GRANT SELECT (delivery_status) ON context_share_offer TO mwf_job;
-- insertOffer: the subject's offer (PENDING from the reconciler; OFFERED with offered_at from the share-offer fallback)
GRANT INSERT (attempt_id, result_id, subject_participant_id, iteration, status, offer_message, suggested_content,
              suggested_reason, offered_at) ON context_share_offer TO mwf_job;
-- sharing.ts shareAccepted: the delivery stamp of the shared text; notifications.ts getPendingActionsHandler:
-- the notification path writes delivery_notified_at / seen_notified_at (review F4.2); stage2.ts
-- triggerStage3Transition: status → EXPIRED when the Stage 2 sharing window closes
GRANT UPDATE (status, delivery_status, delivered_at, delivery_notified_at, seen_notified_at) ON context_share_offer TO mwf_job;

-- TS-10 fix1 I4 (Ruling R35): the reconciler READER. The reconciler runs as the job: every
-- read of the analysis path (services/reconciler/{analysis,state,sharing,circuit-breaker}.ts,
-- stage2.ts triggerReconcilerAndUpdateStatuses) goes through mwf_job, so the request that
-- triggered an analysis never reads the other participant's private rows on its own
-- connection. These are exactly the analysis inputs; nothing else of the tables below.
-- analysis.ts stagedChat (witnessing content, the subject's recent Stage 2 turns) and
-- state.ts markEmpathyReady's de-dup guard (lastAiNote): the text and speaker of the
-- MAIN-conversation CHAT rows of the two parties (conversation_id, kind, created_at granted above).
GRANT SELECT (role, content, sender_participant_id) ON message TO mwf_job;
-- analysis.ts loadSubjectFacts: the subject's NOTABLE_FACTS document (participant_id, kind granted above;
-- id because a Prisma model read always selects the primary key — measured: denied without it)
GRANT SELECT (id, doc) ON ai_memory TO mwf_job;
-- analysis.ts milestonesOf: when each milestone was reached — the stage each chat row was written in
GRANT SELECT (reached_at) ON participant_milestone TO mwf_job;
-- empathy-store sessionParties (the reconciler's A/B order and the names in its prompts)
GRANT SELECT (joined_at, display_name) ON participant TO mwf_job;
GRANT SELECT (first_name, name) ON "user" TO mwf_job;
-- analysis.ts currentResultFor / analyzeEmpathyGap's cached result, sharing.ts generateShareOffer,
-- state.ts reveal quality note: the stored analysis an analysis reuses (RESULT_SELECT)
GRANT SELECT (subject_participant_id, alignment_score, alignment_summary, correctly_identified, gap_severity,
              gap_summary, missed_feelings, misattributions, most_important_gap, recommended_action, rationale,
              sharing_would_help, suggested_share_focus, suggested_share_content, suggested_share_reason, created_at)
  ON reconciler_result TO mwf_job;
-- analysis.ts guidanceFor: the guidance of a cached result
GRANT SELECT (result_id, area_hint, guidance_type, prompt_seed) ON reconciler_guidance TO mwf_job;
-- sharing.ts generateShareSuggestion(ForDirection) / generateShareOffer: does this result already
-- have an offer (with a suggestion)? Never the shared text.
GRANT SELECT (result_id, suggested_content) ON context_share_offer TO mwf_job;

-- TS-11: the job's writers in needs, repair and follow-up (spec §1.4 agreement
-- "I job (the mutual-willingness path)", agreement_party "I job",
-- session_closure "I job", proposal "U … mwf_job (status, shared_at)",
-- proposal_revision "I … job", follow_up "I … job (scheduler) · U … job
-- (status)", reminder "status → DELIVERED by mwf_job"). Every job write is a
-- raw INSERT/UPDATE naming exactly these columns (no client-side defaults).
-- repair-store createAgreementsAsJob: the agreement row (snapshot of the proposal) and its id (RETURNING id)
GRANT INSERT (session_id, proposal_id, type, status, description, duration, measure_of_success, follow_up_at) ON agreement TO mwf_job;
-- repair-store: RETURNING id; T-agreement-parties (invoker = mwf_job) reads the agreement's session, proposal and instant;
-- tending: the agreement a follow-up is about (status moves)
GRANT SELECT (id, session_id, proposal_id, status, created_at) ON agreement TO mwf_job;
-- tending resolve/closure paths: an agreement moves AGREED → IN_PROGRESS → COMPLETED | ABANDONED
GRANT UPDATE (status, completed_at) ON agreement TO mwf_job;
-- repair-store createAgreementsAsJob: one party row per present human
GRANT INSERT (agreement_id, participant_id, agreed_at) ON agreement_party TO mwf_job;
-- T-agreement-parties (deferred, invoker = mwf_job): the party set
GRANT SELECT (agreement_id, participant_id) ON agreement_party TO mwf_job;
-- T-agreement-parties: every party WILLING on the proposal
GRANT SELECT (proposal_id, participant_id, decision) ON proposal_choice TO mwf_job;
-- stage4-closure closureInputsAsJob (fix round 1): the closure decides across every participant on the
-- job connection — the proposals it converts / schedules (snapshot text for the agreement and follow-up)
GRANT SELECT (session_id, kind, status, description, duration, measure_of_success, shared_at) ON proposal TO mwf_job;
-- repair-store convertProposalsAsJob: ACTIVE/REVISED → CONVERTED_TO_AGREEMENT (WHERE id = …: SELECT id is granted above)
GRANT UPDATE (status) ON proposal TO mwf_job;
-- repair-store: the conversion's audit row (append-only; no message id, lineage in before/after)
GRANT INSERT (proposal_id, actor_participant_id, action, before, after, reason) ON proposal_revision TO mwf_job;
-- repair-store closeSessionAsJob: how the repair stage ended (the three id arrays are v_session_closure_items)
GRANT INSERT (session_id, kind, reason, summary, closed_by_participant_id, check_in_at, closed_at) ON session_closure TO mwf_job;
-- tending scheduleFollowUpsAsJob: SHARED agreements and INDIVIDUAL commitments scheduled at closure, and the
-- next round a check-in schedules (EXTEND / PARTIAL_CLOSURE continuing: a follow-up is one cycle) (RETURNING id: SELECT id granted above)
GRANT INSERT (session_id, agreement_id, proposal_id, type, scope, owner_participant_id, opted_in_shared, status, scheduled_for,
              response_deadline_at, summary) ON follow_up TO mwf_job;
-- open-due-tending-entries (runs as the job): find due SCHEDULED rows (sql_follow_up_due), whom to notify, the cycle columns it moves
GRANT SELECT (session_id, agreement_id, type, owner_participant_id, status, scheduled_for, response_deadline_at) ON follow_up TO mwf_job;
-- open-due / cycle resolution: SCHEDULED → OPEN (opened_at, the response deadline), OPEN/PARTIAL → COMPLETED | EXPIRED
GRANT UPDATE (status, opened_at, completed_at, response_deadline_at) ON follow_up TO mwf_job;
-- processDueTendingReminders (job): due SCHEDULED reminders (sql_reminder_due) → DELIVERED, or the next remind_at for a cadence
GRANT SELECT (id, follow_up_id, scope, remind_at, cadence, status) ON reminder TO mwf_job;
GRANT UPDATE (status, remind_at) ON reminder TO mwf_job;

-- TS-12: the job's writers and readers in telemetry, notifications, deletion and
-- retention (spec §1.8 brain_activity "mwf_job writes, mwf_ops reads"; R35 — the
-- job is the principal for work that crosses users, the anonymise walk and
-- retention). Every job statement is raw and names exactly these columns.
-- brain-service startActivity: the telemetry row, attributed at capture (participant_id,
-- reflection_id); id / created_at are column defaults returned by RETURNING
GRANT INSERT (session_id, reflection_id, participant_id, turn_id, activity_type, call_type, model, input, metadata, status)
  ON brain_activity TO mwf_job;
-- startActivity RETURNING id, created_at; completeActivity / failActivity WHERE id = …;
-- data-retention's purge and delete windows (WHERE created_at < …; session_id granted above). Never a blob.
GRANT SELECT (id, created_at) ON brain_activity TO mwf_job;
-- completeActivity / failActivity: the outcome of the call (metadata replaced, never read back)
GRANT UPDATE (output, token_count_input, token_count_output, cost, duration_ms, status, completed_at, structured_output, metadata)
  ON brain_activity TO mwf_job;
-- data-retention: the short-retention purge sets the four blobs NULL (spec §1.8)
GRANT UPDATE (input) ON brain_activity TO mwf_job;
-- push.ts sendPushNotification: the recipient's devices — another user than the caller, so the
-- job reads them (user_device RLS is user_id = me); newest device first (last_seen_at)
GRANT SELECT (user_id, push_token, last_seen_at) ON user_device TO mwf_job;
-- push.ts: a token Expo reports as unregistered is cleared (WHERE user_id = … AND push_token = …)
GRANT UPDATE (push_token) ON user_device TO mwf_job;
-- session-deletion: the leaver's session-scoped user_memory goes with the leave (DELETE granted above)
GRANT SELECT (session_id) ON user_memory TO mwf_job;
-- session-retention: staleness of an ACTIVE session and the purge window of an ARCHIVED one
GRANT SELECT (updated_at) ON session TO mwf_job;
-- session-retention: an ARCHIVED session past the purge window is hard-deleted (every child
-- FKs session ON DELETE CASCADE; spec Conventions "retention hard-deletes whole sessions")
GRANT DELETE ON session TO mwf_job;

-- mwf_ops: SELECT on exactly the tables routes/brain.ts reads, re-based
-- (BrainActivity, Session/Relationship/RelationshipMember/User, StageProgress,
-- Message, UserVessel.notableFacts, EmotionalReading, InnerWorkSession/Message).
GRANT USAGE ON SCHEMA public TO mwf_ops;
GRANT SELECT ON brain_activity, session, relationship, relationship_member, "user", participant, participant_milestone,
                milestone, conversation, message, ai_memory, mood_reading, reflection, reflection_message, v_current_stage
  TO mwf_ops;

-- mwf_auth: the bootstrap function only (granted in T4); nothing on tables.

-- milestone is reference data (P3 §1.1 pattern): readable by the request role.
GRANT SELECT ON milestone TO mwf_app;

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

  -- Every jsonb column has a jsonb_typeof CHECK.
  SELECT string_agg(c.table_name || '.' || c.column_name, ', ' ORDER BY c.table_name, c.column_name) INTO bad
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.data_type = 'jsonb'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                    WHERE k.contype = 'c' AND k.conrelid = format('public.%I', c.table_name)::regclass
                      AND pg_get_constraintdef(k.oid) ~ ('jsonb_typeof\(' || c.column_name || '\) (= |= ANY )'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: jsonb column(s) without a jsonb_typeof CHECK: %', bad; END IF;

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
