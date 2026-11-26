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
-- Two minted ids: a participant has no id of its own since work-k5fk.3 (its key
-- is (session_id, user_id)), so the views derive the concept's participant id
-- as md5('participant:' || session_id || ':' || user_id)::uuid wherever a row
-- names one — current-shape.sql's own formula for its keyless participant rows.
-- A message has none since work-k5fk.4 (its key is (conversation_id, seq)): the
-- views derive its concept id as the first 20 hex digits of
-- md5('message:' || conversation_id) followed by seq as 12 hex digits — a uuid
-- that sorts by seq within a conversation, as the uuidv7 id sorted by creation,
-- so the normaliser's id tie-break orders a conversation's lines as before; the
-- normaliser reads seq back from the last 12 digits to label the API's
-- "<conversation_id>:<seq>" id with the same label. Every other id is the row's
-- own. The normaliser labels them from their natural keys either way.
--
-- `concept_check_*`: the current-shape checks guard states the migration
-- mapping could not represent. On the target most are enforced by
-- constraints; the three kept below are the ones whose subject still exists as
-- data (a NULL-safe restatement of the CHECK / NOT NULL), so a regression that
-- loosened the constraint still fails the snapshot. The gate-key and
-- read-state checks have no subject on the target (no gate JSON; the read
-- state's PK is the participant) and are not carried.
-- ============================================================================


-- user — spec §1.7. `name` is the generated column. work-k5fk.1: the
-- old clerk_id is the user's sign-in subject in user_identity (a fixture user
-- and an E2E-bypass user have exactly one, of provider e2e). The scalar
-- subquery has no LIMIT on purpose: a user with two identities has no single
-- old clerk_id, and the snapshot fails ("more than one row returned by a
-- subquery") rather than pick one. The old shape had only accounts, so the AI
-- principal and personas (kind ai / persona) are not projected.
CREATE VIEW old_concept_user AS
SELECT
  u.id,
  (SELECT i.subject FROM user_identity i WHERE i.user_id = u.id) AS clerk_id,
  u.email,
  u.first_name,
  u.last_name,
  u.name,
  u.deleted_at AT TIME ZONE 'UTC' AS deleted_at,
  u.created_at AT TIME ZONE 'UTC' AS created_at,
  u.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM "user" u
WHERE u.kind = 'human';


-- session — spec §1.1. work-k5fk.2 (review round 1, F5): the target has no
-- relationship, so the view has no relationship_id. A synthesised id was
-- tried and dropped: it compared equal for any value the labeller mapped to
-- <relationship:main>, so it asserted nothing. The comparison names the
-- dropped column instead (allow-lists/relationship-dropped.ts
-- RELATIONSHIP_ID_CONCEPT_RULE; concept-views.test DROPPED_COLUMNS).
CREATE VIEW old_concept_session AS
SELECT
  s.id,
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
  md5('participant:' || p.session_id::text || ':' || p.user_id::text)::uuid AS id,
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
  md5('participant:' || c.session_id::text || ':' || c.user_id::text)::uuid AS participant_id,
  c.kind::text AS kind,
  c.anchor_kind::text AS anchor_kind,
  c.anchor_proposal_id,
  c.status::text AS status,
  c.resolved_at AT TIME ZONE 'UTC' AS resolved_at
FROM conversation c;


-- participant_milestone — spec §1.1. The table itself; no decoding.
CREATE VIEW old_concept_participant_milestone AS
SELECT
  md5('participant:' || pm.session_id::text || ':' || pm.user_id::text)::uuid AS participant_id,
  pm.milestone_key,
  pm.reached_at AT TIME ZONE 'UTC' AS reached_at
FROM participant_milestone pm;


-- message — spec §1.1 (no updated_at: append-only).
CREATE VIEW old_concept_message AS
SELECT
  (substr(md5('message:' || m.conversation_id::text), 1, 20) || lpad(to_hex(m.seq), 12, '0'))::uuid AS id,
  m.conversation_id,
  md5('participant:' || m.session_id::text || ':' || m.sender_user_id::text)::uuid AS sender_participant_id,
  m.role::text AS role,
  m.kind::text AS kind,
  m.content,
  -- work-fdc1: the target stores no digest of a message (content_hash was a
  -- plaintext oracle). The recorded baselines hold the old column, which was
  -- sha256(content) on every row they contain, so the concept column is
  -- recomputed here, harness-side, from the (keyless, plaintext) content: it
  -- says nothing content does not, and nothing is stored.
  encode(sha256(convert_to(m.content, 'UTF8')), 'hex') AS content_hash,
  m.refining_need_id,
  m.source_attempt_id,
  m.created_at AT TIME ZONE 'UTC' AS created_at
FROM message m;


-- empathy_attempt — spec §1.2.
CREATE VIEW old_concept_empathy_attempt AS
SELECT
  a.id,
  md5('participant:' || a.session_id::text || ':' || a.author_user_id::text)::uuid AS author_participant_id,
  md5('participant:' || a.session_id::text || ':' || a.subject_user_id::text)::uuid AS subject_participant_id,
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
  md5('participant:' || v.session_id::text || ':' || v.reviewer_user_id::text)::uuid AS reviewer_participant_id,
  v.validated,
  v.feedback,
  v.feedback_sent_at AT TIME ZONE 'UTC' AS feedback_sent_at
FROM empathy_review v;


-- reconciler_result — spec §1.2.
CREATE VIEW old_concept_reconciler_result AS
SELECT
  r.id,
  r.attempt_id,
  md5('participant:' || r.session_id::text || ':' || r.subject_user_id::text)::uuid AS subject_participant_id,
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
  md5('participant:' || g.session_id::text || ':' || g.author_user_id::text)::uuid AS author_participant_id,
  md5('participant:' || g.session_id::text || ':' || g.subject_user_id::text)::uuid AS subject_participant_id,
  -- work-k5fk.9 (Q4): the stored label and the derived seed, as the phrases the current shape stored
  -- (reconciler/guidance-phrases.ts)
  CASE g.area_hint
    WHEN 'work_effort' THEN 'work and effort'
    WHEN 'connection_closeness' THEN 'connection and closeness'
    WHEN 'safety_security' THEN 'safety and security'
    WHEN 'heard_understood' THEN 'being heard and understood'
    WHEN 'respect_value' THEN 'respect and value'
    WHEN 'deeper_emotions' THEN 'deeper emotional experiences'
  END AS area_hint,
  g.guidance_type,
  CASE g.guidance_type
    WHEN 'challenge_assumptions' THEN 'what might be different from your initial understanding'
    WHEN 'explore_breadth' THEN 'other aspects of their experience'
    WHEN 'explore_deeper_feelings' THEN 'what might be underneath the surface'
  END AS prompt_seed,
  g.created_at AT TIME ZONE 'UTC' AS created_at
FROM reconciler_guidance g;


-- context_share_offer — spec §1.2 (offered_at not projected, as in current-shape.sql).
CREATE VIEW old_concept_context_share_offer AS
SELECT
  o.id,
  o.attempt_id,
  o.result_id,
  md5('participant:' || o.session_id::text || ':' || o.subject_user_id::text)::uuid AS subject_participant_id,
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
  md5('participant:' || d.session_id::text || ':' || d.user_id::text)::uuid AS participant_id,
  d.kind::text AS kind,
  md5('participant:' || d.session_id::text || ':' || d.about_user_id::text)::uuid AS about_participant_id,
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
  md5('participant:' || n.session_id::text || ':' || n.user_id::text)::uuid AS participant_id,
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
  md5('participant:' || s.session_id::text || ':' || s.user_id::text)::uuid AS participant_id,
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
  md5('participant:' || d.session_id::text || ':' || d.user_id::text)::uuid AS participant_id,
  d.need_id,
  d.status::text AS status,
  d.is_current,
  -- work-k5fk.9 (Q9): the column is dropped (it had no writer); the concept keeps it, always NULL
  NULL::text AS note
FROM need_disposition d;


-- proposal — spec §1.4.
CREATE VIEW old_concept_proposal AS
SELECT
  p.id,
  p.session_id,
  md5('participant:' || p.session_id::text || ':' || p.created_by_user_id::text)::uuid AS created_by_participant_id,
  p.source::text AS source,
  p.kind::text AS kind,
  p.status::text AS status,
  p.description,
  p.duration,
  p.measure_of_success,
  p.unresolved_need_labels,
  p.removed_at AT TIME ZONE 'UTC' AS removed_at,
  md5('participant:' || p.session_id::text || ':' || p.removed_by_user_id::text)::uuid AS removed_by_participant_id,
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
  md5('participant:' || c.session_id::text || ':' || c.user_id::text)::uuid AS participant_id,
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
SELECT ap.agreement_id, md5('participant:' || ap.session_id::text || ':' || ap.user_id::text)::uuid AS participant_id, ap.agreed_at AT TIME ZONE 'UTC' AS agreed_at
FROM agreement_party ap;


-- consent — spec §1.3. target_kind is the generated column.
CREATE VIEW old_concept_consent AS
SELECT
  c.id,
  md5('participant:' || c.session_id::text || ':' || c.user_id::text)::uuid AS participant_id,
  md5('participant:' || c.session_id::text || ':' || c.requested_by_user_id::text)::uuid AS requested_by_participant_id,
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
  md5('participant:' || i.session_id::text || ':' || i.invited_by_user_id::text)::uuid AS invited_by_participant_id,
  i.accepted_by_user_id,
  i.invitee_name AS name,
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
  md5('participant:' || r.session_id::text || ':' || r.user_id::text)::uuid AS participant_id,
  r.last_viewed_at AT TIME ZONE 'UTC' AS last_viewed_at,
  (substr(md5('message:' || r.last_seen_conversation_id::text), 1, 20) || lpad(to_hex(r.last_seen_seq), 12, '0'))::uuid
    AS last_seen_message_id,
  r.last_viewed_share_tab_at AT TIME ZONE 'UTC' AS last_viewed_share_tab_at,
  r.last_active_at AT TIME ZONE 'UTC' AS last_active_at,
  -- the old concept's archivedAt: never written, and its target column dropped (review schema S8)
  NULL::timestamp AS archived_at,
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
  md5('participant:' || c.session_id::text || ':' || c.closed_by_user_id::text)::uuid AS closed_by_participant_id,
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
  md5('participant:' || b.session_id::text || ':' || b.participant_user_id::text)::uuid AS participant_id,
  b.turn_id,
  b.activity_type::text AS activity_type,
  b.call_type::text AS call_type,
  b.model,
  b.input,
  b.output,
  b.metadata,
  -- work-k5fk.9 (J1): the column is dropped (no writer ever set it); the concept keeps it, always NULL
  NULL::jsonb AS structured_output,
  b.token_count_input,
  b.token_count_output,
  b.duration_ms,
  b.cost,
  b.status::text AS status,
  b.created_at   AT TIME ZONE 'UTC' AS created_at,
  b.completed_at AT TIME ZONE 'UTC' AS completed_at
FROM brain_activity b;
