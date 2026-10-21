// app/_layout.tsx
import { Stack, useRouter, useSegments } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Toast from 'react-native-toast-message';
import { localDb } from '../src/db/local/client';
import { useAppLock } from '../hooks/useAppLock';
import { LockScreen } from '../components/ui/LockScreen';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import '../global.css';

SplashScreen.preventAutoHideAsync();
Notifications.setNotificationHandler({handleNotification:async()=>({shouldPlaySound:false,shouldSetBadge:false,shouldShowBanner:true,shouldShowList:true})});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60 * 24,
    },
  },
});

function RootNavigator() {
  const router = useRouter();
  const segments = useSegments();
  const { user, isLoading } = useAuth();
  const { isLocked, unlock } = useAppLock(!!user);

  const [loaded, fontError] = useFonts({});

  useEffect(() => {
    if (loaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [loaded, fontError]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const destination = response.notification.request.content.data?.url;
      if (user && destination === '/obligations') router.push('/obligations');
    });
    return () => subscription.remove();
  }, [router, user]);

  useEffect(() => {
    if (!user || isLoading) return;
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    void localDb.obligations.schedules.generateDue(user.id,today).catch((error:unknown)=>{
      console.error('Recurring schedule catch-up could not complete:',error);
    });
  }, [user, isLoading]);

  useEffect(() => {
    if (isLoading || (!loaded && !fontError)) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!user && !inAuthGroup) {
      // Not authenticated — send to auth
      router.replace('/(auth)');
      return;
    }

    if (user && inAuthGroup) {
      // Authenticated — send to tabs
      router.replace('/(tabs)');
      return;
    }

    // Authenticated and in tabs — check onboarding
    if (user && segments[0] === '(tabs)') {
      (async () => {
        try {
          const accountCount = await localDb.account.count(user.id);
          if (accountCount === 0) {
            router.replace('/onboarding');
          }
        } catch (e) {
          console.error('DB Error Check:', e);
        }
      })();
    }
  }, [user, isLoading, segments, loaded, fontError, router]);

  if (!loaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {isLocked && <LockScreen onUnlock={unlock} />}
      <Stack>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="budgets" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="savings" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="accounts" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="obligations" options={{ headerShown: false, presentation: 'modal' }} />
      </Stack>
      <Toast />
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </QueryClientProvider>
  );
}
