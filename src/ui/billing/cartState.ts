/** In-progress order. Plain data so it can be autosaved as a draft. */
import type { OrderType, PaymentMode } from '../../db/types';
import { LIMITS } from '../../core/validate';

export interface CartLine {
  menuId: number;
  qty: number;
}

export interface CartData {
  lines: CartLine[];
  orderType: OrderType;
  tableNo: string;
  customerName: string;
  paymentMode: PaymentMode;
  discountKind: 'flat' | 'pct';
  discountInput: string;
}

export const emptyCart = (): CartData => ({
  lines: [],
  orderType: 'dine-in',
  tableNo: '',
  customerName: '',
  paymentMode: 'cash',
  discountKind: 'flat',
  discountInput: '',
});

const clampQty = (n: number) => Math.min(LIMITS.qtyMax, Math.max(1, Math.trunc(n)));

export class Cart {
  data: CartData = emptyCart();
  private listeners = new Set<(changedId?: number) => void>();

  subscribe(fn: (changedId?: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(changedId?: number) {
    for (const fn of this.listeners) fn(changedId);
  }

  qtyOf(menuId: number): number {
    return this.data.lines.find((l) => l.menuId === menuId)?.qty ?? 0;
  }

  add(menuId: number, by = 1): void {
    const line = this.data.lines.find((l) => l.menuId === menuId);
    if (line) line.qty = clampQty(line.qty + by);
    else this.data.lines.push({ menuId, qty: clampQty(by) });
    this.emit(menuId);
  }

  /** Decrease by one; removes the line when it reaches zero. */
  decrement(menuId: number): void {
    const line = this.data.lines.find((l) => l.menuId === menuId);
    if (!line) return;
    if (line.qty <= 1) this.remove(menuId);
    else {
      line.qty -= 1;
      this.emit(menuId);
    }
  }

  setQty(menuId: number, qty: number): void {
    const line = this.data.lines.find((l) => l.menuId === menuId);
    if (!line) return;
    line.qty = clampQty(qty);
    this.emit(menuId);
  }

  remove(menuId: number): void {
    this.data.lines = this.data.lines.filter((l) => l.menuId !== menuId);
    this.emit(menuId);
  }

  set<K extends Exclude<keyof CartData, 'lines'>>(key: K, value: CartData[K]): void {
    this.data[key] = value;
    this.emit();
  }

  load(data: CartData): void {
    this.data = data;
    this.emit();
  }

  /** Clear items but keep the order type / payment mode habit. */
  reset(): void {
    const { orderType, paymentMode } = this.data;
    this.data = { ...emptyCart(), orderType, paymentMode };
    this.emit();
  }
}

/** Validate an untrusted saved draft (it came from IndexedDB, but be defensive). */
export function parseDraft(raw: unknown, validIds: Set<number>): CartData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const base = emptyCart();
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const lines = Array.isArray(r['lines'])
    ? (r['lines'] as unknown[]).flatMap((l) => {
        const x = l as Record<string, unknown>;
        const id = x?.['menuId'];
        const q = x?.['qty'];
        return typeof id === 'number' && validIds.has(id) && typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= LIMITS.qtyMax
          ? [{ menuId: id, qty: q }]
          : [];
      })
    : [];
  return {
    lines,
    orderType: (['dine-in', 'takeaway', 'delivery'] as const).find((t) => t === r['orderType']) ?? base.orderType,
    tableNo: str(r['tableNo'], LIMITS.tableNo),
    customerName: str(r['customerName'], LIMITS.customerName),
    paymentMode: (['cash', 'upi'] as const).find((t) => t === r['paymentMode']) ?? base.paymentMode,
    discountKind: r['discountKind'] === 'pct' ? 'pct' : 'flat',
    discountInput: str(r['discountInput'], 12),
  };
}
