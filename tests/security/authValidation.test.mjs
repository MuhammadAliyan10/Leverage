import test from 'node:test';
import assert from 'node:assert/strict';
import { signInSchema, signUpSchema } from '../../utils/validations/auth.ts';

test('sign in trims and normalizes email while allowing existing password lengths', () => {
  const result = signInSchema.safeParse({ email: '  PERSON@Example.Test ', password: 'old' });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { email: 'person@example.test', password: 'old' });
});

test('sign in rejects empty values and malformed email addresses', () => {
  assert.equal(signInSchema.safeParse({ email: '', password: 'x' }).success, false);
  assert.equal(signInSchema.safeParse({ email: 'not-an-email', password: 'x' }).success, false);
  assert.equal(signInSchema.safeParse({ email: 'person@example.test', password: '' }).success, false);
});

test('sign up trims the name and email and accepts a matching policy-compliant password', () => {
  const result = signUpSchema.safeParse({
    fullName: '  Preview User  ',
    email: '  PREVIEW@example.test ',
    password: 'Synthetic-Password-42',
    confirmPassword: 'Synthetic-Password-42',
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    fullName: 'Preview User',
    email: 'preview@example.test',
    password: 'Synthetic-Password-42',
    confirmPassword: 'Synthetic-Password-42',
  });
});

test('sign up rejects blank names, malformed email, weak passwords, mismatches, and oversized passwords', () => {
  const valid = {
    fullName: 'Preview User',
    email: 'preview@example.test',
    password: 'Synthetic-Password-42',
    confirmPassword: 'Synthetic-Password-42',
  };
  assert.equal(signUpSchema.safeParse({ ...valid, fullName: '   ' }).success, false);
  assert.equal(signUpSchema.safeParse({ ...valid, email: 'bad-email' }).success, false);
  assert.equal(signUpSchema.safeParse({ ...valid, password: 'short1A', confirmPassword: 'short1A' }).success, false);
  assert.equal(signUpSchema.safeParse({ ...valid, password: 'synthetic-password-42', confirmPassword: 'synthetic-password-42' }).success, false);
  assert.equal(signUpSchema.safeParse({ ...valid, confirmPassword: 'Different-Password-42' }).success, false);
  assert.equal(signUpSchema.safeParse({ ...valid, password: 'A1'.padEnd(1025, 'x'), confirmPassword: 'A1'.padEnd(1025, 'x') }).success, false);
});
