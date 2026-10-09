# Stage: Audit

## Global State File

```bash
source /opt/slam-bot/scripts/lib/github-state.sh
github_state_assert_fresh || exit 1
```

Use `github_state_*` helpers for all open issue/PR metadata lookups. Do NOT call `gh issue list` or `gh pr list` for label filtering or state checks — use the state file. Direct `gh` calls are only permitted for: keyword search (`--search`), closed/merged items, diffs, and comment bodies. See step 5 for details.

## Input

- Optional argument: time window (default: last 24h), focus area
- Credentials loaded per `shared/references/credentials.md`

## Process

1. **Identify activity** from Mixpanel: peak windows, active users, key event counts, anomalies
2. **Check EC2 instance health**:
   - Run `df -h /` to check disk usage. If above 80%, include a warning in the report. If above 90%, create a `bug` + `bot:investigate` issue.
   - Run `du -sh ~/.claude/projects/ /tmp/meet-without-fear-worktree-* 2>/dev/null` to check for session file and worktree bloat.
   - Run `find ~/.claude/projects/ -name "*.jsonl" -mtime +30 | wc -l` to count stale session files (>30 days old). If significant, note in report.
3. **Check thread-tracker health** (`shared/diagnostics/check-thread-tracker.md`):
   - Tracker file count (warn if >100)
   - Oldest open tracker file age (warn if >14 days)
   - Follow-ups sent in last 24h (warn if >20)
   - Last successful tick timestamp (warn if >90 min ago)
4. **Check production** (parallel sub-agents):
   - AWS API health (`shared/diagnostics/render-status.md`)
   - Read-only database/pipeline health (`shared/diagnostics/check-pipeline-health.md`)
   - Sentry unresolved issues (`shared/diagnostics/check-sentry.md`)
4b. **Cross-reference and analyze**:
   - Errors during activity windows = user impact
   - Noisy logs: repetitive lines, debug-level in prod, excessive payloads
   - Silent failures: Mixpanel shows start but no completion
   - Conversation health: sessions whose latest message is `role=USER` for >~3 min (AI reply stuck) — see `shared/diagnostics/check-pipeline-health.md`
   - Performance: slow responses, Bedrock throttling
5. **Check if already tracked or fixed** — before creating any issue, check the state file first, then use search as needed:
   ```bash
   source /opt/slam-bot/scripts/lib/github-state.sh
   github_state_assert_fresh || exit 1
   ```
   - **Open issues by label**: Use `github_state_issues_with_label "bug"` to scan open issues for title matches — do NOT call `gh issue list` for simple label filtering.
   - **Keyword search** (escape hatch): `gh issue list --repo shantamg/meet-without-fear --search "<key terms>" --limit 10 --json number,title,state,labels,url` — only for keyword search not possible via state file.
   - **Recent merged PRs** (escape hatch): `gh pr list --repo shantamg/meet-without-fear --search "<key terms>" --state merged --limit 5 --json number,title,mergedAt,url` — merged PRs are not in the state file.
   - **Closed issues**: if a closed issue matches and the finding is a recurrence, reopen it with a comment rather than creating a new issue.

   Re-fetching open issue labels or state via `gh issue list --label` is a **strict violation** of the bot's GitHub API budget policy (#1649) — use the state file.

   Include an *Already Addressed* section in the report for findings that were skipped due to existing issues or recent fixes, with links to the relevant issue/PR.
6. **Create GitHub issues** for actionable findings that passed the dedup check, per `shared/references/github-ops.md` thresholds.
   Always add a `bot:investigate` label in addition to `bug`/`security` so the
   dispatcher picks the issue up for automated investigation. See the
   "Bot Pipeline Labels" section in `shared/references/github-ops.md`.
7. **Post to #health-check** via `shared/slack/slack-post.md`:
   - All clear: `All clear — no issues found.`
   - Minor: `N issues created — [brief]. [link]`
   - Needs attention: `N issues, user impact detected — [brief]. [links] cc @shantamg`

## Output

Structured health report with:
- Activity summary (Mixpanel)
- Errors and issues (Sentry + AWS API)
- Thread tracker health (file count, oldest age, follow-up volume, cron status)
- Cross-reference findings
- Already addressed (findings skipped due to existing issues or recent fixes)
- Log quality assessment
- Created issue links

## Completion

Single-stage workspace. Complete after report posted and issues created.

On completion, no label swap needed (cron-triggered, not label-triggered).
