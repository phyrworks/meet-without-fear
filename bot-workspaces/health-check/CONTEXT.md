# Health Check — Workspace Context

## Purpose

Cross-reference Mixpanel activity, AWS API diagnostics, and Sentry errors to surface production issues. Creates GitHub issues for actionable findings and posts a summary to #health-check.

## Stage Pointers

- `stages/audit/CONTEXT.md` — Single-stage fan-out audit

## Shared Resources Used

- `shared/references/credentials.md` — API credentials
- `shared/diagnostics/check-mixpanel.md` — Activity windows
- `shared/diagnostics/check-sentry.md` — Unresolved issues
- `shared/diagnostics/render-logs.md` — Error/warning logs
- `shared/github/create-issue.md` — Issue creation for findings
- `shared/references/github-ops.md` — Auto-creation thresholds
- `shared/slack/slack-post.md` — Summary to #health-check
