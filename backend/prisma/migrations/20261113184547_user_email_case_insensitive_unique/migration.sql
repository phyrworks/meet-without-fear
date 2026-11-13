-- work-jv9y: User.email is unique case-insensitively.
--
-- "User_email_key" compares bytes, so 'Ada@Example.test' and 'ada@example.test'
-- could be two accounts. The auth middleware now stores addresses trimmed and
-- lowercased, and refuses a first login whose email already belongs to another
-- account; this index makes the database enforce the same rule for rows written
-- before that (which keep their stored case).
--
-- Existing rows that already collide case-insensitively are NOT merged: which
-- account keeps the address is a support decision. The migration refuses to
-- run and says how many addresses collide (never which: they are PII).
-- Find them with:
--   SELECT lower(email), array_agg(id) FROM "User" GROUP BY 1 HAVING count(*) > 1;
--
-- Prisma's schema language cannot express an expression index, so this index
-- is not in schema.prisma; `prisma migrate diff` ignores it (checked).

DO $$
DECLARE
  collisions bigint;
BEGIN
  SELECT count(*) INTO collisions
  FROM (SELECT 1 FROM "User" GROUP BY lower(email) HAVING count(*) > 1) AS shared;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'user_email_case_insensitive_unique: % email address(es) are shared case-insensitively by more than one "User" row', collisions
      USING HINT = 'Resolve each collision by hand (no automatic merge), then re-run the migration. '
                   'List them: SELECT lower(email), array_agg(id) FROM "User" GROUP BY 1 HAVING count(*) > 1;';
  END IF;
END
$$;

CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower(email));

COMMENT ON INDEX "User_email_lower_key" IS
  'User.email is unique case-insensitively (work-jv9y). Not expressible in schema.prisma.';
