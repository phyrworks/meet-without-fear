import { Stack, Redirect } from 'expo-router';
import { useAuth as useClerkAuth } from '@clerk/clerk-expo';
import { useAppAppearance } from '@/src/theme';
import { useUserSessionUpdates } from '@/src/hooks/useRealtime';
import { isE2EMode } from '@/src/providers/E2EAuthProvider';
import { useNotifications } from '@/src/hooks/useNotifications';
import { BiometricLockProvider } from '@/src/contexts/BiometricLockContext';
import { BiometricLockOverlay } from '@/src/components/BiometricLockOverlay';
import { AccountProblemScreen } from '@/src/components/AccountProblemScreen';
import { useAuth } from '@/src/hooks/useAuthTypes';

/**
 * Auth group layout
 * Uses Clerk as the single source of truth for authentication.
 * If Clerk says signed in, we're in. No double-checking with backend.
 * Pending invitations are now handled by the home screen (not auto-accepted).
 */
export default function AuthLayout() {
  const { isSignedIn, isLoaded } = useClerkAuth();
  const { accountProblem, signOut } = useAuth();
  const { palette } = useAppAppearance();

  // Subscribe to user-level session updates for real-time list refreshes
  // This is placed here (not in individual screens) to ensure only ONE Ably connection
  // Skip in E2E mode to avoid token/capability cache issues with the user notification channel
  useUserSessionUpdates({ enabled: !isE2EMode() });
  useNotifications();

  // Wait for Clerk to initialize
  if (!isLoaded) {
    return null;
  }

  // If Clerk says not signed in, redirect to public
  if (!isSignedIn) {
    return <Redirect href="/(public)" />;
  }

  // Signed in, but the backend refused the account (work-k5fk.35 C4): say what to do instead of the app
  if (accountProblem) {
    return <AccountProblemScreen problem={accountProblem} onSignOut={signOut} />;
  }

  // Render the app - backend profile sync happens in useAuth hook
  return (
    <BiometricLockProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: false,
          headerStyle: {
            backgroundColor: palette.bg,
          },
          headerTintColor: palette.text,
          headerTitleStyle: {
            color: palette.text,
          },
          contentStyle: {
            backgroundColor: palette.bg,
          },
        }}
      >
        {/* Main screens (Home, Settings) */}
        <Stack.Screen
          name="(tabs)"
          options={{
            animationTypeForReplace: 'pop',
          }}
        />

        {/* Inner Work - animation is handled at the screen level */}
        <Stack.Screen
          name="inner-work"
          options={{
            animation: 'slide_from_right',
            gestureEnabled: true,
          }}
        />

        {/* Settings - slide from right */}
        <Stack.Screen
          name="settings"
          options={{
            animation: 'slide_from_right',
            gestureEnabled: true,
          }}
        />

        {/* Session flow screens */}
        <Stack.Screen name="design-system" />
        <Stack.Screen
          name="session/new"
          options={{
            presentation: 'modal',
            headerShown: true,
            title: 'New Session',
            gestureEnabled: true,
          }}
        />
        <Stack.Screen
          name="session/[id]"
          options={{
            gestureEnabled: true,
          }}
        />

        {/* Person detail */}
        <Stack.Screen
          name="person/[id]"
          options={{
            headerShown: true,
            title: 'Person',
            gestureEnabled: true,
          }}
        />
      </Stack>
      <BiometricLockOverlay />
    </BiometricLockProvider>
  );
}
