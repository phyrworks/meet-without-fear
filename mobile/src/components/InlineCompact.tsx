/**
 * InlineCompact Component
 *
 * An inline version of the opening welcome for embedding in the chat interface
 * as an AI-triggered action. Shows a warm AI message with a "Ready" button.
 */

import { useMemo } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { radius, spacing, typography, useAppAppearance } from '../theme';

// ============================================================================
// Types
// ============================================================================

interface InlineCompactProps {
  /** Callback when user taps Ready */
  onSign: () => void;
  /** Whether signing is in progress */
  isPending?: boolean;
  /** Whether this is the first session of these two people */
  isFirstSession?: boolean;
  /** Test ID for testing */
  testID?: string;
}

// ============================================================================
// Constants
// ============================================================================

const FIRST_SESSION_TEXT =
  "I am here to help you work through conflict\u2014step by step.\n\nYou'll start by sharing what you believe is happening, privately.\n\nI don't share anything unless you approve it, ever.";

const REPEAT_SESSION_TEXT =
  "Welcome back. Same as before \u2014 your space is private, nothing shared without your say. Let's pick up where we left off.";

// ============================================================================
// Component
// ============================================================================

export function InlineCompact({
  onSign,
  isPending = false,
  isFirstSession = true,
  testID = 'inline-compact',
}: InlineCompactProps) {
  const styles = useStyles();

  const messageText = isFirstSession ? FIRST_SESSION_TEXT : REPEAT_SESSION_TEXT;

  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.messageText}>{messageText}</Text>

      <TouchableOpacity
        testID={`${testID}-sign-button`}
        style={[styles.readyButton, isPending && styles.readyButtonDisabled]}
        onPress={onSign}
        disabled={isPending}
        accessibilityRole="button"
        accessibilityState={{ disabled: isPending }}
      >
        <Text style={styles.readyButtonText}>
          {isPending ? '...' : isFirstSession ? 'Ready' : "Let's go"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const useStyles = () => {
  const { palette } = useAppAppearance();

  return useMemo(() => StyleSheet.create({
    container: {
      backgroundColor: palette.bgElev,
      borderRadius: radius.lg,
      padding: spacing.xl,
      marginVertical: spacing.md,
      borderWidth: 1,
      borderColor: palette.border,
    },
    messageText: {
      fontSize: typography.fontSize.md,
      lineHeight: 22,
      color: palette.text,
      marginBottom: spacing.lg,
    },
    readyButton: {
      backgroundColor: palette.accent,
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.xl,
      borderRadius: radius.sm,
      alignItems: 'center',
    },
    readyButtonDisabled: {
      backgroundColor: palette.chipBg,
    },
    readyButtonText: {
      color: palette.bg,
      fontSize: typography.fontSize.md,
      fontWeight: '600',
    },
  }), [palette]);
};
