export const DISPOSABLE_ANDROID_VERIFICATION_VARIANT = 'disposable-android-verification';

export function isDisposableAndroidVerificationBuild(extra: unknown): boolean {
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return false;
  return (extra as Record<string, unknown>).houseLogBuildVariant === DISPOSABLE_ANDROID_VERIFICATION_VARIANT;
}
