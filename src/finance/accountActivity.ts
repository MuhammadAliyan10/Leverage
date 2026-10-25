export type AccountMovementDirection = 'in' | 'out';

/** Direction of cash movement for one account, including the compensating side of corrections. */
export function accountMovementDirection(transaction: { type: string; accountId: string | null; toAccountId: string | null; linkedOriginalType?: string | null }, accountId: string): AccountMovementDirection | null {
  if (transaction.type === 'Income' || transaction.type === 'Refund') return transaction.accountId === accountId ? 'in' : null;
  if (transaction.type === 'Expense') return transaction.accountId === accountId ? 'out' : null;
  if (transaction.type === 'Transfer') {
    if (transaction.accountId === accountId) return 'out';
    if (transaction.toAccountId === accountId) return 'in';
    return null;
  }
  if (transaction.type === 'Reversal') {
    if (transaction.linkedOriginalType === 'Income') return transaction.accountId === accountId ? 'out' : null;
    if (transaction.linkedOriginalType === 'Expense') return transaction.accountId === accountId ? 'in' : null;
    if (transaction.linkedOriginalType === 'Transfer') {
      if (transaction.accountId === accountId) return 'in';
      if (transaction.toAccountId === accountId) return 'out';
    }
  }
  return null;
}
