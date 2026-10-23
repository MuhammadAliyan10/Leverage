import test from 'node:test';
import assert from 'node:assert/strict';
import { onboardingSchema } from '../../utils/validations/onboarding.ts';

test('onboarding trims account names and accepts supported account types with an empty zero balance', () => {
  const result = onboardingSchema.safeParse({ name: '  Main bank  ', type: 'bank', currency: 'PKR', balance: '' });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { name: 'Main bank', type: 'bank', currency: 'PKR', balance: '' });
});

test('onboarding balance accepts exact cents and zero but rejects negative, malformed, and over-precision values', () => {
  for (const balance of ['0', '0.00', '0.01', '123456.78']) {
    assert.equal(onboardingSchema.safeParse({ name: 'Main bank', type: 'bank', currency: 'PKR', balance }).success, true, balance);
  }
  for (const balance of ['-1', '1.001', '1e3', 'abc', '9007199254740992']) {
    assert.equal(onboardingSchema.safeParse({ name: 'Main bank', type: 'bank', currency: 'PKR', balance }).success, false, balance);
  }
});

test('onboarding requires a trimmed name and known account type', () => {
  const valid = { name: 'Main bank', type: 'bank', currency: 'PKR', balance: '0' };
  assert.equal(onboardingSchema.safeParse({ ...valid, name: '  ' }).success, false);
  assert.equal(onboardingSchema.safeParse({ ...valid, name: 'x' }).success, false);
  assert.equal(onboardingSchema.safeParse({ ...valid, name: 'x'.repeat(81) }).success, false);
  assert.equal(onboardingSchema.safeParse({ ...valid, type: 'crypto' }).success, false);
});
