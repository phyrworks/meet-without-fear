/**
 * Shown instead of the app when the backend refuses the signed-in account (GET /auth/me, work-k5fk.35 C4):
 * Clerk says signed in, but there is no user to be, so nothing behind it would work. Says what to do, and
 * offers sign out (to verify the email, or to sign in with the other account).
 */

import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AccountProblem } from '../hooks/useAuthTypes';
import { colors } from '../theme';

export const SUPPORT_EMAIL = 'support@meetwithoutfear.com';

const COPY: Record<AccountProblem, { title: string; body: string }> = {
  EMAIL_NOT_VERIFIED: {
    title: 'Verify your email',
    body:
      "Your account's email address isn't verified yet. Verify your email in your account (check your inbox for " +
      'the verification message), then sign in again.',
  },
  ACCOUNT_LINK_CONFLICT: {
    title: 'This email belongs to another account',
    body: `This email address is already linked to a different Meet Without Fear account. Contact support at ${SUPPORT_EMAIL} and we'll help you get into the right one.`,
  },
};

export function AccountProblemScreen({
  problem,
  onSignOut,
}: {
  problem: AccountProblem;
  onSignOut: () => void | Promise<void>;
}) {
  const copy = COPY[problem];
  return (
    <SafeAreaView style={styles.container} testID={`account-problem-${problem}`}>
      <View style={styles.content}>
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.body}>{copy.body}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => void onSignOut()}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          testID="account-problem-sign-out"
        >
          <Text style={styles.buttonText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPage,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    paddingHorizontal: 32,
    maxWidth: 400,
    alignItems: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 12,
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 32,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
