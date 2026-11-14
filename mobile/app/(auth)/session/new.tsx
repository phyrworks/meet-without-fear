/**
 * New Session Screen
 *
 * Form to create a session by either:
 * 1. Picking an existing person from your relationships
 * 2. Entering a new person's name
 *
 * After creation, navigates directly to the session where the AI
 * will help craft an invitation message.
 *
 * If innerThoughtsId is provided (from Inner Thoughts flow), fetches context
 * and pre-fills the partner name if available.
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Send, User, UserPlus, Check, Layers } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCreateSession } from '@/src/hooks/useSessions';
import { dedupePeople, usePeople } from '@/src/hooks/usePerson';
import { useGenerateContext } from '@/src/hooks/useInnerThoughts';
import { NotificationPermissionDrawer } from '@/src/components/NotificationPermissionDrawer';
import { useAppAppearance } from '@/src/theme';
import { trackSessionCreated, trackPersonSelected } from '@/src/services/analytics';
import {
  getNotificationPermissionStatus,
  requestAndRegisterForPushNotifications,
} from '@/src/services/notifications';
import type { PersonSummaryDTO, GenerateContextResponse } from '@meet-without-fear/shared';

// ============================================================================
// Component
// ============================================================================

export default function NewSessionScreen() {
  const router = useRouter();
  const { palette } = useAppAppearance();
  const styles = useStyles();
  const { partnerId, partnerName, innerThoughtsId, linkedAtMessageId } = useLocalSearchParams<{
    partnerId?: string;
    partnerName?: string;
    innerThoughtsId?: string;
    linkedAtMessageId?: string;
  }>();

  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [selectedPerson, setSelectedPerson] = useState<PersonSummaryDTO | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [innerThoughtsContext, setInnerThoughtsContext] = useState<GenerateContextResponse | null>(null);
  const hasPreFilledPartnerName = useRef(false);
  const [showNotificationDrawer, setShowNotificationDrawer] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<(() => Promise<void>) | null>(null);

  const { data: rawPeople = [], isLoading: peopleLoading } = usePeople();
  const people = useMemo(() => dedupePeople(rawPeople), [rawPeople]);
  const { mutateAsync: createSession, isPending } = useCreateSession();
  const { mutateAsync: generateContext, isPending: isGeneratingContext } = useGenerateContext();

  // Generate context from Inner Thoughts session if linked
  useEffect(() => {
    if (innerThoughtsId && !innerThoughtsContext) {
      generateContext({ sessionId: innerThoughtsId })
        .then((context) => {
          setInnerThoughtsContext(context);
          // Pre-fill partner name if available and no name was passed as param
          if (context.personName && !partnerName) {
            const nameParts = context.personName.split(' ');
            setFirstName(nameParts[0] || '');
            setLastName(nameParts.slice(1).join(' ') || '');
            setMode('new'); // Switch to new person mode since we have a name
          }
        })
        .catch((err) => {
          console.error('Failed to generate context from Inner Thoughts:', err);
        });
    }
  }, [innerThoughtsId, innerThoughtsContext, generateContext, partnerName]);

  // Pre-fill partner name from query params (from InnerThoughtsScreen navigation)
  useEffect(() => {
    if (partnerName && !hasPreFilledPartnerName.current) {
      hasPreFilledPartnerName.current = true;
      const nameParts = partnerName.split(' ');
      setFirstName(nameParts[0] || '');
      setLastName(nameParts.slice(1).join(' ') || '');
      setMode('new'); // Switch to new person mode since we have a name
    }
  }, [partnerName]);

  // Pre-select an existing person when launched from their detail screen.
  useEffect(() => {
    if (!partnerId || selectedPerson) {
      return;
    }

    const person = people.find((p) => p.id === partnerId);
    if (person) {
      setSelectedPerson(person);
      setMode('pick');
    }
  }, [partnerId, people, selectedPerson]);

  // Determine if we have people to pick from
  const hasPeople = people.length > 0;

  // Effective mode: if no people exist, treat as 'new' regardless of state
  const effectiveMode = hasPeople ? mode : 'new';

  const createSessionFromForm = async (forceCreate = false) => {
    // Build optional context and innerThoughtsId for session creation
    const context = innerThoughtsContext?.contextSummary;
    const linkedInnerThoughtsId = innerThoughtsId;

    if (effectiveMode === 'pick' && selectedPerson) {
      // Track person selection
      trackPersonSelected(selectedPerson.id, false);

      try {
        const response = await createSession({
          personId: selectedPerson.id,
          ...(context && { context }),
          ...(linkedInnerThoughtsId && { innerThoughtsId: linkedInnerThoughtsId }),
          ...(linkedAtMessageId && { linkedAtMessageId }),
          ...(forceCreate && { forceCreate: true }),
        });
        // Handle existing active session response
        if ('existingActiveSession' in response) {
          const existing = (response as { existingActiveSession: { id: string; status: string } }).existingActiveSession;
          Alert.alert(
            `Active session with ${selectedPerson.name}`,
            'You already have an active session with this person.',
            [
              {
                text: 'Continue Existing',
                onPress: () => router.replace(`/session/${existing.id}`),
              },
              {
                text: 'Start New Anyway',
                style: 'default',
                onPress: () => {
                  void createSessionFromForm(true);
                },
              },
            ]
          );
          return;
        }
        // Track session creation
        trackSessionCreated(response.session.id, selectedPerson.id);
        router.replace(
          linkedInnerThoughtsId
            ? `/session/${response.session.id}?fromInnerThoughtsCreate=1`
            : `/session/${response.session.id}`
        );
      } catch (error) {
        console.error('Failed to create session:', error);
        Alert.alert('Error', 'Failed to create session. Please try again.');
      }
    } else if (effectiveMode === 'new') {
      if (!firstName.trim()) {
        Alert.alert('Name Required', 'Please enter their first name');
        return;
      }

      const inviteName = lastName.trim()
        ? `${firstName.trim()} ${lastName.trim()}`
        : firstName.trim();

      try {
        const response = await createSession({
          inviteName,
          ...(context && { context }),
          ...(linkedInnerThoughtsId && { innerThoughtsId: linkedInnerThoughtsId }),
          ...(linkedAtMessageId && { linkedAtMessageId }),
        });
        // Track person selection (new person) and session creation
        // A new person has no user id until they accept (work-k5fk.2: no relationship id either)
        trackPersonSelected(response.session.partner?.id || '', true);
        trackSessionCreated(response.session.id);
        router.replace(
          linkedInnerThoughtsId
            ? `/session/${response.session.id}?fromInnerThoughtsCreate=1`
            : `/session/${response.session.id}`
        );
      } catch (error) {
        console.error('Failed to create session:', error);
        Alert.alert('Error', 'Failed to create session. Please try again.');
      }
    }
  };

  const handleSubmit = async () => {
    try {
      if ((await getNotificationPermissionStatus()) === 'undetermined') {
        setPendingSubmit(() => createSessionFromForm);
        setShowNotificationDrawer(true);
        return;
      }
    } catch (error) {
      console.warn('Failed to check notification permission:', error);
    }

    await createSessionFromForm();
  };

  const continueAfterNotificationChoice = async () => {
    const submit = pendingSubmit;
    setPendingSubmit(null);
    setShowNotificationDrawer(false);
    if (submit) {
      await submit();
    }
  };

  const handleEnableNotifications = async () => {
    setNotificationLoading(true);
    try {
      await requestAndRegisterForPushNotifications();
    } finally {
      setNotificationLoading(false);
    }
    await continueAfterNotificationChoice();
  };

  const canSubmit = effectiveMode === 'pick' ? !!selectedPerson : !!firstName.trim();

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <NotificationPermissionDrawer
        visible={showNotificationDrawer}
        loading={notificationLoading}
        onEnable={handleEnableNotifications}
        onSkip={continueAfterNotificationChoice}
      />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.form}>
            <Text style={styles.heading}>Who do you want to connect with?</Text>
            <Text style={styles.subheading}>
              {hasPeople
                ? 'Pick someone you know or add a new person.'
                : "Enter their name and we'll create a session."}
            </Text>

            {/* Inner Thoughts Context Banner - show when linked from Inner Thoughts */}
            {innerThoughtsId && (
              <View style={styles.contextBanner}>
                <View style={styles.contextBannerHeader}>
                  <Layers size={16} color={palette.accent} />
                  <Text style={styles.contextBannerTitle}>From Inner Thoughts</Text>
                </View>
                {isGeneratingContext ? (
                  <View style={styles.contextLoading}>
                    <ActivityIndicator size="small" color={palette.accent} />
                    <Text style={styles.contextLoadingText}>Preparing context...</Text>
                  </View>
                ) : innerThoughtsContext ? (
                  <Text style={styles.contextBannerText} numberOfLines={3}>
                    {innerThoughtsContext.contextSummary}
                  </Text>
                ) : null}
              </View>
            )}

            {/* Mode Tabs - only show if there are existing people */}
            {hasPeople && (
              <View style={styles.tabs}>
                <TouchableOpacity
                  style={[styles.tab, mode === 'pick' && styles.tabActive]}
                  onPress={() => setMode('pick')}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mode === 'pick' }}
                >
                  <User
                    size={18}
                    color={mode === 'pick' ? palette.accent : palette.textMuted}
                  />
                  <Text
                    style={[styles.tabText, mode === 'pick' && styles.tabTextActive]}
                  >
                    Pick Someone
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tab, mode === 'new' && styles.tabActive]}
                  onPress={() => setMode('new')}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mode === 'new' }}
                >
                  <UserPlus
                    size={18}
                    color={mode === 'new' ? palette.accent : palette.textMuted}
                  />
                  <Text
                    style={[styles.tabText, mode === 'new' && styles.tabTextActive]}
                  >
                    New Person
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* People Picker */}
            {effectiveMode === 'pick' && hasPeople && (
              <View style={styles.peopleList}>
                {peopleLoading ? (
                  <ActivityIndicator color={palette.accent} />
                ) : (
                  people.map((person) => (
                    <TouchableOpacity
                      key={person.id}
                      style={[
                        styles.personCard,
                        selectedPerson?.id === person.id && styles.personCardSelected,
                      ]}
                      onPress={() => setSelectedPerson(person)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selectedPerson?.id === person.id }}
                    >
                      <View style={styles.personAvatar}>
                        <Text style={styles.personAvatarText}>{person.initials}</Text>
                      </View>
                      <View style={styles.personInfo}>
                        <View style={styles.personNameRow}>
                          <Text style={styles.personName}>{person.name}</Text>
                          {person.activeSessionCount > 0 && (
                            <View style={styles.activeBadge}>
                              <Text style={styles.activeBadgeText}>Active</Text>
                            </View>
                          )}
                        </View>
                        {person.lastSession && (
                          <Text style={styles.personMeta}>
                            Last session: {formatRelativeTime(person.lastSession.updatedAt)}
                          </Text>
                        )}
                      </View>
                      {selectedPerson?.id === person.id && (
                        <View style={styles.checkIcon}>
                          <Check size={20} color={palette.accent} />
                        </View>
                      )}
                    </TouchableOpacity>
                  ))
                )}
              </View>
            )}

            {/* Active Session Warning */}
            {effectiveMode === 'pick' && selectedPerson && selectedPerson.activeSessionCount > 0 && (
              <View style={styles.activeWarningBanner}>
                <Text style={styles.activeWarningText}>
                  You have an active session with {selectedPerson.name}
                </Text>
                <TouchableOpacity
                  style={styles.continueExistingButton}
                  onPress={() => {
                    if (selectedPerson.lastSession) {
                      router.replace(`/session/${selectedPerson.lastSession.id}`);
                    }
                  }}
                >
                  <Text style={styles.continueExistingButtonText}>Continue Existing Session</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* New Person Form */}
            {effectiveMode === 'new' && (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>First Name *</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter their first name"
                    placeholderTextColor={palette.textFaint}
                    value={firstName}
                    onChangeText={setFirstName}
                    autoCapitalize="words"
                    autoCorrect={false}
                    maxLength={50}
                    returnKeyType="next"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Last Name (optional)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter their last name"
                    placeholderTextColor={palette.textFaint}
                    value={lastName}
                    onChangeText={setLastName}
                    autoCapitalize="words"
                    autoCorrect={false}
                    maxLength={50}
                    returnKeyType="done"
                    onSubmitEditing={handleSubmit}
                  />
                </View>
              </>
            )}
          </View>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[
                styles.submitButton,
                (!canSubmit || isPending) && styles.submitButtonDisabled,
              ]}
              onPress={handleSubmit}
              disabled={!canSubmit || isPending}
              accessibilityRole="button"
              accessibilityLabel="Create session"
            >
              {isPending ? (
                <ActivityIndicator color={palette.bg} size="small" />
              ) : (
                <>
                  <Text style={styles.submitButtonText}>Create Session</Text>
                  <Send color={palette.bg} size={20} />
                </>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${diffWeeks}w ago`;
}

// ============================================================================
// Styles
// ============================================================================

const useStyles = () => {
  const { palette } = useAppAppearance();

  return useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: palette.bg,
    },
    keyboardView: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      flexGrow: 1,
      justifyContent: 'space-between',
    },
    form: {
      padding: 16,
      gap: 20,
    },
    heading: {
      fontSize: 24,
      fontWeight: '700',
      color: palette.text,
      marginBottom: 4,
    },
    subheading: {
      fontSize: 16,
      color: palette.textMuted,
      lineHeight: 24,
      marginBottom: 8,
    },
    // Tabs
    tabs: {
      flexDirection: 'row',
      backgroundColor: palette.chipBg,
      borderRadius: 12,
      padding: 4,
    },
    tab: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 8,
      gap: 8,
    },
    tabActive: {
      backgroundColor: palette.bgElev,
    },
    tabText: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.textMuted,
    },
    tabTextActive: {
      color: palette.accent,
    },
    // People list
    peopleList: {
      gap: 12,
    },
    personCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: palette.bgElev,
      borderRadius: 12,
      padding: 12,
      borderWidth: 2,
      borderColor: palette.border,
    },
    personCardSelected: {
      borderColor: palette.accent,
      backgroundColor: palette.accentSoft,
    },
    personAvatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: palette.chipBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    personAvatarText: {
      fontSize: 16,
      fontWeight: '600',
      color: palette.text,
    },
    personInfo: {
      flex: 1,
      marginLeft: 12,
    },
    personNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    personName: {
      fontSize: 17,
      fontWeight: '600',
      color: palette.text,
    },
    activeBadge: {
      backgroundColor: palette.accentSoft,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 8,
    },
    activeBadgeText: {
      fontSize: 11,
      fontWeight: '600',
      color: palette.accentText,
    },
    personMeta: {
      fontSize: 13,
      color: palette.textMuted,
      marginTop: 2,
    },
    checkIcon: {
      marginLeft: 8,
    },
    activeWarningBanner: {
      backgroundColor: palette.warningSoft,
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: palette.borderStrong,
      gap: 12,
    },
    activeWarningText: {
      fontSize: 15,
      color: palette.textMuted,
      lineHeight: 22,
    },
    continueExistingButton: {
      backgroundColor: palette.accent,
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 16,
      alignItems: 'center',
    },
    continueExistingButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.bg,
    },
    // Input group
    inputGroup: {
      gap: 8,
    },
    label: {
      fontSize: 15,
      fontWeight: '600',
      color: palette.textMuted,
    },
    input: {
      backgroundColor: palette.bgElev,
      borderRadius: 12,
      padding: 16,
      fontSize: 17,
      borderWidth: 1,
      borderColor: palette.border,
      color: palette.text,
    },
    footer: {
      padding: 16,
      paddingBottom: 24,
    },
    submitButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.accent,
      borderRadius: 12,
      padding: 16,
      gap: 8,
    },
    submitButtonDisabled: {
      backgroundColor: palette.chipBg,
    },
    submitButtonText: {
      fontSize: 17,
      fontWeight: '600',
      color: palette.bg,
    },
    // Context banner (from Inner Thoughts)
    contextBanner: {
      backgroundColor: palette.accentSoft,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: palette.borderStrong,
    },
    contextBannerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    contextBannerTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: palette.accentText,
    },
    contextBannerText: {
      fontSize: 14,
      color: palette.textMuted,
      lineHeight: 20,
    },
    contextLoading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    contextLoadingText: {
      fontSize: 13,
      color: palette.textFaint,
    },
  }), [palette]);
};
