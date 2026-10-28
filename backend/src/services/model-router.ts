import type { ModelType } from '../lib/bedrock';

export type RequestType = 'mediate' | 'summarize' | 'rewrite' | 'classify' | 'draft' | 'retrieve' | 'unknown';

export interface RoutingInput {
  requestType: RequestType;
  conflictIntensity: number;
  ambiguityScore: number;
  messageLength: number;
}

export interface RoutingDecision {
  model: ModelType;
  score: number;
  reasons: string[];
}

export function scoreAmbiguity(message: string): number {
  const questionMarks = (message.match(/\?/g) ?? []).length;
  const vagueTerms = ['maybe', 'not sure', 'kinda', 'sort of', 'something', 'stuff'];
  const vaguenessHits = vagueTerms.filter(term => message.toLowerCase().includes(term)).length;
  const lengthFactor = Math.min(message.length / 600, 1);
  return Math.min(1, questionMarks * 0.2 + vaguenessHits * 0.15 + lengthFactor * 0.2);
}

export function routeModel(input: RoutingInput): RoutingDecision {
  const reasons: string[] = [];
  let score = 0;

  switch (input.requestType) {
    case 'mediate':
      score += 4;
      reasons.push('mediation-response');
      break;
    case 'draft':
      score += 1;
      reasons.push('drafting');
      break;
    case 'rewrite':
    case 'summarize':
    case 'classify':
    case 'retrieve':
      score -= 1;
      reasons.push(input.requestType);
      break;
    default:
      reasons.push('unknown');
      break;
  }

  if (input.conflictIntensity >= 8) {
    score += 3;
    reasons.push('high-intensity');
  } else if (input.conflictIntensity >= 6) {
    score += 1;
    reasons.push('medium-intensity');
  }

  if (input.ambiguityScore >= 0.5) {
    score += 2;
    reasons.push('ambiguous');
  }

  if (input.messageLength > 500) {
    score += 1;
    reasons.push('long-message');
  }

  const model: ModelType = score >= 4 ? 'sonnet' : 'haiku';
  return { model, score, reasons };
}
