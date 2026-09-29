/**
 * Sign-in with a User ID and password (Supabase Auth, email + password underneath).
 * The User ID is turned into the account email by public.login_email(); typing the
 * email itself also works. The session is kept in this phone's IndexedDB and the
 * access token is refreshed automatically (one refresh at a time).
 */
import { request, rpc } from './http';
import { CloudError, SIGNED_OUT_MESSAGE } from './errors';
import { getMeta, setMeta, deleteMeta } from '../db/settingsRepo';
import type { CloudSession } from '../db/types';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id: string; email?: string };
}

const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{1,29}$/;
/** Refresh this long before the token runs out. */
const REFRESH_EARLY_MS = 60_000;

let session: CloudSession | null | undefined; // undefined = not loaded yet
let refreshing: Promise<CloudSession> | null = null;
const listeners = new Set<(s: CloudSession | null) => void>();

export function onSessionChange(fn: (s: CloudSession | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function store(s: CloudSession | null): Promise<void> {
  session = s;
  if (s) await setMeta('session', s);
  else await deleteMeta('session');
  for (const fn of listeners) fn(s);
}

export async function loadSession(): Promise<CloudSession | null> {
  if (session === undefined) session = (await getMeta('session')) ?? null;
  return session;
}

export function currentSession(): CloudSession | null {
  return session ?? null;
}

function toSession(t: TokenResponse, username: string, now: number): CloudSession {
  if (!t.access_token || !t.refresh_token || !t.user?.id) throw new CloudError('Unexpected reply from the sign-in service.', 'server');
  const expiresAt = t.expires_at ? t.expires_at * 1000 : now + (t.expires_in ?? 3600) * 1000;
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt, userId: t.user.id, email: t.user.email ?? '', username };
}

/** Resolve what was typed (User ID or email) to the account email. */
export async function emailFor(login: string): Promise<string> {
  const typed = login.trim().toLowerCase();
  if (typed.includes('@')) return typed;
  if (!USER_ID_RE.test(typed)) throw new CloudError('Wrong User ID or password.', 'auth');
  const email = await rpc<string | null>('login_email', { p_username: typed });
  if (!email) throw new CloudError('Wrong User ID or password.', 'auth');
  return email;
}

export async function signIn(login: string, password: string, now = Date.now()): Promise<CloudSession> {
  if (!login.trim() || !password) throw new CloudError('Enter your User ID and password.', 'auth');
  const email = await emailFor(login);
  let t: TokenResponse;
  try {
    t = await request<TokenResponse>('/auth/v1/token?grant_type=password', { body: { email, password } });
  } catch (e) {
    if (!(e instanceof CloudError) || e.kind === 'offline') throw e;
    // Only a refused password says "wrong"; other refusals say what to do.
    if (e.status === 429) throw new CloudError('Too many sign-in tries. Wait a few minutes and try again.', 'auth', 429);
    if (/email not confirmed/i.test(e.message)) {
      throw new CloudError('This account is not confirmed yet. The owner should confirm it in Supabase (Authentication → Users).', 'auth', e.status);
    }
    throw new CloudError('Wrong User ID or password.', 'auth', e.status);
  }
  const s = toSession(t, login.trim().toLowerCase(), now);
  await store(s);
  return s;
}

/** A valid access token, refreshed if it is about to run out. Throws CloudError('auth') if signed out. */
export async function accessToken(now = Date.now()): Promise<string> {
  const s = await loadSession();
  if (!s) throw new CloudError(SIGNED_OUT_MESSAGE, 'auth');
  if (s.expiresAt - REFRESH_EARLY_MS > now) return s.accessToken;
  return (await refresh(now)).accessToken;
}

/** Get a new access token with the refresh token. Concurrent callers share one request. */
export function refresh(now = Date.now()): Promise<CloudSession> {
  refreshing ??= (async () => {
    try {
      const s = await loadSession();
      if (!s) throw new CloudError(SIGNED_OUT_MESSAGE, 'auth');
      let t: TokenResponse;
      try {
        t = await request<TokenResponse>('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } });
      } catch (e) {
        // A refused refresh token means the sign-in is over (password changed, removed, or expired).
        if (e instanceof CloudError && e.kind !== 'offline') {
          await store(null);
          throw new CloudError(SIGNED_OUT_MESSAGE, 'auth', e.status);
        }
        throw e;
      }
      const next = toSession(t, s.username, now);
      await store(next);
      return next;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function signOut(): Promise<void> {
  const s = await loadSession();
  if (s) {
    // Best effort: tell the server; signed out on this phone either way.
    await request('/auth/v1/logout', { method: 'POST', token: s.accessToken, timeoutMs: 4000 }).catch(() => undefined);
  }
  await store(null);
}

/** Tests only. */
export function resetAuthForTests(): void {
  session = undefined;
  refreshing = null;
  listeners.clear();
}
