-- ============================================================================
-- Golden harness — `old_concept_*` views over the TARGET shape (TS-9).
--
-- The counterpart of `current-shape.sql`, whose header states the contract:
-- the SAME view names with the SAME column sets (names and order), so a
-- normalised baseline recorded on the current shape compares against a run on
-- the target under its scenario's allow-list. Owned by the golden harness
-- (TS-4 ruling R9): applied to each run database after `restoreFixture`,
-- never a migration.
--
-- Over the target these views are close to identity projections — the target
-- tables ARE the vocabulary the current-shape views translate into. What they
-- still do:
--   * Timestamps: the target is timestamptz; every one is projected
--     `AT TIME ZONE 'UTC'` to the naive `timestamp` the current-shape views
--     emit, so both files render one instant as the same text.
--   * Enums are projected as text, as in current-shape.sql.
--   * Columns the current-shape views do not project (e.g. message has no
--     updated_at at all; invitation.updated_at, conversation.created_at,
--     context_share_offer.offered_at are left out there) are left out here.
--   * `need.confirmed` is `confirmed_at IS NOT NULL` (the old shape has only
--     the boolean; current-shape.sql's comment names this projection).
--
-- No minted ids here: the target stores participant, conversation and draft
-- ids, so every id is the row's own. The normaliser labels them from their
-- natural keys exactly as it labels the md5 ids of current-shape.sql.
--
-- `concept_check_*`: the current-shape checks guard states the migration
-- mapping could not represent. On the target most are enforced by
-- constraints; the three kept below are the ones whose subject still exists as
-- data (a NULL-safe restatement of the CHECK / NOT NULL), so a regression that
-- loosened the constraint still fails the snapshot. The gate-key and
-- read-state checks have no subject on the target (no gate JSON; the read
-- state's PK is the participant) and are not carried.
-- ============================================================================


-- user — spec §1.7. `name` is the generated column.
CREATE VIEW old_concept_user AS
SELECT
  u.id,
  u.clerk_id,
  u.email,
  u.first_name,
  u.last_name,
  u.name,
  u.deleted_at AT TIME ZONE 'UTC' AS deleted_at,
  u.created_at AT TIME ZONE 'UTC' AS created_at,
  u.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM "user" u;


-- session — spec §1.1.
CREATE VIEW old_concept_session AS
SELECT
  s.id,
  s.relationship_id,
  s.status::text AS status,
  s.topic_frame,
  s.topic_frame_confirmed_at AT TIME ZONE 'UTC' AS topic_frame_confirmed_at,
  s.previous_session_id,
  s.resolved_at AT TIME ZONE 'UTC' AS resolved_at,
  s.created_at  AT TIME ZONE 'UTC' AS created_at,
  s.updated_at  AT TIME ZONE 'UTC' AS updated_at
FROM session s;


-- participant — spec §1.1.
CREATE VIEW old_concept_participant AS
SELECT
  p.id,
  p.session_id,
  p.user_id,
  p.kind::text AS kind,
  p.display_name,
  p.joined_at AT TIME ZONE 'UTC' AS joined_at,
  p.left_at   AT TIME ZONE 'UTC' AS left_at
FROM participant p;


-- conversation — spec §1.1 (created_at not projected, as in current-shape.sql).
CREATE VIEW old_concept_conversation AS
SELECT
  c.id,
  c.participant_id,
  c.kind::text AS kind,
  c.anchor_kind::text AS anchor_kind,
  c.anchor_proposal_id,
  c.status::text AS status,
  c.resolved_at AT TIME ZONE 'UTC' AS resolved_at
FROM conversation c;


-- participant_milestone — spec §1.1. The table itself; no decoding.
CREATE VIEW old_concept_participant_milestone AS
SELECT
  pm.participant_id,
  pm.milestone_key,
  pm.reached_at AT TIME ZONE 'UTC' AS reached_at
FROM participant_milestone pm;


-- message — spec §1.1 (no updated_at: append-only).
CREATE VIEW old_concept_message AS
SELECT
  m.id,
  m.conversation_id,
  m.sender_participant_id,
  m.role::text AS role,
  m.kind::text AS kind,
  m.content,
  m.content_hash,
  m.refining_need_id,
  m.source_attempt_id,
  m.created_at AT TIME ZONE 'UTC' AS created_at
FROM message m;


-- empathy_attempt — spec §1.2.
CREATE VIEW old_concept_empathy_attempt AS
SELECT
  a.id,
  a.author_participant_id,
  a.subject_participant_id,
  a.round,
  a.supersedes_attempt_id,
  a.content,
  a.status::text AS status,
  a.status_version,
  a.submitted_at AT TIME ZONE 'UTC' AS submitted_at,
  a.revealed_at  AT TIME ZONE 'UTC' AS revealed_at,
  a.delivery_status::text AS delivery_status,
  a.delivered_at AT TIME ZONE 'UTC' AS delivered_at,
  a.seen_at      AT TIME ZONE 'UTC' AS seen_at
FROM empathy_attempt a;


-- A direction the target's NOT NULLs already guarantee; kept so a loosened
-- column cannot slip a directionless attempt past the snapshot.
CREATE VIEW concept_check_attempt_without_direction AS
SELECT id, author_participant_id IS NULL AS no_author, subject_participant_id IS NULL AS no_subject
FROM old_concept_empathy_attempt
WHERE author_participant_id IS NULL OR subject_participant_id IS NULL;


-- empathy_review — spec §1.2.
CREATE VIEW old_concept_empathy_review AS
SELECT
  v.id,
  v.attempt_id,
  v.reviewer_participant_id,
  v.validated,
  v.feedback,
  v.feedback_sent_at AT TIME ZONE 'UTC' AS feedback_sent_at
FROM empathy_review v;


-- reconciler_result — spec §1.2.
CREATE VIEW old_concept_reconciler_result AS
SELECT
  r.id,
  r.attempt_id,
  r.subject_participant_id,
  r.iteration,
  r.alignment_score,
  r.alignment_summary,
  r.gap_summary,
  r.gap_severity::text AS gap_severity,
  r.correctly_identified,
  r.missed_feelings,
  r.misattributions,
  r.most_important_gap,
  r.recommended_action::text AS recommended_action,
  r.rationale,
  r.sharing_would_help,
  r.suggested_share_focus,
  r.suggested_share_content,
  r.suggested_share_reason,
  r.circuit_breaker_tripped,
  r.superseded_at AT TIME ZONE 'UTC' AS superseded_at,
  r.created_at    AT TIME ZONE 'UTC' AS created_at
FROM reconciler_result r;


-- reconciler_guidance — spec §1.2.
CREATE VIEW old_concept_reconciler_guidance AS
SELECT
  g.result_id,
  g.author_participant_id,
  g.subject_participant_id,
  g.area_hint,
  g.guidance_type,
  g.prompt_seed,
  g.created_at AT TIME ZONE 'UTC' AS created_at
FROM reconciler_guidance g;


-- context_share_offer — spec §1.2 (offered_at not projected, as in current-shape.sql).
CREATE VIEW old_concept_context_share_offer AS
SELECT
  o.id,
  o.attempt_id,
  o.result_id,
  o.subject_participant_id,
  o.iteration,
  o.status::text AS status,
  o.offer_message,
  o.suggested_content,
  o.suggested_reason,
  o.shared_content,
  o.shared_at   AT TIME ZONE 'UTC' AS shared_at,
  o.declined_at AT TIME ZONE 'UTC' AS declined_at,
  o.delivery_status::text AS delivery_status,
  o.delivered_at AT TIME ZONE 'UTC' AS delivered_at,
  o.seen_at      AT TIME ZONE 'UTC' AS seen_at,
  o.delivery_notified_at AT TIME ZONE 'UTC' AS delivery_notified_at,
  o.seen_notified_at     AT TIME ZONE 'UTC' AS seen_notified_at,
  o.created_at AT TIME ZONE 'UTC' AS created_at,
  o.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM context_share_offer o;


-- draft — spec §1.1.
CREATE VIEW old_concept_draft AS
SELECT
  d.id,
  d.participant_id,
  d.kind::text AS kind,
  d.about_participant_id,
  d.attempt_id,
  d.share_offer_id,
  d.content,
  d.ready_to_share,
  d.version,
  d.created_at AT TIME ZONE 'UTC' AS created_at,
  d.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM draft d;


-- need — spec §1.4. `confirmed` = confirmed_at IS NOT NULL (see header).
CREATE VIEW old_concept_need AS
SELECT
  n.id,
  n.participant_id,
  n.label,
  n.category::text AS category,
  n.evidence,
  -- real (spec) → its shortest decimal, then double: 0.9 stays 0.9 (a plain
  -- real→double cast widens it to 0.8999999761581421; TS-11 post-merge).
  n.ai_confidence::text::double precision AS ai_confidence,
  n.confirmed_at IS NOT NULL AS confirmed,
  n.locked_at AT TIME ZONE 'UTC' AS locked_at,
  n.superseded_by_need_id,
  n.deleted_at AT TIME ZONE 'UTC' AS deleted_at,
  n.created_at AT TIME ZONE 'UTC' AS created_at
FROM need n;


-- need_share — spec §1.4.
CREATE VIEW old_concept_need_share AS
SELECT
  s.need_id,
  s.participant_id,
  s.session_id,
  s.category::text AS category,
  s.shared_text,
  s.shared_at  AT TIME ZONE 'UTC' AS shared_at,
  s.revoked_at AT TIME ZONE 'UTC' AS revoked_at,
  s.created_at AT TIME ZONE 'UTC' AS created_at
FROM need_share s;


-- need_disposition — spec §1.4.
CREATE VIEW old_concept_need_disposition AS
SELECT
  d.participant_id,
  d.need_id,
  d.status::text AS status,
  d.is_current,
  d.note
FROM need_disposition d;


-- proposal — spec §1.4.
CREATE VIEW old_concept_proposal AS
SELECT
  p.id,
  p.session_id,
  p.created_by_participant_id,
  p.source::text AS source,
  p.kind::text AS kind,
  p.status::text AS status,
  p.description,
  p.duration,
  p.measure_of_success,
  p.unresolved_need_labels,
  p.removed_at AT TIME ZONE 'UTC' AS removed_at,
  p.removed_by_participant_id,
  p.removal_reason,
  p.shared_at  AT TIME ZONE 'UTC' AS shared_at,
  p.created_at AT TIME ZONE 'UTC' AS created_at,
  p.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM proposal p;


-- proposal_need — spec §1.4.
CREATE VIEW old_concept_proposal_need AS
SELECT pn.proposal_id, pn.need_id, pn.created_at AT TIME ZONE 'UTC' AS created_at
FROM proposal_need pn;


-- proposal_choice — spec §1.4.
CREATE VIEW old_concept_proposal_choice AS
SELECT
  c.proposal_id,
  c.participant_id,
  c.decision::text AS decision,
  c.note,
  c.created_at AT TIME ZONE 'UTC' AS created_at,
  c.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM proposal_choice c;


-- agreement — spec §1.4 (created_at/updated_at not projected, as in current-shape.sql).
CREATE VIEW old_concept_agreement AS
SELECT
  a.id,
  a.session_id,
  a.proposal_id,
  a.type::text AS type,
  a.status::text AS status,
  a.description,
  a.duration,
  a.measure_of_success,
  a.follow_up_at AT TIME ZONE 'UTC' AS follow_up_at,
  a.completed_at AT TIME ZONE 'UTC' AS completed_at
FROM agreement a;


-- agreement_party — spec §1.4.
CREATE VIEW old_concept_agreement_party AS
SELECT ap.agreement_id, ap.participant_id, ap.agreed_at AT TIME ZONE 'UTC' AS agreed_at
FROM agreement_party ap;


-- consent — spec §1.3. target_kind is the generated column.
CREATE VIEW old_concept_consent AS
SELECT
  c.id,
  c.participant_id,
  c.requested_by_participant_id,
  c.need_id,
  c.empathy_attempt_id,
  c.proposal_id,
  c.share_offer_id,
  c.review_id,
  c.target_kind::text AS target_kind,
  c.decision::text AS decision,
  c.decided_at AT TIME ZONE 'UTC' AS decided_at,
  c.revoked_at AT TIME ZONE 'UTC' AS revoked_at,
  c.created_at AT TIME ZONE 'UTC' AS created_at
FROM consent c;


-- The arc CHECK, restated (see header).
CREATE VIEW concept_check_consent_unresolved_arc AS
SELECT id, target_kind, participant_id IS NULL AS no_participant
FROM old_concept_consent
WHERE target_kind IS NULL
   OR participant_id IS NULL
   OR num_nonnulls(need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id) <> 1;


-- reflection — spec §1.6.
CREATE VIEW old_concept_reflection AS
SELECT
  r.id,
  r.user_id,
  r.title,
  r.theme,
  r.status::text AS status,
  r.summary,
  r.summary_doc,
  r.linked_session_id,
  r.linked_at AT TIME ZONE 'UTC' AS linked_at,
  r.context_snapshot,
  r.distilled_at AT TIME ZONE 'UTC' AS distilled_at,
  r.created_at   AT TIME ZONE 'UTC' AS created_at,
  r.updated_at   AT TIME ZONE 'UTC' AS updated_at
FROM reflection r;


-- reflection_message — spec §1.6.
CREATE VIEW old_concept_reflection_message AS
SELECT m.id, m.reflection_id, m.role::text AS role, m.content, m.created_at AT TIME ZONE 'UTC' AS created_at
FROM reflection_message m;


-- takeaway — spec §1.6.
CREATE VIEW old_concept_takeaway AS
SELECT
  t.id,
  t.reflection_id,
  t.content,
  t.theme,
  t.source::text AS source,
  t.type::text AS type,
  t.position,
  t.resolved_at AT TIME ZONE 'UTC' AS resolved_at,
  t.created_at  AT TIME ZONE 'UTC' AS created_at,
  t.updated_at  AT TIME ZONE 'UTC' AS updated_at
FROM takeaway t;


-- takeaway_link — spec §1.6.
CREATE VIEW old_concept_takeaway_link AS
SELECT l.source_id, l.target_id, l.link_type::text AS link_type, l.similarity::double precision AS similarity,
       l.created_at AT TIME ZONE 'UTC' AS created_at
FROM takeaway_link l;


-- ============================================================================
-- TS-5 additions.
-- ============================================================================

-- invitation — spec §1.1 (updated_at not projected, as in current-shape.sql).
CREATE VIEW old_concept_invitation AS
SELECT
  i.id,
  i.session_id,
  i.invited_by_participant_id,
  i.accepted_by_user_id,
  i.name,
  i.status::text AS status,
  i.message_confirmed_at AT TIME ZONE 'UTC' AS message_confirmed_at,
  i.expires_at  AT TIME ZONE 'UTC' AS expires_at,
  i.accepted_at AT TIME ZONE 'UTC' AS accepted_at,
  i.declined_at AT TIME ZONE 'UTC' AS declined_at,
  i.decline_reason,
  i.created_at  AT TIME ZONE 'UTC' AS created_at
FROM invitation i;


-- conversation_read_state — spec §1.1.
CREATE VIEW old_concept_conversation_read_state AS
SELECT
  r.participant_id,
  r.last_viewed_at AT TIME ZONE 'UTC' AS last_viewed_at,
  r.last_seen_message_id,
  r.last_viewed_share_tab_at AT TIME ZONE 'UTC' AS last_viewed_share_tab_at,
  r.last_active_at AT TIME ZONE 'UTC' AS last_active_at,
  r.archived_at    AT TIME ZONE 'UTC' AS archived_at,
  r.updated_at     AT TIME ZONE 'UTC' AS updated_at
FROM conversation_read_state r;


-- The invitation CHECK, restated (see header).
CREATE VIEW concept_check_invitation_accepted_without_acceptor AS
SELECT id, accepted_by_user_id IS NULL AS no_acceptor, accepted_at IS NULL AS no_accepted_at
FROM old_concept_invitation
WHERE status = 'ACCEPTED' AND (accepted_by_user_id IS NULL OR accepted_at IS NULL);


-- session_closure — spec §1.4.
CREATE VIEW old_concept_session_closure AS
SELECT
  c.session_id,
  c.kind::text AS kind,
  c.reason::text AS reason,
  c.summary,
  c.closed_by_participant_id,
  c.check_in_at AT TIME ZONE 'UTC' AS check_in_at,
  c.closed_at   AT TIME ZONE 'UTC' AS closed_at,
  c.created_at  AT TIME ZONE 'UTC' AS created_at
FROM session_closure c;


-- brain_activity — spec §1.8 (updated_at not projected, as in current-shape.sql).
CREATE VIEW old_concept_brain_activity AS
SELECT
  b.id,
  b.session_id,
  b.reflection_id,
  b.participant_id,
  b.turn_id,
  b.activity_type::text AS activity_type,
  b.call_type::text AS call_type,
  b.model,
  b.input,
  b.output,
  b.metadata,
  b.structured_output,
  b.token_count_input,
  b.token_count_output,
  b.duration_ms,
  b.cost,
  b.status::text AS status,
  b.created_at   AT TIME ZONE 'UTC' AS created_at,
  b.completed_at AT TIME ZONE 'UTC' AS completed_at
FROM brain_activity b;
