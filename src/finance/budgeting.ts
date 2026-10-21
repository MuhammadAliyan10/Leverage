import type { FinancialReport } from './reporting.ts';

export type BudgetRolloverPolicy = 'reset' | 'carry_unused';

export interface BudgetAllocation {
  category: string;
  amountMinor: number;
}

export interface BudgetSnapshotInput {
  ownerId: string;
  currency: string;
  reportOwnerId: string;
  startDate: string;
  endDate: string;
  allocations: readonly BudgetAllocation[];
  report: FinancialReport;
}

export interface BudgetCategoryStatus extends BudgetAllocation {
  spentMinor: number;
  remainingMinor: number;
  percentUsed: number;
}

export interface BudgetSnapshot {
  ownerId: string;
  currency: string;
  startDate: string;
  endDate: string;
  allocatedMinor: number;
  spentMinor: number;
  remainingMinor: number;
  categories: BudgetCategoryStatus[];
}

function assertAmount(amountMinor: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer minor-unit amount.`);
  }
}

function safeMinor(value: bigint, label: string): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return Number(value);
}

/**
 * Compares a complete, same-profile, same-currency report with period allocations.
 * Report rows are expected to come from the full financial-report query, never a page.
 */
export function calculateBudgetSnapshot(input: BudgetSnapshotInput): BudgetSnapshot {
  if (!input.ownerId.trim() || !input.currency.trim()) throw new Error('Budget profile and currency are required.');
  if (input.reportOwnerId !== input.ownerId) throw new Error('Budget and report profiles must match.');
  const start = new Date(input.startDate).getTime();
  const end = new Date(input.endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Budget period is invalid.');
  if (input.report.currency !== input.currency) throw new Error('Budget and report currencies must match.');

  const allocationByCategory = new Map<string, bigint>();
  for (const allocation of input.allocations) {
    if (!allocation.category.trim()) throw new Error('Budget category is required.');
    assertAmount(allocation.amountMinor, `Budget for ${allocation.category}`, true);
    if (allocationByCategory.has(allocation.category)) throw new Error(`Duplicate budget category: ${allocation.category}.`);
    allocationByCategory.set(allocation.category, BigInt(allocation.amountMinor));
  }

  const spentByCategory = new Map<string, bigint>();
  for (const category of input.report.categoryTotals) {
    if (!category.category.trim() || !Number.isSafeInteger(category.amountMinor)) throw new Error('Report category total is invalid.');
    // Negative category totals are valid when refunds exceed period purchases.
    spentByCategory.set(category.category, BigInt(category.amountMinor));
  }

  const categories = new Set([...allocationByCategory.keys(), ...spentByCategory.keys()]);
  const statuses = Array.from(categories).sort().map((category) => {
    const allocated = allocationByCategory.get(category) ?? 0n;
    const spent = spentByCategory.get(category) ?? 0n;
    const remaining = allocated - spent;
    const percentUsed = allocated === 0n ? (spent > 0n ? 100 : 0) : Number((spent * 10000n) / allocated) / 100;
    return {
      category,
      amountMinor: safeMinor(allocated, `Budget for ${category}`),
      spentMinor: safeMinor(spent, `Spending for ${category}`),
      remainingMinor: safeMinor(remaining, `Remaining budget for ${category}`),
      percentUsed,
    };
  });
  const allocated = statuses.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n);
  const spent = statuses.reduce((sum, item) => sum + BigInt(item.spentMinor), 0n);
  return {
    ownerId: input.ownerId,
    currency: input.currency,
    startDate: input.startDate,
    endDate: input.endDate,
    allocatedMinor: safeMinor(allocated, 'Total allocation'),
    spentMinor: safeMinor(spent, 'Total spending'),
    remainingMinor: safeMinor(allocated - spent, 'Total remaining budget'),
    categories: statuses,
  };
}

/** Starts the next monthly period while carrying only the previous unused amount when requested. */
export function rollMonthlyBudget(
  year: number,
  monthIndex: number,
  ownerId: string,
  currency: string,
  allocations: readonly BudgetAllocation[],
  prior: BudgetSnapshot | null,
  policy: BudgetRolloverPolicy,
): { startDate: string; endDate: string; allocations: BudgetAllocation[] } {
  if (!ownerId.trim() || !currency.trim()) throw new Error('Budget profile and currency are required.');
  if (!Number.isInteger(year) || year < 1 || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new Error('Budget month is invalid.');
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const carriedByCategory = new Map<string, bigint>();
  if (policy === 'carry_unused' && prior) {
    if (prior.ownerId !== ownerId) throw new Error('Budget rollover profiles must match.');
    if (prior.currency !== currency) throw new Error('Budget rollover currencies must match.');
    for (const category of prior.categories) carriedByCategory.set(category.category, BigInt(Math.max(0, category.remainingMinor)));
  } else if (policy !== 'reset' && policy !== 'carry_unused') {
    throw new Error('Budget rollover policy is unsupported.');
  }
  const nextAllocations = allocations.map((allocation) => {
    if (!allocation.category.trim()) throw new Error('Budget category is required.');
    assertAmount(allocation.amountMinor, `Budget for ${allocation.category}`, true);
    const carry = carriedByCategory.get(allocation.category) ?? 0n;
    return { category: allocation.category, amountMinor: safeMinor(BigInt(allocation.amountMinor) + carry, `Rolled budget for ${allocation.category}`) };
  });
  return { startDate: start.toISOString(), endDate: end.toISOString(), allocations: nextAllocations };
}

export interface SavingsContribution {
  ownerId: string;
  currency: string;
  amountMinor: number;
}

export interface SavingsGoalProgress {
  targetMinor: number;
  contributedMinor: number;
  remainingMinor: number;
  percentComplete: number;
  overfundedMinor: number;
}

/** Calculates goal progress from same-profile, same-currency contributions in minor units. */
export function calculateSavingsGoalProgress(input: {
  ownerId: string;
  currency: string;
  targetMinor: number;
  contributions: readonly SavingsContribution[];
}): SavingsGoalProgress {
  if (!input.ownerId.trim() || !input.currency.trim()) throw new Error('Savings goal profile and currency are required.');
  assertAmount(input.targetMinor, 'Savings goal target');
  let contributed = 0n;
  for (const contribution of input.contributions) {
    if (contribution.ownerId !== input.ownerId) throw new Error('Savings contributions must belong to the goal profile.');
    if (contribution.currency !== input.currency) throw new Error('Savings contributions must use the goal currency.');
    assertAmount(contribution.amountMinor, 'Savings contribution');
    contributed += BigInt(contribution.amountMinor);
  }
  const target = BigInt(input.targetMinor);
  return {
    targetMinor: input.targetMinor,
    contributedMinor: safeMinor(contributed, 'Total savings contributions'),
    remainingMinor: safeMinor(target > contributed ? target - contributed : 0n, 'Remaining savings goal'),
    percentComplete: Number((contributed * 10000n) / target) / 100,
    overfundedMinor: safeMinor(contributed > target ? contributed - target : 0n, 'Savings goal overfunding'),
  };
}

export interface EssentialMonthlyExpense {
  amountMinor: number;
  currency: string;
}

/** Estimates an emergency-fund target from essential costs in exactly one currency. */
export function calculateEmergencyFundTarget(
  currency: string,
  essentialMonthlyExpenses: readonly EssentialMonthlyExpense[],
  months = 6,
): number {
  if (!currency.trim()) throw new Error('Emergency-fund currency is required.');
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new Error('Emergency-fund months must be between 1 and 60.');
  const monthly = essentialMonthlyExpenses.reduce((sum, expense) => {
    if (expense.currency !== currency) throw new Error('Emergency-fund expenses must use one currency.');
    assertAmount(expense.amountMinor, 'Essential monthly expense', true);
    return sum + BigInt(expense.amountMinor);
  }, 0n);
  return safeMinor(monthly * BigInt(months), 'Emergency-fund target');
}
