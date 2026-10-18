import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';

let expoDb: SQLite.SQLiteDatabase | null = null;

async function hashPassword(password: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, password);
}

async function getDb() {
  if (expoDb) return expoDb;
  try {
    expoDb = await SQLite.openDatabaseAsync('finance.db');
    await expoDb.execAsync(`
      CREATE TABLE IF NOT EXISTS User (
        id TEXT PRIMARY KEY,
        fullName TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS Account (
        id TEXT PRIMARY KEY,
        ownerId TEXT,
        name TEXT,
        type TEXT NOT NULL DEFAULT 'Bank',
        balance REAL,
        balanceMinor INTEGER,
        currency TEXT NOT NULL DEFAULT 'PKR',
        createdAt TEXT,
        synced INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS "Transaction" (
        id TEXT PRIMARY KEY,
        ownerId TEXT,
        amount REAL,
        amountMinor INTEGER,
        type TEXT,
        categoryId TEXT,
        accountId TEXT,
        toAccountId TEXT,
        date TEXT,
        note TEXT,
        sourceName TEXT,
        paymentMethod TEXT,
        sourceAmountMinor INTEGER,
        sourceCurrency TEXT,
        exchangeRate TEXT,
        referenceNumber TEXT,
        taxStatus TEXT NOT NULL DEFAULT 'unreviewed',
        taxYear INTEGER,
        synced INTEGER DEFAULT 0
      );
    `);

    const accountColumns = await expoDb.getAllAsync<{ name: string }>('PRAGMA table_info(Account)');
    const existingAccountColumns = new Set(accountColumns.map((column) => column.name));
    if (!existingAccountColumns.has('ownerId')) {
      await expoDb.execAsync('ALTER TABLE Account ADD COLUMN ownerId TEXT');
    }
    if (!existingAccountColumns.has('type')) {
      await expoDb.execAsync("ALTER TABLE Account ADD COLUMN type TEXT NOT NULL DEFAULT 'Bank'");
    }
    if (!existingAccountColumns.has('balanceMinor')) {
      await expoDb.execAsync('ALTER TABLE Account ADD COLUMN balanceMinor INTEGER');
      await expoDb.execAsync(
        'UPDATE Account SET balanceMinor = CAST(ROUND(balance * 100) AS INTEGER) WHERE balanceMinor IS NULL AND balance IS NOT NULL'
      );
    }
    if (!existingAccountColumns.has('createdAt')) {
      await expoDb.execAsync('ALTER TABLE Account ADD COLUMN createdAt TEXT');
      await expoDb.execAsync("UPDATE Account SET createdAt = datetime('now') WHERE createdAt IS NULL");
    }
    if (!existingAccountColumns.has('synced')) {
      await expoDb.execAsync('ALTER TABLE Account ADD COLUMN synced INTEGER NOT NULL DEFAULT 0');
    }

    // Add the exact-value column to databases created by earlier app versions.
    const transactionColumns = await expoDb.getAllAsync<{ name: string }>(
      'PRAGMA table_info("Transaction")'
    );
    if (!transactionColumns.some((column) => column.name === 'ownerId')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN ownerId TEXT');
    }
    if (!transactionColumns.some((column) => column.name === 'amountMinor')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN amountMinor INTEGER');
    }
    if (!transactionColumns.some((column) => column.name === 'sourceName')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN sourceName TEXT');
    }
    if (!transactionColumns.some((column) => column.name === 'paymentMethod')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN paymentMethod TEXT');
    }
    if (!transactionColumns.some((column) => column.name === 'toAccountId')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN toAccountId TEXT');
    }
    if (!transactionColumns.some((column) => column.name === 'sourceAmountMinor')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN sourceAmountMinor INTEGER');
    }
    if (!transactionColumns.some((column) => column.name === 'sourceCurrency')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN sourceCurrency TEXT');
    }
    if (!transactionColumns.some((column) => column.name === 'exchangeRate')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN exchangeRate TEXT');
    }
    if (!transactionColumns.some((column) => column.name === 'referenceNumber')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN referenceNumber TEXT');
    }
    if (!transactionColumns.some((column) => column.name === 'taxStatus')) {
      await expoDb.execAsync("ALTER TABLE \"Transaction\" ADD COLUMN taxStatus TEXT NOT NULL DEFAULT 'unreviewed'");
    }
    if (!transactionColumns.some((column) => column.name === 'taxYear')) {
      await expoDb.execAsync('ALTER TABLE "Transaction" ADD COLUMN taxYear INTEGER');
    }
    await expoDb.execAsync(
      'UPDATE "Transaction" SET amountMinor = CAST(ROUND(amount * 100) AS INTEGER) WHERE amountMinor IS NULL AND amount IS NOT NULL'
    );
    await expoDb.execAsync('CREATE INDEX IF NOT EXISTS Account_owner_idx ON Account(ownerId)');
    await expoDb.execAsync('CREATE INDEX IF NOT EXISTS Transaction_owner_date_idx ON "Transaction"(ownerId, date)');
    return expoDb;
  } catch (e) {
    expoDb = null;
    console.error("Failed to initialize SQLite:", e);
    return null;
  }
}

export type DbUser = { id: string; fullName: string; email: string; passwordHash: string; createdAt: string };

export type AuthResult =
  | { success: true; user: Omit<DbUser, 'passwordHash'> }
  | { success: false; error: string };

export const localDb = {
  user: {
    register: async (fullName: string, email: string, password: string): Promise<AuthResult> => {
      const db = await getDb();
      if (!db) return { success: false, error: 'Database unavailable' };

      const existing = await db.getFirstAsync<DbUser>(
        'SELECT id FROM User WHERE email = ?',
        [email.toLowerCase()]
      );
      if (existing) return { success: false, error: 'An account with this email already exists' };

      const id = Crypto.randomUUID();
      const passwordHash = await hashPassword(password);
      const createdAt = new Date().toISOString();

      await db.runAsync(
        'INSERT INTO User (id, fullName, email, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)',
        [id, fullName, email.toLowerCase(), passwordHash, createdAt]
      );

      return { success: true, user: { id, fullName, email: email.toLowerCase(), createdAt } };
    },

    signIn: async (email: string, password: string): Promise<AuthResult> => {
      const db = await getDb();
      if (!db) return { success: false, error: 'Database unavailable' };

      const user = await db.getFirstAsync<DbUser>(
        'SELECT * FROM User WHERE email = ?',
        [email.toLowerCase()]
      );
      if (!user) return { success: false, error: 'No account found with this email' };

      const passwordHash = await hashPassword(password);
      if (passwordHash !== user.passwordHash) {
        return { success: false, error: 'Incorrect password' };
      }

      return { success: true, user: { id: user.id, fullName: user.fullName, email: user.email, createdAt: user.createdAt } };
    },

    findById: async (id: string): Promise<Omit<DbUser, 'passwordHash'> | null> => {
      const db = await getDb();
      if (!db) return null;
      const user = await db.getFirstAsync<DbUser>('SELECT id, fullName, email, createdAt FROM User WHERE id = ?', [id]);
      return user ?? null;
    },
    claimLegacyData: async (ownerId: string): Promise<void> => {
      const db = await getDb();
      if (!db) throw new Error('Database unavailable.');
      const userCount = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM User');
      // Existing ownerless records can be assigned safely only when there is one local profile.
      if (userCount?.count !== 1) return;
      await db.withTransactionAsync(async () => {
        await db.runAsync('UPDATE Account SET ownerId = ? WHERE ownerId IS NULL', [ownerId]);
        await db.runAsync('UPDATE "Transaction" SET ownerId = ? WHERE ownerId IS NULL', [ownerId]);
      });
    },
  },
  account: {
    count: async (ownerId: string) => {
      const db = await getDb();
      if (!db) throw new Error('Database unavailable.');
      const result = await db.getFirstAsync<{count: number}>(
        'SELECT COUNT(*) as count FROM Account WHERE ownerId = ?',
        [ownerId],
      );
      return result?.count || 0;
    },
    create: async ({ data }: { data: {
      ownerId: string;
      name: string;
      type: string;
      balanceMinor: number;
      currency?: string;
    } }) => {
      const db = await getDb();
      if (!data.ownerId) throw new Error('An account owner is required.');
      if (!Number.isSafeInteger(data.balanceMinor) || data.balanceMinor < 0) {
        throw new Error('Opening balance must be a non-negative integer in minor units.');
      }
      const id = Crypto.randomUUID();
      if (db) {
        const createdAt = new Date().toISOString();
        await db.runAsync(
          'INSERT INTO Account (id, ownerId, name, type, balance, balanceMinor, currency, createdAt, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
          [id, data.ownerId, data.name, data.type, data.balanceMinor / 100, data.balanceMinor, data.currency ?? 'PKR', createdAt],
        );
        return { id, ...data, currency: data.currency ?? 'PKR', createdAt, synced: false };
      }
      throw new Error('Database unavailable. Account was not saved.');
    },
    findMany: async (ownerId: string) => {
      const db = await getDb();
      if (!db) throw new Error('Database unavailable.');
      if (!ownerId) return [];
      return await db.getAllAsync<{
        id: string;
        name: string;
        type: string;
        balanceMinor: number;
        currency: string;
        createdAt: string;
        synced: number;
      }>(
        'SELECT id, name, type, balanceMinor, currency, createdAt, synced FROM Account WHERE ownerId = ? ORDER BY createdAt ASC',
        [ownerId],
      );
    }
  },
  transaction: {
    findMany: async ({
      where,
      ownerId,
      orderBy,
      take,
    }: {
      where?: { synced?: boolean };
      ownerId?: string;
      orderBy?: { date?: 'asc' | 'desc' };
      take?: number;
    } = {}) => {
      const db = await getDb();
      if (!db) throw new Error('Database unavailable.');
      if (!ownerId) return [];
      let query = 'SELECT id, amountMinor, type, categoryId AS category, accountId, toAccountId, date, note, sourceName, paymentMethod, sourceAmountMinor, sourceCurrency, exchangeRate, referenceNumber, taxStatus, taxYear, synced FROM "Transaction" WHERE ownerId = ?';
      const params: any[] = [ownerId];
      if (where && where.synced !== undefined) {
        query += ' AND synced = ?';
        params.push(where.synced ? 1 : 0);
      }
      query += ` ORDER BY date ${orderBy?.date === 'asc' ? 'ASC' : 'DESC'}`;
      if (take !== undefined) {
        if (!Number.isSafeInteger(take) || take < 0) throw new Error('take must be a non-negative integer.');
        query += ' LIMIT ?';
        params.push(take);
      }
      const results = await db.getAllAsync(query, params);
      return (results as any[]).map((r) => ({ ...r, synced: !!r.synced }));
    },
    create: async ({ data }: { data: {
      ownerId: string;
      amountMinor: number;
      type: string;
      category: string;
      accountId?: string;
      toAccountId?: string;
      date?: Date | string;
      note?: string;
      sourceName?: string;
      paymentMethod?: string;
      sourceAmountMinor?: number;
      sourceCurrency?: string;
      exchangeRate?: string;
      referenceNumber?: string;
      taxStatus?: 'unreviewed' | 'taxable' | 'non_taxable';
      taxYear?: number;
      synced?: boolean;
    } }) => {
      const db = await getDb();
      if (!db) throw new Error('Database unavailable. Transaction was not saved.');
      if (!Number.isSafeInteger(data.amountMinor) || data.amountMinor <= 0) {
        throw new Error('Transaction amount must be a positive integer in minor units.');
      }
      if (!data.ownerId) throw new Error('A transaction owner is required.');
      if (!data.accountId) throw new Error('Choose an account for this transaction.');
      const account = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM Account WHERE id = ? AND ownerId = ?',
        [data.accountId, data.ownerId],
      );
      if (!account) throw new Error('The selected account no longer exists.');
      if (data.type === 'Transfer') {
        if (!data.toAccountId || data.toAccountId === data.accountId) {
          throw new Error('Choose two different accounts for a transfer.');
        }
        const destination = await db.getFirstAsync<{ id: string }>(
          'SELECT id FROM Account WHERE id = ? AND ownerId = ?',
          [data.toAccountId, data.ownerId],
        );
        if (!destination) throw new Error('The destination account no longer exists.');
        const accountCurrencies = await db.getAllAsync<{ currency: string }>(
          'SELECT currency FROM Account WHERE id IN (?, ?) AND ownerId = ?',
          [data.accountId, data.toAccountId, data.ownerId],
        );
        if (accountCurrencies.length !== 2 || accountCurrencies[0].currency !== accountCurrencies[1].currency) {
          throw new Error('Transfers between accounts with different currencies are not supported yet.');
        }
      } else if (data.toAccountId) {
        throw new Error('A destination account is only valid for an internal transfer.');
      }
      if (data.type === 'Income' && data.category === 'Family gift' && !data.sourceName?.trim()) {
        throw new Error('Record who gave you this family gift.');
      }
      if (data.sourceAmountMinor !== undefined && (!Number.isSafeInteger(data.sourceAmountMinor) || data.sourceAmountMinor < 0)) {
        throw new Error('Original currency amount must be a non-negative safe integer.');
      }
      if (data.type === 'Income' && data.category === 'Family remittance' &&
          (!data.sourceAmountMinor || !data.sourceCurrency || !data.exchangeRate || !data.referenceNumber)) {
        throw new Error('A remittance requires its original amount, currency, exchange rate, and reference number.');
      }
      if (data.taxStatus && !['unreviewed', 'taxable', 'non_taxable'].includes(data.taxStatus)) {
        throw new Error('Tax status is invalid.');
      }
      const id = Crypto.randomUUID();
      const transactionDate = data.date
        ? data.date instanceof Date ? data.date : new Date(data.date)
        : new Date();
      const dateIso = transactionDate.toISOString();
      await db.runAsync(
        'INSERT INTO "Transaction" (id, ownerId, amount, amountMinor, type, categoryId, accountId, toAccountId, date, note, sourceName, paymentMethod, sourceAmountMinor, sourceCurrency, exchangeRate, referenceNumber, taxStatus, taxYear, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          data.ownerId,
          data.amountMinor / 100, // Transitional compatibility only; amountMinor is authoritative.
          data.amountMinor,
          data.type,
          data.category,
          data.accountId,
          data.toAccountId || null,
          dateIso,
          data.note || '',
          data.sourceName || null,
          data.paymentMethod || null,
          data.sourceAmountMinor ?? null,
          data.sourceCurrency || null,
          data.exchangeRate || null,
          data.referenceNumber || null,
          data.taxStatus || 'unreviewed',
          data.taxYear ?? null,
          data.synced ? 1 : 0,
        ]
      );
      return { id, ...data, date: dateIso };
    },
    update: async ({ where, data }: {
      where: { id: string; ownerId: string };
      data: { synced?: boolean };
    }) => {
      const db = await getDb();
      if (!db) throw new Error('Database unavailable.');
      if (!where.ownerId) throw new Error('A transaction owner is required.');
      if (data.synced !== undefined) {
        await db.runAsync(
          'UPDATE "Transaction" SET synced = ? WHERE id = ? AND ownerId = ?',
          [data.synced ? 1 : 0, where.id, where.ownerId],
        );
      }
      return { id: where.id, ...data };
    }
  }
};
