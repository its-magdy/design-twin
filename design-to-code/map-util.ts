// map-util.ts — the "get, or insert a fresh value and get it" idiom, typed, so callers never need `m.get(k)!`.

/**
 * `m.get(k)`, after first doing `m.set(k, init())` when `k` has no value yet. Returns the existing or the
 * newly-set value (the same object the map holds). It only calls `set` when the key is absent, so a present
 * key keeps its Map position and a new key is appended — iteration order is exactly that of the
 * `if (!m.has(k)) m.set(k, init()); m.get(k)!` it replaces. `V` excludes `undefined` (a stored `undefined`
 * would read as absent); every caller stores arrays, Sets or record objects.
 */
export function getOrInit<K, V extends NonNullable<unknown> | null>(m: Map<K, V>, k: K, init: () => V): V {
  const have = m.get(k);
  if (have !== undefined) return have;
  const made = init();
  m.set(k, made);
  return made;
}
