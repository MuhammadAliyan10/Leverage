import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, Wallet } from 'lucide-react-native';
import { Button } from '../components/ui/Button';
import { BudgetProgressBar } from '../components/ui/BudgetProgressBar';
import { useAuth } from '../src/context/AuthContext';
import { CLASSIFICATIONS, CURRENCIES, EXPENSE_CLASSIFICATION_IDS, type CurrencyCode } from '../src/finance/domain';
import { formatMinorUnits, parseMinorUnits } from '../src/finance/ledger';
import { useBudgeting, useBudgetingWrites } from '../hooks/queries/useBudgeting';

const asMonthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1).toISOString().slice(0, 10);
const requestId = () => `houselog-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function BudgetsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [month, setMonth] = useState(() => new Date());
  const [currency, setCurrency] = useState<CurrencyCode>('PKR');
  const periodStart = asMonthStart(month);
  const { data, isLoading, error } = useBudgeting(periodStart);
  const writes = useBudgetingWrites();
  const existing = useMemo(() => new Map((data?.budgets ?? []).filter((item) => item.currency === currency).map((item) => [item.categoryId, item])), [data?.budgets, currency]);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const save = async (categoryId: string) => {
    if (!user) return;
    try {
      const amountMinor = parseMinorUnits(limits[categoryId] ?? '');
      const current = existing.get(categoryId);
      await writes.saveBudget.mutateAsync({
        id: requestId(), ownerId: user.id, categoryId, amountMinor, currency,
        periodStart, periodEnd: new Date(Date.UTC(month.getFullYear(), month.getMonth() + 1, 1)).toISOString().slice(0, 10),
        rolloverPolicy: current?.rolloverPolicy ?? 'reset', replacesBudgetId: current?.id,
      });
      setLimits((value) => ({ ...value, [categoryId]: '' }));
    } catch (e) { Alert.alert('Could not save budget', e instanceof Error ? e.message : 'Try again.'); }
  };
  const archive = (id: string) => Alert.alert('Archive this budget?', 'Its history will remain available.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Archive', style: 'destructive', onPress: () => writes.archiveBudget.mutate(id, { onError: (e) => Alert.alert('Could not archive', e.message) }) },
  ]);
  const rollover = async () => {
    if (!user) return;
    const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    try {
      await writes.rollover.mutateAsync({ ownerId: user.id, sourcePeriodStart: periodStart, targetPeriodStart: asMonthStart(next), requestId: requestId(), policy: 'carry_unused' });
      setMonth(next);
    } catch (e) { Alert.alert('Could not roll budgets forward', e instanceof Error ? e.message : 'Try again.'); }
  };
  const snapshotByCurrency = new Map((data?.snapshots ?? []).map((snapshot) => [snapshot.currency, snapshot]));

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <View className="flex-row items-center px-4 pt-4 pb-3 border-b border-gray-200 dark:border-neutral-800">
      <Pressable onPress={() => router.back()} className="p-2"><Text className="text-primary font-bold">Done</Text></Pressable>
      <Text className="flex-1 text-center font-bold text-lg dark:text-white">Monthly Budgets</Text><View className="w-10" />
    </View>
    <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 28 }}>
      <View className="flex-row items-center justify-between mb-4 rounded-2xl bg-white dark:bg-neutral-900 p-3">
        <Pressable accessibilityLabel="Previous month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="p-2"><ChevronLeft color="#533AFE" /></Pressable>
        <Text className="font-bold text-gray-900 dark:text-white">{monthLabel}</Text>
        <Pressable accessibilityLabel="Next month" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="p-2"><ChevronRight color="#533AFE" /></Pressable>
      </View>
      {!!error && <Text className="text-red-600 mb-4">{error.message}</Text>}
      {isLoading ? <Text className="text-gray-500 py-6">Loading budgets…</Text> : null}
      {[...(data?.snapshots ?? [])].map((snapshot) => <View key={snapshot.currency} className="mb-4 rounded-2xl bg-primary/10 p-4">
        <Text className="font-bold text-primary">{snapshot.currency} spending · {monthLabel}</Text>
        <Text className="mt-1 text-gray-800 dark:text-white">Spent {formatMinorUnits(snapshot.spentMinor, snapshot.currency)} · Budgeted {formatMinorUnits(snapshot.allocatedMinor, snapshot.currency)}</Text>
        <Text className="mt-1 text-sm text-gray-600 dark:text-neutral-300">Remaining {formatMinorUnits(snapshot.remainingMinor, snapshot.currency)} (negative means over budget)</Text>
      </View>)}
      {data?.excludedCurrencies.length ? <Text className="mb-4 text-sm text-amber-700">Not included in PKR totals: {[...new Set(data.excludedCurrencies)].join(', ')}. Each currency is shown separately.</Text> : null}
      <Text className="text-gray-500 dark:text-neutral-400 mb-4">Set a monthly limit by category. Spending uses the complete transaction history for this month; transfers and opening balances are excluded.</Text>
      <Text className="mb-2 text-sm font-semibold text-gray-700 dark:text-neutral-300">Budget currency</Text>
      <View className="mb-4 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} onPress={() => setCurrency(code)} className={`mr-2 mb-2 rounded-full px-3 py-2 ${currency === code ? 'bg-primary' : 'bg-white dark:bg-neutral-900'}`}><Text className={currency === code ? 'text-white text-xs font-bold' : 'text-gray-700 dark:text-neutral-200 text-xs'}>{code}</Text></Pressable>)}</View>
      {EXPENSE_CLASSIFICATION_IDS.map((categoryId) => {
        const item = existing.get(categoryId);
        const spent = snapshotByCurrency.get(currency)?.categories.find((category) => category.category === categoryId)?.spentMinor ?? 0;
        const remove = () => Alert.alert('Delete unused budget?', 'Budgets with financial activity or revision history must be archived.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => item && writes.deleteBudget.mutate(item.id, { onError: (e) => Alert.alert('Could not delete', e.message) }) },
        ]);
        return <View key={categoryId} className="mb-3 rounded-2xl bg-white dark:bg-neutral-900 p-4">
          <View className="flex-row items-center justify-between">
            <Text className="flex-1 font-semibold text-gray-900 dark:text-white">{CLASSIFICATIONS[categoryId].label}</Text>
            {item ? <View className="flex-row"><Pressable onPress={remove} className="mr-3"><Text className="text-gray-500 font-semibold">Delete</Text></Pressable><Pressable onPress={() => archive(item.id)}><Text className="text-red-500 font-semibold">Archive</Text></Pressable></View> : null}
          </View>
          <Text className="mt-2 text-sm text-gray-500 dark:text-neutral-400">Spent {formatMinorUnits(spent, item?.currency ?? 'PKR')}{item ? ` of ${formatMinorUnits(item.amountMinor, item.currency)}` : ' · No limit set'}</Text>
          {item ? <View className="mt-3"><BudgetProgressBar categoryName={CLASSIFICATIONS[categoryId].label} icon={Wallet} spent={Math.max(0, spent) / 100} limit={item.amountMinor / 100} currency={currency} /></View> : null}
          <View className="flex-row items-center mt-3">
            <TextInput value={limits[categoryId] ?? ''} onChangeText={(value) => setLimits((previous) => ({ ...previous, [categoryId]: value }))}
              placeholder={item ? `${(item.amountMinor / 100).toFixed(2)} (${item.currency})` : `Monthly limit in ${currency}`} keyboardType="decimal-pad"
              className="flex-1 rounded-xl bg-gray-100 dark:bg-neutral-800 px-3 py-3 text-gray-900 dark:text-white" />
            <Pressable onPress={() => void save(categoryId)} disabled={writes.saveBudget.isPending} className="ml-2 rounded-xl bg-primary px-4 py-3"><Text className="font-bold text-white">{item ? 'Update' : 'Set limit'}</Text></Pressable>
          </View>
        </View>;
      })}
      <Button title="Carry unused limits to next month" onPress={() => void rollover()} />
      <Pressable onPress={() => router.push('/savings')} className="mt-4 rounded-2xl bg-white dark:bg-neutral-900 p-4"><Text className="font-bold text-primary">Savings goals & emergency fund →</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}
