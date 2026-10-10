import { E2EFixture } from './types';
import { FIXTURE_USER_IDS } from './ids';

export const reconcilerCircuitBreaker: E2EFixture = {
  name: 'Reconciler Circuit Breaker',
  description:
    'Partner journey where reconciler ALWAYS detects gaps (OFFER_SHARING), forcing refinement loop to continue until circuit breaker trips after 3 attempts. Subject shares context, guesser refines, reconciler re-runs with same OFFER_SHARING result, repeating until the 4th attempt when circuit breaker skips reconciler and forces READY.',

  seed: {
    users: [
      {
        id: FIXTURE_USER_IDS.userB,
        email: 'user-b@e2e.test',
        clerkId: 'e2e_clerk_user_b',
        name: 'Darryl Test',
      },
    ],
  },

  responses: [
    // ========================================
    // STAGE 0-1: Witnessing (Same as reconciler-refinement)
    // ========================================

    // Response 0: First witnessing exchange (response to first user message)
    {
      user: 'Things have been tense lately',
      ai: `<thinking>
Mode: WITNESSING
Intensity: 4
FeelHeardCheck: N
Strategy: Acknowledge and encourage sharing
</thinking>

I hear you - tension can be really draining. It takes courage to step into this conversation.

Can you tell me more about what's been happening? What does the tension feel like for you?
`,
    },

    // Response 1: Second witnessing exchange - deeper exploration
    {
      user: "I feel like we've just been miscommunicating",
      ai: `<thinking>
Mode: WITNESSING
Intensity: 5
FeelHeardCheck: N
Strategy: Reflect feelings and validate
</thinking>

Miscommunication can be really frustrating - like you're speaking different languages even though you want the same things.

What do you wish they could understand about how you're feeling?
`,
    },

    // Response 2: Third witnessing exchange
    {
      user: "I want them to know I still care, even when I'm stressed",
      ai: `<thinking>
Mode: WITNESSING
Intensity: 5
FeelHeardCheck: N
Strategy: Deep acknowledgment of care beneath stress
</thinking>

That's such an important feeling to name - that underneath the stress and tension, there's real care. Sometimes that gets lost in the day-to-day.

It sounds like you want them to see the love that's still there, even when things are hard.
`,
    },

    // Response 3: Feel-heard check trigger
    {
      user: 'Exactly. I just want us to be on the same page again',
      ai: `<thinking>
Mode: WITNESSING
Intensity: 6
FeelHeardCheck: Y
Strategy: Reflect deep understanding and check in
</thinking>

You're longing to reconnect - to get back to that sense of being a team. The care is there, and you want both of you to feel it again.

Before we continue, I want to check in with you: Do you feel like I understand what you've been going through?
`,
    },

    // ========================================
    // STAGE 2: Empathy Building
    // ========================================

    // Response 4: Post-feel-heard, transition to empathy building
    {
      user: 'Yes, I feel understood',
      ai: `<thinking>
Mode: TRANSITION
Intensity: 4
FeelHeardCheck: N
Strategy: Acknowledge and begin transitioning to empathy building
</thinking>

I'm glad you feel understood. That's an important foundation.

Now that we've explored your experience, I'd like to help you consider Shantam's perspective too. This isn't about excusing anything - it's about understanding. Sometimes when we can see where someone else is coming from, it opens new possibilities.

What do you think might be going on for Shantam?
`,
    },

    // Response 5: Building empathy - first attempt
    {
      user: 'I think they might be feeling frustrated too',
      ai: `<thinking>
Mode: EMPATHY_BUILDING
Intensity: 4
FeelHeardCheck: N
Strategy: Encourage deeper exploration of partner's perspective
</thinking>

That's a good starting point - recognizing that frustration might be going both ways.

Can you imagine what specifically might be frustrating for Shantam? What might they be experiencing in this situation?
`,
    },

    // Response 6: Deeper empathy building with ReadyShare: Y and draft
    {
      user: 'Maybe they feel like I pull away when stressed and they want to connect',
      ai: `<thinking>
Mode: EMPATHY_BUILDING
Intensity: 5
FeelHeardCheck: N
ReadyShare: Y
Strategy: Affirm empathy attempt and offer statement to share
</thinking>

That's a really insightful observation. You're seeing that Shantam might interpret your stress as distance, when really you're just overwhelmed. That awareness shows real empathy.

I've put together a statement that captures what you've been working on understanding:

<draft>
I realize that when I get stressed and pull away, it might feel like I'm pushing you away. That's not my intention at all - I still care deeply, even when I'm overwhelmed. I want us to find ways to stay connected even during stressful times.
</draft>

Does this capture what you'd like to express to them?
`,
    },
  ],

  // ============================================================================
  // OPERATIONS: Circuit Breaker Test - ALWAYS return OFFER_SHARING
  // ============================================================================
  // The circuit breaker operates at the runReconcilerForDirection level BEFORE
  // any fixture/AI call. So the fixture needs to return OFFER_SHARING consistently
  // for the first 3 attempts. On the 4th attempt, checkAttempts
  // returns shouldSkipReconciler=true and the reconciler never runs (fixture is
  // never consulted).
  operations: {
    'topic-frame-generate': {
      response: 'Household chores disagreement',
    },

    'topic-frame-confirm': {
      response: 'Household chores disagreement',
    },

    // Reconciler analysis - ALWAYS finds SIGNIFICANT gaps
    // This is identical to reconciler-refinement.ts BUT unlike that fixture,
    // we don't rely on hasContextAlreadyBeenShared guard to stop the loop.
    // Instead, the circuit breaker will stop it after 3 attempts.
    'reconciler-analysis': {
      response: {
        alignment: {
          score: 45,
          summary:
            "Shantam's empathy addresses surface-level tension but significantly misses the depth of exhaustion and feeling taken for granted that Darryl is experiencing at work.",
          correctlyIdentified: [
            'desire to reconnect',
            'frustration with miscommunication',
          ],
        },
        gaps: {
          severity: 'significant',
          summary:
            'Shantam does not grasp the profound impact of work stress on Darryl or how feeling unappreciated at work is affecting emotional capacity in the relationship.',
          missedFeelings: [
            'deep exhaustion from work',
            'feeling taken for granted at work',
            'emotional depletion affecting relationship capacity',
          ],
          misattributions: [],
          mostImportantGap: 'The depth of exhaustion and feeling taken for granted at work',
        },
        recommendation: {
          action: 'OFFER_SHARING',
          rationale:
            'Sharing about the work situation is crucial for Shantam to understand the full context of the emotional withdrawal.',
          sharingWouldHelp: true,
          suggestedShareFocus: 'The depth of exhaustion and feeling taken for granted at work',
        },
      },
    },

    // Share suggestion - generates draft if subject accepts
    'reconciler-share-suggestion': {
      response: {
        suggestedContent:
          "I need you to understand how drained I've been feeling at work. It's not just busy - it's this constant feeling of being taken for granted, like no matter how much I give, it's never seen or valued. I come home completely depleted, and I know that affects us. The exhaustion makes it hard to be emotionally present, even though I want to be.",
        reason:
          'Understanding the depth of work exhaustion and feeling unvalued will help them see why you sometimes pull away - not from lack of care, but from emotional depletion.',
      },
    },

    // Refine suggestion - used when guesser chooses to refine their empathy after receiving shared context
    'reconciler-refine-suggestion': {
      response: {
        refinedContent:
          "I can see now that it's not just about stress - you're carrying this deep exhaustion from work, where you feel taken for granted no matter how much you give. That depletion is real, and it affects your capacity to be emotionally present with me. I understand that when you pull away, it's not about us - it's about being completely drained. I want to support you through this and find ways we can both feel connected even when you're exhausted.",
      },
    },
  },
};
