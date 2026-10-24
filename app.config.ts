import type { ExpoConfig } from 'expo/config';
import { assertProductionNeonConfigured } from './src/cloud/apiConfiguration.ts';
import { DISPOSABLE_ANDROID_VERIFICATION_VARIANT } from './src/security/verificationBuild.ts';

/** The Android verification variant has its own package sandbox and SQLite files. */
export default ({ config }: { config: ExpoConfig }): ExpoConfig => {
  assertProductionNeonConfigured(process.env.EAS_BUILD_PROFILE, process.env.EXPO_PUBLIC_NEON_AUTH_URL, process.env.EXPO_PUBLIC_NEON_DATA_API_URL);
  const disposable = process.env.HOUSELOG_ANDROID_VARIANT === 'disposable';
  if (!disposable) return config;
  return {
    ...config,
    name: 'Mizan Verification',
    android: {
      ...config.android,
      package: 'com.houselog.verification',
    },
    extra: {
      ...config.extra,
      houseLogBuildVariant: DISPOSABLE_ANDROID_VERIFICATION_VARIANT,
    },
  };
};
