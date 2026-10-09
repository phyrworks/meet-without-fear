import { PrismaClient } from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../lib/prisma-pg';
import { checkAttempts, incrementAttempts } from '../services/reconciler';

/**
 * Circuit Breaker Tests
 *
 * Tests the refinement attempt counter that prevents infinite refinement loops.
 * The circuit breaker limits empathy refinement attempts to 3 per direction.
 *
 * checkAttempts is read-only (used by reconciler runs).
 * incrementAttempts is write-only (called only from resubmitEmpathy).
 */
describe('Circuit Breaker', () => {
  let prisma: PrismaClient;
  const TEST_PREFIX = 'cb-unit';
  const testSessionId = `${TEST_PREFIX}-session`;
  const userAId = `${TEST_PREFIX}-user-a`;
  const userBId = `${TEST_PREFIX}-user-b`;
  const relationshipId = `${TEST_PREFIX}-rel`;

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up in dependency order
    await prisma.refinementAttemptCounter.deleteMany({ where: { sessionId: testSessionId } });
    await prisma.session.deleteMany({ where: { id: testSessionId } });
    await prisma.relationshipMember.deleteMany({ where: { relationshipId } });
    await prisma.relationship.deleteMany({ where: { id: relationshipId } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });

    // Create required parent records for FK constraint
    await prisma.user.createMany({
      data: [
        { id: userAId, email: `${TEST_PREFIX}-a@test.com`, name: 'Alice', firstName: 'Alice' },
        { id: userBId, email: `${TEST_PREFIX}-b@test.com`, name: 'Bob', firstName: 'Bob' },
      ],
    });
    await prisma.relationship.create({ data: { id: relationshipId } });
    await prisma.relationshipMember.createMany({
      data: [
        { relationshipId, userId: userAId },
        { relationshipId, userId: userBId },
      ],
    });
    await prisma.session.create({
      data: { id: testSessionId, relationshipId, status: 'ACTIVE' },
    });
  });

  afterEach(async () => {
    // Clean up in dependency order
    await prisma.refinementAttemptCounter.deleteMany({ where: { sessionId: testSessionId } });
    await prisma.session.deleteMany({ where: { id: testSessionId } });
    await prisma.relationshipMember.deleteMany({ where: { relationshipId } });
    await prisma.relationship.deleteMany({ where: { id: relationshipId } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
  });

  describe('checkAttempts (read-only)', () => {
    it('returns shouldSkip=false with attempts=0 when no counter exists', async () => {
      const result = await checkAttempts(testSessionId, userAId, userBId);

      expect(result.shouldSkipReconciler).toBe(false);
      expect(result.attempts).toBe(0);
    });

    it('does not create or modify the counter', async () => {
      // Check twice — should not create a counter
      await checkAttempts(testSessionId, userAId, userBId);
      await checkAttempts(testSessionId, userAId, userBId);

      const direction = `${userAId}->${userBId}`;
      const counter = await prisma.refinementAttemptCounter.findUnique({
        where: { sessionId_direction: { sessionId: testSessionId, direction } },
      });

      expect(counter).toBeNull();
    });
  });

  describe('incrementAttempts (write-only)', () => {
    it('creates counter with attempts=1 on first call', async () => {
      await incrementAttempts(testSessionId, userAId, userBId);

      const result = await checkAttempts(testSessionId, userAId, userBId);
      expect(result.attempts).toBe(1);
      expect(result.shouldSkipReconciler).toBe(false);
    });

    it('third increment results in shouldSkip=false', async () => {
      await incrementAttempts(testSessionId, userAId, userBId);
      await incrementAttempts(testSessionId, userAId, userBId);
      await incrementAttempts(testSessionId, userAId, userBId);

      const result = await checkAttempts(testSessionId, userAId, userBId);
      expect(result.shouldSkipReconciler).toBe(false);
      expect(result.attempts).toBe(3);
    });

    it('fourth increment results in shouldSkip=true', async () => {
      await incrementAttempts(testSessionId, userAId, userBId);
      await incrementAttempts(testSessionId, userAId, userBId);
      await incrementAttempts(testSessionId, userAId, userBId);
      await incrementAttempts(testSessionId, userAId, userBId);

      const result = await checkAttempts(testSessionId, userAId, userBId);
      expect(result.shouldSkipReconciler).toBe(true);
      expect(result.attempts).toBe(4);
    });

    it('tracks directions independently', async () => {
      // Increment 3 times for direction A->B
      await incrementAttempts(testSessionId, userAId, userBId);
      await incrementAttempts(testSessionId, userAId, userBId);
      await incrementAttempts(testSessionId, userAId, userBId);

      // Direction B->A should still be at 0
      const result = await checkAttempts(testSessionId, userBId, userAId);
      expect(result.shouldSkipReconciler).toBe(false);
      expect(result.attempts).toBe(0);
    });

    it('persists across function calls', async () => {
      await incrementAttempts(testSessionId, userAId, userBId);
      const result1 = await checkAttempts(testSessionId, userAId, userBId);
      expect(result1.attempts).toBe(1);

      await incrementAttempts(testSessionId, userAId, userBId);
      const result2 = await checkAttempts(testSessionId, userAId, userBId);
      expect(result2.attempts).toBe(2);
    });
  });
});
