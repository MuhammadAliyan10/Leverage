type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Extract only a JWT-shaped Neon Data API token; reject opaque session cookie IDs. */
export function readNeonAccessToken(response: unknown): string | null {
  if (!isRecord(response)) return null;
  const data = isRecord(response.data) ? response.data : response;
  const session = isRecord(data.session) ? data.session : null;
  const candidates = [data.token, data.access_token, session?.access_token, session?.token];
  return candidates.find((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.trim().split('.').length === 3,
  )?.trim() ?? null;
}

/** Return claim-presence metadata only; never expose token or claim values in logs. */
export function inspectNeonJwt(token: string): {
  jwtShapeValid: boolean;
  hasSubject: boolean;
  hasRole: boolean;
  hasAuthenticatedRole: boolean;
  hasExpiry: boolean;
  expired: boolean;
} {
  const invalid = { jwtShapeValid: false, hasSubject: false, hasRole: false, hasAuthenticatedRole: false, hasExpiry: false, expired: false };
  const parts = token.split('.');
  if (parts.length !== 3) return invalid;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = typeof atob === 'function' ? atob(payload) : '';
    const claims: unknown = JSON.parse(decoded);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return invalid;
    const record = claims as Record<string, unknown>;
    const exp = record.exp;
    return {
      jwtShapeValid: true,
      hasSubject: typeof record.sub === 'string' && record.sub.length > 0,
      hasRole: typeof record.role === 'string' && record.role.length > 0,
      hasAuthenticatedRole: record.role === 'authenticated',
      hasExpiry: typeof exp === 'number' && Number.isFinite(exp),
      expired: typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 <= Date.now(),
    };
  } catch {
    return invalid;
  }
}
