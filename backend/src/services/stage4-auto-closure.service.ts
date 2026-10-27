import { Stage4ClosureKind, Stage4ClosureReason } from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { notifyPartner, publishSessionEvent } from './realtime';
import { getPartnerUserId } from '../utils/session';
import type { Stage4ClosureSignalDTO } from './stage4-capture.service';
import { resolveParticipant } from './participant-resolver';
import { loadStageStates } from './stage-shim';
import { closeStage4WithoutAgreement, Stage4CloseError } from './stage4-closure';

export type Stage4AutoClosureResult =
  | { closed: true; reason: Stage4ClosureReason }
  | { closed: false; reason: string };

function isExplicitNoSharedClosure(signal: Stage4ClosureSignalDTO | undefined): signal is Stage4ClosureSignalDTO {
  return signal?.readyToClose === true && signal.kind === Stage4ClosureKind.NO_SHARED_AGREEMENT;
}

/**
 * Apply an explicit conversational no-shared-agreement close (TS-11: on the
 * target, via stage4-closure — the job writes `session_closure` and the
 * session RESOLVED; the open needs and individual commitments are
 * `v_session_closure_items`).
 *
 * This is intentionally narrower than the button endpoint: it only honors
 * explicit stop/close/no-shared-agreement language captured from the user's
 * own Stage 4 message. It does not convert shared proposals into agreements.
 */
export async function applyStage4AutoClosureFromSignal(args: {
  sessionId: string;
  userId: string;
  signal?: Stage4ClosureSignalDTO;
}): Promise<Stage4AutoClosureResult> {
  if (!isExplicitNoSharedClosure(args.signal)) {
    return { closed: false, reason: 'no_explicit_no_shared_closure_signal' };
  }

  const participant = await resolveParticipant(args.sessionId, args.userId);
  if (!participant) return { closed: false, reason: 'session_not_found' };
  const session = await prisma.session.findUnique({ where: { id: args.sessionId }, select: { status: true } });
  if (!session) return { closed: false, reason: 'session_not_found' };
  if (session.status !== 'ACTIVE') return { closed: false, reason: 'session_not_active' };

  const states = await loadStageStates([{ id: participant.id, joinedAt: participant.joinedAt }]);
  if ((states.get(participant.id)?.current.stage ?? 0) !== 4) return { closed: false, reason: 'not_in_stage_4' };

  const reason = args.signal.reason ?? Stage4ClosureReason.USER_STOPPED;
  let counts: { individualCount: number; openNeedCount: number };
  try {
    counts = await closeStage4WithoutAgreement({
      sessionId: args.sessionId,
      participantId: participant.id,
      reason,
      summary: args.signal.summary,
    });
  } catch (error) {
    if (error instanceof Stage4CloseError && error.code === 'CONFLICT') return { closed: false, reason: 'already_closed' };
    throw error;
  }

  const partnerId = await getPartnerUserId(args.sessionId, args.userId);
  if (partnerId) {
    await notifyPartner(args.sessionId, partnerId, 'session.resolved', {
      closedBy: args.userId,
      kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
      agreementIds: [],
    });
  }
  await publishSessionEvent(args.sessionId, 'session.resolved', {
    closureKind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
    agreementIds: [],
  });

  logger.info('[applyStage4AutoClosureFromSignal] Closed Stage 4 from explicit conversation signal', {
    sessionId: args.sessionId,
    userId: args.userId,
    reason,
    individualProposalCount: counts.individualCount,
    openNeedCount: counts.openNeedCount,
  });

  return { closed: true, reason };
}
