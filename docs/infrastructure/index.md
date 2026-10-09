---
title: Infrastructure
sidebar_position: 1
description: Slam bot (EC2), AWS Lightsail hosting, Vercel deploys, GitHub automation.
created: 2026-03-11
updated: 2026-05-30
status: living
---

# Infrastructure

Operational infrastructure for Meet Without Fear.

## Slam Bot (autonomous agent on EC2)

- Runs on a t3.medium EC2 instance in us-west-2, tagged `slam-bot`.
- **Display name**: "Slam Paws" (in Slack and GitHub). System paths (`/opt/slam-bot/`) retain the original name for backward compatibility.
- GitHub identity: `slam-paws` (collaborator on `shantamg/meet-without-fear` with write access).
- Scripts at `/opt/slam-bot/scripts` (symlink to `~/meet-without-fear/scripts/ec2-bot/scripts` on the box).
- Workspaces at `~/meet-without-fear/bot-workspaces/` with a router (`CLAUDE.md`) + label registry (`label-registry.json`).
- Logs at `/var/log/slam-bot/`. Rotated daily via `logrotate`: 7-day retention, compressed, with a 10MB per-file `maxsize` cap. `prune-journal.sh` (daily 04:00) and `prune-claude-projects.sh` (daily 04:05) clean older state.

### Bot harness layout

Slam Paws keeps the public script names used by cron, systemd, Slack Socket Mode, GitHub notification polling, and manual SSH operation, but the core bot harness now lives in Python under `scripts/ec2-bot/scripts/lib/bot_harness/`.

| Public script | Python entrypoint | Role |
|---|---|---|
| `run-claude.sh` | `python3 -m bot_harness run` | Compatibility runner for both Claude and Codex providers |
| `process-queue.sh` | `python3 -m bot_harness queue` | Priority FIFO queue draining, retries, TTL, stale-label checks, Slack reactions |
| `workspace-dispatcher.sh` | `python3 -m bot_harness dispatch` | Label and scheduled workspace dispatch, claims, cooldowns, state-file fallback |
| `check-github.sh` | `python3 -m bot_harness github-check` | GitHub notifications, mentions, review requests, and claim dedupe |

The shell files remain as thin shims so existing crontab, systemd, Socket Mode, and operator commands do not need to change.

Provider selection is resolved in this order: explicit `--provider`, `PROVIDER` env, `bot-workspaces/label-registry.json` `provider`, then default `claude`. Registry entries may also set `fallback_provider` and `review_provider`; labels that omit these fields keep the previous Claude behavior. Supported provider values are `claude` and `codex`.

Codex dispatches get runtime context through a generated per-agent `AGENTS.md` in the `_active/agent-<pid>/` directory. The generated file is assembled from Meet Without Fear repo and workspace instructions (`CLAUDE.md`, workspace `CONTEXT.md`, and stage `CONTEXT.md`) so there is no separate hand-maintained Codex prompt copy. Codex Slack replies are posted by the harness from the final `agent_message` event. Claude DM replies are posted only when the CLI did not already post one, which prevents duplicate Slack responses.

Provider session state is stored under `/opt/slam-bot/state/`. Codex session keys map to Codex thread IDs in `codex-session-map.json`; Claude session keys still use deterministic UUIDs for compatibility with the existing Claude session files.

Local validation for bot harness changes:

```bash
jq empty bot-workspaces/label-registry.json
python3 -m py_compile scripts/ec2-bot/scripts/lib/invoke_provider.py scripts/ec2-bot/scripts/lib/bot_harness/*.py
bash -n scripts/ec2-bot/scripts/run-claude.sh scripts/ec2-bot/scripts/process-queue.sh scripts/ec2-bot/scripts/workspace-dispatcher.sh scripts/ec2-bot/scripts/check-github.sh
PYTHONPATH=scripts/ec2-bot/scripts/lib python3 -m unittest scripts/ec2-bot/scripts/tests/test_bot_harness.py scripts/ec2-bot/scripts/tests/test_invoke_provider.py
```

Rollback is intentionally simple: revert the bot harness commit and let `git-pull.sh` auto-pull `main`, or manually `ssh slam-bot 'cd ~/meet-without-fear && git pull --ff-only && sudo systemctl restart slam-bot-socket slam-bot-state-scanner'`. The public script names and `/opt/slam-bot/scripts` symlink are stable across the migration.

### systemd services

| Service | Purpose |
|---|---|
| `slam-bot-socket.service` | Socket Mode listener for real-time Slack events. Routes incoming messages by channel: DMs and `#slam-paws`/`#agentic-devs`/`#bugs-and-requests`/`#most-important-thing` go to the `slack-triage` workspace. Also handles `@slam_paws test <scenario>` commands from any channel — spawns `run-and-publish.sh` in the background, replies in-thread with 👀 / ✅ / ❌ and a dashboard URL. |
| `slam-bot-state-scanner.service` | GitHub state scanner daemon (`github-state-scanner.sh` loop). Hardened with `MemoryMax=256M` and `TasksMax=64` to prevent runaway resource use. |

### Cron jobs

The crontab (installed by `deploy.sh`) covers roughly the following categories. Source of truth is `scripts/ec2-bot/crontab.txt`:

| Cadence | Script | Role |
|---|---|---|
| every 1 min | `git-pull.sh` | Keep `/opt/slam-bot` in sync with `main`; pushes propagate in ~60s |
| every 1 min | `check-github.sh` | Monitor and enforce GitHub state (falls back to `gh` calls if state scanner is unavailable) |
| every 1 min | `workspace-dispatcher.sh` | Drive label-based workspace dispatch |
| every 1 min | `process-queue.sh` | Drain queued work items |
| every 1 min | `api-budget-monitor.sh` | **[Disabled 2026-05-30]** — Track Claude API spend per workspace |
| every 5 min | `clear-stale-locks.sh` | Unblock wedged dispatcher runs; auto-clear `waiting-human` markers when a non-bot reply is detected |
| every 5 min | `check-socket-mode.sh` | Restart socket listener if Slack disconnects |
| every 10 min | `pipeline-monitor.sh` | **[Disabled 2026-05-30]** — Watch PR / workflow state (feature pipeline retired) |
| every 30 min | `thread-tracker.sh` | Reconcile Slack threads with GitHub activity |
| daily | `sync-labels.sh`, `bot-health-check.sh`, `prune-journal.sh`, `prune-claude-projects.sh` | Housekeeping + daily health |
| twice daily (08:00 / 20:00) | `sync-staging.sh` | Merge `main` → `bot/staging`; PR accumulated bot work back to `main` |
| scheduled | `workspace-dispatcher.sh` variants | `docs-audit` (10:00 daily), `daily-strategy` (14:00 daily). [Cost/noise rework 2026-05-30]: other jobs (bug-fix, health-check, security-audit, stale-sweeper, pr-reviewer, pipeline-monitor) disabled; bug routing now human-gated via `bot:investigate`/`bot:pr` labels |
| on-demand only | `run-and-publish.sh` | E2E test runs published to dashboard — triggered via `@slam_paws test <scenario>` in Slack or manually via SSH. No scheduled cron (see `scripts/ec2-bot/crontab.txt`). |

Local operator scripts live at `scripts/ec2-bot/`:

| Script | Purpose |
|---|---|
| `provision.sh` | One-shot AWS provisioning (security group, EIP, instance, SSH config entry) |
| `setup.sh` | First-time bootstrap of a fresh instance (Node, gh, claude, directories) |
| `deploy.sh` | Symlink scripts, install systemd units + crontab + logrotate |
| `configure-slack.sh` | Write Slack tokens + channel IDs (`SLAM_BOT_CHANNEL_ID` for `#slam-paws`, `AGENTIC_DEVS_CHANNEL_ID` for `#agentic-devs`, `BUGS_AND_REQUESTS_CHANNEL_ID` for `#bugs-and-requests`, `MOST_IMPORTANT_THING_CHANNEL_ID` for `#most-important-thing`, `DAILY_SUMMARY_CHANNEL_ID` for `#daily-summary`) to `/opt/slam-bot/.env` and start the socket service |
| `configure-mixpanel.sh` | Write Mixpanel service-account credentials |
| `configure-db.sh` | Legacy database setup; current AWS readonly role and tunnel are managed by `infra/aws/` |
| `run-and-publish.sh` | Wrap a Playwright e2e run and publish results (screenshots, transcript, metadata) to the test dashboard. Called by the `@slam_paws test` Slack handler or manually via SSH. |
| `save-snapshot.sh` | Save a named DB + app-state snapshot so test runs can branch from a known point. |
| `restore-snapshot.sh` | Restore a previously saved snapshot by ID (used with `--starting-snapshot-id` in `run-and-publish.sh`). |
| `write-test-result.ts` | Upload test artifacts (screenshots → Vercel Blob) and PATCH the run row in Vercel Postgres. Called by `run-and-publish.sh` after Playwright exits. |

### Channel routing

The socket listener routes messages by channel config. Each monitored channel maps to a workspace and command slug:

| Channel | Workspace | Command slug |
|---|---|---|
| DM (Shantam) | `slack-triage` | `dm-reply` |
| `#slam-paws` | `slack-triage` | `slam-paws-reply` |
| `#agentic-devs` | `slack-triage` | `agentic-devs-reply` |
| `#bugs-and-requests` | `slack-triage` | `bugs-and-requests-reply` |
| `#most-important-thing` | `slack-triage` | `most-important-thing-reply` |
| `#daily-summary` | `slack-triage` | `daily-summary-reply` |

### Runbook: repo disappearance

The repo clone at `/home/ubuntu/projects/meet-without-fear/` has vanished four times (2026-04-16, -18, -19, -21), each time breaking the `/opt/slam-bot/scripts` symlink chain. Symptoms: Slack messages stuck on `:eyes:` with no reply, `/var/log/slam-bot/socket-mode.log` crashing on `spawn /opt/slam-bot/scripts/run-claude.sh ENOENT`, `cron.log` flooded with "not found".

**Root cause (identified 2026-04-21)**: the worktree-cleanup loop in `clear-stale-locks.sh` was deleting the main worktree. Its main-worktree guard compared `$WT_PATH` (canonical path from `git worktree list`, e.g. `/home/ubuntu/projects/meet-without-fear`) against `$REPO_ROOT` (symlinked path `/home/ubuntu/meet-without-fear`), which never matched. With the guard bypassed, the `main` branch had no PR → the "no PR + >24h → abandoned" fallback fired → `rm -rf` on the main checkout. Fixed by normalizing both paths with `readlink -f`, adding a `main|master|develop` branch allowlist, and restricting the "no PR" fallback to bot-owned branch patterns.

Persistent auditd watches are installed at `/etc/audit/rules.d/mwf.rules` (keys `mwf_projects`, `mwf_repo`). If the repo disappears again, the first diagnostic is:

```bash
# The `</dev/null` is required. ausearch reads from stdin when stdin isn't a tty,
# and non-interactive ssh makes stdin a pipe, so without redirection it silently
# returns `<no matches>` for every query.
ssh slam-bot "sudo ausearch -k mwf_projects </dev/null | grep -E 'rename|delete|unlink|comm='"
```

Pair a matching PATH record with its SYSCALL and PROCTITLE records (same `:NNNNN)` event id) to get the PID, parent chain, and command line. If watches are missing (empty `auditctl -l | grep mwf`), reinstate with `sudo auditctl -R /etc/audit/rules.d/mwf.rules`.

Recovery:

1. `ssh slam-bot 'cd /home/ubuntu/projects && git clone https://github.com/shantamg/meet-without-fear.git'` (skip step if a `.broken` copy exists; remove it first)
2. `ssh slam-bot 'sudo systemctl restart slam-bot-socket'` (look for a clean startup with no "workspaces missing" warning)
3. `ssh slam-bot 'rm /opt/slam-bot/state/claims/claimed-<channel>-<ts>.txt'` for each message stuck on `:eyes:`

Slack Socket Mode will not redeliver an acked event. To force the bot to process a stuck message after recovery, invoke `run-claude.sh` directly with the same args the listener would have used:

```bash
/opt/slam-bot/scripts/run-claude.sh \
  --workspace slack-triage \
  --session slack-<channel>-<thread_ts> \
  '' <prompt_file> <msg_ts>
```

Set `CHANNEL=<channel>` in the env so the emoji reaction handlers work.

## Production hosting

- **Backend API**: AWS Lightsail `mwf-api` in `us-west-2`, Dockerized Express behind Caddy at `api.meetwithoutfear.com`
- **Database**: PostgreSQL 18 with pgvector on the same host, database `mwf`, non-superuser app role `mwf_app`; operator and bot access through SSH tunnels only. See [the AWS runbook](../../infra/aws/README.md).
- **Docs site (this one)**: Vercel
- **Marketing site**: Vercel (`website/`)
- **Web app** (`app.meetwithoutfear.com`): Vercel — Expo Web build of `mobile/`, Vercel project `mwf-app`. Deployed via `.github/workflows/vercel-deploy-app.yml` on pushes to `main` that touch `mobile/**` or `shared/**`.
- **Neural Monitor** (`monitor.meetwithoutfear.com`): Vercel (`tools/status-dashboard/`) — internal Clerk-gated dashboard for `/api/brain/*` activity, restricted in production to the Shantam and Darryl Clerk user IDs/email addresses.
- **Test Dashboard**: Vercel (`mwf-test-dashboard`) — Browsable UI for e2e test runs, screenshots, and snapshots. Vercel Postgres (Neon) for run/snapshot metadata; Vercel Blob for screenshots. Deployed via `.github/workflows/vercel-deploy-test-dashboard.yml` on pushes to `main` that touch `tools/test-dashboard/**`. See [E2E Testing Architecture: Test Run Publishing & Dashboard](../e2e-testing/architecture.md#test-run-publishing--dashboard).

See [deployment](../deployment/index.md) for release procedures and env var reference.

## GitHub workflows

- `.github/workflows/docs-impact.yml` — PR-time check that code changes and their mapped docs are updated together. Mapping rules in `docs/code-to-docs-mapping.json`.
- `.github/workflows/ci.yml` — PR-time CI with three conditional jobs gated by `dorny/paths-filter`. `ci`: spins up a Postgres 15 service container, installs deps (`npm ci`), generates the Prisma client, runs `npm run check`, migrates the test DB, and runs `npm run test`. `python-eval`: runs `py_compile` syntax checks across all gold-loop scripts and executes `test_mwf_moment_eval.py` when eval files change (`scripts/mwf_*.py`, `eval/gold-scenarios.json`, `eval/icm/**`, `eval/moments/**`, etc.). `bot-harness`: validates `bot-workspaces/label-registry.json` (JSON lint), Python-compiles the provider harness (`scripts/ec2-bot/scripts/lib/invoke_provider.py` and `bot_harness/*.py`), bash-syntax-checks the five public shell scripts, node-checks the Socket Mode listener, runs the bot harness unit tests, and enforces a stale-name guard when `scripts/ec2-bot/**` or `bot-workspaces/**` change. A `ci-success` gate job (requiring `changes`, `ci`, `python-eval`, and `bot-harness`) is the single required status check for branch protection.
- `.github/workflows/aws-deploy.yml` — Push-to-`main` backend deployment for API/shared/dependency/infrastructure changes. GitHub OIDC uploads checksummed image and runtime artifacts to S3; the host polls, backs up before migrations, deploys, and reports health to the workflow. Render automatic deployment is disabled.
- `.github/workflows/vercel-deploy-app.yml` — Push-to-`main` Expo Web deploy: filters to pushes touching `mobile/**` or `shared/**`, builds the Expo Web bundle, and deploys to `app.meetwithoutfear.com` via Vercel (`mwf-app` project). Also supports `workflow_dispatch`.
- `.github/workflows/vercel-deploy-website.yml` — Push-to-`main` marketing site deploy: filters to pushes touching `website/**`, deploys to Vercel.
- `.github/workflows/vercel-deploy-test-dashboard.yml` — Push-to-`main` test dashboard deploy: filters to pushes touching `tools/test-dashboard/**`, deploys Vite SPA + Vercel serverless functions to `mwf-test-dashboard` project. Also supports `workflow_dispatch`.
- `.github/workflows/ota-update.yml` — Push-to-`main` OTA update: publishes an Expo OTA update to the `production` EAS branch for iOS whenever `mobile/**` or `shared/**` changes on `main`. Also supports `workflow_dispatch` with a custom message. Uses `EXPO_TOKEN` secret. Roll back a bad update with `eas update:delete <group-id> --non-interactive`.
- **Dependabot** (`.github/dependabot.yml`) — Automated dependency updates for npm and GitHub Actions (replaces pre-launch autonomous security-audit workspace). Configured for weekly updates grouped by ecosystem with a 3-PR limit per group to minimize noise. Adds `dependencies` label to all PRs.
