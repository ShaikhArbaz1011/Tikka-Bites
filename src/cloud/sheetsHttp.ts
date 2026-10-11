/**
 * Talking to the Google Sheet (the Apps Script web app in google-sheets/Code.gs) with
 * plain fetch. One POST per call: the body is JSON { fn, args, token } sent as plain
 * text with NO custom headers, so the browser makes no CORS pre-check (Apps Script
 * can't answer one). Google replies with a redirect to script.googleusercontent.com,
 * which fetch follows. Every failure becomes a CloudError whose message is safe to show.
 */
import { cloudConfig } from './config';
import { CloudError, OFFLINE_MESSAGE, type CloudErrorKind } from './errors';

const KINDS: readonly CloudErrorKind[] = ['auth', 'not-staff', 'rejected', 'setup', 'server'];
const BUSY = 'The Google Sheet is busy or unreachable. Please try again in a moment.';
/** Longer than the script waits for its lock (25 s), so a slow answer is not mistaken for no answer. */
export const SHEETS_TIMEOUT_MS = 30_000;

interface Reply {
  ok?: boolean;
  data?: unknown;
  error?: { kind?: string; message?: string };
}

export async function call<T>(fn: string, args: Record<string, unknown>, token?: string, timeoutMs = SHEETS_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(cloudConfig().url, {
      method: 'POST',
      body: JSON.stringify(token ? { fn, args, token } : { fn, args }), // a string body is sent as text/plain
      redirect: 'follow',
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
  if (!res.ok) throw new CloudError(BUSY, res.status === 429 ? 'server' : 'offline', res.status);
  let reply: Reply;
  try {
    reply = JSON.parse(text) as Reply;
  } catch {
    // Google's own error page (quota, a script error before doPost ran, a wrong deployment).
    throw new CloudError(BUSY, 'server', res.status);
  }
  return fromReply<T>(reply, res.status);
}

/** Turn the script's answer into the data or a CloudError (exported for tests). */
export function fromReply<T>(reply: Reply, status = 200): T {
  if (reply && reply.ok === true) return reply.data as T;
  const e = reply?.error ?? {};
  const kind = KINDS.includes(e.kind as CloudErrorKind) ? (e.kind as CloudErrorKind) : 'server';
  throw new CloudError(typeof e.message === 'string' && e.message ? e.message : BUSY, kind, status);
}
