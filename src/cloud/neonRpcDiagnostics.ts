export type NeonRpcErrorBody = {
  code: string | null;
  message: string | null;
  details: string | null;
  hint: string | null;
};

export type NeonRpcDiagnostic = {
  status: number;
  apiCode: string | null;
  message: string | null;
  details: string | null;
  hint: string | null;
  method: string;
  endpoint: string;
  rpc: string;
  request: {
    contentType: string | null;
    authorizationPresent: boolean;
    idempotencyKeyPresent: boolean;
    operation: string | null;
    bodyKeys: string[];
  };
};

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function safeText(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, 500)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

/** Parse Neon/PostgREST JSON or plain-text errors without ever retaining the full body. */
export function parseNeonRpcErrorBody(text: string): NeonRpcErrorBody {
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) as unknown : null; } catch { parsed = null; }
  const outer = isObject(parsed) ? parsed : {};
  const nested = isObject(outer.error) ? outer.error : {};
  const pick = (key: keyof NeonRpcErrorBody): unknown => outer[key] ?? nested[key];
  const code = safeText(pick('code'));
  return {
    code: code && /^[A-Z0-9_-]{1,40}$/.test(code) ? code : null,
    message: safeText(pick('message')) ?? (!parsed ? safeText(text) : null),
    details: safeText(pick('details')),
    hint: safeText(pick('hint')),
  };
}

function requestBodyMetadata(body: string | undefined): { operation: string | null; bodyKeys: string[] } {
  if (!body) return { operation: null, bodyKeys: [] };
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isObject(parsed)) return { operation: null, bodyKeys: [] };
    const bodyKeys = Object.keys(parsed).filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).sort().slice(0, 24);
    const operation = typeof parsed.p_operation === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(parsed.p_operation)
      ? parsed.p_operation : null;
    return { operation, bodyKeys };
  } catch { return { operation: null, bodyKeys: [] }; }
}

/** Diagnostic fields are limited to safe protocol metadata; payload values and credential values are excluded. */
export function buildNeonRpcDiagnostic(input: {
  status: number;
  error: NeonRpcErrorBody;
  method: string;
  endpoint: string;
  rpc: string;
  contentType: string | null;
  authorizationPresent: boolean;
  idempotencyKeyPresent: boolean;
  body?: string;
}): NeonRpcDiagnostic {
  let endpoint = '[invalid endpoint]';
  try {
    const url = new URL(input.endpoint);
    endpoint = `${url.origin}${url.pathname}`;
  } catch { /* Keep the constant invalid marker. */ }
  const metadata = requestBodyMetadata(input.body);
  return {
    status: input.status,
    apiCode: input.error.code,
    message: input.error.message,
    details: input.error.details,
    hint: input.error.hint,
    method: input.method.toUpperCase().slice(0, 8),
    endpoint,
    rpc: /^[a-z][a-z0-9_]{0,62}$/.test(input.rpc) ? input.rpc : '[invalid rpc]',
    request: {
      contentType: input.contentType?.split(';', 1)[0]?.slice(0, 80) ?? null,
      authorizationPresent: input.authorizationPresent,
      idempotencyKeyPresent: input.idempotencyKeyPresent,
      ...metadata,
    },
  };
}

/** Build one PostgREST-style RPC URL, preserving the configured database base path exactly once. */
export function buildNeonRpcUrl(baseUrl: string, rpc: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(rpc)) throw new Error('Invalid Neon RPC name.');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Neon Data API URL.');
  const basePath = url.pathname.replace(/\/+$/, '');
  if (!basePath.endsWith('/rest/v1')) throw new Error('Invalid Neon Data API base path.');
  url.pathname = `${basePath}/rpc/${rpc}`;
  return url.toString();
}

export function withPublicNeonRpcProfile(headers: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set('Content-Profile', 'public');
  return result;
}
