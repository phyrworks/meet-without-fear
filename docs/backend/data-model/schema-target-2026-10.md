---
title: "Target Schema — October 2026"
sidebar_position: 7
description: The approved target shape for every cluster, at the level an implementer needs to write schema.prisma and the migration SQL — tables, columns, constraints, RLS sketches, views, Prisma mapping, blast radius, invariants.
created: 2026-10-17
status: living
---

# Target Schema — October 2026

Companion to [`schema-review-2026-10.md`](./schema-review-2026-10.md) (the review and the owner
decisions D1–D4 of 2026-10-13 in its §9) and [`schema-migration-plan-2026-10.md`](./schema-migration-plan-2026-10.md)
(how to get there). Security predicates re-base [`phase3-design-summary.md`](./phase3-design-summary.md)
§2–§6; where a predicate is unchanged in spirit it is marked **(P3 §2)**.

## Assumptions, 2026-10-17

The review's Q3–Q7 are still open. The target is designed under these; each can be vetoed on its own.

| # | Assumption | Cheap to reverse? |
|---|---|---|
| A-Q3 | **One live (non-terminal) session per relationship**, enforced by `UNIQUE (relationship_id) WHERE status NOT IN ('RESOLVED','ABANDONED','ARCHIVED')` on `session` | **yes** — drop the partial index |
| A-Q4 | **Wellbeing features demoted to documents**: meditation, gratitude, needs assessment and people tracking each become one `feature_state(user_id, feature, doc jsonb, updated_at)` row per feature per user (the owner's own suggestion). The 19-row need taxonomy moves to a shared constant in code. `mood_reading` and `regulation_event` stay as session tables because they are part of the journey, not a satellite | **yes** — a feature is promoted back to tables by a migration that unpacks its document; nothing else references the documents |
| A-Q5 | **Empathy attempts are immutable per round**: one row per submission, `round` increments, reveal and review reference a specific row | **no** — reverting to in-place overwrite loses the history the product spec requires ("a later private edit must not silently change what the partner was shown") |
| A-Q6 | **Pre-session chat is dropped** (`PreSessionMessage` is never populated today) | **yes** — a `conversation` with `session_id NULL` and a `participant` whose session is `CREATED` can be added later; D1's status-gated cardinality already allows a one-participant session |
| A-Q7 | **snake_case identifiers now**, with Prisma `@map`/`@@map` on every field and model | **yes** (mechanical), but do it now: every policy, trigger, CHECK and view is hand-written SQL and would otherwise quote `"PascalCase"` forever |
| A-P1/P2 | Parked questions stay parked: the shape supports all-N or pairwise reveal (`v_session_readiness` vs per-attempt status) and gives a modeled participant a `conversation` row like any other; whether a human may read it is a policy, not a column | — |

## Conventions (apply to every table; not repeated below)

| Rule | Detail |
|---|---|
| Ids | `id uuid PRIMARY KEY DEFAULT uuidv7()`. Junctions use composite PKs |
| Timestamps | all `timestamptz`; `created_at timestamptz NOT NULL DEFAULT now()` on every table; `updated_at timestamptz NOT NULL DEFAULT now()` on tables updated in place, maintained by one `BEFORE UPDATE` trigger `app.touch_updated_at()`; append-only tables have no `updated_at` and `mwf_app` holds no `UPDATE` grant on them |
| Names | snake_case tables and columns; enums `snake_case` types; Prisma models PascalCase via `@@map`, fields camelCase via `@map` |
| FK delete rules | → `user`: **RESTRICT, always** (soft delete, P3 D9). → `session`: CASCADE (retention hard-deletes whole sessions). → `participant`: CASCADE (a participant row is removed only with its session; a leaver's row survives, pointing at the tombstone). → `conversation`, `reflection`, `empathy_attempt`, `follow_up`: CASCADE. → `consent`: RESTRICT (a consent record outlives nothing that depends on it). → `proposal`: RESTRICT from `agreement`, CASCADE from its own children. → `milestone`: RESTRICT |
| Every FK | has a supporting index unless it is the leading column of the PK or of a listed unique |
| `jsonb` | every column carries `CHECK (jsonb_typeof(col) = 'object')` (or `'array'`); documents with a known contract add key-presence checks listed per table |
| Visibility classes | **P** private-to-participant · **S** shared-vessel (all participants of the session) · **U** user-private (outside any session) · **G** global/reference · **T** telemetry |
| Encryption keys (P3 D5, §8.6) | **user** key (`user_key`) for U-class content; **session** key (`session_key`) for S-class; **participant** key (`participant_key`, the review's refinement of "conversation_key") for P-class; **none** for G/T. The column lists below name the encrypted columns; everything else is plaintext |
| RLS shorthand | `me` = `app.current_user_id()` (NULL when unset ⇒ zero rows, fail-closed). `mine(p)` = `EXISTS (SELECT 1 FROM participant p WHERE p.id = <col> AND p.user_id = me)`. `member(s)` = `EXISTS (SELECT 1 FROM participant p WHERE p.session_id = <col> AND p.user_id = me)`. `job` = `current_user IN ('mwf_job','mwf_migrator')`. Four policies per table, `TO mwf_app`, never `ALL` (P3 §2). Columns a read policy trusts are pinned by the write policy and are not in the column `UPDATE` grant (P3 §4) |

---

## 1. Tables by cluster

### 1.1 Core / session (16)

#### `relationship`
Durable pairing of users across sessions. · core · S · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. No cardinality rule (D1). FKs: none. Indexes: none.
RLS: S `EXISTS (relationship_member m WHERE m.relationship_id = id AND m.user_id = me)` (P3 §2 bespoke) · I `job` (created by the invitation path) · U none · D none.
Absorbs: `Relationship`.

#### `relationship_member`
A user's membership in a relationship (not in a session). · core · S · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| relationship_id | uuid | no | | FK relationship CASCADE |
| user_id | uuid | no | | FK user RESTRICT |
| role | relationship_role | no | 'member' | `member \| owner` |
| nickname | text | yes | | what this member calls the other(s) |
| joined_at | timestamptz | no | now() | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK (relationship_id, user_id). Index (user_id) — "my relationships". CHECK via enum.
RLS: S `user_id = me OR EXISTS (relationship_member m2 WHERE m2.relationship_id = relationship_id AND m2.user_id = me)` · I `job` · U `user_id = me` (nickname only, column grant) · D none.
Absorbs: `RelationshipMember` (drops surrogate `id`; `role` text → enum).

#### `session`
One facilitated process on one topic between the participants. · core · S · session (topic_frame)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| relationship_id | uuid | no | | FK relationship CASCADE |
| status | session_status | no | 'CREATED' | `CREATED, INVITED, ACTIVE, RESOLVED, ABANDONED, ARCHIVED` |
| topic_frame | text | yes | | 3–5 word neutral topic (encrypted) |
| topic_frame_confirmed_at | timestamptz | yes | | |
| previous_session_id | uuid | yes | | FK session SET NULL — lineage from a NEW_PROCESS follow-up |
| resolved_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. **Partial unique (A-Q3)** `UNIQUE (relationship_id) WHERE status NOT IN ('RESOLVED','ABANDONED','ARCHIVED')`. CHECK `(status = 'RESOLVED') = (resolved_at IS NOT NULL)`. Indexes: (relationship_id), (previous_session_id). Trigger **T-cardinality-1**: `BEFORE UPDATE OF status` refuses `→ ACTIVE` unless `≥2 participant` rows exist with `≥1 kind='human'` (D1).
RLS: S `member(id)` (P3 §2 shape E) · I `job`/invitation path · U `member(id)` for `status`, `topic_frame*` only; status transitions through `app.session_set_status()` · D `job` (retention).
Absorbs: `Session` minus `type` (dropped; `INNER_WORK` never written), minus `WAITING`/`PAUSED` (per-participant states → milestones), minus `SharedVessel` (1:1 container with no columns — its children now key on `session_id`).

#### `participant`
One membership of a session: the first-class entity (D1). · core · S (existence) / P (its content) · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| session_id | uuid | no | | FK session CASCADE |
| user_id | uuid | yes | | FK user RESTRICT; NULL for a modeled participant |
| kind | participant_kind | no | 'human' | `human \| modeled` |
| display_name | text | yes | | snapshot of the name shown to co-participants; the only `user` fact a co-participant may see (P3 §2 `partner_display_name`) |
| joined_at | timestamptz | no | now() | |
| left_at | timestamptz | yes | | set when the user leaves/deletes; row stays |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (session_id, user_id) — a user is one participant per session. CHECK `(kind = 'modeled') = (user_id IS NULL)`. Indexes: (user_id) — "my sessions". Trigger **T-cardinality-2**: `DEFERRABLE INITIALLY DEFERRED` constraint trigger on DELETE / UPDATE OF kind, user_id refusing to leave a non-terminal session with no human participant (D1).
RLS: S `user_id = me OR member(session_id)` (co-participants see each other's row: id, kind, display_name, joined_at — column grant hides nothing else because there is nothing else) · I `job` (invitation accept / session create) · U `user_id = me` (display_name only) · D none.
Absorbs: new. Seeded from `StageProgress(sessionId,userId)` ∪ `UserVessel(sessionId,userId)` ∪ `RelationshipMember × Session`; `display_name` from `User.name`/`RelationshipMember.nickname`.

#### `conversation`
A participant's private thread with their AI guide inside a session; also a Stage-4 sub-chat. · core · P · participant
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | no | | FK participant CASCADE |
| kind | conversation_kind | no | 'MAIN' | `MAIN \| SUBCHAT` |
| anchor_kind | subchat_anchor | yes | | `NEEDS_BRAINSTORM \| PROPOSAL_REFINEMENT \| NO_OVERLAP` (SUBCHAT only) |
| anchor_proposal_id | uuid | yes | | FK proposal SET NULL (SUBCHAT only) |
| status | conversation_status | no | 'ACTIVE' | `ACTIVE \| RESOLVED` |
| resolved_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. **Partial unique** `UNIQUE (participant_id) WHERE kind = 'MAIN'` — exactly one main thread per participant. CHECK `(kind = 'MAIN') = (anchor_kind IS NULL)`. Indexes: (participant_id, kind, status) — sub-chat lookup; (anchor_proposal_id).
RLS: S `mine(participant_id)` · I `mine(participant_id)` (pins participant_id) · U `mine(participant_id)` (status, resolved_at) · D none.
Absorbs: `UserVessel` (identity and `archivedAt` → `conversation_read_state`), `Stage4SubChat`.

#### `conversation_read_state`
Hot per-participant view state. · core · P · none (timestamps and an id only)
| column | type | null | default | meaning |
|---|---|---|---|---|
| participant_id | uuid | no | | PK, FK participant CASCADE |
| last_viewed_at | timestamptz | yes | | chat tab |
| last_seen_message_id | uuid | yes | | FK message SET NULL — "new messages" line |
| last_viewed_share_tab_at | timestamptz | yes | | |
| last_active_at | timestamptz | yes | | presence (subject to privacy prefs) |
| archived_at | timestamptz | yes | | hidden from this participant's list |
| updated_at | timestamptz | no | now() | |

Keys: PK (participant_id). Index (last_seen_message_id).
RLS: S `mine(participant_id)`; `last_active_at` is read for the partner through `v_participant` only when `user_preferences.doc->'privacy'->>'showActivityStatus'` allows — a view, not a policy · I/U `mine(participant_id)` · D none.
Absorbs: `UserVessel.{lastViewedAt, lastSeenChatItemId, lastViewedShareTabAt, lastActiveAt, archivedAt}`.

#### `message`
One line of a conversation: human, AI, system, or a delivered cross-participant item. · core · P · participant
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| conversation_id | uuid | no | | FK conversation CASCADE — the audience |
| sender_participant_id | uuid | yes | | FK participant CASCADE; NULL for AI/SYSTEM |
| role | message_role | no | | `USER \| AI \| SYSTEM` |
| kind | message_kind | no | 'CHAT' | `CHAT, EMPATHY_STATEMENT, EMPATHY_REVEAL_INTRO, SHARED_CONTEXT, VALIDATION_FEEDBACK, SHARE_SUGGESTION, EMPATHY_VALIDATION_PROMPT` |
| content | text | no | | encrypted |
| content_hash | varchar(64) | yes | | SHA-256 of plaintext (dedupe probes) |
| refining_need_id | uuid | yes | | FK need SET NULL |
| source_attempt_id | uuid | yes | | FK empathy_attempt SET NULL — which attempt a delivered statement/feedback came from (lineage) |
| created_at | timestamptz | no | now() | |

Keys: PK. CHECK `role <> 'USER' OR sender_participant_id IS NOT NULL`; CHECK `role NOT IN ('AI','SYSTEM') OR sender_participant_id IS NULL` (P3 §6, "humans can't author as the facilitator"). Indexes: (conversation_id, created_at) — the chat list; (conversation_id, kind, content_hash) — dedupe probes; (sender_participant_id); (refining_need_id); (source_attempt_id). Append-only: no `updated_at`; trigger **T-message-immutable** `BEFORE UPDATE` refuses changes to `conversation_id, sender_participant_id, role, kind`, and to `content` when role ∈ (AI, SYSTEM) (P3 §4).
RLS: S `EXISTS (conversation c JOIN participant p ON p.id = c.participant_id WHERE c.id = conversation_id AND p.user_id = me) OR mine(sender_participant_id)` (P3 §2 bespoke `Message`, re-based) · I same, with `sender_participant_id` pinned to me for role USER; AI/SYSTEM rows inserted by `mwf_job` · U none for `mwf_app` · D none.
Absorbs: `Message` (`sessionId`+`forUserId` → `conversation_id`; `senderId` → participant; `role` split; `stage` dropped — derivable from `participant_milestone`; `extractedNeeds/Emotions` dropped), `Stage4SubChatMessage`. **Not** `InnerWorkMessage` (→ `reflection_message`).

#### `draft`
A participant's working text for a sharing point, before any consent. · core · P · participant
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | no | | FK participant CASCADE |
| kind | draft_kind | no | | `EMPATHY \| VALIDATION_FEEDBACK \| SHARE_CONTEXT` |
| content | text | no | | encrypted |
| ready_to_share | boolean | no | false | |
| version | int | no | 1 | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (participant_id, kind). 
RLS: S/I/U `mine(participant_id)` · D `mine(participant_id)`.
Absorbs: `EmpathyDraft`, `ValidationFeedbackDraft`, `ReconcilerShareOffer.refinedContent` (the subject's edit of a share suggestion).

#### `milestone`
Lookup of journey milestones; the only place "stage" exists, as data. · core · G · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| key | text | no | | PK, e.g. `compact_signed`, `invitation_sent`, `feel_heard`, `empathy_submitted`, `empathy_ready`, `empathy_validated`, `needs_confirmed`, `needs_shared`, `choices_shared`, `closed` |
| ordinal | int | no | | order along the journey |
| stage_label | text | no | | UI label of the stage this milestone belongs to ("Your Story", …) |
| scope | milestone_scope | no | 'participant' | `participant \| session` — whether all participants must reach it for the session to advance |
| created_at | timestamptz | no | now() | |

Keys: PK (key). UNIQUE (ordinal). Seeded by migration from today's gate keys; renumbering is an `UPDATE`.
RLS: no RLS (reference table); `GRANT SELECT` to `mwf_app` (P3 §1.1 pattern, like `Need`).
Absorbs: the key set of `StageProgress.gatesSatisfied` and the `stage` integers (D3).

#### `participant_milestone`
Event: a participant reached a milestone at a time. · core · S (progress is visible to co-participants per the visibility table) · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| participant_id | uuid | no | | FK participant CASCADE |
| milestone_key | text | no | | FK milestone RESTRICT |
| reached_at | timestamptz | no | now() | |
| detail | jsonb | yes | | small payload where the gate carried one (e.g. `finalEmotionalReading`), `CHECK jsonb_typeof = 'object'` |

Keys: PK (participant_id, milestone_key). Index (milestone_key, reached_at) — readiness scans. Append-only (no `updated_at`; un-reaching a milestone is a `DELETE` by `mwf_job` only — "withdraw selections" path).
RLS: S `mine(participant_id) OR EXISTS (participant p2 JOIN participant p1 ON p1.session_id = p2.session_id WHERE p1.id = participant_id AND p2.user_id = me)` · I `mine(participant_id)` for participant-scoped keys; session-scoped keys (`empathy_ready`, `closed`) by `mwf_job` (P3 D6) · U none · D `job`.
Absorbs: `StageProgress` rows + the boolean/timestamp pairs in `gatesSatisfied` (`compactSigned/signedAt`, `feelHeardConfirmed/At`, `needsConfirmed`, `needsShared`, `selectionSubmitted`, `empathyExchanged`, `empathyValidated`, `invitationSent`, …); `Session.status WAITING/PAUSED`.

#### `ai_memory`
AI working memory: rolling summary, notable facts, consolidated global facts. · core · P (participant scope) / U (user scope) · participant / user
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | yes | | FK participant CASCADE |
| user_id | uuid | yes | | FK user RESTRICT |
| kind | ai_memory_kind | no | | `SUMMARY \| NOTABLE_FACTS \| GLOBAL_FACTS` |
| doc | jsonb | no | | encrypted; `CHECK jsonb_typeof = 'object'`; `SUMMARY` requires keys `text, messageCount, generatedAt`; `*_FACTS` requires `facts` array |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. CHECK `num_nonnulls(participant_id, user_id) = 1`; CHECK `(kind = 'GLOBAL_FACTS') = (user_id IS NOT NULL)`. UNIQUE (participant_id, kind) WHERE participant_id IS NOT NULL; UNIQUE (user_id, kind) WHERE user_id IS NOT NULL.
RLS: S/I/U `mine(participant_id) OR user_id = me`; in practice written by `mwf_job` (background classifiers) · D `job`.
Absorbs: `UserVessel.conversationSummary` (text JSON → jsonb), `UserVessel.notableFacts`, `User.globalFacts` (comment says array, code writes object — the object shape wins), `InnerWorkSession.conversationSummary` moves to `reflection.summary_doc` instead (never mixed).

#### `mood_reading`
Barometer reading (1–10) by a participant. · core · P · none (integer + short context, encrypted context)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | no | | FK participant CASCADE |
| intensity | intensity | no | | domain `int CHECK 1..10` |
| context | text | yes | | encrypted |
| recorded_at | timestamptz | no | now() | |

Keys: PK. Index (participant_id, recorded_at) — time series. Append-only.
RLS: S/I `mine(participant_id)` · U/D none.
Absorbs: `EmotionalReading` (drops `stage`); `User.lastMoodIntensity` becomes `v_participant.last_mood` (latest reading across the user's participants).

#### `regulation_event`
A completed emotional-regulation exercise. · core · P · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | no | | FK participant CASCADE |
| type | regulation_type | no | | `BREATHING_EXERCISE \| BODY_SCAN \| GROUNDING \| PAUSE_SESSION` |
| intensity_before, intensity_after | intensity | yes | | |
| completed_at | timestamptz | no | now() | |

Keys: PK. Index (participant_id, completed_at). Append-only.
RLS: S/I `mine(participant_id)` · U/D none.
Absorbs: `EmotionalExerciseCompletion`.

#### `invitation`
An invitation to join a session. · core · S · session (name)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| session_id | uuid | no | | FK session CASCADE |
| invited_by_participant_id | uuid | no | | FK participant CASCADE |
| accepted_by_user_id | uuid | yes | | FK user RESTRICT (P3 §6 new column) |
| name | text | yes | | invitee display name (encrypted) |
| status | invitation_status | no | 'PENDING' | `PENDING \| ACCEPTED \| DECLINED \| EXPIRED` |
| message_confirmed_at | timestamptz | yes | | |
| expires_at | timestamptz | no | | |
| accepted_at, declined_at | timestamptz | yes | | |
| decline_reason | text | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. CHECK `status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)` (P3 §6). Indexes: (session_id), (status, expires_at) — expiry sweep, (accepted_by_user_id).
RLS: S `mine(invited_by_participant_id) OR accepted_by_user_id = me OR member(session_id)` (P3 §2 bespoke `Invitation`) · I `mine(invited_by_participant_id)` · U inviter (message_confirmed) or `mwf_job` (accept/decline/expire) · D none.
Absorbs: `Invitation` (`messageConfirmed` boolean folded into the timestamp; `invitedById` → participant).

#### `session_key`, `participant_key`
Envelope keys (P3 D5). · core · — · (they *are* keys)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| session_id / participant_id | uuid | no | | FK CASCADE; UNIQUE WHERE destroyed_at IS NULL |
| key_id | text | no | | KMS key id |
| wrapped_dek | bytea | no | | |
| created_at | timestamptz | no | now() | |
| destroyed_at | timestamptz | yes | | the crypto-shred |

RLS: S `member(session_id)` / `mine(participant_id)`; I once by the creating path; U none for `mwf_app` (`destroyed_at` is `mwf_job`'s) (P3 cat §1.2). Absorbs: new. `user_key` is in §1.7.

### 1.2 Empathy and reconciler (5)

#### `empathy_attempt`
A submitted statement by `author` about `subject`, immutable per round (A-Q5). · empathy · P until revealed, then S between author and subject · participant (author) until revealed; session key after reveal (re-wrapped by the reveal job — see migration plan)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| author_participant_id | uuid | no | | FK participant CASCADE |
| subject_participant_id | uuid | no | | FK participant CASCADE |
| round | int | no | 1 | increments per resubmission in the same direction |
| supersedes_attempt_id | uuid | yes | | FK empathy_attempt SET NULL — the previous round |
| content | text | no | | encrypted; never updated |
| consent_id | uuid | yes | | FK consent RESTRICT — the submission consent (arc on `consent`) |
| status | empathy_status | no | 'HELD' | `HELD, AWAITING_SHARING, REFINING, READY, REVEALED, VALIDATED, SUPERSEDED` (legacy `ANALYZING`, `NEEDS_WORK` dropped) |
| status_version | int | no | 0 | event ordering |
| submitted_at | timestamptz | no | now() | |
| revealed_at | timestamptz | yes | | |
| delivery_status | delivery_status | no | 'PENDING' | `PENDING \| DELIVERED \| SEEN` |
| delivered_at, seen_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (author_participant_id, subject_participant_id, round). **Partial unique** `UNIQUE (author_participant_id, subject_participant_id) WHERE status NOT IN ('SUPERSEDED','VALIDATED')` — one live attempt per direction. CHECK `author_participant_id <> subject_participant_id` (D1; replaces P3's `guesserId <> subjectId`). Trigger **T-same-session**: author and subject belong to the same session. Indexes: (subject_participant_id, status) — "what is revealed to me"; (supersedes_attempt_id); (consent_id).
RLS: S `mine(author_participant_id) OR (mine(subject_participant_id) AND status IN ('REVEALED','VALIDATED'))` (P3 §2 bespoke `EmpathyAttempt`, now narrower than "any member") · I `mine(author_participant_id)` pinned · U **none for `mwf_app`**; `status` moves only through `app.empathy_set_status(id, status)` (P3 §5) and `delivery_status`/`seen_at` through `mwf_job` · D none.
Absorbs: `EmpathyAttempt` (`sourceUserId` → author; subject made explicit; `draftId` dropped — the draft is transient; `revisionCount` → rows), `RefinementAttemptCounter` (count of rounds).

#### `empathy_review`
The subject's verdict on a revealed attempt. · empathy · S between the two · session
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| attempt_id | uuid | no | | FK empathy_attempt CASCADE |
| reviewer_participant_id | uuid | no | | FK participant CASCADE (= the attempt's subject; trigger-checked) |
| validated | boolean | no | | |
| feedback | text | yes | | encrypted |
| feedback_sent_at | timestamptz | yes | | explicit send (visibility table: "delivered after explicit send") |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (attempt_id, reviewer_participant_id). Index (reviewer_participant_id).
RLS: S `mine(reviewer_participant_id) OR (feedback_sent_at IS NOT NULL AND EXISTS (empathy_attempt a WHERE a.id = attempt_id AND mine(a.author_participant_id)))` · I/U `mine(reviewer_participant_id)` · D none.
Absorbs: `EmpathyValidation` (`feedbackShared` → timestamp).

#### `reconciler_result`
Gap analysis for one attempt; immutable; one current per attempt. · empathy · P to the **subject** only (P3 D8a) · participant (subject)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| attempt_id | uuid | no | | FK empathy_attempt CASCADE |
| subject_participant_id | uuid | no | | FK participant CASCADE (denormalised for the policy; trigger-checked = attempt.subject) |
| iteration | int | no | 1 | |
| alignment_score | int | no | | CHECK 0..100 |
| alignment_summary, gap_summary | text | no | | encrypted |
| gap_severity | gap_severity | no | | `NONE \| MINOR \| MODERATE \| SIGNIFICANT` (was lowercase free text) |
| correctly_identified, missed_feelings, misattributions | text[] | no | '{}' | LLM output, encrypted-as-json if the map requires |
| most_important_gap | text | yes | | |
| recommended_action | recommender_action | no | | `PROCEED \| OFFER_OPTIONAL \| OFFER_SHARING` |
| rationale | text | no | | |
| sharing_would_help | boolean | no | | |
| suggested_share_focus, suggested_share_content, suggested_share_reason | text | yes | | the subject's private suggestion |
| circuit_breaker_tripped | boolean | no | false | (kept; was never read — read it in `v_empathy_direction` or drop at implementation) |
| superseded_at | timestamptz | yes | | |
| created_at | timestamptz | no | now() | |

Keys: PK. **Partial unique** `UNIQUE (attempt_id) WHERE superseded_at IS NULL`. UNIQUE (attempt_id, iteration). Index (subject_participant_id). Append-only except `superseded_at` (`mwf_job`).
RLS: S `mine(subject_participant_id)` **only** (P3 §2) · I/U `job` · D none.
Absorbs: `ReconcilerResult` minus `guesserName/subjectName`, minus the three guidance columns.

#### `reconciler_guidance`
The abstract hints the **author** may see (P3 D8a split). · empathy · P to author (and subject) · participant (author)
| column | type | null | default | meaning |
|---|---|---|---|---|
| result_id | uuid | no | | PK, FK reconciler_result CASCADE |
| author_participant_id, subject_participant_id | uuid | no | | FK participant CASCADE (policy columns) |
| area_hint, guidance_type, prompt_seed | text | yes | | no partner content by construction |
| created_at | timestamptz | no | now() | |

RLS: S `mine(author_participant_id) OR mine(subject_participant_id)` (P3 §2) · I `job` · U/D none.
Absorbs: `ReconcilerResult.{areaHint, guidanceType, promptSeed}`.

#### `context_share_offer`
The suggestion to the subject to share context, and what happened to it. · empathy · P to subject; the shared text is delivered as a `message` to the author · participant (subject)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| attempt_id | uuid | no | | FK empathy_attempt CASCADE |
| result_id | uuid | no | | FK reconciler_result CASCADE |
| subject_participant_id | uuid | no | | FK participant CASCADE |
| iteration | int | no | 1 | |
| status | share_offer_status | no | 'PENDING' | `PENDING \| OFFERED \| ACCEPTED \| DECLINED \| EXPIRED` (legacy `NOT_OFFERED`, `SKIPPED` dropped) |
| offer_message, suggested_content, suggested_reason | text | yes | | encrypted |
| shared_content | text | yes | | the exact approved text (encrypted); also copied into the author's `message` (kind SHARED_CONTEXT) at delivery |
| shared_at, declined_at, offered_at | timestamptz | yes | | |
| delivery_status | delivery_status | no | 'PENDING' | |
| delivered_at, seen_at | timestamptz | yes | | |
| delivery_notified_at, seen_notified_at | timestamptz | yes | | **written** by the notification path (review F4.2 fix) |
| consent_id | uuid | yes | | FK consent RESTRICT — the share decision |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (attempt_id, iteration). CHECK `(status = 'ACCEPTED') = (shared_at IS NOT NULL)`; `(status = 'DECLINED') = (declined_at IS NOT NULL)`. Indexes: (subject_participant_id, status) — pending-actions badge; (result_id).
RLS: S `mine(subject_participant_id)` · I `job` · U `mine(subject_participant_id)` for the response columns (status via function), `mwf_job` for delivery/notification columns · D none.
Absorbs: `ReconcilerShareOffer` minus `skippedAt`, `refinementChatUsed`; `refinedContent` → `draft(kind SHARE_CONTEXT)`.

### 1.3 Consent (1)

#### `consent`
One explicit decision by a participant to let something cross a boundary. · consent · S between the two parties · session
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | no | | FK participant CASCADE — who decides |
| requested_by_participant_id | uuid | yes | | FK participant CASCADE — NULL when self-initiated |
| need_id | uuid | yes | | FK need CASCADE |
| empathy_attempt_id | uuid | yes | | FK empathy_attempt CASCADE |
| proposal_id | uuid | yes | | FK proposal CASCADE |
| share_offer_id | uuid | yes | | FK context_share_offer CASCADE |
| review_id | uuid | yes | | FK empathy_review CASCADE (feedback send) |
| target_kind | consent_target | no | *generated* | `GENERATED ALWAYS AS (CASE WHEN need_id IS NOT NULL THEN 'NEED' … END) STORED` |
| decision | consent_decision | yes | | `GRANTED \| DENIED \| REVOKED` |
| decided_at, revoked_at | timestamptz | yes | | |
| created_at | timestamptz | no | now() | |

Keys: PK. **Exclusive arc** `CHECK (num_nonnulls(need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id) = 1)`. CHECK `(decision IS NULL) = (decided_at IS NULL)` (P3 §6); `revoked_at IS NULL OR decision = 'REVOKED'`. Indexes: one per arc column; (participant_id, decided_at).
RLS: S `mine(participant_id) OR mine(requested_by_participant_id)` (P3 §2 bespoke `ConsentRecord`) · I `mine(participant_id)` · U `mine(participant_id)` (decision columns only; `decision` may only move `NULL→GRANTED|DENIED`, `GRANTED→REVOKED` — trigger **T-consent-transitions**) · D none (RESTRICT from every dependant).
Absorbs: `ConsentRecord` (polymorphic `targetType/targetId` → arc; `metadata` dropped — never written), `ConsentedContent.{consentActive, revokedAt}` (the content itself → `need`).

### 1.4 Needs, proposals, agreements, closure (9)

#### `need`
A need identified for a participant; private until shared. · needs · P, then S once `shared_at` set and not revoked · participant until shared; the shared text under session key
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | no | | FK participant CASCADE |
| label | text | no | | from the universal needs taxonomy (encrypted) |
| category | need_category | no | | `SAFETY, CONNECTION, AUTONOMY, RECOGNITION, MEANING, FAIRNESS` |
| evidence | text[] | no | '{}' | quotes (encrypted) |
| ai_confidence | real | no | | CHECK 0..1 |
| confirmed_at | timestamptz | yes | | user confirmed |
| locked_at | timestamptz | yes | | |
| superseded_by_need_id | uuid | yes | | FK need SET NULL |
| shared_text | text | yes | | "heat removed" version shown to co-participants (encrypted, session key) |
| shared_at | timestamptz | yes | | |
| revoked_at | timestamptz | yes | | |
| consent_id | uuid | yes | | FK consent RESTRICT |
| deleted_at | timestamptz | yes | | soft-delete inside the UI |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. CHECK `(shared_at IS NULL) = (shared_text IS NULL)`; `revoked_at IS NULL OR shared_at IS NOT NULL`; `revoked_at >= shared_at`. Indexes: (participant_id) WHERE deleted_at IS NULL; (superseded_by_need_id); (consent_id). Trigger **T-need-share-terminal**: `shared_text`/`shared_at` immutable once set; `revoked_at` may only go NULL→value (P3 §4 `ConsentedContent` trigger, re-homed).
RLS: S `mine(participant_id) OR (shared_at IS NOT NULL AND revoked_at IS NULL AND EXISTS (participant p1 JOIN participant p2 ON p2.session_id = p1.session_id WHERE p1.id = participant_id AND p2.user_id = me))` — co-participants see **only** the row when shared; `label`, `evidence`, `ai_confidence` are excluded from the co-participant arm by a column grant to a `need_shared` **view** (`id, participant_id, shared_text, category, shared_at`) that `mwf_app` reads for partner needs; the base-table SELECT policy is owner-only (P3 §2 `ConsentedContent`, re-based) · I/U `mine(participant_id)` · D none.
Absorbs: `IdentifiedNeed` + `ConsentedContent` (1:1 via `originalNeedId @unique`).

#### `need_disposition`
How a participant dispositions a need during repair (own or co-participant's). · needs · P · none (enum + note; note encrypted)
| column | type | null | default | meaning |
|---|---|---|---|---|
| participant_id | uuid | no | | FK participant CASCADE — whose walkthrough |
| need_id | uuid | no | | FK need CASCADE |
| status | need_disposition_status | no | 'OPEN' | `OPEN \| COVERED \| PARTIAL \| SKIPPED \| DECLINED` |
| is_current | boolean | no | false | the need the walkthrough is on |
| note | text | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK (participant_id, need_id). **Partial unique** `UNIQUE (participant_id) WHERE is_current` — one current need per walkthrough. Index (need_id).
RLS: S/I/U `mine(participant_id)` · D `mine(participant_id)`.
Absorbs: `gatesSatisfied.{currentNeedId, coveredNeedIds, skippedNeedIds, phase}`, `Stage4NeedCoverage` (its `coverageStatus` where user-set; computed coverage is `v_need_coverage`), `Stage4NeedDeclination`. The walkthrough `phase` becomes a `participant_milestone` key.

#### `proposal`
A repair idea for one or more needs. · proposals · S (shared proposals) / P (individual commitments until shared) · session
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| session_id | uuid | no | | FK session CASCADE |
| created_by_participant_id | uuid | yes | | FK participant CASCADE; NULL for AI |
| source | proposal_source | no | 'USER_SUBMITTED' | `USER_SUBMITTED \| AI_SUGGESTED \| CURATED` |
| kind | proposal_kind | no | 'SHARED_PROPOSAL' | `SHARED_PROPOSAL \| INDIVIDUAL_COMMITMENT` |
| status | proposal_status | no | 'ACTIVE' | `ACTIVE \| REVISED \| REMOVED \| CONVERTED_TO_AGREEMENT` |
| description | text | no | | encrypted |
| duration, measure_of_success | text | yes | | |
| unresolved_need_labels | text[] | no | '{}' | labels from `needsAddressed[]` the migration could not match to a `need` (kept as text; see plan §3) |
| captured_from_message_id | uuid | yes | | FK message SET NULL |
| removed_at | timestamptz | yes | | |
| removed_by_participant_id | uuid | yes | | FK participant CASCADE |
| removal_reason | text | yes | | |
| consent_id | uuid | yes | | FK consent RESTRICT (sharing an individual commitment) |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. CHECK `(status = 'REMOVED') = (removed_at IS NOT NULL)`. Indexes: (session_id, status); (created_by_participant_id); (captured_from_message_id).
RLS: S `member(session_id) AND (kind = 'SHARED_PROPOSAL' OR mine(created_by_participant_id) OR consent_id IS NOT NULL)` · I `member(session_id)` with `created_by_participant_id` pinned · U creator (description, duration, measure) or `mwf_job` (status) · D none.
Absorbs: `StrategyProposal` minus `needsAddressed[]` (→ `proposal_need`), `parentProposalId`, `coverageSummary` (never written).

#### `proposal_need`
Which needs a proposal addresses. · proposals · S · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| proposal_id | uuid | no | | FK proposal CASCADE |
| need_id | uuid | no | | FK need CASCADE |
| created_at | timestamptz | no | now() | |

Keys: PK (proposal_id, need_id). Index (need_id).
RLS: S via parent proposal (hop) · I creator of the proposal · U none · D creator.
Absorbs: `StrategyProposalNeed` + resolvable entries of `StrategyProposal.needsAddressed[]`.

#### `proposal_choice`
A participant's willingness on a proposal. · proposals · P until `choices_shared` milestone, then S · participant
| column | type | null | default | meaning |
|---|---|---|---|---|
| proposal_id | uuid | no | | FK proposal CASCADE |
| participant_id | uuid | no | | FK participant CASCADE |
| decision | choice_decision | no | | `WILLING \| NOT_WILLING` |
| note | text | yes | | encrypted |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK (proposal_id, participant_id). Index (participant_id).
RLS: S `mine(participant_id) OR (co-participant AND EXISTS participant_milestone(participant_id, 'choices_shared'))` — the visibility-table rule "partner choices stay hidden until both share selections" as a predicate · I/U/D `mine(participant_id)` (withdraw-before-closure = DELETE).
Absorbs: `Stage4ProposalSelection`, `Agreement.agreedByA/agreedByB` (as evidence), `StrategyRanking` is **not** absorbed (dropped, A-Q4-adjacent: ranking is not in the product flow).

#### `proposal_revision`
Append-only audit of proposal changes. · proposals · S · session
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| proposal_id | uuid | no | | FK proposal CASCADE |
| actor_participant_id | uuid | yes | | FK participant CASCADE; NULL = AI/system |
| action | revision_action | no | | `CREATED, REVISED, REMOVED, RESTORED, CONVERTED, CAPTURE_SKIPPED, COVERED, SUBCHAT_REFINED` |
| before, after | jsonb | yes | | `CHECK jsonb_typeof = 'object'` |
| reason | text | yes | | |
| message_id | uuid | yes | | FK message SET NULL |
| created_at | timestamptz | no | now() | |

Keys: PK. Index (proposal_id, created_at). Append-only.
RLS: S via proposal (hop) · I `member` (actor pinned) or `job` · U/D none.
Absorbs: `Stage4ProposalRevision` (`sessionId` dropped — via proposal; `action` normalised).

#### `agreement`
A proposal all willing parties have accepted (D4). · agreements · S · session
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| session_id | uuid | no | | FK session CASCADE |
| proposal_id | uuid | no | | FK proposal RESTRICT |
| type | agreement_type | no | | `MICRO_EXPERIMENT \| COMMITMENT \| CHECK_IN \| HYBRID` |
| status | agreement_status | no | 'AGREED' | `AGREED \| IN_PROGRESS \| COMPLETED \| ABANDONED` (`PROPOSED` dropped — a proposal is a proposal) |
| description | text | no | | snapshot at conversion (encrypted) |
| duration, measure_of_success | text | yes | | |
| follow_up_at | timestamptz | yes | | |
| completed_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (proposal_id) — one agreement per proposal. Index (session_id, status). Trigger **T-agreement-parties**: on INSERT, every `participant` of the session with `kind='human'` that the agreement names must have a `proposal_choice = WILLING` on the proposal (the "all parties willing" rule, D4).
RLS: S `member(session_id)` · I `job` (the mutual-willingness path, P3 D6) · U `job` (status) · D none.
Absorbs: `Agreement` minus `agreedByA/B/agreedAt` (→ `agreement_party`), minus `sharedVesselId`.

#### `agreement_party`
Who is party to an agreement. · agreements · S · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| agreement_id | uuid | no | | FK agreement CASCADE |
| participant_id | uuid | no | | FK participant CASCADE |
| agreed_at | timestamptz | no | now() | |

Keys: PK (agreement_id, participant_id). Index (participant_id).
RLS: S via agreement (hop) · I `job` · U/D none.
Absorbs: `Agreement.agreedByA/agreedByB/agreedAt`, `CommonGround.confirmedByA/B` (table dropped).

#### `session_closure`
How the repair stage ended. · closure · S · session
| column | type | null | default | meaning |
|---|---|---|---|---|
| session_id | uuid | no | | PK, FK session CASCADE |
| kind | closure_kind | no | | `SHARED_AGREEMENT \| NO_SHARED_AGREEMENT` |
| reason | closure_reason | no | | `MUTUAL_SELECTION \| NO_OVERLAP \| BOUNDARY_HONORED \| USER_STOPPED` |
| summary | text | no | | encrypted |
| closed_by_participant_id | uuid | yes | | FK participant CASCADE; NULL = auto-closure |
| check_in_at | timestamptz | yes | | |
| closed_at | timestamptz | no | now() | |
| created_at | timestamptz | no | now() | |

Keys: PK (session_id). Append-only. The three id arrays are `v_session_closure_items`.
RLS: S `member(session_id)` · I `job` · U/D none.
Absorbs: `Stage4Closure` minus `sharedAgreementIds`, `individualProposalIds`, `openNeedIds`.

### 1.5 Follow-up (was Tending) (4)

#### `follow_up`
A scheduled or user-initiated check-in on an agreement or individual commitment. · follow_up · S (shared scope) / P (individual) · session
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| session_id | uuid | no | | FK session CASCADE |
| agreement_id | uuid | yes | | FK agreement CASCADE |
| proposal_id | uuid | yes | | FK proposal CASCADE — individual commitment without an agreement |
| type | follow_up_type | no | | `SCHEDULED_SHARED_AGREEMENT \| SCHEDULED_INDIVIDUAL_COMMITMENT \| USER_INITIATED_REENTRY` |
| scope | follow_up_scope | no | 'SHARED' | `SHARED \| INDIVIDUAL` |
| owner_participant_id | uuid | yes | | FK participant CASCADE (INDIVIDUAL) |
| opted_in_shared | boolean | no | false | |
| status | follow_up_status | no | 'SCHEDULED' | `SCHEDULED, OPEN, PARTIAL, COMPLETED, EXPIRED, CANCELLED` |
| scheduled_for | timestamptz | yes | | |
| response_deadline_at | timestamptz | yes | | replaces the coordination cycle's deadline |
| opened_at, completed_at | timestamptz | yes | | |
| summary | text | yes | | encrypted |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. CHECK `(scope = 'INDIVIDUAL') = (owner_participant_id IS NOT NULL)`; `num_nonnulls(agreement_id, proposal_id) <= 1`. Indexes: (scheduled_for) WHERE status = 'SCHEDULED' — the open-due job; (session_id, status); (agreement_id); (owner_participant_id).
RLS: S `member(session_id) AND (scope = 'SHARED' OR mine(owner_participant_id) OR opted_in_shared)` · I `member` / `job` (scheduler) · U owner or `job` (status) · D none.
Absorbs: `TendingEntry`; `TendingCoordinationCycle` (→ `response_deadline_at` + `v_follow_up_cycle`).

#### `follow_up_checkin`
One participant's check-in submission, with its structured answers as a document. · follow_up · P, parts shared by scope · participant
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| follow_up_id | uuid | no | | FK follow_up CASCADE |
| participant_id | uuid | no | | FK participant CASCADE |
| next_action | next_action | yes | | `FULL_CLOSURE, EXTEND, ADJUST_COMMITMENT, REOPEN_STRATEGY_WORK, NEW_PROCESS, PARTIAL_CLOSURE` |
| continue_choice | continue_choice | yes | | `ANOTHER_ROUND, EXTEND, NEW_PROCESS, PARTIAL_CLOSURE, FULL_CLOSURE` |
| reflection_summary | text | yes | | encrypted |
| payload | jsonb | no | '{}' | encrypted; `CHECK jsonb_typeof = 'object'`; contract `FollowUpCheckinPayload` in `shared/` — keys `entryOutcomes[]`, `needOutcomes[]`, `adjustments[]`, `partialClosures[]`, `responses[]`; validated by zod on write |
| submitted_at | timestamptz | no | now() | |
| created_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (follow_up_id, participant_id). Index (participant_id, submitted_at). Append-only.
RLS: S `mine(participant_id) OR (follow_up is SHARED scope AND member)` · I `mine(participant_id)` · U/D none.
Absorbs: `TendingCheckin`, `TendingResponse`, `TendingEntryOutcome`, `TendingNeedOutcome`, `TendingAdjustment`, `TendingResponsePartialClosure` (the five become arrays in `payload`; their enums become zod unions in `shared/`).

#### `follow_up_note`
A private between-period note, optionally carried into a check-in. · follow_up · P, S after consent · participant
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| participant_id | uuid | no | | FK participant CASCADE |
| content | text | no | | encrypted |
| carry_forward | boolean | no | false | |
| shared_at | timestamptz | yes | | explicit share |
| selected_for_checkin_id | uuid | yes | | FK follow_up_checkin SET NULL |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. Indexes: (participant_id, created_at); (selected_for_checkin_id).
RLS: S `mine(participant_id) OR (shared_at IS NOT NULL AND co-participant)` · I/U `mine(participant_id)` · D `mine(participant_id)`.
Absorbs: `TendingBetweenPeriodNote` (`consentToShareWithPartner/shareConsentAt` → `shared_at`).

#### `reminder`
A scheduled nudge for one user. · follow_up · U (delivery is personal) · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| user_id | uuid | no | | FK user RESTRICT |
| follow_up_id | uuid | yes | | FK follow_up CASCADE |
| scope | reminder_scope | no | 'PRIVATE' | `PRIVATE \| SHARED` |
| remind_at | timestamptz | no | | |
| cadence | text | yes | | |
| note | text | yes | | |
| status | reminder_status | no | 'SCHEDULED' | `SCHEDULED \| DELIVERED \| CANCELLED` |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. Indexes: (remind_at) WHERE status = 'SCHEDULED' — the delivery job; (user_id, remind_at); (follow_up_id).
RLS: S/I/U/D `user_id = me` (P3 shape A); `status → DELIVERED` by `mwf_job`.
Absorbs: `TendingReminder`.

### 1.6 Reflection — Inner Work (4)

Structurally outside the session boundary (D2): nothing in §1.1–1.5 or §1.3 may FK these tables; CI assertion over `pg_constraint`.

#### `reflection`
A private self-reflection thread. · reflection · U · user
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| user_id | uuid | no | | FK user RESTRICT |
| title | text | yes | | encrypted |
| theme | text | yes | | detected theme tag |
| status | reflection_status | no | 'ACTIVE' | `ACTIVE \| COMPLETED \| ARCHIVED` |
| summary | text | yes | | encrypted |
| summary_doc | jsonb | yes | | rolling summary (was JSON-in-text); encrypted; `CHECK jsonb_typeof = 'object'` |
| linked_session_id | uuid | yes | | FK session SET NULL — **context only**; grants no visibility either way |
| linked_at | timestamptz | yes | | when the link was made (replaces `linkedAtStage`) |
| context_snapshot | text | yes | | point-in-time partner-session context (encrypted) |
| distilled_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. Indexes: (user_id, updated_at) — list; (linked_session_id); (user_id, theme) — `v_reflection_theme`.
RLS: S/I/U/D `user_id = me` (P3 shape A). No session-side policy ever reaches it.
Absorbs: `InnerWorkSession` minus `linkedAtStage`, `linkedTrigger` (stale), `contentEmbedding` (D8), `linkedAtMessageId` (→ `reflection_message.branch_of_message_id` is **not** carried: it pointed at an inner-work message, keep as `linked_at` only).

#### `reflection_message`
· reflection · U · user
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| reflection_id | uuid | no | | FK reflection CASCADE |
| role | message_role | no | | `USER \| AI \| SYSTEM` |
| content | text | no | | encrypted |
| created_at | timestamptz | no | now() | |

Keys: PK. Index (reflection_id, created_at). Append-only. CHECK `role NOT IN ('AI','SYSTEM') OR true` — no sender column here; author is the reflection's user by construction.
RLS: S/I via `reflection.user_id = me` (shape D) · U/D none.
Absorbs: `InnerWorkMessage`.

#### `takeaway`
Distilled insight/action/intention from a reflection. · reflection · U · user
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| reflection_id | uuid | no | | FK reflection CASCADE |
| content | text | no | | encrypted |
| theme | text | yes | | |
| source | takeaway_source | no | 'AI' | `AI \| USER` |
| type | takeaway_type | no | 'INSIGHT' | `INSIGHT \| ACTION_ITEM \| INTENTION` |
| position | int | no | 0 | |
| resolved_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. Index (reflection_id, position). RLS: via reflection (shape D).
Absorbs: `SessionTakeaway` minus `embedding` (D8: encrypted vector blob in the app, or dropped until the knowledge-base search is rebuilt — plan §5).

#### `takeaway_link`
· reflection · U · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| source_id, target_id | uuid | no | | FK takeaway CASCADE |
| link_type | takeaway_link_type | no | | `AI_SEMANTIC \| USER_MANUAL` |
| similarity | real | yes | | |
| created_at | timestamptz | no | now() | |

Keys: PK (source_id, target_id). CHECK `source_id <> target_id`. Index (target_id). RLS: via source takeaway (shape D2).
Absorbs: `TakeawayLink`.

### 1.7 User, preferences, feature state (6)

#### `user`
Identity only. · user · U · none (identity is plaintext; `email`/`clerk_id` are lookup keys)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| clerk_id | text | yes | | UNIQUE |
| email | text | no | | UNIQUE |
| first_name, last_name | text | yes | | |
| name | text | yes | *generated* | `GENERATED ALWAYS AS (nullif(trim(coalesce(first_name,'') \|\| ' ' \|\| coalesce(last_name,'')), '')) STORED` |
| deleted_at | timestamptz | yes | | the tombstone (P3 D9) |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK; UNIQUE (clerk_id), (email). CHECK `deleted_at IS NULL OR (clerk_id IS NULL AND email LIKE 'deleted+%')` — a tombstone is scrubbed.
RLS: S `id = me`; co-participant display name comes from `participant.display_name`, never from this table (P3 §2 bespoke `User`) · I `mwf_auth` only (P3 §5) · U `id = me` (names) · D none.
Absorbs: `User` identity columns. Drops `pushToken`, `biometric*` (→ `user_device`), the four jsonb (→ `user_preferences`, `ai_memory`), `lastMoodIntensity` (→ view).

#### `user_device`
A registered device: push token, biometric enrolment. · user · U · none
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| user_id | uuid | no | | FK user RESTRICT |
| push_token | text | yes | | |
| platform | device_platform | yes | | `ios \| android \| web` |
| biometric_enabled | boolean | no | false | |
| biometric_enrolled_at | timestamptz | yes | | |
| last_seen_at | timestamptz | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. UNIQUE (push_token) WHERE push_token IS NOT NULL. Index (user_id).
RLS: `user_id = me` for all four (shape A). Tombstone scrub deletes rows.
Absorbs: `User.{pushToken, biometricEnabled, biometricEnrolledAt}` (one row per user at migration; multi-device later).

#### `user_preferences`
The three preference documents, one row per user. · user · U · none (settings, not content)
| column | type | null | default | meaning |
|---|---|---|---|---|
| user_id | uuid | no | | PK, FK user RESTRICT |
| doc | jsonb | no | '{}' | `CHECK jsonb_typeof = 'object' AND doc ?& array['memory','notifications','privacy']`; shapes are `MemoryPreferencesDTO`, `NotificationPreferencesDTO`, `PrivacyPreferencesDTO` (`shared/src/dto/auth.ts`) |
| updated_at | timestamptz | no | now() | |

RLS: `user_id = me`. Absorbs: `User.{memoryPreferences, notificationPreferences, privacyPreferences}`.

#### `user_memory`
"Things to always remember" — user-approved standing instructions. · user · U (optionally session-scoped) · user
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| user_id | uuid | no | | FK user RESTRICT |
| session_id | uuid | yes | | FK session CASCADE; NULL = global |
| content | text | no | | encrypted |
| category | memory_category | no | | `AI_NAME, LANGUAGE, COMMUNICATION, PERSONAL_INFO, RELATIONSHIP, PREFERENCE` |
| status | memory_status | no | 'ACTIVE' | `ACTIVE \| PENDING \| REJECTED` |
| source | memory_source | no | 'USER_APPROVED' | |
| suggested_text | text | yes | | AI's original if edited |
| created_at, updated_at | timestamptz | no | now() | |

Keys: PK. Indexes: (user_id, status); (session_id). RLS: `user_id = me`. Absorbs: `UserMemory`.

#### `feature_state`
One document per wellbeing feature per user (A-Q4). · user · U · user
| column | type | null | default | meaning |
|---|---|---|---|---|
| user_id | uuid | no | | FK user RESTRICT |
| feature | text | no | | CHECK `feature IN ('meditation','gratitude','needs_assessment','people')` |
| doc | jsonb | no | '{}' | encrypted; `CHECK jsonb_typeof = 'object'`; one zod contract per feature in `shared/src/dto/feature-state.ts` (meditation: `sessions[], scripts[], preferences, stats`; gratitude: `entries[], preferences`; needs_assessment: `scores[], state`; people: `persons[]` with `mentions[]`) |
| updated_at | timestamptz | no | now() | |

Keys: PK (user_id, feature). No other index (never filtered inside the document by SQL — that is the criterion). RLS: `user_id = me`.
Absorbs: `MeditationSession`, `MeditationStats`, `MeditationFavorite`, `MeditationPreferences`, `SavedMeditation`, `GratitudeEntry`, `GratitudePreferences`, `NeedScore`, `NeedsAssessmentState`, `Person`, `PersonMention`; the `Need` taxonomy → `shared/src/constants/needs.ts`. `Insight`, `RecurringTheme`, `GlobalLibraryItem`: dropped (never populated / derivable).

#### `user_key`
Per-user envelope key (P3 §8.6). Same columns as `session_key` with `user_id` FK user RESTRICT; `UNIQUE (user_id) WHERE destroyed_at IS NULL`. RLS: `user_id = me` SELECT, INSERT once; `destroyed_at` by `mwf_job` (the shred at account deletion).

### 1.8 Telemetry (1)

#### `brain_activity`
LLM/embedding call log. · telemetry · T · none (short retention instead — P3 §7; `input`/`output` to be added to the field map under the session key where `session_id` is set, else purged within days)
| column | type | null | default | meaning |
|---|---|---|---|---|
| id | uuid | no | uuidv7() | |
| session_id | uuid | yes | | FK session CASCADE |
| reflection_id | uuid | yes | | FK reflection CASCADE — the one permitted FK *into* the reflection cluster, telemetry-only, no `mwf_app` grant |
| participant_id | uuid | yes | | FK participant CASCADE — whose turn (new; enables per-participant prompt audit) |
| turn_id | text | yes | | correlation |
| activity_type | activity_type | no | | `LLM_CALL \| EMBEDDING \| RETRIEVAL \| TOOL_USE` |
| call_type | brain_call_type | yes | | 19 members, unchanged |
| model | text | no | | |
| input, output, metadata, structured_output | jsonb | yes | | `CHECK jsonb_typeof IN ('object','array')` |
| token_count_input, token_count_output, duration_ms | int | no | 0 | |
| cost | numeric(10,6) | no | 0 | |
| status | activity_status | no | 'PENDING' | |
| created_at, completed_at | timestamptz | — | | |

Keys: PK. Indexes: (session_id), (reflection_id), (turn_id), (created_at) — retention sweep.
RLS: enabled, **no policies, all `mwf_app` grants revoked** (P3 §1.1); `mwf_job` writes, `mwf_ops` reads.
Absorbs: `BrainActivity` (`innerWorkSessionId` → `reflection_id`).

---

## 2. ERDs per cluster

### 2.1 Core / session
```mermaid
erDiagram
    user ||--o{ relationship_member : "RESTRICT"
    relationship ||--o{ relationship_member : ""
    relationship ||--o{ session : "partial unique: one live session"
    session |o--o{ session : "previous_session_id"
    session ||--|{ participant : "human | modeled"
    user |o--o{ participant : "NULL for modeled"
    session ||--o{ invitation : ""
    participant ||--o{ invitation : "invited_by"
    participant ||--|| conversation : "MAIN (exactly one)"
    participant ||--o{ conversation : "SUBCHAT (0..n)"
    conversation ||--o{ message : ""
    participant |o--o{ message : "sender (NULL = AI/SYSTEM)"
    participant ||--o| conversation_read_state : ""
    participant ||--o{ draft : "EMPATHY | VALIDATION_FEEDBACK | SHARE_CONTEXT"
    milestone ||--o{ participant_milestone : "lookup"
    participant ||--o{ participant_milestone : ""
    participant ||--o{ ai_memory : "SUMMARY | NOTABLE_FACTS"
    user ||--o{ ai_memory : "GLOBAL_FACTS"
    participant ||--o{ mood_reading : ""
    participant ||--o{ regulation_event : ""
    session ||--o| session_key : ""
    participant ||--o| participant_key : ""
```

### 2.2 Empathy and reconciler
```mermaid
erDiagram
    participant ||--o{ empathy_attempt : "author"
    participant ||--o{ empathy_attempt : "subject (CHECK <> author)"
    empathy_attempt |o--o| empathy_attempt : "supersedes (round n-1)"
    empathy_attempt ||--o{ reconciler_result : "one current (partial unique)"
    reconciler_result ||--o| reconciler_guidance : "author-visible hints"
    empathy_attempt ||--o{ context_share_offer : "to subject"
    reconciler_result ||--o{ context_share_offer : ""
    empathy_attempt ||--o| empathy_review : "by subject"
    message }o--o| empathy_attempt : "source_attempt_id (delivered statement / feedback)"
```

### 2.3 Consent
```mermaid
erDiagram
    participant ||--o{ consent : "participant_id (decider)"
    participant |o--o{ consent : "requested_by"
    consent |o--|| need : "arc"
    consent |o--|| empathy_attempt : "arc"
    consent |o--|| proposal : "arc"
    consent |o--|| context_share_offer : "arc"
    consent |o--|| empathy_review : "arc (feedback send)"
```

### 2.4 Needs, proposals, agreements, closure
```mermaid
erDiagram
    participant ||--o{ need : "private until shared_at"
    need |o--o{ need : "superseded_by"
    participant ||--o{ need_disposition : ""
    need ||--o{ need_disposition : ""
    session ||--o{ proposal : ""
    participant |o--o{ proposal : "created_by (NULL = AI)"
    proposal ||--o{ proposal_need : ""
    need ||--o{ proposal_need : ""
    proposal ||--o{ proposal_choice : ""
    participant ||--o{ proposal_choice : "WILLING | NOT_WILLING"
    proposal ||--o{ proposal_revision : "append-only"
    proposal ||--o| agreement : "RESTRICT; one per proposal"
    agreement ||--|{ agreement_party : ""
    participant ||--o{ agreement_party : ""
    session ||--o| session_closure : ""
```

### 2.5 Follow-up
```mermaid
erDiagram
    session ||--o{ follow_up : ""
    agreement |o--o{ follow_up : ""
    proposal |o--o{ follow_up : "individual commitment"
    participant |o--o{ follow_up : "owner (INDIVIDUAL)"
    follow_up ||--o{ follow_up_checkin : "payload jsonb"
    participant ||--o{ follow_up_checkin : ""
    participant ||--o{ follow_up_note : ""
    follow_up_checkin |o--o{ follow_up_note : "selected_for"
    user ||--o{ reminder : ""
    follow_up |o--o{ reminder : ""
```

### 2.6 Reflection (Inner Work)
```mermaid
erDiagram
    user ||--o{ reflection : "user-owned"
    session |o--o{ reflection : "linked_session_id: context only"
    reflection ||--o{ reflection_message : ""
    reflection ||--o{ takeaway : ""
    takeaway ||--o{ takeaway_link : "source"
    takeaway ||--o{ takeaway_link : "target"
    reflection |o--o{ brain_activity : "telemetry only"
```

### 2.7 User, preferences, feature state
```mermaid
erDiagram
    user ||--o{ user_device : ""
    user ||--o| user_preferences : "memory | notifications | privacy"
    user ||--o{ user_memory : ""
    session |o--o{ user_memory : "optional scope"
    user ||--o{ feature_state : "meditation | gratitude | needs_assessment | people"
    user ||--o| user_key : ""
```

### 2.8 Telemetry
```mermaid
erDiagram
    session |o--o{ brain_activity : ""
    participant |o--o{ brain_activity : ""
    reflection |o--o{ brain_activity : ""
```

---

## 3. Enums and lookups

| Enum (Postgres type) | Members | From |
|---|---|---|
| `session_status` | CREATED, INVITED, ACTIVE, RESOLVED, ABANDONED, ARCHIVED | `SessionStatus` minus WAITING, PAUSED |
| `participant_kind` | human, modeled | new |
| `conversation_kind` / `conversation_status` / `subchat_anchor` | MAIN, SUBCHAT / ACTIVE, RESOLVED / NEEDS_BRAINSTORM, PROPOSAL_REFINEMENT, NO_OVERLAP | `Stage4SubChat*` |
| `message_role` | USER, AI, SYSTEM | `MessageRole` split |
| `message_kind` | CHAT, EMPATHY_STATEMENT, EMPATHY_REVEAL_INTRO, SHARED_CONTEXT, VALIDATION_FEEDBACK, SHARE_SUGGESTION, EMPATHY_VALIDATION_PROMPT | `MessageRole` split |
| `draft_kind` | EMPATHY, VALIDATION_FEEDBACK, SHARE_CONTEXT | new |
| `milestone_scope` | participant, session | new |
| `ai_memory_kind` | SUMMARY, NOTABLE_FACTS, GLOBAL_FACTS | new |
| `regulation_type` | BREATHING_EXERCISE, BODY_SCAN, GROUNDING, PAUSE_SESSION | `ExerciseType` |
| `invitation_status` | PENDING, ACCEPTED, DECLINED, EXPIRED | unchanged |
| `relationship_role` | member, owner | was free text |
| `empathy_status` | HELD, AWAITING_SHARING, REFINING, READY, REVEALED, VALIDATED, SUPERSEDED | minus ANALYZING, NEEDS_WORK (never set) |
| `delivery_status` | PENDING, DELIVERED, SEEN | unchanged |
| `share_offer_status` | PENDING, OFFERED, ACCEPTED, DECLINED, EXPIRED | minus NOT_OFFERED, SKIPPED |
| `gap_severity` | NONE, MINOR, MODERATE, SIGNIFICANT | was lowercase text |
| `recommender_action` | PROCEED, OFFER_OPTIONAL, OFFER_SHARING | was text |
| `consent_target` (generated) / `consent_decision` | NEED, EMPATHY_ATTEMPT, PROPOSAL, SHARE_OFFER, REVIEW / GRANTED, DENIED, REVOKED | `ConsentContentType` (7 → 5 real targets) |
| `need_category` | SAFETY, CONNECTION, AUTONOMY, RECOGNITION, MEANING, FAIRNESS | unchanged |
| `need_disposition_status` | OPEN, COVERED, PARTIAL, SKIPPED, DECLINED | `coverageStatus` text + declination |
| `proposal_source` / `proposal_kind` / `proposal_status` / `choice_decision` / `revision_action` | as today; `revision_action` normalised to upper snake (8 members) | `Strategy*`, `Stage4*` |
| `agreement_type` / `agreement_status` | as today / minus PROPOSED | |
| `closure_kind` / `closure_reason` | unchanged | `Stage4Closure*` |
| `follow_up_type` / `follow_up_scope` / `follow_up_status` / `next_action` / `continue_choice` / `reminder_scope` / `reminder_status` | as the `Tending*` enums, renamed; `reminder_status` adds CANCELLED (was text) | |
| `reflection_status` / `takeaway_source` / `takeaway_type` / `takeaway_link_type` | unchanged | `InnerWork*`, `Takeaway*` |
| `memory_category` / `memory_status` / `memory_source` | unchanged | |
| `device_platform` | ios, android, web | new |
| `activity_type` / `activity_status` / `brain_call_type` | unchanged | |
| **Domain** `intensity` | `int CHECK (VALUE BETWEEN 1 AND 10)` | new |

**Become lookup tables:** `milestone` (the stage vocabulary, D3). **Become zod unions inside documents, not DB types:** `TendingFollowThroughStatus`, `TendingHelpfulnessStatus`, `TendingBlockerCategory`, `TendingNeedResolutionStatus`, `PartialClosureResolution` (inside `follow_up_checkin.payload`); `MeditationType`, `FavoriteType`, `NeedsCategory`, `MentionSourceType`, `InsightType`, `GlobalLibrarySource`, `TakeawayLinkType`-style enums of dropped tables (inside `feature_state.doc` or gone). **Dropped:** `SessionType`, `StageStatus`, `Attribution`, `MemoryCategory` is kept. Enum members are declared in the migration in the order listed; the five sort-order drifts (census §7) disappear with the rebuild.

---

## 4. Views and functions

All plain views, `security_invoker = true` (PG15+) so RLS of the underlying tables applies; `mwf_app` has SELECT.

| View | Defined as (in words) | Replaces |
|---|---|---|
| `v_participant` | `participant` ⋈ `user` (tombstone-aware name fallback to `display_name`) ⋈ `conversation` (MAIN) ⋈ `conversation_read_state`, plus `last_mood` = latest `mood_reading.intensity` for that participant and `last_active_at` masked to NULL unless the owner's `privacy.showActivityStatus` | 40 partner-lookup sites, `getUserSlot`, `User.lastMoodIntensity` |
| `v_co_participant` | for each participant, every *other* participant of the same session (id, kind, display_name) — one row per pair, N-safe | `app.partner_user_id()` callers (the function stays for `mwf_job`) |
| `v_session_readiness` | for each (session, session-scoped milestone key): `all_reached` = no human participant lacks the milestone; `waiting_on` = array of participant ids lacking it | every "both ready" check; reveal gate (P3 D6 path reads this) |
| `v_current_stage` | per participant: the max-`ordinal` milestone reached, its `stage_label`, and the next milestone key | `StageProgress` readers, `gatesSatisfied` decoding, `utils/stage-resolver.ts` |
| `v_empathy_direction` | per (author, subject): current attempt (partial-unique row), its round, status, current `reconciler_result`, open `context_share_offer`, `empathy_review` | reconciler `findFirst` chains, `RefinementAttemptCounter` |
| `v_need_shared` | `need` rows with `shared_at IS NOT NULL AND revoked_at IS NULL`, columns `id, participant_id, session_id, category, shared_text, shared_at` only | the co-participant arm of `need` (the only object `mwf_app` may read partner needs through) |
| `v_need_coverage` | per (session, need): covering proposals = `proposal_need` ⋈ `proposal` (ACTIVE) and whether each human participant is WILLING on at least one; `status` = COVERED/PARTIAL/OPEN by that rule | `Stage4NeedCoverage` computed rows |
| `v_session_closure_items` | per session: agreements (ids), individual commitments (proposals of kind INDIVIDUAL with a WILLING choice by their creator), open needs (`need_disposition` OPEN or no covering proposal) | the three `Stage4Closure` arrays |
| `v_follow_up_cycle` | per follow-up: human participants, who has a check-in, `waiting_on`, `status` ∈ WAITING_FOR_PARTNER / READY_TO_RESOLVE / RESOLVED / TIMED_OUT by `response_deadline_at` | `TendingCoordinationCycle` |
| `v_conversation_unread` | per participant: messages in their MAIN conversation after `last_viewed_at`, latest message time | the session-list unread loop |
| `v_reflection_theme` | per (user, theme): count of reflections, latest `updated_at` | `RecurringTheme` |

Functions (P3 §5, unchanged in purpose; signatures re-based): `app.current_user_id()`, `app.is_member(session)`, `app.co_participants(session)`, `app.partner_user_id(session)` (kept for 2-party job paths; returns NULL when N≠2), `app.empathy_set_status(attempt, status)` (the only writer of `empathy_attempt.status`; refuses a non-author moving a row into a disclosing state), `app.session_set_status(session, status)` (runs T-cardinality-1's check and the terminal-state rules), `app.touch_updated_at()`, `app.anonymize_user_account(user)` / `app.anonymize_user_in_session(session, participant)` (the tombstone path: scrub `user`, delete `user_device`/`user_preferences`/`ai_memory`(user)/`reflection*`/`feature_state`/`user_memory`, delete the participant's `conversation` (cascades messages, drafts), unshared `need`, `mood_reading`, `regulation_event`, `need_disposition`, `follow_up_note` (unshared); set `participant.left_at`; destroy `user_key` and `participant_key`), `app.resolve_user_by_clerk_id`, `app.create_user_for_clerk` (`mwf_auth`).

---

## 5. Prisma mapping notes

| Topic | Rule |
|---|---|
| Names | every model `@@map("snake_name")`, every field `@map("snake_name")`; model names PascalCase singular (`Participant`, `FollowUpCheckin`), relation fields camelCase. A generator check (`prisma format` + a script diffing `@map`s against `information_schema`) runs in CI |
| Ids | `String @id @default(dbgenerated("uuidv7()")) @db.Uuid` as today |
| Timestamps | `DateTime @db.Timestamptz(3)`; `updated_at` is `@updatedAt` in Prisma **and** trigger-maintained in SQL (Prisma's value wins on Prisma writes; the trigger covers raw/job writes) |
| Enums | Prisma enums with `@@map` to the snake type names; member names unchanged (upper snake) |
| Generated columns | `user.name`, `consent.target_kind`: declared in Prisma as plain nullable scalars with `@default(dbgenerated())` and never written by the app; migration SQL owns the `GENERATED ALWAYS` clause |
| `Unsupported` | none remain: the three `vector(1024)` columns go with D8; `wrapped_dek` is `Bytes` |
| Composite PKs | `@@id([a, b])` on `relationship_member`, `participant_milestone`, `need_disposition`, `proposal_need`, `proposal_choice`, `agreement_party`, `takeaway_link`, `feature_state` |
| Lives only in migration SQL (Prisma cannot express it) | RLS `ENABLE/FORCE` + policies · all triggers (T-cardinality-1/2, T-message-immutable, T-same-session, T-consent-transitions, T-need-share-terminal, T-agreement-parties, `touch_updated_at`) · every CHECK (incl. `jsonb_typeof`, exclusive arcs, ranges, the `intensity` domain) · partial unique indexes (`session` live, `conversation` MAIN, `empathy_attempt` live-per-direction, `reconciler_result` current, `need_disposition` current, key tables) · partial plain indexes (`follow_up.scheduled_for`, `reminder.remind_at`, `need.participant_id`) · `GENERATED` columns · views (`security_invoker`) · `app.*` functions · roles and grants · `milestone` seed rows. **Rule:** every such object is created in a hand-written migration file named `*_target_shape_constraints`, and `prisma migrate diff --from-url <db> --to-schema-datamodel schema.prisma` must report *only* those objects (a CI script allow-lists them by name) |
| Views in Prisma | not declared (the `views` preview feature is not used); read through the Phase 4 `pg` layer or `$queryRaw` with a typed row mapper in `backend/src/db/views.ts` |
| Partial uniques in Prisma | declared as plain `@@index` so the client has the field names; uniqueness is the SQL index |

---

## 6. What the application must change (blast radius)

Sizes are census production call sites (`schema-review-2026-10/models.csv`, R/W) summed per old model touched; "contract" marks a change visible in `shared/src/contracts` or `shared/src/dto` (mobile impact).

| Area | Files | Old models touched (R/W) | Change | Contract? |
|---|---|---|---|---|
| Identity & participant resolution | `middleware/auth.ts` (404), `utils/session.ts` (542), `utils/stage-resolver.ts`, `services/shared-context.ts` | User 38/20, RelationshipMember 11/5, StageProgress 65/38 | `requireSessionAccess` resolves `participant` once per request and puts `participant_id` on the request context; all partner lookups → `v_co_participant`; stage → `v_current_stage` | no (DTO `stage` numbers computed from `stage_label`/ordinal in a shim until mobile moves to milestone keys) |
| Session list & state | `controllers/sessions.ts` (1275), `controllers/session-state.ts`, `controllers/stage0.ts` | Session 90/28, UserVessel 30/14, Invitation 14/8 | unread via `v_conversation_unread`; archive via `conversation_read_state`; compact gates → `participant_milestone` inserts | `SessionSummaryDTO` keeps shape; `gatesSatisfied` fields in `StageProgressDetailDTO` become derived (contract unchanged, values computed) |
| Chat turn pipeline | `services/stream-turn-admission.ts`, `-context.ts` (665), `-persistence.ts`, `-actions.ts`, `-background.ts`, `controllers/messages.ts` (1284), `services/context-assembler.ts` (1010), `context-retriever.ts` (799) | Message 36/34, UserVessel, StageProgress | `message.create` takes `conversation_id` (no `forUserId`); AI/SYSTEM rows written through the job connection; **the per-participant prompt-assembly rule becomes one entry point** `buildContextForParticipant(participantId)` in `context-assembler.ts` — the only code that may read another participant's rows (shared vessel only) | `stream` contract unchanged |
| Empathy & reconciler | `controllers/stage2.ts` (2456), `controllers/reconciler.ts` (1046), `services/reconciler/*` (2,955), `services/empathy-status.ts`, `services/empathy-state-machine.ts` | EmpathyAttempt 28/15, EmpathyDraft 5/3, EmpathyValidation 4/3, ReconcilerResult 13/7, ReconcilerShareOffer 15/12, RefinementAttemptCounter 1/1, ValidationFeedbackDraft 0/1 | attempts immutable per round (new row on resubmit); direction by participant ids; status via `app.empathy_set_status`; reveal via `v_session_readiness`; share offers write `*_notified_at` | `empathy` DTOs gain `round`/`attemptId` on reveal payloads (additive) |
| Needs & repair | `controllers/stage3.ts` (1470), `controllers/stage4.ts` (2723), `services/stage4-*.ts` (2,340), `services/needs*.ts` | IdentifiedNeed 23/16, ConsentedContent 1/3, StrategyProposal 19/11, Stage4* 29/22, StrategyRanking 4/2, Agreement 6/3 | needs share → `need.shared_*`; walkthrough state → `need_disposition`; coverage → `v_need_coverage`; selections → `proposal_choice`; agreement creation → job path with `agreement_party`; closure arrays → view; ranking endpoints removed | `rankStrategies*` removed; `confirmAgreement` response shape unchanged; `Stage4CoverageStatus` from view |
| Consent | `controllers/consent.ts`, `routes/consent.ts` | ConsentRecord 6/5 | arc columns instead of `targetType/targetId` | `ConsentRecordDTO` keeps `targetType` (generated column) |
| Follow-up (tending) | `services/tending.service.ts` (1814), `controllers/tending.ts`, `src/scripts/open-due-tending-entries.ts` | TendingEntry 7/20, TendingCheckin 2/1, 5 response tables 1/6, CoordinationCycle 5/4, Reminder 1/3, Note 3/3 | check-in writes one `follow_up_checkin` with `payload`; cycle status from `v_follow_up_cycle`; deadline on `follow_up` | `strategy.ts` tending DTOs: payload shape is the same data, nested; renames only |
| Reflection (Inner Work) | `controllers/inner-work.ts` (1366), `controllers/knowledge-base.ts` (680), `controllers/takeaways.ts`, `controllers/distillation.ts`, `services/distillation.ts`, `services/theme-detector.ts`, `routes/inner-thoughts.ts` | InnerWorkSession 31/13, InnerWorkMessage 5/5, SessionTakeaway 12/5, TakeawayLink 5/3, RecurringTheme 1/1 | renames; **remove all 18 `prismaAny`/`(prisma as any)` casts** (review F4.3); themes from `v_reflection_theme`; semantic search over takeaways rebuilt app-side (D8) or disabled until then | `inner-work`/`knowledge-base` DTOs: renames behind the same routes |
| Wellbeing → documents | `controllers/meditation.ts` (1177), `gratitude.ts` (676), `needs-assessment.ts` (537), `people.ts`, `services/people-extractor.ts`, `cross-feature-context.ts` | 11 models, 54/34 | each controller reads/writes one `feature_state` row; the 4 `DISTINCT ON` raw queries become in-memory reductions over the document | routes unchanged; DTOs unchanged (the document mirrors them) |
| Memory & preferences | `controllers/auth.ts` (665), `controllers/memories.ts`, `services/global-memory.ts`, `services/memory-*.ts`, `services/push.ts` | User, UserMemory 11/12 | preferences → `user_preferences.doc`; push tokens → `user_device`; global facts → `ai_memory` | `auth` contract unchanged |
| Deletion & retention | `services/account-deletion.ts`, `session-deletion.ts`, `session-retention.ts`, `data-retention.ts`, `src/scripts/sweep-session-retention.ts` | all | call `app.anonymize_*`; explicit private-row deletes per P3 §7 | — |
| Encryption | `lib/prisma-encryption-middleware.ts`, `utils/field-encryption.ts` | 9 models | field map rewritten for the target columns (§1 "encrypted" marks); key class per table; `enc:v2:<keyId>` | — |
| Realtime & notifications | `services/realtime.ts` (980), `controllers/notifications.ts` | ReconcilerShareOffer, EmpathyAttempt | payloads carry `participant_id`; badge counts use the now-written `*_notified_at` | `realtime` contract: `partnerId` → `participantId` (**breaking**, versioned event names) |
| Brain dashboard | `routes/brain.ts` (1475) | all, read-only | repoint to new names; `mwf_ops` role | dashboard only |
| Testing | `src/testing/state-factory.ts`, `src/testing/golden/*`, `routes/e2e.ts`, `lib/e2e-fixtures.ts` | all | fixtures build `participant`-centred state; see plan §4 | — |

---

## 7. Invariants

Enforced by the schema (mechanism named):

| Rule | Mechanism |
|---|---|
| A message has exactly one audience, and it is a participant's private conversation | `message.conversation_id NOT NULL` FK; RLS owner arm; T-message-immutable |
| Humans cannot author as the facilitator; AI/SYSTEM content is immutable | CHECK on `message.role`/`sender_participant_id`; T-message-immutable |
| A user is at most one participant per session; a modeled participant has no user | `participant` UNIQUE (session_id, user_id); CHECK kind ⇔ user_id |
| A session becomes ACTIVE only with ≥2 participants, ≥1 human; never loses its last human while live | T-cardinality-1, T-cardinality-2 (deferred) |
| One live session per relationship (A-Q3) | partial unique on `session` |
| Exactly one main conversation per participant | partial unique on `conversation` |
| A milestone is reached once; progress is an event, not a mutable flag | `participant_milestone` PK; append-only grants |
| No stage number exists; the stage vocabulary is data | `milestone` lookup; `v_current_stage`; no `stage` column anywhere (D3) |
| An empathy attempt is immutable once submitted; a later edit is a new round; what the partner saw is the row they saw | `empathy_attempt` append-only `content`, `round`, `supersedes_attempt_id`; `message.source_attempt_id` records which row was delivered (A-Q5) |
| You cannot imagine yourself; author and subject share a session | CHECK author ≠ subject; T-same-session |
| One live attempt per direction; one current reconciler result per attempt | partial uniques |
| A co-participant sees an attempt only once REVEALED/VALIDATED; the gap analysis only as its subject; the guidance only as author/subject | RLS on `empathy_attempt`, `reconciler_result`, `reconciler_guidance` (P3 §2) |
| Status moves only along the transition table and never into a disclosing state by a non-author | `app.empathy_set_status` is the only writer (P3 §5) |
| Every crossing of the boundary has a dated consent naming exactly one target; consent cannot be deleted while anything depends on it; revocation is terminal | `consent` exclusive-arc CHECK, `decided_at` CHECK, T-consent-transitions, RESTRICT FKs |
| A shared need is visible to co-participants only while shared and unrevoked, and only its transformed text | `need` RLS + `v_need_shared` column projection; T-need-share-terminal |
| Partner choices stay hidden until the chooser reaches `choices_shared` | `proposal_choice` RLS arm over `participant_milestone` |
| An agreement exists only when every named party was WILLING; parties are a set over participants | T-agreement-parties; `agreement_party` (D4) |
| Inner Work can never be referenced by anything that crosses between participants | **no FK from any §1.1–1.5 table to `reflection*`**; CI assertion over `pg_constraint`; `reflection` RLS is `user_id = me` only (D2) |
| Every FK to `user` is RESTRICT; a user row is never hard-deleted | migration + CI structural assertion (P3 D9) |
| Values are in range | `intensity` domain; score/confidence CHECKs; `jsonb_typeof` and key-presence CHECKs |
| Jobs find their work by index, not by scanning documents | partial indexes on `follow_up.scheduled_for`, `reminder.remind_at`, `invitation.expires_at` |

Service rules the schema cannot express (each needs a test in the golden harness):

| Rule | Where it lives |
|---|---|
| **A prompt built for participant X contains only X's private material (X's conversation, drafts, needs, `ai_memory`, mood, and X's own reflections) plus the session's shared vessel — never another participant's private rows or reflections** (D2) | single entry point `buildContextForParticipant` in `context-assembler.ts`; golden scenario "reflection never crosses" |
| Reveal fires only when `v_session_readiness.all_reached` for `empathy_ready` (all-N; P1 parked — if pairwise is chosen later, the predicate changes, not the tables) | `services/reconciler/state.ts` as `mwf_job` |
| A late reconciler result must not overwrite a newer decision | `reconciler_result.superseded_at` is set by the job that produces the newer one, in the same transaction; `status_version` on the attempt |
| What was delivered to a partner is what they continue to see even after the author revises | the delivered `message` row is immutable and points at the specific attempt row; the UI renders from `message`, not from the live attempt |
| The modeled participant's "private conversation" is readable by the human or not (P2 parked) | policy on `conversation` for `participant.kind = 'modeled'`; today: owner arm only, i.e. nobody — the job writes it |
| `display_name` is the only `user` fact a co-participant may see; `last_active_at` only with the owner's privacy preference | `v_participant` masking; no co-member policy on `user` |
| Tombstoned users are excluded from every membership count | `participant.left_at IS NULL` in `v_session_readiness` and `v_follow_up_cycle`; `work-a39h.3.14` |
