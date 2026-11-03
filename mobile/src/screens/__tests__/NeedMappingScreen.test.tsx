/**
 * NeedMappingScreen Tests
 *
 * Tests for Stage 3 Need Mapping screen covering:
 * - Exploration phase (chat with AI)
 * - Review phase (show identified needs)
 * - Confirmation flow
 * - Waiting for partner
 */

import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import { render } from '../../utils/test-utils';
import { Stage, StageStatus, NeedCategory, MessageRole } from '@meet-without-fear/shared';

// Import after mocks
import { NeedMappingScreen } from '../NeedMappingScreen';

// Mock expo-router
const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'test-session-123' }),
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: jest.fn(),
  }),
  Stack: {
    Screen: 'Screen',
  },
}));

// Mock ChatInterface to render messages without animation logic
jest.mock('../../components/ChatInterface', () => {
  const { View, Text, TextInput, TouchableOpacity } = require('react-native');
  return {
    ChatInterface: ({ messages, onSendMessage, emptyStateTitle, emptyStateMessage }: {
      messages: { id: string; content: string }[];
      onSendMessage?: (text: string) => void;
      emptyStateTitle?: string;
      emptyStateMessage?: string;
    }) => (
      <View testID="chat-interface">
        {messages.length === 0 ? (
          <View testID="chat-empty-state">
            <Text>{emptyStateTitle}</Text>
            <Text>{emptyStateMessage}</Text>
          </View>
        ) : (
          messages.map((msg) => (
            <View key={msg.id} testID={`chat-bubble-${msg.id}`}>
              <Text>{msg.content}</Text>
            </View>
          ))
        )}
        <View>
          <TextInput testID="chat-input" />
          <TouchableOpacity testID="send-button" onPress={() => onSendMessage?.('test')}>
            <Text>Send</Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
  };
});

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
  };
});

// Default mock data - unconfirmed needs (for review phase)
const mockNeedsUnconfirmed = [
  {
    id: 'need-1',
    need: 'Security',
    category: NeedCategory.SAFETY,
    description: 'A need to feel safe and stable in the relationship',
    evidence: ['I felt unsafe when...'],
    confirmed: false,
    aiConfidence: 0.85,
  },
  {
    id: 'need-2',
    need: 'Connection',
    category: NeedCategory.CONNECTION,
    description: 'A need to feel close and emotionally connected',
    evidence: ['I miss feeling close...'],
    confirmed: false,
    aiConfidence: 0.9,
  },
];

const mockMessages = [
  {
    id: 'msg-1',
    sessionId: 'test-session-123',
    role: MessageRole.AI,
    content: 'Let me help you understand what you need.',
    stage: Stage.NEED_MAPPING,
    timestamp: new Date().toISOString(),
    // Skip typewriter in tests so message renders immediately
    skipTypewriter: true,
  },
];

// Type definitions for mock data
type NeedsType = typeof mockNeedsUnconfirmed;
type NeedsComparisonType = {
  myNeeds: { id: string; need: string; category: NeedCategory; confirmed: boolean }[];
  partnerNeeds: { id: string; need: string; category: NeedCategory; confirmed: boolean }[];
};

// Mock hooks - these will be overridden per test
let mockNeedsData: { needs: NeedsType; synthesizedAt: string; isDirty: boolean; sharedAt: string | null } = {
  needs: [],
  synthesizedAt: '',
  isDirty: false,
  sharedAt: null,
};
let mockNeedsComparisonData: NeedsComparisonType | undefined;
let mockMessagesData = { messages: mockMessages };
let mockProgressData: {
  myProgress: { stage: Stage; status: StageStatus; milestones?: Record<string, string> };
  partnerProgress: { stage: Stage; status: StageStatus; milestones?: Record<string, string> };
} = {
  myProgress: { stage: Stage.NEED_MAPPING, status: StageStatus.IN_PROGRESS },
  partnerProgress: { stage: Stage.NEED_MAPPING, status: StageStatus.IN_PROGRESS },
};
const mockCaptureNeedsMutate = jest.fn();
const mockConfirmNeedsMutate = jest.fn();
const mockConsentShareNeedsMutate = jest.fn();

jest.mock('../../hooks/useSessions', () => ({
  useSession: () => ({
    data: {
      session: {
        id: 'test-session-123',
        partner: { name: 'Alex' },
      },
    },
    isLoading: false,
  }),
}));

jest.mock('../../hooks/useMessages', () => ({
  useMessages: () => ({
    data: mockMessagesData,
    isLoading: false,
  }),
}));

jest.mock('../../hooks/useStreamingMessage', () => ({
  useStreamingMessage: () => ({
    sendMessage: jest.fn(),
    isSending: false,
  }),
}));

jest.mock('../../hooks/useStages', () => ({
  useProgress: () => ({
    data: mockProgressData,
    isLoading: false,
  }),
  useNeeds: () => ({
    data: mockNeedsData,
    isLoading: false,
    refetch: jest.fn(),
  }),
  useNeedsComparison: () => ({
    data: mockNeedsComparisonData,
    isLoading: false,
  }),
  useCaptureNeeds: () => ({
    mutate: mockCaptureNeedsMutate,
    isPending: false,
  }),
  useConfirmNeeds: () => ({
    mutate: mockConfirmNeedsMutate,
    isPending: false,
  }),
  useAddNeed: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
  useConsentShareNeeds: () => ({
    mutate: mockConsentShareNeedsMutate,
    isPending: false,
  }),
}));

describe('NeedMappingScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset to defaults - exploration phase (no needs yet)
    mockNeedsData = { needs: [], synthesizedAt: '', isDirty: false, sharedAt: null };
    mockNeedsComparisonData = undefined;
    mockMessagesData = { messages: mockMessages };
    mockProgressData = {
      myProgress: { stage: Stage.NEED_MAPPING, status: StageStatus.IN_PROGRESS },
      partnerProgress: { stage: Stage.NEED_MAPPING, status: StageStatus.IN_PROGRESS },
    };
  });

  describe('Exploration Phase (no needs yet)', () => {
    it('renders the exploration screen title', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText('Understanding Your Needs')).toBeTruthy();
    });

    it('renders the exploration subtitle', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText(/underlying needs/i)).toBeTruthy();
    });

    it('shows chat interface in exploration phase', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText('Understanding Your Needs')).toBeTruthy();
    });

    it('shows AI messages in chat', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText('Let me help you understand what you need.')).toBeTruthy();
    });
  });

  describe('Review Phase (needs identified, not confirmed)', () => {
    beforeEach(() => {
      mockNeedsData = {
        needs: mockNeedsUnconfirmed,
        synthesizedAt: new Date().toISOString(),
        isDirty: false,
        sharedAt: null,
      };
    });

    it('shows identified needs section', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText('Your Needs')).toBeTruthy();
    });

    it('displays all identified needs', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText('Security')).toBeTruthy();
      expect(screen.getByText('Connection')).toBeTruthy();
    });

    it('shows need descriptions', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText(/feel safe and stable/i)).toBeTruthy();
      expect(screen.getByText(/emotionally connected/i)).toBeTruthy();
    });

    it('allows adjusting needs', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText(/adjust/i)).toBeTruthy();
    });

    it('shows confirm button', () => {
      render(<NeedMappingScreen />);
      const confirmButton = screen.getByText(/confirm/i);
      expect(confirmButton).toBeTruthy();
    });

    it('captures displayed needs before confirming and consenting', () => {
      mockCaptureNeedsMutate.mockImplementation((_variables, options) => {
        options?.onSuccess?.({
          needs: mockNeedsUnconfirmed.map((need) => ({ ...need, confirmed: false })),
          capturedAt: new Date().toISOString(),
        });
      });
      mockConfirmNeedsMutate.mockImplementation((_variables, options) => {
        options?.onSuccess?.();
      });

      render(<NeedMappingScreen />);
      fireEvent.press(screen.getByTestId('confirm-needs-button'));

      expect(mockCaptureNeedsMutate).toHaveBeenCalledWith(
        {
          sessionId: 'test-session-123',
          needs: [
            {
              need: 'Security',
              category: NeedCategory.SAFETY,
              description: 'A need to feel safe and stable in the relationship',
              evidence: ['I felt unsafe when...'],
            },
            {
              need: 'Connection',
              category: NeedCategory.CONNECTION,
              description: 'A need to feel close and emotionally connected',
              evidence: ['I miss feeling close...'],
            },
          ],
        },
        expect.any(Object)
      );
      expect(mockConfirmNeedsMutate).toHaveBeenCalledWith(
        { sessionId: 'test-session-123', needIds: ['need-1', 'need-2'] },
        expect.any(Object)
      );
      expect(mockConsentShareNeedsMutate).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        needIds: ['need-1', 'need-2'],
      });
    });
  });

  describe('Reveal Phase (both partners consented)', () => {
    beforeEach(() => {
      mockNeedsData = {
        needs: mockNeedsUnconfirmed.map((need) => ({ ...need, confirmed: true })),
        synthesizedAt: new Date().toISOString(),
        isDirty: false,
        // The caller's own share (need_share) — not the session-scoped needs_shared milestone.
        sharedAt: new Date().toISOString(),
      };
      mockProgressData = {
        myProgress: {
          stage: Stage.NEED_MAPPING,
          status: StageStatus.IN_PROGRESS,
        },
        partnerProgress: { stage: Stage.NEED_MAPPING, status: StageStatus.IN_PROGRESS },
      };
      mockNeedsComparisonData = {
        myNeeds: [
          { id: 'need-1', need: 'Security', category: NeedCategory.SAFETY, confirmed: true },
        ],
        partnerNeeds: [
          { id: 'partner-need-1', need: 'Autonomy', category: NeedCategory.AUTONOMY, confirmed: true },
        ],
      };
    });

    it('renders side-by-side reveal cards and the noticing prompt', () => {
      render(<NeedMappingScreen />);

      expect(screen.getByTestId('need-mapping-reveal')).toBeTruthy();
      expect(screen.getByTestId('needs-side-by-side')).toBeTruthy();
      expect(screen.getByText('What do you notice?')).toBeTruthy();
      expect(screen.getByText('Your needs')).toBeTruthy();
      expect(screen.getByText('Partner needs')).toBeTruthy();
      expect(screen.getByText('Security')).toBeTruthy();
      expect(screen.getByText('Autonomy')).toBeTruthy();
    });
  });

  describe('Waiting Phase (partner behind in progress)', () => {
    beforeEach(() => {
      mockProgressData = {
        myProgress: { stage: Stage.STRATEGIC_REPAIR, status: StageStatus.IN_PROGRESS },
        partnerProgress: { stage: Stage.NEED_MAPPING, status: StageStatus.IN_PROGRESS },
      };
    });

    it('shows waiting room when partner is behind', () => {
      render(<NeedMappingScreen />);
      // Use getAllByText since "Waiting" appears in both title and message
      const waitingElements = screen.getAllByText(/waiting/i);
      expect(waitingElements.length).toBeGreaterThan(0);
    });

    it('shows partner name in waiting message', () => {
      render(<NeedMappingScreen />);
      expect(screen.getAllByText(/Alex/).length).toBeGreaterThan(0);
    });

    it('shows waiting message about partner completing needs', () => {
      render(<NeedMappingScreen />);
      expect(screen.getByText(/partner to complete need mapping/i)).toBeTruthy();
    });
  });

  describe('Stage Gate Check', () => {
    it('shows locked message if not at need mapping stage', () => {
      mockProgressData = {
        myProgress: { stage: Stage.PERSPECTIVE_STRETCH, status: StageStatus.IN_PROGRESS },
        partnerProgress: { stage: Stage.PERSPECTIVE_STRETCH, status: StageStatus.IN_PROGRESS },
      };
      render(<NeedMappingScreen />);
      expect(screen.getByText(/unlocked/i)).toBeTruthy();
    });
  });
});
