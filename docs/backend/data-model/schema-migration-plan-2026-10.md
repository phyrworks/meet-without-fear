---
title: "Schema Migration Plan — October 2026"
sidebar_position: 8
description: One-shot re-shape from the 68-table Prisma schema to the target shape — strategy, sequencing against Phase 3, build order with assertions, verification, application rewrite, Lightsail rollout, work breakdown, risks.
created: 2026-10-17
status: living
---

# Schema Migration Plan — October 2026

Target: [`schema-target-2026-10.md`](./schema-target-2026-10.md) (47 tables; "Absorbs" lines there are
the mapping used here). Rationale: [`schema-review-2026-10.md`](./schema-review-2026-10.md) §8–§9.
Security: [`phase3-design-summary.md`](./phase3-design-summary.md) §8 rollout, re-sequenced in §2 below.
Revised 2026-10-17 after the adversarial pass (dispositions at the end).

## 1. Strategy and why

**One shot, one transaction, one cutover.** Production holds 9 users and ~1,000 messages; every
copy step below completes in seconds, so there is nothing to amortise and nothing to dual-write.
The golden harness (`backend/src/testing/golden/`) is the oracle: it snapshots tables through `pg`,
never Prisma, and diffs rows before/after real HTTP calls — exactly the instrument a re-shape
needs, and the one the uuid migration (`20261010180736_cuid_to_uuidv7`) already proved: generated
SQL from the catalog, an `_id_map`, pre- and post-assertions that `RAISE` inside Prisma's single
migration transaction, and a before/after **content-hash** verification
(`backend/scripts/verify-uuid-migration.sql`) that checks identity of references, not just counts.
This plan reuses that pattern: a generator script, a mapping table, assertions, the verify script
extended to the new names — and, unlike the first draft, **one migration file**, because Prisma
7.10 applies each file atomically on its own (adversarial P1-11 [V]): a second file that fails
would leave the first committed.

**Why not incremental.** A strangler (new tables beside old, dual writes, per-feature cutover)
buys safety only when the old shape must keep serving traffic for weeks. Here the application is
rewritten against the target in the same release (§5), Phase 3's policies have not been written
yet and would otherwise be written twice, and every intermediate state (two message tables, a
`participant` half the code knows about) is a state the harness would have to certify on its
own. What a one-shot does **not** buy: no dual-running, no partial rollback. The rollback is the
preserved backup `deploy.sh` takes immediately before `migrate deploy` (`infra/aws/deploy.sh:13–15`),
restored with `restore.sh … replace-production`. Between backup and a green smoke check the API is
stopped (`compose stop api`), so no writes are lost by rolling back.

## 2. Sequencing against Phase 3

Decision: **W0–W2 proceed now on the current shape; W3–W6 are folded into the re-shape
migration; W7–W10 and W13 land only on the target.** Roles, the identity GUC and the `app.*`
helpers are shape-independent and are prerequisites for testing the new policies at all. CHECKs,
FKs and the invitation column are cheaper to write once against the target than twice.

| # | Step | On which shape | Gate |
|---|---|---|---|
| 1 | **W0** D0 check (`rolsuper=false`), split connection URLs (`APP_/JOB_/OPS_/AUTH_DATABASE_URL`) | current | — |
| 2 | **W1/W1a** roles `mwf_migrator/app/job/ops/auth`, baseline grants, `USING (true)` placeholders where P3 says so; **the job role (owner of the definer helpers) gets `EXECUTE` on `app.current_user_id()` and `SELECT` on `participant`** — pass 2 found the helpers fail without exactly these | current | D0 green |
| 3 | **W2** `app.current_user_id()`, the definer helpers (`app.is_member`, `app.is_co_participant` — target §4), request-scoped `SET LOCAL` in the Phase 4 `pg` layer spike | current | W1 |
| 4 | Error middleware strips `PostgresError.detail` (P3 §7 prerequisite for any CHECK) | current | — |
| 5 | **Fixture pipeline rewrite** (`state-factory.ts` → participant-centred; `work-a39h.6.1`) and new golden scenarios recorded **against the current shape** so the re-record in §4 has a baseline | current | — |
| 6 | **Re-shape migration** = §3, carrying **W3 CHECKs, W4 triggers (the T-* set), W5/W6 FKs + `invitation.accepted_by_user_id`, W4b tombstone column + every-FK-to-user-RESTRICT**, in one migration file | → target | 1–5; rehearsal green (§6) |
| 7 | Application rewrite merged in the same release (§5); `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` empty | target | harness green |
| 8 | **W8/W9** `ENABLE`+`FORCE` RLS on all target tables, policies as written in target §1 (placeholders first per tier, P3 §9.1) | target | 6, 7 |
| 9 | **W10** enforcement per tier with shadow-mode row-count comparison | target | Phase 4 identity (step 3 complete) |
| 10 | **W13** encryption: `user_key`/`session_key`/`participant_key`, field map for the target columns per the writer-principal rule (target Conventions), vectors removed | target | its six P3 prerequisites |

Nothing in steps 1–5 is wasted if the re-shape slips; nothing in 8–10 is written twice.

## 3. Build order for the migration

**One migration file** `*_target_shape/migration.sql`, generated by `backend/scripts/gen-target-migration.ts`
(modelled on `gen-uuid-migration.ts`) with a hand-maintained trailer: (1) enums and new tables,
(2) prechecks, (3) copies with assertions, (4) drop the 68 old tables and 51 old enum types,
(5) **constraints, triggers, functions, views, `milestone` seed, grants** — all in the same
transaction, so a failure anywhere leaves the database exactly as it was. The trailer is
idempotent SQL (`CREATE OR REPLACE`, `IF NOT EXISTS`) only for readability; it never runs alone.

**Id policy.** Tables that are renames keep their ids (`session`, `message`, `need`, `proposal`,
`empathy_attempt`, `agreement`, `follow_up`, `reflection*`, `takeaway*`, `user_memory`,
`invitation`, `consent`) so URLs, push payloads and mobile caches survive. New entities
(`participant`, `conversation`, `draft`, `participant_milestone`, `need_share`, …) mint
`uuidv7(created_at)` as the uuid migration did. `_shape_map(concept, old_key, new_id)` records every
minted id for the verify script and is dropped at the end.

**Prechecks (step 0b) — every one lists offending ids and RAISEs; all are expected to return zero rows on
production after the rehearsal has been used to fix data with a small pre-migration script:**

| Precheck | Why |
|---|---|
| no relationship with >1 non-terminal `Session` | A-Q3 partial unique |
| no `Message` with `role IN ('AI','SYSTEM') AND senderId IS NOT NULL` | target CHECK (P3 §6) |
| every `Agreement` has `proposalId IS NOT NULL` (one writer passes `strategyId \|\| null`, `stage4.ts:2153`) | target `agreement.proposal_id NOT NULL` (P1-10) |
| `Agreement.status = 'PROPOSED'` rows: both `agreedByA AND agreedByB` → will map to `AGREED`; otherwise → **dropped** (an agreement nobody accepted is just its proposal, which still exists) — listed, not fatal | enum loses `PROPOSED` (P1-10) |
| `User.name IS NOT DISTINCT FROM nullif(trim(coalesce(firstName,'')\|\|' '\|\|coalesce(lastName,'')),'')` | `user.name` becomes generated (P2); mismatches are fixed by writing the split names first |
| every `gatesSatisfied` key is in the key table of step 7 | unknown key = unmodelled state |
| every `ConsentRecord.targetType` ∈ {IDENTIFIED_NEED, EMPATHY_ATTEMPT, EMPATHY_DRAFT, STRATEGY_PROPOSAL} and `targetId` resolves | arc (P0-3 shape) |
| `_ab_slot` tie report (step 5) | P1-8 |
| vanished-member report (step 4a) | P1-9 |

| Step | Copy (old → new) | Assertion (RAISE on failure) |
|---|---|---|
| 0 | Record row counts of all 68 tables into `_row_counts` | — |
| 1 | `user` ← `User` identity cols; `user_device` ← push/biometric; `user_preferences` ← 3 jsonb (defaults filled from `DEFAULT_*_PREFERENCES`); `ai_memory(GLOBAL_FACTS)` ← `globalFacts` | one `user` per `User`; one `user_preferences` per user; `name` precheck passed |
| 2 | `relationship`, `relationship_member` ← same (role text → enum; unknown values RAISE) | counts equal |
| 3 | `session` ← `Session` (status `WAITING` → `ACTIVE`; `PAUSED` → `ACTIVE` + `paused` milestone in step 7); `topic_frame*` carried | counts equal; A-Q3 precheck passed |
| 4 | **`participant`** ← one row per distinct `(sessionId, userId)` in `StageProgress ∪ UserVessel ∪ EmpathyDraft ∪ Stage4ProposalSelection ∪ TendingCheckin ∪ Message.forUserId ∪ Message.senderId`, union `RelationshipMember × Session`; `display_name` ← `User.name`; `joined_at` ← `RelationshipMember.joinedAt`; `kind='human'` | every `(session, user)` referenced by any old `userId+sessionId` pair resolves to exactly one participant |
| 4a | **Vanished members** (users hard-deleted under today's `user.delete`, `account-deletion.ts:160`; their `RelationshipMember`/`StageProgress`/`UserVessel` cascaded): detect sessions whose evidence names a user id with no `User` row — `Message.forUserId` (text, no FK, survives), `ReconcilerResult.guesserId/subjectId`, `ReconcilerShareOffer.userId`, `Stage4NeedDeclination.userId`, `TendingEntry.ownerUserId`. For each such id: **mint a tombstone `user`** (`email 'deleted+<id>'`, `deleted_at = now()`, names NULL) and a `participant(kind='human', user_id = tombstone, left_at = now(), display_name NULL)`; route the session to `ABANDONED` if non-terminal; `Message` rows with `senderId IS NULL AND forUserId IS NULL` (the leaver's own typed messages, `stream-turn-admission.ts:159` never set `forUserId`) are the leaver's private rows under D9 → **deleted** (counted and reported). Data impact: unknown until the precheck runs; expected small (9 users) | after 4a, every session in ACTIVE/RESOLVED has ≥2 participants (else RAISE — this is the list the owner must look at); zero `Message` rows without a resolvable participant |
| 5 | **A/B slots** → participant ids: `getUserSlot` order (first `RelationshipMember` by `joinedAt`) materialised once into `_ab_slot(session_id, slot, participant_id)`. **Tie-break** (ties are the common case: `relationship.create({members:{create:[inviter, invitee]}})` writes both in one statement, `invitations.ts:396–407`): order by `joinedAt, ctid` — physical order, which is what Prisma returned to `getUserSlot` on a tie; and because that is a belief about physical order, **RAISE when a tie coincides with any `Agreement` of that session having `agreedByA <> agreedByB`** (the only case where the slot matters) — those are resolved by hand on the rehearsal copy (expected 0) | every 2-participant session has exactly one A and one B; the tie-report is empty or hand-resolved |
| 6 | **`conversation`** ← one MAIN per participant (id minted); `conversation_read_state` ← `UserVessel.{lastViewedAt, lastSeenChatItemId, lastViewedShareTabAt, lastActiveAt, archivedAt}`; `ai_memory(SUMMARY, NOTABLE_FACTS)` ← `UserVessel.{conversationSummary (parsed from text, RAISE on invalid JSON), notableFacts}`; SUBCHAT conversations ← `Stage4SubChat` (ids kept) | one MAIN per participant; every `UserVessel` mapped |
| 7 | **`participant_milestone`** ← `StageProgress.gatesSatisfied` decoded with the **key table below**; plus `StageProgress(status=COMPLETED, stage=n)` → the terminal milestone of stage n (0 `compact_signed`, 1 `feel_heard`, 2 `empathy_validated`, 3 `needs_shared`, 4 `choices_shared`); `Session.status PAUSED` → `paused` | every `StageProgress COMPLETED` row has its terminal milestone; unknown keys RAISE |
| 8 | **`need_disposition`** ← `gatesSatisfied.{coveredNeedIds, skippedNeedIds, currentNeedId}` ∪ `Stage4NeedDeclination` (→ DECLINED), for needs that have a `need_share` row (step 12); dispositions on unshared needs are reported and dropped. `Stage4NeedCoverage` is **not** copied (computed; `v_need_coverage`) | every referenced need id exists in `need_share` or is in the dropped report |
| 9 | **`message`** ← `Message` (ids kept): `conversation_id` = MAIN conversation of participant `(sessionId, coalesce(forUserId, senderId))`; `sender_participant_id` from `senderId`; `role` ∈ USER/AI/SYSTEM, `kind` from the six event roles; `source_attempt_id` for `EMPATHY_STATEMENT`/`VALIDATION_FEEDBACK` rows resolved by **`(sessionId, author)`** — the old `@@unique([sessionId, sourceUserId])` makes that the key (there is no hash on `EmpathyAttempt`); `Stage4SubChatMessage` → SUBCHAT conversations; `InnerWorkMessage` → `reflection_message` (**never** into `message`). **Delivered copies:** for every REVEALED/VALIDATED attempt, insert an `EMPATHY_STATEMENT` message into the **subject's** conversation (`source_attempt_id` set, `created_at = revealedAt`) — today's data has none (P0-2) | counts: `message` = `Message` + `Stage4SubChatMessage` + inserted delivered copies (reported); `reflection_message` = `InnerWorkMessage`; zero NULL `conversation_id`; role/sender CHECK precheck passed |
| 10 | `draft` ← `EmpathyDraft` (EMPATHY, `about` = the other participant), `ValidationFeedbackDraft` (VALIDATION_FEEDBACK, `attempt` = the partner's attempt), `ReconcilerShareOffer.refinedContent` (SHARE_CONTEXT, `share_offer`) | unique per (participant, kind, arc) |
| 11 | **`empathy_attempt`** ← `EmpathyAttempt` (ids kept): author ← `sourceUserId`, subject ← the other participant (RAISE if N≠2 — none today), `round` ← `revisionCount+1`, status `ANALYZING→HELD`, `NEEDS_WORK→AWAITING_SHARING`, `revealed_at` carried; `reconciler_result` ← `ReconcilerResult` by `(sessionId, guesserId, subjectId)` → attempt (ids kept; `subject_participant_id`); `reconciler_guidance` split; `context_share_offer` ← `ReconcilerShareOffer` (+`attempt_id` via result; `NOT_OFFERED/SKIPPED → EXPIRED`); `empathy_review` ← `EmpathyValidation` (`feedback` kept only where `feedbackShared`; unsent text → `draft(VALIDATION_FEEDBACK)`); `RefinementAttemptCounter` dropped | **every reveal still resolvable**: for every old REVEALED/VALIDATED attempt the new row is readable by its subject under the target policy (simulated with `SET LOCAL app.current_user_id`), and the subject's conversation holds its delivered copy; one current result per attempt; counter value = `count(reconciler_result)` per direction |
| 12 | **`consent`** ← `ConsentRecord`: arc column by `targetType` (`IDENTIFIED_NEED→need_id`, `EMPATHY_ATTEMPT/EMPATHY_DRAFT→empathy_attempt_id`, `STRATEGY_PROPOSAL→proposal_id`); `targetId` text → uuid resolved against the target table; `requested_by` kept only for NEED/PROPOSAL/EMPATHY_ATTEMPT. **`need_share`** ← `ConsentedContent` (`need_id` via `consentRecordId → ConsentRecord.targetId` — `originalNeedId` was never written, census §3; `session_id` via `SharedVessel`; `category` from the need; **`participant_id` and `session_id` from the resolved need's owner** (pass 2 N-1); `revoked_at` from `consentActive/revokedAt`) | `num_nonnulls(arc)=1` for every row; every `ConsentedContent` landed on exactly one `need_share` whose `participant_id` equals its need's owner (T-need-share-owner would refuse otherwise); T-consent-owner holds for every migrated row (else RAISE: a consent naming a partner's row) |
| 13 | **Proposals**: `proposal` ← `StrategyProposal` (ids kept; `captured_from_message_id` dropped); `proposal_need` ← `StrategyProposalNeed` ∪ resolvable `needsAddressed[]` labels (match on `IdentifiedNeed.need` within the session, case-insensitive), **both filtered to needs with a `need_share` row**; unmatched or unshared → `proposal.unresolved_need_labels`; `proposal_choice` ← `Stage4ProposalSelection`; `proposal_revision` ← `Stage4ProposalRevision` (`action` upper-snaked; `sessionId` asserted = proposal's then dropped; `messageId` dropped); `agreement` ← `Agreement` (via `SharedVessel.sessionId`; `PROPOSED` per precheck); **`agreement_party` ← `agreedByA/B` through `_ab_slot`**; `session_closure` ← `Stage4Closure` minus arrays; `StrategyRanking` dropped | every `agreedByX=true` produced a party row and T-agreement-parties (deferred) accepts the result at commit; `v_session_closure_items` reproduces each old array as a set restricted to shared needs (differences reported per session; a difference that is only an unshared need id is expected and listed, anything else RAISEs); `needsAddressed` label coverage reported |
| 14 | **Follow-up**: `follow_up` ← `TendingEntry` (ids kept; `owner_participant_id` via `(sessionId, ownerUserId)`; `response_deadline_at` and **`summary` ← the entry's open `TendingCoordinationCycle.{responseDeadlineAt, resultSummary}`**); `follow_up_checkin` ← `TendingCheckin` with `payload` assembled (`jsonb_agg`) from `TendingResponse`, `TendingEntryOutcome`, `TendingNeedOutcome` (`needId` resolved to a `need_share` id or kept as label), `TendingAdjustment`, `TendingResponsePartialClosure`; **orphan `TendingResponse` rows (`checkinId IS NULL`) get a synthetic check-in** per `(entry, user)` with `submitted_at = response.submittedAt`; `follow_up_note` ← `TendingBetweenPeriodNote` (`selectedForCheckinId` → `carried_into_checkin_id`; notes with `consentToShareWithPartner` are copied into that check-in's `payload.carriedNotes[]`); `reminder` ← `TendingReminder`; `TendingCoordinationCycle` dropped | counts conserved per concept: Σ array lengths in payloads = Σ old child rows (incl. orphans); `v_follow_up_cycle.status` equals the old cycle status for every open cycle |
| 15 | **Reflection**: `reflection` ← `InnerWorkSession` (ids kept; `summary_doc` parsed from text; `linked_at` ← `updatedAt` of the linking row), `takeaway` ← `SessionTakeaway`, `takeaway_link` ← `TakeawayLink`; `RecurringTheme`, `Insight` dropped | counts equal; **zero FKs from target §1.1–1.5 tables to `reflection*`** (catalog assertion in the trailer) |
| 16 | **Wellbeing → `feature_state`**: one row per (user, feature) built with `jsonb_build_object`/`jsonb_agg` from `Meditation*`/`SavedMeditation`, `Gratitude*`, `NeedScore`/`NeedsAssessmentState`, `Person`/`PersonMention`; `GlobalLibraryItem`, `PreSessionMessage`, `UserEvent`, `Boundary`, `UserDocument`, `CommonGround` dropped (all unpopulated per census §2) | Σ array lengths per feature = old row counts per user; each `doc` validates against its zod contract (verify script, post-migration) |
| 17 | **26 FK-less text ids**: each either became a real FK above (`forUserId`, `guesserId/subjectId`, `ReconcilerShareOffer.userId`, `Stage4NeedDeclination.*`, `Stage4ProposalRevision.actorUserId`, `Stage4Closure.closedByUserId`, `TendingEntry.ownerUserId`, `TendingNeedOutcome.needId/sourceUserId` (inside payload, resolved), `SavedMeditation.conversationId` (document), `PersonMention.*` (document), `Stage4SubChat.anchorId` → `anchor_proposal_id` where it was a proposal id) or was dropped (`parentProposalId`, `capturedFromMessageId`, `Stage4ProposalRevision.messageId`, `Stage4NeedCoverage.*`, `linkedConflictId` ×2, `associatedSessionId`, `contributedBy`; `turnId` stays text) | every resolved value cast to uuid and found; unresolvable non-null values RAISE with table/column/count |
| 18 | `brain_activity` ← `BrainActivity` (`innerWorkSessionId` → `reflection_id`; `participant_id` NULL for history) | counts equal |
| 19 | Drop the 68 old tables and 51 old enum types; drop `_shape_map`, `_ab_slot`, `_row_counts` | after every assertion above |
| 20 | **Trailer (same transaction)**: CHECKs, `intensity` domain, `sql_*` partial indexes, generated columns, triggers, `app.*` functions, views (`security_invoker`), `milestone` seed (ordinals from today's stage order; `self_assertable` flags), grants | catalog assertions inside the transaction: every FK to `user` is RESTRICT; `need_share → need` is RESTRICT; no FK into `reflection*` except `brain_activity`; every jsonb column has a `jsonb_typeof` CHECK. (`prisma migrate diff … --script` empty and `prisma db pull` matching `schema.prisma` are **CI gates** — §2 step 7, §7 issue 6 — not something the migration can run; pass 2 N-8) |

**Step 7 key table** — built from a grep of every key written to `gatesSatisfied` in `backend/src` (adversarial P1-7; the census called the column ad hoc, and it is):

| Old key (sites) | Becomes |
|---|---|
| `compactSigned` + `signedAt` (13/9) | milestone `compact_signed` @ `signedAt` |
| `invitationSent` (2) | milestone `invitation_sent` @ `StageProgress.startedAt` |
| `feelHeardConfirmed` + `feelHeardConfirmedAt`/`confirmedAt` (4/5/5) | milestone `feel_heard` @ the timestamp |
| `feelHeardCheckOffered` (1) | **dropped** — an AI hint flag, not a milestone; the prompt layer recomputes it |
| `finalEmotionalReading` (1) | **dropped** — always written `null` (`messages.ts:289`); live readings are `mood_reading` |
| `partnerConsented`, `partnerValidated` (2/2) | **derived** — the partner's `empathy_attempt` state; not copied |
| `empathyValidated` (3) | milestone `empathy_validated` @ `StageProgress.completedAt` |
| `needsConfirmed` (2), `needsShared` (12), `needsValidated` (6) | milestones `needs_confirmed`, `needs_shared`, `needs_validated` |
| `readyToRank` (7), `rankingSubmitted` (1) | **dropped with ranking** (A-Q4-adjacent; not in the product flow). The Stage-4 completion gate `sessions.ts:524` (`rankingSubmitted`, `agreementCreated`) is replaced by `choices_shared` + a `session_closure` row → `closed` |
| `selectionSubmitted` (3) | milestone `choices_shared` |
| `phase` (7) | milestone `repair_walkthrough_started` when `phase <> 'INVENTORY'`; nothing else |
| `currentNeedId`, `coveredNeedIds`, `skippedNeedIds` (3/3/3) | `need_disposition` (step 8) |
| `partner`/`own` nested objects (`shared-context.ts:60–61`) | read-side projections of the above; not stored |

**Old tables are dropped in the same transaction** as the data move and before the trailer. The
preserved backup is the rollback, not the old tables; leaving 68 tables behind invites a reader to
keep using them; and `migrate diff` cannot be empty with them present. The rehearsal (§6) keeps a
restored copy with the old tables for a week for forensic comparison.

## 4. Verification

| Layer | What | How |
|---|---|---|
| In-migration | every precheck and assertion in §3 | `RAISE EXCEPTION` inside the one transaction; zero tolerance |
| Content-hash before/after | identity of every reference across the rename: each new row rendered with each id replaced by the content hash of the row it names, compared as a multiset to the old rendering **modulo the mapping** (`_shape_map` + §3's concept table). Rows that merge (5 tending tables → one payload) are compared after `jsonb` normalisation. Rows the migration *adds* (delivered `EMPATHY_STATEMENT` copies, synthetic check-ins, tombstone users/participants) are allow-listed by concept and counted | `backend/scripts/verify-target-migration.sql`, `-v phase=before|after`, extended from `verify-uuid-migration.sql`; run in rehearsal and on the production host before `compose up` |
| Golden harness (`work-a39h.2.4`) — what is and is not identical | The two recorded scenarios (`session-read`, `empathy-reveal`) redden wholesale on rename. Plan: (1) before the re-shape, record a **normalised** baseline: HTTP bodies for both scenarios, and row snapshots projected through `old_concept_*` views over the old tables that already present participant-centred rows; (2) after, the same views are redefined over the new tables; (3) compare with a **per-scenario allow-list**, not "byte-identical" (adversarial P1-14). **`session-read`**: identical except `StageProgressDetailDTO.gatesSatisfied` (now derived; keys `feelHeardCheckOffered`, `readyToRank`, `rankingSubmitted`, `finalEmotionalReading` absent — asserted absent, everything else asserted equal) and `ConsentRecordDTO.targetType` (5 values, asserted ⊆ old). **`empathy-reveal`**: old body ⊆ new body — `round`, `attemptId` added on reveal payloads; asserted as a subset match plus an exact list of added keys. Concept-view row diffs: identical modulo the added-row concepts above | `GOLDEN_UPDATE=<scenario>` one scenario at a time, per the harness README; the normaliser gains a rename map |
| New golden scenarios (required before cutover) | **R1 reflection-never-crosses**: co-participant's full session read and prompt context (`brain_activity.input` of the turn) contain no reflection text. **R2 co-participant-cannot-read-unrevealed**: an attempt in HELD/AWAITING_SHARING/REFINING/READY is absent from the subject's reads; `v_empathy_direction_status` shows the status with no content; present after REVEALED **and still present after the author's next round supersedes it**. **R3 N=2 reveal fires on all-ready**: two attempts reach READY in either order; reveal occurs exactly once; both subjects' conversations gain an `EMPATHY_STATEMENT` row. **R4 choices and needs hidden until shared**: partner `proposal_choice` invisible before `choices_shared`; `need.label/evidence` never readable by the partner; `proposal_need`, `v_need_coverage`, `v_session_closure_items` name only `need_share` ids. **R5 tombstone**: account deletion leaves delivered messages, revealed attempts, `need_share` and agreements readable to the partner; private rows gone; `participant.display_name` NULL; `brain_activity` for the leaver gone; live session ABANDONED. **R6 author sees status only** (P1-15): the author's full read and prompt context contain no `reconciler_result` detail, no `context_share_offer` text, no unsent `empathy_review.feedback`; only `v_empathy_direction_status` rows and `reconciler_guidance`. **R7 declined offer leaves no trace**: after the subject declines, the author's reads (incl. `consent`) are unchanged from before the offer | recorded first against the **current** shape using the `old_concept_*` views (so they fail today where current code leaks — that is information), then re-recorded on the target |
| Fixture pipeline (`work-a39h.6.1`) — **critical path** | `state-factory.ts` (53 tooling writes of `StageProgress` alone, census §11) rewritten to build participant-centred state through the application's own services where possible and through `pg` otherwise; `TargetStage`s expressed as milestone sets | blocks R1–R7 and the re-record; start first |
| Application | `npm run check`, `npm run test` all workspaces; the 39 Prisma-mocking suites rewritten or deleted where they encode old shapes | CI |
| Post-deploy smoke | `infra/aws/smoke.cjs` + `verify.sql` (row counts, FK validation) + one scripted two-user walk (`scripts/mwf-moment-real.ts` ported) to reveal | on the host before `compose up -d caddy` |

## 5. Application rewrite plan

Grouped by cluster, sized by census production call sites (R/W); "behind contract" = no change in
`shared/src/contracts` or DTO shapes; "contract change" = mobile must ship together (OTA).

| Cluster | Size (R/W) | Behind old contracts? | Notes |
|---|---|---|---|
| Identity, participant resolution, stage | User 38/20, RelationshipMember 11/5, StageProgress 65/38 | yes — `stage` numbers in DTOs computed from `v_current_stage.ordinal`/`stage_label` by a shim | first; everything else depends on `req.participant` |
| Chat turn pipeline + context builder | Message 36/34, UserVessel 30/14 | yes (`stream` contract unchanged) | `buildContextForParticipant` is the **single** entry point; delete the ad-hoc partner reads in `stream-turn-context.ts:517`, `state.ts:619` (P3 §7) |
| Empathy & reconciler | 66/42 | mostly; reveal payload gains `attemptId`/`round` (additive) | immutable rounds; `app.empathy_set_status` owns the gate and the subject's delivered copy; waiting status from `v_empathy_direction_status` |
| Needs, proposals, agreements, closure | 87/55 | `rankStrategies*` contracts **removed**; `Stage4CoverageStatus` now from the view; rest behind contract | needs share writes `need_share` via `app.need_share()` (job; the only writer); partner needs via `v_need_shared`, which reads `need_share` alone; agreement creation moves to the job path |
| Consent | 13/10 | yes (`targetType` generated) | no requester reads |
| Follow-up | 19/37 | renames; payload nests the same data | job scripts `open-due-tending-entries.ts` repointed |
| Reflection | 57/28 | yes | remove 18 `prismaAny` casts; lint rule `no-prisma-any`; takeaway semantic search disabled or app-side (D8) |
| Wellbeing → `feature_state` | 54/34 | yes (DTOs mirrored by the documents) | the 4 raw `DISTINCT ON` queries become reductions |
| Memory & preferences | 11/12 (+User) | yes | |
| Deletion & retention | — | — | `app.anonymize_*` (the complete walk, target §4) |
| Realtime | — | **no contract change** — the envelope's `forUserId`/`triggeredByUserId`/`excludeUserId`/`userId`/`messagesByUserId` are user ids and stay; `participantId` added where useful (additive) | the first draft's `partnerId` was a local parameter, not a contract field |
| Brain dashboard | read-only | dashboard only | |
| Encryption middleware | 9 models → target columns per the writer-principal rule | — | W13 prerequisite, not W13 itself |
| Tests | 39 mocking suites | — | delete or rewrite against the harness |

Order: identity → chat pipeline → empathy → needs/proposals → follow-up → reflection → wellbeing →
memory → deletion → realtime → dashboard. Each cluster lands behind the same routes; the release
is one PR train on a `target-shape` integration branch, merged to `main` once (that merge is the
deploy — §6). Only `rankStrategies*` removal touches mobile.

## 6. Rollout on Lightsail

`main` auto-deploys (`.github/workflows/aws-deploy.yml`, `on: push: branches: [main]`), and
`deploy.sh` stops the API, takes `backup.sh preserved`, runs `migrate deploy`, starts the API and
gates on health. **The merge to `main` is the deploy.**

| # | Step | Command / artefact | Gate |
|---|---|---|---|
| 1 | Freeze: no other backend merges to `main` from rehearsal start to smoke green | branch protection note | — |
| 2 | **Preserved backup** of production | `/opt/mwf/backup.sh preserved` (operator-run, in addition to the one `deploy.sh` takes) | artefact in S3 with `SHA256SUMS` |
| 3 | **Rehearsal** on a restored copy | `restore.sh <dump> restore_target` → `psql -v phase=before -f verify-target-migration.sql` → `migrate deploy` against `restore_target` → `-v phase=after` → `infra/aws/verify.sql` → golden suite against it; **fix-data script** derived from the precheck reports, re-run until zero RAISE | all green; wall-clock measured (expect seconds) |
| 4 | Keep the rehearsal database for 7 days | forensic "before" copy with the old tables | — |
| 5 | Merge the `target-shape` train to `main` | PR; CI green incl. harness and `migrate diff` empty | 3 green |
| 6 | Deploy runs | `deploy.sh`: API stopped → preserved backup → `migrate deploy` (**one file; all-or-nothing**) → API up → health | script exit 0 |
| 7 | Smoke | `smoke.cjs`; `verify.sql`; `verify-target-migration.sql -v phase=after` against the `before` snapshot a pre-deploy hook took on production immediately before step 6; scripted two-user walk to reveal | all green |
| 8 | Mobile OTA for the `rankStrategies*` removal (`ota-update.yml`) | after 7 | — |
| 9 | **Rollback** (only before step 8, only if 6 or 7 fails): `compose stop api`; `restore.sh <preserved dump> mwf replace-production`; redeploy previous image (`/var/lib/mwf/previous-image`); `verify.sql`. Because the migration is one transaction, a failure in step 6 leaves the database already at the old shape and only the image needs reverting | explicit operator decision; `deploy.sh` never reverses migrations itself |

## 7. Work breakdown (for beads; epic `target-shape`, label `project:meet-without-fear`)

| # | Issue | Acceptance criterion | Blocked by |
|---|---|---|---|
| 1 | Phase 3 W0–W2 on the current shape: D0 check, split URLs, roles, `app.current_user_id()`, definer helpers, `pg` identity spike | roles exist on dev and in `init-db.sh`; `SET LOCAL app.current_user_id` observed in the statement log for one request; `app.is_member` callable as `mwf_app` | — |
| 2 | Error middleware strips `PostgresError.detail` | a forced CHECK violation returns a body without row contents (test) | — |
| 3 | Fixture pipeline rewrite: `state-factory.ts` builds participant-centred state; `TargetStage`s expressed as milestone sets (`work-a39h.6.1`) | `cli.ts build FEEL_HEARD_B` succeeds on the current shape through the new factory; existing golden suite still green | — |
| 4 | `old_concept_*` views + normaliser rename map + per-scenario allow-lists; record normalised baselines for `session-read`, `empathy-reveal` | baselines and allow-lists committed; harness green on current shape | 3 |
| 5 | New golden scenarios R1–R7 recorded on the current shape | seven scenarios committed; failures on current code documented as findings, not fixed here | 3, 4 |
| 6 | `schema.prisma` for the target (snake_case `@map`s, enums, composite ids, relations with `onUpdate: NoAction`, generated columns declared as `db pull` renders them, no `sql_`-named indexes) | `prisma validate`; `migrate diff --from-config-datasource --to-schema` against a DB built by the migration is empty; `prisma db pull` output matches `schema.prisma` | — |
| 7 | Migration generator `gen-target-migration.ts` + the single migration file (§3 steps 0–20) and the fix-data script template | applies on a restored production copy with zero RAISE; all §3 assertions pass | 6 |
| 8 | `verify-target-migration.sql` (content-hash before/after modulo mapping; added-row allow-list; payload/document zod validation) | before/after on the rehearsal copy reports zero identity differences | 7 |
| 9 | App rewrite I: identity/participant resolution, context builder entry point, chat pipeline, session list | harness `session-read` green on target (allow-list); no `forUserId` in `backend/src` | 6 |
| 10 | App rewrite II: empathy/reconciler (immutable rounds, `empathy_set_status` with gate + delivered copy, `v_empathy_direction_status`), consent arc | `empathy-reveal`, R2, R3, R6, R7 green on target | 9 |
| 11 | App rewrite III: needs (`need_share`), proposals/agreements/closure/follow-up (choices, `agreement_party`, payload check-ins); ranking endpoints removed | R4 green; `rankStrategies*` gone from contracts; tending job runs against `follow_up` | 9 |
| 12 | App rewrite IV: reflection (no `prismaAny`), wellbeing → `feature_state`, memory/preferences, deletion/retention via `app.anonymize_*`, brain dashboard | R1, R5 green; `no-prisma-any` lint passes; 39 mocking suites rewritten or deleted | 9 |
| 13 | Encryption field map for target columns per the writer-principal rule (W13 prerequisite) | middleware tests green against target column names; `contentHash` still written | 9 |
| 14 | Rehearsal on Lightsail restored copy (§6 steps 2–4) and runbook | rehearsal log with timings; verify scripts green; rollback rehearsed once on the copy | 7, 8, 10, 11, 12 |
| 15 | Cutover: merge train to `main`, smoke, mobile OTA (§6 steps 5–8) | production on target; smoke green; `migrate diff` empty against production | 14 |
| 16 | Phase 3 W8–W10 on the target: enable/force RLS, policies from target §1, shadow mode, per-tier enforcement | CI structural assertions (coverage, FK-to-user RESTRICT, no FK into `reflection*`) green; R1–R7 green under enforcement | 15, 1 |

## 8. Risks

| # | Risk | Mitigation already in the plan |
|---|---|---|
| 1 | A data row violates a new invariant (AI message with a sender, one-participant ACTIVE session, unresolvable `targetId`, nullable `Agreement.proposalId`, a vanished member) and the migration RAISEs on production | every such case is a **named precheck** that RAISEs in rehearsal first on a restored copy (§6.3) with ids listed; data is fixed by the pre-migration script; vanished members have a defined mapping (step 4a); the migration itself stays zero-tolerance |
| 2 | The `gatesSatisfied` → milestone decoding loses a state the UI depends on | the key table is built from a grep of every writer, each key has a decision, unknown keys RAISE; the scenario allow-lists name exactly which derived keys are expected to disappear, so an unexpected loss fails the harness |
| 3 | The harness re-record masks a behavioural regression | baselines are recorded on the **current** shape through concept views first (§4), one scenario at a time; comparisons use explicit per-scenario allow-lists (subset + named additions), so the re-record can only change what the list says |
| 4 | Application rewrite is larger than the schedule (≈1,000 call sites; 39 mocking suites) | clusters land behind existing contracts in dependency order (§5); only `rankStrategies*` removal touches mobile; the integration branch is not merged until the whole train is green |
| 5 | Rollback after users have written to the new shape loses those writes | the API is stopped from backup to health check; the migration is one transaction, so a failed deploy leaves the old shape intact; rollback is permitted only before the mobile OTA (§6.9) and is an explicit operator step |

---

## Adversarial findings, 2026-10-17 — dispositions

Source: `scratchpad/target-schema-adversarial.md` (independent pass on `ab614381`). Schema-side findings are dispositioned in `schema-target-2026-10.md`; this table covers the plan.

| ID | Disposition |
|---|---|
| P0-1 | **fixed in §3 steps 8, 12, 13** — `need_share` copied from `ConsentedContent`; `proposal_need`/dispositions filtered to shared needs; closure-array assertion restricted to shared needs |
| P0-2 | **fixed in §3 steps 9, 11; §4 R2/R3** — delivered `EMPATHY_STATEMENT` copies inserted into subjects' conversations for every revealed attempt; reveal-resolvable assertion checks the copy exists |
| P0-3 | **fixed in §3 step 12** — no back-pointers copied; T-consent-owner asserted on migrated rows |
| P1-7 | **fixed in §3 step 7** — key table from the grep; `readyToRank`/`rankingSubmitted` dropped with ranking; `feelHeardCheckOffered`, `finalEmotionalReading` dropped; Stage-4 terminal rule = `choices_shared` + closure row |
| P1-8 | **fixed in §3 step 5** — tie-break `joinedAt, ctid` and RAISE when a tie meets `agreedByA <> agreedByB` |
| P1-9 | **fixed in §3 step 4a** — tombstone `user` + `participant(left_at)` per vanished member from `forUserId`/reconciler/declination/tending evidence; both-NULL messages deleted; impact reported by precheck |
| P1-10 | **fixed in §3 prechecks and step 13** — `proposalId NOT NULL` asserted; `PROPOSED` → `AGREED` when both agreed, else dropped (listed) |
| P1-11 | **fixed in §1, §3, §6** — one migration file, trailer in the same transaction; rollback restated |
| P1-12 | **fixed in §2 step 7, §3 step 20, §7 issue 6** — `--from-config-datasource --to-schema`; the schema-side rules are in the target §5 |
| P1-13 | **fixed in the target §4**; §5 deletion row points at the complete walk |
| P1-14 | **fixed in §4 and §5** — per-scenario allow-lists replace "byte-identical"; realtime row rewritten around the real contract fields; mobile impact reduced to `rankStrategies*` |
| P1-15 | **fixed in §4** — R6, R7 added; R4 extended to the need projection; R2 extended to the superseded round |
| P2 `source_attempt_id` match key | **fixed in §3 step 9** — `(sessionId, author)` |
| P2 cycle `resultSummary`/`resolvedAt`, orphan responses, `Stage4NeedCoverage` | **fixed in §3 steps 8, 14** — `resultSummary` → `follow_up.summary`; synthetic check-ins for orphans; coverage not copied |
| P2 `user.name` generated | **fixed in §3 prechecks** — equality asserted, mismatches fixed first |
| P2 enum creation in file (b) | **moot** — single file |
| P2 lock footprint | **accepted** — API stopped, one transaction, within default `max_locks_per_transaction` as the adversary reasoned; the rehearsal measures it |
| P2 rollback story | **fixed in §6 step 9** |

### Pass 2 (`target-schema-adversarial-pass2.md`)

| ID | Disposition |
|---|---|
| N-1 (P0) | **fixed in §3 step 12, §5** — the migration fills `need_share.participant_id`/`session_id` from the resolved need's owner and asserts the pin; the rewrite reads partner needs through `v_need_shared` over `need_share` alone |
| N-2 (P1) | **fixed in §7 issue 6** — acceptance adds "`prisma db pull` output matches `schema.prisma`"; the rule itself is in the target §5 |
| N-3 (P1) | **fixed in §3 step 20** — `need_share → need` RESTRICT is a trailer catalog assertion; the deletion walk is in the target §4 |
| N-8 (P2) | **fixed in §3 step 20** — `migrate diff` and `db pull` are CI gates, not trailer assertions |
| Pass-2 implementation note (job-role grants) | **fixed in §2 step 2** |
| N-4 – N-7 | schema-side; dispositioned in `schema-target-2026-10.md` |
