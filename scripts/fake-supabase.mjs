// A stand-in for Supabase, for end-to-end tests on this PC: the real app talks to
// it exactly like to Supabase (Auth + PostgREST URLs), and every call runs as real
// SQL against supabase/schema.sql in a local PostgreSQL, with Supabase's roles
// (anon / authenticated) and the signed-in user's id, so row-level security and
// all checks are the real ones.
//
// Usage: node scripts/fake-supabase.mjs [port=54321]
// Needs PostgreSQL 15+ (psql) reachable as a superuser: PGHOST, PGPORT, PGUSER,
// and PG_BIN (folder with psql) if psql isn't on PATH.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The real server function (supabase/functions/staff-admin), run here instead of on Supabase.
import { handle as staffAdmin } from '../supabase/functions/staff-admin/index.ts';

const PORT = Number(process.argv[2] ?? 54321);
const DB = process.env.FAKE_SUPABASE_DB ?? 'tb_e2e';
const PSQL = process.env.PG_BIN ? join(process.env.PG_BIN, 'psql') : 'psql';
export const ANON_KEY = 'anon-key-for-local-e2e-0000000000';
/** Stands in for the project's secret key: only the server function uses it. */
const SECRET_KEY = 'secret-key-for-local-e2e-0000000000';
const FUNCTION_ENV = { SUPABASE_URL: `http://localhost:${PORT}`, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }) };

/** Accounts (auth.users in tests/stub.sql, plus any the super admin adds) and their passwords. */
let PASSWORDS;
let USER_IDS;
function resetAccounts() {
  PASSWORDS = {
    'owner@tikka.test': 'owner-pass-123',
    'counter1@tikka.test': 'counter-pass-123',
    'counter2@tikka.test': 'counter2-pass-123',
  };
  USER_IDS = {
    'owner@tikka.test': '11111111-1111-1111-1111-111111111111',
    'counter1@tikka.test': '22222222-2222-2222-2222-222222222222',
    'counter2@tikka.test': '33333333-3333-3333-3333-333333333333',
  };
}

/** Argument types of every SQL function the app calls (PostgREST reads these from the database). */
const FUNCS = {
  login_email: { p_username: 'text' },
  pull_changes: { p_since: 'bigint', p_limit: 'integer' },
  save_bill: { p_bill: 'jsonb' },
  void_bill: { p_bill_no: 'text', p_reason: 'text', p_created_at: 'bigint' },
  patch_settings: { p_set: 'jsonb', p_unset: 'text[]' },
  purge_old_months: {},
  import_device_data: { p_menu: 'jsonb', p_lines: 'jsonb', p_settings: 'jsonb', p_counters: 'jsonb' },
  import_bills: { p_bills: 'jsonb' },
  finish_import: {},
  my_role: {},
  list_staff: {},
  staff_add_prepare: { p_username: 'text' },
  staff_add_finish: { p_user_id: 'uuid', p_username: 'text' },
  staff_remove: { p_username: 'text' },
  staff_user_id: { p_username: 'text' },
};
const VOID_FUNCS = new Set(['import_device_data', 'finish_import']);
const TABLES = {
  menu: ['name', 'category', 'price_paise', 'is_veg', 'active', 'deleted'],
  cheesy_lines: ['text', 'active', 'removed'],
};

const tokens = new Map(); // access token → { sub, email, exp }
const refreshTokens = new Map(); // refresh token → email

function dq(s) {
  const tag = `q${randomBytes(6).toString('hex')}`;
  return `$${tag}$${s}$${tag}$`;
}

function literal(value, type) {
  if (value === null || value === undefined) return `null::${type}`;
  if (type === 'jsonb') return `${dq(JSON.stringify(value))}::jsonb`;
  if (type === 'text') return `${dq(String(value))}::text`;
  if (type === 'uuid') return `${dq(String(value))}::uuid`;
  if (type === 'text[]') {
    if (!Array.isArray(value)) throw new Error('expected an array');
    return `array[${value.map((v) => dq(String(v))).join(',')}]::text[]`;
  }
  if (type === 'bigint' || type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error('expected an integer');
    return `${value}::${type}`;
  }
  if (type === 'boolean') return value ? 'true' : 'false';
  throw new Error(`unknown type ${type}`);
}

/** Run SQL as a Supabase role; returns stdout. Rejects with { code, message } on SQL errors. */
function runSql(sql, who) {
  const claims = who ? JSON.stringify({ sub: who.sub, role: 'authenticated', email: who.email }) : '';
  const script = [
    '\\set VERBOSITY verbose',
    'begin;',
    `set local role ${who ? 'authenticated' : 'anon'};`,
    `select set_config('request.jwt.claims', ${dq(claims)}, true) \\g ${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    sql,
    'commit;',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const p = spawn(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', DB], { env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code === 0) return resolve(out.trim());
      const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(err);
      reject({ code: m?.[1] ?? 'XX000', message: m?.[2]?.trim() ?? err.trim() });
    });
    p.stdin.end(script);
  });
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function sqlError(res, e) {
  const status = e.code === 'P0001' ? 400 : e.code === '42501' ? 403 : e.code === '42883' ? 404 : 400;
  send(res, status, { code: e.code === '42883' ? 'PGRST202' : e.code, message: e.message });
}

function issue(email) {
  const at = `at-${randomUUID()}`;
  const rt = `rt-${randomUUID()}`;
  const expiresIn = Number(process.env.FAKE_TOKEN_TTL ?? 3600);
  tokens.set(at, { sub: USER_IDS[email], email, exp: Date.now() + expiresIn * 1000 });
  refreshTokens.set(rt, email);
  return { access_token: at, refresh_token: rt, token_type: 'bearer', expires_in: expiresIn, user: { id: USER_IDS[email], email } };
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : undefined;
}

/** Run SQL as the superuser (like Supabase's own services). */
function adminSql(sql, db = DB) {
  return new Promise((resolve, reject) => {
    const p = spawn(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], { env: process.env });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    p.stdin.end(sql);
  });
}

/** Supabase Auth's admin API (secret key only): create, change and delete accounts. */
async function adminUsers(req, res, id, body) {
  if (req.headers.authorization !== `Bearer ${SECRET_KEY}`) return send(res, 401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a valid Bearer token' });
  const emailOf = (uid) => Object.keys(USER_IDS).find((e) => USER_IDS[e] === uid);
  if (req.method === 'POST' && !id) {
    const email = String(body?.email ?? '').toLowerCase();
    if (USER_IDS[email]) return send(res, 422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
    const uid = randomUUID();
    await adminSql(`insert into auth.users (id, email) values ('${uid}', ${dq(email)});`);
    USER_IDS[email] = uid;
    PASSWORDS[email] = String(body.password);
    return send(res, 200, { id: uid, email });
  }
  const email = id && emailOf(id);
  if (!email) return send(res, 404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
  if (req.method === 'PUT') {
    if (body?.password) PASSWORDS[email] = String(body.password);
    return send(res, 200, { id, email });
  }
  if (req.method === 'DELETE') {
    await adminSql(`delete from auth.users where id = '${id}';`);
    delete USER_IDS[email];
    delete PASSWORDS[email];
    for (const [t, v] of tokens) if (v.sub === id) tokens.delete(t);
    for (const [t, e] of refreshTokens) if (e === email) refreshTokens.delete(t);
    return send(res, 200, {});
  }
  return send(res, 405, { msg: 'method not allowed' });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const admin = /^\/auth\/v1\/admin\/users(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
    if (req.headers.apikey !== (admin ? SECRET_KEY : ANON_KEY)) return send(res, 401, { message: 'Invalid API key' });
    const body = await readBody(req);
    if (admin) return await adminUsers(req, res, admin[1], body);

    // ----- The staff-admin server function (the real code) -----
    if (url.pathname === '/functions/v1/staff-admin') {
      const fnReq = new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers: { apikey: String(req.headers.apikey ?? ''), authorization: String(req.headers.authorization ?? ''), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const out = await staffAdmin(fnReq, { get: (n) => FUNCTION_ENV[n] });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(await out.text());
    }

    // ----- Test only: start again from an empty shared database -----
    if (url.pathname === '/__test/reset' && req.method === 'POST') {
      tokens.clear();
      refreshTokens.clear();
      await resetDatabase();
      return send(res, 200, { ok: true });
    }

    // ----- Auth -----
    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const email = String(body?.email ?? '').toLowerCase();
        if (PASSWORDS[email] && PASSWORDS[email] === body?.password) return send(res, 200, issue(email));
        return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      if (grant === 'refresh_token') {
        const email = refreshTokens.get(body?.refresh_token);
        if (!email) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        refreshTokens.delete(body.refresh_token); // rotated, like Supabase
        return send(res, 200, issue(email));
      }
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204);

    // Who is calling: the anon key, or a signed-in access token.
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    let who = null;
    if (bearer !== ANON_KEY) {
      const t = tokens.get(bearer);
      if (!t || t.exp < Date.now()) return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });
      who = t;
    }

    // ----- SQL functions -----
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (rpc && req.method === 'POST') {
      const fn = rpc[1];
      const types = FUNCS[fn];
      if (!types) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
      const args = Object.entries(body ?? {}).map(([k, v]) => {
        if (!(k in types)) throw { code: 'PGRST202', message: `unknown argument ${k}` };
        return `${k} => ${literal(v, types[k])}`;
      });
      const call = `public.${fn}(${args.join(', ')})`;
      try {
        if (VOID_FUNCS.has(fn)) {
          await runSql(`select ${call} \\g ${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, who);
          return send(res, 200, null);
        }
        const out = await runSql(`select coalesce(to_jsonb(${call}), 'null'::jsonb);`, who);
        return send(res, 200, JSON.parse(out || 'null'));
      } catch (e) {
        return sqlError(res, e);
      }
    }

    // ----- Tables: insert (POST) and update (PATCH ?id=eq.N) -----
    const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (table && TABLES[table]) {
      const allowed = TABLES[table];
      try {
        if (req.method === 'POST') {
          const rows = Array.isArray(body) ? body : [body];
          const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
          if (cols.some((c) => !allowed.includes(c) && c !== 'text')) throw { code: '42501', message: 'permission denied' };
          const values = rows.map((r) => `(${cols.map((c) => literal(r[c], typeof r[c] === 'boolean' ? 'boolean' : typeof r[c] === 'number' ? 'integer' : 'text')).join(', ')})`);
          const out = await runSql(`with t as (insert into public.${table} (${cols.join(', ')}) values ${values.join(', ')} returning *) select coalesce(json_agg(to_jsonb(t)), '[]') from t;`, who);
          return send(res, 201, JSON.parse(out));
        }
        if (req.method === 'PATCH') {
          const id = /^eq\.(\d+)$/.exec(url.searchParams.get('id') ?? '')?.[1];
          if (!id) return send(res, 400, { message: 'id filter required' });
          const sets = Object.entries(body).map(([c, v]) => {
            if (!allowed.includes(c)) throw { code: '42501', message: 'permission denied' };
            return `${c} = ${literal(v, typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'integer' : 'text')}`;
          });
          const out = await runSql(`with t as (update public.${table} set ${sets.join(', ')} where id = ${Number(id)} returning *) select coalesce(json_agg(to_jsonb(t)), '[]') from t;`, who);
          return send(res, 200, JSON.parse(out));
        }
      } catch (e) {
        return sqlError(res, e);
      }
    }
    send(res, 404, { message: 'not found' });
  } catch (e) {
    send(res, 400, { code: e.code ?? 'XX000', message: e.message ?? String(e) });
  }
});

/** Fresh database: Supabase stand-in (roles, auth.users) + the real schema + staff with User IDs. */
async function resetDatabase() {
  resetAccounts();
  await adminSql(`drop database if exists ${DB} with (force);`, 'postgres');
  await adminSql(`create database ${DB};`, 'postgres');
  await adminSql(readFileSync('supabase/tests/stub.sql', 'utf8'));
  await adminSql(readFileSync('supabase/schema.sql', 'utf8'));
  await adminSql(
    "select public.allow_staff('owner@tikka.test', 'owner'); select public.allow_staff('counter1@tikka.test', 'counter1');" +
      " select public.make_super_admin('owner');",
  );
}

await resetDatabase();
server.listen(PORT, () => console.log(`fake Supabase on http://localhost:${PORT} (database ${DB})`));
