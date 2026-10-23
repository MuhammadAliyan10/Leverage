import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BarChart, LineChart, PieChart } from 'react-native-gifted-charts';
import { ArrowUpRight, Banknote, BriefcaseBusiness, Car, CircleHelp, Coffee, CreditCard, Gift, Heart, Home, PiggyBank, RefreshCw, ShoppingBag, ShoppingCart, Wallet, Zap } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { useInsightsMetrics } from '../../hooks/queries/useInsightsMetrics';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import { CLASSIFICATIONS } from '../../src/finance/domain';
import { formatMinorUnits } from '../../src/finance/ledger';
import { INSIGHTS_PERIODS, type InsightsPeriod } from '../../src/finance/insights';

const CATEGORY_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  food: { color: '#F59E0B', icon: ShoppingCart }, groceries: { color: '#F59E0B', icon: ShoppingCart },
  transport: { color: '#2D8CFF', icon: Car }, bills: { color: '#E59A22', icon: Zap },
  shopping: { color: '#D946EF', icon: ShoppingBag }, health: { color: '#E34D59', icon: Heart },
  bank_fee: { color: '#64748B', icon: CreditCard }, housing: { color: '#8B5CF6', icon: Home },
  other_expense: { color: '#94A3B8', icon: CircleHelp }, 'rent & utilities': { color: '#8B5CF6', icon: Home },
  entertainment: { color: '#D946EF', icon: Coffee },
};
const INCOME_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  salary: { color: '#15966A', icon: BriefcaseBusiness }, freelance: { color: '#18A999', icon: BriefcaseBusiness },
  business_revenue: { color: '#25A36F', icon: BriefcaseBusiness }, family_gift: { color: '#8B5CF6', icon: Gift },
  foreign_remittance: { color: '#4F7EE8', icon: Gift }, investment_return: { color: '#635BFF', icon: Banknote },
  rental_income: { color: '#D99028', icon: Home }, other_income: { color: '#64748B', icon: CircleHelp },
};
const GREEN = '#15966A';
const ORANGE = '#EF8B36';

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0;
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <View className={`mb-4 border border-gray-100 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>{children}</View>;
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return <View className="mb-3"><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{title}</Text>{hint ? <Text className="mt-1 font-body text-xs text-gray-500 dark:text-neutral-400">{hint}</Text> : null}</View>;
}

function Money({ amount, currency, color }: { amount: number; currency: string; color?: string }) {
  return <Text className="font-heading text-xl font-bold" style={{ color: color ?? undefined }}>{formatMinorUnits(amount, currency)}</Text>;
}

export default function InsightsScreen() {
  const [period, setPeriod] = useState<InsightsPeriod>('This month');
  const [currencyPreference, setCurrencyPreference] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const dark = colorScheme === 'dark';
  const axisColor = dark ? '#A3A3A3' : '#737987';
  const dataQuery = useInsightsMetrics(period, currencyPreference);
  const data = dataQuery.data;
  const chartWidth = Math.max(225, width - 100);
  const selectedPoint = data?.monthReportRows.find((point) => point.id === selectedMonth) ?? data?.monthReportRows.at(-1);

  const pieData = useMemo(() => (data?.categories ?? []).filter((item) => item.amountMinor > 0).map((item) => {
    const style = CATEGORY_STYLE[item.category.toLowerCase()] ?? { color: '#94A3B8', icon: CircleHelp };
    return { value: item.amountMinor / 100, color: style.color, text: CLASSIFICATIONS[item.category as keyof typeof CLASSIFICATIONS]?.label ?? item.category };
  }), [data?.categories]);

  const goTransactions = (filters: { categoryId?: string; currency?: string; startDate?: string; endDate?: string } = {}) => {
    router.push({ pathname: '/transactions', params: Object.fromEntries(Object.entries(filters).filter(([, value]) => !!value)) });
  };

  const chartData = useMemo(() => (data?.monthReportRows ?? []).flatMap((point) => [
    { value: point.incomeMinor / 100, label: point.label, frontColor: GREEN, spacing: 3, onPress: () => setSelectedMonth(point.id) },
    { value: point.expenseMinor / 100, label: '', frontColor: ORANGE, spacing: 17, onPress: () => setSelectedMonth(point.id) },
  ]), [data?.monthReportRows]);
  const trendData = useMemo(() => (data?.spendingTrend ?? []).map((point) => ({ value: Math.max(0, point.amountMinor) / 100, label: point.label })), [data?.spendingTrend]);

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['top']}>
      <GlobalHeader title="Insights" description="See the patterns behind your money" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 36 }} showsVerticalScrollIndicator={false}>
        <View className="mb-4">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {INSIGHTS_PERIODS.map((item) => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: period === item }} onPress={() => { setPeriod(item); setSelectedMonth(null); }} className={`min-h-10 justify-center border px-3 ${period === item ? 'border-primary bg-primary' : 'border-gray-200 bg-white dark:border-neutral-700 dark:bg-neutral-900'}`}><Text className={`font-body text-xs font-semibold ${period === item ? 'text-white' : 'text-gray-700 dark:text-neutral-200'}`}>{item}</Text></Pressable>)}
          </ScrollView>
          {data && data.currencies.length > 1 ? <ScrollView horizontal className="mt-2" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{data.currencies.map((currency) => <Pressable key={currency} accessibilityRole="button" accessibilityState={{ selected: data.currency === currency }} onPress={() => setCurrencyPreference(currency)} className={`min-h-9 justify-center border px-3 ${data.currency === currency ? 'border-primary bg-primary/10' : 'border-gray-200 bg-white dark:border-neutral-700 dark:bg-neutral-900'}`}><Text className={`font-body text-xs font-semibold ${data.currency === currency ? 'text-primary' : 'text-gray-600 dark:text-neutral-300'}`}>{currency}</Text></Pressable>)}</ScrollView> : null}
        </View>

        {dataQuery.isLoading ? <View accessibilityLabel="Loading financial insights" className="gap-3">{[0, 1, 2].map((item) => <View key={item} className="mb-2 h-32 border border-gray-100 bg-white dark:border-neutral-800 dark:bg-neutral-900" />)}<ActivityIndicator color={PRIMARY_COLOR} /></View> : dataQuery.isError ? <Card className="items-center py-8"><RefreshCw size={22} color={PRIMARY_COLOR} /><Text className="mt-3 font-heading font-semibold text-gray-900 dark:text-white">Insights could not be loaded</Text><Text className="mt-1 text-center font-body text-sm text-gray-500 dark:text-neutral-400">{dataQuery.error instanceof Error ? dataQuery.error.message : 'Your saved records are unchanged.'}</Text><Pressable accessibilityRole="button" onPress={() => void dataQuery.refetch()} className="houselog-button mt-4 px-5 py-3"><Text className="font-body font-semibold text-white">Retry</Text></Pressable></Card> : data ? <>
          <Text className="mb-2 font-body text-[11px] text-gray-500 dark:text-neutral-400">{period} · {data.currency} only · {data.excludedCurrencies.length ? `excludes ${data.excludedCurrencies.join(', ')}` : 'no other recorded currencies excluded'}</Text>

          <Card>
            <SectionTitle title="Income, spending & net" hint={`${data.report.incomeMinor >= 0 ? 'Recorded money in' : 'Net income adjustments'} and ordinary expenses`} />
            <View className="flex-row flex-wrap gap-y-4">
              <View className="w-1/2 pr-2"><Text className="mb-1 font-body text-xs text-gray-500 dark:text-neutral-400">Ordinary income</Text><Money amount={data.report.incomeMinor} currency={data.currency} color={GREEN} /></View>
              <View className="w-1/2 pl-2"><Text className="mb-1 font-body text-xs text-gray-500 dark:text-neutral-400">Net ordinary spending</Text><Money amount={data.report.expenseMinor} currency={data.currency} color={ORANGE} /></View>
              <View className="w-full border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="mb-1 font-body text-xs text-gray-500 dark:text-neutral-400">Income minus expenses</Text><Money amount={data.report.netMinor} currency={data.currency} color={data.report.netMinor >= 0 ? PRIMARY_COLOR : '#DC4C4C'} /></View>
            </View>
            <View className="mt-4 flex-row flex-wrap gap-3 border-t border-gray-100 pt-3 dark:border-neutral-800">
              <View className="min-w-[45%] flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Avg. spending / calendar day</Text><Text className="mt-1 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(data.dailyAverageMinor, data.currency)}</Text></View>
              <View className="min-w-[45%] flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">vs previous period</Text><Text className="mt-1 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Income {data.incomeChangePercent === null ? '—' : `${data.incomeChangePercent >= 0 ? '+' : ''}${data.incomeChangePercent.toFixed(0)}%`} · Spend {data.expenseChangePercent === null ? '—' : `${data.expenseChangePercent >= 0 ? '+' : ''}${data.expenseChangePercent.toFixed(0)}%`}</Text></View>
              <View className="min-w-[45%] flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Spending frequency</Text><Text className="mt-1 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{data.report.expenseCount} net expense records</Text></View>
            </View>
            <Text className="mt-3 font-body text-[11px] leading-4 text-gray-500 dark:text-neutral-400">Transfers, opening balances, loan principal and asset purchases are excluded from ordinary income and spending. Investment dividends follow their recorded income classification.</Text>
          </Card>

          {data.monthReportRows.some((point) => point.incomeMinor !== 0 || point.expenseMinor !== 0) ? <Card>
            <SectionTitle title="Income vs expenses" hint="Monthly totals from every eligible transaction in the selected period" />
            {selectedPoint ? <Pressable accessibilityRole="button" onPress={() => goTransactions({ currency: data.currency, startDate: selectedPoint.startDate, endDate: selectedPoint.endDate })} className="mb-3 flex-row items-center justify-between border-l-2 border-primary pl-3"><View><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{selectedPoint.label} · tap to view transactions</Text><Text className="mt-1 font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">Income {formatMinorUnits(selectedPoint.incomeMinor, data.currency)} · Spending {formatMinorUnits(selectedPoint.expenseMinor, data.currency)}</Text></View><ArrowUpRight size={16} color={PRIMARY_COLOR} /></Pressable> : null}
            <View accessible accessibilityRole="image" accessibilityLabel={`Grouped bars compare income and expenses by month, denominated in ${data.currency}.`}><ScrollView horizontal showsHorizontalScrollIndicator={false}><BarChart data={chartData} barWidth={11} spacing={5} isAnimated={false} height={150} width={chartWidth} noOfSections={4} yAxisLabelWidth={45} yAxisTextStyle={{ color: axisColor, fontSize: 9 }} xAxisLabelTextStyle={{ color: axisColor, fontSize: 9 }} xAxisThickness={0} yAxisThickness={0} hideRules={false} rulesColor={dark ? '#303030' : '#ECEEF2'} /></ScrollView></View>
            <View className="mt-2 flex-row justify-center gap-5"><Legend color={GREEN} label="Income" /><Legend color={ORANGE} label="Expenses" /></View>
          </Card> : <Card><SectionTitle title="Income vs expenses" hint="Monthly totals from every eligible transaction in the selected period" /><Empty text="No income or spending activity has been recorded for this period." /></Card>}

          <Card>
            <SectionTitle title="Spending by category" hint="Net expense totals after refunds and reversals" />
            {data.categories.length === 0 ? <Empty text="No ordinary expenses recorded in this period." /> : <>
              {pieData.length > 0 ? <View accessible accessibilityRole="image" accessibilityLabel={`Category donut shows positive net category totals of ${formatMinorUnits(data.positiveCategoryTotalMinor, data.currency)}. Refund adjustments are listed separately.`} className="mb-3 items-center"><PieChart donut radius={90} innerRadius={64} data={pieData} centerLabelComponent={() => <View className="items-center"><Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">Positive category totals</Text><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{formatMinorUnits(data.positiveCategoryTotalMinor, data.currency)}</Text></View>} /></View> : null}
              {data.categories.map((category) => {
                const key = category.category.toLowerCase(); const style = CATEGORY_STYLE[key] ?? { color: '#94A3B8', icon: CircleHelp }; const Icon = style.icon;
                const label = CLASSIFICATIONS[category.category as keyof typeof CLASSIFICATIONS]?.label ?? category.category.replaceAll('_', ' ');
                const share = category.amountMinor > 0 && data.positiveCategoryTotalMinor > 0 ? category.amountMinor / data.positiveCategoryTotalMinor : 0;
                return <Pressable key={category.category} accessibilityRole="button" accessibilityLabel={`Show ${label} transactions, ${formatMinorUnits(category.amountMinor, data.currency)}`} onPress={() => goTransactions({ categoryId: category.category, currency: data.currency, startDate: data.currentRange.startDate, endDate: data.currentRange.endDate })} className="mb-3 flex-row items-center"><View className="mr-3 h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: `${style.color}20` }}><Icon size={17} color={style.color} /></View><View className="mr-3 flex-1"><Text className="font-body text-sm font-semibold capitalize text-gray-800 dark:text-neutral-100" numberOfLines={1}>{label}</Text><View className="mt-1 h-1.5 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full" style={{ width: `${share * 100}%`, backgroundColor: style.color }} /></View></View><View className="items-end"><Text className="font-body text-sm font-bold" style={{ color: category.amountMinor < 0 ? GREEN : undefined }}>{formatMinorUnits(category.amountMinor, data.currency)}</Text><Text className="font-body text-[10px] text-gray-500 dark:text-neutral-400">{category.amountMinor < 0 ? 'net refund' : `${(share * 100).toFixed(0)}%`}</Text></View></Pressable>;
              })}
              {data.categories.some((item) => item.amountMinor < 0) ? <Text className="mt-1 font-body text-xs leading-4 text-gray-500 dark:text-neutral-400">Refund adjustments are signed and shown separately; donut slices include only positive net category spending.</Text> : null}
            </>}
          </Card>

          {data.spendingTrend.length > 0 && data.report.expenseMinor > 0 ? <Card>
            <SectionTitle title="Spending trend" hint={period === 'This month' || period === 'Last month' ? 'Daily net spending, including zero-activity days' : 'Monthly net spending'} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false}><LineChart data={trendData} width={chartWidth} height={140} color={ORANGE} thickness={2} hideDataPoints dataPointsColor={ORANGE} hideRules xAxisThickness={0} yAxisThickness={0} xAxisLabelTextStyle={{ color: axisColor, fontSize: 9 }} yAxisTextStyle={{ color: axisColor, fontSize: 9 }} /></ScrollView>
            {data.spendingTrend.length > 0 ? <Text className="mt-2 font-body text-xs text-gray-600 dark:text-neutral-300">Highest period: {(() => { const highest = data.spendingTrend.reduce((top, current) => current.amountMinor > top.amountMinor ? current : top); return `${highest.label} · ${formatMinorUnits(highest.amountMinor, data.currency)}`; })()}</Text> : null}
          </Card> : null}

          {data.incomeSources.length > 0 ? <Card>
            <SectionTitle title="Where income came from" hint="Recorded income classifications; receipts are not the same as taxable income" />
            {data.incomeSources.map((source) => {
              const style = INCOME_STYLE[source.source] ?? { color: '#64748B', icon: CircleHelp }; const Icon = style.icon;
              const label = CLASSIFICATIONS[source.source as keyof typeof CLASSIFICATIONS]?.label ?? source.source.replaceAll('_', ' ');
              const share = safeRatio(source.amountMinor, data.report.incomeMinor);
              return <View key={source.source} className="mb-3 flex-row items-center"><View className="mr-3 h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: `${style.color}20` }}><Icon size={17} color={style.color} /></View><View className="mr-3 flex-1"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{label}</Text><View className="mt-1 h-1.5 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full" style={{ width: `${share * 100}%`, backgroundColor: style.color }} /></View></View><Text className="font-body text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(source.amountMinor, data.currency)}</Text></View>;
            })}
          </Card> : null}

          {data.budgets.length || data.activeGoals.length || data.emergency ? <Card>
            <SectionTitle title="Budgets & savings" hint="Actual spending and earmarked goals remain separate from account balances" />
            {data.budgets.length ? data.budgets.slice(0, 4).map((budget) => { const ratio = safeRatio(budget.spentMinor, budget.allocatedMinor); const over = budget.remainingMinor < 0; return <View key={budget.category} className="mb-3"><View className="mb-1 flex-row justify-between"><Text className="font-body text-sm font-semibold capitalize text-gray-800 dark:text-neutral-100">{CLASSIFICATIONS[budget.category as keyof typeof CLASSIFICATIONS]?.label ?? budget.category}</Text><Text className={`font-body text-xs font-semibold ${over ? 'text-red-600' : 'text-gray-500 dark:text-neutral-400'}`}>{over ? `Over by ${formatMinorUnits(-budget.remainingMinor, data.currency)}` : `${formatMinorUnits(budget.remainingMinor, data.currency)} left`}</Text></View><View className="h-2 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full" style={{ width: `${ratio * 100}%`, backgroundColor: over ? '#DC4C4C' : PRIMARY_COLOR }} /></View><Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">{formatMinorUnits(budget.spentMinor, data.currency)} of {formatMinorUnits(budget.allocatedMinor, data.currency)}</Text></View>; }) : null}
            {data.activeGoals.length ? data.activeGoals.slice(0, 3).map((goal) => <View key={goal.id} className="mb-3"><View className="mb-1 flex-row justify-between"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{goal.name}</Text><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{goal.percent.toFixed(0)}%</Text></View><View className="h-2 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full bg-primary" style={{ width: `${safeRatio(goal.actualMinor, goal.targetMinor) * 100}%` }} /></View><Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">{formatMinorUnits(goal.actualMinor, data.currency)} of {formatMinorUnits(goal.targetMinor, data.currency)}</Text></View>) : null}
            {data.emergency ? <View className="mt-2 border-t border-gray-100 pt-3 dark:border-neutral-800"><View className="mb-1 flex-row justify-between"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Emergency fund · {data.emergency.currency}</Text><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{data.emergency.coverageMonthsActual.toFixed(1)} / {data.emergency.coverageMonths} months</Text></View><View className="h-2 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full bg-primary" style={{ width: `${safeRatio(data.emergency.allocatedMinor, data.emergency.requiredMinor) * 100}%` }} /></View><Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">{formatMinorUnits(data.emergency.allocatedMinor, data.emergency.currency)} saved · {formatMinorUnits(data.emergency.remainingMinor, data.emergency.currency)} remaining to target. Essential monthly baseline {formatMinorUnits(data.emergency.essentialMonthlyMinor, data.emergency.currency)}.</Text></View> : null}
            <Pressable accessibilityRole="link" onPress={() => router.push('/budgets')} className="mt-2 self-start border-b border-primary pb-0.5"><Text className="font-body text-xs font-semibold text-primary">Manage budgets and savings</Text></Pressable>
          </Card> : null}

          {data.liquidity.length || data.netWorth.length ? <Card>
            <SectionTitle title="Liquidity & net worth" hint="Currency totals remain separate; assets are not cash available to spend" />
            {data.liquidity.filter((position) => position.currency === data.currency).map((position) => <View key={`liq-${position.currency}`} className="mb-3"><View className="mb-1 flex-row items-center"><Wallet size={15} color="#2D8CFF" /><Text className="ml-2 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Cash & bank · {position.currency}</Text></View><View className="flex-row justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Account balances</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(position.currentBalanceMinor, position.currency)}</Text></View><View className="mt-1 flex-row justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Reserved · available</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(position.reservedMinor, position.currency)} · {formatMinorUnits(position.availableMinor, position.currency)}</Text></View></View>)}
            {data.netWorth.map((position) => <View key={`nw-${position.currency}`} className="mb-3 border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="mb-2 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Net worth · {position.currency}</Text><View className="flex-row flex-wrap gap-y-2"><Position label="Assets" value={position.totalAssetsMinor} currency={position.currency} /><Position label="Liabilities" value={position.liabilitiesMinor} currency={position.currency} /><Position label="Net worth" value={position.netWorthMinor} currency={position.currency} strong /></View></View>)}
            {data.netWorth.filter((position) => position.currency === data.currency).map((position) => <View key={`mix-${position.currency}`} className="mb-2"><Text className="mb-2 font-body text-xs font-semibold text-gray-700 dark:text-neutral-200">Asset allocation · {position.currency}</Text><AssetComponent label="Cash and accounts" value={position.cashMinor} total={position.totalAssetsMinor} currency={position.currency} color="#2D8CFF" /><AssetComponent label="Investments" value={position.investmentsMinor} total={position.totalAssetsMinor} currency={position.currency} color="#8B5CF6" /><AssetComponent label="Physical assets" value={position.physicalAssetsMinor} total={position.totalAssetsMinor} currency={position.currency} color="#E59A22" /><AssetComponent label="Receivables" value={position.receivablesMinor} total={position.totalAssetsMinor} currency={position.currency} color="#15966A" /></View>)}
            <Text className="mt-1 font-body text-[11px] leading-4 text-gray-500 dark:text-neutral-400">A dated net-worth trend is unavailable in Insights because the existing history repository loads unbounded ledger history and reconstructs each snapshot repeatedly. Current positions use saved valuations; {data.staleAssetValuations ? `${data.staleAssetValuations} asset valuation(s) are older than 180 days or undated.` : 'asset estimates may still be stale.'}</Text>
          </Card> : null}

          {(data.investments.marketValueMinor > 0 || data.investments.realizedGainMinor !== 0 || data.investments.unrealizedGainMinor !== 0 || data.investments.dividendsMinor > 0 || data.unpricedCurrencies.includes(data.currency) || data.debtPositions.some((item) => item.currency === data.currency) || data.bills.length) ? <Card>
            <SectionTitle title="Investments, debt & upcoming bills" hint="Principal movements are tracked outside ordinary spending" />
            {data.investments.marketValueMinor > 0 || data.investmentPriceInfo.length ? <View className="mb-3"><View className="flex-row items-center"><PiggyBank size={16} color="#7C4DCE" /><Text className="ml-2 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Recorded investment value</Text></View><Money amount={data.investments.marketValueMinor} currency={data.currency} color="#7C4DCE" /><Text className="mt-1 font-body text-xs text-gray-500 dark:text-neutral-400">Realized {formatMinorUnits(data.investments.realizedGainMinor, data.currency)} · unrealized {formatMinorUnits(data.investments.unrealizedGainMinor, data.currency)} · dividends {formatMinorUnits(data.investments.dividendsMinor, data.currency)}{data.unpricedCurrencies.includes(data.currency) ? ' · some holdings lack a saved price' : ''}</Text>{data.investmentPriceInfo.map((price, index) => <Text key={`${price.date ?? 'no-date'}-${index}`} className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">Price {price.date ? new Date(price.date).toLocaleDateString() : 'not recorded'} · {price.source ?? 'source unavailable'}{price.stale ? ' · stale (>180 days)' : ''}</Text>)}</View> : null}
            {data.debtPositions.filter((item) => item.currency === data.currency).map((debt) => <View key={`debt-${debt.currency}`} className="mb-2 flex-row items-center justify-between"><View className="flex-row items-center"><CreditCard size={16} color="#DC4C4C" /><Text className="ml-2 font-body text-sm text-gray-700 dark:text-neutral-200">Debt outstanding · {debt.currency}</Text></View><Text className="font-body text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(debt.liabilitiesMinor, debt.currency)}</Text></View>)}
            {data.bills.map((bill) => <View key={bill.id} className="mb-2 flex-row justify-between"><Text className="flex-1 font-body text-xs text-gray-700 dark:text-neutral-200" numberOfLines={1}>{bill.name} · {bill.status}</Text><Text className="ml-2 font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(bill.amountMinor, bill.currency)}</Text></View>)}
            <Pressable accessibilityRole="link" onPress={() => router.push('/obligations')} className="mt-2 self-start border-b border-primary pb-0.5"><Text className="font-body text-xs font-semibold text-primary">View assets and obligations</Text></Pressable>
          </Card> : null}
        </> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Legend({ color, label }: { color: string; label: string }) { return <View className="flex-row items-center"><View className="mr-1.5 h-2.5 w-2.5" style={{ backgroundColor: color }} /><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{label}</Text></View>; }
function Empty({ text }: { text: string }) { return <Text className="py-3 font-body text-sm text-gray-500 dark:text-neutral-400">{text}</Text>; }
function Position({ label, value, currency, strong = false }: { label: string; value: number; currency: string; strong?: boolean }) { return <View className="w-1/3 pr-1"><Text className="font-body text-[10px] text-gray-500 dark:text-neutral-400">{label}</Text><Text className={`mt-0.5 font-body ${strong ? 'text-sm font-bold text-primary' : 'text-xs font-semibold text-gray-800 dark:text-neutral-100'}`}>{formatMinorUnits(value, currency)}</Text></View>; }
function AssetComponent({ label, value, total, currency, color }: { label: string; value: number; total: number; currency: string; color: string }) { return <View className="mb-2"><View className="mb-1 flex-row justify-between"><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{label}</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(value, currency)}</Text></View><View className="h-1.5 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full" style={{ width: `${value > 0 ? safeRatio(value, total) * 100 : 0}%`, backgroundColor: color }} /></View></View>; }
