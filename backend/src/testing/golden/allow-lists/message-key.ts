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
  'session-read': '',
  'empathy-reveal': '',
  'reflection-never-crosses': '',
  'unrevealed-attempt-hidden': '',
  'reveal-all-ready-ada-first': '',
  'reveal-all-ready-bob-first': '',
  'needs-hidden-until-shared': '',
  'choices-hidden-until-shared': '',
  tombstone: '',
  'author-sees-status-only': '',
  'declined-offer-no-trace': '',
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
