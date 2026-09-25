import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDBForTests, getDB } from '../../src/db/db';
import { saveBill, forEachBill } from '../../src/db/billRepo';
import { addDish, listMenu } from '../../src/db/menuRepo';
import { runReport, dishRankings, billMatches, pctChange, wholeMonthsIn, type ReportFilter } from '../../src/ui/reports/query';
import { applyBill, emptyStats } from '../../src/core/stats';
import { monthRange } from '../../src/core/dates';
import { NO_DISCOUNT } from '../../src/core/totals';
import type { Bill } from '../../src/db/types';

const SEP = monthRange(2026, 8);
const at = (day: number, hour = 13) => +new Date(2026, 8, day, hour);

let tikka: number, naan: number, fish: number, kulfi: number;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await resetDBForTests();
  tikka = (await addDish({ name: 'Paneer Tikka', category: 'Starters', pricePaise: 24900, isVeg: true, active: true })).id;
  naan = (await addDish({ name: 'Butter Naan', category: 'Breads', pricePaise: 4500, isVeg: true, active: true })).id;
  fish = (await addDish({ name: 'Fish Fry', category: 'Starters', pricePaise: 34000, isVeg: false, active: true })).id;
  kulfi = (await addDish({ name: 'Kulfi', category: 'Desserts', pricePaise: 7500, isVeg: true, active: true })).id; // never sold
  await saveBill({ items: [{ menuId: tikka, qty: 2 }, { menuId: naan, qty: 4 }], orderType: 'dine-in', paymentMode: 'upi', discount: NO_DISCOUNT }, at(3));
  await saveBill({ items: [{ menuId: fish, qty: 1 }], orderType: 'delivery', paymentMode: 'cash', discount: NO_DISCOUNT }, at(4, 20));
  await saveBill({ items: [{ menuId: naan, qty: 10 }], orderType: 'takeaway', paymentMode: 'upi', discount: NO_DISCOUNT }, at(5, 21));
});

const base: ReportFilter = { range: SEP, showVoid: false };

describe('runReport', () => {
  it('uses the pre-aggregated summary for a whole month with no filters', async () => {
    const r = await runReport(base);
    expect(r.source).toBe('summary');
    expect(r.stats.billCount).toBe(3);
    expect(r.stats.itemsSold).toBe(17);
  });

  it('scan path gives the same totals as the summary', async () => {
    const summary = await runReport(base);
    const scan = await runReport({ ...base, range: { start: SEP.start, end: SEP.end - 1 } });
    expect(scan.source).toBe('scan');
    expect(scan.stats).toEqual(summary.stats);
  });

  it('filters by payment, order type, amount and bill number', async () => {
    expect((await runReport({ ...base, payment: 'cash' })).stats.billCount).toBe(1);
    expect((await runReport({ ...base, orderType: 'takeaway' })).stats.revenuePaise).toBe(45000);
    expect((await runReport({ ...base, minPaise: 45000 })).stats.billCount).toBe(2);
    expect((await runReport({ ...base, maxPaise: 44999 })).stats.billCount).toBe(1);
    expect((await runReport({ ...base, billNo: '0002' })).stats.billCount).toBe(1);
  });

  it('category / veg filters keep whole bills for KPIs but only matching items for dish figures', async () => {
    const r = await runReport({ ...base, category: 'Breads' });
    expect(r.stats.billCount).toBe(2); // bills containing Breads
    expect(r.stats.itemsSold).toBe(14); // only naan counted
    expect(Object.keys(r.stats.byCategory)).toEqual(['Breads']);
    const nv = await runReport({ ...base, food: 'nonveg' });
    expect(nv.stats.billCount).toBe(1);
    expect(nv.stats.byDish[String(fish)]!.qty).toBe(1);
  });
});

describe('multi-month ranges', () => {
  it('splits a range into whole months plus partial edges', () => {
    const r = { start: +new Date(2026, 6, 15), end: +new Date(2026, 8, 10) };
    expect(wholeMonthsIn(r)).toEqual({ keys: ['202608'], edges: [{ start: r.start, end: +new Date(2026, 7, 1) }, { start: +new Date(2026, 8, 1), end: r.end }] });
    expect(wholeMonthsIn(monthRange(2026, 8)).keys).toEqual(['202609']);
    const inside = { start: +new Date(2026, 8, 2), end: +new Date(2026, 8, 20) };
    expect(wholeMonthsIn(inside)).toEqual({ keys: [], edges: [inside] });
  });

  it('whole months from summaries + scanned edges equal a full scan', async () => {
    await saveBill({ items: [{ menuId: fish, qty: 2 }], orderType: 'takeaway', paymentMode: 'upi', discount: NO_DISCOUNT }, +new Date(2026, 7, 20, 12));
    await saveBill({ items: [{ menuId: naan, qty: 1 }], orderType: 'dine-in', paymentMode: 'cash', discount: NO_DISCOUNT }, +new Date(2026, 6, 28, 19));
    const range = { start: +new Date(2026, 6, 25), end: +new Date(2026, 8, 4) }; // Jul 25 → Sep 3
    const r = await runReport({ range, showVoid: false });
    const full = emptyStats();
    await forEachBill(range, (b) => applyBill(full, b, 1));
    expect(r.stats.billCount).toBe(full.billCount);
    expect(r.stats.revenuePaise).toBe(full.revenuePaise);
    expect(r.stats.byDish).toEqual(full.byDish);
    expect(r.stats.byHour).toEqual(full.byHour);
    expect(r.scanned).toBeLessThan(5); // August came from its summary
  });
});

describe('dishRankings', () => {
  it('ranks top by quantity and by revenue, and least-sold includes zero sellers', async () => {
    const r = await runReport(base);
    const menu = await listMenu();
    const { byQty, byRevenue, least } = dishRankings(r.stats, menu, base);
    expect(byQty.map((d) => d.name)).toEqual(['Butter Naan', 'Paneer Tikka', 'Fish Fry']);
    expect(byRevenue.map((d) => d.name)).toEqual(['Butter Naan', 'Paneer Tikka', 'Fish Fry']); // 630 > 498 > 340
    expect(least[0]).toMatchObject({ name: 'Kulfi', qty: 0 });
    expect(least.map((d) => d.id)).not.toContain(undefined);
    expect(kulfi).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('pctChange handles zero previous', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(10, 0)).toBeNull();
  });
  it('billMatches ignores void status (the caller decides)', () => {
    const b = { paymentMode: 'cash', orderType: 'takeaway', categories: ['A'], hasVeg: true, hasNonVeg: false, totalPaise: 100, billNo: 'INV-202609-0001', status: 'void' } as Bill;
    expect(billMatches(b, base)).toBe(true);
    expect(billMatches(b, { ...base, food: 'nonveg' })).toBe(false);
  });
});

describe('forEachBill batching', () => {
  it('visits every bill exactly once across 1000-bill batches, even with shared timestamps', async () => {
    const db = await getDB();
    const tmpl = (await db.getAll('bills'))[0]!;
    const tx = db.transaction('bills', 'readwrite');
    for (let i = 0; i < 2500; i++) {
      // 1200 bills share one millisecond, so a batch boundary falls inside that group.
      const t = i < 1200 ? at(10) : at(10) + i;
      void tx.store.put({ ...tmpl, billNo: `INV-202609-${String(1000 + i)}`, createdAt: t });
    }
    await tx.done;
    const seen = new Map<string, number>();
    await forEachBill(SEP, (b) => seen.set(b.billNo, (seen.get(b.billNo) ?? 0) + 1));
    expect(seen.size).toBe(2503);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });
});
