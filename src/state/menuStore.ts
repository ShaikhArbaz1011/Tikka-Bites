/**
 * In-memory menu cache shared by Billing and Menu screens. Loaded once from
 * IndexedDB, with a precomputed lowercase search key per dish, and refreshed
 * whenever the menu is edited.
 */
import { listMenu } from '../db/menuRepo';
import type { Dish } from '../db/types';

export interface IndexedDish extends Dish {
  key: string; // "paneer tikka starters"
}

let dishes: IndexedDish[] = [];
let loading: Promise<IndexedDish[]> | undefined;
const listeners = new Set<(d: IndexedDish[]) => void>();

export function getMenu(): Promise<IndexedDish[]> {
  loading ??= refreshMenu();
  return loading;
}

export async function refreshMenu(): Promise<IndexedDish[]> {
  const list = await listMenu();
  dishes = list.map((d) => ({ ...d, key: `${d.nameLower} ${d.category.toLowerCase()}` }));
  loading = Promise.resolve(dishes);
  for (const fn of listeners) fn(dishes);
  return dishes;
}

export function onMenuChange(fn: (d: IndexedDish[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every whitespace-separated term must appear in the dish's search key. */
export function searchDishes<T extends { key: string }>(list: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return list as T[];
  return list.filter((d) => terms.every((t) => d.key.includes(t)));
}
