
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getAbly } from '../services/realtime';
import { ActivityType, ActivityStatus, BrainActivity, BrainCallType } from '../generated/prisma/client';

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
  input: any;
  metadata?: any;
  callType?: BrainActivityCallType;
};

export { BrainActivityCallType };

export class BrainService {
  private static instance: BrainService;

  // Ably channel name for real-time updates
  private readonly CHANNEL_NAME = 'ai-audit-stream';

  private constructor() { }

  public static getInstance(): BrainService {
    if (!BrainService.instance) {
      BrainService.instance = new BrainService();
    }
    return BrainService.instance;
  }

  /**
   * Start tracking a brain activity. Creates a PENDING record.
   */
  public async startActivity(params: ActivityInput): Promise<BrainActivity> {
    try {
      const activity = await prisma.brainActivity.create({
        data: {
          ...(params.sessionId ? { session: { connect: { id: params.sessionId } } } : {}),
          // TS-9 (mechanical): InnerWorkSession is `reflection` in the target.
          ...(params.innerWorkSessionId ? { reflection: { connect: { id: params.innerWorkSessionId } } } : {}),
          turnId: params.turnId,
          activityType: params.activityType,
          model: params.model,
          input: params.input ?? {},
          metadata: params.metadata ?? {},
          callType: params.callType,
          status: ActivityStatus.PENDING,
          tokenCountInput: 0,
          tokenCountOutput: 0,
          cost: 0,
          durationMs: 0,
        },
      });

      this.broadcastUpdate(activity);
      return activity;
    } catch (error) {
      logger.error('[BrainService] Failed to start activity:', error);
      // Return a temporary object if DB fails so flow doesn't break, 
      // though ideally we want to fail hard or handle gracefully.
      // For now, rethrow to ensure visibility during dev.
      throw error;
    }
  }

  /**
   * Complete a brain activity. Updates status to COMPLETED and fills in results/stats.
   */
  public async completeActivity(
    activityId: string,
    result: {
      output: any;
      tokenCountInput?: number;
      tokenCountOutput?: number;
      cost?: number;
      durationMs?: number;
      metadata?: any;
      structuredOutput?: any;
    }
  ): Promise<BrainActivity | null> {
    try {
      // Merge new metadata with existing if needed, or structured differently.
      // Prisma JSON updates can be tricky, so we'll fetch-update or just overwrite if structure allows.
      // Here we assume result.metadata is additional info to merge or overwrite.

      const activity = await prisma.brainActivity.update({
        where: { id: activityId },
        data: {
          output: result.output ?? {},
          tokenCountInput: result.tokenCountInput ?? 0,
          tokenCountOutput: result.tokenCountOutput ?? 0,
          cost: result.cost ?? 0,
          durationMs: result.durationMs ?? 0,
          status: ActivityStatus.COMPLETED,
          completedAt: new Date(),
          metadata: result.metadata ? result.metadata : undefined, // Depending on merge strategy
          structuredOutput: result.structuredOutput,
        },
      });

      this.broadcastUpdate(activity);
      return activity;
    } catch (error) {
      logger.error(`[BrainService] Failed to complete activity ${activityId}:`, error);
      return null;
    }
  }

  /**
   * Mark an activity as FAILED.
   */
  public async failActivity(activityId: string, error: any): Promise<BrainActivity | null> {
    try {
      const activity = await prisma.brainActivity.update({
        where: { id: activityId },
        data: {
          status: ActivityStatus.FAILED,
          completedAt: new Date(),
          metadata: { error: typeof error === 'object' ? JSON.stringify(error) : String(error) },
        },
      });

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
    channel.publish('brain-activity', activity).catch((err: any) => {
      logger.warn('[BrainService] Telemetry push failed:', err.message);
    });
  }

  /**
   * Broadcast a user/AI message to the audit stream
   */
  public broadcastMessage(message: any) {
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
    channel.publish('new-message', payload).catch((err: any) => {
      logger.warn('[BrainService] Message push failed:', err.message);
    });
  }
}

export const brainService = BrainService.getInstance();
