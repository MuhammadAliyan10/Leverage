import { useInfiniteQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import type { LocalTransaction } from '../../src/db/local/client';

export interface TransactionSection {
  title: string;
  data: LocalTransaction[];
}

export function useTransactions() {
  const { user } = useAuth();
  const query = useInfiniteQuery({
    queryKey: ['transactions', user?.id],
    enabled: !!user,
    initialPageParam: null as { date: string; id: string } | null,
    queryFn: async ({ pageParam }) => {
      if (!user) throw new Error('Sign in to read transactions.');
      return localDb.transaction.findPage({
        ownerId: user.id,
        limit: 50,
        cursor: pageParam ?? undefined,
      });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const sections: TransactionSection[] = [{ title: 'Recent', data: query.data?.pages.flatMap((page) => page.items) ?? [] }];
  return { ...query, data: sections };
}
