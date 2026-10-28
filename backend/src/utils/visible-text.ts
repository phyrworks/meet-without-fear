/**
 * Cleanup for AI-generated text before it is shown or persisted.
 *
 * This is intentionally narrow: it removes serialization and markdown artifacts
 * that the prompt format can leak, without rewriting normal prose.
 */
export interface CleanVisibleAITextOptions {
  /**
   * Streaming chunks may begin or end with semantically meaningful whitespace.
   * Preserve it when cleaning per-chunk text so chunk boundaries do not collapse
   * words together in the streamed or persisted response.
   */
  preserveBoundaryWhitespace?: boolean;
}

export function cleanVisibleAIText(text: string, options: CleanVisibleAITextOptions = {}): string {
  if (options.preserveBoundaryWhitespace && text.trim().length === 0) {
    return text;
  }

  const leadingWhitespace = options.preserveBoundaryWhitespace ? (text.match(/^\s*/)?.[0] ?? '') : '';
  const trailingWhitespace = options.preserveBoundaryWhitespace ? (text.match(/\s*$/)?.[0] ?? '') : '';

  let cleaned = text.replace(/\\"/g, '"').replace(/\r\n/g, '\n').trim();

  for (let i = 0; i < 4; i += 1) {
    const before = cleaned;
    cleaned = cleaned
      .split('\n')
      .filter((line, index) => {
        const trimmed = line.trim();
        if (index === 0 && /^(?:---+|```(?:json|markdown)?|~~~)$/.test(trimmed)) {
          return false;
        }
        return !/^(?:```|~~~)$/.test(trimmed);
      })
      .join('\n')
      .replace(/^---+\s*/, '')
      .trim();

    const emphasisMatch = cleaned.match(/^\*\*([\s\S]*?)\*\*$/) ?? cleaned.match(/^__([\s\S]*?)__$/);
    if (emphasisMatch) {
      cleaned = emphasisMatch[1].trim();
    }

    const quoteMatch = cleaned.match(/^["“”']([\s\S]*?)["“”']$/);
    if (quoteMatch) {
      cleaned = quoteMatch[1].trim();
    }
    if (cleaned === before) break;
  }

  if (options.preserveBoundaryWhitespace && cleaned.length > 0) {
    return `${leadingWhitespace}${cleaned}${trailingWhitespace}`;
  }

  return cleaned;
}

const PLANNER_LINE_PREFIXES = [
  'i should',
  'so both lists should',
  '— so both lists should',
  "here's my plan",
  'the prompt says',
  'i need to follow',
  'i need to present',
  'i need to check the prompt',
  'i need to use the prompt',
  'i need to make sure both lists',
];

function stripUntaggedReasoningPreamble(text: string): string {
  const marker = text.match(/\bFor\s+stage4_(?:walkthrough|proposals)\s*:/i);
  if (!marker || marker.index === undefined) return text;

  const afterMarker = text.slice(marker.index);
  const nextParagraph = afterMarker.match(/\n\s*\n+/);
  if (!nextParagraph || nextParagraph.index === undefined) return text;

  const visibleStart = marker.index + nextParagraph.index + nextParagraph[0].length;
  return text.slice(visibleStart);
}

/**
 * `cleanVisibleAIText` plus removal of untagged planner/reasoning prose that
 * the model sometimes emits outside the hidden-tag protocol.
 *
 * Shared by the streaming turn services (per-chunk with boundary whitespace
 * preserved, and once over the full parsed response) and re-exported from the
 * messages controller for its existing callers.
 */
export function scrubVisibleAIText(
  text: string,
  options: { preserveBoundaryWhitespace?: boolean } = {},
): { text: string; scrubbed: boolean } {
  const before = text;
  const preambleScrubbed = stripUntaggedReasoningPreamble(text);
  const plannerScrubbed = preambleScrubbed
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim().toLowerCase();
      return !PLANNER_LINE_PREFIXES.some(prefix => trimmed.startsWith(prefix));
    })
    .join('\n')
    .replace(/\bI should\b/gi, '')
    .replace(/\bso both lists should be available\b/gi, '');
  const cleaned = cleanVisibleAIText(plannerScrubbed, {
    preserveBoundaryWhitespace: options.preserveBoundaryWhitespace,
  });

  return { text: cleaned, scrubbed: cleaned !== before };
}
