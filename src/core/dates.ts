/** Date ranges in device-local time. Ranges are [start, end) in epoch ms. */

export type Range = { start: number; end: number };
export type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth';

const DAY = 86_400_000;

export function startOfDay(t: number | Date): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  // setDate handles DST correctly (unlike adding 24h).
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function presetRange(p: Preset, now: number = Date.now()): Range {
  const today = startOfDay(now);
  switch (p) {
    case 'today':
      return { start: +today, end: +addDays(today, 1) };
    case 'yesterday':
      return { start: +addDays(today, -1), end: +today };
    case 'week': {
      const mondayOffset = (today.getDay() + 6) % 7; // Mon = 0
      const start = addDays(today, -mondayOffset);
      return { start: +start, end: +addDays(start, 7) };
    }
    case 'month':
      return monthRange(today.getFullYear(), today.getMonth());
    case 'lastMonth':
      return monthRange(today.getFullYear(), today.getMonth() - 1);
  }
}

/** month is 0-based and may be out of range (Date normalises it). */
export function monthRange(year: number, month: number): Range {
  return { start: +new Date(year, month, 1), end: +new Date(year, month + 1, 1) };
}

export function monthKeyRange(monthKey: string): Range {
  return monthRange(Number(monthKey.slice(0, 4)), Number(monthKey.slice(4, 6)) - 1);
}

export function prevMonthKey(monthKey: string): string {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(4, 6)) - 1;
  const d = new Date(y, m - 1, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Custom range from two "YYYY-MM-DD" input values, inclusive of the end day. */
export function customRange(from: string, to: string): Range | null {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = re.exec(from);
  const b = re.exec(to);
  if (!a || !b) return null;
  const start = +new Date(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = +addDays(new Date(Number(b[1]), Number(b[2]) - 1, Number(b[3])), 1);
  return end > start ? { start, end } : null;
}

/** True when the range exactly covers one calendar month; returns its key. */
export function rangeIsWholeMonth(r: Range): string | null {
  const d = new Date(r.start);
  const m = monthRange(d.getFullYear(), d.getMonth());
  if (m.start !== r.start || m.end !== r.end) return null;
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function daysIn(r: Range): number {
  return Math.round((r.end - r.start) / DAY);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateISO(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatMonthKey(monthKey: string): string {
  return `${MONTHS[Number(monthKey.slice(4, 6)) - 1]} ${monthKey.slice(0, 4)}`;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
