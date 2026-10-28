/**
 * The message store's pure mapping (TS-9): the old single role from the
 * target's role + kind, and a row to the shared MessageDTO.
 *
 * TS-12: the Prisma-mock writer tests are gone. The writer runs on real roles:
 * the participant's own turn on the APP connection and the AI reply on the JOB
 * connection (whose column grants allow reading back only id/created_at) in
 * testing/golden/__tests__/job-path.target.test.ts and
 * services/__tests__/chat-turn.target.test.ts; delivered items into another
 * participant's conversation in share-delivery-retry.target.test.ts.
 */

import { legacyRole, targetRoleAndKind, toMessageDTO, type StoredMessage } from '../message-store';

const row = (over: Partial<StoredMessage> = {}): StoredMessage => ({
  id: 'm1',
  conversationId: 'c-ada',
  senderParticipantId: null,
  role: 'AI',
  kind: 'CHAT',
  content: 'hello',
  refiningNeedId: null,
  sourceAttemptId: null,
  createdAt: new Date('2026-10-26T12:00:00.000Z'),
  senderParticipant: null,
  ...over,
});

describe('message DTO mapping', () => {
  it('keeps the old single role: CHAT rows by role, delivered rows by kind', () => {
    expect(legacyRole('USER', 'CHAT')).toBe('USER');
    expect(legacyRole('AI', 'CHAT')).toBe('AI');
    expect(legacyRole('USER', 'EMPATHY_STATEMENT')).toBe('EMPATHY_STATEMENT');
    expect(targetRoleAndKind('EMPATHY_STATEMENT', true)).toEqual({ role: 'USER', kind: 'EMPATHY_STATEMENT' });
    expect(targetRoleAndKind('SHARE_SUGGESTION', false)).toEqual({ role: 'AI', kind: 'SHARE_SUGGESTION' });
  });

  it("maps a row to the shared MessageDTO: sender's user id, owner's stage at the instant", () => {
    const dto = toMessageDTO(
      row({ role: 'USER', senderParticipantId: 'p-ada', senderParticipant: { userId: 'u-ada' } }),
      {
        sessionId: 's1',
        ownerMilestones: [{ key: 'compact_signed', reachedAt: new Date('2026-10-26T11:00:00.000Z') }],
      },
    );
    expect(dto).toEqual({
      id: 'm1',
      sessionId: 's1',
      senderId: 'u-ada',
      role: 'USER',
      content: 'hello',
      stage: 1,
      timestamp: '2026-10-26T12:00:00.000Z',
    });
  });
});
