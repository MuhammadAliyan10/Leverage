export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

function parseDay(value: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Recurring dates must use YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Recurring date is not a valid calendar day.');
  }
  return { year, month, day };
}

function isoDay(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Advances from the original scheduled date; monthly/yearly dates clamp at month end. */
export function nextOccurrenceDate(startDate: string, previousDate: string, frequency: RecurrenceFrequency): string {
  if (!['daily','weekly','monthly','yearly'].includes(frequency)) throw new Error('Recurrence frequency is unsupported.');
  const anchor = parseDay(startDate);
  const previous = parseDay(previousDate);
  if (previousDate < startDate) throw new Error('An occurrence cannot precede its schedule start date.');
  if (frequency === 'daily' || frequency === 'weekly') {
    const date = new Date(Date.UTC(previous.year, previous.month - 1, previous.day + (frequency === 'daily' ? 1 : 7)));
    return isoDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const monthOffset = frequency === 'monthly' ? 1 : 12;
  const monthIndex = previous.year * 12 + previous.month - 1 + monthOffset;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return isoDay(year, month, Math.min(anchor.day, lastDay));
}

/** Returns every due day through today, inclusive. The caller persists each with a unique key. */
export function enumerateDueOccurrences(input: {
  startDate: string;
  nextDueDate: string;
  endDate: string | null;
  frequency: RecurrenceFrequency;
  throughDate: string;
  maxOccurrences?: number;
}): { occurrenceDates: string[]; nextDueDate: string } {
  if (!['daily','weekly','monthly','yearly'].includes(input.frequency)) throw new Error('Recurrence frequency is unsupported.');
  parseDay(input.startDate);
  parseDay(input.nextDueDate);
  parseDay(input.throughDate);
  if (input.endDate !== null) parseDay(input.endDate);
  if (input.nextDueDate < input.startDate) throw new Error('Next recurring date precedes the start date.');
  if (input.endDate !== null && input.endDate < input.startDate) throw new Error('Schedule end date precedes its start date.');
  const max = input.maxOccurrences ?? 5000;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Occurrence limit is invalid.');
  const occurrenceDates: string[] = [];
  let cursor = input.nextDueDate;
  while (cursor <= input.throughDate && (input.endDate === null || cursor <= input.endDate)) {
    if (occurrenceDates.length >= max) throw new Error('Schedule has too many missed occurrences to safely generate at once.');
    occurrenceDates.push(cursor);
    cursor = nextOccurrenceDate(input.startDate, cursor, input.frequency);
  }
  return { occurrenceDates, nextDueDate: cursor };
}
