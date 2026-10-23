import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import { calculateBudgetSnapshot, calculateSavingsGoalProgress } from '../../src/finance/budgeting';
import { calculateFinancialReport } from '../../src/finance/reporting';

export function useBudgeting(periodStart: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['budgets', user?.id, periodStart],
    enabled: !!user,
    queryFn: async () => {
      if (!user) throw new Error('Sign in to view budgets.');
      const period = new Date(`${periodStart}T00:00:00.000Z`);
      const end = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 1));
      const periodEnd = end.toISOString().slice(0, 10);
      const [budgets, rows] = await Promise.all([
        localDb.budget.list(user.id, periodStart),
        localDb.transaction.findReportRows({ ownerId: user.id, startDate: `${periodStart}T00:00:00.000Z`, endDate: `${periodEnd}T00:00:00.000Z` }),
      ]);
      const currencies = new Set([...budgets.map((budget) => budget.currency), ...rows.flatMap((row) => row.accountCurrency ? [row.accountCurrency] : [])]);
      const reports = [...currencies].map((currency) => calculateFinancialReport(rows, currency, {
        startDate: `${periodStart}T00:00:00.000Z`, endDate: `${periodEnd}T00:00:00.000Z`,
      }));
      const snapshots = reports.map((report) => calculateBudgetSnapshot({
        ownerId: user.id, reportOwnerId: user.id, currency: report.currency,
        startDate: `${periodStart}T00:00:00.000Z`, endDate: `${periodEnd}T00:00:00.000Z`, report,
        allocations: budgets.filter((item) => item.currency === report.currency).map((item) => ({ category: item.categoryId, amountMinor: item.amountMinor })),
      }));
      return { budgets, snapshots, periodEnd, excludedCurrencies: [...new Set(rows.flatMap((row) => row.accountCurrency && row.accountCurrency !== 'PKR' ? [row.accountCurrency] : []))] };
    },
  });
}

export function useSavingsOverview() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['savings', user?.id],
    enabled: !!user,
    queryFn: async () => {
      if (!user) throw new Error('Sign in to view savings.');
      const [goals, emergency] = await Promise.all([localDb.savings.goals(user.id), localDb.emergencyFund.get(user.id)]);
      return { goals: goals.map((goal) => ({ ...goal, progress: calculateSavingsGoalProgress({
        ownerId: user.id, currency: goal.currency, targetMinor: goal.targetMinor,
        contributions: [{ ownerId: user.id, currency: goal.currency, amountMinor: Math.max(0, goal.actualMinor) }],
      }) })), emergency };
    },
  });
}

export function useBudgetingWrites() {
  const { user } = useAuth();
  const client = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['budgets', user?.id] }),
      client.invalidateQueries({ queryKey: ['savings', user?.id] }),
      client.invalidateQueries({ queryKey: ['savings-history', user?.id] }),
      client.invalidateQueries({ queryKey: ['accounts', user?.id] }),
      client.invalidateQueries({ queryKey: ['transactions', user?.id] }),
      client.invalidateQueries({ queryKey: ['dashboard'] }),
      client.invalidateQueries({ queryKey: ['financial-report', user?.id] }),
      client.invalidateQueries({ queryKey: ['insights', user?.id] }),
    ]);
  };
  return {
    saveBudget: useMutation({ mutationFn: (input: Parameters<typeof localDb.budget.save>[0]) => localDb.budget.save(input), onSuccess: refresh }),
    archiveBudget: useMutation({ mutationFn: (id: string) => { if (!user) throw new Error('Sign in first.'); return localDb.budget.archive(user.id, id); }, onSuccess: refresh }),
    deleteBudget: useMutation({ mutationFn: (id: string) => { if (!user) throw new Error('Sign in first.'); return localDb.budget.deleteUnused(user.id, id); }, onSuccess: refresh }),
    rollover: useMutation({ mutationFn: (input: Parameters<typeof localDb.budget.rollover>[0]) => localDb.budget.rollover(input), onSuccess: refresh }),
    saveGoal: useMutation({ mutationFn: (input: Parameters<typeof localDb.savings.save>[0]) => localDb.savings.save(input), onSuccess: refresh }),
    goalEvent: useMutation({ mutationFn: (input: Parameters<typeof localDb.savings.addEvent>[0]) => localDb.savings.addEvent(input), onSuccess: refresh }),
    goalStatus: useMutation({ mutationFn: (input: { goalId: string; status: 'completed' | 'archived' }) => { if (!user) throw new Error('Sign in first.'); return localDb.savings.setStatus(user.id, input.goalId, input.status); }, onSuccess: refresh }),
    saveEmergencyConfig: useMutation({ mutationFn: (input: Parameters<typeof localDb.emergencyFund.saveConfig>[0]) => localDb.emergencyFund.saveConfig(input), onSuccess: refresh }),
    emergencyEvent: useMutation({ mutationFn: (input: Parameters<typeof localDb.emergencyFund.addEvent>[0]) => localDb.emergencyFund.addEvent(input), onSuccess: refresh }),
  };
}
