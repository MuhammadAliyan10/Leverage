export type SyncQueueRow = {
  entityType: string;
  operation: string;
  payload: Record<string, unknown>;
  accountName?: string | null;
  destinationName?: string | null;
  errorCategory?: string | null;
  status: 'pending' | 'in_flight' | 'rejected';
  createdAt: string;
};

export type SyncQueueDisplay = {
  title: string;
  detail: string;
  state: string;
  reason: string | null;
  errorCode: string | null;
  timestamp: string;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function amount(value: unknown, currency: unknown): string | null {
  const code = text(currency);
  if (!code || typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try {
    const minor = BigInt(value);
    if (minor < 0n) return null;
    const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const fraction = (minor % 100n).toString().padStart(2, '0');
    return `${code} ${whole}.${fraction}`;
  } catch { return null; }
}

function domainName(payload: Record<string, unknown>): string | null {
  const nested = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : null;
  return text(payload.name) ?? text(payload.label) ?? text(nested?.name) ?? text(nested?.label);
}

function explain(row: SyncQueueRow): { title: string; detail: string } {
  const payload = row.payload;
  const currency = payload.currency;
  const value = amount(payload.amountMinor ?? payload.openingBalanceMinor ?? payload.targetMinor, currency);
  const name = text(payload.name) ?? domainName(payload);

  if (row.entityType === 'account') {
    const account = name ?? row.accountName ?? 'Account';
    const title = row.operation === 'account.create' ? `New account: ${account}`
      : row.operation === 'account.archive' ? `Archive account: ${account}`
        : `Update account: ${account}`;
    const accountType = text(payload.type);
    const details = [accountType ? `${accountType[0]!.toLocaleUpperCase()}${accountType.slice(1)}` : null, text(currency), amount(payload.openingBalanceMinor, currency) ? `Opening balance ${amount(payload.openingBalanceMinor, currency)}` : null].filter(Boolean);
    return { title, detail: details.join(' · ') || 'Account details saved on this device' };
  }

  if (row.entityType === 'transaction') {
    const type = text(payload.type)?.toLowerCase();
    const label = type === 'income' ? 'Income' : type === 'expense' ? 'Expense' : type === 'transfer' ? 'Account transfer'
      : type === 'refund' ? 'Refund' : type === 'reversal' ? 'Correction' : 'Transaction';
    const category = text(payload.categoryLabel);
    const context = type === 'transfer'
      ? `${row.accountName ?? 'Source account'} → ${row.destinationName ?? 'Destination account'}`
      : row.accountName ?? 'Account not found';
    const memo = text(payload.sourceName) ?? text(payload.note);
    const detail = [value, type === 'transfer' ? null : category, context, memo].filter(Boolean).join(' · ');
    return { title: `${label}${type === 'transfer' || !category ? '' : ` · ${category}`}`, detail: detail || 'Transaction saved on this device' };
  }

  const entityLabels: Record<string, string> = {
    budget: 'Budget', savings_goal: 'Savings goal', savings_goal_event: 'Savings contribution',
    emergency_config: 'Emergency fund settings', emergency_event: 'Emergency fund activity',
    recurring_schedule: 'Recurring payment', schedule_occurrence: 'Scheduled payment',
    bill: 'Bill', bill_payment: 'Bill payment', debt: 'Debt', debt_event: 'Debt activity',
    debt_interest_event: 'Debt interest', debt_event_correction: 'Debt correction',
    debt_repayment_schedule: 'Debt repayment schedule', asset: 'Asset', asset_valuation: 'Asset value',
    asset_activity: 'Asset activity', investment_portfolio: 'Investment portfolio',
    investment_holding: 'Investment holding', investment_event: 'Investment activity', investment_price: 'Investment price',
  };
  const label = entityLabels[row.entityType] ?? 'Financial record';
  const verb = row.operation.endsWith('.create') ? 'New' : row.operation.endsWith('.archive') ? 'Archive' : row.operation.endsWith('.update') ? 'Update' : 'Update';
  const details = [name, value, text(payload.frequency), text(payload.status)].filter(Boolean);
  return { title: `${verb} ${label.toLowerCase()}`, detail: details.join(' · ') || 'Financial change saved on this device' };
}

export function explainSyncFailure(category: string | null | undefined): string {
  const messages: Record<string, string> = {
    CLOUD_MUTATION_NOT_AVAILABLE: 'Neon could not route the financial write operation. Your change is still saved on this device; check the Data API schema and deployed RPC.',
    CLOUD_REQUEST_NOT_FOUND: 'Neon could not find the cloud request route. Your change is still saved on this device; check the configured Data API endpoint.',
    CLOUD_ENDPOINT_NOT_FOUND: 'The configured Neon Data API returned HTTP 404 for this route. Your change is still saved on this device; verify the endpoint and RPC path.',
    CLOUD_FUNCTION_MISSING: 'The Neon Data API could not find the financial sync function in its schema cache. Your record is safe here; verify the exposed schema and function signature, then refresh that branch’s cache.',
    CLOUD_RPC_SIGNATURE_MISSING: 'The Neon Data API could not match the RPC arguments to an exposed function. Your change is still saved here; check the public schema exposure, function signature and schema cache.',
    CLOUD_SCHEMA_TYPE_MISMATCH: 'The cloud sync function ran, but a database value type did not match. Your change is still safe on this device; update the reviewed Neon function migration, then retry.',
    // Older app versions stored all SQLSTATE 42883 errors under this category,
    // including operator/type mismatches. Keep the explanation accurate for
    // those already queued failures too.
    CLOUD_FUNCTION_UNDEFINED: 'PostgreSQL could not execute the sync function. Your change is safe here; check the deployed function version and its database value types before retrying.',
    session_expired: 'Your cloud session expired. Sign in to cloud sync, then retry this record.',
    RELATED_RECORD_MISSING: 'A linked account or financial record is not in the cloud yet. Sync the linked record first, then retry.',
    saving_goal_dependency_missing: 'Leverage could not match this contribution to its cloud savings goal. It stays on this device until the goal and any linked account or transaction are confirmed in cloud sync.',
    account_dependency_missing: 'This transaction is waiting for its account to sync first.',
    refund_dependency_missing: 'This refund is waiting for the original expense to sync first.',
    reversal_dependency_missing: 'This correction is waiting for the original transaction to sync first.',
    correction_dependency_missing: 'This correction is waiting for its related transaction to sync first.',
    budget_dependency_missing: 'This budget change is waiting for the original budget to sync first.',
    DUPLICATE_OR_IDEMPOTENCY_CONFLICT: 'The cloud has a different record with this change key. Review the cloud record before retrying.',
    CLOUD_RECORD_ALREADY_EXISTS: 'A record with this ID already exists in the cloud, but this change was not confirmed. Compare the cloud and device records before retrying.',
    CLOUD_RECORD_CONFLICT: 'The cloud rejected this change because it conflicts with an existing record. Review the cloud and device versions before retrying.',
    FINANCIAL_RECORD_CONFLICT: 'The cloud record changed after this update was queued. Review both versions before retrying.',
    server_local_conflict: 'The cloud and this device have different versions. Review the record before retrying.',
    INVALID_FINANCIAL_RECORD: 'The cloud rejected some details. Check the amount, currency, category, and linked account.',
    FINANCIAL_RULE_REJECTED: 'The cloud’s financial rules rejected this change. Check the linked records and amount.',
    CLOUD_PERMISSION_DENIED: 'Your cloud account does not have permission to save this record.',
    AUTH_REQUIRED: 'Neon did not accept the cloud session. Sign in to cloud sync again, then retry; the local record remains saved.',
    invalid_local_payload: 'This queued change is incomplete or damaged. The saved local record was not removed.',
    network_or_timeout: 'The cloud did not respond in time. This change will retry when the connection is available.',
    DATABASE_UNAVAILABLE: 'The cloud database is temporarily unavailable. This change will retry later.',
  };
  if (!category) return 'The cloud did not accept this change. Your local record remains saved.';
  return messages[category] ?? 'The cloud did not accept this change. Your local record remains saved; retry after checking your connection and linked records.';
}

export function projectSyncQueueRow(row: SyncQueueRow): SyncQueueDisplay {
  const { title, detail } = explain(row);
  const state = row.status === 'rejected' ? 'Not synced' : row.status === 'in_flight' ? 'Syncing now' : 'Waiting to sync';
  return {
    title,
    detail,
    state,
    reason: row.status === 'rejected' ? explainSyncFailure(row.errorCategory) : null,
    // Keep the stable, non-secret category visible so held failures can be
    // diagnosed without exposing IDs, request bodies, tokens, or SQL details.
    errorCode: row.status === 'rejected' && row.errorCategory && /^[A-Za-z0-9_-]{1,80}$/.test(row.errorCategory)
      ? row.errorCategory : null,
    timestamp: Number.isFinite(new Date(row.createdAt).getTime()) ? new Date(row.createdAt).toLocaleString() : 'Time unavailable',
  };
}
