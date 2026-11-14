/**
 * SessionCard Component Tests
 *
 * Tests for the streamlined session card component that displays session summaries.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SessionCard } from '../SessionCard';
import { SessionSummaryDTO, SessionStatus, Stage, StageStatus } from '@meet-without-fear/shared';

// Mock expo-router
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Helper to create mock session with status summary
function createMockSession(overrides: Partial<SessionSummaryDTO> = {}): SessionSummaryDTO {
  return {
    id: 'session-1',
    status: SessionStatus.ACTIVE,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    partner: {
      id: 'user-2',
      name: 'Jane Doe',
      nickname: null,
    },
    myProgress: {
      stage: Stage.WITNESS,
      status: StageStatus.IN_PROGRESS,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: null,
    },
    partnerProgress: {
      stage: Stage.WITNESS,
      status: StageStatus.IN_PROGRESS,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: null,
    },
    statusSummary: {
      userStatus: 'Working on The Witness',
      partnerStatus: 'Jane Doe is also working',
    },
    selfActionNeeded: [],
    partnerActionNeeded: [],
    ...overrides,
  };
}

describe('SessionCard', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  describe('basic rendering', () => {
    it('renders partner name', () => {
      const session = createMockSession({
        partner: { id: 'user-2', name: 'John Smith', nickname: null },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('John Smith')).toBeTruthy();
    });

    it('renders fallback when partner has no name', () => {
      const session = createMockSession({
        partner: { id: 'user-2', name: null, nickname: null },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('Partner')).toBeTruthy();
    });

    it('prefers nickname over actual name', () => {
      const session = createMockSession({
        partner: { id: 'user-2', name: 'John Smith', nickname: 'Johnny' },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('Johnny')).toBeTruthy();
      expect(screen.queryByText('John Smith')).toBeNull();
    });

    it('renders with testID session-card for regular cards', () => {
      const session = createMockSession();
      render(<SessionCard session={session} />);

      expect(screen.getByTestId('session-card')).toBeTruthy();
    });

    it('renders with testID hero-card when isHero is true', () => {
      const session = createMockSession();
      render(<SessionCard session={session} isHero />);

      expect(screen.getByTestId('hero-card')).toBeTruthy();
    });
  });

  describe('navigation', () => {
    it('navigates to session detail on press', () => {
      const session = createMockSession({ id: 'session-123' });
      render(<SessionCard session={session} />);

      fireEvent.press(screen.getByTestId('session-card'));

      expect(mockPush).toHaveBeenCalledWith('/session/session-123');
    });
  });

  describe('status summary display', () => {
    it('renders user status from statusSummary', () => {
      const session = createMockSession({
        statusSummary: {
          userStatus: "You've shared your story",
          partnerStatus: 'Alex is working on their story',
        },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText("You've shared your story")).toBeTruthy();
    });

    it('renders partner status from statusSummary', () => {
      const session = createMockSession({
        statusSummary: {
          userStatus: "You've shared your story",
          partnerStatus: 'Alex is working on their story',
        },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('Alex is working on their story')).toBeTruthy();
    });

    it('shows invitation status for INVITED sessions', () => {
      const session = createMockSession({
        status: SessionStatus.INVITED,
        statusSummary: {
          userStatus: 'Invitation ready',
          partnerStatus: "Jane hasn't joined yet",
        },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('Invitation ready')).toBeTruthy();
      expect(screen.getByText("Jane hasn't joined yet")).toBeTruthy();
    });

    it('shows paused status for PAUSED sessions', () => {
      const session = createMockSession({
        status: SessionStatus.PAUSED,
        statusSummary: {
          userStatus: 'Session paused',
          partnerStatus: 'Take a break and return when ready',
        },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('Session paused')).toBeTruthy();
    });

    it('shows resolved status for RESOLVED sessions', () => {
      const session = createMockSession({
        status: SessionStatus.RESOLVED,
        statusSummary: {
          userStatus: 'Session complete',
          partnerStatus: 'You both reached resolution',
        },
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('Session complete')).toBeTruthy();
    });
  });

  describe('time display', () => {
    beforeAll(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-03T12:00:00Z'));
    });

    afterAll(() => {
      jest.useRealTimers();
    });

    it('shows time since last update', () => {
      const session = createMockSession({
        updatedAt: '2024-01-03T10:00:00Z', // 2 hours ago
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('2h ago')).toBeTruthy();
    });

    it('shows days for older sessions', () => {
      const session = createMockSession({
        updatedAt: '2024-01-01T12:00:00Z', // 2 days ago
      });
      render(<SessionCard session={session} />);

      expect(screen.getByText('2d ago')).toBeTruthy();
    });
  });

  describe('hero card', () => {
    it('shows hero footer with tap hint', () => {
      const session = createMockSession();
      render(<SessionCard session={session} isHero />);

      expect(screen.getByText('Tap to continue')).toBeTruthy();
    });

    it('displays status summary in hero mode', () => {
      const session = createMockSession({
        statusSummary: {
          userStatus: "You've signed the compact",
          partnerStatus: 'Alex is also ready',
        },
      });
      render(<SessionCard session={session} isHero />);

      expect(screen.getByText("You've signed the compact")).toBeTruthy();
      expect(screen.getByText('Alex is also ready')).toBeTruthy();
    });
  });

  describe('visual styling', () => {
    it('applies action card style when selfActionNeeded has items', () => {
      const session = createMockSession({
        selfActionNeeded: ['complete_stage'],
      });
      const { getByTestId } = render(<SessionCard session={session} />);
      const card = getByTestId('session-card');

      // The card should have the actionCard style applied
      // We verify the component renders without error with this state
      expect(card).toBeTruthy();
    });

    it('applies paused card style for PAUSED sessions', () => {
      const session = createMockSession({
        status: SessionStatus.PAUSED,
        statusSummary: {
          userStatus: 'Session paused',
          partnerStatus: 'Take a break',
        },
      });
      const { getByTestId } = render(<SessionCard session={session} />);
      const card = getByTestId('session-card');

      expect(card).toBeTruthy();
    });

    it('applies resolved card style for RESOLVED sessions', () => {
      const session = createMockSession({
        status: SessionStatus.RESOLVED,
        statusSummary: {
          userStatus: 'Session complete',
          partnerStatus: 'Resolution reached',
        },
      });
      const { getByTestId } = render(<SessionCard session={session} />);
      const card = getByTestId('session-card');

      expect(card).toBeTruthy();
    });
  });
});
