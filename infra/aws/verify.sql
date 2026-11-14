SELECT current_database(), version();
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name;
SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
-- Revalidate every FK, including checks skipped by a bulk restore.
SELECT format('ALTER TABLE %s VALIDATE CONSTRAINT %I;', conrelid::regclass, conname) FROM pg_constraint WHERE contype = 'f' \gexec
SELECT count(*) AS unvalidated_foreign_keys FROM pg_constraint WHERE contype = 'f' AND NOT convalidated;
-- Target shape (work-k5fk.1): production has no E2E-bypass identity. The e2e provider is written only by
-- the E2E tooling connection (E2E_AUTH_BYPASS, never production); a row here means the bypass ran.
DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.user_identity') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM public.user_identity WHERE provider = 'e2e'$q$ INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'verify: % user_identity row(s) of provider e2e in production', n; END IF;
  END IF;
END
$$;
SELECT id, "createdAt" FROM "User" ORDER BY id LIMIT 1;
SELECT id, "sessionId" FROM "Message" ORDER BY id LIMIT 1;
