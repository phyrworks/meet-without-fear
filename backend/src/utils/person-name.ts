/**
 * A name as the `person_name` domain stores it ("user".first_name / last_name, user_contact.nickname;
 * work-k5fk.9, D1): 1 to 100 characters and not blank, or NULL.
 *
 * Trims the value, maps an empty or whitespace-only one to NULL, and clamps a longer one to its first
 * 100 characters (code points, as char_length counts them). Used where a name arrives from outside the
 * zod contracts — a Clerk profile at first sign-in (OD-4: clamp, never refuse the sign-in) — and for
 * the profile edit, whose contract lets `lastName` be "".
 */
export const PERSON_NAME_MAX = 100;

export function toPersonName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const chars = Array.from(trimmed);
  return chars.length <= PERSON_NAME_MAX ? trimmed : chars.slice(0, PERSON_NAME_MAX).join('').trimEnd();
}
