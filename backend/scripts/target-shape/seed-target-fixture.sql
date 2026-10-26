-- ============================================================================
-- seed-target-fixture.sql — a small TARGET-shape fixture for the per-caller
-- tests (functions-caller-tests.sql) and the view smoke (smoke-baseline.sql)
-- on an empty database built by the target_shape_baseline migration (TS-7c,
-- OD7: there is no migrated data to test against any more).
--
-- Run by run-baseline.sh as the superuser in ONE transaction (psql -1), so
-- the deferred T-agreement-parties check runs at commit. Every write goes
-- through the real triggers and CHECKs; nothing is disabled. Fixed uuids
-- (00000000-0000-7e00-8000-…) so the tests can name rows.
--
--   S  (…05e6) relationship R1, ACTIVE: A (…a1, participant …07a1) and
--      B (…b1, participant …07b1). A→B attempt AWAITING_SHARING (…09a1),
--      B→A attempt HELD (…09b1); MAIN conversations, chat, read state, mood;
--      B hides activity status; one NULL-participant brain_activity (R17).
--   X  (…05e1) relationship R2, RESOLVED with a SHARED_AGREEMENT closure:
--      C (…c1, …07c1) and D (…d1, …07d1). C's need e1 and D's need e4 are
--      shared (GRANTED consent + need_share); D's need e5 is not. A shared
--      proposal (CONVERTED_TO_AGREEMENT) covers e1, both WILLING, agreement
--      with both parties, a SHARED follow-up; D's individual commitment.
--      One NULL-participant and one D brain_activity row.
--   outsider (…f1): a user with no session.
--   A's reflection (theme "trust") with its telemetry row (no session).
-- ============================================================================
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF current_database() !~ '^ts7_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'seed-target-fixture.sql only runs on a ts7_* scratch database, not %', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM "user") THEN
    RAISE EXCEPTION 'seed-target-fixture.sql expects an empty database (table "user" has rows)';
  END IF;
END
$$;

INSERT INTO "user" (id, email, first_name, last_name, clerk_id) VALUES
  ('00000000-0000-7e00-8000-0000000000a1', 'a@ts7c.test', 'Ada', 'Lovelace', 'clerk_ts7c_a'),
  ('00000000-0000-7e00-8000-0000000000b1', 'b@ts7c.test', 'Bob', 'Ross', 'clerk_ts7c_b'),
  ('00000000-0000-7e00-8000-0000000000c1', 'c@ts7c.test', 'Cy', 'Young', 'clerk_ts7c_c'),
  ('00000000-0000-7e00-8000-0000000000d1', 'd@ts7c.test', 'Di', 'Prince', 'clerk_ts7c_d'),
  ('00000000-0000-7e00-8000-0000000000f1', 'outsider@ts7c.test', 'Out', 'Sider', 'clerk_ts7c_o');

INSERT INTO user_preferences (user_id, doc) VALUES
  ('00000000-0000-7e00-8000-0000000000b1', '{"memory": {}, "notifications": {}, "privacy": {"showActivityStatus": false}}');

INSERT INTO relationship (id) VALUES
  ('00000000-0000-7e00-8000-0000000001a1'),
  ('00000000-0000-7e00-8000-0000000001c1');
INSERT INTO relationship_member (relationship_id, user_id) VALUES
  ('00000000-0000-7e00-8000-0000000001a1', '00000000-0000-7e00-8000-0000000000a1'),
  ('00000000-0000-7e00-8000-0000000001a1', '00000000-0000-7e00-8000-0000000000b1'),
  ('00000000-0000-7e00-8000-0000000001c1', '00000000-0000-7e00-8000-0000000000c1'),
  ('00000000-0000-7e00-8000-0000000001c1', '00000000-0000-7e00-8000-0000000000d1');

-- Sessions start INVITED; → ACTIVE below, after the participants (T-cardinality-1).
INSERT INTO session (id, relationship_id, status, topic_frame) VALUES
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000001a1', 'INVITED', 'Dishes'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000001c1', 'INVITED', 'Weekends');
INSERT INTO participant (id, session_id, user_id, kind, display_name) VALUES
  ('00000000-0000-7e00-8000-0000000007a1', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000a1', 'human', 'Ada'),
  ('00000000-0000-7e00-8000-0000000007b1', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000b1', 'human', 'Bob'),
  ('00000000-0000-7e00-8000-0000000007c1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'human', 'Cy'),
  ('00000000-0000-7e00-8000-0000000007d1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 'human', 'Di');
UPDATE session SET status = 'ACTIVE'
WHERE id IN ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000005e1');

INSERT INTO conversation (id, participant_id, kind) VALUES
  ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000007a1', 'MAIN'),
  ('00000000-0000-7e00-8000-0000000008b1', '00000000-0000-7e00-8000-0000000007b1', 'MAIN'),
  ('00000000-0000-7e00-8000-0000000008c1', '00000000-0000-7e00-8000-0000000007c1', 'MAIN'),
  ('00000000-0000-7e00-8000-0000000008d1', '00000000-0000-7e00-8000-0000000007d1', 'MAIN');
INSERT INTO message (conversation_id, sender_participant_id, role, kind, content, created_at) VALUES
  ('00000000-0000-7e00-8000-0000000008a1', '00000000-0000-7e00-8000-0000000007a1', 'USER', 'CHAT', 'The dishes pile up.', now() - interval '3 hours'),
  ('00000000-0000-7e00-8000-0000000008a1', NULL, 'AI', 'CHAT', 'That sounds frustrating.', now() - interval '2 hours'),
  ('00000000-0000-7e00-8000-0000000008b1', '00000000-0000-7e00-8000-0000000007b1', 'USER', 'CHAT', 'I work late.', now() - interval '1 hour'),
  ('00000000-0000-7e00-8000-0000000008c1', '00000000-0000-7e00-8000-0000000007c1', 'USER', 'CHAT', 'Weekends feel rushed.', now() - interval '5 hours');
INSERT INTO conversation_read_state (participant_id, last_viewed_at, last_active_at) VALUES
  ('00000000-0000-7e00-8000-0000000007a1', now() - interval '150 minutes', now() - interval '10 minutes'),
  ('00000000-0000-7e00-8000-0000000007b1', now() - interval '30 minutes', now() - interval '20 minutes');
INSERT INTO mood_reading (participant_id, intensity, recorded_at) VALUES
  ('00000000-0000-7e00-8000-0000000007a1', 6, now() - interval '3 hours'),
  ('00000000-0000-7e00-8000-0000000007a1', 4, now() - interval '1 hour');

INSERT INTO participant_milestone (participant_id, milestone_key) VALUES
  ('00000000-0000-7e00-8000-0000000007a1', 'compact_signed'),
  ('00000000-0000-7e00-8000-0000000007a1', 'feel_heard'),
  ('00000000-0000-7e00-8000-0000000007a1', 'empathy_submitted'),
  ('00000000-0000-7e00-8000-0000000007b1', 'compact_signed'),
  ('00000000-0000-7e00-8000-0000000007b1', 'feel_heard'),
  ('00000000-0000-7e00-8000-0000000007c1', 'compact_signed'),
  ('00000000-0000-7e00-8000-0000000007c1', 'needs_shared'),
  ('00000000-0000-7e00-8000-0000000007c1', 'choices_shared'),
  ('00000000-0000-7e00-8000-0000000007c1', 'closed'),
  ('00000000-0000-7e00-8000-0000000007d1', 'compact_signed'),
  ('00000000-0000-7e00-8000-0000000007d1', 'needs_shared'),
  ('00000000-0000-7e00-8000-0000000007d1', 'choices_shared'),
  ('00000000-0000-7e00-8000-0000000007d1', 'closed');

-- S: the two empathy directions (A→B awaiting sharing, B→A held).
INSERT INTO empathy_attempt (id, author_participant_id, subject_participant_id, round, content, status) VALUES
  ('00000000-0000-7e00-8000-0000000009a1', '00000000-0000-7e00-8000-0000000007a1', '00000000-0000-7e00-8000-0000000007b1', 1,
   'You are stretched thin after work.', 'AWAITING_SHARING'),
  ('00000000-0000-7e00-8000-0000000009b1', '00000000-0000-7e00-8000-0000000007b1', '00000000-0000-7e00-8000-0000000007a1', 1,
   'You want to feel the load is shared.', 'HELD');

-- X: needs, consents (owner GRANTED), shares.
INSERT INTO need (id, participant_id, label, category, ai_confidence, confirmed_at) VALUES
  ('00000000-0000-7e00-8000-0000000000e1', '00000000-0000-7e00-8000-0000000007c1', 'Rest together', 'CONNECTION', 0.9, now() - interval '2 days'),
  ('00000000-0000-7e00-8000-0000000000e4', '00000000-0000-7e00-8000-0000000007d1', 'Time to myself', 'AUTONOMY', 0.8, now() - interval '2 days'),
  ('00000000-0000-7e00-8000-0000000000e5', '00000000-0000-7e00-8000-0000000007d1', 'Predictable plans', 'SAFETY', 0.7, NULL);
INSERT INTO consent (id, participant_id, need_id, decision, decided_at) VALUES
  ('00000000-0000-7e00-8000-000000000ca1', '00000000-0000-7e00-8000-0000000007c1', '00000000-0000-7e00-8000-0000000000e1', 'GRANTED', now() - interval '2 days'),
  ('00000000-0000-7e00-8000-000000000ca4', '00000000-0000-7e00-8000-0000000007d1', '00000000-0000-7e00-8000-0000000000e4', 'GRANTED', now() - interval '2 days');
INSERT INTO need_share (need_id, participant_id, session_id, category, shared_text, shared_at) VALUES
  ('00000000-0000-7e00-8000-0000000000e1', '00000000-0000-7e00-8000-0000000007c1', '00000000-0000-7e00-8000-0000000005e1', 'CONNECTION', 'Rest together', now() - interval '2 days'),
  ('00000000-0000-7e00-8000-0000000000e4', '00000000-0000-7e00-8000-0000000007d1', '00000000-0000-7e00-8000-0000000005e1', 'AUTONOMY', 'Time to myself', now() - interval '2 days');

-- X: a shared proposal covering e1, converted to an agreement both are party to;
-- D's individual commitment (WILLING by D).
INSERT INTO proposal (id, session_id, created_by_participant_id, kind, status, description, shared_at) VALUES
  ('00000000-0000-7e00-8000-000000000aa1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000007c1',
   'SHARED_PROPOSAL', 'CONVERTED_TO_AGREEMENT', 'A lazy Sunday morning every week', NULL),
  ('00000000-0000-7e00-8000-000000000aa2', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000007d1',
   'INDIVIDUAL_COMMITMENT', 'ACTIVE', 'I will plan Saturdays by Thursday', now() - interval '1 day');
INSERT INTO proposal_need (proposal_id, need_id) VALUES
  ('00000000-0000-7e00-8000-000000000aa1', '00000000-0000-7e00-8000-0000000000e1');
INSERT INTO proposal_choice (proposal_id, participant_id, decision) VALUES
  ('00000000-0000-7e00-8000-000000000aa1', '00000000-0000-7e00-8000-0000000007c1', 'WILLING'),
  ('00000000-0000-7e00-8000-000000000aa1', '00000000-0000-7e00-8000-0000000007d1', 'WILLING'),
  ('00000000-0000-7e00-8000-000000000aa2', '00000000-0000-7e00-8000-0000000007d1', 'WILLING');
INSERT INTO agreement (id, session_id, proposal_id, type, description) VALUES
  ('00000000-0000-7e00-8000-000000000ab1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-000000000aa1',
   'MICRO_EXPERIMENT', 'A lazy Sunday morning every week');
INSERT INTO agreement_party (agreement_id, participant_id) VALUES
  ('00000000-0000-7e00-8000-000000000ab1', '00000000-0000-7e00-8000-0000000007c1'),
  ('00000000-0000-7e00-8000-000000000ab1', '00000000-0000-7e00-8000-0000000007d1');
INSERT INTO follow_up (id, session_id, agreement_id, type, scope, status, scheduled_for) VALUES
  ('00000000-0000-7e00-8000-000000000ac1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-000000000ab1',
   'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'OPEN', now() - interval '1 hour');
INSERT INTO session_closure (session_id, kind, reason, summary, closed_by_participant_id) VALUES
  ('00000000-0000-7e00-8000-0000000005e1', 'SHARED_AGREEMENT', 'MUTUAL_SELECTION', 'Sunday mornings, together.',
   '00000000-0000-7e00-8000-0000000007c1');
UPDATE session SET status = 'RESOLVED', resolved_at = now() WHERE id = '00000000-0000-7e00-8000-0000000005e1';

-- Telemetry: NULL-participant history in X and in S (ruling R17), D's own row
-- in X, and A's reflection with its telemetry (no session).
INSERT INTO reflection (id, user_id, title, theme) VALUES
  ('00000000-0000-7e00-8000-000000000fa1', '00000000-0000-7e00-8000-0000000000a1', 'On trust', 'trust');
INSERT INTO brain_activity (id, session_id, reflection_id, participant_id, activity_type, model, status) VALUES
  ('00000000-0000-7e00-8000-000000000ba1', '00000000-0000-7e00-8000-0000000005e1', NULL, NULL, 'LLM_CALL', 'test-model', 'COMPLETED'),
  ('00000000-0000-7e00-8000-000000000ba2', '00000000-0000-7e00-8000-0000000005e6', NULL, NULL, 'LLM_CALL', 'test-model', 'COMPLETED'),
  ('00000000-0000-7e00-8000-000000000ba3', NULL, '00000000-0000-7e00-8000-000000000fa1', NULL, 'LLM_CALL', 'test-model', 'COMPLETED'),
  ('00000000-0000-7e00-8000-000000000ba4', '00000000-0000-7e00-8000-0000000005e1', NULL, '00000000-0000-7e00-8000-0000000007d1', 'LLM_CALL', 'test-model', 'COMPLETED');

SELECT format('seed-target-fixture: %s users, %s sessions, %s participants, %s attempts, %s needs, %s shares, %s consents, %s agreements, %s closures, %s brain_activity',
              (SELECT count(*) FROM "user"), (SELECT count(*) FROM session), (SELECT count(*) FROM participant),
              (SELECT count(*) FROM empathy_attempt), (SELECT count(*) FROM need), (SELECT count(*) FROM need_share),
              (SELECT count(*) FROM consent), (SELECT count(*) FROM agreement), (SELECT count(*) FROM session_closure),
              (SELECT count(*) FROM brain_activity)) AS seeded;
