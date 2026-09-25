import { getDB, SETTINGS_KEY, DEFAULT_SETTINGS } from './db';
import { BACKUP_APP, BACKUP_SCHEMA_VERSION, type Backup } from '../core/backupSchema';
import { applyBill, emptyStats } from '../core/stats';
import { parseBillNo } from '../core/billNo';
import type { MonthlyStats, Settings } from './types';
import type { BagState } from '../core/shuffleBag';

/**
 * Export everything as a JSON Blob. Bills are streamed with a cursor and
 * serialised one by one, so 50k+ bills never sit in memory as one huge string.
 */
export async function exportBackup(now = Date.now()): Promise<Blob> {
  const db = await getDB();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(await db.get('settings', SETTINGS_KEY)), lastBackupAt: now };
  const [menu, cheesyLines, shuffleBag] = await Promise.all([db.getAll('menu'), db.getAll('cheesyLines'), db.get('meta', 'shuffleBag')]);

  const parts: string[] = [
    `{"app":${JSON.stringify(BACKUP_APP)},"schemaVersion":${BACKUP_SCHEMA_VERSION},"exportedAt":${now},`,
    `"settings":${JSON.stringify(settings)},"menu":${JSON.stringify(menu)},"cheesyLines":${JSON.stringify(cheesyLines)},`,
    `"meta":${JSON.stringify(shuffleBag ? { shuffleBag } : {})},"bills":[`,
  ];
  let first = true;
  let cursor = await db.transaction('bills').store.openCursor();
  while (cursor) {
    parts.push((first ? '' : ',') + JSON.stringify(cursor.value));
    first = false;
    cursor = await cursor.continue();
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

export async function markBackedUp(now = Date.now()): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('settings', 'readwrite');
  const s = { ...DEFAULT_SETTINGS, ...(await tx.store.get(SETTINGS_KEY)) };
  await tx.store.put({ ...s, lastBackupAt: now }, SETTINGS_KEY);
  await tx.done;
}

/**
 * Replace ALL data with a validated backup, in one transaction.
 * Monthly stats and bill counters are rebuilt from the bills themselves
 * rather than trusted from the file.
 */
export async function importBackup(b: Backup): Promise<void> {
  const stats = new Map<string, MonthlyStats>();
  const counters = new Map<string, number>();
  for (const bill of b.bills) {
    const seq = parseBillNo(bill.billNo)!.seq;
    counters.set(bill.monthKey, Math.max(counters.get(bill.monthKey) ?? 0, seq));
    let s = stats.get(bill.monthKey);
    if (!s) stats.set(bill.monthKey, (s = { monthKey: bill.monthKey, ...emptyStats() }));
    if (bill.status === 'paid') applyBill(s, bill, 1);
    else s.voidCount += 1;
  }

  const db = await getDB();
  const stores = ['menu', 'bills', 'counters', 'monthlyStats', 'settings', 'cheesyLines', 'meta'] as const;
  const tx = db.transaction([...stores], 'readwrite');
  for (const name of stores) void tx.objectStore(name).clear();
  void tx.objectStore('settings').put(b.settings, SETTINGS_KEY);
  for (const d of b.menu) void tx.objectStore('menu').put(d);
  for (const l of b.cheesyLines) void tx.objectStore('cheesyLines').put(l);
  for (const bill of b.bills) void tx.objectStore('bills').put(bill);
  for (const s of stats.values()) void tx.objectStore('monthlyStats').put(s);
  for (const [monthKey, last] of counters) void tx.objectStore('counters').put({ monthKey, last });
  if (b.meta.shuffleBag) void tx.objectStore('meta').put(b.meta.shuffleBag as BagState, 'shuffleBag');
  await tx.done;
}

export async function countBills(): Promise<number> {
  return (await getDB()).count('bills');
}
