// map-util.ts — small Map / name helpers shared by the checkers: the "get, or insert a fresh value and get it" idiom,
// typed, so callers never need `m.get(k)!`, and the loose name key.

/** A name folded for near-miss comparison: lower-cased, every run of non-alphanumerics dropped ("Primary / Fill" and
 *  "primary-fill" share a key). Only ASCII letters and digits survive. */
export const alnumKey = (s: unknown): string => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

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
