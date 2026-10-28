/**
 * E2E Fixture Loader Tests
 *
 * Tests for loading TypeScript fixtures for E2E testing.
 */

import { loadFixture, getFixtureResponse, getFixtureResponseByIndex, clearFixtureCache } from '../e2e-fixtures';
import { FIXTURE_USER_IDS } from '../../fixtures/ids';

const USER_A = FIXTURE_USER_IDS.userA;

describe('E2E Fixture Loader', () => {
  describe('loadFixture', () => {
    it('loads a valid fixture from registry', () => {
      const fixture = loadFixture('test-fixture');

      expect(fixture).toBeDefined();
      expect(fixture.name).toBe('Test Fixture');
      expect(fixture.description).toBe('A test fixture for unit tests');
    });

    it('parses seed.users from fixture', () => {
      const fixture = loadFixture('test-fixture');

      expect(fixture.seed?.users).toHaveLength(1);
      expect(fixture.seed!.users![0]).toEqual({
        id: USER_A,
        email: 'user-a@e2e.test',
        clerkId: 'e2e_clerk_user_a',
        name: 'Alice Test',
      });
    });

    it('parses storyline from fixture', () => {
      const fixture = loadFixture('test-fixture');

      expect(fixture.storyline).toBeDefined();
      expect(fixture.storyline![USER_A]).toHaveLength(2);
      expect(fixture.storyline![USER_A][0].user).toBe('Hello');
      expect(fixture.storyline![USER_A][0].ai).toContain('thinking');
    });

    it('throws error when fixture not found', () => {
      expect(() => loadFixture('non-existent')).toThrow('Fixture not found: non-existent');
    });

    it('lists available fixtures in error message', () => {
      expect(() => loadFixture('non-existent')).toThrow('Available fixtures:');
    });
  });

  describe('getFixtureResponse', () => {
    it('returns AI response for given user and index', () => {
      const fixture = loadFixture('test-fixture');

      const response = getFixtureResponse(fixture, USER_A, 0);

      expect(response).toContain('thinking');
      expect(response).toContain('Hi there! How can I help you today?');
    });

    it('returns next response when index increments', () => {
      const fixture = loadFixture('test-fixture');

      const response = getFixtureResponse(fixture, USER_A, 1);

      expect(response).toContain("I'm doing well");
    });

    it('throws error when user not in storyline', () => {
      const fixture = loadFixture('test-fixture');

      expect(() => getFixtureResponse(fixture, 'unknown-user', 0)).toThrow('No storyline found for user: unknown-user');
    });

    it('throws error when index out of bounds', () => {
      const fixture = loadFixture('test-fixture');

      expect(() => getFixtureResponse(fixture, USER_A, 99)).toThrow(
        `Response index 99 out of bounds for user ${USER_A} (has 2 responses)`,
      );
    });
  });

  describe('getFixtureResponseByIndex', () => {
    it('returns AI response for given index using legacy storyline format', () => {
      const response = getFixtureResponseByIndex('test-fixture', 0);

      expect(response).toContain('thinking');
      expect(response).toContain('Hi there! How can I help you today?');
    });

    it('returns next response when index increments', () => {
      const response = getFixtureResponseByIndex('test-fixture', 1);

      expect(response).toContain("I'm doing well");
    });

    it('throws error when fixture not found', () => {
      expect(() => getFixtureResponseByIndex('non-existent', 0)).toThrow('Fixture not found: non-existent');
    });

    it('throws error when index out of bounds', () => {
      expect(() => getFixtureResponseByIndex('test-fixture', 99)).toThrow(
        'Response index 99 out of bounds for fixture test-fixture (has 2 responses)',
      );
    });

    it('throws error when index is negative', () => {
      expect(() => getFixtureResponseByIndex('test-fixture', -1)).toThrow(
        'Response index -1 out of bounds for fixture test-fixture (has 2 responses)',
      );
    });

    it('loads fixture with flat-array responses format', () => {
      const response = getFixtureResponseByIndex('flat-array-fixture', 0);

      expect(response).toContain('Welcome to the session');
    });

    it('returns correct response from flat-array at different indices', () => {
      const response0 = getFixtureResponseByIndex('flat-array-fixture', 0);
      const response1 = getFixtureResponseByIndex('flat-array-fixture', 1);

      expect(response0).toContain('Welcome to the session');
      expect(response1).toContain('<draft>');
    });
  });

  describe('clearFixtureCache', () => {
    it('is a no-op for backward compatibility', () => {
      // Should not throw
      expect(() => clearFixtureCache()).not.toThrow();
    });
  });
});
