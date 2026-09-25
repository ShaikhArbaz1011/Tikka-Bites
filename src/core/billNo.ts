/** Bill numbers: INV-YYYYMM-0001, counter resets each calendar month (device local time). */

export const BILL_NO_RE = /^INV-(\d{4})(0[1-9]|1[0-2])-(\d{4,})$/;

export function monthKeyOf(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function formatBillNo(monthKey: string, seq: number): string {
  if (!/^\d{6}$/.test(monthKey) || !Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError('Invalid bill number parts');
  }
  return `INV-${monthKey}-${String(seq).padStart(4, '0')}`;
}

export function parseBillNo(billNo: string): { monthKey: string; seq: number } | null {
  const m = BILL_NO_RE.exec(billNo);
  if (!m) return null;
  return { monthKey: `${m[1]}${m[2]}`, seq: Number(m[3]) };
}

/**
 * Given the last used counter for a month (or undefined when the month has
 * no bills yet), return the next bill number and new counter value.
 */
export function nextBillNo(monthKey: string, last: number | undefined): { billNo: string; seq: number } {
  const seq = (last ?? 0) + 1;
  return { billNo: formatBillNo(monthKey, seq), seq };
}
