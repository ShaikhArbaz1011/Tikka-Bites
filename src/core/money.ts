/**
 * Money helpers. All amounts are integer PAISE (₹1 = 100 paise) and all
 * percentages are integer BASIS POINTS (1% = 100 bp). No floats in money math.
 */

export type Paise = number;
export type Bp = number;

export const MAX_PRICE_PAISE = 10_000_000; // ₹1,00,000 per dish
export const MAX_BP = 10_000; // 100%

export function isPaise(n: unknown): n is Paise {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/**
 * round(a × b ÷ d), rounding halves up, for non-negative safe integers.
 * Works entirely in integers: floor((2ab + d) / 2d).
 */
export function mulDivRound(a: number, b: number, d: number): number {
  if (a < 0 || b < 0 || d <= 0) throw new RangeError('mulDivRound expects non-negative inputs');
  const num = 2 * a * b + d;
  if (!Number.isSafeInteger(num)) throw new RangeError('mulDivRound overflow');
  return Math.floor(num / (2 * d));
}

/** Percentage of an amount: amount × bp / 10000, half-up. */
export function applyBp(amount: Paise, bp: Bp): Paise {
  return mulDivRound(amount, bp, MAX_BP);
}

/** Round to the nearest whole rupee (half-up). Returns the rounded paise amount. */
export function roundToRupee(p: Paise): Paise {
  return Math.floor((p + 50) / 100) * 100;
}

/** Parse a user-typed rupee amount ("120", "120.5", "1,20,000.00") into paise. */
export function parseRupees(input: string): Paise | null {
  const s = input.trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const rupees = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(2, '0');
  const p = rupees * 100 + Number(frac);
  return Number.isSafeInteger(p) ? p : null;
}

/** Parse a user-typed percentage ("18", "2.5", "12.25") into basis points. */
export function parsePercent(input: string): Bp | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= MAX_BP ? bp : null;
}

/** Group an integer string the Indian way: 12,34,567. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Display-only: 12345678 paise → "₹1,23,456.78". */
export function formatINR(p: Paise, symbol = '₹'): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100);
  const paise = String(abs % 100).padStart(2, '0');
  return `${neg ? '−' : ''}${symbol}${groupIndian(String(rupees))}.${paise}`;
}

/** Display-only short form for chart axes: ₹950, ₹12.5K, ₹3.2L, ₹1.1Cr. */
export function formatCompactINR(p: Paise, symbol = '₹'): string {
  const r = Math.abs(p) / 100;
  const sign = p < 0 ? '−' : '';
  const fmt = (n: number, unit: string) => `${sign}${symbol}${(Math.round(n * 10) / 10).toString()}${unit}`;
  if (r >= 1e7) return fmt(r / 1e7, 'Cr');
  if (r >= 1e5) return fmt(r / 1e5, 'L');
  if (r >= 1e3) return fmt(r / 1e3, 'K');
  return `${sign}${symbol}${Math.round(r)}`;
}

/** Paise → plain decimal string for inputs / CSV ("1234.50"). */
export function paiseToDecimal(p: Paise): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Basis points → display string ("18", "2.5"). */
export function formatBp(bp: Bp): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (!frac) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
