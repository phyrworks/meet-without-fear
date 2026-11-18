# Check Database Utility

Query the PostgreSQL database for diagnostics, data inspection, or debugging.

## Credentials

Load only `READONLY_DATABASE_URL` per `shared/references/credentials.md`. On the bot this points to `127.0.0.1:15432` through `mwf-db-tunnel.service`, using database `mwf` and role `slam_bot_readonly`. If it is absent or the tunnel is down, report the failure; do not fall back to an administrative or development database.

## Running Queries

```bash
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" \
  psql "$READONLY_DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off -c "SELECT ..."
```

First confirm `SELECT current_database(), current_user;` returns `mwf` and `slam_bot_readonly`. On the operator machine, `python3 infra/aws/prod-query.py 'SELECT ...'` opens and verifies the tunnel automatically.

## What the bot can see (target shape)

`slam_bot_readonly` is a member of the `diag_access` capability only (owner decision 2026-11-17,
"diagnostics, no content"; `backend/scripts/target-shape/trailer.sql` T7c). It reads **every row**,
but **only** columns that hold ids, statuses, kinds, stages, counts, flags and timestamps. Asking for
anything else — message or empathy content, needs, reflections, memory, names, emails, nicknames,
push tokens, notes, the key tables, `user_identity`, and a user's private state even as an enum or
flag (need categories, choices and consent decisions, review verdicts, reconciler judgements, closure
reasons, regulation events, who knows whom, per-user last-seen times) — fails with `permission denied` (42501). That
is by design: report counts and states, never content. `SELECT *` always fails; name the columns.
`count(*)` works on every table it can read.

## Default Health Check

1. Row counts: `"user"`, `session`, `participant`, `conversation`, `message`, `invitation`, `reflection`
2. Recent sessions (last 24h) with status and message count
3. Conversation/turn health via `check-pipeline-health.md`
4. Migration status (last 5 migrations)

Recent sessions query:

```sql
SELECT s.id, s.status, s.created_at,
       (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS messages,
       (SELECT count(*) FROM participant p WHERE p.session_id = s.id AND p.left_at IS NULL) AS participants
FROM session s
WHERE s.created_at > now() - interval '24 hours'
ORDER BY s.created_at DESC;
```

Migration status:

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;
```

## Key Tables

Names are snake_case; ids are UUIDv7 (they sort by creation time); timestamps are `timestamptz`.

| Table | Purpose | Useful columns |
|---|---|---|
| `"user"` | Accounts (human, persona, the AI) | `id`, `kind`, `deleted_at`, `created_at` |
| `session` | A conversation between two people (`session_status`: CREATED→INVITED→ACTIVE→…→RESOLVED/ABANDONED/ARCHIVED) | `id`, `status`, `previous_session_id`, `resolved_at`, `archived_at` |
| `participant` | Who is in a session (key `(session_id, user_id)`) | `kind`, `joined_at`, `left_at` |
| `participant_milestone` | Stage progress: which milestone each participant reached | `milestone_key`, `reached_at` |
| `milestone` | The milestone catalogue (stage order) | `key`, `ordinal`, `scope` |
| `conversation` / `message` | Each participant's threads and their lines (key `(conversation_id, seq)`) | `kind`, `status`; `role`, `kind`, `created_at` |
| `invitation` | Partner invitations | `status`, `expires_at`, `accepted_at`, `declined_at` |
| `empathy_attempt` / `empathy_review` | Empathy statements (Stage 2) and their review | `status`, `round`, `delivery_status`, `revealed_at` |
| `reconciler_result` / `context_share_offer` | Reconciler runs and share offers | `iteration`, `circuit_breaker_tripped`, `superseded_at`; `status`, `delivery_status` |
| `need` / `need_share` / `need_disposition` | Stage 3 needs (counts and times only) | `confirmed_at`, `shared_at`, `revoked_at` |
| `proposal` / `proposal_choice` / `agreement` / `session_closure` | Stage 4 | `status`, `kind`, `closed_at` |
| `follow_up` / `follow_up_checkin` / `reminder` | Tending after resolution, scheduled jobs | `status`, `scheduled_for`, `opened_at`, `remind_at` |
| `reflection` / `takeaway` | Inner work (solo) | `status`, `created_at` |
| `brain_activity` | AI call telemetry | `activity_type`, `call_type`, `status`, token counts, `duration_ms` |

## Security

- SELECT-only, diagnostics columns only, via `slam_bot_readonly` (capability `diag_access`)
- NEVER print full connection strings
