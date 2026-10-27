/**
 * Session Realtime Contract
 *
 * Single source of truth for the Ably event protocol spoken between the backend
 * publishers (`backend/src/services/realtime.ts` and its callers) and the mobile
 * subscriber (`mobile/src/hooks/useRealtime.ts`).
 *
 * This closes the Phase 1 gap left open by `contracts/stream.ts`: SSE frames were
 * runtime-typed, session realtime events were not. Previously `SessionEventData`
 * degraded to `{ [key: string]: unknown }`, so a publisher could add a field or a
 * consumer could read a misspelled one with no compile-time or runtime signal.
 *
 * ## The two-tier design (read this before editing)
 *
 * Each event has ONE shape declaration, from which two things are derived:
 *
 * 1. **`SESSION_EVENT_DATA_SCHEMAS[event]` — the runtime schema.** Built with
 *    `.passthrough()`, so unknown keys are preserved rather than rejected. This is
 *    deliberate and load-bearing: this contract was introduced against a live
 *    protocol, and a schema that rejected an unexpected key would silently break a
 *    shipped flow.
 *
 *    `.passthrough()` tolerates unknown KEYS; it does not tolerate a DECLARED key
 *    carrying the wrong type. A payload is therefore rejected when it is not an
 *    object, when `sessionId` is missing or not a string, or when a declared field
 *    holds the wrong primitive, a malformed inline message, a non-object where an
 *    opaque DTO is expected, or an invalid `empathy.revealed.direction`. Almost
 *    every field below was transcribed from a real publisher — the exceptions are
 *    a handful of consumer-only reads (`partner.stage_completed.messagesByUserId`)
 *    and the events marked as having no publisher — and the backend typechecks
 *    against these same shapes, so no current publisher hits any of those. But
 *    the rejection surface is wider than "not an object", and a future publisher
 *    that changes a field's type will be dropped rather than coerced.
 *
 * 2. **`SessionEventPublishData<E>` — the compile-time publisher type.** Derived
 *    from the same shape WITHOUT passthrough, so a publish call site gets
 *    TypeScript excess-property checking. Publishing an unknown event name, or a
 *    payload with a misspelled/unknown key, is a compile error.
 *
 *    Excess-property checking alone only covers FRESH OBJECT LITERALS — a widened
 *    variable (`const d = { typo: 1 }; publish(id, evt, d)`) would pass by width
 *    subtyping and put an undeclared field on the wire. The publishers therefore
 *    also apply `NoExtraSessionEventKeys`, which maps surplus keys to `never` and
 *    closes the variable and nested-spread routes too.
 *
 *    SCOPE OF THAT GUARANTEE: it covers keys that are STATICALLY VISIBLE at the
 *    call site. It cannot survive type erasure — laundering a value through an
 *    explicit annotation defeats it, because the surplus key stops being part of
 *    the inferred type while the runtime object still carries it:
 *
 *        const raw = { activeAt: 'x', escaped: 'wire' };
 *        const narrowed: SessionEventPublishData<'partner.activity'> = raw;
 *        publishSessionEvent(id, 'partner.activity', narrowed); // compiles
 *
 *    Closing that would require stripping unknown keys at publish time, which is
 *    deliberately NOT done: `.passthrough()` exists precisely so unknown fields
 *    survive, and stripping would remove fields that are on the wire today.
 *
 * The split is the point. Strict where we can fail the build, permissive where a
 * failure would mean a user staring at a chat that never updates.
 *
 * ## Why fields are almost all optional
 *
 * A minority of events are published from several call sites with materially
 * different key sets — but where that happens the divergence is wide
 * (`partner.stage_completed` has five publishers, `session.resolved` six, and
 * their payloads barely overlap). The shapes below are the UNION of what is
 * actually published, with a field marked required only when every publisher of
 * that event sets it. Optionality here documents real divergence in the backend —
 * it is not laziness. Excess-key checking still catches typos, because the key
 * SET is exact even when every member is optional.
 *
 * ## Adding an event
 *
 * Add the name to `SessionEventType` in `../dto/realtime` and a shape here. The
 * `_assertEveryEventHasASchema` / `_assertNoUnknownEventSchemas` checks at the
 * bottom of this file fail the build if the two drift apart, and
 * `__tests__/realtime.contract.test.ts` asserts the same at test time.
 */

import { z } from 'zod';
import type { SessionEventType, UserEventType } from '../dto/realtime';
import type { EmpathyExchangeStatusResponse, EmpathyAttemptDTO } from '../dto/empathy';
import type { MessageDTO } from '../dto/message';
import type { IdentifiedNeedDTO } from '../dto/needs';
import type { AffectedNeed } from '../dto/need-edits';

// ============================================================================
// Structural escape hatches
// ============================================================================

/**
 * A field whose runtime check is only "is a non-null object", but whose
 * TypeScript type is the real DTO.
 *
 * Used for payload fields that embed a large existing response DTO
 * (`EmpathyExchangeStatusResponse` is ~20 fields with nested attempt/reconciler
 * objects). Those DTOs are already the contract of their REST endpoints and are
 * serialized by the same backend code paths; re-deriving them as zod here would
 * duplicate that contract and, on any drift, would DROP a live event rather than
 * surface a type error. Narrow and deliberate: we validate the shape of the
 * envelope and the fields consumers branch on, and treat the embedded DTO as an
 * opaque object.
 */
function opaqueObject<T>(label: string): z.ZodType<T> {
  return z.custom<T>(value => typeof value === 'object' && value !== null && !Array.isArray(value), {
    message: `${label} must be an object`,
  });
}

/**
 * An inline message snippet embedded in several partner events.
 *
 * `timestamp` accepts a string OR a Date: several publishers pass a raw Prisma
 * `Date` (e.g. `controllers/stage2.ts` and `controllers/stage3.ts` forward
 * `recipientMessage.timestamp` unconverted). Ably JSON-serializes it to an ISO
 * string on the wire, but the backend-side type must accept the Date it is
 * actually handed.
 */
export const realtimeInlineMessageSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    timestamp: z.union([z.string(), z.date()]),
    stage: z.number().optional(),
    forUserId: z.string().optional(),
  })
  .passthrough();

const empathyStatus = () => opaqueObject<EmpathyExchangeStatusResponse>('empathyStatus');
const empathyStatusMap = () => opaqueObject<Record<string, EmpathyExchangeStatusResponse>>('empathyStatuses');
const identifiedNeed = () => opaqueObject<IdentifiedNeedDTO>('need');
const affectedNeed = () => opaqueObject<AffectedNeed>('affectedNeed');
const messageDto = () => opaqueObject<MessageDTO>('message');

// ============================================================================
// Envelope
// ============================================================================

/**
 * Fields `publishSessionEvent` stamps onto every session event.
 *
 * `timestamp` and `excludeUserId` are stamped BEFORE the caller's data is spread,
 * so a publisher can override them. `timestamp` is therefore `number | string`:
 * the envelope sets `Date.now()`, but `controllers/sessions.ts` publishes
 * `invitation.confirmed` with an ISO string. Both forms are on the wire today.
 *
 * `sessionId` is stamped AFTER the spread and cannot be overridden — it has to
 * match the channel the event is published to.
 */
export const sessionEventEnvelopeShape = {
  sessionId: z.string(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  excludeUserId: z.string().optional(),
} as const;

export interface SessionEventEnvelope {
  sessionId: string;
  timestamp?: number | string;
  excludeUserId?: string;
}

// ============================================================================
// Per-event payload shapes
// ============================================================================

/**
 * The exhaustive event vocabulary. Every key of `SessionEventType` appears here
 * exactly once; the assertions at the bottom of the file enforce it.
 */
const SESSION_EVENT_SHAPES = {
  // --------------------------------------------------------------------------
  // Partner actions
  // --------------------------------------------------------------------------
  'partner.signed_compact': {
    signedBy: z.string().optional(),
    signedAt: z.string().optional(),
    triggeredByUserId: z.string().optional(),
  },

  /**
   * Five publishers with materially different payloads: the Stage 1 completion
   * ping (`stage` + `completedBy`), the Stage 2 validation result (`validated` +
   * `empathyStatus`), and the Stage 2->3 / 3->4 transitions (`previousStage` +
   * `currentStage` + an addressed `message`). `messagesByUserId` is read by the
   * mobile handler but has no current publisher — kept so the read stays typed.
   */
  'partner.stage_completed': {
    stage: z.number().optional(),
    completedBy: z.string().optional(),
    validated: z.boolean().optional(),
    empathyStatus: empathyStatus().optional(),
    triggeredByUserId: z.string().optional(),
    forUserId: z.string().optional(),
    userId: z.string().optional(),
    previousStage: z.number().optional(),
    currentStage: z.number().optional(),
    message: realtimeInlineMessageSchema.optional(),
    messagesByUserId: z.record(z.string(), realtimeInlineMessageSchema).optional(),
  },

  'partner.advanced': {
    fromStage: z.number().optional(),
    toStage: z.number().optional(),
    advancedAt: z.string().optional(),
    triggeredByUserId: z.string().optional(),
  },

  'partner.empathy_shared': {
    stage: z.number().optional(),
    sharedBy: z.string().optional(),
    sharedByUserId: z.string().optional(),
    empathyStatus: empathyStatus().optional(),
    empathyMessage: realtimeInlineMessageSchema.optional(),
  },

  /** Declared in the union and handled downstream; no current backend publisher. */
  'partner.additional_context_shared': {
    forUserId: z.string().optional(),
    sharedByUserId: z.string().optional(),
    empathyStatus: empathyStatus().optional(),
  },

  /** Declared in the union; no current backend publisher. */
  'partner.empathy_revealed': {
    forUserId: z.string().optional(),
    guesserUserId: z.string().optional(),
    empathyStatus: empathyStatus().optional(),
  },

  'partner.session_viewed': {
    viewedAt: z.string().nullish(),
    activeAt: z.string().nullish(),
    presenceVisible: z.boolean().optional(),
    empathyStatuses: empathyStatusMap().optional(),
  },

  'partner.share_tab_viewed': {
    viewedAt: z.string().nullish(),
    activeAt: z.string().nullish(),
    presenceVisible: z.boolean().optional(),
    empathyStatuses: empathyStatusMap().optional(),
  },

  'partner.activity': {
    activeAt: z.string().optional(),
  },

  'partner.skipped_refinement': {
    willingToAccept: z.boolean().optional(),
  },

  // --------------------------------------------------------------------------
  // Empathy reconciler
  // --------------------------------------------------------------------------
  'empathy.share_suggestion': {
    forUserId: z.string().optional(),
    guesserName: z.string().optional(),
    suggestedContent: z.string().optional(),
    suggestedReason: z.string().optional(),
    shareOffer: opaqueObject<unknown>('shareOffer').optional(),
    empathyStatus: empathyStatus().optional(),
    triggeredByUserId: z.string().optional(),
  },

  'empathy.revealed': {
    direction: z.enum(['outgoing', 'incoming']).optional(),
    guesserUserId: z.string().optional(),
    forUserId: z.string().optional(),
    empathyStatus: empathyStatus().optional(),
    partnerEmpathy: opaqueObject<EmpathyAttemptDTO>('partnerEmpathy').optional(),
    empathyContent: z.string().optional(),
    attemptId: z.string().optional(),
    revealedAt: z.string().optional(),
  },

  'empathy.refining': {
    guesserId: z.string().optional(),
    forUserId: z.string().optional(),
    empathyStatus: empathyStatus().optional(),
    hasNewContext: z.boolean().optional(),
  },

  'empathy.context_shared': {
    stage: z.number().optional(),
    sharedBy: z.string().optional(),
    sharedByUserId: z.string().optional(),
    // `controllers/reconciler.ts` forwards `result.sharedContent`, which is nullable.
    content: z.string().nullish(),
    sharedContent: z.string().nullish(),
    sharedMessage: realtimeInlineMessageSchema.optional(),
    forUserId: z.string().optional(),
    empathyStatus: empathyStatus().optional(),
    triggeredByUserId: z.string().optional(),
  },

  /**
   * Three publishers with near-disjoint payloads: the Stage 2 broadcast
   * (`statuses` + `empathyStatuses`, no recipient), the validation result
   * (`status` + `validatedBy` + feedback), and the reconciler's awaiting-sharing
   * ping (`subjectName` + a human-readable `message` STRING — note that `message`
   * is an object on `partner.stage_completed` and a string here).
   */
  'empathy.status_updated': {
    stage: z.number().optional(),
    status: z.string().optional(),
    statusVersion: z.number().optional(),
    statuses: opaqueObject<Record<string, string | null>>('statuses').optional(),
    empathyStatuses: empathyStatusMap().optional(),
    empathyStatus: empathyStatus().optional(),
    forUserId: z.string().optional(),
    validatedBy: z.string().optional(),
    feedbackShared: z.boolean().optional(),
    validationFeedback: z.string().optional(),
    subjectName: z.string().optional(),
    message: z.string().optional(),
    triggeredByUserId: z.string().optional(),
  },

  'empathy.resubmitted': {
    forUserId: z.string().optional(),
    guesserUserId: z.string().optional(),
    empathyStatus: empathyStatus().optional(),
  },

  // --------------------------------------------------------------------------
  // Stage 3: need mapping
  // --------------------------------------------------------------------------
  'session.needs_extracted': {
    forUserId: z.string().optional(),
    userId: z.string().optional(),
    needsCount: z.number().optional(),
    capturedAt: z.string().optional(),
  },

  'need.captured': {
    forUserId: z.string().optional(),
    userId: z.string().optional(),
    need: identifiedNeed().optional(),
    affectedNeed: affectedNeed().optional(),
    capturedAt: z.string().optional(),
  },

  'need.refined': {
    forUserId: z.string().optional(),
    userId: z.string().optional(),
    need: identifiedNeed().optional(),
    oldNeed: identifiedNeed().optional(),
    affectedNeed: affectedNeed().optional(),
    oldId: z.string().optional(),
    newId: z.string().optional(),
  },

  'need.locked': {
    forUserId: z.string().optional(),
    userId: z.string().optional(),
    need: identifiedNeed().optional(),
    oldNeed: identifiedNeed().optional(),
    affectedNeed: affectedNeed().optional(),
    oldId: z.string().optional(),
    newId: z.string().optional(),
  },

  'need.deleted': {
    forUserId: z.string().optional(),
    userId: z.string().optional(),
    need: identifiedNeed().optional(),
    oldNeed: identifiedNeed().optional(),
    affectedNeed: affectedNeed().optional(),
    oldId: z.string().optional(),
    newId: z.string().optional(),
  },

  'partner.needs_confirmed': {
    stage: z.number().optional(),
    confirmedBy: z.string().optional(),
  },

  'partner.needs_shared': {
    stage: z.number().optional(),
    sharedBy: z.string().optional(),
    needsRevealReady: z.boolean().optional(),
  },

  'partner.needs_validated': {
    stage: z.number().optional(),
    validatedBy: z.string().optional(),
    validated: z.boolean().optional(),
    allValidatedByBoth: z.boolean().optional(),
  },

  'session.needs_reveal_ready': {
    stage: z.number().optional(),
    needsRevealReady: z.boolean().optional(),
  },

  /** Legacy alias for `session.needs_reveal_ready`; no current publisher. */
  'session.common_ground_ready': {
    stage: z.number().optional(),
    needsRevealReady: z.boolean().optional(),
  },

  /** Legacy alias for `partner.needs_validated`; no current publisher. */
  'partner.common_ground_confirmed': {
    stage: z.number().optional(),
    validatedBy: z.string().optional(),
    validated: z.boolean().optional(),
  },

  // --------------------------------------------------------------------------
  // Stage 4: strategic repair
  // --------------------------------------------------------------------------
  'session.strategies_updated': {
    stage: z.number().optional(),
    submittedBy: z.string().optional(),
    updatedBy: z.string().optional(),
    change: z.string().optional(),
    appliedOperationCount: z.number().optional(),
    skippedOperationCount: z.number().optional(),
    selectionCaptured: z.boolean().optional(),
    walkthroughUpdated: z.boolean().optional(),
    action: z.string().optional(),
    needId: z.string().nullish(),
  },

  'partner.ranking_submitted': {
    stage: z.number().optional(),
    submittedBy: z.string().optional(),
  },

  'partner.ready_to_rank': {
    stage: z.number().optional(),
    readyBy: z.string().optional(),
  },

  'partner.consent_granted': {
    contentType: z.string().optional(),
    consentedAt: z.string().optional(),
  },

  'partner.consent_revoked': {
    contentType: z.string().optional(),
    revokedAt: z.string().optional(),
  },

  // --------------------------------------------------------------------------
  // Agreements
  // --------------------------------------------------------------------------
  'agreement.proposed': {
    agreementId: z.string().optional(),
    proposedBy: z.string().optional(),
  },

  'agreement.confirmed': {
    agreementId: z.string().optional(),
    confirmedBy: z.string().optional(),
    confirmed: z.boolean().optional(),
    bothConfirmed: z.boolean().optional(),
  },

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------
  'session.joined': {
    joinedBy: z.string().optional(),
    userId: z.string().optional(),
    userName: z.string().nullish(),
  },

  'session.paused': {
    pausedBy: z.string().optional(),
    pausedAt: z.string().optional(),
    reason: z.string().optional(),
  },

  'session.resumed': {
    resumedBy: z.string().optional(),
    resumedAt: z.string().optional(),
  },

  /**
   * Six publishers, three incompatible shapes: the manual resolve
   * (`resolvedBy`/`resolvedAt`), the Stage 4 closure pair (`closedBy`/`kind` on
   * the partner notify, `closureKind` on the session broadcast), and the
   * agreement-confirmation nudge (`agreementId` singular).
   */
  'session.resolved': {
    resolvedBy: z.string().optional(),
    resolvedAt: z.string().optional(),
    closedBy: z.string().optional(),
    kind: z.string().optional(),
    closureKind: z.string().optional(),
    agreementIds: z.array(z.string()).optional(),
    agreementId: z.string().optional(),
  },

  'session.abandoned': {
    reason: z.string().optional(),
    partnerName: z.string().optional(),
  },

  /**
   * Stage 0 topic-frame draft updates. Published directly via
   * `publishTopicFrameUpdated` rather than `publishSessionEvent`, so it carries
   * the envelope but never an `excludeUserId`.
   */
  'session.topic_frame_updated': {
    topicFrame: z.string().optional(),
    confirmed: z.boolean().optional(),
  },

  // --------------------------------------------------------------------------
  // Invitations
  // --------------------------------------------------------------------------
  'invitation.declined': {
    reason: z.string().optional(),
  },

  /** The one event that overrides the envelope `timestamp` with an ISO string. */
  'invitation.confirmed': {
    confirmedBy: z.string().optional(),
    triggeredByUserId: z.string().optional(),
  },

  // --------------------------------------------------------------------------
  // Presence / typing / stage sync
  // --------------------------------------------------------------------------
  'presence.online': {
    userId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
  },
  'presence.offline': {
    userId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
  },
  'presence.away': {
    userId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
  },

  'typing.start': {
    userId: z.string().optional(),
    isTyping: z.boolean().optional(),
  },
  'typing.stop': {
    userId: z.string().optional(),
    isTyping: z.boolean().optional(),
  },

  'stage.progress': {
    userId: z.string().optional(),
    stage: z.number().optional(),
    previousStage: z.number().optional(),
    status: z.string().optional(),
    triggeredByUserId: z.string().optional(),
  },
  'stage.waiting': {
    userId: z.string().optional(),
    stage: z.number().optional(),
    status: z.string().optional(),
  },

  // --------------------------------------------------------------------------
  // Memory
  // --------------------------------------------------------------------------
  'memory.suggested': {
    suggestion: opaqueObject<unknown>('suggestion').optional(),
  },

  // --------------------------------------------------------------------------
  // Fire-and-forget message events
  // --------------------------------------------------------------------------
  /**
   * `message` carries a whole `MessageDTO` straight into the mobile React Query
   * cache. It is validated as an object rather than field-by-field for the same
   * reason as `empathyStatus`: it is already the contract of the messages REST
   * endpoints, and a stricter check here would drop AI responses (a visible,
   * user-facing failure) instead of surfacing a type error.
   *
   * `expectingMore` is accepted by `publishMessageAIResponse`'s metadata
   * parameter and ships on the wire, but was never declared on
   * `MessageAIResponsePayload`. Declared here so the contract matches reality.
   */
  'message.ai_response': {
    forUserId: z.string().optional(),
    message: messageDto().optional(),
    /** TS-12 (R36): the reply's id; the session channel carries no message text — the addressed client refetches. */
    messageId: z.string().optional(),
    offerFeelHeardCheck: z.boolean().optional(),
    offerReadyToShare: z.boolean().optional(),
    proposedEmpathyStatement: z.string().nullish(),
    expectingMore: z.boolean().optional(),
  },

  'message.error': {
    forUserId: z.string().optional(),
    userMessageId: z.string().optional(),
    error: z.string().optional(),
    canRetry: z.boolean().optional(),
  },

  // --------------------------------------------------------------------------
  // Context assembly (Neural Monitor dashboard)
  // --------------------------------------------------------------------------
  'context.updated': {
    userId: z.string().optional(),
    assembledAt: z.string().optional(),
  },

  // --------------------------------------------------------------------------
  // Notifications
  // --------------------------------------------------------------------------
  /**
   * Two distinct producer families share this event name: the empathy reconciler
   * (`actionType` + `actionId`) and the tending service (`kind` + a per-kind tail).
   * The `kind` values are open-ended by design — tending adds new ones — so `kind`
   * is a plain string rather than an enum, and the per-kind fields are all optional.
   */
  'notification.pending_action': {
    forUserId: z.string().optional(),
    actionType: z.string().optional(),
    actionId: z.string().optional(),
    kind: z.string().optional(),
    userId: z.string().optional(),
    // Nullable: the tending reminder payload forwards a nullable FK.
    tendingEntryId: z.string().nullish(),
    ownerUserId: z.string().optional(),
    submittedBy: z.string().optional(),
    createdBy: z.string().optional(),
    continueChoice: z.string().optional(),
    nextAction: z.string().optional(),
    newSessionId: z.string().optional(),
    scope: z.string().optional(),
    reminderId: z.string().optional(),
    note: z.string().nullish(),
    coordinationCycleId: z.string().optional(),
    submittedUserIds: z.array(z.string()).optional(),
    missingUserIds: z.array(z.string()).optional(),
    resultSummary: z.string().optional(),
    nextScheduledFor: z.string().nullish(),
  },
} as const satisfies Record<SessionEventType, z.ZodRawShape>;

type SessionEventShapes = typeof SESSION_EVENT_SHAPES;

/** The validated payload type for each event: envelope + that event's fields. */
export type SessionEventDataMap = {
  [E in SessionEventType]: SessionEventEnvelope &
    z.infer<z.ZodObject<SessionEventShapes[E]>> & { [key: string]: unknown };
};

/**
 * Runtime schemas — `.passthrough()`, so unknown keys survive validation.
 * See the two-tier note in the module docblock.
 */
export const SESSION_EVENT_DATA_SCHEMAS = Object.fromEntries(
  Object.entries(SESSION_EVENT_SHAPES).map(([name, shape]) => [
    name,
    z.object({ ...sessionEventEnvelopeShape, ...(shape as z.ZodRawShape) }).passthrough(),
  ]),
) as unknown as { [E in SessionEventType]: z.ZodType<SessionEventDataMap[E]> };

export const SESSION_EVENT_NAMES = Object.keys(SESSION_EVENT_SHAPES) as readonly SessionEventType[];

/**
 * Envelope fields a publisher may set explicitly. `sessionId` is accepted
 * because one publisher re-passes it, but `publishSessionEvent` stamps the real
 * one last so a caller can never override or blank the channel's session.
 */
type SessionEventEnvelopeOverrides = {
  sessionId?: string;
  timestamp?: number | string;
  excludeUserId?: string;
};

/**
 * The compile-time payload type for publishers.
 *
 * Derived from the shape WITHOUT passthrough, so an object literal passed to
 * `publishSessionEvent` / `notifyPartner` gets excess-property checking: a
 * misspelled or unknown key is a compile error.
 *
 * Distributive over `E`, so a union event name yields a union of payloads.
 *
 * KNOWN LIMITATION: when `E` is a union — as at the `need.*` publish sites in
 * `services/stream-turn-actions.ts`, which pass a variable event name —
 * TypeScript's excess-property check admits any key belonging to ANY member of
 * the union. So `{ capturedAt }` compiles for `'need.captured' | 'need.refined'`
 * even though only `need.captured` declares it. Unknown keys are still rejected;
 * what is lost is the event-to-payload correlation, which TypeScript cannot
 * express for an uncorrelated union discriminant. Publishing with a literal
 * event name gets the exact check.
 */
export type SessionEventPublishData<E extends SessionEventType> = E extends SessionEventType
  ? z.input<z.ZodObject<SessionEventShapes[E]>> & SessionEventEnvelopeOverrides
  : never;

/**
 * Every key any member of `E` declares, unioned.
 *
 * Distributes before taking `keyof`, because `keyof (A | B)` is the
 * INTERSECTION of their keys — which would wrongly reject a key valid for only
 * one member at the union-event publish sites.
 */
type SessionEventKeys<E extends SessionEventType> = E extends SessionEventType
  ? keyof SessionEventPublishData<E>
  : never;

/**
 * Rejects keys the contract does not declare, even when the payload is a
 * VARIABLE rather than a fresh object literal.
 *
 * TypeScript's excess-property check only fires on fresh literals, so
 * `const d = { typo: 1 }; publish(id, evt, d)` would otherwise compile by width
 * subtyping and put an undeclared field on the wire. Mapping the surplus keys to
 * `never` closes that: a payload carrying one cannot satisfy the parameter.
 *
 * Bounded by type erasure — it only sees keys present in `T`. Annotating a value
 * as `SessionEventPublishData<E>` first erases the surplus key from the type
 * while the runtime object keeps it, and no type-level construct can catch that.
 * See the module docblock for why this is accepted rather than fixed with
 * runtime stripping.
 */
export type NoExtraSessionEventKeys<E extends SessionEventType, T> = {
  [K in Exclude<keyof T, SessionEventKeys<E>>]?: never;
};

type UserEventKeys<E extends UserEventType> = E extends UserEventType ? keyof UserEventPublishData<E> : never;

export type NoExtraUserEventKeys<E extends UserEventType, T> = {
  [K in Exclude<keyof T, UserEventKeys<E>>]?: never;
};

/** A full session event as a discriminated union on the event name. */
export type SessionRealtimeEvent = {
  [E in SessionEventType]: { event: E; data: SessionEventDataMap[E] };
}[SessionEventType];

// ============================================================================
// User-channel events
// ============================================================================

const userEventEnvelopeShape = {
  sessionId: z.string(),
  timestamp: z.union([z.number(), z.string()]).optional(),
} as const;

const USER_EVENT_SHAPES = {
  /**
   * Published by `notifySessionMembers` after every non-transient session event
   * (bare `sessionId` only), and by the tending service with a `kind` tail.
   */
  'session.updated': {
    kind: z.string().optional(),
    userId: z.string().optional(),
    tendingEntryId: z.string().nullish(),
    scope: z.string().optional(),
    reminderId: z.string().optional(),
    note: z.string().nullish(),
  },

  /** Declared in `UserEventType` and handled by mobile; no current publisher. */
  'session.new_message': {
    messageId: z.string().optional(),
  },

  /**
   * Handled by mobile (`useRealtime` -> `UnifiedSessionScreen`) but never
   * published by the backend. Kept typed so the consumer read stays checked.
   */
  'memory.suggested': {
    suggestion: opaqueObject<unknown>('suggestion').optional(),
  },
} as const satisfies Record<UserEventType, z.ZodRawShape>;

type UserEventShapes = typeof USER_EVENT_SHAPES;

export interface UserEventEnvelope {
  sessionId: string;
  timestamp?: number | string;
}

export type UserEventDataMap = {
  [E in UserEventType]: UserEventEnvelope & z.infer<z.ZodObject<UserEventShapes[E]>> & { [key: string]: unknown };
};

export const USER_EVENT_DATA_SCHEMAS = Object.fromEntries(
  Object.entries(USER_EVENT_SHAPES).map(([name, shape]) => [
    name,
    z.object({ ...userEventEnvelopeShape, ...(shape as z.ZodRawShape) }).passthrough(),
  ]),
) as unknown as { [E in UserEventType]: z.ZodType<UserEventDataMap[E]> };

export const USER_EVENT_NAMES = Object.keys(USER_EVENT_SHAPES) as readonly UserEventType[];

export type UserEventPublishData<E extends UserEventType> = z.input<z.ZodObject<UserEventShapes[E]>> &
  UserEventEnvelope;

// ============================================================================
// Consumer boundary
// ============================================================================

/** The minimum any session-channel payload must satisfy to be delivered. */
export const sessionEventEnvelopeSchema = z.object(sessionEventEnvelopeShape).passthrough();

export function isKnownSessionEventName(name: string): name is SessionEventType {
  return Object.prototype.hasOwnProperty.call(SESSION_EVENT_DATA_SCHEMAS, name);
}

export function isKnownUserEventName(name: string): name is UserEventType {
  return Object.prototype.hasOwnProperty.call(USER_EVENT_DATA_SCHEMAS, name);
}

/**
 * The outcome of validating one session-channel event.
 *
 * The `known` case is distributed over `SessionEventType`, so a consumer that
 * switches on `parsed.event` gets `parsed.data` narrowed to that event's payload
 * with no cast.
 */
export type ParsedSessionEvent =
  | ({ kind: 'known' } & {
      [E in SessionEventType]: { event: E; data: SessionEventDataMap[E] };
    }[SessionEventType])
  | {
      /**
       * The event name is not in `SessionEventType`, but the payload is a valid
       * envelope. Delivered rather than dropped so a newly-deployed backend event
       * still reaches an older client — the existing forward-compatibility
       * behaviour of the mobile handler.
       */
      kind: 'unknown-event';
      event: string;
      data: SessionEventEnvelope & { [key: string]: unknown };
    }
  | { kind: 'invalid'; reason: 'invalid-payload' | 'invalid-envelope' };

/**
 * Validate one session-channel event at the consumer boundary.
 *
 * Returns the typed payload, or `{ kind: 'invalid' }` when the payload cannot be
 * trusted. Consumers must treat `invalid` as "drop the event" — never let an
 * unvalidated payload through.
 *
 * Deliberately narrow about what it rejects: the per-event schemas are
 * `.passthrough()` with near-universally optional fields, so a payload fails only
 * when it is not an object, when `sessionId` is missing or not a string, or when
 * a DECLARED field carries the wrong type (see the module docblock for the full
 * rejection surface). No current publisher produces any of those.
 *
 * An unrecognised event NAME is not a failure — it falls back to envelope
 * validation and is delivered, matching how the mobile handler already treats
 * event names as open-ended.
 */
export function parseSessionEvent(eventName: string, raw: unknown): ParsedSessionEvent {
  if (!isKnownSessionEventName(eventName)) {
    const envelope = sessionEventEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return { kind: 'invalid', reason: 'invalid-envelope' };
    return {
      kind: 'unknown-event',
      event: eventName,
      data: envelope.data as SessionEventEnvelope & { [key: string]: unknown },
    };
  }

  const result = SESSION_EVENT_DATA_SCHEMAS[eventName].safeParse(raw);
  if (!result.success) return { kind: 'invalid', reason: 'invalid-payload' };
  return { kind: 'known', event: eventName, data: result.data } as ParsedSessionEvent;
}

/**
 * Typed single-event parse, mirroring `parseStreamEventData`.
 * Returns `null` when the payload fails validation.
 */
export function parseSessionEventData<E extends SessionEventType>(
  eventName: E,
  raw: unknown,
): SessionEventDataMap[E] | null {
  const result = SESSION_EVENT_DATA_SCHEMAS[eventName].safeParse(raw);
  return result.success ? (result.data as SessionEventDataMap[E]) : null;
}

export function parseUserEventData<E extends UserEventType>(eventName: E, raw: unknown): UserEventDataMap[E] | null {
  const result = USER_EVENT_DATA_SCHEMAS[eventName].safeParse(raw);
  return result.success ? (result.data as UserEventDataMap[E]) : null;
}

// ============================================================================
// Known protocol drift
// ============================================================================

/**
 * Event names the mobile client branches on that no backend publisher emits.
 *
 * Recorded rather than silently added to `SessionEventType`, so the drift stays
 * visible. `parseSessionEvent` delivers these via the unknown-event path, so the
 * dead branches keep their current (never-taken) behaviour.
 */
export const MOBILE_ONLY_EVENT_NAMES = ['partner.marked_ready', 'session.needs_revealed'] as const;

// ============================================================================
// Compile-time exhaustiveness
// ============================================================================

/** Fails the build if a `SessionEventType` member has no schema. */
const _assertEveryEventHasASchema: Record<SessionEventType, z.ZodTypeAny> = SESSION_EVENT_DATA_SCHEMAS;
void _assertEveryEventHasASchema;

/** Fails the build if a schema exists for a name that is not a `SessionEventType`. */
type UnknownSessionEventSchemaKeys = Exclude<keyof SessionEventShapes, SessionEventType>;
const _assertNoUnknownEventSchemas: UnknownSessionEventSchemaKeys extends never ? true : never = true;
void _assertNoUnknownEventSchemas;

const _assertEveryUserEventHasASchema: Record<UserEventType, z.ZodTypeAny> = USER_EVENT_DATA_SCHEMAS;
void _assertEveryUserEventHasASchema;

type UnknownUserEventSchemaKeys = Exclude<keyof UserEventShapes, UserEventType>;
const _assertNoUnknownUserEventSchemas: UnknownUserEventSchemaKeys extends never ? true : never = true;
void _assertNoUnknownUserEventSchemas;
