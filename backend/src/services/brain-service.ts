import { logger } from '../lib/logger';
import { getJobPrisma } from '../lib/prisma';
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
 * attributed at capture. Ruling R40: `participant_id` is set ONLY for a call
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

  public static getInstance(): BrainService {
    if (!BrainService.instance) {
      BrainService.instance = new BrainService();
    }
    return BrainService.instance;
  }

  /** Whose turn: the request's participant in this session, else (job) the request user's participant there. */
  private async participantFor(sessionId: string | null): Promise<string | null> {
    if (!sessionId) return null;
    const ctx = getRequestContext();
    if (ctx?.participantId && ctx.sessionId === sessionId) return ctx.participantId;
    if (!ctx?.userId || !UUID.test(ctx.userId)) return null;
    const rows = await getJobPrisma().$queryRaw<Array<{ id: string }>>`SELECT id FROM participant
      WHERE session_id = ${sessionId}::uuid AND user_id = ${ctx.userId}::uuid`;
    return rows[0]?.id ?? null;
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
      participantId: null,
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
      record.participantId = params.attributeToCaller ? await this.participantFor(sessionId) : null;
      const rows = await getJobPrisma().$queryRaw<Array<{ id: string; created_at: Date }>>`INSERT INTO brain_activity
          (session_id, reflection_id, participant_id, turn_id, activity_type, call_type, model, input, metadata, status)
        VALUES (${sessionId}::uuid, ${reflectionId}::uuid, ${record.participantId}::uuid, ${record.turnId},
                ${params.activityType}::activity_type, ${record.callType}::brain_call_type, ${params.model},
                ${json(record.input)}::jsonb, ${json(record.metadata)}::jsonb, 'PENDING'::activity_status)
        RETURNING id, created_at`;
      record.id = rows[0].id;
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
      await getJobPrisma().$executeRaw`UPDATE brain_activity
        SET output = ${json(result.output ?? {})}::jsonb,
            token_count_input = ${result.tokenCountInput ?? 0},
            token_count_output = ${result.tokenCountOutput ?? 0},
            cost = ${result.cost ?? 0},
            duration_ms = ${result.durationMs ?? 0},
            status = 'COMPLETED'::activity_status,
            completed_at = ${completedAt},
            structured_output = ${json(result.structuredOutput)}::jsonb
            ${result.metadata ? Prisma.sql`, metadata = ${json(result.metadata)}::jsonb` : Prisma.empty}
        WHERE id = ${activityId}::uuid`;
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
      await getJobPrisma().$executeRaw`UPDATE brain_activity
        SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('turnTrace', ${JSON.stringify(turnTrace)}::jsonb)
        WHERE id = (SELECT b.id FROM brain_activity b
                    WHERE b.session_id = ${sessionId}::uuid AND b.turn_id = ${turnId}
                      AND b.call_type = 'ORCHESTRATED_RESPONSE'::brain_call_type
                    ORDER BY b.created_at DESC LIMIT 1)`;
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
      await getJobPrisma().$executeRaw`UPDATE brain_activity
        SET status = 'FAILED'::activity_status, completed_at = ${completedAt}, metadata = ${JSON.stringify(metadata)}::jsonb
        WHERE id = ${activityId}::uuid`;
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
