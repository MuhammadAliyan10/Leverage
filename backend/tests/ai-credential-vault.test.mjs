import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptAICredential, encryptAICredential } from '../src/aiCredentialVault.ts';

const key = 'ab'.repeat(32);
const credential = `sk-proj-${'a'.repeat(40)}`;

test('provider credentials use randomized authenticated encryption scoped to the account', () => {
  const first = encryptAICredential('user-a', credential, key);
  const second = encryptAICredential('user-a', credential, key);
  assert.notEqual(first, second);
  assert.equal(first.includes(credential), false);
  assert.equal(decryptAICredential('user-a', first, key), credential);
  assert.throws(() => decryptAICredential('user-b', first, key), /could not be decrypted/);
  const [version, iv, tag, ciphertext] = first.split('.');
  const changedTag = `${tag.startsWith('A') ? 'B' : 'A'}${tag.slice(1)}`;
  const tampered = `${version}.${iv}.${changedTag}.${ciphertext}`;
  assert.throws(() => decryptAICredential('user-a', tampered, key), /could not be decrypted/);
});

test('credential encryption rejects invalid server keys and malformed envelopes', () => {
  assert.throws(() => encryptAICredential('user-a', credential, 'not-a-key'), /not configured/);
  assert.throws(() => decryptAICredential('user-a', 'plaintext', key), /is invalid/);
});
