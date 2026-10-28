/**
 * Need edits (TS-11): the owner's own `need` rows only. Removal is the soft
 * delete; a refinement supersedes the old row (spec §1.4 `need`). Editing
 * ends once the owner has shared (a `need_share` row of theirs exists).
 */

import {
  AffectedNeed,
  ApplyNeedEditsResponse,
  ApplyNeedActionResponse,
  IdentifiedNeedDTO,
  NeedCategory,
  ParsedNeedAction,
  NeedEditOperation,
} from '@meet-without-fear/shared';
import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { cleanVisibleAIText } from '../utils/visible-text';
import {
  NEED_SELECT,
  requireNeedOwner,
  toIdentifiedNeedDTO,
  toNeedRecord,
  validateNeedIsUniversal,
  type IdentifiedNeedRecord,
  type NeedRecord,
} from './needs';

type NeedRow = IdentifiedNeedRecord;

export class NeedEditValidationError extends Error {
  statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'NeedEditValidationError';
  }
}

export class NeedEditForbiddenError extends Error {
  statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = 'NeedEditForbiddenError';
  }
}

type Db = typeof prisma | Prisma.TransactionClient;

/** The caller's own needs (legacy record shape), oldest first. */
async function ownNeeds(participantId: string, db: Db = prisma, where: Prisma.NeedWhereInput = {}): Promise<NeedRow[]> {
  const rows = (await db.need.findMany({
    where: { participantId, ...where },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: NEED_SELECT,
  })) as NeedRecord[];
  return rows.map(toNeedRecord);
}

async function updateNeed(db: Db, id: string, data: Prisma.NeedUpdateInput): Promise<NeedRow> {
  return toNeedRecord((await db.need.update({ where: { id }, data, select: NEED_SELECT })) as NeedRecord);
}

/**
 * Needs are editable until their owner has shared them: once a `need_share`
 * row of theirs exists (live or revoked), the list is delivered content.
 */
export async function assertNeedsEditable(sessionId: string, userId: string): Promise<{ id: string }> {
  const participant = await requireNeedOwner(sessionId, userId).catch(() => {
    throw new NeedEditValidationError('Stage 3 progress was not found.');
  });
  const shared = await prisma.needShare.count({ where: { participantId: participant.id } });
  if (shared > 0) {
    throw new NeedEditForbiddenError('Needs have already been shared and can no longer be edited.');
  }
  return participant;
}

function isNeedCategory(value: unknown): value is NeedCategory {
  return typeof value === 'string' && Object.values(NeedCategory).includes(value as NeedCategory);
}

function normalizeCategory(value: unknown, fallback: NeedCategory = NeedCategory.MEANING): NeedCategory {
  return isNeedCategory(value) ? value : fallback;
}

function cleanNeedText(value: unknown): string {
  return cleanVisibleAIText(typeof value === 'string' ? value : '').trim();
}

const toDTO = (row: NeedRow): IdentifiedNeedDTO => toIdentifiedNeedDTO(row);

export function previewNeedEditOperations(operations: NeedEditOperation[], needs: NeedRow[]): AffectedNeed[] {
  const byId = new Map(needs.map(need => [need.id, need]));
  const affected: AffectedNeed[] = [];

  for (const operation of operations) {
    if (operation.type === 'updateNeedText') {
      const current = operation.needId ? byId.get(operation.needId) : undefined;
      if (!current) throw new NeedEditValidationError('A target need could not be found.');
      const newText = cleanNeedText(operation.newText);
      if (!newText) throw new NeedEditValidationError('Updated need text is required.');
      if (newText.length > 500) throw new NeedEditValidationError('Updated need text is too long.');
      const newCategory = normalizeCategory(operation.newCategory, current.category);
      const validation = validateNeedIsUniversal(newText);
      affected.push({
        needId: current.id,
        before: { text: current.need, category: current.category },
        after: { text: newText, category: newCategory },
        operation: newCategory !== current.category ? 'category_change' : 'text_change',
        warning: validation.warning,
      });
      continue;
    }

    if (operation.type === 'addNeed') {
      const text = cleanNeedText(operation.text);
      if (!text) throw new NeedEditValidationError('New need text is required.');
      if (text.length > 500) throw new NeedEditValidationError('New need text is too long.');
      const category = normalizeCategory(operation.category, NeedCategory.MEANING);
      const validation = validateNeedIsUniversal(text);
      affected.push({
        after: { text, category },
        operation: 'add',
        warning: validation.warning,
      });
      continue;
    }

    if (operation.type === 'removeNeed') {
      const current = operation.needId ? byId.get(operation.needId) : undefined;
      if (!current) throw new NeedEditValidationError('A target need could not be found.');
      affected.push({
        needId: current.id,
        before: { text: current.need, category: current.category },
        operation: 'remove',
      });
      continue;
    }

    throw new NeedEditValidationError('Unsupported need edit operation.');
  }

  return affected;
}

export async function applyNeedEdits(
  sessionId: string,
  userId: string,
  operations: NeedEditOperation[],
): Promise<ApplyNeedEditsResponse> {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new NeedEditValidationError('At least one edit operation is required.');
  }

  const participant = await assertNeedsEditable(sessionId, userId);

  const applied = await prisma.$transaction(async tx => {
    const currentNeeds = await ownNeeds(participant.id, tx, { deletedAt: null });
    const preview = previewNeedEditOperations(operations, currentNeeds);
    const now = new Date();

    for (const operation of operations) {
      if (operation.type === 'updateNeedText') {
        const current = currentNeeds.find(need => need.id === operation.needId);
        if (!current || !operation.needId) continue;
        await updateNeed(tx, operation.needId, {
          label: cleanNeedText(operation.newText),
          category: normalizeCategory(operation.newCategory, current.category),
          confirmedAt: current.confirmed ? undefined : now,
        });
      } else if (operation.type === 'addNeed') {
        await tx.need.create({
          data: {
            participantId: participant.id,
            label: cleanNeedText(operation.text),
            category: normalizeCategory(operation.category, NeedCategory.MEANING),
            evidence: [],
            aiConfidence: 0.9,
            confirmedAt: now,
          },
        });
      } else if (operation.type === 'removeNeed' && operation.needId) {
        await tx.need.updateMany({
          where: { id: operation.needId, participantId: participant.id },
          data: { deletedAt: now },
        });
      }
    }

    return preview;
  });

  const needs = await ownNeeds(participant.id);
  return {
    needs: needs.map(toDTO),
    applied,
    warnings: applied.map(item => item.warning).filter((warning): warning is string => Boolean(warning)),
  };
}

export async function deleteNeed(sessionId: string, userId: string, needId: string): Promise<IdentifiedNeedDTO> {
  const participant = await assertNeedsEditable(sessionId, userId);
  const [need] = await ownNeeds(participant.id, prisma, { id: needId });
  if (!need) throw new NeedEditValidationError('Need not found.');
  return toDTO(await updateNeed(prisma, needId, { deletedAt: new Date() }));
}

export async function applyNeedAction(
  sessionId: string,
  userId: string,
  action: ParsedNeedAction,
): Promise<ApplyNeedActionResponse> {
  const participant = await assertNeedsEditable(sessionId, userId);

  const result = await prisma.$transaction(async tx => {
    if (action.type === 'refine') {
      const oldNeedId = action.supersedes;
      if (!oldNeedId) throw new NeedEditValidationError('Refine action requires supersedes.');
      const [current] = await ownNeeds(participant.id, tx, { id: oldNeedId, deletedAt: null });
      if (!current) throw new NeedEditValidationError('Need not found.');

      const text = cleanNeedText(action.description || action.need);
      if (!text) throw new NeedEditValidationError('Refined need text is required.');
      const newNeed = toNeedRecord(
        (await tx.need.create({
          data: {
            participantId: participant.id,
            label: text,
            category: normalizeCategory(action.category, current.category),
            evidence: Array.isArray(action.evidence)
              ? action.evidence.map(entry => cleanVisibleAIText(entry)).filter(Boolean)
              : current.evidence,
            aiConfidence: 0.9,
          },
          select: NEED_SELECT,
        })) as NeedRecord,
      );
      const oldNeed = await updateNeed(tx, current.id, { supersededByNeed: { connect: { id: newNeed.id } } });
      return { oldNeed, newNeed };
    }

    const targetId = action.needId;
    if (!targetId) throw new NeedEditValidationError(`${action.type} action requires needId.`);
    const [current] = await ownNeeds(participant.id, tx, { id: targetId });
    if (!current) throw new NeedEditValidationError('Need not found.');

    if (action.type === 'delete') {
      const deleted = await updateNeed(tx, current.id, { deletedAt: new Date() });
      return { oldNeed: deleted, newNeed: deleted };
    }

    const now = new Date();
    const locked = await updateNeed(tx, current.id, {
      lockedAt: now,
      confirmedAt: current.confirmed ? undefined : now,
    });
    return { oldNeed: locked, newNeed: locked };
  });

  const needs = await ownNeeds(participant.id);
  return {
    action: action.type,
    oldNeed: result.oldNeed ? toDTO(result.oldNeed) : undefined,
    need: result.newNeed ? toDTO(result.newNeed) : undefined,
    needs: needs.map(toDTO),
  };
}
