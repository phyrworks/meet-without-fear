import { E2EFixture } from './types';
import { FIXTURE_USER_IDS } from './ids';

export const reconcilerNoGaps: E2EFixture = {
  name: 'Reconciler No Gaps',
  description:
    'Partner journey where reconciler finds no significant gaps - empathy proceeds without sharing suggestion',

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
    // Response 0: First witnessing exchange (response to first user message)
    // Note: The initial greeting uses a fallback message, so this is the first fixture response
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
    // This response triggers the feel-heard check UI
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
    // STAGE 2: Empathy Building (User B writes empathy about User A)
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

  // Operation-specific mock responses for non-streaming AI calls
  // These are used by the reconciler and other JSON-response operations
  operations: {
    'topic-frame-generate': {
      response: 'Household chores disagreement',
    },

    'topic-frame-confirm': {
      response: 'Household chores disagreement',
    },

    // Reconciler analysis - finds NO significant gaps, empathy proceeds normally
    'reconciler-analysis': {
      response: {
        alignment: {
          score: 85,
          summary:
            "Shantam's empathy accurately captures Darryl's feelings of wanting to reconnect and be understood despite the stress.",
          correctlyIdentified: [
            'desire to reconnect with partner',
            'frustration with miscommunication',
            'underlying care for the relationship',
            'wanting to be on the same team',
          ],
        },
        gaps: {
          severity: 'none',
          summary:
            "Shantam has demonstrated a strong understanding of Darryl's perspective. No significant gaps were identified.",
          missedFeelings: [],
          misattributions: [],
          mostImportantGap: null,
        },
        recommendation: {
          action: 'PROCEED',
          rationale:
            'The empathy attempt shows sufficient understanding. Both partners can proceed to reveal their perspectives to each other.',
          sharingWouldHelp: false,
          suggestedShareFocus: null,
        },
      },
    },

    // Needs extraction operation - returns 3 deterministic needs for User B
    'extract-needs': {
      response: {
        needs: [
          {
            category: 'CONNECTION',
            need: 'To feel emotionally connected despite stress',
            evidence: ["I want them to know I still care, even when I'm stressed"],
            aiConfidence: 0.87,
          },
          {
            category: 'UNDERSTANDING',
            need: 'To be understood when communicating',
            evidence: ["I feel like we've just been miscommunicating"],
            aiConfidence: 0.83,
          },
          {
            category: 'SAFETY',
            need: 'To feel safe and secure in the relationship',
            evidence: ['I just want us to be on the same page again'],
            aiConfidence: 0.8,
          },
        ],
      },
    },

    // Common ground operation - compatible with user-a-full-journey fixture
    'common-ground': {
      response: {
        commonGround: [
          {
            category: 'CONNECTION',
            need: 'Both partners want to feel connected and understood',
            insight: 'Despite the tension, both value the relationship and want to support each other',
          },
          {
            category: 'RECOGNITION',
            need: 'Both need to feel seen and appreciated',
            insight: 'Each partner wants acknowledgment for their contributions and efforts',
          },
        ],
      },
    },
  },
};
