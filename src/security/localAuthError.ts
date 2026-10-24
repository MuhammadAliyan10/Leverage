/** Turns native database failures into useful, non-destructive auth guidance. */
export function getLocalAuthFailureMessage(error: unknown, operation: 'sign-in' | 'sign-up' = 'sign-in'): string {
  const detail = error instanceof Error ? error.message : '';

  if (detail.includes('SQLCipher is unavailable in this native app build')) {
    return 'This Android app build is missing encrypted database support. Your records were not reset. Install a corrected build before retrying.';
  }
  if (detail.includes('The local database key is missing') || detail.includes('The local database key is invalid')) {
    return 'The key for this device’s encrypted database is unavailable. Do not uninstall or clear app data; restore from a verified backup or contact support.';
  }
  if (detail.includes('Local database could not be safely opened:')) {
    return `Leverage could not open its local database: ${detail.slice(detail.indexOf(':') + 1).trim()} Your records were not deliberately cleared.`;
  }
  if (detail) {
    return `Leverage could not complete ${operation} because local storage failed (${detail}). Your records were not deliberately cleared.`;
  }
  return `Leverage could not access its local profile database during ${operation}. Your records were not deliberately cleared; keep the app installed and try again.`;
}

export const LOCAL_PROFILE_NOT_FOUND_MESSAGE =
  'No profile for this email is stored on this device. Leverage keeps browser and Android profiles separate; create a profile here or restore a verified Android backup.';
