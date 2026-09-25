import { describe, it, expect } from 'vitest';
import { mulDivRound, applyBp, roundToRupee, parseRupees, parsePercent, formatINR, paiseToDecimal, formatBp } from '../../src/core/money';

describe('mulDivRound', () => {
  it('rounds halves up using integers only', () => {
    expect(mulDivRound(5, 1, 2)).toBe(3); // 2.5 → 3
    expect(mulDivRound(3, 1, 2)).toBe(2); // 1.5 → 2
    expect(mulDivRound(1, 1, 3)).toBe(0); // 0.33 → 0
    expect(mulDivRound(2, 1, 3)).toBe(1); // 0.67 → 1
  });
  it('rejects negatives and overflow', () => {
    expect(() => mulDivRound(-1, 1, 1)).toThrow();
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, 10, 1)).toThrow();
  });
});

describe('applyBp', () => {
  it('computes percentages in basis points', () => {
    expect(applyBp(10000, 500)).toBe(500); // 5% of ₹100
    expect(applyBp(33333, 1800)).toBe(6000); // 5999.94 → 6000
    expect(applyBp(1, 5000)).toBe(1); // 0.5 → 1
    expect(applyBp(12345, 0)).toBe(0);
  });
  it('never drifts like floats do', () => {
    expect(applyBp(10, 10000) + applyBp(20, 10000)).toBe(30);
  });
});

describe('roundToRupee', () => {
  it('rounds to nearest rupee, half up', () => {
    expect(roundToRupee(12349)).toBe(12300);
    expect(roundToRupee(12350)).toBe(12400);
    expect(roundToRupee(12300)).toBe(12300);
    expect(roundToRupee(49)).toBe(0);
  });
});

describe('parseRupees', () => {
  it.each([
    ['120', 12000],
    ['120.5', 12050],
    ['120.05', 12005],
    ['0.99', 99],
    ['1,20,000', 12000000],
    [' 7 ', 700],
  ])('%s → %i paise', (s, p) => expect(parseRupees(s)).toBe(p));
  it.each(['', 'abc', '1.234', '-5', '1e3', '12.', '.5', '1 2'])('rejects %j', (s) => expect(parseRupees(s)).toBeNull());
});

describe('parsePercent', () => {
  it('parses to basis points', () => {
    expect(parsePercent('18')).toBe(1800);
    expect(parsePercent('2.5')).toBe(250);
    expect(parsePercent('12.25')).toBe(1225);
    expect(parsePercent('100')).toBe(10000);
  });
  it('rejects out of range / bad input', () => {
    expect(parsePercent('100.01')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
    expect(parsePercent('-1')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats INR with Indian grouping', () => {
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(5)).toBe('₹0.05');
    expect(formatINR(12345678)).toBe('₹1,23,456.78');
    expect(formatINR(100000000)).toBe('₹10,00,000.00');
    expect(formatINR(-150)).toBe('−₹1.50');
    expect(formatINR(9900, 'Rs ')).toBe('Rs 99.00');
  });
  it('paiseToDecimal and formatBp', () => {
    expect(paiseToDecimal(12345)).toBe('123.45');
    expect(paiseToDecimal(-5)).toBe('-0.05');
    expect(formatBp(1800)).toBe('18');
    expect(formatBp(250)).toBe('2.5');
    expect(formatBp(1225)).toBe('12.25');
  });
});
