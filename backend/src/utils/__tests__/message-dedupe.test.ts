import crypto from 'crypto';
import { contentHash } from '../content-hash';
import { findMessageByContent } from '../message-dedupe';
import { applyFieldEncryption } from '../../lib/prisma-encryption-middleware';
import { isEncrypted, _resetForTesting } from '../field-encryption';

describe('contentHash', () => {
  it('is the SHA-256 hex digest of the plaintext', () => {
    const plaintext = "We'll hold here while your partner reviews what you shared.";
    expect(contentHash(plaintext)).toBe(
      crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex'),
    );
  });

  it('is 64 lowercase hex characters', () => {
    expect(contentHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(contentHash('same input')).toBe(contentHash('same input'));
  });

  it('differs for different inputs', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });

  it('hashes the empty string without throwing', () => {
    expect(contentHash('')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across unicode content', () => {
    const plaintext = 'Estoy muy triste \u{1F622}';
    expect(contentHash(plaintext)).toBe(
      crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex'),
    );
  });
});

describe('findMessageByContent', () => {
  function fakeDelegate(rows: Array<Record<string, unknown>>) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      findFirst: jest.fn(async (args: Record<string, unknown>) => {
        calls.push(args);
        const where = args.where as Record<string, unknown>;
        const match = rows.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        );
        return match ? { id: match.id as string } : null;
      }),
    };
  }

  const criteria = {
    sessionId: 'sess-1',
    forUserId: 'user-1',
    role: 'AI',
    content: 'We will hold here while your partner reviews what you shared.',
  };

  it('probes on contentHash, not on the encrypted content column', async () => {
    const delegate = fakeDelegate([]);
    await findMessageByContent(delegate, criteria);

    const where = delegate.calls[0].where as Record<string, unknown>;
    expect(where).toEqual({
      sessionId: 'sess-1',
      forUserId: 'user-1',
      role: 'AI',
      contentHash: contentHash(criteria.content),
    });
    expect(where).not.toHaveProperty('content');
  });

  it('finds an existing row whose contentHash matches', async () => {
    const delegate = fakeDelegate([
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        forUserId: 'user-1',
        role: 'AI',
        contentHash: contentHash(criteria.content),
      },
    ]);

    await expect(findMessageByContent(delegate, criteria)).resolves.toEqual({ id: 'msg-1' });
  });

  it('does not match a row with different content', async () => {
    const delegate = fakeDelegate([
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        forUserId: 'user-1',
        role: 'AI',
        contentHash: contentHash('a completely different system message'),
      },
    ]);

    await expect(findMessageByContent(delegate, criteria)).resolves.toBeNull();
  });

  it('does not match the same content in a different session', async () => {
    const delegate = fakeDelegate([
      {
        id: 'msg-1',
        sessionId: 'other-session',
        forUserId: 'user-1',
        role: 'AI',
        contentHash: contentHash(criteria.content),
      },
    ]);

    await expect(findMessageByContent(delegate, criteria)).resolves.toBeNull();
  });

  it('does not match the same content addressed to a different user', async () => {
    const delegate = fakeDelegate([
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        forUserId: 'other-user',
        role: 'AI',
        contentHash: contentHash(criteria.content),
      },
    ]);

    await expect(findMessageByContent(delegate, criteria)).resolves.toBeNull();
  });

  it('selects only the id — it never reads the encrypted content back', async () => {
    const delegate = fakeDelegate([]);
    await findMessageByContent(delegate, criteria);
    expect(delegate.calls[0].select).toEqual({ id: true });
  });
});

/**
 * The round trip that actually matters: the hash the encryption middleware writes
 * on create must be the hash the probe looks for. Tested against an in-memory
 * stand-in for the Message table, with encryption on, so the ciphertext really is
 * different on every write.
 */
describe('insert-once dedupe round trip (middleware write -> probe read)', () => {
  const TEST_KEY = crypto.randomBytes(32).toString('base64');

  beforeEach(() => {
    _resetForTesting();
    process.env.FIELD_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    _resetForTesting();
    delete process.env.FIELD_ENCRYPTION_KEY;
  });

  function fakeMessageTable() {
    const rows: Array<Record<string, unknown>> = [];
    let nextId = 1;

    const delegate = {
      rows,
      findFirst: (args: { where: Record<string, unknown>; select: { id: true } }) =>
        applyFieldEncryption({
          model: 'Message',
          operation: 'findFirst',
          args: args as unknown as Record<string, unknown>,
          query: async (a) => {
            const where = (a.where ?? {}) as Record<string, unknown>;
            const match = rows.find((row) =>
              Object.entries(where).every(([key, value]) => row[key] === value),
            );
            return match ? { id: match.id } : null;
          },
        }) as Promise<{ id: string } | null>,
      create: (args: { data: Record<string, unknown> }) =>
        applyFieldEncryption({
          model: 'Message',
          operation: 'create',
          args: args as unknown as Record<string, unknown>,
          query: async (a) => {
            const row = { id: `m${nextId++}`, ...(a.data as Record<string, unknown>) };
            rows.push(row);
            return { ...row };
          },
        }),
    };
    return delegate;
  }

  const base = { sessionId: 'sess-1', forUserId: 'user-1', role: 'AI' };
  const systemMessage = "We'll hold here while your partner reviews what you shared.";

  /** The shape both controller probes now use. */
  async function createOnce(
    table: ReturnType<typeof fakeMessageTable>,
    content: string,
  ): Promise<boolean> {
    const existing = await findMessageByContent(table, { ...base, content });
    if (existing) return false;
    await table.create({ data: { ...base, content, stage: 2 } });
    return true;
  }

  it('writes the row once and skips the second attempt', async () => {
    const table = fakeMessageTable();

    await expect(createOnce(table, systemMessage)).resolves.toBe(true);
    await expect(createOnce(table, systemMessage)).resolves.toBe(false);
    await expect(createOnce(table, systemMessage)).resolves.toBe(false);

    expect(table.rows).toHaveLength(1);
  });

  it('stores the content encrypted while the hash stays deterministic', async () => {
    const table = fakeMessageTable();
    await createOnce(table, systemMessage);

    const row = table.rows[0];
    expect(isEncrypted(row.content as string)).toBe(true);
    expect(row.content).not.toBe(systemMessage);
    expect(row.contentHash).toBe(contentHash(systemMessage));
  });

  it('would NOT have deduped on content equality — the regression this guards', async () => {
    const table = fakeMessageTable();
    await createOnce(table, systemMessage);

    // The old probe compared the ciphertext column to the plaintext.
    const oldStyleMatch = table.rows.find((row) => row.content === systemMessage);
    expect(oldStyleMatch).toBeUndefined();
  });

  it('still inserts a genuinely different system message', async () => {
    const table = fakeMessageTable();

    await expect(createOnce(table, systemMessage)).resolves.toBe(true);
    await expect(createOnce(table, 'A different handoff bridge message.')).resolves.toBe(true);

    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].contentHash).not.toBe(table.rows[1].contentHash);
  });

  it('dedupes identically when no encryption key is configured', async () => {
    _resetForTesting();
    delete process.env.FIELD_ENCRYPTION_KEY;

    const table = fakeMessageTable();
    await expect(createOnce(table, systemMessage)).resolves.toBe(true);
    await expect(createOnce(table, systemMessage)).resolves.toBe(false);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].content).toBe(systemMessage);
    expect(table.rows[0].contentHash).toBe(contentHash(systemMessage));
  });

  it('does not dedupe a legacy row with a NULL contentHash (accepted, documented)', async () => {
    const table = fakeMessageTable();
    // A row written before the contentHash column existed.
    table.rows.push({ id: 'legacy', ...base, content: 'ciphertext-from-before', contentHash: null });

    await expect(createOnce(table, systemMessage)).resolves.toBe(true);
    expect(table.rows).toHaveLength(2);
  });
});
