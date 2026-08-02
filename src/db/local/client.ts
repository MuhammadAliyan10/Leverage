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
        name TEXT,
        balance REAL,
        currency TEXT
      );
      CREATE TABLE IF NOT EXISTS "Transaction" (
        id TEXT PRIMARY KEY,
        amount REAL,
        type TEXT,
        categoryId TEXT,
        accountId TEXT,
        date TEXT,
        note TEXT,
        synced INTEGER DEFAULT 0
      );
    `);
    return expoDb;
  } catch (e) {
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
  },
  account: {
    count: async () => {
      const db = await getDb();
      if (!db) return 0;
      const result = await db.getFirstAsync<{count: number}>('SELECT COUNT(*) as count FROM Account');
      return result?.count || 0;
    },
    create: async ({ data }: any) => {
      const db = await getDb();
      const id = Math.random().toString(36).substring(7);
      if (db) {
        await db.runAsync('INSERT INTO Account (id, name, balance, currency) VALUES (?, ?, ?, ?)', [id, data.name, data.balance, data.currency]);
      }
      return { id, ...data };
    },
    findMany: async () => {
      const db = await getDb();
      if (!db) return [];
      return await db.getAllAsync('SELECT * FROM Account');
    }
  },
  transaction: {
    findMany: async ({ where }: any = {}) => {
      const db = await getDb();
      if (!db) return [];
      let query = 'SELECT * FROM "Transaction"';
      const params: any[] = [];
      if (where && where.synced !== undefined) {
        query += ' WHERE synced = ?';
        params.push(where.synced ? 1 : 0);
      }
      query += ' ORDER BY date DESC';
      const results = await db.getAllAsync(query, params);
      return (results as any[]).map((r) => ({ ...r, synced: !!r.synced }));
    },
    create: async ({ data }: any) => {
      const db = await getDb();
      const id = Math.random().toString(36).substring(7);
      if (db) {
        await db.runAsync(
          'INSERT INTO "Transaction" (id, amount, type, categoryId, accountId, date, note, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
          [
            id, 
            data.amount, 
            data.type, 
            data.categoryId, 
            data.accountId, 
            data.date ? new Date(data.date).toISOString() : new Date().toISOString(), 
            data.note || '', 
            data.synced ? 1 : 0
          ]
        );
      }
      return { id, ...data };
    },
    update: async ({ where, data }: any) => {
      const db = await getDb();
      if (db && data.synced !== undefined) {
        await db.runAsync('UPDATE "Transaction" SET synced = ? WHERE id = ?', [data.synced ? 1 : 0, where.id]);
      }
      return { id: where.id, ...data };
    }
  }
};
