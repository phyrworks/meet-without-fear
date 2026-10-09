SELECT current_database(), version();
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name;
SELECT format('SELECT %L AS table_name, count(*) AS rows FROM %I.%I;', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
-- Revalidate every FK, including checks skipped by a bulk restore.
SELECT format('ALTER TABLE %s VALIDATE CONSTRAINT %I;', conrelid::regclass, conname) FROM pg_constraint WHERE contype = 'f' \gexec
SELECT count(*) AS unvalidated_foreign_keys FROM pg_constraint WHERE contype = 'f' AND NOT convalidated;
SELECT id, "createdAt" FROM "User" ORDER BY id LIMIT 1;
SELECT id, "sessionId" FROM "Message" ORDER BY id LIMIT 1;
