// tokens-core.ts — the variable readers every token emitter shares: names, default modes, the
// fully-rounded sentinel and the FLOAT unit decision.
//
// tokens.ts (DTCG / CSS / Resolver / Tailwind) and tokens-native.ts (SwiftUI / Compose / Flutter /
// React Native) must agree on all of these — a token's segments, which mode is its default, whether a
// FLOAT is a length, a unitless number or a percentage — so both import them from here. They live in
// their own module because tokens.ts imports tokens-native.ts (for toNative): tokens-native.ts importing
// them back from tokens.ts would be a cycle, which makes the bundler wrap tokens.ts as an inner module
// whose `import.meta.main` CLI guard then never fires.
import type { Variable, VariableCollection, VariableValue } from "./types.ts";
import { isAlias } from "./doc-guards.ts";

/** The px-vs-unitless override every emitter honours (unitDecision): the names a caller declared unitless. */
export interface UnitOpts {
  unitless?: { has: (name: string) => boolean };
}
/** unitDecision(): WHO decided a FLOAT's unit. */
export type UnitDecision = "override" | "scopes" | "name" | "px";

// --- a Figma token name split into its `/` segments (trimmed, .{}$ stripped, whitespace folded to -).
// Memoized by name: emitTokens runs toDTCG, toCSS and lintNames over the SAME variable list, and each
// pass re-derives these from the name (a split plus a regex chain per segment, twice over for
// cssVarName). At 500-2000 variables that is ~6 recomputations per token for a value that is a pure
// function of the name. The returned array is shared, so callers must treat it as read-only — no
// current caller mutates it. Cache lifetime is one CLI process / one emitTokens call chain.
const segsCache = new Map<string, string[]>();
function segs(name: string | null | undefined): string[] {
  const key = String(name || "");
  let v = segsCache.get(key);
  if (v === undefined) {
    v = key.split("/").map((s) => s.trim().replace(/[.{}$]/g, "").replace(/\s+/g, "-")).filter(Boolean);
    segsCache.set(key, v);
  }
  return v;
}

// --- Figma's "fully rounded" sentinel ------------------------------------------------------------
// A pill corner exports as a literal 1e9 (cross-check.ts reports it as `sentinel-token-value`). It is
// an idiom, not a measurement, and `1000000000px` must never reach a stylesheet.
// Every emitter writes the platform's own idiom instead: 9999px on the web (and in DTCG, with the
// original kept under $extensions), `.infinity` in SwiftUI, `double.infinity` in Flutter, 9999 in
// React Native, and 9999.dp with a CircleShape note in Compose.
const SENTINEL_MIN = 10000; // the same threshold as cross-check.ts ABSURD_NUMBER
function isRadiusVar(v: Variable): boolean {
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (narrowed) return scopes.includes("CORNER_RADIUS");
  return /radius|corner|round/i.test(String(v.collection || "") + "/" + v.name);
}
function isSentinel(v: Variable | null | undefined, raw: unknown): boolean {
  if (!v || v.type !== "FLOAT" || isAlias(raw)) return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && Math.abs(n) >= SENTINEL_MIN && isRadiusVar(v);
}

// `modes[0]` — "any present mode"; a variable with no values at all has none, so undefined (as the JS
// always returned), and every caller tolerates that.
function defaultModeName(variable: Variable, collections: VariableCollection[] | undefined): string | undefined {
  const c = (collections || []).find((x) => x.name === variable.collection);
  const modes = variable.values ? Object.keys(variable.values) : [];
  if (c && c.default && modes.includes(c.default)) return c.default;
  return modes[0]; // fall back to any present mode rather than emit undefined
}
// The value that should populate $value / :root — never undefined (falls back to any present mode).
// `def` may be passed in when the caller already computed the default mode (avoids recomputing it).
function baseValue(variable: Variable, collections: VariableCollection[] | undefined, def?: string): VariableValue | undefined {
  const values = variable.values || {};
  if (def === undefined) def = defaultModeName(variable, collections);
  if (def !== undefined && values[def] !== undefined) return values[def];
  const firstDefined = Object.keys(values).find((m) => values[m] !== undefined);
  return firstDefined !== undefined ? values[firstDefined] : undefined;
}

// FLOAT unit: Figma FLOAT variables are overwhelmingly dimensions -> `px`; OPACITY/FONT_WEIGHT scopes
// (and any name in opts.unitless) are NOT lengths, so we never emit invalid CSS like `opacity: 0.5px`
// (FONT_WEIGHT is a bare number; OPACITY/COLOR_OPACITY a percentage — see percentOpacity).
// LINE_HEIGHT/LETTER_SPACING are DELIBERATELY not unitless: per the Figma API these are px|percent
// (LineHeight = {value, unit:"PIXELS"|"PERCENT"} | AUTO), never a CSS-style unitless multiplier — so
// `px` is the safe default. Emitting them unitless would be wrong (`line-height: 24` = 24x font size)
// and for letter-spacing outright invalid CSS (a bare number is not a valid <length>). Use opts.unitless
// to override per-token when a source genuinely encodes a multiplier.
// COLOR_OPACITY (typings 1.139): a FLOAT offered as the opacity half of a composed colour — an opacity too.
const UNITLESS_SCOPES = new Set(["OPACITY", "COLOR_OPACITY", "FONT_WEIGHT"]);
// Scopes are only a signal when the designer NARROWED them. Figma's default is ALL_SCOPES, and real
// files overwhelmingly leave it there (it's the very smell `hygiene[]` reports) — so a scopes-only
// rule emits `font-weight: 500px` / `opacity: 0.5px` on the common case. Both are invalid CSS the
// browser drops. When scopes carry no signal, fall back to the NAME. Narrow scopes still win, so an
// explicitly-scoped variable is never second-guessed by a name match.
// Matched per `/`-SEGMENT, not as a substring of the whole name. A substring rule (what this was)
// cannot tell "font-weight/bold" from "font-weight-scale/lg": both contain "font-weight" followed by a
// non-letter, but the second is a multiplier — the one FLOAT in the family where dropping the unit is
// the wrong call. Figma names are `/`-delimited groups, so the group IS the unit of meaning: a segment
// that is exactly the property (ignoring case and -/_/space) names it; one that merely starts with it
// names something else. "text/font-weight" and "Opacity/disabled" both still match.
const UNITLESS_NAME_SEGMENTS = new Set(["opacity", "fontweight"]);
function unitlessName(name: string): boolean {
  // segs() is this module's ONE definition of "a Figma token name split into meaningful segments"
  // (it trims, strips .{}$ and folds whitespace). Re-splitting on "/" here let the unit heuristic
  // segment a name differently from cssVarName/dtcgRef, so the linter could claim a heuristic hit on
  // a token whose emitted var name was built from other segments.
  return segs(name).some((seg) => UNITLESS_NAME_SEGMENTS.has(seg.replace(/[-_ ]/g, "").toLowerCase()));
}
// The SCOPE rule, in one place: a variable is unitless only when EVERY scope says so. Real files scope
// a single FLOAT to several text properties at once (e.g. FONT_WEIGHT + FONT_SIZE + LINE_HEIGHT on one
// "Body" size token) — `.some()` let one unitless scope override the length scopes sitting right next
// to it, emitting a bare number (`--Body-2: 18;`) on what is, in practice, a px value.
// Scopes are a STRONG SIGNAL, not ground truth: per the Plugin API docs on Variable.scopes, setting
// them "does not prevent that variable from being bound in other scopes (for example, via the Plugin
// API). This only limits the variables that are shown in pickers within the Figma UI." So an
// OPACITY-scoped FLOAT can still be bound to a width. It's the best evidence the file has and stays
// authoritative; opts.unitless is the escape hatch when it's wrong.
function scopesSayUnitless(scopes: readonly string[]): boolean {
  return !!scopes.length && scopes.every((s) => UNITLESS_SCOPES.has(s));
}
// WHO decided this token's unit, in one place: "override" (the caller named it), "scopes" (the
// designer narrowed them), "name" (no scope signal — the heuristic guessed), or "px" (the default).
// One function so the emitter and the linter cannot disagree about which tokens the heuristic touched:
// numberUnit maps the decision to a unit, and lintNames warns iff the decision was "name".
function unitDecision(variable: Variable, opts?: UnitOpts): UnitDecision {
  if (opts && opts.unitless && opts.unitless.has && opts.unitless.has(variable.name)) return "override";
  const scopes = variable.scopes || [];
  if (scopesSayUnitless(scopes)) return "scopes";
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (!narrowed && unitlessName(variable.name)) return "name";
  return "px";
}
// OPACITY / COLOR_OPACITY: Figma's opacity numbers are PERCENTAGES, 0–100. REST API variables types
// (https://developers.figma.com/docs/rest-api/variables-types/): VariableComposedColor.opacity is "An
// opacity percentage from 0 to 100, or an alias to a FLOAT variable", and VariableScope says "OPACITY
// corresponds to layer opacity, while COLOR_OPACITY corresponds to the opacity channel of a color".
// So a FLOAT whose SCOPES say "opacity" (and nothing else) is written to CSS as `N%` — valid for the
// `opacity` property and as an <alpha-value> — never a bare `N`, which `opacity` clamps to 1 (fully
// opaque). DTCG keeps the verbatim number, marked $extensions["figma.com"].unit: "percent".
// Scopes only: a name-heuristic or opts.unitless token carries no evidence of Figma's scale, so it
// stays a bare number; so does a mix with FONT_WEIGHT (which half of the mix is it?).
const PERCENT_SCOPES = new Set(["OPACITY", "COLOR_OPACITY"]);
function percentOpacity(variable: Variable, opts?: UnitOpts): boolean {
  return variable.type === "FLOAT" && unitDecision(variable, opts) === "scopes" && (variable.scopes || []).every((s) => PERCENT_SCOPES.has(s));
}

export { segs, isSentinel, defaultModeName, baseValue, unitDecision, percentOpacity };
