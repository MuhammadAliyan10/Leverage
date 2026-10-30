export type AppearancePreference = 'system' | 'light' | 'dark';

export interface ProfileSettings {
  appLockEnabled: boolean;
  biometricUnlockEnabled: boolean;
  remindersEnabled: boolean;
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  appLockEnabled: true,
  biometricUnlockEnabled: false,
  remindersEnabled: true,
};

export interface SettingsKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const APPEARANCE_KEY = 'houselog_appearance_v1';
const profileKey = (profileId: string) => `houselog_profile_settings_v1_${profileId}`;
const backgroundKey = (profileId: string) => `houselog_profile_background_v1_${profileId}`;

export function createSettingsPreferenceStore(storage: SettingsKeyValueStorage) {
  return {
    async getAppearance(): Promise<AppearancePreference> {
      const value = await storage.getItem(APPEARANCE_KEY);
      return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
    },
    setAppearance(value: AppearancePreference): Promise<void> {
      return storage.setItem(APPEARANCE_KEY, value);
    },
    async getProfile(profileId: string): Promise<ProfileSettings> {
      if (!profileId.trim()) throw new Error('A profile is required to load its settings.');
      const stored = await storage.getItem(profileKey(profileId));
      if (stored === null) return { ...DEFAULT_PROFILE_SETTINGS };
      let value: unknown;
      try {
        value = JSON.parse(stored);
      } catch {
        throw new Error('Saved profile settings are invalid.');
      }
      if (!value || typeof value !== 'object'
        || !('appLockEnabled' in value)
        || !('biometricUnlockEnabled' in value)
        || !('remindersEnabled' in value)
        || typeof value.appLockEnabled !== 'boolean'
        || typeof value.biometricUnlockEnabled !== 'boolean'
        || typeof value.remindersEnabled !== 'boolean') {
        throw new Error('Saved profile settings are incomplete.');
      }
      return {
        appLockEnabled: value.appLockEnabled,
        biometricUnlockEnabled: value.biometricUnlockEnabled,
        remindersEnabled: value.remindersEnabled,
      };
    },
    async setProfile(profileId: string, value: ProfileSettings): Promise<void> {
      if (!profileId.trim()) throw new Error('A profile is required to save its settings.');
      if (value.biometricUnlockEnabled && !value.appLockEnabled) {
        throw new Error('Biometric unlock requires the app lock to be enabled.');
      }
      await storage.setItem(profileKey(profileId), JSON.stringify(value));
    },
    async getLastBackgroundAt(profileId: string): Promise<number | null> {
      if (!profileId.trim()) throw new Error('A profile is required to read its lock state.');
      const stored = await storage.getItem(backgroundKey(profileId));
      if (stored === null) return null;
      const timestamp = Number(stored);
      return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
    },
    async setLastBackgroundAt(profileId: string, timestamp: number): Promise<void> {
      if (!profileId.trim() || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
        throw new Error('The profile inactivity timestamp is invalid.');
      }
      await storage.setItem(backgroundKey(profileId), String(timestamp));
    },
    async clearLastBackgroundAt(profileId: string): Promise<void> {
      if (!profileId.trim()) throw new Error('A profile is required to clear its lock state.');
      await storage.removeItem(backgroundKey(profileId));
    },
  };
}
