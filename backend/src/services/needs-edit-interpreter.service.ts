import {
  InterpretNeedEditRequest,
  InterpretNeedEditResponse,
  NeedCategory,
  NeedEditOperation,
} from '@meet-without-fear/shared';
import { getModelCompletion } from '../lib/bedrock';
import { extractJsonFromResponse } from '../utils/json-extractor';
import { previewNeedEditOperations } from './needs-edit-applier.service';
import { listOwnNeeds, requireNeedOwner, toNeedRecord, type IdentifiedNeedRecord } from './needs';

type NeedRow = IdentifiedNeedRecord;

function numberedNeeds(needs: NeedRow[]): string {
  return needs.map((need, index) => `[${index + 1}] (${need.id}) ${need.need}`).join('\n');
}

function findNeedByOrdinal(request: string, needs: NeedRow[]): NeedRow | null {
  const lower = request.toLowerCase();
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  const index = words.findIndex((word) => lower.includes(word));
  if (index >= 0) return needs[index] ?? null;
  const match = lower.match(/\b(?:need\s*)?(\d+)\b/);
  if (match) return needs[Number(match[1]) - 1] ?? null;
  return null;
}

function fallbackInterpret(request: string, targetNeedId: string | undefined, needs: NeedRow[]): InterpretNeedEditResponse {
  const lower = request.toLowerCase();
  const target = targetNeedId
    ? needs.find((need) => need.id === targetNeedId)
    : findNeedByOrdinal(request, needs);

  if (lower.includes('remove') || lower.includes('delete')) {
    if (!target) {
      return {
        clarificationNeeded: true,
        clarificationMessage: 'Which need should I remove from your list?',
      };
    }
    const operations: NeedEditOperation[] = [{ type: 'removeNeed', needId: target.id }];
    return {
      plan: {
        summary: 'I can remove that need from your draft list.',
        operations,
        affectedNeeds: previewNeedEditOperations(operations, needs),
      },
    };
  }

  if (!targetNeedId && /\b(add|missing|also)\b/i.test(request)) {
    return {
      clarificationNeeded: true,
      clarificationMessage:
        'I can add this as a new need, but I need the AI draft first. Try describing the underlying need in one sentence.',
    };
  }

  if (!target) {
    return {
      clarificationNeeded: true,
      clarificationMessage: 'Which need should I change?',
    };
  }

  return {
    clarificationNeeded: true,
    clarificationMessage:
      'What should feel different about this need? I will propose revised wording before anything changes.',
  };
}

function normalizeOperations(value: unknown): NeedEditOperation[] {
  if (!value || typeof value !== 'object') return [];
  const operations = (value as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];
  return operations
    .filter((operation): operation is Record<string, unknown> => Boolean(operation) && typeof operation === 'object')
    .map((operation) => ({
      type: operation.type as NeedEditOperation['type'],
      needId: typeof operation.needId === 'string' ? operation.needId : undefined,
      newText: typeof operation.newText === 'string' ? operation.newText : undefined,
      text: typeof operation.text === 'string' ? operation.text : undefined,
      category: operation.category as NeedCategory | undefined,
      newCategory: operation.newCategory as NeedCategory | undefined,
    }));
}

export async function interpretNeedEditRequest(
  sessionId: string,
  userId: string,
  request: InterpretNeedEditRequest
): Promise<InterpretNeedEditResponse> {
  // The owner's own needs only (spec §1.4: need is owner-only, always).
  const participant = await requireNeedOwner(sessionId, userId);
  const needs: NeedRow[] = (await listOwnNeeds(participant.id)).map(toNeedRecord);

  if (needs.length === 0 && !/\b(add|missing|also)\b/i.test(request.request)) {
    return {
      clarificationNeeded: true,
      clarificationMessage: 'There are no needs in your draft list yet. What feels missing?',
    };
  }

  const systemPrompt = `You are a need editing assistant for Meet Without Fear.
Users give instructions about an AI-owned needs draft. They are not writing partner-facing messages.
Return strict JSON only.

Allowed operations:
- updateNeedText: { "type": "updateNeedText", "needId": string, "newText": string, "newCategory"?: NeedCategory }
- addNeed: { "type": "addNeed", "text": string, "category"?: NeedCategory }
- removeNeed: { "type": "removeNeed", "needId": string }

NeedCategory must be one of: ${Object.values(NeedCategory).join(', ')}.
Needs must be universal and self-referential. Do not draft demands like "I need them to stop..." Reframe to what matters to the user.
If the request is ambiguous, return { "clarificationNeeded": true, "clarificationMessage": "..." }.
Otherwise return { "summary": string, "operations": [...] }.
Numbered needs refer to the displayed list and targets refer to the original list.`;

  const history = request.conversationHistory
    ?.map((turn) => `User: ${turn.request}\nAssistant: ${turn.clarification ?? turn.plan?.summary ?? ''}`)
    .join('\n\n');

  const response = await getModelCompletion('haiku', {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Current needs:\n${numberedNeeds(needs) || '(none)'}\n\nTarget need ID: ${request.targetNeedId ?? '(none)'}\n\nPrior edit conversation:\n${history || '(none)'}\n\nRequest:\n${request.request}`,
      },
    ],
    maxTokens: 1000,
    operation: 'stage3-need-edit-interpret',
    sessionId,
    turnId: `${sessionId}:need-edit:${Date.now()}`,
  });

  if (!response) {
    return fallbackInterpret(request.request, request.targetNeedId, needs);
  }

  const parsed = extractJsonFromResponse(response) as Record<string, unknown>;
  if (parsed.clarificationNeeded === true) {
    return {
      clarificationNeeded: true,
      clarificationMessage:
        typeof parsed.clarificationMessage === 'string'
          ? parsed.clarificationMessage
          : 'Can you say which need you want to change?',
    };
  }

  const operations = normalizeOperations(parsed);
  if (operations.length === 0) {
    return fallbackInterpret(request.request, request.targetNeedId, needs);
  }

  const affectedNeeds = previewNeedEditOperations(operations, needs);
  return {
    plan: {
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'I can update your needs draft.',
      operations,
      affectedNeeds,
    },
  };
}
