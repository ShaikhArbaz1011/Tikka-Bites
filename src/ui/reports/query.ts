/**
 * Report queries. Whole-month views with no extra filters read the
 * pre-aggregated `monthlyStats` record (instant at any bill count); anything
 * else streams the bills in the date range once and aggregates on the fly.
 */
import { forEachBill, getMonthlyStats } from '../../db/billRepo';
import { applyBill, emptyStats } from '../../core/stats';
import { rangeIsWholeMonth, prevMonthKey, type Range } from '../../core/dates';
import { topK, bottomK } from '../../core/topK';
import type { Bill, BillItem, Dish, OrderType, PaymentMode, Stats } from '../../db/types';

export interface ReportFilter {
  range: Range;
  category?: string;
  payment?: PaymentMode;
  orderType?: OrderType;
  food?: 'veg' | 'nonveg';
  minPaise?: number;
  maxPaise?: number;
  billNo?: string;
  showVoid: boolean;
}

export function hasBillFilters(f: ReportFilter): boolean {
  return !!(f.category || f.payment || f.orderType || f.food || f.minPaise !== undefined || f.maxPaise !== undefined || f.billNo);
}

/** Bill-level match (ignores paid/void status). */
export function billMatches(b: Bill, f: ReportFilter): boolean {
  if (f.payment && b.paymentMode !== f.payment) return false;
  if (f.orderType && b.orderType !== f.orderType) return false;
  if (f.category && !b.categories.includes(f.category)) return false;
  if (f.food === 'veg' && !b.hasVeg) return false;
  if (f.food === 'nonveg' && !b.hasNonVeg) return false;
  if (f.minPaise !== undefined && b.totalPaise < f.minPaise) return false;
  if (f.maxPaise !== undefined && b.totalPaise > f.maxPaise) return false;
  if (f.billNo && !b.billNo.includes(f.billNo)) return false;
  return true;
}

/** Item-level filter for dish/category figures (category and veg filters). */
export function itemFilterFor(f: ReportFilter): ((i: BillItem) => boolean) | undefined {
  if (!f.category && !f.food) return undefined;
  return (i) => (!f.category || i.category === f.category) && (!f.food || i.isVeg === (f.food === 'veg'));
}

export interface ReportData {
  stats: Stats;
  voided: number;
  source: 'summary' | 'scan';
  scanned: number;
  ms: number;
}

export async function runReport(f: ReportFilter): Promise<ReportData> {
  const t0 = performance.now();
  const monthKey = rangeIsWholeMonth(f.range);
  if (monthKey && !hasBillFilters(f)) {
    const s = (await getMonthlyStats(monthKey)) ?? { monthKey, ...emptyStats() };
    const { monthKey: _m, ...stats } = s;
    return { stats, voided: s.voidCount, source: 'summary', scanned: 0, ms: performance.now() - t0 };
  }
  const stats = emptyStats();
  const itemFilter = itemFilterFor(f);
  let voided = 0;
  let scanned = 0;
  await forEachBill(f.range, (b) => {
    scanned++;
    if (!billMatches(b, f)) return;
    if (b.status === 'void') voided++;
    else applyBill(stats, b, 1, itemFilter);
  });
  stats.voidCount = voided;
  return { stats, voided, source: 'scan', scanned, ms: performance.now() - t0 };
}

export interface DishRank {
  id: string;
  name: string;
  qty: number;
  paise: number;
}

const byName = (a: DishRank, b: DishRank) => a.name.localeCompare(b.name);

/**
 * Top-10 by quantity and by revenue (hash map already built in stats.byDish,
 * then heap-based top-K), plus least-sold among dishes currently on the menu,
 * including dishes with zero sales in the range.
 */
export function dishRankings(stats: Stats, menu: readonly Dish[], f: ReportFilter, k = 10) {
  const sold: DishRank[] = Object.entries(stats.byDish)
    .filter(([, d]) => d.qty > 0)
    .map(([id, d]) => ({ id, name: d.name, qty: d.qty, paise: d.paise }));
  const byQty = topK(sold, k, (d) => d.qty, (a, b) => b.paise - a.paise || byName(a, b));
  const byRevenue = topK(sold, k, (d) => d.paise, (a, b) => b.qty - a.qty || byName(a, b));

  const candidates: DishRank[] = menu
    .filter((d) => d.active && !d.deleted)
    .filter((d) => (!f.category || d.category === f.category) && (!f.food || d.isVeg === (f.food === 'veg')))
    .map((d) => {
      const s = stats.byDish[String(d.id)];
      return { id: String(d.id), name: d.name, qty: s?.qty ?? 0, paise: s?.paise ?? 0 };
    });
  const least = bottomK(candidates, k, (d) => d.qty, (a, b) => a.paise - b.paise || byName(a, b));
  return { byQty, byRevenue, least };
}

/** This month vs previous month, both straight from monthlyStats. */
export async function monthComparison(monthKey: string): Promise<{ curKey: string; prevKey: string; cur: Stats; prev: Stats }> {
  const prevKey = prevMonthKey(monthKey);
  const [c, p] = await Promise.all([getMonthlyStats(monthKey), getMonthlyStats(prevKey)]);
  return { curKey: monthKey, prevKey, cur: c ?? emptyStats(), prev: p ?? emptyStats() };
}

/** Percent change, or null when there is no previous value to compare with. */
export function pctChange(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}
