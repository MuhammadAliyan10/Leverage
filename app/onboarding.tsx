import { PRIMARY_COLOR } from '../src/constants/themeColors';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, Banknote, Building2, Check, CircleEllipsis, PiggyBank, Smartphone, TrendingUp, Wallet } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { localDb } from '../src/db/local/client';
import { parseMinorUnits } from '../src/finance/ledger';
import { CURRENCIES } from '../src/finance/domain';
import { useAuth } from '../src/context/AuthContext';
import { onboardingSchema, type OnboardingFormData } from '../utils/validations/onboarding';

const ACCOUNT_OPTIONS = [
  { value: 'cash', label: 'Cash', description: 'Money on hand', Icon: Banknote },
  { value: 'bank', label: 'Bank', description: 'Current account', Icon: Building2 },
  { value: 'savings', label: 'Savings', description: 'Savings account', Icon: PiggyBank },
  { value: 'wallet', label: 'Mobile wallet', description: 'Wallet or payment app', Icon: Smartphone },
  { value: 'investment', label: 'Investment', description: 'Investment account', Icon: TrendingUp },
  { value: 'other', label: 'Other', description: 'Another money account', Icon: Wallet },
] as const;

const SUBMIT_CLASS = 'houselog-button w-full flex-row items-center justify-center py-3.5 active:opacity-90';

export default function OnboardingScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [createdAccountName, setCreatedAccountName] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<OnboardingFormData>({
    resolver: zodResolver(onboardingSchema),
    mode: 'onTouched',
    reValidateMode: 'onChange',
    defaultValues: { name: '', type: 'bank', currency: 'PKR', balance: '' },
  });
  const selectedCurrency = useWatch({ control, name: 'currency' });

  const onSubmit = async (data: OnboardingFormData) => {
    setSaveError(null);
    try {
      if (!user) throw new Error('Your session expired. Sign in again before setting up an account.');
      const normalizedBalance = data.balance.trim();
      const balanceMinor = !normalizedBalance || /^0+(?:\.0+)?$/.test(normalizedBalance)
        ? 0
        : parseMinorUnits(normalizedBalance);
      const result = await localDb.user.completeOnboarding(user.id, {
        name: data.name,
        type: data.type,
        balanceMinor,
          currency: data.currency,
      });
      setCreatedAccountName(result.account.name);
    } catch (error) {
      const internalMessage = error instanceof Error ? error.message : '';
      const knownMessage = /^(Your local profile|Setup is complete|The first account|Choose a supported|Account names?|Starting balance)/.test(internalMessage);
      const message = knownMessage ? internalMessage : 'Your account could not be saved. Existing financial records were not changed. Check device storage and try again.';
      setSaveError(message);
      setError('root', { type: 'server', message });
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1">
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View className="w-full max-w-[560px] self-center">
            {createdAccountName ? (
              <View className="rounded-3xl border border-gray-100 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="mb-5 h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 dark:bg-emerald-950">
                  <Check size={28} color="#059669" />
                </View>
                <Text className="font-heading text-2xl font-bold text-gray-900 dark:text-white">You’re ready to start</Text>
                <Text className="font-body mt-2 text-sm leading-6 text-gray-600 dark:text-neutral-300">
                  {createdAccountName} is set up. Your opening balance is recorded as money already in the account, not income.
                </Text>
                <Button
                  title="Open dashboard"
                  className="mt-6"
                  onPress={() => router.replace('/(tabs)')}
                  accessibilityRole="button"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Record your first transaction"
                  onPress={() => router.replace('/(tabs)/add')}
                  className="mt-3 min-h-12 flex-row items-center justify-center rounded-full border border-gray-200 dark:border-neutral-700"
                >
                  <Text className="font-body font-semibold text-primary">Record your first transaction</Text>
                  <ArrowRight size={17} color={PRIMARY_COLOR} className="ml-2" />
                </Pressable>
              </View>
            ) : <>
            <View className="mb-7 flex-row items-center">
              <View className="mr-3 h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                <Wallet size={25} color={PRIMARY_COLOR} />
              </View>
              <View>
                <Text className="font-body text-sm font-bold tracking-wide text-primary">HOUSELOG SETUP</Text>
                <Text className="font-body mt-0.5 text-xs text-gray-500 dark:text-neutral-400">First account · You can add more later</Text>
              </View>
            </View>

            <View className="mb-7">
              <View className="mb-4 h-1.5 overflow-hidden rounded-full bg-gray-200">
                <View className="h-full w-full rounded-full bg-primary" />
              </View>
              <Text className="font-heading text-3xl font-bold tracking-tight text-[#1b2935] dark:text-white">Start with an account</Text>
              <Text className="font-body mt-2 text-base leading-6 text-[#66717e] dark:text-neutral-300">
                Add where you keep your money. You can create more accounts any time.
              </Text>
            </View>

            <View className="mb-5 rounded-3xl border border-gray-100 bg-white p-5 shadow-sm">
              <View className="mb-4">
                <Text className="font-body text-base font-bold text-gray-900">Name your account</Text>
                <Text className="font-body mt-1 text-sm leading-5 text-gray-500">Use a name you will recognize, like “Main bank” or “Wallet cash”.</Text>
              </View>
              <Controller
                control={control}
                name="name"
                render={({ field: { onChange, onBlur, value } }) => (
                  <Input
                    label="Account name"
                    placeholder="e.g. Main bank account"
                    variant="pill"
                    autoCapitalize="words"
                    autoComplete="off"
                    maxLength={80}
                    returnKeyType="next"
                    onBlur={onBlur}
                    onChangeText={onChange}
                    value={value}
                    error={errors.name?.message}
                  />
                )}
              />
            </View>

            <View className="mb-5 rounded-3xl border border-gray-100 bg-white p-5 shadow-sm">
              <View className="mb-4">
                <Text className="font-body text-base font-bold text-gray-900">Choose the account type</Text>
                <Text className="font-body mt-1 text-sm leading-5 text-gray-500">This helps Mizan organize your balances.</Text>
              </View>
              <Controller
                control={control}
                name="type"
                render={({ field: { onChange, value } }) => (
                  <View>
                    <View className="flex-row flex-wrap justify-between">
                      {ACCOUNT_OPTIONS.map(({ value: option, label, description, Icon }) => {
                        const selected = value === option;
                        return (
                          <Pressable
                            key={option}
                            accessibilityRole="radio"
                            accessibilityState={{ selected }}
                            accessibilityLabel={`${label}: ${description}`}
                            onPress={() => onChange(option)}
                            className={`mb-3 min-h-[84px] w-[48.5%] flex-row items-center rounded-2xl border p-3 ${selected ? 'border-primary bg-primary/5' : 'border-gray-200 bg-white'}`}
                          >
                            <View className={`mr-2.5 h-10 w-10 items-center justify-center rounded-xl ${selected ? 'bg-primary/10' : 'bg-gray-100'}`}>
                              <Icon size={20} color={selected ? PRIMARY_COLOR : '#748092'} />
                            </View>
                            <View className="min-w-0 flex-1">
                              <Text className={["font-body", (`text-sm font-semibold ${selected ? 'text-primary' : 'text-gray-800'}`)].filter(Boolean).join(' ')}>{label}</Text>
                              <Text className="font-body mt-0.5 text-[11px] leading-4 text-gray-500">{description}</Text>
                            </View>
                            {selected && <Check size={15} color={PRIMARY_COLOR} />}
                          </Pressable>
                        );
                      })}
                    </View>
                    {errors.type?.message && (
                      <Text accessibilityRole="alert" className="font-body mt-1 text-sm text-red-600">{errors.type.message}</Text>
                    )}
                  </View>
                )}
              />
            </View>

            <View className="mb-5 rounded-3xl border border-gray-100 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <Text className="font-body mb-1 text-base font-bold text-gray-900 dark:text-white">Account currency</Text>
              <Text className="font-body mb-4 text-sm leading-5 text-gray-500 dark:text-neutral-400">PKR is selected by default. Choose the currency this account actually uses.</Text>
              <Controller control={control} name="currency" render={({ field: { onChange, value } }) => (
                <View className="flex-row flex-wrap">
                  {Object.entries(CURRENCIES).map(([code, currency]) => {
                    const selected = value === code;
                    return <Pressable key={code} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${code}, ${currency.label}`} onPress={() => onChange(code)} className={`mb-2 mr-2 min-h-11 justify-center rounded-full border px-4 ${selected ? 'border-primary bg-primary/10' : 'border-gray-200 dark:border-neutral-700'}`}><Text className={["font-body", (`text-sm font-semibold ${selected ? 'text-primary' : 'text-gray-700 dark:text-neutral-200'}`)].filter(Boolean).join(' ')}>{code}</Text></Pressable>;
                  })}
                </View>
              )} />
              {errors.currency?.message ? <Text accessibilityRole="alert" className="font-body mt-1 text-sm text-red-600">{errors.currency.message}</Text> : null}
            </View>

            <View className="mb-5 rounded-3xl border border-gray-100 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
              <View className="mb-4">
                <Text className="font-body text-base font-bold text-gray-900 dark:text-white">Opening balance</Text>
                <Text className="font-body mt-1 text-sm leading-5 text-gray-500">
                  Enter what is already in this account. Leave it empty if the balance is zero.
                </Text>
              </View>
              <Controller
                control={control}
                name="balance"
                render={({ field: { onChange, onBlur, value } }) => (
                  <Input
                    label={`Starting amount in ${selectedCurrency}`}
                    placeholder="0.00"
                    helperText="Use digits and up to two decimal places. This sets the starting balance; it does not create income."
                    variant="pill"
                    leadingIcon={<Text className="font-body text-sm font-bold text-gray-600">Rs</Text>}
                    keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
                    autoComplete="off"
                    maxLength={18}
                    returnKeyType="done"
                    onBlur={onBlur}
                    onChangeText={onChange}
                    value={value}
                    error={errors.balance?.message}
                  />
                )}
              />
            </View>

            {saveError && (
              <Text accessibilityRole="alert" className="font-body mb-4 rounded-2xl bg-red-50 p-3 text-sm leading-5 text-red-700">
                {saveError}
              </Text>
            )}
            {errors.root?.message && !saveError && (
              <Text accessibilityRole="alert" className="font-body mb-4 text-sm text-red-700">{errors.root.message}</Text>
            )}

            <Button
              title="Create account"
              className={`${SUBMIT_CLASS} ${isSubmitting ? 'opacity-60' : ''}`}
              onPress={handleSubmit(onSubmit)}
              isLoading={isSubmitting}
            />
            <View className="mt-4 flex-row items-start justify-center px-3">
              <CircleEllipsis size={15} color="#8490a0" />
              <Text className="font-body ml-2 flex-1 text-center text-xs leading-5 text-gray-500">
                Your opening balance is kept separate from income and expenses. You can change account details later.
              </Text>
            </View>
            <Text className="font-body mt-4 text-center text-xs leading-5 text-gray-500 dark:text-neutral-400">
              Mizan is offline-first. This profile and its records stay on this device; browser profiles do not automatically sync to Android. Password recovery is not available yet.
            </Text>
            </>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
