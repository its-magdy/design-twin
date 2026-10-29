// variable-class.ts — what a Figma variable IS, decided once for every token emitter: classifyVariable().
//
// tokens.ts (DTCG / CSS / Resolver / Tailwind) and tokens-native.ts (SwiftUI / Compose / Flutter / React Native) each
// map a class to their own syntax — a `dimension` $type, `px` or `%`, a `--radius-*` namespace, `.sp` or `.dp` — and
// never re-read scopes or names themselves, so no two emitters can file one variable differently. A variable's value
// in a mode is variable-resolve.ts's; its emitted names are token-naming.ts's.
//
// The rule, in one order. TYPE first (COLOR, BOOLEAN, STRING, FLOAT; anything else has no class). Then, for a FLOAT,
// its UNIT (unitDecision — the caller's override, then narrowed scopes, then the name): a unitless FLOAT is an opacity
// percentage when its scopes say opacity and nothing else, else a plain number. A length is then a radius, a font size
// or a plain length — SCOPES FIRST when the designer narrowed them (CORNER_RADIUS before FONT_SIZE: a FLOAT scoped to
// both is a radius), the NAME only when they did not (Figma's default ALL_SCOPES carries no signal), in the same
// radius-before-font-size order. A STRING is a font family by its FONT_FAMILY scope, or by name under ALL_SCOPES.
//
// Imported by both emitters, and importing neither: tokens.ts imports tokens-native.ts (for toNative), so this living
// in tokens.ts would be a cycle, which makes the bundler wrap tokens.ts as an inner module whose `import.meta.main` CLI
// guard then never fires.
import type { Variable } from "./types.ts";
import { isAlias } from "./doc-guards.ts";
import { segs } from "./tokens-core.ts";

/** The px-vs-unitless override every emitter honours (unitDecision): the names a caller declared unitless. */
export interface UnitOpts {
  unitless?: { has: (name: string) => boolean };
}
/** unitDecision(): WHO decided a FLOAT's unit. */
export type UnitDecision = "override" | "scopes" | "name" | "px";

/** What a variable is — the one answer every emitter maps to its own syntax.
 *  `length` / `radius` / `fontSize`: a FLOAT in px. `percent`: a FLOAT on Figma's 0–100 opacity scale. `number`: a
 *  unitless FLOAT (font weight, a multiplier, an opacity the scopes did not vouch for). `fontFamily` / `string`: a
 *  STRING. `color`, `bool`: COLOR, BOOLEAN. */
export type VariableClass = "color" | "length" | "radius" | "fontSize" | "percent" | "number" | "fontFamily" | "string" | "bool";

// Scopes are only a signal when the designer NARROWED them. Figma's default is ALL_SCOPES, and real files
// overwhelmingly leave it there (it's the very smell `hygiene[]` reports) — so every rule below falls back to the
// NAME when scopes say nothing, and never second-guesses narrowed scopes with a name match.
function narrowedScopes(v: Variable): readonly string[] | null {
  const scopes = v.scopes || [];
  return scopes.length && !scopes.every((s) => s === "ALL_SCOPES") ? scopes : null;
}
// The name a fallback reads: the collection too, so a "Type" collection's `body` reads as a font size.
const qualifiedName = (v: Variable): string => (v.collection ?? "") + "/" + v.name;

// FLOAT unit: Figma FLOAT variables are overwhelmingly dimensions -> `px`; OPACITY/FONT_WEIGHT scopes
// (and any name in opts.unitless) are NOT lengths, so we never emit invalid CSS like `opacity: 0.5px`
// (FONT_WEIGHT is a bare number; OPACITY/COLOR_OPACITY a percentage — see `percent` below).
// LINE_HEIGHT/LETTER_SPACING are DELIBERATELY not unitless: per the Figma API these are px|percent
// (LineHeight = {value, unit:"PIXELS"|"PERCENT"} | AUTO), never a CSS-style unitless multiplier — so
// `px` is the safe default. Emitting them unitless would be wrong (`line-height: 24` = 24x font size)
// and for letter-spacing outright invalid CSS (a bare number is not a valid <length>). Use opts.unitless
// to override per-token when a source genuinely encodes a multiplier.
// COLOR_OPACITY (typings 1.139): a FLOAT offered as the opacity half of a composed colour — an opacity too.
const UNITLESS_SCOPES = new Set(["OPACITY", "COLOR_OPACITY", "FONT_WEIGHT"]);
// The name fallback (ALL_SCOPES) is matched per `/`-SEGMENT, not as a substring of the whole name. A substring rule
// (what this was) cannot tell "font-weight/bold" from "font-weight-scale/lg": both contain "font-weight" followed by a
// non-letter, but the second is a multiplier — the one FLOAT in the family where dropping the unit is
// the wrong call. Figma names are `/`-delimited groups, so the group IS the unit of meaning: a segment
// that is exactly the property (ignoring case and -/_/space) names it; one that merely starts with it
// names something else. "text/font-weight" and "Opacity/disabled" both still match.
const UNITLESS_NAME_SEGMENTS = new Set(["opacity", "fontweight"]);
function unitlessName(name: string): boolean {
  // segs() is tokens-core.ts's ONE definition of "a Figma token name split into meaningful segments"
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
// classifyVariable maps the decision to a class, and lintNames warns iff the decision was "name".
function unitDecision(variable: Variable, opts?: UnitOpts): UnitDecision {
  if (opts && opts.unitless && opts.unitless.has && opts.unitless.has(variable.name)) return "override";
  const scopes = variable.scopes || [];
  if (scopesSayUnitless(scopes)) return "scopes";
  if (!narrowedScopes(variable) && unitlessName(variable.name)) return "name";
  return "px";
}
// OPACITY / COLOR_OPACITY: Figma's opacity numbers are PERCENTAGES, 0–100. REST API variables types
// (https://developers.figma.com/docs/rest-api/variables-types/): VariableComposedColor.opacity is "An
// opacity percentage from 0 to 100, or an alias to a FLOAT variable", and VariableScope says "OPACITY
// corresponds to layer opacity, while COLOR_OPACITY corresponds to the opacity channel of a color".
// So a FLOAT whose SCOPES say "opacity" (and nothing else) is a `percent`: CSS writes it `N%` — valid for the
// `opacity` property and as an <alpha-value> — never a bare `N`, which `opacity` clamps to 1 (fully
// opaque); DTCG keeps the verbatim number, marked $extensions["figma.com"].unit: "percent"; native writes N/100.
// Scopes only: a name-heuristic or opts.unitless token carries no evidence of Figma's scale, so it
// stays a bare number; so does a mix with FONT_WEIGHT (which half of the mix is it?).
const PERCENT_SCOPES = new Set(["OPACITY", "COLOR_OPACITY"]);

// Radius before font size, in both the scope rule and the name rule: a FLOAT a designer offered to corner radius
// AND font size (or named both ways) is filed under the radius. One order for every emitter — Tailwind's
// `--radius-*` and native's dp-not-sp then agree.
function lengthClass(v: Variable): "length" | "radius" | "fontSize" {
  const scopes = narrowedScopes(v);
  if (scopes) return scopes.includes("CORNER_RADIUS") ? "radius" : scopes.includes("FONT_SIZE") ? "fontSize" : "length";
  if (/radius|corner|rounded/i.test(v.name)) return "radius";
  if (/font.?size|text.?size|type.?size/i.test(qualifiedName(v))) return "fontSize";
  return "length";
}

/** What `v` is (see the header for the rule); null for a type no emitter writes (EASING / TIMING — motion objects). */
function classifyVariable(v: Variable, opts?: UnitOpts): VariableClass | null {
  switch (v.type) {
    case "COLOR": return "color";
    case "BOOLEAN": return "bool";
    case "STRING": {
      // the scope is the designer's own statement — a FONT_FAMILY-scoped STRING is a font family
      // whatever it is called ("Heading" in a "Type" collection). The name is only a fallback when the scopes
      // say nothing (ALL_SCOPES / none); a STRING narrowed to anything else (FONT_STYLE: "Semi Bold") is not one.
      const scopes = narrowedScopes(v);
      const font = scopes ? scopes.includes("FONT_FAMILY") : /font.?family|typeface/i.test(qualifiedName(v));
      return font ? "fontFamily" : "string";
    }
    case "FLOAT": {
      const unit = unitDecision(v, opts);
      if (unit === "px") return lengthClass(v);
      return unit === "scopes" && (v.scopes || []).every((s) => PERCENT_SCOPES.has(s)) ? "percent" : "number";
    }
    // a type this file's Variable does not know (a newer export) has no emitter either
    case "EASING": case "TIMING": default: return null;
  }
}
/** A class whose values carry a px unit. */
const isLengthClass = (c: VariableClass | null): c is "length" | "radius" | "fontSize" => c === "length" || c === "radius" || c === "fontSize";

// --- Figma's "fully rounded" sentinel ------------------------------------------------------------
// A pill corner exports as a literal 1e9 (cross-check.ts reports it as `sentinel-token-value`). It is
// an idiom, not a measurement, and `1000000000px` must never reach a stylesheet.
// Every emitter writes the platform's own idiom instead: 9999px on the web (and in DTCG, with the
// original kept under $extensions), `.infinity` in SwiftUI, `double.infinity` in Flutter, 9999 in
// React Native, and 9999.dp with a CircleShape note in Compose.
// A VALUE test, not a class: one mode of a radius may be 1e9 and the next 8. Its guard is deliberately WIDER than
// the `radius` class — every radius passes it, and so does a name with "round" anywhere in its collection or name,
// whatever its unit — because the costs are lopsided: a missed sentinel prints 1000000000px, while a wrongly caught
// one turns a number nobody could have meant (≥ 10000) into 9999.
const SENTINEL_MIN = 10000; // the same threshold as cross-check.ts ABSURD_NUMBER
function mayBeRadius(v: Variable): boolean {
  const scopes = narrowedScopes(v);
  if (scopes) return scopes.includes("CORNER_RADIUS");
  return /radius|corner|round/i.test(qualifiedName(v));
}
function isSentinel(v: Variable | null | undefined, raw: unknown): boolean {
  if (!v || v.type !== "FLOAT" || isAlias(raw)) return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && Math.abs(n) >= SENTINEL_MIN && mayBeRadius(v);
}

export { classifyVariable, isLengthClass, unitDecision, isSentinel };
