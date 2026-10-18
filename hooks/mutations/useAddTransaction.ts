import { useMutation, useQueryClient } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useAuth } from '../../src/context/AuthContext';

export function useAddTransaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: {
      amountMinor: number;
      type: 'Expense' | 'Income' | 'Transfer';
      category: string;
      accountId: string;
      toAccountId?: string;
      note?: string;
      sourceName?: string;
      paymentMethod?: string;
      sourceAmountMinor?: number;
      sourceCurrency?: string;
      exchangeRate?: string;
      referenceNumber?: string;
      taxStatus?: 'unreviewed' | 'taxable' | 'non_taxable';
      taxYear?: number;
      date: Date;
    }) => {
      return await localDb.transaction.create({
        data: {
          ownerId: user!.id,
          amountMinor: data.amountMinor,
          type: data.type,
          category: data.category,
          accountId: data.accountId,
          toAccountId: data.toAccountId,
          note: data.note,
          sourceName: data.sourceName,
          paymentMethod: data.paymentMethod,
          sourceAmountMinor: data.sourceAmountMinor,
          sourceCurrency: data.sourceCurrency,
          exchangeRate: data.exchangeRate,
          referenceNumber: data.referenceNumber,
          taxStatus: data.taxStatus,
          taxYear: data.taxYear,
          date: data.date,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts', user?.id] });
      
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      Toast.show({
        type: 'success',
        text1: 'Transaction Saved',
        text2: 'Your transaction was saved on this device.',
        position: 'top',
      });
    },
    onError: (error) => {
      Toast.show({
        type: 'error',
        text1: 'Transaction not saved',
        text2: error instanceof Error ? error.message : 'Please try again.',
        position: 'top',
      });
    },
  });
}
