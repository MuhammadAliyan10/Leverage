import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { localDb, type LocalTransaction, type TransactionListFilters } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import { groupTransactionsByDate } from '../../src/finance/transactionDisplay';

export interface TransactionSection { title: string; data: LocalTransaction[] }

export function useTransactions(filters: TransactionListFilters = {}, options: { keepPreviousAccountResults?: boolean } = {}) {
  const { user } = useAuth();
  type TransactionPage = Awaited<ReturnType<typeof localDb.transaction.findPage>>;
  const query = useInfiniteQuery<TransactionPage, Error, InfiniteData<TransactionPage>, readonly unknown[], { date: string; id: string } | null>({
    queryKey: ['transactions', user?.id, filters],
    enabled: !!user,
    placeholderData: options.keepPreviousAccountResults
      ? (previousData, previousQuery) => {
          const previousFilters = previousQuery?.queryKey[2] as TransactionListFilters | undefined;
          return previousFilters?.accountId === filters.accountId ? previousData : undefined;
        }
      : undefined,
    initialPageParam: null as { date: string; id: string } | null,
    queryFn: async ({ pageParam, signal }) => {
      if (!user) throw new Error('Sign in to read transactions.');
      if (signal.aborted) throw new Error('Transaction query was cancelled.');
      const page = await localDb.transaction.findPage({ ownerId: user.id, limit: 50, cursor: pageParam ?? undefined, filters });
      if (signal.aborted) throw new Error('Transaction query was cancelled.');
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Keep recently visited filter/search results warm while mutations explicitly invalidate this key.
    staleTime: 15 * 1000,
    gcTime: 5 * 60 * 1000,
  });
  const sections = useMemo(() => groupTransactionsByDate(query.data?.pages.flatMap((page) => page.items) ?? []), [query.data]);
  return { ...query, data: sections };
}
