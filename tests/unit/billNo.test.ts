import { describe, it, expect } from 'vitest';
import { formatBillNo, parseBillNo, nextBillNo, monthKeyOf, yearKeyOf, billNoMatchesMonth, BILL_NO_RE } from '../../src/core/billNo';

describe('receipt numbers', () => {
  it('formats RCPT-YYYY-0001: one count per year (owner request, 24 Oct 2026)', () => {
    expect(formatBillNo('2026', 1)).toBe('RCPT-2026-0001');
    expect(formatBillNo('2026', 42)).toBe('RCPT-2026-0042');
    expect(formatBillNo('2026', 12345)).toBe('RCPT-2026-12345'); // widens, never wraps
    expect(BILL_NO_RE.test(formatBillNo('2026', 1))).toBe(true);
  });
  it('rejects bad parts', () => {
    expect(() => formatBillNo('202609', 1)).toThrow(); // a month is no longer a counter for new bills
    expect(() => formatBillNo('26', 1)).toThrow();
    expect(() => formatBillNo('2026', 0)).toThrow();
    expect(() => formatBillNo('2026', 1.5)).toThrow();
  });
  it('parses yearly numbers and the old monthly ones', () => {
    expect(parseBillNo('RCPT-2026-0007')).toEqual({ counterKey: '2026', year: '2026', seq: 7 });
    expect(parseBillNo('RCPT-202612-0007')).toEqual({ counterKey: '202612', year: '2026', monthKey: '202612', seq: 7 });
    expect(parseBillNo('RCPT-202613-0001')).toBeNull();
    expect(parseBillNo('RCPT-202609-01')).toBeNull();
    expect(parseBillNo('RCPT-2026-01')).toBeNull();
    expect(parseBillNo('RCPT-20266-0001')).toBeNull();
    expect(parseBillNo('<script>')).toBeNull();
  });
  it('still reads bills numbered INV- before the switch to receipts (monthly only)', () => {
    expect(parseBillNo('INV-202609-0017')).toEqual({ counterKey: '202609', year: '2026', monthKey: '202609', seq: 17 });
    for (const bad of ['INV-2026-0001', 'RCP-202609-0001', 'INVOICE-202609-0001', 'rcpt-2026-0001', 'XRCPT-2026-0001']) {
      expect(parseBillNo(bad), bad).toBeNull();
      expect(BILL_NO_RE.test(bad), bad).toBe(false);
    }
  });
  it('increments within a year and starts at 0001 on 1 January', () => {
    expect(nextBillNo('2026', undefined)).toEqual({ billNo: 'RCPT-2026-0001', seq: 1 });
    expect(nextBillNo('2026', 9)).toEqual({ billNo: 'RCPT-2026-0010', seq: 10 });
    expect(nextBillNo('2027', undefined).billNo).toBe('RCPT-2027-0001');
  });
  it('a number fits its bill month: same year (yearly) or same month (old monthly)', () => {
    expect(billNoMatchesMonth('RCPT-2026-0001', '202610')).toBe(true);
    expect(billNoMatchesMonth('RCPT-2026-0001', '202701')).toBe(false);
    expect(billNoMatchesMonth('RCPT-202610-0001', '202610')).toBe(true);
    expect(billNoMatchesMonth('RCPT-202610-0001', '202611')).toBe(false);
    expect(billNoMatchesMonth('OFF-K7Q-0001', '202610')).toBe(false);
  });
  it('month and year keys use local time', () => {
    expect(monthKeyOf(new Date(2026, 0, 31, 23, 59))).toBe('202601');
    expect(monthKeyOf(new Date(2026, 11, 1))).toBe('202612');
    expect(yearKeyOf(new Date(2026, 11, 31, 23, 59))).toBe('2026');
    expect(yearKeyOf(new Date(2027, 0, 1, 0, 0))).toBe('2027');
  });
});
