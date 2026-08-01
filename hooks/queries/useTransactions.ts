import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';

export function useTransactions() {
  return useQuery({
    queryKey: ['transactions'],
    queryFn: async () => {
      // Fetch from local DB
      const allTxs = await localDb.transaction.findMany({
        orderBy: { date: 'desc' },
      });

      // Group by date (dummy grouping for now)
      return [
        {
          title: 'Recent',
          data: allTxs.map(tx => ({
            ...tx,
            // mapping category string to icon handled in UI for now
          }))
        }
      ];
    }
  });
}
