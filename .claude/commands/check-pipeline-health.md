# Check Pipeline Health

Query the session pipeline status to identify stuck, failed, or incomplete sessions. This is a reusable skill invoked by other skills (health-check, investigate, check-db).

For Meet Without Fear, the "pipeline" is the conversation state machine: sessions progress through stages (0 → 1 → 2 → 3 → 4) with per-user `StageProgress` records and reconciler runs that compare empathy attempts. A session is "stuck" when it sits in a non-terminal state with no forward progress for an unusually long time.

See `docs/backend/state-machine/index.md` and `docs/backend/reconciler-flow.md` for the full progression model.

## Arguments

`$ARGUMENTS` — Optional. Examples:
- (empty) → check last 10 sessions
- `last 24h` → sessions from the last 24 hours
- `session <ID>` → check a specific session
- `user <name>` → sessions involving a specific user

## Load credentials

Follow the pattern in `/load-creds` to obtain `DATABASE_URL` (readonly preferred, production as fallback).

## Pipeline progression

A healthy conflict-resolution session flows through these stages per user:

```
Stage 0 (Landing) → Stage 1 (Feeling heard / facts) → Stage 2 (Empathy attempt + reconciler) →
Stage 3 (Shared understanding) → Stage 4 (Strategies + agreement) → RESOLVED
```

Each stage's `StageProgress` row transitions: `IN_PROGRESS` → `GATE_PENDING` (waiting for partner) → `COMPLETED`.

For Stage 2 specifically, `EmpathyAttempt.status` cycles through:
`HELD → ANALYZING → (AWAITING_SHARING | REFINING | READY) → REVEALED → VALIDATED`

A session stuck at any stage for >1 hour is likely blocked.

## Core query

```sql
SELECT
  s.id,
  s.status as session_status,
  s.type,
  s."createdAt",
  s."updatedAt",
  (SELECT COUNT(*) FROM "StageProgress" sp WHERE sp."sessionId" = s.id AND sp.status = 'COMPLETED') as stages_completed,
  (SELECT MAX(sp.stage) FROM "StageProgress" sp WHERE sp."sessionId" = s.id) as highest_stage,
  (SELECT COUNT(*) FROM "Message" m WHERE m."sessionId" = s.id) as message_count,
  (SELECT COUNT(*) FROM "EmpathyAttempt" ea WHERE ea."sessionId" = s.id) as empathy_attempts,
  (SELECT COUNT(*) FROM "ReconcilerResult" rr WHERE rr."sessionId" = s.id) as reconciler_runs
FROM "Session" s
ORDER BY s."updatedAt" DESC
LIMIT 10;
```

### Time-windowed variant

```sql
-- Replace LIMIT with a time filter
WHERE s."updatedAt" > NOW() - INTERVAL '24 hours'
ORDER BY s."updatedAt" DESC;
```

### Single session

```sql
WHERE s.id = 'SESSION_ID';
```

### Empathy attempts stuck in reconciler

```sql
SELECT ea.id, ea."sessionId", ea."sourceUserId", ea.status, ea."statusVersion",
       ea."createdAt", ea."sharedAt"
FROM "EmpathyAttempt" ea
WHERE ea.status IN ('ANALYZING', 'AWAITING_SHARING', 'REFINING', 'NEEDS_WORK')
  AND ea."sharedAt" < NOW() - INTERVAL '1 hour'
ORDER BY ea."sharedAt" DESC;
```

## Interpreting results

| Session status | Stages completed | Empathy attempts | Reconciler runs | Interpretation |
|---|---|---|---|---|
| `RESOLVED` | ≥4 | ≥2 | ≥2 | Healthy — full flow completed |
| `ACTIVE` | 0-1 | 0 | 0 | Early session, expected if young |
| `ACTIVE` | 2-3 | ≥1 | ≥1 | Mid-flow, check stage-specific progress |
| `ACTIVE` with no updates for >1h | any | any | any | Stalled — check stage gates, reconciler status |
| `WAITING` | N | N | N | One partner done, waiting for the other — normal until long-lived |
| `PAUSED` | any | any | any | Explicit cool-down; monitor for resume |
| `ABANDONED` | any | any | any | Timeout or withdrawal — terminal |

For Stage 2 specifically, if `EmpathyAttempt.status` is `ANALYZING` for more than a few minutes the reconciler likely failed or is stuck — check logs and `ReconcilerResult` for the attempt.

## Stuck detection

Flag sessions as potentially stuck if:
- Status is `ACTIVE` and `updatedAt` is >1 hour ago (no user or AI activity)
- Any `StageProgress` row sits in `IN_PROGRESS` or `GATE_PENDING` for >24h without matching partner progress
- Any `EmpathyAttempt` in `ANALYZING` / `AWAITING_SHARING` / `REFINING` for >1h
- `Session.status` is `WAITING` for >72h (partner never returned)

## Output format

```
🔄 Pipeline Health — [scope]

| Session | Status | Type | Age | Stage | Msgs | Empathy | Reconciler | Health |
|---------|--------|------|-----|-------|------|---------|------------|--------|
| [id]    | [status] | [type] | [age] | [n] | [n] | [n] | [n] | ✅/⚠️/❌ |

Summary:
- Total: N sessions
- Healthy: N ✅
- Stuck: N ⚠️ [details]
- Abandoned/failed: N ❌ [details]
```

## Cross-referencing

When stuck sessions are found:
1. Check Sentry for errors correlated with the session time window (`/check-sentry`)
2. Check AWS API diagnostics for pipeline errors around that time (`/render-logs errors`)
3. Inspect `BrainActivity` rows for the session to see LLM call failures
4. If user-impacting, follow `/github-ops` thresholds for creating issues
