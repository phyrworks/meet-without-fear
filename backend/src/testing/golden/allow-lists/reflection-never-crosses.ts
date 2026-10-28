/**
 * Allow-list and known leaks for `reflection-never-crosses` (golden R1).
 *
 * Plan §4 R1: the co-participant's full session read and prompt context
 * (`brain_activity.input` of the turn) contain no reflection text. Spec §7:
 * "a prompt built for participant X contains only X's private material …
 * never another participant's private rows or reflections"; the reflection
 * cluster has no FK from anything that crosses (D2).
 *
 * On the TARGET (TS-12) the run is compared to the current-shape baselines
 * (never re-recorded, R39) under pinned rules only. Nothing about the
 * reflection or the captures moves; what does is what every FEEL_HEARD_B read
 * carries on the target (TS-9/TS-10 rules, each with its scenario pair) and
 * the turn's served mock response (mockTurnIndex):
 *   - DTO rules, message DTO stage, compact signed instants, user first_name,
 *     Ada's `empathy_submitted` milestone at her attempt's submitted_at (<ts:18>);
 *   - Bob's turn (step 31) is served the fixture response at his real turn
 *     count, whose metadata proposes an empathy statement: his EMPATHY draft is
 *     ADDED (he had none), and his later reads (state 33, messages 35, empathy
 *     draft 41) show that reply and that draft — Bob's own rows;
 *   - `brain_activity.cost` is numeric(10,6) on the target (spec §1.8), so the
 *     view projects "0.000000" where the old Float projected 0.
 */

import type { KnownLeak } from '../privacy';
import {
  empathySubmittedMilestone,
  mockTurnIndex,
  READ_DTO_RULES,
  targetByteRules,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_USER_NAME_RULE,
} from './common';
import type { AllowList, AllowRule } from './types';

/** Bob's chat turn (the scenario's step index). */
export const R1_TURN_STEP = 31;
/** Bob's reads after the turn that return his conversation, and his empathy-draft read. */
export const R1_AFTER_STATE_STEP = 33;
export const R1_AFTER_MESSAGES_STEP = 35;
export const R1_AFTER_DRAFT_STEP = 41;

const bodyRules = (concept: boolean): AllowRule[] => [
  ...READ_DTO_RULES,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_COMPACT_SIGNED_MASK,
  ...mockTurnIndex(R1_TURN_STEP, concept, 'bob', 'added'),
  {
    kind: 'mayDiffer',
    at: [
      `steps.${R1_AFTER_STATE_STEP}.body.data.messages.messages.11.content`,
      `steps.${R1_AFTER_MESSAGES_STEP}.body.data.messages.11.content`,
    ],
    mustMatch: true,
    why: "Bob's own AI reply of the turn holds the served canned response (mockTurnIndex); the scenario asserts it is the streamed text.",
  },
  {
    kind: 'mayDiffer',
    at: `steps.${R1_AFTER_DRAFT_STEP}.body.data.draft`,
    mustMatch: true,
    why: "Bob's own EMPATHY draft, written by the served response's proposed statement (mockTurnIndex); the scenario asserts its content is that statement.",
  },
];

export const REFLECTION_NEVER_CROSSES_ALLOW: AllowList = {
  scenario: 'reflection-never-crosses',
  rules: [
    ...bodyRules(true),
    TARGET_USER_NAME_RULE,
    empathySubmittedMilestone('ada', 'initial', '<ts:18>'),
    {
      kind: 'mayDiffer',
      at: 'initial.brain_activity.*.cost',
      mustMatch: true,
      why: 'spec §1.8: brain_activity.cost is numeric(10,6) (pg returns it as text); the scenario asserts every value is numerically the baseline 0.',
    },
  ],
};

/** The byte-level golden on the TARGET shape (TS-12): body rules + changesMapped (ruling R32). */
export const REFLECTION_NEVER_CROSSES_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'reflection-never-crosses',
  rules: [
    ...bodyRules(false),
    ...targetByteRules({
      addedTables: [
        {
          step: R1_TURN_STEP,
          table: 'draft',
          kind: 'added',
          count: 1,
          why: "the mock response's proposed statement (mockTurnIndex): Bob's first EMPATHY draft",
        },
      ],
    }),
  ],
};

/** Observed against the current code; see `privacy.ts` for the contract. */
export const REFLECTION_NEVER_CROSSES_KNOWN_LEAKS: KnownLeak[] = [];
