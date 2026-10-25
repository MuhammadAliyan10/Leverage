import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Pencil, Search } from 'lucide-react-native';
import { DoneHeader } from '../../components/ui/DoneHeader';
import { useAppConfirm } from '../../components/ui/useAppConfirm';
import { useAccounts } from '../../hooks/queries/useAccounts';
import { useTransactions } from '../../hooks/queries/useTransactions';
import { useAuth } from '../../src/context/AuthContext';
import { localDb, type LocalTransaction } from '../../src/db/local/client';
import { accountMovementDirection } from '../../src/finance/accountActivity';
import type { CurrencyCode } from '../../src/finance/domain';
import { formatMinorUnits } from '../../src/finance/ledger';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';

export default function AccountActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const accountId = Array.isArray(id) ? id[0] : id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { confirm, dialog } = useAppConfirm();
  const { data: accounts = [], isLoading: accountsLoading, isError: accountsError, refetch: refetchAccounts } = useAccounts({ includeArchived: true });
  const account = accounts.find((item) => item.id === accountId);
  const summaryQuery = useQuery({
    queryKey: ['account-activity-summary', user?.id, accountId],
    enabled: !!user && !!accountId,
    queryFn: () => {
      if (!user || !accountId) throw new Error('Sign in and select an account to view its activity.');
      return localDb.transaction.findAccountSummary(user.id, accountId);
    },
  });
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const filters = useMemo(() => ({ accountId, search: debouncedSearch || undefined }), [accountId, debouncedSearch]);
  const history = useTransactions(filters);
  const transactions = history.data.flatMap((section) => section.data);

  const editAccount = () => router.replace({ pathname: '/accounts', params: { edit: accountId } });
  const archiveAccount = async () => {
    if (!user || !accountId) return;
    try {
      await localDb.account.archive({ ownerId: user.id, accountId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['accounts', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['account-records', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['account-activity-summary', user.id, accountId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['insights', user.id] }),
      ]);
      router.replace('/accounts');
    } catch (error) {
      Alert.alert('Account not archived', error instanceof Error ? error.message : 'Please try again.');
    }
  };
  const confirmArchive = async () => {
    if (!account) return;
    const message = `Archive “${account.name}”? The balance and transaction history will remain available.`;
    if (await confirm({ title: 'Archive account?', message, confirmLabel: 'Archive', destructive: true })) await archiveAccount();
  };
  const retry = () => {
    void refetchAccounts();
    void summaryQuery.refetch();
    void history.refetch();
  };
  const busy = accountsLoading || (summaryQuery.isLoading && !summaryQuery.data);

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title={account?.name ?? 'Account activity'} onDone={() => router.canGoBack() ? router.back() : router.replace('/accounts')} />
    <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {busy ? <Text className="font-body py-8 text-center text-gray-500 dark:text-neutral-400">Loading account activity…</Text>
        : accountsError || summaryQuery.isError ? <View className="rounded-2xl border border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950"><Text className="font-body mb-3 text-sm text-red-700 dark:text-red-300">Account details could not be loaded. Your saved records have not been changed.</Text><Pressable accessibilityRole="button" onPress={retry} className="houselog-button self-start px-4 py-2"><Text className="font-body font-semibold text-white">Try again</Text></Pressable></View>
          : !account || !summaryQuery.data ? <View className="rounded-2xl bg-white p-5 dark:bg-neutral-900"><Text className="font-body text-gray-700 dark:text-neutral-200">This account is not available in the current profile.</Text></View>
            : <>
              <View className="mb-4 rounded-3xl border border-gray-100 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="flex-row items-center justify-between"><View><Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{account.currency} · {account.type}{account.archivedAt ? ' · archived' : ''}</Text><Text className="font-heading mt-2 text-3xl font-bold text-gray-950 dark:text-white">{formatMinorUnits(summaryQuery.data.currentBalanceMinor, account.currency)}</Text><Text className="font-body mt-1 text-sm text-gray-500 dark:text-neutral-400">Current balance</Text></View>
                  {!account.archivedAt && <View className="flex-row"><Pressable accessibilityRole="button" accessibilityLabel="Edit account" onPress={editAccount} className="mr-2 rounded-full bg-primary/10 p-3"><Pencil size={18} color={PRIMARY_COLOR} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Archive account" onPress={confirmArchive} className="rounded-full bg-gray-100 p-3 dark:bg-neutral-800"><Archive size={18} color="#6b7280" /></Pressable></View>}
                </View>
                <View className="mt-5 flex-row border-t border-gray-100 pt-4 dark:border-neutral-800"><View className="flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Opening balance</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{formatMinorUnits(summaryQuery.data.openingBalanceMinor, account.currency)}</Text></View><View className="flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Recorded entries</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{summaryQuery.data.transactionCount.toLocaleString()}</Text></View></View>
              </View>

              <View className="mb-5 flex-row">
                <View className="mr-2 flex-1 rounded-2xl border border-emerald-100 bg-emerald-50 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/40"><View className="mb-2 flex-row items-center"><ArrowDownLeft size={16} color="#059669" /><Text className="font-body ml-1 text-xs font-semibold text-emerald-800 dark:text-emerald-300">TOTAL IN</Text></View><Text className="font-heading text-lg font-bold text-emerald-800 dark:text-emerald-300">{formatMinorUnits(summaryQuery.data.inflowMinor, account.currency)}</Text></View>
                <View className="ml-2 flex-1 rounded-2xl border border-rose-100 bg-rose-50 p-4 dark:border-rose-900/60 dark:bg-rose-950/40"><View className="mb-2 flex-row items-center"><ArrowUpRight size={16} color="#e11d48" /><Text className="font-body ml-1 text-xs font-semibold text-rose-800 dark:text-rose-300">TOTAL OUT</Text></View><Text className="font-heading text-lg font-bold text-rose-800 dark:text-rose-300">{formatMinorUnits(summaryQuery.data.outflowMinor, account.currency)}</Text></View>
              </View>
              <Text className="font-body -mt-2 mb-5 text-xs leading-5 text-gray-500 dark:text-neutral-400">Totals cover all recorded history. Transfers count as movement in or out of this account, not as income or spending.</Text>

              <View className="mb-3 flex-row items-center justify-between"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Transaction history</Text><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Newest first</Text></View>
              <View className="mb-3 flex-row items-center rounded-xl border border-gray-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-900"><Search size={17} color="#9ca3af" /><TextInput accessibilityLabel="Search account history" value={search} onChangeText={setSearch} placeholder="Search account history" placeholderTextColor="#9ca3af" returnKeyType="search" className="font-body ml-2 flex-1 py-3 text-sm text-gray-900 dark:text-white" /></View>
              {history.isLoading ? <Text className="font-body py-5 text-center text-gray-500 dark:text-neutral-400">Loading transactions…</Text>
                : history.isError ? <View className="rounded-2xl bg-white p-4 dark:bg-neutral-900"><Text className="font-body mb-3 text-sm text-red-600 dark:text-red-400">Transaction history could not be loaded.</Text><Pressable onPress={() => void history.refetch()}><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>
                  : transactions.length === 0 ? <View className="rounded-2xl border border-gray-100 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-body text-center text-sm text-gray-500 dark:text-neutral-400">{debouncedSearch ? 'No matching transactions.' : 'No transactions recorded for this account yet.'}</Text></View>
                    : transactions.map((transaction) => <AccountTransactionRow key={transaction.id} transaction={transaction} accountId={account.id} currency={account.currency as CurrencyCode} />)}
              {!!history.hasNextPage && <Pressable disabled={history.isFetchingNextPage} accessibilityRole="button" onPress={() => void history.fetchNextPage()} className="houselog-button mt-3 items-center py-3"><Text className="font-body font-semibold text-white">{history.isFetchingNextPage ? 'Loading…' : 'Load older transactions'}</Text></Pressable>}
            </>}
    </ScrollView>
    {dialog}
  </SafeAreaView>;
}

function AccountTransactionRow({ transaction, accountId, currency }: { transaction: LocalTransaction; accountId: string; currency: CurrencyCode }) {
  const direction = accountMovementDirection(transaction, accountId);
  const title = transaction.specializedContext || transaction.sourceName?.trim() || transaction.note.trim() || transaction.category.replaceAll('_', ' ');
  const isTransfer = transaction.type === 'Transfer' || (transaction.type === 'Reversal' && transaction.linkedOriginalType === 'Transfer');
  const label = transaction.type === 'Reversal' ? 'Correction reversal' : isTransfer ? (direction === 'in' ? 'Transfer in' : 'Transfer out') : transaction.type;
  const color = direction === 'in' ? '#059669' : '#e11d48';
  const Icon = isTransfer ? ArrowLeftRight : direction === 'in' ? ArrowDownLeft : ArrowUpRight;
  return <View className="mb-2 flex-row items-center rounded-2xl border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
    <View className={`mr-3 rounded-full p-2 ${direction === 'in' ? 'bg-emerald-50 dark:bg-emerald-950/50' : 'bg-rose-50 dark:bg-rose-950/50'}`}><Icon size={18} color={color} /></View>
    <View className="flex-1"><Text numberOfLines={1} className="font-body font-semibold capitalize text-gray-900 dark:text-white">{title}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{label} · {new Date(transaction.date).toLocaleString()}</Text>{transaction.toAccountId && <Text numberOfLines={1} className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{transaction.accountName} → {transaction.destinationName}</Text>}</View>
    <Text className="font-heading ml-2 text-right text-sm font-bold" style={{ color }}>{direction === 'in' ? '+' : '−'}{formatMinorUnits(transaction.amountMinor, currency)}</Text>
  </View>;
}
