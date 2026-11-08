/**
 * Whether the app is in the foreground and its page visible (work-2doq).
 *
 * "Shown on screen" for the Seen line must not fire from a backgrounded app
 * (Android keeps JS — and Ably — alive, and a context_received action
 * refetches messages) or a hidden browser tab. Native: AppState 'active'.
 * Web: also document.visibilityState 'visible'.
 */

import { useEffect, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

/** Pure predicate. `visibilityState` is undefined off web. */
export function isAppForeground(
  appState: AppStateStatus | null | undefined,
  visibilityState: DocumentVisibilityState | undefined,
): boolean {
  if (appState != null && appState !== 'active') return false;
  if (visibilityState !== undefined && visibilityState !== 'visible') return false;
  return true;
}

function currentVisibility(): DocumentVisibilityState | undefined {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
  return document.visibilityState;
}

export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(() =>
    isAppForeground(AppState.currentState, currentVisibility()),
  );

  useEffect(() => {
    let appState: AppStateStatus | null | undefined = AppState.currentState;
    const update = () => setForeground(isAppForeground(appState, currentVisibility()));
    const subscription = AppState.addEventListener('change', (next) => {
      appState = next;
      update();
    });
    const onVisibility = () => update();
    const hasDocument = Platform.OS === 'web' && typeof document !== 'undefined';
    if (hasDocument) document.addEventListener('visibilitychange', onVisibility);
    update();
    return () => {
      subscription.remove();
      if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return foreground;
}
