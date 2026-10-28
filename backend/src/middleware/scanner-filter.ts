import { Request, Response, NextFunction } from 'express';

/**
 * Patterns that indicate automated vulnerability scanner probes.
 * Requests matching these are short-circuited with a 404 before
 * they reach the logging middleware or route handlers, keeping
 * application logs clean.
 */
const SCANNER_PATH_SUFFIXES = ['.php', '.asp', '.aspx', '.jsp', '.cgi'];

const SCANNER_PATH_PREFIXES = [
  '/wp-admin',
  '/wp-login',
  '/wp-includes',
  '/wp-content',
  '/wordpress',
  '/xmlrpc',
  '/.env',
  '/.git',
  '/phpmyadmin',
  '/administrator',
];

function isScannerProbe(path: string): boolean {
  const lower = path.toLowerCase();
  if (SCANNER_PATH_SUFFIXES.some(s => lower.endsWith(s))) return true;
  if (SCANNER_PATH_PREFIXES.some(p => lower.startsWith(p))) return true;
  return false;
}

/**
 * Middleware that silently rejects known vulnerability scanner probes.
 * Returns a plain 404 without logging or invoking downstream middleware.
 */
export function scannerFilter(req: Request, res: Response, next: NextFunction): void {
  if (isScannerProbe(req.path)) {
    res.status(404).end();
    return;
  }
  next();
}
