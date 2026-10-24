import { assertBackupSchemaVersion } from '../../security/backupEnvelope.ts';
import { LOCAL_DATABASE_VERSION, migrateLocalDatabase, type MigrationDatabase } from './migrations.ts';

/** Validate and upgrade only the detached SQLite candidate, before it can replace a device database. */
export async function prepareBackupCandidate(
  database: MigrationDatabase,
  expectedProfileId: string,
  envelopeSchemaVersion: number,
): Promise<void> {
  const originalVersion = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  assertBackupSchemaVersion(envelopeSchemaVersion, originalVersion?.user_version ?? 0, LOCAL_DATABASE_VERSION);
  const originalProfile = await database.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [expectedProfileId]);
  if (!originalProfile) throw new Error('The backup belongs to a different profile or has no valid profile record.');
  await migrateLocalDatabase(database);

  const integrity = await database.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
  const foreignKeys = await database.getAllAsync('PRAGMA foreign_key_check');
  const version = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const profile = await database.getFirstAsync<{ id: string }>('SELECT id FROM User WHERE id=?', [expectedProfileId]);
  const malformedTransaction = await database.getFirstAsync<{ id: string }>(`SELECT id FROM "Transaction"
    WHERE typeof(amountMinor)!='integer' OR amountMinor<=0 OR ownerId IS NULL LIMIT 1`);
  const malformedAccount = await database.getFirstAsync<{ id: string }>(`SELECT id FROM Account
    WHERE typeof(balanceMinor)!='integer' OR balanceMinor<0 OR ownerId IS NULL LIMIT 1`);
  if (integrity?.integrity_check !== 'ok' || foreignKeys.length !== 0 || version?.user_version !== LOCAL_DATABASE_VERSION ||
      !profile || malformedTransaction || malformedAccount) {
    throw new Error('The backup failed schema, profile, financial-record or foreign-key validation. Your current database was not changed.');
  }
}
