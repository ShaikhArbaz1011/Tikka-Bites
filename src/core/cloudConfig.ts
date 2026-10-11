/**
 * Shared-database settings, checked at BUILD time by vite.config.ts.
 * Pure (no Node or browser APIs beyond URL/atob) so it can be unit tested.
 *
 * backend ""         → Supabase if its two values are filled, else local-only mode
 *                      (every phone keeps its own data, the original design).
 * backend "supabase" → every phone signs in and uses one Supabase database.
 * backend "sheets"   → every phone signs in and uses the owner's Google Sheets through
 *                      the Apps Script web app at sheetsUrl (google-sheets/README.md).
 */
export type CloudBackend = '' | 'supabase' | 'sheets';

export interface CloudConfig {
  backend: CloudBackend;
  /** Supabase: origin only, e.g. https://abcd1234.supabase.co. Google Sheets: the web app address (…/exec). */
  url: string;
  /** Supabase only: the anon / publishable key (public by design; RLS protects the data). */
  anonKey: string;
}

export const NO_CLOUD: CloudConfig = { backend: '', url: '', anonKey: '' };

/** Google's address for the web app; the answer itself comes from script.googleusercontent.com. */
export const GOOGLE_SCRIPT_ORIGIN = 'https://script.google.com';
const GOOGLE_CONTENT_ORIGIN = 'https://script.googleusercontent.com';

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

/** The Apps Script web app address (Deploy → Manage deployments → Web app URL). */
function sheetsConfig(raw: string): CloudConfig {
  const hint = 'sheetsUrl must be the web app address from Apps Script (Deploy → Manage deployments), like https://script.google.com/macros/s/…/exec.';
  if (!raw) throw new CloudConfigError(`cloud.config.json: backend is "sheets" but sheetsUrl is empty. ${hint}`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CloudConfigError(`cloud.config.json: ${hint}`);
  }
  const google = u.protocol === 'https:' && u.origin === GOOGLE_SCRIPT_ORIGIN;
  const local = (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (u.protocol === 'http:' || u.protocol === 'https:'); // local tests
  const path = /^\/(?:a\/macros\/[A-Za-z0-9.-]+\/s|macros\/s)\/[A-Za-z0-9_-]{10,200}\/exec$/.test(u.pathname);
  if (!(google || local) || !path || u.search || u.hash || u.username || u.password) throw new CloudConfigError(`cloud.config.json: ${hint}`);
  return { backend: 'sheets', url: u.origin + u.pathname, anonKey: '' };
}

/**
 * @param file  parsed cloud.config.json ({ backend, sheetsUrl, supabaseUrl, supabaseAnonKey })
 * @param env   VITE_CLOUD_BACKEND / VITE_SHEETS_URL / VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY,
 *              which win over the file (so Netlify/Vercel can set them in their dashboards).
 */
export function resolveCloudConfig(
  file: unknown,
  env: { backend?: string | undefined; sheetsUrl?: string | undefined; url?: string | undefined; anonKey?: string | undefined } = {},
): CloudConfig {
  const f = (file && typeof file === 'object' ? file : {}) as Record<string, unknown>;
  const pick = (envValue: string | undefined, fileValue: unknown) => (envValue ?? (typeof fileValue === 'string' ? fileValue : '')).trim();
  const backend = pick(env.backend, f['backend']);
  const rawUrl = pick(env.url, f['supabaseUrl']);
  const anonKey = pick(env.anonKey, f['supabaseAnonKey']);
  // The secret key bypasses every security rule. It must never ship to browsers, whichever backend is used.
  if (anonKey.startsWith('sb_secret_') || jwtPayload(anonKey)?.['role'] === 'service_role') {
    throw new CloudConfigError('cloud.config.json: that is the SECRET (service_role) key. Use the anon / publishable key instead, and keep the secret key private.');
  }
  if (backend === 'sheets') return sheetsConfig(pick(env.sheetsUrl, f['sheetsUrl']));
  if (backend !== '' && backend !== 'supabase') throw new CloudConfigError('cloud.config.json: backend must be "sheets", "supabase", or "" (empty).');
  if (!rawUrl && !anonKey) {
    if (backend === 'supabase') throw new CloudConfigError('cloud.config.json: backend is "supabase": fill in BOTH supabaseUrl and supabaseAnonKey.');
    return NO_CLOUD;
  }
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
  return { backend: 'supabase', url: u.origin, anonKey };
}

/** The Content-Security-Policy connect-src for a config: the page may talk only to itself and this one database. */
export function connectSrc(c: CloudConfig): string {
  if (!c.url) return "'self'";
  const origin = new URL(c.url).origin;
  // Google answers a web app request with a redirect to script.googleusercontent.com.
  return c.backend === 'sheets' && origin === GOOGLE_SCRIPT_ORIGIN ? `'self' ${origin} ${GOOGLE_CONTENT_ORIGIN}` : `'self' ${origin}`;
}
