/**
 * Dispatch Handler
 *
 * Handles off-ramp dispatch tags from the AI.
 * When the AI outputs <dispatch>TAG</dispatch>, this handler
 * hijacks the response to provide specialized, contextual answers
 * for specific scenarios like explaining the process.
 */

import { logger } from '../lib/logger';
import { getSonnetResponse, BrainActivityCallType } from '../lib/bedrock';

export type DispatchTag = 'EXPLAIN_PROCESS' | 'EXPLAIN_EMPATHY_PURPOSE' | 'HANDLE_MEMORY_REQUEST' | string; // Allow unknown tags

export interface DispatchContext {
  /** The user's current message */
  userMessage: string;
  /** Recent conversation history */
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** User's first name */
  userName?: string;
  /** Partner's name */
  partnerName?: string;
  /** Session ID for logging */
  sessionId: string;
  /** Turn ID for logging */
  turnId: string;
  /** Current stage (0=invitation, 1=witness, 2=perspective, 3=needs, 4=repair) */
  currentStage?: number;
  /** Whether the invitation has been sent */
  invitationSent?: boolean;
  /** Whether the partner has joined the session */
  partnerJoined?: boolean;
}

/**
 * Build system prompt for process explanation, including session state context.
 */
function buildProcessExplainerPrompt(context: DispatchContext): string {
  const { userName, partnerName, currentStage, invitationSent, partnerJoined } = context;

  // Build state context section
  let stateContext = '';
  if (invitationSent && !partnerJoined) {
    stateContext = `\nCURRENT STATE: ${userName || 'The user'} has already sent an invitation to ${partnerName || 'the other person'}. They're waiting for ${partnerName || 'them'} to accept and join the conversation IN THIS APP. The conversation will happen here, not separately.`;
  } else if (partnerJoined) {
    stateContext = `\nCURRENT STATE: Both ${userName || 'the user'} and ${partnerName || 'the other person'} are participating in the process. They're in Stage ${currentStage || 1}.`;
  } else if (currentStage === 0) {
    stateContext = `\nCURRENT STATE: ${userName || 'The user'} is crafting an invitation to send to ${partnerName || 'the other person'}.`;
  }

  return `You are a warm, knowledgeable guide helping someone understand how Meet Without Fear works.

CRITICAL: Meet Without Fear is an IN-APP guided conversation platform. When someone accepts an invitation, they join the conversation THROUGH THIS APP - not in person or elsewhere. The entire process happens here with AI facilitation.
${stateContext}

THE PROCESS:

**Getting Started**
You craft a brief invitation message and share a link. When they accept, they join THIS APP and go through the same process on their side.

**Stage 1 - Feel Heard**
Each person gets private time with the AI to share what's on their mind. Deep listening, reflection, feeling understood. This continues until you confirm you feel heard.

**Stage 2 - Perspective Stretch**
You imagine what the other person might be experiencing. You craft an empathy statement that gets shared with them (with your consent). They do the same for you.

**Stage 3 - What Matters**
Explore what truly matters to each of you - in terms of your own needs, not what's wrong with the other person.

**Stage 4 - Strategic Repair**
Design small testable experiments - specific things to try that address both people's needs.

HOW IT WORKS:
- Both people participate THROUGH THIS APP
- The AI guides each person's journey privately
- At certain points, you share things with consent
- You're not chatting directly - the AI facilitates structured sharing

CONVERSATION STYLE:
- Be warm and encouraging
- Answer naturally - don't lecture
- Keep responses concise (2-4 sentences)
- Match their energy
- If they want to continue, let them know you're ready

NEVER say things like "you'd need to set up in real life" - the conversation happens IN THIS APP.`;
}

/**
 * Handle a dispatch tag with full conversation context.
 * Returns a contextual AI response for the specific scenario,
 * or null if the tag is unrecognized (letting the original AI response through).
 */
export async function handleDispatch(dispatchTag: DispatchTag, context: DispatchContext): Promise<string | null> {
  logger.info(`[Dispatch Handler] Triggered: ${dispatchTag}`);

  switch (dispatchTag) {
    case 'EXPLAIN_PROCESS':
      return handleProcessExplanation(context);

    case 'EXPLAIN_EMPATHY_PURPOSE':
      return handleEmpathyPurposeExplanation(context);

    case 'HANDLE_MEMORY_REQUEST':
      // Memory request is simpler - static response is fine
      return `I'd love to help you remember important things! You can add memories in your Profile under "Things to Remember." That way I'll always have them available when we talk.

Is there something specific you'd like to note down?`;

    default:
      if (/^SAFETY_CONCERN/i.test(dispatchTag)) {
        logger.info(`[Dispatch Handler] Routing safety tag "${dispatchTag}" to retry guidance`);
        return `I'm sorry, I had trouble responding to that safely. Something in the wording appears to touch on safety-sensitive harm, crisis, or risk, so I paused instead of guessing.

Could you try again with a little more concrete context and less shorthand? For example, name what happened, who is currently safe or unsafe, and what kind of help you want from me right now.`;
      }

      // Sharing/process-related tags the AI freelances (e.g. EXPLAIN_WHAT_WAS_SHARED,
      // SHOW_SHARING_HISTORY, CLARIFY_SHARE_HISTORY) — route to the process explainer
      // rather than falling through to an empty response (issue #312).
      if (/SHAR|PROCESS|EXPLAIN|HISTORY|STAGE/i.test(dispatchTag)) {
        logger.info(`[Dispatch Handler] Routing process-related tag "${dispatchTag}" to EXPLAIN_PROCESS`);
        return handleProcessExplanation(context);
      }
      // Truly unknown tags are ignored — the AI's original streamed response is used instead.
      logger.warn(`[Dispatch Handler] Unknown tag ignored (using AI response): ${dispatchTag}`);
      return null;
  }
}

/**
 * Handle process explanation with full AI conversation capability.
 */
async function handleProcessExplanation(context: DispatchContext): Promise<string> {
  const { userMessage, conversationHistory, sessionId, turnId } = context;

  try {
    // Build messages for the AI - include recent conversation for context
    const messages = [
      ...conversationHistory.slice(-6), // Last few exchanges for context
      { role: 'user' as const, content: userMessage },
    ];

    const response = await getSonnetResponse({
      systemPrompt: buildProcessExplainerPrompt(context),
      messages,
      maxTokens: 512,
      sessionId,
      turnId,
      operation: 'dispatch-process-explainer',
      callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    });

    if (response) {
      return response.trim();
    }

    // Fallback if AI fails
    return getFallbackProcessResponse(userMessage);
  } catch (error) {
    logger.error('[Dispatch Handler] Process explanation failed:', error);
    return getFallbackProcessResponse(userMessage);
  }
}

/**
 * Fallback response if AI call fails.
 */
function getFallbackProcessResponse(userMessage: string): string {
  const lowerMessage = userMessage.toLowerCase();

  // Check if they're asking about talking to/connecting with the other person
  if (lowerMessage.includes('talk to') || lowerMessage.includes('connect') || lowerMessage.includes('when do i')) {
    return `You'll invite them to join by sharing a link. Once they accept, they go through the same process on their side. At certain points - like empathy statements - you'll share things with each other (always with your consent).

Ready to continue?`;
  }

  // Check if they're asking about next steps
  if (lowerMessage.includes('next') || lowerMessage.includes('then') || lowerMessage.includes('after')) {
    return `After you feel fully heard, you'll craft an empathy statement imagining their perspective - that gets shared with them. Then we identify underlying needs for both of you, and design small experiments to try together.

Ready to continue where we were?`;
  }

  // Default overview
  return `The process has four stages: first each person gets to feel truly heard, then you craft empathy statements that get shared with each other, then we identify underlying needs, and finally you design small experiments to try together.

Would you like me to explain more, or shall we continue?`;
}

/**
 * Build system prompt for explaining why the empathy step exists.
 * Triggered when user explicitly asks "Why am I guessing?" or similar.
 */
function buildEmpathyPurposePrompt(context: DispatchContext): string {
  const { userName, partnerName } = context;
  const user = userName || 'you';
  const partner = partnerName || 'your partner';

  return `You are Meet Without Fear, explaining to ${user} why this step matters — seeing things from the other side.

${user} has been exploring ${partner}'s perspective and has asked something like "Why am I guessing at what ${partner} feels?" or "Shouldn't ${partner} be talking to the AI too?" or "What's the point of this?"

WHAT TO EXPLAIN (in your own words, naturally — not as a bulleted list):

1. Yes, ${partner} IS also going through this process separately. Both people talk to the AI on their own, working through their own side.

2. This step is where each person tries to understand what the other might be going through. Both ${user} and ${partner} do this for each other.

3. Why it matters: This step helps each person check whether they can name something real about the other's inner experience without excusing, agreeing, or deciding what happens next. It doesn't matter if the guess is accurate — the act of honestly trying creates clearer understanding.

4. It's a guess, not a test. Nobody expects ${user} to read ${partner}'s mind. Getting it "wrong" is completely fine. What matters is that ${partner} will see ${user} made the effort.

5. What happens next: ${user} will write a short statement about what they think ${partner} might be feeling. That statement gets shared (with consent) so ${partner} can see how ${user} sees them. ${partner} does the same thing for ${user}.

STYLE:
- Sound like a warm, smart person explaining something that genuinely helps — not a therapist reading a protocol.
- Keep it to 3-5 sentences. Don't over-explain.
- End by gently inviting them back into the conversation: ask an opening question about ${partner}'s perspective.
- Match their energy. If they seem frustrated, acknowledge that before explaining.`;
}

/**
 * Handle empathy purpose explanation with full AI conversation capability.
 */
async function handleEmpathyPurposeExplanation(context: DispatchContext): Promise<string> {
  const { userMessage, conversationHistory, sessionId, turnId } = context;

  try {
    const messages = [...conversationHistory.slice(-6), { role: 'user' as const, content: userMessage }];

    const response = await getSonnetResponse({
      systemPrompt: buildEmpathyPurposePrompt(context),
      messages,
      maxTokens: 512,
      sessionId,
      turnId,
      operation: 'dispatch-empathy-purpose',
      callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    });

    if (response) {
      return response.trim();
    }

    return getFallbackEmpathyPurposeResponse(context);
  } catch (error) {
    logger.error('[Dispatch Handler] Empathy purpose explanation failed:', error);
    return getFallbackEmpathyPurposeResponse(context);
  }
}

/**
 * Fallback if AI call fails for empathy purpose explanation.
 */
function getFallbackEmpathyPurposeResponse(context: DispatchContext): string {
  const partner = context.partnerName || 'your partner';
  return `Good question. ${partner} is actually going through this same process on their side — you're both independently trying to understand each other. This is not a test, and it is not about excusing, agreeing, or deciding what happens next. You'll each write a short statement that gets shared, so ${partner} can see you tried to understand them, and you'll see the same from them.

What do you think might be going on for ${partner} in all this?`;
}
