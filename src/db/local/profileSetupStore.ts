import { normalizeAccountDraft, type AccountDraft } from '../../finance/domain.ts';

export interface ProfileSetupSql {
  getFirstAsync<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T | null>;
  runAsync(sql: string, params?: readonly (string | number | null)[]): Promise<unknown>;
}

export interface SetupAccount {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  balanceMinor: number;
  currency: string;
  createdAt: string;
  archivedAt: string | null;
  synced: number;
}

export interface OnboardingCompletionResult {
  alreadyComplete: boolean;
  account: SetupAccount;
}

export function createProfileSetupStore(
  getSql: () => Promise<ProfileSetupSql>,
  withWrite: <T>(task: (sql: ProfileSetupSql) => Promise<T>) => Promise<T>,
) {
  return {
    isRequired: async (ownerId: string): Promise<boolean> => {
      if (!ownerId.trim()) return false;
      const sql = await getSql();
      return (await sql.getFirstAsync<{ ownerId: string }>('SELECT ownerId FROM OnboardingRequirement WHERE ownerId=?', [ownerId])) !== null;
    },

    require: async (ownerId: string): Promise<void> => {
      if (!ownerId.trim()) throw new Error('Your local profile is unavailable. Sign in again.');
      const sql = await getSql();
      const profile = await sql.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [ownerId]);
      if (!profile) throw new Error('Your local profile is unavailable. Sign in again.');
      await withWrite(async (transaction) => {
        await transaction.runAsync('INSERT OR IGNORE INTO OnboardingRequirement(ownerId,requiredAt) VALUES(?,?)', [ownerId, new Date().toISOString()]);
      });
    },

    isComplete: async (ownerId: string): Promise<boolean> => {
      if (!ownerId.trim()) return false;
      const sql = await getSql();
      const profile = await sql.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [ownerId]);
      if (!profile) throw new Error('Your local profile is unavailable. Sign in again.');
      const setup = await sql.getFirstAsync<{ ownerId: string }>('SELECT ownerId FROM ProfileSetup WHERE ownerId=?', [ownerId]);
      if (setup) return true;
      // Older and newly imported profiles can already have accounts without the
      // onboarding marker. An account is enough evidence that setup is complete.
      return (await sql.getFirstAsync<{ id: string }>('SELECT id FROM Account WHERE ownerId=? LIMIT 1', [ownerId])) !== null;
    },

    complete: async (ownerId: string, draft: Omit<AccountDraft, 'ownerId' | 'id'>): Promise<OnboardingCompletionResult> => {
      if (!ownerId.trim()) throw new Error('Your local profile is unavailable. Sign in again.');
      return withWrite(async (sql) => {
        const profile = await sql.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [ownerId]);
        if (!profile) throw new Error('Your local profile is unavailable. Sign in again.');
        const setup = await sql.getFirstAsync<{ completedAt: string; firstAccountId: string | null }>('SELECT completedAt,firstAccountId FROM ProfileSetup WHERE ownerId=?', [ownerId]);
        const priorAccount = setup?.firstAccountId
          ? await sql.getFirstAsync<SetupAccount>('SELECT id,ownerId,name,type,balanceMinor,currency,createdAt,archivedAt,synced FROM Account WHERE id=? AND ownerId=?', [setup.firstAccountId, ownerId])
          : await sql.getFirstAsync<SetupAccount>('SELECT id,ownerId,name,type,balanceMinor,currency,createdAt,archivedAt,synced FROM Account WHERE ownerId=? ORDER BY createdAt ASC,id ASC LIMIT 1', [ownerId]);
        if (setup || priorAccount) {
          await sql.runAsync('DELETE FROM OnboardingRequirement WHERE ownerId=?', [ownerId]);
          if (!setup) await sql.runAsync('INSERT INTO ProfileSetup(ownerId,completedAt,firstAccountId) VALUES(?,?,?)', [ownerId, new Date().toISOString(), priorAccount?.id ?? null]);
          if (!priorAccount) throw new Error('Setup is complete, but its account could not be found. Open account settings to continue.');
          return { alreadyComplete: true, account: priorAccount };
        }

        // Stable, profile-scoped ID makes retries converge on the same first account.
        const accountId = `first-account:${ownerId}`;
        const normalized = normalizeAccountDraft({ ...draft, ownerId, id: accountId });
        const createdAt = new Date().toISOString();
        await sql.runAsync('INSERT INTO Account(id,ownerId,name,type,balance,balanceMinor,currency,createdAt,synced) VALUES(?,?,?,?,?,?,?,?,0)', [accountId, ownerId, normalized.name, normalized.type, normalized.balanceMinor / 100, normalized.balanceMinor, normalized.currency, createdAt]);
        await sql.runAsync('INSERT INTO ProfileSetup(ownerId,completedAt,firstAccountId) VALUES(?,?,?)', [ownerId, createdAt, accountId]);
        await sql.runAsync('DELETE FROM OnboardingRequirement WHERE ownerId=?', [ownerId]);
        const saved = await sql.getFirstAsync<SetupAccount>('SELECT id,ownerId,name,type,balanceMinor,currency,createdAt,archivedAt,synced FROM Account WHERE id=? AND ownerId=?', [accountId, ownerId]);
        if (!saved) throw new Error('The first account could not be confirmed. Please try again.');
        return { alreadyComplete: false, account: saved };
      });
    },
  };
}
