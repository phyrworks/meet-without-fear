import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import routes from './routes';
import { requestContextMiddleware } from './middleware/request-context';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { scannerFilter } from './middleware/scanner-filter';
import { globalRateLimit } from './middleware/rate-limit';
import { logger } from './lib/logger';

const app = express();

// Security middleware
app.use(helmet());

// CORS - allow website, app (Expo Web), and dashboard origins
const corsOrigins: (string | RegExp)[] = [
  // Website (marketing + invitation acceptance flow)
  'https://meetwithoutfear.com',
  'https://www.meetwithoutfear.com',
  // App (Expo Web build)
  'https://app.meetwithoutfear.com',
  // Vercel preview deployments of mwf-app (mwf-<hash>-shantam.vercel.app etc)
  /^https:\/\/mwf-[a-z0-9-]+\.vercel\.app$/,
  // Local development
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:5173',
  'http://localhost:8081',
  'http://localhost:8082', // e2e Playwright suite uses this port to avoid clashing with local dev on 8081
];
if (process.env.DASHBOARD_URL) {
  corsOrigins.push(process.env.DASHBOARD_URL);
}
const corsOptions: cors.CorsOptions = {
  origin: corsOrigins,
};
if (process.env.E2E_AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production') {
  corsOptions.allowedHeaders = '*';
} else {
  corsOptions.allowedHeaders = [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'X-Requested-With',
    'x-dashboard-secret',
  ];
}
app.use(cors(corsOptions));

// Compression middleware - skip SSE endpoints to prevent buffering
app.use(
  compression({
    filter: (req, res) => {
      // Skip compression for SSE streaming endpoints
      if (req.path.includes('/messages/stream')) {
        return false;
      }
      // Use default compression filter for other requests
      return compression.filter(req, res);
    },
  }),
);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request context - establishes AsyncLocalStorage context for turnId propagation
// Must be before routes but after body parsing
app.use(requestContextMiddleware);

// Scanner filter - reject known vulnerability scanner probes before they hit the logger
app.use(scannerFilter);

// Request logging
app.use((req, res, next) => {
  const hasAuth = !!req.headers.authorization;
  logger.info(`[${new Date().toISOString()}] ${req.method} ${req.path} (auth: ${hasAuth})`);

  // Log response status
  res.on('finish', () => {
    logger.info(`[${new Date().toISOString()}] ${req.method} ${req.path} -> ${res.statusCode}`);
  });
  next();
});

// Health check - must be before API routes (no auth required)
app.get('/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global rate limit — 100 req/min per user safety net (before route-specific limits)
app.use('/api', globalRateLimit);

// API routes - support both /api and /api/v1 for compatibility
app.use('/api/v1', routes);
app.use('/api', routes);

// 404 handler
app.use(notFoundHandler);

// Error handler - handles AppError, ZodError, and unknown errors consistently
app.use(errorHandler);

export default app;
