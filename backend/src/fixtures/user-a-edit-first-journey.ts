/**
 * User A — pre-join draft, partner joins, "Edit first" (work-9309).
 *
 * The user-a-full-journey storyline up to the empathy draft (responses 0-5),
 * then the revision after Edit first:
 *   - operation `prejoin-edit-first-opener`: the AI's opener (it speaks first;
 *     not an indexed chat response — it answers no user message).
 *     `{{writtenAt}}` is replaced with the day phrase ("earlier today").
 *   - response 6: A's first reply after the opener; the AI proposes the
 *     revised statement (ReadyShare: Y + <draft>), which A then reviews and
 *     shares through the normal Review/Share flow.
 */

import { E2EFixture } from './types';
import { userAFullJourney } from './user-a-full-journey';

export const userAEditFirstJourney: E2EFixture = {
  name: 'User A Edit First Journey',
  description: 'Solo inviter drafts before the join, chooses Edit first after it, revises with the AI, then shares',

  seed: userAFullJourney.seed,

  responses: [
    ...(userAFullJourney.responses ?? []).slice(0, 6),

    // Response 6: the reply after the opener — the revised statement.
    {
      user: "Reading it now, I made it about the chores. I think they're just worn out and scared of letting me down.",
      ai: `<thinking>
Mode: BUILDING
Intensity: 4
FeelHeardCheck: N
ReadyShare: Y
Strategy: Reflect what shifted on rereading and offer the revised statement for review
</thinking>

That's a real shift — from the chores themselves to what might be underneath them for your partner.

<draft>
I think you might be worn out, and maybe scared that you're letting me down. When I talk about the chores, it might land as one more way you're falling short. I want to understand what this has been like for you.
</draft>

I've put together a revised draft for you to review when you're ready.
`,
    },
  ],

  operations: {
    ...userAFullJourney.operations,
    'prejoin-edit-first-opener': {
      response:
        "Here's what you wrote {{writtenAt}}, before your partner joined. Nothing has been sent. Reading it now, what feels different?",
    },
  },
};
