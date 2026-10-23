import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfileSwitchTarget } from '../../src/security/profileSwitchPolicy.ts';

const profiles = [
  { id: 'profile-a', email: 'a@example.test' },
  { id: 'profile-b', email: 'b@example.test' },
];

test('profile switch resolves by unique profile ID and does not authenticate the target', () => {
  assert.deepEqual(resolveProfileSwitchTarget(profiles, 'profile-a', 'profile-b'), profiles[1]);
});

test('profile switch rejects the active or an unavailable profile ID', () => {
  assert.throws(() => resolveProfileSwitchTarget(profiles, 'profile-a', 'profile-a'), /another available/);
  assert.throws(() => resolveProfileSwitchTarget(profiles, 'profile-a', 'missing'), /another available/);
});
