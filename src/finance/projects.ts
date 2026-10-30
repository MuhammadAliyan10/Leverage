import type { CurrencyCode } from './domain.ts';

export type ProjectLifecycle = 'planned' | 'active' | 'completed' | 'archived';
export type ProjectKind = 'personal' | 'shared' | 'work' | 'custom';
export type ProjectSplitMethod = 'equal' | 'percentage' | 'fixed' | 'weighted' | 'individual';

export interface ProjectShareInput {
  memberId: string;
  value?: number;
}

export interface ProjectShare {
  memberId: string;
  amountMinor: number;
}

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

function validAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_MINOR) {
    throw new Error('Project amounts must be positive safe integer minor units.');
  }
}

/** Deterministically assigns fractional minor units by input order and reconciles exactly. */
function allocateProportionally(amountMinor: number, entries: readonly ProjectShareInput[]): ProjectShare[] {
  validAmount(amountMinor);
  if (entries.length === 0) throw new Error('Choose at least one project participant.');
  const seen = new Set<string>();
  const weights = entries.map(({ memberId, value }) => {
    if (!memberId.trim() || seen.has(memberId)) throw new Error('Project participants must be unique and valid.');
    seen.add(memberId);
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('Split weights must be positive safe integers.');
    return BigInt(value as number);
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  const amount = BigInt(amountMinor);
  let allocated = 0n;
  const result = weights.map((weight, index) => {
    const share = index === weights.length - 1 ? amount - allocated : amount * weight / totalWeight;
    allocated += share;
    return { memberId: entries[index]!.memberId, amountMinor: Number(share) };
  });
  if (allocated !== amount) throw new Error('Project split could not be reconciled.');
  return result;
}

export function splitProjectExpense(input: {
  amountMinor: number;
  method: ProjectSplitMethod;
  participants: readonly ProjectShareInput[];
}): ProjectShare[] {
  const { amountMinor, method, participants } = input;
  validAmount(amountMinor);
  if (participants.length === 0) throw new Error('Choose at least one project participant.');
  if (method === 'individual' && participants.length !== 1) throw new Error('An individual expense must have exactly one participant.');
  if (method === 'equal' || method === 'individual') {
    return allocateProportionally(amountMinor, participants.map(({ memberId }) => ({ memberId, value: 1 })));
  }
  if (method === 'weighted') return allocateProportionally(amountMinor, participants);
  if (method === 'percentage') {
    const total = participants.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
    if (total !== 10_000) throw new Error('Percentage shares must total exactly 100%.');
    return allocateProportionally(amountMinor, participants);
  }
  if (method === 'fixed') {
    const seen = new Set<string>();
    const shares = participants.map(({ memberId, value }) => {
      if (!memberId.trim() || seen.has(memberId)) throw new Error('Project participants must be unique and valid.');
      seen.add(memberId);
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_MINOR) throw new Error('Fixed shares must be non-negative safe integer minor units.');
      return { memberId, amountMinor: value as number };
    });
    if (shares.reduce((sum, share) => sum + share.amountMinor, 0) !== amountMinor) throw new Error('Fixed shares must equal the expense amount exactly.');
    return shares;
  }
  throw new Error('Choose a supported project split method.');
}

export interface ProjectLedgerTotals {
  budgetMinor: number;
  expenseMinor: number;
  refundMinor: number;
  contributionMinor: number;
  fundSpendMinor: number;
  externalRevenueMinor: number;
}

export function calculateProjectTotals(events: readonly {
  type: 'expense' | 'refund' | 'contribution' | 'fund_spend' | 'revenue';
  amountMinor: number;
}[], budgetMinor = 0): ProjectLedgerTotals {
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) throw new Error('Project budget must be a non-negative safe integer.');
  const totals: ProjectLedgerTotals = { budgetMinor, expenseMinor: 0, refundMinor: 0, contributionMinor: 0, fundSpendMinor: 0, externalRevenueMinor: 0 };
  for (const event of events) {
    validAmount(event.amountMinor);
    const key = event.type === 'expense' || event.type === 'fund_spend' ? 'expenseMinor' : event.type === 'refund' ? 'refundMinor' : event.type === 'contribution' ? 'contributionMinor' : event.type === 'revenue' ? 'externalRevenueMinor' : 'fundSpendMinor';
    const value = totals[key] + event.amountMinor;
    if (!Number.isSafeInteger(value)) throw new Error('Project totals exceed the supported amount range.');
    totals[key] = value;
    if (event.type === 'fund_spend') {
      const fundSpend = totals.fundSpendMinor + event.amountMinor;
      if (!Number.isSafeInteger(fundSpend)) throw new Error('Project totals exceed the supported amount range.');
      totals.fundSpendMinor = fundSpend;
    }
  }
  return totals;
}

export function projectRemainingBudget(totals: ProjectLedgerTotals): number {
  return totals.budgetMinor - totals.expenseMinor + totals.refundMinor;
}

export function projectFundBalance(totals: ProjectLedgerTotals): number {
  return totals.contributionMinor - totals.fundSpendMinor;
}

export function assertProjectCurrency(currency: string): asserts currency is CurrencyCode {
  if (!['PKR', 'USD', 'GBP', 'EUR', 'AED', 'SAR'].includes(currency)) throw new Error('Choose a supported project currency.');
}
