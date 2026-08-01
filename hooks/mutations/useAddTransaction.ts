import { useMutation, useQueryClient } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';

export function useAddTransaction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: any) => {
      return await localDb.transaction.create({
        data: {
          amount: data.amount,
          type: data.type,
          category: data.categoryId,
          accountId: data.accountId,
          note: data.note,
          date: data.date,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      Toast.show({
        type: 'success',
        text1: 'Transaction Saved',
        text2: 'Your transaction has been securely saved locally.',
        position: 'top',
      });
    },
  });
}
