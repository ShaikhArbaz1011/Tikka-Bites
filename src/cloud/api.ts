/**
 * Every call the app makes to the shared database. Signed-in calls refresh the
 * token and retry once if it had just expired.
 */
import { request, rpc } from './http';
import { accessToken, refresh } from './auth';
import { CloudError } from './errors';
import type { Bill, CheesyLine, Counter, Dish, Settings } from '../db/types';
import type { DishInput } from '../db/menuRepo';

/** A dish as the database stores it (snake_case columns). */
export interface MenuRow {
  id: number;
  name: string;
  category: string;
  price_paise: number;
  is_veg: boolean;
  active: boolean;
  deleted: boolean;
  used_in_bills: boolean;
  created_at: number;
  updated_at: number;
  rev?: number;
}

export interface LineRow {
  id: number;
  text: string;
  built_in: boolean;
  active: boolean;
  removed: boolean;
  rev?: number;
}

export interface PullPage {
  menu: MenuRow[];
  lines: LineRow[];
  settings: Settings | null;
  bills: Bill[];
  dbId: string;
  ready: boolean;
  importOpen: boolean;
  keepFrom: string;
  more: boolean;
  rev: number;
}

export function dishFromRow(r: MenuRow): Dish {
  return {
    id: Number(r.id),
    name: r.name,
    nameLower: r.name.toLowerCase(),
    category: r.category,
    pricePaise: r.price_paise,
    isVeg: r.is_veg,
    active: r.active,
    deleted: r.deleted,
    usedInBills: r.used_in_bills,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function lineFromRow(r: LineRow): CheesyLine {
  return { id: Number(r.id), text: r.text, builtIn: r.built_in, active: r.active };
}

export function dishToRow(d: DishInput): Pick<MenuRow, 'name' | 'category' | 'price_paise' | 'is_veg' | 'active'> {
  return { name: d.name, category: d.category, price_paise: d.pricePaise, is_veg: d.isVeg, active: d.active };
}

async function authed<T>(call: (token: string) => Promise<T>): Promise<T> {
  const token = await accessToken();
  try {
    return await call(token);
  } catch (e) {
    if (e instanceof CloudError && e.kind === 'auth') return call((await refresh()).accessToken);
    throw e;
  }
}

function one<T>(rows: T[] | null, what: string): T {
  const row = rows?.[0];
  if (!row) throw new CloudError(`${what} not found in the shared database.`, 'rejected');
  return row;
}

export const api = {
  pullChanges: (since: number, limit = 500) => authed((t) => rpc<PullPage>('pull_changes', { p_since: since, p_limit: limit }, t)),
  /** Online bills are numbered by the server; `offline` bills keep their sale time and price. */
  saveBill: (bill: Record<string, unknown>, timeoutMs?: number) => authed((t) => rpc<Bill>('save_bill', { p_bill: bill }, t, timeoutMs)),
  voidBill: (billNo: string, reason: string) => authed((t) => rpc<Bill>('void_bill', { p_bill_no: billNo, p_reason: reason }, t)),
  patchSettings: (set: Partial<Settings>, unset: string[] = []) => authed((t) => rpc<Settings>('patch_settings', { p_set: set, p_unset: unset }, t)),
  purgeOldMonths: () => authed((t) => rpc<number>('purge_old_months', {}, t)),

  importDeviceData: (menu: Dish[], lines: CheesyLine[], settings: Settings, counters: Counter[]) =>
    authed((t) => rpc<null>('import_device_data', { p_menu: menu, p_lines: lines, p_settings: settings, p_counters: counters }, t, 60_000)),
  importBills: (bills: Bill[]) => authed((t) => rpc<number>('import_bills', { p_bills: bills }, t, 60_000)),
  finishImport: () => authed((t) => rpc<null>('finish_import', {}, t)),

  insertDishes: (rows: ReturnType<typeof dishToRow>[]) =>
    authed((t) => request<MenuRow[]>('/rest/v1/menu', { body: rows, token: t, prefer: 'return=representation' })),
  updateDish: async (id: number, patch: Partial<MenuRow>) =>
    one(await authed((t) => request<MenuRow[]>(`/rest/v1/menu?id=eq.${Math.trunc(id)}`, { method: 'PATCH', body: patch, token: t, prefer: 'return=representation' })), 'Dish'),
  insertLine: async (text: string) =>
    one(await authed((t) => request<LineRow[]>('/rest/v1/cheesy_lines', { body: { text, active: true }, token: t, prefer: 'return=representation' })), 'Line'),
  updateLine: async (id: number, patch: Partial<LineRow>) =>
    one(await authed((t) => request<LineRow[]>(`/rest/v1/cheesy_lines?id=eq.${Math.trunc(id)}`, { method: 'PATCH', body: patch, token: t, prefer: 'return=representation' })), 'Line'),
};
