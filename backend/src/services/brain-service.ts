import { logger } from '../lib/logger';
import { getAiPrisma } from '../lib/prisma';
import { withSessionScope } from '../lib/request-context';
import { getRequestContext } from '../lib/request-context';
import { getAbly } from '../services/realtime';
import { ActivityType, ActivityStatus, BrainActivity, BrainCallType, Prisma } from '../generated/prisma/client';

// TS-9 (mechanical): the target schema names the enum `BrainCallType`
// (spec §3, same members); the app keeps importing it under its old name.
const BrainActivityCallType = BrainCallType;
type BrainActivityCallType = BrainCallType;

export type ActivityInput = {
  sessionId?: string;
  innerWorkSessionId?: string;
  turnId?: string;
  activityType: ActivityType;
  model: string;
  input: unknown;
  metadata?: unknown;
  callType?: BrainActivityCallType;
  /** R40: attribute the row to the request's participant (their own content only). */
  attributeToCaller?: boolean;
};

export { BrainActivityCallType };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | undefined): string | null => (v && UUID.test(v) ? v : null);
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * The telemetry writer (TS-12, spec §1.8 brain_activity): rows are written by
 * the JOB (`mwf_job`) — `brain_activity` has no `mwf_app` grant at all — and
 * attributed at capture. Ruling R40: `participant_user_id` is set ONLY for a call
 * whose whole content is the calling participant's (`attributeToCaller`, from
 * the call site's `ownContent`); every call that reads or produces another
 * participant's content (reconciler, share suggestion/offer, empathy analysis
 * and refinement, transitions, dispatch) stays NULL with its session_id, so
 * the anonymise walk's R17 arm removes it when either participant leaves.
 * `reflection_id` is the reflection a turn belongs to. The job writes
 * through raw statements naming exactly its granted columns and never reads a
 * prompt back (RETURNING id, created_at only).
 *
 * Telemetry never breaks the call it describes: a failed write is logged and
 * the caller gets an unsaved record (empty id); completing or failing an
 * unsaved record is a no-op.
 */
export class BrainService {
  private static instance: BrainService;

  // Ably channel name for real-time updates
  private readonly CHANNEL_NAME = 'ai-audit-stream';

  private constructor() {}

  /**
   * The session each open activity row belongs to (work-k5fk.10.5): the AI writes a telemetry row
   * only within that session's app.session_scope (t_session_scope), and completeActivity /
   * failActivity name only the row's id. Entries go when the row is completed or failed.
   */
  private readonly activitySessions = new Map<string, string | null>();

  /** Run `fn` scoped to the activity's session (none for a sessionless — inner-work — row). */
  private inScope<T>(sessionId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    return sessionId ? withSessionScope(sessionId, fn) : fn();
  }

  public static getInstance(): BrainService {
    if (!BrainService.instance) {
      BrainService.instance = new BrainService();
    }
    return BrainService.instance;
  }

  /**
   * Whose turn: the request's participant in this session (its user id — the row's
   * participant is (session_id, participant_user_id), work-k5fk.3), else (job) the
   * request user, if they are a participant there.
   */
  private async participantUserFor(sessionId: string | null): Promise<string | null> {
    if (!sessionId) return null;
    const ctx = getRequestContext();
    if (ctx?.seated && ctx.sessionId === sessionId && ctx.userId) return ctx.userId;
    if (!ctx?.userId || !UUID.test(ctx.userId)) return null;
    const rows = await getAiPrisma().$queryRaw<Array<{ user_id: string }>>`SELECT user_id FROM participant
      WHERE session_id = ${sessionId}::uuid AND user_id = ${ctx.userId}::uuid`;
    return rows[0]?.user_id ?? null;
  }

  /**
   * Start tracking a brain activity. Creates a PENDING record.
   */
  public async startActivity(params: ActivityInput): Promise<BrainActivity> {
    const sessionId = uuidOrNull(params.sessionId);
    const reflectionId = uuidOrNull(params.innerWorkSessionId);
    const now = new Date();
    const record: BrainActivity = {
      id: '',
      sessionId,
      reflectionId,
      participantUserId: null,
      turnId: params.turnId ?? null,
      activityType: params.activityType,
      callType: params.callType ?? null,
      model: params.model,
      input: params.input ?? {},
      output: null,
      metadata: params.metadata ?? {},
      structuredOutput: null,
      tokenCountInput: 0,
      tokenCountOutput: 0,
      durationMs: 0,
      cost: new Prisma.Decimal(0),
      status: ActivityStatus.PENDING,
      createdAt: now,
      completedAt: null,
      updatedAt: now,
    };
    try {
      record.participantUserId = params.attributeToCaller ? await this.participantUserFor(sessionId) : null;
      // The telemetry row of an AI call on `sessionId` is written in that session's scope.
      const rows = await this.inScope(sessionId, async () => await getAiPrisma().$queryRaw<Array<{ id: string; created_at: Date }>>`INSERT INTO brain_activity
          (session_id, reflection_id, participant_user_id, turn_id, activity_type, call_type, model, input, metadata,
           status)
        VALUES (${sessionId}::uuid, ${reflectionId}::uuid, ${record.participantUserId}::uuid, ${record.turnId},
                ${params.activityType}::activity_type, ${record.callType}::brain_call_type, ${params.model},
                ${json(record.input)}::jsonb, ${json(record.metadata)}::jsonb, 'PENDING'::activity_status)
        RETURNING id, created_at`);
      record.id = rows[0].id;
      this.activitySessions.set(record.id, sessionId);
      // An activity never completed or failed (a crashed call) must not grow the map without bound.
      if (this.activitySessions.size > 5000) {
        const oldest = this.activitySessions.keys().next().value;
        if (oldest !== undefined) this.activitySessions.delete(oldest);
      }
      record.createdAt = rows[0].created_at;
      this.broadcastUpdate(record);
    } catch (error) {
      // Telemetry must not break the call it describes (an LLM turn, a retrieval).
      logger.error('[BrainService] Failed to start activity:', error);
    }
    return record;
  }

  /**
   * Complete a brain activity. Updates status to COMPLETED and fills in results/stats.
   */
  public async completeActivity(
    activityId: string,
    result: {
      output: unknown;
      tokenCountInput?: number;
      tokenCountOutput?: number;
      cost?: number;
      durationMs?: number;
      metadata?: unknown;
      structuredOutput?: unknown;
    },
  ): Promise<BrainActivity | null> {
    if (!activityId) return null;
    try {
      const completedAt = new Date();
      const sessionId = this.activitySessions.get(activityId);
      this.activitySessions.delete(activityId);
      await this.inScope(sessionId, async () => await getAiPrisma().$executeRaw`UPDATE brain_activity
        SET output = ${json(result.output ?? {})}::jsonb,
            token_count_input = ${result.tokenCountInput ?? 0},
            token_count_output = ${result.tokenCountOutput ?? 0},
            cost = ${result.cost ?? 0},
            duration_ms = ${result.durationMs ?? 0},
            status = 'COMPLETED'::activity_status,
            completed_at = ${completedAt},
            structured_output = ${json(result.structuredOutput)}::jsonb
            ${result.metadata ? Prisma.sql`, metadata = ${json(result.metadata)}::jsonb` : Prisma.empty}
        WHERE id = ${activityId}::uuid`);
      const activity = {
        id: activityId,
        status: ActivityStatus.COMPLETED,
        output: result.output ?? {},
        tokenCountInput: result.tokenCountInput ?? 0,
        tokenCountOutput: result.tokenCountOutput ?? 0,
        durationMs: result.durationMs ?? 0,
        completedAt,
      } as unknown as BrainActivity;
      this.broadcastUpdate(activity);
      return activity;
    } catch (error) {
      logger.error(`[BrainService] Failed to complete activity ${activityId}:`, error);
      return null;
    }
  }

  /**
   * Merge a turn's pipeline trace into the metadata of its latest
   * ORCHESTRATED_RESPONSE activity (ai-orchestrator storeTurnTrace; TS-12: as
   * the job — brain_activity has no mwf_app grant). One statement; a missing
   * activity is a no-op. Never throws.
   */
  public async mergeTurnTrace(sessionId: string, turnId: string, turnTrace: unknown): Promise<void> {
    try {
      await this.inScope(sessionId, async () => await getAiPrisma().$executeRaw`UPDATE brain_activity
        SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('turnTrace', ${JSON.stringify(turnTrace)}::jsonb)
        WHERE id = (SELECT b.id FROM brain_activity b
                    WHERE b.session_id = ${sessionId}::uuid AND b.turn_id = ${turnId}
                      AND b.call_type = 'ORCHESTRATED_RESPONSE'::brain_call_type
                    ORDER BY b.created_at DESC LIMIT 1)`);
    } catch (error) {
      logger.warn('[BrainService] Failed to store turn trace:', error);
    }
  }

  /**
   * Mark an activity as FAILED.
   */
  public async failActivity(activityId: string, error: unknown): Promise<BrainActivity | null> {
    if (!activityId) return null;
    try {
      const completedAt = new Date();
      const metadata = { error: typeof error === 'object' ? JSON.stringify(error) : String(error) };
      const sessionId = this.activitySessions.get(activityId);
      this.activitySessions.delete(activityId);
      await this.inScope(sessionId, async () => await getAiPrisma().$executeRaw`UPDATE brain_activity
        SET status = 'FAILED'::activity_status, completed_at = ${completedAt}, metadata = ${JSON.stringify(metadata)}::jsonb
        WHERE id = ${activityId}::uuid`);
      const activity = {
        id: activityId,
        status: ActivityStatus.FAILED,
        completedAt,
        metadata,
      } as unknown as BrainActivity;
      this.broadcastUpdate(activity);
      return activity;
    } catch (e) {
      logger.error(`[BrainService] Failed to fail activity ${activityId}:`, e);
      return null;
    }
  }

  /**
   * Helper to broadcast updates via Ably.
   */
  private broadcastUpdate(activity: BrainActivity) {
    if (process.env.ENABLE_AUDIT_STREAM !== 'true') return;

    const ably = getAbly();
    if (!ably) return;

    const channel = ably.channels.get(this.CHANNEL_NAME);
    // We publish 'brain-activity' event. Status site will need to listen for this.
    channel.publish('brain-activity', activity).catch((err: Error) => {
      logger.warn('[BrainService] Telemetry push failed:', err.message);
    });
  }

  /**
   * Broadcast a user/AI message to the audit stream
   */
  public broadcastMessage(message: {
    id?: string;
    sessionId?: string;
    senderId?: string | null;
    role?: string;
    content?: string;
    stage?: number;
    timestamp?: string | Date;
  }) {
    if (process.env.ENABLE_AUDIT_STREAM !== 'true') return;

    const ably = getAbly();
    if (!ably) return;

    const channel = ably.channels.get(this.CHANNEL_NAME);
    // Standardize payload
    const payload = {
      id: message.id,
      sessionId: message.sessionId,
      senderId: message.senderId,
      role: message.role,
      content: message.content,
      stage: message.stage,
      timestamp: message.timestamp,
    };
    channel.publish('new-message', payload).catch((err: Error) => {
      logger.warn('[BrainService] Message push failed:', err.message);
    });
  }
}

export const brainService = BrainService.getInstance();
