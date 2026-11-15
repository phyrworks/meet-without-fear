/**
 * work-k5fk.3, step 6a (design note §3, §7 row 6a): every child of
 * `participant` carries `session_id` and the user id of each participant it
 * names, pinned by composite foreign keys; participant.id and the old FKs
 * stay. No baseline is re-recorded (R39: the current-shape baselines are the
 * oracle, and the runner refuses a re-record on the target) and NO rule is
 * added: 6a moves nothing any baseline compares. This module exists for the
 * README's "every accepted change needs a written reason", one paragraph per
 * baseline, and is the place a 6a rule would go if one were ever needed (a
 * moved baseline on this branch is a bug, not an allowance).
 *
 * Why nothing moves, in every baseline alike:
 *   - concept snapshots read the `old_concept_*` views (concept-views/
 *     target-shape.sql), which project named columns in the old vocabulary;
 *     none projects a 6a column, so an added or changed row has the same
 *     concept image with or without its session_id / *_user_id;
 *   - byte-level row `changes` are compared through changesMapped, whose
 *     values are the concept comparison's (README, TS-10), so the physical
 *     columns are not compared either;
 *   - the writers that now read the seat in the INSERT (message-store insert,
 *     the draft upsert, upsertChoice, reachMilestone, the reconciler and share
 *     offer writers) read only `participant`, `conversation` and
 *     `empathy_attempt`, which are already in the trace's image
 *     (TARGET_RELATION_MAP, TARGET_ADDED_RELATIONS): no new relation;
 *   - no HTTP body carries a 6a column: the API never returned participant
 *     ids (design note §0; verified on this branch, see the hand-back), and
 *     the user ids it returns came from the same participant rows before.
 *
 * Measured: the full golden suite (21 tests over 11 baselines) passed on the
 * 6a schema with the fixture templates rebuilt; the only failures were the two
 * scenarios that seed rows by raw SQL (tombstone, choices-hidden-until-shared),
 * whose seeds had to name the new NOT NULL columns — a test fix, not a
 * baseline change.
 */

/** One paragraph per baseline: what its recorded steps write through a 6a-changed writer, and why it holds. */
export const PARTICIPANT_KEY_6A_BASELINES: Record<string, string> = {
  'session-read':
    'Reads only (GET session, state, messages); its one change per step is the bypass rewriting the user identity. ' +
    'No step writes a child of participant, so 6a cannot move a row; the participant / conversation reads it traces ' +
    'are unchanged statements.',
  'empathy-reveal':
    "Bob's draft, consent and attempt, four messages and the reveal: every one is now written with its seat " +
    '(draft upsert, submitAttempt + consent, message-store insert, empathy_set_status), which the concept views do ' +
    'not project. The reveal still writes one EMPATHY_STATEMENT into the subject conversation; its sender is the ' +
    'same participant, now also its sender_user_id.',
  'reflection-never-crosses':
    "A read-state stamp and two chat messages; the messages' seat is read from the conversation and the sender in " +
    'the INSERT. The privacy probes (no reflection text reaches Bob) are about content and audience, which 6a does ' +
    'not touch.',
  'unrevealed-attempt-hidden':
    'Nine messages, four attempt moves, a share offer and a reconciler result change: the moves are UPDATEs of ' +
    'status columns (no seat column changes); the inserts carry their seats. What the subject may read is decided ' +
    'by the same participant rows as before.',
  'reveal-all-ready-ada-first':
    'The R3 reveal in Ada-first order: a draft, a consent, an attempt, two attempt moves and five messages, each ' +
    'written with its seat. The delivered copies are still one per subject conversation (the reveal-checks pin it).',
  'reveal-all-ready-bob-first':
    'The R3 reveal in Bob-first order from RECONCILER_SHOWN_B: three attempt moves, a share offer change and three ' +
    'messages; as ada-first, nothing the concept views project moves.',
  'needs-hidden-until-shared':
    'Four consents, three messages and four milestones: consent and participant_milestone rows now carry ' +
    '(session_id, user_id) from the deciding / reaching participant. need_share is written by app.need_share, which ' +
    "copies the need's session and user (the need's owner, by key); the probes on labels and evidence are unchanged.",
  'choices-hidden-until-shared':
    "Two proposal_choice rows (upsertChoice, now reading the chooser's seat in the INSERT) and the choices_shared " +
    "milestone. The scenario's own post-golden check seeds two needs and a consent by SQL; those seeds name the new " +
    'columns (test change only).',
  tombstone:
    "The account walk: only the user row changes in the recorded steps. The leaver's private rows the scenario " +
    'seeds before the deletion (so every absence rule has a row to find gone) name the new NOT NULL columns; the ' +
    'walk deletes them by participant id as before, and the composite FKs cascade with the old ones.',
  'author-sees-status-only':
    "A read-state stamp, the author's feedback draft and two messages, written with their seats; the author's " +
    'reads are the R6 subject, and none of them returns a 6a column.',
  'declined-offer-no-trace':
    "The subject's decline: a share offer UPDATE and an attempt status move (no seat column changes) and the " +
    "decline's consent (written with the subject's seat). The author's reads are unchanged but for the direction's " +
    'status, as recorded.',
};

/**
 * work-k5fk.3, step 6b (design note §7 row 6b): participant's key is
 * (session_id, user_id); participant.id, every *_participant_id column and
 * the id foreign keys are gone, and participant.kind is the user's kind
 * pinned by FOREIGN KEY (user_id, kind) REFERENCES "user" (id, kind). Again
 * no baseline is re-recorded and NO rule is added.
 *
 * Why nothing moves, in every baseline alike:
 *   - the `old_concept_*` views keep the old vocabulary's participant ids by
 *     deriving each as md5('participant:' || session_id || ':' || user_id),
 *     the formula current-shape.sql already uses for its participant rows, so
 *     a concept row, its order and its `<participant:…>` label are what they
 *     were; the concept comparison and changesMapped see the same values;
 *   - byte-level labels (normalize.ts labelTargetRows) take a row's owner from
 *     its user column rather than through participant.id: the same
 *     `<user:…>` owner label as before;
 *   - the writers name a seat by (session_id, user_id) in the INSERT instead
 *     of a participant id: the relations they touch are the ones already in
 *     the trace image (participant, conversation, empathy_attempt,
 *     v_co_participant), so no new relation;
 *   - no HTTP body changes: the API never returned a participant id (verified
 *     again on this branch: 0 hits in mobile/; the one shared/ hit was a
 *     stored payload key, now sourceUserId).
 *
 * Measured: the golden suite passed on the 6b schema with the 16 templates
 * rebuilt (manifests equal to 6a's but for ids and builtAt); the test-side
 * edits were the scenarios' own SQL (joins through p.id, seeds naming
 * participant ids), which now name the user column.
 */

/** One paragraph per baseline: what 6b changes under its recorded steps, and why it holds. */
export const PARTICIPANT_KEY_6B_BASELINES: Record<string, string> = {
  'session-read':
    'Reads only. Membership is the (session_id, user_id) participant row found by key instead of by id; the ' +
    'participant and v_co_participant reads it traces are the same relations, and no DTO carried a participant id.',
  'empathy-reveal':
    "Bob's draft, consent, attempt, messages and the reveal are written with (session_id, user columns) only; the " +
    "concept views mint the same participant ids from those columns, so every row's concept image is unchanged. " +
    'empathy_set_status takes the direction by (session, author, subject).',
  'reflection-never-crosses':
    'Two chat messages and a read-state stamp, keyed by sender_user_id / user_id; the audience probes read the ' +
    'user columns directly (test SQL), and the reflection never reaches Bob exactly as before.',
  'unrevealed-attempt-hidden':
    'Attempt moves are UPDATEs of status columns; the reconciler result and share offer name their subject by ' +
    'subject_user_id under the session key. What the subject may read is decided by the same participant rows.',
  'reveal-all-ready-ada-first':
    'As empathy-reveal, in Ada-first order: one delivered copy per subject conversation (reveal-checks, now reading ' +
    'the user columns).',
  'reveal-all-ready-bob-first': 'As ada-first in Bob-first order: no column the concept views project changes value.',
  'needs-hidden-until-shared':
    'Consents, messages and milestones keyed by (session_id, user_id); app.need_share copies the need owner by key. ' +
    "The scenario's needIdsOf and unread probe read the user column directly (test SQL); labels and evidence " +
    'probes unchanged.',
  'choices-hidden-until-shared':
    "proposal_choice's key is (proposal_id, session_id, user_id); upsertChoice conflicts on it. The selection " +
    "probes filter by the chooser's seat, and the closure probe's need/consent seeds name Bob's seat (test SQL).",
  tombstone:
    'The account walk calls app.anonymize_user_in_session(session, user) per seat and deletes the leaver rows by ' +
    '(session_id, user_id): the same rows the old participant-id walk found; the GLOBAL_FACTS ai_memory row (no ' +
    'session) is keyed by user alone. Seeds and walk rules name the user column (test SQL); the recorded user-row ' +
    'change is unchanged.',
  'author-sees-status-only':
    "The author's draft, read-state stamp and messages, written by seat; v_empathy_direction_status exposes " +
    'author_user_id / subject_user_id, which no recorded body returns.',
  'declined-offer-no-trace':
    "The decline's offer UPDATE, attempt move and consent, as in 6a; the scenario's cleanup joins the attempt's " +
    'author_user_id directly (test SQL).',
};
