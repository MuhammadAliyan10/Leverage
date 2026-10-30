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

/** Native requests use the configured auth service origin when the platform has no browser origin. */
export function resolveNativeAuthRequestOrigin(value: string | undefined): string | null {
  const endpoint = resolveNeonAuthUrl(value);
  return endpoint ? new URL(endpoint).origin : null;
}

/** Supplies the trusted auth-service origin only for native requests with no usable origin. */
export function withNativeAuthRequestOrigin(headers: Headers, isNative: boolean, authOrigin: string | null): Headers {
  const result = new Headers(headers);
  const origin = result.get('origin');
  if (isNative && authOrigin && (!origin || origin === 'null')) result.set('Origin', authOrigin);
  return result;
}

export function resolveNeonDataApiUrl(value: string | undefined): string | null {
  return resolveNeonEndpoint(value, '/neondb/rest/v1');
}

/** Map Neon/Postgres failures to safe, actionable categories without displaying SQL details. */
export function classifyNeonDataApiFailure(status: number, body: unknown): string {
  const error = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = error.error && typeof error.error === 'object' ? error.error as Record<string, unknown> : {};
  const code = typeof error.code === 'string' ? error.code : typeof nested.code === 'string' ? nested.code : '';
  const message = (typeof error.message === 'string' ? error.message : typeof nested.message === 'string' ? nested.message : '').toLowerCase();
  if (code.startsWith('UNSUPPORTED_')) return code;
  if (code === 'PGRST202') return 'CLOUD_RPC_SIGNATURE_MISSING';
  // 42883 covers both undefined functions and undefined operators. Neon can
  // return it with HTTP 404 even after the RPC function was successfully found.
  if (code === '42883' && message.includes('operator does not exist')) return 'CLOUD_SCHEMA_TYPE_MISMATCH';
  if (code === '42883' && message.includes('function')) return 'CLOUD_FUNCTION_UNDEFINED';
  if (status === 401 || code === '28000' || message.includes('authentication credentials')) return 'AUTH_REQUIRED';
  if (status === 403 || code === '42501') return 'CLOUD_PERMISSION_DENIED';
  // A unique-constraint violation is not necessarily an idempotency conflict.
  // The finance RPC also raises 23505 when an entity ID is already present,
  // which is materially different: compare that cloud row before treating the
  // queued create as confirmed.
  if (message.includes('idempotency key reused')) return 'DUPLICATE_OR_IDEMPOTENCY_CONFLICT';
  if (code === '23505' || (status === 409 && message.includes('duplicate key'))) return 'CLOUD_RECORD_ALREADY_EXISTS';
  if (status === 409) return 'CLOUD_RECORD_CONFLICT';
  if (code === '23503' || message.includes('foreign key')) return 'RELATED_RECORD_MISSING';
  if (code === '23514' || message.includes('check constraint') || message.includes('financial rule')) return 'FINANCIAL_RULE_REJECTED';
  if (code === '22023' || code.startsWith('22') || message.includes('invalid account') || message.includes('invalid transaction') || message.includes('unsupported transaction classification')) return 'INVALID_FINANCIAL_RECORD';
  if (code === '40001' || message.includes('revision conflict')) return 'FINANCIAL_RECORD_CONFLICT';
  if (message.includes('schema cache') || message.includes('could not find the function')) return 'CLOUD_FUNCTION_MISSING';
  if (status === 408 || status === 429 || status >= 500) return 'DATABASE_UNAVAILABLE';
  if (status === 404) return 'CLOUD_ENDPOINT_NOT_FOUND';
  if (status === 400) return 'NEON_REQUEST_REJECTED';
  return 'SERVER_REJECTED';
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
