import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDBForTests, getDB } from '../../src/db/db';
import { saveBill, voidBill, getBill, getMonthlyStats, listBillsPage, forEachBill, BillError, type BillDraft } from '../../src/db/billRepo';
import { addDish, updateDish, deleteDish, listMenu, getDish } from '../../src/db/menuRepo';
import { listLines } from '../../src/db/linesRepo';
import { getSettings, saveSettings } from '../../src/db/settingsRepo';
import { applyBill, emptyStats } from '../../src/core/stats';
import { monthRange } from '../../src/core/dates';
import { NO_DISCOUNT } from '../../src/core/totals';

const SEP = +new Date(2026, 8, 25, 13, 15);
const OCT = +new Date(2026, 9, 1, 9, 0);

let paneer: number;
let lassi: number;
let naan: number;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await resetDBForTests();
  paneer = (await addDish({ name: 'Paneer Tikka', category: 'Starters', pricePaise: 24900, isVeg: true, active: true })).id;
  lassi = (await addDish({ name: 'Sweet Lassi', category: 'Drinks', pricePaise: 6050, isVeg: true, active: true })).id;
  naan = (await addDish({ name: 'Chicken 65', category: 'Starters', pricePaise: 22000, isVeg: false, active: true })).id;
});

const draft = (over: Partial<BillDraft> = {}): BillDraft => ({
  items: [
    { menuId: paneer, qty: 2 },
    { menuId: lassi, qty: 3 },
  ],
  orderType: 'dine-in',
  tableNo: '7',
  paymentMode: 'upi',
  discount: NO_DISCOUNT,
  ...over,
});

describe('first run', () => {
  it('seeds 40 cheesy lines and default settings', async () => {
    expect(await listLines()).toHaveLength(40);
    expect(await getSettings()).toMatchObject({ currencySymbol: '₹', roundOff: true, receiptWidth: '80' });
  });
});

describe('saveBill', () => {
  it('creates INV-YYYYMM-0001 with snapshots, totals and a stored cheesy line', async () => {
    const b = await saveBill(draft(), SEP);
    expect(b.billNo).toBe('INV-202609-0001');
    expect(b.subtotalPaise).toBe(67950);
    expect(b.totalPaise).toBe(68000); // 679.50 rounded to 680
    expect(b.roundOffPaise).toBe(50);
    expect(b.items[0]).toMatchObject({ name: 'Paneer Tikka', unitPaise: 24900, qty: 2, linePaise: 49800 });
    expect(b.cheesyLine.length).toBeGreaterThan(0);
    expect(b.hour).toBe(13);
    expect(b.weekday).toBe(5);
    expect(b.tableNo).toBe('7');
    expect((await getDish(paneer))!.usedInBills).toBe(true);
    expect(await getBill(b.billNo)).toEqual(b);
  });

  it('respects the round-off setting', async () => {
    await saveSettings({ roundOff: false });
    const b = await saveBill(draft(), SEP);
    expect(b.totalPaise).toBe(67950);
    expect(b.roundOffPaise).toBe(0);
  });

  it('drops table number for takeaway and merges duplicate dishes', async () => {
    const b = await saveBill(draft({ orderType: 'takeaway', items: [{ menuId: paneer, qty: 1 }, { menuId: paneer, qty: 2 }] }), SEP);
    expect(b.tableNo).toBeUndefined();
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.qty).toBe(3);
  });

  it('increments per month and resets for a new month', async () => {
    expect((await saveBill(draft(), SEP)).billNo).toBe('INV-202609-0001');
    expect((await saveBill(draft(), SEP)).billNo).toBe('INV-202609-0002');
    expect((await saveBill(draft(), OCT)).billNo).toBe('INV-202610-0001');
    expect((await saveBill(draft(), SEP)).billNo).toBe('INV-202609-0003');
  });

  it('never duplicates bill numbers under 50 concurrent saves', async () => {
    const bills = await Promise.all(Array.from({ length: 50 }, () => saveBill(draft(), SEP)));
    const nos = bills.map((b) => b.billNo).sort();
    expect(new Set(nos).size).toBe(50);
    expect(nos[0]).toBe('INV-202609-0001');
    expect(nos[49]).toBe('INV-202609-0050');
  });

  it('rolls back everything if the bill fails (no gaps in numbering)', async () => {
    await deleteDish(lassi); // never billed → hard delete
    await expect(saveBill(draft(), SEP)).rejects.toThrow(BillError);
    expect((await getDish(paneer))!.usedInBills).toBe(false); // earlier write rolled back
    expect(await getMonthlyStats('202609')).toBeUndefined();
    const ok = await saveBill(draft({ items: [{ menuId: paneer, qty: 1 }] }), SEP);
    expect(ok.billNo).toBe('INV-202609-0001');
  });

  it('rejects invalid drafts', async () => {
    await expect(saveBill(draft({ items: [] }), SEP)).rejects.toThrow('at least one item');
    await expect(saveBill(draft({ items: [{ menuId: paneer, qty: 0 }] }), SEP)).rejects.toThrow('Quantity');
    await expect(saveBill(draft({ items: [{ menuId: paneer, qty: 1.5 }] }), SEP)).rejects.toThrow('Quantity');
    await expect(saveBill(draft({ items: [{ menuId: paneer, qty: 1000 }] }), SEP)).rejects.toThrow('Quantity');
    await expect(saveBill(draft({ paymentMode: 'bitcoin' as never }), SEP)).rejects.toThrow('payment');
    await expect(saveBill(draft({ discount: { kind: 'pct', bp: 10001 } }), SEP)).rejects.toThrow('discount');
  });

  it('old bills keep their snapshot after the menu changes', async () => {
    const b = await saveBill(draft(), SEP);
    await updateDish(paneer, { name: 'Paneer Tikka XL', category: 'Starters', pricePaise: 29900, isVeg: true, active: true });
    const again = await getBill(b.billNo);
    expect(again!.items[0]).toMatchObject({ name: 'Paneer Tikka', unitPaise: 24900 });
  });

  it('does not repeat a cheesy line until all 40 are used', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push((await saveBill(draft(), SEP)).cheesyLine);
    expect(new Set(lines).size).toBe(40);
  });
});

describe('monthly stats (pre-aggregation) and void', () => {
  it('matches a full recomputation from the bills', async () => {
    await saveBill(draft(), SEP);
    await saveBill(draft({ paymentMode: 'cash', orderType: 'delivery', items: [{ menuId: naan, qty: 1 }] }), SEP + 3_600_000);
    await saveBill(draft({ discount: { kind: 'pct', bp: 1000 } }), SEP + 7_200_000);
    const recomputed = emptyStats();
    await forEachBill(monthRange(2026, 8), (b) => applyBill(recomputed, b, 1));
    const stored = await getMonthlyStats('202609');
    expect(stored).toEqual({ monthKey: '202609', ...recomputed });
    expect(stored!.billCount).toBe(3);
    expect(stored!.byPayment['cash']).toEqual({ count: 1, paise: 22000 });
    expect(stored!.byCategory['Starters']!.qty).toBe(5);
    expect(stored!.byHour[13]!.count).toBe(1);
  });

  it('void removes a bill from totals but keeps it for audit', async () => {
    const a = await saveBill(draft(), SEP);
    const b = await saveBill(draft({ items: [{ menuId: naan, qty: 2 }] }), SEP);
    const before = await getMonthlyStats('202609');
    const v = await voidBill(b.billNo, 'Customer cancelled', SEP + 60_000);
    expect(v).toMatchObject({ status: 'void', voidReason: 'Customer cancelled' });
    const after = await getMonthlyStats('202609');
    expect(after!.billCount).toBe(1);
    expect(after!.voidCount).toBe(1);
    expect(after!.revenuePaise).toBe(before!.revenuePaise - b.totalPaise);
    expect(after!.revenuePaise).toBe(a.totalPaise);
    expect(after!.byDish[String(naan)]).toBeUndefined(); // pruned, as if never added
    expect((await getBill(b.billNo))!.status).toBe('void');
  });

  it('void needs a reason and cannot happen twice', async () => {
    const b = await saveBill(draft(), SEP);
    await expect(voidBill(b.billNo, '  ')).rejects.toThrow('reason');
    await voidBill(b.billNo, 'Wrong order');
    await expect(voidBill(b.billNo, 'Again')).rejects.toThrow('already');
    await expect(voidBill('INV-202609-9999', 'Nope')).rejects.toThrow('not found');
  });

  it('applyBill +1 then −1 returns to empty', () => {
    const s = emptyStats();
    const bill = {
      billNo: 'X', createdAt: SEP, monthKey: '202609', hour: 13, weekday: 5, orderType: 'takeaway', paymentMode: 'card',
      discount: NO_DISCOUNT, subtotalPaise: 100, discountPaise: 0, roundOffPaise: 0, totalPaise: 100, itemCount: 1,
      categories: ['A'], hasVeg: true, hasNonVeg: false, cheesyLine: '', status: 'paid',
      items: [{ menuId: 1, name: 'x', category: 'A', isVeg: true, unitPaise: 100, qty: 1, linePaise: 100 }],
    } as const;
    applyBill(s, structuredClone(bill) as never, 1);
    applyBill(s, structuredClone(bill) as never, -1);
    expect(s.billCount).toBe(0);
    expect(s.revenuePaise).toBe(0);
    expect(s).toEqual(emptyStats());
  });
});

describe('menu delete rules', () => {
  it('hard-deletes unused dishes, soft-deletes billed ones', async () => {
    await saveBill(draft({ items: [{ menuId: paneer, qty: 1 }] }), SEP);
    expect(await deleteDish(lassi)).toBe('hard');
    expect(await deleteDish(paneer)).toBe('soft');
    const visible = await listMenu();
    expect(visible.map((d) => d.name)).toEqual(['Chicken 65']);
    const all = await listMenu(true);
    expect(all.find((d) => d.id === paneer)).toMatchObject({ deleted: true, active: false });
    await expect(saveBill(draft({ items: [{ menuId: paneer, qty: 1 }] }), SEP)).rejects.toThrow('no longer exists');
  });

  it('validates dish input', async () => {
    await expect(addDish({ name: '', category: 'X', pricePaise: 100, isVeg: true, active: true })).rejects.toThrow('Name');
    await expect(addDish({ name: 'X', category: 'X', pricePaise: 0, isVeg: true, active: true })).rejects.toThrow('Price');
    await expect(addDish({ name: 'X', category: 'X', pricePaise: 1.5, isVeg: true, active: true })).rejects.toThrow('Price');
  });
});

describe('pagination', () => {
  it('pages newest-first 50 at a time with no gaps or duplicates (incl. same-ms bills)', async () => {
    const db = await getDB();
    expect(db).toBeTruthy();
    for (let i = 0; i < 120; i++) await saveBill(draft({ items: [{ menuId: lassi, qty: 1 }] }), SEP + Math.floor(i / 3) * 1000);
    const range = monthRange(2026, 8);
    const seen: string[] = [];
    let page = await listBillsPage(range, 50);
    const sizes = [page.bills.length];
    seen.push(...page.bills.map((b) => b.billNo));
    while (page.next) {
      page = await listBillsPage(range, 50, page.next);
      sizes.push(page.bills.length);
      seen.push(...page.bills.map((b) => b.billNo));
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe('INV-202609-0120');
    expect(seen[119]).toBe('INV-202609-0001');
  });
});
