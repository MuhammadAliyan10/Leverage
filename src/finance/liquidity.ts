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
}

function safeMinor(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`${label} is outside the supported range.`);
  return Number(value);
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
  for (const account of accounts) {
    if (account.archivedAt !== null || !['cash', 'bank', 'savings', 'wallet'].includes(normalizeAccountType(account.type) ?? '')) continue;
    if (!isCurrencyCode(account.currency)) throw new Error(`Account ${account.id} has an unsupported currency.`);
    const currency = account.currency;
    balances.set(currency, (balances.get(currency) ?? 0n) + BigInt(account.balanceMinor));
    reserved.set(currency, (reserved.get(currency) ?? 0n) + (reservationsByAccount.get(account.id) ?? 0n));
  }

  return [...new Set([...balances.keys(), ...reserved.keys()])].sort().map((currency) => {
    const currentBalanceMinor = safeMinor(balances.get(currency) ?? 0n, 'Liquid balance');
    const reservedMinor = safeMinor(reserved.get(currency) ?? 0n, 'Reserved balance');
    return {
      currency,
      currentBalanceMinor,
      reservedMinor,
      availableMinor: safeMinor(BigInt(currentBalanceMinor) - BigInt(reservedMinor), 'Available balance'),
    };
  });
}
