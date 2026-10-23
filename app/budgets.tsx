import { PRIMARY_COLOR } from '../src/constants/themeColors';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, Wallet } from 'lucide-react-native';
import { Button } from '../components/ui/Button';
import { BudgetProgressBar } from '../components/ui/BudgetProgressBar';
import { useAuth } from '../src/context/AuthContext';
import { CLASSIFICATIONS, CURRENCIES, EXPENSE_CLASSIFICATION_IDS, type CurrencyCode } from '../src/finance/domain';
import { formatMinorUnits, formatMinorUnitsForInput, parseMinorUnits } from '../src/finance/ledger';
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
    <View className="flex-row items-center px-4 pt-4 pb-3 border-b border-gray-200 dark:border-neutral-800">
      <Pressable onPress={() => router.back()} className="p-2"><Text className="font-body text-primary font-bold">Done</Text></Pressable>
      <Text className="font-heading flex-1 text-center font-bold text-lg dark:text-white">Monthly Budgets</Text><View className="w-10" />
    </View>
    <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 28 }}>
      <View className="flex-row items-center justify-between mb-4 rounded-2xl bg-white dark:bg-neutral-900 p-3">
        <Pressable accessibilityLabel="Previous month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="p-2"><ChevronLeft color={PRIMARY_COLOR} /></Pressable>
        <Text className="font-body font-bold text-gray-900 dark:text-white">{monthLabel}</Text>
        <Pressable accessibilityLabel="Next month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="p-2"><ChevronRight color={PRIMARY_COLOR} /></Pressable>
      </View>
      {!!error && <View className="mb-4 rounded-xl bg-red-50 dark:bg-red-950 p-3">
        <Text className="font-body text-sm text-red-700 dark:text-red-200">Budgets could not be loaded: {error.message}</Text>
        <Pressable accessibilityRole="button" onPress={() => void refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable>
      </View>}
      {!!notice && <Text accessibilityRole="text" accessibilityLiveRegion="polite" className="font-body text-sm text-primary mb-4">{notice}</Text>}
      {isLoading ? <Text className="font-body text-gray-500 py-6">Loading budgets…</Text> : null}
      {[...(data?.snapshots ?? [])].map((snapshot) => <View key={snapshot.currency} className="mb-4 rounded-2xl bg-primary/10 p-4">
        <Text className="font-body font-bold text-primary">{snapshot.currency} spending · {monthLabel}</Text>
        <Text className="font-body mt-1 text-gray-800 dark:text-white">Spent {formatMinorUnits(snapshot.spentMinor, snapshot.currency)} · Budgeted {formatMinorUnits(snapshot.allocatedMinor, snapshot.currency)}</Text>
        <Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Remaining {formatMinorUnits(snapshot.remainingMinor, snapshot.currency)} (negative means over budget)</Text>
      </View>)}
      {data?.excludedCurrencies.length ? <Text className="font-body mb-4 text-sm text-amber-700">Foreign currency activity is kept separate and not converted into PKR totals: {[...new Set(data.excludedCurrencies)].join(', ')}.</Text> : null}
      <Text className="font-body text-gray-500 dark:text-neutral-400 mb-4">Set a monthly limit by category. Spending uses the complete transaction history for this month; transfers and opening balances are excluded.</Text>
      <Text className="font-body mb-2 text-sm font-semibold text-gray-700 dark:text-neutral-300">Budget currency</Text>
      <View className="mb-4 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: currency === code }} accessibilityLabel={`${CURRENCIES[code].label}, ${code}`} onPress={() => setCurrency(code)} className={`mr-2 mb-2 rounded-full px-3 py-2 ${currency === code ? 'bg-primary' : 'bg-white dark:bg-neutral-900'}`}><Text className={["font-body", (currency === code ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs')].filter(Boolean).join(' ')}>{code}</Text></Pressable>)}</View>
      {EXPENSE_CLASSIFICATION_IDS.map((categoryId) => {
        const item = existing.get(categoryId);
        const spent = snapshotByCurrency.get(currency)?.categories.find((category) => category.category === categoryId)?.spentMinor ?? 0;
        const remove = async () => {
          if (!item || !await confirmAction('Delete unused budget?', 'Budgets with financial activity or revision history must be archived.')) return;
          setNotice('');
          writes.deleteBudget.mutate(item.id, {
            onSuccess: () => setNotice('Unused budget removed.'),
            onError: (e) => setNotice(`Could not delete this budget: ${e.message}`),
          });
        };
        return <View key={categoryId} className="mb-3 rounded-2xl bg-white dark:bg-neutral-900 p-4">
          <View className="flex-row items-center justify-between">
            <Text className="font-body flex-1 font-semibold text-gray-900 dark:text-white">{CLASSIFICATIONS[categoryId].label}</Text>
            {item ? <View className="flex-row"><Pressable onPress={remove} className="mr-3"><Text className="font-body text-gray-500 font-semibold">Delete</Text></Pressable><Pressable onPress={() => archive(item.id)}><Text className="font-body text-red-500 font-semibold">Archive</Text></Pressable></View> : null}
          </View>
          <Text className="font-body mt-2 text-sm text-gray-500 dark:text-neutral-400">Spent {formatMinorUnits(spent, item?.currency ?? 'PKR')}{item ? ` of ${formatMinorUnits(item.amountMinor, item.currency)}` : ' · No limit set'}</Text>
          {item ? <View className="mt-3"><BudgetProgressBar categoryName={CLASSIFICATIONS[categoryId].label} icon={Wallet} spent={Math.max(0, spent) / 100} limit={item.amountMinor / 100} currency={currency} /></View> : null}
          <View className="flex-row items-center mt-3">
            <TextInput accessibilityLabel={`${CLASSIFICATIONS[categoryId].label} monthly budget amount in ${currency}`}
              value={limits[categoryId] ?? ''} onChangeText={(value) => {
                setLimits((previous) => ({ ...previous, [categoryId]: value }));
                setErrors((previous) => ({ ...previous, [categoryId]: '' }));
              }}
              placeholder={item ? `${formatMinorUnitsForInput(item.amountMinor)} (${item.currency})` : `Monthly limit in ${currency}`} keyboardType="decimal-pad"
              className="font-body flex-1 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
            <Pressable accessibilityRole="button" accessibilityLabel={`${item ? 'Update' : 'Set'} ${CLASSIFICATIONS[categoryId].label} budget`}
              onPress={() => void save(categoryId)} disabled={writes.saveBudget.isPending}
              className={`houselog-button ml-2 px-4 py-3 ${writes.saveBudget.isPending ? 'opacity-60' : ''}`}>
              <Text className="font-body font-bold text-white">{writes.saveBudget.isPending ? 'Saving…' : item ? 'Update' : 'Set limit'}</Text>
            </Pressable>
          </View>
          {!!errors[categoryId] && <Text accessibilityRole="alert" className="font-body mt-2 text-sm text-red-600">{errors[categoryId]}</Text>}
        </View>;
      })}
      <Button title="Carry unused limits to next month" isLoading={writes.rollover.isPending} onPress={() => void rollover()} />
      <Pressable onPress={() => router.push('/savings')} className="mt-4 rounded-2xl bg-white dark:bg-neutral-900 p-4"><Text className="font-body font-bold text-primary">Savings goals & emergency fund →</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}
