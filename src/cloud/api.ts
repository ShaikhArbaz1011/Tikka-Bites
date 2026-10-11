/**
 * Every call the app makes to the shared database: Supabase (SQL functions and tables)
 * or the owner's Google Sheets (the same-named functions in google-sheets/Code.gs).
 * Signed-in calls refresh the token and retry once if it had just expired.
 */
import { request, rpc } from './http';
import { call } from './sheetsHttp';
import { onSheets } from './config';
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

/** One person on the staff list, as the super admin sees it (Settings → Users). */
export interface StaffRow {
  username: string | null;
  role: 'super_admin' | 'staff';
  me: boolean;
  addedAt: number;
}

export type StaffAction = 'add' | 'reset' | 'remove';

/** Google Sheets only: is the Backup sheet up to date, and what did the last check find? (super admin) */
export interface SheetStatus {
  backupOk: boolean;
  /** Changes not yet copied to the Backup (it catches up on the next change or at night). */
  backupBehind: number;
  backupError: string | null;
  lastNightlyAt: number | null;
  lastCopyAt: number | null;
  health: { at: number; ok: boolean; problems: string[] } | null;
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

/** A server function: the SQL function on Supabase, or the function of the same name in the sheet's script. */
function fn<T>(name: string, args: Record<string, unknown>, token: string, timeoutMs?: number): Promise<T> {
  return onSheets() ? call<T>(name, args, token, timeoutMs) : rpc<T>(name, args, token, timeoutMs);
}

function one<T>(rows: T[] | null, what: string): T {
  const row = rows?.[0];
  if (!row) throw new CloudError(`${what} not found in the shared database.`, 'rejected');
  return row;
}

export const api = {
  /** Each request to the sheet has a fixed cost, so it sends bigger pages (and may take longer). */
  pullChanges: (since: number, limit = onSheets() ? 2000 : 500) =>
    authed((t) => fn<PullPage>('pull_changes', { p_since: since, p_limit: limit }, t, onSheets() ? 60_000 : undefined)),
  /** Online bills are numbered by the server; `offline` bills keep their sale time and price. */
  saveBill: (bill: Record<string, unknown>, timeoutMs?: number) => authed((t) => fn<Bill>('save_bill', { p_bill: bill }, t, timeoutMs)),
  voidBill: (billNo: string, reason: string) => authed((t) => fn<Bill>('void_bill', { p_bill_no: billNo, p_reason: reason }, t)),
  patchSettings: (set: Partial<Settings>, unset: string[] = []) => authed((t) => fn<Settings>('patch_settings', { p_set: set, p_unset: unset }, t)),
  purgeOldMonths: () => authed((t) => fn<number>('purge_old_months', {}, t)),

  importDeviceData: (menu: Dish[], lines: CheesyLine[], settings: Settings, counters: Counter[]) =>
    authed((t) => fn<null>('import_device_data', { p_menu: menu, p_lines: lines, p_settings: settings, p_counters: counters }, t, 60_000)),
  importBills: (bills: Bill[]) => authed((t) => fn<number>('import_bills', { p_bills: bills }, t, 60_000)),
  finishImport: () => authed((t) => fn<null>('finish_import', {}, t)),

  insertDishes: (rows: ReturnType<typeof dishToRow>[]) =>
    authed((t) => (onSheets() ? call<MenuRow[]>('insert_dishes', { p_rows: rows }, t) : request<MenuRow[]>('/rest/v1/menu', { body: rows, token: t, prefer: 'return=representation' }))),
  updateDish: async (id: number, patch: Partial<MenuRow>) =>
    onSheets()
      ? authed((t) => call<MenuRow>('update_dish', { p_id: Math.trunc(id), p_patch: patch }, t))
      : one(await authed((t) => request<MenuRow[]>(`/rest/v1/menu?id=eq.${Math.trunc(id)}`, { method: 'PATCH', body: patch, token: t, prefer: 'return=representation' })), 'Dish'),
  insertLine: async (text: string) =>
    onSheets()
      ? authed((t) => call<LineRow>('insert_line', { p_text: text }, t))
      : one(await authed((t) => request<LineRow[]>('/rest/v1/cheesy_lines', { body: { text, active: true }, token: t, prefer: 'return=representation' })), 'Line'),
  updateLine: async (id: number, patch: Partial<LineRow>) =>
    onSheets()
      ? authed((t) => call<LineRow>('update_line', { p_id: Math.trunc(id), p_patch: patch }, t))
      : one(await authed((t) => request<LineRow[]>(`/rest/v1/cheesy_lines?id=eq.${Math.trunc(id)}`, { method: 'PATCH', body: patch, token: t, prefer: 'return=representation' })), 'Line'),

  /** 'super_admin', 'staff', or null if not on the staff list. */
  myRole: () => authed((t) => fn<'super_admin' | 'staff' | null>('my_role', {}, t)),
  listStaff: () => authed((t) => fn<StaffRow[]>('list_staff', {}, t)),
  /** Google Sheets only (super admin). */
  sheetStatus: () => authed((t) => call<SheetStatus>('sheet_status', {}, t)),
  /** Add a user, change a password or remove a user (super admin; supabase/functions/staff-admin, or the sheet's script). */
  staffAdmin: async (action: StaffAction, username: string, password?: string): Promise<void> => {
    const body = { action, username, ...(password === undefined ? {} : { password }) };
    if (onSheets()) {
      await authed((t) => call('staff_admin', body, t));
      return;
    }
    try {
      await authed((t) => request('/functions/v1/staff-admin', { body, token: t, timeoutMs: 20_000 }));
    } catch (e) {
      // 404 from Supabase itself (not a missing SQL function, which is kind 'setup' already).
      if (e instanceof CloudError && e.status === 404 && e.kind !== 'setup') {
        throw new CloudError('The user manager is not installed on Supabase yet (supabase/README.md, "Add users from the app").', 'setup', 404);
      }
      throw e;
    }
  },
};
