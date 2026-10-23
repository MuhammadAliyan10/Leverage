import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import {
  calculateExpenseBucketTotals,
  calculateFinancialReport,
  type FinancialBucket,
  type FinancialReportRow,
} from '../../src/finance/reporting';
import { calculateAccountBalances } from '../../src/finance/balances';
import { calculateDebtPositions } from '../../src/finance/debtPosition';
import { calculateNetWorthPositions, type NetWorthPosition } from '../../src/finance/assetsInvestments';
import { calculateBudgetSnapshot, type BudgetSnapshot } from '../../src/finance/budgeting';
import { isCurrencyCode, type CurrencyCode } from '../../src/finance/domain';
import { calculateLiquidityPositions, type LiquidityPosition } from '../../src/finance/liquidity';
import type { TransactionActivity } from '../../src/finance/transactionDisplay';

export type DashboardFilter = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';
export type DashboardChartPoint = { amountMinor: number; label: string; hasActivity: boolean };

export type DashboardLiquidityPosition = LiquidityPosition;

export interface DashboardSavingsPosition {
  currency: CurrencyCode;
  targetMinor: number;
  actualMinor: number;
}

export interface DashboardUpcomingBill {
  id: string;
  name: string;
  currency: CurrencyCode;
  remainingMinor: number;
  dueDate: string;
  status: 'overdue' | 'due' | 'upcoming';
}

export interface DashboardMetrics {
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  excludedCurrencies: string[];
  monthLabel: string;
  chartData: Record<DashboardFilter, DashboardChartPoint[]>;
  activities: TransactionActivity[];
  liquidity: DashboardLiquidityPosition[];
  netWorth: NetWorthPosition[];
  unpricedHoldingCurrencies: string[];
  budgets: BudgetSnapshot[];
  savings: DashboardSavingsPosition[];
  emergencyFund: Awaited<ReturnType<typeof localDb.emergencyFund.get>>;
  upcomingBills: DashboardUpcomingBill[];
  hasAnyFinancialRecords: boolean;
}

type Account = Awaited<ReturnType<typeof localDb.account.findMany>>[number];
type BalanceRow = Awaited<ReturnType<typeof localDb.transaction.findBalanceRows>>[number];
type AccountReservation = Awaited<ReturnType<typeof localDb.savings.reservationsByAccount>>[number];

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`${label} is outside the supported range.`);
  return Number(value);
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function chartBuckets(today: Date): { ranges: FinancialBucket[]; labels: Record<DashboardFilter, string[]>; starts: Record<DashboardFilter, Date[]> } {
  const starts: Record<DashboardFilter, Date[]> = { Daily: [], Weekly: [], Monthly: [], Yearly: [] };
  const labels: Record<DashboardFilter, string[]> = { Daily: [], Weekly: [], Monthly: [], Yearly: [] };
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    starts.Daily.push(date);
    labels.Daily.push(date.toLocaleDateString(undefined, { weekday: 'short' }));
  }
  const week = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(week);
    date.setDate(date.getDate() - offset * 7);
    starts.Weekly.push(date);
    labels.Weekly.push(date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  }
  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    starts.Monthly.push(date);
    labels.Monthly.push(date.toLocaleDateString(undefined, { month: 'short' }));
  }
  for (let offset = 4; offset >= 0; offset -= 1) {
    const year = today.getFullYear() - offset;
    starts.Yearly.push(new Date(year, 0, 1));
    labels.Yearly.push(String(year));
  }
  const ranges: FinancialBucket[] = [];
  for (const group of ['Daily', 'Weekly', 'Monthly', 'Yearly'] as const) {
    starts[group].forEach((start, index) => {
      const end = group === 'Daily' ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
        : group === 'Weekly' ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
          : group === 'Monthly' ? new Date(start.getFullYear(), start.getMonth() + 1, 1)
            : new Date(start.getFullYear() + 1, 0, 1);
      ranges.push({ id: `${group}:${index}`, group, startDate: start.toISOString(), endDate: end.toISOString() });
    });
  }
  return { ranges, labels, starts };
}

function summarizeNetWorth(
  accounts: readonly ReturnType<typeof calculateAccountBalances>[number][],
  assets: Awaited<ReturnType<typeof localDb.assets.list>>,
  holdings: Awaited<ReturnType<typeof localDb.holdings.list>>,
  debts: Awaited<ReturnType<typeof localDb.obligations.debts.list>>,
): NetWorthPosition[] {
  const parts: Parameters<typeof calculateNetWorthPositions>[0][number][] = [];
  for (const account of accounts) parts.push({ currency: account.currency, cashMinor: account.balanceMinor, investmentsMinor: 0, physicalAssetsMinor: 0, receivablesMinor: 0, liabilitiesMinor: 0 });
  for (const asset of assets) if (asset.currentOwnershipBps > 0) parts.push({ currency: asset.currency, cashMinor: 0, investmentsMinor: 0, physicalAssetsMinor: asset.ownedValueMinor, receivablesMinor: 0, liabilitiesMinor: 0 });
  for (const holding of holdings) if (holding.quantityMicros > 0) parts.push({ currency: holding.currency, cashMinor: 0, investmentsMinor: holding.marketValueMinor, physicalAssetsMinor: 0, receivablesMinor: 0, liabilitiesMinor: 0 });
  const positions = calculateDebtPositions(debts.filter((debt) => debt.status !== 'cancelled').map((debt) => ({
    direction: debt.direction, currency: debt.currency, principalMinor: debt.principalMinor,
    principalSettledMinor: debt.principalSettledMinor, interestAccruedMinor: debt.interestAccruedMinor,
    interestPaidMinor: debt.interestPaidMinor,
  })));
  for (const debt of positions) parts.push({ currency: debt.currency, cashMinor: 0, investmentsMinor: 0, physicalAssetsMinor: 0, receivablesMinor: debt.receivablesMinor, liabilitiesMinor: debt.liabilitiesMinor });
  return calculateNetWorthPositions(parts);
}

function summarizeSavings(
  goals: Awaited<ReturnType<typeof localDb.savings.goals>>,
): DashboardSavingsPosition[] {
  const targets = new Map<CurrencyCode, bigint>();
  const actuals = new Map<CurrencyCode, bigint>();
  for (const goal of goals) {
    if (goal.status !== 'active') continue;
    if (!Number.isSafeInteger(goal.actualMinor) || goal.actualMinor < 0 || !Number.isSafeInteger(goal.targetMinor) || goal.targetMinor <= 0) {
      throw new Error(`Savings goal ${goal.id} has invalid saved amounts.`);
    }
    if (!isCurrencyCode(goal.currency)) throw new Error(`Savings goal ${goal.id} has an unsupported currency.`);
    const currency = goal.currency;
    targets.set(currency, (targets.get(currency) ?? 0n) + BigInt(goal.targetMinor));
    actuals.set(currency, (actuals.get(currency) ?? 0n) + BigInt(goal.actualMinor));
  }
  return [...targets.keys()].sort().map((currency) => ({
    currency,
    targetMinor: toSafeNumber(targets.get(currency) ?? 0n, 'Savings target'),
    actualMinor: toSafeNumber(actuals.get(currency) ?? 0n, 'Savings allocation'),
  }));
}

function calculateBudgetSummaries(
  ownerId: string,
  budgets: Awaited<ReturnType<typeof localDb.budget.list>>,
  rows: readonly FinancialReportRow[],
  startDate: string,
  endDate: string,
): BudgetSnapshot[] {
  const grouped = new Map<string, typeof budgets>();
  for (const budget of budgets) grouped.set(budget.currency, [...(grouped.get(budget.currency) ?? []), budget]);
  const periodRows = rows.filter((row) => {
    const timestamp = new Date(row.date).getTime();
    return timestamp >= new Date(startDate).getTime() && timestamp < new Date(endDate).getTime();
  });
  return [...grouped].map(([currency, allocations]) => {
    const report = calculateFinancialReport(periodRows, currency, { startDate, endDate });
    return calculateBudgetSnapshot({
      ownerId, reportOwnerId: ownerId, currency, startDate, endDate, report,
      allocations: allocations.map((budget) => ({ category: budget.categoryId, amountMinor: budget.amountMinor })),
    });
  });
}

export function useDashboardMetrics(reportDate: Date) {
  const { user } = useAuth();
  const dayKey = localDateKey(reportDate);
  const monthStart = new Date(reportDate.getFullYear(), reportDate.getMonth(), 1);
  const nextMonth = new Date(reportDate.getFullYear(), reportDate.getMonth() + 1, 1);
  const periodStart = monthStart.toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(reportDate.getFullYear(), reportDate.getMonth() + 1, 1)).toISOString().slice(0, 10);

  return useQuery({
    queryKey: ['dashboard', 'metrics', user?.id, dayKey],
    enabled: !!user,
    staleTime: Infinity,
    queryFn: async (): Promise<DashboardMetrics> => {
      if (!user) throw new Error('Sign in to view your dashboard.');
      const today = new Date(`${dayKey}T12:00:00`);
      const chartStart = new Date(today.getFullYear() - 4, 0, 1);
      const chartEnd = new Date(today.getFullYear() + 1, 0, 1);
      const monthReportStart = monthStart;
      const monthReportEnd = nextMonth;
      const reportQueryStart = chartStart < monthReportStart ? chartStart : monthReportStart;
      const reportQueryEnd = chartEnd > monthReportEnd ? chartEnd : monthReportEnd;
      const budgetRangeStart = new Date(`${periodStart}T00:00:00.000Z`);
      const budgetRangeEnd = new Date(`${periodEnd}T00:00:00.000Z`);
      const queryEnd = reportQueryEnd > budgetRangeEnd ? reportQueryEnd : budgetRangeEnd;
      const [accounts, balanceRows, reportRows, activities, assets, holdings, debts, budgetRows, goals, emergencyFund, bills, reservations] = await Promise.all([
        localDb.account.findMany(user.id, { includeArchived: true }),
        localDb.transaction.findBalanceRows(user.id),
        localDb.transaction.findReportRows({ ownerId: user.id, startDate: reportQueryStart.toISOString(), endDate: queryEnd.toISOString() }),
        localDb.transaction.findRecentActivity(user.id, 5),
        localDb.assets.list(user.id),
        localDb.holdings.list(user.id),
        localDb.obligations.debts.list(user.id),
        localDb.budget.list(user.id, periodStart),
        localDb.savings.goals(user.id),
        localDb.emergencyFund.get(user.id),
        localDb.obligations.bills.upcoming(user.id, dayKey),
        localDb.savings.reservationsByAccount(user.id),
      ]);
      const balanceInputs: Parameters<typeof calculateAccountBalances>[1] = balanceRows.map((row: BalanceRow) => ({
        id: row.id, ownerId: row.ownerId, amountMinor: row.amountMinor, type: row.type,
        accountId: row.accountId, toAccountId: row.toAccountId, reversalOfId: row.reversalOfId,
      }));
      const accountBalances = calculateAccountBalances(accounts, balanceInputs);
      const balancesById = new Map(accountBalances.map((balance) => [balance.id, balance]));
      const liquidityAccounts = accounts.map((account) => {
        const balance = balancesById.get(account.id);
        if (!balance) throw new Error(`Account ${account.id} has no calculated balance.`);
        return { id: account.id, currency: balance.currency, type: account.type, archivedAt: account.archivedAt, balanceMinor: balance.balanceMinor };
      });
      const monthReport = calculateFinancialReport(reportRows, 'PKR', {
        startDate: monthReportStart.toISOString(), endDate: monthReportEnd.toISOString(),
      });
      const { ranges, labels, starts } = chartBuckets(today);
      const chartTotals = calculateExpenseBucketTotals(reportRows, 'PKR', ranges);
      const pointsFor = (period: DashboardFilter): DashboardChartPoint[] => starts[period].map((start, index) => {
          const amountMinor = chartTotals[`${period}:${index}`] ?? 0;
          return { amountMinor, label: labels[period][index], hasActivity: amountMinor !== 0 };
        });
      const chartData: Record<DashboardFilter, DashboardChartPoint[]> = {
        Daily: pointsFor('Daily'), Weekly: pointsFor('Weekly'), Monthly: pointsFor('Monthly'), Yearly: pointsFor('Yearly'),
      };
      const savings = summarizeSavings(goals);
      const liquidity = calculateLiquidityPositions(liquidityAccounts, reservations);
      const netWorth = summarizeNetWorth(accountBalances, assets, holdings, debts);
      const unpricedHoldingCurrencies = [...new Set(holdings
        .filter((holding) => holding.quantityMicros > 0 && holding.currentPriceMinor === null)
        .map((holding) => holding.currency))].sort();
      const budgetStart = budgetRangeStart.toISOString();
      const budgetEnd = budgetRangeEnd.toISOString();
      const budgets = calculateBudgetSummaries(user.id, budgetRows, reportRows, budgetStart, budgetEnd);
      const upcomingBills: DashboardUpcomingBill[] = bills
        .filter((bill) => ['overdue', 'due', 'upcoming'].includes(bill.status) && bill.paidMinor < bill.amountMinor)
        .flatMap((bill): DashboardUpcomingBill[] => {
          const currency = bill.currency;
          if (!isCurrencyCode(currency)) throw new Error(`Bill ${bill.id} has an invalid currency.`);
          const status = bill.status;
          if (status !== 'overdue' && status !== 'due' && status !== 'upcoming') return [];
          const remaining = BigInt(bill.amountMinor) - BigInt(bill.paidMinor);
          if (remaining <= 0n) return [];
          return [{ id: bill.id, name: bill.name, currency,
            remainingMinor: toSafeNumber(remaining, 'Remaining bill amount'), dueDate: bill.dueDate, status }];
        }).slice(0, 3);
      const hasAnyFinancialRecords = accounts.length > 0 || balanceRows.length > 0 || assets.length > 0 || holdings.length > 0 || debts.length > 0;
      return {
        incomeMinor: monthReport.incomeMinor, expenseMinor: monthReport.expenseMinor,
        netMinor: monthReport.netMinor, excludedCurrencies: monthReport.excludedCurrencies,
        monthLabel: reportDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        chartData, activities, liquidity, netWorth, unpricedHoldingCurrencies, budgets, savings, emergencyFund,
        upcomingBills, hasAnyFinancialRecords,
      };
    },
  });
}
