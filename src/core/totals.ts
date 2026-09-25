import { applyBp, roundToRupee, MAX_BP, type Bp, type Paise } from './money';

export type Discount = { kind: 'flat'; paise: Paise } | { kind: 'pct'; bp: Bp };

export interface LineInput {
  unitPaise: Paise;
  qty: number;
}

export interface Totals {
  subtotalPaise: Paise;
  discountPaise: Paise;
  roundOffPaise: Paise; // may be negative
  totalPaise: Paise;
  itemCount: number;
}

export const NO_DISCOUNT: Discount = { kind: 'flat', paise: 0 };

export function discountAmount(subtotal: Paise, d: Discount): Paise {
  if (d.kind === 'flat') return Math.min(Math.max(0, d.paise), subtotal);
  return applyBp(subtotal, Math.min(Math.max(0, d.bp), MAX_BP));
}

/** Bill totals: subtotal − discount, optionally rounded to the nearest rupee. No tax. */
export function computeTotals(lines: readonly LineInput[], discount: Discount, roundOff: boolean): Totals {
  let subtotal = 0;
  let itemCount = 0;
  for (const l of lines) {
    subtotal += l.unitPaise * l.qty;
    itemCount += l.qty;
  }
  const discountPaise = discountAmount(subtotal, discount);
  const raw = subtotal - discountPaise;
  const total = roundOff ? roundToRupee(raw) : raw;
  return { subtotalPaise: subtotal, discountPaise, roundOffPaise: total - raw, totalPaise: total, itemCount };
}
