/**
 * Reconciler Service Unit Tests
 *
 * Tests for the core reconciler functions:
 * - checkAttempts: circuit breaker logic
 * - hasContextAlreadyBeenShared: duplicate sharing guard
 * - getFallbackContinuation: safe default content
 * - generateShareSuggestionForDirection: share suggestion creation
 * - checkAndRevealBothIfReady: mutual reveal atomicity
 * - runReconciler: full reconciler flow with mocked AI
 * - respondToShareSuggestion: accept and decline paths
 * - State transitions via empathy state machine
 */

import { prisma } from '../../lib/prisma';
import { EmpathyStatus } from '../../generated/prisma/client';
import { MessageRole } from '@meet-without-fear/shared';

// Mock prisma
jest.mock('../../lib/prisma');

// Mock realtime
jest.mock('../../services/realtime', () => ({
  publishMessageAIResponse: jest.fn().mockResolvedValue(undefined),
  notifyPartner: jest.fn().mockResolvedValue(undefined),
}));

// Mock bedrock
jest.mock('../../lib/bedrock', () => ({
  getSonnetResponse: jest.fn().mockResolvedValue(
    JSON.stringify({
      alignment: {
        score: 75,
        summary: 'Partner understood most key feelings.',
        correctlyIdentified: ['frustration', 'disappointment'],
      },
      gaps: {
        severity: 'moderate',
        summary: 'Missed the underlying fear of disconnection.',
        missedFeelings: ['fear', 'vulnerability'],
        misattributions: [],
        mostImportantGap: 'The fear of growing apart was not captured.',
      },
      recommendation: {
        action: 'OFFER_OPTIONAL',
        rationale: 'Sharing could deepen understanding but is not critical.',
        sharingWouldHelp: true,
        suggestedShareFocus: 'The fear of disconnection mentioned earlier.',
      },
    })
  ),
  getHaikuJson: jest.fn().mockResolvedValue({ themes: ['frustration', 'disappointment', 'fear'] }),
  getModelCompletion: jest.fn().mockResolvedValue('Mock AI response'),
  BrainActivityCallType: {
    RECONCILER_ANALYSIS: 'RECONCILER_ANALYSIS',
    THEME_EXTRACTION: 'THEME_EXTRACTION',
  },
}));

// Mock json-extractor
jest.mock('../../utils/json-extractor', () => ({
  extractJsonFromResponse: jest.fn().mockImplementation((str: string) => {
    try {
      return JSON.parse(str);
    } catch {
      return {
        alignment: { score: 75, summary: 'Good understanding', correctlyIdentified: [] },
        gaps: { severity: 'minor', summary: 'Minor gaps', missedFeelings: [], misattributions: [], mostImportantGap: null },
        recommendation: { action: 'PROCEED', rationale: 'Ready', sharingWouldHelp: false, suggestedShareFocus: null },
      };
    }
  }),
}));

// Mock empathy-status service
jest.mock('../../services/empathy-status', () => ({
  buildEmpathyExchangeStatus: jest.fn().mockResolvedValue({
    myAttempt: { id: 'mock-attempt', status: 'READY' },
    partnerAttempt: null,
    analyzing: false,
    awaitingSharing: false,
    readyForStage3: false,
    partnerCompletedStage1: true,
  }),
  buildEmpathyExchangeStatusForBothUsers: jest.fn().mockResolvedValue({
    'guesser-1': { myAttempt: { status: 'REVEALED' }, partnerAttempt: null },
    'subject-1': { myAttempt: { status: 'REVEALED' }, partnerAttempt: null },
  }),
}));

// Mock request-context
jest.mock('../../lib/request-context', () => ({
  getCurrentUserId: jest.fn().mockReturnValue('user-123'),
  getRequestContext: jest.fn().mockReturnValue(null),
}));

// Mock stage-prompts
jest.mock('../../services/stage-prompts', () => ({
  buildReconcilerPrompt: jest.fn().mockReturnValue({ staticBlock: 'Mock reconciler prompt', dynamicBlock: '' }),
  buildReconcilerEvidencePacket: jest.fn().mockReturnValue('Mock reconciler evidence packet'),
  buildShareOfferPrompt: jest.fn().mockReturnValue('Mock share offer prompt'),
  buildReconcilerSummaryPrompt: jest.fn().mockReturnValue('Mock summary prompt'),
  buildStagePrompt: jest.fn().mockReturnValue('Mock stage prompt'),
}));

// Add refinementAttemptCounter mock to prisma (not in default mock)
(prisma as any).refinementAttemptCounter = {
  findUnique: jest.fn().mockResolvedValue(null),
  upsert: jest.fn().mockResolvedValue({ id: 'counter-1', attempts: 1 }),
};

// Override message.create to return objects with timestamp (Date)
(prisma.message.create as jest.Mock).mockImplementation((args: any) =>
  Promise.resolve({
    id: 'mock-msg-id',
    ...args?.data,
    timestamp: args?.data?.timestamp || new Date(),
  })
);

// Import after mocks
import {
  analyzeEmpathyGap,
  checkAttempts,
  incrementAttempts,
  hasContextAlreadyBeenShared,
  getFallbackContinuation,
  generatePostShareContinuation,
  generateContextReceivedReflection,
  generateValidationFeedbackReflection,
  generateShareSuggestionForDirection,
  checkAndRevealBothIfReady,
  loadRecentSubjectStage2Turns,
  runReconciler,
  respondToShareSuggestion,
  runReconcilerForDirection,
} from '../reconciler';
import { transition } from '../empathy-state-machine';
import { getSonnetResponse } from '../../lib/bedrock';
import { buildReconcilerEvidencePacket, buildReconcilerPrompt } from '../../services/stage-prompts';

describe('Reconciler Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-set default for refinementAttemptCounter after clearAllMocks
    (prisma as any).refinementAttemptCounter.findUnique = jest.fn().mockResolvedValue(null);
    (prisma as any).refinementAttemptCounter.upsert = jest.fn().mockResolvedValue({ id: 'counter-1', attempts: 1 });

    // Reset $transaction to default: pass prisma itself as tx for callback-style,
    // or Promise.all for array-style. Tests that need custom tx objects can override.
    (prisma.$transaction as jest.Mock).mockImplementation((p: any) => {
      if (Array.isArray(p)) return Promise.all(p);
      if (typeof p === 'function') return p(prisma);
      return Promise.resolve();
    });

    // Ensure message.create returns an object with timestamp (needed by markEmpathyReady)
    (prisma.message.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({
        id: 'mock-msg-id',
        ...args?.data,
        timestamp: args?.data?.timestamp || new Date(),
      })
    );
  });

  // ==========================================================================
  // 1. State Transitions (empathy state machine)
  // ==========================================================================

  describe('State Transitions', () => {
    it('transitions from HELD to ANALYZING on START_ANALYSIS', () => {
      expect(transition(EmpathyStatus.HELD, 'START_ANALYSIS')).toBe(EmpathyStatus.ANALYZING);
    });

    it('transitions from HELD to READY on MARK_READY', () => {
      expect(transition(EmpathyStatus.HELD, 'MARK_READY')).toBe(EmpathyStatus.READY);
    });

    it('transitions from ANALYZING to AWAITING_SHARING on GAPS_DETECTED', () => {
      expect(transition(EmpathyStatus.ANALYZING, 'GAPS_DETECTED')).toBe(EmpathyStatus.AWAITING_SHARING);
    });

    it('transitions from ANALYZING to READY on NO_SIGNIFICANT_GAPS', () => {
      expect(transition(EmpathyStatus.ANALYZING, 'NO_SIGNIFICANT_GAPS')).toBe(EmpathyStatus.READY);
    });

    it('transitions from AWAITING_SHARING to REFINING on CONTEXT_SHARED', () => {
      expect(transition(EmpathyStatus.AWAITING_SHARING, 'CONTEXT_SHARED')).toBe(EmpathyStatus.REFINING);
    });

    it('transitions from AWAITING_SHARING to READY on DECLINE_SHARING', () => {
      expect(transition(EmpathyStatus.AWAITING_SHARING, 'DECLINE_SHARING')).toBe(EmpathyStatus.READY);
    });

    it('transitions from REFINING to READY on MARK_READY', () => {
      expect(transition(EmpathyStatus.REFINING, 'MARK_READY')).toBe(EmpathyStatus.READY);
    });

    it('transitions from READY to REVEALED on MUTUAL_REVEAL', () => {
      expect(transition(EmpathyStatus.READY, 'MUTUAL_REVEAL')).toBe(EmpathyStatus.REVEALED);
    });

    it('transitions from REVEALED to VALIDATED on VALIDATE', () => {
      expect(transition(EmpathyStatus.REVEALED, 'VALIDATE')).toBe(EmpathyStatus.VALIDATED);
    });

    it('transitions from REVEALED to REFINING on VALIDATION_FEEDBACK_SENT', () => {
      expect(transition(EmpathyStatus.REVEALED, 'VALIDATION_FEEDBACK_SENT')).toBe(EmpathyStatus.REFINING);
    });

    it('throws on invalid transition', () => {
      expect(() => transition(EmpathyStatus.HELD, 'MUTUAL_REVEAL')).toThrow(
        'Invalid empathy state transition'
      );
    });

    it('throws when trying to transition from REVEALED to READY', () => {
      expect(() => transition(EmpathyStatus.REVEALED, 'MARK_READY')).toThrow(
        'Invalid empathy state transition'
      );
    });

    it('handles legacy NEEDS_WORK status with CONTEXT_SHARED', () => {
      expect(transition(EmpathyStatus.NEEDS_WORK, 'CONTEXT_SHARED')).toBe(EmpathyStatus.REFINING);
    });

    it('handles legacy NEEDS_WORK status with DECLINE_SHARING', () => {
      expect(transition(EmpathyStatus.NEEDS_WORK, 'DECLINE_SHARING')).toBe(EmpathyStatus.READY);
    });
  });

  // ==========================================================================
  // 2. Circuit Breaker: checkAttempts / incrementAttempts
  // ==========================================================================

  describe('Circuit Breaker - checkAttempts', () => {
    it('returns shouldSkipReconciler=false when no counter exists (0 attempts)', async () => {
      (prisma as any).refinementAttemptCounter.findUnique.mockResolvedValue(null);

      const result = await checkAttempts('session-1', 'guesser-1', 'subject-1');

      expect(result.shouldSkipReconciler).toBe(false);
      expect(result.attempts).toBe(0);
    });

    it('returns shouldSkipReconciler=false when attempts <= 3', async () => {
      (prisma as any).refinementAttemptCounter.findUnique.mockResolvedValue({
        id: 'counter-1',
        sessionId: 'session-1',
        direction: 'guesser-1->subject-1',
        attempts: 3,
      });

      const result = await checkAttempts('session-1', 'guesser-1', 'subject-1');

      expect(result.shouldSkipReconciler).toBe(false);
      expect(result.attempts).toBe(3);
    });

    it('returns shouldSkipReconciler=true when attempts > 3 (circuit breaker trips)', async () => {
      (prisma as any).refinementAttemptCounter.findUnique.mockResolvedValue({
        id: 'counter-1',
        sessionId: 'session-1',
        direction: 'guesser-1->subject-1',
        attempts: 4,
      });

      const result = await checkAttempts('session-1', 'guesser-1', 'subject-1');

      expect(result.shouldSkipReconciler).toBe(true);
      expect(result.attempts).toBe(4);
    });

    it('constructs the direction key as guesserId->subjectId', async () => {
      await checkAttempts('session-1', 'guesser-1', 'subject-1');

      expect((prisma as any).refinementAttemptCounter.findUnique).toHaveBeenCalledWith({
        where: {
          sessionId_direction: {
            sessionId: 'session-1',
            direction: 'guesser-1->subject-1',
          },
        },
      });
    });
  });

  describe('Hybrid reconciler evidence loading', () => {
    it('loads recent Stage 2 subject-owned turns with immediately preceding AI referent prompts', async () => {
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'ai-1',
          role: 'AI',
          content: 'Did you actually do X?',
          stage: 2,
        },
        {
          id: 'user-1',
          role: 'USER',
          content: 'Yeah, I did.',
          stage: 2,
        },
        {
          id: 'ai-2',
          role: 'AI',
          content: 'What changed for you?',
          stage: 2,
        },
        {
          id: 'user-2',
          role: 'USER',
          content: 'I can see why that landed badly.',
          stage: 2,
        },
      ]);

      const turns = await loadRecentSubjectStage2Turns('session-1', 'subject-1');

      expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          sessionId: 'session-1',
          stage: 2,
          OR: [
            { senderId: 'subject-1', role: 'USER' },
            { forUserId: 'subject-1', role: 'AI' },
          ],
        },
      }));
      expect(turns).toEqual([
        { role: 'assistant', content: 'Did you actually do X?', stage: 2 },
        { role: 'user', content: 'Yeah, I did.', stage: 2 },
        { role: 'assistant', content: 'What changed for you?', stage: 2 },
        { role: 'user', content: 'I can see why that landed badly.', stage: 2 },
      ]);
    });

    it('passes PromptBlocks plus evidence packet to Sonnet, including facts and hot buffer in context', async () => {
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({
        notableFacts: [
          { category: 'Conflict', fact: 'Subject now acknowledges doing X.' },
        ],
      });
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        { id: 'ai-1', role: 'AI', content: 'Did you do X?', stage: 2 },
        { id: 'user-1', role: 'USER', content: 'Yeah, I did.', stage: 2 },
      ]);

      await analyzeEmpathyGap({
        sessionId: 'session-1',
        guesser: { id: 'guesser-1', name: 'Adam' },
        subject: { id: 'subject-1', name: 'Eve' },
        empathyStatement: 'I think you felt wrongly accused.',
        witnessingContent: {
          userMessages: 'I did not do X.',
          themes: ['defensive'],
        },
      });

      expect(buildReconcilerPrompt).toHaveBeenCalledWith(expect.objectContaining({
        subjectFacts: [
          { category: 'Conflict', fact: 'Subject now acknowledges doing X.' },
        ],
        recentSubjectTurns: [
          { role: 'assistant', content: 'Did you do X?', stage: 2 },
          { role: 'user', content: 'Yeah, I did.', stage: 2 },
        ],
      }));
      expect(buildReconcilerEvidencePacket).toHaveBeenCalledWith(expect.objectContaining({
        subjectFacts: expect.any(Array),
        recentSubjectTurns: expect.any(Array),
      }));
      expect(getSonnetResponse).toHaveBeenCalledWith(expect.objectContaining({
        systemPrompt: { staticBlock: 'Mock reconciler prompt', dynamicBlock: '' },
        messages: [{ role: 'user', content: 'Mock reconciler evidence packet' }],
      }));
    });
  });

  describe('Circuit Breaker - incrementAttempts', () => {
    it('upserts the counter with increment', async () => {
      await incrementAttempts('session-1', 'guesser-1', 'subject-1');

      expect((prisma as any).refinementAttemptCounter.upsert).toHaveBeenCalledWith({
        where: {
          sessionId_direction: {
            sessionId: 'session-1',
            direction: 'guesser-1->subject-1',
          },
        },
        create: {
          sessionId: 'session-1',
          direction: 'guesser-1->subject-1',
          attempts: 1,
        },
        update: {
          attempts: { increment: 1 },
        },
      });
    });
  });

  // ==========================================================================
  // 3. Context-Already-Shared Guard
  // ==========================================================================

  describe('hasContextAlreadyBeenShared', () => {
    it('returns false when no shared context message exists', async () => {
      (prisma.message.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await hasContextAlreadyBeenShared('session-1', 'guesser-1', 'subject-1');

      expect(result).toBe(false);
      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          sessionId: 'session-1',
          role: 'SHARED_CONTEXT',
          senderId: 'subject-1',
          forUserId: 'guesser-1',
        },
      });
    });

    it('returns true when shared context message exists (prevents duplicate sharing)', async () => {
      (prisma.message.findFirst as jest.Mock).mockResolvedValue({
        id: 'msg-1',
        sessionId: 'session-1',
        senderId: 'subject-1',
        forUserId: 'guesser-1',
        role: 'SHARED_CONTEXT',
        content: 'Some shared context',
        timestamp: new Date(),
      });

      const result = await hasContextAlreadyBeenShared('session-1', 'guesser-1', 'subject-1');

      expect(result).toBe(true);
    });

    it('checks for correct sender/receiver direction (subject sends, guesser receives)', async () => {
      await hasContextAlreadyBeenShared('session-1', 'guesser-1', 'subject-1');

      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            senderId: 'subject-1',
            forUserId: 'guesser-1',
          }),
        })
      );
    });
  });

  // ==========================================================================
  // 4. Default Fallback Continuation
  // ==========================================================================

  describe('getFallbackContinuation', () => {
    it('returns stage 1 fallback with partner name', () => {
      const result = getFallbackContinuation(1, 'Alex');

      expect(result).toContain('Thank you for sharing that with Alex');
      expect(result).toContain('how this situation has affected you');
    });

    it('returns stage 2 fallback without restarting perspective exploration', () => {
      const result = getFallbackContinuation(2, 'Jordan');

      expect(result).toContain('Thank you for sharing that with Jordan');
      expect(result).toContain("Revisit what you'll share");
      expect(result).toContain("don't need to do anything more on their behalf");
      expect(result).not.toContain("Jordan's perspective");
    });

    it('returns stage 3 fallback about needs', () => {
      const result = getFallbackContinuation(3, 'Sam');

      expect(result).toContain('Thank you for sharing that with Sam');
      expect(result).toContain('what you truly need');
    });

    it('returns stage 4 fallback about steps forward', () => {
      const result = getFallbackContinuation(4, 'Pat');

      expect(result).toContain('Thank you for sharing that with Pat');
      expect(result).toContain('small step');
    });

    it('returns generic fallback for unknown stages', () => {
      const result = getFallbackContinuation(99, 'Alex');

      expect(result).toContain('Thank you for sharing that with Alex');
      expect(result).toContain("Let's continue our conversation");
    });

    it('always includes acknowledgment section', () => {
      for (const stage of [1, 2, 3, 4, 5]) {
        const result = getFallbackContinuation(stage, 'TestPartner');
        expect(result).toContain("Thank you for sharing that with TestPartner");
        expect(result).toContain("refine their understanding");
      }
    });
  });

  // ==========================================================================
  // 5. Post-share Continuation
  // ==========================================================================

  describe('generatePostShareContinuation', () => {
    it('tells stage 2 users to review their own draft when their attempt is still refining', async () => {
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({ stage: 2 });
      (prisma.empathyAttempt.findFirst as jest.Mock).mockResolvedValue({
        status: EmpathyStatus.REFINING,
      });

      const result = await generatePostShareContinuation(
        'session-1',
        'adam-id',
        'Adam',
        'Eve',
        'Shared context'
      );

      expect(prisma.empathyAttempt.findFirst).toHaveBeenCalledWith({
        where: {
          sessionId: 'session-1',
          sourceUserId: 'adam-id',
        },
        select: {
          status: true,
        },
      });
      expect(result).toContain("Revisit what you'll share");
      expect(result).toContain('resubmit it');
      expect(result).not.toContain("For now, you don't need to do anything more");
    });

    it('keeps stage 2 post-share waiting copy when the sender has no draft refinement pending', async () => {
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({ stage: 2 });
      (prisma.empathyAttempt.findFirst as jest.Mock).mockResolvedValue({
        status: EmpathyStatus.READY,
      });

      const result = await generatePostShareContinuation(
        'session-1',
        'adam-id',
        'Adam',
        'Eve',
        'Shared context'
      );

      expect(result).toContain('If your own empathy draft asks for review');
      expect(result).toContain("don't need to do anything more on their behalf");
    });
  });

  describe('generateContextReceivedReflection', () => {
    it('frames shared context for the receiver without thanking the sharer', async () => {
      const result = await generateContextReceivedReflection('session-1', 'Shantam', 'Blair');

      expect(result).toContain('Blair shared this because');
      expect(result).toContain('what stands out');
      expect(result).not.toContain('Thank you for sharing');
      expect(result).not.toContain('Jason');
    });
  });

  // ==========================================================================
  // 6. generateValidationFeedbackReflection
  // ==========================================================================

  describe('generateValidationFeedbackReflection', () => {
    it('returns trimmed AI response on success', async () => {
      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValueOnce('  Jordan shared some thoughts about what felt off.  ');

      const result = await generateValidationFeedbackReflection('session-1', 'Alex', 'Jordan');

      expect(result).toBe('Jordan shared some thoughts about what felt off.');
      expect(getSonnetResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          operation: 'reconciler-validation-feedback-reflection',
        })
      );
    });

    it('returns fallback when getSonnetResponse returns null', async () => {
      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValueOnce(null);

      const result = await generateValidationFeedbackReflection('session-1', 'Alex', 'Jordan');

      expect(result).toContain('Jordan');
      expect(result).toContain('shared some thoughts');
    });

    it('returns fallback when getSonnetResponse throws', async () => {
      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockRejectedValueOnce(new Error('Bedrock error'));

      const result = await generateValidationFeedbackReflection('session-1', 'Alex', 'Jordan');

      expect(result).toContain('Jordan');
      expect(result).toContain('shared some thoughts');
    });
  });

  // ==========================================================================
  // 7. generateShareSuggestionForDirection
  // ==========================================================================

  describe('generateShareSuggestionForDirection', () => {
    const sessionId = 'session-1';
    const guesserId = 'guesser-1';
    const subjectId = 'subject-1';

    beforeEach(() => {
      // Mock user lookups
      (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === guesserId) {
          return Promise.resolve({ id: guesserId, name: 'Guesser User', firstName: 'Guesser' });
        }
        if (where.id === subjectId) {
          return Promise.resolve({ id: subjectId, name: 'Subject User', firstName: 'Subject' });
        }
        return Promise.resolve(null);
      });

      // Mock reconciler result with share offer
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue({
        id: 'result-1',
        sessionId,
        guesserId,
        subjectId,
        guesserName: 'Guesser',
        subjectName: 'Subject',
        alignmentScore: 65,
        alignmentSummary: 'Moderate understanding',
        correctlyIdentified: ['frustration'],
        gapSeverity: 'moderate',
        gapSummary: 'Missed deeper feelings',
        missedFeelings: ['fear', 'vulnerability'],
        misattributions: [],
        mostImportantGap: 'Fear of disconnection',
        recommendedAction: 'OFFER_SHARING',
        rationale: 'Sharing would help',
        sharingWouldHelp: true,
        suggestedShareFocus: 'Fear of disconnection',
        supersededAt: null,
        shareOffer: null,
      });

      // Mock witnessing content messages
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        {
          content: 'I feel so disconnected from everything.',
          extractedEmotions: ['disconnection', 'fear'],
        },
      ]);

      // Mock the Sonnet JSON response for share suggestion
      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(
        JSON.stringify({
          suggestedContent: 'I feel afraid that we might be growing apart.',
          reason: 'This addresses the core fear that was missed.',
        })
      );
    });

    it('returns early when guesser or subject not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await generateShareSuggestionForDirection(sessionId, guesserId, subjectId);

      // Should not proceed to reconciler result lookup
      expect(prisma.reconcilerResult.findFirst).not.toHaveBeenCalled();
    });

    it('returns early when no reconciler result exists', async () => {
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);

      await generateShareSuggestionForDirection(sessionId, guesserId, subjectId);

      // Should not call AI
      const { getSonnetResponse } = require('../../lib/bedrock');
      expect(getSonnetResponse).not.toHaveBeenCalled();
    });

    it('skips generation when share offer already has content', async () => {
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue({
        id: 'result-1',
        sessionId,
        guesserId,
        subjectId,
        guesserName: 'Guesser',
        subjectName: 'Subject',
        alignmentScore: 65,
        alignmentSummary: 'Moderate understanding',
        correctlyIdentified: ['frustration'],
        gapSeverity: 'moderate',
        gapSummary: 'Missed deeper feelings',
        missedFeelings: ['fear'],
        misattributions: [],
        mostImportantGap: 'Fear of disconnection',
        recommendedAction: 'OFFER_SHARING',
        rationale: 'Sharing would help',
        sharingWouldHelp: true,
        suggestedShareFocus: 'Fear of disconnection',
        supersededAt: null,
        shareOffer: {
          id: 'offer-1',
          suggestedContent: 'Already generated content',
        },
      });

      await generateShareSuggestionForDirection(sessionId, guesserId, subjectId);

      // Should not call AI since offer already exists
      const { getSonnetResponse } = require('../../lib/bedrock');
      expect(getSonnetResponse).not.toHaveBeenCalled();
    });

    it('creates share offer when reconciler result has no existing offer', async () => {
      // Mock the second findFirst (inside generateShareSuggestion) for DB result lookup
      // The first call is in generateShareSuggestionForDirection (with include shareOffer)
      // The inner generateShareSuggestion also calls findFirst (via findReconcilerResultWithRetry or passed directly)
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue({
        id: 'result-1',
        sessionId,
        guesserId,
        subjectId,
        guesserName: 'Guesser',
        subjectName: 'Subject',
        alignmentScore: 65,
        alignmentSummary: 'Moderate understanding',
        correctlyIdentified: ['frustration'],
        gapSeverity: 'moderate',
        gapSummary: 'Missed deeper feelings',
        missedFeelings: ['fear', 'vulnerability'],
        misattributions: [],
        mostImportantGap: 'Fear of disconnection',
        recommendedAction: 'OFFER_SHARING',
        rationale: 'Sharing would help',
        sharingWouldHelp: true,
        suggestedShareFocus: 'Fear of disconnection',
        supersededAt: null,
        shareOffer: null,
      });

      await generateShareSuggestionForDirection(sessionId, guesserId, subjectId);

      // Should have called reconcilerShareOffer.upsert to create the suggestion
      expect(prisma.reconcilerShareOffer.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resultId: 'result-1' },
          create: expect.objectContaining({
            resultId: 'result-1',
            userId: subjectId,
            status: 'PENDING',
          }),
        })
      );
    });
  });

  // ==========================================================================
  // 6. Mutual Reveal: checkAndRevealBothIfReady
  // ==========================================================================

  describe('checkAndRevealBothIfReady', () => {
    it('returns false when fewer than 2 empathy attempts exist', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
      ]);

      const result = await checkAndRevealBothIfReady('session-1');

      expect(result).toBe(false);
      expect(prisma.empathyAttempt.updateMany).not.toHaveBeenCalled();
    });

    it('returns false when not both attempts are READY', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
        { id: 'attempt-2', sessionId: 'session-1', sourceUserId: 'user-2', status: 'AWAITING_SHARING' },
      ]);

      const result = await checkAndRevealBothIfReady('session-1');

      expect(result).toBe(false);
      expect(prisma.empathyAttempt.updateMany).not.toHaveBeenCalled();
    });

    it('reveals both attempts atomically when both are READY', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
        { id: 'attempt-2', sessionId: 'session-1', sourceUserId: 'user-2', status: 'READY' },
      ]);

      const result = await checkAndRevealBothIfReady('session-1');

      expect(result).toBe(true);
      expect(prisma.empathyAttempt.updateMany).toHaveBeenCalledWith({
        where: {
          sessionId: 'session-1',
          status: 'READY',
        },
        data: expect.objectContaining({
          status: 'REVEALED',
          statusVersion: { increment: 1 },
        }),
      });
    });

    it('reveals a READY revision when the other direction was already VALIDATED', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
        { id: 'attempt-2', sessionId: 'session-1', sourceUserId: 'user-2', status: 'VALIDATED' },
      ]);

      const result = await checkAndRevealBothIfReady('session-1');

      expect(result).toBe(true);
      expect(prisma.empathyAttempt.updateMany).toHaveBeenCalledWith({
        where: {
          sessionId: 'session-1',
          status: 'READY',
        },
        data: expect.objectContaining({
          status: 'REVEALED',
          statusVersion: { increment: 1 },
        }),
      });
    });

    it('does not notify or create review copy for an already VALIDATED direction', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
        { id: 'attempt-2', sessionId: 'session-1', sourceUserId: 'user-2', status: 'VALIDATED' },
      ]);
      (prisma.reconcilerResult.findMany as jest.Mock).mockResolvedValue([
        {
          sessionId: 'session-1',
          guesserId: 'user-1',
          subjectId: 'user-2',
          gapSeverity: 'minor',
        },
        {
          sessionId: 'session-1',
          guesserId: 'user-2',
          subjectId: 'user-1',
          gapSeverity: 'moderate',
        },
      ]);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        { id: 'user-1', firstName: 'Ava', name: 'Ava Example' },
        { id: 'user-2', firstName: 'Ben', name: 'Ben Example' },
      ]);

      await checkAndRevealBothIfReady('session-1');

      const { notifyPartner } = require('../../services/realtime');
      expect(notifyPartner).toHaveBeenCalledTimes(1);
      expect(notifyPartner).toHaveBeenCalledWith(
        'session-1',
        'user-1',
        'empathy.revealed',
        expect.objectContaining({
          guesserUserId: 'user-1',
          forUserId: 'user-1',
        })
      );

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          forUserId: 'user-2',
          content: expect.stringContaining("Ava's attempt to understand your experience"),
        }),
      });
      expect(prisma.message.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({
          forUserId: 'user-1',
          content: expect.stringContaining("Ben's attempt to understand your experience"),
        }),
      });
    });

    it('sets revealedAt and delivery status when revealing', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
        { id: 'attempt-2', sessionId: 'session-1', sourceUserId: 'user-2', status: 'READY' },
      ]);

      await checkAndRevealBothIfReady('session-1');

      expect(prisma.empathyAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'REVEALED',
            deliveryStatus: 'DELIVERED',
            revealedAt: expect.any(Date),
            deliveredAt: expect.any(Date),
          }),
        })
      );
    });

    it('notifies both users after reveal', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
        { id: 'attempt-2', sessionId: 'session-1', sourceUserId: 'user-2', status: 'READY' },
      ]);

      await checkAndRevealBothIfReady('session-1');

      const { notifyPartner } = require('../../services/realtime');
      // Should notify both users
      expect(notifyPartner).toHaveBeenCalledTimes(2);
      expect(notifyPartner).toHaveBeenCalledWith(
        'session-1',
        'user-1',
        'empathy.revealed',
        expect.objectContaining({
          direction: 'outgoing',
          guesserUserId: 'user-1',
          forUserId: 'user-1',
        })
      );
      expect(notifyPartner).toHaveBeenCalledWith(
        'session-1',
        'user-2',
        'empathy.revealed',
        expect.objectContaining({
          direction: 'outgoing',
          guesserUserId: 'user-2',
          forUserId: 'user-2',
        })
      );
    });

    it('creates subject-specific quality commentary messages when revealing', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([
        { id: 'attempt-1', sessionId: 'session-1', sourceUserId: 'user-1', status: 'READY' },
        { id: 'attempt-2', sessionId: 'session-1', sourceUserId: 'user-2', status: 'READY' },
      ]);
      (prisma.reconcilerResult.findMany as jest.Mock).mockResolvedValue([
        {
          sessionId: 'session-1',
          guesserId: 'user-1',
          subjectId: 'user-2',
          gapSeverity: 'moderate',
        },
        {
          sessionId: 'session-1',
          guesserId: 'user-2',
          subjectId: 'user-1',
          gapSeverity: 'minor',
        },
      ]);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        { id: 'user-1', firstName: 'Ava', name: 'Ava Example' },
        { id: 'user-2', firstName: 'Ben', name: 'Ben Example' },
      ]);

      await checkAndRevealBothIfReady('session-1');

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'session-1',
          senderId: null,
          forUserId: 'user-2',
          role: 'AI',
          stage: 2,
          content: expect.stringContaining("Ava's attempt to understand your experience"),
        }),
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'session-1',
          senderId: null,
          forUserId: 'user-2',
          role: 'AI',
          stage: 2,
          content: expect.stringContaining('may not fully capture everything you shared'),
        }),
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'session-1',
          senderId: null,
          forUserId: 'user-1',
          role: 'AI',
          stage: 2,
          content: expect.stringContaining("Ben's attempt to understand your experience"),
        }),
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: 'session-1',
          senderId: null,
          forUserId: 'user-1',
          role: 'AI',
          stage: 2,
          content: expect.not.stringContaining('may not fully capture everything you shared'),
        }),
      });

      const { publishMessageAIResponse } = require('../../services/realtime');
      expect(publishMessageAIResponse).toHaveBeenCalledWith(
        'session-1',
        'user-2',
        expect.objectContaining({
          role: MessageRole.AI,
          stage: 2,
          content: expect.stringContaining('may not fully capture everything you shared'),
        }),
        {}
      );
      expect(publishMessageAIResponse).toHaveBeenCalledWith(
        'session-1',
        'user-1',
        expect.objectContaining({
          role: MessageRole.AI,
          stage: 2,
          content: expect.not.stringContaining('may not fully capture everything you shared'),
        }),
        {}
      );
    });

    it('returns false when no attempts exist', async () => {
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([]);

      const result = await checkAndRevealBothIfReady('session-1');

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // 7. runReconciler
  // ==========================================================================

  describe('runReconciler', () => {
    const sessionId = 'session-1';

    function mockSessionWithParticipants() {
      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: sessionId,
        relationship: {
          members: [
            { user: { id: 'user-a', name: 'Alice', firstName: 'Alice' } },
            { user: { id: 'user-b', name: 'Bob', firstName: 'Bob' } },
          ],
        },
      });
    }

    function mockBothEmpathyAttempts() {
      (prisma.empathyAttempt.findFirst as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.sourceUserId === 'user-a') {
          return Promise.resolve({
            id: 'attempt-a',
            sessionId,
            sourceUserId: 'user-a',
            content: 'I think Bob feels frustrated about the situation.',
            sharedAt: new Date(),
            status: 'HELD',
          });
        }
        if (where.sourceUserId === 'user-b') {
          return Promise.resolve({
            id: 'attempt-b',
            sessionId,
            sourceUserId: 'user-b',
            content: 'I think Alice feels overwhelmed and unheard.',
            sharedAt: new Date(),
            status: 'HELD',
          });
        }
        return Promise.resolve(null);
      });
    }

    function mockWitnessingContent() {
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        {
          content: 'I feel so overwhelmed with everything going on.',
          extractedEmotions: ['overwhelm', 'stress'],
        },
      ]);
    }

    it('throws when session not found', async () => {
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(runReconciler(sessionId)).rejects.toThrow('Session session-1 not found');
    });

    it('throws when session does not have exactly 2 members', async () => {
      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: sessionId,
        relationship: {
          members: [{ user: { id: 'user-a', name: 'Alice', firstName: 'Alice' } }],
        },
      });

      await expect(runReconciler(sessionId)).rejects.toThrow('does not have exactly 2 members');
    });

    it('returns bothCompleted=false when one user has not shared empathy', async () => {
      mockSessionWithParticipants();
      // User A has empathy, User B does not
      (prisma.empathyAttempt.findFirst as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.sourceUserId === 'user-a') {
          return Promise.resolve({
            id: 'attempt-a',
            content: 'I think Bob feels...',
            sharedAt: new Date(),
            status: 'HELD',
          });
        }
        return Promise.resolve(null);
      });

      const result = await runReconciler(sessionId);

      expect(result.bothCompleted).toBe(false);
      expect(result.readyToProceed).toBe(false);
      expect(result.blockingReason).toContain('Bob');
    });

    it('analyzes both directions and returns results when both users completed', async () => {
      mockSessionWithParticipants();
      mockBothEmpathyAttempts();
      mockWitnessingContent();

      // Mock no existing reconciler results (triggers fresh analysis)
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);

      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(
        JSON.stringify({
          alignment: { score: 85, summary: 'Good understanding', correctlyIdentified: ['frustration'] },
          gaps: { severity: 'minor', summary: 'Minor gaps', missedFeelings: [], misattributions: [], mostImportantGap: null },
          recommendation: { action: 'PROCEED', rationale: 'Ready', sharingWouldHelp: false, suggestedShareFocus: null },
        })
      );

      const result = await runReconciler(sessionId);

      expect(result.bothCompleted).toBe(true);
      expect(result.aUnderstandingB).not.toBeNull();
      expect(result.bUnderstandingA).not.toBeNull();
      expect(result.aUnderstandingB?.recommendation.action).toBe('PROCEED');
    });

    it('returns readyToProceed=true when both directions get PROCEED', async () => {
      mockSessionWithParticipants();
      mockBothEmpathyAttempts();
      mockWitnessingContent();
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);

      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(
        JSON.stringify({
          alignment: { score: 90, summary: 'Excellent', correctlyIdentified: [] },
          gaps: { severity: 'none', summary: 'No gaps', missedFeelings: [], misattributions: [], mostImportantGap: null },
          recommendation: { action: 'PROCEED', rationale: 'Aligned', sharingWouldHelp: false, suggestedShareFocus: null },
        })
      );

      const result = await runReconciler(sessionId);

      expect(result.readyToProceed).toBe(true);
      expect(result.blockingReason).toBeNull();
    });

    it('returns readyToProceed=false when one direction has OFFER_SHARING', async () => {
      mockSessionWithParticipants();
      mockBothEmpathyAttempts();
      mockWitnessingContent();
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);

      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(
        JSON.stringify({
          alignment: { score: 50, summary: 'Needs work', correctlyIdentified: [] },
          gaps: { severity: 'significant', summary: 'Big gaps', missedFeelings: ['fear'], misattributions: [], mostImportantGap: 'Fear' },
          recommendation: { action: 'OFFER_SHARING', rationale: 'Must share', sharingWouldHelp: true, suggestedShareFocus: 'Fear' },
        })
      );

      const result = await runReconciler(sessionId);

      expect(result.readyToProceed).toBe(false);
      expect(result.blockingReason).toContain('empathy gaps');
    });

    it('runs analysis for only one user when forUserId is specified', async () => {
      mockSessionWithParticipants();
      mockBothEmpathyAttempts();
      mockWitnessingContent();
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);

      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(
        JSON.stringify({
          alignment: { score: 80, summary: 'Good', correctlyIdentified: [] },
          gaps: { severity: 'minor', summary: 'Minor', missedFeelings: [], misattributions: [], mostImportantGap: null },
          recommendation: { action: 'PROCEED', rationale: 'OK', sharingWouldHelp: false, suggestedShareFocus: null },
        })
      );

      const result = await runReconciler(sessionId, 'user-a');

      // Only A's understanding of B should be analyzed
      expect(result.aUnderstandingB).not.toBeNull();
      expect(result.bUnderstandingA).toBeNull();
    });

    it('uses cached result when existing reconciler result found', async () => {
      mockSessionWithParticipants();
      mockBothEmpathyAttempts();
      mockWitnessingContent();

      // Return cached result
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue({
        alignmentScore: 80,
        alignmentSummary: 'Cached result',
        correctlyIdentified: ['empathy'],
        gapSeverity: 'minor',
        gapSummary: 'Cached minor gaps',
        missedFeelings: [],
        misattributions: [],
        mostImportantGap: null,
        recommendedAction: 'PROCEED',
        rationale: 'Cached',
        sharingWouldHelp: false,
        suggestedShareFocus: null,
      });

      const result = await runReconciler(sessionId);

      // Should not call AI since cached
      const { getSonnetResponse } = require('../../lib/bedrock');
      expect(getSonnetResponse).not.toHaveBeenCalled();
      expect(result.aUnderstandingB?.alignment.summary).toBe('Cached result');
    });

    it('uses fallback result when AI returns null', async () => {
      mockSessionWithParticipants();
      mockBothEmpathyAttempts();
      mockWitnessingContent();
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);

      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(null);

      const result = await runReconciler(sessionId);

      // Should use default fallback
      expect(result.aUnderstandingB?.alignment.score).toBe(70);
      expect(result.aUnderstandingB?.recommendation.action).toBe('PROCEED');
    });
  });

  // ==========================================================================
  // 8. respondToShareSuggestion
  // ==========================================================================

  describe('respondToShareSuggestion', () => {
    const sessionId = 'session-1';
    const subjectUserId = 'subject-1';
    const guesserId = 'guesser-1';

    function mockShareOffer(status = 'OFFERED') {
      return {
        id: 'offer-1',
        userId: subjectUserId,
        status,
        suggestedContent: 'I feel afraid that we might be growing apart.',
        suggestedReason: 'Addresses the core fear.',
        result: {
          id: 'result-1',
          sessionId,
          guesserId,
          subjectId: subjectUserId,
          guesserName: 'Guesser',
          subjectName: 'Subject',
          gapSeverity: 'moderate',
          gapSummary: 'Missed deeper feelings',
          missedFeelings: ['fear'],
          mostImportantGap: 'Fear of disconnection',
        },
      };
    }

    describe('decline path', () => {
      /**
       * Helper: mock $transaction so the FIRST call uses a custom decline tx,
       * and subsequent calls (e.g. checkAndRevealBothIfReady) fall through to
       * the default behavior (pass prisma as tx).
       */
      function mockDeclineTransaction(overrides?: {
        shareOfferUpdateCount?: number;
        onAfterCallback?: () => void;
      }) {
        const { shareOfferUpdateCount = 1, onAfterCallback } = overrides ?? {};
        (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: Function) => {
          const tx = {
            reconcilerShareOffer: {
              updateMany: jest.fn().mockResolvedValue({ count: shareOfferUpdateCount }),
            },
            empathyAttempt: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'attempt-1',
                status: EmpathyStatus.AWAITING_SHARING,
              }),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            message: {
              deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
          };
          const result = await cb(tx);
          onAfterCallback?.();
          return result;
        });
        // checkAndRevealBothIfReady's serializable transaction uses the default
        // mock (reset in beforeEach) which passes prisma as tx.
      }

      it('marks guesser empathy as READY and returns declined status', async () => {
        const offer = mockShareOffer();
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(offer);

        mockDeclineTransaction();

        // Mock checkAndRevealBothIfReady's dependency (not both READY, returns early)
        (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([]);

        const result = await respondToShareSuggestion(sessionId, subjectUserId, {
          action: 'decline',
        });

        expect(result.status).toBe('declined');
        expect(result.sharedContent).toBeNull();
        expect(result.guesserUpdated).toBe(true);
      });

      it('validates state transition from AWAITING_SHARING to READY on decline', async () => {
        const offer = mockShareOffer();
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(offer);

        let transitionCalled = false;
        mockDeclineTransaction({ onAfterCallback: () => { transitionCalled = true; } });

        (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([]);

        await respondToShareSuggestion(sessionId, subjectUserId, { action: 'decline' });

        // Transaction was executed successfully (includes transition validation)
        expect(transitionCalled).toBe(true);
      });

      it('throws when share offer already processed (idempotency)', async () => {
        const offer = mockShareOffer();
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(offer);

        mockDeclineTransaction({ shareOfferUpdateCount: 0 });

        await expect(
          respondToShareSuggestion(sessionId, subjectUserId, { action: 'decline' })
        ).rejects.toThrow('Share offer already processed');
      });
    });

    describe('accept path', () => {
      beforeEach(() => {
        // Mock stageProgress for subject's current stage
        (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({ stage: 2 });

        // Mock message count for prior shares
        (prisma.message.count as jest.Mock).mockResolvedValue(0);

        // Mock AI responses for continuation and reflection
        const { getSonnetResponse } = require('../../lib/bedrock');
        (getSonnetResponse as jest.Mock).mockResolvedValue(
          JSON.stringify({ response: 'Thank you for sharing that.' })
        );
      });

      it('creates shared context and updates guesser to REFINING on accept', async () => {
        const offer = mockShareOffer();
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(offer);

        // Accept path: AI calls happen outside transaction, then transaction runs
        (prisma.$transaction as jest.Mock).mockImplementation(async (cb: Function) => {
          const tx = {
            reconcilerShareOffer: {
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            empathyAttempt: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'attempt-1',
                status: EmpathyStatus.AWAITING_SHARING,
              }),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            message: {
              deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
              create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
            },
          };
          return cb(tx);
        });

        const result = await respondToShareSuggestion(sessionId, subjectUserId, {
          action: 'accept',
        });

        expect(result.status).toBe('shared');
        expect(result.sharedContent).toBe('I feel afraid that we might be growing apart.');
        expect(result.guesserUpdated).toBe(true);
      });

      it('throws when no pending share offer found', async () => {
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(null);

        await expect(
          respondToShareSuggestion(sessionId, subjectUserId, { action: 'accept' })
        ).rejects.toThrow('No pending share offer found');
      });

      it('uses refined content when action is refine', async () => {
        const offer = mockShareOffer();
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(offer);

        // Mock the refine AI response
        const { getSonnetResponse } = require('../../lib/bedrock');
        (getSonnetResponse as jest.Mock).mockResolvedValue(
          JSON.stringify({ refinedContent: 'My refined message about feeling disconnected.' })
        );

        (prisma.$transaction as jest.Mock).mockImplementation(async (cb: Function) => {
          const tx = {
            reconcilerShareOffer: {
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            empathyAttempt: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'attempt-1',
                status: EmpathyStatus.AWAITING_SHARING,
              }),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            message: {
              deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
              create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
            },
          };
          return cb(tx);
        });

        const result = await respondToShareSuggestion(sessionId, subjectUserId, {
          action: 'refine',
          refinedContent: 'I want it to be more about feeling disconnected',
        });

        expect(result.status).toBe('shared');
        // The shared content comes from the AI refinement
        expect(result.sharedContent).toBeTruthy();
      });

      it('falls back to original content when AI refinement fails', async () => {
        const offer = mockShareOffer();
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(offer);

        // First getSonnetResponse call (refineShareSuggestion) returns null
        // Second call (generatePostShareContinuation or reflection) returns content
        const { getSonnetResponse } = require('../../lib/bedrock');
        let callCount = 0;
        (getSonnetResponse as jest.Mock).mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(null); // Refine fails
          return Promise.resolve('Reflection message');
        });

        (prisma.$transaction as jest.Mock).mockImplementation(async (cb: Function) => {
          const tx = {
            reconcilerShareOffer: {
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            empathyAttempt: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'attempt-1',
                status: EmpathyStatus.AWAITING_SHARING,
              }),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            message: {
              deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
              create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
            },
          };
          return cb(tx);
        });

        const result = await respondToShareSuggestion(sessionId, subjectUserId, {
          action: 'refine',
          refinedContent: 'Make it warmer',
        });

        expect(result.status).toBe('shared');
        // Falls back to original suggested content
        expect(result.sharedContent).toBe('I feel afraid that we might be growing apart.');
      });

      it('handles PENDING status share offer (race condition)', async () => {
        const offer = mockShareOffer('PENDING');
        (prisma.reconcilerShareOffer.findFirst as jest.Mock).mockResolvedValue(offer);
        (prisma.reconcilerShareOffer.update as jest.Mock).mockResolvedValue({ ...offer, status: 'OFFERED' });

        (prisma.$transaction as jest.Mock).mockImplementation(async (cb: Function) => {
          const tx = {
            reconcilerShareOffer: {
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            empathyAttempt: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'attempt-1',
                status: EmpathyStatus.AWAITING_SHARING,
              }),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            message: {
              deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
              create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
            },
          };
          return cb(tx);
        });

        const { getSonnetResponse } = require('../../lib/bedrock');
        (getSonnetResponse as jest.Mock).mockResolvedValue('Reflection message');

        const result = await respondToShareSuggestion(sessionId, subjectUserId, {
          action: 'accept',
        });

        expect(result.status).toBe('shared');
        // Verify PENDING was first updated to OFFERED
        expect(prisma.reconcilerShareOffer.update).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: { status: 'OFFERED' },
        });
      });
    });
  });

  // ==========================================================================
  // runReconcilerForDirection
  // ==========================================================================

  describe('runReconcilerForDirection', () => {
    const sessionId = 'session-1';
    const guesserId = 'guesser-1';
    const subjectId = 'subject-1';

    beforeEach(() => {
      // Mock user lookups
      (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === guesserId) {
          return Promise.resolve({ id: guesserId, name: 'Guesser User', firstName: 'Guesser' });
        }
        if (where.id === subjectId) {
          return Promise.resolve({ id: subjectId, name: 'Subject User', firstName: 'Subject' });
        }
        return Promise.resolve(null);
      });

      // Mock empathy data
      (prisma.empathyAttempt.findFirst as jest.Mock).mockResolvedValue({
        id: 'attempt-1',
        sessionId,
        sourceUserId: guesserId,
        content: 'I think they feel frustrated.',
        sharedAt: new Date(),
        status: 'HELD',
      });

      // Mock witnessing content
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        {
          content: 'I feel so disconnected.',
          extractedEmotions: ['disconnection'],
        },
      ]);

      // Mock no existing reconciler result
      (prisma.reconcilerResult.findFirst as jest.Mock).mockResolvedValue(null);

      // Mock checkAndRevealBothIfReady dependency
      (prisma.empathyAttempt.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('throws when guesser not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        runReconcilerForDirection(sessionId, guesserId, subjectId)
      ).rejects.toThrow('Guesser or subject not found');
    });

    it('forces READY when circuit breaker trips', async () => {
      (prisma as any).refinementAttemptCounter.findUnique.mockResolvedValue({
        attempts: 5,
      });

      // Need to mock empathyAttempt.findFirst for markEmpathyReady
      (prisma.empathyAttempt.findFirst as jest.Mock).mockResolvedValue({
        id: 'attempt-1',
        status: EmpathyStatus.HELD,
      });

      const result = await runReconcilerForDirection(sessionId, guesserId, subjectId);

      expect(result.empathyStatus).toBe('READY');
      expect(result.result).toBeNull();
      expect(result.shareOffer).toBeNull();
    });

    it('marks READY when action is PROCEED (no sharing needed)', async () => {
      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(
        JSON.stringify({
          alignment: { score: 90, summary: 'Great', correctlyIdentified: ['all'] },
          gaps: { severity: 'none', summary: 'None', missedFeelings: [], misattributions: [], mostImportantGap: null },
          recommendation: { action: 'PROCEED', rationale: 'Aligned', sharingWouldHelp: false, suggestedShareFocus: null },
        })
      );

      const result = await runReconcilerForDirection(sessionId, guesserId, subjectId);

      expect(result.empathyStatus).toBe('READY');
      expect(result.shareOffer).toBeNull();
      // Verify empathy was updated to READY
      expect(prisma.empathyAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'READY' }),
        })
      );
    });

    it('marks READY when context was already shared (prevents duplicate)', async () => {
      const { getSonnetResponse } = require('../../lib/bedrock');
      (getSonnetResponse as jest.Mock).mockResolvedValue(
        JSON.stringify({
          alignment: { score: 60, summary: 'Gaps remain', correctlyIdentified: [] },
          gaps: { severity: 'moderate', summary: 'Still gaps', missedFeelings: ['fear'], misattributions: [], mostImportantGap: 'Fear' },
          recommendation: { action: 'OFFER_SHARING', rationale: 'Share more', sharingWouldHelp: true, suggestedShareFocus: 'Fear' },
        })
      );

      // Mock that context has already been shared
      (prisma.message.findFirst as jest.Mock).mockResolvedValue({
        id: 'existing-shared',
        role: 'SHARED_CONTEXT',
        senderId: subjectId,
        forUserId: guesserId,
        timestamp: new Date(),
      });

      const result = await runReconcilerForDirection(sessionId, guesserId, subjectId);

      expect(result.empathyStatus).toBe('READY');
    });

    it('sets AWAITING_SHARING and generates share offer when gaps detected', async () => {
      const { getSonnetResponse } = require('../../lib/bedrock');

      // First call: reconciler analysis (gaps detected)
      // Second call: share suggestion generation
      let callIndex = 0;
      (getSonnetResponse as jest.Mock).mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(
            JSON.stringify({
              alignment: { score: 50, summary: 'Significant gaps', correctlyIdentified: [] },
              gaps: { severity: 'significant', summary: 'Major gaps', missedFeelings: ['fear', 'loneliness'], misattributions: [], mostImportantGap: 'Deep fear' },
              recommendation: { action: 'OFFER_SHARING', rationale: 'Must share', sharingWouldHelp: true, suggestedShareFocus: 'Their deep fear' },
            })
          );
        }
        // Share suggestion generation
        return Promise.resolve(
          JSON.stringify({
            suggestedContent: 'I feel scared that we are drifting apart.',
            reason: 'Addresses the core fear.',
          })
        );
      });

      // No existing shared context
      (prisma.message.findFirst as jest.Mock).mockResolvedValue(null);

      // The empathyAttempt.findFirst is called multiple times:
      // 1. getEmpathyData (for the guesser's empathy statement) — needs content
      // 2. For AWAITING_SHARING transition validation — needs status ANALYZING
      //    (because analyzeEmpathyGap runs first, implicitly the status should be ANALYZING)
      (prisma.empathyAttempt.findFirst as jest.Mock)
        .mockResolvedValueOnce({
          id: 'attempt-1',
          sessionId,
          sourceUserId: guesserId,
          content: 'I think they feel frustrated.',
          sharedAt: new Date(),
          status: 'HELD',
        })
        .mockResolvedValue({
          id: 'attempt-1',
          sessionId,
          sourceUserId: guesserId,
          status: EmpathyStatus.ANALYZING,
        });

      // Mock reconciler result creation — need it for generateShareSuggestion
      (prisma.reconcilerResult.create as jest.Mock).mockResolvedValue({ id: 'result-1' });
      // After creation, the findFirst for share suggestion lookup should return it
      (prisma.reconcilerResult.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // First call: no existing result (triggers analysis)
        .mockResolvedValue({ id: 'result-1' }); // Subsequent calls: return the created result

      const result = await runReconcilerForDirection(sessionId, guesserId, subjectId);

      expect(result.empathyStatus).toBe('AWAITING_SHARING');
      expect(result.shareOffer).not.toBeNull();
      expect(result.shareOffer?.suggestedContent).toBeTruthy();
    });

    it('throws when guesser has not submitted empathy statement', async () => {
      // Reset the empathyAttempt mock to return null (no empathy submitted)
      (prisma.empathyAttempt.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        runReconcilerForDirection(sessionId, guesserId, subjectId)
      ).rejects.toThrow('Guesser has not submitted empathy statement');
    });
  });
});
