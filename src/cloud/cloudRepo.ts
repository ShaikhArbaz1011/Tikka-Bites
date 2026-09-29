/**
 * What saving does when the shared database is on (plugged in via db/hooks.ts).
 *  - Bills: the server numbers them (RCPT-…). With no internet the bill is saved
 *    on this phone with a temporary number (OFF-…) and uploaded later; billing
 *    never stops.
 *  - Void, menu, cheesy lines and settings go to the server and need internet.
 * Results are written into this phone's copy, which the screens read.
 */
import { api, dishFromRow, dishToRow, lineFromRow } from './api';
import { CloudError } from './errors';
import { applyChanges, storePendingBill, voidPendingLocally } from './localStore';
import { syncNow } from './sync';
import { getDB, SETTINGS_KEY, DEFAULT_SETTINGS } from '../db/db';
import { BillError, FALLBACK_LINE, type BillDraft } from '../db/billRepo';
import { MenuError } from '../db/menuRepo';
import { LineError } from '../db/linesRepo';
import { computeTotals } from '../core/totals';
import { monthKeyOf } from '../core/billNo';
import { draw, type BagState } from '../core/shuffleBag';
import type { CloudHooks } from '../db/hooks';
import type { Bill, BillItem, Settings } from '../db/types';

/** How long to wait for the server before saving the bill offline instead. */
const ONLINE_SAVE_TIMEOUT_MS = 6000;

/** Offline-safe kinds: save the bill on the phone and upload it later. */
const SAVE_OFFLINE: ReadonlySet<CloudError['kind']> = new Set(['offline', 'server', 'auth']);

async function buildBill(draft: BillDraft, now: number): Promise<Omit<Bill, 'billNo'>> {
  const db = await getDB();
  const settings = { ...DEFAULT_SETTINGS, ...(await db.get('settings', SETTINGS_KEY)) };
  const items: BillItem[] = [];
  for (const { menuId, qty } of draft.items) {
    const dish = await db.get('menu', menuId);
    if (!dish || dish.deleted) throw new BillError('A dish in this bill no longer exists');
    items.push({ menuId, name: dish.name, category: dish.category, isVeg: dish.isVeg, unitPaise: dish.pricePaise, qty, linePaise: dish.pricePaise * qty });
  }
  const totals = computeTotals(items, draft.discount, settings.roundOff);

  // Cheesy line from this phone's shuffle bag.
  const tx = db.transaction(['cheesyLines', 'meta'], 'readwrite');
  const lines = (await tx.objectStore('cheesyLines').getAll()).filter((l) => l.active);
  const pick = draw((await tx.objectStore('meta').get('shuffleBag')) as BagState | undefined, lines.map((l) => l.id));
  await tx.objectStore('meta').put(pick.state, 'shuffleBag');
  await tx.done;

  const date = new Date(now);
  return {
    createdAt: now,
    monthKey: monthKeyOf(now),
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
    cheesyLine: lines.find((l) => l.id === pick.id)?.text ?? FALLBACK_LINE,
    status: 'paid',
  };
}

async function saveBill(draft: BillDraft, now: number): Promise<Bill> {
  const bill = await buildBill(draft, now);
  const clientRef = crypto.randomUUID();
  try {
    const saved = await api.saveBill(
      {
        clientRef,
        items: bill.items.map((i) => ({ menuId: i.menuId, qty: i.qty, unitPaise: i.unitPaise })),
        orderType: bill.orderType,
        tableNo: bill.tableNo,
        customerName: bill.customerName,
        paymentMode: bill.paymentMode,
        discount: bill.discount,
        roundOffPaise: bill.roundOffPaise,
        totalPaise: bill.totalPaise,
        cheesyLine: bill.cheesyLine,
      },
      ONLINE_SAVE_TIMEOUT_MS,
    );
    await applyChanges({ bills: [saved] });
    return saved;
  } catch (e) {
    if (!(e instanceof CloudError)) throw e;
    if (SAVE_OFFLINE.has(e.kind)) {
      // No reply: keep billing. Same clientRef, so if the server did save it, the upload finds that bill.
      const pending = await storePendingBill({ ...bill, sync: { clientRef } });
      void syncNow(); // shows "Offline · 1 waiting" now, and uploads at once if the connection is back
      return pending;
    }
    if (e.kind === 'rejected') void syncNow(); // e.g. a price changed on another phone: fetch the new menu
    throw new BillError(e.message);
  }
}

async function voidBill(billNo: string, reason: string): Promise<Bill> {
  const local = await (await getDB()).get('bills', billNo);
  if (local?.sync) return voidPendingLocally(billNo, reason); // never uploaded: just cancel it here
  try {
    const voided = await api.voidBill(billNo, reason);
    await applyChanges({ bills: [voided] });
    return voided;
  } catch (e) {
    if (e instanceof CloudError) throw new BillError(e.kind === 'offline' ? 'Voiding needs the internet. Try again when you are online.' : e.message);
    throw e;
  }
}

/** Menu / lines / settings need internet; turn cloud errors into the screen's own error types. */
async function guard<T>(what: 'menu' | 'line' | 'settings', fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof CloudError)) throw e;
    const msg = e.kind === 'offline' ? 'Changes to the menu and settings need the internet. Try again when you are online.' : e.message;
    if (what === 'menu') throw new MenuError(msg);
    if (what === 'line') throw new LineError(msg);
    throw e;
  }
}

async function patchDish(id: number, patch: Parameters<typeof api.updateDish>[1]) {
  const row = await api.updateDish(id, patch);
  await applyChanges({ menu: [row] });
  return dishFromRow(row);
}

export const cloudRepo: CloudHooks = {
  saveBill,
  voidBill,
  addDish: (d) =>
    guard('menu', async () => {
      const rows = await api.insertDishes([dishToRow(d)]);
      await applyChanges({ menu: rows });
      return dishFromRow(rows[0]!);
    }),
  addDishes: (list) =>
    guard('menu', async () => {
      await applyChanges({ menu: await api.insertDishes(list.map(dishToRow)) });
    }),
  updateDish: (id, d) => guard('menu', () => patchDish(id, dishToRow(d))),
  setDishActive: (id, active) => guard('menu', async () => void (await patchDish(id, { active }))),
  // Other phones may have billed it: always hidden (kept), never erased.
  deleteDish: (id) => guard('menu', async () => (await patchDish(id, { deleted: true, active: false }), 'soft' as const)),

  saveSettings: (patch) =>
    guard('settings', async () => {
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) unset.push(k);
        else set[k] = v;
      }
      const saved = await api.patchSettings(set as Partial<Settings>, unset);
      await applyChanges({ settings: saved });
      return { ...DEFAULT_SETTINGS, ...saved };
    }),

  addLine: (text) =>
    guard('line', async () => {
      const row = await api.insertLine(text);
      await applyChanges({ lines: [row] });
      return lineFromRow(row);
    }),
  updateLine: (id, patch) =>
    guard('line', async () => {
      await applyChanges({ lines: [await api.updateLine(id, patch)] });
    }),
  deleteLine: (id) =>
    guard('line', async () => {
      await applyChanges({ lines: [await api.updateLine(id, { removed: true })] });
    }),
};
