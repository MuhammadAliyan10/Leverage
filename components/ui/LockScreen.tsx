import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Eye, EyeOff, Fingerprint, LockKeyhole } from 'lucide-react-native';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from './Button';
import { Input } from './Input';

const schema = z.object({ password: z.string().min(1, 'Enter your profile password.') });
type FormData = z.infer<typeof schema>;

interface LockScreenProps {
  onUnlockPassword: (password: string) => Promise<{ success: boolean; error?: string }>;
  onUnlockBiometric: () => Promise<boolean>;
  checkBiometricAvailability: () => Promise<boolean>;
  biometricEnabled: boolean;
}

export function LockScreen({ onUnlockPassword, onUnlockBiometric, checkBiometricAvailability, biometricEnabled }: LockScreenProps) {
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const { control, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema), mode: 'onTouched', defaultValues: { password: '' },
  });

  useEffect(() => {
    let active = true;
    void checkBiometricAvailability().then((available) => { if (active) setBiometricAvailable(available && biometricEnabled); });
    return () => { active = false; };
  }, [checkBiometricAvailability, biometricEnabled]);

  const submitPassword = async (data: FormData) => {
    const result = await onUnlockPassword(data.password);
    if (!result.success) setError('password', { type: 'server', message: result.error ?? 'Password could not unlock this profile.' });
  };

  const tryBiometric = async () => {
    if (biometricBusy) return;
    setBiometricBusy(true);
    try {
      const success = await onUnlockBiometric();
      if (!success) setError('password', { type: 'server', message: 'Biometric unlock was cancelled or unavailable. Enter your profile password instead.' });
    } finally { setBiometricBusy(false); }
  };

  return (
    <SafeAreaView className="absolute inset-0 z-50 flex-1 items-center justify-center bg-[#f8f9fc] px-6 dark:bg-neutral-950">
      <View className="w-full max-w-[420px] rounded-3xl bg-white p-6 dark:bg-neutral-900">
        <View className="mb-5 h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <LockKeyhole size={27} color={PRIMARY_COLOR} />
        </View>
        <Text className="font-heading text-2xl font-bold text-gray-900 dark:text-white">Welcome back</Text>
        <Text className="font-body mt-2 text-sm leading-5 text-gray-600 dark:text-neutral-300">
          Unlock this local profile with its password. A saved device session alone does not open your financial data.
        </Text>

        <Controller control={control} name="password" render={({ field: { onChange, onBlur, value } }) => (
          <Input
            label="Profile password"
            placeholder="Enter your password"
            variant="pill"
            leadingIcon={<LockKeyhole size={17} color="#7b8495" />}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="done"
            onBlur={onBlur}
            onChangeText={onChange}
            onSubmitEditing={handleSubmit(submitPassword)}
            value={value}
            error={errors.password?.message}
            trailingAction={<Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} hitSlop={10} onPress={() => setShowPassword((visible) => !visible)} className="p-1">{showPassword ? <EyeOff size={19} color="#737d8d" /> : <Eye size={19} color="#737d8d" />}</Pressable>}
          />
        )} />

        <Button title="Unlock with password" onPress={handleSubmit(submitPassword)} isLoading={isSubmitting} accessibilityRole="button" accessibilityLabel="Unlock Leverage with profile password" />
        {biometricAvailable ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Unlock with biometrics" disabled={biometricBusy} onPress={() => void tryBiometric()} className="mt-3 min-h-12 flex-row items-center justify-center rounded-full border border-gray-200 dark:border-neutral-700">
            <Fingerprint size={19} color={PRIMARY_COLOR} />
            <Text className="font-body ml-2 font-semibold text-primary">{biometricBusy ? 'Waiting for device…' : 'Use biometrics'}</Text>
          </Pressable>
        ) : null}
        <Text className="font-body mt-4 text-center text-xs leading-5 text-gray-500 dark:text-neutral-400">
          Forgotten passwords cannot currently be reset. Your local financial records remain on this device.
        </Text>
      </View>
    </SafeAreaView>
  );
}
