import { PRIMARY_COLOR } from '../src/constants/themeColors';
// app/_layout.tsx
import { Stack, useLocalSearchParams, useRouter, useSegments } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Toast from 'react-native-toast-message';
import { localDb } from '../src/db/local/client';
import { useAppLock } from '../hooks/useAppLock';
import { LockScreen } from '../components/ui/LockScreen';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { reconcileProfileReminders } from '../src/security/localReminders';
import { mayOpenReminder, readReminderIdentity } from '../src/security/reminderPolicy';
import { decideOnboardingRoute } from '../src/security/onboardingRoutePolicy';
import { authTraceEvent, authTraceOperation, getActiveAuthTraceId } from '../src/security/authDiagnostics';
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
  const { manual: manualOnboardingParam } = useLocalSearchParams<{ manual?: string }>();
  const { session, status, user, isLoading, lock, unlockWithPassword, unlockAfterBiometric, profileSettings, pendingProfileEmail, retrySessionRestore, signOut } = useAuth();
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
    const traceId = getActiveAuthTraceId();
    if (traceId) authTraceEvent('NAVIGATION_GUARD_EVALUATED', {
      status,
      isLoading,
      fontsLoaded: loaded || Boolean(fontError),
      route: segments.join('/') || 'root',
    }, traceId);
    if (traceId && isLoading) authTraceEvent('NAVIGATION_BLOCKED', { reason: 'session_restoration' }, traceId);
    if (traceId && !isLoading && !loaded && !fontError) authTraceEvent('NAVIGATION_BLOCKED', { reason: 'font_initialization' }, traceId);
    if (isLoading || (!loaded && !fontError)) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (status === 'signedOut' && !inAuthGroup) {
      // Not authenticated — send to auth
      router.replace(pendingProfileEmail ? { pathname: '/(auth)', params: { email: pendingProfileEmail } } : '/(auth)');
      return;
    }

    if (status === 'signedIn' && inAuthGroup) {
      // Authenticated — send to tabs
      if (traceId) authTraceEvent('NAVIGATION_START', { destination: 'tabs' }, traceId);
      router.replace('/(tabs)');
      if (traceId) authTraceEvent('NAVIGATION_DISPATCHED', { destination: 'tabs' }, traceId);
      return;
    }

    // Only a newly registered profile is forced through first-run setup. A
    // returning cloud user may not have local rows until the first pull completes.
    const onDashboardEntry = segments[0] === '(tabs)' && segments.length === 1;
    if (status === 'signedIn' && user && (onDashboardEntry || segments[0] === 'onboarding')) {
      let active = true;
      void (async () => {
        if (traceId) authTraceEvent('ONBOARDING_ROUTE_CHECK_START', { route: segments.join('/') || 'root' }, traceId);
        const complete = await authTraceOperation(traceId, 'ONBOARDING_COMPLETE_CHECK', () => localDb.user.onboardingComplete(user.id));
        if (!active) return;
        const onboardingRequired = !complete && await authTraceOperation(traceId, 'ONBOARDING_REQUIRED_CHECK', () => localDb.user.onboardingRequired(user.id));
        if (!active) return;
        // Cloud sync is already started by AuthProvider. Never hold navigation on
        // a network pull: an empty new-device database must open the dashboard while
        // cloud records arrive in the background.
        const destination = decideOnboardingRoute({
          isSignedIn: status === 'signedIn',
          isComplete: complete,
          isRequired: onboardingRequired,
          onDashboardEntry: segments[0] === '(tabs)' && segments.length === 1,
          onOnboarding: segments[0] === 'onboarding',
          manualRequest: manualOnboardingParam === '1',
        });
        if (destination === 'onboarding') {
          if (traceId) authTraceEvent('NAVIGATION_START', { destination: 'onboarding' }, traceId);
          router.replace('/onboarding');
        } else if (destination === 'tabs') {
          if (traceId) authTraceEvent('NAVIGATION_START', { destination: 'tabs' }, traceId);
          router.replace('/(tabs)');
        }
        if (traceId) authTraceEvent('ONBOARDING_ROUTE_CHECK_END', { destination }, traceId);
      })().catch(() => {
        if (traceId) authTraceEvent('ONBOARDING_ROUTE_CHECK_ERROR', { errorKind: 'operation_failed' }, traceId);
        // Keep the current screen visible and allow a retry; do not guess completion.
      });
      return () => { active = false; };
    }
  }, [status, user, isLoading, segments, loaded, fontError, router, pendingProfileEmail, manualOnboardingParam]);

  if (!loaded && !fontError) return null;
  if (isLoading) return <View className="flex-1 items-center justify-center bg-gray-50 dark:bg-neutral-950"><ActivityIndicator color={PRIMARY_COLOR} /><Text className="font-body mt-3 text-sm text-gray-600 dark:text-neutral-300">Checking this device…</Text></View>;

  if (session.status === 'restoreError') {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 justify-center bg-gray-50 px-6 dark:bg-neutral-950">
          <View className="rounded-sm border border-gray-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <Text className="font-heading text-xl font-bold text-gray-900 dark:text-white">Your profile is still saved</Text>
            <Text accessibilityRole="alert" className="font-body mt-3 text-sm leading-6 text-gray-600 dark:text-neutral-300">{session.message}</Text>
            <Pressable accessibilityRole="button" onPress={retrySessionRestore} className="mt-5 items-center bg-primary px-4 py-3">
              <Text className="font-body font-semibold text-white">Retry</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => { void signOut(); }} className="mt-3 items-center border border-gray-300 px-4 py-3 dark:border-neutral-700">
              <Text className="font-body font-semibold text-gray-700 dark:text-neutral-200">Sign out and sign in online</Text>
            </Pressable>
          </View>
          <Toast />
        </View>
      </GestureHandlerRootView>
    );
  }

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
        <Stack.Screen name="projects/index" options={{ headerShown: false }} />
        <Stack.Screen name="projects/[id]" options={{ headerShown: false }} />
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
