/**
 * Context Assembler Tests
 *
 * Tests for context bundle assembly including notable facts.
 */

import { formatContextForPrompt, type ContextBundle } from '../context-assembler';
import type { MemoryIntentResult } from '../memory-intent';

describe('Context Assembler', () => {
  describe('formatContextForPrompt', () => {
    // Create a minimal valid ContextBundle for testing
    const createMinimalBundle = (overrides?: Partial<ContextBundle>): ContextBundle => ({
      conversationContext: {
        recentTurns: [],
        turnCount: 0,
        sessionDurationMinutes: 0,
        timeSinceLastUserTurnMs: null,
      },
      emotionalThread: {
        initialIntensity: null,
        currentIntensity: null,
        trend: 'unknown',
        notableShifts: [],
      },
      stageContext: {
        stage: 1,
        gatesSatisfied: {},
      },
      userName: 'User',
      intent: {
        intent: 'emotional_validation',
        depth: 'light',
        reason: 'Test context',
        threshold: 0.5,
        maxCrossSession: 0,
        allowCrossSession: false,
        surfaceStyle: 'silent',
      } as MemoryIntentResult,
      assembledAt: new Date().toISOString(),
      ...overrides,
    });

    describe('Notable Facts Formatting', () => {
      it('formats notable facts with categories', () => {
        const bundle = createMinimalBundle({
          notableFacts: [
            { category: 'People', fact: 'User has a daughter named Emma who is 14' },
            { category: 'Logistics', fact: 'Partner works night shifts' },
            { category: 'Emotional', fact: 'Feeling unheard about childcare decisions' },
          ],
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('--- Notable facts ---');
        expect(formatted).toContain('- User has a daughter named Emma who is 14');
        expect(formatted).toContain('- Partner works night shifts');
        expect(formatted).toContain('- Feeling unheard about childcare decisions');
      });

      it('does not include facts block when no facts exist', () => {
        const bundle = createMinimalBundle({
          notableFacts: undefined,
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).not.toContain('--- Notable facts ---');
      });

      it('does not include facts block when facts array is empty', () => {
        const bundle = createMinimalBundle({
          notableFacts: [],
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).not.toContain('--- Notable facts ---');
      });

      it('formats single fact correctly', () => {
        const bundle = createMinimalBundle({
          notableFacts: [{ category: 'Emotional', fact: 'User feels overwhelmed' }],
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('--- Notable facts ---');
        expect(formatted).toContain('- User feels overwhelmed');
      });

      it('groups facts by category', () => {
        const bundle = createMinimalBundle({
          notableFacts: [
            { category: 'People', fact: 'First person fact' },
            { category: 'Emotional', fact: 'Second emotional fact' },
            { category: 'People', fact: 'Third person fact' },
          ],
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('- First person fact');
        expect(formatted).toContain('- Third person fact');
        expect(formatted).toContain('- Second emotional fact');
      });
    });

    describe('Combined Context Formatting', () => {
      it('includes facts alongside other context elements', () => {
        const bundle = createMinimalBundle({
          emotionalThread: {
            initialIntensity: 5,
            currentIntensity: 7,
            trend: 'escalating',
            notableShifts: [],
          },
          userMemories: {
            global: [{ content: 'Call me Sam', category: 'PERSONAL_INFO' }],
            session: [],
          },
          notableFacts: [
            { category: 'People', fact: 'Has two kids' },
            { category: 'Logistics', fact: 'Works from home' },
          ],
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('Intensity:'); // HUD format
        expect(formatted).toContain('--- User preferences to honor ---');
        expect(formatted).toContain('--- Notable facts ---');
        expect(formatted).toContain('- Has two kids');
        expect(formatted).toContain('- Works from home');
      });

      it('places facts after user memories', () => {
        const bundle = createMinimalBundle({
          userMemories: {
            global: [{ content: 'User memory here', category: 'PREFERENCE' }],
            session: [],
          },
          notableFacts: [{ category: 'Emotional', fact: 'Notable fact here' }],
        });

        const formatted = formatContextForPrompt(bundle);
        const memoriesIndex = formatted.indexOf('--- User preferences to honor ---');
        const factsIndex = formatted.indexOf('--- Notable facts ---');

        expect(memoriesIndex).toBeGreaterThan(-1);
        expect(factsIndex).toBeGreaterThan(-1);
        expect(factsIndex).toBeGreaterThan(memoriesIndex);
      });
    });

    describe('Global Facts Formatting', () => {
      it('does not include global facts in compact context', () => {
        const bundle = createMinimalBundle({
          globalFacts: [
            { category: 'People', fact: 'Has a partner named Alex' },
            { category: 'History', fact: 'Together for 5 years' },
          ],
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).not.toContain('ABOUT THIS USER');
        expect(formatted).not.toContain('Has a partner named Alex');
      });
    });

    describe('Topic Frame Formatting', () => {
      it('includes confirmed topic frame as orientation context', () => {
        const bundle = createMinimalBundle({
          topicFrame: {
            text: 'Trust around late-night texting',
            confirmedAt: '2026-05-12T00:00:00.000Z',
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('--- Conversation topic ---');
        expect(formatted).toContain('Confirmed topic: "Trust around late-night texting"');
        expect(formatted).toContain('Use this as orientation only');
        expect(formatted).toContain('Stage gates still come from StageProgress');
      });

      it('omits topic frame when not present', () => {
        const formatted = formatContextForPrompt(createMinimalBundle());

        expect(formatted).not.toContain('--- Conversation topic ---');
        expect(formatted).not.toContain('Confirmed topic:');
      });
    });

    describe('Consented Share State Formatting', () => {
      it('includes typed consent and share lifecycle as orientation context', () => {
        const bundle = createMinimalBundle({
          consentedShareState: {
            items: [
              {
                kind: 'empathy_attempt',
                direction: 'user_to_partner',
                lifecycleStatus: 'VALIDATED',
                content: 'I think you felt shut out when I made the decision alone.',
                sharedAt: '2026-05-12T00:00:00.000Z',
                revealedAt: '2026-05-12T00:05:00.000Z',
                validatedAt: '2026-05-12T00:10:00.000Z',
              },
              {
                kind: 'additional_context',
                direction: 'partner_to_user',
                lifecycleStatus: 'ACCEPTED/DELIVERED',
                content: 'I needed to know my effort still mattered.',
                sharedAt: '2026-05-12T00:02:00.000Z',
                deliveredAt: '2026-05-12T00:03:00.000Z',
              },
            ],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('--- Consented partner/share state ---');
        expect(formatted).toContain('Use this only for orientation');
        expect(formatted).toContain('Stage gates still come from StageProgress');
        expect(formatted).toContain('empathy/share/validation lifecycle state');
        expect(formatted).toContain(
          '- You shared empathy attempt (VALIDATED; shared 2026-05-12T00:00:00.000Z; revealed 2026-05-12T00:05:00.000Z; validated 2026-05-12T00:10:00.000Z): I think you felt shut out when I made the decision alone.',
        );
        expect(formatted).toContain(
          '- Partner shared additional context (ACCEPTED/DELIVERED; shared 2026-05-12T00:02:00.000Z; delivered 2026-05-12T00:03:00.000Z): I needed to know my effort still mattered.',
        );
      });

      it('omits consented share state when no items are present', () => {
        const bundle = createMinimalBundle({
          consentedShareState: {
            items: [],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).not.toContain('--- Consented partner/share state ---');
      });

      it('does not render partner content when lifecycle says it is not visible to this user', () => {
        const bundle = createMinimalBundle({
          consentedShareState: {
            items: [
              {
                kind: 'empathy_attempt',
                direction: 'partner_to_user',
                lifecycleStatus: 'READY',
                sharedAt: '2026-05-12T00:00:00.000Z',
              },
            ],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain(
          '- Partner shared empathy attempt (READY; shared 2026-05-12T00:00:00.000Z) (content not yet visible to this user)',
        );
      });

      it('truncates long share-state content to keep prompt size bounded', () => {
        const longContent = 'b'.repeat(500);
        const bundle = createMinimalBundle({
          consentedShareState: {
            items: [
              {
                kind: 'additional_context',
                direction: 'user_to_partner',
                lifecycleStatus: 'ACCEPTED/SEEN',
                content: longContent,
              },
            ],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain(`${'b'.repeat(359)}…`);
        expect(formatted).not.toContain(longContent);
      });
    });

    describe('Prior Stage Summaries Formatting', () => {
      it('includes prior-stage summaries as continuity context', () => {
        const bundle = createMinimalBundle({
          stageContext: {
            stage: 2,
            gatesSatisfied: {},
          },
          priorStageSummaries: {
            stages: [
              {
                stage: 1,
                lifecycleStatus: 'COMPLETED',
                completedAt: '2026-05-12T00:10:00.000Z',
                userTurnCount: 2,
                assistantTurnCount: 2,
                highlights: [
                  {
                    role: 'user',
                    content: 'I felt like every practical objection meant she was already halfway gone.',
                    stage: 1,
                    timestamp: '2026-05-12T00:01:00.000Z',
                  },
                  {
                    role: 'assistant',
                    content: 'The fear is not just about the trip, it is about losing the marriage.',
                    stage: 1,
                    timestamp: '2026-05-12T00:02:00.000Z',
                  },
                ],
              },
            ],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('--- Prior stage summaries (current user lane only) ---');
        expect(formatted).toContain('Use this only for continuity');
        expect(formatted).toContain('Stage gates still come from StageProgress');
        expect(formatted).toContain(
          'Stage 1 (COMPLETED; completed 2026-05-12T00:10:00.000Z): 2 user turn(s), 2 AI turn(s).',
        );
        expect(formatted).toContain(
          '- User: I felt like every practical objection meant she was already halfway gone.',
        );
        expect(formatted).toContain('- AI: The fear is not just about the trip, it is about losing the marriage.');
      });

      it('omits prior-stage summaries when no stages are present', () => {
        const bundle = createMinimalBundle({
          priorStageSummaries: {
            stages: [],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).not.toContain('--- Prior stage summaries');
      });

      it('truncates long prior-stage highlights to keep prompt size bounded', () => {
        const longContent = 'c'.repeat(500);
        const bundle = createMinimalBundle({
          priorStageSummaries: {
            stages: [
              {
                stage: 0,
                lifecycleStatus: 'COMPLETED',
                userTurnCount: 1,
                assistantTurnCount: 0,
                highlights: [
                  {
                    role: 'user',
                    content: longContent,
                    stage: 0,
                    timestamp: '2026-05-12T00:00:00.000Z',
                  },
                ],
              },
            ],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain(`${'c'.repeat(239)}…`);
        expect(formatted).not.toContain(longContent);
      });
    });

    describe('Current Stage History Formatting', () => {
      it('includes full current-user stage history as continuity context', () => {
        const bundle = createMinimalBundle({
          stageContext: {
            stage: 2,
            gatesSatisfied: {},
          },
          currentStageHistory: {
            stage: 2,
            messages: [
              {
                role: 'user',
                content: 'I think Eve feels boxed in by the safe life I built.',
                stage: 2,
                timestamp: '2026-05-12T00:00:00.000Z',
              },
              {
                role: 'assistant',
                content: 'That sounds like a real attempt to imagine her side.',
                stage: 2,
                timestamp: '2026-05-12T00:01:00.000Z',
              },
              {
                role: 'empathy_statement',
                content: 'I think you might feel like stability became a cage.',
                stage: 2,
                timestamp: '2026-05-12T00:02:00.000Z',
              },
            ],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain('--- Current Stage 2 history (current user lane only) ---');
        expect(formatted).toContain('Use this only for continuity');
        expect(formatted).toContain('Stage gates still come from StageProgress');
        expect(formatted).toContain('- User: I think Eve feels boxed in by the safe life I built.');
        expect(formatted).toContain('- AI: That sounds like a real attempt to imagine her side.');
        expect(formatted).toContain('- Empathy statement: I think you might feel like stability became a cage.');
      });

      it('omits current stage history when no messages are present', () => {
        const bundle = createMinimalBundle({
          currentStageHistory: {
            stage: 2,
            messages: [],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).not.toContain('Current Stage 2 history');
      });

      it('truncates long stage-history entries to keep prompt size bounded', () => {
        const longContent = 'a'.repeat(500);
        const bundle = createMinimalBundle({
          currentStageHistory: {
            stage: 1,
            messages: [
              {
                role: 'user',
                content: longContent,
                stage: 1,
                timestamp: '2026-05-12T00:00:00.000Z',
              },
            ],
          },
        });

        const formatted = formatContextForPrompt(bundle);

        expect(formatted).toContain(`${'a'.repeat(359)}…`);
        expect(formatted).not.toContain(longContent);
      });
    });

    describe('Session Isolation', () => {
      it('does not include global facts when undefined (session isolation)', () => {
        // Per session isolation spec: globalFacts should be undefined until consent UI is built
        const bundle = createMinimalBundle({
          globalFacts: undefined,
          // Session-specific facts should still work
          notableFacts: [{ category: 'Emotional', fact: 'User is feeling stressed' }],
        });

        const formatted = formatContextForPrompt(bundle);

        // Should NOT contain global facts section
        expect(formatted).not.toContain('ABOUT THIS USER (from previous sessions)');

        // Should still contain session-specific notable facts
        expect(formatted).toContain('--- Notable facts ---');
        expect(formatted).toContain('User is feeling stressed');
      });

      it('verifies session isolation - no cross-session context in stage 1', () => {
        // This test documents the expected behavior per the session isolation spec:
        // Stage 1 sessions should be a "clean slate" with only:
        // - Session-specific notable facts
        // - User memories
        // - Emotional thread
        // But NOT:
        // - Global facts from previous sessions
        const bundle = createMinimalBundle({
          globalFacts: undefined, // Disabled until consent UI
          notableFacts: [{ category: 'People', fact: 'Partner is named Alex' }],
          userMemories: {
            global: [{ content: 'Prefers to be called Sam', category: 'PERSONAL_INFO' }],
            session: [],
          },
          emotionalThread: {
            initialIntensity: 5,
            currentIntensity: 6,
            trend: 'stable',
            notableShifts: [],
          },
          stageContext: {
            stage: 1,
            gatesSatisfied: {},
          },
        });

        const formatted = formatContextForPrompt(bundle);

        // Allowed content for session isolation
        expect(formatted).toContain('--- Notable facts ---');
        expect(formatted).toContain('--- User preferences to honor ---');
        expect(formatted).toContain('Intensity:'); // HUD format

        // Forbidden content (cross-session)
        expect(formatted).not.toContain('ABOUT THIS USER (from previous sessions)');
      });
    });

    describe('Resumption framing (long-idle)', () => {
      const HOUR = 60 * 60 * 1000;

      it('does not render resumption section for active conversations', () => {
        const bundle = createMinimalBundle({
          conversationContext: {
            recentTurns: [],
            turnCount: 5,
            sessionDurationMinutes: 10,
            timeSinceLastUserTurnMs: 5 * 60 * 1000, // 5 min
          },
        });
        const formatted = formatContextForPrompt(bundle);
        expect(formatted).not.toContain('Resumption');
      });

      it('does not render resumption section when user has never spoken', () => {
        const bundle = createMinimalBundle({
          conversationContext: {
            recentTurns: [],
            turnCount: 0,
            sessionDurationMinutes: 0,
            timeSinceLastUserTurnMs: null,
          },
        });
        const formatted = formatContextForPrompt(bundle);
        expect(formatted).not.toContain('Resumption');
      });

      it('renders cliffhanger branch when summary has a lastUnresolvedThread', () => {
        const bundle = createMinimalBundle({
          conversationContext: {
            recentTurns: [],
            turnCount: 8,
            sessionDurationMinutes: 30,
            timeSinceLastUserTurnMs: 48 * HOUR,
          },
          sessionSummary: {
            keyThemes: [],
            emotionalJourney: '',
            currentFocus: '',
            userStatedGoals: [],
            lastUnresolvedThread: 'Alice was still sitting with the feeling that trust had been eroding.',
          },
        });
        const formatted = formatContextForPrompt(bundle);
        expect(formatted).toContain('Resumption');
        expect(formatted).toContain('Paused mid-thread');
        expect(formatted).toContain('trust had been eroding');
        expect(formatted).toContain('2 days'); // humanized duration
      });

      it('renders milestone branch when lastUnresolvedThread is null', () => {
        const bundle = createMinimalBundle({
          conversationContext: {
            recentTurns: [],
            turnCount: 8,
            sessionDurationMinutes: 30,
            timeSinceLastUserTurnMs: 26 * HOUR,
          },
          stageContext: {
            stage: 2,
            gatesSatisfied: {},
          },
          sessionSummary: {
            keyThemes: [],
            emotionalJourney: '',
            currentFocus: '',
            userStatedGoals: [],
            lastUnresolvedThread: null,
          },
        });
        const formatted = formatContextForPrompt(bundle);
        expect(formatted).toContain('Resumption');
        expect(formatted).toContain('Just entered Stage 2');
        expect(formatted).toContain('without manufacturing unresolved tension');
      });

      it('renders milestone branch when sessionSummary is missing entirely', () => {
        const bundle = createMinimalBundle({
          conversationContext: {
            recentTurns: [],
            turnCount: 8,
            sessionDurationMinutes: 30,
            timeSinceLastUserTurnMs: 30 * HOUR,
          },
          stageContext: {
            stage: 1,
            gatesSatisfied: {},
          },
          // no sessionSummary
        });
        const formatted = formatContextForPrompt(bundle);
        expect(formatted).toContain('Resumption');
        expect(formatted).toContain('Just entered Stage 1');
      });

      it('formats short idle windows (24-35h) in hours', () => {
        const bundle = createMinimalBundle({
          conversationContext: {
            recentTurns: [],
            turnCount: 5,
            sessionDurationMinutes: 15,
            timeSinceLastUserTurnMs: 25 * HOUR,
          },
        });
        const formatted = formatContextForPrompt(bundle);
        expect(formatted).toContain('~25 hours');
      });

      it('formats longer gaps in days', () => {
        const bundle = createMinimalBundle({
          conversationContext: {
            recentTurns: [],
            turnCount: 5,
            sessionDurationMinutes: 15,
            timeSinceLastUserTurnMs: 72 * HOUR,
          },
        });
        const formatted = formatContextForPrompt(bundle);
        expect(formatted).toContain('3 days');
      });
    });
  });
});
