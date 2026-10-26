/**
 * The message writer (TS-9): every row names its conversation (the
 * audience); the participant's own turn goes through the APP connection with
 * its sender; AI/SYSTEM and delivered rows go through the JOB connection.
 */

const appCreate = jest.fn();
const jobCreate = jest.fn();

jest.mock('../../lib/prisma', () => ({
  prisma: { message: { create: (...a: unknown[]) => appCreate(...a) } },
  getJobPrisma: () => ({ message: { create: (...a: unknown[]) => jobCreate(...a) } }),
}));

import { contentHash } from '../../utils/content-hash';
import {
  createFacilitatorMessage,
  createParticipantMessage,
  deliverMessage,
  legacyRole,
  targetRoleAndKind,
  toMessageDTO,
  type StoredMessage,
} from '../message-store';

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

beforeEach(() => {
  appCreate.mockReset().mockImplementation(async ({ data }) => row({ ...data }));
  jobCreate.mockReset().mockImplementation(async ({ data }) => row({ ...data }));
});

describe('message writer', () => {
  it("writes the participant's own turn on the APP connection, into their conversation, as its sender", async () => {
    await createParticipantMessage({ conversationId: 'c-ada', participantId: 'p-ada', content: 'I feel heard' });
    expect(jobCreate).not.toHaveBeenCalled();
    expect(appCreate).toHaveBeenCalledTimes(1);
    expect(appCreate.mock.calls[0][0].data).toEqual({
      conversationId: 'c-ada',
      senderParticipantId: 'p-ada',
      role: 'USER',
      kind: 'CHAT',
      content: 'I feel heard',
      contentHash: contentHash('I feel heard'),
      refiningNeedId: null,
      sourceAttemptId: null,
    });
  });

  it('writes AI rows on the JOB connection, sender-less, into the named conversation', async () => {
    await createFacilitatorMessage({ conversationId: 'c-ada', content: 'Tell me more.' });
    expect(appCreate).not.toHaveBeenCalled();
    expect(jobCreate).toHaveBeenCalledTimes(1);
    const data = jobCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ conversationId: 'c-ada', senderParticipantId: null, role: 'AI', kind: 'CHAT' });
    expect(data.contentHash).toBe(contentHash('Tell me more.'));
  });

  it('writes SYSTEM rows on the JOB connection too', async () => {
    await createFacilitatorMessage({ conversationId: 'c-bob', role: 'SYSTEM', content: 'note' });
    expect(appCreate).not.toHaveBeenCalled();
    expect(jobCreate.mock.calls[0][0].data).toMatchObject({ conversationId: 'c-bob', role: 'SYSTEM', senderParticipantId: null });
  });

  it("delivers an item into ANOTHER participant's conversation on the JOB connection, authored by the sender", async () => {
    await deliverMessage({
      toConversationId: 'c-bob',
      fromParticipantId: 'p-ada',
      kind: 'EMPATHY_STATEMENT',
      content: 'I understand…',
      sourceAttemptId: 'a1',
    });
    expect(appCreate).not.toHaveBeenCalled();
    expect(jobCreate.mock.calls[0][0].data).toMatchObject({
      conversationId: 'c-bob',
      senderParticipantId: 'p-ada',
      role: 'USER',
      kind: 'EMPATHY_STATEMENT',
      sourceAttemptId: 'a1',
    });
  });

  it('never writes a recipient column: the conversation is the audience', async () => {
    await createParticipantMessage({ conversationId: 'c-ada', participantId: 'p-ada', content: 'x' });
    await createFacilitatorMessage({ conversationId: 'c-ada', content: 'y' });
    for (const call of [...appCreate.mock.calls, ...jobCreate.mock.calls]) {
      expect(Object.keys(call[0].data).sort()).toEqual(
        ['content', 'contentHash', 'conversationId', 'kind', 'refiningNeedId', 'role', 'senderParticipantId', 'sourceAttemptId'].sort(),
      );
    }
  });
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
    const dto = toMessageDTO(row({ role: 'USER', senderParticipantId: 'p-ada', senderParticipant: { userId: 'u-ada' } }), {
      sessionId: 's1',
      ownerMilestones: [{ key: 'compact_signed', reachedAt: new Date('2026-10-26T11:00:00.000Z') }],
    });
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
