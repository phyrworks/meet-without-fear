-- ============================================================================
-- sql-only.sql — target shape, October 2026 (TS-6)
--
-- Spec: docs/backend/data-model/schema-target-2026-10.md (§1 Keys lines, §5).
--
-- The `sql_`-prefixed partial / expression indexes (spec §5 "Lives only in
-- migration SQL"; never give a Prisma index one of these names): objects
-- `prisma migrate diff` ignores but `prisma db pull` CAN see, which
-- schema.prisma deliberately does not declare.
--
-- The migration generator splices this file, verbatim, into the trailer of
-- the baseline (T2), after tables.sql has created the tables. Since
-- work-a39h.11.40 everything else that used to be here or in the trailer —
-- the generated columns user.name and consent.target_kind, the CHECKs, the
-- domains — is inline in tables.sql; these indexes stay apart because the
-- drift gate needs them in a second stage (below).
--
-- Gate: backend/scripts/target-shape/check-schema.sh applies tables.sql, pulls
-- (must equal schema.prisma), then applies this file and pulls again (only
-- these sql_ objects may differ) and proves the drift diff is empty.
--
-- `migrate diff` ignores these (gate step b), but Prisma 7.10 `db pull` DOES
-- render them — as `@unique(map: "sql_…", where: raw(…))` / `@@index(…, where:)`
-- plus `previewFeatures = [… "partialIndexes"]`, and it turns the back-relation
-- of every single-column one into a 1:1 (`Conversation?` instead of
-- `Conversation[]`). schema.prisma deliberately does not declare them
-- (spec §5); NEVER run `prisma db pull` to refresh schema.prisma.
--
-- These indexes keep their names: check-schema.sh checks them by name (spec
-- §5 list ⊆ this file ⊆ db pull), and schema.prisma and the code cite them
-- (e.g. sql_draft_one_per_point in stream-turn-actions.ts, sql_follow_up_due
-- in tending.service.ts).
-- ============================================================================

-- user — exactly one AI principal (work-k5fk.3; tables.sql seeds it)
CREATE UNIQUE INDEX sql_user_one_ai ON "user" (kind) WHERE kind = 'ai';
COMMENT ON INDEX sql_user_one_ai IS 'At most one user of kind ai: the AI principal seeded with the baseline (app.ai_user_id()).';

-- §1.1 participant — work-k5fk.2: at most one initiator, the participant nobody added
CREATE UNIQUE INDEX sql_participant_one_initiator ON participant (session_id)
  WHERE added_by_user_id IS NULL;
COMMENT ON INDEX sql_participant_one_initiator IS 'At most one initiator per session (work-k5fk.2): at most one participant without an adder (replaces relationship_member.role = owner). The one-live-session rule is live_session_pair''s key, not an index here.';

-- §1.1 conversation — exactly one MAIN thread per participant
CREATE UNIQUE INDEX sql_conversation_one_main ON conversation (session_id, user_id)
  WHERE kind = 'MAIN';
COMMENT ON INDEX sql_conversation_one_main IS 'Exactly one MAIN conversation per participant; sub-chats are unlimited.';

-- §1.1 draft — one draft per sharing point (adversarial P1-5). An expression
-- index, so it cannot be a Prisma @@unique; not in §5's list by name. The
-- invitation arm (work-99k2) is per invitee, so one EMPATHY draft per subject
-- still holds before the subject has joined.
CREATE UNIQUE INDEX sql_draft_one_per_point ON draft
  (session_id, user_id, kind, (coalesce(about_user_id, invitation_id, attempt_id, share_offer_id)));
COMMENT ON INDEX sql_draft_one_per_point IS 'One draft per participant, kind and sharing point (whichever arc column is set), so N subjects or N attempts do not collide. The draft upsert (empathy-store.ts upsertDraft) conflicts on it.';

-- §1.1 session_key / participant_key, §1.7 user_key — one live key per owner
CREATE UNIQUE INDEX sql_session_key_live ON session_key (session_id)
  WHERE destroyed_at IS NULL;
COMMENT ON INDEX sql_session_key_live IS 'At most one live (not shredded) key per session.';
CREATE UNIQUE INDEX sql_participant_key_live ON participant_key (session_id, user_id)
  WHERE destroyed_at IS NULL;
COMMENT ON INDEX sql_participant_key_live IS 'At most one live (not shredded) key per participant.';
CREATE UNIQUE INDEX sql_user_key_live ON user_key (user_id)
  WHERE destroyed_at IS NULL;
COMMENT ON INDEX sql_user_key_live IS 'At most one live (not shredded) key per user.';

-- §1.1 message — work-fdc1: an app-generated facilitator line at most once per
-- conversation. The idempotency key of the two once-only writers (stage2
-- validateEmpathy's hold-here note, stage4's hand-off bridge): they insert and
-- treat a conflict here as "already written", so two concurrent calls write one
-- row. Replaces the sha256(content) probe (no content-derived value is stored).
CREATE UNIQUE INDEX sql_message_once ON message (conversation_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
COMMENT ON INDEX sql_message_once IS 'At most one message per conversation and dedupe_key: the once-only facilitator lines (message_dedupe_key). Their writers insert and treat a conflict as already written.';

-- §1.2 empathy_attempt — one live attempt per direction
CREATE UNIQUE INDEX sql_attempt_one_live_per_direction ON empathy_attempt
  (session_id, author_user_id, subject_user_id)
  WHERE status NOT IN ('SUPERSEDED', 'VALIDATED');
COMMENT ON INDEX sql_attempt_one_live_per_direction IS 'At most one live empathy attempt per author and subject; SUPERSEDED and VALIDATED rounds are history.';

-- §1.2 reconciler_result — one current result per attempt
CREATE UNIQUE INDEX sql_result_one_current ON reconciler_result (attempt_id)
  WHERE superseded_at IS NULL;
COMMENT ON INDEX sql_result_one_current IS 'At most one current (not superseded) reconciler result per attempt.';

-- §1.4 need — live needs per participant
CREATE INDEX sql_need_live ON need (session_id, user_id)
  WHERE deleted_at IS NULL;
COMMENT ON INDEX sql_need_live IS 'A participant''s live (not deleted) needs.';

-- §1.4 need_disposition — one current need per walkthrough
CREATE UNIQUE INDEX sql_disposition_one_current ON need_disposition (session_id, user_id)
  WHERE is_current;
COMMENT ON INDEX sql_disposition_one_current IS 'At most one need marked current per participant: the need the Stage-4 walkthrough is on.';

-- §1.1 ai_memory — one document per (user, session, kind), GLOBAL_FACTS (no
-- session) once per user. Two partial indexes, not the UNIQUE NULLS NOT DISTINCT
-- of design note Q12: a plain unique index is one Prisma sees, so a sql-only one
-- would make the drift gate's migrate diff drop it (measured, work-k5fk.3); a
-- partial one it ignores. The writers' ON CONFLICT names the arm's predicate.
CREATE UNIQUE INDEX sql_ai_memory_one_per_participant ON ai_memory (user_id, session_id, kind)
  WHERE session_id IS NOT NULL;
COMMENT ON INDEX sql_ai_memory_one_per_participant IS 'One SUMMARY and one NOTABLE_FACTS document per participant (session, user); the summarizer and classifier upsert on it (ON CONFLICT (user_id, session_id, kind) WHERE session_id IS NOT NULL).';
CREATE UNIQUE INDEX sql_ai_memory_one_global ON ai_memory (user_id, kind)
  WHERE session_id IS NULL;
COMMENT ON INDEX sql_ai_memory_one_global IS 'One GLOBAL_FACTS document per user; global-memory upserts on it (ON CONFLICT (user_id, kind) WHERE session_id IS NULL).';

-- §1.5 follow_up — the open-due job
CREATE INDEX sql_follow_up_due ON follow_up (scheduled_for)
  WHERE status = 'SCHEDULED';
COMMENT ON INDEX sql_follow_up_due IS 'The job''s scan for SCHEDULED follow-ups that are due (open-due-tending-entries).';

-- §1.5 reminder — the delivery job
CREATE INDEX sql_reminder_due ON reminder (remind_at)
  WHERE status = 'SCHEDULED';
COMMENT ON INDEX sql_reminder_due IS 'The job''s scan for SCHEDULED reminders that are due.';

-- §1.7 user_device — Expo tokens are per install (adversarial P2)
CREATE UNIQUE INDEX sql_user_device_token ON user_device (user_id, push_token)
  WHERE push_token IS NOT NULL;
COMMENT ON INDEX sql_user_device_token IS 'A push token is registered once per user (Expo tokens are per install).';
