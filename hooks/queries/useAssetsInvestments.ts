import { useQuery } from '@tanstack/react-query';
import { localDb } from '../../src/db/local/client';
import { useAuth } from '../../src/context/AuthContext';
import { calculateDebtPositions } from '../../src/finance/debtPosition';
import { calculateNetWorthHistory, calculateNetWorthPositions } from '../../src/finance/assetsInvestments';

export function useAssetsInvestments() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['assets-investments', user?.id],
    enabled: !!user,
    queryFn: async () => {
      if (!user) throw new Error('Sign in to view your assets.');
      const now=new Date();
      const dates=Array.from({length:12},(_,index)=>{
        const offset=index-11;const year=now.getUTCFullYear();const month=now.getUTCMonth()+offset;
        return offset===0?now.toISOString():new Date(Date.UTC(year,month+1,0,23,59,59,999)).toISOString();
      });
      const [accounts, assets, holdings, portfolios, debts, historyData] = await Promise.all([
        localDb.account.findManyWithBalances(user.id, { includeArchived: true }),
        localDb.assets.list(user.id),
        localDb.holdings.list(user.id),
        localDb.portfolios.list(user.id),
        localDb.obligations.debts.list(user.id),
        localDb.netWorth.historyData(user.id,dates),
      ]);
      const parts: Parameters<typeof calculateNetWorthPositions>[0][number][] = [];
      for (const account of accounts) parts.push({ currency: account.currency, cashMinor: account.balanceMinor, investmentsMinor: 0, physicalAssetsMinor: 0, receivablesMinor: 0, liabilitiesMinor: 0 });
      for (const asset of assets) if (asset.currentOwnershipBps > 0) parts.push({ currency: asset.currency, cashMinor: 0, investmentsMinor: 0, physicalAssetsMinor: asset.ownedValueMinor, receivablesMinor: 0, liabilitiesMinor: 0 });
      for (const holding of holdings) if (holding.quantityMicros > 0) parts.push({ currency: holding.currency, cashMinor: 0, investmentsMinor: holding.marketValueMinor, physicalAssetsMinor: 0, receivablesMinor: 0, liabilitiesMinor: 0 });
      const debtPositions = calculateDebtPositions(debts.map((debt) => ({
        direction: debt.direction,
        currency: debt.currency,
        principalMinor: debt.principalMinor,
        principalSettledMinor: debt.principalSettledMinor,
        interestAccruedMinor: debt.interestAccruedMinor,
        interestPaidMinor: debt.interestPaidMinor,
      })));
      for (const debt of debtPositions) parts.push({ currency: debt.currency, cashMinor: 0, investmentsMinor: 0, physicalAssetsMinor: 0, receivablesMinor: debt.receivablesMinor, liabilitiesMinor: debt.liabilitiesMinor });
      const history=calculateNetWorthHistory({dates,accounts,transactions:[],...historyData});
      return { positions: calculateNetWorthPositions(parts), accounts, assets, holdings, portfolios, history, asOf: now.toISOString() };
    },
  });
}
