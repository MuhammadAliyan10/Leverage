import { isCurrencyCode, normalizeAccountType, type CurrencyCode } from './domain.ts';

export interface LiquidityAccountInput {
  id: string;
  currency: string;
  type: string;
  archivedAt: string | null;
  balanceMinor: number;
}

export interface AccountReservationInput {
  accountId: string;
  amountMinor: number;
}

export interface LiquidityPosition {
  currency: CurrencyCode;
  currentBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  physicalCashBalanceMinor: number;
  physicalCashReservedMinor: number;
  physicalCashAvailableMinor: number;
  bankAndMobileBalanceMinor: number;
  bankAndMobileReservedMinor: number;
  bankAndMobileAvailableMinor: number;
}

export interface AvailableToSpendBillInput {
  id: string;
  currency: string;
  amountMinor: number;
  paidMinor: number;
  dueDate: string;
  status: string;
}

export interface AvailableToSpendPosition {
  currency: CurrencyCode;
  unreservedMinor: number;
  unpaidBillsDueMinor: number;
  availableToSpendMinor: number;
}

function safeMinor(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`${label} is outside the supported range.`);
  return Number(value);
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]) - 1; const day = Number(match[3]);
  const parsed = new Date(year, month, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === day;
}

/** Calculates available balances only from active liquid accounts and their own earmarks. */
export function calculateLiquidityPositions(
  accounts: readonly LiquidityAccountInput[],
  reservations: readonly AccountReservationInput[],
): LiquidityPosition[] {
  const accountIds = new Set<string>();
  const reservationsByAccount = new Map<string, bigint>();
  for (const account of accounts) {
    if (!account.id.trim() || accountIds.has(account.id) || !Number.isSafeInteger(account.balanceMinor)) throw new Error('A liquid account record is invalid.');
    accountIds.add(account.id);
  }
  for (const reservation of reservations) {
    if (!reservation.accountId.trim() || !Number.isSafeInteger(reservation.amountMinor) || reservation.amountMinor < 0 || reservationsByAccount.has(reservation.accountId)) {
      throw new Error('An account reservation is invalid.');
    }
    reservationsByAccount.set(reservation.accountId, BigInt(reservation.amountMinor));
  }

  const balances = new Map<CurrencyCode, bigint>();
  const reserved = new Map<CurrencyCode, bigint>();
  const physicalCashBalances = new Map<CurrencyCode, bigint>();
  const physicalCashReserved = new Map<CurrencyCode, bigint>();
  const bankAndMobileBalances = new Map<CurrencyCode, bigint>();
  const bankAndMobileReserved = new Map<CurrencyCode, bigint>();
  for (const account of accounts) {
    if (account.archivedAt !== null || !['cash', 'bank', 'savings', 'wallet'].includes(normalizeAccountType(account.type) ?? '')) continue;
    if (!isCurrencyCode(account.currency)) throw new Error(`Account ${account.id} has an unsupported currency.`);
    const currency = account.currency;
    const balance = BigInt(account.balanceMinor);
    const accountReservation = reservationsByAccount.get(account.id) ?? 0n;
    balances.set(currency, (balances.get(currency) ?? 0n) + BigInt(account.balanceMinor));
    reserved.set(currency, (reserved.get(currency) ?? 0n) + accountReservation);
    const isPhysicalCash = normalizeAccountType(account.type) === 'cash';
    const balanceByType = isPhysicalCash ? physicalCashBalances : bankAndMobileBalances;
    const reservedByType = isPhysicalCash ? physicalCashReserved : bankAndMobileReserved;
    balanceByType.set(currency, (balanceByType.get(currency) ?? 0n) + balance);
    reservedByType.set(currency, (reservedByType.get(currency) ?? 0n) + accountReservation);
  }

  return [...new Set([...balances.keys(), ...reserved.keys()])].sort().map((currency) => {
    const currentBalanceMinor = safeMinor(balances.get(currency) ?? 0n, 'Liquid balance');
    const reservedMinor = safeMinor(reserved.get(currency) ?? 0n, 'Reserved balance');
    const physicalCashBalanceMinor = safeMinor(physicalCashBalances.get(currency) ?? 0n, 'Physical cash balance');
    const physicalCashReservedMinor = safeMinor(physicalCashReserved.get(currency) ?? 0n, 'Physical cash reservation');
    const bankAndMobileBalanceMinor = safeMinor(bankAndMobileBalances.get(currency) ?? 0n, 'Bank and mobile balance');
    const bankAndMobileReservedMinor = safeMinor(bankAndMobileReserved.get(currency) ?? 0n, 'Bank and mobile reservation');
    return {
      currency,
      currentBalanceMinor,
      reservedMinor,
      availableMinor: safeMinor(BigInt(currentBalanceMinor) - BigInt(reservedMinor), 'Available balance'),
      physicalCashBalanceMinor,
      physicalCashReservedMinor,
      physicalCashAvailableMinor: safeMinor(BigInt(physicalCashBalanceMinor) - BigInt(physicalCashReservedMinor), 'Available physical cash'),
      bankAndMobileBalanceMinor,
      bankAndMobileReservedMinor,
      bankAndMobileAvailableMinor: safeMinor(BigInt(bankAndMobileBalanceMinor) - BigInt(bankAndMobileReservedMinor), 'Available bank and mobile funds'),
    };
  });
}

/**
 * Estimates what remains through a period end from current unreserved liquid
 * balances, less unpaid recorded bills due by that date. Bills already paid,
 * skipped, cancelled, or due after the period are excluded. Reservations have
 * already been removed from `availableMinor` and must not be subtracted again.
 */
export function calculateAvailableToSpend(
  liquidity: readonly Pick<LiquidityPosition, 'currency' | 'availableMinor'>[],
  bills: readonly AvailableToSpendBillInput[],
  periodEndDate: string,
): AvailableToSpendPosition[] {
  if (!isCalendarDate(periodEndDate)) {
    throw new Error('Available-to-spend period end date is invalid.');
  }
  const balances = new Map<CurrencyCode, bigint>();
  for (const position of liquidity) {
    if (!isCurrencyCode(position.currency) || !Number.isSafeInteger(position.availableMinor) || balances.has(position.currency)) {
      throw new Error('Available-to-spend liquid balances are invalid.');
    }
    balances.set(position.currency, BigInt(position.availableMinor));
  }
  const billIds = new Set<string>();
  const billsByCurrency = new Map<CurrencyCode, bigint>();
  for (const bill of bills) {
    if (!bill.id.trim() || billIds.has(bill.id) || !isCurrencyCode(bill.currency)
      || !Number.isSafeInteger(bill.amountMinor) || bill.amountMinor <= 0
      || !Number.isSafeInteger(bill.paidMinor) || bill.paidMinor < 0
      || !isCalendarDate(bill.dueDate)) {
      throw new Error('An available-to-spend bill is invalid.');
    }
    billIds.add(bill.id);
    if (['paid', 'cancelled', 'skipped'].includes(bill.status) || bill.dueDate > periodEndDate) continue;
    const remaining = BigInt(bill.amountMinor) - BigInt(bill.paidMinor);
    if (remaining <= 0n) continue;
    billsByCurrency.set(bill.currency, (billsByCurrency.get(bill.currency) ?? 0n) + remaining);
  }
  return [...new Set([...balances.keys(), ...billsByCurrency.keys()])].sort().map((currency) => {
    const unreserved = balances.get(currency) ?? 0n;
    const billsDue = billsByCurrency.get(currency) ?? 0n;
    return {
      currency,
      unreservedMinor: safeMinor(unreserved, 'Unreserved balance'),
      unpaidBillsDueMinor: safeMinor(billsDue, 'Unpaid bills due'),
      availableToSpendMinor: safeMinor(unreserved - billsDue, 'Available to spend'),
    };
  });
}
