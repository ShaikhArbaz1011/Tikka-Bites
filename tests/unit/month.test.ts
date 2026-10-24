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

describe('bills follow the local month; numbers follow the local year', () => {
  it('last second of January vs first second of February', async () => {
    const jan = await saveBill(bill(), ist(2026, 1, 31, 23, 59, 59, 999));
    const feb = await saveBill(bill(), ist(2026, 2, 1, 0, 0, 0, 0));
    expect(jan.billNo).toBe('RCPT-2026-0001');
    expect(feb.billNo).toBe('RCPT-2026-0002'); // same year: the count carries on
    expect(jan.monthKey).toBe('202601');
    expect(feb.monthKey).toBe('202602');
  });

  it('00:30 IST on the 1st belongs to the new month (not the UTC one)', async () => {
    const b = await saveBill(bill(), ist(2026, 2, 1, 0, 30));
    expect(b.billNo).toBe('RCPT-2026-0001');
    expect(b.monthKey).toBe('202602');
    expect(b.hour).toBe(0);
    expect(b.weekday).toBe(0); // 1 Feb 2026 is a Sunday
    expect(formatDateTime(b.createdAt)).toBe('01/02/2026 00:30');
  });

  it('one count through the months of a year', async () => {
    const nos: string[] = [];
    for (const t of [ist(2026, 1, 5), ist(2026, 1, 20), ist(2026, 2, 3), ist(2026, 2, 28, 23, 59), ist(2026, 3, 1, 0, 1)]) {
      nos.push((await saveBill(bill(), t)).billNo);
    }
    expect(nos).toEqual(['RCPT-2026-0001', 'RCPT-2026-0002', 'RCPT-2026-0003', 'RCPT-2026-0004', 'RCPT-2026-0005']);
  });

  it('year end: 31 Dec 23:59 → 1 Jan 00:00 IST starts again at 0001', async () => {
    await saveBill(bill(), ist(2026, 6, 1, 12, 0));
    expect((await saveBill(bill(), ist(2026, 12, 31, 23, 59))).billNo).toBe('RCPT-2026-0002');
    expect((await saveBill(bill(), ist(2027, 1, 1, 0, 0))).billNo).toBe('RCPT-2027-0001');
    expect((await saveBill(bill(), ist(2027, 1, 1, 0, 5))).billNo).toBe('RCPT-2027-0002');
    // 00:30 IST on 1 Jan is still 31 Dec in UTC: it is a 2027 bill.
    expect((await saveBill(bill(), ist(2027, 1, 1, 0, 30))).billNo).toBe('RCPT-2027-0003');
  });

  it('leap day 29 Feb 2028 is a normal February bill', async () => {
    const b = await saveBill(bill(), ist(2028, 2, 29, 13, 0));
    expect(b.billNo).toBe('RCPT-2028-0001');
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
    expect(page.bills.map((b) => b.monthKey)).toEqual(['202602', '202602']);
    expect(page.bills[0]!.createdAt).toBeGreaterThan(page.bills[1]!.createdAt);
  });

  it('Excel export keeps each bill on its own local date and time', async () => {
    const { sheets } = await collectExport({ ...base, range: customRange('2026-01-31', '2026-02-01')! }, 'Custom', 'Tikka Bites');
    const rows = sheets.find((s) => s.name === 'Bills')!.rows;
    expect(rows.map((r) => r[0])).toEqual(['RCPT-2026-0001', 'RCPT-2026-0002']);
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

describe('3-month limit (keep this month and the 2 before it)', () => {
  it('oldest kept month, across month and year ends (IST)', async () => {
    const { keepFromMonth } = await import('../../src/core/dates');
    expect(keepFromMonth(ist(2026, 9, 29, 12))).toBe('202607'); // Sep → keep Jul, Aug, Sep
    expect(keepFromMonth(ist(2026, 10, 1, 0, 0))).toBe('202608'); // 1 Oct 00:00 → July is gone
    expect(keepFromMonth(ist(2026, 9, 30, 23, 59, 59, 999))).toBe('202607'); // one ms before: July still kept
    expect(keepFromMonth(ist(2027, 1, 15))).toBe('202611'); // Jan → keep Nov, Dec, Jan
    expect(keepFromMonth(ist(2027, 2, 1))).toBe('202612');
    expect(keepFromMonth(ist(2028, 3, 1))).toBe('202801'); // leap-year March
  });

  it('reminder shows in the last 7 days of the month, naming the month to be deleted', async () => {
    const { retentionWarning } = await import('../../src/ui/components/retentionBanner');
    expect(retentionWarning(ist(2026, 9, 23, 10))).toBeNull(); // 8 days left
    const w = retentionWarning(ist(2026, 9, 24, 10))!; // 7 days left
    expect(w.monthKey).toBe('202607'); // July goes on 1 Oct
    expect(+w.on).toBe(ist(2026, 10, 1));
    expect(retentionWarning(ist(2026, 12, 31, 23, 0))).toMatchObject({ monthKey: '202610' }); // Oct goes on 1 Jan
    expect(retentionWarning(ist(2028, 2, 23))).toMatchObject({ monthKey: '202712' }); // Feb 2028 has 29 days
    expect(retentionWarning(ist(2028, 2, 22))).toBeNull();
  });
});

describe('3-month clean-up on the phone deletes exactly one month at a time', () => {
  it('May–October bills: mid-Sep deletes May+June; 1 Oct deletes only July; others unchanged', async () => {
    const { purgeOldMonths } = await import('../../src/db/retention');
    const { keepFromMonth } = await import('../../src/core/dates');
    const perMonth: Record<string, number> = { '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 1 };
    for (const [m, n] of Object.entries(perMonth)) {
      for (let k = 0; k < n; k++) await saveBill(bill({ items: [{ menuId: dish, qty: 1 + k }] }), ist(2026, Number(m), 10 + k, 13));
    }
    // One July bill is voided: it must go with July too.
    const july = await listBillsPage(monthRange(2026, 6), 50);
    await voidBill(july.bills[0]!.billNo, 'test void');
    const monthsLeft = async () => {
      const out: Record<string, number> = {};
      for (let m = 5; m <= 10; m++) {
        const n = (await listBillsPage(monthRange(2026, m - 1), 50)).bills.length;
        if (n) out[String(m)] = n;
      }
      return out;
    };
    const statsFor = async (m: number) => runReport({ ...base, range: monthRange(2026, m - 1) });
    const augBefore = (await statsFor(8)).stats;
    const sepBefore = (await statsFor(9)).stats;

    expect(await purgeOldMonths(keepFromMonth(ist(2026, 9, 15, 12)))).toBe(5); // May 2 + June 3
    expect(await monthsLeft()).toEqual({ '7': 4, '8': 5, '9': 6, '10': 1 });

    expect(await purgeOldMonths(keepFromMonth(ist(2026, 9, 30, 23, 59, 59)))).toBe(0); // a second early: nothing
    expect(await purgeOldMonths(keepFromMonth(ist(2026, 10, 1, 0, 0)))).toBe(4); // exactly July, voided one included
    expect(await monthsLeft()).toEqual({ '8': 5, '9': 6, '10': 1 });
    expect(await getMonthlyStats('202607')).toBeUndefined(); // July's totals are gone too
    expect((await statsFor(8)).stats).toEqual(augBefore); // August's report is exactly the same
    expect((await statsFor(9)).stats).toEqual(sepBefore);

    expect(await purgeOldMonths(keepFromMonth(ist(2026, 10, 20)))).toBe(0); // again: nothing
    // Numbering carries on after the clean-up: the year's counter is kept (21 bills so far in 2026).
    expect((await saveBill(bill(), ist(2026, 10, 21, 12))).billNo).toBe('RCPT-2026-0022');
  });
});

describe('a bill forgotten earlier this month, entered with its date (owner request, 24 Oct 2026)', () => {
  const NOW = ist(2026, 10, 24, 15, 0);

  it('is saved under its own date and time, counted in that day, numbered in the year', async () => {
    await saveBill(bill(), ist(2026, 10, 22, 12)); // RCPT-2026-0001
    const b = await saveBill(bill({ billedAt: ist(2026, 10, 20, 14, 30) }), NOW);
    expect(b).toMatchObject({ billNo: 'RCPT-2026-0002', createdAt: ist(2026, 10, 20, 14, 30), monthKey: '202610', hour: 14, weekday: 2, enteredAt: NOW }); // 20 Oct 2026 is a Tuesday
    expect(formatDateTime(b.createdAt)).toBe('20/10/2026 14:30');
    expect((await getMonthlyStats('202610'))!.billCount).toBe(2);
    // Reports for 20 Oct find it; the list is in date order, so it comes after the 22 Oct bill.
    expect((await runReport({ ...base, range: customRange('2026-10-20', '2026-10-20')! })).stats.billCount).toBe(1);
    expect((await listBillsPage(monthRange(2026, 9), 50)).bills.map((x) => x.billNo)).toEqual(['RCPT-2026-0001', 'RCPT-2026-0002']);
    // A normal bill has no "entered" time.
    expect('enteredAt' in (await saveBill(bill(), NOW))).toBe(false);
  });

  it('the 1st of the month just after midnight IST: the 1st itself is allowed, last month is not', async () => {
    const now = ist(2026, 11, 1, 0, 30); // still 31 Oct in UTC
    await expect(saveBill(bill({ billedAt: ist(2026, 10, 31, 23, 0) }), now)).rejects.toThrow('only be added for this month');
    const b = await saveBill(bill({ billedAt: ist(2026, 11, 1, 0, 5) }), now);
    expect(b.monthKey).toBe('202611');
  });

  it('never the future, never last month; within a minute of now it is just a normal bill', async () => {
    await expect(saveBill(bill({ billedAt: ist(2026, 10, 24, 18, 0) }), NOW)).rejects.toThrow("can't be in the future");
    await expect(saveBill(bill({ billedAt: ist(2026, 9, 30, 20, 0) }), NOW)).rejects.toThrow('only be added for this month');
    await expect(saveBill(bill({ billedAt: Number.NaN }), NOW)).rejects.toThrow('Invalid bill date');
    const b = await saveBill(bill({ billedAt: NOW - 30_000 }), NOW);
    expect(b.createdAt).toBe(NOW);
    expect('enteredAt' in b).toBe(false);
    expect((await listBillsPage(monthRange(2026, 8), 50)).bills).toHaveLength(0); // nothing landed in September
  });

  it('the calendar allows the 1st of this month … today; a date and time give the local time', async () => {
    const { allowedRange, localTime } = await import('../../src/ui/billing/billDate');
    expect(allowedRange(NOW)).toEqual({ min: '2026-10-01', max: '2026-10-24' });
    expect(allowedRange(ist(2026, 11, 1, 0, 30))).toEqual({ min: '2026-11-01', max: '2026-11-01' });
    expect(allowedRange(ist(2028, 2, 29, 9))).toEqual({ min: '2028-02-01', max: '2028-02-29' });
    expect(localTime('2026-10-20', '14:30')).toBe(ist(2026, 10, 20, 14, 30));
    expect(localTime('2026-02-30', '12:00')).toBeNull();
    expect(localTime('2026-10-20', '')).toBeNull();
    expect(localTime('2026-10-20', '25:00')).toBeNull();
  });
});
