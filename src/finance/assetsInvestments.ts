import { calculateAccountBalances, type BalanceAccountInput, type BalanceTransactionInput } from './balances.ts';

export const QUANTITY_SCALE = 1_000_000n;
export const OWNERSHIP_SCALE = 10_000n;

export type InvestmentEvent = {
  eventType: 'buy' | 'sell' | 'split' | 'dividend';
  quantityMicros: number;
  unitPriceMinor: number;
  feeMinor: number;
  amountMinor: number;
  splitNumerator: number;
  splitDenominator: number;
};

export interface HoldingPosition {
  quantityMicros: number;
  costBasisMinor: number;
  marketValueMinor: number;
  realizedGainMinor: number;
  unrealizedGainMinor: number;
  dividendsMinor: number;
  feesMinor: number;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MAX_SAFE_INTEGER) * -1n) {
    throw new Error(`${label} exceeds the supported range.`);
  }
  return Number(value);
}

function roundQuantityPrice(quantityMicros: bigint, priceMinor: bigint): bigint {
  return (quantityMicros * priceMinor + QUANTITY_SCALE / 2n) / QUANTITY_SCALE;
}

/** Average-cost position. Fees are capitalized on purchases and reduce net sale proceeds. */
export function calculateHoldingPosition(
  events: readonly InvestmentEvent[],
  marketPriceMinor: number | null,
): HoldingPosition {
  let quantity = 0n;
  let basis = 0n;
  let realized = 0n;
  let dividends = 0n;
  let fees = 0n;
  for (const event of events) {
    for (const value of [event.quantityMicros, event.unitPriceMinor, event.feeMinor, event.amountMinor]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Investment event contains an invalid amount.');
    }
    if (event.eventType === 'buy') {
      if (event.quantityMicros <= 0 || event.unitPriceMinor <= 0) throw new Error('A buy needs a positive quantity and price.');
      quantity += BigInt(event.quantityMicros);
      basis += roundQuantityPrice(BigInt(event.quantityMicros), BigInt(event.unitPriceMinor)) + BigInt(event.feeMinor);
      fees += BigInt(event.feeMinor);
    } else if (event.eventType === 'sell') {
      const sold = BigInt(event.quantityMicros);
      if (sold <= 0n || sold > quantity || event.unitPriceMinor <= 0) throw new Error('Sale quantity exceeds the available holding.');
      const allocatedBasis = sold === quantity ? basis : (basis * sold + quantity / 2n) / quantity;
      const netProceeds = roundQuantityPrice(sold, BigInt(event.unitPriceMinor)) - BigInt(event.feeMinor);
      if (netProceeds < 0n) throw new Error('Sale fees exceed gross proceeds.');
      basis -= allocatedBasis;
      quantity -= sold;
      realized += netProceeds - allocatedBasis;
      fees += BigInt(event.feeMinor);
    } else if (event.eventType === 'split') {
      if (!Number.isSafeInteger(event.splitNumerator) || !Number.isSafeInteger(event.splitDenominator) || event.splitNumerator <= 0 || event.splitDenominator <= 0) {
        throw new Error('Stock split ratio is invalid.');
      }
      const adjustedQuantity = (quantity * BigInt(event.splitNumerator) + BigInt(event.splitDenominator) / 2n) / BigInt(event.splitDenominator);
      if (quantity > 0n && adjustedQuantity === 0n) throw new Error('Split ratio would round the remaining shares to zero at six-decimal precision.');
      quantity = adjustedQuantity;
    } else {
      if (event.amountMinor <= 0) throw new Error('A dividend must be positive.');
      dividends += BigInt(event.amountMinor);
      fees += BigInt(event.feeMinor);
    }
    if (quantity > BigInt(Number.MAX_SAFE_INTEGER) || basis > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Investment position exceeds the supported range.');
  }
  if (marketPriceMinor !== null && (!Number.isSafeInteger(marketPriceMinor) || marketPriceMinor < 0)) throw new Error('Market price is invalid.');
  const marketValue = marketPriceMinor === null ? 0n : roundQuantityPrice(quantity, BigInt(marketPriceMinor));
  return {
    quantityMicros: safeNumber(quantity, 'Holding quantity'),
    costBasisMinor: safeNumber(basis, 'Holding cost basis'),
    marketValueMinor: safeNumber(marketValue, 'Holding market value'),
    realizedGainMinor: safeNumber(realized, 'Realized gain'),
    unrealizedGainMinor: safeNumber(marketValue - basis, 'Unrealized gain'),
    dividendsMinor: safeNumber(dividends, 'Dividend total'),
    feesMinor: safeNumber(fees, 'Investment fees'),
  };
}

export interface AssetPositionInput {
  currency: string;
  ownershipBps: number;
  currentValueMinor: number;
}

/** Applies ownership to the appraised whole-asset value with integer half-up rounding. */
export function ownedAssetValue(input: AssetPositionInput): number {
  if (!/^[A-Z]{3}$/.test(input.currency) || !Number.isSafeInteger(input.ownershipBps) || input.ownershipBps < 0 || input.ownershipBps > 10_000 || !Number.isSafeInteger(input.currentValueMinor) || input.currentValueMinor < 0) {
    throw new Error('Asset valuation is invalid.');
  }
  return Number((BigInt(input.currentValueMinor) * BigInt(input.ownershipBps) + OWNERSHIP_SCALE / 2n) / OWNERSHIP_SCALE);
}

export interface NetWorthPosition {
  currency: string;
  cashMinor: number;
  investmentsMinor: number;
  physicalAssetsMinor: number;
  receivablesMinor: number;
  liabilitiesMinor: number;
  totalAssetsMinor: number;
  netWorthMinor: number;
}

export function calculateNetWorthPositions(inputs: readonly Omit<NetWorthPosition, 'totalAssetsMinor' | 'netWorthMinor'>[]): NetWorthPosition[] {
  const totals = new Map<string, Record<'cashMinor' | 'investmentsMinor' | 'physicalAssetsMinor' | 'receivablesMinor' | 'liabilitiesMinor', bigint>>();
  for (const input of inputs) {
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('Net-worth currency is invalid.');
    const row = totals.get(input.currency) ?? { cashMinor: 0n, investmentsMinor: 0n, physicalAssetsMinor: 0n, receivablesMinor: 0n, liabilitiesMinor: 0n };
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (!Number.isSafeInteger(input[key])) throw new Error('Net-worth amount must be integer minor units.');
      row[key] += BigInt(input[key]);
    }
    totals.set(input.currency, row);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, row]) => {
    const assets = row.cashMinor + row.investmentsMinor + row.physicalAssetsMinor + row.receivablesMinor;
    return {
      currency,
      cashMinor: safeNumber(row.cashMinor, 'Cash total'),
      investmentsMinor: safeNumber(row.investmentsMinor, 'Investment total'),
      physicalAssetsMinor: safeNumber(row.physicalAssetsMinor, 'Physical asset total'),
      receivablesMinor: safeNumber(row.receivablesMinor, 'Receivables total'),
      liabilitiesMinor: safeNumber(row.liabilitiesMinor, 'Liability total'),
      totalAssetsMinor: safeNumber(assets, 'Total assets'),
      netWorthMinor: safeNumber(assets - row.liabilitiesMinor, 'Net worth'),
    };
  });
}

export function calculateQuantityMicros(input: string): number {
  const value = input.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error('Enter a quantity with up to six decimal places.');
  const result = BigInt(match[1]) * QUANTITY_SCALE + BigInt((match[2] ?? '').padEnd(6, '0') || '0');
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Quantity must be positive and within the supported range.');
  return Number(result);
}

export function formatQuantityMicros(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Quantity is invalid.');
  const whole = Math.floor(value / Number(QUANTITY_SCALE));
  const fraction = String(value % Number(QUANTITY_SCALE)).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
export interface HistoricalAssetInput {
  id: string; currency: string; purchaseDate: string; purchaseValueMinor: number; ownershipBps: number;
  valuations: { valueMinor: number; date: string }[];
  disposals: { ownershipBps: number; date: string }[];
}
export interface HistoricalHoldingInput {
  id: string; currency: string;
  events: (InvestmentEvent & { date: string })[];
  prices: { unitPriceMinor: number; date: string }[];
}
export interface HistoricalDebtInput {
  id: string; direction: 'borrowed'|'lent'; currency: string; principalMinor: number; openedAt: string;
  events: { id?: string; eventType: string; principalMinor: number; interestMinor: number; eventDate: string }[];
  corrections?: { originalEventId: string; createdAt: string }[];
  interestEvents: { eventType: 'charge'|'reversal'; amountMinor: number; eventDate: string }[];
}

/** Rebuilds monthly balance sheets from dated ledger and valuation events; does not store balances. */
export function calculateNetWorthHistory(input: {
  dates: readonly string[];
  accounts: readonly (BalanceAccountInput & { createdAt: string })[];
  transactions: readonly (BalanceTransactionInput & { date: string })[];
  accountBalanceSnapshots?: readonly {asOfDate:string;accounts:readonly BalanceAccountInput[]}[];
  assets: readonly HistoricalAssetInput[];
  holdings: readonly HistoricalHoldingInput[];
  debts: readonly HistoricalDebtInput[];
}): { asOfDate: string; positions: NetWorthPosition[] }[] {
  return input.dates.map((asOfDate) => {
    const cutoff = Date.parse(asOfDate);
    if (!Number.isFinite(cutoff)) throw new Error('Net-worth history date is invalid.');
    const snapshot=input.accountBalanceSnapshots?.find((item)=>item.asOfDate===asOfDate);
    const accounts = input.accounts.filter((account) => Date.parse(account.createdAt) <= cutoff);
    const accountIds = new Set(accounts.map((account) => account.id));
    const transactions = input.transactions.filter((transaction) => Date.parse(transaction.date) <= cutoff && transaction.accountId !== null && accountIds.has(transaction.accountId));
    const balances = snapshot?.accounts ?? calculateAccountBalances(accounts, transactions);
    const parts: Omit<NetWorthPosition, 'totalAssetsMinor'|'netWorthMinor'>[] = [];
    for (const account of balances) parts.push({currency:account.currency,cashMinor:account.balanceMinor,investmentsMinor:0,physicalAssetsMinor:0,receivablesMinor:0,liabilitiesMinor:0});
    for (const asset of input.assets) {
      if (Date.parse(asset.purchaseDate)>cutoff) continue;
      const valuations=asset.valuations.filter((item)=>Date.parse(item.date)<=cutoff).sort((a,b)=>a.date.localeCompare(b.date));
      const value=valuations.at(-1)?.valueMinor??asset.purchaseValueMinor;
      const ownership=asset.ownershipBps-asset.disposals.filter((item)=>Date.parse(item.date)<=cutoff).reduce((sum,item)=>sum+item.ownershipBps,0);
      if(ownership>0)parts.push({currency:asset.currency,cashMinor:0,investmentsMinor:0,physicalAssetsMinor:ownedAssetValue({currency:asset.currency,ownershipBps:ownership,currentValueMinor:value}),receivablesMinor:0,liabilitiesMinor:0});
    }
    for(const holding of input.holdings){
      const events=holding.events.filter((event)=>Date.parse(event.date)<=cutoff).sort((a,b)=>a.date.localeCompare(b.date));
      if(!events.length)continue;
      const prices=holding.prices.filter((price)=>Date.parse(price.date)<=cutoff).sort((a,b)=>a.date.localeCompare(b.date));
      const fallback=events.filter((event)=>event.eventType==='buy'||event.eventType==='sell').at(-1)?.unitPriceMinor??null;
      const position=calculateHoldingPosition(events,prices.at(-1)?.unitPriceMinor??fallback);
      if(position.quantityMicros>0)parts.push({currency:holding.currency,cashMinor:0,investmentsMinor:position.marketValueMinor,physicalAssetsMinor:0,receivablesMinor:0,liabilitiesMinor:0});
    }
    for(const debt of input.debts){
      if(Date.parse(debt.openedAt)>cutoff)continue;
      const corrected=new Set((debt.corrections??[]).filter((item)=>Date.parse(item.createdAt)<=cutoff).map((item)=>item.originalEventId));
      const events=debt.events.filter((event)=>Date.parse(event.eventDate)<=cutoff&&(!event.id||!corrected.has(event.id)));
      const settled=events.reduce((sum,event)=>sum+((event.eventType==='principal_repayment'||event.eventType==='receivable_payment'||event.eventType==='settlement')?BigInt(event.principalMinor):0n),0n);
      const accrued=debt.interestEvents.filter((event)=>Date.parse(event.eventDate)<=cutoff).reduce((sum,event)=>sum+(event.eventType==='charge'?BigInt(event.amountMinor):-BigInt(event.amountMinor)),0n);
      const paid=events.filter((event)=>event.eventType==='interest').reduce((sum,event)=>sum+BigInt(event.interestMinor),0n);
      const principal=BigInt(debt.principalMinor)-settled;const interest=accrued-paid;
      if(principal<0n||interest<0n)throw new Error('Historical debt events exceed the outstanding balance.');
      parts.push({currency:debt.currency,cashMinor:0,investmentsMinor:0,physicalAssetsMinor:0,receivablesMinor:debt.direction==='lent'?safeNumber(principal+interest,'Historical receivable'):0,liabilitiesMinor:debt.direction==='borrowed'?safeNumber(principal+interest,'Historical liability'):0});
    }
    return {asOfDate,positions:calculateNetWorthPositions(parts)};
  });
}
