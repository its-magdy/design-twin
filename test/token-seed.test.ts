// Code tokens read back into the create tables (bridge/src/token-seed.ts, bridge/src/seed-file.ts): the mapping, a round
// trip through the emitters (design-to-code toDTCG and toResolver), the file checks, and the reply cut to what changed.
// The tool end to end, with the plugin's real code on a fake file, is test/write-seed.test.ts.
//   bun test/token-seed.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { tokens } from "./fixtures.ts";
import { toDTCG, toResolver } from "../design-to-code/tokens.ts";
import type { Variable, VariableValue } from "../bridge/src/doc-types.ts";
import { checkCreateStyles, checkCreateVariables, MAX_TABLE_ROWS } from "../bridge/src/create-spec.ts";
import { refProblem, resolverRefs, seedFromDtcg, seedFromResolver, type SeedOutcome, type SeedResult, type SeedRow, type SeedStylesOp, type SeedVariablesOp } from "../bridge/src/token-seed.ts";
import { inputIndex, loadSeedTokens, seededPreview, seededReply, type SeedRecord } from "../bridge/src/seed-file.ts";
import { MAX_SPEC_FILE_BYTES } from "../bridge/src/spec-file.ts";
import type { WritePreviewStep, WriteResult } from "../bridge/src/commands.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const res = (o: SeedOutcome): SeedResult => ("error" in o ? { ops: [], unmapped: [{ token: "(error)", reason: o.error }] } : o);
const tables = (o: SeedOutcome): SeedVariablesOp[] => res(o).ops.filter((x): x is SeedVariablesOp => x.op === "createVariables");
const stylesOf = (o: SeedOutcome): SeedStylesOp["styles"] => res(o).ops.find((x): x is SeedStylesOp => x.op === "createStyles")?.styles ?? [];
const rowOf = (o: SeedOutcome, name: string): SeedRow | undefined => tables(o).flatMap((t) => t.variables).find((r) => r[0] === name);
const reasonOf = (o: SeedOutcome, name: string): string => res(o).unmapped.find((u) => u.token === name)?.reason ?? "";
const dtcg = (text: string, collection?: string): SeedOutcome => seedFromDtcg(JSON.parse(text) as unknown, { collection });
/** Every seeded table passes the create tables' own shape check. */
const valid = (o: SeedOutcome): boolean => res(o).ops.every((op) => (op.op === "createVariables" ? checkCreateVariables(op).problems.length === 0 : checkCreateStyles(op).problems.length === 0));

// ---------------------------------------------------------------- the round trip
console.log("\nthe round trip: a design system emitted by toDTCG and toResolver, read back:");
const FIXTURE = tokens({
  file: "Sample Library",
  collections: [
    { name: "Primitives", modes: ["Value"], default: "Value" },
    { name: "Theme", modes: ["Light", "Dark"], default: "Light" },
  ],
  variables: [
    { name: "color/gray/0", type: "COLOR", collection: "Primitives", values: { Value: "#FFFFFF" } },
    { name: "color/gray/900", type: "COLOR", collection: "Primitives", values: { Value: "#111827" } },
    { name: "color/indigo/400", type: "COLOR", collection: "Primitives", values: { Value: "#818cf8" } },
    { name: "color/indigo/600", type: "COLOR", collection: "Primitives", values: { Value: "#4f46e5" } },
    { name: "color/scrim", type: "COLOR", collection: "Primitives", values: { Value: "#00000080" } },
    { name: "space/sm", type: "FLOAT", collection: "Primitives", values: { Value: 8 }, scopes: ["GAP"] },
    { name: "opacity/overlay", type: "FLOAT", collection: "Primitives", values: { Value: 40 }, scopes: ["OPACITY"] },
    { name: "font/family/body", type: "STRING", collection: "Primitives", values: { Value: "Inter" }, scopes: ["FONT_FAMILY"] },
    { name: "flag/beta", type: "BOOLEAN", collection: "Primitives", values: { Value: true } },
    { name: "color/bg", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "color/gray/0" }, Dark: { aliasOf: "color/gray/900" } } },
    { name: "color/text", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "color/gray/900" }, Dark: { aliasOf: "color/gray/0" } } },
    { name: "color/brand/primary", type: "COLOR", collection: "Theme", values: { Light: { aliasOf: "color/indigo/600" }, Dark: { aliasOf: "color/indigo/400" } } },
    // A composed colour (a colour and an opacity, one of them an alias) is no single variable value: listed, not seeded.
    { name: "color/overlay", type: "COLOR", collection: "Theme", values: { Light: { composed: { color: { aliasOf: "color/gray/900" }, opacity: 40 } }, Dark: { composed: { color: "#ffffff", opacity: { aliasOf: "opacity/overlay" } } } } },
    { name: "space/gap", type: "FLOAT", collection: "Theme", values: { Light: { aliasOf: "space/sm" }, Dark: 12 }, scopes: ["GAP"] },
    { name: "label/cta", type: "STRING", collection: "Theme", values: { Light: "Go", Dark: "Go" } },
    { name: "flag/dense", type: "BOOLEAN", collection: "Theme", values: { Light: false, Dark: true } },
  ],
});
const COMPOSED = "color/overlay";
/** A variable's value as a seeded cell: a hex lower-cased, an alias by name. */
function cellOfVariable(v: VariableValue): unknown {
  if (typeof v === "object" && v !== null && "aliasOf" in v) return { aliasOf: v.aliasOf };
  return typeof v === "string" && v.startsWith("#") ? v.toLowerCase() : v;
}
const TYPE: Record<string, string> = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" };
/** Every variable of the fixture came back: its name, type and a value per mode, in `modes` order. */
function roundTrips(o: SeedOutcome, collOf: (v: Variable) => { name: string; modes: string[] }): string[] {
  const bad: string[] = [];
  for (const v of FIXTURE.variables ?? []) {
    if (v.name === COMPOSED) { if (rowOf(o, v.name) || !/opacity/.test(reasonOf(o, v.name))) bad.push("the composed colour is not listed (" + reasonOf(o, v.name) + ")"); continue; }
    const want = collOf(v);
    const t = tables(o).find((x) => x.collection === want.name);
    if (!t) { bad.push("no collection " + want.name + " for " + v.name); continue; }
    if (!same(t.modes ?? [], want.modes)) bad.push(want.name + " has modes " + JSON.stringify(t.modes) + ", wanted " + JSON.stringify(want.modes));
    const row = t.variables.find((r) => r[0] === v.name);
    if (!row) { bad.push("no row " + v.name + " (" + reasonOf(o, v.name) + ")"); continue; }
    if (row[1] !== TYPE[v.type]) bad.push(v.name + " is a " + row[1] + ", wanted " + TYPE[v.type]);
    const modes = want.modes.length ? want.modes : Object.keys(v.values);
    const cells = modes.map((m) => { const x = v.values[m]; return x === undefined ? null : cellOfVariable(x); });
    if (!same(row.slice(2), cells)) bad.push(v.name + " = " + JSON.stringify(row.slice(2)) + ", wanted " + JSON.stringify(cells));
  }
  return bad;
}
{
  const warnings: string[] = [];
  const tree = JSON.parse(JSON.stringify(toDTCG(FIXTURE, warnings))) as unknown;
  const fromDtcg = seedFromDtcg(tree, { collection: "Brand" });
  const bad = roundTrips(fromDtcg, (v) => (v.collection === "Theme" ? { name: "Brand (Light / Dark)", modes: ["Light", "Dark"] } : { name: "Brand", modes: [] }));
  check(`tokens.dtcg.json: every variable back with its name, type, value per mode and aliases${bad.length ? " (" + bad.slice(0, 4).join("; ") + ")" : ""}`, bad.length === 0);
  check("tokens.dtcg.json: the one-mode table first (the two-mode one aliases it), only the composed colour unmapped, every table valid",
    same(tables(fromDtcg).map((t) => t.collection), ["Brand", "Brand (Light / Dark)"]) && same(res(fromDtcg).unmapped.map((u) => u.token), [COMPOSED]) && valid(fromDtcg));

  const { resolver, files } = toResolver(FIXTURE, []);
  const parsed = JSON.parse(JSON.stringify(resolver)) as unknown;
  const refs = resolverRefs(parsed);
  const loaded = new Map<string, unknown>();
  for (const r of "refs" in refs ? refs.refs : []) loaded.set(r, JSON.parse(JSON.stringify(files[r])) as unknown);
  const fromResolver = seedFromResolver(parsed, loaded);
  const badR = roundTrips(fromResolver, (v) => (v.collection === "Theme" ? { name: "Theme", modes: ["Light", "Dark"] } : { name: "Primitives", modes: [] }));
  check(`tokens.resolver.json: every variable back, in its own collection, its modes from the modifier${badR.length ? " (" + badR.slice(0, 4).join("; ") + ")" : ""}`, badR.length === 0);
  check("tokens.resolver.json: the resolver names every set and context file it was written with", "refs" in refs && refs.refs.length === Object.keys(files).length);
  check("tokens.resolver.json: Primitives before Theme, only the composed colour unmapped, every table valid", same(tables(fromResolver).map((t) => t.collection), ["Primitives", "Theme"]) && same(res(fromResolver).unmapped.map((u) => u.token), [COMPOSED]) && valid(fromResolver));
  const sorted = (o: SeedOutcome): SeedRow[][] => tables(o).map((t) => t.variables.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  check("both files make the same rows (in the order of their trees)", same(sorted(fromDtcg), sorted(fromResolver)));
}

// ---------------------------------------------------------------- the mapping
console.log("\ntypes and values:");
{
  const o = dtcg(`{
    "color": { "$type": "color",
      "hex": { "$value": "#ABC" },
      "srgb": { "$value": { "colorSpace": "srgb", "components": [1, 0.5, 0], "alpha": 0.5 } },
      "p3": { "$value": { "colorSpace": "display-p3", "components": [1, 0, 0], "hex": "#ff0000" } },
      "p3bare": { "$value": { "colorSpace": "display-p3", "components": [1, 0, 0] } },
      "faded": { "$value": "#000000", "$extensions": { "figma.com": { "opacity": 50 } } },
      "fadedRef": { "$value": "#000000", "$extensions": { "figma.com": { "opacity": "{opacity.half}" } } },
      "bad": { "$value": "red" }
    },
    "size": { "$type": "dimension", "px": { "$value": { "value": 4, "unit": "px" } }, "rem": { "$value": { "value": 1.5, "unit": "rem" } }, "str": { "$value": "2em" }, "pt": { "$value": { "value": 3, "unit": "pt" } } },
    "n": { "$type": "number", "$value": 2, "$description": "dropped" },
    "s": { "$type": "string", "$value": "hello" },
    "font": { "fam": { "$type": "fontFamily", "$value": ["Inter", "sans-serif"] }, "w": { "$type": "fontWeight", "$value": "semi-bold" }, "w2": { "$type": "fontWeight", "$value": 700 } },
    "b": { "$type": "string", "$value": "true", "$extensions": { "figma.com": { "originalType": "boolean" } } },
    "motion": { "$type": "duration", "$value": { "value": 100, "unit": "ms" } },
    "curve": { "$type": "cubicBezier", "$value": [0, 0, 1, 1] },
    "grad": { "$type": "gradient", "$value": [] }, "line": { "$type": "border", "$value": {} }, "move": { "$type": "transition", "$value": {} }, "dash": { "$type": "strokeStyle", "$value": "dashed" },
    "odd": { "$type": "wobble", "$value": 1 },
    "untyped": { "$value": 3 },
    "accent": { "$type": "color", "$root": { "$value": "#112233" }, "hover": { "$value": "#445566" } }
  }`);
  check("a hex is normalised (#abc → #aabbcc)", rowOf(o, "color/hex")?.[2] === "#aabbcc");
  check("an sRGB colour's components and alpha → #rrggbbaa", rowOf(o, "color/srgb")?.[2] === "#ff800080");
  check("a display-p3 colour takes its hex fallback; one without is unmapped, saying why", rowOf(o, "color/p3")?.[2] === "#ff0000" && /display-p3 colour without a hex fallback/.test(reasonOf(o, "color/p3bare")));
  check("a numeric opacity goes into the alpha; one that is a reference is unmapped", rowOf(o, "color/faded")?.[2] === "#00000080" && /opacity is a reference/.test(reasonOf(o, "color/fadedRef")));
  check("a value that is not a colour is unmapped", /not a colour/.test(reasonOf(o, "color/bad")));
  check("dimensions: px as is, rem and em × 16, another unit unmapped", rowOf(o, "size/px")?.[2] === 4 && rowOf(o, "size/rem")?.[2] === 24 && rowOf(o, "size/str")?.[2] === 32 && /'pt'/.test(reasonOf(o, "size/pt")));
  check("number, string; a description is dropped without a word", same(rowOf(o, "n"), ["n", "number", 2]) && same(rowOf(o, "s"), ["s", "string", "hello"]) && reasonOf(o, "n") === "");
  check("fontFamily (a list: its first), fontWeight (named, and a number)", same(rowOf(o, "font/fam"), ["font/fam", "string", "Inter"]) && rowOf(o, "font/w")?.[2] === 600 && same(rowOf(o, "font/w2"), ["font/w2", "number", 700]));
  check("a string token that was a Figma boolean is a boolean again", same(rowOf(o, "b"), ["b", "boolean", true]));
  const listed = ["motion", "curve", "grad", "line", "move", "dash"].every((n) => /has no Figma variable or style/.test(reasonOf(o, n)));
  check("duration, cubicBezier, gradient, border, transition, strokeStyle: each listed, not dropped", listed);
  check("an unknown $type, and a token with no $type, are listed", /unknown \$type 'wobble'/.test(reasonOf(o, "odd")) && /no \$type/.test(reasonOf(o, "untyped")));
  check("a group's $type is inherited; $root is the group's own token", rowOf(o, "accent")?.[2] === "#112233" && same(rowOf(o, "accent/hover"), ["accent/hover", "color", "#445566"]));
  check("every table it made is valid", valid(o));
}

console.log("\nnames and aliases:");
{
  const o = dtcg(`{
    "a": { "b/c": { "$type": "number", "$value": 1 } }, "a/b": { "c": { "$type": "number", "$value": 2 } },
    "": { "$type": "number", "$value": 1 }, "x.y": { "$type": "number", "$value": 1 }, "loose": 4,
    "base": { "$type": "color", "$value": "#000000" },
    "ref": { "$value": "{base}" },
    "refRef": { "$value": "{ref}" },
    "gone": { "$type": "color", "$value": "{nowhere.at.all}" },
    "chain": { "$type": "color", "$value": "{gone}" },
    "num": { "$type": "number", "$value": 1 },
    "mix": { "$type": "color", "$value": "{num}" },
    "loop1": { "$type": "color", "$value": "{loop2}" }, "loop2": { "$type": "color", "$value": "{loop1}" },
    "me": { "$type": "color", "$value": "{me}" },
    "intoLoop": { "$type": "color", "$value": "{loop1}" }
  }`);
  check("a name two paths reach once joined with '/': the first seeded, the second listed", rowOf(o, "a/b/c")?.[2] === 1 && /two paths make this name/.test(reasonOf(o, "a/b/c")));
  check("an empty name, a name with '.', a stray value: listed", /empty name/.test(reasonOf(o, "")) && /'\.'/.test(reasonOf(o, "x.y")) && /neither a token/.test(reasonOf(o, "loose")));
  check("an alias with no $type takes its target's type, through another alias", same(rowOf(o, "ref"), ["ref", "color", { aliasOf: "base" }]) && same(rowOf(o, "refRef"), ["refRef", "color", { aliasOf: "ref" }]));
  check("an alias to a token not here is listed, and so is one that aliases it", /names no token here/.test(reasonOf(o, "gone")) && /not seeded/.test(reasonOf(o, "chain")) && !rowOf(o, "gone") && !rowOf(o, "chain"));
  check("an alias to a token of another type is listed", /names a number token, and it is a color one/.test(reasonOf(o, "mix")));
  check("a loop of aliases is listed (both), so is a self-alias and a row that aliases into the loop — no crash",
    /aliases loop: 'loop1' → 'loop2' → 'loop1'/.test(reasonOf(o, "loop1")) && /aliases loop/.test(reasonOf(o, "loop2")) && /aliases itself/.test(reasonOf(o, "me")) && /not seeded/.test(reasonOf(o, "intoLoop")));
  check("what is left is a valid table", valid(o) && tables(o).length === 1);
}

console.log("\nmodes and collections (tokens.dtcg.json):");
{
  const o = dtcg(`{
    "plain": { "$type": "number", "$value": 1 },
    "bg": { "$type": "color", "$value": "#ffffff", "$extensions": { "figma.com": { "modes": { "Light": "#ffffff", "Dark": "#000000" } } } },
    "fg": { "$type": "color", "$value": "#000000", "$extensions": { "figma.com": { "modes": { "Dark": "#ffffff", "Light": "#000000" } } } },
    "tint": { "$type": "color", "$value": "#000000", "$extensions": { "figma.com": { "modes": { "Light": "#000000", "Dark": "#ffffff" }, "modeOpacity": { "Light": 50 } } } },
    "gap": { "$type": "number", "$value": 4, "$extensions": { "figma.com": { "modes": { "Compact": 4, "Comfy": 8, "Roomy": 12 } } } }
  }`, "Kit");
  const names = tables(o).map((t) => t.collection);
  check(`tokens with different modes: one collection per set of modes, named for them (got ${JSON.stringify(names)})`, same(names, ["Kit", "Kit (Light / Dark)", "Kit (Compact / Comfy / Roomy)"]));
  const ld = tables(o).find((t) => t.collection === "Kit (Light / Dark)");
  check("a token whose modes come in another order lands in the same collection, its values by mode name", same(ld?.modes, ["Light", "Dark"]) && same(ld?.variables.find((r) => r[0] === "fg"), ["fg", "color", "#000000", "#ffffff"]));
  check("a per-mode opacity goes into that mode's alpha only", same(rowOf(o, "tint"), ["tint", "color", "#00000080", "#ffffff"]));
  check("a token with no modes goes into the one-mode collection", same(tables(o)[0]?.variables, [["plain", "number", 1]]) && tables(o)[0]?.modes === undefined);
  const one = dtcg(`{ "bg": { "$type": "color", "$value": "#ffffff", "$extensions": { "figma.com": { "modes": { "Light": "#ffffff", "Dark": "#000000" } } } } }`);
  check("one set of modes: the collection is named as given ('Tokens' by default)", same(tables(one).map((t) => [t.collection, t.modes]), [["Tokens", ["Light", "Dark"]]]));
  const big: Record<string, unknown> = {};
  for (let i = 0; i <= MAX_TABLE_ROWS; i++) big["t" + i] = { $type: "number", $value: i };
  const tooBig = seedFromDtcg(big);
  check("a collection over the table's limit is refused, naming the limit", "error" in tooBig && new RegExp("1001 variables, and a table takes at most " + MAX_TABLE_ROWS).test(tooBig.error));
  const none = dtcg(`{ "a": { "$type": "duration", "$value": { "value": 1, "unit": "ms" } } }`);
  check("a file where nothing can be seeded is refused, with why", "error" in none && /no token in the token file could be seeded \('a': a duration token/.test(none.error));
}

console.log("\nstyles:");
{
  const o = dtcg(`{
    "font": { "family": { "body": { "$type": "fontFamily", "$value": "Inter" } }, "size": { "md": { "$type": "dimension", "$value": { "value": 16, "unit": "px" } } }, "weight": { "bold": { "$type": "fontWeight", "$value": 700 } },
      "leading": { "$type": "number", "$value": 1.5 } },
    "shadow": { "color": { "$type": "color", "$value": "#00000040" }, "blur": { "$type": "dimension", "$value": "8px" } },
    "type": { "$type": "typography",
      "body": { "$value": { "fontFamily": "{font.family.body}", "fontSize": "{font.size.md}", "fontWeight": "{font.weight.bold}", "lineHeight": 1.5, "letterSpacing": { "value": 0.5, "unit": "px" } } },
      "lead": { "$value": { "fontFamily": "Inter", "fontSize": { "value": 1, "unit": "rem" }, "lineHeight": "{font.leading}" } },
      "alias": { "$value": "{type.body}" },
      "broken": { "$value": { "fontSize": "{font.size.nope}" } }
    },
    "elevation": { "$type": "shadow",
      "card": { "$value": { "color": "{shadow.color}", "offsetX": { "value": 0, "unit": "px" }, "offsetY": { "value": 2, "unit": "px" }, "blur": "{shadow.blur}", "spread": { "value": 0, "unit": "px" } } },
      "stack": { "$value": [{ "color": "#000000", "offsetX": "0px", "offsetY": "1px", "blur": "2px" }, { "color": "#00000080", "offsetX": "0px", "offsetY": "4px", "blur": "8px", "inset": true }] }
    }
  }`);
  const st = stylesOf(o);
  const body = st.find((s) => s.name === "type/body"), lead = st.find((s) => s.name === "type/lead");
  check("a typography token is a text style: its fields, the references bound through `tokens`", same(body, { name: "type/body", kind: "text", set: {
    font: "Inter", weight: "Bold", size: 16, letterSpacing: { unit: "px", value: 0.5 }, lineHeight: { unit: "percent", value: 150 },
    tokens: { fontFamily: "font/family/body", fontWeight: "font/weight/bold", fontSize: "font/size/md" } } }));
  check("a line height that is a multiple (or names one) is a percentage, not bound; rem font size × 16", same(lead?.set, { font: "Inter", size: 16, lineHeight: { unit: "percent", value: 150 } }));
  check("a typography alias takes its target's value", same(st.find((s) => s.name === "type/alias")?.set, body?.set));
  check("a style that names a token that is not seeded is listed", /fontSize names \{font\.size\.nope\}, which is not seeded/.test(reasonOf(o, "type/broken")));
  const card = st.find((s) => s.name === "elevation/card"), stack = st.find((s) => s.name === "elevation/stack");
  check("a shadow token is an effect style, its colour and blur bound to their variables", same(card, { name: "elevation/card", kind: "effect", set: { effects: [
    { type: "drop_shadow", color: "#00000040", offset: { x: 0, y: 2 }, radius: 8, spread: 0, tokens: { color: "shadow/color", radius: "shadow/blur" } }] } }));
  check("a shadow list is one effect per layer; inset is an inner shadow", same(stack?.set.effects?.map((e) => e.type), ["drop_shadow", "inner_shadow"]));
  check("the styles come after the variables, one table; every table valid", res(o).ops.at(-1)?.op === "createStyles" && valid(o));
}

console.log("\nnames that are Object.prototype's:");
{
  const o = dtcg(`{
    "__proto__": { "$type": "color", "$value": "#000000", "$extensions": { "figma.com": { "modes": { "__proto__": "#000000", "constructor": "#ffffff" } } } },
    "constructor": { "$type": "color", "$value": "{__proto__}", "$extensions": { "figma.com": { "modes": { "__proto__": "{__proto__}", "constructor": "{toString.hasOwnProperty}" } } } },
    "toString": { "hasOwnProperty": { "$type": "color", "$value": "#111111", "$extensions": { "figma.com": { "modes": { "__proto__": "#111111", "constructor": "#222222" } } } } },
    "valueOf": { "$type": "number", "$value": 1 }
  }`, "__proto__");
  const t = tables(o);
  check(`__proto__, constructor, toString, hasOwnProperty, valueOf: names, modes and a collection like any other (got ${JSON.stringify(t.map((x) => x.collection))})`,
    same(t.map((x) => x.collection), ["__proto__ (__proto__ / constructor)", "__proto__"]) && same(rowOf(o, "constructor"), ["constructor", "color", { aliasOf: "__proto__" }, { aliasOf: "toString/hasOwnProperty" }])
    && same(rowOf(o, "__proto__"), ["__proto__", "color", "#000000", "#ffffff"]) && same(rowOf(o, "valueOf"), ["valueOf", "number", 1]) && res(o).unmapped.length === 0 && valid(o));
  check("no prototype was touched", Object.getPrototypeOf({}) === Object.prototype && !("#000000" in Object.prototype));
  const resolver = JSON.parse(`{ "version": "2025.10", "sets": { "__proto__": { "sources": [{ "$ref": "p.json" }] } },
    "modifiers": { "constructor": { "contexts": { "toString": [], "valueOf": [{ "$ref": "v.json" }] }, "default": "toString", "$extensions": { "figma.com": { "collection": "__proto__" } } } },
    "resolutionOrder": [{ "$ref": "#/sets/__proto__" }, { "$ref": "#/modifiers/constructor" }] }`) as unknown;
  const files = new Map<string, unknown>([["p.json", JSON.parse(`{ "__proto__": { "$type": "number", "$value": 1 } }`) as unknown], ["v.json", JSON.parse(`{ "__proto__": { "$type": "number", "$value": 2 } }`) as unknown]]);
  const r = seedFromResolver(resolver, files);
  check("a resolver's set, modifier and contexts named after them too", same(tables(r), [{ op: "createVariables", collection: "__proto__", modes: ["toString", "valueOf"], variables: [["__proto__", "number", 1, 2]] }]));
}

console.log("\nresolvers:");
{
  const doc = (o: object): unknown => JSON.parse(JSON.stringify(o)) as unknown;
  const base = { $type: "color", a: { $value: "#000000" }, b: { $value: "#111111" } };
  const r = seedFromResolver(doc({
    sets: { Core: { sources: [{ $ref: "core.json" }] }, Brand: { sources: [{ brand: { $type: "color", $value: "{a}" } }], $extensions: { "figma.com": { collection: "Brand colours" } } } },
    modifiers: { theme: { contexts: { dark: [{ $ref: "dark.json" }], light: [] }, default: "light" } },
    resolutionOrder: [{ $ref: "#/sets/Core" }, { $ref: "#/sets/Brand" }, { $ref: "#/modifiers/theme" }],
  }), new Map([["core.json", doc(base)], ["dark.json", doc({ a: { $type: "color", $value: "#ffffff" } })]]));
  check("a set is a collection by its figma.com collection, else its name; inline tokens are read", same(tables(r).map((t) => t.collection), ["Core", "Brand colours"]));
  check("a modifier with no figma.com collection goes to the one set its tokens are in; the default mode first; the rest filled from the set",
    same(tables(r)[0], { op: "createVariables", collection: "Core", modes: ["light", "dark"], variables: [["a", "color", "#000000", "#ffffff"], ["b", "color", "#111111", "#111111"]] }));
  const ext = seedFromResolver(doc({
    sets: { Core: { sources: [{ a: { $type: "number", $value: 1 } }] } },
    modifiers: { Sub: { contexts: { none: [], One: [{ a: { $type: "number", $value: 2 } }] }, default: "none", $extensions: { "figma.com": { collection: "Sub", defaultMode: "none" } } } },
    resolutionOrder: [{ $ref: "#/sets/Core" }, { $ref: "#/modifiers/Sub" }],
  }), new Map());
  check("an extended collection's override modifier (its collection has no set) is listed, the base seeded", same(rowOf(ext, "a"), ["a", "number", 1]) && /extended collection's overrides are not seeded/.test(reasonOf(ext, "a")));
  const cross = seedFromResolver(doc({
    sets: { A: { sources: [{ a1: { $type: "number", $value: 1 }, a2: { $type: "number", $value: "{b1}" } }] }, B: { sources: [{ b1: { $type: "number", $value: 2 }, b2: { $type: "number", $value: "{a1}" } }] } },
    resolutionOrder: [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }],
  }), new Map());
  check("two collections that alias each other: the alias that would need the later table is listed, the rest valid", (rowOf(cross, "a2") === undefined) !== (rowOf(cross, "b2") === undefined)
    && /which aliases this one too/.test(reasonOf(cross, "a2") + reasonOf(cross, "b2")) && valid(cross));
  const twice = seedFromResolver(doc({ sets: { A: { sources: [{ x: { $type: "number", $value: 1 } }] }, B: { sources: [{ x: { $type: "number", $value: 2 } }] } }, resolutionOrder: [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }] }), new Map());
  check("a token two sets give is seeded once, in the first, and the second listed", same(rowOf(twice, "x"), ["x", "number", 1]) && /seeded once, in collection 'A'/.test(reasonOf(twice, "x")));
  check("$ref refusals: a URL, an absolute path, a pointer, a fragment", /URL/.test(refProblem("https://example.com/t.json") ?? "") && /absolute/.test(refProblem("/etc/t.json") ?? "")
    && /points into the resolver/.test(refProblem("#/sets/x") ?? "") && /#fragment/.test(refProblem("t.json#/a") ?? "") && refProblem("tokens/t.json") === null && /URL or a drive path/.test(refProblem("C:\\t.json") ?? ""));
  const bad = resolverRefs(doc({ sets: { A: { sources: [{ $ref: "https://example.com/t.json" }] } }, resolutionOrder: [{ $ref: "#/sets/A" }] }));
  check("a resolver with such a $ref is refused, naming the set", "error" in bad && /^set 'A': 'https:\/\/example\.com\/t\.json' is a URL/.test(bad.error));
  const noSet = resolverRefs(doc({ sets: {}, resolutionOrder: [{ $ref: "#/sets/missing" }] }));
  check("a resolution order naming a set that is not there is refused", "error" in noSet && /names nothing in the resolver/.test(noSet.error));
}

// ---------------------------------------------------------------- the files
console.log("\nthe files (seed-file.ts):");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-seed-"));
  const put = (name: string, content: unknown): void => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content)); };
  const inside = (p: string, what: string): string => {
    const abs = path.resolve(dir, p);
    if (!abs.startsWith(dir + path.sep)) throw new Error(`${what} must stay inside the directory this server was started in`);
    return abs;
  };
  const load = (ops: Array<Record<string, unknown> & { op: string }>) => loadSeedTokens(ops, inside);
  const err = (r: ReturnType<typeof load>): string => ("error" in r ? r.error : "(loaded)");
  put("tokens.dtcg.json", { color: { $type: "color", bg: { $value: "#ffffff" } }, type: { $type: "typography", body: { $value: { fontFamily: "Inter", fontSize: "16px" } } } });
  const r = load([{ op: "seedTokens", file: "tokens.dtcg.json", collection: "Theme" }, { op: "createTree", tree: { name: "S" } }]);
  check("seedTokens becomes its tables in place, the op after it kept", "ops" in r && same(r.ops.map((o) => o.op), ["createVariables", "createStyles", "createTree"])
    && same(r.seeds, [{ index: 0, file: "tokens.dtcg.json", first: 0, count: 2, unmapped: [], tables: [{ collection: "Theme", names: ["color/bg"] }, { collection: null, names: ["type/body"] }] }]));
  put("tokens.resolver.json", { version: "2025.10", sets: { Core: { sources: [{ $ref: "tokens/core.json" }] } }, resolutionOrder: [{ $ref: "#/sets/Core" }] });
  put("tokens/core.json", { gap: { $type: "number", $value: 4 } });
  const rr = load([{ op: "seedTokens", file: "tokens.resolver.json" }]);
  check("a resolver is told by its content, its $ref read relative to it", "ops" in rr && same(rr.ops, [{ op: "createVariables", collection: "Core", variables: [["gap", "number", 4]] }]));
  put("named.json", { version: "2025.10", sets: { Core: { sources: [{ $ref: "tokens/core.json" }] } }, resolutionOrder: [{ $ref: "#/sets/Core" }] });
  check("…whatever the file is called", "ops" in load([{ op: "seedTokens", file: "named.json" }]));
  check("a resolver with `collection` is refused (its sets name the collections)", /a resolver names its collections/.test(err(load([{ op: "seedTokens", file: "tokens.resolver.json", collection: "X" }]))));
  put("escape.resolver.json", { sets: { A: { sources: [{ $ref: "../../outside.json" }] } }, resolutionOrder: [{ $ref: "#/sets/A" }] });
  check("a $ref that leaves the directory is refused by the server's own check", /\$ref '\.\.\/\.\.\/outside\.json' must stay inside the directory/.test(err(load([{ op: "seedTokens", file: "escape.resolver.json" }]))));
  put("url.resolver.json", { sets: { A: { sources: [{ $ref: "https://example.com/t.json" }] } }, resolutionOrder: [{ $ref: "#/sets/A" }] });
  check("a URL $ref is refused", /is a URL/.test(err(load([{ op: "seedTokens", file: "url.resolver.json" }]))));
  put("missing.resolver.json", { sets: { A: { sources: [{ $ref: "nope.json" }] } }, resolutionOrder: [{ $ref: "#/sets/A" }] });
  check("a $ref to no file is refused", /\$ref 'nope\.json': no file at/.test(err(load([{ op: "seedTokens", file: "missing.resolver.json" }]))));
  put("tokens.css", ":root { --color-bg: #fff; }");
  check("a CSS file is refused, naming the formats read", /'tokens\.css' is not read \(CSS and native token files lose the '\/' grouping.*tokens\.dtcg\.json.*tokens\.resolver\.json/.test(err(load([{ op: "seedTokens", file: "tokens.css" }]))));
  put("broken.json", "{");
  check("a file that is not JSON is refused, naming the formats read", /broken\.json is not valid JSON .*seedTokens reads a DTCG token file/.test(err(load([{ op: "seedTokens", file: "broken.json" }]))));
  put("huge.json", " ".repeat(MAX_SPEC_FILE_BYTES + 1));
  check("a file over the size limit is refused", /huge\.json is \d+ bytes; a token file is at most/.test(err(load([{ op: "seedTokens", file: "huge.json" }]))));
  check("a path outside the directory is refused", /must stay inside the directory/.test(err(load([{ op: "seedTokens", file: "../elsewhere.json" }]))));
  check("a missing file, a directory, no file given", /no file at/.test(err(load([{ op: "seedTokens", file: "nope.json" }]))) && /is not a file/.test(err(load([{ op: "seedTokens", file: "tokens" }])))
    && /ops\[0\]\.file: must be the path/.test(err(load([{ op: "seedTokens" }]))));
  check("seedTokens after an op that is not a create table is refused (it runs first)", /ops\[1\]: seedTokens goes before every other op of a batch \(it comes after ops\[0\], a createTree\)/.test(err(load([{ op: "createTree", tree: {} }, { op: "seedTokens", file: "tokens.dtcg.json" }]))));
  check("…but after a create table it is fine", "ops" in load([{ op: "createVariables", collection: "A", variables: [["a", "number", 1]] }, { op: "seedTokens", file: "tokens.dtcg.json" }]));
  const many = Array.from({ length: 49 }, () => ({ op: "createFrame" }));
  check("the 50-op cap counts the tables seedTokens made", /the batch is 51 ops once seedTokens made its tables \(2 from tokens\.dtcg\.json\)/.test(err(load([{ op: "seedTokens", file: "tokens.dtcg.json" }, ...many]))));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the reply
console.log("\nthe reply, cut to what changed:");
{
  const seeds: SeedRecord[] = [{ index: 0, file: "t.json", first: 0, count: 2, unmapped: [{ token: "motion/fast", reason: "a duration token has no Figma variable or style" }],
    tables: [{ collection: "Theme", names: ["a", "b", "c"] }, { collection: null, names: ["Body"] }] }];
  const r: WriteResult = { ok: true, applied: [
    { id: "C:1", result: "unchanged", rows: [["V:1", "unchanged"], ["V:2", "updated"], ["V:3", "created"]] },
    { rows: [["S:1", "unchanged"]] },
    { id: "9:1", created: { frames: 1, texts: 0 } },
  ] };
  const out = seededReply(r, seeds);
  check("a seed's tables are one entry at its op's index: only the created and updated rows, by name, and a count of the rest",
    same(out.applied, [
      { seeded: "t.json", tables: [{ collection: "Theme", id: "C:1", result: "unchanged", created: [["c", "V:3"]], updated: [["b", "V:2"]], unchanged: 1 }, { styles: true, unchanged: 1 }], unmapped: seeds[0]?.unmapped },
      { id: "9:1", created: { frames: 1, texts: 0 } },
    ]));
  const fail = seededReply({ ok: false, applied: [], failedAt: 1, failedOp: "createStyles", error: "ops[1] (createStyles): boom" }, seeds);
  check("a failure inside a seed's tables is that op's, and says which tables it became", fail.failedAt === 0 && fail.failedOp === "seedTokens" && /ops\[0\] \(seedTokens 't\.json'\) became ops\[0–1\] of the batch: createVariables 'Theme', createStyles/.test(fail.error ?? ""));
  check("a failure after it is given at the agent's own index", seededReply({ ok: false, applied: [], failedAt: 2, error: "x" }, seeds).failedAt === 1 && inputIndex(seeds, 2) === 1 && inputIndex(seeds, 1) === 0);
  const step = (index: number, op: WritePreviewStep["op"], extra: Partial<WritePreviewStep> = {}): WritePreviewStep => ({ index, op, effect: "creates", target: null, ...extra });
  const p = seededPreview({ dryRun: true, creates: 3, invalid: 0, steps: [step(0, "createVariables", { plan: { create: ["a"], update: [] } }), step(1, "createStyles"), step(2, "createTree")] }, seeds);
  const steps = Array.isArray(p.steps) ? (p.steps as Array<Record<string, unknown>>) : [];
  check("the dry run: one step for the seed (its tables' steps under it, the plan kept, the unmapped listed), the next at index 1",
    steps.length === 2 && steps[0]?.op === "seedTokens" && same(steps[0]?.unmapped, seeds[0]?.unmapped) && same((steps[0]?.tables as unknown[])[0], { op: "createVariables", effect: "creates", target: null, plan: { create: ["a"], update: [] } })
    && /seeds from 't\.json': collection 'Theme' \(3 variables\), 1 style; 1 token is not seeded/.test(String(steps[0]?.change)) && steps[1]?.index === 1 && p.creates === 2);
  check("nothing seeded: the reply and the preview are as they were", seededReply(r, []) === r);
}

report();
