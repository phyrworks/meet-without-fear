import { E2EFixture } from './types';
import { FIXTURE_USER_IDS } from './ids';

/**
 * Test fixture for unit tests (flat-array responses format)
 */
export const flatArrayFixture: E2EFixture = {
  name: 'Flat Array Fixture',
  description: 'A test fixture using the flat-array responses format',

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
    {
      user: 'Hello',
      ai: `<thinking>
Mode: ONBOARDING
Intensity: 2
FeelHeardCheck: N
Strategy: Welcome user
</thinking>

Welcome to the session! I'm here to help you communicate better.
`,
    },
    {
      user: 'I want to invite my partner',
      ai: `<thinking>
Mode: INVITATION
Intensity: 3
FeelHeardCheck: N
Strategy: Offer invitation draft
</thinking>

I'd be happy to help you craft an invitation for your partner.

<draft>
Hi, I've been working on improving our communication and would love for you to join me in this conversation.
</draft>
`,
    },
  ],
};
