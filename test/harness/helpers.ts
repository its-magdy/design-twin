// What every harness area shares: the case shape, and reading the plugin's output without trusting its realm or
// narrowing a union first.
import type { Paint, Effect, VariableValue, ComposedColor } from "../../bridge/src/doc-types.ts";

/** One harness case: it builds its own world (scene.ts `world()`), so it runs the same in any order. */
export interface Case { name: string; run(): Promise<void> }

/** A caught error's message, without trusting its realm: code.js throws the VM context's Error, which
 *  is not `instanceof` this realm's. */
export interface Thrown { message: string }
export const thrown = (e: unknown): Thrown =>
  (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" ? { message: e.message } : { message: String(e) });

// ---- driving the run chain (state.ts serializeRun) from outside
/** The error a bridge run fails with once its caller abandoned it (state.ts abandonedError). */
export const ABANDONED = "export cancelled: the bridge request that asked for it was abandoned (its caller timed out, stalled out, or disconnected)";
/** A promise a fake's callback waits on until the case opens it: holds a run mid-walk while another arrives. */
export const gate = (): { p: Promise<void>; open: () => void } => {
  let open = (): void => {};
  const p = new Promise<void>((r) => { open = r; });
  return { p, open };
};
/** A run's outcome without a rejection escaping: its value, or what it threw. */
export const settle = <T>(p: Promise<T>): Promise<{ v: T | null; err: Thrown | null }> =>
  p.then((v) => ({ v, err: null }), (e: unknown) => ({ v: null, err: thrown(e) }));

// ---- reading union-typed output without narrowing first (the assertions check `type` themselves)
/** Every field any member of a discriminated union may carry, all optional. Each member is assignable
 *  to it, so `flat()` is a widening, not a cast: a field the actual member lacks reads `undefined`,
 *  exactly as it did untyped. */
export type AnyOf<U> = { [K in U extends unknown ? keyof U : never]?: U extends unknown ? (K extends keyof U ? U[K] : never) : never };
export const flatPaint = (p: Paint): AnyOf<Paint> => p;
export const flatEffect = (e: Effect): AnyOf<Effect> => e;
/** A variable's per-mode value's alias target — `undefined` for a raw value, like `.aliasOf` on it was. */
export const aliasOf = (v: VariableValue): string | undefined => (typeof v === "object" && "aliasOf" in v ? v.aliasOf : undefined);
/** A variable's per-mode value's composed-colour halves — `undefined` for anything else. */
export const composedOf = (v: VariableValue | undefined): ComposedColor | undefined => (typeof v === "object" && "composed" in v ? v.composed : undefined);
