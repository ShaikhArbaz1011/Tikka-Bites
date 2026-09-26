import { describe, it, expect } from 'vitest';
import { Cart, parseDraft } from '../../src/ui/billing/cartState';
import { computeTotals, NO_DISCOUNT } from '../../src/core/totals';

describe('Cart', () => {
  it('adds, steps and clamps quantities to 1–999', () => {
    const c = new Cart();
    c.add(1);
    c.add(1);
    c.add(2);
    expect(c.qtyOf(1)).toBe(2);
    c.setQty(1, 5000);
    expect(c.qtyOf(1)).toBe(999);
    c.setQty(1, 0);
    expect(c.qtyOf(1)).toBe(1);
    c.decrement(1);
    expect(c.qtyOf(1)).toBe(0);
    expect(c.data.lines).toEqual([{ menuId: 2, qty: 1 }]);
  });
  it('reset keeps order type and payment habit', () => {
    const c = new Cart();
    c.add(1);
    c.set('paymentMode', 'upi');
    c.set('orderType', 'takeaway');
    c.set('customerName', 'Asha');
    c.reset();
    expect(c.data).toMatchObject({ lines: [], paymentMode: 'upi', orderType: 'takeaway', customerName: '' });
  });
});

describe('parseDraft', () => {
  it('drops unknown dishes and bad values from a stored draft', () => {
    const d = parseDraft(
      {
        lines: [{ menuId: 1, qty: 2 }, { menuId: 99, qty: 1 }, { menuId: 2, qty: 1.5 }, 'junk'],
        orderType: 'spaceship',
        paymentMode: 'upi',
        tableNo: 'x'.repeat(50),
        discountKind: 'pct',
        discountInput: '10',
      },
      new Set([1, 2]),
    );
    expect(d).toMatchObject({ lines: [{ menuId: 1, qty: 2 }], orderType: 'dine-in', paymentMode: 'upi', discountKind: 'pct' });
    // A draft saved when Card existed falls back to Cash.
    expect(parseDraft({ paymentMode: 'card' }, new Set())!.paymentMode).toBe('cash');
    expect(d!.tableNo.length).toBe(10);
    expect(parseDraft(null, new Set())).toBeNull();
  });
});

describe('reducing a quantity (the − button)', () => {
  it('takes a dish from 3 to 2, and the bill total follows', () => {
    const c = new Cart();
    for (let i = 0; i < 3; i++) c.add(7);
    expect(c.qtyOf(7)).toBe(3);
    c.decrement(7);
    expect(c.qtyOf(7)).toBe(2);
    expect(c.data.lines).toEqual([{ menuId: 7, qty: 2 }]);
    const t = computeTotals(c.data.lines.map((l) => ({ unitPaise: 10_000, qty: l.qty })), NO_DISCOUNT, true);
    expect(t.totalPaise).toBe(20_000);
  });
});
