/**
 * Shuffle bag: Fisher-Yates shuffle the ids, then hand them out in order, so no
 * item repeats until every item has been used. State is plain data so it can be
 * stored in IndexedDB between sessions.
 */

export interface BagState {
  order: number[];
  pos: number;
  last?: number;
}

/** Returns a uniform random integer in [0, n). */
export type RandInt = (n: number) => number;

/** Crypto-backed uniform random integer (rejection sampling, no modulo bias). */
export const cryptoRandInt: RandInt = (n) => {
  if (n <= 0) throw new RangeError('n must be > 0');
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % n;
};

/** In-place Fisher-Yates shuffle. */
export function fisherYates<T>(arr: T[], rand: RandInt = cryptoRandInt): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

/** A fresh bag whose first item is never `avoidFirst` (when there's a choice). */
export function newBag(ids: readonly number[], avoidFirst: number | undefined, rand: RandInt = cryptoRandInt): BagState {
  const order = fisherYates([...ids], rand);
  if (order.length > 1 && order[0] === avoidFirst) {
    const j = 1 + rand(order.length - 1);
    [order[0], order[j]] = [order[j]!, order[0]!];
  }
  return { order, pos: 0, last: avoidFirst };
}

/**
 * Draw the next id from the bag. `activeIds` is the current set of usable ids;
 * ids removed since the bag was built are skipped, and new ids are merged in
 * with the not-yet-drawn remainder.
 */
export function draw(
  state: BagState | undefined,
  activeIds: readonly number[],
  rand: RandInt = cryptoRandInt,
): { id: number | undefined; state: BagState } {
  if (activeIds.length === 0) return { id: undefined, state: { order: [], pos: 0, last: state?.last } };
  const active = new Set(activeIds);
  let bag = state ? syncBag(state, active, rand) : newBag(activeIds, undefined, rand);
  if (bag.pos >= bag.order.length) bag = newBag(activeIds, bag.last, rand);
  const id = bag.order[bag.pos]!;
  return { id, state: { order: bag.order, pos: bag.pos + 1, last: id } };
}

/** Drop inactive ids from the undrawn part of the bag and mix in any new ids. */
function syncBag(state: BagState, active: Set<number>, rand: RandInt): BagState {
  const seen = new Set(state.order);
  const added = [...active].filter((id) => !seen.has(id));
  const remaining = state.order.slice(state.pos).filter((id) => active.has(id));
  if (added.length === 0 && remaining.length === state.order.length - state.pos) return state;
  const drawn = state.order.slice(0, state.pos);
  return { order: [...drawn, ...fisherYates([...remaining, ...added], rand)], pos: state.pos, last: state.last };
}
