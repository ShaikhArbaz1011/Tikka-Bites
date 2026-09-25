import { getDB, SETTINGS_KEY, DEFAULT_SETTINGS } from './db';
import type { MetaMap, Settings } from './types';

export async function getSettings(): Promise<Settings> {
  const s = await (await getDB()).get('settings', SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await getDB();
  const tx = db.transaction('settings', 'readwrite');
  const current = { ...DEFAULT_SETTINGS, ...(await tx.store.get(SETTINGS_KEY)) };
  const next: Settings = { ...current, ...patch };
  // Remove keys explicitly cleared (e.g. logo removed).
  for (const k of Object.keys(patch) as (keyof Settings)[]) {
    if (patch[k] === undefined) delete next[k];
  }
  await tx.store.put(next, SETTINGS_KEY);
  await tx.done;
  return next;
}

export async function getMeta<K extends keyof MetaMap>(key: K): Promise<MetaMap[K] | undefined> {
  return (await (await getDB()).get('meta', key)) as MetaMap[K] | undefined;
}

export async function setMeta<K extends keyof MetaMap>(key: K, value: MetaMap[K]): Promise<void> {
  await (await getDB()).put('meta', value, key);
}

export async function deleteMeta(key: keyof MetaMap): Promise<void> {
  await (await getDB()).delete('meta', key);
}
