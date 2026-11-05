/**
 * PreJoinDraftReviewModal (work-99k2)
 *
 * The inviter wrote an empathy draft before their partner joined. Nothing is
 * sent on the join: the next time they open the session after it, they review
 * what they wrote — shown with when they wrote it — and choose:
 *   - Send as is   (consent, after the join)
 *   - Edit first   (back into the draft, with the AI's help)
 *   - Set aside    (discard it and start over from here; confirmed in-page)
 *
 * Shown while GET /empathy/draft reports `preJoinReview`.
 */

import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { appWidthStyle, modalPageStyle, useAppAppearance } from '@/theme';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When the draft was written, as it reads after "Here's what you wrote …":
 * "earlier today", "yesterday", "on Tuesday" (within the last week), else
 * "on Nov 2" (with the year when it is not this year). Local time.
 */
export function formatWrittenAt(writtenAtIso: string, now: Date = new Date()): string {
  const written = new Date(writtenAtIso);
  if (Number.isNaN(written.getTime())) return 'before they joined';
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(written)) / 86_400_000);
  if (days <= 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `on ${WEEKDAYS[written.getDay()]}`;
  const sameYear = written.getFullYear() === now.getFullYear();
  return `on ${MONTHS[written.getMonth()]} ${written.getDate()}${sameYear ? '' : `, ${written.getFullYear()}`}`;
}

/** The prompt's heading: "Jordan has joined. Here's what you wrote on Tuesday." */
export function preJoinReviewHeading(partnerName: string, writtenAtIso: string, now?: Date): string {
  return `${partnerName} has joined. Here's what you wrote ${formatWrittenAt(writtenAtIso, now)}.`;
}

export interface PreJoinDraftReviewModalProps {
  visible: boolean;
  partnerName: string;
  /** The draft's written-at (ISO), from `preJoinReview.writtenAt`. */
  writtenAt: string;
  statement: string;
  /** Disable the actions while one is in flight. */
  busy?: boolean;
  onSendAsIs: () => void;
  onEditFirst: () => void;
  onSetAside: () => void;
  /** For tests: the clock the date is read against. */
  now?: Date;
}

export function PreJoinDraftReviewModal({
  visible,
  partnerName,
  writtenAt,
  statement,
  busy = false,
  onSendAsIs,
  onEditFirst,
  onSetAside,
  now,
}: PreJoinDraftReviewModalProps) {
  const { palette } = useAppAppearance();
  const styles = makeStyles(palette);
  const [confirmingSetAside, setConfirmingSetAside] = useState(false);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" testID="pre-join-review-modal">
      <SafeAreaProvider>
        <View style={styles.modalPage}>
          <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <Text style={styles.title} testID="pre-join-review-heading">
                {preJoinReviewHeading(partnerName, writtenAt, now)}
              </Text>
              <Text style={styles.subtitle}>
                Nothing has been sent. Read it through with fresh eyes, then decide what to do with it.
              </Text>
              <View style={styles.messageContainer}>
                <Text style={styles.messageText} testID="pre-join-review-statement">
                  {statement}
                </Text>
              </View>

              {confirmingSetAside ? (
                <View style={styles.confirmBox} testID="pre-join-review-confirm-set-aside">
                  <Text style={styles.confirmText}>
                    Set this draft aside? It will be discarded, and you'll start again from where you are now.
                  </Text>
                  <View style={styles.row}>
                    <TouchableOpacity
                      style={styles.secondaryButton}
                      onPress={() => setConfirmingSetAside(false)}
                      disabled={busy}
                      testID="pre-join-review-keep-button"
                    >
                      <Text style={styles.secondaryButtonText}>Keep it</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.dangerButton}
                      onPress={onSetAside}
                      disabled={busy}
                      testID="pre-join-review-confirm-set-aside-button"
                    >
                      <Text style={styles.primaryButtonText}>Set it aside</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={onSendAsIs}
                    disabled={busy}
                    testID="pre-join-review-send-button"
                  >
                    <Text style={styles.primaryButtonText}>Send as is</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={onEditFirst}
                    disabled={busy}
                    testID="pre-join-review-edit-button"
                  >
                    <Text style={styles.secondaryButtonText}>Edit first</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.linkButton}
                    onPress={() => setConfirmingSetAside(true)}
                    disabled={busy}
                    testID="pre-join-review-set-aside-button"
                  >
                    <Text style={styles.linkButtonText}>Set aside</Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

const makeStyles = (palette: ReturnType<typeof useAppAppearance>['palette']) =>
  StyleSheet.create({
    modalPage: { ...modalPageStyle },
    container: { flex: 1, backgroundColor: palette.bg, ...appWidthStyle },
    scrollContent: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 24 },
    title: {
      fontSize: 24,
      fontWeight: '700',
      color: palette.text,
      textAlign: 'center',
      marginBottom: 12,
      lineHeight: 32,
    },
    subtitle: { fontSize: 16, color: palette.textMuted, textAlign: 'center', lineHeight: 24, marginBottom: 24 },
    messageContainer: {
      backgroundColor: palette.bgElev,
      borderRadius: 12,
      borderLeftWidth: 3,
      borderLeftColor: palette.info,
      padding: 20,
      marginBottom: 32,
    },
    messageText: { fontSize: 17, fontStyle: 'italic', color: palette.text, lineHeight: 26 },
    actions: { gap: 12 },
    row: { flexDirection: 'row', gap: 12 },
    primaryButton: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.accent,
      borderRadius: 24,
      paddingVertical: 16,
      paddingHorizontal: 20,
    },
    primaryButtonText: { fontSize: 15, fontWeight: '600', color: palette.bg },
    secondaryButton: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.bgElev,
      borderRadius: 24,
      paddingVertical: 16,
      paddingHorizontal: 20,
    },
    secondaryButtonText: { fontSize: 15, fontWeight: '600', color: palette.text },
    dangerButton: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.danger,
      borderRadius: 24,
      paddingVertical: 16,
      paddingHorizontal: 20,
    },
    linkButton: { alignItems: 'center', paddingVertical: 12 },
    linkButtonText: { fontSize: 15, fontWeight: '600', color: palette.textMuted },
    confirmBox: { backgroundColor: palette.bgElev, borderRadius: 16, padding: 16, gap: 16 },
    confirmText: { fontSize: 15, lineHeight: 22, color: palette.text, textAlign: 'center' },
  });
