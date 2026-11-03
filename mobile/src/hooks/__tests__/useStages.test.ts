/**
 * useStages Hook Tests
 *
 * Tests for stage-specific API hooks covering all 5 stages of the Meet Without Fear process.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useProgress,
  useCompactStatus,
  useSignCompact,
  useConfirmFeelHeard,
  useEmpathyDraft,
  useSaveEmpathyDraft,
  useConsentToShareEmpathy,
  usePartnerEmpathy,
  useValidateEmpathy,
  useSkipRefinement,
  useNeeds,
  useCaptureNeeds,
  useConfirmNeeds,
  useAddNeed,
  useConsentShareNeeds,
  useStrategies,
  useProposeStrategy,
  useMarkReadyToRank,
  useSubmitRankings,
  useStrategiesReveal,
  useStage4State,
  useSubmitStage4ProposalSelection,
  useSubmitStage4Selections,
  useCloseStage4,
  useTendingEntries,
  useSubmitTendingResponse,
  useCreateTendingReentry,
  useAgreements,
  useCreateAgreement,
  useConfirmAgreement,
  useResolveSession,
  stageKeys,
} from '../useStages';
import { sessionKeys } from '../queryKeys';
import {
  Stage,
  StageStatus,
  NeedCategory,
  AgreementType,
  AgreementStatus,
  StrategyPhase,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4Phase,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
  ContinueChoice,
  TendingEntryStatus,
  TendingEntryType,
} from '@meet-without-fear/shared';

// Import mocked functions
import * as api from '../../lib/api';

// Mock the API module
jest.mock('../../lib/api', () => ({
  get: jest.fn(),
  post: jest.fn(),
  ApiClientError: class ApiClientError extends Error {
    code: string;
    status: number;
    constructor(error: { code: string; message: string }, status: number) {
      super(error.message);
      this.code = error.code;
      this.status = status;
    }
  },
}));

// Mock useAuth to provide user context
jest.mock('../useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-123', name: 'Test User' },
    isAuthenticated: true,
  }),
}));

const mockGet = api.get as jest.MockedFunction<typeof api.get>;
const mockPost = api.post as jest.MockedFunction<typeof api.post>;

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

// Create a wrapper with QueryClient
function createWrapper(queryClient = createTestQueryClient()): React.FC<{ children: React.ReactNode }> {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const sessionId = 'session-123';

const redesignedStage4State = {
  phase: Stage4Phase.SELECTION,
  inventory: {
    sharedProposals: [
      {
        id: 'proposal-1',
        kind: Stage4ProposalKind.SHARED_PROPOSAL,
        description: 'Try a Sunday check-in',
        needsAddressed: [],
        duration: null,
        measureOfSuccess: null,
        status: Stage4ProposalStatus.ACTIVE,
        myDecision: Stage4SelectionDecision.WILLING,
      },
    ],
    individualCommitments: [],
    unaddressedNeeds: [],
    removedProposalCount: 0,
    updatedAt: '2026-05-06T00:00:00.000Z',
  },
  coverageAudit: {
    covered: [],
    partial: [],
    open: [],
    updatedAt: null,
  },
  mySelections: [
    {
      proposalId: 'proposal-1',
      decision: Stage4SelectionDecision.WILLING,
      note: null,
      selectedAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
    },
  ],
  partnerSelections: [],
  partnerSelectionStatus: 'NOT_STARTED' as const,
  outcome: null,
  tendingPreview: null,
};

describe('useStages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('useProgress hook', () => {
    it('fetches session progress', async () => {
      mockGet.mockResolvedValueOnce({
        sessionId,
        myProgress: {
          stage: Stage.WITNESS,
          status: StageStatus.IN_PROGRESS,
          startedAt: '2024-01-01T00:00:00.000Z',
          completedAt: null,
          gates: { SIGNED_COMPACT: true },
        },
        partnerProgress: {
          stage: Stage.ONBOARDING,
          status: StageStatus.NOT_STARTED,
        },
        canAdvance: false,
      });

      const { result } = renderHook(() => useProgress(sessionId), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(result.current.data?.myProgress.stage).toBe(Stage.WITNESS);
      expect(mockGet).toHaveBeenCalledWith(`/sessions/${sessionId}/progress`);
    });

    it('does not fetch when sessionId is undefined', async () => {
      const { result } = renderHook(() => useProgress(undefined), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('Stage 0: Curiosity Compact', () => {
    describe('useCompactStatus hook', () => {
      it('fetches compact status', async () => {
        mockGet.mockResolvedValueOnce({
          mySigned: true,
          mySignedAt: '2024-01-01T00:00:00.000Z',
          partnerSigned: false,
          partnerSignedAt: null,
          canAdvance: false,
        });

        const { result } = renderHook(() => useCompactStatus(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(result.current.data?.mySigned).toBe(true);
        expect(result.current.data?.partnerSigned).toBe(false);
        expect(mockGet).toHaveBeenCalledWith(`/sessions/${sessionId}/compact/status`);
      });
    });

    describe('useSignCompact hook', () => {
      it('signs compact successfully', async () => {
        const responseData = {
          signed: true,
          signedAt: '2024-01-01T00:00:00.000Z',
          partnerSigned: false,
          canAdvance: false,
        };
        mockPost.mockResolvedValueOnce(responseData);

        const { result } = renderHook(() => useSignCompact(), {
          wrapper: createWrapper(),
        });

        let mutationResult: typeof responseData | undefined;
        await act(async () => {
          mutationResult = await result.current.mutateAsync({ sessionId });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/compact/sign`, {
          agreed: true,
        });
        expect(mutationResult?.signed).toBe(true);
      });
    });
  });

  describe('Stage 1: Feel Heard', () => {
    describe('useConfirmFeelHeard hook', () => {
      it('confirms feel heard with positive feedback', async () => {
        const responseData = {
          confirmed: true,
          confirmedAt: '2024-01-01T00:00:00.000Z',
          canAdvance: true,
          partnerCompleted: false,
        };
        mockPost.mockResolvedValueOnce(responseData);

        const { result } = renderHook(() => useConfirmFeelHeard(), {
          wrapper: createWrapper(),
        });

        const mutationPromise = result.current.mutateAsync({
          sessionId,
          confirmed: true,
          feedback: 'I feel heard',
        });
        await act(async () => {
          await mutationPromise;
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/feel-heard`, {
          confirmed: true,
          feedback: 'I feel heard',
        });
        const mutationResult = await mutationPromise;
        expect(mutationResult.confirmed).toBe(true);
      });

      it('handles not feeling heard', async () => {
        const responseData = {
          confirmed: false,
          confirmedAt: null,
          canAdvance: false,
          partnerCompleted: false,
        };
        mockPost.mockResolvedValueOnce(responseData);

        const { result } = renderHook(() => useConfirmFeelHeard(), {
          wrapper: createWrapper(),
        });

        const mutationPromise = result.current.mutateAsync({
          sessionId,
          confirmed: false,
          feedback: 'Need more time',
        });
        await act(async () => {
          await mutationPromise;
        });

        const mutationResult = await mutationPromise;
        expect(mutationResult.confirmed).toBe(false);
      });

      it('writes the feel_heard milestone into myProgress.milestones (server instant wins)', async () => {
        mockPost.mockResolvedValueOnce({
          confirmed: true,
          confirmedAt: '2024-01-01T00:00:00.000Z',
          canAdvance: true,
          partnerCompleted: false,
        });
        const queryClient = createTestQueryClient();
        queryClient.setQueryData(sessionKeys.state(sessionId), {
          progress: {
            sessionId,
            myProgress: {
              stage: Stage.WITNESS,
              status: StageStatus.IN_PROGRESS,
              startedAt: null,
              completedAt: null,
              milestones: { compact_signed: '2023-12-31T00:00:00.000Z' },
            },
            partnerProgress: { stage: Stage.WITNESS, status: StageStatus.IN_PROGRESS, startedAt: null, completedAt: null },
            canAdvance: false,
            witnessStartedAt: '2023-12-31T00:00:00.000Z',
          },
        });

        const { result } = renderHook(() => useConfirmFeelHeard(), { wrapper: createWrapper(queryClient) });
        await act(async () => {
          await result.current.mutateAsync({ sessionId, confirmed: true });
        });

        const progress = queryClient.getQueryData<any>(sessionKeys.state(sessionId))?.progress;
        expect(progress.myProgress.milestones).toEqual({
          compact_signed: '2023-12-31T00:00:00.000Z',
          feel_heard: '2024-01-01T00:00:00.000Z',
        });
        expect(progress.myProgress.stage).toBe(Stage.PERSPECTIVE_STRETCH);
        expect(progress).not.toHaveProperty('milestones');
      });
    });
  });

  describe('Stage 2: Empathy / Perspective Stretch', () => {
    describe('useEmpathyDraft hook', () => {
      it('fetches empathy draft', async () => {
        mockGet.mockResolvedValueOnce({
          draft: {
            id: 'draft-123',
            content: 'I understand you feel...',
            readyToShare: false,
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        });

        const { result } = renderHook(() => useEmpathyDraft(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(result.current.data?.draft?.content).toContain('I understand');
        expect(mockGet).toHaveBeenCalledWith(`/sessions/${sessionId}/empathy/draft`);
      });
    });

    describe('useSaveEmpathyDraft hook', () => {
      it('saves empathy draft', async () => {
        mockPost.mockResolvedValueOnce({
          draft: {
            id: 'draft-123',
            content: 'Updated empathy content',
            readyToShare: false,
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        });

        const { result } = renderHook(() => useSaveEmpathyDraft(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            content: 'Updated empathy content',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/empathy/draft`, {
          content: 'Updated empathy content',
          readyToShare: undefined,
        });
      });

      it('saves draft as ready to share', async () => {
        mockPost.mockResolvedValueOnce({
          draft: {
            id: 'draft-123',
            content: 'Final content',
            readyToShare: true,
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        });

        const { result } = renderHook(() => useSaveEmpathyDraft(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            content: 'Final content',
            readyToShare: true,
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/empathy/draft`, {
          content: 'Final content',
          readyToShare: true,
        });
      });
    });

    describe('useConsentToShareEmpathy hook', () => {
      it('grants consent to share empathy', async () => {
        mockPost.mockResolvedValueOnce({
          consent: true,
          bothConsented: false,
          canViewPartner: false,
        });

        const { result } = renderHook(() => useConsentToShareEmpathy(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            consent: true,
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/empathy/consent`, {
          consent: true,
        });
      });
    });

    describe('usePartnerEmpathy hook', () => {
      it('fetches partner empathy attempt after both consent', async () => {
        mockGet.mockResolvedValueOnce({
          attempt: {
            id: 'empathy-456',
            sourceUserId: 'user-456',
            content: 'Partner empathy attempt',
            sharedAt: '2024-01-01T00:00:00.000Z',
            consentRecordId: 'consent-123',
          },
          waitingForPartner: false,
          validated: false,
          validatedAt: null,
          awaitingRevision: false,
        });

        const { result } = renderHook(() => usePartnerEmpathy(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(result.current.data?.attempt?.content).toBe('Partner empathy attempt');
      });
    });

    describe('useValidateEmpathy hook', () => {
      it('validates partner empathy positively', async () => {
        mockPost.mockResolvedValueOnce({
          validated: true,
          validatedAt: '2024-01-01T00:00:00.000Z',
          feedbackShared: false,
          awaitingRevision: false,
          canAdvance: true,
          partnerValidated: false,
        });

        const { result } = renderHook(() => useValidateEmpathy(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            validated: true,
            feedback: 'Yes, you understood me',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/empathy/validate`, {
          sessionId,
          validated: true,
          feedback: 'Yes, you understood me',
        });
      });
    });

    describe('useSkipRefinement hook', () => {
      it('accepts partner experience without further revision', async () => {
        mockPost.mockResolvedValueOnce({ success: true });

        const { result } = renderHook(() => useSkipRefinement(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            willingToAccept: true,
          });
        });

        expect(mockPost).toHaveBeenCalledWith(
          `/sessions/${sessionId}/empathy/skip-refinement`,
          { willingToAccept: true }
        );
      });

      it('declines partner experience with a reason', async () => {
        mockPost.mockResolvedValueOnce({ success: true });

        const { result } = renderHook(() => useSkipRefinement(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            willingToAccept: false,
            reason: 'This still misses the impact.',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(
          `/sessions/${sessionId}/empathy/skip-refinement`,
          {
            willingToAccept: false,
            reason: 'This still misses the impact.',
          }
        );
      });
    });
  });

  describe('Stage 3: Need Mapping', () => {
    describe('useNeeds hook', () => {
      it('fetches AI-identified needs', async () => {
        mockGet.mockResolvedValueOnce({
          needs: [
            {
              id: 'need-1',
              need: 'Respect',
              category: NeedCategory.RECOGNITION,
              description: 'Feeling valued and recognized',
              evidence: ['Quote 1'],
              confirmed: false,
              aiConfidence: 0.9,
            },
            {
              id: 'need-2',
              need: 'Understanding',
              category: NeedCategory.CONNECTION,
              description: 'Being understood by partner',
              evidence: ['Quote 2'],
              confirmed: false,
              aiConfidence: 0.85,
            },
          ],
          synthesizedAt: '2024-01-01T00:00:00.000Z',
          isDirty: false,
        });

        const { result } = renderHook(() => useNeeds(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(result.current.data?.needs).toHaveLength(2);
        expect(result.current.data?.needs[0].need).toBe('Respect');
      });
    });

    describe('useCaptureNeeds hook', () => {
      it('captures needs through the Stage 3 capture endpoint', async () => {
        mockPost.mockResolvedValueOnce({
          needs: [
            {
              id: 'need-1',
              need: 'Respect',
              category: NeedCategory.RECOGNITION,
              description: 'Feeling valued and recognized',
              evidence: ['Quote 1'],
              confirmed: false,
              aiConfidence: 0.85,
            },
          ],
          capturedAt: '2024-01-01T00:00:00.000Z',
        });

        const { result } = renderHook(() => useCaptureNeeds(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            needs: [
              {
                need: 'Respect',
                category: NeedCategory.RECOGNITION,
                description: 'Feeling valued and recognized',
                evidence: ['Quote 1'],
              },
            ],
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/needs/capture`, {
          needs: [
            {
              need: 'Respect',
              category: NeedCategory.RECOGNITION,
              description: 'Feeling valued and recognized',
              evidence: ['Quote 1'],
            },
          ],
        });
      });
    });

    describe('useConfirmNeeds hook', () => {
      it('confirms identified needs', async () => {
        mockPost.mockResolvedValueOnce({
          confirmed: true,
          confirmedAt: '2024-01-01T00:00:00.000Z',
          partnerConfirmed: false,
          canAdvance: false,
        });

        const { result } = renderHook(() => useConfirmNeeds(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            needIds: ['need-1', 'need-2'],
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/needs/confirm`, {
          needIds: ['need-1', 'need-2'],
          adjustments: undefined,
        });
      });

      it('immediately writes the needs_confirmed milestone into progress and session state caches', async () => {
        mockPost.mockResolvedValueOnce({
          confirmed: true,
          confirmedAt: '2024-01-01T00:00:00.000Z',
          partnerConfirmed: false,
          canAdvance: false,
        });

        const queryClient = createTestQueryClient();
        queryClient.setQueryData(stageKeys.progress(sessionId), {
          sessionId,
          myProgress: {
            stage: Stage.NEED_MAPPING,
            status: StageStatus.IN_PROGRESS,
            startedAt: '2024-01-01T00:00:00.000Z',
            completedAt: null,
            milestones: {},
          },
          partnerProgress: {
            stage: Stage.NEED_MAPPING,
            status: StageStatus.IN_PROGRESS,
          },
          canAdvance: false,
        });
        queryClient.setQueryData(sessionKeys.state(sessionId), {
          progress: {
            sessionId,
            myProgress: {
              stage: Stage.NEED_MAPPING,
              status: StageStatus.IN_PROGRESS,
              startedAt: '2024-01-01T00:00:00.000Z',
              completedAt: null,
              milestones: {},
            },
            partnerProgress: {
              stage: Stage.NEED_MAPPING,
              status: StageStatus.IN_PROGRESS,
            },
            canAdvance: false,
            witnessStartedAt: null,
          },
        });

        const { result } = renderHook(() => useConfirmNeeds(), {
          wrapper: createWrapper(queryClient),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            needIds: ['need-1', 'need-2'],
          });
        });

        expect(
          queryClient.getQueryData<any>(stageKeys.progress(sessionId))?.myProgress.milestones.needs_confirmed
        ).toEqual(expect.any(String));
        expect(
          queryClient.getQueryData<any>(sessionKeys.state(sessionId))?.progress.myProgress.milestones.needs_confirmed
        ).toEqual(expect.any(String));
      });
    });

    describe('useAddNeed hook', () => {
      it('adds custom need', async () => {
        mockPost.mockResolvedValueOnce({
          need: {
            id: 'need-3',
            need: 'Security',
            category: NeedCategory.SAFETY,
            description: 'Feeling safe in the relationship',
            evidence: [],
            confirmed: true,
            aiConfidence: 1.0,
          },
        });

        const { result } = renderHook(() => useAddNeed(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            need: 'Security',
            category: NeedCategory.SAFETY,
            description: 'Feeling safe in the relationship',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/needs`, {
          need: 'Security',
          category: NeedCategory.SAFETY,
          description: 'Feeling safe in the relationship',
        });
      });
    });

    describe('useConsentShareNeeds hook', () => {
      it('consents to reveal confirmed needs to the partner', async () => {
        mockPost.mockResolvedValueOnce({
          consented: true,
          sharedAt: '2024-01-01T00:00:00.000Z',
          waitingForPartner: true,
          needsRevealReady: false,
        });

        const { result } = renderHook(() => useConsentShareNeeds(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            needIds: ['need-1', 'need-2'],
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/needs/consent`, {
          needIds: ['need-1', 'need-2'],
        });
      });

      it.each([
        { label: 'first sharer (partner not yet shared)', needsRevealReady: false },
        { label: 'second sharer (reveal ready)', needsRevealReady: true },
      ])('records the own share in the needs cache; needs_shared only once all shared — $label', async ({ needsRevealReady }) => {
        mockPost.mockResolvedValueOnce({
          consented: true,
          sharedAt: '2024-01-01T00:00:00.000Z',
          waitingForPartner: !needsRevealReady,
          needsRevealReady,
        });

        const queryClient = createTestQueryClient();
        queryClient.setQueryData(stageKeys.progress(sessionId), {
          sessionId,
          myProgress: {
            stage: Stage.NEED_MAPPING,
            status: StageStatus.GATE_PENDING,
            startedAt: '2024-01-01T00:00:00.000Z',
            completedAt: null,
            milestones: { needs_confirmed: '2024-01-01T00:00:00.000Z' },
          },
          partnerProgress: {
            stage: Stage.NEED_MAPPING,
            status: StageStatus.GATE_PENDING,
          },
          canAdvance: false,
        });
        queryClient.setQueryData(sessionKeys.state(sessionId), {
          progress: {
            sessionId,
            myProgress: {
              stage: Stage.NEED_MAPPING,
              status: StageStatus.GATE_PENDING,
              startedAt: '2024-01-01T00:00:00.000Z',
              completedAt: null,
              milestones: { needs_confirmed: '2024-01-01T00:00:00.000Z' },
            },
            partnerProgress: {
              stage: Stage.NEED_MAPPING,
              status: StageStatus.GATE_PENDING,
            },
            canAdvance: false,
            witnessStartedAt: null,
          },
        });

        queryClient.setQueryData(stageKeys.needs(sessionId), { needs: [], synthesizedAt: null, sharedAt: null });

        const { result } = renderHook(() => useConsentShareNeeds(), {
          wrapper: createWrapper(queryClient),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            needIds: ['need-1', 'need-2'],
          });
        });

        expect(queryClient.getQueryData<any>(stageKeys.needs(sessionId))?.sharedAt).toBe('2024-01-01T00:00:00.000Z');
        const expected = needsRevealReady ? '2024-01-01T00:00:00.000Z' : undefined;
        expect(
          queryClient.getQueryData<any>(stageKeys.progress(sessionId))?.myProgress.milestones.needs_shared
        ).toBe(expected);
        expect(
          queryClient.getQueryData<any>(sessionKeys.state(sessionId))?.progress.myProgress.milestones.needs_shared
        ).toBe(expected);
      });
    });

  });

  describe('Stage 4: Strategic Repair', () => {
    describe('useStrategies hook', () => {
      it('fetches strategies for session', async () => {
        mockGet.mockResolvedValueOnce({
          strategies: [
            {
              id: 'strategy-1',
              description: 'Weekly check-ins',
              proposedBy: 'user-123',
              needsAddressed: ['need-1'],
            },
          ],
          canRank: true,
        });

        const { result } = renderHook(() => useStrategies(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(result.current.data?.strategies).toHaveLength(1);
        expect(result.current.data?.strategies[0].description).toBe('Weekly check-ins');
      });
    });

    describe('useProposeStrategy hook', () => {
      it('proposes new strategy', async () => {
        mockPost.mockResolvedValueOnce({
          strategy: {
            id: 'strategy-2',
            description: 'Daily appreciation',
            proposedBy: 'user-123',
            needsAddressed: ['need-1', 'need-2'],
          },
        });

        const { result } = renderHook(() => useProposeStrategy(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            description: 'Daily appreciation',
            needsAddressed: ['need-1', 'need-2'],
            duration: '30 days',
            measureOfSuccess: 'Both partners feel appreciated',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/strategies`, {
          description: 'Daily appreciation',
          needsAddressed: ['need-1', 'need-2'],
          duration: '30 days',
          measureOfSuccess: 'Both partners feel appreciated',
        });
      });
    });

    describe('useSubmitRankings hook', () => {
      it('optimistically marks current user ready to rank in cache', async () => {
        mockPost.mockResolvedValueOnce({
          ready: true,
          readyAt: '2026-05-05T00:00:00.000Z',
          partnerReady: false,
          canStartRanking: false,
        });

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(stageKeys.strategies(sessionId), {
          strategies: [],
          phase: StrategyPhase.COLLECTING,
          aiSuggestionsAvailable: false,
          myReadyToRank: false,
          partnerReadyToRank: false,
        });
        queryClient.setQueryData(stageKeys.progress(sessionId), {
          sessionId,
          myProgress: {
            stage: Stage.STRATEGIC_REPAIR,
            status: StageStatus.IN_PROGRESS,
            startedAt: '2026-05-05T00:00:00.000Z',
            completedAt: null,
            milestones: {},
          },
          partnerProgress: {
            stage: Stage.STRATEGIC_REPAIR,
            status: StageStatus.IN_PROGRESS,
            milestones: {},
          },
          canAdvance: false,
        });
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
          return React.createElement(QueryClientProvider, { client: queryClient }, children);
        };

        const { result } = renderHook(() => useMarkReadyToRank(), { wrapper });

        await act(async () => {
          await result.current.mutateAsync({ sessionId });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/strategies/ready`);
        expect(queryClient.getQueryData<any>(stageKeys.strategies(sessionId))?.myReadyToRank).toBe(true);
        // Readiness is not a milestone: the progress cache is left alone.
        expect(queryClient.getQueryData<any>(stageKeys.progress(sessionId))?.myProgress.milestones).toEqual({});
      });

      it('submits strategy rankings', async () => {
        mockPost.mockResolvedValueOnce({
          submitted: true,
          waitingForPartner: true,
        });

        const { result } = renderHook(() => useSubmitRankings(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            rankedIds: ['strategy-1', 'strategy-2', 'strategy-3'],
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/strategies/rank`, {
          rankedIds: ['strategy-1', 'strategy-2', 'strategy-3'],
        });
      });

      it('moves the local strategy cache out of active ranking immediately', async () => {
        mockPost.mockResolvedValueOnce({
          ranked: true,
          rankedAt: '2026-05-05T00:00:00.000Z',
          partnerRanked: false,
          canReveal: false,
        });

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(stageKeys.strategies(sessionId), {
          strategies: [],
          phase: StrategyPhase.RANKING,
          aiSuggestionsAvailable: false,
          myReadyToRank: true,
          partnerReadyToRank: true,
        });
        queryClient.setQueryData(stageKeys.progress(sessionId), {
          sessionId,
          myProgress: {
            stage: Stage.STRATEGIC_REPAIR,
            status: StageStatus.IN_PROGRESS,
            startedAt: '2026-05-05T00:00:00.000Z',
            completedAt: null,
            milestones: {},
          },
          partnerProgress: {
            stage: Stage.STRATEGIC_REPAIR,
            status: StageStatus.IN_PROGRESS,
            milestones: {},
          },
          canAdvance: false,
        });
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
          React.createElement(QueryClientProvider, { client: queryClient }, children);

        const { result } = renderHook(() => useSubmitRankings(), { wrapper });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            rankedIds: ['strategy-1', 'strategy-2'],
          });
        });

        expect(queryClient.getQueryData<any>(stageKeys.strategies(sessionId))?.phase)
          .toBe(StrategyPhase.REVEALING);
        // Ranking has no milestone on the target: the progress cache is left alone.
        expect(queryClient.getQueryData<any>(stageKeys.progress(sessionId))?.myProgress.milestones).toEqual({});
      });
    });

    describe('useStrategiesReveal hook', () => {
      it('fetches strategy overlap after both ranked', async () => {
        mockGet.mockResolvedValueOnce({
          overlap: [
            {
              id: 'strategy-1',
              description: 'Weekly check-ins',
              needsAddressed: ['need-1'],
              duration: null,
              measureOfSuccess: null,
            },
          ],
          phase: 'REVEALING',
        });

        const { result } = renderHook(() => useStrategiesReveal(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(result.current.data?.overlap).toHaveLength(1);
        expect(result.current.data?.overlap[0].id).toBe('strategy-1');
      });
    });

    describe('redesigned Stage 4 hooks', () => {
      it('fetches redesigned Stage 4 state', async () => {
        mockGet.mockResolvedValueOnce(redesignedStage4State);

        const { result } = renderHook(() => useStage4State(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(mockGet).toHaveBeenCalledWith(`/sessions/${sessionId}/stage4`);
        expect(result.current.data?.phase).toBe(Stage4Phase.SELECTION);
      });

      it('submits one proposal selection and caches refreshed Stage 4 state', async () => {
        mockPost.mockResolvedValueOnce({
          submitted: true,
          submittedAt: '2026-05-06T00:00:00.000Z',
          partnerSubmitted: false,
          state: redesignedStage4State,
        });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
          React.createElement(QueryClientProvider, { client: queryClient }, children);

        const { result } = renderHook(() => useSubmitStage4ProposalSelection(), { wrapper });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            proposalId: 'proposal-1',
            decision: Stage4SelectionDecision.WILLING,
            note: 'Worth trying',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(
          `/sessions/${sessionId}/stage4/proposals/proposal-1/selection`,
          { decision: Stage4SelectionDecision.WILLING, note: 'Worth trying' }
        );
        expect(queryClient.getQueryData(stageKeys.stage4(sessionId))).toEqual(redesignedStage4State);
      });

      it('submits bulk proposal selections', async () => {
        mockPost.mockResolvedValueOnce({
          submitted: true,
          submittedAt: '2026-05-06T00:00:00.000Z',
          partnerSubmitted: true,
          state: redesignedStage4State,
        });

        const { result } = renderHook(() => useSubmitStage4Selections(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            selections: [
              {
                proposalId: 'proposal-1',
                decision: Stage4SelectionDecision.NOT_WILLING,
              },
            ],
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/stage4/selections`, {
          selections: [
            {
              proposalId: 'proposal-1',
              decision: Stage4SelectionDecision.NOT_WILLING,
            },
          ],
        });
      });

      it('closes redesigned Stage 4 through the new closure endpoint', async () => {
        const closedState = {
          ...redesignedStage4State,
          phase: Stage4Phase.CLOSED_NO_SHARED_AGREEMENT,
          outcome: {
            kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
            reason: Stage4ClosureReason.NO_OVERLAP,
            summary: 'No shared agreement for now.',
            agreements: [],
            individualCommitments: [],
            openNeeds: [],
            closedAt: '2026-05-06T00:00:00.000Z',
          },
        };
        mockPost.mockResolvedValueOnce({
          closed: true,
          closedAt: '2026-05-06T00:00:00.000Z',
          outcome: closedState.outcome,
          state: closedState,
        });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
          React.createElement(QueryClientProvider, { client: queryClient }, children);

        const { result } = renderHook(() => useCloseStage4(), { wrapper });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
            reason: Stage4ClosureReason.NO_OVERLAP,
            summary: 'No shared agreement for now.',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/stage4/close`, {
          kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
          reason: Stage4ClosureReason.NO_OVERLAP,
          summary: 'No shared agreement for now.',
        });
        expect(queryClient.getQueryData(stageKeys.stage4(sessionId))).toEqual(closedState);
        expect(queryClient.getQueryData(stageKeys.agreements(sessionId))).toEqual({ agreements: [] });
      });
    });

    describe('Tending hooks', () => {
      const tendingEntry = {
        id: 'tending-1',
        sessionId,
        agreementId: 'agreement-1',
        type: TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN,
        status: TendingEntryStatus.OPEN,
        scheduledFor: '2026-05-13T00:00:00.000Z',
        openedAt: '2026-05-13T00:00:00.000Z',
        completedAt: null,
        summary: 'Check whether the shared experiment helped.',
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-13T00:00:00.000Z',
        myResponse: null,
        responseCount: 0,
      };

      it('fetches Tending entries', async () => {
        mockGet.mockResolvedValueOnce({ entries: [tendingEntry] });

        const { result } = renderHook(() => useTendingEntries(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(mockGet).toHaveBeenCalledWith(`/sessions/${sessionId}/tending`);
        expect(result.current.data?.entries[0].id).toBe('tending-1');
      });

      it('submits a Tending response and caches the updated entry', async () => {
        const updatedEntry = {
          ...tendingEntry,
          status: TendingEntryStatus.PARTIAL,
          myResponse: {
            id: 'response-1',
            tendingEntryId: tendingEntry.id,
            userId: 'user-123',
            status: 'CHECKIN',
            reflection: 'It helped once.',
            continueChoice: ContinueChoice.EXTEND,
            submittedAt: '2026-05-13T01:00:00.000Z',
          },
          responseCount: 1,
        };
        mockPost.mockResolvedValueOnce({ entry: updatedEntry });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
          React.createElement(QueryClientProvider, { client: queryClient }, children);

        const { result } = renderHook(() => useSubmitTendingResponse(), { wrapper });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            entryId: tendingEntry.id,
            status: 'CHECKIN',
            reflection: 'It helped once.',
            continueChoice: ContinueChoice.EXTEND,
          });
        });

        expect(mockPost).toHaveBeenCalledWith(
          `/sessions/${sessionId}/tending/${tendingEntry.id}/responses`,
          {
            status: 'CHECKIN',
            reflection: 'It helped once.',
            continueChoice: ContinueChoice.EXTEND,
          }
        );
        expect(queryClient.getQueryData(stageKeys.tending(sessionId))).toEqual({
          entries: [updatedEntry],
        });
      });

      it('creates passive Tending re-entry', async () => {
        const reentry = {
          ...tendingEntry,
          id: 'tending-reentry-1',
          agreementId: null,
          type: TendingEntryType.USER_INITIATED_REENTRY,
          summary: 'Passive Tending re-entry context.',
        };
        mockPost.mockResolvedValueOnce({ entry: reentry });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
          React.createElement(QueryClientProvider, { client: queryClient }, children);

        const { result } = renderHook(() => useCreateTendingReentry(), { wrapper });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            intent: 'I want to revisit what stayed open.',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/tending/reentry`, {
          intent: 'I want to revisit what stayed open.',
        });
        expect(queryClient.getQueryData(stageKeys.tending(sessionId))).toEqual({
          entries: [reentry],
        });
      });
    });
  });

  describe('Agreements', () => {
    describe('useAgreements hook', () => {
      it('fetches session agreements', async () => {
        mockGet.mockResolvedValueOnce({
          agreements: [
            {
              id: 'agreement-1',
              description: 'We agree to weekly check-ins',
              type: AgreementType.COMMITMENT,
              status: AgreementStatus.PROPOSED,
              duration: null,
              measureOfSuccess: null,
              agreedByMe: false,
              agreedByPartner: false,
              agreedAt: null,
              followUpDate: null,
            },
          ],
        });

        const { result } = renderHook(() => useAgreements(sessionId), {
          wrapper: createWrapper(),
        });

        await waitFor(() => {
          expect(result.current.isSuccess).toBe(true);
        });

        expect(result.current.data?.agreements).toHaveLength(1);
      });
    });

    describe('useCreateAgreement hook', () => {
      it('creates new agreement', async () => {
        mockPost.mockResolvedValueOnce({
          agreement: {
            id: 'agreement-1',
            description: 'We agree to weekly check-ins on Sundays',
            type: AgreementType.COMMITMENT,
            status: 'PROPOSED',
            duration: null,
            measureOfSuccess: null,
            agreedByMe: true,
            agreedByPartner: false,
            agreedAt: null,
            followUpDate: null,
          },
          awaitingPartnerConfirmation: true,
        });

        const { result } = renderHook(() => useCreateAgreement(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            strategyId: 'strategy-1',
            description: 'We agree to weekly check-ins on Sundays',
            type: AgreementType.COMMITMENT,
          });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/agreements`, {
          strategyId: 'strategy-1',
          description: 'We agree to weekly check-ins on Sundays',
          type: AgreementType.COMMITMENT,
        });
      });

      it('adds the created agreement to cache and leaves reveal state', async () => {
        mockPost.mockResolvedValueOnce({
          agreement: {
            id: 'agreement-1',
            description: 'We agree to weekly check-ins on Sundays',
            type: AgreementType.COMMITMENT,
            status: 'PROPOSED',
            duration: null,
            measureOfSuccess: null,
            agreedByMe: true,
            agreedByPartner: false,
            agreedAt: null,
            followUpDate: null,
          },
          awaitingPartnerConfirmation: true,
        });

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(stageKeys.strategies(sessionId), {
          strategies: [],
          phase: StrategyPhase.REVEALING,
          aiSuggestionsAvailable: false,
        });
        const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
          React.createElement(QueryClientProvider, { client: queryClient }, children);

        const { result } = renderHook(() => useCreateAgreement(), { wrapper });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            strategyId: 'strategy-1',
            description: 'We agree to weekly check-ins on Sundays',
            type: AgreementType.COMMITMENT,
          });
        });

        expect(queryClient.getQueryData<any>(stageKeys.agreements(sessionId))?.agreements)
          .toHaveLength(1);
        expect(queryClient.getQueryData<any>(stageKeys.strategies(sessionId))?.phase)
          .toBe(StrategyPhase.NEGOTIATING);
      });
    });

    describe('useConfirmAgreement hook', () => {
      it('confirms agreement', async () => {
        mockPost.mockResolvedValueOnce({
          confirmed: true,
          bothConfirmed: true,
          status: 'CONFIRMED',
        });

        const { result } = renderHook(() => useConfirmAgreement(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            agreementId: 'agreement-1',
            confirmed: true,
          });
        });

        expect(mockPost).toHaveBeenCalledWith(
          `/sessions/${sessionId}/agreements/agreement-1/confirm`,
          { confirmed: true, modification: undefined }
        );
      });

      it('requests modification to agreement', async () => {
        mockPost.mockResolvedValueOnce({
          confirmed: false,
          modificationRequested: true,
          status: 'PENDING_MODIFICATION',
        });

        const { result } = renderHook(() => useConfirmAgreement(), {
          wrapper: createWrapper(),
        });

        await act(async () => {
          await result.current.mutateAsync({
            sessionId,
            agreementId: 'agreement-1',
            confirmed: false,
            modification: 'Can we do biweekly instead?',
          });
        });

        expect(mockPost).toHaveBeenCalledWith(
          `/sessions/${sessionId}/agreements/agreement-1/confirm`,
          { confirmed: false, modification: 'Can we do biweekly instead?' }
        );
      });
    });

    describe('useResolveSession hook', () => {
      it('resolves session successfully', async () => {
        const responseData = {
          resolved: true,
          resolvedAt: '2024-01-01T00:00:00.000Z',
          agreements: [],
          followUpScheduled: false,
        };
        mockPost.mockResolvedValueOnce(responseData);

        const { result } = renderHook(() => useResolveSession(), {
          wrapper: createWrapper(),
        });

        let mutationResult: typeof responseData | undefined;
        await act(async () => {
          mutationResult = await result.current.mutateAsync({ sessionId });
        });

        expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/resolve`);
        expect(mutationResult?.resolved).toBe(true);
      });
    });
  });

  describe('stageKeys', () => {
    it('generates correct query keys', () => {
      expect(stageKeys.all).toEqual(['stages']);
      expect(stageKeys.progress(sessionId)).toEqual(['stages', 'progress', sessionId]);
      expect(stageKeys.compact(sessionId)).toEqual(['stages', 'compact', sessionId]);
      expect(stageKeys.empathyDraft(sessionId)).toEqual([
        'stages',
        'empathy',
        'draft',
        sessionId,
      ]);
      expect(stageKeys.partnerEmpathy(sessionId)).toEqual([
        'stages',
        'empathy',
        'partner',
        sessionId,
      ]);
      expect(stageKeys.needs(sessionId)).toEqual(['stages', 'needs', sessionId]);
      expect(stageKeys.stage4(sessionId)).toEqual(['stages', 'stage4', sessionId]);
      expect(stageKeys.strategies(sessionId)).toEqual(['stages', 'strategies', sessionId]);
      expect(stageKeys.strategiesReveal(sessionId)).toEqual([
        'stages',
        'strategies',
        'reveal',
        sessionId,
      ]);
      expect(stageKeys.agreements(sessionId)).toEqual(['stages', 'agreements', sessionId]);
    });
  });
});
