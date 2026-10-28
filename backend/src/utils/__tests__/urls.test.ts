import { createInvitationUrl, getWebsiteUrl } from '../urls';

describe('urls', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WEBSITE_URL;
    delete process.env.APP_URL;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getWebsiteUrl', () => {
    it('uses WEBSITE_URL when set', () => {
      process.env.WEBSITE_URL = 'https://example.com';
      expect(getWebsiteUrl()).toBe('https://example.com');
    });

    it('uses APP_URL when WEBSITE_URL is not set', () => {
      process.env.APP_URL = 'https://legacy.example.com';
      expect(getWebsiteUrl()).toBe('https://legacy.example.com');
    });

    it('prefers WEBSITE_URL over APP_URL', () => {
      process.env.WEBSITE_URL = 'https://new.example.com';
      process.env.APP_URL = 'https://legacy.example.com';
      expect(getWebsiteUrl()).toBe('https://new.example.com');
    });

    it('returns localhost only when NODE_ENV is explicitly development', () => {
      process.env.NODE_ENV = 'development';
      expect(getWebsiteUrl()).toBe('http://localhost:3001');
    });

    it('returns the production URL when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      expect(getWebsiteUrl()).toBe('https://meetwithoutfear.com');
    });

    it('returns the production URL when NODE_ENV is unset (safe default)', () => {
      expect(getWebsiteUrl()).toBe('https://meetwithoutfear.com');
    });

    it('returns the production URL for unknown NODE_ENV values', () => {
      process.env.NODE_ENV = 'staging';
      expect(getWebsiteUrl()).toBe('https://meetwithoutfear.com');
    });
  });

  describe('createInvitationUrl', () => {
    it('appends the invitation id to the website URL', () => {
      process.env.WEBSITE_URL = 'https://example.com';
      expect(createInvitationUrl('abc-123')).toBe('https://example.com/invitation/abc-123');
    });

    it('uses the production URL when env vars are unset', () => {
      expect(createInvitationUrl('abc-123')).toBe('https://meetwithoutfear.com/invitation/abc-123');
    });
  });
});
