import { E2EFixture } from './types';
import { FIXTURE_USER_IDS } from './ids';

export const userAFullJourney: E2EFixture = {
  name: 'User A Full Journey',
  description: 'Complete single user journey from session creation through empathy draft',

  seed: {
    users: [
      {
        id: FIXTURE_USER_IDS.userA,
        email: 'user-a@e2e.test',
        clerkId: 'e2e_clerk_user_a',
        name: 'Alice Test',
      },
    ],
  },

  responses: [
    // Response 0: Initial greeting (no panels)
    {
      user: "Hi, I'm having a conflict with my partner",
      ai: `<thinking>
Mode: ONBOARDING
Intensity: 3
FeelHeardCheck: N
Strategy: Welcome user and encourage them to share
</thinking>

Hi there. I'm glad you reached out. Conflicts with partners can be really difficult to navigate on your own. I'm here to listen and help you work through this.

What's been happening between you and your partner?
`,
    },

    // Response 1: Response with <draft> tag (triggers invitation panel)
    {
      user: 'We keep arguing about household chores',
      ai: `<thinking>
Mode: INVITATION_CRAFTING
Intensity: 4
FeelHeardCheck: N
Strategy: Acknowledge concern and offer invitation draft
</thinking>

That sounds frustrating. Disagreements about household responsibilities are one of the most common sources of conflict in relationships. It's good that you want to address this.

Would you like to invite your partner to join this conversation? I've prepared a message you could share with them:

<draft>
Hey, I've been thinking about how we can better divide household tasks. I found this app that helps couples have productive conversations. Would you be open to trying it with me? It might help us understand each other better.
</draft>
`,
    },

    // Response 2: Post-invitation response
    {
      user: 'Thanks, I sent the invitation',
      ai: `<thinking>
Mode: WITNESSING
Intensity: 3
FeelHeardCheck: N
Strategy: Acknowledge and continue exploring their perspective
</thinking>

That's a great step. While we wait for your partner, let's continue exploring your perspective.

Can you tell me more about what specifically bothers you about the chore situation? What does it feel like when the disagreement happens?
`,
    },

    // Response 3: Response with FeelHeardCheck: Y in <thinking> tag
    {
      user: "I feel like I do most of the work and they don't notice or appreciate it",
      ai: `<thinking>
Mode: WITNESSING
Intensity: 5
FeelHeardCheck: Y
Strategy: Reflect feelings deeply before checking if they feel heard
</thinking>

I really hear you. Feeling unappreciated for the work you put in is exhausting and lonely. It's not just about the chores themselves - it sounds like you're longing to be seen and valued by your partner.

That desire to be acknowledged is completely valid. Before we continue, I want to check in: do you feel like I understand what you've been experiencing?
`,
    },

    // Response 4: Post-feel-heard response
    {
      user: 'Yes, I feel heard now',
      ai: `<thinking>
Mode: TRANSITION
Intensity: 4
FeelHeardCheck: N
Strategy: Acknowledge and begin transitioning to empathy building
</thinking>

I'm glad you feel heard. That's really important.

Now that we've explored your experience, I'd like to help you build some understanding of your partner's perspective too. This isn't about excusing anything - it's about understanding. Sometimes when we can see where someone else is coming from, it opens up new possibilities for connection.

What do you think might be going on for your partner?
`,
    },

    // Response 5: Response with <draft> tag and ReadyShare: Y (triggers empathy panel)
    {
      user: 'I guess they might be stressed from work too',
      ai: `<thinking>
Mode: EMPATHY_BUILDING
Intensity: 4
FeelHeardCheck: N
ReadyShare: Y
Strategy: Affirm empathy attempt and offer empathy statement to share
</thinking>

That's a really thoughtful observation. Recognizing that your partner might also be carrying stress shows real empathy on your part.

I've put together a statement that captures what you've been working on understanding. When you're ready, you could share this with your partner:

<draft>
I've been doing some reflecting. I realize that while I've been feeling overwhelmed with household tasks, you might also be dealing with a lot of stress from work. I want us to find a way to support each other better. Can we talk about how we're both feeling and figure this out together?
</draft>

Does this capture what you'd like to express to them?
`,
    },
    // Response 6: Refine empathy after receiving privacy-protected shared context.
    {
      user: 'I can see now how exhausted and unappreciated they have been feeling at work',
      ai: `<thinking>
Mode: EMPATHY_BUILDING
Intensity: 4
FeelHeardCheck: N
ReadyShare: Y
Strategy: Integrate the newly shared context into a revised empathy statement
</thinking>

That new context adds an important layer to what you understand about their experience.

<draft>
I can see now that the stress you are carrying is not just about being busy. You have been feeling deeply exhausted and unappreciated at work, and that depletion makes it harder to be emotionally present even though you still care about us. I want to understand that strain and support you without treating your need for space as rejection.
</draft>

Does this revised understanding capture what you want to share?
`,
    },
  ],

  // Operation-specific mock responses for non-streaming AI calls (Stage 3-4)
  operations: {
    'topic-frame-generate': {
      response: 'Household chores disagreement',
    },

    'topic-frame-confirm': {
      response: 'Household chores disagreement',
    },

    // Needs extraction operation - returns 3 deterministic needs for User A
    'extract-needs': {
      response: {
        needs: [
          {
            category: 'RECOGNITION',
            need: 'To have my efforts seen and appreciated',
            evidence: ["I feel like I do most of the work and they don't notice or appreciate it"],
            aiConfidence: 0.88,
          },
          {
            category: 'CONNECTION',
            need: 'To feel like we are partners working together',
            evidence: ['I want us to find a way to support each other better'],
            aiConfidence: 0.82,
          },
          {
            category: 'BALANCE',
            need: 'For household responsibilities to be shared fairly',
            evidence: ['We keep arguing about household chores'],
            aiConfidence: 0.85,
          },
        ],
      },
    },

    // Common ground operation - compatible with reconciler-no-gaps fixture
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
