/**
 * Aggregation. The same function keeps `monthlyStats` up to date when a bill is
 * saved (+1) or voided (−1), and builds ad-hoc stats when Reports scans a
 * filtered range, so both paths always agree.
 */
import type { Bill, BillItem, Stats, CountPaise } from '../db/types';

const zeroes = (n: number): CountPaise[] => Array.from({ length: n }, () => ({ count: 0, paise: 0 }));

export function emptyStats(): Stats {
  return {
    billCount: 0,
    voidCount: 0,
    revenuePaise: 0,
    discountPaise: 0,
    itemsSold: 0,
    byPayment: {},
    byOrderType: {},
    byCategory: {},
    byDish: {},
    byHour: zeroes(24),
    byWeekday: zeroes(7),
    byDay: {},
  };
}

function bump(map: Record<string, CountPaise>, key: string, sign: number, paise: number): void {
  const e = (map[key] ??= { count: 0, paise: 0 });
  e.count += sign;
  e.paise += sign * paise;
  if (e.count === 0 && e.paise === 0) delete map[key];
}

/** Removing a bill must leave stats identical to never having added it. */
function pruneQty(map: Record<string, { qty: number; paise: number }>, key: string): void {
  const e = map[key];
  if (e && e.qty === 0 && e.paise === 0) delete map[key];
}

/**
 * Add (sign = 1) or remove (sign = −1) a paid bill's numbers.
 * `itemFilter` limits item-level figures (dishes, categories, items sold) to
 * matching lines, e.g. when Reports filters by category; bill-level figures
 * (revenue, bill count, payment split) always use the whole bill.
 * Category/dish revenue is the gross line amount (before bill discount).
 */
export function applyBill(s: Stats, bill: Bill, sign: 1 | -1, itemFilter?: (i: BillItem) => boolean): Stats {
  const total = bill.totalPaise;
  s.billCount += sign;
  s.revenuePaise += sign * total;
  s.discountPaise += sign * bill.discountPaise;
  bump(s.byPayment, bill.paymentMode, sign, total);
  bump(s.byOrderType, bill.orderType, sign, total);
  const hour = s.byHour[bill.hour]!;
  hour.count += sign;
  hour.paise += sign * total;
  const wd = s.byWeekday[bill.weekday]!;
  wd.count += sign;
  wd.paise += sign * total;
  const day = String(new Date(bill.createdAt).getDate());
  s.byDay[day] = (s.byDay[day] ?? 0) + sign * total;
  if (sign < 0 && s.byDay[day] === 0) delete s.byDay[day];

  for (const it of bill.items) {
    if (itemFilter && !itemFilter(it)) continue;
    s.itemsSold += sign * it.qty;
    const c = (s.byCategory[it.category] ??= { qty: 0, paise: 0 });
    c.qty += sign * it.qty;
    c.paise += sign * it.linePaise;
    const d = (s.byDish[String(it.menuId)] ??= { name: it.name, qty: 0, paise: 0 });
    d.qty += sign * it.qty;
    d.paise += sign * it.linePaise;
    if (sign < 0) {
      pruneQty(s.byCategory, it.category);
      pruneQty(s.byDish, String(it.menuId));
    }
  }
  return s;
}
