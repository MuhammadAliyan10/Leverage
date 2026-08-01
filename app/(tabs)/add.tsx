import React, { useState } from 'react';
import { View, Text, SafeAreaView, KeyboardAvoidingView, Platform, Pressable, TextInput, ScrollView } from 'react-native';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'expo-router';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Calendar, ChevronDown } from 'lucide-react-native';
import { Button } from '../../components/ui/Button';
import { useAddTransaction } from '../../hooks/mutations/useAddTransaction';

// 1. Zod Validation Schema
const addTransactionSchema = z.object({
  amount: z.string()
    .min(1, 'Amount is required')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, 'Must be a valid positive number'),
  type: z.enum(['Expense', 'Income', 'Transfer']),
  categoryId: z.string().min(1, 'Category is required'),
  accountId: z.string().min(1, 'Account is required'),
  date: z.date(),
  note: z.string().optional(),
});

type AddTransactionFormData = z.infer<typeof addTransactionSchema>;

// Dummy Data
const DUMMY_ACCOUNTS = [
  { id: 'acc1', name: 'Meezan Bank' },
  { id: 'acc2', name: 'Cash Wallet' },
];

const DUMMY_CATEGORIES = [
  { id: 'cat1', name: 'Food', emoji: '🍔' },
  { id: 'cat2', name: 'Transport', emoji: '🚗' },
  { id: 'cat3', name: 'Bills', emoji: '💡' },
  { id: 'cat4', name: 'Shopping', emoji: '🛍️' },
  { id: 'cat5', name: 'Health', emoji: '💊' },
];

export default function AddTransactionScreen() {
  const router = useRouter();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const addTransaction = useAddTransaction();

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
      accountId: DUMMY_ACCOUNTS[0].id,
      categoryId: DUMMY_CATEGORIES[0].id,
      date: new Date(),
      note: '',
    }
  });

  const transactionType = watch('type');
  const selectedDate = watch('date');
  const selectedCategoryId = watch('categoryId');

  const onDateChange = (event: DateTimePickerEvent, selected?: Date) => {
    const currentDate = selected || selectedDate;
    setShowDatePicker(Platform.OS === 'ios');
    setValue('date', currentDate);
  };

  const onSubmit = (data: AddTransactionFormData) => {
    addTransaction.mutate(
      {
        amount: parseFloat(data.amount),
        type: data.type,
        categoryId: data.categoryId,
        accountId: data.accountId,
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
                  onPress={() => setValue('type', type)}
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
            <Text className="text-gray-500 font-semibold mb-2">Enter Amount</Text>
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
                  />
                )}
              />
            </View>
            {errors.amount && <Text className="mt-2 text-sm text-red-500">{errors.amount.message}</Text>}
          </View>

          {/* Details Section */}
          <View className="mx-6 rounded-3xl bg-white p-5 shadow-sm shadow-gray-200 space-y-6">
            
            {/* Account Picker Mock */}
            <View className="flex-row justify-between items-center border-b border-gray-100 pb-4">
              <Text className="text-base font-semibold text-gray-700">Account</Text>
              <View className="flex-row items-center">
                <Text className="text-base font-bold text-black mr-2">Meezan Bank</Text>
                <ChevronDown size={20} color="#9ca3af" />
              </View>
            </View>

            {/* Category Horizontal Scroll */}
            <View className="border-b border-gray-100 pb-4">
              <Text className="text-base font-semibold text-gray-700 mb-3">Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-2 px-2">
                {DUMMY_CATEGORIES.map((cat) => {
                  const isSelected = selectedCategoryId === cat.id;
                  return (
                    <Pressable
                      key={cat.id}
                      onPress={() => setValue('categoryId', cat.id)}
                      className={`mr-3 flex-row items-center rounded-full px-4 py-2 border-2
                        ${isSelected ? `border-${getTypeColor(transactionType).replace('bg-', '')} bg-${getTypeColor(transactionType).replace('bg-', '')}/10` : 'border-gray-200 bg-gray-50'}
                      `}
                    >
                      <Text className="text-base mr-2">{cat.emoji}</Text>
                      <Text className={`text-sm font-bold ${isSelected ? 'text-black' : 'text-gray-500'}`}>{cat.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

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
            className={`${getTypeColor(transactionType)}`} // dynamic color override
          />
        </View>

      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
