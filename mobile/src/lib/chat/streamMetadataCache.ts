/**
 * Applying stream metadata to the query cache.
 *
 * When the model's tool call arrives mid-stream, some of it must reach the UI
 * immediately (so panels open while text is still streaming) and some of it
 * must be refetched from the server (because the authoritative record is
 * written server-side).
 *
 * The split matters: broad invalidation during an active stream races the
 * optimistic writes and makes indicators flicker, so the direct-write path is
 * kept deliberately narrow and the invalidation path is kept explicit.
 *
 * The nested cache transforms are exported separately because they are pure and
 * the nesting is where mistakes hide — writing to the wrong depth silently
 * no-ops rather than throwing.
 */

import type { QueryKey } from '@tanstack/react-query';
import type { StreamMetadata } from '@meet-without-fear/shared';
import { sessionKeys, stageKeys } from '../../hooks/queryKeys';

type UnknownRecord = Record<string, unknown>;

/**
 * Seed the empathy draft the model just proposed.
 *
 * `readyToShare` is forced false: a freshly proposed draft has not been
 * consented to, and inheriting a stale `true` here would let the previous
 * draft's consent carry over to new text the user has not seen.
 */
export function withProposedEmpathyDraft(
  old: UnknownRecord | undefined,
  proposedEmpathyStatement: string
): UnknownRecord {
  return {
    ...old,
    draft: {
      ...(old?.draft as UnknownRecord | undefined),
      content: proposedEmpathyStatement,
      readyToShare: false,
    },
    canConsent: true,
    alreadyConsented: false,
  };
}

/**
 * Keys to refetch because the metadata references state the server owns.
 *
 * Intentionally narrow. Anything that can be written directly is written
 * directly (see `streamMetadataCacheWrites`) — invalidating during an active
 * stream overwrites in-flight optimistic updates and makes panels flicker.
 */
export function metadataInvalidationKeys(
  sessionId: string,
  metadata: StreamMetadata
): QueryKey[] {
  const keys: QueryKey[] = [];

  // Stage 3 needs are persisted server-side as a structured card, so the
  // cache cannot be updated from the metadata alone.
  if (metadata.proposedNeeds && metadata.proposedNeeds.length > 0) {
    keys.push(stageKeys.progress(sessionId), sessionKeys.state(sessionId));
  }

  if (
    metadata.stage4Proposals ||
    metadata.stage4WalkthroughAction ||
    metadata.stage4Capture
  ) {
    keys.push(
      stageKeys.stage4(sessionId),
      stageKeys.strategies(sessionId),
      stageKeys.agreements(sessionId),
      stageKeys.progress(sessionId)
    );
  }

  return keys;
}

/** A direct cache write: apply `update` to whatever is at `queryKey`. */
export interface StreamMetadataCacheWrite {
  queryKey: QueryKey;
  update: (old: UnknownRecord | undefined) => UnknownRecord | undefined;
}

/**
 * The direct cache writes implied by this metadata, in application order.
 *
 * Returned rather than applied so the policy can be tested without a query
 * client, and so the caller keeps a single place where cache mutation happens.
 */
export function streamMetadataCacheWrites(
  sessionId: string,
  metadata: StreamMetadata
): StreamMetadataCacheWrite[] {
  const writes: StreamMetadataCacheWrite[] = [];

  // `offerFeelHeardCheck` is not written to the cache: the target persists no
  // "check offered" fact (plan §3 step 7; it was a key in the deleted
  // gatesSatisfied JSON), so the stream trigger is the only signal —
  // useUnifiedSession's `streamTriggeredFeelHeard` (work-keq6).

  if (metadata.proposedEmpathyStatement) {
    const statement = metadata.proposedEmpathyStatement;
    writes.push({
      // Must be stageKeys.empathyDraft — this is the key useEmpathyDraft reads.
      queryKey: stageKeys.empathyDraft(sessionId),
      update: (old) => withProposedEmpathyDraft(old, statement),
    });
  }

  return writes;
}
