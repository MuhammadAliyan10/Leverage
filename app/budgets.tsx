import { PRIMARY_COLOR } from '../src/constants/themeColors';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Button } from '../components/ui/Button';
import { BudgetProgressBar } from '../components/ui/BudgetProgressBar';
import { DoneHeader } from '../components/ui/DoneHeader';
import { useAuth } from '../src/context/AuthContext';
import { CLASSIFICATIONS, CURRENCIES, EXPENSE_CLASSIFICATION_IDS, type CurrencyCode } from '../src/finance/domain';
import { formatGroupedAmountInput, formatMinorUnits, formatMinorUnitsForInput, parseMinorUnits } from '../src/finance/ledger';
import { useBudgeting, useBudgetingWrites } from '../hooks/queries/useBudgeting';

// A budget period is a calendar date, not an instant. Formatting local parts avoids
// shifting the first of the month to the previous UTC date (e.g. Asia/Karachi).
const asMonthStart = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
const requestId = () => `houselog-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function BudgetsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [month, setMonth] = useState(() => new Date());
  const [currency, setCurrency] = useState<CurrencyCode>('PKR');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const periodStart = asMonthStart(month);
  const { data, isLoading, error, refetch } = useBudgeting(periodStart);
  const writes = useBudgetingWrites();
  const isSaving = writes.saveBudget.isPending;
  const isChangingBudget = writes.archiveBudget.isPending || writes.deleteBudget.isPending;
  const isBusy = isSaving || isChangingBudget || writes.rollover.isPending;
  const existing = useMemo(() => new Map((data?.budgets ?? []).filter((item) => item.currency === currency).map((item) => [item.categoryId, item])), [data?.budgets, currency]);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  useEffect(() => {
    setLimits({});
    setErrors({});
  }, [periodStart, currency]);

  const confirmAction = (title: string, message: string): Promise<boolean> => {
    if (Platform.OS === 'web') return Promise.resolve(typeof globalThis.confirm === 'function' && globalThis.confirm(`${title}\n\n${message}`));
    return new Promise((resolve) => Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }));
  };

  const save = async (categoryId: (typeof EXPENSE_CLASSIFICATION_IDS)[number]) => {
    if (!user) return;
    setErrors((current) => ({ ...current, [categoryId]: '' }));
    setNotice('');
    try {
      const amountMinor = parseMinorUnits(limits[categoryId] ?? '');
      const current = existing.get(categoryId);
      await writes.saveBudget.mutateAsync({
        id: requestId(), ownerId: user.id, categoryId, amountMinor, currency,
        periodStart, periodEnd: new Date(Date.UTC(month.getFullYear(), month.getMonth() + 1, 1)).toISOString().slice(0, 10),
        rolloverPolicy: current?.rolloverPolicy ?? 'reset', replacesBudgetId: current?.id,
      });
      setLimits((value) => ({ ...value, [categoryId]: '' }));
      setNotice(`${CLASSIFICATIONS[categoryId].label} budget saved for ${monthLabel}.`);
    } catch (e) { setErrors((current) => ({ ...current, [categoryId]: e instanceof Error ? e.message : 'Could not save this budget. Try again.' })); }
  };
  const archive = async (id: string) => {
    if (isBusy) return;
    if (!await confirmAction('Archive this budget?', 'Its history will remain available.')) return;
    setNotice('');
    writes.archiveBudget.mutate(id, {
      onSuccess: () => setNotice('Budget archived. Its history has been preserved.'),
      onError: (e) => setNotice(`Could not archive this budget: ${e.message}`),
    });
  };
  const rollover = async () => {
    if (!user) return;
    const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    try {
      await writes.rollover.mutateAsync({ ownerId: user.id, sourcePeriodStart: periodStart, targetPeriodStart: asMonthStart(next), requestId: requestId(), policy: 'carry_unused' });
      setMonth(next);
      setNotice(`Budgets carried forward to ${next.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}.`);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not roll budgets forward. Try again.'); }
  };
  const snapshotByCurrency = new Map((data?.snapshots ?? []).map((snapshot) => [snapshot.currency, snapshot]));

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Monthly Budgets" onDone={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} />
    <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 28 }}>
      <View className="mb-4 flex-row items-center justify-between rounded-2xl border border-gray-100 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
        <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-gray-50 dark:bg-neutral-800"><ChevronLeft color={PRIMARY_COLOR} /></Pressable>
        <View className="items-center"><Text className="font-body text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-neutral-400">Budget period</Text><Text className="font-heading mt-0.5 font-bold text-gray-900 dark:text-white">{monthLabel}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-gray-50 dark:bg-neutral-800"><ChevronRight color={PRIMARY_COLOR} /></Pressable>
      </View>
      {!!error && <View className="mb-4 rounded-xl bg-red-50 dark:bg-red-950 p-3">
        <Text className="font-body text-sm text-red-700 dark:text-red-200">Budgets could not be loaded: {error.message}</Text>
        <Pressable accessibilityRole="button" onPress={() => void refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable>
      </View>}
      {!!notice && <Text accessibilityRole="text" accessibilityLiveRegion="polite" className="font-body mb-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm text-primary dark:bg-primary/10">{notice}</Text>}
      {isLoading ? <Text className="font-body py-6 text-gray-500 dark:text-neutral-400">Loading budgets…</Text> : null}
      {[...(data?.snapshots ?? [])].map((snapshot) => <View key={snapshot.currency} className="mb-3 rounded-2xl border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <View className="mb-3 flex-row items-center justify-between"><Text className="font-heading font-bold text-gray-900 dark:text-white">{snapshot.currency} overview</Text><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{monthLabel}</Text></View>
        <View className="flex-row">
          <View className="mr-2 flex-1 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Spent</Text><Text className="font-body mt-1 text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(snapshot.spentMinor, snapshot.currency)}</Text></View>
          <View className="ml-2 flex-1 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Budgeted</Text><Text className="font-body mt-1 text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(snapshot.allocatedMinor, snapshot.currency)}</Text></View>
        </View>
        <View className="mt-3 flex-row items-center justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{snapshot.remainingMinor < 0 ? 'Over budget' : 'Remaining'}</Text><Text className={`font-body text-sm font-bold ${snapshot.remainingMinor < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{formatMinorUnits(Math.abs(snapshot.remainingMinor), snapshot.currency)}</Text></View>
      </View>)}
      {data?.excludedCurrencies.length ? <Text className="font-body mb-4 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-950 dark:text-amber-200">Currencies are kept separate; no exchange-rate conversion is applied. Activity in { [...new Set(data.excludedCurrencies)].join(', ') } is shown only in its own currency summary.</Text> : null}
      <Text className="font-body mb-4 text-sm leading-5 text-gray-600 dark:text-neutral-300">Set a monthly limit for each category. Spent amounts use the full selected month; transfers and opening balances are excluded. Refunds reduce category spending.</Text>
      <Text className="font-body mb-2 text-sm font-semibold text-gray-700 dark:text-neutral-300">Budget currency</Text>
      <View className="mb-4 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: currency === code }} accessibilityLabel={`${CURRENCIES[code].label}, ${code}`} onPress={() => setCurrency(code)} className={`mr-2 mb-2 rounded-full px-3 py-2 ${currency === code ? 'bg-primary' : 'bg-white dark:bg-neutral-900'}`}><Text className={["font-body", (currency === code ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>{code}</Text></Pressable>)}</View>
      {EXPENSE_CLASSIFICATION_IDS.map((categoryId) => {
        const item = existing.get(categoryId);
        const spent = snapshotByCurrency.get(currency)?.categories.find((category) => category.category === categoryId)?.spentMinor ?? 0;
        const remove = async () => {
          if (!item || isChangingBudget || !await confirmAction('Delete unused budget?', 'Budgets with financial activity or revision history must be archived.')) return;
          setNotice('');
          writes.deleteBudget.mutate(item.id, {
            onSuccess: () => setNotice('Unused budget removed.'),
            onError: (e) => setNotice(`Could not delete this budget: ${e.message}`),
          });
        };
        return <View key={categoryId} className="mb-3 rounded-2xl border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <View className="flex-row items-center justify-between">
            <Text className="font-body flex-1 font-semibold text-gray-900 dark:text-white">{CLASSIFICATIONS[categoryId].label}</Text>
            {item ? <View className="flex-row"><Pressable accessibilityRole="button" accessibilityLabel={`Delete unused ${CLASSIFICATIONS[categoryId].label} budget`} disabled={isChangingBudget || isSaving} onPress={remove} className="mr-2 min-h-10 justify-center rounded-lg px-2"><Text className="font-body text-xs font-semibold text-gray-500 dark:text-neutral-400">Delete</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Archive ${CLASSIFICATIONS[categoryId].label} budget`} disabled={isChangingBudget || isSaving} onPress={() => archive(item.id)} className="min-h-10 justify-center rounded-lg px-2"><Text className="font-body text-xs font-semibold text-red-600 dark:text-red-400">Archive</Text></Pressable></View> : null}
          </View>
          <Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Spent {formatMinorUnits(spent, item?.currency ?? currency)}{item ? ` of ${formatMinorUnits(item.amountMinor, item.currency)}` : ' · No limit set'}</Text>
          {item ? <View className="mt-3"><BudgetProgressBar spent={Math.max(0, spent) / 100} limit={item.amountMinor / 100} /></View> : null}
          <View className="flex-row items-center mt-3">
            <TextInput accessibilityLabel={`${CLASSIFICATIONS[categoryId].label} monthly budget amount in ${currency}`}
              editable={!isSaving}
              value={limits[categoryId] ?? ''} onChangeText={(value) => {
                setLimits((previous) => ({ ...previous, [categoryId]: formatGroupedAmountInput(value) }));
                setErrors((previous) => ({ ...previous, [categoryId]: '' }));
              }}
              placeholder={item ? `${formatMinorUnitsForInput(item.amountMinor)} ${item.currency}` : `Limit in ${currency}`} placeholderTextColor="#9ca3af" keyboardType="decimal-pad"
              className="font-body min-h-11 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" />
            <Pressable accessibilityRole="button" accessibilityLabel={`${item ? 'Update' : 'Set'} ${CLASSIFICATIONS[categoryId].label} budget`}
              onPress={() => void save(categoryId)} disabled={isBusy}
              className={`houselog-button ml-2 min-h-11 justify-center px-3 py-2 ${isBusy ? 'opacity-60' : ''}`}>
              <Text className="font-body text-xs font-bold text-white">{writes.saveBudget.isPending ? 'Saving…' : item ? 'Update' : 'Set'}</Text>
            </Pressable>
          </View>
          {!!errors[categoryId] && <Text accessibilityRole="alert" className="font-body mt-2 text-xs leading-5 text-red-600 dark:text-red-400">{errors[categoryId]}</Text>}
        </View>;
      })}
      <Button title="Carry unused limits to next month" disabled={isChangingBudget || isSaving} isLoading={writes.rollover.isPending} onPress={() => void rollover()} />
      <Pressable accessibilityRole="button" onPress={() => router.push('/savings')} className="mt-4 rounded-2xl border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-body font-bold text-primary">Savings goals & emergency fund →</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">View goals and emergency-fund progress</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}
