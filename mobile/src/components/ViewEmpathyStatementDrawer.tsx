/**
 * ViewEmpathyStatementDrawer Component
 *
 * A scrollable drawer that displays the full empathy statement.
 * Users can tap to open this drawer and see the complete text.
 * Two actions: Share (sends to partner) or Refine Further (open inline composer).
 */

import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { X, Send, MessageCircle } from 'lucide-react-native';
import { appWidthStyle, modalPageStyle, useAppAppearance } from '@/theme';

export interface ViewEmpathyStatementDrawerProps {
  /** Whether the drawer is visible */
  visible: boolean;
  /** The empathy statement content */
  statement: string;
  /** Partner's name */
  partnerName?: string;
  /** Whether user is revising after receiving shared context from partner */
  isRevising?: boolean;
  /**
   * work-99k2: the partner has been invited but has not joined. The draft is
   * saved; sharing (consent) waits for the join, so Share is replaced by an
   * explanation and "Keep for later" (which only closes the drawer).
   */
  awaitingPartner?: boolean;
  /** Callback when "Share" is tapped */
  onShare: () => void;
  /** Callback when drawer is closed */
  onClose: () => void;
  /** Callback when user sends a refinement request from the drawer */
  onSendRefinement?: (message: string) => void;
}

/** The Share step's explanation while the partner has not joined (work-99k2). */
export function awaitingPartnerNote(partnerName: string): string {
  return `${partnerName} hasn't joined yet. Your draft is saved, and you can share it once ${partnerName} joins. You'll get to look it over again first.`;
}

export function ViewEmpathyStatementDrawer({
  visible,
  statement,
  partnerName = 'your partner',
  isRevising = false,
  awaitingPartner = false,
  onShare,
  onClose,
  onSendRefinement,
}: ViewEmpathyStatementDrawerProps) {
  const { palette } = useAppAppearance();
  const styles = makeStyles(palette);
  const [isRefining, setIsRefining] = useState(false);
  const [refinementText, setRefinementText] = useState('');
  const scrollViewRef = useRef<ScrollView>(null);

  // When the refinement composer opens (and keyboard comes up), ensure we scroll the input into view.
  useEffect(() => {
    if (!isRefining) return;

    // Run a couple times to handle layout + keyboard timing differences across iOS/Android.
    const raf = requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    });
    const t = setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 150);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [isRefining]);

  const handleSendRefinement = () => {
    const trimmed = refinementText.trim();
    if (!trimmed) return;

    onSendRefinement?.(trimmed);
    setRefinementText('');
    setIsRefining(false);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      testID="view-empathy-statement-drawer"
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
        <View style={styles.modalPage}>
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
          <KeyboardAvoidingView
            style={styles.keyboardAvoid}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={0}
          >
          {/* Header with close button */}
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              testID="view-empathy-close"
              accessibilityLabel="Close"
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            >
              <X color={palette.textMuted} size={24} />
            </TouchableOpacity>
          </View>

          {/* Scrollable content - entire drawer scrolls */}
          <ScrollView
            ref={scrollViewRef}
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={true}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.title}>
              {isRevising ? 'Revisit your understanding' : 'What you\'ll share'}
            </Text>
            <Text style={styles.subtitle}>
              {isRevising
                ? `${partnerName} shared some additional context to help you understand their experience better. Take a moment to consider if you'd like to update what you'll share with them.`
                : awaitingPartner
                  ? `This is what you'd share with ${partnerName} to show you understand their perspective.`
                  : `This is what you'll share with ${partnerName} to show you understand their perspective.`}
            </Text>

            {/* Empathy statement - styled subtly */}
            <View style={styles.messageContainer}>
              <Text style={styles.messageText}>{statement}</Text>
            </View>

            {isRefining ? (
              <View style={styles.refineComposer}>
                <View style={styles.refineComposerHeader}>
                  <Text style={styles.refineComposerTitle}>How would you like to tweak this?</Text>
                  <TouchableOpacity
                    onPress={() => {
                      setIsRefining(false);
                      setRefinementText('');
                    }}
                    accessibilityLabel="Close refinement"
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    testID="close-refine-composer"
                  >
                    <X color={palette.textMuted} size={20} />
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={styles.refineInput}
                  multiline
                  placeholder="Tell the AI what to change or add..."
                  placeholderTextColor={palette.textFaint}
                  value={refinementText}
                  onChangeText={setRefinementText}
                  autoFocus
                  onFocus={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
                  testID="refine-empathy-input"
                />
                <TouchableOpacity
                  style={[
                    styles.sendRefineButton,
                    !refinementText.trim() && styles.sendRefineButtonDisabled,
                  ]}
                  onPress={handleSendRefinement}
                  disabled={!refinementText.trim()}
                  activeOpacity={0.8}
                  testID="send-refine-empathy-button"
                >
                  <Send color={refinementText.trim() ? palette.bg : palette.textFaint} size={20} />
                  <Text
                    style={[
                      styles.sendRefineButtonText,
                      !refinementText.trim() && styles.sendRefineButtonTextDisabled,
                    ]}
                  >
                    Send and update
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.footer}>
                {awaitingPartner && !isRevising && (
                  <Text style={styles.awaitingPartnerNote} testID="empathy-share-after-join-note">
                    {awaitingPartnerNote(partnerName)}
                  </Text>
                )}
                <View style={styles.actionButtons}>
                  {onSendRefinement && (
                    <TouchableOpacity
                      style={styles.refineButton}
                      onPress={() => setIsRefining(true)}
                      testID="refine-empathy-button"
                      activeOpacity={0.8}
                    >
                      <MessageCircle color={palette.textMuted} size={20} />
                      <Text style={styles.refineButtonText}>Refine further</Text>
                    </TouchableOpacity>
                  )}
                  {awaitingPartner && !isRevising ? (
                    <TouchableOpacity
                      style={styles.shareButton}
                      onPress={onClose}
                      testID="empathy-keep-for-later-button"
                      activeOpacity={0.8}
                    >
                      <Text style={styles.shareButtonText}>Keep for later</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={styles.shareButton}
                      onPress={onShare}
                      testID="share-empathy-button"
                      activeOpacity={0.8}
                    >
                      <Send color={palette.bg} size={20} />
                      <Text style={styles.shareButtonText}>{isRevising ? 'Resubmit' : 'Share'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
          </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

const makeStyles = (palette: ReturnType<typeof useAppAppearance>['palette']) => StyleSheet.create({
  modalPage: {
    ...modalPageStyle,
  },
  container: {
    flex: 1,
    backgroundColor: palette.bg,
    ...appWidthStyle,
  },
  keyboardAvoid: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  closeButton: {
    padding: 12,
    backgroundColor: palette.bgElev,
    borderRadius: 20,
  },
  scrollView: {
    flex: 1,
  },
  awaitingPartnerNote: {
    fontSize: 15,
    lineHeight: 22,
    color: palette.textMuted,
    textAlign: 'center',
    marginBottom: 16,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: palette.text,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 36,
  },
  subtitle: {
    fontSize: 16,
    color: palette.textMuted,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  messageContainer: {
    backgroundColor: palette.bgElev,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: palette.info,
    padding: 20,
    marginBottom: 32,
  },
  messageText: {
    fontSize: 17,
    fontStyle: 'italic',
    color: palette.text,
    lineHeight: 26,
  },
  footer: {
    flexDirection: 'column',
    gap: 0,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  refineComposer: {
    backgroundColor: palette.bgElev,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  refineComposerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  refineComposerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: palette.text,
    flex: 1,
    marginRight: 12,
  },
  refineInput: {
    minHeight: 100,
    backgroundColor: palette.bg,
    borderRadius: 12,
    padding: 12,
    color: palette.text,
    fontSize: 15,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: palette.border,
  },
  sendRefineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accent,
    borderRadius: 24,
    paddingVertical: 14,
    paddingHorizontal: 18,
    gap: 8,
  },
  sendRefineButtonDisabled: {
    backgroundColor: palette.bgElev,
  },
  sendRefineButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: palette.bg,
  },
  sendRefineButtonTextDisabled: {
    color: palette.textFaint,
  },
  refineButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.bgElev,
    borderRadius: 24,
    paddingVertical: 16,
    paddingHorizontal: 20,
    gap: 8,
  },
  refineButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: palette.textMuted,
  },
  shareButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accent,
    borderRadius: 24,
    paddingVertical: 16,
    paddingHorizontal: 20,
    gap: 8,
  },
  shareButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: palette.bg,
  },
});

export default ViewEmpathyStatementDrawer;
