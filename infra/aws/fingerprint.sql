BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L || ''|'' || count(*) || ''|'' || coalesce(md5(string_agg(to_jsonb(t)::text, E''\\n'' ORDER BY to_jsonb(t)::text)), ''empty'') FROM %I.%I t;', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
COMMIT;
