/**
 * Fixed user ids for E2E fixtures.
 *
 * `User.id` is a Postgres `uuid` column, so a fixture id must be a valid UUID
 * string even though the seed route lets the database mint the real id (it
 * upserts by email). Fixed, readable v4-format constants: the last group names
 * the user.
 */
export const FIXTURE_USER_IDS = {
  userA: '00000000-0000-4000-8000-00000000000a',
  userB: '00000000-0000-4000-8000-00000000000b',
  stage3: '00000000-0000-4000-8000-000000000003',
  stage4: '00000000-0000-4000-8000-000000000004',
} as const;
