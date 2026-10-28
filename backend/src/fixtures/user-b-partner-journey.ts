import { E2EFixture } from './types';
import { FIXTURE_USER_IDS } from './ids';

export const userBPartnerJourney: E2EFixture = {
  name: 'User B Partner Journey',
  description: 'Partner journey from invitation acceptance through Stage 1 feel-heard check',

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
      user: "I feel like they don't see how much I'm dealing with",
      ai: `<thinking>
Mode: WITNESSING
Intensity: 5
FeelHeardCheck: N
Strategy: Reflect feelings and validate
</thinking>

That sounds really hard - feeling unseen while carrying a lot. It's a lonely place to be in a relationship.

What do you wish they could understand about what you're going through?
`,
    },

    // Response 2: Third witnessing exchange
    {
      user: "I work so hard and come home exhausted, but there's always more to do",
      ai: `<thinking>
Mode: WITNESSING
Intensity: 5
FeelHeardCheck: N
Strategy: Deep acknowledgment of exhaustion and burden
</thinking>

That exhaustion you're describing - carrying the weight of work and then coming home to more - it sounds overwhelming. You're running on empty and still trying to show up.

That's a lot to hold. How long have you been feeling this way?
`,
    },

    // Response 3: Feel-heard check trigger
    // This response triggers the feel-heard check UI
    {
      user: "Months now. I don't know how to get through to them",
      ai: `<thinking>
Mode: WITNESSING
Intensity: 6
FeelHeardCheck: Y
Strategy: Reflect deep understanding and check in
</thinking>

Months of feeling depleted and unheard - that's a heavy burden. You've been carrying this alone, wanting desperately to connect but not knowing how to bridge the gap.

Before we continue, I want to check in with you: Do you feel like I understand what you've been going through?
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

    // Reconciler analysis - finds significant gaps so we can test the share suggestion flow
    'reconciler-analysis': {
      response: {
        alignment: {
          score: 45,
          summary:
            "Shantam's empathy attempt captures some surface-level frustration but misses the deeper exhaustion and feeling of being unseen that Darryl expressed.",
          correctlyIdentified: ['frustration with the relationship', 'desire for change'],
        },
        gaps: {
          severity: 'significant',
          summary:
            'Shantam focused primarily on conflict dynamics but missed the underlying feelings of exhaustion, being unseen at work and home, and the loneliness of carrying burdens alone.',
          missedFeelings: [
            'deep exhaustion from work demands',
            'feeling unseen and unappreciated',
            'loneliness of carrying burdens alone',
            'hopelessness about communication',
          ],
          misattributions: ['assumed anger when the primary emotion was exhaustion'],
          mostImportantGap:
            'Darryl feels profoundly exhausted and unseen - not just frustrated. This distinction matters for true understanding.',
        },
        recommendation: {
          action: 'OFFER_SHARING',
          rationale:
            "There is a significant gap between what Shantam guessed and what Darryl actually shared. Sharing more context would help Shantam understand the depth of Darryl's exhaustion.",
          sharingWouldHelp: true,
          suggestedShareFocus: 'The exhaustion from work and the feeling of being unseen despite all the effort.',
        },
      },
    },

    // Share suggestion for Darryl to help Shantam understand
    'reconciler-share-suggestion': {
      response: {
        suggestedContent:
          "I feel like I'm running on empty - exhausted from work every day, and then coming home to more tasks. What I really need is for someone to see how hard I'm trying, even when I don't have anything left to give.",
        reason:
          "This helps Shantam understand that Darryl's frustration comes from exhaustion and feeling unseen, not anger or blame.",
      },
    },
  },
};
