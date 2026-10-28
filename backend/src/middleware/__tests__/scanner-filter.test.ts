import { Request, Response, NextFunction } from 'express';
import { scannerFilter } from '../scanner-filter';

function createMockReq(path: string): Partial<Request> {
  return { path };
}

function createMockRes(): Partial<Response> & { statusCode?: number; ended: boolean } {
  const res: Partial<Response> & { statusCode?: number; ended: boolean } = {
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res as Response;
    },
    end() {
      res.ended = true;
      return res as Response;
    },
  };
  return res;
}

describe('scannerFilter', () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('blocks scanner probes', () => {
    const scannerPaths = [
      '/wp-load.php',
      '/wp-login.php',
      '/admin/config.php',
      '/xmlrpc.php',
      '/.env',
      '/.git/config',
      '/wp-admin/setup-config.php',
      '/wp-includes/js/jquery.php',
      '/phpmyadmin/index.php',
      '/administrator/index.php',
      '/test.asp',
      '/shell.aspx',
      '/cmd.jsp',
      '/exploit.cgi',
    ];

    test.each(scannerPaths)('rejects %s with 404', path => {
      const req = createMockReq(path);
      const res = createMockRes();

      scannerFilter(req as Request, res as Response, next);

      expect(res.statusCode).toBe(404);
      expect(res.ended).toBe(true);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('passes legitimate requests through', () => {
    const legitimatePaths = [
      '/api/v1/sessions',
      '/api/v1/users/me',
      '/health',
      '/api/v1/messages/stream',
      '/api/invitations/accept',
    ];

    test.each(legitimatePaths)('allows %s', path => {
      const req = createMockReq(path);
      const res = createMockRes();

      scannerFilter(req as Request, res as Response, next);

      expect(res.statusCode).toBeUndefined();
      expect(res.ended).toBe(false);
      expect(next).toHaveBeenCalled();
    });
  });

  it('is case-insensitive', () => {
    const req = createMockReq('/WP-ADMIN/setup.PHP');
    const res = createMockRes();

    scannerFilter(req as Request, res as Response, next);

    expect(res.statusCode).toBe(404);
    expect(res.ended).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
});
