import { assertProfileId, keyFromHex, keyToHex } from './keyMaterial.ts';

const MAGIC = 'HLBK1';
const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = MAX_DATABASE_BYTES + 256;

export interface BackupCipher {
  seal(plaintext: Uint8Array, key: Uint8Array, authenticatedHeader: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array, key: Uint8Array, authenticatedHeader: Uint8Array): Promise<Uint8Array>;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function asciiString(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array {
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  return combined;
}

/** Returns a user-held 256-bit recovery secret. It is never stored in the backup. */
export async function createRecoveryKey(randomBytes: (count: number) => Promise<Uint8Array>): Promise<string> {
  return keyToHex(await randomBytes(32));
}

export interface RestoredBackup {
  schemaVersion: number;
  database: Uint8Array;
}

/** The authenticated plaintext contains profile and schema metadata; the outer header is public. */
export async function createBackupEnvelope(
  cipher: BackupCipher,
  recoveryKeyHex: string,
  profileId: string,
  schemaVersion: number,
  database: Uint8Array,
): Promise<Uint8Array> {
  assertProfileId(profileId);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 10_000) {
    throw new Error('Invalid backup schema version.');
  }
  if (database.length === 0 || database.length > MAX_DATABASE_BYTES) {
    throw new Error('The database is empty or exceeds the supported backup size.');
  }
  const key = keyFromHex(recoveryKeyHex);
  const header = ascii(`${MAGIC}\n`);
  const inner = concatenate(ascii(`${schemaVersion}|${profileId}\n`), database);
  const sealed = await cipher.seal(inner, key, header);
  if (sealed.length < 28 || sealed.length > MAX_ENVELOPE_BYTES) {
    throw new Error('The encrypted backup has an invalid size.');
  }
  return concatenate(header, sealed);
}

export async function openBackupEnvelope(
  cipher: BackupCipher,
  recoveryKeyHex: string,
  expectedProfileId: string,
  expectedSchemaVersion: number,
  envelope: Uint8Array,
): Promise<RestoredBackup> {
  assertProfileId(expectedProfileId);
  if (envelope.length < MAGIC.length + 1 + 28 || envelope.length > MAX_ENVELOPE_BYTES + MAGIC.length + 1) {
    throw new Error('Invalid backup size.');
  }
  const header = ascii(`${MAGIC}\n`);
  if (asciiString(envelope.subarray(0, header.length)) !== `${MAGIC}\n`) {
    throw new Error('Unsupported backup format.');
  }
  const key = keyFromHex(recoveryKeyHex);
  let plaintext: Uint8Array;
  try {
    plaintext = await cipher.open(envelope.subarray(header.length), key, header);
  } catch {
    throw new Error('The recovery key is incorrect or the backup is damaged.');
  }
  const newline = plaintext.subarray(0, 80).indexOf(10);
  if (newline < 0) throw new Error('Backup metadata is invalid.');
  const metadata = asciiString(plaintext.subarray(0, newline));
  const match = /^(\d{1,5})\|([A-Za-z0-9_-]{1,64})$/.exec(metadata);
  if (!match) throw new Error('Backup metadata is invalid.');
  const schemaVersion = Number(match[1]);
  if (schemaVersion !== expectedSchemaVersion || schemaVersion < 1) {
    throw new Error('Backup schema version is incompatible.');
  }
  if (match[2] !== expectedProfileId) throw new Error('Backup belongs to a different profile.');
  const database = plaintext.slice(newline + 1);
  if (database.length === 0 || database.length > MAX_DATABASE_BYTES) {
    throw new Error('Backup database size is invalid.');
  }
  return { schemaVersion, database };
}
