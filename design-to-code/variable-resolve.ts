// variable-resolve.ts — the ONE answer to "what value does this variable have in mode M".
//
// Every reader of a token catalog asks it: the emitters (which variable an alias names, whether an opacity alias
// holds a percentage), tokens-native (each mode's literal), the plan skeleton (the value a frame renders),
// cross-check (the colours a contrast pair resolves to) and tokens --lookup. Each used to follow aliases its own
// way, and they disagreed on which of two same-named variables an alias meant, how deep a chain could go, and
// which mode an alias lands in — so one alias could resolve to different variables in --native output and in
// tokens.css. This module owns the three rules; the callers only format what it answers.
//
// The duplicate-name rule (target). An alias carries its target's NAME only (all the export writes), and names
// are not unique. Candidates are every variable with that name in every source, never the referrer itself (a
// variable cannot alias itself — a screen-local `Space/4` aliasing the library's `Space/4` means the library's).
// The first of them by:
//   1. the referrer's own collection (by collectionKey when both carry one, else by collection name);
//   2. the source's precedence (the order the sources are given: a screen's own slice before the library);
//   3. the lowest key (deterministic: re-ordering the input cannot change the answer; a keyless one first);
//   4. the order they are listed in.
//
// The mode rule (modeOf). A variable is read in, in order:
//   1. the mode the request names for it — the frame's mode for its collection (`byCollection`), else the one
//      mode name asked for every collection (`mode`) — exactly, else differing only in case ("dark" = "Dark");
//   2. its only mode, when it has one (a one-mode variable reads the same in any mode);
//   3. its collection's default (Figma's defaultModeId; the collection found by collectionKey when the variable
//      carries one — collection names repeat — else by name);
//   4. its first mode.
// Each alias hop applies the rule afresh to the target, so an alias into another collection lands in THAT
// collection's mode. `fallback` lets a caller stop early: "default" never takes step 4, "none" stops after 2
// (cross-check's contrast says nothing rather than judge a mode the variable does not have).
//
// The cycle rule. A chain that comes back to a variable it already passed through is a cycle and resolves to
// nothing; there is no depth cap (a finite catalog with a seen set always ends).
//
// A composed colour (doc-types ComposedColor: a colour plus a separate 0–100 opacity, either half an alias) folds
// into ONE colour: each half resolved by the same rules, the opacity applied by color.ts composeAlpha.
import type { Variable, VariableCollection, VariableValue } from "./types.ts";
import { isAlias, isComposed, NUMERIC_TEXT } from "./doc-guards.ts";
import { parseHex, formatHex, composeAlpha, type Rgba } from "./color.ts";

/** What a resolver reads: a token catalog (tokens.json, variables.json, a .vars.json slice) or any list of variables. */
export interface VariableSource { variables?: readonly Variable[] | undefined; collections?: readonly VariableCollection[] | undefined }
/** Which mode to read each variable in (see the mode rule above). */
export interface ModeRequest {
  /** the mode per collection name — a frame's resolvedModes */
  byCollection?: Readonly<Record<string, string>>;
  /** one mode name for every collection (one with no entry in byCollection) */
  mode?: string | undefined;
  /** how far the mode rule may go for a variable that lacks the requested mode: "first" (all of it, the default),
   *  "default" (never an arbitrary first mode) or "none" (the requested or only mode; else unresolved) */
  fallback?: "first" | "default" | "none";
}
/** A resolved value is never an alias or a composed colour (that is folded into "#rrggbb[aa]"). */
export type ConcreteValue = Exclude<VariableValue, { aliasOf: string } | { composed: unknown }>;
export interface Resolved {
  /** the end of the alias chain's value; undefined = unresolved (a dangling alias, a cycle, no mode to read,
   *  a composed half that did not resolve) */
  value: ConcreteValue | undefined;
  /** the variable that holds it (null when unresolved) */
  variable: Variable | null;
  /** the mode the asked variable itself was read in (undefined: it has no mode the request allows) */
  mode: string | undefined;
  /** the alias names followed from the asked variable, in order */
  via: string[];
}
/** Every variable a variable reaches through aliases in ANY mode (itself first); complete = no dangling alias, no cycle. */
export interface AliasClosure { vars: Variable[]; complete: boolean }

export interface VariableResolver {
  /** every variable an alias to `name` from `referrer` could mean: those called `name`, never the referrer itself; in source order */
  candidates(name: string, referrer?: Variable | null): readonly Variable[];
  /** the variable an alias to `name` means, seen from `referrer` (the duplicate-name rule); null = none */
  target(name: string, referrer?: Variable | null): Variable | null;
  /** the mode `v` is read in for `req` (the mode rule); undefined = none it allows */
  modeOf(v: Variable, req?: ModeRequest): string | undefined;
  /** `v`'s value in `req`, aliases followed and a composed colour folded */
  resolve(v: Variable | null | undefined, req?: ModeRequest): Resolved;
  /** `v`'s colour in `req` (a hex value, a composed colour's fold); null when it is not one */
  colour(v: Variable | null | undefined, req?: ModeRequest): Rgba | null;
  /** `v`'s number in `req` (a number, or a string-number FLOAT); null when it is not one */
  number(v: Variable | null | undefined, req?: ModeRequest): number | null;
  /** what `v` reaches through aliases across all its modes (CSS custom properties chain in every mode at once) */
  closure(v: Variable): AliasClosure;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const definedModes = (v: Variable): string[] => { const vals = v.values || {}; return Object.keys(vals).filter((m) => vals[m] !== undefined); };
const sameVariable = (a: Variable, b: Variable): boolean => a === b || (!!a.key && a.key === b.key);
const sameCollection = (a: Variable, b: Variable): boolean =>
  a.collectionKey && b.collectionKey ? a.collectionKey === b.collectionKey : a.collection !== undefined && a.collection === b.collection;

// The collection default among `modes`: the collections carrying v's collectionKey first, then those of its name —
// the first whose default is one of v's modes.
function defaultAmong(v: Variable, modes: readonly string[], collections: readonly VariableCollection[]): string | undefined {
  const hasDefault = (c: VariableCollection): boolean => c.default !== undefined && modes.includes(c.default);
  const byKey = v.collectionKey ? collections.find((c) => c.key === v.collectionKey && hasDefault(c)) : undefined;
  return (byKey ?? (v.collection === undefined ? undefined : collections.find((c) => c.name === v.collection && hasDefault(c))))?.default;
}

/** The mode `:root` / `$value` takes: the collection default, else the first mode (steps 3–4 of the mode rule). */
function defaultModeName(v: Variable, collections: readonly VariableCollection[] | undefined): string | undefined {
  const modes = definedModes(v);
  return defaultAmong(v, modes, collections || []) ?? modes[0];
}
/** The value that populates `$value` / `:root`: the default mode's (undefined only for a variable with no values). */
function baseValue(v: Variable, collections: readonly VariableCollection[] | undefined, def?: string): VariableValue | undefined {
  const m = def !== undefined && (v.values || {})[def] !== undefined ? def : defaultModeName(v, collections);
  return m === undefined ? undefined : (v.values || {})[m];
}

// A producer-mismatch read kept as-is: a COLOR value spelled {r,g,b,a} (0–1 channels) instead of a hex string.
const isLegacyRgba = (x: unknown): x is { r: number; g: number; b: number; a?: number } =>
  !!x && typeof x === "object" && "r" in x && "g" in x && "b" in x && typeof x.r === "number" && typeof x.g === "number" && typeof x.b === "number";
/** A COLOR value's colour: a hex string, or the legacy {r,g,b,a} object; null otherwise. */
function readColour(raw: unknown): Rgba | null {
  if (typeof raw === "string") return parseHex(raw);
  if (!isLegacyRgba(raw)) return null;
  const a = raw.a === undefined ? 1 : Number(raw.a);
  return { r: raw.r * 255, g: raw.g * 255, b: raw.b * 255, a: Number.isNaN(a) ? 1 : a };
}
const readNumber = (raw: unknown): number | null => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && NUMERIC_TEXT.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};

const isSourceList = (x: VariableSource | null | undefined | ReadonlyArray<VariableSource | null | undefined>): x is ReadonlyArray<VariableSource | null | undefined> => Array.isArray(x);
// walk's answer: a composed colour's fold rides beside its hex so colour() reads it unrounded.
type Walked = Resolved & { fold?: Rgba };
const colourOf = (r: Walked): Rgba | null => r.fold ?? readColour(r.value);

function variableResolver(input: VariableSource | null | undefined | ReadonlyArray<VariableSource | null | undefined>): VariableResolver {
  const sources = isSourceList(input) ? input : [input];
  const byName = new Map<string, Array<{ v: Variable; source: number; order: number }>>();
  const collections: VariableCollection[] = [];
  let order = 0;
  for (const [source, src] of sources.entries()) {
    for (const v of (src && src.variables) || []) {
      if (!v || typeof v.name !== "string") continue;
      const list = byName.get(v.name);
      const entry = { v, source, order: order++ };
      if (list) list.push(entry); else byName.set(v.name, [entry]);
    }
    for (const c of (src && src.collections) || []) if (c) collections.push(c);
  }

  const entries = (name: string, referrer?: Variable | null) => (byName.get(name) || []).filter((e) => !referrer || !sameVariable(e.v, referrer));
  function target(name: string, referrer?: Variable | null): Variable | null {
    const cands = entries(name, referrer);
    if (cands.length <= 1) return cands[0]?.v ?? null;
    const own = (e: { v: Variable }): number => (referrer && sameCollection(e.v, referrer) ? 0 : 1);
    return cands.slice().sort((a, b) => own(a) - own(b) || a.source - b.source || cmpStr(a.v.key || "", b.v.key || "") || a.order - b.order)[0]?.v ?? null;
  }

  function modeOf(v: Variable, req: ModeRequest = {}): string | undefined {
    const modes = definedModes(v);
    const fromFrame = v.collection === undefined ? undefined : req.byCollection?.[v.collection];
    for (const want of [fromFrame, req.mode]) {
      if (want === undefined) continue;
      if (modes.includes(want)) return want;
      const lower = want.toLowerCase();
      const ci = modes.find((m) => m.toLowerCase() === lower);
      if (ci !== undefined) return ci;
    }
    if (modes.length === 1) return modes[0];
    const fallback = req.fallback ?? "first";
    if (fallback === "none") return undefined;
    const def = defaultAmong(v, modes, collections);
    if (def !== undefined || fallback === "default") return def;
    return modes[0];
  }

  // `seen`: the variables this chain has passed through (the cycle rule).
  function walk(v: Variable | null | undefined, req: ModeRequest, seen: ReadonlySet<Variable>): Walked {
    const none = (mode?: string): Walked => ({ value: undefined, variable: null, mode, via: [] });
    if (!v || seen.has(v)) return none();
    const mode = modeOf(v, req);
    if (mode === undefined) return none();
    const raw = (v.values || {})[mode];
    const next = new Set(seen).add(v);
    if (isAlias(raw)) {
      const r = walk(target(raw.aliasOf, v), req, next);
      return { ...r, mode, via: [raw.aliasOf, ...r.via] };
    }
    if (isComposed(raw)) {
      const c = composed(v, raw.composed, req, next);
      return c ? { value: formatHex(c), variable: v, mode, via: [], fold: c } : none(mode);
    }
    // A malformed composed value (doc-guards isComposed refused it: two literals, a missing half) is no colour.
    if (raw === undefined || (!!raw && typeof raw === "object" && "composed" in raw)) return none(mode);
    return { value: raw, variable: v, mode, via: [] };
  }
  // The two halves of a composed colour, each a literal or an alias resolved like any other, folded into one.
  function composed(owner: Variable, half: { color: unknown; opacity: unknown }, req: ModeRequest, seen: ReadonlySet<Variable>): Rgba | null {
    const c = isAlias(half.color) ? colourOf(walk(target(half.color.aliasOf, owner), req, seen)) : readColour(half.color);
    const o = isAlias(half.opacity) ? readNumber(walk(target(half.opacity.aliasOf, owner), req, seen).value) : readNumber(half.opacity);
    return c && o !== null ? { ...c, a: composeAlpha(c.a, o) } : null;
  }

  function closure(v: Variable): AliasClosure {
    const vars: Variable[] = [];
    let complete = true;
    // `path`: the variables on the chain being walked (back on it = a cycle); `done`: walked to the end already, so
    // another mode reaching it adds nothing — without it a chain whose modes all alias the next link is walked
    // once per path, exponentially in its length.
    const done = new Set<Variable>();
    const path = new Set<Variable>();
    const visit = (x: Variable): void => {
      if (path.has(x)) { complete = false; return; }
      if (done.has(x)) return;
      vars.push(x);
      path.add(x);
      for (const val of Object.values(x.values || {})) {
        const names = isAlias(val) ? [val.aliasOf] : isComposed(val) ? [val.composed.color, val.composed.opacity].filter(isAlias).map((a) => a.aliasOf) : [];
        for (const n of names) {
          const t = target(n, x);
          if (t) visit(t); else complete = false;
        }
      }
      path.delete(x);
      done.add(x);
    };
    visit(v);
    return { vars, complete };
  }

  return {
    candidates: (name, referrer) => entries(name, referrer).map((e) => e.v),
    target,
    modeOf,
    resolve: (v, req = {}) => { const { value, variable, mode, via } = walk(v, req, new Set()); return { value, variable, mode, via }; },
    colour: (v, req = {}) => colourOf(walk(v, req, new Set())),
    number: (v, req = {}) => readNumber(walk(v, req, new Set()).value),
    closure,
  };
}

export { variableResolver, defaultModeName, baseValue, readColour };
