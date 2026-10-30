import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, SectionList, TextInput, Pressable, Alert, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { DatePickerField } from '../../components/ui/DatePickerField';
import { Filter, Search, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, X, Edit } from 'lucide-react-native';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTransactions, type TransactionSection } from '../../hooks/queries/useTransactions';
import type { LocalTransaction, TransactionListFilters } from '../../src/db/local/client';
import { localDb } from '../../src/db/local/client';
import { sanitizeGroupedAmountInput, formatMinorUnits, parseMinorUnits } from '../../src/finance/ledger';
import { CLASSIFICATIONS, isCurrencyCode, TRANSACTION_TYPES, type CurrencyCode, type TransactionType } from '../../src/finance/domain';
import { projectTransactionActivity } from '../../src/finance/transactionDisplay';
import { useAuth } from '../../src/context/AuthContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { BADGE_NEUTRAL, BADGE_NEUTRAL_TEXT, BADGE_PRIMARY, BADGE_PRIMARY_TEXT } from '../../components/ui/badgeStyles';

const FILTER_TYPES = TRANSACTION_TYPES;
const EVENT_CATEGORIES = [
  ['internal_transfer', 'Account transfer'], ['scheduled_transfer', 'Scheduled transfer'],
  ['debt_borrowing', 'Borrowed principal received'], ['debt_lending', 'Money lent'],
  ['debt_principal_repayment', 'Debt principal repayment'], ['debt_receivable_payment', 'Principal repaid to you'],
  ['debt_interest', 'Debt interest'], ['debt_settlement', 'Debt settlement'],
  ['asset_purchase', 'Asset purchase'], ['asset_sale_proceeds', 'Asset sale proceeds'],
  ['investment_purchase', 'Investment purchase'], ['investment_sale_proceeds', 'Investment sale proceeds'],
  ['investment_dividend', 'Investment dividend'],
  ['correction_reversal', 'Correction reversal'],
] as const;
type DateFilters = Pick<TransactionListFilters, 'startDate' | 'endDate'>;
const COLORS: Record<TransactionType, string> = { Income: '#16804a', Expense: '#c2413b', Transfer: '#3268a8', Refund: '#16804a', Reversal: '#8b5e12' };

function formatAmount(amountMinor: number, currency: CurrencyCode | null): string {
  return currency ? formatMinorUnits(amountMinor, currency) : `${amountMinor.toLocaleString()} minor units · currency unavailable`;
}

function specializedTransaction(tx: LocalTransaction): boolean {
  if (tx.specializedContext) return true;
  const key = `${tx.category} ${tx.classificationId ?? ''}`.toLocaleLowerCase('en-US');
  return /^(asset_|investment_|debt_)/.test(key) || /^(asset_|investment_|debt_)/.test(tx.classificationId ?? '');
}

function activityFor(tx: LocalTransaction) {
  return projectTransactionActivity({
    id: tx.id, type: tx.type, categoryId: tx.classificationId ?? tx.category, amountMinor: tx.amountMinor,
    accountCurrency: tx.accountCurrency, destinationCurrency: tx.destinationCurrency ?? null,
    sourceName: tx.specializedContext ?? tx.sourceName, note: tx.note, date: tx.date,
    linkedOriginalType: tx.linkedOriginalType ?? null, linkedCategoryId: tx.linkedOriginalCategory ?? null,
    accountName: tx.accountName, destinationName: tx.destinationName,
  });
}

export default function TransactionsScreen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const routeFilters = useLocalSearchParams<{ accountId?: string; categoryId?: string; currency?: string; startDate?: string; endDate?: string }>();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<TransactionListFilters>(() => ({
    accountId: routeFilters.accountId || undefined,
    categoryId: routeFilters.categoryId || undefined,
    currency: routeFilters.currency && isCurrencyCode(routeFilters.currency) ? routeFilters.currency : undefined,
    startDate: routeFilters.startDate || undefined,
    endDate: routeFilters.endDate || undefined,
  }));
  const [draftTypes, setDraftTypes] = useState<TransactionType[]>([]);
  const [draftAccountId, setDraftAccountId] = useState('');
  const [draftAccountSearch, setDraftAccountSearch] = useState('');
  const [draftCategoryId, setDraftCategoryId] = useState('');
  const [draftCategorySearch, setDraftCategorySearch] = useState('');
  const [draftCurrency, setDraftCurrency] = useState<CurrencyCode | ''>('');
  const [draftDates, setDraftDates] = useState<DateFilters>({});
  const [selectedTx, setSelectedTx] = useState<LocalTransaction | null>(null);
  const [correctionLinks, setCorrectionLinks] = useState<{ reversalId: string | null; replacementId: string | null } | null>(null);
  const [correctionLinkError, setCorrectionLinkError] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundAccountId, setRefundAccountId] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const [loadingLinked, setLoadingLinked] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [filterError, setFilterError] = useState('');
  const detailSheetRef = useRef<BottomSheet>(null);
  const filterSheetRef = useRef<BottomSheet>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [filtersVisible, setFiltersVisible] = useState(false);
  const sheetPoints = useMemo(() => ['78%'], []);
  const filterSheetPoints = useMemo(() => ['84%'], []);

  useEffect(() => {
    if (filtersVisible) filterSheetRef.current?.expand();
    else filterSheetRef.current?.close();
  }, [filtersVisible]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const accountsQuery = useQuery({
    queryKey: ['transaction-filter-accounts', user?.id], enabled: !!user,
    queryFn: () => user ? localDb.account.findMany(user.id, { includeArchived: true }) : Promise.resolve([]),
  });
  const activeFilters: TransactionListFilters = useMemo(() => ({ ...filters, search: debouncedSearch || undefined }), [filters, debouncedSearch]);
  const { data: groupedTransactions = [], isLoading, isError, error, hasNextPage, isFetchingNextPage, isRefetching, fetchNextPage, refetch } = useTransactions(activeFilters);
  const visibleCount = groupedTransactions.reduce((count, section) => count + section.data.length, 0);
  const allCurrencies = [...new Set((accountsQuery.data ?? []).map((account) => account.currency).filter(isCurrencyCode))];
  const activeFilterCount = (filters.types?.length ? 1 : 0) + Number(!!filters.accountId) + Number(!!filters.categoryId) + Number(!!filters.currency) + Number(!!filters.startDate || !!filters.endDate);
  const activeFilterLabels = [
    ...(filters.types?.length ? [{ key: 'types', label: `Types: ${filters.types.join(', ')}` }] : []),
    ...(filters.accountId ? [{ key: 'accountId', label: accountsQuery.data?.find((account) => account.id === filters.accountId)?.name ?? 'Account' }] : []),
    ...(filters.categoryId ? [{ key: 'categoryId', label: Object.entries(CLASSIFICATIONS).find(([id]) => id === filters.categoryId)?.[1].label ?? EVENT_CATEGORIES.find(([id]) => id === filters.categoryId)?.[1] ?? filters.categoryId }] : []),
    ...(filters.currency ? [{ key: 'currency', label: filters.currency }] : []),
    ...(filters.startDate || filters.endDate ? [{ key: 'dates', label: `${filters.startDate?.slice(0, 10) ?? 'Any date'} – ${filters.endDate ? new Date(Date.parse(filters.endDate) - 86_400_000).toISOString().slice(0, 10) : 'Any date'}` }] : []),
  ];

  useFocusEffect(useCallback(() => {
    if (user) void refetch();
  }, [refetch, user]));

  const backdrop = useCallback((props: BottomSheetBackdropProps) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />, []);
  const openFilters = useCallback(() => {
    setDraftTypes(filters.types ?? []);
    setDraftAccountId(filters.accountId ?? '');
    setDraftAccountSearch('');
    setDraftCategoryId(filters.categoryId ?? '');
    setDraftCategorySearch('');
    setDraftCurrency(filters.currency ?? '');
    setDraftDates({
      startDate: filters.startDate?.slice(0, 10),
      // The query stores an exclusive next-day boundary; show the user's inclusive date.
      endDate: filters.endDate
        ? new Date(Date.parse(filters.endDate) - 86_400_000).toISOString().slice(0, 10)
        : undefined,
    });
    setFilterError('');
    setFiltersVisible(true);
  }, [filters]);
  const openDetails = useCallback((tx: LocalTransaction) => {
    selectedIdRef.current = tx.id;
    setSelectedTx(tx);
    setCorrectionLinks(null);
    setCorrectionLinkError(false);
    setRefundAmount('');
    setRefundAccountId(tx.accountId ?? '');
    detailSheetRef.current?.expand();
    if (user && tx.type !== 'Refund' && tx.type !== 'Reversal') {
      void localDb.transaction.findCorrectionLinks(user.id, tx.id).then((links) => {
        if (selectedIdRef.current === tx.id) setCorrectionLinks(links);
      }).catch(() => { if (selectedIdRef.current === tx.id) setCorrectionLinkError(true); });
    }
  }, [user]);
  const closeDetails = useCallback(() => detailSheetRef.current?.close(), []);
  const onDetailsChange = useCallback((index: number) => { if (index < 0) { selectedIdRef.current = null; setSelectedTx(null); setCorrectionLinks(null); setCorrectionLinkError(false); } }, []);
  const openLinkedTransaction = async (id: string) => {
    if (!user || loadingLinked) return;
    const sourceId = selectedIdRef.current;
    setLoadingLinked(true);
    try {
      const linked = await localDb.transaction.findById(user.id, id);
      if (selectedIdRef.current !== sourceId) return;
      if (!linked) throw new Error('The linked transaction is no longer available in this profile.');
      selectedIdRef.current = linked.id;
      setSelectedTx(linked);
      setCorrectionLinks(null);
      setCorrectionLinkError(false);
      setRefundAmount('');
      setRefundAccountId(linked.accountId ?? '');
      if (linked.type !== 'Refund' && linked.type !== 'Reversal') {
        const links = await localDb.transaction.findCorrectionLinks(user.id, linked.id);
        if (selectedIdRef.current === linked.id) setCorrectionLinks(links);
      }
      setRefundAmount('');
    } catch (cause) {
      Alert.alert('Transaction unavailable', cause instanceof Error ? cause.message : 'Could not load the linked transaction.');
    } finally { setLoadingLinked(false); }
  };
  const openLinkedOriginal = async () => {
    if (!user || !selectedTx?.linkedOriginalId || loadingLinked) return;
    const sourceId = selectedTx.id;
    setLoadingLinked(true);
    try {
      const original = await localDb.transaction.findById(user.id, selectedTx.linkedOriginalId);
      if (selectedIdRef.current !== sourceId) return;
      if (!original) throw new Error('The original transaction is no longer available in this profile.');
      selectedIdRef.current = original.id;
      setSelectedTx(original);
      setRefundAccountId(original.accountId ?? '');
      setCorrectionLinkError(false);
      if (original.type !== 'Refund' && original.type !== 'Reversal') {
        const links = await localDb.transaction.findCorrectionLinks(user.id, original.id);
        if (selectedIdRef.current === original.id) setCorrectionLinks(links);
      } else setCorrectionLinks(null);
      setRefundAmount('');
    } catch (cause) {
      Alert.alert('Original unavailable', cause instanceof Error ? cause.message : 'Could not load the original transaction.');
    } finally { setLoadingLinked(false); }
  };

  const applyFilters = () => {
    const dateIsValid = (value?: string) => {
      if (!value) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!dateIsValid(draftDates.startDate) || !dateIsValid(draftDates.endDate)) { setFilterError('Use dates in YYYY-MM-DD format.'); return; }
    if (draftDates.startDate && draftDates.endDate && draftDates.startDate > draftDates.endDate) { setFilterError('Start date must be on or before end date.'); return; }
    setFilters({
      types: draftTypes.length && draftTypes.length < FILTER_TYPES.length ? draftTypes : undefined,
      accountId: draftAccountId || undefined,
      categoryId: draftCategoryId || undefined,
      currency: draftCurrency || undefined,
      startDate: draftDates.startDate,
      endDate: draftDates.endDate ? new Date(Date.parse(`${draftDates.endDate}T00:00:00.000Z`) + 86_400_000).toISOString() : undefined,
    });
    setFiltersVisible(false);
  };
  const clearFilters = () => {
    setDraftTypes([]); setDraftAccountId(''); setDraftAccountSearch(''); setDraftCategoryId(''); setDraftCategorySearch(''); setDraftCurrency(''); setDraftDates({}); setFilterError(''); setFilters({});
    setFiltersVisible(false);
  };

  const handleEdit = () => {
    if (!selectedTx) return;
    if (selectedTx.type === 'Refund' || selectedTx.type === 'Reversal') { Alert.alert('Correction unavailable', 'Refund and correction entries are linked history and cannot be corrected again.'); return; }
    if (specializedTransaction(selectedTx)) { Alert.alert('Use the linked feature', 'This entry belongs to a bill, debt, asset, or investment record. Correct it from its dedicated history so both records stay consistent.'); return; }
    const id = selectedTx.id;
    closeDetails();
    router.push({ pathname: '/(tabs)/add', params: { correctionOf: id } });
  };

  const handleRefund = async (refundRemaining: boolean) => {
    if (!selectedTx || !user || !refundAccountId || refundBusy) return;
    let amountMinor: number | undefined;
    try { if (!refundRemaining) amountMinor = parseMinorUnits(refundAmount); }
    catch (cause) { Alert.alert('Enter a valid amount', cause instanceof Error ? cause.message : 'Enter a positive refund amount.'); return; }
    setRefundBusy(true);
    try {
      await localDb.transaction.refund({
        id: Crypto.randomUUID(), ownerId: user.id, originalTransactionId: selectedTx.id,
        accountId: refundAccountId, ...(refundRemaining ? { refundRemaining: true } : { amountMinor }),
        date: new Date(), note: `Refund for ${selectedTx.category}`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['financial-report', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['insights', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['transactions', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['accounts', user.id] }),
      ]);
      setRefundAmount('');
      Alert.alert('Refund recorded', 'The refund was saved to this device and linked to the original expense.');
      closeDetails();
    } catch (cause) {
      Alert.alert('Refund not saved', cause instanceof Error ? cause.message : 'Please review the amount and try again.');
    } finally { setRefundBusy(false); }
  };

  const sections: TransactionSection[] = groupedTransactions;
  const normalizedAccountSearch = draftAccountSearch.trim().toLocaleLowerCase('en-US');
  const visibleFilterAccounts = (accountsQuery.data ?? []).filter((account) => `${account.name} ${account.type} ${account.currency}${account.archivedAt ? ' archived' : ''}`.toLocaleLowerCase('en-US').includes(normalizedAccountSearch));
  const normalizedCategorySearch = draftCategorySearch.trim().toLocaleLowerCase('en-US');
  const visibleCategories = Object.entries(CLASSIFICATIONS).filter(([, value]) => value.label.toLocaleLowerCase('en-US').includes(normalizedCategorySearch));
  const visibleEventCategories = EVENT_CATEGORIES.filter(([, label]) => label.toLocaleLowerCase('en-US').includes(normalizedCategorySearch));
  const selectedActivity = selectedTx ? activityFor(selectedTx) : null;
  const remainingRefund = selectedTx ? Math.max(0, selectedTx.amountMinor - (selectedTx.refundedMinor ?? 0)) : 0;
  const refundAccounts = selectedTx?.accountCurrency ? (accountsQuery.data ?? []).filter((account) => !account.archivedAt && account.currency === selectedTx.accountCurrency) : [];
  const canRefund = refundAccounts.some((account) => account.id === refundAccountId);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} className="flex-1 bg-white dark:bg-neutral-950">
      <GlobalHeader title="Transactions" description="Search and review your financial history" RightIcon={<Filter size={21} color="#635BFF" />} onRightPress={openFilters} rightActionLabel={activeFilterCount ? `Filters, ${activeFilterCount} active` : 'Filter transactions'} />

      <View className="px-5 pt-4 pb-2">
        <View className={`h-12 flex-row items-center border bg-gray-50 px-3 dark:bg-neutral-900 ${isFocused ? 'border-primary' : 'border-gray-200 dark:border-neutral-800'}`}>
          <Search size={19} color={isFocused ? '#635BFF' : '#858995'} />
          <TextInput className="ml-2 flex-1 font-body text-sm text-gray-900 dark:text-white" placeholder="Search transactions, accounts, notes…" placeholderTextColor="#858995" value={searchQuery} onChangeText={setSearchQuery} onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)} onSubmitEditing={() => setDebouncedSearch(searchQuery.trim())} returnKeyType="search" accessibilityLabel="Search all transactions" />
          {!!searchQuery && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => { setSearchQuery(''); setDebouncedSearch(''); }}><X size={18} color="#858995" /></Pressable>}
        </View>
        {activeFilterLabels.length ? <View className="mt-2 flex-row flex-wrap">{activeFilterLabels.map(({ key, label }) => <Pressable key={`${key}-${label}`} accessibilityRole="button" accessibilityLabel={`Remove ${label} filter`} className="mb-1 mr-1 rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 dark:bg-primary/10" onPress={() => setFilters((current) => {
          if (key === 'types') return { ...current, types: undefined };
          if (key === 'dates') return { ...current, startDate: undefined, endDate: undefined };
          if (key === 'accountId') return { ...current, accountId: undefined };
          if (key === 'categoryId') return { ...current, categoryId: undefined };
          return { ...current, currency: undefined };
        })}><Text className="font-body text-[10px] font-medium text-primary">{label} ×</Text></Pressable>)}</View> : null}
      </View>

      {isLoading ? <View className="flex-1 px-5 pt-2">{[0,1,2,3,4].map((row) => <View key={row} className="mb-3 h-[76px] border border-gray-100 bg-gray-50 dark:border-neutral-800 dark:bg-neutral-900" />)}</View> : isError ? (
        <View className="flex-1 items-center justify-center px-8"><Text className="font-body text-center text-gray-700 dark:text-neutral-200">Transactions could not be loaded.</Text><Text className="mt-1 text-center font-body text-xs text-gray-500">{error instanceof Error ? error.message : 'Check storage and try again.'}</Text><Pressable accessibilityRole="button" className="houselog-button mt-4 px-5 py-3" onPress={() => void refetch()}><Text className="font-body font-semibold text-white">Retry</Text></Pressable></View>
      ) : (
        <SectionList<LocalTransaction, TransactionSection>
          sections={sections} onEndReached={() => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage(); }} onEndReachedThreshold={0.35}
          keyExtractor={(item) => item.id} stickySectionHeadersEnabled={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 36, flexGrow: visibleCount ? undefined : 1 }}
          refreshing={isRefetching} onRefresh={() => void refetch()}
          ListFooterComponent={isFetchingNextPage ? <View className="py-4"><ActivityIndicator color="#635BFF" /></View> : null}
          ListEmptyComponent={<View className="flex-1 items-center justify-center py-12"><Text className="font-heading text-base font-semibold text-gray-800 dark:text-white">{debouncedSearch ? 'No matching transactions' : activeFilterCount ? 'No transactions match these filters' : 'No transactions yet'}</Text><Text className="mt-1 text-center font-body text-sm text-gray-500 dark:text-neutral-400">{debouncedSearch || activeFilterCount ? 'Try clearing your search or filters.' : 'Add income, spending, or an account transfer to start your history.'}</Text>{(debouncedSearch || activeFilterCount) ? <Pressable className="mt-3 py-2" onPress={() => { setSearchQuery(''); setDebouncedSearch(''); setFilters({}); }}><Text className="font-body font-semibold text-primary">Clear search and filters</Text></Pressable> : null}</View>}
          renderSectionHeader={({ section }) => <Text className="mb-2 mt-5 font-heading text-sm font-semibold text-gray-700 dark:text-neutral-200">{section.title}</Text>}
          renderItem={({ item }) => {
            const activity = activityFor(item);
            const color = COLORS[item.type];
            const Icon = activity.direction === 'transfer' ? ArrowLeftRight : activity.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
            const isTransfer = item.type === 'Transfer' || (item.type === 'Reversal' && item.linkedOriginalType === 'Transfer');
            const sign = isTransfer ? '' : activity.direction === 'in' ? '+' : '−';
            return <Pressable accessibilityRole="button" accessibilityLabel={`${activity.title}, ${activity.categoryLabel}, ${formatAmount(item.amountMinor, activity.currency)}, ${new Date(item.date).toLocaleString()}`} className="mb-2 flex-row items-center border-b border-gray-100 py-3 dark:border-neutral-800" onPress={() => openDetails(item)}>
              <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-gray-100 dark:bg-neutral-800"><Icon size={19} color={color} /></View>
              <View className="min-w-0 flex-1 pr-2"><Text className="font-body text-sm font-semibold text-gray-900 dark:text-white" numberOfLines={1}>{activity.title}</Text><Text className="mt-0.5 font-body text-xs text-gray-500 dark:text-neutral-400" numberOfLines={1}>{activity.categoryLabel}{activity.accountContext ? ` · ${activity.accountContext}` : ''}</Text></View>
              <View className="items-end"><Text className="font-body text-sm font-bold" style={{ color }}>{sign ? `${sign} ` : ''}{formatAmount(item.amountMinor, activity.currency)}</Text><Text className="mt-0.5 font-body text-[11px] text-gray-500 dark:text-neutral-400">{new Date(item.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text></View>
            </Pressable>;
          }}
        />
      )}

      <BottomSheet
        ref={filterSheetRef}
        index={-1}
        snapPoints={filterSheetPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={backdrop}
        onChange={(index) => { if (index < 0) setFiltersVisible(false); }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        handleIndicatorStyle={{ backgroundColor: '#9ca3af', width: 40 }}
        backgroundStyle={{ backgroundColor: 'transparent' }}
      >
        <View className="flex-1 border-t border-gray-200 bg-white px-5 pt-3 dark:border-neutral-700 dark:bg-neutral-900">
          <View className="mb-3 flex-row items-center justify-between"><View><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Filter transactions</Text><Text className="mt-0.5 font-body text-xs text-gray-500 dark:text-neutral-400">Narrow your history, then apply all filters together.</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close filters" hitSlop={8} onPress={() => setFiltersVisible(false)} className="h-10 w-10 items-center justify-center rounded-full bg-gray-100 dark:bg-neutral-800"><X size={20} color="#858995" /></Pressable></View>
          <BottomSheetScrollView className="flex-1" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 12 }}>
            <View className="mb-3 rounded-2xl bg-gray-50 p-3 dark:bg-neutral-800/70">
              <View className="mb-2"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Transaction type</Text><Text className="mt-0.5 font-body text-xs text-gray-500 dark:text-neutral-400">Choose one or more. All types are included by default.</Text></View>
              <View className="flex-row flex-wrap"><Choice label="All types" selected={draftTypes.length === 0} onPress={() => setDraftTypes([])} />{FILTER_TYPES.map((type) => { const selected = draftTypes.includes(type); return <Choice key={type} label={type} selected={selected} onPress={() => setDraftTypes((current) => { const effective = current.length ? current : [...FILTER_TYPES]; return effective.includes(type) ? effective.filter((item) => item !== type) : [...effective, type]; })} />; })}</View>
            </View>

            <View className="mb-3 rounded-2xl bg-gray-50 p-3 dark:bg-neutral-800/70">
              <View className="mb-2"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Account</Text><Text className="mt-0.5 font-body text-xs text-gray-500 dark:text-neutral-400">Include activity paid from or transferred to this account.</Text></View>
              {accountsQuery.isError ? <Pressable accessibilityRole="button" className="py-2" onPress={() => void accountsQuery.refetch()}><Text className="font-body text-sm text-red-600">Accounts unavailable · tap to retry</Text></Pressable> : <>
                {(accountsQuery.data?.length ?? 0) > 5 ? <View className="mb-2 h-10 flex-row items-center rounded-xl border border-gray-200 bg-white px-3 dark:border-neutral-700 dark:bg-neutral-900"><Search size={16} color="#858995" /><BottomSheetTextInput accessibilityLabel="Search filter accounts" className="ml-2 flex-1 font-body text-sm text-gray-900 dark:text-white" placeholder="Find an account" placeholderTextColor="#858995" value={draftAccountSearch} onChangeText={setDraftAccountSearch} /><Pressable accessibilityRole="button" accessibilityLabel="Clear account search" onPress={() => setDraftAccountSearch('')}><X size={16} color="#858995" /></Pressable></View> : null}
                <View className="flex-row flex-wrap"><Choice label="All accounts" selected={!draftAccountId} onPress={() => setDraftAccountId('')} />{visibleFilterAccounts.map((account) => <Choice key={account.id} label={`${account.name}${account.archivedAt ? ' · archived' : ''}`} selected={draftAccountId === account.id} onPress={() => setDraftAccountId(account.id)} />)}{visibleFilterAccounts.length === 0 ? <Text className="py-2 font-body text-xs text-gray-500 dark:text-neutral-400">No matching accounts.</Text> : null}</View>
              </>}
            </View>

            <View className="mb-3 rounded-2xl bg-gray-50 p-3 dark:bg-neutral-800/70">
              <View className="mb-2"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Category or activity</Text><Text className="mt-0.5 font-body text-xs text-gray-500 dark:text-neutral-400">Find spending, income, transfers, or linked financial activity.</Text></View>
              <View className="mb-2 h-10 flex-row items-center rounded-xl border border-gray-200 bg-white px-3 dark:border-neutral-700 dark:bg-neutral-900"><Search size={16} color="#858995" /><BottomSheetTextInput accessibilityLabel="Search filter categories" className="ml-2 flex-1 font-body text-sm text-gray-900 dark:text-white" placeholder="Find a category or activity" placeholderTextColor="#858995" value={draftCategorySearch} onChangeText={setDraftCategorySearch} /><Pressable accessibilityRole="button" accessibilityLabel="Clear category search" onPress={() => setDraftCategorySearch('')}><X size={16} color="#858995" /></Pressable></View>
              <View className="flex-row flex-wrap"><Choice label="All categories" selected={!draftCategoryId} onPress={() => setDraftCategoryId('')} />{visibleCategories.map(([id, value]) => <Choice key={id} label={value.label} selected={draftCategoryId === id} onPress={() => setDraftCategoryId(draftCategoryId === id ? '' : id)} />)}{visibleEventCategories.map(([id, label]) => <Choice key={id} label={label} selected={draftCategoryId === id} onPress={() => setDraftCategoryId(draftCategoryId === id ? '' : id)} />)}{visibleCategories.length + visibleEventCategories.length === 0 ? <Text className="py-2 font-body text-xs text-gray-500 dark:text-neutral-400">No matching categories.</Text> : null}</View>
            </View>

            {allCurrencies.length > 1 ? <View className="mb-3 rounded-2xl bg-gray-50 p-3 dark:bg-neutral-800/70"><View className="mb-2"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Currency</Text><Text className="mt-0.5 font-body text-xs text-gray-500 dark:text-neutral-400">Show transactions involving this currency.</Text></View><View className="flex-row flex-wrap"><Choice label="All currencies" selected={!draftCurrency} onPress={() => setDraftCurrency('')} />{allCurrencies.map((currency) => <Choice key={currency} label={currency} selected={draftCurrency === currency} onPress={() => setDraftCurrency(draftCurrency === currency ? '' : currency)} />)}</View></View> : null}

            <View className="mb-2 rounded-2xl bg-gray-50 p-3 dark:bg-neutral-800/70"><View className="mb-2"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Date range</Text><Text className="mt-0.5 font-body text-xs text-gray-500 dark:text-neutral-400">Leave either date empty for an open-ended range.</Text></View><View className="flex-row"><View className="mr-2 flex-1"><DatePickerField label="From date" accessibilityLabel="Start date" value={draftDates.startDate?.slice(0, 10) ?? ''} onChangeText={(value) => setDraftDates((old) => ({ ...old, startDate: value || undefined }))} clearable/></View><View className="flex-1"><DatePickerField label="Through date" accessibilityLabel="End date" value={draftDates.endDate?.slice(0, 10) ?? ''} onChangeText={(value) => setDraftDates((old) => ({ ...old, endDate: value || undefined }))} clearable/></View></View></View>
          </BottomSheetScrollView>
          <View className="border-t border-gray-100 bg-white pt-3 pb-3 dark:border-neutral-800 dark:bg-neutral-900">
            {!!filterError && <Text accessibilityRole="alert" className="mb-2 font-body text-sm text-red-600">{filterError}</Text>}
            <View className="flex-row"><Pressable accessibilityRole="button" className="mr-2 h-12 flex-1 items-center justify-center rounded-xl border border-gray-300 dark:border-neutral-700" onPress={clearFilters}><Text className="font-body font-semibold text-gray-700 dark:text-neutral-200">Clear all</Text></Pressable><Pressable accessibilityRole="button" className="houselog-button h-12 flex-1 items-center justify-center rounded-xl" onPress={applyFilters}><Text className="font-body font-semibold text-white">Apply filters</Text></Pressable></View>
          </View>
        </View>
      </BottomSheet>

      <BottomSheet ref={detailSheetRef} index={-1} snapPoints={sheetPoints} enablePanDownToClose backdropComponent={backdrop} onChange={onDetailsChange} keyboardBehavior="interactive" keyboardBlurBehavior="restore" handleIndicatorStyle={{ backgroundColor: '#9ca3af', width: 40 }}>
        {selectedTx && selectedActivity ? <ScrollView className="flex-1 px-5" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
          <View className="mb-4 flex-row items-center justify-between"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Transaction details</Text><Pressable accessibilityRole="button" accessibilityLabel="Close transaction details" onPress={closeDetails}><X size={22} color="#777" /></Pressable></View>
          <View className="mb-4 border-b border-gray-100 pb-4 dark:border-neutral-800"><Text className="font-body text-sm font-semibold text-gray-600 dark:text-neutral-300">{selectedActivity.categoryLabel}{selectedActivity.statusLabel ? ` · ${selectedActivity.statusLabel}` : ''}</Text><View className="mt-1 flex-row items-center">{selectedTx.type === 'Transfer' ? <ArrowLeftRight size={21} color={COLORS[selectedTx.type]} style={{ marginRight: 8 }} /> : null}<Text className="font-heading text-2xl font-bold" style={{ color: COLORS[selectedTx.type] }}>{selectedTx.type === 'Transfer' ? '' : selectedActivity.direction === 'in' ? '+ ' : '− '}{formatAmount(selectedTx.amountMinor, selectedActivity.currency)}</Text></View><Text className="mt-1 font-body text-sm text-gray-700 dark:text-neutral-200">{new Date(selectedTx.date).toLocaleString()}</Text></View>
          {!!selectedTx.note && <Detail label="Description" value={selectedTx.note} />}
          {!!selectedActivity.accountContext && <Detail label={selectedTx.type === 'Transfer' ? 'Accounts' : selectedActivity.direction === 'in' ? 'Received into' : 'Paid from'} value={selectedActivity.accountContext} />}
          {selectedTx.type === 'Transfer' && selectedTx.destinationCurrency && selectedTx.destinationCurrency !== selectedTx.accountCurrency ? <Detail label="Transfer currency" value={`${selectedTx.accountCurrency ?? 'Unavailable'} → ${selectedTx.destinationCurrency}`} /> : null}
          {selectedTx.linkedOriginalId ? <Pressable accessibilityRole="button" accessibilityLabel="Open original transaction" disabled={loadingLinked} onPress={() => void openLinkedOriginal()} className="mb-3 border-l-2 border-primary pl-3"><Text className="font-body text-xs font-semibold text-primary">{loadingLinked ? 'Loading original…' : `Open original · ${selectedTx.linkedOriginalType ?? 'transaction'}`}</Text>{selectedTx.linkedOriginalNote ? <Text className="mt-1 font-body text-sm text-gray-700 dark:text-neutral-200">{selectedTx.linkedOriginalNote}</Text> : null}<Text className="mt-1 font-body text-xs text-gray-500">Reference: {selectedTx.linkedOriginalId}</Text></Pressable> : null}
          {selectedTx.type === 'Expense' && selectedTx.accountId ? <Detail label="Refund status" value={`${formatAmount(selectedTx.refundedMinor ?? 0, selectedActivity.currency)} refunded · ${formatAmount(remainingRefund, selectedActivity.currency)} remaining`} /> : null}
          {!!selectedTx.sourceName && <Detail label="Source / recipient" value={selectedTx.sourceName} />}
          {!!selectedTx.paymentMethod && <Detail label="Payment method" value={selectedTx.paymentMethod} />}
          {!!selectedTx.sourceAmountMinor && !!selectedTx.sourceCurrency ? <Detail label="Original remittance" value={`${formatMinorUnits(selectedTx.sourceAmountMinor, selectedTx.sourceCurrency)} · exchange rate ${selectedTx.exchangeRate ?? 'unavailable'}`} /> : null}
          {!!selectedTx.referenceNumber && <Detail label="Reference number" value={selectedTx.referenceNumber} />}
          {selectedTx.type === 'Income' ? <Detail label="Tax record" value={selectedTx.taxStatus === 'taxable' ? `Taxable · tax year ${selectedTx.taxYear ?? 'not set'}` : selectedTx.taxStatus === 'non_taxable' ? `Marked non-taxable · tax year ${selectedTx.taxYear ?? 'not set'}` : 'Not reviewed'} /> : null}
          {selectedTx.correctionOfId ? <Detail label="Correction status" value={`Replacement for ${selectedTx.correctionOfId}`} /> : null}
          {correctionLinkError ? <Text className="mb-3 font-body text-xs text-amber-700">Correction links could not be loaded. Try closing and reopening this transaction.</Text> : null}
          {correctionLinks && (correctionLinks.reversalId || correctionLinks.replacementId) ? <View className="mb-3 border-l-2 border-amber-500 pl-3"><Text className="font-body text-xs font-semibold text-amber-700">This original transaction was corrected</Text>{correctionLinks.reversalId ? <Pressable accessibilityRole="button" onPress={() => void openLinkedTransaction(correctionLinks.reversalId!)} className="py-2"><Text className="font-body text-sm font-semibold text-primary">Open reversal · {correctionLinks.reversalId}</Text></Pressable> : null}{correctionLinks.replacementId ? <Pressable accessibilityRole="button" onPress={() => void openLinkedTransaction(correctionLinks.replacementId!)} className="py-2"><Text className="font-body text-sm font-semibold text-primary">Open replacement · {correctionLinks.replacementId}</Text></Pressable> : null}</View> : null}
          {selectedTx.type === 'Expense' && remainingRefund > 0 && !specializedTransaction(selectedTx) ? <View className="mt-3 border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="mb-2 font-body text-sm font-semibold text-gray-800 dark:text-white">Record a refund</Text><Text className="mb-2 font-body text-xs text-gray-500">Maximum remaining: {formatAmount(remainingRefund, selectedActivity.currency)}</Text><Text className="mb-1 font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Refund into an active same-currency account</Text><View className="mb-2 flex-row flex-wrap">{refundAccounts.map((account) => <Choice key={account.id} label={account.name} selected={refundAccountId === account.id} onPress={() => setRefundAccountId(account.id)} />)}</View>{!canRefund ? <Text className="mb-2 font-body text-xs text-amber-700">Select an active account in {selectedTx.accountCurrency ?? 'the transaction currency'}. The original account may be archived.</Text> : null}<BottomSheetTextInput className="mb-2 h-12 border border-gray-200 px-3 font-body text-base text-gray-900 dark:border-neutral-700 dark:text-white" placeholder="Partial amount" placeholderTextColor="#858995" keyboardType="decimal-pad" value={refundAmount} onChangeText={(value) => setRefundAmount(sanitizeGroupedAmountInput(value))} accessibilityLabel="Partial refund amount" /><Pressable accessibilityRole="button" disabled={refundBusy || !canRefund} className={`houselog-button mb-2 h-12 items-center justify-center ${refundBusy || !canRefund ? 'opacity-60' : ''}`} onPress={() => void handleRefund(false)}>{refundBusy ? <ActivityIndicator color="#fff" /> : <Text className="font-body font-semibold text-white">Record partial refund</Text>}</Pressable><Pressable accessibilityRole="button" disabled={refundBusy || !canRefund} className={`h-11 items-center justify-center border border-primary ${refundBusy || !canRefund ? 'opacity-60' : ''}`} onPress={() => void handleRefund(true)}><Text className="font-body font-semibold text-primary">Refund full remaining amount</Text></Pressable></View> : null}
          {selectedTx.type !== 'Refund' && selectedTx.type !== 'Reversal' && !specializedTransaction(selectedTx) ? <Pressable accessibilityRole="button" className="houselog-button mt-4 h-12 flex-row items-center justify-center" onPress={handleEdit}><Edit size={18} color="#fff" /><Text className="ml-2 font-body font-semibold text-white">Correct transaction</Text></Pressable> : specializedTransaction(selectedTx) ? <Text className="mt-4 font-body text-sm text-gray-500 dark:text-neutral-400">Correct this record in its linked bill, debt, asset, or investment history to preserve both records.</Text> : null}
        </ScrollView> : null}
      </BottomSheet>
    </SafeAreaView>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={onPress} className={`mb-2 mr-2 ${selected ? BADGE_PRIMARY : BADGE_NEUTRAL} px-3 py-2`}><Text className={`font-body text-xs ${selected ? `font-semibold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{label}</Text></Pressable>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <View className="mb-3"><Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{label}</Text><Text className="mt-0.5 font-body text-sm text-gray-900 dark:text-neutral-100">{value}</Text></View>;
}
