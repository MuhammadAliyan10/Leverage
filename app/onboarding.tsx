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

const onboardingSchema = z.object({
  name: z.string().min(2, 'Account name must be at least 2 characters'),
  type: z.string().min(2, 'Account type is required'),
  balance: z.string().refine((val) => !isNaN(Number(val)), 'Must be a valid number'),
});

type OnboardingFormData = z.infer<typeof onboardingSchema>;

export default function OnboardingScreen() {
  const router = useRouter();

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
      await localDb.account.create({
        data: {
          name: data.name,
          type: data.type,
          balance: parseFloat(data.balance),
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
          <Text className="font-fargie text-3xl font-bold text-black text-center">Let's set up your first account.</Text>
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
                placeholder="Account Type (e.g. Cash, Bank)"
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
