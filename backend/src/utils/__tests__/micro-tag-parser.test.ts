import { parseMicroTagResponse } from '../micro-tag-parser';

describe('micro-tag-parser', () => {
  describe('parseMicroTagResponse', () => {
    it('extracts thinking block content', () => {
      const raw = `<thinking>
Mode:Witness | Intensity:8 | FeelHeardCheck:Y | Strategy:Validate
</thinking>

I hear you. That sounds really difficult.`;

      const result = parseMicroTagResponse(raw);

      expect(result.thinking).toContain('Mode:Witness');
      expect(result.thinking).toContain('FeelHeardCheck:Y');
    });

    it('parses one singular Stage 3 need tag', () => {
      const raw = `<thinking>Mode: NEEDS</thinking>
<need>{"need":"to feel taken seriously","category":"RECOGNITION","description":"I need to feel taken seriously when I raise concerns.","evidence":["taken seriously"]}</need>
That feels important enough to hold onto.`;

      const result = parseMicroTagResponse(raw);

      expect(result.proposedNeed).toEqual({
        need: 'to feel taken seriously',
        category: 'RECOGNITION',
        description: 'I need to feel taken seriously when I raise concerns.',
        evidence: ['taken seriously'],
      });
      expect(result.proposedNeeds).toEqual([]);
      expect(result.needParseError).toBeNull();
      expect(result.response).toBe('That feels important enough to hold onto.');
    });

    it('parses one Stage 3 need-action refine tag', () => {
      const raw = `<thinking>Mode: NEEDS</thinking>
<need-action type="refine" supersedes="need-old">{"need":"to feel respected","category":"RECOGNITION","description":"I need to feel respected in hard conversations.","evidence":["respected"]}</need-action>
That version is clearer.`;

      const result = parseMicroTagResponse(raw);

      expect(result.needAction).toEqual({
        type: 'refine',
        supersedes: 'need-old',
        need: 'to feel respected',
        category: 'RECOGNITION',
        description: 'I need to feel respected in hard conversations.',
        evidence: ['respected'],
      });
      expect(result.needParseError).toBeNull();
      expect(result.response).toBe('That version is clearer.');
    });

    it('rejects multiple Stage 3 need tags in one turn', () => {
      const raw = `<thinking>Mode: NEEDS</thinking>
<need>{"need":"one","category":"SAFETY","description":"one","evidence":[]}</need>
<need>{"need":"two","category":"CONNECTION","description":"two","evidence":[]}</need>
I found two.`;

      const result = parseMicroTagResponse(raw);

      expect(result.proposedNeed).toBeNull();
      expect(result.needAction).toBeNull();
      expect(result.needParseError).toBe('Only one <need> or <need-action> tag is allowed per turn.');
    });

    it('extracts clean response text without tags', () => {
      const raw = `<thinking>
Mode:Witness | FeelHeardCheck:N
</thinking>

I hear you. That sounds really difficult.`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe('I hear you. That sounds really difficult.');
      expect(result.response).not.toContain('<thinking>');
    });

    it('extracts FeelHeardCheck:Y as true', () => {
      const raw = `<thinking>FeelHeardCheck:Y</thinking>Response text`;
      const result = parseMicroTagResponse(raw);
      expect(result.offerFeelHeardCheck).toBe(true);
    });

    it('extracts and strips visible XML feel-heard control tags', () => {
      const raw = `<feel_heard_check>Y</feel_heard_check>

That sounds exhausting to keep carrying.`;

      const result = parseMicroTagResponse(raw);

      expect(result.offerFeelHeardCheck).toBe(true);
      expect(result.response).toBe('That sounds exhausting to keep carrying.');
      expect(result.response).not.toContain('feel_heard_check');
    });

    it('extracts and strips dashed XML ready-share control tags', () => {
      const raw = `<ready-share>Y</ready-share>
<draft>I think you might feel alone here.</draft>
I've prepared a draft for you to review.`;

      const result = parseMicroTagResponse(raw);

      expect(result.offerReadyToShare).toBe(true);
      expect(result.draft).toBe('I think you might feel alone here.');
      expect(result.response).toBe("I've prepared a draft for you to review.");
      expect(result.response).not.toContain('ready-share');
    });

    it('extracts FeelHeardCheck:N as false', () => {
      const raw = `<thinking>FeelHeardCheck:N</thinking>Response text`;
      const result = parseMicroTagResponse(raw);
      expect(result.offerFeelHeardCheck).toBe(false);
    });

    it('extracts ReadyShare:Y as true', () => {
      const raw = `<thinking>ReadyShare:Y</thinking>Response text`;
      const result = parseMicroTagResponse(raw);
      expect(result.offerReadyToShare).toBe(true);
    });

    it('extracts <draft> as topicFrame for Stage 0 callers', () => {
      const raw = `<thinking>Mode:ONBOARDING</thinking>

<draft>
Mealtime poking
</draft>

How does that framing land?`;

      const result = parseMicroTagResponse(raw);

      expect(result.topicFrame).toBe('Mealtime poking');
      expect(result.draft).toBe('Mealtime poking');
      expect(result.response).toBe('How does that framing land?');
      expect(result.response).not.toContain('<draft>');
    });

    it('topicFrame is null when no <draft> tag is present', () => {
      const raw = `<thinking>Mode:ONBOARDING</thinking>What's been going on?`;
      const result = parseMicroTagResponse(raw);
      expect(result.topicFrame).toBeNull();
      expect(result.draft).toBeNull();
    });

    it('extracts draft block content (used for empathy in stage 2)', () => {
      const raw = `<thinking>Mode:Empathy</thinking>

<draft>
You feel unseen when I get distracted at meals.
</draft>

Here's a draft for you to review.`;

      const result = parseMicroTagResponse(raw);

      expect(result.draft).toContain('You feel unseen');
      expect(result.response).toBe("Here's a draft for you to review.");
      expect(result.response).not.toContain('<draft>');
    });

    it('extracts dispatch tag', () => {
      const raw = `<thinking>User asking about process</thinking>

<dispatch>EXPLAIN_PROCESS</dispatch>

Let me explain how this works.`;

      const result = parseMicroTagResponse(raw);

      expect(result.dispatchTag).toBe('EXPLAIN_PROCESS');
    });

    it('extracts proposed needs from a hidden needs JSON block', () => {
      const raw = `<thinking>NeedsReady:Y</thinking>

<needs>
[
  {
    "need": "safety",
    "category": "SAFETY",
    "description": "I need steadiness before deciding what comes next.",
    "evidence": ["I feel scared when things escalate"]
  },
  {
    "need": "recognition",
    "category": "RECOGNITION",
    "description": "I need my effort to be seen.",
    "evidence": []
  }
]
</needs>

I captured a draft of what matters to you for review.`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe('I captured a draft of what matters to you for review.');
      expect(result.response).not.toContain('<needs>');
      expect(result.proposedNeeds).toEqual([
        {
          need: 'safety',
          category: 'SAFETY',
          description: 'I need steadiness before deciding what comes next.',
          evidence: ['I feel scared when things escalate'],
        },
        {
          need: 'recognition',
          category: 'RECOGNITION',
          description: 'I need my effort to be seen.',
          evidence: [],
        },
      ]);
    });

    it('ignores malformed needs JSON and still strips the hidden block', () => {
      const raw = `<thinking>NeedsReady:Y</thinking>
<needs>{not valid json</needs>
Let's keep exploring what matters most.`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe("Let's keep exploring what matters most.");
      expect(result.proposedNeeds).toEqual([]);
    });

    it('handles response with no tags gracefully', () => {
      const raw = 'Just a plain response with no tags.';
      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe('Just a plain response with no tags.');
      expect(result.thinking).toBe('');
      expect(result.draft).toBeNull();
      expect(result.dispatchTag).toBeNull();
    });

    it('handles malformed thinking tags', () => {
      const raw = `<thinking>Incomplete

Response without closing tag.`;

      const result = parseMicroTagResponse(raw);
      // Should return raw text as response when tags are malformed
      expect(result.response).toBeTruthy();
    });

    it('strips a leaked update_session_state tool-call XML block from the response', () => {
      const raw = `<tool_calls>
<invoke name="update_session_state">
<parameter name="mode">ONBOARDING</parameter>
<parameter name="ready_share">false</parameter>
<parameter name="draft_topic"></parameter>
<parameter name="memory_items">[]</parameter>
</invoke>
</tool_calls>

Hey Shantam. First, let's write a short topic for Darryl so they know what this is about. What's going on?`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe(
        "Hey Shantam. First, let's write a short topic for Darryl so they know what this is about. What's going on?",
      );
      expect(result.response).not.toContain('<tool_calls>');
      expect(result.response).not.toContain('<invoke');
      expect(result.response).not.toContain('update_session_state');
    });

    it('strips multiple tag types from response', () => {
      const raw = `<thinking>Analysis here</thinking>

<draft>Draft content</draft>

<needs>[{"need":"Safety","category":"SAFETY","description":"To feel safe enough to speak","evidence":["I shut down"]}]</needs>

<dispatch>SOME_TAG</dispatch>

The actual response.`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe('The actual response.');
    });

    it('extracts structured Stage 3 needs from hidden needs tag', () => {
      const raw = `<thinking>Mode: NEEDS</thinking>
<needs>
[
  {
    "need": "Safety",
    "category": "SAFETY",
    "description": "To feel safe enough to say what is true",
    "evidence": ["I shut down when it gets loud"]
  }
]
</needs>
Here is what I am hearing matters most.`;

      const result = parseMicroTagResponse(raw);

      expect(result.proposedNeeds).toEqual([
        {
          need: 'Safety',
          category: 'SAFETY',
          description: 'To feel safe enough to say what is true',
          evidence: ['I shut down when it gets loud'],
        },
      ]);
      expect(result.response).toBe('Here is what I am hearing matters most.');
    });

    it('drops malformed needs instead of exposing hidden needs JSON', () => {
      const raw = `<thinking>Mode: NEEDS</thinking>
<needs>[{"need":"Fix them","category":"NOT_A_CATEGORY","description":"Make them stop","evidence":[]}]</needs>
Visible response.`;

      const result = parseMicroTagResponse(raw);

      expect(result.proposedNeeds).toEqual([]);
      expect(result.response).toBe('Visible response.');
      expect(result.response).not.toContain('<needs>');
    });

    it('strips legacy needs_ready payloads from visible response text', () => {
      const raw = `<thinking>Mode: WITNESS</thinking>
<needs_ready>
{
  "core_needs": ["To know whether change is possible"],
  "boundary": "Reacting to volatility is not the same as causing it"
}
</needs_ready>
Okay. You're clear on what you need.`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe("Okay. You're clear on what you need.");
      expect(result.response).not.toContain('<needs_ready>');
      expect(result.response).not.toContain('core_needs');
      expect(result.proposedNeeds).toEqual([]);
    });

    it('handles whitespace variations in flag extraction', () => {
      const raw = `<thinking>FeelHeardCheck: Y</thinking>Response`;
      const result = parseMicroTagResponse(raw);
      expect(result.offerFeelHeardCheck).toBe(true);
    });

    it('is case-insensitive for flag extraction', () => {
      const raw = `<thinking>feelheardcheck:y</thinking>Response`;
      const result = parseMicroTagResponse(raw);
      expect(result.offerFeelHeardCheck).toBe(true);
    });

    it('extracts ReadyShare:N as false', () => {
      const raw = `<thinking>ReadyShare:N</thinking>Response text`;
      const result = parseMicroTagResponse(raw);
      expect(result.offerReadyToShare).toBe(false);
    });

    it('strips visible ProposedStrategy lines while preserving extracted strategies', () => {
      const raw = `<thinking>Mode:STRATEGIC_REPAIR | StrategyProposed:Y</thinking>
ProposedStrategy: Ceramics class on Tuesday evenings for eight weeks
ProposedStrategy: Sunday morning walk, 45 minutes, once a week for four weeks
That's solid. Which one feels easiest to start with?`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe("That's solid. Which one feels easiest to start with?");
      expect(result.response).not.toContain('ProposedStrategy:');
      expect(result.proposedStrategies).toEqual([
        'Ceramics class on Tuesday evenings for eight weeks',
        'Sunday morning walk, 45 minutes, once a week for four weeks',
      ]);
    });

    it('does not treat follow-up timing as a rankable strategy', () => {
      const raw = `<thinking>
StrategyProposed:Y
ProposedStrategy: Ceramics class on Tuesday evenings for eight weeks
ProposedStrategy: Follow-up check-in after eight weeks
</thinking>
That gives you a concrete experiment and a time to revisit it.`;

      const result = parseMicroTagResponse(raw);

      expect(result.proposedStrategies).toEqual(['Ceramics class on Tuesday evenings for eight weeks']);
    });

    it('extracts typed Stage 4 proposal classifications from a hidden block', () => {
      const raw = `<thinking>Mode:REPAIR | StrategyProposed:N</thinking>
<stage4_proposals>
[
  {
    "action": "ADD",
    "targetProposalId": null,
    "classification": "PROPOSAL",
    "description": "This Friday, one quiet conversation without the kids in the room",
    "kind": "SHARED_PROPOSAL",
    "ownerUserId": null,
    "needsAddressed": ["clarity"],
    "duration": "Friday evening",
    "measureOfSuccess": "They leave with an actual answer"
  },
  {
    "action": "IGNORE",
    "targetProposalId": null,
    "classification": "SUCCESS_MARKER",
    "description": "I would walk away knowing where I stand",
    "kind": null,
    "ownerUserId": null
  }
]
</stage4_proposals>
That gives this a clearer shape.`;

      const result = parseMicroTagResponse(raw);

      expect(result.response).toBe('That gives this a clearer shape.');
      expect(result.response).not.toContain('stage4_proposals');
      expect(result.stage4ProposalBlockPresent).toBe(true);
      expect(result.stage4Proposals).toEqual([
        {
          action: 'ADD',
          classification: 'PROPOSAL',
          description: 'This Friday, one quiet conversation without the kids in the room',
          kind: 'SHARED_PROPOSAL',
          needsAddressed: ['clarity'],
          duration: 'Friday evening',
          measureOfSuccess: 'They leave with an actual answer',
        },
        {
          action: 'IGNORE',
          classification: 'SUCCESS_MARKER',
          description: 'I would walk away knowing where I stand',
        },
      ]);
    });

    it('defaults flags to false when not present', () => {
      const raw = `<thinking>Just some analysis</thinking>Response`;
      const result = parseMicroTagResponse(raw);
      expect(result.offerFeelHeardCheck).toBe(false);
      expect(result.offerReadyToShare).toBe(false);
      expect(result.stage4ProposalBlockPresent).toBe(false);
    });

    it('ignores FeelHeardConfirmed flag (feel-heard confirmation is button-only)', () => {
      const raw = `<thinking>
Mode: WITNESS
FeelHeardCheck:Y
FeelHeardConfirmed:Y
</thinking>
Let's move into the next part.`;

      const result = parseMicroTagResponse(raw);

      expect(result.offerFeelHeardCheck).toBe(true);
      expect(result).not.toHaveProperty('feelHeardConfirmed');
    });

    it('trims whitespace from draft content', () => {
      const raw = `<thinking>test</thinking>
<draft>

  Draft with whitespace

</draft>
Response`;
      const result = parseMicroTagResponse(raw);
      expect(result.draft).toBe('Draft with whitespace');
    });

    it('trims whitespace from dispatch tag', () => {
      const raw = `<thinking>test</thinking>
<dispatch>  EXPLAIN_PROCESS  </dispatch>
Response`;
      const result = parseMicroTagResponse(raw);
      expect(result.dispatchTag).toBe('EXPLAIN_PROCESS');
    });

    it('trims leading newlines after thinking block removal', () => {
      // This is the real-world format: thinking block followed by newlines then response
      const raw = `<thinking>
Mode: WITNESS
Intensity: 7
FeelHeardCheck: N
Strategy: Validate their feelings
</thinking>

I hear how difficult this has been for you.`;

      const result = parseMicroTagResponse(raw);

      // Response should NOT start with newline
      expect(result.response).not.toMatch(/^\n/);
      expect(result.response).toBe('I hear how difficult this has been for you.');
    });

    it('trims multiple leading newlines after tag removal', () => {
      const raw = `<thinking>Analysis</thinking>



Response after multiple newlines.`;

      const result = parseMicroTagResponse(raw);
      expect(result.response).toBe('Response after multiple newlines.');
    });

    it('returns empty response (no placeholder) when content is entirely inside thinking', () => {
      // Regression: previously returned "[AI processing — please continue the conversation]"
      // which was then saved as the user-facing message. Caller should see empty and decide.
      const raw = `<thinking>Mode:Witness | FeelHeardCheck:N</thinking>`;
      const result = parseMicroTagResponse(raw);
      expect(result.response).toBe('');
      expect(result.thinking).toContain('Mode:Witness');
    });

    it('returns empty response (no placeholder) when only dispatch tag is present', () => {
      // This is the exact shape that caused the "[AI processing...]" message in prod:
      // model emitted <thinking>...</thinking><dispatch>TAG</dispatch> with no visible text.
      const raw = `<thinking>User asking for impasse handling</thinking>\n<dispatch>HANDLE_DENIAL_IMPASSE</dispatch>`;
      const result = parseMicroTagResponse(raw);
      expect(result.response).toBe('');
      expect(result.dispatchTag).toBe('HANDLE_DENIAL_IMPASSE');
    });

    it('returns empty response (no placeholder) when only draft is present', () => {
      const raw = `<thinking>Mode:Empathy</thinking>\n<draft>A proposed empathy statement.</draft>`;
      const result = parseMicroTagResponse(raw);
      expect(result.response).toBe('');
      expect(result.draft).toBe('A proposed empathy statement.');
    });

    it('extracts Stage 4 walkthrough action and strips it from visible response', () => {
      const raw = `<thinking>Mode: REPAIR</thinking>
<stage4_walkthrough>
{ "action": "SKIP", "needId": "need-2", "reason": "User wants to leave this aside for now." }
</stage4_walkthrough>
Okay, we can leave that one for now.`;

      const result = parseMicroTagResponse(raw);

      expect(result.stage4WalkthroughAction).toEqual({
        action: 'SKIP',
        needId: 'need-2',
        reason: 'User wants to leave this aside for now.',
      });
      expect(result.response).toBe('Okay, we can leave that one for now.');
    });
  });
});
