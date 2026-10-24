/** Turns native database failures into useful, non-destructive sign-in guidance. */
export function getLocalAuthFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : '';

  if (detail.includes('SQLCipher is unavailable in this native app build')) {
    return 'This Android app build is missing encrypted database support. Your records were not reset. Install a corrected build before retrying.';
  }
  if (detail.includes('The local database key is missing') || detail.includes('The local database key is invalid')) {
    return 'The key for this device’s encrypted database is unavailable. Do not uninstall or clear app data; restore from a verified backup or contact support.';
  }
  if (detail.includes('Local database could not be safely opened:')) {
    return `Mizan could not open its local database: ${detail.slice(detail.indexOf(':') + 1).trim()} Your records were not deliberately cleared.`;
  }
  if (detail) {
    return `Mizan could not complete sign-in because local storage failed (${detail}). Your records were not deliberately cleared.`;
  }
  return 'Mizan could not access its local profile database. Your records were not deliberately cleared; keep the app installed and try again.';
}

export const LOCAL_PROFILE_NOT_FOUND_MESSAGE =
  'No profile for this email is stored on this device. Mizan keeps browser and Android profiles separate; create a profile here or restore a verified Android backup.';
