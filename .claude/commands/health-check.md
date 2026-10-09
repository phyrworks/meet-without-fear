# Health Check — Daily Production Health Audit

Cross-reference Mixpanel activity, AWS API diagnostics, and Sentry errors to surface production issues.

## Arguments

`$ARGUMENTS` — Optional. Examples:
- (empty) → full audit of last 24h
- `last 3 days` → extend the window
- `session` → focus on session-related activity

## Step 1: Identify activity windows from Mixpanel

Run `/check-mixpanel` (no arguments — gets last 24h summary). From the results, note:
- **Peak activity windows** — time ranges with the most events
- **Active users** — distinct_id counts
- **Key event counts** — especially `Session Created`, `Session Resolved`, `Stage Started`, `Stage Completed`, `Message Sent`, app opens
- **Any anomalies** — sudden drops, missing expected events, error-related events

## Step 2: Check AWS API diagnostics during peak activity (parallel)

Launch parallel sub-agents:

1. **AWS API errors** — Run `/render-logs errors` to get error-level logs from the same time window
2. **AWS API warnings** — Run `/render-logs` with text search for `warn` or `timeout` or `throttling`
3. **Sentry issues** — Run `/check-sentry` (no arguments — gets recent unresolved issues)

## Step 3: Cross-reference and analyze

Correlate the results:

1. **Errors during activity** — Do Render errors or Sentry issues cluster around Mixpanel peak activity times? If so, users were likely impacted.
2. **Noisy logs** — Look for:
   - Repetitive log lines that fire on every request (unnecessary verbosity)
   - Debug-level logs that shouldn't be in production
   - Health check / ping noise that clutters real signal
   - Excessive `console.log` or `console.info` that add no diagnostic value
   - Logs that dump large payloads (request bodies, full transcripts, etc.)
3. **Silent failures** — Mixpanel shows a user started a session but no `Session Resolved` or stage completion? Check if Sentry or logs explain why. Also look at the Stage 2 reconciler: an `EmpathyAttempt` stuck in `ANALYZING`/`AWAITING_SHARING`/`REFINING` with no forward motion is a silent failure.
4. **Pipeline health** — Compare `Session Created` events to `Stage Completed` events by stage. Drop-off between stages indicates a blocked step. Run `/check-pipeline-health` for a structured view.
5. **Performance signals** — Slow responses, timeouts, Bedrock throttling in logs during high activity.

## Step 4: Report findings

Present a structured report:

```
Production Health Check — [date range]

Activity Summary (Mixpanel)
- Total events: N
- Active users: N
- Peak activity: [time window]
- Key events: Session Created (N), Session Resolved (N), Stage Completed (N), Message Sent (N)

Errors & Issues
- Sentry: N unresolved issues (N new since last check)
  - [issue summaries with links]
- AWS API diagnostics: N errors, N warnings
  - [grouped error summaries]

Cross-Reference Findings
- [any correlation between activity and errors]
- [silent failures: started but not resolved flows]
- [pipeline drop-off analysis by stage]

Log Quality
- [noisy/unnecessary log patterns found]
- [recommendations for log cleanup]

Issues Worth Noting
- [numbered list of actionable findings]
```

## Step 5: Search for prior issues and fixes

For each actionable finding from Step 4, search GitHub for related issues and PRs using `/github-ops` keyword search patterns:

For each finding:
1. Craft a short search query from the finding (e.g., "Ably token 503 error", "reconciler timeout")
2. Search issues and PRs in the repo
3. Review the results for:
   - **Prior occurrences** — has this exact problem been reported before?
   - **Prior fixes** — were PRs merged that attempted to fix it? What approach did they take?
   - **Recurrence pattern** — if this is a repeat, note how many times and what was tried

Include this context in the issue body (Step 6) under a **Prior Art** section:

```markdown
## Prior Art
- **Prior issues**: #NNN (date) — [brief description of what was reported]
- **Prior fixes**: PR #NNN (date) — [what the fix attempted]
- **Assessment**: [why prior fixes may not have resolved the root cause]
```

If search finds a matching open issue, comment on it with the new occurrence data instead of creating a duplicate.

## Step 6: Create GitHub issues for actionable findings

Follow the `/github-ops` patterns for duplicate checking, issue creation, cross-referencing, and auto-creation thresholds. Use `/create-issue` for the actual creation. Include the **Prior Art** section from Step 5 in the issue body.

## Step 7: Post to #health-check

Post a one-sentence summary to `#health-check` using `/slack-post`. See `.claude/config/services.json` for the channel ID.

**Format by severity:**

- **All clear**: `✅ Health check [date]: All clear — no issues found.`
- **Minor issues**: `⚠️ Health check [date]: N issues created — [brief description]. [link to most important issue]`
- **Needs attention**: `🚨 Health check [date]: N issues, user impact detected — [brief description]. [links to issues] cc @shantamg`

Keep it to one sentence. Link GitHub issues inline. Only tag people if there's actual user impact.
