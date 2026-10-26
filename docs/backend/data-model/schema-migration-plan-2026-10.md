---
title: "Schema Migration Plan — October 2026"
sidebar_position: 8
description: Fresh-baseline cutover from the 68-table Prisma schema to the target shape (OD7, 2026-10-26: no data move) — strategy, sequencing against Phase 3, baseline build order, verification, application rewrite, Lightsail cutover, work breakdown, risks.
created: 2026-10-17
status: living
---

# Schema Migration Plan — October 2026

Target: [`schema-target-2026-10.md`](./schema-target-2026-10.md) (47 tables; "Absorbs" lines there are
the mapping used here). Rationale: [`schema-review-2026-10.md`](./schema-review-2026-10.md) §8–§9.
Security: [`phase3-design-summary.md`](./phase3-design-summary.md) §8 rollout, re-sequenced in §2 below.
Revised 2026-10-17 after the adversarial pass (dispositions at the end). **Revised 2026-10-26 for
owner decision OD7** (§1, §3, §4, §6, §7, §8): existing production data is demo/test and is not
preserved, so the cutover is a fresh baseline migration on an emptied database — there is no data
move. The data-move design (prechecks, copy steps 1–19, id policy, fix-data, content-hash verify)
is superseded; it stays readable in git history (`phoenix/target-shape` at `3cf611cb`), and the
adversarial dispositions below that cite "§3 step N" refer to that version.

## 1. Strategy and why

**A fresh baseline, one transaction, one cutover (OD7, 2026-10-26).** The owner decided that the
data in production is demo/test data and is **not preserved**. The target shape is therefore not
reached by moving rows: one migration, `*_target_shape_baseline`, builds the 47 target tables and
everything that lives only in SQL on an **empty** database, and it is the only migration in
`backend/prisma/migrations` (the 75 current-shape migrations, TS-1's `phase3_app_schema_helpers` and
TS-7's data-move `target_shape` are deleted from the active branch; git history keeps them). A
database still at the old shape is emptied first by the operator script
`backend/scripts/target-shape/drop-old-objects.sql` (§6). No prechecks, no fix-data script, no
content-hash verification, no mapping table: there is nothing to verify identity against.

What carries over from the data-move design unchanged: the generator
(`backend/scripts/gen-target-migration.ts`, deterministic, its output committed), the hand-maintained
trailer (CHECKs, the `intensity` domain, `app.*` functions with the TS-1 ownership/grant order,
T-* triggers, `touch_updated_at` on 35 tables, views, milestone seed, grants, the step-20 catalog
assertions), `sql-only.sql`, the schema gate `check-schema.sh`, and the per-caller privacy tests —
re-validated on an empty target database (TS-7c).

**Why not incremental.** A strangler (new tables beside old, dual writes, per-feature cutover)
buys safety only when the old shape must keep serving traffic for weeks. Here the application is
rewritten against the target in the same release (§5), Phase 3's policies have not been written
yet and would otherwise be written twice, and every intermediate state is a state the harness would
have to certify on its own. What a one-shot does **not** buy: no dual-running, no partial rollback.
The rollback is the preserved backup taken immediately before the cutover, restored with
`restore.sh … replace-production`, plus the previous image. Between backup and a green smoke check
the API is stopped, so no writes are lost by rolling back.

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
| 6 | **Baseline migration** = §3 (OD7: fresh baseline, no data move), carrying **W3 CHECKs, W4 triggers (the T-* set), W5/W6 FKs + `invitation.accepted_by_user_id`, W4b tombstone column + every-FK-to-user-RESTRICT**, in one migration file | → target | 1–5; `run-baseline.sh` green (§3) |
| 7 | Application rewrite merged in the same release (§5); `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` empty | target | harness green |
| 8 | **W8/W9** `ENABLE`+`FORCE` RLS on all target tables, policies as written in target §1 (placeholders first per tier, P3 §9.1) | target | 6, 7 |
| 9 | **W10** enforcement per tier with shadow-mode row-count comparison | target | Phase 4 identity (step 3 complete) |
| 10 | **W13** encryption: `user_key`/`session_key`/`participant_key`, field map for the target columns per the writer-principal rule (target Conventions), vectors removed | target | its six P3 prerequisites |

Nothing in steps 1–5 is wasted if the re-shape slips; nothing in 8–10 is written twice.

## 3. Build order for the baseline migration

OD7, 2026-10-26. **One migration file** `backend/prisma/migrations/20261026120000_target_shape_baseline/migration.sql`,
written by `npx tsx backend/scripts/gen-target-migration.ts` (`--check`: two runs byte-identical,
equal to the committed file, and the only migration). It runs in one transaction under
`prisma migrate deploy`; a `RAISE` anywhere rolls it all back. Sections, in order:

| # | Section | Source |
|---|---|---|
| 0 | **Preamble**: refuse unless the database is empty (no table `"Session"` — the old shape, with the cutover instruction in the hint —, no schema `app`, no relation in `public` but `_prisma_migrations`); the roles assertion (`mwf_app/job/ops/auth` exist) and `pg_has_role(current_user, 'mwf_job', 'SET')`, both from TS-1's migration; `CREATE SCHEMA app` + `USAGE` grants; `app.current_user_id()` | `backend/scripts/target-shape/preamble.sql` |
| 1 | Enums and the 47 tables: `prisma migrate diff --from-empty --to-schema <copy of schema.prisma without the consent.target_kind @default> --script` (the default references other columns; §T2 re-adds the column GENERATED) | `schema.prisma` |
| 2 | `milestone` seed (13 rows; reference data) | `backend/scripts/target-shape/gen/maps.ts` |
| 3 | **Trailer**: T1 `intensity` domain · T2 `sql-only.sql` verbatim (generated columns, `sql_` indexes) · T3 CHECKs · T4 `app.*` functions — `is_member`/`partner_user_id` (TS-1's signatures, re-based on `participant`) created like every other definer helper and handed to `mwf_job` in the TS-1 order (GRANT CREATE → ALTER OWNER → REVOKE CREATE → SET ROLE `mwf_job` for REVOKE/GRANT EXECUTE) · T5 triggers (T-* and `touch_updated_at` ×35) · T6 views · T7 grants (column-level for `mwf_job`) · T8 catalog assertions (plan step 20: FK-to-user RESTRICT, `need_share → need` RESTRICT, no FK into `reflection*`, `jsonb_typeof` CHECK on every jsonb column, 35 `touch_updated_at`, views `security_invoker`, pinned `search_path`, no PUBLIC EXECUTE, definer functions owned by `mwf_job`, 13 milestones) | `backend/scripts/target-shape/trailer.sql` |

There are no invariant re-checks over existing rows: the database is empty, and every invariant is
a trigger or CHECK that sees every row from the first write.

**Proof** (`backend/scripts/target-shape/run-baseline.sh <ts7_name>`): generator `--check` →
`CREATE DATABASE` → `migrate deploy` → `check-schema.sh --db` (validate, drift empty, pull delta
`sql_`-only, `sql_` names complete) → a second `migrate deploy` is a no-op → `seed-target-fixture.sql`
(a two-session target fixture through the real triggers) → `smoke-baseline.sql` (all 12 views as
`mwf_app`) → `functions-caller-tests.sql` (17 per-caller tests as `mwf_app`/`mwf_job` logins).
`--as-migrator` builds a database owned by `mwf_migrator` and deploys as it; `--cutover` proves the
§6 path end to end from an old-shape database built from the `phoenix/base` history; `--dev` keeps
the branch's development databases (`docs/development/local-setup.md`).

## 4. Verification

| Layer | What | How |
|---|---|---|
| In-migration | the preamble guard and the T8 catalog assertions of §3 | `RAISE EXCEPTION` inside the one transaction; zero tolerance |
| ~~Content-hash before/after~~ | **cancelled by OD7 (2026-10-26)**: no data is moved, so there is no identity to verify | — |
| Baseline proof | generator determinism; gate; second deploy no-op; target fixture; view smoke as `mwf_app`; 17 per-caller tests; the cutover path from an old-shape database | `backend/scripts/target-shape/run-baseline.sh` (§3) |
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

## 6. Cutover on Lightsail

OD7, 2026-10-26: production's data is not preserved. `main` auto-deploys
(`.github/workflows/aws-deploy.yml`) and `deploy.sh` runs `migrate deploy` itself, but `deploy.sh`
cannot apply the baseline to a database that still has the old shape — the baseline's preamble
refuses it. The cutover is therefore an **operator sequence** run before (or as) the merge that
deploys the target image; afterwards `deploy.sh`'s own `migrate deploy` finds nothing pending.

| # | Step | Command / artefact | Gate |
|---|---|---|---|
| 1 | Freeze: no other backend merges to `main` from cutover start to smoke green | branch protection note | — |
| 2 | **Backup** (kept, although the data is not carried over) | `/opt/mwf/backup.sh preserved` | artefact in S3 with `SHA256SUMS` |
| 3 | **Stop the API** | `compose stop api` | nothing writes |
| 4 | **Drop the old shape** | `psql -v ON_ERROR_STOP=1 -d <db> -v target_db=<db> -f backend/scripts/target-shape/drop-old-objects.sql` — one transaction; refuses unless `<db>` is in the `target_db` allow-list, table `"Session"` exists and table `participant` does not; drops the 68 old tables, 51 enum types, TS-1's `app` objects and `_prisma_migrations`; asserts `public` is empty | script exit 0 |
| 5 | **`prisma migrate deploy`** | applies the single baseline (one transaction) | exit 0; `_prisma_migrations` = 1 row |
| 6 | **Deploy the image** | merge the `target-shape` train to `main` (`deploy.sh`: its `migrate deploy` is a no-op) | health green |
| 7 | **Smoke** | `smoke.cjs`; `verify.sql`; `check-schema.sh --db`-equivalent drift check (`migrate diff` empty); scripted two-user walk to reveal | all green |
| 8 | Mobile OTA for the `rankStrategies*` removal (`ota-update.yml`) | after 7 | — |
| 9 | **Rollback** (only before step 8): `compose stop api`; `restore.sh <backup> mwf replace-production`; redeploy the previous image (`/var/lib/mwf/previous-image`); `verify.sql`. A failure in step 5 leaves the database empty (the baseline is one transaction), so restoring the backup is the rollback | explicit operator decision |

Rehearsal: `run-baseline.sh --cutover <ts7_name>` runs steps 4–5 and the full proof on a database
built from the old migration history and seeded through the current-shape factory (TS-7c log).

## 7. Work breakdown (for beads; epic `target-shape`, label `project:meet-without-fear`)

| # | Issue | Acceptance criterion | Blocked by |
|---|---|---|---|
| 1 | Phase 3 W0–W2 on the current shape: D0 check, split URLs, roles, `app.current_user_id()`, definer helpers, `pg` identity spike | roles exist on dev and in `init-db.sh`; `SET LOCAL app.current_user_id` observed in the statement log for one request; `app.is_member` callable as `mwf_app` | — |
| 2 | Error middleware strips `PostgresError.detail` | a forced CHECK violation returns a body without row contents (test) | — |
| 3 | Fixture pipeline rewrite: `state-factory.ts` builds participant-centred state; `TargetStage`s expressed as milestone sets (`work-a39h.6.1`) | `cli.ts build FEEL_HEARD_B` succeeds on the current shape through the new factory; existing golden suite still green | — |
| 4 | `old_concept_*` views + normaliser rename map + per-scenario allow-lists; record normalised baselines for `session-read`, `empathy-reveal` | baselines and allow-lists committed; harness green on current shape | 3 |
| 5 | New golden scenarios R1–R7 recorded on the current shape | seven scenarios committed; failures on current code documented as findings, not fixed here | 3, 4 |
| 6 | `schema.prisma` for the target (snake_case `@map`s, enums, composite ids, relations with `onUpdate: NoAction`, generated columns declared as `db pull` renders them, no `sql_`-named indexes) | `backend/scripts/target-shape/check-schema.sh` passes: `prisma validate`; `migrate diff --from-config-datasource --to-schema` against a DB built by the migration is empty; `prisma db pull` matches `schema.prisma` (after normalisation) on a database without the `sql_` objects, and differs only by the `sql_` objects on one with them — the single-stage "`db pull` output matches `schema.prisma`" is superseded: `db pull` renders partial indexes and flips single-column ones to 1:1 (target §5, verified TS-6, 2026-10-19, PG 18.6 / Prisma 7.10) | — |
| 7 | Baseline generator `gen-target-migration.ts` + the single baseline migration (§3), `drop-old-objects.sql` and `run-baseline.sh` (OD7, 2026-10-26: no data move; the TS-7/7b data-move generator and fix-data template are superseded) | `run-baseline.sh <ts7_*>`: deploy ok, gate passed, 17 per-caller tests + second deploy no-op, view smoke; `--cutover` green from an old-shape database | 6 |
| 8 | ~~`verify-target-migration.sql`~~ — **cancelled (OD7, 2026-10-26)**: no data is moved, so there is no before/after identity to verify | — | — |
| 9 | App rewrite I: identity/participant resolution, context builder entry point, chat pipeline, session list | harness `session-read` green on target (allow-list); no `forUserId` in `backend/src` | 6 |
| 10 | App rewrite II: empathy/reconciler (immutable rounds, `empathy_set_status` with gate + delivered copy, `v_empathy_direction_status`), consent arc | `empathy-reveal`, R2, R3, R6, R7 green on target | 9 |
| 11 | App rewrite III: needs (`need_share`), proposals/agreements/closure/follow-up (choices, `agreement_party`, payload check-ins); ranking endpoints removed | R4 green; `rankStrategies*` gone from contracts; tending job runs against `follow_up` | 9 |
| 12 | App rewrite IV: reflection (no `prismaAny`), wellbeing → `feature_state`, memory/preferences, deletion/retention via `app.anonymize_*`, brain dashboard | R1, R5 green; `no-prisma-any` lint passes; 39 mocking suites rewritten or deleted | 9 |
| 13 | Encryption field map for target columns per the writer-principal rule (W13 prerequisite) | middleware tests green against target column names; `contentHash` still written | 9 |
| 14 | Cutover rehearsal (§6 steps 2–5) on a restored copy of production, and the runbook | `drop-old-objects.sql` + `migrate deploy` green on the copy with timings; smoke green; rollback (restore + previous image) rehearsed once on the copy | 7, 10, 11, 12 |
| 15 | Cutover (§6 steps 1–8): backup → stop API → `drop-old-objects.sql` → `migrate deploy` → deploy image → smoke → mobile OTA | production on target with one `_prisma_migrations` row; smoke green; `migrate diff` empty against production | 14 |
| 16 | Phase 3 W8–W10 on the target: enable/force RLS, policies from target §1, shadow mode, per-tier enforcement | CI structural assertions (coverage, FK-to-user RESTRICT, no FK into `reflection*`) green; R1–R7 green under enforcement | 15, 1 |

## 8. Risks

| # | Risk | Mitigation already in the plan |
|---|---|---|
| 1 | ~~A data row violates a new invariant and the migration RAISEs on production~~ — **moot under OD7** (no data is moved); the remaining risk is `drop-old-objects.sql` meeting an unexpected object (a harness view, a hand-made table) | the drop is RESTRICT and in one transaction, so an unknown dependent fails it and changes nothing; the rehearsal (row 14) runs it on a restored copy first |
| 2 | ~~The `gatesSatisfied` → milestone decoding loses a state the UI depends on~~ — **moot under OD7** (nothing is decoded; new sessions write milestones directly) | the key table is built from a grep of every writer, each key has a decision, unknown keys RAISE; the scenario allow-lists name exactly which derived keys are expected to disappear, so an unexpected loss fails the harness |
| 3 | The harness re-record masks a behavioural regression | baselines are recorded on the **current** shape through concept views first (§4), one scenario at a time; comparisons use explicit per-scenario allow-lists (subset + named additions), so the re-record can only change what the list says |
| 4 | Application rewrite is larger than the schedule (≈1,000 call sites; 39 mocking suites) | clusters land behind existing contracts in dependency order (§5); only `rankStrategies*` removal touches mobile; the integration branch is not merged until the whole train is green |
| 5 | Rollback after users have written to the new shape loses those writes | the API is stopped from backup to health check; the baseline is one transaction, but the old shape is already dropped by then (§6 step 4), so a failed deploy leaves the database **empty** — restore the backup (§6 step 9); rollback is permitted only before the mobile OTA (§6.9) and is an explicit operator step |

---

## Adversarial findings, 2026-10-17 — dispositions

Source: `scratchpad/target-schema-adversarial.md` (independent pass on `ab614381`). Schema-side findings are dispositioned in `schema-target-2026-10.md`; this table covers the plan.

| ID | Disposition |
|---|---|
| P0-1 | **fixed in §3 steps 8, 12, 13** — `need_share` copied from `ConsentedContent` and (TS-7b, 2026-10-21) from the Stage 3 handler's granted `ConsentRecord(IDENTIFIED_NEED)` rows that have no `ConsentedContent`; `proposal_need`/dispositions filtered to shared needs; closure-array assertion restricted to live shared needs (a revoked share is a listed expected difference) |
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
