/**
 * Crisis/Safety Detection Service
 *
 * Pattern-based crisis detection as a programmatic safety net alongside
 * LLM prompt instructions. Addresses audit finding M9: "No automated
 * crisis/safety escalation — prompt-dependent only."
 *
 * Design decisions:
 * - Uses word-boundary matching (\b) to minimize false positives on
 *   metaphorical language common in relationship conflict discussions.
 * - Never blocks message processing — detection results are additive
 *   (resources are prepended to AI context, user still gets a response).
 * - Patterns grouped by category for clarity and maintainability.
 * - Logs every detection at an appropriate severity level.
 */

import { logger } from '../lib/logger';

// ============================================================================
// Types
// ============================================================================

export type CrisisSeverity = 'none' | 'concern' | 'urgent' | 'emergency';

export interface CrisisDetectionResult {
  detected: boolean;
  severity: CrisisSeverity;
  categories: string[];
  resourceMessage?: string;
}

// ============================================================================
// Crisis Resource Messages
// ============================================================================

const CRISIS_RESOURCE_MESSAGE = [
  'If you or someone you know is in immediate danger, please call 911.',
  '',
  'Crisis resources:',
  '- 988 Suicide & Crisis Lifeline: Call or text 988 (available 24/7)',
  '- National Domestic Violence Hotline: 1-800-799-7233 (available 24/7)',
  '- Crisis Text Line: Text HOME to 741741',
].join('\n');

// ============================================================================
// Pattern Definitions
// ============================================================================

interface CrisisPattern {
  pattern: RegExp;
  category: string;
  severity: CrisisSeverity;
}

/**
 * Patterns are ordered by category. Each uses \b word boundaries to avoid
 * matching inside unrelated words (e.g., "override" won't match "ride").
 *
 * Severity levels:
 * - concern: vague references that may warrant monitoring
 * - urgent: clear expressions of distress or unsafe situations
 * - emergency: imminent danger to self or others
 */
const CRISIS_PATTERNS: CrisisPattern[] = [
  // ---- Suicide / Self-Harm (emergency) ----
  { pattern: /\bi\s+want\s+to\s+kill\s+myself\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\bi\s+(?:just\s+)?want\s+to\s+die\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\bi('m|\s+am)\s+going\s+to\s+kill\s+myself\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\bend(ing)?\s+my\s+life\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\bsuicid(e|al)\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\bi\s+don'?t\s+want\s+to\s+live\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\bi\s+don'?t\s+want\s+to\s+be\s+alive\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\bkill(ing)?\s+myself\b/i, category: 'suicide', severity: 'emergency' },
  { pattern: /\btake\s+my\s+(own\s+)?life\b/i, category: 'suicide', severity: 'emergency' },

  // ---- Self-Harm (urgent) ----
  { pattern: /\bself[- ]?harm(ing)?\b/i, category: 'self-harm', severity: 'urgent' },
  { pattern: /\bcutting\s+myself\b/i, category: 'self-harm', severity: 'urgent' },
  { pattern: /\bhurt(ing)?\s+myself\b/i, category: 'self-harm', severity: 'urgent' },
  { pattern: /\bi('m|\s+am)\s+going\s+to\s+hurt\s+myself\b/i, category: 'self-harm', severity: 'emergency' },

  // ---- Domestic Violence (urgent/emergency) ----
  {
    pattern: /\b(he|she|they|my\s+partner|my\s+husband|my\s+wife)\s+hits?\s+me\b/i,
    category: 'domestic-violence',
    severity: 'urgent',
  },
  { pattern: /\b(he|she|they)\s+(is|are)\s+hitting\s+me\b/i, category: 'domestic-violence', severity: 'emergency' },
  { pattern: /\bphysically\s+abus(ing|ed|e)\b/i, category: 'domestic-violence', severity: 'urgent' },
  { pattern: /\bi('m|\s+am)\s+being\s+beaten\b/i, category: 'domestic-violence', severity: 'emergency' },
  { pattern: /\bdomestic\s+(violence|abuse)\b/i, category: 'domestic-violence', severity: 'urgent' },
  { pattern: /\bthreatening\s+to\s+hurt\s+me\b/i, category: 'domestic-violence', severity: 'emergency' },
  { pattern: /\bthreatening\s+to\s+kill\s+me\b/i, category: 'domestic-violence', severity: 'emergency' },
  { pattern: /\bstrangl(e|ed|ing)\s+me\b/i, category: 'domestic-violence', severity: 'emergency' },

  // ---- Imminent Danger (emergency) ----
  { pattern: /\bi('m|\s+am)\s+scared\s+for\s+my\s+life\b/i, category: 'imminent-danger', severity: 'emergency' },
  { pattern: /\bi\s+don'?t\s+feel\s+safe\b/i, category: 'imminent-danger', severity: 'urgent' },
  {
    pattern: /\b(he|she|they)\s+(has|have)\s+a\s+(gun|knife|weapon)\b/i,
    category: 'imminent-danger',
    severity: 'emergency',
  },
  {
    pattern: /\bi\s+think\s+(he|she|they)('s|\s+is|\s+are)\s+going\s+to\s+kill\s+me\b/i,
    category: 'imminent-danger',
    severity: 'emergency',
  },

  // ---- Child Abuse (urgent/emergency) ----
  { pattern: /\b(child|children|kid|kids)\s+(abuse|abusing|abused)\b/i, category: 'child-abuse', severity: 'urgent' },
  {
    pattern: /\bhurt(ing|s)?\s+(my|the|a)\s+(child|children|kid|kids|baby|son|daughter)\b/i,
    category: 'child-abuse',
    severity: 'emergency',
  },
  {
    pattern:
      /\b(he|she|they)\s+(hit|hits|beat|beats|abuse|abuses)\s+(my|the|our)\s+(child|children|kid|kids|son|daughter)\b/i,
    category: 'child-abuse',
    severity: 'emergency',
  },

  // ---- General Safety Concern (concern) ----
  { pattern: /\bi\s+feel\s+unsafe\b/i, category: 'safety-concern', severity: 'concern' },
  {
    pattern: /\bi('m|\s+am)\s+afraid\s+(he|she|they)\s+will\s+hurt\b/i,
    category: 'safety-concern',
    severity: 'urgent',
  },
];

// ============================================================================
// Severity Ranking
// ============================================================================

const SEVERITY_RANK: Record<CrisisSeverity, number> = {
  none: 0,
  concern: 1,
  urgent: 2,
  emergency: 3,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Detect crisis/safety signals in a user message.
 *
 * Scans the message against categorized patterns and returns the highest
 * severity detected along with all matched categories.
 *
 * This function is intentionally synchronous and fast — it runs at the
 * start of every message pipeline invocation.
 */
export function detectCrisis(message: string): CrisisDetectionResult {
  const matchedCategories = new Set<string>();
  let highestSeverity: CrisisSeverity = 'none';

  for (const { pattern, category, severity } of CRISIS_PATTERNS) {
    if (pattern.test(message)) {
      matchedCategories.add(category);
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[highestSeverity]) {
        highestSeverity = severity;
      }
    }
  }

  const detected = highestSeverity !== 'none';
  const categories = Array.from(matchedCategories);

  // Log at appropriate level
  if (detected) {
    const logData = {
      severity: highestSeverity,
      categories,
      messagePreview: message.substring(0, 100),
    };

    switch (highestSeverity) {
      case 'concern':
        logger.info('[Crisis Detector] Safety concern detected', logData);
        break;
      case 'urgent':
        logger.warn('[Crisis Detector] Urgent safety signal detected', logData);
        break;
      case 'emergency':
        logger.error('[Crisis Detector] EMERGENCY safety signal detected', logData);
        break;
    }
  }

  const includeResources = highestSeverity === 'urgent' || highestSeverity === 'emergency';

  return {
    detected,
    severity: highestSeverity,
    categories,
    resourceMessage: includeResources ? CRISIS_RESOURCE_MESSAGE : undefined,
  };
}
