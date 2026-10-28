/**
 * E2E Fixture Loader
 *
 * Loads TypeScript fixtures for E2E testing with deterministic AI responses.
 */

import { E2EFixture, fixtureRegistry } from '../fixtures';

// Re-export types for backward compatibility
export type {
  E2EFixture,
  E2EFixtureSeed,
  E2EFixtureUser,
  E2EOperationResponse,
  E2EResponseEntry,
  E2EStorylineEntry,
} from '../fixtures';

// ============================================================================
// Fixture Loader
// ============================================================================

/**
 * Load a fixture by ID from the registry.
 * @param fixtureId - The fixture ID (e.g., 'user-a-full-journey')
 * @returns The fixture
 * @throws Error if fixture not found
 */
export function loadFixture(fixtureId: string): E2EFixture {
  const fixture = fixtureRegistry[fixtureId];

  if (!fixture) {
    const available = Object.keys(fixtureRegistry).join(', ');
    throw new Error(`Fixture not found: ${fixtureId}. Available fixtures: ${available}`);
  }

  return fixture;
}

/**
 * Get AI response from fixture for a specific user and response index.
 * @deprecated Use getFixtureResponseByIndex instead
 */
export function getFixtureResponse(fixture: E2EFixture, userId: string, responseIndex: number): string {
  if (!fixture.storyline) {
    throw new Error(`No storyline found in fixture`);
  }

  const userStoryline = fixture.storyline[userId];

  if (!userStoryline) {
    throw new Error(`No storyline found for user: ${userId}`);
  }

  if (responseIndex >= userStoryline.length) {
    throw new Error(
      `Response index ${responseIndex} out of bounds for user ${userId} (has ${userStoryline.length} responses)`,
    );
  }

  return userStoryline[responseIndex].ai;
}

/**
 * Clear the fixture cache (no-op, kept for backward compatibility).
 * TypeScript fixtures are imported modules and don't need cache clearing.
 */
export function clearFixtureCache(): void {
  // No-op: TypeScript fixtures are imported modules
}

/**
 * Get AI response from fixture by ID and index (flat-array format).
 * This is the simplified API for E2E tests.
 *
 * @param fixtureId - The fixture ID (e.g., 'user-a-full-journey')
 * @param index - The response index (0-based)
 * @returns The AI response string
 * @throws Error if fixture not found or index out of bounds
 */
export function getFixtureResponseByIndex(fixtureId: string, index: number): string {
  const fixture = loadFixture(fixtureId);

  // Support flat-array format (responses array)
  if (fixture.responses && fixture.responses.length > 0) {
    if (index < 0 || index >= fixture.responses.length) {
      throw new Error(
        `Response index ${index} out of bounds for fixture ${fixtureId} (has ${fixture.responses.length} responses)`,
      );
    }
    return fixture.responses[index].ai;
  }

  // Fallback to legacy storyline format (use first user's storyline)
  if (fixture.storyline && Object.keys(fixture.storyline).length > 0) {
    const userKeys = Object.keys(fixture.storyline);
    const storyline = fixture.storyline[userKeys[0]];
    if (index < 0 || index >= storyline.length) {
      throw new Error(
        `Response index ${index} out of bounds for fixture ${fixtureId} (has ${storyline.length} responses)`,
      );
    }
    return storyline[index].ai;
  }

  throw new Error(`No responses or storyline found in fixture: ${fixtureId}`);
}

/**
 * Get operation-specific mock response for non-streaming AI calls.
 * Used for reconciler, share suggestions, and other JSON-response operations.
 *
 * @param fixtureId - The fixture ID (e.g., 'user-b-partner-journey')
 * @param operationName - The operation name (e.g., 'reconciler-analysis', 'reconciler-share-suggestion')
 * @returns The JSON response as a string, or null if not found
 */
export function getFixtureOperationResponse(fixtureId: string, operationName: string): string | null {
  try {
    const fixture = loadFixture(fixtureId);

    if (!fixture.operations) {
      return null;
    }

    const operation = fixture.operations[operationName];
    if (!operation) {
      return null;
    }

    // Return the response as a JSON string
    return JSON.stringify(operation.response);
  } catch {
    // Fixture not found or other error
    return null;
  }
}
