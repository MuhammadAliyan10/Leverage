import { normalizeAccountDraft, type AccountDraft, type NormalizedAccountDraft } from './domain.ts';

export interface StoredAccount {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  balanceMinor: number;
  currency: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface AccountMutationStore {
  findAccount(ownerId: string, accountId: string): Promise<StoredAccount | null>;
  countTransactions(ownerId: string, accountId: string): Promise<number>;
  updateAccount(account: NormalizedAccountDraft): Promise<void>;
  archiveAccount(ownerId: string, accountId: string, archivedAt: string): Promise<void>;
}

/** Edits account metadata while locking opening balance and currency once history exists. */
export async function editAccount(
  ownerId: string,
  accountId: string,
  changes: Partial<Pick<AccountDraft, 'name' | 'type' | 'balanceMinor' | 'currency'>>,
  store: AccountMutationStore,
): Promise<StoredAccount> {
  if (!ownerId.trim() || !accountId.trim()) throw new Error('A profile and account are required.');
  const current = await store.findAccount(ownerId, accountId);
  if (!current) throw new Error('This account is not available to this profile.');
  if (current.archivedAt) throw new Error('Archived accounts cannot be edited.');
  const account = normalizeAccountDraft({
    id: current.id,
    ownerId: current.ownerId,
    name: changes.name ?? current.name,
    type: changes.type ?? current.type,
    balanceMinor: changes.balanceMinor ?? current.balanceMinor,
    currency: changes.currency ?? current.currency,
  });
  const transactionCount = await store.countTransactions(ownerId, accountId);
  if (transactionCount && account.balanceMinor !== current.balanceMinor) {
    throw new Error('Opening balance is locked after transactions exist. Record a correction to preserve history.');
  }
  if (transactionCount && account.currency !== current.currency) {
    throw new Error('Currency cannot change after transactions exist.');
  }
  await store.updateAccount(account);
  return { ...current, ...account, archivedAt: null };
}

/** Archives instead of deleting so transactions and account balances remain auditable. */
export async function archiveAccount(ownerId: string, accountId: string, store: AccountMutationStore, at = new Date()): Promise<void> {
  if (!ownerId.trim() || !accountId.trim()) throw new Error('A profile and account are required.');
  if (!Number.isFinite(at.getTime())) throw new Error('Archive date is invalid.');
  const account = await store.findAccount(ownerId, accountId);
  if (!account) throw new Error('This account is not available to this profile.');
  if (account.archivedAt) return;
  await store.archiveAccount(ownerId, accountId, at.toISOString());
}
