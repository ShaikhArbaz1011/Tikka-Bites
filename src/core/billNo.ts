/**
 * Receipt numbers: RCPT-YYYYMM-0001. The counter resets each calendar month
 * (device local time). Bills saved before the switch from invoices to receipts
 * were numbered INV-YYYYMM-0001; they stay valid everywhere (look-up, reports,
 * backups) and share the monthly counter, so numbering simply carries on.
 */

export const BILL_PREFIX = 'RCPT';
/** Prefix used before Tikka Bites switched from invoices to receipts. */
export const LEGACY_BILL_PREFIX = 'INV';

export const BILL_NO_RE = /^(?:RCPT|INV)-(\d{4})(0[1-9]|1[0-2])-(\d{4,})$/;

/** Temporary number of a bill made offline with the shared database on (OFF-<phone code>-0001). */
export const OFFLINE_NO_RE = /^OFF-[A-Z0-9]{3,6}-\d{4,}$/;

export function monthKeyOf(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function formatBillNo(monthKey: string, seq: number): string {
  if (!/^\d{6}$/.test(monthKey) || !Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError('Invalid bill number parts');
  }
  return `${BILL_PREFIX}-${monthKey}-${String(seq).padStart(4, '0')}`;
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
