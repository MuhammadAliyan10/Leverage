import { PRIMARY_COLOR } from '../src/constants/themeColors';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { BottomSheetTextInput as TextInput } from '@gorhom/bottom-sheet';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { PieChart } from 'react-native-gifted-charts';
import { Banknote, BriefcaseBusiness, ChevronRight, CircleEllipsis, Landmark, PiggyBank, Plus, Smartphone, Wallet } from 'lucide-react-native';
import { ActionSheet } from '../components/ui/ActionSheet';
import { DoneHeader } from '../components/ui/DoneHeader';
import { SectionHeading } from '../components/ui/SectionHeading';
import { BADGE_NEUTRAL, BADGE_NEUTRAL_TEXT, BADGE_PRIMARY, BADGE_PRIMARY_TEXT } from '../components/ui/badgeStyles';
import { useAccounts } from '../hooks/queries/useAccounts';
import { useAuth } from '../src/context/AuthContext';
import { localDb } from '../src/db/local/client';
import { ACCOUNT_TYPES, CURRENCIES, type AccountType, type CurrencyCode } from '../src/finance/domain';
import { sanitizeGroupedAmountInput, formatMinorUnits, formatMinorUnitsForInput, parseMinorUnits } from '../src/finance/ledger';

const ACCOUNT_TYPE_COLORS: Record<AccountType, string> = {
  cash: '#2D8CFF', bank: '#635BFF', savings: '#15966A', wallet: '#14B8A6', investment: '#A855F7', other: '#F59E0B',
};
const ACCOUNT_TYPE_ICONS: Record<AccountType, typeof Wallet> = {
  cash: Banknote, bank: Landmark, savings: PiggyBank, wallet: Smartphone, investment: BriefcaseBusiness, other: CircleEllipsis,
};

export default function AccountsScreen() {
  const router = useRouter();
  const { edit: editParam } = useLocalSearchParams<{ edit?: string }>();
  const queryClient = useQueryClient();
  const { user } = useAuth();
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
  const [formOpen, setFormOpen] = useState(false);
  const [chartCurrency, setChartCurrency] = useState<CurrencyCode | null>(null);
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
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; openingBalance?: string }>({});
  const currencyOptions = useMemo(() => Object.keys(CURRENCIES) as CurrencyCode[], []);

  const resetDraft = () => {
    setSelectedId(null); setName(''); setType('bank'); setCurrency('PKR'); setOpeningBalance('0.00'); setFieldErrors({});
  };
  const beginCreate = () => { resetDraft(); setFeedback(null); setFormOpen(true); };
  const beginEdit = useCallback((account: typeof records[number]) => {
    if (account.archivedAt) return;
    setSelectedId(account.id); setName(account.name); setType(account.type as AccountType); setCurrency(account.currency as CurrencyCode); setOpeningBalance(formatMinorUnitsForInput(account.balanceMinor)); setFieldErrors({});
    setFormOpen(true);
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
    setFieldErrors({});
    const wasEditing = selectedId !== null;
    try {
      const normalizedName = name.trim();
      if (normalizedName.length < 2 || normalizedName.length > 80) {
        setFieldErrors({ name: normalizedName.length < 2 ? 'Enter an account name with at least 2 characters.' : 'Account names can be up to 80 characters.' });
        return;
      }
      const balanceText = openingBalance.trim();
      let balanceMinor: number;
      try {
        balanceMinor = /^0(?:\.0{1,2})?$/.test(balanceText) ? 0 : parseMinorUnits(balanceText);
      } catch (error) {
        setFieldErrors({ openingBalance: error instanceof Error ? error.message : 'Enter a valid non-negative opening balance.' });
        return;
      }
      if (selectedId) {
        const changes = financialFieldsLocked ? { name: normalizedName, type } : { name: normalizedName, type, currency, balanceMinor };
        await localDb.account.update({ ownerId: user.id, accountId: selectedId, changes });
      }
      else await localDb.account.create({ data: { ownerId: user.id, name: normalizedName, type, currency, balanceMinor } });
      await refresh();
      resetDraft();
      setFormOpen(false);
      setFeedback({ message: wasEditing ? 'Account changes saved.' : 'Account created.', isError: false });
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : 'Check the details and try again.', isError: true });
    } finally { setBusy(false); }
  };
  const activeAccounts = useMemo(() => accounts.filter((account) => !account.archivedAt), [accounts]);
  const archivedAccounts = useMemo(() => accounts.filter((account) => !!account.archivedAt), [accounts]);
  const chartCurrencies = [...new Set(activeAccounts.map((account) => account.currency as CurrencyCode))];
  const activeChartCurrency = chartCurrency && chartCurrencies.includes(chartCurrency) ? chartCurrency : chartCurrencies.includes('PKR') ? 'PKR' : chartCurrencies[0];
  const accountMix = useMemo(() => {
    if (!activeChartCurrency) return [];
    const totals = new Map<AccountType, number>();
    for (const account of activeAccounts) {
      if (account.currency !== activeChartCurrency || account.balanceMinor <= 0) continue;
      const accountType = account.type as AccountType;
      totals.set(accountType, (totals.get(accountType) ?? 0) + account.balanceMinor);
    }
    return ACCOUNT_TYPES.flatMap((accountType) => {
      const balanceMinor = totals.get(accountType.id) ?? 0;
      return balanceMinor > 0 ? [{ type: accountType.id, label: accountType.label, balanceMinor, color: ACCOUNT_TYPE_COLORS[accountType.id] }] : [];
    });
  }, [activeAccounts, activeChartCurrency]);
  const positiveMixTotal = accountMix.reduce((total, item) => total + item.balanceMinor, 0);

  return <SafeAreaView edges={['left', 'right', 'bottom']} className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Accounts" onDone={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} />
    <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
      <View className="mb-3 flex-row items-center justify-between">
        <SectionHeading title="Your accounts" description={`${activeAccounts.length} active`} className="min-w-0 flex-1" />
        <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Add account" accessibilityState={{ disabled: busy }} onPress={beginCreate} className="houselog-button ml-2 min-h-10 flex-row items-center justify-center px-3">
          <Plus size={16} color="white" />
          <Text className="font-body ml-1.5 text-sm font-bold text-white">Add</Text>
        </Pressable>
      </View>
      {isLoading || recordsQuery.isLoading ? <View className="items-center py-8"><ActivityIndicator color={PRIMARY_COLOR} /><Text className="font-body mt-2 text-sm text-gray-500 dark:text-neutral-400">Loading your accounts…</Text></View> : isError || recordsQuery.isError ? <View className="mb-4 items-center rounded-md border border-gray-100 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-body mb-3 text-center text-red-600 dark:text-red-400">Accounts could not be loaded.</Text><Pressable onPress={() => { void refetchAccounts(); void recordsQuery.refetch(); }} className="houselog-button px-4 py-2"><Text className="font-body font-semibold text-white">Try again</Text></Pressable></View> : activeAccounts.length === 0 ? <View className="mb-4 rounded-md border border-gray-100 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"><View className="mb-3 h-10 w-10 items-center justify-center bg-primary/10"><Wallet size={21} color={PRIMARY_COLOR} /></View><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">No active accounts yet</Text><Text className="font-body mt-1 text-sm leading-5 text-gray-500 dark:text-neutral-400">Add your cash, bank, or mobile wallet accounts to start tracking balances and activity.</Text></View> : activeAccounts.map((account) => {
        const accountType = ACCOUNT_TYPES.find((item) => item.id === account.type);
        const TypeIcon = ACCOUNT_TYPE_ICONS[account.type as AccountType] ?? CircleEllipsis;
        return <View key={account.id} className="mb-2 flex-row items-center border border-gray-100 bg-white p-3.5 dark:border-neutral-800 dark:bg-neutral-900">
          <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`View ${account.name} balance and history`} onPress={() => router.push({ pathname: '/account/[id]', params: { id: account.id } })} className="min-w-0 flex-1 flex-row items-center">
            <View className="mr-3 h-10 w-10 items-center justify-center" style={{ backgroundColor: `${ACCOUNT_TYPE_COLORS[account.type as AccountType] ?? PRIMARY_COLOR}18` }}><TypeIcon size={19} color={ACCOUNT_TYPE_COLORS[account.type as AccountType] ?? PRIMARY_COLOR} /></View>
            <View className="min-w-0 flex-1"><Text numberOfLines={1} className="font-body font-bold text-gray-900 dark:text-white">{account.name}</Text><View className="mt-1 flex-row items-center"><Text className={`mr-1.5 rounded-full px-2 py-0.5 font-body text-[10px] font-semibold ${BADGE_PRIMARY} ${BADGE_PRIMARY_TEXT}`}>{accountType?.label ?? 'Account'}</Text><Text className={`rounded-full px-2 py-0.5 font-body text-[10px] font-semibold ${BADGE_NEUTRAL} ${BADGE_NEUTRAL_TEXT}`}>{account.currency}</Text></View></View>
            <Text className="font-heading ml-3 text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(account.balanceMinor, account.currency)}</Text>
            <ChevronRight className="ml-2" size={18} color="#9ca3af" />
          </Pressable>
        </View>;
      })}

      <View className="mt-5 mb-2"><SectionHeading title="Balance mix" description="Active account balances by type" /></View>
      <View className="mb-3 border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        {chartCurrencies.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} className="mb-3">{chartCurrencies.map((code) => <Pressable key={code} accessibilityRole="button" accessibilityState={{ selected: activeChartCurrency === code }} onPress={() => setChartCurrency(code)} className={`min-h-8 items-center justify-center px-3 ${activeChartCurrency === code ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs font-semibold ${activeChartCurrency === code ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>{code}</Text></Pressable>)}</ScrollView> : null}
        {activeChartCurrency && accountMix.length > 0 ? <View className="flex-row items-center justify-around">
          <View accessible accessibilityRole="image" accessibilityLabel={`Account balance mix in ${activeChartCurrency}; positive balances total ${formatMinorUnits(positiveMixTotal, activeChartCurrency)}`}>
            <PieChart donut radius={74} innerRadius={53} data={accountMix.map((item) => ({ value: item.balanceMinor / 100, color: item.color, text: item.label }))} centerLabelComponent={() => <View className="items-center"><Text className="font-body text-[10px] text-gray-500 dark:text-neutral-400">TOTAL</Text><Text numberOfLines={1} className="font-heading max-w-[92px] text-xs font-bold text-gray-900 dark:text-white">{formatMinorUnits(positiveMixTotal, activeChartCurrency)}</Text></View>} />
          </View>
          <View className="min-w-0 flex-1 pl-2">{accountMix.map((item) => <View key={item.type} className="mb-3 flex-row items-start"><View className="mr-2 mt-1.5 h-2.5 w-2.5" style={{ backgroundColor: item.color }} /><View className="min-w-0 flex-1"><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{item.label}</Text><Text className="font-body mt-0.5 text-xs text-gray-500 dark:text-neutral-400">{formatMinorUnits(item.balanceMinor, activeChartCurrency)} · {positiveMixTotal ? `${Math.round(item.balanceMinor / positiveMixTotal * 100)}%` : '0%'}</Text></View></View>)}</View>
        </View> : <View className="items-center py-5"><Text className="font-body text-sm text-gray-500 dark:text-neutral-400">Add a positive account balance to see its share here.</Text></View>}
        <Text className="font-body mt-2 text-[11px] leading-4 text-gray-500 dark:text-neutral-400">Currencies are shown separately. Zero or negative balances remain in the account list and are not included in this chart.</Text>
      </View>

      {!isLoading && !isError && !recordsQuery.isLoading && !recordsQuery.isError && archivedAccounts.length > 0 ? <View className="mt-2"><SectionHeading title="Archived accounts" description="Not included in active totals" className="mb-3" /><Text className="font-body mb-3 text-sm leading-5 text-gray-500 dark:text-neutral-400">Archived accounts remain available for history and reference.</Text>{archivedAccounts.map((account) => {
        const balance = accounts.find((item) => item.id === account.id);
        return <Pressable accessibilityRole="button" accessibilityLabel={`View archived ${account.name} history`} onPress={() => router.push({ pathname: '/account/[id]', params: { id: account.id } })} key={account.id} className="mb-2 border border-gray-200 bg-gray-100 p-4 dark:border-neutral-800 dark:bg-neutral-900"><View className="flex-row items-start justify-between"><View className="flex-1"><Text className="font-body font-bold text-gray-700 dark:text-neutral-200">{account.name}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{account.type} · {account.currency} · Archived</Text></View><Text className="font-heading ml-3 text-base font-bold text-gray-700 dark:text-neutral-200">{formatMinorUnits(balance?.balanceMinor ?? account.balanceMinor, account.currency)}</Text></View></Pressable>;
      })}</View> : null}
    </ScrollView>
    <ActionSheet visible={formOpen} title={selected ? 'Edit account' : 'Add account'} onClose={() => { if (!busy) setFormOpen(false); }}>
      <Text className="font-body mb-1 text-sm font-semibold text-gray-600 dark:text-neutral-300">Account name</Text>
      <TextInput accessibilityLabel="Account name" value={name} onChangeText={(value) => { setName(value); setFieldErrors((errors) => ({ ...errors, name: undefined })); }} placeholder="e.g. Main bank" placeholderTextColor="#9ca3af" maxLength={80} autoCapitalize="words" editable={!busy} className={`font-body rounded-md border bg-white px-4 py-3 text-base text-gray-900 dark:bg-neutral-800 dark:text-white ${fieldErrors.name ? 'mb-1 border-red-500 dark:border-red-500' : 'mb-4 border-gray-200 dark:border-neutral-700'}`} />
      {fieldErrors.name ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="font-body mb-4 text-xs text-red-600 dark:text-red-400">{fieldErrors.name}</Text> : null}
      <Text className="font-body mb-2 text-sm font-semibold text-gray-600 dark:text-neutral-300">Account type</Text>
      <View className="mb-3 flex-row flex-wrap">{ACCOUNT_TYPES.map((option) => <Pressable key={option.id} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: type === option.id }} onPress={() => setType(option.id)} className={`mb-2 mr-2 rounded-full px-3 py-2 ${type === option.id ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body ${type === option.id ? `font-semibold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{option.label}</Text></Pressable>)}</View>
      {!selected || !financialFieldsLocked ? <>
        <Text className="font-body mb-2 text-sm font-semibold text-gray-600 dark:text-neutral-300">Currency</Text>
        <View className="mb-3 flex-row flex-wrap">{currencyOptions.map((code) => <Pressable key={code} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: currency === code }} onPress={() => setCurrency(code)} className={`mb-2 mr-2 rounded-full px-3 py-2 ${currency === code ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body ${currency === code ? `font-semibold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{code}</Text></Pressable>)}</View>
        <Text className="font-body mb-1 text-sm font-semibold text-gray-600 dark:text-neutral-300">Opening balance</Text>
        <TextInput accessibilityLabel="Opening balance" value={openingBalance} onChangeText={(value) => { setOpeningBalance(sanitizeGroupedAmountInput(value)); setFieldErrors((errors) => ({ ...errors, openingBalance: undefined })); }} editable={!busy} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor="#9ca3af" inputMode="decimal" className={`font-body rounded-md border bg-white px-4 py-3 text-base text-gray-900 dark:bg-neutral-800 dark:text-white ${fieldErrors.openingBalance ? 'mb-1 border-red-500 dark:border-red-500' : 'mb-4 border-gray-200 dark:border-neutral-700'}`} />
        {fieldErrors.openingBalance ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="font-body mb-4 text-xs text-red-600 dark:text-red-400">{fieldErrors.openingBalance}</Text> : null}
      </> : null}
      {!!selected && <Text className="font-body mb-3 text-xs leading-5 text-gray-500 dark:text-neutral-400">{editConstraintsQuery.isLoading ? 'Checking account history and sync settings…' : editConstraintsQuery.isError ? 'Could not verify edit limits. Try again before changing account details.' : financialFieldsLocked ? 'You can’t change the starting balance or currency after transactions exist or cloud sync is connected.' : 'After you record a transaction, the starting balance and currency stay fixed to protect the account history.'}</Text>}
      {feedback && <Text accessibilityRole={feedback.isError ? 'alert' : 'text'} accessibilityLiveRegion="polite" className={`font-body mb-3 text-sm ${feedback.isError ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{feedback.message}</Text>}
      {selected && editConstraintsQuery.isError && <Pressable onPress={() => void editConstraintsQuery.refetch()} className="mb-3 self-start"><Text className="font-body font-semibold text-primary">Retry account checks</Text></Pressable>}
      <Pressable disabled={busy || (!!selected && editConstraintsQuery.isError)} accessibilityRole="button" accessibilityState={{ disabled: busy || (!!selected && editConstraintsQuery.isError), busy }} onPress={() => void save()} className={`houselog-button min-h-12 flex-row items-center justify-center ${busy ? 'opacity-70' : ''}`}>{busy ? <><ActivityIndicator size="small" color="white" /><Text className="font-body ml-2 font-bold text-white">Saving…</Text></> : <Text className="font-body font-bold text-white">{selected ? 'Save changes' : 'Create account'}</Text>}</Pressable>
      {selected ? <Pressable disabled={busy} onPress={() => { resetDraft(); setFormOpen(false); }} className="mt-2 min-h-11 items-center justify-center"><Text className="font-body font-semibold text-gray-700 dark:text-neutral-200">Cancel</Text></Pressable> : null}
    </ActionSheet>
  </SafeAreaView>;
}
