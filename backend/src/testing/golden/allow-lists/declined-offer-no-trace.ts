/**
 * Allow-list, permitted status paths and known traces for
 * `declined-offer-no-trace` (golden R7).
 *
 * Plan §4 R7: after the subject declines, the author's reads (incl.
 * `consent`) are unchanged from before the offer. Spec §7: declining a share
 * suggestion leaves no author-visible trace (`consent` has no requester read
 * arm; share-offer consents have no requester at all; `context_share_offer`
 * is subject-only — P1-4).
 *
 * The target re-record may change only what every read carries.
 */

import type { KnownLeak } from '../privacy';
import { READ_DTO_RULES } from './common';
import type { AllowList } from './types';

export const DECLINED_OFFER_NO_TRACE_ALLOW: AllowList = {
  scenario: 'declined-offer-no-trace',
  rules: [...READ_DTO_RULES],
};

/**
 * The direction's status, which the author may see change (it is
 * `v_empathy_direction_status`): `<read name>` + normalised body path.
 */
export const DECLINE_STATUS_PATHS: Array<{ read: string; path: string }> = [
  // AWAITING_SHARING → READY: the author's own direction status.
  { read: 'empathy status as ada@e2e.test', path: 'body.data.myAttempt.status' },
  // The DTO's boolean restatement of that status (`status === AWAITING_SHARING`).
  { read: 'empathy status as ada@e2e.test', path: 'body.data.awaitingSharing' },
];

/** Differences observed against the current code that are traces of the decline. `at` = `<read> @ <path>`. */
export const DECLINED_OFFER_NO_TRACE_KNOWN_TRACES: KnownLeak[] = [
  {
    at: 'reconciler status as ada@e2e.test @ body.data.pendingShareOffers',
    finding:
      'R7/P1-4: GET /sessions/:id/reconciler/status shows the author the count of the subject’s pending share offers, ' +
      'so the author sees an offer exist and then be answered (1 → 0 on decline)',
    evidence:
      'before decline: body.data.pendingShareOffers = 1; after: 0 (services/reconciler/state.ts getReconcilerStatus ' +
      'counts the session’s results whose share offer is OFFERED, whoever the offer’s subject is)',
  },
];
