import { useState, useEffect, useCallback, useMemo } from 'react';
import { Session, BrainActivity, SessionSummary } from '../types';
import { api } from '../services/api';
import { useAblyConnection } from './useAblyConnection';
import {
  groupActivitiesIntoTurns,
  matchMessagesToTurns,
  splitTurnsByUser,
  Turn,
  UserInfo
} from '../utils/turnGrouping';

interface UseSessionActivityResult {
  activities: BrainActivity[];
  messages: any[];
  summary: SessionSummary | null;
  sessionData: Session | null;
  loading: boolean;
  error: string | null;
  connectionStatus: 'connecting' | 'connected' | 'error' | 'disconnected';
  users: { initiator: UserInfo | null; invitee: UserInfo | null };
  turns: Turn[];
  initiatorTurns: Turn[];
  inviteeTurns: Turn[];
  hasTwoUsers: boolean;
}

/**
 * Hook for fetching and managing session activity with real-time updates.
 */
export function useSessionActivity(sessionId: string | undefined): UseSessionActivityResult {
  const [activities, setActivities] = useState<BrainActivity[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [sessionData, setSessionData] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivity = useCallback(async () => {
    if (!sessionId) return;

    try {
      setLoading(true);
      const activityData = await api.getSessionActivity(sessionId);
      setActivities(activityData.activities);
      setMessages(activityData.messages);
      setSummary(activityData.summary);

      // Fetch session data
      const session = await api.getSession(sessionId);
      if (session) {
        setSessionData(session);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Handle real-time brain activity updates
  const handleBrainActivity = useCallback((activity: BrainActivity) => {
    if (activity.sessionId !== sessionId) return;

    setActivities(prev => {
      const index = prev.findIndex(p => p.id === activity.id);
      if (index >= 0) {
        const newArr = [...prev];
        // The live event carries telemetry only (no input / output / metadata: work-k5fk.9), so keep what the
        // REST fetch already loaded and lay the new telemetry over it.
        newArr[index] = { ...prev[index], ...activity };
        return newArr;
      }
      return [...prev, activity];
    });

    // Update summary if there's a cost
    if (activity.cost) {
      setSummary(prev => ({
        totalCost: (prev?.totalCost || 0) + activity.cost,
        totalTokens: (prev?.totalTokens || 0) + activity.tokenCountInput + activity.tokenCountOutput,
      }));
    }
  }, [sessionId]);

  // Handle real-time message updates
  const handleNewMessage = useCallback((message: any) => {
    if (message.sessionId !== sessionId || message.role !== 'USER') return;

    setMessages(prev => {
      if (prev.some(m => m.id === message.id)) return prev;
      return [...prev, message];
    });
  }, [sessionId]);

  // Set up Ably connection
  const { status: connectionStatus } = useAblyConnection({
    onBrainActivity: handleBrainActivity,
    onNewMessage: handleNewMessage,
  });

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  // Extract users from session data
  const users = useMemo((): { initiator: UserInfo | null; invitee: UserInfo | null } => {
    // Handle Inner Work sessions (single user)
    if (sessionData?.type === 'INNER_WORK' && sessionData?.user) {
      return {
        initiator: {
          id: sessionData.user.id,
          name: sessionData.user.firstName || sessionData.user.name || 'User',
          isInitiator: true,
        },
        invitee: null,
      };
    }

    if (!sessionData?.relationship?.members) {
      return { initiator: null, invitee: null };
    }

    const members = sessionData.relationship.members;

    // Sort by createdAt to determine initiator (first to join) vs invitee
    const sortedMembers = [...members].sort((a: any, b: any) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    const initiatorMember = sortedMembers[0];
    const inviteeMember = sortedMembers[1];

    const initiator = initiatorMember ? {
      id: initiatorMember.userId,
      name: initiatorMember.user?.firstName || initiatorMember.user?.name || 'User 1',
      isInitiator: true,
    } : null;

    const invitee = inviteeMember ? {
      id: inviteeMember.userId,
      name: inviteeMember.user?.firstName || inviteeMember.user?.name || 'User 2',
      isInitiator: false,
    } : null;

    return { initiator, invitee };
  }, [sessionData]);

  // Group activities into turns
  const turns = useMemo(() => {
    const grouped = groupActivitiesIntoTurns(activities, users);
    return matchMessagesToTurns(grouped, messages);
  }, [activities, users, messages]);

  // Split turns by user
  const { initiatorTurns, inviteeTurns } = useMemo(() => {
    return splitTurnsByUser(turns, users);
  }, [turns, users]);

  return {
    activities,
    messages,
    summary,
    sessionData,
    loading,
    error,
    connectionStatus,
    users,
    turns,
    initiatorTurns,
    inviteeTurns,
    hasTwoUsers: !!(users.initiator && users.invitee),
  };
}
