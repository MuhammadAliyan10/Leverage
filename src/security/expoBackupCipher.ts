import * as Crypto from 'expo-crypto';
import type { BackupCipher } from './backupEnvelope';

/** SDK 57 AES-GCM adapter. Its native behavior still requires Android build verification. */
export const expoBackupCipher: BackupCipher = {
  async seal(plaintext, key, authenticatedHeader) {
    const imported = await Crypto.AESEncryptionKey.import(key);
    const encrypted = await Crypto.aesEncryptAsync(plaintext, imported, {
      additionalData: authenticatedHeader,
    });
    const combined = await encrypted.combined('bytes');
    if (!(combined instanceof Uint8Array)) throw new Error('Native encryption returned an unexpected format.');
    return combined;
  },
  async open(sealed, key, authenticatedHeader) {
    const imported = await Crypto.AESEncryptionKey.import(key);
    const combined = Crypto.AESSealedData.fromCombined(sealed);
    const plaintext = await Crypto.aesDecryptAsync(combined, imported, {
      additionalData: authenticatedHeader,
      output: 'bytes',
    });
    if (!(plaintext instanceof Uint8Array)) throw new Error('Native decryption returned an unexpected format.');
    return plaintext;
  },
};
