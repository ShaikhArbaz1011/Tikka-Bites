import { describe, it, expect } from 'vitest';
import { Cart, parseDraft } from '../../src/ui/billing/cartState';

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
