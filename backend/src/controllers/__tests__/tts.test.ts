/**
 * Tests for the TTS controller.
 *
 * Tests use mock req/res objects and mock global fetch.
 * Covers retry logic, structured error logging, and streaming behavior.
 */

import { Request, Response } from 'express';

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../lib/logger', () => ({
  logger: mockLogger,
}));

// Suppress real timers for retry delays
jest.useFakeTimers();

let streamTTS: (req: Request, res: Response) => Promise<void | Response>;
let originalFetch: typeof global.fetch;

function createMockReqRes(overrides?: { body?: Record<string, unknown>; query?: Record<string, unknown> }) {
  const jsonMock = jest.fn().mockReturnThis();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const setHeaderMock = jest.fn();
  const pipeMock = jest.fn();

  const req = {
    body: overrides?.body || { text: 'Hello world', voice: 'alloy', model: 'tts-1' },
    query: overrides?.query || {},
  } as unknown as Request;

  const res = {
    json: jsonMock,
    status: statusMock,
    setHeader: setHeaderMock,
    headersSent: false,
  } as unknown as Response;

  return { req, res, jsonMock, statusMock, setHeaderMock };
}

function mockFetchOk() {
  const pipeMock = jest.fn();
  const mockBody = { pipe: pipeMock };

  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: mockBody,
  });

  // Mock Readable.fromWeb to return the body as-is
  jest.mock('stream', () => ({
    Readable: { fromWeb: (body: unknown) => body },
  }));

  return { pipeMock };
}

function mockFetchError(status: number, errorText: string) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: jest.fn().mockResolvedValue(errorText),
  });
}

describe('streamTTS controller', () => {
  beforeAll(() => {
    originalFetch = global.fetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  });

  // Use dynamic import so the module reads env at import time
  async function loadController() {
    jest.resetModules();
    jest.mock('../../lib/logger', () => ({ logger: mockLogger }));
    const mod = await import('../tts');
    return mod.streamTTS;
  }

  describe('input validation', () => {
    it('returns 500 when OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      streamTTS = await loadController();
      const { req, res, statusMock, jsonMock } = createMockReqRes();

      await streamTTS(req, res);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Server configuration error' });
      expect(mockLogger.error).toHaveBeenCalledWith('[TTS] OPENAI_API_KEY not configured');
    });

    it('returns 400 when text is missing', async () => {
      streamTTS = await loadController();
      const { req, res, statusMock, jsonMock } = createMockReqRes({ body: {}, query: {} });

      await streamTTS(req, res);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Text is required' });
    });
  });

  describe('successful requests', () => {
    it('calls OpenAI with correct parameters and streams response', async () => {
      streamTTS = await loadController();
      const { pipeMock } = mockFetchOk();
      const { req, res, setHeaderMock } = createMockReqRes();

      await streamTTS(req, res);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-openai-key',
          }),
          body: expect.stringContaining('"model":"tts-1"'),
        }),
      );
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'audio/ogg');
    });

    it('falls back to defaults when voice and model are not provided', async () => {
      streamTTS = await loadController();
      mockFetchOk();
      const { req, res } = createMockReqRes({ body: { text: 'test' } });

      await streamTTS(req, res);

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.voice).toBe('alloy');
      expect(body.model).toBe('tts-1');
      expect(body.speed).toBe(1.0);
    });

    it('validates model and falls back to tts-1 for invalid models', async () => {
      streamTTS = await loadController();
      mockFetchOk();
      const { req, res } = createMockReqRes({ body: { text: 'test', model: 'gpt-4' } });

      await streamTTS(req, res);

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('tts-1');
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('non-retryable errors', () => {
    it('returns immediately for 400 errors without retrying', async () => {
      streamTTS = await loadController();
      mockFetchError(400, 'Bad Request');
      const { req, res, statusMock, jsonMock } = createMockReqRes();

      await streamTTS(req, res);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[TTS] OpenAI API error (non-retryable)',
        expect.objectContaining({ status: 400, errorBody: 'Bad Request' }),
      );
    });

    it('returns immediately for 401 errors without retrying', async () => {
      streamTTS = await loadController();
      mockFetchError(401, 'Unauthorized');
      const { req, res, statusMock } = createMockReqRes();

      await streamTTS(req, res);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  describe('retryable errors', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    afterEach(() => {
      jest.useFakeTimers();
    });

    it('retries on 429 and succeeds on second attempt', async () => {
      streamTTS = await loadController();

      const pipeMock = jest.fn();
      const mockBody = { pipe: pipeMock };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: jest.fn().mockResolvedValue('Rate limited'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: mockBody,
        });

      const { req, res, setHeaderMock, statusMock } = createMockReqRes();

      await streamTTS(req, res);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[TTS] Retrying OpenAI API call',
        expect.objectContaining({ attempt: 1 }),
      );
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'audio/ogg');
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('retries on 500 and returns error after all retries exhausted', async () => {
      streamTTS = await loadController();

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });

      const { req, res, statusMock, jsonMock } = createMockReqRes();

      await streamTTS(req, res);

      // Initial attempt + 2 retries = 3 calls
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[TTS] OpenAI API error after retries exhausted',
        expect.objectContaining({
          status: 500,
          retries: 2,
        }),
      );
    });

    it('retries on 502 and succeeds on third attempt', async () => {
      streamTTS = await loadController();

      const pipeMock = jest.fn();
      const mockBody = { pipe: pipeMock };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: jest.fn().mockResolvedValue('Bad Gateway'),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: jest.fn().mockResolvedValue('Service Unavailable'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: mockBody,
        });

      const { req, res, setHeaderMock, statusMock } = createMockReqRes();

      await streamTTS(req, res);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'audio/ogg');
      expect(statusMock).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('logs structured error and returns 500 when fetch throws', async () => {
      streamTTS = await loadController();
      global.fetch = jest.fn().mockRejectedValue(new Error('Network failure'));
      const { req, res, statusMock, jsonMock } = createMockReqRes();

      await streamTTS(req, res);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Internal server error processing TTS' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[TTS] Error streaming audio',
        expect.objectContaining({ error: 'Network failure' }),
      );
    });

    it('includes structured context in error logs', async () => {
      streamTTS = await loadController();
      mockFetchError(400, 'Invalid voice');
      const { req, res } = createMockReqRes({ body: { text: 'Hello', voice: 'nova', model: 'tts-1-hd' } });

      await streamTTS(req, res);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[TTS] OpenAI API error (non-retryable)',
        expect.objectContaining({
          status: 400,
          model: 'tts-1-hd',
          voice: 'nova',
          textLength: 5,
        }),
      );
    });
  });
});
