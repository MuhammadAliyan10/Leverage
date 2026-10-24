/** Resolve a public API origin without treating documentation placeholders as live services. */
export function resolveCloudApiBaseUrl(value: string | undefined, development: boolean): string | null {
  const configured = value?.trim();
  if (!configured) return null;

  let url: URL;
  try { url = new URL(configured); }
  catch { return null; }

  if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) return null;
  const host = url.hostname.toLowerCase();
  const reservedHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.invalid') ||
    host.endsWith('.example') || host.endsWith('.test') ||
    ['example.com', 'example.org', 'example.net'].some((reserved) => host === reserved || host.endsWith(`.${reserved}`));
  if (url.protocol === 'https:' && !reservedHost) return url.origin;
  if (development && url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')) return url.origin;
  return null;
}

function resolveNeonEndpoint(value: string | undefined, expectedPath: string): string | null {
  const configured = value?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (!url.hostname.endsWith('.aws.neon.tech') || url.pathname.replace(/\/$/, '') !== expectedPath) return null;
    return `${url.origin}${expectedPath}`;
  } catch { return null; }
}

export function resolveNeonAuthUrl(value: string | undefined): string | null {
  return resolveNeonEndpoint(value, '/neondb/auth');
}

export function resolveNeonDataApiUrl(value: string | undefined): string | null {
  return resolveNeonEndpoint(value, '/neondb/rest/v1');
}

/** Stop production EAS builds before bundling if cloud auth/sync would be compiled disabled. */
export function assertProductionCloudApiConfigured(profile: string | undefined, value: string | undefined): void {
  if (profile !== 'production' && profile !== 'production-apk') return;
  if (!resolveCloudApiBaseUrl(value, false)) {
    throw new Error('Production Android builds require EXPO_PUBLIC_MIZAN_API_URL to be a real HTTPS API origin. Configure it in the EAS production environment before building.');
  }
}

export function assertProductionNeonConfigured(profile: string | undefined, authUrl: string | undefined, dataApiUrl: string | undefined): void {
  if (profile !== 'production' && profile !== 'production-apk') return;
  if (!resolveNeonAuthUrl(authUrl) || !resolveNeonDataApiUrl(dataApiUrl)) {
    throw new Error('Production builds require valid EXPO_PUBLIC_NEON_AUTH_URL and EXPO_PUBLIC_NEON_DATA_API_URL endpoints.');
  }
}
