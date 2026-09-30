// tokens.ts — turn the extractor's variable dump into design tokens.
//
// Consumes the `designSystem` shape from figma-plugin/code.js buildDesignSystem()/dumpVariables():
//   { colorProfile?, collections:[{name,modes:[modeName],default,theming}],
//     variables:[{ name:"color/primary", type:"COLOR"|"FLOAT"|"STRING"|"BOOLEAN",
//                  collection, values:{ modeName: "#2563eb" | 123 | {aliasOf:"blue/600"}
//                                               | {composed:{color, opacity}} }, ... }] }
//
// Emits:
//   toDTCG(ds[, warnings, opts]) -> W3C DTCG JSON in the STABLE 2025.10 format (references PRESERVED
//                             as "{group.token}"; structured color {colorSpace,components,alpha?,
//                             hex(6-digit)}; length FLOATs as $type "dimension" {value,unit:"px"},
//                             unitless ones as "number"; every leaf carries a valid $type).
//                             Not emitted: composite types (typography/shadow/…). Modes ride in
//                             $extensions["figma.com"].modes here AND in the resolver below.
//                             A COMPOSED colour (Figma Update 139: a colour plus a separate opacity,
//                             one or both of them variable aliases) is a $type "color" token whose
//                             $value is the colour half (a "{ref}" or a structured colour). DTCG
//                             2025.10 has no way to put a reference and an opacity in one colour
//                             value, so the opacity half (a number or a "{ref}") rides in
//                             $extensions["figma.com"].opacity (per-mode: .modeOpacity), in
//                             tokens.dtcg.json AND in the resolver set files. The number is Figma's,
//                             verbatim, on Figma's 0–100 scale: "An opacity percentage from 0 to
//                             100, or an alias to a FLOAT variable" (REST API variables types,
//                             VariableComposedColor.opacity —
//                             https://developers.figma.com/docs/rest-api/variables-types/). DTCG
//                             `alpha` is 0–1 and cannot hold a reference, so it is not folded in.
//                             tokens.css/theme.css write the WHOLE value as
//                             `color-mix(in srgb, <colour> <opacity>%, transparent)` (see cssValue),
//                             except when the opacity half aliases a FLOAT whose CSS is not a
//                             percentage — then the colour half only, and lintTokens says so.
//                             OPACITY / COLOR_OPACITY-scoped FLOATs (the same 0–100 scale — the
//                             REST page's VariableScope: "OPACITY corresponds to layer opacity, while
//                             COLOR_OPACITY corresponds to the opacity channel of a color") are
//                             written to CSS as a clamped percentage (`40%`), and keep their verbatim
//                             number in DTCG with $extensions["figma.com"].unit: "percent" (in
//                             tokens.dtcg.json AND in the resolver set files).
//   toResolver(ds[, warnings, opts]) -> { resolver, files }: a DTCG **Resolver Module** 2025.10
//                             document (the spec-blessed portable theming mechanism) plus the token
//                             files it $refs. Each multi-mode collection becomes a modifier whose
//                             contexts are its mode names; base sets carry default-mode values and a
//                             context carries ONLY what differs (same dedup as toCSS).
//   toCSS(ds[, opts])      -> :root + one block per (collection, mode): [data-theme="mode"], or
//                             [data-theme-<collection>="mode"] when collections share the mode name
//                             (see planModeScopes) — custom properties, zero-dependency.
//   lintTokens(ds[, opts]) -> string[] of problems (never-silent guarantee): group/leaf collisions,
//                             duplicate names, malformed/missing color, missing default-mode value,
//                             dangling aliases, CSS var-name collisions, empty names.
//
// Defensive by construction: a collision or missing value is skipped + reported, never silently
// producing an illegal DTCG node or `--x: undefined;`. See docs/design-to-code-spec.md.
import fs from "node:fs";
import path from "node:path";
import type { TokensDoc, Variable, VariableAlias, VariableCollection, VariableType, VariableValue } from "./types.ts";
import { readSplitFile, NO_DESIGN_SYSTEM_HINT } from "./catalog-input.ts";
import { isTokensDoc } from "./doc-guards.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { sourcesOf, type SliceSources } from "./slice-sources.ts";
import { normHex, clampOpacityPct } from "./color.ts";
import nativeEmitter, { type UnitDecision, type UnitOpts } from "./tokens-native.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2
import { ifDefined, nullProto } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";
import type { VariableComposedColor } from "../bridge/src/doc-types.ts";
import { TAILWIND_SOURCE_NOT_NOTE } from "../bridge/src/project-layout.ts";

/** The options every emitter shares (opts.unitless is honoured by the ONE unitDecision below). */
export interface EmitOpts extends UnitOpts {
  /** toCSS: the selector a non-default mode's block lives under. Default `[<scope.attribute>="<mode>"]`,
   *  where scope.attribute is `data-theme`, or `data-theme-<collection>` when several collections have a
   *  block for that mode name (see planModeScopes). `scope.collection` is the collection's name. */
  selector?: (mode: string, scope: ModeScope) => string;
  /** The CSS files the caller writes ("tokens.css", "theme.css") — warnings name these, not a fixed file.
   *  Default: tokens.css, plus theme.css when opts.tailwind. */
  cssFiles?: readonly string[];
  /** Map(variable key -> [screen]) so a collision warning can say which screen each variable came from. */
  sources?: SliceSources | null;
  /** emitTokens: also build theme.css in the same pass. */
  tailwind?: boolean;
}

// ---- the DTCG tree this file emits (tokens.dtcg.json and every resolver set file)
export interface DtcgDimension { value: number; unit: "px" }
/** The DTCG Color Module colour spaces this emitter writes (the export's colorProfile decides). */
export type DtcgColorSpace = "srgb" | "display-p3";
/** DTCG Color Module 2025.10 structured color. */
export interface DtcgColor { colorSpace: DtcgColorSpace; components: number[]; alpha?: number; hex?: string }
/** The DTCG 2025.10 $types this emitter writes (BOOLEAN is coerced to "string"; a length FLOAT is "dimension"). */
export type DtcgType = "color" | "number" | "string" | "dimension";
export type DtcgLeafValue = string | number | boolean | DtcgDimension | DtcgColor;
/** A composed colour's opacity half: Figma's number verbatim (0–100, a percentage), or a "{ref}" to the opacity token. */
export type DtcgOpacity = number | string;
export interface DtcgFigmaExtension {
  modes?: Record<string, DtcgLeafValue>;
  /** composed colour: the opacity half of $value (see the header comment) */
  opacity?: DtcgOpacity;
  /** composed colour, 2+ modes: the opacity half per mode (only modes whose value is composed) */
  modeOpacity?: Record<string, DtcgOpacity>;
  key?: string;
  sentinel?: { figmaValue: VariableValue; meaning: string };
  scopes?: string[];
  /** an OPACITY / COLOR_OPACITY-scoped FLOAT: $value is Figma's 0–100 percentage, verbatim (tokens.css writes `N%`) */
  unit?: "percent";
  codeSyntax?: Variable["codeSyntax"];
  originalType?: "boolean";
}
export interface DtcgLeaf { $type: DtcgType; $value: DtcgLeafValue; $description?: string; $extensions?: { "figma.com": DtcgFigmaExtension } }
export interface DtcgGroup { [key: string]: DtcgGroup | DtcgLeaf }
/** A node in the tree is a leaf iff it carries a $value (a group never does). */
const isLeaf = (n: DtcgGroup | DtcgLeaf | undefined): n is DtcgLeaf => n !== undefined && n.$value !== undefined;

// ---- the DTCG Resolver Module document (toResolver)
export interface ResolverRef { $ref: string }
export interface ResolverSet { description: string; sources: ResolverRef[]; $extensions: { "figma.com": { collection: string | null } } }
export interface ResolverModifier { description: string; contexts: Record<string, ResolverRef[]>; default: string; $extensions: { "figma.com": { collection: string | null; defaultMode: string } } }
/** toResolver()'s document: version, sets and resolutionOrder are always written; modifiers only when some collection has 2+ modes. */
export interface ResolverDoc { $schema: string; name?: string; version: typeof RESOLVER_VERSION; sets: Record<string, ResolverSet>; modifiers?: Record<string, ResolverModifier>; resolutionOrder: ResolverRef[] }

export interface TailwindResult { text: string; utilities: number; tokens: number; warnings: string[] }
export interface EmitResult {
  dtcg: DtcgGroup;
  css: string;
  tailwind: TailwindResult | undefined;
  resolver: ResolverDoc;
  resolverFiles: Record<string, DtcgGroup>;
  warnings: string[];
  collisions: string[];
}

const round = (x: number): number => Math.round(x * 10000) / 10000;

// --- name handling. CSS custom properties ARE case-sensitive, so var names PRESERVE case
// (only non-[A-Za-z0-9-] is folded) — otherwise "Gray/100" and "gray/100" would collide. ---
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
const dtcgRef = (tokenName: string): string => "{" + segs(tokenName).join(".") + "}";
const varNameCache = new Map<string, string>();
const cssVarName = (tokenName: string): string => {
  const key = String(tokenName || "");
  let v = varNameCache.get(key);
  if (v === undefined) varNameCache.set(key, (v = "--" + segs(key).join("-").replace(/[^A-Za-z0-9-]/g, "-")));
  return v;
};

// --- identity: a Figma variable IS its key, never its name -------------------------------------
// Names are not unique. The livetest-3 export held 96 variables with 96 distinct keys and only 94
// distinct names: two variables called `Spacing/Space 4` (24 in the design system's library, 16 in a
// screen-local one) and two called `Spacing/Space 2`. Every emitter here used to key its output on
// the NAME, so the second definition silently overwrote the first — theme.css shipped
// `--spacing-space-4: 16px` for two screens whose own Figma says 24, under a "later definition wins"
// warning that described nothing useful. Worse, `Space 3` (16) and `(Space 3)` (12) are two
// different names that only collide AFTER slugging, so that pair was overwritten with no warning at
// all (livetest-3 findings 44, 94, 95).
//
// So every emitter plans its identifiers here, on the EMITTED identifier (the DTCG path, the CSS
// custom property, the Tailwind variable), and never picks a winner:
//   * the same key listed twice is one variable (the last record is used);
//   * different keys that fold onto one identifier but resolve to the same value in every mode
//     (`Space 2` = 8 under Desktop/Tablet/Mobile vs 8 under Mode 1) are emitted ONCE, and reported;
//   * different keys that fold onto one identifier and DIFFER are ALL emitted, each under the
//     identifier plus `-<first 8 chars of its key>`, and the warning names every key, its values,
//     the screens whose slice carries it, and the identifier it landed on.
const KEY_SUFFIX_LEN = 8;
function identityOf(v: Variable): string {
  if (v && typeof v.key === "string" && v.key) return "k:" + v.key;
  return "n:" + String((v && v.collection) || "") + "\u0000" + String((v && v.name) || "");
}
const shortKey = (v: Variable | null | undefined): string | null => (v && typeof v.key === "string" && v.key ? v.key.slice(0, KEY_SUFFIX_LEN).toLowerCase() : null);
const suffixSlug = (s: string | null | undefined): string => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Equivalent = every mode either variable declares resolves to the same value (a mode one side lacks
// falls back to that side's own default, which is exactly what every emitter below does with it).
function equivalentVars(a: Variable, b: Variable, collections: VariableCollection[] | undefined): boolean {
  if (a.type !== b.type) return false;
  const ba = JSON.stringify(baseValue(a, collections)), bb = JSON.stringify(baseValue(b, collections));
  if (ba !== bb) return false;
  const at = (v: Variable, base: string, m: string): string => { const x = (v.values || {})[m]; return x === undefined ? base : JSON.stringify(x); };
  for (const m of new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])) if (at(a, ba, m) !== at(b, bb, m)) return false;
  return true;
}

/** One identifier collision planIds found: the records that fold onto `id` in `output`, and what each was emitted as. */
export interface CollisionNote { output: string; id: string; differ: boolean; members: Array<{ v: Variable; id: string }> }
/** planIds' plan: `id(v)` is undefined for a variable the emitter skips (idOf gave null). */
export interface IdPlan {
  id: (v: Variable) => string | undefined;
  /** the ONE record emitted per identifier, mapped to that identifier (= its `id(v)`) */
  canonical: Map<Variable, string>;
  notes: CollisionNote[];
  byName: Map<string, Variable[]>;
}

// idOf(v) -> the identifier an emitter would give v on its own (null = the emitter skips v).
// suffix(id, s) -> that identifier disambiguated with `s`.
// exact(v) -> true when v's NAME reaches the identifier without any character being folded away.
//   When two DIFFERENT names collide (`Space 3` vs `(Space 3)`), exactly one of them usually spells
//   the identifier as written; that one keeps it and only the folded one is suffixed — order-free,
//   so re-ordering the input cannot move the plain name. Same-name pairs are always all suffixed.
// Returns { id(v), canonical: Set(v) — the ONE record emitted per identifier, notes[], byName }.
function planIds(vars: readonly Variable[], idOf: (v: Variable) => string | null, suffix: (id: string, s: string) => string, collections: VariableCollection[] | undefined, output: string, exact?: (v: Variable) => boolean): IdPlan {
  const groups = new Map<string, Variable[]>();
  for (const v of vars) {
    const id = idOf(v);
    if (id == null) continue;
    getOrInit(groups, id, () => []).push(v);
  }
  const ids = new Map<Variable, string>(), canonical = new Map<Variable, string>(), notes: CollisionNote[] = [];
  const taken = new Set(groups.keys());
  for (const [id, list] of groups) {
    const byIdent = new Map<string, Variable>();
    for (const v of list) byIdent.set(identityOf(v), v); // the same variable read twice: last record
    const members = [...byIdent.values()];
    const clusters: [Variable, ...Variable[]][] = [];
    for (const v of members) {
      const c = clusters.find((cl) => equivalentVars(cl[0], v, collections));
      if (c) c.push(v); else clusters.push([v]);
    }
    const onlyCluster = clusters.length === 1 ? clusters[0] : undefined;
    if (onlyCluster) {
      for (const v of list) ids.set(v, id);
      canonical.set(onlyCluster[0], id); // members[0]: the first member always opens the first cluster
      if (members.length > 1) notes.push({ output, id, differ: false, members: members.map((v) => ({ v, id })) });
      continue;
    }
    // Every member of this group gets exactly one identifier below, recorded in member order.
    const assigned = new Map<string, string>(), memberIds: CollisionNote["members"] = [];
    const exactOnes = exact ? members.filter((v) => exact(v)) : [];
    const exactOne = exactOnes.length === 1 ? exactOnes[0] : undefined;
    const keeper = exactOne && members.filter((v) => v.name === exactOne.name).length === 1 ? exactOne : null;
    for (const v of members) {
      if (v === keeper) { assigned.set(identityOf(v), id); canonical.set(v, id); memberIds.push({ v, id }); continue; }
      const s = shortKey(v) || suffixSlug(v.collection) || "alt";
      let nid = suffix(id, s);
      for (let n = 2; taken.has(nid); n++) nid = suffix(id, s + "-" + n);
      taken.add(nid);
      assigned.set(identityOf(v), nid);
      canonical.set(v, nid);
      memberIds.push({ v, id: nid });
    }
    // Every record in `list` shares its identity with one member (byIdent above), so every lookup hits;
    // a miss would only leave id(v) undefined, which is what the old `ids.set(v, undefined)` gave too.
    for (const v of list) { const got = assigned.get(identityOf(v)); if (got !== undefined) ids.set(v, got); }
    notes.push({ output, id, differ: true, members: memberIds });
  }
  const byName = new Map<string, Variable[]>();
  for (const v of vars) {
    getOrInit(byName, v.name, () => []).push(v);
  }
  return { id: (v) => ids.get(v), canonical, notes, byName };
}

// An alias carries its target's NAME only (that is all the export writes), so a name shared by two
// variables makes the target ambiguous. Equivalent candidates share one identifier and it does not
// matter; otherwise prefer the referrer's own collection, then the lowest key — deterministic, so a
// re-ordered input cannot change the output — and SAY so.
// Returns the target together with its planned identifier (candidates without one are never picked).
function aliasTargetId(plan: IdPlan, name: string, referrer: Variable | null | undefined, warn?: (m: string) => void): { v: Variable; id: string } | null {
  const cands: Array<{ v: Variable; id: string }> = [];
  for (const c of plan.byName.get(name) || []) { const id = plan.id(c); if (id != null) cands.push({ v: c, id }); }
  const firstCand = cands[0];
  if (firstCand === undefined) return null;
  if (new Set(cands.map((c) => c.id)).size === 1) return firstCand;
  const sameColl = cands.filter((c) => referrer && c.v.collection === referrer.collection);
  const pool = (sameColl.length && new Set(sameColl.map((c) => c.id)).size === 1 ? sameColl : cands)
    .slice().sort((a, b) => String(a.v.key || "").localeCompare(String(b.v.key || "")));
  const pick = pool[0] ?? firstCand; // ?? firstCand: pool is sameColl (non-empty) or cands (non-empty), so it never applies
  if (warn) {
    warn(`alias '${referrer ? referrer.name : "?"}' -> '${name}' is AMBIGUOUS: the export names an alias target by name, and ${cands.length} different variables are called '${name}' ` +
      `(${cands.map(({ v: c }) => (shortKey(c) ? "key " + shortKey(c) + "…" : "'" + (c.collection ?? "") + "'") + " " + JSON.stringify(c.values)).join(", ")}) — pointed at ${pick.id}; confirm in Figma which one it really aliases`);
  }
  return pick;
}
function aliasTarget(plan: IdPlan, name: string, referrer: Variable | null | undefined, warn?: (m: string) => void): Variable | null {
  const t = aliasTargetId(plan, name, referrer, warn);
  return t ? t.v : null;
}

// One message per SET of colliding variables, however many outputs it showed up in — the same
// `Space 4` pair collides in tokens.dtcg.json, tokens.css and theme.css, and three near-identical
// paragraphs is how a warning stops being read.
function collisionMessages(notes: readonly CollisionNote[], opts?: EmitOpts): string[] {
  const sources = (opts && opts.sources) || null;
  const bySet = new Map<string, [CollisionNote, ...CollisionNote[]]>();
  for (const n of notes) {
    const k = (n.differ ? "D" : "S") + n.members.map((m) => identityOf(m.v)).sort().join("|");
    const group = bySet.get(k);
    if (group) group.push(n); else bySet.set(k, [n]);
  }
  const out: string[] = [];
  for (const group of bySet.values()) {
    const first = group[0];
    const members = first.members.map((m) => m.v);
    const names = [...new Set(members.map((v) => v.name))];
    const who = (v: Variable): string => {
      const k = shortKey(v);
      // `k` is non-null only when v.key is a non-empty string, so String(v.key) is that key.
      const where = k && sources ? sources.get(String(v.key)) : null;
      return (k ? `key ${k}…` : `'${v.collection || ""}'`) + ` = ${JSON.stringify(v.values || {})}` +
        (where && where.length ? ` (from ${where.join(", ")})` : "");
    };
    const m0 = members[0];
    const oneColl = m0 !== undefined && members.every((v) => v.collection === m0.collection) && m0.collection;
    const subject = names.length === 1
      ? `${members.length} different Figma variables share the name '${names[0]}'${oneColl ? ` (collection '${oneColl}')` : ""}`
      : `${members.length} different Figma variables (${names.map((n) => `'${n}'`).join(", ")}) fold onto one identifier`;
    const where = group.map((n) => `${n.output} ${n.members.map((m) => m.id).join(" / ")}`).join("; ");
    if (first.differ) {
      out.push(`${subject} and resolve DIFFERENTLY — none is dropped, each keeps its own name: ${members.map(who).join(" vs ")}. ` +
        `Emitted as: ${where}. ` +
        (names.length === 1
          ? `Pick by key, never by name. A screen's own .vars.json usually carries only one of them under the plain name — ` +
            `generate that screen's theme from it (or from design-system/tokens.json), not from the merged variables.json.`
          : `The name spelled exactly as the identifier keeps it; a name that only reached it by folding punctuation carries its key.`));
    } else {
      out.push(`${subject} but resolve identically in every mode — emitted ONCE: ${members.map(who).join(" and ")} → ${where}.`);
    }
  }
  return out;
}

// --- Figma's "fully rounded" sentinel ------------------------------------------------------------
// A pill corner exports as a literal 1e9 (cross-check.ts reports it as `sentinel-token-value`). It is
// an idiom, not a measurement, and `1000000000px` must never reach a stylesheet (livetest-3 #96).
// Every emitter writes the platform's own idiom instead: 9999px on the web (and in DTCG, with the
// original kept under $extensions), `.infinity` in SwiftUI, `double.infinity` in Flutter, 9999 in
// React Native, and 9999.dp with a CircleShape note in Compose.
const SENTINEL_MIN = 10000; // the same threshold as cross-check.ts ABSURD_NUMBER
const WEB_FULL_ROUND = 9999;
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
const webNumber = (v: Variable, raw: VariableValue): VariableValue => (isSentinel(v, raw) ? WEB_FULL_ROUND : raw);

// --- color: color.ts normHex (optional #, 3/4/6/8 digits -> "#rrggbb" / "#rrggbbaa"). ---
const isHexish = (v: unknown): v is string => typeof v === "string" && /^#/.test(v);
const isScalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const isAlias = (v: unknown): v is VariableAlias => !!v && typeof v === "object" && "aliasOf" in v && typeof v.aliasOf === "string";
// A composed colour {composed:{color, opacity}} (doc-types ComposedColor). Each half is checked, so a
// hand-written token file with a malformed `composed` object is a non-scalar value (skipped + reported),
// never a half-read one.
const isComposed = (v: unknown): v is VariableComposedColor => {
  if (!v || typeof v !== "object" || !("composed" in v)) return false;
  const c = v.composed;
  if (!c || typeof c !== "object" || !("color" in c) || !("opacity" in c)) return false;
  const colorOk = typeof c.color === "string" || isAlias(c.color);
  const opacityOk = typeof c.opacity === "number" || isAlias(c.opacity);
  return colorOk && opacityOk && (isAlias(c.color) || isAlias(c.opacity));
};
// The alias names a value references: a top-level alias, or a composed colour's nested alias(es).
function aliasNames(v: unknown): string[] {
  if (isAlias(v)) return [v.aliasOf];
  if (!isComposed(v)) return [];
  const out: string[] = [];
  if (isAlias(v.composed.color)) out.push(v.composed.color.aliasOf);
  if (isAlias(v.composed.opacity)) out.push(v.composed.opacity.aliasOf);
  return out;
}

// --- CSS string safety. A custom-property value is a token stream, so a STRING token can break out of
// its declaration three different ways; all three are neutralized with CSS hex escapes (`\3b ` etc.):
//
//   1. Terminators — `;` `{` `}` (plus newlines and backslash) end the declaration or block early.
//   2. Comment delimiters — `/*` opens a comment that swallows every following declaration to the end
//      of the stylesheet (`*/` closes one early). Only the two-character sequences are escaped, so a
//      lone `/` or `*` in a legitimate value (`url(/img.png)`, `2 * 4`) still passes through.
//   3. Unbalanced `(` `)` or quotes — leave the parser inside a function/string to end-of-stylesheet.
//      Balance is checked first so ordinary values keep their delimiters verbatim: `cubic-bezier(.4,0,.2,1)`
//      and `"Inter", sans-serif` are balanced and are NOT escaped.
//
// lintTokens must report every value the emitter rewrites (the never-silent guarantee). Rather than
// keep a detector "twin" that has to be edited in lockstep with the escaper — and whose failure mode
// is invisible, a value quietly rewritten with no warning — the detector below simply ASKS the
// escaper whether it changed anything. The escaper is then the only place the rules live. ---
const CSS_UNSAFE = /[\\\n\r\f;{}]/g;
// `c` is always one character (a regex match), so it has a code point.
const hexEsc = (c: string): string => "\\" + (c.codePointAt(0) ?? 0).toString(16) + " "; // `?? 0` is inert

// True when `(`/`)` or quote characters don't pair up across the whole value.
function cssUnbalanced(s: string): boolean {
  let depth = 0, dq = 0, sq = 0;
  for (const ch of String(s)) {
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth < 0) return true; }
    else if (ch === '"') dq++;
    else if (ch === "'") sq++;
  }
  return depth !== 0 || dq % 2 !== 0 || sq % 2 !== 0;
}
// Defined below cssEscapeText's declaration point in execution order (function hoisting) — it is
// exactly "would the emitter rewrite this?", so it can never be narrower than the escaper.
const cssNeedsEscape = (s: unknown): boolean => typeof s === "string" && cssEscapeText(s) !== s;

// A MODE NAME lands inside an attribute selector — `[data-theme="<mode>"]`. That's a quoted-string
// context, not a value context, so cssEscapeText's rules don't apply: only `"` and `\` are structural
// there, and either one closes the string early and lets the rest of the name inject arbitrary
// selectors and declarations. Mode names are free-form designer strings (the Plugin API documents no
// restriction on them), so escape the two characters that matter. cssAttrNeedsEscape derives from the
// escaper for the same reason as cssNeedsEscape above — one rule, no twin to keep in sync.
const CSS_ATTR_UNSAFE = /["\\]/g;
const cssAttrEscape = (s: string): string => String(s).replace(CSS_ATTR_UNSAFE, hexEsc);
const cssAttrNeedsEscape = (s: string): boolean => cssAttrEscape(s) !== String(s);

function cssEscapeText(s: string): string {
  const raw = String(s);
  let out = raw.replace(CSS_UNSAFE, hexEsc);
  // Break comment delimiters by escaping only the `*`, so `/` and `*` alone survive untouched.
  out = out.replace(/\/\*/g, "/" + hexEsc("*")).replace(/\*\//g, hexEsc("*") + "/");
  // Only when the value is genuinely unbalanced — balanced parens/quotes are legitimate CSS.
  if (cssUnbalanced(raw)) out = out.replace(/[()"']/g, hexEsc);
  return out;
}

// The plugin writes Figma's documentColorProfile lowercased: "display_p3" (underscore — the Plugin API's
// DISPLAY_P3). "display-p3" (DTCG's own spelling) is accepted too, for hand-written token files.
const isP3 = (colorProfile: string | undefined): boolean => colorProfile === "display_p3" || colorProfile === "display-p3";
function hexToColorValue(hex: unknown, colorProfile?: string): DtcgColor | null {
  const e = normHex(hex);
  if (!e) return null;
  const n = (i: number): number => parseInt(e.slice(i, i + 2), 16) / 255;
  const value: DtcgColor = { colorSpace: isP3(colorProfile) ? "display-p3" : "srgb", components: [round(n(1)), round(n(3)), round(n(5))] };
  // DTCG Color Module 2025.10: opacity lives in `alpha`; the `hex` fallback MUST be 6-digit
  // ("to avoid conflicts with the provided alpha value"). An 8-digit hex fallback is non-conformant.
  if (e.length === 9) value.alpha = round(n(7));
  value.hex = e.slice(0, 7);
  return value;
}

// DTCG 2025.10 $type mapping. `string` became a primitive type in 2025.10 (so STRING is no longer
// typeless). BOOLEAN has NO DTCG type — handled separately (a typeless token is INVALID per spec).
const DTCG_TYPE: Partial<Record<VariableType, DtcgType>> = { COLOR: "color", FLOAT: "number", STRING: "string" };
// The variable types every emitter here writes. Anything else — EASING / TIMING variables, whose
// per-mode values are motion OBJECTS, not scalars — is skipped: toDTCG/toResolver say so (a warning
// per token), toCSS/theme.css leave it out, tokens-native.ts skips it with its own warning.
const EMITTED_TYPES: ReadonlySet<string> = new Set<VariableType>(["COLOR", "FLOAT", "STRING", "BOOLEAN"]);
const emitted = (v: Variable): boolean => EMITTED_TYPES.has(v.type);

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

// `dimension`: the FLOAT is a length (see unitDecision) — DTCG 2025.10 requires the object form
// {value, unit:"px"|"rem"} for $type "dimension"; a bare number there is non-conformant.
// Only a scalar or an alias has a DTCG value here: an object (a motion value) is null — never "[object Object]".
// A composed colour's $value is its COLOUR half — a reference, or the structured colour of its hex (a
// malformed hex is null: skipped + reported); the opacity half is dtcgOpacity's, under $extensions.
function dtcgValue(raw: VariableValue, colorProfile: string | undefined, dimension: boolean, ref?: (name: string) => string): DtcgLeafValue | null {
  if (isAlias(raw)) return ref ? ref(raw.aliasOf) : dtcgRef(raw.aliasOf);
  if (isComposed(raw)) {
    const { color } = raw.composed;
    return isAlias(color) ? (ref ? ref(color.aliasOf) : dtcgRef(color.aliasOf)) : hexToColorValue(color, colorProfile);
  }
  if (!isScalar(raw)) return null;
  if (dimension) {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? { value: n, unit: "px" } : raw;
  }
  const c = isHexish(raw) ? hexToColorValue(raw, colorProfile) : null;
  return c || raw;
}
// The opacity half of a composed colour, for $extensions["figma.com"]: the number verbatim, or a
// "{ref}" built exactly like a $value reference. Undefined for every other value.
function dtcgOpacity(raw: VariableValue | undefined, ref?: (name: string) => string): DtcgOpacity | undefined {
  if (!isComposed(raw)) return undefined;
  const { opacity } = raw.composed;
  return isAlias(opacity) ? (ref ? ref(opacity.aliasOf) : dtcgRef(opacity.aliasOf)) : opacity;
}

// Build nested DTCG groups from "a/b/c". ONE builder behind BOTH emitters that produce DTCG trees:
// toDTCG (a single tree, default-mode values, every mode under $extensions) and toResolver (one tree
// per resolver set, values picked per mode). `pick` is the ONLY thing that varies — typing, the
// dimension/color/alias value shape, the reserved-key guard and the collision guards are shared, so a
// resolver set file and tokens.dtcg.json can never disagree about a token's $type or value form.
//
// `pick` returns SKIP when this particular tree deliberately does not carry the token (the resolver's
// per-mode dedup: unchanged-from-default). That is the ONE omission that is intentional rather than a
// loss, so it is the one that produces no warning; `undefined` still means "no value anywhere" and is
// reported. The value check runs BEFORE the group descent so a skipped token leaves no empty group
// behind in a context file.
// `opts` is the same bag toCSS takes (opts.unitless) — the px-vs-unitless decision for a FLOAT is made
// by the ONE unitDecision() every emitter shares, so tokens.dtcg.json, tokens.css and the resolver set
// files cannot disagree about which numbers are lengths.
const SKIP = Symbol("resolver-set omits this token");
type PickValue = (v: Variable) => VariableValue | undefined | typeof SKIP;
// The DTCG plan: a token's path is its name's segments; two variables that fold onto one path are
// disambiguated on the LAST segment (see planIds). Planned over the WHOLE variable list even when a
// resolver set file only holds one collection, because every set is merged into one namespace.
const DTCG_SEP = "\u0000";
function dtcgPlan(designSystem: TokensDoc | null | undefined): IdPlan {
  const ds: TokensDoc = designSystem || {};
  return planIds(ds.variables || [], (v) => { const p = segs(v.name); return p.length ? p.join(DTCG_SEP) : null; },
    (id, s) => id + "-" + s, ds.collections, "tokens.dtcg.json", (v) => !/[.{}$]/.test(String(v.name)));
}
function buildTree(designSystem: TokensDoc | null | undefined, warn: (m: string) => void, opts: EmitOpts | undefined, pick: PickValue, withExtensions: boolean, plan?: IdPlan): DtcgGroup {
  const root: DtcgGroup = {};
  const ds: TokensDoc = designSystem || {};
  const { colorProfile } = ds;
  plan = plan || dtcgPlan(designSystem);
  const ref = (referrer: Variable) => (name: string): string => {
    const t = aliasTargetId(plan, name, referrer, warn);
    return t ? "{" + t.id.split(DTCG_SEP).join(".") + "}" : dtcgRef(name);
  };
  for (const v of (designSystem && designSystem.variables) || []) {
    if (!segs(v.name).length) { warn(`variable with empty/degenerate name skipped: '${v.name}'`); continue; }
    if (!emitted(v)) { warn(`token '${v.name}' is a ${v.type} variable — its values are not colours, numbers or strings, so no DTCG token is emitted for it (skipped)`); continue; }
    const planned = plan.canonical.get(v);
    if (planned === undefined) continue; // the same variable twice, or an identical twin — emitted once, reported by planIds
    const path = planned.split(DTCG_SEP);
    // Reserved keys would let a token name walk into / write onto Object.prototype (prototype pollution)
    // — token maps are semi-trusted third-party dumps, so refuse them explicitly.
    if (path.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
      warn(`token '${v.name}' uses a reserved key (__proto__/constructor/prototype) — skipped`); continue;
    }
    const bv = pick(v);
    if (bv === SKIP) continue;
    if (bv === undefined) { warn(`token '${v.name}' has no value in any mode — skipped`); continue; }

    // Descend, guarding leaf/group collisions instead of clobbering or producing illegal nodes.
    let node: DtcgGroup = root, collided = false;
    for (const [i, seg] of path.slice(0, -1).entries()) {
      let child = node[seg];
      if (child === undefined) child = node[seg] = {};
      else if (isLeaf(child)) {
        warn(`token '${v.name}' collides with token '${path.slice(0, i + 1).join("/")}' (a name is used as both a value and a group) — skipped`);
        collided = true; break;
      }
      node = child;
    }
    if (collided) continue;
    const leafKey = path[path.length - 1] ?? ""; // ?? "": split() always returns at least one piece, so it never applies
    const existing = node[leafKey];
    if (existing !== undefined && !isLeaf(existing)) {
      warn(`token '${v.name}' collides with a group of the same name — skipped`); continue;
    }
    // planIds gave every distinct variable its own path, so an occupied leaf here can only be a
    // path that some OTHER name also reaches after sanitising (reported by planIds). Never overwrite.
    if (existing !== undefined) { warn(`token '${v.name}' lands on '${path.join("/")}', which another token already holds — skipped, nothing overwritten`); continue; }

    let type = DTCG_TYPE[v.type];
    if (v.type === "COLOR" && isHexish(bv) && !normHex(bv)) warn(`token '${v.name}' has malformed hex '${bv}'`);
    // A FLOAT that toCSS would emit with `px` IS a dimension; one it leaves unitless (opacity,
    // font-weight) stays a `number`.
    const dimension = v.type === "FLOAT" && unitDecision(v, opts) === "px";
    if (dimension) type = "dimension";
    // Figma composes COLOR values only; one on any other type would put a colour under a non-colour $type.
    if (isComposed(bv) && v.type !== "COLOR") { warn(`token '${v.name}' is a ${v.type} variable holding a composed colour value — skipped`); continue; }
    const aliasRef = ref(v);
    const dv = dtcgValue(webNumber(v, bv), colorProfile, dimension, aliasRef);
    if (dv === null) { warn(`token '${v.name}' has a non-scalar value ${JSON.stringify(bv)} — skipped`); continue; }
    let value = dv;
    if (v.type === "BOOLEAN") {
      // DTCG 2025.10 has no boolean type, and a token with no resolvable $type is INVALID. Coerce to a
      // string token ("true"/"false"); the origin is recorded under $extensions so it round-trips.
      type = "string";
      if (!isAlias(bv)) value = String(value);
      warn(`token '${v.name}' is BOOLEAN — DTCG has no boolean type; emitted as $type:"string" (origin kept in $extensions)`);
    }
    if (!type) { warn(`token '${v.name}' (type ${v.type}) maps to no DTCG $type — skipped (a typeless token is invalid per DTCG 2025.10)`); continue; }
    const leaf: DtcgLeaf = { $type: type, $value: value };
    if (v.description) leaf.$description = v.description;

    // A composed colour's opacity half travels with its $value in EVERY tree — a resolver set file
    // picks one mode's value, so without it that file would carry the colour and silently drop the opacity.
    const opacity = dtcgOpacity(bv, aliasRef);

    if (!withExtensions) { // resolver set files: modes live in the resolver
      // …and so does an opacity FLOAT's scale: a set's `sources` are ordinary DTCG token files
      // (designtokens.org/tr/2025.10/resolver/), so a set file's `number` must say it is Figma's 0–100
      // percentage exactly as tokens.dtcg.json does (same key, same value, same condition: percentOpacity).
      const setExt: DtcgFigmaExtension = {};
      if (opacity !== undefined) setExt.opacity = opacity;
      if (percentOpacity(v, opts)) setExt.unit = "percent";
      if (Object.keys(setExt).length) leaf.$extensions = { "figma.com": setExt };
      node[leafKey] = leaf; continue;
    }

    const values = v.values || {};
    const modeKeys = Object.keys(values);
    const ext: DtcgFigmaExtension = {};
    if (opacity !== undefined) ext.opacity = opacity;
    // Null-prototype: keyed by MODE NAMES, which are free-form designer strings (the Plugin API
    // documents no character/reserved-word restriction on addMode/renameMode) arriving via JSON.parse
    // — which, unlike an object literal, creates a REAL own "__proto__" key. On a plain object
    // `modes["__proto__"] = {...}` sets the prototype instead of an own key, so the mode vanished from
    // the emitted JSON with no warning. Same hardening as toDTCG's reserved-key guard on token NAMES.
    if (modeKeys.length > 1) { const modes: Record<string, DtcgLeafValue> = nullProto(); for (const m of modeKeys) { const mv = values[m] === undefined ? null : dtcgValue(webNumber(v, values[m]), colorProfile, dimension, aliasRef); if (mv !== null) modes[m] = mv; } ext.modes = modes; }
    // …and each composed mode's opacity half beside it (null-prototype for the same reason as `modes`).
    if (modeKeys.length > 1 && modeKeys.some((m) => isComposed(values[m]))) {
      const byMode: Record<string, DtcgOpacity> = nullProto();
      for (const m of modeKeys) { const o = dtcgOpacity(values[m], aliasRef); if (o !== undefined) byMode[m] = o; }
      ext.modeOpacity = byMode;
    }
    // The key is the variable's identity (the name is not unique — see planIds), so it travels with
    // the token: a consumer can always get back from an emitted name to the one Figma variable.
    if (typeof v.key === "string" && v.key) ext.key = v.key;
    if (isSentinel(v, bv)) ext.sentinel = { figmaValue: bv, meaning: "fully rounded — emitted as the platform idiom" };
    if (v.scopes && v.scopes.length) ext.scopes = v.scopes;
    // A `number` token says nothing about its scale; Figma's opacities are 0–100, not DTCG/CSS's 0–1.
    if (percentOpacity(v, opts)) ext.unit = "percent";
    if (v.codeSyntax && Object.keys(v.codeSyntax).length) ext.codeSyntax = v.codeSyntax;
    if (v.type === "BOOLEAN") ext.originalType = "boolean"; // marks a boolean coerced to a string token
    // Vendor key `figma.com` — the namespace the DTCG Resolver Module's own examples and Figma's native
    // export use (not the reverse-DNS `com.figma`). Modes are kept here as data-preserving metadata so
    // ONE file still carries everything; the spec-blessed portable theming mechanism is the Resolver
    // Module (per-mode files), emitted alongside by toResolver() — the two are kept in sync by the
    // shared buildTree/dtcgValue path, and the round-trip is asserted in test/design-to-code.test.ts.
    if (Object.keys(ext).length) leaf.$extensions = { "figma.com": ext };
    node[leafKey] = leaf;
  }
  return root;
}

// `notes` (internal): when given, name collisions are collected there as objects so emitTokens can
// report each colliding SET once across every output; otherwise they are formatted into `warnings`.
function toDTCG(designSystem: TokensDoc | null | undefined, warnings?: string[], opts?: EmitOpts, notes?: CollisionNote[]): DtcgGroup {
  const warn = (m: string): void => { if (warnings) warnings.push(m); };
  const collections = designSystem?.collections;
  const plan = dtcgPlan(designSystem);
  const tree = buildTree(designSystem, warn, opts, (v) => baseValue(v, collections), true, plan);
  if (notes) notes.push(...plan.notes);
  else for (const m of collisionMessages(plan.notes, opts)) warn(m);
  return tree;
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
function numberUnit(variable: Variable, opts?: UnitOpts): string {
  if (percentOpacity(variable, opts)) return "%";
  return unitDecision(variable, opts) === "px" ? "px" : "";
}
// Figma clamps an out-of-range opacity itself (Help Center,
// https://help.figma.com/hc/en-us/articles/14506821864087): "If the number variable has a negative
// value, the opacity will default to 0%. If the number variable has a value greater than 100, the
// opacity will default to 100%." The CSS does the same (and color-mix() REQUIRES 0%–100%); lintNames
// reports every clamp, and tokens.dtcg.json keeps the verbatim number. The clamp itself is color.ts
// clampOpacityPct — the one implementation every emitter and checker shares.
const pctOutOfRange = (n: number): boolean => n < 0 || n > 100;
// `s` is a number's CSS text ("40", "-5", "12.5"); in range it is kept verbatim.
const cssPercent = (s: string): string => (pctOutOfRange(Number(s)) ? String(clampOpacityPct(Number(s))) : s) + "%";
const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;
// Does v's custom property hold a percentage in EVERY mode? An opacity-scoped FLOAT whose values are
// numbers, or aliases to such a FLOAT (followed through the SAME plan the emitter named them with).
// A composed colour may only put `var(--x)` in color-mix()'s <percentage> slot when this holds —
// a `40px` or a bare `0.4` there makes the whole declaration invalid at computed-value time.
function cssPercentVar(plan: IdPlan, v: Variable | null, opts: UnitOpts | undefined, depth = 0): boolean {
  if (!v || depth > 8 || !percentOpacity(v, opts)) return false;
  const vals = Object.values(v.values || {}).filter((x) => x !== undefined);
  return vals.length > 0 && vals.every((x) => (isAlias(x)
    ? cssPercentVar(plan, aliasTarget(plan, x.aliasOf, v), opts, depth + 1)
    : typeof x === "number" || (typeof x === "string" && NUMERIC_TEXT.test(x))));
}

// A value -> CSS text. Reference -> var(); color -> hex; number -> `${n}${unit}` (a 0 length stays
// unitless; a percentage is clamped and always carries its `%`, so `0%` is still an <alpha-value> and a
// color-mix() percentage). `pctRef(name)`: does that alias target's custom property hold a percentage
// (cssPercentVar)? Without it, no opacity alias is trusted.
// Composed colour: the colour mixed with `transparent` at the opacity —
//   color-mix(in srgb, <var(--colour) | #hex> <N% | var(--opacity)>, transparent)
// color-mix() mixes in premultiplied alpha, so this keeps the colour's channels and multiplies its alpha
// by the opacity; MDN's own "adding transparency" example is exactly `color-mix(in srgb, var(--base)
// 25%, transparent)`, and it notes this works "even if the color is already non-opaque"
// (https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix). The <percentage> slot takes
// 0%–100%, which is why every opacity percentage here is clamped; `var(--opacity)` substitutes that
// token's `N%` (https://developer.mozilla.org/en-US/docs/Web/CSS/var — "instead of any part of a value").
// alpha × opacity/100 is an INFERENCE: Figma documents the 0–100 range but not how the opacity combines
// with a colour whose own alpha is < 1; multiplying is what every other alpha stack does.
// An opacity alias whose target is not a percentage (a px/bare FLOAT) leaves the colour half only —
// lintNames reports it (never silent).
function cssValue(raw: VariableValue, unit: string, ref?: (name: string) => string, pctRef?: (name: string) => boolean): string {
  if (isAlias(raw)) return "var(" + (ref ? ref(raw.aliasOf) : cssVarName(raw.aliasOf)) + ")";
  if (isComposed(raw)) {
    const { color, opacity } = raw.composed;
    const c = cssValue(color, "", ref);
    const pct = isAlias(opacity) ? (pctRef && pctRef(opacity.aliasOf) ? cssValue(opacity, "", ref) : null) : cssPercent(String(opacity));
    return pct === null ? c : `color-mix(in srgb, ${c} ${pct}, transparent)`;
  }
  const e = isHexish(raw) ? normHex(raw) : null;
  if (e) return e;
  const fmtNum = (s: string): string => (unit === "%" ? cssPercent(s) : s === "0" ? "0" : unit ? s + unit : s); // 0 stays unitless; String(0) === "0"
  if (typeof raw === "number") return fmtNum(String(raw));
  if (typeof raw === "string" && NUMERIC_TEXT.test(raw)) return fmtNum(raw); // string-number FLOAT
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "string") return cssEscapeText(raw); // arbitrary STRING token -> escape CSS breakout chars
  return String(raw);
}

// The tokens.css plan: one custom property per distinct variable (see planIds).
function cssPlan(designSystem: TokensDoc | null | undefined): IdPlan {
  const ds: TokensDoc = designSystem || {};
  return planIds(ds.variables || [], (v) => (segs(v.name).length ? cssVarName(v.name) : null), (id, s) => id + "-" + s, ds.collections, "tokens.css",
    (v) => cssVarName(v.name) === "--" + segs(v.name).join("-"));
}

// --- non-default modes: one block per (collection, mode) -----------------------------------------
// Figma selects a mode PER COLLECTION. Keying the blocks by mode NAME alone flipped every collection that
// has a "Dark" at once (DT-24 / D15). So lines are grouped by (collection, mode). A mode name only one
// collection has a block for keeps the plain `[data-theme="<mode>"]` (the usual single-theme file is
// unchanged); when two or more collections have a block for the same name, each gets
// `[data-theme-<collection slug>="<mode>"]`, a slug two collections share gets `-<first 8 of its key>`,
// and ONE warning per clashing name says which attributes to set.
/** What a block's selector is scoped by — handed to opts.selector. */
export interface ModeScope { collection: string | undefined; attribute: string }
interface ModeScopePlan {
  groupOf: (v: Variable) => string;
  scope: (group: string, mode: string) => ModeScope;
  warnings: string[];
}
// Which collection a variable belongs to. Variables carry only the collection NAME, and real exports have
// two collections of one name (a single-mode "Spacing" and a Desktop/Tablet/Mobile "Spacing"): among
// same-named collections, the one declaring every mode the variable has values for.
// Limit: two same-named collections with the SAME mode list cannot be told apart (no collection key on a
// variable) — their variables all land in the first one.
function collectionOf(v: Variable, collections: readonly VariableCollection[]): VariableCollection | undefined {
  const named = collections.filter((c) => c.name === v.collection);
  if (named.length <= 1) return named[0];
  const modes = Object.keys(v.values || {});
  return named.find((c) => modes.every((m) => (c.modes || []).includes(m))) ?? named[0];
}
// The (collection, mode) pairs that emit a block: exactly the condition toCSS/toTailwind emit a line on
// (a defined, non-default value that differs from the emitted base). theme.css plans off the same list
// as tokens.css, so the two files always agree on every block's selector.
function planModeScopes(designSystem: TokensDoc | null | undefined): ModeScopePlan {
  const collections = (designSystem && designSystem.collections) || [];
  const vars = (designSystem && designSystem.variables) || [];
  const groupIds = new Map<VariableCollection, string>();
  collections.forEach((c, i) => groupIds.set(c, "c" + i));
  const groupOf = (v: Variable): string => { const c = collectionOf(v, collections); return c ? groupIds.get(c) ?? "" : ""; };
  const collOfGroup = new Map<string, VariableCollection>();
  for (const [c, id] of groupIds) collOfGroup.set(id, c);
  const groupsPerMode = new Map<string, string[]>();
  // Shared = DECLARED by several collections (each collection's modes minus its default), not "has a
  // differing value today": otherwise one designer edit to a value flips the next pull from
  // [data-theme="Dark"] to [data-theme-<collection>="Dark"] with no change to the modes. A collection
  // counts once it has ANY emittable variable — whichever record tokens.css's or theme.css's plan keeps
  // as canonical, its group is in this list, so neither file can fall back to a bare selector for it.
  // The no-collection group ("") declares the non-default modes its variables have values for.
  const declared = (g: string, v: Variable): string[] => {
    const c = collOfGroup.get(g);
    if (c) { const def = c.default ?? (c.modes || [])[0]; return (c.modes || []).filter((m) => m !== def); }
    const def = defaultModeName(v, collections);
    return Object.keys(v.values || {}).filter((m) => m !== def);
  };
  for (const v of vars) {
    if (!segs(v.name).length || !emitted(v)) continue;
    if (baseValue(v, collections) === undefined) continue;
    const g = groupOf(v);
    for (const m of declared(g, v)) {
      const list = getOrInit(groupsPerMode, m, () => []);
      if (!list.includes(g)) list.push(g);
    }
  }
  // One attribute per collection that is ever qualified, the same for all its modes.
  const qualified = new Set<string>();
  for (const list of groupsPerMode.values()) if (list.length > 1) for (const g of list) qualified.add(g);
  const nameOf = (g: string): string | undefined => collOfGroup.get(g)?.name;
  const slugOf = (g: string): string => suffixSlug(nameOf(g) ?? "no collection") || "collection";
  const slugCount = new Map<string, number>();
  for (const g of qualified) slugCount.set(slugOf(g), (slugCount.get(slugOf(g)) ?? 0) + 1);
  const attrOf = new Map<string, string>();
  const used = new Set<string>();
  for (const g of qualified) {
    const slug = slugOf(g);
    const key = collOfGroup.get(g)?.key;
    let attr = "data-theme-" + slug + ((slugCount.get(slug) ?? 0) > 1 && key ? "-" + suffixSlug(key.slice(0, KEY_SUFFIX_LEN)) : "");
    for (let n = 2; used.has(attr); n++) attr = "data-theme-" + slug + "-" + n; // no key to tell them apart
    used.add(attr);
    attrOf.set(g, attr);
  }
  const warnings: string[] = [];
  for (const [m, list] of groupsPerMode) {
    if (list.length < 2) continue;
    const label = (g: string): string => nameOf(g) ?? "(no collection)";
    warnings.push(`mode '${m}' exists in ${list.length} collections (${list.map(label).join(", ")}); their blocks are scoped per collection instead of [data-theme="${m}"]: set ${list.map((g) => `${attrOf.get(g) ?? "data-theme"}="${m}"`).join(" / ")} on the element that picks each collection's mode`);
  }
  const scope = (g: string, m: string): ModeScope => {
    const list = groupsPerMode.get(m) || [];
    return { collection: nameOf(g), attribute: list.length > 1 ? attrOf.get(g) ?? "data-theme" : "data-theme" };
  };
  return { groupOf, scope, warnings };
}
/** Non-default-mode lines, grouped by (collection, mode) in first-seen order. */
interface ModeBlocks { set: (v: Variable, mode: string, prop: string, line: string) => void; render: (selector?: EmitOpts["selector"]) => string }
function modeBlocks(plan: ModeScopePlan): ModeBlocks {
  const blocks = new Map<string, { group: string; mode: string; lines: Map<string, string> }>();
  return {
    set(v, mode, prop, line) {
      const group = plan.groupOf(v);
      getOrInit(blocks, group + "\u0000" + mode, () => ({ group, mode, lines: new Map<string, string>() })).lines.set(prop, line);
    },
    render(selector) {
      let out = "";
      for (const b of blocks.values()) {
        const sc = plan.scope(b.group, b.mode);
        out += `\n${selector ? selector(b.mode, sc) : `[${sc.attribute}="${cssAttrEscape(b.mode)}"]`} {\n` + [...b.lines.values()].join("\n") + "\n}\n";
      }
      return out;
    },
  };
}

// `notes` (internal): see toDTCG.
function toCSS(designSystem: TokensDoc | null | undefined, opts?: EmitOpts, notes?: CollisionNote[]): string {
  const collections = (designSystem && designSystem.collections) || [];
  const vars = (designSystem && designSystem.variables) || [];

  // Keyed by custom-property NAME, not pushed as lines. Two records of the SAME variable, or two
  // variables that resolve identically in every mode (seen live: three "Schemes/On Primary" with
  // distinct keys, 22 copies of one declaration), emit ONE declaration. Two variables that fold onto
  // one property and DIFFER each get their own property (planIds) — the browser's "last one wins"
  // is exactly the silent overwrite that shipped `--spacing-space-4: 16px` (livetest-3 #44).
  const plan = cssPlan(designSystem);
  if (notes) notes.push(...plan.notes);
  const ref = (referrer: Variable) => (name: string): string => { const t = aliasTargetId(plan, name, referrer); return t ? t.id : cssVarName(name); };
  const pctRef = (referrer: Variable) => (name: string): boolean => cssPercentVar(plan, aliasTarget(plan, name, referrer), opts);
  const rootLines = new Map<string, string>();
  // A Map keyed by (collection, mode), never a plain object: mode names are free-form designer strings
  // reaching us through JSON.parse, and a mode literally named "__proto__" once resolved to
  // Object.prototype on a plain object and crashed the CLI half-way through writing its outputs.
  const perMode = modeBlocks(planModeScopes(designSystem));
  for (const v of vars) {
    if (!segs(v.name).length) continue; // skip empty names (would emit invalid `--:`)
    if (!emitted(v)) continue; // EASING/TIMING: no CSS value (toDTCG reports the skip)
    const varName = plan.canonical.get(v);
    if (varName === undefined) continue;
    const values = v.values || {};
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === undefined) continue; // never emit `--x: undefined;`
    const baseStr = JSON.stringify(base); // hoisted: base is invariant across the mode loop below
    const unit = numberUnit(v, opts);
    const r = ref(v), p = pctRef(v);
    // A font-family STRING (the same test theme.css uses) is written as a font-family value, quoted when
    // it is not one identifier — `font-family: var(--Heading)` must not get `Inter Display 2` bare.
    const font = v.type === "STRING" && twKind(v, opts) === "fontFamily";
    const val = (raw: VariableValue): string => (font && typeof raw === "string" ? cssFontFamily(raw) : cssValue(webNumber(v, raw), unit, r, p));
    rootLines.set(varName, `  ${varName}: ${val(base)};`);
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === undefined) continue;
      if (JSON.stringify(values[m]) === baseStr) continue; // dedup vs the EMITTED base (handles undefined-default)
      perMode.set(v, m, varName, `  ${varName}: ${val(values[m])};`);
    }
  }
  const out = rootLines.size ? ":root {\n" + [...rootLines.values()].join("\n") + "\n}\n" : "";
  return out + perMode.render(opts && opts.selector);
}

// --- Tailwind v4 theme ------------------------------------------------------------------------
//
// Why this exists (live run #18): `--native <profile>` gives a native project ONE checked-in token
// file every screen imports. A web project had no equivalent — tokens.css is plain custom properties,
// which Tailwind does not turn into utilities, so the builder hand-wrote an `@theme` block from the
// bound token names and pasted the hexes into the plan's allowedLiterals. Two screens built in
// separate sessions would then disagree about what `--color-primary` is called. Same fix as native:
// generate it once.
//
// Tailwind v4 generates a utility from a theme variable's NAMESPACE (tailwindcss.com/docs/theme):
// `--color-*` -> bg-/text-/border-, `--spacing-*` -> p-/m-/gap-, `--radius-*` -> rounded-,
// `--text-*` -> text-<size>, `--font-*` -> font-. So a Figma variable has to be filed under the right
// namespace or it produces a custom property nobody can reach from a class. A FLOAT that carries no
// unit (opacity, font-weight) matches no Tailwind namespace at all; it is still emitted, so `var(--x)`
// works, but it generates no utility — which is the honest outcome, not a silent drop.
//
// Every generated variable sits under a `figma-` sub-namespace (`--radius-figma-xl`, `--spacing-
// figma-space-4`, `--color-figma-primary-primary`), because Tailwind v4's own scale lives in the SAME
// namespaces and an `@theme` variable of the same name REPLACES it. Figma's `XL` radius emitted as
// `--radius-xl: 16px` silently redefined the framework's `rounded-xl` (12px) in every project pulled
// through this tool, and `--radius-l`/`--radius-s` minted `rounded-l`/`rounded-s`, which Tailwind
// already defines as the LEFT/START-corner shorthands (livetest-3 #183). Figma names are free-form, so
// no finite list of Tailwind's defaults (`xl`, `4`, `full`, `red-500`, `sans`, a bare `--spacing`)
// can be relied on; one prefix makes a collision impossible and every design-system utility greppable.
//
// Modes: `@theme` cannot be nested in a selector, so the default mode's values live there and every
// other mode reassigns the SAME custom properties in a plain `[data-theme="…"]` block (per collection
// when the name is shared — the same planModeScopes selectors as tokens.css). Tailwind's
// generated utilities read `var(--color-…)`, so they follow the override with no extra work.
type TwKind = "color" | "dimension" | "radius" | "fontSize" | "fontFamily";
const TW_NAMESPACE: Record<TwKind, string> = { color: "--color-", dimension: "--spacing-", radius: "--radius-", fontSize: "--text-", fontFamily: "--font-" };
const TW_PREFIX = "figma-";

// The Tailwind key for a token name: kebab-case, lowercased, from the SAME segs() every other
// emitter uses, so `--color-figma-schemes-on-primary` and the DTCG `schemes.on.primary` describe one token.
function twSlug(name: string): string {
  const slug = segs(name).join("-").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug || "token";
}
function twName(v: Variable, opts?: EmitOpts): string {
  const kind = twKind(v, opts);
  return (kind ? TW_NAMESPACE[kind] : "--") + TW_PREFIX + twSlug(v.name);
}

const RADIUS_SCOPES = new Set(["CORNER_RADIUS"]);
function twKind(v: Variable, opts?: EmitOpts): TwKind | null {
  if (v.type === "COLOR") return "color";
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  // DT-24: the scope is the designer's own statement — a FONT_FAMILY-scoped STRING is a font family
  // whatever it is called ("Heading" in a "Type" collection). The name is only a fallback when the scopes
  // say nothing (ALL_SCOPES / none); a STRING narrowed to anything else (FONT_STYLE: "Semi Bold") is not one.
  if (v.type === "STRING") {
    if (narrowed) return scopes.includes("FONT_FAMILY") ? "fontFamily" : null;
    return /font.?family|typeface/i.test((v.collection ?? "") + "/" + v.name) ? "fontFamily" : null;
  }
  if (v.type !== "FLOAT") return null;
  if (unitDecision(v, opts) !== "px") return null; // unitless: opacity/weight — no Tailwind namespace fits
  if (narrowed && scopes.some((x) => RADIUS_SCOPES.has(x))) return "radius";
  if (narrowed && scopes.includes("FONT_SIZE")) return "fontSize";
  if (!narrowed && /radius|corner|rounded/i.test(v.name)) return "radius";
  if (!narrowed && /font.?size|text.?size|type.?size/i.test((v.collection ?? "") + "/" + v.name)) return "fontSize";
  return "dimension";
}

// A font family as a font-family VALUE: a family name that is not a single identifier ("Open Sans",
// "Inter Display 2") is quoted — unquoted, a name with a digit-led word is invalid and one with spaces
// only survives by accident of the identifier rules (CSS Fonts 4 §2.1.1: "Font family names that happen
// to be the same as a keyword value … must be quoted"; names with whitespace SHOULD be). A value that is
// already a list or already quoted ("Inter, sans-serif", "'Inter'") is the designer's CSS, left as is.
function cssFontFamily(raw: string): string {
  const s = raw.trim();
  if (!s || /[,'"]/.test(s) || /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(s)) return cssEscapeText(raw);
  return '"' + s.replace(/["\\\n\r\f]/g, hexEsc) + '"';
}

// → { text, utilities, tokens, warnings[] }. `warnings` carries the name collisions (the slug folds
// case and punctuation, so `Space 3` and `(Space 3)` land on one Tailwind name even though tokens.css
// kept them apart) unless the internal `notes` array is passed, as emitTokens does — plus the STRING
// tokens left out of theme.css and the per-collection mode scoping (both always).
function toTailwind(designSystem: TokensDoc | null | undefined, opts?: EmitOpts, notes?: CollisionNote[]): TailwindResult {
  const collections = (designSystem && designSystem.collections) || [];
  const vars = (designSystem && designSystem.variables) || [];
  const plan = planIds(vars, (v) => (segs(v.name).length ? twName(v, opts) : null), (id, s) => id + "-" + s, collections, "theme.css",
    (v) => /^[A-Za-z0-9-]+$/.test(segs(v.name).join("-")));
  const warnings: string[] = [];
  if (notes) notes.push(...plan.notes);
  else warnings.push(...collisionMessages(plan.notes, opts));
  const theme = new Map<string, string>();
  const scopes = planModeScopes(designSystem);
  const perMode = modeBlocks(scopes); // the same (collection, mode) selectors as tokens.css
  warnings.push(...scopes.warnings);
  // DT-24: a STRING that is not a font family ("Semi Bold", a label) is not a usable value in @theme and
  // earns no utility, so it is left out — unless a font-family token aliases it (then the var() must resolve).
  const aliasedByFont = new Set<Variable>();
  // The whole alias chain: a kept STRING that itself aliases another STRING keeps that one too.
  const queue = vars.filter((v) => v.type === "STRING" && twKind(v, opts) === "fontFamily");
  for (let v = queue.pop(); v !== undefined; v = queue.pop()) {
    for (const m of Object.keys(v.values || {})) for (const n of aliasNames(v.values[m])) {
      const t = aliasTarget(plan, n, v);
      if (t && !aliasedByFont.has(t)) { aliasedByFont.add(t); queue.push(t); }
    }
  }
  const leftOut: string[] = [];
  let utilities = 0;
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    if (!emitted(v)) continue; // EASING/TIMING: no CSS value (toDTCG reports the skip)
    const name = plan.canonical.get(v);
    if (name === undefined) continue;
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === undefined) continue;
    const kind = twKind(v, opts);
    if (v.type === "STRING" && !kind && !aliasedByFont.has(v)) { if (!leftOut.includes(v.name)) leftOut.push(v.name); continue; }
    if (kind) utilities++;
    const unit = numberUnit(v, opts);
    // An alias must point at the TAILWIND name of its target (its own namespace, its own
    // disambiguated name), not the tokens.css one.
    const ref = (n: string): string => { const t = aliasTargetId(plan, n, v); return t ? t.id : "--" + TW_PREFIX + twSlug(n); };
    const pctRef = (n: string): boolean => cssPercentVar(plan, aliasTarget(plan, n, v), opts);
    const val = (raw: VariableValue): string => (kind === "fontFamily" && typeof raw === "string" ? cssFontFamily(raw) : cssValue(webNumber(v, raw), unit, ref, pctRef));
    const baseStr = JSON.stringify(base);
    theme.set(name, `  ${name}: ${val(base)};`);
    const values = v.values || {};
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === undefined) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      perMode.set(v, m, name, `  ${name}: ${val(values[m])};`);
    }
  }
  if (leftOut.length) {
    warnings.push(`theme.css leaves out ${leftOut.length} STRING token(s) that are not font families (${leftOut.slice(0, 4).map((n) => `'${n}'`).join(", ")}${leftOut.length > 4 ? `, … +${leftOut.length - 4} more` : ""}) — ` +
      "a value like 'Semi Bold' is not usable in @theme and generates no utility. They are kept in tokens.dtcg.json and tokens.css (written with --also-generic); scope a font-family STRING to FONT_FAMILY in Figma to get a --font-figma-* utility");
  }
  let out = '@import "tailwindcss";\n' +
    "/* GENERATED by Design Twin (tokens.js --web tailwind) — do not edit by hand; re-run after a token pull.\n" +
    "   Every design-system variable sits under a `figma-` name (rounded-figma-xl, p-figma-space-4, bg-figma-…),\n" +
    "   so Tailwind's own scale (rounded-xl, p-4, …) keeps its framework meaning. */\n";
  if (theme.size) out += "\n@theme {\n" + [...theme.values()].join("\n") + "\n}\n";
  out += perMode.render();
  return { text: out, utilities, tokens: theme.size, warnings };
}

// --- DTCG Resolver Module (2025.10) -------------------------------------------------------------
// The spec (designtokens.org/tr/2025.10/resolver/) in the sentences this mapping rests on:
//   · "The document MUST provide a version at the root level, and it MUST be `2025.10`."
//   · `resolutionOrder` is the other REQUIRED root key; `name`/`description`/`sets`/`modifiers`/
//     `$schema` are all optional ("MAY").
//   · "A set MUST contain a `sources` array with tokens declared directly, or a reference object
//     pointing to a JSON file containing design tokens, or any combination of the two." Sources merge
//     in array order, last occurrence wins.
//   · "A modifier MUST declare a `contexts` map of a `string` value to an array of token sources." It
//     "SHOULD have two or more contexts, since one is the equivalent of a set" and "MUST NOT have an
//     empty contexts map". Contexts MAY be empty ARRAYS (the spec's own `"false": []` example).
//   · "A modifier MAY declare a `default` value that MUST match one of the keys in `contexts`."
//   · resolutionOrder: "The order is significant, with tokens later in the array overriding any
//     tokens that came before them, in case of conflict."
//   · A reference object is `{ "$ref": <RFC6901 JSON pointer / relative URI> }`; only resolutionOrder
//     may reference a modifier, and sets/modifiers MUST NOT reference another modifier.
//   · "Users SHOULD use the '.resolver.json' file extension to name resolver documents."
//
// The Figma mapping, chosen to be the most conservative reading of the above:
//   collection            -> one SET holding that collection's DEFAULT-mode values (a file $ref).
//   collection with >1 mode -> additionally one MODIFIER named after the collection, whose contexts
//                           are its mode names and whose `default` is the collection's default mode.
//                           A context's file carries ONLY the tokens whose value differs from the
//                           default mode (exactly toCSS's dedup, JSON-equality against the EMITTED
//                           base) — so resolution = base set then context override, which is what
//                           "later in the array overrides" gives us. The default mode therefore
//                           differs in nothing and gets the empty array, no file.
//   single-mode collection -> set only, no modifier (the spec says one context "is the equivalent of
//                           a set", and tools SHOULD error on a 1-context modifier).
//   resolutionOrder       -> every set, then every modifier. Sets are unconditional foundations;
//                           modifiers must be able to override them.
// Nothing here resolves aliases: "Aliases MUST NOT be resolved until this step" (after ordering), so
// `{a.b}` references are passed through verbatim, same as toDTCG.
const RESOLVER_VERSION = "2025.10";
const RESOLVER_SCHEMA = "https://www.designtokens.org/schemas/2025.10/resolver.json";
const RESOLVER_DIR = "tokens"; // set files live in <outDir>/tokens/, the resolver doc in <outDir>/

// RFC6901: `~` and `/` are the two characters a JSON pointer token must escape. Collection names are
// designer-supplied and routinely contain `/`, which would otherwise silently re-point the reference
// at a nested key that does not exist.
const ptrEsc = (s: string): string => String(s).replace(/~/g, "~0").replace(/\//g, "~1");

// File names come from DESIGNER-supplied collection/mode names, which may contain anything: spaces,
// `/`, `..`, emoji, leading dots. Fold to [a-z0-9._-] so a name can never escape <outDir>/tokens/ nor
// hide a file from a shell. Lowercased deliberately: "Light" and "light" are two names but ONE file on
// a case-insensitive filesystem (macOS APFS default), so folding case makes that collision visible to
// the collision check below instead of letting one mode silently overwrite the other.
function fileSlug(s: string | null | undefined, fallback: string): string {
  const out = String(s == null ? "" : s).trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return out || fallback;
}

function toResolver(designSystem: TokensDoc | null | undefined, warnings?: string[], opts?: EmitOpts): { resolver: ResolverDoc; files: Record<string, DtcgGroup> } {
  // Dedupe against warnings ALREADY collected (emitTokens shares one array with toDTCG): every token
  // problem toDTCG reports is re-derived here, once per set the token appears in. Reporting the same
  // sentence three times is noise, not evidence — but a NEW problem (a filename collision) still gets
  // through, so the never-silent guarantee holds.
  const seen = new Set(warnings || []);
  const warn = (m: string): void => { if (warnings && !seen.has(m)) { seen.add(m); warnings.push(m); } };

  const ds: TokensDoc = designSystem || {};
  const collections = ds.collections || [];
  const vars = ds.variables || [];

  // Group variables by collection NAME — that is what Variable.collection carries. A Map, not an
  // object: the keys are designer strings (`__proto__` is a legal collection name).
  const groups = new Map<string, Variable[]>();
  for (const v of vars) {
    const key = String((v && v.collection) || "");
    getOrInit(groups, key, () => []).push(v);
  }
  const declared = new Map<string, VariableCollection>();
  for (const c of collections) if (c && c.name != null && !declared.has(String(c.name))) declared.set(String(c.name), c);
  // ONE plan over every variable: resolver sets are merged into one token namespace, so a set file
  // must use exactly the (disambiguated) paths tokens.dtcg.json uses. Its notes are toDTCG's to report.
  const plan = dtcgPlan(ds);

  // Reserve every emitted path case-insensitively; a sanitized name that lands on a taken path is
  // disambiguated with -2/-3 and REPORTED, never silently overwritten.
  const takenFiles = new Map<string, string>();
  function reserveFile(base: string, ext: string, owner: string): string {
    let candidate = `${RESOLVER_DIR}/${base}${ext}`, n = 1;
    while (takenFiles.has(candidate.toLowerCase())) {
      n += 1;
      const next = `${RESOLVER_DIR}/${base}-${n}${ext}`;
      warn(`resolver file '${candidate}' for ${owner} collides with ${takenFiles.get(candidate.toLowerCase())} after sanitizing the name — wrote '${next}' instead`);
      candidate = next;
    }
    takenFiles.set(candidate.toLowerCase(), owner);
    return candidate;
  }
  // Same rule for the `sets`/`modifiers` map keys, which are JSON-pointer targets: a duplicate key
  // would drop a whole set. The two namespaces are SEPARATE — per the spec's own editorial note, "it
  // is valid for a set to share a name with a modifier"; only duplicates inside one map (or inside
  // resolutionOrder, which we never write inline) are invalid.
  const takenKeys: Record<"set" | "modifier", Set<string>> = { set: new Set(), modifier: new Set() };
  function reserveKey(name: string, kind: "set" | "modifier"): string {
    let candidate = name, n = 1;
    while (takenKeys[kind].has(candidate)) { n += 1; const next = `${name} ${n}`; warn(`resolver ${kind} name '${candidate}' is already used — renamed to '${next}'`); candidate = next; }
    takenKeys[kind].add(candidate);
    return candidate;
  }

  // Null-prototype: keyed by COLLECTION NAMES / MODE NAMES, free-form designer strings arriving via
  // JSON.parse — which creates a real own "__proto__" key that a plain object would turn into a
  // prototype write (the mode silently vanishes). Same hardening as toDTCG/toCSS.
  const sets: Record<string, ResolverSet> = nullProto();
  const modifiers: Record<string, ResolverModifier> = nullProto();
  const files: Record<string, DtcgGroup> = nullProto();
  const resolutionOrder: ResolverRef[] = [];
  const modifierRefs: ResolverRef[] = [];

  for (const [collName, groupVars] of groups) {
    const c = declared.get(collName);
    const label = collName || "tokens"; // variables with no collection still need a set name
    const sub: TokensDoc = { ...ifDefined("colorProfile", ds.colorProfile), collections, variables: groupVars };

    // Base set: the SAME values toDTCG puts in $value (baseValue), so the two outputs agree by
    // construction rather than by two parallel implementations.
    const base = buildTree(sub, warn, opts, (v) => baseValue(v, collections), false, plan);
    if (!Object.keys(base).length) continue; // every token in the collection was skipped + reported

    const setName = reserveKey(label, "set");
    const setFile = reserveFile(fileSlug(label, "tokens"), ".json", `set '${label}'`);
    files[setFile] = base;
    sets[setName] = { description: `${label} (default mode values)`, sources: [{ $ref: setFile }], $extensions: { "figma.com": { collection: collName || null } } };
    resolutionOrder.push({ $ref: `#/sets/${ptrEsc(setName)}` });

    // Modes: the collection's declaration, plus any mode that only shows up in a variable's values
    // (the declaration can lag a per-variable dump). Union, so no mode is lost.
    const modes: string[] = [];
    for (const m of (c && c.modes) || []) if (!modes.includes(m)) modes.push(m);
    for (const v of groupVars) for (const m of Object.keys((v && v.values) || {})) if (!modes.includes(m)) modes.push(m);
    if (modes.length < 2) continue; // one context "is the equivalent of a set" — emit no modifier

    const contexts: Record<string, ResolverRef[]> = nullProto();
    let nonEmpty = 0;
    for (const m of modes) {
      // Per-VARIABLE default mode + dedup, mirroring toCSS exactly: compare against the value actually
      // emitted into the base set (baseValue), not against collection.default, so a variable missing
      // the collection's default mode still dedupes against what it really shipped.
      const tree = buildTree(sub, warn, opts, (v) => {
        const values = (v && v.values) || {};
        const def = defaultModeName(v, collections);
        if (m === def || values[m] === undefined) return SKIP;
        const bv = baseValue(v, collections, def);
        return JSON.stringify(values[m]) === JSON.stringify(bv) ? SKIP : values[m];
      }, false, plan);
      if (!Object.keys(tree).length) { contexts[m] = []; continue; } // spec allows an empty context array
      const file = reserveFile(`${fileSlug(label, "tokens")}.${fileSlug(m, "mode")}`, ".json", `collection '${label}' mode '${m}'`);
      files[file] = tree;
      contexts[m] = [{ $ref: file }];
      nonEmpty += 1;
    }
    if (!nonEmpty) continue; // every mode was identical to the default — a modifier would resolve to nothing

    const modName = reserveKey(label, "modifier");
    // ?? "": modes has at least two entries here (the `modes.length < 2` continue above), so it never applies
    const def = c && c.default != null && modes.includes(c.default) ? c.default : (modes[0] ?? "");
    modifiers[modName] = { description: `${label} mode`, contexts, default: def, $extensions: { "figma.com": { collection: collName || null, defaultMode: def } } };
    modifierRefs.push({ $ref: `#/modifiers/${ptrEsc(modName)}` });
  }

  // Modifiers last: they exist to override the unconditional sets, and "tokens later in the array
  // override any tokens that came before them".
  for (const r of modifierRefs) resolutionOrder.push(r);

  const resolver: ResolverDoc = {
    $schema: RESOLVER_SCHEMA,
    ...(ds.file ? { name: String(ds.file) } : {}), // optional, but the filename alone rarely says which Figma file
    version: RESOLVER_VERSION, // REQUIRED, MUST be "2025.10"
    sets,
    ...(Object.keys(modifiers).length ? { modifiers } : {}), // omitted rather than empty: nothing to condition on
    resolutionOrder, // REQUIRED
  };
  return { resolver, files };
}

// Never-silent guarantee: every problem the emitters guard against is also reported here so a caller
// can surface it (mirrors the extractor's manifest.warnings discipline).
// `opts` is the SAME object you pass to toCSS. It has to be, because the name-heuristic warning below
// only makes sense for tokens the heuristic actually decided — and `opts.unitless` pre-empts it in
// numberUnit. Linting with different opts than you emitted with reports guesses that were never made.
// Same two warning sources emitTokens uses (toDTCG + lintNames) — toCSS contributes none, so a
// lint-only caller must not pay for building and discarding the whole stylesheet.
function lintTokens(designSystem: TokensDoc | null | undefined, opts?: EmitOpts): string[] {
  const warnings: string[] = [];
  const notes: CollisionNote[] = [];
  toDTCG(designSystem, warnings, opts, notes);
  notes.push(...cssPlan(designSystem).notes);
  warnings.push(...collisionMessages(notes, opts));
  lintNames(designSystem, opts, warnings);
  return dedupe(warnings);
}
const dedupe = <T>(list: readonly T[]): T[] => [...new Set(list)];

// The half of the lint that does NOT come from toDTCG. Split out so emitTokens can lint off the
// warnings toDTCG already collected instead of building the whole DTCG tree a second time.
// DT-24: the CSS file(s) the caller writes, as a warning names them — theme.css alone under `--web
// tailwind` (tokens.css is not written then), tokens.css by default, both with --also-generic.
function cssFilesOf(opts: EmitOpts | undefined): string[] {
  return opts && opts.cssFiles ? [...opts.cssFiles] : opts && opts.tailwind ? ["tokens.css", "theme.css"] : ["tokens.css"];
}
function lintNames(designSystem: TokensDoc | null | undefined, opts: EmitOpts | undefined, warnings: string[]): string[] {
  const vars = (designSystem && designSystem.variables) || [];
  const files = cssFilesOf(opts);
  const inCss = files.join("/") || "the CSS";
  // Several collections with a block for one mode name: scoped per collection (planModeScopes).
  warnings.push(...planModeScopes(designSystem).warnings);
  // Dangling aliases: an aliasOf whose target isn't a defined token.
  const names = new Set(vars.map((v) => segs(v.name).join(".")).filter(Boolean));
  for (const v of vars) for (const m of Object.keys(v.values || {})) {
    // A composed colour's nested alias(es) dangle exactly like a top-level one.
    for (const target of aliasNames(v.values[m])) {
      if (!names.has(segs(target).join("."))) warnings.push(`token '${v.name}' (mode ${m}) references undefined token '${target}'`);
    }
  }
  // Composed colours: tokens.css / theme.css write color-mix(); only an opacity alias whose target's
  // CSS is not a percentage falls back to the colour half (see cssValue). Same plan + test as toCSS.
  let plan: IdPlan | null = null;
  for (const v of vars) {
    if (v.type !== "COLOR") continue;
    for (const m of Object.keys(v.values || {})) {
      const raw = v.values[m];
      if (!isComposed(raw)) continue;
      const { opacity } = raw.composed;
      if (isAlias(opacity)) {
        plan = plan || cssPlan(designSystem);
        if (!cssPercentVar(plan, aliasTarget(plan, opacity.aliasOf, v), opts)) {
          warnings.push(`token '${v.name}' (mode ${m}) is a composed colour whose opacity '${opacity.aliasOf}' is not an OPACITY/COLOR_OPACITY-scoped number (its CSS is not a percentage); ${inCss} carr${files.length > 1 ? "y" : "ies"} the colour only — the opacity is in tokens.dtcg.json $extensions["figma.com"]`);
          break;
        }
      } else if (pctOutOfRange(opacity)) {
        warnings.push(`token '${v.name}' (mode ${m}) is a composed colour with opacity ${opacity}, outside Figma's 0–100 range; clamped to ${clampOpacityPct(opacity)}% in ${inCss} (as Figma does); tokens.dtcg.json keeps ${opacity}`);
      }
    }
  }
  // Opacity FLOATs outside 0–100: clamped in the CSS exactly as Figma clamps them (see clampOpacityPct in color.ts).
  for (const v of vars) {
    if (!percentOpacity(v, opts)) continue;
    for (const m of Object.keys(v.values || {})) {
      const raw = v.values[m];
      const txt = typeof raw === "number" ? String(raw) : typeof raw === "string" && NUMERIC_TEXT.test(raw) ? raw : null;
      if (txt !== null && pctOutOfRange(Number(txt))) warnings.push(`token '${v.name}' (mode ${m}) is an opacity of ${txt}, outside Figma's 0–100 range; clamped to ${clampOpacityPct(Number(txt))}% in ${inCss} (as Figma does); tokens.dtcg.json keeps ${txt}`);
    }
  }
  // STRING tokens carrying CSS-structural characters are emitted escaped (see cssEscapeText) — report
  // so the author knows the value was rewritten rather than passed through verbatim. cssNeedsEscape
  // runs the escaper itself, so terminators, comment delimiters and unbalanced parens/quotes are ALL
  // reported by construction — the detector cannot be narrower than the rewrite.
  for (const v of vars) {
    if (v.type !== "STRING") continue;
    for (const m of Object.keys(v.values || {})) {
      if (cssNeedsEscape(v.values[m])) { warnings.push(`token '${v.name}' (mode ${m}) contains CSS-structural characters; escaped for safety in ${inCss}`); break; }
    }
  }
  // Mode names that had to be escaped to stay inside their `[data-theme="…"]` selector. Same
  // never-silent rule as the value escaper: if we rewrote it, say so. Collected from both the
  // collection declarations and the per-variable value maps, since either can name a mode.
  const modeNames = new Set<string>();
  for (const c of (designSystem && designSystem.collections) || []) for (const m of c.modes || []) modeNames.add(m);
  for (const v of vars) for (const m of Object.keys(v.values || {})) modeNames.add(m);
  for (const m of modeNames) {
    if (cssAttrNeedsEscape(m)) warnings.push(`mode '${m}' contains a quote or backslash; escaped in its ${inCss} selector`);
  }

  // One pass per variable for the three name-derived checks below; `segs`/`cssVarName` are split +
  // regex chains, so computing each once per token keeps the lint linear in the token count.
  //  - Character folding (e.g. "(Space 3)" -> "---Space-3-"): same never-silent rule as the value/mode
  //    escapers. The "expected" form is built from segs() and compared to cssVarName()'s own output, so
  //    the detector is derived from the rewriter rather than being a twin that can drift out of sync.
  //  - FLOATs left unitless because their NAME looked like an opacity/font-weight, with no scope to
  //    confirm it. That is a guess — a defensible one, and better than emitting `opacity: 0.5px`, but it
  //    is still this file rewriting output off a pattern match, and every other such rewrite announces
  //    itself. Say which tokens it touched so a wrong guess is visible; the fix is to narrow the
  //    variable's scopes in Figma (or pass opts.unitless).
  //  - CSS var-name collisions are NOT here any more: they are planned (and reported, naming every
  //    key) by planIds, the same function that decides the emitted names — see cssPlan.
  for (const v of vars) {
    if (v.type === "FLOAT" && unitDecision(v, opts) === "name") {
      warnings.push(`token '${v.name}' has no narrowed scopes (Figma's ALL_SCOPES default); emitted UNITLESS because its name reads as an opacity/font-weight — scope it in Figma to make this explicit`);
    }
    const s = segs(v.name);
    if (!s.length) continue;
    const folded = cssVarName(v.name);
    if (folded !== "--" + s.join("-")) {
      const as = files.map((f) => `${f === "theme.css" ? twName(v, opts) : folded} in ${f}`).join(", ");
      warnings.push(`token '${v.name}' contains characters that are illegal in a CSS custom property; emitted as ${as}`);
    }
  }
  return warnings;
}

// Both emitters + the lint under ONE opts object and ONE pass over the design system. lintTokens has
// to be called with the same opts as toCSS (it reports guesses the emitter actually made); making
// that one call removes the coupling from the caller instead of documenting it.
// opts.tailwind: also build theme.css in the same pass, so its name collisions are reported in the
// SAME message as tokens.dtcg.json's and tokens.css's. opts.sources: Map(key -> [screen]) so a
// collision warning can say which screen each colliding variable came from.
function emitTokens(designSystem: TokensDoc | null | undefined, opts?: EmitOpts): EmitResult {
  const warnings: string[] = [];
  const notes: CollisionNote[] = [];
  const dtcg = toDTCG(designSystem, warnings, opts, notes);
  const css = toCSS(designSystem, opts, notes);
  const tailwind = opts && opts.tailwind ? toTailwind(designSystem, opts, notes) : undefined;
  // Additive: the resolver is a SECOND view of the same variables (per-mode files instead of
  // $extensions), not a replacement — toDTCG's output is unchanged. It runs after toDTCG so its
  // warning dedupe sees the messages toDTCG already recorded.
  const { resolver, files } = toResolver(designSystem, warnings, opts);
  const collisions = collisionMessages(notes, opts);
  if (tailwind) warnings.push(...tailwind.warnings); // no collisions in it (notes was passed): the left-out STRINGs, the mode scoping
  lintNames(designSystem, opts, warnings);
  return { dtcg, css, tailwind, resolver, resolverFiles: files, warnings: dedupe(collisions.concat(warnings)), collisions };
}

export { toDTCG, toCSS, toResolver, toTailwind, lintTokens, emitTokens, hexToColorValue, cssVarName, TW_PREFIX, WEB_FULL_ROUND };
// tokens-native.ts must agree with this file on names, default modes, aliases and units, so it is
// built FROM these helpers (see the note at its top on why it does not import this file back).
const { toNative, platformOf, PLATFORMS } = nativeEmitter({ segs, isAlias, defaultModeName, baseValue, unitDecision, isSentinel, percentOpacity });
export { toNative, platformOf, PLATFORMS };

// CLI: node design-to-code/tokens.ts <design-system/tokens.json> [outDir] [--native <platform>] [--package <kotlin.package>]
// --native swiftui | compose | flutter | react-native (a build-screen profile name works too) also
// writes ONE native token file next to the others — move it into the app's source tree and import it
// from every screen (see tokens-native.ts for why and for the shape of each file).
// The input is the SPLIT token file — design-system.json is a slim pointer manifest since the split
// and has no `variables` array (see bridge/design-system-layout.js).
function main(args: string[]): number {
  const USAGE = `usage: ${scriptCmd("tokens")} <design-system/tokens.json | design/variables.json> [outDir]\n` +
    "       [--native swiftui|compose|flutter|react-native] [--package <kotlin.package>] [--web tailwind] [--also-generic]\n" +
    "       With --web/--native, ONLY the target's file is written to [outDir]; pass --also-generic to\n" +
    "       additionally write the generic set (tokens.dtcg.json, tokens.css, tokens.resolver.json, tokens/).\n" +
    "       Without a target flag, only the generic set is written (unchanged).";
  const OPTIONS = { native: { type: "string" }, web: { type: "string" }, package: { type: "string" }, "also-generic": { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;
  const { values: flags, positionals } = cliParse("tokens", args, OPTIONS, USAGE, 1, (a) => parseArgs({ args: a, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; }
  const { native, web, package: kotlinPackage } = flags;
  const alsoGeneric = !!flags["also-generic"];
  const input = positionals[0];
  const outDir = positionals[1] || ".";
  if (!input) { console.error(USAGE); return 1; }
  if (native !== undefined && !platformOf(native)) { console.error(`--native: unknown platform "${native}"\n${USAGE}`); return 1; }
  const WEB_TARGETS: Record<string, string> = { tailwind: "theme.css", "web-tailwind": "theme.css" }; // build-screen's profile name works too
  const webFile = web === undefined ? undefined : WEB_TARGETS[web];
  if (web !== undefined && !webFile) { console.error(`--web: unknown target "${web}" (known: tailwind)\n${USAGE}`); return 1; }
  // The SPLIT token file (or a merged variables.json): the manifest is refused with its own message, and
  // anything else that is not a token catalog is a one-line error — never an empty token set.
  const ds = readSplitFile(input, "token catalog", isTokensDoc, "variables", "design-system/tokens.json",
    NO_DESIGN_SYSTEM_HINT + "\n       A single-screen pull DOES write design/variables.json — pass that instead.");
  fs.mkdirSync(outDir, { recursive: true }); // documented usage is `… ./out`; don't die on a raw ENOENT
  // finding 225: a --web/--native target used to get the generic set (dtcg/css/resolver/tokens/)
  // written on top of it unconditionally, with no indication of which file the app actually
  // consumes. Now: a target selected -> ONLY that target's file(s) are written to outDir, unless
  // --also-generic is passed. No target -> unchanged (generic set only).
  const hasTarget = web !== undefined || native !== undefined;
  const writeGeneric = !hasTarget || alsoGeneric;
  // The CSS files actually written, so a warning names those (DT-24) — not tokens.css when only theme.css is.
  const cssFiles = [...(writeGeneric ? ["tokens.css"] : []), ...(webFile !== undefined ? [webFile] : [])];
  // one pass: emit + lint share the same opts and traversal, and a name collision is reported once
  // across every output it touches, naming the screen(s) each colliding variable came from.
  const { dtcg, css, tailwind, resolver, resolverFiles, warnings } = emitTokens(ds, { tailwind: web !== undefined, sources: sourcesOf(ds, input), cssFiles });
  const genericCount = Object.keys(resolverFiles).length;
  if (writeGeneric) {
    fs.writeFileSync(path.join(outDir, "tokens.dtcg.json"), JSON.stringify(dtcg, null, 2));
    fs.writeFileSync(path.join(outDir, "tokens.css"), css);
    // Resolver document + the set files it $refs. The refs are relative to the resolver document, and
    // the keys of resolverFiles ARE those refs — so join each key onto outDir and the links hold.
    // Every key is a fileSlug()ed, collision-checked "tokens/<name>.json"; split on "/" rather than
    // passing the key straight to path.join so the layout is identical on Windows.
    fs.writeFileSync(path.join(outDir, "tokens.resolver.json"), JSON.stringify(resolver, null, 2));
    for (const rel of Object.keys(resolverFiles)) {
      const dest = path.join(outDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(resolverFiles[rel], null, 2));
    }
  }
  let canonicalFile: string | null = null;
  // webFile is set whenever web is (unknown targets exit above), and emitTokens built `tailwind` whenever
  // web is (opts.tailwind is `web !== undefined`), so the extra `tw` check never skips this block.
  const tw = tailwind;
  if (web !== undefined && webFile !== undefined && tw !== undefined) {
    const file = webFile;
    fs.writeFileSync(path.join(outDir, file), tw.text);
    canonicalFile = file;
    if (tw.tokens && !tw.utilities) warnings.push(`--web ${web}: no variable mapped to a Tailwind namespace, so ${file} generates no utilities — every token is a plain custom property you must reference with var()`);
    else if (tw.tokens > tw.utilities) warnings.push(`--web ${web}: ${tw.tokens - tw.utilities} of ${tw.tokens} token(s) match no Tailwind namespace (unitless FLOATs like opacity/font-weight, booleans, strings a font family aliases) — emitted as plain --figma-* properties, usable via var() but generating no utility`);
  }
  if (native !== undefined) {
    const n = toNative(ds, native, { ...ifDefined("package", kotlinPackage || undefined) });
    fs.writeFileSync(path.join(outDir, n.file), n.text);
    warnings.push(...n.warnings);
    canonicalFile = n.file;
  }
  warnings.forEach((w) => console.error("warn  " + w));
  // DT-79 (D9): a suggestion only, printed — not written into theme.css, which the user moves into the app.
  if (webFile !== undefined) console.error("note  " + TAILWIND_SOURCE_NOT_NOTE);
  if (hasTarget) {
    const genericNote = writeGeneric
      ? ` (+ the generic set: tokens.dtcg.json, tokens.css, tokens.resolver.json, ${genericCount} file(s) under ${RESOLVER_DIR}/ — also written here because --also-generic was passed)`
      : ` — the generic handoff set (tokens.dtcg.json, tokens.css, tokens.resolver.json, tokens/) was NOT written here; it belongs under design/, not the app's source tree (pass --also-generic to also write it to ${outDir})`;
    console.log(`wrote ${canonicalFile} to ${outDir} — this is the file your app should import${genericNote} (${(ds.variables || []).length} variables)`);
  } else {
    console.log(`wrote tokens.dtcg.json + tokens.css + tokens.resolver.json (+${genericCount} set files under ${RESOLVER_DIR}/) (${(ds.variables || []).length} variables)`);
  }
  return 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
