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
  // --- tiedOrder (fix round 3): endpoints that sort on ONE timestamp ---------
  // Audit of every TS-5 response array whose rows one request can write:
  {
    kind: 'tiedOrder',
    at: 'steps.*.body.data.records',
    key: 'createdAt',
    why:
      'GET consent/history orders by createdAt alone (controllers/consent.ts); POST needs/consent writes every ' +
      'need’s consent in one transaction with one `now` (stage3.ts consentToShareNeeds), so they tie and come back ' +
      'in heap order — measured flipping at needs-hidden-until-shared step 29.',
  },
  {
    kind: 'tiedOrder',
    at: ['steps.*.body.data.messages', 'steps.*.body.data.messages.messages'],
    key: 'timestamp',
    why:
      'GET messages and the state DTO order a conversation by timestamp alone (controllers/messages.ts); a stream ' +
      'turn, a share acceptance, a resubmit or a reveal writes 2–3 messages for one reader in one request, and every ' +
      'run-written stamp normalises to <ts:fresh>. Order between tied rows is still carried by their labels ' +
      '(`<message:N>` ranks by timestamp then id), so only the response position is relaxed.',
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
 * inserts the copy into the restored state), or the index of the step whose
 * reveal inserts it — pinned to that one step, so a duplicate copy written by
 * any other step is a violation and "exactly once" holds on the target too.
 * `round` is the revealed attempt's round (its lineage).
 */
export function deliveredStatementCopy(
  author: string,
  subject: string,
  where: 'initial' | number,
  round = 1,
): AddedEntriesRule {
  const key = `<message:${subject}@main/EMPATHY_STATEMENT:${author}#1>`;
  const row = {
    'kind': 'EMPATHY_STATEMENT',
    'role': 'USER',
    'conversation_id': `<conversation:${subject}@main/MAIN>`,
    'sender_participant_id': `<participant:${author}@main>`,
    'source_attempt_id': `<empathyAttempt:${author}→${subject}@main#${round}>`,
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
        at: `steps.${where}.changes`,
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
