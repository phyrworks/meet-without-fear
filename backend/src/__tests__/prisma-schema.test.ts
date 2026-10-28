/**
 * Prisma schema: the generated client is the TARGET schema
 * (docs/backend/data-model/schema-target-2026-10.md), and the database enums
 * the API exposes stay inside the shared package's enums.
 *
 * TS-12: rewritten for the target. The old version asserted the pre-migration
 * models and enums (UserVessel, StageProgress, StrategyProposal, …) and had a
 * database-connection block behind RUN_DB_TESTS; the target's tables are
 * exercised on real roles by the services/__tests__/*.target.test.ts suites.
 */

import {
  Prisma,
  AgreementStatus,
  AgreementType,
  ConsentDecision,
  ContinueChoice,
  EmpathyStatus,
  InvitationStatus,
  MessageKind,
  MessageRole,
  NeedCategory,
  ReflectionStatus,
  SessionStatus,
} from '../generated/prisma/client';
import * as shared from '@meet-without-fear/shared';

const values = (e: object): string[] => Object.values(e as Record<string, string>);

describe('Prisma schema (target)', () => {
  const models = Object.values(Prisma.ModelName) as string[];

  it('exports the target models of every cluster', () => {
    expect(models).toEqual(
      expect.arrayContaining([
        // identity & sessions
        'User',
        'Relationship',
        'RelationshipMember',
        'Session',
        'Participant',
        'Invitation',
        // chat
        'Conversation',
        'Message',
        'Draft',
        'ParticipantMilestone',
        'AiMemory',
        // empathy / reconciler / consent
        'EmpathyAttempt',
        'EmpathyReview',
        'ReconcilerResult',
        'ContextShareOffer',
        'Consent',
        // needs / repair / follow-up
        'Need',
        'NeedShare',
        'Proposal',
        'ProposalChoice',
        'Agreement',
        'FollowUp',
        // reflection, wellbeing, memory & preferences, telemetry (TS-12)
        'Reflection',
        'ReflectionMessage',
        'Takeaway',
        'TakeawayLink',
        'FeatureState',
        'UserPreferences',
        'UserDevice',
        'UserMemory',
        'BrainActivity',
      ]),
    );
  });

  it('exports none of the pre-migration models', () => {
    for (const legacy of [
      'UserVessel',
      'StageProgress',
      'IdentifiedNeed',
      'StrategyProposal',
      'InnerWorkSession',
      'InnerWorkMessage',
      'SessionTakeaway',
      'MeditationSession',
      'GratitudeEntry',
      'ConsentRecord',
    ]) {
      expect(models).not.toContain(legacy);
    }
  });

  it('pins the target enum values the API and the stage shim depend on', () => {
    expect(values(SessionStatus)).toEqual(['CREATED', 'INVITED', 'ACTIVE', 'RESOLVED', 'ABANDONED', 'ARCHIVED']);
    expect(values(MessageRole)).toEqual(['USER', 'AI', 'SYSTEM']);
    expect(values(MessageKind)).toEqual(
      expect.arrayContaining([
        'CHAT',
        'EMPATHY_STATEMENT',
        'SHARED_CONTEXT',
        'VALIDATION_FEEDBACK',
        'SHARE_SUGGESTION',
      ]),
    );
    expect(values(EmpathyStatus)).toEqual([
      'HELD',
      'AWAITING_SHARING',
      'REFINING',
      'READY',
      'REVEALED',
      'VALIDATED',
      'SUPERSEDED',
    ]);
    expect(values(ReflectionStatus)).toEqual(['ACTIVE', 'COMPLETED', 'ARCHIVED']);
  });

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
