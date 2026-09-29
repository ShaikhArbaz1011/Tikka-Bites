/**
 * Tikka Bites · staff-admin (Supabase Edge Function)
 *
 * Lets the super admin add a user, change a password or remove a user from the app
 * (Settings → Users). Creating and deleting sign-in accounts needs the project's
 * secret key, which must never be in the app, so that part happens here, on Supabase.
 *
 * Who may do it is decided by the database, as the person calling: the first call is
 * always staff_add_prepare / staff_user_id / staff_remove, which refuse anyone who is
 * not the super admin. Nothing is changed before that check passes.
 *
 * Deploy (see supabase/README.md): Edge Functions → Deploy a new function → Via Editor,
 * name it "staff-admin", paste this whole file, Deploy. Then turn OFF "Verify JWT"
 * in its settings (the database checks the sign-in instead).
 *
 * Request: POST { action: 'add' | 'reset' | 'remove', username, password? }
 * with the app's usual apikey + Authorization (the signed-in user's token).
 */

export interface Env {
  get(name: string): string | undefined;
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{1,29}$/;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
/** A refusal the app shows word for word (same shape as the database's own P0001 errors). */
const refuse = (message: string) => reply(400, { code: 'P0001', message });

/** Same rule as the app (src/core/validate.ts#newPassword). */
export function passwordProblem(p: string): string | null {
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (new TextEncoder().encode(p).length > 72) return 'Password must be at most 72 characters';
  if (p.trim() !== p) return 'Password cannot start or end with a space';
  return null;
}

/** The project's secret key: the new kind (SUPABASE_SECRET_KEYS), else the legacy service role key. */
export function secretKey(env: Env): string {
  const keys = env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      const key = parsed['default'] ?? Object.values(parsed)[0];
      if (key) return key;
    } catch {
      // fall back to the legacy key
    }
  }
  return env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

class UpstreamError extends Error {
  status: number;
  body: Record<string, unknown>;
  fromDb: boolean;
  constructor(status: number, body: Record<string, unknown>, fromDb: boolean) {
    super(String(body['message'] ?? body['msg'] ?? status));
    this.status = status;
    this.body = body;
    this.fromDb = fromDb;
  }
}

async function call(fetchFn: Fetch, url: string, method: string, headers: Record<string, string>, fromDb: boolean, body?: unknown): Promise<unknown> {
  const res = await fetchFn(url, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text.slice(0, 200) };
  }
  if (!res.ok) throw new UpstreamError(res.status, (json ?? {}) as Record<string, unknown>, fromDb);
  return json;
}

export async function handle(req: Request, env: Env, fetchFn: Fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return reply(405, { message: 'Use POST' });
  const base = (env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  const admin = secretKey(env);
  if (!base || !admin) return reply(500, { message: 'The user manager is not set up on the server.' });
  const authorization = req.headers.get('authorization') ?? '';
  const apikey = req.headers.get('apikey') ?? '';
  if (!/^Bearer \S+$/.test(authorization) || !apikey) return reply(401, { code: 'PGRST301', message: 'Please sign in again.' });

  let input: Record<string, unknown>;
  try {
    input = (await req.json()) as Record<string, unknown>;
  } catch {
    return refuse('Send the request as JSON');
  }
  const action = input['action'];
  const username = typeof input['username'] === 'string' ? input['username'].trim().toLowerCase() : '';
  const password = typeof input['password'] === 'string' ? input['password'] : '';
  if (action !== 'add' && action !== 'reset' && action !== 'remove') return refuse('Unknown action');
  if (!USER_ID_RE.test(username)) return refuse('User ID must be 2–30 characters: small letters, numbers, dot, dash or underscore (e.g. counter2)');
  if (action !== 'remove') {
    const bad = passwordProblem(password);
    if (bad) return refuse(bad);
  }

  // As the caller: the database decides whether they are the super admin.
  const asCaller = (fn: string, args: Record<string, unknown>) =>
    call(fetchFn, `${base}/rest/v1/rpc/${fn}`, 'POST', { apikey, Authorization: authorization }, true, args);
  // With the secret key: Supabase Auth's admin API (sign-in accounts).
  const asAdmin = (method: string, id: string, body?: Record<string, unknown>) =>
    call(fetchFn, `${base}/auth/v1/admin/users${id ? `/${encodeURIComponent(id)}` : ''}`, method, { apikey: admin, Authorization: `Bearer ${admin}` }, false, body);

  try {
    if (action === 'add') {
      const prep = (await asCaller('staff_add_prepare', { p_username: username })) as { email: string; userId: string | null };
      let id = prep.userId;
      let created = false;
      if (id) {
        await asAdmin('PUT', id, { password, email_confirm: true }); // an old account for this User ID: reuse it
      } else {
        const user = (await asAdmin('POST', '', { email: prep.email, password, email_confirm: true })) as { id?: string };
        if (!user?.id) return reply(502, { message: 'Supabase did not return the new account.' });
        id = user.id;
        created = true;
      }
      try {
        await asCaller('staff_add_finish', { p_user_id: id, p_username: username });
      } catch (e) {
        if (created) await asAdmin('DELETE', id).catch(() => undefined); // don't leave an account behind
        throw e;
      }
      return reply(200, { ok: true, username });
    }
    if (action === 'reset') {
      const id = (await asCaller('staff_user_id', { p_username: username })) as string;
      await asAdmin('PUT', id, { password });
      return reply(200, { ok: true, username });
    }
    // remove: off the staff list first (access ends at once), then delete the sign-in account.
    const id = (await asCaller('staff_remove', { p_username: username })) as string;
    const accountDeleted = await asAdmin('DELETE', id).then(
      () => true,
      () => false, // still removed: without the staff list the account can do nothing
    );
    return reply(200, { ok: true, username, accountDeleted });
  } catch (e) {
    if (e instanceof UpstreamError && e.fromDb) {
      // The database's own answer (not super admin, User ID taken, signed out…): pass it on.
      const { code, message } = e.body;
      return reply(e.status, { code, message });
    }
    if (e instanceof UpstreamError) {
      const code = String(e.body['error_code'] ?? '');
      const msg = String(e.body['msg'] ?? e.body['message'] ?? '');
      if (code === 'weak_password' || /password/i.test(msg)) return refuse(`Supabase did not accept this password: ${msg}`);
      if (code === 'email_exists') return refuse('An account for this User ID already exists. Try again.');
      return refuse(`Supabase refused to change the account (${e.status}${code ? ` ${code}` : ''}).`);
    }
    return reply(502, { message: 'Could not reach Supabase. Please try again.' });
  }
}

// On Supabase (Deno): serve requests. Tests and scripts/fake-supabase.mjs import handle() instead.
const deno = (globalThis as { Deno?: { serve(h: (req: Request) => Promise<Response>): void; env: Env } }).Deno;
if (deno) deno.serve((req) => handle(req, deno.env));
