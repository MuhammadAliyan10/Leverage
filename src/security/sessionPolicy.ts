export type RestoredSessionDecision = 'signedOut' | 'signedIn' | 'locked';
export const APP_LOCK_INACTIVITY_MS = 15 * 60_000;

/** A remembered local session stays signed in until the user signs out or the profile is removed. */
export function decideRestoredSession(input: {
  savedUserId: string | null;
  signedOutMarker: boolean;
  profileExists: boolean;
  appLockEnabled?: boolean;
  lastBackgroundAt?: number | null;
  now?: number;
  inactivityThresholdMs?: number;
}): RestoredSessionDecision {
  if (input.signedOutMarker || !input.savedUserId || !input.profileExists) return 'signedOut';
  const inactivity = input.lastBackgroundAt == null ? 0 : (input.now ?? Date.now()) - input.lastBackgroundAt;
  return input.appLockEnabled && inactivity >= (input.inactivityThresholdMs ?? APP_LOCK_INACTIVITY_MS) ? 'locked' : 'signedIn';
}

export function canReadProtectedData(status: 'restoring' | 'signedOut' | 'locked' | 'signedIn'): boolean {
  return status === 'signedIn';
}
