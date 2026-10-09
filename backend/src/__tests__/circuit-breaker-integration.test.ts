import { PrismaClient } from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../lib/prisma-pg';
import { runReconcilerForDirection, incrementAttempts } from '../services/reconciler';

/**
 * Circuit Breaker Integration Test
 *
 * Tests the full runReconcilerForDirection flow when the circuit breaker trips.
 * Pre-seeds the counter to 3 (simulating 3 prior refinement attempts), then calls
 * runReconcilerForDirection once. Verifies it:
 *   - Skips the AI analysis entirely
 *   - Marks empathy as READY with circuitBreakerTripped=true
 *   - Creates the waiting-state transition message
 *   - Calls checkAndRevealBothIfReady (reveals if both directions are READY)
 *
 * Uses real Prisma against the test DB with mocked Ably (realtime) and empathy-status.
 */

// Mock the realtime module BEFORE importing reconciler
jest.mock('../services/realtime', () => ({
  publishMessageAIResponse: jest.fn().mockResolvedValue(undefined),
  notifyPartner: jest.fn().mockResolvedValue(undefined),
  publishSessionEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/empathy-status', () => ({
  buildEmpathyExchangeStatus: jest.fn().mockResolvedValue({}),
  buildEmpathyExchangeStatusForBothUsers: jest.fn().mockResolvedValue({}),
}));

describe('Circuit Breaker Integration', () => {
  let prisma: PrismaClient;

  // Test IDs - use unique prefix to avoid collisions
  const TEST_PREFIX = 'cb-integ';
  const userAId = `${TEST_PREFIX}-user-a`;
  const userBId = `${TEST_PREFIX}-user-b`;
  const relationshipId = `${TEST_PREFIX}-rel`;
  const sessionId = `${TEST_PREFIX}-session`;

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up in dependency order (most dependent first)
    await prisma.message.deleteMany({ where: { sessionId } });
    await prisma.empathyAttempt.deleteMany({ where: { sessionId } });
    await prisma.refinementAttemptCounter.deleteMany({ where: { sessionId } });
    await prisma.session.deleteMany({ where: { id: sessionId } });
    await prisma.relationshipMember.deleteMany({ where: { relationshipId } });
    await prisma.relationship.deleteMany({ where: { id: relationshipId } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });

    // Create test data
    await prisma.user.createMany({
      data: [
        { id: userAId, email: `${TEST_PREFIX}-a@test.com`, name: 'Alice', firstName: 'Alice' },
        { id: userBId, email: `${TEST_PREFIX}-b@test.com`, name: 'Bob', firstName: 'Bob' },
      ],
    });

    await prisma.relationship.create({
      data: { id: relationshipId },
    });

    await prisma.relationshipMember.createMany({
      data: [
        { relationshipId, userId: userAId },
        { relationshipId, userId: userBId },
      ],
    });

    await prisma.session.create({
      data: {
        id: sessionId,
        relationshipId,
        status: 'ACTIVE',
      },
    });
  });

  afterEach(async () => {
    // Clean up
    await prisma.message.deleteMany({ where: { sessionId } });
    await prisma.empathyAttempt.deleteMany({ where: { sessionId } });
    await prisma.refinementAttemptCounter.deleteMany({ where: { sessionId } });
    await prisma.session.deleteMany({ where: { id: sessionId } });
    await prisma.relationshipMember.deleteMany({ where: { relationshipId } });
    await prisma.relationship.deleteMany({ where: { id: relationshipId } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
  });

  it('circuit breaker trips on 4th attempt and marks empathy READY with transition message', async () => {
    // Create empathy attempt for User A (guesser) - status NEEDS_WORK (about to resubmit)
    await prisma.empathyAttempt.create({
      data: {
        sessionId,
        sourceUserId: userAId,
        content: 'I think Bob feels frustrated about communication issues.',
        status: 'NEEDS_WORK',
        revisionCount: 3,
      },
    });

    // Pre-seed the circuit breaker counter to 3 (simulating 3 prior attempts)
    await prisma.refinementAttemptCounter.create({
      data: {
        sessionId,
        direction: `${userAId}->${userBId}`,
        attempts: 3,
      },
    });

    // Simulate resubmitEmpathy: increment first, then run reconciler
    await incrementAttempts(sessionId, userAId, userBId);

    // Call runReconcilerForDirection — checkAttempts sees 4 and trips
    const result = await runReconcilerForDirection(sessionId, userAId, userBId);

    // Verify return value indicates circuit breaker tripped
    expect(result.result).toBeNull();
    expect(result.empathyStatus).toBe('READY');
    expect(result.shareOffer).toBeNull();

    // Verify empathy attempt status was updated to READY
    const attempt = await prisma.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: userAId },
    });
    expect(attempt?.status).toBe('READY');

    // Verify transition message was created with circuit breaker text
    const messages = await prisma.message.findMany({
      where: { sessionId, forUserId: userAId, role: 'AI' },
      orderBy: { timestamp: 'desc' },
    });
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].content).toContain("you'll both see what each other shared");
    expect(messages[0].content).toContain('Bob');
    // Should NOT contain the normal "quite accurate" message
    expect(messages[0].content).not.toContain('quite accurate');

    // Verify the counter is at 4 (incremented by incrementAttempts)
    const counter = await prisma.refinementAttemptCounter.findUnique({
      where: { sessionId_direction: { sessionId, direction: `${userAId}->${userBId}` } },
    });
    expect(counter?.attempts).toBe(4);

    // Verify Ably was called (message published to guesser)
    const { publishMessageAIResponse } = require('../services/realtime');
    expect(publishMessageAIResponse).toHaveBeenCalledWith(
      sessionId,
      userAId,
      expect.objectContaining({
        content: expect.stringContaining("you'll both see what each other shared"),
      }),
      expect.anything()
    );
  });

  it('circuit breaker reveals empathy when BOTH directions are READY', async () => {
    // Create empathy attempts for BOTH directions
    await prisma.empathyAttempt.createMany({
      data: [
        {
          sessionId,
          sourceUserId: userAId,
          content: 'I think Bob feels frustrated.',
          status: 'NEEDS_WORK',
          revisionCount: 3,
        },
        {
          sessionId,
          sourceUserId: userBId,
          content: 'I think Alice feels unappreciated.',
          status: 'READY', // B's direction already READY
        },
      ],
    });

    // Pre-seed circuit breaker for A→B direction
    await prisma.refinementAttemptCounter.create({
      data: {
        sessionId,
        direction: `${userAId}->${userBId}`,
        attempts: 3,
      },
    });

    // Simulate resubmitEmpathy: increment first, then run reconciler
    await incrementAttempts(sessionId, userAId, userBId);

    // Trip the circuit breaker for A→B — B→A is already READY
    const result = await runReconcilerForDirection(sessionId, userAId, userBId);
    expect(result.empathyStatus).toBe('READY');

    // Both directions should now be REVEALED (checkAndRevealBothIfReady ran)
    const attempts = await prisma.empathyAttempt.findMany({
      where: { sessionId },
    });

    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('REVEALED');
      expect(attempt.revealedAt).not.toBeNull();
      expect(attempt.deliveryStatus).toBe('DELIVERED');
      expect(attempt.deliveredAt).not.toBeNull();
    }

    // Verify Ably notifications were sent for empathy reveal
    const { notifyPartner } = require('../services/realtime');
    expect(notifyPartner).toHaveBeenCalledWith(
      sessionId,
      expect.any(String),
      'empathy.revealed',
      expect.objectContaining({ direction: 'outgoing' })
    );
  });

  it('circuit breaker does NOT reveal when other direction is still AWAITING_SHARING', async () => {
    // Create empathy attempts — A is about to trip, B is still AWAITING_SHARING
    await prisma.empathyAttempt.createMany({
      data: [
        {
          sessionId,
          sourceUserId: userAId,
          content: 'I think Bob feels frustrated.',
          status: 'NEEDS_WORK',
          revisionCount: 3,
        },
        {
          sessionId,
          sourceUserId: userBId,
          content: 'I think Alice feels unappreciated.',
          status: 'AWAITING_SHARING', // B's direction NOT ready
        },
      ],
    });

    // Pre-seed circuit breaker for A→B direction
    await prisma.refinementAttemptCounter.create({
      data: {
        sessionId,
        direction: `${userAId}->${userBId}`,
        attempts: 3,
      },
    });

    // Simulate resubmitEmpathy: increment first, then run reconciler
    await incrementAttempts(sessionId, userAId, userBId);

    // Trip the circuit breaker for A→B
    await runReconcilerForDirection(sessionId, userAId, userBId);

    // A should be READY, but B should still be AWAITING_SHARING
    const attemptA = await prisma.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: userAId },
    });
    const attemptB = await prisma.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: userBId },
    });

    expect(attemptA?.status).toBe('READY'); // Circuit breaker forced READY
    expect(attemptB?.status).toBe('AWAITING_SHARING'); // Unchanged — NOT revealed
  });

  it('3rd attempt does NOT trip circuit breaker (still runs reconciler)', async () => {
    // Pre-seed counter to 2 (simulating 2 prior attempts)
    await prisma.refinementAttemptCounter.create({
      data: {
        sessionId,
        direction: `${userAId}->${userBId}`,
        attempts: 2,
      },
    });

    // Create empathy attempt
    await prisma.empathyAttempt.create({
      data: {
        sessionId,
        sourceUserId: userAId,
        content: 'I think Bob feels frustrated.',
        status: 'NEEDS_WORK',
      },
    });

    // Simulate resubmitEmpathy: increment first (2 -> 3), then run reconciler
    await incrementAttempts(sessionId, userAId, userBId);

    // checkAttempts sees 3, which is not > 3, so circuit breaker does NOT trip.
    // runReconcilerForDirection will try to run the full reconciler analysis
    // which needs witnessing content. Since we don't have it, it should throw
    // (proving the circuit breaker did NOT fire and the function tried to proceed)
    await expect(
      runReconcilerForDirection(sessionId, userAId, userBId)
    ).rejects.toThrow(); // Throws because it tried to run the full reconciler (no test data for it)

    // Empathy attempt should NOT have been changed to READY
    const attempt = await prisma.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: userAId },
    });
    expect(attempt?.status).toBe('NEEDS_WORK');
  });
});
