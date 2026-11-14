-- ============================================================================
-- functions-caller-tests.sql — the app.* writers and triggers, exercised per
-- caller (TS-7 fix round 1; re-based on the target_shape_baseline by TS-7c,
-- OD7). Run by run-baseline.sh on a throwaway clone of a ts7_* database that
-- the baseline built and seed-target-fixture.sql seeded (it changes data);
-- run-baseline.sh adds test 18 (a second migrate deploy is a no-op), which
-- needs the Prisma CLI. Every caller arm runs in a session that LOGGED
-- IN as mwf_app, mwf_job or mwf_auth (\connect), never as the superuser (20, the
-- structural key checks, run as the superuser by design); identity is
-- set_config('app.current_user_id', <user>, true), as the request layer does.
--
-- Setup (superuser, before any caller arm): ids via \gset. mwf_app holds only
-- the baseline's own grants (tables.sql, work-k5fk.10.2), so a caller arm
-- that writes as mwf_app proves the grant as well as the function or trigger.
-- An expected refusal is caught by its SQLSTATE and logged PASS; anything else
-- (or a refusal that does not happen: 'TEST FAILED') stops the run. Most
-- refusals come from the function or trigger under test; 6a–6d (mwf_job's
-- narrowed column grants) and 13b (no EXECUTE on need_share) are grant
-- refusals, by design — 13d reaches need_share's own job check.
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
SELECT a.id AS att_a FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id WHERE p.user_id = :'a_user' AND p.session_id = :'r_session' \gset
SELECT a.id AS att_b FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id WHERE p.user_id = :'b_user' AND p.session_id = :'r_session' \gset
SELECT p.id AS b_participant FROM participant p WHERE p.user_id = :'b_user' AND p.session_id = :'r_session' \gset
SELECT p.id AS a_participant FROM participant p WHERE p.user_id = :'a_user' AND p.session_id = :'r_session' \gset
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
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null

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
  SELECT count(*) INTO n FROM v_empathy_direction_status v JOIN participant p ON p.id = v.author_participant_id
  WHERE p.session_id = current_setting('t.r_session')::uuid;
  IF n <> 0 OR app.is_member(current_setting('t.r_session')::uuid) OR app.my_participant(current_setting('t.r_session')::uuid) IS NOT NULL
     OR app.is_co_participant(current_setting('t.b_participant')::uuid) THEN
    RAISE EXCEPTION 'TEST FAILED: a non-member sees the session (% direction rows)', n;
  END IF;
  RAISE NOTICE 'PASS 3b non-member sees no direction status, is not a member, has no participant, is no co-participant';
END $$;

-- 4. only the job reveals: the author of a READY attempt cannot
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.b_user'), true);
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'REVEALED');
    RAISE EXCEPTION 'TEST FAILED: the author revealed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 4 the author cannot reveal READY→REVEALED: %', SQLERRM;
  END;
END $$;

-- ============================ as mwf_job ======================================
\connect - mwf_job
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null

-- 5. the reveal gate: B→A is READY but A→B is AWAITING_SHARING → refused
DO $$ BEGIN
  BEGIN
    PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'REVEALED');
    RAISE EXCEPTION 'TEST FAILED: revealed before every direction was READY';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 5 reveal refused until every direction is READY: %', SQLERRM;
  END;
END $$;

-- 6. the job's narrowed privileges (C3): no routing-column UPDATE, no U-class reads
DO $$ BEGIN
  BEGIN
    UPDATE participant SET user_id = user_id WHERE id = current_setting('t.b_participant')::uuid;
    RAISE EXCEPTION 'TEST FAILED: mwf_job updated participant.user_id';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6a mwf_job cannot UPDATE participant.user_id: %', SQLERRM;
  END;
  BEGIN
    UPDATE empathy_attempt SET author_participant_id = author_participant_id WHERE id = current_setting('t.att_a')::uuid;
    RAISE EXCEPTION 'TEST FAILED: mwf_job updated empathy_attempt.author_participant_id';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6b mwf_job cannot UPDATE empathy_attempt.author_participant_id: %', SQLERRM;
  END;
  BEGIN
    PERFORM title FROM reflection LIMIT 1;
    RAISE EXCEPTION 'TEST FAILED: mwf_job read reflection.title';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6c mwf_job cannot read reflection content: %', SQLERRM;
  END;
  BEGIN
    PERFORM content FROM user_memory LIMIT 1;
    RAISE EXCEPTION 'TEST FAILED: mwf_job read user_memory.content';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6d mwf_job cannot read user_memory content: %', SQLERRM;
  END;
END $$;

-- ============================ as mwf_app ======================================
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null
-- 7. the AUTHOR moves own AWAITING_SHARING → READY
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', current_setting('t.a_user'), true);
  PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'READY');
  RAISE NOTICE 'PASS 7 author moves own attempt AWAITING_SHARING→READY';
END $$;

-- ============================ as mwf_job ======================================
\connect - mwf_job
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null
-- 8. the job reveals both; the subject's conversation gains exactly one copy, even when the reveal is repeated
DO $$ DECLARE n int; BEGIN
  PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'REVEALED');
  PERFORM app.empathy_set_status(current_setting('t.att_b')::uuid, 'REVEALED');
  PERFORM app.empathy_set_status(current_setting('t.att_a')::uuid, 'REVEALED');
  SELECT count(*) INTO n FROM message m JOIN conversation c ON c.id = m.conversation_id
  WHERE c.participant_id = current_setting('t.b_participant')::uuid AND m.kind = 'EMPATHY_STATEMENT'
    AND m.source_attempt_id = current_setting('t.att_a')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'TEST FAILED: % delivered copies in the subject''s conversation', n; END IF;
  RAISE NOTICE 'PASS 8 job reveals once all directions are READY; subject''s conversation holds exactly 1 copy (after a repeated reveal)';
END $$;

-- ============================ as mwf_app ======================================
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null
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

-- 12e. mwf_app holds no EXECUTE on anonymize_* (work-k5fk.10.2: the job is their only caller,
--      account-deletion.ts / session-deletion.ts). 12a–d, 13a and 15 then test the functions'
--      own identity checks against a non-job caller: EXECUTE is granted to mwf_app on this
--      throwaway clone (superuser) and revoked after 15, as 13d does for need_share.
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000c1');
    RAISE EXCEPTION 'TEST FAILED: mwf_app ran anonymize_user_account';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 12e anonymize_user_account is not mwf_app''s (no EXECUTE): %', SQLERRM;
  END;
  BEGIN
    PERFORM app.anonymize_user_in_session('00000000-0000-7e00-8000-0000000005e1', NULL);
    RAISE EXCEPTION 'TEST FAILED: mwf_app ran anonymize_user_in_session';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 12f anonymize_user_in_session is not mwf_app''s (no EXECUTE): %', SQLERRM;
  END;
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
  UPDATE "user" SET first_name = 'Ada B.' WHERE id = '00000000-0000-7e00-8000-0000000000a1';
  IF NOT FOUND THEN RAISE EXCEPTION 'TEST FAILED: the profile edit updated no row'; END IF;
  RAISE NOTICE 'PASS 21i mwf_app still edits the names (profile edit)';
END $$;
ROLLBACK;
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: temporary GRANT EXECUTE ON app.anonymize_* TO mwf_app)';
GRANT EXECUTE ON FUNCTION app.anonymize_user_account(uuid), app.anonymize_user_in_session(uuid, uuid) TO mwf_app;
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null

-- 12. anonymize_*: no identity, another user → not found; a modeled-style NULL comparison never passes
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '', true);
  BEGIN
    PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000d1');
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_account with no identity';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 12a anonymize_user_account with no identity: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.anonymize_user_in_session('00000000-0000-7e00-8000-0000000005e1',
              (SELECT id FROM participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND user_id = '00000000-0000-7e00-8000-0000000000d1'));
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
    PERFORM app.anonymize_user_in_session('00000000-0000-7e00-8000-0000000005e1',
              (SELECT id FROM participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND user_id = '00000000-0000-7e00-8000-0000000000d1'));
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_in_session of another user';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 12d anonymize_user_in_session of another user: %', SQLERRM;
  END;
END $$;

-- 13. the C1 attack: temp objects shadowing pg_roles and participant change nothing
CREATE TEMP VIEW pg_roles AS SELECT session_user::name AS rolname, true AS rolsuper;
CREATE TEMP TABLE participant (id uuid, session_id uuid, user_id uuid, kind text, left_at timestamptz);
INSERT INTO pg_temp.participant VALUES (gen_random_uuid(), '00000000-0000-7e00-8000-0000000005e1', current_setting('t.outsider')::uuid, 'human', NULL);
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000d1');
    RAISE EXCEPTION 'TEST FAILED: temp pg_roles made mwf_app the job';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 13a temp-view pg_roles attack: anonymize another user still refused: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.need_share('00000000-0000-7e00-8000-0000000000e1', 'x');
    RAISE EXCEPTION 'TEST FAILED: mwf_app ran need_share';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 13b need_share stays the job''s (refused by the missing EXECUTE grant): %', SQLERRM;
  END;
  PERFORM set_config('app.current_user_id', current_setting('t.outsider'), true);
  IF app.is_member('00000000-0000-7e00-8000-0000000005e1') THEN
    RAISE EXCEPTION 'TEST FAILED: a temp participant table made an outsider a member';
  END IF;
  RAISE NOTICE 'PASS 13c temp participant table does not make an outsider a member';
END $$;
DROP VIEW pg_temp.pg_roles;
DROP TABLE pg_temp.participant;

-- 13d. need_share's own job check, reached by a non-job caller: grant EXECUTE
--      to mwf_app on this throwaway clone (superuser), call it as mwf_app, revoke.
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: temporary GRANT EXECUTE ON app.need_share TO mwf_app)';
GRANT EXECUTE ON FUNCTION app.need_share(uuid, text) TO mwf_app;
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null
DO $$ BEGIN
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true);
  BEGIN
    PERFORM app.need_share('00000000-0000-7e00-8000-0000000000e1', 'x');
    RAISE EXCEPTION 'TEST FAILED: need_share ran for mwf_app with EXECUTE granted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 13d need_share refuses a non-job caller by its own check (EXECUTE granted): %', SQLERRM;
  END;
END $$;
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: REVOKE EXECUTE ON app.need_share FROM mwf_app)';
REVOKE EXECUTE ON FUNCTION app.need_share(uuid, text) FROM mwf_app;
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null

-- 14. T-review-subject: a review by a non-subject is refused (I5)
DO $$ BEGIN
  BEGIN
    INSERT INTO empathy_review (attempt_id, reviewer_participant_id, validated)
    VALUES (current_setting('t.att_a')::uuid, current_setting('t.a_participant')::uuid, true);
    RAISE EXCEPTION 'TEST FAILED: a non-subject reviewed';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 14 review by a non-subject refused: %', SQLERRM;
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

\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: REVOKE EXECUTE ON app.anonymize_* FROM mwf_app)';
REVOKE EXECUTE ON FUNCTION app.anonymize_user_account(uuid), app.anonymize_user_in_session(uuid, uuid) FROM mwf_app;

-- ============================ as mwf_job ======================================
\connect - mwf_job
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
-- 16. need_share is idempotent and refuses a deleted need
DO $$ DECLARE n int; BEGIN
  PERFORM app.need_share('00000000-0000-7e00-8000-0000000000e1', 'again');
  SELECT count(*) INTO n FROM need_share WHERE need_id = '00000000-0000-7e00-8000-0000000000e1';
  IF n <> 1 THEN RAISE EXCEPTION 'TEST FAILED: need_share not idempotent (% rows)', n; END IF;
  RAISE NOTICE 'PASS 16a need_share on an already shared need is a no-op';
  BEGIN
    PERFORM app.need_share('00000000-0000-7e00-8000-0000000000ff', 'x');
    RAISE EXCEPTION 'TEST FAILED: need_share on a missing need';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 16b need_share refuses a missing/deleted/superseded need: %', SQLERRM;
  END;
END $$;

-- 17. ruling R17 (rolled back): anonymize_user_in_session also deletes the
--     session's NULL-participant brain_activity rows — history that cannot
--     be attributed (…ba1 in X). History of other sessions (…ba2 in S) and
--     reflection telemetry (…ba3, no session) stay.
BEGIN;
DO $$ DECLARE x_before int; s_before int; refl_before int; BEGIN
  SELECT count(*) INTO x_before FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND participant_id IS NULL;
  SELECT count(*) INTO s_before FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND participant_id IS NULL;
  SELECT count(*) INTO refl_before FROM brain_activity WHERE session_id IS NULL AND reflection_id IS NOT NULL;
  IF x_before = 0 OR s_before = 0 OR refl_before = 0 THEN
    RAISE EXCEPTION 'TEST FAILED: setup — expected NULL-participant history in X (%), in S (%) and reflection telemetry (%)', x_before, s_before, refl_before;
  END IF;
  PERFORM app.anonymize_user_in_session('00000000-0000-7e00-8000-0000000005e1',
            (SELECT p.id FROM participant p WHERE p.session_id = '00000000-0000-7e00-8000-0000000005e1' AND p.user_id = '00000000-0000-7e00-8000-0000000000d1'));
  IF EXISTS (SELECT 1 FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND participant_id IS NULL) THEN
    RAISE EXCEPTION 'TEST FAILED: NULL-participant brain_activity of the session survived anonymize_user_in_session';
  END IF;
  IF (SELECT count(*) FROM brain_activity WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND participant_id IS NULL) <> s_before
     OR (SELECT count(*) FROM brain_activity WHERE session_id IS NULL AND reflection_id IS NOT NULL) <> refl_before THEN
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_in_session deleted brain_activity outside the session';
  END IF;
  RAISE NOTICE 'PASS 17 anonymize_user_in_session deletes the session''s NULL-participant brain_activity (% row(s) in X), keeps S (%) and reflection telemetry (%)',
    x_before, s_before, refl_before;
END $$;
ROLLBACK;

-- 24. work-k5fk.1/.3 (rolled back): the walk deletes the account's identities and
--     scrubs its personas; the AI row and a persona are never an account to delete.
BEGIN;
DO $$ BEGIN
  PERFORM app.anonymize_user_account('00000000-0000-7e00-8000-0000000000d1');
  IF EXISTS (SELECT 1 FROM user_identity WHERE user_id = '00000000-0000-7e00-8000-0000000000d1') THEN
    RAISE EXCEPTION 'TEST FAILED: the walk left a user_identity of the tombstone';
  END IF;
  RAISE NOTICE 'PASS 24a the walk deletes the account''s user_identity rows';
  -- mwf_job reads first_name and deleted_at (not last_name); the walk NULLs both names in one SET
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
\connect - mwf_job
DO $$ BEGIN
  BEGIN
    PERFORM app.anonymize_user_account(app.ai_user_id());
    RAISE EXCEPTION 'TEST FAILED: anonymize_user_account ran on the AI row';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS 24c the AI row is not an account: %', SQLERRM;
  END;
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

  BEGIN
    PERFORM app.create_user('clerk', 'user_ts7cMallory', 'a@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: create_user attached a new identity to the holder of the email';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS 23d an email held by another account is refused (unique_violation), never re-bound: %', SQLERRM;
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
    PERFORM app.create_user('e2e', 'user_ts7cAda2', 'x2@ts7c.test');
    RAISE EXCEPTION 'TEST FAILED: an e2e identity with a non-e2e subject';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 23h an e2e subject must be e2e_…: %', SQLERRM;
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
END $$;
-- 19. app.session_archive (work-k5fk.10.12): only a CURRENT participant of the
--     session, only from CREATED / INVITED / RESOLVED / ABANDONED; records the
--     archiver and the instant. Its refusals carry their own SQLSTATEs (MWA00
--     no identity, MWA01 not found / not a participant, MWA02 participant left,
--     MWA03 not archivable), so each arm below catches exactly its code — a
--     grant drift (42501) or an unrelated CHECK (23514) would stop the run.
--     mwf_app holds no UPDATE of session.status; app.session_set_status
--     archives only for the job (retention); a job login cannot call
--     session_archive. Setup (superuser): D leaves X (RESOLVED, so
--     T-cardinality-2 allows it); Y (…05e2), a CREATED session on X's
--     relationship R2 with C only, so D is a relationship member of Y but
--     never joined it.
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: D leaves X; session Y with C only)';
UPDATE participant SET left_at = now() WHERE id = '00000000-0000-7e00-8000-0000000007d1';
INSERT INTO session (id, relationship_id, status) VALUES ('00000000-0000-7e00-8000-0000000005e2', '00000000-0000-7e00-8000-0000000001c1', 'CREATED');
INSERT INTO participant (id, session_id, user_id, kind, display_name) VALUES
  ('00000000-0000-7e00-8000-0000000007c2', '00000000-0000-7e00-8000-0000000005e2', '00000000-0000-7e00-8000-0000000000c1', 'human', 'Cy');
\connect - mwf_app
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
SELECT set_config('t.a_user', :'a_user', false), set_config('t.b_user', :'b_user', false), set_config('t.outsider', :'outsider', false), set_config('t.att_a', :'att_a', false), set_config('t.att_b', :'att_b', false), set_config('t.r_session', :'r_session', false), set_config('t.b_participant', :'b_participant', false), set_config('t.a_participant', :'a_participant', false) \g /dev/null
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
  -- 19c. a relationship member who never joined Y; 19d an outsider; 19e no identity
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e2');
    RAISE EXCEPTION 'TEST FAILED: a relationship member who never joined archived the session';
  EXCEPTION WHEN SQLSTATE 'MWA01' THEN RAISE NOTICE 'PASS 19c a relationship member who never joined cannot archive (MWA01): %', SQLERRM;
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
  -- 19l. a current participant cannot archive through session_set_status either (→ ARCHIVED is the job's)
  BEGIN
    PERFORM app.session_set_status(current_setting('t.r_session')::uuid, 'ARCHIVED');
    RAISE EXCEPTION 'TEST FAILED: a participant archived through session_set_status';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'only the job archives through session_set_status%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19l a current participant cannot archive through session_set_status: %', SQLERRM;
  END;
  -- 19m. session_check1: mwf_app cannot INSERT an ARCHIVED session (no archived_at)
  BEGIN
    INSERT INTO session (relationship_id, status) VALUES ('00000000-0000-7e00-8000-0000000001c1', 'ARCHIVED');
    RAISE EXCEPTION 'TEST FAILED: mwf_app inserted an ARCHIVED session';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con <> 'session_check1' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19m mwf_app INSERT of an ARCHIVED session refused by %', v_con;
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
\connect - mwf_job
SELECT 'connected as ' || session_user || ' (current_user ' || current_user || ')';
DO $$ DECLARE v_con text; BEGIN
  -- 19n. a job login cannot archive for a user (the owner role holds EXECUTE; the function refuses it)
  PERFORM set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a1', true);
  BEGIN
    PERFORM app.session_archive('00000000-0000-7e00-8000-0000000005e6');
    RAISE EXCEPTION 'TEST FAILED: a job login archived through session_archive';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'session_archive is identity-bound%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19n a job login cannot call session_archive: %', SQLERRM;
  END;
  -- 19o. session_check1 / session_check2 hold for the job's own grants: ARCHIVED without archived_at,
  --      an archiver on a session that is not archived
  BEGIN
    UPDATE session SET status = 'ARCHIVED' WHERE id = '00000000-0000-7e00-8000-0000000005e6';
    RAISE EXCEPTION 'TEST FAILED: the job set ARCHIVED without archived_at';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con <> 'session_check1' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19o the job''s UPDATE to ARCHIVED without archived_at refused by %', v_con;
  END;
  BEGIN
    UPDATE session SET archived_by_user_id = '00000000-0000-7e00-8000-0000000000a1' WHERE id = '00000000-0000-7e00-8000-0000000005e6';
    RAISE EXCEPTION 'TEST FAILED: an archiver on a session that is not archived';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con <> 'session_check2' THEN RAISE; END IF;
    RAISE NOTICE 'PASS 19p an archiver without archived_at refused by %', v_con;
  END;
END $$;
-- 19k. the job (session-retention.ts) still archives through session_set_status: archived_at, no archiver;
--      and the retention purge of an archived session is not blocked by the archive columns (rolled back)
BEGIN;
DO $$ BEGIN
  PERFORM app.session_set_status('00000000-0000-7e00-8000-0000000005e6', 'ABANDONED');
  PERFORM app.session_set_status('00000000-0000-7e00-8000-0000000005e6', 'ARCHIVED');
  IF NOT EXISTS (SELECT 1 FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e6' AND status = 'ARCHIVED'
                 AND archived_at IS NOT NULL AND archived_by_user_id IS NULL) THEN
    RAISE EXCEPTION 'TEST FAILED: the job''s archive did not stamp archived_at alone';
  END IF;
  DELETE FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e1';
  IF EXISTS (SELECT 1 FROM participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e1') THEN
    RAISE EXCEPTION 'TEST FAILED: purge left participants';
  END IF;
  RAISE NOTICE 'PASS 19k the job archives (archived_at, no archiver); purging a participant-archived session cascades';
END $$;
ROLLBACK;

-- 20. session_set_status's member arm is CURRENT participants only (work-k5fk.10.12 review):
--     B leaves the live session S (A stays, so T-cardinality-2 allows it); B cannot move S
--     (→ ABANDONED), A can (rolled back).
\connect - mwf_user
SELECT 'connected as ' || session_user || ' (setup: B leaves S)';
UPDATE participant SET left_at = now() WHERE id = :'b_participant';
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

\echo 'functions-caller-tests: ALL PASSED'
