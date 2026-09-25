/** Central input validation. Every user-entered value passes through here. */

import { MAX_PRICE_PAISE, parseRupees, parsePercent, type Paise, type Bp } from './money';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Trim, strip control characters, collapse runs of spaces (newlines kept if multiline). */
export function cleanText(s: string, multiline = false): string {
  const t = s.replace(CONTROL, '');
  return (multiline ? t.replace(/[ \t]+/g, ' ') : t.replace(/\s+/g, ' ')).trim();
}

export const LIMITS = {
  dishName: 60,
  category: 30,
  customerName: 60,
  tableNo: 10,
  restaurantName: 80,
  address: 200,
  phone: 20,
  cheesyLine: 120,
  voidReason: 200,
  currencySymbol: 3,
  qtyMax: 999,
} as const;

export function text(label: string, s: string, min: number, max: number, multiline = false): Result<string> {
  const v = cleanText(s, multiline);
  if (v.length < min) return err(min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`);
  if (v.length > max) return err(`${label} must be at most ${max} characters`);
  return ok(v);
}

export function optionalText(label: string, s: string, max: number): Result<string | undefined> {
  const v = cleanText(s);
  if (!v) return ok(undefined);
  return v.length > max ? err(`${label} must be at most ${max} characters`) : ok(v);
}

export function price(s: string): Result<Paise> {
  const p = parseRupees(s);
  if (p === null) return err('Enter a valid price, e.g. 120 or 99.50');
  if (p <= 0) return err('Price must be more than 0');
  if (p > MAX_PRICE_PAISE) return err('Price must be at most ₹1,00,000');
  return ok(p);
}

export function isQty(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= LIMITS.qtyMax;
}

export function qty(s: string): Result<number> {
  if (!/^\d{1,3}$/.test(s.trim())) return err('Quantity must be a whole number 1–999');
  const n = Number(s.trim());
  return isQty(n) ? ok(n) : err('Quantity must be a whole number 1–999');
}

export function discountPercent(s: string): Result<Bp> {
  const bp = parsePercent(s);
  if (bp === null) return err('Discount must be between 0 and 100%');
  return ok(bp);
}

export function discountFlat(s: string): Result<Paise> {
  if (!s.trim()) return ok(0);
  const p = parseRupees(s);
  return p === null ? err('Enter a valid discount amount') : ok(p);
}

export function phone(s: string): Result<string | undefined> {
  const v = cleanText(s);
  if (!v) return ok(undefined);
  return /^\+?[\d\s-]{6,20}$/.test(v) ? ok(v) : err('Enter a valid phone number');
}

export const DISH_IMAGE_PATH_RE = /^\/dishes\/[a-z0-9-]{1,40}\.webp$/;
export const MAX_DISH_IMAGE_CHARS = 200_000;

/** A built-in photo path or a PNG/JPEG/WEBP data URL of sane size. */
export function isDishImage(v: unknown): v is string {
  return typeof v === 'string' && (DISH_IMAGE_PATH_RE.test(v) || (v.length <= MAX_DISH_IMAGE_CHARS && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v)));
}
