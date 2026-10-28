import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PieChart } from 'react-native-gifted-charts';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { ArrowUpRight, BriefcaseBusiness, Car, ChartNoAxesCombined, CircleEllipsis, Coffee, CreditCard, Gift, Globe2, HandCoins, Heart, Home, ReceiptText, RefreshCw, ShoppingBag, ShoppingCart, TrendingDown, TrendingUp, Wallet } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { BADGE_NEUTRAL, BADGE_NEUTRAL_TEXT, BADGE_PRIMARY, BADGE_PRIMARY_TEXT } from '../../components/ui/badgeStyles';
import { SectionHeading } from '../../components/ui/SectionHeading';
import { DatePickerField } from '../../components/ui/DatePickerField';
import { useInsightsMetrics } from '../../hooks/queries/useInsightsMetrics';
import { PRIMARY_COLOR } from '../../src/constants/themeColors';
import { CLASSIFICATIONS } from '../../src/finance/domain';
import { formatMinorUnits } from '../../src/finance/ledger';
import { INSIGHTS_PERIODS, type InsightsPeriod } from '../../src/finance/insights';
import { calculateCashFlowSections, transactionDateTimestamp } from '../../src/finance/reporting';

const CATEGORY_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  food: { color: '#F59E0B', icon: ShoppingCart }, groceries: { color: '#F59E0B', icon: ShoppingCart },
  transport: { color: '#2D8CFF', icon: Car }, bills: { color: '#E59A22', icon: ReceiptText },
  shopping: { color: '#D946EF', icon: ShoppingBag }, health: { color: '#E34D59', icon: Heart },
  bank_fee: { color: '#14B8A6', icon: CreditCard }, housing: { color: '#8B5CF6', icon: Home },
  other_expense: { color: '#22C55E', icon: CircleEllipsis }, 'rent & utilities': { color: '#8B5CF6', icon: Home },
  entertainment: { color: '#D946EF', icon: Coffee },
};
const CATEGORY_FALLBACK_COLORS = ['#06B6D4', '#F43F5E', '#84CC16', '#A855F7', '#0EA5E9', '#F97316'];
const INCOME_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  salary: { color: '#15966A', icon: BriefcaseBusiness }, freelance: { color: '#18A999', icon: BriefcaseBusiness },
  business_revenue: { color: '#25A36F', icon: BriefcaseBusiness }, family_gift: { color: '#8B5CF6', icon: Gift },
  foreign_remittance: { color: '#4F7EE8', icon: Globe2 }, investment_return: { color: '#635BFF', icon: HandCoins },
  rental_income: { color: '#D99028', icon: Home }, other_income: { color: '#64748B', icon: CircleEllipsis },
};
const GREEN = '#15966A';
const ORANGE = '#EF8B36';

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDateKey(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : undefined;
}

function categoryStyle(category: string) {
  const key = category.trim().toLowerCase();
  const known = CATEGORY_STYLE[key];
  if (known) return known;
  const hash = [...key].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
  return { color: CATEGORY_FALLBACK_COLORS[hash % CATEGORY_FALLBACK_COLORS.length]!, icon: CircleEllipsis };
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <View className={`mb-4 rounded-md border border-gray-100 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>{children}</View>;
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return <SectionHeading title={title} description={hint} className="mb-3" />;
}

function Money({ amount, currency, color, className = 'text-xl' }: { amount: number; currency: string; color?: string; className?: string }) {
  return <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} className={`font-heading ${className} font-bold`} style={{ color: color ?? undefined }}>{formatMinorUnits(amount, currency)}</Text>;
}

export default function InsightsScreen() {
  const [period, setPeriod] = useState<InsightsPeriod>('This month');
  const [customStartDate, setCustomStartDate] = useState(() => dateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [customEndDate, setCustomEndDate] = useState(() => dateKey(new Date()));
  const [reportView, setReportView] = useState<'review' | 'overview' | 'income' | 'cashflow' | 'balance'>('review');
  const [currencyPreference, setCurrencyPreference] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const dark = colorScheme === 'dark';
  const customDates = { startDate: customStartDate, endDate: customEndDate };
  const dataQuery = useInsightsMetrics(period, currencyPreference, customDates);
  const data = dataQuery.data;
  const periodLabel = period === 'Custom' ? `${formatDateOnly(customStartDate)} – ${formatDateOnly(customEndDate)}` : period;
  const selectedPoint = data?.monthReportRows.find((point) => point.id === selectedMonth) ?? data?.monthReportRows.at(-1);
  const selectedLiquidity = data?.liquidity.find((position) => position.currency === data.currency);
  const selectedNetWorth = data?.netWorth.find((position) => position.currency === data.currency);
  const cashFlowSections = useMemo(() => data ? calculateCashFlowSections(data.reportRows, data.currency, data.currentRange) : [], [data]);
  const cashFlowNet = cashFlowSections.reduce((sum, section) => sum + BigInt(section.netMinor), 0n);
  const cashFlowNetMinor = cashFlowNet <= BigInt(Number.MAX_SAFE_INTEGER) && cashFlowNet >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(cashFlowNet) : null;
  const activityScale = data ? Math.max(Math.abs(data.report.incomeMinor), Math.abs(data.report.expenseMinor), 1) : 1;
  const categoryIncrease = useMemo(() => {
    if (!data) return null;
    const previous = new Map(data.previousReport.categoryTotals.map((item) => [item.category, BigInt(item.amountMinor)]));
    let largest: { category: string; amountMinor: number } | null = null;
    for (const item of data.report.categoryTotals) {
      const increase = BigInt(item.amountMinor) - (previous.get(item.category) ?? 0n);
      if (increase <= 0n || increase > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      if (!largest || increase > BigInt(largest.amountMinor)) largest = { category: item.category, amountMinor: Number(increase) };
    }
    return largest;
  }, [data]);

  const pieData = useMemo(() => (data?.categories ?? []).filter((item) => item.amountMinor > 0).map((item) => {
    const style = categoryStyle(item.category);
    return { value: item.amountMinor / 100, color: style.color, text: CLASSIFICATIONS[item.category as keyof typeof CLASSIFICATIONS]?.label ?? item.category };
  }), [data?.categories]);

  const goTransactions = (filters: { categoryId?: string; currency?: string; startDate?: string; endDate?: string } = {}) => {
    router.push({ pathname: '/transactions', params: Object.fromEntries(Object.entries(filters).filter(([, value]) => !!value)) });
  };

  const goExpenseDay = (expense: { category: string; date: string }) => {
    const occurredAt = new Date(transactionDateTimestamp(expense.date));
    const start = new Date(occurredAt.getFullYear(), occurredAt.getMonth(), occurredAt.getDate());
    const end = new Date(occurredAt.getFullYear(), occurredAt.getMonth(), occurredAt.getDate() + 1);
    const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    goTransactions({ categoryId: expense.category, currency: data?.currency, startDate: dayKey(start), endDate: dayKey(end) });
  };

  const monthlyMax = Math.max(1, ...(data?.monthReportRows ?? []).flatMap((point) => [point.incomeMinor, point.expenseMinor]));
  const trendPoints = data?.spendingTrend ?? [];
  const highestTrend = trendPoints.reduce<(typeof trendPoints)[number] | null>((top, current) => !top || current.amountMinor > top.amountMinor ? current : top, null);
  const trendFrequency = period === 'This month' || period === 'Last month' ? 'day' : 'month';
  const spendingShare = data && data.report.incomeMinor > 0 ? data.report.expenseMinor / data.report.incomeMinor : null;
  const spendingShareLabel = spendingShare === null ? '—' : spendingShare > 1 ? '>100%' : `${Math.round(Math.max(0, spendingShare) * 100)}%`;
  const trendChartWidth = Math.max(240, width - 64);

  return (
    <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950" edges={['left', 'right', 'bottom']}>
      <GlobalHeader title="Insights" description="See the patterns behind your money" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 36 }} showsVerticalScrollIndicator={false}>
        <View className="mb-4">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {INSIGHTS_PERIODS.map((item) => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: period === item }} onPress={() => { setPeriod(item); setSelectedMonth(null); }} className={`min-h-10 justify-center px-3 ${period === item ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs font-semibold ${period === item ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>{item}</Text></Pressable>)}
          </ScrollView>
          {period === 'Custom' ? <>
            <View className="mt-3 flex-row">
              <View className="mr-2 flex-1"><DatePickerField label="Start date" value={customStartDate} maxDate={parseDateKey(customEndDate) ?? new Date()} onChangeText={setCustomStartDate} /></View>
              <View className="flex-1"><DatePickerField label="End date" value={customEndDate} minDate={parseDateKey(customStartDate)} maxDate={new Date()} onChangeText={setCustomEndDate} /></View>
            </View>
            {dataQuery.customRangeError ? <Text accessibilityLiveRegion="polite" className="-mt-2 mb-2 font-body text-xs text-rose-700 dark:text-rose-300">{dataQuery.customRangeError}</Text> : null}
          </> : null}
          {data && data.currencies.length > 1 ? <ScrollView horizontal className="mt-2" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{data.currencies.map((currency) => <Pressable key={currency} accessibilityRole="button" accessibilityState={{ selected: data.currency === currency }} onPress={() => setCurrencyPreference(currency)} className={`min-h-9 justify-center px-3 ${data.currency === currency ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs font-semibold ${data.currency === currency ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>{currency}</Text></Pressable>)}</ScrollView> : null}
        </View>

        <ScrollView accessibilityRole="tablist" horizontal showsHorizontalScrollIndicator={false} className="mb-3" contentContainerStyle={{ gap: 8 }}>
          {([
            ['review', 'Review'], ['overview', 'Overview'], ['income', 'Income statement'], ['cashflow', 'Cash flow'], ['balance', 'Balance sheet'],
          ] as const).map(([key, label]) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: reportView === key }} onPress={() => setReportView(key)} className={`min-h-10 shrink-0 items-center justify-center px-3 ${reportView === key ? BADGE_PRIMARY : BADGE_NEUTRAL}`}><Text className={`font-body text-xs font-semibold ${reportView === key ? BADGE_PRIMARY_TEXT : BADGE_NEUTRAL_TEXT}`}>{label}</Text></Pressable>)}
        </ScrollView>

          {dataQuery.customRangeError ? <Card><Empty text="Choose a valid date range to load this report." /></Card> : dataQuery.isLoading ? <View accessibilityLabel="Loading financial insights" className="gap-3">{[0, 1, 2].map((item) => <View key={item} className="mb-2 h-32 border border-gray-100 bg-white dark:border-neutral-800 dark:bg-neutral-900" />)}<ActivityIndicator color={PRIMARY_COLOR} /></View> : dataQuery.isError ? <Card className="items-center py-8"><RefreshCw size={22} color={PRIMARY_COLOR} /><Text className="mt-3 font-heading font-semibold text-gray-900 dark:text-white">Insights could not be loaded</Text><Text className="mt-1 text-center font-body text-sm text-gray-500 dark:text-neutral-400">{dataQuery.error instanceof Error ? dataQuery.error.message : 'Your saved records are unchanged.'}</Text><Pressable accessibilityRole="button" onPress={() => void dataQuery.refetch()} className="houselog-button mt-4 px-5 py-3"><Text className="font-body font-semibold text-white">Retry</Text></Pressable></Card> : data ? <>
          <Text className="mb-2 font-body text-[11px] text-gray-500 dark:text-neutral-400">{periodLabel} · {data.currency} only · {data.excludedCurrencies.length ? `excludes ${data.excludedCurrencies.join(', ')}` : 'no other recorded currencies excluded'}</Text>

          {reportView === 'review' ? <>
            <Card>
              <SectionTitle title="Money review" hint={`${periodLabel} · ${data.currency}. A quick summary of what came in, what went out, and what may need a look.`} />
              <View className={`mb-3 rounded-md border p-4 ${data.report.netMinor >= 0 ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30' : 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30'}`}>
                <Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">{data.report.netMinor >= 0 ? 'Income left after recorded spending' : 'Spending above recorded income'}</Text>
                <Money amount={data.report.netMinor} currency={data.currency} color={data.report.netMinor >= 0 ? GREEN : '#DC4C4C'} className="mt-1 text-2xl" />
                <Text className="mt-1 font-body text-xs leading-5 text-gray-600 dark:text-neutral-300">This is a period total, not your current account balance or a forecast.</Text>
              </View>
              <View className="flex-row gap-3">
                <View className="min-w-0 flex-1 rounded-md bg-emerald-50 p-3 dark:bg-emerald-950/30"><Text className="font-body text-xs font-medium text-gray-600 dark:text-neutral-300">Money in</Text><Money amount={data.report.incomeMinor} currency={data.currency} color={GREEN} className="mt-1 text-base" /></View>
                <View className="min-w-0 flex-1 rounded-md bg-orange-50 p-3 dark:bg-orange-950/30"><Text className="font-body text-xs font-medium text-gray-600 dark:text-neutral-300">Spending after refunds</Text><Money amount={data.report.expenseMinor} currency={data.currency} color={ORANGE} className="mt-1 text-base" /></View>
              </View>
            </Card>

            <Card>
              <SectionTitle title="Compared with the previous period" hint="A simple change in recorded income and spending. No comparison appears when there is no usable earlier activity." />
              <ReviewChange label="Income" value={data.incomeChangePercent} detail="More income is shown as up." />
              <View className="my-2 border-t border-gray-100 dark:border-neutral-800" />
              <ReviewChange label="Spending" value={data.expenseChangePercent} detail="More spending is shown as up." />
              {categoryIncrease ? <View className="mt-3 rounded-md bg-orange-50 p-3 dark:bg-orange-950/30"><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">Biggest category increase</Text><Text className="mt-1 font-body text-xs text-gray-600 dark:text-neutral-300">{CLASSIFICATIONS[categoryIncrease.category as keyof typeof CLASSIFICATIONS]?.label ?? categoryIncrease.category.replaceAll('_', ' ')} · up {formatMinorUnits(categoryIncrease.amountMinor, data.currency)} from the previous period.</Text></View> : null}
            </Card>

            {data.report.netMinor < 0 ? <ReviewNotice title="Spending was higher than income" detail={`The difference is ${formatMinorUnits(Math.abs(data.report.netMinor), data.currency)} for this period. Check the transactions and categories to see what drove it.`} action="Review transactions" onPress={() => goTransactions({ currency: data.currency, startDate: data.currentRange.startDate.slice(0, 10), endDate: data.currentRange.endDate.slice(0, 10) })} tone="red" /> : null}
            {data.expenseChangePercent !== null && data.expenseChangePercent >= 15 ? <ReviewNotice title="Spending increased" detail={`Recorded spending is up ${data.expenseChangePercent.toFixed(0)}% versus the previous period. Check whether this came from one category or several.`} action="See spending" onPress={() => goTransactions({ currency: data.currency, startDate: data.currentRange.startDate.slice(0, 10), endDate: data.currentRange.endDate.slice(0, 10) })} tone="orange" /> : null}

            {data.budgets.some((item) => item.remainingMinor < 0) ? <Card>
              <SectionTitle title="Budget limits to check" hint="These categories have recorded spending above their budget for the selected period." />
              {data.budgets.filter((item) => item.remainingMinor < 0).map((item) => <View key={item.category} className="mb-2 flex-row items-center justify-between gap-3"><Text className="flex-1 font-body text-sm text-gray-700 dark:text-neutral-200">{CLASSIFICATIONS[item.category as keyof typeof CLASSIFICATIONS]?.label ?? item.category.replaceAll('_', ' ')}</Text><Money amount={Math.abs(item.remainingMinor)} currency={data.currency} color="#DC4C4C" className="text-sm" /></View>)}
              <Pressable accessibilityRole="link" onPress={() => router.push('/budgets')} className="mt-2 self-start border-b border-primary pb-0.5"><Text className="font-body text-xs font-semibold text-primary">Review budgets</Text></Pressable>
            </Card> : null}

            {period === 'This month' && data.currentMonthBudgets.length === 0 ? <ReviewNotice title="No monthly budget is set" detail="Add limits for the categories you want to keep an eye on. You can change them any time." action="Set a budget" onPress={() => router.push('/budgets')} tone="primary" /> : null}
            {data.report.netMinor > 0 ? <ReviewNotice title="You have a period surplus" detail="If some of this money is meant for a goal, you can reserve it on the Savings page. This summary does not move money." action="View savings" onPress={() => router.push('/savings')} tone="primary" /> : null}

            <Card>
              <SectionTitle title="Coming up" hint={`Known bills and schedule reminders in ${data.currency}. These are reminders, not automatic payments.`} />
              {data.bills.length === 0 && data.scheduledItems.length === 0 ? <Empty text="No upcoming bills or active schedule reminders are recorded." /> : <>
                {data.bills.map((bill) => <View key={`bill-${bill.id}`} className="mb-3 flex-row items-center justify-between gap-3"><View className="min-w-0 flex-1"><Text numberOfLines={1} className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{bill.name}</Text><Text className="mt-0.5 font-body text-xs capitalize text-gray-500 dark:text-neutral-400">Bill · {bill.status} · {formatDateOnly(bill.dueDate)}</Text></View><Money amount={Math.max(0, bill.amountMinor - bill.paidMinor)} currency={bill.currency} className="text-sm" /></View>)}
                {data.scheduledItems.map((item) => <View key={`schedule-${item.id}`} className="mb-3 flex-row items-center justify-between gap-3"><View className="min-w-0 flex-1"><Text numberOfLines={1} className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{item.name}</Text><Text className="mt-0.5 font-body text-xs capitalize text-gray-500 dark:text-neutral-400">{item.scheduleType} reminder · {formatDateOnly(item.nextDueDate)}</Text></View><Money amount={item.amountMinor} currency={item.currency} className="text-sm" /></View>)}
              </>}
              <Text className="mt-1 font-body text-[11px] leading-4 text-gray-500 dark:text-neutral-400">Leverage does not charge your bank or wallet. Record a payment only after it actually happens.</Text>
              <Pressable accessibilityRole="link" onPress={() => router.push('/obligations')} className="mt-3 self-start border-b border-primary pb-0.5"><Text className="font-body text-xs font-semibold text-primary">Manage bills and reminders</Text></Pressable>
            </Card>

            <Text className="mb-3 font-body text-[11px] leading-4 text-gray-500 dark:text-neutral-400">This review uses records you entered, in one currency at a time. It is a spending summary, not personalized investment or borrowing advice.</Text>
          </> : null}

          {reportView === 'overview' ? <>
          <Card>
            <View className="mb-4 flex-row items-start justify-between">
              <SectionHeading title="Your money at a glance" description={`${periodLabel} · ${data.currency}`} size="compact" className="flex-1" />
              <View className={`rounded-full px-2.5 py-1 ${BADGE_PRIMARY}`}><Text className={`font-body text-[10px] font-bold ${BADGE_PRIMARY_TEXT}`}>OVERVIEW</Text></View>
            </View>
            <View className="flex-row gap-3">
              <View className="min-w-0 flex-1 rounded-md border border-emerald-100 bg-emerald-50 p-3 dark:border-emerald-900/70 dark:bg-emerald-950/40">
                <View className="mb-2 flex-row items-center"><View className="mr-2 h-2 w-2 rounded-full bg-emerald-600"/><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Money in</Text></View>
                <Money amount={data.report.incomeMinor} currency={data.currency} color={GREEN} className="text-lg" />
                <View className="mt-3 h-1.5 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-900/70"><View className="h-full rounded-full bg-emerald-600" style={{ width: `${safeRatio(Math.max(0, data.report.incomeMinor), activityScale) * 100}%` }}/></View>
                <Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">Recorded receipts</Text>
              </View>
              <View className="min-w-0 flex-1 rounded-md border border-orange-100 bg-orange-50 p-3 dark:border-orange-900/70 dark:bg-orange-950/30">
                <View className="mb-2 flex-row items-center"><View className="mr-2 h-2 w-2 rounded-full bg-orange-500"/><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Money out</Text></View>
                <Money amount={data.report.expenseMinor} currency={data.currency} color={ORANGE} className="text-lg" />
                <View className="mt-3 h-1.5 overflow-hidden rounded-full bg-orange-100 dark:bg-orange-900/60"><View className="h-full rounded-full bg-orange-500" style={{ width: `${safeRatio(Math.max(0, data.report.expenseMinor), activityScale) * 100}%` }}/></View>
                <Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">Spending after refunds</Text>
              </View>
            </View>
            <View className={`mt-3 flex-row items-center rounded-md border p-4 ${data.report.netMinor >= 0 ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30' : 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30'}`}>
              <View className="mr-3 flex-1">
                <View className="mb-1.5 flex-row items-center">
                  <View className={`mr-2 h-7 w-7 items-center justify-center rounded-full ${data.report.netMinor >= 0 ? 'bg-emerald-100 dark:bg-emerald-900/60' : 'bg-red-100 dark:bg-red-900/60'}`}>
                    {data.report.netMinor >= 0 ? <TrendingUp size={15} color={GREEN} /> : <TrendingDown size={15} color="#DC4C4C" />}
                  </View>
                  <Text className="font-body text-xs font-bold text-gray-700 dark:text-neutral-200">{data.report.netMinor >= 0 ? 'Surplus' : 'Shortfall'}</Text>
                </View>
                <Money amount={data.report.netMinor} currency={data.currency} color={data.report.netMinor >= 0 ? GREEN : '#DC4C4C'} className="text-2xl" />
                <Text className="mt-1 font-body text-xs text-gray-600 dark:text-neutral-300">{data.report.netMinor >= 0 ? 'You recorded more money in than spending.' : 'You recorded more spending than money in.'}</Text>
              </View>
              <View accessibilityRole="image" accessibilityLabel={spendingShare === null ? 'No receipts recorded to compare with spending.' : `${spendingShareLabel} of recorded receipts used for spending.`} className="h-[68px] w-[68px] items-center justify-center">
                <Svg width={68} height={68} viewBox="0 0 68 68">
                  <Circle cx={34} cy={34} r={27} fill="none" stroke={dark ? '#404040' : '#E5E7EB'} strokeWidth={7} />
                  <Circle cx={34} cy={34} r={27} fill="none" stroke={spendingShare !== null && spendingShare > 1 ? '#DC4C4C' : ORANGE} strokeWidth={7} strokeDasharray={`${2 * Math.PI * 27}`} strokeDashoffset={`${2 * Math.PI * 27 * (1 - Math.min(1, Math.max(0, spendingShare ?? 0)))}`} strokeLinecap="round" transform="rotate(-90 34 34)" />
                </Svg>
                <Text className="absolute font-heading text-xs font-bold text-gray-800 dark:text-white">{spendingShareLabel}</Text>
              </View>
            </View>
            <Text className="mt-2 text-right font-body text-[10px] text-gray-500 dark:text-neutral-400">{spendingShare === null ? 'No receipts to compare' : data.report.expenseMinor < 0 ? 'Refunds exceeded spending' : 'of receipts spent'}</Text>
            <View className="mt-3 flex-row gap-3">
              <View className="min-w-0 flex-1 rounded-md bg-sky-50 p-3 dark:bg-sky-950/30"><Text className="font-body text-[11px] font-medium text-gray-600 dark:text-neutral-300">Not set aside · {data.currency}</Text><Money amount={selectedLiquidity?.availableMinor ?? 0} currency={data.currency} color="#2D8CFF" className="mt-1 text-base"/><Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">Cash {formatMinorUnits(selectedLiquidity?.physicalCashAvailableMinor ?? 0, data.currency)} · Bank/mobile {formatMinorUnits(selectedLiquidity?.bankAndMobileAvailableMinor ?? 0, data.currency)}. Bills aren’t deducted.</Text></View>
              <View className="min-w-0 flex-1 rounded-md bg-violet-50 p-3 dark:bg-violet-950/30"><Text className="font-body text-[11px] font-medium text-gray-600 dark:text-neutral-300">Known net worth · {data.currency}</Text>{selectedNetWorth ? <Money amount={selectedNetWorth.netWorthMinor} currency={data.currency} color="#7C4DCE" className="mt-1 text-base"/> : <Text className="mt-1 font-heading text-base font-bold text-gray-500 dark:text-neutral-400">—</Text>}<Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">Uses your saved asset values</Text></View>
            </View>
            <View className="mt-4 flex-row flex-wrap gap-y-3 border-t border-gray-100 pt-3 dark:border-neutral-800">
              <View className="w-1/2 pr-2"><Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">Average spending per day after refunds</Text><Text className="mt-1 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(data.dailyAverageMinor, data.currency)}</Text></View>
              <View className="w-1/2 pl-2"><Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">Expense transactions</Text><Text className="mt-1 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{data.report.expenseCount}</Text></View>
              <View className="w-full"><Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">Compared with previous period</Text><Text className="mt-1 font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">Money in {data.incomeChangePercent === null ? '—' : `${data.incomeChangePercent >= 0 ? '+' : ''}${data.incomeChangePercent.toFixed(0)}%`} · Spending {data.expenseChangePercent === null ? '—' : `${data.expenseChangePercent >= 0 ? '+' : ''}${data.expenseChangePercent.toFixed(0)}%`}</Text></View>
            </View>
            <Text className="mt-3 font-body text-[10px] leading-4 text-gray-500 dark:text-neutral-400">Money moved between your accounts, starting balances, loan amounts and asset purchases aren’t counted as money in or spending. Refunds reduce spending. Other currencies stay separate.</Text>
          </Card>

          {data.monthReportRows.some((point) => point.incomeMinor !== 0 || point.expenseMinor !== 0) ? <Card>
            <SectionTitle title="Money in vs spending" hint="Compare receipts and spending by month. Longer bars mean larger amounts." />
            {selectedPoint ? <Pressable accessibilityRole="button" onPress={() => goTransactions({ currency: data.currency, startDate: selectedPoint.startDate, endDate: selectedPoint.endDate })} className="mb-3 flex-row items-center justify-between border-l-2 border-primary pl-3"><View><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{selectedPoint.label} · tap to view transactions</Text><Text className="mt-1 font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">In {formatMinorUnits(selectedPoint.incomeMinor, data.currency)} · Out {formatMinorUnits(selectedPoint.expenseMinor, data.currency)}</Text></View><ArrowUpRight size={16} color={PRIMARY_COLOR} /></Pressable> : null}
            <View accessibilityRole="image" accessibilityLabel={`Monthly comparison of money received and spending in ${data.currency}.`}>
              {data.monthReportRows.map((point) => <Pressable key={point.id} accessibilityRole="button" accessibilityLabel={`${point.label}: money received ${formatMinorUnits(point.incomeMinor, data.currency)}, spending ${formatMinorUnits(point.expenseMinor, data.currency)}. Select month.`} accessibilityState={{ selected: selectedPoint?.id === point.id }} onPress={() => setSelectedMonth(point.id)} className={`mb-3 rounded-xl px-3 py-2 ${selectedPoint?.id === point.id ? 'bg-primary/5 dark:bg-primary/10' : ''}`}>
                <View className="mb-2 flex-row items-center justify-between"><Text className="font-body text-xs font-bold text-gray-800 dark:text-neutral-100">{point.label}</Text><Text className="font-body text-[10px] text-gray-500 dark:text-neutral-400">{point.incomeMinor - point.expenseMinor >= 0 ? 'Surplus' : 'Shortfall'} {formatMinorUnits(Math.abs(point.incomeMinor - point.expenseMinor), data.currency)}</Text></View>
                <View className="mb-1.5 flex-row items-center"><Text className="w-11 font-body text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">In</Text><View className="mr-2 h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className="h-full rounded-full" style={{ width: `${safeRatio(point.incomeMinor, monthlyMax) * 100}%`, backgroundColor: GREEN }} /></View><Text numberOfLines={1} className="w-[82px] text-right font-body text-[10px] font-semibold text-gray-700 dark:text-neutral-200">{formatMinorUnits(point.incomeMinor, data.currency)}</Text></View>
                <View className="flex-row items-center"><Text className="w-11 font-body text-[10px] font-semibold text-orange-700 dark:text-orange-300">Out</Text><View className="mr-2 h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className="h-full rounded-full" style={{ width: `${safeRatio(point.expenseMinor, monthlyMax) * 100}%`, backgroundColor: ORANGE }} /></View><Text numberOfLines={1} className="w-[82px] text-right font-body text-[10px] font-semibold text-gray-700 dark:text-neutral-200">{formatMinorUnits(point.expenseMinor, data.currency)}</Text></View>
              </Pressable>)}
            </View>
            <View className="mt-1 flex-row justify-center gap-5"><Legend color={GREEN} label="Income" /><Legend color={ORANGE} label="Expenses" /></View>
          </Card> : <Card><SectionTitle title="Money in vs spending" hint="Monthly totals for the selected period" /><Empty text="No money-in or spending activity recorded for this period." /></Card>}

          <Card>
            <SectionTitle title="Spending by category" hint="Category spending after refunds are applied" />
            {data.categories.length === 0 ? <Empty text="No ordinary expenses recorded in this period." /> : <>
              {pieData.length > 0 ? <View accessible accessibilityRole="image" accessibilityLabel={`Category donut shows positive net category totals of ${formatMinorUnits(data.positiveCategoryTotalMinor, data.currency)}. Refund adjustments are listed separately.`} className="mb-3 items-center"><PieChart donut radius={90} innerRadius={64} data={pieData} centerLabelComponent={() => <View className="items-center"><Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">Positive category totals</Text><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{formatMinorUnits(data.positiveCategoryTotalMinor, data.currency)}</Text></View>} /></View> : null}
              {data.categories.map((category) => {
                const style = categoryStyle(category.category); const Icon = style.icon;
                const label = CLASSIFICATIONS[category.category as keyof typeof CLASSIFICATIONS]?.label ?? category.category.replaceAll('_', ' ');
                const share = category.amountMinor > 0 && data.positiveCategoryTotalMinor > 0 ? category.amountMinor / data.positiveCategoryTotalMinor : 0;
                return <Pressable key={category.category} accessibilityRole="button" accessibilityLabel={`Show ${label} transactions, ${formatMinorUnits(category.amountMinor, data.currency)}`} onPress={() => goTransactions({ categoryId: category.category, currency: data.currency, startDate: data.currentRange.startDate, endDate: data.currentRange.endDate })} className="mb-3 flex-row items-center"><View className="mr-3 h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: `${style.color}24` }}><Icon size={17} color={style.color} /></View><View className="mr-3 flex-1"><Text className="font-body text-sm font-semibold capitalize text-gray-800 dark:text-neutral-100" numberOfLines={1}>{label}</Text><View className="mt-1.5 h-2 overflow-hidden rounded-full" style={{ backgroundColor: dark ? `${style.color}30` : `${style.color}20` }}><View className="h-full rounded-full" style={{ width: `${share * 100}%`, backgroundColor: style.color }} /></View></View><View className="items-end"><Text className="font-body text-sm font-bold" style={{ color: category.amountMinor < 0 ? GREEN : style.color }}>{formatMinorUnits(category.amountMinor, data.currency)}</Text><Text className="font-body text-[10px] text-gray-500 dark:text-neutral-400">{category.amountMinor < 0 ? 'net refund' : `${(share * 100).toFixed(0)}%`}</Text></View></Pressable>;
              })}
              {data.categories.some((item) => item.amountMinor < 0) ? <Text className="mt-1 font-body text-xs leading-4 text-gray-500 dark:text-neutral-400">A refund can bring a category below zero. The chart shows categories with spending left after refunds.</Text> : null}
            </>}
          </Card>

          {data.report.largestExpenses.length > 0 ? <Card>
            <SectionTitle title="Largest expenses" hint="Your largest expenses after linked refunds and corrections" />
            {data.report.largestExpenses.map((expense) => {
              const label = CLASSIFICATIONS[expense.category as keyof typeof CLASSIFICATIONS]?.label ?? expense.category.replaceAll('_', ' ');
              const dateLabel = new Date(transactionDateTimestamp(expense.date)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
              return <Pressable key={expense.id} accessibilityRole="button" accessibilityLabel={`View ${label} transactions for ${dateLabel}, ${formatMinorUnits(expense.amountMinor, data.currency)}`} onPress={() => goExpenseDay(expense)} className="mb-3 flex-row items-center justify-between rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-neutral-800">
                <View className="mr-3 min-w-0 flex-1"><Text numberOfLines={1} className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{expense.note.trim() || label}</Text><Text className="mt-0.5 font-body text-[10px] capitalize text-gray-500 dark:text-neutral-400">{label} · {dateLabel} · view day</Text></View>
                <Money amount={expense.amountMinor} currency={data.currency} color={ORANGE} className="text-sm" />
              </Pressable>;
            })}
          </Card> : null}

          {trendPoints.length > 0 && data.report.expenseMinor > 0 ? <Card>
            <SectionTitle title="Spending over time" hint={trendFrequency === 'day' ? 'The filled curve shows your net spending each day.' : 'The filled curve shows your net spending each month.'} />
            <SpendingAreaChart points={trendPoints} width={trendChartWidth} color={ORANGE} dark={dark} />
            {highestTrend ? <Text className="mt-1 font-body text-xs text-gray-600 dark:text-neutral-300">Peak {trendFrequency}: {highestTrend.label} · {formatMinorUnits(highestTrend.amountMinor, data.currency)}</Text> : null}
          </Card> : null}

          {data.incomeSources.length > 0 ? <Card>
            <SectionTitle title="Where money came from" hint="Receipts can include salary, gifts and other sources. This is not a tax calculation." />
            {data.incomeSources.map((source) => {
              const style = INCOME_STYLE[source.source] ?? { color: '#64748B', icon: CircleEllipsis }; const Icon = style.icon;
              const label = CLASSIFICATIONS[source.source as keyof typeof CLASSIFICATIONS]?.label ?? source.source.replaceAll('_', ' ');
              const share = safeRatio(source.amountMinor, data.report.incomeMinor);
              return <View key={source.source} className="mb-3 flex-row items-center"><View className="mr-3 h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: `${style.color}20` }}><Icon size={17} color={style.color} /></View><View className="mr-3 flex-1"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{label}</Text><View className="mt-1 h-1.5 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full" style={{ width: `${share * 100}%`, backgroundColor: style.color }} /></View></View><Text className="font-body text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(source.amountMinor, data.currency)}</Text></View>;
            })}
          </Card> : null}

          {data.budgets.length || data.activeGoals.length || data.emergency ? <Card>
            <SectionTitle title="Budgets & savings" hint="Compare spending with limits and track money set aside for goals." />
            {data.budgets.length ? data.budgets.slice(0, 4).map((budget) => { const ratio = safeRatio(budget.spentMinor, budget.allocatedMinor); const over = budget.remainingMinor < 0; return <View key={budget.category} className="mb-3"><View className="mb-1 flex-row justify-between"><Text className="font-body text-sm font-semibold capitalize text-gray-800 dark:text-neutral-100">{CLASSIFICATIONS[budget.category as keyof typeof CLASSIFICATIONS]?.label ?? budget.category}</Text><Text className={`font-body text-xs font-semibold ${over ? 'text-red-600' : 'text-gray-500 dark:text-neutral-400'}`}>{over ? `Over by ${formatMinorUnits(-budget.remainingMinor, data.currency)}` : `${formatMinorUnits(budget.remainingMinor, data.currency)} left`}</Text></View><View className="h-2 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full" style={{ width: `${ratio * 100}%`, backgroundColor: over ? '#DC4C4C' : PRIMARY_COLOR }} /></View><Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">{formatMinorUnits(budget.spentMinor, data.currency)} of {formatMinorUnits(budget.allocatedMinor, data.currency)}</Text></View>; }) : null}
            {data.activeGoals.length ? data.activeGoals.slice(0, 3).map((goal) => <View key={goal.id} className="mb-3"><View className="mb-1 flex-row justify-between"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{goal.name}</Text><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{goal.percent.toFixed(0)}%</Text></View><View className="h-2 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full bg-primary" style={{ width: `${safeRatio(goal.actualMinor, goal.targetMinor) * 100}%` }} /></View><Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">{formatMinorUnits(goal.actualMinor, data.currency)} of {formatMinorUnits(goal.targetMinor, data.currency)}</Text></View>) : null}
            {data.emergency ? <View className="mt-2 border-t border-gray-100 pt-3 dark:border-neutral-800"><View className="mb-1 flex-row justify-between"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Emergency fund · {data.emergency.currency}</Text><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{data.emergency.coverageMonthsActual.toFixed(1)} / {data.emergency.coverageMonths} months</Text></View><View className="h-2 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full bg-primary" style={{ width: `${safeRatio(data.emergency.allocatedMinor, data.emergency.requiredMinor) * 100}%` }} /></View><Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">{formatMinorUnits(data.emergency.allocatedMinor, data.emergency.currency)} set aside · {formatMinorUnits(data.emergency.remainingMinor, data.emergency.currency)} left to reach the target. Essential monthly costs: {formatMinorUnits(data.emergency.essentialMonthlyMinor, data.emergency.currency)}.</Text></View> : null}
            <Pressable accessibilityRole="link" onPress={() => router.push('/budgets')} className="mt-2 self-start border-b border-primary pb-0.5"><Text className="font-body text-xs font-semibold text-primary">Manage budgets and savings</Text></Pressable>
          </Card> : null}

          {data.liquidity.length || data.netWorth.length ? <Card>
            <SectionTitle title="Cash, accounts & net worth" hint="See physical cash separately from money in bank, savings and mobile-wallet accounts." />
            {data.liquidity.filter((position) => position.currency === data.currency).map((position) => <View key={`liq-${position.currency}`} className="mb-3"><View className="mb-2 flex-row items-center"><Wallet size={15} color="#2D8CFF" /><Text className="ml-2 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Liquid funds · {position.currency}</Text></View><View className="mb-2 flex-row justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Physical cash</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(position.physicalCashBalanceMinor, position.currency)} · available {formatMinorUnits(position.physicalCashAvailableMinor, position.currency)}</Text></View><View className="mb-2 flex-row justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Bank, mobile & savings</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(position.bankAndMobileBalanceMinor, position.currency)} · available {formatMinorUnits(position.bankAndMobileAvailableMinor, position.currency)}</Text></View><View className="mt-2 border-t border-gray-100 pt-2 dark:border-neutral-800"><View className="flex-row justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Total liquid funds</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(position.currentBalanceMinor, position.currency)}</Text></View><View className="mt-1 flex-row justify-between"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Reserved · available total</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(position.reservedMinor, position.currency)} · {formatMinorUnits(position.availableMinor, position.currency)}</Text></View></View></View>)}
            {data.netWorth.map((position) => <View key={`nw-${position.currency}`} className="mb-3 border-t border-gray-100 pt-3 dark:border-neutral-800"><Text className="mb-2 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Net worth · {position.currency}</Text><View className="flex-row flex-wrap gap-y-2"><Position label="Assets" value={position.totalAssetsMinor} currency={position.currency} /><Position label="Liabilities" value={position.liabilitiesMinor} currency={position.currency} /><Position label="Net worth" value={position.netWorthMinor} currency={position.currency} strong /></View></View>)}
            {data.netWorth.filter((position) => position.currency === data.currency).map((position) => <View key={`mix-${position.currency}`} className="mb-2"><Text className="mb-2 font-body text-xs font-semibold text-gray-700 dark:text-neutral-200">Asset allocation · {position.currency}</Text><AssetComponent label="Cash and accounts" value={position.cashMinor} total={position.totalAssetsMinor} currency={position.currency} color="#2D8CFF" /><AssetComponent label="Investments" value={position.investmentsMinor} total={position.totalAssetsMinor} currency={position.currency} color="#8B5CF6" /><AssetComponent label="Physical assets" value={position.physicalAssetsMinor} total={position.totalAssetsMinor} currency={position.currency} color="#E59A22" /><AssetComponent label="Receivables" value={position.receivablesMinor} total={position.totalAssetsMinor} currency={position.currency} color="#15966A" /></View>)}
            <Text className="mt-1 font-body text-[11px] leading-4 text-gray-500 dark:text-neutral-400">Net-worth history isn’t available yet. Current totals use your saved asset and investment values; {data.staleAssetValuations ? `${data.staleAssetValuations} asset value(s) are older than 180 days or have no date.` : 'some saved values may be out of date.'}</Text>
          </Card> : null}

          {(data.investments.marketValueMinor > 0 || data.investments.realizedGainMinor !== 0 || data.investments.unrealizedGainMinor !== 0 || data.investments.dividendsMinor > 0 || data.unpricedCurrencies.includes(data.currency) || data.debtPositions.some((item) => item.currency === data.currency) || data.bills.length) ? <Card>
            <SectionTitle title="Investments, debt & upcoming bills" hint="Investment purchases and loan amounts are not counted as everyday spending." />
            {data.investments.marketValueMinor > 0 || data.investmentPriceInfo.length ? <View className="mb-3"><View className="flex-row items-center"><ChartNoAxesCombined size={16} color="#7C4DCE" /><Text className="ml-2 font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">Recorded investment value</Text></View><Money amount={data.investments.marketValueMinor} currency={data.currency} color="#7C4DCE" /><Text className="mt-1 font-body text-xs text-gray-500 dark:text-neutral-400">Realized {formatMinorUnits(data.investments.realizedGainMinor, data.currency)} · unrealized {formatMinorUnits(data.investments.unrealizedGainMinor, data.currency)} · dividends {formatMinorUnits(data.investments.dividendsMinor, data.currency)}{data.unpricedCurrencies.includes(data.currency) ? ' · some holdings lack a saved price' : ''}</Text>{data.investmentPriceInfo.map((price, index) => <Text key={`${price.date ?? 'no-date'}-${index}`} className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">Price {price.date ? new Date(price.date).toLocaleDateString() : 'not recorded'} · {price.source ?? 'source unavailable'}{price.stale ? ' · stale (>180 days)' : ''}</Text>)}</View> : null}
            {data.debtPositions.filter((item) => item.currency === data.currency).map((debt) => <View key={`debt-${debt.currency}`} className="mb-2 flex-row items-center justify-between"><View className="flex-row items-center"><CreditCard size={16} color="#DC4C4C" /><Text className="ml-2 font-body text-sm text-gray-700 dark:text-neutral-200">Debt outstanding · {debt.currency}</Text></View><Text className="font-body text-sm font-bold text-gray-900 dark:text-white">{formatMinorUnits(debt.liabilitiesMinor, debt.currency)}</Text></View>)}
            {data.bills.map((bill) => <View key={bill.id} className="mb-2 flex-row justify-between"><Text className="flex-1 font-body text-xs text-gray-700 dark:text-neutral-200" numberOfLines={1}>{bill.name} · {bill.status}</Text><Text className="ml-2 font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(bill.amountMinor, bill.currency)}</Text></View>)}
            <Pressable accessibilityRole="link" onPress={() => router.push('/obligations')} className="mt-2 self-start border-b border-primary pb-0.5"><Text className="font-body text-xs font-semibold text-primary">View assets and obligations</Text></Pressable>
          </Card> : null}
          </> : null}

          {reportView === 'income' ? <>
            <Card>
              <SectionTitle title="Income statement" hint={`${periodLabel} · ${data.currency}. A cash-basis summary of recorded income and everyday spending.`} />
              <StatementLine label="Income received" value={data.report.incomeMinor} currency={data.currency} color={GREEN} />
              <StatementLine label="Spending after refunds" value={-data.report.expenseMinor} currency={data.currency} color={ORANGE} />
              <View className="my-2 border-t border-gray-100 dark:border-neutral-800" />
              <StatementLine label={data.report.netMinor >= 0 ? 'Surplus' : 'Shortfall'} value={data.report.netMinor} currency={data.currency} color={data.report.netMinor >= 0 ? GREEN : '#DC4C4C'} strong />
              <Text className="mt-3 font-body text-xs leading-5 text-gray-500 dark:text-neutral-400">Transfers between your accounts, starting balances, borrowed or repaid principal, and asset or investment purchases are excluded. They change balances but are not income or everyday spending.</Text>
            </Card>
            <Card>
              <SectionTitle title="Income sources" hint="Where recorded income came from during this period." />
              {data.incomeSources.length ? data.incomeSources.map((item) => <StatementLine key={item.source} label={CLASSIFICATIONS[item.source as keyof typeof CLASSIFICATIONS]?.label ?? item.source.replaceAll('_', ' ')} value={item.amountMinor} currency={data.currency} color={GREEN} />) : <Empty text="No income was recorded for this period." />}
            </Card>
            <Card>
              <SectionTitle title="Spending categories" hint="Net spending after refunds and corrections." />
              {data.categories.length ? data.categories.map((item) => <StatementLine key={item.category} label={CLASSIFICATIONS[item.category as keyof typeof CLASSIFICATIONS]?.label ?? item.category.replaceAll('_', ' ')} value={-item.amountMinor} currency={data.currency} color={item.amountMinor < 0 ? GREEN : ORANGE} />) : <Empty text="No everyday spending was recorded for this period." />}
            </Card>
          </> : null}

          {reportView === 'cashflow' ? <>
            <Card>
              <SectionTitle title="Cash flow" hint={`${periodLabel} · ${data.currency}. Money entering and leaving your recorded accounts.`} />
              <View className={`mb-3 rounded-md p-4 ${cashFlowNetMinor !== null && cashFlowNetMinor >= 0 ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'bg-red-50 dark:bg-red-950/30'}`}>
                <Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Net cash movement</Text>
                {cashFlowNetMinor === null ? <Text className="mt-1 font-heading text-xl font-bold text-gray-900 dark:text-white">Outside supported range</Text> : <Money amount={cashFlowNetMinor} currency={data.currency} color={cashFlowNetMinor >= 0 ? GREEN : '#DC4C4C'} className="mt-1 text-2xl" />}
                <Text className="mt-1 font-body text-xs text-gray-500 dark:text-neutral-400">All three sections combined, in this currency.</Text>
              </View>
              {cashFlowSections.map((section) => <View key={section.section} className="mb-3 border-t border-gray-100 pt-3 dark:border-neutral-800">
                <View className="mb-2 flex-row items-center justify-between"><Text className="font-heading text-sm font-bold capitalize text-gray-900 dark:text-white">{section.section}</Text><Money amount={section.netMinor} currency={data.currency} color={section.netMinor >= 0 ? GREEN : '#DC4C4C'} className="text-sm" /></View>
                <StatementLine label="Money in" value={section.inflowsMinor} currency={data.currency} color={GREEN} />
                <StatementLine label="Money out" value={-section.outflowsMinor} currency={data.currency} color={ORANGE} />
              </View>)}
              <Text className="mt-1 font-body text-xs leading-5 text-gray-500 dark:text-neutral-400">Operating covers income and everyday costs. Investing covers asset and investment purchases or proceeds. Financing covers borrowing, lending, and principal repayments. Transfers between your own accounts are excluded; currencies are never combined.</Text>
            </Card>
          </> : null}

          {reportView === 'balance' ? <>
            <Card>
              <SectionTitle title="Balance sheet" hint={`Your recorded financial position as of ${new Date(data.asOf).toLocaleDateString()}. This is a current snapshot, not a historical statement.`} />
              {selectedNetWorth ? <>
                <View className="mb-3 rounded-md bg-violet-50 p-4 dark:bg-violet-950/30"><Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Net worth · {data.currency}</Text><Money amount={selectedNetWorth.netWorthMinor} currency={data.currency} color="#7C4DCE" className="mt-1 text-2xl" /><Text className="mt-1 font-body text-xs text-gray-500 dark:text-neutral-400">Assets minus liabilities</Text></View>
                <SectionTitle title="Assets" />
                <StatementLine label="Cash and account balances" value={selectedNetWorth.cashMinor} currency={data.currency} color="#2D8CFF" />
                <StatementLine label="Investments at saved prices" value={selectedNetWorth.investmentsMinor} currency={data.currency} color="#7C4DCE" />
                <StatementLine label="Your share of physical assets" value={selectedNetWorth.physicalAssetsMinor} currency={data.currency} color="#D99028" />
                <StatementLine label="Money owed to you" value={selectedNetWorth.receivablesMinor} currency={data.currency} color={GREEN} />
                <View className="my-2 border-t border-gray-100 dark:border-neutral-800" />
                <StatementLine label="Total assets" value={selectedNetWorth.totalAssetsMinor} currency={data.currency} color="#2D8CFF" strong />
                <SectionTitle title="Liabilities" />
                <StatementLine label="Outstanding debts" value={-selectedNetWorth.liabilitiesMinor} currency={data.currency} color="#DC4C4C" />
              </> : <Empty text={`No balance sheet data is available for ${data.currency}.`} />}
              <Text className="mt-3 font-body text-xs leading-5 text-gray-500 dark:text-neutral-400">Account balances use your saved ledger. Asset and investment values are estimates you entered and may be out of date. Savings goals are not added again because reserved money is already part of account balances. Each currency has its own statement.</Text>
              {data.staleAssetValuations > 0 || data.investmentPriceInfo.some((price) => price.stale) ? <Text className="mt-2 font-body text-xs font-semibold text-orange-700 dark:text-orange-300">Some asset or investment values are older than 180 days. Update them for a more current estimate.</Text> : null}
            </Card>
          </> : null}
        </> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Legend({ color, label }: { color: string; label: string }) { return <View className="flex-row items-center"><View className="mr-1.5 h-2.5 w-2.5" style={{ backgroundColor: color }} /><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{label}</Text></View>; }
function Empty({ text }: { text: string }) { return <Text className="py-3 font-body text-sm text-gray-500 dark:text-neutral-400">{text}</Text>; }
function ReviewChange({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  const trend = value === null ? 'No comparison' : `${value >= 0 ? '↑' : '↓'} ${Math.abs(value).toFixed(0)}%`;
  return <View className="flex-row items-center justify-between gap-3"><View className="min-w-0 flex-1"><Text className="font-body text-sm font-semibold text-gray-800 dark:text-neutral-100">{label}</Text><Text className="mt-0.5 font-body text-[11px] text-gray-500 dark:text-neutral-400">{detail}</Text></View><Text className="font-heading text-sm font-bold text-gray-800 dark:text-neutral-100">{trend}</Text></View>;
}
function ReviewNotice({ title, detail, action, onPress, tone }: { title: string; detail: string; action: string; onPress: () => void; tone: 'red' | 'orange' | 'primary' }) {
  const toneClass = tone === 'red' ? 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30' : tone === 'orange' ? 'border-orange-200 bg-orange-50 dark:border-orange-900/60 dark:bg-orange-950/30' : 'border-primary/20 bg-primary/5 dark:border-primary/30 dark:bg-primary/10';
  return <Card className={toneClass}><Text className="font-heading text-sm font-bold text-gray-900 dark:text-white">{title}</Text><Text className="mt-1 font-body text-xs leading-5 text-gray-600 dark:text-neutral-300">{detail}</Text><Pressable accessibilityRole="link" onPress={onPress} className="mt-3 self-start border-b border-primary pb-0.5"><Text className="font-body text-xs font-semibold text-primary">{action}</Text></Pressable></Card>;
}
function formatDateOnly(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function StatementLine({ label, value, currency, color, strong = false }: { label: string; value: number; currency: string; color: string; strong?: boolean }) { return <View className="mb-2 flex-row items-center justify-between gap-3"><Text className={`flex-1 font-body ${strong ? 'text-sm font-bold text-gray-900 dark:text-white' : 'text-xs text-gray-600 dark:text-neutral-300'}`}>{label}</Text><Money amount={value} currency={currency} color={color} className={strong ? 'text-base' : 'text-sm'} /></View>; }
function Position({ label, value, currency, strong = false }: { label: string; value: number; currency: string; strong?: boolean }) { return <View className="w-1/3 pr-1"><Text className="font-body text-[10px] text-gray-500 dark:text-neutral-400">{label}</Text><Text className={`mt-0.5 font-body ${strong ? 'text-sm font-bold text-primary' : 'text-xs font-semibold text-gray-800 dark:text-neutral-100'}`}>{formatMinorUnits(value, currency)}</Text></View>; }
function AssetComponent({ label, value, total, currency, color }: { label: string; value: number; total: number; currency: string; color: string }) { return <View className="mb-2"><View className="mb-1 flex-row justify-between"><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{label}</Text><Text className="font-body text-xs font-semibold text-gray-800 dark:text-neutral-100">{formatMinorUnits(value, currency)}</Text></View><View className="h-1.5 overflow-hidden bg-gray-100 dark:bg-neutral-800"><View className="h-full" style={{ width: `${value > 0 ? safeRatio(value, total) * 100 : 0}%`, backgroundColor: color }} /></View></View>; }

function SpendingAreaChart({ points, width, color, dark }: { points: { id: string; label: string; amountMinor: number }[]; width: number; color: string; dark: boolean }) {
  const height = 142;
  const left = 8;
  const right = 8;
  const top = 10;
  const bottom = 112;
  const values = points.map((point) => point.amountMinor);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(1, ...values);
  const valueRange = maxValue - minValue || 1;
  const xAt = (index: number) => points.length < 2 ? (width - left - right) / 2 + left : left + (index / (points.length - 1)) * (width - left - right);
  const yAt = (value: number) => top + ((maxValue - value) / valueRange) * (bottom - top);
  const coordinates = points.map((point, index) => ({ x: xAt(index), y: yAt(point.amountMinor), point }));
  const baseline = yAt(0);
  const linePath = coordinates.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
  const areaPath = coordinates.length ? `${linePath} L ${coordinates.at(-1)!.x} ${baseline} L ${coordinates[0]!.x} ${baseline} Z` : '';
  const tickIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const peakIndex = values.reduce((peak, value, index) => value > values[peak]! ? index : peak, 0);
  const gridColor = dark ? '#353535' : '#E9ECF2';
  const labelColor = dark ? '#A3A3A3' : '#737987';

  return <View accessible accessibilityRole="image" accessibilityLabel="Area chart of net daily or monthly spending. Dips below the baseline represent net refunds.">
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {[0, 0.5, 1].map((fraction) => {
        const y = top + fraction * (bottom - top);
        return <Line key={fraction} x1={left} x2={width - right} y1={y} y2={y} stroke={gridColor} strokeWidth={1} />;
      })}
      {minValue < 0 ? <Line x1={left} x2={width - right} y1={baseline} y2={baseline} stroke={dark ? '#A3A3A3' : '#737987'} strokeDasharray="3 4" strokeWidth={1.2} /> : null}
      {areaPath ? <Path d={areaPath} fill={color} fillOpacity={dark ? 0.22 : 0.14} /> : null}
      {linePath ? <Path d={linePath} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
      {coordinates[peakIndex] ? <Circle cx={coordinates[peakIndex]!.x} cy={coordinates[peakIndex]!.y} r={4} fill={color} stroke={dark ? '#171717' : '#FFFFFF'} strokeWidth={2} /> : null}
      {tickIndices.map((index) => <SvgText key={index} x={xAt(index)} y={height - 4} fill={labelColor} fontSize={10} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{points[index]!.label}</SvgText>)}
    </Svg>
    {minValue < 0 ? <Text className="mt-1 font-body text-[10px] text-gray-500 dark:text-neutral-400">The dashed line is zero; dips below it are net refunds.</Text> : null}
  </View>;
}
