import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Eye, EyeOff, ShieldCheck } from 'lucide-react-native';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../src/context/AuthContext';
import { localDb } from '../../src/db/local/client';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';

export default function RestoreBackupScreen() {
  const router = useRouter();
  const { restoreBackup } = useAuth();
  const [passphrase, setPassphrase] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    if (passphrase.length < 12 || passphrase.length > 256) { setError('Enter the backup passphrase (at least 12 characters).'); return; }
    setBusy(true); setError(null);
    try {
      const bytes = await localDb.recovery.pickEncryptedBackup();
      if (!bytes) { setBusy(false); return; }
      Alert.alert('Restore Mizan backup?', 'Mizan will validate the encrypted file, schema, profile, financial data and foreign keys before replacing this device’s local database.', [
        { text: 'Cancel', style: 'cancel', onPress: () => setBusy(false) },
        { text: 'Validate and restore', onPress: () => {
          void restoreBackup(bytes, passphrase).then(() => {
            Alert.alert('Restore complete', 'Your backup is restored. Sign in with the profile included in the backup.');
            router.replace('/(auth)');
          }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The backup could not be restored.')).finally(() => setBusy(false));
        } },
      ]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The backup file could not be opened.'); setBusy(false); }
  };

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1">
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 }} keyboardShouldPersistTaps="handled">
        <View className="w-full max-w-[460px] self-center">
          <Pressable accessibilityRole="button" accessibilityLabel="Back to sign in" onPress={() => router.back()} className="mb-8 h-11 w-11 items-center justify-center rounded-full bg-white dark:bg-neutral-900"><ArrowLeft size={20} color={PRIMARY_COLOR} /></Pressable>
          <View className="mb-5 h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"><ShieldCheck size={28} color={PRIMARY_COLOR} /></View>
          <Text className="font-heading text-2xl font-bold text-gray-900 dark:text-white">Restore encrypted backup</Text>
          <Text className="font-body mb-7 mt-2 text-sm leading-5 text-gray-600 dark:text-neutral-300">Choose your Mizan .hlbk file and enter its backup passphrase. You must remember this passphrase; it is not your profile password.</Text>
          <Input label="Backup passphrase" placeholder="At least 12 characters" value={passphrase} onChangeText={(value) => { setPassphrase(value); setError(null); }} secureTextEntry={!visible} autoCapitalize="none" autoCorrect={false} error={undefined} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={visible ? 'Hide passphrase' : 'Show passphrase'} onPress={() => setVisible((value) => !value)}>{visible ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />
          {error ? <Text accessibilityRole="alert" className="font-body mb-3 text-sm text-red-600">{error}</Text> : null}
          <Button title="Choose backup file" onPress={() => void restore()} isLoading={busy} />
          <Text className="font-body mt-5 text-xs leading-5 text-gray-500 dark:text-neutral-400">Restore validates the file before activating it. A damaged backup or incorrect passphrase leaves the existing database unchanged.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
