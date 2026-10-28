/*
 * TS-12: the cases of this suite that needed the mocked Prisma client (the user
 * message cleanup, its ordering against the error frame, the success-path
 * sequence) run against real tables in services/__tests__/chat-turn.target.test.ts.
 * What remains is the orchestration with every service mocked at its module seam.
 */
/**
 * Controller-level orchestration tests for `sendMessageStream`.
 *
 * The seam-level suites document that `resolveStreamTurn` mutates the caller's
 * metadata in place and only then throws the empty-response guard — so after a
 * failed turn the caller is holding a fully-populated state object (a Stage 3
 * `proposedNeed`, a Stage 0 `topicFrame`, Stage 4 proposals).
 *
 * Nothing in that seam prevents those mutations from being persisted. What
 * protects the staged model is this controller's early return on `streamError`.
 * That guarantee is load-bearing and was previously untested, so it is pinned
 * here: when a turn fails, the persistence and stage-action services must be
 * unreachable.
 *
 * Every extracted service is mocked, because the subject under test is the
 * controller's sequencing, not the services' behavior.
 */

import { Request, Response } from 'express';
import { sendMessageStream } from '../messages';
import { admitStreamTurn } from '../../services/stream-turn-admission';
import { assembleStreamTurnContext } from '../../services/stream-turn-context';
import { runStreamTurnModel } from '../../services/stream-turn-model';
import { resolveStreamTurn } from '../../services/stream-turn-resolution';
import { applyStage3NeedActions, persistTurnState } from '../../services/stream-turn-actions';
import {
  cleanupFailedStreamTurn,
  resolveStage3GateTurn,
  saveAiTurnMessage,
} from '../../services/stream-turn-persistence';
import { scheduleStreamTurnBackgroundJobs } from '../../services/stream-turn-background';

jest.mock('../../services/stream-turn-admission', () => ({
  admitStreamTurn: jest.fn(),
}));
jest.mock('../../services/stream-turn-context', () => ({
  assembleStreamTurnContext: jest.fn(),
}));
jest.mock('../../services/stream-turn-model', () => ({
  runStreamTurnModel: jest.fn(),
}));
jest.mock('../../services/stream-turn-resolution', () => ({
  resolveStreamTurn: jest.fn(),
}));
jest.mock('../../services/stream-turn-actions', () => ({
  applyStage3NeedActions: jest.fn().mockResolvedValue(undefined),
  persistTurnState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/stream-turn-persistence', () => ({
  cleanupFailedStreamTurn: jest.fn().mockResolvedValue(undefined),
  saveAiTurnMessage: jest.fn(),
  resolveStage3GateTurn: jest.fn().mockResolvedValue(null),
  isReadyForStage3RevealText: jest.fn().mockReturnValue(false),
}));
jest.mock('../../services/stream-turn-background', () => ({
  scheduleStreamTurnBackgroundJobs: jest.fn(),
}));
jest.mock('../../services/llm-telemetry', () => ({
  finalizeTurnMetrics: jest.fn(),
  estimateContextSizes: jest.fn().mockReturnValue({}),
  recordContextSizes: jest.fn(),
}));
jest.mock('../../services/realtime', () => ({
  notifyPartner: jest.fn().mockResolvedValue(undefined),
  publishSessionEvent: jest.fn().mockResolvedValue(undefined),
}));

const userMessage = {
  id: 'msg-user-1',
  content: 'It has been a hard week.',
  timestamp: new Date('2026-07-22T10:00:00Z'),
  refiningNeedId: null,
};

/** Metadata a failed turn leaves populated on the object the controller holds. */
const dirtyMetadata = {
  proposedNeed: { need: 'to be heard', category: 'CONNECTION' },
  topicFrame: 'the trip',
  offerFeelHeardCheck: true,
};

/**
 * A single ordered log of BOTH emitted SSE frames and downstream service
 * calls. Asserting frame order and service order separately cannot catch a
 * frame moving across a service boundary, so they share one timeline.
 */
let timeline: string[] = [];

/** Resolvers for any deliberately-held promise, drained after each test. */
let deferredReleases: Array<() => void> = [];

function mockRes() {
  const write = jest.fn((chunk: unknown) => {
    const match = /^event: (.+)$/m.exec(String(chunk));
    if (match) timeline.push(`frame:${match[1]}`);
  });
  const end = jest.fn();
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  let headersSent = false;
  const res = {
    status,
    json,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(() => {
      headersSent = true;
    }),
    write,
    end,
    get headersSent() {
      return headersSent;
    },
  } as unknown as Response;
  const raw = () => write.mock.calls.map(([c]) => String(c)).join('');
  /** Payload of the first frame with the given name, parsed. */
  const payload = (name: string) => {
    const m = new RegExp(`^event: ${name}\\ndata: (.+)$`, 'm').exec(raw());
    return m ? JSON.parse(m[1]) : null;
  };
  return {
    res,
    raw,
    end,
    payload,
    eventNames: () => Array.from(raw().matchAll(/^event: (.+)$/gm)).map(m => m[1]),
  };
}

function mockReq() {
  return {
    user: { id: 'user-1' },
    params: { id: 'session-1' },
    body: { content: userMessage.content },
    query: {},
    on: jest.fn(),
  } as unknown as Request;
}

describe('sendMessageStream — failed turns cannot advance state', () => {
  beforeEach(() => {
    // `clearMocks` clears recorded calls but NOT implementations, so any
    // mockImplementation set inside a test would leak into the next one.
    // Every mock this suite reconfigures is therefore reset explicitly here.
    jest.clearAllMocks();
    timeline = [];
    deferredReleases = [];
    (cleanupFailedStreamTurn as jest.Mock).mockResolvedValue(undefined);
    (resolveStage3GateTurn as jest.Mock).mockResolvedValue(null);
    (applyStage3NeedActions as jest.Mock).mockImplementation(async () => {
      timeline.push('service:applyStage3NeedActions');
    });
    (persistTurnState as jest.Mock).mockImplementation(async () => {
      timeline.push('service:persistTurnState');
    });
    (scheduleStreamTurnBackgroundJobs as jest.Mock).mockImplementation(() => {
      timeline.push('service:scheduleBackgroundJobs');
    });
    (admitStreamTurn as jest.Mock).mockResolvedValue({
      admitted: true,
      user: { id: 'user-1' },
      sessionId: 'session-1',
      content: userMessage.content,
      session: { status: 'ACTIVE', topicFrame: null, topicFrameConfirmedAt: null },
      progress: { id: 'progress-1', gatesSatisfied: {} },
      currentStage: 3,
      refiningNeedContext: null,
      userMessage,
    });
    (assembleStreamTurnContext as jest.Mock).mockResolvedValue({
      history: [],
      userTurnCount: 1,
      turnId: 'turn-1',
      partnerName: 'Bo',
      userName: 'Ann',
      isInvitationPhase: false,
      effectiveStage: 3,
      prompt: { staticBlock: 's', dynamicBlock: 'd' },
      messagesWithContext: [],
    });
    (runStreamTurnModel as jest.Mock).mockResolvedValue({
      accumulatedText: 'partial',
      metadata: { ...dirtyMetadata },
      captured: {},
    });
    (resolveStreamTurn as jest.Mock).mockResolvedValue({
      accumulatedText: 'the reply',
      metadata: { ...dirtyMetadata },
      isDispatchMessage: false,
    });
    (saveAiTurnMessage as jest.Mock).mockImplementation(async () => {
      timeline.push('service:saveAiTurnMessage');
      return { id: 'msg-ai-1', content: 'the reply' };
    });
  });

  afterEach(async () => {
    // Release anything a test held open, including on the failure path, so a
    // failed assertion cannot leave sendMessageStream pending forever.
    while (deferredReleases.length > 0) deferredReleases.pop()!();
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('when resolution throws (empty response, stream failure)', () => {
    beforeEach(() => {
      (resolveStreamTurn as jest.Mock).mockRejectedValue(new Error('AI response was empty after tag stripping'));
    });

    it('never reaches the stage-action or persistence services', async () => {
      const { res } = mockRes();

      await sendMessageStream(mockReq(), res);

      // These are the two services that would write the mutated metadata into
      // the staged model. Both must be unreachable on the failure path.
      expect(applyStage3NeedActions).not.toHaveBeenCalled();
      expect(persistTurnState).not.toHaveBeenCalled();
      expect(saveAiTurnMessage).not.toHaveBeenCalled();
    });

    /**
     * The cleanup must be AWAITED, not fire-and-forget. If the client is told
     * the turn failed before the user message is actually deleted, an
     * immediate retry races the delete and can leave a duplicate user message
     * in the conversation. Asserting only that cleanup "was called" does not
     * catch a dropped `await`, so this holds the cleanup open and checks that
     * nothing reaches the client until it resolves.
     */

    it('does not schedule background jobs for a failed turn', async () => {
      const { res } = mockRes();

      await sendMessageStream(mockReq(), res);

      expect(scheduleStreamTurnBackgroundJobs).not.toHaveBeenCalled();
    });

    it('does not emit any of the mutated metadata on the wire', async () => {
      const handle = mockRes();

      await sendMessageStream(mockReq(), handle.res);

      // EVERY value the failed turn left populated must be absent, not just a
      // sample of them.
      for (const leaked of ['to be heard', 'CONNECTION', 'the trip', 'offerFeelHeardCheck']) {
        expect(handle.raw()).not.toContain(leaked);
      }
    });
  });
});
