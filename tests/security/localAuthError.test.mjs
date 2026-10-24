import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalAuthFailureMessage, LOCAL_PROFILE_NOT_FOUND_MESSAGE } from '../../src/security/localAuthError.ts';

test('reports missing SQLCipher support without suggesting a data reset', () => {
  const message = getLocalAuthFailureMessage(new Error('SQLCipher is unavailable in this native app build.'));
  assert.match(message, /missing encrypted database support/i);
  assert.match(message, /records were not reset/i);
});

test('reports an unavailable database key without recommending app data deletion', () => {
  const message = getLocalAuthFailureMessage(new Error('The local database key is missing. Restore from a verified backup.'));
  assert.match(message, /encrypted database/i);
  assert.match(message, /Do not uninstall or clear app data/i);
});

test('does not hide a concrete SQLite open failure behind a generic storage message', () => {
  const message = getLocalAuthFailureMessage(new Error('Local database could not be safely opened: disk I/O error'));
  assert.match(message, /disk I\/O error/i);
  assert.match(message, /records were not deliberately cleared/i);
});

test('names sign-up correctly when local profile creation fails after cloud registration', () => {
  const message = getLocalAuthFailureMessage(new Error('URI is not absolute'), 'sign-up');
  assert.match(message, /could not complete sign-up/i);
  assert.match(message, /URI is not absolute/i);
});

test('explains that profiles are local to each device when no profile is found', () => {
  assert.match(LOCAL_PROFILE_NOT_FOUND_MESSAGE, /browser and Android profiles separate/i);
  assert.match(LOCAL_PROFILE_NOT_FOUND_MESSAGE, /create a profile here or restore/i);
});
