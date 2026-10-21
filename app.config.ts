import type { ExpoConfig } from 'expo/config';

/** The Android verification variant has its own package sandbox and SQLite files. */
export default ({ config }: { config: ExpoConfig }): ExpoConfig => {
  const disposable = process.env.HOUSELOG_ANDROID_VARIANT === 'disposable';
  if (!disposable) return config;
  return {
    ...config,
    name: 'HouseLog Verification',
    android: {
      ...config.android,
      package: 'com.houselog.verification',
    },
    extra: {
      ...config.extra,
      houseLogBuildVariant: 'disposable-android-verification',
    },
  };
};
