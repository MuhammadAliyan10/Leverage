import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadProtectedData, decideRestoredSession } from '../../src/security/sessionPolicy.ts';

test('a remembered profile restores signed in across refreshes', () => {
  assert.equal(decideRestoredSession({ savedUserId: 'profile-a', signedOutMarker: false, profileExists: true }), 'signedIn');
  assert.equal(canReadProtectedData('locked'), false);
  assert.equal(canReadProtectedData('signedIn'), true);
});

test('logout marker, missing ID, and stale profile IDs all restore signed out', () => {
  assert.equal(decideRestoredSession({ savedUserId: 'profile-a', signedOutMarker: true, profileExists: true }), 'signedOut');
  assert.equal(decideRestoredSession({ savedUserId: null, signedOutMarker: false, profileExists: false }), 'signedOut');
  assert.equal(decideRestoredSession({ savedUserId: 'deleted-profile', signedOutMarker: false, profileExists: false }), 'signedOut');
  for (const status of ['restoring', 'signedOut', 'locked']) assert.equal(canReadProtectedData(status), false);
});
