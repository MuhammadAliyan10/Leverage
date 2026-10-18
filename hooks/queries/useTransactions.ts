import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';

export function useTransactions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['transactions', user?.id],
    enabled: !!user,
    queryFn: async () => {
      // Fetch from local DB
      const allTxs = await localDb.transaction.findMany({
        ownerId: user!.id,
        orderBy: { date: 'desc' },
      });

      // Date grouping will be added when the transaction history supports period filters.
      return [
        {
          title: 'Recent',
          data: allTxs.map(tx => ({
            ...tx,
            // Category and payer text are shown as recorded; tax treatment is not inferred.
          }))
        }
      ];
    }
  });
}
