import { expect } from '@playwright/test';

/** Google Sheets e2e helpers (scripts/fake-sheets.mjs runs the real google-sheets/Code.gs). */
export { appReady, declineFingerprint, signIn, signOut, watchErrors } from '../e2e-cloud/helpers';

export const SHEETS = 'http://localhost:54330';
export const EXEC = `${SHEETS}/macros/s/fake-e2e-deployment/exec`;

export interface SheetBill {
  billNo: string;
  monthKey: string;
  status: 'paid' | 'void';
  printedAs?: string;
  savedBy: string;
}

export interface SheetState {
  main: { bills: SheetBill[]; menu: { id: number; name: string }[]; users: { username: string; role: string; removed: boolean }[] };
  backup: { bills: SheetBill[]; menu: { id: number }[] };
  violations: string[];
  formulaWrites: number;
}

export async function resetSheets() {
  const r = await fetch(`${SHEETS}/__test/reset`, { method: 'POST' });
  expect(r.ok).toBe(true);
}

/** What Main and Backup hold right now. */
export async function sheets(): Promise<SheetState> {
  return (await fetch(`${SHEETS}/__test/state`)).json() as Promise<SheetState>;
}

/** Call the script directly, as the app would (to prove the server refuses something). */
export async function callScript(fn: string, args: Record<string, unknown>, token?: string) {
  const r = await fetch(EXEC, { method: 'POST', body: JSON.stringify({ fn, args, token }) });
  return (await r.json()) as { ok: boolean; data?: unknown; error?: { kind: string; message: string } };
}
