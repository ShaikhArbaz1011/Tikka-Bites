/** Run `fn` only after `ms` of quiet since the last call. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...args: A) => {
    if (t !== undefined) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...args);
    }, ms);
  };
  d.cancel = () => {
    if (t !== undefined) clearTimeout(t);
    t = undefined;
  };
  return d;
}
