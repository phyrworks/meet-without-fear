import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { Request, Response } from 'express';
import { logger } from '../lib/logger';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TTS_MAX_RETRIES = 2;
const TTS_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

async function callOpenAITTS(params: {
  model: string;
  input: string;
  voice: string;
  speed: number;
}): Promise<globalThis.Response> {
  return fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...params,
      response_format: 'opus',
    }),
  });
}

export const streamTTS = async (req: Request, res: Response): Promise<void | Response> => {
  try {
    if (!OPENAI_API_KEY) {
      logger.error('[TTS] OPENAI_API_KEY not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Support both POST body and GET query params (for native downloadAsync compatibility)
    const text = req.body.text || req.query.text;
    const voice = req.body.voice || req.query.voice;
    const model = req.body.model || req.query.model;
    const speed = req.body.speed || req.query.speed;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Default to 'alloy' and 'tts-1' if not provided
    const voiceId = voice || 'alloy';
    let modelId = model || 'tts-1';
    const speechSpeed = typeof speed === 'string' ? parseFloat(speed) : speed || 1.0;

    // Validate model - only allow OpenAI TTS models
    if (modelId !== 'tts-1' && modelId !== 'tts-1-hd') {
      logger.warn(`[TTS] Invalid model '${modelId}' requested. Falling back to 'tts-1'.`);
      modelId = 'tts-1';
    }

    const ttsParams = { model: modelId, input: text, voice: voiceId, speed: speechSpeed };
    const logContext = { model: modelId, voice: voiceId, textLength: text.length };

    let response: globalThis.Response | undefined;
    let lastStatus = 0;
    let lastErrorText = '';

    for (let attempt = 0; attempt <= TTS_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = TTS_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn('[TTS] Retrying OpenAI API call', { attempt, delay, lastStatus, ...logContext });
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      response = await callOpenAITTS(ttsParams);

      if (response.ok) break;

      lastStatus = response.status;
      lastErrorText = await response.text();

      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        // Non-retryable error — log and return immediately
        logger.error('[TTS] OpenAI API error (non-retryable)', {
          status: response.status,
          errorBody: lastErrorText,
          ...logContext,
        });
        return res.status(response.status).json({ error: `OpenAI API error: ${lastErrorText}` });
      }
    }

    if (!response || !response.ok) {
      // All retries exhausted
      logger.error('[TTS] OpenAI API error after retries exhausted', {
        status: lastStatus,
        errorBody: lastErrorText,
        retries: TTS_MAX_RETRIES,
        ...logContext,
      });
      return res.status(lastStatus || 500).json({ error: `OpenAI API error: ${lastErrorText}` });
    }

    // Stream the audio back to the client
    res.setHeader('Content-Type', 'audio/ogg');

    if (response.body) {
      // Convert Web Stream to Node Stream for Express compatibility
      const nodeStream = Readable.fromWeb(response.body as unknown as WebReadableStream);
      nodeStream.pipe(res);
    } else {
      throw new Error('No response body from OpenAI');
    }
  } catch (error) {
    logger.error('[TTS] Error streaming audio', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error processing TTS' });
    }
  }
};
