import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { KeyboardAwareScrollView } from '../../components/ui/KeyboardAwareScrollView';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Pencil, Search } from 'lucide-react-native';
import { DoneHeader } from '../../components/ui/DoneHeader';
import { ActionSheet } from '../../components/ui/ActionSheet';
import { useAppConfirm } from '../../components/ui/useAppConfirm';
import { BADGE_NEUTRAL, BADGE_NEUTRAL_TEXT, BADGE_PRIMARY, BADGE_PRIMARY_TEXT } from '../../components/ui/badgeStyles';
import { useAccounts } from '../../hooks/queries/useAccounts';
import { useTransactions } from '../../hooks/queries/useTransactions';
import { useAuth } from '../../src/context/AuthContext';
import { localDb, type LocalTransaction } from '../../src/db/local/client';
import { accountMovementDirection } from '../../src/finance/accountActivity';
import { ACCOUNT_TYPES, CURRENCIES, type AccountType, type CurrencyCode } from '../../src/finance/domain';
import { sanitizeGroupedAmountInput, formatMinorUnits, formatMinorUnitsForInput, parseMinorUnits } from '../../src/finance/ledger';
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
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<AccountType>('bank');
  const [editCurrency, setEditCurrency] = useState<CurrencyCode>('PKR');
  const [editOpeningBalance, setEditOpeningBalance] = useState('0.00');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<{ name?: string; openingBalance?: string }>({});
  const editConstraintsQuery = useQuery({
    queryKey: ['account-edit-constraints', user?.id, accountId],
    enabled: !!user && !!accountId && editOpen,
    queryFn: () => {
      if (!user || !accountId) throw new Error('Select an account to edit.');
      return localDb.account.getEditConstraints(user.id, accountId);
    },
  });
  const financialFieldsLocked = editConstraintsQuery.isLoading || editConstraintsQuery.isError || editConstraintsQuery.data?.cloudSyncEnabled === true || (editConstraintsQuery.data?.transactionCount ?? 0) > 0;
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const filters = useMemo(() => ({ accountId, search: debouncedSearch || undefined }), [accountId, debouncedSearch]);
  const history = useTransactions(filters, { keepPreviousAccountResults: true });
  const transactions = history.data.flatMap((section) => section.data);

  const editAccount = () => {
    if (!account || account.archivedAt) return;
    setEditName(account.name);
    setEditType(account.type as AccountType);
    setEditCurrency(account.currency as CurrencyCode);
    setEditOpeningBalance(formatMinorUnitsForInput(summaryQuery.data?.openingBalanceMinor ?? account.balanceMinor));
    setEditFieldErrors({});
    setEditError(null);
    setEditOpen(true);
  };
  const saveAccount = async () => {
    if (!user || !accountId || !account || editBusy) return;
    setEditBusy(true);
    setEditError(null);
    setEditFieldErrors({});
    try {
      const normalizedName = editName.trim();
      if (normalizedName.length < 2 || normalizedName.length > 80) {
        setEditFieldErrors({ name: normalizedName.length < 2 ? 'Enter an account name with at least 2 characters.' : 'Account names can be up to 80 characters.' });
        return;
      }
      let openingBalanceMinor: number;
      try {
        const text = editOpeningBalance.trim();
        openingBalanceMinor = /^0(?:\.0{1,2})?$/.test(text) ? 0 : parseMinorUnits(text);
      } catch (error) {
        setEditFieldErrors({ openingBalance: error instanceof Error ? error.message : 'Enter a valid non-negative opening balance.' });
        return;
      }
      const changes = financialFieldsLocked
        ? { name: normalizedName, type: editType }
        : { name: normalizedName, type: editType, currency: editCurrency, balanceMinor: openingBalanceMinor };
      await localDb.account.update({ ownerId: user.id, accountId, changes });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['accounts', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['account-records', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['account-activity-summary', user.id, accountId] }),
        queryClient.invalidateQueries({ queryKey: ['transaction-filter-accounts', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['insights', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['transactions', user.id] }),
      ]);
      setEditOpen(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Account changes could not be saved. Please try again.');
    } finally {
      setEditBusy(false);
    }
  };
  const archiveAccount = async () => {
    if (!user || !accountId || !account || account.archivedAt) return;
    setArchiveError(null);
    try {
      await localDb.account.archive({ ownerId: user.id, accountId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['accounts', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['account-records', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['account-activity-summary', user.id, accountId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['insights', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['transactions', user.id] }),
      ]);
      router.replace('/accounts');
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Account could not be archived. Please try again.');
    }
  };
  const confirmArchive = async () => {
    if (!account) return;
    const confirmed = await confirm({
      title: 'Archive account?',
      message: `Archive “${account.name}”? Its balance and transaction history will remain available.`,
      confirmLabel: 'Archive',
      destructive: true,
    });
    if (confirmed) await archiveAccount();
  };

  const retry = () => {
    void refetchAccounts();
    void summaryQuery.refetch();
    void history.refetch();
  };
  const busy = accountsLoading || (summaryQuery.isLoading && !summaryQuery.data);

  return <SafeAreaView edges={['left', 'right', 'bottom']} className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title={account?.name ?? 'Account activity'} onDone={() => router.canGoBack() ? router.back() : router.replace('/accounts')} />
    <KeyboardAwareScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {busy ? <Text className="font-body py-8 text-center text-gray-500 dark:text-neutral-400">Loading account activity…</Text>
        : accountsError || summaryQuery.isError ? <View className="rounded-md border border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950"><Text className="font-body mb-3 text-sm text-red-700 dark:text-red-300">Account details could not be loaded. Your saved records have not been changed.</Text><Pressable accessibilityRole="button" onPress={retry} className="houselog-button self-start px-4 py-2"><Text className="font-body font-semibold text-white">Try again</Text></Pressable></View>
          : !account || !summaryQuery.data ? <View className="rounded-md bg-white p-5 dark:bg-neutral-900"><Text className="font-body text-gray-700 dark:text-neutral-200">This account is not available in the current profile.</Text></View>
            : <>
              {archiveError ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-3 border border-red-200 bg-red-50 p-3 font-body text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{archiveError}</Text> : null}
              <View className="mb-4 rounded-md border border-gray-100 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="flex-row items-start justify-between"><View><Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{account.currency} · {account.type}{account.archivedAt ? ' · archived' : ''}</Text><Text className="font-heading mt-2 text-3xl font-bold text-gray-950 dark:text-white">{formatMinorUnits(summaryQuery.data.currentBalanceMinor, account.currency)}</Text><Text className="font-body mt-1 text-sm text-gray-500 dark:text-neutral-400">Current balance</Text></View>
                  {!account.archivedAt ? <View className="flex-row"><Pressable accessibilityRole="button" accessibilityLabel="Edit account" onPress={editAccount} className="mr-2 min-h-11 min-w-11 items-center justify-center bg-primary/10"><Pencil size={18} color={PRIMARY_COLOR} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Archive account" onPress={() => void confirmArchive()} className="min-h-11 min-w-11 items-center justify-center bg-gray-100 dark:bg-neutral-800"><Archive size={18} color="#6b7280" /></Pressable></View> : null}
                </View>
                <View className="mt-5 flex-row border-t border-gray-100 pt-4 dark:border-neutral-800"><View className="flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Opening balance</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{formatMinorUnits(summaryQuery.data.openingBalanceMinor, account.currency)}</Text></View><View className="flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Recorded entries</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{summaryQuery.data.transactionCount.toLocaleString()}</Text></View></View>
              </View>

              <View className="mb-5 flex-row">
                <View className="mr-2 flex-1 rounded-md border border-emerald-100 bg-emerald-50 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/40"><View className="mb-2 flex-row items-center"><ArrowDownLeft size={16} color="#059669" /><Text className="font-body ml-1 text-xs font-semibold text-emerald-800 dark:text-emerald-300">TOTAL IN</Text></View><Text className="font-heading text-lg font-bold text-emerald-800 dark:text-emerald-300">{formatMinorUnits(summaryQuery.data.inflowMinor, account.currency)}</Text></View>
                <View className="ml-2 flex-1 rounded-md border border-rose-100 bg-rose-50 p-4 dark:border-rose-900/60 dark:bg-rose-950/40"><View className="mb-2 flex-row items-center"><ArrowUpRight size={16} color="#e11d48" /><Text className="font-body ml-1 text-xs font-semibold text-rose-800 dark:text-rose-300">TOTAL OUT</Text></View><Text className="font-heading text-lg font-bold text-rose-800 dark:text-rose-300">{formatMinorUnits(summaryQuery.data.outflowMinor, account.currency)}</Text></View>
              </View>
              <Text className="font-body -mt-2 mb-5 text-xs leading-5 text-gray-500 dark:text-neutral-400">Totals include all dates. Transfers show money moving in or out, but aren’t income or spending.</Text>

              <View className="mb-3 flex-row items-center justify-between"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Transaction history</Text><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Newest first</Text></View>
              <View className="mb-3 flex-row items-center rounded-xl border border-gray-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-900"><Search size={17} color="#9ca3af" /><TextInput accessibilityLabel="Search account history" value={search} onChangeText={setSearch} placeholder="Search account history" placeholderTextColor="#9ca3af" returnKeyType="search" className="font-body ml-2 flex-1 py-3 text-sm text-gray-900 dark:text-white" /></View>
              {history.isLoading && !search.trim() && !debouncedSearch ? <Text className="font-body py-5 text-center text-gray-500 dark:text-neutral-400">Loading transactions…</Text>
                : history.isError ? <View className="rounded-md bg-white p-4 dark:bg-neutral-900"><Text className="font-body mb-3 text-sm text-red-600 dark:text-red-400">Transaction history could not be loaded.</Text><Pressable onPress={() => void history.refetch()}><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>
                  : history.isLoading ? null
                    : transactions.length === 0 ? <View className="rounded-md border border-gray-100 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-body text-center text-sm text-gray-500 dark:text-neutral-400">{debouncedSearch ? 'No matching transactions.' : 'No transactions recorded for this account yet.'}</Text></View>
                      : transactions.map((transaction) => <AccountTransactionRow key={transaction.id} transaction={transaction} accountId={account.id} currency={account.currency as CurrencyCode} />)}
              {!!history.hasNextPage && <Pressable disabled={history.isFetching} accessibilityRole="button" accessibilityState={{ disabled: history.isFetching, busy: history.isFetchingNextPage }} onPress={() => void history.fetchNextPage()} className={`houselog-button mt-3 items-center py-3 ${history.isFetching?'opacity-60':''}`}><Text className="font-body font-semibold text-white">{history.isFetchingNextPage ? 'Loading…' : 'Load older transactions'}</Text></Pressable>}
            </>}
    </KeyboardAwareScrollView>
    <ActionSheet visible={editOpen} title="Edit account" onClose={() => { if (!editBusy) setEditOpen(false); }}>
      <Text className="font-body mb-1 text-sm font-semibold text-gray-600 dark:text-neutral-300">Account name</Text>
      <BottomSheetTextInput accessibilityLabel="Account name" value={editName} onChangeText={(value) => { setEditName(value); setEditFieldErrors((errors) => ({ ...errors, name: undefined })); }} placeholder="e.g. Main bank" placeholderTextColor="#9ca3af" maxLength={80} autoCapitalize="words" editable={!editBusy} className={`font-body rounded-md border bg-white px-4 py-3 text-base text-gray-900 dark:bg-neutral-800 dark:text-white ${editFieldErrors.name ? 'mb-1 border-red-500 dark:border-red-500' : 'mb-4 border-gray-200 dark:border-neutral-700'}`} />
      {editFieldErrors.name ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="font-body mb-4 text-xs text-red-600 dark:text-red-400">{editFieldErrors.name}</Text> : null}
      <Text className="font-body mb-2 text-sm font-semibold text-gray-600 dark:text-neutral-300">Account type</Text>
      <View className="mb-3 flex-row flex-wrap">{ACCOUNT_TYPES.map((option) => <Pressable key={option.id} disabled={editBusy} accessibilityRole="radio" accessibilityState={{ checked: editType === option.id }} onPress={() => setEditType(option.id)} className={`mb-2 mr-2 rounded-full px-3 py-2 ${editType === option.id ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body ${editType === option.id ? `font-semibold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{option.label}</Text></Pressable>)}</View>
      {!financialFieldsLocked ? <>
        <Text className="font-body mb-2 text-sm font-semibold text-gray-600 dark:text-neutral-300">Currency</Text>
        <View className="mb-3 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} disabled={editBusy} accessibilityRole="radio" accessibilityState={{ checked: editCurrency === code }} onPress={() => setEditCurrency(code)} className={`mb-2 mr-2 rounded-full px-3 py-2 ${editCurrency === code ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body ${editCurrency === code ? `font-semibold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{code}</Text></Pressable>)}</View>
        <Text className="font-body mb-1 text-sm font-semibold text-gray-600 dark:text-neutral-300">Opening balance</Text>
      <BottomSheetTextInput accessibilityLabel="Opening balance" value={editOpeningBalance} onChangeText={(value) => { setEditOpeningBalance(sanitizeGroupedAmountInput(value)); setEditFieldErrors((errors) => ({ ...errors, openingBalance: undefined })); }} editable={!editBusy} keyboardType="decimal-pad" inputMode="decimal" placeholder="0.00" placeholderTextColor="#9ca3af" className={`font-body rounded-md border bg-white px-4 py-3 text-base text-gray-900 dark:bg-neutral-800 dark:text-white ${editFieldErrors.openingBalance ? 'mb-1 border-red-500 dark:border-red-500' : 'mb-4 border-gray-200 dark:border-neutral-700'}`} />
        {editFieldErrors.openingBalance ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="font-body mb-4 text-xs text-red-600 dark:text-red-400">{editFieldErrors.openingBalance}</Text> : null}
      </> : null}
      <Text className="font-body mb-3 text-xs leading-5 text-gray-500 dark:text-neutral-400">{editConstraintsQuery.isLoading ? 'Checking account history and sync settings…' : editConstraintsQuery.isError ? 'Could not verify edit limits. Retry the account checks before saving.' : financialFieldsLocked ? 'Currency and opening balance are locked because this account has activity or cloud sync is connected.' : 'After you record a transaction, changing the starting balance or currency is restricted to protect your account history.'}</Text>
      {editError ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="font-body mb-3 text-sm text-red-600 dark:text-red-400">{editError}</Text> : null}
      {editConstraintsQuery.isError ? <Pressable onPress={() => void editConstraintsQuery.refetch()} className="mb-3 self-start"><Text className="font-body font-semibold text-primary">Retry account checks</Text></Pressable> : null}
      <Pressable disabled={editBusy || editConstraintsQuery.isLoading || editConstraintsQuery.isError} accessibilityRole="button" accessibilityState={{ disabled: editBusy || editConstraintsQuery.isLoading || editConstraintsQuery.isError, busy: editBusy }} onPress={() => void saveAccount()} className={`houselog-button min-h-12 flex-row items-center justify-center ${editBusy ? 'opacity-70' : ''}`}>{editBusy ? <><ActivityIndicator size="small" color="white" /><Text className="font-body ml-2 font-bold text-white">Saving…</Text></> : <Text className="font-body font-bold text-white">Save changes</Text>}</Pressable>
    </ActionSheet>
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
  return <View className="mb-2 flex-row items-center rounded-md border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
    <View className={`mr-3 rounded-full p-2 ${direction === 'in' ? 'bg-emerald-50 dark:bg-emerald-950/50' : 'bg-rose-50 dark:bg-rose-950/50'}`}><Icon size={18} color={color} /></View>
    <View className="flex-1"><Text numberOfLines={1} className="font-body font-semibold capitalize text-gray-900 dark:text-white">{title}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{label} · {new Date(transaction.date).toLocaleString()}</Text>{transaction.toAccountId && <Text numberOfLines={1} className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{transaction.accountName} → {transaction.destinationName}</Text>}</View>
    <Text className="font-heading ml-2 text-right text-sm font-bold" style={{ color }}>{direction === 'in' ? '+' : '−'}{formatMinorUnits(transaction.amountMinor, currency)}</Text>
  </View>;
}
