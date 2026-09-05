import crypto from 'crypto';
import {
  encrypt,
  decrypt,
  isEncrypted,
  FieldDecryptionError,
  _resetForTesting,
} from '../field-encryption';

// Generate a deterministic 32-byte key for tests
const TEST_KEY = crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  _resetForTesting();
  process.env.FIELD_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  _resetForTesting();
  delete process.env.FIELD_ENCRYPTION_KEY;
});

describe('field-encryption', () => {
  describe('encrypt / decrypt roundtrip', () => {
    it('roundtrips a simple string', () => {
      const plaintext = 'I feel hurt when you dismiss my feelings.';
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('roundtrips an empty string', () => {
      const encrypted = encrypt('');
      expect(decrypt(encrypted)).toBe('');
    });

    it('roundtrips unicode / emoji content', () => {
      const plaintext = 'Estoy muy triste \u{1F622} \u00BFpor qu\u00E9 me ignoras?';
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('roundtrips a long multi-line string', () => {
      const plaintext = Array.from({ length: 500 }, (_, i) => `Line ${i}: some emotional content here.`).join('\n');
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });
  });

  describe('encrypted output format', () => {
    it('encrypted output differs from plaintext', () => {
      const plaintext = 'My partner never listens.';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
    });

    it('encrypted output starts with the version prefix', () => {
      const encrypted = encrypt('test');
      expect(encrypted).toMatch(/^enc:v1:/);
    });

    it('encrypted output has three base64 segments after prefix', () => {
      const encrypted = encrypt('test');
      const payload = encrypted.slice('enc:v1:'.length);
      const segments = payload.split(':');
      expect(segments).toHaveLength(3);
      // Each segment should be valid base64
      for (const seg of segments) {
        expect(seg.length).toBeGreaterThan(0);
        expect(() => Buffer.from(seg, 'base64')).not.toThrow();
      }
    });
  });

  describe('IV randomness', () => {
    it('produces different ciphertexts for the same plaintext', () => {
      const plaintext = 'Same input every time.';
      const a = encrypt(plaintext);
      const b = encrypt(plaintext);
      expect(a).not.toBe(b);
      // Both should still decrypt correctly
      expect(decrypt(a)).toBe(plaintext);
      expect(decrypt(b)).toBe(plaintext);
    });
  });

  describe('isEncrypted', () => {
    it('returns true for encrypted values', () => {
      const encrypted = encrypt('hello');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('returns false for plaintext', () => {
      expect(isEncrypted('just some text')).toBe(false);
    });

    it('returns false for partial prefix', () => {
      expect(isEncrypted('enc:v1:')).toBe(false);
      expect(isEncrypted('enc:v1:onlyone')).toBe(false);
      expect(isEncrypted('enc:v1:one:two')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isEncrypted('')).toBe(false);
    });
  });

  describe('corrupted data handling', () => {
    it('throws FieldDecryptionError for corrupted ciphertext', () => {
      const encrypted = encrypt('valid content');
      // Mangle the ciphertext portion
      const corrupted = encrypted.slice(0, -4) + 'XXXX';
      expect(() => decrypt(corrupted)).toThrow(FieldDecryptionError);
    });

    it('throws FieldDecryptionError for a tampered auth tag', () => {
      const encrypted = encrypt('valid content');
      const [, , ivB64, authTagB64, ciphertextB64] = encrypted.split(':');
      const tagBuf = Buffer.from(authTagB64, 'base64');
      tagBuf[0] = tagBuf[0] ^ 0xff; // flip every bit of the first tag byte
      const tampered = `enc:v1:${ivB64}:${tagBuf.toString('base64')}:${ciphertextB64}`;
      expect(tampered).not.toBe(encrypted);
      expect(() => decrypt(tampered)).toThrow(FieldDecryptionError);
    });

    it('attaches the underlying error as the cause', () => {
      const encrypted = encrypt('valid content');
      const corrupted = encrypted.slice(0, -4) + 'XXXX';
      let caught: unknown;
      try {
        decrypt(corrupted);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FieldDecryptionError);
      // The underlying crypto error is preserved so the real reason is not lost.
      // (It crosses jest's realm boundary, so `toBeInstanceOf(Error)` is unreliable.)
      const cause = (caught as FieldDecryptionError).cause as Error | undefined;
      expect(cause).toBeDefined();
      expect(typeof cause?.message).toBe('string');
      expect(cause?.message.length).toBeGreaterThan(0);
    });

    it('throws for a truncated encrypted value that still matches the format', () => {
      const encrypted = encrypt('test data that is long enough to survive being chopped in half');
      const truncated = encrypted.slice(0, Math.floor(encrypted.length / 2));
      if (isEncrypted(truncated)) {
        expect(() => decrypt(truncated)).toThrow(FieldDecryptionError);
      } else {
        // Not in encrypted format → treated as legacy plaintext, returned unchanged
        expect(decrypt(truncated)).toBe(truncated);
      }
    });

    it('returns plaintext unchanged if value is not encrypted format', () => {
      expect(decrypt('plain text that was never encrypted')).toBe('plain text that was never encrypted');
    });

    it('returns legacy values that only look prefix-ish unchanged', () => {
      expect(decrypt('enc:v1:onlyone')).toBe('enc:v1:onlyone');
      expect(decrypt('')).toBe('');
    });
  });

  describe('graceful degradation (no key, non-production)', () => {
    beforeEach(() => {
      _resetForTesting();
      delete process.env.FIELD_ENCRYPTION_KEY;
      process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
      delete process.env.NODE_ENV;
    });

    it('encrypt returns plaintext unchanged when no key is set', () => {
      const plaintext = 'sensitive data without encryption';
      expect(encrypt(plaintext)).toBe(plaintext);
    });

    it('decrypt returns input unchanged when no key is set', () => {
      const input = 'enc:v1:abc:def:ghi';
      expect(decrypt(input)).toBe(input);
    });

    it('isEncrypted still detects format even without key', () => {
      expect(isEncrypted('enc:v1:abc:def:ghi')).toBe(true);
      expect(isEncrypted('not encrypted')).toBe(false);
    });
  });

  describe('production without key (test-phase passthrough)', () => {
    beforeEach(() => {
      _resetForTesting();
      delete process.env.FIELD_ENCRYPTION_KEY;
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      process.env.NODE_ENV = 'test';
      delete process.env.REQUIRE_FIELD_ENCRYPTION;
    });

    it('encrypt passes through unchanged when no key is set (default)', () => {
      expect(encrypt('sensitive data')).toBe('sensitive data');
    });

    it('decrypt passes through unchanged when no key is set (default)', () => {
      expect(decrypt('enc:v1:abc:def:ghi')).toBe('enc:v1:abc:def:ghi');
    });

    it('encrypt throws when REQUIRE_FIELD_ENCRYPTION=true and no key', () => {
      process.env.REQUIRE_FIELD_ENCRYPTION = 'true';
      _resetForTesting();
      expect(() => encrypt('sensitive data')).toThrow('REQUIRE_FIELD_ENCRYPTION=true');
    });

    it('decrypt throws when REQUIRE_FIELD_ENCRYPTION=true and no key', () => {
      process.env.REQUIRE_FIELD_ENCRYPTION = 'true';
      _resetForTesting();
      expect(() => decrypt('enc:v1:abc:def:ghi')).toThrow('REQUIRE_FIELD_ENCRYPTION=true');
    });
  });

  describe('key validation', () => {
    it('throws if key is not 32 bytes', () => {
      _resetForTesting();
      process.env.FIELD_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
      expect(() => encrypt('test')).toThrow('must be exactly 32 bytes');
    });
  });

  describe('decryption with wrong key', () => {
    it('throws FieldDecryptionError when decrypting with a different key', () => {
      const encrypted = encrypt('secret content');

      // Switch to a different key
      _resetForTesting();
      process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

      expect(() => decrypt(encrypted)).toThrow(FieldDecryptionError);
    });

    it('never silently yields an empty string for undecryptable content', () => {
      const encrypted = encrypt('secret content');

      _resetForTesting();
      process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

      let result: string | undefined;
      try {
        result = decrypt(encrypted);
      } catch {
        result = undefined;
      }
      expect(result).toBeUndefined();
    });
  });
});
