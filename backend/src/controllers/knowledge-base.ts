/**
 * Knowledge Base Controllers
 *
 * Read-side API for browsing the inner thoughts knowledge base:
 * - GET /knowledge-base/topics - Sessions grouped by theme tag
 * - GET /knowledge-base/topics/:tag - Chronological timeline for a given theme
 * - GET /knowledge-base/themes - Recurring themes sorted by frequency
 *
 * Target shape (TS-12): reflections are `reflection`, takeaways `takeaway`,
 * links `takeaway_link` (composite key: a link's id is `<source>.<target>`),
 * themes are `v_reflection_theme`. Everything is the caller's own
 * (reflection.user_id = me, spec §1.6). Semantic search is disabled until the
 * takeaway embeddings are rebuilt app-side — TODO(D8).
 */

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import type { Prisma } from '../generated/prisma/client';
import { getUser } from '../middleware/auth';
import { asyncHandler, NotFoundError, ValidationError } from '../middleware/errors';
import { mapTakeawayToDTO } from '../services/distillation';
import type {
  ApiResponse,
  KnowledgeBaseTopicDTO,
  TopicSessionEntryDTO,
  ListTopicsResponse,
  GetTopicTimelineResponse,
  RecurringThemeDTO,
  ListRecurringThemesResponse,
  SearchKnowledgeBaseResponse,
  RecentTakeawaysResponse,
  TakeawayLinkDTO,
  GetTakeawayLinksResponse,
  CreateTakeawayLinkRequest,
  CreateTakeawayLinkResponse,
  DeleteTakeawayLinkResponse,
  TakeawayThreadDTO,
  TakeawayDTO,
  ResolveTakeawayResponse,
  ListActionsResponse,
} from '@meet-without-fear/shared';

// ============================================================================
// Helpers
// ============================================================================

const TAKEAWAY_WITH_DATE = {
  include: { reflection: { select: { createdAt: true } } },
} as const;

type TakeawayRow = Prisma.TakeawayGetPayload<Record<string, never>>;
type TakeawayWithDate = Prisma.TakeawayGetPayload<typeof TAKEAWAY_WITH_DATE>;

/** A link's public id: the composite key (`takeaway_link` has no id column). */
export function linkIdOf(link: { sourceId: string; targetId: string }): string {
  return `${link.sourceId}.${link.targetId}`;
}

function parseLinkId(linkId: string): { sourceId: string; targetId: string } | null {
  const [sourceId, targetId, extra] = linkId.split('.');
  if (!sourceId || !targetId || extra !== undefined) return null;
  return { sourceId, targetId };
}

/** A takeaway the caller owns (through its reflection), or null. */
function ownTakeaway(userId: string, takeawayId: string) {
  return prisma.takeaway.findFirst({
    where: { id: takeawayId, reflection: { userId } },
    ...TAKEAWAY_WITH_DATE,
  });
}

/**
 * Maps a reflection (with takeaways) to a TopicSessionEntryDTO.
 */
function mapSessionToTopicEntry(session: {
  id: string;
  title: string | null;
  createdAt: Date;
  takeaways: TakeawayRow[];
}): TopicSessionEntryDTO {
  return {
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    takeaways: session.takeaways.map((t) => ({
      id: t.id,
      content: t.content,
      theme: t.theme,
      type: t.type,
      resolved: t.resolvedAt !== null,
    })),
  };
}

function linkedTakeawayOf(t: TakeawayWithDate): TakeawayLinkDTO['linkedTakeaway'] {
  return {
    id: t.id,
    content: t.content,
    theme: t.theme,
    type: t.type,
    sessionDate: t.reflection.createdAt.toISOString(),
  };
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * GET /knowledge-base/topics
 * Returns all sessions grouped by theme tag. Groups are sorted by lastActivity
 * descending (most recently active topic first). Sessions with null theme are
 * excluded. ARCHIVED sessions are excluded.
 */
export const listTopics = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);

  const sessions = await prisma.reflection.findMany({
    where: {
      userId: user.id,
      status: { not: 'ARCHIVED' },
      theme: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      takeaways: { orderBy: { position: 'asc' } },
    },
  });

  // Group in application layer (Prisma groupBy does not support include)
  const topicMap = new Map<string, KnowledgeBaseTopicDTO>();

  for (const session of sessions) {
    const tag = session.theme!; // guaranteed non-null by where clause
    const entry = mapSessionToTopicEntry(session);

    const existing = topicMap.get(tag);
    if (existing) {
      existing.sessionCount += 1;
      existing.takeawayCount += session.takeaways.length;
      // Track the most recent updatedAt as lastActivity
      if (session.updatedAt.toISOString() > existing.lastActivity) {
        existing.lastActivity = session.updatedAt.toISOString();
      }
      existing.sessions.push(entry);
    } else {
      topicMap.set(tag, {
        tag,
        sessionCount: 1,
        takeawayCount: session.takeaways.length,
        lastActivity: session.updatedAt.toISOString(),
        sessions: [entry],
      });
    }
  }

  // Sort groups by lastActivity descending (most recent first)
  const topics = Array.from(topicMap.values()).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  const response: ApiResponse<ListTopicsResponse> = {
    success: true,
    data: { topics },
  };

  res.json(response);
});

/**
 * GET /knowledge-base/topics/:tag
 * Returns sessions for a given theme tag in chronological order (oldest first).
 * The tag parameter is URL-decoded to handle spaces and special characters.
 */
export const getTopicTimeline = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  // CRITICAL: always decode to handle spaces and special characters
  const tag = decodeURIComponent(req.params.tag);

  const sessions = await prisma.reflection.findMany({
    where: {
      userId: user.id,
      theme: tag,
      status: { not: 'ARCHIVED' },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      takeaways: { orderBy: { position: 'asc' } },
    },
  });

  const response: ApiResponse<GetTopicTimelineResponse> = {
    success: true,
    data: {
      tag,
      sessions: sessions.map(mapSessionToTopicEntry),
    },
  };

  res.json(response);
});

/** A theme recurs once this many of the user's reflections carry it (the old threshold, unchanged). */
export const RECURRING_THEME_MIN_REFLECTIONS = 3;

/**
 * GET /knowledge-base/themes
 * Recurring themes for the user from `v_reflection_theme` (spec §4; replaces
 * RecurringTheme), sorted by count descending. Only themes on 3+ reflections
 * are recurring (the old background threshold). The view stores no LLM
 * summary: `summary` is empty and `summaryAt` is the theme's latest activity.
 */
export const listRecurringThemes = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);

  const themes = await prisma.$queryRaw<Array<{ theme: string; reflection_count: number; latest_updated_at: Date }>>`SELECT theme, reflection_count::int AS reflection_count, latest_updated_at
    FROM v_reflection_theme
    WHERE user_id = ${user.id}::uuid AND reflection_count >= ${RECURRING_THEME_MIN_REFLECTIONS}
    ORDER BY reflection_count DESC, latest_updated_at DESC, theme`;

  const response: ApiResponse<ListRecurringThemesResponse> = {
    success: true,
    data: {
      themes: themes.map(
        (t): RecurringThemeDTO => ({
          tag: t.theme,
          sessionCount: t.reflection_count,
          summary: '',
          summaryAt: new Date(t.latest_updated_at).toISOString(),
          updatedAt: new Date(t.latest_updated_at).toISOString(),
        })
      ),
    },
  };

  res.json(response);
});

// ============================================================================
// Search (SEARCH-01, SEARCH-02, SEARCH-03)
// ============================================================================

/**
 * GET /knowledge-base/search?q=<text>&limit=10
 * Semantic search across takeaways. TODO(D8): the takeaway embedding column
 * is dropped on the target (spec §1.6 takeaway, D8); until the search is
 * rebuilt app-side every query answers an empty result.
 */
export const searchKnowledgeBase = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  getUser(req);
  const query = (req.query.q as string) || '';

  const response: ApiResponse<SearchKnowledgeBaseResponse> = {
    success: true,
    data: { query, results: [] },
  };

  res.json(response);
});

// ============================================================================
// Recent Takeaways (UI-03)
// ============================================================================

/**
 * GET /knowledge-base/recent?limit=3
 * Returns the most recently created takeaways across all sessions.
 */
export const listRecentTakeaways = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 3, 20);

  const takeaways = await prisma.takeaway.findMany({
    where: {
      reflection: {
        userId: user.id,
        status: { not: 'ARCHIVED' },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...TAKEAWAY_WITH_DATE,
  });

  const response: ApiResponse<RecentTakeawaysResponse> = {
    success: true,
    data: {
      takeaways: takeaways.map((t) => ({
        id: t.id,
        content: t.content,
        theme: t.theme,
        type: t.type,
        sessionDate: t.reflection.createdAt.toISOString(),
        sessionId: t.reflectionId,
      })),
    },
  };

  res.json(response);
});

// ============================================================================
// Takeaway Links (LINK-01 through LINK-04)
// ============================================================================

/** Both directions of a takeaway's links, with the other end (outgoing first). */
async function linksOf(takeawayId: string) {
  const [outgoing, incoming] = await Promise.all([
    prisma.takeawayLink.findMany({
      where: { sourceId: takeawayId },
      include: { target: TAKEAWAY_WITH_DATE },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.takeawayLink.findMany({
      where: { targetId: takeawayId },
      include: { source: TAKEAWAY_WITH_DATE },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return [
    ...outgoing.map((l) => ({ link: l, other: l.target })),
    ...incoming.map((l) => ({ link: l, other: l.source })),
  ];
}

/**
 * GET /knowledge-base/takeaways/:id/links
 * Returns all linked takeaways (both directions: outgoing + incoming).
 */
export const getTakeawayLinks = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const takeawayId = req.params.id;

  // Verify ownership
  const takeaway = await ownTakeaway(user.id, takeawayId);
  if (!takeaway) {
    throw new NotFoundError('Takeaway not found');
  }

  const links: TakeawayLinkDTO[] = (await linksOf(takeawayId)).map(({ link, other }) => ({
    id: linkIdOf(link),
    linkedTakeaway: linkedTakeawayOf(other),
    linkType: link.linkType,
    similarity: link.similarity,
    createdAt: link.createdAt.toISOString(),
  }));

  // Deduplicate by linked takeaway ID (a pair could exist in both directions)
  const seen = new Set<string>();
  const uniqueLinks = links.filter((link) => {
    if (seen.has(link.linkedTakeaway.id)) return false;
    seen.add(link.linkedTakeaway.id);
    return true;
  });

  const response: ApiResponse<GetTakeawayLinksResponse> = {
    success: true,
    data: { links: uniqueLinks },
  };

  res.json(response);
});

/**
 * POST /knowledge-base/takeaways/:id/links
 * Create a manual link between two takeaways.
 */
export const createTakeawayLink = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const sourceId = req.params.id;
  const { targetId } = req.body as CreateTakeawayLinkRequest;

  if (!targetId) {
    throw new ValidationError('targetId is required');
  }

  if (sourceId === targetId) {
    throw new ValidationError('Cannot link a takeaway to itself');
  }

  // Verify both takeaways belong to this user
  const [source, target] = await Promise.all([ownTakeaway(user.id, sourceId), ownTakeaway(user.id, targetId)]);

  if (!source || !target) {
    throw new NotFoundError('One or both takeaways not found');
  }

  try {
    const link = await prisma.takeawayLink.create({
      data: {
        sourceId,
        targetId,
        linkType: 'USER_MANUAL',
      },
    });

    const response: ApiResponse<CreateTakeawayLinkResponse> = {
      success: true,
      data: {
        link: {
          id: linkIdOf(link),
          linkedTakeaway: linkedTakeawayOf(target),
          linkType: 'USER_MANUAL',
          similarity: null,
          createdAt: link.createdAt.toISOString(),
        },
      },
    };

    res.status(201).json(response);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ success: false, error: 'Link already exists' });
      return;
    }
    throw err;
  }
});

/**
 * DELETE /knowledge-base/takeaways/:id/links/:linkId
 * Remove a manual link (only USER_MANUAL links can be deleted by the user).
 */
export const deleteTakeawayLink = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const takeawayId = req.params.id;
  const key = parseLinkId(req.params.linkId);

  // Verify the link exists and touches the named takeaway
  const link =
    key && (key.sourceId === takeawayId || key.targetId === takeawayId)
      ? await prisma.takeawayLink.findUnique({ where: { sourceId_targetId: key } })
      : null;

  if (!link) {
    throw new NotFoundError('Link not found');
  }

  // Verify user ownership via the takeaway
  const takeaway = await ownTakeaway(user.id, takeawayId);

  if (!takeaway) {
    throw new NotFoundError('Takeaway not found');
  }

  // Only allow deletion of USER_MANUAL links
  if (link.linkType !== 'USER_MANUAL') {
    throw new ValidationError('Only manually created links can be deleted');
  }

  await prisma.takeawayLink.delete({ where: { sourceId_targetId: { sourceId: link.sourceId, targetId: link.targetId } } });

  const response: ApiResponse<DeleteTakeawayLinkResponse> = {
    success: true,
    data: { success: true },
  };

  res.json(response);
});

// ============================================================================
// Thought Thread (LINK-03)
// ============================================================================

/**
 * GET /knowledge-base/takeaways/:id/thread
 * Traverses all links (breadth-first, max depth 3) to build the full connected
 * thought chain. Returns the root + all connected takeaways chronologically.
 */
export const getTakeawayThread = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const rootId = req.params.id;

  // Verify root ownership
  const root = await ownTakeaway(user.id, rootId);

  if (!root) {
    throw new NotFoundError('Takeaway not found');
  }

  // BFS traversal — max depth 3
  const visited = new Set<string>([rootId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const threadItems: Array<{ takeaway: TakeawayWithDate; linkType: TakeawayLinkDTO['linkType'] }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= 3) continue;

    for (const { link, other } of await linksOf(current.id)) {
      if (!visited.has(other.id)) {
        visited.add(other.id);
        threadItems.push({ takeaway: other, linkType: link.linkType });
        queue.push({ id: other.id, depth: current.depth + 1 });
      }
    }
  }

  // Sort thread chronologically
  threadItems.sort((a, b) => a.takeaway.reflection.createdAt.getTime() - b.takeaway.reflection.createdAt.getTime());

  const rootDTO: TakeawayDTO & { sessionDate: string } = {
    ...mapTakeawayToDTO(root),
    sessionDate: root.reflection.createdAt.toISOString(),
  };

  const response: ApiResponse<TakeawayThreadDTO> = {
    success: true,
    data: {
      root: rootDTO,
      thread: threadItems.map((item) => ({
        ...mapTakeawayToDTO(item.takeaway),
        sessionDate: item.takeaway.reflection.createdAt.toISOString(),
        linkType: item.linkType,
      })),
    },
  };

  res.json(response);
});

// ============================================================================
// Action Item Resolution (ACTION-01 through ACTION-04)
// ============================================================================

/**
 * PATCH /knowledge-base/takeaways/:id/resolve
 * Toggles the resolved state of a takeaway (`resolved_at` set or cleared).
 */
export const resolveTakeaway = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const takeawayId = req.params.id;

  const takeaway = await ownTakeaway(user.id, takeawayId);

  if (!takeaway) {
    throw new NotFoundError('Takeaway not found');
  }

  // Toggle resolved state
  const currentResolved = takeaway.resolvedAt !== null;
  const updated = await prisma.takeaway.update({
    where: { id: takeawayId },
    data: { resolvedAt: !currentResolved ? new Date() : null },
  });

  const response: ApiResponse<ResolveTakeawayResponse> = {
    success: true,
    data: { takeaway: mapTakeawayToDTO(updated) },
  };

  res.json(response);
});

/**
 * GET /knowledge-base/actions?status=open|resolved|all
 * Returns action items for the user, with optional status filter.
 */
export const listActions = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const status = (req.query.status as string) || 'open';

  const where: Prisma.TakeawayWhereInput = {
    reflection: {
      userId: user.id,
      status: { not: 'ARCHIVED' },
    },
    type: 'ACTION_ITEM',
  };

  if (status === 'open') {
    where.resolvedAt = null;
  } else if (status === 'resolved') {
    where.resolvedAt = { not: null };
  }
  // 'all' — no additional filter

  const takeaways = await prisma.takeaway.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      reflection: { select: { createdAt: true, theme: true } },
    },
  });

  const response: ApiResponse<ListActionsResponse> = {
    success: true,
    data: {
      actions: takeaways.map((t) => ({
        ...mapTakeawayToDTO(t),
        sessionDate: t.reflection.createdAt.toISOString(),
        topicTag: t.reflection.theme,
      })),
    },
  };

  res.json(response);
});
