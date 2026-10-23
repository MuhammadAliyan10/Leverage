import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, Alert, Modal, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { useColorScheme } from 'nativewind';
import { Building2, Target, PiggyBank, CalendarClock, Moon, Coins, CloudSync, LogOut, ChevronRight, TrendingUp, UserRound, KeyRound, UsersRound, X, Eye, EyeOff } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/context/AuthContext';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { changePasswordSchema, profileNameSchema, type ChangePasswordForm, type ProfileNameForm } from '../../utils/validations/profile';
import type { DbUser } from '../../src/db/local/client';

interface SettingRowProps {
  icon: LucideIcon;
  title: string;
  isDanger?: boolean;
  onPress?: () => void;
  rightComponent?: React.ReactNode;
  showChevron?: boolean;
}

const SettingRow: React.FC<SettingRowProps> = ({ 
  icon: Icon, 
  title, 
  isDanger = false, 
  onPress, 
  rightComponent, 
  showChevron = false 
}) => {
  return (
    <TouchableOpacity 
      onPress={onPress}
      className={`flex-row items-center justify-between py-4 border-b border-gray-100 dark:border-neutral-800 active:opacity-70`}
      disabled={!onPress}
    >
      <View className="flex-row items-center">
        <View className={`h-9 w-9 items-center justify-center rounded-full ${isDanger ? 'bg-red-100 dark:bg-red-500/20' : 'bg-primary/10 dark:bg-primary/20'}`}>
          <Icon size={18} color={isDanger ? '#ef4444' : PRIMARY_COLOR} />
        </View>
        <Text className={["font-body", (`ml-4 text-base font-semibold ${isDanger ? 'text-red-500' : 'text-gray-900 dark:text-white'}`)].filter(Boolean).join(' ')}>
          {title}
        </Text>
      </View>
      <View className="flex-row items-center">
        {rightComponent}
        {showChevron && <ChevronRight size={20} color="#9ca3af" className="ml-2" />}
      </View>
    </TouchableOpacity>
  );
};

export default function SettingsScreen() {
  const { colorScheme, toggleColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();
  const { user, signOut, updateProfileName, changePassword, listProfiles } = useAuth();
  const [securityPanel, setSecurityPanel] = useState<'name'|'password'|'switch'|null>(null);

  const userInitials = user?.fullName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? '?';

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => signOut() }
    ]);
  };

  const switchToProfile = async (email: string) => {
    setSecurityPanel(null);
    await signOut();
    router.replace({ pathname: '/(auth)', params: { email } });
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <GlobalHeader 
        title="Settings" 
        description="Manage your app and data" 
      />

      <ScrollView className="flex-1 px-6 pt-4" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
        
        {/* User Profile Card */}
        <View className="mb-6 flex-row items-center rounded-3xl bg-white dark:bg-neutral-900 p-5">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-primary">
            <Text className="font-heading text-2xl font-bold text-white">{userInitials}</Text>
          </View>
          <View className="ml-4 flex-1">
            <Text className="font-heading text-xl font-bold text-gray-900 dark:text-white">{user?.fullName ?? '—'}</Text>
            <Text className="font-body text-sm text-gray-500 dark:text-neutral-400 mt-0.5">{user?.email ?? '—'}</Text>
          </View>
        </View>

        <View className="mb-6 rounded-3xl bg-white p-5 shadow-sm dark:bg-neutral-900">
          <Text className="font-body mb-2 text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Profile & Security</Text>
          <SettingRow icon={UserRound} title="Edit display name" showChevron onPress={() => setSecurityPanel('name')} />
          <SettingRow icon={KeyRound} title="Change password" showChevron onPress={() => setSecurityPanel('password')} />
          <SettingRow icon={UsersRound} title="Switch local profile" showChevron onPress={() => setSecurityPanel('switch')} />
          <Text className="font-body mt-3 text-xs leading-5 text-gray-500 dark:text-neutral-400">These profiles exist only on this device. Switching requires the selected profile’s password.</Text>
        </View>

        <View className="space-y-6">
          
          {/* Financial Management */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
            <Text className="font-body mb-2 text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Financial Management</Text>
            <SettingRow 
              icon={Building2} 
              title="Manage Accounts" 
              showChevron 
              onPress={() => router.push('/accounts')}
            />
            <SettingRow 
              icon={Target} 
              title="Monthly Budgets" 
              showChevron 
              onPress={() => router.push('/budgets')} 
            />
            <SettingRow
              icon={PiggyBank}
              title="Savings & Emergency Fund"
              showChevron
              onPress={() => router.push('/savings')}
            />
            <SettingRow
              icon={CalendarClock}
              title="Recurring, Bills & Debt"
              showChevron
              onPress={() => router.push('/obligations')}
            />
            <SettingRow
              icon={TrendingUp}
              title="Assets, Investments & Net Worth"
              showChevron
              onPress={() => router.push('/assets')}
            />
          </View>

          {/* Preferences */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
            <Text className="font-body mb-2 text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Preferences</Text>
            <SettingRow 
              icon={Moon} 
              title="Dark Mode" 
              rightComponent={
                <Switch 
                  value={isDark} 
                  onValueChange={toggleColorScheme} 
                  trackColor={{ false: '#d1d5db', true: PRIMARY_COLOR }}
                  thumbColor="#ffffff"
                />
              } 
            />
            <SettingRow 
              icon={Coins} 
              title="Currency" 
              rightComponent={
                <Text className="font-body text-base font-bold text-gray-500 dark:text-neutral-400">PKR</Text>
              } 
            />
          </View>

          {/* Data & Sync */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none">
            <Text className="font-body mb-2 text-sm font-bold uppercase tracking-wider text-gray-400 dark:text-neutral-500">Data & Sync</Text>
            <SettingRow 
              icon={CloudSync} 
              title="Cloud Sync" 
              rightComponent={
                <Text className="font-body text-sm text-gray-500 dark:text-neutral-400">Local only</Text>
              }
            />
          </View>

          {/* Danger Zone */}
          <View className="rounded-3xl bg-white dark:bg-neutral-900 p-5 shadow-sm shadow-gray-200 dark:shadow-none mb-10">
            <Text className="font-body mb-2 text-sm font-bold uppercase tracking-wider text-red-500/70">Danger Zone</Text>
            <SettingRow 
              icon={LogOut} 
              title="Sign Out" 
              isDanger 
              onPress={handleSignOut} 
            />
          </View>
          
        </View>

      </ScrollView>
      <ProfileSecurityModal
        key={securityPanel ?? 'closed'}
        mode={securityPanel}
        fullName={user?.fullName ?? ''}
        currentEmail={user?.email ?? ''}
        onClose={() => setSecurityPanel(null)}
        onSaveName={updateProfileName}
        onChangePassword={changePassword}
        loadProfiles={listProfiles}
        onSwitchProfile={(email) => void switchToProfile(email)}
      />
    </SafeAreaView>
  );
}

type ProfileRow = Omit<DbUser, 'passwordHash'>;

function ProfileSecurityModal({
  mode, fullName, currentEmail, onClose, onSaveName, onChangePassword, loadProfiles, onSwitchProfile,
}: {
  mode: 'name'|'password'|'switch'|null;
  fullName: string;
  currentEmail: string;
  onClose: () => void;
  onSaveName: (name: string) => Promise<void>;
  onChangePassword: (current: string, next: string) => Promise<void>;
  loadProfiles: () => Promise<ProfileRow[]>;
  onSwitchProfile: (email: string) => void;
}) {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const nameForm = useForm<ProfileNameForm>({ resolver: zodResolver(profileNameSchema), mode: 'onTouched', defaultValues: { fullName } });
  const passwordForm = useForm<ChangePasswordForm>({ resolver: zodResolver(changePasswordSchema), mode: 'onTouched', defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' } });
  useEffect(() => {
    if (mode !== 'switch') return;
    let active = true;
    void loadProfiles().then((result) => { if (active) { setProfiles(result); setProfileError(null); } }).catch(() => { if (active) setProfileError('Profiles could not be loaded. Try again.'); });
    return () => { active = false; };
  }, [mode, loadProfiles]);

  const submitName = async (data: ProfileNameForm) => {
    try { await onSaveName(data.fullName); onClose(); }
    catch (error) { nameForm.setError('fullName', { type: 'server', message: error instanceof Error ? error.message : 'Name could not be saved.' }); }
  };
  const submitPassword = async (data: ChangePasswordForm) => {
    try { await onChangePassword(data.currentPassword, data.newPassword); onClose(); Alert.alert('Password changed', 'Your local profile password was updated. Keep it somewhere safe; HouseLog cannot reset it.'); }
    catch (error) { passwordForm.setError('currentPassword', { type: 'server', message: error instanceof Error ? error.message : 'Password could not be changed.' }); }
  };

  return (
    <Modal visible={mode !== null} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1 justify-end bg-black/40">
        <SafeAreaView className="max-h-[90%] rounded-t-3xl bg-gray-50 px-5 pb-5 dark:bg-neutral-950">
          <View className="mb-4 flex-row items-center justify-between pt-4">
            <Text className="font-heading text-xl font-bold text-gray-900 dark:text-white">{mode === 'name' ? 'Edit display name' : mode === 'password' ? 'Change password' : 'Switch local profile'}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} className="min-h-11 min-w-11 items-center justify-center rounded-full bg-white dark:bg-neutral-800"><X size={20} color="#687386" /></Pressable>
          </View>
          {mode === 'name' ? <>
            <Text className="font-body mb-4 text-sm text-gray-600 dark:text-neutral-300">This name appears in your local profile.</Text>
            <Controller control={nameForm.control} name="fullName" render={({ field: { onChange, onBlur, value } }) => <Input label="Full name" placeholder="Your name" autoCapitalize="words" maxLength={60} onBlur={onBlur} onChangeText={onChange} value={value} error={nameForm.formState.errors.fullName?.message} />} />
            <Button title="Save name" onPress={nameForm.handleSubmit(submitName)} isLoading={nameForm.formState.isSubmitting} />
          </> : null}
          {mode === 'password' ? <>
            <Text className="font-body mb-4 text-sm leading-5 text-gray-600 dark:text-neutral-300">Enter your current password to replace it. There is no remote reset; forgetting it may make this local profile inaccessible.</Text>
            <Controller control={passwordForm.control} name="currentPassword" render={({ field: { onChange, onBlur, value } }) => <Input label="Current password" secureTextEntry={!showCurrentPassword} autoComplete="current-password" textContentType="password" onBlur={onBlur} onChangeText={onChange} value={value} error={passwordForm.formState.errors.currentPassword?.message} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showCurrentPassword ? 'Hide current password' : 'Show current password'} onPress={() => setShowCurrentPassword((visible) => !visible)} hitSlop={10}>{showCurrentPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />} />
            <Controller control={passwordForm.control} name="newPassword" render={({ field: { onChange, onBlur, value } }) => <Input label="New password" helperText="At least 10 characters, including an uppercase letter and a number." secureTextEntry={!showNewPassword} autoComplete="new-password" textContentType="newPassword" onBlur={onBlur} onChangeText={onChange} value={value} error={passwordForm.formState.errors.newPassword?.message} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showNewPassword ? 'Hide new password' : 'Show new password'} onPress={() => setShowNewPassword((visible) => !visible)} hitSlop={10}>{showNewPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />} />
            <Controller control={passwordForm.control} name="confirmPassword" render={({ field: { onChange, onBlur, value } }) => <Input label="Confirm new password" secureTextEntry={!showConfirmPassword} autoComplete="new-password" textContentType="newPassword" onBlur={onBlur} onChangeText={onChange} value={value} error={passwordForm.formState.errors.confirmPassword?.message} trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'} onPress={() => setShowConfirmPassword((visible) => !visible)} hitSlop={10}>{showConfirmPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>} />} />
            <Button title="Change password" onPress={passwordForm.handleSubmit(submitPassword)} isLoading={passwordForm.formState.isSubmitting} />
          </> : null}
          {mode === 'switch' ? <>
            <Text className="font-body mb-4 text-sm leading-5 text-gray-600 dark:text-neutral-300">Choose another profile, then sign in with that profile’s password. Your financial records stay separate.</Text>
            {profileError ? <Text accessibilityRole="alert" className="font-body mb-3 text-sm text-red-600">{profileError}</Text> : null}
            <ScrollView keyboardShouldPersistTaps="handled">
              {profiles.filter((profile) => profile.email !== currentEmail).map((profile) => <Pressable key={profile.id} accessibilityRole="button" accessibilityLabel={`Switch to ${profile.fullName}`} onPress={() => onSwitchProfile(profile.email)} className="mb-2 rounded-2xl bg-white p-4 dark:bg-neutral-900"><Text className="font-body font-semibold text-gray-900 dark:text-white">{profile.fullName}</Text><Text className="font-body mt-1 text-sm text-gray-500 dark:text-neutral-400">{profile.email}</Text></Pressable>)}
              {profiles.length > 0 && profiles.every((profile) => profile.email === currentEmail) ? <Text className="font-body text-sm text-gray-500 dark:text-neutral-400">No other local profiles are available.</Text> : null}
            </ScrollView>
          </> : null}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
