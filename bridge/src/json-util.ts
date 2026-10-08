// Small helpers for the untyped-JSON boundary, shared by bridge/ and design-to-code/ (the layer may
// import bridge/src; bridge cannot import the layer, so both-sided helpers live here). Dependency-free.

/**
 * An empty null-prototype record. Use it wherever keys come from untrusted input (component keys, token
 * names, a map's `kind`): on a plain `{}` those names can resolve to — or write onto — Object.prototype
 * members ("constructor", "__proto__", "toString"). `Object.create(null)` itself is typed `any`; this is
 * the one place that asserts its shape.
 */
export function nullProto<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A plain JSON object: not null, not an array. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Array.isArray for an `unknown`, narrowing to `unknown[]` (the built-in narrows to an untyped array). */
export function isUnknownArray(x: unknown): x is unknown[] {
  return Array.isArray(x);
}

/** A string[] guard for untyped JSON. */
export function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

/**
 * `{ [key]: v }` when `v` is defined, `{}` when it is not — for spreading an optional key into an object
 * literal (`{ a, ...ifDefined("b", b), c }`) under exactOptionalPropertyTypes, where `b: undefined` no
 * longer type-checks against `b?: T`. Output is byte-identical to writing `b: b`: JSON.stringify already
 * drops an undefined-valued key, and the spread sits where the key was, so the key order is unchanged.
 * Only `undefined` is dropped — `null`, `""`, `0` and `false` are kept, exactly as JSON.stringify keeps them.
 */
export function ifDefined<K extends string, V>(key: K, v: V | undefined): Partial<Record<K, V>> {
  const o: Partial<Record<K, V>> = {};
  if (v !== undefined) o[key] = v;
  return o;
}
