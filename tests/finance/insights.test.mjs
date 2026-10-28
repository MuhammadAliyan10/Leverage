import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDailyAverageMinor, calculatePeriodChangePercent, calendarDaysInRange, getInsightsPeriodRanges } from '../../src/finance/insights.ts';

test('period windows respect local calendar boundaries and compare like-length periods', () => {
  const now = new Date(2026, 4, 31, 14, 30);
  const month = getInsightsPeriodRanges('This month', now);
  assert.equal(month.current.start.getDate(), 1);
  assert.equal(month.current.end.getMonth(), 5);
  assert.equal(month.current.end.getDate(), 1);
  assert.equal(month.previous.start.getMonth(), 3);
  assert.equal(month.previous.end.getMonth(), 4);
  assert.equal(month.previous.end.getDate(), 1);

  const quarter = getInsightsPeriodRanges('Last 3 months', now);
  assert.equal(quarter.current.start.getMonth(), 2);
  assert.equal(quarter.current.end.getMonth(), 5);
  assert.equal(quarter.previous.start.getMonth(), 11);
  assert.equal(quarter.previous.end.getMonth(), 2);

  const year = getInsightsPeriodRanges('This year', now);
  assert.equal(year.current.start.getFullYear(), 2026);
  assert.equal(year.previous.start.getFullYear(), 2025);
  assert.equal(year.previous.end.getMonth(), 5);
});

test('daily average rounds integer minor units and handles signed net refunds', () => {
  assert.equal(calculateDailyAverageMinor(100, 3), 33);
  assert.equal(calculateDailyAverageMinor(101, 2), 51);
  assert.equal(calculateDailyAverageMinor(-101, 2), -51);
  assert.throws(() => calculateDailyAverageMinor(1.5, 1), /invalid/);
  assert.throws(() => calculateDailyAverageMinor(1, 0), /invalid/);
});

test('period comparison is unavailable for a zero baseline and uses magnitude for negatives', () => {
  assert.equal(calculatePeriodChangePercent(100, 0), null);
  assert.equal(calculatePeriodChangePercent(150, 100), 50);
  assert.equal(calculatePeriodChangePercent(-150, -100), -50);
});

test('custom Insights dates use inclusive local days and an equal-length preceding comparison', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Karachi';
  try {
    const ranges = getInsightsPeriodRanges('Custom', new Date(2026, 9, 28, 12), { startDate: '2026-10-01', endDate: '2026-10-03' });
    assert.equal(ranges.current.start.getFullYear(), 2026);
    assert.equal(ranges.current.start.getMonth(), 9);
    assert.equal(ranges.current.start.getDate(), 1);
    assert.equal(ranges.current.end.getDate(), 4);
    assert.equal(ranges.previous.start.getDate(), 28);
    assert.equal(ranges.previous.start.getMonth(), 8);
    assert.equal(ranges.previous.end.getDate(), 1);
    assert.equal(ranges.previous.end.getMonth(), 9);
    assert.equal(calendarDaysInRange(ranges.current), calendarDaysInRange(ranges.previous));
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('custom Insights range validates ordering, future dates, and a 366-day maximum', () => {
  const now = new Date(2026, 9, 28, 12);
  assert.throws(() => getInsightsPeriodRanges('Custom', now, { startDate: '2026-10-10', endDate: '2026-10-09' }), /End date/);
  assert.throws(() => getInsightsPeriodRanges('Custom', now, { startDate: '2026-10-28', endDate: '2026-10-29' }), /future/);
  assert.throws(() => getInsightsPeriodRanges('Custom', now, { startDate: '2025-10-26', endDate: '2026-10-27' }), /366 days/);
  assert.throws(() => getInsightsPeriodRanges('Custom', now, { startDate: '2026-02-30', endDate: '2026-02-28' }), /valid/);
});
