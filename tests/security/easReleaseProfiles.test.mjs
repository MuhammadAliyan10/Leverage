import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const eas = JSON.parse(await readFile(new URL('../../eas.json', import.meta.url), 'utf8'));
const app = JSON.parse(await readFile(new URL('../../app.json', import.meta.url), 'utf8')).expo;

test('verification builds remain disposable and separate from the production package', () => {
  for (const name of ['development', 'preview']) {
    assert.equal(eas.build[name].env.HOUSELOG_ANDROID_VARIANT, 'disposable');
  }
  assert.equal(app.android.package, 'com.houselog.finance');
});

test('production installable APK uses production identity and production environment', () => {
  const profile = eas.build['production-apk'];
  assert.equal(profile.environment, 'production');
  assert.equal(profile.distribution, 'internal');
  assert.equal(profile.android.buildType, 'apk');
  assert.equal(profile.autoIncrement, true);
  assert.equal(profile.env?.HOUSELOG_ANDROID_VARIANT, undefined);
});

test('Play Store production profile emits an app bundle with production environment', () => {
  const profile = eas.build.production;
  assert.equal(profile.environment, 'production');
  assert.equal(profile.distribution, 'store');
  assert.equal(profile.android.buildType, 'app-bundle');
  assert.equal(profile.autoIncrement, true);
});
