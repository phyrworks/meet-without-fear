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
 * - `fixture-scenarios/current-shape.ts` — writes a scenario into today's
 *   tables (StageProgress rows, `gatesSatisfied` JSON, stage integers,
 *   `Session.status`, …), reproducing the pre-rebuild factory's rows exactly so
 *   recorded goldens stay valid. The target-shape writer replaces it.
 *
 * This file is the stable public surface (`StateFactory`, `stateFactory`,
 * `TargetStage`, `UserConfig`, `StateFactoryOptions`, `StateFactoryResult`).
 */

import { prisma } from '../lib/prisma';
import { writeCurrentShape } from './fixture-scenarios/current-shape';
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

    return prisma.$transaction(async tx => {
      const written = await writeCurrentShape(tx, scenario, users);
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
    });
  }

  private pageUrl(sessionId: string, user: { id: string; email: string }): string {
    return `${this.baseUrl}/session/${sessionId}?e2e-user-id=${user.id}&e2e-user-email=${encodeURIComponent(user.email)}`;
  }
}

/**
 * Singleton instance for convenience
 */
export const stateFactory = new StateFactory();
