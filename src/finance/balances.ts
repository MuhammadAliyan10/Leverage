export interface BalanceAccountInput {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  balanceMinor: number;
  currency: string;
}

export interface BalanceTransactionInput {
  id?: string;
  ownerId: string;
  amountMinor: number;
  type: string;
  accountId: string | null;
  toAccountId: string | null;
  reversalOfId?: string | null;
}

export interface BalanceAccountResult extends BalanceAccountInput {
  balanceMinor: number;
}

/** True only when a safe integer balance covers a positive minor-unit cash outflow. */
export function hasSufficientFunds(currentBalanceMinor: number, requiredMinor: number): boolean {
  if (!Number.isSafeInteger(currentBalanceMinor) || !Number.isSafeInteger(requiredMinor) || requiredMinor <= 0) {
    throw new Error('A verified account balance and positive integer amount are required.');
  }
  return currentBalanceMinor >= requiredMinor;
}

/** Derives each account balance from its opening amount and persisted transactions. */
export function calculateAccountBalances(
  accounts: readonly BalanceAccountInput[],
  transactions: readonly BalanceTransactionInput[],
): BalanceAccountResult[] {
  const byId = new Map<string, BalanceAccountInput>();
  const balances = new Map<string, bigint>();
  for (const account of accounts) {
    if (!account.id || !account.ownerId || byId.has(account.id)) throw new Error('A saved account identity is invalid.');
    if (!Number.isSafeInteger(account.balanceMinor) || account.balanceMinor < 0) {
      throw new Error(`Account ${account.id} has an invalid opening balance.`);
    }
    byId.set(account.id, account);
    balances.set(account.id, BigInt(account.balanceMinor));
  }

  const eventsById = new Map(transactions.filter((transaction) => transaction.id).map((transaction) => [transaction.id!, transaction]));
  const refundsByOriginalId = new Map<string, bigint>();
  const refundedOriginalIds = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.type !== 'Refund' || !transaction.reversalOfId) continue;
    const originalId = transaction.reversalOfId;
    refundedOriginalIds.add(originalId);
    refundsByOriginalId.set(originalId, (refundsByOriginalId.get(originalId) ?? 0n) + BigInt(transaction.amountMinor));
  }
  for (const transaction of transactions) {
    if (!Number.isSafeInteger(transaction.amountMinor) || transaction.amountMinor <= 0) {
      throw new Error('A saved transaction has an invalid amount.');
    }
    if (!['Income', 'Expense', 'Transfer', 'Refund', 'Reversal'].includes(transaction.type)) {
      throw new Error('A saved transaction has an unsupported type.');
    }
    // Legacy orphaned rows are retained but cannot be included in any account balance.
    if (transaction.accountId === null) continue;
    const source = byId.get(transaction.accountId);
    if (!source || source.ownerId !== transaction.ownerId) {
      throw new Error('A saved transaction references an unavailable source account.');
    }
    const amount = BigInt(transaction.amountMinor);
    if (transaction.type === 'Reversal') {
      const original = transaction.reversalOfId ? eventsById.get(transaction.reversalOfId) : undefined;
      if (!original || !original.id || original.ownerId !== transaction.ownerId || original.accountId !== transaction.accountId || original.toAccountId !== transaction.toAccountId) {
        throw new Error('A saved correction refers to an unavailable original transaction.');
      }
      if (amount !== BigInt(original.amountMinor) || refundedOriginalIds.has(original.id)) {
        throw new Error('A saved correction has an invalid amount or conflicts with a refund.');
      }
      if (original.type === 'Income') balances.set(source.id, (balances.get(source.id) ?? 0n) - amount);
      else if (original.type === 'Expense') balances.set(source.id, (balances.get(source.id) ?? 0n) + amount);
      else if (original.type === 'Transfer') {
        const destination = original.toAccountId ? byId.get(original.toAccountId) : undefined;
        if (!destination || destination.ownerId !== transaction.ownerId || destination.currency !== source.currency) throw new Error('A saved correction has an invalid transfer destination.');
        balances.set(source.id, (balances.get(source.id) ?? 0n) + amount);
        balances.set(destination.id, (balances.get(destination.id) ?? 0n) - amount);
      } else throw new Error('A refund or reversal cannot itself be reversed.');
    } else if (transaction.type === 'Income' || transaction.type === 'Refund') {
      if (transaction.toAccountId !== null) throw new Error('An income or refund has an unexpected destination account.');
      if (transaction.type === 'Refund') {
        const original = transaction.reversalOfId ? eventsById.get(transaction.reversalOfId) : undefined;
        if (!original || !original.id || original.type !== 'Expense' || original.ownerId !== transaction.ownerId || !original.accountId) {
          throw new Error('A saved refund refers to an unavailable expense.');
        }
        const sourceForOriginal = byId.get(original.accountId);
        if (!sourceForOriginal || sourceForOriginal.ownerId !== transaction.ownerId || sourceForOriginal.currency !== source.currency) {
          throw new Error('A saved refund uses an incompatible account.');
        }
        const refundedMinor = refundsByOriginalId.get(original.id) ?? 0n;
        if (refundedMinor > BigInt(original.amountMinor)) throw new Error('Saved refunds exceed the original expense.');
      }
      balances.set(source.id, (balances.get(source.id) ?? 0n) + amount);
    } else if (transaction.type === 'Expense') {
      if (transaction.toAccountId !== null) throw new Error('An expense transaction has an unexpected destination account.');
      balances.set(source.id, (balances.get(source.id) ?? 0n) - amount);
    } else {
      const destination = transaction.toAccountId ? byId.get(transaction.toAccountId) : undefined;
      if (!destination || destination.id === source.id || destination.ownerId !== transaction.ownerId) {
        throw new Error('A saved transfer has an invalid destination account.');
      }
      if (destination.currency !== source.currency) throw new Error('A saved transfer uses accounts with different currencies.');
      balances.set(source.id, (balances.get(source.id) ?? 0n) - amount);
      balances.set(destination.id, (balances.get(destination.id) ?? 0n) + amount);
    }
  }

  return accounts.map((account) => {
    const balanceMinor = balances.get(account.id) ?? 0n;
    if (balanceMinor > BigInt(Number.MAX_SAFE_INTEGER) || balanceMinor < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`Account ${account.id} balance is outside the supported range.`);
    }
    return { ...account, balanceMinor: Number(balanceMinor) };
  });
}
