/**
 * Tests for the voice token controller.
 *
 * Tests use mock req/res objects and mock global fetch.
 */

import { Request, Response, NextFunction } from 'express';

// Mock the logger to avoid noise in test output
jest.mock('../../lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('getVoiceToken controller', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    jsonMock = jest.fn().mockReturnThis();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      user: { id: 'user-123', email: 'test@example.com' } as Request['user'],
    };
    mockRes = {
      json: jsonMock,
      status: statusMock,
    };
    mockNext = jest.fn();
  });

  afterEach(() => {
    delete process.env.ASSEMBLYAI_API_KEY;
  });

  describe('when ASSEMBLYAI_API_KEY is not set', () => {
    it('returns 500 with "Voice transcription not configured" error', async () => {
      delete process.env.ASSEMBLYAI_API_KEY;

      // Import after resetting modules so env is read inside the handler
      const { getVoiceToken } = await import('../voice');

      await getVoiceToken(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: 'Voice transcription not configured',
      });
    });
  });

  describe('when ASSEMBLYAI_API_KEY is set', () => {
    beforeEach(() => {
      process.env.ASSEMBLYAI_API_KEY = 'test-api-key';
    });

    it('returns 200 with token and expiresInSeconds on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ token: 'abc123' }),
      } as unknown as Response);

      const { getVoiceToken } = await import('../voice');

      await getVoiceToken(mockReq as Request, mockRes as Response, mockNext);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://streaming.assemblyai.com/v3/token?expires_in_seconds=300',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'test-api-key',
          }),
        }),
      );
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          token: 'abc123',
          expiresInSeconds: 300,
        },
      });
    });

    it('returns 502 when AssemblyAI returns a non-200 response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: jest.fn().mockResolvedValue('Forbidden'),
      } as unknown as Response);

      const { getVoiceToken } = await import('../voice');

      await getVoiceToken(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(502);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to obtain voice token',
      });
    });

    it('calls next with error when fetch throws', async () => {
      const fetchError = new Error('Network failure');
      global.fetch = jest.fn().mockRejectedValue(fetchError);

      const { getVoiceToken } = await import('../voice');

      await getVoiceToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(fetchError);
    });
  });
});
