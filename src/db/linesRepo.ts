import { getDB } from './db';
import type { CheesyLine } from './types';
import { cleanText, LIMITS } from '../core/validate';

export class LineError extends Error {}

function checkText(text: string): string {
  const t = cleanText(text);
  if (!t) throw new LineError('Line cannot be empty');
  if (t.length > LIMITS.cheesyLine) throw new LineError(`Line must be at most ${LIMITS.cheesyLine} characters`);
  return t;
}

export async function listLines(): Promise<CheesyLine[]> {
  return (await getDB()).getAll('cheesyLines');
}

export async function addLine(text: string): Promise<CheesyLine> {
  const t = checkText(text);
  const rec = { text: t, builtIn: false, active: true };
  const id = await (await getDB()).add('cheesyLines', rec as CheesyLine);
  return { ...rec, id };
}

export async function updateLine(id: number, patch: { text?: string; active?: boolean }): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('cheesyLines', 'readwrite');
  const line = await tx.store.get(id);
  if (!line) throw new LineError('Line not found');
  await tx.store.put({
    ...line,
    ...(patch.text !== undefined ? { text: checkText(patch.text) } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  });
  await tx.done;
}

/** Old bills keep their own copy of the line, so deleting is always safe. */
export async function deleteLine(id: number): Promise<void> {
  await (await getDB()).delete('cheesyLines', id);
}
