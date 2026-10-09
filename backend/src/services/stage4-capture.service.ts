import { Prisma } from '../generated/prisma/client';
import {
  ProposalInventoryDTO,
  Stage4CoverageAuditDTO,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
} from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { refreshStage4NeedCoverage } from './stage4-coverage.service';
import { isSupersededStrategy } from '../utils/strategy-dedupe';

function normalizeNeedToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function needLabelMatches(label: string, need: string): boolean {
  const a = normalizeNeedToken(label);
  const b = normalizeNeedToken(need);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const tokensA = new Set(a.split(' ').filter((token) => token.length > 2));
  const tokensB = new Set(b.split(' ').filter((token) => token.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  const denom = Math.min(tokensA.size, tokensB.size);
  return denom > 0 && shared / denom >= 0.5;
}

async function getSessionMemberUserIds(sessionId: string): Promise<Set<string>> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      relationship: {
        select: {
          members: { select: { userId: true } },
        },
      },
    },
  });
  return new Set(session?.relationship.members.map((member) => member.userId) ?? []);
}

function validateOperationOwnerUserId(
  operation: Stage4InventoryOperation,
  memberUserIds: Set<string>,
  fallbackUserId: string
): Stage4InventoryOperation {
  if (!('ownerUserId' in operation) || !operation.ownerUserId) {
    return operation;
  }
  if (memberUserIds.has(operation.ownerUserId)) {
    return operation;
  }
  logger.warn('[stage4-capture] Ignoring non-member ownerUserId from AI output', {
    ownerUserId: operation.ownerUserId,
  });
  return { ...operation, ownerUserId: fallbackUserId };
}

export async function linkProposalToIdentifiedNeeds(
  proposalId: string,
  sessionId: string,
  needLabels: string[] | null | undefined
): Promise<number> {
  if (!needLabels || needLabels.length === 0) return 0;

  const needs = await prisma.identifiedNeed.findMany({
    where: { vessel: { sessionId } },
    select: { id: true, need: true },
  });
  if (needs.length === 0) return 0;
  const candidates = needs;

  const matchedNeedIds = new Set<string>();
  for (const label of needLabels) {
    for (const candidate of candidates) {
      if (label === candidate.id || needLabelMatches(label, candidate.need)) {
        matchedNeedIds.add(candidate.id);
      }
    }
  }
  if (matchedNeedIds.size === 0) return 0;

  let createdCount = 0;
  for (const needId of matchedNeedIds) {
    try {
      await prisma.strategyProposalNeed.upsert({
        where: { proposalId_needId: { proposalId, needId } },
        create: { proposalId, needId },
        update: {},
      });
      createdCount += 1;
    } catch (error) {
      logger.warn('[stage4-capture] Failed to link proposal to need', { proposalId, needId, error });
    }
  }
  return createdCount;
}

export type Stage4CaptureInput = {
  sessionId: string;
  userId: string;
  messageId: string;
  userMessage: string;
  aiResponse: string;
  currentInventory?: ProposalInventoryDTO;
  confirmedNeeds?: Stage4NeedDTO[];
  recentStage4Messages?: Array<{ role: 'USER' | 'AI'; userId?: string; content: string; timestamp: string }>;
  structuredProposals?: Stage4StructuredProposalInput[];
  compatibilityProposedStrategies?: string[];
  topicFrame?: string;
};

export type Stage4StructuredProposalInput = {
  action?: 'ADD' | 'REVISE' | 'REMOVE' | 'IGNORE';
  targetProposalId?: string;
  classification: 'PROPOSAL' | 'REFLECTION' | 'SUCCESS_MARKER' | 'PROCESS';
  description: string;
  kind?: Stage4ProposalKind;
  ownerUserId?: string;
  needsAddressed?: string[];
  duration?: string;
  measureOfSuccess?: string;
};

export type Stage4NeedDTO = {
  id?: string;
  label: string;
  sourceUserId?: string;
};

export type Stage4InventoryOperation =
  | {
      type: 'ADD_PROPOSAL';
      tempKey: string;
      kind: Stage4ProposalKind;
      ownerUserId?: string;
      description: string;
      needsAddressed: string[];
      duration?: string;
      measureOfSuccess?: string;
      capturedQuote?: string;
    }
  | {
      type: 'REVISE_PROPOSAL';
      proposalId: string;
      description?: string;
      needsAddressed?: string[];
      duration?: string;
      measureOfSuccess?: string;
      kind?: Stage4ProposalKind;
      ownerUserId?: string;
      reason?: string;
    }
  | {
      type: 'REMOVE_PROPOSAL';
      proposalId: string;
      reason?: string;
    }
  | {
      type: 'RESTORE_PROPOSAL';
      proposalId: string;
      reason?: string;
    };

export type Stage4SelectionCaptureDTO = {
  userId: string;
  decisions: Array<{
    proposalId: string;
    decision: Stage4SelectionDecision;
    note?: string;
  }>;
};

export type Stage4ClosureSignalDTO = {
  readyToClose: boolean;
  kind?: Stage4ClosureKind;
  reason?: Stage4ClosureReason;
  summary?: string;
};

export type Stage4TendingTimingDTO = {
  proposalId?: string;
  agreementId?: string;
  suggestedFollowUpDate?: string;
  sourceText?: string;
};

export type Stage4CaptureResult = {
  operations: Stage4InventoryOperation[];
  coverageAudit?: Stage4CoverageAuditDTO;
  selection?: Stage4SelectionCaptureDTO;
  closureSignal?: Stage4ClosureSignalDTO;
  tendingTiming?: Stage4TendingTimingDTO;
  confidence: number;
  rationale: string;
  appliedOperationCount: number;
  skippedOperationCount: number;
};

type ProposalRow = {
  id: string;
  sessionId: string;
  createdByUserId: string | null;
  description: string;
  needsAddressed: string[];
  duration: string | null;
  measureOfSuccess: string | null;
  kind: Stage4ProposalKind;
  status: Stage4ProposalStatus;
  removedAt: Date | null;
  removedByUserId: string | null;
  removalReason: string | null;
};

const CAPTURE_CONFIDENCE_THRESHOLD = 0.7;
const DESTRUCTIVE_CONFIDENCE_THRESHOLD = 0.85;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanProposalDescription(value: string): string {
  return value
    .replace(/^to\s+/i, '')
    .replace(/^(?:what\s+i\s+can\s+)?commit\s+to\s+is\s+/i, '')
    .replace(/^private\s+weekly\s+check[-\s]*in:\s*/i, '')
    .replace(/\s*\((?:shared proposal|(?:private\s+)?individual commitment|private commitment)\)\s*$/i, '')
    .replace(/\s+(?:please|maybe|i think|if that works)$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function hasEnoughSpecificity(description: string): boolean {
  const normalized = normalizeText(description);
  if (normalized.length < 12) return false;
  return !['communicate better', 'be nicer', 'try harder', 'do better'].includes(normalized);
}

function getOverlapScore(haystack: string, needle: string): number {
  const haystackWords = new Set(normalizeText(haystack).split(' ').filter(Boolean));
  const needleWords = normalizeText(needle).split(' ').filter((word) => word.length > 2);
  if (needleWords.length === 0) return 0;
  const overlap = needleWords.filter((word) => haystackWords.has(word)).length;
  return overlap / needleWords.length;
}

function findReferencedProposal(
  text: string,
  proposals: ProposalRow[],
  allowedStatus: Stage4ProposalStatus[]
): { proposal: ProposalRow | null; confidence: number } {
  const candidates = proposals.filter((proposal) => allowedStatus.includes(proposal.status));
  if (candidates.length === 0) return { proposal: null, confidence: 0 };

  const quoted = text.match(/["'“”](.+?)["'“”]/)?.[1];
  const referenceText = quoted ?? text;
  const direct = candidates.find((proposal) =>
    normalizeText(referenceText).includes(normalizeText(proposal.description))
  );
  if (direct) return { proposal: direct, confidence: quoted ? 0.95 : 0.9 };

  const scored = candidates
    .map((proposal) => ({ proposal, score: getOverlapScore(referenceText, proposal.description) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score >= 0.6) return { proposal: scored[0].proposal, confidence: 0.82 };

  if (candidates.length === 1 && /\b(that|it|this|the proposal|the idea)\b/i.test(text)) {
    return { proposal: candidates[0], confidence: 0.88 };
  }

  return { proposal: null, confidence: 0 };
}

function findLooseRevisionProposal(text: string, proposals: ProposalRow[]): { proposal: ProposalRow | null; confidence: number } {
  const candidates = proposals.filter((proposal) =>
    [Stage4ProposalStatus.ACTIVE, Stage4ProposalStatus.REVISED].includes(proposal.status)
  );
  const scored = candidates
    .map((proposal) => ({ proposal, score: getOverlapScore(text, proposal.description) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score >= 0.35 && (!scored[1] || scored[0].score - scored[1].score >= 0.15)) {
    return { proposal: scored[0].proposal, confidence: 0.86 };
  }
  return { proposal: null, confidence: 0 };
}

/**
 * Compatibility fallback for the legacy free-text `ProposedStrategy` capture
 * path. The authoritative source for proposal kind is the `kind` field on the
 * typed `<stage4_proposals>` block; this function is only reached when no typed
 * block was emitted.
 *
 * Uses only generic, scenario-agnostic signals (pronouns and common commitment
 * verbs). Scenario-specific regexes are explicitly avoided per the gold-loop
 * Stage 4 supplement. When uncertain, defaults to INDIVIDUAL_COMMITMENT — the
 * safer default, since auto-promoting an ambiguous fragment to a SHARED proposal
 * pulls the partner into a commitment they did not author.
 */
function inferProposalKind(text: string): Stage4ProposalKind {
  // Explicit individual-commitment self-references.
  if (/\b(?:mine alone|just for me|my commitment|individual commitment|my own)\b/i.test(text)) {
    return Stage4ProposalKind.INDIVIDUAL_COMMITMENT;
  }
  // Generic shared/joint phrasing.
  if (
    /\b(?:we|both of us|together|each of us|we each|one thing each)\b/i.test(text) ||
    /\blet's\b/i.test(text)
  ) {
    return Stage4ProposalKind.SHARED_PROPOSAL;
  }
  // First-person commitment phrasing.
  if (/\b(?:i can|i could|i will|i'll|i would|i want to|i am going to|i'm going to)\b/i.test(text)) {
    return Stage4ProposalKind.INDIVIDUAL_COMMITMENT;
  }
  // Uncertain — never auto-promote a fragment to SHARED.
  return Stage4ProposalKind.INDIVIDUAL_COMMITMENT;
}

function isNonCommitmentFirstPerson(raw: string): boolean {
  return [
    /\bi\s+can\s+(?:see|understand|recognize|hear|imagine|tell|appreciate)\b/i,
    /\bi\s+could\s+(?:see|understand|recognize|hear|imagine|tell|appreciate)\b/i,
    /\bi\s+would\s+(?:worry|be worried|be concerned|feel|think)\b/i,
    /\bi\s+(?:think|feel|worry|wonder|guess)\b/i,
  ].some((pattern) => pattern.test(raw));
}

function proposalWordCount(value: string): number {
  return normalizeText(value).split(' ').filter(Boolean).length;
}

function isConcreteProposal(description: string): boolean {
  return hasEnoughSpecificity(description);
}

const TOPIC_OVERLAP_THRESHOLD = 0.6;
const MIN_STEM_LENGTH = 4;

function normalizeWord(word: string): string {
  return word.replace(/[''\u2019]s$/i, '').replace(/(?:ing|tion|ment|ness|ates|ated|ting|ted|ies|es|ed|ly|s)$/i, '');
}

function fuzzyWordMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const stemA = normalizeWord(a);
  const stemB = normalizeWord(b);
  if (stemA.length >= MIN_STEM_LENGTH && stemB.length >= MIN_STEM_LENGTH && stemA === stemB) return true;
  return false;
}

function getTopicOverlapScore(haystack: string, needle: string): number {
  const haystackWords = normalizeText(haystack).split(' ').filter(Boolean);
  const needleWords = normalizeText(needle).split(' ').filter((word) => word.length > 2);
  if (needleWords.length === 0) return 0;
  const overlap = needleWords.filter((nw) => haystackWords.some((hw) => fuzzyWordMatch(hw, nw))).length;
  return overlap / needleWords.length;
}

function isTopicRestatement(description: string, topicFrame: string | undefined): boolean {
  if (!topicFrame) return false;
  return getTopicOverlapScore(description, topicFrame) >= TOPIC_OVERLAP_THRESHOLD;
}

function hasRemoveIntent(text: string): boolean {
  return [
    /\b(?:remove|delete)\b.*\b(?:proposal|idea|strategy|that|this|it|one)\b/i,
    /\b(?:drop|scratch)\s+(?:that|this|it|one|that one|this one)\b/i,
    /\b(?:take|taking)\s+(?:that|this|it|one|that one|this one|proposal|idea|strategy|that proposal|this proposal|that idea|this idea)\s+(?:off|back)\b/i,
    /\b(?:that|this|it|one|that one|this one)\s+comes\s+off(?:\s+the\s+list)?\b/i,
    /\bi'?m\s+taking\s+(?:that|this|it|one|that one|this one)\s+back\b/i,
  ].some((pattern) => pattern.test(text));
}

function extractAddOperations(input: Stage4CaptureInput): Stage4InventoryOperation[] {
  const operations: Stage4InventoryOperation[] = [];
  for (const proposal of input.structuredProposals ?? []) {
    const action = proposal.action ?? 'ADD';
    if (action === 'IGNORE') continue;
    if (action === 'REMOVE' && proposal.targetProposalId) {
      operations.push({
        type: 'REMOVE_PROPOSAL',
        proposalId: proposal.targetProposalId,
        reason: proposal.description,
      });
      continue;
    }
    if (proposal.classification !== 'PROPOSAL' || !proposal.kind) continue;
    const description = cleanProposalDescription(proposal.description);
    if (!description) continue;
    if (isTopicRestatement(description, input.topicFrame)) continue;
    if (action === 'REVISE' && proposal.targetProposalId) {
      operations.push({
        type: 'REVISE_PROPOSAL',
        proposalId: proposal.targetProposalId,
        description,
        kind: proposal.kind,
        ownerUserId: proposal.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT
          ? proposal.ownerUserId ?? input.userId
          : proposal.ownerUserId,
        needsAddressed: proposal.needsAddressed ?? [],
        duration: proposal.duration,
        measureOfSuccess: proposal.measureOfSuccess,
        reason: proposal.description,
      });
      continue;
    }
    operations.push({
      type: 'ADD_PROPOSAL',
      tempKey: `structured-${operations.length}`,
      kind: proposal.kind,
      ownerUserId: proposal.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT
        ? proposal.ownerUserId ?? input.userId
        : proposal.ownerUserId,
      description,
      needsAddressed: proposal.needsAddressed ?? [],
      duration: proposal.duration,
      measureOfSuccess: proposal.measureOfSuccess,
      capturedQuote: proposal.description,
    });
  }
  if (input.structuredProposals !== undefined) {
    return operations;
  }

  const compatibility = input.compatibilityProposedStrategies ?? [];

  compatibility.forEach((description, index) => {
    const cleaned = cleanProposalDescription(description);
    if (!isConcreteProposal(cleaned)) return;
    if (isTopicRestatement(cleaned, input.topicFrame)) return;
    const kind = inferProposalKind(description);
    operations.push({
      type: 'ADD_PROPOSAL',
      tempKey: `compat-${index}`,
      kind,
      ownerUserId: kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT ? input.userId : undefined,
      description: cleaned,
      needsAddressed: [],
      capturedQuote: description,
    });
  });

  const addPatterns = [
    /\b(?:what if we|we could|we can|we should|we might|let's|let us)\s+(.+?)(?:$|[.!?]\s)/gi,
    /\b(?:i can|i could|i will|i'll|i would|i want to|i am going to|i'm going to)\s+(.+?)(?:$|[.!?]\s)/gi,
  ];

  addPatterns.forEach((pattern) => {
    for (const match of input.userMessage.matchAll(pattern)) {
      const raw = match[0];
      if (/\b(?:not willing|willing|remove|delete|take .* off|drop that|change|revise|update)\b/i.test(raw)) {
        continue;
      }
      if (isNonCommitmentFirstPerson(raw)) continue;
      const description = cleanProposalDescription(match[1] ?? '');
      if (!isConcreteProposal(description)) continue;
      if (isTopicRestatement(description, input.topicFrame)) continue;
      const kind = inferProposalKind(raw);
      operations.push({
        type: 'ADD_PROPOSAL',
        tempKey: `heuristic-${operations.length}`,
        kind,
        ownerUserId: kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT ? input.userId : undefined,
        description,
        needsAddressed: [],
        capturedQuote: raw.trim(),
      });
    }
  });

  return operations;
}

function extractDestructiveOrRevisionOperation(
  text: string,
  proposals: ProposalRow[]
): { operation: Stage4InventoryOperation | null; confidence: number; lowConfidenceAction?: string } {
  if (hasRemoveIntent(text)) {
    const match = findReferencedProposal(text, proposals, [Stage4ProposalStatus.ACTIVE, Stage4ProposalStatus.REVISED]);
    if (match.proposal) {
      return {
        operation: {
          type: 'REMOVE_PROPOSAL',
          proposalId: match.proposal.id,
          reason: text,
        },
        confidence: match.confidence,
      };
    }
    return { operation: null, confidence: 0.4, lowConfidenceAction: 'REMOVE_PROPOSAL' };
  }

  if (/\b(?:restore|bring back|put back)\b/i.test(text)) {
    const match = findReferencedProposal(text, proposals, [Stage4ProposalStatus.REMOVED]);
    if (match.proposal) {
      return {
        operation: {
          type: 'RESTORE_PROPOSAL',
          proposalId: match.proposal.id,
          reason: text,
        },
        confidence: match.confidence,
      };
    }
    return { operation: null, confidence: 0.4, lowConfidenceAction: 'RESTORE_PROPOSAL' };
  }

  const reviseMatch = text.match(/\b(?:change|revise|update)\b.+?\bto\b\s+(.+?)(?:$|[.!?]\s)/i);
  if (reviseMatch) {
    const match = findReferencedProposal(text, proposals, [Stage4ProposalStatus.ACTIVE, Stage4ProposalStatus.REVISED]);
    const description = cleanProposalDescription(reviseMatch[1] ?? '');
    if (match.proposal && hasEnoughSpecificity(description)) {
      return {
        operation: {
          type: 'REVISE_PROPOSAL',
          proposalId: match.proposal.id,
          description,
          reason: text,
        },
        confidence: match.confidence,
      };
    }
    return { operation: null, confidence: 0.45, lowConfidenceAction: 'REVISE_PROPOSAL' };
  }

  if (/\b(?:should be|is|make it|mark it|keep it)\s+(?:an?\s+)?individual\b/i.test(text) || /\bnot shared\b/i.test(text)) {
    const directMatch = findReferencedProposal(text, proposals, [
      Stage4ProposalStatus.ACTIVE,
      Stage4ProposalStatus.REVISED,
    ]);
    const match = directMatch.proposal ? directMatch : findLooseRevisionProposal(text, proposals);
    if (match.proposal) {
      return {
        operation: {
          type: 'REVISE_PROPOSAL',
          proposalId: match.proposal.id,
          kind: Stage4ProposalKind.INDIVIDUAL_COMMITMENT,
          reason: text,
        },
        confidence: match.confidence,
      };
    }
    return { operation: null, confidence: 0.45, lowConfidenceAction: 'REVISE_PROPOSAL' };
  }

  return { operation: null, confidence: 0 };
}

function extractSelection(text: string, userId: string, proposals: ProposalRow[]): Stage4SelectionCaptureDTO | undefined {
  let decision: Stage4SelectionDecision | null = null;
  if (/\b(?:not willing|won't|do not want|don't want|no to)\b/i.test(text)) {
    decision = Stage4SelectionDecision.NOT_WILLING;
  } else if (/\b(?:willing|yes to|i can try|i'd try|i would try|works for me)\b/i.test(text)) {
    decision = Stage4SelectionDecision.WILLING;
  }
  if (!decision) return undefined;

  const match = findReferencedProposal(text, proposals, [Stage4ProposalStatus.ACTIVE, Stage4ProposalStatus.REVISED]);
  if (!match.proposal || match.confidence < CAPTURE_CONFIDENCE_THRESHOLD) return undefined;

  return {
    userId,
    decisions: [
      {
        proposalId: match.proposal.id,
        decision,
        note: text,
      },
    ],
  };
}

function inferClosureSignalFromUserMessage(message: string): Stage4ClosureSignalDTO | undefined {
  const explicitStop =
    /\b(?:stop here|stop this|close here|close this|right place to close|ready to close|no agreement|no shared agreement|without a shared agreement)\b/i.test(message) ||
    /\b(?:feels|feel|is)\s+complete\s+(?:for now|enough to close|as a stopping point|to stop here)\b/i.test(message);
  const declinesSharedRepair =
    /\b(?:not|don't|do not|can't|cannot)\s+(?:want|need|looking for|make|making|seeking)\s+(?:a\s+|another\s+)?(?:shared|couple|joint)\s+(?:strategy|agreement|plan|repair)\b/i.test(message) ||
    /\b(?:not|don't|do not|can't|cannot)\s+(?:ready\s+to\s+)?(?:turn|make)\s+this\s+into\s+(?:a\s+|another\s+)?(?:shared|couple|joint)\s+(?:strategy|agreement|plan|repair)\b/i.test(message) ||
    /\b(?:no|not another)\s+(?:shared|couple|joint)\s+(?:strategy|agreement|plan|repair)\b/i.test(message);

  if (!explicitStop && !declinesSharedRepair) return undefined;

  const boundaryLanguage = /\b(?:boundary|safety|safe|space|separat|ending|end this|protect)\b/i.test(message);

  return {
    readyToClose: true,
    kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
    reason: boundaryLanguage ? Stage4ClosureReason.BOUNDARY_HONORED : Stage4ClosureReason.USER_STOPPED,
    summary: message,
  };
}

function proposalSnapshot(proposal: ProposalRow): Prisma.JsonObject {
  return {
    description: proposal.description,
    needsAddressed: proposal.needsAddressed,
    duration: proposal.duration,
    measureOfSuccess: proposal.measureOfSuccess,
    kind: proposal.kind,
    status: proposal.status,
    removedAt: proposal.removedAt?.toISOString() ?? null,
    removedByUserId: proposal.removedByUserId,
    removalReason: proposal.removalReason,
  };
}

async function auditSkippedDestructiveCapture(
  proposals: ProposalRow[],
  input: Stage4CaptureInput,
  action: string,
  confidence: number
): Promise<void> {
  const match = findReferencedProposal(input.userMessage, proposals, [
    Stage4ProposalStatus.ACTIVE,
    Stage4ProposalStatus.REVISED,
    Stage4ProposalStatus.REMOVED,
  ]);
  if (!match.proposal) {
    logger.info('[stage4-capture] Skipped low-confidence destructive capture without proposal match', {
      sessionId: input.sessionId,
      userId: input.userId,
      action,
      confidence,
    });
    return;
  }

  await prisma.stage4ProposalRevision.create({
    data: {
      proposalId: match.proposal.id,
      sessionId: input.sessionId,
      actorUserId: input.userId,
      action: 'CAPTURE_SKIPPED',
      before: proposalSnapshot(match.proposal),
      after: { requestedAction: action, confidence },
      reason: 'Low-confidence destructive Stage 4 capture was not applied.',
      messageId: input.messageId,
    },
  });
}

async function applyOperation(
  operation: Stage4InventoryOperation,
  input: Stage4CaptureInput,
  proposals: ProposalRow[]
): Promise<boolean> {
  if (operation.type === 'ADD_PROPOSAL') {
    const activeProposals = proposals.filter((proposal) => proposal.status !== Stage4ProposalStatus.REMOVED);
    const duplicate = proposals.find(
      (proposal) =>
        proposal.status !== Stage4ProposalStatus.REMOVED &&
        normalizeText(proposal.description) === normalizeText(operation.description)
    );
    if (duplicate) return false;
    const superseded = activeProposals.find((proposal) =>
      isSupersededStrategy(proposal.description, operation.description)
    );
    if (superseded) {
      await prisma.strategyProposal.update({
        where: { id: superseded.id },
        data: {
          description: operation.description,
          needsAddressed: operation.needsAddressed,
          duration: operation.duration,
          measureOfSuccess: operation.measureOfSuccess,
          kind: operation.kind,
          status: Stage4ProposalStatus.ACTIVE,
        },
      });
      const beforeSnapshot = proposalSnapshot(superseded);
      Object.assign(superseded, {
        description: operation.description,
        needsAddressed: operation.needsAddressed,
        duration: operation.duration ?? null,
        measureOfSuccess: operation.measureOfSuccess ?? null,
        kind: operation.kind,
        status: Stage4ProposalStatus.ACTIVE,
      });
      await prisma.stage4ProposalRevision.create({
        data: {
          proposalId: superseded.id,
          sessionId: input.sessionId,
          actorUserId: input.userId,
          action: 'REVISED',
          before: beforeSnapshot,
          after: proposalSnapshot(superseded),
          reason: 'Captured refined Stage 4 proposal superseding an existing draft.',
          messageId: input.messageId,
        },
      });
      await linkProposalToIdentifiedNeeds(
        superseded.id,
        input.sessionId,
        operation.needsAddressed
      );
      return true;
    }

    const created = await prisma.strategyProposal.create({
      data: {
        sessionId: input.sessionId,
        createdByUserId: operation.ownerUserId ?? input.userId,
        description: operation.description,
        needsAddressed: operation.needsAddressed,
        duration: operation.duration,
        measureOfSuccess: operation.measureOfSuccess,
        source: 'AI_SUGGESTED',
        kind: operation.kind,
        status: Stage4ProposalStatus.ACTIVE,
        capturedFromMessageId: input.messageId,
      },
    });
    proposals.push({
      id: created.id,
      sessionId: input.sessionId,
      createdByUserId: operation.ownerUserId ?? input.userId,
      description: operation.description,
      needsAddressed: operation.needsAddressed,
      duration: operation.duration ?? null,
      measureOfSuccess: operation.measureOfSuccess ?? null,
      kind: operation.kind,
      status: Stage4ProposalStatus.ACTIVE,
      removedAt: null,
      removedByUserId: null,
      removalReason: null,
      parentProposalId: null,
      coverageSummary: null,
      capturedFromMessageId: input.messageId,
      createdAt: new Date(),
      updatedAt: new Date(),
      consentRecordId: null,
    } as ProposalRow);
    await prisma.stage4ProposalRevision.create({
      data: {
        proposalId: created.id,
        sessionId: input.sessionId,
        actorUserId: input.userId,
        action: 'CREATED',
        before: Prisma.JsonNull,
        after: {
          description: operation.description,
          needsAddressed: operation.needsAddressed,
          duration: operation.duration ?? null,
          measureOfSuccess: operation.measureOfSuccess ?? null,
          kind: operation.kind,
          status: Stage4ProposalStatus.ACTIVE,
          capturedQuote: operation.capturedQuote ?? null,
        },
        reason: 'Captured from Stage 4 conversation.',
        messageId: input.messageId,
      },
    });
    await linkProposalToIdentifiedNeeds(
      created.id,
      input.sessionId,
      operation.needsAddressed
    );
    return true;
  }

  const proposal = proposals.find((candidate) => candidate.id === operation.proposalId);
  if (!proposal) return false;

  if (operation.type === 'REMOVE_PROPOSAL') {
    await prisma.strategyProposal.update({
      where: { id: operation.proposalId },
      data: {
        status: Stage4ProposalStatus.REMOVED,
        removedAt: new Date(),
        removedByUserId: input.userId,
        removalReason: operation.reason,
      },
    });
    await prisma.stage4ProposalRevision.create({
      data: {
        proposalId: operation.proposalId,
        sessionId: input.sessionId,
        actorUserId: input.userId,
        action: 'REMOVED',
        before: proposalSnapshot(proposal),
        after: {
          ...proposalSnapshot(proposal),
          status: Stage4ProposalStatus.REMOVED,
          removedByUserId: input.userId,
          removalReason: operation.reason ?? null,
        },
        reason: operation.reason,
        messageId: input.messageId,
      },
    });
    return true;
  }

  if (operation.type === 'RESTORE_PROPOSAL') {
    await prisma.strategyProposal.update({
      where: { id: operation.proposalId },
      data: {
        status: Stage4ProposalStatus.ACTIVE,
        removedAt: null,
        removedByUserId: null,
        removalReason: null,
      },
    });
    await prisma.stage4ProposalRevision.create({
      data: {
        proposalId: operation.proposalId,
        sessionId: input.sessionId,
        actorUserId: input.userId,
        action: 'RESTORED',
        before: proposalSnapshot(proposal),
        after: {
          ...proposalSnapshot(proposal),
          status: Stage4ProposalStatus.ACTIVE,
          removedAt: null,
          removedByUserId: null,
          removalReason: null,
        },
        reason: operation.reason,
        messageId: input.messageId,
      },
    });
    return true;
  }

  await prisma.strategyProposal.update({
    where: { id: operation.proposalId },
    data: {
      description: operation.description ?? proposal.description,
      needsAddressed: operation.needsAddressed ?? proposal.needsAddressed,
      duration: operation.duration ?? proposal.duration,
      measureOfSuccess: operation.measureOfSuccess ?? proposal.measureOfSuccess,
      kind: operation.kind ?? proposal.kind,
      createdByUserId:
        operation.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT
          ? input.userId
          : operation.ownerUserId ?? proposal.createdByUserId,
      status: Stage4ProposalStatus.ACTIVE,
    },
  });
  await prisma.stage4ProposalRevision.create({
    data: {
      proposalId: operation.proposalId,
      sessionId: input.sessionId,
      actorUserId: input.userId,
      action: 'REVISED',
      before: proposalSnapshot(proposal),
      after: {
        ...proposalSnapshot(proposal),
        description: operation.description ?? proposal.description,
        needsAddressed: operation.needsAddressed ?? proposal.needsAddressed,
        duration: operation.duration ?? proposal.duration,
        measureOfSuccess: operation.measureOfSuccess ?? proposal.measureOfSuccess,
        kind: operation.kind ?? proposal.kind,
        status: Stage4ProposalStatus.ACTIVE,
      },
      reason: operation.reason,
      messageId: input.messageId,
    },
  });
  if (operation.needsAddressed) {
    await linkProposalToIdentifiedNeeds(
      operation.proposalId,
      input.sessionId,
      operation.needsAddressed
    );
  }
  return true;
}

export async function captureStage4Turn(input: Stage4CaptureInput): Promise<Stage4CaptureResult> {
  const proposals = (await prisma.strategyProposal.findMany({
    where: { sessionId: input.sessionId },
    orderBy: { updatedAt: 'desc' },
  })) as ProposalRow[];

  const rawOperations = extractAddOperations(input);
  const destructiveOrRevision = extractDestructiveOrRevisionOperation(input.userMessage, proposals);
  if (destructiveOrRevision.operation) {
    rawOperations.push(destructiveOrRevision.operation);
  }
  const sessionMemberUserIds = await getSessionMemberUserIds(input.sessionId);
  const operations = rawOperations.map((operation) =>
    validateOperationOwnerUserId(operation, sessionMemberUserIds, input.userId)
  );

  const selection = extractSelection(input.userMessage, input.userId, proposals);
  const confidence = operations.length > 0 || selection
    ? Math.max(
        input.structuredProposals !== undefined && operations.length > 0 ? 0.92 : 0,
        operations.some((operation) => operation.type === 'ADD_PROPOSAL') ? 0.78 : 0,
        destructiveOrRevision.confidence,
        selection ? 0.82 : 0
      )
    : 0;

  let appliedOperationCount = 0;
  let skippedOperationCount = 0;

  if (destructiveOrRevision.lowConfidenceAction && destructiveOrRevision.confidence < DESTRUCTIVE_CONFIDENCE_THRESHOLD) {
    skippedOperationCount += 1;
    await auditSkippedDestructiveCapture(
      proposals,
      input,
      destructiveOrRevision.lowConfidenceAction,
      destructiveOrRevision.confidence
    );
  }

  for (const operation of operations) {
    const isDestructive = operation.type === 'REMOVE_PROPOSAL' || operation.type === 'RESTORE_PROPOSAL';
    const requiredConfidence = isDestructive ? DESTRUCTIVE_CONFIDENCE_THRESHOLD : CAPTURE_CONFIDENCE_THRESHOLD;
    const operationConfidence = isDestructive ? destructiveOrRevision.confidence : confidence;
    if (operationConfidence < requiredConfidence) {
      skippedOperationCount += 1;
      continue;
    }
    const applied = await applyOperation(operation, input, proposals);
    if (applied) appliedOperationCount += 1;
    else skippedOperationCount += 1;
  }

  if (appliedOperationCount > 0) {
    await refreshStage4NeedCoverage(input.sessionId);
  }

  if (selection) {
    for (const decision of selection.decisions) {
      await prisma.stage4ProposalSelection.upsert({
        where: {
          proposalId_userId: {
            proposalId: decision.proposalId,
            userId: input.userId,
          },
        },
        create: {
          proposalId: decision.proposalId,
          sessionId: input.sessionId,
          userId: input.userId,
          decision: decision.decision,
          note: decision.note,
        },
        update: {
          decision: decision.decision,
          note: decision.note,
          selectedAt: new Date(),
        },
      });
    }
  }

  return {
    operations,
    selection,
    closureSignal: inferClosureSignalFromUserMessage(input.userMessage),
    confidence,
    rationale: operations.length > 0 || selection
      ? 'Captured deterministic Stage 4 inventory or selection signal from the conversation turn.'
      : 'No high-confidence Stage 4 inventory operation detected.',
    appliedOperationCount,
    skippedOperationCount,
  };
}
