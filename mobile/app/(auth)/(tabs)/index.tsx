/**
 * Home Screen
 *
 * Simplified landing page with:
 * - Big greeting: "Hi [username]"
 * - Main question: "What can I help you work through today?"
 * - Low-profile quick actions: Continue with [nickname], New Session, Inner Thoughts
 * - Pending invitation CTA: "Accept [name]'s invitation" (if invited)
 *
 * Inner Thoughts navigates to the private reflection list.
 */

import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  Alert,
  Animated,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowRight, ArrowUp, Plus, Layers, UserPlus, Menu, Settings, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SessionStatus, type SessionSummaryDTO } from '@meet-without-fear/shared';

import { useAuth } from '@/src/hooks/useAuth';
import { useBiometricAuth, usePendingInvitation, useSessionDrawer } from '@/src/hooks';
import { describeAcceptInvitationError, useInvitationDetails } from '@/src/hooks/useInvitation';
import { useSessions, useAcceptInvitation } from '../../../src/hooks/useSessions';
import { useUnreadSessionCount } from '@/src/hooks/useUnreadSessionCount';
import { BiometricPrompt, SessionDrawer } from '../../../src/components';
import { designFonts, useAppAppearance } from '@/src/theme';

const SHOW_INNER_WORK_BUTTON = true;

// ============================================================================
// Component
// ============================================================================

export default function HomeScreen() {
  const { palette } = useAppAppearance();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const router = useRouter();
  const { user, isLoading: isAuthLoading } = useAuth();
  const { data, isLoading: isSessionsLoading } = useSessions();
  const { isAvailable, isEnrolled, hasPrompted, isLoading: biometricLoading } = useBiometricAuth();
  const { openDrawer } = useSessionDrawer();
  const { count: unreadCount } = useUnreadSessionCount();
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [showProcessDrawer, setShowProcessDrawer] = useState(false);
  const composerExtrasOpacity = useRef(new Animated.Value(1)).current;

  const dismissHomeComposer = useCallback(() => {
    Keyboard.dismiss();
    setIsComposerFocused(false);
  }, []);

  // Check for pending invitation from deep link
  const { pendingInvitation, isLoading: isPendingLoading, clearInvitation } = usePendingInvitation();
  const { invitation } = useInvitationDetails(pendingInvitation);

  // Accept invitation mutation
  const acceptInvitation = useAcceptInvitation({
    onSuccess: async (data) => {
      await clearInvitation();
      router.push(`/session/${data.session.id}`);
    },
    onError: async (error) => {
      // Say why (work-k5fk.35 C10): claimed by someone else, invitations turned off, the session full, a live
      // session with this person already, expired. A refusal clears the invitation; a transient failure keeps it.
      const { message, keepPending } = describeAcceptInvitationError(error);
      Alert.alert("Couldn't accept the invitation", message);
      if (!keepPending) await clearInvitation();
    },
  });

  // Wait for auth, sessions, and pending invitation check to load
  const isLoading = isAuthLoading || isSessionsLoading || isPendingLoading;

  // Biometric prompt state
  const [showBiometricPrompt, setShowBiometricPrompt] = useState(false);

  // Show biometric prompt when conditions are met
  useEffect(() => {
    if (!biometricLoading && isAvailable && isEnrolled && !hasPrompted) {
      const timer = setTimeout(() => {
        setShowBiometricPrompt(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [biometricLoading, isAvailable, isEnrolled, hasPrompted]);

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidHide', () => {
      setIsComposerFocused(false);
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (isComposerFocused) {
      composerExtrasOpacity.stopAnimation();
      composerExtrasOpacity.setValue(0);
      return;
    }

    composerExtrasOpacity.setValue(0);
    Animated.timing(composerExtrasOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [composerExtrasOpacity, isComposerFocused]);

  // Find the most recent session with a partner nickname
  const mostRecentSession = useMemo(() => {
    const sessions = data?.items || [];
    if (sessions.length === 0) return null;

    // Sort by most recently updated
    const sorted = [...sessions].sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return sorted[0];
  }, [data?.items]);

  // Get the partner's nickname or name for the continue button
  const partnerDisplayName = mostRecentSession?.partner?.nickname || mostRecentSession?.partner?.name;
  const continueCopy = useMemo(() => {
    if (!mostRecentSession || !partnerDisplayName) return null;
    return getContinueSessionCopy(mostRecentSession, partnerDisplayName);
  }, [mostRecentSession, partnerDisplayName]);

  // Handle sending a message from the home page chat input.
  const handleHomeChat = useCallback((message: string) => {
    Keyboard.dismiss();
    const params: {
      id: string;
      initialMessage: string;
    } = {
      id: 'new',
      initialMessage: message,
    };

    router.push({
      pathname: '/inner-work/self-reflection/[id]',
      params,
    });
  }, [router]);

  // Get inviter's name for pending invitation
  const inviterName = invitation?.invitedBy?.name || 'Someone';
  const hasPendingInvitation = pendingInvitation && invitation && invitation.status === 'PENDING';

  const handleNewSession = () => {
    router.push('/session/new');
  };

  const handleContinueSession = () => {
    if (mostRecentSession) {
      router.push(`/session/${mostRecentSession.id}`);
    }
  };

  const handleInnerWork = () => {
    // Navigate to the Inner Thoughts list.
    router.push('/inner-work');
  };

  const handleAcceptInvitation = () => {
    if (pendingInvitation) {
      acceptInvitation.mutate({ invitationId: pendingInvitation });
    }
  };

  const handleSettings = useCallback(() => {
    router.push('/settings');
  }, [router]);

  const handleOpenProcessDrawer = useCallback(() => {
    setShowProcessDrawer(true);
  }, []);

  const handleCloseProcessDrawer = useCallback(() => {
    setShowProcessDrawer(false);
  }, []);

  // Get the user's display name
  const userName = user?.firstName || user?.name?.split(' ')[0] || 'there';

  // Loading state
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={palette.accent} />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SessionDrawer>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header with hamburger and settings icons */}
        <View style={styles.headerBar}>
          <TouchableOpacity
            style={styles.headerIconButton}
            onPress={openDrawer}
            accessibilityRole="button"
            accessibilityLabel="Open session drawer"
          >
            <Menu color={palette.textMuted} size={22} />
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <View style={styles.brandMark}>
            <View style={styles.brandDot} />
            <Text style={styles.brandText}>meet without fear</Text>
          </View>
          <TouchableOpacity
            style={styles.headerIconButton}
            onPress={handleSettings}
            accessibilityRole="button"
            accessibilityLabel="Open settings"
          >
            <Settings color={palette.textMuted} size={22} />
          </TouchableOpacity>
        </View>

          <KeyboardAvoidingView
            style={styles.keyboardAvoid}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={0}
          >
            <Pressable style={styles.content} onPress={dismissHomeComposer}>
              <View style={styles.greetingSection}>
                <Text style={styles.greeting}>
                  {getGreetingLabel()}, <Text style={styles.greetingEm}>{userName}</Text>
                </Text>
                <Text style={styles.question}>
                  What would you like to work through?
                </Text>
              </View>

              {!isComposerFocused && (
                <Animated.View style={{ opacity: composerExtrasOpacity }}>
                <View style={styles.actionsSection}>
                  {/* Accept pending invitation - shown first if there's a pending invitation */}
                  {hasPendingInvitation && (
                    <TouchableOpacity
                      style={[styles.actionCard, styles.primaryActionCard]}
                      onPress={handleAcceptInvitation}
                      accessibilityRole="button"
                      accessibilityLabel={`Accept ${inviterName}'s invitation`}
                      disabled={acceptInvitation.isPending}
                    >
                      {acceptInvitation.isPending ? (
                        <ActivityIndicator size="small" color={palette.accent} />
                      ) : (
                        <View style={styles.actionIcon}>
                          <UserPlus color={palette.textMuted} size={18} />
                        </View>
                      )}
                      <View style={styles.actionTextBlock}>
                        <Text style={styles.actionEyebrow}>Invitation waiting</Text>
                        <Text style={styles.actionTitle}>Accept {inviterName}&apos;s invitation</Text>
                        <Text style={styles.actionSub}>Join the conversation when you are ready</Text>
                      </View>
                      <ArrowRight color={palette.textFaint} size={16} />
                    </TouchableOpacity>
                  )}

                  {/* Continue with partner - only show if there's a recent session and no pending invitation */}
                  {!hasPendingInvitation && mostRecentSession && partnerDisplayName && continueCopy && (
                    <TouchableOpacity
                      style={[styles.actionCard, styles.primaryActionCard]}
                      onPress={handleContinueSession}
                      accessibilityRole="button"
                      accessibilityLabel={`Continue with ${partnerDisplayName}`}
                    >
                      <View style={styles.actionAvatar}>
                        <Text style={styles.actionAvatarText}>{partnerDisplayName.charAt(0).toUpperCase()}</Text>
                        <View style={styles.actionPing} />
                      </View>
                      <View style={styles.actionTextBlock}>
                        <Text style={styles.actionEyebrow}>{continueCopy.eyebrow}</Text>
                        <Text style={styles.actionTitle}>{continueCopy.title}</Text>
                        <Text style={styles.actionSub}>{continueCopy.subtitle}</Text>
                      </View>
                      <ArrowRight color={palette.textFaint} size={16} />
                    </TouchableOpacity>
                  )}

                  <View style={styles.secondaryActionsGroup}>
                    <View style={styles.secondaryActionsRule} />
                    <View style={styles.secondaryActionsRow}>
                      {/* New Session */}
                      <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={handleNewSession}
                        accessibilityRole="button"
                        accessibilityLabel="Start new session"
                      >
                        <Plus color={palette.accentText} size={18} />
                        <Text style={styles.secondaryButtonText}>New conversation</Text>
                      </TouchableOpacity>

                      {SHOW_INNER_WORK_BUTTON && (
                        <TouchableOpacity
                          style={styles.secondaryButton}
                          onPress={handleInnerWork}
                          accessibilityRole="button"
                          accessibilityLabel="Inner Thoughts"
                        >
                          <Layers color={palette.textMuted} size={17} />
                          <Text style={styles.secondaryButtonText}>Inner thoughts</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>

                <View style={styles.whisper}>
                  <View style={styles.whisperRule}>
                    <View style={styles.whisperDot} />
                    <Text style={styles.whisperLabel}>Today</Text>
                    <View style={styles.whisperLine} />
                  </View>
                  <Text style={styles.whisperQuote}>
                    It is okay to take your time getting to the words. The right ones usually arrive after the rough ones.
                  </Text>
                </View>

                <TouchableOpacity
                  style={styles.processLink}
                  onPress={handleOpenProcessDrawer}
                  accessibilityRole="button"
                  accessibilityLabel="How does this work?"
                >
                  <Text style={styles.processLinkText}>How does this work?</Text>
                </TouchableOpacity>
                </Animated.View>
              )}
            </Pressable>

            <View style={styles.chatInputSection}>
              <HomeComposer
                onSend={handleHomeChat}
                onFocusChange={setIsComposerFocused}
                palette={palette}
              />
            </View>
        </KeyboardAvoidingView>

        {/* Biometric opt-in prompt */}
        <BiometricPrompt
          visible={showBiometricPrompt}
          onDismiss={() => setShowBiometricPrompt(false)}
          testID="biometric-prompt"
        />

        <ProcessDrawer
          visible={showProcessDrawer}
          onClose={handleCloseProcessDrawer}
          palette={palette}
        />
      </SafeAreaView>
    </SessionDrawer>
  );
}

function getGreetingLabel() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function getContinueSessionCopy(session: SessionSummaryDTO, partnerName: string) {
  const userStatus = session.statusSummary?.userStatus;
  const partnerStatus = session.statusSummary?.partnerStatus;

  switch (session.status) {
    case SessionStatus.CREATED:
      return {
        eyebrow: 'Draft',
        title: `Finish inviting ${partnerName}`,
        subtitle: userStatus || 'Prepare the invitation when you are ready',
      };
    case SessionStatus.INVITED:
      return {
        eyebrow: 'Invitation sent',
        title: `Waiting for ${partnerName}`,
        subtitle: partnerStatus || `${partnerName} can join when ready`,
      };
    case SessionStatus.PAUSED:
      return {
        eyebrow: 'Paused',
        title: `Return to ${partnerName}`,
        subtitle: userStatus || 'Take your time and continue when ready',
      };
    case SessionStatus.RESOLVED:
      return {
        eyebrow: 'Resolved',
        title: `Review session with ${partnerName}`,
        subtitle: userStatus || 'Look back at what you worked through',
      };
    case SessionStatus.ABANDONED:
      return {
        eyebrow: 'Ended',
        title: `View session with ${partnerName}`,
        subtitle: partnerStatus || 'This conversation was not completed',
      };
    case SessionStatus.ACTIVE:
    case SessionStatus.WAITING:
    default:
      return {
        eyebrow: 'Continue',
        title: `Continue with ${partnerName}`,
        subtitle: userStatus || partnerStatus || 'Pick up where you left off',
      };
  }
}

function HomeComposer({
  onSend,
  onFocusChange,
  palette,
}: {
  onSend: (message: string) => void;
  onFocusChange: (focused: boolean) => void;
  palette: ReturnType<typeof useAppAppearance>['palette'];
}) {
  const [value, setValue] = useState('');
  const canSend = value.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    const message = value.trim();
    setValue('');
    onSend(message);
  };

  return (
    <View style={[composerStyles.container, { backgroundColor: palette.bg }]}>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder="What's on your mind?"
        placeholderTextColor={palette.textFaint}
        style={[
          composerStyles.input,
          {
            backgroundColor: palette.bgElev,
            borderColor: palette.border,
            color: palette.text,
          },
        ]}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onSubmitEditing={handleSend}
        returnKeyType="send"
      />
      <TouchableOpacity
        style={[
          composerStyles.sendButton,
          { backgroundColor: canSend ? palette.accent : palette.chipBg },
        ]}
        onPress={handleSend}
        disabled={!canSend}
        accessibilityRole="button"
        accessibilityLabel="Send"
      >
        <ArrowUp color={canSend ? palette.bg : palette.textFaint} size={18} />
      </TouchableOpacity>
    </View>
  );
}

const PROCESS_STEPS = [
  {
    title: 'Start in private',
    body: 'Each person works with the AI separately. The app slows things down before anyone is asked to respond directly.',
  },
  {
    title: 'Be fully heard',
    body: 'You first tell your side without interruption. The AI reflects it back until you feel accurately understood.',
  },
  {
    title: 'Practice understanding',
    body: 'When both people are ready, the process helps each of you understand the other person without excusing or debating what happened.',
  },
  {
    title: 'Name what matters',
    body: 'You clarify the needs underneath the conflict, choose what to share, and only reveal it when both people have consented.',
  },
  {
    title: 'Try a small repair',
    body: 'The final step looks for small, reversible experiments both people are willing to try, then turns overlap into a clear next step.',
  },
];

function ProcessDrawer({
  visible,
  onClose,
  palette,
}: {
  visible: boolean;
  onClose: () => void;
  palette: ReturnType<typeof useAppAppearance>['palette'];
}) {
  const styles = useMemo(() => makeProcessDrawerStyles(palette), [palette]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.drawerHeader}>
            <View style={styles.drawerTitleBlock}>
              <Text style={styles.drawerEyebrow}>A guided conversation</Text>
              <Text style={styles.drawerTitle}>How it works</Text>
            </View>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <X color={palette.textMuted} size={18} />
            </TouchableOpacity>
          </View>

          <Text style={styles.intro}>
            Meet Without Fear works like a buffer between two people. It helps
            each side settle, be heard, and move toward a next step without
            rushing into a reactive conversation.
          </Text>

          <View style={styles.steps}>
            {PROCESS_STEPS.map((step, index) => (
              <View key={step.title} style={styles.stepRow}>
                <View style={styles.stepNumber}>
                  <Text style={styles.stepNumberText}>{index + 1}</Text>
                </View>
                <View style={styles.stepTextBlock}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepBody}>{step.body}</Text>
                </View>
              </View>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ============================================================================
// Styles
// ============================================================================

const composerStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 18,
  },
    input: {
    flex: 1,
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 18,
    fontSize: 14,
    fontFamily: designFonts.sans,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const makeStyles = (palette: ReturnType<typeof useAppAppearance>['palette']) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: palette.bg,
    },
    headerBar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    headerIconButton: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    brandMark: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    brandDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: palette.accent,
    },
    brandText: {
      color: palette.text,
      fontSize: 18,
      fontFamily: designFonts.serif,
      letterSpacing: -0.1,
    },
    badge: {
      position: 'absolute',
      top: 3,
      right: 0,
      backgroundColor: palette.accent,
      borderRadius: 999,
      minWidth: 15,
      height: 15,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 3,
      borderWidth: 2,
      borderColor: palette.bg,
    },
    badgeText: {
      color: palette.bg,
      fontSize: 9,
      fontWeight: '700',
      fontFamily: designFonts.mono,
    },
    keyboardAvoid: {
      flex: 1,
    },
    centerContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    loadingText: {
      marginTop: 12,
      fontSize: 16,
      color: palette.textMuted,
      fontFamily: designFonts.sans,
    },
    content: {
      flex: 1,
      paddingHorizontal: 16,
    },
    processLink: {
      alignSelf: 'flex-start',
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginTop: 18,
      marginLeft: 0,
    },
    processLinkText: {
      color: palette.accentText,
      fontSize: 15,
      fontFamily: designFonts.serifItalic,
    },
    greetingSection: {
      paddingTop: 36,
      paddingHorizontal: 12,
      paddingBottom: 28,
    },
    timeGreet: {
      color: palette.textFaint,
      fontSize: 10.5,
      letterSpacing: 1.1,
      textTransform: 'uppercase',
      marginBottom: 16,
      fontWeight: '600',
      fontFamily: designFonts.mono,
    },
    greeting: {
      fontSize: 44,
      color: palette.text,
      marginBottom: 12,
      letterSpacing: -0.8,
      lineHeight: 46,
      fontFamily: designFonts.serif,
    },
    greetingEm: {
      fontFamily: designFonts.serifItalic,
    },
    question: {
      fontSize: 15,
      color: palette.textMuted,
      lineHeight: 22,
      maxWidth: 280,
      fontFamily: designFonts.sans,
    },
    actionsSection: {
      gap: 6,
    },
    chatInputSection: {
      borderTopWidth: 1,
      borderTopColor: palette.divider,
      backgroundColor: palette.bg,
    },
    actionCard: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: palette.bgElev,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: 14,
      padding: 14,
      gap: 10,
    },
    primaryActionCard: {
      borderLeftWidth: 3,
      borderLeftColor: palette.accent,
    },
    secondaryActionsGroup: {
      marginTop: 18,
      marginBottom: 16,
    },
    secondaryActionsRule: {
      height: 1,
      marginBottom: 18,
      backgroundColor: palette.divider,
    },
    secondaryActionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    secondaryButton: {
      flex: 1,
      minHeight: 66,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      backgroundColor: palette.bgElev,
      borderWidth: 1,
      borderColor: palette.border,
    },
    secondaryButtonText: {
      color: palette.text,
      fontSize: 13.5,
      fontWeight: '600',
      fontFamily: designFonts.sans,
    },
    actionIcon: {
      width: 38,
      height: 38,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.chipBg,
      borderWidth: 1,
      borderColor: palette.border,
    },
    actionAvatar: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.chipBg,
      borderWidth: 1,
      borderColor: palette.border,
      position: 'relative',
    },
    actionAvatarText: {
      color: palette.text,
      fontWeight: '500',
      fontSize: 14,
      fontFamily: designFonts.sans,
    },
    actionPing: {
      position: 'absolute',
      top: -1,
      right: -1,
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: palette.accent,
      borderWidth: 2,
      borderColor: palette.bg,
    },
    actionTextBlock: {
      flex: 1,
      minWidth: 0,
    },
    actionEyebrow: {
      color: palette.accentText,
      fontSize: 9.5,
      letterSpacing: 1,
      textTransform: 'uppercase',
      fontWeight: '700',
      marginBottom: 4,
      fontFamily: designFonts.mono,
    },
    privateActionEyebrow: {
      color: palette.textFaint,
      fontSize: 9.5,
      letterSpacing: 1,
      textTransform: 'uppercase',
      fontWeight: '700',
      marginBottom: 4,
      fontFamily: designFonts.mono,
    },
    actionTitle: {
      color: palette.text,
      fontSize: 14.5,
      fontWeight: '600',
      marginBottom: 2,
      fontFamily: designFonts.sans,
    },
    actionSub: {
      color: palette.textMuted,
      fontSize: 12.5,
      fontFamily: designFonts.sans,
    },
    whisper: {
      marginTop: 24,
      paddingHorizontal: 12,
    },
    whisperRule: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
    },
    whisperDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.textFaint,
    },
    whisperLabel: {
      color: palette.textFaint,
      fontSize: 10,
      letterSpacing: 1,
      textTransform: 'uppercase',
      fontWeight: '700',
      fontFamily: designFonts.mono,
    },
    whisperLine: {
      flex: 1,
      height: 1,
      backgroundColor: palette.divider,
    },
    whisperQuote: {
      color: palette.textMuted,
      fontSize: 17,
      lineHeight: 24,
      fontFamily: designFonts.serifItalic,
    },
  });

const makeProcessDrawerStyles = (palette: ReturnType<typeof useAppAppearance>['palette']) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: 'transparent',
    },
    sheet: {
      backgroundColor: palette.bg,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: palette.border,
      paddingHorizontal: 22,
      paddingTop: 10,
      paddingBottom: 28,
    },
    handle: {
      alignSelf: 'center',
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.divider,
      marginBottom: 22,
    },
    drawerHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      marginBottom: 16,
    },
    drawerTitleBlock: {
      flex: 1,
      minWidth: 0,
    },
    drawerEyebrow: {
      color: palette.accentText,
      fontSize: 10,
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      fontWeight: '700',
      fontFamily: designFonts.mono,
      marginBottom: 8,
    },
    drawerTitle: {
      color: palette.text,
      fontSize: 32,
      lineHeight: 36,
      fontFamily: designFonts.serif,
    },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.chipBg,
      borderWidth: 1,
      borderColor: palette.border,
    },
    intro: {
      color: palette.textMuted,
      fontSize: 15,
      lineHeight: 22,
      fontFamily: designFonts.sans,
      marginBottom: 22,
    },
    steps: {
      gap: 16,
    },
    stepRow: {
      flexDirection: 'row',
      gap: 12,
    },
    stepNumber: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.chipBg,
      borderWidth: 1,
      borderColor: palette.border,
    },
    stepNumberText: {
      color: palette.accentText,
      fontSize: 11,
      fontWeight: '700',
      fontFamily: designFonts.mono,
    },
    stepTextBlock: {
      flex: 1,
      minWidth: 0,
      paddingBottom: 2,
    },
    stepTitle: {
      color: palette.text,
      fontSize: 15,
      lineHeight: 20,
      fontWeight: '700',
      fontFamily: designFonts.sans,
      marginBottom: 4,
    },
    stepBody: {
      color: palette.textMuted,
      fontSize: 14,
      lineHeight: 20,
      fontFamily: designFonts.sans,
    },
  });
