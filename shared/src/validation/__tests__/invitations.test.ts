/**
 * Invitations Validation Tests
 */

import {
  acceptInvitationParamsSchema,
  resendInvitationRequestSchema,
  invitationStatusCheckSchema,
} from '../invitations';

describe('acceptInvitationParamsSchema', () => {
  it('accepts valid UUID', () => {
    const result = acceptInvitationParamsSchema.safeParse({
      invitationId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = acceptInvitationParamsSchema.safeParse({
      invitationId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing invitationId', () => {
    const result = acceptInvitationParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('resendInvitationRequestSchema', () => {
  it('accepts valid UUID', () => {
    const result = resendInvitationRequestSchema.safeParse({
      invitationId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID', () => {
    const result = resendInvitationRequestSchema.safeParse({
      invitationId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});

describe('invitationStatusCheckSchema', () => {
  it('accepts valid statuses', () => {
    expect(invitationStatusCheckSchema.safeParse('pending').success).toBe(true);
    expect(invitationStatusCheckSchema.safeParse('accepted').success).toBe(true);
    expect(invitationStatusCheckSchema.safeParse('expired').success).toBe(true);
    expect(invitationStatusCheckSchema.safeParse('declined').success).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(invitationStatusCheckSchema.safeParse('INVALID').success).toBe(false);
  });
});
