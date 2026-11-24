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
--   T7  the database's ACL (PUBLIC loses CONNECT / TEMPORARY, the capabilities
--       get CONNECT), the seed checks, then ENABLE + FORCE ROW LEVEL SECURITY
--       and the policies of every table (work-k5fk.10.6, §7 row 9c). No grants:
--       since work-k5fk.7 every grant sits next to its object
--   T8  catalog assertions (plan step 20). The database is empty, so there are
--       no existing rows to re-check: every invariant is enforced by its
--       trigger or CHECK from the first write on.
--
-- Not here: the milestone seed (in
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
-- "Who is calling?" inside a SECURITY DEFINER function: current_user is the
-- owner (mwf_definer), so every arm reads session_user — the login — and asks
-- what the database can know itself (design note §6 "Session variables"):
--   the app arm    pg_has_role(session_user, 'app_access', 'USAGE') and the
--                  identity (app.current_user_id()) is the row's participant;
--   the AI arm     pg_has_role(session_user, 'ai_access', 'USAGE') and
--                  app.session_scope() is the row's session (Q20: required —
--                  an unset scope is NULL, so the arm fails closed), and its
--                  acting user is a participant of it (app.scope_actor_is_member;
--                  work-k5fk.10.7 review F6, as the ai_session policies);
--   the worker arm the same with worker_access;
--   mwf_migrator   local tooling and the caller tests (never a runtime client).
-- An arm never borrows another's: the AI's client binds the request's identity
-- too, so an identity arm without the app capability would let the AI act
-- without a scope. mwf_job, which was all of these at once, is retired
-- (work-k5fk.10.5, §7 row 9b).
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
-- app.json_schema with the caller's rights (SELECT: app_access, ai_access —
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
-- app_access, ai_access (mwf_app's and mwf_ai's: user_preferences.doc, ai_memory.doc): the t_doc_schema trigger calls it
-- with the writer's rights.
REVOKE EXECUTE ON FUNCTION app.jsonb_violation(jsonb, text, public.schema_version) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jsonb_violation(jsonb, text, public.schema_version) TO app_access;
GRANT EXECUTE ON FUNCTION app.jsonb_violation(jsonb, text, public.schema_version) TO ai_access;

-- Does doc match the seeded schema (name, version)? (MWJ01 for an unknown one.)
CREATE FUNCTION app.jsonb_matches(doc jsonb, name text, version public.schema_version) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  RETURN app.jsonb_violation(doc, name, version) IS NULL;
COMMENT ON FUNCTION app.jsonb_matches(jsonb, text, public.schema_version) IS 'True when doc matches the app.json_schema row (name, version); raises MWJ01 for an unknown one. For ad-hoc checks and tests; the trigger uses app.jsonb_violation for its message.';
-- app_access (mwf_app's): no app caller today; the caller tests use it.
REVOKE EXECUTE ON FUNCTION app.jsonb_matches(jsonb, text, public.schema_version) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jsonb_matches(jsonb, text, public.schema_version) TO app_access;

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
-- mwf_app (app_access): no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app.
REVOKE EXECUTE ON FUNCTION app.is_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO app_access;

-- Is the caller a PRESENT participant of this session (seated, not left)? Review F4: a leaver keeps reading
-- (app.is_member) but loses every write — the app_active_* restrictive policies and the session INSERT's
-- previous_session_id test.
CREATE FUNCTION app.is_current_member(session uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.participant p
      WHERE p.session_id = is_current_member.session AND p.user_id = app.current_user_id() AND p.left_at IS NULL
    )
  $$;
COMMENT ON FUNCTION app.is_current_member(uuid) IS 'True when the caller is a participant of the session who has not left. The write half of app.is_member (review F4).';
-- mwf_app (app_access): the app_active_* RLS policies.
REVOKE EXECUTE ON FUNCTION app.is_current_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_current_member(uuid) TO app_access;

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
-- mwf_app (app_access): no app caller today; the RLS policies of design note §6 (rows 9d–9g) evaluate it as mwf_app.
REVOKE EXECUTE ON FUNCTION app.partner_user_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.partner_user_id(uuid) TO app_access;

-- The row predicates of the §6 policies (rows 9d–9g, work-k5fk.10.7) that need a row the caller does not see
-- (or holds no grant on): definers, so a policy never recurses into another table's policy (spec P1-1). Each is a
-- boolean of the caller's identity (app.current_user_id(); NULL never matches) or scope, and nothing more.

-- A session nobody is seated in yet: createSession's INSERT … RETURNING (and tending's linked process) reads the
-- new session back before its initiator's participant row exists. Committed, every session has a participant
-- (both writers seat the initiator in the same transaction), so the arm reaches only that moment.
-- Review F12 (accepted, documented): the arm cannot be scoped to its creator — session has no creator column, and
-- the initiator's participant row, which would name them, is what does not exist yet. An unseated CREATED session
-- other than one's own in-flight insert is unreachable: no committed state holds one (the two writers above seat
-- the initiator in the session's own transaction, which is invisible to every other transaction until it commits),
-- mwf_app cannot DELETE a participant, and seats go only with their session (the worker's retention purge,
-- t_session_purge). A superuser or migration that commits an unseated session would open it; none does.
-- Review F13 (accepted, documented): true for a session id that does not exist, so with app.session_invitee_access
-- it tells a signed-in caller whether an id names a session. The ids are UUIDv7 (not enumerable), and the answer
-- carries nothing of the session.
CREATE FUNCTION app.session_unseated(session uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$ SELECT NOT EXISTS (SELECT 1 FROM public.participant p WHERE p.session_id = session_unseated.session) $$;
COMMENT ON FUNCTION app.session_unseated(uuid) IS 'True when no participant is seated in the session yet (the moment between createSession''s INSERT and its initiator''s participant row). RLS predicate of session (work-k5fk.10.7).';
-- mwf_app (app_access): the session policy app_select.
REVOKE EXECUTE ON FUNCTION app.session_unseated(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_unseated(uuid) TO app_access;

-- Is this user a live human the caller shares a session with (both seated in one, leavers included, as
-- app.is_member)? createSession's personId check: a session is started only with a known person (review F7: "user"
-- no longer shows a co-participant's row, so the check asks here and learns nothing but yes or no).
CREATE FUNCTION app.shares_session_with(other uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.participant me
      JOIN public.participant o ON o.session_id = me.session_id AND o.user_id = shares_session_with.other
      JOIN public."user" u ON u.id = o.user_id AND u.kind = 'human' AND u.deleted_at IS NULL
      WHERE me.user_id = app.current_user_id()
    )
  $$;
COMMENT ON FUNCTION app.shares_session_with(uuid) IS 'True when the user is a live (not deleted) human who shares a session with the caller (leavers included). createSession''s personId check (work-k5fk.10.7, review F7).';
-- mwf_app (app_access): controllers/invitations.ts createSession.
REVOKE EXECUTE ON FUNCTION app.shares_session_with(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.shares_session_with(uuid) TO app_access;

-- Is this user a persona the caller owns (design note §6 "user" S)? mwf_app holds nothing on persona.
CREATE FUNCTION app.owns_persona("user" uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM public.persona x
                   WHERE x.user_id = owns_persona."user" AND x.owner_user_id = app.current_user_id())
  $$;
COMMENT ON FUNCTION app.owns_persona(uuid) IS 'True when the user is a persona the caller owns. RLS predicate of "user" (work-k5fk.10.7).';
-- mwf_app (app_access): the "user" policy app_select.
REVOKE EXECUTE ON FUNCTION app.owns_persona(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.owns_persona(uuid) TO app_access;

-- The AI's acting user (the request's identity, which the AI connection binds too) is a participant of the one
-- session its transaction is scoped to (design note §6: the ai_access policies are the scope "and the acting user
-- must be a member"). An unset scope or identity: false.
CREATE FUNCTION app.scope_actor_is_member() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM public.participant p
                   WHERE p.session_id = app.session_scope() AND p.user_id = app.current_user_id())
  $$;
COMMENT ON FUNCTION app.scope_actor_is_member() IS 'True when the acting user (app.current_user_id) is a participant of app.session_scope. The membership term of the ai_access policies (work-k5fk.10.7).';
-- mwf_ai (ai_access): every ai_session policy, as (SELECT app.scope_actor_is_member()).
REVOKE EXECUTE ON FUNCTION app.scope_actor_is_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scope_actor_is_member() TO ai_access;

-- Is this reflection the acting user's? The AI's sessionless telemetry of an inner-work call (brain_activity with
-- a reflection_id) is its owner's only (work-k5fk.10.33: any AI transaction read and rewrote every sessionless row).
CREATE FUNCTION app.owns_reflection(reflection uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM public.reflection r
                   WHERE r.id = owns_reflection.reflection AND r.user_id = app.current_user_id())
  $$;
COMMENT ON FUNCTION app.owns_reflection(uuid) IS 'True when the reflection is the acting user''s. RLS predicate of the AI''s sessionless brain_activity rows (work-k5fk.10.33).';
-- mwf_ai (ai_access): the brain_activity policy ai_reflection.
REVOKE EXECUTE ON FUNCTION app.owns_reflection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.owns_reflection(uuid) TO ai_access;

-- An invitation as someone who is not (yet) a participant may see it (design note §6 invitation: "pre-membership
-- accept read via definer app.invitation_peek(id)"). Until it is claimed, the invitation's link is the credential: a
-- caller who names the id reads this much — never the session's content, only whether it is ready to join. No identity
-- is required: GET /invitations/:id (the link's preview) is public, rate-limited (routes/invitations.ts). Once claimed
-- (work-k5fk.10.8: the first signed-in non-inviter to open it, app.invitation_claim), only the claimer and the inviter
-- read the details; anyone else gets the claim notice: withheld = true, and only the id, status, expiry, creation and
-- claimed = true. claimed_by_name is the claimer's name (user.name, read now, never stored), for the inviter and the
-- claimer. invitee_name is the inviter's name for the invitee, ciphertext (the caller decrypts). No row: not found.
CREATE FUNCTION app.invitation_peek(invitation uuid)
  RETURNS TABLE (id uuid, session_id uuid, invited_by_user_id uuid, inviter_display_name text, invitee_name text,
                 status public.invitation_status, accepted_by_user_id uuid, message_confirmed_at timestamptz,
                 expires_at timestamptz, created_at timestamptz, session_status public.session_status,
                 topic_frame_confirmed boolean, claimed boolean, withheld boolean, claimed_by_user_id uuid,
                 claimed_by_name text, claimed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT i.id,
           CASE WHEN v.shown THEN i.session_id END,
           CASE WHEN v.shown THEN i.invited_by_user_id END,
           CASE WHEN v.shown THEN p.display_name END,
           CASE WHEN v.shown THEN i.invitee_name END,
           i.status,
           CASE WHEN v.shown THEN i.accepted_by_user_id END,
           CASE WHEN v.shown THEN i.message_confirmed_at END,
           i.expires_at, i.created_at,
           CASE WHEN v.shown THEN s.status END,
           CASE WHEN v.shown THEN (s.topic_frame IS NOT NULL AND s.topic_frame_confirmed_at IS NOT NULL) END,
           i.claimed_by_user_id IS NOT NULL,
           NOT v.shown,
           CASE WHEN v.shown THEN i.claimed_by_user_id END,
           CASE WHEN v.shown THEN u.name END,
           CASE WHEN v.shown THEN i.claimed_at END
    FROM public.invitation i
    JOIN public.session s ON s.id = i.session_id
    JOIN public.participant p ON p.session_id = i.session_id AND p.user_id = i.invited_by_user_id
    LEFT JOIN public."user" u ON u.id = i.claimed_by_user_id
    CROSS JOIN LATERAL (SELECT (i.claimed_by_user_id IS NULL
                                OR i.claimed_by_user_id = app.current_user_id()
                                OR i.invited_by_user_id = app.current_user_id()) IS TRUE AS shown) v
    WHERE i.id = invitation_peek.invitation AND pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
  $$;
COMMENT ON FUNCTION app.invitation_peek(uuid) IS 'The invitation by id for a caller who need not be a participant, nor signed in (until it is claimed its link is the credential; the preview is public): status, expiry, the inviter''s display name, the invitee name (ciphertext), whether the session is ready to join, and who claimed it. Once claimed, only the claimer and the inviter see past the claim notice (withheld). app_access (work-k5fk.10.7, work-k5fk.10.8).';
-- mwf_app (app_access): invitations.ts getInvitation, acceptInvitation, declineInvitation, acknowledgeInvitation;
-- sessions.ts getInvitation and session-state.ts (the inviter's view of who claimed it).
REVOKE EXECUTE ON FUNCTION app.invitation_peek(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_peek(uuid) TO app_access;

-- The first signed-in caller other than the inviter to open a PENDING, unexpired invitation claims it: they become its
-- invitee, the only one who reads its details (app.invitation_peek), accepts or declines it (app.invitation_answer).
-- Owner decision 2026-11-23, work-k5fk.10.8. One UPDATE … WHERE claimed_by_user_id IS NULL, so two openers race to
-- one winner; the claimer opening it again is a no-op. Identity-bound. Refusals: not found (P0002; the inviter, no
-- identity), claimed by someone else (MWI01), not PENDING or expired (check_violation). Returns claimed_at.
CREATE FUNCTION app.invitation_claim(invitation uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me      uuid := app.current_user_id();
    v_inviter uuid;
    v_status  public.invitation_status;
    v_expires timestamptz;
    v_claimer uuid;
    v_at      timestamptz;
  BEGIN
    IF v_me IS NULL OR NOT pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') THEN
      RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.invitation i SET claimed_by_user_id = v_me, claimed_at = CURRENT_TIMESTAMP
    WHERE i.id = invitation_claim.invitation AND i.claimed_by_user_id IS NULL AND i.invited_by_user_id <> v_me
      AND i.status = 'PENDING' AND i.expires_at > CURRENT_TIMESTAMP
    RETURNING i.claimed_at INTO v_at;
    IF FOUND THEN
      RETURN v_at;
    END IF;
    SELECT i.invited_by_user_id, i.status, i.expires_at, i.claimed_by_user_id, i.claimed_at
    INTO v_inviter, v_status, v_expires, v_claimer, v_at
    FROM public.invitation i WHERE i.id = invitation_claim.invitation;
    IF v_inviter IS NULL OR v_inviter = v_me THEN
      RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_claimer = v_me THEN
      RETURN v_at;
    END IF;
    IF v_claimer IS NOT NULL THEN
      RAISE EXCEPTION 'invitation was claimed by someone else' USING ERRCODE = 'MWI01';
    END IF;
    IF v_status <> 'PENDING' THEN
      RAISE EXCEPTION 'invitation is %, not PENDING', v_status USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'invitation has expired' USING ERRCODE = 'check_violation';
  END
  $$;
COMMENT ON FUNCTION app.invitation_claim(uuid) IS 'The caller (signed in, not the inviter) claims a PENDING unexpired invitation as its invitee: first opener wins; idempotent for the claimer. Returns claimed_at. Refusals: P0002 not found / the inviter, MWI01 claimed by someone else, check_violation not PENDING or expired. Identity-bound, app_access (work-k5fk.10.8).';
-- mwf_app (app_access): invitations.ts acknowledgeInvitation (what the app calls when the link opens).
REVOKE EXECUTE ON FUNCTION app.invitation_claim(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_claim(uuid) TO app_access;

-- The invitee's answer to a PENDING invitation (design note §6: the inviter's row is written only through a
-- function): ACCEPTED (not yet expired; accepted by the caller, at instant), DECLINED (with the reason, ciphertext),
-- or EXPIRED (only once past expires_at). Identity-bound, never the inviter. Locks the invitation FOR UPDATE first:
-- the accept's lock (work-99k2: a concurrent pre-join draft save holds it FOR SHARE). ACCEPTED and DECLINED are the
-- claimer's alone (work-k5fk.10.8): an unclaimed invitation is claimed by the answer, under that lock; one claimed by
-- someone else is refused (MWI01). EXPIRED is a fact about the clock, any non-inviter's to record. Refusals: not found
-- (P0002; the inviter too), claimed by someone else (MWI01), not PENDING, not expired, expired (check_violation).
CREATE FUNCTION app.invitation_answer(invitation uuid, answer public.invitation_status, instant timestamptz DEFAULT NULL,
                                      reason text DEFAULT NULL)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me      uuid := app.current_user_id();
    v_now     timestamptz := CURRENT_TIMESTAMP;
    v_at      timestamptz := coalesce(invitation_answer.instant, CURRENT_TIMESTAMP);
    v_inviter uuid;
    v_status  public.invitation_status;
    v_expires timestamptz;
    v_claimer uuid;
  BEGIN
    IF v_me IS NULL OR NOT pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') THEN
      RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002';
    END IF;
    SELECT i.invited_by_user_id, i.status, i.expires_at, i.claimed_by_user_id
    INTO v_inviter, v_status, v_expires, v_claimer
    FROM public.invitation i WHERE i.id = invitation_answer.invitation FOR UPDATE;
    IF v_inviter IS NULL OR v_inviter = v_me THEN
      RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002';
    END IF;
    IF invitation_answer.answer IN ('ACCEPTED', 'DECLINED') AND v_claimer <> v_me THEN
      RAISE EXCEPTION 'invitation was claimed by someone else' USING ERRCODE = 'MWI01';
    END IF;
    IF v_status <> 'PENDING' THEN
      RAISE EXCEPTION 'invitation is %, not PENDING', v_status USING ERRCODE = 'check_violation';
    END IF;
    -- review F3: the instant only stamps the answer (accepted_at / declined_at), and only near now — as
    -- app.deliver_message / empathy_mark_delivery; expiry is always judged against the database's clock.
    IF v_at < v_now - interval '10 minutes' OR v_at > v_now + interval '5 seconds' THEN
      RAISE EXCEPTION 'an answer is stamped now (within ten minutes back, five seconds ahead)' USING ERRCODE = 'check_violation';
    END IF;
    IF invitation_answer.answer = 'ACCEPTED' THEN
      IF v_expires <= v_now THEN
        RAISE EXCEPTION 'invitation has expired' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE public.invitation i
      SET status = 'ACCEPTED', accepted_by_user_id = v_me, accepted_at = v_at,
          claimed_by_user_id = v_me, claimed_at = coalesce(i.claimed_at, v_at)
      WHERE i.id = invitation_answer.invitation;
    ELSIF invitation_answer.answer = 'DECLINED' THEN
      UPDATE public.invitation i
      SET status = 'DECLINED', declined_at = v_at, decline_reason = invitation_answer.reason::public.ciphertext,
          claimed_by_user_id = v_me, claimed_at = coalesce(i.claimed_at, v_at)
      WHERE i.id = invitation_answer.invitation;
    ELSIF invitation_answer.answer = 'EXPIRED' THEN
      IF v_expires > v_now THEN
        RAISE EXCEPTION 'invitation has not expired' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE public.invitation i SET status = 'EXPIRED' WHERE i.id = invitation_answer.invitation;
    ELSE
      RAISE EXCEPTION 'not an answer: %', invitation_answer.answer USING ERRCODE = 'check_violation';
    END IF;
  END
  $$;
COMMENT ON FUNCTION app.invitation_answer(uuid, public.invitation_status, timestamptz, text) IS 'The invitee''s answer to a PENDING invitation: ACCEPTED (by the caller, before expiry), DECLINED (with a ciphertext reason) or EXPIRED (past expiry). ACCEPTED and DECLINED only by its claimer, claiming it when no one has (MWI01 otherwise). Identity-bound, app_access, never the inviter; locks the invitation FOR UPDATE (work-k5fk.10.7, work-k5fk.10.8).';
-- mwf_app (app_access): invitations.ts acceptInvitation, declineInvitation.
REVOKE EXECUTE ON FUNCTION app.invitation_answer(uuid, public.invitation_status, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_answer(uuid, public.invitation_status, timestamptz, text) TO app_access;

-- At accept, inside the transaction that seats the invitee (invitations.ts acceptInvitation, after the participant
-- row): the inviter's EMPATHY drafts about the invitation become about the invitee (about_user_id = the invitee,
-- invitation_id = NULL; work-99k2). A move — delete, then insert the same row with the new arc — not an UPDATE:
-- touch_updated_at would stamp updated_at, which is the draft's written-at (preJoinReview). id, created_at,
-- updated_at, version and reopened_at carry over; content is copied as it is stored (one key, no row binding:
-- lib/prisma-encryption-middleware.ts). The caller is the invitee: identity-bound, the invitation is ACCEPTED by
-- them and they are seated in its session (a definer, work-k5fk.10.7: the drafts are the inviter's own rows).
-- Returns the drafts moved.
CREATE FUNCTION app.invitation_repoint_drafts(invitation uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me      uuid := app.current_user_id();
    v_session uuid;
    v_rows    public.draft[];
  BEGIN
    SELECT i.session_id INTO v_session FROM public.invitation i
    WHERE i.id = invitation_repoint_drafts.invitation AND i.status = 'ACCEPTED' AND i.accepted_by_user_id = v_me;
    IF v_me IS NULL OR v_session IS NULL OR NOT pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
       OR NOT EXISTS (SELECT 1 FROM public.participant p WHERE p.session_id = v_session AND p.user_id = v_me) THEN
      RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002';
    END IF;
    -- The DELETE takes the rows' locks (the invitation lock is the protocol; this keeps the move safe from any
    -- writer that skips it); the INSERT is a second statement, so the same ids are free again.
    WITH moved AS (DELETE FROM public.draft d WHERE d.invitation_id = invitation_repoint_drafts.invitation RETURNING d.*)
    SELECT array_agg(m ORDER BY m.id) INTO v_rows FROM moved m;
    IF v_rows IS NULL THEN
      RETURN 0;
    END IF;
    INSERT INTO public.draft (id, session_id, user_id, kind, about_user_id, content, ready_to_share, version,
                              created_at, updated_at, reopened_at)
    SELECT r.id, r.session_id, r.user_id, r.kind, v_me, r.content, r.ready_to_share, r.version,
           r.created_at, r.updated_at, r.reopened_at
    FROM unnest(v_rows) r;
    RETURN cardinality(v_rows);
  END
  $$;
COMMENT ON FUNCTION app.invitation_repoint_drafts(uuid) IS 'At accept: the inviter''s EMPATHY drafts about the invitation move to the invitee (same id and timestamps). The invitee, seated, who accepted it (identity-bound, app_access). work-99k2, work-k5fk.10.7.';
-- mwf_app (app_access): empathy-store repointInvitationDrafts (acceptInvitation).
REVOKE EXECUTE ON FUNCTION app.invitation_repoint_drafts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_repoint_drafts(uuid) TO app_access;

-- What a push to `recipient` calls the caller (push.ts getNotificationActorName): the recipient's own name for them —
-- their user_contact entry for the caller (authoritative when present, a cleared NULL included), else the invite name
-- on the recipient's latest invitation the caller accepted (ciphertext; contacts.ts namesIGave's order). Both are the
-- recipient's private rows (user_contact app_own, invitation app_select), read here only by the actor the push is
-- about, for a recipient they share a session with (work-k5fk.10.7). No row: no such recipient for the caller.
-- Review r1 (accepted, owner decision 2026-11-18): the recipient's nickname for the actor thus reaches the actor's
-- request — server memory only. push.ts composes the push to the recipient from it and returns it to no client: the
-- actor's own device never receives it.
CREATE FUNCTION app.actor_name_for(recipient uuid)
  RETURNS TABLE (has_entry boolean, nickname text, invite_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT c.user_id IS NOT NULL, c.nickname,
           (SELECT i.invitee_name FROM public.invitation i
            WHERE i.invited_by_user_id = actor_name_for.recipient AND i.accepted_by_user_id = app.current_user_id()
              AND i.invitee_name IS NOT NULL
            ORDER BY i.created_at DESC LIMIT 1)
    FROM (SELECT 1) one
    LEFT JOIN public.user_contact c ON c.user_id = actor_name_for.recipient AND c.contact_user_id = app.current_user_id()
    WHERE pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND app.shares_session_with(actor_name_for.recipient)
  $$;
COMMENT ON FUNCTION app.actor_name_for(uuid) IS 'The recipient''s own name for the caller (their user_contact nickname, else the invite name of their invitation the caller accepted, ciphertext), for a push about the caller to a recipient they share a session with; server memory only, never the caller''s client (review r1, accepted). Identity-bound, app_access (work-k5fk.10.7).';
-- mwf_app (app_access): push.ts getNotificationActorName.
REVOKE EXECUTE ON FUNCTION app.actor_name_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_name_for(uuid) TO app_access;

-- A co-participant's presence for the session view (participant-resolver getCoParticipantPresence;
-- session-state.ts): whether they show their activity, when they last viewed the session and were last active, and
-- when they last took a turn — instants only, never content. Their read state, preferences and messages are own-row
-- under RLS (work-k5fk.10.7), so a participant of the same session reads them here. When they hide their activity
-- (user_preferences.doc.privacy.showActivityStatus false) the three instants are NULL: the caller shows none (review F2).
CREATE FUNCTION app.co_participant_presence(session uuid, "user" uuid)
  RETURNS TABLE (shows boolean, last_viewed_at public.ts_ms, last_active_at public.ts_ms, last_turn_at public.ts_ms)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT v.shows,
           CASE WHEN v.shows IS DISTINCT FROM false THEN r.last_viewed_at END,
           CASE WHEN v.shows IS DISTINCT FROM false THEN r.last_active_at END,
           CASE WHEN v.shows IS DISTINCT FROM false THEN
             (SELECT max(m.created_at) FROM public.message m
              WHERE m.session_id = p.session_id AND m.sender_user_id = p.user_id AND m.role = 'USER' AND m.kind = 'CHAT')
           END
    FROM public.participant p
    LEFT JOIN public.conversation_read_state r ON r.session_id = p.session_id AND r.user_id = p.user_id
    LEFT JOIN public.user_preferences up ON up.user_id = p.user_id
    CROSS JOIN LATERAL (SELECT (up.doc -> 'privacy' ->> 'showActivityStatus')::boolean AS shows) v
    WHERE p.session_id = co_participant_presence.session AND p.user_id = co_participant_presence."user"
      AND EXISTS (SELECT 1 FROM public.participant me
                  WHERE me.session_id = co_participant_presence.session AND me.user_id = app.current_user_id())
  $$;
COMMENT ON FUNCTION app.co_participant_presence(uuid, uuid) IS 'A co-participant''s presence instants (last viewed, last active and last turn — the latter two NULL when they hide their activity) and whether they show it, for a caller seated in the same session. Identity-bound, app_access (work-k5fk.10.7).';
-- mwf_app (app_access): participant-resolver getCoParticipantPresence (session-state.ts).
REVOKE EXECUTE ON FUNCTION app.co_participant_presence(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.co_participant_presence(uuid, uuid) TO app_access;

-- Content-free facts of empathy attempts the caller is a party of (author or subject): who wrote it, about whom,
-- the round and its status (with status_version, the optimistic check of app.empathy_set_status) — never content.
-- The subject of an unrevealed attempt does not see its row (empathy_attempt app_select, P0-2), yet answers a share
-- offer on it, which moves its round (reconciler.ts, reconciler/sharing.ts, notifications.ts). work-k5fk.10.7.
CREATE FUNCTION app.attempt_meta(attempts uuid[])
  RETURNS TABLE (id uuid, session_id uuid, author_user_id uuid, subject_user_id uuid, round integer,
                 status public.empathy_status, status_version integer, revealed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT a.id, a.session_id, a.author_user_id, a.subject_user_id, a.round, a.status, a.status_version, a.revealed_at
    FROM public.empathy_attempt a
    WHERE a.id = ANY (attempt_meta.attempts)
      AND app.current_user_id() IN (a.author_user_id, a.subject_user_id)
      AND pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
  $$;
COMMENT ON FUNCTION app.attempt_meta(uuid[]) IS 'Who wrote each attempt, about whom, its round and status (status_version) — never its content — for an attempt the caller is the author or the subject of. Identity-bound, app_access (work-k5fk.10.7).';
-- mwf_app (app_access): empathy-store attemptMetaOf (the subject's share-offer paths).
REVOKE EXECUTE ON FUNCTION app.attempt_meta(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attempt_meta(uuid[]) TO app_access;

-- Content-free facts of reconciler results behind the guidance the caller may read (reconciler_guidance app_select:
-- author or subject): which attempt each analysed, its iteration and whether it was superseded — never the analysis.
-- The author of the attempt reads its guidance but not the result (reconciler_result app_select is the subject's,
-- R6), yet picks the current guidance by the result's superseded_at (context-assembler, empathy-status, stage2,
-- reconciler/state). For a result the caller is the subject of, or of an attempt the caller authored. work-k5fk.10.7.
CREATE FUNCTION app.result_facts(results uuid[])
  RETURNS TABLE (id uuid, attempt_id uuid, iteration integer, superseded_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.id, r.attempt_id, r.iteration, r.superseded_at
    FROM public.reconciler_result r
    JOIN public.empathy_attempt a ON a.id = r.attempt_id
    WHERE r.id = ANY (result_facts.results)
      AND app.current_user_id() IN (r.subject_user_id, a.author_user_id)
      AND pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
  $$;
COMMENT ON FUNCTION app.result_facts(uuid[]) IS 'Which attempt each reconciler result analysed, its iteration and superseded_at — never the analysis — for a result the caller is the subject of or whose attempt the caller authored. Identity-bound, app_access (work-k5fk.10.7).';
-- mwf_app (app_access): empathy-store resultFactsOf (the author's current guidance).
REVOKE EXECUTE ON FUNCTION app.result_facts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.result_facts(uuid[]) TO app_access;

-- What reached the caller as an attempt's AUTHOR through a share: the offers on attempts the caller authored whose
-- shared text was delivered (DELIVERED / SEEN) — the shared text, its status and instants, never the offer the
-- subject was shown (suggested_* / offer_message; R6). The offer row is the subject's (context_share_offer
-- app_select), and the author already holds the text as the delivered SHARED_CONTEXT line; the context assembler
-- reads it here (work-k5fk.10.7).
CREATE FUNCTION app.shares_delivered_to_me(session uuid)
  RETURNS TABLE (id uuid, subject_user_id uuid, status public.share_offer_status, delivery_status public.delivery_status,
                 shared_content text, shared_at timestamptz, delivered_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT o.id, o.subject_user_id, o.status, o.delivery_status, o.shared_content, o.shared_at, o.delivered_at
    FROM public.context_share_offer o
    JOIN public.empathy_attempt a ON a.id = o.attempt_id
    WHERE o.session_id = shares_delivered_to_me.session AND a.author_user_id = app.current_user_id()
      AND o.shared_content IS NOT NULL AND o.delivery_status IN ('DELIVERED', 'SEEN')
      AND pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
  $$;
COMMENT ON FUNCTION app.shares_delivered_to_me(uuid) IS 'The shared text (ciphertext), status and instants of the delivered share offers on attempts the caller authored — never the offer the subject was shown. Identity-bound, app_access (work-k5fk.10.7).';
-- mwf_app (app_access): context-assembler buildSharedVessel.
REVOKE EXECUTE ON FUNCTION app.shares_delivered_to_me(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.shares_delivered_to_me(uuid) TO app_access;

-- When each of the caller's own attempts was first validated by its subject (the earliest validated review): the
-- verdict reaches the author through their round's status, and the context assembler dates it (review rows are the
-- reviewer's until feedback is sent — empathy_review app_own / app_author_sent; work-k5fk.10.7).
CREATE FUNCTION app.validated_at(attempts uuid[])
  RETURNS TABLE (attempt_id uuid, validated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT v.attempt_id, min(v.created_at)
    FROM public.empathy_review v
    JOIN public.empathy_attempt a ON a.id = v.attempt_id
    WHERE v.attempt_id = ANY (validated_at.attempts) AND v.validated AND a.author_user_id = app.current_user_id()
      AND pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
    GROUP BY v.attempt_id
  $$;
COMMENT ON FUNCTION app.validated_at(uuid[]) IS 'The instant each of the caller''s own attempts was first validated (its earliest validated review''s created_at), nothing else of the review. Identity-bound, app_access (work-k5fk.10.7).';
-- mwf_app (app_access): context-assembler buildSharedVessel.
REVOKE EXECUTE ON FUNCTION app.validated_at(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.validated_at(uuid[]) TO app_access;

-- requireSessionAccess for a caller with no participant row (middleware/auth.ts): 'missing' when the session does
-- not exist, 'invited' when it has an invitation the caller did not send that is PENDING, unexpired and not claimed
-- by someone else (work-k5fk.10.8), or that
-- the caller accepted (the acceptance timing gap; Phase 3 §7 W6 schedules its removal), else 'denied'. Under RLS a
-- non-participant sees neither the session nor its invitation.
-- Review F13 (accepted, documented): 'missing' against 'denied' tells any signed-in caller whether a session id
-- exists. The route needs it (404 for no session, 403 for someone else's); the ids are UUIDv7 and nothing else of
-- the session is answered.
CREATE FUNCTION app.session_invitee_access(session uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT CASE
      WHEN app.current_user_id() IS NULL OR NOT pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') THEN 'denied'
      WHEN NOT EXISTS (SELECT 1 FROM public.session s WHERE s.id = session_invitee_access.session) THEN 'missing'
      WHEN EXISTS (SELECT 1 FROM public.invitation i
                   WHERE i.session_id = session_invitee_access.session AND i.invited_by_user_id <> app.current_user_id()
                     AND ((i.status = 'PENDING' AND i.expires_at > CURRENT_TIMESTAMP
                           AND (i.claimed_by_user_id IS NULL OR i.claimed_by_user_id = app.current_user_id()))
                          OR (i.status = 'ACCEPTED' AND i.accepted_by_user_id = app.current_user_id()))) THEN 'invited'
      ELSE 'denied' END
  $$;
COMMENT ON FUNCTION app.session_invitee_access(uuid) IS 'For a caller with no participant row in the session: missing (no such session), invited (a PENDING unexpired invitation they did not send and no one else claimed, or one they accepted) or denied. Identity-bound, app_access (work-k5fk.10.7, work-k5fk.10.8).';
-- mwf_app (app_access): middleware/auth.ts requireSessionAccess.
REVOKE EXECUTE ON FUNCTION app.session_invitee_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_invitee_access(uuid) TO app_access;

-- One participant's presence as a co-participant sees it (v_participant, below): their MAIN conversation's id, their
-- read state, their last activity (unless their privacy preference hides it from others) and their latest mood.
-- Each lives in an own-row table under RLS (conversation, conversation_read_state, user_preferences, mood_reading;
-- work-k5fk.10.7), so the view reads them here — for a participant of a session the caller is in, and nothing else.
CREATE FUNCTION app.participant_presence(session uuid, "user" uuid)
  RETURNS TABLE (main_conversation_id public.uuid7, last_viewed_at public.ts_ms, last_seen_conversation_id public.uuid7,
                 last_seen_seq integer, last_viewed_share_tab_at public.ts_ms, archived_at public.ts_ms,
                 last_active_at public.ts_ms, last_mood integer, user_name text, is_tombstone boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    -- review F2: a co-participant gets only what the app reads about a partner — the MAIN conversation's id, the
    -- shared-frame seen instant (reconciler/sharing.ts: the author saw the context shared with them) and the last
    -- activity when their privacy preference shows it. Their read state, archive flag and mood are the caller's own
    -- only (own-row tables), never a partner's.
    SELECT c.id,
           CASE WHEN v_self THEN r.last_viewed_at END,
           CASE WHEN v_self THEN r.last_seen_conversation_id END,
           CASE WHEN v_self THEN r.last_seen_seq END,
           r.last_viewed_share_tab_at,
           CASE WHEN v_self THEN r.archived_at END,
           CASE WHEN v_self OR coalesce((up.doc -> 'privacy' ->> 'showActivityStatus')::boolean, true)
                THEN r.last_active_at END,
           CASE WHEN v_self THEN
             (SELECT m.intensity::integer FROM public.mood_reading m
              WHERE m.session_id = participant_presence.session AND m.user_id = participant_presence."user"
              ORDER BY m.recorded_at DESC, m.id DESC LIMIT 1)
           END,
           -- review F7: the name the app calls them by (first name, else what "user".name holds without one); no email,
           -- no last name beside a first name, no deletion instant — only whether the row is a tombstone.
           CASE WHEN u.deleted_at IS NULL THEN coalesce(nullif(u.first_name, ''), u.name) END,
           u.deleted_at IS NOT NULL
    FROM public.participant p
    LEFT JOIN public."user" u ON u.id = p.user_id
    LEFT JOIN public.conversation c ON c.session_id = p.session_id AND c.user_id = p.user_id AND c.kind = 'MAIN'
    LEFT JOIN public.conversation_read_state r ON r.session_id = p.session_id AND r.user_id = p.user_id
    LEFT JOIN public.user_preferences up ON up.user_id = p.user_id
    CROSS JOIN LATERAL (SELECT participant_presence."user" = app.current_user_id() AS v_self) me_
    WHERE p.session_id = participant_presence.session AND p.user_id = participant_presence."user"
      AND EXISTS (SELECT 1 FROM public.participant me
                  WHERE me.session_id = participant_presence.session AND me.user_id = app.current_user_id())
  $$;
COMMENT ON FUNCTION app.participant_presence(uuid, uuid) IS 'A participant''s presence for a caller seated in the same session; behind v_participant. The caller''s own row: MAIN conversation id, read state, last activity, latest mood. A co-participant''s: MAIN conversation id, shared-frame seen instant, last activity only if their privacy preference shows it (work-k5fk.10.7, review F2); for either, the name the app calls them by and whether they are a tombstone (review F7).';
-- mwf_app (app_access): v_participant.
REVOKE EXECUTE ON FUNCTION app.participant_presence(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.participant_presence(uuid, uuid) TO app_access;

-- The parties of the caller's sessions (review F7/F8): each participant's seat, the name the app calls them by,
-- whether they are a tombstone, and their MAIN conversation's id — the address the AI's deliveries and notes to them
-- go to. "user" and conversation are own-row tables for the app (a co-participant's email, last name, deletion
-- instant and conversation row — its next_seq — stay out of reach); this is the one read of a partner's names and
-- conversation id: empathy-store sessionParties/departedCounterpart, contacts.ts, listPeople, the invitee's inviter
-- name, the Stage 4 announcement. Only for sessions the caller is seated in (leavers included, as app.is_member).
CREATE FUNCTION app.session_parties(sessions uuid[])
  RETURNS TABLE (session_id public.uuid7, user_id public.uuid7, kind public.user_kind, display_name text,
                 joined_at public.ts_ms, left_at public.ts_ms, user_name text, is_tombstone boolean,
                 main_conversation_id public.uuid7)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT p.session_id, p.user_id, p.kind, p.display_name, p.joined_at, p.left_at,
           CASE WHEN u.deleted_at IS NULL THEN coalesce(nullif(u.first_name, ''), u.name) END,
           u.deleted_at IS NOT NULL,
           c.id
    FROM public.participant p
    LEFT JOIN public."user" u ON u.id = p.user_id
    LEFT JOIN public.conversation c ON c.session_id = p.session_id AND c.user_id = p.user_id AND c.kind = 'MAIN'
    WHERE p.session_id = ANY (session_parties.sessions)
      AND EXISTS (SELECT 1 FROM public.participant me
                  WHERE me.session_id = p.session_id AND me.user_id = app.current_user_id())
  $$;
COMMENT ON FUNCTION app.session_parties(uuid[]) IS 'Every participant of the given sessions the caller is seated in: seat, kind, display name, join/leave instants, the name the app calls them by (first name, else name), tombstone flag, MAIN conversation id. No email, no deletion instant, no conversation row (work-k5fk.10.7, review F7/F8).';
-- mwf_app (app_access): empathy-store.ts, contacts.ts, invitations.ts listPeople, messages.ts, stage3.ts.
REVOKE EXECUTE ON FUNCTION app.session_parties(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_parties(uuid[]) TO app_access;

-- Has the Stage 4 transition started under the own-request rule (services/stage4-transition.ts)? True once some
-- participant of the session holds their STAGE4_TRANSITION line — the one the request that completed the mutual
-- share writes for its own user. A co-participant's next read then writes theirs. A session that reached
-- needs_shared any other way (a fixture, a migrated session whose lines predate the key) holds none, so no read
-- writes a second line into it. Content-free: one boolean, for a caller seated in the session.
CREATE FUNCTION app.stage4_transition_started(session uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.message m JOIN public.conversation c ON c.id = m.conversation_id
      WHERE c.session_id = stage4_transition_started.session AND c.kind = 'MAIN' AND m.dedupe_key = 'STAGE4_TRANSITION'
    ) AND EXISTS (SELECT 1 FROM public.participant me
                  WHERE me.session_id = stage4_transition_started.session AND me.user_id = app.current_user_id())
  $$;
COMMENT ON FUNCTION app.stage4_transition_started(uuid) IS 'True when a participant of the session holds a STAGE4_TRANSITION line (the own-request rule has begun) and the caller is seated in it. No content (owner decision 2026-11-18, review r1).';
-- mwf_app (app_access): services/stage4-transition.ts ensureOwnStage4TransitionLine.
REVOKE EXECUTE ON FUNCTION app.stage4_transition_started(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stage4_transition_started(uuid) TO app_access;

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
-- mwf_app (app_access): the identity-bound read behind v_empathy_direction_status.
REVOKE EXECUTE ON FUNCTION app.empathy_direction_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empathy_direction_status() TO app_access;

-- The writer of session.status (spec §1.1 transition set), but for a
-- participant's archive (app.session_archive, below). A worker task scoped to
-- this session (app.session_scope; the Stage 4 closure, retention), or, on the
-- app capability, a CURRENT participant (left_at IS NULL; not app.is_member,
-- which counts leavers so they keep reading — work-k5fk.10.12: a leaver must
-- not move the session); anyone else: 'session not found'. → ARCHIVED is the
-- worker's only (retention: RESOLVED / ABANDONED → ARCHIVED, stamping
-- archived_at with no archiver).
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
    v_worker boolean := pg_catalog.pg_has_role(session_user, 'worker_access', 'USAGE')
                        AND coalesce(app.session_scope() = session_set_status.session, false);
    v_job  boolean := session_user = 'mwf_migrator' OR v_worker;
  BEGIN
    -- review F6: the worker only ends a session (retention, the Stage 4 closure, tending): it never starts one.
    IF v_worker AND session_user <> 'mwf_migrator'
       AND session_set_status.status NOT IN ('ABANDONED', 'ARCHIVED', 'RESOLVED') THEN
      RAISE EXCEPTION 'the worker only ends a session (ABANDONED, ARCHIVED, RESOLVED), not %', session_set_status.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT s.status INTO v_from FROM public.session s WHERE s.id = session_set_status.session FOR NO KEY UPDATE;
    IF NOT FOUND OR NOT (v_job OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND EXISTS (
          SELECT 1 FROM public.participant p
          WHERE p.session_id = session_set_status.session AND p.user_id = app.current_user_id() AND p.left_at IS NULL))) THEN
      RAISE EXCEPTION 'session not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_from = session_set_status.status THEN
      RETURN;
    END IF;
    IF session_set_status.status = 'ARCHIVED' AND NOT v_job THEN
      RAISE EXCEPTION 'only a worker archives through session_set_status; a participant uses app.session_archive'
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
-- mwf_app (app_access): invitations.ts accept, topic-frame / invitation confirm (→ INVITED), messages / stage0 (→ ACTIVE),
-- sessions.ts resolve and tending's closure / new process (→ RESOLVED), as a current participant. mwf_worker
-- (worker_access): session-retention (→ ABANDONED → ARCHIVED) and the Stage 4 closure (→ RESOLVED), scoped to the session.
REVOKE EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) TO app_access;
GRANT EXECUTE ON FUNCTION app.session_set_status(uuid, public.session_status) TO worker_access;

-- A participant archives a session (work-k5fk.10.12, owner decision option A,
-- 2026-11-13): the caller must be a CURRENT participant (a human participant
-- whose user is the identity, left_at NULL) — not an invitee who never
-- joined, not one who left — and the session in an archivable state:
-- CREATED, INVITED (a pending invitation withdrawn), RESOLVED or ABANDONED.
-- Records the archiver and the instant; returns the instant. Identity-bound
-- only: a login without the app capability, and the migrator, are refused
-- (insufficient_privilege) — the owner role would otherwise archive for any
-- user; retention archives through session_set_status.
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
    IF session_user = 'mwf_migrator' OR NOT pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') THEN
      RAISE EXCEPTION 'session_archive is identity-bound: only the app archives, for its own user'
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
COMMENT ON FUNCTION app.session_archive(uuid) IS 'Archive a session as a current participant of it (identity-bound; logins without app_access, and the migrator, refused): CREATED, INVITED, RESOLVED or ABANDONED -> ARCHIVED, recording archived_at and archived_by_user_id; returns archived_at. Refusals: MWA00 no identity, MWA01 not found / not a participant, MWA02 participant left, MWA03 not archivable. The only way mwf_app archives (no UPDATE of session.status).';
-- mwf_app (app_access): invitations.ts archiveSession, identity-bound. No other grant (the function itself refuses a login
-- without app_access as well); retention archives through session_set_status.
REVOKE EXECUTE ON FUNCTION app.session_archive(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_archive(uuid) TO app_access;

-- The only writer of empathy_attempt.status (spec §1.2 transition table; P3 §5).
-- Actors (P3 §5: a non-author never moves a row into a disclosing state):
--   the AUTHOR (identity-bound, app capability) or the AI (the reconciler, scoped
--     to the attempt's session): HELD → AWAITING_SHARING | READY,
--     AWAITING_SHARING → REFINING | READY, REFINING → READY | AWAITING_SHARING
--     (the stage2.ts in-request writers), and SUPERSEDED (resubmission);
--   the AI only: READY → REVEALED, and only when the reveal gate holds;
--   the SUBJECT (identity-bound, app capability) only: REVEALED → VALIDATED | REFINING (review F2: never the AI);
--   SUPERSEDED (a resubmission) is the author's only, never the AI's.
-- (mwf_migrator: every arm the AI has, for tooling.)
-- Anyone else: 'attempt not found'. Locks the session row, then the attempt,
-- so a concurrent resubmit of the reverse direction cannot slip between the
-- gate read and the reveal. On → REVEALED: stamps revealed_at once and writes
-- the EMPATHY_STATEMENT into the SUBJECT's MAIN conversation (the author keeps
-- their own copy); re-encrypting content under the session key is the AI's,
-- in the application (keys never reach SQL). → SUPERSEDED inserts round n+1
-- (HELD) with p_content and returns its id; a retried call returns that id.
CREATE FUNCTION app.empathy_set_status(attempt uuid, status public.empathy_status, content text DEFAULT NULL) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    a              public.empathy_attempt%ROWTYPE;
    v_me           uuid := app.current_user_id();
    v_app          boolean := pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE');
    v_job          boolean;
    v_mig          boolean;
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
    -- The AI arm (the reconciler's moves and the reveal): only within the attempt's session (app.session_scope).
    v_job := session_user = 'mwf_migrator'
             OR (pg_catalog.pg_has_role(session_user, 'ai_access', 'USAGE') AND coalesce(app.session_scope() = v_session, false)
                  AND app.scope_actor_is_member());
    -- review F2: the AI arm makes the reconciler's moves and the reveal only; resubmitting (the author's next round)
    -- and reviewing a revealed round (the subject's) are never the AI's.
    v_mig := session_user = 'mwf_migrator';
    PERFORM 1 FROM public.session s WHERE s.id = v_session FOR NO KEY UPDATE;
    SELECT * INTO a FROM public.empathy_attempt e WHERE e.id = empathy_set_status.attempt FOR NO KEY UPDATE;
    SELECT p.user_id, p.left_at INTO v_author_user, v_author_left FROM public.participant p
    WHERE p.session_id = a.session_id AND p.user_id = a.author_user_id;
    SELECT p.user_id, p.left_at INTO v_subject_user, v_subject_left FROM public.participant p
    WHERE p.session_id = a.session_id AND p.user_id = a.subject_user_id;
    -- review r2 N1: the author's / subject's moves are a PRESENT participant's (a leaver moves no round).
    v_is_author  := v_app AND v_me IS NOT NULL AND v_author_user IS NOT NULL AND v_me = v_author_user
                    AND v_author_left IS NULL;
    v_is_subject := v_app AND v_me IS NOT NULL AND v_subject_user IS NOT NULL AND v_me = v_subject_user
                    AND v_subject_left IS NULL;
    IF NOT (v_job OR v_is_author OR v_is_subject) THEN
      RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
    END IF;

    IF empathy_set_status.status = 'SUPERSEDED' THEN
      IF NOT (v_mig OR v_is_author) THEN
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
        RAISE EXCEPTION 'only the author or the AI moves this attempt' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF (a.status, empathy_set_status.status) = ('READY'::public.empathy_status, 'REVEALED'::public.empathy_status) THEN
      IF NOT v_job THEN
        RAISE EXCEPTION 'only the AI reveals' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF (a.status, empathy_set_status.status) IN (
         ('REVEALED'::public.empathy_status, 'VALIDATED'::public.empathy_status), ('REVEALED', 'REFINING')) THEN
      IF NOT (v_mig OR v_is_subject) THEN
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
-- mwf_app (app_access): the request-path writer (work-k5fk.10.2). mwf_ai (ai_access): the reconciler's moves and the reveal
-- (empathy-store jobMoveIfUnchanged, reconciler/state.ts), scoped to the session.
REVOKE EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) TO app_access;
GRANT EXECUTE ON FUNCTION app.empathy_set_status(uuid, public.empathy_status, text) TO ai_access;

-- need_share is written only here, by the need's OWNER (identity-bound, app
-- capability: consent.ts and needs-share.ts share their own needs; the
-- application seals shared_text under the session key — keys never reach SQL),
-- after the owner's GRANTED consent, for a need that is neither deleted nor
-- superseded; session_id and user_id come from the need, never from the caller
-- (spec §1.4, N-1, N-7). Idempotent: a need already shared is left as it is.
-- Until work-k5fk.10.5 the job wrote it for the owner; the owner's request is the principal.
CREATE FUNCTION app.need_share(need uuid, shared_text text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NOT (session_user = 'mwf_migrator'
            OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND EXISTS (
                  SELECT 1 FROM public.need n WHERE n.id = need_share.need AND n.user_id = app.current_user_id()
                    AND app.is_current_member(n.session_id)))) THEN
      -- review r2 N1: the owner, while a present participant of the need's session (a leaver shares nothing).
      RAISE EXCEPTION 'need_share is the need owner''s' USING ERRCODE = 'insufficient_privilege';
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
-- mwf_app (app_access): consent.ts (a GRANTED need consent with its text) and needs-share.ts shareNeeds, as the owner.
REVOKE EXECUTE ON FUNCTION app.need_share(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.need_share(uuid, text) TO app_access;

-- Revoke a shared need: need_share.revoked_at and the consent's REVOKED in
-- one transaction (spec §1.4). The need's owner (identity-bound, app capability).
CREATE FUNCTION app.need_revoke_share(need uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_job boolean := session_user = 'mwf_migrator';
    v_me  uuid := app.current_user_id();
  BEGIN
    IF NOT (v_job OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND v_me IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.need n WHERE n.id = need_revoke_share.need AND n.user_id = v_me
                AND app.is_current_member(n.session_id)))) THEN  -- review r2 N1: a present participant only
      RAISE EXCEPTION 'need not found' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.need_share SET revoked_at = now() WHERE need_id = need_revoke_share.need AND revoked_at IS NULL;
    UPDATE public.consent SET decision = 'REVOKED', revoked_at = now()
    WHERE need_id = need_revoke_share.need AND decision = 'GRANTED';
  END
  $$;
-- mwf_app (app_access): the request-path writer (work-k5fk.10.2).
REVOKE EXECUTE ON FUNCTION app.need_revoke_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.need_revoke_share(uuid) TO app_access;

-- app.anonymize_user_in_session(session, user): steps 1–4 and 7 (participant
-- key) of the account walk for one session (spec §4), for the participant
-- (session, user) (work-k5fk.3). That user (identity-bound, never NULL, app capability).
CREATE FUNCTION app.anonymize_user_in_session(session uuid, "user" uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_job  boolean := session_user = 'mwf_migrator';
    v_me   uuid := app.current_user_id();
    sid    uuid := anonymize_user_in_session.session;
    uid    uuid := anonymize_user_in_session."user";
  BEGIN
    PERFORM 1 FROM public.participant p WHERE p.session_id = sid AND p.user_id = uid;
    IF NOT FOUND OR NOT (v_job OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
                                   AND coalesce(v_me IS NOT NULL AND uid = v_me, false))) THEN
      RAISE EXCEPTION 'participant not found' USING ERRCODE = 'P0002';
    END IF;
    -- 1. a live session → ABANDONED (closes the invite-accept path; lets T-cardinality-2 accept the leave). The walk's
    -- own arm (review F8): not through session_set_status, whose participant arm refuses a user who already left
    -- (left_at set) — such a user's account deletion must still end the session. Same lock as session_set_status.
    IF (SELECT s.status FROM public.session s WHERE s.id = sid FOR NO KEY UPDATE) IN ('CREATED', 'INVITED', 'ACTIVE') THEN
      UPDATE public.session s SET status = 'ABANDONED' WHERE s.id = sid;
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
-- mwf_app (app_access): session-deletion.ts deleteSessionForUser, the leaver's own request.
REVOKE EXECUTE ON FUNCTION app.anonymize_user_in_session(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.anonymize_user_in_session(uuid, uuid) TO app_access;

-- app.anonymize_user_account(user): the complete walk (spec §4, P1-13).
-- The user themself (identity-bound, never NULL, app capability).
CREATE FUNCTION app.anonymize_user_account("user" uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_job boolean := session_user = 'mwf_migrator';
    v_me  uuid := app.current_user_id();
    v_uid uuid := anonymize_user_account."user";
    r     record;
  BEGIN
    IF NOT (v_job OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
                      AND coalesce(v_me IS NOT NULL AND v_uid = v_me, false)))
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
-- mwf_app (app_access): account-deletion.ts deleteAccountWithNotifications, the user's own request.
REVOKE EXECUTE ON FUNCTION app.anonymize_user_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.anonymize_user_account(uuid) TO app_access;

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
-- written by its owner only: no runtime role holds UPDATE (next_seq) or EXECUTE
-- on this — the owner is the NOLOGIN mwf_definer (work-k5fk.10.4), so no login
-- can take a number with no row (a hole). Its one caller is t_message_seq (T5),
-- also mwf_definer's. A missing conversation returns NULL; t_message_seq refuses
-- that row.
CREATE FUNCTION app.next_message_seq(conversation uuid) RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    UPDATE public.conversation SET next_seq = next_seq + 1 WHERE id = next_message_seq.conversation
    RETURNING next_seq - 1
  $$;
COMMENT ON FUNCTION app.next_message_seq(uuid) IS 'The next message seq of a conversation (work-k5fk.4): advances conversation.next_seq under the row''s lock and returns the number taken, or NULL for no such conversation. Called by t_message_seq; executable by its owner, the NOLOGIN mwf_definer, alone (work-k5fk.10.4): no runtime role may EXECUTE it.';
-- No grant: t_message_seq (owned by mwf_definer, as this is) is its only caller.
REVOKE EXECUTE ON FUNCTION app.next_message_seq(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The request path's cross-partner writes (work-k5fk.10.5; design note §6 Q13,
-- §7 row 9b). Each was a write of mwf_job's, which saw everyone's rows; each is
-- now a definer that checks who is asking (the arms in the T4 header) and
-- writes exactly one kind of row, executable only by the capability that calls
-- it. Content arrives sealed: the application encrypts (keys never reach SQL).
-- Refusals: P0002 for a row the caller may not act on (as not found, so its
-- existence is not revealed), check_violation for a move the row forbids,
-- insufficient_privilege for a caller without the arm.
-- ---------------------------------------------------------------------------

-- A delivered item authored by one participant, written into ANOTHER
-- participant's conversation of the same session (role USER: delivered items
-- are the author's; spec T-message-immutable): message-store deliverMessage —
-- EMPATHY_STATEMENT / VALIDATION_FEEDBACK / … from a request (empathy-messages,
-- stage2.ts), SHARED_CONTEXT from the reconciler's delivery of an accepted
-- share (sharing.ts deliverAcceptedShare, mwf_ai). The app arm: the author is
-- the identity and a current participant; the AI arm: the conversation's
-- session is the scope. Never a CHAT line, never into the author's own
-- conversation. Returns the row's key and instant.
CREATE FUNCTION app.deliver_message(conversation uuid, from_user uuid, kind public.message_kind, content text,
                                    source_attempt uuid DEFAULT NULL, instant timestamptz DEFAULT NULL)
  RETURNS TABLE (seq integer, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_session uuid;
    v_to      uuid;
    v_mig     boolean := session_user = 'mwf_migrator';
    v_ai      boolean;
    v_app     boolean;
    v_at      timestamptz := coalesce(deliver_message.instant, CURRENT_TIMESTAMP);
  BEGIN
    SELECT c.session_id, c.user_id INTO v_session, v_to FROM public.conversation c WHERE c.id = deliver_message.conversation;
    v_ai := pg_catalog.pg_has_role(session_user, 'ai_access', 'USAGE') AND coalesce(app.session_scope() = v_session, false)
                  AND app.scope_actor_is_member();
    v_app := pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
             AND coalesce(app.current_user_id() = deliver_message.from_user, false)
             AND EXISTS (SELECT 1 FROM public.participant p
                         WHERE p.session_id = v_session AND p.user_id = deliver_message.from_user AND p.left_at IS NULL);
    IF v_session IS NULL OR NOT (v_mig OR v_ai OR v_app) THEN
      RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'P0002';
    END IF;
    IF deliver_message.kind = 'CHAT' THEN
      RAISE EXCEPTION 'a delivered item is never a CHAT line' USING ERRCODE = 'check_violation';
    END IF;
    IF v_to = deliver_message.from_user THEN
      RAISE EXCEPTION 'a delivery goes into another participant''s conversation' USING ERRCODE = 'check_violation';
    END IF;
    -- review F1: the instant orders a delivery after the line it follows; it is never backdated or in the future.
    IF v_at < CURRENT_TIMESTAMP - interval '10 minutes' OR v_at > CURRENT_TIMESTAMP + interval '5 seconds' THEN
      RAISE EXCEPTION 'a delivery is stamped now (within ten minutes back, five seconds ahead)' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_mig AND v_app THEN
      -- review F1: the request path delivers the subject's feedback on a revealed round into its author's conversation
      -- (stage2.ts, the review), nothing else.
      IF deliver_message.kind <> 'VALIDATION_FEEDBACK' OR NOT EXISTS (
           SELECT 1 FROM public.empathy_attempt e
           WHERE e.id = deliver_message.source_attempt AND e.session_id = v_session
             AND e.subject_user_id = deliver_message.from_user AND e.author_user_id = v_to
             AND e.revealed_at IS NOT NULL AND e.status IN ('REVEALED', 'REFINING')) THEN
        RAISE EXCEPTION 'the app delivers only the subject''s VALIDATION_FEEDBACK on a revealed round into its author''s conversation'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NOT v_mig THEN
      -- review F3: the AI delivers the shared context of an ACCEPTED, undelivered offer whose subject is the sender into
      -- the conversation of the author of the offer's round (reconciler/sharing.ts deliverAcceptedShare), nothing else.
      IF deliver_message.kind <> 'SHARED_CONTEXT' OR NOT EXISTS (
           SELECT 1 FROM public.context_share_offer o JOIN public.empathy_attempt e ON e.id = o.attempt_id
           WHERE o.session_id = v_session AND o.subject_user_id = deliver_message.from_user
             AND o.status = 'ACCEPTED' AND o.delivery_status = 'PENDING' AND e.author_user_id = v_to) THEN
        RAISE EXCEPTION 'the AI delivers only the SHARED_CONTEXT of the sender''s ACCEPTED, undelivered share offer'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN QUERY
      INSERT INTO public.message AS m (conversation_id, session_id, sender_user_id, role, kind, content, source_attempt_id, created_at)
      VALUES (deliver_message.conversation, v_session, deliver_message.from_user, 'USER', deliver_message.kind,
              deliver_message.content, deliver_message.source_attempt, v_at)
      RETURNING m.seq::integer, m.created_at::timestamptz;
  END
  $$;
COMMENT ON FUNCTION app.deliver_message(uuid, uuid, public.message_kind, text, uuid, timestamptz) IS 'Deliver a participant''s item (role USER, content sealed by the application) into another participant''s conversation of the same session, stamped now (bounded): the subject''s VALIDATION_FEEDBACK on a revealed round into its author''s conversation (identity-bound, app_access), or the SHARED_CONTEXT of the sender''s ACCEPTED, undelivered offer (the AI within app.session_scope). Returns (seq, created_at). work-k5fk.10.5.';
-- mwf_app (app_access): message-store deliverMessage on the request path. mwf_ai (ai_access): sharing.ts deliverAcceptedShare.
REVOKE EXECUTE ON FUNCTION app.deliver_message(uuid, uuid, public.message_kind, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deliver_message(uuid, uuid, public.message_kind, text, uuid, timestamptz) TO app_access;
GRANT EXECUTE ON FUNCTION app.deliver_message(uuid, uuid, public.message_kind, text, uuid, timestamptz) TO ai_access;

-- The delivery stamp of an attempt (empathy-store markAttemptDelivery): the
-- SUBJECT saw (SEEN) or sent feedback on (DELIVERED) the author's round
-- (stage2.ts, app arm), or the reconciler delivered it (reconciler/state.ts,
-- AI arm). The first instant stands.
CREATE FUNCTION app.empathy_mark_delivery(attempt uuid, delivery public.delivery_status, instant timestamptz DEFAULT NULL)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_session  uuid;
    v_subject  uuid;
    v_revealed timestamptz;
    v_at       timestamptz := coalesce(empathy_mark_delivery.instant, CURRENT_TIMESTAMP);
  BEGIN
    SELECT e.session_id, e.subject_user_id, e.revealed_at INTO v_session, v_subject, v_revealed
    FROM public.empathy_attempt e WHERE e.id = empathy_mark_delivery.attempt FOR NO KEY UPDATE;
    IF v_session IS NULL OR NOT (
         session_user = 'mwf_migrator'
         OR (pg_catalog.pg_has_role(session_user, 'ai_access', 'USAGE') AND coalesce(app.session_scope() = v_session, false)
                  AND app.scope_actor_is_member())
         OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND coalesce(app.current_user_id() = v_subject, false)
             AND app.is_current_member(v_session))) THEN  -- review r2 N1: a present subject only
      RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002';
    END IF;
    -- review F10: only a revealed round is delivered or seen, and the stamp moves forward only (PENDING → DELIVERED →
    -- SEEN; a later DELIVERED leaves SEEN), at an instant clamped to the last ten minutes, never before the reveal.
    IF v_revealed IS NULL THEN
      RAISE EXCEPTION 'a round that was never revealed is neither delivered nor seen' USING ERRCODE = 'check_violation';
    END IF;
    v_at := least(greatest(v_at, v_revealed, CURRENT_TIMESTAMP - interval '10 minutes'), CURRENT_TIMESTAMP);
    IF empathy_mark_delivery.delivery = 'DELIVERED' THEN
      UPDATE public.empathy_attempt SET delivery_status = 'DELIVERED', delivered_at = coalesce(delivered_at, v_at)
      WHERE id = empathy_mark_delivery.attempt AND delivery_status = 'PENDING';
    ELSIF empathy_mark_delivery.delivery = 'SEEN' THEN
      -- work-k5fk.9 (D4): seen implies delivered — a round seen straight from PENDING is delivered at the same instant
      UPDATE public.empathy_attempt SET delivery_status = 'SEEN', seen_at = coalesce(seen_at, v_at),
                                        delivered_at = coalesce(delivered_at, v_at)
      WHERE id = empathy_mark_delivery.attempt AND delivery_status IN ('PENDING', 'DELIVERED');
    ELSE
      RAISE EXCEPTION 'delivery % is not a stamp', empathy_mark_delivery.delivery USING ERRCODE = 'check_violation';
    END IF;
  END
  $$;
COMMENT ON FUNCTION app.empathy_mark_delivery(uuid, public.delivery_status, timestamptz) IS 'Stamp a revealed attempt DELIVERED (delivered_at) or SEEN (seen_at), forward only (SEEN is never downgraded), first instant standing, the instant clamped to the last ten minutes and never before revealed_at. Its subject (identity-bound, app_access) or the AI within app.session_scope. work-k5fk.10.5.';
-- mwf_app (app_access): stage2.ts, the subject's review. mwf_ai (ai_access): reconciler/state.ts, the reveal's delivery.
REVOKE EXECUTE ON FUNCTION app.empathy_mark_delivery(uuid, public.delivery_status, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empathy_mark_delivery(uuid, public.delivery_status, timestamptz) TO app_access;
GRANT EXECUTE ON FUNCTION app.empathy_mark_delivery(uuid, public.delivery_status, timestamptz) TO ai_access;

-- A system milestone (one the milestone table marks NOT self_assertable:
-- invitation_sent, empathy_*, needs_validated, needs_shared, paused, closed …)
-- for a participant of the session, reached on a request (milestone-writer
-- reachMilestone). The caller is a current participant of the session (app
-- arm); the participant reached may be the partner — that is the two-party
-- write. A self-assertable key is the participant's own INSERT on mwf_app
-- (refused here). Returns true when this call recorded it (the first instant stands).
CREATE FUNCTION app.reach_milestone(session uuid, "user" uuid, key text, instant timestamptz DEFAULT NULL)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_self boolean;
    n      integer;
  BEGIN
    IF NOT (session_user = 'mwf_migrator'
            OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND EXISTS (
                  SELECT 1 FROM public.participant p
                  WHERE p.session_id = reach_milestone.session AND p.user_id = app.current_user_id() AND p.left_at IS NULL)))
       OR NOT EXISTS (SELECT 1 FROM public.participant p
                      WHERE p.session_id = reach_milestone.session AND p.user_id = reach_milestone."user") THEN
      RAISE EXCEPTION 'participant not found' USING ERRCODE = 'P0002';
    END IF;
    SELECT m.self_assertable INTO v_self FROM public.milestone m WHERE m.key = reach_milestone.key;
    IF v_self IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'milestone % is not a system milestone (unknown, or the participant''s own)', reach_milestone.key
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO public.participant_milestone (session_id, user_id, milestone_key, reached_at)
    VALUES (reach_milestone.session, reach_milestone."user", reach_milestone.key, coalesce(reach_milestone.instant, CURRENT_TIMESTAMP))
    ON CONFLICT (session_id, user_id, milestone_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
  END
  $$;
COMMENT ON FUNCTION app.reach_milestone(uuid, uuid, text, timestamptz) IS 'Reach a system (not self-assertable) milestone for a participant of a session the caller is a current participant of (identity-bound, app_access). True when recorded now; the first instant stands. work-k5fk.10.5.';
-- mwf_app (app_access): milestone-writer reachMilestone (every system key; the self-assertable ones are its own INSERT).
REVOKE EXECUTE ON FUNCTION app.reach_milestone(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reach_milestone(uuid, uuid, text, timestamptz) TO app_access;

-- Resume a paused session: every participant's `paused` milestone goes
-- (sessions.ts resumeSession; un-reaching is a DELETE, spec §1.1). A current
-- participant of the session. Returns the rows removed.
CREATE FUNCTION app.session_resume(session uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    n integer;
  BEGIN
    IF NOT (session_user = 'mwf_migrator'
            OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND EXISTS (
                  SELECT 1 FROM public.participant p
                  WHERE p.session_id = session_resume.session AND p.user_id = app.current_user_id() AND p.left_at IS NULL))) THEN
      RAISE EXCEPTION 'session not found' USING ERRCODE = 'P0002';
    END IF;
    DELETE FROM public.participant_milestone pm WHERE pm.session_id = session_resume.session AND pm.milestone_key = 'paused';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
  $$;
COMMENT ON FUNCTION app.session_resume(uuid) IS 'Un-reach `paused` for every participant of a session; a current participant of it (identity-bound, app_access). Returns the rows removed. work-k5fk.10.5.';
-- mwf_app (app_access): sessions.ts resumeSession.
REVOKE EXECUTE ON FUNCTION app.session_resume(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_resume(uuid) TO app_access;

-- Withdraw the caller's shared Stage 4 choices so they can revise
-- (stage4-store unshareChoices): their own `choices_shared` goes. Returns the
-- rows removed.
CREATE FUNCTION app.choices_unshare(session uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me uuid := app.current_user_id();
    n    integer;
  BEGIN
    IF v_me IS NULL OR NOT pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') THEN
      RAISE EXCEPTION 'choices_unshare is identity-bound' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.is_current_member(choices_unshare.session) THEN
      RETURN 0;  -- review r2 N1: a leaver changes nothing in the session
    END IF;
    DELETE FROM public.participant_milestone pm
    WHERE pm.session_id = choices_unshare.session AND pm.user_id = v_me AND pm.milestone_key = 'choices_shared';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
  $$;
COMMENT ON FUNCTION app.choices_unshare(uuid) IS 'Un-reach the caller''s own choices_shared in a session (identity-bound, app_access). Returns the rows removed. work-k5fk.10.5.';
-- mwf_app (app_access): stage4-store unshareChoices.
REVOKE EXECUTE ON FUNCTION app.choices_unshare(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.choices_unshare(uuid) TO app_access;

-- The Stage 2 sharing window closes (stage2.ts triggerStage3Transition): the
-- open (PENDING / OFFERED) share offers to the named subjects in the session
-- expire. A current participant of the session. Returns the rows moved.
CREATE FUNCTION app.share_offers_expire(session uuid, subjects uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    n integer;
  BEGIN
    IF NOT (session_user = 'mwf_migrator'
            OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND EXISTS (
                  SELECT 1 FROM public.participant p
                  WHERE p.session_id = share_offers_expire.session AND p.user_id = app.current_user_id() AND p.left_at IS NULL))) THEN
      RAISE EXCEPTION 'session not found' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.context_share_offer o SET status = 'EXPIRED'
    WHERE o.session_id = share_offers_expire.session AND o.subject_user_id = ANY (share_offers_expire.subjects)
      AND o.status IN ('PENDING', 'OFFERED');
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
  $$;
COMMENT ON FUNCTION app.share_offers_expire(uuid, uuid[]) IS 'Expire the open (PENDING / OFFERED) share offers to the given subjects of a session; a current participant of it (identity-bound, app_access). work-k5fk.10.5.';
-- mwf_app (app_access): stage2.ts triggerStage3Transition.
REVOKE EXECUTE ON FUNCTION app.share_offers_expire(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_offers_expire(uuid, uuid[]) TO app_access;

-- The caller has been told about their shared context's delivery (seen =
-- false: delivery_notified_at) or its being seen (seen = true:
-- seen_notified_at) — notifications.ts getPendingActionsHandler. Only offers
-- whose subject is the caller are stamped. Returns the rows stamped.
CREATE FUNCTION app.share_offers_mark_notified(offers uuid[], seen boolean) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me uuid := app.current_user_id();
    n    integer;
  BEGIN
    IF v_me IS NULL OR NOT pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') THEN
      RAISE EXCEPTION 'share_offers_mark_notified is identity-bound' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF share_offers_mark_notified.seen THEN
      UPDATE public.context_share_offer o SET seen_notified_at = now()
      WHERE o.id = ANY (share_offers_mark_notified.offers) AND o.subject_user_id = v_me
        AND app.is_current_member(o.session_id);  -- review r2 N1
    ELSE
      UPDATE public.context_share_offer o SET delivery_notified_at = now()
      WHERE o.id = ANY (share_offers_mark_notified.offers) AND o.subject_user_id = v_me
        AND app.is_current_member(o.session_id);
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END
  $$;
COMMENT ON FUNCTION app.share_offers_mark_notified(uuid[], boolean) IS 'Stamp seen_notified_at (seen) or delivery_notified_at (not seen) on the caller''s own share offers among the given ones (identity-bound, app_access). work-k5fk.10.5.';
-- mwf_app (app_access): notifications.ts getPendingActionsHandler.
REVOKE EXECUTE ON FUNCTION app.share_offers_mark_notified(uuid[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_offers_mark_notified(uuid[], boolean) TO app_access;

-- An invitation was declined (invitations.ts declineInvitation): its session,
-- still CREATED or INVITED, ends (→ ABANDONED). The decliner is no participant,
-- so the arm is the declined invitation itself: identity-bound, not the
-- inviter, and the invitation already DECLINED (the app's own UPDATE, in the
-- same request). A session that moved on is left as it is. Locks the session
-- row FOR NO KEY UPDATE, as session_set_status does.
CREATE FUNCTION app.session_abandon_declined(invitation uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me      uuid := app.current_user_id();
    v_session uuid;
    v_inviter uuid;
    v_status  public.invitation_status;
    v_from    public.session_status;
  BEGIN
    SELECT i.session_id, i.invited_by_user_id, i.status INTO v_session, v_inviter, v_status
    FROM public.invitation i WHERE i.id = session_abandon_declined.invitation;
    IF v_session IS NULL OR NOT (session_user = 'mwf_migrator'
         OR (pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE') AND v_me IS NOT NULL AND v_me <> v_inviter)) THEN
      RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_status <> 'DECLINED' THEN
      RAISE EXCEPTION 'invitation is % , not DECLINED', v_status USING ERRCODE = 'check_violation';
    END IF;
    SELECT s.status INTO v_from FROM public.session s WHERE s.id = v_session FOR NO KEY UPDATE;
    IF v_from IN ('CREATED', 'INVITED') THEN
      UPDATE public.session s SET status = 'ABANDONED' WHERE s.id = v_session;
    END IF;
  END
  $$;
COMMENT ON FUNCTION app.session_abandon_declined(uuid) IS 'A DECLINED invitation ends its still CREATED / INVITED session (→ ABANDONED). The decliner (identity-bound, app_access, not the inviter). work-k5fk.10.5.';
-- mwf_app (app_access): invitations.ts declineInvitation.
REVOKE EXECUTE ON FUNCTION app.session_abandon_declined(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_abandon_declined(uuid) TO app_access;

-- The caller's own sign-in subject for a provider (account-deletion.ts: the
-- Clerk user to delete at Clerk, read before the walk deletes the identity).
-- mwf_app holds nothing on user_identity (work-k5fk.1); this reads one row,
-- the caller's.
CREATE FUNCTION app.identity_subject(provider public.identity_provider) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT i.subject FROM public.user_identity i
    WHERE i.user_id = app.current_user_id() AND i.provider = identity_subject.provider
      AND pg_catalog.pg_has_role(session_user, 'app_access', 'USAGE')
  $$;
COMMENT ON FUNCTION app.identity_subject(public.identity_provider) IS 'The caller''s own subject for a sign-in provider, or NULL (identity-bound, app_access). work-k5fk.10.5.';
-- mwf_app (app_access): account-deletion.ts deleteAccountWithNotifications.
REVOKE EXECUTE ON FUNCTION app.identity_subject(public.identity_provider) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_subject(public.identity_provider) TO app_access;

-- Hand the definer functions to the NOLOGIN mwf_definer (work-k5fk.10.4; TS-1 order, measured there with a
-- non-superuser migrator): CREATE on the schema for the hand-over only. Their
-- EXECUTE grants were issued above, next to each function, by the migrator as
-- owner; ALTER OWNER rewrites each ACL to the new owner (grantee and grantor),
-- which is exactly what issuing them AS the owner after the hand-over produced
-- before work-k5fk.7 (app-grants.target.test.ts privilege matrix; pg_proc.proacl
-- byte-identical).
GRANT CREATE ON SCHEMA app TO mwf_definer;
ALTER FUNCTION app.is_member(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.is_current_member(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.partner_user_id(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.session_unseated(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.shares_session_with(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.owns_persona(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.scope_actor_is_member() OWNER TO mwf_definer;
ALTER FUNCTION app.owns_reflection(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.invitation_peek(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.invitation_claim(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.invitation_answer(uuid, public.invitation_status, timestamptz, text) OWNER TO mwf_definer;
ALTER FUNCTION app.session_invitee_access(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.shares_delivered_to_me(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.validated_at(uuid[]) OWNER TO mwf_definer;
ALTER FUNCTION app.result_facts(uuid[]) OWNER TO mwf_definer;
ALTER FUNCTION app.attempt_meta(uuid[]) OWNER TO mwf_definer;
ALTER FUNCTION app.co_participant_presence(uuid, uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.actor_name_for(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.invitation_repoint_drafts(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.participant_presence(uuid, uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.session_parties(uuid[]) OWNER TO mwf_definer;
ALTER FUNCTION app.stage4_transition_started(uuid) OWNER TO mwf_definer;
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
ALTER FUNCTION app.deliver_message(uuid, uuid, public.message_kind, text, uuid, timestamptz) OWNER TO mwf_definer;
ALTER FUNCTION app.empathy_mark_delivery(uuid, public.delivery_status, timestamptz) OWNER TO mwf_definer;
ALTER FUNCTION app.reach_milestone(uuid, uuid, text, timestamptz) OWNER TO mwf_definer;
ALTER FUNCTION app.session_resume(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.choices_unshare(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.share_offers_expire(uuid, uuid[]) OWNER TO mwf_definer;
ALTER FUNCTION app.share_offers_mark_notified(uuid[], boolean) OWNER TO mwf_definer;
ALTER FUNCTION app.session_abandon_declined(uuid) OWNER TO mwf_definer;
ALTER FUNCTION app.identity_subject(public.identity_provider) OWNER TO mwf_definer;
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
-- changes, except by the migrator (W13's re-encryption names its own writer when it lands; mwf_job, which held this
-- arm, is retired — work-k5fk.10.5).
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
       AND session_user <> 'mwf_migrator' THEN
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
-- named mwf_app, so a second login mapped onto app_access is narrowed too. Exempt: any current_user
-- that holds the database owner's privileges (pg_has_role … pg_database_owner — true for the owner
-- and for every superuser, false for every runtime login, which step 20 forbids to own anything).
-- That is a current_user fact, as the membership test is: a cascaded delete runs as the owner of
-- message whatever the session login (on a superuser-owned database the owner is a superuser, who
-- is also "a member" of app_access), and a superuser session writing directly (fixtures, tooling) is
-- exempt too. Both are role-catalog functions, so the golden traces see no new relation. Keyed on current_user, not session_user: a SECURITY DEFINER function the app
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
-- app.current_user_id() is read only after the early return, so other roles (ai_access, worker_access)
-- need no EXECUTE on it to write.
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
       OR pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'USAGE') THEN
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
       OR pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'USAGE') THEN
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

-- T-session-scope (work-k5fk.10.5; design note §6 "Session variables", Q20): the AI (ai_access) — and a worker
-- task on the per-session tables of the Stage 4 closure (worker_access) — writes a row only in the one session its
-- transaction names in app.session_scope (set by the ai / worker clients, lib/prisma-identity.ts). Unset is NULL, so
-- a write with no scope is refused: the scope is required, not a filter that an absent value turns off. On message
-- the AI writes only its own AI / SYSTEM lines (a participant's delivered line is app.deliver_message's). Arguments:
-- TG_ARGV[0] the row's session column, TG_ARGV[1] the capability it binds, TG_ARGV[2] 'sessionless' when a row with
-- no session is allowed (brain_activity: an inner-work call's telemetry). Exempt, as t_message_app_* are: any
-- current_user that is not a member of that capability (mwf_app, every definer body — mwf_definer is a member of
-- nothing — and every cascade, which runs as the table's owner) and any that holds the database owner's privileges
-- (the owner, superusers). UPDATE checks the old and the new row: a row may not be moved into, or out of, scope.
-- Role-catalog functions and a setting only, so the golden traces see no new relation.
CREATE FUNCTION app.t_session_scope() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_col   text := TG_ARGV[0];
    v_new   jsonb;
    v_old   jsonb;
    v_scope uuid;
  BEGIN
    IF NOT pg_catalog.pg_has_role(current_user, TG_ARGV[1], 'USAGE')
       OR pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'USAGE') THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
    IF NOT (coalesce(TG_ARGV[2], '') = 'sessionless'
            AND (v_new IS NULL OR v_new ->> v_col IS NULL) AND (v_old IS NULL OR v_old ->> v_col IS NULL)) THEN
      v_scope := app.session_scope();
      IF v_scope IS NULL
         OR (v_new IS NOT NULL AND (v_new ->> v_col)::uuid IS DISTINCT FROM v_scope)
         OR (v_old IS NOT NULL AND (v_old ->> v_col)::uuid IS DISTINCT FROM v_scope) THEN
        RAISE EXCEPTION '% writes % only within its app.session_scope (%)', current_user, TG_TABLE_NAME,
          coalesce(v_scope::text, 'unset')
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'message' AND TG_ARGV[1] = 'ai_access' AND v_new IS NOT NULL
       AND (v_new ->> 'role') NOT IN ('AI', 'SYSTEM') THEN
      RAISE EXCEPTION 'the AI writes only AI / SYSTEM lines, not %', v_new ->> 'role' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_session_scope() FROM PUBLIC;
COMMENT ON FUNCTION app.t_session_scope() IS 'The AI (and a worker task on the Stage 4 closure tables) writes only rows of the session app.session_scope names; required, so an unset scope refuses the write. work-k5fk.10.5.';
-- mwf_ai's writes (tables.sql "-- mwf_ai:" grants). session and empathy_attempt: the one-column UPDATE the row locks need.
CREATE TRIGGER t_session_scope BEFORE INSERT ON public.message
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'ai_access');
CREATE TRIGGER t_session_scope BEFORE INSERT OR UPDATE ON public.ai_memory
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'ai_access');
CREATE TRIGGER t_session_scope BEFORE INSERT OR UPDATE ON public.reconciler_result
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'ai_access');
CREATE TRIGGER t_session_scope BEFORE INSERT ON public.reconciler_guidance
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'ai_access');
CREATE TRIGGER t_session_scope BEFORE INSERT OR UPDATE ON public.context_share_offer
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'ai_access');
CREATE TRIGGER t_session_scope BEFORE INSERT OR UPDATE ON public.brain_activity
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'ai_access', 'sessionless');
CREATE TRIGGER t_session_scope BEFORE UPDATE ON public.session
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('id', 'ai_access');
CREATE TRIGGER t_session_scope BEFORE UPDATE ON public.empathy_attempt
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'ai_access');
-- mwf_worker's per-session writes: the Stage 4 closure (stage4-store insertAgreementsTx / insertClosureTx). Its
-- cross-session writes (retention, due follow-ups and reminders, push tokens) are not session rows of one task.
CREATE TRIGGER t_session_scope_worker BEFORE INSERT OR UPDATE ON public.agreement
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'worker_access');
CREATE TRIGGER t_session_scope_worker BEFORE INSERT ON public.agreement_party
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'worker_access');
CREATE TRIGGER t_session_scope_worker BEFORE INSERT ON public.session_closure
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'worker_access');
CREATE TRIGGER t_session_scope_worker BEFORE INSERT ON public.proposal_revision
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'worker_access');
CREATE TRIGGER t_session_scope_worker BEFORE UPDATE ON public.proposal
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'worker_access');
-- review F6: a follow-up the worker schedules is of one session (the closure, a check-in's next round, the coordination
-- cycle's next round); its UPDATEs stay cross-session (open-due, step 20's exemptions).
CREATE TRIGGER t_session_scope_worker BEFORE INSERT ON public.follow_up
  FOR EACH ROW EXECUTE FUNCTION app.t_session_scope('session_id', 'worker_access');

-- T-session-purge (review F6): the worker's DELETE of a session (session-retention's purge, a cascade of every
-- session-scoped row) removes only an ARCHIVED session. Exempt, as t_session_scope: any current_user that is not a
-- member of worker_access, and the database owner / superusers.
CREATE FUNCTION app.t_session_purge() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF pg_catalog.pg_has_role(current_user, 'worker_access', 'USAGE')
       AND NOT pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'USAGE')
       AND OLD.status <> 'ARCHIVED' THEN
      RAISE EXCEPTION 'the worker purges only ARCHIVED sessions, not %', OLD.status USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_session_purge() FROM PUBLIC;
COMMENT ON FUNCTION app.t_session_purge() IS 'The worker deletes only ARCHIVED sessions (session-retention''s purge). work-k5fk.10.5 review F6.';
CREATE TRIGGER t_session_purge BEFORE DELETE ON public.session
  FOR EACH ROW EXECUTE FUNCTION app.t_session_purge();

-- T-proposal-app-moves (work-k5fk.10.9, owner decisions 2026-11-18, review F5): what a plain app UPDATE of a proposal
-- may not do, since a row policy cannot compare OLD with NEW.
--  * Its creator is fixed. The one creator move is the edit that turns a proposal into the editor's own individual
--    commitment (Stage 4 capture): created_by_user_id becomes the acting user AND kind becomes INDIVIDUAL_COMMITMENT
--    in the same UPDATE. Any other change — a re-assignment from the model's output, to the partner or to oneself —
--    is refused.
--  * A move into INDIVIDUAL_COMMITMENT names the acting user as creator (the same rule from the kind's side).
--  * CONVERTED_TO_AGREEMENT is the agreement path's (the worker's createAgreementsAsJob, with its agreement rows),
--    never an app edit's.
--  * A removal is attributed to the acting user: removed_by_user_id moves only with the status — into REMOVED it
--    names the acting user, out of REMOVED (a restore) it returns to NULL — and is otherwise immutable (review r2 N4).
-- Exempt, as t_session_scope: any current_user that is not a member of app_access (the worker's conversion, every
-- definer body) and any that holds the database owner's privileges.
CREATE FUNCTION app.t_proposal_app_moves() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_me uuid;
  BEGIN
    IF NOT pg_catalog.pg_has_role(current_user, 'app_access', 'USAGE')
       OR pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'USAGE') THEN
      RETURN NEW;
    END IF;
    v_me := app.current_user_id();
    IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       AND NOT (NEW.created_by_user_id = v_me
                AND NEW.kind = 'INDIVIDUAL_COMMITMENT' AND OLD.kind IS DISTINCT FROM 'INDIVIDUAL_COMMITMENT') THEN
      RAISE EXCEPTION 'a proposal''s creator changes only when it becomes the editor''s own commitment'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- owner decision 2026-11-18 (after review r1): a move into INDIVIDUAL_COMMITMENT makes the actor its creator in the
    -- same UPDATE; a kind-only change never hands someone else a commitment.
    IF NEW.kind = 'INDIVIDUAL_COMMITMENT' AND OLD.kind IS DISTINCT FROM 'INDIVIDUAL_COMMITMENT'
       AND NEW.created_by_user_id IS DISTINCT FROM v_me THEN
      RAISE EXCEPTION 'a proposal becomes an individual commitment only as the editor''s own'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'CONVERTED_TO_AGREEMENT' AND OLD.status IS DISTINCT FROM 'CONVERTED_TO_AGREEMENT' THEN
      RAISE EXCEPTION 'a proposal becomes an agreement only through the agreement path'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- review r2 N4: removed_by_user_id moves only with the status — into REMOVED (to the acting user) or out of it
    -- (back to NULL, a restore); otherwise it is immutable.
    IF (NEW.status = 'REMOVED' AND OLD.status IS DISTINCT FROM 'REMOVED'
        AND NEW.removed_by_user_id IS DISTINCT FROM v_me)
       OR (OLD.status = 'REMOVED' AND NEW.status IS DISTINCT FROM 'REMOVED' AND NEW.removed_by_user_id IS NOT NULL)
       OR (NEW.status IS NOT DISTINCT FROM OLD.status
           AND NEW.removed_by_user_id IS DISTINCT FROM OLD.removed_by_user_id) THEN
      RAISE EXCEPTION 'a proposal''s removal is attributed to the acting user'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_proposal_app_moves() FROM PUBLIC;
COMMENT ON FUNCTION app.t_proposal_app_moves() IS 'For mwf_app: proposal.created_by_user_id changes only to itself, in the UPDATE that makes the proposal its INDIVIDUAL_COMMITMENT, and no proposal becomes an INDIVIDUAL_COMMITMENT of anyone else; status never becomes CONVERTED_TO_AGREEMENT; a removal names the acting user. work-k5fk.10.9, review F5.';
CREATE TRIGGER t_proposal_app_moves BEFORE UPDATE ON public.proposal
  FOR EACH ROW EXECUTE FUNCTION app.t_proposal_app_moves();

-- T-session-link-moves (review r2 N2): on an own-row table with an optional session link (TG_ARGV[0] names the
-- column), mwf_app may keep or clear the link whatever its membership, and may change it only to a session it is a
-- present participant of. Exempt as t_proposal_app_moves: a current_user outside app_access, the database owner.
CREATE FUNCTION app.t_session_link_moves() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_new uuid := (pg_catalog.to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
    v_old uuid := (pg_catalog.to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
  BEGIN
    IF NOT pg_catalog.pg_has_role(current_user, 'app_access', 'USAGE')
       OR pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'USAGE') THEN
      RETURN NEW;
    END IF;
    IF v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old AND NOT app.is_current_member(v_new) THEN
      RAISE EXCEPTION 'a row links only to a session its owner is a present participant of'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_session_link_moves() FROM PUBLIC;
COMMENT ON FUNCTION app.t_session_link_moves() IS 'For mwf_app: an optional session link (TG_ARGV[0]) is kept or cleared freely and changed only to a session the caller is a present participant of. Review r2 N2.';
CREATE TRIGGER t_session_link_moves BEFORE UPDATE ON public.reflection
  FOR EACH ROW EXECUTE FUNCTION app.t_session_link_moves('linked_session_id');
CREATE TRIGGER t_session_link_moves BEFORE UPDATE ON public.ai_memory
  FOR EACH ROW EXECUTE FUNCTION app.t_session_link_moves('session_id');
CREATE TRIGGER t_session_link_moves BEFORE UPDATE ON public.user_memory
  FOR EACH ROW EXECUTE FUNCTION app.t_session_link_moves('session_id');

-- T-reflection-unlink (review r1 F8, work-k5fk.9): the C6 key's ON DELETE SET NULL (linked_session_id) can null only
-- columns of the key, so a session's deletion would leave linked_at behind and fail reflection_check. This BEFORE
-- trigger clears linked_at whenever an UPDATE clears the link, the referential action's included.
CREATE FUNCTION app.t_reflection_unlink() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF NEW.linked_session_id IS NULL THEN
      NEW.linked_at := NULL;
    END IF;
    RETURN NEW;
  END
  $$;
-- No caller needs EXECUTE on a trigger function.
REVOKE EXECUTE ON FUNCTION app.t_reflection_unlink() FROM PUBLIC;
COMMENT ON FUNCTION app.t_reflection_unlink() IS 'Clears reflection.linked_at when an UPDATE clears linked_session_id (the C6 SET NULL (col) included), so reflection_check holds. Review r1 F8, work-k5fk.9.';
CREATE TRIGGER t_reflection_unlink BEFORE UPDATE OF linked_session_id ON public.reflection
  FOR EACH ROW EXECUTE FUNCTION app.t_reflection_unlink();
COMMENT ON TRIGGER t_reflection_unlink ON public.reflection IS 'linked_at goes with the link (review r1 F8).';

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
-- SECURITY DEFINER (owned by mwf_definer, handed over with the k5fk.2 trigger functions below; work-k5fk.10.33):
-- it asks whether a row exists, and under the writer's RLS a row the writer may not see would read as absent — the
-- answer must be the table's, not the caller's view of it.
CREATE FUNCTION app.t_result_live_attempt() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
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
-- SECURITY DEFINER (owned by mwf_definer; work-k5fk.10.33): its EXCEPT and NOT EXISTS terms ask what rows exist,
-- and under the writer's RLS a party, a participant or a choice the writer may not see would read as absent — and
-- the check pass vacuously. The answer must be the tables', not the writer's view of them.
CREATE FUNCTION app.t_agreement_parties() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
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
    -- review F4: the adder is present (a leaver adds no one).
    IF NOT EXISTS (SELECT 1 FROM public.participant a
                   WHERE a.session_id = NEW.session_id AND a.user_id = NEW.added_by_user_id AND a.kind = 'human'
                     AND a.left_at IS NULL) THEN
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
ALTER FUNCTION app.t_result_live_attempt() OWNER TO mwf_definer;
ALTER FUNCTION app.t_agreement_parties() OWNER TO mwf_definer;
ALTER FUNCTION app.t_live_session_pair() OWNER TO mwf_definer;
ALTER FUNCTION app.t_live_session_pair_end() OWNER TO mwf_definer;
REVOKE CREATE ON SCHEMA app FROM mwf_definer;

-- ---------------------------------------------------------------------------
-- work-k5fk.4: a message is (conversation_id, seq). t_message_seq numbers an
-- INSERT that leaves seq NULL — every runtime writer: no role is granted
-- INSERT (seq) — from app.next_message_seq. SECURITY DEFINER (owned by mwf_definer)
-- like the k5fk.2 triggers above, the exception to T5's invoker rule: the
-- helper is executable by its owner alone, the NOLOGIN mwf_definer
-- (work-k5fk.10.4), so no runtime login can take numbers outside an INSERT (a
-- taken number with no row is a hole). A conversation
-- that does not exist (or was deleted while the insert waited) is refused as
-- foreign_key_violation, with no DETAIL — never the NOT NULL error on seq, whose
-- DETAIL would print the failing row (house rule; functions-caller-tests 28b).
-- It runs after t_message_app_insert (name order), which reads
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
    IF NEW.seq IS NULL THEN
      RAISE EXCEPTION 'message refused: no such conversation' USING ERRCODE = 'foreign_key_violation';
    END IF;
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
       coalesce(p.display_name, x.user_name) AS display_name,
       coalesce(x.is_tombstone, false) AS is_tombstone,
       p.joined_at, p.left_at,
       x.main_conversation_id,
       x.last_viewed_at, x.last_seen_conversation_id, x.last_seen_seq, x.last_viewed_share_tab_at, x.archived_at,
       x.last_active_at, x.last_mood
FROM participant p
LEFT JOIN LATERAL app.participant_presence(p.session_id, p.user_id) x ON true;
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
-- mwf_ops: the Neural Monitor dashboard's stage column (routes/brain.ts, stage-shim.ts loadCurrentStages): exactly the
-- columns it reads (work-k5fk.9, least privilege).
GRANT SELECT (session_id, user_id, milestone_key, ordinal, stage_label, next_milestone_key, active_stage) ON v_current_stage
  TO ops_access;

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
-- T7. The database's ACL, then row-level security (design note §6 layers 1–3,
-- §7 row 9c; work-k5fk.10.6). Grants are not here (work-k5fk.7): every grant
-- sits next to its object — table grants after each table in tables.sql,
-- schema public's USAGE before the tables there, view grants after each view
-- (T6), EXECUTE grants after each function (T4, T5), schema app's in
-- preamble.sql. app-grants.target.test.ts snapshots the privilege matrix.
-- ---------------------------------------------------------------------------

-- T7a. Who may connect (review 9a r3 L2): nobody by default. PUBLIC loses CONNECT and TEMPORARY (no runtime path
-- creates a temporary object, and one shadowing a catalog name is an attack surface: caller test 13); each ACTIVE
-- capability gets CONNECT, which its one login inherits — never the login itself, so a login added later reaches the
-- database only through its capability. clinician_access (reserved, Q18) and mwf_definer (nobody logs in) get none.
-- The owner (mwf_migrator) and superusers connect by ownership / attribute. The operations bot connects through
-- diag_access (slam_bot_readonly, work-k5fk.10.30); no other role may (step 20 refuses any other grantee).
-- A database's ACL is not copied by CREATE DATABASE … TEMPLATE, so a clone (the golden runs) starts with PostgreSQL's
-- default again; the database this migration runs in is the one that counts.
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_access, ai_access, worker_access, ops_access, auth_access, diag_access',
                 current_database());
END
$$;

-- The seeds are complete (step 20 read them until FORCE ROW LEVEL SECURITY, below, hid every row from the migrator).
DO $$
DECLARE
  bad text;
  n   bigint;
BEGIN
  SELECT count(*) INTO n FROM milestone;
  IF n <> 13 THEN RAISE EXCEPTION 'step 20: % milestone rows, expected 13', n; END IF;
  -- work-k5fk.8: every name t_doc_schema can derive has a version-1 schema.
  SELECT string_agg(x.name, ', ' ORDER BY x.name) INTO bad
  FROM (SELECT 'user_preferences' AS name UNION ALL SELECT 'ai_memory.' || lower(e::text) FROM unnest(enum_range(NULL::ai_memory_kind)) e) x
  WHERE NOT EXISTS (SELECT 1 FROM app.json_schema j WHERE j.name = x.name AND j.version = 1);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: no version-1 json_schema for: %', bad; END IF;
  SELECT count(*) INTO n FROM app.json_schema;
  IF n <> 4 THEN RAISE EXCEPTION 'step 20: % json_schema rows, expected 4', n; END IF;
END
$$;

-- T7b. Row-level security: ENABLE + FORCE on every table (§6 layer 3, owner decision Q8), so the owner mwf_migrator
-- is held to the policies too and, holding none, reads and writes no row by default. That is a default, not a
-- control: as the owner it may ALTER TABLE … NO FORCE / DISABLE ROW LEVEL SECURITY, and it may SET ROLE mwf_definer
-- (definer_all). What holds the migrator is that only the deploy step logs in as it (pg_hba.conf) and pgaudit
-- logs every statement it runs (infra/aws/ownership.sql). Referential actions and
-- checks (a cascade, a RESTRICT, a unique probe) are not row reads: PostgreSQL runs them as the owner with RLS off.
-- Superusers bypass RLS (break-glass only, §6). _prisma_migrations is Prisma's own bookkeeping, written by
-- `migrate deploy` as the migrator around this script and granted to nobody: it is the one table left out.
-- A role with no policy on a table sees no row of it; step 20 requires a policy for every command each capability (and
-- mwf_definer) holds on every table, so a grant can never be silently dead — nor added without its policy.
-- Policies target capabilities, never logins (Q16), and call app.session_scope() as (SELECT …) so the planner
-- evaluates it once per statement (an initplan), not once per row. The policies, per capability:
--   app_access    the §6 per-table predicates (rows 9d–9g, work-k5fk.10.7), each with a COMMENT: app_own (the
--                 caller's own rows: user_id = app.current_user_id()), app_select / app_insert / app_update /
--                 app_delete where the commands differ (membership through app.is_member, the partner's rows only
--                 as §6 lets a member see them), app_read / app_reference on reference data. Every predicate is
--                 written (SELECT app.fn()) — an initplan — or as a definer helper of the row (T4), never an inline
--                 read of participant (spec P1-1). The goldens are the assertion that no request moved. A fact of
--                 a row the caller may not see (the invitee's invitation, an unrevealed attempt's author, a
--                 co-participant's presence …) is a content-free definer's answer (T4). No 9c interim is left.
--   ai_access     ai_session: the row's session is app.session_scope() — the one session the AI's transaction acts
--                 on (Q20) — and its acting user (app.current_user_id(), which the AI connection binds too) is a
--                 participant of it (app.scope_actor_is_member(), rows 9d–9g). Required: unset is NULL, which
--                 matches no row, so an unscoped or actorless AI statement reads and writes nothing (t_session_scope
--                 already refused its writes). session: its id; "user": the participants of that session;
--                 brain_activity: also the sessionless rows of the acting user's own reflection (ai_reflection) and,
--                 FINDING, the unattributed ones (ai_unattributed; work-k5fk.10.33); app.json_schema: reference
--                 data (ai_reference).
--   worker_access worker_session on the Stage 4 closure's tables (agreement, agreement_party, session_closure,
--                 proposal, proposal_choice, proposal_revision) and on the follow-ups it schedules (INSERT): the
--                 closure runs scoped to its session (stage4-closure.ts, withSessionScope). worker_all / worker_read /
--                 worker_update elsewhere: its cross-session jobs (retention, due follow-ups and reminders, push
--                 tokens) read and change rows of every session — the grants narrow them to columns, and where a
--                 call site writes one value only, the policy says so (work-k5fk.10.29: worker_clear_token,
--                 worker_purge_blobs, worker_purge).
--   ops_access    ops_read: SELECT, every row (the dashboard reads across sessions); its grants never include
--                 message.content or reflection_message.content (owner decision OD-1, work-k5fk.9 — §7 row 10),
--                 and nothing on ai_memory (the owner's follow-up decision: ops obtains no decrypted memory).
--   mwf_definer   definer_all: every row; the definer bodies make their own authorisation checks (T4).
--   auth_access, clinician_access: no table grant, so no policy.
-- Each table below says which capabilities hold which commands (S I U D) on it.
-- agreement: app_access S, mwf_definer S, worker_access SIU
ALTER TABLE agreement ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON agreement TO mwf_definer USING (true) WITH CHECK (true);
CREATE POLICY app_select ON agreement FOR SELECT TO app_access USING (app.is_member(session_id));
COMMENT ON POLICY app_select ON agreement IS 'The agreements of a session the caller is in (design note §6; work-k5fk.10.7).';
CREATE POLICY worker_session ON agreement TO worker_access USING (session_id = (SELECT app.session_scope())) WITH CHECK (session_id = (SELECT app.session_scope()));

-- agreement_party: app_access S, mwf_definer S, worker_access SI
ALTER TABLE agreement_party ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON agreement_party TO mwf_definer USING (true) WITH CHECK (true);
CREATE POLICY app_select ON agreement_party FOR SELECT TO app_access USING (app.is_member(session_id));
COMMENT ON POLICY app_select ON agreement_party IS 'The parties of the agreements of a session the caller is in (design note §6; work-k5fk.10.7).';
CREATE POLICY worker_session ON agreement_party TO worker_access USING (session_id = (SELECT app.session_scope())) WITH CHECK (session_id = (SELECT app.session_scope()));

-- ai_memory: ai_access SIU, app_access SIU, mwf_definer SD (no ops_access: the monitor reads no memory, work-k5fk.9)
ALTER TABLE ai_memory ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON ai_memory TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON ai_memory IS 'The caller''s own rows: their summaries and facts, session or global (design note §6; work-k5fk.10.7).';
CREATE POLICY ai_session ON ai_memory TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY definer_all ON ai_memory TO mwf_definer USING (true) WITH CHECK (true);

-- brain_activity: ai_access SIU, mwf_definer SD, ops_access S, worker_access SUD
ALTER TABLE brain_activity ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_session ON brain_activity TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY ai_reflection ON brain_activity TO ai_access
  USING (session_id IS NULL AND reflection_id IS NOT NULL AND app.owns_reflection(reflection_id))
  WITH CHECK (session_id IS NULL AND reflection_id IS NOT NULL AND app.owns_reflection(reflection_id));
COMMENT ON POLICY ai_reflection ON brain_activity IS 'An inner-work call''s telemetry: the acting user''s own reflection only (work-k5fk.10.33).';
CREATE POLICY ai_unattributed ON brain_activity TO ai_access
  USING (session_id IS NULL AND reflection_id IS NULL) WITH CHECK (session_id IS NULL AND reflection_id IS NULL);
COMMENT ON POLICY ai_unattributed ON brain_activity IS 'FINDING (work-k5fk.10.33, left open): a call of neither a session nor a reflection carries no owner, so any AI transaction still reads and completes such a row.';
CREATE POLICY worker_read ON brain_activity FOR SELECT TO worker_access USING (true);
CREATE POLICY worker_purge_blobs ON brain_activity FOR UPDATE TO worker_access USING (true)
  WITH CHECK (input IS NULL AND output IS NULL AND metadata IS NULL);
COMMENT ON POLICY worker_purge_blobs ON brain_activity IS 'The worker''s only UPDATE is the retention purge: the three blobs NULL (data-retention.ts enforceDataRetention); it can never write one (work-k5fk.10.29 R2).';
CREATE POLICY worker_delete ON brain_activity FOR DELETE TO worker_access USING (true);
CREATE POLICY ops_read ON brain_activity FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON brain_activity TO mwf_definer USING (true) WITH CHECK (true);

-- consent: app_access SIU, mwf_definer SU
ALTER TABLE consent ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON consent TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON consent IS 'The caller''s own rows: the deciders (no requester arm, P1-4) (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON consent TO mwf_definer USING (true) WITH CHECK (true);

-- context_share_offer: ai_access SIU, app_access SU, mwf_definer SU
ALTER TABLE context_share_offer ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON context_share_offer FOR SELECT TO app_access USING (subject_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_select ON context_share_offer IS 'The share offers made to the caller (the subject); the author sees the shared text only as its delivered copy (design note §6, R6; work-k5fk.10.7).';
CREATE POLICY app_update ON context_share_offer FOR UPDATE TO app_access USING (subject_user_id = (SELECT app.current_user_id())) WITH CHECK (subject_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_update ON context_share_offer IS 'The subject answers their own offer (status, shared / declined; work-k5fk.10.7).';
CREATE POLICY ai_session ON context_share_offer TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY definer_all ON context_share_offer TO mwf_definer USING (true) WITH CHECK (true);

-- conversation: ai_access S, app_access SIU, mwf_definer SUD, ops_access S
ALTER TABLE conversation ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON conversation FOR SELECT TO app_access
  USING (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_select ON conversation IS 'The caller''s own conversations (design note §6). A co-participant''s MAIN conversation id — the address a delivery to them goes to — comes from app.session_parties / v_participant; their row (next_seq) is never the app''s (work-k5fk.10.7, review F8).';
CREATE POLICY app_insert ON conversation FOR INSERT TO app_access WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_insert ON conversation IS 'The caller''s own conversation (their MAIN at create / accept, a sub-chat; work-k5fk.10.7).';
CREATE POLICY app_update ON conversation FOR UPDATE TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_update ON conversation IS 'The caller''s own conversation (status, resolved_at; work-k5fk.10.7).';
CREATE POLICY ai_session ON conversation TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY ops_read ON conversation FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON conversation TO mwf_definer USING (true) WITH CHECK (true);

-- conversation_read_state: app_access SIU, mwf_definer SD
ALTER TABLE conversation_read_state ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON conversation_read_state TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()) AND (last_seen_conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversation c WHERE c.id = conversation_read_state.last_seen_conversation_id AND c.user_id = (SELECT app.current_user_id()))));
COMMENT ON POLICY app_own ON conversation_read_state IS 'The caller''s own rows: their read state (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON conversation_read_state TO mwf_definer USING (true) WITH CHECK (true);

-- draft: app_access SIUD, mwf_definer SD
ALTER TABLE draft ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON draft TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON draft IS 'The caller''s own rows: their drafts (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON draft TO mwf_definer USING (true) WITH CHECK (true);

-- empathy_attempt: ai_access SU, app_access SI, mwf_definer SIUD
ALTER TABLE empathy_attempt ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON empathy_attempt FOR SELECT TO app_access
  USING (author_user_id = (SELECT app.current_user_id()) OR (subject_user_id = (SELECT app.current_user_id()) AND revealed_at IS NOT NULL));
COMMENT ON POLICY app_select ON empathy_attempt IS 'The caller''s own attempts; the ones about the caller only once revealed — before that its subject reads the direction''s status through v_empathy_direction_status (design note §6, P0-2; work-k5fk.10.7).';
CREATE POLICY app_insert ON empathy_attempt FOR INSERT TO app_access WITH CHECK (author_user_id = (SELECT app.current_user_id()) AND status = 'HELD');
COMMENT ON POLICY app_insert ON empathy_attempt IS 'The caller''s own new attempt, HELD; every move after is app.empathy_set_status (design note §6; work-k5fk.10.7).';
CREATE POLICY ai_session ON empathy_attempt TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY definer_all ON empathy_attempt TO mwf_definer USING (true) WITH CHECK (true);

-- empathy_review: app_access SIU, mwf_definer S
ALTER TABLE empathy_review ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON empathy_review TO app_access USING (reviewer_user_id = (SELECT app.current_user_id()))
  WITH CHECK (reviewer_user_id = (SELECT app.current_user_id())
              AND EXISTS (SELECT 1 FROM empathy_attempt a WHERE a.id = empathy_review.attempt_id AND a.revealed_at IS NOT NULL));
COMMENT ON POLICY app_own ON empathy_review IS 'The caller''s own rows: their reviews of an attempt about them, written only once that attempt is revealed (the subject reads it then; design note §6; work-k5fk.10.7, review F9).';
CREATE POLICY app_author_sent ON empathy_review FOR SELECT TO app_access
  USING (feedback_sent_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM empathy_attempt a WHERE a.id = empathy_review.attempt_id AND a.author_user_id = (SELECT app.current_user_id())));
COMMENT ON POLICY app_author_sent ON empathy_review IS 'The author of the attempt reads its review once the feedback was sent — before that nothing, the validated flag included (spec §1.2 RLS, fix1 m2; empathy-store reviewVisibleToAuthor; work-k5fk.10.7).';
CREATE POLICY definer_all ON empathy_review TO mwf_definer USING (true) WITH CHECK (true);

-- feature_state: app_access SIU, mwf_definer SD
ALTER TABLE feature_state ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON feature_state TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON feature_state IS 'The caller''s own rows: their wellbeing features (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON feature_state TO mwf_definer USING (true) WITH CHECK (true);

-- follow_up: app_access SIU, mwf_definer S, worker_access SIU
ALTER TABLE follow_up ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON follow_up FOR SELECT TO app_access
  USING (app.is_member(session_id) AND (scope = 'SHARED' OR owner_user_id = (SELECT app.current_user_id()) OR opted_in_shared));
COMMENT ON POLICY app_select ON follow_up IS 'In a session the caller is in: the shared follow-ups, the caller''s own individual ones, and a partner''s individual one only once its owner opted it in to sharing (design note §6 narrowed; work-k5fk.10.7, review F11).';
CREATE POLICY app_insert ON follow_up FOR INSERT TO app_access
  WITH CHECK (app.is_member(session_id) AND (owner_user_id IS NULL OR owner_user_id = (SELECT app.current_user_id())));
COMMENT ON POLICY app_insert ON follow_up IS 'A follow-up of a session of the caller''s, the caller''s own when it has an owner (work-k5fk.10.7).';
CREATE POLICY app_update ON follow_up FOR UPDATE TO app_access USING (owner_user_id = (SELECT app.current_user_id())) WITH CHECK (owner_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_update ON follow_up IS 'The owner of an individual entry shares it or not (opted_in_shared; tending setIndividualEntryShare; work-k5fk.10.7).';
CREATE POLICY worker_read ON follow_up FOR SELECT TO worker_access USING (true);
CREATE POLICY worker_update ON follow_up FOR UPDATE TO worker_access USING (true) WITH CHECK (true);
CREATE POLICY worker_session ON follow_up FOR INSERT TO worker_access WITH CHECK (session_id = (SELECT app.session_scope()));
CREATE POLICY definer_all ON follow_up TO mwf_definer USING (true) WITH CHECK (true);

-- follow_up_checkin: app_access SI, mwf_definer SD
ALTER TABLE follow_up_checkin ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON follow_up_checkin FOR SELECT TO app_access
  USING (user_id = (SELECT app.current_user_id()) OR (app.is_member(session_id) AND EXISTS (SELECT 1 FROM follow_up f WHERE f.id = follow_up_checkin.follow_up_id AND f.scope = 'SHARED' AND f.status IN ('COMPLETED', 'PARTIAL'))));
COMMENT ON POLICY app_select ON follow_up_checkin IS 'The caller''s own check-ins; a co-participant''s on a SHARED follow-up once it is COMPLETED or PARTIAL (design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON follow_up_checkin FOR INSERT TO app_access
  WITH CHECK (user_id = (SELECT app.current_user_id())
              AND EXISTS (SELECT 1 FROM follow_up f WHERE f.id = follow_up_checkin.follow_up_id
                            AND (f.scope = 'SHARED' OR f.owner_user_id = (SELECT app.current_user_id()))));
COMMENT ON POLICY app_insert ON follow_up_checkin IS 'The caller''s own check-in, on a shared follow-up or the caller''s own individual one (design note §6; work-k5fk.10.7, review F11).';
CREATE POLICY definer_all ON follow_up_checkin TO mwf_definer USING (true) WITH CHECK (true);

-- follow_up_note: app_access SIU, mwf_definer SD
ALTER TABLE follow_up_note ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON follow_up_note TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON follow_up_note IS 'The caller''s own rows: their between-period notes (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON follow_up_note TO mwf_definer USING (true) WITH CHECK (true);

-- invitation: app_access SIU, mwf_definer S, ops_access S
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON invitation FOR SELECT TO app_access USING (invited_by_user_id = (SELECT app.current_user_id()) OR accepted_by_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_select ON invitation IS 'The invitations the caller sent or accepted; before accepting, app.invitation_peek (design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON invitation FOR INSERT TO app_access WITH CHECK (invited_by_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_insert ON invitation IS 'The inviter''s own invitation (createSession; work-k5fk.10.7).';
CREATE POLICY app_update ON invitation FOR UPDATE TO app_access USING (invited_by_user_id = (SELECT app.current_user_id())) WITH CHECK (invited_by_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_update ON invitation IS 'The inviter confirms the message (message_confirmed_at) and locks it for a pre-join draft save; the invitee''s answer is app.invitation_answer (work-k5fk.10.7).';
CREATE POLICY ops_read ON invitation FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON invitation TO mwf_definer USING (true) WITH CHECK (true);

-- json_schema: ai_access S, app_access S
ALTER TABLE app.json_schema ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_reference ON app.json_schema FOR SELECT TO app_access USING (true);
COMMENT ON POLICY app_reference ON app.json_schema IS 'Reference data: the seeded document schemas t_doc_schema reads with the writer''s rights (work-k5fk.10.7).';
CREATE POLICY ai_reference ON app.json_schema FOR SELECT TO ai_access USING (true);

-- live_session_pair: app_access S, mwf_definer SID
ALTER TABLE live_session_pair ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON live_session_pair FOR SELECT TO app_access USING ((SELECT app.current_user_id()) IN (user_a, user_b));
COMMENT ON POLICY app_select ON live_session_pair IS 'The caller''s own pairs (createSession''s pre-check, contacts.ts findLiveSessionWith; work-k5fk.10.7).';
CREATE POLICY definer_all ON live_session_pair TO mwf_definer USING (true) WITH CHECK (true);

-- message: ai_access SI, app_access SID, mwf_definer SI, ops_access S, worker_access S
ALTER TABLE message ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON message FOR SELECT TO app_access USING (sender_user_id = (SELECT app.current_user_id()) OR EXISTS (SELECT 1 FROM conversation c WHERE c.id = message.conversation_id AND c.user_id = (SELECT app.current_user_id())));
COMMENT ON POLICY app_select ON message IS 'The lines of the caller''s own conversations, and the caller''s own lines (design note §6, Q9; work-k5fk.10.7).';
CREATE POLICY app_insert ON message FOR INSERT TO app_access
  WITH CHECK (role = 'USER' AND sender_user_id = (SELECT app.current_user_id()) AND kind IN ('CHAT', 'EMPATHY_STATEMENT') AND EXISTS (SELECT 1 FROM conversation c WHERE c.id = message.conversation_id AND c.user_id = (SELECT app.current_user_id())));
COMMENT ON POLICY app_insert ON message IS 'The caller''s own USER turn (CHAT) and own copy of their empathy statement, in their own conversation; every other line is a definer''s or the AI''s (design note §6; work-k5fk.10.7).';
CREATE POLICY app_delete ON message FOR DELETE TO app_access
  USING (EXISTS (SELECT 1 FROM conversation c WHERE c.id = message.conversation_id AND c.user_id = (SELECT app.current_user_id())) AND ((role = 'USER' AND kind = 'CHAT' AND sender_user_id = (SELECT app.current_user_id())) OR kind = 'SHARE_SUGGESTION'));
COMMENT ON POLICY app_delete ON message IS 'In the caller''s own conversation: their failed USER turn, or a share suggestion (declined or accepted; work-k5fk.10.7).';
CREATE POLICY ai_session ON message TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY worker_all ON message TO worker_access USING (true) WITH CHECK (true);
CREATE POLICY ops_read ON message FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON message TO mwf_definer USING (true) WITH CHECK (true);

-- milestone: app_access S, mwf_definer S, ops_access S
ALTER TABLE milestone ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON milestone FOR SELECT TO app_access USING (true);
COMMENT ON POLICY app_read ON milestone IS 'Reference data: the seeded milestone keys (work-k5fk.10.7).';
CREATE POLICY ops_read ON milestone FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON milestone TO mwf_definer USING (true) WITH CHECK (true);

-- mood_reading: app_access SI, mwf_definer SD, ops_access S
ALTER TABLE mood_reading ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON mood_reading TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON mood_reading IS 'The caller''s own rows: their mood readings (design note §6; work-k5fk.10.7).';
CREATE POLICY ops_read ON mood_reading FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON mood_reading TO mwf_definer USING (true) WITH CHECK (true);

-- need: app_access SIU, mwf_definer SD
ALTER TABLE need ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON need TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON need IS 'The caller''s own rows: their needs (a soft delete is deleted_at) (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON need TO mwf_definer USING (true) WITH CHECK (true);

-- need_disposition: app_access SIUD, mwf_definer SD
ALTER TABLE need_disposition ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON need_disposition TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON need_disposition IS 'The caller''s own rows: their dispositions of a need (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON need_disposition TO mwf_definer USING (true) WITH CHECK (true);

-- need_share: app_access S, mwf_definer SIU
ALTER TABLE need_share ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON need_share FOR SELECT TO app_access
  USING (user_id = (SELECT app.current_user_id()) OR (revoked_at IS NULL AND app.is_member(session_id)));
COMMENT ON POLICY app_select ON need_share IS 'The caller''s own shares, and every unrevoked share of a session the caller is in; a share is written by app.need_share (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON need_share TO mwf_definer USING (true) WITH CHECK (true);

-- participant: ai_access S, app_access SI, mwf_definer SU, ops_access S, worker_access S
ALTER TABLE participant ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON participant FOR SELECT TO app_access USING (user_id = (SELECT app.current_user_id()) OR app.is_member(session_id));
COMMENT ON POLICY app_select ON participant IS 'The caller''s seats and every seat of a session the caller is in (design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON participant FOR INSERT TO app_access
  WITH CHECK ((user_id = (SELECT app.current_user_id()) AND added_by_user_id IS NULL AND app.session_unseated(session_id))
              OR (user_id = (SELECT app.current_user_id()) AND EXISTS (SELECT 1 FROM invitation i
                                              WHERE i.session_id = participant.session_id
                                                AND i.invited_by_user_id = participant.added_by_user_id
                                                AND i.accepted_by_user_id = (SELECT app.current_user_id())))
              OR (added_by_user_id = (SELECT app.current_user_id()) AND kind <> 'human' AND app.is_current_member(session_id)));
COMMENT ON POLICY app_insert ON participant IS 'Three seats only: the caller as the initiator of a session nobody is seated in (createSession, the linked process); the caller as the invitee of an invitation they accepted, added by its inviter (acceptInvitation); the AI or a persona the caller brings in (t_participant_added_by checks the adder and the owner). Nobody seats another human (work-k5fk.10.7).';
CREATE POLICY ai_session ON participant TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY worker_all ON participant TO worker_access USING (true) WITH CHECK (true);
CREATE POLICY ops_read ON participant FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON participant TO mwf_definer USING (true) WITH CHECK (true);

-- participant_key: mwf_definer SU
ALTER TABLE participant_key ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON participant_key TO mwf_definer USING (true) WITH CHECK (true);

-- participant_milestone: ai_access S, app_access SI, mwf_definer SID, ops_access S, worker_access S
ALTER TABLE participant_milestone ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON participant_milestone FOR SELECT TO app_access USING (user_id = (SELECT app.current_user_id()) OR app.is_member(session_id));
COMMENT ON POLICY app_select ON participant_milestone IS 'Progress of every participant of the caller''s sessions (the stage shim reads both; design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON participant_milestone FOR INSERT TO app_access
  WITH CHECK (user_id = (SELECT app.current_user_id()) AND EXISTS (SELECT 1 FROM milestone m WHERE m.key = milestone_key AND m.self_assertable));
COMMENT ON POLICY app_insert ON participant_milestone IS 'The caller''s own self-assertable milestones only; every other key, and any for the partner, is app.reach_milestone''s (work-k5fk.10.28; work-k5fk.10.7).';
CREATE POLICY ai_session ON participant_milestone TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY worker_all ON participant_milestone TO worker_access USING (true) WITH CHECK (true);
CREATE POLICY ops_read ON participant_milestone FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON participant_milestone TO mwf_definer USING (true) WITH CHECK (true);

-- persona: mwf_definer S
ALTER TABLE persona ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON persona TO mwf_definer USING (true) WITH CHECK (true);

-- proposal: app_access SIU, mwf_definer S, worker_access SU
ALTER TABLE proposal ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON proposal FOR SELECT TO app_access USING (app.is_member(session_id));
COMMENT ON POLICY app_select ON proposal IS 'The proposals of a session the caller is in (design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON proposal FOR INSERT TO app_access
  WITH CHECK (created_by_user_id = (SELECT app.current_user_id()) AND app.is_member(session_id)
              AND status = 'ACTIVE' AND removed_by_user_id IS NULL);
COMMENT ON POLICY app_insert ON proposal IS 'A proposal the caller makes, in a session of theirs, starting ACTIVE and unremoved — never born converted or removed (design note §6; work-k5fk.10.7, review r2 N3).';
CREATE POLICY app_update ON proposal FOR UPDATE TO app_access
  USING (app.is_member(session_id) AND status <> 'CONVERTED_TO_AGREEMENT'
         AND (created_by_user_id = (SELECT app.current_user_id()) OR kind = 'SHARED_PROPOSAL'))
  WITH CHECK (app.is_member(session_id) AND (created_by_user_id = (SELECT app.current_user_id()) OR kind = 'SHARED_PROPOSAL'));
COMMENT ON POLICY app_update ON proposal IS 'Creator-only until shared (owner decision 2026-11-23, work-k5fk.10.10): the caller''s own proposal, or a SHARED_PROPOSAL, which is shared with every member from birth (app_select is membership; stage4-store loadProposals shows it to all) — so either participant edits, refines or removes it (Stage 4 capture, the sub-chat). Never the partner''s INDIVIDUAL_COMMITMENT, even once shared_at makes it visible. Never one converted to an agreement (the worker''s; closes work-k5fk.10.9''s revival). The app checks the same rule first (stage4-store proposalEditableBy). work-k5fk.10.7.';
CREATE POLICY worker_session ON proposal TO worker_access USING (session_id = (SELECT app.session_scope())) WITH CHECK (session_id = (SELECT app.session_scope()));
CREATE POLICY definer_all ON proposal TO mwf_definer USING (true) WITH CHECK (true);

-- proposal_choice: app_access SIU, mwf_definer SD, worker_access S
ALTER TABLE proposal_choice ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON proposal_choice FOR SELECT TO app_access
  USING (user_id = (SELECT app.current_user_id()) OR (app.is_member(session_id) AND EXISTS (SELECT 1 FROM participant_milestone m WHERE m.session_id = proposal_choice.session_id AND m.user_id = proposal_choice.user_id AND m.milestone_key = 'choices_shared')));
COMMENT ON POLICY app_select ON proposal_choice IS 'The caller''s own choices; a co-participant''s once they shared them (choices_shared) (design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON proposal_choice FOR INSERT TO app_access WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_insert ON proposal_choice IS 'The caller''s own choice (design note §6; work-k5fk.10.7).';
CREATE POLICY app_update ON proposal_choice FOR UPDATE TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_update ON proposal_choice IS 'The caller revises their own choice (design note §6; work-k5fk.10.7).';
CREATE POLICY worker_session ON proposal_choice TO worker_access USING (session_id = (SELECT app.session_scope())) WITH CHECK (session_id = (SELECT app.session_scope()));
CREATE POLICY definer_all ON proposal_choice TO mwf_definer USING (true) WITH CHECK (true);

-- proposal_need: app_access SID
ALTER TABLE proposal_need ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON proposal_need FOR SELECT TO app_access USING (app.is_member(session_id));
COMMENT ON POLICY app_select ON proposal_need IS 'The need links of the proposals of a session the caller is in (design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON proposal_need FOR INSERT TO app_access
  WITH CHECK (app.is_member(session_id)
              AND EXISTS (SELECT 1 FROM proposal p WHERE p.id = proposal_need.proposal_id
                            AND (p.created_by_user_id = (SELECT app.current_user_id()) OR p.kind = 'SHARED_PROPOSAL')));
COMMENT ON POLICY app_insert ON proposal_need IS 'A need link of a proposal the caller may edit: their own, or a shared one (as proposal_revision; design note §6; work-k5fk.10.7, review F10).';
CREATE POLICY app_delete ON proposal_need FOR DELETE TO app_access
  USING (app.is_member(session_id)
         AND EXISTS (SELECT 1 FROM proposal p WHERE p.id = proposal_need.proposal_id
                       AND (p.created_by_user_id = (SELECT app.current_user_id()) OR p.kind = 'SHARED_PROPOSAL')));
COMMENT ON POLICY app_delete ON proposal_need IS 'A need link of a proposal the caller may edit: their own, or a shared one (work-k5fk.10.7, review F10).';

-- proposal_revision: app_access SI, worker_access I
ALTER TABLE proposal_revision ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON proposal_revision FOR SELECT TO app_access USING (app.is_member(session_id));
COMMENT ON POLICY app_select ON proposal_revision IS 'The revision history of the proposals of a session the caller is in (design note §6; work-k5fk.10.7).';
CREATE POLICY app_insert ON proposal_revision FOR INSERT TO app_access
  WITH CHECK (actor_user_id = (SELECT app.current_user_id()) AND app.is_member(session_id)
              AND EXISTS (SELECT 1 FROM proposal p WHERE p.id = proposal_revision.proposal_id
                            AND (p.created_by_user_id = (SELECT app.current_user_id()) OR p.kind = 'SHARED_PROPOSAL')));
COMMENT ON POLICY app_insert ON proposal_revision IS 'A revision the caller made, in a session of theirs (design note §6: member + actor = me), of a proposal they may edit as proposal app_update has it: their own, or a SHARED_PROPOSAL (shared with every member from birth) — never the partner''s INDIVIDUAL_COMMITMENT, shared or not (owner decision 2026-11-23: creator-only until shared; work-k5fk.10.11, work-k5fk.10.7). The app checks the same rule first (stage4-store proposalEditableBy).';
CREATE POLICY worker_session ON proposal_revision TO worker_access USING (session_id = (SELECT app.session_scope())) WITH CHECK (session_id = (SELECT app.session_scope()));

-- reconciler_guidance: ai_access SI, app_access S
ALTER TABLE reconciler_guidance ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON reconciler_guidance FOR SELECT TO app_access USING (author_user_id = (SELECT app.current_user_id()) OR subject_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_select ON reconciler_guidance IS 'Guidance in a direction the caller is a party of (design note §6; work-k5fk.10.7).';
CREATE POLICY ai_session ON reconciler_guidance TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));

-- reconciler_result: ai_access SIU, app_access S, mwf_definer S
ALTER TABLE reconciler_result ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON reconciler_result TO mwf_definer USING (true) WITH CHECK (true);
CREATE POLICY app_select ON reconciler_result FOR SELECT TO app_access USING (subject_user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_select ON reconciler_result IS 'The reconciler''s analysis of an attempt about the caller — never its author''s (design note §6, R6; work-k5fk.10.7).';
CREATE POLICY ai_session ON reconciler_result TO ai_access
  USING (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (session_id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));

-- reflection: app_access SIU, mwf_definer SD, ops_access S
ALTER TABLE reflection ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON reflection TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()) AND (linked_session_id IS NULL OR app.is_member(linked_session_id)));
COMMENT ON POLICY app_own ON reflection IS 'The caller''s own rows: their inner work (a linked session is one of the callers) (design note §6; work-k5fk.10.7).';
CREATE POLICY ops_read ON reflection FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON reflection TO mwf_definer USING (true) WITH CHECK (true);

-- reflection_message: app_access SI, ops_access S
ALTER TABLE reflection_message ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON reflection_message TO app_access USING (EXISTS (SELECT 1 FROM reflection r WHERE r.id = reflection_message.reflection_id AND r.user_id = (SELECT app.current_user_id()))) WITH CHECK (EXISTS (SELECT 1 FROM reflection r WHERE r.id = reflection_message.reflection_id AND r.user_id = (SELECT app.current_user_id())));
COMMENT ON POLICY app_own ON reflection_message IS 'The messages of the caller''s own reflections (design note §6; work-k5fk.10.7).';
CREATE POLICY ops_read ON reflection_message FOR SELECT TO ops_access USING (true);

-- regulation_event: app_access SI, mwf_definer SD
ALTER TABLE regulation_event ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON regulation_event TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON regulation_event IS 'The caller''s own rows: their regulation exercises (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON regulation_event TO mwf_definer USING (true) WITH CHECK (true);

-- reminder: app_access SID, mwf_definer SD, worker_access SU
ALTER TABLE reminder ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON reminder TO app_access USING (user_id = (SELECT app.current_user_id()))
  WITH CHECK (user_id = (SELECT app.current_user_id())
              AND (follow_up_id IS NULL OR EXISTS (SELECT 1 FROM follow_up f WHERE f.id = reminder.follow_up_id)));
COMMENT ON POLICY app_own ON reminder IS 'The caller''s own rows: their reminders, pointing only at a follow-up the caller can read (follow_up''s own policy: a session they are in; design note §6; work-k5fk.10.7, review F14).';
CREATE POLICY worker_all ON reminder TO worker_access USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON reminder TO mwf_definer USING (true) WITH CHECK (true);

-- session: ai_access SU, app_access SIU, mwf_definer SU, ops_access S, worker_access SD
ALTER TABLE session ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON session FOR SELECT TO app_access
  USING (app.is_member(id) OR (status = 'CREATED' AND app.session_unseated(id)));
COMMENT ON POLICY app_select ON session IS 'A session the caller is (or was) seated in; and a CREATED session nobody is seated in yet — createSession''s INSERT … RETURNING, before the initiator''s participant row (work-k5fk.10.7).';
CREATE POLICY app_insert ON session FOR INSERT TO app_access
  WITH CHECK (status = 'CREATED' AND (previous_session_id IS NULL OR app.is_current_member(previous_session_id)));
COMMENT ON POLICY app_insert ON session IS 'A new session starts CREATED, continuing (previous_session_id) only a session of the caller''s; its initiator''s participant row follows in the same transaction (design note §6; work-k5fk.10.7).';
CREATE POLICY app_update ON session FOR UPDATE TO app_access USING (app.is_member(id)) WITH CHECK (app.is_member(id));
COMMENT ON POLICY app_update ON session IS 'A participant''s session: the topic frame and its confirmation (the grant''s columns); status moves only through app.session_set_status (work-k5fk.10.7).';
CREATE POLICY ai_session ON session TO ai_access
  USING (id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member())) WITH CHECK (id = (SELECT app.session_scope()) AND (SELECT app.scope_actor_is_member()));
CREATE POLICY worker_read ON session FOR SELECT TO worker_access USING (true);
CREATE POLICY worker_purge ON session FOR DELETE TO worker_access
  USING (status = 'ARCHIVED' AND updated_at < CURRENT_TIMESTAMP - interval '90 days');
COMMENT ON POLICY worker_purge ON session IS 'The worker hard-deletes only a session ARCHIVED and untouched for the purge window (90 days: session-retention.ts ARCHIVED_SESSION_PURGE_MS, by updated_at, which the archive''s status write stamps — the call site''s own filter) — never one it archived in the same transaction (work-k5fk.10.29 R3; t_session_purge refuses a non-ARCHIVED one).';
CREATE POLICY ops_read ON session FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON session TO mwf_definer USING (true) WITH CHECK (true);

-- session_closure: app_access S, worker_access I
ALTER TABLE session_closure ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON session_closure FOR SELECT TO app_access USING (app.is_member(session_id));
COMMENT ON POLICY app_select ON session_closure IS 'The closure of a session the caller is in (design note §6; work-k5fk.10.7).';
CREATE POLICY worker_session ON session_closure TO worker_access USING (session_id = (SELECT app.session_scope())) WITH CHECK (session_id = (SELECT app.session_scope()));

-- session_key: no grant, so no policy: no runtime role reads or writes a row
ALTER TABLE session_key ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- takeaway: app_access SIUD
ALTER TABLE takeaway ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON takeaway TO app_access USING (EXISTS (SELECT 1 FROM reflection r WHERE r.id = takeaway.reflection_id AND r.user_id = (SELECT app.current_user_id()))) WITH CHECK (EXISTS (SELECT 1 FROM reflection r WHERE r.id = takeaway.reflection_id AND r.user_id = (SELECT app.current_user_id())));
COMMENT ON POLICY app_own ON takeaway IS 'The takeaways of the caller''s own reflections (design note §6; work-k5fk.10.7).';

-- takeaway_link: app_access SID
ALTER TABLE takeaway_link ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON takeaway_link TO app_access USING (EXISTS (SELECT 1 FROM takeaway t JOIN reflection r ON r.id = t.reflection_id WHERE t.id = takeaway_link.source_id AND r.user_id = (SELECT app.current_user_id()))) WITH CHECK (EXISTS (SELECT 1 FROM takeaway t JOIN reflection r ON r.id = t.reflection_id WHERE t.id = takeaway_link.source_id AND r.user_id = (SELECT app.current_user_id())) AND EXISTS (SELECT 1 FROM takeaway t JOIN reflection r ON r.id = t.reflection_id WHERE t.id = takeaway_link.target_id AND r.user_id = (SELECT app.current_user_id())));
COMMENT ON POLICY app_own ON takeaway_link IS 'Links from the caller''s own takeaways, and only to their own (design note §6; work-k5fk.10.7).';

-- user: ai_access S, app_access SU, mwf_definer SIU, ops_access S
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_select ON "user" FOR SELECT TO app_access
  USING (id = (SELECT app.current_user_id()) OR kind = 'ai' OR app.owns_persona(id));
COMMENT ON POLICY app_select ON "user" IS 'The caller, the AI principal and the caller''s personas (design note §6). A co-participant''s row stays out of reach: the name the app calls them by comes from app.session_parties / v_participant, never their email, last name or deletion instant (work-k5fk.10.7, review F7).';
CREATE POLICY app_update ON "user" FOR UPDATE TO app_access USING (id = (SELECT app.current_user_id())) WITH CHECK (id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_update ON "user" IS 'The caller''s own names (controllers/auth.ts profile edit; work-k5fk.10.7).';
CREATE POLICY ai_session ON "user" FOR SELECT TO ai_access
  USING ((SELECT app.scope_actor_is_member()) AND EXISTS (SELECT 1 FROM participant p WHERE p.session_id = (SELECT app.session_scope()) AND p.user_id = "user".id));
CREATE POLICY ops_read ON "user" FOR SELECT TO ops_access USING (true);
CREATE POLICY definer_all ON "user" TO mwf_definer USING (true) WITH CHECK (true);

-- user_contact: app_access SIU, mwf_definer SD
ALTER TABLE user_contact ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON user_contact TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON user_contact IS 'The caller''s own rows: what the caller calls other people (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON user_contact TO mwf_definer USING (true) WITH CHECK (true);

-- user_device: app_access SIU, mwf_definer SD, worker_access SU
ALTER TABLE user_device ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON user_device TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON user_device IS 'The caller''s own rows: their devices (design note §6; work-k5fk.10.7).';
CREATE POLICY worker_read ON user_device FOR SELECT TO worker_access USING (true);
CREATE POLICY worker_clear_token ON user_device FOR UPDATE TO worker_access USING (true) WITH CHECK (push_token IS NULL);
COMMENT ON POLICY worker_clear_token ON user_device IS 'The worker only clears a token Expo reports unregistered (user-settings.ts clearPushTokenAsWorker); it can never set one (work-k5fk.10.29 R1).';
CREATE POLICY definer_all ON user_device TO mwf_definer USING (true) WITH CHECK (true);

-- user_identity: mwf_definer SID
ALTER TABLE user_identity ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON user_identity TO mwf_definer USING (true) WITH CHECK (true);

-- user_key: mwf_definer SU
ALTER TABLE user_key ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON user_key TO mwf_definer USING (true) WITH CHECK (true);

-- user_memory: app_access SIUD, mwf_definer SD
ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON user_memory TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON user_memory IS 'The caller''s own rows: their memories (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON user_memory TO mwf_definer USING (true) WITH CHECK (true);

-- user_preferences: app_access SIU, mwf_definer SD
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON user_preferences TO app_access USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()));
COMMENT ON POLICY app_own ON user_preferences IS 'The caller''s own rows: their preferences (design note §6; work-k5fk.10.7).';
CREATE POLICY definer_all ON user_preferences TO mwf_definer USING (true) WITH CHECK (true);

-- Review F4: a participant who left keeps reading the session (app.is_member counts leavers: what was shared stays
-- readable, spec §1.1) but writes nothing in it. Every session-scoped table mwf_app writes carries one RESTRICTIVE
-- policy per write command it holds: the row's session must be one the caller is a PRESENT participant of
-- (app.is_current_member). Restrictive, so it narrows the permissive §6 policies above without restating them; a
-- row outside any session (a NULL session_id / linked_session_id) is the caller's own and unaffected. participant
-- itself is guarded in its policy (the adder arm) and t_participant_added_by; session INSERT by its
-- previous_session_id (below).
-- Review r2 N2: an own-row table whose session link is optional (reflection.linked_session_id, ai_memory /
-- user_memory.session_id) is the user's own, not the session's: a leaver keeps editing, unlinking and deleting it.
-- Only a NEW link (an INSERT naming a session, or an UPDATE that changes the link to one) needs present
-- membership: app_active_insert below, and t_session_link_moves for the UPDATE (a policy cannot compare OLD with
-- NEW).
CREATE POLICY app_active_insert ON ai_memory AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK ((session_id IS NULL OR app.is_current_member(session_id)));
COMMENT ON POLICY app_active_insert ON ai_memory IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON consent AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON consent IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON consent AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON consent IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON context_share_offer AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON context_share_offer IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON conversation AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON conversation IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON conversation AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON conversation IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON conversation_read_state AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON conversation_read_state IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON conversation_read_state AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON conversation_read_state IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON draft AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON draft IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON draft AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON draft IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_delete ON draft AS RESTRICTIVE FOR DELETE TO app_access USING (app.is_current_member(session_id));
COMMENT ON POLICY app_active_delete ON draft IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON empathy_attempt AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON empathy_attempt IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON empathy_review AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON empathy_review IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON empathy_review AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON empathy_review IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON follow_up AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON follow_up IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON follow_up AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON follow_up IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON follow_up_checkin AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON follow_up_checkin IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON follow_up_note AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON follow_up_note IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON follow_up_note AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON follow_up_note IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON invitation AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON invitation IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON invitation AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON invitation IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON message AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON message IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_delete ON message AS RESTRICTIVE FOR DELETE TO app_access USING (app.is_current_member(session_id));
COMMENT ON POLICY app_active_delete ON message IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON mood_reading AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK ((session_id IS NULL OR app.is_current_member(session_id)));
COMMENT ON POLICY app_active_insert ON mood_reading IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON need AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON need IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON need AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON need IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON need_disposition AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON need_disposition IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON need_disposition AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON need_disposition IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_delete ON need_disposition AS RESTRICTIVE FOR DELETE TO app_access USING (app.is_current_member(session_id));
COMMENT ON POLICY app_active_delete ON need_disposition IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON participant_milestone AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON participant_milestone IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON proposal AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON proposal IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON proposal AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON proposal IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON proposal_choice AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON proposal_choice IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON proposal_choice AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(session_id)) WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_update ON proposal_choice IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON proposal_need AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON proposal_need IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_delete ON proposal_need AS RESTRICTIVE FOR DELETE TO app_access USING (app.is_current_member(session_id));
COMMENT ON POLICY app_active_delete ON proposal_need IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON proposal_revision AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK (app.is_current_member(session_id));
COMMENT ON POLICY app_active_insert ON proposal_revision IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON reflection AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK ((linked_session_id IS NULL OR app.is_current_member(linked_session_id)));
COMMENT ON POLICY app_active_insert ON reflection IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON regulation_event AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK ((session_id IS NULL OR app.is_current_member(session_id)));
COMMENT ON POLICY app_active_insert ON regulation_event IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_update ON session AS RESTRICTIVE FOR UPDATE TO app_access USING (app.is_current_member(id)) WITH CHECK (app.is_current_member(id));
COMMENT ON POLICY app_active_update ON session IS 'Writes only by a present participant of the row''s session (review F4).';
CREATE POLICY app_active_insert ON user_memory AS RESTRICTIVE FOR INSERT TO app_access WITH CHECK ((session_id IS NULL OR app.is_current_member(session_id)));
COMMENT ON POLICY app_active_insert ON user_memory IS 'Writes only by a present participant of the row''s session (review F4).';

-- T7c. Diagnostics (work-k5fk.10.30; owner decision 2026-11-17: "diagnostics, no content"). diag_access is the
-- operations bot's capability (login slam_bot_readonly, its only member; infra/aws/roles.sql). It reads, on every
-- row (diag_read, USING (true)), only the columns that carry ids, statuses, kinds, stages, counts, flags and
-- timestamps — chosen by type: uuid7, ts_ms, the integer types, boolean, the enums, milestone_key, schema_version.
-- Never: any text / ciphertext / jsonb / array / bytea column (message, empathy, need, reflection and memory
-- content, names, emails, nicknames, push tokens, notes, model names), the mood and regulation intensities, the
-- reconciler's alignment score, and no column of the key tables (session_key, participant_key, user_key), of
-- user_identity (sign-in subjects) or of app.json_schema. A new column is invisible to the bot until listed here.
-- Review 9c r2 (the owner's least privilege): operational facts only, so also none of a user's private state, not
-- even as an enum or a flag — need / need_share.category, regulation_event (all of it), proposal_choice / consent
-- .decision, empathy_review.validated, reconciler_result's gap_severity / recommended_action /
-- sharing_would_help, session_closure.reason, user_memory.category, feature_state.feature; none of the
-- relationship graph (user_contact, live_session_pair, persona.owner_user_id); and no per-user activity times
-- (user_device.last_seen_at, conversation_read_state.last_active_at, mood_reading.recorded_at).
-- Grants are here rather than next to each table: check-schema.sh applies tables.sql to a cluster that need not
-- have diag_access, and the policy must follow its grant. Plus the migration status the bot reports
-- (_prisma_migrations, which has no RLS: its bookkeeping columns only, when Prisma created it).
DO $$
BEGIN
  IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
    GRANT SELECT (id, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
      ON public._prisma_migrations TO diag_access;
  END IF;
END
$$;

-- agreement
GRANT SELECT (id, session_id, proposal_id, type, status, follow_up_at, completed_at, created_at, updated_at) ON agreement TO diag_access;
CREATE POLICY diag_read ON agreement FOR SELECT TO diag_access USING (true);
-- agreement_party
GRANT SELECT (agreement_id, session_id, user_id, agreed_at, created_at) ON agreement_party TO diag_access;
CREATE POLICY diag_read ON agreement_party FOR SELECT TO diag_access USING (true);
-- ai_memory
GRANT SELECT (id, session_id, user_id, kind, doc_schema_version, created_at, updated_at) ON ai_memory TO diag_access;
CREATE POLICY diag_read ON ai_memory FOR SELECT TO diag_access USING (true);
-- brain_activity
GRANT SELECT (id, session_id, reflection_id, participant_user_id, activity_type, call_type, token_count_input, token_count_output, duration_ms, status, created_at, completed_at, updated_at) ON brain_activity TO diag_access;
CREATE POLICY diag_read ON brain_activity FOR SELECT TO diag_access USING (true);
-- consent
GRANT SELECT (id, session_id, user_id, requested_by_user_id, need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id, decided_at, revoked_at, created_at, updated_at, target_kind) ON consent TO diag_access;
CREATE POLICY diag_read ON consent FOR SELECT TO diag_access USING (true);
-- context_share_offer
GRANT SELECT (id, attempt_id, result_id, session_id, subject_user_id, iteration, status, shared_at, declined_at, offered_at, delivery_status, delivered_at, seen_at, delivery_notified_at, seen_notified_at, created_at, updated_at) ON context_share_offer TO diag_access;
CREATE POLICY diag_read ON context_share_offer FOR SELECT TO diag_access USING (true);
-- conversation
GRANT SELECT (id, session_id, user_id, kind, anchor_kind, anchor_proposal_id, status, resolved_at, next_seq, created_at, updated_at) ON conversation TO diag_access;
CREATE POLICY diag_read ON conversation FOR SELECT TO diag_access USING (true);
-- conversation_read_state
GRANT SELECT (session_id, user_id, last_viewed_at, last_seen_conversation_id, last_seen_seq, last_viewed_share_tab_at, archived_at, created_at, updated_at) ON conversation_read_state TO diag_access;
CREATE POLICY diag_read ON conversation_read_state FOR SELECT TO diag_access USING (true);
-- draft
GRANT SELECT (id, session_id, user_id, kind, about_user_id, attempt_id, share_offer_id, invitation_id, ready_to_share, version, created_at, updated_at, reopened_at) ON draft TO diag_access;
CREATE POLICY diag_read ON draft FOR SELECT TO diag_access USING (true);
-- empathy_attempt
GRANT SELECT (id, session_id, author_user_id, subject_user_id, round, supersedes_attempt_id, status, status_version, submitted_at, revealed_at, delivery_status, delivered_at, seen_at, created_at, updated_at) ON empathy_attempt TO diag_access;
CREATE POLICY diag_read ON empathy_attempt FOR SELECT TO diag_access USING (true);
-- empathy_review
GRANT SELECT (id, attempt_id, session_id, reviewer_user_id, feedback_sent_at, created_at, updated_at) ON empathy_review TO diag_access;
CREATE POLICY diag_read ON empathy_review FOR SELECT TO diag_access USING (true);
-- feature_state
GRANT SELECT (user_id, created_at, updated_at) ON feature_state TO diag_access;
CREATE POLICY diag_read ON feature_state FOR SELECT TO diag_access USING (true);
-- follow_up
GRANT SELECT (id, session_id, agreement_id, proposal_id, type, scope, owner_user_id, opted_in_shared, status, scheduled_for, response_deadline_at, opened_at, completed_at, created_at, updated_at) ON follow_up TO diag_access;
CREATE POLICY diag_read ON follow_up FOR SELECT TO diag_access USING (true);
-- follow_up_checkin
GRANT SELECT (id, follow_up_id, session_id, user_id, next_action, continue_choice, submitted_at, created_at) ON follow_up_checkin TO diag_access;
CREATE POLICY diag_read ON follow_up_checkin FOR SELECT TO diag_access USING (true);
-- follow_up_note
GRANT SELECT (id, session_id, user_id, carry_forward, carried_into_checkin_id, created_at, updated_at) ON follow_up_note TO diag_access;
CREATE POLICY diag_read ON follow_up_note FOR SELECT TO diag_access USING (true);
-- invitation
GRANT SELECT (id, session_id, invited_by_user_id, accepted_by_user_id, status, message_confirmed_at, expires_at, accepted_at, declined_at, created_at, updated_at) ON invitation TO diag_access;
CREATE POLICY diag_read ON invitation FOR SELECT TO diag_access USING (true);
-- message
GRANT SELECT (conversation_id, seq, session_id, sender_user_id, role, kind, dedupe_key, refining_need_id, source_attempt_id, created_at) ON message TO diag_access;
CREATE POLICY diag_read ON message FOR SELECT TO diag_access USING (true);
-- milestone
GRANT SELECT (key, ordinal, scope, self_assertable, created_at, updated_at) ON milestone TO diag_access;
CREATE POLICY diag_read ON milestone FOR SELECT TO diag_access USING (true);
-- mood_reading
GRANT SELECT (id, session_id, user_id, created_at) ON mood_reading TO diag_access;
CREATE POLICY diag_read ON mood_reading FOR SELECT TO diag_access USING (true);
-- need
GRANT SELECT (id, session_id, user_id, confirmed_at, locked_at, superseded_by_need_id, deleted_at, created_at, updated_at) ON need TO diag_access;
CREATE POLICY diag_read ON need FOR SELECT TO diag_access USING (true);
-- need_disposition
GRANT SELECT (need_id, session_id, user_id, status, is_current, created_at, updated_at) ON need_disposition TO diag_access;
CREATE POLICY diag_read ON need_disposition FOR SELECT TO diag_access USING (true);
-- need_share
GRANT SELECT (need_id, session_id, user_id, shared_at, revoked_at, created_at, updated_at) ON need_share TO diag_access;
CREATE POLICY diag_read ON need_share FOR SELECT TO diag_access USING (true);
-- participant
GRANT SELECT (session_id, user_id, kind, added_by_user_id, joined_at, left_at, created_at, updated_at) ON participant TO diag_access;
CREATE POLICY diag_read ON participant FOR SELECT TO diag_access USING (true);
-- participant_milestone
GRANT SELECT (session_id, user_id, milestone_key, reached_at, created_at) ON participant_milestone TO diag_access;
CREATE POLICY diag_read ON participant_milestone FOR SELECT TO diag_access USING (true);
-- persona
GRANT SELECT (user_id, kind, owner_kind, created_at) ON persona TO diag_access;
CREATE POLICY diag_read ON persona FOR SELECT TO diag_access USING (true);
-- proposal
GRANT SELECT (id, session_id, created_by_user_id, source, kind, status, removed_at, removed_by_user_id, shared_at, created_at, updated_at) ON proposal TO diag_access;
CREATE POLICY diag_read ON proposal FOR SELECT TO diag_access USING (true);
-- proposal_choice
GRANT SELECT (proposal_id, session_id, user_id, created_at, updated_at) ON proposal_choice TO diag_access;
CREATE POLICY diag_read ON proposal_choice FOR SELECT TO diag_access USING (true);
-- proposal_need
GRANT SELECT (proposal_id, need_id, session_id, created_at) ON proposal_need TO diag_access;
CREATE POLICY diag_read ON proposal_need FOR SELECT TO diag_access USING (true);
-- proposal_revision
GRANT SELECT (id, proposal_id, session_id, actor_user_id, action, reason, created_at) ON proposal_revision TO diag_access;
CREATE POLICY diag_read ON proposal_revision FOR SELECT TO diag_access USING (true);
-- reconciler_guidance
GRANT SELECT (result_id, session_id, author_user_id, subject_user_id, guidance_type, created_at) ON reconciler_guidance TO diag_access;
CREATE POLICY diag_read ON reconciler_guidance FOR SELECT TO diag_access USING (true);
-- reconciler_result
GRANT SELECT (id, attempt_id, session_id, author_user_id, subject_user_id, iteration, circuit_breaker_tripped, superseded_at, created_at, updated_at) ON reconciler_result TO diag_access;
CREATE POLICY diag_read ON reconciler_result FOR SELECT TO diag_access USING (true);
-- reflection
GRANT SELECT (id, user_id, status, linked_session_id, linked_at, distilled_at, created_at, updated_at) ON reflection TO diag_access;
CREATE POLICY diag_read ON reflection FOR SELECT TO diag_access USING (true);
-- reflection_message
GRANT SELECT (id, reflection_id, role, created_at) ON reflection_message TO diag_access;
CREATE POLICY diag_read ON reflection_message FOR SELECT TO diag_access USING (true);
-- reminder
GRANT SELECT (id, user_id, follow_up_id, session_id, scope, remind_at, cadence, status, created_at, updated_at) ON reminder TO diag_access;
CREATE POLICY diag_read ON reminder FOR SELECT TO diag_access USING (true);
-- session
GRANT SELECT (id, status, topic_frame_confirmed_at, previous_session_id, resolved_at, archived_at, archived_by_user_id, created_at, updated_at) ON session TO diag_access;
CREATE POLICY diag_read ON session FOR SELECT TO diag_access USING (true);
-- session_closure
GRANT SELECT (session_id, kind, closed_by_user_id, check_in_at, closed_at, created_at) ON session_closure TO diag_access;
CREATE POLICY diag_read ON session_closure FOR SELECT TO diag_access USING (true);
-- takeaway
GRANT SELECT (id, reflection_id, source, type, "position", resolved_at, created_at, updated_at) ON takeaway TO diag_access;
CREATE POLICY diag_read ON takeaway FOR SELECT TO diag_access USING (true);
-- takeaway_link
GRANT SELECT (source_id, target_id, link_type, created_at) ON takeaway_link TO diag_access;
CREATE POLICY diag_read ON takeaway_link FOR SELECT TO diag_access USING (true);
-- user
GRANT SELECT (id, kind, deleted_at, created_at, updated_at) ON "user" TO diag_access;
CREATE POLICY diag_read ON "user" FOR SELECT TO diag_access USING (true);
-- user_device
GRANT SELECT (id, user_id, platform, biometric_enabled, biometric_enrolled_at, created_at, updated_at) ON user_device TO diag_access;
CREATE POLICY diag_read ON user_device FOR SELECT TO diag_access USING (true);
-- user_memory
GRANT SELECT (id, user_id, session_id, status, source, created_at, updated_at) ON user_memory TO diag_access;
CREATE POLICY diag_read ON user_memory FOR SELECT TO diag_access USING (true);
-- user_preferences
GRANT SELECT (user_id, doc_schema_version, created_at, updated_at) ON user_preferences TO diag_access;
CREATE POLICY diag_read ON user_preferences FOR SELECT TO diag_access USING (true);

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

  -- Typed domains (owner, 2026-11-23): no table column is plain jsonb — each is typed by a domain named for its
  -- contract (tables.sql, jsonb documents), directly over jsonb (Prisma reads a domain over a domain as
  -- Unsupported), and every such domain's CHECK refuses a non-object.
  SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname) INTO bad
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND (a.atttypid = 'pg_catalog.jsonb'::regtype
         OR (t.typtype = 'd' AND t.typbasetype <> 'pg_catalog.jsonb'::regtype
             AND EXISTS (SELECT 1 FROM pg_catalog.pg_type b WHERE b.oid = t.typbasetype AND b.typtype = 'd'
                           AND b.typbasetype = 'pg_catalog.jsonb'::regtype))
         OR (t.typtype = 'd' AND t.typbasetype = 'pg_catalog.jsonb'::regtype
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.contypid = t.oid AND k.contype = 'c'
                               AND pg_get_constraintdef(k.oid) ~ '(jsonb_typeof\(VALUE\) = ''object''|app\.(jsonb_envelope|activity_metadata)_violation\(VALUE\))')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: jsonb column(s) not typed by a jsonb domain that refuses a non-object: %', bad;
  END IF;

  -- work-k5fk.8 / typed domains: every jsonb-envelope column (its COMMENT says 'jsonb envelope') is typed by a
  -- domain whose CHECK is the envelope rule (app.jsonb_envelope_violation), and no other column is; there are
  -- @@JSONB_ENVELOPES@@ (gen-target-migration.ts JSONB_ENVELOPES; the jest test encryption-at-rest-schema ties the
  -- set to SENSITIVE_FIELD_MAP).
  SELECT string_agg(coalesce(e.col, g.col), ', ' ORDER BY coalesce(e.col, g.col)) INTO bad
  FROM (SELECT c.relname || '.' || a.attname AS col
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
        JOIN pg_catalog.pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_catalog.pg_class'::regclass AND d.objsubid = a.attnum
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND d.description ~ '^encrypted \([a-z-]+\): jsonb envelope') e
  FULL JOIN (SELECT c.relname || '.' || a.attname AS col
             FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
             JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
             WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
               AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_depend dp
                             ON dp.classid = 'pg_catalog.pg_constraint'::regclass AND dp.objid = k.oid
                            AND dp.refclassid = 'pg_catalog.pg_proc'::regclass
                            AND dp.refobjid = 'app.jsonb_envelope_violation(jsonb)'::regprocedure
                           WHERE k.contypid = a.atttypid AND k.contype = 'c')) g ON g.col = e.col
  WHERE e.col IS NULL OR g.col IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: jsonb envelope column(s) and envelope-domain columns differ: %', bad; END IF;
  SELECT count(*) INTO n
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.contypid = a.atttypid AND k.conname = 'jsonb_envelope');
  IF n IS DISTINCT FROM @@JSONB_ENVELOPES@@ THEN RAISE EXCEPTION 'step 20: % envelope-domain columns, expected @@JSONB_ENVELOPES@@', n; END IF;
  -- and no table CHECK echoes a refused document's row: the rules are the domains' alone (a domain CHECK refusal
  -- names the domain and the constraint, with no DETAIL).
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ') INTO bad FROM pg_catalog.pg_constraint
  WHERE contype = 'c' AND conrelid <> 0 AND pg_get_constraintdef(oid) ~ '(jsonb_envelope|activity_metadata)';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: envelope / metadata table CHECK(s) (their DETAIL echoes the row): %', bad; END IF;
  -- the trigger the domains replaced is gone
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 't_jsonb_envelope')
     OR to_regprocedure('app.t_jsonb_envelope()') IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: t_jsonb_envelope is back (the envelope domains replaced it)';
  END IF;

  -- work-k5fk.8: t_doc_schema validates exactly user_preferences and ai_memory, each with a
  -- doc_schema_version (the version-1 schema of every name the trigger can derive: T7a, read before FORCE).
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE t.tgname = 't_doc_schema';
  IF bad IS DISTINCT FROM 'ai_memory, user_preferences' THEN RAISE EXCEPTION 'step 20: t_doc_schema on %, expected ai_memory, user_preferences', bad; END IF;
  SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO bad FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'doc_schema_version';
  IF bad IS DISTINCT FROM 'ai_memory, user_preferences' THEN RAISE EXCEPTION 'step 20: doc_schema_version on %, expected ai_memory, user_preferences', bad; END IF;

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
  -- columns typed ciphertext and @@CIPHERTEXT_ARRAYS@@ text[] columns typed
  -- ciphertext_list. The jest test encryption-at-rest-schema ties both sets
  -- to the map by name; these counts catch a retype here.
  SELECT count(*) INTO n
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'public.ciphertext'::regtype;
  IF n <> @@CIPHERTEXT_COLUMNS@@ THEN RAISE EXCEPTION 'step 20: % ciphertext columns, expected @@CIPHERTEXT_COLUMNS@@', n; END IF;
  SELECT count(*) INTO n
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'public.ciphertext_list'::regtype;
  IF n <> @@CIPHERTEXT_ARRAYS@@ THEN RAISE EXCEPTION 'step 20: % ciphertext_list columns, expected @@CIPHERTEXT_ARRAYS@@', n; END IF;

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

  -- Views are security_invoker, in every schema that is not PostgreSQL's own (review 9c F4), and there is no
  -- materialized view: it stores rows its readers get with no row-level security at all.
  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_(toast|temp_|toast_temp_)'
    AND ((c.relkind = 'v' AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)) OR c.relkind = 'm');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: view(s) without security_invoker, or materialized view(s): %', bad; END IF;

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
  -- their one capability each: grants target the capability, the login only inherits them. mwf_job and its interim
  -- job_access are retired (work-k5fk.10.5, §7 row 9b). Roles are cluster-level (infra/aws/roles.sql, init-db.sh), so
  -- these read the cluster as the migration finds it and refuse a baseline over a cluster that drifted.
  DECLARE
    -- slam_bot_readonly / diag_access: the operations bot (work-k5fk.10.30, T7c).
    v_logins CONSTANT text[] := ARRAY['mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth', 'mwf_clinician',
                                      'slam_bot_readonly'];
    v_caps   CONSTANT text[] := ARRAY['app_access', 'ai_access', 'worker_access', 'ops_access', 'auth_access',
                                      'clinician_access', 'diag_access'];
    -- LOGIN or not: the bot logs in where it is deployed (production), and exists NOLOGIN elsewhere (roles.sql).
    v_either CONSTANT text[] := ARRAY['slam_bot_readonly'];
    -- Reserved (review 9a F4): NOLOGIN until the clinician portal (Q18) uses it. mwf_ai and mwf_worker log in since
    -- §7 row 9b gave them their call sites.
    v_reserved CONSTANT text[] := ARRAY['mwf_clinician'];
    v_reserved_caps CONSTANT text[] := ARRAY['clinician_access'];
    -- What the definer bodies write (T4/T5; review 9a F3): mwf_definer's INSERT / UPDATE / DELETE grants, exactly.
    -- Reads are pinned by app-grants.target.test.ts's privilege matrix; a write beyond these widens what a
    -- definer bug, or an injection into one, can change.
    v_definer_writes CONSTANT text[] := ARRAY[
      'ai_memory:DELETE', 'brain_activity:DELETE', 'consent:UPDATE', 'conversation:DELETE', 'conversation:UPDATE',
      'conversation_read_state:DELETE', 'draft:DELETE', 'draft:INSERT', 'empathy_attempt:DELETE', 'empathy_attempt:INSERT',
      'empathy_attempt:UPDATE', 'feature_state:DELETE', 'invitation:UPDATE', 'follow_up_checkin:DELETE', 'follow_up_note:DELETE',
      'context_share_offer:UPDATE',
      'live_session_pair:DELETE', 'live_session_pair:INSERT', 'message:INSERT', 'mood_reading:DELETE', 'need:DELETE',
      'need_disposition:DELETE', 'need_share:INSERT', 'need_share:UPDATE', 'participant:UPDATE',
      'participant_milestone:DELETE', 'participant_milestone:INSERT',
      'participant_key:UPDATE', 'proposal_choice:DELETE', 'reflection:DELETE', 'regulation_event:DELETE',
      'reminder:DELETE', 'session:UPDATE', 'user:INSERT', 'user:UPDATE', 'user_contact:DELETE', 'user_device:DELETE',
      'user_identity:DELETE', 'user_identity:INSERT', 'user_key:UPDATE', 'user_memory:DELETE',
      'user_preferences:DELETE'];
  BEGIN

  -- work-k5fk.10.5 (§7 row 9b, Q13): mwf_job — once the AI's writer, the two-party writer and the definer owner at once —
  -- and its interim capability job_access are gone from the cluster; infra/aws/roles.sql retires them.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO bad FROM pg_roles r WHERE r.rolname IN ('mwf_job', 'job_access');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: retired role(s) still exist: % (infra/aws/roles.sql retires them; work-k5fk.10.5)', bad;
  END IF;

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
  WHERE (lr.rolcanlogin = (l.login = ANY (v_reserved)) AND NOT l.login = ANY (v_either))
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
  -- (directly or inherited). The database's own ACL (T7a; review 9a r3 L2, work-k5fk.10.6): a runtime login holds no
  -- entry of its own, an active capability exactly CONNECT, clinician_access and mwf_definer nothing.
  SELECT string_agg(DISTINCT r.rolname, ', ') INTO bad
  FROM pg_roles r
  WHERE r.rolname IN (SELECT unnest(v_logins || v_caps) UNION ALL SELECT 'mwf_definer')
    AND (has_database_privilege(r.oid, current_database(), 'CREATE')
         OR has_schema_privilege(r.oid, 'public', 'CREATE') OR has_schema_privilege(r.oid, 'app', 'CREATE')
         OR ARRAY(SELECT a.privilege_type::text FROM pg_database d, aclexplode(d.datacl) a
                  WHERE d.datname = current_database() AND a.grantee = r.oid ORDER BY 1)
            IS DISTINCT FROM CASE WHEN r.rolname = ANY (v_caps) AND NOT r.rolname = ANY (v_reserved_caps)
                                  THEN ARRAY['CONNECT'] ELSE ARRAY[]::text[] END);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: role(s) that may CREATE in the database or schema public/app, or whose database ACL entry is not exactly CONNECT for an active capability and nothing otherwise: %', bad;
  END IF;
  -- And nobody else (review 9c F4): the database's ACL names only its owner and the active capabilities — not
  -- PUBLIC (grantee 0: no CONNECT, no TEMPORARY), no login, no other role. An unset ACL is PostgreSQL's default,
  -- which grants PUBLIC both.
  SELECT CASE WHEN d.datacl IS NULL THEN 'PUBLIC: the default ACL (CONNECT, TEMPORARY)'
              ELSE (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                                      || ' ' || a.privilege_type, ', ' ORDER BY 1)
                    FROM aclexplode(d.datacl) a
                    WHERE a.grantee <> d.datdba
                      AND NOT (pg_get_userbyid(a.grantee) = ANY (v_caps) AND NOT pg_get_userbyid(a.grantee) = ANY (v_reserved_caps)
                               AND a.privilege_type = 'CONNECT')) END
  INTO bad FROM pg_database d WHERE d.datname = current_database();
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: database ACL entries beyond the owner and the capabilities'' CONNECT: %', bad; END IF;

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

  -- clinician_access holds nothing until the consent model exists (Q18). Read over the whole catalog of this database.
  SELECT string_agg(DISTINCT pg_get_userbyid(x.grantee), ', ') INTO bad FROM (
    SELECT a.grantee FROM pg_namespace s, aclexplode(s.nspacl) a
    UNION ALL SELECT a.grantee FROM pg_class c, aclexplode(c.relacl) a
    UNION ALL SELECT a.grantee FROM pg_attribute att, aclexplode(att.attacl) a
    UNION ALL SELECT a.grantee FROM pg_proc p, aclexplode(p.proacl) a
    UNION ALL SELECT a.grantee FROM pg_type t, aclexplode(t.typacl) a) x
  WHERE pg_get_userbyid(x.grantee) IN ('clinician_access');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: role(s) that hold nothing yet hold a privilege: %', bad; END IF;

  -- work-k5fk.10.4.1: t_doc_schema runs with the writer's rights, so every role that may fire it (INSERT on the
  -- table, or UPDATE of a column the trigger names) can run the validator it calls — or its first write fails inside
  -- the trigger. The table's owner, superusers and the predefined pg_* roles (pg_write_all_data writes everything and
  -- is granted to no one: the role guard refuses any membership but the capability) are exempt.
  SELECT string_agg(DISTINCT r.rolname || ' on ' || c.relname, ', ') INTO bad
  FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid CROSS JOIN pg_roles r
  WHERE tg.tgname = 't_doc_schema' AND NOT r.rolsuper AND NOT pg_has_role(r.oid, c.relowner, 'USAGE')
    AND r.rolname !~ '^pg_'
    AND (has_any_column_privilege(r.oid, c.oid, 'INSERT')
         OR EXISTS (SELECT 1 FROM unnest(tg.tgattr::int2[]) a(attnum) WHERE has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE')))
    AND NOT (has_schema_privilege(r.oid, 'app', 'USAGE') AND has_table_privilege(r.oid, 'app.json_schema', 'SELECT')
             AND has_function_privilege(r.oid, 'app.jsonb_violation(jsonb, text, public.schema_version)', 'EXECUTE'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: role(s) that may write a validated column but cannot run its validator: %', bad;
  END IF;
  -- Typed domains (owner, 2026-11-23): a domain CHECK also runs with the writer's rights, and an INSERT that leaves a
  -- domain column to its default (or NULL) runs it too. So every role that may INSERT into a table with a column of
  -- such a domain, or UPDATE that column, may EXECUTE each function the domain's CHECKs call (pg_depend: the
  -- envelope domains' app.jsonb_envelope_violation, activity_metadata_json_schema's app.activity_metadata_violation,
  -- ciphertext_list's app.all_ciphertext). Same exemptions.
  SELECT string_agg(DISTINCT r.rolname || ' on ' || c.relname || '.' || a.attname || ' (' || dp.refobjid::regprocedure::text || ')', ', ') INTO bad
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
  JOIN pg_catalog.pg_constraint k ON k.contypid = a.atttypid AND k.contype = 'c'
  JOIN pg_catalog.pg_depend dp ON dp.classid = 'pg_catalog.pg_constraint'::regclass AND dp.objid = k.oid
                              AND dp.refclassid = 'pg_catalog.pg_proc'::regclass
  CROSS JOIN pg_roles r
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND NOT r.rolsuper AND NOT pg_has_role(r.oid, c.relowner, 'USAGE') AND r.rolname !~ '^pg_'
    AND (has_any_column_privilege(r.oid, c.oid, 'INSERT') OR has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE'))
    AND NOT has_function_privilege(r.oid, dp.refobjid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: role(s) that may write a domain column but cannot run its CHECK''s function: %', bad;
  END IF;

  -- work-k5fk.10.5 review F4: every write the AI or the worker holds is bound to its session by a t_session_scope
  -- trigger naming that capability, for that event — or is one of the worker's cross-session writes named here
  -- (retention, due follow-ups and reminders, push-token clean-up, and the purge, which t_session_purge binds to
  -- ARCHIVED sessions). A grant added without its trigger, or a trigger dropped, refuses the baseline.
  DECLARE
    v_scope_exempt CONSTANT text[] := ARRAY[
      'worker_access:brain_activity:UPDATE', 'worker_access:brain_activity:DELETE',
      'worker_access:follow_up:UPDATE', 'worker_access:reminder:UPDATE', 'worker_access:user_device:UPDATE',
      'worker_access:session:DELETE'];
  BEGIN
    SELECT string_agg(w.cap || ':' || w.rel || ':' || w.ev, ', ' ORDER BY w.cap, w.rel, w.ev) INTO bad
    FROM (
      SELECT DISTINCT r.rolname::text AS cap, c.relname::text AS rel, e.ev, e.bit, c.oid AS reloid
      FROM pg_roles r
      CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('INSERT', 4), ('DELETE', 8), ('UPDATE', 16)) e(ev, bit)
      WHERE r.rolname IN ('ai_access', 'worker_access') AND n.nspname = 'public' AND c.relkind = 'r'
        AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = r.oid AND a.privilege_type = e.ev)
             OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                        WHERE att.attrelid = c.oid AND a.grantee = r.oid AND a.privilege_type = e.ev))
    ) w
    WHERE NOT (w.cap || ':' || w.rel || ':' || w.ev = ANY (v_scope_exempt))
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = w.reloid AND NOT tg.tgisinternal AND tg.tgfoid = 'app.t_session_scope()'::regprocedure
          AND (tg.tgtype & w.bit) <> 0
          AND position(quote_literal(w.cap) IN pg_get_triggerdef(tg.oid)) > 0);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'step 20: AI / worker write(s) with no t_session_scope trigger for the event (capability:table:event): %', bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.session'::regclass
                   AND tg.tgfoid = 'app.t_session_purge()'::regprocedure AND (tg.tgtype & 8) <> 0) THEN
      RAISE EXCEPTION 'step 20: the worker''s DELETE of session is not bound to ARCHIVED sessions (t_session_purge)';
    END IF;
  END;

  -- The message counter moves only through app.next_message_seq (work-k5fk.4): no role but its owner mwf_definer
  -- (and the table's owner) may UPDATE conversation.next_seq.
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO bad
  FROM pg_roles r JOIN pg_class c ON c.oid = 'public.conversation'::regclass
  WHERE NOT r.rolsuper AND r.rolname <> 'mwf_definer' AND r.rolname !~ '^pg_' AND NOT pg_has_role(r.oid, c.relowner, 'USAGE')
    AND has_column_privilege(r.oid, c.oid, 'next_seq', 'UPDATE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: role(s) other than mwf_definer that may UPDATE conversation.next_seq: %', bad; END IF;

  -- Row-level security (work-k5fk.10.6; §6 layer 3, Q8; T7b). Every table in public / app has it ENABLED and FORCED
  -- (the owner is held to the policies too) — all but _prisma_migrations, Prisma's bookkeeping, which no runtime role
  -- or capability may hold any privilege on.
  SELECT string_agg(c.oid::regclass::text, ', ' ORDER BY c.oid::regclass::text) INTO bad
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_(toast|temp_|toast_temp_)' AND c.relkind IN ('r', 'p', 'f')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    AND NOT (s.nspname = 'public' AND c.relname = '_prisma_migrations');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: table(s) without row-level security enabled and forced: %', bad; END IF;
  -- _prisma_migrations has no RLS: only diag_access may read it, and only its bookkeeping columns (T7c).
  SELECT string_agg(DISTINCT r.rolname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r
  WHERE n.nspname = 'public' AND c.relname = '_prisma_migrations'
    AND r.rolname IN (SELECT unnest(v_logins || v_caps) UNION ALL SELECT 'mwf_definer')
    AND (has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
         OR has_any_column_privilege(r.oid, c.oid, 'INSERT, UPDATE, REFERENCES')
         OR (NOT pg_has_role(r.oid, 'diag_access', 'USAGE') AND has_any_column_privilege(r.oid, c.oid, 'SELECT'))
         OR has_column_privilege(r.oid, c.oid, 'checksum', 'SELECT') OR has_column_privilege(r.oid, c.oid, 'logs', 'SELECT'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: role(s) with a privilege on _prisma_migrations (it has no RLS): %', bad; END IF;
  -- TRUNCATE ignores row-level security: no runtime login, capability or mwf_definer holds it anywhere (review 9c F4).
  SELECT string_agg(DISTINCT r.rolname || ' ' || c.oid::regclass::text, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace CROSS JOIN pg_roles r
  WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_(toast|temp_|toast_temp_)' AND c.relkind IN ('r', 'p', 'f')
    AND r.rolname IN (SELECT unnest(v_logins || v_caps) UNION ALL SELECT 'mwf_definer')
    AND has_table_privilege(r.oid, c.oid, 'TRUNCATE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: role(s) that may TRUNCATE (RLS does not apply to it): %', bad; END IF;
  -- Every command a capability or mwf_definer holds on a table (table- or column-level grant) is covered by a
  -- permissive policy naming that role for that command or ALL: under FORCE a grant with no policy is dead, and a
  -- grant added later must come with its policy (capability:table:command).
  SELECT string_agg(w.role || ':' || w.rel || ':' || w.cmd, ', ' ORDER BY w.role, w.rel, w.cmd) INTO bad
  FROM (
    SELECT DISTINCT r.oid AS roleoid, r.rolname::text AS role, c.oid AS reloid, c.oid::regclass::text AS rel, e.cmd, e.code
    FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('SELECT', 'r'), ('INSERT', 'a'), ('UPDATE', 'w'), ('DELETE', 'd')) e(cmd, code)
    WHERE r.rolname IN (SELECT unnest(v_caps) UNION ALL SELECT 'mwf_definer')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_|toast_temp_)'
      AND c.relkind IN ('r', 'p', 'f') AND NOT (n.nspname = 'public' AND c.relname = '_prisma_migrations')
      AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = r.oid AND a.privilege_type = e.cmd)
           OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                      WHERE att.attrelid = c.oid AND a.grantee = r.oid AND a.privilege_type = e.cmd))
  ) w
  WHERE NOT EXISTS (SELECT 1 FROM pg_policy pol
                    WHERE pol.polrelid = w.reloid AND pol.polpermissive AND w.roleoid = ANY (pol.polroles)
                      AND pol.polcmd IN ('*', w.code::"char"));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'step 20: grant(s) with no policy for that command (capability:table:command): %', bad;
  END IF;
  -- Policies name capabilities or mwf_definer, never PUBLIC, a login or the owner (Q16).
  SELECT string_agg(pol.polname || ' ON ' || pol.polrelid::regclass::text, ', ' ORDER BY pol.polname, pol.polrelid::regclass::text) INTO bad
  FROM pg_policy pol
  WHERE EXISTS (SELECT 1 FROM unnest(pol.polroles) x(oid)
                WHERE x.oid = 0 OR pg_get_userbyid(x.oid) NOT IN (SELECT unnest(v_caps) UNION ALL SELECT 'mwf_definer'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: policy(ies) for a role other than a capability or mwf_definer: %', bad; END IF;
  END;

  -- work-k5fk.4 (k5fk.21, .23): the column-list SET NULL keys, which Prisma reads as plain SetNull — so the
  -- drift gate passes a full SET NULL (that would null session_id, NOT NULL) and only this catches it.
  SELECT string_agg(w.want, '; ') INTO bad
  FROM (VALUES ('message', 'need', '{refining_need_id}'),
               ('message', 'empathy_attempt', '{source_attempt_id}'),
               ('conversation_read_state', 'message', '{last_seen_conversation_id,last_seen_seq}'),
               -- work-k5fk.9 (C1, C2, C5, C6, C3)
               ('conversation', 'proposal', '{anchor_proposal_id}'),
               ('empathy_attempt', 'empathy_attempt', '{supersedes_attempt_id}'),
               ('follow_up_note', 'follow_up_checkin', '{carried_into_checkin_id}'),
               ('reflection', 'participant', '{linked_session_id}'),
               ('need', 'need', '{superseded_by_need_id}')) x(rel, ref, cols),
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

END
$$;
