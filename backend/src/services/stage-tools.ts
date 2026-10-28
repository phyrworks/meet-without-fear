/**
 * Stage Tools
 *
 * Defines Claude Tool Use definitions for stage-specific metadata delivery.
 * These tools replace the JSON wrapper format for structured AI responses.
 */

import type { CapturedNeedInput, ParsedNeedAction, StreamMetadata } from '@meet-without-fear/shared';
import { NeedCategory, Stage4ProposalKind } from '@meet-without-fear/shared';
import type { AnthropicToolDef } from '../lib/bedrock';
import type {
  ParsedStage4ProposalAction,
  ParsedStage4ProposalClassification,
  ParsedStage4ProposalInput,
  ParsedStage4WalkthroughAction,
  ParsedStage4WalkthroughActionType,
} from '../utils/micro-tag-parser';

/**
 * Session state tool for delivering stage metadata via Tool Use.
 *
 * Claude calls this tool to provide state separately from visible prose:
 * - Stage 0: topicFrame
 * - Stage 1: offerFeelHeardCheck
 * - Stage 2: offerReadyToShare, proposedEmpathyStatement
 * - Stage 3: proposedNeed, proposedNeeds, needAction
 * - Stage 4: stage4Proposals, stage4WalkthroughAction
 *
 * The tool is designed so Claude only provides fields relevant to the current stage.
 */
export const SESSION_STATE_TOOL: AnthropicToolDef = {
  name: 'update_session_state',
  description: `Report structured session state for the current turn. Only include fields relevant to the current stage:
- Stage 0 (Topic): Set topicFrame when proposing or revising the conversation topic
- Stage 1 (Witnessing): Set offerFeelHeardCheck=true when the user seems fully heard
- Stage 2 (Empathy Building): Set offerReadyToShare=true and proposedEmpathyStatement when ready
- Stage 3 (What Matters): Use proposedNeed/proposedNeeds for captured needs and needAction for refine/delete/lock
- Stage 4 (Repair): Use stage4Proposals for proposal inventory changes and stage4WalkthroughAction for current-need progress.

Call this tool before your visible conversational response whenever the latest turn requires state capture or progress updates. Do not put tool JSON, internal reasoning, XML tags, or state summaries in visible text.`,
  input_schema: {
    type: 'object',
    properties: {
      topicFrame: {
        type: 'string',
        description: 'Stage 0 only: short neutral topic phrase/sentence, maximum 20 words, no names.',
      },
      offerFeelHeardCheck: {
        type: 'boolean',
        description:
          'Stage 1 only: Set to true when the user appears fully heard and ready for the feel-heard checkpoint.',
      },
      offerReadyToShare: {
        type: 'boolean',
        description: 'Stage 2 only: Set to true when the empathy statement is ready to share with their partner.',
      },
      proposedEmpathyStatement: {
        type: 'string',
        description: "Stage 2 only: The empathy statement draft in first person from the partner's perspective.",
      },
      proposedNeed: {
        description: 'Stage 3 only: one need to capture from the latest turn.',
        ...needInputSchema(),
      },
      proposedNeeds: {
        type: 'array',
        description:
          'Stage 3 legacy/bulk fallback: multiple needs to capture. Prefer proposedNeed for normal chat turns.',
        items: needInputSchema(),
      },
      needAction: {
        type: 'object',
        description: 'Stage 3 only: user-requested refinement, deletion, or lock for an existing need.',
        properties: {
          type: { type: 'string', enum: ['refine', 'delete', 'lock'] },
          needId: { type: ['string', 'null'] },
          supersedes: { type: ['string', 'null'] },
          need: { type: ['string', 'null'] },
          category: { type: ['string', 'null'], enum: [...Object.values(NeedCategory), null] },
          description: { type: ['string', 'null'] },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['type'],
        additionalProperties: false,
      },
      stage4Proposals: {
        type: 'array',
        description: 'Stage 4 only: structured proposal inventory actions for the latest user turn.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['ADD', 'REVISE', 'REMOVE', 'IGNORE'] },
            targetProposalId: { type: ['string', 'null'] },
            classification: { type: 'string', enum: ['PROPOSAL', 'REFLECTION', 'SUCCESS_MARKER', 'PROCESS'] },
            description: { type: 'string' },
            kind: { type: ['string', 'null'], enum: ['SHARED_PROPOSAL', 'INDIVIDUAL_COMMITMENT', null] },
            ownerUserId: { type: ['string', 'null'] },
            needsAddressed: {
              type: 'array',
              items: { type: 'string' },
              description: 'Human-readable need labels (e.g. "Partnership", "Understanding"). Never use internal IDs.',
            },
            duration: { type: ['string', 'null'] },
            measureOfSuccess: { type: ['string', 'null'] },
          },
          required: ['action', 'classification', 'description'],
          additionalProperties: false,
        },
      },
      stage4WalkthroughAction: {
        type: 'object',
        description: 'Stage 4 only: current-need walkthrough decision for the latest turn.',
        properties: {
          action: { type: 'string', enum: ['COVERED', 'SKIP', 'NONE'] },
          needId: { type: ['string', 'null'] },
          reason: { type: ['string', 'null'] },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

/**
 * Tool name constant for matching tool calls
 */
export const SESSION_STATE_TOOL_NAME = 'update_session_state';

/**
 * Type for the parsed tool input from SESSION_STATE_TOOL.
 *
 * This is exactly the structured-metadata payload that crosses the SSE wire,
 * so it is defined once in the shared streaming contract
 * (`shared/src/contracts/stream.ts`) and aliased here.
 */
export type SessionStateToolInput = StreamMetadata;

/**
 * Validate and normalize session state tool input.
 * Ensures type safety and default values.
 */
export function parseSessionStateToolInput(input: Record<string, unknown>): SessionStateToolInput {
  const stage4Proposals = parseStage4Proposals(input.stage4Proposals);
  const stage4WalkthroughAction = parseStage4WalkthroughAction(input.stage4WalkthroughAction);
  const proposedNeed = parseNeedInput(input.proposedNeed);
  const proposedNeeds = parseNeedInputs(input.proposedNeeds);
  const needAction = parseNeedAction(input.needAction);

  return {
    offerFeelHeardCheck: typeof input.offerFeelHeardCheck === 'boolean' ? input.offerFeelHeardCheck : undefined,
    offerReadyToShare: typeof input.offerReadyToShare === 'boolean' ? input.offerReadyToShare : undefined,
    topicFrame: parseOptionalString(input.topicFrame),
    proposedEmpathyStatement:
      typeof input.proposedEmpathyStatement === 'string' ? input.proposedEmpathyStatement.trim() : undefined,
    ...(proposedNeed ? { proposedNeed } : {}),
    ...(proposedNeeds.length > 0 ? { proposedNeeds } : {}),
    ...(needAction ? { needAction } : {}),
    ...(stage4Proposals.length > 0 ? { stage4Proposals } : {}),
    ...(stage4WalkthroughAction ? { stage4WalkthroughAction } : {}),
  };
}

function needInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      need: { type: 'string' },
      category: { type: 'string', enum: Object.values(NeedCategory) },
      description: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
    },
    required: ['need', 'category', 'description', 'evidence'],
    additionalProperties: false,
  };
}

function isNeedCategory(value: unknown): value is NeedCategory {
  return typeof value === 'string' && Object.values(NeedCategory).includes(value as NeedCategory);
}

function parseNeedInput(value: unknown): CapturedNeedInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const need = parseOptionalString(candidate.need);
  const description = parseOptionalString(candidate.description);
  if (!need || !description || !isNeedCategory(candidate.category)) return undefined;
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence.map(entry => parseOptionalString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  return {
    need,
    category: candidate.category,
    description,
    evidence,
  };
}

function parseNeedInputs(value: unknown): CapturedNeedInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CapturedNeedInput[] => {
    const parsed = parseNeedInput(item);
    return parsed ? [parsed] : [];
  });
}

function parseNeedAction(value: unknown): ParsedNeedAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;
  if (type !== 'refine' && type !== 'delete' && type !== 'lock') return undefined;
  const category = isNeedCategory(candidate.category) ? candidate.category : undefined;
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence.map(entry => parseOptionalString(entry)).filter((entry): entry is string => Boolean(entry))
    : undefined;
  return {
    type,
    needId: parseOptionalString(candidate.needId),
    supersedes: parseOptionalString(candidate.supersedes),
    need: parseOptionalString(candidate.need),
    category,
    description: parseOptionalString(candidate.description),
    evidence,
  };
}

function isStage4ProposalAction(value: unknown): value is ParsedStage4ProposalAction {
  return value === 'ADD' || value === 'REVISE' || value === 'REMOVE' || value === 'IGNORE';
}

function isStage4ProposalClassification(value: unknown): value is ParsedStage4ProposalClassification {
  return value === 'PROPOSAL' || value === 'REFLECTION' || value === 'SUCCESS_MARKER' || value === 'PROCESS';
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseStage4Proposals(value: unknown): ParsedStage4ProposalInput[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): ParsedStage4ProposalInput[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    if (!isStage4ProposalAction(candidate.action)) return [];
    if (!isStage4ProposalClassification(candidate.classification)) return [];
    const description = parseOptionalString(candidate.description);
    if (!description) return [];
    const kind =
      typeof candidate.kind === 'string' &&
      Object.values(Stage4ProposalKind).includes(candidate.kind as Stage4ProposalKind)
        ? (candidate.kind as Stage4ProposalKind)
        : undefined;
    const needsAddressed = Array.isArray(candidate.needsAddressed)
      ? candidate.needsAddressed
          .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          .map(entry => entry.trim())
      : undefined;

    return [
      {
        action: candidate.action,
        targetProposalId: parseOptionalString(candidate.targetProposalId),
        classification: candidate.classification,
        description,
        kind,
        ownerUserId: parseOptionalString(candidate.ownerUserId),
        needsAddressed,
        duration: parseOptionalString(candidate.duration),
        measureOfSuccess: parseOptionalString(candidate.measureOfSuccess),
      },
    ];
  });
}

function isStage4WalkthroughActionType(value: unknown): value is ParsedStage4WalkthroughActionType {
  return value === 'COVERED' || value === 'SKIP' || value === 'NONE';
}

function parseStage4WalkthroughAction(value: unknown): ParsedStage4WalkthroughAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isStage4WalkthroughActionType(candidate.action)) return undefined;
  return {
    action: candidate.action,
    needId: parseOptionalString(candidate.needId),
    reason: parseOptionalString(candidate.reason),
  };
}

/**
 * Get the tools array for a specific stage.
 * Currently returns SESSION_STATE_TOOL for all stages.
 */
export function getToolsForStage(_stage: number): AnthropicToolDef[] {
  return [SESSION_STATE_TOOL];
}
