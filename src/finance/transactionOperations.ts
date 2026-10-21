export function resolveRefundAmount({
  originalAmountMinor,
  alreadyRefundedMinor,
  amountMinor,
  refundRemaining = false,
}: {
  originalAmountMinor: number;
  alreadyRefundedMinor: number;
  amountMinor?: number;
  refundRemaining?: boolean;
}): number {
  if (!Number.isSafeInteger(originalAmountMinor) || originalAmountMinor <= 0) {
    throw new Error('Original expense amount is invalid.');
  }
  if (!Number.isSafeInteger(alreadyRefundedMinor) || alreadyRefundedMinor < 0 || alreadyRefundedMinor > originalAmountMinor) {
    throw new Error('Recorded refunds exceed the original expense or are invalid.');
  }
  if (!refundRemaining && (!Number.isSafeInteger(amountMinor) || amountMinor! <= 0)) {
    throw new Error('Refund amount must be a positive integer in minor units.');
  }
  const refundAmount = refundRemaining ? originalAmountMinor - alreadyRefundedMinor : amountMinor!;
  if (!Number.isSafeInteger(refundAmount) || refundAmount <= 0) {
    throw new Error('There is no refundable expense balance remaining.');
  }
  if (BigInt(alreadyRefundedMinor) + BigInt(refundAmount) > BigInt(originalAmountMinor)) {
    throw new Error('Refund total cannot exceed the original expense.');
  }
  return refundAmount;
}

export function assertCorrectionCanPost({
  originalTransactionId,
  stableReversalId,
  existingReversalId,
  priorRefundCount,
  replacementAlreadyExists,
  existingReplacementCorrectionOfId,
}: {
  originalTransactionId: string;
  stableReversalId: string;
  existingReversalId: string | null;
  priorRefundCount: number;
  replacementAlreadyExists: boolean;
  existingReplacementCorrectionOfId: string | null;
}): void {
  if (!originalTransactionId.trim() || !stableReversalId.trim()) throw new Error('Correction identifiers are required.');
  if (!Number.isSafeInteger(priorRefundCount) || priorRefundCount < 0) throw new Error('Refund history is invalid.');
  if (priorRefundCount > 0) throw new Error('An expense with recorded refunds cannot be corrected.');
  if (existingReversalId !== null && existingReversalId !== stableReversalId) {
    throw new Error('This transaction already has a correction or reversal.');
  }
  if (replacementAlreadyExists && existingReplacementCorrectionOfId !== originalTransactionId) {
    throw new Error('Replacement ID is already used for another transaction.');
  }
}
