/**
 * Allow-list and known leaks for `reflection-never-crosses` (golden R1).
 *
 * Plan §4 R1: the co-participant's full session read and prompt context
 * (`brain_activity.input` of the turn) contain no reflection text. Spec §7:
 * "a prompt built for participant X contains only X's private material …
 * never another participant's private rows or reflections"; the reflection
 * cluster has no FK from anything that crosses (D2).
 *
 * What the target re-record may change: only the DTO rules every read
 * carries. Nothing about the reflection or the captures may move — the
 * migration keeps their ids, renames `innerWorkSessionId` → `reflection_id`
 * (already the view's column name) and leaves `brain_activity.participant_id`
 * NULL for history (plan step 18), which is what the view projects.
 */

import type { KnownLeak } from '../privacy';
import { READ_DTO_RULES } from './common';
import type { AllowList } from './types';

export const REFLECTION_NEVER_CROSSES_ALLOW: AllowList = {
  scenario: 'reflection-never-crosses',
  rules: [...READ_DTO_RULES],
};

/** Observed against the current code; see `privacy.ts` for the contract. */
export const REFLECTION_NEVER_CROSSES_KNOWN_LEAKS: KnownLeak[] = [];
