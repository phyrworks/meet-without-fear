/**
 * Prisma schema: the database enums the API exposes stay inside the shared
 * package's enums (an API contract: a database value the shared enum lacks
 * reaches a client that cannot name it).
 *
 * Test audit 2026-11-17: the model-list, no-legacy-model and enum-value pins
 * were removed. They checked the generated client's shape; `npm run check`
 * fails if a model or value the code uses disappears.
 *
 * TS-12: rewritten for the target. The old version asserted the pre-migration
 * models and enums (UserVessel, StageProgress, StrategyProposal, …) and had a
 * database-connection block behind RUN_DB_TESTS; the target's tables are
 * exercised on real roles by the services/__tests__/*.target.test.ts suites.
 */

import {
  AgreementStatus,
  AgreementType,
  ConsentDecision,
  ContinueChoice,
  InvitationStatus,
  MessageRole,
  NeedCategory,
  SessionStatus,
} from '../generated/prisma/client';
import * as shared from '@meet-without-fear/shared';

const values = (e: object): string[] => Object.values(e as Record<string, string>);

describe('Prisma schema (target)', () => {
  it('every value of an API-exposed database enum is a value of its shared enum', () => {
    const pairs: Array<[string, object, object]> = [
      ['SessionStatus', SessionStatus, shared.SessionStatus],
      ['MessageRole', MessageRole, shared.MessageRole],
      ['NeedCategory', NeedCategory, shared.NeedCategory],
      ['ConsentDecision', ConsentDecision, shared.ConsentDecision],
      ['AgreementType', AgreementType, shared.AgreementType],
      ['AgreementStatus', AgreementStatus, shared.AgreementStatus],
      ['InvitationStatus', InvitationStatus, shared.InvitationStatus],
      ['ContinueChoice', ContinueChoice, shared.ContinueChoice],
    ];
    for (const [name, db, dto] of pairs) {
      const missing = values(db).filter(v => !values(dto).includes(v));
      expect({ name, missing }).toEqual({ name, missing: [] });
    }
  });
});
