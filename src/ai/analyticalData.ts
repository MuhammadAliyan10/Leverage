import { localDb } from '../db/local/client';
import { calculateFinancialReport } from '../finance/reporting';
import { isCurrencyCode } from '../finance/domain';
import { assertAIReadAllowed, type AIProfileConfig } from './config';
import { aiProfileStore } from './profileStore';

export interface AIDataAccessContext {
  activeProfileId: string | null;
  requestedProfileId: string;
}

async function assertCurrentAIReadAllowed(
  context: AIDataAccessContext,
  scope: 'aggregatedFinancialInsights' | 'detailedFinancialRecords' | 'projectsIntelligence',
): Promise<void> {
  if (!context.activeProfileId || context.activeProfileId !== context.requestedProfileId) {
    throw new Error('AI access is limited to the active local profile.');
  }
  const config: AIProfileConfig = await aiProfileStore.load(context.activeProfileId);
  assertAIReadAllowed({ ...context, config, scope });
}

export interface AggregatedFinancialInsights {
  period: { startDate: string; endDate: string };
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  expenseCount: number;
  categories: { label: string; netAmountMinor: number }[];
  excludedCurrencies: string[];
}

export interface SelectedFinancialRecords {
  records: { date: string; type: string; currency: string; amountMinor: number; category: string }[];
}

function validatePeriod(startDate: string, endDate: string, maximumDays: number): void {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > maximumDays * 86_400_000) {
    throw new Error(`Choose a valid reporting period of no more than ${maximumDays} days.`);
  }
}

/**
 * Read-only allowlisted capability. Uses the same report query and deterministic
 * calculation as Insights; transaction IDs, account identifiers and notes never
 * leave this local selector.
 */
export async function readAggregatedFinancialInsights(
  context: AIDataAccessContext,
  input: { startDate: string; endDate: string; currency: string },
): Promise<AggregatedFinancialInsights> {
  await assertCurrentAIReadAllowed(context, 'aggregatedFinancialInsights');
  validatePeriod(input.startDate, input.endDate, 366);
  if (!isCurrencyCode(input.currency)) throw new Error('Choose a supported reporting currency.');
  const rows = await localDb.transaction.findReportRows({
    ownerId: context.activeProfileId!,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const report = calculateFinancialReport(rows, input.currency, { startDate: input.startDate, endDate: input.endDate });
  return {
    period: { startDate: input.startDate, endDate: input.endDate },
    currency: report.currency,
    incomeMinor: report.incomeMinor,
    expenseMinor: report.expenseMinor,
    netMinor: report.netMinor,
    expenseCount: report.expenseCount,
    categories: report.categoryTotals.filter((entry) => entry.amountMinor !== 0).slice(0, 12)
      .map((entry) => ({ label: entry.category, netAmountMinor: entry.amountMinor })),
    excludedCurrencies: report.excludedCurrencies.slice(0, 12),
  };
}

/** User-selected detail only; account IDs, names, notes and transaction IDs are never returned. */
export async function readSelectedFinancialRecords(
  context: AIDataAccessContext,
  transactionIds: readonly string[],
): Promise<SelectedFinancialRecords> {
  await assertCurrentAIReadAllowed(context, 'detailedFinancialRecords');
  if (transactionIds.length < 1 || transactionIds.length > 50) {
    throw new Error('Select between 1 and 50 transactions for detailed analysis.');
  }
  const records = await localDb.transaction.findSelectedForAI(context.activeProfileId!, transactionIds);
  return {
    records: records.map(({ date, type, currency, amountMinor, category }) => ({ date, type, currency, amountMinor, category })),
  };
}

export interface AIProjectOverview {
  project: { name: string; currency: string; startDate: string; endDate: string | null };
  budgetMinor: number | null;
  remainingBudgetMinor: number | null;
  spentMinor: number;
  refundedMinor: number;
  fundBalanceMinor: number;
  members: { displayName: string; role: 'owner' | 'editor' | 'viewer'; contributionTargetMinor: number | null }[];
  expenseCategories: { category: string; grossAmountMinor: number; count: number }[];
}

/** Only owner-scoped project records are available in the current local store. */
export async function readAuthorizedProjectOverview(
  context: AIDataAccessContext,
  projectId: string,
): Promise<AIProjectOverview> {
  await assertCurrentAIReadAllowed(context, 'projectsIntelligence');
  if (!projectId.trim() || projectId.length > 100) throw new Error('Choose a valid project.');
  const ownerId = context.activeProfileId!;
  const project = await localDb.projects.get(ownerId, projectId);
  const expenses = await localDb.projects.expenses(ownerId, projectId);
  const categories = new Map<string, { amount: bigint; count: number }>();
  for (const expense of expenses) {
    const current = categories.get(expense.category) ?? { amount: 0n, count: 0 };
    current.amount += BigInt(expense.amountMinor);
    current.count += 1;
    categories.set(expense.category, current);
  }
  return {
    project: { name: project.name, currency: project.currency, startDate: project.startDate, endDate: project.endDate },
    budgetMinor: project.budgetMinor,
    remainingBudgetMinor: project.remainingBudgetMinor,
    spentMinor: project.expenseMinor - project.refundMinor,
    refundedMinor: project.refundMinor,
    fundBalanceMinor: project.fundBalanceMinor,
    members: project.members.slice(0, 50).map((member) => ({
      displayName: member.displayName,
      role: member.role,
      contributionTargetMinor: member.targetContributionMinor ?? null,
    })),
    expenseCategories: [...categories.entries()].slice(0, 20).map(([category, value]) => {
      if (value.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Project category total exceeds the supported range.');
      return { category, grossAmountMinor: Number(value.amount), count: value.count };
    }),
  };
}
