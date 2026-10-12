/**
 * Validation Utils Tests
 */

import {
  uuid,
  nonEmptyString,
  email,
  timestamp,
  paginationParams,
  intensityRating,
  phoneNumber,
  validationApiResponseSchema,
} from '../utils';
import { z } from 'zod';

describe('uuid', () => {
  it('accepts valid UUID', () => {
    const result = uuid.safeParse('550e8400-e29b-41d4-a716-446655440000');
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = uuid.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
  });
});

describe('nonEmptyString', () => {
  it('accepts valid string', () => {
    const schema = nonEmptyString('Name');
    const result = schema.safeParse('John');
    expect(result.success).toBe(true);
  });

  it('rejects empty string', () => {
    const schema = nonEmptyString('Name');
    const result = schema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Name is required');
    }
  });

  it('rejects string over max length', () => {
    const schema = nonEmptyString('Name');
    const result = schema.safeParse('x'.repeat(10001));
    expect(result.success).toBe(false);
  });
});

describe('email', () => {
  it('accepts valid email', () => {
    const result = email.safeParse('test@example.com');
    expect(result.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const result = email.safeParse('not-an-email');
    expect(result.success).toBe(false);
  });
});

describe('timestamp', () => {
  it('accepts ISO 8601 datetime', () => {
    const result = timestamp.safeParse('2024-01-01T00:00:00.000Z');
    expect(result.success).toBe(true);
  });

  it('rejects invalid timestamp', () => {
    const result = timestamp.safeParse('not-a-date');
    expect(result.success).toBe(false);
  });
});

describe('paginationParams', () => {
  it('provides defaults', () => {
    const result = paginationParams.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it('coerces string limit', () => {
    const result = paginationParams.safeParse({ limit: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  it('rejects limit over 100', () => {
    const result = paginationParams.safeParse({ limit: 200 });
    expect(result.success).toBe(false);
  });

  it('accepts cursor', () => {
    const result = paginationParams.safeParse({ cursor: 'next-page' });
    expect(result.success).toBe(true);
  });
});

describe('intensityRating', () => {
  it('accepts 1-10', () => {
    expect(intensityRating.safeParse(1).success).toBe(true);
    expect(intensityRating.safeParse(5).success).toBe(true);
    expect(intensityRating.safeParse(10).success).toBe(true);
  });

  it('rejects 0', () => {
    expect(intensityRating.safeParse(0).success).toBe(false);
  });

  it('rejects 11', () => {
    expect(intensityRating.safeParse(11).success).toBe(false);
  });

  it('rejects non-integer', () => {
    expect(intensityRating.safeParse(5.5).success).toBe(false);
  });
});

describe('phoneNumber', () => {
  it('accepts E.164 format', () => {
    const result = phoneNumber.safeParse('+14155551234');
    expect(result.success).toBe(true);
  });

  it('accepts without plus', () => {
    const result = phoneNumber.safeParse('14155551234');
    expect(result.success).toBe(true);
  });

  it('rejects invalid phone', () => {
    const result = phoneNumber.safeParse('abc');
    expect(result.success).toBe(false);
  });
});

describe('validationApiResponseSchema', () => {
  it('wraps data schema', () => {
    const dataSchema = z.object({ name: z.string() });
    const responseSchema = validationApiResponseSchema(dataSchema);

    const result = responseSchema.safeParse({
      success: true,
      data: { name: 'John' },
    });
    expect(result.success).toBe(true);
  });

  it('requires success: true', () => {
    const dataSchema = z.object({ name: z.string() });
    const responseSchema = validationApiResponseSchema(dataSchema);

    const result = responseSchema.safeParse({
      success: false,
      data: { name: 'John' },
    });
    expect(result.success).toBe(false);
  });
});
