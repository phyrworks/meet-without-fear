---
title: Data migrations after the baseline
sidebar_position: 6
description: How a migration that reads or rewrites rows gets past FORCE ROW LEVEL SECURITY — a policy for the migrating role, created and dropped inside the migration.
---
# Data migrations after the baseline

**In one line:** a migration that reads or changes rows opens one `migration_<purpose>` policy per table it
touches, `TO CURRENT_USER`, does its work, drops the policies and asserts none is left — all in the one
migration file, which PostgreSQL runs as one transaction.

## Why a backfill sees nothing

Every table is `ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY` (trailer.sql T7b), and no policy names
the owner, `mwf_migrator` (step 20 refuses one; [RLS policies](../security/rls-policies.md)). FORCE holds the
owner to the policies too, so with no policy of its own the owner reads no row and changes none: an
`UPDATE need SET …` in a migration deployed as `mwf_migrator` reports `UPDATE 0` and silently does nothing.
The baseline needed no exception — it builds an empty database (owner decision OD7) and reads only the seeds it
writes before FORCE is set. The first migration with a backfill does (work-k5fk.10.31).

A superuser deploy (local `run-baseline.sh` default mode) bypasses row-level security entirely, so a backfill
that works there can still do nothing in production, where `prisma migrate deploy` logs in as `mwf_migrator`.
Test it with `run-baseline.sh --as-migrator`, or the way `data-migration-pattern.target.test.ts` does.

## The pattern

```sql
-- work-k5fk.10.31 pattern: one policy per table the data step reads or writes (a subquery's table too),
-- for the migrating role only, narrowed to the commands and rows the step needs.
CREATE POLICY migration_backfill_need ON need TO CURRENT_USER USING (true) WITH CHECK (true);

UPDATE need SET category = 'SAFETY' WHERE category = 'MEANING';   -- the data step (illustrative)

DROP POLICY migration_backfill_need ON need;
-- Close: no migration policy may outlive its migration (infra/aws/verify.sql checks this again after a deploy).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname LIKE 'migration\_%') THEN
    RAISE EXCEPTION 'a migration_ policy outlived its migration';
  END IF;
END
$$;
```

- **One transaction.** `prisma migrate deploy` sends a migration file as one multi-statement simple query, which
  PostgreSQL runs in a single implicit transaction (the baseline's operator notes). So the policy exists only
  inside the deploy: if any statement fails, the policy, the data change and the drop all roll back together.
  Never add `BEGIN`/`COMMIT`, `CONCURRENTLY` or anything else that commits mid-file.
- **`TO CURRENT_USER`**, so the policy names exactly the role running the deploy (`mwf_migrator` in production,
  the superuser locally, where it is harmless) and no runtime capability.
- **Least privilege.** Narrow the policy when you can: `FOR UPDATE` / `FOR SELECT` instead of all commands, and a
  `USING` predicate that matches only the rows the step changes.
- **Name it `migration_…`.** The closing assertion and `verify.sql` find a leftover by that prefix.
- **Triggers still fire.** They run for the owner as for anyone: `touch_updated_at` stamps `updated_at`, the
  definer triggers (owned by `mwf_definer`, which has its own `definer_all` policies) do their work, and the
  invariants that exempt the owner (`t_session_scope`, `t_message_immutable`) do so by role. Read the triggers
  of each table before writing to it.

## Rejected alternatives

| Option | Why not |
|---|---|
| `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` for the step | All or nothing per table, every command and row; a leftover is a table without FORCE. The policy can be narrowed and is named. |
| `SET ROLE mwf_definer` for the step | Its grants are column lists cut to the definer bodies; a backfill would need them widened, and the widening would stay. |
| A standing policy for the owner | Step 20 forbids it: the owner's reads are then every row, every day, not only during a deploy. |
| Run the step by hand as the superuser | Outside the migration history and its transaction; not reproducible on the next environment. |
