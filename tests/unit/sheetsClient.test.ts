/**
 * The app with the Google Sheets backend: the real app code (src/cloud/*) talks through a
 * stubbed fetch to the real google-sheets/Code.gs, run by tests/helpers/fakeAppsScript.mjs.
 * Sign-in, saving online and offline, sync, menu, settings, users, switching from Supabase.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRuntime, type FakeAppsScript } from '../helpers/fakeAppsScript.mjs';
import { resetDBForTests, getDB } from '../../src/db/db';
import { setCloudConfigForTests } from '../../src/cloud/config';
import { call, fromReply } from '../../src/cloud/sheetsHttp';
import { api } from '../../src/cloud/api';
import { signIn, signOut, accessToken, loadSession, resetAuthForTests, currentSession } from '../../src/cloud/auth';
import { cloudRepo } from '../../src/cloud/cloudRepo';
import { syncNow, resetSyncForTests } from '../../src/cloud/sync';
import { applyChanges, countersFor, forgetOtherDatabase, pendingBills } from '../../src/cloud/localStore';
import { setCloudHooks } from '../../src/db/hooks';
import { saveBill, voidBill, getBill, getMonthlyStats, BillError } from '../../src/db/billRepo';
import { addDish, listMenu } from '../../src/db/menuRepo';
import { saveSettings } from '../../src/db/settingsRepo';
import { getMeta, setMeta } from '../../src/db/settingsRepo';
import { monthKeyOf } from '../../src/core/billNo';
import { NO_DISCOUNT } from '../../src/core/totals';
import { CloudError } from '../../src/cloud/errors';
import type { Bill } from '../../src/db/types';

const SHEETS = 'https://script.google.com/macros/s/AKfycbTestDeployment0123456789/exec';
const T0 = Date.now();
const M = monthKeyOf(T0);

let g: FakeAppsScript;
let offline: boolean;
let requests: { fn: string; headers: unknown }[];

const DISHES = [
  { id: 1, name: 'Full Chicken', nameLower: 'full chicken', category: 'Grill Gali', pricePaise: 45000, isVeg: false, active: true, deleted: false, usedInBills: false, createdAt: 1, updatedAt: 1 },
  { id: 2, name: 'Lassi', nameLower: 'lassi', category: 'Thanda Matter', pricePaise: 6000, isVeg: true, active: true, deleted: false, usedInBills: false, createdAt: 1, updatedAt: 1 },
];
const SETTINGS = { name: 'Tikka Bites', address: '', phone: '09137582060', currencySymbol: '₹', receiptWidth: '80' as const, roundOff: true };

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await resetDBForTests();
  resetAuthForTests();
  resetSyncForTests();
  setCloudHooks(null);
  setCloudConfigForTests({ backend: 'sheets', url: SHEETS, anonKey: '' });
  g = createRuntime({ now: T0 });
  g.exec('setup');
  g.exec('setOwnerLogin', 'owner', 'owner-pass-123');
  offline = false;
  requests = [];
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe(SHEETS);
    if (offline) throw new TypeError('Failed to fetch');
    const body = JSON.parse(String(init.body));
    requests.push({ fn: body.fn, headers: init.headers });
    return new Response(JSON.stringify(g.post(init.body)), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(g.rt.violations).toEqual([]);
});

/** The first phone signs in and sets the sheet up (what boot.ts does on "Set up from this phone"). */
async function setUpAsOwner() {
  await signIn('owner', 'owner-pass-123', T0);
  await api.importDeviceData(DISHES, [{ id: 1, text: 'Thank you', builtIn: true, active: true }], SETTINGS, []);
  await api.finishImport();
  setCloudHooks(cloudRepo);
  expect((await syncNow()).status).toBe('synced');
}

const draft = { items: [{ menuId: 1, qty: 2 }], orderType: 'takeaway' as const, paymentMode: 'upi' as const, discount: NO_DISCOUNT };
const sheetBills = () => g.records<{ bill: Bill; by: string }>(g.main(), `Bills ${M.slice(0, 4)}-${M.slice(4)}`).map((r) => r.bill);

describe('talking to the sheet', () => {
  it('one plain POST, no custom headers (no CORS pre-check), the token in the body', async () => {
    await signIn('owner', 'owner-pass-123', T0);
    await api.myRole();
    expect(requests.map((r) => r.fn)).toEqual(['sign_in', 'my_role']);
    expect(requests.every((r) => r.headers === undefined)).toBe(true);
  });

  it('answers become data or plain CloudErrors; Google error pages and outages are "busy"', async () => {
    expect(fromReply({ ok: true, data: 5 })).toBe(5);
    expect(() => fromReply({ ok: false, error: { kind: 'rejected', message: 'Bill not found' } })).toThrow('Bill not found');
    expect(() => fromReply({ ok: false, error: { kind: 'weird', message: 'x' } })).toThrow(expect.objectContaining({ kind: 'server' }));
    vi.stubGlobal('fetch', async () => new Response('<html>Service invoked too many times</html>', { status: 200 }));
    await expect(call('my_role', {})).rejects.toMatchObject({ kind: 'server', message: expect.stringContaining('busy or unreachable') });
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    await expect(call('my_role', {})).rejects.toMatchObject({ kind: 'offline' });
  });
});

describe('sign-in', () => {
  it('User ID + password; the session survives a restart; wrong passwords say so', async () => {
    const s = await signIn('  Owner ', 'owner-pass-123', T0);
    expect(s).toMatchObject({ username: 'owner', userId: 'owner', email: '' });
    resetAuthForTests();
    expect((await loadSession())?.accessToken).toBe(s.accessToken);
    await expect(signIn('owner', 'nope-nope-1', T0)).rejects.toThrow('Wrong User ID or password.');
    await expect(signIn('owner@tikka.test', 'owner-pass-123', T0)).rejects.toThrow('Wrong User ID or password.'); // no emails here
    expect(requests.filter((r) => r.fn === 'sign_in')).toHaveLength(2);
  });

  it('an expiring token is refreshed; a removed person is signed out; a busy sheet signs nobody out', async () => {
    await setUpAsOwner();
    await api.staffAdmin('add', 'counter1', 'counter-pass-1');
    await signOut();
    expect(requests.at(-1)?.fn).toBe('staff_admin'); // signing out tells nobody: only this phone
    const s = await signIn('counter1', 'counter-pass-1', T0);
    g.rt.clock = T0 + 13 * 3_600_000;
    const t = await accessToken(T0 + 13 * 3_600_000);
    expect(t).not.toBe(s.accessToken);
    expect(requests.at(-1)?.fn).toBe('refresh_session');

    g.rt.lockBusy = true;
    g.rt.evictCache = true;
    await expect(api.listStaff()).rejects.toBeInstanceOf(CloudError); // staff aren't allowed anyway, or busy
    expect(currentSession()).not.toBeNull();
    g.rt.lockBusy = false;
    g.rt.evictCache = false;

    // The owner removes counter1 (from another phone)
    const owner = g.post({ fn: 'sign_in', args: { username: 'owner', password: 'owner-pass-123' } }).data.accessToken;
    expect(g.post({ fn: 'staff_admin', token: owner, args: { action: 'remove', username: 'counter1' } }).ok).toBe(true);
    await expect(api.myRole()).rejects.toMatchObject({ kind: 'auth' });
    expect(currentSession()).toBeNull();
  });
});

describe('billing with the Google Sheet', () => {
  it('online: the sheet numbers the bill; it is in Main and Backup; the phone keeps it', async () => {
    await setUpAsOwner();
    const b = await saveBill(draft, T0);
    expect(b.billNo).toBe(`RCPT-${M}-0001`);
    expect(b.sync).toBeUndefined();
    expect(await getBill(b.billNo)).toMatchObject({ totalPaise: 90000 });
    expect(sheetBills().map((x) => x.billNo)).toEqual([b.billNo]);
    expect(g.records(g.backup(), `Bills ${M.slice(0, 4)}-${M.slice(4)}`)).toHaveLength(1);
  });

  it('no internet or a busy sheet: billing goes on with OFF- numbers, uploaded later exactly once', async () => {
    await setUpAsOwner();
    offline = true;
    const a = await saveBill(draft, T0);
    offline = false;
    g.rt.lockBusy = true; // another phone is saving: the sheet says "busy"
    const b = await saveBill(draft, T0 + 1000);
    expect([a.billNo, b.billNo]).toEqual([expect.stringMatching(/^OFF-/), expect.stringMatching(/^OFF-/)]);
    expect((await syncNow()).message).toContain('busy'); // the save started a background sync: let it finish
    g.rt.lockBusy = false;
    expect((await syncNow()).status).toBe('synced');
    expect(await pendingBills()).toEqual([]);
    expect(sheetBills().map((x) => x.printedAs)).toEqual([a.billNo, b.billNo]);
    expect((await getMonthlyStats(M))?.billCount).toBe(2); // not counted twice
    expect((await syncNow()).status).toBe('synced');
    expect(sheetBills()).toHaveLength(2);
  });

  it('a price changed on another phone: refused with the reason, nothing saved', async () => {
    await setUpAsOwner();
    const owner = g.post({ fn: 'sign_in', args: { username: 'owner', password: 'owner-pass-123' } }).data.accessToken;
    g.post({ fn: 'update_dish', token: owner, args: { p_id: 1, p_patch: { price_paise: 47000 } } });
    await expect(saveBill(draft, T0)).rejects.toThrow(BillError);
    await expect(saveBill(draft, T0)).rejects.toThrow('changed on another device');
    await syncNow();
    expect((await listMenu())[0]?.pricePaise).toBe(47000);
    expect((await saveBill(draft, T0)).billNo).toBe(`RCPT-${M}-0001`);
  });

  it('bills, voids and menu changes from other phones arrive with the next sync', async () => {
    await setUpAsOwner();
    const mine = await saveBill(draft, T0);
    const other = g.post({ fn: 'sign_in', args: { username: 'owner', password: 'owner-pass-123' } }).data.accessToken;
    const theirs = g.post({ fn: 'save_bill', token: other, args: { p_bill: { items: [{ menuId: 2, qty: 1, unitPaise: 6000 }], orderType: 'takeaway', paymentMode: 'cash', discount: { kind: 'flat', paise: 0 }, roundOffPaise: 0, totalPaise: 6000, cheesyLine: '' } } }).data;
    g.post({ fn: 'void_bill', token: other, args: { p_bill_no: mine.billNo, p_reason: 'Wrong table' } });
    await syncNow();
    expect(await getBill(theirs.billNo)).toBeTruthy();
    expect((await getBill(mine.billNo))?.status).toBe('void');
    expect(await getMonthlyStats(M)).toMatchObject({ billCount: 1, voidCount: 1, revenuePaise: 6000 });
    await voidBill(theirs.billNo, 'Test void');
    expect(sheetBills().find((x) => x.billNo === theirs.billNo)?.status).toBe('void');
  });

  it('menu, settings (tagline) and cheesy lines are saved in the sheet', async () => {
    await setUpAsOwner();
    const d = await addDish({ name: 'Paneer Roll', category: 'Rolls', pricePaise: 15000, isVeg: true, active: true });
    expect(d.id).toBe(3);
    expect(g.records(g.main(), 'Menu').map((x) => x.name)).toContain('Paneer Roll');
    await saveSettings({ tagline: 'Taste the Flame' });
    expect(g.records(g.main(), 'Settings')[0]).toMatchObject({ tagline: 'Taste the Flame', phone: '09137582060' });
    offline = true;
    await expect(addDish({ name: 'X', category: 'Y', pricePaise: 100, isVeg: true, active: true })).rejects.toThrow('need the internet');
  });

  it('Settings → Users on the sheet: add, change password, remove, and the backup status', async () => {
    await setUpAsOwner();
    await api.staffAdmin('add', 'counter2', 'counter-pass-2');
    await expect(api.staffAdmin('add', 'counter2', 'counter-pass-2')).rejects.toThrow('User ID counter2 is already used');
    await api.staffAdmin('reset', 'counter2', 'counter-pass-3');
    expect((await api.listStaff()).map((u) => u.username)).toEqual(['owner', 'counter2']);
    await api.staffAdmin('remove', 'counter2');
    expect(await api.sheetStatus()).toMatchObject({ backupOk: true, backupBehind: 0 });
    g.rt.failFiles.add(g.backupId());
    await saveBill(draft, T0);
    expect(await api.sheetStatus()).toMatchObject({ backupOk: false });
  });
});

describe('moving from Supabase to the Google Sheet', () => {
  it('a phone that was on Supabase forgets that sign-in and position, keeps its data and waiting bills', async () => {
    const db = await getDB();
    await setMeta('session', { accessToken: 'sb', refreshToken: 'sb', expiresAt: T0 + 9e6, userId: 'u', email: 'e', username: 'owner' });
    await setMeta('cloudDbId', 'supabase-db');
    await setMeta('cloudRev', 77);
    await applyChanges({ menu: DISHES.map((d) => ({ id: d.id, name: d.name, category: d.category, price_paise: d.pricePaise, is_veg: d.isVeg, active: true, deleted: false, used_in_bills: false, created_at: 1, updated_at: 1 })) });
    await setMeta('outbox', ['OFF-K7Q-0001']);
    expect(await forgetOtherDatabase()).toBe(true);
    expect([await getMeta('session'), await getMeta('cloudDbId'), await getMeta('cloudRev')]).toEqual([undefined, undefined, undefined]);
    expect(await getMeta('cloudBackend')).toBe(`sheets ${SHEETS}`);
    expect(await getMeta('outbox')).toEqual(['OFF-K7Q-0001']);
    expect(await db.count('menu')).toBe(2);
    expect(await forgetOtherDatabase()).toBe(false); // once only
  });

  it('a Supabase phone on a Supabase build keeps everything', async () => {
    setCloudConfigForTests({ backend: 'supabase', url: 'https://abcd.supabase.co', anonKey: 'anon-key-000000000000000000' });
    await setMeta('cloudDbId', 'supabase-db');
    expect(await forgetOtherDatabase()).toBe(false);
    expect(await getMeta('cloudDbId')).toBe('supabase-db');
  });

  it('the upload sends counters raised to the phone’s highest receipt numbers (so new bills never collide)', () => {
    const bill = (billNo: string) => ({ billNo }) as Bill;
    expect(countersFor([{ monthKey: '202609', last: 3 }], [bill('RCPT-202609-0009'), bill('INV-202608-0002'), bill('OFF-K7Q-0001')])).toEqual([
      { monthKey: '202609', last: 9 },
      { monthKey: '202608', last: 2 },
    ]);
  });
});
