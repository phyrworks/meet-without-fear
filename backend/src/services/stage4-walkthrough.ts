/**
 * The Stage 4 needs walkthrough on `need_disposition` (TS-11; spec §1.4).
 *
 * One row per (participant, shared need): COVERED / SKIPPED from the
 * walkthrough, DECLINED from "leave for now", OPEN for the need the
 * walkthrough is on (`is_current`; at most one per participant —
 * sql_disposition_one_current). The phase is not stored: it follows the
 * current need's owner (own → MY_NEEDS, partner's → PARTNER_NEEDS) and is
 * QUALITY_REVIEW when nothing remains. The first walkthrough write records the
 * participant's `repair_walkthrough_started` milestone (a system key: job).
 *
 * The controller's POST /stage4/walkthrough/needs/:needId and the AI's
 * walkthrough action both go through `advanceWalkthrough`.
 */

import { prisma } from '../lib/prisma';
import { reachMilestone } from './milestone-writer';
import { buildStage4StateFromView, loadStage4View, walkthroughOrder, walkthroughStoredFor } from './stage4-state';
import type { GetStage4StateResponse } from '@meet-without-fear/shared';

export class Stage4WalkthroughNeedNotFoundError extends Error {
  constructor() {
    super('Stage 4 walkthrough need not found');
    this.name = 'Stage4WalkthroughNeedNotFoundError';
  }
}

export type WalkthroughAction = 'covered' | 'skip' | 'reset';

export async function advanceWalkthrough(args: {
  sessionId: string;
  userId: string;
  needId: string;
  action: WalkthroughAction;
}): Promise<{ state: GetStage4StateResponse; phase: string; currentNeedId: string | null }> {
  const view = await loadStage4View(args.sessionId, args.userId);
  const target = view.rows.find(r => r.id === args.needId);
  if (!target) throw new Stage4WalkthroughNeedNotFoundError();

  const stored = walkthroughStoredFor(view);
  const before = walkthroughOrder(view.rows, view.me, stored);
  const covered = new Set(stored.coveredNeedIds);
  const skipped = new Set(stored.skippedNeedIds);
  if (args.action === 'covered') {
    covered.add(args.needId);
    skipped.delete(args.needId);
  } else if (args.action === 'skip') {
    skipped.add(args.needId);
    covered.delete(args.needId);
  } else {
    covered.delete(args.needId);
    skipped.delete(args.needId);
  }

  const remainingOwn = before.own.find(n => !covered.has(n.id) && !skipped.has(n.id));
  const remainingPartner = before.partner.find(n => !covered.has(n.id) && !skipped.has(n.id));
  const isOwn = target.ownerParticipantId === view.me;
  let phase: 'MY_NEEDS' | 'PARTNER_NEEDS' | 'QUALITY_REVIEW';
  let currentNeedId: string | null;
  if (args.action === 'reset') {
    phase = isOwn ? 'MY_NEEDS' : 'PARTNER_NEEDS';
    currentNeedId = args.needId;
  } else if (before.phase === 'MY_NEEDS' && remainingOwn) {
    phase = 'MY_NEEDS';
    currentNeedId = remainingOwn.id;
  } else if (before.phase === 'MY_NEEDS' && remainingPartner) {
    phase = 'PARTNER_NEEDS';
    currentNeedId = remainingPartner.id;
  } else if (before.phase === 'PARTNER_NEEDS' && remainingPartner) {
    phase = 'PARTNER_NEEDS';
    currentNeedId = remainingPartner.id;
  } else if (remainingOwn) {
    phase = 'MY_NEEDS';
    currentNeedId = remainingOwn.id;
  } else if (remainingPartner) {
    phase = 'PARTNER_NEEDS';
    currentNeedId = remainingPartner.id;
  } else {
    phase = 'QUALITY_REVIEW';
    currentNeedId = null;
  }

  const status = args.action === 'covered' ? 'COVERED' : args.action === 'skip' ? 'SKIPPED' : 'OPEN';
  const me = view.me;
  await prisma.$transaction(async tx => {
    // The partial unique allows one current row: clear first.
    await tx.needDisposition.updateMany({ where: { participantId: me, isCurrent: true }, data: { isCurrent: false } });
    await tx.needDisposition.upsert({
      where: { participantId_needId: { participantId: me, needId: args.needId } },
      create: { participantId: me, needId: args.needId, status },
      update: { status },
    });
    if (currentNeedId) {
      await tx.needDisposition.upsert({
        where: { participantId_needId: { participantId: me, needId: currentNeedId } },
        create: { participantId: me, needId: currentNeedId, status: 'OPEN', isCurrent: true },
        update: { isCurrent: true },
      });
    }
  });
  await reachMilestone(me, 'repair_walkthrough_started');

  return { state: buildStage4StateFromView(await loadStage4View(args.sessionId, args.userId)), phase, currentNeedId };
}

/** "Leave for now": the participant declines to address a shared need. */
export async function declineNeed(participantId: string, needId: string): Promise<void> {
  await prisma.needDisposition.upsert({
    where: { participantId_needId: { participantId, needId } },
    create: { participantId, needId, status: 'DECLINED' },
    update: { status: 'DECLINED' },
  });
}

/** Remove a "leave for now": the row goes, unless it is the walkthrough's current need (then OPEN). */
export async function undeclineNeed(participantId: string, needId: string): Promise<void> {
  const row = await prisma.needDisposition.findUnique({ where: { participantId_needId: { participantId, needId } } });
  if (!row || row.status !== 'DECLINED') return;
  if (row.isCurrent) {
    await prisma.needDisposition.update({
      where: { participantId_needId: { participantId, needId } },
      data: { status: 'OPEN' },
    });
  } else {
    await prisma.needDisposition.delete({ where: { participantId_needId: { participantId, needId } } });
  }
}
