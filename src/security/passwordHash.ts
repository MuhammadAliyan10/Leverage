import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const PASSWORD_HASH_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const HASH_PREFIX = 'pbkdf2-sha256';
type NativePasswordKdf = {
  pbkdf2Sha256(password: string, saltHex: string, iterations: number, outputBytes: number): Promise<string>;
};

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  // Avoid importing React Native's Flow-typed entry point into Node-based domain
  // tests; Hermes exposes the same runtime marker on actual native devices.
  const isNativeRuntime = typeof navigator !== 'undefined'
    && (navigator as Navigator & { product?: string }).product === 'ReactNative';
  if (isNativeRuntime) {
    // Keep the same PBKDF2 work factor and persisted hash format while doing the
    // expensive loop in the platform crypto provider instead of Hermes JS.
    const { requireNativeModule } = await import('expo-modules-core');
    const native = requireNativeModule<NativePasswordKdf>('LeveragePasswordKdf');
    const output = await native.pbkdf2Sha256(password, bytesToHex(salt), iterations, DERIVED_KEY_BYTES);
    if (!/^[0-9a-f]{64}$/i.test(output)) throw new Error('Native password derivation returned an invalid result.');
    return hexToBytes(output);
  }
  return pbkdf2Async(sha256, utf8ToBytes(password), salt, { c: iterations, dkLen: DERIVED_KEY_BYTES });
}

function validPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) {
    throw new Error('Password must contain between 1 and 1,024 characters.');
  }
}

function parseHash(storedHash: string): { iterations: number; salt: Uint8Array; expected: Uint8Array } | null {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX || !/^\d+$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < PASSWORD_HASH_ITERATIONS || iterations > 2_000_000) return null;
  if (!/^[0-9a-f]{32}$/i.test(parts[2]) || !/^[0-9a-f]{64}$/i.test(parts[3])) return null;
  try {
    return { iterations, salt: hexToBytes(parts[2]), expected: hexToBytes(parts[3]) };
  } catch {
    return null;
  }
}

/** PBKDF2-HMAC-SHA256; salt must be 16 bytes and iterations must meet the chosen policy floor. */
export async function derivePasswordHash(password: string, salt: Uint8Array, iterations = PASSWORD_HASH_ITERATIONS): Promise<string> {
  validPassword(password);
  if (salt.length !== SALT_BYTES) throw new Error('Password salt must be 16 random bytes.');
  if (!Number.isSafeInteger(iterations) || iterations < PASSWORD_HASH_ITERATIONS || iterations > 2_000_000) {
    throw new Error('Password hash work factor is outside the supported range.');
  }
  const derived = await deriveKey(password, salt, iterations);
  return `${HASH_PREFIX}$${iterations}$${bytesToHex(salt)}$${bytesToHex(derived)}`;
}

export async function verifyPbkdf2Password(password: string, storedHash: string): Promise<boolean> {
  try {
    validPassword(password);
    const parsed = parseHash(storedHash);
    if (!parsed) return false;
    const actual = await deriveKey(password, parsed.salt, parsed.iterations);
    let difference = 0;
    for (let index = 0; index < DERIVED_KEY_BYTES; index += 1) difference |= actual[index] ^ parsed.expected[index];
    return difference === 0;
  } catch {
    return false;
  }
}

export interface PasswordUpgradeDependencies {
  verifyLegacy(password: string, legacyHash: string): Promise<boolean>;
  createCurrentHash(password: string): Promise<string>;
  replaceStoredHash(legacyHash: string, currentHash: string): Promise<void>;
}

export type PasswordVerification = { valid: false; upgraded: false } | { valid: true; upgraded: boolean };

/** Upgrades a legacy credential only after its old verifier succeeds; failed upgrades preserve access and stored bytes. */
export async function verifyAndUpgradePassword(
  password: string,
  storedHash: string,
  dependencies: PasswordUpgradeDependencies,
): Promise<PasswordVerification> {
  if (storedHash.startsWith(`${HASH_PREFIX}$`)) {
    return { valid: await verifyPbkdf2Password(password, storedHash), upgraded: false };
  }
  let valid = false;
  try { valid = await dependencies.verifyLegacy(password, storedHash); } catch { return { valid: false, upgraded: false }; }
  if (!valid) return { valid: false, upgraded: false };
  try {
    const currentHash = await dependencies.createCurrentHash(password);
    await dependencies.replaceStoredHash(storedHash, currentHash);
    return { valid: true, upgraded: true };
  } catch {
    // The previously verified legacy hash remains unchanged and usable if a KDF or DB update fails.
    return { valid: true, upgraded: false };
  }
}
