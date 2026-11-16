// bind-values.ts — a tree spec's raw values bound to the file's variables and text styles (docs/write-plane-spec.md,
// "From an existing app to Figma" step 3; decisions 5 and 15): the binding a `createTree` op with `bind: true` asks for.
//
// The plugin gathers what the file has (figma-plugin/src/bind.ts: its local colour and number variables, each by its
// collection's default mode, their scopes, its local text styles, and what the create ops earlier in the batch make) and
// hands this module that table and the spec as it will be built. What comes back is the same spec with every raw value
// that equals exactly one of them rewritten into the reference fields the spec already has — `fills[i].tokens.color`, a
// text's `tokens.fills` (its font colour), `tokens.strokes`, `tokens.<itemSpacing | counterAxisSpacing | padding… |
// …Radius>` and `styles.text` — so the references then resolve through tree-refs.ts like any a person wrote. The raw
// value stays beside the reference (the tree spec allows both), bar a styled text's font fields, which the style sets
// (tree-spec.ts would only warn that they set nothing).
//
// Matching never guesses (decision 15). A colour matches by its 8-bit RGBA (the read's hex), a number when it is within
// 0.01. A variable's value is its value in its collection's default mode, through its aliases (a broken or looping chain:
// no value). When several variables match, in order: (1) the variable's scopes must allow the field; (2) of those left,
// the ones whose name has a word for the field's kind, when any has; (3) one that another candidate aliases is dropped
// (the semantic alias is kept over the primitive it names). Still more than one: the value stays raw and is listed in
// `ambiguous`. A text binds to a text style whose family, style, size, line height, letter spacing, case and decoration
// all equal the text's; several such styles: ambiguous.
//
// Not bound: sizes, opacity, stroke weights, image paints, a paint with its own opacity, a paint style (the tree spec has
// no fill style), and nothing inside a copy (`clone`) or an instance.
//
// Pure and dependency-free (bar pure siblings): the plugin bundle imports it, so it must type-check under
// figma-plugin/tsconfig.json (ES2019 lib, no Node types), and use no `??` or `?.`.
import { formatHex, parseHexColor } from "./hex-color.ts";
import { DEFAULT_FONT, nodeKind, type TreeFont, type TreeNodeSpec, type TreeTokens } from "./tree-spec.ts";

/** A colour or number variable a value can bind to. `value` is its own value in its collection's default mode (a hex as
 *  formatHex writes it, or a number); `aliasOf` the `ref` of the variable that mode aliases instead (in the same list). */
export interface BindVariable {
  /** what the spec names it by: its id (a variable the file has), or its name (one a create op of the batch makes) */
  ref: string;
  name: string;
  value?: string | number;
  aliasOf?: string;
  /** Figma's VariableScope list (ALL_SCOPES allows every field; an empty list none) */
  scopes: readonly string[];
  /** false: only there to follow an alias through (a library variable): never bound to itself */
  candidate?: false;
}
/** A text style a text can bind to, in the tree spec's own vocabulary: `lineHeight` in px (null for auto), `letterSpacing`
 *  in px, `textCase` / `decoration` as the spec spells them ("original" / "none" for neither). */
export interface BindTextStyle {
  ref: string;
  name: string;
  family: string;
  style: string;
  size: number;
  lineHeight: number | null;
  letterSpacing: number;
  textCase: string;
  decoration: string;
}
export interface BindTable {
  colors: readonly BindVariable[];
  numbers: readonly BindVariable[];
  textStyles: readonly BindTextStyle[];
}
/** A value left raw because more than one variable or style matched it, with up to three of their names. */
export interface AmbiguousValue { path: string; field: string; value: string | number; candidates: string[] }
/** What a binding did: how many raw values it bound, and the ones it could not decide (at most AMBIGUOUS_SAMPLES of them,
 *  `count` all of them). */
export interface BindOutcome { bound: number; ambiguous: { count: number; samples: AmbiguousValue[] } }
/** What a `bind: true` createTree's reply (and its dry run, when a plugin answers) says: the raw values bound, the
 *  instances the spec places, the raw values left (tree-spec.ts `unbound`), and the ones several candidates matched. */
export interface BindCounts {
  bound: number;
  instanced: number;
  unbound: number;
  ambiguous?: { count: number; samples: AmbiguousValue[] };
}
/** How many ambiguous values a reply lists (decision 20: a small reply); `count` says how many there were. */
export const AMBIGUOUS_SAMPLES = 5;

/** The field kinds a value binds as: which scopes allow it, and the words a variable's name has for it. */
type FieldKind = "fill" | "text" | "stroke" | "spacing" | "radius";
const SCOPES: { readonly [K in FieldKind]: readonly string[] } = {
  fill: ["ALL_SCOPES", "ALL_FILLS", "FRAME_FILL"],
  text: ["ALL_SCOPES", "ALL_FILLS", "TEXT_FILL"],
  stroke: ["ALL_SCOPES", "STROKE_COLOR"],
  spacing: ["ALL_SCOPES", "GAP"],
  radius: ["ALL_SCOPES", "CORNER_RADIUS"],
};
const WORDS: { readonly [K in FieldKind]: readonly string[] } = {
  fill: ["bg", "background", "surface", "fill"],
  text: ["text", "fg", "foreground", "content"],
  stroke: ["border", "stroke", "outline", "divider"],
  spacing: ["space", "spacing", "gap", "padding", "inset", "gutter"],
  radius: ["radius", "radii", "round", "corner"],
};
/** A name's words: split at every character that is not a letter or digit, and at a lower-to-upper case change. */
function wordsOf(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "");
}
const hasWordFor = (name: string, kind: FieldKind): boolean => wordsOf(name).some((w) => WORDS[kind].some((k) => w.indexOf(k) === 0));
const allows = (v: BindVariable, kind: FieldKind): boolean => v.scopes.some((s) => SCOPES[kind].indexOf(s) >= 0);

/** A hex colour as the read writes it (formatHex: lower case, `#rrggbb`, `aa` only below 255), or null. */
export function canonicalHex(hex: unknown): string | null {
  const c = parseHexColor(hex);
  if (!c) return null;
  return formatHex({ r: c.r * 255, g: c.g * 255, b: c.b * 255, a: c.a === undefined ? 1 : c.a });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const NUMBER_TOLERANCE = 0.01;

/** Each variable's resolved value (through its aliases) and the refs its chain passes through; null value: none. */
function resolveAll(list: readonly BindVariable[]): Map<string, { value: string | number | null; chain: string[] }> {
  const byRef = new Map<string, BindVariable>();
  for (const v of list) if (!byRef.has(v.ref)) byRef.set(v.ref, v);
  const out = new Map<string, { value: string | number | null; chain: string[] }>();
  for (const v of list) {
    const chain: string[] = [];
    let at: BindVariable | undefined = v;
    let value: string | number | null = null;
    const seen = new Set<string>();
    while (at) {
      if (seen.has(at.ref)) { value = null; break; } // a loop: no value
      seen.add(at.ref);
      if (at.aliasOf === undefined) { value = at.value === undefined ? null : at.value; break; }
      chain.push(at.aliasOf);
      at = byRef.get(at.aliasOf); // a broken chain ends with `at` undefined: no value
      if (!at) value = null;
    }
    out.set(v.ref, { value, chain });
  }
  return out;
}

/** The variables one value of `kind` binds to: exactly one (bound), several (ambiguous, with their names), or none. */
type Pick = { one: BindVariable } | { many: BindVariable[] } | { none: true };
function chooser(list: readonly BindVariable[], eq: (a: string | number, b: string | number) => boolean) {
  const resolved = resolveAll(list);
  const usable = list.filter((v) => v.candidate !== false);
  return (value: string | number, kind: FieldKind): Pick => {
    let cands = usable.filter((v) => { const r = resolved.get(v.ref); return r !== undefined && r.value !== null && eq(r.value, value); });
    // (1) the variable's scopes allow the field
    cands = cands.filter((v) => allows(v, kind));
    if (cands.length > 1) {
      // (2) a name with a word for the field's kind, when any has one
      const named = cands.filter((v) => hasWordFor(v.name, kind));
      if (named.length) cands = named;
    }
    if (cands.length > 1) {
      // (3) the semantic alias over the variable it names: a candidate another candidate's chain reaches is dropped
      const reached = new Set<string>();
      for (const v of cands) { const r = resolved.get(v.ref); if (r) for (const x of r.chain) reached.add(x); }
      const top = cands.filter((v) => !reached.has(v.ref));
      if (top.length) cands = top;
    }
    const first = cands[0];
    if (cands.length === 1 && first) return { one: first };
    return cands.length ? { many: cands } : { none: true };
  };
}

/** A text's font in the units a text style is compared in; null when it cannot be matched (a variable font's axes). */
function textFont(font: Record<string, unknown>): Omit<BindTextStyle, "ref" | "name"> | null {
  if (isObj(font.variationSettings) && Object.keys(font.variationSettings).length) return null;
  const size = typeof font.size === "number" ? font.size : 12; // Figma's size for a new text
  const lh = isObj(font.lineHeight) ? font.lineHeight : null;
  const lineHeight = !lh || lh.unit === "auto" ? null : typeof lh.value !== "number" ? null : lh.unit === "percent" ? lh.value * size / 100 : lh.value;
  const ls = isObj(font.letterSpacing) ? font.letterSpacing : null;
  const letterSpacing = !ls || typeof ls.value !== "number" ? 0 : ls.unit === "percent" ? ls.value * size / 100 : ls.value;
  return {
    family: typeof font.family === "string" ? font.family : DEFAULT_FONT.family,
    style: typeof font.weight === "string" ? font.weight : DEFAULT_FONT.weight,
    size, lineHeight, letterSpacing,
    textCase: typeof font.case === "string" ? font.case : "original",
    decoration: typeof font.decoration === "string" ? font.decoration : "none",
  };
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < NUMBER_TOLERANCE;
const sameFont = (a: Omit<BindTextStyle, "ref" | "name">, b: Omit<BindTextStyle, "ref" | "name">): boolean =>
  a.family === b.family && a.style === b.style && near(a.size, b.size) &&
  (a.lineHeight === null ? b.lineHeight === null : b.lineHeight !== null && near(a.lineHeight, b.lineHeight)) &&
  near(a.letterSpacing, b.letterSpacing) && a.textCase === b.textCase && a.decoration === b.decoration;

/** A text style's fields as Figma's Plugin API gives them (TextStyle), in the units BindTextStyle compares. */
export function textStyleEntry(ref: string, name: string, s: {
  family: string; style: string; size: number;
  lineHeight: { unit: string; value?: number };
  letterSpacing: { unit: string; value: number };
  textCase: string; textDecoration: string;
}): BindTextStyle {
  const lineHeight = s.lineHeight.unit === "AUTO" || typeof s.lineHeight.value !== "number" ? null : s.lineHeight.unit === "PERCENT" ? s.lineHeight.value * s.size / 100 : s.lineHeight.value;
  const letterSpacing = s.letterSpacing.unit === "PERCENT" ? s.letterSpacing.value * s.size / 100 : s.letterSpacing.value;
  return { ref, name, family: s.family, style: s.style, size: s.size, lineHeight, letterSpacing, textCase: s.textCase.toLowerCase(), decoration: s.textDecoration.toLowerCase() };
}

/** The spec's fields that a text style sets: dropped from a text once it is bound to one (the style sets them). */
const STYLE_SET_FIELDS: ReadonlyArray<keyof TreeFont> = ["family", "weight", "weightValue", "size", "lineHeight", "letterSpacing", "case", "decoration", "variationSettings"];
const SIDES = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
const CORNERS = [["tl", "topLeftRadius"], ["tr", "topRightRadius"], ["br", "bottomRightRadius"], ["bl", "bottomLeftRadius"]] as const;

/**
 * `spec` (a valid tree spec, as checkTree expanded it) with every raw value that equals exactly one variable or text
 * style of `table` bound to it, and what was bound and left undecided. `spec` itself is not changed: the result is a copy.
 */
export function bindSpec(spec: TreeNodeSpec, table: BindTable): { spec: TreeNodeSpec; outcome: BindOutcome } {
  const copy = JSON.parse(JSON.stringify(spec)) as TreeNodeSpec;
  const outcome: BindOutcome = { bound: 0, ambiguous: { count: 0, samples: [] } };
  const color = chooser(table.colors, (a, b) => a === b);
  const number = chooser(table.numbers, (a, b) => typeof a === "number" && typeof b === "number" && near(a, b));
  const unsure = (path: string, field: string, value: string | number, many: readonly { name: string }[]): void => {
    outcome.ambiguous.count++;
    if (outcome.ambiguous.samples.length < AMBIGUOUS_SAMPLES) outcome.ambiguous.samples.push({ path, field, value, candidates: many.slice(0, 3).map((v) => v.name) });
  };
  /** The ref one value binds to, or null (no match, or several: listed). */
  const bindOne = (pick: (v: string | number, k: FieldKind) => Pick, value: string | number, kind: FieldKind, path: string, field: string): string | null => {
    const p = pick(value, kind);
    if ("one" in p) return p.one.ref;
    if ("many" in p) unsure(path, field, value, p.many);
    return null;
  };
  const tokensOf = (n: TreeNodeSpec): TreeTokens => { if (!n.tokens) n.tokens = {}; return n.tokens; };

  const walk = (n: TreeNodeSpec, path: string): void => {
    const kind = nodeKind(n);
    // A copy's fields are a patch of it, and an instance shows its component: neither is bound here.
    if (kind === "CLONE" || kind === "INSTANCE" || kind === null) return;
    const t: TreeTokens = n.tokens ? n.tokens : {};
    // Paints: each solid paint without a variable and without an opacity of its own.
    (n.fills || []).forEach((p, i) => {
      if (p.type !== "solid" || p.tokens !== undefined || (p.opacity !== undefined && p.opacity !== 1)) return;
      const hex = canonicalHex(p.color);
      if (hex === null) return;
      const ref = bindOne(color, hex, kind === "TEXT" ? "text" : "fill", path, "fills[" + i + "]");
      if (ref === null) return;
      p.tokens = { color: ref };
      outcome.bound++;
    });
    if (kind === "TEXT") {
      // A text without paints is coloured by its font: bound through `tokens.fills`.
      const font = n.font;
      if (n.fills === undefined && t.fills === undefined && font && font.color !== undefined) {
        const hex = canonicalHex(font.color);
        const ref = hex === null ? null : bindOne(color, hex, "text", path, "font.color");
        if (ref !== null) { tokensOf(n).fills = ref; outcome.bound++; }
      }
      if (!(n.styles && n.styles.text !== undefined)) {
        const want = textFont(isObj(font) ? font : {});
        if (want) {
          const hits = table.textStyles.filter((s) => sameFont(s, want));
          const one = hits[0];
          if (hits.length === 1 && one) {
            n.styles = { text: one.ref };
            if (font) {
              for (const k of STYLE_SET_FIELDS) delete font[k];
              if (!Object.keys(font).length) delete n.font;
            }
            outcome.bound++;
          } else if (hits.length > 1) unsure(path, "styles.text", want.family + " " + want.style + " " + want.size, hits);
        }
      }
    }
    // Strokes: every colour, or none (`tokens.strokes` names one variable per colour, in order).
    const st = n.strokes;
    if (st && st.colors && st.colors.length && t.strokes === undefined) {
      const refs: string[] = [];
      for (const [i, c] of st.colors.entries()) {
        const hex = canonicalHex(c);
        const ref = hex === null ? null : bindOne(color, hex, "stroke", path, "strokes.colors[" + i + "]");
        if (ref === null) break;
        refs.push(ref);
      }
      if (refs.length === st.colors.length) {
        const only = refs[0];
        tokensOf(n).strokes = refs.length === 1 && only !== undefined ? only : refs;
        outcome.bound += refs.length;
      }
    }
    if (kind === "FRAME") {
      const l = n.layout;
      if (l && l.display === "flex") {
        if (l.gap !== undefined && t.itemSpacing === undefined) {
          const ref = bindOne(number, l.gap, "spacing", path, "itemSpacing");
          if (ref !== null) { tokensOf(n).itemSpacing = ref; outcome.bound++; }
        }
        const track = l.flexDirection === "column" ? l.columnGap : l.rowGap;
        if (l.flexWrap !== undefined && track !== undefined && t.counterAxisSpacing === undefined) {
          const ref = bindOne(number, track, "spacing", path, "counterAxisSpacing");
          if (ref !== null) { tokensOf(n).counterAxisSpacing = ref; outcome.bound++; }
        }
        const pad = l.padding;
        if (pad) SIDES.forEach((side, i) => {
          const v = pad[i];
          if (v === undefined || t[side] !== undefined) return;
          const ref = bindOne(number, v, "spacing", path, side);
          if (ref !== null) { tokensOf(n)[side] = ref; outcome.bound++; }
        });
      }
      const r = n.radius;
      if (typeof r === "number" && CORNERS.every(([, f]) => t[f] === undefined)) {
        // One radius is four corners: each bound to the one variable (tree-spec counts it once).
        const ref = bindOne(number, r, "radius", path, "radius");
        if (ref !== null) { const tk = tokensOf(n); for (const [, f] of CORNERS) tk[f] = ref; outcome.bound++; }
      } else if (isObj(r)) {
        for (const [k, f] of CORNERS) {
          const v = r[k];
          if (typeof v !== "number" || t[f] !== undefined) continue;
          const ref = bindOne(number, v, "radius", path, f);
          if (ref !== null) { tokensOf(n)[f] = ref; outcome.bound++; }
        }
      }
    }
    (n.children || []).forEach((c, i) => walk(c, path + ".children[" + i + "]"));
  };
  walk(copy, "tree");
  return { spec: copy, outcome };
}

/** The counts a reply carries for a bound spec: `outcome` with the instances and raw values the checked spec has. */
export function bindCounts(outcome: BindOutcome, instanced: number, unbound: number): BindCounts {
  const out: BindCounts = { bound: outcome.bound, instanced, unbound };
  if (outcome.ambiguous.count) out.ambiguous = { count: outcome.ambiguous.count, samples: outcome.ambiguous.samples };
  return out;
}
