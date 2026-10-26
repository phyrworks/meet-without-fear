-- ============================================================================
-- smoke-baseline.sql — every target view is queryable AS mwf_app on the rows
-- of seed-target-fixture.sql, and returns what those rows imply (TS-7c;
-- replaces TS-7's smoke-target-migration.sql, whose old-vs-new comparisons
-- have nothing to compare under OD7). Read-only for the data: the only write
-- is the setup GRANT below. Scratch-only (ts7_*).
--
-- Setup (superuser): mwf_app gets the table privileges it holds in production
-- as the tables' owner (the views are security_invoker, so a reader needs
-- SELECT on the tables underneath). Then \connect - mwf_app; identity is
-- set_config('app.current_user_id', <user>, true), as the request layer does.
-- Every check RAISEs on a mismatch; the view rows are printed for the report.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
DO $$
BEGIN
  IF current_database() !~ '^ts7_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'smoke-baseline.sql only runs on a ts7_* scratch database, not %', current_database();
  END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mwf_app;

\connect - mwf_app
SELECT 'smoke-baseline: connected as ' || session_user AS who;

BEGIN;
-- ---- as A (…a1), a participant of S ------------------------------------------
SELECT set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a1', true) \g /dev/null
\echo '-- v_participant (as A, session S)'
SELECT participant_id, display_name, is_tombstone, main_conversation_id, last_active_at IS NOT NULL AS sees_last_active, last_mood
FROM v_participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' ORDER BY participant_id;
DO $$ BEGIN
  IF (SELECT count(*) FROM v_participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e6') <> 2 THEN
    RAISE EXCEPTION 'smoke v_participant: expected 2 rows in S';
  END IF;
  IF (SELECT last_active_at FROM v_participant WHERE participant_id = '00000000-0000-7e00-8000-0000000007b1') IS NOT NULL THEN
    RAISE EXCEPTION 'smoke v_participant: B hides activity status, but A sees last_active_at';
  END IF;
  IF (SELECT last_active_at FROM v_participant WHERE participant_id = '00000000-0000-7e00-8000-0000000007a1') IS NULL
     OR (SELECT last_mood FROM v_participant WHERE participant_id = '00000000-0000-7e00-8000-0000000007a1') <> 4 THEN
    RAISE EXCEPTION 'smoke v_participant: A''s own row lacks last_active_at or the latest mood (4)';
  END IF;
  RAISE NOTICE 'smoke ok: v_participant';
END $$;

\echo '-- v_co_participant (A in S)'
SELECT participant_id, co_participant_id, co_kind, co_display_name FROM v_co_participant
WHERE participant_id = '00000000-0000-7e00-8000-0000000007a1';
DO $$ BEGIN
  IF (SELECT array_agg(co_participant_id) FROM v_co_participant WHERE participant_id = '00000000-0000-7e00-8000-0000000007a1')
     <> ARRAY['00000000-0000-7e00-8000-0000000007b1'::uuid] THEN
    RAISE EXCEPTION 'smoke v_co_participant: A''s co-participant is not B';
  END IF;
  RAISE NOTICE 'smoke ok: v_co_participant';
END $$;

\echo '-- v_session_readiness (S and X)'
SELECT session_id, milestone_key, all_reached, cardinality(waiting_on) AS waiting FROM v_session_readiness
WHERE session_id IN ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000005e1') ORDER BY session_id, milestone_key;
DO $$ BEGIN
  IF NOT (SELECT all_reached FROM v_session_readiness WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND milestone_key = 'compact_signed')
     OR (SELECT all_reached FROM v_session_readiness WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND milestone_key = 'empathy_validated')
     OR (SELECT cardinality(waiting_on) FROM v_session_readiness WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND milestone_key = 'empathy_validated') <> 2
     OR NOT (SELECT all_reached FROM v_session_readiness WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND milestone_key = 'closed') THEN
    RAISE EXCEPTION 'smoke v_session_readiness: unexpected readiness';
  END IF;
  RAISE NOTICE 'smoke ok: v_session_readiness';
END $$;

\echo '-- v_current_stage (every participant)'
SELECT participant_id, milestone_key, stage_label, reached_stage, next_milestone_key, active_stage FROM v_current_stage ORDER BY participant_id;
DO $$ BEGIN
  IF (SELECT (milestone_key, reached_stage, active_stage) FROM v_current_stage WHERE participant_id = '00000000-0000-7e00-8000-0000000007a1')
       IS DISTINCT FROM ('empathy_submitted'::text, 2, 2)
     OR (SELECT (milestone_key, reached_stage, active_stage) FROM v_current_stage WHERE participant_id = '00000000-0000-7e00-8000-0000000007b1')
       IS DISTINCT FROM ('feel_heard'::text, 1, 2)
     OR (SELECT (milestone_key, next_milestone_key, active_stage) FROM v_current_stage WHERE participant_id = '00000000-0000-7e00-8000-0000000007c1')
       IS DISTINCT FROM ('closed'::text, NULL::text, 4) THEN
    RAISE EXCEPTION 'smoke v_current_stage: unexpected stage';
  END IF;
  RAISE NOTICE 'smoke ok: v_current_stage';
END $$;

\echo '-- v_empathy_direction (S)'
SELECT author_participant_id, subject_participant_id, round, status, result_id, share_offer_id, review_id FROM v_empathy_direction
ORDER BY author_participant_id;
DO $$ BEGIN
  IF (SELECT array_agg(status::text ORDER BY author_participant_id) FROM v_empathy_direction) <> ARRAY['AWAITING_SHARING', 'HELD'] THEN
    RAISE EXCEPTION 'smoke v_empathy_direction: expected A→B AWAITING_SHARING, B→A HELD';
  END IF;
  RAISE NOTICE 'smoke ok: v_empathy_direction';
END $$;

\echo '-- v_empathy_direction_status (as A: only S)'
SELECT author_participant_id, subject_participant_id, round, status FROM v_empathy_direction_status ORDER BY author_participant_id;
DO $$ BEGIN
  IF (SELECT count(*) FROM v_empathy_direction_status) <> 2 THEN
    RAISE EXCEPTION 'smoke v_empathy_direction_status: A should see the 2 directions of S';
  END IF;
  RAISE NOTICE 'smoke ok: v_empathy_direction_status';
END $$;

\echo '-- v_reflection_theme'
SELECT user_id, theme, reflection_count FROM v_reflection_theme;
DO $$ BEGIN
  IF (SELECT reflection_count FROM v_reflection_theme WHERE user_id = '00000000-0000-7e00-8000-0000000000a1' AND theme = 'trust') <> 1 THEN
    RAISE EXCEPTION 'smoke v_reflection_theme: A''s trust theme missing';
  END IF;
  RAISE NOTICE 'smoke ok: v_reflection_theme';
END $$;

\echo '-- v_conversation_unread (S)'
SELECT participant_id, conversation_id, unread_count, latest_message_at IS NOT NULL AS has_latest FROM v_conversation_unread
WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' ORDER BY participant_id;
DO $$ BEGIN
  IF (SELECT unread_count FROM v_conversation_unread WHERE participant_id = '00000000-0000-7e00-8000-0000000007a1') <> 1 THEN
    RAISE EXCEPTION 'smoke v_conversation_unread: A has one unread AI message';
  END IF;
  RAISE NOTICE 'smoke ok: v_conversation_unread';
END $$;

-- ---- as C (…c1), a participant of X -------------------------------------------
SELECT set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true) \g /dev/null
\echo '-- v_need_shared (X)'
SELECT need_id, participant_id, category, shared_text FROM v_need_shared ORDER BY need_id;
\echo '-- v_need_coverage (X)'
SELECT need_id, covering_proposal_ids, cardinality(willing_participant_ids) AS willing, status FROM v_need_coverage ORDER BY need_id;
\echo '-- v_session_closure_items (X)'
SELECT session_id, agreement_ids, individual_commitment_ids, open_need_ids FROM v_session_closure_items
WHERE session_id = '00000000-0000-7e00-8000-0000000005e1';
\echo '-- v_follow_up_cycle (X)'
SELECT follow_up_id, cardinality(participant_ids) AS expected, cardinality(waiting_on) AS waiting, status FROM v_follow_up_cycle;
DO $$ BEGIN
  IF (SELECT count(*) FROM v_need_shared) <> 2 THEN
    RAISE EXCEPTION 'smoke v_need_shared: expected the 2 shares of X';
  END IF;
  IF (SELECT status FROM v_need_coverage WHERE need_id = '00000000-0000-7e00-8000-0000000000e1') <> 'COVERED'
     OR (SELECT status FROM v_need_coverage WHERE need_id = '00000000-0000-7e00-8000-0000000000e4') <> 'OPEN' THEN
    RAISE EXCEPTION 'smoke v_need_coverage: expected e1 COVERED (converted proposal, R20), e4 OPEN';
  END IF;
  IF (SELECT (agreement_ids, individual_commitment_ids, open_need_ids) FROM v_session_closure_items
      WHERE session_id = '00000000-0000-7e00-8000-0000000005e1')
     IS DISTINCT FROM (ARRAY['00000000-0000-7e00-8000-000000000ab1'::uuid], ARRAY['00000000-0000-7e00-8000-000000000aa2'::uuid],
                       ARRAY['00000000-0000-7e00-8000-0000000000e4'::uuid]) THEN
    RAISE EXCEPTION 'smoke v_session_closure_items: expected agreement ab1, commitment aa2, open need e4';
  END IF;
  IF (SELECT (status, cardinality(waiting_on)) FROM v_follow_up_cycle WHERE follow_up_id = '00000000-0000-7e00-8000-000000000ac1')
     IS DISTINCT FROM ('WAITING_FOR_PARTNER'::text, 2) THEN
    RAISE EXCEPTION 'smoke v_follow_up_cycle: expected WAITING_FOR_PARTNER on both';
  END IF;
  RAISE NOTICE 'smoke ok: v_need_shared, v_need_coverage, v_session_closure_items, v_follow_up_cycle';
END $$;
ROLLBACK;

\echo 'smoke-baseline: ALL 12 VIEWS OK'
