import { describe, it, expect } from 'vitest';
import * as v from '../../src/core/validate';

describe('validate', () => {
  it('cleans text: trims, strips control chars, collapses spaces', () => {
    expect(v.cleanText('  Paneer\u0000  Tikka \n ')).toBe('Paneer Tikka');
  });
  it('enforces text length', () => {
    expect(v.text('Name', '  ', 1, 60).ok).toBe(false);
    expect(v.text('Name', 'x'.repeat(61), 1, 60).ok).toBe(false);
    expect(v.text('Name', 'Dal', 1, 60)).toEqual({ ok: true, value: 'Dal' });
  });
  it('price must be > 0 and ≤ ₹1,00,000', () => {
    expect(v.price('0').ok).toBe(false);
    expect(v.price('0.00').ok).toBe(false);
    expect(v.price('100000.01').ok).toBe(false);
    expect(v.price('abc').ok).toBe(false);
    expect(v.price('249')).toEqual({ ok: true, value: 24900 });
  });
  it('qty is an integer 1–999', () => {
    expect(v.qty('0').ok).toBe(false);
    expect(v.qty('1000').ok).toBe(false);
    expect(v.qty('2.5').ok).toBe(false);
    expect(v.qty('12')).toEqual({ ok: true, value: 12 });
    expect(v.isQty(999)).toBe(true);
    expect(v.isQty(1.5)).toBe(false);
  });
  it('discounts', () => {
    expect(v.discountPercent('10')).toEqual({ ok: true, value: 1000 });
    expect(v.discountPercent('101').ok).toBe(false);
    expect(v.discountFlat('')).toEqual({ ok: true, value: 0 });
    expect(v.discountFlat('50')).toEqual({ ok: true, value: 5000 });
    expect(v.discountFlat('x').ok).toBe(false);
  });
  it('phone', () => {
    expect(v.phone('+91 98765-43210').ok).toBe(true);
    expect(v.phone('').ok).toBe(true);
    expect(v.phone('call me').ok).toBe(false);
  });
});
