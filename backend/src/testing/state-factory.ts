/**
 * State Factory for E2E Testing
 *
 * Creates sessions at various stages using Prisma transactions.
 * This allows E2E tests to start from specific states rather than
 * having to navigate through the entire UI flow.
 */

import { prisma } from '../lib/prisma';
import {
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
} from '@meet-without-fear/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Target stages for session seeding.
 * Each stage represents a specific point in the user journey.
 */
export enum TargetStage {
  /** Session just created, compact not signed */
  CREATED = 'CREATED',

  /** Topic has been confirmed and the invitation-ready modal can be opened */
  INVITATION_READY = 'INVITATION_READY',

  /** User A completed Stage 1 (witnessed, felt heard) and shared empathy */
  EMPATHY_SHARED_A = 'EMPATHY_SHARED_A',

  /** User B has completed Stage 1 (felt heard), reconciler has run. Ready for reconciler tests. */
  FEEL_HEARD_B = 'FEEL_HEARD_B',

  /** User B has felt heard, reconciler has run with significant gaps, share offer is OFFERED. Ready for share modal UI tests. */
  RECONCILER_SHOWN_B = 'RECONCILER_SHOWN_B',

  /** Both users active: User B has felt heard, received share suggestion, and shared context */
  CONTEXT_SHARED_B = 'CONTEXT_SHARED_B',

  /** Both users active: Both have shared empathy and validated each other's empathy (empathy reveal complete) */
  EMPATHY_REVEALED = 'EMPATHY_REVEALED',

  /** Stage 3: Both users have identified needs and confirmed common ground */
  NEED_MAPPING_COMPLETE = 'NEED_MAPPING_COMPLETE',

  /** Stage 4: Strategies collected, ranked, and agreement created */
  STRATEGIC_REPAIR_COMPLETE = 'STRATEGIC_REPAIR_COMPLETE',

  /** Redesigned Stage 4: Active proposal inventory with one removed proposal */
  STAGE4_REDESIGN_INVENTORY = 'STAGE4_REDESIGN_INVENTORY',

  /** Redesigned Stage 4: Both partners selected one shared proposal as willing */
  STAGE4_REDESIGN_SHARED_SELECTIONS = 'STAGE4_REDESIGN_SHARED_SELECTIONS',

  /** Redesigned Stage 4: Both partners selected, but no shared proposal overlaps */
  STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS = 'STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS',

  /** Redesigned Stage 4: One partner selected while the other is inactive */
  STAGE4_REDESIGN_PARTNER_INACTIVE = 'STAGE4_REDESIGN_PARTNER_INACTIVE',
}

const TWO_USER_ACTIVE_TARGETS = new Set<TargetStage>([
  TargetStage.FEEL_HEARD_B,
  TargetStage.RECONCILER_SHOWN_B,
  TargetStage.CONTEXT_SHARED_B,
  TargetStage.EMPATHY_REVEALED,
  TargetStage.NEED_MAPPING_COMPLETE,
  TargetStage.STRATEGIC_REPAIR_COMPLETE,
  TargetStage.STAGE4_REDESIGN_INVENTORY,
  TargetStage.STAGE4_REDESIGN_SHARED_SELECTIONS,
  TargetStage.STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS,
  TargetStage.STAGE4_REDESIGN_PARTNER_INACTIVE,
]);

export interface UserConfig {
  email: string;
  name: string;
}

export interface StateFactoryOptions {
  userA: UserConfig;
  userB?: UserConfig;
  targetStage: TargetStage;
}

export interface StateFactoryResult {
  session: {
    id: string;
    status: string;
    relationshipId: string;
  };
  userA: {
    id: string;
    email: string;
    name: string;
  };
  userB?: {
    id: string;
    email: string;
    name: string;
  };
  invitation: {
    id: string;
    status: string;
  };
  pageUrls: {
    userA: string;
    userB?: string;
  };
}

// ============================================================================
// State Factory
// ============================================================================

export class StateFactory {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8081') {
    this.baseUrl = baseUrl;
  }

  /**
   * Create a session at the specified stage.
   * Uses a Prisma transaction to ensure atomicity.
   */
  async createSessionAtStage(options: StateFactoryOptions): Promise<StateFactoryResult> {
    const { userA, userB, targetStage } = options;

    // Validate email domains
    if (!userA.email.endsWith('@e2e.test')) {
      throw new Error(`User A email must end with @e2e.test: ${userA.email}`);
    }
    if (userB && !userB.email.endsWith('@e2e.test')) {
      throw new Error(`User B email must end with @e2e.test: ${userB.email}`);
    }

    // Use transaction to ensure all-or-nothing creation
    return prisma.$transaction(async (tx) => {
      // 1. Create/upsert User A
      const userARecord = await tx.user.upsert({
        where: { email: userA.email },
        update: { name: userA.name },
        create: {
          email: userA.email,
          name: userA.name,
          clerkId: `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          lastMoodIntensity: 7,
        },
      });

      // 2. Create/upsert User B if provided
      let userBRecord: typeof userARecord | null = null;
      if (userB) {
        userBRecord = await tx.user.upsert({
          where: { email: userB.email },
          update: { name: userB.name },
          create: {
            email: userB.email,
            name: userB.name,
            clerkId: `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            lastMoodIntensity: 7,
          },
        });
      }

      // 3. Create relationship with members
      const memberData = [
        {
          userId: userARecord.id,
          nickname: userB?.name || null, // What A calls B
        },
      ];

      // Add User B whenever provided. Some E2E fresh-session callers need
      // both URLs to be authorized before the real invitation UI is driven.
      if (userBRecord) {
        memberData.push({
          userId: userBRecord.id,
          nickname: userA.name, // What B calls A
        });
      }

      const relationship = await tx.relationship.create({
        data: {
          members: {
            create: memberData,
          },
        },
      });

      // 4. Determine session status based on target stage
      // EMPATHY_SHARED_A: User A has completed, invitation is pending for User B
      // Session stays INVITED until User B accepts (which changes it to ACTIVE)
      let sessionStatus: 'CREATED' | 'INVITED' | 'ACTIVE' = 'CREATED';
      if (targetStage === TargetStage.INVITATION_READY) {
        // Topic is confirmed and the invitation link is ready, but partner has
        // not accepted yet.
        sessionStatus = 'INVITED';
      } else if (targetStage === TargetStage.EMPATHY_SHARED_A) {
        // Session is INVITED - waiting for User B to accept
        // Will become ACTIVE when User B accepts the invitation
        sessionStatus = 'INVITED';
      } else if (TWO_USER_ACTIVE_TARGETS.has(targetStage)) {
        // Both users have joined and are active
        sessionStatus = 'ACTIVE';
      }

      // 5. Create session
      const session = await tx.session.create({
        data: {
          relationshipId: relationship.id,
          status: sessionStatus,
          ...(targetStage === TargetStage.INVITATION_READY
            ? {
                topicFrame: 'How we repair after a tense dinner conversation',
                topicFrameConfirmedAt: new Date(),
              }
            : {}),
        },
      });

      // 6. Create invitation
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const invitationAccepted = TWO_USER_ACTIVE_TARGETS.has(targetStage);
      const invitationStatus = invitationAccepted ? 'ACCEPTED' : 'PENDING';
      const invitation = await tx.invitation.create({
        data: {
          sessionId: session.id,
          invitedById: userARecord.id,
          acceptedAt: invitationAccepted ? new Date() : null,
          name: userB?.name || 'Partner',
          status: invitationStatus,
          expiresAt,
          messageConfirmed: targetStage !== TargetStage.CREATED,
          messageConfirmedAt: targetStage !== TargetStage.CREATED ? new Date() : null,
        },
      });

      // 7. Create SharedVessel
      await tx.sharedVessel.create({
        data: { sessionId: session.id },
      });

      // 8. Create UserVessel for User A
      await tx.userVessel.create({
        data: {
          sessionId: session.id,
          userId: userARecord.id,
        },
      });

      // 8b. Create UserVessel for User B whenever they were attached to the
      // relationship so both E2E URLs resolve to a complete per-user shell.
      if (userBRecord) {
        await tx.userVessel.create({
          data: {
            sessionId: session.id,
            userId: userBRecord.id,
          },
        });
      }

      // 9. Create stage-specific data
      if (targetStage === TargetStage.CREATED || targetStage === TargetStage.INVITATION_READY) {
        // Just Stage 0 IN_PROGRESS for User A
        await tx.stageProgress.create({
          data: {
            sessionId: session.id,
            userId: userARecord.id,
            stage: 0,
            status: 'IN_PROGRESS',
            gatesSatisfied: {},
          },
        });
      } else if (targetStage === TargetStage.EMPATHY_SHARED_A) {
        // Create full state for User A through empathy
        // Note: User B's state (StageProgress, UserVessel) is created when they accept invitation
        await this.createEmpathySharedState(tx, session.id, userARecord.id);
      } else if (targetStage === TargetStage.FEEL_HEARD_B && userBRecord) {
        // Both users active, User B has felt heard, reconciler ready to run
        await this.createFeelHeardBState(tx, session.id, userARecord.id, userBRecord.id, userA.name, userB!.name);
      } else if (targetStage === TargetStage.RECONCILER_SHOWN_B && userBRecord) {
        // Both users active, User B has felt heard, reconciler has run with significant gaps, share offer OFFERED
        await this.createReconcilerShownBState(tx, session.id, userARecord.id, userBRecord.id, userA.name, userB!.name);
      } else if (targetStage === TargetStage.CONTEXT_SHARED_B && userBRecord) {
        // Create full state for both users, with User B having shared context
        await this.createContextSharedState(tx, session.id, userARecord.id, userBRecord.id, userA.name, userB!.name);
      } else if (targetStage === TargetStage.EMPATHY_REVEALED && userBRecord) {
        // Both users have shared and validated empathy - ready for Stage 3
        await this.createEmpathyRevealedState(tx, session.id, userARecord.id, userBRecord.id, userA.name, userB!.name);
      } else if (targetStage === TargetStage.NEED_MAPPING_COMPLETE && userBRecord) {
        // Stage 3 complete - needs identified and common ground confirmed
        await this.createNeedMappingCompleteState(tx, session.id, userARecord.id, userBRecord.id, userA.name, userB!.name);
      } else if (targetStage === TargetStage.STRATEGIC_REPAIR_COMPLETE && userBRecord) {
        // Stage 4 complete - strategies ranked and agreement created
        await this.createStrategicRepairCompleteState(tx, session.id, userARecord.id, userBRecord.id, userA.name, userB!.name);
      } else if (
        (
          targetStage === TargetStage.STAGE4_REDESIGN_INVENTORY ||
          targetStage === TargetStage.STAGE4_REDESIGN_SHARED_SELECTIONS ||
          targetStage === TargetStage.STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS ||
          targetStage === TargetStage.STAGE4_REDESIGN_PARTNER_INACTIVE
        ) &&
        userBRecord
      ) {
        await this.createStage4RedesignFixtureState(
          tx,
          session.id,
          userARecord.id,
          userBRecord.id,
          userA.name,
          userB!.name,
          targetStage
        );
      }

      // Build result
      const result: StateFactoryResult = {
        session: {
          id: session.id,
          status: session.status,
          relationshipId: session.relationshipId,
        },
        userA: {
          id: userARecord.id,
          email: userARecord.email,
          name: userARecord.name || userA.name,
        },
        invitation: {
          id: invitation.id,
          status: invitation.status,
        },
        pageUrls: {
          userA: `${this.baseUrl}/session/${session.id}?e2e-user-id=${userARecord.id}&e2e-user-email=${encodeURIComponent(userARecord.email)}`,
        },
      };

      if (userBRecord) {
        result.userB = {
          id: userBRecord.id,
          email: userBRecord.email,
          name: userBRecord.name || userB!.name,
        };
        result.pageUrls.userB = `${this.baseUrl}/session/${session.id}?e2e-user-id=${userBRecord.id}&e2e-user-email=${encodeURIComponent(userBRecord.email)}`;
      }

      return result;
    });
  }

  /**
   * Create the full state for EMPATHY_SHARED_A stage.
   * User A has completed Stage 1 and shared empathy, now in Stage 2.
   * User B has not accepted the invitation yet (no StageProgress or UserVessel).
   */
  private async createEmpathySharedState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string
  ): Promise<void> {
    const now = new Date();
    const stage0CompletedAt = new Date(now.getTime() - 60000); // 1 minute ago
    const stage1CompletedAt = new Date(now.getTime() - 30000); // 30 seconds ago

    // Stage 0 for User A - COMPLETED with compact signed
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(now.getTime() - 120000), // 2 minutes ago
        completedAt: stage0CompletedAt,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: stage0CompletedAt.toISOString(),
        },
      },
    });

    // Stage 1 for User A - COMPLETED with feelHeardConfirmed
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: stage0CompletedAt,
        completedAt: stage1CompletedAt,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: stage1CompletedAt.toISOString(),
        },
      },
    });

    // Stage 2 for User A - IN_PROGRESS (has shared empathy but waiting for partner)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 2,
        status: 'IN_PROGRESS',
        startedAt: stage1CompletedAt,
        gatesSatisfied: {},
      },
    });

    // NOTE: User B's StageProgress and UserVessel are NOT created here.
    // They will be created when User B accepts the invitation via the API.
    // This keeps the seeded state consistent with the real application flow.

    // Create User A's messages (enough for turnCount threshold)
    const messageContents = [
      { role: 'USER' as const, content: "Hi, I'm having issues with my partner." },
      { role: 'AI' as const, content: "I'm glad you reached out. Tell me more about what's happening." },
      { role: 'USER' as const, content: "We argue about household chores constantly." },
      { role: 'AI' as const, content: "That sounds frustrating. Would you like to invite your partner?" },
      { role: 'USER' as const, content: "Yes, I sent the invitation." },
      { role: 'AI' as const, content: "Great. Let's continue exploring your perspective while we wait." },
      { role: 'USER' as const, content: "I feel like I do most of the work and they don't notice." },
      { role: 'AI' as const, content: "I hear you. Do you feel like I understand what you've been experiencing?" },
      { role: 'USER' as const, content: "Yes, I feel heard now." },
      { role: 'AI' as const, content: "I'm glad. Now let's build some empathy for your partner's perspective." },
      { role: 'USER' as const, content: "I think they're stressed from work too." },
      { role: 'AI' as const, content: "That's a thoughtful observation. Here's an empathy statement you could share..." },
    ];

    for (let i = 0; i < messageContents.length; i++) {
      const msg = messageContents[i];
      await tx.message.create({
        data: {
          sessionId,
          senderId: msg.role === 'USER' ? userAId : null,
          forUserId: userAId, // All messages are for User A (data isolation)
          role: msg.role,
          content: msg.content,
          stage: i < 4 ? 0 : i < 8 ? 1 : 1, // Approximate stage based on message index
          timestamp: new Date(now.getTime() - (messageContents.length - i) * 5000),
        },
      });
    }

    // Create EmpathyDraft for User A
    const empathyDraft = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userAId,
        content: "I understand you might be feeling stressed from work. I want us to support each other better.",
        readyToShare: true,
      },
    });

    // Create EmpathyAttempt (the shared statement)
    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraft.id,
        sourceUserId: userAId,
        content: empathyDraft.content,
        status: 'HELD', // Waiting for partner to complete Stage 1
        sharedAt: now,
      },
    });

    // User A's consent record (proves they already consented to share)
    await tx.consentRecord.create({
      data: {
        userId: userAId,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: empathyDraft.id,
        requestedByUserId: userAId,
        decision: 'GRANTED',
        decidedAt: now,
      },
    });

    // Also create the EMPATHY_STATEMENT message for the chat history
    await tx.message.create({
      data: {
        sessionId,
        senderId: userAId,
        forUserId: userAId,
        role: 'EMPATHY_STATEMENT',
        content: empathyDraft.content,
        stage: 2,
        timestamp: now,
      },
    });
  }

  /**
   * Create the full state for FEEL_HEARD_B stage.
   * Both users are active. User B has:
   * - Completed Stage 0 (signed compact)
   * - Completed Stage 1 (felt heard)
   * - NOT yet received share suggestion or reconciler analysis
   *
   * User A has shared empathy and is waiting in Stage 2.
   * This stage is ideal for testing reconciler outcomes.
   */
  private async createFeelHeardBState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string,
    userBId: string,
    userAName: string,
    _userBName: string // Reserved for future use
  ): Promise<void> {
    const now = new Date();
    const baseTime = now.getTime();

    // Timeline (working backwards from now):
    // - now: User B felt heard, ready for reconciler
    // - -30s: User B Stage 1 in progress
    // - -60s: User B Stage 0 completed (compact signed)
    // - -90s: User A's empathy shared
    // - -120s: User A's Stage 1 completed
    // - -150s: User A's Stage 0 completed

    const timestamps = {
      userAStage0Completed: new Date(baseTime - 150000),
      userAStage1Completed: new Date(baseTime - 120000),
      userAEmpathyShared: new Date(baseTime - 90000),
      userBStage0Completed: new Date(baseTime - 60000),
      userBStage1Completed: now,
    };

    // ========================================
    // USER A STATE (same as CONTEXT_SHARED_B)
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 180000),
        completedAt: timestamps.userAStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userAStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage0Completed,
        completedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userAStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - IN_PROGRESS (waiting for User B's empathy)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 2,
        status: 'IN_PROGRESS',
        startedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {},
      },
    });

    // User A's messages (conversation history)
    const userAMessages = [
      { role: 'USER' as const, content: "Hi, I'm having issues with my partner.", stage: 0 },
      { role: 'AI' as const, content: "I'm glad you reached out. Tell me more about what's happening.", stage: 0 },
      { role: 'USER' as const, content: "We argue about household chores constantly.", stage: 1 },
      { role: 'AI' as const, content: "That sounds frustrating. Would you like to invite your partner?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I sent the invitation.", stage: 1 },
      { role: 'AI' as const, content: "Great. Let's continue exploring your perspective while we wait.", stage: 1 },
      { role: 'USER' as const, content: "I feel like I do most of the work and they don't notice.", stage: 1 },
      { role: 'AI' as const, content: "I hear you. Do you feel like I understand what you've been experiencing?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I feel heard now.", stage: 1 },
      { role: 'AI' as const, content: "I'm glad. Now let's build some empathy for your partner's perspective.", stage: 2 },
      { role: 'USER' as const, content: "I think they're stressed from work too.", stage: 2 },
      { role: 'AI' as const, content: "That's a thoughtful observation. Here's an empathy statement you could share...", stage: 2 },
    ];

    for (let i = 0; i < userAMessages.length; i++) {
      const msg = userAMessages[i];
      await tx.message.create({
        data: {
          sessionId,
          senderId: msg.role === 'USER' ? userAId : null,
          forUserId: userAId,
          role: msg.role,
          content: msg.content,
          stage: msg.stage,
          timestamp: new Date(baseTime - 180000 + i * 5000),
        },
      });
    }

    // User A's empathy draft and attempt
    const empathyDraftA = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userAId,
        content: "I understand you might be feeling stressed from work. I want us to support each other better.",
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftA.id,
        sourceUserId: userAId,
        content: empathyDraftA.content,
        status: 'HELD', // Waiting for User B to complete Stage 1 and reconciler to run
        sharedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's consent record (proves they already consented to share)
    await tx.consentRecord.create({
      data: {
        userId: userAId,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: empathyDraftA.id,
        requestedByUserId: userAId,
        decision: 'GRANTED',
        decidedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's EMPATHY_STATEMENT message
    await tx.message.create({
      data: {
        sessionId,
        senderId: userAId,
        forUserId: userAId,
        role: 'EMPATHY_STATEMENT',
        content: empathyDraftA.content,
        stage: 2,
        timestamp: timestamps.userAEmpathyShared,
      },
    });

    // ========================================
    // USER B STATE
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 90000),
        completedAt: timestamps.userBStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userBStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED (just now felt heard)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userBStage0Completed,
        completedAt: timestamps.userBStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userBStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - IN_PROGRESS (just started, reconciler hasn't run yet)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 2,
        status: 'IN_PROGRESS',
        startedAt: timestamps.userBStage1Completed,
        gatesSatisfied: {},
      },
    });

    // User B's messages (conversation history)
    const userBMessages = [
      { role: 'AI' as const, content: `Welcome! ${userAName} invited you to work through some challenges together.`, stage: 0 },
      { role: 'USER' as const, content: "Things have been tense lately between us.", stage: 0 },
      { role: 'AI' as const, content: "I hear you. Tell me more about what's been happening.", stage: 1 },
      { role: 'USER' as const, content: "I feel like they don't see how much I'm dealing with at work.", stage: 1 },
      { role: 'AI' as const, content: "That sounds really hard. Can you tell me more?", stage: 1 },
      { role: 'USER' as const, content: "I work so hard and come home exhausted, but there's always more to do.", stage: 1 },
      { role: 'AI' as const, content: "I understand. How long has this been going on?", stage: 1 },
      { role: 'USER' as const, content: "Months now. I don't know how to get through to them.", stage: 1 },
      { role: 'AI' as const, content: "Do you feel like I understand what you've been going through?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I feel heard.", stage: 1 },
    ];

    for (let i = 0; i < userBMessages.length; i++) {
      const msg = userBMessages[i];
      await tx.message.create({
        data: {
          sessionId,
          senderId: msg.role === 'USER' ? userBId : null,
          forUserId: userBId,
          role: msg.role,
          content: msg.content,
          stage: msg.stage,
          timestamp: new Date(baseTime - 90000 + i * 5000),
        },
      });
    }

    // Note: No ReconcilerResult or ReconcilerShareOffer created.
    // The test will trigger the reconciler by navigating the UI,
    // and the fixture's operation responses will determine the outcome.
  }

  /**
   * Create the full state for RECONCILER_SHOWN_B stage.
   * Both users are active. User B has:
   * - Completed Stage 0 (signed compact)
   * - Completed Stage 1 (felt heard)
   * - ReconcilerResult with significant gaps
   * - ReconcilerShareOffer with status OFFERED (ready for UI interaction)
   *
   * User A has shared empathy and is waiting (status = AWAITING_SHARING).
   * This stage is ideal for testing the share modal UI without running the reconciler.
   */
  private async createReconcilerShownBState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string,
    userBId: string,
    userAName: string,
    userBName: string
  ): Promise<void> {
    const now = new Date();
    const baseTime = now.getTime();

    // Timeline (working backwards from now):
    // - now: Share suggestion offered and visible
    // - -5s: Reconciler ran
    // - -30s: User B Stage 1 completed (felt heard)
    // - -60s: User B Stage 0 completed (compact signed)
    // - -90s: User A's empathy shared
    // - -120s: User A's Stage 1 completed
    // - -150s: User A's Stage 0 completed

    const timestamps = {
      userAStage0Completed: new Date(baseTime - 150000),
      userAStage1Completed: new Date(baseTime - 120000),
      userAEmpathyShared: new Date(baseTime - 90000),
      userBStage0Completed: new Date(baseTime - 60000),
      userBStage1Completed: new Date(baseTime - 30000),
      reconcilerRan: new Date(baseTime - 5000),
      shareOfferOffered: now,
    };

    // ========================================
    // USER A STATE (same as FEEL_HEARD_B but with AWAITING_SHARING status)
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 180000),
        completedAt: timestamps.userAStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userAStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage0Completed,
        completedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userAStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - IN_PROGRESS (waiting for User B's share decision)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 2,
        status: 'IN_PROGRESS',
        startedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {},
      },
    });

    // User A's messages (conversation history)
    const userAMessages = [
      { role: 'USER' as const, content: "Hi, I'm having issues with my partner.", stage: 0 },
      { role: 'AI' as const, content: "I'm glad you reached out. Tell me more about what's happening.", stage: 0 },
      { role: 'USER' as const, content: "We argue about household chores constantly.", stage: 1 },
      { role: 'AI' as const, content: "That sounds frustrating. Would you like to invite your partner?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I sent the invitation.", stage: 1 },
      { role: 'AI' as const, content: "Great. Let's continue exploring your perspective while we wait.", stage: 1 },
      { role: 'USER' as const, content: "I feel like I do most of the work and they don't notice.", stage: 1 },
      { role: 'AI' as const, content: "I hear you. Do you feel like I understand what you've been experiencing?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I feel heard now.", stage: 1 },
      { role: 'AI' as const, content: "I'm glad. Now let's build some empathy for your partner's perspective.", stage: 2 },
      { role: 'USER' as const, content: "I think they're stressed from work too.", stage: 2 },
      { role: 'AI' as const, content: "That's a thoughtful observation. Here's an empathy statement you could share...", stage: 2 },
    ];

    for (let i = 0; i < userAMessages.length; i++) {
      const msg = userAMessages[i];
      await tx.message.create({
        data: {
          sessionId,
          senderId: msg.role === 'USER' ? userAId : null,
          forUserId: userAId,
          role: msg.role,
          content: msg.content,
          stage: msg.stage,
          timestamp: new Date(baseTime - 180000 + i * 5000),
        },
      });
    }

    // User A's empathy draft and attempt (status = AWAITING_SHARING)
    const empathyDraftA = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userAId,
        content: "I understand you might be feeling stressed from work. I want us to support each other better.",
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftA.id,
        sourceUserId: userAId,
        content: empathyDraftA.content,
        status: 'AWAITING_SHARING', // Waiting for User B to respond to share suggestion
        sharedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's consent record
    await tx.consentRecord.create({
      data: {
        userId: userAId,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: empathyDraftA.id,
        requestedByUserId: userAId,
        decision: 'GRANTED',
        decidedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's EMPATHY_STATEMENT message
    await tx.message.create({
      data: {
        sessionId,
        senderId: userAId,
        forUserId: userAId,
        role: 'EMPATHY_STATEMENT',
        content: empathyDraftA.content,
        stage: 2,
        timestamp: timestamps.userAEmpathyShared,
      },
    });

    // ========================================
    // USER B STATE
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 90000),
        completedAt: timestamps.userBStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userBStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED (just felt heard)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userBStage0Completed,
        completedAt: timestamps.userBStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userBStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - IN_PROGRESS (just started)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 2,
        status: 'IN_PROGRESS',
        startedAt: timestamps.userBStage1Completed,
        gatesSatisfied: {},
      },
    });

    // User B's messages (conversation history)
    const userBMessages = [
      { role: 'AI' as const, content: `Welcome! ${userAName} invited you to work through some challenges together.`, stage: 0 },
      { role: 'USER' as const, content: "Things have been tense lately between us.", stage: 0 },
      { role: 'AI' as const, content: "I hear you. Tell me more about what's been happening.", stage: 1 },
      { role: 'USER' as const, content: "I feel like they don't see how much I'm dealing with at work.", stage: 1 },
      { role: 'AI' as const, content: "That sounds really hard. Can you tell me more?", stage: 1 },
      { role: 'USER' as const, content: "I work so hard and come home exhausted, but there's always more to do.", stage: 1 },
      { role: 'AI' as const, content: "I understand. How long has this been going on?", stage: 1 },
      { role: 'USER' as const, content: "Months now. I don't know how to get through to them.", stage: 1 },
      { role: 'AI' as const, content: "Do you feel like I understand what you've been going through?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I feel heard.", stage: 1 },
    ];

    for (let i = 0; i < userBMessages.length; i++) {
      const msg = userBMessages[i];
      await tx.message.create({
        data: {
          sessionId,
          senderId: msg.role === 'USER' ? userBId : null,
          forUserId: userBId,
          role: msg.role,
          content: msg.content,
          stage: msg.stage,
          timestamp: new Date(baseTime - 90000 + i * 5000),
        },
      });
    }

    // User B's empathy draft/attempt keeps this visual fixture aligned with
    // the mobile share-offer fetch gate, which only requests pending offers
    // once the current user has submitted perspective-stretch empathy.
    const empathyDraftB = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userBId,
        content: "I understand that Riley may feel alone with the household work and want their effort to be noticed.",
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftB.id,
        sourceUserId: userBId,
        content: empathyDraftB.content,
        status: 'HELD',
        sharedAt: timestamps.userBStage1Completed,
      },
    });

    await tx.consentRecord.create({
      data: {
        userId: userBId,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: empathyDraftB.id,
        requestedByUserId: userBId,
        decision: 'GRANTED',
        decidedAt: timestamps.userBStage1Completed,
      },
    });

    // ========================================
    // RECONCILER RESULT & SHARE OFFER (OFFERED status)
    // ========================================

    // Create ReconcilerResult with significant gaps
    const reconcilerResult = await tx.reconcilerResult.create({
      data: {
        sessionId,
        guesserId: userAId,
        guesserName: userAName,
        subjectId: userBId,
        subjectName: userBName,
        alignmentScore: 45,
        alignmentSummary: `${userAName}'s empathy attempt captures some elements but misses key aspects of ${userBName}'s experience.`,
        correctlyIdentified: ['stress', 'work pressure'],
        gapSeverity: 'significant',
        gapSummary: `${userAName} hasn't fully grasped the depth of ${userBName}'s exhaustion and feeling unseen.`,
        missedFeelings: ['exhaustion', 'feeling unseen', 'overwhelm'],
        misattributions: [],
        mostImportantGap: `${userBName} feels exhausted and unseen, not just stressed.`,
        recommendedAction: 'OFFER_SHARING',
        rationale: `Sharing specific context would help ${userAName} understand ${userBName}'s perspective better.`,
        sharingWouldHelp: true,
        suggestedShareFocus: "The exhaustion from work and feeling unseen.",
        suggestedShareContent: "I feel like I'm running on empty - exhausted from work every day, and then coming home to more tasks. What I really need is for someone to see how hard I'm trying, even when I don't have anything left to give.",
        suggestedShareReason: `This helps ${userAName} understand that ${userBName}'s frustration comes from exhaustion and feeling unseen, not anger or blame.`,
        createdAt: timestamps.reconcilerRan,
      },
    });

    // Create the share offer (OFFERED status - ready for UI interaction)
    const suggestedContent = "I feel like I'm running on empty - exhausted from work every day, and then coming home to more tasks. What I really need is for someone to see how hard I'm trying, even when I don't have anything left to give.";

    await tx.reconcilerShareOffer.create({
      data: {
        resultId: reconcilerResult.id,
        userId: userBId,
        status: 'OFFERED', // Ready for user to accept/decline/refine
        suggestedContent,
        suggestedReason: reconcilerResult.suggestedShareReason,
      },
    });
  }

  /**
   * Create the full state for CONTEXT_SHARED_B stage.
   * Both users are active. User B has:
   * - Completed Stage 0 (signed compact)
   * - Completed Stage 1 (felt heard)
   * - Received a share suggestion from reconciler
   * - Shared context (accepted the suggestion)
   *
   * User A has shared empathy and received the shared context from B.
   */
  private async createContextSharedState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string,
    userBId: string,
    userAName: string,
    userBName: string
  ): Promise<void> {
    const now = new Date();
    const baseTime = now.getTime();

    // Timeline (working backwards from now):
    // - now: Context shared
    // - -5s: Share suggestion offered
    // - -10s: User B felt heard, reconciler ran
    // - -30s: User B Stage 1 completed
    // - -60s: User B Stage 0 completed (compact signed)
    // - -90s: User A's empathy shared
    // - -120s: User A's Stage 1 completed
    // - -150s: User A's Stage 0 completed

    const timestamps = {
      userAStage0Completed: new Date(baseTime - 150000),
      userAStage1Completed: new Date(baseTime - 120000),
      userAEmpathyShared: new Date(baseTime - 90000),
      userBStage0Completed: new Date(baseTime - 60000),
      userBStage1Completed: new Date(baseTime - 30000),
      reconcilerRan: new Date(baseTime - 10000),
      shareSuggestionOffered: new Date(baseTime - 5000),
      contextShared: now,
    };

    // ========================================
    // USER A STATE
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 180000),
        completedAt: timestamps.userAStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userAStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage0Completed,
        completedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userAStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - IN_PROGRESS (waiting for User B's empathy)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 2,
        status: 'IN_PROGRESS',
        startedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {},
      },
    });

    // User A's messages (conversation history)
    const userAMessages = [
      { role: 'USER' as const, content: "Hi, I'm having issues with my partner.", stage: 0 },
      { role: 'AI' as const, content: "I'm glad you reached out. Tell me more about what's happening.", stage: 0 },
      { role: 'USER' as const, content: "We argue about household chores constantly.", stage: 1 },
      { role: 'AI' as const, content: "That sounds frustrating. Would you like to invite your partner?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I sent the invitation.", stage: 1 },
      { role: 'AI' as const, content: "Great. Let's continue exploring your perspective while we wait.", stage: 1 },
      { role: 'USER' as const, content: "I feel like I do most of the work and they don't notice.", stage: 1 },
      { role: 'AI' as const, content: "I hear you. Do you feel like I understand what you've been experiencing?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I feel heard now.", stage: 1 },
      { role: 'AI' as const, content: "I'm glad. Now let's build some empathy for your partner's perspective.", stage: 2 },
      { role: 'USER' as const, content: "I think they're stressed from work too.", stage: 2 },
      { role: 'AI' as const, content: "That's a thoughtful observation. Here's an empathy statement you could share...", stage: 2 },
    ];

    for (let i = 0; i < userAMessages.length; i++) {
      const msg = userAMessages[i];
      await tx.message.create({
        data: {
          sessionId,
          senderId: msg.role === 'USER' ? userAId : null,
          forUserId: userAId,
          role: msg.role,
          content: msg.content,
          stage: msg.stage,
          timestamp: new Date(baseTime - 180000 + i * 5000),
        },
      });
    }

    // User A's empathy draft and attempt
    const empathyDraftA = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userAId,
        content: "I understand you might be feeling stressed from work. I want us to support each other better.",
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftA.id,
        sourceUserId: userAId,
        content: empathyDraftA.content,
        status: 'REFINING', // User B has shared context, so A can now refine
        sharedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's consent record (proves they already consented to share)
    await tx.consentRecord.create({
      data: {
        userId: userAId,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: empathyDraftA.id,
        requestedByUserId: userAId,
        decision: 'GRANTED',
        decidedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's EMPATHY_STATEMENT message
    await tx.message.create({
      data: {
        sessionId,
        senderId: userAId,
        forUserId: userAId,
        role: 'EMPATHY_STATEMENT',
        content: empathyDraftA.content,
        stage: 2,
        timestamp: timestamps.userAEmpathyShared,
      },
    });

    // ========================================
    // USER B STATE
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 90000),
        completedAt: timestamps.userBStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userBStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userBStage0Completed,
        completedAt: timestamps.userBStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userBStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - IN_PROGRESS
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 2,
        status: 'IN_PROGRESS',
        startedAt: timestamps.userBStage1Completed,
        gatesSatisfied: {},
      },
    });

    // User B's messages (conversation history)
    const userBMessages = [
      { role: 'AI' as const, content: `Welcome! ${userAName} invited you to work through some challenges together.`, stage: 0 },
      { role: 'USER' as const, content: "Things have been tense lately between us.", stage: 0 },
      { role: 'AI' as const, content: "I hear you. Tell me more about what's been happening.", stage: 1 },
      { role: 'USER' as const, content: "I feel like they don't see how much I'm dealing with at work.", stage: 1 },
      { role: 'AI' as const, content: "That sounds really hard. Can you tell me more?", stage: 1 },
      { role: 'USER' as const, content: "I work so hard and come home exhausted, but there's always more to do.", stage: 1 },
      { role: 'AI' as const, content: "I understand. How long has this been going on?", stage: 1 },
      { role: 'USER' as const, content: "Months now. I don't know how to get through to them.", stage: 1 },
      { role: 'AI' as const, content: "Do you feel like I understand what you've been going through?", stage: 1 },
      { role: 'USER' as const, content: "Yes, I feel heard.", stage: 1 },
      { role: 'AI' as const, content: `Good. Now let's work on understanding ${userAName}'s perspective.`, stage: 2 },
    ];

    for (let i = 0; i < userBMessages.length; i++) {
      const msg = userBMessages[i];
      await tx.message.create({
        data: {
          sessionId,
          senderId: msg.role === 'USER' ? userBId : null,
          forUserId: userBId,
          role: msg.role,
          content: msg.content,
          stage: msg.stage,
          timestamp: new Date(baseTime - 90000 + i * 5000),
        },
      });
    }

    // ========================================
    // RECONCILER RESULT & SHARE OFFER
    // ========================================

    // Create ReconcilerResult (the analysis that found gaps)
    const reconcilerResult = await tx.reconcilerResult.create({
      data: {
        sessionId,
        guesserId: userAId, // User A is the one who needs help understanding
        guesserName: userAName,
        subjectId: userBId, // User B is the subject being asked to share
        subjectName: userBName,
        alignmentScore: 45,
        alignmentSummary: `${userAName}'s empathy attempt captures some elements but misses key aspects of ${userBName}'s experience.`,
        correctlyIdentified: ['stress', 'work pressure'],
        gapSeverity: 'significant',
        gapSummary: `${userAName} hasn't fully grasped the depth of ${userBName}'s exhaustion and feeling unseen.`,
        missedFeelings: ['exhaustion', 'feeling unseen', 'overwhelm'],
        misattributions: [],
        mostImportantGap: `${userBName} feels exhausted and unseen, not just stressed.`,
        recommendedAction: 'OFFER_SHARING',
        rationale: `Sharing specific context would help ${userAName} understand ${userBName}'s perspective better.`,
        sharingWouldHelp: true,
        suggestedShareFocus: "The exhaustion from work and feeling unseen.",
        suggestedShareContent: "I feel like I'm running on empty - exhausted from work every day, and then coming home to more tasks. What I really need is for someone to see how hard I'm trying, even when I don't have anything left to give.",
        suggestedShareReason: `This helps ${userAName} understand that ${userBName}'s frustration comes from exhaustion and feeling unseen, not anger or blame.`,
        createdAt: timestamps.reconcilerRan,
      },
    });

    // Create the share offer (ACCEPTED since context was shared)
    const sharedContent = "I feel like I'm running on empty - exhausted from work every day, and then coming home to more tasks. What I really need is for someone to see how hard I'm trying, even when I don't have anything left to give.";

    await tx.reconcilerShareOffer.create({
      data: {
        resultId: reconcilerResult.id,
        userId: userBId,
        status: 'ACCEPTED', // User B accepted the suggestion
        suggestedContent: sharedContent,
        suggestedReason: reconcilerResult.suggestedShareReason,
        sharedContent: sharedContent, // Same as suggested (not refined)
        sharedAt: timestamps.contextShared,
        deliveryStatus: 'DELIVERED', // Delivered to User A
        deliveredAt: timestamps.contextShared,
      },
    });

    // ========================================
    // SHARED CONTEXT MESSAGES
    // ========================================

    // Message for User A (the guesser) - intro
    // Order: intro (oldest) → SHARED_CONTEXT (middle) → reflection (newest)
    // Using 100ms gaps to match production code and avoid any timestamp precision issues
    await tx.message.create({
      data: {
        sessionId,
        senderId: null,
        forUserId: userAId,
        role: 'AI',
        content: `${userBName} hasn't seen your empathy statement yet because the reconciler suggested they share more. This is what they shared:`,
        stage: 2,
        timestamp: new Date(timestamps.contextShared.getTime() - 200),
      },
    });

    // SHARED_CONTEXT message for User A (the guesser)
    await tx.message.create({
      data: {
        sessionId,
        senderId: userBId,
        forUserId: userAId,
        role: 'SHARED_CONTEXT',
        content: sharedContent,
        stage: 2,
        timestamp: new Date(timestamps.contextShared.getTime() - 100),
      },
    });

    // Reflection prompt for User A
    await tx.message.create({
      data: {
        sessionId,
        senderId: null,
        forUserId: userAId,
        role: 'AI',
        content: `How does this land for you? Take a moment to reflect on what ${userBName} shared. Does this give you any new insight into what they might be experiencing?`,
        stage: 2,
        timestamp: timestamps.contextShared,
      },
    });

    // SHARED_CONTEXT message for User B (showing what they shared in their own chat)
    await tx.message.create({
      data: {
        sessionId,
        senderId: userBId,
        forUserId: userBId,
        role: 'SHARED_CONTEXT',
        content: sharedContent,
        stage: 2,
        timestamp: timestamps.contextShared,
      },
    });

    // AI acknowledgment for User B
    await tx.message.create({
      data: {
        sessionId,
        senderId: null,
        forUserId: userBId,
        role: 'AI',
        content: `You shared this to help ${userAName} understand. They'll see it soon.`,
        stage: 2,
        timestamp: new Date(timestamps.contextShared.getTime() + 1),
      },
    });
  }

  /**
   * Create the full state for EMPATHY_REVEALED stage.
   * Both users are active and have:
   * - Completed Stage 0 (signed compact)
   * - Completed Stage 1 (felt heard)
   * - Shared empathy with each other
   * - Validated each other's empathy as accurate
   * - Now in Stage 2 COMPLETED, ready for Stage 3
   *
   * This stage is ideal for testing the Stage 3 (What Matters) flow.
   */
  private async createEmpathyRevealedState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string,
    userBId: string,
    userAName: string,
    userBName: string
  ): Promise<void> {
    const now = new Date();
    const baseTime = now.getTime();

    // Timeline (working backwards from now):
    // - now: Both users validated empathy, Stage 2 COMPLETE
    // - -10s: User B validated User A's empathy
    // - -20s: User A validated User B's empathy
    // - -30s: User B shared empathy
    // - -60s: User A shared empathy
    // - -90s: Both users completed Stage 1

    const timestamps = {
      userAStage0Completed: new Date(baseTime - 180000),
      userAStage1Completed: new Date(baseTime - 150000),
      userAEmpathyShared: new Date(baseTime - 120000),
      userBEmpathyShared: new Date(baseTime - 90000),
      userAValidated: new Date(baseTime - 60000),
      userBValidated: new Date(baseTime - 30000),
      userAEmpathyRevealed: new Date(baseTime - 50000), // When both empathies are READY → REVEALED
      userBEmpathyRevealed: new Date(baseTime - 50000),
      stage2Completed: now,
    };

    // ========================================
    // USER A STATE
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 200000),
        completedAt: timestamps.userAStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userAStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage0Completed,
        completedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userAStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - COMPLETED (empathy exchanged and validated)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 2,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage1Completed,
        completedAt: timestamps.stage2Completed,
        gatesSatisfied: {
          empathyExchanged: true,
          empathyExchangedAt: timestamps.stage2Completed.toISOString(),
        },
      },
    });

    // Stage 3 - IN_PROGRESS (What Matters)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 3,
        status: 'IN_PROGRESS',
        startedAt: timestamps.stage2Completed,
        gatesSatisfied: {},
      },
    });

    // User A's empathy draft and attempt
    const empathyDraftA = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userAId,
        content: `I understand you're feeling overwhelmed with work and home responsibilities. You need to feel seen and appreciated for all your efforts.`,
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftA.id,
        sourceUserId: userAId,
        content: empathyDraftA.content,
        status: 'VALIDATED',
        sharedAt: timestamps.userAEmpathyShared,
        revealedAt: timestamps.userAEmpathyRevealed,
        deliveryStatus: 'DELIVERED',
        deliveredAt: timestamps.userAEmpathyRevealed,
      },
    });

    // User A's consent record
    await tx.consentRecord.create({
      data: {
        userId: userAId,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: empathyDraftA.id,
        requestedByUserId: userAId,
        decision: 'GRANTED',
        decidedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's EMPATHY_STATEMENT message
    await tx.message.create({
      data: {
        sessionId,
        senderId: userAId,
        forUserId: userAId,
        role: 'EMPATHY_STATEMENT',
        content: empathyDraftA.content,
        stage: 2,
        timestamp: timestamps.userAEmpathyShared,
      },
    });

    // Validation message from User B's perspective
    await tx.message.create({
      data: {
        sessionId,
        senderId: userBId,
        forUserId: userAId,
        role: 'EMPATHY_VALIDATION_PROMPT',
        content: 'VALIDATED',
        stage: 2,
        timestamp: timestamps.userBValidated,
      },
    });

    // ========================================
    // USER B STATE
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 200000),
        completedAt: timestamps.userAStage0Completed,
        gatesSatisfied: {
          compactSigned: true,
          compactSignedAt: timestamps.userAStage0Completed.toISOString(),
        },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage0Completed,
        completedAt: timestamps.userAStage1Completed,
        gatesSatisfied: {
          feelHeardConfirmed: true,
          feelHeardConfirmedAt: timestamps.userAStage1Completed.toISOString(),
        },
      },
    });

    // Stage 2 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 2,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage1Completed,
        completedAt: timestamps.stage2Completed,
        gatesSatisfied: {
          empathyExchanged: true,
          empathyExchangedAt: timestamps.stage2Completed.toISOString(),
        },
      },
    });

    // Stage 3 - IN_PROGRESS
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 3,
        status: 'IN_PROGRESS',
        startedAt: timestamps.stage2Completed,
        gatesSatisfied: {},
      },
    });

    // User B's empathy draft and attempt
    const empathyDraftB = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userBId,
        content: `I hear that you're frustrated about household chores and feeling like you carry more of the burden. You want appreciation and partnership.`,
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftB.id,
        sourceUserId: userBId,
        content: empathyDraftB.content,
        status: 'VALIDATED',
        sharedAt: timestamps.userBEmpathyShared,
        revealedAt: timestamps.userBEmpathyRevealed,
        deliveryStatus: 'DELIVERED',
        deliveredAt: timestamps.userBEmpathyRevealed,
      },
    });

    // User B's consent record
    await tx.consentRecord.create({
      data: {
        userId: userBId,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: empathyDraftB.id,
        requestedByUserId: userBId,
        decision: 'GRANTED',
        decidedAt: timestamps.userBEmpathyShared,
      },
    });

    // User B's EMPATHY_STATEMENT message
    await tx.message.create({
      data: {
        sessionId,
        senderId: userBId,
        forUserId: userBId,
        role: 'EMPATHY_STATEMENT',
        content: empathyDraftB.content,
        stage: 2,
        timestamp: timestamps.userBEmpathyShared,
      },
    });

    // Validation message from User A's perspective
    await tx.message.create({
      data: {
        sessionId,
        senderId: userAId,
        forUserId: userBId,
        role: 'EMPATHY_VALIDATION_PROMPT',
        content: 'VALIDATED',
        stage: 2,
        timestamp: timestamps.userAValidated,
      },
    });
  }

  /**
   * Create the full state for NEED_MAPPING_COMPLETE stage.
   * Both users have:
   * - Completed Stage 2 (empathy exchanged and validated)
   * - Identified their needs in Stage 3
   * - Confirmed common ground
   * - Now in Stage 4 IN_PROGRESS (Strategic Repair)
   *
   * This stage is ideal for testing the Stage 4 (Strategic Repair) flow.
   */
  private async createNeedMappingCompleteState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string,
    userBId: string,
    userAName: string,
    userBName: string
  ): Promise<void> {
    const now = new Date();
    const baseTime = now.getTime();

    // Timeline
    const timestamps = {
      userAStage0Completed: new Date(baseTime - 300000),
      userAStage1Completed: new Date(baseTime - 240000),
      userAEmpathyShared: new Date(baseTime - 180000),
      userBEmpathyShared: new Date(baseTime - 150000),
      empathyValidated: new Date(baseTime - 120000),
      needsIdentified: new Date(baseTime - 60000),
      needsValidated: new Date(baseTime - 30000),
      stage3Completed: now,
    };

    const sharedVessel = await tx.sharedVessel.findUnique({ where: { sessionId } });
    if (!sharedVessel) {
      throw new Error(`Shared vessel not found for session ${sessionId}`);
    }
    const [userAVessel, userBVessel] = await Promise.all([
      tx.userVessel.findUnique({ where: { userId_sessionId: { userId: userAId, sessionId } } }),
      tx.userVessel.findUnique({ where: { userId_sessionId: { userId: userBId, sessionId } } }),
    ]);
    if (!userAVessel || !userBVessel) {
      throw new Error(`User vessels not found for session ${sessionId}`);
    }

    // ========================================
    // USER A STATE - Stages 0-3 COMPLETED, Stage 4 IN_PROGRESS
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 350000),
        completedAt: timestamps.userAStage0Completed,
        gatesSatisfied: { compactSigned: true },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage0Completed,
        completedAt: timestamps.userAStage1Completed,
        gatesSatisfied: { feelHeardConfirmed: true },
      },
    });

    // Stage 2 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 2,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage1Completed,
        completedAt: timestamps.empathyValidated,
        gatesSatisfied: { empathyExchanged: true },
      },
    });

    // Stage 3 - COMPLETED (What Matters)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 3,
        status: 'COMPLETED',
        startedAt: timestamps.empathyValidated,
        completedAt: timestamps.stage3Completed,
        gatesSatisfied: {
          needsIdentified: true,
          needsIdentifiedAt: timestamps.needsIdentified.toISOString(),
          needsValidated: true,
          needsValidatedAt: timestamps.needsValidated.toISOString(),
        },
      },
    });

    // Stage 4 - IN_PROGRESS (Strategic Repair)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 4,
        status: 'IN_PROGRESS',
        startedAt: timestamps.stage3Completed,
        gatesSatisfied: {},
      },
    });

    // User A's empathy attempt
    const empathyDraftA = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userAId,
        content: `I understand you're feeling overwhelmed with work and home responsibilities.`,
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftA.id,
        sourceUserId: userAId,
        content: empathyDraftA.content,
        status: 'VALIDATED',
        sharedAt: timestamps.userAEmpathyShared,
      },
    });

    // User A's needs
    await tx.identifiedNeed.createMany({
      data: [
        {
          vesselId: userAVessel.id,
          need: 'Appreciation',
          category: 'RECOGNITION',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
        {
          vesselId: userAVessel.id,
          need: 'Partnership',
          category: 'FAIRNESS',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
      ],
    });

    // ========================================
    // USER B STATE - Stages 0-3 COMPLETED, Stage 4 IN_PROGRESS
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 350000),
        completedAt: timestamps.userAStage0Completed,
        gatesSatisfied: { compactSigned: true },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage0Completed,
        completedAt: timestamps.userAStage1Completed,
        gatesSatisfied: { feelHeardConfirmed: true },
      },
    });

    // Stage 2 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 2,
        status: 'COMPLETED',
        startedAt: timestamps.userAStage1Completed,
        completedAt: timestamps.empathyValidated,
        gatesSatisfied: { empathyExchanged: true },
      },
    });

    // Stage 3 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 3,
        status: 'COMPLETED',
        startedAt: timestamps.empathyValidated,
        completedAt: timestamps.stage3Completed,
        gatesSatisfied: {
          needsIdentified: true,
          needsIdentifiedAt: timestamps.needsIdentified.toISOString(),
          needsValidated: true,
          needsValidatedAt: timestamps.needsValidated.toISOString(),
        },
      },
    });

    // Stage 4 - IN_PROGRESS
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 4,
        status: 'IN_PROGRESS',
        startedAt: timestamps.stage3Completed,
        gatesSatisfied: {},
      },
    });

    // User B's empathy attempt
    const empathyDraftB = await tx.empathyDraft.create({
      data: {
        sessionId,
        userId: userBId,
        content: `I hear that you're frustrated about household chores and feeling like you carry more of the burden.`,
        readyToShare: true,
      },
    });

    await tx.empathyAttempt.create({
      data: {
        sessionId,
        draftId: empathyDraftB.id,
        sourceUserId: userBId,
        content: empathyDraftB.content,
        status: 'VALIDATED',
        sharedAt: timestamps.userBEmpathyShared,
      },
    });

    // User B's needs
    await tx.identifiedNeed.createMany({
      data: [
        {
          vesselId: userBVessel.id,
          need: 'Understanding',
          category: 'CONNECTION',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
        {
          vesselId: userBVessel.id,
          need: 'Support',
          category: 'CONNECTION',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
      ],
    });

  }

  /**
   * Create deterministic redesigned Stage 4 fixtures on top of completed Stage 3.
   *
   * These states avoid LLM nondeterminism while covering the proposal inventory,
   * removed proposal, selection privacy, closure, and Tending paths.
   */
  private async createStage4RedesignFixtureState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string,
    userBId: string,
    userAName: string,
    userBName: string,
    targetStage: TargetStage
  ): Promise<void> {
    await this.createNeedMappingCompleteState(tx, sessionId, userAId, userBId, userAName, userBName);

    const now = new Date();
    const sharedCheckin = await tx.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: userAId,
        description: 'Try a Sunday evening planning check-in for the next two weeks',
        needsAddressed: ['Partnership', 'Support'],
        duration: 'Two weeks',
        measureOfSuccess: 'Both people know the week plan before Monday',
        kind: Stage4ProposalKind.SHARED_PROPOSAL,
        status: Stage4ProposalStatus.ACTIVE,
        coverageSummary: { fixture: 'shared-agreement-with-tending' },
      },
    });
    const sharedPause = await tx.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: userBId,
        description: 'Use a pause phrase when either person starts to shut down',
        needsAddressed: ['Understanding'],
        duration: 'One month',
        measureOfSuccess: 'Hard conversations can pause without either person feeling abandoned',
        kind: Stage4ProposalKind.SHARED_PROPOSAL,
        status: Stage4ProposalStatus.ACTIVE,
        coverageSummary: { fixture: 'alternate-shared-proposal' },
      },
    });
    const individualCommitment = await tx.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: userAId,
        description: 'I will name when I am overloaded before I disappear',
        needsAddressed: ['Appreciation'],
        duration: 'This week',
        measureOfSuccess: 'Stress is named before withdrawal',
        kind: Stage4ProposalKind.INDIVIDUAL_COMMITMENT,
        status: Stage4ProposalStatus.ACTIVE,
        coverageSummary: { fixture: 'individual-only-commitment' },
      },
    });
    const removedProposal = await tx.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: userBId,
        description: 'Track every chore in a shared spreadsheet every night',
        needsAddressed: ['Partnership'],
        duration: 'One week',
        measureOfSuccess: 'Every chore is logged',
        kind: Stage4ProposalKind.SHARED_PROPOSAL,
        status: Stage4ProposalStatus.REMOVED,
        removedAt: now,
        removedByUserId: userBId,
        removalReason: 'Partner said this felt too controlling',
        coverageSummary: { fixture: 'removed-proposal' },
      },
    });

    await tx.stage4ProposalRevision.createMany({
      data: [
        {
          proposalId: sharedCheckin.id,
          sessionId,
          actorUserId: userAId,
          action: 'CREATED',
          after: { description: sharedCheckin.description },
          reason: 'E2E redesigned Stage 4 fixture',
        },
        {
          proposalId: sharedPause.id,
          sessionId,
          actorUserId: userBId,
          action: 'CREATED',
          after: { description: sharedPause.description },
          reason: 'E2E redesigned Stage 4 fixture',
        },
        {
          proposalId: individualCommitment.id,
          sessionId,
          actorUserId: userAId,
          action: 'CREATED',
          after: { description: individualCommitment.description },
          reason: 'E2E redesigned Stage 4 fixture',
        },
        {
          proposalId: removedProposal.id,
          sessionId,
          actorUserId: userBId,
          action: 'REMOVED',
          before: { status: Stage4ProposalStatus.ACTIVE },
          after: { status: Stage4ProposalStatus.REMOVED },
          reason: 'E2E redesigned Stage 4 fixture',
        },
      ],
    });

    await tx.stage4NeedCoverage.createMany({
      data: [
        {
          sessionId,
          needLabel: 'Partnership',
          sourceUserId: userAId,
          coverageStatus: 'COVERED',
          coveringProposalIds: [sharedCheckin.id],
          note: 'Sunday planning check-in directly covers partnership.',
        },
        {
          sessionId,
          needLabel: 'Support',
          sourceUserId: userBId,
          coverageStatus: 'PARTIAL',
          coveringProposalIds: [sharedCheckin.id, sharedPause.id],
          note: 'Support is partly covered but may need more specificity.',
        },
        {
          sessionId,
          needLabel: 'Appreciation',
          sourceUserId: userAId,
          coverageStatus: 'OPEN',
          coveringProposalIds: [],
          note: 'No active shared proposal directly covers appreciation yet.',
        },
      ],
    });

    if (targetStage === TargetStage.STAGE4_REDESIGN_INVENTORY) {
      return;
    }

    const selections =
      targetStage === TargetStage.STAGE4_REDESIGN_SHARED_SELECTIONS
        ? [
            { proposalId: sharedCheckin.id, userId: userAId, decision: Stage4SelectionDecision.WILLING },
            { proposalId: sharedCheckin.id, userId: userBId, decision: Stage4SelectionDecision.WILLING },
            { proposalId: sharedPause.id, userId: userAId, decision: Stage4SelectionDecision.NOT_WILLING },
            { proposalId: sharedPause.id, userId: userBId, decision: Stage4SelectionDecision.NOT_WILLING },
            { proposalId: individualCommitment.id, userId: userAId, decision: Stage4SelectionDecision.WILLING },
          ]
        : targetStage === TargetStage.STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS
          ? [
              { proposalId: sharedCheckin.id, userId: userAId, decision: Stage4SelectionDecision.WILLING },
              { proposalId: sharedCheckin.id, userId: userBId, decision: Stage4SelectionDecision.NOT_WILLING },
              { proposalId: sharedPause.id, userId: userAId, decision: Stage4SelectionDecision.NOT_WILLING },
              { proposalId: sharedPause.id, userId: userBId, decision: Stage4SelectionDecision.WILLING },
              { proposalId: individualCommitment.id, userId: userAId, decision: Stage4SelectionDecision.WILLING },
            ]
          : [
              { proposalId: sharedCheckin.id, userId: userAId, decision: Stage4SelectionDecision.WILLING },
            ];

    await tx.stage4ProposalSelection.createMany({
      data: selections.map((selection) => ({
        ...selection,
        sessionId,
        selectedAt: now,
      })),
    });

    await tx.stageProgress.updateMany({
      where: {
        sessionId,
        userId: { in: [...new Set(selections.map((selection) => selection.userId))] },
        stage: 4,
      },
      data: {
        gatesSatisfied: {
          selectionSubmitted: true,
          selectionSubmittedAt: now.toISOString(),
        },
      },
    });
  }

  /**
   * Create the full state for STRATEGIC_REPAIR_COMPLETE stage.
   * Both users have:
   * - Completed Stage 3 (need mapping)
   * - Collected strategies
   * - Ranked strategies
   * - Created an agreement
   * - Now in Stage 4 COMPLETED
   *
   * This stage represents a fully completed session.
   */
  private async createStrategicRepairCompleteState(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sessionId: string,
    userAId: string,
    userBId: string,
    userAName: string,
    userBName: string
  ): Promise<void> {
    const now = new Date();
    const baseTime = now.getTime();

    // Timeline
    const timestamps = {
      empathyValidated: new Date(baseTime - 300000),
      needsIdentified: new Date(baseTime - 240000),
      needsValidated: new Date(baseTime - 180000),
      stage3Completed: new Date(baseTime - 150000),
      strategiesCollected: new Date(baseTime - 120000),
      strategiesRanked: new Date(baseTime - 90000),
      overlapRevealed: new Date(baseTime - 60000),
      agreementCreated: new Date(baseTime - 30000),
      agreementConfirmed: now,
    };

    const sharedVessel = await tx.sharedVessel.findUnique({ where: { sessionId } });
    if (!sharedVessel) {
      throw new Error(`Shared vessel not found for session ${sessionId}`);
    }
    const [userAVessel, userBVessel] = await Promise.all([
      tx.userVessel.findUnique({ where: { userId_sessionId: { userId: userAId, sessionId } } }),
      tx.userVessel.findUnique({ where: { userId_sessionId: { userId: userBId, sessionId } } }),
    ]);
    if (!userAVessel || !userBVessel) {
      throw new Error(`User vessels not found for session ${sessionId}`);
    }

    // ========================================
    // USER A STATE - All stages COMPLETED
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 400000),
        completedAt: new Date(baseTime - 350000),
        gatesSatisfied: { compactSigned: true },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 350000),
        completedAt: new Date(baseTime - 320000),
        gatesSatisfied: { feelHeardConfirmed: true },
      },
    });

    // Stage 2 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 2,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 320000),
        completedAt: timestamps.empathyValidated,
        gatesSatisfied: { empathyExchanged: true },
      },
    });

    // Stage 3 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 3,
        status: 'COMPLETED',
        startedAt: timestamps.empathyValidated,
        completedAt: timestamps.stage3Completed,
        gatesSatisfied: {
          needsIdentified: true,
          needsValidated: true,
        },
      },
    });

    // Stage 4 - COMPLETED (Strategic Repair)
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userAId,
        stage: 4,
        status: 'COMPLETED',
        startedAt: timestamps.stage3Completed,
        completedAt: timestamps.agreementConfirmed,
        gatesSatisfied: {
          strategiesRanked: true,
          agreementCreated: true,
          agreementConfirmed: true,
        },
      },
    });

    // ========================================
    // USER B STATE - All stages COMPLETED
    // ========================================

    // Stage 0 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 0,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 400000),
        completedAt: new Date(baseTime - 350000),
        gatesSatisfied: { compactSigned: true },
      },
    });

    // Stage 1 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 1,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 350000),
        completedAt: new Date(baseTime - 320000),
        gatesSatisfied: { feelHeardConfirmed: true },
      },
    });

    // Stage 2 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 2,
        status: 'COMPLETED',
        startedAt: new Date(baseTime - 320000),
        completedAt: timestamps.empathyValidated,
        gatesSatisfied: { empathyExchanged: true },
      },
    });

    // Stage 3 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 3,
        status: 'COMPLETED',
        startedAt: timestamps.empathyValidated,
        completedAt: timestamps.stage3Completed,
        gatesSatisfied: {
          needsIdentified: true,
          needsValidated: true,
        },
      },
    });

    // Stage 4 - COMPLETED
    await tx.stageProgress.create({
      data: {
        sessionId,
        userId: userBId,
        stage: 4,
        status: 'COMPLETED',
        startedAt: timestamps.stage3Completed,
        completedAt: timestamps.agreementConfirmed,
        gatesSatisfied: {
          strategiesRanked: true,
          agreementCreated: true,
          agreementConfirmed: true,
        },
      },
    });

    // ========================================
    // SHARED DATA: Needs, Common Ground, Strategies, Agreement
    // ========================================

    // Needs for both users
    await tx.identifiedNeed.createMany({
      data: [
        {
          vesselId: userAVessel.id,
          need: 'Appreciation',
          category: 'RECOGNITION',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
        {
          vesselId: userAVessel.id,
          need: 'Partnership',
          category: 'FAIRNESS',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
        {
          vesselId: userBVessel.id,
          need: 'Understanding',
          category: 'CONNECTION',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
        {
          vesselId: userBVessel.id,
          need: 'Support',
          category: 'CONNECTION',
          evidence: [],
          aiConfidence: 0.95,
          confirmed: true,
          createdAt: timestamps.needsIdentified,
        },
      ],
    });

    // Strategies
    const strategy1 = await tx.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: userAId,
        description: 'Weekly check-in on Sundays to discuss upcoming week and divide tasks',
        needsAddressed: ['Appreciation', 'Partnership'],
        duration: 'ongoing',
        createdAt: timestamps.strategiesCollected,
      },
    });

    const strategy2 = await tx.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: userBId,
        description: 'Express appreciation for at least one thing your partner did each day',
        needsAddressed: ['Recognition'],
        duration: 'ongoing',
        createdAt: timestamps.strategiesCollected,
      },
    });

    const strategy3 = await tx.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: userAId,
        description: 'Take 10 minutes to decompress when arriving home before discussing responsibilities',
        needsAddressed: ['Emotional safety'],
        duration: 'ongoing',
        createdAt: timestamps.strategiesCollected,
      },
    });

    // Strategy rankings (both users ranked the same strategies)
    await tx.strategyRanking.createMany({
      data: [
        {
          sessionId,
          userId: userAId,
          rankedIds: [strategy1.id, strategy2.id, strategy3.id],
          submittedAt: timestamps.strategiesRanked,
        },
        {
          sessionId,
          userId: userBId,
          rankedIds: [strategy2.id, strategy1.id, strategy3.id],
          submittedAt: timestamps.strategiesRanked,
        },
      ],
    });

    // Agreement
    await tx.agreement.create({
      data: {
        sharedVesselId: sharedVessel.id,
        description: 'Weekly check-in on Sundays to discuss upcoming week and divide tasks',
        type: 'COMMITMENT',
        proposalId: strategy1.id,
        followUpDate: new Date(baseTime + 14 * 24 * 60 * 60 * 1000), // 2 weeks from now
        status: 'AGREED',
        agreedByA: true,
        agreedByB: true,
        agreedAt: timestamps.agreementConfirmed,
      },
    });
  }
}

/**
 * Singleton instance for convenience
 */
export const stateFactory = new StateFactory();
