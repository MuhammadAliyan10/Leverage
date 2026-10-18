import React, { useEffect, useState } from 'react';
import { View, Text, KeyboardAvoidingView, Platform, Pressable, TextInput, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'expo-router';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Calendar } from 'lucide-react-native';
import { Button } from '../../components/ui/Button';
import { useAddTransaction } from '../../hooks/mutations/useAddTransaction';
import { convertForeignMinorToPkr, parseExchangeRate, parseMinorUnits } from '../../src/finance/ledger';
import { useAccounts } from '../../hooks/queries/useAccounts';

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
  categoryId: z.string().min(1, 'Category is required'),
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
  if (data.type === 'Income' && data.categoryId === 'family_gift' && !data.sourceName?.trim()) {
    context.addIssue({ code: 'custom', message: 'Record who gave you this gift.', path: ['sourceName'] });
  }
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

const EXPENSE_CATEGORIES = [
  { id: 'food', name: 'Food', emoji: '🍔' },
  { id: 'transport', name: 'Transport', emoji: '🚗' },
  { id: 'bills', name: 'Bills', emoji: '💡' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️' },
  { id: 'health', name: 'Health', emoji: '💊' },
  { id: 'bank_fee', name: 'Banking expense', emoji: '🏦' },
  { id: 'housing', name: 'Housing / hostel', emoji: '🏠' },
];

const INCOME_SOURCES = [
  { id: 'salary', name: 'Employment income', emoji: '💼' },
  { id: 'freelance', name: 'Freelance', emoji: '🧑‍💻' },
  { id: 'business_revenue', name: 'Business receipts', emoji: '🏪' },
  { id: 'family_gift', name: 'Family gift / support', emoji: '🎁' },
  { id: 'foreign_remittance', name: 'Family remittance', emoji: '🌍' },
  { id: 'investment_return', name: 'Bank profit / deposit income', emoji: '📈' },
  { id: 'rental_income', name: 'Rent received', emoji: '🏠' },
  { id: 'other_income', name: 'Other income', emoji: '＋' },
];

export default function AddTransactionScreen() {
  const router = useRouter();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const addTransaction = useAddTransaction();
  const { data: accounts = [], isLoading: accountsLoading, isError: accountsError } = useAccounts();
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState('Bank transfer');

  const {
    control,
    handleSubmit,
    watch,
    setValue,
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

  const transactionType = watch('type');
  const selectedDate = watch('date');
  const selectedCategoryId = watch('categoryId');
  const selectedAccountId = watch('accountId');
  const selectedToAccountId = watch('toAccountId');
  const categories = transactionType === 'Income' ? INCOME_SOURCES : EXPENSE_CATEGORIES;
  const isRemittance = transactionType === 'Income' && selectedCategoryId === 'foreign_remittance';
  const sourceAmount = watch('sourceAmount') ?? '';
  const sourceCurrency = watch('sourceCurrency') ?? 'USD';
  const exchangeRate = watch('exchangeRate') ?? '';
  let remittancePreview = '';
  if (isRemittance && sourceAmount && exchangeRate) {
    try {
      remittancePreview = `≈ PKR ${(convertForeignMinorToPkr(parseMinorUnits(sourceAmount), parseExchangeRate(exchangeRate)) / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } catch { /* Validation displays incomplete or out-of-range values. */ }
  }

  useEffect(() => {
    if (accounts.length > 0 && !accounts.some((account) => account.id === selectedAccountId)) {
      setValue('accountId', accounts[0].id, { shouldValidate: true });
    }
  }, [accounts, selectedAccountId, setValue]);

  useEffect(() => {
    if (!isRemittance) return;
    try {
      const converted = convertForeignMinorToPkr(parseMinorUnits(sourceAmount), parseExchangeRate(exchangeRate));
      setValue('amount', (converted / 100).toFixed(2), { shouldValidate: true });
    } catch {
      setValue('amount', '', { shouldValidate: true });
    }
  }, [isRemittance, sourceAmount, exchangeRate, setValue]);

  const onDateChange = (event: DateTimePickerEvent, selected?: Date) => {
    const currentDate = selected || selectedDate;
    setShowDatePicker(Platform.OS === 'ios');
    setValue('date', currentDate);
  };

  const onSubmit = (data: AddTransactionFormData) => {
    addTransaction.mutate(
      {
        amountMinor: parseMinorUnits(data.amount),
        type: data.type,
        category: data.type === 'Transfer' ? 'Internal transfer' : categories.find((category) => category.id === data.categoryId)?.name ?? 'Other',
        sourceName: data.sourceName?.trim(),
        paymentMethod: data.paymentMethod,
        accountId: data.accountId,
        toAccountId: data.type === 'Transfer' ? data.toAccountId : undefined,
        sourceAmountMinor: isRemittance ? parseMinorUnits(data.sourceAmount ?? '') : undefined,
        sourceCurrency: isRemittance ? data.sourceCurrency : undefined,
        exchangeRate: isRemittance ? data.exchangeRate?.trim() : undefined,
        referenceNumber: data.referenceNumber?.trim() || undefined,
        taxStatus: data.type === 'Income' ? data.taxStatus ?? 'unreviewed' : undefined,
        taxYear: data.type === 'Income' ? (data.date.getMonth() >= 6 ? data.date.getFullYear() + 1 : data.date.getFullYear()) : undefined,
        note: data.note,
        date: data.date,
      },
      {
        onSuccess: () => {
          router.replace('/(tabs)');
        },
      }
    );
  };

  // Helper for dynamic colors based on type
  const getTypeColor = (type: string) => {
    switch (type) {
      case 'Expense': return 'bg-red-500';
      case 'Income': return 'bg-green-500';
      case 'Transfer': return 'bg-blue-500';
      default: return 'bg-gray-500';
    }
  };

  const getTypeTextClass = (type: string, currentSelected: string) => {
    if (type !== currentSelected) return 'text-gray-500';
    switch (type) {
      case 'Expense': return 'text-red-500';
      case 'Income': return 'text-green-500';
      case 'Transfer': return 'text-blue-500';
      default: return 'text-gray-500';
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
          
          {/* Header & Toggle */}
          <View className="px-6 pt-10 pb-6 items-center">
            <View className="flex-row rounded-full bg-gray-200 p-1 w-full max-w-sm">
              {(['Expense', 'Income', 'Transfer'] as const).map((type) => (
                <Pressable
                  key={type}
                  className={`flex-1 items-center rounded-full py-2.5 ${transactionType === type ? 'bg-white shadow-sm' : ''}`}
                  onPress={() => {
                    setValue('type', type);
                    if (type !== 'Transfer') setValue('categoryId', (type === 'Income' ? INCOME_SOURCES : EXPENSE_CATEGORIES)[0].id);
                  }}
                >
                  <Text className={`text-sm font-bold ${getTypeTextClass(type, transactionType)}`}>
                    {type}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Amount Hero Input */}
          <View className="items-center justify-center py-10 px-6">
            <Text className="text-gray-500 font-semibold mb-2">{isRemittance ? 'Converted amount (PKR)' : transactionType === 'Transfer' ? 'Transfer amount' : 'Enter Amount'}</Text>
            <View className="flex-row items-center justify-center">
              <Text className="text-4xl font-bold text-gray-400 mr-2">₨</Text>
              <Controller
                control={control}
                name="amount"
                render={({ field: { onChange, onBlur, value } }) => (
                  <TextInput
                    className="text-6xl font-bold text-black min-w-[120px] text-center"
                    keyboardType="decimal-pad"
                    autoFocus={true}
                    placeholder="0"
                    placeholderTextColor="#d1d5db"
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                    maxLength={10}
                    editable={!isRemittance}
                  />
                )}
              />
            </View>
            {errors.amount && <Text className="mt-2 text-sm text-red-500">{errors.amount.message}</Text>}
          </View>

          {/* Details Section */}
          <View className="mx-6 rounded-3xl bg-white p-5 shadow-sm shadow-gray-200 space-y-6">
            
            {/* Account selection */}
            <View className="border-b border-gray-100 pb-4">
              <Text className="text-base font-semibold text-gray-700">{transactionType === 'Transfer' ? 'From account' : transactionType === 'Income' ? 'Deposit to' : 'Paid from'}</Text>
              {accountsLoading ? (
                <Text className="mt-2 text-sm text-gray-500">Loading accounts…</Text>
              ) : accountsError ? (
                <Text className="mt-2 text-sm text-red-600">Accounts could not be loaded. Try again before saving.</Text>
              ) : accounts.length === 0 ? (
                <Text className="mt-2 text-sm text-gray-500">Create an account before recording income or spending.</Text>
              ) : (
                <ScrollView horizontal className="mt-3" showsHorizontalScrollIndicator={false}>
                  {accounts.map((account) => {
                    const selected = account.id === selectedAccountId;
                    return (
                      <Pressable
                        key={account.id}
                        onPress={() => setValue('accountId', account.id, { shouldValidate: true })}
                        className={`mr-2 rounded-xl border px-4 py-2 ${selected ? 'border-primary bg-primary/10' : 'border-gray-200 bg-gray-50'}`}
                      >
                        <Text className={`font-semibold ${selected ? 'text-primary' : 'text-gray-700'}`}>{account.name}</Text>
                        <Text className="mt-0.5 text-xs text-gray-500">{account.type}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
              {transactionType === 'Transfer' && accounts.length > 1 && (
                <View className="mt-4">
                  <Text className="text-base font-semibold text-gray-700">To account</Text>
                  <ScrollView horizontal className="mt-3" showsHorizontalScrollIndicator={false}>
                    {accounts.filter((account) => account.id !== selectedAccountId).map((account) => {
                      const selected = account.id === selectedToAccountId;
                      return <Pressable key={account.id} onPress={() => setValue('toAccountId', account.id, { shouldValidate: true })} className={`mr-2 rounded-xl border px-4 py-2 ${selected ? 'border-primary bg-primary/10' : 'border-gray-200 bg-gray-50'}`}><Text className={`font-semibold ${selected ? 'text-primary' : 'text-gray-700'}`}>{account.name}</Text></Pressable>;
                    })}
                  </ScrollView>
                  {errors.toAccountId && <Text className="mt-1 text-sm text-red-500">{errors.toAccountId.message}</Text>}
                  <Text className="mt-2 text-xs text-gray-500">Moving money between your accounts does not count as income or spending.</Text>
                </View>
              )}
            </View>

            {/* Category Horizontal Scroll */}
            <View className="border-b border-gray-100 pb-4">
              <Text className="text-base font-semibold text-gray-700 mb-3">{transactionType === 'Income' ? 'Income source' : 'Category'}</Text>
              {transactionType === 'Transfer' ? <Text className="text-sm text-blue-700">Internal transfer · excluded from income and spending totals</Text> : <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-2 px-2">
                {categories.map((cat) => {
                  const isSelected = selectedCategoryId === cat.id;
                  return (
                    <Pressable
                      key={cat.id}
                      onPress={() => setValue('categoryId', cat.id, { shouldValidate: true })}
                      className={`mr-3 flex-row items-center rounded-full px-4 py-2 border-2
                        ${isSelected ? `border-${getTypeColor(transactionType).replace('bg-', '')} bg-${getTypeColor(transactionType).replace('bg-', '')}/10` : 'border-gray-200 bg-gray-50'}
                      `}
                    >
                      <Text className="text-base mr-2">{cat.emoji}</Text>
                      <Text className={`text-sm font-bold ${isSelected ? 'text-black' : 'text-gray-500'}`}>{cat.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>}
            </View>

            {transactionType === 'Income' && (
              <View className="border-b border-gray-100 pb-4">
                <Text className="mb-2 text-base font-semibold text-gray-700">
                  {selectedCategoryId === 'family_gift' ? 'Gift from' : 'Payer / source'}
                </Text>
                <Controller
                  control={control}
                  name="sourceName"
                  render={({ field: { onChange, onBlur, value } }) => (
                    <TextInput
                      className="rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black"
                      placeholder={selectedCategoryId === 'family_gift' ? 'Name and relationship (e.g. brother)' : 'Employer, client, or source (optional)'}
                      value={value}
                      onChangeText={onChange}
                      onBlur={onBlur}
                    />
                  )}
                />
                {errors.sourceName && <Text className="mt-1 text-sm text-red-500">{errors.sourceName.message}</Text>}
                {selectedCategoryId === 'family_gift' && (
                  <Text className="mt-2 text-xs leading-5 text-gray-500">
                    A gift is not salary. Keep the sender and payment proof; tax treatment depends on current rules and your circumstances.
                  </Text>
                )}
                <Text className="mt-4 text-sm font-semibold text-gray-700">How did you receive it?</Text>
                <View className="mt-2 flex-row flex-wrap gap-2">
                  {['Bank transfer', 'Digital payment', 'Cash', 'Cheque', 'Other'].map((method) => (
                    <Pressable
                      key={method}
                      onPress={() => {
                        setSelectedPaymentMethod(method);
                        setValue('paymentMethod', method);
                      }}
                      className={`rounded-full border px-3 py-2 ${selectedPaymentMethod === method ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white'}`}
                    >
                      <Text className={`text-xs font-semibold ${selectedPaymentMethod === method ? 'text-primary' : 'text-gray-600'}`}>{method}</Text>
                    </Pressable>
                  ))}
                </View>
                {selectedCategoryId === 'business_revenue' && (
                  <Text className="mt-2 text-xs leading-5 text-gray-500">
                    These are gross receipts, not profit. A profit report needs business costs to be recorded and matched.
                  </Text>
                )}
                {isRemittance && <View className="mt-4 gap-3">
                  <Text className="text-sm font-semibold text-gray-700">Original remittance details</Text>
                  <Controller control={control} name="sourceAmount" render={({ field: { onChange, value } }) => <TextInput className="rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black" placeholder="Amount in original currency" keyboardType="decimal-pad" value={value} onChangeText={onChange} />} />
                  {errors.sourceAmount && <Text className="text-sm text-red-500">{errors.sourceAmount.message}</Text>}
                  <View className="flex-row gap-2">{['USD', 'GBP', 'EUR', 'AED', 'SAR'].map((currency) => <Pressable key={currency} onPress={() => setValue('sourceCurrency', currency)} className={`rounded-full border px-3 py-2 ${sourceCurrency === currency ? 'border-primary bg-primary/10' : 'border-gray-200'}`}><Text className="text-xs font-semibold">{currency}</Text></Pressable>)}</View>
                  <Controller control={control} name="exchangeRate" render={({ field: { onChange, value } }) => <TextInput className="rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black" placeholder="PKR per 1 unit (provider rate)" keyboardType="decimal-pad" value={value} onChangeText={onChange} />} />
                  {errors.exchangeRate && <Text className="text-sm text-red-500">{errors.exchangeRate.message}</Text>}
                  {remittancePreview ? <Text className="font-semibold text-primary">Converted amount: {remittancePreview}</Text> : null}
                  <Controller control={control} name="referenceNumber" render={({ field: { onChange, value } }) => <TextInput className="rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black" placeholder="Bank / remittance reference number" value={value} onChangeText={onChange} />} />
                  <Text className="text-xs leading-5 text-gray-500">Enter the exchange rate shown by your bank or provider. The converted PKR amount is what will be added to your account.</Text>
                </View>}
                <Text className="mt-4 text-sm font-semibold text-gray-700">Tax record</Text>
                <Text className="mt-1 text-xs text-gray-500">Your record only; HouseLog does not decide the legal tax treatment.</Text>
                <View className="mt-2 flex-row flex-wrap gap-2">{([['unreviewed', 'Not reviewed'], ['taxable', 'Taxable'], ['non_taxable', 'Non-taxable']] as const).map(([value, label]) => <Pressable key={value} onPress={() => setValue('taxStatus', value)} className={`rounded-full border px-3 py-2 ${((watch('taxStatus') ?? 'unreviewed') === value) ? 'border-primary bg-primary/10' : 'border-gray-200'}`}><Text className="text-xs font-semibold">{label}</Text></Pressable>)}</View>
              </View>
            )}

            {/* Date Picker */}
            <View className="flex-row justify-between items-center border-b border-gray-100 pb-4">
              <Text className="text-base font-semibold text-gray-700">Date</Text>
              {Platform.OS === 'ios' ? (
                <DateTimePicker
                  value={selectedDate}
                  mode="date"
                  display="default"
                  onChange={onDateChange}
                  style={{ width: 130 }}
                />
              ) : (
                <Pressable onPress={() => setShowDatePicker(true)} className="flex-row items-center bg-gray-100 px-3 py-1.5 rounded-lg">
                  <Calendar size={18} color="#533AFE" className="mr-2" />
                  <Text className="text-base font-bold text-black">{selectedDate.toLocaleDateString()}</Text>
                </Pressable>
              )}
            </View>
            {Platform.OS === 'android' && showDatePicker && (
              <DateTimePicker
                value={selectedDate}
                mode="date"
                display="default"
                onChange={onDateChange}
              />
            )}

            {/* Note Input */}
            <View>
              <Text className="text-base font-semibold text-gray-700 mb-2">Note (Optional)</Text>
              <Controller
                control={control}
                name="note"
                render={({ field: { onChange, onBlur, value } }) => (
                  <TextInput
                    className="rounded-xl border-2 border-gray-200 bg-gray-50 px-4 py-3 text-base text-black"
                    placeholder="What was this for?"
                    placeholderTextColor="#9ca3af"
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                  />
                )}
              />
            </View>

          </View>
        </ScrollView>

        {/* Sticky Save Button */}
        <View className="absolute bottom-0 left-0 right-0 border-t border-gray-200 bg-white px-6 py-4 shadow-lg">
          <Button
            title="Save Transaction"
            onPress={handleSubmit(onSubmit)}
            isLoading={isSubmitting || addTransaction.isPending}
            disabled={accounts.length === 0 || accountsLoading || accountsError}
            className={`${getTypeColor(transactionType)}`} // dynamic color override
          />
        </View>

      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
