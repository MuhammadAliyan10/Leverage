import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';

export function useAccounts(options: { includeArchived?: boolean } = {}) {
  const { user } = useAuth();
  const includeArchived = options.includeArchived === true;
  return useQuery({
    queryKey: ['accounts', user?.id, includeArchived],
    enabled: !!user,
    queryFn: async () => {
      if (!user) throw new Error('Sign in to read accounts.');
      return localDb.account.findManyWithBalances(user.id, { includeArchived });
    },
  });
}
