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
