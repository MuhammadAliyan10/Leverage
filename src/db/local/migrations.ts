import { resolveClassification } from '../../finance/domain.ts';

export const LOCAL_DATABASE_VERSION = 17;

export interface MigrationDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params?: readonly (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params?: readonly (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(source: string, params?: readonly (string | number | null)[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

interface TableColumn {
  name: string;
}

interface NumericRow {
  id: string;
  amount: number | null;
  amountMinor: number | null;
}

interface AccountNumericRow {
  id: string;
  balance: number | null;
  balanceMinor: number | null;
}

interface VersionRow {
  user_version: number;
}

interface CountRow { count: number }

async function columnsFor(database: MigrationDatabase, table: string): Promise<Set<string>> {
  const escaped = table.replaceAll('"', '""');
  const columns = await database.getAllAsync<TableColumn>(`PRAGMA table_info("${escaped}")`);
  return new Set(columns.map((column) => column.name));
}

async function addColumnIfMissing(
  database: MigrationDatabase,
  table: string,
  knownColumns: Set<string>,
  name: string,
  definition: string,
): Promise<void> {
  if (knownColumns.has(name)) return;
  await database.execAsync(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
  knownColumns.add(name);
}

function validateMinorAmount(value: number | null, id: string, label: string, allowNegative: boolean): number {
  if (value === null || !Number.isFinite(value)) throw new Error(`${label} ${id} has no valid legacy amount; migration was rolled back.`);
  const minor = Math.round(value * 100);
  if (!Number.isSafeInteger(minor) || (!allowNegative && minor <= 0)) {
    throw new Error(`${label} ${id} has an amount outside the supported range; migration was rolled back.`);
  }
  return minor;
}

async function ensureBaseTables(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
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
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "Transaction" (
      id TEXT PRIMARY KEY,
      ownerId TEXT,
      amount REAL,
      amountMinor INTEGER,
      type TEXT,
      category TEXT,
      categoryId TEXT,
      classificationId TEXT,
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
      synced INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function migrateOnboardingStateV7(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS ProfileSetup (
      ownerId TEXT PRIMARY KEY NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      completedAt TEXT NOT NULL,
      firstAccountId TEXT
    );
    CREATE TABLE IF NOT EXISTS AuthLoginAttempt (
      attemptKey TEXT PRIMARY KEY NOT NULL,
      failures INTEGER NOT NULL CHECK(failures >= 0),
      blockedUntil INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Any existing account, including an archived one, proves the profile completed
  // initial setup. Preserve all rows and avoid sending established users through setup.
  await database.execAsync(`
    INSERT OR IGNORE INTO ProfileSetup(ownerId,completedAt,firstAccountId)
    SELECT u.id,u.createdAt,(
      SELECT a.id FROM Account a WHERE a.ownerId=u.id ORDER BY a.createdAt ASC,a.id ASC LIMIT 1
    )
    FROM User u
    WHERE EXISTS (SELECT 1 FROM Account WHERE Account.ownerId = u.id);
    CREATE INDEX IF NOT EXISTS ProfileSetup_completed_idx ON ProfileSetup(completedAt);
    CREATE INDEX IF NOT EXISTS AuthLoginAttempt_blocked_idx ON AuthLoginAttempt(blockedUntil);
  `);
}

/** Hardens legacy cash-ledger rows without rebuilding tables or rewriting ambiguous dates. */
async function migrateDatabaseHardeningV8(database: MigrationDatabase): Promise<void> {
  const dates = await database.getAllAsync<{ id: string; date: string }>(
    'SELECT id,date FROM "Transaction" ORDER BY id',
  );
  for (const row of dates) {
    // SQLite datetime('now') values are UTC by SQLite contract. Normalize only this
    // recognized legacy representation; retain date-only and timezone-ambiguous values.
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(row.date);
    if (match) {
      const milliseconds = (match[3] ?? '.000').padEnd(4, '0');
      const normalized = `${match[1]}T${match[2]}${milliseconds}Z`;
      if (!Number.isFinite(Date.parse(normalized))) {
        throw new Error(`Transaction ${row.id} has an invalid legacy timestamp; migration was rolled back.`);
      }
      await database.runAsync('UPDATE "Transaction" SET date=? WHERE id=?', [normalized, row.id]);
      continue;
    }
    // Explicit-offset ISO timestamps have an unambiguous represented instant.
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(row.date)) {
      const instant = Date.parse(row.date);
      if (!Number.isFinite(instant)) throw new Error(`Transaction ${row.id} has an invalid legacy timestamp; migration was rolled back.`);
      await database.runAsync('UPDATE "Transaction" SET date=? WHERE id=?', [new Date(instant).toISOString(), row.id]);
    }
  }

  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS Transaction_owner_correction_idx ON "Transaction"(ownerId, correctionOfId);

    CREATE TRIGGER IF NOT EXISTS Account_insert_integrity_guard
    BEFORE INSERT ON Account
    WHEN NEW.ownerId IS NULL
      OR NOT EXISTS (SELECT 1 FROM User u WHERE u.id=NEW.ownerId)
      OR typeof(NEW.balanceMinor)!='integer'
      OR NEW.balanceMinor < -9007199254740991 OR NEW.balanceMinor > 9007199254740991
      OR NEW.currency IS NULL OR NEW.currency NOT IN ('PKR','USD','GBP','EUR','AED','SAR')
    BEGIN SELECT RAISE(ABORT, 'account violates profile, balance, or currency integrity'); END;

    CREATE TRIGGER IF NOT EXISTS Account_update_integrity_guard
    BEFORE UPDATE OF balanceMinor,currency ON Account
    WHEN typeof(NEW.balanceMinor)!='integer'
      OR NEW.balanceMinor < -9007199254740991 OR NEW.balanceMinor > 9007199254740991
      OR NEW.currency IS NULL OR NEW.currency NOT IN ('PKR','USD','GBP','EUR','AED','SAR')
    BEGIN SELECT RAISE(ABORT, 'account violates balance or currency integrity'); END;

    CREATE TRIGGER IF NOT EXISTS Account_history_currency_guard
    BEFORE UPDATE OF balanceMinor,currency ON Account
    WHEN (NEW.balanceMinor IS NOT OLD.balanceMinor OR NEW.currency IS NOT OLD.currency)
      AND EXISTS (SELECT 1 FROM "Transaction" t WHERE t.ownerId=OLD.ownerId AND (t.accountId=OLD.id OR t.toAccountId=OLD.id))
    BEGIN SELECT RAISE(ABORT, 'opening balance and currency are locked after transaction history exists'); END;

    CREATE TRIGGER IF NOT EXISTS Transaction_insert_integrity_guard
    BEFORE INSERT ON "Transaction"
    WHEN NEW.ownerId IS NULL
      OR NOT EXISTS (SELECT 1 FROM User u WHERE u.id=NEW.ownerId)
      OR NEW.accountId IS NULL
      OR NEW.type IS NULL OR NEW.type NOT IN ('Income','Expense','Transfer','Refund','Reversal')
      OR typeof(NEW.amountMinor) != 'integer'
      OR NEW.amountMinor <= 0
      OR NEW.amountMinor > 9007199254740991
      OR NEW.amount IS NULL
      OR ABS(NEW.amount - (NEW.amountMinor / 100.0)) > 0.000000001
      OR (NEW.type='Transfer' AND (NEW.toAccountId IS NULL OR NEW.toAccountId=NEW.accountId))
      OR (NEW.type IN ('Income','Expense','Refund') AND NEW.toAccountId IS NOT NULL)
      OR (NEW.type IN ('Income','Expense','Transfer') AND NEW.reversalOfId IS NOT NULL)
      OR (NEW.type='Refund' AND (NEW.reversalOfId IS NULL OR NEW.correctionOfId IS NOT NULL))
      OR (NEW.type='Reversal' AND (NEW.reversalOfId IS NULL OR NEW.correctionOfId IS NOT NULL))
      OR (NEW.sourceAmountMinor IS NOT NULL AND (typeof(NEW.sourceAmountMinor)!='integer' OR NEW.sourceAmountMinor<=0 OR NEW.sourceAmountMinor>9007199254740991))
      OR (NEW.sourceCurrency IS NOT NULL AND NEW.sourceCurrency NOT IN ('PKR','USD','GBP','EUR','AED','SAR'))
      OR NEW.date IS NULL
      OR (NEW.date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
          AND NEW.date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
      OR NOT EXISTS (SELECT 1 FROM Account a WHERE a.id=NEW.accountId AND a.ownerId=NEW.ownerId)
      OR (NEW.toAccountId IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM Account a WHERE a.id=NEW.toAccountId AND a.ownerId=NEW.ownerId
          AND a.currency=(SELECT source.currency FROM Account source WHERE source.id=NEW.accountId AND source.ownerId=NEW.ownerId)
      ))
      OR (NEW.reversalOfId IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Transaction" original WHERE original.id=NEW.reversalOfId AND original.ownerId=NEW.ownerId
          AND ((NEW.type='Refund' AND original.type='Expense'
            AND (SELECT currency FROM Account WHERE id=original.accountId AND ownerId=original.ownerId)
                = (SELECT currency FROM Account WHERE id=NEW.accountId AND ownerId=NEW.ownerId)
            AND NEW.amountMinor <= original.amountMinor - COALESCE((
            SELECT SUM(refund.amountMinor) FROM "Transaction" refund WHERE refund.ownerId=NEW.ownerId AND refund.type='Refund' AND refund.reversalOfId=original.id
          ),0)) OR (NEW.type='Reversal' AND original.type IN ('Income','Expense','Transfer') AND NEW.amountMinor=original.amountMinor
            AND NEW.accountId=original.accountId AND NEW.toAccountId IS original.toAccountId
            AND NOT EXISTS (SELECT 1 FROM "Transaction" prior WHERE prior.ownerId=NEW.ownerId AND prior.type='Reversal' AND prior.reversalOfId=original.id)
          ))
      ))
      OR (NEW.correctionOfId IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Transaction" original WHERE original.id=NEW.correctionOfId AND original.ownerId=NEW.ownerId
          AND NEW.type IN ('Income','Expense','Transfer')
      ))
    BEGIN SELECT RAISE(ABORT, 'transaction violates cash-ledger integrity'); END;

    CREATE TRIGGER IF NOT EXISTS Transaction_append_only_delete
    BEFORE DELETE ON "Transaction"
    BEGIN SELECT RAISE(ABORT, 'posted transaction history is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS Transaction_financial_update_guard
    BEFORE UPDATE ON "Transaction"
    WHEN NOT (
      (OLD.ownerId IS NULL AND NEW.ownerId IS NOT NULL
        AND NEW.id IS OLD.id AND NEW.amount IS OLD.amount AND NEW.amountMinor IS OLD.amountMinor
        AND NEW.type IS OLD.type AND NEW.category IS OLD.category AND NEW.categoryId IS OLD.categoryId
        AND NEW.classificationId IS OLD.classificationId AND NEW.accountId IS OLD.accountId
        AND NEW.toAccountId IS OLD.toAccountId AND NEW.date IS OLD.date AND NEW.note IS OLD.note
        AND NEW.sourceName IS OLD.sourceName AND NEW.paymentMethod IS OLD.paymentMethod
        AND NEW.sourceAmountMinor IS OLD.sourceAmountMinor AND NEW.sourceCurrency IS OLD.sourceCurrency
        AND NEW.exchangeRate IS OLD.exchangeRate AND NEW.referenceNumber IS OLD.referenceNumber
        AND NEW.taxStatus IS OLD.taxStatus AND NEW.taxYear IS OLD.taxYear
        AND NEW.reversalOfId IS OLD.reversalOfId AND NEW.correctionOfId IS OLD.correctionOfId
        AND EXISTS (SELECT 1 FROM User u WHERE u.id=NEW.ownerId))
      OR (NEW.synced IS NOT OLD.synced
        AND NEW.id IS OLD.id AND NEW.ownerId IS OLD.ownerId AND NEW.amount IS OLD.amount
        AND NEW.amountMinor IS OLD.amountMinor AND NEW.type IS OLD.type AND NEW.category IS OLD.category
        AND NEW.categoryId IS OLD.categoryId AND NEW.classificationId IS OLD.classificationId
        AND NEW.accountId IS OLD.accountId AND NEW.toAccountId IS OLD.toAccountId
        AND NEW.date IS OLD.date AND NEW.note IS OLD.note AND NEW.sourceName IS OLD.sourceName
        AND NEW.paymentMethod IS OLD.paymentMethod AND NEW.sourceAmountMinor IS OLD.sourceAmountMinor
        AND NEW.sourceCurrency IS OLD.sourceCurrency AND NEW.exchangeRate IS OLD.exchangeRate
        AND NEW.referenceNumber IS OLD.referenceNumber AND NEW.taxStatus IS OLD.taxStatus
        AND NEW.taxYear IS OLD.taxYear AND NEW.reversalOfId IS OLD.reversalOfId
        AND NEW.correctionOfId IS OLD.correctionOfId)
    )
    BEGIN SELECT RAISE(ABORT, 'posted transaction history is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS Transaction_account_update_guard_v8
    BEFORE UPDATE OF ownerId,accountId,toAccountId ON "Transaction"
    WHEN NEW.ownerId IS NOT NULL AND (
      NOT EXISTS (SELECT 1 FROM User u WHERE u.id=NEW.ownerId)
      OR NEW.accountId IS NULL
      OR NOT EXISTS (SELECT 1 FROM Account a WHERE a.id=NEW.accountId AND a.ownerId=NEW.ownerId)
      OR (NEW.toAccountId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Account a WHERE a.id=NEW.toAccountId AND a.ownerId=NEW.ownerId))
    )
    BEGIN SELECT RAISE(ABORT, 'transaction account is unavailable to this profile'); END;
  `);

  const invalidLinks = await database.getFirstAsync<CountRow>(`SELECT COUNT(*) AS count FROM "Transaction" t
    WHERE t.reversalOfId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Transaction" o WHERE o.id=t.reversalOfId AND o.ownerId=t.ownerId)
       OR t.correctionOfId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Transaction" o WHERE o.id=t.correctionOfId AND o.ownerId=t.ownerId)`);
  if ((invalidLinks?.count ?? 0) > 0) throw new Error('Legacy transaction links cross profiles or reference missing records; migration was rolled back.');
}

async function migrateCloudSyncV9(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_update;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_update;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_outbox_resolve;
    DROP TRIGGER IF EXISTS ScheduleOccurrence_no_delete;
    CREATE TABLE IF NOT EXISTS CloudIdentity (
      ownerId TEXT PRIMARY KEY NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      cloudUserId TEXT NOT NULL UNIQUE,
      linkedAt TEXT NOT NULL,
      syncEnabled INTEGER NOT NULL DEFAULT 1 CHECK(syncEnabled IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS CloudEntityMap (
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction')),
      localId TEXT NOT NULL,
      cloudId TEXT NOT NULL,
      serverRevision INTEGER,
      PRIMARY KEY(ownerId,entityType,localId),
      UNIQUE(ownerId,entityType,cloudId)
    );
    CREATE TABLE IF NOT EXISTS SyncOutbox (
      mutationId TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      cloudUserId TEXT NOT NULL,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction')),
      entityId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('account.create','account.update','account.archive','transaction.create')),
      payloadVersion INTEGER NOT NULL CHECK(payloadVersion = 1),
      payloadJson TEXT NOT NULL CHECK(json_valid(payloadJson)),
      dependencyEntityId TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','confirmed','rejected')),
      attemptCount INTEGER NOT NULL DEFAULT 0 CHECK(attemptCount >= 0 AND attemptCount <= 20),
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      leaseUntil TEXT,
      lastErrorCategory TEXT,
      serverAckJson TEXT CHECK(serverAckJson IS NULL OR json_valid(serverAckJson)),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(ownerId,mutationId)
    );
    CREATE INDEX IF NOT EXISTS SyncOutbox_ready_idx ON SyncOutbox(ownerId,status,nextAttemptAt,createdAt,mutationId);
    CREATE INDEX IF NOT EXISTS SyncOutbox_entity_idx ON SyncOutbox(ownerId,entityType,entityId,createdAt);
    CREATE TABLE IF NOT EXISTS SyncCursor (
      ownerId TEXT PRIMARY KEY NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      cloudUserId TEXT NOT NULL,
      cursor TEXT NOT NULL DEFAULT '0' CHECK(cursor GLOB '[0-9]*'),
      lastSuccessfulAt TEXT
    );
    CREATE TRIGGER IF NOT EXISTS SyncOutbox_immutable_confirmed
    BEFORE UPDATE ON SyncOutbox WHEN OLD.status='confirmed' AND (
      NEW.mutationId IS NOT OLD.mutationId OR NEW.ownerId IS NOT OLD.ownerId OR
      NEW.cloudUserId IS NOT OLD.cloudUserId OR NEW.entityType IS NOT OLD.entityType OR
      NEW.entityId IS NOT OLD.entityId OR NEW.operation IS NOT OLD.operation OR
      NEW.payloadVersion IS NOT OLD.payloadVersion OR NEW.payloadJson IS NOT OLD.payloadJson OR
      NEW.status IS NOT OLD.status OR NEW.serverAckJson IS NOT OLD.serverAckJson
    ) BEGIN SELECT RAISE(ABORT,'confirmed sync mutations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_account_insert_guard BEFORE INSERT ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation='account.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account writes require an outbox mutation'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_account_update_guard BEFORE UPDATE ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND (NEW.name IS NOT OLD.name OR NEW.type IS NOT OLD.type OR NEW.archivedAt IS NOT OLD.archivedAt OR NEW.balanceMinor IS NOT OLD.balanceMinor OR NEW.currency IS NOT OLD.currency)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation IN ('account.update','account.archive') AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account changes require an outbox mutation'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_transaction_insert_guard BEFORE INSERT ON "Transaction"
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='transaction' AND o.entityId=NEW.id AND o.operation='transaction.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked transaction writes require an outbox mutation'); END;
  `);
  const localOnlyTables = [
    'Budget','SavingsGoal','SavingsGoalEvent','EmergencyFundConfig','EmergencyFundEvent',
    'RecurringSchedule','ScheduleOccurrence','Bill','BillPayment','Debt','DebtEvent','DebtInterestEvent',
    'BillPaymentCorrection','DebtEventCorrection','DebtRepaymentSchedule',
    'Asset','AssetValuation','AssetActivity','InvestmentPortfolio','InvestmentHolding','InvestmentEvent','InvestmentPrice',
  ];
  for (const table of localOnlyTables) {
    const safe = table.replaceAll('"','""');
    await database.execAsync(`
      CREATE TRIGGER IF NOT EXISTS CloudSync_${table}_local_only_insert BEFORE INSERT ON "${safe}"
      WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
      CREATE TRIGGER IF NOT EXISTS CloudSync_${table}_local_only_update BEFORE UPDATE ON "${safe}"
      WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=OLD.ownerId AND c.syncEnabled=1)
      BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
      CREATE TRIGGER IF NOT EXISTS CloudSync_${table}_local_only_delete BEFORE DELETE ON "${safe}"
      WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=OLD.ownerId AND c.syncEnabled=1)
      BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
    `);
  }
  await database.execAsync(`
    CREATE TRIGGER IF NOT EXISTS CloudSync_BillPaymentCorrectionReplacement_local_only_insert BEFORE INSERT ON BillPaymentCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM BillPaymentCorrection p JOIN CloudIdentity c ON c.ownerId=p.ownerId AND c.syncEnabled=1 WHERE p.id=NEW.correctionId)
    BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_BillPaymentCorrectionReplacement_local_only_update BEFORE UPDATE ON BillPaymentCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM BillPaymentCorrection p JOIN CloudIdentity c ON c.ownerId=p.ownerId AND c.syncEnabled=1 WHERE p.id=OLD.correctionId)
    BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_BillPaymentCorrectionReplacement_local_only_delete BEFORE DELETE ON BillPaymentCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM BillPaymentCorrection p JOIN CloudIdentity c ON c.ownerId=p.ownerId AND c.syncEnabled=1 WHERE p.id=OLD.correctionId)
    BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_DebtEventCorrectionReplacement_local_only_insert BEFORE INSERT ON DebtEventCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM DebtEventCorrection p JOIN CloudIdentity c ON c.ownerId=p.ownerId AND c.syncEnabled=1 WHERE p.id=NEW.correctionId)
    BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_DebtEventCorrectionReplacement_local_only_update BEFORE UPDATE ON DebtEventCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM DebtEventCorrection p JOIN CloudIdentity c ON c.ownerId=p.ownerId AND c.syncEnabled=1 WHERE p.id=OLD.correctionId)
    BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
    CREATE TRIGGER IF NOT EXISTS CloudSync_DebtEventCorrectionReplacement_local_only_delete BEFORE DELETE ON DebtEventCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM DebtEventCorrection p JOIN CloudIdentity c ON c.ownerId=p.ownerId AND c.syncEnabled=1 WHERE p.id=OLD.correctionId)
    BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
  `);
}

/** Extends the existing durable queue to immutable budget revisions and archive metadata. */
async function migrateCloudBudgetSyncV10(database: MigrationDatabase): Promise<void> {
  const budgetColumns = await columnsFor(database, 'Budget');
  await addColumnIfMissing(database, 'Budget', budgetColumns, 'synced', 'INTEGER NOT NULL DEFAULT 0 CHECK(synced IN (0,1))');
  await database.execAsync(`
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_update;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_update;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_outbox_resolve;
    DROP TRIGGER IF EXISTS ScheduleOccurrence_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_SavingsGoal_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_SavingsGoal_outbox_update;
    DROP TRIGGER IF EXISTS CloudSync_SavingsGoalEvent_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_EmergencyFundConfig_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_EmergencyFundConfig_outbox_update;
    DROP TRIGGER IF EXISTS CloudSync_EmergencyFundEvent_outbox_insert;
    DROP TRIGGER IF EXISTS SyncOutbox_immutable_confirmed;
    DROP TRIGGER IF EXISTS CloudSync_account_insert_guard;
    DROP TRIGGER IF EXISTS CloudSync_account_update_guard;
    DROP TRIGGER IF EXISTS CloudSync_transaction_insert_guard;
    DROP TRIGGER IF EXISTS CloudSync_Budget_local_only_insert;
    DROP TRIGGER IF EXISTS CloudSync_Budget_local_only_update;
    DROP TRIGGER IF EXISTS CloudSync_Budget_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_Budget_outbox_archive;
    DROP INDEX IF EXISTS SyncOutbox_ready_idx;
    DROP INDEX IF EXISTS SyncOutbox_entity_idx;
    ALTER TABLE CloudEntityMap RENAME TO CloudEntityMap_v9;
    CREATE TABLE CloudEntityMap (
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget')),
      localId TEXT NOT NULL,
      cloudId TEXT NOT NULL,
      serverRevision INTEGER,
      PRIMARY KEY(ownerId,entityType,localId),
      UNIQUE(ownerId,entityType,cloudId)
    );
    INSERT INTO CloudEntityMap SELECT * FROM CloudEntityMap_v9;
    DROP TABLE CloudEntityMap_v9;

    ALTER TABLE SyncOutbox RENAME TO SyncOutbox_v9;
    CREATE TABLE SyncOutbox (
      mutationId TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      cloudUserId TEXT NOT NULL,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget')),
      entityId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('account.create','account.update','account.archive','transaction.create','budget.create','budget.revise','budget.archive')),
      payloadVersion INTEGER NOT NULL CHECK(payloadVersion = 1),
      payloadJson TEXT NOT NULL CHECK(json_valid(payloadJson)),
      dependencyEntityId TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','confirmed','rejected')),
      attemptCount INTEGER NOT NULL DEFAULT 0 CHECK(attemptCount >= 0 AND attemptCount <= 20),
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      leaseUntil TEXT,
      lastErrorCategory TEXT,
      serverAckJson TEXT CHECK(serverAckJson IS NULL OR json_valid(serverAckJson)),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(ownerId,mutationId)
    );
    INSERT INTO SyncOutbox SELECT * FROM SyncOutbox_v9;
    DROP TABLE SyncOutbox_v9;
    CREATE INDEX SyncOutbox_ready_idx ON SyncOutbox(ownerId,status,nextAttemptAt,createdAt,mutationId);
    CREATE INDEX SyncOutbox_entity_idx ON SyncOutbox(ownerId,entityType,entityId,createdAt);

    CREATE TRIGGER SyncOutbox_immutable_confirmed
    BEFORE UPDATE ON SyncOutbox WHEN OLD.status='confirmed' AND (
      NEW.mutationId IS NOT OLD.mutationId OR NEW.ownerId IS NOT OLD.ownerId OR NEW.cloudUserId IS NOT OLD.cloudUserId OR
      NEW.entityType IS NOT OLD.entityType OR NEW.entityId IS NOT OLD.entityId OR NEW.operation IS NOT OLD.operation OR
      NEW.payloadVersion IS NOT OLD.payloadVersion OR NEW.payloadJson IS NOT OLD.payloadJson OR
      NEW.status IS NOT OLD.status OR NEW.serverAckJson IS NOT OLD.serverAckJson
    ) BEGIN SELECT RAISE(ABORT,'confirmed sync mutations are immutable'); END;
    CREATE TRIGGER CloudSync_account_insert_guard BEFORE INSERT ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation='account.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account writes require an outbox mutation'); END;
    CREATE TRIGGER CloudSync_account_update_guard BEFORE UPDATE ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND (NEW.name IS NOT OLD.name OR NEW.type IS NOT OLD.type OR NEW.archivedAt IS NOT OLD.archivedAt OR NEW.balanceMinor IS NOT OLD.balanceMinor OR NEW.currency IS NOT OLD.currency)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation IN ('account.update','account.archive') AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account changes require an outbox mutation'); END;
    CREATE TRIGGER CloudSync_transaction_insert_guard BEFORE INSERT ON "Transaction"
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='transaction' AND o.entityId=NEW.id AND o.operation='transaction.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked transaction writes require an outbox mutation'); END;

    CREATE TRIGGER CloudSync_Budget_outbox_insert AFTER INSERT ON Budget
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
      SELECT CASE WHEN NEW.supersedesId IS NULL THEN 'budget.create:'||NEW.id ELSE 'budget.revise:'||NEW.id END,
        NEW.ownerId,c.cloudUserId,'budget',NEW.id,CASE WHEN NEW.supersedesId IS NULL THEN 'budget.create' ELSE 'budget.revise' END,1,
        CASE WHEN NEW.supersedesId IS NULL THEN json_object('id',NEW.id,'categoryId',NEW.categoryId,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'periodStart',NEW.periodStart,'periodEnd',NEW.periodEnd,'rolloverPolicy',NEW.rolloverPolicy)
        ELSE json_object('budgetId',NEW.supersedesId,'expectedRevision',NEW.revision-1,'categoryId',NEW.categoryId,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'periodStart',NEW.periodStart,'periodEnd',NEW.periodEnd,'rolloverPolicy',NEW.rolloverPolicy) END,
        'pending',0,0,NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_Budget_outbox_archive AFTER UPDATE OF archivedAt ON Budget
    WHEN NEW.synced=0 AND OLD.archivedAt IS NULL AND NEW.archivedAt IS NOT NULL
      AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
      SELECT 'budget.archive:'||NEW.id,NEW.ownerId,c.cloudUserId,'budget',NEW.id,'budget.archive',1,json_object('id',NEW.id),'pending',0,0,NEW.archivedAt,NEW.archivedAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
  `);

  const localOnlyTables = [
    'SavingsGoal','SavingsGoalEvent','EmergencyFundConfig','EmergencyFundEvent',
    'RecurringSchedule','ScheduleOccurrence','Bill','BillPayment','Debt','DebtEvent','DebtInterestEvent',
    'BillPaymentCorrection','DebtEventCorrection','DebtRepaymentSchedule',
    'Asset','AssetValuation','AssetActivity','InvestmentPortfolio','InvestmentHolding','InvestmentEvent','InvestmentPrice',
  ];
  for (const table of localOnlyTables) {
    const safe = table.replaceAll('"','""');
    await database.execAsync(`
      CREATE TRIGGER IF NOT EXISTS CloudSync_${safe}_local_only_insert BEFORE INSERT ON "${safe}"
      WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
      CREATE TRIGGER IF NOT EXISTS CloudSync_${safe}_local_only_update BEFORE UPDATE ON "${safe}"
      WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=OLD.ownerId AND c.syncEnabled=1)
      BEGIN SELECT RAISE(ABORT,'this financial module is not supported for cloud-linked profiles'); END;
    `);
  }
}

/** Adds durable cloud mutations for savings goals and emergency-fund reservations. */
async function migrateCloudSavingsSyncV11(database: MigrationDatabase): Promise<void> {
  for (const table of ['SavingsGoal', 'SavingsGoalEvent', 'EmergencyFundConfig', 'EmergencyFundEvent']) {
    const columns = await columnsFor(database, table);
    await addColumnIfMissing(database, table, columns, 'synced', 'INTEGER NOT NULL DEFAULT 0 CHECK(synced IN (0,1))');
  }
  await database.execAsync(`
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_update;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_update;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_outbox_resolve;
    DROP TRIGGER IF EXISTS ScheduleOccurrence_no_delete;
    DROP TRIGGER IF EXISTS CloudSync_account_insert_guard;
    DROP TRIGGER IF EXISTS CloudSync_account_update_guard;
    DROP TRIGGER IF EXISTS CloudSync_transaction_insert_guard;
    DROP TRIGGER IF EXISTS CloudSync_Budget_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_Budget_outbox_archive;
    DROP INDEX IF EXISTS SyncOutbox_ready_idx;
    DROP INDEX IF EXISTS SyncOutbox_entity_idx;
    ALTER TABLE CloudEntityMap RENAME TO CloudEntityMap_v10;
    CREATE TABLE CloudEntityMap (
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget','savings_goal','savings_goal_event','emergency_config','emergency_event')),
      localId TEXT NOT NULL, cloudId TEXT NOT NULL, serverRevision INTEGER,
      PRIMARY KEY(ownerId,entityType,localId), UNIQUE(ownerId,entityType,cloudId)
    );
    INSERT INTO CloudEntityMap SELECT * FROM CloudEntityMap_v10;
    DROP TABLE CloudEntityMap_v10;

    ALTER TABLE SyncOutbox RENAME TO SyncOutbox_v10;
    CREATE TABLE SyncOutbox (
      mutationId TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      cloudUserId TEXT NOT NULL,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget','savings_goal','savings_goal_event','emergency_config','emergency_event')),
      entityId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('account.create','account.update','account.archive','transaction.create','budget.create','budget.revise','budget.archive',
        'saving.goal.create','saving.goal.update','saving.goal.event','emergency.config.save','emergency.event')),
      payloadVersion INTEGER NOT NULL CHECK(payloadVersion = 1), payloadJson TEXT NOT NULL CHECK(json_valid(payloadJson)),
      dependencyEntityId TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','confirmed','rejected')),
      attemptCount INTEGER NOT NULL DEFAULT 0 CHECK(attemptCount >= 0 AND attemptCount <= 20), nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      leaseUntil TEXT, lastErrorCategory TEXT, serverAckJson TEXT CHECK(serverAckJson IS NULL OR json_valid(serverAckJson)),
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(ownerId,mutationId)
    );
    INSERT INTO SyncOutbox SELECT * FROM SyncOutbox_v10;
    DROP TABLE SyncOutbox_v10;
    CREATE INDEX SyncOutbox_ready_idx ON SyncOutbox(ownerId,status,nextAttemptAt,createdAt,mutationId);
    CREATE INDEX SyncOutbox_entity_idx ON SyncOutbox(ownerId,entityType,entityId,createdAt);
    DROP TRIGGER IF EXISTS SyncOutbox_immutable_confirmed;
    CREATE TRIGGER SyncOutbox_immutable_confirmed BEFORE UPDATE ON SyncOutbox WHEN OLD.status='confirmed' AND (
      NEW.mutationId IS NOT OLD.mutationId OR NEW.ownerId IS NOT OLD.ownerId OR NEW.cloudUserId IS NOT OLD.cloudUserId OR
      NEW.entityType IS NOT OLD.entityType OR NEW.entityId IS NOT OLD.entityId OR NEW.operation IS NOT OLD.operation OR
      NEW.payloadVersion IS NOT OLD.payloadVersion OR NEW.payloadJson IS NOT OLD.payloadJson OR NEW.status IS NOT OLD.status OR NEW.serverAckJson IS NOT OLD.serverAckJson
    ) BEGIN SELECT RAISE(ABORT,'confirmed sync mutations are immutable'); END;
  `);

  const localOnly = ['SavingsGoal','SavingsGoalEvent','EmergencyFundConfig','EmergencyFundEvent'];
  for (const table of localOnly) {
    const safe = table.replaceAll('"','""');
    await database.execAsync(`DROP TRIGGER IF EXISTS CloudSync_${safe}_local_only_insert; DROP TRIGGER IF EXISTS CloudSync_${safe}_local_only_update;`);
  }
  await database.execAsync(`
    CREATE TRIGGER CloudSync_account_insert_guard BEFORE INSERT ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation='account.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account writes require an outbox mutation'); END;
    CREATE TRIGGER CloudSync_account_update_guard BEFORE UPDATE ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND (NEW.name IS NOT OLD.name OR NEW.type IS NOT OLD.type OR NEW.archivedAt IS NOT OLD.archivedAt OR NEW.balanceMinor IS NOT OLD.balanceMinor OR NEW.currency IS NOT OLD.currency)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation IN ('account.update','account.archive') AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account changes require an outbox mutation'); END;
    CREATE TRIGGER CloudSync_Budget_outbox_insert AFTER INSERT ON Budget
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
      SELECT CASE WHEN NEW.supersedesId IS NULL THEN 'budget.create:'||NEW.id ELSE 'budget.revise:'||NEW.id END,NEW.ownerId,c.cloudUserId,'budget',NEW.id,CASE WHEN NEW.supersedesId IS NULL THEN 'budget.create' ELSE 'budget.revise' END,1,
        CASE WHEN NEW.supersedesId IS NULL THEN json_object('id',NEW.id,'categoryId',NEW.categoryId,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'periodStart',NEW.periodStart,'periodEnd',NEW.periodEnd,'rolloverPolicy',NEW.rolloverPolicy)
        ELSE json_object('budgetId',NEW.supersedesId,'expectedRevision',NEW.revision-1,'categoryId',NEW.categoryId,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'periodStart',NEW.periodStart,'periodEnd',NEW.periodEnd,'rolloverPolicy',NEW.rolloverPolicy) END,
        'pending',0,0,NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_Budget_outbox_archive AFTER UPDATE OF archivedAt ON Budget
    WHEN NEW.synced=0 AND OLD.archivedAt IS NULL AND NEW.archivedAt IS NOT NULL AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
      SELECT 'budget.archive:'||NEW.id,NEW.ownerId,c.cloudUserId,'budget',NEW.id,'budget.archive',1,json_object('id',NEW.id),'pending',0,0,NEW.archivedAt,NEW.archivedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    DROP TRIGGER IF EXISTS CloudSync_transaction_insert_guard;
    CREATE TRIGGER CloudSync_transaction_insert_guard BEFORE INSERT ON "Transaction"
    WHEN NEW.synced=0 AND NEW.id NOT LIKE 'fund-transfer:%' AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='transaction' AND o.entityId=NEW.id AND o.operation='transaction.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked transaction writes require an outbox mutation'); END;
    DROP TRIGGER IF EXISTS SavingsGoalEvent_append_only_update;
    DROP TRIGGER IF EXISTS EmergencyFundEvent_append_only_update;
    CREATE TRIGGER SavingsGoalEvent_append_only_update BEFORE UPDATE ON SavingsGoalEvent
    WHEN NEW.synced != 1 OR OLD.synced != 0 OR
      NEW.id IS NOT OLD.id OR NEW.ownerId IS NOT OLD.ownerId OR NEW.goalId IS NOT OLD.goalId OR NEW.eventType IS NOT OLD.eventType OR
      NEW.amountMinor IS NOT OLD.amountMinor OR NEW.currency IS NOT OLD.currency OR NEW.accountId IS NOT OLD.accountId OR
      NEW.transactionId IS NOT OLD.transactionId OR NEW.idempotencyKey IS NOT OLD.idempotencyKey OR NEW.eventDate IS NOT OLD.eventDate OR
      NEW.note IS NOT OLD.note OR NEW.createdAt IS NOT OLD.createdAt
    BEGIN SELECT RAISE(ABORT,'savings goal history is append-only'); END;
    CREATE TRIGGER EmergencyFundEvent_append_only_update BEFORE UPDATE ON EmergencyFundEvent
    WHEN NEW.synced != 1 OR OLD.synced != 0 OR
      NEW.id IS NOT OLD.id OR NEW.ownerId IS NOT OLD.ownerId OR NEW.eventType IS NOT OLD.eventType OR NEW.amountMinor IS NOT OLD.amountMinor OR
      NEW.currency IS NOT OLD.currency OR NEW.accountId IS NOT OLD.accountId OR NEW.transactionId IS NOT OLD.transactionId OR
      NEW.idempotencyKey IS NOT OLD.idempotencyKey OR NEW.eventDate IS NOT OLD.eventDate OR NEW.note IS NOT OLD.note OR NEW.createdAt IS NOT OLD.createdAt
    BEGIN SELECT RAISE(ABORT,'emergency fund history is append-only'); END;
    CREATE TRIGGER CloudSync_SavingsGoal_outbox_insert AFTER INSERT ON SavingsGoal
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'saving.goal.create:'||NEW.id,NEW.ownerId,c.cloudUserId,'savings_goal',NEW.id,'saving.goal.create',1,
        json_object('id',NEW.id,'name',NEW.name,'targetMinor',CAST(NEW.targetMinor AS TEXT),'currency',NEW.currency,'targetDate',NEW.targetDate,'createdAt',NEW.createdAt,'updatedAt',NEW.updatedAt), 'pending',NEW.createdAt,NEW.createdAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_SavingsGoal_outbox_update AFTER UPDATE ON SavingsGoal
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1) AND
      (NEW.name IS NOT OLD.name OR NEW.targetMinor IS NOT OLD.targetMinor OR NEW.targetDate IS NOT OLD.targetDate OR NEW.status IS NOT OLD.status OR NEW.completedAt IS NOT OLD.completedAt OR NEW.archivedAt IS NOT OLD.archivedAt)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'saving.goal.update:'||NEW.id||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'savings_goal',NEW.id,'saving.goal.update',1,
        json_object('id',NEW.id,'name',NEW.name,'targetMinor',CAST(NEW.targetMinor AS TEXT),'targetDate',NEW.targetDate,'status',NEW.status,'completedAt',NEW.completedAt,'archivedAt',NEW.archivedAt,'expectedUpdatedAt',OLD.updatedAt,'updatedAt',NEW.updatedAt), 'pending',NEW.updatedAt,NEW.updatedAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_SavingsGoalEvent_outbox_insert AFTER INSERT ON SavingsGoalEvent
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,dependencyEntityId,createdAt,updatedAt)
      SELECT 'saving.goal.event:'||NEW.id,NEW.ownerId,c.cloudUserId,'savings_goal_event',NEW.id,'saving.goal.event',1,
        json_object('id',NEW.id,'goalId',NEW.goalId,'eventType',NEW.eventType,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'accountId',NEW.accountId,'transactionId',NEW.transactionId,'idempotencyKey',NEW.idempotencyKey,'eventDate',NEW.eventDate,'note',NEW.note,
          'sourceAccountId',(SELECT accountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId),
          'destinationAccountId',(SELECT toAccountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId)), 'pending',NEW.goalId,NEW.createdAt,NEW.createdAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_EmergencyFundConfig_outbox_insert AFTER INSERT ON EmergencyFundConfig
    WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'emergency.config:'||NEW.ownerId||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'emergency_config',NEW.ownerId,'emergency.config.save',1,
        json_object('currency',NEW.currency,'coverageMonths',NEW.coverageMonths,'essentialMonthlyMinor',CAST(NEW.essentialMonthlyMinor AS TEXT)), 'pending',NEW.updatedAt,NEW.updatedAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_EmergencyFundConfig_outbox_update AFTER UPDATE ON EmergencyFundConfig
    WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1) AND
      (NEW.currency IS NOT OLD.currency OR NEW.coverageMonths IS NOT OLD.coverageMonths OR NEW.essentialMonthlyMinor IS NOT OLD.essentialMonthlyMinor)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'emergency.config:'||NEW.ownerId||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'emergency_config',NEW.ownerId,'emergency.config.save',1,
        json_object('currency',NEW.currency,'coverageMonths',NEW.coverageMonths,'essentialMonthlyMinor',CAST(NEW.essentialMonthlyMinor AS TEXT)), 'pending',NEW.updatedAt,NEW.updatedAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_EmergencyFundEvent_outbox_insert AFTER INSERT ON EmergencyFundEvent
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,dependencyEntityId,createdAt,updatedAt)
      SELECT 'emergency.event:'||NEW.id,NEW.ownerId,c.cloudUserId,'emergency_event',NEW.id,'emergency.event',1,
        json_object('id',NEW.id,'eventType',NEW.eventType,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'accountId',NEW.accountId,'transactionId',NEW.transactionId,'idempotencyKey',NEW.idempotencyKey,'eventDate',NEW.eventDate,'note',NEW.note,
          'sourceAccountId',(SELECT accountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId),
          'destinationAccountId',(SELECT toAccountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId)), 'pending',NEW.accountId,NEW.createdAt,NEW.createdAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
  `);
}

/** Adds durable cloud mutations for non-bill recurring schedules and their occurrences. */
async function migrateRecurringScheduleSyncV12(database: MigrationDatabase): Promise<void> {
  for (const table of ['RecurringSchedule', 'ScheduleOccurrence']) {
    const columns = await columnsFor(database, table);
    await addColumnIfMissing(database, table, columns, 'synced', 'INTEGER NOT NULL DEFAULT 0 CHECK(synced IN (0,1))');
  }
  await database.execAsync(`
    DROP TRIGGER IF EXISTS CloudSync_account_insert_guard;
    DROP TRIGGER IF EXISTS CloudSync_account_update_guard;
    DROP TRIGGER IF EXISTS CloudSync_transaction_insert_guard;
    DROP TRIGGER IF EXISTS CloudSync_Budget_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_Budget_outbox_archive;
    DROP TRIGGER IF EXISTS CloudSync_SavingsGoal_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_SavingsGoal_outbox_update;
    DROP TRIGGER IF EXISTS CloudSync_SavingsGoalEvent_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_EmergencyFundConfig_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_EmergencyFundConfig_outbox_update;
    DROP TRIGGER IF EXISTS CloudSync_EmergencyFundEvent_outbox_insert;
    DROP INDEX IF EXISTS SyncOutbox_ready_idx;
    DROP INDEX IF EXISTS SyncOutbox_entity_idx;
    CREATE TABLE CloudEntityMap_v12 (
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget','savings_goal','savings_goal_event','emergency_config','emergency_event','recurring_schedule','schedule_occurrence')),
      localId TEXT NOT NULL, cloudId TEXT NOT NULL, serverRevision INTEGER,
      PRIMARY KEY(ownerId,entityType,localId), UNIQUE(ownerId,entityType,cloudId)
    );
    INSERT INTO CloudEntityMap_v12 SELECT * FROM CloudEntityMap;
    DROP TABLE CloudEntityMap;
    ALTER TABLE CloudEntityMap_v12 RENAME TO CloudEntityMap;

    CREATE TABLE SyncOutbox_v12 (
      mutationId TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      cloudUserId TEXT NOT NULL,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget','savings_goal','savings_goal_event','emergency_config','emergency_event','recurring_schedule','schedule_occurrence')),
      entityId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('account.create','account.update','account.archive','transaction.create','budget.create','budget.revise','budget.archive',
        'saving.goal.create','saving.goal.update','saving.goal.event','emergency.config.save','emergency.event',
        'recurring.schedule.create','recurring.schedule.update','schedule.occurrence.create','schedule.occurrence.resolve')),
      payloadVersion INTEGER NOT NULL CHECK(payloadVersion = 1), payloadJson TEXT NOT NULL CHECK(json_valid(payloadJson)),
      dependencyEntityId TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','confirmed','rejected')),
      attemptCount INTEGER NOT NULL DEFAULT 0 CHECK(attemptCount >= 0 AND attemptCount <= 20), nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      leaseUntil TEXT, lastErrorCategory TEXT, serverAckJson TEXT CHECK(serverAckJson IS NULL OR json_valid(serverAckJson)),
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(ownerId,mutationId)
    );
    INSERT INTO SyncOutbox_v12 SELECT * FROM SyncOutbox;
    DROP TABLE SyncOutbox;
    ALTER TABLE SyncOutbox_v12 RENAME TO SyncOutbox;
    CREATE INDEX SyncOutbox_ready_idx ON SyncOutbox(ownerId,status,nextAttemptAt,createdAt,mutationId);
    CREATE INDEX SyncOutbox_entity_idx ON SyncOutbox(ownerId,entityType,entityId,createdAt);
    DROP TRIGGER IF EXISTS SyncOutbox_immutable_confirmed;
    CREATE TRIGGER SyncOutbox_immutable_confirmed BEFORE UPDATE ON SyncOutbox WHEN OLD.status='confirmed' AND (
      NEW.mutationId IS NOT OLD.mutationId OR NEW.ownerId IS NOT OLD.ownerId OR NEW.cloudUserId IS NOT OLD.cloudUserId OR
      NEW.entityType IS NOT OLD.entityType OR NEW.entityId IS NOT OLD.entityId OR NEW.operation IS NOT OLD.operation OR
      NEW.payloadVersion IS NOT OLD.payloadVersion OR NEW.payloadJson IS NOT OLD.payloadJson OR NEW.status IS NOT OLD.status OR NEW.serverAckJson IS NOT OLD.serverAckJson
    ) BEGIN SELECT RAISE(ABORT,'confirmed sync mutations are immutable'); END;
  `);

  await database.execAsync(`
    CREATE TRIGGER CloudSync_account_insert_guard BEFORE INSERT ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation='account.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account writes require an outbox mutation'); END;
    CREATE TRIGGER CloudSync_account_update_guard BEFORE UPDATE ON Account
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND (NEW.name IS NOT OLD.name OR NEW.type IS NOT OLD.type OR NEW.archivedAt IS NOT OLD.archivedAt OR NEW.balanceMinor IS NOT OLD.balanceMinor OR NEW.currency IS NOT OLD.currency)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='account' AND o.entityId=NEW.id AND o.operation IN ('account.update','account.archive') AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked account changes require an outbox mutation'); END;
    CREATE TRIGGER CloudSync_Budget_outbox_insert AFTER INSERT ON Budget
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
      SELECT CASE WHEN NEW.supersedesId IS NULL THEN 'budget.create:'||NEW.id ELSE 'budget.revise:'||NEW.id END,NEW.ownerId,c.cloudUserId,'budget',NEW.id,CASE WHEN NEW.supersedesId IS NULL THEN 'budget.create' ELSE 'budget.revise' END,1,
        CASE WHEN NEW.supersedesId IS NULL THEN json_object('id',NEW.id,'categoryId',NEW.categoryId,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'periodStart',NEW.periodStart,'periodEnd',NEW.periodEnd,'rolloverPolicy',NEW.rolloverPolicy)
        ELSE json_object('budgetId',NEW.supersedesId,'expectedRevision',NEW.revision-1,'categoryId',NEW.categoryId,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'periodStart',NEW.periodStart,'periodEnd',NEW.periodEnd,'rolloverPolicy',NEW.rolloverPolicy) END,
        'pending',0,0,NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_Budget_outbox_archive AFTER UPDATE OF archivedAt ON Budget
    WHEN NEW.synced=0 AND OLD.archivedAt IS NULL AND NEW.archivedAt IS NOT NULL AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,attemptCount,nextAttemptAt,createdAt,updatedAt)
      SELECT 'budget.archive:'||NEW.id,NEW.ownerId,c.cloudUserId,'budget',NEW.id,'budget.archive',1,json_object('id',NEW.id),'pending',0,0,NEW.archivedAt,NEW.archivedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_transaction_insert_guard BEFORE INSERT ON "Transaction"
    WHEN NEW.synced=0 AND NEW.id NOT LIKE 'fund-transfer:%' AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
      AND NOT EXISTS(SELECT 1 FROM SyncOutbox o WHERE o.ownerId=NEW.ownerId AND o.entityType='transaction' AND o.entityId=NEW.id AND o.operation='transaction.create' AND o.status IN ('pending','in_flight','confirmed'))
    BEGIN SELECT RAISE(ABORT,'cloud-linked transaction writes require an outbox mutation'); END;
    CREATE TRIGGER CloudSync_SavingsGoal_outbox_insert AFTER INSERT ON SavingsGoal
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'saving.goal.create:'||NEW.id,NEW.ownerId,c.cloudUserId,'savings_goal',NEW.id,'saving.goal.create',1,
        json_object('id',NEW.id,'name',NEW.name,'targetMinor',CAST(NEW.targetMinor AS TEXT),'currency',NEW.currency,'targetDate',NEW.targetDate,'createdAt',NEW.createdAt,'updatedAt',NEW.updatedAt), 'pending',NEW.createdAt,NEW.createdAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_SavingsGoal_outbox_update AFTER UPDATE ON SavingsGoal
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1) AND
      (NEW.name IS NOT OLD.name OR NEW.targetMinor IS NOT OLD.targetMinor OR NEW.targetDate IS NOT OLD.targetDate OR NEW.status IS NOT OLD.status OR NEW.completedAt IS NOT OLD.completedAt OR NEW.archivedAt IS NOT OLD.archivedAt)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'saving.goal.update:'||NEW.id||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'savings_goal',NEW.id,'saving.goal.update',1,
        json_object('id',NEW.id,'name',NEW.name,'targetMinor',CAST(NEW.targetMinor AS TEXT),'targetDate',NEW.targetDate,'status',NEW.status,'completedAt',NEW.completedAt,'archivedAt',NEW.archivedAt,'expectedUpdatedAt',OLD.updatedAt,'updatedAt',NEW.updatedAt), 'pending',NEW.updatedAt,NEW.updatedAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_SavingsGoalEvent_outbox_insert AFTER INSERT ON SavingsGoalEvent
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,dependencyEntityId,createdAt,updatedAt)
      SELECT 'saving.goal.event:'||NEW.id,NEW.ownerId,c.cloudUserId,'savings_goal_event',NEW.id,'saving.goal.event',1,
        json_object('id',NEW.id,'goalId',NEW.goalId,'eventType',NEW.eventType,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'accountId',NEW.accountId,'transactionId',NEW.transactionId,'idempotencyKey',NEW.idempotencyKey,'eventDate',NEW.eventDate,'note',NEW.note,
          'sourceAccountId',(SELECT accountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId),'destinationAccountId',(SELECT toAccountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId)), 'pending',NEW.goalId,NEW.createdAt,NEW.createdAt
      FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_EmergencyFundConfig_outbox_insert AFTER INSERT ON EmergencyFundConfig
    WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'emergency.config:'||NEW.ownerId||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'emergency_config',NEW.ownerId,'emergency.config.save',1,
        json_object('currency',NEW.currency,'coverageMonths',NEW.coverageMonths,'essentialMonthlyMinor',CAST(NEW.essentialMonthlyMinor AS TEXT)), 'pending',NEW.updatedAt,NEW.updatedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_EmergencyFundConfig_outbox_update AFTER UPDATE ON EmergencyFundConfig
    WHEN EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1) AND
      (NEW.currency IS NOT OLD.currency OR NEW.coverageMonths IS NOT OLD.coverageMonths OR NEW.essentialMonthlyMinor IS NOT OLD.essentialMonthlyMinor)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,createdAt,updatedAt)
      SELECT 'emergency.config:'||NEW.ownerId||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'emergency_config',NEW.ownerId,'emergency.config.save',1,
        json_object('currency',NEW.currency,'coverageMonths',NEW.coverageMonths,'essentialMonthlyMinor',CAST(NEW.essentialMonthlyMinor AS TEXT)), 'pending',NEW.updatedAt,NEW.updatedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
    CREATE TRIGGER CloudSync_EmergencyFundEvent_outbox_insert AFTER INSERT ON EmergencyFundEvent
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1)
    BEGIN INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,status,dependencyEntityId,createdAt,updatedAt)
      SELECT 'emergency.event:'||NEW.id,NEW.ownerId,c.cloudUserId,'emergency_event',NEW.id,'emergency.event',1,
        json_object('id',NEW.id,'eventType',NEW.eventType,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,'accountId',NEW.accountId,'transactionId',NEW.transactionId,'idempotencyKey',NEW.idempotencyKey,'eventDate',NEW.eventDate,'note',NEW.note,
          'sourceAccountId',(SELECT accountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId),'destinationAccountId',(SELECT toAccountId FROM "Transaction" WHERE id=NEW.transactionId AND ownerId=NEW.ownerId)), 'pending',NEW.accountId,NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1; END;
  `);

  for (const table of ['RecurringSchedule', 'ScheduleOccurrence']) {
    await database.execAsync(`DROP TRIGGER IF EXISTS CloudSync_${table}_local_only_insert; DROP TRIGGER IF EXISTS CloudSync_${table}_local_only_update; DROP TRIGGER IF EXISTS CloudSync_${table}_local_only_delete;`);
  }
  await database.execAsync(`
    DROP TRIGGER IF EXISTS ScheduleOccurrence_no_delete;
    CREATE TRIGGER CloudSync_RecurringSchedule_bill_insert BEFORE INSERT ON RecurringSchedule
    WHEN NEW.scheduleType='bill' AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
    BEGIN SELECT RAISE(ABORT,'recurring bill schedules are not supported for cloud-linked profiles yet'); END;
    CREATE TRIGGER CloudSync_RecurringSchedule_bill_update BEFORE UPDATE ON RecurringSchedule
    WHEN (NEW.scheduleType='bill' OR OLD.scheduleType='bill') AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
    BEGIN SELECT RAISE(ABORT,'recurring bill schedules are not supported for cloud-linked profiles yet'); END;
    CREATE TRIGGER CloudSync_RecurringSchedule_no_delete BEFORE DELETE ON RecurringSchedule
    WHEN EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=OLD.ownerId AND syncEnabled=1)
    BEGIN SELECT RAISE(ABORT,'cloud-linked recurring schedules cannot be deleted'); END;
    CREATE TRIGGER ScheduleOccurrence_no_delete BEFORE DELETE ON ScheduleOccurrence
    BEGIN SELECT RAISE(ABORT,'schedule occurrence history cannot be deleted'); END;

    CREATE TRIGGER CloudSync_RecurringSchedule_outbox_insert AFTER INSERT ON RecurringSchedule
    WHEN NEW.synced=0 AND NEW.scheduleType!='bill' AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
      SELECT 'recurring.schedule.create:'||NEW.id,NEW.ownerId,c.cloudUserId,'recurring_schedule',NEW.id,'recurring.schedule.create',1,
        json_object('id',NEW.id,'scheduleType',NEW.scheduleType,'name',NEW.name,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,
          'classificationId',NEW.classificationId,'accountId',NEW.accountId,'toAccountId',NEW.toAccountId,'frequency',NEW.frequency,'startDate',NEW.startDate,
          'endDate',NEW.endDate,'nextDueDate',NEW.nextDueDate,'status',NEW.status,'createdAt',NEW.createdAt,'updatedAt',NEW.updatedAt),
        NEW.accountId,'pending',NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_RecurringSchedule_outbox_update AFTER UPDATE ON RecurringSchedule
    WHEN NEW.synced=0 AND NEW.scheduleType!='bill' AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1) AND
      (NEW.name IS NOT OLD.name OR NEW.amountMinor IS NOT OLD.amountMinor OR NEW.currency IS NOT OLD.currency OR NEW.classificationId IS NOT OLD.classificationId OR
       NEW.accountId IS NOT OLD.accountId OR NEW.toAccountId IS NOT OLD.toAccountId OR NEW.frequency IS NOT OLD.frequency OR NEW.startDate IS NOT OLD.startDate OR
       NEW.endDate IS NOT OLD.endDate OR NEW.nextDueDate IS NOT OLD.nextDueDate OR NEW.status IS NOT OLD.status)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
      SELECT 'recurring.schedule.update:'||NEW.id||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'recurring_schedule',NEW.id,'recurring.schedule.update',1,
        json_object('id',NEW.id,'scheduleType',NEW.scheduleType,'name',NEW.name,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,
          'classificationId',NEW.classificationId,'accountId',NEW.accountId,'toAccountId',NEW.toAccountId,'frequency',NEW.frequency,'startDate',NEW.startDate,
          'endDate',NEW.endDate,'nextDueDate',NEW.nextDueDate,'status',NEW.status,'expectedUpdatedAt',OLD.updatedAt,'updatedAt',NEW.updatedAt),
        NEW.accountId,'pending',NEW.updatedAt,NEW.updatedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_ScheduleOccurrence_outbox_insert AFTER INSERT ON ScheduleOccurrence
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
      SELECT 'schedule.occurrence.create:'||NEW.id,NEW.ownerId,c.cloudUserId,'schedule_occurrence',NEW.id,'schedule.occurrence.create',1,
        json_object('id',NEW.id,'scheduleId',NEW.scheduleId,'occurrenceDate',NEW.occurrenceDate,'status','pending','createdAt',NEW.createdAt),
        NEW.scheduleId,'pending',NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_ScheduleOccurrence_outbox_resolve AFTER UPDATE ON ScheduleOccurrence
    WHEN OLD.status='pending' AND NEW.status IN ('posted','skipped') AND NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
      SELECT 'schedule.occurrence.resolve:'||NEW.id||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'schedule_occurrence',NEW.id,'schedule.occurrence.resolve',1,
        json_object('scheduleId',NEW.scheduleId,'status',NEW.status,'transactionId',NEW.transactionId,'resolvedAt',NEW.resolvedAt,
          'expectedRevision',COALESCE((SELECT serverRevision FROM CloudEntityMap WHERE ownerId=NEW.ownerId AND entityType='schedule_occurrence' AND localId=NEW.id),1)),
        NEW.scheduleId,'pending',NEW.resolvedAt,NEW.resolvedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
  `);
}

/** Adds outbox support for the existing obligation, asset, and investment ledgers. */
async function migrateExtendedFinanceSyncV13(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    DROP TRIGGER IF EXISTS CloudSync_ScheduleOccurrence_outbox_resolve;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_bill_update;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_insert;
    DROP TRIGGER IF EXISTS CloudSync_RecurringSchedule_outbox_update;
    PRAGMA legacy_alter_table=ON;
    ALTER TABLE CloudEntityMap RENAME TO CloudEntityMap_v12;
    CREATE TABLE CloudEntityMap (
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget','savings_goal','savings_goal_event','emergency_config','emergency_event','recurring_schedule','schedule_occurrence','bill','bill_payment','bill_payment_correction','debt','debt_event','debt_interest_event','debt_event_correction','debt_repayment_schedule','asset','asset_valuation','asset_activity','investment_portfolio','investment_holding','investment_event','investment_price')),
      localId TEXT NOT NULL, cloudId TEXT NOT NULL, serverRevision INTEGER,
      PRIMARY KEY(ownerId,entityType,localId), UNIQUE(ownerId,entityType,cloudId)
    );
    INSERT INTO CloudEntityMap SELECT * FROM CloudEntityMap_v12;
    DROP TABLE CloudEntityMap_v12;
    DROP INDEX IF EXISTS SyncOutbox_ready_idx;
    DROP INDEX IF EXISTS SyncOutbox_entity_idx;
    ALTER TABLE SyncOutbox RENAME TO SyncOutbox_v12;
    CREATE TABLE SyncOutbox (
      mutationId TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      cloudUserId TEXT NOT NULL,
      entityType TEXT NOT NULL CHECK(entityType IN ('account','transaction','budget','savings_goal','savings_goal_event','emergency_config','emergency_event','recurring_schedule','schedule_occurrence','bill','bill_payment','bill_payment_correction','debt','debt_event','debt_interest_event','debt_event_correction','debt_repayment_schedule','asset','asset_valuation','asset_activity','investment_portfolio','investment_holding','investment_event','investment_price')),
      entityId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('account.create','account.update','account.archive','transaction.create','budget.create','budget.revise','budget.archive',
        'saving.goal.create','saving.goal.update','saving.goal.event','emergency.config.save','emergency.event',
        'recurring.schedule.create','recurring.schedule.update','schedule.occurrence.create','schedule.occurrence.resolve',
        'domain.create','domain.update')),
      payloadVersion INTEGER NOT NULL CHECK(payloadVersion = 1), payloadJson TEXT NOT NULL CHECK(json_valid(payloadJson)),
      dependencyEntityId TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','confirmed','rejected')),
      attemptCount INTEGER NOT NULL DEFAULT 0 CHECK(attemptCount >= 0 AND attemptCount <= 20), nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      leaseUntil TEXT, lastErrorCategory TEXT, serverAckJson TEXT CHECK(serverAckJson IS NULL OR json_valid(serverAckJson)),
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(ownerId,mutationId)
    );
    INSERT INTO SyncOutbox SELECT * FROM SyncOutbox_v12;
    DROP TABLE SyncOutbox_v12;
    CREATE INDEX SyncOutbox_ready_idx ON SyncOutbox(ownerId,status,nextAttemptAt,createdAt,mutationId);
    CREATE INDEX SyncOutbox_entity_idx ON SyncOutbox(ownerId,entityType,entityId,createdAt);
    DROP TRIGGER IF EXISTS SyncOutbox_immutable_confirmed;
    CREATE TRIGGER SyncOutbox_immutable_confirmed BEFORE UPDATE ON SyncOutbox WHEN OLD.status='confirmed' AND (
      NEW.mutationId IS NOT OLD.mutationId OR NEW.ownerId IS NOT OLD.ownerId OR NEW.cloudUserId IS NOT OLD.cloudUserId OR
      NEW.entityType IS NOT OLD.entityType OR NEW.entityId IS NOT OLD.entityId OR NEW.operation IS NOT OLD.operation OR
      NEW.payloadVersion IS NOT OLD.payloadVersion OR NEW.payloadJson IS NOT OLD.payloadJson OR NEW.status IS NOT OLD.status OR NEW.serverAckJson IS NOT OLD.serverAckJson
    ) BEGIN SELECT RAISE(ABORT,'confirmed sync mutations are immutable'); END;
    PRAGMA legacy_alter_table=OFF;
  `);
  await database.execAsync(`
    CREATE TRIGGER CloudSync_RecurringSchedule_outbox_insert AFTER INSERT ON RecurringSchedule
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
      SELECT 'recurring.schedule.create:'||NEW.id,NEW.ownerId,c.cloudUserId,'recurring_schedule',NEW.id,'recurring.schedule.create',1,
        json_object('id',NEW.id,'scheduleType',NEW.scheduleType,'name',NEW.name,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,
          'classificationId',NEW.classificationId,'accountId',NEW.accountId,'toAccountId',NEW.toAccountId,'billId',NEW.billId,'frequency',NEW.frequency,'startDate',NEW.startDate,
          'endDate',NEW.endDate,'nextDueDate',NEW.nextDueDate,'status',NEW.status,'createdAt',NEW.createdAt,'updatedAt',NEW.updatedAt),
        COALESCE(NEW.billId,NEW.accountId),'pending',NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_RecurringSchedule_outbox_update AFTER UPDATE ON RecurringSchedule
    WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1) AND
      (NEW.name IS NOT OLD.name OR NEW.amountMinor IS NOT OLD.amountMinor OR NEW.currency IS NOT OLD.currency OR NEW.classificationId IS NOT OLD.classificationId OR
       NEW.accountId IS NOT OLD.accountId OR NEW.toAccountId IS NOT OLD.toAccountId OR NEW.billId IS NOT OLD.billId OR NEW.frequency IS NOT OLD.frequency OR NEW.startDate IS NOT OLD.startDate OR
       NEW.endDate IS NOT OLD.endDate OR NEW.nextDueDate IS NOT OLD.nextDueDate OR NEW.status IS NOT OLD.status)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
      SELECT 'recurring.schedule.update:'||NEW.id||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'recurring_schedule',NEW.id,'recurring.schedule.update',1,
        json_object('id',NEW.id,'scheduleType',NEW.scheduleType,'name',NEW.name,'amountMinor',CAST(NEW.amountMinor AS TEXT),'currency',NEW.currency,
          'classificationId',NEW.classificationId,'accountId',NEW.accountId,'toAccountId',NEW.toAccountId,'billId',NEW.billId,'frequency',NEW.frequency,'startDate',NEW.startDate,
          'endDate',NEW.endDate,'nextDueDate',NEW.nextDueDate,'status',NEW.status,'expectedUpdatedAt',OLD.updatedAt,'updatedAt',NEW.updatedAt),
        COALESCE(NEW.billId,NEW.accountId),'pending',NEW.updatedAt,NEW.updatedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
    CREATE TRIGGER CloudSync_ScheduleOccurrence_outbox_resolve AFTER UPDATE ON ScheduleOccurrence
    WHEN OLD.status='pending' AND NEW.status IN ('posted','skipped') AND NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
    BEGIN
      INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
      SELECT 'schedule.occurrence.resolve:'||NEW.id||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'schedule_occurrence',NEW.id,'schedule.occurrence.resolve',1,
        json_object('scheduleId',NEW.scheduleId,'status',NEW.status,'transactionId',NEW.transactionId,'resolvedAt',NEW.resolvedAt,
          'expectedRevision',COALESCE((SELECT serverRevision FROM CloudEntityMap WHERE ownerId=NEW.ownerId AND entityType='schedule_occurrence' AND localId=NEW.id),1)),
        NEW.scheduleId,'pending',NEW.resolvedAt,NEW.resolvedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
    END;
  `);

  // The JSON payload is a versioned snapshot of each local row. Linked account,
  // transaction, and parent IDs remain explicit for server-side FK validation.
  const specs: { table: string; type: string; parent?: string; account?: string; transaction?: string; columns: string[]; mutable?: boolean }[] = [
    { table: 'Bill', type: 'bill', account: 'accountId', columns: ['id','name','categoryId','amountMinor','currency','dueDate','accountId','scheduleId','status','reminderId','createdAt','updatedAt'], mutable: true },
    { table: 'BillPayment', type: 'bill_payment', parent: 'bill', transaction: 'transactionId', columns: ['id','billId','amountMinor','transactionId','paidAt','idempotencyKey','createdAt'] },
    { table: 'BillPaymentCorrection', type: 'bill_payment_correction', parent: 'bill', transaction: 'reversalTransactionId', columns: ['id','billId','originalPaymentId','reversalTransactionId','replacementPaymentId','reason','createdAt'] },
    { table: 'Debt', type: 'debt', account: 'accountId', columns: ['id','direction','counterparty','principalMinor','currency','accountId','interestRateBps','openedAt','dueDate','status','createdAt','updatedAt'], mutable: true },
    { table: 'DebtEvent', type: 'debt_event', parent: 'debt', account: 'accountId', transaction: 'transactionId', columns: ['id','debtId','eventType','principalMinor','interestMinor','accountId','transactionId','eventDate','idempotencyKey','note','createdAt'] },
    { table: 'DebtInterestEvent', type: 'debt_interest_event', parent: 'debt', columns: ['id','debtId','eventType','amountMinor','reversalOfEventId','eventDate','idempotencyKey','note','createdAt'] },
    { table: 'DebtEventCorrection', type: 'debt_event_correction', parent: 'debt', transaction: 'reversalTransactionId', columns: ['id','debtId','originalEventId','reversalTransactionId','replacementEventId','reason','createdAt'] },
    { table: 'DebtRepaymentSchedule', type: 'debt_repayment_schedule', parent: 'debt', columns: ['id','debtId','frequency','firstDueDate','installmentAmountMinor','interestMethod','rateBps','installmentCount','status','createdAt','updatedAt'], mutable: true },
    { table: 'Asset', type: 'asset', columns: ['id','name','category','currency','purchaseValueMinor','purchaseDate','ownershipBps','notes','createdAt'] },
    { table: 'AssetValuation', type: 'asset_valuation', parent: 'asset', columns: ['id','assetId','valueMinor','valuationDate','source','idempotencyKey','createdAt'] },
    { table: 'AssetActivity', type: 'asset_activity', parent: 'asset', account: 'accountId', transaction: 'transactionId', columns: ['id','assetId','eventType','ownershipBps','costBasisMinor','proceedsMinor','accountId','transactionId','eventDate','idempotencyKey','createdAt'] },
    { table: 'InvestmentPortfolio', type: 'investment_portfolio', account: 'cashAccountId', columns: ['id','name','currency','cashAccountId','createdAt'] },
    { table: 'InvestmentHolding', type: 'investment_holding', parent: 'investment_portfolio', columns: ['id','portfolioId','symbol','name','category','currency','createdAt'] },
    { table: 'InvestmentEvent', type: 'investment_event', parent: 'investment_holding', transaction: 'transactionId', columns: ['id','holdingId','eventType','quantityMicros','unitPriceMinor','feeMinor','amountMinor','splitNumerator','splitDenominator','transactionId','eventDate','idempotencyKey','createdAt'] },
    { table: 'InvestmentPrice', type: 'investment_price', parent: 'investment_holding', columns: ['id','holdingId','unitPriceMinor','priceDate','source','idempotencyKey','createdAt'] },
  ];
  for (const spec of specs) {
    const columns = await columnsFor(database,spec.table);
    await addColumnIfMissing(database,spec.table,columns,'synced','INTEGER NOT NULL DEFAULT 0 CHECK(synced IN (0,1))');
  }
  for (const spec of specs) {
    for (const suffix of ['insert','update','delete']) await database.execAsync(`DROP TRIGGER IF EXISTS CloudSync_${spec.table}_local_only_${suffix}`);
    const data = `json_object(${spec.columns.map((c) => `'${c}',NEW."${c}"`).join(',')})`;
    const parentKey = spec.parent ? spec.columns.find((c) => ['billId','debtId','assetId','portfolioId','holdingId'].includes(c)) : null;
    const parentExpr = parentKey ? `NEW."${parentKey}"` : 'NULL';
    const parentTypeExpr = spec.parent ? `'${spec.parent}'` : 'NULL';
    const accountExpr = spec.account ? `NEW."${spec.account}"` : 'NULL';
    const txExpr = spec.transaction ? `NEW."${spec.transaction}"` : 'NULL';
    const expectedRevision = spec.mutable ? `,'expectedRevision',COALESCE((SELECT serverRevision FROM CloudEntityMap WHERE ownerId=NEW.ownerId AND entityType='${spec.type}' AND localId=NEW.id),1)+(SELECT COUNT(*) FROM SyncOutbox WHERE ownerId=NEW.ownerId AND entityType='${spec.type}' AND entityId=NEW.id AND operation='domain.update' AND status IN ('pending','in_flight'))` : '';
    const immutableGuard = spec.mutable ? '' : `
      CREATE TRIGGER CloudSync_${spec.table}_immutable_update BEFORE UPDATE ON "${spec.table}"
      WHEN EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=OLD.ownerId AND syncEnabled=1)
      BEGIN SELECT RAISE(ABORT,'cloud-linked ${spec.type} history cannot be overwritten'); END;`;
    await database.execAsync(`
      DROP TRIGGER IF EXISTS CloudSync_${spec.table}_outbox_insert;
      DROP TRIGGER IF EXISTS CloudSync_${spec.table}_outbox_update;
      CREATE TRIGGER CloudSync_${spec.table}_outbox_insert AFTER INSERT ON "${spec.table}"
      WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
      BEGIN
        INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
        SELECT 'domain:${spec.type}:'||NEW.id,NEW.ownerId,c.cloudUserId,'${spec.type}',NEW.id,'domain.create',1,
          json_object('entityType','${spec.type}','id',NEW.id,'parentType',${parentTypeExpr},'parentId',${parentExpr},'accountId',${accountExpr},'transactionId',${txExpr},'scheduleId',${spec.table === 'Bill' ? 'NEW.scheduleId' : 'NULL'},'data',${data}),
          COALESCE(${parentExpr},${accountExpr},${txExpr}),'pending',NEW.createdAt,NEW.createdAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
      END;
      ${spec.mutable ? `CREATE TRIGGER CloudSync_${spec.table}_outbox_update AFTER UPDATE ON "${spec.table}"
      WHEN NEW.synced=0 AND EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=NEW.ownerId AND syncEnabled=1)
      BEGIN
        INSERT INTO SyncOutbox(mutationId,ownerId,cloudUserId,entityType,entityId,operation,payloadVersion,payloadJson,dependencyEntityId,status,createdAt,updatedAt)
        SELECT 'domain:${spec.type}:'||NEW.id||':'||lower(hex(randomblob(16))),NEW.ownerId,c.cloudUserId,'${spec.type}',NEW.id,'domain.update',1,
          json_object('entityType','${spec.type}','id',NEW.id,'parentType',${parentTypeExpr},'parentId',${parentExpr},'accountId',${accountExpr},'transactionId',${txExpr},'scheduleId',${spec.table === 'Bill' ? 'NEW.scheduleId' : 'NULL'},'data',${data}${expectedRevision}),
          COALESCE(${parentExpr},${accountExpr},${txExpr}),'pending',NEW.updatedAt,NEW.updatedAt FROM CloudIdentity c WHERE c.ownerId=NEW.ownerId AND c.syncEnabled=1;
      END;` : ''}
      ${immutableGuard}
      CREATE TRIGGER CloudSync_${spec.table}_immutable_delete BEFORE DELETE ON "${spec.table}"
      WHEN EXISTS(SELECT 1 FROM CloudIdentity WHERE ownerId=OLD.ownerId AND syncEnabled=1)
      BEGIN SELECT RAISE(ABORT,'cloud-linked ${spec.type} history cannot be deleted'); END;
    `);
  }
  for (const table of ['BillPaymentCorrectionReplacement','DebtEventCorrectionReplacement']) {
    for (const suffix of ['insert','update','delete']) await database.execAsync(`DROP TRIGGER IF EXISTS CloudSync_${table}_local_only_${suffix}`);
  }
  await database.execAsync(`
    CREATE TRIGGER CloudSync_BillPaymentCorrectionReplacement_no_delete BEFORE DELETE ON BillPaymentCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM BillPaymentCorrection c JOIN CloudIdentity i ON i.ownerId=c.ownerId AND i.syncEnabled=1 WHERE c.id=OLD.correctionId)
    BEGIN SELECT RAISE(ABORT,'cloud-linked bill payment correction history cannot be deleted'); END;
    CREATE TRIGGER CloudSync_DebtEventCorrectionReplacement_no_delete BEFORE DELETE ON DebtEventCorrectionReplacement
    WHEN EXISTS(SELECT 1 FROM DebtEventCorrection c JOIN CloudIdentity i ON i.ownerId=c.ownerId AND i.syncEnabled=1 WHERE c.id=OLD.correctionId)
    BEGIN SELECT RAISE(ABORT,'cloud-linked debt correction history cannot be deleted'); END;
  `);
}

async function migrateLegacyColumns(database: MigrationDatabase): Promise<void> {
  const accountColumns = await columnsFor(database, 'Account');
  await addColumnIfMissing(database, 'Account', accountColumns, 'ownerId', 'TEXT');
  await addColumnIfMissing(database, 'Account', accountColumns, 'name', 'TEXT');
  await addColumnIfMissing(database, 'Account', accountColumns, 'type', "TEXT NOT NULL DEFAULT 'Bank'");
  await addColumnIfMissing(database, 'Account', accountColumns, 'balance', 'REAL');
  await addColumnIfMissing(database, 'Account', accountColumns, 'balanceMinor', 'INTEGER');
  await addColumnIfMissing(database, 'Account', accountColumns, 'currency', "TEXT NOT NULL DEFAULT 'PKR'");
  await addColumnIfMissing(database, 'Account', accountColumns, 'createdAt', 'TEXT');
  await addColumnIfMissing(database, 'Account', accountColumns, 'synced', 'INTEGER NOT NULL DEFAULT 0');

  const transactionColumns = await columnsFor(database, 'Transaction');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'ownerId', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'amount', 'REAL');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'amountMinor', 'INTEGER');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'type', "TEXT NOT NULL DEFAULT 'Expense'");
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'category', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'categoryId', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'classificationId', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'accountId', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'toAccountId', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'date', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'note', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'sourceName', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'paymentMethod', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'sourceAmountMinor', 'INTEGER');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'sourceCurrency', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'exchangeRate', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'referenceNumber', 'TEXT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'taxStatus', "TEXT NOT NULL DEFAULT 'unreviewed'");
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'taxYear', 'INTEGER');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'synced', 'INTEGER NOT NULL DEFAULT 0');

  if (transactionColumns.has('category')) {
    await database.execAsync('UPDATE "Transaction" SET categoryId = category WHERE categoryId IS NULL');
  }
  await database.execAsync("UPDATE Account SET createdAt = datetime('now') WHERE createdAt IS NULL OR createdAt = ''");
  await database.execAsync("UPDATE \"Transaction\" SET date = datetime('now') WHERE date IS NULL OR date = ''");
  await database.execAsync("UPDATE \"Transaction\" SET taxStatus = 'unreviewed' WHERE taxStatus IS NULL OR taxStatus = ''");
}

async function migrateMoneyToMinorUnits(database: MigrationDatabase): Promise<void> {
  const accounts = await database.getAllAsync<AccountNumericRow>(
    'SELECT id, balance, balanceMinor FROM Account ORDER BY id',
  );
  for (const account of accounts) {
    if (account.balanceMinor === null || account.balanceMinor === undefined) {
      if (account.balance === null) {
        await database.runAsync('UPDATE Account SET balanceMinor = 0 WHERE id = ?', [account.id]);
      } else {
        const minor = validateMinorAmount(account.balance, account.id, 'Account', true);
        await database.runAsync('UPDATE Account SET balanceMinor = ? WHERE id = ?', [minor, account.id]);
      }
    } else if (!Number.isSafeInteger(account.balanceMinor)) {
      throw new Error(`Account ${account.id} has an unsafe opening balance; migration was rolled back.`);
    }
  }

  const transactions = await database.getAllAsync<NumericRow>(
    'SELECT id, amount, amountMinor FROM "Transaction" ORDER BY id',
  );
  for (const transaction of transactions) {
    if (transaction.amountMinor === null || transaction.amountMinor === undefined) {
      const minor = validateMinorAmount(transaction.amount, transaction.id, 'Transaction', false);
      await database.runAsync('UPDATE "Transaction" SET amountMinor = ? WHERE id = ?', [minor, transaction.id]);
    } else if (!Number.isSafeInteger(transaction.amountMinor) || transaction.amountMinor <= 0) {
      throw new Error(`Transaction ${transaction.id} has an unsafe amount; migration was rolled back.`);
    }
  }
}

async function migrateClassifications(database: MigrationDatabase): Promise<void> {
  const rows = await database.getAllAsync<{ id: string; categoryId: string | null; classificationId: string | null }>(
    'SELECT id, categoryId, classificationId FROM "Transaction" WHERE classificationId IS NULL',
  );
  for (const row of rows) {
    if (!row.categoryId) continue;
    const classification = resolveClassification(row.categoryId);
    if (classification) {
      await database.runAsync('UPDATE "Transaction" SET classificationId = ? WHERE id = ?', [classification, row.id]);
    }
  }
}

/** Phase 1B.1 additive migration: account lifecycle and linked financial events. */
async function migrateFinancialCoreV2(database: MigrationDatabase): Promise<void> {
  const accountColumns = await columnsFor(database, 'Account');
  await addColumnIfMissing(database, 'Account', accountColumns, 'archivedAt', 'TEXT');
  const transactionColumns = await columnsFor(database, 'Transaction');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'reversalOfId', 'TEXT REFERENCES "Transaction"(id) ON DELETE RESTRICT');
  await addColumnIfMissing(database, 'Transaction', transactionColumns, 'correctionOfId', 'TEXT REFERENCES "Transaction"(id) ON DELETE RESTRICT');

  // Older local schemas predate foreign keys. These triggers add equivalent checks without
  // rebuilding legacy tables or dropping any data. New records must point to same-profile accounts.
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS Transaction_owner_date_id_idx ON "Transaction"(ownerId, date DESC, id DESC);
    CREATE INDEX IF NOT EXISTS Transaction_reversal_idx ON "Transaction"(ownerId, reversalOfId);
    CREATE INDEX IF NOT EXISTS Account_owner_active_idx ON Account(ownerId, archivedAt, createdAt);
    CREATE TRIGGER IF NOT EXISTS Transaction_account_insert_guard
    BEFORE INSERT ON "Transaction"
    WHEN NEW.accountId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM Account a WHERE a.id = NEW.accountId AND a.ownerId = NEW.ownerId
    )
    BEGIN SELECT RAISE(ABORT, 'transaction account is unavailable to this profile'); END;
    CREATE TRIGGER IF NOT EXISTS Transaction_destination_insert_guard
    BEFORE INSERT ON "Transaction"
    WHEN NEW.toAccountId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM Account a WHERE a.id = NEW.toAccountId AND a.ownerId = NEW.ownerId
    )
    BEGIN SELECT RAISE(ABORT, 'transaction destination is unavailable to this profile'); END;
    CREATE TRIGGER IF NOT EXISTS Account_owner_insert_guard
    BEFORE INSERT ON Account
    WHEN NEW.ownerId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM User u WHERE u.id = NEW.ownerId)
    BEGIN SELECT RAISE(ABORT, 'account owner does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS Account_owner_update_guard
    BEFORE UPDATE OF ownerId ON Account
    WHEN NEW.ownerId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM User u WHERE u.id = NEW.ownerId)
    BEGIN SELECT RAISE(ABORT, 'account owner does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS Account_delete_history_guard
    BEFORE DELETE ON Account
    WHEN EXISTS (SELECT 1 FROM "Transaction" t WHERE t.accountId = OLD.id OR t.toAccountId = OLD.id)
    BEGIN SELECT RAISE(ABORT, 'account with financial history cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS Transaction_account_update_guard
    BEFORE UPDATE OF ownerId, accountId, toAccountId ON "Transaction"
    WHEN (NEW.accountId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM Account a WHERE a.id = NEW.accountId AND a.ownerId = NEW.ownerId
    )) OR (NEW.toAccountId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM Account a WHERE a.id = NEW.toAccountId AND a.ownerId = NEW.ownerId
    ))
    BEGIN SELECT RAISE(ABORT, 'transaction account is unavailable to this profile'); END;
  `);
}

/** Phase 2A additive budget, savings-ledger and emergency-fund schema. */
async function migrateBudgetingV3(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS Budget (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      categoryId TEXT NOT NULL CHECK (length(trim(categoryId)) > 0),
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      periodStart TEXT NOT NULL,
      periodEnd TEXT NOT NULL,
      rolloverPolicy TEXT NOT NULL CHECK (rolloverPolicy IN ('reset', 'carry_unused')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      supersedesId TEXT REFERENCES Budget(id) ON DELETE RESTRICT,
      supersededAt TEXT,
      archivedAt TEXT,
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId, categoryId, currency, periodStart, revision),
      CHECK (periodStart < periodEnd)
    );
    CREATE INDEX IF NOT EXISTS Budget_owner_period_idx ON Budget(ownerId, periodStart, periodEnd, currency);
    CREATE INDEX IF NOT EXISTS Budget_history_idx ON Budget(ownerId, categoryId, currency, periodStart, revision DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS Budget_current_unique_idx
      ON Budget(ownerId, categoryId, currency, periodStart)
      WHERE supersededAt IS NULL AND archivedAt IS NULL;

    CREATE TABLE IF NOT EXISTS SavingsGoal (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
      targetMinor INTEGER NOT NULL CHECK (targetMinor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      targetDate TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')),
      completedAt TEXT,
      archivedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS SavingsGoal_owner_status_idx ON SavingsGoal(ownerId, status, createdAt);

    CREATE TABLE IF NOT EXISTS SavingsGoalEvent (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      goalId TEXT NOT NULL REFERENCES SavingsGoal(id) ON DELETE RESTRICT,
      eventType TEXT NOT NULL CHECK (eventType IN ('planned', 'allocate', 'release', 'transfer_in', 'transfer_out')),
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      accountId TEXT REFERENCES Account(id) ON DELETE RESTRICT,
      transactionId TEXT UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      idempotencyKey TEXT NOT NULL,
      eventDate TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId, idempotencyKey),
      CHECK (
        (eventType = 'planned' AND accountId IS NULL AND transactionId IS NULL) OR
        (eventType IN ('allocate', 'release') AND accountId IS NOT NULL AND transactionId IS NULL) OR
        (eventType IN ('transfer_in', 'transfer_out') AND accountId IS NOT NULL AND transactionId IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS SavingsGoalEvent_owner_goal_date_idx ON SavingsGoalEvent(ownerId, goalId, eventDate, id);
    CREATE INDEX IF NOT EXISTS SavingsGoalEvent_owner_account_idx ON SavingsGoalEvent(ownerId, accountId, eventDate);

    CREATE TABLE IF NOT EXISTS EmergencyFundConfig (
      ownerId TEXT PRIMARY KEY NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      coverageMonths INTEGER NOT NULL CHECK (coverageMonths BETWEEN 1 AND 60),
      essentialMonthlyMinor INTEGER NOT NULL CHECK (essentialMonthlyMinor >= 0),
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS EmergencyFundEvent (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      eventType TEXT NOT NULL CHECK (eventType IN ('allocate', 'release', 'transfer_in', 'transfer_out')),
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      accountId TEXT NOT NULL REFERENCES Account(id) ON DELETE RESTRICT,
      transactionId TEXT UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      idempotencyKey TEXT NOT NULL,
      eventDate TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId, idempotencyKey),
      CHECK (
        (eventType IN ('allocate', 'release') AND transactionId IS NULL) OR
        (eventType IN ('transfer_in', 'transfer_out') AND transactionId IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS EmergencyFundEvent_owner_date_idx ON EmergencyFundEvent(ownerId, eventDate, id);
    CREATE INDEX IF NOT EXISTS EmergencyFundEvent_owner_account_idx ON EmergencyFundEvent(ownerId, accountId, eventDate);

    CREATE TRIGGER IF NOT EXISTS Budget_owner_insert_guard
    BEFORE INSERT ON Budget
    WHEN NOT EXISTS (SELECT 1 FROM User WHERE id = NEW.ownerId)
    BEGIN SELECT RAISE(ABORT, 'budget owner does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS Budget_history_update_guard
    BEFORE UPDATE ON Budget
    WHEN NEW.id != OLD.id OR NEW.ownerId != OLD.ownerId OR NEW.categoryId != OLD.categoryId OR
      NEW.amountMinor != OLD.amountMinor OR NEW.currency != OLD.currency OR NEW.periodStart != OLD.periodStart OR
      NEW.periodEnd != OLD.periodEnd OR NEW.rolloverPolicy != OLD.rolloverPolicy OR NEW.revision != OLD.revision OR
      NEW.supersedesId IS NOT OLD.supersedesId OR NEW.createdAt != OLD.createdAt OR
      (OLD.supersededAt IS NOT NULL AND NEW.supersededAt IS NOT OLD.supersededAt) OR
      (OLD.archivedAt IS NOT NULL AND NEW.archivedAt IS NOT OLD.archivedAt)
    BEGIN SELECT RAISE(ABORT, 'budget revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS SavingsGoal_owner_insert_guard
    BEFORE INSERT ON SavingsGoal
    WHEN NOT EXISTS (SELECT 1 FROM User WHERE id = NEW.ownerId)
    BEGIN SELECT RAISE(ABORT, 'savings goal owner does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS SavingsGoalEvent_insert_guard
    BEFORE INSERT ON SavingsGoalEvent
    WHEN NOT EXISTS (
      SELECT 1 FROM SavingsGoal g WHERE g.id = NEW.goalId AND g.ownerId = NEW.ownerId AND g.currency = NEW.currency
    ) OR (NEW.accountId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM Account a WHERE a.id = NEW.accountId AND a.ownerId = NEW.ownerId AND a.currency = NEW.currency
    )) OR (NEW.transactionId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Transaction" t WHERE t.id = NEW.transactionId AND t.ownerId = NEW.ownerId AND
        t.type = 'Transfer' AND t.amountMinor = NEW.amountMinor AND
        ((NEW.eventType = 'transfer_in' AND t.toAccountId = NEW.accountId) OR
         (NEW.eventType = 'transfer_out' AND t.accountId = NEW.accountId))
    ))
    BEGIN SELECT RAISE(ABORT, 'savings event owner, currency, account or transfer does not match'); END;
    CREATE TRIGGER IF NOT EXISTS SavingsGoalEvent_append_only_update
    BEFORE UPDATE ON SavingsGoalEvent
    BEGIN SELECT RAISE(ABORT, 'savings goal history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS SavingsGoalEvent_append_only_delete
    BEFORE DELETE ON SavingsGoalEvent
    BEGIN SELECT RAISE(ABORT, 'savings goal history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS EmergencyFundConfig_owner_insert_guard
    BEFORE INSERT ON EmergencyFundConfig
    WHEN NOT EXISTS (SELECT 1 FROM User WHERE id = NEW.ownerId)
    BEGIN SELECT RAISE(ABORT, 'emergency fund owner does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS EmergencyFundEvent_insert_guard
    BEFORE INSERT ON EmergencyFundEvent
    WHEN NOT EXISTS (
      SELECT 1 FROM EmergencyFundConfig c WHERE c.ownerId = NEW.ownerId AND c.currency = NEW.currency
    ) OR NOT EXISTS (
      SELECT 1 FROM Account a WHERE a.id = NEW.accountId AND a.ownerId = NEW.ownerId AND a.currency = NEW.currency
    ) OR (NEW.transactionId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Transaction" t WHERE t.id = NEW.transactionId AND t.ownerId = NEW.ownerId AND
        t.type = 'Transfer' AND t.amountMinor = NEW.amountMinor AND
        ((NEW.eventType = 'transfer_in' AND t.toAccountId = NEW.accountId) OR
         (NEW.eventType = 'transfer_out' AND t.accountId = NEW.accountId))
    ))
    BEGIN SELECT RAISE(ABORT, 'emergency fund event owner, currency, account or transfer does not match'); END;
    CREATE TRIGGER IF NOT EXISTS EmergencyFundEvent_append_only_update
    BEFORE UPDATE ON EmergencyFundEvent
    BEGIN SELECT RAISE(ABORT, 'emergency fund history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS EmergencyFundEvent_append_only_delete
    BEFORE DELETE ON EmergencyFundEvent
    BEGIN SELECT RAISE(ABORT, 'emergency fund history is append-only'); END;
  `);
}

/** Phase 2B schedules, obligations and debt history. Monetary values stay integer minor units. */
async function migrateRecurringFinanceV4(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS RecurringSchedule (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      scheduleType TEXT NOT NULL CHECK (scheduleType IN ('income','expense','transfer','bill')),
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      classificationId TEXT,
      accountId TEXT NOT NULL REFERENCES Account(id) ON DELETE RESTRICT,
      toAccountId TEXT REFERENCES Account(id) ON DELETE RESTRICT,
      billId TEXT REFERENCES Bill(id) ON DELETE RESTRICT,
      frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','yearly')),
      startDate TEXT NOT NULL,
      endDate TEXT,
      nextDueDate TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','paused','cancelled')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      CHECK (endDate IS NULL OR startDate <= endDate),
      CHECK ((scheduleType = 'transfer' AND toAccountId IS NOT NULL AND toAccountId != accountId) OR (scheduleType != 'transfer' AND toAccountId IS NULL)),
      CHECK ((scheduleType = 'bill' AND billId IS NOT NULL) OR (scheduleType != 'bill' AND billId IS NULL))
    );
    CREATE INDEX IF NOT EXISTS RecurringSchedule_due_idx ON RecurringSchedule(ownerId,status,nextDueDate);
    CREATE TABLE IF NOT EXISTS ScheduleOccurrence (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      scheduleId TEXT NOT NULL REFERENCES RecurringSchedule(id) ON DELETE RESTRICT,
      occurrenceDate TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','posted','skipped')),
      transactionId TEXT UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      createdAt TEXT NOT NULL,
      resolvedAt TEXT,
      UNIQUE(scheduleId, occurrenceDate),
      CHECK ((status = 'posted' AND transactionId IS NOT NULL AND resolvedAt IS NOT NULL) OR
        (status != 'posted' AND transactionId IS NULL))
    );
    CREATE INDEX IF NOT EXISTS ScheduleOccurrence_owner_status_date_idx ON ScheduleOccurrence(ownerId,status,occurrenceDate,id);
    CREATE TABLE IF NOT EXISTS Bill (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
      categoryId TEXT NOT NULL CHECK (length(trim(categoryId)) > 0),
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      dueDate TEXT NOT NULL,
      accountId TEXT NOT NULL REFERENCES Account(id) ON DELETE RESTRICT,
      scheduleId TEXT REFERENCES RecurringSchedule(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('upcoming','due','overdue','paid','partial','cancelled','skipped')),
      reminderId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS Bill_owner_due_status_idx ON Bill(ownerId,status,dueDate,id);
    CREATE INDEX IF NOT EXISTS Bill_schedule_idx ON Bill(ownerId,scheduleId,dueDate);
    CREATE TABLE IF NOT EXISTS BillPayment (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      billId TEXT NOT NULL REFERENCES Bill(id) ON DELETE RESTRICT,
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      transactionId TEXT NOT NULL UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      paidAt TEXT NOT NULL,
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,idempotencyKey)
    );
    CREATE INDEX IF NOT EXISTS BillPayment_owner_bill_date_idx ON BillPayment(ownerId,billId,paidAt,id);
    CREATE TABLE IF NOT EXISTS Debt (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL CHECK (direction IN ('borrowed','lent')),
      counterparty TEXT NOT NULL CHECK (length(trim(counterparty)) BETWEEN 1 AND 120),
      principalMinor INTEGER NOT NULL CHECK (principalMinor > 0),
      currency TEXT NOT NULL CHECK (length(currency) = 3),
      accountId TEXT NOT NULL REFERENCES Account(id) ON DELETE RESTRICT,
      interestRateBps INTEGER NOT NULL DEFAULT 0 CHECK (interestRateBps BETWEEN 0 AND 100000),
      openedAt TEXT NOT NULL,
      dueDate TEXT,
      status TEXT NOT NULL CHECK (status IN ('open','settled','cancelled')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS Debt_owner_status_idx ON Debt(ownerId,status,dueDate,id);
    CREATE TABLE IF NOT EXISTS DebtEvent (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      debtId TEXT NOT NULL REFERENCES Debt(id) ON DELETE RESTRICT,
      eventType TEXT NOT NULL CHECK (eventType IN ('borrow','lend','principal_repayment','receivable_payment','interest','settlement')),
      principalMinor INTEGER NOT NULL DEFAULT 0 CHECK (principalMinor >= 0),
      interestMinor INTEGER NOT NULL DEFAULT 0 CHECK (interestMinor >= 0),
      accountId TEXT NOT NULL REFERENCES Account(id) ON DELETE RESTRICT,
      transactionId TEXT NOT NULL UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      eventDate TEXT NOT NULL,
      idempotencyKey TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,idempotencyKey),
      CHECK (principalMinor + interestMinor > 0 AND (principalMinor = 0 OR interestMinor = 0))
    );
    CREATE INDEX IF NOT EXISTS DebtEvent_owner_debt_date_idx ON DebtEvent(ownerId,debtId,eventDate,id);
    CREATE TRIGGER IF NOT EXISTS RecurringSchedule_profile_guard
    BEFORE INSERT ON RecurringSchedule
    WHEN NOT EXISTS (SELECT 1 FROM Account WHERE id=NEW.accountId AND ownerId=NEW.ownerId AND currency=NEW.currency AND archivedAt IS NULL)
      OR (NEW.toAccountId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Account WHERE id=NEW.toAccountId AND ownerId=NEW.ownerId AND currency=NEW.currency AND archivedAt IS NULL))
    BEGIN SELECT RAISE(ABORT,'schedule account profile or currency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS RecurringSchedule_profile_update_guard
    BEFORE UPDATE OF ownerId,accountId,toAccountId,currency ON RecurringSchedule
    WHEN NOT EXISTS (SELECT 1 FROM Account WHERE id=NEW.accountId AND ownerId=NEW.ownerId AND currency=NEW.currency AND archivedAt IS NULL)
      OR (NEW.toAccountId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Account WHERE id=NEW.toAccountId AND ownerId=NEW.ownerId AND currency=NEW.currency AND archivedAt IS NULL))
    BEGIN SELECT RAISE(ABORT,'schedule account profile or currency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS ScheduleOccurrence_profile_guard
    BEFORE INSERT ON ScheduleOccurrence
    WHEN NOT EXISTS (SELECT 1 FROM RecurringSchedule WHERE id=NEW.scheduleId AND ownerId=NEW.ownerId)
    BEGIN SELECT RAISE(ABORT,'schedule occurrence profile mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS ScheduleOccurrence_history_update_guard
    BEFORE UPDATE ON ScheduleOccurrence
    WHEN OLD.status != 'pending' OR NEW.id != OLD.id OR NEW.ownerId != OLD.ownerId OR NEW.scheduleId != OLD.scheduleId OR NEW.occurrenceDate != OLD.occurrenceDate OR NEW.createdAt != OLD.createdAt OR
      (NEW.status='posted' AND NEW.transactionId IS NULL) OR NEW.status NOT IN ('posted','skipped')
    BEGIN SELECT RAISE(ABORT,'invalid or immutable schedule occurrence update'); END;
    CREATE TRIGGER IF NOT EXISTS Bill_profile_guard
    BEFORE INSERT ON Bill
    WHEN NOT EXISTS (SELECT 1 FROM Account WHERE id=NEW.accountId AND ownerId=NEW.ownerId AND currency=NEW.currency AND archivedAt IS NULL)
    BEGIN SELECT RAISE(ABORT,'bill account profile or currency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS BillPayment_profile_guard
    BEFORE INSERT ON BillPayment
    WHEN NOT EXISTS (SELECT 1 FROM Bill b JOIN "Transaction" t ON t.id=NEW.transactionId
      WHERE b.id=NEW.billId AND b.ownerId=NEW.ownerId AND b.status NOT IN ('cancelled','skipped') AND t.ownerId=NEW.ownerId AND t.type='Expense' AND t.amountMinor=NEW.amountMinor AND t.accountId=b.accountId AND t.categoryId=b.categoryId)
    BEGIN SELECT RAISE(ABORT,'bill payment transaction mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS BillPayment_obligation_limit_guard
    BEFORE INSERT ON BillPayment
    WHEN NOT EXISTS (SELECT 1 FROM Bill b WHERE b.id=NEW.billId AND b.ownerId=NEW.ownerId AND
      NEW.amountMinor + COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=b.id AND p.ownerId=b.ownerId),0) <= b.amountMinor)
    BEGIN SELECT RAISE(ABORT,'bill payments exceed the obligation'); END;
    CREATE TRIGGER IF NOT EXISTS BillPayment_append_only_update BEFORE UPDATE ON BillPayment BEGIN SELECT RAISE(ABORT,'bill payment history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS BillPayment_append_only_delete BEFORE DELETE ON BillPayment BEGIN SELECT RAISE(ABORT,'bill payment history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS Debt_profile_guard
    BEFORE INSERT ON Debt
    WHEN NOT EXISTS (SELECT 1 FROM Account WHERE id=NEW.accountId AND ownerId=NEW.ownerId AND currency=NEW.currency AND archivedAt IS NULL)
    BEGIN SELECT RAISE(ABORT,'debt account profile or currency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEvent_profile_guard
    BEFORE INSERT ON DebtEvent
    WHEN NOT EXISTS (SELECT 1 FROM Debt d JOIN Account a ON a.id=NEW.accountId JOIN "Transaction" t ON t.id=NEW.transactionId
      WHERE d.id=NEW.debtId AND d.ownerId=NEW.ownerId AND a.ownerId=NEW.ownerId AND a.currency=d.currency AND
      t.ownerId=NEW.ownerId AND t.accountId=NEW.accountId AND t.amountMinor=NEW.principalMinor+NEW.interestMinor AND
      ((NEW.eventType IN ('borrow','receivable_payment') AND t.type='Income') OR
       (NEW.eventType IN ('lend','principal_repayment','interest') AND t.type='Expense') OR
       (NEW.eventType='settlement' AND ((d.direction='borrowed' AND t.type='Expense') OR (d.direction='lent' AND t.type='Income')))) AND
      t.categoryId=CASE NEW.eventType WHEN 'borrow' THEN 'debt_borrowing' WHEN 'lend' THEN 'debt_lending' WHEN 'principal_repayment' THEN 'debt_principal_repayment' WHEN 'receivable_payment' THEN 'debt_receivable_payment' WHEN 'interest' THEN 'debt_interest' ELSE 'debt_settlement' END)
    BEGIN SELECT RAISE(ABORT,'debt event profile or currency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEvent_semantics_guard
    BEFORE INSERT ON DebtEvent
    WHEN NOT EXISTS (SELECT 1 FROM Debt d WHERE d.id=NEW.debtId AND d.ownerId=NEW.ownerId AND d.status='open' AND
      ((d.direction='borrowed' AND NEW.eventType IN ('borrow','principal_repayment','interest','settlement')) OR
       (d.direction='lent' AND NEW.eventType IN ('lend','receivable_payment','interest','settlement'))) AND
      (NEW.eventType NOT IN ('principal_repayment','receivable_payment','settlement') OR NEW.principalMinor <= d.principalMinor - COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND ((d.direction='borrowed' AND e.eventType='principal_repayment') OR (d.direction='lent' AND e.eventType='receivable_payment') OR e.eventType='settlement')),0)))
    BEGIN SELECT RAISE(ABORT,'debt event direction or principal limit is invalid'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEvent_append_only_update BEFORE UPDATE ON DebtEvent BEGIN SELECT RAISE(ABORT,'debt history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEvent_append_only_delete BEFORE DELETE ON DebtEvent BEGIN SELECT RAISE(ABORT,'debt history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS Transaction_obligation_adjustment_guard
    BEFORE INSERT ON "Transaction"
    WHEN NEW.type IN ('Refund','Reversal') AND EXISTS (
      SELECT 1 FROM BillPayment p WHERE p.ownerId=NEW.ownerId AND p.transactionId=NEW.reversalOfId
      UNION ALL
      SELECT 1 FROM DebtEvent e WHERE e.ownerId=NEW.ownerId AND e.transactionId=NEW.reversalOfId
    )
    BEGIN SELECT RAISE(ABORT,'obligation-linked transactions require an obligation-specific correction'); END;
  `);
}

/** Phase 2C adds append-only obligation corrections and projected debt installments. */
async function migrateObligationAccountingV5(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS DebtInterestEvent (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      debtId TEXT NOT NULL REFERENCES Debt(id) ON DELETE RESTRICT,
      eventType TEXT NOT NULL CHECK (eventType IN ('charge','reversal')),
      amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
      reversalOfEventId TEXT UNIQUE REFERENCES DebtInterestEvent(id) ON DELETE RESTRICT,
      eventDate TEXT NOT NULL,
      idempotencyKey TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,idempotencyKey),
      CHECK ((eventType='charge' AND reversalOfEventId IS NULL) OR (eventType='reversal' AND reversalOfEventId IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS DebtInterestEvent_owner_debt_date_idx ON DebtInterestEvent(ownerId,debtId,eventDate,id);
    CREATE TRIGGER IF NOT EXISTS DebtInterestEvent_profile_guard
    BEFORE INSERT ON DebtInterestEvent
    WHEN NOT EXISTS (SELECT 1 FROM Debt d WHERE d.id=NEW.debtId AND d.ownerId=NEW.ownerId)
      OR (NEW.eventType='reversal' AND NOT EXISTS (SELECT 1 FROM DebtInterestEvent e WHERE e.id=NEW.reversalOfEventId AND e.debtId=NEW.debtId AND e.ownerId=NEW.ownerId AND e.eventType='charge' AND e.amountMinor=NEW.amountMinor AND NOT EXISTS(SELECT 1 FROM DebtInterestEvent r WHERE r.reversalOfEventId=e.id)))
    BEGIN SELECT RAISE(ABORT,'debt interest event profile or reversal mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS DebtInterestEvent_append_only_update BEFORE UPDATE ON DebtInterestEvent BEGIN SELECT RAISE(ABORT,'debt interest history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS DebtInterestEvent_append_only_delete BEFORE DELETE ON DebtInterestEvent BEGIN SELECT RAISE(ABORT,'debt interest history is append-only'); END;
    CREATE TABLE IF NOT EXISTS BillPaymentCorrection (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      billId TEXT NOT NULL REFERENCES Bill(id) ON DELETE RESTRICT,
      originalPaymentId TEXT NOT NULL UNIQUE REFERENCES BillPayment(id) ON DELETE RESTRICT,
      reversalTransactionId TEXT NOT NULL UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      replacementPaymentId TEXT UNIQUE REFERENCES BillPayment(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      createdAt TEXT NOT NULL,
      CHECK (replacementPaymentId IS NULL OR replacementPaymentId != originalPaymentId)
    );
    CREATE INDEX IF NOT EXISTS BillPaymentCorrection_owner_bill_idx ON BillPaymentCorrection(ownerId,billId,createdAt,id);
    CREATE TABLE IF NOT EXISTS BillPaymentCorrectionReplacement (
      correctionId TEXT PRIMARY KEY NOT NULL REFERENCES BillPaymentCorrection(id) ON DELETE RESTRICT,
      replacementPaymentId TEXT NOT NULL UNIQUE REFERENCES BillPayment(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS DebtEventCorrection (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      debtId TEXT NOT NULL REFERENCES Debt(id) ON DELETE RESTRICT,
      originalEventId TEXT NOT NULL UNIQUE REFERENCES DebtEvent(id) ON DELETE RESTRICT,
      reversalTransactionId TEXT NOT NULL UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      replacementEventId TEXT UNIQUE REFERENCES DebtEvent(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      createdAt TEXT NOT NULL,
      CHECK (replacementEventId IS NULL OR replacementEventId != originalEventId)
    );
    CREATE INDEX IF NOT EXISTS DebtEventCorrection_owner_debt_idx ON DebtEventCorrection(ownerId,debtId,createdAt,id);
    CREATE TABLE IF NOT EXISTS DebtEventCorrectionReplacement (
      correctionId TEXT PRIMARY KEY NOT NULL REFERENCES DebtEventCorrection(id) ON DELETE RESTRICT,
      replacementEventId TEXT NOT NULL UNIQUE REFERENCES DebtEvent(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS DebtRepaymentSchedule (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      debtId TEXT NOT NULL REFERENCES Debt(id) ON DELETE RESTRICT,
      frequency TEXT NOT NULL CHECK (frequency IN ('monthly','yearly')),
      firstDueDate TEXT NOT NULL,
      installmentAmountMinor INTEGER NOT NULL CHECK (installmentAmountMinor > 0),
      interestMethod TEXT NOT NULL CHECK (interestMethod IN ('none','fixed','declining')),
      rateBps INTEGER NOT NULL CHECK (rateBps BETWEEN 0 AND 100000),
      installmentCount INTEGER NOT NULL CHECK (installmentCount BETWEEN 1 AND 600),
      status TEXT NOT NULL CHECK (status IN ('active','cancelled','completed')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      CHECK ((interestMethod='none' AND rateBps=0) OR interestMethod!='none'),
      UNIQUE(ownerId,debtId,id)
    );
    CREATE INDEX IF NOT EXISTS DebtRepaymentSchedule_owner_debt_status_idx ON DebtRepaymentSchedule(ownerId,debtId,status);
    CREATE TRIGGER IF NOT EXISTS BillPaymentCorrection_profile_guard
    BEFORE INSERT ON BillPaymentCorrection
    WHEN NOT EXISTS (
      SELECT 1 FROM BillPayment p JOIN Bill b ON b.id=p.billId JOIN "Transaction" original ON original.id=p.transactionId
      JOIN "Transaction" reversal ON reversal.id=NEW.reversalTransactionId
      WHERE p.id=NEW.originalPaymentId AND p.billId=NEW.billId AND p.ownerId=NEW.ownerId AND b.ownerId=NEW.ownerId
      AND reversal.ownerId=NEW.ownerId AND reversal.type='Reversal' AND reversal.reversalOfId=original.id
      AND reversal.amountMinor=original.amountMinor AND reversal.accountId=original.accountId
    )
    BEGIN SELECT RAISE(ABORT,'bill payment correction reversal mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS BillPaymentCorrection_replacement_guard
    BEFORE INSERT ON BillPaymentCorrection
    WHEN NEW.replacementPaymentId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM BillPayment p WHERE p.id=NEW.replacementPaymentId AND p.ownerId=NEW.ownerId AND p.billId=NEW.billId
    )
    BEGIN SELECT RAISE(ABORT,'bill payment correction replacement mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS BillPaymentCorrection_append_only_update BEFORE UPDATE ON BillPaymentCorrection BEGIN SELECT RAISE(ABORT,'bill payment corrections are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS BillPaymentCorrection_append_only_delete BEFORE DELETE ON BillPaymentCorrection BEGIN SELECT RAISE(ABORT,'bill payment corrections are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS BillPaymentCorrectionReplacement_profile_guard
    BEFORE INSERT ON BillPaymentCorrectionReplacement
    WHEN NOT EXISTS (SELECT 1 FROM BillPaymentCorrection c JOIN BillPayment p ON p.id=NEW.replacementPaymentId WHERE c.id=NEW.correctionId AND c.ownerId=p.ownerId AND c.billId=p.billId)
    BEGIN SELECT RAISE(ABORT,'bill payment replacement profile mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS BillPaymentCorrectionReplacement_append_only_update BEFORE UPDATE ON BillPaymentCorrectionReplacement BEGIN SELECT RAISE(ABORT,'bill payment replacements are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS BillPaymentCorrectionReplacement_append_only_delete BEFORE DELETE ON BillPaymentCorrectionReplacement BEGIN SELECT RAISE(ABORT,'bill payment replacements are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEventCorrection_profile_guard
    BEFORE INSERT ON DebtEventCorrection
    WHEN NOT EXISTS (
      SELECT 1 FROM DebtEvent e JOIN Debt d ON d.id=e.debtId JOIN "Transaction" original ON original.id=e.transactionId
      JOIN "Transaction" reversal ON reversal.id=NEW.reversalTransactionId
      WHERE e.id=NEW.originalEventId AND e.debtId=NEW.debtId AND e.ownerId=NEW.ownerId AND d.ownerId=NEW.ownerId
      AND reversal.ownerId=NEW.ownerId AND reversal.type='Reversal' AND reversal.reversalOfId=original.id
      AND reversal.amountMinor=original.amountMinor AND reversal.accountId=original.accountId
    )
    BEGIN SELECT RAISE(ABORT,'debt event correction reversal mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEventCorrection_replacement_guard
    BEFORE INSERT ON DebtEventCorrection
    WHEN NEW.replacementEventId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM DebtEvent e WHERE e.id=NEW.replacementEventId AND e.ownerId=NEW.ownerId AND e.debtId=NEW.debtId
    )
    BEGIN SELECT RAISE(ABORT,'debt event correction replacement mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEventCorrection_append_only_update BEFORE UPDATE ON DebtEventCorrection BEGIN SELECT RAISE(ABORT,'debt event corrections are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEventCorrection_append_only_delete BEFORE DELETE ON DebtEventCorrection BEGIN SELECT RAISE(ABORT,'debt event corrections are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEventCorrectionReplacement_profile_guard
    BEFORE INSERT ON DebtEventCorrectionReplacement
    WHEN NOT EXISTS (SELECT 1 FROM DebtEventCorrection c JOIN DebtEvent e ON e.id=NEW.replacementEventId WHERE c.id=NEW.correctionId AND c.ownerId=e.ownerId AND c.debtId=e.debtId)
    BEGIN SELECT RAISE(ABORT,'debt event replacement profile mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEventCorrectionReplacement_append_only_update BEFORE UPDATE ON DebtEventCorrectionReplacement BEGIN SELECT RAISE(ABORT,'debt event replacements are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS DebtEventCorrectionReplacement_append_only_delete BEFORE DELETE ON DebtEventCorrectionReplacement BEGIN SELECT RAISE(ABORT,'debt event replacements are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS DebtRepaymentSchedule_profile_guard
    BEFORE INSERT ON DebtRepaymentSchedule
    WHEN NOT EXISTS (SELECT 1 FROM Debt WHERE id=NEW.debtId AND ownerId=NEW.ownerId)
    BEGIN SELECT RAISE(ABORT,'repayment schedule debt profile mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS DebtRepaymentSchedule_history_update_guard
    BEFORE UPDATE ON DebtRepaymentSchedule
    WHEN OLD.status!='active' OR NEW.id!=OLD.id OR NEW.ownerId!=OLD.ownerId OR NEW.debtId!=OLD.debtId OR NEW.createdAt!=OLD.createdAt
    BEGIN SELECT RAISE(ABORT,'repayment schedule history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS DebtRepaymentSchedule_delete_guard BEFORE DELETE ON DebtRepaymentSchedule BEGIN SELECT RAISE(ABORT,'repayment schedule history is append-only'); END;
    DROP TRIGGER IF EXISTS Transaction_obligation_adjustment_guard;
    CREATE TRIGGER Transaction_obligation_adjustment_guard
    BEFORE INSERT ON "Transaction"
    WHEN NEW.type IN ('Refund','Reversal') AND EXISTS (
      SELECT 1 FROM BillPayment p WHERE p.ownerId=NEW.ownerId AND p.transactionId=NEW.reversalOfId
      UNION ALL SELECT 1 FROM DebtEvent e WHERE e.ownerId=NEW.ownerId AND e.transactionId=NEW.reversalOfId
    ) AND NOT EXISTS (
      SELECT 1 FROM BillPayment p JOIN Bill b ON b.id=p.billId WHERE p.ownerId=NEW.ownerId AND p.transactionId=NEW.reversalOfId AND NEW.type='Reversal'
      UNION ALL SELECT 1 FROM DebtEvent e WHERE e.ownerId=NEW.ownerId AND e.transactionId=NEW.reversalOfId AND NEW.type='Reversal'
    )
    BEGIN SELECT RAISE(ABORT,'obligation-linked entries require a full obligation correction'); END;
    DROP TRIGGER IF EXISTS BillPayment_obligation_limit_guard;
    CREATE TRIGGER BillPayment_obligation_limit_guard
    BEFORE INSERT ON BillPayment
    WHEN NOT EXISTS (SELECT 1 FROM Bill b WHERE b.id=NEW.billId AND b.ownerId=NEW.ownerId AND
      NEW.amountMinor + COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=b.id AND p.ownerId=b.ownerId
        AND NOT EXISTS (SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)),0) <= b.amountMinor)
    BEGIN SELECT RAISE(ABORT,'bill payments exceed the obligation'); END;
    DROP TRIGGER IF EXISTS BillPayment_profile_guard;
    CREATE TRIGGER BillPayment_profile_guard
    BEFORE INSERT ON BillPayment
    WHEN NOT EXISTS (SELECT 1 FROM Bill b JOIN "Transaction" t ON t.id=NEW.transactionId
      JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId AND a.archivedAt IS NULL AND a.currency=b.currency
      WHERE b.id=NEW.billId AND b.ownerId=NEW.ownerId AND b.status NOT IN ('cancelled','skipped')
      AND t.ownerId=NEW.ownerId AND t.type='Expense' AND t.amountMinor=NEW.amountMinor AND t.categoryId=b.categoryId)
    BEGIN SELECT RAISE(ABORT,'bill payment transaction profile or currency mismatch'); END;
    DROP TRIGGER IF EXISTS DebtEvent_semantics_guard;
    CREATE TRIGGER DebtEvent_semantics_guard
    BEFORE INSERT ON DebtEvent
    WHEN NOT EXISTS (SELECT 1 FROM Debt d WHERE d.id=NEW.debtId AND d.ownerId=NEW.ownerId AND d.status='open' AND
      ((d.direction='borrowed' AND NEW.eventType IN ('borrow','principal_repayment','interest','settlement')) OR
       (d.direction='lent' AND NEW.eventType IN ('lend','receivable_payment','interest','settlement'))) AND
      (NEW.eventType NOT IN ('principal_repayment','receivable_payment','settlement') OR NEW.principalMinor <= d.principalMinor - COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND ((d.direction='borrowed' AND e.eventType='principal_repayment') OR (d.direction='lent' AND e.eventType='receivable_payment') OR e.eventType='settlement') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0)))
    BEGIN SELECT RAISE(ABORT,'debt event direction or principal limit is invalid'); END;
  `);
}

/** Phase 3 append-only asset and investment records with profile/currency guards. */
async function migrateAssetsInvestmentsV6(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS Asset (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
      category TEXT NOT NULL CHECK(category IN ('property','vehicle','precious_metal','valuable','business_equity','other')),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      purchaseValueMinor INTEGER NOT NULL CHECK(purchaseValueMinor > 0),
      purchaseDate TEXT NOT NULL,
      ownershipBps INTEGER NOT NULL CHECK(ownershipBps BETWEEN 1 AND 10000),
      notes TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS Asset_owner_category_idx ON Asset(ownerId,category,id);
    CREATE TABLE IF NOT EXISTS AssetValuation (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      assetId TEXT NOT NULL REFERENCES Asset(id) ON DELETE RESTRICT,
      valueMinor INTEGER NOT NULL CHECK(valueMinor >= 0),
      valuationDate TEXT NOT NULL,
      source TEXT NOT NULL CHECK(length(trim(source)) BETWEEN 1 AND 120),
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,idempotencyKey)
    );
    CREATE INDEX IF NOT EXISTS AssetValuation_owner_asset_date_idx ON AssetValuation(ownerId,assetId,valuationDate DESC,id DESC);
    CREATE TABLE IF NOT EXISTS AssetActivity (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      assetId TEXT NOT NULL REFERENCES Asset(id) ON DELETE RESTRICT,
      eventType TEXT NOT NULL CHECK(eventType IN ('acquisition','disposal')),
      ownershipBps INTEGER NOT NULL CHECK(ownershipBps BETWEEN 1 AND 10000),
      costBasisMinor INTEGER NOT NULL CHECK(costBasisMinor >= 0),
      proceedsMinor INTEGER NOT NULL CHECK(proceedsMinor >= 0),
      accountId TEXT REFERENCES Account(id) ON DELETE RESTRICT,
      transactionId TEXT UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      eventDate TEXT NOT NULL,
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,idempotencyKey),
      CHECK((eventType='acquisition' AND ownershipBps>0 AND proceedsMinor=0) OR (eventType='disposal' AND ownershipBps>0)),
      CHECK(accountId IS NULL OR transactionId IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS AssetActivity_owner_asset_date_idx ON AssetActivity(ownerId,assetId,eventDate,id);
    CREATE TABLE IF NOT EXISTS InvestmentPortfolio (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      cashAccountId TEXT NOT NULL REFERENCES Account(id) ON DELETE RESTRICT,
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,name,currency)
    );
    CREATE INDEX IF NOT EXISTS InvestmentPortfolio_owner_idx ON InvestmentPortfolio(ownerId,currency,id);
    CREATE TABLE IF NOT EXISTS InvestmentHolding (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      portfolioId TEXT NOT NULL REFERENCES InvestmentPortfolio(id) ON DELETE RESTRICT,
      symbol TEXT NOT NULL CHECK(length(trim(symbol)) BETWEEN 1 AND 24),
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
      category TEXT NOT NULL CHECK(category IN ('stock','etf','mutual_fund','bond','sukuk','gold','crypto','other')),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,portfolioId,symbol)
    );
    CREATE INDEX IF NOT EXISTS InvestmentHolding_owner_portfolio_idx ON InvestmentHolding(ownerId,portfolioId,id);
    CREATE TABLE IF NOT EXISTS InvestmentEvent (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      holdingId TEXT NOT NULL REFERENCES InvestmentHolding(id) ON DELETE RESTRICT,
      eventType TEXT NOT NULL CHECK(eventType IN ('buy','sell','split','dividend')),
      quantityMicros INTEGER NOT NULL DEFAULT 0 CHECK(quantityMicros>=0),
      unitPriceMinor INTEGER NOT NULL DEFAULT 0 CHECK(unitPriceMinor>=0),
      feeMinor INTEGER NOT NULL DEFAULT 0 CHECK(feeMinor>=0),
      amountMinor INTEGER NOT NULL DEFAULT 0 CHECK(amountMinor>=0),
      splitNumerator INTEGER NOT NULL DEFAULT 0 CHECK(splitNumerator>=0),
      splitDenominator INTEGER NOT NULL DEFAULT 0 CHECK(splitDenominator>=0),
      transactionId TEXT UNIQUE REFERENCES "Transaction"(id) ON DELETE RESTRICT,
      eventDate TEXT NOT NULL,
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,idempotencyKey),
      CHECK((eventType IN ('buy','sell') AND quantityMicros>0 AND unitPriceMinor>0 AND splitNumerator=0 AND splitDenominator=0 AND transactionId IS NOT NULL) OR
        (eventType='split' AND quantityMicros=0 AND splitNumerator>0 AND splitDenominator>0 AND transactionId IS NULL) OR
        (eventType='dividend' AND amountMinor>0 AND quantityMicros=0 AND splitNumerator=0 AND splitDenominator=0 AND transactionId IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS InvestmentEvent_owner_holding_date_idx ON InvestmentEvent(ownerId,holdingId,eventDate,id);
    CREATE TABLE IF NOT EXISTS InvestmentPrice (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      holdingId TEXT NOT NULL REFERENCES InvestmentHolding(id) ON DELETE RESTRICT,
      unitPriceMinor INTEGER NOT NULL CHECK(unitPriceMinor>=0),
      priceDate TEXT NOT NULL,
      source TEXT NOT NULL CHECK(length(trim(source)) BETWEEN 1 AND 120),
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(ownerId,idempotencyKey)
    );
    CREATE INDEX IF NOT EXISTS InvestmentPrice_owner_holding_date_idx ON InvestmentPrice(ownerId,holdingId,priceDate DESC,id DESC);
    CREATE TRIGGER IF NOT EXISTS Asset_profile_guard BEFORE INSERT ON Asset
    WHEN NOT EXISTS(SELECT 1 FROM User WHERE id=NEW.ownerId)
    BEGIN SELECT RAISE(ABORT,'asset owner does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS Asset_purchase_immutable BEFORE UPDATE ON Asset
    WHEN NEW.ownerId!=OLD.ownerId OR NEW.currency!=OLD.currency OR NEW.purchaseValueMinor!=OLD.purchaseValueMinor OR NEW.purchaseDate!=OLD.purchaseDate OR NEW.ownershipBps!=OLD.ownershipBps OR NEW.id!=OLD.id OR NEW.createdAt!=OLD.createdAt
    BEGIN SELECT RAISE(ABORT,'asset purchase history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS AssetValuation_profile_guard BEFORE INSERT ON AssetValuation
    WHEN NOT EXISTS(SELECT 1 FROM Asset a WHERE a.id=NEW.assetId AND a.ownerId=NEW.ownerId)
    BEGIN SELECT RAISE(ABORT,'asset valuation profile mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS AssetValuation_append_only_update BEFORE UPDATE ON AssetValuation BEGIN SELECT RAISE(ABORT,'asset valuations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS AssetValuation_append_only_delete BEFORE DELETE ON AssetValuation BEGIN SELECT RAISE(ABORT,'asset valuations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS AssetActivity_profile_guard BEFORE INSERT ON AssetActivity
    WHEN NOT EXISTS(SELECT 1 FROM Asset a WHERE a.id=NEW.assetId AND a.ownerId=NEW.ownerId)
      OR NEW.eventDate < (SELECT a.purchaseDate FROM Asset a WHERE a.id=NEW.assetId AND a.ownerId=NEW.ownerId)
      OR (NEW.accountId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM Account a JOIN Asset x ON x.id=NEW.assetId WHERE a.id=NEW.accountId AND a.ownerId=NEW.ownerId AND a.currency=x.currency))
      OR (NEW.transactionId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Transaction" t JOIN Asset x ON x.id=NEW.assetId WHERE t.id=NEW.transactionId AND t.ownerId=NEW.ownerId AND t.accountId=NEW.accountId AND t.amountMinor=CASE WHEN NEW.eventType='acquisition' THEN NEW.costBasisMinor ELSE NEW.proceedsMinor END AND t.type=CASE WHEN NEW.eventType='acquisition' THEN 'Expense' ELSE 'Income' END AND t.categoryId=CASE WHEN NEW.eventType='acquisition' THEN 'asset_purchase' ELSE 'asset_sale_proceeds' END AND EXISTS(SELECT 1 FROM Account a WHERE a.id=t.accountId AND a.currency=x.currency)))
    BEGIN SELECT RAISE(ABORT,'asset activity profile, currency or cash entry mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS AssetActivity_disposal_limit_guard BEFORE INSERT ON AssetActivity
    WHEN (NEW.eventType='acquisition' AND EXISTS(SELECT 1 FROM AssetActivity a WHERE a.assetId=NEW.assetId AND a.ownerId=NEW.ownerId AND a.eventType='acquisition'))
      OR (NEW.eventType='disposal' AND NOT EXISTS(SELECT 1 FROM Asset a WHERE a.id=NEW.assetId AND a.ownerId=NEW.ownerId AND NEW.ownershipBps<=a.ownershipBps-COALESCE((SELECT SUM(x.ownershipBps) FROM AssetActivity x WHERE x.assetId=a.id AND x.ownerId=a.ownerId AND x.eventType='disposal'),0)))
    BEGIN SELECT RAISE(ABORT,'asset acquisition is duplicated or disposal exceeds ownership'); END;
    CREATE TRIGGER IF NOT EXISTS AssetActivity_append_only_update BEFORE UPDATE ON AssetActivity BEGIN SELECT RAISE(ABORT,'asset history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS AssetActivity_append_only_delete BEFORE DELETE ON AssetActivity BEGIN SELECT RAISE(ABORT,'asset history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS Portfolio_profile_guard BEFORE INSERT ON InvestmentPortfolio
    WHEN NOT EXISTS(SELECT 1 FROM Account a WHERE a.id=NEW.cashAccountId AND a.ownerId=NEW.ownerId AND a.currency=NEW.currency AND a.archivedAt IS NULL)
    BEGIN SELECT RAISE(ABORT,'portfolio cash account profile or currency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS Portfolio_update_guard BEFORE UPDATE ON InvestmentPortfolio
    WHEN NEW.ownerId!=OLD.ownerId OR NEW.currency!=OLD.currency OR NEW.cashAccountId!=OLD.cashAccountId OR NEW.id!=OLD.id OR NEW.createdAt!=OLD.createdAt
    BEGIN SELECT RAISE(ABORT,'portfolio funding account and currency are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS Holding_profile_guard BEFORE INSERT ON InvestmentHolding
    WHEN NOT EXISTS(SELECT 1 FROM InvestmentPortfolio p WHERE p.id=NEW.portfolioId AND p.ownerId=NEW.ownerId AND p.currency=NEW.currency)
    BEGIN SELECT RAISE(ABORT,'holding profile or currency mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS Holding_immutable BEFORE UPDATE ON InvestmentHolding
    WHEN NEW.ownerId!=OLD.ownerId OR NEW.portfolioId!=OLD.portfolioId OR NEW.currency!=OLD.currency OR NEW.id!=OLD.id OR NEW.createdAt!=OLD.createdAt
    BEGIN SELECT RAISE(ABORT,'holding identity and currency are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS InvestmentEvent_profile_guard BEFORE INSERT ON InvestmentEvent
    WHEN NOT EXISTS(SELECT 1 FROM InvestmentHolding h WHERE h.id=NEW.holdingId AND h.ownerId=NEW.ownerId)
      OR (NEW.transactionId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Transaction" t JOIN InvestmentHolding h ON h.id=NEW.holdingId JOIN InvestmentPortfolio p ON p.id=h.portfolioId WHERE t.id=NEW.transactionId AND t.ownerId=NEW.ownerId AND t.accountId=p.cashAccountId AND ((NEW.eventType='buy' AND t.type='Expense' AND t.categoryId='investment_purchase' AND t.amountMinor=NEW.amountMinor+NEW.feeMinor) OR (NEW.eventType='sell' AND t.type='Income' AND t.categoryId='investment_sale_proceeds' AND t.amountMinor=NEW.amountMinor-NEW.feeMinor) OR (NEW.eventType='dividend' AND t.type='Income' AND t.categoryId='investment_dividend' AND t.amountMinor=NEW.amountMinor))) )
    BEGIN SELECT RAISE(ABORT,'investment event cash entry mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS InvestmentEvent_append_only_update BEFORE UPDATE ON InvestmentEvent BEGIN SELECT RAISE(ABORT,'investment history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS InvestmentEvent_append_only_delete BEFORE DELETE ON InvestmentEvent BEGIN SELECT RAISE(ABORT,'investment history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS InvestmentPrice_profile_guard BEFORE INSERT ON InvestmentPrice
    WHEN NOT EXISTS(SELECT 1 FROM InvestmentHolding h WHERE h.id=NEW.holdingId AND h.ownerId=NEW.ownerId)
    BEGIN SELECT RAISE(ABORT,'investment price profile mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS InvestmentPrice_append_only_update BEFORE UPDATE ON InvestmentPrice BEGIN SELECT RAISE(ABORT,'investment prices are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS InvestmentPrice_append_only_delete BEFORE DELETE ON InvestmentPrice BEGIN SELECT RAISE(ABORT,'investment prices are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS Transaction_asset_investment_adjustment_guard
    BEFORE INSERT ON "Transaction"
    WHEN NEW.type IN ('Refund','Reversal') AND EXISTS(
      SELECT 1 FROM AssetActivity a WHERE a.ownerId=NEW.ownerId AND a.transactionId=NEW.reversalOfId
      UNION ALL SELECT 1 FROM InvestmentEvent e WHERE e.ownerId=NEW.ownerId AND e.transactionId=NEW.reversalOfId
    )
    BEGIN SELECT RAISE(ABORT,'asset and investment cash entries require asset-specific corrections'); END;
  `);
}

/**
 * Applies the one compatibility migration from the released legacy Prisma schema and the
 * intermediate unversioned local schema. DDL, backfills, validation and user_version commit
 * together so failure leaves SQLite able to roll back to the prior schema and data.
 */
export async function migrateLocalDatabase(database: MigrationDatabase): Promise<void> {
  const version = await database.getFirstAsync<VersionRow>('PRAGMA user_version');
  const currentVersion = version?.user_version ?? 0;
  if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error('Local database version is invalid.');
  if (currentVersion > LOCAL_DATABASE_VERSION) {
    throw new Error(`Local database version ${currentVersion} is newer than this app supports.`);
  }
  if (currentVersion === LOCAL_DATABASE_VERSION) return;

  await database.withTransactionAsync(async () => {
    await ensureBaseTables(database);
    const accountCountBefore = await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM Account');
    const transactionCountBefore = await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM "Transaction"');
    await migrateLegacyColumns(database);
    await migrateMoneyToMinorUnits(database);
    await migrateClassifications(database);
    if (currentVersion < 2) await migrateFinancialCoreV2(database);
    if (currentVersion < 3) await migrateBudgetingV3(database);
    if (currentVersion < 4) await migrateRecurringFinanceV4(database);
    if (currentVersion < 5) await migrateObligationAccountingV5(database);
    if (currentVersion < 6) await migrateAssetsInvestmentsV6(database);
    if (currentVersion < 7) await migrateOnboardingStateV7(database);
    if (currentVersion < 8) await migrateDatabaseHardeningV8(database);
    if (currentVersion < 9) await migrateCloudSyncV9(database);
    if (currentVersion < 10) await migrateCloudBudgetSyncV10(database);
    if (currentVersion < 11) await migrateCloudSavingsSyncV11(database);
    if (currentVersion < 12) await migrateRecurringScheduleSyncV12(database);
    if (currentVersion < 13) await migrateExtendedFinanceSyncV13(database);
    if (currentVersion < 14) await migrateAccountActivityIndexesV14(database);
    if (currentVersion < 15) await migrateOnboardingRequirementV15(database);
    if (currentVersion < 16) await migrateProjectsV16(database);
    if (currentVersion < 17) await migrateProjectsV17(database);
    // No server acknowledgement can be verified for the legacy sync flags.
    await database.execAsync('UPDATE Account SET synced = 0 WHERE synced != 0');
    await database.execAsync('UPDATE "Transaction" SET synced = 0 WHERE synced != 0');
    await database.execAsync('CREATE INDEX IF NOT EXISTS Account_owner_idx ON Account(ownerId)');
    await database.execAsync('CREATE INDEX IF NOT EXISTS Transaction_owner_date_idx ON "Transaction"(ownerId, date)');
    await database.execAsync('CREATE INDEX IF NOT EXISTS Transaction_classification_idx ON "Transaction"(ownerId, classificationId, date)');

    const integrity = await database.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') throw new Error('Local database integrity check failed; migration was rolled back.');
    const foreignKeyViolations = await database.getAllAsync<{ table: string; rowid: number | null; parent: string; fkid: number }>('PRAGMA foreign_key_check');
    if (foreignKeyViolations.length > 0) throw new Error('Local database foreign-key integrity check failed; migration was rolled back.');
    const accountCountAfter = await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM Account');
    const transactionCountAfter = await database.getFirstAsync<CountRow>('SELECT COUNT(*) AS count FROM "Transaction"');
    if (accountCountBefore?.count !== accountCountAfter?.count || transactionCountBefore?.count !== transactionCountAfter?.count) {
      throw new Error('Local database record counts changed during migration; migration was rolled back.');
    }
    await database.execAsync(`PRAGMA user_version = ${LOCAL_DATABASE_VERSION}`);
  });
}

/** Adds an offline project workspace without altering the existing personal ledger. */
async function migrateProjectsV16(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS Project (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
      description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
      kind TEXT NOT NULL CHECK(kind IN ('personal','shared','work','custom')),
      status TEXT NOT NULL CHECK(status IN ('planned','active','completed','archived')),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      startDate TEXT NOT NULL,
      endDate TEXT,
      budgetMinor INTEGER CHECK(budgetMinor IS NULL OR (typeof(budgetMinor)='integer' AND budgetMinor >= 0 AND budgetMinor <= 9007199254740991)),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      archivedAt TEXT,
      UNIQUE(id,ownerId),
      CHECK(endDate IS NULL OR endDate >= startDate),
      CHECK((status='archived') = (archivedAt IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS Project_owner_status_updated_idx ON Project(ownerId,status,updatedAt DESC,id);
    CREATE TABLE IF NOT EXISTS ProjectMember (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      displayName TEXT NOT NULL CHECK(length(trim(displayName)) BETWEEN 1 AND 100),
      role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      identityType TEXT NOT NULL CHECK(identityType IN ('local','registered')),
      cloudUserId TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','removed')),
      createdAt TEXT NOT NULL,
      FOREIGN KEY(projectId,ownerId) REFERENCES Project(id,ownerId) ON DELETE RESTRICT,
      UNIQUE(id,projectId,ownerId),
      CHECK((identityType='local' AND cloudUserId IS NULL) OR (identityType='registered' AND cloudUserId IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS ProjectMember_project_status_idx ON ProjectMember(ownerId,projectId,status,createdAt,id);
    CREATE TABLE IF NOT EXISTS ProjectExpense (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK(typeof(amountMinor)='integer' AND amountMinor > 0 AND amountMinor <= 9007199254740991),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      occurredAt TEXT NOT NULL,
      category TEXT NOT NULL CHECK(length(trim(category)) BETWEEN 1 AND 80),
      description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 200),
      note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000),
      payerMemberId TEXT NOT NULL,
      fundingSource TEXT NOT NULL CHECK(fundingSource IN ('member','group_fund')),
      splitMethod TEXT NOT NULL CHECK(splitMethod IN ('equal','percentage','fixed','weighted','individual')),
      recordedByMemberId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(projectId,ownerId) REFERENCES Project(id,ownerId) ON DELETE RESTRICT,
      FOREIGN KEY(payerMemberId,projectId,ownerId) REFERENCES ProjectMember(id,projectId,ownerId) ON DELETE RESTRICT,
      FOREIGN KEY(recordedByMemberId,projectId,ownerId) REFERENCES ProjectMember(id,projectId,ownerId) ON DELETE RESTRICT,
      UNIQUE(id,projectId,ownerId)
    );
    CREATE INDEX IF NOT EXISTS ProjectExpense_project_date_idx ON ProjectExpense(ownerId,projectId,occurredAt DESC,id);
    CREATE INDEX IF NOT EXISTS ProjectExpense_project_category_idx ON ProjectExpense(ownerId,projectId,category,occurredAt);
    CREATE TABLE IF NOT EXISTS ProjectExpenseShare (
      expenseId TEXT NOT NULL,
      ownerId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      memberId TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK(typeof(amountMinor)='integer' AND amountMinor >= 0 AND amountMinor <= 9007199254740991),
      PRIMARY KEY(expenseId,memberId),
      FOREIGN KEY(expenseId,projectId,ownerId) REFERENCES ProjectExpense(id,projectId,ownerId) ON DELETE RESTRICT,
      FOREIGN KEY(memberId,projectId,ownerId) REFERENCES ProjectMember(id,projectId,ownerId) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS ProjectExpenseShare_member_idx ON ProjectExpenseShare(ownerId,projectId,memberId,expenseId);
    CREATE TABLE IF NOT EXISTS ProjectExpenseRefund (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      expenseId TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK(typeof(amountMinor)='integer' AND amountMinor > 0 AND amountMinor <= 9007199254740991),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      occurredAt TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 1000),
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(projectId,ownerId) REFERENCES Project(id,ownerId) ON DELETE RESTRICT,
      FOREIGN KEY(expenseId,projectId,ownerId) REFERENCES ProjectExpense(id,projectId,ownerId) ON DELETE RESTRICT,
      UNIQUE(ownerId,idempotencyKey)
    );
    CREATE INDEX IF NOT EXISTS ProjectExpenseRefund_expense_idx ON ProjectExpenseRefund(ownerId,projectId,expenseId,occurredAt,id);
    CREATE TABLE IF NOT EXISTS ProjectCashEvent (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      memberId TEXT,
      eventType TEXT NOT NULL CHECK(eventType IN ('contribution','revenue','withdrawal')),
      amountMinor INTEGER NOT NULL CHECK(typeof(amountMinor)='integer' AND amountMinor > 0 AND amountMinor <= 9007199254740991),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      occurredAt TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 1000),
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(projectId,ownerId) REFERENCES Project(id,ownerId) ON DELETE RESTRICT,
      FOREIGN KEY(memberId,projectId,ownerId) REFERENCES ProjectMember(id,projectId,ownerId) ON DELETE RESTRICT,
      UNIQUE(ownerId,idempotencyKey)
    );
    CREATE INDEX IF NOT EXISTS ProjectCashEvent_project_date_idx ON ProjectCashEvent(ownerId,projectId,occurredAt,id);
    CREATE TABLE IF NOT EXISTS ProjectSettlement (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      fromMemberId TEXT NOT NULL,
      toMemberId TEXT NOT NULL,
      amountMinor INTEGER NOT NULL CHECK(typeof(amountMinor)='integer' AND amountMinor > 0 AND amountMinor <= 9007199254740991),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      occurredAt TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 1000),
      idempotencyKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(projectId,ownerId) REFERENCES Project(id,ownerId) ON DELETE RESTRICT,
      FOREIGN KEY(fromMemberId,projectId,ownerId) REFERENCES ProjectMember(id,projectId,ownerId) ON DELETE RESTRICT,
      FOREIGN KEY(toMemberId,projectId,ownerId) REFERENCES ProjectMember(id,projectId,ownerId) ON DELETE RESTRICT,
      UNIQUE(ownerId,idempotencyKey),
      CHECK(fromMemberId <> toMemberId)
    );
    CREATE INDEX IF NOT EXISTS ProjectSettlement_project_date_idx ON ProjectSettlement(ownerId,projectId,occurredAt,id);
    CREATE TABLE IF NOT EXISTS ProjectBudget (
      id TEXT PRIMARY KEY NOT NULL,
      ownerId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      category TEXT,
      amountMinor INTEGER NOT NULL CHECK(typeof(amountMinor)='integer' AND amountMinor >= 0 AND amountMinor <= 9007199254740991),
      currency TEXT NOT NULL CHECK(currency IN ('PKR','USD','GBP','EUR','AED','SAR')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY(projectId,ownerId) REFERENCES Project(id,ownerId) ON DELETE RESTRICT,
      UNIQUE(projectId,category)
    );
    CREATE INDEX IF NOT EXISTS ProjectBudget_owner_project_idx ON ProjectBudget(ownerId,projectId,category);
    CREATE TRIGGER IF NOT EXISTS ProjectExpense_append_only_update
      BEFORE UPDATE ON ProjectExpense BEGIN SELECT RAISE(ABORT,'project expense history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectExpense_append_only_delete
      BEFORE DELETE ON ProjectExpense BEGIN SELECT RAISE(ABORT,'project expense history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectExpenseShare_append_only_update
      BEFORE UPDATE ON ProjectExpenseShare BEGIN SELECT RAISE(ABORT,'project expense allocation history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectExpenseShare_append_only_delete
      BEFORE DELETE ON ProjectExpenseShare BEGIN SELECT RAISE(ABORT,'project expense allocation history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectExpenseRefund_append_only_update
      BEFORE UPDATE ON ProjectExpenseRefund BEGIN SELECT RAISE(ABORT,'project refund history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectExpenseRefund_append_only_delete
      BEFORE DELETE ON ProjectExpenseRefund BEGIN SELECT RAISE(ABORT,'project refund history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectCashEvent_append_only_update
      BEFORE UPDATE ON ProjectCashEvent BEGIN SELECT RAISE(ABORT,'project cash history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectCashEvent_append_only_delete
      BEFORE DELETE ON ProjectCashEvent BEGIN SELECT RAISE(ABORT,'project cash history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectSettlement_append_only_update
      BEFORE UPDATE ON ProjectSettlement BEGIN SELECT RAISE(ABORT,'project settlement history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectSettlement_append_only_delete
      BEFORE DELETE ON ProjectSettlement BEGIN SELECT RAISE(ABORT,'project settlement history is immutable'); END;
  `);
}

/** Adds optional participant contribution targets without rewriting existing project history. */
async function migrateProjectsV17(database: MigrationDatabase): Promise<void> {
  const memberColumns = await columnsFor(database, 'ProjectMember');
  await addColumnIfMissing(database, 'ProjectMember', memberColumns, 'targetContributionMinor', 'INTEGER CHECK(targetContributionMinor IS NULL OR (typeof(targetContributionMinor)=\'integer\' AND targetContributionMinor >= 0 AND targetContributionMinor <= 9007199254740991))');
  const expenseColumns = await columnsFor(database, 'ProjectExpense');
  await addColumnIfMissing(database, 'ProjectExpense', expenseColumns, 'accountId', 'TEXT');
  await addColumnIfMissing(database, 'ProjectExpense', expenseColumns, 'transactionId', 'TEXT');
  const refundColumns = await columnsFor(database, 'ProjectExpenseRefund');
  await addColumnIfMissing(database, 'ProjectExpenseRefund', refundColumns, 'transactionId', 'TEXT');
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS ProjectMember_project_target_idx ON ProjectMember(ownerId,projectId,status,targetContributionMinor);
    CREATE UNIQUE INDEX IF NOT EXISTS ProjectExpense_transaction_unique_idx ON ProjectExpense(ownerId,transactionId) WHERE transactionId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ProjectExpenseRefund_transaction_unique_idx ON ProjectExpenseRefund(ownerId,transactionId) WHERE transactionId IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS ProjectExpense_account_link_insert
    BEFORE INSERT ON ProjectExpense
    WHEN (NEW.accountId IS NULL) <> (NEW.transactionId IS NULL)
      OR (NEW.transactionId IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "Transaction" t JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId
        WHERE t.id=NEW.transactionId AND t.ownerId=NEW.ownerId AND t.type='Expense'
          AND t.accountId=NEW.accountId AND t.amountMinor=NEW.amountMinor AND a.currency=NEW.currency
      ))
    BEGIN SELECT RAISE(ABORT,'project expense account link does not match its personal transaction'); END;
    CREATE TRIGGER IF NOT EXISTS ProjectExpenseRefund_account_link_insert
    BEFORE INSERT ON ProjectExpenseRefund
    WHEN (NEW.transactionId IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ProjectExpense e JOIN "Transaction" t ON t.id=NEW.transactionId AND t.ownerId=NEW.ownerId
      WHERE e.id=NEW.expenseId AND e.ownerId=NEW.ownerId AND e.projectId=NEW.projectId
        AND e.transactionId IS NOT NULL AND t.type='Refund' AND t.reversalOfId=e.transactionId
        AND t.amountMinor=NEW.amountMinor AND t.date=NEW.occurredAt AND t.accountId=e.accountId
    ))
    BEGIN SELECT RAISE(ABORT,'project refund account link does not match its personal refund transaction'); END;
  `);
}

/** Adds covering indexes for account-specific transaction history and movement summaries. */
async function migrateAccountActivityIndexesV14(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS Transaction_owner_account_history_idx ON "Transaction"(ownerId,accountId,date DESC,id DESC);
    CREATE INDEX IF NOT EXISTS Transaction_owner_destination_history_idx ON "Transaction"(ownerId,toAccountId,date DESC,id DESC);
  `);
}

/** Persist first-run onboarding only for profiles created by this app installation. */
async function migrateOnboardingRequirementV15(database: MigrationDatabase): Promise<void> {
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS OnboardingRequirement (
      ownerId TEXT PRIMARY KEY NOT NULL REFERENCES User(id) ON DELETE CASCADE,
      requiredAt TEXT NOT NULL
    );
  `);
}
