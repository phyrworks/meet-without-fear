/**
 * Realtime Transcription WebSocket Handler
 *
 * Proxies audio from mobile clients to AssemblyAI's Universal Streaming API.
 * Pattern ported from the Lovely project's battle-tested implementation.
 *
 * Flow:
 *   Mobile (react-native-audio-record, base64 PCM chunks)
 *     → Backend WebSocket /realtime
 *     → Buffer chunks to ≥1600 bytes (50ms at 16kHz 16-bit mono)
 *     → Forward binary PCM to AssemblyAI
 *     → Relay PartialTranscript / FinalTranscript back to mobile
 *
 * Auth:
 *   Client connects without a token in the URL. The first WebSocket message
 *   must be { type: "auth", token: "<clerk-jwt>" }. The server verifies the
 *   JWT and only then establishes the AssemblyAI proxy. This keeps the JWT
 *   out of URLs, server logs, and proxy logs.
 *
 * Key behaviors:
 *   - Buffers small audio chunks to meet AssemblyAI's 50–1000ms requirement
 *   - Tracks transcripts per turn to deduplicate
 *   - Skips unformatted final transcripts (waits for formatted version)
 *   - Flushes remaining buffer on client disconnect
 */

import WebSocket from 'ws';
import { Server, IncomingMessage } from 'http';
import { Socket } from 'net';
import { logger } from '../lib/logger';

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const ASSEMBLYAI_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token?expires_in_seconds=300';
const ASSEMBLYAI_WS_BASE = 'wss://streaming.assemblyai.com/v3/ws';

// At 16kHz, 16-bit mono PCM: 50ms = 1600 bytes
const MIN_CHUNK_SIZE = 1600;
const AUTH_TIMEOUT_MS = 5000;

// WebSocket connection rate limit: 5 upgrades per 60s per user
const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = 5;
const wsConnectionTimestamps = new Map<string, number[]>();

function isWsRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = wsConnectionTimestamps.get(userId) || [];
  const recent = timestamps.filter(t => now - t < WS_RATE_WINDOW_MS);
  if (recent.length >= WS_RATE_MAX) {
    wsConnectionTimestamps.set(userId, recent);
    return true;
  }
  recent.push(now);
  wsConnectionTimestamps.set(userId, recent);
  return false;
}

/**
 * Attach a /realtime WebSocket endpoint to an existing HTTP server.
 * Call this from server.ts after creating the HTTP server.
 */
export function attachRealtimeWebSocket(server: Server): void {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname !== '/realtime') {
      // Non-/realtime upgrades are ignored (other middleware may handle them)
      return;
    }

    // Accept upgrade without auth — JWT is verified via first WebSocket message
    // (prevents token from leaking into server/proxy URL logs)
    wss.handleUpgrade(request, socket as Socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (clientWs: WebSocket, request: IncomingMessage) => {
    logger.info('[Realtime] Client connected, awaiting auth');

    const authTimeout = setTimeout(() => {
      logger.warn('[Realtime] Auth timeout — no auth message within 5s');
      clientWs.close(1008, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);

    const onFirstMessage = async (data: WebSocket.Data) => {
      clientWs.off('message', onFirstMessage);
      clearTimeout(authTimeout);

      try {
        const message = JSON.parse(data.toString());
        if (message.type !== 'auth' || typeof message.token !== 'string') {
          logger.warn('[Realtime] First message was not a valid auth message');
          clientWs.close(1008, 'Expected auth message');
          return;
        }

        const { verifyToken } = await import('@clerk/express');
        const session = await verifyToken(message.token, {
          secretKey: CLERK_SECRET_KEY!,
        });

        if (isWsRateLimited(session.sub)) {
          logger.warn('[Realtime] WebSocket auth rejected: rate limited for user:', session.sub);
          clientWs.close(1008, 'Rate limited');
          return;
        }

        logger.info('[Realtime] Authenticated WebSocket for user:', session.sub);

        startTranscriptionProxy(clientWs, request);
      } catch (error) {
        logger.warn('[Realtime] WebSocket auth failed:', error);
        clientWs.close(1008, 'Policy Violation');
      }
    };

    clientWs.on('message', onFirstMessage);
    clientWs.on('close', () => clearTimeout(authTimeout));
  });

  async function startTranscriptionProxy(clientWs: WebSocket, request: IncomingMessage): Promise<void> {
    if (!ASSEMBLYAI_API_KEY) {
      clientWs.send(JSON.stringify({ type: 'error', data: 'Voice transcription not configured' }));
      clientWs.close(1008, 'No API key');
      return;
    }

    let assemblyAiWs: WebSocket | null = null;
    let audioBuffer: Buffer[] = [];
    let audioBufferSize = 0;

    try {
      // 1. Get a temporary AssemblyAI token
      const tokenResponse = await fetch(ASSEMBLYAI_TOKEN_URL, {
        method: 'GET',
        headers: { Authorization: ASSEMBLYAI_API_KEY },
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        logger.error('[Realtime] AssemblyAI token failed:', tokenResponse.status, errorText);
        clientWs.send(JSON.stringify({ type: 'error', data: 'Failed to obtain voice token' }));
        clientWs.close(1011, 'Token error');
        return;
      }

      const tokenData = (await tokenResponse.json()) as { token: string };

      // 2. Connect to AssemblyAI Universal Streaming
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const wsUrl = new URL(ASSEMBLYAI_WS_BASE);
      wsUrl.searchParams.append('token', tokenData.token);
      wsUrl.searchParams.append('sample_rate', '16000');
      wsUrl.searchParams.append('encoding', 'pcm_s16le');
      wsUrl.searchParams.append('format_turns', 'true');

      // Tuning params — client can override via query string
      wsUrl.searchParams.append(
        'end_of_turn_confidence_threshold',
        url.searchParams.get('endOfTurnConfidenceThreshold') || '0.6',
      );
      wsUrl.searchParams.append(
        'min_end_of_turn_silence_when_confident',
        url.searchParams.get('minEndOfTurnSilenceWhenConfident') || '1500',
      );
      wsUrl.searchParams.append('max_turn_silence', url.searchParams.get('maxTurnSilence') || '3000');
      wsUrl.searchParams.append('max_turn_duration', '15000');
      wsUrl.searchParams.append('end_of_turn_silence_threshold', '800');

      assemblyAiWs = new WebSocket(wsUrl.toString());

      // 3. Track transcripts per turn to deduplicate
      const lastTranscriptByTurn = new Map<number, string>();

      assemblyAiWs.on('open', () => {
        logger.info('[Realtime] Connected to AssemblyAI');
      });

      assemblyAiWs.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());

          switch (message.type) {
            case 'Begin':
              lastTranscriptByTurn.clear();
              clientWs.send(JSON.stringify({ message_type: 'SessionReady' }));
              break;

            case 'Turn':
              if (message.transcript) {
                const turnOrder = message.turn_order || 0;
                const lastTranscript = lastTranscriptByTurn.get(turnOrder);
                const isNewContent = lastTranscript !== message.transcript;

                // Skip unformatted final — wait for the formatted version
                if (message.end_of_turn && !message.turn_is_formatted) {
                  return;
                }

                if (isNewContent) {
                  lastTranscriptByTurn.set(turnOrder, message.transcript);

                  clientWs.send(
                    JSON.stringify({
                      message_type: message.end_of_turn ? 'FinalTranscript' : 'PartialTranscript',
                      text: message.transcript,
                      confidence: message.confidence,
                      turnOrder,
                    }),
                  );

                  // Prevent memory growth — keep only last 5 turns
                  if (message.end_of_turn && lastTranscriptByTurn.size > 5) {
                    const oldestTurn = Math.min(...lastTranscriptByTurn.keys());
                    lastTranscriptByTurn.delete(oldestTurn);
                  }
                }
              }
              break;

            case 'Termination':
              logger.info('[Realtime] Session terminated after', message.audio_duration_seconds, 'seconds');
              lastTranscriptByTurn.clear();
              break;
          }
        } catch (error) {
          logger.error('[Realtime] Error parsing AssemblyAI message:', error);
        }
      });

      assemblyAiWs.on('error', (error: Error) => {
        logger.error('[Realtime] AssemblyAI WebSocket error:', error.message);
        clientWs.send(JSON.stringify({ type: 'error', data: 'AssemblyAI connection error' }));
      });

      assemblyAiWs.on('close', () => {
        logger.info('[Realtime] AssemblyAI connection closed');
      });

      // 4. Handle incoming audio from mobile client
      clientWs.on('message', (data: WebSocket.Data) => {
        if (!assemblyAiWs || assemblyAiWs.readyState !== WebSocket.OPEN) return;

        try {
          // JSON format: { audio_data: "<base64>" }
          const message = JSON.parse(data.toString());
          if (message.audio_data && typeof message.audio_data === 'string') {
            bufferAndForward(Buffer.from(message.audio_data, 'base64'));
          }
        } catch {
          // Not JSON — try raw base64 string
          const dataStr = data.toString();
          if (/^[A-Za-z0-9+/]*={0,2}$/.test(dataStr) && dataStr.length > 0) {
            bufferAndForward(Buffer.from(dataStr, 'base64'));
          }
        }
      });

      // eslint-disable-next-line no-inner-declarations -- hoisted: the message handler above calls it
      function bufferAndForward(chunk: Buffer): void {
        audioBuffer.push(chunk);
        audioBufferSize += chunk.length;

        if (audioBufferSize >= MIN_CHUNK_SIZE) {
          const combined = Buffer.concat(audioBuffer);
          assemblyAiWs!.send(combined);
          audioBuffer = [];
          audioBufferSize = 0;
        }
      }

      // 5. Cleanup on client disconnect
      clientWs.on('close', () => {
        logger.info('[Realtime] Client disconnected');

        // Flush remaining buffered audio
        if (assemblyAiWs && assemblyAiWs.readyState === WebSocket.OPEN && audioBuffer.length > 0) {
          assemblyAiWs.send(Buffer.concat(audioBuffer));
        }
        audioBuffer = [];
        audioBufferSize = 0;

        if (assemblyAiWs) {
          assemblyAiWs.close();
          assemblyAiWs = null;
        }
      });
    } catch (error) {
      logger.error('[Realtime] Failed to initialize:', error);
      clientWs.send(
        JSON.stringify({
          type: 'error',
          data: 'Failed to initialize transcription: ' + (error instanceof Error ? error.message : 'Unknown error'),
        }),
      );
    }
  }
}
