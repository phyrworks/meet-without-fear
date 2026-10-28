/**
 * State Factory for E2E and golden fixtures.
 *
 * Seeds a session at a named `TargetStage` so tests can start mid-journey
 * instead of driving the UI from the beginning.
 *
 * Two layers sit behind this file:
 *
 * - `fixture-scenarios/scenarios.ts` — each `TargetStage` as a declarative,
 *   shape-independent scenario: participants, the milestones each has reached
 *   (with timestamps), and the content they produced. See
 *   `fixture-scenarios/scenario-model.ts`.
 * - `fixture-scenarios/target-shape.ts` — writes the scenario into the
 *   target tables (participant, conversation, participant_milestone, …)
 *   through `pg` (TS-9).
 *
 * The current-shape writer (`fixture-scenarios/current-shape.ts`, the
 * pre-rebuild Prisma models) was removed from phoenix/target-shape at TS-13
 * (ruling R42); phoenix/base keeps it, and its recorded concept goldens stay
 * the oracle (R39).
 *
 * This file is the stable public surface (`StateFactory`, `stateFactory`,
 * `TargetStage`, `UserConfig`, `StateFactoryOptions`, `StateFactoryResult`).
 */

import { Client } from 'pg';
import { writeTargetShape } from './fixture-scenarios/target-shape';
import type { WrittenScenario } from './fixture-scenarios/scenario-helpers';
import { scenarioFor } from './fixture-scenarios/scenarios';
import { TargetStage } from './fixture-scenarios/target-stage';

export { TargetStage };

// ============================================================================
// Types
// ============================================================================

export interface UserConfig {
  email: string;
  name: string;
}

export interface StateFactoryOptions {
  userA: UserConfig;
  userB?: UserConfig;
  targetStage: TargetStage;
}

export interface StateFactoryResult {
  session: {
    id: string;
    status: string;
    relationshipId: string;
  };
  userA: {
    id: string;
    email: string;
    name: string;
  };
  userB?: {
    id: string;
    email: string;
    name: string;
  };
  invitation: {
    id: string;
    status: string;
  };
  pageUrls: {
    userA: string;
    userB?: string;
  };
}

// ============================================================================
// State Factory
// ============================================================================

export class StateFactory {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8081') {
    this.baseUrl = baseUrl;
  }

  /**
   * Create a session at the specified stage, atomically.
   */
  async createSessionAtStage(options: StateFactoryOptions): Promise<StateFactoryResult> {
    const { userA, userB, targetStage } = options;

    if (!userA.email.endsWith('@e2e.test')) {
      throw new Error(`User A email must end with @e2e.test: ${userA.email}`);
    }
    if (userB && !userB.email.endsWith('@e2e.test')) {
      throw new Error(`User B email must end with @e2e.test: ${userB.email}`);
    }

    const scenario = scenarioFor(targetStage, { a: userA.name, b: userB?.name });
    const users = userB ? [userA, userB] : [userA];

    const write = async (written: WrittenScenario): Promise<StateFactoryResult> => {
      const [userARecord, userBRecord] = written.users;

      const result: StateFactoryResult = {
        session: written.session,
        userA: {
          id: userARecord.id,
          email: userARecord.email,
          name: userARecord.name || userA.name,
        },
        invitation: written.invitation,
        pageUrls: {
          userA: this.pageUrl(written.session.id, userARecord),
        },
      };

      if (userB && userBRecord) {
        result.userB = {
          id: userBRecord.id,
          email: userBRecord.email,
          name: userBRecord.name || userB.name,
        };
        result.pageUrls.userB = this.pageUrl(written.session.id, userBRecord);
      }

      return result;
    };

    // Through pg in one transaction, never through the app's Prisma client
    // (the fixture must not depend on the code under test).
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      await db.query('BEGIN');
      const written = await writeTargetShape(db, scenario, users);
      await db.query('COMMIT');
      return write(written);
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await db.end();
    }
  }

  private pageUrl(sessionId: string, user: { id: string; email: string }): string {
    return `${this.baseUrl}/session/${sessionId}?e2e-user-id=${user.id}&e2e-user-email=${encodeURIComponent(user.email)}`;
  }
}

/**
 * Singleton instance for convenience
 */
export const stateFactory = new StateFactory();
