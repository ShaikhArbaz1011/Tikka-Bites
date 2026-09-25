/**
 * Top-K selection with a bounded min-heap: O(n log k) time, O(k) memory.
 * Only the best k items are ever kept; the rest are never sorted.
 */

export function topK<T>(items: Iterable<T>, k: number, score: (t: T) => number, tieBreak?: (a: T, b: T) => number): T[] {
  if (k <= 0) return [];
  // "less" = worse rank. With tieBreak(a,b) < 0 meaning a ranks before b.
  const worse = (a: T, b: T): boolean => {
    const d = score(a) - score(b);
    if (d !== 0) return d < 0;
    return tieBreak ? tieBreak(a, b) > 0 : false;
  };
  const heap: T[] = []; // heap[0] is the worst of the kept items

  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!worse(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const down = (i: number) => {
    const n = heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && worse(heap[l]!, heap[m]!)) m = l;
      if (r < n && worse(heap[r]!, heap[m]!)) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  };

  for (const item of items) {
    if (heap.length < k) {
      heap.push(item);
      up(heap.length - 1);
    } else if (worse(heap[0]!, item)) {
      heap[0] = item;
      down(0);
    }
  }
  // Final sort of just k items, best first.
  return heap.sort((a, b) => (worse(a, b) ? 1 : worse(b, a) ? -1 : 0));
}

/** Bottom-K: the k lowest-scoring items, lowest first. */
export function bottomK<T>(items: Iterable<T>, k: number, score: (t: T) => number, tieBreak?: (a: T, b: T) => number): T[] {
  return topK(items, k, (t) => -score(t), tieBreak);
}
