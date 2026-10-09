# Check Database — Meet Without Fear

Query the meet-without-fear PostgreSQL database for diagnostics, data inspection, or debugging.

## Arguments

`$ARGUMENTS` — What to check. Examples:
- (empty) → general health check (table counts, recent activity)
- `users` → list users and relationships
- `sessions for <user>` → recent sessions for a user
- `schema` → show current schema state
- `<SQL query>` → run a custom SELECT query
- `migrations` → check migration status
- Any description of what you're looking for

## Load credentials

Follow the `/load-creds` pattern for `READONLY_DATABASE_URL` (preferred) with fallback to `DATABASE_URL`.

Default to **production read-only** for investigation. A readonly role should only have SELECT access — INSERT/UPDATE/DELETE/DROP are all denied at the database level.

**SECURITY**: NEVER print full connection strings. Write operations will be rejected by PostgreSQL even if attempted.

### Verify the production tunnel

Production is the Lightsail `mwf-api` instance in `us-west-2`, database `mwf`.
Use `python3 infra/aws/prod-query.py 'SELECT ...'`. It loads protected
`~/.config/mwf/production.json`, opens the `mwf-api` SSH tunnel if necessary,
and checks both the database name and readonly role before querying.

A loopback database address is expected for the SSH tunnel on port 15432;
it must not be confused with the local development database on port 5432.
Do not retrieve Render credentials or fall back to the development DATABASE_URL.
See `infra/aws/README.md` for recovery and credential rotation.

## Running queries

Use `psql` directly (available in Docker and most dev environments):

```bash
psql "$DATABASE_URL" -c "SELECT ..." --no-psqlrc -P pager=off
```

If psql is not available, fall back to the repo helper:
```bash
cd meet-without-fear && DATABASE_URL="$DATABASE_URL" npx ts-node backend/src/scripts/db-query.ts 'SELECT ...'
```

Alternatively, create a temp file in `backend/src/` that imports from `./lib/prisma` and run with `npx ts-node` (see CLAUDE.md).

## Default health check (no arguments)

Run these queries in parallel:

### 1. Table row counts
```sql
SELECT
  'User' as entity, COUNT(*) as count FROM "User"
UNION ALL SELECT 'Relationship', COUNT(*) FROM "Relationship"
UNION ALL SELECT 'Session', COUNT(*) FROM "Session"
UNION ALL SELECT 'Message', COUNT(*) FROM "Message"
UNION ALL SELECT 'StageProgress', COUNT(*) FROM "StageProgress"
UNION ALL SELECT 'UserVessel', COUNT(*) FROM "UserVessel"
UNION ALL SELECT 'SharedVessel', COUNT(*) FROM "SharedVessel"
UNION ALL SELECT 'EmpathyAttempt', COUNT(*) FROM "EmpathyAttempt"
UNION ALL SELECT 'ReconcilerResult', COUNT(*) FROM "ReconcilerResult"
UNION ALL SELECT 'InnerWorkSession', COUNT(*) FROM "InnerWorkSession"
UNION ALL SELECT 'BrainActivity', COUNT(*) FROM "BrainActivity"
ORDER BY count DESC;
```

### 2. Recent sessions (last 24h)
```sql
SELECT s.id, s.status, s.type, s."createdAt", r.id as relationship
FROM "Session" s
JOIN "Relationship" r ON s."relationshipId" = r.id
WHERE s."createdAt" > NOW() - INTERVAL '24 hours'
ORDER BY s."createdAt" DESC
LIMIT 10;
```

### 3. Pipeline status (recent)

Run `/check-pipeline-health` for the session progression query and interpretation guide.

### 4. Migration status
```sql
SELECT migration_name, finished_at
FROM "_prisma_migrations"
ORDER BY finished_at DESC
LIMIT 5;
```

## Guided queries based on $ARGUMENTS

- **"users"**: List all users with their relationships and session counts
- **"sessions for X"**: Find user by email/name, show their sessions with status
- **"errors" / "failures"**: Find sessions stuck in non-terminal states or empathy attempts stuck in NEEDS_WORK/REFINING
- **"schema"**: Run `\dt` to list tables, or read `backend/prisma/schema.prisma`
- **"user X"**: Search User table by name or email
- **Custom SQL**: Run it directly (SELECT only unless mutation explicitly requested)

## Key tables reference

| Table | Purpose |
|-------|---------|
| `User` | Auth users (linked to Clerk or Slack) |
| `Relationship` | Two-member relationship container |
| `RelationshipMember` | Join table for users in a relationship |
| `Session` | Conversation session (CONFLICT_RESOLUTION or INNER_WORK) |
| `SessionSlackThread` | Maps Slack DM threads to sessions |
| `StageProgress` | Per-user stage progression (stages 0-4) |
| `Message` | Chat messages (USER, AI, SYSTEM, EMPATHY_STATEMENT, etc.) |
| `UserVessel` | Private per-user session data (facts, events, emotions) |
| `SharedVessel` | Consensually shared content for a session |
| `EmpathyDraft` | User's in-progress empathy attempt |
| `EmpathyAttempt` | Completed empathy attempt with reconciler status |
| `EmpathyValidation` | Recipient's validation of partner's empathy |
| `ReconcilerResult` | Output of reconciler analysis (gaps, alignment) |
| `ReconcilerShareOffer` | Share suggestion made to a subject |
| `ConsentRecord` | Audit trail for content sharing decisions |
| `ConsentedContent` | Content transformed + shared with consent |
| `StrategyProposal` | Stage 4 strategies |
| `StrategyRanking` | User's ranking of proposals |
| `Agreement` | Finalized agreements between partners |
| `InnerWorkSession` | Solo inner-work (self-reflection) session |
| `InnerWorkMessage` | Messages within an inner-work session |
| `SessionTakeaway` | Distilled insights/actions from inner work |
| `Person` / `PersonMention` | People tracked across features |
| `Need` / `NeedScore` / `NeedsAssessmentState` | Needs assessment data |
| `GratitudeEntry` | Gratitude practice entries |
| `MeditationSession` / `MeditationStats` | Meditation tracking |
| `UserMemory` | User-approved memory preferences |
| `RecurringTheme` | Cross-session theme summaries (KB) |
| `Insight` | AI-generated cross-feature insights |
| `BrainActivity` | LLM call telemetry (prompts, outputs, costs) |

## Output format

Present results as formatted tables. Summarize key findings at the top:
```
🗄️ Database Check — meet-without-fear (production)
[summary of findings]

[formatted query results]
```
