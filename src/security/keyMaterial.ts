const KEY_BYTES = 32;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertProfileId(profileId: string): void {
  if (!PROFILE_ID_PATTERN.test(profileId)) throw new Error('Invalid local profile identifier.');
}

export function keyToHex(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error('A 256-bit key is required.');
  return Array.from(key, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function keyFromHex(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Invalid 256-bit key material.');
  const key = new Uint8Array(KEY_BYTES);
  for (let index = 0; index < KEY_BYTES; index += 1) {
    key[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return key;
}

export interface DeviceKeyPort {
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
  randomBytes(count: number): Promise<Uint8Array>;
  databaseExists(profileId: string): Promise<boolean>;
}

/** A missing key for an existing database is an error, never a signal to create a new database. */
export function createProfileKeyManager(port: DeviceKeyPort) {
  const pending = new Map<string, Promise<Uint8Array>>();

  async function load(profileId: string, allowCreate: boolean): Promise<Uint8Array> {
    assertProfileId(profileId);
    const name = `houselog.dbkey.v1.${profileId}`;
    const saved = await port.read(name);
    if (saved !== null) return keyFromHex(saved);
    if (!allowCreate || await port.databaseExists(profileId)) {
      throw new Error('The local database key is unavailable. Restore from a verified backup.');
    }
    const key = await port.randomBytes(KEY_BYTES);
    const encoded = keyToHex(key);
    await port.write(name, encoded);
    return key;
  }

  function singleFlight(profileId: string, allowCreate: boolean): Promise<Uint8Array> {
    assertProfileId(profileId);
    const existing = pending.get(profileId);
    if (existing) return existing;
    const operation = load(profileId, allowCreate);
    pending.set(profileId, operation);
    const clearPending = () => {
      if (pending.get(profileId) === operation) pending.delete(profileId);
    };
    void operation.then(clearPending, clearPending);
    return operation;
  }

  return {
    loadExisting: (profileId: string) => singleFlight(profileId, false),
    loadOrCreate: (profileId: string) => singleFlight(profileId, true),
  };
}
