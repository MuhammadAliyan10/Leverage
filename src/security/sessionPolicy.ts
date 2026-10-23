export type RestoredSessionDecision = 'signedOut' | 'signedIn' | 'locked';

/** A remembered local session stays signed in until the user signs out or the profile is removed. */
export function decideRestoredSession(input: {
  savedUserId: string | null;
  signedOutMarker: boolean;
  profileExists: boolean;
  appLockEnabled?: boolean;
  coldStartLockRequired?: boolean;
}): RestoredSessionDecision {
  if (input.signedOutMarker || !input.savedUserId || !input.profileExists) return 'signedOut';
  return input.appLockEnabled && (input.coldStartLockRequired ?? true) ? 'locked' : 'signedIn';
}

export function canReadProtectedData(status: 'restoring' | 'signedOut' | 'locked' | 'signedIn'): boolean {
  return status === 'signedIn';
}
