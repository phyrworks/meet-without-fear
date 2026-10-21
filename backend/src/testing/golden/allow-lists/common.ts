/**
 * Allow-list rules every TS-5 privacy scenario carries, because each one
 * reads DTOs the target changes for reasons unrelated to the scenario.
 *
 * They restate `session-read`'s two DTO rules (plan §4 "Golden harness" row)
 * without `mustMatch`: a scenario's reads may or may not include a body with
 * `gatesSatisfied` or a consent DTO, and the rule must not go vacuous-fails
 * where it simply has nothing to match.
 */

import type { AddedEntriesRule, AllowRule } from './types';

export const READ_DTO_RULES: AllowRule[] = [
  {
    kind: 'absentKeys',
    at: 'steps.*.body.**.gatesSatisfied',
    keys: ['feelHeardCheckOffered', 'readyToRank', 'rankingSubmitted', 'finalEmotionalReading'],
    why:
      'plan §3 step 7: feelHeardCheckOffered (AI hint) and finalEmotionalReading (always null) are dropped; ' +
      'readyToRank/rankingSubmitted are dropped with ranking. gatesSatisfied becomes derived from participant_milestone.',
  },
  {
    kind: 'valuesSubset',
    at: ['steps.*.body.**.targetType', 'steps.*.body.**.contentType'],
    why:
      'spec §3 consent_target: 7 ConsentContentType values become 5 real targets. A value may disappear, none may appear.',
  },
];

/**
 * The delivered `EMPATHY_STATEMENT` copy the target writes into the SUBJECT's
 * conversation when `author`'s attempt is revealed (plan §3 step 9 for
 * migrated reveals, `app.empathy_set_status` for live ones; spec §7 "what the
 * partner saw stays readable to them"). Pinned completely — structural key,
 * audience, lineage, sender — so a copy into the author's own conversation, a
 * duplicate, or the wrong lineage is still a violation (TS-4 review probe).
 *
 * `where` = 'initial' for an attempt revealed in the fixture (the migration
 * inserts the copy into the restored state), or 'steps' for one revealed
 * during the run (the reveal job inserts it in the step's changes).
 */
export function deliveredStatementCopy(author: string, subject: string, where: 'initial' | 'steps'): AddedEntriesRule {
  const key = `<message:${subject}@main/EMPATHY_STATEMENT:${author}#1>`;
  const row = {
    'kind': 'EMPATHY_STATEMENT',
    'role': 'USER',
    'conversation_id': `<conversation:${subject}@main/MAIN>`,
    'sender_participant_id': `<participant:${author}@main>`,
    'source_attempt_id': `<empathyAttempt:${author}→${subject}@main#1>`,
  };
  return where === 'initial'
    ? {
        kind: 'addedEntries',
        at: 'initial.message',
        where: { $key: key, ...row },
        why:
          `plan §3 step 9: for every REVEALED/VALIDATED attempt the migration inserts ${author}'s EMPATHY_STATEMENT ` +
          `into the subject's (${subject}'s) conversation; today's data has none (P0-2).`,
      }
    : {
        kind: 'addedEntries',
        at: 'steps.*.changes',
        where: {
          view: 'message',
          kind: 'added',
          key,
          ...Object.fromEntries(Object.entries(row).map(([k, v]) => [`after.${k}`, v])),
        },
        why:
          `spec §4 app.empathy_set_status: on → REVEALED the reveal writes ${author}'s EMPATHY_STATEMENT into the ` +
          `subject's (${subject}'s) conversation; today it is written only into the author's own chat (P0-2).`,
      };
}
