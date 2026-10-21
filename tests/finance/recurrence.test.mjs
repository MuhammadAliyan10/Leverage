import assert from 'node:assert/strict';
import test from 'node:test';
import { enumerateDueOccurrences, nextOccurrenceDate } from '../../src/finance/recurrence.ts';

test('monthly recurrence clamps to month end but recovers the original anchor day', () => {
  assert.equal(nextOccurrenceDate('2026-01-31','2026-01-31','monthly'),'2026-02-28');
  assert.equal(nextOccurrenceDate('2026-01-31','2026-02-28','monthly'),'2026-03-31');
  assert.equal(nextOccurrenceDate('2024-02-29','2024-02-29','yearly'),'2025-02-28');
  assert.equal(nextOccurrenceDate('2024-02-29','2025-02-28','yearly'),'2026-02-28');
});

test('daily, weekly and catch-up occurrence dates are calendar-day based and bounded', () => {
  assert.equal(nextOccurrenceDate('2026-10-17','2026-10-17','daily'),'2026-10-18');
  assert.equal(nextOccurrenceDate('2026-10-17','2026-10-17','weekly'),'2026-10-24');
  assert.deepEqual(enumerateDueOccurrences({startDate:'2026-01-31',nextDueDate:'2026-01-31',endDate:null,frequency:'monthly',throughDate:'2026-04-30'}),{
    occurrenceDates:['2026-01-31','2026-02-28','2026-03-31','2026-04-30'],nextDueDate:'2026-05-31',
  });
  assert.deepEqual(enumerateDueOccurrences({startDate:'2026-01-01',nextDueDate:'2026-01-01',endDate:'2026-01-03',frequency:'daily',throughDate:'2026-01-10'}),{
    occurrenceDates:['2026-01-01','2026-01-02','2026-01-03'],nextDueDate:'2026-01-04',
  });
  assert.throws(()=>enumerateDueOccurrences({startDate:'2026-01-01',nextDueDate:'2026-01-01',endDate:null,frequency:'daily',throughDate:'2026-01-10',maxOccurrences:2}),/too many missed/);
});

test('invalid calendar dates and unsupported scheduling boundaries are rejected',()=>{
  assert.throws(()=>nextOccurrenceDate('2026-02-30','2026-02-30','monthly'),/valid calendar day/);
  assert.throws(()=>enumerateDueOccurrences({startDate:'2026-03-01',nextDueDate:'2026-02-01',endDate:null,frequency:'weekly',throughDate:'2026-04-01'}),/precedes/);
});
