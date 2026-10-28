/**
 * E2E Testing Routes
 *
 * Helper endpoints for E2E testing. Only available when E2E_AUTH_BYPASS is enabled.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { loadFixture } from '../lib/e2e-fixtures';
import { StateFactory, TargetStage } from '../testing/state-factory';
import { runReconcilerForDirection } from '../services/reconciler';
import { logger } from '../lib/logger';

const router = Router();

/**
 * Clean up all E2E test data.
 * Deletes users with emails matching *@e2e.test pattern.
 * Cascades to related data through Prisma's referential actions.
 */
export async function cleanupE2EUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only allow when E2E mode is enabled
  if (process.env.E2E_AUTH_BYPASS !== 'true') {
    res.status(403).json({
      success: false,
      error: 'E2E cleanup only available when E2E_AUTH_BYPASS is enabled',
    });
    return;
  }

  try {
    // Step 1: Find all E2E test users
    const e2eUsers = await prisma.user.findMany({
      where: { email: { endsWith: '@e2e.test' } },
      select: { id: true },
    });
    const e2eUserIds = e2eUsers.map(u => u.id);

    if (e2eUserIds.length === 0) {
      res.status(200).json({
        success: true,
        deletedUsers: 0,
        deletedSessions: 0,
        deletedRelationships: 0,
      });
      return;
    }

    // Step 2: Find all relationships that have E2E test members
    const e2eRelationships = await prisma.relationship.findMany({
      where: {
        members: {
          some: { userId: { in: e2eUserIds } },
        },
      },
      select: { id: true },
    });
    const e2eRelationshipIds = e2eRelationships.map(r => r.id);

    // Step 3: Delete sessions linked to those relationships
    // Session cascade (onDelete: Cascade) handles all children:
    // Messages, StageProgress, UserVessel, EmpathyDraft, EmpathyAttempt,
    // EmpathyValidation, ReconcilerResult -> ReconcilerShareOffer,
    // StrategyProposal, StrategyRanking, ConsentRecord, SharedVessel,
    // Invitation, UserMemory, ValidationFeedbackDraft,
    // RefinementAttemptCounter, BrainActivity, EmotionalExerciseCompletion
    let deletedSessions = 0;
    if (e2eRelationshipIds.length > 0) {
      const sessionResult = await prisma.session.deleteMany({
        where: { relationshipId: { in: e2eRelationshipIds } },
      });
      deletedSessions = sessionResult.count;
    }

    // Step 4: Delete the relationships themselves
    let deletedRelationships = 0;
    if (e2eRelationshipIds.length > 0) {
      const relationshipResult = await prisma.relationship.deleteMany({
        where: { id: { in: e2eRelationshipIds } },
      });
      deletedRelationships = relationshipResult.count;
    }

    // Step 5: Also clean up any orphaned relationships (zero members)
    // This handles edge cases where prior partial cleanup removed members
    const orphanedRelationships = await prisma.relationship.findMany({
      where: {
        members: { none: {} },
      },
      select: { id: true },
    });
    if (orphanedRelationships.length > 0) {
      const orphanRelIds = orphanedRelationships.map(r => r.id);
      // Delete sessions under orphaned relationships first
      const orphanSessionResult = await prisma.session.deleteMany({
        where: { relationshipId: { in: orphanRelIds } },
      });
      deletedSessions += orphanSessionResult.count;
      const orphanRelResult = await prisma.relationship.deleteMany({
        where: { id: { in: orphanRelIds } },
      });
      deletedRelationships += orphanRelResult.count;
    }

    // Step 6: Delete the E2E users themselves. E2E TOOLING ONLY (behind
    // E2E_AUTH_BYPASS): production never hard-deletes a user — account
    // deletion tombstones it (app.anonymize_user_account; spec §7). Every FK to
    // `user` is RESTRICT on the target, so the synthetic users' own U-class rows
    // go first (their sessions, participants and invitations went with the
    // relationships above).
    const e2eUser = { userId: { in: e2eUserIds } };
    await prisma.$transaction([
      prisma.reflection.deleteMany({ where: e2eUser }),
      prisma.featureState.deleteMany({ where: e2eUser }),
      prisma.userMemory.deleteMany({ where: e2eUser }),
      prisma.userDevice.deleteMany({ where: e2eUser }),
      prisma.userPreferences.deleteMany({ where: e2eUser }),
      prisma.userKey.deleteMany({ where: e2eUser }),
      prisma.aiMemory.deleteMany({ where: e2eUser }),
      prisma.reminder.deleteMany({ where: e2eUser }),
      prisma.relationshipMember.deleteMany({ where: e2eUser }),
      prisma.participant.deleteMany({ where: e2eUser }),
      prisma.invitation.updateMany({
        where: { acceptedByUserId: { in: e2eUserIds } },
        data: { acceptedByUserId: null },
      }),
    ]);
    const userResult = await prisma.user.deleteMany({
      where: { email: { endsWith: '@e2e.test' } },
    });

    res.status(200).json({
      success: true,
      deletedUsers: userResult.count,
      deletedSessions,
      deletedRelationships,
    });
  } catch (error) {
    next(error);
  }
}

router.post('/cleanup', cleanupE2EUsers);

/**
 * Seed a test user for E2E testing.
 * Creates a user in the database with the provided email/name or from a fixture.
 *
 * Body options:
 * - { email: string, name?: string } - Create user with explicit email
 * - { fixtureId: string } - Load user from fixture seed
 *
 * Returns 201 with { id, email, name } on success.
 * Returns 400 if email doesn't end in @e2e.test
 * Returns 403 if E2E_AUTH_BYPASS is not true
 */
export async function seedE2EUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only allow when E2E mode is enabled
  if (process.env.E2E_AUTH_BYPASS !== 'true') {
    res.status(403).json({
      success: false,
      error: 'E2E seed only available when E2E_AUTH_BYPASS is enabled',
    });
    return;
  }

  try {
    const { email, name, fixtureId } = req.body;

    let userEmail: string;
    let userName: string;

    if (fixtureId) {
      // Load user from fixture
      const fixture = loadFixture(fixtureId);
      if (!fixture.seed?.users || fixture.seed.users.length === 0) {
        res.status(400).json({
          success: false,
          error: `Fixture ${fixtureId} has no seed users`,
        });
        return;
      }
      const fixtureUser = fixture.seed.users[0];
      userEmail = fixtureUser.email;
      userName = fixtureUser.name;
    } else if (email) {
      userEmail = email;
      userName = name || 'E2E Test User';
    } else {
      res.status(400).json({
        success: false,
        error: 'Either email or fixtureId is required',
      });
      return;
    }

    // Validate email domain
    if (!userEmail.endsWith('@e2e.test')) {
      res.status(400).json({
        success: false,
        error: 'Email must end with @e2e.test',
      });
      return;
    }

    // Create user with e2e_ prefixed clerkId
    const user = await prisma.user.upsert({
      where: { email: userEmail },
      // name is generated from first/last (spec §1.7): the whole name goes in first_name
      update: { firstName: userName, lastName: null },
      create: {
        email: userEmail,
        firstName: userName,
        clerkId: `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      },
    });

    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    next(error);
  }
}

router.post('/seed', seedE2EUser);

/**
 * Seed a session at a specific stage for E2E testing.
 * Creates users, relationship, session, invitation, and stage-specific data.
 *
 * Body:
 * {
 *   userA: { email: string, name: string },
 *   userB?: { email: string, name: string },
 *   targetStage: 'CREATED' | 'EMPATHY_SHARED_A'
 * }
 *
 * Returns 201 with session/user/invitation details and page URLs.
 * Returns 400 if validation fails.
 * Returns 403 if E2E_AUTH_BYPASS is not true.
 */
export async function seedE2ESession(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only allow when E2E mode is enabled
  if (process.env.E2E_AUTH_BYPASS !== 'true') {
    res.status(403).json({
      success: false,
      error: 'E2E seed-session only available when E2E_AUTH_BYPASS is enabled',
    });
    return;
  }

  try {
    const { userA, userB, targetStage } = req.body;

    // Validate required fields
    if (!userA || !userA.email || !userA.name) {
      res.status(400).json({
        success: false,
        error: 'userA with email and name is required',
      });
      return;
    }

    // Validate email domains
    if (!userA.email.endsWith('@e2e.test')) {
      res.status(400).json({
        success: false,
        error: 'userA.email must end with @e2e.test',
      });
      return;
    }

    if (userB && userB.email && !userB.email.endsWith('@e2e.test')) {
      res.status(400).json({
        success: false,
        error: 'userB.email must end with @e2e.test',
      });
      return;
    }

    // Validate target stage
    const validStages = Object.values(TargetStage);
    if (!targetStage || !validStages.includes(targetStage)) {
      res.status(400).json({
        success: false,
        error: `targetStage must be one of: ${validStages.join(', ')}`,
      });
      return;
    }

    // Get base URL from environment or use default
    const baseUrl = process.env.E2E_APP_BASE_URL || 'http://localhost:8081';

    // Create the session at the specified stage
    const factory = new StateFactory(baseUrl);
    const result = await factory.createSessionAtStage({
      userA: { email: userA.email, name: userA.name },
      userB: userB ? { email: userB.email, name: userB.name } : undefined,
      targetStage: targetStage as TargetStage,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('[seedE2ESession] Error:', error);
    next(error);
  }
}

router.post('/seed-session', seedE2ESession);

/**
 * Seed an Inner Thoughts session with distilled takeaways for visual testing.
 *
 * Body:
 * {
 *   user: { email: string, name: string }
 * }
 */
export async function seedE2EInnerThoughts(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.E2E_AUTH_BYPASS !== 'true') {
    res.status(403).json({
      success: false,
      error: 'E2E seed-inner-thoughts only available when E2E_AUTH_BYPASS is enabled',
    });
    return;
  }

  try {
    const { user } = req.body;

    if (!user || !user.email || !user.name) {
      res.status(400).json({
        success: false,
        error: 'user with email and name is required',
      });
      return;
    }

    if (!user.email.endsWith('@e2e.test')) {
      res.status(400).json({
        success: false,
        error: 'user.email must end with @e2e.test',
      });
      return;
    }

    const baseUrl = process.env.E2E_APP_BASE_URL || 'http://localhost:8081';

    const result = await prisma.$transaction(async tx => {
      // user.name is generated from first/last (spec §1.7): the whole name goes in first_name
      const userRecord = await tx.user.upsert({
        where: { email: user.email },
        update: { firstName: user.name, lastName: null },
        create: {
          email: user.email,
          firstName: user.name,
          clerkId: `e2e_inner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        },
      });

      const session = await tx.reflection.create({
        data: {
          userId: userRecord.id,
          title: 'Repair patterns after conflict',
          theme: 'Relationship repair',
          summary:
            'The reflection identified a need for a short pause before repair conversations and a clearer opening sentence.',
          status: 'COMPLETED',
          distilledAt: new Date(),
          messages: {
            create: [
              {
                role: 'USER',
                content: 'I keep trying to repair too quickly after dinner arguments.',
              },
              {
                role: 'AI',
                content: 'It sounds like timing matters. Let us capture the patterns you want to remember.',
              },
            ],
          },
          takeaways: {
            create: [
              {
                content: 'A short pause before repair helps me speak with less urgency.',
                theme: 'Repair timing',
                source: 'AI',
                type: 'INSIGHT',
                position: 0,
              },
              {
                content: 'Open with what I want to understand, not what I want to prove.',
                theme: 'Communication',
                source: 'AI',
                type: 'INTENTION',
                position: 1,
              },
              {
                content: 'Ask whether now is a good time before starting a serious repair conversation.',
                theme: 'Action',
                source: 'AI',
                type: 'ACTION_ITEM',
                position: 2,
              },
            ],
          },
        },
      });

      return {
        session: {
          id: session.id,
          status: session.status,
          distilledAt: session.distilledAt?.toISOString() ?? null,
        },
        user: {
          id: userRecord.id,
          email: userRecord.email,
          name: userRecord.name || user.name,
        },
        pageUrl: `${baseUrl}/inner-thoughts/${session.id}?e2e-user-id=${userRecord.id}&e2e-user-email=${encodeURIComponent(userRecord.email)}`,
      };
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('[seedE2EInnerThoughts] Error:', error);
    next(error);
  }
}

router.post('/seed-inner-thoughts', seedE2EInnerThoughts);

/**
 * Trigger the reconciler for a specific direction in a session.
 * This allows E2E tests seeded at FEEL_HEARD_B to run the reconciler
 * via API call instead of navigating through the UI.
 *
 * Body:
 * {
 *   sessionId: string,
 *   guesserId: string,
 *   subjectId: string
 * }
 *
 * Returns 200 with reconciler result and share offer details.
 * Returns 400 if validation fails.
 * Returns 403 if E2E_AUTH_BYPASS is not true.
 */
export async function triggerE2EReconciler(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only allow when E2E mode is enabled
  if (process.env.E2E_AUTH_BYPASS !== 'true') {
    res.status(403).json({
      success: false,
      error: 'E2E trigger-reconciler only available when E2E_AUTH_BYPASS is enabled',
    });
    return;
  }

  try {
    const { sessionId, guesserId, subjectId } = req.body;

    // Validate required fields
    if (!sessionId || !guesserId || !subjectId) {
      res.status(400).json({
        success: false,
        error: 'sessionId, guesserId, and subjectId are required',
      });
      return;
    }

    // Verify session exists
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      res.status(400).json({
        success: false,
        error: `Session ${sessionId} not found`,
      });
      return;
    }

    // Run the reconciler for the specified direction
    const result = await runReconcilerForDirection(sessionId, guesserId, subjectId);

    res.status(200).json({
      success: true,
      data: {
        reconcilerResult: result.result,
        empathyStatus: result.empathyStatus,
        shareOffer: result.shareOffer,
      },
    });
  } catch (error) {
    logger.error('[triggerE2EReconciler] Error:', error);
    next(error);
  }
}

router.post('/trigger-reconciler', triggerE2EReconciler);

export default router;
