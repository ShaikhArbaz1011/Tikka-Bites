/**
 * Receipt numbers.
 *  - Now (owner request, 24 Oct 2026): RCPT-YYYY-0001. One counter per calendar
 *    year (India time), so numbering starts again at 0001 every 1 January.
 *  - Before that: RCPT-YYYYMM-0001, one counter per month. Earlier still, bills
 *    were invoices: INV-YYYYMM-0001. Both stay valid everywhere (look-up,
 *    reports, backups) and keep their numbers; they are just never issued again.
 * A counter is stored under its "counter key": the year (YYYY) for yearly
 * numbers, the month (YYYYMM) for the old monthly ones.
 */

export const BILL_PREFIX = 'RCPT';
/** Prefix used before Tikka Bites switched from invoices to receipts. */
export const LEGACY_BILL_PREFIX = 'INV';

/** Old monthly numbers: RCPT-202610-0007 or INV-202609-0042. */
export const MONTHLY_NO_RE = /^(?:RCPT|INV)-(\d{4})(0[1-9]|1[0-2])-(\d{4,})$/;
/** Yearly numbers: RCPT-2026-0001. */
export const YEARLY_NO_RE = /^RCPT-(\d{4})-(\d{4,})$/;
/** Any final receipt number (yearly or the old monthly kind). */
export const BILL_NO_RE = /^(?:RCPT-\d{4}|(?:RCPT|INV)-\d{4}(?:0[1-9]|1[0-2]))-\d{4,}$/;

/** Temporary number of a bill made offline with the shared database on (OFF-<phone code>-0001). */
export const OFFLINE_NO_RE = /^OFF-[A-Z0-9]{3,6}-\d{4,}$/;

export function monthKeyOf(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** The counter key for a new bill: its year. */
export function yearKeyOf(d: Date | number): string {
  return String((typeof d === 'number' ? new Date(d) : d).getFullYear());
}

export function formatBillNo(year: string, seq: number): string {
  if (!/^\d{4}$/.test(year) || !Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError('Invalid bill number parts');
  }
  return `${BILL_PREFIX}-${year}-${String(seq).padStart(4, '0')}`;
}

export interface ParsedBillNo {
  /** Where its counter lives: YYYY (yearly) or YYYYMM (old monthly). */
  counterKey: string;
  year: string;
  /** Only the old monthly numbers carry their month. */
  monthKey?: string;
  seq: number;
}

export function parseBillNo(billNo: string): ParsedBillNo | null {
  const y = YEARLY_NO_RE.exec(billNo);
  if (y) return { counterKey: y[1]!, year: y[1]!, seq: Number(y[2]) };
  const m = MONTHLY_NO_RE.exec(billNo);
  if (!m) return null;
  return { counterKey: `${m[1]}${m[2]}`, year: m[1]!, monthKey: `${m[1]}${m[2]}`, seq: Number(m[3]) };
}

/** Does this final bill number fit the bill's month (YYYYMM)? */
export function billNoMatchesMonth(billNo: string, monthKey: string): boolean {
  const p = parseBillNo(billNo);
  if (!p || !/^\d{6}$/.test(monthKey)) return false;
  return p.monthKey ? p.monthKey === monthKey : monthKey.startsWith(p.year);
}

/**
 * Given the last used counter for a year (or undefined when the year has
 * no bills yet), return the next bill number and new counter value.
 */
export function nextBillNo(year: string, last: number | undefined): { billNo: string; seq: number } {
  const seq = (last ?? 0) + 1;
  return { billNo: formatBillNo(year, seq), seq };
}
