/**
 * Structured Logger
 *
 * Winston-based logger with JSON output in production and pretty-print in development.
 * Automatically includes correlation IDs from request context (turnId, sessionId, userId).
 *
 * Usage:
 *   import { logger } from '../lib/logger';
 *   logger.info('Stage transition', { sessionId, from: 'HELD', to: 'ANALYZING' });
 *   logger.error('AI call failed', { error: err.message, model });
 */

import winston from 'winston';
import Transport from 'winston-transport';
import * as Sentry from '@sentry/node';
import { getRequestContext } from './request-context';

const isDev = process.env.NODE_ENV !== 'production';
const isTest = process.env.NODE_ENV === 'test';

/**
 * Custom format that injects request context (turnId, sessionId, userId, requestId)
 * into every log entry when available.
 */
const contextFormat = winston.format(info => {
  const ctx = getRequestContext();
  if (ctx) {
    if (ctx.turnId) info.turnId = ctx.turnId;
    if (ctx.sessionId) info.sessionId = ctx.sessionId;
    if (ctx.userId) info.userId = ctx.userId;
    if (ctx.requestId) info.requestId = ctx.requestId;
  }
  return info;
});

/**
 * Custom Winston transport that forwards error-level logs to Sentry.
 * Only added when SENTRY_DSN is configured.
 */
class SentryTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
    this.level = 'error';
  }

  log(info: { message: string; stack?: string; [key: string]: unknown }, callback: () => void): void {
    const { message, stack, level: _level, ...extra } = info;

    if (stack) {
      // If there's a stack trace, capture as an exception
      const err = new Error(message);
      err.stack = stack;
      Sentry.captureException(err, { extra });
    } else {
      Sentry.captureMessage(message, { level: 'error', extra });
    }

    callback();
  }
}

const transports: winston.transport[] = [new winston.transports.Console()];

// Add Sentry transport when DSN is configured
if (process.env.SENTRY_DSN) {
  transports.push(new SentryTransport());
}

export const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  silent: isTest,
  format: winston.format.combine(
    contextFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${timestamp} ${level}: ${message}${metaStr}`;
          }),
        )
      : winston.format.json(),
  ),
  transports,
});
