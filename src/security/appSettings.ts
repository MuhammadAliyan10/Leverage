import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { createSettingsPreferenceStore } from './settingsPreferences';

export const appSettings = createSettingsPreferenceStore({
  async getItem(key) {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return null;
      return window.localStorage.getItem(key);
    }
    return SecureStore.getItemAsync(key);
  },
  async setItem(key, value) {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') throw new Error('Browser storage is unavailable.');
      window.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
    async removeItem(key) {
      if (Platform.OS === 'web') {
        if (typeof window === 'undefined') throw new Error('Browser storage is unavailable.');
        window.localStorage.removeItem(key);
        return;
      }
      await SecureStore.deleteItemAsync(key);
    },
});
