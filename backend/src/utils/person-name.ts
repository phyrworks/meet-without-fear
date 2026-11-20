/**
 * A name as the `person_name` domain stores it ("user".first_name / last_name, user_contact.nickname;
 * work-k5fk.9, D1): 1 to 100 characters and not blank, or NULL.
 *
 * "Blank" is one set on both sides (review r2 R2-4): Unicode White_Space. The domain refuses a value made only of
 * it (`VALUE COLLATE pg_c_utf8 !~ '^[[:space:]]*$'`); this strips it from both ends (`\p{White_Space}`) — not
 * JavaScript's trim(), which also strips U+FEFF but keeps U+0085, so a NEL-only Clerk name would have failed sign-in.
 *
 * Maps an empty or all-White_Space value to NULL, and clamps a longer one to its first 100 characters (code points,
 * as char_length counts them). Used where a name arrives from outside the zod contracts — a Clerk profile at first
 * sign-in (OD-4: clamp, never refuse the sign-in) — for the profile edit, whose contract lets `lastName` be "", and
 * for a nickname.
 */
export const PERSON_NAME_MAX = 100;

const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Strip Unicode White_Space from both ends: the person_name domain's notion of blank. */
export function trimPersonName(value: string): string {
  return value.replace(EDGE_SPACE, '');
}

export function toPersonName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = trimPersonName(value);
  if (!trimmed) return null;
  const chars = Array.from(trimmed);
  return chars.length <= PERSON_NAME_MAX ? trimmed : trimPersonName(chars.slice(0, PERSON_NAME_MAX).join('')) || null;
}
