/**
 * Shared-database (Supabase) settings, checked at BUILD time by vite.config.ts.
 * Pure (no Node or browser APIs beyond URL/atob) so it can be unit tested.
 *
 * Both empty  → local-only mode: every phone keeps its own data (the original design).
 * Both filled → shared mode: every phone signs in and uses one database.
 */
export interface CloudConfig {
  /** Origin only, e.g. https://abcd1234.supabase.co (no trailing slash). */
  url: string;
  /** The anon / publishable key (public by design; RLS protects the data). */
  anonKey: string;
}

export const NO_CLOUD: CloudConfig = { url: '', anonKey: '' };

export class CloudConfigError extends Error {}

/** Payload of a JWT-style key (legacy Supabase keys are JWTs), or null if it is not one. */
function jwtPayload(key: string): Record<string, unknown> | null {
  const part = key.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * @param file  parsed cloud.config.json ({ supabaseUrl, supabaseAnonKey })
 * @param env   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, which win over the file
 *              (so Netlify/Vercel can set them in their dashboards).
 */
export function resolveCloudConfig(file: unknown, env: { url?: string | undefined; anonKey?: string | undefined } = {}): CloudConfig {
  const f = (file && typeof file === 'object' ? file : {}) as Record<string, unknown>;
  const pick = (envValue: string | undefined, fileValue: unknown) => (envValue ?? (typeof fileValue === 'string' ? fileValue : '')).trim();
  const rawUrl = pick(env.url, f['supabaseUrl']);
  const anonKey = pick(env.anonKey, f['supabaseAnonKey']);
  if (!rawUrl && !anonKey) return NO_CLOUD;
  if (!rawUrl || !anonKey) throw new CloudConfigError('cloud.config.json: fill in BOTH supabaseUrl and supabaseAnonKey, or leave both empty.');

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new CloudConfigError(`cloud.config.json: supabaseUrl "${rawUrl}" is not a web address.`);
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  const plainOrigin = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && !u.username && !u.password;
  if (!(u.protocol === 'https:' || (local && u.protocol === 'http:')) || !plainOrigin) {
    throw new CloudConfigError('cloud.config.json: supabaseUrl must look like https://your-project.supabase.co (https, nothing after .co).');
  }

  if (!/^[A-Za-z0-9._-]{20,2048}$/.test(anonKey)) throw new CloudConfigError('cloud.config.json: supabaseAnonKey does not look like a Supabase key.');
  // The secret key bypasses every security rule. It must never ship to browsers.
  if (anonKey.startsWith('sb_secret_') || jwtPayload(anonKey)?.['role'] === 'service_role') {
    throw new CloudConfigError('cloud.config.json: that is the SECRET (service_role) key. Use the anon / publishable key instead, and keep the secret key private.');
  }
  return { url: u.origin, anonKey };
}

/** The Content-Security-Policy connect-src for a config: the page may talk only to itself and this one database. */
export function connectSrc(c: CloudConfig): string {
  return c.url ? `'self' ${c.url}` : "'self'";
}
