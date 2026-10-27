import express from 'express';
import request from 'supertest';
import brainRoutes from '../brain';
import { verifyToken } from '@clerk/express';

jest.mock('@clerk/express', () => ({
  verifyToken: jest.fn(),
}));

const verifyTokenMock = verifyToken as jest.MockedFunction<typeof verifyToken>;

function createApp() {
  const app = express();
  app.use('/brain', brainRoutes);
  return app;
}

describe('brain dashboard auth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      CLERK_SECRET_KEY: 'sk_test_mock',
      DASHBOARD_API_SECRET: '',
      DASHBOARD_ALLOWED_EMAILS: '',
      DASHBOARD_ALLOWED_USER_IDS: '',
      ABLY_API_KEY: '',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('allows Clerk tokens whose sub is in DASHBOARD_ALLOWED_USER_IDS', async () => {
    process.env.DASHBOARD_ALLOWED_USER_IDS = 'user_allowed,user_other';
    verifyTokenMock.mockResolvedValue({ sub: 'user_allowed' } as any);

    const res = await request(createApp())
      .get('/brain/ably-token')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'NOT_CONFIGURED', message: 'Ably not configured' });
  });

  it('allows Clerk tokens whose email is in DASHBOARD_ALLOWED_EMAILS', async () => {
    process.env.DASHBOARD_ALLOWED_EMAILS = 'admin@example.com';
    verifyTokenMock.mockResolvedValue({ sub: 'user_any', email: 'Admin@Example.com' } as any);

    const res = await request(createApp())
      .get('/brain/ably-token')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'NOT_CONFIGURED', message: 'Ably not configured' });
  });

  it('rejects Clerk tokens that match neither allowlist', async () => {
    process.env.DASHBOARD_ALLOWED_USER_IDS = 'user_allowed';
    process.env.DASHBOARD_ALLOWED_EMAILS = 'admin@example.com';
    verifyTokenMock.mockResolvedValue({ sub: 'user_blocked', email: 'blocked@example.com' } as any);

    const res = await request(createApp())
      .get('/brain/ably-token')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Not authorized for dashboard access' });
  });

  it('rejects Clerk tokens whose sub is not in DASHBOARD_ALLOWED_USER_IDS when only user ids are configured', async () => {
    process.env.DASHBOARD_ALLOWED_USER_IDS = 'user_allowed';
    verifyTokenMock.mockResolvedValue({ sub: 'user_blocked' } as any);

    const res = await request(createApp())
      .get('/brain/ably-token')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Not authorized for dashboard access' });
  });

  it('rejects requests without a token when Clerk auth is configured', async () => {
    process.env.DASHBOARD_ALLOWED_USER_IDS = 'user_allowed';

    const res = await request(createApp()).get('/brain/ably-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Dashboard authentication required' });
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });
});
