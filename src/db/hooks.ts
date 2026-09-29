/**
 * Switch for the shared database. In local-only mode no hooks are set and every
 * write goes to this phone's IndexedDB as before. When the shared database is on
 * (src/cloud/boot.ts), writes go to Supabase first and the result is stored in the
 * local copy, which billing and reports keep reading from.
 *
 * Kept tiny and import-free so the cloud code can stay in a lazy-loaded chunk.
 */
import type { Bill, CheesyLine, Dish, Settings } from './types';
import type { BillDraft } from './billRepo';
import type { DishInput } from './menuRepo';

export interface CloudHooks {
  saveBill(draft: BillDraft, now: number): Promise<Bill>;
  voidBill(billNo: string, reason: string): Promise<Bill>;
  addDish(input: DishInput): Promise<Dish>;
  addDishes(inputs: DishInput[]): Promise<void>;
  updateDish(id: number, input: DishInput): Promise<Dish>;
  setDishActive(id: number, active: boolean): Promise<void>;
  deleteDish(id: number): Promise<'hard' | 'soft'>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  addLine(text: string): Promise<CheesyLine>;
  updateLine(id: number, patch: { text?: string; active?: boolean }): Promise<void>;
  deleteLine(id: number): Promise<void>;
}

let hooks: CloudHooks | null = null;

export function setCloudHooks(h: CloudHooks | null): void {
  hooks = h;
}

export function cloudHooks(): CloudHooks | null {
  return hooks;
}
