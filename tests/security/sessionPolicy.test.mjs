import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadProtectedData, decideRestoredSession } from '../../src/security/sessionPolicy.ts';

test('a remembered profile restores signed in across refreshes', () => {
  assert.equal(decideRestoredSession({ savedUserId: 'profile-a', signedOutMarker: false, profileExists: true }), 'signedIn');
  assert.equal(canReadProtectedData('locked'), false);
  assert.equal(canReadProtectedData('signedIn'), true);
});

test('app lock does not prompt on each restart, but locks after the configured inactivity period', () => {
  assert.equal(decideRestoredSession({ savedUserId: 'profile-a', signedOutMarker: false, profileExists: true, appLockEnabled: true }), 'signedIn');
  assert.equal(decideRestoredSession({ savedUserId: 'profile-a', signedOutMarker: false, profileExists: true, appLockEnabled: true, lastBackgroundAt: 1_000, now: 901_000 }), 'locked');
  assert.equal(decideRestoredSession({ savedUserId: 'profile-a', signedOutMarker: false, profileExists: true, appLockEnabled: false, lastBackgroundAt: 1_000, now: 901_000 }), 'signedIn');
  assert.equal(canReadProtectedData('locked'), false);
});

test('a remembered web session remains signed in across reloads even when native app lock is enabled', () => {
  assert.equal(decideRestoredSession({
    savedUserId: 'profile-a', signedOutMarker: false, profileExists: true,
    appLockEnabled: true,
  }), 'signedIn');
  assert.equal(decideRestoredSession({
    savedUserId: 'profile-a', signedOutMarker: false, profileExists: true,
    appLockEnabled: true, lastBackgroundAt: 0, now: 1_000_000,
  }), 'locked');
});

test('logout marker, missing ID, and stale profile IDs all restore signed out', () => {
  assert.equal(decideRestoredSession({ savedUserId: 'profile-a', signedOutMarker: true, profileExists: true }), 'signedOut');
  assert.equal(decideRestoredSession({ savedUserId: null, signedOutMarker: false, profileExists: false }), 'signedOut');
  assert.equal(decideRestoredSession({ savedUserId: 'deleted-profile', signedOutMarker: false, profileExists: false }), 'signedOut');
  for (const status of ['restoring', 'signedOut', 'locked']) assert.equal(canReadProtectedData(status), false);
});
