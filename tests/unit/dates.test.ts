import { describe, it, expect } from 'vitest';
import { presetRange, customRange, rangeIsWholeMonth, prevMonthKey, monthKeyRange } from '../../src/core/dates';

const now = +new Date(2026, 8, 25, 15, 30); // Fri 25 Sep 2026

describe('date presets', () => {
  it('today / yesterday', () => {
    expect(presetRange('today', now)).toEqual({ start: +new Date(2026, 8, 25), end: +new Date(2026, 8, 26) });
    expect(presetRange('yesterday', now)).toEqual({ start: +new Date(2026, 8, 24), end: +new Date(2026, 8, 25) });
  });
  it('week starts Monday', () => {
    expect(presetRange('week', now)).toEqual({ start: +new Date(2026, 8, 21), end: +new Date(2026, 8, 28) });
  });
  it('this month / last month (incl. year wrap)', () => {
    expect(rangeIsWholeMonth(presetRange('month', now))).toBe('202609');
    expect(rangeIsWholeMonth(presetRange('lastMonth', +new Date(2026, 0, 5)))).toBe('202512');
  });
  it('custom range is inclusive of the end day', () => {
    expect(customRange('2026-09-01', '2026-09-30')).toEqual(monthKeyRange('202609'));
    expect(customRange('2026-09-10', '2026-09-01')).toBeNull();
    expect(customRange('bad', '2026-09-01')).toBeNull();
  });
  it('prevMonthKey wraps years', () => {
    expect(prevMonthKey('202601')).toBe('202512');
    expect(prevMonthKey('202610')).toBe('202609');
  });
});
