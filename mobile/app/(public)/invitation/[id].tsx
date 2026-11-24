import { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  SafeAreaView,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '@/src/hooks/useAuth';
import {
  useInvitationDetails,
  isInvitationClaimedError,
  INVITATION_CLAIMED_MESSAGE,
} from '@/src/hooks/useInvitation';
import { useAcceptInvitation } from '@/src/hooks/useSessions';
import { colors } from '@/src/theme';

const PENDING_INVITATION_KEY = 'pending_invitation';

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Loading state while fetching invitation details
 */
function LoadingState() {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.accent} />
      <Text style={styles.loadingText}>Loading invitation...</Text>
    </View>
  );
}

/**
 * Expired invitation state with option to request a new one
 */
function ExpiredState({ inviterName }: { inviterName: string | null }) {
  const handleRequestNew = () => {
    // Navigate to home where user can contact the inviter
    router.replace('/(public)');
  };

  const handleReturnHome = () => {
    router.replace('/(public)');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="time-outline" size={64} color={colors.warning} />
        </View>

        <Text style={styles.title}>Invitation Expired</Text>

        <Text style={styles.description}>
          {inviterName
            ? `The invitation from ${inviterName} has expired.`
            : 'This invitation has expired.'}
        </Text>

        <Text style={styles.subtitle}>
          Invitations are valid for 7 days. Please ask {inviterName || 'the sender'} to send you a
          new invitation.
        </Text>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleRequestNew}
            accessibilityRole="button"
            accessibilityLabel="Request new invitation"
          >
            <Ionicons name="mail-outline" size={20} color="#FFFFFF" style={styles.buttonIcon} />
            <Text style={styles.primaryButtonText}>Request New Invitation</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={handleReturnHome}
            accessibilityRole="button"
            accessibilityLabel="Return home"
          >
            <Text style={styles.secondaryButtonText}>Return Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * Someone else opened the invitation first (work-k5fk.10.40): they are its invitee, so this account cannot read,
 * accept or decline it. Not an error to retry.
 */
function ClaimedState() {
  const handleReturnHome = () => {
    router.replace('/(public)');
  };

  return (
    <SafeAreaView style={styles.container} testID="invitation-claimed-state">
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="lock-closed-outline" size={64} color={colors.textMuted} />
        </View>

        <Text style={styles.title}>Invitation Already Opened</Text>

        <Text style={styles.description}>{INVITATION_CLAIMED_MESSAGE}</Text>

        <Text style={styles.subtitle}>
          An invitation belongs to the first person who opens it. If that was you on another account, sign in with
          that account; otherwise ask the sender to invite you directly.
        </Text>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleReturnHome}
            accessibilityRole="button"
            accessibilityLabel="Return home"
          >
            <Ionicons name="home-outline" size={20} color="#FFFFFF" style={styles.buttonIcon} />
            <Text style={styles.primaryButtonText}>Return Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * Not found state when invitation ID is invalid
 */
function NotFoundState() {
  const handleReturnHome = () => {
    router.replace('/(public)');
  };

  const handleContactSupport = () => {
    // For now, just go home - in the future could open a support link
    router.replace('/(public)');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="search-outline" size={64} color={colors.textMuted} />
        </View>

        <Text style={styles.title}>Invitation Not Found</Text>

        <Text style={styles.description}>
          We could not find this invitation. It may have been deleted or the link may be incorrect.
        </Text>

        <Text style={styles.subtitle}>
          Please check the invitation link and try again, or ask the sender for a new invitation.
        </Text>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleReturnHome}
            accessibilityRole="button"
            accessibilityLabel="Return home"
          >
            <Ionicons name="home-outline" size={20} color="#FFFFFF" style={styles.buttonIcon} />
            <Text style={styles.primaryButtonText}>Return Home</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={handleContactSupport}
            accessibilityRole="button"
            accessibilityLabel="Contact support"
          >
            <Text style={styles.secondaryButtonText}>Contact Support</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * Network error state with retry option
 */
function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const handleReturnHome = () => {
    router.replace('/(public)');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons name="cloud-offline-outline" size={64} color={colors.error} />
        </View>

        <Text style={styles.title}>Connection Error</Text>

        <Text style={styles.description}>{message}</Text>

        <Text style={styles.subtitle}>Please check your internet connection and try again.</Text>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Ionicons name="refresh-outline" size={20} color="#FFFFFF" style={styles.buttonIcon} />
            <Text style={styles.primaryButtonText}>Try Again</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={handleReturnHome}
            accessibilityRole="button"
            accessibilityLabel="Return home"
          >
            <Text style={styles.secondaryButtonText}>Return Home</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * Already processed invitation (accepted or declined)
 */
function AlreadyProcessedState({
  status,
  inviterName,
}: {
  status: 'ACCEPTED' | 'DECLINED';
  inviterName: string | null;
}) {
  const handleReturnHome = () => {
    router.replace('/(public)');
  };

  const isAccepted = status === 'ACCEPTED';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons
            name={isAccepted ? 'checkmark-circle-outline' : 'close-circle-outline'}
            size={64}
            color={isAccepted ? colors.success : colors.textMuted}
          />
        </View>

        <Text style={styles.title}>
          Invitation Already {isAccepted ? 'Accepted' : 'Declined'}
        </Text>

        <Text style={styles.description}>
          {isAccepted
            ? `You have already accepted this invitation${inviterName ? ` from ${inviterName}` : ''}.`
            : `This invitation${inviterName ? ` from ${inviterName}` : ''} was declined.`}
        </Text>

        {isAccepted && (
          <Text style={styles.subtitle}>Sign in to access your session.</Text>
        )}

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleReturnHome}
            accessibilityRole="button"
            accessibilityLabel={isAccepted ? 'Sign in' : 'Return home'}
          >
            <Text style={styles.primaryButtonText}>
              {isAccepted ? 'Sign In' : 'Return Home'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Invitation landing screen
 *
 * When a user opens an invitation deep link, this screen:
 * 1. Fetches invitation details from the API
 * 2. Shows appropriate UI based on invitation status:
 *    - Loading: Shows spinner
 *    - Expired: Shows expired message with request new option
 *    - Not Found: Shows not found message with return home
 *    - Claimed: someone else opened it first (403), return home
 *    - Network Error: Shows error with retry option
 *    - Valid: Stores invitation ID and redirects appropriately
 */
export default function InvitationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const {
    invitation,
    isLoading: isInvitationLoading,
    error,
    isExpired,
    isNotFound,
    isClaimedByOther,
    refetch,
  } = useInvitationDetails(id);

  const acceptInvitation = useAcceptInvitation({
    onSuccess: async (data) => {
      // Clear the pending invitation since we've now accepted it
      await AsyncStorage.removeItem(PENDING_INVITATION_KEY);
      // Navigate to the session using the session ID from the response
      router.replace(`/session/${data.session.id}`);
    },
  });

  useEffect(() => {
    const handleValidInvitation = async () => {
      // Wait for both auth and invitation data
      if (isAuthLoading || isInvitationLoading) {
        return;
      }

      // Don't proceed if there's an error or special status
      if (error || isExpired || !invitation) {
        return;
      }

      // Don't proceed if invitation is already processed
      if (invitation.status === 'ACCEPTED' || invitation.status === 'DECLINED') {
        return;
      }

      // Store the invitation ID for later use (in case user needs to log in)
      if (id) {
        await AsyncStorage.setItem(PENDING_INVITATION_KEY, id);
      }

      if (isAuthenticated) {
        // User is authenticated - accept the invitation
        // This will set the session to ACTIVE and navigate on success
        if (!acceptInvitation.isPending) {
          acceptInvitation.mutate({ invitationId: id });
        }
      } else {
        // User needs to login first
        router.replace('/(public)');
      }
    };

    handleValidInvitation();
  }, [id, invitation, isAuthenticated, isAuthLoading, isInvitationLoading, error, isExpired, acceptInvitation]);

  // Show loading state while fetching data or accepting invitation
  if (isAuthLoading || isInvitationLoading || acceptInvitation.isPending) {
    return <LoadingState />;
  }

  // Someone else opened it first: the GET, the acknowledge or the accept said so (403)
  if (isClaimedByOther || (acceptInvitation.isError && isInvitationClaimedError(acceptInvitation.error))) {
    return <ClaimedState />;
  }

  // Show error if invitation acceptance failed
  if (acceptInvitation.isError) {
    return (
      <ErrorState
        message={acceptInvitation.error?.message || 'Failed to accept invitation'}
        onRetry={() => acceptInvitation.mutate({ invitationId: id })}
      />
    );
  }

  // Show not found state
  if (isNotFound) {
    return <NotFoundState />;
  }

  // Show error state for network/unknown errors
  if (error && error.type !== 'not_found') {
    return <ErrorState message={error.message} onRetry={refetch} />;
  }

  // Show expired state
  if (isExpired && invitation) {
    return <ExpiredState inviterName={invitation.invitedBy.name} />;
  }

  // Show already processed state
  if (invitation && (invitation.status === 'ACCEPTED' || invitation.status === 'DECLINED')) {
    return (
      <AlreadyProcessedState
        status={invitation.status}
        inviterName={invitation.invitedBy.name}
      />
    );
  }

  // Default loading state while redirecting
  return <LoadingState />;
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPage,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    maxWidth: 400,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: colors.textSecondary,
  },
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.bgSecondary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 12,
  },
  description: {
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 24,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 20,
  },
  buttonContainer: {
    width: '100%',
    gap: 12,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonIcon: {
    marginRight: 8,
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: '500',
  },
});
