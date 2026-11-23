-- ============================================================================
-- functions-caller-tests.sql — the app.* writers and triggers, exercised per
-- caller (TS-7 fix round 1; re-based on the target_shape_baseline by TS-7c,
-- OD7). Run by run-baseline.sh on a throwaway clone of a ts7_* database that
-- the baseline built and seed-target-fixture.sql seeded (it changes data);
-- run-baseline.sh adds test 18 (a second migrate deploy is a no-op), which
-- needs the Prisma CLI. Every caller arm runs in a session that LOGGED
-- IN as mwf_app, mwf_ai, mwf_worker or mwf_auth (\connect), never as the superuser (20, the
-- structural key checks, run as the superuser by design); identity is
-- set_config('app.current_user_id', <user>, true), as the request layer does.
--
-- Setup (superuser, before any caller arm): ids via \gset. mwf_app holds only
-- the baseline's own grants (tables.sql, work-k5fk.10.2), so a caller arm
-- that writes as mwf_app proves the grant as well as the function or trigger.
-- An expected refusal is caught by its SQLSTATE and logged PASS; anything else
-- (or a refusal that does not happen: 'TEST FAILED') stops the run. Most
-- refusals come from the function or trigger under test; 6a–6d (mwf_ai's
-- narrowed column grants) are grant refusals, by design. mwf_job is retired
-- (work-k5fk.10.5): the AI's arms run as mwf_ai with app.session_scope set,
-- the worker's as mwf_worker; 17 and 24 call as mwf_app via SET SESSION AUTHORIZATION.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
\pset tuples_only on
DO $$
BEGIN
  IF current_database() !~ '^ts7_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'functions-caller-tests.sql only runs on a ts7_* scratch database, not %', current_database();
  END IF;
END
$$;

-- ---- setup (superuser) --------------------------------------------------------
-- No setup GRANT (work-k5fk.10.2): mwf_app runs on the baseline's own grants (tables.sql).
-- Rows from seed-target-fixture.sql: session S (A, B; A→B AWAITING_SHARING,
-- B→A HELD), session X (C, D; shared needs e1 of C and e4 of D), an outsider.
SELECT u.id AS a_user FROM "user" u WHERE u.email = 'a@ts7c.test' \gset
SELECT u.id AS b_user FROM "user" u WHERE u.email = 'b@ts7c.test' \gset
SELECT u.id AS outsider FROM "user" u WHERE u.email = 'outsider@ts7c.test' \gset
SELECT p.session_id AS r_session FROM participant p WHERE p.user_id = :'a_user' LIMIT 1 \gset
SELECT a.id AS att_a FROM empathy_attempt a WHERE a.author_user_id = :'a_user' AND a.session_id = :'r_session' \gset
SELECT a.id AS att_b FROM empathy_attempt a WHERE a.author_user_id = :'b_user' AND a.session_id = :'r_session' \gset
\set c_user '00000000-0000-7e00-8000-0000000000c1'
\set d_user '00000000-0000-7e00-8000-0000000000d1'
\set x_session '00000000-0000-7e00-8000-0000000005e1'
\set n1 '00000000-0000-7e00-8000-0000000000e1'
\set n4 '00000000-0000-7e00-8000-0000000000e4'
SELECT format('setup: session %s; A attempt %s (%s), B attempt %s (%s)', :'r_session',
              :'att_a', (SELECT status FROM empathy_attempt WHERE id = :'att_a'),
              :'att_b', (SELECT status FROM empathy_attempt WHERE id = :'att_b'));
-- The ids go into the DO blocks through session settings (psql does not
-- interpolate inside $$ … $$); the line is repeated after every \connect.

-- ============================ as mwf_app ======================================
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null

-- 1. the SUBJECT cannot move the author's attempt (A is B's subject; B's attempt is HELD)
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'READY');
    RAISE EXCEPTION 'TEST FAILED: the subject moved the author''s attempt';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 1 subject cannot move the author''s attempt HELD→READY: %', SQLERRM;
  END;
END $$;

-- 2. the AUTHOR moves their own attempt HELD → READY (the stage2.ts in-request writer)
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'READY');
  IF (SELECT status FROM empathy_attempt WHERE id = current_setting('t.att_b')::uuid) <> 'READY' THEN
    RAISE EXCEPTION 'TEST FAILED: author move did not land';
  END IF;
  RAISE NOTICE 'PASS 2 author moves own attempt HELD→READY';
END $$;

-- 3. a non-member can neither move nor see anything of the session
DO $$ DECLARE n int; BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'READY');
    RAISE EXCEPTION 'TEST FAILED: a non-member moved an attempt';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 3a non-member cannot move an attempt: %', SQLERRM;
  END;
  SELECT count(*) INTO n FROM v_empathy_direction_status v WHERE v.session_id = current_setting('t.r_session')::uuid;
  IF n <> 0 OR app.is_member(current_setting('t.r_session')::uuid) THEN
    RAISE EXCEPTION 'TEST FAILED: a non-member sees the session (% direction rows)', n;
  END IF;
  RAISE NOTICE 'PASS 3b non-member sees no direction status and is not a member';
END $$;

-- 4. only the AI reveals: the author of a READY attempt cannot
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'REVEALED');
    RAISE EXCEPTION 'TEST FAILED: the author revealed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 4 the author cannot reveal READY→REVEALED: %', SQLERRM;
  END;
END $$;

-- ============================ as mwf_ai =======================================
\connect - mwf_ai
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null
-- The AI's arm needs the session in app.session_scope (work-k5fk.10.5, Q20); session-wide here, transaction-local in the app.
SELECT set_config('app.session_scope', :'r_session', false) \g /dev/null
-- …and its acting user (the request's identity, bound on the AI connection too) must be a participant of it
-- (work-k5fk.10.7: the ai_session policies' app.scope_actor_is_member()).
SELECT set_config('app.current_user_id', :'a_user', false) \g /dev/null

-- 5a. the AI arm needs the scope: with another session's scope the attempt is not found to it
DO $$ BEGIN
  PERFORM set_config('app.session_scope', '00000000-0000-7e00-8000-0000000005e1', true);
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'REVEALED');
    RAISE EXCEPTION 'TEST FAILED: the AI moved an attempt outside its scope';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 5a the AI cannot move an attempt of another session than its scope: %', SQLERRM;
  END;
END $$;

-- 5. the reveal gate: B→A is READY but A→B is AWAITING_SHARING → refused
DO $$ BEGIN
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'REVEALED');
    RAISE EXCEPTION 'TEST FAILED: revealed before every direction was READY';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 5 reveal refused until every direction is READY: %', SQLERRM;
  END;
END $$;

-- 6. the AI's narrowed privileges (C3): no routing-column UPDATE, no U-class reads
DO $$ BEGIN
  BEGIN
    UPDATE participant SET user_id = user_id
    WHERE session_id = current_setting('t.r_session')::uuid AND user_id = current_setting('t.b_user')::uuid;
    RAISE EXCEPTION 'TEST FAILED: mwf_ai updated participant.user_id';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6a mwf_ai cannot UPDATE participant.user_id: %', SQLERRM;
  END;
  BEGIN
    UPDATE empathy_attempt SET author_user_id = author_user_id WHERE id = current_setting('t.att_a')::uuid;
    RAISE EXCEPTION 'TEST FAILED: mwf_ai updated empathy_attempt.author_user_id';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6b mwf_ai cannot UPDATE empathy_attempt.author_user_id: %', SQLERRM;
  END;
  BEGIN
    PERFORM title FROM reflection LIMIT 1;
    RAISE EXCEPTION 'TEST FAILED: mwf_ai read reflection.title';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6c mwf_ai cannot read reflection content: %', SQLERRM;
  END;
  BEGIN
    PERFORM content FROM user_memory LIMIT 1;
    RAISE EXCEPTION 'TEST FAILED: mwf_ai read user_memory.content';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6d mwf_ai cannot read user_memory content: %', SQLERRM;
  END;
END $$;

-- ============================ as mwf_app ======================================
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null
-- 7. the AUTHOR moves own AWAITING_SHARING → READY
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'READY');
  RAISE NOTICE 'PASS 7 author moves own attempt AWAITING_SHARING→READY';
END $$;

-- ============================ as mwf_ai =======================================
\connect - mwf_ai
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null
-- The AI's arm needs the session in app.session_scope (work-k5fk.10.5, Q20); session-wide here, transaction-local in the app.
SELECT set_config('app.session_scope', :'r_session', false) \g /dev/null
-- …and its acting user (the request's identity, bound on the AI connection too) must be a participant of it
-- (work-k5fk.10.7: the ai_session policies' app.scope_actor_is_member()).
SELECT set_config('app.current_user_id', :'a_user', false) \g /dev/null
-- 8. the AI reveals both; the subject's conversation gains exactly one copy, even when the reveal is repeated
DO $$ DECLARE n int; BEGIN
  PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'REVEALED');
  PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'REVEALED');
  PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'REVEALED');
  SELECT count(*) INTO n FROM message m JOIN conversation c ON c.id = m.conversation_id
  WHERE c.session_id = current_setting('t.r_session')::uuid AND c.user_id = current_setting('t.b_user')::uuid AND m.kind = 'EMPATHY_STATEMENT'
    AND m.source_attempt_id = current_setting('t.att_a')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'TEST FAILED: % delivered copies in the subject''s conversation', n; END IF;
  RAISE NOTICE 'PASS 8 the AI reveals once all directions are READY; subject''s conversation holds exactly 1 copy (after a repeated reveal)';
END $$;

-- ============================ as mwf_app ======================================
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null
-- 9. the AUTHOR cannot validate their own revealed attempt; the SUBJECT can
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'VALIDATED');
    RAISE EXCEPTION 'TEST FAILED: the author validated their own attempt';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 9a author cannot VALIDATE own REVEALED attempt: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'VALIDATED');
  RAISE NOTICE 'PASS 9b subject VALIDATEs the REVEALED attempt';
END $$;

-- 10. resubmission: by the author → round n+1 (a retry returns the same id); by the subject → refused
DO $$ DECLARE v_new uuid; v_retry uuid; v_round int; BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  v_new := app.empathy_set_status(current_setting('t.att_b')::uuid, 'SUPERSEDED', 'second round');
  v_retry := app.empathy_set_status(current_setting('t.att_b')::uuid, 'SUPERSEDED', 'second round');
  SELECT round INTO v_round FROM empathy_attempt WHERE id = v_new;
  IF v_new = current_setting('t.att_b')::uuid OR v_retry <> v_new OR v_round <> 2 THEN
    RAISE EXCEPTION 'TEST FAILED: resubmit new=% retry=% round=%', v_new, v_retry, v_round;
  END IF;
  RAISE NOTICE 'PASS 10a author resubmits → round 2, retried call returns the same id';
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  BEGIN
    PERFORM app.empathy_set_status(v_new, 'SUPERSEDED', 'not mine');
    RAISE EXCEPTION 'TEST FAILED: the subject resubmitted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 10b subject cannot resubmit: %', SQLERRM;
  END;
END $$;

-- 11. need_revoke_share: the partner and nobody cannot; the owner can
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.need_revoke_share('00000000-0000-7e00-8000-0000000000e4');
    RAISE EXCEPTION 'TEST FAILED: the partner revoked a share';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 11a partner cannot revoke the owner''s share: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '', true);
  BEGIN
    PERFORM app.need_revoke_share('00000000-0000-7e00-8000-0000000000e4');
    RAISE EXCEPTION 'TEST FAILED: no identity revoked a share';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 11b no identity cannot revoke: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000d1', true);
  PERFORM app.need_revoke_share('00000000-0000-7e00-8000-0000000000e4');
  IF (SELECT revoked_at FROM need_share WHERE need_id = '00000000-0000-7e00-8000-0000000000e4') IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED: owner revoke did not land';
  END IF;
  RAISE NOTICE 'PASS 11c owner revokes the share (need_share.revoked_at set, consent REVOKED)';
END $$;

-- 12e. anonymize_* are mwf_app's since work-k5fk.10.5 (account-deletion.ts / session-deletion.ts run on the
--      user's own request): 12a–d, 13a, 15, 17 and 24 test their own identity checks. mwf_app still cannot
--      resolve or create a user (mwf_auth's).
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.resolve_user('clerk', 'user_ts7cAda');
    RAISE EXCEPTION 'TEST FAILED: mwf_app ran resolve_user';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 12g resolve_user is mwf_auth''s, not mwf_app''s: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.create_user('clerk', 'user_ts7cMallory', 'mallory@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: mwf_app ran create_user';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 12h create_user is mwf_auth''s, not mwf_app''s: %', SQLERRM;
  END;
END $$;

-- 21. work-bp5m: mwf_app can neither see nor write a sign-in identity, nor write an
--     email, a kind or a user row — the grants the work-jv9y re-bind needed are gone.
--     The profile edit (names) still works.
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM user_identity;
    RAISE EXCEPTION 'TEST FAILED: mwf_app read user_identity';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21a mwf_app cannot read user_identity: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_ts7cMallory', '00000000-0000-7e00-8000-0000000000a1');
    RAISE EXCEPTION 'TEST FAILED: mwf_app inserted a user_identity';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21b mwf_app cannot attach an identity to a user: %', SQLERRM;
  END;
  BEGIN
    UPDATE user_identity SET user_id = '00000000-0000-7e00-8000-0000000000b1' WHERE subject = 'user_ts7cAda';
    RAISE EXCEPTION 'TEST FAILED: mwf_app re-bound a user_identity';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21c mwf_app cannot re-bind an identity: %', SQLERRM;
  END;
  BEGIN
    DELETE FROM user_identity WHERE subject = 'user_ts7cAda';
    RAISE EXCEPTION 'TEST FAILED: mwf_app deleted a user_identity';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21d mwf_app cannot delete an identity: %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET email = 'mallory@ts7c.test' WHERE id = '00000000-0000-7e00-8000-0000000000a1';
    RAISE EXCEPTION 'TEST FAILED: mwf_app updated user.email';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21e mwf_app cannot UPDATE user.email: %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET kind = 'persona' WHERE id = '00000000-0000-7e00-8000-0000000000a1';
    RAISE EXCEPTION 'TEST FAILED: mwf_app updated user.kind';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21f mwf_app cannot UPDATE user.kind: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO "user" (email) VALUES ('mallory@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: mwf_app inserted a user';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21g mwf_app cannot INSERT a user: %', SQLERRM;
  END;
  BEGIN
    PERFORM 1 FROM persona;
    RAISE EXCEPTION 'TEST FAILED: mwf_app read persona';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 21h mwf_app holds nothing on persona: %', SQLERRM;
  END;
END $$;
BEGIN;
DO $$ BEGIN
  -- work-k5fk.10.7: the names are the caller's own row ("user" app_update): B edits nothing of A's.
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  UPDATE "user" SET first_name = 'Mallory' WHERE id = '00000000-0000-7e00-8000-0000000000a1';
  IF FOUND THEN RAISE EXCEPTION 'TEST FAILED: B edited A''s names'; END IF;
  RAISE NOTICE 'PASS 21j another user''s names are not the caller''s to edit (no row)';
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a1', true);
  UPDATE "user" SET first_name = 'Ada B.' WHERE id = '00000000-0000-7e00-8000-0000000000a1';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST FAILED: the profile edit updated no row'; END IF;
  RAISE NOTICE 'PASS 21i mwf_app still edits the names (profile edit)';
END $$;
ROLLBACK;

-- 12. anonymize_*: no identity, another user → not found; a modeled-style NULL comparison never passes
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '', true);
  BEGIN
    PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000d1');
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_account with no identity';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 12a anonymize_user_account with no identity: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.anonymize_user_in_session('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1');
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_in_session with no identity';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 12b anonymize_user_in_session with no identity: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000d1');
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_account of another user';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 12c anonymize_user_account of another user: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.anonymize_user_in_session('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1');
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_in_session of another user';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 12d anonymize_user_in_session of another user: %', SQLERRM;
  END;
END $$;

-- 13. the C1 attack: temp objects shadowing pg_roles and participant change nothing
CREATE TEMP VIEW pg_roles AS SELECT session_user::name AS rolname, true AS rolsuper;
CREATE TEMP TABLE participant (session_id uuid, user_id uuid, kind text, left_at timestamptz);
INSERT INTO pg_temp.participant VALUES ('00000000-0000-7e00-8000-0000000005e1', current_setting('t.outsider')::uuid, 'human', NULL);
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000d1');
    RAISE EXCEPTION 'TEST FAILED: temp pg_roles made mwf_app the migrator';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 13a temp-view pg_roles attack: anonymize another user still refused: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000d1', true);
  BEGIN
    PERFORM app.need_share('00000000-0000-7e00-8000-0000000000e1', 'x');
    RAISE EXCEPTION 'TEST FAILED: D shared C''s need';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 13b need_share is its owner''s: another participant is refused (temp pg_roles too): %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  IF app.is_member('00000000-0000-7e00-8000-0000000005e1') THEN
    RAISE EXCEPTION 'TEST FAILED: a temp participant table made an outsider a member';
  END IF;
  RAISE NOTICE 'PASS 13c temp participant table does not make an outsider a member';
END $$;
DROP VIEW pg_temp.pg_roles;
DROP TABLE pg_temp.participant;

-- 13d. need_share with no identity bound: nobody's need
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '', true);
  BEGIN
    PERFORM app.need_share('00000000-0000-7e00-8000-0000000000e1', 'x');
    RAISE EXCEPTION 'TEST FAILED: need_share ran with no identity';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 13d need_share refuses a caller with no identity: %', SQLERRM;
  END;
END $$;

-- 14. A review by a non-subject is refused (I5). Since work-k5fk.3 (6a) by key, not by the retired t_review_subject:
-- empathy_review (attempt_id, session_id, reviewer_user_id) REFERENCES empathy_attempt (id, session_id, subject_user_id).
DO $$ BEGIN
  -- as A, so the row is A's own (empathy_review app_own, work-k5fk.10.7) and the key is what refuses it
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  BEGIN
    INSERT INTO empathy_review (attempt_id, session_id, reviewer_user_id, validated)
    VALUES (current_setting('t.att_a')::uuid, current_setting('t.r_session')::uuid,
            current_setting('t.a_user')::uuid, true);
    RAISE EXCEPTION 'TEST FAILED: a non-subject reviewed';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS 14 review by a non-subject refused: %', SQLERRM;
  END;
END $$;

-- 15. anonymize self (rolled back): the walk runs for the user themself
BEGIN;
SELECT set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true) \g /dev/null
SELECT app.anonymize_user_account('00000000-0000-7e00-8000-0000000000c1') \g /dev/null
DO $$ BEGIN
  IF (SELECT deleted_at FROM "user" WHERE id = '00000000-0000-7e00-8000-0000000000c1') IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED: self anonymize did not tombstone';
  END IF;
  RAISE NOTICE 'PASS 15 anonymize_user_account of oneself tombstones the user';
END $$;
ROLLBACK;

-- 16. need_share, by the need's owner (consent.ts / needs-share.ts): idempotent; a need without the owner's GRANTED
--     consent is refused; a missing need is nobody's
DO $$ DECLARE n int; BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  PERFORM app.need_share('00000000-0000-7e00-8000-0000000000e1', 'again');
  SELECT count(*) INTO n FROM need_share WHERE need_id = '00000000-0000-7e00-8000-0000000000e1';
  IF n <> 1 THEN RAISE EXCEPTION 'TEST FAILED: need_share not idempotent (% rows)', n; END IF;
  RAISE NOTICE 'PASS 16a need_share by its owner on an already shared need is a no-op';
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000d1', true);
  BEGIN
    PERFORM app.need_share('00000000-0000-7e00-8000-0000000000e5', 'x');
    RAISE EXCEPTION 'TEST FAILED: need_share without the owner''s GRANTED consent';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 16c need_share refuses the owner''s need without a GRANTED consent: %', SQLERRM;
  END;
END $$;
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.need_share('00000000-0000-7e00-8000-0000000000ff', 'x');
    RAISE EXCEPTION 'TEST FAILED: need_share on a missing need';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 16b need_share refuses a missing need (it is nobody''s): %', SQLERRM;
  END;
END $$;
-- 17 and 24 read what mwf_app cannot (brain_activity, user_identity), so they run on a superuser connection and
-- make the call itself as mwf_app (SET SESSION AUTHORIZATION: session_user is then mwf_app, as the definers' app
-- arm reads it), with the leaver's / the account's own identity.
\connect - mwf_user

-- 17. ruling R17 (rolled back; D leaves X on its own request, as mwf_app): anonymize_user_in_session also deletes the
--     session's NULL-participant brain_activity rows — history that cannot
--     be attributed (…ba1 in X). History of other sessions (…ba2 in S) and
--     reflection telemetry (…ba3, no session) stay.
BEGIN;
DO $$ DECLARE x_before int; s_before int; refl_before int; BEGIN
  SELECT count(*) INTO x_before FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND participant_user_id IS NULL;
  SELECT count(*) INTO s_before FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND participant_user_id IS NULL;
  SELECT count(*) INTO refl_before FROM brain_activity WHERE session_id IS NULL AND reflection_id IS NOT NULL;
  IF x_before = 0 OR s_before = 0 OR refl_before = 0 THEN
    RAISE EXCEPTION 'TEST FAILED: setup — expected NULL-participant history in X (%), in S (%) and reflection telemetry (%)', x_before, s_before, refl_before;
  END IF;
  EXECUTE 'SET SESSION AUTHORIZATION mwf_app';
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000d1', true);
  PERFORM app.anonymize_user_in_session('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1');
  EXECUTE 'RESET SESSION AUTHORIZATION';
  IF EXISTS (SELECT 1 FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND participant_user_id IS NULL) THEN
    RAISE EXCEPTION 'TEST FAILED: NULL-participant brain_activity of the session survived anonymize_user_in_session';
  END IF;
  IF (SELECT count(*) FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND participant_user_id IS NULL) <> s_before
     OR (SELECT count(*) FROM brain_activity WHERE session_id IS NULL AND reflection_id IS NOT NULL) <> refl_before THEN
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_in_session deleted brain_activity outside the session';
  END IF;
  RAISE NOTICE 'PASS 17 anonymize_user_in_session deletes the session''s NULL-participant brain_activity (% row(s) in X), keeps S (%) and reflection telemetry (%)',
    x_before, s_before, refl_before;
END $$;
ROLLBACK;

-- 24. work-k5fk.1/.3 (rolled back; D deletes its own account, as mwf_app): the walk deletes the account's identities and
--     scrubs its personas; the AI row and a persona are never an account to delete.
BEGIN;
DO $$ BEGIN
  EXECUTE 'SET SESSION AUTHORIZATION mwf_app';
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000d1', true);
  PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000d1');
  EXECUTE 'RESET SESSION AUTHORIZATION';
  IF EXISTS (SELECT 1 FROM user_identity WHERE user_id = '00000000-0000-7e00-8000-0000000000d1') THEN
    RAISE EXCEPTION 'TEST FAILED: the walk left a user_identity of the tombstone';
  END IF;
  RAISE NOTICE 'PASS 24a the walk deletes the account''s user_identity rows';
  -- the walk NULLs both names in one SET
  IF (SELECT row(first_name, deleted_at IS NOT NULL)::text FROM "user" WHERE id = '00000000-0000-7e00-8000-0000000000a9')
     IS DISTINCT FROM '(,t)' THEN
    RAISE EXCEPTION 'TEST FAILED: the owner''s persona was not scrubbed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM persona WHERE user_id = '00000000-0000-7e00-8000-0000000000a9') THEN
    RAISE EXCEPTION 'TEST FAILED: the persona row went (it stays, scrubbed)';
  END IF;
  RAISE NOTICE 'PASS 24b the owner''s persona is scrubbed (names NULL, soft-deleted) and kept';
END $$;
ROLLBACK;
\connect - mwf_app
DO $$ BEGIN
  -- the walk's self arm with the AI's / the persona's own id as the identity: still not an account
  PERFORM set_config('app.current_user_id', app.ai_user_id()::text, true);
  BEGIN
    PERFORM app.anonymize_user_account(app.ai_user_id());
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_account ran on the AI row';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 24c the AI row is not an account: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a9', true);
  BEGIN
    PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000a9');
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_account ran on a persona';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 24d a persona is not an account: %', SQLERRM;
  END;
END $$;

-- ============================ as mwf_auth ==============================-- 21. work-k5fk.1 / work-bp5m: resolve_user and create_user, mwf_auth's only privileges.
\connect - mwf_auth
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
DO $$ DECLARE v uuid; w uuid; BEGIN
  IF app.resolve_user('clerk', 'user_ts7cAda') IS DISTINCT FROM '00000000-0000-7e00-8000-0000000000a1' THEN
    RAISE EXCEPTION 'TEST FAILED: resolve_user did not find Ada';
  END IF;
  IF app.resolve_user('clerk', 'user_ts7cNobody') IS NOT NULL OR app.resolve_user('e2e', 'user_ts7cAda') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: resolve_user found an unknown identity (or ignored the provider)';
  END IF;
  RAISE NOTICE 'PASS 23a resolve_user finds the identity''s user, and only under its provider';

  v := app.create_user('clerk', 'user_ts7cNew', 'new@ts7c.test', 'New', 'Person');
  IF v IS NULL OR app.resolve_user('clerk', 'user_ts7cNew') IS DISTINCT FROM v THEN
    RAISE EXCEPTION 'TEST FAILED: create_user did not create a resolvable user';
  END IF;
  RAISE NOTICE 'PASS 23b create_user creates the user and its identity';

  w := app.create_user('clerk', 'user_ts7cNew', 'other@ts7c.test');
  IF w IS DISTINCT FROM v THEN RAISE EXCEPTION 'TEST FAILED: a repeated create_user made a second user'; END IF;
  RAISE NOTICE 'PASS 23c create_user of an existing identity returns its user (concurrent first login), nothing new';

  DECLARE d text;
  BEGIN
    PERFORM app.create_user('clerk', 'user_ts7cMallory', 'a@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: create_user attached a new identity to the holder of the email';
  EXCEPTION WHEN SQLSTATE 'MWF01' THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
    IF d IS DISTINCT FROM '00000000-0000-7e00-8000-0000000000a1' THEN
      RAISE EXCEPTION 'TEST FAILED: MWF01 DETAIL is %, expected the holder''s id', d;
    END IF;
    RAISE NOTICE 'PASS 23d an email held by another account is refused (MWF01, DETAIL the holder''s id), never re-bound: %', SQLERRM;
  END;
  IF app.resolve_user('clerk', 'user_ts7cMallory') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: the refused identity resolves';
  END IF;
  RAISE NOTICE 'PASS 23e the refused identity resolves to nothing';

  BEGIN
    PERFORM app.create_user('clerk', 'user_ts7cCase', 'A@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: create_user stored a non-canonical email';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 23f a non-canonical email is refused (the caller canonicalizes): %', SQLERRM;
  END;
  BEGIN
    PERFORM app.create_user('clerk', 'e2e_not_a_clerk_id', 'x1@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: a clerk identity with a non-Clerk subject';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 23g a clerk subject must be user_<base62>: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.create_user('e2e', 'e2e_ts7c_signup', 'x2@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: create_user signed up an e2e identity';
  EXCEPTION WHEN SQLSTATE 'MWF02' THEN RAISE NOTICE 'PASS 23h create_user takes the clerk provider only (MWF02): %', SQLERRM;
  END;
  BEGIN
    PERFORM app.create_user('clerk', 'user_ts7cNoMail', NULL);
    RAISE EXCEPTION 'TEST FAILED: a human without an email';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 23i a human needs an email: %', SQLERRM;
  END;
  BEGIN
    PERFORM 1 FROM user_identity;
    RAISE EXCEPTION 'TEST FAILED: mwf_auth read user_identity directly';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 23j mwf_auth has the functions only: %', SQLERRM;
  END;
END $$;
-- 23k. a tombstone's identity is gone (24a), so its subject no longer resolves — checked
--      on Bob deleting his own account (rolled back; the superuser stands in for the
--      request, with Bob's identity bound, so mwf_auth can look in the same transaction).
\connect - mwf_user
BEGIN;
SELECT set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000b1', true) \g /dev/null
SELECT app.anonymize_user_account('00000000-0000-7e00-8000-0000000000b1') \g /dev/null
SET LOCAL ROLE mwf_auth;
DO $$ BEGIN
  IF app.resolve_user('clerk', 'user_ts7cBob') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: a deleted account still resolves';
  END IF;
  RAISE NOTICE 'PASS 23k a deleted account''s subject no longer resolves';
END $$;
ROLLBACK;

-- 23l. (review M5, rolled back) the deleted_at filters themselves: Cy is tombstoned
--      WITHOUT the walk, so his identity row is still there. resolve_user must
--      not resolve it, and create_user's same-identity arm must not hand the
--      tombstone back (it raises the identity's unique_violation instead).
BEGIN;
UPDATE "user" SET deleted_at = now(), email = 'deleted+' || id || '@invalid', first_name = NULL, last_name = NULL
WHERE id = '00000000-0000-7e00-8000-0000000000c1';
SET LOCAL ROLE mwf_auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolname = 'mwf_auth') THEN
    RAISE EXCEPTION 'TEST FAILED: setup — not running as mwf_auth';
  END IF;
  IF app.resolve_user('clerk', 'user_ts7cCy') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: resolve_user resolved a tombstone whose identity survived';
  END IF;
  RAISE NOTICE 'PASS 23l resolve_user ignores a tombstoned user even with its identity present';
  BEGIN
    PERFORM app.create_user('clerk', 'user_ts7cCy', 'cy.again@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: create_user handed back (or re-created around) a tombstone''s identity';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 23m create_user does not return a tombstone for its surviving identity (unique_violation): %', SQLERRM;
  END;
END $$;
ROLLBACK;

-- ============================ structure (superuser) ===========================
-- 22. pattern K and the AI principal: the keys, not the callers, refuse these.
DO $$ BEGIN
  BEGIN
    INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_ts7cAi', app.ai_user_id());
    RAISE EXCEPTION 'TEST FAILED: an identity on the AI row';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS 22a an identity can only point at a human (AI row refused): %', SQLERRM;
  END;
  BEGIN
    INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_ts7cPersona', '00000000-0000-7e00-8000-0000000000a9');
    RAISE EXCEPTION 'TEST FAILED: an identity on a persona';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS 22b an identity can only point at a human (persona refused): %', SQLERRM;
  END;
  BEGIN
    INSERT INTO persona (user_id, owner_user_id) VALUES ('00000000-0000-7e00-8000-0000000000a1', '00000000-0000-7e00-8000-0000000000b1');
    RAISE EXCEPTION 'TEST FAILED: a human row as a persona';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS 22c a persona row must be a persona user: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO "user" (id, kind) VALUES ('00000000-0000-7e00-8000-0000000000aa', 'persona');
    INSERT INTO persona (user_id, owner_user_id) VALUES ('00000000-0000-7e00-8000-0000000000aa', '00000000-0000-7e00-8000-0000000000a9');
    RAISE EXCEPTION 'TEST FAILED: a persona owned by a persona';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS 22d a persona''s owner must be a human: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO "user" (kind) VALUES ('ai');
    RAISE EXCEPTION 'TEST FAILED: a second AI row';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS 22e exactly one AI row (sql_user_one_ai): %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET email = 'ai@ts7c.test' WHERE id = app.ai_user_id();
    RAISE EXCEPTION 'TEST FAILED: the AI row with an email';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 22f a non-human has no email: %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET kind = 'persona' WHERE id = '00000000-0000-7e00-8000-0000000000a1';
    RAISE EXCEPTION 'TEST FAILED: a human with an identity re-kinded';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN RAISE NOTICE 'PASS 22g a human with an email/identity cannot change kind: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO user_identity (provider, subject, user_id) VALUES ('e2e', 'e2e_ts7c_second', '00000000-0000-7e00-8000-0000000000a1');
    INSERT INTO user_identity (provider, subject, user_id) VALUES ('e2e', 'e2e_ts7c_third', '00000000-0000-7e00-8000-0000000000a1');
    RAISE EXCEPTION 'TEST FAILED: two identities of one provider on one user';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS 22h one identity per provider per user: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO user_identity (provider, subject, user_id) VALUES ('e2e', 'user_ts7cAda2', '00000000-0000-7e00-8000-0000000000b1');
    RAISE EXCEPTION 'TEST FAILED: an e2e identity with a non-e2e subject';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 22i an e2e subject must be e2e_…: %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET email = 'deleted+' || id || '@invalid' WHERE id = '00000000-0000-7e00-8000-0000000000a1';
    RAISE EXCEPTION 'TEST FAILED: a live account holds a deleted+…@invalid address';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 22j a live account cannot hold a tombstone address (review L1): %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET deleted_at = now() WHERE id = '00000000-0000-7e00-8000-0000000000a1';
    RAISE EXCEPTION 'TEST FAILED: a tombstone keeps a real address';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 22k a tombstone cannot keep a real address: %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET first_name = 'Hal' WHERE id = app.ai_user_id();
    RAISE EXCEPTION 'TEST FAILED: the AI row named';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 22l the AI row has no name: %', SQLERRM;
  END;
  BEGIN
    UPDATE "user" SET deleted_at = now() WHERE id = app.ai_user_id();
    RAISE EXCEPTION 'TEST FAILED: the AI row deleted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 22m the AI row is never deleted: %', SQLERRM;
  END;
END $$;
-- 19. app.session_archive (work-k5fk.10.12): only a CURRENT participant of the
--     session, only from CREATED / INVITED / RESOLVED / ABANDONED; records the
--     archiver and the instant. Its refusals carry their own SQLSTATEs (MWA00
--     no identity, MWA01 not found / not a participant, MWA02 participant left,
--     MWA03 not archivable), so each arm below catches exactly its code — a
--     grant drift (42501) or an unrelated CHECK (23514) would stop the run.
--     mwf_app holds no UPDATE of session.status; app.session_set_status
--     archives only for a worker (retention); a worker login cannot call
--     session_archive. Setup (superuser): D leaves X (RESOLVED, so
--     T-cardinality-2 allows it); Y (…05e2), a CREATED session started by C
--     alone, so D shared a session with C (X) but never joined Y (work-k5fk.2:
--     no relationship membership grants anything).
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: D leaves X; session Y with C only)';
UPDATE participant SET left_at = now() WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND user_id = '00000000-0000-7e00-8000-0000000000d1';
INSERT INTO session (id, status) VALUES ('00000000-0000-7e00-8000-0000000005e2', 'CREATED');
INSERT INTO participant (session_id, user_id, kind, display_name) VALUES
  ('00000000-0000-7e00-8000-0000000005e2', '00000000-0000-7e00-8000-0000000000c1', 'human', 'Cy');
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null
DO $$ DECLARE v_con text; BEGIN
  -- 19a. a participant who left: MWA02 from session_archive
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000d1', true);
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e1');
    RAISE EXCEPTION 'TEST FAILED: a participant who left archived the session';
  EXCEPTION WHEN SQLSTATE 'MWA02' THEN RAISE NOTICE 'PASS 19a a participant who left cannot archive (MWA02): %', SQLERRM;
  END;
  -- 19b. nor through session_set_status: its member arm is current participants only (not found)
  BEGIN
    PERFORM app.session_set_status('00000000-0000-7e00-8000-0000000005e1', 'ARCHIVED');
    RAISE EXCEPTION 'TEST FAILED: a participant who left archived the session through session_set_status';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'session not found' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19b nor through session_set_status (a leaver is no member there): %', SQLERRM;
  END;
  -- 19c. C's partner from X, who never joined Y; 19d an outsider; 19e no identity
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e2');
    RAISE EXCEPTION 'TEST FAILED: a past partner who never joined archived the session';
  EXCEPTION WHEN SQLSTATE 'MWA01' THEN RAISE NOTICE 'PASS 19c a past partner who never joined cannot archive (MWA01): %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e1');
    RAISE EXCEPTION 'TEST FAILED: an outsider archived the session';
  EXCEPTION WHEN SQLSTATE 'MWA01' THEN RAISE NOTICE 'PASS 19d an outsider cannot archive (MWA01): %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '', true);
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e1');
    RAISE EXCEPTION 'TEST FAILED: no identity archived the session';
  EXCEPTION WHEN SQLSTATE 'MWA00' THEN RAISE NOTICE 'PASS 19e no identity cannot archive (MWA00): %', SQLERRM;
  END;
  -- 19f. a live (ACTIVE) session is not archivable
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  BEGIN
    PERFORM app.session_archive(current_setting('t.r_session')::uuid);
    RAISE EXCEPTION 'TEST FAILED: an ACTIVE session was archived';
  EXCEPTION WHEN SQLSTATE 'MWA03' THEN RAISE NOTICE 'PASS 19f an ACTIVE session is not archivable (MWA03): %', SQLERRM;
  END;
  -- 19g, 19h. no direct write of session.status or the archive columns by mwf_app: the grant refuses
  BEGIN
    UPDATE session SET status = 'ARCHIVED' WHERE id = '00000000-0000-7e00-8000-0000000005e1';
    RAISE EXCEPTION 'TEST FAILED: mwf_app updated session.status';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'permission denied for table session' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19g mwf_app cannot UPDATE session.status: %', SQLERRM;
  END;
  BEGIN
    UPDATE session SET archived_at = now() WHERE id = '00000000-0000-7e00-8000-0000000005e1';
    RAISE EXCEPTION 'TEST FAILED: mwf_app updated session.archived_at';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'permission denied for table session' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19h mwf_app cannot UPDATE session.archived_at: %', SQLERRM;
  END;
  -- 19l. a current participant cannot archive through session_set_status either (→ ARCHIVED is the worker's)
  BEGIN
    PERFORM app.session_set_status(current_setting('t.r_session')::uuid, 'ARCHIVED');
    RAISE EXCEPTION 'TEST FAILED: a participant archived through session_set_status';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'only a worker archives through session_set_status%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19l a current participant cannot archive through session_set_status: %', SQLERRM;
  END;
  -- 19m. mwf_app cannot INSERT an ARCHIVED session: a new session starts CREATED (work-k5fk.10.7: session
  --      app_insert, which PostgreSQL checks before session_check1's missing archived_at)
  BEGIN
    INSERT INTO session (status) VALUES ('ARCHIVED');
    RAISE EXCEPTION 'TEST FAILED: mwf_app inserted an ARCHIVED session';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'new row violates row-level security policy for table "session"%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19m mwf_app INSERT of an ARCHIVED session refused: %', SQLERRM;
  END;
  IF (SELECT status FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e1') <> 'RESOLVED' THEN
    RAISE EXCEPTION 'TEST FAILED: X moved off RESOLVED';
  END IF;
END $$;
-- 19i. a current participant archives X (RESOLVED) and Y (CREATED); the archiver and instant are recorded; a repeat is refused
DO $$ DECLARE v_at timestamptz; BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  v_at := app.session_archive('00000000-0000-7e00-8000-0000000005e1');
  IF NOT EXISTS (SELECT 1 FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e1' AND status = 'ARCHIVED'
                 AND archived_by_user_id = '00000000-0000-7e00-8000-0000000000c1' AND archived_at = v_at) THEN
    RAISE EXCEPTION 'TEST FAILED: X not archived by C at %', v_at;
  END IF;
  PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e2');
  IF NOT EXISTS (SELECT 1 FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e2' AND status = 'ARCHIVED'
                 AND archived_by_user_id = '00000000-0000-7e00-8000-0000000000c1' AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TEST FAILED: Y not archived by C';
  END IF;
  RAISE NOTICE 'PASS 19i a current participant archives RESOLVED X and CREATED Y; archived_by and archived_at recorded';
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e1');
    RAISE EXCEPTION 'TEST FAILED: an ARCHIVED session was archived again';
  EXCEPTION WHEN SQLSTATE 'MWA03' THEN RAISE NOTICE 'PASS 19j an ARCHIVED session is not archived again (MWA03): %', SQLERRM;
  END;
END $$;
\connect - mwf_worker
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
DO $$ BEGIN
  -- 19n. a worker login cannot archive for a user: it holds no EXECUTE on session_archive (the function's own
  --      app_access refusal is the second wall)
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a1', true);
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e6');
    RAISE EXCEPTION 'TEST FAILED: a worker login archived through session_archive';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'permission denied for function session_archive%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19n a worker login cannot call session_archive: %', SQLERRM;
  END;
  -- 19o. the worker writes no session column directly: status moves through session_set_status (work-k5fk.10.5:
  --      mwf_job kept UPDATE (status) for its row locks; neither mwf_worker nor mwf_ai holds it)
  BEGIN
    UPDATE session SET status = 'ARCHIVED' WHERE id = '00000000-0000-7e00-8000-0000000005e6';
    RAISE EXCEPTION 'TEST FAILED: the worker updated session.status directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 19o the worker cannot UPDATE session.status directly: %', SQLERRM;
  END;
  -- 19p. the archive columns are written only through session_set_status / session_archive (work-k5fk.10.4:
  --      their UPDATE grant is mwf_definer's): a direct UPDATE by the worker is refused
  BEGIN
    UPDATE session SET archived_by_user_id = '00000000-0000-7e00-8000-0000000000a1' WHERE id = '00000000-0000-7e00-8000-0000000005e6';
    RAISE EXCEPTION 'TEST FAILED: the worker updated session.archived_by_user_id directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 19p the worker cannot UPDATE the archive columns directly: %', SQLERRM;
  END;
  -- 19r. the worker's arm of session_set_status needs the session in app.session_scope (Q20)
  PERFORM set_config('app.session_scope', '', true);
  BEGIN
    PERFORM app.session_set_status('00000000-0000-7e00-8000-0000000005e6', 'ABANDONED');
    RAISE EXCEPTION 'TEST FAILED: the worker moved a session without a scope';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 19r the worker cannot move a session outside its app.session_scope: %', SQLERRM;
  END;
END $$;
-- 19q. session_check1 / session_check2 bind every writer, the superuser too: ARCHIVED without archived_at, an
--      archiver on a session that is not archived (before work-k5fk.10.4 shown with mwf_job's own UPDATE grants)
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (session_check1 / session_check2)';
DO $$ DECLARE v_con text; BEGIN
  BEGIN
    UPDATE session SET status = 'ARCHIVED' WHERE id = '00000000-0000-7e00-8000-0000000005e6';
    RAISE EXCEPTION 'TEST FAILED: ARCHIVED without archived_at';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con <> 'session_check1' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19q an UPDATE to ARCHIVED without archived_at refused by %', v_con;
  END;
  BEGIN
    UPDATE session SET archived_by_user_id = '00000000-0000-7e00-8000-0000000000a1' WHERE id = '00000000-0000-7e00-8000-0000000005e6';
    RAISE EXCEPTION 'TEST FAILED: an archiver on a session that is not archived';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con <> 'session_check2' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19q an archiver without archived_at refused by %', v_con;
  END;
END $$;
-- 19k. the worker (session-retention.ts) archives through session_set_status, scoped to the session: archived_at,
--      no archiver; and the retention purge of an archived session is not blocked by the archive columns. On W
--      (…05e7), a CREATED session made for it, and X (…05e1, archived by D in 19i), neither used below, so it is
--      committed: the worker cannot read the archive columns (work-k5fk.10.4), so the superuser checks them after.
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: session W for 19k)';
INSERT INTO session (id, status) VALUES ('00000000-0000-7e00-8000-0000000005e7', 'CREATED');
-- work-k5fk.10.29 R3: the worker purges only past the window (untouched for 90 days since the archive); X was
-- archived in 19i. touch_updated_at would stamp the backdated value away: triggers off for the one statement.
ALTER TABLE session DISABLE TRIGGER USER;
UPDATE session SET updated_at = now() - interval '91 days' WHERE id = '00000000-0000-7e00-8000-0000000005e1';
ALTER TABLE session ENABLE TRIGGER USER;
\connect - mwf_worker
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
DO $$ BEGIN
  PERFORM set_config('app.session_scope', '00000000-0000-7e00-8000-0000000005e7', true);
  PERFORM app.session_set_status('00000000-0000-7e00-8000-0000000005e7', 'ABANDONED');
  PERFORM app.session_set_status('00000000-0000-7e00-8000-0000000005e7', 'ARCHIVED');
  IF NOT EXISTS (SELECT 1 FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e7' AND status = 'ARCHIVED') THEN
    RAISE EXCEPTION 'TEST FAILED: the worker''s archive did not archive';
  END IF;
  -- work-k5fk.10.29 R3: W, archived in this very transaction, is not purgeable (worker_purge: past the window only)
  DELETE FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e7';
  IF NOT FOUND THEN RAISE NOTICE 'PASS 19k-0 the worker cannot archive and purge a session in one transaction';
  ELSE RAISE EXCEPTION 'TEST FAILED: the worker purged a session it had just archived'; END IF;
  DELETE FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e1';
  IF EXISTS (SELECT 1 FROM participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e1') THEN
    RAISE EXCEPTION 'TEST FAILED: purge left participants';
  END IF;
END $$;
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (19k: the archive columns the worker wrote)';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e7' AND status = 'ARCHIVED'
                 AND archived_at IS NOT NULL AND archived_by_user_id IS NULL) THEN
    RAISE EXCEPTION 'TEST FAILED: the worker''s archive did not stamp archived_at alone';
  END IF;
  RAISE NOTICE 'PASS 19k the worker archives (archived_at, no archiver); purging a participant-archived session cascades';
END $$;

-- 20. session_set_status's member arm is CURRENT participants only (work-k5fk.10.12 review):
--     B leaves the live session S (A stays, so T-cardinality-2 allows it); B cannot move S
--     (→ ABANDONED), A can (rolled back).
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: B leaves S)';
UPDATE participant SET left_at = now() WHERE session_id = :'r_session' AND user_id = :'b_user';
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.r_session', :'r_session', false) \g /dev/null
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  BEGIN
    PERFORM app.session_set_status(current_setting('t.r_session')::uuid, 'ABANDONED');
    RAISE EXCEPTION 'TEST FAILED: a participant who left abandoned the session';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'session not found' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 20a a participant who left cannot move the session (ACTIVE→ABANDONED): %', SQLERRM;
  END;
  IF (SELECT status FROM session WHERE id = current_setting('t.r_session')::uuid) <> 'ACTIVE' THEN
    RAISE EXCEPTION 'TEST FAILED: S moved off ACTIVE';
  END IF;
END $$;
BEGIN;
SELECT set_config('app.current_user_id', :'a_user', true) \g /dev/null
SELECT app.session_set_status(:'r_session', 'ABANDONED') \g /dev/null
DO $$ BEGIN
  IF (SELECT status FROM session WHERE id = current_setting('t.r_session')::uuid) <> 'ABANDONED' THEN
    RAISE EXCEPTION 'TEST FAILED: the current participant''s ACTIVE→ABANDONED did not land';
  END IF;
  RAISE NOTICE 'PASS 20b a current participant moves the session (ACTIVE→ABANDONED)';
END $$;
ROLLBACK;

-- 25. the JSON-schema subset validator (work-k5fk.8): every keyword accepts and refuses,
--     nested properties and arrays carry a path, and a schema with an unsupported keyword
--     is not well-formed. Pure functions, run as mwf_app (still connected).
DO $$
DECLARE
  -- [schema, accepted doc, refused doc, the refusal's expected text]
  cases jsonb := $j$[
    [{"type": "object"},                           {},                  [],                   "$: expected object, got array"],
    [{"type": "array"},                            [],                  {},                   "$: expected array, got object"],
    [{"type": "string"},                           "x",                 1,                    "$: expected string, got number"],
    [{"type": "number"},                           1.5,                 "1",                  "$: expected number, got string"],
    [{"type": "integer"},                          2,                   2.5,                  "$: expected integer, got number"],
    [{"type": "integer"},                          1.0,                 1.01,                 "$: expected integer, got number"],
    [{"type": "boolean"},                          false,               null,                 "$: expected boolean, got null"],
    [{"type": "null"},                             null,                0,                    "$: expected null, got number"],
    [{"type": ["string", "null"]},                 null,                true,                 "$: expected string or null, got boolean"],
    [{"type": ["integer", "string", "null"]},      "s",                 [],                   "$: expected integer or string or null, got array"],
    [{"required": ["a", "b"]},                     {"a": 1, "b": 2},    {"a": 1},             "$: missing required key b"],
    [{"required": ["a", "b"]},                     {"a": null, "b": null}, {"b": 1},          "$: missing required key a"],
    [{"enum": ["x", 2, {"k": [1]}]},               {"k": [1]},          {"k": [1, 2]},        "$: not one of the allowed values"],
    [{"enum": [1.0, "1"]},                         1,                   "1.0",                "$: not one of the allowed values"],
    [{"properties": {"a": {"type": "string"}}},    {"a": "s", "z": 1},  {"a": 1},             "$.a: expected string, got number"],
    [{"properties": {"a": {"type": "string"}}, "additionalProperties": false}, {"a": "s"}, {"a": 2}, "$.a: expected string, got number"],
    [{"properties": {"a": {}}, "additionalProperties": false}, {"a": 0}, {"a": 0, "b": 1},    "$: unexpected key b"],
    [{"additionalProperties": {"type": "integer"}}, {"a": 1, "b": 2},   {"a": 1, "b": "2"},   "$.b: expected integer, got string"],
    [{"items": {"type": "string"}},                ["a", "b"],          ["a", 2],             "$[1]: expected string, got number"],
    [{"items": {"type": "string"}},                [],                  [1, "a"],             "$[0]: expected string, got number"],
    [{"type": "object", "properties": {"o": {"type": "object", "required": ["p"], "properties": {"p": {"type": "array", "items": {"type": "object", "required": ["q"], "properties": {"q": {"type": "boolean"}}}}}}}},
                                                   {"o": {"p": [{"q": true}, {"q": false}]}},
                                                   {"o": {"p": [{"q": true}, {"q": "no"}]}},
                                                                                          "$.o.p[1].q: expected boolean, got string"]
  ]$j$;
  c jsonb; v text; i int := 0;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(cases) LOOP
    i := i + 1;
    v := app.jsonb_schema_violation(c -> 1, c -> 0);
    IF v IS NOT NULL THEN RAISE EXCEPTION 'TEST FAILED: case %: % refused %: %', i, c -> 0, c -> 1, v; END IF;
    v := app.jsonb_schema_violation(c -> 2, c -> 0);
    IF v IS DISTINCT FROM (c ->> 3) THEN RAISE EXCEPTION 'TEST FAILED: case %: % on % gave %, expected %', i, c -> 0, c -> 2, v, c ->> 3; END IF;
  END LOOP;
  -- keywords apply only to their own type, as in JSON Schema: properties/required say nothing about a string
  IF app.jsonb_schema_violation('"s"', '{"required": ["a"], "items": {"type": "null"}}') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: object/array keywords applied to a string';
  END IF;
  -- an SQL NULL document is named as such
  IF app.jsonb_schema_violation(NULL, '{"type": "object"}') IS DISTINCT FROM '$: expected object, got SQL NULL' THEN
    RAISE EXCEPTION 'TEST FAILED: SQL NULL: %', app.jsonb_schema_violation(NULL, '{"type": "object"}');
  END IF;
  RAISE NOTICE 'PASS 25a the validator: type (7 types, unions, integer 1.0), required (a JSON null is present), enum (jsonb equality: 1 = 1.0), properties, additionalProperties (false, a schema), items (every element), a nested path, SQL NULL — % cases each accepted and refused', i;
  -- an unknown keyword, a bad type name, a non-array required: not well-formed (refused when seeded, never
  -- silently ignored), at every depth: properties, items and additionalProperties sub-schemas too
  IF app.json_schema_wellformed('{"type": "object", "minimum": 1}') OR app.json_schema_wellformed('{"type": "date"}')
     OR app.json_schema_wellformed('{"type": ["string", "date"]}') OR app.json_schema_wellformed('{"type": []}')
     OR app.json_schema_wellformed('{"required": "a"}') OR app.json_schema_wellformed('{"required": [1]}')
     OR app.json_schema_wellformed('{"properties": {"a": {"maxLength": 3}}}')
     OR app.json_schema_wellformed('{"items": {"minimum": 1}}') OR app.json_schema_wellformed('{"items": {"type": "date"}}')
     OR app.json_schema_wellformed('{"additionalProperties": {"pattern": "x"}}') OR app.json_schema_wellformed('{"additionalProperties": "no"}')
     OR app.json_schema_wellformed('{"enum": []}') OR app.json_schema_wellformed('{"description": 1}') OR app.json_schema_wellformed('[]')
     OR NOT app.json_schema_wellformed('{"type": "object", "description": "x", "$comment": "y", "properties": {"a": {"enum": [1]}}, "additionalProperties": false}')
     OR NOT app.json_schema_wellformed('{"items": {"type": "string"}, "additionalProperties": {"type": ["integer", "null"]}}') THEN
    RAISE EXCEPTION 'TEST FAILED: json_schema_wellformed';
  END IF;
  RAISE NOTICE 'PASS 25b json_schema_wellformed refuses an unsupported keyword, type name or keyword value, in properties, items and additionalProperties too';
  BEGIN
    PERFORM app.jsonb_matches('{}', 'user_preferences', 99::schema_version);
    RAISE EXCEPTION 'TEST FAILED: an unknown schema version matched';
  EXCEPTION WHEN SQLSTATE 'MWJ01' THEN
    IF SQLERRM <> 'json_schema user_preferences version 99 does not exist' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 25c jsonb_matches: an unknown version raises MWJ01: %', SQLERRM;
  END;
END $$;
-- 25d. each seeded v1 schema accepts what its writer writes and refuses at each closed level
DO $$
DECLARE
  -- [name, accepted doc, refused doc, the refusal's expected text]
  cases jsonb := $j$[
    ["user_preferences", {"memory": {}, "notifications": {}, "privacy": {}}, {"memory": {}, "notifications": {}}, "$: missing required key privacy"],
    ["user_preferences", {"memory": {"patternInsights": true}, "notifications": {}, "privacy": {}}, {"memory": {"x": true}, "notifications": {}, "privacy": {}}, "$.memory: unexpected key x"],
    ["user_preferences", {"memory": {}, "notifications": {"pushEnabled": false}, "privacy": {}}, {"memory": {}, "notifications": {"sms": true}, "privacy": {}}, "$.notifications: unexpected key sms"],
    ["user_preferences", {"memory": {}, "notifications": {}, "privacy": {"analyticsOptOut": true}}, {"memory": {}, "notifications": {}, "privacy": {"analyticsOptOut": 1}}, "$.privacy.analyticsOptOut: expected boolean, got number"],
    ["ai_memory.summary", {"text": "s", "messageCount": 1, "generatedAt": "g", "keyThemes": ["a"]}, {"text": "s", "messageCount": 1, "generatedAt": "g", "mood": "x"}, "$: unexpected key mood"],
    ["ai_memory.summary", {"text": "s", "messageCount": 1, "generatedAt": "g", "keyThemes": null}, {"text": "s", "messageCount": 1, "generatedAt": "g", "keyThemes": ["a", 2]}, "$.keyThemes[1]: expected string, got number"],
    ["ai_memory.summary", {"text": "s", "messageCount": 1, "generatedAt": "g", "tokenCount": 2}, {"text": "s", "messageCount": 1, "generatedAt": "g", "tokenCount": null}, "$.tokenCount: expected integer, got null"],
    ["ai_memory.notable_facts", {"facts": [{"id": "x", "category": "c", "fact": "f", "extra": 1}]}, {"facts": [], "topic": "t"}, "$: unexpected key topic"],
    ["ai_memory.notable_facts", {"facts": []}, {"facts": [{"id": 12345, "category": "c", "fact": "f"}]}, "$.facts[0].id: expected string, got number"],
    ["ai_memory.global_facts", {"facts": [], "sessionCount": 3, "consolidatedAt": "c"}, {"facts": [], "sessionCount": "3"}, "$.sessionCount: expected integer, got string"],
    ["ai_memory.global_facts", {"facts": [{"category": "c", "fact": "f"}]}, {"facts": [], "owner": "x"}, "$: unexpected key owner"]
  ]$j$;
  c jsonb; v text; i int := 0;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(cases) LOOP
    i := i + 1;
    IF NOT app.jsonb_matches(c -> 1, c ->> 0, 1::schema_version) THEN
      RAISE EXCEPTION 'TEST FAILED: % refused %: %', c ->> 0, c -> 1, app.jsonb_violation(c -> 1, c ->> 0, 1::schema_version);
    END IF;
    IF app.jsonb_matches(c -> 2, c ->> 0, 1::schema_version) THEN RAISE EXCEPTION 'TEST FAILED: % accepted %', c ->> 0, c -> 2; END IF;
    v := app.jsonb_violation(c -> 2, c ->> 0, 1::schema_version);
    IF v IS DISTINCT FROM (c ->> 3) THEN RAISE EXCEPTION 'TEST FAILED: % on % gave %, expected %', c ->> 0, c -> 2, v, c ->> 3; END IF;
  END LOOP;
  RAISE NOTICE 'PASS 25d the four seeded schemas: % cases, each accepted and refused at its closed level (jsonb_matches, jsonb_violation)', i;
END $$;

-- 26. user_preferences.doc is validated by its BEFORE trigger (json_schema user_preferences v1), as mwf_app
SELECT set_config('t.a_user', :'a_user', false) \g /dev/null
DO $$ DECLARE v_msg text; v_detail text; BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  -- the app's own default document (user-settings.ts DEFAULT_DOC) is accepted, version 1 by default
  INSERT INTO user_preferences (user_id, doc) VALUES (current_setting('t.a_user')::uuid,
    '{"memory": {"sessionContinuity": true, "crossSessionRecall": false, "patternInsights": false, "rememberAgreements": true},
      "notifications": {"pushEnabled": true, "emailEnabled": false, "newInvitations": true, "partnerActions": true, "followUpReminders": true},
      "privacy": {"showActivityStatus": true, "allowSessionInvites": true, "analyticsOptOut": false}}');
  IF (SELECT doc_schema_version FROM user_preferences WHERE user_id = current_setting('t.a_user')::uuid) <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: doc_schema_version is not 1';
  END IF;
  RAISE NOTICE 'PASS 26a the app''s default preferences document is accepted (doc_schema_version 1)';
  BEGIN
    UPDATE user_preferences SET doc = jsonb_set(doc, '{memory,sessionContinuity}', '"yes"') WHERE user_id = current_setting('t.a_user')::uuid;
    RAISE EXCEPTION 'TEST FAILED: a string preference was stored';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_msg <> 'user_preferences.doc does not match json_schema user_preferences v1: $.memory.sessionContinuity: expected boolean, got string'
       OR v_detail <> '' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 26b a wrongly typed preference is refused (no DETAIL): %', v_msg;
  END;
  BEGIN
    UPDATE user_preferences SET doc = doc || '{"theme": "dark"}' WHERE user_id = current_setting('t.a_user')::uuid;
    RAISE EXCEPTION 'TEST FAILED: an unknown preference document was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%: $: unexpected key theme' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 26c an unknown top-level key is refused: %', SQLERRM;
  END;
  BEGIN
    UPDATE user_preferences SET doc = doc || '{"privacy": {"showActivityStatus": false, "shareLocation": true}}' WHERE user_id = current_setting('t.a_user')::uuid;
    RAISE EXCEPTION 'TEST FAILED: an unknown privacy key was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%: $.privacy: unexpected key shareLocation' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 26d an unknown nested key is refused: %', SQLERRM;
  END;
  -- 26f. mwf_app writes doc (and updated_at), never the version: that is a migration's
  BEGIN
    UPDATE user_preferences SET doc_schema_version = 1 WHERE user_id = current_setting('t.a_user')::uuid;
    RAISE EXCEPTION 'TEST FAILED: mwf_app wrote doc_schema_version';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 26f mwf_app cannot UPDATE user_preferences.doc_schema_version: %', SQLERRM;
  END;
END $$;
-- 26e. an unknown schema version is refused (mwf_app cannot write doc_schema_version, 26f: the migrator's
--      UPDATE, rolled back, shows the trigger fires on UPDATE OF doc_schema_version, and refuses it)
\connect - mwf_user
BEGIN;
DO $$ BEGIN
  UPDATE user_preferences SET doc_schema_version = 2 WHERE user_id = '00000000-0000-7e00-8000-0000000000b1';
  RAISE EXCEPTION 'TEST FAILED: an unknown schema version was stored';
EXCEPTION WHEN SQLSTATE 'MWJ01' THEN
  IF SQLERRM <> 'json_schema user_preferences version 2 does not exist' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 26e an unknown doc_schema_version is refused (MWJ01): %', SQLERRM;
END $$;
ROLLBACK;

-- 27. ai_memory.doc's structure is validated per kind (json_schema ai_memory.<kind> v1), as mwf_ai
--     (the summarizer and the partner-session classifier write it: INSERT … ON CONFLICT DO UPDATE)
\connect - mwf_ai
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.r_session', :'r_session', false), set_config('t.outsider', :'outsider', false) \g /dev/null
-- The AI's arm needs the session in app.session_scope (work-k5fk.10.5, Q20); session-wide here, transaction-local in the app.
SELECT set_config('app.session_scope', :'r_session', false) \g /dev/null
-- …and its acting user (the request's identity, bound on the AI connection too) must be a participant of it
-- (work-k5fk.10.7: the ai_session policies' app.scope_actor_is_member()).
SELECT set_config('app.current_user_id', :'a_user', false) \g /dev/null
-- 27-0. work-k5fk.10.7: in its scope, the AI acting for a user who is no participant of it writes nothing
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  BEGIN
    INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES (current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid,
      'NOTABLE_FACTS', '{"facts": []}');
    RAISE EXCEPTION 'TEST FAILED: the AI wrote for an actor outside its scope';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'new row violates row-level security policy for table "ai_memory"%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27-0 the AI acting for a non-participant writes no memory in its scope: %', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM ai_memory) THEN RAISE EXCEPTION 'TEST FAILED: the AI reads memory for an actor outside its scope'; END IF;
  RAISE NOTICE 'PASS 27-1 …nor reads any';
END $$;
DO $$ DECLARE v_msg text; BEGIN
  -- the summarizer's document (conversation-summarizer.ts updateSessionSummary), every key it writes
  INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES (current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid, 'SUMMARY',
    '{"text": "s", "messageCount": 12, "oldestMessageAt": "2026-11-01T10:00:00.000Z", "newestMessageAt": "2026-11-01T11:00:00.000Z",
      "tokenCount": 3, "generatedAt": "2026-11-01T11:00:01.000Z", "keyThemes": ["t"], "emotionalJourney": "e", "unresolvedTopics": [],
      "agreedFacts": [], "userNeeds": ["n"], "partnerNeeds": [], "openQuestions": [], "agreements": [], "lastUnresolvedThread": null}')
    ON CONFLICT (user_id, session_id, kind) WHERE session_id IS NOT NULL DO UPDATE SET doc = EXCLUDED.doc;
  -- the classifier's NOTABLE_FACTS (partner-session-classifier.ts; ids from ensureFactIds)
  INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES (current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid, 'NOTABLE_FACTS',
    '{"facts": [{"id": "01900000-0000-7000-8000-000000000001", "category": "People", "fact": "f"}, {"category": "Emotional", "fact": "g"}]}')
    ON CONFLICT (user_id, session_id, kind) WHERE session_id IS NOT NULL DO UPDATE SET doc = EXCLUDED.doc;
  RAISE NOTICE 'PASS 27a the summarizer''s SUMMARY and the classifier''s NOTABLE_FACTS documents are accepted';
  -- 27b. the BEFORE INSERT trigger sees the proposed row before ON CONFLICT is considered: a bad
  --      document is refused at the INSERT even though a SUMMARY row for the participant exists
  BEGIN
    INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES (current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid, 'SUMMARY',
      '{"text": "s", "messageCount": "12", "generatedAt": "2026-11-01T11:00:01.000Z"}')
      ON CONFLICT (user_id, session_id, kind) WHERE session_id IS NOT NULL DO UPDATE SET doc = EXCLUDED.doc;
    RAISE EXCEPTION 'TEST FAILED: a string messageCount was stored';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'ai_memory.doc does not match json_schema ai_memory.summary v1: $.messageCount: expected integer, got string' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27b a SUMMARY with a string messageCount is refused by the BEFORE INSERT on the proposed row (a row exists): %', v_msg;
  END;
  -- 27g. the DO UPDATE path: the proposed row is good, the SET writes a bad document — the BEFORE UPDATE refuses it
  BEGIN
    INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES (current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid, 'SUMMARY',
      '{"text": "s", "messageCount": 1, "generatedAt": "g"}')
      ON CONFLICT (user_id, session_id, kind) WHERE session_id IS NOT NULL DO UPDATE SET doc = '{"text": "s", "messageCount": 1}';
    RAISE EXCEPTION 'TEST FAILED: the upsert''s update stored a SUMMARY without generatedAt';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%ai_memory.summary v1: $: missing required key generatedAt' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27g the upsert''s DO UPDATE is checked as an UPDATE: %', SQLERRM;
  END;
  BEGIN
    INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES (current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid, 'NOTABLE_FACTS',
      '{"facts": [{"category": "People", "fact": "f"}, {"category": "People"}]}')
      ON CONFLICT (user_id, session_id, kind) WHERE session_id IS NOT NULL DO UPDATE SET doc = EXCLUDED.doc;
    RAISE EXCEPTION 'TEST FAILED: a fact without its text was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%ai_memory.notable_facts v1: $.facts[1]: missing required key fact' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27c a fact without its text is refused: %', SQLERRM;
  END;
  -- 27h. mwf_ai writes doc only: never kind or the version
  BEGIN
    UPDATE ai_memory SET kind = 'NOTABLE_FACTS' WHERE session_id = current_setting('t.r_session')::uuid AND user_id = current_setting('t.a_user')::uuid AND kind = 'SUMMARY';
    RAISE EXCEPTION 'TEST FAILED: mwf_ai changed a kind';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE ai_memory SET doc_schema_version = 1 WHERE session_id = current_setting('t.r_session')::uuid AND user_id = current_setting('t.a_user')::uuid;
    RAISE EXCEPTION 'TEST FAILED: mwf_ai wrote doc_schema_version';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 27h mwf_ai cannot UPDATE ai_memory.kind or doc_schema_version: %', SQLERRM;
  END;
  -- 27j. the scope is required: outside it, the AI's document is refused (t_session_scope)
  PERFORM set_config('app.session_scope', '', true);
  BEGIN
    INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES (current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid, 'SUMMARY',
      '{"text": "s", "messageCount": 1, "generatedAt": "g"}')
      ON CONFLICT (user_id, session_id, kind) WHERE session_id IS NOT NULL DO UPDATE SET doc = EXCLUDED.doc;
    RAISE EXCEPTION 'TEST FAILED: the AI wrote ai_memory with no app.session_scope';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 27j the AI cannot write ai_memory without app.session_scope: %', SQLERRM;
  END;
END $$;
-- 27d. GLOBAL_FACTS through mwf_app (global-memory.ts consolidateGlobalFacts writes it with a raw INSERT … ON CONFLICT
-- (user_id, kind) WHERE session_id IS NULL; this case also names doc_schema_version, which mwf_app may insert)
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false) \g /dev/null
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  INSERT INTO ai_memory (user_id, kind, doc, doc_schema_version) VALUES (current_setting('t.a_user')::uuid, 'GLOBAL_FACTS',
    '{"facts": [{"category": "People", "fact": "f"}], "consolidatedAt": "2026-11-01T11:00:01.000Z", "sessionCount": 2}', 1);
  RAISE NOTICE 'PASS 27d the consolidator''s GLOBAL_FACTS document is accepted';
  BEGIN
    UPDATE ai_memory SET doc = '{"facts": ["a bare string"]}' WHERE user_id = current_setting('t.a_user')::uuid AND kind = 'GLOBAL_FACTS';
    RAISE EXCEPTION 'TEST FAILED: a bare-string fact was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%ai_memory.global_facts v1: $.facts[0]: expected object, got string' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27e a bare-string global fact is refused: %', SQLERRM;
  END;
  BEGIN
    -- (a BEFORE trigger runs before the UNIQUE and CHECK constraints, so A's existing row is no obstacle)
    INSERT INTO ai_memory (user_id, kind, doc, doc_schema_version) VALUES (current_setting('t.a_user')::uuid, 'GLOBAL_FACTS', '{"facts": []}', 7);
    RAISE EXCEPTION 'TEST FAILED: an unknown schema version was stored';
  EXCEPTION WHEN SQLSTATE 'MWJ01' THEN
    IF SQLERRM <> 'json_schema ai_memory.global_facts version 7 does not exist' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27f an unknown doc_schema_version is refused (MWJ01): %', SQLERRM;
  END;
END $$;
-- 27i. the trigger fires on UPDATE OF kind and of doc_schema_version (the migrator's UPDATEs, rolled
--      back: no runtime role may write either, 27h)
\connect - mwf_user
BEGIN;
SELECT set_config('t.a_user', :'a_user', false), set_config('t.r_session', :'r_session', false) \g /dev/null
DO $$ BEGIN
  BEGIN
    UPDATE ai_memory SET kind = 'NOTABLE_FACTS' WHERE session_id = current_setting('t.r_session')::uuid AND user_id = current_setting('t.a_user')::uuid AND kind = 'SUMMARY';
    RAISE EXCEPTION 'TEST FAILED: a SUMMARY document was re-kinded NOTABLE_FACTS';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    IF SQLERRM NOT LIKE 'ai_memory.doc does not match json_schema ai_memory.notable_facts v1: %' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27i a change of kind re-checks the document against the new kind''s schema: %', SQLERRM;
  END;
  BEGIN
    UPDATE ai_memory SET doc_schema_version = 3 WHERE session_id = current_setting('t.r_session')::uuid AND user_id = current_setting('t.a_user')::uuid AND kind = 'SUMMARY';
    RAISE EXCEPTION 'TEST FAILED: an unknown version was stored on ai_memory';
  EXCEPTION WHEN SQLSTATE 'MWJ01' THEN
    IF SQLERRM <> 'json_schema ai_memory.summary version 3 does not exist' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 27j a change of doc_schema_version re-checks (MWJ01): %', SQLERRM;
  END;
END $$;
ROLLBACK;

-- 28. the envelope rule on the seven jsonb-envelope documents (the CHECK of their envelope domains,
--     app.jsonb_envelope_violation; feature_state.doc as mwf_app here, step 20 asserts all seven are typed so):
--     a sealed document is exactly {"$enc": <a v1 ciphertext>}; a keyless plaintext document (no "$enc" key)
--     still passes, as the ciphertext domain lets plaintext through. A refusal names the domain and the
--     constraint, never the value: no DETAIL (a table CHECK's "Failing row contains …" would echo the
--     plaintext); the reason is the function's.
\connect - mwf_app
SELECT set_config('t.a_user', :'a_user', false) \g /dev/null
DO $$
DECLARE
  -- [the refused document, the expected reason]
  bad jsonb := $j$[
    [{"$enc": "MY SECRET JOURNAL"},                                                     "\"$enc\" is not a ciphertext (plaintext in an envelope)"],
    [{"$enc": "enc:v1:MYSECRETJOURNAL:AAAA"},                                           "\"$enc\" is a malformed ciphertext"],
    [{"$enc": "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA", "note": "MY SECRET JOURNAL"}, "a sealed document has \"$enc\" as its only key"],
    [{"$enc": {"MY SECRET JOURNAL": 1}},                                                "\"$enc\" is not a string, got object"],
    ["MY SECRET JOURNAL",                                                               "not an object, got string"]
  ]$j$;
  c jsonb; v_msg text; v_detail text; v_hint text; i int := 0;
BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  INSERT INTO feature_state (user_id, feature, doc) VALUES (current_setting('t.a_user')::uuid, 'gratitude',
    '{"$enc": "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA"}');
  INSERT INTO feature_state (user_id, feature, doc) VALUES (current_setting('t.a_user')::uuid, 'people', '{"persons": []}');
  RAISE NOTICE 'PASS 28a a sealed envelope and a keyless plaintext document are accepted';
  FOR c IN SELECT * FROM jsonb_array_elements(bad) LOOP
    i := i + 1;
    BEGIN
      UPDATE feature_state SET doc = c -> 0 WHERE user_id = current_setting('t.a_user')::uuid AND feature = 'gratitude';
      RAISE EXCEPTION 'TEST FAILED: % was stored', c -> 0;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL, v_hint = PG_EXCEPTION_HINT;
      IF v_msg IS DISTINCT FROM 'value for domain feature_state_doc violates check constraint "jsonb_envelope"' THEN
        RAISE EXCEPTION 'TEST FAILED: case % message %', i, v_msg;
      END IF;
      IF app.jsonb_envelope_violation(c -> 0) IS DISTINCT FROM c ->> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: case % reason %', i, app.jsonb_envelope_violation(c -> 0);
      END IF;
      IF v_detail <> '' OR v_hint <> '' OR (v_msg || v_detail || v_hint) LIKE '%SECRET%' THEN
        RAISE EXCEPTION 'TEST FAILED: case % leaks the value (detail %)', i, v_detail;
      END IF;
    END;
  END LOOP;
  -- a new row, through the INSERT arm
  BEGIN
    INSERT INTO feature_state (user_id, feature, doc) VALUES (current_setting('t.a_user')::uuid, 'meditation', '{"$enc": "MY SECRET JOURNAL"}');
    RAISE EXCEPTION 'TEST FAILED: plaintext envelope inserted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM LIKE '%SECRET%' OR v_detail <> '' THEN RAISE EXCEPTION 'TEST FAILED: the INSERT refusal leaks the value'; END IF;
  END;
  RAISE NOTICE 'PASS 28b plaintext in, a malformed ciphertext in, a key beside, a non-string and a non-object envelope are refused (% cases and the INSERT arm), naming the reason and never the value (no DETAIL)', i;
END $$;
-- 28c. the four other envelope columns, with the superuser's writes (rolled back)
\connect - mwf_user
BEGIN;
DO $$ DECLARE v_detail text; v_n int := 0; BEGIN
  BEGIN
    UPDATE proposal_revision SET after = '{"$enc": "MY SECRET PLAN"}' WHERE id = (SELECT id FROM proposal_revision LIMIT 1);
    IF NOT FOUND THEN
      -- no revision in the fixture: a direct call of the rule stands in for the row
      IF app.jsonb_envelope_violation('{"$enc": "MY SECRET PLAN"}') IS NULL THEN RAISE EXCEPTION 'TEST FAILED: rule'; END IF;
    ELSE
      RAISE EXCEPTION 'TEST FAILED: plaintext envelope in proposal_revision.after';
    END IF;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'value for domain proposal_snapshot violates check constraint "jsonb_envelope"' OR v_detail <> '' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO reflection (user_id, summary_doc) VALUES ('00000000-0000-7e00-8000-0000000000b1', '{"$enc": "MY SECRET SUMMARY"}');
    RAISE EXCEPTION 'TEST FAILED: plaintext envelope in reflection.summary_doc';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'value for domain reflection_summary_doc violates check constraint "jsonb_envelope"' OR SQLERRM LIKE '%SECRET%' THEN RAISE; END IF;
    v_n := v_n + 1;
  END;
  BEGIN
    UPDATE follow_up_checkin SET payload = '"MY SECRET ANSWERS"' WHERE id = (SELECT id FROM follow_up_checkin LIMIT 1);
    IF FOUND THEN RAISE EXCEPTION 'TEST FAILED: a non-object payload'; END IF;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'value for domain checkin_payload violates check constraint "jsonb_envelope"' THEN RAISE; END IF;
    v_n := v_n + 1;
  END;
  IF v_n < 1 THEN RAISE EXCEPTION 'TEST FAILED: the reflection INSERT was not refused'; END IF;
  RAISE NOTICE 'PASS 28c the envelope rule on reflection (an INSERT), proposal_revision and follow_up_checkin (fixture rows when present): % refused, no value in the message', v_n;
END $$;
ROLLBACK;
-- 28d. typed domains (owner, 2026-11-23), as their writers: brain_activity.metadata (activity_metadata) is the
--      turn-trace.ts whitelist — what brain-service writes passes, a key outside it, a value of the wrong type
--      and a non-object are refused; model_id and turn_id bound the telemetry ids. As mwf_ai (its EXECUTE on
--      app.activity_metadata_violation is what the cast needs).
\connect - mwf_ai
DO $$
DECLARE
  ok jsonb := '[{"maxTokens": 4096, "toolCount": 1, "cacheReadInputTokens": 10, "toolInvocations": [{"name": "update_session_state"}, {"name": "other"}],
                 "contextSizes": {"pinnedTokens": 1, "summaryTokens": 2, "recentTokens": 3, "ragTokens": 0}},
                {"error": "ThrottlingException"},
                {"queryCount": 2, "turnTrace": {"totalDurationMs": 12.5, "modelUsed": "sonnet", "usedMock": false,
                  "steps": [{"name": "Dispatch (ignored)", "type": "dispatch", "startMs": 0, "durationMs": 3, "result": "other: unknown tag, fell through to the normal response", "status": "skipped"}]}},
                {}]';
  bad jsonb := '[{"prompt": "MY SECRET"}, {"maxTokens": "4096"}, {"error": "connect ECONNREFUSED 10.0.0.1:5432"},
                 {"toolInvocations": [{"name": "update_session_state", "input": "MY SECRET"}]},
                 {"contextSizes": {"pinnedTokens": 1, "note": 2}}, {"turnTrace": {"steps": [{"name": "x", "status": "MY SECRET"}]}},
                 {"turnTrace": {"text": "MY SECRET"}}, ["MY SECRET"], "MY SECRET"]';
  c jsonb; n int := 0;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(ok) LOOP PERFORM c::activity_metadata; END LOOP;
  FOR c IN SELECT * FROM jsonb_array_elements(bad) LOOP
    BEGIN
      PERFORM c::activity_metadata;
      RAISE EXCEPTION 'TEST FAILED: metadata % accepted', c;
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM <> 'value for domain activity_metadata violates check constraint "activity_metadata_whitelist"' THEN RAISE; END IF;
      n := n + 1;
    END;
  END LOOP;
  PERFORM 'global.anthropic.claude-haiku-4-5-20251001-v1:0'::model_id, 'amazon.titan-embed-text-v2:0'::model_id, 'system-retrieval'::model_id;
  PERFORM '0193d4a0-0000-7000-8000-000000000001-0193d4a0-0000-7000-8000-000000000002-consent-share'::turn_id;
  BEGIN PERFORM 'Claude Sonnet'::model_id; RAISE EXCEPTION 'TEST FAILED: model id with a space'; EXCEPTION WHEN check_violation THEN n := n + 1; END;
  BEGIN PERFORM 'a turn'::turn_id; RAISE EXCEPTION 'TEST FAILED: turn id with a space'; EXCEPTION WHEN check_violation THEN n := n + 1; END;
  RAISE NOTICE 'PASS 28d activity_metadata takes what brain-service writes and refuses % off-whitelist / ill-typed documents and ids', n;
END $$;
-- 28e. user_device.push_token (push_token) as mwf_app: an Expo token passes, a token with a space or a control
--      character is refused; wrapped_dek is 1-6144 bytes.
\connect - mwf_app
DO $$ DECLARE n int := 0; BEGIN
  PERFORM 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'::push_token;
  BEGIN PERFORM 'ExponentPushToken[ab cd]'::push_token; RAISE EXCEPTION 'TEST FAILED: a token with a space'; EXCEPTION WHEN check_violation THEN n := n + 1; END;
  BEGIN PERFORM (E'ExponentPushToken[ab\ncd]')::push_token; RAISE EXCEPTION 'TEST FAILED: a token with a newline'; EXCEPTION WHEN check_violation THEN n := n + 1; END;
  BEGIN PERFORM ''::push_token; RAISE EXCEPTION 'TEST FAILED: an empty token'; EXCEPTION WHEN check_violation THEN n := n + 1; END;
  PERFORM '\x01'::bytea::wrapped_dek;
  BEGIN PERFORM ''::bytea::wrapped_dek; RAISE EXCEPTION 'TEST FAILED: an empty wrapped key'; EXCEPTION WHEN check_violation THEN n := n + 1; END;
  BEGIN PERFORM decode(repeat('00', 6145), 'hex')::wrapped_dek; RAISE EXCEPTION 'TEST FAILED: a 6145-byte wrapped key'; EXCEPTION WHEN check_violation THEN n := n + 1; END;
  RAISE NOTICE 'PASS 28e push_token refuses a space, a control character and empty (% refusals with wrapped_dek''s bounds)', n;
END $$;

-- 29. app.json_schema is reference data: mwf_app and mwf_ai read it (the invoker-rights triggers
--     do) and write nothing.
\connect - mwf_app
DO $$ BEGIN
  IF (SELECT count(*) FROM app.json_schema) <> 4 THEN RAISE EXCEPTION 'TEST FAILED: mwf_app reads % schemas', (SELECT count(*) FROM app.json_schema); END IF;
  BEGIN
    INSERT INTO app.json_schema (name, version, schema) VALUES ('user_preferences', 2, '{}');
    RAISE EXCEPTION 'TEST FAILED: mwf_app added a schema';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE app.json_schema SET schema = '{}' WHERE name = 'user_preferences';
    RAISE EXCEPTION 'TEST FAILED: mwf_app rewrote a schema';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 29a mwf_app reads the 4 schemas and can neither add nor rewrite one';
END $$;
\connect - mwf_ai
DO $$ BEGIN
  BEGIN
    DELETE FROM app.json_schema WHERE name = 'user_preferences';
    RAISE EXCEPTION 'TEST FAILED: mwf_ai deleted a schema';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 29b mwf_ai cannot delete a schema: %', SQLERRM;
  END;
END $$;
-- 29c. a schema outside the subset cannot be seeded (the migrator's INSERT, rolled back)
\connect - mwf_user
BEGIN;
DO $$ DECLARE v_con text; BEGIN
  INSERT INTO app.json_schema (name, version, schema) VALUES ('user_preferences', 2, '{"type": "object", "minProperties": 1}');
  RAISE EXCEPTION 'TEST FAILED: a schema with an unsupported keyword was seeded';
EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
  IF v_con <> 'json_schema_schema_check' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 29c a schema with an unsupported keyword is refused by %', v_con;
END $$;
ROLLBACK;


-- 30. work-k5fk.10.5: the request path's two-party writes are definers (design note §7 row 9b). On S (…05e6): A (…a1,
--     conversation …08a1) and B (…b1, …08b1); att_a is A→B (subject B), att_b is B→A (subject A). Rolled back. Each
--     refusal is pinned by its control: the same call with only the checked fact changed succeeds. The setup is the
--     superuser's (both rounds REVEALED, an ACTIVE session); every call runs as mwf_app (SET SESSION AUTHORIZATION:
--     session_user is mwf_app, as the definers' app arm reads it), with the identity bound per call.
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (30: setup as the superuser, the calls as mwf_app)';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null
-- The latest round of each direction (test 10 resubmitted one; the earlier rounds are history).
SELECT set_config('t.att_a', (SELECT e.id::text FROM empathy_attempt e WHERE e.session_id = current_setting('t.r_session')::uuid
                              AND e.author_user_id = current_setting('t.a_user')::uuid ORDER BY e.round DESC LIMIT 1), false),
       set_config('t.att_b', (SELECT e.id::text FROM empathy_attempt e WHERE e.session_id = current_setting('t.r_session')::uuid
                              AND e.author_user_id = current_setting('t.b_user')::uuid ORDER BY e.round DESC LIMIT 1), false) \g /dev/null
BEGIN;
UPDATE session SET status = 'ACTIVE', resolved_at = NULL WHERE id = current_setting('t.r_session')::uuid;
UPDATE participant SET left_at = NULL WHERE session_id = current_setting('t.r_session')::uuid;
UPDATE empathy_attempt SET status = 'REVEALED', revealed_at = coalesce(revealed_at, now() - interval '1 hour'),
       delivery_status = 'PENDING', delivered_at = NULL, seen_at = NULL
WHERE id IN (current_setting('t.att_a')::uuid, current_setting('t.att_b')::uuid);
INSERT INTO invitation (id, session_id, invited_by_user_id, status, expires_at)
VALUES ('00000000-0000-7e00-8000-0000000006f1', current_setting('t.r_session')::uuid, current_setting('t.a_user')::uuid,
        'DECLINED', now() + interval '1 day');
SET SESSION AUTHORIZATION mwf_app;
DO $$ DECLARE v_seq int; v_sender uuid; v_at timestamptz; v_n int;
  conv_a uuid := '00000000-0000-7e00-8000-0000000008a1'; conv_b uuid := '00000000-0000-7e00-8000-0000000008b1';
  a uuid := current_setting('t.a_user')::uuid; b uuid := current_setting('t.b_user')::uuid;
  att_a uuid := current_setting('t.att_a')::uuid; att_b uuid := current_setting('t.att_b')::uuid;
  s uuid := current_setting('t.r_session')::uuid;
BEGIN
  -- 30a. A, the subject of B's revealed round, delivers feedback on it into B's conversation: role USER, sender A
  PERFORM set_config('app.current_user_id', a::text, true);
  SELECT d.seq INTO v_seq FROM app.deliver_message(conv_b, a, 'VALIDATION_FEEDBACK', 'feedback from A', att_b, NULL) d;
  SELECT m.sender_user_id INTO v_sender FROM message m WHERE m.conversation_id = conv_b AND m.seq = v_seq;
  IF v_sender IS DISTINCT FROM a THEN RAISE EXCEPTION 'TEST FAILED: the delivery is not A''s'; END IF;
  RAISE NOTICE 'PASS 30a the subject delivers feedback on a revealed round into its author''s conversation (seq %)', v_seq;
  -- 30b. the identity is the check that refuses: A cannot deliver as B (B present, B's feedback on att_a into A's
  --      conversation); the same call with B's identity is delivered
  BEGIN
    PERFORM app.deliver_message(conv_a, b, 'VALIDATION_FEEDBACK', 'x', att_a, NULL);
    RAISE EXCEPTION 'TEST FAILED: A delivered as B';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 30b an item is delivered only as the caller: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', b::text, true);
  PERFORM app.deliver_message(conv_a, b, 'VALIDATION_FEEDBACK', 'feedback from B', att_a, NULL);
  RAISE NOTICE 'PASS 30b control: the same delivery as B, the identity, is written';
  PERFORM set_config('app.current_user_id', a::text, true);
  -- 30c. never into one's own conversation; never a kind but VALIDATION_FEEDBACK from the request path (F1)
  BEGIN
    PERFORM app.deliver_message(conv_a, a, 'VALIDATION_FEEDBACK', 'x', att_b, NULL);
    RAISE EXCEPTION 'TEST FAILED: A delivered into their own conversation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 30c a delivery goes into another participant''s conversation: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.deliver_message(conv_b, a, 'SHARED_CONTEXT', 'x', att_b, NULL);
    RAISE EXCEPTION 'TEST FAILED: the app delivered SHARED_CONTEXT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 30d the app delivers VALIDATION_FEEDBACK only (SHARED_CONTEXT: %)', SQLERRM;
  END;
  BEGIN
    PERFORM app.deliver_message(conv_b, a, 'EMPATHY_STATEMENT', 'x', att_b, NULL);
    RAISE EXCEPTION 'TEST FAILED: the app delivered an EMPATHY_STATEMENT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 30d the app delivers VALIDATION_FEEDBACK only (EMPATHY_STATEMENT: %)', SQLERRM;
  END;
  -- 30e. the source must be a revealed round whose subject is the caller and whose author owns the conversation
  BEGIN
    PERFORM app.deliver_message(conv_b, a, 'VALIDATION_FEEDBACK', 'x', NULL, NULL);
    RAISE EXCEPTION 'TEST FAILED: feedback with no source round';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 30e feedback names its round: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.deliver_message(conv_b, a, 'VALIDATION_FEEDBACK', 'x', att_a, NULL);
    RAISE EXCEPTION 'TEST FAILED: feedback on a round A is not the subject of';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 30e feedback only by the round''s subject: %', SQLERRM;
  END;
  -- 30f. the instant is bounded: neither backdated nor in the future (F1)
  BEGIN
    PERFORM app.deliver_message(conv_b, a, 'VALIDATION_FEEDBACK', 'x', att_b, '2001-01-01');
    RAISE EXCEPTION 'TEST FAILED: a backdated delivery';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 30f a backdated instant is refused: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.deliver_message(conv_b, a, 'VALIDATION_FEEDBACK', 'x', att_b, now() + interval '1 hour');
    RAISE EXCEPTION 'TEST FAILED: a future delivery';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 30f a future instant is refused: %', SQLERRM;
  END;
  -- 30g. an outsider delivers into nobody's conversation
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  BEGIN
    PERFORM app.deliver_message(conv_b, current_setting('t.outsider')::uuid, 'VALIDATION_FEEDBACK', 'x', att_b, NULL);
    RAISE EXCEPTION 'TEST FAILED: an outsider delivered';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 30g an outsider cannot deliver: %', SQLERRM;
  END;
  -- 30h. A reaches a system milestone for B, once; never a self-assertable one; an outsider reaches none
  PERFORM set_config('app.current_user_id', a::text, true);
  IF NOT app.reach_milestone(s, b, 'closed') THEN RAISE EXCEPTION 'TEST FAILED: reach_milestone recorded nothing'; END IF;
  IF app.reach_milestone(s, b, 'closed') THEN RAISE EXCEPTION 'TEST FAILED: reach_milestone recorded twice'; END IF;
  RAISE NOTICE 'PASS 30h a participant reaches a system milestone for the partner, once';
  BEGIN
    PERFORM app.reach_milestone(s, b, 'compact_signed');
    RAISE EXCEPTION 'TEST FAILED: A asserted B''s self-assertable milestone';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 30h a self-assertable milestone is never reached through reach_milestone: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  BEGIN
    PERFORM app.reach_milestone(s, b, 'paused');
    RAISE EXCEPTION 'TEST FAILED: an outsider reached a milestone';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 30h an outsider reaches no milestone: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.session_resume(s);
    RAISE EXCEPTION 'TEST FAILED: an outsider resumed a session';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 30i an outsider cannot resume a session: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.share_offers_expire(s, ARRAY[a, b]);
    RAISE EXCEPTION 'TEST FAILED: an outsider expired the offers';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 30i an outsider cannot expire a session''s offers: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', a::text, true);
  PERFORM app.share_offers_expire(s, ARRAY[a, b]);
  RAISE NOTICE 'PASS 30i control: a participant expires the session''s open offers';
  -- 30j. a caller's own sign-in subject, never another's
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a1', true);
  IF app.identity_subject('clerk') IS DISTINCT FROM 'user_ts7cAda' THEN RAISE EXCEPTION 'TEST FAILED: identity_subject is not Ada''s'; END IF;
  PERFORM set_config('app.current_user_id', '', true);
  IF app.identity_subject('clerk') IS NOT NULL THEN RAISE EXCEPTION 'TEST FAILED: identity_subject with no identity'; END IF;
  RAISE NOTICE 'PASS 30j identity_subject reads the caller''s own subject only';
  -- 30k. the subject stamps the delivery of the author's revealed round; the author cannot; stamps only move forward
  --      and their instant is bounded (F10)
  PERFORM set_config('app.current_user_id', b::text, true);
  BEGIN
    PERFORM app.empathy_mark_delivery(att_b, 'SEEN');
    RAISE EXCEPTION 'TEST FAILED: the author stamped their own attempt';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 30k only the subject stamps an attempt''s delivery: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', a::text, true);
  PERFORM app.empathy_mark_delivery(att_b, 'SEEN', '1999-01-01');
  PERFORM app.empathy_mark_delivery(att_b, 'DELIVERED');
  SELECT e.seen_at INTO v_at FROM empathy_attempt e WHERE e.id = att_b;
  IF (SELECT e.delivery_status::text FROM empathy_attempt e WHERE e.id = att_b) <> 'SEEN' THEN
    RAISE EXCEPTION 'TEST FAILED: SEEN was downgraded to DELIVERED';
  END IF;
  IF v_at < now() - interval '11 minutes' THEN RAISE EXCEPTION 'TEST FAILED: the stamp was backdated to %', v_at; END IF;
  -- work-k5fk.9 (D4): seen implies delivered
  IF (SELECT e.delivered_at FROM empathy_attempt e WHERE e.id = att_b) IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED: a SEEN round has no delivered_at';
  END IF;
  RAISE NOTICE 'PASS 30l the subject stamps SEEN (and delivered); a later DELIVERED does not downgrade it; the instant is not backdated';
  -- 30m. the session of a declined invitation ends only while it is CREATED / INVITED: an ACTIVE one is left alone
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  PERFORM app.session_abandon_declined('00000000-0000-7e00-8000-0000000006f1');
  IF (SELECT st.status::text FROM session st WHERE st.id = s) <> 'ACTIVE' THEN
    RAISE EXCEPTION 'TEST FAILED: a declined invitation ended an ACTIVE session';
  END IF;
  RAISE NOTICE 'PASS 30m a declined invitation leaves an ACTIVE session alone';
END $$;
RESET SESSION AUTHORIZATION;
-- 30n. stamping a round that was never revealed is refused (F10): B's round back to READY, A tries
UPDATE empathy_attempt SET status = 'READY', revealed_at = NULL, delivery_status = 'PENDING', delivered_at = NULL, seen_at = NULL
WHERE id = current_setting('t.att_b')::uuid;
SET SESSION AUTHORIZATION mwf_app;
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  BEGIN
    PERFORM app.empathy_mark_delivery(current_setting('t.att_b')::uuid, 'SEEN');
    RAISE EXCEPTION 'TEST FAILED: an unrevealed round was stamped';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 30n an unrevealed round is never stamped: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.deliver_message('00000000-0000-7e00-8000-0000000008b1', current_setting('t.a_user')::uuid,
                                'VALIDATION_FEEDBACK', 'x', current_setting('t.att_b')::uuid, NULL);
    RAISE EXCEPTION 'TEST FAILED: feedback on an unrevealed round';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 30n feedback only on a revealed round: %', SQLERRM;
  END;
END $$;
ROLLBACK;

-- 31. app.session_scope is required for the AI (t_session_scope, Q20): as mwf_ai, an AI line goes only into the
--     session its transaction names, and the AI never writes a participant's line. Rolled back.
\connect - mwf_ai
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
BEGIN;
DO $$ BEGIN
  BEGIN
    INSERT INTO message (conversation_id, session_id, role, kind, content)
    VALUES ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000005e6', 'AI', 'CHAT', 'no scope');
    RAISE EXCEPTION 'TEST FAILED: the AI wrote with no app.session_scope';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 31a no scope, no AI write: %', SQLERRM;
  END;
  PERFORM set_config('app.session_scope', '00000000-0000-7e00-8000-0000000005e1', true);
  BEGIN
    INSERT INTO message (conversation_id, session_id, role, kind, content)
    VALUES ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000005e6', 'AI', 'CHAT', 'other scope');
    RAISE EXCEPTION 'TEST FAILED: the AI wrote outside its scope';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 31b another session''s scope, no AI write: %', SQLERRM;
  END;
  PERFORM set_config('app.session_scope', '00000000-0000-7e00-8000-0000000005e6', true);
  -- work-k5fk.10.7: in its scope, the AI acting for no one — or for someone outside it (C) — writes no line
  BEGIN
    INSERT INTO message (conversation_id, session_id, role, kind, content)
    VALUES ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000005e6', 'AI', 'CHAT', 'no actor');
    RAISE EXCEPTION 'TEST FAILED: the AI wrote a line acting for no one';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 31b-0 the AI acting for no one writes no line: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    INSERT INTO message (conversation_id, session_id, role, kind, content)
    VALUES ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000005e6', 'AI', 'CHAT', 'outsider');
    RAISE EXCEPTION 'TEST FAILED: the AI wrote a line acting for a non-participant';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 31b-1 the AI acting for a non-participant writes no line: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a1', true);
  INSERT INTO message (conversation_id, session_id, role, kind, content)
  VALUES ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000005e6', 'AI', 'CHAT', 'in scope');
  RAISE NOTICE 'PASS 31c the AI writes its line in its scope';
  BEGIN
    INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content)
    VALUES ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000a1',
            'USER', 'CHAT', 'as A');
    RAISE EXCEPTION 'TEST FAILED: the AI wrote a participant''s line';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 31d the AI never writes a participant''s line: %', SQLERRM;
  END;
END $$;
ROLLBACK;

-- 32. the AI's definer arms do only what its call sites do (F2, F3): on S, scoped. Rolled back.
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (32: setup as the superuser, the calls as mwf_ai)';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false) \g /dev/null
-- The latest round of each direction (test 10 resubmitted one; the earlier rounds are history).
SELECT set_config('t.att_a', (SELECT e.id::text FROM empathy_attempt e WHERE e.session_id = current_setting('t.r_session')::uuid
                              AND e.author_user_id = current_setting('t.a_user')::uuid ORDER BY e.round DESC LIMIT 1), false),
       set_config('t.att_b', (SELECT e.id::text FROM empathy_attempt e WHERE e.session_id = current_setting('t.r_session')::uuid
                              AND e.author_user_id = current_setting('t.b_user')::uuid ORDER BY e.round DESC LIMIT 1), false) \g /dev/null
BEGIN;
UPDATE empathy_attempt SET status = 'REVEALED', revealed_at = coalesce(revealed_at, now() - interval '1 hour')
WHERE id = current_setting('t.att_a')::uuid;
UPDATE empathy_attempt SET status = 'HELD', revealed_at = NULL WHERE id = current_setting('t.att_b')::uuid;
SET SESSION AUTHORIZATION mwf_ai;
DO $$ BEGIN
  PERFORM set_config('app.session_scope', current_setting('t.r_session'), true);
  -- 32-0 (review F6). the AI's scope is not enough: it acts for a participant of the session, or moves nothing
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'READY');
    RAISE EXCEPTION 'TEST FAILED: the AI acting for no one moved a round';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 32-0 the AI acting for no one moves no round: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-00000000dead', true);
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'READY');
    RAISE EXCEPTION 'TEST FAILED: the AI acting for a non-participant moved a round';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 32-0 the AI acting for a non-participant moves no round: %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  -- 32a. the AI never resubmits a round (SUPERSEDED writes the author's next round) nor reviews a revealed one
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'SUPERSEDED', 'AI WROTE THIS');
    RAISE EXCEPTION 'TEST FAILED: the AI resubmitted a round';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 32a the AI cannot supersede a round: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'VALIDATED');
    RAISE EXCEPTION 'TEST FAILED: the AI validated a revealed round';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 32a the AI cannot validate a revealed round: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'REFINING');
    RAISE EXCEPTION 'TEST FAILED: the AI sent a revealed round back to refining';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 32a the AI cannot move a revealed round to REFINING: %', SQLERRM;
  END;
  -- control: the reconciler's own move
  PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'READY');
  RAISE NOTICE 'PASS 32a control: the AI moves a HELD round to READY';
  -- 32b. the AI delivers only SHARED_CONTEXT, and only for an ACCEPTED offer whose subject is the sender (F3)
  BEGIN
    PERFORM app.deliver_message('00000000-0000-7e00-8000-0000000008a1', current_setting('t.b_user')::uuid,
                                'EMPATHY_STATEMENT', 'as B', current_setting('t.att_b')::uuid, NULL);
    RAISE EXCEPTION 'TEST FAILED: the AI delivered an EMPATHY_STATEMENT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 32b the AI delivers SHARED_CONTEXT only: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.deliver_message('00000000-0000-7e00-8000-0000000008a1', current_setting('t.b_user')::uuid,
                                'SHARED_CONTEXT', 'as B', NULL, NULL);
    RAISE EXCEPTION 'TEST FAILED: the AI delivered shared context with no accepted offer';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 32b shared context needs the sender''s ACCEPTED offer: %', SQLERRM;
  END;
END $$;
ROLLBACK;

-- 33. the worker (F6): its session_set_status arm only ends sessions; its purge only deletes ARCHIVED sessions; its
--     follow_up INSERT is scoped. On S. Rolled back.
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (33: setup as the superuser, the calls as mwf_worker)';
SELECT set_config('t.r_session', :'r_session', false) \g /dev/null
BEGIN;
UPDATE session SET status = 'INVITED', resolved_at = NULL WHERE id = current_setting('t.r_session')::uuid;
SET SESSION AUTHORIZATION mwf_worker;
DO $$ BEGIN
  PERFORM set_config('app.session_scope', current_setting('t.r_session'), true);
  BEGIN
    PERFORM app.session_set_status(current_setting('t.r_session')::uuid, 'ACTIVE');
    RAISE EXCEPTION 'TEST FAILED: the worker activated a session';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 33a the worker cannot move a session to ACTIVE: %', SQLERRM;
  END;
  -- work-k5fk.10.29 R3: a live session is not the worker's to delete — worker_purge does not reach it (no row;
  -- t_session_purge, behind it, would refuse a non-ARCHIVED one)
  DELETE FROM session WHERE id = current_setting('t.r_session')::uuid;
  IF FOUND THEN RAISE EXCEPTION 'TEST FAILED: the worker deleted a live session'; END IF;
  RAISE NOTICE 'PASS 33b the worker purges only ARCHIVED sessions past the window (a live one: no row)';
  PERFORM set_config('app.session_scope', '', true);
  BEGIN
    INSERT INTO follow_up (session_id, type, scope, status, scheduled_for, summary)
    VALUES (current_setting('t.r_session')::uuid, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'SCHEDULED', now(), 'unscoped');
    RAISE EXCEPTION 'TEST FAILED: the worker scheduled a follow-up with no scope';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 33c the worker''s follow_up INSERT is scoped: %', SQLERRM;
  END;
  -- control: ending the session is the worker's
  PERFORM set_config('app.session_scope', current_setting('t.r_session'), true);
  PERFORM app.session_set_status(current_setting('t.r_session')::uuid, 'ABANDONED');
  RAISE NOTICE 'PASS 33a control: the worker abandons the session in its scope';
END $$;
ROLLBACK;

-- 34. account deletion of a participant who already left a live session (F8): the walk ends the session itself. On S:
--     B left (left_at), S still ACTIVE, B deletes the account as mwf_app. Rolled back.
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (34: setup as the superuser, the call as mwf_app)';
SELECT set_config('t.b_user', :'b_user', false), set_config('t.r_session', :'r_session', false) \g /dev/null
BEGIN;
UPDATE session SET status = 'ACTIVE', resolved_at = NULL WHERE id = current_setting('t.r_session')::uuid;
UPDATE participant SET left_at = now() - interval '1 day'
WHERE session_id = current_setting('t.r_session')::uuid AND user_id = current_setting('t.b_user')::uuid;
DO $$ BEGIN
  EXECUTE 'SET SESSION AUTHORIZATION mwf_app';
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  PERFORM app.anonymize_user_account(current_setting('t.b_user')::uuid);
  EXECUTE 'RESET SESSION AUTHORIZATION';
  IF (SELECT st.status::text FROM session st WHERE st.id = current_setting('t.r_session')::uuid) <> 'ABANDONED' THEN
    RAISE EXCEPTION 'TEST FAILED: the leaver''s live session was not ended by the walk';
  END IF;
  RAISE NOTICE 'PASS 34 a participant who already left a live session deletes the account; the walk ends the session';
END $$;
ROLLBACK;

\echo 'functions-caller-tests: ALL PASSED'
