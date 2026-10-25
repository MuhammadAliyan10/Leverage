import { PRIMARY_COLOR } from '../src/constants/themeColors';
// app/_layout.tsx
import { Stack, useRouter, useSegments } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Toast from 'react-native-toast-message';
import { localDb } from '../src/db/local/client';
import { useAppLock } from '../hooks/useAppLock';
import { LockScreen } from '../components/ui/LockScreen';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { reconcileProfileReminders } from '../src/security/localReminders';
import { mayOpenReminder, readReminderIdentity } from '../src/security/reminderPolicy';
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
  const { session, status, user, isLoading, lock, unlockWithPassword, unlockAfterBiometric, profileSettings, pendingProfileEmail } = useAuth();
  const { biometricAvailability, authenticateBiometric } = useAppLock(status === 'signedIn' && profileSettings.appLockEnabled, lock);
  const reminderErrorShown = useRef<string | null>(null);

  const [loaded, fontError] = useFonts({
    Inter: require('../assets/fonts/Inter-Regular.ttf'),
    InterBlack: require('../assets/fonts/Inter-Black.ttf'),
    Figtree: require('../assets/fonts/Figtree-Regular.otf'),
  });

  useEffect(() => {
    if (loaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [loaded, fontError]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (mayOpenReminder({ identity: readReminderIdentity(data), activeProfileId: user?.id ?? null, remindersEnabled: profileSettings.remindersEnabled })) router.push('/obligations');
    });
    return () => subscription.remove();
  }, [router, user, profileSettings.remindersEnabled]);

  useEffect(() => {
    if (status !== 'signedIn' || !user) return;
    void reconcileProfileReminders(user.id, profileSettings.remindersEnabled).then(() => {
      reminderErrorShown.current = null;
    }).catch((error: unknown) => {
      if (reminderErrorShown.current === user.id) return;
      reminderErrorShown.current = user.id;
      Toast.show({ type: 'error', text1: 'Reminder update needs attention', text2: error instanceof Error ? error.message : 'Local reminders could not be reconciled.' });
    });
  }, [status, user, profileSettings.remindersEnabled]);

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

    if (status === 'signedOut' && !inAuthGroup) {
      // Not authenticated — send to auth
      router.replace(pendingProfileEmail ? { pathname: '/(auth)', params: { email: pendingProfileEmail } } : '/(auth)');
      return;
    }

    if (status === 'signedIn' && inAuthGroup) {
      // Authenticated — send to tabs
      router.replace('/(tabs)');
      return;
    }

    if (status === 'signedIn' && user && (segments[0] === '(tabs)' || segments[0] === 'onboarding')) {
      let active = true;
      void localDb.user.onboardingComplete(user.id).then((complete) => {
        if (!active) return;
        if (!complete && segments[0] === '(tabs)') router.replace('/onboarding');
        else if (complete && segments[0] === 'onboarding') router.replace('/(tabs)');
      }).catch(() => {
        // Keep the current screen visible and allow a retry; do not guess completion.
      });
      return () => { active = false; };
    }
  }, [status, user, isLoading, segments, loaded, fontError, router, pendingProfileEmail]);

  if (!loaded && !fontError) return null;
  if (isLoading) return <View className="flex-1 items-center justify-center bg-gray-50 dark:bg-neutral-950"><ActivityIndicator color={PRIMARY_COLOR} /><Text className="font-body mt-3 text-sm text-gray-600 dark:text-neutral-300">Checking this device…</Text></View>;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {session.status === 'locked' && (
        <LockScreen
          onUnlockPassword={unlockWithPassword}
          onUnlockBiometric={async () => profileSettings.biometricUnlockEnabled && (await authenticateBiometric()) && unlockAfterBiometric()}
          checkBiometricAvailability={biometricAvailability}
          biometricEnabled={profileSettings.biometricUnlockEnabled}
        />
      )}
      <Stack>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)/restore" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="budgets" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="savings" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="accounts" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="account/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="obligations" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="assets" options={{ headerShown: false, presentation: 'modal' }} />
        <Stack.Screen name="native-verification" options={{ headerShown: false, presentation: 'modal' }} />
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
