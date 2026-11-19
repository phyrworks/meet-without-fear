-- ============================================================================
-- smoke-baseline.sql — every target view is queryable AS mwf_app on the rows
-- of seed-target-fixture.sql, and returns what those rows imply (TS-7c;
-- replaces TS-7's smoke-target-migration.sql, whose old-vs-new comparisons
-- have nothing to compare under OD7). Read-only for the data: the only write
-- writes nothing. Scratch-only (ts7_*).
--
-- mwf_app holds exactly the baseline's grants (tables.sql; the views are
-- security_invoker, so a reader needs SELECT on the tables underneath).
-- \connect - mwf_app; identity is
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
-- No setup GRANT (work-k5fk.10.2): mwf_app runs on the baseline's own grants (tables.sql).

\connect - mwf_app
SELECT 'smoke-baseline: connected as ' || session_user AS who;

BEGIN;
-- ---- as A (…a1), a participant of S ------------------------------------------
SELECT set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000a1', true) \g /dev/null
\echo '-- v_participant (as A, session S)'
SELECT user_id, display_name, is_tombstone, main_conversation_id, last_active_at IS NOT NULL AS sees_last_active, last_mood
FROM v_participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' ORDER BY user_id;
DO $$ BEGIN
  IF (SELECT count(*) FROM v_participant WHERE session_id = '00000000-0000-7e00-8000-0000000005e6') <> 2 THEN
    RAISE EXCEPTION 'smoke v_participant: expected 2 rows in S';
  END IF;
  IF (SELECT last_active_at FROM v_participant WHERE user_id = '00000000-0000-7e00-8000-0000000000b1') IS NOT NULL THEN
    RAISE EXCEPTION 'smoke v_participant: B hides activity status, but A sees last_active_at';
  END IF;
  IF (SELECT last_active_at FROM v_participant WHERE user_id = '00000000-0000-7e00-8000-0000000000a1') IS NULL
     OR (SELECT last_mood FROM v_participant WHERE user_id = '00000000-0000-7e00-8000-0000000000a1') <> 4 THEN
    RAISE EXCEPTION 'smoke v_participant: A''s own row lacks last_active_at or the latest mood (4)';
  END IF;
  RAISE NOTICE 'smoke ok: v_participant';
END $$;

\echo '-- v_co_participant (A in S)'
SELECT user_id, co_user_id, co_kind, co_display_name FROM v_co_participant
WHERE user_id = '00000000-0000-7e00-8000-0000000000a1';
DO $$ BEGIN
  -- co_user_id is a uuid7 (view columns keep the domain), so array_agg
  -- is uuid7[], which has no <> with uuid[]: cast (tables.sql, uuid7).
  IF (SELECT array_agg(co_user_id)::uuid[] FROM v_co_participant WHERE user_id = '00000000-0000-7e00-8000-0000000000a1')
     <> ARRAY['00000000-0000-7e00-8000-0000000000b1'::uuid] THEN
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
     OR (SELECT cardinality(waiting_on) FROM v_session_readiness WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' AND milestone_key = 'empathy_validated') <> 2 THEN
    RAISE EXCEPTION 'smoke v_session_readiness: unexpected readiness';
  END IF;
  -- RLS (work-k5fk.10.7): A is no participant of X, so X is not there for A at all.
  IF EXISTS (SELECT 1 FROM v_session_readiness WHERE session_id = '00000000-0000-7e00-8000-0000000005e1') THEN
    RAISE EXCEPTION 'smoke v_session_readiness: A sees session X, which A is not in';
  END IF;
  RAISE NOTICE 'smoke ok: v_session_readiness';
END $$;

\echo '-- v_current_stage (every participant)'
SELECT user_id, milestone_key, stage_label, reached_stage, next_milestone_key, active_stage FROM v_current_stage ORDER BY user_id;
-- The key columns are the milestone_key domain (work-k5fk.6): a row comparison needs the
-- same types on both sides (against text: "cannot compare dissimilar column types").
DO $$ BEGIN
  IF (SELECT (milestone_key, reached_stage, active_stage) FROM v_current_stage WHERE user_id = '00000000-0000-7e00-8000-0000000000a1')
       IS DISTINCT FROM ('empathy_submitted'::milestone_key, 2, 2)
     OR (SELECT (milestone_key, reached_stage, active_stage) FROM v_current_stage WHERE user_id = '00000000-0000-7e00-8000-0000000000b1')
       IS DISTINCT FROM ('feel_heard'::milestone_key, 1, 2) THEN
    RAISE EXCEPTION 'smoke v_current_stage: unexpected stage';
  END IF;
  -- RLS (work-k5fk.10.7): only the participants of A's sessions.
  IF EXISTS (SELECT 1 FROM v_current_stage WHERE session_id = '00000000-0000-7e00-8000-0000000005e1') THEN
    RAISE EXCEPTION 'smoke v_current_stage: A sees the participants of session X, which A is not in';
  END IF;
  RAISE NOTICE 'smoke ok: v_current_stage';
END $$;

\echo '-- v_empathy_direction (S)'
SELECT author_user_id, subject_user_id, round, status, result_id, share_offer_id, review_id FROM v_empathy_direction
ORDER BY author_user_id;
DO $$ BEGIN
  -- RLS (work-k5fk.10.7, empathy_attempt app_select): A reads their own direction (A→B AWAITING_SHARING) and not
  -- B's unrevealed HELD attempt about them — its status is v_empathy_direction_status's, below; nor the
  -- reconciler's result or the share offer of A→B, both B's (the subject's).
  IF (SELECT array_agg(status::text ORDER BY author_user_id) FROM v_empathy_direction) <> ARRAY['AWAITING_SHARING'] THEN
    RAISE EXCEPTION 'smoke v_empathy_direction: expected only A→B AWAITING_SHARING';
  END IF;
  IF (SELECT result_id IS NOT NULL OR share_offer_id IS NOT NULL FROM v_empathy_direction) THEN
    RAISE EXCEPTION 'smoke v_empathy_direction: A, the author, reads the subject''s result or offer';
  END IF;
  RAISE NOTICE 'smoke ok: v_empathy_direction';
END $$;

\echo '-- v_empathy_direction_status (as A: only S)'
SELECT author_user_id, subject_user_id, round, status FROM v_empathy_direction_status ORDER BY author_user_id;
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
SELECT user_id, conversation_id, unread_count, latest_message_at IS NOT NULL AS has_latest FROM v_conversation_unread
WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' ORDER BY user_id;
DO $$ BEGIN
  IF (SELECT unread_count FROM v_conversation_unread WHERE user_id = '00000000-0000-7e00-8000-0000000000a1') <> 1 THEN
    RAISE EXCEPTION 'smoke v_conversation_unread: A has one unread AI message';
  END IF;
  RAISE NOTICE 'smoke ok: v_conversation_unread';
END $$;

-- ---- as C (…c1), a participant of X -------------------------------------------
SELECT set_config('app.current_user_id', '00000000-0000-7e00-8000-0000000000c1', true) \g /dev/null
\echo '-- v_session_readiness and v_current_stage (X)'
SELECT session_id, milestone_key, all_reached FROM v_session_readiness WHERE milestone_key = 'closed';
DO $$ BEGIN
  IF NOT (SELECT all_reached FROM v_session_readiness WHERE session_id = '00000000-0000-7e00-8000-0000000005e1' AND milestone_key = 'closed')
     OR (SELECT (milestone_key, next_milestone_key, active_stage) FROM v_current_stage WHERE user_id = '00000000-0000-7e00-8000-0000000000c1')
       IS DISTINCT FROM ('closed'::milestone_key, NULL::milestone_key, 4) THEN
    RAISE EXCEPTION 'smoke v_session_readiness / v_current_stage: X closed for both, C at closed';
  END IF;
  IF EXISTS (SELECT 1 FROM v_current_stage WHERE session_id = '00000000-0000-7e00-8000-0000000005e6') THEN
    RAISE EXCEPTION 'smoke v_current_stage: C sees session S, which C is not in';
  END IF;
  RAISE NOTICE 'smoke ok: v_session_readiness, v_current_stage (X)';
END $$;
\echo '-- v_need_shared (X)'
SELECT need_id, user_id, category, shared_text FROM v_need_shared ORDER BY need_id;
\echo '-- v_need_coverage (X)'
SELECT need_id, covering_proposal_ids, cardinality(willing_user_ids) AS willing, status FROM v_need_coverage ORDER BY need_id;
\echo '-- v_session_closure_items (X)'
SELECT session_id, agreement_ids, individual_commitment_ids, open_need_ids FROM v_session_closure_items
WHERE session_id = '00000000-0000-7e00-8000-0000000005e1';
\echo '-- v_follow_up_cycle (X)'
SELECT follow_up_id, cardinality(user_ids) AS expected, cardinality(waiting_on) AS waiting, status FROM v_follow_up_cycle;
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
