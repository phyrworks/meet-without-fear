/**
 * Needs Assessment Prompts Service
 *
 * Provides conversational prompts for needs check-ins and assessments.
 */

import { NeedsCategory } from '@meet-without-fear/shared';

// ============================================================================
// Types
// ============================================================================

interface NeedPromptContext {
  needId: number;
  needName: string;
  category: NeedsCategory;
  currentScore: number | null;
  previousScore: number | null;
  daysSinceLastCheckIn: number | null;
  lowNeeds: string[];
  highNeeds: string[];
}

// ============================================================================
// Check-in Prompts
// ============================================================================

/**
 * Build a conversational prompt for checking in on a specific need.
 */
export function buildNeedCheckInPrompt(context: NeedPromptContext): string {
  const { needName, category, currentScore, previousScore, daysSinceLastCheckIn } = context;

  const categoryContext = getCategoryContext(category);
  const scoreContext = getScoreContext(currentScore, previousScore);
  const timeContext = getTimeContext(daysSinceLastCheckIn);

  return `You are helping someone check in on their ${needName} need as part of Inner Work.

ABOUT THIS NEED:
${needName} is a ${category.toLowerCase()} need. ${categoryContext}

${scoreContext}
${timeContext}

YOUR APPROACH:
1. Ask a gentle, open question about how this need feels right now
2. Listen for specifics - what's contributing to it feeling met or unmet?
3. Don't lecture or explain the need - they already know what it is
4. If they share something, reflect it back briefly
5. Help them arrive at a score (0 = not met, 1 = somewhat met, 2 = fully met)
6. Keep it conversational, not clinical

TONE:
- Warm and curious, not therapeutic or analytical
- Brief responses (1-3 sentences typically)
- No excessive validation or cheerleading
- Trust them to know their own experience

EXAMPLE EXCHANGE:
User: "I've been feeling disconnected lately"
AI: "That sounds hard. What does that disconnection feel like day to day?"
User: "Like I'm just going through motions, not really present with anyone"
AI: "Going through the motions... Would you say your sense of connection feels not met right now, somewhat met, or more fully met?"

START by asking about their current experience with ${needName}. Keep it simple and open.`;
}

/**
 * Build prompt for the baseline assessment flow.
 */
export function buildBaselineAssessmentPrompt(
  needsToAssess: { id: number; name: string; category: NeedsCategory; description: string }[],
  assessedSoFar: number,
): string {
  const totalNeeds = 19;
  const progress = `${assessedSoFar}/${totalNeeds}`;

  return `You are guiding someone through their initial needs baseline assessment in Inner Work.

PROGRESS: ${progress} needs assessed

NEEDS REMAINING:
${needsToAssess.map((n, i) => `${i + 1}. ${n.name} (${n.category}): ${n.description}`).join('\n')}

YOUR ROLE:
1. Present one need at a time
2. Briefly explain what the need means (one sentence)
3. Ask them to rate: 0 = not met, 1 = somewhat met, 2 = fully met
4. Accept their rating without judgment
5. Move to the next need

PACING:
- Keep it moving - this shouldn't feel like a therapy session
- Brief acknowledgment of each answer, then next need
- If they want to elaborate, let them, but don't probe
- Goal is to complete the baseline, not deep exploration

TONE:
- Efficient but warm
- "Got it" or "Thanks" is enough acknowledgment
- No analysis or interpretation of their scores
- Save deeper exploration for individual check-ins later

After all 19 needs are rated, congratulate them briefly and explain that they can check in on individual needs anytime.`;
}

/**
 * Build prompt for suggesting which need to check in on.
 */
export function buildNeedSuggestionPrompt(
  needsWithScores: { name: string; score: number; daysSinceCheckIn: number }[],
): string {
  const lowNeeds = needsWithScores.filter(n => n.score <= 1);
  const staleNeeds = needsWithScores.filter(n => n.daysSinceCheckIn > 14);

  return `Based on the user's needs data, suggest which need might be worth checking in on.

CURRENT STATE:
${needsWithScores.map(n => `- ${n.name}: score ${n.score}, last checked ${n.daysSinceCheckIn} days ago`).join('\n')}

LOW NEEDS (score 0-1):
${lowNeeds.length > 0 ? lowNeeds.map(n => n.name).join(', ') : 'None'}

STALE NEEDS (not checked in 14+ days):
${staleNeeds.length > 0 ? staleNeeds.map(n => n.name).join(', ') : 'None'}

SUGGESTION LOGIC:
1. Prioritize low needs that haven't been checked recently
2. If all needs are doing well, suggest checking in on the oldest one
3. Frame it as an invitation, not a prescription

OUTPUT:
Suggest 1-2 needs to check in on, with a brief reason why. Keep it under 2 sentences.`;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getCategoryContext(category: NeedsCategory): string {
  switch (category) {
    case NeedsCategory.FOUNDATION:
      return 'Foundation needs are about your body and safety - rest, nourishment, movement, material security.';
    case NeedsCategory.EMOTIONAL:
      return 'Emotional needs are about how you feel - self-compassion, regulation, agency, emotional safety.';
    case NeedsCategory.RELATIONAL:
      return 'Relational needs are about connections - being seen, belonging, trust, contribution.';
    case NeedsCategory.INTEGRATION:
      return 'Integration needs are about meaning - purpose, learning, integrity, hope.';
    case NeedsCategory.TRANSCENDENCE:
      return 'Transcendence needs are about presence - gratitude, connection to something larger.';
    default:
      return '';
  }
}

function getScoreContext(currentScore: number | null, previousScore: number | null): string {
  if (currentScore === null) {
    return 'This is a new check-in - no previous score recorded.';
  }

  const scoreLabels = ['not met', 'somewhat met', 'fully met'];
  const current = scoreLabels[currentScore] || 'unknown';

  if (previousScore === null) {
    return `Last check-in: ${current} (${currentScore}/2)`;
  }

  const previous = scoreLabels[previousScore] || 'unknown';
  const trend =
    currentScore > previousScore ? 'improved' : currentScore < previousScore ? 'declined' : 'stayed the same';

  return `Last check-in: ${current} (${currentScore}/2). Previously: ${previous}. Trend: ${trend}.`;
}

function getTimeContext(daysSinceLastCheckIn: number | null): string {
  if (daysSinceLastCheckIn === null) {
    return 'First time checking in on this need.';
  }

  if (daysSinceLastCheckIn === 0) {
    return 'Checked in earlier today.';
  }

  if (daysSinceLastCheckIn === 1) {
    return 'Last checked in yesterday.';
  }

  if (daysSinceLastCheckIn < 7) {
    return `Last checked in ${daysSinceLastCheckIn} days ago.`;
  }

  if (daysSinceLastCheckIn < 14) {
    return `About a week since last check-in.`;
  }

  return `It's been ${daysSinceLastCheckIn} days since last check-in - good time to revisit.`;
}

// ============================================================================
// Need-Specific Prompts
// ============================================================================

/**
 * Get a contextual opening question for a specific need.
 */
export function getNeedOpeningQuestion(needName: string): string {
  const questions: Record<string, string> = {
    // Physical
    Rest: 'How has your sleep and rest been feeling lately?',
    Nourishment: "How are you feeling about how you've been eating and drinking?",
    Movement: 'Have you been able to move your body in ways that feel good?',
    Safety: 'How safe and secure do you feel in your day-to-day life?',
    Comfort: 'How comfortable is your physical environment right now?',

    // Emotional
    Peace: 'How calm or anxious have you been feeling?',
    Joy: "What's been bringing you joy lately, if anything?",
    Acceptance: 'How accepted do you feel - by others, by yourself?',
    Expression: "Have you been able to express what you're really feeling?",
    Validation: 'Do you feel like your experiences and feelings are being acknowledged?',

    // Mental
    Clarity: 'How clear or foggy has your thinking been?',
    Stimulation: 'Are you getting enough mental challenge and engagement?',
    Learning: 'Have you been learning or growing in ways that matter to you?',
    Autonomy: 'How much control do you feel over your choices right now?',
    Creativity: 'Have you had space to create or express yourself creatively?',

    // Social
    Connection: 'How connected do you feel to the people in your life?',
    Belonging: 'Do you feel like you belong somewhere, with some group or community?',
    Recognition: 'Do you feel seen and appreciated for who you are?',
    Intimacy: "How's the depth and closeness in your important relationships?",

    // Spiritual
    Purpose: 'How connected do you feel to a sense of purpose or meaning?',
    Contribution: "Do you feel like you're making a meaningful contribution?",
    Transcendence: 'Have you had moments of feeling connected to something larger than yourself?',
    Gratitude: 'How much gratitude have you been feeling lately?',
  };

  return questions[needName] || `How has your sense of ${needName.toLowerCase()} been lately?`;
}

/**
 * Get follow-up prompts based on score direction.
 */
export function getScoreFollowUp(needName: string, score: number): string {
  if (score === 0) {
    return `It sounds like ${needName.toLowerCase()} is really struggling right now. Is there one small thing that might help, even a little?`;
  }

  if (score === 1) {
    return `Somewhat met - that's honest. What would move it closer to fully met, if anything?`;
  }

  return `That's great that ${needName.toLowerCase()} feels well met. What's contributing to that?`;
}
