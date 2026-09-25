import { getDB } from './db';
import type { Dish } from './types';
import { cleanText, LIMITS } from '../core/validate';
import { MAX_PRICE_PAISE } from '../core/money';

export interface DishInput {
  name: string;
  category: string;
  pricePaise: number;
  isVeg: boolean;
  active: boolean;
}

export class MenuError extends Error {}

function checkInput(d: DishInput): DishInput {
  const name = cleanText(d.name);
  const category = cleanText(d.category);
  if (!name || name.length > LIMITS.dishName) throw new MenuError(`Name must be 1–${LIMITS.dishName} characters`);
  if (!category || category.length > LIMITS.category) throw new MenuError(`Category must be 1–${LIMITS.category} characters`);
  if (!Number.isSafeInteger(d.pricePaise) || d.pricePaise <= 0 || d.pricePaise > MAX_PRICE_PAISE) {
    throw new MenuError('Price must be more than 0 and at most ₹1,00,000');
  }
  return { name, category, pricePaise: d.pricePaise, isVeg: !!d.isVeg, active: !!d.active };
}

/** All non-deleted dishes, sorted by category then name. */
export async function listMenu(includeDeleted = false): Promise<Dish[]> {
  const all = await (await getDB()).getAll('menu');
  return all
    .filter((d) => includeDeleted || !d.deleted)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export async function getDish(id: number): Promise<Dish | undefined> {
  return (await getDB()).get('menu', id);
}

export async function addDish(input: DishInput, now = Date.now()): Promise<Dish> {
  const d = checkInput(input);
  const db = await getDB();
  const record = { ...d, nameLower: d.name.toLowerCase(), deleted: false, usedInBills: false, createdAt: now, updatedAt: now };
  const id = await db.add('menu', record as Dish);
  return { ...record, id };
}

export async function updateDish(id: number, input: DishInput, now = Date.now()): Promise<Dish> {
  const d = checkInput(input);
  const db = await getDB();
  const tx = db.transaction('menu', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing || existing.deleted) throw new MenuError('Dish not found');
  const updated: Dish = { ...existing, ...d, nameLower: d.name.toLowerCase(), updatedAt: now };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

export async function setDishActive(id: number, active: boolean): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('menu', 'readwrite');
  const d = await tx.store.get(id);
  if (d) await tx.store.put({ ...d, active, updatedAt: Date.now() });
  await tx.done;
}

/**
 * Delete a dish. Dishes that appear in any bill are only soft-deleted
 * (hidden, but kept for old bills and reports). Returns which one happened.
 */
export async function deleteDish(id: number): Promise<'hard' | 'soft'> {
  const db = await getDB();
  const tx = db.transaction('menu', 'readwrite');
  const d = await tx.store.get(id);
  if (!d) throw new MenuError('Dish not found');
  let kind: 'hard' | 'soft';
  if (d.usedInBills) {
    await tx.store.put({ ...d, deleted: true, active: false, updatedAt: Date.now() });
    kind = 'soft';
  } else {
    await tx.store.delete(id);
    kind = 'hard';
  }
  await tx.done;
  return kind;
}

export async function listCategories(): Promise<string[]> {
  const menu = await listMenu();
  return [...new Set(menu.map((d) => d.category))].sort((a, b) => a.localeCompare(b));
}

export async function addDishes(inputs: DishInput[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('menu', 'readwrite');
  const now = Date.now();
  for (const i of inputs) {
    const d = checkInput(i);
    void tx.store.add({ ...d, nameLower: d.name.toLowerCase(), deleted: false, usedInBills: false, createdAt: now, updatedAt: now } as Dish);
  }
  await tx.done;
}
