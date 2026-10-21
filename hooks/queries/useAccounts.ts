import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import { calculateAccountBalances } from '../../src/finance/balances';

export function useAccounts() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['accounts', user?.id],
    enabled: !!user,
    queryFn: async () => {
      if (!user) throw new Error('Sign in to read accounts.');
      const [accounts, transactions] = await Promise.all([
        localDb.account.findMany(user.id),
        localDb.transaction.findMany({ ownerId: user.id, orderBy: { date: 'asc' } }),
      ]);
      return calculateAccountBalances(accounts, transactions);
    },
  });
}
