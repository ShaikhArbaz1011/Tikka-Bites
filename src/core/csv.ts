/** RFC 4180 CSV with spreadsheet-formula injection protection. */

export type Cell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // A text cell starting with = + - @ could be run as a formula by Excel: neutralise it.
  const s = FORMULA_START.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Iterable<readonly Cell[]>): string {
  const out: string[] = [];
  for (const r of rows) out.push(r.map(csvCell).join(','));
  return out.join('\r\n') + '\r\n';
}

/** BOM so Excel opens UTF-8 (₹, non-English names) correctly. */
export const CSV_BOM = '﻿';
