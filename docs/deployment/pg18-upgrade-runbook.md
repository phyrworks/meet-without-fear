---
title: PostgreSQL 16 → 18 Upgrade Runbook
sidebar_position: 5
description: Owner-executed runbook for upgrading the Render Postgres instance from 16 to 18, clone-first. Phase 1 of work-a39h (data-layer rebuild).
slug: /deployment/pg18-upgrade-runbook
created: 2026-08-18
status: living
---

# PostgreSQL 16 → 18 Upgrade Runbook

Phase 1 of `work-a39h` (rebuild the data layer: PG18 + hand-written DDL, remove Prisma). This
upgrade is independent and reversible on its own: Prisma 6.12 runs unchanged on PG18, so the app
keeps working before, during (modulo the maintenance window) and after it, and stays available as
the behavioural oracle for the later phases.

**Everything in this document was rehearsed locally** against a disposable
`pgvector/pgvector:pg18` container on a non-default port, never against Render. The findings below
are the evidence; the procedure is what the local rehearsal implies for the real, Render-hosted
database. Anything that could not be checked locally is labelled **UNVERIFIED — check on Render**.

---

## 0. What the local rehearsal established

| # | Question | Result |
|---|---|---|
| 1 | Do all 74 migrations apply cleanly to a fresh PG18 database? | **Yes.** `prisma migrate deploy` against a fresh `pgvector/pgvector:pg18` (Postgres 18.4) database applied all 74 migrations with no errors. `_prisma_migrations` shows 74 rows, all `finished_at IS NOT NULL`, 0 unfinished. Resulting schema: 69 tables (68 + `_prisma_migrations`), matching the schema-audit baseline. |
| 2 | Are the 3 `vector(1024)` columns intact and functional? | **Yes.** `UserVessel.contentEmbedding`, `InnerWorkSession.contentEmbedding`, `SessionTakeaway.embedding` are all `vector(1024)` (confirmed via `information_schema.columns`). Inserted a 1024-dim vector into each, confirmed `vector_dims() = 1024`, ran a cosine self-distance (`<=>` → 0) and an L2 nearest-neighbor query (`<->` … `ORDER BY … LIMIT 1`) against `UserVessel`. Both work. |
| 3 | pgvector version, HNSW floor | **0.8.6** — same version as the local PG16 container and the schema-audit's documented environment. Well above the 0.5.0 floor. Confirmed empirically, not just by version number: `CREATE INDEX … USING hnsw ("contentEmbedding" vector_cosine_ops)` succeeded and was dropped cleanly. |
| 4 | PG17/18 behavioural incompatibilities | **None found that this schema or these migrations trigger.** See §5 below for the full reasoning — this app does not use text search, `md5()`/pgcrypto, triggers, rules, partitioned tables, views, `COPY`, or interval-`ago` literals anywhere in its 74 migrations or its `$queryRaw`/`$executeRaw` call sites. |
| 5 | `uuidv7()` | **Present and correct.** Generated concurrently, confirmed time-ordered (`ORDER BY id` matches insertion order for 5 rows spaced 10ms apart), confirmed unique across 10,000 generations, confirmed usable as `DEFAULT` on a `uuid PRIMARY KEY` column. |
| 6 | Does the app run against PG18? | **Yes, at the HTTP and row level.** The golden-query harness (`work-a39h.2`'s oracle) built its `FEEL_HEARD_B` fixture and ran both scenarios (`session-read`, `empathy-reveal`) against the PG18 container end-to-end through the real Express app. **Zero HTTP-body or row-snapshot diffs** against the PG16-recorded baseline. The only diffs were (a) one pre-existing, version-independent fixture nondeterminism (see §6.3) and (b) SQL-trace-only mismatches caused by a PG18 `EXPLAIN ANALYZE` output-format change that breaks the harness's own log parser — not an app behaviour change. Both are explained in full below. |

**Bottom line: nothing found locally blocks the upgrade.** The one real finding is that the
golden harness's SQL-trace parser (`backend/src/testing/golden/trace.ts`) needs a small fix before
it can be trusted as a trace-level oracle on PG18 — filed as follow-up, does not block this phase.

---

## 1. Pre-flight checks

Run these before touching Render. Each has a command and an expected result.

### 1.1 Confirm the local rehearsal is reproducible (optional, ~10 min)

If you want to re-verify before running the real thing:

```bash
podman run -d --name pg18-preflight \
  -e POSTGRES_USER=mwf_user -e POSTGRES_PASSWORD=mwf_password -e POSTGRES_DB=meet_without_fear \
  -p 5433:5432 -v pg18-preflight-data:/var/lib/postgresql \
  pgvector/pgvector:pg18
```

**Note the mount path**: `pgvector/pgvector:pg18` (Postgres 18+ images) store data under
`/var/lib/postgresql/<version>/…` and refuse to start against a volume mounted at the old
`/var/lib/postgresql/data` path used by the 16 image — mount the volume at `/var/lib/postgresql`
(no `/data` suffix), not the path from the PG16 setup instructions in `local-setup.md`.

```bash
cd backend
DATABASE_URL="postgresql://mwf_user:mwf_password@localhost:5433/meet_without_fear" \
DIRECT_URL="postgresql://mwf_user:mwf_password@localhost:5433/meet_without_fear" \
SHADOW_DATABASE_URL="postgresql://mwf_user:mwf_password@localhost:5433/meet_without_fear_shadow" \
  npx prisma migrate deploy
```

Expect: `All migrations have been successfully applied.` Tear down with
`podman rm -f pg18-preflight && podman volume rm pg18-preflight-data` when done.

### 1.2 Render plan tier supports in-place upgrade — **UNVERIFIED, check on Render**

Render's in-place major-version upgrade and its "Clone this database" test-copy feature both
require a **flexible Postgres plan with point-in-time recovery (PITR) enabled**. Legacy instance
types must be migrated to a flexible plan first, which is itself a separate, disruptive operation.

**Check**: open the database's Info page in the Render Dashboard. If it shows a PITR / recovery
window setting, you're on a flexible plan and can proceed. If not, stop here and plan the plan
migration as a separate, earlier step — do not discover this mid-upgrade.

### 1.3 Confirm current backup/PITR coverage — **UNVERIFIED, check on Render**

Render's automatic PITR retention is plan-dependent: **3 days on Hobby, 7 days on Pro or higher**.
Confirm which tier the production database is on, and confirm the Recovery page shows a live PITR
window before you start — this is your safety net if a problem surfaces *after* the upgrade
reports success (see §4, "no downgrade path").

Also take a manual logical backup immediately before the production upgrade
(`pg_dump` via the Render dashboard's "PSQL Command", or Render's own manual-backup feature) —
belt and suspenders, since manual/logical backups are retained independently of PITR.

### 1.4 Confirm pgvector is on Render's supported list for the target version — **UNVERIFIED, check on Render**

Render documents pgvector as supported for Postgres 13+ (manually enabled via
`CREATE EXTENSION vector;`) and pre-enabled by default only on the now-irrelevant 11/12. This
implies PG18 support, but Render's docs do not state which pgvector *version* ships for which
Postgres major version, and that may not match the 0.8.6 this rehearsal used (a community Docker
image, not Render's managed build). **Check on the clone** (§2, step 4) with:

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
```

If it reports something below 0.5.0, HNSW indexing (wanted in a later phase) is blocked on Render
specifically, regardless of what this rehearsal showed locally.

### 1.5 Confirm the app's DB role/privilege model on Render — **UNVERIFIED, check on Render**

The schema audit notes: *"On the local container `mwf_user` is a superuser with all privileges on
all 69 tables (a property of the local setup, not necessarily production — the Render role
configuration is unverified)."* This upgrade does not depend on the app's role being a superuser,
but confirm the app's DB role can still connect and has the same privileges after the upgrade —
Render states credentials and connection strings are unchanged, but this has not been observed
against this app's actual Render role.

### 1.6 Freeze deploys during the window

Confirm no other deploy is queued or auto-triggered during the maintenance window — a `prisma
migrate deploy` racing the Postgres upgrade is an unforced error. Render's auto-deploy is already
off for this service (per `docs/deployment/render-config.md`); just avoid manually triggering one.

---

## 2. Procedure — clone-first

This maps directly onto Render's own documented mechanism, which already matches the issue's
"clone → upgrade the clone → verify → then the real instance" shape (Render calls this "Clone this
database", not "fork" — there is no separate fork feature).

### Step 1 — Clone the production database

1. Render Dashboard → the production Postgres instance → Info page → click the current version
   number (`16`).
2. Select **"Clone this database"**.
3. Wait for the clone to finish replicating. **Render clones from ~10 minutes prior**, not
   instantaneously — the clone will be missing the last ~10 minutes of writes at clone time. That
   is expected and fine for this test; it is not the production cutover.

**Verify**: the clone appears as a new, separate Postgres instance in the dashboard, status
`Available`, still on Postgres 16.

### Step 2 — Upgrade the clone to PG18

1. On the **clone's** Info page, click its version number, then **"Upgrade to PostgreSQL 18"**.
2. Watch the log explorer. Expect this to complete in well under an hour (Render states "usually
   under one hour"; the local rehearsal's full `migrate deploy` against a fresh PG18 database took
   well under a minute, so the bulk of Render's hour budget is `pg_upgrade`'s own mechanics, not
   this schema being large).
3. Status changes `Upgrading` → `Available` on success.

**If it fails**: per Render's docs, the clone remains on its original version (16) and nothing is
lost — it's a throwaway clone. Read the log explorer output, retry, or escalate to Render support.
Nothing production-facing has been touched yet.

### Step 3 — Verify the clone

Connect to the clone (external connection string from its Info page) and run the same checks the
local rehearsal ran:

```sql
-- 1. Migration count and completeness
SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
-- expect 74

SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;
-- expect 0

-- 2. Table count
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
-- expect 69 (68 app tables + _prisma_migrations)

-- 3. pgvector present and versioned
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- expect extversion >= 0.5.0 -- see 1.4, this is the one genuinely unverified number

-- 4. The 3 vector columns still typed correctly
SELECT table_name, column_name FROM information_schema.columns WHERE udt_name = 'vector'
ORDER BY table_name;
-- expect exactly: InnerWorkSession.contentEmbedding, SessionTakeaway.embedding,
--                 UserVessel.contentEmbedding

-- 5. A real similarity query still works (pick a real row instead of inserting a fake one,
--    since this is a clone of real user data -- do not write test rows into it)
SELECT id FROM "UserVessel" WHERE "contentEmbedding" IS NOT NULL
ORDER BY "contentEmbedding" <-> (SELECT "contentEmbedding" FROM "UserVessel"
  WHERE "contentEmbedding" IS NOT NULL LIMIT 1) LIMIT 5;
-- expect 5 rows back, no error

-- 6. uuidv7 available (needed for the later phase, confirm now while cheap)
SELECT uuidv7();
-- expect a UUID back, no error
```

Then point a local checkout's `DATABASE_URL` at the clone's **external** connection string and run:

```bash
cd backend
npx prisma migrate deploy
```

**Expect**: `No pending migrations to apply.` — proves Prisma's own migration bookkeeping agrees
the clone is fully migrated, using the exact command Render's `startCommand` runs on every deploy.

Optionally, run the golden harness against the clone the same way the local rehearsal did (see
§6.3 for what will and won't come back clean):

```bash
GOLDEN_DATABASE_URL="<clone external URL>" npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
GOLDEN_DATABASE_URL="<clone external URL>" npm run test --workspace=backend -- golden
```

Expect the same shape of result the local rehearsal got: HTTP and row snapshots clean, SQL-trace
fields red for the reasons in §6.2 (a known harness gap, not a signal to chase here).

### Step 4 — Delete the clone

Once satisfied, delete the clone from the dashboard. Don't leave it running — it's a second full
copy of production user data.

### Step 5 — Upgrade production

This is the real thing. Repeat Step 2 against the **production** instance, not the clone:

1. Production database → Info page → current version (`16`) → **"Upgrade to PostgreSQL 18"**.
2. The database is **unavailable for the duration** (see §3 for the downtime estimate). The app
   will fail its `/health` check and any in-flight request will error during this window — there
   is no way to avoid this with Render's managed offering; it is not a rolling/zero-downtime
   upgrade.
3. Watch the log explorer to completion.

### Step 6 — Verify production

Run the exact same six checks from Step 3 against the **production** connection string. All six
must pass before you consider this done. Then:

```bash
curl -s https://<the render service URL>/health
```

Expect `{"status":"healthy", ...}`. This exercises the app's own `prisma.$queryRaw\`SELECT 1\`` —
the cheapest possible end-to-end proof that the running Node process, not just `psql`, can reach
the upgraded database.

Since `render.yaml`'s `startCommand` already runs `npx prisma migrate deploy` before starting the
server on every deploy, the next normal deploy will also re-confirm all 74 migrations report
applied — but don't wait for that as your verification; do the explicit checks above first.

---

## 3. Downtime window

- **The clone-and-verify stages (Steps 1–4) cause zero production downtime.** They operate
  entirely on a disposable copy.
- **Step 5 (the real upgrade) is the only downtime.** Render states the upgrade "usually takes
  less than one hour" and the database is fully unavailable for its duration — no read replica or
  partial-availability mode during the upgrade.
- Budget the maintenance window as: upgrade duration (≤ 1 hour, per Render) + verification (Step 6,
  ~10–15 minutes if done efficiently) + a buffer for a possible retry. **Call it a 90-minute
  window**, expecting the actual outage to be much shorter than that in the common case.
- Nothing in this schema (no huge tables, no partitioning, 69 tables with modest row counts per
  the schema audit) suggests this database is large enough to be at the pessimistic end of
  Render's estimate, but that has not been measured against the real production data volume —
  **UNVERIFIED, Render doesn't publish a size-to-duration formula**.

---

## 4. Rollback plan and point of no return

**Before Step 5 (clicking "Upgrade to PostgreSQL 18" on production): fully reversible.**
Nothing has been done to the production database. Abandon at any point with zero cleanup beyond
deleting the clone.

**During Step 5, if the upgrade fails partway**: per Render's documentation, the production
database "remains on its original PostgreSQL version" on failure — Render's own upgrade mechanism
is designed to fail closed. Read the log explorer, retry, or contact Render support.

**The point of no return is a successful Step 5.** Render's documentation describes no downgrade
path from a *completed* upgrade — there is no "revert to 16" button once the database reports
`Available` on 18. If a problem is discovered only after the upgrade has succeeded and the app has
been running against PG18 for a while, the only path back is:

1. **Point-in-time recovery** to a moment before the upgrade, using the PITR window confirmed in
   §1.3 (3 or 7 days, by plan). This creates a **new** database instance on PG16 at that past
   state — it does not revert the existing instance in place. You would then need to re-point the
   app's `DATABASE_URL` at the recovered instance, which is itself a config change and its own
   small outage, and you lose every write made between the upgrade and the recovery.
2. Or the manual logical backup taken in §1.3, restored via `pg_restore`/`psql` into a fresh PG16
   instance — same re-pointing caveat, and only as current as when it was taken.

**Practical consequence**: verify hard in Step 6 before considering this done, and don't delete the
pre-upgrade manual backup for at least as long as the PITR window would otherwise cover, in case
PITR itself is ever in question.

---

## 5. PG17 / PG18 behavioural changes checked against this schema

Checked the official release notes' "Migration to Version 17" and "Migration to Version 18"
incompatibility lists against grep of all 74 migration files and every `$queryRaw`/`$executeRaw`
call site in `backend/src`. Only the following are worth recording as **applicable** — everything
else in the release notes (partitioned-table `VACUUM`/`ANALYZE` defaults, `AFTER` trigger role
context, rule privileges, `pg_stat_*` column renames, `pgrowlocks` labels, safe search_path for
expression indexes, unlogged partitioned tables, interval `ago` restrictions, `COPY … \.` handling)
was checked and does **not** apply, because this schema has none of: text search columns,
`md5()`/pgcrypto calls, triggers, rules, partitioned tables, views/materialized views, `COPY`
statements, or `interval` literals using `ago` — all confirmed by grep, not assumption, and cross-
checked against the schema audit's own finding of **zero** triggers, views, and stored procedures.

| Change | Version | Applicability here |
|---|---|---|
| MD5 password authentication deprecated (warns on `CREATE ROLE`/`ALTER ROLE` with MD5 passwords; not yet removed) | PG18 | Not triggered by anything in this app's SQL — no `md5()` calls exist. **But** if the Postgres *role itself* authenticates via MD5 (a `pg_hba.conf`/role-password setting, not app code), Render's PG18 instance may start emitting deprecation warnings in its logs. **UNVERIFIED — check Render's auth method for the app's DB role after the upgrade**; this is cosmetic (a warning, not a break) at PG18 but worth knowing about before it becomes a removal in a future major version. |
| Full-text search now uses the cluster's default collation provider instead of always libc; Postgres recommends reindexing FTS/`pg_trgm` indexes after a `pg_upgrade` | PG18 | **Not applicable.** Grepped all 74 migrations and all `$queryRaw` sites for `tsvector`/`tsquery`/`to_tsvector`/`to_tsquery`: zero matches. This app has no text-search columns or indexes. |
| Session time zone abbreviations checked before `timezone_abbreviations` server variable (previously the other order) | PG18 | **Not applicable as used.** The only `AT TIME ZONE` usage in the codebase is `now() AT TIME ZONE 'UTC'` (in the golden harness's fixture-rebasing SQL) — `'UTC'` is a full zone name, not an abbreviation, so the lookup-order change doesn't affect it. |
| `timestamp without time zone` handling | — | No server-side parsing behaviour changed between 16 and 18 for naive timestamps as such. The schema's real timestamp risk is unrelated to the PG version: all 144 non-`_prisma_migrations` timestamp columns are `timestamp without time zone`, and `node-postgres` (the driver) parses that OID using the **process** time zone rather than assuming UTC — already known and already handled in application/test code by doing timestamp arithmetic in SQL against `now() AT TIME ZONE 'UTC'` rather than in JavaScript. That mitigation is unaffected by moving to PG18. |
| Extension packaging / `CREATE EXTENSION` behaviour | — | No incompatibility found in the release notes for `CREATE EXTENSION IF NOT EXISTS "vector"` (the only extension statement in the 74 migrations). Confirmed empirically: it applies cleanly on a fresh PG18 database, and `pgvector/pgvector:pg18` ships pgvector 0.8.6, matching the local PG16 environment's version. Render's specific packaging is the one thing still to confirm — see §1.4. |
| Default privileges | — | The schema audit already establishes there are zero `GRANT`/`REVOKE`/`CREATE ROLE`/`ALTER DEFAULT PRIVILEGES` statements anywhere in the 74-migration history (the only mentions are commented-out example SQL inside the reverted RLS migration). Nothing here depends on default-privilege behaviour, so nothing to check for a version-to-version change. |
| `EXPLAIN ANALYZE` output format (actual row counts now rendered with two decimal places, e.g. `rows=6.00` instead of `rows=6`; a `Planning: Buffers:` block now appears by default) | PG18 | **Applicable to the golden test harness, not the app.** Confirmed by direct comparison: `EXPLAIN ANALYZE SELECT 1` on the local PG16 container prints `rows=1 loops=1`; the identical command on PG18 prints `rows=1.00 loops=1` plus an added `Planning: Buffers: shared hit=3` block. This is a genuine, confirmed PG18 output-format change, and it breaks `backend/src/testing/golden/trace.ts`'s row-count regex (`ACTUAL_RE = /\(actual (?:time=[\d.]+\.\.[\d.]+ )?rows=(\d+) loops=(\d+)\)/` — `\d+` does not match `6.00`), which is exactly why the golden harness's SQL-trace assertions came back red while its HTTP and row-level assertions stayed clean. See §6.2. This affects the migration-oracle tooling for `work-a39h`, not production behaviour, and is filed as follow-up work rather than blocking this phase. |

---

## 6. Evidence detail — golden harness run against PG18

Full context for the "6" row in the summary table.

### 6.1 Setup

Built the `FEEL_HEARD_B` fixture and ran both existing golden scenarios (`session-read`,
`empathy-reveal`) against the local PG18 rehearsal container via
`GOLDEN_DATABASE_URL`/`DATABASE_URL`, with `MWF_PG_CONTAINER` pointed at the PG18 container name so
the SQL-trace capture's `podman logs` reader targeted the right container (the harness defaults to
`mwf-postgres`, i.e. the PG16 dev container, via `driver.ts`'s
`process.env.MWF_PG_CONTAINER ?? 'mwf-postgres'`). Confirmed `mwf_user` is a superuser on the PG18
container too (required for `log_statement`/`session_preload_libraries`), and that
`auto_explain.so` ships in the `pgvector/pgvector:pg18` image. Fixture build succeeded first try:
2 users, 1 session, 68-table schema, 13 populated tables.

### 6.2 What the trace capture actually did, and why it went red

The SQL-trace machinery **worked** against the PG18 container — `podman logs` returned real
statement/plan output, sentinel markers were found, transactions were grouped correctly. The
failure is narrower than "trace capture doesn't work on PG18": raw log inspection
(`EXPLAIN ANALYZE SELECT 1` on both containers, side by side) showed PG18 now renders actual row
counts as `rows=6.00` instead of `rows=6`, and the harness's row-count regex only matches integer
digits. Every `rowsRead` value the parser extracted therefore came back `0` or `undefined`, which
cascades into `topRows`, transaction-shape grouping, and some `planNodes` mismatches in the diff
output. **Both golden test suites' non-trace assertions — the HTTP response bodies and the
PK-ordered row snapshots — were byte-identical to the PG16-recorded baseline; every red assertion
in both runs was under a `.trace.` path**, except for one `clerkId` field (next section). This is a
harness bug, not a signal about the app or PG18's query correctness, and it's a one-line regex fix
(`\d+` → `\d+(?:\.\d+)?`) — filed as follow-up, not attempted here since it's out of scope for this
phase and touches shared harness code another workstream (`work-a39h.2`) owns.

### 6.3 The one non-trace diff: `clerkId`, and why it isn't a PG18 issue

`empathy-reveal`'s diff showed one non-trace field: `steps[0].changes[1].before.clerkId` (and its
`changesAtResponse` echo) didn't match the recorded baseline. Traced this to
`backend/src/testing/state-factory.ts`, which mints a fresh
`` `e2e_${Date.now()}_${Math.random()...}` `` clerkId for fixture users at **fixture-build time**,
and — per `normalize.ts`'s own comments — this field is deliberately left as a raw literal
comparison rather than resolved to a structural label. Rebuilding the fixture (which this rehearsal
had to do, since it needed its own PG18 database) mints a new random value every time, independent
of which Postgres version it's built against. This would mismatch the recorded golden on a fresh
`cli.ts build` run against PG16 too, for the same reason — **not verified by actually running it
against PG16** (deliberately did not touch `mwf-postgres` beyond read-only queries, per this
rehearsal's constraints), but the mechanism is deterministic enough from reading the code that this
is a pre-existing fixture-build nondeterminism, unrelated to the PG16→18 change.

### 6.4 What wasn't run

The harness's own documented gaps (see `backend/src/testing/golden/README.md`, "Known gaps") apply
identically here — this rehearsal didn't newly exercise negative-authorization paths, out-of-scope
write detection outside `empathy-reveal`, or anything the harness doesn't already cover on PG16.
Nothing PG18-specific was skipped: both existing scenarios ran to completion, and the "row/HTTP
channels alone still prove the app runs" fallback held — they weren't needed as a fallback, since
only the trace layer failed.

---

## 7. What this runbook does not cover

- **Phase 2/3 work** (`work-a39h.2`, `work-a39h.3` — the golden-query harness becoming the full
  migration oracle, and the hand-written-DDL rebuild) is out of scope here. This upgrade only gets
  Render onto PG18 so that work has `uuidv7()` available; it does not add HNSW indexes, does not
  touch the RLS/security model, and does not change any table.
- **HNSW indexes** are not created by this runbook, even though pgvector supports them. The schema
  audit and this rehearsal both confirm the pgvector version supports them (≥ 0.5.0), but adding
  them is explicitly a later phase's work.
- Everything marked **UNVERIFIED — check on Render** above (§1.2–1.5, the MD5-auth row in §5, and
  the production data-volume-to-downtime estimate in §3) needs a human with Render dashboard access
  to close out; none of it was possible to check from this machine, which deliberately has no
  Render credentials.
