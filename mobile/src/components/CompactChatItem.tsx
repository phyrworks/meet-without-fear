/**
 * CompactChatItem Component
 *
 * Displays a brief, warm AI opening message during onboarding.
 * Replaces the formal Curiosity Compact terms with a conversational welcome.
 */

import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { TypewriterText } from './TypewriterText';
import { spacing, typography, useAppAppearance } from '../theme';

// ============================================================================
// Types
// ============================================================================

interface CompactChatItemProps {
  testID?: string;
  /** Whether this is the first session of these two people */
  isFirstSession?: boolean;
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

export function CompactChatItem({ testID, isFirstSession = true }: CompactChatItemProps) {
  const styles = useStyles();

  const messageText = isFirstSession ? FIRST_SESSION_TEXT : REPEAT_SESSION_TEXT;

  return (
    <View style={styles.container} testID={testID || 'compact-chat-item'}>
      <View style={styles.messageContainer}>
        <TypewriterText
          text={messageText}
          style={styles.messageText}
        />
      </View>
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
      paddingTop: spacing.lg,
      paddingBottom: spacing.md,
    },
    messageContainer: {
      marginVertical: spacing.xs,
      paddingHorizontal: spacing.lg,
    },
    messageText: {
      fontSize: typography.fontSize.md,
      lineHeight: 22,
      color: palette.text,
      fontFamily: typography.fontFamily.regular,
    },
  }), [palette]);
};

export default CompactChatItem;
