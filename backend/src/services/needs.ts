/**
 * Needs Service (TS-11, spec §1.4 `need`).
 *
 * A need is OWNER-ONLY, always: `need` hangs off the owner's `participant`
 * and no code path reads another participant's `need` row. What crosses the
 * boundary is the separate `need_share` row (services/needs-share.ts), which
 * carries the job's transformed text and the category — never `label` or
 * `evidence`.
 *
 *   - "confirmed" is `confirmed_at IS NOT NULL` (the old boolean, with its instant);
 *   - removal is the soft delete `deleted_at` (mwf_app has no DELETE on need);
 *   - refinement is supersession: the old row's `superseded_by_need_id` points
 *     at the new one.
 *
 * The DTO (`IdentifiedNeedDTO`) is unchanged: `need` is the label.
 */

import { resetBedrockClient } from '../lib/bedrock';
import { prisma } from '../lib/prisma';
import { NeedCategory, type CapturedNeedInput, type IdentifiedNeedDTO } from '@meet-without-fear/shared';
import { cleanVisibleAIText } from '../utils/visible-text';
import { resolveParticipant } from './participant-resolver';

// ============================================================================
// Types
// ============================================================================

export interface ExtractedNeed {
  category: NeedCategory;
  need: string;
  evidence: string[];
  aiConfidence: number;
}

/** A `need` row as the app reads it (the owner's own row only). */
export interface NeedRecord {
  id: string;
  participantId: string;
  label: string;
  category: NeedCategory;
  evidence: string[];
  aiConfidence: number;
  confirmedAt: Date | null;
  lockedAt: Date | null;
  supersededByNeedId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

/** The legacy record shape (`need` = label, `confirmed` boolean) the DTO builders take. */
export interface IdentifiedNeedRecord {
  id: string;
  need: string;
  category: NeedCategory;
  evidence: string[];
  aiConfidence: number;
  confirmed: boolean;
  lockedAt?: Date | null;
  deletedAt?: Date | null;
  supersededByNeedId?: string | null;
  createdAt: Date;
  needsReframing?: boolean;
  reframingWarning?: string;
}

export interface CaptureProposedNeedsResult {
  needs: IdentifiedNeedRecord[];
  capturedAt: Date;
}

export interface CaptureSingleNeedResult {
  need: IdentifiedNeedDTO;
  capturedAt: Date;
}

export interface UniversalNeedValidationResult {
  ok: boolean;
  warning?: string;
}

export class NeedParticipantNotFoundError extends Error {
  constructor() {
    super('No participant for this user in the session');
    this.name = 'NeedParticipantNotFoundError';
  }
}

export const NEED_SELECT = {
  id: true,
  participantId: true,
  label: true,
  category: true,
  evidence: true,
  aiConfidence: true,
  confirmedAt: true,
  lockedAt: true,
  supersededByNeedId: true,
  deletedAt: true,
  createdAt: true,
} as const;

const OTHER_PERSON_PATTERNS = [
  /\bi need\s+(him|her|them|you|my partner)\s+to\b/i,
  /\bi need\s+(him|her|them|you|my partner)\s+not\s+to\b/i,
  /\bi need\s+(him|her|them|you|my partner)\s+to\s+stop\b/i,
  /\bi need\s+.*\b(stop|quit|change|apologize|admit|listen|understand)\b/i,
  /\bso (he|she|they|you) (will|would|can|could|won't|don't|doesn't)\b/i,
];

export function validateNeedIsUniversal(need: string): UniversalNeedValidationResult {
  const text = cleanVisibleAIText(need).trim();
  if (!text) return { ok: false, warning: 'Need text is empty.' };

  if (OTHER_PERSON_PATTERNS.some(pattern => pattern.test(text))) {
    return {
      ok: false,
      warning: 'This may still be framed around what the other person should do. Reword it toward what matters to you.',
    };
  }

  return { ok: true };
}

export function withNeedReframingWarning<T extends { need: string }>(
  need: T,
): T & { needsReframing: boolean; reframingWarning?: string } {
  const validation = validateNeedIsUniversal(need.need);
  return {
    ...need,
    needsReframing: !validation.ok,
    reframingWarning: validation.warning,
  };
}

/** Target row → the legacy record (`need` = label, `confirmed` = confirmed_at set). */
export function toNeedRecord(row: NeedRecord): IdentifiedNeedRecord {
  return {
    id: row.id,
    need: row.label,
    category: row.category,
    evidence: row.evidence,
    aiConfidence: row.aiConfidence,
    confirmed: row.confirmedAt !== null,
    lockedAt: row.lockedAt,
    deletedAt: row.deletedAt,
    supersededByNeedId: row.supersededByNeedId,
    createdAt: row.createdAt,
  };
}

export function toIdentifiedNeedDTO(need: IdentifiedNeedRecord | NeedRecord): IdentifiedNeedDTO {
  const record = 'label' in need ? toNeedRecord(need) : need;
  const warned = withNeedReframingWarning(record);
  const lockedAt = record.lockedAt ?? null;
  const deletedAt = record.deletedAt ?? null;
  const supersededByNeedId = record.supersededByNeedId ?? null;
  return {
    id: record.id,
    need: record.need,
    category: record.category,
    description: record.need,
    evidence: record.evidence,
    confirmed: record.confirmed,
    lockedAt: lockedAt?.toISOString() ?? null,
    deletedAt: deletedAt?.toISOString() ?? null,
    supersededByNeedId,
    status: deletedAt ? 'deleted' : supersededByNeedId ? 'superseded' : lockedAt ? 'locked' : 'draft',
    aiConfidence: record.aiConfidence,
    createdAt: record.createdAt.toISOString(),
    needsReframing: warned.needsReframing,
    reframingWarning: warned.reframingWarning,
  };
}

/** The caller's present participant in the session, or throw. */
export async function requireNeedOwner(sessionId: string, userId: string): Promise<{ id: string; sessionId: string }> {
  const participant = await resolveParticipant(sessionId, userId);
  if (!participant) throw new NeedParticipantNotFoundError();
  return participant;
}

/**
 * The participant's own needs, oldest first. `live` = not deleted and not
 * superseded; `confirmed` = confirmed_at set.
 */
export async function listOwnNeeds(
  participantId: string,
  opts: { live?: boolean; confirmed?: boolean; notDeleted?: boolean } = {},
): Promise<NeedRecord[]> {
  return (await prisma.need.findMany({
    where: {
      participantId,
      ...(opts.live ? { deletedAt: null, supersededByNeedId: null } : {}),
      ...(opts.notDeleted ? { deletedAt: null } : {}),
      ...(opts.confirmed ? { confirmedAt: { not: null } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: NEED_SELECT,
  })) as NeedRecord[];
}

function cleanEvidence(evidence: unknown): string[] {
  return (Array.isArray(evidence) ? evidence.filter((entry): entry is string => typeof entry === 'string') : [])
    .map(entry => cleanVisibleAIText(entry))
    .filter(Boolean);
}

/**
 * Replace the participant's unconfirmed AI-captured needs with a new set.
 * Once the user confirms, the list is user-owned and later chat summaries do
 * not overwrite it. "Replace" is the soft delete (no DELETE on need).
 */
export async function captureProposedNeedsForUser(
  sessionId: string,
  userId: string,
  needs: CapturedNeedInput[],
): Promise<CaptureProposedNeedsResult> {
  const participant = await requireNeedOwner(sessionId, userId);
  const capturedAt = new Date();

  await prisma.$transaction(async tx => {
    await tx.need.updateMany({
      where: { participantId: participant.id, confirmedAt: null, deletedAt: null },
      data: { deletedAt: capturedAt },
    });
    for (const item of needs) {
      await tx.need.create({
        data: {
          participantId: participant.id,
          label: cleanVisibleAIText(item.description || item.need),
          category: item.category,
          evidence: cleanEvidence(item.evidence),
          aiConfidence: 0.85,
        },
      });
    }
  });

  const captured = await listOwnNeeds(participant.id, { notDeleted: true });
  return {
    needs: captured.map(need => withNeedReframingWarning(toNeedRecord(need))),
    capturedAt,
  };
}

/** Capture one proposed need, replacing any unconfirmed draft (the AI cannot see what it proposed before). */
export async function captureSingleNeedForUser(
  sessionId: string,
  userId: string,
  item: CapturedNeedInput,
): Promise<CaptureSingleNeedResult> {
  const participant = await requireNeedOwner(sessionId, userId);
  const capturedAt = new Date();

  const created = (await prisma.$transaction(async tx => {
    await tx.need.updateMany({
      where: { participantId: participant.id, confirmedAt: null, deletedAt: null },
      data: { deletedAt: capturedAt },
    });
    return tx.need.create({
      data: {
        participantId: participant.id,
        label: cleanVisibleAIText(item.description || item.need),
        category: item.category,
        evidence: cleanEvidence(item.evidence),
        aiConfidence: 0.85,
      },
      select: NEED_SELECT,
    });
  })) as NeedRecord;

  return { need: toIdentifiedNeedDTO(created), capturedAt };
}

/**
 * Reset the client (useful for testing)
 */
export function resetNeedsClient(): void {
  resetBedrockClient();
}
