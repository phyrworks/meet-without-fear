# Investigate — Meet Without Fear Bug/Issue Investigator

Investigate a bug, error, or issue across all Meet Without Fear services. Correlates data from AWS API diagnostics, Sentry errors, Mixpanel events, the database, and GitHub issues.

## Arguments

`$ARGUMENTS` — What to investigate. Examples:
- `session not processing` → check pipeline, logs, and errors
- `user can't login` → check auth, Sentry, Mixpanel
- `SENTRY-123` → investigate a specific Sentry issue
- `#42` → investigate a GitHub issue
- `slow reconciler` → check reconciler performance, logs, timing
- Any bug description, error message, or issue reference

## Investigation workflow

### Phase 0: Check docs first

Before hitting external services, launch a sub-agent to search the MWF docs (`docs/`) for anything related to `$ARGUMENTS`. This often reveals:
- Known issues or gotchas already documented
- Expected behavior that the reporter may have misunderstood
- Architecture context that narrows the search (which service, which pipeline step, etc.)

The sub-agent should search docs with Grep/Glob and return a brief summary of anything relevant. This runs in parallel with Phase 1.

### Phase 1: Triage (parallel sub-agents)

Launch parallel sub-agents, each using the appropriate skill:

1. **Sentry** — run `/check-sentry` with the search term derived from `$ARGUMENTS`
2. **AWS API diagnostics** — run `/render-logs errors` to get recent error logs
3. **Database** — run `/check-db` with a relevant query (e.g., recent sessions, stuck pipelines)
4. **GitHub issues** — follow `/github-ops` issue search pattern

If the issue involves user behavior or a specific user, also:
5. **Mixpanel** — run `/check-mixpanel` with the user or event context

### Phase 2: Correlate

After gathering data from Phase 1:

1. Cross-reference Sentry errors with Render log timestamps
2. Check if database records show the expected pipeline progression
3. Look for patterns (same user, same time window, same endpoint)
4. Check if there's already a GitHub issue for this problem

### Phase 3: Deep dive

Based on findings, dig deeper:

- **If Sentry has a stacktrace**: Read the relevant source files, trace the code path
- **If logs show a specific endpoint failing**: Read the route handler and service code
- **If database shows stuck records**: Check the state-machine + reconciler paths in `backend/`
- **If Mixpanel shows user journey context**: Run `/check-mixpanel user <uuid>` for timeline

### Phase 4: Report & Act

Present findings, then ask the user what action to take:

- **Create a GitHub issue** → run `/create-issue` (follows `/github-ops` patterns)
- **Fix the code** → implement the fix, then run `/pr` to open a pull request
- **Notify Shantam** → `/create-issue` handles assignment and tagging

## Output format

```
🔍 Investigation Report — [issue description]

📋 Summary
[1-2 sentence summary of findings]

🐛 Sentry Errors
[related errors found, with links]

📜 Render Logs
[relevant log entries]

🗄️ Database State
[relevant records and their status]

📊 Mixpanel (if relevant)
[user activity context]

🔗 GitHub Issues
[related existing issues]

🎯 Root Cause
[identified or hypothesized root cause]

💡 Recommended Actions
1. [action items]

📝 Next Steps
- [ ] Create/update GitHub issue?
- [ ] Fix the code?
- [ ] Notify Shantam?
```
