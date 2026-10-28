/**
 * Tests for session status generation utilities
 *
 * Validates that status messages use encouraging, non-pressuring language
 * and reference STAGE_FRIENDLY_NAMES consistently.
 */

import { generateSessionStatusSummary, mapSessionToSummary } from '../session';
import { SessionStatus, Stage, StageStatus, StageProgressDTO } from '@meet-without-fear/shared';

// Helper to create progress objects
function makeProgress(stage: Stage, status: StageStatus): StageProgressDTO {
  return {
    stage,
    status,
    startedAt: '2024-01-01T00:00:00Z',
    completedAt: status === StageStatus.COMPLETED ? '2024-01-01T01:00:00Z' : null,
  };
}

describe('generateSessionStatusSummary', () => {
  describe('non-active statuses', () => {
    it('returns draft status for CREATED sessions', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.CREATED,
        makeProgress(Stage.ONBOARDING, StageStatus.NOT_STARTED),
        makeProgress(Stage.ONBOARDING, StageStatus.NOT_STARTED),
        'Alex',
      );
      expect(result.userStatus).toBe('Draft invitation');
      expect(result.partnerStatus).toBe('Not sent yet');
    });

    it('returns invitation sent for INVITED sessions without partner progress', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.INVITED,
        makeProgress(Stage.ONBOARDING, StageStatus.NOT_STARTED),
        makeProgress(Stage.ONBOARDING, StageStatus.NOT_STARTED),
        'Alex',
      );
      expect(result.userStatus).toBe('Invitation ready');
      expect(result.partnerStatus).toBe("Alex hasn't joined yet");
    });

    it('returns user progress when creator has advanced in INVITED session', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.INVITED,
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        makeProgress(Stage.ONBOARDING, StageStatus.NOT_STARTED),
        'Alex',
      );
      expect(result.userStatus).toBe('Sharing your story');
      expect(result.partnerStatus).toBe("Alex hasn't joined yet");
    });

    it('returns paused status for PAUSED sessions', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.PAUSED,
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        'Alex',
      );
      expect(result.userStatus).toBe('Session paused');
    });

    it('returns complete status for RESOLVED sessions', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.RESOLVED,
        makeProgress(Stage.STRATEGIC_REPAIR, StageStatus.COMPLETED),
        makeProgress(Stage.STRATEGIC_REPAIR, StageStatus.COMPLETED),
        'Alex',
      );
      expect(result.userStatus).toBe('Session complete');
      expect(result.partnerStatus).toBe('You both reached resolution');
    });

    it('returns ended status for ABANDONED sessions', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ABANDONED,
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        'Alex',
      );
      expect(result.userStatus).toBe('Session ended');
    });
  });

  describe('active session - user status', () => {
    it('shows ready message with friendly name for NOT_STARTED', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.NOT_STARTED),
        makeProgress(Stage.WITNESS, StageStatus.NOT_STARTED),
        'Alex',
      );
      expect(result.userStatus).toBe('Ready for Your Story');
    });

    it('shows in-progress message for each stage', () => {
      const stages: Array<{ stage: Stage; expected: string }> = [
        { stage: Stage.ONBOARDING, expected: 'Reviewing the agreement' },
        { stage: Stage.WITNESS, expected: 'Sharing your story' },
        { stage: Stage.PERSPECTIVE_STRETCH, expected: 'Working on understanding their perspective' },
        { stage: Stage.NEED_MAPPING, expected: 'Exploring what matters to you' },
        { stage: Stage.STRATEGIC_REPAIR, expected: 'Considering next steps' },
      ];

      for (const { stage, expected } of stages) {
        const result = generateSessionStatusSummary(
          SessionStatus.ACTIVE,
          makeProgress(stage, StageStatus.IN_PROGRESS),
          makeProgress(stage, StageStatus.IN_PROGRESS),
          'Alex',
        );
        expect(result.userStatus).toBe(expected);
      }
    });

    it('shows empathy sent message when user has sent empathy', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.PERSPECTIVE_STRETCH, StageStatus.IN_PROGRESS),
        makeProgress(Stage.PERSPECTIVE_STRETCH, StageStatus.IN_PROGRESS),
        'Alex',
        { userHasSentEmpathy: true },
      );
      expect(result.userStatus).toBe("You've shared your understanding");
    });

    it('shows completed message for GATE_PENDING', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.GATE_PENDING),
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        'Alex',
      );
      expect(result.userStatus).toBe("You've shared your story");
    });
  });

  describe('active session - partner status', () => {
    it('shows partner working on earlier stage when behind', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.PERSPECTIVE_STRETCH, StageStatus.IN_PROGRESS),
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        'Alex',
      );
      expect(result.partnerStatus).toBe('Alex is working on Your Story');
    });

    it('shows partner at own pace when behind and gate pending', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.PERSPECTIVE_STRETCH, StageStatus.IN_PROGRESS),
        makeProgress(Stage.WITNESS, StageStatus.GATE_PENDING),
        'Alex',
      );
      expect(result.partnerStatus).toBe('Alex is working at their own pace');
    });

    it('shows partner is also ready when both gate pending', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.GATE_PENDING),
        makeProgress(Stage.WITNESS, StageStatus.GATE_PENDING),
        'Alex',
      );
      expect(result.partnerStatus).toBe('Alex is also ready');
    });

    it('shows partner will join when ready when same stage NOT_STARTED', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        makeProgress(Stage.WITNESS, StageStatus.NOT_STARTED),
        'Alex',
      );
      expect(result.partnerStatus).toBe('Alex will join when ready');
    });

    it('shows stage-specific partner message when same stage IN_PROGRESS', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        'Alex',
      );
      expect(result.partnerStatus).toBe('Alex is working on their story');
    });

    it('shows encouraging message when partner is ahead', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        makeProgress(Stage.PERSPECTIVE_STRETCH, StageStatus.IN_PROGRESS),
        'Alex',
      );
      expect(result.partnerStatus).toBe("You can continue when you're ready");
      expect(result.userStatus).toBe("You're making progress on Your Story");
    });

    it('shows ready-when-you-are message when partner is ahead and user NOT_STARTED', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.NOT_STARTED),
        makeProgress(Stage.PERSPECTIVE_STRETCH, StageStatus.IN_PROGRESS),
        'Alex',
      );
      expect(result.userStatus).toBe('Ready for Your Story when you are');
    });
  });

  describe('no blame or pressure language', () => {
    const allStatuses = [
      SessionStatus.CREATED,
      SessionStatus.INVITED,
      SessionStatus.ACTIVE,
      SessionStatus.WAITING,
      SessionStatus.PAUSED,
      SessionStatus.RESOLVED,
      SessionStatus.ABANDONED,
    ];

    const allStages = [
      Stage.ONBOARDING,
      Stage.WITNESS,
      Stage.PERSPECTIVE_STRETCH,
      Stage.NEED_MAPPING,
      Stage.STRATEGIC_REPAIR,
    ];

    const allStageStatuses = [
      StageStatus.NOT_STARTED,
      StageStatus.IN_PROGRESS,
      StageStatus.GATE_PENDING,
      StageStatus.COMPLETED,
    ];

    it('never uses "Waiting for X to" pattern', () => {
      for (const sessionStatus of allStatuses) {
        for (const myStage of allStages) {
          for (const myStatus of allStageStatuses) {
            for (const partnerStage of allStages) {
              for (const partnerStatus of allStageStatuses) {
                const result = generateSessionStatusSummary(
                  sessionStatus,
                  makeProgress(myStage, myStatus),
                  makeProgress(partnerStage, partnerStatus),
                  'Alex',
                );
                expect(result.userStatus).not.toMatch(/Waiting for .+ to /);
                expect(result.partnerStatus).not.toMatch(/Waiting for .+ to /);
              }
            }
          }
        }
      }
    });

    it('never uses "is ahead" pattern', () => {
      for (const sessionStatus of allStatuses) {
        for (const myStage of allStages) {
          for (const partnerStage of allStages) {
            const result = generateSessionStatusSummary(
              sessionStatus,
              makeProgress(myStage, StageStatus.IN_PROGRESS),
              makeProgress(partnerStage, StageStatus.IN_PROGRESS),
              'Alex',
            );
            expect(result.userStatus).not.toMatch(/is ahead/);
            expect(result.partnerStatus).not.toMatch(/is ahead/);
          }
        }
      }
    });

    it('never uses "is waiting for you" pattern', () => {
      for (const myStage of allStages) {
        for (const partnerStage of allStages) {
          const result = generateSessionStatusSummary(
            SessionStatus.ACTIVE,
            makeProgress(myStage, StageStatus.IN_PROGRESS),
            makeProgress(partnerStage, StageStatus.IN_PROGRESS),
            'Alex',
          );
          expect(result.userStatus).not.toMatch(/is waiting for you/);
          expect(result.partnerStatus).not.toMatch(/is waiting for you/);
        }
      }
    });
  });

  describe('fallback behavior', () => {
    it('uses "Partner" when no name provided', () => {
      const result = generateSessionStatusSummary(
        SessionStatus.ACTIVE,
        makeProgress(Stage.WITNESS, StageStatus.IN_PROGRESS),
        makeProgress(Stage.WITNESS, StageStatus.NOT_STARTED),
        '',
      );
      expect(result.partnerStatus).toBe('Partner will join when ready');
    });
  });
});

describe('mapSessionToSummary - Stage 2 selfActionNeeded', () => {
  const USER_ID = 'user-1';
  const PARTNER_ID = 'user-2';

  function makeSession(
    overrides: {
      empathyAttempts?: Array<{ sourceUserId: string | null; status?: string }>;
      myStage?: number;
      myStatus?: string;
    } = {},
  ) {
    return {
      id: 'session-1',
      relationshipId: 'rel-1',
      status: 'ACTIVE',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-02'),
      relationship: {
        members: [
          { userId: USER_ID, nickname: null, user: { id: USER_ID, name: 'User', firstName: 'User' } },
          { userId: PARTNER_ID, nickname: null, user: { id: PARTNER_ID, name: 'Partner', firstName: 'Partner' } },
        ],
      },
      stageProgress: [
        {
          userId: USER_ID,
          stage: overrides.myStage ?? Stage.PERSPECTIVE_STRETCH,
          status: overrides.myStatus ?? 'IN_PROGRESS',
          startedAt: new Date('2024-01-01'),
          completedAt: null,
        },
        {
          userId: PARTNER_ID,
          stage: Stage.PERSPECTIVE_STRETCH,
          status: 'IN_PROGRESS',
          startedAt: new Date('2024-01-01'),
          completedAt: null,
        },
      ],
      empathyAttempts: overrides.empathyAttempts ?? [],
      userVessels: [],
    };
  }

  it('shows selfActionNeeded when user has not sent empathy yet', () => {
    const session = makeSession({ empathyAttempts: [] });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).toContain('continue_stage');
  });

  it('shows selfActionNeeded when user empathy is REFINING', () => {
    const session = makeSession({
      empathyAttempts: [
        { sourceUserId: USER_ID, status: 'REFINING' },
        { sourceUserId: PARTNER_ID, status: 'HELD' },
      ],
    });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).toContain('continue_stage');
  });

  it('shows selfActionNeeded when partner empathy is REVEALED (needs validation)', () => {
    const session = makeSession({
      empathyAttempts: [
        { sourceUserId: USER_ID, status: 'READY' },
        { sourceUserId: PARTNER_ID, status: 'REVEALED' },
      ],
    });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).toContain('continue_stage');
  });

  it('shows selfActionNeeded when partner empathy is AWAITING_SHARING', () => {
    const session = makeSession({
      empathyAttempts: [
        { sourceUserId: USER_ID, status: 'READY' },
        { sourceUserId: PARTNER_ID, status: 'AWAITING_SHARING' },
      ],
    });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).toContain('continue_stage');
  });

  it('does NOT show selfActionNeeded when user empathy is READY and partner is still working', () => {
    const session = makeSession({
      empathyAttempts: [
        { sourceUserId: USER_ID, status: 'READY' },
        { sourceUserId: PARTNER_ID, status: 'REFINING' },
      ],
    });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).not.toContain('continue_stage');
  });

  it('does NOT show selfActionNeeded when user empathy is READY and partner is HELD', () => {
    const session = makeSession({
      empathyAttempts: [
        { sourceUserId: USER_ID, status: 'READY' },
        { sourceUserId: PARTNER_ID, status: 'HELD' },
      ],
    });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).not.toContain('continue_stage');
  });

  it('does NOT show selfActionNeeded when user empathy is VALIDATED and partner is ANALYZING', () => {
    const session = makeSession({
      empathyAttempts: [
        { sourceUserId: USER_ID, status: 'VALIDATED' },
        { sourceUserId: PARTNER_ID, status: 'ANALYZING' },
      ],
    });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).not.toContain('continue_stage');
  });

  it('still shows selfActionNeeded for non-Stage-2 IN_PROGRESS', () => {
    const session = makeSession({
      myStage: Stage.WITNESS,
      empathyAttempts: [],
    });
    const result = mapSessionToSummary(session, USER_ID);
    expect(result.selfActionNeeded).toContain('continue_stage');
  });
});
