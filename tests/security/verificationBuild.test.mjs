import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPOSABLE_ANDROID_VERIFICATION_VARIANT, isDisposableAndroidVerificationBuild } from '../../src/security/verificationBuild.ts';

test('native SQLCipher verification is enabled only for the dedicated disposable build variant', () => {
  assert.equal(isDisposableAndroidVerificationBuild({ houseLogBuildVariant: DISPOSABLE_ANDROID_VERIFICATION_VARIANT }), true);
  assert.equal(isDisposableAndroidVerificationBuild({ houseLogBuildVariant: 'production' }), false);
  assert.equal(isDisposableAndroidVerificationBuild({}), false);
  assert.equal(isDisposableAndroidVerificationBuild(null), false);
  assert.equal(isDisposableAndroidVerificationBuild('disposable-android-verification'), false);
});
