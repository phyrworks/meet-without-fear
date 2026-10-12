/**
 * Sessions Contracts Tests
 */

import {
  createSessionRequestSchema,
  listSessionsQuerySchema,
  pauseSessionRequestSchema,
  sendMessageRequestSchema,
  acceptInvitationRequestSchema,
  declineInvitationRequestSchema,
} from '../sessions';
import { SessionStatus } from '../../enums';

describe('createSessionRequestSchema', () => {
  it('accepts personId only', () => {
    const result = createSessionRequestSchema.safeParse({
      personId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
    });
    expect(result.success).toBe(true);
  });

  it('accepts inviteName only', () => {
    const result = createSessionRequestSchema.safeParse({
      inviteName: 'My Partner',
    });
    expect(result.success).toBe(true);
  });

  it('accepts both personId and inviteName', () => {
    const result = createSessionRequestSchema.safeParse({
      personId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
      inviteName: 'My Partner',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty request', () => {
    const result = createSessionRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts optional context', () => {
    const result = createSessionRequestSchema.safeParse({
      inviteName: 'My Partner',
      context: 'We need to discuss finances',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit force-create confirmation', () => {
    const result = createSessionRequestSchema.safeParse({
      personId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
      forceCreate: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-boolean force-create value', () => {
    const result = createSessionRequestSchema.safeParse({
      personId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
      forceCreate: 'true',
    });
    expect(result.success).toBe(false);
  });

  it('rejects context over 500 chars', () => {
    const result = createSessionRequestSchema.safeParse({
      inviteName: 'My Partner',
      context: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe('listSessionsQuerySchema', () => {
  it('accepts empty query with defaults', () => {
    const result = listSessionsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it('accepts valid status filter', () => {
    const result = listSessionsQuerySchema.safeParse({
      status: SessionStatus.ACTIVE,
    });
    expect(result.success).toBe(true);
  });

  it('coerces string limit', () => {
    const result = listSessionsQuerySchema.safeParse({
      limit: '15',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(15);
    }
  });

  it('rejects limit over 50', () => {
    const result = listSessionsQuerySchema.safeParse({
      limit: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects limit below 1', () => {
    const result = listSessionsQuerySchema.safeParse({
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts cursor', () => {
    const result = listSessionsQuerySchema.safeParse({
      cursor: 'next-page-token',
    });
    expect(result.success).toBe(true);
  });
});

describe('pauseSessionRequestSchema', () => {
  it('accepts empty object', () => {
    const result = pauseSessionRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid reason', () => {
    const result = pauseSessionRequestSchema.safeParse({
      reason: 'Need a break',
    });
    expect(result.success).toBe(true);
  });

  it('rejects reason over 200 chars', () => {
    const result = pauseSessionRequestSchema.safeParse({
      reason: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe('sendMessageRequestSchema', () => {
  it('accepts valid message', () => {
    const result = sendMessageRequestSchema.safeParse({
      content: 'Hello, I want to talk about...',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty message', () => {
    const result = sendMessageRequestSchema.safeParse({
      content: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects message over 5000 chars', () => {
    const result = sendMessageRequestSchema.safeParse({
      content: 'x'.repeat(5001),
    });
    expect(result.success).toBe(false);
  });
});

describe('acceptInvitationRequestSchema', () => {
  it('accepts valid UUID', () => {
    const result = acceptInvitationRequestSchema.safeParse({
      invitationId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = acceptInvitationRequestSchema.safeParse({
      invitationId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a cuid (ids are UUIDv7 since cuid_to_uuidv7)', () => {
    const result = acceptInvitationRequestSchema.safeParse({
      invitationId: 'cmv2p1tis0005tj9kwfbbpqfm',
    });
    expect(result.success).toBe(false);
  });
});

describe('declineInvitationRequestSchema', () => {
  it('accepts empty object', () => {
    const result = declineInvitationRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid reason', () => {
    const result = declineInvitationRequestSchema.safeParse({
      reason: 'Not ready yet',
    });
    expect(result.success).toBe(true);
  });

  it('rejects reason over 500 chars', () => {
    const result = declineInvitationRequestSchema.safeParse({
      reason: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });
});
