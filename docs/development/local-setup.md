---
title: Local Development Setup
sidebar_position: 1
description: Verified steps to run the stack locally on macOS, including the gaps in the root README.
created: 2026-08-12
status: living
---

# Local Development Setup

Verified end-to-end on macOS (Apple Silicon) on 2026-08-12. Every command below was run and
its result observed; where the root `README.md` is wrong or incomplete, that is called out.

## 1. Node 20

The repo pins `"engines": { "node": "20.x" }`. Homebrew's default `node` is currently 26.x, and
Expo 54 / RN 0.81 / Metro do not behave on it. Use a version manager:

```bash
brew install fnm
# add to ~/.zshrc:
#   eval "$(fnm env --use-on-cd --shell zsh)"
fnm install 20
```

A `.node-version` file at the repo root pins the version, so `--use-on-cd` switches automatically
when you `cd` in. Confirm `node -v` reports `v20.x` **before** running `npm install` — installing
under a different major bakes the wrong engine artifacts into `node_modules`.

## 2. PostgreSQL 16 + pgvector

**pgvector is mandatory.** Three models use `vector(1024)` columns, and migration
`20251228220702` runs `CREATE EXTENSION "vector"`. A vanilla Postgres will fail to migrate.

Note the schema does *not* declare the extension — `datasource db` has `// extensions = [vector]`
commented out in `backend/prisma/schema.prisma`. It is created by raw SQL in that migration only.
`prisma migrate diff` will therefore always report the `vector` and `plpgsql` extensions as a
difference. That is expected and is not schema drift.

### Container (recommended — matches production)

```bash
podman machine start          # or use Docker
podman run -d --name mwf-postgres \
  -e POSTGRES_USER=mwf_user \
  -e POSTGRES_PASSWORD=mwf_password \
  -e POSTGRES_DB=meet_without_fear \
  -p 5432:5432 \
  -v mwf-pgdata:/var/lib/postgresql/data \
  --restart unless-stopped \
  pgvector/pgvector:pg16

podman exec mwf-postgres psql -U mwf_user -d meet_without_fear \
  -c "CREATE DATABASE meet_without_fear_shadow OWNER mwf_user;" \
  -c "CREATE DATABASE meet_without_fear_test OWNER mwf_user;"
```

Three databases are required: the main one, `_shadow` (Prisma's shadow DB for `migrate dev`), and
`_test` (the E2E harness). Using exactly these names and credentials means the `DATABASE_URL`s
already committed in `backend/.env.example` and `e2e/.env.test` work unchanged.

Day-to-day: `podman machine start && podman start mwf-postgres`.

### The golden harness changes one server-wide setting

The SQL-trace oracle in `backend/src/testing/golden` reads Postgres's own statement log, so it needs
the log lines to carry the database, application, virtual xid and xid. `log_line_prefix` is
`PGC_SIGHUP` — it cannot be set per-database — so the harness sets it once, server-wide:

```
log_line_prefix = '%m [%p] db=%d,app=%a,vxid=%v,xid=%x '
```

It does this with `ALTER SYSTEM` + `pg_reload_conf()`, which writes to
`/var/lib/postgresql/data/postgresql.auto.conf` inside the container and therefore **persists across
container restarts**. It is idempotent and is deliberately **not** restored afterwards: restoring it
per run races other test workers, and one worker's restore landing mid-run turns another's trace into
a silently empty window. It is a formatting-only change to a development container.

To put it back:

```bash
podman exec mwf-postgres psql -U mwf_user -d postgres \
  -c "ALTER SYSTEM RESET log_line_prefix;" -c "SELECT pg_reload_conf();"
```

Everything else the oracle needs — `log_statement`, `auto_explain` via `session_preload_libraries`,
`plan_cache_mode`, and the two `log_parameter_max_length` settings — is set per-database on the
disposable `mwf_run_*` clone and vanishes with `DROP DATABASE`. All of it requires a superuser;
`mwf_user` is one in this container, and the harness fails with an explicit message rather than a
confusing error if it is not.

#### The captured statement log contains real identifiers, and it persists

**`log_parameter_max_length=0` and `auto_explain.log_parameter_max_length=0` do not keep bind values
out of the log.** They suppress the two *parameter list* channels — `DETAIL: parameters:` and
`Query Parameters:` — and nothing else. PostgreSQL still inlines bind values into plan predicates:

```
Index Cond: (id = 'cmsqt19i200079kbfuv75bxh8'::text)
```

Measured on one hour of golden-suite runs: 3,645 such lines. These are ids rather than message
bodies, but they are real identifiers from a real database, so treat the capture as sensitive.

`plan_cache_mode='force_custom_plan'`, which the harness sets so plan shape is deterministic, is what
makes this *universal*: a custom plan is built against the actual parameter values every time, so
every predicate is inlined. Anyone revisiting that setting is also revisiting this, in both
directions — turning it off reduces inlining but reintroduces the plan-shape nondeterminism it was
added to remove.

The log lives in the podman VM's journal, not in the container, and **it is not purged when the run
database is dropped or when the container restarts**. Measured: 305 MB of journal holding 70,889
statement lines across two days of development.

To inspect or purge it:

```bash
podman machine ssh 'journalctl --disk-usage'
podman machine ssh 'sudo journalctl --rotate && sudo journalctl --vacuum-time=1s'   # purge everything
```

The golden artefacts themselves are clean by construction — a recorded trace has no text-shaped
field at all, only kinds, relation names, counts and plan node types — so nothing here reaches
`__golden__/*.json`. This is about the raw journal on the development machine.

### Alternative: devenv (what the README assumes)

`devenv up -d` provisions the same three databases plus pgvector via Nix. Costs a multi-GB Nix
install. Note `devenv.nix` also provisions an unrelated `peter_app` / `lovely_mind_user` database —
a leftover from an earlier codebase, safe to ignore.

**Not recommended:** Homebrew `postgresql@16` + `brew install pgvector`. The pgvector formula builds
against the *default* postgresql formula (18), so the extension lands in the wrong lib directory.

## 3. Install and migrate

```bash
npm install                       # workspaces; ~3400 packages
cp backend/.env.example backend/.env   # then fill in, see below
npm run prisma -- generate
cd backend && npx prisma migrate deploy    # 74 migrations
```

Also migrate the test database, which the E2E harness uses:

```bash
DATABASE_URL="postgresql://mwf_user:mwf_password@127.0.0.1:5432/meet_without_fear_test" \
  npx prisma migrate deploy
```

### Gaps in the README's env list

`README.md` documents `DATABASE_URL`, Clerk, Ably and Resend but **omits the AWS Bedrock
credentials** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`), which every AI path
needs. `backend/.env.example` also lists `OPENAI_API_KEY` under an "AWS Bedrock" heading — that key
is real but belongs to the `/tts` endpoint, not Bedrock.

**You do not need any third-party credentials to get a working test bed.** The E2E harness runs the
whole stack against fixtures with `E2E_AUTH_BYPASS=true` and `MOCK_LLM=true`. Credentials are only
required to exercise live auth, realtime and AI.

## 4. Baseline — what passes today

Observed 2026-08-12 on a clean install:

| Command | Result |
|---|---|
| `npm run check` | pass — all 6 workspaces |
| `npm run test --workspace=backend` | pass — 81 suites, 1556 tests, ~32s |
| `npm run test --workspace=shared` | pass — 14 suites, 318 tests, ~4s |
| `npm run test --workspace=mobile` | **pass — 71 suites, 1030 tests, ~6s** |

The mobile result contradicts the comment in `.github/workflows/ci.yml`, which says the mobile
suite is "all 42 suites red on main" and excludes it from CI. That comment dates from
`1b418a7a` (2026-04-15) and is stale — the suite passes. CI has been skipping a green suite, so
mobile has had no test gate for months. (One caveat: the run reports "A worker process has failed
to exit gracefully", a teardown leak worth cleaning up.)

Two npm scripts in `backend/package.json` reference files that do not exist and will always fail:
`seed` (`src/seed.ts`) and `db:query` (`src/scripts/db-query.ts`).

## 5. Running the app

```bash
npm run dev:api        # backend  :3000
npm run dev:website    # Next.js  :3001
npm run dev:mobile     # Expo     :8081
```

### Landmines

1. **An unset API URL silently points the app at PRODUCTION.** `mobile/app.config.js` defaults
   `EXPO_PUBLIC_API_URL` to `https://api.meetwithoutfear.com`, and `mobile/src/lib/api.ts` reads
   `Constants.expoConfig.extra.apiUrl` first. Always set it explicitly for local work.
2. **`npm start` rewrites `mobile/.env` every time.** `mobile/package.json` runs `set-local-ip`
   before `expo start`; it shells out to `ipconfig getifaddr` (macOS-only) and unconditionally
   overwrites `EXPO_PUBLIC_API_URL` with your LAN IP.
3. **Expo Go will not work**, despite the README. `expo-dev-client`, `expo-secure-store`,
   `expo-local-authentication`, `expo-notifications`, `@sentry/react-native`,
   `mixpanel-react-native` and `expo-updates` need a dev client build — use the
   `development-simulator` EAS profile.
4. There is no `mobile/.env.example`; an empty Clerk key fails at runtime with no useful message.

## 6. Running the app interactively with NO third-party credentials

Verified working 2026-08-12. This is the fastest way to explore the product and its data.

```bash
# Terminal 1 — API. E2E_FIXTURE_ID is REQUIRED, see the gotcha below.
E2E_AUTH_BYPASS=true MOCK_LLM=true E2E_FIXTURE_ID=user-a-full-journey \
  npm run dev:api

# Terminal 2 — web client. Clerk is swapped for a mock module at bundle time.
cd mobile && EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL=http://localhost:3000 \
  npx expo start --web --port 8082
```

Seed a fully populated two-user session at any stage:

```bash
curl -s -X POST http://localhost:3000/api/v1/e2e/seed-session \
  -H 'Content-Type: application/json' \
  -d '{"userA":{"email":"ada@e2e.test","name":"Ada Lovelace"},
       "userB":{"email":"bob@e2e.test","name":"Bob Ross"},
       "targetStage":"NEED_MAPPING_COMPLETE"}'
```

Emails **must** end in `@e2e.test`. The response includes per-user `pageUrls` carrying
`?e2e-user-id=...&e2e-user-email=...`; `E2EAuthProvider` reads those and injects the
`x-e2e-user-id` header, so no login is needed. Change the port in those URLs from 8081 to 8082.
Open the two URLs in separate browser profiles to drive both sides of a session.

`TargetStage` (`backend/src/testing/state-factory.ts:24`) offers 13 states: `CREATED`,
`INVITATION_READY`, `EMPATHY_SHARED_A`, `FEEL_HEARD_B`, `RECONCILER_SHOWN_B`, `CONTEXT_SHARED_B`,
`EMPATHY_REVEALED`, `NEED_MAPPING_COMPLETE`, `STRATEGIC_REPAIR_COMPLETE`, and four
`STAGE4_REDESIGN_*` variants. Seeding `NEED_MAPPING_COMPLETE` populates 14 tables.

Browse the data with `cd backend && npx prisma studio`.

### Gotcha: `MOCK_LLM=true` alone breaks message sending

Without `E2E_FIXTURE_ID`, `getModelCompletion` returns empty, `resolveStreamTurn` throws
"AI response was empty after tag stripping" (`stream-turn-resolution.ts:222`), the stream aborts,
**the user's message is deleted**, and the UI shows only "Message not sent. Failed to send message."
Nothing in that message points at the missing fixture. Valid IDs are `user-a-full-journey` and
`user-b-partner-journey` (`backend/src/lib/e2e-fixtures.ts`).

### What does NOT work without credentials

| Needs | What breaks without it |
|---|---|
| `ABLY_API_KEY` | **All realtime.** The mock token uses app id `mock-key-na`, so Ably returns 404 and the client sits `disconnected`. Partner presence shows "offline" and no live cross-user updates arrive. Free tier is enough. |
| AWS Bedrock creds | Real AI. Fixture replies are a fixed script, not contextual — you cannot evaluate prompt behaviour locally. |
| `CLERK_SECRET_KEY` | The real login flow. Note an unauthenticated call returns **500** ("Authentication not configured", `auth.ts:143-153`) rather than 401 when the key is absent. |
| `RESEND_API_KEY` | Email invitations. |

**Realtime is the credential worth getting first.** Without it you cannot observe two users
affecting each other live, which is where most of this product's interesting behaviour lives.

## 7. E2E

```bash
cd e2e
npx playwright install chromium     # first run only
npm run e2e                         # default hermetic suite
npx playwright test --config=playwright.two-browser.config.ts   # two-user flows
```

The default config is hermetic: it starts its own API with `MOCK_LLM=true` and `E2E_AUTH_BYPASS=true`,
truncates 46 tables in `globalSetup`, and serves a production-mode Expo web bundle on :8082. No real
LLM calls, no cost.

**Do not casually run `playwright.live-ai.config.ts`** — it sets `MOCK_LLM: 'false'`, makes real
Bedrock calls, and allows 30 minutes per test.

`DIAGNOSIS_FINDINGS.txt` at the repo root documents E2E failures whose stated root cause
(`globalSetup` commented out) is already fixed. It is a stale artifact.
