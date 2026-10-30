type SyncMetadataSql = {
  runAsync(sql: string, params: (string | number | null)[]): Promise<unknown>;
};

/**
 * Marks a posted transaction as cloud-confirmed without issuing a no-op UPDATE.
 * The local ledger trigger allows the 0 -> 1 sync metadata transition, but
 * rejects an UPDATE that leaves an already-confirmed immutable row unchanged.
 */
export function markTransactionCloudConfirmed(
  sql: SyncMetadataSql,
  transactionId: string,
  ownerId: string,
): Promise<unknown> {
  return sql.runAsync(
    'UPDATE "Transaction" SET synced=1 WHERE id=? AND ownerId=? AND synced=0',
    [transactionId, ownerId],
  );
}
