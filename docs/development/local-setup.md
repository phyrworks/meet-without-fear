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

## 6. E2E

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
