# Bot Workspaces — Shared Context

Pointers to cross-workspace resources. Each workspace's `CONTEXT.md` references specific items from here — do NOT load this file wholesale.

## Shared Resource Pointers

### References
- `shared/references/credentials.md` — Credential fallback chain (env -> bot .env -> app .env)
- `shared/references/slack-format.md` — Slack mrkdwn syntax rules and formatting conventions
- `shared/references/github-ops.md` — GitHub issue/PR patterns, duplicate checks, label taxonomy

### Diagnostics
- `shared/diagnostics/check-db.md` — PostgreSQL query utility (read-only production)
- `shared/diagnostics/check-mixpanel.md` — Mixpanel event export and analysis
- `shared/diagnostics/check-sentry.md` — Sentry issue query (backend + mobile)
- `shared/diagnostics/render-logs.md` — AWS API error diagnostics
- `shared/diagnostics/render-status.md` — AWS deployment status and health

### GitHub Utilities
- `shared/github/create-issue.md` — Issue creation with dedup, provenance, cross-referencing
- `shared/github/attach-image.md` — Image upload and embed for issues/PRs

### Slack Utilities
- `shared/slack/slack-post.md` — Message posting (single entry point for all Slack writes)
- `shared/slack/slack-upload.md` — File upload via Slack API

### Skills
- `shared/skills/pr.md` — PR creation workflow (pre-flight, docs update, issue linking)
- `shared/skills/send-voice-message.md` — Voice message generation via edge-tts

## Configuration Files

- `.claude/config/services.json` — Channel IDs, Sentry project slugs, AWS API connection details, bot user ID
- `.env` — Local dev credentials (fallback)
- `/opt/slam-bot/.env` — EC2 bot credentials (primary)

## Project Context (load only when needed)

- `CLAUDE.md` — Docs routing table, architecture principles, testing conventions
- `docs/` — Living documentation (load specific docs per workspace need)
- `backend/prisma/schema.prisma` — Database schema
