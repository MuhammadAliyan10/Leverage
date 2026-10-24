import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PRIMARY_COLOR } from '../src/constants/themeColors';
import { isDisposableAndroidVerificationBuild } from '../src/security/verificationBuild';
import {
  completeNativeSqlCipherRestartVerification,
  discardNativeSqlCipherRestartCheck,
  hasPendingNativeSqlCipherRestartCheck,
  prepareNativeSqlCipherVerification,
  type NativeStorageVerification,
} from '../src/security/nativeStorageVerification';

const disposableBuild = isDisposableAndroidVerificationBuild(Constants.expoConfig?.extra);

export default function NativeVerificationScreen() {
  const [pendingRestart, setPendingRestart] = useState(false);
  const [checkingPending, setCheckingPending] = useState(disposableBuild);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<NativeStorageVerification | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!disposableBuild) return;
    void hasPendingNativeSqlCipherRestartCheck().then(setPendingRestart).catch(() => setPendingRestart(false)).finally(() => setCheckingPending(false));
  }, []);

  if (!disposableBuild) {
    return <SafeAreaView className="flex-1 items-center justify-center bg-gray-50 px-6 dark:bg-neutral-950">
      <Text className="font-heading text-xl font-bold text-slate-900 dark:text-white">Verification unavailable</Text>
      <Text className="mt-2 text-center font-body text-sm text-slate-600 dark:text-neutral-300">This screen is enabled only in the disposable Android verification build.</Text>
    </SafeAreaView>;
  }

  const prepare = async () => {
    setRunning(true);
    setMessage('');
    setResult(null);
    try {
      const verification = await prepareNativeSqlCipherVerification();
      setResult(verification);
      setPendingRestart(true);
      setMessage('First check passed. Fully close Leverage Verification, reopen it, then return here and complete the restart check.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Native encryption verification failed.');
    } finally { setRunning(false); }
  };

  const completeRestart = async () => {
    setRunning(true);
    setMessage('');
    try {
      await completeNativeSqlCipherRestartVerification();
      setPendingRestart(false);
      setResult(null);
      setMessage('PASS: the encrypted test data survived a full app restart, rejected a wrong key, and passed integrity checks. The temporary database and test key were deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Restart verification failed.');
    } finally { setRunning(false); }
  };

  const discardRestart = async () => {
    setRunning(true);
    setMessage('');
    try {
      await discardNativeSqlCipherRestartCheck();
      setPendingRestart(false);
      setResult(null);
      setMessage('The isolated test database and its temporary key were discarded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The isolated test could not be discarded.');
    } finally { setRunning(false); }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }}>
        <Text className="font-heading text-2xl font-bold text-slate-900 dark:text-white">Native storage check</Text>
        <Text className="mt-2 font-body text-sm leading-6 text-slate-600 dark:text-neutral-300">
          Runs only in this disposable verification app. It creates a random, encrypted test database and never opens or changes your financial records.
        </Text>

        <View className="mt-6 rounded-xl border border-slate-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <Text className="font-heading text-base font-semibold text-slate-900 dark:text-white">Checks performed</Text>
          {[
            'SQLCipher is present in the installed native binary',
            'Test database file is encrypted at rest',
            'Correct key can reopen saved data',
            'Incorrect key is rejected',
            'SQLite integrity and foreign keys pass',
            'Data and key survive a full app restart',
          ].map((item) => <Text key={item} className="mt-3 font-body text-sm text-slate-700 dark:text-neutral-200">• {item}</Text>)}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={running || checkingPending || pendingRestart}
          onPress={() => void prepare()}
          style={{ backgroundColor: running || checkingPending || pendingRestart ? '#9691ff' : PRIMARY_COLOR }}
          className="mt-6 min-h-12 items-center justify-center rounded-md px-4"
        >
          {running || checkingPending ? <ActivityIndicator color="white" /> : <Text className="font-body font-semibold text-white">Run isolated encryption check</Text>}
        </Pressable>

        {pendingRestart && <Pressable
          accessibilityRole="button"
          disabled={running}
          onPress={() => void completeRestart()}
          style={{ backgroundColor: running ? '#9691ff' : PRIMARY_COLOR }}
          className="mt-3 min-h-12 items-center justify-center rounded-md px-4"
        >
          {running ? <ActivityIndicator color="white" /> : <Text className="font-body font-semibold text-white">Complete after full app restart</Text>}
        </Pressable>}

        {pendingRestart && <Pressable accessibilityRole="button" disabled={running} onPress={() => void discardRestart()} className="mt-2 min-h-11 items-center justify-center">
          <Text className="font-body text-sm font-semibold text-red-600">Discard isolated test</Text>
        </Pressable>}

        {result && <Text className="mt-5 font-body text-sm font-semibold text-emerald-700 dark:text-emerald-400">First phase passed. Restart verification is pending.</Text>}
        {!!message && <Text accessibilityLiveRegion="polite" className="mt-4 font-body text-sm leading-6 text-slate-700 dark:text-neutral-200">{message}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}
