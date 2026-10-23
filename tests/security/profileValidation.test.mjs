import test from 'node:test';
import assert from 'node:assert/strict';
import { changePasswordSchema, profileNameSchema } from '../../utils/validations/profile.ts';

test('profile name validation trims and bounds display names', () => {
  assert.deepEqual(profileNameSchema.parse({ fullName: '  Ayan Khan  ' }), { fullName: 'Ayan Khan' });
  assert.equal(profileNameSchema.safeParse({ fullName: 'x' }).success, false);
  assert.equal(profileNameSchema.safeParse({ fullName: 'x'.repeat(61) }).success, false);
});

test('password change requires a current password and a confirmed strong replacement', () => {
  const valid = { currentPassword: 'old-password', newPassword: 'New-Synthetic-42', confirmPassword: 'New-Synthetic-42' };
  assert.equal(changePasswordSchema.safeParse(valid).success, true);
  assert.equal(changePasswordSchema.safeParse({ ...valid, currentPassword: '' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ ...valid, newPassword: 'weak', confirmPassword: 'weak' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ ...valid, confirmPassword: 'different' }).success, false);
});
