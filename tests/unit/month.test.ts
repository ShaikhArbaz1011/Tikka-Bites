/**
 * Month and date correctness, in Indian Standard Time (UTC+5:30, set in vite.config.ts).
 * The riskiest moments are just after midnight IST: 00:30 IST on the 1st is still
 * the previous day (and previous month) in UTC. Every date in the app must follow
 * the shop's local clock, never UTC.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDBForTests } from '../../src/db/db';
import { saveBill, voidBill, getMonthlyStats, listBillsPage, type BillDraft } from '../../src/db/billRepo';
import { addDish } from '../../src/db/menuRepo';
import { runReport, monthComparison, wholeMonthsIn } from '../../src/ui/reports/query';
import { collectExport } from '../../src/ui/reports/exportExcel';
import { presetRange, monthRange, customRange, rangeIsWholeMonth, prevMonthKey, formatDateTime, formatMonthKey, daysIn } from '../../src/core/dates';
import { monthKeyOf } from '../../src/core/billNo';
import { excelDate, excelTime } from '../../src/core/xlsx';
import { NO_DISCOUNT } from '../../src/core/totals';

/** Local (IST) timestamp. Month is 1-based here for readability. */
const ist = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) => +new Date(y, m - 1, d, h, min, s, ms);

let dish: number;
const bill = (over: Partial<BillDraft> = {}): BillDraft => ({
  items: [{ menuId: dish, qty: 1 }],
  orderType: 'takeaway',
  paymentMode: 'cash',
  discount: NO_DISCOUNT,
  ...over,
});
const base = { showVoid: false } as const;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await resetDBForTests();
  dish = (await addDish({ name: 'Chicken Tikka Wrap', category: 'Lapete Mein', pricePaise: 15000, isVeg: false, active: true })).id;
});

describe('test environment', () => {
  it('runs on Indian Standard Time', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-330);
    // 00:30 IST on 1 Feb is still 31 Jan in UTC — the case these tests guard.
    expect(new Date(ist(2026, 2, 1, 0, 30)).toISOString()).toBe('2026-01-31T19:00:00.000Z');
  });
});

describe('bill numbers follow the local month', () => {
  it('last second of January vs first second of February', async () => {
    const jan = await saveBill(bill(), ist(2026, 1, 31, 23, 59, 59, 999));
    const feb = await saveBill(bill(), ist(2026, 2, 1, 0, 0, 0, 0));
    expect(jan.billNo).toBe('INV-202601-0001');
    expect(feb.billNo).toBe('INV-202602-0001');
    expect(jan.monthKey).toBe('202601');
    expect(feb.monthKey).toBe('202602');
  });

  it('00:30 IST on the 1st belongs to the new month (not the UTC one)', async () => {
    const b = await saveBill(bill(), ist(2026, 2, 1, 0, 30));
    expect(b.billNo).toBe('INV-202602-0001');
    expect(b.hour).toBe(0);
    expect(b.weekday).toBe(0); // 1 Feb 2026 is a Sunday
    expect(formatDateTime(b.createdAt)).toBe('01/02/2026 00:30');
  });

  it('counter resets every month and continues within a month', async () => {
    const nos: string[] = [];
    for (const t of [ist(2026, 1, 5), ist(2026, 1, 20), ist(2026, 2, 3), ist(2026, 2, 28, 23, 59), ist(2026, 3, 1, 0, 1)]) {
      nos.push((await saveBill(bill(), t)).billNo);
    }
    expect(nos).toEqual(['INV-202601-0001', 'INV-202601-0002', 'INV-202602-0001', 'INV-202602-0002', 'INV-202603-0001']);
  });

  it('year end: 31 Dec 23:59 → 1 Jan 00:00 starts a new year and month', async () => {
    expect((await saveBill(bill(), ist(2026, 12, 31, 23, 59))).billNo).toBe('INV-202612-0001');
    expect((await saveBill(bill(), ist(2027, 1, 1, 0, 0))).billNo).toBe('INV-202701-0001');
  });

  it('leap day 29 Feb 2028 is a normal February bill', async () => {
    const b = await saveBill(bill(), ist(2028, 2, 29, 13, 0));
    expect(b.billNo).toBe('INV-202802-0001');
    expect(formatDateTime(b.createdAt)).toBe('29/02/2028 13:00');
  });
});

describe('monthly totals are kept per month', () => {
  beforeEach(async () => {
    await saveBill(bill({ items: [{ menuId: dish, qty: 2 }] }), ist(2026, 1, 31, 23, 59));
    await saveBill(bill(), ist(2026, 2, 1, 0, 1));
    await saveBill(bill({ items: [{ menuId: dish, qty: 3 }] }), ist(2026, 2, 14, 20, 0));
  });

  it('January and February stats never mix', async () => {
    const jan = await getMonthlyStats('202601');
    const feb = await getMonthlyStats('202602');
    expect(jan).toMatchObject({ billCount: 1, revenuePaise: 30000, itemsSold: 2 });
    expect(feb).toMatchObject({ billCount: 2, revenuePaise: 60000, itemsSold: 4 });
    expect(jan!.byDay).toEqual({ '31': 30000 });
    expect(feb!.byDay).toEqual({ '1': 15000, '14': 45000 });
  });

  it('voiding a January bill in February changes January only', async () => {
    const janBill = (await listBillsPage(monthRange(2026, 0), 50)).bills[0]!;
    await voidBill(janBill.billNo, 'Found in March audit', ist(2026, 3, 2));
    expect(await getMonthlyStats('202601')).toMatchObject({ billCount: 0, revenuePaise: 0, voidCount: 1 });
    expect(await getMonthlyStats('202602')).toMatchObject({ billCount: 2, revenuePaise: 60000, voidCount: 0 });
  });

  it('reports: This month / Last month / Today / Yesterday just after midnight on the 1st', async () => {
    const now = ist(2026, 2, 1, 0, 5); // 12:05 AM on 1 Feb
    const count = async (r: { start: number; end: number }) => (await runReport({ ...base, range: r })).stats.billCount;
    expect(await count(presetRange('month', now))).toBe(2); // Feb 1 + Feb 14 (the whole of February)
    expect(await count(presetRange('lastMonth', now))).toBe(1); // Jan 31
    expect(await count(presetRange('today', now))).toBe(1); // only the 00:01 bill
    expect(await count(presetRange('yesterday', now))).toBe(1); // only the 23:59 bill
  });

  it('a week that spans two months includes both sides', async () => {
    const week = presetRange('week', ist(2026, 2, 1, 12)); // Mon 26 Jan – Sun 1 Feb
    expect(new Date(week.start).getDate()).toBe(26);
    expect((await runReport({ ...base, range: week })).stats.billCount).toBe(2);
  });

  it('custom range 31 Jan → 1 Feb includes both whole days', async () => {
    const r = customRange('2026-01-31', '2026-02-01')!;
    expect(r).toEqual({ start: ist(2026, 1, 31), end: ist(2026, 2, 2) });
    expect((await runReport({ ...base, range: r })).stats.billCount).toBe(2);
  });

  it('month-over-month compares the right months', async () => {
    const c = await monthComparison('202602');
    expect(c.prevKey).toBe('202601');
    expect(c.cur.revenuePaise).toBe(60000);
    expect(c.prev.revenuePaise).toBe(30000);
  });

  it('bill list for February starts at the newest February bill and stops at 1 Feb', async () => {
    const page = await listBillsPage(monthRange(2026, 1), 50);
    expect(page.bills.map((b) => b.billNo)).toEqual(['INV-202602-0002', 'INV-202602-0001']);
  });

  it('Excel export keeps each bill on its own local date and time', async () => {
    const { sheets } = await collectExport({ ...base, range: customRange('2026-01-31', '2026-02-01')! }, 'Custom', 'Tikka Bites');
    const rows = sheets.find((s) => s.name === 'Bills')!.rows;
    expect(rows.map((r) => r[0])).toEqual(['INV-202601-0001', 'INV-202602-0001']);
    expect(excelDate(rows[0]![1] as number)).toBe(46053); // 31-01-2026
    expect(excelDate(rows[1]![1] as number)).toBe(46054); // 01-02-2026 (not 31 Jan UTC)
    expect(excelTime(rows[0]![2] as number)).toBeCloseTo((23 * 60 + 59) / 1440, 10);
    expect(excelTime(rows[1]![2] as number)).toBeCloseTo(1 / 1440, 10);
  });
});

describe('month arithmetic', () => {
  it('month lengths, including leap years', () => {
    expect(daysIn(monthRange(2026, 1))).toBe(28); // Feb 2026
    expect(daysIn(monthRange(2028, 1))).toBe(29); // Feb 2028 (leap)
    expect(daysIn(monthRange(2026, 3))).toBe(30); // April
    expect(daysIn(monthRange(2026, 11))).toBe(31); // December
    expect(monthRange(2026, 11).end).toBe(ist(2027, 1, 1)); // Dec ends at 1 Jan next year
  });

  it('last month across the year boundary', () => {
    expect(rangeIsWholeMonth(presetRange('lastMonth', ist(2027, 1, 1, 0, 0)))).toBe('202612');
    expect(prevMonthKey('202701')).toBe('202612');
    expect(formatMonthKey('202612')).toBe('Dec 2026');
  });

  it('month key uses the local date at the exact boundary', () => {
    expect(monthKeyOf(ist(2026, 1, 31, 23, 59, 59, 999))).toBe('202601');
    expect(monthKeyOf(ist(2026, 2, 1))).toBe('202602');
  });

  it('whole months inside a long range, across a year end', () => {
    const r = { start: ist(2026, 11, 15), end: ist(2027, 2, 10) };
    expect(wholeMonthsIn(r).keys).toEqual(['202612', '202701']);
    expect(wholeMonthsIn(r).edges).toEqual([
      { start: ist(2026, 11, 15), end: ist(2026, 12, 1) },
      { start: ist(2027, 2, 1), end: ist(2027, 2, 10) },
    ]);
  });

  it('Excel serial dates match Excel for known days', () => {
    expect(excelDate(ist(2000, 1, 1))).toBe(36526);
    expect(excelDate(ist(2026, 12, 31, 23, 59))).toBe(46387);
    expect(excelDate(ist(2027, 1, 1, 0, 0))).toBe(46388);
    expect(excelDate(ist(2028, 2, 29, 12))).toBe(46812);
  });
});
