/**
 * Circuit Breaker: refinement attempts per direction (TS-10).
 *
 * Prevents infinite refinement loops by limiting resubmissions to 3 per
 * direction. On the target shape there is no counter table
 * (`RefinementAttemptCounter` is absorbed by `empathy_attempt.round`, spec
 * §1.2): the number of resubmissions of a direction IS its round count − 1.
 */

import { getJobPrisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/**
 * The resubmission count of a direction (read-only): rounds − 1.
 * `shouldSkipReconciler` when it exceeds 3, as before.
 */
export async function checkAttempts(
  authorParticipantId: string,
  subjectParticipantId: string,
): Promise<{ shouldSkipReconciler: boolean; attempts: number }> {
  // Analysis path: the job reads (Ruling R35).
  const rounds = await getJobPrisma().empathyAttempt.count({ where: { authorParticipantId, subjectParticipantId } });
  const attempts = Math.max(0, rounds - 1);
  const shouldSkipReconciler = attempts > 3;
  logger.debug('Circuit breaker check', { authorParticipantId, subjectParticipantId, attempts, shouldSkipReconciler });
  return { shouldSkipReconciler, attempts };
}

/**
 * Has the subject already shared context for this direction (an ACCEPTED
 * share offer on any round)? Prevents the reconciler loop where the same gaps
 * re-offer sharing after every resubmission.
 */
export async function hasContextAlreadyBeenShared(
  authorParticipantId: string,
  subjectParticipantId: string,
): Promise<boolean> {
  const shared = await getJobPrisma().contextShareOffer.findFirst({
    where: {
      subjectParticipantId,
      status: 'ACCEPTED',
      attempt: { authorParticipantId, subjectParticipantId },
    },
    select: { id: true },
  });
  if (shared) {
    logger.info('Context already shared', { subjectParticipantId, authorParticipantId });
    return true;
  }
  return false;
}
