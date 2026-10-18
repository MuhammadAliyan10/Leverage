import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';

type Transaction = {
  id: string;
  amountMinor: number;
  type: 'Income' | 'Expense' | 'Transfer';
  category: string;
  accountId: string | null;
  date: string;
  note: string;
};

type ChartPoint = { value: number; label: string };
type ChartPeriod = 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';

function sumMinorUnits(values: number[]): number {
  const sum = values.reduce((total, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('A saved transaction has an invalid amount.');
    }
    return total + BigInt(value);
  }, 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Financial total is out of range.');
  return Number(sum);
}

function monthStart(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function expenseChart(transactions: Transaction[], period: ChartPeriod, today: Date): ChartPoint[] {
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
    const minor = sumMinorUnits(
      transactions
        .filter((tx) => tx.type === 'Expense')
        .filter((tx) => {
          const date = new Date(tx.date);
          if (Number.isNaN(date.getTime())) throw new Error('A transaction has an invalid date.');
          return date >= start && date < next;
        })
        .map((tx) => tx.amountMinor),
    );
    // The chart library takes display values as numbers. Financial totals remain integer minor units.
    return { value: minor / 100, label: labels[index] };
  });
}

export function useDashboardMetrics() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['dashboard', 'metrics', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const transactions = await localDb.transaction.findMany({
        ownerId: user!.id,
        orderBy: { date: 'desc' },
      }) as Transaction[];
      const today = new Date();
      const currentMonth = transactions.filter((tx) => {
        const date = new Date(tx.date);
        if (Number.isNaN(date.getTime())) throw new Error('A transaction has an invalid date.');
        return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth();
      });

      const incomeMinor = sumMinorUnits(
        currentMonth.filter((tx) => tx.type === 'Income').map((tx) => tx.amountMinor),
      );
      const expenseMinor = sumMinorUnits(
        currentMonth.filter((tx) => tx.type === 'Expense').map((tx) => tx.amountMinor),
      );
      const netMinorBigInt = BigInt(incomeMinor) - BigInt(expenseMinor);
      if (netMinorBigInt > BigInt(Number.MAX_SAFE_INTEGER) || netMinorBigInt < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error('Monthly net amount is out of range.');
      }

      return {
        incomeMinor,
        expenseMinor,
        netMinor: Number(netMinorBigInt),
        monthLabel: today.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        chartData: {
          Daily: expenseChart(transactions, 'Daily', today),
          Weekly: expenseChart(transactions, 'Weekly', today),
          Monthly: expenseChart(transactions, 'Monthly', today),
          Yearly: expenseChart(transactions, 'Yearly', today),
        },
        transactions: transactions.slice(0, 4),
      };
    },
  });
}
