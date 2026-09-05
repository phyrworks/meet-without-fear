import crypto from 'crypto';
import {
  encryptDataFields,
  decryptRecordFields,
  applyFieldEncryption,
  SENSITIVE_FIELD_MAP,
} from '../prisma-encryption-middleware';
import {
  encrypt,
  decrypt,
  isEncrypted,
  FieldDecryptionError,
  _resetForTesting,
} from '../../utils/field-encryption';
import { contentHash } from '../../utils/content-hash';

const TEST_KEY = crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  _resetForTesting();
  process.env.FIELD_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  _resetForTesting();
  delete process.env.FIELD_ENCRYPTION_KEY;
});

describe('prisma-encryption-middleware', () => {
  describe('SENSITIVE_FIELD_MAP', () => {
    it('covers all 9 models from the security audit', () => {
      const expectedModels = [
        'Message',
        'InnerWorkMessage',
        'UserVessel',
        'Boundary',
        'UserDocument',
        'EmpathyDraft',
        'EmpathyAttempt',
        'GratitudeEntry',
        'User',
      ];
      for (const model of expectedModels) {
        expect(SENSITIVE_FIELD_MAP).toHaveProperty(model);
      }
    });

    it('maps Message.content as a string field', () => {
      expect(SENSITIVE_FIELD_MAP.Message.stringFields).toContain('content');
    });

    it('maps UserVessel.notableFacts as a JSON field', () => {
      expect(SENSITIVE_FIELD_MAP.UserVessel.jsonFields).toContain('notableFacts');
    });

    it('maps User.globalFacts as a JSON field', () => {
      expect(SENSITIVE_FIELD_MAP.User.jsonFields).toContain('globalFacts');
    });
  });

  describe('encryptDataFields', () => {
    const messageConfig = SENSITIVE_FIELD_MAP.Message;

    it('encrypts string fields in place', () => {
      const data: Record<string, unknown> = { content: 'I feel hurt', role: 'USER' };
      encryptDataFields(data, messageConfig);

      expect(data.content).not.toBe('I feel hurt');
      expect(isEncrypted(data.content as string)).toBe(true);
      expect(data.role).toBe('USER'); // non-sensitive field unchanged
    });

    it('skips null/undefined values', () => {
      const data: Record<string, unknown> = { content: null, role: 'USER' };
      encryptDataFields(data, messageConfig);
      expect(data.content).toBeNull();
    });

    it('skips fields not present in the data object', () => {
      const data: Record<string, unknown> = { role: 'USER' };
      encryptDataFields(data, messageConfig);
      expect(data).toEqual({ role: 'USER' });
    });

    it('encrypts JSON fields by serializing then encrypting', () => {
      const config = SENSITIVE_FIELD_MAP.User;
      const facts = { people: ['Alice'], emotions: ['frustrated'] };
      const data: Record<string, unknown> = { globalFacts: facts, name: 'test' };

      encryptDataFields(data, config);

      expect(typeof data.globalFacts).toBe('string');
      expect(isEncrypted(data.globalFacts as string)).toBe(true);
      expect(data.name).toBe('test');
    });

    it('skips null JSON fields', () => {
      const config = SENSITIVE_FIELD_MAP.User;
      const data: Record<string, unknown> = { globalFacts: null };
      encryptDataFields(data, config);
      expect(data.globalFacts).toBeNull();
    });
  });

  describe('decryptRecordFields', () => {
    const messageConfig = SENSITIVE_FIELD_MAP.Message;

    it('decrypts encrypted string fields in place', () => {
      const encrypted = encrypt('I feel hurt');
      const record: Record<string, unknown> = { content: encrypted, role: 'USER' };

      decryptRecordFields(record, messageConfig);

      expect(record.content).toBe('I feel hurt');
      expect(record.role).toBe('USER');
    });

    it('passes through plaintext string fields (legacy data)', () => {
      const record: Record<string, unknown> = { content: 'legacy plaintext', role: 'USER' };
      decryptRecordFields(record, messageConfig);
      expect(record.content).toBe('legacy plaintext');
    });

    it('decrypts encrypted JSON fields back to objects', () => {
      const config = SENSITIVE_FIELD_MAP.User;
      const facts = { people: ['Alice'], emotions: ['frustrated'] };
      const encryptedJson = encrypt(JSON.stringify(facts));
      const record: Record<string, unknown> = { globalFacts: encryptedJson };

      decryptRecordFields(record, config);

      expect(record.globalFacts).toEqual(facts);
    });

    it('leaves unencrypted JSON objects as-is (legacy data)', () => {
      const config = SENSITIVE_FIELD_MAP.User;
      const facts = { people: ['Alice'] };
      const record: Record<string, unknown> = { globalFacts: facts };

      decryptRecordFields(record, config);

      expect(record.globalFacts).toEqual(facts);
    });

    it('handles null fields gracefully', () => {
      const record: Record<string, unknown> = { content: null };
      decryptRecordFields(record, messageConfig);
      expect(record.content).toBeNull();
    });
  });

  describe('roundtrip encrypt → decrypt', () => {
    it('roundtrips string fields correctly', () => {
      const config = SENSITIVE_FIELD_MAP.Message;
      const original = 'My partner dismissed my feelings again.';
      const data: Record<string, unknown> = { content: original, role: 'USER' };

      encryptDataFields(data, config);
      expect(data.content).not.toBe(original);

      decryptRecordFields(data, config);
      expect(data.content).toBe(original);
    });

    it('roundtrips JSON fields correctly', () => {
      const config = SENSITIVE_FIELD_MAP.UserVessel;
      const facts = [
        { id: '1', category: 'relationship', fact: 'Partner is Alice' },
        { id: '2', category: 'emotion', fact: 'Feels unheard' },
      ];
      const data: Record<string, unknown> = {
        notableFacts: facts,
        conversationSummary: 'User expressed frustration',
      };

      encryptDataFields(data, config);
      expect(isEncrypted(data.notableFacts as string)).toBe(true);
      expect(isEncrypted(data.conversationSummary as string)).toBe(true);

      decryptRecordFields(data, config);
      expect(data.notableFacts).toEqual(facts);
      expect(data.conversationSummary).toBe('User expressed frustration');
    });

    it('roundtrips all 9 models', () => {
      for (const [model, config] of Object.entries(SENSITIVE_FIELD_MAP)) {
        const data: Record<string, unknown> = {};

        for (const field of config.stringFields) {
          data[field] = `test content for ${model}.${field}`;
        }
        for (const field of config.jsonFields) {
          data[field] = { test: true, model, field };
        }

        const original = { ...data };
        for (const field of config.jsonFields) {
          original[field] = { ...data[field] as object };
        }

        encryptDataFields(data, config);
        decryptRecordFields(data, config);

        for (const field of config.stringFields) {
          expect(data[field]).toBe(original[field]);
        }
        for (const field of config.jsonFields) {
          expect(data[field]).toEqual(original[field]);
        }
      }
    });
  });

  describe('graceful degradation (no key)', () => {
    beforeEach(() => {
      _resetForTesting();
      delete process.env.FIELD_ENCRYPTION_KEY;
    });

    it('encrypt passes through when no key is set', () => {
      const config = SENSITIVE_FIELD_MAP.Message;
      const data: Record<string, unknown> = { content: 'plaintext' };

      encryptDataFields(data, config);

      expect(data.content).toBe('plaintext');
    });

    it('decrypt passes through when no key is set', () => {
      const config = SENSITIVE_FIELD_MAP.Message;
      const record: Record<string, unknown> = { content: 'plaintext' };

      decryptRecordFields(record, config);

      expect(record.content).toBe('plaintext');
    });

    it('JSON fields pass through unchanged when no key is set', () => {
      const config = SENSITIVE_FIELD_MAP.User;
      const facts = { people: ['Alice'] };
      const data: Record<string, unknown> = { globalFacts: facts };

      encryptDataFields(data, config);

      expect(data.globalFacts).toEqual(facts);
    });
  });

  describe('mixed encrypted/plaintext data handling', () => {
    it('decrypts encrypted values and passes through plaintext', () => {
      const config = SENSITIVE_FIELD_MAP.Message;
      const encrypted = encrypt('encrypted message');
      const records = [
        { content: encrypted, role: 'USER' },
        { content: 'legacy plaintext', role: 'AI' },
      ];

      for (const record of records) {
        decryptRecordFields(record as Record<string, unknown>, config);
      }

      expect(records[0].content).toBe('encrypted message');
      expect(records[1].content).toBe('legacy plaintext');
    });
  });

  describe('contentHash on write', () => {
    const captured: Array<Record<string, unknown>> = [];
    const query = async (args: Record<string, unknown>) => {
      captured.push(args);
      return null;
    };

    beforeEach(() => {
      captured.length = 0;
    });

    it('writes contentHash alongside the encrypted content on create', async () => {
      const args: Record<string, unknown> = {
        data: { sessionId: 's1', role: 'AI', content: 'a system message', stage: 2 },
      };
      await applyFieldEncryption({ model: 'Message', operation: 'create', args, query });

      const data = (captured[0].data as Record<string, unknown>);
      expect(data.contentHash).toBe(contentHash('a system message'));
      expect(isEncrypted(data.content as string)).toBe(true);
    });

    it('writes contentHash even when no encryption key is configured', async () => {
      _resetForTesting();
      delete process.env.FIELD_ENCRYPTION_KEY;

      const args: Record<string, unknown> = { data: { content: 'a system message' } };
      await applyFieldEncryption({ model: 'Message', operation: 'create', args, query });

      const data = (captured[0].data as Record<string, unknown>);
      expect(data.contentHash).toBe(contentHash('a system message'));
      expect(data.content).toBe('a system message');
    });

    it('writes contentHash for every row of a createMany', async () => {
      const args: Record<string, unknown> = {
        data: [{ content: 'first' }, { content: 'second' }],
      };
      await applyFieldEncryption({ model: 'Message', operation: 'createMany', args, query });

      const rows = captured[0].data as Array<Record<string, unknown>>;
      expect(rows[0].contentHash).toBe(contentHash('first'));
      expect(rows[1].contentHash).toBe(contentHash('second'));
      expect(rows[0].contentHash).not.toBe(rows[1].contentHash);
    });

    it('refreshes contentHash when content is updated', async () => {
      const args: Record<string, unknown> = {
        where: { id: 'm1' },
        data: { content: 'edited content' },
      };
      await applyFieldEncryption({ model: 'Message', operation: 'update', args, query });

      const data = (captured[0].data as Record<string, unknown>);
      expect(data.contentHash).toBe(contentHash('edited content'));
    });

    it('writes contentHash on both branches of an upsert', async () => {
      const args: Record<string, unknown> = {
        where: { id: 'm1' },
        create: { content: 'created' },
        update: { content: 'updated' },
      };
      await applyFieldEncryption({ model: 'Message', operation: 'upsert', args, query });

      expect((captured[0].create as Record<string, unknown>).contentHash).toBe(
        contentHash('created'),
      );
      expect((captured[0].update as Record<string, unknown>).contentHash).toBe(
        contentHash('updated'),
      );
    });

    it('leaves contentHash alone on an update that does not touch content', async () => {
      const args: Record<string, unknown> = { where: { id: 'm1' }, data: { stage: 3 } };
      await applyFieldEncryption({ model: 'Message', operation: 'update', args, query });

      expect(captured[0].data).not.toHaveProperty('contentHash');
    });

    it('does not add contentHash to models without a hashed field', async () => {
      const args: Record<string, unknown> = { data: { content: 'inner work content' } };
      await applyFieldEncryption({ model: 'InnerWorkMessage', operation: 'create', args, query });

      expect(captured[0].data).not.toHaveProperty('contentHash');
    });
  });

  describe('undecryptable data propagates instead of becoming empty', () => {
    it('decryptRecordFields throws on a string field encrypted under another key', () => {
      const config = SENSITIVE_FIELD_MAP.Message;
      const record: Record<string, unknown> = { content: encrypt('secret message'), role: 'AI' };

      // Simulate a key rotation gone wrong: the row was written under a key we no longer hold.
      _resetForTesting();
      process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

      expect(() => decryptRecordFields(record, config)).toThrow(FieldDecryptionError);
      // The caller must never observe the row silently emptied.
      expect(record.content).not.toBe('');
    });

    it('decryptRecordFields throws on a JSON field encrypted under another key', () => {
      const config = SENSITIVE_FIELD_MAP.UserVessel;
      const record: Record<string, unknown> = {
        notableFacts: JSON.parse(JSON.stringify([{ fact: 'they value honesty' }])),
      };
      encryptDataFields(record, config);

      _resetForTesting();
      process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

      expect(() => decryptRecordFields(record, config)).toThrow(FieldDecryptionError);
      expect(record.notableFacts).not.toBeNull();
    });

    it('the middleware read path propagates the decryption failure', async () => {
      const row = { id: 'm1', content: encrypt('secret message'), role: 'AI' };

      _resetForTesting();
      process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

      await expect(
        applyFieldEncryption({
          model: 'Message',
          operation: 'findFirst',
          args: { where: { id: 'm1' } },
          query: async () => row,
        }),
      ).rejects.toThrow(FieldDecryptionError);
    });

    it('the middleware read path propagates a failure inside a findMany batch', async () => {
      const rows = [
        { id: 'm1', content: encrypt('first') },
        { id: 'm2', content: encrypt('second') },
      ];

      _resetForTesting();
      process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

      await expect(
        applyFieldEncryption({
          model: 'Message',
          operation: 'findMany',
          args: {},
          query: async () => rows,
        }),
      ).rejects.toThrow(FieldDecryptionError);
    });

    it('the middleware leaves unmapped models untouched', async () => {
      const row = { id: 's1', status: 'ACTIVE' };
      await expect(
        applyFieldEncryption({
          model: 'Session',
          operation: 'findFirst',
          args: {},
          query: async () => row,
        }),
      ).resolves.toBe(row);
    });
  });
});
