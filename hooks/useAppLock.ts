import { useCallback, useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

const BACKGROUND_LOCK_AFTER_MS = 15 * 60_000;

export function useAppLock(enabled: boolean, onLock: () => void) {
  const onLockRef = useRef(onLock);
  const backgroundAtRef = useRef<number | null>(null);
  const previousStateRef = useRef<AppStateStatus>(AppState.currentState);
  onLockRef.current = onLock;

  useEffect(() => {
    if (!enabled) {
      backgroundAtRef.current = null;
      previousStateRef.current = AppState.currentState;
      return;
    }
    const subscription = AppState.addEventListener('change', (nextState) => {
      const previous = previousStateRef.current;
      if (previous.match(/inactive|background/) && nextState === 'active') {
        const backgroundAt = backgroundAtRef.current;
        if (backgroundAt !== null && Date.now() - backgroundAt >= BACKGROUND_LOCK_AFTER_MS) onLockRef.current();
        backgroundAtRef.current = null;
      } else if (nextState.match(/inactive|background/)) {
        backgroundAtRef.current ??= Date.now();
      }
      previousStateRef.current = nextState;
    });
    return () => subscription.remove();
  }, [enabled]);

  const biometricAvailability = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'web') return false;
    try {
      const [hasHardware, enrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      return hasHardware && enrolled;
    } catch {
      return false;
    }
  }, []);

  const authenticateBiometric = useCallback(async (): Promise<boolean> => {
    if (!(await biometricAvailability())) return false;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock HouseLog',
        cancelLabel: 'Use password',
        disableDeviceFallback: true,
      });
      return result.success;
    } catch {
      return false;
    }
  }, [biometricAvailability]);

  return { biometricAvailability, authenticateBiometric };
}
