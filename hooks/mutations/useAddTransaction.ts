import { useMutation, useQueryClient } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useAuth } from '../../src/context/AuthContext';
import type { TransactionType } from '../../src/finance/domain';

export function useAddTransaction() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: {
      id: string;
      amountMinor: number;
      type: TransactionType;
      classificationId?: string;
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
      if (!user) throw new Error('Sign in before recording a transaction.');
      return await localDb.transaction.create({
        data: {
          id: data.id,
          ownerId: user.id,
          amountMinor: data.amountMinor,
          type: data.type,
          classificationId: data.classificationId,
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
      queryClient.invalidateQueries({ queryKey: ['financial-report', user?.id] });
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
