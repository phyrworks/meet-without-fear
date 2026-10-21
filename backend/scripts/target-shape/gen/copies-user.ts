/**
 * (3d) Copies, plan §3 steps 15–18 — reflection, feature_state, the step-17
 * FK-less-id audit, brain_activity, invitation / regulation / mood / memory
 * (the per-row renames) — then the 'after' row counts; and (4) step 19, the
 * drops.
 */

import { DROPPED_COUNTED, OLD_ENUMS, OLD_TABLES, lit, q } from './maps';

export function stepRenames(): string {
  return `
-- ---- Renames that hang off participant: invitation, mood_reading, regulation_event, user_memory.
-- invitation (ids kept): invitedById → participant; messageConfirmed folded into
-- message_confirmed_at (createdAt when the flag is set without a time);
-- accepted_by_user_id (new, P3 §6) = the session's one participant other than
-- the inviter, a vanished acceptor included (their tombstone keeps the id;
-- P14b checked there is exactly one).
INSERT INTO invitation (id, session_id, invited_by_participant_id, accepted_by_user_id, name, status, message_confirmed_at, expires_at,
                        accepted_at, declined_at, decline_reason, created_at, updated_at)
SELECT i.id, i."sessionId", pi.id,
       CASE WHEN i.status = 'ACCEPTED' THEN
         (SELECT DISTINCT p.user_id FROM app_migration.pair p WHERE p.session_id = i."sessionId" AND p.user_id <> i."invitedById")
       END,
       i.name, i.status::text::invitation_status,
       coalesce(i."messageConfirmedAt", CASE WHEN i."messageConfirmed" THEN i."createdAt" END),
       i."expiresAt", i."acceptedAt", i."declinedAt", i."declineReason", i."createdAt",
       greatest(i."createdAt", i."acceptedAt", i."declinedAt", i."messageConfirmedAt")
FROM "Invitation" i
JOIN "Session" s ON s.id = i."sessionId"
JOIN participant pi ON pi.session_id = i."sessionId" AND pi.user_id = i."invitedById";
SELECT app_migration.note('3', 'invitation accepted by a vanished member (accepted_by_user_id = the tombstone)', count(*))
FROM invitation i JOIN app_migration.vanished v ON v.user_id = i.accepted_by_user_id;
SELECT app_migration.assert(a = b, format('invitation: %s rows for %s "Invitation" rows', a, b))
FROM (SELECT (SELECT count(*) FROM invitation) AS a, (SELECT count(*) FROM "Invitation") AS b) x;

-- mood_reading ← EmotionalReading (ids kept; stage dropped).
INSERT INTO mood_reading (id, participant_id, intensity, context, recorded_at, created_at)
SELECT e.id, p.id, e.intensity, e.context, e.timestamp, e.timestamp
FROM "EmotionalReading" e
JOIN "UserVessel" v ON v.id = e."vesselId"
JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId";
SELECT app_migration.assert(a = b, format('mood_reading: %s rows for %s "EmotionalReading" rows', a, b))
FROM (SELECT (SELECT count(*) FROM mood_reading) AS a, (SELECT count(*) FROM "EmotionalReading") AS b) x;

-- regulation_event ← EmotionalExerciseCompletion (ids kept).
INSERT INTO regulation_event (id, participant_id, type, intensity_before, intensity_after, completed_at, created_at)
SELECT e.id, p.id, e.type::text::regulation_type, e."intensityBefore", e."intensityAfter", e."completedAt", e."completedAt"
FROM "EmotionalExerciseCompletion" e
JOIN participant p ON p.session_id = e."sessionId" AND p.user_id = e."userId";
SELECT app_migration.assert(a = b, format('regulation_event: %s rows for %s "EmotionalExerciseCompletion" rows', a, b))
FROM (SELECT (SELECT count(*) FROM regulation_event) AS a, (SELECT count(*) FROM "EmotionalExerciseCompletion") AS b) x;

-- user_memory ← UserMemory (ids kept; suggestedBy → suggested_text).
INSERT INTO user_memory (id, user_id, session_id, content, category, status, source, suggested_text, created_at, updated_at)
SELECT id, "userId", "sessionId", content, category::text::memory_category, status::text::memory_status, source::text::memory_source,
       "suggestedBy", "createdAt", "updatedAt"
FROM "UserMemory";
SELECT app_migration.assert(a = b, format('user_memory: %s rows for %s "UserMemory" rows', a, b))
FROM (SELECT (SELECT count(*) FROM user_memory) AS a, (SELECT count(*) FROM "UserMemory") AS b) x;
`;
}

export function stepReflection(): string {
  return `
-- ---- Step 15: reflection ← InnerWorkSession (ids kept; summary_doc parsed
-- from text, P28a checked; linked_at = updatedAt of the linking row);
-- reflection_message ← InnerWorkMessage; takeaway ← SessionTakeaway
-- (resolved without a time → updatedAt); takeaway_link ← TakeawayLink.
-- linkedAtStage, linkedTrigger, linkedAtMessageId, contentEmbedding/embedding dropped.
INSERT INTO reflection (id, user_id, title, theme, status, summary, summary_doc, linked_session_id, linked_at, context_snapshot,
                        distilled_at, created_at, updated_at)
SELECT s.id, s."userId", s.title, s.theme, s.status::text::reflection_status, s.summary, s."conversationSummary"::jsonb,
       s."linkedPartnerSessionId", CASE WHEN s."linkedPartnerSessionId" IS NOT NULL THEN s."updatedAt" END,
       s."contextSummarySnapshot", s."distilledAt", s."createdAt", s."updatedAt"
FROM "InnerWorkSession" s;
INSERT INTO reflection_message (id, reflection_id, role, content, created_at)
SELECT id, "sessionId", role::text::message_role, content, timestamp FROM "InnerWorkMessage";
INSERT INTO takeaway (id, reflection_id, content, theme, source, type, position, resolved_at, created_at, updated_at)
SELECT id, "sessionId", content, theme, source::text::takeaway_source, type::text::takeaway_type, position,
       CASE WHEN resolved OR "resolvedAt" IS NOT NULL THEN coalesce("resolvedAt", "updatedAt") END, "createdAt", "updatedAt"
FROM "SessionTakeaway";
INSERT INTO takeaway_link (source_id, target_id, link_type, similarity, created_at)
SELECT "sourceId", "targetId", "linkType"::text::takeaway_link_type, similarity::real, "createdAt" FROM "TakeawayLink";

SELECT app_migration.note('15', 'InnerWorkSession.' || c || ' dropped', n)
FROM (SELECT 'linkedAtStage' AS c, count(*) FILTER (WHERE "linkedAtStage" IS NOT NULL) AS n FROM "InnerWorkSession"
      UNION ALL SELECT 'linkedTrigger', count(*) FILTER (WHERE "linkedTrigger" IS NOT NULL) FROM "InnerWorkSession"
      UNION ALL SELECT 'linkedAtMessageId', count(*) FILTER (WHERE "linkedAtMessageId" IS NOT NULL) FROM "InnerWorkSession"
      UNION ALL SELECT 'contentEmbedding (D8)', count(*) FILTER (WHERE "contentEmbedding" IS NOT NULL) FROM "InnerWorkSession") x
WHERE n > 0;
SELECT app_migration.note('15', t || ' dropped (D8)', n)
FROM (SELECT 'SessionTakeaway.embedding' AS t, count(*) FILTER (WHERE embedding IS NOT NULL) AS n FROM "SessionTakeaway"
      UNION ALL SELECT 'UserVessel.contentEmbedding', count(*) FILTER (WHERE "contentEmbedding" IS NOT NULL) FROM "UserVessel") x
WHERE n > 0;
SELECT app_migration.assert(a = b AND c = d AND e = f AND g = h,
         format('step 15: reflection %s/%s, reflection_message %s/%s, takeaway %s/%s, takeaway_link %s/%s', a, b, c, d, e, f, g, h))
FROM (SELECT (SELECT count(*) FROM reflection) AS a, (SELECT count(*) FROM "InnerWorkSession") AS b,
             (SELECT count(*) FROM reflection_message) AS c, (SELECT count(*) FROM "InnerWorkMessage") AS d,
             (SELECT count(*) FROM takeaway) AS e, (SELECT count(*) FROM "SessionTakeaway") AS f,
             (SELECT count(*) FROM takeaway_link) AS g, (SELECT count(*) FROM "TakeawayLink") AS h) x;

-- ---- Step 16: feature_state — one document per (user, feature) that has
-- any source row; each old row becomes an array element (to_jsonb of the row
-- minus userId), single rows become objects (null when absent). Documents:
--   meditation        {sessions[], favorites[], scripts[], preferences, stats}
--   gratitude         {entries[], preferences}
--   needs_assessment  {scores[] (+needSlug from the dropped taxonomy), state}
--   people            {persons[] each with mentions[]}
-- favorites[] is not in spec §1.7's key summary; MeditationFavorite is in its
-- Absorbs list, so it needs a key.
INSERT INTO feature_state (user_id, feature, doc, created_at, updated_at)
SELECT u.id, 'meditation', jsonb_build_object(
         'sessions', coalesce((SELECT jsonb_agg(to_jsonb(x) - 'userId' ORDER BY x."startedAt", x.id) FROM "MeditationSession" x WHERE x."userId" = u.id), '[]'::jsonb),
         'favorites', coalesce((SELECT jsonb_agg(to_jsonb(x) - 'userId' ORDER BY x."savedAt", x.id) FROM "MeditationFavorite" x WHERE x."userId" = u.id), '[]'::jsonb),
         'scripts', coalesce((SELECT jsonb_agg(to_jsonb(x) - 'userId' ORDER BY x."createdAt", x.id) FROM "SavedMeditation" x WHERE x."userId" = u.id), '[]'::jsonb),
         'preferences', (SELECT to_jsonb(x) - 'userId' FROM "MeditationPreferences" x WHERE x."userId" = u.id),
         'stats', (SELECT to_jsonb(x) - 'userId' FROM "MeditationStats" x WHERE x."userId" = u.id)),
       u."createdAt", now()
FROM "User" u
WHERE EXISTS (SELECT 1 FROM "MeditationSession" x WHERE x."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "MeditationFavorite" x WHERE x."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "SavedMeditation" x WHERE x."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "MeditationPreferences" x WHERE x."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "MeditationStats" x WHERE x."userId" = u.id);

INSERT INTO feature_state (user_id, feature, doc, created_at, updated_at)
SELECT u.id, 'gratitude', jsonb_build_object(
         'entries', coalesce((SELECT jsonb_agg(to_jsonb(x) - 'userId' ORDER BY x."createdAt", x.id) FROM "GratitudeEntry" x WHERE x."userId" = u.id), '[]'::jsonb),
         'preferences', (SELECT to_jsonb(x) - 'userId' FROM "GratitudePreferences" x WHERE x."userId" = u.id)),
       u."createdAt", now()
FROM "User" u
WHERE EXISTS (SELECT 1 FROM "GratitudeEntry" x WHERE x."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "GratitudePreferences" x WHERE x."userId" = u.id);

INSERT INTO feature_state (user_id, feature, doc, created_at, updated_at)
SELECT u.id, 'needs_assessment', jsonb_build_object(
         'scores', coalesce((SELECT jsonb_agg((to_jsonb(x) - 'userId') || jsonb_build_object('needSlug', n.slug) ORDER BY x."createdAt", x.id)
                             FROM "NeedScore" x JOIN "Need" n ON n.id = x."needId" WHERE x."userId" = u.id), '[]'::jsonb),
         'state', (SELECT to_jsonb(x) - 'userId' FROM "NeedsAssessmentState" x WHERE x."userId" = u.id)),
       u."createdAt", now()
FROM "User" u
WHERE EXISTS (SELECT 1 FROM "NeedScore" x WHERE x."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "NeedsAssessmentState" x WHERE x."userId" = u.id);

INSERT INTO feature_state (user_id, feature, doc, created_at, updated_at)
SELECT u.id, 'people', jsonb_build_object(
         'persons', coalesce((
           SELECT jsonb_agg((to_jsonb(x) - 'userId') || jsonb_build_object('mentions', coalesce((
                    SELECT jsonb_agg(to_jsonb(m) - 'userId' ORDER BY m."createdAt", m.id) FROM "PersonMention" m WHERE m."personId" = x.id), '[]'::jsonb))
                  ORDER BY x."firstMentioned", x.id)
           FROM "Person" x WHERE x."userId" = u.id), '[]'::jsonb)),
       u."createdAt", now()
FROM "User" u
WHERE EXISTS (SELECT 1 FROM "Person" x WHERE x."userId" = u.id);

-- Conservation: Σ array lengths per feature key = old row counts; one
-- document per single-row table row.
SELECT app_migration.assert(got = want, format('step 16: feature_state %s holds %s for %s old rows', what, got, want))
FROM (
  SELECT 'meditation.sessions' AS what, (SELECT coalesce(sum(jsonb_array_length(doc -> 'sessions')), 0) FROM feature_state WHERE feature = 'meditation') AS got, (SELECT count(*) FROM "MeditationSession") AS want
  UNION ALL SELECT 'meditation.favorites', (SELECT coalesce(sum(jsonb_array_length(doc -> 'favorites')), 0) FROM feature_state WHERE feature = 'meditation'), (SELECT count(*) FROM "MeditationFavorite")
  UNION ALL SELECT 'meditation.scripts', (SELECT coalesce(sum(jsonb_array_length(doc -> 'scripts')), 0) FROM feature_state WHERE feature = 'meditation'), (SELECT count(*) FROM "SavedMeditation")
  UNION ALL SELECT 'meditation.preferences', (SELECT count(*) FROM feature_state WHERE feature = 'meditation' AND jsonb_typeof(doc -> 'preferences') = 'object'), (SELECT count(*) FROM "MeditationPreferences")
  UNION ALL SELECT 'meditation.stats', (SELECT count(*) FROM feature_state WHERE feature = 'meditation' AND jsonb_typeof(doc -> 'stats') = 'object'), (SELECT count(*) FROM "MeditationStats")
  UNION ALL SELECT 'gratitude.entries', (SELECT coalesce(sum(jsonb_array_length(doc -> 'entries')), 0) FROM feature_state WHERE feature = 'gratitude'), (SELECT count(*) FROM "GratitudeEntry")
  UNION ALL SELECT 'gratitude.preferences', (SELECT count(*) FROM feature_state WHERE feature = 'gratitude' AND jsonb_typeof(doc -> 'preferences') = 'object'), (SELECT count(*) FROM "GratitudePreferences")
  UNION ALL SELECT 'needs_assessment.scores', (SELECT coalesce(sum(jsonb_array_length(doc -> 'scores')), 0) FROM feature_state WHERE feature = 'needs_assessment'), (SELECT count(*) FROM "NeedScore")
  UNION ALL SELECT 'needs_assessment.state', (SELECT count(*) FROM feature_state WHERE feature = 'needs_assessment' AND jsonb_typeof(doc -> 'state') = 'object'), (SELECT count(*) FROM "NeedsAssessmentState")
  UNION ALL SELECT 'people.persons', (SELECT coalesce(sum(jsonb_array_length(doc -> 'persons')), 0) FROM feature_state WHERE feature = 'people'), (SELECT count(*) FROM "Person")
  UNION ALL SELECT 'people.persons[].mentions', (SELECT coalesce(sum(jsonb_array_length(pp -> 'mentions')), 0) FROM feature_state, jsonb_array_elements(doc -> 'persons') pp WHERE feature = 'people'), (SELECT count(*) FROM "PersonMention")
) x;
`;
}

export function stepTelemetryAndAudit(): string {
  return `
-- ---- Step 17: the FK-less text ids. Each became a real FK above (or was
-- dropped, reported where it held a value); P25 refused any that is not
-- uuid-shaped. Here: every non-null source value resolved.
SELECT app_migration.assert(n = 0, format('step 17: %s.%s: %s non-null value(s) did not resolve', t, c, n))
FROM (
  SELECT 'Message' AS t, 'forUserId' AS c, (SELECT count(*) FROM "Message" m WHERE m."forUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message x WHERE x.id = m.id)) AS n
  UNION ALL SELECT 'ReconcilerResult', 'guesserId/subjectId', (SELECT count(*) FROM "ReconcilerResult" r WHERE NOT EXISTS (SELECT 1 FROM reconciler_result x WHERE x.id = r.id))
  UNION ALL SELECT 'ReconcilerShareOffer', 'userId', (SELECT count(*) FROM "ReconcilerShareOffer" o WHERE NOT EXISTS (SELECT 1 FROM context_share_offer x WHERE x.id = o.id))
  UNION ALL SELECT 'Stage4ProposalRevision', 'actorUserId', (SELECT count(*) FROM "Stage4ProposalRevision" r JOIN proposal_revision x ON x.id = r.id
                                                             WHERE r."actorUserId" IS NOT NULL AND x.actor_participant_id IS NULL)
  UNION ALL SELECT 'Stage4Closure', 'closedByUserId', (SELECT count(*) FROM "Stage4Closure" c JOIN session_closure x ON x.session_id = c."sessionId"
                                                       WHERE c."closedByUserId" IS NOT NULL AND x.closed_by_participant_id IS NULL)
  UNION ALL SELECT 'TendingEntry', 'ownerUserId', (SELECT count(*) FROM "TendingEntry" e JOIN follow_up x ON x.id = e.id
                                                   WHERE e."ownerUserId" IS NOT NULL AND x.owner_participant_id IS NULL)
  UNION ALL SELECT 'Stage4NeedDeclination', 'userId', (SELECT count(*) FROM "Stage4NeedDeclination" d
                                                       WHERE NOT EXISTS (SELECT 1 FROM participant p WHERE p.session_id = d."sessionId" AND p.user_id = app_migration.as_uuid(d."userId")))
  UNION ALL SELECT 'TendingNeedOutcome', 'sourceUserId', (SELECT count(*) FROM "TendingNeedOutcome" n
                                                          WHERE n."sourceUserId" IS NOT NULL
                                                            AND NOT EXISTS (SELECT 1 FROM participant p WHERE p.session_id = n."sessionId" AND p.user_id = app_migration.as_uuid(n."sourceUserId")))
) x;
SELECT app_migration.note('17', 'TendingNeedOutcome.needId kept as label (not a shared need)', count(*))
FROM "TendingNeedOutcome" n
WHERE n."needId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM need_share ns WHERE ns.need_id = app_migration.as_uuid(n."needId"));
SELECT app_migration.note('17', 'GratitudeEntry/MeditationSession.linkedConflictId kept inside the feature document', count(*))
FROM (SELECT "linkedConflictId" FROM "GratitudeEntry" WHERE "linkedConflictId" IS NOT NULL
      UNION ALL SELECT "linkedConflictId" FROM "MeditationSession" WHERE "linkedConflictId" IS NOT NULL) x;

-- ---- Step 18: brain_activity ← BrainActivity (ids kept; innerWorkSessionId →
-- reflection_id; participant_id NULL for history; cost float → numeric(10,6)).
INSERT INTO brain_activity (id, session_id, reflection_id, participant_id, turn_id, activity_type, call_type, model, input, output, metadata,
                            structured_output, token_count_input, token_count_output, duration_ms, cost, status, created_at, completed_at, updated_at)
SELECT id, "sessionId", "innerWorkSessionId", NULL, "turnId", "activityType"::text::activity_type, "callType"::text::brain_call_type, model,
       app_migration.jnull(input), app_migration.jnull(output), app_migration.jnull(metadata), app_migration.jnull("structuredOutput"),
       "tokenCountInput", "tokenCountOutput", "durationMs", round(cost::numeric, 6), status::text::activity_status,
       "createdAt", "completedAt", coalesce("completedAt", "createdAt")
FROM "BrainActivity";
SELECT app_migration.assert(a = b, format('step 18: %s brain_activity rows for %s "BrainActivity" rows', a, b))
FROM (SELECT (SELECT count(*) FROM brain_activity) AS a, (SELECT count(*) FROM "BrainActivity") AS b) x;

-- Tables dropped by decision, counted.
${DROPPED_COUNTED.map(([t, why]) => `SELECT app_migration.note('19', ${lit(`${t} dropped: ${why}`)}, count(*)) FROM ${q(t)};`).join('\n')}

-- Row counts after the copy: the 47 target tables.
DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relname ~ '^[a-z]' AND c.relname <> '_prisma_migrations'
           ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    INSERT INTO app_migration.row_counts VALUES ('after', t, n);
  END LOOP;
END
$$;
`;
}

export function stepDrop(): string {
  return `
-- ---- Step 19: drop the 68 old tables and 51 old enum types (after every
-- assertion above), and the work tables that read them. One DROP statement,
-- so the old FKs between them need no ordering.
DROP VIEW app_migration.pair, app_migration.vanished;
DROP TABLE ${OLD_TABLES.map(q).join(', ')};
DROP TABLE app_migration.precheck, app_migration.su, app_migration.ab_slot, app_migration.checkin_map,
           app_migration.milestone_src, app_migration.disposition_ref, app_migration.proposal_need_src,
           app_migration.slot_fix, app_migration.empathy_attempt_src, app_migration.empathy_validation_src;
DROP TYPE ${OLD_ENUMS.map(q).join(', ')};

DO $$
DECLARE
  extra text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO extra
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND c.relname !~ '^[a-z_]';
  PERFORM app_migration.assert(extra IS NULL, format('step 19: old relation(s) remain: %s', extra));
  SELECT string_agg(t.typname, ', ' ORDER BY t.typname) INTO extra
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype = 'e' AND t.typname !~ '^[a-z_]';
  PERFORM app_migration.assert(extra IS NULL, format('step 19: old enum type(s) remain: %s', extra));
  PERFORM app_migration.assert(
    (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations') = 47,
    format('step 19: %s tables in public, expected the 47 of the target', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations')));
END
$$;
`;
}
