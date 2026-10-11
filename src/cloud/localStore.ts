/**
 * This phone's copy of the shared database. Billing and reports read it (fast,
 * and it works offline); sync writes what the server sends into it here, keeping
 * the monthly totals exact (the same applyBill() the local-only mode uses).
 */
import { getDB, SETTINGS_KEY } from '../db/db';
import { getMeta, setMeta, deleteMeta } from '../db/settingsRepo';
import { applyBill, emptyStats } from '../core/stats';
import { parseBillNo } from '../core/billNo';
import { cloudConfig } from './config';
import { dishFromRow, lineFromRow, type LineRow, type MenuRow } from './api';
import type { Bill, Counter, MonthlyStats, Settings } from '../db/types';

const STORES = ['menu', 'cheesyLines', 'settings', 'bills', 'monthlyStats', 'counters', 'meta'] as const;

export interface Changes {
  menu?: MenuRow[];
  lines?: LineRow[];
  settings?: Settings | null;
  bills?: Bill[];
}

/** Letters/digits without look-alikes (no 0/O, 1/I/L). */
const TAG_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Apply server changes in ONE transaction. A server bill that stands for a bill
 * this phone made offline (same printed OFF- number, or `replaces`) takes its
 * place: the temporary bill is removed and the totals move over, never counted twice.
 */
export async function applyChanges(c: Changes, replaces?: Map<string, string>): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([...STORES], 'readwrite');
  const bills = tx.objectStore('bills');
  const statsStore = tx.objectStore('monthlyStats');
  const meta = tx.objectStore('meta');
  const stats = new Map<string, MonthlyStats>();
  const statsFor = async (monthKey: string) => {
    let s = stats.get(monthKey);
    if (!s) {
      s = (await statsStore.get(monthKey)) ?? { monthKey, ...emptyStats() };
      stats.set(monthKey, s);
    }
    return s;
  };

  for (const row of c.menu ?? []) await tx.objectStore('menu').put(dishFromRow(row));
  for (const row of c.lines ?? []) {
    if (row.removed) await tx.objectStore('cheesyLines').delete(Number(row.id));
    else await tx.objectStore('cheesyLines').put(lineFromRow(row));
  }
  if (c.settings) await tx.objectStore('settings').put(c.settings, SETTINGS_KEY);

  if (c.bills?.length) {
    let outbox = ((await meta.get('outbox')) as string[] | undefined) ?? [];
    const outboxBefore = outbox.length;
    for (const b of c.bills) {
      // 1. The offline bill this server bill replaces (if it is still on this phone).
      const tempNo = replaces?.get(b.billNo) ?? b.printedAs;
      if (tempNo && tempNo !== b.billNo) {
        const temp = await bills.get(tempNo);
        if (temp?.sync) {
          const s = await statsFor(temp.monthKey);
          if (temp.status === 'paid') applyBill(s, temp, -1);
          else s.voidCount -= 1;
          await bills.delete(tempNo);
          outbox = outbox.filter((n) => n !== tempNo);
        }
      }
      // 2. The server bill itself: new, or a change (e.g. voided on another phone).
      const existing = await bills.get(b.billNo);
      const s = await statsFor(b.monthKey);
      if (!existing) {
        if (b.status === 'paid') applyBill(s, b, 1);
        else s.voidCount += 1;
      } else if (existing.status === 'paid' && b.status === 'void') {
        applyBill(s, existing, -1);
        s.voidCount += 1;
      }
      await bills.put(b);
    }
    if (outbox.length !== outboxBefore) await meta.put(outbox, 'outbox');
  }
  for (const s of stats.values()) await statsStore.put(s);
  await tx.done;
}

/** Save a bill made while offline, with the next temporary number (OFF-<phone>-0001). */
export async function storePendingBill(bill: Omit<Bill, 'billNo'> & { sync: { clientRef: string } }): Promise<Bill> {
  const db = await getDB();
  const tx = db.transaction(['bills', 'monthlyStats', 'meta'], 'readwrite');
  const meta = tx.objectStore('meta');
  let tag = (await meta.get('deviceTag')) as string | undefined;
  if (!tag) {
    const r = crypto.getRandomValues(new Uint8Array(3));
    tag = [...r].map((x) => TAG_CHARS[x % TAG_CHARS.length]).join('');
    await meta.put(tag, 'deviceTag');
  }
  const seq = (((await meta.get('offSeq')) as number | undefined) ?? 0) + 1;
  await meta.put(seq, 'offSeq');
  const full: Bill = { ...bill, billNo: `OFF-${tag}-${String(seq).padStart(4, '0')}` };
  await tx.objectStore('bills').add(full);
  const statsStore = tx.objectStore('monthlyStats');
  const s = (await statsStore.get(full.monthKey)) ?? { monthKey: full.monthKey, ...emptyStats() };
  applyBill(s, full, 1);
  await statsStore.put(s);
  const outbox = ((await meta.get('outbox')) as string[] | undefined) ?? [];
  await meta.put([...outbox, full.billNo], 'outbox');
  await tx.done;
  return full;
}

/** Bills made offline that are still waiting to upload (oldest first). */
export async function pendingBills(): Promise<Bill[]> {
  const db = await getDB();
  const outbox = ((await db.get('meta', 'outbox')) as string[] | undefined) ?? [];
  const out: Bill[] = [];
  for (const no of outbox) {
    const b = await db.get('bills', no);
    if (b?.sync) out.push(b);
  }
  return out;
}

export async function setSyncError(billNo: string, error: string | undefined): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('bills', 'readwrite');
  const b = await tx.store.get(billNo);
  if (b?.sync) {
    const sync: Bill['sync'] = error ? { ...b.sync, error } : { clientRef: b.sync.clientRef };
    await tx.store.put({ ...b, sync });
  }
  await tx.done;
}

/** Cancel an offline bill before it is uploaded: kept on this phone as void, never sent. */
export async function voidPendingLocally(billNo: string, reason: string, now = Date.now()): Promise<Bill> {
  const db = await getDB();
  const tx = db.transaction(['bills', 'monthlyStats', 'meta'], 'readwrite');
  const bill = await tx.objectStore('bills').get(billNo);
  if (!bill?.sync) throw new Error('Bill not found');
  if (bill.status === 'void') throw new Error('Bill is already voided');
  const updated: Bill = { ...bill, status: 'void', voidReason: reason, voidedAt: now, sync: { ...bill.sync, error: 'Cancelled before upload' } };
  await tx.objectStore('bills').put(updated);
  const statsStore = tx.objectStore('monthlyStats');
  const s = (await statsStore.get(bill.monthKey)) ?? { monthKey: bill.monthKey, ...emptyStats() };
  applyBill(s, bill, -1);
  s.voidCount += 1;
  await statsStore.put(s);
  const outbox = ((await tx.objectStore('meta').get('outbox')) as string[] | undefined) ?? [];
  await tx.objectStore('meta').put(outbox.filter((n) => n !== billNo), 'outbox');
  await tx.done;
  return updated;
}

/**
 * Empty this phone's copy of the shared data (first join, or the shared database was
 * re-created). Offline bills still waiting to upload are kept and re-counted.
 */
export async function resetSharedCopy(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([...STORES], 'readwrite');
  const meta = tx.objectStore('meta');
  const outbox = ((await meta.get('outbox')) as string[] | undefined) ?? [];
  const keep: Bill[] = [];
  for (const no of outbox) {
    const b = await tx.objectStore('bills').get(no);
    if (b?.sync) keep.push(b);
  }
  for (const name of ['menu', 'cheesyLines', 'settings', 'bills', 'monthlyStats', 'counters'] as const) await tx.objectStore(name).clear();
  const stats = new Map<string, MonthlyStats>();
  for (const b of keep) {
    await tx.objectStore('bills').put(b);
    const s = stats.get(b.monthKey) ?? { monthKey: b.monthKey, ...emptyStats() };
    if (b.status === 'paid') applyBill(s, b, 1);
    stats.set(b.monthKey, s);
  }
  for (const s of stats.values()) await tx.objectStore('monthlyStats').put(s);
  await meta.put(keep.map((b) => b.billNo), 'outbox');
  await meta.delete('cloudRev');
  await meta.delete('cloudDbId');
  await tx.done;
}

/**
 * The shared database this phone last used ("sheets https://…/exec"). Phones from before
 * this was recorded were on Supabase. Another one now: the old sign-in and change number
 * mean nothing there, so they go; the data and any bills waiting to upload stay, and the
 * usual first-time screens follow (set up from this phone, or join).
 */
export async function forgetOtherDatabase(): Promise<boolean> {
  const c = cloudConfig();
  const now = `${c.backend} ${c.url}`;
  const before = await getMeta('cloudBackend');
  const changed = before === undefined ? c.backend !== 'supabase' && (await getMeta('cloudDbId')) !== undefined : before !== now;
  if (changed) {
    await deleteMeta('session');
    await deleteMeta('cloudRev');
    await deleteMeta('cloudDbId');
  }
  if (before !== now) await setMeta('cloudBackend', now);
  return changed;
}

/** Receipt counters for the upload: this phone's own, raised to the highest number among its bills. */
export function countersFor(stored: Counter[], bills: Bill[]): Counter[] {
  const last = new Map(stored.map((c) => [c.monthKey, c.last]));
  for (const b of bills) {
    const p = parseBillNo(b.billNo);
    if (p && p.seq > (last.get(p.monthKey) ?? 0)) last.set(p.monthKey, p.seq);
  }
  return [...last].map(([monthKey, n]) => ({ monthKey, last: n }));
}
