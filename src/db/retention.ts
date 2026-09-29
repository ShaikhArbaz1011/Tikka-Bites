/**
 * Keep 3 months: delete this phone's bills (and their monthly totals and
 * counters) from months older than `keepFrom` (YYYYMM). Used in both modes:
 * local-only phones use their own clock; with the shared database the server
 * says which month is the oldest kept (pull_changes → keepFrom).
 */
import { getDB } from './db';
import { keepFromMonth } from '../core/dates';

export async function purgeOldMonths(keepFrom: string = keepFromMonth()): Promise<number> {
  if (!/^\d{6}$/.test(keepFrom)) throw new RangeError('keepFrom must be YYYYMM');
  const db = await getDB();
  const older = IDBKeyRange.upperBound(keepFrom, true); // month keys sort as text: '202607' < '202608'
  const tx = db.transaction(['bills', 'monthlyStats', 'counters', 'meta'], 'readwrite');
  let removed = 0;
  const gone = new Set<string>();
  for (let c = await tx.objectStore('bills').index('monthKey').openCursor(older); c; c = await c.continue()) {
    gone.add(c.value.billNo);
    await c.delete();
    removed++;
  }
  for (let c = await tx.objectStore('monthlyStats').openCursor(older); c; c = await c.continue()) await c.delete();
  for (let c = await tx.objectStore('counters').openCursor(older); c; c = await c.continue()) await c.delete();
  if (gone.size) {
    const meta = tx.objectStore('meta');
    const outbox = (await meta.get('outbox')) as string[] | undefined;
    if (outbox?.some((n) => gone.has(n))) await meta.put(outbox.filter((n) => !gone.has(n)), 'outbox');
  }
  await tx.done;
  return removed;
}
