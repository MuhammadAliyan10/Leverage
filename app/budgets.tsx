import { PRIMARY_COLOR } from '../src/constants/themeColors';
import React, { useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { BottomSheetTextInput as TextInput } from '@gorhom/bottom-sheet';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Button } from '../components/ui/Button';
import { ActionSheet } from '../components/ui/ActionSheet';
import { BudgetProgressBar } from '../components/ui/BudgetProgressBar';
import { DoneHeader } from '../components/ui/DoneHeader';
import { SectionHeading } from '../components/ui/SectionHeading';
import { BADGE_NEUTRAL, BADGE_NEUTRAL_TEXT, BADGE_PRIMARY, BADGE_PRIMARY_TEXT } from '../components/ui/badgeStyles';
import { useAppConfirm } from '../components/ui/useAppConfirm';
import { useAuth } from '../src/context/AuthContext';
import { CLASSIFICATIONS, CURRENCIES, EXPENSE_CLASSIFICATION_IDS, type CurrencyCode } from '../src/finance/domain';
import { sanitizeGroupedAmountInput, formatMinorUnits, formatMinorUnitsForInput, parseMinorUnits } from '../src/finance/ledger';
import { useBudgeting, useBudgetingWrites } from '../hooks/queries/useBudgeting';

// A budget period is a calendar date, not an instant. Formatting local parts avoids
// shifting the first of the month to the previous UTC date (e.g. Asia/Karachi).
const asMonthStart = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
const requestId = () => Crypto.randomUUID();

export default function BudgetsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { confirm, dialog } = useAppConfirm();
  const [month, setMonth] = useState(() => new Date());
  const [currency, setCurrency] = useState<CurrencyCode>('PKR');
  const [notice, setNotice] = useState('');
  const periodStart = asMonthStart(month);
  const { data, isLoading, error, refetch } = useBudgeting(periodStart);
  const writes = useBudgetingWrites();
  const isSaving = writes.saveBudget.isPending;
  const isChangingBudget = writes.archiveBudget.isPending || writes.deleteBudget.isPending;
  const isBusy = isSaving || isChangingBudget || writes.rollover.isPending;
  const existing = useMemo(() => new Map((data?.budgets ?? []).filter((item) => item.currency === currency).map((item) => [item.categoryId as (typeof EXPENSE_CLASSIFICATION_IDS)[number], item] as const)), [data?.budgets, currency]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<(typeof EXPENSE_CLASSIFICATION_IDS)[number] | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<(typeof EXPENSE_CLASSIFICATION_IDS)[number] | null>(null);
  const [budgetAmount, setBudgetAmount] = useState('');
  const [budgetError, setBudgetError] = useState('');
  const [budgetDrawerOpen, setBudgetDrawerOpen] = useState(false);
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const openBudgetEditor = (categoryId?: (typeof EXPENSE_CLASSIFICATION_IDS)[number]) => {
    setNotice('');
    setBudgetError('');
    setEditingCategoryId(categoryId ?? null);
    setSelectedCategoryId(categoryId ?? EXPENSE_CLASSIFICATION_IDS.find((id) => !existing.has(id)) ?? EXPENSE_CLASSIFICATION_IDS[0]);
    setBudgetAmount(categoryId ? formatMinorUnitsForInput(existing.get(categoryId)?.amountMinor ?? 0) : '');
    setBudgetDrawerOpen(true);
  };

  const save = async () => {
    if (!user) return;
    if (!selectedCategoryId) { setBudgetError('Choose a category for this budget.'); return; }
    setBudgetError('');
    setNotice('');
    try {
      const amountMinor = parseMinorUnits(budgetAmount);
      const current = existing.get(selectedCategoryId);
      await writes.saveBudget.mutateAsync({
        id: requestId(), ownerId: user.id, categoryId: selectedCategoryId, amountMinor, currency,
        periodStart, periodEnd: new Date(Date.UTC(month.getFullYear(), month.getMonth() + 1, 1)).toISOString().slice(0, 10),
        rolloverPolicy: current?.rolloverPolicy ?? 'reset', replacesBudgetId: current?.id,
      });
      setBudgetAmount('');
      setBudgetDrawerOpen(false);
      setEditingCategoryId(null);
      setNotice(`${CLASSIFICATIONS[selectedCategoryId].label} budget saved for ${monthLabel}.`);
    } catch (e) { setBudgetError(e instanceof Error ? e.message : 'Could not save this budget. Try again.'); }
  };
  const archive = async (id: string) => {
    if (isBusy) return;
    if (!await confirm({ title: 'Archive this budget?', message: 'Its history will remain available.', confirmLabel: 'Archive', destructive: true })) return;
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
  const availableCategories = EXPENSE_CLASSIFICATION_IDS.filter((categoryId) => !existing.has(categoryId));
  const budgetDrawerTitle = editingCategoryId
    ? `Edit ${CLASSIFICATIONS[editingCategoryId].label} budget`
    : `Add ${selectedCategoryId ? CLASSIFICATIONS[selectedCategoryId].label : 'category'} budget`;

  return <SafeAreaView edges={['left', 'right', 'bottom']} className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Monthly Budgets" onDone={() => router.canGoBack() ? router.back() : router.replace('/(tabs)')} />
    <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 28 }}>
      <View className="mb-4 flex-row items-center justify-between rounded-md border border-gray-100 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900">
        <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => {setBudgetDrawerOpen(false);setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));}} className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-gray-50 dark:bg-neutral-800"><ChevronLeft color={PRIMARY_COLOR} /></Pressable>
        <View className="items-center"><Text className="font-body text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-neutral-400">Budget period</Text><Text className="font-heading mt-0.5 font-bold text-gray-900 dark:text-white">{monthLabel}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => {setBudgetDrawerOpen(false);setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));}} className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-gray-50 dark:bg-neutral-800"><ChevronRight color={PRIMARY_COLOR} /></Pressable>
      </View>
      {!!error && <View className="mb-4 rounded-xl bg-red-50 dark:bg-red-950 p-3">
        <Text className="font-body text-sm text-red-700 dark:text-red-200">Budgets could not be loaded: {error.message}</Text>
        <Pressable accessibilityRole="button" onPress={() => void refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable>
      </View>}
      {!!notice && <Text accessibilityRole="text" accessibilityLiveRegion="polite" className="font-body mb-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm text-primary dark:bg-primary/10">{notice}</Text>}
      {isLoading ? <Text className="font-body py-6 text-gray-500 dark:text-neutral-400">Loading budgets…</Text> : null}
      {[...(data?.snapshots ?? [])].map((snapshot) => <View key={snapshot.currency} className="mb-3 rounded-md border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <View className="mb-3 flex-row items-center justify-between"><SectionHeading title={`${snapshot.currency} overview`} size="compact" className="flex-1"/><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{monthLabel}</Text></View>
        <View className="flex-row">
          <View className="mr-2 flex-1 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Spent</Text><Text className="font-body mt-1 text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(snapshot.spentMinor, snapshot.currency)}</Text></View>
          <View className="ml-2 flex-1 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Budgeted</Text><Text className="font-body mt-1 text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(snapshot.allocatedMinor, snapshot.currency)}</Text></View>
        </View>
        <View className="mt-3 flex-row items-center justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{snapshot.remainingMinor < 0 ? 'Over budget' : 'Remaining'}</Text><Text className={`font-body text-sm font-bold ${snapshot.remainingMinor < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{formatMinorUnits(Math.abs(snapshot.remainingMinor), snapshot.currency)}</Text></View>
      </View>)}
      {data?.excludedCurrencies.length ? <Text className="font-body mb-4 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-950 dark:text-amber-200">Amounts in different currencies aren’t combined. Activity in { [...new Set(data.excludedCurrencies)].join(', ') } appears in its own currency summary.</Text> : null}
      <Text className="font-body mb-2 text-sm font-semibold text-gray-700 dark:text-neutral-300">Budget currency</Text>
      <View className="mb-4 flex-row flex-wrap">{(Object.keys(CURRENCIES) as CurrencyCode[]).map((code) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: currency === code }} accessibilityLabel={`${CURRENCIES[code].label}, ${code}`} onPress={() => {setBudgetDrawerOpen(false);setCurrency(code);}} className={`mr-2 mb-2 rounded-full px-3 py-2 ${currency === code ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs ${currency === code ? `font-bold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{code}</Text></Pressable>)}</View>
      <View className="mb-3 flex-row items-center justify-between gap-3"><View className="flex-1"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">{currency} budget limits</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Spending and refunds are tracked for {monthLabel}.</Text></View><Pressable accessibilityRole="button" accessibilityLabel={`Add a ${currency} monthly budget`} disabled={isLoading||isBusy || availableCategories.length===0} onPress={()=>openBudgetEditor()} className={`houselog-button min-h-11 justify-center px-3 ${isLoading||isBusy || availableCategories.length===0?'opacity-60':''}`}><Text className="font-body text-sm font-semibold text-white">＋ Add budget</Text></Pressable></View>
      {availableCategories.length===0&&existing.size>0?<Text className="font-body mb-3 rounded-md bg-primary/5 p-3 text-sm text-gray-700 dark:bg-primary/10 dark:text-neutral-200">Every expense category already has a {currency} budget.</Text>:null}
      {existing.size===0&&!isLoading?<View className="mb-3 rounded-md border border-dashed border-gray-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900"><Text className="font-body font-semibold text-gray-900 dark:text-white">No {currency} budgets for {monthLabel}</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Choose a category and set a limit to start tracking monthly spending.</Text><Pressable accessibilityRole="button" disabled={isBusy} onPress={()=>openBudgetEditor()} className="mt-3 self-start"><Text className="font-body font-semibold text-primary">Set your first budget →</Text></Pressable></View>:null}
      {[...existing.entries()].map(([categoryId, item]) => {
        const spent = snapshotByCurrency.get(currency)?.categories.find((category) => category.category === categoryId)?.spentMinor ?? 0;
        const remaining = item.amountMinor-spent;
        const remove = async () => {
          if (!item || isChangingBudget || !await confirm({ title: 'Delete unused budget?', message: 'Budgets with financial activity or revision history must be archived.', confirmLabel: 'Delete', destructive: true })) return;
          setNotice('');
          writes.deleteBudget.mutate(item.id, {
            onSuccess: () => setNotice('Unused budget removed.'),
            onError: (e) => setNotice(`Could not delete this budget: ${e.message}`),
          });
        };
        return <View key={categoryId} className="mb-3 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <View className="flex-row items-start justify-between gap-3"><View className="flex-1"><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{CLASSIFICATIONS[categoryId].label}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{formatMinorUnits(spent,currency)} spent · {remaining<0?`${formatMinorUnits(Math.abs(remaining),currency)} over limit`:`${formatMinorUnits(remaining,currency)} remaining`}</Text></View><Text className={`font-body rounded-full px-2 py-1 text-xs font-semibold ${remaining<0?'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300':'bg-primary/10 text-primary'}`}>{formatMinorUnits(item.amountMinor,currency)}</Text></View>
          <View className="mt-3"><BudgetProgressBar spent={Math.max(0,spent)/100} limit={item.amountMinor/100}/></View>
          <View className="mt-3 flex-row flex-wrap items-center"><Pressable accessibilityRole="button" accessibilityLabel={`Edit ${CLASSIFICATIONS[categoryId].label} budget`} disabled={isBusy} onPress={()=>openBudgetEditor(categoryId)} className="houselog-button mr-2 min-h-10 justify-center px-3"><Text className="font-body text-xs font-semibold text-white">Edit limit</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Delete unused ${CLASSIFICATIONS[categoryId].label} budget`} disabled={isChangingBudget || isSaving} onPress={remove} className="mr-2 min-h-10 justify-center rounded-lg px-2"><Text className="font-body text-xs font-semibold text-gray-500 dark:text-neutral-400">Delete</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Archive ${CLASSIFICATIONS[categoryId].label} budget`} disabled={isChangingBudget || isSaving} onPress={() => archive(item.id)} className="min-h-10 justify-center rounded-lg px-2"><Text className="font-body text-xs font-semibold text-red-600 dark:text-red-400">Archive</Text></Pressable></View>
        </View>;
      })}
      <Button title="Carry unused limits to next month" disabled={isChangingBudget || isSaving} isLoading={writes.rollover.isPending} onPress={() => void rollover()} />
      <Pressable accessibilityRole="button" onPress={() => router.push('/savings')} className="mt-4 rounded-md border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-body font-bold text-primary">Savings goals & emergency fund →</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">View goals and emergency-fund progress</Text></Pressable>
    </ScrollView>
    <ActionSheet visible={budgetDrawerOpen} title={budgetDrawerTitle} onClose={() => setBudgetDrawerOpen(false)}>
      <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Set the maximum planned spending for this category in {monthLabel}. Refunds reduce the spending total; transfers and starting balances are excluded.</Text>
      {editingCategoryId?<View className="mt-4 rounded-md bg-gray-100 p-3 dark:bg-neutral-800"><Text className="font-body text-xs font-semibold text-gray-500 dark:text-neutral-400">CATEGORY</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{CLASSIFICATIONS[editingCategoryId].label}</Text></View>:<>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Choose a category</Text>
        <View className="mt-1 flex-row flex-wrap">{availableCategories.map((categoryId)=><Pressable key={categoryId} accessibilityRole="radio" accessibilityState={{checked:selectedCategoryId===categoryId}} onPress={()=>{setSelectedCategoryId(categoryId);setBudgetError('');}} className={`mr-2 mt-2 rounded-full px-3 py-2 ${selectedCategoryId===categoryId?BADGE_PRIMARY:BADGE_NEUTRAL}`}><Text className={`font-body text-xs ${selectedCategoryId===categoryId?`font-semibold ${BADGE_PRIMARY_TEXT}`:BADGE_NEUTRAL_TEXT}`}>{CLASSIFICATIONS[categoryId].label}</Text></Pressable>)}</View>
      </>}
      <Text className="font-body mt-5 text-xs font-semibold text-gray-600 dark:text-neutral-300">Monthly limit · {currency}</Text>
      <View className="mt-1 flex-row items-stretch">
        <TextInput accessibilityLabel={`${selectedCategoryId?CLASSIFICATIONS[selectedCategoryId].label:'Category'} monthly budget amount in ${currency}`} editable={!isSaving} value={budgetAmount} onChangeText={(value)=>{setBudgetAmount(sanitizeGroupedAmountInput(value));setBudgetError('');}} placeholder={`Limit in ${currency}`} placeholderTextColor="#9ca3af" keyboardType="decimal-pad" inputMode="decimal" className="font-body min-h-12 flex-1 rounded-md border border-gray-200 bg-white px-3 py-3 text-base text-gray-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"/>
        <Pressable accessibilityRole="button" accessibilityLabel={editingCategoryId?'Save budget limit':'Set monthly budget'} accessibilityState={{disabled:isBusy||!selectedCategoryId,busy:isSaving}} disabled={isBusy||!selectedCategoryId} onPress={()=>void save()} className={`houselog-button ml-2 min-h-12 min-w-[132px] flex-row items-center justify-center px-3 ${isBusy||!selectedCategoryId?'opacity-60':''}`}>
          {isSaving?<ActivityIndicator color="#fff" className="mr-2"/>:null}
          <Text className="font-body text-center text-sm font-semibold text-white">{isSaving?'Saving…':editingCategoryId?'Save limit':'Set budget'}</Text>
        </Pressable>
      </View>
      {budgetError?<Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="font-body mt-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{budgetError}</Text>:null}
    </ActionSheet>
    {dialog}
  </SafeAreaView>;
}
