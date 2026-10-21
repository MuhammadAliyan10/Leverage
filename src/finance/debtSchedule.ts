import { nextOccurrenceDate } from './recurrence.ts';

export interface DebtRepaymentPlanInput {
  principalMinor: number;
  installmentAmountMinor: number;
  frequency: 'monthly' | 'yearly';
  firstDueDate: string;
  installmentCount: number;
  interestMethod: 'none' | 'fixed' | 'declining';
  annualRateBps: number;
  /** Number of schedule periods in a year. Monthly schedules use 12, yearly use 1. */
}

export interface PlannedInstallment {
  sequence: number;
  dueDate: string;
  principalMinor: number;
  interestMinor: number;
  totalMinor: number;
  remainingPrincipalMinor: number;
  status: 'planned' | 'overdue';
}

/**
 * Produces projections only; callers must never post these rows as cash events.
 * Interest uses integer half-up rounding on each period's exact rational amount.
 * Fixed interest uses original principal; declining interest uses prior projected
 * principal. The final payment is capped at actual principal plus interest.
 */
export function projectDebtRepayments(input: DebtRepaymentPlanInput, asOfDate: string): PlannedInstallment[] {
  if (!Number.isSafeInteger(input.principalMinor) || input.principalMinor <= 0 ||
      !Number.isSafeInteger(input.installmentAmountMinor) || input.installmentAmountMinor <= 0 ||
      !Number.isSafeInteger(input.installmentCount) || input.installmentCount < 1 || input.installmentCount > 600 ||
      !Number.isSafeInteger(input.annualRateBps) || input.annualRateBps < 0 || input.annualRateBps > 100000 ||
      !['monthly', 'yearly'].includes(input.frequency) || !['none', 'fixed', 'declining'].includes(input.interestMethod) ||
      (input.interestMethod === 'none' && input.annualRateBps !== 0)) throw new Error('Repayment schedule terms are invalid.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error('Repayment schedule as-of date must use YYYY-MM-DD.');
  const periodsPerYear = input.frequency === 'monthly' ? 12n : 1n;
  const rate = BigInt(input.annualRateBps);
  const interestFor = (basis: bigint) => {
    if (input.interestMethod === 'none' || rate === 0n) return 0n;
    const numerator = basis * rate;
    const denominator = 10000n * periodsPerYear;
    return (numerator + denominator / 2n) / denominator;
  };
  let outstanding = BigInt(input.principalMinor);
  const original = outstanding;
  let dueDate = input.firstDueDate;
  // Validates the first due date through the date recurrence helper.
  dueDate = nextOccurrenceDate(dueDate, dueDate, input.frequency);
  const dates = [input.firstDueDate];
  while (dates.length < input.installmentCount) {
    dates.push(dueDate);
    dueDate = nextOccurrenceDate(input.firstDueDate, dueDate, input.frequency);
  }
  return dates.map((date, index) => {
    const interest = interestFor(input.interestMethod === 'fixed' ? original : outstanding);
    if (BigInt(input.installmentAmountMinor) <= interest && interest < outstanding + interest) {
      throw new Error('Installment amount does not cover the projected interest; increase the payment or revise explicit terms.');
    }
    const principal = outstanding < BigInt(input.installmentAmountMinor) - interest ? outstanding : BigInt(input.installmentAmountMinor) - interest;
    const total = principal + interest;
    outstanding -= principal;
    return {
      sequence: index + 1,
      dueDate: date,
      principalMinor: Number(principal),
      interestMinor: Number(interest),
      totalMinor: Number(total),
      remainingPrincipalMinor: Number(outstanding),
      status: date < asOfDate ? 'overdue' as const : 'planned' as const,
    };
  });
}
