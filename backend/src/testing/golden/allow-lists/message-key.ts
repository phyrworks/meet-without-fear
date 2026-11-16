/**
 * work-k5fk.4, step 7 (design note §5, §7 row 7): a message is keyed
 * (conversation_id, seq). seq is numbered by t_message_seq from the
 * per-conversation counter conversation.next_seq; message.id is gone. The
 * API keeps `MessageDTO.id: string` as the derived "<conversationId>:<seq>"
 * and adds `seq` (owner decision Q6). No baseline is re-recorded (R39; the
 * runner refuses a re-record on the target); what the key change moves is
 * carried here, one paragraph per baseline.
 *
 * What moves, in every baseline alike:
 *   - every MessageDTO gains `seq` — GET /sessions/:id/messages
 *     (`data.messages.*`) and GET /sessions/:id/state (`data.messages.messages.*`).
 *     It is the one added key (MESSAGE_SEQ_RULE); its value is the number in the
 *     id, which message-seq.target.test.ts asserts over HTTP ("a MessageDTO is
 *     <conversationId>:<seq> and carries seq").
 *
 * What does not move, and why:
 *   - message ids. The byte-level labeller (normalize.ts labelTargetRows) labels
 *     the API id "<conversation_id>:<seq>" with the same `<message:N>` global
 *     time rank as before, matched as ONE token ahead of the uuid pattern
 *     (MESSAGE_ID_RE); the concept views mint the concept message id from
 *     (conversation_id, seq) with seq in its last 12 hex digits, so the
 *     concept labeller's id tie-break orders a conversation's lines by seq —
 *     their creation order, as the uuidv7 id did — and the API id takes the
 *     same `<message:ada@main#3>` label. A pending action's id (the unread
 *     shared context, GET /sessions/:id/pending-actions) is a message id too.
 *   - message order. A conversation page is ordered by seq (the chat order);
 *     the fixture writer inserts each fixture's messages in time order, so seq
 *     order is created_at order there, as the app produces it.
 *   - conversation rows. The counter column next_seq changes on every message
 *     insert; snapshots never read it (snapshot.ts UNSNAPSHOTTED_COLUMNS), and
 *     touch_updated_at skips the counter's UPDATE, so a written line is not a
 *     conversation change. The counter's UPDATE runs inside the trigger, so the
 *     statement log (the trace) does not see it.
 *   - the read state. Its seen-message pointer is now (last_seen_conversation_id,
 *     last_seen_seq); old_concept_conversation_read_state derives the old
 *     last_seen_message_id from the pair with the message's formula. Every
 *     baseline records it NULL, and no step posts a seen message.
 */

import type { AddedKeysRule } from './types';

/** Where a MessageDTO sits in a recorded body. */
export const MESSAGE_DTO_AT = ['steps.*.body.data.messages.*', 'steps.*.body.data.messages.messages.*'];

/** Per baseline: what the key change moves in it, measured on the first target run of this branch. */
export const MESSAGE_KEY_WHY = {
  'session-read':
    'session-read (FEEL_HEARD_B, reads only): its messages reads (GET /messages for each reader, the page of 5) and ' +
    'its two session-state reads return 56 MessageDTOs; each gains seq and nothing else — every id keeps its ' +
    '<message:N> (the same-instant pair of FEEL_HEARD_B ranks in creation order, xmin then ctid), every order and ' +
    'content is as recorded. The paged message read is still one read of message (traceMapped sameRowsRead).',
  'empathy-reveal':
    'empathy-reveal (FEEL_HEARD_B): the two messages reads after the reveal return 27 MessageDTOs, each gaining ' +
    'seq. The delivered copies keep their pinned entries (deliveredCopyInRead does not name seq); the four messages ' +
    'Bob writes and the reveal copy are numbered by t_message_seq, which the trace does not see (it runs inside the ' +
    'INSERT).',
  'reflection-never-crosses':
    'reflection-never-crosses (INNER_WORK_LINKED_A): the messages and state reads before and after Ada’s turn ' +
    'return 44 MessageDTOs, each gaining seq. The probes (no reflection text reaches Bob) are about content and ' +
    'audience; the conversation is still the audience, by key now.',
  'unrevealed-attempt-hidden':
    'unrevealed-attempt-hidden (RECONCILER_SHOWN_B): the messages and state reads at the four phases return 154 ' +
    'MessageDTOs, each gaining seq; the unread shared-context action (GET /pending-actions) names its message by the ' +
    'derived id, labelled as before. No attempt, status or reveal value moves.',
  'reveal-all-ready-ada-first':
    'reveal-all-ready-ada-first (FEEL_HEARD_B): the messages and state reads after Ada is READY and after the reveal ' +
    'return 104 MessageDTOs, each gaining seq; the delivered copies are still one per subject conversation ' +
    '(reveal-checks).',
  'reveal-all-ready-bob-first':
    'reveal-all-ready-bob-first (RECONCILER_SHOWN_B): as the Ada-first order, 100 MessageDTOs, each gaining seq; ' +
    'nothing else moves.',
  'needs-hidden-until-shared':
    'needs-hidden-until-shared (NEEDS_CONFIRMED): the messages and state reads once both have shared return 6 ' +
    'MessageDTOs (the needs_shared lines), each gaining seq. Need labels, evidence and their visibility are unchanged.',
  'choices-hidden-until-shared':
    'choices-hidden-until-shared (STAGE4_REDESIGN_PARTNER_INACTIVE): reads no conversation and writes no message ' +
    'in its recorded steps, so no rule here (a mustMatch rule would have nothing to match); its fixture has no ' +
    'messages either.',
  tombstone:
    'tombstone (TOMBSTONE_READY): the messages and state reads before and after the deletion return 20 MessageDTOs, ' +
    'each gaining seq; the unread shared-context action names its message by the derived id. Its two same-instant ' +
    'SHARED_CONTEXT lines (the sender’s copy and the delivered one) keep their creation-order labels (<message:8>, ' +
    '<message:9>; measured: ordering ties by (conversation_id, seq) swapped them here, by (seq, conversation_id) ' +
    'FEEL_HEARD_B’s pair). The walk deletes the leaver’s ' +
    'conversation and its lines by cascade, as before; the template’s labels label the survivors.',
  'author-sees-status-only':
    'author-sees-status-only (RECONCILER_SHOWN_B): the author’s messages and state reads return 26 MessageDTOs, ' +
    'each gaining seq. No status or analysis value moves.',
  'declined-offer-no-trace':
    'declined-offer-no-trace (RECONCILER_SHOWN_B): the author’s messages and state reads before and after the ' +
    'decline return 52 MessageDTOs, each gaining seq on both sides, so "the author’s reads are unchanged by the ' +
    'decline" still compares the two phases equal.',
} as const;

export type MessageKeyScenario = keyof typeof MESSAGE_KEY_WHY;

/** The one rule a baseline whose bodies carry MessageDTOs gets (see the module comment). */
export function messageSeqAdded(scenario: MessageKeyScenario): AddedKeysRule {
  return {
    kind: 'addedKeys',
    at: MESSAGE_DTO_AT,
    keys: ['seq'],
    mustMatch: true,
    why: `work-k5fk.4 (message key (conversation_id, seq)): ${MESSAGE_KEY_WHY[scenario]}`,
  };
}
