import { Stack, useRouter, useSegments } from 'expo-router';
import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Toast from 'react-native-toast-message';
import { localDb } from '../src/db/local/client';
import { useAppLock } from '../hooks/useAppLock';
import { LockScreen } from '../components/ui/LockScreen';
import '../global.css';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
    },
  },
});

export default function RootLayout() {
  const [loaded, error] = useFonts({
    // Uncomment and add your font files to assets/fonts when ready
    // Fargie: require('../assets/fonts/Fargie.ttf'),
    // Inter: require('../assets/fonts/Inter.ttf'),
  });

  const router = useRouter();
  const segments = useSegments();
  
  // App Lock logic - default enabled (can be pulled from async storage in real app)
  const { isLocked, unlock } = useAppLock(true);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  useEffect(() => {
    async function handleRouting() {
      if (!loaded) return;
      
      // Intercept navigation to tabs to check if onboarding is needed
      if (segments[0] === '(tabs)') {
        try {
          const accountCount = await localDb.account.count();
          if (accountCount === 0) {
            router.replace('/onboarding');
          }
        } catch (e) {
          console.error("DB Error Check:", e);
        }
      }
    }
    
    handleRouting();
  }, [segments, loaded]);

  if (!loaded && !error) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {isLocked && <LockScreen onUnlock={unlock} />}
        <Stack>
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="budgets" options={{ headerShown: false, presentation: 'modal' }} />
        </Stack>
        <Toast />
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}
