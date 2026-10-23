import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsPreferenceStore, DEFAULT_PROFILE_SETTINGS } from '../../src/security/settingsPreferences.ts';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
  };
}

test('appearance choice persists and defaults to following the system', async () => {
  const storage = memoryStorage();
  const settings = createSettingsPreferenceStore(storage);
  assert.equal(await settings.getAppearance(), 'system');
  await settings.setAppearance('dark');
  assert.equal(await settings.getAppearance(), 'dark');
  await settings.setAppearance('light');
  assert.equal(await settings.getAppearance(), 'light');
});

test('security and reminder preferences are isolated by profile', async () => {
  const settings = createSettingsPreferenceStore(memoryStorage());
  assert.deepEqual(await settings.getProfile('profile-a'), DEFAULT_PROFILE_SETTINGS);
  await settings.setProfile('profile-a', { ...DEFAULT_PROFILE_SETTINGS, biometricUnlockEnabled: true });
  await settings.setProfile('profile-b', { ...DEFAULT_PROFILE_SETTINGS, remindersEnabled: false });
  assert.deepEqual(await settings.getProfile('profile-a'), { ...DEFAULT_PROFILE_SETTINGS, biometricUnlockEnabled: true });
  assert.deepEqual(await settings.getProfile('profile-b'), { ...DEFAULT_PROFILE_SETTINGS, remindersEnabled: false });
});

test('biometric unlock cannot be enabled without app lock', async () => {
  const settings = createSettingsPreferenceStore(memoryStorage());
  await assert.rejects(
    settings.setProfile('profile-a', { appLockEnabled: false, biometricUnlockEnabled: true, remindersEnabled: true }),
    /requires the app lock/,
  );
});

test('corrupt saved profile settings are reported rather than silently accepted', async () => {
  const storage = memoryStorage();
  storage.values.set('houselog_profile_settings_v1_profile-a', '{bad json');
  const settings = createSettingsPreferenceStore(storage);
  await assert.rejects(settings.getProfile('profile-a'), /invalid/);
});
