/**
 * Embedding Service — disabled on the target shape (TS-12, spec D8).
 *
 * The three pgvector columns this service wrote and searched
 * (`UserVessel.contentEmbedding`, `InnerWorkSession.contentEmbedding`,
 * `SessionTakeaway.embedding`) are dropped by the target schema (spec §1.6
 * takeaway "minus embedding (D8)", §5 "`Unsupported`: none remain — the three
 * `vector(1024)` columns go with D8"). Until semantic search is rebuilt
 * app-side (an encrypted vector blob, or a search service — plan §5
 * "takeaway semantic search disabled or app-side"), every function keeps its
 * signature and does nothing:
 *
 * - the `embed*` writers return `false` (nothing stored) without calling the
 *   embedding model, so no Titan cost is spent on vectors nobody can read;
 * - the `search*` / `find*` readers return `[]`, so callers fall back to
 *   their non-semantic paths (retrieval: recent messages only; knowledge
 *   base: an empty search result).
 *
 * TODO(D8): rebuild semantic search over reflections/takeaways app-side and
 * restore these functions; until then no caller may assume a hit.
 */

import { logger } from '../lib/logger';
import { getEmbedding } from '../lib/bedrock';

// ============================================================================
// Types (unchanged — callers and DTO mappers keep compiling)
// ============================================================================

export interface SessionSummary {
  id: string;
  partnerName: string;
  topic?: string;
  recentContext?: string;
  status: string;
}

export interface SimilarSession {
  sessionId: string;
  partnerName: string;
  similarity: number;
}

/** A categorized fact from the fact-ledger */
export interface CategorizedFact {
  category: string;
  fact: string;
}

/** Result from session content search */
export interface SessionContentMatch {
  sessionId: string;
  vesselId: string;
  similarity: number;
  partnerName: string;
  facts?: CategorizedFact[];
}

/** Result from takeaway semantic search */
export interface TakeawaySearchMatch {
  takeawayId: string;
  content: string;
  theme: string | null;
  type: string;
  sessionId: string;
  sessionDate: string;
  similarity: number;
}

const disabled = (fn: string): void => {
  logger.debug(`[Embedding] ${fn}: semantic search is disabled on the target shape — TODO(D8)`);
};

/**
 * Check if embeddings are enabled (Bedrock credentials available). This still
 * asks the model: it answers "can we embed", not "do we store vectors".
 */
export async function isEmbeddingEnabled(): Promise<boolean> {
  const testEmbedding = await getEmbedding('test');
  return testEmbedding !== null;
}

// ============================================================================
// Writers — store nothing (TODO(D8))
// ============================================================================

export async function embedSessionContent(_sessionId: string, _userId: string, _turnId?: string): Promise<boolean> {
  disabled('embedSessionContent');
  return false;
}

export async function embedInnerWorkSessionContent(_sessionId: string, _turnId?: string): Promise<boolean> {
  disabled('embedInnerWorkSessionContent');
  return false;
}

export async function embedTakeaway(_takeawayId: string, _content: string, _turnId?: string): Promise<boolean> {
  disabled('embedTakeaway');
  return false;
}

/** Returns the ids of the takeaways embedded: none. */
export async function embedTakeawayBatch(
  _takeaways: Array<{ id: string; content: string }>,
  _turnId?: string,
): Promise<string[]> {
  disabled('embedTakeawayBatch');
  return [];
}

// ============================================================================
// Readers — find nothing (TODO(D8))
// ============================================================================

export async function searchSessionContent(
  _userId: string,
  _queryText: string,
  _limit: number = 5,
  _threshold: number = 0.5,
  _turnId?: string,
): Promise<SessionContentMatch[]> {
  disabled('searchSessionContent');
  return [];
}

export async function searchInnerWorkSessionContent(
  _userId: string,
  _queryText: string,
  _linkedPartnerSessionId?: string,
  _boostFactor: number = 1.3,
  _limit: number = 5,
  _threshold: number = 0.5,
  _turnId?: string,
  _sessionId?: string,
): Promise<Array<{ sessionId: string; theme: string | null; similarity: number; isLinked: boolean }>> {
  disabled('searchInnerWorkSessionContent');
  return [];
}

export async function searchTakeaways(
  _userId: string,
  _queryText: string,
  _limit: number = 10,
  _threshold: number = 0.5,
  _turnId?: string,
): Promise<TakeawaySearchMatch[]> {
  disabled('searchTakeaways');
  return [];
}

export async function findSimilarTakeaways(
  _takeawayId: string,
  _userId: string,
  _sessionId: string,
  _threshold: number = 0.55,
  _limit: number = 5,
): Promise<Array<{ takeawayId: string; similarity: number }>> {
  disabled('findSimilarTakeaways');
  return [];
}

/** @deprecated Use searchSessionContent instead */
export async function findSimilarSessions(
  _userId: string,
  _queryText: string,
  _limit: number = 5,
  _threshold: number = 0.7,
  _turnId?: string,
): Promise<SimilarSession[]> {
  disabled('findSimilarSessions');
  return [];
}

/** @deprecated Use searchSessionContent instead */
export async function findRelevantSessions(
  _userId: string,
  _userMessage: string,
  _limit: number = 3,
  _turnId?: string,
): Promise<SimilarSession[]> {
  disabled('findRelevantSessions');
  return [];
}
