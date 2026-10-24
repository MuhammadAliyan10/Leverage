import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, KeyboardAvoidingView, Platform, Pressable, TextInput, ScrollView, ActivityIndicator } from 'react-native';
import { useColorScheme } from 'nativewind';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DatePickerModal, TimePickerModal, en, registerTranslation } from 'react-native-paper-dates';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';
import { CalendarDays, ChevronLeft, ChevronRight, CircleHelp, Clock3, Keyboard, Pencil, Search, X } from 'lucide-react-native';
import { Button } from '../../components/ui/Button';
import { useAddTransaction } from '../../hooks/mutations/useAddTransaction';
import { convertForeignMinorToPkr, formatMinorUnits, formatMinorUnitsForInput, parseExchangeRate, parseMinorUnits } from '../../src/finance/ledger';
import { useAccounts } from '../../hooks/queries/useAccounts';
import * as Crypto from 'expo-crypto';
import { useAuth } from '../../src/context/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import Toast from 'react-native-toast-message';
import {
  CLASSIFICATIONS,
  EXPENSE_CLASSIFICATION_IDS,
  INCOME_CLASSIFICATION_IDS,
  pakistanTaxYear,
  CURRENCIES,
  isCurrencyCode,
  resolveClassification,
} from '../../src/finance/domain';

// 1. Zod Validation Schema
const addTransactionSchema = z.object({
  amount: z.string()
    .min(1, 'Amount is required')
    .refine((value) => {
      try {
        parseMinorUnits(value);
        return true;
      } catch {
        return false;
      }
    }, 'Enter an amount with up to two decimal places'),
  type: z.enum(['Expense', 'Income', 'Transfer']),
  categoryId: z.string(),
  accountId: z.string().min(1, 'Account is required'),
  toAccountId: z.string().optional(),
  date: z.date(),
  note: z.string().optional(),
  sourceName: z.string().optional(),
  paymentMethod: z.string().optional(),
  sourceAmount: z.string().optional(),
  sourceCurrency: z.string().optional(),
  exchangeRate: z.string().optional(),
  referenceNumber: z.string().optional(),
  taxStatus: z.enum(['unreviewed', 'taxable', 'non_taxable']).optional(),
}).superRefine((data, context) => {
  const classificationId = resolveClassification(data.categoryId);
  if (data.type !== 'Transfer' && (!classificationId || CLASSIFICATIONS[classificationId].type !== data.type)) {
    context.addIssue({ code: 'custom', message: 'Choose a category that matches this transaction.', path: ['categoryId'] });
  }
  if (data.note && data.note.length > 2000) context.addIssue({ code: 'custom', message: 'Keep notes to 2,000 characters or fewer.', path: ['note'] });
  if (data.sourceName && data.sourceName.length > 160) context.addIssue({ code: 'custom', message: 'Keep payer or sender details to 160 characters or fewer.', path: ['sourceName'] });
  if (data.type === 'Income' && (data.categoryId === 'family_gift' || data.categoryId === 'foreign_remittance') && !data.sourceName?.trim()) {
    context.addIssue({ code: 'custom', message: data.categoryId === 'family_gift' ? 'Record who gave you this gift.' : 'Record who sent you this remittance.', path: ['sourceName'] });
  }
  if (data.referenceNumber && data.referenceNumber.length > 120) context.addIssue({ code: 'custom', message: 'Reference numbers must be 120 characters or fewer.', path: ['referenceNumber'] });
}).superRefine((data, context) => {
  if (data.type === 'Transfer' && (!data.toAccountId || data.toAccountId === data.accountId)) {
    context.addIssue({ code: 'custom', message: 'Choose a different destination account.', path: ['toAccountId'] });
  }
  if (data.type === 'Income' && data.categoryId === 'foreign_remittance') {
    if (!data.sourceCurrency) context.addIssue({ code: 'custom', message: 'Choose the original currency.', path: ['sourceCurrency'] });
    try { parseMinorUnits(data.sourceAmount ?? ''); } catch {
      context.addIssue({ code: 'custom', message: 'Enter the original amount with up to two decimals.', path: ['sourceAmount'] });
    }
    try { parseExchangeRate(data.exchangeRate ?? ''); } catch {
      context.addIssue({ code: 'custom', message: 'Enter the PKR rate used by your bank or provider.', path: ['exchangeRate'] });
    }
    if (!data.referenceNumber?.trim()) context.addIssue({ code: 'custom', message: 'Record the remittance reference number.', path: ['referenceNumber'] });
  }
});

type AddTransactionFormData = z.infer<typeof addTransactionSchema>;

const EXPENSE_CATEGORIES = EXPENSE_CLASSIFICATION_IDS.map((id) => ({
  id,
  name: CLASSIFICATIONS[id].label,
}));
const INCOME_SOURCES = INCOME_CLASSIFICATION_IDS.map((id) => ({
  id,
  name: CLASSIFICATIONS[id].label,
}));

registerTranslation('en', en);

export default function AddTransactionScreen() {
  const router = useRouter();
  const { correctionOf } = useLocalSearchParams<{ correctionOf?: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const operationId = useRef(Crypto.randomUUID());
  const ownerAtEntry = useRef<string | null>(user?.id ?? null);
  const savingRef = useRef(false);
  const [profileChanged, setProfileChanged] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');
  const [correctionRestriction, setCorrectionRestriction] = useState<string | null>(null);
  const [showAdditionalDetails, setShowAdditionalDetails] = useState(false);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [timePickerVisible, setTimePickerVisible] = useState(false);
  const addTransaction = useAddTransaction();
  const { data: accounts = [], isLoading: accountsLoading, isError: accountsError } = useAccounts();
  const [correctionOriginalAccount, setCorrectionOriginalAccount] = useState<string | null>(null);
  const [correctionLoadedId, setCorrectionLoadedId] = useState<string | null>(null);
  const [correctionLoadFailedId, setCorrectionLoadFailedId] = useState<string | null>(null);
  const [correctionRetry, setCorrectionRetry] = useState(0);
  const { colorScheme } = useColorScheme();
  const isDark = Platform.OS === 'web'
    ? typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    : colorScheme === 'dark';
  const paperBaseTheme = isDark ? MD3DarkTheme : MD3LightTheme;
  const paperTheme = {
    ...paperBaseTheme,
    colors: {
      ...paperBaseTheme.colors,
      primary: PRIMARY_COLOR,
      primaryContainer: isDark ? '#30296f' : '#efedff',
      onPrimary: '#ffffff',
    },
    fonts: {
      ...paperBaseTheme.fonts,
      headlineSmall: { ...paperBaseTheme.fonts.headlineSmall, fontFamily: 'Inter' },
      titleLarge: { ...paperBaseTheme.fonts.titleLarge, fontFamily: 'Inter' },
      titleMedium: { ...paperBaseTheme.fonts.titleMedium, fontFamily: 'Figtree' },
      titleSmall: { ...paperBaseTheme.fonts.titleSmall, fontFamily: 'Figtree' },
      bodyLarge: { ...paperBaseTheme.fonts.bodyLarge, fontFamily: 'Figtree' },
      bodyMedium: { ...paperBaseTheme.fonts.bodyMedium, fontFamily: 'Figtree' },
      bodySmall: { ...paperBaseTheme.fonts.bodySmall, fontFamily: 'Figtree' },
      labelLarge: { ...paperBaseTheme.fonts.labelLarge, fontFamily: 'Figtree' },
      labelMedium: { ...paperBaseTheme.fonts.labelMedium, fontFamily: 'Figtree' },
      labelSmall: { ...paperBaseTheme.fonts.labelSmall, fontFamily: 'Figtree' },
    },
  };

  const {
    control,
    handleSubmit,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddTransactionFormData>({
    resolver: zodResolver(addTransactionSchema),
    defaultValues: {
      type: 'Expense',
      amount: '',
      accountId: '',
      categoryId: EXPENSE_CATEGORIES[0].id,
      date: new Date(),
      note: '',
      sourceName: '',
      paymentMethod: 'Bank transfer',
    }
  });

  const transactionType = useWatch({ control, name: 'type' });
  const selectedDate = useWatch({ control, name: 'date' });
  const selectedCategoryId = useWatch({ control, name: 'categoryId' });
  const selectedAccountId = useWatch({ control, name: 'accountId' });
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedToAccountId = useWatch({ control, name: 'toAccountId' });
  const selectedTaxStatus = useWatch({ control, name: 'taxStatus' }) ?? 'unreviewed';
  const selectedPaymentMethod = useWatch({ control, name: 'paymentMethod' }) ?? 'Bank transfer';
  const correctionReady = Boolean(correctionOf) && correctionLoadedId === correctionOf;
  const correctionLoadFailed = Boolean(correctionOf) && correctionLoadFailedId === correctionOf;
  const correctionLoading = Boolean(correctionOf) && !correctionReady && !correctionLoadFailed;
  const categories = transactionType === 'Income' ? INCOME_SOURCES : EXPENSE_CATEGORIES;
  const visibleCategories = categories;
  const normalizedAccountSearch = accountSearch.trim().toLocaleLowerCase('en-US');
  const visibleAccounts = useMemo(() => accounts.filter((account) => (
    `${account.name} ${account.type} ${account.currency}`.toLocaleLowerCase('en-US').includes(normalizedAccountSearch)
  )), [accounts, normalizedAccountSearch]);
  const visibleDestinationAccounts = useMemo(() => accounts.filter((account) => (
    account.id !== selectedAccountId
    && account.currency === selectedAccount?.currency
    && `${account.name} ${account.type} ${account.currency}`.toLocaleLowerCase('en-US').includes(normalizedAccountSearch)
  )), [accounts, normalizedAccountSearch, selectedAccount?.currency, selectedAccountId]);
  const isRemittance = transactionType === 'Income' && selectedCategoryId === 'foreign_remittance';
  const sourceAmount = useWatch({ control, name: 'sourceAmount' }) ?? '';
  const sourceCurrency = useWatch({ control, name: 'sourceCurrency' }) ?? 'USD';
  const exchangeRate = useWatch({ control, name: 'exchangeRate' }) ?? '';
  let remittancePreview = '';
  if (isRemittance && sourceAmount && exchangeRate) {
    try {
      remittancePreview = `≈ ${formatMinorUnits(convertForeignMinorToPkr(parseMinorUnits(sourceAmount), parseExchangeRate(exchangeRate)), 'PKR')}`;
    } catch { /* Validation displays incomplete or out-of-range values. */ }
  }

  useEffect(() => {
    if (!user?.id) return;
    if (!ownerAtEntry.current) ownerAtEntry.current = user.id;
    if (ownerAtEntry.current !== user.id) {
      setProfileChanged(true);
      reset({ type: 'Expense', amount: '', accountId: '', categoryId: EXPENSE_CATEGORIES[0].id, date: new Date(), note: '', sourceName: '', paymentMethod: 'Bank transfer' });
      setCorrectionOriginalAccount(null);
      setCorrectionLoadedId(null);
      operationId.current = Crypto.randomUUID();
    }
  }, [user?.id, reset]);

  useEffect(() => {
    if (correctionOf || profileChanged || accountsLoading || accountsError || accounts.length === 0 || !user) return;
    if (accounts.some((account) => account.id === selectedAccountId)) return;
    let cancelled = false;
    void localDb.transaction.findRecentAccountId(user.id, transactionType).then((preferredId) => {
      if (cancelled || ownerAtEntry.current !== user.id) return;
      const preferred = accounts.find((account) => account.id === preferredId);
      if (preferred) setValue('accountId', preferred.id, { shouldValidate: true });
      else if (accounts.length === 1) setValue('accountId', accounts[0].id, { shouldValidate: true });
      else setValue('accountId', '', { shouldValidate: true });
    }).catch((error) => {
      if (!cancelled) Toast.show({ type: 'error', text1: 'Account preference unavailable', text2: error instanceof Error ? error.message : 'Choose an account to continue.', position: 'top' });
    });
    return () => { cancelled = true; };
  }, [accounts, accountsLoading, accountsError, correctionOf, profileChanged, selectedAccountId, setValue, transactionType, user]);

  useEffect(() => {
    if (!correctionOf || !user) return;
    let cancelled = false;
    void localDb.transaction.findById(user.id, correctionOf).then(async (original) => {
      if (cancelled) return;
      if (!original || original.type === 'Refund' || original.type === 'Reversal') {
        throw new Error('This transaction cannot be edited.');
      }
      setValue('type', original.type);
      const originalAccountCurrency = original.accountCurrency;
      const originalDigits = originalAccountCurrency && isCurrencyCode(originalAccountCurrency)
        ? CURRENCIES[originalAccountCurrency].minorUnitDigits
        : CURRENCIES.PKR.minorUnitDigits;
      setValue('amount', formatMinorUnitsForInput(original.amountMinor, originalDigits));
      setValue('accountId', original.accountId ?? '');
      setCorrectionOriginalAccount(original.accountName ?? 'Original account');
      setValue('toAccountId', original.toAccountId ?? undefined);
      setValue('categoryId', original.classificationId ?? EXPENSE_CATEGORIES[0].id);
      setValue('date', new Date(original.date));
      setValue('note', original.note);
      setValue('sourceName', original.sourceName ?? '');
      setValue('paymentMethod', original.paymentMethod ?? 'Bank transfer');
      setValue('taxStatus', original.taxStatus);
      setValue('sourceAmount', original.sourceAmountMinor ? formatMinorUnitsForInput(original.sourceAmountMinor) : '');
      setValue('sourceCurrency', original.sourceCurrency ?? 'USD');
      setValue('exchangeRate', original.exchangeRate ?? '');
      setValue('referenceNumber', original.referenceNumber ?? '');
      if (original.specializedContext) {
        setCorrectionRestriction(`${original.specializedContext} entries must be corrected from their dedicated history.`);
      }
      const correctionLinks = await localDb.transaction.findCorrectionLinks(user.id, correctionOf);
      if (cancelled) return;
      if (correctionLinks.reversalId || correctionLinks.replacementId) {
        setCorrectionRestriction('This transaction already has a correction. Record a new transaction or review its correction history.');
      }
      setCorrectionLoadedId(correctionOf);
    }).catch((error) => {
      if (!cancelled) {
        setCorrectionLoadFailedId(correctionOf);
        Toast.show({ type: 'error', text1: 'Correction unavailable', text2: error instanceof Error ? error.message : 'Could not load this transaction.', position: 'top' });
      }
    });
    return () => { cancelled = true; };
  }, [correctionOf, user, setValue, correctionRetry]);

  useEffect(() => {
    if (!isRemittance) return;
    try {
      const converted = convertForeignMinorToPkr(parseMinorUnits(sourceAmount), parseExchangeRate(exchangeRate));
      setValue('amount', formatMinorUnitsForInput(converted), { shouldValidate: true });
    } catch {
      setValue('amount', '', { shouldValidate: true });
    }
  }, [isRemittance, sourceAmount, exchangeRate, setValue]);

  const onDateConfirm = ({ date }: { date: Date | undefined }) => {
    setDatePickerVisible(false);
    if (!date) return;
    const updated = new Date(date);
    updated.setHours(selectedDate.getHours(), selectedDate.getMinutes(), selectedDate.getSeconds(), selectedDate.getMilliseconds());
    setValue('date', updated, { shouldValidate: true });
  };

  const onTimeConfirm = ({ hours, minutes }: { hours: number; minutes: number }) => {
    setTimePickerVisible(false);
    const updated = new Date(selectedDate);
    updated.setHours(hours, minutes, 0, 0);
    setValue('date', updated, { shouldValidate: true });
  };

  const onSubmit = async (data: AddTransactionFormData, addAnother = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      if (!user || ownerAtEntry.current !== user.id || profileChanged) throw new Error('Your profile changed while this form was open. Reopen Add before saving.');
      if (correctionRestriction) throw new Error(correctionRestriction);
      if (!accounts.some((account) => account.id === data.accountId)) throw new Error('Choose a valid active account before saving.');
      if (data.type === 'Transfer' && !accounts.some((account) => account.id === data.toAccountId && account.id !== data.accountId && account.currency === selectedAccount?.currency)) {
        throw new Error('Choose an active destination account with the same currency. Cross-currency transfers are not supported.');
      }
      const draft = {
        id: operationId.current,
        amountMinor: parseMinorUnits(data.amount, selectedAccount && isCurrencyCode(selectedAccount.currency) ? CURRENCIES[selectedAccount.currency].minorUnitDigits : CURRENCIES.PKR.minorUnitDigits),
        type: data.type,
        classificationId: data.type === 'Transfer' ? undefined : data.categoryId,
        sourceName: data.type === 'Income' ? data.sourceName?.trim() : undefined,
        paymentMethod: data.type === 'Income' ? data.paymentMethod : undefined,
        accountId: data.accountId,
        toAccountId: data.type === 'Transfer' ? data.toAccountId : undefined,
        sourceAmountMinor: isRemittance ? parseMinorUnits(data.sourceAmount ?? '') : undefined,
        sourceCurrency: isRemittance ? data.sourceCurrency : undefined,
        exchangeRate: isRemittance ? data.exchangeRate?.trim() : undefined,
        referenceNumber: isRemittance ? data.referenceNumber?.trim() : undefined,
        taxStatus: data.type === 'Income' ? data.taxStatus ?? 'unreviewed' : undefined,
        taxYear: data.type === 'Income' ? pakistanTaxYear(data.date) : undefined,
        note: data.note,
        date: data.date,
      };
      if (correctionOf) {
        if (!correctionReady || correctionLoadFailed) throw new Error('The original transaction could not be loaded. Return to history and try again.');
        if (!accounts.some((account) => account.id === data.accountId)) throw new Error('The original account is unavailable or archived. Choose an active account deliberately before saving this correction.');
        await localDb.transaction.correct({ ownerId: user.id, originalTransactionId: correctionOf, replacement: { ...draft, ownerId: user.id } });
        await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: ['dashboard', 'metrics', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['financial-report', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['insights', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['transactions', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['accounts', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['budgets', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['savings', user.id] }),
        ]);
        operationId.current = Crypto.randomUUID();
        router.replace('/(tabs)/transactions');
      } else {
        await addTransaction.mutateAsync(draft);
        operationId.current = Crypto.randomUUID();
        if (addAnother) {
          reset({
            type: data.type,
            amount: '',
            accountId: data.accountId,
            toAccountId: undefined,
            categoryId: data.categoryId,
            date: new Date(),
            note: '',
            sourceName: '',
            paymentMethod: data.paymentMethod ?? 'Bank transfer',
            sourceAmount: '',
            sourceCurrency: 'USD',
            exchangeRate: '',
            referenceNumber: '',
            taxStatus: 'unreviewed',
          });
        } else {
          router.replace('/(tabs)');
        }
      }
    } catch (error) {
      Toast.show({ type: 'error', text1: correctionOf ? 'Correction not saved' : 'Transaction not saved', text2: error instanceof Error ? error.message : 'Please review the transaction and try again.', position: 'top' });
    } finally {
      savingRef.current = false;
    }
  };

  const saveTransaction = (addAnother = false) => { void handleSubmit((data) => onSubmit(data, addAnother))(); };

  const getTypeTextClass = (type: string, currentSelected: string) => {
    if (type !== currentSelected) return 'text-gray-500 dark:text-neutral-300';
    switch (type) {
      case 'Expense': return 'text-red-500 dark:text-red-300';
      case 'Income': return 'text-green-500 dark:text-green-300';
      case 'Transfer': return 'text-blue-500 dark:text-blue-300';
      default: return 'text-gray-500 dark:text-neutral-300';
    }
  };

  return (
    <PaperProvider
      theme={paperTheme}
      settings={{
        icon: ({ name, size, color }) => {
          switch (name) {
            case 'chevron-left': return <ChevronLeft size={size} color={color} />;
            case 'chevron-right': return <ChevronRight size={size} color={color} />;
            case 'pencil-outline': return <Pencil size={size} color={color} />;
            case 'keyboard-outline': return <Keyboard size={size} color={color} />;
            case 'clock-outline': return <Clock3 size={size} color={color} />;
            case 'close': return <X size={size} color={color} />;
            case 'calendar-blank': return <CalendarDays size={size} color={color} />;
            default: return <CircleHelp size={size} color={color} />;
          }
        },
      }}
    >
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView className="flex-1 w-full" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ width: '100%', alignItems: 'center', paddingBottom: 24 }}>
          <View style={{ width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: 16, boxSizing: 'border-box' }}>
          
          {/* Header & Toggle */}
          <View className="w-full pt-3 pb-3 items-center">
            {correctionOf && <Text className="font-body mb-3 w-full border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">This appends a correction and preserves the original. Original account: {correctionOriginalAccount ?? 'loading…'}{!accounts.some((account) => account.id === selectedAccountId) ? '. Choose an active account explicitly.' : '.'}</Text>}
            {correctionRestriction && <Text className="font-body mb-3 w-full border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{correctionRestriction}</Text>}
            {profileChanged && <Text className="font-body mb-3 w-full border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">Your profile changed while this form was open. Please reopen Add to continue safely.</Text>}
            {correctionLoadFailed && <Pressable accessibilityRole="button" className="mb-3 self-center border border-red-300 px-4 py-2" onPress={() => { setCorrectionLoadedId(null); setCorrectionLoadFailedId(null); setCorrectionRetry((value) => value + 1); }}><Text className="font-body text-sm font-semibold text-red-700">Retry loading original transaction</Text></Pressable>}
            <View className="flex-row rounded-full bg-gray-200 p-1 w-full max-w-sm dark:bg-neutral-900">
              {(['Expense', 'Income', 'Transfer'] as const).map((type) => (
                <Pressable
                  key={type}
                  accessibilityRole="button"
                  accessibilityState={{ selected: transactionType === type }}
                  disabled={Boolean(correctionOf && !correctionReady)}
                  className={`min-h-11 flex-1 items-center justify-center rounded-full py-2.5 ${transactionType === type ? 'bg-white shadow-sm dark:bg-neutral-700' : ''}`}
                  onPress={() => {
                    setValue('type', type);
                    setAccountSearch('');
                    if (type !== 'Transfer') setValue('categoryId', (type === 'Income' ? INCOME_SOURCES : EXPENSE_CATEGORIES)[0].id);
                  }}
                >
                  <Text className={["font-body", (`text-sm font-bold ${getTypeTextClass(type, transactionType)}`)].filter(Boolean).join(' ')}>
                    {type}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Amount Hero Input */}
          <View className="w-full items-center justify-center py-6">
            <Text className="font-body mb-2 font-semibold text-gray-500 dark:text-neutral-400">{isRemittance ? 'Converted amount (PKR)' : transactionType === 'Transfer' ? 'Transfer amount' : 'Amount'}</Text>
            <View className="relative h-16 w-full items-center justify-center">
              <Text className="font-heading absolute left-[12%] text-lg font-bold text-gray-500 dark:text-neutral-400">{isRemittance ? 'PKR' : selectedAccount?.currency ?? 'Select account'}</Text>
              <Controller
                control={control}
                name="amount"
                render={({ field: { onChange, onBlur, value } }) => (
                  <TextInput
                    accessibilityLabel={`${transactionType} amount${selectedAccount ? ` in ${selectedAccount.currency}` : ''}`}
                    className="font-heading h-full w-full text-center text-5xl font-bold text-gray-950 dark:text-white"
                    style={{ width: '100%', textAlign: 'center' }}
                    keyboardType="decimal-pad"
                    autoFocus={Platform.OS !== 'web'}
                    placeholder="0"
                    placeholderTextColor="#d1d5db"
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                    maxLength={18}
                    editable={!isRemittance}
                  />
                )}
              />
            </View>
            {errors.amount && <Text className="font-body mt-2 text-sm text-red-500">{errors.amount.message}</Text>}
          </View>

          {/* Details Section */}
          <View className="w-full space-y-5 rounded-2xl border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            
            {/* Account selection */}
            <View className="border-b border-gray-100 pb-4">
              <Text className="font-body text-base font-semibold text-gray-700 dark:text-neutral-100">{transactionType === 'Transfer' ? 'From account' : transactionType === 'Income' ? 'Deposit to' : 'Paid from'}</Text>
              {accountsLoading ? (
                <View className="mt-3 flex-row items-center"><ActivityIndicator size="small" color={PRIMARY_COLOR} /><Text className="font-body ml-2 text-sm text-gray-500">Loading accounts…</Text></View>
              ) : accountsError ? (
                <View className="mt-3"><Text className="font-body text-sm text-red-600">Accounts could not be loaded. Try again before saving.</Text><Pressable accessibilityRole="button" className="mt-2 self-start border-b border-primary pb-0.5" onPress={() => void queryClient.invalidateQueries({ queryKey: ['accounts', user?.id] })}><Text className="font-body text-sm font-semibold text-primary">Retry accounts</Text></Pressable></View>
              ) : accounts.length === 0 ? (
                <View className="mt-3"><Text className="font-body text-sm text-gray-500 dark:text-neutral-400">Create an account before recording income or spending.</Text><Pressable accessibilityRole="button" className="mt-3 self-start border-b border-primary pb-0.5" onPress={() => router.push('/accounts')}><Text className="font-body text-sm font-semibold text-primary">Create account</Text></Pressable></View>
              ) : (
                <>
                {accounts.length > 4 && <View className="mt-3 flex-row items-center border border-gray-200 bg-gray-50 px-3 dark:border-neutral-700 dark:bg-neutral-800"><Search size={17} color="#6b7280" /><TextInput accessibilityLabel="Search accounts" className="font-body min-h-11 flex-1 px-2 text-sm text-gray-900 dark:text-white" placeholder="Search name, type, or currency" placeholderTextColor="#9ca3af" value={accountSearch} onChangeText={setAccountSearch} /></View>}
                <ScrollView horizontal style={{ width: '100%', flexGrow: 0, flexShrink: 1 }} className="mt-3" showsHorizontalScrollIndicator={false}>
                  {visibleAccounts.map((account) => {
                    const selected = account.id === selectedAccountId;
                    return (
                      <Pressable
                        key={account.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${account.name}, ${account.type}, ${account.currency}, balance ${formatMinorUnits(account.balanceMinor, account.currency)}`}
                        onPress={() => setValue('accountId', account.id, { shouldValidate: true })}
                        className={`mr-2 min-h-12 justify-center rounded-xl border px-3 py-2 ${selected ? 'border-primary bg-primary/10 dark:bg-primary/20' : 'border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-800'}`}
                      >
                        <Text className={`font-body font-semibold ${selected ? 'text-primary dark:text-[#b9b5ff]' : 'text-gray-700 dark:text-neutral-100'}`}>{account.name}</Text>
                        <Text className="font-body mt-0.5 text-xs text-gray-500 dark:text-neutral-400">{account.type} · {account.currency} · {formatMinorUnits(account.balanceMinor, account.currency)}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                {visibleAccounts.length === 0 && <Text className="font-body mt-2 text-sm text-gray-500">No matching accounts.</Text>}
                </>
              )}
              {errors.accountId && <Text className="font-body mt-1 text-sm text-red-600">{errors.accountId.message}</Text>}
              {transactionType === 'Transfer' && accounts.length > 1 && (
                <View className="mt-4">
                  <Text className="font-body text-base font-semibold text-gray-700 dark:text-neutral-100">To account</Text>
                  {accounts.length > 4 && <View className="mt-3 flex-row items-center border border-gray-200 bg-gray-50 px-3 dark:border-neutral-700 dark:bg-neutral-800"><Search size={17} color="#6b7280" /><TextInput accessibilityLabel="Search destination accounts" className="font-body min-h-11 flex-1 px-2 text-sm text-gray-900 dark:text-white" placeholder="Search destination accounts" placeholderTextColor="#9ca3af" value={accountSearch} onChangeText={setAccountSearch} /></View>}
                  <ScrollView horizontal style={{ width: '100%', flexGrow: 0, flexShrink: 1 }} className="mt-3" showsHorizontalScrollIndicator={false}>
                    {visibleDestinationAccounts.map((account) => {
                      const selected = account.id === selectedToAccountId;
                      return <Pressable key={account.id} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => setValue('toAccountId', account.id, { shouldValidate: true })} className={`mr-2 min-h-12 justify-center border px-3 py-2 ${selected ? 'border-primary bg-primary/10 dark:bg-primary/20' : 'border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-800'}`}><Text className={`font-body font-semibold ${selected ? 'text-primary dark:text-[#b9b5ff]' : 'text-gray-700 dark:text-neutral-100'}`}>{account.name}</Text><Text className="font-body mt-0.5 text-xs text-gray-500 dark:text-neutral-400">{account.type} · {account.currency} · {formatMinorUnits(account.balanceMinor, account.currency)}</Text></Pressable>;
                    })}
                  </ScrollView>
                  {!accounts.some((account) => account.id !== selectedAccountId && account.currency === selectedAccount?.currency) && <Text className="font-body mt-2 text-sm text-gray-500">No other active account uses {selectedAccount?.currency ?? 'the selected currency'}. Cross-currency transfers are not supported.</Text>}
                  {errors.toAccountId && <Text className="font-body mt-1 text-sm text-red-500">{errors.toAccountId.message}</Text>}
                  <Text className="font-body mt-2 text-xs text-gray-500">Moving money between your accounts does not count as income or spending.</Text>
                </View>
              )}
            </View>

            {/* Category Horizontal Scroll */}
            <View className="border-b border-gray-100 pb-4 dark:border-neutral-800">
              <Text className="font-body mb-3 text-sm font-semibold text-gray-800 dark:text-neutral-100">{transactionType === 'Income' ? 'Income classification' : 'Category'}</Text>
              {transactionType === 'Transfer' ? <Text className="font-body text-sm text-blue-700">Internal transfer · excluded from income and spending totals</Text> : <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-2 px-2">
                {visibleCategories.map((cat) => {
                  const isSelected = selectedCategoryId === cat.id;
                  return (
                    <Pressable
                      key={cat.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      onPress={() => setValue('categoryId', cat.id, { shouldValidate: true })}
                      className={`mr-2 min-h-11 flex-row items-center rounded-full border px-3 py-2 ${isSelected ? 'border-primary bg-primary/10 dark:bg-primary/20' : 'border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-800'}`}
                    >
                      <Text className={`font-body text-sm font-semibold ${isSelected ? 'text-primary dark:text-[#b9b5ff]' : 'text-gray-600 dark:text-neutral-300'}`}>{cat.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>}
              {errors.categoryId && <Text className="font-body mt-1 text-sm text-red-600">{errors.categoryId.message}</Text>}
            </View>

            {transactionType === 'Income' && (
              <View className="border-b border-gray-100 pb-4">
                <Text className="font-body mb-2 text-sm font-semibold text-gray-800 dark:text-neutral-100">
                  {selectedCategoryId === 'family_gift' ? 'Gift from' : 'Payer / source'}
                </Text>
                <Controller
                  control={control}
                  name="sourceName"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <TextInput
                      accessibilityLabel={selectedCategoryId === 'family_gift' ? 'Gift from' : 'Payer or source'}
                      maxLength={160}
                      className="font-body min-h-11 border border-gray-200 bg-gray-50 px-4 py-3 text-base text-black dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                      placeholder={selectedCategoryId === 'family_gift' ? 'Name and relationship (e.g. brother)' : selectedCategoryId === 'foreign_remittance' ? 'Sender name (required)' : 'Employer, client, or source (optional)'}
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                    />
                  )}
                />
                {errors.sourceName && <Text className="font-body mt-1 text-sm text-red-500">{errors.sourceName.message}</Text>}
                {selectedCategoryId === 'family_gift' && (
                  <Text className="font-body mt-2 text-xs leading-5 text-gray-500">
                    A gift is not salary. Keep the sender and payment proof; tax treatment depends on current rules and your circumstances.
                  </Text>
                )}
                <Text className="font-body mt-4 text-sm font-semibold text-gray-700 dark:text-neutral-100">How did you receive it?</Text>
                <View className="mt-2 flex-row flex-wrap gap-2">
                  {['Bank transfer', 'Digital payment', 'Cash', 'Cheque', 'Other'].map((method) => (
                    <Pressable
                      key={method}
                      onPress={() => {
                        setValue('paymentMethod', method);
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: selectedPaymentMethod === method }}
                      className={`rounded-full border px-3 py-2 ${selectedPaymentMethod === method ? 'border-primary bg-primary/10 dark:bg-primary/20' : 'border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-800'}`}
                    >
                      <Text className={`font-body text-xs font-semibold ${selectedPaymentMethod === method ? 'text-primary dark:text-[#b9b5ff]' : 'text-gray-600 dark:text-neutral-200'}`}>{method}</Text>
                    </Pressable>
                  ))}
                </View>
                {selectedCategoryId === 'business_revenue' && (
                  <Text className="font-body mt-2 text-xs leading-5 text-gray-500">
                    These are gross receipts, not profit. A profit report needs business costs to be recorded and matched.
                  </Text>
                )}
                {isRemittance && <View className="mt-4 gap-3">
                  <Text className="font-body text-sm font-semibold text-gray-700 dark:text-neutral-100">Original remittance details</Text>
                  <Controller control={control} name="sourceAmount" render={({ field: { onChange, value } }) => <TextInput className="font-body rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black" placeholder="Amount in original currency" keyboardType="decimal-pad" value={value} onChangeText={onChange} />} />
                  {errors.sourceAmount && <Text className="font-body text-sm text-red-500">{errors.sourceAmount.message}</Text>}
                  <View className="flex-row gap-2">{['USD', 'GBP', 'EUR', 'AED', 'SAR'].map((currency) => <Pressable key={currency} accessibilityRole="radio" accessibilityState={{ selected: sourceCurrency === currency }} onPress={() => setValue('sourceCurrency', currency)} className={`rounded-full border px-3 py-2 ${sourceCurrency === currency ? 'border-primary bg-primary/10 dark:bg-primary/20' : 'border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-800'}`}><Text className={`font-body text-xs font-semibold ${sourceCurrency === currency ? 'text-primary dark:text-[#b9b5ff]' : 'text-gray-700 dark:text-neutral-200'}`}>{currency}</Text></Pressable>)}</View>
                  <Controller control={control} name="exchangeRate" render={({ field: { onChange, value } }) => <TextInput className="font-body rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black" placeholder="PKR per 1 unit (provider rate)" keyboardType="decimal-pad" value={value} onChangeText={onChange} />} />
                  {errors.exchangeRate && <Text className="font-body text-sm text-red-500">{errors.exchangeRate.message}</Text>}
                  {remittancePreview ? <Text className="font-body font-semibold text-primary">Converted amount: {remittancePreview}</Text> : null}
                  <Controller control={control} name="referenceNumber" render={({ field: { onChange, value } }) => <TextInput className="font-body rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black" placeholder="Bank / remittance reference number" value={value} onChangeText={onChange} />} />
                  <Text className="font-body text-xs leading-5 text-gray-500">Enter the exchange rate shown by your bank or provider. The converted PKR amount is what will be added to your account.</Text>
                </View>}
                <Text className="font-body mt-4 text-sm font-semibold text-gray-700 dark:text-neutral-100">Tax record</Text>
                <Text className="font-body mt-1 text-xs text-gray-500">Your record only; Leverage does not decide the legal tax treatment.</Text>
                <View className="mt-2 flex-row flex-wrap gap-2">{([['unreviewed', 'Not reviewed'], ['taxable', 'Taxable'], ['non_taxable', 'Non-taxable']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: selectedTaxStatus === value }} onPress={() => setValue('taxStatus', value)} className={`rounded-full border px-3 py-2 ${selectedTaxStatus === value ? 'border-primary bg-primary/10 dark:bg-primary/20' : 'border-gray-200 bg-gray-50 dark:border-neutral-700 dark:bg-neutral-800'}`}><Text className={`font-body text-xs font-semibold ${selectedTaxStatus === value ? 'text-primary dark:text-[#b9b5ff]' : 'text-gray-700 dark:text-neutral-200'}`}>{label}</Text></Pressable>)}</View>
              </View>
            )}

            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAdditionalDetails }} onPress={() => setShowAdditionalDetails((visible) => !visible)} className="min-h-11 flex-row items-center justify-between border-b border-gray-100 pb-3 dark:border-neutral-800">
              <Text className="font-body text-sm font-semibold text-gray-700 dark:text-neutral-200">{showAdditionalDetails ? 'Hide optional details' : 'Add date or note'}</Text>
              <Text className="font-body text-sm font-semibold text-primary">{showAdditionalDetails ? '−' : '+'}</Text>
            </Pressable>
            {showAdditionalDetails && <>
            {/* Date Picker */}
            <View className="gap-3 border-b border-gray-100 pb-4 dark:border-neutral-800">
              <Text className="font-body text-sm font-semibold text-gray-700 dark:text-neutral-200">Date and time</Text>
              <View className="flex-row gap-2">
                <Pressable accessibilityRole="button" accessibilityLabel="Choose transaction date" onPress={() => setDatePickerVisible(true)} className="min-h-11 flex-1 flex-row items-center border border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-neutral-700 dark:bg-neutral-800">
                  <CalendarDays size={18} color={PRIMARY_COLOR} className="mr-2" />
                  <Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">{selectedDate.toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' })}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Choose transaction time" onPress={() => setTimePickerVisible(true)} className="min-h-11 flex-1 flex-row items-center border border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-neutral-700 dark:bg-neutral-800">
                  <Clock3 size={18} color={PRIMARY_COLOR} className="mr-2" />
                  <Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">{selectedDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</Text>
                </Pressable>
              </View>
            </View>

            {/* Note Input */}
            <View>
              <Text className="font-body mb-2 text-sm font-semibold text-gray-700 dark:text-neutral-200">Note (Optional)</Text>
              <Controller
                control={control}
                name="note"
                render={({ field: { onChange, onBlur, value } }) => (
                  <TextInput
                    accessibilityLabel="Optional transaction note"
                    maxLength={2000}
                    className="font-body min-h-11 border border-gray-200 bg-gray-50 px-4 py-3 text-base text-black dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
                    placeholder="What was this for?"
                    placeholderTextColor="#9ca3af"
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                  />
                )}
              />
            </View>
            </>}

          </View>
          </View>
        </ScrollView>

        <DatePickerModal
          key={datePickerVisible ? `date-${selectedDate.getTime()}` : 'date-hidden'}
          visible={datePickerVisible}
          locale="en"
          mode="single"
          date={selectedDate}
          inputEnabled
          label="Transaction date"
          saveLabel="Apply date"
          onDismiss={() => setDatePickerVisible(false)}
          onConfirm={onDateConfirm}
        />
        <TimePickerModal
          key={timePickerVisible ? `time-${selectedDate.getTime()}` : 'time-hidden'}
          visible={timePickerVisible}
          locale="en"
          label="Transaction time"
          hours={selectedDate.getHours()}
          minutes={selectedDate.getMinutes()}
          use24HourClock
          defaultInputType="picker"
          confirmLabel="Apply time"
          onDismiss={() => setTimePickerVisible(false)}
          onConfirm={onTimeConfirm}
        />

        {/* Keep save actions in layout so they stay clear of the tab bar. */}
        <View className="w-full border-t border-gray-200 bg-white px-4 pt-3 pb-3 dark:border-neutral-800 dark:bg-neutral-950">
          <Button
            title={correctionLoading ? 'Loading original…' : correctionOf ? 'Save correction' : `Save ${transactionType.toLocaleLowerCase('en-US')}`}
            onPress={() => saveTransaction(false)}
            isLoading={isSubmitting || addTransaction.isPending}
            disabled={accounts.length === 0 || accountsLoading || accountsError || correctionLoading || correctionLoadFailed || Boolean(correctionRestriction) || profileChanged || !user}
          />
          {!correctionOf && <Pressable accessibilityRole="button" disabled={isSubmitting || addTransaction.isPending || accounts.length === 0 || accountsLoading || accountsError || profileChanged} onPress={() => saveTransaction(true)} className="mt-2 min-h-11 items-center justify-center"><Text className="font-body text-sm font-semibold text-primary">Save and add another</Text></Pressable>}
        </View>

      </KeyboardAvoidingView>
    </SafeAreaView>
    </PaperProvider>
  );
}
