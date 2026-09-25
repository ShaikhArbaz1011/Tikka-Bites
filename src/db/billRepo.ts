import { getDB, SETTINGS_KEY, DEFAULT_SETTINGS } from './db';
import { ORDER_TYPES, PAYMENT_MODES, type Bill, type BillItem, type OrderType, type PaymentMode, type MonthlyStats } from './types';
import { computeTotals, type Discount } from '../core/totals';
import { monthKeyOf, nextBillNo } from '../core/billNo';
import { draw, type BagState } from '../core/shuffleBag';
import { applyBill, emptyStats } from '../core/stats';
import { isQty, cleanText, LIMITS } from '../core/validate';
import { MAX_BP } from '../core/money';

export class BillError extends Error {}

export interface BillDraft {
  items: { menuId: number; qty: number }[];
  orderType: OrderType;
  tableNo?: string;
  customerName?: string;
  paymentMode: PaymentMode;
  discount: Discount;
}

const FALLBACK_LINE = 'Thank you! Visit again 😊';

function validateDraft(d: BillDraft): BillDraft {
  if (!Array.isArray(d.items) || d.items.length === 0) throw new BillError('Add at least one item');
  // Merge duplicate lines for the same dish.
  const merged = new Map<number, number>();
  for (const it of d.items) {
    if (!Number.isSafeInteger(it.menuId)) throw new BillError('Invalid item');
    merged.set(it.menuId, (merged.get(it.menuId) ?? 0) + it.qty);
  }
  for (const q of merged.values()) if (!isQty(q)) throw new BillError('Quantity must be a whole number 1–999');
  if (!ORDER_TYPES.includes(d.orderType)) throw new BillError('Invalid order type');
  if (!PAYMENT_MODES.includes(d.paymentMode)) throw new BillError('Invalid payment mode');
  const disc = d.discount;
  if (disc.kind === 'flat' ? !Number.isSafeInteger(disc.paise) || disc.paise < 0 : !Number.isInteger(disc.bp) || disc.bp < 0 || disc.bp > MAX_BP) {
    throw new BillError('Invalid discount');
  }
  const tableNo = d.orderType === 'dine-in' ? cleanText(d.tableNo ?? '').slice(0, LIMITS.tableNo) || undefined : undefined;
  const customerName = cleanText(d.customerName ?? '').slice(0, LIMITS.customerName) || undefined;
  return {
    items: [...merged].map(([menuId, qty]) => ({ menuId, qty })),
    orderType: d.orderType,
    tableNo,
    customerName,
    paymentMode: d.paymentMode,
    discount: disc,
  };
}

/**
 * Save a bill atomically: bill number, dish snapshots, totals, cheesy line,
 * monthly stats and dish "used" flags are written in ONE IndexedDB transaction.
 * If anything fails, nothing is written, and bill numbers can never repeat.
 */
export async function saveBill(input: BillDraft, now: number = Date.now()): Promise<Bill> {
  const draft = validateDraft(input);
  const db = await getDB();
  const tx = db.transaction(['menu', 'bills', 'counters', 'monthlyStats', 'settings', 'cheesyLines', 'meta'], 'readwrite');
  const done = tx.done;
  try {
    const settings = (await tx.objectStore('settings').get(SETTINGS_KEY)) ?? DEFAULT_SETTINGS;

    // Snapshot dishes from the menu as they are *now*.
    const menu = tx.objectStore('menu');
    const items: BillItem[] = [];
    for (const { menuId, qty } of draft.items) {
      const dish = await menu.get(menuId);
      if (!dish || dish.deleted) throw new BillError('A dish in this bill no longer exists');
      items.push({
        menuId,
        name: dish.name,
        category: dish.category,
        isVeg: dish.isVeg,
        unitPaise: dish.pricePaise,
        qty,
        linePaise: dish.pricePaise * qty,
      });
      if (!dish.usedInBills) await menu.put({ ...dish, usedInBills: true });
    }
    const totals = computeTotals(items, draft.discount, settings.roundOff);

    // Next bill number for this month.
    const monthKey = monthKeyOf(now);
    const counters = tx.objectStore('counters');
    const counter = await counters.get(monthKey);
    const { billNo, seq } = nextBillNo(monthKey, counter?.last);
    await counters.put({ monthKey, last: seq });

    // Cheesy line from the shuffle bag.
    const lines = (await tx.objectStore('cheesyLines').getAll()).filter((l) => l.active);
    const meta = tx.objectStore('meta');
    const bag = (await meta.get('shuffleBag')) as BagState | undefined;
    const pick = draw(bag, lines.map((l) => l.id));
    await meta.put(pick.state, 'shuffleBag');
    const cheesyLine = lines.find((l) => l.id === pick.id)?.text ?? FALLBACK_LINE;

    const date = new Date(now);
    const bill: Bill = {
      billNo,
      createdAt: now,
      monthKey,
      hour: date.getHours(),
      weekday: date.getDay(),
      items,
      orderType: draft.orderType,
      ...(draft.tableNo ? { tableNo: draft.tableNo } : {}),
      ...(draft.customerName ? { customerName: draft.customerName } : {}),
      paymentMode: draft.paymentMode,
      discount: draft.discount,
      subtotalPaise: totals.subtotalPaise,
      discountPaise: totals.discountPaise,
      roundOffPaise: totals.roundOffPaise,
      totalPaise: totals.totalPaise,
      itemCount: totals.itemCount,
      categories: [...new Set(items.map((i) => i.category))],
      hasVeg: items.some((i) => i.isVeg),
      hasNonVeg: items.some((i) => !i.isVeg),
      cheesyLine,
      status: 'paid',
    };
    await tx.objectStore('bills').add(bill); // add() rejects a duplicate key

    const statsStore = tx.objectStore('monthlyStats');
    const stats: MonthlyStats = (await statsStore.get(monthKey)) ?? { monthKey, ...emptyStats() };
    applyBill(stats, bill, 1);
    await statsStore.put(stats);

    await done;
    return bill;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* already finished */
    }
    await done.catch(() => undefined);
    throw e;
  }
}

/** Void a bill: kept for the audit trail, removed from monthly totals. */
export async function voidBill(billNo: string, reason: string, now: number = Date.now()): Promise<Bill> {
  const why = cleanText(reason, true);
  if (why.length < 3) throw new BillError('Please give a reason (at least 3 characters)');
  if (why.length > LIMITS.voidReason) throw new BillError(`Reason must be at most ${LIMITS.voidReason} characters`);
  const db = await getDB();
  const tx = db.transaction(['bills', 'monthlyStats'], 'readwrite');
  const done = tx.done;
  try {
    const bills = tx.objectStore('bills');
    const bill = await bills.get(billNo);
    if (!bill) throw new BillError('Bill not found');
    if (bill.status === 'void') throw new BillError('Bill is already voided');
    const updated: Bill = { ...bill, status: 'void', voidReason: why, voidedAt: now };
    await bills.put(updated);
    const statsStore = tx.objectStore('monthlyStats');
    const stats = (await statsStore.get(bill.monthKey)) ?? { monthKey: bill.monthKey, ...emptyStats() };
    applyBill(stats, bill, -1);
    stats.voidCount += 1;
    await statsStore.put(stats);
    await done;
    return updated;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* already finished */
    }
    await done.catch(() => undefined);
    throw e;
  }
}

export async function getBill(billNo: string): Promise<Bill | undefined> {
  return (await getDB()).get('bills', billNo);
}

export async function getMonthlyStats(monthKey: string): Promise<MonthlyStats | undefined> {
  return (await getDB()).get('monthlyStats', monthKey);
}

export interface PageCursor {
  createdAt: number;
  billNo: string;
}

/**
 * Newest-first page of bills in [start, end), `limit` at a time.
 * Pass the last bill of the previous page as `after` to continue.
 */
export async function listBillsPage(
  range: { start: number; end: number },
  limit = 50,
  after?: PageCursor,
  filter?: (b: Bill) => boolean,
): Promise<{ bills: Bill[]; next?: PageCursor }> {
  const db = await getDB();
  const upper = after ? after.createdAt : range.end;
  const keyRange = IDBKeyRange.bound(range.start, upper, false, !after);
  let cursor = await db.transaction('bills').store.index('createdAt').openCursor(keyRange, 'prev');
  const bills: Bill[] = [];
  while (cursor && bills.length < limit) {
    const b = cursor.value;
    const alreadySeen = after && b.createdAt === after.createdAt && b.billNo >= after.billNo;
    if (!alreadySeen && (!filter || filter(b))) bills.push(b);
    cursor = await cursor.continue();
  }
  const last = bills[bills.length - 1];
  return { bills, next: cursor && last ? { createdAt: last.createdAt, billNo: last.billNo } : undefined };
}

/** Stream every bill in [start, end) oldest-first without loading them all into memory. */
export async function forEachBill(range: { start: number; end: number }, fn: (b: Bill) => void): Promise<void> {
  const db = await getDB();
  let cursor = await db.transaction('bills').store.index('createdAt').openCursor(IDBKeyRange.bound(range.start, range.end, false, true));
  while (cursor) {
    fn(cursor.value);
    cursor = await cursor.continue();
  }
}
