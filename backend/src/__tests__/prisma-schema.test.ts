import {
  PrismaClient,
  Prisma,
  SessionStatus,
  StageStatus,
  MessageRole,
  Attribution,
  NeedCategory,
  ConsentDecision,
  ConsentContentType,
  AgreementType,
  AgreementStatus,
  GlobalLibrarySource,
  StrategySource,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
  TendingEntryStatus,
  TendingEntryType,
  ExerciseType,
} from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../lib/prisma-pg';

import {
  SessionStatus as SharedSessionStatus,
  StageStatus as SharedStageStatus,
  MessageRole as SharedMessageRole,
  Attribution as SharedAttribution,
  NeedCategory as SharedNeedCategory,
  ConsentDecision as SharedConsentDecision,
  ConsentContentType as SharedConsentContentType,
  AgreementType as SharedAgreementType,
  AgreementStatus as SharedAgreementStatus,
  GlobalLibrarySource as SharedGlobalLibrarySource,
} from '@meet-without-fear/shared';

/**
 * Prisma Schema Tests
 *
 * These tests validate that the Prisma schema is correctly configured
 * and the client types are properly generated.
 *
 * Note: Database connection tests are skipped when DATABASE_URL is not available.
 */
describe('Prisma Schema', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Schema Type Validation', () => {
    it('exports all expected models', () => {
      // Verify prisma client has all expected model delegates
      expect(prisma.user).toBeDefined();
      expect(prisma.relationship).toBeDefined();
      expect(prisma.relationshipMember).toBeDefined();
      expect(prisma.session).toBeDefined();
      expect(prisma.stageProgress).toBeDefined();
      expect(prisma.userVessel).toBeDefined();
      expect(prisma.userEvent).toBeDefined();
      expect(prisma.emotionalReading).toBeDefined();
      expect(prisma.identifiedNeed).toBeDefined();
      expect(prisma.boundary).toBeDefined();
      expect(prisma.userDocument).toBeDefined();
      expect(prisma.sharedVessel).toBeDefined();
      expect(prisma.consentedContent).toBeDefined();
      expect(prisma.commonGround).toBeDefined();
      expect(prisma.agreement).toBeDefined();
      expect(prisma.consentRecord).toBeDefined();
      expect(prisma.message).toBeDefined();
      expect(prisma.empathyDraft).toBeDefined();
      expect(prisma.empathyAttempt).toBeDefined();
      expect(prisma.empathyValidation).toBeDefined();
      expect(prisma.strategyProposal).toBeDefined();
      expect(prisma.strategyRanking).toBeDefined();
      expect(prisma.stage4ProposalSelection).toBeDefined();
      expect(prisma.stage4ProposalRevision).toBeDefined();
      expect(prisma.stage4NeedCoverage).toBeDefined();
      expect(prisma.stage4Closure).toBeDefined();
      expect(prisma.tendingEntry).toBeDefined();
      expect(prisma.tendingResponse).toBeDefined();
      expect(prisma.emotionalExerciseCompletion).toBeDefined();
      expect(prisma.globalLibraryItem).toBeDefined();
    });

    it('exports SessionStatus enum with correct values', () => {
      expect(SessionStatus.CREATED).toBe('CREATED');
      expect(SessionStatus.INVITED).toBe('INVITED');
      expect(SessionStatus.ACTIVE).toBe('ACTIVE');
      expect(SessionStatus.PAUSED).toBe('PAUSED');
      expect(SessionStatus.WAITING).toBe('WAITING');
      expect(SessionStatus.RESOLVED).toBe('RESOLVED');
      expect(SessionStatus.ABANDONED).toBe('ABANDONED');
    });

    it('exports StageStatus enum with correct values', () => {
      expect(StageStatus.NOT_STARTED).toBe('NOT_STARTED');
      expect(StageStatus.IN_PROGRESS).toBe('IN_PROGRESS');
      expect(StageStatus.GATE_PENDING).toBe('GATE_PENDING');
      expect(StageStatus.COMPLETED).toBe('COMPLETED');
    });

    it('exports MessageRole enum with correct values', () => {
      expect(MessageRole.USER).toBe('USER');
      expect(MessageRole.AI).toBe('AI');
      expect(MessageRole.SYSTEM).toBe('SYSTEM');
      expect(MessageRole.VALIDATION_FEEDBACK).toBe('VALIDATION_FEEDBACK');
    });

    it('exports Attribution enum with correct values', () => {
      expect(Attribution.SELF).toBe('SELF');
      expect(Attribution.OTHER).toBe('OTHER');
      expect(Attribution.MUTUAL).toBe('MUTUAL');
      expect(Attribution.EXTERNAL).toBe('EXTERNAL');
    });

    it('exports NeedCategory enum with correct values', () => {
      expect(NeedCategory.SAFETY).toBe('SAFETY');
      expect(NeedCategory.CONNECTION).toBe('CONNECTION');
      expect(NeedCategory.AUTONOMY).toBe('AUTONOMY');
      expect(NeedCategory.RECOGNITION).toBe('RECOGNITION');
      expect(NeedCategory.MEANING).toBe('MEANING');
      expect(NeedCategory.FAIRNESS).toBe('FAIRNESS');
    });

    it('exports ConsentDecision enum with correct values', () => {
      expect(ConsentDecision.GRANTED).toBe('GRANTED');
      expect(ConsentDecision.DENIED).toBe('DENIED');
      expect(ConsentDecision.REVOKED).toBe('REVOKED');
    });

    it('exports ConsentContentType enum with correct values', () => {
      expect(ConsentContentType.IDENTIFIED_NEED).toBe('IDENTIFIED_NEED');
      expect(ConsentContentType.EVENT_SUMMARY).toBe('EVENT_SUMMARY');
      expect(ConsentContentType.EMOTIONAL_PATTERN).toBe('EMOTIONAL_PATTERN');
      expect(ConsentContentType.BOUNDARY).toBe('BOUNDARY');
      expect(ConsentContentType.EMPATHY_DRAFT).toBe('EMPATHY_DRAFT');
      expect(ConsentContentType.EMPATHY_ATTEMPT).toBe('EMPATHY_ATTEMPT');
      expect(ConsentContentType.STRATEGY_PROPOSAL).toBe('STRATEGY_PROPOSAL');
    });

    it('exports AgreementType enum with correct values', () => {
      expect(AgreementType.MICRO_EXPERIMENT).toBe('MICRO_EXPERIMENT');
      expect(AgreementType.COMMITMENT).toBe('COMMITMENT');
      expect(AgreementType.CHECK_IN).toBe('CHECK_IN');
    });

    it('exports AgreementStatus enum with correct values', () => {
      expect(AgreementStatus.PROPOSED).toBe('PROPOSED');
      expect(AgreementStatus.AGREED).toBe('AGREED');
      expect(AgreementStatus.IN_PROGRESS).toBe('IN_PROGRESS');
      expect(AgreementStatus.COMPLETED).toBe('COMPLETED');
      expect(AgreementStatus.ABANDONED).toBe('ABANDONED');
    });

    it('exports GlobalLibrarySource enum with correct values', () => {
      expect(GlobalLibrarySource.CURATED).toBe('CURATED');
      expect(GlobalLibrarySource.CONTRIBUTED).toBe('CONTRIBUTED');
    });

    it('exports StrategySource enum with correct values', () => {
      expect(StrategySource.USER_SUBMITTED).toBe('USER_SUBMITTED');
      expect(StrategySource.AI_SUGGESTED).toBe('AI_SUGGESTED');
      expect(StrategySource.CURATED).toBe('CURATED');
    });

    it('exports Stage 4 and Tending enums with correct values', () => {
      expect(Stage4ProposalKind.SHARED_PROPOSAL).toBe('SHARED_PROPOSAL');
      expect(Stage4ProposalKind.INDIVIDUAL_COMMITMENT).toBe('INDIVIDUAL_COMMITMENT');
      expect(Stage4ProposalStatus.ACTIVE).toBe('ACTIVE');
      expect(Stage4ProposalStatus.REVISED).toBe('REVISED');
      expect(Stage4ProposalStatus.REMOVED).toBe('REMOVED');
      expect(Stage4ProposalStatus.CONVERTED_TO_AGREEMENT).toBe('CONVERTED_TO_AGREEMENT');
      expect(Stage4SelectionDecision.WILLING).toBe('WILLING');
      expect(Stage4SelectionDecision.NOT_WILLING).toBe('NOT_WILLING');
      expect(Stage4ClosureKind.SHARED_AGREEMENT).toBe('SHARED_AGREEMENT');
      expect(Stage4ClosureKind.NO_SHARED_AGREEMENT).toBe('NO_SHARED_AGREEMENT');
      expect(Stage4ClosureReason.MUTUAL_SELECTION).toBe('MUTUAL_SELECTION');
      expect(Stage4ClosureReason.NO_OVERLAP).toBe('NO_OVERLAP');
      expect(Stage4ClosureReason.BOUNDARY_HONORED).toBe('BOUNDARY_HONORED');
      expect(Stage4ClosureReason.USER_STOPPED).toBe('USER_STOPPED');
      expect(TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN).toBe('SCHEDULED_SHARED_AGREEMENT_CHECKIN');
      expect(TendingEntryType.USER_INITIATED_REENTRY).toBe('USER_INITIATED_REENTRY');
      expect(TendingEntryStatus.SCHEDULED).toBe('SCHEDULED');
      expect(TendingEntryStatus.OPEN).toBe('OPEN');
      expect(TendingEntryStatus.PARTIAL).toBe('PARTIAL');
      expect(TendingEntryStatus.COMPLETED).toBe('COMPLETED');
      expect(TendingEntryStatus.EXPIRED).toBe('EXPIRED');
      expect(TendingEntryStatus.CANCELLED).toBe('CANCELLED');
    });

    it('exports ExerciseType enum with correct values', () => {
      expect(ExerciseType.BREATHING_EXERCISE).toBe('BREATHING_EXERCISE');
      expect(ExerciseType.BODY_SCAN).toBe('BODY_SCAN');
      expect(ExerciseType.GROUNDING).toBe('GROUNDING');
      expect(ExerciseType.PAUSE_SESSION).toBe('PAUSE_SESSION');
    });
  });

  describe('Type-safe Input Validation', () => {
    it('allows creating valid User input', () => {
      const userInput: Prisma.UserCreateInput = {
        email: 'test@example.com',
        name: 'Test User',
      };
      expect(userInput.email).toBe('test@example.com');
    });

    it('allows creating valid Session input', () => {
      const sessionInput: Prisma.SessionCreateInput = {
        relationship: {
          create: {},
        },
        status: SessionStatus.CREATED,
      };
      expect(sessionInput.status).toBe('CREATED');
    });

    it('allows creating valid Message input', () => {
      const messageInput: Prisma.MessageCreateInput = {
        session: { connect: { id: 'session-id' } },
        role: MessageRole.USER,
        content: 'Hello world',
        stage: 1,
      };
      expect(messageInput.role).toBe('USER');
      expect(messageInput.stage).toBe(1);
    });

    it('allows creating valid StageProgress input', () => {
      const progressInput: Prisma.StageProgressCreateInput = {
        session: { connect: { id: 'session-id' } },
        user: { connect: { id: 'user-id' } },
        stage: 1,
        status: StageStatus.IN_PROGRESS,
      };
      expect(progressInput.status).toBe('IN_PROGRESS');
    });

    it('allows creating valid ConsentRecord input', () => {
      const consentInput: Prisma.ConsentRecordCreateInput = {
        user: { connect: { id: 'user-id' } },
        targetType: ConsentContentType.IDENTIFIED_NEED,
        requestedBy: { connect: { id: 'other-user-id' } },
      };
      expect(consentInput.targetType).toBe('IDENTIFIED_NEED');
    });

    it('allows creating valid EmpathyDraft input', () => {
      const draftInput: Prisma.EmpathyDraftCreateInput = {
        session: { connect: { id: 'session-id' } },
        user: { connect: { id: 'user-id' } },
        content: 'I understand that you feel...',
        readyToShare: false,
      };
      expect(draftInput.content).toBe('I understand that you feel...');
    });

    it('allows creating valid StrategyProposal input', () => {
      const proposalInput: Prisma.StrategyProposalCreateInput = {
        session: { connect: { id: 'session-id' } },
        description: 'Weekly check-ins',
        needsAddressed: ['CONNECTION', 'RECOGNITION'],
        source: StrategySource.USER_SUBMITTED,
        kind: Stage4ProposalKind.SHARED_PROPOSAL,
        status: Stage4ProposalStatus.ACTIVE,
      };
      expect(proposalInput.source).toBe('USER_SUBMITTED');
      expect(proposalInput.needsAddressed).toHaveLength(2);
      expect(proposalInput.kind).toBe('SHARED_PROPOSAL');
    });

    it('allows creating valid Stage 4 selection input', () => {
      const selectionInput: Prisma.Stage4ProposalSelectionCreateInput = {
        proposal: { connect: { id: 'proposal-id' } },
        session: { connect: { id: 'session-id' } },
        user: { connect: { id: 'user-id' } },
        decision: Stage4SelectionDecision.WILLING,
        note: 'I can try this for two weeks',
      };
      expect(selectionInput.decision).toBe('WILLING');
    });

    it('allows creating valid Stage 4 closure input without agreements', () => {
      const closureInput: Prisma.Stage4ClosureCreateInput = {
        session: { connect: { id: 'session-id' } },
        kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
        reason: Stage4ClosureReason.NO_OVERLAP,
        summary: 'The session closed with open needs named and no shared obligation.',
        sharedAgreementIds: [],
        individualProposalIds: ['proposal-id'],
        openNeedIds: ['need-id'],
      };
      expect(closureInput.kind).toBe('NO_SHARED_AGREEMENT');
      expect(closureInput.sharedAgreementIds).toEqual([]);
    });

    it('allows creating valid Tending entry and response inputs', () => {
      const entryInput: Prisma.TendingEntryCreateInput = {
        session: { connect: { id: 'session-id' } },
        type: TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN,
        status: TendingEntryStatus.SCHEDULED,
        scheduledFor: new Date('2026-05-20T17:00:00.000Z'),
      };
      const responseInput: Prisma.TendingResponseCreateInput = {
        tendingEntry: { connect: { id: 'entry-id' } },
        user: { connect: { id: 'user-id' } },
        status: 'PARTLY',
        continueChoice: 'ANOTHER_ROUND',
      };
      expect(entryInput.type).toBe('SCHEDULED_SHARED_AGREEMENT_CHECKIN');
      expect(responseInput.continueChoice).toBe('ANOTHER_ROUND');
    });

    it('allows creating valid GlobalLibraryItem input', () => {
      const libraryInput: Prisma.GlobalLibraryItemCreateInput = {
        title: 'Weekly Date Night',
        description: 'Schedule regular quality time together',
        category: 'quality-time',
        source: GlobalLibrarySource.CURATED,
      };
      expect(libraryInput.source).toBe('CURATED');
    });
  });

  describe('Enum Alignment with Shared Package', () => {
    /**
     * These tests verify that Prisma enums match the shared package enums.
     * This ensures type consistency between backend (using Prisma) and mobile (using shared).
     */

    it('SessionStatus enum values match shared package', () => {
      expect(SessionStatus.CREATED).toBe(SharedSessionStatus.CREATED);
      expect(SessionStatus.INVITED).toBe(SharedSessionStatus.INVITED);
      expect(SessionStatus.ACTIVE).toBe(SharedSessionStatus.ACTIVE);
      expect(SessionStatus.PAUSED).toBe(SharedSessionStatus.PAUSED);
      expect(SessionStatus.WAITING).toBe(SharedSessionStatus.WAITING);
      expect(SessionStatus.RESOLVED).toBe(SharedSessionStatus.RESOLVED);
      expect(SessionStatus.ABANDONED).toBe(SharedSessionStatus.ABANDONED);
    });

    it('StageStatus enum values match shared package', () => {
      expect(StageStatus.NOT_STARTED).toBe(SharedStageStatus.NOT_STARTED);
      expect(StageStatus.IN_PROGRESS).toBe(SharedStageStatus.IN_PROGRESS);
      expect(StageStatus.GATE_PENDING).toBe(SharedStageStatus.GATE_PENDING);
      expect(StageStatus.COMPLETED).toBe(SharedStageStatus.COMPLETED);
    });

    it('MessageRole enum values match shared package', () => {
      expect(MessageRole.USER).toBe(SharedMessageRole.USER);
      expect(MessageRole.AI).toBe(SharedMessageRole.AI);
      expect(MessageRole.SYSTEM).toBe(SharedMessageRole.SYSTEM);
    });

    it('Attribution enum values match shared package', () => {
      expect(Attribution.SELF).toBe(SharedAttribution.SELF);
      expect(Attribution.OTHER).toBe(SharedAttribution.OTHER);
      expect(Attribution.MUTUAL).toBe(SharedAttribution.MUTUAL);
      expect(Attribution.EXTERNAL).toBe(SharedAttribution.EXTERNAL);
    });

    it('NeedCategory enum values match shared package', () => {
      expect(NeedCategory.SAFETY).toBe(SharedNeedCategory.SAFETY);
      expect(NeedCategory.CONNECTION).toBe(SharedNeedCategory.CONNECTION);
      expect(NeedCategory.AUTONOMY).toBe(SharedNeedCategory.AUTONOMY);
      expect(NeedCategory.RECOGNITION).toBe(SharedNeedCategory.RECOGNITION);
      expect(NeedCategory.MEANING).toBe(SharedNeedCategory.MEANING);
      expect(NeedCategory.FAIRNESS).toBe(SharedNeedCategory.FAIRNESS);
    });

    it('ConsentDecision enum values match shared package', () => {
      expect(ConsentDecision.GRANTED).toBe(SharedConsentDecision.GRANTED);
      expect(ConsentDecision.DENIED).toBe(SharedConsentDecision.DENIED);
      expect(ConsentDecision.REVOKED).toBe(SharedConsentDecision.REVOKED);
    });

    it('ConsentContentType enum values match shared package', () => {
      expect(ConsentContentType.IDENTIFIED_NEED).toBe(SharedConsentContentType.IDENTIFIED_NEED);
      expect(ConsentContentType.EVENT_SUMMARY).toBe(SharedConsentContentType.EVENT_SUMMARY);
      expect(ConsentContentType.EMOTIONAL_PATTERN).toBe(SharedConsentContentType.EMOTIONAL_PATTERN);
      expect(ConsentContentType.BOUNDARY).toBe(SharedConsentContentType.BOUNDARY);
      expect(ConsentContentType.EMPATHY_DRAFT).toBe(SharedConsentContentType.EMPATHY_DRAFT);
      expect(ConsentContentType.EMPATHY_ATTEMPT).toBe(SharedConsentContentType.EMPATHY_ATTEMPT);
      expect(ConsentContentType.STRATEGY_PROPOSAL).toBe(SharedConsentContentType.STRATEGY_PROPOSAL);
    });

    it('AgreementType enum values match shared package', () => {
      expect(AgreementType.MICRO_EXPERIMENT).toBe(SharedAgreementType.MICRO_EXPERIMENT);
      expect(AgreementType.COMMITMENT).toBe(SharedAgreementType.COMMITMENT);
      expect(AgreementType.CHECK_IN).toBe(SharedAgreementType.CHECK_IN);
    });

    it('AgreementStatus enum values match shared package', () => {
      expect(AgreementStatus.PROPOSED).toBe(SharedAgreementStatus.PROPOSED);
      expect(AgreementStatus.AGREED).toBe(SharedAgreementStatus.AGREED);
      expect(AgreementStatus.IN_PROGRESS).toBe(SharedAgreementStatus.IN_PROGRESS);
      expect(AgreementStatus.COMPLETED).toBe(SharedAgreementStatus.COMPLETED);
      expect(AgreementStatus.ABANDONED).toBe(SharedAgreementStatus.ABANDONED);
    });

    it('GlobalLibrarySource enum values match shared package', () => {
      expect(GlobalLibrarySource.CURATED).toBe(SharedGlobalLibrarySource.CURATED);
      expect(GlobalLibrarySource.CONTRIBUTED).toBe(SharedGlobalLibrarySource.CONTRIBUTED);
    });
  });

  // Database connection tests - only run if explicitly enabled with RUN_DB_TESTS=true
  // This prevents false positives when DATABASE_URL is set but database is not running
  const dbTestCondition =
    process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

  dbTestCondition('Database Connection', () => {
    it('connects to database', async () => {
      const result = await prisma.$queryRaw`SELECT 1 as value`;
      expect(result).toBeDefined();
    });

    it('creates and retrieves a user', async () => {
      const email = `test-${Date.now()}@example.com`;
      const user = await prisma.user.create({
        data: {
          email,
          name: 'Test User',
        },
      });
      expect(user.id).toBeDefined();
      expect(user.email).toBe(email);

      // Cleanup
      await prisma.user.delete({ where: { id: user.id } });
    });
  });
});
