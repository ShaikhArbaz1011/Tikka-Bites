import { describe, it, expect } from 'vitest';
import { fisherYates, newBag, draw, cryptoRandInt, type BagState } from '../../src/core/shuffleBag';

const ids = Array.from({ length: 40 }, (_, i) => i + 1);

describe('fisherYates', () => {
  it('is a permutation', () => {
    const out = fisherYates([...ids]);
    expect([...out].sort((a, b) => a - b)).toEqual(ids);
  });
  it('is roughly uniform (first position over many runs)', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 8000; i++) counts[fisherYates([0, 1, 2, 3])[0]!]!++;
    for (const c of counts) expect(c).toBeGreaterThan(1700); // expected 2000 each
  });
  it('cryptoRandInt stays in range', () => {
    for (let i = 0; i < 1000; i++) {
      const x = cryptoRandInt(7);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
    }
  });
});

describe('shuffle bag', () => {
  it('never repeats until all 40 lines are used (5 full rounds)', () => {
    let state: BagState | undefined;
    for (let round = 0; round < 5; round++) {
      const seen = new Set<number>();
      for (let i = 0; i < ids.length; i++) {
        const r = draw(state, ids);
        state = r.state;
        expect(seen.has(r.id!)).toBe(false);
        seen.add(r.id!);
      }
      expect(seen.size).toBe(ids.length);
    }
  });

  it('does not repeat the last line across a reshuffle boundary', () => {
    for (let t = 0; t < 200; t++) {
      let state: BagState | undefined;
      let last: number | undefined;
      for (let i = 0; i < 6; i++) {
        const r = draw(state, [1, 2, 3]);
        expect(r.id).not.toBe(last);
        last = r.id;
        state = r.state;
      }
    }
  });

  it('newBag avoids the given first item', () => {
    for (let t = 0; t < 200; t++) expect(newBag([1, 2], 1).order[0]).toBe(2);
  });

  it('skips removed ids and picks up newly added ids', () => {
    const state: BagState = { order: [1, 2, 3, 4], pos: 1, last: 1 }; // 1 already used
    const active = [1, 2, 3, 5]; // 4 removed, 5 added
    let s = state;
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = draw(s, active);
      s = r.state;
      seen.push(r.id!);
    }
    expect(seen.sort()).toEqual([2, 3, 5]);
  });

  it('returns undefined when there are no lines', () => {
    expect(draw(undefined, []).id).toBeUndefined();
  });

  it('a single line is returned every time', () => {
    let state: BagState | undefined;
    for (let i = 0; i < 3; i++) {
      const r = draw(state, [9]);
      expect(r.id).toBe(9);
      state = r.state;
    }
  });
});
