import { describe, it, expect } from 'vitest';
import { topK, bottomK } from '../../src/core/topK';

type D = { name: string; qty: number };
const byQty = (d: D) => d.qty;
const byName = (a: D, b: D) => a.name.localeCompare(b.name);

describe('topK', () => {
  it('matches a full sort on random data', () => {
    for (let t = 0; t < 50; t++) {
      const data = Array.from({ length: 500 }, (_, i) => ({ name: `d${i}`, qty: Math.floor(Math.random() * 100) }));
      const expected = [...data].sort((a, b) => b.qty - a.qty || byName(a, b)).slice(0, 10);
      expect(topK(data, 10, byQty, byName)).toEqual(expected);
    }
  });
  it('handles k larger than input, k = 0 and empty input', () => {
    const data = [
      { name: 'a', qty: 1 },
      { name: 'b', qty: 3 },
    ];
    expect(topK(data, 10, byQty).map((d) => d.name)).toEqual(['b', 'a']);
    expect(topK(data, 0, byQty)).toEqual([]);
    expect(topK([], 5, byQty)).toEqual([]);
  });
  it('breaks ties deterministically', () => {
    const data = [
      { name: 'c', qty: 5 },
      { name: 'a', qty: 5 },
      { name: 'b', qty: 5 },
    ];
    expect(topK(data, 2, byQty, byName).map((d) => d.name)).toEqual(['a', 'b']);
  });
  it('works on any iterable (Map values)', () => {
    const m = new Map([
      ['x', { name: 'x', qty: 2 }],
      ['y', { name: 'y', qty: 9 }],
    ]);
    expect(topK(m.values(), 1, byQty)[0]!.name).toBe('y');
  });
});

describe('bottomK', () => {
  it('returns the least-sold, lowest first (including zeros)', () => {
    const data = [
      { name: 'a', qty: 10 },
      { name: 'b', qty: 0 },
      { name: 'c', qty: 3 },
      { name: 'd', qty: 7 },
    ];
    expect(bottomK(data, 2, byQty).map((d) => d.name)).toEqual(['b', 'c']);
  });
});
