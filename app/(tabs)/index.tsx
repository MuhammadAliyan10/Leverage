import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell, BriefcaseBusiness, Landmark, Plus, RefreshCw, Wallet } from 'lucide-react-native';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { useDashboardMetrics, type DashboardChartPoint, type DashboardFilter } from '../../hooks/queries/useDashboardMetrics';
import { formatMinorUnits } from '../../src/finance/ledger';
import type { CurrencyCode } from '../../src/finance/domain';
import type { TransactionActivity } from '../../src/finance/transactionDisplay';

const FILTERS: readonly DashboardFilter[] = ['Daily', 'Weekly', 'Monthly', 'Yearly'];
const money = (minor: number, currency: CurrencyCode | string) => formatMinorUnits(minor, currency);

function SectionTitle({ title, action, onPress }: { title: string; action?: string; onPress?: () => void }) {
  return <View className="mb-3 mt-7 flex-row items-center justify-between">
    <Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">{title}</Text>
    {action && onPress ? <Pressable accessibilityRole="button" accessibilityLabel={action} onPress={onPress} className="min-h-11 justify-center pl-3"><View className="border-b border-primary pb-0.5"><Text className="font-body font-semibold text-primary">{action}</Text></View></Pressable> : null}
  </View>;
}

function Surface({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <View className={`rounded-2xl border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>{children}</View>;
}

function Skeleton({ height = 18, width = '100%' }: { height?: number; width?: `${number}%` | number }) {
  return <View style={{ height, width }} className="rounded-lg bg-gray-200 dark:bg-neutral-800" />;
}

function DashboardSkeleton() {
  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['top']}>
    <GlobalHeader title="Dashboard" description="Your finances at a glance" />
    <ScrollView className="px-5" contentContainerStyle={{ paddingBottom: 32 }}>
      <Surface className="mt-5"><Skeleton width="45%" /><View className="mt-4"><Skeleton height={32} width="65%" /></View><View className="mt-3"><Skeleton width="80%" /></View></Surface>
      <Surface className="mt-4"><Skeleton width="55%" /><View className="mt-4"><Skeleton height={100} /></View></Surface>
      <Surface className="mt-4"><Skeleton width="40%" /><View className="mt-4"><Skeleton height={66} /></View></Surface>
      <Surface className="mt-4"><Skeleton width="50%" /><View className="mt-4"><Skeleton height={66} /></View></Surface>
    </ScrollView>
  </SafeAreaView>;
}

function Chart({ points, width }: { points: readonly DashboardChartPoint[]; width: number }) {
  const max = points.reduce((highest, point) => Math.max(highest, Math.abs(point.amountMinor)), 0);
  if (points.length === 0 || max === 0) return <View className="h-36 items-center justify-center"><Text className="font-body text-sm text-gray-500 dark:text-neutral-400">No net spending in this period.</Text></View>;
  const usableWidth = Math.max(100, width - 52);
  const gap = points.length > 1 ? 10 : 0;
  const barWidth = Math.max(10, Math.min(34, (usableWidth - gap * (points.length - 1)) / points.length));
  const baseline = 54;
  return <View accessibilityLabel="Spending chart, PKR only" className="pt-2">
    <View className="h-28 flex-row items-center justify-center" style={{ gap }}>
      <View pointerEvents="none" className="absolute left-0 right-0 h-px bg-gray-300 dark:bg-neutral-700" style={{ top: baseline }} />
      {points.map((point) => {
        const barHeight = Math.max(3, Math.round((Math.abs(point.amountMinor) / max) * 48));
        const negative = point.amountMinor < 0;
        return <View key={point.label} className="h-full" style={{ width: barWidth }}>
          <View accessibilityRole="image" accessibilityLabel={`${point.label}: ${point.amountMinor < 0 ? 'net refunds' : 'net spending'} ${money(Math.abs(point.amountMinor), 'PKR')}`}
            className={`absolute left-0 rounded-md ${negative ? 'bg-amber-500' : 'bg-primary'}`}
            style={{ top: negative ? baseline : baseline - barHeight, width: barWidth, height: barHeight }} />
        </View>;
      })}
    </View>
    <View className="mt-2 flex-row justify-center" style={{ gap }}>
      {points.map((point) => <Text key={point.label} numberOfLines={1} className="font-body text-center text-[10px] text-gray-500 dark:text-neutral-400" style={{ width: barWidth }}>{point.label}</Text>)}
    </View>
    {points.some((point) => point.amountMinor < 0) ? <Text className="font-body mt-2 text-xs text-amber-700 dark:text-amber-300">Amber bars indicate refunds exceeded expenses for that period.</Text> : null}
  </View>;
}

function ActivityRow({ activity, onPress }: { activity: TransactionActivity; onPress: () => void }) {
  const incoming = activity.direction === 'in';
  const transfer = activity.direction === 'transfer';
  const Icon = incoming ? ArrowDownLeft : transfer ? ArrowLeftRight : ArrowUpRight;
  const amountColor = incoming ? 'text-emerald-700 dark:text-emerald-300' : transfer ? 'text-blue-700 dark:text-blue-300' : 'text-gray-900 dark:text-white';
  const sign = incoming ? '+' : transfer ? '↔ ' : '−';
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
  const { data: metrics, isLoading, isError, isFetching, refetch } = useDashboardMetrics(reportDate);

  useFocusEffect(useCallback(() => {
    if (metrics) void refetch();
  }, [metrics, refetch]));

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && previous !== 'active') {
        setReportDate(new Date());
        void refetch();
      }
      previous = state;
    });
    return () => subscription.remove();
  }, [refetch]);

  if (isLoading && !metrics) return <DashboardSkeleton />;
  if (isError && !metrics) return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['top']}>
    <GlobalHeader title="Dashboard" description="Your finances at a glance" />
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

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['top']}>
    <GlobalHeader title="Dashboard" description="Your finances at a glance" RightIcon={<Bell size={21} color={PRIMARY_COLOR} />} onRightPress={() => router.push('/obligations')} rightActionLabel="Open upcoming obligations" />
    <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
      {isFetching ? <Text accessibilityLiveRegion="polite" className="font-body mt-2 text-right text-xs text-gray-500 dark:text-neutral-400">Updating…</Text> : null}
      {isError ? <View accessibilityLiveRegion="assertive" className="mt-3 flex-row items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950">
        <Text className="font-body mr-3 flex-1 text-xs leading-4 text-amber-900 dark:text-amber-100">Could not refresh. Showing the last successful summary.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry dashboard refresh" onPress={() => void refetch()} className="min-h-10 justify-center px-2"><Text className="font-body font-bold text-primary">Retry</Text></Pressable>
      </View> : null}
      {!metrics.hasAnyFinancialRecords ? <Surface className="mt-5 items-start">
        <View className="h-12 w-12 items-center justify-center rounded-2xl bg-primary/10"><Wallet size={23} color={PRIMARY_COLOR} /></View>
        <Text className="font-heading mt-4 text-xl font-bold text-gray-900 dark:text-white">Start with your first account</Text>
        <Text className="font-body mt-2 text-sm leading-5 text-gray-600 dark:text-neutral-300">Add the accounts where you keep money. Then record income, expenses, transfers, savings and debts as they happen.</Text>
        <Pressable accessibilityRole="button" onPress={() => router.replace('/onboarding')} className="houselog-button mt-4 min-h-12 flex-row items-center justify-center px-4"><Plus size={18} color="white" /><Text className="font-body ml-2 font-bold text-white">Create an account</Text></Pressable>
      </Surface> : null}

      <SectionTitle title="Cash & available funds" action="Accounts" onPress={() => router.push('/accounts')} />
      {hasAccounts ? metrics.liquidity.map((position) => <Surface key={position.currency} className="mb-3">
        <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{position.currency} · active liquid accounts</Text>
        <Text className="font-heading mt-1 text-2xl font-bold text-gray-900 dark:text-white">{money(position.currentBalanceMinor, position.currency)}</Text>
        <View className="mt-3 flex-row flex-wrap border-t border-gray-100 pt-3 dark:border-neutral-800">
          <View className="mr-6"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Reserved for savings</Text><Text className="font-body mt-1 font-semibold text-gray-800 dark:text-neutral-200">{money(position.reservedMinor, position.currency)}</Text></View>
          <View><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Available unreserved</Text><Text className="font-body mt-1 font-semibold text-primary">{money(position.availableMinor, position.currency)}</Text></View>
        </View>
      </Surface>) : <Surface><Text className="font-body font-semibold text-gray-900 dark:text-white">No active liquid accounts</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Archived accounts remain in your financial history and net worth.</Text></Surface>}
      <Text className="font-body mt-1 text-xs leading-4 text-gray-500 dark:text-neutral-400">Available funds are shown by currency. Liquid includes active cash, bank, savings and wallet accounts; investments and other assets are excluded.</Text>

      <SectionTitle title="Net worth" action="Assets & debts" onPress={() => router.push('/assets')} />
      {visibleNetWorth.length ? visibleNetWorth.map((position) => <Pressable key={position.currency} accessibilityRole="button" accessibilityLabel={`Open assets and investments for ${position.currency}`} onPress={() => router.push('/assets')}><Surface className="mb-3">
        <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{position.currency} · known net worth</Text>
        <Text className="font-heading mt-1 text-2xl font-bold text-gray-900 dark:text-white">{money(position.netWorthMinor, position.currency)}</Text>
        <Text className="font-body mt-2 text-xs text-gray-600 dark:text-neutral-300">Assets {money(position.totalAssetsMinor, position.currency)} · Liabilities {money(position.liabilitiesMinor, position.currency)}</Text>
      </Surface></Pressable>) : <Surface><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Add accounts, assets or debts to see a net-worth position.</Text></Surface>}
      <Text className="font-body -mt-1 text-xs text-gray-500 dark:text-neutral-400">Currencies are kept separate; no exchange-rate estimate is used. Savings earmarks are already part of account balances.</Text>
      {metrics.unpricedHoldingCurrencies.length ? <Text className="font-body mt-2 text-xs leading-4 text-amber-700 dark:text-amber-300">Known net worth excludes holdings without a saved price in {metrics.unpricedHoldingCurrencies.join(', ')}. Asset and investment values use their latest saved estimates, which may be outdated.</Text> : <Text className="font-body mt-2 text-xs leading-4 text-gray-500 dark:text-neutral-400">Asset and investment values use their latest saved estimates, which may be outdated.</Text>}

      <SectionTitle title="This month · ordinary activity" />
      <Surface>
        <Text className="font-body text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-neutral-400">{metrics.monthLabel} · PKR only</Text>
        <View className="mt-3 flex-row flex-wrap">
          <View className="mb-3 mr-7"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Ordinary income</Text><Text className="font-heading mt-1 text-lg font-bold text-emerald-700 dark:text-emerald-300">{money(metrics.incomeMinor, 'PKR')}</Text></View>
          <View className="mb-3"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Ordinary expenses</Text><Text className="font-heading mt-1 text-lg font-bold text-gray-900 dark:text-white">{money(metrics.expenseMinor, 'PKR')}</Text></View>
        </View>
        <View className="border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Income minus expenses</Text><Text className="font-heading mt-1 text-xl font-bold text-primary">{money(metrics.netMinor, 'PKR')}</Text></View>
        <Text className="font-body mt-2 text-xs leading-4 text-gray-500 dark:text-neutral-400">Transfers, opening balances, investment purchases and debt principal are not ordinary income or spending.{metrics.excludedCurrencies.length ? ` Excluded currencies: ${metrics.excludedCurrencies.join(', ')}.` : ''}</Text>
      </Surface>

      <SectionTitle title="Spending trend" />
      <Surface>
        <Text className="font-body mb-3 text-xs text-gray-500 dark:text-neutral-400">Net ordinary expenses · PKR · refunds reduce spending</Text>
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
          <Text className="font-body mt-2 text-sm text-gray-700 dark:text-neutral-200">Spent {money(budget.spentMinor, budget.currency)} of {money(budget.allocatedMinor, budget.currency)}</Text>
          <View accessibilityLabel={`${Math.round(used)} percent of budget used`} className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className={`h-full rounded-full ${used >= 100 ? 'bg-rose-500' : 'bg-primary'}`} style={{ width: `${used}%` }} /></View>
          <Text className={["font-body", (`mt-2 text-sm font-semibold ${budget.remainingMinor < 0 ? 'text-rose-600 dark:text-rose-300' : 'text-gray-600 dark:text-neutral-300'}`)].filter(Boolean).join(' ')}>{budget.remainingMinor < 0 ? `Over by ${money(-budget.remainingMinor, budget.currency)}` : `${money(budget.remainingMinor, budget.currency)} remaining`}</Text>
        </Surface></Pressable>;
      }) : <Pressable accessibilityRole="button" onPress={() => router.push('/budgets')}><Surface><Text className="font-body font-semibold text-gray-900 dark:text-white">Set a monthly budget</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Compare spending with limits you choose.</Text></Surface></Pressable>}

      <SectionTitle title="Savings & emergency fund" action="Savings" onPress={() => router.push('/savings')} />
      {metrics.savings.length || emergency ? <Surface>
        {metrics.savings.map((saving) => <View key={saving.currency} className="mb-3"><Text className="font-body font-semibold text-gray-900 dark:text-white">{saving.currency} savings goals</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Saved {money(saving.actualMinor, saving.currency)} of {money(saving.targetMinor, saving.currency)}</Text></View>)}
        {emergency ? <View className="border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">Emergency fund · {emergency.currency}</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">{money(emergency.allocatedMinor, emergency.currency)} of {money(emergency.requiredMinor, emergency.currency)} target · {emergency.coverageMonthsActual.toFixed(1)} months covered</Text></View> : null}
        <Text className="font-body mt-3 text-xs leading-4 text-gray-500 dark:text-neutral-400">Earmarks reserve existing money; they are not extra cash or assets.</Text>
      </Surface> : <Pressable accessibilityRole="button" onPress={() => router.push('/savings')}><Surface><Text className="font-body font-semibold text-gray-900 dark:text-white">Create a savings goal</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Track progress and reserve money for your priorities.</Text></Surface></Pressable>}

      <SectionTitle title="Upcoming obligations" action="View all" onPress={() => router.push('/obligations')} />
      {metrics.upcomingBills.length ? <Surface>{metrics.upcomingBills.map((bill, index) => <View key={bill.id} className={`flex-row items-center justify-between py-3 ${index ? 'border-t border-gray-100 dark:border-neutral-800' : ''}`}>
        <View className="mr-3 flex-1"><Text numberOfLines={1} className="font-body font-semibold text-gray-900 dark:text-white">{bill.name}</Text><Text className={["font-body", (`mt-1 text-xs ${bill.status === 'overdue' ? 'font-semibold text-rose-600 dark:text-rose-300' : 'text-gray-500 dark:text-neutral-400'}`)].filter(Boolean).join(' ')}>{bill.status === 'overdue' ? 'Overdue' : `Due ${new Date(`${bill.dueDate}T12:00:00`).toLocaleDateString()}`}</Text></View>
        <Text className="font-body font-bold text-gray-900 dark:text-white">{money(bill.remainingMinor, bill.currency)}</Text>
      </View>)}</Surface> : <Pressable accessibilityRole="button" onPress={() => router.push('/obligations')}><Surface><Text className="font-body text-sm text-gray-600 dark:text-neutral-300">No unpaid upcoming bills recorded.</Text></Surface></Pressable>}
      <Text className="font-body mt-2 text-xs text-gray-500 dark:text-neutral-400">Scheduled amounts are not deducted from account balances until recorded as paid.</Text>

      <SectionTitle title="Recent activity" action="See all" onPress={() => router.push('/transactions')} />
      <Surface>
        {hasActivity ? metrics.activities.map((activity) => <ActivityRow key={activity.id} activity={activity} onPress={() => router.push('/transactions')} />)
          : <View className="py-2"><Text className="font-body font-semibold text-gray-900 dark:text-white">{metrics.hasAnyFinancialRecords ? 'No transactions recorded yet' : 'Your activity will appear here'}</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">{metrics.hasAnyFinancialRecords ? 'Your account opening balances are tracked. Record your first income, expense or transfer.' : 'Start by creating an account, then record money as it moves.'}</Text></View>}
      </Surface>

      <SectionTitle title="Quick actions" />
      <View className="flex-row flex-wrap">
        <QuickAction label="Add transaction" icon={<Plus size={19} color="white" />} onPress={() => router.push('/(tabs)/add')} primary />
        <QuickAction label="Accounts" icon={<Landmark size={19} color={PRIMARY_COLOR} />} onPress={() => router.push('/accounts')} />
        <QuickAction label="Transactions" icon={<ArrowLeftRight size={19} color={PRIMARY_COLOR} />} onPress={() => router.push('/transactions')} />
        <QuickAction label="Assets" icon={<BriefcaseBusiness size={19} color={PRIMARY_COLOR} />} onPress={() => router.push('/assets')} />
      </View>
    </ScrollView>
  </SafeAreaView>;
}

function QuickAction({ label, icon, onPress, primary = false }: { label: string; icon: React.ReactNode; onPress: () => void; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className={`${primary ? 'houselog-button' : 'border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'} mb-2 mr-2 min-h-12 flex-row items-center px-3`}><View>{icon}</View><Text numberOfLines={1} className={["font-body", (`ml-2 text-sm font-semibold ${primary ? 'text-white' : 'text-gray-800 dark:text-neutral-100'}`)].filter(Boolean).join(' ')}>{label}</Text></Pressable>;
}
