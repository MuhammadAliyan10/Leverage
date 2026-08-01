import { useEffect, useState, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

export function useAppLock(enabled: boolean = true) {
  const [isLocked, setIsLocked] = useState(enabled);
  const [appState, setAppState] = useState(AppState.currentState);
  const backgroundTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setIsLocked(false);
      return;
    }

    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (
        appState.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        // App has come to the foreground
        if (backgroundTimeRef.current) {
          const timeInBackground = Date.now() - backgroundTimeRef.current;
          // 60 seconds (60000 ms) timeout before re-authentication is required
          if (timeInBackground > 60000) {
            setIsLocked(true);
          }
        }
      } else if (nextAppState.match(/inactive|background/)) {
        // App goes to background
        backgroundTimeRef.current = Date.now();
      }
      setAppState(nextAppState);
    });

    return () => {
      subscription.remove();
    };
  }, [appState, enabled]);

  const unlock = async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (!hasHardware || !isEnrolled) {
      // Fallback if no biometrics are set up
      setIsLocked(false);
      return true;
    }

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Finance App',
      fallbackLabel: 'Use PIN',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });

    if (result.success) {
      setIsLocked(false);
      backgroundTimeRef.current = Date.now();
      return true;
    }
    return false;
  };

  return { isLocked, unlock };
}
