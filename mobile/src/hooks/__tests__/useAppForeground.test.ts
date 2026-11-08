import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { isAppForeground, useAppForeground } from '../useAppForeground';

describe('isAppForeground', () => {
  it('is true only when the app is active and (on web) the page visible', () => {
    expect(isAppForeground('active', undefined)).toBe(true);
    expect(isAppForeground('active', 'visible')).toBe(true);
    expect(isAppForeground('background', undefined)).toBe(false);
    expect(isAppForeground('inactive', undefined)).toBe(false);
    expect(isAppForeground('active', 'hidden')).toBe(false);
    expect(isAppForeground(null, undefined)).toBe(true);
  });
});

describe('useAppForeground', () => {
  it('follows AppState changes', () => {
    let listener: ((s: string) => void) | undefined;
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true });
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: string) => void) => {
      listener = fn;
      return { remove: jest.fn() };
    }) as never);

    const { result } = renderHook(() => useAppForeground());
    expect(result.current).toBe(true);

    act(() => {
      listener?.('background');
    });
    expect(result.current).toBe(false);

    act(() => {
      listener?.('active');
    });
    expect(result.current).toBe(true);
  });
});
