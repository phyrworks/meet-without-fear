/**
 * JSON Extraction Utility
 *
 * Robust JSON extraction from LLM responses with multiple fallback strategies.
 * Based on production patterns from lovely backend.
 */

// ============================================================================
// Types
// ============================================================================

import { logger } from '../lib/logger';

export interface ExtractJsonOptions {
  /** Whether to log parsing attempts for debugging */
  debug?: boolean;
}

// ============================================================================
// JSON Extraction
// ============================================================================

/**
 * Escape unescaped newlines inside JSON string values.
 * LLMs often output literal newlines instead of \n in strings.
 *
 * Uses a state machine approach to properly handle nested quotes and escapes.
 */
function escapeNewlinesInStrings(jsonStr: string): string {
  let result = '';
  let inString = false;
  let i = 0;

  while (i < jsonStr.length) {
    const char = jsonStr[i];

    if (char === '"') {
      // Count consecutive backslashes before this quote
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && jsonStr[j] === '\\'; j--) {
        backslashes++;
      }
      // Quote is escaped only if preceded by an odd number of backslashes
      if (backslashes % 2 === 0) {
        inString = !inString;
      }
      result += char;
    } else if (inString && (char === '\n' || char === '\r')) {
      // Replace literal newlines inside strings with escaped versions
      if (char === '\r' && jsonStr[i + 1] === '\n') {
        result += '\\n';
        i++; // Skip the \n that follows \r
      } else {
        result += '\\n';
      }
    } else {
      result += char;
    }
    i++;
  }

  return result;
}

/**
 * Clean and parse JSON string, handling common LLM quirks.
 */
function parseCleanJson(jsonStr: string): unknown {
  // Step 1: Escape unescaped newlines in string values
  let cleanedJson = escapeNewlinesInStrings(jsonStr);

  // Step 2: Handle other common LLM quirks
  cleanedJson = cleanedJson
    .replace(/:\s*undefined\b/g, ': null')
    .replace(/,\s*}/g, '}') // Remove trailing commas before }
    .replace(/,\s*]/g, ']'); // Remove trailing commas before ]
  return JSON.parse(cleanedJson);
}

/**
 * Extract JSON from an LLM response using multiple strategies.
 *
 * Tries in order:
 * 1. JSON code blocks (```json ... ```)
 * 2. Raw JSON object ({ ... })
 * 3. Raw JSON array ([ ... ])
 * 4. Full response as JSON
 *
 * @param response - The raw LLM response string
 * @param options - Extraction options
 * @returns Parsed JSON object or throws error
 */
export function extractJsonFromResponse(response: string, options: ExtractJsonOptions = {}): unknown {
  const { debug = false } = options;

  if (debug) {
    logger.info('[JSON Extractor] Raw response:', response);
  }

  // Strategy 1: Extract JSON from code blocks (case-insensitive, optional language tag)
  const jsonBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\s*```/i);
  if (jsonBlockMatch) {
    try {
      const result = parseCleanJson(jsonBlockMatch[1].trim());
      if (debug) logger.info('[JSON Extractor] Extracted from code block');
      return result;
    } catch (e) {
      if (debug) logger.info('[JSON Extractor] Code block parse failed:', e);
    }
  }

  // Strategy 1b: Handle truncated code blocks (opening ``` but no closing ```)
  // This happens when LLM responses hit the max_tokens limit mid-output
  const truncatedBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]+)/i);
  if (truncatedBlockMatch && !jsonBlockMatch) {
    const truncatedContent = truncatedBlockMatch[1].trim();
    // Try to find a valid JSON object within the truncated content
    const jsonObjectInTruncated = truncatedContent.match(/\{[\s\S]*\}/);
    if (jsonObjectInTruncated) {
      try {
        const result = parseCleanJson(jsonObjectInTruncated[0]);
        if (debug) logger.info('[JSON Extractor] Extracted from truncated code block');
        return result;
      } catch (e) {
        if (debug) logger.info('[JSON Extractor] Truncated code block parse failed:', e);
      }
    }
  }

  // Strategy 2: Find JSON object in response
  const jsonObjectMatch = response.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    try {
      const result = parseCleanJson(jsonObjectMatch[0]);
      if (debug) logger.info('[JSON Extractor] Extracted raw JSON object');
      return result;
    } catch (e) {
      if (debug) logger.info('[JSON Extractor] Object parse failed:', e);
    }
  }

  // Strategy 3: Find JSON array in response
  const jsonArrayMatch = response.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    try {
      const result = parseCleanJson(jsonArrayMatch[0]);
      if (debug) logger.info('[JSON Extractor] Extracted raw JSON array');
      return result;
    } catch (e) {
      if (debug) logger.info('[JSON Extractor] Array parse failed:', e);
    }
  }

  // Strategy 4: Try parsing the full response after cleanup (case-insensitive)
  const cleanedContent = response
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const result = parseCleanJson(cleanedContent);
    if (debug) logger.info('[JSON Extractor] Parsed cleaned full response');
    return result;
  } catch (error) {
    if (debug) logger.info('[JSON Extractor] Full response parse failed:', error);
  }

  throw new Error(`Failed to extract JSON from LLM response: ${response.substring(0, 200)}...`);
}

/**
 * Safely extract JSON with a fallback value.
 * Never throws - returns fallback on any error.
 */
export function extractJsonSafe<T>(response: string, fallback: T, options: ExtractJsonOptions = {}): T {
  try {
    return extractJsonFromResponse(response, options) as T;
  } catch (error) {
    logger.warn('[JSON Extractor] Using fallback:', error);
    return fallback;
  }
}

// ============================================================================
// Typed Extraction Helpers
// ============================================================================
