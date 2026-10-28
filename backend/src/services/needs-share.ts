/**
 * The Stage 3 share path (TS-11; spec §1.4 `need_share`, §7).
 *
 * A need crosses the boundary as a SEPARATE row, `need_share`, holding only
 * the job's transformed ("heat removed") text and the category. The private
 * `need.label` / `need.evidence` never leave the owner:
 *
 *   1. the OWNER records the decision — one `consent` row per need (the
 *      `need_id` arc, `decision GRANTED`, `decided_at`) on the APP connection
 *      (T-consent-owner: the decider must own the need);
 *   2. the JOB transforms the text (`transformNeedForSharing`) and calls
 *      `app.need_share(need, shared_text)` on the JOB connection. That definer
 *      function is the only writer of `need_share` (EXECUTE is mwf_job's
 *      alone; it refuses a need without its owner's GRANTED consent and copies
 *      participant/session/category from the need). The app never INSERTs
 *      `need_share`;
 *   3. once every present human of the session has shared, the job writes the
 *      session-scoped milestones `needs_shared` (stage 3's terminal) and
 *      `needs_validated` for each of them — the writer contract in
 *      stage-shim.ts: a session-scoped gating milestone is written only when it
 *      holds for the whole session, so `v_session_readiness.all_reached` is true
 *      the moment it exists and no participant's stage runs ahead.
 *
 * Partner needs are read through `v_need_shared` only (it reads `need_share`
 * alone, never `need`). Revocation is `app.need_revoke_share(need)` — the
 * share's `revoked_at` and the consent's REVOKED in one transaction.
 */

import { NeedCategory } from '@meet-without-fear/shared';
import { getModelCompletion } from '../lib/bedrock';
import { logger } from '../lib/logger';
import { getJobPrisma, prisma } from '../lib/prisma';
import { decryptRawRows, encryptColumnValue } from '../lib/prisma-encryption-middleware';
import { reencryptForSession } from '../lib/share-moments';
import { cleanVisibleAIText } from '../utils/visible-text';
import { reachMilestone } from './milestone-writer';

export interface SharedNeedRow {
  needId: string;
  participantId: string;
  sessionId: string;
  category: NeedCategory;
  sharedText: string;
  sharedAt: Date;
}

/** Every live shared need of the session (`v_need_shared`: need_share alone). */
export async function listSharedNeeds(sessionId: string): Promise<SharedNeedRow[]> {
  return decryptRawRows(
    await prisma.$queryRaw<SharedNeedRow[]>`
    SELECT need_id AS "needId", participant_id AS "participantId", session_id AS "sessionId",
           category::text AS category, shared_text AS "sharedText", shared_at AS "sharedAt"
    FROM v_need_shared
    WHERE session_id = ${sessionId}::uuid
    ORDER BY shared_at, need_id`,
    { sharedText: 'need_share.shared_text' },
  );
}

/** The present human participants of the session who have at least one live share. */
export async function participantsWhoShared(sessionId: string): Promise<Set<string>> {
  return new Set((await listSharedNeeds(sessionId)).map(n => n.participantId));
}

// ----------------------------------------------------------------------------
// The job's transform
// ----------------------------------------------------------------------------

/**
 * The fallback shared text: a sentence about the CATEGORY, so a failed or
 * mocked transform can never carry the private label (or its evidence).
 */
const CATEGORY_TEXT: Record<NeedCategory, string> = {
  [NeedCategory.SAFETY]: 'Feeling safe and settled',
  [NeedCategory.CONNECTION]: 'Feeling close and connected',
  [NeedCategory.AUTONOMY]: 'Having room to choose for myself',
  [NeedCategory.RECOGNITION]: 'Being seen and appreciated',
  [NeedCategory.MEANING]: 'Doing things that matter to me',
  [NeedCategory.FAIRNESS]: 'Sharing things fairly',
};
const GENERIC_TEXT = 'Something that matters to me';

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** True when `text` contains the label (or one of the evidence quotes) verbatim, case-insensitively. */
export function carriesPrivateText(text: string, label: string, evidence: string[] = []): boolean {
  const t = norm(text);
  return [label, ...evidence].some(p => {
    const n = norm(p);
    return n.length >= 3 && t.includes(n);
  });
}

export function fallbackSharedText(label: string, category: NeedCategory): string {
  const text = CATEGORY_TEXT[category] ?? GENERIC_TEXT;
  return carriesPrivateText(text, label) ? GENERIC_TEXT : text;
}

/**
 * The "heat removed" version of a need the partner may read (Haiku, on the job
 * path). Rejected — and replaced by the category fallback — when the model
 * fails, is mocked (MOCK_LLM), returns nothing usable, or returns text that
 * still contains the label or an evidence quote.
 */
export async function transformNeedForSharing(need: {
  label: string;
  category: NeedCategory;
  evidence?: string[];
  sessionId: string;
}): Promise<string> {
  let out: string | null = null;
  try {
    out = await getModelCompletion('haiku', {
      systemPrompt: [
        "You rewrite one person's need so their partner can read it without feeling blamed.",
        'Keep what matters to the person; remove accusation, heat and any mention of the partner.',
        'Do not quote the original wording. One short sentence, first person, no more than 12 words.',
        'Return only the sentence.',
      ].join('\n'),
      messages: [{ role: 'user', content: `Category: ${need.category}\nNeed: ${need.label}` }],
      maxTokens: 60,
      operation: 'stage3-need-share-transform',
      sessionId: need.sessionId,
      turnId: `${need.sessionId}:need-share:${Date.now()}`,
    });
  } catch (error) {
    logger.warn('[transformNeedForSharing] model call failed; using the category text', { error });
  }
  const text = out
    ? cleanVisibleAIText(out)
        .replace(/^["“]|["”]$/g, '')
        .trim()
    : '';
  if (!text || text.length > 200 || carriesPrivateText(text, need.label, need.evidence ?? [])) {
    return fallbackSharedText(need.label, need.category);
  }
  return text;
}

// ----------------------------------------------------------------------------
// Share and revoke
// ----------------------------------------------------------------------------

export interface ShareNeedsResult {
  sharedAt: Date;
  /** Every present human of the session has now shared (the job wrote needs_shared for all). */
  allShared: boolean;
  /** This call is the one that completed the session's sharing. */
  completedNow: boolean;
}

/**
 * Share the owner's needs (all of them, already validated by the caller as
 * the owner's live, confirmed needs).
 */
export async function shareNeeds(args: {
  sessionId: string;
  participantId: string;
  needs: Array<{ id: string; label: string; category: NeedCategory; evidence: string[] }>;
}): Promise<ShareNeedsResult> {
  const sharedAt = new Date();

  // 1. The owner's decision (app connection).
  await prisma.$transaction(async tx => {
    for (const need of args.needs) {
      const existing = await tx.consent.findFirst({
        where: { needId: need.id, participantId: args.participantId, decision: 'GRANTED' },
        select: { id: true },
      });
      if (existing) continue;
      await tx.consent.create({
        data: {
          participantId: args.participantId,
          requestedByParticipantId: args.participantId,
          needId: need.id,
          decision: 'GRANTED',
          decidedAt: sharedAt,
        },
      });
    }
  });

  // 2. The job's transformed copy, through the only writer.
  const job = getJobPrisma();
  for (const need of args.needs) {
    const text = await transformNeedForSharing({ ...need, sessionId: args.sessionId });
    // need_share.shared_text is written under the session key by the job (ciphertext in; TS-13).
    await job.$executeRaw`SELECT app.need_share(${need.id}::uuid, ${encryptColumnValue('need_share', 'shared_text', text)})`;
    // Share moment (writer-principal rule): W13 re-encrypts here.
    await reencryptForSession({
      moment: 'need-share',
      sessionId: args.sessionId,
      rows: [{ table: 'need_share', id: need.id }],
    });
  }

  // 3. Session-scoped completion: every present human has shared.
  const completedNow = await completeNeedsSharingIfReady(args.sessionId, sharedAt);
  const allShared = await needsSharedForSession(args.sessionId);
  return { sharedAt, allShared, completedNow };
}

/** `v_session_readiness` for needs_shared: every present human has reached it. */
export async function needsSharedForSession(sessionId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ all_reached: boolean }>>`
    SELECT all_reached FROM v_session_readiness
    WHERE session_id = ${sessionId}::uuid AND milestone_key = 'needs_shared'`;
  return rows[0]?.all_reached === true;
}

/**
 * When every present human participant has a live share and the session's
 * `needs_shared` is not yet reached, the job writes `needs_validated` and
 * `needs_shared` for each of them. Returns true when this call wrote them.
 */
export async function completeNeedsSharingIfReady(sessionId: string, at: Date = new Date()): Promise<boolean> {
  const humans = await prisma.participant.findMany({
    where: { sessionId, kind: 'human', leftAt: null },
    select: { id: true },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
  });
  if (humans.length < 2) return false;
  const shared = await participantsWhoShared(sessionId);
  if (!humans.every(h => shared.has(h.id))) return false;
  let wrote = false;
  for (const h of humans) {
    await reachMilestone(h.id, 'needs_validated', at);
    if (await reachMilestone(h.id, 'needs_shared', at)) wrote = true;
  }
  return wrote;
}

/**
 * Revoke a shared need: `app.need_revoke_share` (the owner, identity-bound, on
 * the app connection) sets `need_share.revoked_at` and the consent's REVOKED
 * in one transaction. The partner's `v_need_shared` read is empty afterwards.
 */
export async function revokeNeedShare(needId: string): Promise<void> {
  await prisma.$executeRaw`SELECT app.need_revoke_share(${needId}::uuid)`;
}
