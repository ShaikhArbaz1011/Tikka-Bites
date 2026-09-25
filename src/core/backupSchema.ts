/**
 * Strict backup-file validator (hand-written, no schema library).
 * Every field is type- and range-checked, unknown keys are rejected, and
 * bill arithmetic is re-verified, so a tampered or corrupt file can't get in.
 */
import { MAX_PRICE_PAISE, MAX_BP } from './money';
import { BILL_NO_RE } from './billNo';
import { discountAmount, type Discount } from './totals';
import { LIMITS } from './validate';
import type { Bill, BillItem, CheesyLine, Dish, Settings } from '../db/types';
import type { BagState } from './shuffleBag';

export const BACKUP_APP = 'restobill';
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const MAX_LOGO_CHARS = 700_000;
const MAX_TIME = 8.64e15;

export interface Backup {
  app: typeof BACKUP_APP;
  schemaVersion: number;
  exportedAt: number;
  settings: Settings;
  menu: Dish[];
  bills: Bill[];
  cheesyLines: CheesyLine[];
  meta: { shuffleBag?: BagState };
}

class Invalid extends Error {}

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new Invalid(`${path}: ${msg}`);
}

function obj(v: unknown, path: string, required: string[], optional: string[] = []): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  const o = v as Obj;
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) fail(path, `unknown field "${k}"`);
  for (const k of required) if (!(k in o)) fail(path, `missing field "${k}"`);
  return o;
}

function str(v: unknown, path: string, min: number, max: number): string {
  if (typeof v !== 'string') fail(path, 'must be text');
  if (v.length < min || v.length > max) fail(path, `must be ${min}–${max} characters`);
  return v;
}

function optStr(o: Obj, k: string, path: string, max: number): void {
  if (k in o) str(o[k], `${path}.${k}`, 0, max);
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(path, 'must be a whole number');
  if (v < min || v > max) fail(path, `must be between ${min} and ${max}`);
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'must be true or false');
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !options.includes(v as T)) fail(path, `must be one of ${options.join(', ')}`);
  return v as T;
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be a list');
  if (v.length > max) fail(path, `has too many entries (max ${max})`);
  return v;
}

function checkSettings(v: unknown, p: string): void {
  const o = obj(v, p, ['name', 'address', 'phone', 'currencySymbol', 'receiptWidth', 'roundOff'], ['logoDataUrl', 'lastBackupAt']);
  str(o['name'], `${p}.name`, 1, LIMITS.restaurantName);
  str(o['address'], `${p}.address`, 0, LIMITS.address);
  str(o['phone'], `${p}.phone`, 0, LIMITS.phone);
  str(o['currencySymbol'], `${p}.currencySymbol`, 1, LIMITS.currencySymbol);
  oneOf(o['receiptWidth'], `${p}.receiptWidth`, ['58', '80', 'A4'] as const);
  bool(o['roundOff'], `${p}.roundOff`);
  if ('logoDataUrl' in o) {
    const logo = str(o['logoDataUrl'], `${p}.logoDataUrl`, 1, MAX_LOGO_CHARS);
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(logo)) fail(`${p}.logoDataUrl`, 'must be a PNG, JPEG or WEBP image');
  }
  if ('lastBackupAt' in o) int(o['lastBackupAt'], `${p}.lastBackupAt`, 0, MAX_TIME);
}

function checkDish(v: unknown, p: string): number {
  const o = obj(v, p, ['id', 'name', 'nameLower', 'category', 'pricePaise', 'isVeg', 'active', 'deleted', 'usedInBills', 'createdAt', 'updatedAt']);
  const id = int(o['id'], `${p}.id`, 1, Number.MAX_SAFE_INTEGER);
  const name = str(o['name'], `${p}.name`, 1, LIMITS.dishName);
  if (o['nameLower'] !== name.toLowerCase()) fail(`${p}.nameLower`, 'does not match name');
  str(o['category'], `${p}.category`, 1, LIMITS.category);
  int(o['pricePaise'], `${p}.pricePaise`, 1, MAX_PRICE_PAISE);
  for (const k of ['isVeg', 'active', 'deleted', 'usedInBills']) bool(o[k], `${p}.${k}`);
  int(o['createdAt'], `${p}.createdAt`, 0, MAX_TIME);
  int(o['updatedAt'], `${p}.updatedAt`, 0, MAX_TIME);
  return id;
}

function checkItem(v: unknown, p: string): BillItem {
  const o = obj(v, p, ['menuId', 'name', 'category', 'isVeg', 'unitPaise', 'qty', 'linePaise']);
  int(o['menuId'], `${p}.menuId`, 1, Number.MAX_SAFE_INTEGER);
  str(o['name'], `${p}.name`, 1, LIMITS.dishName);
  str(o['category'], `${p}.category`, 1, LIMITS.category);
  bool(o['isVeg'], `${p}.isVeg`);
  const unit = int(o['unitPaise'], `${p}.unitPaise`, 1, MAX_PRICE_PAISE);
  const qty = int(o['qty'], `${p}.qty`, 1, LIMITS.qtyMax);
  if (int(o['linePaise'], `${p}.linePaise`, 1, Number.MAX_SAFE_INTEGER) !== unit * qty) fail(`${p}.linePaise`, 'is not price × quantity');
  return o as unknown as BillItem;
}

function checkDiscount(v: unknown, p: string): Discount {
  const kind = (v as Obj | null)?.['kind'];
  if (kind === 'flat') {
    const o = obj(v, p, ['kind', 'paise']);
    int(o['paise'], `${p}.paise`, 0, Number.MAX_SAFE_INTEGER);
  } else if (kind === 'pct') {
    const o = obj(v, p, ['kind', 'bp']);
    int(o['bp'], `${p}.bp`, 0, MAX_BP);
  } else fail(`${p}.kind`, 'must be flat or pct');
  return v as Discount;
}

const BILL_REQUIRED = [
  'billNo', 'createdAt', 'monthKey', 'hour', 'weekday', 'items', 'orderType', 'paymentMode', 'discount',
  'subtotalPaise', 'discountPaise', 'roundOffPaise', 'totalPaise', 'itemCount', 'categories', 'hasVeg', 'hasNonVeg',
  'cheesyLine', 'status',
];

function checkBill(v: unknown, p: string): string {
  const o = obj(v, p, BILL_REQUIRED, ['tableNo', 'customerName', 'voidReason', 'voidedAt']);
  const billNo = str(o['billNo'], `${p}.billNo`, 1, 30);
  const m = BILL_NO_RE.exec(billNo);
  if (!m) fail(`${p}.billNo`, 'is not in INV-YYYYMM-0001 format');
  if (o['monthKey'] !== `${m[1]}${m[2]}`) fail(`${p}.monthKey`, 'does not match bill number');
  int(o['createdAt'], `${p}.createdAt`, 0, MAX_TIME);
  int(o['hour'], `${p}.hour`, 0, 23);
  int(o['weekday'], `${p}.weekday`, 0, 6);
  const items = arr(o['items'], `${p}.items`, 500).map((it, i) => checkItem(it, `${p}.items[${i}]`));
  if (!items.length) fail(`${p}.items`, 'must have at least one item');
  oneOf(o['orderType'], `${p}.orderType`, ['dine-in', 'takeaway', 'delivery'] as const);
  oneOf(o['paymentMode'], `${p}.paymentMode`, ['cash', 'upi', 'card'] as const);
  optStr(o, 'tableNo', p, LIMITS.tableNo);
  optStr(o, 'customerName', p, LIMITS.customerName);
  const discount = checkDiscount(o['discount'], `${p}.discount`);

  const subtotal = items.reduce((s, i) => s + i.linePaise, 0);
  if (int(o['subtotalPaise'], `${p}.subtotalPaise`, 0, Number.MAX_SAFE_INTEGER) !== subtotal) fail(`${p}.subtotalPaise`, 'does not match items');
  if (int(o['discountPaise'], `${p}.discountPaise`, 0, Number.MAX_SAFE_INTEGER) !== discountAmount(subtotal, discount)) fail(`${p}.discountPaise`, 'does not match discount');
  const round = int(o['roundOffPaise'], `${p}.roundOffPaise`, -50, 50);
  if (int(o['totalPaise'], `${p}.totalPaise`, 0, Number.MAX_SAFE_INTEGER) !== subtotal - (o['discountPaise'] as number) + round) fail(`${p}.totalPaise`, 'does not add up');
  if (int(o['itemCount'], `${p}.itemCount`, 1, Number.MAX_SAFE_INTEGER) !== items.reduce((s, i) => s + i.qty, 0)) fail(`${p}.itemCount`, 'does not match items');
  arr(o['categories'], `${p}.categories`, 500).forEach((c, i) => str(c, `${p}.categories[${i}]`, 1, LIMITS.category));
  bool(o['hasVeg'], `${p}.hasVeg`);
  bool(o['hasNonVeg'], `${p}.hasNonVeg`);
  str(o['cheesyLine'], `${p}.cheesyLine`, 0, LIMITS.cheesyLine);
  const status = oneOf(o['status'], `${p}.status`, ['paid', 'void'] as const);
  if (status === 'void') {
    str(o['voidReason'], `${p}.voidReason`, 1, LIMITS.voidReason);
    int(o['voidedAt'], `${p}.voidedAt`, 0, MAX_TIME);
  } else if ('voidReason' in o || 'voidedAt' in o) fail(p, 'a paid bill cannot have void details');
  return billNo;
}

function checkLine(v: unknown, p: string): number {
  const o = obj(v, p, ['id', 'text', 'builtIn', 'active']);
  const id = int(o['id'], `${p}.id`, 1, Number.MAX_SAFE_INTEGER);
  str(o['text'], `${p}.text`, 1, LIMITS.cheesyLine);
  bool(o['builtIn'], `${p}.builtIn`);
  bool(o['active'], `${p}.active`);
  return id;
}

function unique<T>(values: T[], path: string, what: string): void {
  const seen = new Set<T>();
  for (const v of values) {
    if (seen.has(v)) fail(path, `duplicate ${what} ${String(v)}`);
    seen.add(v);
  }
}

export type ValidationResult = { ok: true; backup: Backup } | { ok: false; error: string };

/** Validate parsed JSON. Never throws. */
export function validateBackup(data: unknown): ValidationResult {
  try {
    const o = obj(data, 'backup', ['app', 'schemaVersion', 'exportedAt', 'settings', 'menu', 'bills', 'cheesyLines', 'meta']);
    if (o['app'] !== BACKUP_APP) fail('backup.app', 'this is not a RestoBill backup');
    if (o['schemaVersion'] !== BACKUP_SCHEMA_VERSION) fail('backup.schemaVersion', `unsupported version (expected ${BACKUP_SCHEMA_VERSION})`);
    int(o['exportedAt'], 'backup.exportedAt', 0, MAX_TIME);
    checkSettings(o['settings'], 'settings');
    unique(arr(o['menu'], 'menu', 100_000).map((d, i) => checkDish(d, `menu[${i}]`)), 'menu', 'dish id');
    unique(arr(o['bills'], 'bills', 5_000_000).map((b, i) => checkBill(b, `bills[${i}]`)), 'bills', 'bill number');
    unique(arr(o['cheesyLines'], 'cheesyLines', 10_000).map((l, i) => checkLine(l, `cheesyLines[${i}]`)), 'cheesyLines', 'line id');
    const meta = obj(o['meta'], 'meta', [], ['shuffleBag']);
    if ('shuffleBag' in meta) {
      const bag = obj(meta['shuffleBag'], 'meta.shuffleBag', ['order', 'pos'], ['last']);
      const order = arr(bag['order'], 'meta.shuffleBag.order', 10_000);
      order.forEach((x, i) => int(x, `meta.shuffleBag.order[${i}]`, 1, Number.MAX_SAFE_INTEGER));
      int(bag['pos'], 'meta.shuffleBag.pos', 0, order.length);
      if ('last' in bag) int(bag['last'], 'meta.shuffleBag.last', 1, Number.MAX_SAFE_INTEGER);
    }
    return { ok: true, backup: o as unknown as Backup };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}
