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

import crypto from 'crypto';
import type { DbClient } from '../../lib/prisma';
import { _resetForTesting, decrypt, isEncrypted } from '../../utils/field-encryption';
import {
  createFacilitatorMessageOnce,
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
        ownerInvitationPending: false,
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

/**
 * work-fdc1: the once-only writer is one INSERT … ON CONFLICT DO NOTHING
 * RETURNING, so a duplicate is an empty result (null), never an error that
 * would abort a caller's transaction; real errors propagate. DB-less: a fake
 * client records the statement. The real-role behaviour (one row under
 * concurrency) is message-once-stage4.target.test.ts.
 */
describe('createFacilitatorMessageOnce (DB-less)', () => {
  const fake = (impl: () => Promise<unknown>) => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('$?'), values });
        return impl();
      }),
    } as unknown as DbClient;
    return { client, calls };
  };
  afterEach(() => {
    _resetForTesting();
    delete process.env.FIELD_ENCRYPTION_KEY;
  });

  it('writes the row and returns it; a conflict is absorbed by ON CONFLICT DO NOTHING, not raised', async () => {
    const at = new Date('2026-11-11T10:00:00.000Z');
    const { client, calls } = fake(async () => [{ id: 'm-1', created_at: at }]);
    const row = await createFacilitatorMessageOnce({
      conversationId: 'c-ada',
      dedupeKey: 'STAGE4_HANDOFF_BRIDGE',
      content: 'bridge',
      client,
    });
    expect(row).toEqual({
      id: 'm-1',
      conversationId: 'c-ada',
      senderParticipantId: null,
      role: 'AI',
      kind: 'CHAT',
      content: 'bridge',
      refiningNeedId: null,
      sourceAttemptId: null,
      createdAt: at,
      senderParticipant: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql.replace(/\s+/g, ' ')).toContain('ON CONFLICT DO NOTHING RETURNING id, created_at');
    expect(calls[0].values).toEqual(['c-ada', 'bridge', 'STAGE4_HANDOFF_BRIDGE', null]);
  });

  it('a conflict (no row returned) is null', async () => {
    const { client } = fake(async () => []);
    await expect(
      createFacilitatorMessageOnce({ conversationId: 'c-ada', dedupeKey: 'STAGE2_VALIDATED_WAIT', content: 'x', client }),
    ).resolves.toBeNull();
  });

  it('any other error is rethrown, P2002 included (the statement cannot raise one for the key)', async () => {
    for (const err of [Object.assign(new Error('boom'), { code: 'P2010' }), Object.assign(new Error('dup'), { code: 'P2002' })]) {
      const { client } = fake(async () => {
        throw err;
      });
      await expect(
        createFacilitatorMessageOnce({ conversationId: 'c-ada', dedupeKey: 'STAGE2_VALIDATED_WAIT', content: 'x', client }),
      ).rejects.toBe(err);
    }
  });

  it('binds the content sealed, as the Prisma extension would (key set)', async () => {
    process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    _resetForTesting();
    const { client, calls } = fake(async () => [{ id: 'm-2', created_at: new Date() }]);
    const row = await createFacilitatorMessageOnce({
      conversationId: 'c-ada',
      dedupeKey: 'STAGE2_VALIDATED_WAIT',
      content: 'PROBE_FDC1_SEALED',
      client,
    });
    const bound = calls[0].values[1] as string;
    expect(isEncrypted(bound)).toBe(true);
    expect(decrypt(bound)).toBe('PROBE_FDC1_SEALED');
    expect(row?.content).toBe('PROBE_FDC1_SEALED');
  });
});
