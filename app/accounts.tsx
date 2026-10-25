import { PRIMARY_COLOR } from '../src/constants/themeColors';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Archive, ChevronRight, Pencil, Plus, Save } from 'lucide-react-native';
import { DoneHeader } from '../components/ui/DoneHeader';
import { useAppConfirm } from '../components/ui/useAppConfirm';
import { useAccounts } from '../hooks/queries/useAccounts';
import { useAuth } from '../src/context/AuthContext';
import { localDb } from '../src/db/local/client';
import { ACCOUNT_TYPES, CURRENCIES, type AccountType, type CurrencyCode } from '../src/finance/domain';
import { formatGroupedAmountInput, formatMinorUnits, parseMinorUnits } from '../src/finance/ledger';

export default function AccountsScreen() {
  const router = useRouter();
  const { edit: editParam } = useLocalSearchParams<{ edit?: string }>();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { confirm, dialog } = useAppConfirm();
  const { data: accounts = [], isLoading, isError, refetch: refetchAccounts } = useAccounts({ includeArchived: true });
  const recordsQuery = useQuery({
    queryKey: ['account-records', user?.id],
    enabled: !!user,
    queryFn: () => {
      if (!user) throw new Error('Sign in to manage accounts.');
      return localDb.account.findMany(user.id, { includeArchived: true });
    },
  });
  const records = recordsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = records.find((account) => account.id === selectedId) ?? null;
  const editConstraintsQuery = useQuery({
    queryKey: ['account-edit-constraints', user?.id, selectedId],
    enabled: !!user && !!selectedId,
    queryFn: () => {
      if (!user || !selectedId) throw new Error('Select an account to edit.');
      return localDb.account.getEditConstraints(user.id, selectedId);
    },
  });
  const financialFieldsLocked = !!selected && (editConstraintsQuery.isLoading || editConstraintsQuery.isError || editConstraintsQuery.data?.cloudSyncEnabled === true || (editConstraintsQuery.data?.transactionCount ?? 0) > 0);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('bank');
  const [currency, setCurrency] = useState<CurrencyCode>('PKR');
  const [openingBalance, setOpeningBalance] = useState('0.00');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const currencyOptions = useMemo(() => Object.keys(CURRENCIES) as CurrencyCode[], []);

  const beginCreate = () => {
    setSelectedId(null); setName(''); setType('bank'); setCurrency('PKR'); setOpeningBalance('0.00');
  };
  const beginEdit = useCallback((account: typeof records[number]) => {
    if (account.archivedAt) return;
    setSelectedId(account.id); setName(account.name); setType(account.type as AccountType); setCurrency(account.currency as CurrencyCode); setOpeningBalance(formatGroupedAmountInput((account.balanceMinor / 100).toFixed(2)));
  }, []);
  useEffect(() => {
    if (!editParam || !recordsQuery.data) return;
    const account = recordsQuery.data.find((item) => item.id === editParam);
    const timer = setTimeout(() => {
      if (account && !account.archivedAt) beginEdit(account);
      router.setParams({ edit: undefined });
    }, 0);
    return () => clearTimeout(timer);
  }, [beginEdit, editParam, recordsQuery.data, router]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['accounts', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['account-records', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['transaction-filter-accounts', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['insights', user?.id] }),
      queryClient.invalidateQueries({ queryKey: ['transactions', user?.id] }),
    ]);
  };
  const save = async () => {
    if (!user || busy) return;
    setBusy(true);
    setFeedback(null);
    const wasEditing = selectedId !== null;
    try {
      const balanceText = openingBalance.trim();
      const balanceMinor = /^0(?:\.0{1,2})?$/.test(balanceText) ? 0 : parseMinorUnits(balanceText);
      if (selectedId) {
        const changes = financialFieldsLocked ? { name, type } : { name, type, currency, balanceMinor };
        await localDb.account.update({ ownerId: user.id, accountId: selectedId, changes });
      }
      else await localDb.account.create({ data: { ownerId: user.id, name, type, currency, balanceMinor } });
      await refresh();
      beginCreate();
      setFeedback({ message: wasEditing ? 'Account changes saved.' : 'Account created.', isError: false });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : 'Check the details and try again.', isError: true });
    } finally { setBusy(false); }
  };
  const archiveConfirmed = async (accountId: string) => {
    if (!user || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await localDb.account.archive({ ownerId: user.id, accountId });
      await refresh();
      if (selectedId === accountId) beginCreate();
      setFeedback({ message: 'Account archived. Its balance and transaction history are still available below.', isError: false });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : 'Please try again.', isError: true });
    } finally { setBusy(false); }
  };
  const archive = async (accountId: string, accountName: string) => {
    const message = `Archive “${accountName}”? Its balance and transaction history will remain available.`;
    if (await confirm({ title: 'Archive account?', message, confirmLabel: 'Archive', destructive: true })) await archiveConfirmed(accountId);
  };
  const activeAccounts = accounts.filter((account) => !account.archivedAt);
  const archivedAccounts = accounts.filter((account) => !!account.archivedAt);

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Accounts" onDone={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} />
    <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <View className="mb-6 rounded-3xl border border-gray-100 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <Text className="font-heading mb-4 text-lg font-bold text-gray-900 dark:text-white">{selected ? 'Edit account' : 'Add account'}</Text>
        <Text className="font-body mb-1 text-sm font-semibold text-gray-600 dark:text-neutral-300">Account name</Text>
        <TextInput accessibilityLabel="Account name" value={name} onChangeText={setName} placeholder="e.g. Main bank" placeholderTextColor="#9ca3af" maxLength={80} autoCapitalize="words" editable={!busy} className="font-body mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-base text-gray-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" />
        <Text className="font-body mb-2 text-sm font-semibold text-gray-600 dark:text-neutral-300">Account type</Text>
        <View className="mb-4 flex-row flex-wrap">{ACCOUNT_TYPES.map((option) => <Pressable key={option.id} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: type === option.id }} onPress={() => setType(option.id)} className={`mb-2 mr-2 rounded-full border px-3 py-2 ${type === option.id ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white dark:border-neutral-700 dark:bg-neutral-800'}`}><Text className={["font-body", (type === option.id ? 'font-semibold text-primary' : 'text-gray-600 dark:text-neutral-300')].filter(Boolean).join(' ')}>{option.label}</Text></Pressable>)}</View>
        <Text className="font-body mb-2 text-sm font-semibold text-gray-600 dark:text-neutral-300">Currency</Text>
        <View className="mb-4 flex-row flex-wrap">{currencyOptions.map((code) => <Pressable key={code} disabled={busy || financialFieldsLocked} accessibilityRole="radio" accessibilityState={{ checked: currency === code, disabled: busy || financialFieldsLocked }} onPress={() => setCurrency(code)} className={`mb-2 mr-2 rounded-full border px-3 py-2 ${currency === code ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white dark:border-neutral-700 dark:bg-neutral-800'} ${financialFieldsLocked ? 'opacity-60' : ''}`}><Text className={["font-body", (currency === code ? 'font-semibold text-primary' : 'text-gray-600 dark:text-neutral-300')].filter(Boolean).join(' ')}>{code}</Text></Pressable>)}</View>
        <Text className="font-body mb-1 text-sm font-semibold text-gray-600 dark:text-neutral-300">Opening balance</Text>
        <TextInput accessibilityLabel="Opening balance" value={openingBalance} onChangeText={(value) => setOpeningBalance(formatGroupedAmountInput(value))} editable={!busy && !financialFieldsLocked} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor="#9ca3af" inputMode="decimal" className="font-body mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-base text-gray-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" />
        {!!selected && <Text className="font-body mb-3 text-xs leading-5 text-gray-500 dark:text-neutral-400">{editConstraintsQuery.isLoading ? 'Checking account history and sync settings…' : editConstraintsQuery.isError ? 'Could not verify edit limits. Try again before changing account details.' : financialFieldsLocked ? 'Opening balance and currency are read-only because history exists or cloud sync is enabled.' : 'Opening balance and currency lock after transactions are recorded so account history stays consistent.'}</Text>}
        {feedback && <Text accessibilityRole={feedback.isError ? 'alert' : 'text'} accessibilityLiveRegion="polite" className={`font-body mb-3 text-sm ${feedback.isError ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{feedback.message}</Text>}
        {selected && editConstraintsQuery.isError && <Pressable onPress={() => void editConstraintsQuery.refetch()} className="mb-3 self-start"><Text className="font-body font-semibold text-primary">Retry account checks</Text></Pressable>}
        <View className="flex-row">
          <Pressable disabled={busy || (!!selected && editConstraintsQuery.isError)} accessibilityRole="button" accessibilityState={{ disabled: busy || (!!selected && editConstraintsQuery.isError) }} onPress={() => void save()} className="houselog-button flex-1 flex-row items-center justify-center py-3"><Save size={18} color="white" /><Text className="font-body ml-2 font-bold text-white">{busy ? 'Saving…' : selected ? 'Save changes' : 'Create account'}</Text></Pressable>
          {selected && <Pressable disabled={busy} onPress={beginCreate} className="ml-2 justify-center rounded-xl border border-gray-300 px-4 dark:border-neutral-700"><Text className="font-body font-semibold text-gray-700 dark:text-neutral-200">Cancel</Text></Pressable>}
        </View>
      </View>

      <View className="mb-3 flex-row items-center justify-between"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Your accounts</Text><Pressable disabled={busy} accessibilityRole="button" onPress={beginCreate} className="flex-row items-center"><Plus size={18} color={PRIMARY_COLOR} /><Text className="font-body ml-1 font-semibold text-primary">Add</Text></Pressable></View>
      {isLoading || recordsQuery.isLoading ? <Text className="font-body py-5 text-center text-gray-500 dark:text-neutral-400">Loading accounts…</Text> : isError || recordsQuery.isError ? <View className="items-center rounded-2xl bg-white p-5 dark:bg-neutral-900"><Text className="font-body mb-3 text-center text-red-600 dark:text-red-400">Accounts could not be loaded.</Text><Pressable onPress={() => { void refetchAccounts(); void recordsQuery.refetch(); }} className="houselog-button px-4 py-2"><Text className="font-body font-semibold text-white">Try again</Text></Pressable></View> : activeAccounts.length === 0 ? <Text className="font-body rounded-2xl bg-white p-5 text-center text-gray-500 dark:bg-neutral-900 dark:text-neutral-400">No active accounts yet. Add one to start recording money.</Text> : activeAccounts.map((account) => <View key={account.id} className="mb-3 flex-row items-center rounded-2xl border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`View ${account.name} balance and history`} onPress={() => router.push({ pathname: '/account/[id]', params: { id: account.id } })} className="flex-1"><Text className="font-body font-bold text-gray-900 dark:text-white">{account.name}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{account.type} · {account.currency} · Opening {formatMinorUnits(records.find((item) => item.id === account.id)?.balanceMinor ?? 0, account.currency)}</Text><Text className="font-heading mt-2 text-lg font-bold text-primary">{formatMinorUnits(account.balanceMinor, account.currency)}</Text></Pressable>
        <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`Edit ${account.name}`} onPress={() => { const raw = records.find((item) => item.id === account.id); if (raw) beginEdit(raw); }} className="ml-2 rounded-full bg-gray-100 p-3 dark:bg-neutral-800"><Pencil size={17} color={PRIMARY_COLOR} /></Pressable>
        <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`Archive ${account.name}`} onPress={() => archive(account.id, account.name)} className="ml-3 rounded-full bg-gray-100 p-3 dark:bg-neutral-800"><Archive size={18} color="#6b7280" /></Pressable>
        <ChevronRight size={18} color="#9ca3af" />
      </View>)}
      {!isLoading && !isError && !recordsQuery.isLoading && !recordsQuery.isError && archivedAccounts.length > 0 && <View className="mt-5"><Text className="font-heading mb-3 text-lg font-bold text-gray-900 dark:text-white">Archived accounts</Text><Text className="font-body mb-3 text-sm leading-5 text-gray-500 dark:text-neutral-400">Archived accounts stay here for reference. Their balances are excluded from active account totals.</Text>{archivedAccounts.map((account) => {
        const balance = accounts.find((item) => item.id === account.id);
        return <Pressable accessibilityRole="button" accessibilityLabel={`View archived ${account.name} history`} onPress={() => router.push({ pathname: '/account/[id]', params: { id: account.id } })} key={account.id} className="mb-3 rounded-2xl border border-gray-200 bg-gray-100 p-4 dark:border-neutral-800 dark:bg-neutral-900"><View className="flex-row items-start justify-between"><View className="flex-1"><Text className="font-body font-bold text-gray-700 dark:text-neutral-200">{account.name}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{account.type} · {account.currency} · Archived · View history</Text></View><Text className="font-heading ml-3 text-base font-bold text-gray-700 dark:text-neutral-200">{formatMinorUnits(balance?.balanceMinor ?? account.balanceMinor, account.currency)}</Text></View></Pressable>;
      })}</View>}
    </ScrollView>
    {dialog}
  </SafeAreaView>;
}
