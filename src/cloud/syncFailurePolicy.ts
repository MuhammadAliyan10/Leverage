/** A broken shared cloud capability must stop the queue before every row is rejected. */
export function isQueueWideSyncBlock(category: string): boolean {
  return [
    'CLOUD_MUTATION_NOT_AVAILABLE',
    'CLOUD_FUNCTION_MISSING',
    'CLOUD_RPC_SIGNATURE_MISSING',
    'CLOUD_FUNCTION_UNDEFINED',
    'CLOUD_SCHEMA_TYPE_MISMATCH',
    'CLOUD_REQUEST_NOT_FOUND',
    'CLOUD_ENDPOINT_NOT_FOUND',
    'CLOUD_PERMISSION_DENIED',
    'AUTH_REQUIRED',
  ].includes(category);
}

/** Retry only failures where repeating the same idempotent request is safe. */
export function canRetryRejectedSyncChange(category: string | null | undefined): boolean {
  return category === 'AUTH_REQUIRED' || category === 'session_expired' || category === 'network_or_timeout' || category === 'DATABASE_UNAVAILABLE';
}
