import { describe, it, expect } from 'vitest';
import { csvCell, toCsv } from '../../src/core/csv';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });
  it('neutralises formula injection in text cells only', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`'+1`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell(-12.5)).toBe('-12.5'); // real numbers untouched
  });
  it('builds rows with CRLF', () => {
    expect(toCsv([['a', 1], [null, true]])).toBe('a,1\r\n,true\r\n');
  });
});
