import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';

export function useDashboardMetrics() {
  return useQuery({
    queryKey: ['dashboard', 'metrics'],
    queryFn: async () => {
      // Mocked DB calls for now, replace with actual Prisma aggregations when relationships are fully built
      // For now, we will return some mocked data to keep the UI running while Prisma is set up.
      
      const totalBalance = 150000;
      
      const chartData = {
        Daily: [{ value: 1200, label: 'Mon' }, { value: 3400, label: 'Tue' }],
        Weekly: [{ value: 12000, label: 'W1' }, { value: 8000, label: 'W2' }],
        Monthly: [{ value: 45000, label: 'Jan' }, { value: 38000, label: 'Feb' }],
        Yearly: [{ value: 450000, label: '2024' }, { value: 520000, label: '2025' }],
      };

      const transactions = await localDb.transaction.findMany({
        take: 4,
        orderBy: { date: 'desc' },
      });

      return {
        totalBalance,
        chartData,
        transactions,
      };
    },
  });
}
