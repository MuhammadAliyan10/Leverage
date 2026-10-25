import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { useRouter, type Href } from 'expo-router';
import { Activity, Bell, Building2, CalendarClock, ChevronRight, Cloud, Coins, Eye, EyeOff, Fingerprint, KeyRound, LockKeyhole, LogOut, Moon, PiggyBank, ShieldCheck, TrendingUp, UserRound, UsersRound, X } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { useAppConfirm } from '../../components/ui/useAppConfirm';
import { useAuth } from '../../src/context/AuthContext';
import type { AppearancePreference } from '../../src/security/settingsPreferences';
import { localDb, type DbUser } from '../../src/db/local/client';
import { useAppLock } from '../../hooks/useAppLock';
import { changePasswordSchema, profileNameSchema, type ChangePasswordForm, type ProfileNameForm } from '../../utils/validations/profile';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import { CloudSyncModal } from '../../components/settings/CloudSyncModal';
import { cloudApiConfigured } from '../../src/cloud/authClient';
import { isDisposableAndroidVerificationBuild } from '../../src/security/verificationBuild';

interface SettingRowProps {
  icon: LucideIcon;
  title: string;
  onPress?: () => void;
  value?: string;
  right?: React.ReactNode;
  danger?: boolean;
  accessibilityLabel?: string;
  accessibilityState?: { checked?: boolean; disabled?: boolean; selected?: boolean };
}

function SettingRow({ icon: Icon, title, onPress, value, right, danger = false, accessibilityLabel, accessibilityState }: SettingRowProps) {
  const content = (
    <>
      <View className="min-h-[52px] flex-row flex-1 items-center py-2">
        <View className={`mr-3 h-9 w-9 items-center justify-center rounded-full ${danger ? 'bg-red-100 dark:bg-red-500/15' : 'bg-primary/10 dark:bg-primary/20'}`}>
          <Icon size={18} color={danger ? '#dc2626' : PRIMARY_COLOR} />
        </View>
        <Text className={`font-body flex-1 text-sm font-semibold ${danger ? 'text-red-600' : 'text-gray-900 dark:text-white'}`}>{title}</Text>
      </View>
      <View className="ml-2 flex-row items-center">
        {value ? <Text className="font-body max-w-[150px] text-right text-xs text-gray-500 dark:text-neutral-400">{value}</Text> : null}
        {right}
        {onPress ? <ChevronRight size={18} color="#9ca3af" /> : null}
      </View>
    </>
  );
  const className = 'min-h-[56px] flex-row items-center justify-between border-b border-gray-100 dark:border-neutral-800';
  if (!onPress) return <View className={className}>{content}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={accessibilityState} onPress={onPress} className={`${className} active:opacity-70`}>
      {content}
    </Pressable>
  );
}

function Section({ title, children, description }: { title: string; children: React.ReactNode; description?: string }) {
  return (
    <View className="mb-4 rounded-2xl bg-white px-4 dark:bg-neutral-900">
      <Text className="font-body pb-2 pt-4 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-neutral-400">{title}</Text>
      {children}
      {description ? <Text className="font-body pb-4 pt-2 text-xs leading-5 text-gray-500 dark:text-neutral-400">{description}</Text> : null}
    </View>
  );
}

type PermissionState = 'loading' | 'allowed' | 'not-allowed' | 'unavailable';
type BiometricState = 'checking' | 'available' | 'unavailable';
type ProfileRow = Omit<DbUser, 'passwordHash'>;

export default function SettingsScreen() {
  const router = useRouter();
  const { user, sessionNotice, signOut, updateProfileName, changePassword, listProfiles, appearance, profileSettings, updateAppearance, updateProfileSettings, switchLocalProfile, restoreBackup } = useAuth();
  const { biometricAvailability } = useAppLock(false, () => undefined);
  const [panel, setPanel] = useState<'name' | 'password' | 'switch' | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [cloudSyncOpen, setCloudSyncOpen] = useState(false);
  const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [biometricState, setBiometricState] = useState<BiometricState>(Platform.OS === 'web' ? 'unavailable' : 'checking');
  const [permission, setPermission] = useState<PermissionState>(Platform.OS === 'web' ? 'unavailable' : 'loading');
  const [permissionCanAskAgain, setPermissionCanAskAgain] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [feedback, setFeedback] = useState<{ title: string; message: string; kind: 'error' | 'info' } | null>(null);

  const showFeedback = useCallback((title: string, message: string, kind: 'error' | 'info' = 'error') => {
    setFeedback({ title, message, kind });
    if (Platform.OS !== 'web') Alert.alert(title, message);
  }, []);

  const refreshPermission = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const result = await Notifications.getPermissionsAsync();
      setPermission(result.granted ? 'allowed' : 'not-allowed');
      setPermissionCanAskAgain(result.canAskAgain);
    } catch {
      setPermission('unavailable');
      setPermissionCanAskAgain(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void biometricAvailability().then((available) => { if (active) setBiometricState(available ? 'available' : 'unavailable'); });
    const permissionCheck = setTimeout(() => { void refreshPermission(); }, 0);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshPermission();
    });
    return () => { active = false; clearTimeout(permissionCheck); subscription.remove(); };
  }, [biometricAvailability, refreshPermission]);

  const initials = user?.fullName.split(' ').map((part) => part[0]).join('').toUpperCase().slice(0, 2) ?? '?';
  const version = Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? 'Unavailable';
  const disposableVerificationBuild = isDisposableAndroidVerificationBuild(Constants.expoConfig?.extra);

  const saveAppearance = async (value: AppearancePreference) => {
    setFeedback(null);
    setSavingSettings(true);
    try { await updateAppearance(value); }
    catch (error) { showFeedback('Appearance not saved', error instanceof Error ? error.message : 'The appearance preference could not be saved.'); }
    finally { setSavingSettings(false); }
  };

  const saveProfileSetting = async (patch: Parameters<typeof updateProfileSettings>[0]) => {
    setFeedback(null);
    setSavingSettings(true);
    try { await updateProfileSettings(patch); }
    catch (error) { showFeedback('Setting needs attention', error instanceof Error ? error.message : 'The setting may have been saved, but follow-up work could not be completed.'); }
    finally { setSavingSettings(false); }
  };

  const toggleReminders = async (enabled: boolean) => {
    if (enabled) {
      if (Platform.OS === 'web') {
        showFeedback('Mobile reminders', 'Local bill reminders are available in the installed Android or iOS app.', 'info');
        return;
      }
      try {
        const result = await Notifications.requestPermissionsAsync();
        setPermission(result.granted ? 'allowed' : 'not-allowed');
        setPermissionCanAskAgain(result.canAskAgain);
        if (!result.granted) {
          showFeedback('Notifications not allowed', 'Enable notifications in device settings before turning on bill reminders.');
          return;
        }
      } catch (error) {
        showFeedback('Permission unavailable', error instanceof Error ? error.message : 'Notification permission could not be checked.');
        return;
      }
    }
    await saveProfileSetting({ remindersEnabled: enabled });
  };

  const openNotificationSettings = async () => {
    if (Platform.OS === 'web') return;
    try { await Linking.openSettings(); }
    catch (error) { showFeedback('Settings unavailable', error instanceof Error ? error.message : 'Device notification settings could not be opened.'); }
  };

  const manageNotificationPermission = async () => {
    if (Platform.OS === 'web') return;
    if (permissionCanAskAgain) {
      try {
        const result = await Notifications.requestPermissionsAsync();
        setPermission(result.granted ? 'allowed' : 'not-allowed');
        setPermissionCanAskAgain(result.canAskAgain);
        if (result.granted) return;
      } catch (error) {
        showFeedback('Permission unavailable', error instanceof Error ? error.message : 'Notification permission could not be requested.');
        return;
      }
    }
    await openNotificationSettings();
  };

  const handleSignOut = () => {
    setSignOutDialogOpen(true);
  };

  const confirmSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      setSignOutDialogOpen(false);
    } catch (error) {
      setSigningOut(false);
      setSignOutDialogOpen(false);
      showFeedback('Sign out needs attention', error instanceof Error ? error.message : 'The local profile could not be signed out completely.');
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <GlobalHeader title="Settings" description="Manage your profile and app preferences" />
      <ScrollView className="flex-1 px-4 pt-3" contentContainerStyle={{ paddingBottom: 36 }} showsVerticalScrollIndicator={false}>
        {sessionNotice ? <Text accessibilityRole="alert" className="font-body mb-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-950 dark:text-amber-200">{sessionNotice}</Text> : null}
        {feedback ? <View accessibilityRole={feedback.kind === 'error' ? 'alert' : 'text'} className={`mb-3 flex-row items-start rounded-xl p-3 ${feedback.kind === 'error' ? 'bg-red-50 dark:bg-red-950/50' : 'bg-primary/10 dark:bg-primary/20'}`}>
          <View className="flex-1"><Text className={`font-body text-sm font-semibold ${feedback.kind === 'error' ? 'text-red-800 dark:text-red-200' : 'text-gray-900 dark:text-white'}`}>{feedback.title}</Text><Text className={`font-body mt-1 text-xs leading-5 ${feedback.kind === 'error' ? 'text-red-700 dark:text-red-200' : 'text-gray-700 dark:text-neutral-200'}`}>{feedback.message}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss message" onPress={() => setFeedback(null)} className="ml-2 min-h-8 min-w-8 items-center justify-center"><X size={16} color={feedback.kind === 'error' ? '#b91c1c' : PRIMARY_COLOR} /></Pressable>
        </View> : null}

        <View className="mb-4 flex-row items-center rounded-2xl bg-white p-4 dark:bg-neutral-900">
          <View className="h-12 w-12 items-center justify-center rounded-full bg-primary"><Text className="font-heading text-lg font-bold text-white">{initials}</Text></View>
          <View className="ml-3 flex-1">
            <Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{user?.fullName ?? '—'}</Text>
            <Text className="font-body mt-0.5 text-xs text-gray-500 dark:text-neutral-400">{user?.email ?? '—'}</Text>
          </View>
        </View>

        <Section title="Profile" description="Profiles and financial records stay on this device. Switching profiles requires that profile’s password.">
          <SettingRow icon={UserRound} title="Edit display name" onPress={() => setPanel('name')} />
          <SettingRow icon={KeyRound} title="Change password" onPress={() => setPanel('password')} />
          <SettingRow icon={UsersRound} title="Switch local profile" onPress={() => setPanel('switch')} />
        </Section>

        <Section title="Appearance & preferences">
          <View className="min-h-[58px] flex-row items-center justify-between border-b border-gray-100 dark:border-neutral-800">
            <View className="flex-row items-center"><View className="mr-3 h-9 w-9 items-center justify-center rounded-full bg-primary/10"><Moon size={18} color={PRIMARY_COLOR} /></View><Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">Appearance</Text></View>
            <View className="flex-row rounded-xl bg-gray-100 p-1 dark:bg-neutral-800" accessibilityRole="radiogroup">
              {(['system', 'light', 'dark'] as const).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`${value} appearance`} accessibilityState={{ checked: appearance === value, disabled: savingSettings }} disabled={savingSettings} onPress={() => void saveAppearance(value)} className={`rounded-lg px-2.5 py-2 ${appearance === value ? 'bg-white dark:bg-neutral-700' : ''}`}><Text className={`font-body text-xs font-semibold ${appearance === value ? 'text-primary' : 'text-gray-500 dark:text-neutral-400'}`}>{value[0].toUpperCase() + value.slice(1)}</Text></Pressable>)}
            </View>
          </View>
          <SettingRow icon={Coins} title="Account currencies" value="Set per account" onPress={() => router.push('/accounts')} />
          <SettingRow icon={Building2} title="Quick transaction account" value="Recent account by type" onPress={() => router.push('/add')} />
          <Text className="font-body pb-4 pt-2 text-xs leading-5 text-gray-500 dark:text-neutral-400">The Add screen already remembers the most recent account separately for income, expenses and transfers. Amounts in different currencies remain separate.</Text>
        </Section>

        <Section title="Financial management">
          <SettingRow icon={Building2} title="Accounts" onPress={() => router.push('/accounts')} />
          <SettingRow icon={Activity} title="Monthly budgets" onPress={() => router.push('/budgets')} />
          <SettingRow icon={PiggyBank} title="Savings & emergency fund" onPress={() => router.push('/savings')} />
          <SettingRow icon={CalendarClock} title="Recurring, bills & debt" onPress={() => router.push('/obligations')} />
          <SettingRow icon={TrendingUp} title="Assets, investments & net worth" onPress={() => router.push('/assets')} />
        </Section>

        <Section title="Security" description="On Android and iOS, the app locks after 15 minutes in the background and requires your profile password after a cold restart when app lock is enabled. On web, a remembered session stays open across refreshes and route changes; sign out on a shared browser. Password unlock is always available.">
          <SettingRow icon={LockKeyhole} title="App lock" value={Platform.OS === 'web' ? 'Unavailable in browser' : undefined} right={Platform.OS === 'web' ? undefined : <Switch accessibilityLabel="Enable app lock" accessibilityState={{ checked: profileSettings.appLockEnabled, disabled: savingSettings }} value={profileSettings.appLockEnabled} disabled={savingSettings} onValueChange={(value) => void saveProfileSetting({ appLockEnabled: value })} trackColor={{ false: '#d1d5db', true: PRIMARY_COLOR }} thumbColor="#ffffff" />} />
          <SettingRow icon={Fingerprint} title="Biometric unlock" value={biometricState === 'checking' ? 'Checking…' : biometricState === 'unavailable' ? 'Unavailable on this device' : undefined} right={biometricState === 'available' ? <Switch accessibilityLabel="Enable biometric unlock" accessibilityState={{ checked: profileSettings.biometricUnlockEnabled, disabled: savingSettings || !profileSettings.appLockEnabled }} value={profileSettings.biometricUnlockEnabled} disabled={savingSettings || !profileSettings.appLockEnabled} onValueChange={(value) => void saveProfileSetting({ biometricUnlockEnabled: value })} trackColor={{ false: '#d1d5db', true: PRIMARY_COLOR }} thumbColor="#ffffff" /> : undefined} />
          <SettingRow icon={ShieldCheck} title="Password fallback" value="Always available" />
        </Section>

        <Section title="Notifications" description="Leverage schedules local bill reminders only. Notification text is generic and does not include bill names or amounts.">
          <SettingRow icon={Bell} title="Device permission" value={permission === 'loading' ? 'Checking…' : permission === 'allowed' ? 'Allowed' : permission === 'not-allowed' ? 'Not allowed' : 'Unavailable'} onPress={permission === 'not-allowed' && Platform.OS !== 'web' ? () => void manageNotificationPermission() : undefined} accessibilityLabel="Notification permission status" />
          <SettingRow icon={Bell} title="Local bill reminders" value={Platform.OS === 'web' ? 'Unavailable in browser' : undefined} right={Platform.OS === 'web' ? undefined : <Switch accessibilityLabel="Enable local bill reminders" accessibilityState={{ checked: profileSettings.remindersEnabled, disabled: savingSettings }} value={profileSettings.remindersEnabled} disabled={savingSettings} onValueChange={(value) => void toggleReminders(value)} trackColor={{ false: '#d1d5db', true: PRIMARY_COLOR }} thumbColor="#ffffff" />} />
          <SettingRow icon={CalendarClock} title="Manage bill reminders" onPress={() => router.push('/obligations')} />
        </Section>

        <Section title="Data & privacy" description="Profiles are stored separately on each device. The app saves to its local database first, then queues supported records for Neon cloud sync when connected; offline changes stay on this device until confirmed. Connecting queues supported existing history for import. Check Cloud Sync for pending or rejected changes before relying on another device. SQLCipher is configured for native builds, but encryption and recovery still require Android runtime verification. Encrypted backups include all local profiles on this device; keep the backup file and its separate passphrase safe. Leverage cannot recover a forgotten passphrase. Android automatic device backup is disabled.">
          <SettingRow icon={ShieldCheck} title="Storage" value="Local database + optional cloud sync" />
          {disposableVerificationBuild ? <SettingRow icon={ShieldCheck} title="Native storage verification" value="Disposable test only" onPress={() => router.push('/native-verification' as Href)} /> : null}
          <SettingRow icon={Activity} title="Encrypted backup & restore" value={Platform.OS === 'web' ? 'Unavailable in browser' : 'Available'} onPress={Platform.OS === 'web' ? undefined : () => setRecoveryOpen(true)} />
        </Section>

        <Section title="About" description="Personal finance tracking designed to work offline. Leverage does not connect to banks or provide live investment prices.">
          <SettingRow icon={Activity} title="Leverage version" value={version} />
          <SettingRow icon={Cloud} title="Cloud sync" value={Platform.OS === 'web' ? 'Unavailable in browser' : cloudApiConfigured ? 'Connect account' : 'Not configured'} onPress={Platform.OS === 'web' ? undefined : () => setCloudSyncOpen(true)} />
        </Section>

        <Section title="Session">
          <SettingRow icon={LogOut} title="Sign out" danger onPress={handleSignOut} />
        </Section>
      </ScrollView>

      <ProfileSecurityModal
        key={panel ?? 'closed'}
        mode={panel}
        fullName={user?.fullName ?? ''}
        currentProfileId={user?.id ?? ''}
        onClose={() => setPanel(null)}
        onSaveName={updateProfileName}
        onChangePassword={changePassword}
        loadProfiles={listProfiles}
        onSwitchProfile={switchLocalProfile}
      />
      <RecoveryModal
        key={recoveryOpen ? 'recovery-open' : 'recovery-closed'}
        visible={recoveryOpen}
        onClose={() => setRecoveryOpen(false)}
        onExport={async (passphrase) => {
          if (!user) throw new Error('Unlock a profile before creating a backup.');
          await localDb.recovery.exportEncryptedBackup(user.id, passphrase);
        }}
        onRestore={async (bytes, passphrase) => {
          await restoreBackup(bytes, passphrase);
          setRecoveryOpen(false);
          Alert.alert('Backup restored', 'Sign in with the restored local profile to continue.');
        }}
      />
      <CloudSyncModal visible={cloudSyncOpen} ownerId={user?.id ?? ''} fullName={user?.fullName ?? ''} onClose={() => setCloudSyncOpen(false)} />
      <SignOutDialog visible={signOutDialogOpen} busy={signingOut} onCancel={() => setSignOutDialogOpen(false)} onConfirm={() => void confirmSignOut()} />
    </SafeAreaView>
  );
}

function SignOutDialog({ visible, busy, onCancel, onConfirm }: { visible: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
    <View className="flex-1 items-center justify-center px-6">
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss sign out confirmation" disabled={busy} onPress={onCancel} className="absolute inset-0 bg-black/50" />
      <View accessibilityViewIsModal className="w-full max-w-[420px] rounded-2xl bg-white p-5 shadow-xl dark:bg-neutral-900">
        <View className="mb-3 h-11 w-11 items-center justify-center rounded-full bg-red-50 dark:bg-red-500/15"><LogOut size={20} color="#dc2626" /></View>
        <Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Sign out of Leverage?</Text>
        <Text className="font-body mt-2 text-sm leading-5 text-gray-600 dark:text-neutral-300">Your local financial records will stay on this device. Pending bill reminders for this profile will be removed.</Text>
        <View className="mt-5 flex-row justify-end gap-3">
          <Pressable accessibilityRole="button" disabled={busy} onPress={onCancel} className="min-h-11 min-w-24 items-center justify-center border border-gray-200 px-4 dark:border-neutral-700"><Text className="font-body font-semibold text-gray-700 dark:text-neutral-200">Cancel</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} disabled={busy} onPress={onConfirm} className="min-h-11 min-w-28 flex-row items-center justify-center bg-red-600 px-4">
            {busy ? <ActivityIndicator color="#fff" className="mr-2" /> : null}
            <Text className="font-body font-semibold text-white">{busy ? 'Signing out…' : 'Sign out'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

function RecoveryModal({ visible, onClose, onExport, onRestore }: {
  visible: boolean;
  onClose: () => void;
  onExport: (passphrase: string) => Promise<void>;
  onRestore: (backup: Uint8Array, passphrase: string) => Promise<void>;
}) {
  const { confirm, dialog } = useAppConfirm();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validate = () => {
    if (passphrase.length < 12 || passphrase.length > 256) return 'Use a passphrase between 12 and 256 characters.';
    if (confirmation !== passphrase) return 'The passphrases do not match.';
    return null;
  };
  const exportBackup = async () => {
    const message = validate();
    if (message) { setError(message); return; }
    setBusy(true); setError(null);
    try { await onExport(passphrase); Alert.alert('Encrypted backup created', 'Keep the backup file and passphrase in separate safe places. Leverage cannot recover a forgotten passphrase.'); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Backup could not be created.'); }
    finally { setBusy(false); }
  };
  const restoreBackup = async () => {
    if (passphrase.length < 12 || passphrase.length > 256) { setError('Enter the passphrase used to create this backup.'); return; }
    setBusy(true); setError(null);
    try {
      const bytes = await localDb.recovery.pickEncryptedBackup();
      if (!bytes) { setBusy(false); return; }
      const confirmed = await confirm({
        title: 'Replace local financial records?',
        message: 'Leverage will validate the backup first, then replace the records on this device. The current database is preserved unless the restored database passes verification.',
        confirmLabel: 'Validate and restore',
        destructive: true,
      });
      if (!confirmed) { setBusy(false); return; }
      await onRestore(bytes, passphrase);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Backup file could not be opened.'); setBusy(false); }
    finally { setBusy(false); }
  };
  return <><Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1 justify-end bg-black/40">
      <SafeAreaView edges={['bottom']} className="rounded-t-3xl bg-gray-50 px-5 pt-4 dark:bg-neutral-950" style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
        <View className="mb-3 flex-row items-center justify-between"><Text className="font-heading text-xl font-bold text-gray-900 dark:text-white">Encrypted backup</Text><Pressable accessibilityRole="button" accessibilityLabel="Close backup" onPress={onClose} className="min-h-11 min-w-11 items-center justify-center rounded-full bg-white dark:bg-neutral-800"><X size={20} color="#687386" /></Pressable></View>
        <Text className="font-body mb-3 text-sm leading-5 text-gray-600 dark:text-neutral-300">This file contains all local profiles on this device. Use a unique passphrase with at least 12 characters. A random salt and PBKDF2 protect the encrypted backup.</Text>
        <Input label="Backup passphrase" value={passphrase} onChangeText={setPassphrase} secureTextEntry={!showPassword} autoCapitalize="none" autoCorrect={false} error={undefined} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide passphrase' : 'Show passphrase'} onPress={() => setShowPassword((shown) => !shown)}>{showPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />
        <Input label="Confirm passphrase" value={confirmation} onChangeText={setConfirmation} secureTextEntry={!showPassword} autoCapitalize="none" autoCorrect={false} error={undefined} />
        {error ? <Text accessibilityRole="alert" className="font-body mb-3 text-sm text-red-600">{error}</Text> : null}
        <Button title="Create encrypted backup" onPress={() => void exportBackup()} isLoading={busy} />
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void restoreBackup()} className="mt-3 min-h-12 items-center justify-center"><Text className="font-body font-semibold text-primary">Choose backup file and restore</Text></Pressable>
        <Text className="font-body pb-4 pt-2 text-xs leading-5 text-gray-500 dark:text-neutral-400">Restore replaces this device’s local records after integrity, schema, profile, and financial checks. A successful restore signs you out.</Text>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>{dialog}</>;
}

function ProfileSecurityModal({ mode, fullName, currentProfileId, onClose, onSaveName, onChangePassword, loadProfiles, onSwitchProfile }: {
  mode: 'name' | 'password' | 'switch' | null;
  fullName: string;
  currentProfileId: string;
  onClose: () => void;
  onSaveName: (name: string) => Promise<void>;
  onChangePassword: (current: string, next: string) => Promise<void>;
  loadProfiles: () => Promise<ProfileRow[]>;
  onSwitchProfile: (profileId: string) => Promise<void>;
}) {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null);
  const profileLoadSequence = useRef(0);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const nameForm = useForm<ProfileNameForm>({ resolver: zodResolver(profileNameSchema), mode: 'onTouched', defaultValues: { fullName } });
  const passwordForm = useForm<ChangePasswordForm>({ resolver: zodResolver(changePasswordSchema), mode: 'onTouched', defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' } });

  const refreshProfiles = useCallback(async () => {
    const sequence = ++profileLoadSequence.current;
    await Promise.resolve();
    if (profileLoadSequence.current !== sequence) return;
    setLoadingProfiles(true);
    setProfileError(null);
    try {
      const result = await loadProfiles();
      if (profileLoadSequence.current === sequence) setProfiles(result);
    } catch (error) {
      if (profileLoadSequence.current === sequence) setProfileError(error instanceof Error ? error.message : 'Profiles could not be loaded.');
    } finally {
      if (profileLoadSequence.current === sequence) setLoadingProfiles(false);
    }
  }, [loadProfiles]);

  useEffect(() => {
    const loadingTimer = mode === 'switch' ? setTimeout(() => { void refreshProfiles(); }, 0) : undefined;
    return () => {
      if (loadingTimer !== undefined) clearTimeout(loadingTimer);
      profileLoadSequence.current += 1;
    };
  }, [mode, refreshProfiles, retry]);

  const submitName = async (data: ProfileNameForm) => {
    try { await onSaveName(data.fullName); onClose(); }
    catch (error) { nameForm.setError('fullName', { type: 'server', message: error instanceof Error ? error.message : 'Name could not be saved.' }); }
  };
  const submitPassword = async (data: ChangePasswordForm) => {
    try { await onChangePassword(data.currentPassword, data.newPassword); onClose(); Alert.alert('Password changed', 'Your local profile password was updated. Leverage cannot reset it remotely.'); }
    catch (error) { passwordForm.setError('currentPassword', { type: 'server', message: error instanceof Error ? error.message : 'Password could not be changed.' }); }
  };
  const chooseProfile = async (profile: ProfileRow) => {
    if (switchingProfile || profile.id === currentProfileId) return;
    setSwitchingProfile(profile.id);
    try { await onSwitchProfile(profile.id); }
    catch (error) {
      setProfileError(error instanceof Error ? error.message : 'The selected profile could not be prepared.');
      setSwitchingProfile(null);
    }
  };

  return (
    <Modal visible={mode !== null} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1 justify-end bg-black/40">
        <SafeAreaView edges={['bottom']} className="max-h-[90%] rounded-t-3xl bg-gray-50 dark:bg-neutral-950" style={{ paddingHorizontal: 20, paddingBottom: 20, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
          <View className="mb-4 flex-row items-center justify-between pt-4">
            <Text className="font-heading text-xl font-bold text-gray-900 dark:text-white">{mode === 'name' ? 'Edit display name' : mode === 'password' ? 'Change password' : 'Switch local profile'}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} className="min-h-11 min-w-11 items-center justify-center rounded-full bg-white dark:bg-neutral-800"><X size={20} color="#687386" /></Pressable>
          </View>
          {mode === 'name' ? <>
            <Text className="font-body mb-3 text-sm text-gray-600 dark:text-neutral-300">This name appears on this local profile.</Text>
            <Controller control={nameForm.control} name="fullName" render={({ field: { onChange, onBlur, value } }) => <Input label="Full name" placeholder="Your name" autoCapitalize="words" maxLength={60} onBlur={onBlur} onChangeText={onChange} value={value} error={nameForm.formState.errors.fullName?.message} />} />
            <Button title="Save name" onPress={nameForm.handleSubmit(submitName)} isLoading={nameForm.formState.isSubmitting} />
          </> : null}
          {mode === 'password' ? <>
            <Text className="font-body mb-3 text-sm leading-5 text-gray-600 dark:text-neutral-300">Enter the current password to replace it. There is no remote reset; forgetting it may make this local profile inaccessible.</Text>
            <Controller control={passwordForm.control} name="currentPassword" render={({ field: { onChange, onBlur, value } }) => <Input label="Current password" secureTextEntry={!showCurrentPassword} autoComplete="current-password" textContentType="password" onBlur={onBlur} onChangeText={onChange} value={value} error={passwordForm.formState.errors.currentPassword?.message} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showCurrentPassword ? 'Hide current password' : 'Show current password'} onPress={() => setShowCurrentPassword((visible) => !visible)} hitSlop={10}>{showCurrentPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />} />
            <Controller control={passwordForm.control} name="newPassword" render={({ field: { onChange, onBlur, value } }) => <Input label="New password" helperText="At least 10 characters, including an uppercase letter and a number." secureTextEntry={!showNewPassword} autoComplete="new-password" textContentType="newPassword" onBlur={onBlur} onChangeText={onChange} value={value} error={passwordForm.formState.errors.newPassword?.message} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showNewPassword ? 'Hide new password' : 'Show new password'} onPress={() => setShowNewPassword((visible) => !visible)} hitSlop={10}>{showNewPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />} />
            <Controller control={passwordForm.control} name="confirmPassword" render={({ field: { onChange, onBlur, value } }) => <Input label="Confirm new password" secureTextEntry={!showConfirmPassword} autoComplete="new-password" textContentType="newPassword" onBlur={onBlur} onChangeText={onChange} value={value} error={passwordForm.formState.errors.confirmPassword?.message} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'} onPress={() => setShowConfirmPassword((visible) => !visible)} hitSlop={10}>{showConfirmPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />} />
            <Button title="Change password" onPress={passwordForm.handleSubmit(submitPassword)} isLoading={passwordForm.formState.isSubmitting} />
          </> : null}
          {mode === 'switch' ? <>
            <Text className="font-body mb-3 text-sm leading-5 text-gray-600 dark:text-neutral-300">Choose a profile, then enter its password. Leverage will not authenticate it automatically.</Text>
            {loadingProfiles ? <View className="items-center py-6"><ActivityIndicator color={PRIMARY_COLOR} /><Text className="font-body mt-2 text-sm text-gray-500">Loading profiles…</Text></View> : null}
            {profileError ? <View className="py-2"><Text accessibilityRole="alert" className="font-body text-sm text-red-600">{profileError}</Text><Pressable accessibilityRole="button" onPress={() => setRetry((value) => value + 1)} className="mt-3 min-h-11 justify-center"><Text className="font-body font-semibold text-primary">Retry</Text></Pressable></View> : null}
            {!loadingProfiles && !profileError ? <ScrollView keyboardShouldPersistTaps="handled">
              {profiles.filter((profile) => profile.id !== currentProfileId).map((profile) => <Pressable key={profile.id} accessibilityRole="button" accessibilityLabel={`Sign in to ${profile.fullName}`} disabled={switchingProfile !== null} onPress={() => void chooseProfile(profile)} className="mb-2 min-h-14 flex-row items-center justify-between rounded-xl bg-white px-4 dark:bg-neutral-900"><View><Text className="font-body font-semibold text-gray-900 dark:text-white">{profile.fullName}</Text><Text className="font-body mt-1 text-sm text-gray-500 dark:text-neutral-400">{profile.email}</Text></View>{switchingProfile === profile.id ? <ActivityIndicator color={PRIMARY_COLOR} /> : <ChevronRight size={18} color="#9ca3af" />}</Pressable>)}
              {profiles.length > 0 && profiles.every((profile) => profile.id === currentProfileId) ? <Text className="font-body py-3 text-sm text-gray-500 dark:text-neutral-400">No other local profiles are available.</Text> : null}
              {profiles.length === 0 ? <Text className="font-body py-3 text-sm text-gray-500 dark:text-neutral-400">No local profiles are available.</Text> : null}
            </ScrollView> : null}
          </> : null}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
