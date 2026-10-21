-- ============================================================================
-- smoke-target-migration.sql — functional smoke after the target_shape
-- migration on a run-target-migration.sh scratch database (TS-7 acceptance e).
-- Compares the target views with the old-shape facts smoke-before.sql
-- recorded in schema ts7_smoke; every comparison RAISEs on a mismatch, and
-- the tables are printed for the report. Scratch-only (ts7_*).
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
DO $$
BEGIN
  IF current_database() !~ '^ts7_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'smoke-target-migration.sql only runs on a ts7_* scratch database, not %', current_database();
  END IF;
END
$$;

-- 1. Step 11's assertion as a reader would see it: in EMPATHY_REVEALED (with a
--    partner), as each subject (SET LOCAL app.current_user_id), the delivered
--    EMPATHY_STATEMENT in the subject's own conversation, and the revealed
--    attempt row under the target SELECT predicate.
\echo '-- 1. EMPATHY_REVEALED: delivered EMPATHY_STATEMENT, read as the subject'
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT o.attempt_id, o.subject_user
    FROM ts7_smoke.old_attempt o JOIN ts7_smoke.seed s ON s.session_id = o.session_id
    WHERE s.stage = 'EMPATHY_REVEALED' AND s.variant = 'b' AND o.revealed
  LOOP
    PERFORM set_config('app.current_user_id', r.subject_user::text, true);
    IF NOT EXISTS (
         SELECT 1 FROM message m
         JOIN conversation c ON c.id = m.conversation_id
         JOIN participant p ON p.id = c.participant_id
         WHERE p.user_id = app.current_user_id() AND m.kind = 'EMPATHY_STATEMENT' AND m.source_attempt_id = r.attempt_id) THEN
      RAISE EXCEPTION 'smoke 1: subject % cannot see the delivered statement of attempt %', r.subject_user, r.attempt_id;
    END IF;
    n := n + 1;
  END LOOP;
  PERFORM set_config('app.current_user_id', '', true);
  IF n = 0 THEN
    RAISE EXCEPTION 'smoke 1: no revealed attempt in EMPATHY_REVEALED';
  END IF;
END
$$;
BEGIN;
SELECT set_config('app.current_user_id',
                  (SELECT o.subject_user::text FROM ts7_smoke.old_attempt o JOIN ts7_smoke.seed s ON s.session_id = o.session_id
                   WHERE s.stage = 'EMPATHY_REVEALED' AND s.variant = 'b' AND o.revealed ORDER BY o.attempt_id LIMIT 1), true) AS as_user;
SELECT m.id AS message_id, m.kind, m.role, m.source_attempt_id, m.created_at, left(m.content, 60) AS content,
       (a.author_participant_id IN (SELECT id FROM participant WHERE user_id = app.current_user_id())
        OR (a.subject_participant_id IN (SELECT id FROM participant WHERE user_id = app.current_user_id()) AND a.revealed_at IS NOT NULL))
         AS attempt_readable_under_policy
FROM message m
JOIN conversation c ON c.id = m.conversation_id
JOIN participant p ON p.id = c.participant_id
JOIN empathy_attempt a ON a.id = m.source_attempt_id
WHERE p.user_id = app.current_user_id() AND m.kind = 'EMPATHY_STATEMENT'
  AND p.session_id = (SELECT session_id FROM ts7_smoke.seed WHERE stage = 'EMPATHY_REVEALED' AND variant = 'b');
COMMIT;

-- 2. v_current_stage.active_stage = the old StageProgress stage, every member of every seeded session.
\echo '-- 2. v_current_stage vs old StageProgress stage (with-partner seeds; all seeds asserted)'
SELECT s.stage AS target_stage, o.who, o.old_stage, v.active_stage, v.milestone_key, v.stage_label, v.next_milestone_key
FROM ts7_smoke.seed s
JOIN ts7_smoke.old_stage o ON o.session_id = s.session_id
JOIN participant p ON p.session_id = o.session_id AND p.user_id = o.user_id
JOIN v_current_stage v ON v.participant_id = p.id
WHERE s.variant = 'b'
ORDER BY s.stage, o.who;
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s/%s %s: old %s new %s', s.stage, s.variant, o.who, o.old_stage, v.active_stage), '; ') INTO bad
  FROM ts7_smoke.seed s
  JOIN ts7_smoke.old_stage o ON o.session_id = s.session_id
  JOIN participant p ON p.session_id = o.session_id AND p.user_id = o.user_id
  JOIN v_current_stage v ON v.participant_id = p.id
  WHERE v.active_stage <> o.old_stage;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'smoke 2: v_current_stage differs from the old stage: %', bad;
  END IF;
END
$$;

-- 3. v_session_readiness(compact_signed).all_reached = every old member signed the compact.
\echo '-- 3. v_session_readiness(compact_signed) vs old compactSigned of every member'
SELECT s.stage AS target_stage, s.variant, o.all_signed AS old_all_signed, v.all_reached, cardinality(v.waiting_on) AS waiting
FROM ts7_smoke.seed s
JOIN ts7_smoke.old_compact o ON o.session_id = s.session_id
JOIN v_session_readiness v ON v.session_id = s.session_id AND v.milestone_key = 'compact_signed'
ORDER BY s.variant, s.stage;
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s/%s', s.stage, s.variant), ', ') INTO bad
  FROM ts7_smoke.seed s
  JOIN ts7_smoke.old_compact o ON o.session_id = s.session_id
  JOIN v_session_readiness v ON v.session_id = s.session_id AND v.milestone_key = 'compact_signed'
  WHERE v.all_reached <> o.all_signed;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'smoke 3: compact readiness differs: %', bad;
  END IF;
END
$$;

-- 4. v_empathy_direction_status, read as user A of each seeded session (the
--    definer table function is identity-bound): one row per old attempt, same
--    direction, same status.
\echo '-- 4. v_empathy_direction_status (as user A) vs old EmpathyAttempt'
DO $$
DECLARE
  r record;
  bad text := '';
BEGIN
  FOR r IN SELECT s.session_id, s.stage, s.variant, o.user_id
           FROM ts7_smoke.seed s JOIN ts7_smoke.old_stage o ON o.session_id = s.session_id AND o.who = 'A'
  LOOP
    PERFORM set_config('app.current_user_id', r.user_id::text, true);
    IF EXISTS (
         (SELECT oa.author_user, oa.subject_user, oa.status FROM ts7_smoke.old_attempt oa WHERE oa.session_id = r.session_id
          EXCEPT
          SELECT au.user_id, su.user_id, v.status::text FROM v_empathy_direction_status v
          JOIN participant au ON au.id = v.author_participant_id JOIN participant su ON su.id = v.subject_participant_id
          WHERE au.session_id = r.session_id)
         UNION ALL
         (SELECT au.user_id, su.user_id, v.status::text FROM v_empathy_direction_status v
          JOIN participant au ON au.id = v.author_participant_id JOIN participant su ON su.id = v.subject_participant_id
          WHERE au.session_id = r.session_id
          EXCEPT
          SELECT oa.author_user, oa.subject_user, oa.status FROM ts7_smoke.old_attempt oa WHERE oa.session_id = r.session_id)) THEN
      bad := bad || format(' %s/%s', r.stage, r.variant);
    END IF;
  END LOOP;
  PERFORM set_config('app.current_user_id', '', true);
  IF bad <> '' THEN
    RAISE EXCEPTION 'smoke 4: v_empathy_direction_status differs from the old attempts in:%', bad;
  END IF;
END
$$;
CREATE TEMP TABLE smoke_direction (target_stage text, author text, subject text, round int, status text, revealed boolean);
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT s.session_id, s.stage, o.user_id
           FROM ts7_smoke.seed s JOIN ts7_smoke.old_stage o ON o.session_id = s.session_id AND o.who = 'A'
           WHERE s.variant = 'b'
  LOOP
    PERFORM set_config('app.current_user_id', r.user_id::text, true);
    INSERT INTO smoke_direction
    SELECT r.stage, CASE WHEN ap.user_id = r.user_id THEN 'A' ELSE 'B' END, CASE WHEN sp.user_id = r.user_id THEN 'A' ELSE 'B' END,
           v.round, v.status::text, v.revealed_at IS NOT NULL
    FROM v_empathy_direction_status v
    JOIN participant ap ON ap.id = v.author_participant_id AND ap.session_id = r.session_id
    JOIN participant sp ON sp.id = v.subject_participant_id;
  END LOOP;
  PERFORM set_config('app.current_user_id', '', true);
END
$$;
SELECT * FROM smoke_direction ORDER BY target_stage, author;

-- 5. v_need_shared: one row per old live share, per session — active
--    ConsentedContent plus (TS-7b) granted, unrevoked IDENTIFIED_NEED
--    ConsentRecords without ConsentedContent (smoke-before.sql).
\echo '-- 5. v_need_shared count vs old live shares (active ConsentedContent ∪ granted Stage 3 ConsentRecords)'
SELECT s.stage AS target_stage, s.variant, coalesce(o.n, 0) AS old_shared, (SELECT count(*) FROM v_need_shared v WHERE v.session_id = s.session_id) AS v_need_shared
FROM ts7_smoke.seed s LEFT JOIN ts7_smoke.old_shared_need o ON o.session_id = s.session_id
WHERE s.variant = 'b'
ORDER BY s.stage;
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s: old %s new %s', x.session_id, x.old, x.new), '; ') INTO bad
  FROM (SELECT s.id AS session_id, coalesce(o.n, 0) AS old, (SELECT count(*) FROM v_need_shared v WHERE v.session_id = s.id) AS new
        FROM session s LEFT JOIN ts7_smoke.old_shared_need o ON o.session_id = s.id) x
  WHERE x.old <> x.new;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'smoke 5: v_need_shared differs: %', bad;
  END IF;
END
$$;

-- 6. v_session_closure_items for sessions with a closure (the migration
--    already asserted equality with the old arrays), and v_follow_up_cycle.
\echo '-- 6. v_session_closure_items (sessions with a session_closure) and v_follow_up_cycle'
SELECT v.session_id, c.kind, cardinality(v.agreement_ids) AS agreements, cardinality(v.individual_commitment_ids) AS individual,
       cardinality(v.open_need_ids) AS open_needs
FROM v_session_closure_items v JOIN session_closure c ON c.session_id = v.session_id
ORDER BY v.session_id;
SELECT follow_up_id, status, cardinality(participant_ids) AS expected, cardinality(waiting_on) AS waiting FROM v_follow_up_cycle ORDER BY 1;

-- 7. Ruling R16 (extras only): an ownerless pre-2026 AI reply is attributed
--    only when exactly one user could have had the turn. In vanished-member
--    session V the reply before E2 joined lands in the survivor C's MAIN
--    conversation; the reply after both joined is not copied and sits in
--    app_migration.dropped_content with both candidates.
\echo '-- 7. R16: ownerless AI replies in vanished-member session V (extras)'
SELECT m.id AS message_id, p.user_id AS conversation_owner, c.kind, left(m.content, 40) AS content
FROM message m JOIN conversation c ON c.id = m.conversation_id JOIN participant p ON p.id = c.participant_id
WHERE m.id IN ('00000000-0000-7e00-8000-00000000e5f3', '00000000-0000-7e00-8000-00000000e5f4', '00000000-0000-7e00-8000-00000000e5c5');
SELECT concept, session_id, user_id, left(text, 40) AS text, candidates FROM app_migration.dropped_content WHERE concept = 'message_without_owner';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM session WHERE id = '00000000-0000-7e00-8000-0000000005e5') THEN
    RAISE NOTICE 'smoke 7 skipped (no extras)';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM message m JOIN conversation c ON c.id = m.conversation_id JOIN participant p ON p.id = c.participant_id
                 WHERE m.id = '00000000-0000-7e00-8000-00000000e5f3' AND c.kind = 'MAIN'
                   AND p.user_id = '00000000-0000-7e00-8000-0000000000c1' AND p.session_id = '00000000-0000-7e00-8000-0000000005e5') THEN
    RAISE EXCEPTION 'smoke 7: the exactly attributable reply e5f3 is not in the survivor''s MAIN conversation';
  END IF;
  IF EXISTS (SELECT 1 FROM message WHERE id = '00000000-0000-7e00-8000-00000000e5f4') THEN
    RAISE EXCEPTION 'smoke 7: the inexact reply e5f4 was copied into a conversation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_migration.dropped_content
                 WHERE concept = 'message_without_owner' AND text = 'reply after both joined: whose?' AND user_id IS NULL
                   AND candidates @> '["00000000-0000-7e00-8000-0000000000c1", "00000000-0000-7e00-8000-0000000000ef"]'::jsonb
                   AND jsonb_array_length(candidates) = 2) THEN
    RAISE EXCEPTION 'smoke 7: the inexact reply e5f4 is not in dropped_content with both candidates';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM message m JOIN conversation c ON c.id = m.conversation_id JOIN participant p ON p.id = c.participant_id
                 WHERE m.id = '00000000-0000-7e00-8000-00000000e5c5' AND p.user_id = '00000000-0000-7e00-8000-0000000000c1') THEN
    RAISE EXCEPTION 'smoke 7: the pre-acceptance reply e5c5 in session X is not in the inviter''s conversation';
  END IF;
  RAISE NOTICE 'smoke 7: e5f3 → survivor C (exact), e5c5 → inviter C (exact), e5f4 → dropped_content with candidates [C, E2]';
END
$$;

-- 8. TS-7b (extras only): session S's needs were shared the production way
--    (Stage 3 handler: ConsentRecord only, no ConsentedContent). Each lands in
--    need_share with its owner's participant and session, shared_text = the
--    need label, shared_at = the grant; each is visible in v_need_shared to
--    the PARTNER (app.current_user_id = the partner, transaction-local); the
--    consent row for the same record exists; proposal P6's proposal_need rows
--    to both survive (StrategyProposalNeed → D's need, needsAddressed label →
--    C's need), and v_need_coverage counts P6 as covering both.
\echo '-- 8. TS-7b: Stage 3 shares (ConsentRecord only) in session S (extras)'
SELECT ns.need_id, p.user_id AS owner_user, ns.session_id, ns.category, ns.shared_text, ns.shared_at, ns.revoked_at
FROM need_share ns JOIN participant p ON p.id = ns.participant_id
WHERE ns.session_id = '00000000-0000-7e00-8000-0000000005e6' ORDER BY ns.need_id;
SELECT pn.proposal_id, pn.need_id FROM proposal_need pn WHERE pn.proposal_id = '00000000-0000-7e00-8000-0000000006f1' ORDER BY pn.need_id;
SELECT need_id, covering_proposal_ids, status FROM v_need_coverage WHERE session_id = '00000000-0000-7e00-8000-0000000005e6' ORDER BY need_id;
BEGIN;
DO $$
DECLARE
  s  constant uuid := '00000000-0000-7e00-8000-0000000005e6';
  c  constant uuid := '00000000-0000-7e00-8000-0000000000c1';
  d  constant uuid := '00000000-0000-7e00-8000-0000000000d1';
  r  record;
  n  int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM session WHERE id = s) THEN
    RAISE NOTICE 'smoke 8 skipped (no extras)';
    RETURN;
  END IF;
  FOR r IN SELECT * FROM (VALUES
             ('00000000-0000-7e00-8000-0000000006e1'::uuid, '00000000-0000-7e00-8000-000000006cc1'::uuid, c, d, 'Appreciation', '2026-10-04 09:00+00'::timestamptz),
             ('00000000-0000-7e00-8000-0000000006e2'::uuid, '00000000-0000-7e00-8000-000000006cc2'::uuid, d, c, 'Downtime', '2026-10-04 09:30+00'::timestamptz))
             AS v (need_id, record_id, owner_user, partner_user, label, granted_at)
  LOOP
    -- the share, with the owner's participant and session
    IF NOT EXISTS (SELECT 1 FROM need_share ns JOIN participant p ON p.id = ns.participant_id
                   WHERE ns.need_id = r.need_id AND p.user_id = r.owner_user AND p.session_id = s AND ns.session_id = s
                     AND ns.shared_text = r.label AND ns.shared_at = r.granted_at AND ns.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'smoke 8: Stage 3 share of need % (record %) is not in need_share with owner %, session S, text %, shared_at %',
        r.need_id, r.record_id, r.owner_user, r.label, r.granted_at;
    END IF;
    -- one record, one consent, one need_share
    IF NOT EXISTS (SELECT 1 FROM consent k JOIN participant p ON p.id = k.participant_id
                   WHERE k.id = r.record_id AND k.need_id = r.need_id AND k.decision = 'GRANTED' AND p.user_id = r.owner_user) THEN
      RAISE EXCEPTION 'smoke 8: no GRANTED consent % on need % decided by its owner', r.record_id, r.need_id;
    END IF;
    -- read as the PARTNER
    PERFORM set_config('app.current_user_id', r.partner_user::text, true);
    SELECT count(*) INTO n FROM v_need_shared v JOIN participant p ON p.id = v.participant_id
    WHERE v.need_id = r.need_id AND v.session_id = s AND p.user_id = r.owner_user AND v.shared_text = r.label
      AND app.is_member(s);
    IF n <> 1 THEN
      RAISE EXCEPTION 'smoke 8: as partner %, v_need_shared shows % row(s) for need % (expected 1)', r.partner_user, n, r.need_id;
    END IF;
    PERFORM set_config('app.current_user_id', '', true);
    -- the proposal link survives, and coverage sees it
    IF NOT EXISTS (SELECT 1 FROM proposal_need WHERE proposal_id = '00000000-0000-7e00-8000-0000000006f1' AND need_id = r.need_id) THEN
      RAISE EXCEPTION 'smoke 8: proposal_need (P6, %) did not survive', r.need_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM v_need_coverage WHERE need_id = r.need_id
                   AND covering_proposal_ids = ARRAY['00000000-0000-7e00-8000-0000000006f1'::uuid]) THEN
      RAISE EXCEPTION 'smoke 8: v_need_coverage does not count P6 as covering need %', r.need_id;
    END IF;
  END LOOP;
  IF (SELECT cardinality(unresolved_need_labels) FROM proposal WHERE id = '00000000-0000-7e00-8000-0000000006f1') <> 0 THEN
    RAISE EXCEPTION 'smoke 8: P6 kept unresolved need labels: %', (SELECT unresolved_need_labels FROM proposal WHERE id = '00000000-0000-7e00-8000-0000000006f1');
  END IF;
  IF (SELECT count(*) FROM app_migration.shape_map WHERE concept = 'need_share:ConsentRecord'
        AND old_key IN ('00000000-0000-7e00-8000-000000006cc1', '00000000-0000-7e00-8000-000000006cc2')) <> 2 THEN
    RAISE EXCEPTION 'smoke 8: shape_map lacks need_share:ConsentRecord for 6cc1/6cc2';
  END IF;
  RAISE NOTICE 'smoke 8: both Stage 3 shares in need_share (owner, session S, label text, grant time), consent kept, visible to the partner in v_need_shared, P6 links both (v_need_coverage)';
END
$$;
COMMIT;

\echo '-- smoke: all comparisons passed'
