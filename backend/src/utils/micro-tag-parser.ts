/**
 * Micro-Tag Parser
 *
 * Parses the semantic tag format used by the AI response:
 * - <thinking>...</thinking> - Hidden analysis with flags
 * - <draft>...</draft> - Optional draft content (invitation/empathy)
 * - <needs>...</needs> - Optional structured Stage 3 needs JSON
 * - <needs_ready>...</needs_ready> - Legacy/errant hidden needs payload, stripped if emitted
 * - <dispatch>...</dispatch> - Optional off-ramp signal
 * - Everything else is the user-facing response
 */

import { extractJsonFromResponse } from './json-extractor';
import { logger } from '../lib/logger';
import {
  NeedCategory,
  Stage4ProposalKind,
  type CapturedNeedInput,
  type ParsedNeedAction,
  type Stage4ProposalAction,
  type Stage4ProposalClassification,
  type Stage4ProposalInput,
  type Stage4WalkthroughAction,
  type Stage4WalkthroughActionType,
} from '@meet-without-fear/shared';
import { cleanVisibleAIText } from './visible-text';

// The Stage 4 structured-action shapes are part of the shared streaming
// contract (shared/src/contracts/stream.ts). The Parsed* names are kept as
// aliases for existing backend call sites.
export type ParsedStage4ProposalClassification = Stage4ProposalClassification;
export type ParsedStage4ProposalAction = Stage4ProposalAction;
export type ParsedStage4WalkthroughActionType = Stage4WalkthroughActionType;
export type ParsedStage4ProposalInput = Stage4ProposalInput;
export type ParsedStage4WalkthroughAction = Stage4WalkthroughAction;

export interface ParsedMicroTagResponse {
  /** The user-facing response text (all tags stripped) */
  response: string;
  /** The raw thinking block content (for logging) */
  thinking: string;
  /** Optional draft content (for empathy or topic frame).
   *  Stage 0 uses this as the topic frame; Stage 2 uses it as the empathy draft. */
  draft: string | null;
  /** Convenience alias of `draft` for Stage 0 callers. Mirrors `draft`. */
  topicFrame: string | null;
  /** Optional dispatch tag for off-ramping */
  dispatchTag: string | null;
  /** Extracted from thinking: FeelHeardCheck:Y */
  offerFeelHeardCheck: boolean;
  /** Extracted from thinking: ReadyShare:Y */
  offerReadyToShare: boolean;
  /** Extracted from thinking: ProposedStrategy lines (Stage 4) */
  proposedStrategies: string[];
  /** Structured typed Stage 4 proposal classifications from a hidden JSON block */
  stage4Proposals: ParsedStage4ProposalInput[];
  /** True when the response included a hidden Stage 4 proposal classification block */
  stage4ProposalBlockPresent: boolean;
  /** Structured Stage 4 current-need walkthrough action from the model */
  stage4WalkthroughAction: ParsedStage4WalkthroughAction | null;
  /** Structured needs proposed by Stage 3 in a hidden <needs> JSON block */
  proposedNeeds: CapturedNeedInput[];
  /** Structured single need proposed by Stage 3 in a hidden <need> JSON block */
  proposedNeed: CapturedNeedInput | null;
  /** Structured Stage 3 need edit/delete/lock action */
  needAction: ParsedNeedAction | null;
  /** Parser rejection reason for invalid Stage 3 need tags */
  needParseError: string | null;
}

function isNeedCategory(value: unknown): value is NeedCategory {
  return typeof value === 'string' && Object.values(NeedCategory).includes(value as NeedCategory);
}

function parseNeedsBlock(rawNeeds: string | null): CapturedNeedInput[] {
  if (!rawNeeds) return [];

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawNeeds);
    } catch {
      parsed = extractJsonFromResponse(rawNeeds) as unknown;
    }
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { needs?: unknown }).needs)
        ? (parsed as { needs: unknown[] }).needs
        : [];

    return items.flatMap((item): CapturedNeedInput[] => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as Record<string, unknown>;
      const need = typeof candidate.need === 'string' ? cleanVisibleAIText(candidate.need) : '';
      const description = typeof candidate.description === 'string' ? cleanVisibleAIText(candidate.description) : need;
      const category = candidate.category;
      const evidence = Array.isArray(candidate.evidence)
        ? candidate.evidence
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .map(entry => cleanVisibleAIText(entry))
            .filter(Boolean)
        : [];

      if (!need || !description || !isNeedCategory(category)) return [];

      return [
        {
          need,
          category,
          description,
          evidence,
        },
      ];
    });
  } catch (error) {
    logger.warn('[micro-tag-parser] Failed to parse <needs> block', error);
    return [];
  }
}

function normalizeNeedItem(item: unknown): CapturedNeedInput | null {
  if (!item || typeof item !== 'object') return null;
  const candidate = item as Record<string, unknown>;
  const need = typeof candidate.need === 'string' ? cleanVisibleAIText(candidate.need) : '';
  const description = typeof candidate.description === 'string' ? cleanVisibleAIText(candidate.description) : need;
  const category = candidate.category;
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map(entry => cleanVisibleAIText(entry))
        .filter(Boolean)
    : [];

  if (!need || !description || !isNeedCategory(category)) return null;

  return { need, category, description, evidence };
}

function parseNeedBlock(rawNeed: string | null): CapturedNeedInput | null {
  if (!rawNeed) return null;

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawNeed);
    } catch {
      parsed = extractJsonFromResponse(rawNeed) as unknown;
    }
    return normalizeNeedItem(parsed);
  } catch (error) {
    logger.warn('[micro-tag-parser] Failed to parse <need> block', error);
    return null;
  }
}

function parseTagAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attrRegex = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rawAttributes)) !== null) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function parseNeedActionTag(rawResponse: string): ParsedNeedAction | null {
  const fullMatch = rawResponse.match(/<need-action\b([^>]*)>([\s\S]*?)<\/need-action>/i);
  const selfClosingMatch = rawResponse.match(/<need-action\b([^>]*)\/>/i);
  const match = fullMatch ?? selfClosingMatch;
  if (!match) return null;

  const attributes = parseTagAttributes(match[1] ?? '');
  const type = attributes.type;
  if (type !== 'refine' && type !== 'delete' && type !== 'lock') return null;

  const body = fullMatch?.[2]?.trim();
  const payload = body ? parseNeedBlock(body) : null;
  return {
    type,
    needId: attributes.needId || undefined,
    supersedes: attributes.supersedes || undefined,
    need: payload?.need,
    category: payload?.category,
    description: payload?.description,
    evidence: payload?.evidence,
  };
}

function countTagOccurrences(rawResponse: string, tagName: string): number {
  const boundary = tagName === 'need' ? '(?![-\\w])' : '\\b';
  return rawResponse.match(new RegExp(`<${tagName}${boundary}`, 'gi'))?.length ?? 0;
}

function isStage4ProposalClassification(value: unknown): value is ParsedStage4ProposalClassification {
  return value === 'PROPOSAL' || value === 'REFLECTION' || value === 'SUCCESS_MARKER' || value === 'PROCESS';
}

function isStage4ProposalAction(value: unknown): value is ParsedStage4ProposalAction {
  return value === 'ADD' || value === 'REVISE' || value === 'REMOVE' || value === 'IGNORE';
}

function parseStage4ProposalsBlock(rawProposals: string | null): ParsedStage4ProposalInput[] {
  if (!rawProposals) return [];

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawProposals);
    } catch {
      parsed = extractJsonFromResponse(rawProposals) as unknown;
    }
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { proposals?: unknown }).proposals)
        ? (parsed as { proposals: unknown[] }).proposals
        : [];

    return items.flatMap((item): ParsedStage4ProposalInput[] => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as Record<string, unknown>;
      if (!isStage4ProposalClassification(candidate.classification)) return [];
      const action = isStage4ProposalAction(candidate.action) ? candidate.action : 'ADD';
      const targetProposalId =
        typeof candidate.targetProposalId === 'string' && candidate.targetProposalId.trim().length > 0
          ? candidate.targetProposalId.trim()
          : undefined;

      const description = typeof candidate.description === 'string' ? cleanVisibleAIText(candidate.description) : '';
      const kind =
        typeof candidate.kind === 'string' &&
        Object.values(Stage4ProposalKind).includes(candidate.kind as Stage4ProposalKind)
          ? (candidate.kind as Stage4ProposalKind)
          : undefined;
      const ownerUserId =
        typeof candidate.ownerUserId === 'string' && candidate.ownerUserId.trim().length > 0
          ? candidate.ownerUserId.trim()
          : undefined;
      const needsAddressed = Array.isArray(candidate.needsAddressed)
        ? candidate.needsAddressed
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .map(entry => cleanVisibleAIText(entry))
            .filter(Boolean)
        : undefined;
      const duration = typeof candidate.duration === 'string' ? cleanVisibleAIText(candidate.duration) : undefined;
      const measureOfSuccess =
        typeof candidate.measureOfSuccess === 'string' ? cleanVisibleAIText(candidate.measureOfSuccess) : undefined;

      if (!description) return [];

      return [
        {
          action,
          targetProposalId,
          classification: candidate.classification,
          description,
          kind,
          ownerUserId,
          needsAddressed,
          duration,
          measureOfSuccess,
        },
      ];
    });
  } catch (error) {
    logger.warn('[micro-tag-parser] Failed to parse <stage4_proposals> block', error);
    return [];
  }
}

function parseStage4WalkthroughBlock(rawAction: string | null): ParsedStage4WalkthroughAction | null {
  if (!rawAction) return null;

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAction);
    } catch {
      parsed = extractJsonFromResponse(rawAction) as unknown;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    const action = candidate.action;
    if (action !== 'COVERED' && action !== 'SKIP' && action !== 'NONE') return null;
    const needId =
      typeof candidate.needId === 'string' && candidate.needId.trim().length > 0 ? candidate.needId.trim() : undefined;
    const reason =
      typeof candidate.reason === 'string' && candidate.reason.trim().length > 0
        ? cleanVisibleAIText(candidate.reason)
        : undefined;
    return { action, needId, reason };
  } catch (error) {
    logger.warn('[micro-tag-parser] Failed to parse <stage4_walkthrough> block', error);
    return null;
  }
}

function isFollowUpTimingOnlyStrategy(strategy: string): boolean {
  const normalized = strategy
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;

  const mentionsFollowUpTiming =
    /\bfollow[- ]?up\b/.test(normalized) ||
    /\bcheck back\b/.test(normalized) ||
    /\bcheck in on how (?:it|this|that) (?:went|goes)\b/.test(normalized) ||
    /\bwhen should we check in\b/.test(normalized);
  if (!mentionsFollowUpTiming) return false;

  const hasExperimentAction =
    /\b(?:try|do|take|schedule|practice|write|use|pause|walk|talk|meet|plan|attend|share|listen|ask|choose|spend|set aside|commit)\b/.test(
      normalized,
    );
  return !hasExperimentAction;
}

function addProposedStrategy(proposedStrategies: string[], rawStrategy: string): void {
  const strategy = cleanVisibleAIText(rawStrategy);
  if (strategy.length > 0 && !isFollowUpTimingOnlyStrategy(strategy)) {
    proposedStrategies.push(strategy);
  }
}

function stripVisibleProposedStrategyLines(responseText: string): {
  responseText: string;
  visibleStrategies: string[];
} {
  const visibleStrategies: string[] = [];
  const cleanedLines = responseText.split('\n').filter(line => {
    const match = line.match(/^\s*ProposedStrategy:\s*(.+?)\s*$/i);
    if (!match) return true;
    visibleStrategies.push(match[1]);
    return false;
  });

  return {
    responseText: cleanedLines.join('\n').trim(),
    visibleStrategies,
  };
}

function extractBooleanControlTag(rawResponse: string, tagName: string): boolean | null {
  const tagPattern = tagName.replace(/_/g, '[_-]?');
  const match = rawResponse.match(new RegExp(`<${tagPattern}>\\s*([YN])\\s*<\\/${tagPattern}>`, 'i'));
  if (!match) return null;
  return match[1].toUpperCase() === 'Y';
}

function stripKnownControlTags(rawResponse: string): string {
  return rawResponse
    .replace(/<feel[_-]?heard[_-]?check>\s*[YN]\s*<\/feel[_-]?heard[_-]?check>/gi, '')
    .replace(/<ready[_-]?share>\s*[YN]\s*<\/ready[_-]?share>/gi, '');
}

/**
 * Parse the micro-tag response format.
 * Extracts semantic blocks and flags from the raw AI response.
 */
export function parseMicroTagResponse(rawResponse: string): ParsedMicroTagResponse {
  const feelHeardControlTag = extractBooleanControlTag(rawResponse, 'feel_heard_check');
  const readyShareControlTag = extractBooleanControlTag(rawResponse, 'ready_share');

  // 1. Extract blocks using regex
  const thinkingMatch = rawResponse.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  const draftMatch = rawResponse.match(/<draft>([\s\S]*?)<\/draft>/i);
  const singleNeedMatch = rawResponse.match(/<need>([\s\S]*?)<\/need>/i);
  const needsMatch = rawResponse.match(/<needs>([\s\S]*?)<\/needs>/i);
  const stage4ProposalsMatch = rawResponse.match(/<stage4_proposals>([\s\S]*?)<\/stage4_proposals>/i);
  const stage4WalkthroughMatch = rawResponse.match(/<stage4_walkthrough>([\s\S]*?)<\/stage4_walkthrough>/i);
  const dispatchMatch = rawResponse.match(/<dispatch>([\s\S]*?)<\/dispatch>/i);

  const thinking = thinkingMatch?.[1]?.trim() ?? '';
  const draft = draftMatch?.[1]?.trim() ?? null;
  const needRaw = singleNeedMatch?.[1]?.trim() ?? null;
  const needsRaw = needsMatch?.[1]?.trim() ?? null;
  const stage4ProposalsRaw = stage4ProposalsMatch?.[1]?.trim() ?? null;
  const stage4WalkthroughRaw = stage4WalkthroughMatch?.[1]?.trim() ?? null;
  const dispatchTag = dispatchMatch?.[1]?.trim() ?? null;
  const singularNeedCount = countTagOccurrences(rawResponse, 'need');
  const needActionCount = countTagOccurrences(rawResponse, 'need-action');
  const totalNewNeedTags = singularNeedCount + needActionCount;
  const needParseError = totalNewNeedTags > 1 ? 'Only one <need> or <need-action> tag is allowed per turn.' : null;
  const proposedNeed = needParseError ? null : parseNeedBlock(needRaw);
  const needAction = needParseError ? null : parseNeedActionTag(rawResponse);
  const proposedNeeds = parseNeedsBlock(needsRaw);
  const stage4ProposalBlockPresent = Boolean(stage4ProposalsMatch);
  const stage4Proposals = parseStage4ProposalsBlock(stage4ProposalsRaw);
  const stage4WalkthroughAction = parseStage4WalkthroughBlock(stage4WalkthroughRaw);

  // 2. Clean response text - remove all tags
  let responseText = rawResponse
    // Defense-in-depth: the model is supposed to call update_session_state via the
    // real tool-use API, but it sometimes emits the tool call as literal XML text in
    // the prose pass. Strip any such block so raw <tool_calls>/<invoke> markup never
    // reaches the user.
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '')
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<draft>[\s\S]*?<\/draft>/gi, '')
    .replace(/<need>[\s\S]*?<\/need>/gi, '')
    .replace(/<need-action\b[^>]*>[\s\S]*?<\/need-action>/gi, '')
    .replace(/<need-action\b[^>]*\/>/gi, '')
    .replace(/<needs>[\s\S]*?<\/needs>/gi, '')
    .replace(/<needs[_-]?ready>[\s\S]*?<\/needs[_-]?ready>/gi, '')
    .replace(/<stage4_proposals>[\s\S]*?<\/stage4_proposals>/gi, '')
    .replace(/<stage4_walkthrough>[\s\S]*?<\/stage4_walkthrough>/gi, '')
    .replace(/<dispatch>[\s\S]*?<\/dispatch>/gi, '')
    .trim();
  responseText = stripKnownControlTags(responseText).trim();

  // If everything landed inside tags, leave response empty and let the caller
  // decide what to do. A dispatch handler may still fill it in; otherwise the
  // streaming endpoint should send an SSE error and ask the user to retry,
  // rather than persisting a confusing "AI processing…" placeholder message.
  if (!responseText && (thinking || draft || dispatchTag)) {
    logger.warn('[micro-tag-parser] Empty response after tag stripping', {
      hasThinking: !!thinking,
      hasDraft: !!draft,
      dispatchTag: dispatchTag ?? null,
    });
  }

  const strippedVisibleStrategies = stripVisibleProposedStrategyLines(responseText);
  responseText = strippedVisibleStrategies.responseText;

  // 3. Extract flags from thinking string (no JSON needed!)
  const offerFeelHeardCheck = feelHeardControlTag ?? /FeelHeardCheck:\s*Y/i.test(thinking);
  const offerReadyToShare = readyShareControlTag ?? /ReadyShare:\s*Y/i.test(thinking);

  // 4. Extract proposed strategies from thinking (Stage 4)
  const proposedStrategies: string[] = [];
  const strategyRegex = /ProposedStrategy:\s*(.+)/gi;
  let strategyMatch: RegExpExecArray | null;
  while ((strategyMatch = strategyRegex.exec(thinking)) !== null) {
    addProposedStrategy(proposedStrategies, strategyMatch[1]);
  }
  for (const visibleStrategy of strippedVisibleStrategies.visibleStrategies) {
    addProposedStrategy(proposedStrategies, visibleStrategy);
  }

  const needRegex = /ProposedNeed:\s*([^|]+)\|([^|]+)\|(.+)/gi;
  let needMatch: RegExpExecArray | null;
  while ((needMatch = needRegex.exec(thinking)) !== null) {
    const need = cleanVisibleAIText(needMatch[1]);
    const category = needMatch[2].trim();
    const description = cleanVisibleAIText(needMatch[3]);
    if (need && isNeedCategory(category) && description) {
      proposedNeeds.push({ need, category, description, evidence: [] });
    }
  }

  // 4. Compatibility fallback: JSON output (legacy stages may emit empathy as JSON)
  if (!thinking && !draft && responseText.startsWith('{')) {
    try {
      const parsed = extractJsonFromResponse(responseText) as Record<string, unknown>;
      const response = typeof parsed.response === 'string' ? parsed.response : responseText;
      const empathy = typeof parsed.proposedEmpathyStatement === 'string' ? parsed.proposedEmpathyStatement : null;
      responseText = response;
      return {
        response: responseText,
        thinking: '',
        draft: empathy,
        topicFrame: empathy,
        dispatchTag: null,
        offerFeelHeardCheck,
        offerReadyToShare,
        proposedStrategies,
        stage4Proposals,
        stage4ProposalBlockPresent,
        stage4WalkthroughAction,
        proposedNeeds,
        proposedNeed,
        needAction,
        needParseError,
      };
    } catch {
      // Fall through to raw responseText
    }
  }

  return {
    response: responseText,
    thinking,
    draft,
    topicFrame: draft,
    dispatchTag,
    offerFeelHeardCheck,
    offerReadyToShare,
    proposedStrategies,
    stage4Proposals,
    stage4ProposalBlockPresent,
    stage4WalkthroughAction,
    proposedNeeds,
    proposedNeed,
    needAction,
    needParseError,
  };
}
