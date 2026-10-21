import React from 'react';
import { View, Text, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'expo-router';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { localDb } from '../src/db/local/client';
import { parseMinorUnits } from '../src/finance/ledger';
import { useAuth } from '../src/context/AuthContext';
import { normalizeAccountType } from '../src/finance/domain';

const onboardingSchema = z.object({
  name: z.string().min(2, 'Account name must be at least 2 characters'),
  type: z.string().refine((value) => normalizeAccountType(value) !== null, 'Choose Cash, Bank, Savings, Mobile wallet, Investment or Other'),
  balance: z.string().refine((value) => {
    if (/^0+(?:\.0+)?$/.test(value.trim())) return true;
    try {
      parseMinorUnits(value);
      return true;
    } catch {
      return false;
    }
  }, 'Enter a valid amount with up to two decimal places'),
});

type OnboardingFormData = z.infer<typeof onboardingSchema>;

export default function OnboardingScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<OnboardingFormData>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      type: 'Bank',
      balance: '0',
    }
  });

  const onSubmit = async (data: OnboardingFormData) => {
    try {
      if (!user) throw new Error('Sign in before creating an account.');
      await localDb.account.create({
        data: {
          ownerId: user.id,
          name: data.name,
          type: data.type,
          balanceMinor: /^0+(?:\.0+)?$/.test(data.balance.trim()) ? 0 : parseMinorUnits(data.balance),
          currency: 'PKR',
        },
      });
      router.replace('/(tabs)');
    } catch (error) {
      console.error('Failed to create account:', error);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 justify-center px-6"
      >
        <View className="mb-10 items-center">
          <Text className="font-fargie text-3xl font-bold text-black text-center">Let&apos;s set up your first account.</Text>
          <Text className="text-gray-500 mt-2 text-center">Create your main account to start tracking your finances.</Text>
        </View>

        <View className="w-full">
          <Controller
            control={control}
            name="name"
            render={({ field: { onChange, onBlur, value } }) => (
              <Input
                placeholder="Account Name (e.g. Meezan Bank)"
                onBlur={onBlur}
                onChangeText={onChange}
                value={value}
                error={errors.name?.message}
              />
            )}
          />

          <Controller
            control={control}
            name="type"
            render={({ field: { onChange, onBlur, value } }) => (
              <Input
                placeholder="Cash, Bank, Savings, Mobile wallet, Investment or Other"
                onBlur={onBlur}
                onChangeText={onChange}
                value={value}
                error={errors.type?.message}
              />
            )}
          />

          <View className="relative mb-4">
            <View className="absolute left-4 top-[14px] z-10">
              <Text className="text-base font-bold text-gray-500">PKR</Text>
            </View>
            <Controller
              control={control}
              name="balance"
              render={({ field: { onChange, onBlur, value } }) => (
                <Input
                  placeholder="Initial Balance"
                  keyboardType="numeric"
                  onBlur={onBlur}
                  onChangeText={onChange}
                  value={value}
                  error={errors.balance?.message}
                  style={{ paddingLeft: 60 }}
                />
              )}
            />
          </View>

          <Button
            title="Complete Setup"
            onPress={handleSubmit(onSubmit)}
            isLoading={isSubmitting}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
