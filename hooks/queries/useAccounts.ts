import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';

export interface LocalAccount {
  id: string;
  name: string;
  type: string;
  balanceMinor: number;
  currency: string;
  createdAt: string;
  synced: boolean;
}

export function useAccounts() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['accounts', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const [accounts, transactions] = await Promise.all([
        localDb.account.findMany(user!.id) as Promise<LocalAccount[]>,
        localDb.transaction.findMany({ ownerId: user!.id, orderBy: { date: 'asc' } }),
      ]);
      return accounts.map((account) => {
        let balance = BigInt(account.balanceMinor ?? 0);
        for (const tx of transactions) {
          if (!Number.isSafeInteger(tx.amountMinor) || tx.amountMinor < 0) {
            throw new Error('A saved transaction has an invalid amount.');
          }
          const amount = BigInt(tx.amountMinor);
          if (tx.type === 'Income' && tx.accountId === account.id) balance += amount;
          if (tx.type === 'Expense' && tx.accountId === account.id) balance -= amount;
          if (tx.type === 'Transfer' && tx.accountId === account.id) balance -= amount;
          if (tx.type === 'Transfer' && tx.toAccountId === account.id) balance += amount;
        }
        if (balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new Error('An account balance is out of range.');
        }
        return { ...account, balanceMinor: Number(balance) };
      });
    },
  });
}
