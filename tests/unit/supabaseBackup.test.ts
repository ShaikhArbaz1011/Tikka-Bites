/**
 * The nightly Supabase → Google Sheet backup (google-sheets/Code.gs, "Supabase backup";
 * owner request, 12 Oct 2026), run on this PC against tests/helpers/fakeAppsScript.mjs.
 *  - a stand-in Supabase in JavaScript answers like public.backup_pull (supabase/schema.sql)
 *  - the last test runs the script against the REAL SQL in a local PostgreSQL (skipped
 *    when PGPORT isn't set; supabase/tests/i_backup.sql tests the SQL side on its own)
 * After every test: no write without the lock, no lock released before a flush, no formula.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createRuntime, type FakeAppsScript, type FakeSpreadsheet } from '../helpers/fakeAppsScript.mjs';

/** 12 Oct 2026, 15:00 India time. */
const NOW = Date.UTC(2026, 9, 12, 9, 30);
const URL = 'https://odzdzggbyahgfvmzinfg.supabase.co';
const jwt = (payload: object) =>
  [{ alg: 'HS256', typ: 'JWT' }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') + '.c2lnbmF0dXJl';
const ANON = jwt({ iss: 'supabase', ref: 'odzdzggbyahgfvmzinfg', role: 'anon' });
const SERVICE = jwt({ iss: 'supabase', ref: 'odzdzggbyahgfvmzinfg', role: 'service_role' });
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

type Bill = { billNo: string; createdAt: number; status: 'paid' | 'void'; customerName?: string; voidReason?: string; [k: string]: unknown };

/** A stand-in for the Supabase project: the same answers as public.backup_pull. */
class FakeSupabase {
  rev = 0;
  dbId = randomUUID();
  keyHash = '';
  down: 'no' | 'offline' | 'paused' | 'no-function' = 'no';
  menu = new Map<number, Record<string, unknown>>();
  lines = new Map<number, Record<string, unknown>>();
  settings: { data: Record<string, unknown>; rev: number } | null = null;
  bills = new Map<string, { no: string; bill: Bill; by: string | null; ref: string | null; rev: number; month: string }>();
  counter = new Map<string, number>();
  calls = 0;
  onCall: (() => void) | null = null;

  dish(id: number, name: string, price: number) {
    this.menu.set(id, { id, name, category: 'Grill Gali', price_paise: price, is_veg: false, active: true, deleted: false, used_in_bills: false, created_at: 1, updated_at: 2, rev: ++this.rev });
  }
  line(id: number, text: string) {
    this.lines.set(id, { id, text, built_in: true, active: true, removed: false, rev: ++this.rev });
  }
  setSettings(data: Record<string, unknown>) {
    this.settings = { data, rev: ++this.rev };
  }
  /** Like save_bill: the next number of that month. */
  save(month: string, extra: Partial<Bill> = {}, by = 'owner') {
    const n = (this.counter.get(month) ?? 0) + 1;
    this.counter.set(month, n);
    const no = `RCPT-${month}-${String(n).padStart(4, '0')}`;
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(4)) - 1;
    const bill: Bill = {
      billNo: no, createdAt: Date.UTC(y, m, 5, 8, 0) + n * 60_000, orderType: 'takeaway', paymentMode: 'cash', status: 'paid',
      items: [{ menuId: 1, name: 'Full Chicken', category: 'Grill Gali', isVeg: false, unitPaise: 45000, qty: 1, linePaise: 45000 }],
      itemCount: 1, subtotalPaise: 45000, discountPaise: 0, roundOffPaise: 0, totalPaise: 45000, cheesyLine: '', ...extra,
    };
    this.bills.set(no, { no, bill, by, ref: randomUUID(), rev: ++this.rev, month });
    return no;
  }
  void(no: string, reason: string) {
    const b = this.bills.get(no)!;
    b.bill = { ...b.bill, status: 'void', voidReason: reason };
    b.rev = ++this.rev;
  }
  purgeBefore(month: string) {
    for (const [no, b] of this.bills) if (b.month < month) this.bills.delete(no);
  }
  pull(key: string, since: number, limit: number) {
    if (!this.keyHash || (key?.length ?? 0) < 32 || sha256(key) !== this.keyHash) throw new Error('Wrong backup key.');
    const ch: { rev: number; kind: string; row: unknown }[] = [];
    for (const r of this.menu.values()) if ((r['rev'] as number) > since) ch.push({ rev: r['rev'] as number, kind: 'menu', row: r });
    for (const r of this.lines.values()) if ((r['rev'] as number) > since) ch.push({ rev: r['rev'] as number, kind: 'lines', row: r });
    if (this.settings && this.settings.rev > since) ch.push({ rev: this.settings.rev, kind: 'settings', row: this.settings });
    for (const b of this.bills.values()) if (b.rev > since) ch.push({ rev: b.rev, kind: 'bills', row: { no: b.no, bill: b.bill, by: b.by, ref: b.ref, rev: b.rev } });
    ch.sort((a, b) => a.rev - b.rev);
    const page = ch.slice(0, limit);
    const full = page.length === limit;
    const counts: Record<string, number> = {};
    for (const b of this.bills.values()) counts[b.month] = (counts[b.month] ?? 0) + 1;
    return {
      menu: page.filter((x) => x.kind === 'menu').map((x) => x.row),
      lines: page.filter((x) => x.kind === 'lines').map((x) => x.row),
      settings: page.find((x) => x.kind === 'settings')?.row ?? null,
      bills: page.filter((x) => x.kind === 'bills').map((x) => x.row),
      dbId: this.dbId,
      more: full,
      rev: full ? page[page.length - 1]!.rev : Math.max(this.rev, since),
      counts: full ? null : counts,
    };
  }
  /** UrlFetchApp → PostgREST. */
  handler = (url: string, opts: { headers?: Record<string, string>; payload?: string }) => {
    this.calls++;
    this.onCall?.();
    if (this.down === 'offline') throw new Error('Address unavailable: ' + url);
    if (this.down === 'paused') return { code: 540, body: 'Project paused' };
    if (this.down === 'no-function' || url !== URL + '/rest/v1/rpc/backup_pull') {
      return { code: 404, body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.backup_pull(p_key, p_limit, p_since) in the schema cache' }) };
    }
    if (opts.headers?.['apikey'] !== ANON || opts.headers?.['Authorization'] !== 'Bearer ' + ANON) return { code: 401, body: JSON.stringify({ message: 'Invalid API key' }) };
    const a = JSON.parse(opts.payload ?? '{}');
    try {
      return { code: 200, body: JSON.stringify(this.pull(a.p_key, a.p_since, a.p_limit)) };
    } catch (e) {
      return { code: 403, body: JSON.stringify({ code: '42501', message: (e as Error).message }) };
    }
  };
}

let g: FakeAppsScript;
let sb: FakeSupabase;

const file = () => g.sheet(g.rt.props.get('SB_FILE')!);
const tab = (month: string) => `Bills ${month.slice(0, 4)}-${month.slice(4)}`;
const billsIn = (ss: FakeSpreadsheet, month: string) => g.records<{ bill: Bill; by: string; ref: string }>(ss, tab(month));
const status = () => g.rows(g.control, 'Status').map((r) => `${r[1]}: ${r[2]}`);
const run = () => g.exec('supabaseBackup') as string[];

/** The sheet holds exactly what Supabase holds (old months may be extra). */
function expectSameAsSupabase(ss = file()) {
  const months = new Set([...sb.bills.values()].map((b) => b.month));
  for (const m of months) {
    const want = [...sb.bills.values()].filter((b) => b.month === m).map((b) => ({ bill: b.bill, by: b.by ?? '', ref: b.ref ?? '' }));
    const got = billsIn(ss, m);
    expect(got.length, tab(m)).toBe(want.length);
    expect(new Set(got.map((x) => x.bill.billNo)).size, 'no bill twice').toBe(got.length);
    expect([...got].sort((a, b) => a.bill.billNo.localeCompare(b.bill.billNo))).toEqual(want.sort((a, b) => a.bill.billNo.localeCompare(b.bill.billNo)));
  }
  const strip = (r: Record<string, unknown>) => {
    const { rev: _rev, ...rest } = r;
    return rest;
  };
  expect(g.records(ss, 'Menu')).toEqual([...sb.menu.values()].map(strip));
  expect(g.records(ss, 'Cheesy lines')).toEqual([...sb.lines.values()].map(strip));
  if (sb.settings) expect(g.records(ss, 'Settings')).toEqual([sb.settings.data]);
}

function shop() {
  sb.dish(1, 'Full Chicken', 45000);
  sb.dish(2, 'Masala Fries', 12050);
  sb.line(1, 'Thank you 🫓');
  sb.setSettings({ name: 'Tikka Bites', phone: '09137582060', currencySymbol: '₹', receiptWidth: '80', roundOff: true });
  for (let i = 0; i < 3; i++) sb.save('202608');
  for (let i = 0; i < 4; i++) sb.save('202609');
  for (let i = 0; i < 5; i++) sb.save('202610', {}, i % 2 ? 'counter1' : 'owner');
}

/** Set up the script and give Supabase the key's hash (the owner's one SQL line). */
function setUp() {
  const r = g.exec('setupSupabaseBackup', URL + '/', ANON) as { sql: string; message: string };
  const hash = /set_backup_key\('([0-9a-f]{64})'\)/.exec(r.sql)![1]!;
  sb.keyHash = hash;
  return r;
}

beforeEach(() => {
  g = createRuntime({ now: NOW });
  sb = new FakeSupabase();
  g.rt.fetch = sb.handler;
});

afterEach(() => {
  expect(g.rt.violations).toEqual([]);
  expect(g.rt.formulaWrites).toBe(0);
});

describe('Supabase backup: set up', () => {
  it('takes only the public key, makes the file in "Tikka Bites data", a 3 am job, and shows the SQL line with the key hash', () => {
    expect(() => g.exec('setupSupabaseBackup', URL, SERVICE)).toThrow('SECRET (service_role) key');
    expect(() => g.exec('setupSupabaseBackup', URL, 'sb_secret_abcdefghijklmnop')).toThrow('SECRET (service_role) key');
    expect(() => g.exec('setupSupabaseBackup', 'https://example.com', ANON)).toThrow('should look like https://abcd1234.supabase.co');
    expect(() => g.exec('setupSupabaseBackup', URL, 'hello')).toThrow('anon / publishable key');
    expect(g.rt.props.get('SB_KEY')).toBeUndefined();

    const r = setUp();
    const key = g.rt.props.get('SB_KEY')!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sql).toBe(`select public.set_backup_key('${sha256(key)}');`);
    expect(r.message).toContain(r.sql);
    expect(r.sql).not.toContain(key); // the key itself never leaves the script
    expect(g.rt.props.get('SB_URL')).toBe(URL); // trailing slash dropped
    const f = file();
    expect(f.name).toBe('Tikka Bites – Supabase backup');
    const folder = g.rt.files.get(f.parents[0]!) as { name: string };
    expect(folder.name).toBe('Tikka Bites data');
    expect(f.getSheets().map((s) => s.getName())).toEqual(['Read me', 'Settings', 'Menu', 'Cheesy lines', 'Users', 'Counters', 'Meta']);
    expect(g.rt.triggers).toEqual([expect.objectContaining({ fn: 'supabaseBackup', hour: 3, tz: 'Asia/Kolkata' })]);

    // Again (e.g. a new public key): same key, same file, still one nightly job.
    const again = g.exec('setupSupabaseBackup', URL, 'sb_publishable_abcdefghijklmnop') as { sql: string };
    expect(again.sql).toBe(r.sql);
    expect(g.rt.props.get('SB_FILE')).toBe(f.id);
    expect(g.rt.triggers.filter((t) => t.fn === 'supabaseBackup')).toHaveLength(1);
  });

  it('the menu offers the backup, with the Google Sheets database items in a sub-menu', () => {
    g.useUi();
    expect(() => g.exec('onOpen')).not.toThrow();
    const alerts = g.useUi([URL, ANON]);
    g.exec('menuSupabaseBackup');
    expect(alerts[0]).toContain('select public.set_backup_key(');
    expect(status().join('\n')).toContain('Run once in Supabase → SQL Editor: select public.set_backup_key(');
  });
});

describe('Supabase backup: copying', () => {
  it('the first copy: dishes, cheesy lines, settings and every bill in its month tab, exactly as Supabase has them', () => {
    shop();
    setUp();
    const report = run();
    expectSameAsSupabase();
    expect(report[0]).toBe(`Copied from Supabase: 12 new or changed bills (up to change ${sb.rev}).`);
    expect(report).toContain('Checked: all 12 bills Supabase has are in the sheet.');
    expect(report).toContain('Check: no damaged rows.');
    expect(g.records(file(), 'Counters')).toEqual([
      { monthKey: '202608', last: 3 },
      { monthKey: '202609', last: 4 },
      { monthKey: '202610', last: 5 },
    ]);
    expect(g.records(file(), 'Meta')).toContainEqual({ key: 'rev', value: sb.rev });
    expect(g.rt.props.get('SB_REV')).toBe(String(sb.rev));
    expect(g.rt.props.get('SB_ERROR')).toBe('');
    // Newest month first, readable columns for people, saved-by kept.
    expect(file().getSheets()[1]!.getName()).toBe('Bills 2026-10');
    expect(billsIn(file(), '202610').map((x) => x.by)).toEqual(['owner', 'counter1', 'owner', 'counter1', 'owner']);
    const row = g.rows(file(), 'Bills 2026-10')[0]!;
    expect(row.slice(0, 3)).toEqual(['RCPT-202610-0001', '05-10-2026', '13:31']);
    expect(row[16]).toBe(450); // Total ₹
    // It sent only the public key and the backup key, and asked from the start.
    const sent = g.rt.fetches[0]!;
    expect(sent.opts.headers).toEqual({ apikey: ANON, Authorization: 'Bearer ' + ANON });
    expect(JSON.parse(sent.opts.payload!)).toEqual({ p_key: g.rt.props.get('SB_KEY'), p_since: 0, p_limit: 500 });
    expect(status()[0]).toContain('Supabase backup: Copied from Supabase: 12');
  });

  it('later nights copy only what changed; a voided bill is updated in its own row, never doubled', () => {
    shop();
    setUp();
    run();
    const before = sb.rev;
    sb.void('RCPT-202610-0002', 'Wrong table');
    sb.save('202610');
    sb.dish(1, 'Full Chicken', 48000); // price change
    const report = run();
    expect(JSON.parse(g.rt.fetches.at(-1)!.opts.payload!).p_since).toBe(before);
    expect(report[0]).toBe(`Copied from Supabase: 2 new or changed bills (up to change ${sb.rev}).`);
    expectSameAsSupabase();
    const rows = g.rows(file(), 'Bills 2026-10');
    expect(rows).toHaveLength(6);
    expect(rows[1]!.slice(17, 19)).toEqual(['Void', 'Wrong table']);
    expect(g.records(file(), 'Counters').find((c: any) => c.monthKey === '202610')).toEqual({ monthKey: '202610', last: 6 });
    // Nothing new: one quick call, nothing written.
    const snap = g.snapshot(file());
    expect(run()[0]).toBe(`Copied from Supabase: 0 new or changed bills (up to change ${sb.rev}).`);
    expect(g.snapshot(file())).toEqual(snap);
  });

  it('Supabase clears a month after 3 months: the sheet keeps it for good', () => {
    shop();
    setUp();
    run();
    sb.purgeBefore('202609'); // 1 November-style clean-up: August goes
    sb.save('202610');
    const report = run();
    expect(billsIn(file(), '202608')).toHaveLength(3);
    expect(report).toContain('Checked: all 10 bills Supabase has are in the sheet, plus 1 older month kept only here.');
    expectSameAsSupabase();
  });

  it('1,200 bills are copied page by page (500 at a time)', () => {
    sb.setSettings({ name: 'Tikka Bites' });
    for (let i = 0; i < 1200; i++) sb.save(i < 700 ? '202609' : '202610');
    setUp();
    run();
    expect(sb.calls).toBe(3);
    expectSameAsSupabase();
    expect(billsIn(file(), '202609')).toHaveLength(700);
  });

  it('a long first copy carries on by itself a few minutes later (Google stops a run after 6 minutes)', () => {
    for (let i = 0; i < 1600; i++) sb.save('202610');
    setUp();
    sb.onCall = () => {
      g.rt.clock = (g.rt.clock ?? NOW) + 3 * 60_000; // each page takes 3 minutes
    };
    const report = run();
    expect(report).toContain('More to copy: it carries on by itself in a few minutes.');
    expect(billsIn(file(), '202610')).toHaveLength(1000);
    expect(g.rt.triggers.filter((t) => t.fn === 'supabaseBackupMore')).toEqual([expect.objectContaining({ after: 120_000 })]);
    sb.onCall = null;
    g.exec('supabaseBackupMore');
    expectSameAsSupabase();
    expect(g.rt.triggers.map((t) => t.fn)).toEqual(['supabaseBackup']); // the one-off job removed itself
  });
});

describe('Supabase backup: when something goes wrong', () => {
  it('wrong key, missing function, paused or offline: nothing written, a clear message, and the next run catches up', () => {
    shop();
    setUp();
    const key = g.rt.props.get('SB_KEY')!;
    const snap = g.snapshot(file());
    const cases: [() => void, string][] = [
      [() => (sb.keyHash = sha256('someone-elses-key-0123456789abcdef')), `Run this line once in Supabase → SQL Editor: select public.set_backup_key('${sha256(key)}');`],
      [() => (sb.down = 'no-function'), 'run supabase/schema.sql'],
      [() => (sb.down = 'paused'), 'click Restore project'],
      [() => (sb.down = 'offline'), 'Supabase could not be reached'],
    ];
    for (const [breakIt, message] of cases) {
      breakIt();
      expect(() => run()).toThrow(message); // a nightly job that throws: Google emails the owner
      expect(g.snapshot(file())).toEqual(snap);
      expect(g.rt.props.get('SB_REV')).toBe('0');
      expect(g.rt.props.get('SB_ERROR')).toContain(message.slice(0, 40));
      expect(status()[0]).toContain('The backup did not finish');
      sb.keyHash = sha256(key);
      sb.down = 'no';
    }
    run();
    expectSameAsSupabase();
    expect(g.rt.props.get('SB_ERROR')).toBe('');
  });

  it('a crash at any write step: the next run finishes the job, nothing doubled or lost', () => {
    let steps = 0;
    for (let k = 0; ; k++) {
      g = createRuntime({ now: NOW });
      sb = new FakeSupabase();
      g.rt.fetch = sb.handler;
      shop();
      setUp();
      sb.void('RCPT-202609-0002', 'Test');
      g.rt.writes = 0;
      g.rt.failAfter = k;
      let crashed = false;
      try {
        run();
      } catch {
        crashed = true;
      }
      g.rt.failAfter = Infinity;
      if (!crashed) {
        steps = k;
        break;
      }
      g.rt.violations = g.rt.violations.filter((v) => !v.includes('flush')); // the crash itself
      run();
      expectSameAsSupabase();
      expect(g.rt.violations).toEqual([]);
    }
    expect(steps).toBeGreaterThan(20);
  });

  it('bills deleted from the sheet by hand are found by the count check and copied again', () => {
    shop();
    setUp();
    run();
    const sh = file().getSheetByName('Bills 2026-10')!;
    sh.handEdit((s) => s.deleteRows(3, 2));
    sb.save('202610');
    const report = run();
    expect(report.join(' ')).toContain('Bills were missing (Bills 2026-10: 2 missing). Everything is copied again in a few minutes.');
    expect(g.rt.props.get('SB_REV')).toBe('0');
    g.exec('supabaseBackupMore');
    expectSameAsSupabase();
  });

  it('a column moved by hand: nothing is written and the message says what changed', () => {
    shop();
    setUp();
    run();
    file().getSheetByName('Bills 2026-10')!.handEdit((s) => s.insertColumnsAfter(2, 1));
    const snap = g.snapshot(file());
    sb.save('202610');
    expect(() => run()).toThrow('was changed by hand (tab "Bills 2026-10"');
    expect(g.snapshot(file())).toEqual(snap);
  });

  it('a customer name that looks like a formula stays text, and the phone keeps its leading 0', () => {
    sb.setSettings({ name: 'Tikka Bites', phone: '09137582060' });
    sb.save('202610', { customerName: '=HYPERLINK("http://x.example","win")' });
    sb.save('202610', { customerName: '+91 98200 00000' });
    setUp();
    run();
    expectSameAsSupabase();
    expect(g.rows(file(), 'Settings')[0]![2]).toBe('09137582060');
    expect(g.rt.formulaWrites).toBe(0);
  });

  it('Supabase re-created (a new database id): a new file is started, the old one kept untouched', () => {
    shop();
    setUp();
    run();
    const old = file();
    const oldSnap = g.snapshot(old);
    sb.dbId = randomUUID();
    sb.purgeBefore('999999');
    sb.counter.clear();
    sb.save('202610', { customerName: 'New start' });
    const report = run();
    expect(report.join(' ')).toContain('a new backup file was started');
    expect(file().id).not.toBe(old.id);
    expect(file().name).toBe('Tikka Bites – Supabase backup (from 2026-10-12)');
    expect(billsIn(file(), '202610').map((x) => x.bill.customerName)).toEqual(['New start']);
    expect(g.snapshot(old)).toEqual(oldSnap);
  });

  it('a bill whose data lost its number is filed under the number Supabase keeps', () => {
    sb.save('202610');
    const b = sb.bills.get('RCPT-202610-0001')!;
    const { billNo: _no, ...rest } = b.bill;
    b.bill = rest as Bill;
    setUp();
    run();
    expect(billsIn(file(), '202610')[0]!.bill.billNo).toBe('RCPT-202610-0001');
  });
});

/** The bill-tab header before 12 Oct 2026 (what the live sheet was first made with). */
const OLD_HEAD = ['Receipt no', 'Date', 'Time', 'Order type', 'Table', 'Customer', 'Payment', 'Items', 'Item count', 'Subtotal ₹', 'Discount ₹', 'Round-off ₹', 'Total ₹', 'Status', 'Void reason', 'Saved by', 'Printed as', 'Rev', 'Client ref', 'Data', 'Data 2'];

/** Turn a month tab back into the old 21-column layout, rows exactly as the old script wrote them. */
function toOldLayout(ss: FakeSpreadsheet, tabName: string) {
  const sh = ss.getSheetByName(tabName)! as any;
  const head: string[] = sh.dump()[0];
  const rows = sh.dump().slice(1).map((r: unknown[]) => {
    const json = String(r[head.indexOf('Data')]);
    const rec = JSON.parse(json.slice(2));
    const b = rec.bill;
    return [b.billNo, '01-01-2026', '10:00', b.orderType, b.tableNo ?? '', b.customerName ?? '', b.paymentMode, 'items', b.itemCount, b.subtotalPaise / 100, b.discountPaise / 100, b.roundOffPaise / 100, b.totalPaise / 100, b.status === 'void' ? 'Void' : 'Paid', b.voidReason ?? '', rec.by, b.printedAs ?? '', r[head.indexOf('Rev')], rec.ref, json, ''];
  });
  sh.handEdit((s: any) => {
    s.cols = OLD_HEAD.length;
    s.v = [OLD_HEAD, ...rows];
    s.f = [OLD_HEAD.map(() => '@'), ...rows.map(() => OLD_HEAD.map(() => '@'))];
  });
}

describe('Supabase backup: the sheet made with the older columns (live since 12 Oct 2026)', () => {
  it('each month tab is rebuilt with every field in its own column, from the trusted Data copy; nothing lost or doubled', () => {
    shop();
    sb.void('RCPT-202609-0002', 'Wrong table');
    setUp();
    run();
    toOldLayout(file(), 'Bills 2026-09');
    toOldLayout(file(), 'Bills 2026-10');
    expect(g.rows(file(), 'Bills 2026-10')[0]).toHaveLength(21);
    const order = file().getSheets().map((s) => s.getName());
    sb.save('202610', { customerName: 'After the upgrade' });
    const report = run();
    expect(report).toContain('Checked: all 13 bills Supabase has are in the sheet.');
    expect(report).toContain('Check: no damaged rows.');
    expectSameAsSupabase();
    expect(file().getSheets().map((s) => s.getName())).toEqual(order); // same tabs, same places, no "(upgrading)" left
    const head = file().getSheetByName('Bills 2026-09')!.dump()[0]!;
    expect(head.slice(0, 4)).toEqual(['Receipt no', 'Date', 'Time', 'Day']);
    expect(head).toContain('Receipt line');
    const voided = g.rows(file(), 'Bills 2026-09').find((r) => r[0] === 'RCPT-202609-0002')!;
    expect([voided[0], voided[17], voided[18]]).toEqual(['RCPT-202609-0002', 'Void', 'Wrong table']);
    expect(voided[8]).toBe('1 × Full Chicken @ ₹450 = ₹450');
  });

  it('a crash at any step of the rebuild: the next run finishes it, nothing lost or doubled', () => {
    let steps = 0;
    for (let k = 0; ; k++) {
      g = createRuntime({ now: NOW });
      sb = new FakeSupabase();
      g.rt.fetch = sb.handler;
      shop();
      setUp();
      run();
      toOldLayout(file(), 'Bills 2026-10');
      g.rt.writes = 0;
      g.rt.failAfter = k;
      let crashed = false;
      try {
        run();
      } catch {
        crashed = true;
      }
      g.rt.failAfter = Infinity;
      if (!crashed) {
        steps = k;
        break;
      }
      g.rt.violations = g.rt.violations.filter((v) => !v.includes('flush'));
      run();
      expectSameAsSupabase();
      expect(file().getSheets().map((s) => s.getName()).filter((n) => n.includes('upgrading'))).toEqual([]);
      expect(file().getSheetByName('Bills 2026-10')!.dump()[0]![3]).toBe('Day');
    }
    expect(steps).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------- the real SQL
const PSQL = process.env['PG_BIN'] ? join(process.env['PG_BIN'], 'psql') : 'psql';
const DB = 'tb_backup_it';
const hasPg = !!process.env['PGPORT'] && spawnSync(PSQL, ['-X', '-tAc', 'select 1', '-d', 'postgres']).status === 0;

function psql(sql: string, db = DB) {
  const r = spawnSync(PSQL, ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-v', `devnull=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-d', db], { input: sql, encoding: 'utf8', cwd: 'supabase/tests' });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr };
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe.skipIf(!hasPg)('Supabase backup against the real SQL (local PostgreSQL)', () => {
  it('copies a real Supabase database: every bill exactly as stored, then a void on the next night', () => {
    expect(psql(`drop database if exists ${DB}; create database ${DB};`, 'postgres').ok).toBe(true);
    for (const f of ['stub.sql', '../schema.sql', 'a_basics.sql']) {
      const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `devnull=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-d', DB, '-f', f], { cwd: 'supabase/tests', encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
    g.rt.fetch = (url, opts) => {
      expect(url).toBe(URL + '/rest/v1/rpc/backup_pull');
      const a = JSON.parse(opts.payload!);
      const r = psql(`set role anon; select public.backup_pull(${lit(a.p_key)}, ${Number(a.p_since)}, ${Number(a.p_limit)});`);
      if (!r.ok) return { code: 403, body: JSON.stringify({ message: r.err.replace(/^.*ERROR:\s*/s, '').trim() }) };
      return { code: 200, body: r.out };
    };
    g.exec('setupSupabaseBackup', URL, ANON);
    expect(() => run()).toThrow('Supabase did not accept the backup key');
    const hash = sha256(g.rt.props.get('SB_KEY')!);
    expect(psql(`select public.set_backup_key('${hash}');`).ok).toBe(true);

    const report = run();
    const stored = JSON.parse(psql(`select coalesce(jsonb_agg(data order by bill_no), '[]') from public.bills;`).out) as Bill[];
    expect(stored.length).toBeGreaterThan(3);
    const month = stored[0]!.billNo.slice(5, 11);
    const got = billsIn(file(), month).map((x) => x.bill).sort((a, b) => a.billNo.localeCompare(b.billNo));
    expect(got).toEqual(stored.filter((b) => b.billNo.slice(5, 11) === month));
    expect(report).toContain(`Checked: all ${stored.length} bills Supabase has are in the sheet.`);
    expect(g.records(file(), 'Menu').length).toBe(Number(psql('select count(*) from public.menu;').out));

    const paid = stored.find((b) => b.status === 'paid')!;
    const v = psql(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false); select public.void_bill(${lit(paid.billNo)}, 'Backup test');`);
    expect(v.ok, v.err).toBe(true);
    run();
    const after = billsIn(file(), month).find((x) => x.bill.billNo === paid.billNo)!;
    expect(after.bill.status).toBe('void');
    expect(billsIn(file(), month)).toHaveLength(got.length);
    psql(`drop database ${DB};`, 'postgres');
  });
});
