import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell, BriefcaseBusiness, FolderKanban, Landmark, Plus, RefreshCw, Wallet } from 'lucide-react-native';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { SectionHeading } from '../../components/ui/SectionHeading';
import { useDashboardMetrics, type DashboardChartPoint, type DashboardFilter } from '../../hooks/queries/useDashboardMetrics';
import { formatMinorUnits } from '../../src/finance/ledger';
import type { CurrencyCode } from '../../src/finance/domain';
import type { TransactionActivity } from '../../src/finance/transactionDisplay';
import { authTraceEvent, finishAuthTrace, getActiveAuthTraceId } from '../../src/security/authDiagnostics';

const FILTERS: readonly DashboardFilter[] = ['Daily', 'Weekly', 'Monthly', 'Yearly'];
const money = (minor: number, currency: CurrencyCode | string) => formatMinorUnits(minor, currency);

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const strongNumber = { fontFamily: 'InterBlack' } as const;

function SectionTitle({ title, action, onPress }: { title: string; action?: string; onPress?: () => void }) {
  return <SectionHeading title={title} action={action} onAction={onPress} className="mb-3 mt-7" />;
}

function Surface({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <View className={`rounded-md border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>{children}</View>;
}

function Skeleton({ height = 18, width = '100%' }: { height?: number; width?: `${number}%` | number }) {
  return <View style={{ height, width }} className="rounded-lg bg-gray-200 dark:bg-neutral-800" />;
}

function DashboardSkeleton() {
  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['left', 'right', 'bottom']}>
    <GlobalHeader title="Home" description="Your finances at a glance" />
    <ScrollView className="px-5" contentContainerStyle={{ paddingBottom: 32 }}>
      <Surface className="mt-5"><Skeleton width="45%" /><View className="mt-4"><Skeleton height={32} width="65%" /></View><View className="mt-3"><Skeleton width="80%" /></View></Surface>
      <Surface className="mt-4"><Skeleton width="55%" /><View className="mt-4"><Skeleton height={100} /></View></Surface>
      <Surface className="mt-4"><Skeleton width="40%" /><View className="mt-4"><Skeleton height={66} /></View></Surface>
      <Surface className="mt-4"><Skeleton width="50%" /><View className="mt-4"><Skeleton height={66} /></View></Surface>
    </ScrollView>
  </SafeAreaView>;
}

function Chart({ points, width }: { points: readonly DashboardChartPoint[]; width: number }) {
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const max = points.reduce((highest, point) => Math.max(highest, Math.abs(point.amountMinor)), 0);
  if (points.length === 0 || max === 0) return <View className="h-36 items-center justify-center"><Text className="font-body text-sm text-gray-500 dark:text-neutral-400">No net spending in this period.</Text></View>;
  const hasRefundPeriods = points.some((point) => point.amountMinor < 0);
  const plotHeight = hasRefundPeriods ? 90 : 74;
  const baseline = hasRefundPeriods ? 45 : 66;
  const maxBarHeight = hasRefundPeriods ? 40 : 58;
  const selectedPoint = points.find((point) => point.label === selectedLabel) ?? points.at(-1)!;
  const usableWidth = Math.max(100, width - 52);
  const gap = points.length > 1 ? 10 : 0;
  const barWidth = Math.max(10, Math.min(34, (usableWidth - gap * (points.length - 1)) / points.length));
  return <View accessibilityLabel="Net spending over time, in PKR. Select a bar to read its amount." className="pt-2">
    <View className="mb-1 flex-row items-center justify-between">
      <Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">{selectedPoint.label} · {selectedPoint.amountMinor < 0 ? 'Refunds or corrections exceeded spending' : 'Net spending'}</Text>
      <Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{money(Math.abs(selectedPoint.amountMinor), 'PKR')}</Text>
    </View>
    <View className="flex-row items-center justify-center" style={{ height: plotHeight, gap }}>
      <View pointerEvents="none" className="absolute left-0 right-0 h-px bg-gray-300 dark:bg-neutral-700" style={{ top: baseline }} />
      {points.map((point, index) => {
        const barHeight = Math.max(3, Math.round((Math.abs(point.amountMinor) / max) * maxBarHeight));
        const negative = point.amountMinor < 0;
        return <Pressable key={`${point.label}-${index}`} accessibilityRole="button" accessibilityLabel={`${point.label}: ${point.amountMinor < 0 ? 'refunds or corrections exceeded spending by' : 'net spending'} ${money(Math.abs(point.amountMinor), 'PKR')}`} accessibilityState={{ selected: selectedPoint.label === point.label }} onPress={() => setSelectedLabel(point.label)} className="h-full" style={{ width: barWidth }}>
          <View
            className={`absolute left-0 rounded-md ${negative ? 'bg-amber-500' : 'bg-primary'}`}
            style={{ top: negative ? baseline : baseline - barHeight, width: barWidth, height: barHeight }} />
        </Pressable>;
      })}
    </View>
    <View className="mt-1 flex-row justify-center" style={{ gap }}>
      {points.map((point, index) => <Text key={`${point.label}-${index}`} numberOfLines={1} className={`font-body text-center text-[10px] ${selectedPoint.label === point.label ? 'font-semibold text-primary' : 'text-gray-500 dark:text-neutral-400'}`} style={{ width: barWidth }}>{point.label}</Text>)}
    </View>
    {hasRefundPeriods ? <View className="mt-2 flex-row items-center"><View className="mr-1.5 h-2.5 w-2.5 rounded-sm bg-amber-500"/><Text className="font-body text-[10px] text-gray-500 dark:text-neutral-400">Refunds or corrections exceeded spending</Text></View> : null}
  </View>;
}

function ActivityRow({ activity, onPress }: { activity: TransactionActivity; onPress: () => void }) {
  const incoming = activity.direction === 'in';
  const transfer = activity.direction === 'transfer';
  const Icon = incoming ? ArrowDownLeft : transfer ? ArrowLeftRight : ArrowUpRight;
  const amountColor = incoming ? 'text-emerald-700 dark:text-emerald-300' : transfer ? 'text-blue-700 dark:text-blue-300' : 'text-gray-900 dark:text-white';
  const sign = incoming ? '+' : transfer ? '' : '−';
  return <Pressable accessibilityRole="button" accessibilityLabel={`${activity.title}, ${activity.categoryLabel}, open transactions`} onPress={onPress} className="min-h-[68px] flex-row items-center border-b border-gray-100 py-3 last:border-b-0 dark:border-neutral-800">
    <View className={`mr-3 h-10 w-10 items-center justify-center rounded-full ${incoming ? 'bg-emerald-50 dark:bg-emerald-950' : transfer ? 'bg-blue-50 dark:bg-blue-950' : 'bg-gray-100 dark:bg-neutral-800'}`}><Icon size={19} color={incoming ? '#047857' : transfer ? '#1d4ed8' : '#6b7280'} /></View>
    <View className="mr-2 flex-1">
      <Text numberOfLines={1} className="font-body font-semibold text-gray-900 dark:text-white">{activity.title}</Text>
      <Text numberOfLines={1} className="font-body mt-0.5 text-xs text-gray-500 dark:text-neutral-400">{activity.categoryLabel} · {new Date(activity.date).toLocaleDateString()}</Text>
    </View>
    <Text numberOfLines={1} className={["font-body", (`max-w-[43%] text-right text-sm font-bold ${amountColor}`)].filter(Boolean).join(' ')}>{activity.currency ? `${sign}${money(activity.amountMinor, activity.currency)}` : 'Currency unavailable'}</Text>
  </Pressable>;
}

export default function DashboardScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [filter, setFilter] = useState<DashboardFilter>('Weekly');
  const [reportDate, setReportDate] = useState(() => new Date());
  const reportDateRef = useRef(reportDate);
  const { data: metrics, isLoading, isError, isFetching, refetch } = useDashboardMetrics(reportDate);

  useEffect(() => {
    const traceId = getActiveAuthTraceId();
    if (!traceId) return;
    authTraceEvent('NAVIGATION_COMPLETE', { route: 'tabs' }, traceId);
    authTraceEvent('DASHBOARD_VISIBLE', {}, traceId);
    finishAuthTrace(true, 'dashboard_visible', traceId);
  }, []);

  useFocusEffect(useCallback(() => {
    // Keep this callback independent from query data. Depending on `metrics`
    // makes each successful refetch recreate the focus effect and refetch again.
    const focusedAt = new Date();
    if (focusedAt.toDateString() !== reportDateRef.current.toDateString()) {
      reportDateRef.current = focusedAt;
      setReportDate(focusedAt);
      return;
    }
    void refetch();
  }, [refetch]));

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && previous !== 'active') {
        const resumedAt = new Date();
        if (resumedAt.toDateString() !== reportDateRef.current.toDateString()) {
          reportDateRef.current = resumedAt;
          setReportDate(resumedAt);
        } else {
          void refetch();
        }
      }
      previous = state;
    });
    return () => subscription.remove();
  }, [refetch]);

  if (isLoading && !metrics) return <DashboardSkeleton />;
  if (isError && !metrics) return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['left', 'right', 'bottom']}>
    <GlobalHeader title="Home" description="Your finances at a glance" />
    <View className="flex-1 items-center justify-center px-8">
      <RefreshCw size={30} color={PRIMARY_COLOR} />
      <Text className="font-heading mt-4 text-center text-lg font-bold text-gray-900 dark:text-white">We couldn’t load your dashboard</Text>
      <Text className="font-body mt-2 text-center text-sm text-gray-600 dark:text-neutral-300">Your saved records are unchanged. Check your storage and try again.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry loading dashboard" onPress={() => void refetch()} className="houselog-button mt-5 min-h-12 min-w-32 items-center justify-center px-5"><Text className="font-body font-bold text-white">Try again</Text></Pressable>
    </View>
  </SafeAreaView>;
  if (!metrics) return null;

  const chartPoints = metrics.chartData[filter];
  const hasActivity = metrics.activities.length > 0;
  const hasAccounts = metrics.liquidity.length > 0;
  const visibleNetWorth = metrics.netWorth;
  const emergency = metrics.emergencyFund;
  const monthEnd = new Date(reportDate.getFullYear(), reportDate.getMonth() + 1, 0);
  const periodEndLabel = monthEnd.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const nextWeekKey = localDateKey(new Date(reportDate.getFullYear(), reportDate.getMonth(), reportDate.getDate() + 7));
  const overBudget = metrics.budgets.flatMap((budget) => budget.categories
    .filter((category) => category.amountMinor > 0 && category.remainingMinor < 0)
    .map((category) => ({ budget, category, over: -category.remainingMinor })))
    .sort((a, b) => b.over - a.over)[0];
  const approachingBudget = overBudget ? undefined : metrics.budgets.flatMap((budget) => budget.categories
    .filter((category) => category.amountMinor > 0 && category.percentUsed >= 80)
    .map((category) => ({ budget, category })))
    .sort((a, b) => b.category.percentUsed - a.category.percentUsed)[0];
  const billNeedingAttention = metrics.upcomingBills.find((bill) => bill.status === 'overdue' || bill.dueDate <= nextWeekKey);
  const monthlyActivityScale = Math.max(Math.abs(metrics.incomeMinor), Math.abs(metrics.expenseMinor));
  const monthlyBarWidth = (amountMinor: number): `${number}%` => monthlyActivityScale === 0
    ? '0%'
    : `${(Math.abs(amountMinor) / monthlyActivityScale) * 100}%`;

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['left', 'right', 'bottom']}>
    <GlobalHeader title="Home" description="Your finances at a glance" RightIcon={<Bell size={21} color={PRIMARY_COLOR} />} onRightPress={() => router.push('/obligations')} rightActionLabel="Open upcoming obligations" />
    <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open projects workspace" onPress={() => router.push('/projects' as Href)} className="mt-5 flex-row items-center rounded-md border border-violet-100 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/40">
          <View className="mr-3 h-10 w-10 items-center justify-center rounded-md bg-white dark:bg-neutral-900"><FolderKanban size={20} color={PRIMARY_COLOR} /></View>
          <View className="flex-1"><Text className="font-body text-sm font-bold text-gray-900 dark:text-white">Projects</Text><Text className="font-body mt-0.5 text-xs text-gray-600 dark:text-neutral-300">Track shared and personal activity spending</Text></View>
          <Plus size={19} color={PRIMARY_COLOR} />
        </Pressable>
      {isFetching ? <Text accessibilityLiveRegion="polite" className="font-body mt-2 text-right text-xs text-gray-500 dark:text-neutral-400">Updating…</Text> : null}
      {isError ? <View accessibilityLiveRegion="assertive" className="mt-3 flex-row items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950">
        <Text className="font-body mr-3 flex-1 text-xs leading-4 text-amber-900 dark:text-amber-100">Could not refresh. Showing the last successful summary.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry dashboard refresh" onPress={() => void refetch()} className="min-h-10 justify-center px-2"><Text className="font-body font-bold text-primary">Retry</Text></Pressable>
      </View> : null}
      {!metrics.hasAnyFinancialRecords ? <Surface className="mt-5 items-start">
        <View className="h-12 w-12 items-center justify-center rounded-2xl bg-primary/10"><Wallet size={23} color={PRIMARY_COLOR} /></View>
        <Text className="font-heading mt-4 text-xl font-bold text-gray-900 dark:text-white">Start with your first account</Text>
        <Text className="font-body mt-2 text-sm leading-5 text-gray-600 dark:text-neutral-300">Add the accounts where you keep money. Then record income, expenses, transfers, savings and debts as they happen.</Text>
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/onboarding', params: { manual: '1' } })} className="houselog-button mt-4 min-h-12 flex-row items-center justify-center px-4"><Plus size={18} color="white" /><Text className="font-body ml-2 font-bold text-white">Create an account</Text></Pressable>
      </Surface> : null}

      <SectionTitle title="Liquid funds" action="Accounts" onPress={() => router.push('/accounts')} />
      {hasAccounts ? metrics.liquidity.map((position) => <Surface key={position.currency} className="mb-3">
        <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Total liquid funds · {position.currency}</Text>
        <Text style={strongNumber} className="mt-1 text-2xl text-gray-900 dark:text-white">{money(position.currentBalanceMinor, position.currency)}</Text>
        <View className="mt-3 border-t border-gray-100 pt-2 dark:border-neutral-800">
          <View className="flex-row items-center justify-between py-1.5"><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Physical cash available</Text><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{money(position.physicalCashAvailableMinor, position.currency)}</Text></View>
          <View className="flex-row items-center justify-between py-1.5"><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Bank & mobile available</Text><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{money(position.bankAndMobileAvailableMinor, position.currency)}</Text></View>
          <View className="flex-row items-center justify-between py-1.5"><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Savings & set aside</Text><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{money(position.savingsAndSetAsideMinor, position.currency)}</Text></View>
        </View>
      </Surface>) : <Surface><Text className="font-body font-semibold text-gray-900 dark:text-white">No active liquid accounts</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Archived accounts remain in your financial history and net worth.</Text></Surface>}
      <Text className="font-body mt-1 text-xs leading-4 text-gray-500 dark:text-neutral-400">Account balances are split between available funds and amounts allocated to savings. Available to spend also subtracts upcoming bills.</Text>

      <SectionTitle title="Available to spend" />
      {metrics.availableToSpend.length ? metrics.availableToSpend.map((position) => <Surface key={position.currency} className="mb-3">
        <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">Estimated after bills · {position.currency}</Text>
        <Text style={strongNumber} className={`mt-1 text-2xl ${position.availableToSpendMinor < 0 ? 'text-rose-700 dark:text-rose-300' : 'text-gray-900 dark:text-white'}`}>{money(position.availableToSpendMinor, position.currency)}</Text>
        <View className="mt-3 border-t border-gray-100 pt-3 dark:border-neutral-800">
          <View className="mb-2 flex-row items-center justify-between gap-3"><Text className="flex-1 font-body text-sm text-gray-600 dark:text-neutral-300">Daily-use balance</Text><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{money(position.unreservedMinor, position.currency)}</Text></View>
          <View className="flex-row items-center justify-between gap-3"><Text className="flex-1 font-body text-sm text-gray-600 dark:text-neutral-300">Bills due by {periodEndLabel}</Text><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{position.unpaidBillsDueMinor > 0 ? '−' : ''}{money(position.unpaidBillsDueMinor, position.currency)}</Text></View>
        </View>
        <Text className="font-body mt-3 text-xs leading-4 text-gray-500 dark:text-neutral-400">Uses cash, bank and mobile wallets after account earmarks; savings are excluded. Period ends {periodEndLabel}.</Text>
        {position.availableToSpendMinor < 0 ? <Text className="font-body mt-2 text-xs font-semibold text-rose-700 dark:text-rose-300">Recorded bills are higher than the unreserved balance by {money(-position.availableToSpendMinor, position.currency)}.</Text> : null}
      </Surface>) : <Surface><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Add an active liquid account to estimate available spending money.</Text></Surface>}

      <SectionTitle title="Net worth" action="Assets & debts" onPress={() => router.push('/assets')} />
      {visibleNetWorth.length ? visibleNetWorth.map((position) => <Pressable key={position.currency} accessibilityRole="button" accessibilityLabel={`Open assets and investments for ${position.currency}`} onPress={() => router.push('/assets')}><Surface className="mb-3">
        <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{position.currency} · known net worth</Text>
        <Text style={strongNumber} className="mt-1 text-2xl text-gray-900 dark:text-white">{money(position.netWorthMinor, position.currency)}</Text>
        <Text className="font-body mt-2 text-xs text-gray-600 dark:text-neutral-300">Assets {money(position.totalAssetsMinor, position.currency)} · Debts {money(position.liabilitiesMinor, position.currency)}</Text>
      </Surface></Pressable>) : <Surface><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Add accounts, assets or debts to see a net-worth position.</Text></Surface>}
      <Text className="font-body -mt-1 text-xs text-gray-500 dark:text-neutral-400">Different currencies are shown separately. Money set aside for goals and emergencies is already part of the account balance.</Text>
      {metrics.unpricedHoldingCurrencies.length ? <Text className="font-body mt-2 text-xs leading-4 text-amber-700 dark:text-amber-300">Known net worth excludes holdings without a saved price in {metrics.unpricedHoldingCurrencies.join(', ')}. Asset and investment values use the latest prices you saved; check the date because they may be out of date.</Text> : <Text className="font-body mt-2 text-xs leading-4 text-gray-500 dark:text-neutral-400">Asset and investment values use the latest prices you saved; check the date because they may be out of date.</Text>}

      <SectionTitle title="This month · income & spending" />
      <Surface>
        <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{metrics.monthLabel} · PKR only</Text>
        <View className="mt-4">
          <View className="mb-3">
            <View className="mb-1 flex-row items-center justify-between"><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Income & other receipts</Text><Text style={strongNumber} className={`text-base ${metrics.incomeMinor < 0 ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{money(metrics.incomeMinor, 'PKR')}</Text></View>
            <View accessibilityRole="progressbar" accessibilityLabel={`Income and other receipts ${money(metrics.incomeMinor, 'PKR')}; bars share a scale with expenses`} accessibilityValue={{ min: 0, max: 100, now: monthlyActivityScale === 0 ? 0 : Math.abs(metrics.incomeMinor) / monthlyActivityScale * 100 }} className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className={`h-full rounded-full ${metrics.incomeMinor < 0 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: monthlyBarWidth(metrics.incomeMinor) }} /></View>
          </View>
          <View className="mb-3">
            <View className="mb-1 flex-row items-center justify-between"><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Expenses</Text><Text style={strongNumber} className={`text-base ${metrics.expenseMinor < 0 ? 'text-amber-600 dark:text-amber-300' : 'text-rose-700 dark:text-rose-300'}`}>{money(metrics.expenseMinor, 'PKR')}</Text></View>
            <View accessibilityRole="progressbar" accessibilityLabel={`Expenses ${money(metrics.expenseMinor, 'PKR')}; bars share a scale with income and other receipts`} accessibilityValue={{ min: 0, max: 100, now: monthlyActivityScale === 0 ? 0 : Math.abs(metrics.expenseMinor) / monthlyActivityScale * 100 }} className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className={`h-full rounded-full ${metrics.expenseMinor < 0 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: monthlyBarWidth(metrics.expenseMinor) }} /></View>
          </View>
        </View>
        <View className="border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Receipts minus expenses</Text><Text style={strongNumber} className={`mt-1 text-xl ${metrics.netMinor < 0 ? 'text-rose-700 dark:text-rose-300' : 'text-primary'}`}>{money(metrics.netMinor, 'PKR')}</Text></View>
        {monthlyActivityScale > 0 ? <Text className="font-body mt-2 text-[10px] text-gray-500 dark:text-neutral-400">All bars use the same scale. Amber means refunds or corrections were larger than spending for that period.</Text> : null}
        <Text className="font-body mt-2 text-xs leading-4 text-gray-500 dark:text-neutral-400">Money in can include salary, family support and bank profit; this is not a tax calculation. Transfers, starting balances, investment purchases and loan amounts are not counted as income or spending.{metrics.excludedCurrencies.length ? ` Excluded currencies: ${metrics.excludedCurrencies.join(', ')}.` : ''}</Text>
      </Surface>

      <SectionTitle title="Spending trend" />
      <Surface>
        <Text className="font-body mb-3 text-xs text-gray-500 dark:text-neutral-400">Net spending · PKR · refunds reduce spending</Text>
        <View accessibilityRole="tablist" className="flex-row rounded-xl bg-gray-100 p-1 dark:bg-neutral-800">
          {FILTERS.map((period) => <Pressable key={period} accessibilityRole="tab" accessibilityLabel={`${period} spending`} accessibilityState={{ selected: filter === period }} onPress={() => setFilter(period)} className={`min-h-10 flex-1 items-center justify-center rounded-lg px-1 ${filter === period ? 'bg-white shadow-sm dark:bg-neutral-700' : ''}`}><Text numberOfLines={1} className={["font-body", (`text-xs font-semibold ${filter === period ? 'text-primary' : 'text-gray-500 dark:text-neutral-300'}`)].filter(Boolean).join(' ')}>{period}</Text></Pressable>)}
        </View>
        <View className="mt-4"><Chart points={chartPoints} width={width - 72} /></View>
      </Surface>

      <SectionTitle title="Monthly budget" action="Manage" onPress={() => router.push('/budgets')} />
      {metrics.budgets.length ? metrics.budgets.map((budget) => {
        const used = budget.allocatedMinor > 0 ? Math.max(0, Math.min(100, (budget.spentMinor / budget.allocatedMinor) * 100)) : budget.spentMinor > 0 ? 100 : 0;
        return <Pressable key={budget.currency} accessibilityRole="button" accessibilityLabel={`Manage ${budget.currency} monthly budget`} onPress={() => router.push('/budgets')}><Surface className="mb-3">
          <Text className="font-body font-semibold text-gray-900 dark:text-white">{budget.currency} · this month</Text>
          <Text className="font-body mt-2 text-sm text-gray-700 dark:text-neutral-200">Net spent {money(budget.spentMinor, budget.currency)} of {money(budget.allocatedMinor, budget.currency)}</Text>
          <View accessibilityLabel={`${Math.round(used)} percent of budget used`} className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className={`h-full rounded-full ${used >= 100 ? 'bg-rose-500' : 'bg-primary'}`} style={{ width: `${used}%` }} /></View>
          <Text className={["font-body", (`mt-2 text-sm font-semibold ${budget.remainingMinor < 0 ? 'text-rose-600 dark:text-rose-300' : 'text-gray-600 dark:text-neutral-300'}`)].filter(Boolean).join(' ')}>{budget.remainingMinor < 0 ? `Over by ${money(-budget.remainingMinor, budget.currency)}` : `${money(budget.remainingMinor, budget.currency)} remaining`}</Text>
        </Surface></Pressable>;
      }) : <Pressable accessibilityRole="button" onPress={() => router.push('/budgets')}><Surface><Text className="font-body font-semibold text-gray-900 dark:text-white">Set a monthly budget</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Compare spending with limits you choose.</Text></Surface></Pressable>}

      {metrics.netMinor < 0 || overBudget || approachingBudget || billNeedingAttention ? <>
        <SectionTitle title="Worth a look" />
        {metrics.netMinor < 0 ? <Pressable accessibilityRole="link" onPress={() => router.push('/transactions')}><Surface className="mb-2"><Text className="font-body font-semibold text-rose-700 dark:text-rose-300">This month’s recorded spending is above income</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">The difference is {money(-metrics.netMinor, 'PKR')}. Review this month’s transactions.</Text></Surface></Pressable> : null}
        {overBudget ? <Pressable accessibilityRole="link" onPress={() => router.push('/budgets')}><Surface className="mb-2"><Text className="font-body font-semibold text-rose-700 dark:text-rose-300">A budget is over its limit</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">{overBudget.category.category.replaceAll('_', ' ')} is over by {money(overBudget.over, overBudget.budget.currency)}. Review budgets.</Text></Surface></Pressable>
          : approachingBudget ? <Pressable accessibilityRole="link" onPress={() => router.push('/budgets')}><Surface className="mb-2"><Text className="font-body font-semibold text-amber-700 dark:text-amber-300">A budget is getting close to its limit</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">{approachingBudget.category.category.replaceAll('_', ' ')} has used {Math.round(approachingBudget.category.percentUsed)}% of its limit.</Text></Surface></Pressable> : null}
        {billNeedingAttention ? <Pressable accessibilityRole="link" onPress={() => router.push('/obligations')}><Surface className="mb-2"><Text className={`font-body font-semibold ${billNeedingAttention.status === 'overdue' ? 'text-rose-700 dark:text-rose-300' : 'text-gray-900 dark:text-white'}`}>{billNeedingAttention.status === 'overdue' ? 'An unpaid bill is overdue' : 'An unpaid bill is due soon'}</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">{billNeedingAttention.name} · {money(billNeedingAttention.remainingMinor, billNeedingAttention.currency)}. View obligations.</Text></Surface></Pressable> : null}
      </> : null}

      <SectionTitle title="Savings & emergency fund" action="Savings" onPress={() => router.push('/savings')} />
      {metrics.savings.length || emergency ? <Surface>
        {metrics.savings.map((saving) => <View key={saving.currency} className="mb-3"><Text className="font-body font-semibold text-gray-900 dark:text-white">{saving.currency} savings goals</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Set aside {money(saving.actualMinor, saving.currency)} of {money(saving.targetMinor, saving.currency)}</Text></View>)}
        {emergency ? <View className="border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">Emergency fund · {emergency.currency}</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Set aside {money(emergency.allocatedMinor, emergency.currency)} of {money(emergency.requiredMinor, emergency.currency)} target · {emergency.coverageMonthsActual.toFixed(1)} months covered</Text></View> : null}
        <Text className="font-body mt-3 text-xs leading-4 text-gray-500 dark:text-neutral-400">Money set aside is still part of your account balance; it is not extra cash or an extra asset.</Text>
      </Surface> : <Pressable accessibilityRole="button" onPress={() => router.push('/savings')}><Surface><Text className="font-body font-semibold text-gray-900 dark:text-white">Create a savings goal</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Track progress and reserve money for your priorities.</Text></Surface></Pressable>}

      <SectionTitle title="Upcoming bills" action="View all" onPress={() => router.push('/obligations')} />
      {metrics.upcomingBills.length ? <Surface>{metrics.upcomingBills.map((bill, index) => <View key={bill.id} className={`flex-row items-center justify-between py-3 ${index ? 'border-t border-gray-100 dark:border-neutral-800' : ''}`}>
        <View className="mr-3 flex-1"><Text numberOfLines={1} className="font-body font-semibold text-gray-900 dark:text-white">{bill.name}</Text><Text className={["font-body", (`mt-1 text-xs ${bill.status === 'overdue' ? 'font-semibold text-rose-600 dark:text-rose-300' : 'text-gray-500 dark:text-neutral-400'}`)].filter(Boolean).join(' ')}>{bill.status === 'overdue' ? 'Overdue' : `Due ${new Date(`${bill.dueDate}T12:00:00`).toLocaleDateString()}`}</Text></View>
        <Text className="font-body font-bold text-gray-900 dark:text-white">{money(bill.remainingMinor, bill.currency)}</Text>
      </View>)}</Surface> : <Pressable accessibilityRole="button" onPress={() => router.push('/obligations')}><Surface><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">No unpaid upcoming bills recorded.</Text></Surface></Pressable>}
      <Text className="font-body mt-2 text-xs text-gray-500 dark:text-neutral-400">A scheduled bill does not reduce your balance until you record the payment.</Text>

      <SectionTitle title="Recent activity" action="See all" onPress={() => router.push('/transactions')} />
      <Surface>
        {hasActivity ? metrics.activities.map((activity) => <ActivityRow key={activity.id} activity={activity} onPress={() => router.push('/transactions')} />)
          : <View className="py-2"><Text className="font-body font-semibold text-gray-900 dark:text-white">{metrics.hasAnyFinancialRecords ? 'No transactions recorded yet' : 'Your activity will appear here'}</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">{metrics.hasAnyFinancialRecords ? 'Your account opening balances are tracked. Record your first income, expense or transfer.' : 'Start by creating an account, then record money as it moves.'}</Text></View>}
      </Surface>

      <SectionTitle title="Quick actions" />
      <View className="flex-row flex-wrap">
        <QuickAction label="Add transaction" icon={<Plus size={17} color="white" />} onPress={() => router.push('/(tabs)/add')} primary />
        <QuickAction label="Accounts" icon={<Landmark size={17} color={PRIMARY_COLOR} />} onPress={() => router.push('/accounts')} />
        <QuickAction label="Transactions" icon={<ArrowLeftRight size={17} color={PRIMARY_COLOR} />} onPress={() => router.push('/transactions')} />
        <QuickAction label="Assets" icon={<BriefcaseBusiness size={17} color={PRIMARY_COLOR} />} onPress={() => router.push('/assets')} />
      </View>
    </ScrollView>
  </SafeAreaView>;
}

function QuickAction({ label, icon, onPress, primary = false }: { label: string; icon: React.ReactNode; onPress: () => void; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className={`${primary ? 'houselog-button' : 'border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'} mb-2 mr-2 min-h-11 flex-row items-center px-2.5`}><View>{icon}</View><Text numberOfLines={1} className={["font-body", (`ml-1.5 text-xs font-semibold ${primary ? 'text-white' : 'text-gray-800 dark:text-neutral-100'}`)].filter(Boolean).join(' ')}>{label}</Text></Pressable>;
}
