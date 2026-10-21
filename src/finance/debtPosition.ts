export interface DebtBalanceInput {
  direction: 'borrowed' | 'lent';
  principalMinor: number;
  principalSettledMinor: number;
  interestAccruedMinor?: number;
  interestPaidMinor?: number;
  currency: string;
}

export interface DebtCurrencyPosition {
  currency: string;
  receivablesMinor: number;
  liabilitiesMinor: number;
  netWorthEffectMinor: number;
}

/** Outstanding receivables are assets; borrowed principal is a liability. */
export function calculateDebtPositions(debts: readonly DebtBalanceInput[]): DebtCurrencyPosition[] {
  const totals=new Map<string,{assets:bigint;liabilities:bigint}>();
  for(const debt of debts){
    const interestAccrued=debt.interestAccruedMinor??0;const interestPaid=debt.interestPaidMinor??0;
    if(!/^[A-Z]{3}$/.test(debt.currency)||!Number.isSafeInteger(debt.principalMinor)||!Number.isSafeInteger(debt.principalSettledMinor)||!Number.isSafeInteger(interestAccrued)||!Number.isSafeInteger(interestPaid)||debt.principalMinor<0||debt.principalSettledMinor<0||debt.principalSettledMinor>debt.principalMinor||interestAccrued<0||interestPaid<0||interestPaid>interestAccrued) throw new Error('Debt balance is invalid.');
    const row=totals.get(debt.currency)??{assets:0n,liabilities:0n};
    const remaining=BigInt(debt.principalMinor)-BigInt(debt.principalSettledMinor);
    const accruedOutstanding=BigInt(interestAccrued)-BigInt(interestPaid);
    if(debt.direction==='borrowed') row.liabilities+=remaining+accruedOutstanding; else row.assets+=remaining+accruedOutstanding;
    totals.set(debt.currency,row);
  }
  return [...totals.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([currency,row])=>{
    const asset=Number(row.assets),liability=Number(row.liabilities),net=Number(row.assets-row.liabilities);
    if(!Number.isSafeInteger(asset)||!Number.isSafeInteger(liability)||!Number.isSafeInteger(net)) throw new Error(`${currency} debt position exceeds the supported range.`);
    return {currency,receivablesMinor:asset,liabilitiesMinor:liability,netWorthEffectMinor:net};
  });
}
