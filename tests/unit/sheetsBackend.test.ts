/**
 * google-sheets/Code.gs (the shared database in Google Sheets), run on this PC against
 * tests/helpers/fakeAppsScript.mjs, which behaves like Google Sheets and Apps Script.
 *  - the same rules as supabase/schema.sql (cases ported from supabase/tests/*.sql)
 *  - the sheets can't get corrupted: crashes at every step, hand edits, the Backup
 *    being unreachable, formulas, long data, switching to the Backup
 * After every test: no write without the lock, no lock released before a flush, no formula.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRuntime, type FakeAppsScript, type FakeSpreadsheet, type Reply } from '../helpers/fakeAppsScript.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 25 Sep 2026, 13:00 India time. Kept months: July, August, September. */
const NOW = Date.UTC(2026, 8, 25, 7, 30);
const M = '202609';

let g: FakeAppsScript;
let token: string;

function ok<T = any>(r: Reply<T>): T {
  if (!r.ok) throw new Error(`${r.error?.kind}: ${r.error?.message}`);
  return r.data;
}
function refused(r: Reply, message: string, kind = 'rejected') {
  expect(r.ok, `expected a refusal: ${message}`).toBe(false);
  expect(r.error?.kind).toBe(kind);
  expect(r.error?.message).toContain(message);
}
const signIn = (username: string, password: string) => g.post({ fn: 'sign_in', args: { username, password } });
const call = (fn: string, args: Record<string, unknown> = {}, t: string = token) => g.post({ fn, args, token: t });

const DISHES = [
  { id: 1, name: 'Full Chicken', category: 'Grill Gali', pricePaise: 45000, isVeg: false, active: true, deleted: false, usedInBills: false, createdAt: 1, updatedAt: 2 },
  { id: 2, name: 'Masala Fries', category: 'Aloo Ke Laloo', pricePaise: 12050, isVeg: true, active: true, deleted: false, usedInBills: false, createdAt: 1, updatedAt: 2 },
  { id: 3, name: 'Lassi', category: 'Thanda Matter', pricePaise: 6000, isVeg: true, active: true, deleted: false, usedInBills: false, createdAt: 1, updatedAt: 2 },
];
const SETTINGS = { name: 'Tikka Bites', address: '', phone: '09137582060', currencySymbol: '₹', receiptWidth: '80', roundOff: true, printLogo: true };

function boot(now = NOW) {
  g = createRuntime({ now });
  g.exec('setup');
  g.exec('setOwnerLogin', 'owner', 'owner-pass-123');
  token = ok(signIn('owner', 'owner-pass-123')).accessToken;
}

function setUpShop(counters: { monthKey: string; last: number }[] = []) {
  ok(call('import_device_data', { p_menu: DISHES, p_lines: [{ id: 1, text: 'Thank you 🫓', builtIn: true, active: true }], p_settings: SETTINGS, p_counters: counters }));
  ok(call('finish_import'));
}

function body(items: [number, number, number][], extra: Record<string, unknown> = {}) {
  const sub = items.reduce((s, [, qty, unit]) => s + qty * unit, 0);
  return {
    items: items.map(([menuId, qty, unitPaise]) => ({ menuId, qty, unitPaise })),
    orderType: 'takeaway',
    paymentMode: 'cash',
    discount: { kind: 'flat', paise: 0 },
    roundOffPaise: 0,
    totalPaise: sub,
    cheesyLine: '',
    ...extra,
  };
}
const save = (b: Record<string, unknown>, t?: string) => call('save_bill', { p_bill: b }, t);
const billTab = (ss: FakeSpreadsheet, month = M) => g.records<{ bill: any; by: string; ref: string }>(ss, `Bills ${month.slice(0, 4)}-${month.slice(4)}`);
const counter = (ss: FakeSpreadsheet, month = M) => g.records<{ monthKey: string; last: number }>(ss, 'Counters').find((c) => c.monthKey === month)?.last;

/** Main and Backup hold exactly the same rows in every tab Main has. */
function expectBackupMatches() {
  const main = g.snapshot(g.main());
  const backup = g.snapshot(g.backup());
  const sortRows = (rows: unknown[][] = []) => [rows[0], ...rows.slice(1).map((r) => JSON.stringify(r)).sort()];
  for (const tab of Object.keys(main)) {
    if (tab === 'Read me') continue;
    expect(sortRows(backup[tab]), `tab ${tab}`).toEqual(sortRows(main[tab]));
  }
}

beforeEach(() => boot());

afterEach(() => {
  expect(g.rt.violations).toEqual([]);
  expect(g.rt.formulaWrites).toBe(0);
});

describe('set up', () => {
  it('makes Main and Backup with the same tabs: plain-text cells, frozen header, hidden data columns, protected', () => {
    const main = g.main();
    expect(main.getSheets().map((s) => s.name)).toEqual(['Read me', 'Settings', 'Menu', 'Cheesy lines', 'Users', 'Counters', 'Meta']);
    expect(g.backup().getSheets().map((s) => s.name)).toEqual(main.getSheets().map((s) => s.name));
    const menu = main.getSheetByName('Menu')!;
    expect(menu.dump()[0]).toEqual(['ID', 'Dish', 'Category', 'Price ₹', 'Veg', 'On menu', 'Deleted', 'Used in bills', 'Last edited', 'Rev', 'Data']);
    expect(menu.cols).toBe(11); // no empty columns wasting cells
    expect([...menu.hidden]).toEqual([10, 11]);
    expect(menu.protected).toBe(true);
    expect(g.rt.triggers).toEqual([expect.objectContaining({ fn: 'nightly', hour: 0, minute: 5, tz: 'Asia/Kolkata' })]);
    expect(g.rt.props.get('TOKEN_SECRET')).toMatch(/^[0-9a-f-]{72}$/);
  });

  it('running Set up again changes nothing', () => {
    const before = [g.mainId(), g.backupId()];
    expect(g.exec('setup')).toContain('Already set up');
    expect([g.mainId(), g.backupId()]).toEqual(before);
    expect(g.rt.triggers).toHaveLength(1);
  });

  it('the owner login is made from the Tikka Bites menu (typed by the owner)', () => {
    const alerts = g.useUi(['Boss', 'boss-pass-1234']);
    g.exec('menuOwnerLogin');
    expect(alerts.join(' ')).toContain('User ID "boss"');
    expect(ok(signIn('boss', 'boss-pass-1234')).username).toBe('boss');
    const users = g.records(g.main(), 'Users');
    expect(users.find((u) => u.username === 'boss')).toMatchObject({ role: 'super_admin', removed: false });
    expect(JSON.stringify(users)).not.toContain('boss-pass-1234'); // only a salted hash is stored
  });

  it('before setup is finished, phones are told the sheet is not ready', () => {
    const page = ok(call('pull_changes', { p_since: 0 }));
    expect(page).toMatchObject({ ready: false, settings: null, bills: [], keepFrom: '202607' });
    ok(call('import_device_data', { p_menu: DISHES, p_lines: [], p_settings: SETTINGS, p_counters: [] }));
    expect(ok(call('pull_changes', { p_since: 0 })).ready).toBe(false); // still moving the first phone's bills
    ok(call('finish_import'));
    expect(ok(call('pull_changes', { p_since: 0 })).ready).toBe(true);
  });
});

describe('sign-in: User ID + password, signed tokens', () => {
  it('a wrong password and an unknown User ID get the same answer', () => {
    refused(signIn('owner', 'wrong-pass-1'), 'Wrong User ID or password.', 'auth');
    refused(signIn('nobody', 'owner-pass-123'), 'Wrong User ID or password.', 'auth');
    refused(signIn('', ''), 'Enter your User ID and password.', 'auth');
    expect(ok(signIn('  OWNER ', 'owner-pass-123')).username).toBe('owner');
  });

  it('after 5 wrong tries that User ID waits 10 minutes', () => {
    for (let i = 0; i < 5; i++) refused(signIn('owner', `wrong-${i}-pass`), 'Wrong User ID', 'auth');
    refused(signIn('owner', 'owner-pass-123'), 'Too many sign-in tries', 'auth');
    g.rt.clock! += 11 * 60_000;
    expect(signIn('owner', 'owner-pass-123').ok).toBe(true);
  });

  it('no token, a forged token or an expired one: signed out; the refresh token gets a new one', () => {
    refused(call('my_role', {}, ''), 'sign-in has expired', 'auth');
    const [body_, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body_!, 'base64url').toString()), u: 'counter9' })).toString('base64url');
    refused(call('my_role', {}, `${forged}.${sig}`), 'sign-in has expired', 'auth');
    const s = ok(signIn('owner', 'owner-pass-123'));
    expect(s.expiresAt).toBe(NOW + 12 * HOUR);
    g.rt.clock! += 13 * HOUR;
    refused(call('my_role', {}, s.accessToken), 'sign-in has expired', 'auth');
    refused(g.post({ fn: 'refresh_session', args: { refreshToken: s.accessToken } }), 'sign-in has expired', 'auth'); // an access token is not a refresh token
    const again = ok(g.post({ fn: 'refresh_session', args: { refreshToken: s.refreshToken } }));
    expect(ok(call('my_role', {}, again.accessToken))).toBe('super_admin');
  });

  it('a password changed by the owner, or a removed user: signed out on every phone', () => {
    ok(call('staff_admin', { action: 'add', username: 'counter1', password: 'counter-pass-1' }));
    const c = ok(signIn('counter1', 'counter-pass-1'));
    expect(ok(call('my_role', {}, c.accessToken))).toBe('staff');
    ok(call('staff_admin', { action: 'reset', username: 'counter1', password: 'counter-pass-2' }));
    refused(call('my_role', {}, c.accessToken), 'sign-in has expired', 'auth');
    refused(g.post({ fn: 'refresh_session', args: { refreshToken: c.refreshToken } }), 'sign-in has expired', 'auth');
    const c2 = ok(signIn('counter1', 'counter-pass-2'));
    ok(call('staff_admin', { action: 'remove', username: 'counter1' }));
    refused(call('pull_changes', { p_since: 0 }, c2.accessToken), 'sign-in has expired', 'auth');
    refused(signIn('counter1', 'counter-pass-2'), 'Wrong User ID or password.', 'auth');
  });

  it('changing your own password keeps you signed in here', () => {
    ok(call('staff_admin', { action: 'reset', username: 'owner', password: 'owner-pass-456' }));
    expect(ok(call('my_role'))).toBe('super_admin');
    refused(signIn('owner', 'owner-pass-123'), 'Wrong User ID', 'auth');
    expect(signIn('owner', 'owner-pass-456').ok).toBe(true);
  });
});

describe('bills: the same rules as the SQL server', () => {
  beforeEach(() => setUpShop());

  it('numbers from 0001; money math matches the app; item snapshot; table only for dine-in', () => {
    // 2 × 450 + 120.50 = 1020.50; −10% = 102.05 (half-up) → 918.45 → rounds to 918.00 (−0.45)
    const b = ok(save({ ...body([[1, 2, 45000], [2, 1, 12050]]), orderType: 'dine-in', tableNo: ' 4 ', customerName: 'Asha', paymentMode: 'upi', discount: { kind: 'pct', bp: 1000 }, roundOffPaise: -45, totalPaise: 91800, cheesyLine: 'Totally worth it 😋' }));
    expect(b).toMatchObject({ billNo: `RCPT-${M}-0001`, subtotalPaise: 102050, discountPaise: 10205, roundOffPaise: -45, totalPaise: 91800, itemCount: 3, tableNo: '4', customerName: 'Asha', status: 'paid', monthKey: M, hour: 13, weekday: 5, cheesyLine: 'Totally worth it 😋' });
    expect(b.items[0]).toEqual({ menuId: 1, name: 'Full Chicken', category: 'Grill Gali', isVeg: false, unitPaise: 45000, qty: 2, linePaise: 90000 });
    expect([b.categories, b.hasVeg, b.hasNonVeg]).toEqual([['Grill Gali', 'Aloo Ke Laloo'], true, true]);
    const b2 = ok(save({ ...body([[2, 1, 12050]]), tableNo: '9', roundOffPaise: 50, totalPaise: 12100 }));
    expect(b2.billNo).toBe(`RCPT-${M}-0002`);
    expect('tableNo' in b2).toBe(false);
    const menu = g.records(g.main(), 'Menu');
    expect(menu.filter((d) => d.used_in_bills).map((d) => d.id)).toEqual([1, 2]);
    expect(menu.find((d) => d.id === 1).updated_at).toBe(2); // being billed is not an edit
    // The readable columns, for people
    const row = g.rows(g.main(), 'Bills 2026-09')[0]!;
    expect(row.slice(0, 23)).toEqual([
      `RCPT-${M}-0001`, '25-09-2026', '13:00', 'Friday', 'Dine-in', '4', 'Asha', 'UPI',
      '2 × Full Chicken @ ₹450 = ₹900; 1 × Masala Fries @ ₹120.50 = ₹120.50', 3, 'Grill Gali, Aloo Ke Laloo', 'Veg + Non-veg',
      1020.5, '10%', 102.05, -0.45, 918, 'Paid', '', '', 'owner', '', 'Totally worth it 😋',
    ]);
  });

  it('a retry with the same clientRef gets the SAME bill; a new ref the next number', () => {
    const b = { ...body([[2, 2, 12050]]), clientRef: randomUUID() };
    const b1 = ok(save(b));
    const b2 = ok(save(b));
    expect(b2).toEqual(b1);
    expect(billTab(g.main())).toHaveLength(1);
    expect(ok(save({ ...b, clientRef: randomUUID() })).billNo).toBe(`RCPT-${M}-0002`);
    refused(save({ ...b, clientRef: 'not-a-uuid' }), 'Invalid bill reference');
    expect('clientRef' in b1).toBe(false);
  });

  it('bad or tampered bills are refused, and use up no receipt number', () => {
    ok(save(body([[1, 1, 45000]])));
    refused(save(body([[1, 1, 44000]])), 'The price of Full Chicken was changed on another device');
    refused(save({ ...body([[1, 1, 45000]]), totalPaise: 100 }), 'Totals do not add up');
    refused(save({ ...body([[1, 1, 45000]]), roundOffPaise: 7, totalPaise: 45007 }), 'Totals do not add up');
    refused(save(body([[1, 1000, 45000]])), 'Invalid item');
    refused(save(body([[1, 0, 45000]])), 'Quantity must be a whole number 1–999');
    refused(save(body([[99, 1, 45000]])), 'no longer on the menu');
    refused(save(body([[1, 1, 45000], [1, 1, 45000]])), 'appears twice');
    refused(save({ ...body([[1, 1, 45000]]), paymentMode: 'card' }), 'Invalid payment mode');
    refused(save({ ...body([[1, 1, 45000]]), orderType: 'drive-thru' }), 'Invalid order type');
    refused(save({ ...body([]), totalPaise: 0 }), 'Add at least one item');
    refused(save({ ...body([[1, 1, 45000]]), discount: { kind: 'pct', bp: 10001 } }), 'Invalid discount');
    refused(save({ ...body([[1, 1, 45000]]), customerName: 'x'.repeat(61) }), 'Some text in the bill is too long');
    refused(call('save_bill', { p_bill: 'nope' }), 'Add at least one item');
    expect(counter(g.main())).toBe(1);
    expect(ok(save(body([[1, 1, 45000]]))).billNo).toBe(`RCPT-${M}-0002`);
  });

  it('offline bills keep their sale time, month, price and printed number', () => {
    // 23:50 on the last day of last month, India time
    const at = Date.UTC(2026, 7, 31, 18, 20);
    const ref = randomUUID();
    ok(call('update_dish', { p_id: 3, p_patch: { price_paise: 6500 } })); // the price changed after the sale
    const off = {
      offline: true, createdAt: at, printedAs: 'OFF-K7Q-0003', clientRef: ref,
      items: [{ menuId: 3, qty: 2, unitPaise: 6000, name: 'Sweet Lassi', category: 'Thanda Matter', isVeg: true }],
      orderType: 'takeaway', paymentMode: 'upi', discount: { kind: 'flat', paise: 0 }, roundOffPaise: 0, totalPaise: 12000, cheesyLine: '',
    };
    const b = ok(save(off));
    expect(b).toMatchObject({ billNo: 'RCPT-202608-0001', monthKey: '202608', createdAt: at, hour: 23, printedAs: 'OFF-K7Q-0003' });
    expect(b.items[0]).toMatchObject({ unitPaise: 6000, name: 'Sweet Lassi' });
    expect(ok(save(off))).toEqual(b); // a retry gets the same bill
    expect(billTab(g.main(), '202608')).toHaveLength(1);

    ok(call('update_dish', { p_id: 3, p_patch: { deleted: true } }));
    const recent = ok(save({ ...off, clientRef: randomUUID(), createdAt: NOW - 60_000, printedAs: 'OFF-K7Q-0004' }));
    expect(recent.monthKey).toBe(M); // a dish deleted since still uploads (it was sold)
    refused(save(body([[3, 1, 6500]])), 'no longer on the menu'); // but not online

    const bad = (patch: Record<string, unknown>, msg: string) => refused(save({ ...off, clientRef: randomUUID(), ...patch }), msg);
    bad({ createdAt: NOW + HOUR }, 'time in the future');
    bad({ createdAt: NOW - 40 * DAY }, 'more than 35 days old');
    bad({ createdAt: 'yesterday' }, 'Invalid time');
    bad({ printedAs: 'RCPT-1' }, 'Invalid offline bill number');
    bad({ totalPaise: 999 }, 'Totals do not add up');
    bad({ items: [{ menuId: 3, qty: 1, unitPaise: 0 }], totalPaise: 0 }, 'Invalid item');
  });

  it('an ONLINE bill cannot claim a time: the server clock wins', () => {
    const b = ok(save({ ...body([[1, 1, 45000]]), createdAt: 1, printedAs: 'OFF-K7Q-0001' }));
    expect(b.createdAt).toBe(NOW);
    expect('printedAs' in b).toBe(false);
  });

  it('void keeps the bill (audit trail), once only, with a reason', () => {
    const b = ok(save(body([[1, 1, 45000]])));
    const v = ok(call('void_bill', { p_bill_no: b.billNo, p_reason: '  Wrong table\u0007 ' }));
    expect(v).toMatchObject({ status: 'void', voidReason: 'Wrong table', voidedAt: NOW });
    expect(billTab(g.main())[0]!.bill.status).toBe('void');
    expect(g.rows(g.main(), 'Bills 2026-09')[0]!.slice(17, 20)).toEqual(['Void', expect.any(String), expect.stringMatching(/^\d\d-\d\d-2026 \d\d:\d\d$/)]);
    refused(call('void_bill', { p_bill_no: b.billNo, p_reason: 'again' }), 'already voided');
    refused(call('void_bill', { p_bill_no: b.billNo, p_reason: 'no' }), 'at least 3 characters');
    refused(call('void_bill', { p_bill_no: 'RCPT-190001-0001', p_reason: 'nope' }), 'Bill not found');
    refused(call('void_bill', { p_bill_no: 'x', p_reason: 'nope' }), 'Bill not found');
  });
});

describe('sync: pull_changes', () => {
  beforeEach(() => setUpShop());

  it('every change exactly once, page by page; then only what changed', () => {
    for (let i = 0; i < 12; i++) ok(save(body([[1 + (i % 3), 1, [45000, 12050, 6000][i % 3]!]])));
    let since = 0;
    let pages = 0;
    const bills: string[] = [];
    let menu = 0;
    let page;
    do {
      page = ok(call('pull_changes', { p_since: since, p_limit: 4 }));
      pages++;
      expect(page.bills.length + page.menu.length + page.lines.length + (page.settings ? 1 : 0)).toBeLessThanOrEqual(4);
      expect(page.rev).toBeGreaterThanOrEqual(since);
      bills.push(...page.bills.map((b: { billNo: string }) => b.billNo));
      menu += page.menu.length;
      since = page.rev;
    } while (page.more);
    expect(bills).toHaveLength(12);
    expect(new Set(bills).size).toBe(12);
    expect(menu).toBeGreaterThanOrEqual(3);
    expect(pages).toBeGreaterThan(3);
    const clock = Number(g.records(g.main(), 'Meta').find((m) => m.key === 'rev').value);
    expect(since).toBe(clock);

    ok(call('update_dish', { p_id: 2, p_patch: { active: false } }));
    page = ok(call('pull_changes', { p_since: since }));
    expect(page.menu).toEqual([expect.objectContaining({ id: 2, active: false, rev: clock + 1 })]);
    expect([page.bills, page.more, page.rev]).toEqual([[], false, clock + 1]);
    expect(ok(call('pull_changes', { p_since: clock + 1000 })).rev).toBe(clock + 1000); // a cursor from the future: unchanged (the app checks dbId)
  });

  it('"nothing new" is answered from the cache without touching the sheet, and agrees with the sheet', () => {
    const page = ok(call('pull_changes', { p_since: 0 }));
    const quick = ok(call('pull_changes', { p_since: page.rev }));
    g.rt.evictCache = true; // Google may drop cache entries at any time
    const slow = ok(call('pull_changes', { p_since: page.rev }));
    expect(quick).toEqual(slow);
    expect(quick).toMatchObject({ bills: [], dbId: page.dbId, ready: true, more: false, rev: page.rev });
  });

  it('few property reads per request (Google allows about 50,000 a day; phones ask every 30 s)', () => {
    const page = ok(call('pull_changes', { p_since: 0 }));
    let before = g.rt.propReads;
    ok(call('pull_changes', { p_since: page.rev })); // "anything new?" — the most common request
    expect(g.rt.propReads - before).toBe(1);
    before = g.rt.propReads;
    ok(save(body([[1, 1, 45000]])));
    expect(g.rt.propReads - before).toBeLessThanOrEqual(2);
  });

  it('settings (with the logo) are sent only when they changed', () => {
    const first = ok(call('pull_changes', { p_since: 0 }));
    expect(first.settings).toMatchObject({ name: 'Tikka Bites' });
    ok(save(body([[1, 1, 45000]])));
    expect(ok(call('pull_changes', { p_since: first.rev })).settings).toBeNull();
  });
});

describe('settings: merged and checked on the server', () => {
  beforeEach(() => setUpShop());

  it('merges, removes, and refuses bad values', () => {
    let s = ok(call('patch_settings', { p_set: { phone: '0123456789' } }));
    expect(s).toMatchObject({ phone: '0123456789', name: 'Tikka Bites', roundOff: true });
    s = ok(call('patch_settings', { p_set: { tagline: 'Taste the Flame' } }));
    expect(s.tagline).toBe('Taste the Flame');
    s = ok(call('patch_settings', { p_set: { roundOff: false }, p_unset: ['tagline'] }));
    expect(s).not.toHaveProperty('tagline');
    const bad = (p_set: unknown, p_unset?: unknown) => refused(call('patch_settings', { p_set, p_unset }), 'Invalid settings');
    bad({ tagline: 'x'.repeat(61) });
    bad({ tagline: 42 });
    bad({ receiptWidth: '100' });
    bad({ name: '' });
    bad({ roundOff: 'yes' });
    bad({ logoDataUrl: 'javascript:alert(1)' });
    bad({ logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' });
    bad({ isAdmin: true });
    bad({ logoDataUrl: `data:image/png;base64,${'A'.repeat(700001)}` });
    bad([]);
    bad({}, ['name']);
    // The readable Phone column keeps its leading zero (plain-text cell)
    expect(g.rows(g.main(), 'Settings')[0]!.slice(0, 4)).toEqual(['app', 'Tikka Bites', '0123456789', '']);
  });

  it('a 700 KB logo is split over several cells and comes back exactly', () => {
    const logo = `data:image/webp;base64,${'QUJD'.repeat(174_990)}`;
    expect(logo.length).toBeLessThanOrEqual(700000);
    ok(call('patch_settings', { p_set: { logoDataUrl: logo } }));
    const row = g.rows(g.main(), 'Settings')[0]!;
    expect(row.filter((c) => String(c).startsWith('j:')).length).toBe(16);
    expect(ok(call('pull_changes', { p_since: 0 })).settings.logoDataUrl).toBe(logo);
    expect(g.records(g.backup(), 'Settings')[0].logoDataUrl).toBe(logo);
  });
});

describe('moving the first phone in', () => {
  it('ids kept, numbering continues after the phone (and after old INV- bills); twice is harmless', () => {
    refused(call('patch_settings', { p_set: { phone: '1' } }), 'not set up yet');
    refused(call('import_device_data', { p_menu: [], p_lines: [], p_settings: { name: '' }, p_counters: [] }), 'Invalid settings');
    expect(g.records(g.main(), 'Settings')).toEqual([]); // a refused import writes nothing
    ok(call('import_device_data', { p_menu: [DISHES[0], { ...DISHES[2], id: 9 }], p_lines: [{ id: 4, text: 'Mine', active: false }], p_settings: { ...SETTINGS, lastBackupAt: 1700000000000 }, p_counters: [{ monthKey: M, last: 18 }, { monthKey: '202401', last: 7 }] }));
    // Billing can already go on safely while the old bills upload
    expect(ok(save(body([[1, 1, 45000]]))).billNo).toBe(`RCPT-${M}-0019`);
    const bills = [
      { billNo: `INV-${M}-0017`, createdAt: 1, monthKey: M, status: 'paid', items: [] },
      { billNo: `RCPT-${M}-0018`, createdAt: 2, monthKey: M, status: 'void', items: [], sync: { clientRef: 'x' } },
    ];
    expect(ok(call('import_bills', { p_bills: bills }))).toBe(2);
    expect(ok(call('import_bills', { p_bills: bills }))).toBe(0);
    expect(ok(call('import_bills', { p_bills: [{ billNo: 'INV-202001-0001', createdAt: 1, monthKey: '202001', status: 'paid' }] }))).toBe(0); // older than 3 months
    refused(call('import_bills', { p_bills: [{ billNo: `RCPT-${M}-0001`, createdAt: 1, monthKey: '202608', status: 'paid' }] }), 'Invalid bill from the phone');
    ok(call('finish_import'));
    expect(ok(save(body([[1, 1, 45000]]))).billNo).toBe(`RCPT-${M}-0020`);
    expect(ok(call('insert_dishes', { p_rows: [{ name: 'Soft Drink', category: 'Thanda Matter', price_paise: 2000, is_veg: true }] }))[0].id).toBe(10);
    expect(ok(call('insert_line', { p_text: 'New line' })).id).toBe(5);
    expect(billTab(g.main())).toHaveLength(4);
    expect(billTab(g.main()).find((b) => b.bill.billNo.endsWith('0018'))!.bill).not.toHaveProperty('sync');
    refused(call('import_bills', { p_bills: [] }), 'only allowed while setting up');
    refused(call('import_device_data', { p_menu: [], p_lines: [], p_settings: SETTINGS, p_counters: [] }), 'already set up');
    expectBackupMatches();
  });

  it('an interrupted setup can be run again from the start (nothing is doubled)', () => {
    ok(call('import_device_data', { p_menu: DISHES, p_lines: [{ id: 1, text: 'One', active: true }], p_settings: SETTINGS, p_counters: [] }));
    ok(call('import_bills', { p_bills: [{ billNo: `RCPT-${M}-0001`, createdAt: NOW, monthKey: M, status: 'paid', items: [] }] }));
    // the phone was closed here; next time it starts over
    ok(call('import_device_data', { p_menu: DISHES, p_lines: [{ id: 1, text: 'One', active: true }], p_settings: SETTINGS, p_counters: [] }));
    expect(ok(call('import_bills', { p_bills: [{ billNo: `RCPT-${M}-0001`, createdAt: NOW, monthKey: M, status: 'paid', items: [] }] }))).toBe(0);
    ok(call('finish_import'));
    expect(g.records(g.main(), 'Menu')).toHaveLength(3);
    expect(g.records(g.main(), 'Cheesy lines')).toHaveLength(1);
    expect(billTab(g.main())).toHaveLength(1);
  });
});

describe('menu and cheesy lines', () => {
  beforeEach(() => setUpShop());

  it('add, edit, hide and soft-delete dishes; the server keeps the edit time', () => {
    const [d] = ok(call('insert_dishes', { p_rows: [{ name: 'Paneer Roll', category: 'Rolls', price_paise: 15000, is_veg: true, active: true }] }));
    expect(d).toMatchObject({ id: 4, deleted: false, used_in_bills: false, created_at: NOW, updated_at: NOW });
    g.rt.clock! += 1000;
    const e = ok(call('update_dish', { p_id: 4, p_patch: { price_paise: 16000 } }));
    expect(e).toMatchObject({ price_paise: 16000, updated_at: NOW + 1000 });
    expect(ok(call('update_dish', { p_id: 4, p_patch: { deleted: true, active: false } }))).toMatchObject({ deleted: true });
    refused(call('insert_dishes', { p_rows: [{ name: 'x', category: 'y', price_paise: 1, is_veg: true, used_in_bills: true }] }), 'Invalid dish');
    refused(call('update_dish', { p_id: 1, p_patch: { rev: 1 } }), 'Invalid dish change');
    refused(call('update_dish', { p_id: 1, p_patch: { price_paise: 0 } }), 'Price must be');
    refused(call('update_dish', { p_id: 1, p_patch: { name: '' } }), 'Dish name must be 1–60');
    refused(call('update_dish', { p_id: 77, p_patch: { active: true } }), 'Dish not found');
    expect(g.rows(g.main(), 'Menu')).toHaveLength(4); // never a deleted row
  });

  it('lines: add, edit, remove (kept as a marker for other phones)', () => {
    const l = ok(call('insert_line', { p_text: 'Naan to our curry' }));
    expect(l).toMatchObject({ id: 2, built_in: false, active: true, removed: false });
    expect(ok(call('update_line', { p_id: 2, p_patch: { removed: true } }))).toMatchObject({ removed: true });
    refused(call('update_line', { p_id: 1, p_patch: { built_in: false } }), 'Invalid cheesy line change');
    refused(call('insert_line', { p_text: 'x'.repeat(121) }), 'A cheesy line must be 1–120 characters');
  });
});

describe('users (super admin only)', () => {
  beforeEach(() => setUpShop());

  it('list, add, change password, remove — with the same rules as Supabase', () => {
    expect(ok(call('my_role'))).toBe('super_admin');
    ok(call('staff_admin', { action: 'add', username: ' Counter1 ', password: 'counter-pass-1' }));
    expect(ok(call('list_staff')).map((u: { username: string; role: string; me: boolean }) => [u.username, u.role, u.me])).toEqual([['owner', 'super_admin', true], ['counter1', 'staff', false]]);
    refused(call('staff_admin', { action: 'add', username: 'counter1', password: 'counter-pass-1' }), 'User ID counter1 is already used');
    refused(call('staff_admin', { action: 'add', username: 'Bad Name', password: 'counter-pass-1' }), 'User ID must be 2–30 characters');
    refused(call('staff_admin', { action: 'add', username: 'counter2', password: 'short' }), 'Password must be at least 8 characters');
    refused(call('staff_admin', { action: 'add', username: 'counter2', password: ' spaced-pass ' }), 'cannot start or end with a space');
    refused(call('staff_admin', { action: 'reset', username: 'nobody', password: 'whatever-1' }), 'No user called nobody');
    refused(call('staff_admin', { action: 'remove', username: 'owner' }), 'You cannot remove yourself');
    refused(call('staff_admin', { action: 'explode', username: 'counter1' }), 'Unknown action');

    const staff = ok(signIn('counter1', 'counter-pass-1')).accessToken;
    expect(ok(call('my_role', {}, staff))).toBe('staff');
    refused(call('list_staff', {}, staff), 'Only the super admin can manage users.');
    refused(call('staff_admin', { action: 'remove', username: 'counter1' }, staff), 'Only the super admin can manage users.');
    refused(call('sheet_status', {}, staff), 'Only the super admin');
    expect(ok(save(body([[1, 1, 45000]]), staff)).billNo).toBe(`RCPT-${M}-0001`); // staff can bill
    expect(billTab(g.main())[0]!.by).toBe('counter1');

    g.exec('setOwnerLogin', 'boss', 'boss-pass-1234');
    refused(call('staff_admin', { action: 'reset', username: 'boss', password: 'new-pass-123' }), 'Only that super admin can change their own password');
    refused(call('staff_admin', { action: 'remove', username: 'boss' }), 'A super admin can only be removed from the Control sheet');

    ok(call('staff_admin', { action: 'remove', username: 'counter1' }));
    expect(ok(call('list_staff')).map((u: { username: string }) => u.username)).toEqual(['boss', 'owner']);
    ok(call('staff_admin', { action: 'add', username: 'counter1', password: 'counter-pass-9' })); // the User ID can be used again
    expect(signIn('counter1', 'counter-pass-9').ok).toBe(true);
    expectBackupMatches(); // logins are in the Backup too (so switching to it keeps them)
  });
});

describe('keep 3 months: Main clears old months, the Backup keeps them all', () => {
  it('on 1 October the oldest month (July) leaves Main, stays in the Backup; offline bills for it are refused', () => {
    g = createRuntime({ now: Date.UTC(2026, 6, 20, 6, 0) }); // 20 July
    g.exec('setup');
    g.exec('setOwnerLogin', 'owner', 'owner-pass-123');
    token = ok(signIn('owner', 'owner-pass-123')).accessToken;
    setUpShop();
    ok(save(body([[1, 1, 45000]])));
    g.rt.clock = Date.UTC(2026, 7, 10, 6, 0); // August
    token = ok(signIn('owner', 'owner-pass-123')).accessToken;
    ok(save(body([[1, 1, 45000]])));
    expect(ok(call('purge_old_months'))).toBe(0);

    g.rt.clock = Date.UTC(2026, 8, 30, 18, 29); // 30 Sep 23:59 IST: July is still kept
    token = ok(signIn('owner', 'owner-pass-123')).accessToken;
    expect(ok(call('pull_changes', { p_since: 0 })).keepFrom).toBe('202607');
    expect(ok(call('purge_old_months'))).toBe(0);
    g.rt.clock = Date.UTC(2026, 8, 30, 18, 31); // 1 Oct 00:01 IST
    expect(ok(call('pull_changes', { p_since: 0 })).keepFrom).toBe('202608');
    expect(ok(call('purge_old_months'))).toBe(1);
    expect(ok(call('purge_old_months'))).toBe(0);
    expect(g.main().getSheetByName('Bills 2026-07')).toBeNull();
    expect(billTab(g.backup(), '202607')).toHaveLength(1); // kept in the Backup
    expect(billTab(g.main(), '202608')).toHaveLength(1);
    refused(save({ ...body([[1, 1, 45000]]), offline: true, createdAt: Date.UTC(2026, 8, 30, 18, 0) - 70 * DAY, clientRef: randomUUID() }), 'more than 35 days old');
    refused(save({ ...body([[1, 1, 45000]]), offline: true, createdAt: Date.UTC(2026, 6, 31, 12, 0), clientRef: randomUUID() }), 'more than 35 days old');
  });

  it('a month is never cleared from Main while the Backup is unreachable', () => {
    setUpShop();
    ok(save(body([[1, 1, 45000]])));
    g.rt.clock = Date.UTC(2026, 11, 2, 6, 0); // December: September is too old
    token = ok(signIn('owner', 'owner-pass-123')).accessToken;
    g.rt.failFiles.add(g.backupId());
    expect(ok(call('purge_old_months'))).toBe(0);
    expect(g.main().getSheetByName('Bills 2026-09')).not.toBeNull();
    g.rt.failFiles.clear();
    expect(ok(call('purge_old_months'))).toBe(1);
    expect(billTab(g.backup())).toHaveLength(1);
  });

  it('the nightly job: Backup caught up, old months cleared, a dated copy kept (14 at most), check written', () => {
    setUpShop();
    ok(save(body([[1, 1, 45000]])));
    for (let i = 0; i < 16; i++) {
      g.rt.clock! += DAY;
      g.exec('nightly');
    }
    const copies = [...g.rt.files.values()].filter((f) => 'sheets' in f && f.name.startsWith('Tikka Bites – Main 2026')) as FakeSpreadsheet[];
    expect(copies.filter((c) => !c.trashed)).toHaveLength(14);
    expect(copies.filter((c) => c.trashed)).toHaveLength(2);
    expect(JSON.parse(g.rt.props.get('HEALTH')!)).toMatchObject({ ok: true, problems: [] });
    const status = g.control.getSheetByName('Status')!.dump().slice(1, 4).map((r) => [r[1], r[2]]);
    expect(status).toEqual([
      ['Nightly', 'Backup sheet: up to date'],
      ['Nightly', expect.stringMatching(/^Copy saved: Tikka Bites – Main 2026-10-1\d 13\.00$/)],
      ['Nightly', 'Check: everything is fine'],
    ]);
  });
});

describe('the sheets cannot get corrupted', () => {
  beforeEach(() => setUpShop());

  it('a crash after ANY single write of a save leaves valid sheets; the retry never gives a second receipt', () => {
    // How many writes a normal save makes (Main + Backup), on a fresh copy of the same state.
    const probe = createRuntime({ now: NOW });
    const steps = (() => {
      const saved = g;
      g = probe;
      g.exec('setup');
      g.exec('setOwnerLogin', 'owner', 'owner-pass-123');
      const t = token;
      token = ok(signIn('owner', 'owner-pass-123')).accessToken;
      setUpShop();
      const before = g.rt.writes;
      ok(save({ ...body([[1, 1, 45000]]), clientRef: randomUUID() }));
      const n = g.rt.writes - before;
      g = saved;
      token = t;
      return n;
    })();
    expect(steps).toBeGreaterThan(8);

    for (let n = 0; n < steps; n++) {
      boot();
      setUpShop();
      const b = { ...body([[1, 1, 45000]]), clientRef: randomUUID() };
      g.rt.failAfter = g.rt.writes + n;
      const first = save(b); // crashes at write n+1 (maybe in the Backup, after Main is done)
      g.rt.failAfter = Infinity;
      const retry = ok(save(b));
      if (first.ok) expect(retry).toEqual(first.data);
      const other = ok(save({ ...body([[2, 1, 12050]]), clientRef: randomUUID() }));
      const nos = billTab(g.main()).map((x) => x.bill.billNo);
      expect(new Set(nos).size, `crash at write ${n + 1}`).toBe(nos.length); // never the same number twice
      expect(nos.filter((x) => x === retry.billNo)).toHaveLength(1);
      expect(nos).toContain(other.billNo);
      expect(Number(other.billNo.slice(-4))).toBeGreaterThan(Number(retry.billNo.slice(-4)));
      expect(counter(g.main())).toBeGreaterThanOrEqual(Number(other.billNo.slice(-4)));
      expectBackupMatches(); // the next request copied whatever the Backup missed
      expect(g.exec('healthCheck'), `crash at write ${n + 1}`).toMatchObject({ ok: true });
      expect(g.rt.violations).toEqual([]);
    }
  });

  it('saves one after another get 1, 2, 3 … with no gaps or repeats; a busy lock writes nothing', () => {
    const nos = Array.from({ length: 20 }, () => ok(save({ ...body([[3, 1, 6000]]), clientRef: randomUUID() })).billNo);
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => `RCPT-${M}-${String(i + 1).padStart(4, '0')}`));
    g.rt.lockBusy = true;
    const writes = g.rt.writes;
    refused(save(body([[3, 1, 6000]])), 'The Google Sheet is busy', 'server');
    expect(g.rt.writes).toBe(writes);
  });

  it('a column moved by hand: nothing is written and the app is told what changed; undo fixes it', () => {
    const menu = g.main().getSheetByName('Menu')!;
    menu.handEdit((sh) => sh.insertColumnsAfter(2, 1));
    const writes = g.rt.writes;
    const r = save(body([[1, 1, 45000]]));
    refused(r, 'The Main Google Sheet was changed by hand (tab "Menu": column C should be "Category"', 'server');
    expect(g.rt.writes).toBe(writes);
    menu.handEdit((sh) => sh.deleteColumns(3, 1));
    expect(ok(save(body([[1, 1, 45000]]))).billNo).toBe(`RCPT-${M}-0001`);
  });

  it('a renamed tab or a damaged Data cell is reported, never guessed', () => {
    ok(save(body([[1, 1, 45000]])));
    const bills = g.main().getSheetByName('Bills 2026-09')!;
    bills.handEdit((sh) => sh.getRange(2, sh.dump()[0]!.indexOf('Data') + 1).setValues([['j:{"bill":{"billNo"']]));
    refused(call('pull_changes', { p_since: 0 }), 'damaged row (Main › Bills 2026-09 row 2)', 'server');
    const h = g.exec('healthCheck');
    expect(h.ok).toBe(false);
    expect(h.problems.join(' ')).toContain('damaged row');
    g.main().getSheetByName('Users')!.name = 'People';
    refused(call('my_role'), 'The Main Google Sheet is missing its "Users" tab', 'server');
    refused(signIn('owner', 'owner-pass-123'), 'missing its "Users" tab', 'server');
  });

  it('the Backup unreachable: Main still saves; the Backup catches up exactly afterwards', () => {
    g.rt.failFiles.add(g.backupId());
    const a = ok(save(body([[1, 1, 45000]])));
    ok(call('void_bill', { p_bill_no: a.billNo, p_reason: 'Wrong table' }));
    ok(call('update_dish', { p_id: 2, p_patch: { price_paise: 13000 } }));
    const st = ok(call('sheet_status'));
    expect(st).toMatchObject({ backupOk: false, backupBehind: 4 });
    expect(st.backupError).toContain('can\'t be opened');
    g.rt.failFiles.clear();
    ok(save(body([[2, 1, 13000]])));
    expect(ok(call('sheet_status'))).toMatchObject({ backupOk: true, backupBehind: 0, backupError: null });
    expectBackupMatches();
  });

  it('text never becomes a formula or a number: names, phones, leading zeros', () => {
    const b = ok(save({ ...body([[1, 1, 45000]]), orderType: 'dine-in', tableNo: '007', customerName: '=HYPERLINK("http://x","y")' }));
    expect(b.customerName).toBe('=HYPERLINK("http://x","y")');
    expect(b.tableNo).toBe('007');
    const row = g.rows(g.main(), 'Bills 2026-09')[0]!;
    expect(row[5]).toBe('007');
    expect(row[6]).toBe('\'=HYPERLINK("http://x","y")');
    ok(call('insert_dishes', { p_rows: [{ name: '+91 Special', category: '@home', price_paise: 100, is_veg: true }] }));
    expect(g.records(g.main(), 'Menu').at(-1)).toMatchObject({ name: '+91 Special', category: '@home' });
    expect(ok(call('pull_changes', { p_since: 0 })).bills[0].customerName).toBe('=HYPERLINK("http://x","y")');
  });

  it('long records are split between cells without breaking an emoji', () => {
    for (const lead of [44998, 44999, 45000]) {
      const json = 'a'.repeat(lead) + '😀' + 'b'.repeat(10);
      const cells = g.exec('dataCells', json, 3, 'x') as string[];
      expect(cells.map((c) => c.slice(2)).join('')).toBe(json);
      for (const c of cells) expect(c.length).toBeLessThanOrEqual(45002);
      expect(cells.every((c) => !/[\ud800-\udbff]$/.test(c))).toBe(true);
    }
    expect(() => g.exec('dataCells', 'x'.repeat(45001), 1, 'This bill')).toThrow('This bill is too large');
  });

  it('300 random changes with the Backup sometimes unreachable: Main and Backup end up identical', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const saved: string[] = [];
    const prices: Record<number, number> = { 1: 45000, 2: 12050, 3: 6000 };
    for (let i = 0; i < 300; i++) {
      if (rnd(5) === 0) g.rt.failFiles.add(g.backupId());
      else g.rt.failFiles.clear();
      g.rt.clock! += rnd(120_000); // 300 changes within the 12 hours a sign-in lasts
      const pick = rnd(10);
      if (pick < 5) {
        const id = 1 + rnd(3);
        const r = save({ ...body([[id, 1 + rnd(3), prices[id]!]]), clientRef: randomUUID() });
        saved.push(ok(r).billNo);
      } else if (pick === 5 && saved.length) {
        call('void_bill', { p_bill_no: saved[rnd(saved.length)], p_reason: 'Random void' }); // may be "already voided"
      } else if (pick === 6) {
        const id = 1 + rnd(3);
        prices[id] = 1000 + rnd(50000);
        ok(call('update_dish', { p_id: id, p_patch: { price_paise: prices[id] } }));
      } else if (pick === 7) {
        ok(call('patch_settings', { p_set: { phone: String(rnd(1e9)).padStart(10, '0') } }));
      } else if (pick === 8) {
        ok(call('insert_line', { p_text: `Line ${i}` }));
      } else {
        ok(call('pull_changes', { p_since: rnd(50) }));
      }
    }
    g.rt.failFiles.clear();
    ok(call('pull_changes', { p_since: 0 })); // any request copies what the Backup missed
    expectBackupMatches();
    expect(new Set(saved).size).toBe(saved.length);
    expect(g.exec('healthCheck')).toMatchObject({ ok: true });
  });

  it('Switch to Backup: the app carries on with the same data, logins and next number', () => {
    const a = ok(save(body([[1, 1, 45000]])));
    const oldMain = g.mainId();
    const oldBackup = g.backupId();
    expect(g.exec('switchToBackupNow')).toContain('Done');
    expect(g.mainId()).toBe(oldBackup);
    expect(g.backupId()).not.toBe(oldMain);
    expect(g.sheet(oldMain).name).toMatch(/^Tikka Bites – Main \(damaged 2026-09-25\)$/);
    expect(g.main().name).toBe('Tikka Bites – Main');
    expect(ok(call('my_role'))).toBe('super_admin'); // the same token still works
    expect(ok(save(body([[1, 1, 45000]]))).billNo).toBe(`RCPT-${M}-0002`);
    expect(billTab(g.main()).map((x) => x.bill.billNo)).toEqual([a.billNo, `RCPT-${M}-0002`]);
    expectBackupMatches();
    expect(ok(signIn('owner', 'owner-pass-123')).username).toBe('owner');
  });

  it('the self-test runs on temporary files only and trashes them', () => {
    const before = g.snapshot(g.main());
    const lines = g.exec('selfTest') as string[];
    expect(lines[0]).toBe('Self-test passed.');
    expect(g.snapshot(g.main())).toEqual(before);
    const temp = [...g.rt.files.values()].filter((f) => 'sheets' in f && f.name.includes('self-test')) as FakeSpreadsheet[];
    expect(temp).toHaveLength(2);
    expect(temp.every((f) => f.trashed)).toBe(true);
    expect(Number(g.rt.props.get('HASH_ROUNDS'))).toBeGreaterThanOrEqual(1000);
  });

  it('a request the app does not know, or garbage, gets a clear answer', () => {
    refused(g.post('not json'), 'The request was not understood.', 'server');
    refused(call('drop_everything'), 'older than the app', 'setup');
    expect(JSON.parse(g.exec('doGet').content)).toMatchObject({ ok: true });
  });
});
