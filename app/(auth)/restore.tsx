import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Eye, EyeOff, FileUp } from 'lucide-react-native';
import { Input } from '../../components/ui/Input';
import { KeyboardAwareScrollView } from '../../components/ui/KeyboardAwareScrollView';
import { Button } from '../../components/ui/Button';
import { useAppConfirm } from '../../components/ui/useAppConfirm';
import { useAuth } from '../../src/context/AuthContext';
import { localDb } from '../../src/db/local/client';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';

export default function RestoreBackupScreen() {
  const router = useRouter();
  const { restoreBackup } = useAuth();
  const { confirm, dialog } = useAppConfirm();
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
      const confirmed = await confirm({
        title: 'Restore Leverage backup?',
        message: 'Leverage will validate the encrypted file, schema, profile, financial data and foreign keys before replacing this device’s local database.',
        confirmLabel: 'Validate and restore',
        destructive: true,
      });
      if (!confirmed) { setBusy(false); return; }
      await restoreBackup(bytes, passphrase);
      router.replace('/(auth)');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The backup file could not be opened.'); setBusy(false); }
  };

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <KeyboardAwareScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 32 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View className="w-full max-w-[480px] self-center">
          <Pressable accessibilityRole="button" accessibilityLabel="Back to sign in" onPress={() => router.replace('/(auth)')} className="mb-8 h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"><ArrowLeft size={20} color={PRIMARY_COLOR} /></Pressable>

          <Text className="font-heading text-[30px] font-bold tracking-tight text-gray-900 dark:text-white">Restore your backup</Text>
          <Text className="font-body mb-7 mt-2 text-sm leading-6 text-gray-600 dark:text-neutral-300">Bring your financial profile back to this device using your encrypted <Text className="font-semibold text-gray-800 dark:text-neutral-100">.hlbk</Text> backup and its backup passphrase.</Text>

          <View className="rounded-md border border-gray-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <Input label="Backup passphrase" placeholder="Enter at least 12 characters" value={passphrase} onChangeText={(value) => { setPassphrase(value); setError(null); }} secureTextEntry={!visible} autoCapitalize="none" autoCorrect={false} error={error ?? undefined} helperText="This is different from your Leverage sign-in password." trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={visible ? 'Hide passphrase' : 'Show passphrase'} hitSlop={10} onPress={() => setVisible((value) => !value)}>{visible ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />
            <Button title={busy ? 'Preparing restore…' : 'Choose encrypted backup'} onPress={() => void restore()} isLoading={busy} accessibilityLabel="Choose encrypted backup file" />
            <Text className="font-body mt-3 text-center text-xs leading-5 text-gray-500 dark:text-neutral-400">Select the backup file saved on this device or in your files.</Text>
          </View>

          <View className="mt-5 flex-row items-start gap-3 rounded-md border border-primary/15 bg-primary/5 p-4">
            <FileUp size={19} color={PRIMARY_COLOR} />
            <Text className="font-body flex-1 text-xs leading-5 text-gray-600 dark:text-neutral-300">Your current records stay unchanged unless the backup opens and passes all data checks.</Text>
          </View>
        </View>
    </KeyboardAwareScrollView>
    {dialog}
  </SafeAreaView>;
}
