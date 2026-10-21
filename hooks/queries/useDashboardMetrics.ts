import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import { calculateFinancialReport, type FinancialReportRow } from '../../src/finance/reporting';

type ChartPoint = { value: number; label: string };
type ChartPeriod = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';

function monthStart(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function expenseChart(transactions: FinancialReportRow[], period: ChartPeriod, today: Date): ChartPoint[] {
  const bucketDates: Date[] = [];
  const labels: string[] = [];

  if (period === 'Daily') {
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      bucketDates.push(date);
      labels.push(date.toLocaleDateString(undefined, { weekday: 'short' }));
    }
  } else if (period === 'Weekly') {
    const currentWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    currentWeek.setDate(currentWeek.getDate() - ((currentWeek.getDay() + 6) % 7));
    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(currentWeek);
      date.setDate(date.getDate() - offset * 7);
      bucketDates.push(date);
      labels.push(date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    }
  } else if (period === 'Monthly') {
    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = monthStart(today, -offset);
      bucketDates.push(date);
      labels.push(date.toLocaleDateString(undefined, { month: 'short' }));
    }
  } else {
    for (let offset = 4; offset >= 0; offset -= 1) {
      const year = today.getFullYear() - offset;
      bucketDates.push(new Date(year, 0, 1));
      labels.push(String(year));
    }
  }

  return bucketDates.map((start, index) => {
    const next = period === 'Daily'
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
      : period === 'Weekly'
        ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
        : period === 'Monthly'
          ? monthStart(start, 1)
          : new Date(start.getFullYear() + 1, 0, 1);
    const total = calculateFinancialReport(transactions, 'PKR', {
      startDate: start.toISOString(), endDate: next.toISOString(),
    }).expenseMinor;
    // The chart library takes display values as numbers. Financial totals remain integer minor units.
    return { value: Math.max(0, total) / 100, label: labels[index] };
  });
}

export function useDashboardMetrics() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['dashboard', 'metrics', user?.id],
    enabled: !!user,
    queryFn: async () => {
      if (!user) throw new Error('Sign in to view the dashboard.');
      const today = new Date();
      const reportStart = new Date(today.getFullYear() - 4, 0, 1);
      const reportEnd = new Date(today.getFullYear() + 1, 0, 1);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const [transactions, recentTransactions] = await Promise.all([
        localDb.transaction.findReportRows({ ownerId: user.id, startDate: reportStart.toISOString(), endDate: reportEnd.toISOString() }),
        localDb.transaction.findMany({ ownerId: user.id, orderBy: { date: 'desc' }, take: 4 }),
      ]);
      const monthReport = calculateFinancialReport(transactions, 'PKR', {
        startDate: monthStart.toISOString(), endDate: nextMonth.toISOString(),
      });

      return {
        incomeMinor: monthReport.incomeMinor,
        expenseMinor: monthReport.expenseMinor,
        netMinor: monthReport.netMinor,
        excludedCurrencies: monthReport.excludedCurrencies,
        monthLabel: today.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        chartData: {
          Daily: expenseChart(transactions, 'Daily', today),
          Weekly: expenseChart(transactions, 'Weekly', today),
          Monthly: expenseChart(transactions, 'Monthly', today),
          Yearly: expenseChart(transactions, 'Yearly', today),
        },
        transactions: recentTransactions,
      };
    },
  });
}
