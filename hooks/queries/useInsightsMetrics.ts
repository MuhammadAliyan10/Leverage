import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import { calculateFinancialReport, calculateFinancialBucketTotals, calculateSpendingByAccountTotals, type FinancialBucket } from '../../src/finance/reporting';
import { calculateDebtPositions } from '../../src/finance/debtPosition';
import { calculateNetWorthPositions } from '../../src/finance/assetsInvestments';
import { calculateLiquidityPositions } from '../../src/finance/liquidity';
import { calculateBudgetSnapshot } from '../../src/finance/budgeting';
import { getInsightsPeriodRanges, calendarDaysInRange, calculateDailyAverageMinor, calculatePeriodChangePercent, type CustomInsightsDates, type InsightsPeriod } from '../../src/finance/insights';

export interface InsightsMonthPoint { id: string; label: string; startDate: string; endDate: string; incomeMinor: number; expenseMinor: number }
export interface InsightsTrendPoint extends InsightsMonthPoint { group: 'day' | 'week' | 'month' }

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthRanges(start: Date, end: Date): FinancialBucket[] {
  const buckets: FinancialBucket[] = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor < end && buckets.length < 13) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const boundedStart = cursor < start ? start : cursor;
    const boundedEnd = next > end ? end : next;
    buckets.push({ id: `month:${cursor.getFullYear()}-${cursor.getMonth()}`, group: 'month', startDate: boundedStart.toISOString(), endDate: boundedEnd.toISOString() });
    cursor = next;
  }
  return buckets;
}

function safeMinor(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`${label} is outside the supported range.`);
  return Number(value);
}

export function useInsightsMetrics(period: InsightsPeriod, currencyPreference: string | null, customDates?: CustomInsightsDates) {
  const { user } = useAuth();
  const customStartDate = customDates?.startDate;
  const customEndDate = customDates?.endDate;
  const customRangeError = useMemo(() => {
    if (period !== 'Custom') return null;
    const dates = customStartDate && customEndDate ? { startDate: customStartDate, endDate: customEndDate } : undefined;
    try { getInsightsPeriodRanges('Custom', new Date(), dates); return null; }
    catch (error) { return error instanceof Error ? error.message : 'Choose a valid custom date range.'; }
  }, [period, customStartDate, customEndDate]);
  const ranges = useMemo(() => {
    if (period === 'Custom' && customRangeError) return getInsightsPeriodRanges('This month');
    const dates = customStartDate && customEndDate ? { startDate: customStartDate, endDate: customEndDate } : undefined;
    return getInsightsPeriodRanges(period, new Date(), dates);
  }, [period, customRangeError, customStartDate, customEndDate]);
  const currentPeriodRange = ranges.current;
  const previousPeriodRange = ranges.previous;
  const currentMonths = useMemo(() => monthRanges(currentPeriodRange.start, currentPeriodRange.end), [currentPeriodRange]);
  const query = useQuery({
    queryKey: ['insights', user?.id, period, currentPeriodRange.start.toISOString(), currentPeriodRange.end.toISOString()],
    enabled: !!user && !customRangeError,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    queryFn: async () => {
      if (!user) throw new Error('Sign in to view Insights.');
      const lower = previousPeriodRange.start < currentPeriodRange.start ? previousPeriodRange.start : currentPeriodRange.start;
      const upper = previousPeriodRange.end > currentPeriodRange.end ? previousPeriodRange.end : currentPeriodRange.end;
      const monthStarts: string[] = [];
      for (let date = new Date(currentPeriodRange.start.getFullYear(), currentPeriodRange.start.getMonth(), 1);
        date < currentPeriodRange.end && monthStarts.length < 13;
        date = new Date(date.getFullYear(), date.getMonth() + 1, 1)) {
        monthStarts.push(localDateKey(date));
      }
      const [reportRows, accounts, assets, holdings, debts, goals, emergency, reservations, budgetLists, bills, schedules] = await Promise.all([
        localDb.transaction.findReportRows({ ownerId: user.id, startDate: lower.toISOString(), endDate: upper.toISOString() }),
        localDb.account.findManyWithBalances(user.id, { includeArchived: true }),
        localDb.assets.list(user.id),
        localDb.holdings.list(user.id),
        localDb.obligations.debts.list(user.id),
        localDb.savings.goals(user.id),
        localDb.emergencyFund.get(user.id),
        localDb.savings.reservationsByAccount(user.id),
        Promise.all(monthStarts.map((start) => localDb.budget.list(user.id, start))),
        localDb.obligations.bills.upcoming(user.id),
        localDb.obligations.schedules.list(user.id),
      ]);
      return { reportRows, accounts, assets, holdings, debts, goals, emergency, reservations, budgets: budgetLists.flat(), bills, schedules };
    },
  });

  const data = useMemo(() => {
    if (!query.data) return undefined;
    const source = query.data;
    const accountPositions = source.accounts;
    const currencySet = new Set<string>();
    for (const account of source.accounts) currencySet.add(account.currency);
    for (const row of source.reportRows) if (row.accountCurrency) currencySet.add(row.accountCurrency);
    for (const asset of source.assets) currencySet.add(asset.currency);
    for (const holding of source.holdings) currencySet.add(holding.currency);
    for (const debt of source.debts) currencySet.add(debt.currency);
    for (const budget of source.budgets) currencySet.add(budget.currency);
    if (currencySet.size === 0) currencySet.add('PKR');
    const currencies = [...currencySet].sort();
    const currency = currencyPreference && currencySet.has(currencyPreference) ? currencyPreference : (currencySet.has('PKR') ? 'PKR' : currencies[0]);
    if (!currency) throw new Error('No financial reporting currency is available.');

    const currentRange = { startDate: currentPeriodRange.start.toISOString(), endDate: currentPeriodRange.end.toISOString() };
    const previousRange = { startDate: previousPeriodRange.start.toISOString(), endDate: previousPeriodRange.end.toISOString() };
    const report = calculateFinancialReport(source.reportRows, currency, currentRange);
    const previousReport = calculateFinancialReport(source.reportRows, currency, previousRange);
    const positiveCategoryTotalMinor = safeMinor(report.categoryTotals.filter((item) => item.amountMinor > 0).reduce((sum, item) => sum + BigInt(item.amountMinor), 0n), 'Positive net category total');
    const months = monthRanges(currentPeriodRange.start, currentPeriodRange.end);
    const monthlyTotals = calculateFinancialBucketTotals(source.reportRows, currency, months);
    const monthReportRows = months.map((bucket) => ({ id: bucket.id, label: new Date(bucket.startDate).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), startDate: bucket.startDate, endDate: bucket.endDate, incomeMinor: monthlyTotals[bucket.id]?.incomeMinor ?? 0, expenseMinor: monthlyTotals[bucket.id]?.expenseMinor ?? 0 }));
    const periodDays = calendarDaysInRange(currentPeriodRange);
    const trendGroup: InsightsTrendPoint['group'] = periodDays <= 14 ? 'day' : periodDays <= 183 ? 'week' : 'month';
    const buckets: FinancialBucket[] = trendGroup === 'month'
      ? monthRanges(currentPeriodRange.start, currentPeriodRange.end)
      : (() => {
        const result: FinancialBucket[] = [];
        let date = new Date(currentPeriodRange.start);
        const step = trendGroup === 'day' ? 1 : 7;
        while (date < currentPeriodRange.end && result.length < 53) {
          const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + step);
          const boundedEnd = next > currentPeriodRange.end ? currentPeriodRange.end : next;
          const idDate = localDateKey(date);
          result.push({ id: `${trendGroup}:${idDate}`, group: trendGroup, startDate: date.toISOString(), endDate: boundedEnd.toISOString() });
          date = boundedEnd;
        }
        return result;
      })();
    const bucketAmounts = calculateFinancialBucketTotals(source.reportRows, currency, buckets);
    const financialTrend = buckets.map((bucket) => ({
      id: bucket.id,
      group: trendGroup,
      label: trendGroup === 'day'
        ? new Date(bucket.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : trendGroup === 'week'
          ? `${new Date(bucket.startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–${new Date(new Date(bucket.endDate).getFullYear(), new Date(bucket.endDate).getMonth(), new Date(bucket.endDate).getDate() - 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
          : new Date(bucket.startDate).toLocaleDateString(undefined, currentPeriodRange.start.getFullYear() === new Date(currentPeriodRange.end.getTime() - 1).getFullYear() ? { month: 'short' } : { month: 'short', year: '2-digit' }),
      startDate: bucket.startDate,
      endDate: bucket.endDate,
      incomeMinor: bucketAmounts[bucket.id]?.incomeMinor ?? 0,
      expenseMinor: bucketAmounts[bucket.id]?.expenseMinor ?? 0,
    }));
    const spendingTrend = financialTrend.map((point) => ({ ...point, amountMinor: point.expenseMinor }));
    const accountSpending = calculateSpendingByAccountTotals(source.reportRows, currency, currentRange).map((item) => ({
      ...item,
      name: source.accounts.find((account) => account.id === item.accountId)?.name ?? (item.accountId ? 'Archived account' : 'Unknown account'),
    }));

    const activeGoals = source.goals.filter((goal) => goal.status === 'active' && goal.currency === currency);
    const savings = activeGoals.reduce((sum, goal) => ({ targetMinor: sum.targetMinor + BigInt(goal.targetMinor), actualMinor: sum.actualMinor + BigInt(goal.actualMinor) }), { targetMinor: 0n, actualMinor: 0n });
    const budgetByCategory = new Map<string, { allocated: bigint; spent: bigint }>();
    for (const month of currentMonths) {
      const start = localDateKey(new Date(month.startDate));
      const allocations = source.budgets.filter((budget) => budget.periodStart === start && budget.currency === currency && !budget.archivedAt && !budget.supersededAt)
        .map((budget) => ({ category: budget.categoryId, amountMinor: budget.amountMinor }));
      if (allocations.length === 0) continue;
      const monthlyReport = calculateFinancialReport(source.reportRows, currency, { startDate: month.startDate, endDate: month.endDate });
      const ownerId = user?.id;
      if (!ownerId) throw new Error('Sign in to view budget insights.');
      const snapshot = calculateBudgetSnapshot({ ownerId, reportOwnerId: ownerId, currency, startDate: month.startDate, endDate: month.endDate, report: monthlyReport, allocations });
      for (const category of snapshot.categories) {
        const previous = budgetByCategory.get(category.category) ?? { allocated: 0n, spent: 0n };
        previous.allocated += BigInt(category.amountMinor); previous.spent += BigInt(category.spentMinor); budgetByCategory.set(category.category, previous);
      }
    }
    const budgets = [...budgetByCategory].map(([category, values]) => ({ category, allocatedMinor: safeMinor(values.allocated, 'Budget allocation'), spentMinor: safeMinor(values.spent, 'Budget spending'), remainingMinor: safeMinor(values.allocated - values.spent, 'Budget remaining') }));
    const liquidity = calculateLiquidityPositions(source.accounts.map((account) => ({ id: account.id, currency: account.currency, type: account.type, archivedAt: account.archivedAt, balanceMinor: account.balanceMinor })), source.reservations);
    const debtPositions = calculateDebtPositions(source.debts.filter((debt) => debt.status !== 'cancelled').map((debt) => ({ direction: debt.direction, currency: debt.currency, principalMinor: debt.principalMinor, principalSettledMinor: debt.principalSettledMinor, interestAccruedMinor: debt.interestAccruedMinor, interestPaidMinor: debt.interestPaidMinor })));
    const netWorthInputs: Parameters<typeof calculateNetWorthPositions>[0][number][] = accountPositions.map((account) => ({ currency: account.currency, cashMinor: account.balanceMinor, investmentsMinor: 0, physicalAssetsMinor: 0, receivablesMinor: 0, liabilitiesMinor: 0 }));
    for (const asset of source.assets) if (asset.currentOwnershipBps > 0) netWorthInputs.push({ currency: asset.currency, cashMinor: 0, investmentsMinor: 0, physicalAssetsMinor: asset.ownedValueMinor, receivablesMinor: 0, liabilitiesMinor: 0 });
    for (const holding of source.holdings) if (holding.quantityMicros > 0) netWorthInputs.push({ currency: holding.currency, cashMinor: 0, investmentsMinor: holding.marketValueMinor, physicalAssetsMinor: 0, receivablesMinor: 0, liabilitiesMinor: 0 });
    for (const position of debtPositions) netWorthInputs.push({ currency: position.currency, cashMinor: 0, investmentsMinor: 0, physicalAssetsMinor: 0, receivablesMinor: position.receivablesMinor, liabilitiesMinor: position.liabilitiesMinor });
    const netWorth = calculateNetWorthPositions(netWorthInputs);
    const investments = source.holdings.filter((holding) => holding.quantityMicros > 0 && holding.currency === currency).reduce((sum, holding) => ({
      marketValueMinor: sum.marketValueMinor + BigInt(holding.marketValueMinor),
      realizedGainMinor: sum.realizedGainMinor + BigInt(holding.realizedGainMinor),
      unrealizedGainMinor: sum.unrealizedGainMinor + BigInt(holding.unrealizedGainMinor),
      dividendsMinor: sum.dividendsMinor + BigInt(holding.dividendsMinor),
    }), { marketValueMinor: 0n, realizedGainMinor: 0n, unrealizedGainMinor: 0n, dividendsMinor: 0n });
    const monthStart = localDateKey(new Date(currentPeriodRange.start.getFullYear(), currentPeriodRange.start.getMonth(), 1));
    const currentMonthBudget = source.budgets.some((budget) => budget.periodStart === monthStart && budget.currency === currency && !budget.archivedAt && !budget.supersededAt);
    const selectedMonthBudgets = currentMonthBudget ? source.budgets.filter((budget) => budget.periodStart === monthStart && budget.currency === currency && !budget.archivedAt && !budget.supersededAt) : [];
    const relevantBills = source.bills.filter((bill) => bill.currency === currency && (bill.status === 'overdue' || bill.status === 'due' || bill.status === 'upcoming')).slice(0, 4);
    const scheduledItems = source.schedules
      .filter((schedule) => schedule.status === 'active' && schedule.scheduleType !== 'bill' && schedule.currency === currency)
      .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate) || a.id.localeCompare(b.id))
      .slice(0, 5);
    const asOf = new Date();
    const staleAssetValuations = source.assets.filter((asset) => asset.currentOwnershipBps > 0 && (!asset.valuationDate || !Number.isFinite(Date.parse(asset.valuationDate)) || asOf.getTime() - Date.parse(asset.valuationDate) > 180 * 86_400_000)).length;
    const investmentPriceInfo = source.holdings.filter((holding) => holding.quantityMicros > 0 && holding.currency === currency)
      .map((holding) => ({ date: holding.priceDate, source: holding.priceSource, stale: !holding.priceDate || !Number.isFinite(Date.parse(holding.priceDate)) || asOf.getTime() - Date.parse(holding.priceDate) > 180 * 86_400_000 }));
    return {
      reportRows: source.reportRows,
      currency, currencies, report, previousReport, currentRange, monthReportRows, financialTrend, spendingTrend, accountSpending, excludedCurrencies: report.excludedCurrencies,
      isPartialPeriod: currentPeriodRange.start <= new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) && currentPeriodRange.end.getTime() === new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1).getTime(),
      positiveCategoryTotalMinor,
      dailyAverageMinor: calculateDailyAverageMinor(report.expenseMinor, calendarDaysInRange(currentPeriodRange)),
      incomeChangePercent: calculatePeriodChangePercent(report.incomeMinor, previousReport.incomeMinor),
      expenseChangePercent: calculatePeriodChangePercent(report.expenseMinor, previousReport.expenseMinor),
      categories: report.categoryTotals,
      incomeSources: report.incomeSourceTotals,
      largestExpenses: report.largestExpenses,
      activeGoals: activeGoals.map((goal) => ({ ...goal, percent: goal.targetMinor > 0 ? Number((BigInt(goal.actualMinor) * 10000n) / BigInt(goal.targetMinor)) / 100 : 0 })),
      savingsTargetMinor: safeMinor(savings.targetMinor, 'Savings targets'), savingsActualMinor: safeMinor(savings.actualMinor, 'Savings actuals'),
      emergency: source.emergency,
      budgets, currentMonthBudgets: selectedMonthBudgets,
      liquidity, netWorth, debtPositions, bills: relevantBills, scheduledItems,
      investments: { marketValueMinor: safeMinor(investments.marketValueMinor, 'Investment market value'), realizedGainMinor: safeMinor(investments.realizedGainMinor, 'Realized investment gains'), unrealizedGainMinor: safeMinor(investments.unrealizedGainMinor, 'Unrealized investment gains'), dividendsMinor: safeMinor(investments.dividendsMinor, 'Investment dividends') },
      unpricedCurrencies: [...new Set(source.holdings.filter((holding) => holding.quantityMicros > 0 && holding.currentPriceMinor === null).map((holding) => holding.currency))],
      staleAssetValuations, investmentPriceInfo,
      asOf: asOf.toISOString(),
    };
  }, [query.data, currentPeriodRange, previousPeriodRange, currencyPreference, currentMonths, user?.id]);
  return { ...query, data, customRangeError };
}
