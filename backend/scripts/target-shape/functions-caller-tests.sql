-- ============================================================================
-- functions-caller-tests.sql — the app.* writers and triggers, exercised per
-- caller after the target_shape migration (TS-7 fix round 1). Run by
-- run-target-migration.sh on a throwaway clone of a migrated --extras scratch
-- database (it changes data). Every caller arm runs in a session that LOGGED
-- IN as mwf_app or mwf_job (\connect), never as the superuser; identity is
-- set_config('app.current_user_id', <user>, true), as the request layer does.
--
-- Setup (superuser, before any caller arm): ids via \gset, and mwf_app gets
-- the table privileges it holds in production as the tables' owner — so every
-- refusal below comes from the function or trigger, not from a missing grant.
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
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mwf_app;
SELECT u.id AS a_user FROM "user" u WHERE u.email = 'a.reconciler-shown-b.b@e2e.test' \gset
SELECT u.id AS b_user FROM "user" u WHERE u.email = 'b.reconciler-shown-b@e2e.test' \gset
SELECT u.id AS outsider FROM "user" u WHERE u.email = 'a.created.b@e2e.test' \gset
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
--     session's NULL-participant brain_activity rows — migrated history that
--     cannot be attributed (eba01 in X). History of other sessions (eba03 in
--     S) and reflection telemetry (eba02, no session) stay.
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

\echo 'functions-caller-tests: ALL PASSED'
