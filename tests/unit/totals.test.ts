import { describe, it, expect } from 'vitest';
import { computeTotals, discountAmount, NO_DISCOUNT } from '../../src/core/totals';

describe('discountAmount', () => {
  it('flat is capped at subtotal and never negative', () => {
    expect(discountAmount(10000, { kind: 'flat', paise: 2500 })).toBe(2500);
    expect(discountAmount(10000, { kind: 'flat', paise: 99999 })).toBe(10000);
    expect(discountAmount(10000, { kind: 'flat', paise: -5 })).toBe(0);
  });
  it('percent rounds half up and caps at 100%', () => {
    expect(discountAmount(9999, { kind: 'pct', bp: 1000 })).toBe(1000); // 999.9 → 1000
    expect(discountAmount(10000, { kind: 'pct', bp: 20000 })).toBe(10000);
  });
});

describe('computeTotals', () => {
  const lines = [
    { unitPaise: 24900, qty: 2 }, // 498.00
    { unitPaise: 6050, qty: 3 }, // 181.50
  ];

  it('subtotal and item count, no rounding', () => {
    const t = computeTotals(lines, NO_DISCOUNT, false);
    expect(t).toEqual({ subtotalPaise: 67950, discountPaise: 0, roundOffPaise: 0, totalPaise: 67950, itemCount: 5 });
  });

  it('applies a percent discount', () => {
    const t = computeTotals(lines, { kind: 'pct', bp: 1000 }, false);
    expect(t.discountPaise).toBe(6795);
    expect(t.totalPaise).toBe(61155);
  });

  it('round off to nearest rupee is recorded as a signed adjustment', () => {
    const up = computeTotals(lines, { kind: 'pct', bp: 1000 }, true); // 611.55 → 612
    expect(up.totalPaise).toBe(61200);
    expect(up.roundOffPaise).toBe(45);
    const down = computeTotals([{ unitPaise: 10020, qty: 1 }], NO_DISCOUNT, true); // 100.20 → 100
    expect(down.totalPaise).toBe(10000);
    expect(down.roundOffPaise).toBe(-20);
  });

  it('full discount yields zero total', () => {
    expect(computeTotals(lines, { kind: 'flat', paise: 999999 }, true).totalPaise).toBe(0);
  });

  it('empty cart is all zeros', () => {
    expect(computeTotals([], NO_DISCOUNT, true)).toMatchObject({ subtotalPaise: 0, totalPaise: 0, itemCount: 0 });
  });

  it('stays exact over many random bills (sum invariants)', () => {
    let seed = 42;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let i = 0; i < 2000; i++) {
      const ls = Array.from({ length: 1 + rnd(8) }, () => ({ unitPaise: 1 + rnd(100000), qty: 1 + rnd(20) }));
      const t = computeTotals(ls, { kind: 'pct', bp: rnd(5001) }, i % 2 === 0);
      expect(Number.isInteger(t.totalPaise)).toBe(true);
      expect(t.subtotalPaise - t.discountPaise + t.roundOffPaise).toBe(t.totalPaise);
      expect(Math.abs(t.roundOffPaise)).toBeLessThanOrEqual(50);
    }
  });
});
