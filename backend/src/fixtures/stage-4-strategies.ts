import { E2EFixture } from './types';
import { FIXTURE_USER_IDS } from './ids';

export const stage4Strategies: E2EFixture = {
  name: 'Stage 4 Strategies',
  description:
    'Deterministic AI responses for strategic repair testing in Stage 4. Includes chat responses for Stages 0-3 setup via SessionBuilder.',

  seed: {
    users: [
      {
        id: FIXTURE_USER_IDS.stage4,
        email: 'stage4@e2e.test',
        clerkId: 'e2e_clerk_stage4',
        name: 'Stage4 User',
      },
    ],
  },

  responses: [
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

Now that we've explored your experience, I'd like to help you consider your partner's perspective too. This isn't about excusing anything - it's about understanding. Sometimes when we can see where someone else is coming from, it opens new possibilities.

What do you think might be going on for them?
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

Can you imagine what specifically might be frustrating for them? What might they be experiencing in this situation?
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

That's a really insightful observation. You're seeing that your partner might interpret your stress as distance, when really you're just overwhelmed. That awareness shows real empathy.

I've put together a statement that captures what you've been working on understanding:

<draft>
I realize that when I get stressed and pull away, it might feel like I'm pushing you away. That's not my intention at all - I still care deeply, even when I'm overwhelmed. I want us to find ways to stay connected even during stressful times.
</draft>

Does this capture what you'd like to express to them?
`,
    },
  ],

  // Operation-specific mock responses for non-streaming AI calls
  operations: {
    'topic-frame-generate': {
      response: 'Household chores disagreement',
    },

    'topic-frame-confirm': {
      response: 'Household chores disagreement',
    },

    // Needs extraction operation - returns 3 deterministic needs
    'extract-needs': {
      response: {
        needs: [
          {
            category: 'CONNECTION',
            need: 'To feel emotionally connected and understood',
            evidence: ['I just want to feel like we are on the same team'],
            aiConfidence: 0.85,
          },
          {
            category: 'RECOGNITION',
            need: 'To have efforts acknowledged and appreciated',
            evidence: ['It feels like nothing I do is ever enough'],
            aiConfidence: 0.78,
          },
          {
            category: 'SAFETY',
            need: 'To feel safe expressing feelings without conflict',
            evidence: ['I am afraid to bring things up because it always turns into a fight'],
            aiConfidence: 0.82,
          },
        ],
      },
    },

    // Common ground operation - returns 2 common ground items
    'common-ground': {
      response: {
        commonGround: [
          {
            category: 'CONNECTION',
            need: 'Both partners value emotional connection and want to feel like a team',
            insight: 'While expressed differently, both seek the same underlying closeness',
          },
          {
            category: 'SAFETY',
            need: 'Both need to feel safe being vulnerable in conversations',
            insight: 'The fear of conflict is shared - both want discussions to feel constructive',
          },
        ],
      },
    },
  },
};
