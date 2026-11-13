-- work-jv9y: User.email is unique ignoring case and surrounding whitespace.
--
-- "User_email_key" compares bytes, so 'Ada@Example.test', ' ada@example.test'
-- and 'ada@example.test' could be three accounts. The auth middleware now
-- stores addresses trimmed and lowercased, and refuses a first login whose
-- email already belongs to another account; this index makes the database
-- enforce the same rule for rows written before that (which keep their stored
-- form).
--
-- The normalised form is lower(btrim(email, E' \t\n\r\f')). btrim's default
-- strips only spaces; the explicit set matches what the app's
-- normalizeEmail() (String.prototype.trim) strips for ASCII. The holder lookup
-- in backend/src/middleware/auth.ts uses the same expression, so it hits this
-- index; change them together.
--
-- Existing rows that already collide under that form are NOT merged: which
-- account keeps the address is a support decision. The migration refuses to
-- run and says how many addresses collide (never which: they are PII).
-- Find them with:
--   SELECT lower(btrim(email, E' \t\n\r\f')), array_agg(id) FROM "User" GROUP BY 1 HAVING count(*) > 1;
--
-- Prisma's schema language cannot express an expression index, so this index
-- is not in schema.prisma; `prisma migrate diff` ignores it (checked).

DO $$
DECLARE
  collisions bigint;
BEGIN
  SELECT count(*) INTO collisions
  FROM (SELECT 1 FROM "User" GROUP BY lower(btrim(email, E' \t\n\r\f')) HAVING count(*) > 1) AS shared;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'user_email_case_insensitive_unique: % email address(es) are shared case-insensitively (ignoring surrounding whitespace) by more than one "User" row', collisions
      USING HINT = 'Resolve each collision by hand (no automatic merge), then re-run the migration. '
                   'List them: SELECT lower(btrim(email, E'' \t\n\r\f'')), array_agg(id) FROM "User" GROUP BY 1 HAVING count(*) > 1;';
  END IF;
END
$$;

CREATE UNIQUE INDEX "User_email_normalized_key" ON "User" (lower(btrim(email, E' \t\n\r\f')));

COMMENT ON INDEX "User_email_normalized_key" IS
  'User.email is unique ignoring case and surrounding whitespace: lower(btrim(email, E'' \t\n\r\f'')) (work-jv9y). Same expression as the auth middleware''s holder lookup. Not expressible in schema.prisma.';
