/**
 * Unit tests for `scheduleStreamTurnBackgroundJobs`.
 *
 * The contract this pins is narrow but load-bearing: scheduling must be
 * synchronous and non-blocking, and a background job that fails (or hangs)
 * must never fail the turn or delay the response the user is waiting on.
 */

import { scheduleStreamTurnBackgroundJobs } from '../stream-turn-background';
import { loadOwnNotableFacts } from '../participant-memory';
import { isMockLLMEnabled } from '../../lib/bedrock';
import { updateSessionSummary } from '../conversation-summarizer';
import { embedSessionContent } from '../embedding';
import { runPartnerSessionClassifier, ensureFactIds } from '../partner-session-classifier';

// TS-12: the facts read is its own module (participant-memory), mocked at that
// seam — no Prisma mock.
jest.mock('../participant-memory', () => ({
  loadOwnNotableFacts: jest.fn(),
}));

jest.mock('../../lib/bedrock', () => ({
  isMockLLMEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('../conversation-summarizer', () => ({
  updateSessionSummary: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../embedding', () => ({
  embedSessionContent: jest.fn().mockResolvedValue(true),
}));

jest.mock('../partner-session-classifier', () => ({
  runPartnerSessionClassifier: jest.fn().mockResolvedValue({ notableFacts: [], topicContext: '' }),
  ensureFactIds: jest.fn((facts: unknown) => facts),
}));

const sessionId = 'session-1';
const userId = 'user-1';

function params(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    sessionId,
    userId,
    turnId: 'turn-1',
    isDispatchMessage: false,
    content: 'the user said this',
    history: [{ role: 'USER', content: 'earlier' }],
    partnerName: 'Bo',
    ...overrides,
  } as any;
}

/** Lets any already-scheduled microtasks settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('stream-turn-background', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isMockLLMEnabled as jest.Mock).mockReturnValue(false);
    (loadOwnNotableFacts as jest.Mock).mockResolvedValue([]);
  });

  // These tests deliberately schedule work that outlives the call. Any job
  // left pending is released here, deterministically, so it cannot resolve
  // into the next test's mock implementations.
  const pending: Array<() => void> = [];
  afterEach(async () => {
    while (pending.length > 0) pending.pop()!();
    await settle();
  });

  /** A promise the test controls, instead of relying on a timer to be slow. */
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending.push(release);
    return { promise, release };
  }

  describe('scheduling is synchronous and non-blocking', () => {
    it('returns void rather than a promise the caller could await', () => {
      expect(scheduleStreamTurnBackgroundJobs(params())).toBeUndefined();
    });

    it('returns before the classifier has finished, having started it', async () => {
      const gate = deferred();
      let classifierFinished = false;
      (runPartnerSessionClassifier as jest.Mock).mockImplementation(async () => {
        await gate.promise;
        classifierFinished = true;
        return { notableFacts: [] };
      });

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      // The classifier is genuinely running (so this does not pass by
      // omission) but has not finished, because only this test can finish it.
      expect(runPartnerSessionClassifier).toHaveBeenCalled();
      expect(classifierFinished).toBe(false);

      gate.release();
      await settle();
      expect(classifierFinished).toBe(true);
    });

    it('returns before the summary/embedding chain has finished, having started it', async () => {
      const gate = deferred();
      let summaryFinished = false;
      (updateSessionSummary as jest.Mock).mockImplementation(async () => {
        await gate.promise;
        summaryFinished = true;
      });

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect(updateSessionSummary).toHaveBeenCalled();
      expect(summaryFinished).toBe(false);
      // The embed step is chained off the summary, so it has not run either.
      expect(embedSessionContent).not.toHaveBeenCalled();

      gate.release();
      await settle();
      expect(summaryFinished).toBe(true);
    });
  });

  /**
   * NOTE on how these tests actually catch a regression: it is the
   * `await settle()` that does the work, NOT `expect(...).not.toThrow()`,
   * which only sees synchronous throws. Settling lets a rejection that no
   * longer has a `.catch()` surface as an unhandled rejection, which Jest
   * fails the test on. Do not remove the settle as "redundant".
   *
   * Verified by mutation: deleting the summary/embedding `.catch()` handler in
   * stream-turn-background.ts fails five of the tests below.
   */
  describe('a failing background job cannot fail the turn', () => {
    it('does not throw when the summary update rejects', async () => {
      (updateSessionSummary as jest.Mock).mockRejectedValue(new Error('summarizer down'));

      expect(() => scheduleStreamTurnBackgroundJobs(params())).not.toThrow();
      await settle();
    });

    it('does not throw when the embedding step rejects', async () => {
      (embedSessionContent as jest.Mock).mockRejectedValue(new Error('embedding down'));

      expect(() => scheduleStreamTurnBackgroundJobs(params())).not.toThrow();
      await settle();
    });

    it('does not throw when the classifier rejects', async () => {
      (runPartnerSessionClassifier as jest.Mock).mockRejectedValue(new Error('classifier down'));

      expect(() => scheduleStreamTurnBackgroundJobs(params())).not.toThrow();
      await settle();
    });

    it('does not throw when the facts lookup rejects', async () => {
      (loadOwnNotableFacts as jest.Mock).mockRejectedValue(new Error('db down'));

      expect(() => scheduleStreamTurnBackgroundJobs(params())).not.toThrow();
      await settle();
    });

    it('still runs the classifier when the summary chain fails', async () => {
      (updateSessionSummary as jest.Mock).mockRejectedValue(new Error('summarizer down'));

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect(runPartnerSessionClassifier).toHaveBeenCalled();
    });
  });

  describe('skip conditions', () => {
    it('skips both jobs for a dispatch message', async () => {
      scheduleStreamTurnBackgroundJobs(params({ isDispatchMessage: true }));
      await settle();

      expect(updateSessionSummary).not.toHaveBeenCalled();
      expect(runPartnerSessionClassifier).not.toHaveBeenCalled();
    });

    it('skips both jobs in mock LLM mode', async () => {
      (isMockLLMEnabled as jest.Mock).mockReturnValue(true);

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect(updateSessionSummary).not.toHaveBeenCalled();
      expect(runPartnerSessionClassifier).not.toHaveBeenCalled();
    });
  });

  describe('job wiring', () => {
    it('embeds only after the summary has been updated', async () => {
      const order: string[] = [];
      (updateSessionSummary as jest.Mock).mockImplementation(async () => {
        order.push('summary');
      });
      (embedSessionContent as jest.Mock).mockImplementation(async () => {
        order.push('embed');
        return true;
      });

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect(order).toEqual(['summary', 'embed']);
    });

    it('passes only the last five history entries to the classifier', async () => {
      const history = Array.from({ length: 8 }, (_, i) => ({ role: 'USER', content: `m${i}` }));

      scheduleStreamTurnBackgroundJobs(params({ history }));
      await settle();

      const call = (runPartnerSessionClassifier as jest.Mock).mock.calls[0][0];
      expect(call.conversationHistory).toHaveLength(5);
      expect(call.conversationHistory[0].content).toBe('m3');
    });

    it('maps stored roles onto the classifier role vocabulary', async () => {
      scheduleStreamTurnBackgroundJobs(
        params({ history: [{ role: 'USER', content: 'u' }, { role: 'AI', content: 'a' }] })
      );
      await settle();

      const call = (runPartnerSessionClassifier as jest.Mock).mock.calls[0][0];
      expect(call.conversationHistory).toEqual([
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ]);
    });

    it('treats a participant with no facts document as an empty fact list', async () => {
      (loadOwnNotableFacts as jest.Mock).mockResolvedValue(undefined);

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect((runPartnerSessionClassifier as jest.Mock).mock.calls[0][0].existingFactsWithIds).toEqual([]);
    });

    it('upgrades legacy string facts before handing them to the classifier', async () => {
      (loadOwnNotableFacts as jest.Mock).mockResolvedValue(['likes mornings', 'dislikes surprises']);

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect(ensureFactIds).toHaveBeenCalledWith([
        { category: 'Unknown', fact: 'likes mornings' },
        { category: 'Unknown', fact: 'dislikes surprises' },
      ]);
    });

    it('passes categorized facts through unchanged', async () => {
      const facts = [{ category: 'Preference', fact: 'likes mornings' }];
      (loadOwnNotableFacts as jest.Mock).mockResolvedValue(facts);

      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect(ensureFactIds).toHaveBeenCalledWith(facts);
    });

    it('scopes the facts lookup to the acting user and session', async () => {
      scheduleStreamTurnBackgroundJobs(params());
      await settle();

      expect(loadOwnNotableFacts).toHaveBeenCalledWith(sessionId, userId);
    });
  });
});
