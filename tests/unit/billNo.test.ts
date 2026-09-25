import { describe, it, expect } from 'vitest';
import { formatBillNo, parseBillNo, nextBillNo, monthKeyOf } from '../../src/core/billNo';

describe('bill numbers', () => {
  it('formats INV-YYYYMM-0001', () => {
    expect(formatBillNo('202609', 1)).toBe('INV-202609-0001');
    expect(formatBillNo('202609', 42)).toBe('INV-202609-0042');
    expect(formatBillNo('202609', 12345)).toBe('INV-202609-12345'); // widens, never wraps
  });
  it('rejects bad parts', () => {
    expect(() => formatBillNo('2026-9', 1)).toThrow();
    expect(() => formatBillNo('202609', 0)).toThrow();
    expect(() => formatBillNo('202609', 1.5)).toThrow();
  });
  it('parses and round-trips', () => {
    expect(parseBillNo('INV-202612-0007')).toEqual({ monthKey: '202612', seq: 7 });
    expect(parseBillNo('INV-202613-0001')).toBeNull();
    expect(parseBillNo('INV-202609-01')).toBeNull();
    expect(parseBillNo('<script>')).toBeNull();
  });
  it('increments and starts at 1 for a new month (monthly reset)', () => {
    expect(nextBillNo('202609', undefined)).toEqual({ billNo: 'INV-202609-0001', seq: 1 });
    expect(nextBillNo('202609', 9)).toEqual({ billNo: 'INV-202609-0010', seq: 10 });
    expect(nextBillNo('202610', undefined).billNo).toBe('INV-202610-0001');
  });
  it('month key uses local time', () => {
    expect(monthKeyOf(new Date(2026, 0, 31, 23, 59))).toBe('202601');
    expect(monthKeyOf(new Date(2026, 11, 1))).toBe('202612');
  });
});
