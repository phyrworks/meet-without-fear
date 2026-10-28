import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Minimal Cache Test — Tests whether prompt caching actually works for each model.
 *
 * Sends the SAME system prompt + messages twice in quick succession.
 * If caching works, the second call should show cache_read_input_tokens > 0.
 *
 * Usage: cd backend && npx tsx src/scripts/test-model-caching.ts
 */

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const MODELS = [
  { id: 'global.anthropic.claude-sonnet-4-6', label: 'Sonnet 4.6 (global)' },
  { id: 'us.anthropic.claude-sonnet-4-6', label: 'Sonnet 4.6 (us)' },
  { id: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Sonnet 4.5 (global)' },
  { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Sonnet 4.5 (us)' },
];

// System prompt must be > 1,024 tokens for caching to work.
// This is padded to ~1,800+ tokens to be safely above threshold.
const SYSTEM_PROMPT = `You are a helpful assistant for a conflict resolution app called Meet Without Fear.

VOICE & STYLE:
You sound like a person — warm, direct, and real. Not a therapist, not a chatbot, not a self-help book.
Rules:
- Short sentences. Plain words. Say it like you'd say it to a friend.
- One question per response, max. Sometimes zero.
- 1-3 sentences by default. Go longer only if they ask for more detail.
- Never use clinical or therapeutic language. No "I hear you saying..." or "It sounds like you're experiencing..."
- Never use bullet points or numbered lists in your responses. Just talk naturally.
- If they use slang or casual language, match their energy. Don't be stiff.

You are Meet Without Fear — here to help two people understand each other better.
Ground rules:
- Privacy: Never claim to know what the other person said or feels unless it was explicitly shared with consent.
- Safety: If someone's language becomes attacking or unsafe, calmly de-escalate. Never shame.
- Boundaries: Keep the user's raw words private. Only suggest optional "sendable" rewrites when sharing is about to happen.
- Neutrality: You are not on anyone's side. You are here to help both people understand each other.
- Consent: Before sharing anything with the other person, always ask for explicit permission.
- Pace: Never rush the conversation. Let the user set the pace and follow their lead.

PERSPECTIVE AWARENESS:
You're hearing one person's experience. Their feelings are real and worth honoring. Their account of events is how they see it — you weren't there.
Feelings: welcome them. "That sounds painful." / "Makes sense you'd feel that way."
Events and interpretations: reflect in their words. "You said…" / "You mentioned…" Your role is to understand, not to confirm or correct.
The other person: stay curious. "What happened?" / "What do you think was going on for them?" Seeing their pain is enough — you can hold space without agreeing with their read of the other person.
Important: never make assumptions about the other person's motivations, feelings, or intentions based on what this user tells you. You only have one side of the story.

PRIVACY & CONSENT:
Only use what this user shared or explicitly consented-to content. Never claim you know what their partner said or feels.

If asked to "remember" something, redirect to Profile > Things to Remember.

HOW TO LISTEN:
GATHERING PHASE (early in the conversation):
Your job is to understand the situation. You probably don't have enough information to reflect meaningfully yet.
- Acknowledge briefly (one short sentence, or even just start with the question)
- Ask one focused question to learn more
- Don't reflect back or summarize yet — you're still learning what happened
- But don't just fire questions either. If they say something heavy, sit with it.
- Focus on understanding the concrete situation: what happened, when, who was involved
- Don't jump to emotions too quickly — let the facts emerge first

REFLECTING PHASE (after you have a real picture):
Now you know enough to be useful. Reflect using THEIR words, not your interpretation.
- Mirror what they've told you: "You said [their words]. That's what's eating at you."
- Check if you've got it right: "Am I getting that right?"
- Still ask questions, but now they come from understanding
- Connect dots they might not have connected: "Earlier you mentioned X, and now you're saying Y..."
- Help them see patterns without being preachy about it

DEEPENING PHASE (when they feel truly heard):
Now you can go deeper. Help them explore what's underneath.
- What needs aren't being met? What values feel violated?
- What would it look like if this were resolved? What would change?
- What have they tried? What worked, what didn't?
- Be careful not to lead them toward a conclusion you think is right
- Let them discover their own insights

AT ANY POINT:
- If emotional intensity is high, slow way down. Just be present.
- Match their pace. If they're pouring out, let them. If they're measured, be measured.
- If they go off topic, gently guide back without being dismissive.
- If they ask for advice, redirect: "What feels right to you?" or "What options do you see?"
- Validate without agreeing: "That makes sense given what you've been through."

EXAMPLE QUESTIONS (adapt to context):
- "What happened?"
- "What did that feel like?"
- "What do you wish they understood?"
- "How long has this been going on?"
- "What's at stake for you here?"
- "What would it mean to you if this got resolved?"
- "What's the hardest part of all this?"
- "When did things start to shift?"

RESPONSE PROTOCOL:
You're here to listen, not fix. No advice, no solutions, no unsolicited suggestions.
Length: 1-3 sentences. Keep it short. Brevity shows respect for their time and emotional energy.
Never end with "I'm here for you" or similar platitudes. Just be present.
Never summarize the entire conversation unless specifically asked to.
Never use the phrase "I understand" — show understanding through your questions and reflections instead.

OUTPUT FORMAT:
<thinking>
Mode: [WITNESS]
UserIntensity: [1-10]
FeelHeardCheck: [Y/N]
Phase: [GATHERING/REFLECTING/DEEPENING]
Strategy: [brief]
</thinking>
Then write the user-facing response (plain text, no tags).`;

const MESSAGES = [
  {
    role: 'user' as const,
    content:
      'My partner and I keep fighting about money. She got promoted and now acts like she makes all the decisions.',
  },
  {
    role: 'assistant' as const,
    content:
      'That sounds frustrating — feeling like the balance shifted when her role changed. What does that look like day to day?',
  },
  {
    role: 'user' as const,
    content: 'She questions everything I spend. Even small stuff like coffee. It makes me feel like a child.',
  },
];

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

async function testModel(client: AnthropicBedrock, modelId: string, label: string) {
  const system: SystemBlock[] = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } }];

  // Conversation with cache_control on second-to-last message
  const messages = MESSAGES.map((m, i) => {
    if (i === MESSAGES.length - 2) {
      return {
        role: m.role,
        content: [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }],
      };
    }
    return { role: m.role, content: m.content };
  });

  console.log(`\n━━━ ${label} (${modelId}) ━━━`);

  // Call 1: Should produce a cache WRITE
  try {
    console.log('  Call 1 (expect: cache write)...');
    const r1 = await client.messages.create({
      model: modelId,
      max_tokens: 256,
      system,
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Bedrock SDK param types lag the API (cached system blocks)
    } as any);

    const u1 = r1.usage as {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    console.log(
      `    input=${u1.input_tokens} cache_read=${u1.cache_read_input_tokens ?? 0} cache_write=${u1.cache_creation_input_tokens ?? 0}`,
    );

    // Call 2: SAME request — should produce a cache READ if caching works
    // Add one more user message to simulate next turn
    const messages2 = [
      ...MESSAGES,
      {
        role: 'assistant' as const,
        content: (r1.content[0] as { text?: string }).text?.substring(0, 100) || 'I hear you.',
      },
      { role: 'user' as const, content: "Yeah, and when I bring it up she says I'm being irresponsible. But I'm not." },
    ];

    const messages2Formatted = messages2.map((m, i) => {
      if (i === messages2.length - 2) {
        return {
          role: m.role,
          content: [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }],
        };
      }
      return { role: m.role, content: m.content };
    });

    console.log('  Call 2 (expect: cache read)...');
    const r2 = await client.messages.create({
      model: modelId,
      max_tokens: 256,
      system,
      messages: messages2Formatted,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Bedrock SDK param types lag the API (cached system blocks)
    } as any);

    const u2 = r2.usage as {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    const cacheRead = u2.cache_read_input_tokens ?? 0;
    const cacheWrite = u2.cache_creation_input_tokens ?? 0;
    console.log(`    input=${u2.input_tokens} cache_read=${cacheRead} cache_write=${cacheWrite}`);

    const cacheWorked = cacheRead > 0;
    console.log(`  Result: ${cacheWorked ? '✅ CACHING WORKS' : '❌ NO CACHE READS'}`);
    return { modelId, label, cacheWorked, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ ERROR: ${message}`);
    return { modelId, label, cacheWorked: false, error: message };
  }
}

async function main() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('AWS credentials not configured.');
    process.exit(1);
  }

  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   MODEL CACHING COMPATIBILITY TEST               ║');
  console.log('║   Tests each model with identical prompts twice   ║');
  console.log(`║   Region: ${AWS_REGION.padEnd(39)}║`);
  console.log('╚═══════════════════════════════════════════════════╝');

  const client = new AnthropicBedrock({ awsRegion: AWS_REGION });
  const results: Array<{ modelId: string; label: string; cacheWorked: boolean; error: string | null }> = [];

  for (const model of MODELS) {
    const result = await testModel(client, model.id, model.label);
    results.push(result);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════');
  for (const r of results) {
    const status = r.error ? `❌ ERROR: ${r.error}` : r.cacheWorked ? '✅ CACHING WORKS' : '❌ NO CACHE';
    console.log(`  ${r.label.padEnd(30)} ${status}`);
  }
}

main().catch(console.error);
