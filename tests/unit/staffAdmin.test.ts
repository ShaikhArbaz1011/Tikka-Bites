/**
 * supabase/functions/staff-admin: the super admin adds users, changes passwords and
 * removes users. The secret key is only ever used AFTER the database (as the caller)
 * agreed the caller is the super admin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handle, passwordProblem, secretKey } from '../../supabase/functions/staff-admin/index';
import { newPassword, userId } from '../../src/core/validate';

const BASE = 'https://demo.supabase.co';
const SECRET = 'sb_secret_test_0000';
const env = (vars: Record<string, string> = {}) => ({ get: (n: string) => ({ SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), ...vars })[n] });

type Answer = { status?: number; json?: unknown };
let calls: { method: string; path: string; body: any; apikey: string; auth: string }[];
let answers: Record<string, Answer | ((body: any) => Answer)>;

const fakeFetch = async (url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  const headers = init.headers as Record<string, string>;
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ method, path: u.pathname, body, apikey: headers['apikey'] ?? '', auth: headers['Authorization'] ?? '' });
  const a = answers[`${method} ${u.pathname}`] ?? answers[`${method} ${u.pathname.replace(/[0-9a-f-]{36}$/, ':id')}`];
  const r = typeof a === 'function' ? a(body) : a;
  if (!r) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
  return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status ?? 200 });
};

const ID = '66666666-6666-6666-6666-666666666666';
function post(body: unknown, headers: Record<string, string> = { apikey: 'sb_publishable_x', authorization: 'Bearer user-token' }) {
  return new Request(`${BASE}/functions/v1/staff-admin`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const run = async (req: Request, e = env()) => {
  const res = await handle(req, e, fakeFetch);
  return { status: res.status, json: (await res.json().catch(() => null)) as any, headers: res.headers };
};
const adminCalls = () => calls.filter((c) => c.path.startsWith('/auth/v1/admin'));

beforeEach(() => {
  calls = [];
  answers = {
    'POST /rest/v1/rpc/staff_add_prepare': { json: { email: 'owner+cashier3@tikka.test', userId: null } },
    'POST /auth/v1/admin/users': (b) => ({ json: { id: ID, email: b.email } }),
    'POST /rest/v1/rpc/staff_add_finish': { json: 'cashier3' },
    'POST /rest/v1/rpc/staff_user_id': { json: ID },
    'POST /rest/v1/rpc/staff_remove': { json: ID },
    'PUT /auth/v1/admin/users/:id': { json: { id: ID } },
    'DELETE /auth/v1/admin/users/:id': { json: {} },
  };
});

describe('staff-admin server function', () => {
  it('answers the browser pre-flight (CORS) and refuses other methods', async () => {
    const pre = await handle(new Request(`${BASE}/functions/v1/staff-admin`, { method: 'OPTIONS' }), env(), fakeFetch);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('apikey');
    expect((await run(new Request(`${BASE}/x`, { method: 'GET' }))).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('add: the database checks first (as the caller), then the account is made with the secret key', async () => {
    const r = await run(post({ action: 'add', username: ' Cashier3 ', password: 'cashier-pass-1' }));
    expect(r).toMatchObject({ status: 200, json: { ok: true, username: 'cashier3' } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /rest/v1/rpc/staff_add_prepare',
      'POST /auth/v1/admin/users',
      'POST /rest/v1/rpc/staff_add_finish',
    ]);
    expect(calls[0]).toMatchObject({ apikey: 'sb_publishable_x', auth: 'Bearer user-token', body: { p_username: 'cashier3' } }); // as the caller
    expect(calls[1]).toMatchObject({ apikey: SECRET, auth: `Bearer ${SECRET}`, body: { email: 'owner+cashier3@tikka.test', password: 'cashier-pass-1', email_confirm: true } });
    expect(calls[2]).toMatchObject({ auth: 'Bearer user-token', body: { p_user_id: ID, p_username: 'cashier3' } });
  });

  it('not the super admin: the database says no, and no account is touched', async () => {
    answers['POST /rest/v1/rpc/staff_add_prepare'] = { status: 400, json: { code: 'P0001', message: 'Only the super admin can manage users.', hint: null } };
    answers['POST /rest/v1/rpc/staff_remove'] = { status: 403, json: { code: '42501', message: 'This account is not on the Tikka Bites staff list.' } };
    answers['POST /rest/v1/rpc/staff_user_id'] = { status: 401, json: { code: 'PGRST301', message: 'JWT expired' } };
    expect(await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass-1' }))).toMatchObject({
      status: 400,
      json: { code: 'P0001', message: 'Only the super admin can manage users.' },
    });
    expect((await run(post({ action: 'remove', username: 'owner' }))).json).toMatchObject({ code: '42501' });
    expect(await run(post({ action: 'reset', username: 'owner', password: 'new-pass-123' }))).toMatchObject({ status: 401, json: { code: 'PGRST301' } });
    expect(adminCalls()).toEqual([]);
  });

  it('no sign-in, bad input: refused before anything is called', async () => {
    expect((await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass-1' }, { apikey: 'k' }))).status).toBe(401);
    expect((await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass-1' }, { authorization: 'Bearer t' }))).status).toBe(401);
    expect((await run(post('not json'))).json.message).toMatch(/JSON/);
    expect((await run(post({ action: 'drop', username: 'cashier3' }))).json.message).toBe('Unknown action');
    expect((await run(post({ action: 'add', username: 'Bad Name', password: 'cashier-pass-1' }))).json.message).toMatch(/User ID must be/);
    expect((await run(post({ action: 'add', username: 'cashier3', password: 'short' }))).json.message).toMatch(/at least 8/);
    expect((await run(post({ action: 'reset', username: 'cashier3' }))).json.message).toMatch(/at least 8/);
    expect(calls).toEqual([]);
  });

  it('the server is missing its settings: says so, calls nothing', async () => {
    const r = await run(post({ action: 'remove', username: 'cashier3' }), { get: (n: string) => (n === 'SUPABASE_URL' ? BASE : undefined) });
    expect(r.status).toBe(500);
    expect(calls).toEqual([]);
  });

  it('add: if putting it on the staff list fails, the new account is deleted again', async () => {
    answers['POST /rest/v1/rpc/staff_add_finish'] = { status: 400, json: { code: 'P0001', message: 'User ID cashier3 is already used' } };
    const r = await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass-1' }));
    expect(r.json.message).toBe('User ID cashier3 is already used');
    expect(adminCalls().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /auth/v1/admin/users', `DELETE /auth/v1/admin/users/${ID}`]);
  });

  it('add: an old account for that User ID is reused (new password), not created twice', async () => {
    answers['POST /rest/v1/rpc/staff_add_prepare'] = { json: { email: 'owner+cashier3@tikka.test', userId: ID } };
    answers['POST /rest/v1/rpc/staff_add_finish'] = { status: 400, json: { code: 'P0001', message: 'boom' } };
    await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass-1' }));
    expect(adminCalls().map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /auth/v1/admin/users/${ID}`]); // not deleted: it existed before
    expect(adminCalls()[0]!.body).toEqual({ password: 'cashier-pass-1', email_confirm: true });
  });

  it('Supabase refuses the password or the account: a plain message', async () => {
    answers['POST /auth/v1/admin/users'] = { status: 422, json: { code: 422, error_code: 'weak_password', msg: 'Password should contain at least one number' } };
    expect((await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass' }))).json).toEqual({
      code: 'P0001',
      message: 'Supabase did not accept this password: Password should contain at least one number',
    });
    answers['POST /auth/v1/admin/users'] = { status: 422, json: { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' } };
    expect((await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass-1' }))).json.message).toMatch(/already exists/);
    answers['POST /auth/v1/admin/users'] = { status: 403, json: { code: 403, error_code: 'not_admin', msg: 'User not allowed' } };
    expect((await run(post({ action: 'add', username: 'cashier3', password: 'cashier-pass-1' }))).json.message).toBe('Supabase refused to change the account (403 not_admin).');
  });

  it('reset: checked by the database, then the new password is set', async () => {
    const r = await run(post({ action: 'reset', username: 'cashier3', password: 'brand-new-pass' }));
    expect(r.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /rest/v1/rpc/staff_user_id', `PUT /auth/v1/admin/users/${ID}`]);
    expect(calls[1]!.body).toEqual({ password: 'brand-new-pass' });
  });

  it('remove: off the staff list first, then the account is deleted (removed even if that fails)', async () => {
    expect((await run(post({ action: 'remove', username: 'cashier3' }))).json).toEqual({ ok: true, username: 'cashier3', accountDeleted: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /rest/v1/rpc/staff_remove', `DELETE /auth/v1/admin/users/${ID}`]);
    answers['DELETE /auth/v1/admin/users/:id'] = { status: 500, json: { msg: 'down' } };
    expect((await run(post({ action: 'remove', username: 'cashier3' }))).json).toMatchObject({ ok: true, accountDeleted: false });
  });

  it('uses the new secret key when there is one, else the legacy service role key', () => {
    expect(secretKey(env())).toBe(SECRET);
    expect(secretKey({ get: (n) => ({ SUPABASE_SECRET_KEYS: '{"other":"sb_secret_b"}' })[n] })).toBe('sb_secret_b');
    expect(secretKey({ get: (n) => ({ SUPABASE_SECRET_KEYS: 'not json', SUPABASE_SERVICE_ROLE_KEY: 'eyJ.legacy' })[n] })).toBe('eyJ.legacy');
    expect(secretKey({ get: () => undefined })).toBe('');
  });
});

describe('User ID and password rules (app and server function agree)', () => {
  it.each(['short', '1234567', ' leading-space', 'trailing-space ', 'x'.repeat(73), 'é'.repeat(37)])('refuses %j', (p) => {
    expect(newPassword(p).ok).toBe(false);
    expect(passwordProblem(p)).not.toBeNull();
  });
  it.each(['admin@07', 'cashier-pass-1', 'x'.repeat(72), 'पासवर्ड123'])('accepts %j', (p) => {
    expect(newPassword(p).ok).toBe(true);
    expect(passwordProblem(p)).toBeNull();
  });
  it('User IDs: trimmed and made small letters; the same pattern as the database', () => {
    expect(userId(' Counter2 ')).toEqual({ ok: true, value: 'counter2' });
    for (const bad of ['', 'a', 'bad name', '<b>', '-x', 'x'.repeat(31), 'owner@x']) expect(userId(bad).ok).toBe(false);
  });
});
