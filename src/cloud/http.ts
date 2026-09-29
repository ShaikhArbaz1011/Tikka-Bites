/**
 * Talking to Supabase with plain fetch (no supabase-js: keeps the app small).
 *  - /auth/v1/…  sign-in (GoTrue)
 *  - /rest/v1/…  tables and SQL functions (PostgREST)
 * Every failure becomes a CloudError whose message is safe to show to staff.
 */
import { cloudConfig } from './config';
import { CloudError, OFFLINE_MESSAGE, SIGNED_OUT_MESSAGE } from './errors';

export const DEFAULT_TIMEOUT_MS = 12_000;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /** Signed-in access token; without it the public (anon) key is used. */
  token?: string;
  /** PostgREST Prefer header, e.g. "return=representation". */
  prefer?: string;
  timeoutMs?: number;
}

/** A PostgREST / GoTrue error body (both shapes). */
interface ErrorBody {
  code?: string | number;
  message?: string;
  msg?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { url, anonKey } = cloudConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url + path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${opts.token ?? anonKey}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.prefer ? { Prefer: opts.prefer } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new CloudError(OFFLINE_MESSAGE, 'offline'); // no connection, DNS, CORS or timed out
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (res.ok) return json as T;
  throw toCloudError(res.status, (json ?? {}) as ErrorBody);
}

/** Turn an HTTP error into a CloudError (exported for tests). */
export function toCloudError(status: number, b: ErrorBody): CloudError {
  const code = String(b.code ?? b.error_code ?? '');
  const message = b.message ?? b.msg ?? b.error_description ?? b.error ?? '';
  if (code === '42501' || /not on the Tikka Bites staff list/.test(message)) {
    return new CloudError('This account is not on the Tikka Bites staff list. Ask the owner to add it.', 'not-staff', status);
  }
  if (code === 'P0001' && message) return new CloudError(message, 'rejected', status); // our own checks: message written for people
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303' || /jwt expired/i.test(message)) {
    return new CloudError(SIGNED_OUT_MESSAGE, 'auth', status);
  }
  if (code === 'PGRST202' || code === '42883' || code === 'PGRST205' || code === '42P01') {
    return new CloudError('The shared database needs updating: the owner should run supabase/schema.sql again.', 'setup', status);
  }
  if (status === 0 || status >= 500 || status === 408 || status === 429) {
    return new CloudError('The shared database is busy or unreachable. Please try again in a moment.', status === 429 ? 'server' : 'offline', status);
  }
  return new CloudError(message || `The shared database refused the request (${status}).`, 'server', status);
}

/** Call a SQL function: POST /rest/v1/rpc/<name> with named arguments. */
export function rpc<T>(name: string, args: Record<string, unknown>, token?: string, timeoutMs?: number): Promise<T> {
  return request<T>(`/rest/v1/rpc/${name}`, { body: args, token, timeoutMs });
}
