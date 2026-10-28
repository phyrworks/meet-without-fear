/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture: the
 * partner-session classifier against a real session. Haiku is stubbed at
 * lib/bedrock (and the circuit breaker runs inline); no Prisma mock. The
 * NOTABLE_FACTS document is read back from ai_memory, where mwf_job wrote it
 * for Ada's participant (INSERT … ON CONFLICT DO UPDATE).
 *
 * Replaces the Prisma-mock half of services/__tests__/partner-session-classifier.test.ts
 * (the pure fact bookkeeping stays there).
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

// Mock embedding service first (before any imports)
jest.mock('../embedding', () => ({
  embedSessionContent: jest.fn().mockResolvedValue(true),
}));

// Mock circuit breaker to execute immediately without timeout
jest.mock('../../utils/circuit-breaker', () => ({
  withHaikuCircuitBreaker: jest.fn().mockImplementation(async fn => fn()),
  withTimeout: jest.fn().mockImplementation(async fn => fn()),
  HAIKU_TIMEOUT_MS: 20000,
}));

// Mock Bedrock for Haiku calls - returns categorized facts
jest.mock('../../lib/bedrock', () => ({
  getHaikuJson: jest.fn().mockResolvedValue({
    topicContext: 'discussing relationship',
    notableFacts: [
      { category: 'People', fact: 'User has a daughter named Emma' },
      { category: 'Logistics', fact: 'Partner works night shifts' },
    ],
  }),
  BrainActivityCallType: {
    PARTNER_SESSION_CLASSIFICATION: 'PARTNER_SESSION_CLASSIFICATION',
  },
}));

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';
import { getHaikuJson } from '../../lib/bedrock';
import type { CategorizedFactWithId } from '../partner-session-classifier';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

let SESSION = '';
let USER = '';
let run: TargetRun;
let adaParticipant = '';
let runPartnerSessionClassifier: typeof import('../partner-session-classifier').runPartnerSessionClassifier;

const savedNotableFacts = async (): Promise<CategorizedFactWithId[]> => {
  const [row] = await run.sql<{ doc: { facts: CategorizedFactWithId[] } }>(
    `SELECT doc FROM ai_memory WHERE participant_id = $1 AND kind = 'NOTABLE_FACTS'`,
    [adaParticipant],
  );
  if (!row) throw new Error('no NOTABLE_FACTS document was written');
  return row.doc.facts;
};

describeTarget('partner-session classifier on the target (NOTABLE_FACTS by mwf_job)', () => {
  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_psc_${process.pid}`);
    const ids = await adaAndBob(run);
    SESSION = ids.session;
    USER = ids.adaUser;
    adaParticipant = ids.ada;
    ({ runPartnerSessionClassifier } = await import('../partner-session-classifier'));
  });
  afterAll(async () => {
    if (run) await run.drop();
  });
  beforeEach(async () => {
    await run.sql(`DELETE FROM ai_memory WHERE participant_id = $1 AND kind = 'NOTABLE_FACTS'`, [adaParticipant]);
  });

  it('writes nothing for another session’s participant (the job resolves the caller’s own participant)', async () => {
    await runPartnerSessionClassifier({
      userMessage: 'x',
      conversationHistory: [],
      sessionId: SESSION,
      userId: '019a0000-0000-7000-8000-0000000000dd',
      turnId: 't',
    });
    expect(await run.sql(`SELECT count(*)::int AS n FROM ai_memory WHERE kind = 'NOTABLE_FACTS'`)).toEqual([{ n: 0 }]);
  });

  // ============================================================================
  // Partner Session Classifier Tests
  // ============================================================================

  describe('Partner Session Classifier', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    describe('Notable Facts Extraction', () => {
      it('extracts categorized notable facts from Haiku response', async () => {
        const result = await runPartnerSessionClassifier({
          userMessage: 'My daughter Emma is struggling with school',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
          partnerName: 'Alex',
        });

        expect(result).not.toBeNull();
        expect(result?.notableFacts).toEqual([
          { category: 'People', fact: 'User has a daughter named Emma' },
          { category: 'Logistics', fact: 'Partner works night shifts' },
        ]);
      });

      it('saves categorized notable facts with IDs to UserVessel', async () => {
        await runPartnerSessionClassifier({
          userMessage: 'We have been married for 10 years',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
        });

        const savedFacts = await savedNotableFacts();

        // Facts should now include stable IDs for diff-based updates
        expect(savedFacts).toHaveLength(2);
        expect(savedFacts[0]).toMatchObject({ category: 'People', fact: 'User has a daughter named Emma' });
        expect(savedFacts[0].id).toBeDefined();
        expect(savedFacts[0].id).toMatch(/^[a-f0-9-]{36}$/); // UUID format
        expect(savedFacts[1]).toMatchObject({ category: 'Logistics', fact: 'Partner works night shifts' });
        expect(savedFacts[1].id).toBeDefined();
      });

      it('passes existing facts to Haiku for consolidation', async () => {
        const existingFacts = ['User lives in NYC', 'Has two children'];

        await runPartnerSessionClassifier({
          userMessage: 'I feel overwhelmed',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
          existingFacts,
        });

        // Verify getHaikuJson was called with a prompt containing existing facts
        expect(getHaikuJson).toHaveBeenCalled();
        const call = (getHaikuJson as jest.Mock).mock.calls[0][0];
        expect(call.messages[0].content).toContain('User lives in NYC');
        expect(call.messages[0].content).toContain('Has two children');
      });

      it('passes Sonnet analysis to Haiku for better fact extraction', async () => {
        const sonnetAnalysis = 'The user is expressing frustration about work-life balance';
        const sonnetResponse = "I hear that you're feeling overwhelmed by competing priorities...";

        await runPartnerSessionClassifier({
          userMessage: 'I just cant seem to balance everything',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
          sonnetAnalysis,
          sonnetResponse,
        });

        // Verify getHaikuJson was called with a prompt containing Sonnet's analysis
        expect(getHaikuJson).toHaveBeenCalled();
        const call = (getHaikuJson as jest.Mock).mock.calls[0][0];
        expect(call.messages[0].content).toContain("SONNET'S ANALYSIS");
        expect(call.messages[0].content).toContain(sonnetAnalysis);
        expect(call.messages[0].content).toContain("SONNET'S RESPONSE");
        expect(call.messages[0].content).toContain(sonnetResponse);
      });

      it('does not include Sonnet section when analysis is not provided', async () => {
        await runPartnerSessionClassifier({
          userMessage: 'Just a regular message',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
        });

        expect(getHaikuJson).toHaveBeenCalled();
        const call = (getHaikuJson as jest.Mock).mock.calls[0][0];
        expect(call.messages[0].content).not.toContain("SONNET'S ANALYSIS");
      });

      it('limits facts to 20 items', async () => {
        const manyFacts = Array.from({ length: 25 }, (_, i) => ({
          category: 'People',
          fact: `Fact ${i + 1}`,
        }));
        (getHaikuJson as jest.Mock).mockResolvedValueOnce({
          notableFacts: manyFacts,
        });

        const result = await runPartnerSessionClassifier({
          userMessage: 'Test message',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
        });

        expect(result?.notableFacts).toHaveLength(20);
      });

      it('filters out invalid facts (empty, wrong types, missing fields)', async () => {
        (getHaikuJson as jest.Mock).mockResolvedValueOnce({
          notableFacts: [
            { category: 'People', fact: 'Valid fact' },
            { category: '', fact: 'Empty category' }, // Empty category - filtered
            { category: 'Emotional', fact: '' }, // Empty fact - filtered
            { category: 'History' }, // Missing fact - filtered
            { fact: 'Missing category' }, // Missing category - filtered
            null, // null - filtered
            'string only', // Plain string - filtered
            { category: 'Logistics', fact: 'Another valid fact' },
          ],
        });

        const result = await runPartnerSessionClassifier({
          userMessage: 'Test message',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
        });

        expect(result?.notableFacts).toEqual([
          { category: 'People', fact: 'Valid fact' },
          { category: 'Logistics', fact: 'Another valid fact' },
        ]);
      });

      it('returns undefined notableFacts on Haiku timeout (fallback)', async () => {
        const existingFacts = ['Preserved fact 1', 'Preserved fact 2'];

        // Simulate Haiku returning null (timeout)
        (getHaikuJson as jest.Mock).mockResolvedValueOnce(null);

        const result = await runPartnerSessionClassifier({
          userMessage: 'Test message',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
          existingFacts,
        });

        // On failure, notableFacts should be undefined (don't overwrite existing)
        expect(result?.notableFacts).toBeUndefined();
      });

      it('does not include memory detection tasks in prompt', async () => {
        await runPartnerSessionClassifier({
          userMessage: 'Remember that I prefer short responses',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
        });

        expect(getHaikuJson).toHaveBeenCalled();
        const call = (getHaikuJson as jest.Mock).mock.calls[0][0];
        // Memory detection tasks should NOT be in the prompt
        expect(call.messages[0].content).not.toContain('MEMORY INTENT DETECTION');
        expect(call.messages[0].content).not.toContain('MEMORY VALIDATION');
        expect(call.messages[0].content).not.toContain('TASK 1');
        expect(call.messages[0].content).not.toContain('TASK 2');
      });
    });

    describe('Error Handling', () => {
      it('returns null on complete failure', async () => {
        (getHaikuJson as jest.Mock).mockRejectedValueOnce(new Error('API error'));

        const result = await runPartnerSessionClassifier({
          userMessage: 'Test message',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
        });

        expect(result).toBeNull();
      });

      it('handles response with only topic context (no facts)', async () => {
        (getHaikuJson as jest.Mock).mockResolvedValueOnce({
          topicContext: 'some context',
        });

        const result = await runPartnerSessionClassifier({
          userMessage: 'Test message',
          conversationHistory: [],
          sessionId: SESSION,
          userId: USER,
          turnId: 'turn-1',
        });

        expect(result).not.toBeNull();
        expect(result?.topicContext).toBe('some context');
        expect(result?.notableFacts).toBeUndefined();
      });
    });
  });

  // ============================================================================
  // Diff-Based Prompt and Response Parsing Tests
  // ============================================================================

  describe('Diff-Based Classifier Integration', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('includes random short IDs (not full UUIDs) in prompt when existing facts have IDs', async () => {
      const existingFactsWithIds: CategorizedFactWithId[] = [
        { id: 'fact-abc-123', category: 'People', fact: 'User has a daughter' },
        { id: 'fact-def-456', category: 'Logistics', fact: 'Lives in NYC' },
      ];

      // Mock response - we'll extract the actual short IDs from the prompt
      (getHaikuJson as jest.Mock).mockResolvedValueOnce({
        topicContext: 'discussing family',
        upsert: [],
        delete: [],
      });

      await runPartnerSessionClassifier({
        userMessage: 'Her name is Emma',
        conversationHistory: [],
        sessionId: SESSION,
        userId: USER,
        turnId: 'turn-1',
        existingFactsWithIds,
      });

      // Verify the prompt uses short IDs (not full UUIDs) for token efficiency
      const call = (getHaikuJson as jest.Mock).mock.calls[0][0];
      const promptContent = call.messages[0].content;

      // Full UUIDs should NOT be in the prompt
      expect(promptContent).not.toContain('fact-abc-123');
      expect(promptContent).not.toContain('fact-def-456');

      // Short IDs (5 char alphanumeric) should be present
      // Pattern: [xxxxx] where x is alphanumeric
      const shortIdPattern = /\[([a-z0-9]{5})\]/g;
      const matches = promptContent.match(shortIdPattern);
      expect(matches).toHaveLength(2); // Two facts = two short IDs

      // Verify structural elements
      expect(promptContent).toContain('upsert');
      expect(promptContent).toContain('delete');
      expect(promptContent).toContain('Copy the exact 5-character ID');
    });

    it('uses diff-based reconciliation with short ID mapping', async () => {
      const existingFactsWithIds: CategorizedFactWithId[] = [
        { id: 'fact-1', category: 'People', fact: 'User has a daughter' },
        { id: 'fact-2', category: 'Logistics', fact: 'Lives in NYC' },
        { id: 'fact-3', category: 'Emotional', fact: 'Feeling stressed' },
      ];

      // First, we need to capture the short IDs that will be generated
      // We do this by spying on the call and extracting from the prompt
      const capturedShortIds: { [fullId: string]: string } = {};

      (getHaikuJson as jest.Mock).mockImplementationOnce(args => {
        // Extract short IDs from the prompt
        const prompt = args.messages[0].content;
        const lines = prompt.split('\n').filter((l: string) => l.includes('[') && l.includes(']'));
        lines.forEach((line: string) => {
          const match = line.match(/\[([a-z0-9]{5})\]\s*(\w+):/);
          if (match) {
            // Map category to find full ID
            const shortId = match[1];
            const category = match[2];
            const fact = existingFactsWithIds.find(f => f.category === category);
            if (fact) {
              capturedShortIds[fact.id] = shortId;
            }
          }
        });

        // Return diff using the captured short IDs
        return Promise.resolve({
          topicContext: 'discussing family stress',
          upsert: [
            { id: capturedShortIds['fact-1'], category: 'People', fact: 'User has a daughter named Emma who is 14' },
            { category: 'History', fact: 'Been married for 10 years' }, // New fact, no ID
          ],
          delete: [capturedShortIds['fact-3']], // Delete fact-3 using its short ID
        });
      });

      await runPartnerSessionClassifier({
        userMessage: 'Actually feeling better now',
        conversationHistory: [],
        sessionId: SESSION,
        userId: USER,
        turnId: 'turn-1',
        existingFactsWithIds,
      });

      // Verify the saved facts are correctly reconciled with full UUIDs preserved
      const savedFacts = await savedNotableFacts();

      // fact-1 updated, fact-2 preserved, fact-3 deleted, new fact added
      expect(savedFacts).toHaveLength(3);
      // Verify full UUID is preserved after short ID resolution
      expect(savedFacts.find((f: CategorizedFactWithId) => f.id === 'fact-1')?.fact).toBe(
        'User has a daughter named Emma who is 14',
      );
      expect(savedFacts.find((f: CategorizedFactWithId) => f.id === 'fact-2')).toBeDefined();
      expect(savedFacts.find((f: CategorizedFactWithId) => f.id === 'fact-3')).toBeUndefined();
      expect(savedFacts.find((f: CategorizedFactWithId) => f.fact === 'Been married for 10 years')).toBeDefined();
    });

    it('preserves all facts when LLM returns empty upsert/delete', async () => {
      const existingFactsWithIds: CategorizedFactWithId[] = [
        { id: 'fact-1', category: 'People', fact: 'User has a daughter' },
        { id: 'fact-2', category: 'Logistics', fact: 'Lives in NYC' },
      ];

      (getHaikuJson as jest.Mock).mockResolvedValueOnce({
        topicContext: 'no changes',
        upsert: [],
        delete: [],
      });

      await runPartnerSessionClassifier({
        userMessage: 'Just saying hi',
        conversationHistory: [],
        sessionId: SESSION,
        userId: USER,
        turnId: 'turn-1',
        existingFactsWithIds,
      });

      const savedFacts = await savedNotableFacts();

      expect(savedFacts).toHaveLength(2);
      expect(savedFacts).toEqual(existingFactsWithIds);
    });

    it('falls back gracefully when LLM returns old format (full list without upsert/delete)', async () => {
      const existingFactsWithIds: CategorizedFactWithId[] = [
        { id: 'fact-1', category: 'People', fact: 'User has a daughter' },
      ];

      // LLM returns OLD format (full list) - backward compatibility
      (getHaikuJson as jest.Mock).mockResolvedValueOnce({
        topicContext: 'old format response',
        notableFacts: [
          { category: 'People', fact: 'User has a daughter named Emma' },
          { category: 'Logistics', fact: 'New fact from old format' },
        ],
      });

      const result = await runPartnerSessionClassifier({
        userMessage: 'Testing backward compat',
        conversationHistory: [],
        sessionId: SESSION,
        userId: USER,
        turnId: 'turn-1',
        existingFactsWithIds,
      });

      // When old format is detected, we should still save the facts
      // (fallback behavior - full replacement as before)
      expect(result?.notableFacts).toBeDefined();
      expect(result?.notableFacts).toHaveLength(2);
    });

    it('assigns IDs to legacy facts from DB that lack them before sending to LLM', async () => {
      // Simulate legacy facts from DB without IDs
      const legacyFacts = [{ category: 'People', fact: 'Legacy fact without ID' }];

      (getHaikuJson as jest.Mock).mockResolvedValueOnce({
        topicContext: 'test',
        upsert: [],
        delete: [],
      });

      await runPartnerSessionClassifier({
        userMessage: 'Test message',
        conversationHistory: [],
        sessionId: SESSION,
        userId: USER,
        turnId: 'turn-1',
        existingFacts: legacyFacts.map(f => `[${f.category}] ${f.fact}`),
      });

      // The prompt should contain the legacy fact (as string for backward compat)
      const call = (getHaikuJson as jest.Mock).mock.calls[0][0];
      expect(call.messages[0].content).toContain('Legacy fact without ID');
    });
  });
});
