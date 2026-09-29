/**
 * Shared database (Supabase) on the app side, against an in-memory fake server:
 * sign-in with a User ID, token refresh, saving bills online and offline,
 * uploading offline bills, pulling changes, the 3-month clean-up, fingerprint flag.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDBForTests, getDB } from '../../src/db/db';
import { setCloudConfigForTests } from '../../src/cloud/config';
import { toCloudError } from '../../src/cloud/http';
import { signIn, accessToken, resetAuthForTests, loadSession, signOut } from '../../src/cloud/auth';
import { cloudRepo } from '../../src/cloud/cloudRepo';
import { syncNow, resetSyncForTests, offlinePayload } from '../../src/cloud/sync';
import { applyChanges, pendingBills } from '../../src/cloud/localStore';
import { userVerified } from '../../src/cloud/biometric';
import { setCloudHooks } from '../../src/db/hooks';
import { saveBill, voidBill, getBill, getMonthlyStats, BillError } from '../../src/db/billRepo';
import { addDish, listMenu, MenuError } from '../../src/db/menuRepo';
import { getMeta, setMeta } from '../../src/db/settingsRepo';
import { purgeOldMonths } from '../../src/db/retention';
import { validateBackup } from '../../src/core/backupSchema';
import { exportBackup } from '../../src/db/backup';
import { NO_DISCOUNT } from '../../src/core/totals';
import type { Bill } from '../../src/db/types';

const URL_ = 'https://demo.supabase.co';
const NOW = +new Date(2026, 8, 25, 13, 0);

// ---------------- a tiny fake Supabase ----------------
type Handler = (body: any, headers: Record<string, string>, url: URL) => { status?: number; json?: unknown } | 'offline';
let routes: Record<string, Handler>;
let calls: { path: string; body: any; auth: string }[];

function route(path: string, h: Handler) {
  routes[path] = h;
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await resetDBForTests();
  resetAuthForTests();
  resetSyncForTests();
  setCloudHooks(null);
  setCloudConfigForTests({ url: URL_, anonKey: 'anon-key-000000000000000000' });
  routes = {};
  calls = [];
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    calls.push({ path: key + url.search, body, auth: headers['Authorization'] ?? '' });
    const h = routes[key] ?? routes[`${init.method} ${url.pathname}${url.search}`];
    if (!h) return new Response(JSON.stringify({ code: 'PGRST202', message: 'not found' }), { status: 404 });
    const r = h(body, headers, url);
    if (r === 'offline') throw new TypeError('Failed to fetch');
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status ?? 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function token(tokenId: string, expiresInS = 3600) {
  return { access_token: `at-${tokenId}`, refresh_token: `rt-${tokenId}`, expires_in: expiresInS, user: { id: 'u-1', email: 'counter1@tikka.test' } };
}

function staffLogin() {
  route('POST /rest/v1/rpc/login_email', (b) => ({ json: b.p_username === 'counter1' ? 'counter1@tikka.test' : null }));
  route('POST /auth/v1/token', (b, _h, url) => {
    if (url.searchParams.get('grant_type') === 'password') {
      return b.email === 'counter1@tikka.test' && b.password === 'right-pass'
        ? { json: token('1') }
        : { status: 400, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
    }
    return b.refresh_token === 'rt-1' ? { json: token('2') } : { status: 400, json: { error: 'invalid_grant' } };
  });
}

function serverBill(over: Partial<Bill> & { billNo: string }): Bill {
  return {
    createdAt: NOW, monthKey: '202609', hour: 13, weekday: 5, orderType: 'takeaway', paymentMode: 'cash', discount: NO_DISCOUNT,
    items: [{ menuId: 1, name: 'Full Chicken', category: 'Grill Gali', isVeg: false, unitPaise: 45000, qty: 1, linePaise: 45000 }],
    subtotalPaise: 45000, discountPaise: 0, roundOffPaise: 0, totalPaise: 45000, itemCount: 1, categories: ['Grill Gali'],
    hasVeg: false, hasNonVeg: true, cheesyLine: '', status: 'paid', ...over,
  };
}

const menuRow = { id: 1, name: 'Full Chicken', category: 'Grill Gali', price_paise: 45000, is_veg: false, active: true, deleted: false, used_in_bills: false, created_at: 1, updated_at: 1 };

async function signedInWithMenu() {
  staffLogin();
  await signIn('counter1', 'right-pass', NOW);
  await applyChanges({ menu: [menuRow] });
  await setMeta('cloudDbId', 'db-1');
  setCloudHooks(cloudRepo);
}

// ---------------- errors ----------------
describe('errors from the server become plain messages', () => {
  it.each<[number, object, string, string]>([
    [400, { code: 'P0001', message: 'The price of Lassi was changed on another device.' }, 'rejected', 'The price of Lassi'],
    [403, { code: '42501', message: 'This account is not on the Tikka Bites staff list.' }, 'not-staff', 'staff list'],
    [401, { code: 'PGRST301', message: 'JWT expired' }, 'auth', 'sign-in has expired'],
    [404, { code: 'PGRST202', message: 'Could not find the function' }, 'setup', 'schema.sql'],
    [503, {}, 'offline', 'busy or unreachable'],
  ])('%i %o → %s', (status, body, kind, text) => {
    const e = toCloudError(status, body);
    expect(e.kind).toBe(kind);
    expect(e.message).toContain(text);
  });
});

// ---------------- sign-in ----------------
describe('sign in with a User ID and password', () => {
  it('turns the User ID into the email, signs in and keeps the session on the phone', async () => {
    staffLogin();
    const s = await signIn('  Counter1 ', 'right-pass', NOW);
    expect(s).toMatchObject({ username: 'counter1', email: 'counter1@tikka.test', accessToken: 'at-1', userId: 'u-1' });
    expect(calls.map((c) => c.path)).toEqual(['POST /rest/v1/rpc/login_email', 'POST /auth/v1/token?grant_type=password']);
    resetAuthForTests();
    expect((await loadSession())?.accessToken).toBe('at-1'); // survives a restart
  });

  it('gives the same message for an unknown User ID and a wrong password', async () => {
    staffLogin();
    await expect(signIn('nobody', 'x', NOW)).rejects.toThrow('Wrong User ID or password.');
    await expect(signIn('counter1', 'wrong', NOW)).rejects.toThrow('Wrong User ID or password.');
    await expect(signIn('bad id!', 'x', NOW)).rejects.toThrow('Wrong User ID or password.');
    expect(await loadSession()).toBeNull();
  });

  it('signing in with the email skips the look-up', async () => {
    staffLogin();
    await signIn('counter1@tikka.test', 'right-pass', NOW);
    expect(calls.map((c) => c.path)).toEqual(['POST /auth/v1/token?grant_type=password']);
  });

  it('no internet: says so (not "wrong password")', async () => {
    route('POST /rest/v1/rpc/login_email', () => 'offline');
    await expect(signIn('counter1', 'right-pass', NOW)).rejects.toThrow('No internet');
  });

  it('refreshes an expiring token once, even for several callers at the same time', async () => {
    staffLogin();
    await signIn('counter1', 'right-pass', NOW);
    const later = NOW + 3600_000 - 30_000; // 30 s before expiry
    const [a, b] = await Promise.all([accessToken(later), accessToken(later)]);
    expect([a, b]).toEqual(['at-2', 'at-2']);
    expect(calls.filter((c) => c.path.includes('grant_type=refresh_token'))).toHaveLength(1);
  });

  it('a refused refresh signs the phone out', async () => {
    staffLogin();
    await signIn('counter1', 'right-pass', NOW);
    route('POST /auth/v1/token', () => ({ status: 400, json: { error: 'invalid_grant' } }));
    await expect(accessToken(NOW + 7200_000)).rejects.toThrow('sign-in has expired');
    expect(await loadSession()).toBeNull();
  });

  it('sign out forgets the session even without internet', async () => {
    staffLogin();
    await signIn('counter1', 'right-pass', NOW);
    route('POST /auth/v1/logout', () => 'offline');
    await signOut();
    expect(await loadSession()).toBeNull();
  });
});

// ---------------- bills ----------------
const draft = { items: [{ menuId: 1, qty: 2 }], orderType: 'takeaway' as const, paymentMode: 'upi' as const, discount: NO_DISCOUNT };

describe('saving bills with the shared database', () => {
  it('online: the server numbers the bill; it is kept on the phone with its totals', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/rpc/save_bill', (b) => {
      expect(b.p_bill.items).toEqual([{ menuId: 1, qty: 2, unitPaise: 45000 }]);
      expect(b.p_bill.clientRef).toMatch(/^[0-9a-f-]{36}$/);
      return { json: serverBill({ billNo: 'RCPT-202609-0007', items: [{ ...serverBill({ billNo: 'x' }).items[0]!, qty: 2, linePaise: 90000 }], subtotalPaise: 90000, totalPaise: 90000, itemCount: 2 }) };
    });
    const b = await saveBill(draft, NOW);
    expect(b.billNo).toBe('RCPT-202609-0007');
    expect(b.sync).toBeUndefined();
    expect(await getBill('RCPT-202609-0007')).toBeTruthy();
    expect((await getMonthlyStats('202609'))?.revenuePaise).toBe(90000);
  });

  it('offline: billing continues with a temporary OFF- number, queued for upload', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/rpc/save_bill', () => 'offline');
    const a = await saveBill(draft, NOW);
    const b = await saveBill(draft, NOW + 1000);
    expect(a.billNo).toMatch(/^OFF-[A-Z0-9]{3}-0001$/);
    expect(b.billNo).toMatch(/^OFF-[A-Z0-9]{3}-0002$/);
    expect(a.sync?.clientRef).toMatch(/^[0-9a-f-]{36}$/);
    expect((await getMeta('outbox'))).toEqual([a.billNo, b.billNo]);
    expect((await getMonthlyStats('202609'))?.billCount).toBe(2); // reports include offline bills straight away
  });

  it('refused (e.g. price changed on another phone): nothing is saved and the reason is shown', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/rpc/save_bill', () => ({ status: 400, json: { code: 'P0001', message: 'The price of Full Chicken was changed on another device. Please check the bill and save again.' } }));
    route('POST /rest/v1/rpc/pull_changes', () => ({ json: { menu: [], lines: [], settings: null, bills: [], dbId: 'db-1', ready: true, importOpen: false, keepFrom: '202607', more: false, rev: 5 } }));
    await expect(saveBill(draft, NOW)).rejects.toThrow(BillError);
    await expect(saveBill(draft, NOW)).rejects.toThrow('changed on another device');
    expect(await (await getDB()).count('bills')).toBe(0);
  });

  it('uploading an offline bill replaces it with the final receipt, without counting it twice', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/rpc/save_bill', () => 'offline');
    const off = await saveBill(draft, NOW);
    await syncNow(); // the save started a background sync (offline): let it finish
    let sent: any;
    route('POST /rest/v1/rpc/save_bill', (b) => {
      sent = b.p_bill;
      return { json: serverBill({ billNo: 'RCPT-202609-0042', printedAs: off.billNo, createdAt: NOW, items: off.items, subtotalPaise: 90000, totalPaise: 90000, itemCount: 2 }) };
    });
    route('POST /rest/v1/rpc/pull_changes', () => ({ json: { menu: [], lines: [], settings: null, bills: [], dbId: 'db-1', ready: true, importOpen: false, keepFrom: '202607', more: false, rev: 9 } }));
    route('POST /rest/v1/rpc/purge_old_months', () => ({ json: 0 }));
    const st = await syncNow();
    expect(st.status).toBe('synced');
    expect(sent).toMatchObject({ offline: true, printedAs: off.billNo, createdAt: NOW, clientRef: off.sync!.clientRef });
    expect(sent.items[0]).toMatchObject({ menuId: 1, qty: 2, unitPaise: 45000, name: 'Full Chicken' });
    expect(await getBill(off.billNo)).toBeUndefined();
    expect((await getBill('RCPT-202609-0042'))?.printedAs).toBe(off.billNo);
    expect(await getMeta('outbox')).toEqual([]);
    const s = await getMonthlyStats('202609');
    expect([s?.billCount, s?.revenuePaise]).toEqual([1, 90000]);
  });

  it('an offline bill the server refuses stays on the phone, marked, and does not block others', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/rpc/save_bill', () => 'offline');
    const bad = await saveBill(draft, NOW);
    const good = await saveBill(draft, NOW + 1);
    await syncNow(); // background sync started by the saves (offline)
    route('POST /rest/v1/rpc/save_bill', (b) =>
      b.p_bill.printedAs === bad.billNo
        ? { status: 400, json: { code: 'P0001', message: 'This offline bill is more than 35 days old and can’t be uploaded.' } }
        : { json: serverBill({ billNo: 'RCPT-202609-0050', printedAs: good.billNo }) });
    route('POST /rest/v1/rpc/pull_changes', () => ({ json: { menu: [], lines: [], settings: null, bills: [], dbId: 'db-1', ready: true, importOpen: false, keepFrom: '202607', more: false, rev: 9 } }));
    route('POST /rest/v1/rpc/purge_old_months', () => ({ json: 0 }));
    const st = await syncNow();
    expect(st).toMatchObject({ status: 'synced', waiting: 0, attention: 1 });
    expect((await getBill(bad.billNo))?.sync?.error).toContain('35 days');
    expect(await getBill(good.billNo)).toBeUndefined();
    expect((await pendingBills()).map((b) => b.billNo)).toEqual([bad.billNo]);
  });

  it('voiding: online goes to the server; a not-yet-uploaded bill is cancelled on the phone', async () => {
    await signedInWithMenu();
    await applyChanges({ bills: [serverBill({ billNo: 'RCPT-202609-0001' })] });
    route('POST /rest/v1/rpc/void_bill', (b) => ({ json: serverBill({ billNo: b.p_bill_no, status: 'void', voidReason: b.p_reason, voidedAt: NOW }) }));
    await voidBill('RCPT-202609-0001', 'Customer left');
    expect((await getMonthlyStats('202609'))).toMatchObject({ billCount: 0, voidCount: 1 });

    route('POST /rest/v1/rpc/save_bill', () => 'offline');
    const off = await saveBill(draft, NOW);
    await voidBill(off.billNo, 'Typed wrong');
    expect((await getBill(off.billNo))).toMatchObject({ status: 'void', sync: { error: 'Cancelled before upload' } });
    expect(await getMeta('outbox')).toEqual([]);
    expect(calls.filter((c) => c.path.includes('void_bill'))).toHaveLength(1); // the offline one never reached the server
  });

  it('voiding needs the internet for uploaded bills', async () => {
    await signedInWithMenu();
    await applyChanges({ bills: [serverBill({ billNo: 'RCPT-202609-0001' })] });
    route('POST /rest/v1/rpc/void_bill', () => 'offline');
    await expect(voidBill('RCPT-202609-0001', 'Customer left')).rejects.toThrow('needs the internet');
  });
});

// ---------------- pulling changes ----------------
describe('pulling changes from other phones', () => {
  it('adds new bills, applies voids from other phones, and pages until up to date', async () => {
    await signedInWithMenu();
    await applyChanges({ bills: [serverBill({ billNo: 'RCPT-202609-0001' })] });
    const pages = [
      { menu: [{ ...menuRow, price_paise: 47000 }], lines: [{ id: 3, text: 'Hi', built_in: false, active: true, removed: false }], settings: { name: 'Tikka Bites', address: '', phone: '1', currencySymbol: '₹', receiptWidth: '80', roundOff: true }, bills: [serverBill({ billNo: 'RCPT-202609-0002' })], dbId: 'db-1', ready: true, importOpen: false, keepFrom: '202607', more: true, rev: 10 },
      { menu: [], lines: [], settings: null, bills: [serverBill({ billNo: 'RCPT-202609-0001', status: 'void', voidReason: 'x', voidedAt: NOW })], dbId: 'db-1', ready: true, importOpen: false, keepFrom: '202607', more: false, rev: 11 },
    ];
    const since: number[] = [];
    route('POST /rest/v1/rpc/pull_changes', (b) => {
      since.push(b.p_since);
      return { json: pages.shift() };
    });
    route('POST /rest/v1/rpc/purge_old_months', () => ({ json: 0 }));
    await syncNow();
    expect(since).toEqual([0, 10]);
    expect(await getMeta('cloudRev')).toBe(11);
    expect((await listMenu())[0]?.pricePaise).toBe(47000);
    expect((await getMonthlyStats('202609'))).toMatchObject({ billCount: 1, voidCount: 1, revenuePaise: 45000 });
  });

  it('keeps only the months the server keeps', async () => {
    await signedInWithMenu();
    await applyChanges({ bills: [serverBill({ billNo: 'RCPT-202606-0001', monthKey: '202606', createdAt: +new Date(2026, 5, 3) }), serverBill({ billNo: 'RCPT-202609-0001' })] });
    route('POST /rest/v1/rpc/pull_changes', () => ({ json: { menu: [], lines: [], settings: null, bills: [], dbId: 'db-1', ready: true, importOpen: false, keepFrom: '202607', more: false, rev: 3 } }));
    route('POST /rest/v1/rpc/purge_old_months', () => ({ json: 0 }));
    await syncNow();
    expect(await getBill('RCPT-202606-0001')).toBeUndefined();
    expect(await getMonthlyStats('202606')).toBeUndefined();
    expect(await getBill('RCPT-202609-0001')).toBeTruthy();
  });

  it('a re-created shared database resets this phone’s copy but keeps waiting offline bills', async () => {
    await signedInWithMenu();
    await applyChanges({ bills: [serverBill({ billNo: 'RCPT-202609-0001' })] });
    route('POST /rest/v1/rpc/save_bill', () => 'offline');
    const off = await saveBill(draft, NOW);
    await syncNow();
    // The upload is refused (kept on the phone, marked), so the sync goes on to download.
    route('POST /rest/v1/rpc/save_bill', () => ({ status: 400, json: { code: 'P0001', message: 'Refused for this test' } }));
    await setMeta('cloudRev', 50);
    const sinceSeen: number[] = [];
    route('POST /rest/v1/rpc/pull_changes', (b) => {
      sinceSeen.push(b.p_since);
      return { json: { menu: [menuRow], lines: [], settings: null, bills: [], dbId: 'db-NEW', ready: true, importOpen: false, keepFrom: '202607', more: false, rev: 4 } };
    });
    route('POST /rest/v1/rpc/purge_old_months', () => ({ json: 0 }));
    await syncNow();
    expect(sinceSeen).toEqual([50, 0]);
    expect(await getMeta('cloudDbId')).toBe('db-NEW');
    expect(await getBill('RCPT-202609-0001')).toBeUndefined();
    expect(await getBill(off.billNo)).toBeTruthy();
  });

  it('offline: the sync reports it and keeps the waiting count', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/rpc/save_bill', () => 'offline');
    await saveBill(draft, NOW);
    route('POST /rest/v1/rpc/pull_changes', () => 'offline');
    expect(await syncNow()).toMatchObject({ status: 'offline', waiting: 1 });
  });
});

// ---------------- menu edits ----------------
describe('menu changes go to the shared database', () => {
  it('adding a dish stores the server row (with the server id)', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/menu', (b) => ({ json: b.map((r: any, i: number) => ({ ...menuRow, ...r, id: 77 + i })) }));
    const d = await addDish({ name: 'Kulfi', category: 'Desserts', pricePaise: 7500, isVeg: true, active: true });
    expect(d.id).toBe(77);
    expect((await listMenu()).map((x) => x.name)).toContain('Kulfi');
    expect(calls.at(-1)?.body).toEqual([{ name: 'Kulfi', category: 'Desserts', price_paise: 7500, is_veg: true, active: true }]);
  });

  it('no internet: a clear message, nothing changed on the phone', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/menu', () => 'offline');
    await expect(addDish({ name: 'Kulfi', category: 'Desserts', pricePaise: 7500, isVeg: true, active: true })).rejects.toThrow(MenuError);
    expect((await listMenu()).map((x) => x.name)).toEqual(['Full Chicken']);
  });
});

// ---------------- 3 months, fingerprint, backups ----------------
describe('keep 3 months on the phone', () => {
  it('deletes older months, their totals and counters, and drops them from the upload queue', async () => {
    await applyChanges({ bills: [serverBill({ billNo: 'RCPT-202606-0001', monthKey: '202606' }), serverBill({ billNo: 'RCPT-202607-0001', monthKey: '202607' })] });
    const db = await getDB();
    await db.put('counters', { monthKey: '202606', last: 3 });
    await setMeta('outbox', ['RCPT-202606-0001']);
    expect(await purgeOldMonths('202607')).toBe(1);
    expect(await getBill('RCPT-202606-0001')).toBeUndefined();
    expect(await getBill('RCPT-202607-0001')).toBeTruthy();
    expect(await db.get('counters', '202606')).toBeUndefined();
    expect(await getMonthlyStats('202606')).toBeUndefined();
    expect(await getMeta('outbox')).toEqual([]);
  });
});

describe('fingerprint', () => {
  it('only counts a verified fingerprint / screen lock (UV flag)', () => {
    const data = new Uint8Array(37);
    expect(userVerified(data.buffer)).toBe(false);
    data[32] = 0x01; // user present only
    expect(userVerified(data.buffer)).toBe(false);
    data[32] = 0x05; // present + verified
    expect(userVerified(data.buffer)).toBe(true);
  });
});

describe('backups with offline bills', () => {
  it('a phone’s backup with a waiting offline bill still validates; tampering is refused', async () => {
    await signedInWithMenu();
    route('POST /rest/v1/rpc/save_bill', () => 'offline');
    await saveBill(draft, NOW);
    const json = JSON.parse(await (await exportBackup(NOW)).text());
    expect(validateBackup(json).ok).toBe(true);
    const noSync = structuredClone(json);
    delete noSync.bills[0].sync;
    expect(validateBackup(noSync)).toMatchObject({ ok: false });
    const badRef = structuredClone(json);
    badRef.bills[0].sync.clientRef = 'not-a-uuid';
    expect(validateBackup(badRef)).toMatchObject({ ok: false });
    expect(offlinePayload(json.bills[0]).offline).toBe(true);
  });
});
