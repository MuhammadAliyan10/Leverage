import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const KEY_PATTERN = /^[a-fA-F0-9]{64}$/;

function keyBytes(encodedKey: string): Buffer {
  if (!KEY_PATTERN.test(encodedKey)) throw new Error('AI credential encryption is not configured.');
  return Buffer.from(encodedKey, 'hex');
}

function associatedData(userId: string): Buffer {
  return Buffer.from(`leverage-ai-credential:${VERSION}:${userId}`, 'utf8');
}

/** AES-256-GCM envelope for a per-user provider credential. The key belongs in server secrets. */
export function encryptAICredential(userId: string, plaintext: string, encodedKey: string): string {
  if (!userId || userId.length > 255 || !plaintext) throw new Error('Invalid AI credential input.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(encodedKey), iv);
  cipher.setAAD(associatedData(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptAICredential(userId: string, envelope: string, encodedKey: string): string {
  if (!userId || userId.length > 255) throw new Error('Invalid AI credential owner.');
  const [version, ivText, tagText, ciphertextText, ...extra] = envelope.split('.');
  if (version !== VERSION || !ivText || !tagText || !ciphertextText || extra.length) throw new Error('Stored AI credential is invalid.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(encodedKey), Buffer.from(ivText, 'base64url'));
    decipher.setAAD(associatedData(userId));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored AI credential could not be decrypted.');
  }
}
