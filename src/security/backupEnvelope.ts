import { assertProfileId, keyFromHex, keyToHex } from './keyMaterial.ts';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const MAGIC = 'HLBK1';
const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = MAX_DATABASE_BYTES + 256;
const PASSPHRASE_MAGIC = 'HLBK2';
export const BACKUP_KDF_ITERATIONS = 600_000;

/** Backup metadata must describe the serialized SQLite image and be migratable by this app. */
export function assertBackupSchemaVersion(envelopeVersion: number, databaseVersion: number, supportedVersion: number): void {
  if (!Number.isSafeInteger(envelopeVersion) || envelopeVersion < 1 ||
      !Number.isSafeInteger(databaseVersion) || databaseVersion < 1 ||
      !Number.isSafeInteger(supportedVersion) || supportedVersion < 1 ||
      envelopeVersion !== databaseVersion || envelopeVersion > supportedVersion) {
    throw new Error('Backup schema version is incompatible.');
  }
}

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
  profileId: string;
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
  return { schemaVersion, profileId: match[2], database };
}

/** New user-portable backups derive an encryption key from a passphrase and random salt. */
export async function createPassphraseBackupEnvelope(
  cipher: BackupCipher,
  passphrase: string,
  scope: string,
  schemaVersion: number,
  database: Uint8Array,
  randomBytes: (count: number) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  validatePassphrase(passphrase);
  assertProfileId(scope);
  validateBackup(schemaVersion, database);
  const salt = await randomBytes(16);
  if (salt.length !== 16) throw new Error('Backup salt generation failed.');
  const header = ascii(`${PASSPHRASE_MAGIC}|${BACKUP_KDF_ITERATIONS}|${keyToHex32(salt)}\n`);
  const key = await pbkdf2Async(sha256, passphrase, salt, { c: BACKUP_KDF_ITERATIONS, dkLen: 32 });
  const inner = concatenate(ascii(`${schemaVersion}|${scope}\n`), database);
  const sealed = await cipher.seal(inner, key, header);
  if (sealed.length < 28 || sealed.length > MAX_ENVELOPE_BYTES) throw new Error('The encrypted backup has an invalid size.');
  return concatenate(header, sealed);
}

export async function openPassphraseBackupEnvelope(
  cipher: BackupCipher,
  passphrase: string,
  expectedScope: string | null,
  expectedSchemaVersion: number,
  envelope: Uint8Array,
): Promise<RestoredBackup> {
  validatePassphrase(passphrase);
  if (expectedScope !== null) assertProfileId(expectedScope);
  if (envelope.length < 48 + 28 || envelope.length > MAX_ENVELOPE_BYTES + 64) throw new Error('Invalid backup size.');
  const lineEnd = envelope.indexOf(10);
  if (lineEnd < 1 || lineEnd > 80) throw new Error('Unsupported backup format.');
  const headerBytes = envelope.subarray(0, lineEnd + 1);
  const header = asciiString(headerBytes);
  const match = /^HLBK2\|(\d{6})\|([a-f0-9]{32})\n$/i.exec(header);
  if (!match || Number(match[1]) !== BACKUP_KDF_ITERATIONS) throw new Error('Unsupported backup format.');
  const salt = fromHex(match[2]);
  const key = await pbkdf2Async(sha256, passphrase, salt, { c: BACKUP_KDF_ITERATIONS, dkLen: 32 });
  let plaintext: Uint8Array;
  try { plaintext = await cipher.open(envelope.subarray(lineEnd + 1), key, headerBytes); }
  catch { throw new Error('The passphrase is incorrect or the backup is damaged.'); }
  const newline = plaintext.subarray(0, 80).indexOf(10);
  if (newline < 0) throw new Error('Backup metadata is invalid.');
  const metadata = asciiString(plaintext.subarray(0, newline));
  const metadataMatch = /^(\d{1,5})\|([A-Za-z0-9_-]{1,64})$/.exec(metadata);
  if (!metadataMatch) throw new Error('Backup metadata is invalid.');
  const schemaVersion = Number(metadataMatch[1]);
  if (schemaVersion < 1 || schemaVersion > expectedSchemaVersion) throw new Error('Backup schema version is incompatible.');
  assertProfileId(metadataMatch[2]);
  if (expectedScope !== null && metadataMatch[2] !== expectedScope) throw new Error('Backup is for a different Leverage profile.');
  const database = plaintext.slice(newline + 1);
  if (database.length === 0 || database.length > MAX_DATABASE_BYTES) throw new Error('Backup database size is invalid.');
  return { schemaVersion, profileId: metadataMatch[2], database };
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 256) {
    throw new Error('Use a backup passphrase with at least 12 characters.');
  }
}

function validateBackup(schemaVersion: number, database: Uint8Array): void {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 10_000) throw new Error('Invalid backup schema version.');
  if (database.length === 0 || database.length > MAX_DATABASE_BYTES) throw new Error('The database is empty or exceeds the supported backup size.');
}

function keyToHex32(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('A 128-bit random salt is required.');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error('Invalid backup salt.');
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}
