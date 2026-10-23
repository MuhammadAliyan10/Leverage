export const INSIGHTS_PERIODS = ['This month', 'Last month', 'Last 3 months', 'Last 6 months', 'This year'] as const;
export type InsightsPeriod = (typeof INSIGHTS_PERIODS)[number];

export interface InsightsDateRange { start: Date; end: Date }
export interface InsightsPeriodRanges { current: InsightsDateRange; previous: InsightsDateRange }

function monthStart(year: number, month: number): Date { return new Date(year, month, 1); }
function addCalendarDays(date: Date, days: number): Date { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days); }
function addCalendarMonths(date: Date, months: number): Date { return monthStart(date.getFullYear(), date.getMonth() + months); }
function startOfYear(date: Date, offset = 0): Date { return new Date(date.getFullYear() + offset, 0, 1); }

/** Local-calendar ranges end tomorrow, so future-dated entries are never included in "to date" periods. */
export function getInsightsPeriodRanges(period: InsightsPeriod, now = new Date()): InsightsPeriodRanges {
  if (!Number.isFinite(now.getTime())) throw new Error('Insights reference date is invalid.');
  const tomorrow = addCalendarDays(now, 1);
  let currentStart: Date;
  let previousStart: Date;
  let previousEnd: Date;
  if (period === 'This month') {
    currentStart = monthStart(now.getFullYear(), now.getMonth());
    previousStart = addCalendarMonths(currentStart, -1);
    previousEnd = new Date(previousStart.getFullYear(), previousStart.getMonth(), Math.min(now.getDate(), new Date(previousStart.getFullYear(), previousStart.getMonth() + 1, 0).getDate()) + 1);
  } else if (period === 'Last month') {
    currentStart = addCalendarMonths(monthStart(now.getFullYear(), now.getMonth()), -1);
    previousStart = addCalendarMonths(currentStart, -1);
    previousEnd = currentStart;
  } else if (period === 'Last 3 months' || period === 'Last 6 months') {
    const count = period === 'Last 3 months' ? 3 : 6;
    currentStart = addCalendarMonths(monthStart(now.getFullYear(), now.getMonth()), 1 - count);
    previousStart = addCalendarMonths(currentStart, -count);
    previousEnd = currentStart;
  } else {
    currentStart = startOfYear(now);
    previousStart = startOfYear(now, -1);
    previousEnd = new Date(previousStart.getFullYear(), now.getMonth(), Math.min(now.getDate(), new Date(previousStart.getFullYear(), now.getMonth() + 1, 0).getDate()) + 1);
  }
  return { current: { start: currentStart, end: tomorrow }, previous: { start: previousStart, end: previousEnd } };
}

export function calendarDaysInRange(range: InsightsDateRange): number {
  const start = Date.UTC(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
  const end = Date.UTC(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Insights date range is invalid.');
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

/** Rounded average in currency minor units. Source totals stay exact integer minor units. */
export function calculateDailyAverageMinor(totalMinor: number, days: number): number {
  if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(days) || days < 1) throw new Error('Daily average inputs are invalid.');
  const value = BigInt(totalMinor);
  const divisor = BigInt(days);
  const sign = value < 0n ? -1n : 1n;
  const absolute = value < 0n ? -value : value;
  const rounded = (absolute + divisor / 2n) / divisor;
  const result = sign * rounded;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Daily average is outside the supported range.');
  return Number(result);
}

/** A percentage change is unavailable when the comparison period had no activity. */
export function calculatePeriodChangePercent(currentMinor: number, previousMinor: number): number | null {
  if (!Number.isSafeInteger(currentMinor) || !Number.isSafeInteger(previousMinor)) throw new Error('Period comparison totals are invalid.');
  if (previousMinor === 0) return null;
  return ((currentMinor - previousMinor) / Math.abs(previousMinor)) * 100;
}
