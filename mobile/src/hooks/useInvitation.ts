import { useEffect, useState, useCallback } from 'react';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { get, post, ApiClientError } from '@/src/lib/api';
import { ErrorCode } from '@meet-without-fear/shared';

const PENDING_INVITATION_KEY = 'pending_invitation';

// ============================================================================
// Types
// ============================================================================

/** Invitation status as returned by the API */
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';

/** Invitation details returned from the API */
export interface InvitationDetails {
  id: string;
  invitedBy: {
    id: string;
    name: string | null;
  };
  name: string | null;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
	  session: {
	    id: string;
	    status: string;
	    topicFrame: string | null;
	  };
}

/** Error types for invitation fetching */
export type InvitationErrorType = 'not_found' | 'claimed' | 'network' | 'unknown';

/**
 * The API's 403 for an invitation someone else opened first (work-k5fk.10.8: the first signed-in opener claims
 * it and only they read, accept or decline it). GET, acknowledge and accept all answer it so.
 */
export function isInvitationClaimedError(err: unknown): boolean {
  return err instanceof ApiClientError && (err.code === ErrorCode.FORBIDDEN || err.status === 403);
}

/** What the invitee sees for an invitation someone else claimed (the server's message is not shown verbatim). */
export const INVITATION_CLAIMED_MESSAGE = 'This invitation has already been opened by someone else.';

/** State returned by useInvitationDetails hook */
export interface UseInvitationDetailsState {
  invitation: InvitationDetails | null;
  isLoading: boolean;
  error: {
    type: InvitationErrorType;
    message: string;
  } | null;
  isExpired: boolean;
  isNotFound: boolean;
  /** Someone else opened (claimed) the invitation first (work-k5fk.10.40). */
  isClaimedByOther: boolean;
  refetch: () => Promise<void>;
}

/**
 * Parses invitation data from a deep link URL
 */
function parseInvitationFromUrl(url: string): string | null {
  try {
    const { path, queryParams } = Linking.parse(url);

    // Handle various URL formats:
    // - meetwithoutfear://invitation/abc123
    // - meetwithoutfear://invitation?id=abc123
    // - https://meetwithoutfear.com/invitation/abc123
    // - https://meetwithoutfear.com/invitation?id=abc123

    if (path?.startsWith('invitation/')) {
      // Path format: invitation/abc123
      const parts = path.split('/');
      if (parts.length >= 2 && parts[1]) {
        return parts[1];
      }
    }

    if (path === 'invitation' && queryParams?.id) {
      // Query param format: invitation?id=abc123
      return queryParams.id as string;
    }

    return null;
  } catch (error) {
    console.error('Failed to parse invitation URL:', error);
    return null;
  }
}

/**
 * Hook to handle invitation deep links
 *
 * When the app is opened with an invitation link, the invitation ID
 * is stored and can be retrieved after the user completes authentication.
 */
export function useInvitationLink() {
  const [invitationId, setInvitationId] = useState<string | null>(null);

  useEffect(() => {
    const handleUrl = async (event: { url: string }) => {
      const id = parseInvitationFromUrl(event.url);
      if (id) {
        console.log('[Invitation] Received invitation:', id);
        await AsyncStorage.setItem(PENDING_INVITATION_KEY, id);
        setInvitationId(id);
      }
    };

    // Listen for incoming URLs while app is running
    const subscription = Linking.addEventListener('url', handleUrl);

    // Check initial URL (app opened via deep link)
    Linking.getInitialURL().then((url) => {
      if (url) {
        handleUrl({ url });
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  return invitationId;
}

/**
 * Get the pending invitation ID from storage
 * Call this after successful authentication to navigate to the invited session
 */
export async function getPendingInvitation(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PENDING_INVITATION_KEY);
  } catch (error) {
    console.error('Failed to get pending invitation:', error);
    return null;
  }
}

/**
 * Clear the pending invitation from storage
 * Call this after successfully joining a session
 */
export async function clearPendingInvitation(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_INVITATION_KEY);
  } catch (error) {
    console.error('Failed to clear pending invitation:', error);
  }
}

/**
 * Hook to manage pending invitations after authentication
 */
export function usePendingInvitation() {
  const [pendingInvitation, setPendingInvitation] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadPendingInvitation = async () => {
      try {
        const invitation = await getPendingInvitation();
        setPendingInvitation(invitation);
      } catch (error) {
        console.error('Failed to load pending invitation:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadPendingInvitation();
  }, []);

  const clearInvitation = useCallback(async () => {
    await clearPendingInvitation();
    setPendingInvitation(null);
  }, []);

  return {
    pendingInvitation,
    isLoading,
    clearInvitation,
  };
}

/**
 * Get the website base URL for sharing invitation links.
 * In development: http://localhost:3001
 * In production: https://meetwithoutfear.com
 */
function getWebsiteUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Constants = require('expo-constants').default;
  return (
    Constants.expoConfig?.extra?.websiteUrl ||
    process.env.EXPO_PUBLIC_WEBSITE_URL ||
    (__DEV__ ? 'http://localhost:3001' : 'https://meetwithoutfear.com')
  );
}

/**
 * Generate an invitation link URL for sharing.
 * Uses website URLs (not deep links) so recipients can open in browser,
 * then log in/sign up before being redirected to the app.
 */
export function createInvitationLink(invitationId: string): string {
  const websiteUrl = getWebsiteUrl();
  return `${websiteUrl}/invitation/${invitationId}`;
}

// ============================================================================
// Invitation Details Hook
// ============================================================================

/**
 * Hook to fetch and manage invitation details from the API.
 *
 * Handles:
 * - Loading state during fetch
 * - Not found errors (404)
 * - Expired invitation detection
 * - Network errors with retry capability
 * - Auto-acknowledges pending invitations (creates notification)
 *
 * @param invitationId - The invitation ID to fetch, or null/undefined to skip
 */
export function useInvitationDetails(
  invitationId: string | null | undefined
): UseInvitationDetailsState {
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<{ type: InvitationErrorType; message: string } | null>(null);
  const [hasAcknowledged, setHasAcknowledged] = useState(false);

  const fetchInvitation = useCallback(async () => {
    if (!invitationId) {
      setIsLoading(false);
      setError({ type: 'not_found', message: 'No invitation ID provided' });
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await get<{ invitation: InvitationDetails }>(
        `/v1/invitations/${invitationId}`
      );
      setInvitation(response.invitation);
    } catch (err) {
      console.error('[useInvitationDetails] Error fetching invitation:', err);

      if (isInvitationClaimedError(err)) {
        setError({ type: 'claimed', message: INVITATION_CLAIMED_MESSAGE });
      } else if (err instanceof ApiClientError) {
        if (err.code === ErrorCode.NOT_FOUND) {
          setError({ type: 'not_found', message: 'Invitation not found' });
        } else if (err.code === ErrorCode.SERVICE_UNAVAILABLE) {
          setError({ type: 'network', message: 'Unable to connect. Please check your connection.' });
        } else {
          setError({ type: 'unknown', message: err.message || 'An unexpected error occurred' });
        }
      } else {
        setError({ type: 'network', message: 'Unable to connect. Please check your connection.' });
      }
    } finally {
      setIsLoading(false);
    }
  }, [invitationId]);

  useEffect(() => {
    fetchInvitation();
  }, [fetchInvitation]);

  // Auto-acknowledge pending invitations to create notification
  useEffect(() => {
    const acknowledgeInvitation = async () => {
      if (!invitationId || !invitation || invitation.status !== 'PENDING' || hasAcknowledged) {
        return;
      }

      try {
        await post(`/v1/invitations/${invitationId}/acknowledge`, {});
        setHasAcknowledged(true);
        console.log('[useInvitationDetails] Invitation acknowledged');
      } catch (err) {
        // Opening it claims it: someone else got there between the fetch and this call (work-k5fk.10.40).
        if (isInvitationClaimedError(err)) {
          setHasAcknowledged(true);
          setError({ type: 'claimed', message: INVITATION_CLAIMED_MESSAGE });
          return;
        }
        // Otherwise silently fail - notification is nice-to-have, not critical
        console.warn('[useInvitationDetails] Failed to acknowledge invitation:', err);
      }
    };

    acknowledgeInvitation();
  }, [invitationId, invitation, hasAcknowledged]);

  // Compute derived states
  const isExpired = invitation?.status === 'EXPIRED';
  const isNotFound = error?.type === 'not_found';
  const isClaimedByOther = error?.type === 'claimed';

  return {
    invitation,
    isLoading,
    error,
    isExpired,
    isNotFound,
    isClaimedByOther,
    refetch: fetchInvitation,
  };
}
