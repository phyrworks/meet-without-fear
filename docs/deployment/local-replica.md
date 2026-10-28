---
title: Local production replica
sidebar_position: 3
description: The production stack (API image, Postgres 18, Caddy) on a Mac under podman, with mocked AI and the E2E auth bypass, for end-to-end tests and cutover smoke rehearsals.
created: 2026-10-28
updated: 2026-10-28
status: living
---
# Local production replica

`infra/local/` runs the production stack on one Mac: the image built by `infra/aws/Dockerfile`,
PostgreSQL 18 + pgvector initialised by `infra/aws/init-db.sh`, and Caddy. AI is mocked
(`MOCK_LLM=true`) and Clerk is replaced by the E2E auth bypass (`E2E_AUTH_BYPASS=true`). It exists
so the E2E suite can run against a production build while the AWS host is out of reach, and so the
cutover smoke (schema-migration plan §6 step 7) can be rehearsed locally.

> **Status, 2026-10-28: blocked on phoenix/target-shape.** The image does not build (work-6dht:
> `backend/src/testing/fixture-scenarios/current-shape.ts` does not type-check against the target
> client), and production's `infra/aws/healthcheck.cjs` cannot load the Prisma 7 client, so the
> API container never becomes healthy (work-bg5h). The scripts below are complete; `up.sh` stops
> at whichever of the two it reaches first.

## Commands

```bash
infra/local/up.sh          # build, migrate, start; safe to re-run (a no-op when nothing changed)
infra/local/status.sh      # containers, ports, health, _prisma_migrations, database owner
infra/local/down.sh        # stop and remove containers and networks; keeps the database volume
infra/local/reset.sh --yes # down, drop volume mwf_local_postgres, up (fresh baseline)
```

`up.sh` steps:

1. Generates `infra/local/.local/` (git-ignored, mode 700) once: random development passwords,
   `database.env` (the keys of production's `/etc/mwf/database.env`) and `application.env`.
2. Builds the image from the working tree: the files `git ls-files -co --exclude-standard` reports
   under `package.json`, `package-lock.json`, `backend/`, `shared/`, `infra/aws/` are copied to a
   context directory (no `.env`, no `node_modules`), and tagged `mwf-local-api:<content hash>`.
   An unchanged tree reuses the image. `MWF_LOCAL_APP_IMAGE=<image>` runs an existing image instead.
3. Exports the mobile app for web (`expo export --platform web`) with `EXPO_PUBLIC_E2E_MODE=true`
   and `EXPO_PUBLIC_API_URL=http://127.0.0.1:18180`; skipped when the inputs are unchanged.
4. Starts `db`; `init-db.sh` creates the roles on a fresh volume.
5. Migrates the way `deploy.sh` does — `stop api`, then a one-off `api` container runs
   `prisma migrate deploy` — but only when the image changed, the API is not healthy, or a
   migration is pending. Production has no local backup step.
6. Starts `api`, waits for its healthcheck (`infra/aws/healthcheck.cjs`, unchanged), then `caddy`,
   and checks `/health` and `/` through the origin.

## Ports and names

| What | Where |
|---|---|
| Web app + API (one origin) | `http://127.0.0.1:18180` (`MWF_LOCAL_PORT`) — `/api/*`, `/health`, `/realtime` go to the API, everything else is the web export |
| PostgreSQL (admin) | `127.0.0.1:15433` (`MWF_LOCAL_DB_PORT`), database `mwf`, superuser `postgres`; passwords in `infra/local/.local/secrets.env` |
| Compose project | `mwf-local` (production's is `mwf`) |
| Volumes | `mwf_local_postgres`, `mwf_local_caddy_data`, `mwf_local_caddy_config` |
| Networks | `mwf-local_edge` (172.30.77.0/24; production uses 172.29.0.0/24), `mwf-local_database` (internal), `mwf-local_admin` |

Every published port binds `127.0.0.1`. **Keep it that way:** with the auth bypass on, anyone who
can reach the API can act as any user by sending `x-e2e-user-id`. The replica never touches the
development container `mwf-postgres` or its databases.

## How it differs from production

| | Production (`infra/aws`) | Replica (`infra/local`) |
|---|---|---|
| `NODE_ENV` | `production` | `e2e` (see below) |
| `E2E_AUTH_BYPASS` / `MOCK_LLM` | forced `false` in `compose.yaml` | `true` |
| Caddy | TLS for `api.meetwithoutfear.com` on 80/443, plus loopback `:8080` | loopback `:8080` only, also serving the web export |
| Image architecture | linux/amd64 (CI) | the Mac's native arm64 |
| Database URLs | `DATABASE_URL` = `mwf_app` | the same; plus `APP_`/`JOB_`/`OPS_`/`AUTH_DATABASE_URL` for `mwf_app`/`mwf_job`/`mwf_ops`/`mwf_auth` and `DB_IDENTITY_BINDING=on` (the target-shape settings) |
| Migrations | `mwf_app` (database owner) via `deploy.sh`, after a backup | `mwf_app`, no backup |
| Ably | real `ABLY_API_KEY` | none by default: `/api/auth/ably-token` returns a mock token request, so the browser's Ably client never connects and realtime partner updates do not arrive; set `MWF_LOCAL_ABLY_API_KEY` before `up.sh` to use a real key |
| Clerk, Bedrock, Resend, Sentry, field encryption | configured | not configured |
| Log driver | `local`, 10 MB × 3 | podman default |

Migrations run as `mwf_app` because that is what production does today. Moving them to
`mwf_migrator` is work-a39h.11.19: the baseline grants `mwf_app` only views and `EXECUTE`
("mwf_app's table privileges are unchanged: it owns the tables"), so a database owned by
`mwf_migrator` needs the W1a table grants first.

### Every place `NODE_ENV` changes behaviour (backend/src)

With `NODE_ENV=e2e` (anything but `production`, and not `development` or `test`):

| Where | Production | Replica |
|---|---|---|
| `app.ts:40`, `middleware/auth.ts:93`, `middleware/rate-limit.ts` (×5), `controllers/session-state.ts:58` | bypass and rate-limit skips refused | bypass headers accepted, rate limits skipped, CORS allows any header (all also need `E2E_AUTH_BYPASS=true`) |
| `server.ts:66` | refuses to start with the bypass on | — |
| `routes/index.ts:39` | `/api/e2e/*` not mounted | mounted (`cleanup`, `seed`, `seed-session`, `seed-inner-thoughts`, `trigger-reconciler`) |
| `server.ts:80` | warns when `FIELD_ENCRYPTION_KEY` is unset (fails with `REQUIRE_FIELD_ENCRYPTION=true`) | silent |
| `utils/field-encryption.ts:58` | `REQUIRE_FIELD_ENCRYPTION` enforced | not enforced |
| `controllers/auth.ts:197,278` | no Ably key → 400; Ably failure → error | mock token |
| `routes/brain.ts:51` | dashboard without auth config → 403 | allowed |
| `middleware/errors.ts:194` | 500 bodies say "An unexpected error occurred" | the scrubbed error message |
| `lib/logger.ts:18` | JSON logs | pretty logs |
| `lib/bedrock.ts:89,144` | prompt logging never | only with `ENABLE_PROMPT_LOGGING=true` (unset) |
| `lib/prisma.ts:50` | — | client cached on `globalThis` (no effect in one process) |
| `server.ts:24` | Sentry environment `production` | `e2e` (Sentry is off: no DSN) |
| `utils/urls.ts:26`, `lib/prisma.ts:35`, `middleware/errors.ts:123`, `middleware/auth.ts:76` | check `development`/`test` only | same as production |

`GOLDEN_SHAPE=target` is also set: the E2E seeder detects the schema shape from a path that does
not exist in the built image (work-e4yn), and this is its documented override.

## Troubleshooting

- **`image build failed`** — read `infra/local/.local/build.log`. On 666257bf this is work-6dht.
- **`API readiness failed (healthcheck.cjs)`** while `curl http://127.0.0.1:18180/health` works —
  work-bg5h; `podman exec mwf-local-api-1 node /app/infra/aws/healthcheck.cjs; echo $?` shows it.
- **`migrate deploy failed`** — the API is left stopped, as `deploy.sh` leaves it;
  `infra/local/.local/migrate.log` has Prisma's output. A database that is not empty and not on
  the baseline is refused by the baseline's preamble; `reset.sh --yes` starts over.
- **Port in use** — `MWF_LOCAL_PORT=... MWF_LOCAL_DB_PORT=... infra/local/up.sh`; the web export
  is rebuilt because the origin changed.
- **Podman** — `podman machine start`; the VM has 4 GiB and the stack's limits total 1.6 GiB
  (db 650 MiB, api 850 MiB, caddy 128 MiB), the production values.
- **Psql** — `podman exec -it mwf-local-db-1 psql -U postgres -d mwf`.
