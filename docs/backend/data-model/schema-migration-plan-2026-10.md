---
title: "Schema Migration Plan — October 2026"
sidebar_position: 8
description: One-shot re-shape from the 68-table Prisma schema to the target shape — strategy, sequencing against Phase 3, build order with assertions, verification, application rewrite, Lightsail rollout, work breakdown, risks.
created: 2026-10-17
status: living
---

# Schema Migration Plan — October 2026

Target: [`schema-target-2026-10.md`](./schema-target-2026-10.md) (46 tables; "absorbs" lines there are
the mapping used here). Rationale: [`schema-review-2026-10.md`](./schema-review-2026-10.md) §8–§9.
Security: [`phase3-design-summary.md`](./phase3-design-summary.md) §8 rollout, re-sequenced in §2 below.

## 1. Strategy and why

**One shot, one transaction, one cutover.** Production holds 9 users and ~1,000 messages; every
copy step below completes in seconds, so there is nothing to amortise and nothing to dual-write.
The golden harness (`backend/src/testing/golden/`) is the oracle: it snapshots tables through `pg`,
never Prisma, and diffs rows before/after real HTTP calls — exactly the instrument a re-shape
needs, and the one the uuid migration (`20261010180736_cuid_to_uuidv7`) already proved: generated
SQL from the catalog, an `_id_map`, pre- and post-assertions that `RAISE` inside Prisma's single
migration transaction, and a before/after **content-hash** verification
(`backend/scripts/verify-uuid-migration.sql`) that checks identity of references, not just counts.
This plan reuses that pattern verbatim: a generator script, a mapping table, assertions, and the
verify script extended to the new names.

**Why not incremental.** A strangler (new tables beside old, dual writes, per-feature cutover)
buys safety only when the old shape must keep serving traffic for weeks. Here the application is
rewritten against the target in the same release (§5), Phase 3's 69×4 policies have not been
written yet and would otherwise be written twice, and every intermediate state (two message
tables, a `participant` that half the code knows about) is a state the harness would have to
certify on its own. What a one-shot does **not** buy: no dual-running, no partial rollback. The
rollback is the preserved backup `deploy.sh` takes immediately before `migrate deploy`
(`infra/aws/deploy.sh:13–15`), restored with `restore.sh … replace-production`. Between backup and
a green smoke check the API is stopped (`compose stop api`), so no writes are lost by rolling back.

## 2. Sequencing against Phase 3

Decision: **W0–W2 proceed now on the current shape; W3–W6 are folded into the re-shape
migration; W7–W10 and W13 land only on the target.** Roles, the identity GUC and the `app.*`
helpers are shape-independent and are prerequisites for testing the new policies at all. CHECKs,
FKs and the invitation column are cheaper to write once against the target than to write twice.

| # | Step | On which shape | Gate |
|---|---|---|---|
| 1 | **W0** D0 check (`rolsuper=false`), split connection URLs (`APP_/JOB_/OPS_/AUTH_DATABASE_URL`) | current | — |
| 2 | **W1/W1a** roles `mwf_migrator/app/job/ops/auth`, baseline grants, `USING (true)` placeholders where P3 says so | current | D0 green |
| 3 | **W2** `app.current_user_id()`, request-scoped `SET LOCAL` in the Phase 4 `pg` layer spike (`lib/prisma-pg.ts` adapter path) | current | W1 |
| 4 | Error middleware strips `PostgresError.detail` (P3 §7 prerequisite for any CHECK) | current | — |
| 5 | **Fixture pipeline rewrite** (`state-factory.ts` → participant-centred; `work-a39h.6.1`) and new golden scenarios recorded **against the current shape** so the re-record in §4 has a baseline | current | — |
| 6 | **Re-shape migration** = this plan §3, carrying **W3 CHECKs, W4 triggers (as T-*), W5/W6 FKs + `invitation.accepted_by_user_id`, W4b tombstone column + every-FK-to-user-RESTRICT**, in one migration file pair (generated data move + hand-written constraints) | → target | 1–5; rehearsal green (§6) |
| 7 | Application rewrite merged in the same release (§5); `prisma migrate diff` empty | target | harness green |
| 8 | **W8/W9** `ENABLE`+`FORCE` RLS on all target tables, policies as written in target §1 (placeholders first per tier, P3 §9.1) | target | 6, 7 |
| 9 | **W10** enforcement per tier with shadow-mode row-count comparison | target | Phase 4 identity (step 3 complete) |
| 10 | **W13** encryption: `user_key`/`session_key`/`participant_key`, field map for the target columns, vectors removed | target | its six P3 prerequisites |

Nothing in steps 1–5 is wasted if the re-shape slips; nothing in 8–10 is written twice.

## 3. Build order for the migration

Two migration files, applied in one `migrate deploy`: **(a)** `*_target_shape` — generated
(`backend/scripts/gen-target-migration.ts`, modelled on `gen-uuid-migration.ts`): creates the new
tables beside the old, copies data, asserts, drops the old tables; **(b)** `*_target_shape_constraints`
— hand-written: enums already created in (a); CHECKs, partial indexes, generated columns, triggers,
views, functions, `milestone` seed, grants. Both run inside Prisma's single transaction per file;
any `RAISE` leaves the database untouched.

**Id policy.** Tables that are renames keep their ids (`session`, `message`, `need`, `proposal`,
`empathy_attempt`, `agreement`, `follow_up`, `reflection*`, `takeaway*`, `user_memory`,
`invitation`, `consent`) so URLs, push payloads and mobile caches survive. New entities
(`participant`, `conversation`, `draft`, `participant_milestone`, …) mint `uuidv7(created_at)` as
the uuid migration did, so they sort by original creation time. A `_shape_map(concept, old_key,
new_id)` table records every minted id for the verify script and is dropped at the end.

| Step | Copy (old → new) | Assertion (RAISE on failure) |
|---|---|---|
| 0 | Record row counts of all 68 tables into `_row_counts` | — |
| 1 | `user` ← `User` identity cols; `user_device` ← push/biometric; `user_preferences` ← 3 jsonb (defaults filled from `DEFAULT_*_PREFERENCES`); `ai_memory(GLOBAL_FACTS)` ← `globalFacts` | one `user` per `User`; one `user_preferences` per user |
| 2 | `relationship`, `relationship_member` ← same (role text → enum; unknown values RAISE) | counts equal |
| 3 | `session` ← `Session` (status `WAITING/PAUSED` → `ACTIVE`, recorded as a milestone in step 7); `topic_frame*` carried | counts equal; **A-Q3 precheck**: no relationship has >1 live session, else RAISE with the ids (owner resolves before cutover) |
| 4 | **`participant`** ← one row per distinct `(sessionId, userId)` in `StageProgress ∪ UserVessel ∪ EmpathyDraft ∪ Stage4ProposalSelection ∪ TendingCheckin`, union `RelationshipMember × Session` for members who never wrote a row; `display_name` ← `User.name`; `joined_at` ← `RelationshipMember.joinedAt`; `kind='human'` | every `(session,user)` referenced by any old `userId+sessionId` pair resolves to exactly one participant; every ACTIVE/RESOLVED session has ≥2 participants (else RAISE listing sessions — these are the data the trigger would later reject) |
| 5 | **A/B slots** → participant ids: `getUserSlot` order (first `RelationshipMember` by `joinedAt`) materialised once into `_ab_slot(session_id, slot, participant_id)`; used by steps 13, 14 | every 2-participant session has exactly one A and one B |
| 6 | **`conversation`** ← one MAIN per participant (id minted); `conversation_read_state` ← `UserVessel.{lastViewedAt, lastSeenChatItemId, lastViewedShareTabAt, lastActiveAt, archivedAt}`; `ai_memory(SUMMARY, NOTABLE_FACTS)` ← `UserVessel.{conversationSummary (parsed from text, RAISE on invalid JSON), notableFacts}`; SUBCHAT conversations ← `Stage4SubChat` (ids kept, `participant_id` via `(sessionId,userId)`) | one MAIN per participant; every `UserVessel` mapped |
| 7 | **`participant_milestone`** ← `StageProgress.gatesSatisfied` decoded per key table (`compactSigned/signedAt`→`compact_signed`, `feelHeardConfirmed/At`→`feel_heard`, `needsConfirmed`, `needsShared`, `selectionSubmitted`→`choices_shared`, `empathyExchanged`→`empathy_ready`, `empathyValidated`, `invitationSent`, …; timestamp from the paired `*At` key, else `StageProgress.completedAt`, else `startedAt`); plus `StageProgress(status=COMPLETED, stage=n)` → the terminal milestone of stage n; `Session.status WAITING` → nothing (derived), `PAUSED` → `paused` milestone with `detail` | **every milestone derivable**: for every `StageProgress` row with `status=COMPLETED` the participant has the stage's terminal milestone; unknown gate keys RAISE (the key table is exhaustive by census §5) |
| 8 | **`need_disposition`** ← `gatesSatisfied.{coveredNeedIds, skippedNeedIds, currentNeedId}` (Stage 4 walkthrough) ∪ `Stage4NeedCoverage` (user-set `coverageStatus`) ∪ `Stage4NeedDeclination` (→ DECLINED) | every referenced need id exists (text ids cast to uuid, RAISE on no match) |
| 9 | **`message`** ← `Message` (ids kept): `conversation_id` = MAIN conversation of participant `(sessionId, coalesce(forUserId, senderId))`; `sender_participant_id` from `senderId`; `role` ∈ USER/AI/SYSTEM from old role, `kind` from the six event roles; `source_attempt_id` for `EMPATHY_STATEMENT`/`VALIDATION_FEEDBACK` rows by matching `(session, author, content_hash)` where resolvable, else NULL; `Stage4SubChatMessage` → SUBCHAT conversations; `InnerWorkMessage` → `reflection_message` (**never** into `message`) | counts: `message` = `Message` + `Stage4SubChatMessage`; `reflection_message` = `InnerWorkMessage`; zero rows with NULL `conversation_id`; the P3 CHECK `role AI/SYSTEM ⇒ sender NULL` holds (rows violating it are listed and the migration RAISEs — fix data first) |
| 10 | `draft` ← `EmpathyDraft` (EMPATHY), `ValidationFeedbackDraft` (VALIDATION_FEEDBACK), `ReconcilerShareOffer.refinedContent` (SHARE_CONTEXT) | unique per (participant, kind) |
| 11 | **`empathy_attempt`** ← `EmpathyAttempt` (ids kept): author ← `sourceUserId`, subject ← the other participant of the session (RAISE if N≠2 — none today), `round` ← `revisionCount+1`, status `ANALYZING→HELD`, `NEEDS_WORK→AWAITING_SHARING`; `reconciler_result` ← `ReconcilerResult` by `(sessionId, guesserId, subjectId)` → attempt (ids kept; `subject_participant_id`); `reconciler_guidance` split; `context_share_offer` ← `ReconcilerShareOffer` (+`attempt_id` via result; `NOT_OFFERED/SKIPPED → EXPIRED`); `empathy_review` ← `EmpathyValidation`; `RefinementAttemptCounter` dropped (count check only) | **every reveal still resolvable**: for every old attempt with status REVEALED/VALIDATED the new row is readable under the target policy by its subject (simulated with `SET LOCAL app.current_user_id`); one current result per attempt; counter value = `count(reconciler_result)` per direction ± 0 |
| 12 | **`consent`** ← `ConsentRecord`: arc column by `targetType` (`IDENTIFIED_NEED→need_id`, `EMPATHY_ATTEMPT/EMPATHY_DRAFT→empathy_attempt_id`, `STRATEGY_PROPOSAL→proposal_id`; `EVENT_SUMMARY/EMOTIONAL_PATTERN/BOUNDARY` have no rows — RAISE if any); `targetId` text → uuid resolved against the target table (unresolvable → RAISE); `need.shared_*` ← `ConsentedContent` by `originalNeedId` (or by `consentRecordId` where `originalNeedId` is NULL — census: never written, so expect the latter) | `num_nonnulls(arc)=1` for every row; every `ConsentedContent` landed on exactly one `need` |
| 13 | **Proposals**: `proposal` ← `StrategyProposal` (ids kept); `proposal_need` ← `StrategyProposalNeed` ∪ resolvable `needsAddressed[]` labels (match on `IdentifiedNeed.need` within the session, case-insensitive); unmatched labels → `proposal.unresolved_need_labels`; `proposal_choice` ← `Stage4ProposalSelection`; `proposal_revision` ← `Stage4ProposalRevision` (`action` upper-snaked; `sessionId` dropped after asserting it equals the proposal's); `agreement` ← `Agreement` (via `SharedVessel.sessionId`); **`agreement_party` ← `agreedByA/B` through `_ab_slot`**; `session_closure` ← `Stage4Closure` minus arrays; `StrategyRanking` dropped | every `agreedByX=true` produced a party row; `v_session_closure_items` reproduces each old array as a set (RAISE on difference, reported per session); `needsAddressed` label coverage reported (count resolved / unresolved) — informational, not fatal |
| 14 | **Follow-up**: `follow_up` ← `TendingEntry` (ids kept; `owner_participant_id` via `(sessionId, ownerUserId)`; `response_deadline_at` ← the entry's open `TendingCoordinationCycle.responseDeadlineAt`); `follow_up_checkin` ← `TendingCheckin` with `payload` assembled from `TendingResponse`, `TendingEntryOutcome`, `TendingNeedOutcome`, `TendingAdjustment`, `TendingResponsePartialClosure` rows (`jsonb_agg` per check-in; validated against the zod contract in a post-step by the verify script); `follow_up_note` ← `TendingBetweenPeriodNote`; `reminder` ← `TendingReminder`; `TendingCoordinationCycle` dropped | counts conserved per concept: Σ array lengths in payloads = Σ old child rows; `v_follow_up_cycle.status` equals the old cycle status for every open cycle |
| 15 | **Reflection**: `reflection` ← `InnerWorkSession` (ids kept; `summary_doc` parsed from text), `takeaway` ← `SessionTakeaway`, `takeaway_link` ← `TakeawayLink`; `RecurringTheme`, `Insight` dropped | counts equal; **zero FKs from §1.1–1.5 tables to `reflection*`** (catalog assertion) |
| 16 | **Wellbeing → `feature_state`**: one row per (user, feature) built with `jsonb_build_object`/`jsonb_agg` from `Meditation*`/`SavedMeditation`, `Gratitude*`, `NeedScore`/`NeedsAssessmentState`, `Person`/`PersonMention`; `GlobalLibraryItem`, `PreSessionMessage`, `UserEvent`, `Boundary`, `UserDocument`, `CommonGround` dropped (all unpopulated per census §2) | Σ array lengths per feature = old row counts per user; each `doc` validates against its zod contract (verify script, post-migration) |
| 17 | **26 FK-less text ids**: each either became a real FK above (`forUserId`, `guesserId/subjectId`, `ReconcilerShareOffer.userId`, `Stage4NeedDeclination.*`, `Stage4ProposalRevision.actorUserId/messageId`, `Stage4Closure.closedByUserId`, `TendingEntry.ownerUserId`, `TendingNeedOutcome.needId/sourceUserId` (inside payload, resolved to uuid), `Stage4NeedCoverage.needId`, `StrategyProposal.capturedFromMessageId`, `SavedMeditation.conversationId` (into the document), `PersonMention.*` (document)) or was dropped (`parentProposalId`, `anchorId` → `anchor_proposal_id` where it was a proposal id, `linkedConflictId` ×2, `associatedSessionId`, `contributedBy`, `turnId` stays text) | every resolved value cast to uuid and found; unresolvable non-null values RAISE with table/column/count |
| 18 | `brain_activity` ← `BrainActivity` (`innerWorkSessionId` → `reflection_id`; `participant_id` NULL for history) | counts equal |
| 19 | Drop all 68 old tables and the 51 old enum types; drop `_shape_map`, `_ab_slot`, `_row_counts` | **after** every assertion above; see below |
| 20 | (file b) enums ordered as target §3, CHECKs, domains, partial indexes, generated columns, triggers, functions, views, `milestone` seed (ordinals from today's stage order), grants | `prisma migrate diff` against the new `schema.prisma` reports only the allow-listed SQL-only objects |

**Old tables are dropped at the end of file (a), in the same transaction.** Reasons: the preserved
backup is the rollback, not the old tables; leaving 68 tables behind invites a reader (brain
dashboard, a script) to keep using them; and `prisma migrate diff` cannot be empty with them
present. The rehearsal (§6) keeps a restored copy with the old tables for a week for forensic
comparison — that copy, not production, is where "what did this look like before" is answered.

## 4. Verification

| Layer | What | How |
|---|---|---|
| In-migration | every assertion in §3 | `RAISE EXCEPTION` inside the transaction; zero tolerance |
| Content-hash before/after | identity of every reference across the rename: each new row rendered with each id replaced by the content hash of the row it names, compared as a multiset to the old rendering **modulo the mapping** (`_shape_map` + the concept table of §3: `Message→message`, `UserVessel→conversation+read_state+ai_memory`, …). Rows that merge (5 tending tables → one payload) are compared after `jsonb` normalisation (`jsonb_strip_nulls`, sorted arrays) | `backend/scripts/verify-target-migration.sql`, `-v phase=before|after`, extended from `verify-uuid-migration.sql`; run in rehearsal and on the production host before `compose up` |
| Golden harness (`work-a39h.2.4`) | the two recorded scenarios (`session-read`, `empathy-reveal`) **redden wholesale** on rename. Plan: (1) before the re-shape, record a **normalised** baseline: HTTP bodies for both scenarios, and row snapshots projected through a `concept view` layer (`old_concept_*` views over the old tables that already present participant-centred rows); (2) after, the same views are redefined over the new tables; (3) **byte-identical across the re-record:** the HTTP response bodies of both scenarios (after the existing id/timestamp normalisation), and the concept-view row diffs. Row diffs of raw tables are expected to differ and are not asserted | `GOLDEN_UPDATE=<scenario>` one scenario at a time, per the harness README; the normaliser gains a rename map (`forUserId→participant` labels) |
| New golden scenarios (required before cutover) | **R1 reflection-never-crosses**: a user with a linked reflection; co-participant's full session read and the co-participant's prompt context contain no reflection text (asserted on `brain_activity.input` of the turn). **R2 co-participant-cannot-read-unrevealed**: an attempt in HELD/AWAITING_SHARING/REFINING/READY is absent from the subject's reads and from `v_empathy_direction` as subject; present after REVEALED. **R3 N=2 reveal fires on all-ready**: two attempts reach READY in either order; reveal occurs exactly once when the second does; `v_session_readiness.all_reached` flips in the same transaction. **R4 choices hidden until shared**: partner `proposal_choice` invisible before `choices_shared`. **R5 tombstone**: account deletion leaves delivered messages readable to the partner, removes private rows, participant row survives with `left_at` | recorded first against the **current** shape using the `old_concept_*` views (so they fail today where the current code leaks — that is information), then re-recorded on the target |
| Fixture pipeline (`work-a39h.6.1`) — **critical path** | `state-factory.ts` (the 53 tooling writes of `StageProgress` alone, census §11) is rewritten to build participant-centred state through the application's own services where possible and through `pg` otherwise; `FEEL_HEARD_B` and the other `TargetStage`s are expressed as milestone sets | blocks R1–R5 and the re-record; start first |
| Application | `npm run check`, `npm run test` all workspaces; the 39 Prisma-mocking suites are rewritten or deleted where they encode old shapes (count them in the WBS) | CI |
| Post-deploy smoke | `infra/aws/smoke.cjs` + `verify.sql` (row counts, FK validation) + one scripted two-user walk (`scripts/mwf-moment-real.ts` ported) to reveal | on the host before `compose up -d caddy` |

## 5. Application rewrite plan

Grouped by cluster, sized by census production call sites (R/W); "behind contract" = no change in
`shared/src/contracts` or DTO shapes; "contract change" = mobile must ship together (OTA).

| Cluster | Size (R/W) | Behind old contracts? | Notes |
|---|---|---|---|
| Identity, participant resolution, stage | User 38/20, RelationshipMember 11/5, StageProgress 65/38 | yes — `stage` numbers in DTOs computed from `v_current_stage.ordinal`/`stage_label` by a shim | first; everything else depends on `req.participant` |
| Chat turn pipeline + context builder | Message 36/34, UserVessel 30/14 | yes (`stream` contract unchanged) | `buildContextForParticipant` is the **single** entry point; delete the ad-hoc partner reads in `stream-turn-context.ts:517`, `state.ts:619` (P3 §7) |
| Empathy & reconciler | 66/42 | mostly; reveal payload gains `attemptId`/`round` (additive) | immutable rounds; `app.empathy_set_status`; `v_session_readiness` |
| Needs, proposals, agreements, closure | 87/55 | `rankStrategies*` contracts **removed**; `Stage4CoverageStatus` now from the view; rest behind contract | agreement creation moves to the job path |
| Consent | 13/10 | yes (`targetType` generated) | |
| Follow-up | 19/37 | renames; payload nests the same data | job scripts `open-due-tending-entries.ts` repointed |
| Reflection | 57/28 | yes | remove 18 `prismaAny` casts; lint rule `no-prisma-any`; takeaway semantic search disabled or app-side (D8) |
| Wellbeing → `feature_state` | 54/34 | yes (DTOs mirrored by the documents) | the 4 raw `DISTINCT ON` queries become reductions |
| Memory & preferences | 11/12 (+User) | yes | |
| Deletion & retention | — | — | `app.anonymize_*`, explicit private deletes |
| Realtime | — | **contract change**: `partnerId` → `participantId` in `realtime.ts` events | versioned event names; mobile handler update |
| Brain dashboard | read-only | dashboard only | |
| Encryption middleware | 9 models → target columns | — | W13 prerequisite, not W13 itself |
| Tests | 39 mocking suites | — | delete or rewrite against the harness |

Order: identity → chat pipeline → empathy → needs/proposals → follow-up → reflection → wellbeing →
memory → deletion → realtime → dashboard. Each cluster lands behind the same routes; the release
is one PR train on a `target-shape` integration branch, merged to `main` once (that merge is the
deploy — §6).

## 6. Rollout on Lightsail

`main` auto-deploys (`.github/workflows/aws-deploy.yml`, `on: push: branches: [main]`), and
`deploy.sh` stops the API, takes `backup.sh preserved`, runs `migrate deploy`, starts the API and
gates on health. **The merge to `main` is the deploy.**

| # | Step | Command / artefact | Gate |
|---|---|---|---|
| 1 | Freeze: no other backend merges to `main` from rehearsal start to smoke green | branch protection note | — |
| 2 | **Preserved backup** of production | `/opt/mwf/backup.sh preserved` (operator-run, in addition to the one `deploy.sh` takes) | artefact in S3 with `SHA256SUMS` |
| 3 | **Rehearsal** on a restored copy | `restore.sh <dump> restore_target` → `psql -v phase=before -f verify-target-migration.sql` → `migrate deploy` against `restore_target` → `-v phase=after` → `infra/aws/verify.sql` → run the golden suite against it | all green; wall-clock measured (expect seconds) |
| 4 | Keep the rehearsal database for 7 days | forensic "before" copy with the old tables | — |
| 5 | Merge the `target-shape` train to `main` | PR; CI green incl. harness and `migrate diff` empty | 3 green |
| 6 | Deploy runs | `deploy.sh`: API stopped → preserved backup → `migrate deploy` (both files) → API up → health | script exit 0 |
| 7 | Smoke | `smoke.cjs`; `verify.sql` (row counts, `VALIDATE CONSTRAINT`); `verify-target-migration.sql -v phase=after` against production using the `before` snapshot taken in step 3's schema (re-taken on production immediately before step 6 by a pre-deploy hook) ; scripted two-user walk to reveal | all green |
| 8 | Mobile OTA for the realtime contract change (`ota-update.yml`) | after 7 | — |
| 9 | **Rollback** (only before step 8, only if 7 fails): `compose stop api`; `restore.sh <preserved dump> mwf replace-production`; redeploy previous image (`/var/lib/mwf/previous-image`, `deploy.sh` with the previous manifest); `verify.sql` | explicit operator decision; `deploy.sh` never reverses migrations itself |

## 7. Work breakdown (for beads; epic `target-shape`, label `project:meet-without-fear`)

| # | Issue | Acceptance criterion | Blocked by |
|---|---|---|---|
| 1 | Phase 3 W0–W2 on the current shape: D0 check, split URLs, roles, `app.current_user_id()`, `pg` identity spike | roles exist on dev and in `init-db.sh`; `SET LOCAL app.current_user_id` observed in the statement log for one request | — |
| 2 | Error middleware strips `PostgresError.detail` | a forced CHECK violation returns a body without row contents (test) | — |
| 3 | Fixture pipeline rewrite: `state-factory.ts` builds participant-centred state; `TargetStage`s expressed as milestone sets (`work-a39h.6.1`) | `cli.ts build FEEL_HEARD_B` succeeds on the current shape through the new factory; existing golden suite still green | — |
| 4 | `old_concept_*` views + normaliser rename map; record normalised baselines for `session-read`, `empathy-reveal` | baselines committed; harness green on current shape | 3 |
| 5 | New golden scenarios R1–R5 recorded on the current shape | five scenarios committed; failures on current code documented as findings, not fixed here | 3, 4 |
| 6 | `schema.prisma` for the target (snake_case `@map`s, enums, composite ids) + hand-written constraints migration (file b) | `prisma validate`; `migrate diff` against an empty DB lists only allow-listed SQL-only objects | — |
| 7 | Migration generator `gen-target-migration.ts` + file (a): tables, copies, assertions, drops (§3 steps 0–19) | generated SQL applies on a restored production copy with zero RAISE; all §3 assertions pass | 6 |
| 8 | `verify-target-migration.sql` (content-hash before/after modulo mapping; payload/document zod validation) | before/after on the rehearsal copy reports zero identity differences | 7 |
| 9 | App rewrite I: identity/participant resolution, context builder entry point, chat pipeline, session list | harness `session-read` green on target; no `forUserId` in `backend/src` | 6 |
| 10 | App rewrite II: empathy/reconciler (immutable rounds, `empathy_set_status`, readiness view), consent arc | `empathy-reveal`, R2, R3 green on target | 9 |
| 11 | App rewrite III: needs/proposals/agreements/closure/follow-up (choices, `agreement_party`, payload check-ins); ranking endpoints removed | R4 green; `rankStrategies*` gone from contracts; tending job runs against `follow_up` | 9 |
| 12 | App rewrite IV: reflection (no `prismaAny`), wellbeing → `feature_state`, memory/preferences, deletion/retention via `app.anonymize_*`, realtime `participantId`, brain dashboard | R1, R5 green; `no-prisma-any` lint passes; 39 mocking suites rewritten or deleted | 9 |
| 13 | Encryption field map for target columns (W13 prerequisite) | middleware tests green against target column names; `contentHash` still written | 9 |
| 14 | Rehearsal on Lightsail restored copy (§6 steps 2–4) and runbook | rehearsal log with timings; verify scripts green; rollback rehearsed once on the copy | 7, 8, 10, 11, 12 |
| 15 | Cutover: merge train to `main`, smoke, mobile OTA (§6 steps 5–8) | production on target; smoke green; `migrate diff` empty against production | 14 |
| 16 | Phase 3 W8–W10 on the target: enable/force RLS, policies from target §1, shadow mode, per-tier enforcement | CI structural assertions (coverage, FK-to-user RESTRICT, no FK into `reflection*`) green; R1–R5 green under enforcement | 15, 1 |

## 8. Risks

| # | Risk | Mitigation already in the plan |
|---|---|---|
| 1 | A data row violates a new invariant (e.g. an `AI` message with a `senderId`, a session with one participant marked ACTIVE, an unresolvable `targetId`) and the migration RAISEs on production | every such case RAISEs **in rehearsal first** on a restored copy (§6.3) with the offending ids listed; data is fixed by a small pre-migration script merged before the train; the migration itself stays zero-tolerance |
| 2 | The `gatesSatisfied` → milestone decoding loses a state the UI depends on (e.g. `feelHeardCheckOffered`, Stage 4 `phase`) | the key table is exhaustive by census §5; unknown keys RAISE; the two golden scenarios plus R1–R5 compare HTTP bodies byte-for-byte after normalisation; `participant_milestone.detail` keeps small payloads rather than dropping them |
| 3 | The harness re-record masks a behavioural regression (re-recording "accepts" whatever the new code does) | baselines are recorded on the **current** shape through concept views first (§4), one scenario at a time; the HTTP bodies and concept-view diffs must be byte-identical across the re-record, so the re-record can only change raw-table labels |
| 4 | Application rewrite is larger than the schedule (≈1,000 call sites; 39 mocking suites) | clusters land behind existing contracts in dependency order (§5); only `rankStrategies*` removal and the realtime `participantId` rename touch mobile, both planned with the OTA step; the integration branch is not merged until the whole train is green, so production never sees a half-rewritten app |
| 5 | Rollback after users have written to the new shape loses those writes | the API is stopped from backup to health check; rollback is permitted only before the mobile OTA (§6.9) and is an explicit operator step; after that point forward-fix is the policy, which the tiny data volume makes tractable |
