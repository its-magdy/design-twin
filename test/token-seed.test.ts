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
import { isResolverDoc, MAX_SEED_COLLECTIONS, MAX_SEED_TOKENS, MAX_SEED_WORK, refProblem, resolverRefs, seedFromDtcg, seedFromResolver, type SeedOutcome, type SeedResult, type SeedRow, type SeedStylesOp, type SeedVariablesOp } from "../bridge/src/token-seed.ts";
import { inputIndex, loadSeedTokens, nodeSeedIo, readSeedJson, sameFile, seededPreview, seededReply, type SeedIo, type SeedRecord } from "../bridge/src/seed-file.ts";
import { MAX_SPEC_FILE_BYTES } from "../bridge/src/spec-file.ts";
import type { WritePreviewStep, WriteResult } from "../bridge/src/commands.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Every outcome a check looked at, for the closing check that each token is in one place. */
const looked = new Set<SeedOutcome>();
const res = (o: SeedOutcome): SeedResult => { looked.add(o); return "error" in o ? { ops: [], unmapped: [{ token: "(error)", reason: o.error }], partly: [] } : o; };
const tables = (o: SeedOutcome): SeedVariablesOp[] => res(o).ops.filter((x): x is SeedVariablesOp => x.op === "createVariables");
const stylesOf = (o: SeedOutcome): SeedStylesOp["styles"] => res(o).ops.find((x): x is SeedStylesOp => x.op === "createStyles")?.styles ?? [];
const rowOf = (o: SeedOutcome, name: string): SeedRow | undefined => tables(o).flatMap((t) => t.variables).find((r) => r[0] === name);
const reasonOf = (o: SeedOutcome, name: string): string => res(o).unmapped.find((u) => u.token === name)?.reason ?? "";
/** What a seeded token left out (its `partly` note), or "". */
const partOf = (o: SeedOutcome, name: string): string => res(o).partly.find((u) => u.token === name)?.reason ?? "";
const listed = (l: ReadonlyArray<{ token: string }>, name: string): number => l.filter((u) => u.token === name).length;
const dtcg = (text: string, collection?: string): SeedOutcome => seedFromDtcg(JSON.parse(text) as unknown, { collection });
/** Every seeded table passes the create tables' own shape check. */
/** No name in a table and in `unmapped`; no `partly` note for a name in no table; no row name in two tables. */
/** …no name both a row and a style; no `unmapped` entry that says the token is seeded; a `partly` note that names the
 *  collection a token is seeded from names the right one. */
const clean = (o: SeedOutcome): boolean => {
  if ("error" in o) return true;
  const rows = tables(o).flatMap((t) => t.variables.map((r) => r[0]));
  const styleNames = stylesOf(o).map((s) => s.name);
  const seeded = new Set<string>([...rows, ...styleNames]);
  const SAYS_SEEDED = /seeded from collection '|seeded once, in collection '|was seeded/;
  const from = (u: { token: string; reason: string }): boolean => {
    const m = /seeded (?:from|once, in) collection '([^']+)'/.exec(u.reason);
    return !m || styleNames.includes(u.token) || tables(o).some((t) => t.collection === m[1] && t.variables.some((r) => r[0] === u.token));
  };
  return rows.length === new Set(rows).size && styleNames.length === new Set(styleNames).size && !styleNames.some((s) => rows.includes(s))
    && o.unmapped.every((u) => !seeded.has(u.token) && !SAYS_SEEDED.test(u.reason)) && o.partly.every((u) => seeded.has(u.token) && from(u));
};
const valid = (o: SeedOutcome): boolean => res(o).ops.every((op) => (op.op === "createVariables" ? checkCreateVariables(op).problems.length === 0 : checkCreateStyles(op).problems.length === 0));
/** Words that would tell of a name moving between collections: there is no such move (a name only modifiers give is
 *  the first collection's, seeded there or not at all). */
const SEAT_MOVE = /in collection '[^']*': |\bseats?\b|moves? on|moved|tried (?:first|in)|by the next|a later collection/i;
/** What is false in an outcome's notes, or null: a note that says a target is not seeded when it is, one that tells of
 *  a seat move, or a "gives it too" note on a name seeded in another collection than the one it names. */
const notesTrue = (o: SeedOutcome): string | null => {
  if ("error" in o) return SEAT_MOVE.test(o.error) ? "a refusal tells of a seat move: " + o.error : null;
  const seededIn = new Map<string, string | null>();
  for (const t of tables(o)) for (const r of t.variables) seededIn.set(r[0], t.collection);
  for (const s of stylesOf(o)) seededIn.set(s.name, null);
  for (const u of [...o.unmapped, ...o.partly]) {
    if (SEAT_MOVE.test(u.reason)) return "a note tells of a seat move: " + JSON.stringify(u);
    const m = /\{([^{}]+)\}(?: names a token that is not seeded|, which is not seeded)/.exec(u.reason);
    if (m && m[1] && seededIn.has(m[1].split(".").join("/"))) return "a note says {" + m[1] + "} is not seeded, and it is: " + JSON.stringify(u);
    const f = /gives it too; only the first collection whose modifier gives it, '([^']*)', is read/.exec(u.reason);
    const at = seededIn.get(u.token);
    if (f && typeof at === "string" && at !== f[1]) return "a note names '" + f[1] + "' as the first collection, and the name is seeded in '" + at + "': " + JSON.stringify(u);
  }
  return null;
};

// ---------------------------------------------------------------- the round trip
console.log("\nthe round trip: a design system emitted by toDTCG and toResolver, read back:");
const FIXTURE = tokens({
  file: "Sample Library",
  collections: [
    { name: "Primitives", modes: ["Value"], default: "Value" },
    { name: "Theme", modes: ["Light", "Dark"], default: "Dark" },
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
  const bad = roundTrips(fromDtcg, (v) => (v.collection === "Theme" ? { name: "Brand (Dark / Light)", modes: ["Dark", "Light"] } : { name: "Brand", modes: [] }));
  check(`tokens.dtcg.json: every variable back with its name, type, value per mode and aliases${bad.length ? " (" + bad.slice(0, 4).join("; ") + ")" : ""}`, bad.length === 0);
  check("tokens.dtcg.json: the one-mode table first (the two-mode one aliases it), only the composed colour unmapped, every table valid",
    same(tables(fromDtcg).map((t) => t.collection), ["Brand", "Brand (Dark / Light)"]) && same(res(fromDtcg).unmapped.map((u) => u.token), [COMPOSED]) && valid(fromDtcg));
  // Theme's default is Dark, its values' first key Light: the default goes first, as the mode the plugin renames.
  const bgExt = (((tree as Record<string, Record<string, Record<string, unknown>>>).color?.bg?.$extensions ?? {}) as Record<string, Record<string, unknown>>)["figma.com"];
  check("toDTCG records the collection default as figma.com defaultMode (default ≠ the first key)", bgExt?.defaultMode === "Dark" && same(Object.keys(bgExt?.modes ?? {}), ["Light", "Dark"]));

  const { resolver, files } = toResolver(FIXTURE, []);
  const parsed = JSON.parse(JSON.stringify(resolver)) as unknown;
  const refs = resolverRefs(parsed);
  const loaded = new Map<string, unknown>();
  for (const r of "refs" in refs ? refs.refs : []) loaded.set(r, JSON.parse(JSON.stringify(files[r])) as unknown);
  const fromResolver = seedFromResolver(parsed, loaded);
  const badR = roundTrips(fromResolver, (v) => (v.collection === "Theme" ? { name: "Theme", modes: ["Dark", "Light"] } : { name: "Primitives", modes: [] }));
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
  check("a name two paths reach once joined with '/': the first seeded, the second in `partly`", rowOf(o, "a/b/c")?.[2] === 1 && /two paths make this name/.test(partOf(o, "a/b/c")) && reasonOf(o, "a/b/c") === "");
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
  const modesOf = (text: string): unknown => tables(dtcg(text)).map((t) => [t.collection, t.modes, t.variables]);
  check("the default mode goes first: a figma.com defaultMode", same(modesOf(`{ "a": { "$type": "number", "$value": 9, "$extensions": { "figma.com": { "defaultMode": "Dark", "modes": { "Light": 1, "Dark": 2 } } } } }`),
    [["Tokens", ["Dark", "Light"], [["a", "number", 2, 1]]]]));
  check("…else the one mode whose value is the $value", same(modesOf(`{ "a": { "$type": "number", "$value": 2, "$extensions": { "figma.com": { "modes": { "Light": 1, "Dark": 2 } } } } }`),
    [["Tokens", ["Dark", "Light"], [["a", "number", 2, 1]]]]));
  check("…else (no mode, or two, match) the key order", same(modesOf(`{ "a": { "$type": "number", "$value": 2, "$extensions": { "figma.com": { "modes": { "Light": 2, "Dark": 2 } } } }, "b": { "$type": "number", "$value": 5, "$extensions": { "figma.com": { "modes": { "Light": 3, "Dark": 4 } } } } }`),
    [["Tokens", ["Light", "Dark"], [["a", "number", 2, 2], ["b", "number", 3, 4]]]]));
  check("…a later token's clear default orders a group the first token left open", same(modesOf(`{ "a": { "$type": "number", "$value": 2, "$extensions": { "figma.com": { "modes": { "Light": 2, "Dark": 2 } } } }, "b": { "$type": "number", "$value": 4, "$extensions": { "figma.com": { "modes": { "Light": 3, "Dark": 4 } } } } }`),
    [["Tokens", ["Dark", "Light"], [["a", "number", 2, 2], ["b", "number", 4, 3]]]]));
  check("…the one mode whose value is the $value, whatever its keys' order", same(modesOf(`{ "a": { "$type": "color", "$value": { "colorSpace": "srgb", "components": [1, 0, 0], "alpha": 1 }, "$extensions": { "figma.com": { "modes": {
    "Dark": { "alpha": 1, "components": [0, 0, 0], "colorSpace": "srgb" }, "Light": { "components": [1, 0, 0], "colorSpace": "srgb", "alpha": 1 } } } } } }`),
    [["Tokens", ["Light", "Dark"], [["a", "color", "#ff0000", "#000000"]]]]));
  const over = dtcg(`{ "a": { "$type": "number", "$value": 1, "$extensions": { "figma.com": { "extensionOverrides": { "Sub": 2 } } } },
    "b": { "$type": "number", "$value": "nine", "$extensions": { "figma.com": { "extensionOverrides": { "Sub": 2 } } } } }`);
  check("extended-collection overrides: a seeded token's are in `partly`; a token not seeded keeps only its own reason",
    same(rowOf(over, "a"), ["a", "number", 1]) && /extended-collection overrides are not seeded/.test(partOf(over, "a")) && reasonOf(over, "a") === ""
    && listed(res(over).unmapped, "b") === 1 && !/overrides/.test(reasonOf(over, "b")) && partOf(over, "b") === "");
  const clash = dtcg(`{
    "p": { "$type": "number", "$value": 1 },
    "x": { "$type": "number", "$value": 1, "$extensions": { "figma.com": { "modes": { "A / B": 1, "C": 2 } } } },
    "y": { "$type": "number", "$value": 1, "$extensions": { "figma.com": { "modes": { "A": 1, "B / C": 2 } } } },
    "z": { "$type": "number", "$value": 1, "$extensions": { "figma.com": { "modes": { "x": 1, "y": 2 } } } }
  }`, "K (x / y)");
  const clashNames = tables(clash).map((t) => t.collection);
  check(`mode sets whose names join alike, and one named like the plain collection: every collection name unique (got ${JSON.stringify(clashNames)})`,
    same(clashNames, ["K (x / y)", "K (x / y) (A / B / C)", "K (x / y) (A / B / C) 2", "K (x / y) (x / y)"]) && valid(clash));
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
  check("a style that names a token the files do not have is listed, saying so", /fontSize names \{font\.size\.nope\}, and there is no such token here/.test(reasonOf(o, "type/broken")));
  const card = st.find((s) => s.name === "elevation/card"), stack = st.find((s) => s.name === "elevation/stack");
  check("a shadow token is an effect style, its colour and blur bound to their variables", same(card, { name: "elevation/card", kind: "effect", set: { effects: [
    { type: "drop_shadow", color: "#00000040", offset: { x: 0, y: 2 }, radius: 8, spread: 0, tokens: { color: "shadow/color", radius: "shadow/blur" } }] } }));
  check("a shadow list is one effect per layer; inset is an inner shadow", same(stack?.set.effects?.map((e) => e.type), ["drop_shadow", "inner_shadow"]));
  check("the styles come after the variables, one table; every table valid", res(o).ops.at(-1)?.op === "createStyles" && valid(o));
  // A style has no modes: the default mode's value is seeded, and another mode that differs is said.
  const moded = dtcg(`{
    "t": { "$type": "typography", "$value": { "fontFamily": "Inter", "fontSize": "16px" }, "$extensions": { "figma.com": { "defaultMode": "Light",
      "modes": { "Dark": { "fontFamily": "Inter", "fontSize": "18px" }, "Light": { "fontFamily": "Inter", "fontSize": "16px" } } } } },
    "u": { "$type": "typography", "$value": { "fontFamily": "Inter", "fontSize": "12px" }, "$extensions": { "figma.com": { "modes": { "Light": { "fontFamily": "Inter", "fontSize": "12px" }, "Dark": { "fontFamily": "Inter", "fontSize": "12px" } } } } }
  }`);
  check("a typography token with modes: the default's value is the style, and the differing mode is in `partly`, not `unmapped`",
    same(stylesOf(moded).find((s) => s.name === "t")?.set, { font: "Inter", size: 16 }) && /a style has no modes; only the 'Light' value was seeded \('Dark' differs\)/.test(partOf(moded, "t"))
    && reasonOf(moded, "t") === "" && stylesOf(moded).some((s) => s.name === "u") && partOf(moded, "u") === "" && res(moded).unmapped.length === 0);
  // A style whose other mode fails: only the failure is said (it is in no table), never "was seeded".
  const failed = dtcg(`{ "n": { "$type": "number", "$value": 1 }, "t": { "$type": "typography", "$value": { "fontFamily": "Inter", "fontSize": "16px" }, "$extensions": { "figma.com": { "defaultMode": "Light",
    "modes": { "Dark": { "fontFamily": "Inter", "fontSize": "18px" }, "Light": { "fontSize": "{font.size.nope}" } } } } } }`);
  check("a style with modes that cannot be made: one `unmapped` entry (its own reason), no `partly` note",
    listed(res(failed).unmapped, "t") === 1 && /fontSize names \{font\.size\.nope\}/.test(reasonOf(failed, "t")) && listed(res(failed).partly, "t") === 0 && !stylesOf(failed).some((s) => s.name === "t"));
  // The same fields in another order are the same value.
  const reordered = dtcg(`{ "t": { "$type": "typography", "$value": { "fontFamily": "Inter", "fontSize": "16px" }, "$extensions": { "figma.com": { "defaultMode": "Light",
    "modes": { "Light": { "fontFamily": "Inter", "fontSize": "16px" }, "Dark": { "fontSize": "16px", "fontFamily": "Inter" } } } } } }`);
  check("a style mode with the same fields in another order is not said to differ", stylesOf(reordered).some((s) => s.name === "t") && partOf(reordered, "t") === "" && res(reordered).unmapped.length === 0);
  const doc = (x: object): unknown => JSON.parse(JSON.stringify(x)) as unknown;
  const rs = seedFromResolver(doc({
    sets: { Core: { sources: [{ shadow: { $type: "shadow", $value: { color: "#000000", offsetX: "0px", offsetY: "1px", blur: "2px" } }, gap: { $type: "number", $value: 1 } }] } },
    modifiers: { theme: { contexts: { light: [], dark: [{ shadow: { $type: "shadow", $value: { color: "#ffffff", offsetX: "0px", offsetY: "1px", blur: "2px" } } }] }, default: "light" } },
    resolutionOrder: [{ $ref: "#/sets/Core" }, { $ref: "#/modifiers/theme" }],
  }), new Map());
  check("a shadow a resolver context overrides: the default's value is the style, the context listed",
    same(stylesOf(rs).find((s) => s.name === "shadow")?.set.effects?.map((e) => ("color" in e ? e.color : null)), ["#000000"]) && /only the 'light' value was seeded \('dark' differs\)/.test(partOf(rs, "shadow")) && reasonOf(rs, "shadow") === "");
}

console.log("\na token with children:");
{
  const o = dtcg(`{ "color": { "$type": "color", "$value": "#ffffff", "hover": { "$value": "#000000", "deep": { "$value": "#111111" } }, "group": { "x": { "$value": "#222222" } } }, "ok": { "$type": "number", "$value": 1 } }`);
  check("a token's own children are listed (a token and a group cannot share a name; $root is the group's token), the token seeded",
    same(rowOf(o, "color"), ["color", "color", "#ffffff"]) && ["color/hover", "color/hover/deep", "color/group/x"].every((n) => /inside token 'color'.*\$root/.test(reasonOf(o, n)))
    && !rowOf(o, "color/hover") && same(rowOf(o, "ok"), ["ok", "number", 1]));
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
  check("an extended collection's override modifier (its collection has no set) is in `partly`, the base seeded", same(rowOf(ext, "a"), ["a", "number", 1]) && /extended collection's overrides are not seeded/.test(partOf(ext, "a")) && reasonOf(ext, "a") === "");
  const extOnly = seedFromResolver(doc({
    sets: { Core: { sources: [{ a: { $type: "number", $value: 1 } }] } },
    modifiers: { Sub: { contexts: { none: [], One: [{ z: { $type: "number", $value: 2 } }] }, default: "none", $extensions: { "figma.com": { collection: "Sub" } } } },
    resolutionOrder: [{ $ref: "#/sets/Core" }, { $ref: "#/modifiers/Sub" }],
  }), new Map());
  check("…and a token only such a modifier has is in `unmapped`", /extended collection's overrides are not seeded/.test(reasonOf(extOnly, "z")) && partOf(extOnly, "z") === "");
  const cross = seedFromResolver(doc({
    sets: { A: { sources: [{ a1: { $type: "number", $value: 1 }, a2: { $type: "number", $value: "{b1}" } }] }, B: { sources: [{ b1: { $type: "number", $value: 2 }, b2: { $type: "number", $value: "{a1}" } }] } },
    resolutionOrder: [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }],
  }), new Map());
  check("two collections that alias each other: the alias that would need the later table is listed, the rest valid", (rowOf(cross, "a2") === undefined) !== (rowOf(cross, "b2") === undefined)
    && /which aliases this one too/.test(reasonOf(cross, "a2") + reasonOf(cross, "b2")) && valid(cross));
  const twice = seedFromResolver(doc({ sets: { A: { sources: [{ x: { $type: "number", $value: 1 } }] }, B: { sources: [{ x: { $type: "number", $value: 2 } }] } }, resolutionOrder: [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }] }), new Map());
  check("a token two sets give is seeded once, in the first, and the second in `partly`", same(rowOf(twice, "x"), ["x", "number", 1]) && /seeded once, in collection 'A'/.test(partOf(twice, "x")) && reasonOf(twice, "x") === "");
  check("$ref refusals: a URL, an absolute path, a pointer, a fragment", /URL/.test(refProblem("https://example.com/t.json") ?? "") && /absolute/.test(refProblem("/etc/t.json") ?? "")
    && /points into the resolver/.test(refProblem("#/sets/x") ?? "") && /#fragment/.test(refProblem("t.json#/a") ?? "") && refProblem("tokens/t.json") === null && /URL or a drive path/.test(refProblem("C:\\t.json") ?? ""));
  const bad = resolverRefs(doc({ sets: { A: { sources: [{ $ref: "https://example.com/t.json" }] } }, resolutionOrder: [{ $ref: "#/sets/A" }] }));
  check("a resolver with such a $ref is refused, naming the set", "error" in bad && /^set 'A': 'https:\/\/example\.com\/t\.json' is a URL/.test(bad.error));
  const noSet = resolverRefs(doc({ sets: {}, resolutionOrder: [{ $ref: "#/sets/missing" }] }));
  check("a resolution order naming a set that is not there is refused", "error" in noSet && /names nothing in the resolver/.test(noSet.error));
}

// ---------------------------------------------------------------- every token in one place
console.log("\nevery token is in a table (perhaps with a `partly` note) or in `unmapped`, never both:");
{
  const doc = (o: object): unknown => JSON.parse(JSON.stringify(o)) as unknown;
  const theme = { $extensions: { "figma.com": { collection: "Theme" } } };
  const order = [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }];
  const typeClash = seedFromResolver(doc({ sets: { A: { sources: [{ x: { $type: "number", $value: 1 }, ok: { $type: "number", $value: 3 } }], ...theme }, B: { sources: [{ x: { $type: "color", $value: "#ffffff" } }], ...theme } }, resolutionOrder: order }), new Map());
  check(`two sets of one collection give a token: the first set's token is seeded whole (type and value), the second in \`partly\` (${JSON.stringify(res(typeClash))})`,
    same(rowOf(typeClash, "x"), ["x", "number", 1]) && /set 'B' has it too/.test(partOf(typeClash, "x")) && reasonOf(typeClash, "x") === "" && clean(typeClash));
  const valueClash = seedFromResolver(doc({ sets: { A: { sources: [{ x: { $type: "number", $value: 1 } }], ...theme }, B: { sources: [{ x: { $type: "number", $value: 2 } }], ...theme } }, resolutionOrder: order }), new Map());
  check("…and with two numbers, the first is seeded and the second is said", same(rowOf(valueClash, "x"), ["x", "number", 1]) && /set 'B' has it too/.test(partOf(valueClash, "x")) && clean(valueClash));
  const ctxTwice = seedFromResolver(doc({
    sets: { A: { sources: [{ a: { $type: "number", $value: 1 } }] }, B: { sources: [{ b: { $type: "number", $value: 1 } }] } },
    modifiers: {
      ma: { contexts: { l: [{ n: { $type: "number", $value: 1 } }], d: [{ n: { $type: "number", $value: 2 } }] }, default: "l", $extensions: { "figma.com": { collection: "A" } } },
      mb: { contexts: { l: [{ n: { $type: "number", $value: 3 } }], d: [{ n: { $type: "number", $value: 4 } }] }, default: "l", $extensions: { "figma.com": { collection: "B" } } },
    },
    resolutionOrder: [...order, { $ref: "#/modifiers/ma" }, { $ref: "#/modifiers/mb" }],
  }), new Map());
  check(`a token only modifiers give, in two collections: seeded once, in the first, the other in \`partly\` (${JSON.stringify(tables(ctxTwice).map((t) => t.variables))})`,
    same(rowOf(ctxTwice, "n"), ["n", "number", 1, 2]) && /modifier 'mb' gives it too; only the first collection whose modifier gives it, 'A', is read/.test(partOf(ctxTwice, "n")) && clean(ctxTwice));

  const one = dtcg(`{"n":{"$type":"number","$value":1,"$extensions":{"figma.com":{"modes":{"Only":2}}}},"c":{"$type":"color","$value":"#ffffff","$extensions":{"figma.com":{"modes":{"Only":"#000000"},"modeOpacity":{"Only":50}}}},"t":{"$type":"typography","$value":{"fontFamily":"Inter","fontSize":"16px"},"$extensions":{"figma.com":{"modes":{"Only":{"fontFamily":"Inter","fontSize":"18px"}}}}}}`);
  check(`a token with one mode: its mode's value (and that mode's opacity) for a variable and a style alike, a $value that differs in \`partly\` (${JSON.stringify(res(one))})`,
    same(rowOf(one, "n"), ["n", "number", 2]) && same(rowOf(one, "c"), ["c", "color", "#00000080"]) && stylesOf(one).find((s) => s.name === "t")?.set.size === 18
    && ["n", "c", "t"].every((k) => /its \$value differs from its one mode 'Only'/.test(partOf(one, k))) && res(one).unmapped.length === 0 && clean(one));
  const oneSame = dtcg(`{"n":{"$type":"number","$value":2,"$extensions":{"figma.com":{"modes":{"Only":2}}}}}`);
  check("…and a one-mode token whose $value is its mode's value says nothing", same(rowOf(oneSame, "n"), ["n", "number", 2]) && res(oneSame).partly.length === 0);

  const ext = dtcg(`{"color":{"$extends":"{palette}","$root":{"$type":"color","$value":"#ffffff"},"bg":{"$type":"color","$value":"#000000"}}}`);
  check(`a group's $extends, the group's own token seeded: in \`partly\`, not \`unmapped\` (${JSON.stringify(res(ext))})`,
    same(rowOf(ext, "color"), ["color", "color", "#ffffff"]) && /\$extends is not read/.test(partOf(ext, "color")) && reasonOf(ext, "color") === "" && clean(ext));
  const extGroup = dtcg(`{"color":{"$extends":"{palette}","bg":{"$type":"color","$value":"#000000"}}}`);
  check("…and with no token of its own, in `unmapped`", /\$extends is not read/.test(reasonOf(extGroup, "color")) && clean(extGroup));
  const slash = dtcg(`{"a":{"$type":"color","$value":"#ffffff","b":{"$value":"#000000"}},"a/b":{"$type":"color","$value":"#111111"}}`);
  check(`a token inside a token, its name seeded by a key with '/': the seeded one keeps a \`partly\` note, not an \`unmapped\` one (${JSON.stringify(res(slash))})`,
    same(rowOf(slash, "a/b"), ["a/b", "color", "#111111"]) && /inside token 'a'/.test(partOf(slash, "a/b")) && reasonOf(slash, "a/b") === "" && clean(slash));
  const notNode = dtcg(`{"a":{"b":3},"a/b":{"$type":"number","$value":1}}`);
  check("…and a value that is neither a token nor a group, its name seeded the same way", same(rowOf(notNode, "a/b"), ["a/b", "number", 1]) && /neither a token/.test(partOf(notNode, "a/b")) && clean(notNode));
  const empty = dtcg(`{"a":{"":{"$type":"number","$value":1}},"a/":{"$type":"number","$value":2}}`);
  check("…and an empty name", same(rowOf(empty, "a/"), ["a/", "number", 2]) && /an empty name/.test(partOf(empty, "a/")) && clean(empty));
}

console.log("\nthe default mode types a token, and a name is claimed only once it is seeded:");
{
  const doc = (o: object): unknown => JSON.parse(JSON.stringify(o)) as unknown;
  const core = { Core: { sources: [{ keep: { $type: "number", $value: 1 } }] } };
  const order = [{ $ref: "#/sets/Core" }, { $ref: "#/modifiers/theme" }];
  /** A token only modifier `theme` (of Core) gives: `dark` listed first, `light` the default. */
  const onlyCtx = (dark: object, light: object): SeedOutcome => seedFromResolver(doc({ sets: core,
    modifiers: { theme: { contexts: { dark: [{ x: dark }], light: [{ x: light }] }, default: "light", $extensions: { "figma.com": { collection: "Core" } } } },
    resolutionOrder: order }), new Map());
  const wrong = onlyCtx({ $type: "string", $value: "from-dark" }, { $type: "color", $value: "#ffffff" });
  check(`a token only contexts give is typed by the default context, not the first one listed; a context of another $type is refused (${JSON.stringify(res(wrong))})`,
    rowOf(wrong, "x") === undefined && /modifier 'theme' gives it \$type 'string' in context 'dark', and the default context 'light' makes it a color token/.test(reasonOf(wrong, "x"))
    && same(rowOf(wrong, "keep"), ["keep", "number", 1, 1]) && clean(wrong));
  const bool = onlyCtx({ $value: "false" }, { $type: "string", $value: "true", $extensions: { "figma.com": { originalType: "boolean" } } });
  check(`…a default-mode boolean stays a boolean (${JSON.stringify(res(bool))})`, same(rowOf(bool, "x"), ["x", "boolean", true, false]) && clean(bool));
  const colour = onlyCtx({ $value: "#000000" }, { $type: "color", $value: "#ffffff" });
  check(`…a $type only the default context gives types it, an untyped earlier context notwithstanding (${JSON.stringify(res(colour))})`, same(rowOf(colour, "x"), ["x", "color", "#ffffff", "#000000"]) && clean(colour));
  const setTyped = seedFromResolver(doc({ sets: { Core: { sources: [{ x: { $type: "number", $value: 1 }, keep: { $type: "number", $value: 1 } }] } },
    modifiers: { theme: { contexts: { light: [], dark: [{ x: { $type: "color", $value: "#000000" } }] }, default: "light" } }, resolutionOrder: order }), new Map());
  check(`a set's token a context gives another $type: refused, saying so (${JSON.stringify(res(setTyped))})`,
    rowOf(setTyped, "x") === undefined && /gives it \$type 'color' in context 'dark', and its set makes it a number token/.test(reasonOf(setTyped, "x")) && clean(setTyped));

  // An alias to a token only a later collection's modifier gives is typed by that modifier's default context too.
  const aliasLater = seedFromResolver(doc({
    sets: { A: { sources: [{ r: { $value: "{n}" } }] }, B: { sources: [{ b: { $type: "number", $value: 1 } }] } },
    modifiers: { mb: { contexts: { d: [{ n: { $value: 4 } }], l: [{ n: { $type: "number", $value: 3 } }] }, default: "l", $extensions: { "figma.com": { collection: "B" } } } },
    resolutionOrder: [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }, { $ref: "#/modifiers/mb" }],
  }), new Map());
  check(`an alias to a token only a modifier gives takes the default context's type (${JSON.stringify(res(aliasLater))})`,
    same(rowOf(aliasLater, "r"), ["r", "number", { aliasOf: "n" }]) && same(rowOf(aliasLater, "n"), ["n", "number", 3, 4]) && clean(aliasLater));

  // A token only modifiers give is the first collection's: one that cannot seed it leaves it unseeded (never for a
  // later one), its reason the first's and the later modifier's value said beside it.
  const NOTED_B = /modifier 'mb' gives it too; only the first collection whose modifier gives it, 'A', is read/;
  const two = { A: { sources: [{ a: { $type: "number", $value: 1 } }] }, B: { sources: [{ b: { $type: "number", $value: 1 } }] } };
  const twoOrder = [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }, { $ref: "#/modifiers/ma" }, { $ref: "#/modifiers/mb" }];
  const mb = { contexts: { l: [{ n: { $type: "number", $value: 3 } }], d: [{ n: { $type: "number", $value: 4 } }] }, default: "l", $extensions: { "figma.com": { collection: "B" } } };
  const noDefault = seedFromResolver(doc({ sets: two, modifiers: {
    ma: { contexts: { l: [], d: [{ n: { $type: "number", $value: 2 } }] }, default: "l", $extensions: { "figma.com": { collection: "A" } } }, mb }, resolutionOrder: twoOrder }), new Map());
  /** `n` not seeded: its reasons in `unmapped` are the first collection's (`why`) and the later modifier's note. */
  const notSeeded = (o: SeedOutcome, why: RegExp, name = "n"): boolean => {
    const rs = res(o).unmapped.filter((u) => u.token === name).map((u) => u.reason);
    return rowOf(o, name) === undefined && rs.length === 2 && why.test(rs[0] ?? "") && NOTED_B.test(rs[1] ?? "") && partOf(o, name) === "" && clean(o);
  };
  check(`a token the first collection has no default value for is not seeded, the next not tried (${JSON.stringify(res(noDefault))})`,
    notSeeded(noDefault, /^no value in the default mode 'l' of modifier 'ma'$/));
  const badFirst = seedFromResolver(doc({ sets: two, modifiers: {
    ma: { contexts: { l: [{ n: { $type: "number", $value: "nine" } }], d: [] }, default: "l", $extensions: { "figma.com": { collection: "A" } } }, mb }, resolutionOrder: twoOrder }), new Map());
  check(`…and one it cannot read: not seeded, for the first collection's reason (${JSON.stringify(res(badFirst))})`,
    notSeeded(badFirst, /^not a number/));
  const neither = seedFromResolver(doc({ sets: two, modifiers: {
    ma: { contexts: { l: [{ n: { $type: "number", $value: "nine" } }], d: [] }, default: "l", $extensions: { "figma.com": { collection: "A" } } },
    mb: { contexts: { l: [{ n: { $type: "number", $value: "ten" } }], d: [] }, default: "l", $extensions: { "figma.com": { collection: "B" } } } }, resolutionOrder: twoOrder }), new Map());
  check(`…and when neither can, only the first's reason is given (the second is not read) (${JSON.stringify(res(neither))})`,
    notSeeded(neither, /^not a number: "nine"/) && !/ten/.test(JSON.stringify(res(neither))));

  // A style that aliases another takes the value that one is seeded with (its default mode's), not its $value.
  const oneModeAlias = dtcg(`{ "t": { "$type": "typography", "$value": { "fontFamily": "Inter", "fontSize": "16px" }, "$extensions": { "figma.com": { "modes": { "Only": { "fontFamily": "Inter", "fontSize": "18px" } } } } },
    "u": { "$type": "typography", "$value": "{t}" } }`);
  check(`a style aliasing a one-mode style takes the mode's value, as that style does (${JSON.stringify(stylesOf(oneModeAlias))})`,
    stylesOf(oneModeAlias).find((s) => s.name === "t")?.set.size === 18 && stylesOf(oneModeAlias).find((s) => s.name === "u")?.set.size === 18 && clean(oneModeAlias));
  const ctxAlias = seedFromResolver(doc({
    sets: { Core: { sources: [{ t: { $type: "typography", $value: { fontFamily: "Inter", fontSize: "16px" } }, u: { $type: "typography", $value: "{t}" } }] } },
    modifiers: { theme: { contexts: { dark: [], light: [{ t: { $type: "typography", $value: { fontFamily: "Inter", fontSize: "18px" } } }] }, default: "light" } }, resolutionOrder: order,
  }), new Map());
  check(`…and one whose default context overrides it (${JSON.stringify(stylesOf(ctxAlias))})`,
    stylesOf(ctxAlias).find((s) => s.name === "t")?.set.size === 18 && stylesOf(ctxAlias).find((s) => s.name === "u")?.set.size === 18 && clean(ctxAlias));
}

console.log("\na $value on the document root, and opacity:");
{
  const root = dtcg(`{ "$type": "color", "$value": "#ff0000", "bg": { "$value": "#00ff00" } }`);
  check(`a $value on the root is a token with no name; what is under it is inside it (${"error" in root ? root.error : "seeded"})`,
    "error" in root && /'bg': it is inside token '\$root'.*'\$root': a token needs a name/.test(root.error));
  const rootOnly = dtcg(`{ "$type": "color", "$value": "#ff0000" }`);
  check(`…and a file of only that is refused for that reason, not as empty (${"error" in rootOnly ? rootOnly.error : "seeded"})`, "error" in rootOnly && /'\$root': a token needs a name/.test(rootOnly.error));
  const opac = dtcg(`{ "c": { "$type": "color", "$value": "#000000", "$extensions": { "figma.com": { "modes": { "Only": "#000000" }, "modeOpacity": { "Only": 50 } } } } }`);
  check(`a one-mode colour whose mode differs only in opacity: the note says the opacity differs (${JSON.stringify(res(opac))})`,
    same(rowOf(opac, "c"), ["c", "color", "#00000080"]) && /the opacity of its one mode 'Only' differs from its own; the mode's opacity was seeded/.test(partOf(opac, "c")) && !/\$value differs/.test(partOf(opac, "c")));
  const shadow = dtcg(`{ "s": { "$type": "shadow", "$value": { "color": "#000000", "offsetX": "0px", "offsetY": "1px", "blur": "2px" }, "$extensions": { "figma.com": {
    "modes": { "Only": { "color": "#000000", "offsetX": "0px", "offsetY": "1px", "blur": "2px" } }, "modeOpacity": { "Only": 50 } } } } }`);
  check(`a style's figma.com opacity is not applied, and said (${JSON.stringify(res(shadow))})`,
    same(stylesOf(shadow).find((s) => s.name === "s")?.set.effects?.map((e) => ("color" in e ? e.color : null)), ["#000000"]) && /a style takes no figma\.com opacity/.test(partOf(shadow, "s")) && !/the mode's opacity was seeded/.test(partOf(shadow, "s")) && clean(shadow));
}

console.log("\nround 5: every skip path lists what is under it; a name only modifiers give is the first collection's:");
{
  const doc = (o: object): unknown => JSON.parse(JSON.stringify(o)) as unknown;
  const rootGroup = dtcg(`{ "$root": { "a": { "$type": "color", "$value": "#ffffff" } } }`);
  check(`a $root with no $value is read as the group itself (${JSON.stringify(res(rootGroup))})`, same(rowOf(rootGroup, "a"), ["a", "color", "#ffffff"]) && res(rootGroup).unmapped.length === 0 && clean(rootGroup));
  const rootTok = dtcg(`{ "$type": "number", "$value": 1, "$root": { "$value": 2, "c": { "$value": 3 } }, "bg": { "$value": 4 } }`);
  check(`a token document root: its $root token, that one's child and its other child are each listed (${"error" in rootTok ? rootTok.error : "seeded"})`,
    "error" in rootTok && /'\$root': it is inside token '\$root'.*'\$root\/c': it is inside token '\$root'.*'bg': it is inside token '\$root'.*and 1 more/.test(rootTok.error));
  const nested = dtcg(`{ "color": { "$type": "color", "$value": "#ffffff", "$root": { "$value": "#000000" } }, "g": { "$type": "number", "$root": { "$value": 1, "c": { "$value": 2 } }, "d": { "$value": 3 } }, "h": { "$root": 5, "x": { "$type": "number", "$value": 1 } } }`);
  check(`a $root inside a token is listed; a group's own token's child is inside it; a $root that is no node is listed (${JSON.stringify(res(nested))})`,
    same(rowOf(nested, "color"), ["color", "color", "#ffffff"]) && /inside token 'color'/.test(reasonOf(nested, "color/$root"))
    && same(rowOf(nested, "g"), ["g", "number", 1]) && /inside token 'g'/.test(reasonOf(nested, "g/$root/c")) && same(rowOf(nested, "g/d"), ["g/d", "number", 3])
    && /its \$root is neither a token/.test(reasonOf(nested, "h")) && same(rowOf(nested, "h/x"), ["h/x", "number", 1]) && clean(nested));
  const badSeg = dtcg(`{ "a.b": { "c": { "$type": "color", "$value": "#ffffff" }, "d": { "e": { "$type": "number", "$value": 1 } } }, "": { "$type": "number", "$value": 1, "f": { "$value": 2 } }, "ok": { "$type": "number", "$value": 1 } }`);
  check(`a name no alias could spell: every token under it is listed, the group itself not (${JSON.stringify(res(badSeg))})`,
    /under 'a\.b', which has a name with '\.'/.test(reasonOf(badSeg, "a.b/c")) && /under 'a\.b'/.test(reasonOf(badSeg, "a.b/d/e")) && reasonOf(badSeg, "a.b") === ""
    && /an empty name/.test(reasonOf(badSeg, "")) && /under '', which has an empty name/.test(reasonOf(badSeg, "/f")) && same(rowOf(badSeg, "ok"), ["ok", "number", 1]) && clean(badSeg));

  // The first collection (in the sets' order, whatever the modifiers' order) owns a name only modifiers give: one that
  // cannot seed it leaves it unseeded, and an alias to it is said to name a token that is not seeded.
  const NOTED_B = /modifier 'mb' gives it too; only the first collection whose modifier gives it, 'A', is read/;
  const typedBy = (mbFirst: boolean): SeedOutcome => {
    const ma = { contexts: { l: [{ z: { $type: "color", $value: "nope" } }], d: [] }, default: "l", $extensions: { "figma.com": { collection: "A" } } };
    const mb = { contexts: { l: [{ z: { $type: "number", $value: 4 } }], d: [{ z: { $type: "number", $value: 5 } }] }, default: "l", $extensions: { "figma.com": { collection: "B" } } };
    return seedFromResolver(doc({
      sets: { A: { sources: [{ a: { $value: "{z}" }, keep: { $type: "number", $value: 1 } }] }, B: { sources: [{ b: { $type: "number", $value: 1 } }] } },
      modifiers: { ma, mb },
      resolutionOrder: [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }, ...(mbFirst ? [{ $ref: "#/modifiers/mb" }, { $ref: "#/modifiers/ma" }] : [{ $ref: "#/modifiers/ma" }, { $ref: "#/modifiers/mb" }])],
    }), new Map());
  };
  for (const mbFirst of [false, true]) {
    const o = typedBy(mbFirst);
    const zs = res(o).unmapped.filter((u) => u.token === "z").map((u) => u.reason);
    check(`a name the first collection cannot seed is not seeded, and an alias to it says so (modifiers ${mbFirst ? "mb, ma" : "ma, mb"}: ${JSON.stringify(res(o))})`,
      rowOf(o, "z") === undefined && rowOf(o, "a") === undefined && zs.length === 2 && /^not a colour/.test(zs[0] ?? "") && NOTED_B.test(zs[1] ?? "")
      && /^its alias \{z\} names a token that is not seeded$/.test(reasonOf(o, "a")) && clean(o) && valid(o));
  }
  const two = { A: { sources: [{ a: { $type: "number", $value: 1 } }] }, B: { sources: [{ b: { $type: "number", $value: 1 } }] } };
  const twoOrder = [{ $ref: "#/sets/A" }, { $ref: "#/sets/B" }, { $ref: "#/modifiers/ma" }, { $ref: "#/modifiers/mb" }];
  const pair = (inA: object, inB: object, inBd: object): SeedOutcome => seedFromResolver(doc({ sets: two, modifiers: {
    ma: { contexts: { l: [inA], d: [] }, default: "l", $extensions: { "figma.com": { collection: "A" } } },
    mb: { contexts: { l: [inB], d: [inBd] }, default: "l", $extensions: { "figma.com": { collection: "B" } } } }, resolutionOrder: twoOrder }), new Map());
  const style = pair({ t: { $type: "typography", $value: { fontSize: "{missing}" } } }, { t: { $type: "typography", $value: { fontFamily: "Inter", fontSize: "18px" } } }, {});
  /** Not seeded: the first collection's reason, then the later modifier's note. */
  const firstOnly = (o: SeedOutcome, name: string, why: RegExp): boolean => {
    const rs = res(o).unmapped.filter((u) => u.token === name).map((u) => u.reason);
    return rs.length === 2 && why.test(rs[0] ?? "") && NOTED_B.test(rs[1] ?? "") && partOf(o, name) === "" && clean(o);
  };
  check(`a style the first collection cannot make is not made by the next (${JSON.stringify(res(style))})`,
    !stylesOf(style).some((s) => s.name === "t") && firstOnly(style, "t", /^fontSize names \{missing\}/));
  const dropped = pair({ n: { $type: "number", $value: "{missing}" } }, { n: { $type: "number", $value: 3 } }, { n: { $type: "number", $value: 4 } });
  check(`…and a row the alias check drops (${JSON.stringify(res(dropped))})`,
    rowOf(dropped, "n") === undefined && firstOnly(dropped, "n", /^its alias \{missing\} names no token here$/));

  // The one-mode opacity note is said only of a colour whose seeded cell carries that opacity.
  const op = dtcg(`{ "base": { "$type": "color", "$value": "#000000" },
    "n": { "$type": "number", "$value": 2, "$extensions": { "figma.com": { "modes": { "Only": 2 }, "modeOpacity": { "Only": 30 }, "opacity": 50 } } },
    "s": { "$type": "string", "$value": "x", "$extensions": { "figma.com": { "modes": { "Only": "x" }, "modeOpacity": { "Only": 30 } } } },
    "c": { "$type": "color", "$value": "{base}", "$extensions": { "figma.com": { "modes": { "Only": "{base}" }, "modeOpacity": { "Only": 100 }, "opacity": 40 } } },
    "k": { "$type": "color", "$value": "#000000", "$extensions": { "figma.com": { "modes": { "Only": "#000000" }, "modeOpacity": { "Only": 50 } } } } }`);
  check(`no opacity note on a number, a string, or a colour alias seeded bare; one on a colour that takes it (${JSON.stringify(res(op))})`,
    same(rowOf(op, "n"), ["n", "number", 2]) && same(rowOf(op, "s"), ["s", "string", "x"]) && same(rowOf(op, "c"), ["c", "color", { aliasOf: "base" }])
    && ["n", "s", "c"].every((k) => partOf(op, k) === "") && same(rowOf(op, "k"), ["k", "color", "#00000080"]) && /the mode's opacity was seeded/.test(partOf(op, "k")) && clean(op));
}

console.log("\nround 7: a name only modifiers give is the first collection's, seeded there or not at all, in one build:");
{
  const r7 = (text: string): SeedOutcome => seedFromResolver(JSON.parse(text) as unknown, new Map());
  const KEEP = `{"keep":{"$type":"number","$value":1}}`;
  const reasons = (o: SeedOutcome, name: string): string[] => res(o).unmapped.filter((u) => u.token === name).map((u) => u.reason);
  const NOTED = /^modifier 'B' gives it too; only the first collection whose modifier gives it, 'A', is read$/;
  /** The two cases of round 7's review, A's `y` given: `x` and `y` only A's and B's modifiers give, A first. */
  const blocker = (y: object, aSources = "[]"): string => `{"sets":{"A":{"sources":${aSources}},"B":{"sources":[]}},"modifiers":{"A":{"contexts":{"d":[{"x":{"$type":"number","$value":"{y}"},"y":${JSON.stringify(y)}}]}},"B":{"contexts":{"d":[{"y":{"$type":"number","$value":7}}]}}}}`;
  const LOOP_Y = { $type: "number", $value: "{x}" }, MISSING_Y = { $type: "string", $value: "{missing}" };

  const loop = r7(blocker(LOOP_Y));
  check(`an alias loop A owns: nothing seeded, so refused, listing both loop entries and B's value as a note (${"error" in loop ? loop.error : "seeded"})`,
    "error" in loop && /^no token in the resolver could be seeded \('x': its aliases loop: 'x' → 'y' → 'x'; 'y': its aliases loop: 'x' → 'y' → 'x'; 'y': modifier 'B' gives it too; only the first collection whose modifier gives it, 'A', is read\)$/.test(loop.error)
    && notesTrue(loop) === null);
  const loopKeep = r7(blocker(LOOP_Y, "[" + KEEP + "]"));
  check(`…with a token that seeds beside them: x and y unmapped ("aliases loop"), B's y a note on y's entry (${JSON.stringify(res(loopKeep))})`,
    rowOf(loopKeep, "x") === undefined && rowOf(loopKeep, "y") === undefined && same(reasons(loopKeep, "x"), ["its aliases loop: 'x' → 'y' → 'x'"])
    && reasons(loopKeep, "y").length === 2 && /aliases loop/.test(reasons(loopKeep, "y")[0] ?? "") && NOTED.test(reasons(loopKeep, "y")[1] ?? "")
    && res(loopKeep).partly.length === 0 && same(tables(loopKeep).map((t) => t.collection), ["A"]) && clean(loopKeep) && notesTrue(loopKeep) === null);
  const missing = r7(blocker(MISSING_Y));
  check(`A's y a string aliasing nothing: refused, every note true (${"error" in missing ? missing.error : "seeded"})`,
    "error" in missing && /^no token in the resolver could be seeded \('x': its alias \{y\} names a string token, and it is a number one; 'y': its alias \{missing\} names no token here; 'y': modifier 'B' gives it too; only the first collection whose modifier gives it, 'A', is read\)$/.test(missing.error)
    && notesTrue(missing) === null);
  const missingKeep = r7(blocker(MISSING_Y, "[" + KEEP + "]"));
  check(`…with a token that seeds beside them: the same three entries, each true of the result (${JSON.stringify(res(missingKeep))})`,
    same(reasons(missingKeep, "x"), ["its alias {y} names a string token, and it is a number one"]) && same(reasons(missingKeep, "y").slice(0, 1), ["its alias {missing} names no token here"])
    && NOTED.test(reasons(missingKeep, "y")[1] ?? "") && rowOf(missingKeep, "y") === undefined && same(rowOf(missingKeep, "keep"), ["keep", "number", 1]) && clean(missingKeep) && notesTrue(missingKeep) === null);

  // A later collection that could seed the name never does: the alias to it is unmapped, saying so (truly).
  const chain = r7(`{"sets":{"A":{"sources":[${KEEP}]},"B":{"sources":[]}},"modifiers":{"A":{"contexts":{"L":[{"x":{"$type":"number","$value":"{y}"},"y":{"$type":"number","$value":"bad"}}]}},"B":{"contexts":{"L":[{"y":{"$type":"number","$value":2}}]}}}}`);
  check(`a name A cannot seed is not moved to B, and an alias to it is unmapped (${JSON.stringify(res(chain))})`,
    rowOf(chain, "y") === undefined && rowOf(chain, "x") === undefined && /^not a number/.test(reasons(chain, "y")[0] ?? "") && NOTED.test(reasons(chain, "y")[1] ?? "")
    && same(reasons(chain, "x"), ["its alias {y} names a token that is not seeded"]) && clean(chain) && notesTrue(chain) === null);
  const style = r7(`{"sets":{"A":{"sources":[${KEEP}]},"B":{"sources":[]}},"modifiers":{"A":{"contexts":{"L":[{"t":{"$type":"typography","$value":{"fontFamily":"Inter","fontSize":"{y}"}},"y":{"$type":"number","$value":"bad"}}]}},"B":{"contexts":{"L":[{"y":{"$type":"number","$value":14}}]}}}}`);
  check(`…and so is a style bound to it (${JSON.stringify(res(style))})`,
    !stylesOf(style).some((s) => s.name === "t") && same(reasons(style, "t"), ["fontSize names {y}, which is not seeded"]) && clean(style) && notesTrue(style) === null);
  const seeded = r7(`{"sets":{"A":{"sources":[]},"B":{"sources":[]}},"modifiers":{"A":{"contexts":{"L":[{"x":{"$type":"number","$value":"{y}"},"y":{"$type":"number","$value":1}}]}},"B":{"contexts":{"L":[{"y":{"$type":"number","$value":2}}]}}}}`);
  check(`…and one A can seed is A's, B's value in \`partly\` (${JSON.stringify(res(seeded))})`,
    same(rowOf(seeded, "y"), ["y", "number", 1]) && same(rowOf(seeded, "x"), ["x", "number", { aliasOf: "y" }]) && same(tables(seeded).map((t) => t.collection), ["A"])
    && NOTED.test(partOf(seeded, "y")) && res(seeded).unmapped.length === 0 && clean(seeded) && notesTrue(seeded) === null);
}

console.log("\na resolver's work is bounded before it is built:");
{
  const r6 = (o: object): SeedOutcome => seedFromResolver(JSON.parse(JSON.stringify(o)) as unknown, new Map());
  /** `n` empty sets, each with a modifier giving `x`. */
  const colls = (n: number): object => {
    const sets: Record<string, unknown> = {}, modifiers: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) { sets["S" + i] = { sources: [] }; modifiers["S" + i] = { contexts: { L: [{ x: { $type: "number", $value: i } }] } }; }
    return { sets, modifiers };
  };
  let t0 = performance.now();
  const wide = r6(colls(4000));
  let ms = performance.now() - t0;
  check(`4,000 collections are refused up front (one createVariables op each, and a batch takes 50) in ${Math.round(ms)} ms (${"error" in wide ? wide.error : "seeded"})`,
    "error" in wide && /4000 collections; a seed makes at most 50/.test(wide.error) && ms < 1000);
  const fifty = r6(colls(MAX_SEED_COLLECTIONS));
  check(`…50 are read, the name the first's (${"error" in fifty ? fifty.error : tables(fifty).map((t) => t.collection).join(",")})`,
    same(rowOf(fifty, "x"), ["x", "number", 0]) && same(tables(fifty).map((t) => t.collection), ["S0"]) && res(fifty).partly.length === MAX_SEED_COLLECTIONS - 1 && clean(fifty));
  const TOO_MANY = new RegExp("holds more than " + MAX_SEED_TOKENS + " tokens .*, the most a seed reads");
  const many: Record<string, unknown> = {};
  for (let i = 0; i <= MAX_SEED_TOKENS; i++) many["t" + i] = { $type: "number", $value: i };
  const tooMany = r6({ sets: { A: { sources: [many] } } });
  check(`a resolver whose sets and contexts hold more than ${MAX_SEED_TOKENS} tokens is refused (${"error" in tooMany ? tooMany.error : "seeded"})`, "error" in tooMany && TOO_MANY.test(tooMany.error));
  const flat = dtcg(JSON.stringify(many));
  check(`…and so is a tokens.dtcg.json (${"error" in flat ? flat.error : "seeded"})`, "error" in flat && TOO_MANY.test(flat.error));
  // Tokens the walk turns down count too: names no alias could spell (`bad.N`), and one token that seeds.
  const rejected = (n: number): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) o["bad." + i] = { $type: "number", $value: i };
    o.ok = { $type: "number", $value: 1 };
    return o;
  };
  t0 = performance.now();
  const badFlat = dtcg(JSON.stringify(rejected(MAX_SEED_TOKENS + 1)));
  ms = performance.now() - t0;
  check(`a tokens.dtcg.json of ${MAX_SEED_TOKENS + 1} turned-down tokens and one good one is refused, not seeded with ${MAX_SEED_TOKENS + 1} unmapped (${Math.round(ms)} ms: ${"error" in badFlat ? badFlat.error : res(badFlat).unmapped.length + " unmapped"})`,
    "error" in badFlat && TOO_MANY.test(badFlat.error) && ms < 1000);
  const badInline = r6({ sets: { A: { sources: [rejected(MAX_SEED_TOKENS + 1)] } } });
  check(`…and so is a resolver's inline source of them (${"error" in badInline ? badInline.error : res(badInline).unmapped.length + " unmapped"})`, "error" in badInline && TOO_MANY.test(badInline.error));
  const half = Math.ceil((MAX_SEED_TOKENS + 1) / 2);
  const split = r6({ sets: { A: { sources: [rejected(half)] } }, modifiers: { A: { contexts: { L: [rejected(half)] } } } });
  check(`…and the count is shared by a set and a context (${"error" in split ? split.error : res(split).unmapped.length + " unmapped"})`, "error" in split && TOO_MANY.test(split.error));
  const under = dtcg(JSON.stringify(rejected(MAX_SEED_TOKENS - 1)));
  check(`…while ${MAX_SEED_TOKENS - 1} of them and one good one are read (${"error" in under ? under.error : res(under).unmapped.length + " unmapped"})`,
    same(rowOf(under, "ok"), ["ok", "number", 1]) && res(under).unmapped.length === MAX_SEED_TOKENS - 1);
  // The build alone over the limit: names × modes (empty contexts cost nothing to write).
  const base: Record<string, unknown> = {}, contexts: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) base["n" + i] = { $type: "number", $value: i };
  for (let m = 0; m <= MAX_SEED_WORK / 1000; m++) contexts["m" + m] = [];
  t0 = performance.now();
  const wideModes = r6({ sets: { A: { sources: [base] } }, modifiers: { A: { contexts } } });
  ms = performance.now() - t0;
  check(`a resolver whose build would read more than ${MAX_SEED_WORK} values is refused before it is built (${Math.round(ms)} ms: ${"error" in wideModes ? wideModes.error : "seeded"})`,
    ms < 1000 && "error" in wideModes && /values in one build/.test(wideModes.error));
}

// ---------------------------------------------------------------- the invariant, over many random files
console.log("\nrandom token files: every token in exactly one table or in `unmapped`:");
{
  /** mulberry32: a seeded PRNG, so the cases are the same every run. */
  const prng = (seed: number): (() => number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let rnd = prng(182);
  const chance = (p: number): boolean => rnd() < p;
  const pick = <T>(xs: readonly T[]): T => { const x = xs[Math.floor(rnd() * xs.length)]; if (x === undefined) throw new Error("pick: empty"); return x; };
  // Documents are written as JSON text, so "__proto__" is a key like any other (as JSON.parse makes it).
  const j = (v: unknown): string => JSON.stringify(v);
  const obj = (entries: ReadonlyArray<readonly [string, string]>): string => {
    const seen = new Set<string>();
    return "{" + entries.filter(([k]) => (seen.has(k) ? false : (seen.add(k), true))).map(([k, v]) => j(k) + ":" + v).join(",") + "}";
  };
  const KEYS = ["a", "b", "c", "x", "a/b", "b/c", "", " ", "p.q", "{q}", "r}", "__proto__", "constructor", "toString"];
  const TYPES = ["color", "number", "dimension", "string", "boolean", "fontFamily", "fontWeight", "typography", "shadow", "duration", "gradient", "cubicBezier", "wobble"];
  const REFS = ["{a}", "{b}", "{a.b}", "{b.c}", "{x}", "{a.a}", "{c.x}", "{missing}", "{__proto__}", "{constructor}", "{t}", "{n}", "{z}"];
  const ref = (): string => j(pick(REFS));
  const valueOf = (type: string | null): string => {
    if (chance(0.2)) return ref();
    switch (type ?? pick(TYPES)) {
      case "color": return pick([j("#ffffff"), j("#00000080"), j("red"), j({ colorSpace: "srgb", components: [1, 0, 0] }), j({ colorSpace: "display-p3", components: [1, 0, 0] })]);
      case "number": return pick(["1", "2.5", j("nine")]);
      case "dimension": return pick([j("4px"), j("1rem"), j({ value: 2, unit: "px" }), j("3pt")]);
      case "string": return pick([j("s"), "3"]);
      case "boolean": return pick(["true", j("false"), j("maybe")]);
      case "fontFamily": return pick([j("Inter"), j(["Inter", "sans-serif"]), "1"]);
      case "fontWeight": return pick(["700", j("bold"), j("heavyish")]);
      case "typography": return obj([["fontFamily", pick([j("Inter"), ref()])], ["fontSize", pick([j("16px"), ref()])], ...(chance(0.5) ? [["lineHeight", pick(["1.5", ref()])] as const] : [])]);
      case "shadow": {
        const layer = (): string => obj([["color", pick([j("#000000"), ref()])], ["offsetX", j("0px")], ["offsetY", pick([j("1px"), ref()])], ["blur", j("2px")]]);
        return chance(0.3) ? "[" + layer() + "," + layer() + "]" : layer();
      }
      default: return pick(["1", j({}), "[]"]);
    }
  };
  const MODES = ["L", "D", "__proto__"];
  const token = (depth: number, inherited: string | null): string => {
    const own: string | null = chance(0.6) ? pick(TYPES) : null;
    const type = own ?? inherited;
    const e: Array<readonly [string, string]> = [];
    if (own !== null) e.push(["$type", j(own)]);
    e.push(["$value", valueOf(type)]);
    if (chance(0.4)) {
      const f: Array<readonly [string, string]> = [];
      if (chance(0.7)) {
        const ms = chance(0.5) ? [pick(MODES)] : [pick(MODES), pick(MODES)];
        f.push(["modes", obj(ms.map((m) => [m, valueOf(type)] as const))]);
        if (chance(0.4)) f.push(["modeOpacity", obj(ms.filter(() => chance(0.7)).map((m) => [m, pick(["50", "100", j("{x}")])] as const))]);
        if (chance(0.3)) f.push(["defaultMode", j(pick(MODES))]);
      }
      if (chance(0.3)) f.push(["opacity", pick(["50", "100", j("{x}")])]);
      if (chance(0.1)) f.push(["originalType", j("boolean")]);
      e.push(["$extensions", obj([["figma.com", obj(f)]])]);
    }
    // A token with children, a $root among them.
    if (depth < 3 && chance(0.15)) e.push([pick(KEYS), node(depth + 1, type)]);
    if (depth < 3 && chance(0.08)) e.push(["$root", node(depth + 1, type)]);
    return obj(e);
  };
  const group = (depth: number, inherited: string | null, root = false): string => {
    const own: string | null = chance(0.3) ? pick(TYPES) : null;
    const type = own ?? inherited;
    const e: Array<readonly [string, string]> = [];
    if (own !== null) e.push(["$type", j(own)]);
    if (chance(0.04)) e.push(["$extends", j("{a}")]);
    if (root && chance(0.08)) e.push(["$value", valueOf(type)]);
    if (chance(0.15)) e.push(["$root", chance(0.6) ? token(depth + 1, type) : chance(0.7) ? group(depth + 1, type) : "5"]);
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) e.push([pick(KEYS), node(depth + 1, type)]);
    return obj(e);
  };
  const node = (depth: number, inherited: string | null): string => (chance(0.08) ? pick(["3", j("loose"), "null"]) : depth < 3 && chance(0.35) ? group(depth, inherited) : token(depth, inherited));

  const withAnchor = (tree: string): string => (chance(0.85) ? "{" + j("keep") + ":" + j({ $type: "number", $value: 1 }) + (tree === "{}" ? "" : ",") + tree.slice(1) : tree);
  /** An independent count of a DTCG tree's tokens, by name: a node with a $value is a token; a value that is not an
   *  object under a name is one (a stray); a group's `$root` with a $value is the group's token, one without is the
   *  group; under a token, or under a name no alias could spell, every key (`$root` too) is a step and every token and
   *  stray value is one. */
  const countTokens = (doc: unknown, into: Set<string>): void => {
    const isO = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const get = (o: Record<string, unknown>, k: string): unknown => Object.getOwnPropertyDescriptor(o, k)?.value;
    const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
    const nm = (p: readonly string[]): string => (p.length ? p.join("/") : "$root");
    const steps = (o: Record<string, unknown>): string[] => Object.keys(o).filter((k) => k === "$root" || !k.startsWith("$"));
    const all = (v: unknown, p: readonly string[]): void => {
      if (!isO(v) || has(v, "$value")) into.add(nm(p));
      if (isO(v)) for (const k of steps(v)) all(get(v, k), [...p, k]);
    };
    const grp = (o: Record<string, unknown>, p: readonly string[]): void => {
      if (has(o, "$value")) { all(o, p); return; }
      for (const k of Object.keys(o)) {
        const v = get(o, k);
        if (k === "$root") {
          if (isO(v) && has(v, "$value")) { into.add(nm(p)); for (const kk of steps(v)) all(get(v, kk), [...p, "$root", kk]); }
          else if (isO(v)) grp(v, p);
          else into.add(nm(p));
        } else if (k.startsWith("$")) continue;
        else if (isO(v) && !has(v, "$value") && k.trim() && !/[.{}]/.test(k)) grp(v, [...p, k]);
        else all(v, [...p, k]);
      }
    };
    if (isO(doc)) grp(doc, []);
  };
  /** The same count over a resolver's every set and context (inline sources). */
  const countResolver = (parsed: unknown): Set<string> => {
    const counted = new Set<string>();
    const walkSources = (v: unknown): void => { if (Array.isArray(v)) for (const s of v) countTokens(s, counted); };
    /** An own property of parsed JSON ("__proto__" included), or undefined. */
    const at = (o: unknown, k: string): unknown => { const d = typeof o === "object" && o !== null ? Object.getOwnPropertyDescriptor(o, k) : undefined; return d ? (d.value as unknown) : undefined; };
    const keysOf = (o: unknown): string[] => (typeof o === "object" && o !== null ? Object.keys(o) : []);
    const setsV = at(parsed, "sets"), modsV = at(parsed, "modifiers");
    for (const s of keysOf(setsV)) walkSources(at(at(setsV, s), "sources"));
    for (const m of keysOf(modsV)) { const ctx = at(at(modsV, m), "contexts"); for (const k of keysOf(ctx)) walkSources(at(ctx, k)); }
    return counted;
  };

  /** What breaks the invariant in an outcome, or null. */
  const broken = (o: SeedOutcome, counted: ReadonlySet<string>): string | null => {
    // A note that says a target is not seeded when it is, or that tells of a seat move, is false.
    const lie = notesTrue(o);
    if (lie !== null) return lie;
    if ("error" in o) return counted.size && /it holds no tokens/.test(o.error) ? "refused as holding no tokens: " + o.error : null;
    const rows = tables(o).flatMap((t) => t.variables.map((r) => r[0]));
    const styleNames = stylesOf(o).map((s) => s.name);
    const seeded = new Set<string>([...rows, ...styleNames]);
    const unm = new Set(o.unmapped.map((u) => u.token));
    if (rows.length !== new Set(rows).size) return "a row in two tables";
    if (styleNames.length !== new Set(styleNames).size || styleNames.some((s) => rows.includes(s))) return "a name twice among the styles and rows";
    for (const n of counted) if (seeded.has(n) === unm.has(n)) return (seeded.has(n) ? "seeded and unmapped: " : "neither seeded nor unmapped: ") + JSON.stringify(n);
    for (const n of seeded) if (!counted.has(n)) return "a seeded name no file gives: " + JSON.stringify(n);
    for (const u of o.unmapped) if (seeded.has(u.token)) return "unmapped but seeded: " + JSON.stringify(u.token);
    for (const u of o.partly) if (!seeded.has(u.token)) return "a partly note on a token not seeded: " + JSON.stringify(u.token);
    if (!clean(o)) return "not clean (a note says the wrong collection, or an unmapped entry says it was seeded)";
    if (!valid(o)) return "a table the create checks refuse";
    return null;
  };
  const failures: string[] = [];
  const t0 = performance.now();
  let cases = 0;
  rnd = prng(182);
  for (let i = 0; i < 2500; i++, cases++) {
    // Most files hold one token that always seeds, so the outcome is tables (where every list is checked), not a refusal.
    const text = withAnchor(group(0, null, true));
    const parsed = JSON.parse(text) as unknown;
    const counted = new Set<string>();
    countTokens(parsed, counted);
    const why = broken(seedFromDtcg(parsed), counted);
    if (why) failures.push("dtcg " + why + " in " + text);
  }
  // Resolvers: 1–3 sets (some sharing a collection), 0–2 modifiers per collection, contexts with names only modifiers
  // give, and the same names across collections.
  const NAMES = ["a", "b", "n", "z", "t", "__proto__", "g/x"];
  const rTok = (inherited: string | null = null): string => {
    const type = chance(0.7) ? pick(["number", "color", "typography", "string", "duration"]) : null;
    const e: Array<readonly [string, string]> = [];
    if (type !== null) e.push(["$type", j(type)]);
    e.push(["$value", type === null && chance(0.6) ? j("{" + pick(NAMES).split("/").join(".") + "}") : valueOf(type ?? inherited)]);
    if (chance(0.1)) e.push(["$extensions", obj([["figma.com", obj([["opacity", "50"]])]])]);
    return obj(e);
  };
  const rTree = (): string => {
    const n = Math.floor(rnd() * 3);
    const e: Array<readonly [string, string]> = [];
    for (let i = 0; i < n; i++) e.push([pick(NAMES), chance(0.1) ? group(2, null) : rTok()]);
    return obj(e);
  };
  for (let i = 0; i < 2500; i++, cases++) {
    const setNames = ["A", "B", "__proto__"].filter(() => chance(0.6));
    if (!setNames.length) setNames.push("A");
    const collOf = new Map<string, string>(setNames.map((s) => [s, chance(0.2) ? "Theme" : s]));
    const sets = setNames.map((s, si) => [s, obj([["sources", "[" + Array.from({ length: 1 + Math.floor(rnd() * 2) }, (_, k) => (si === 0 && k === 0 ? withAnchor(rTree()) : rTree())).join(",") + "]"],
      ...(collOf.get(s) !== s ? [["$extensions", obj([["figma.com", obj([["collection", j(collOf.get(s))]])]])] as const] : [])])] as const);
    const mods: Array<readonly [string, string]> = [];
    for (const c of new Set(collOf.values())) {
      for (let m = Math.floor(rnd() * 3); m > 0; m--) {
        const ctxNames = chance(0.5) ? [pick(MODES)] : [pick(MODES), pick(MODES)];
        const ext = chance(0.75) ? [["$extensions", obj([["figma.com", obj([["collection", j(chance(0.9) ? c : "Elsewhere")]])]])] as const] : [];
        mods.push(["m" + mods.length, obj([["contexts", obj(ctxNames.map((k) => [k, "[" + (chance(0.8) ? rTree() : "") + "]"] as const))],
          ...(chance(0.8) ? [["default", j(pick(MODES))] as const] : []), ...ext])]);
      }
    }
    const order = [...sets.map(([s]) => j({ $ref: "#/sets/" + s })), ...mods.map(([m]) => j({ $ref: "#/modifiers/" + m }))];
    const text = obj([["sets", obj(sets)], ["modifiers", obj(mods)], ["resolutionOrder", "[" + order.join(",") + "]"]]);
    const parsed = JSON.parse(text) as unknown;
    const why = broken(seedFromResolver(parsed, new Map()), countResolver(parsed));
    if (why) failures.push("resolver " + why + " in " + text);
  }
  // Alias chains across names only modifiers give, in several collections: each name a bad value, a good one, an
  // alias (typed, of another type, or untyped) or a style bound to one, the same names in several collections. Each
  // name is the first collection's whose modifier gives it: a row of it is in that collection's table, never another's.
  const POOL = ["p", "q", "r", "s", "g/x"];
  const poolRef = (): string => "{" + pick([...POOL, "keep", "nope"]).split("/").join(".") + "}";
  const cTok = (): string => {
    const r = rnd();
    if (r < 0.2) return j({ $type: "number", $value: pick([1, 2, "bad"]) });
    if (r < 0.45) return j({ $type: "number", $value: poolRef() });
    if (r < 0.55) return j({ $type: "color", $value: pick([poolRef(), "#ffffff", "nope"]) });
    if (r < 0.75) return j({ $value: poolRef() });
    if (r < 0.85) return j({ $type: "typography", $value: { fontFamily: "Inter", fontSize: pick([poolRef(), "16px"]) } });
    return j({ $type: "number", $value: chance(0.5) ? 3 : poolRef() });
  };
  const cTree = (): string => obj(Array.from({ length: Math.floor(rnd() * 4) }, () => [pick(POOL), cTok()] as const));
  /** The rule, checked from the file itself: each pool name's row is in the table of the first modifier (in order) that
   *  gives it, and every later modifier that gives it is one "gives it too" note on it. */
  const firstOwns = (o: SeedOutcome, parsed: unknown): string | null => {
    if ("error" in o) return null;
    const at = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? Object.getOwnPropertyDescriptor(v, k)?.value as unknown : undefined);
    const keysOf = (v: unknown): string[] => (typeof v === "object" && v !== null ? Object.keys(v) : []);
    const givers = new Map<string, string[]>();
    const modsV = at(parsed, "modifiers");
    for (const m of keysOf(modsV)) {
      const names = new Set<string>();
      const ctx = at(at(modsV, m), "contexts");
      for (const k of keysOf(ctx)) { const list = at(ctx, k); if (Array.isArray(list)) for (const tree of list) for (const n of keysOf(tree)) names.add(n); }
      for (const n of names) { const l = givers.get(n); if (l) l.push(m); else givers.set(n, [m]); }
    }
    for (const t of tables(o)) for (const r of t.variables) {
      const first = givers.get(r[0])?.[0];
      if (first !== undefined && t.collection !== first) return "'" + r[0] + "' seeded in '" + t.collection + "', not in '" + first + "', the first collection whose modifier gives it";
    }
    for (const [n, list] of givers) {
      const notes = [...o.unmapped, ...o.partly].filter((u) => u.token === n && /gives it too; only the first collection whose modifier gives it/.test(u.reason)).length;
      if (notes !== list.length - 1) return "'" + n + "': " + (list.length - 1) + " later modifiers give it, and " + notes + " notes say so";
    }
    return null;
  };
  for (let i = 0; i < 2500; i++, cases++) {
    const colls = ["A", "B", "C", "D"].slice(0, 2 + Math.floor(rnd() * 3));
    const sets = colls.map((c, ci) => [c, obj([["sources", ci === 0 && chance(0.8) ? "[" + j({ keep: { $type: "number", $value: 1 } }) + "]" : "[]"]])] as const);
    const mods = colls.filter(() => chance(0.9)).map((c) => [c, obj([["contexts", obj((chance(0.6) ? ["L"] : ["L", "D"]).map((k) => [k, "[" + cTree() + "]"] as const))]])] as const);
    const text = obj([["sets", obj(sets)], ["modifiers", obj(mods)]]);
    const parsed = JSON.parse(text) as unknown;
    const o = seedFromResolver(parsed, new Map());
    const why = broken(o, countResolver(parsed)) ?? firstOwns(o, parsed);
    if (why) failures.push("chain " + why + " in " + text);
  }
  const ms = performance.now() - t0;
  console.log(`  (${cases} random files in ${Math.round(ms)} ms)`);
  check(`${cases} random token files and resolvers: every token the test's own walk counts is in one table or in \`unmapped\`, never both, no row twice, every \`partly\` name seeded (${failures.length} not${failures.length ? ": " + failures.slice(0, 3).join(" | ") : ""})`, failures.length === 0);
  check(`…in under 3 s (${Math.round(ms)} ms)`, ms < 3000);
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
  const load = (ops: Array<Record<string, unknown> & { op: string }>) => loadSeedTokens(ops, inside, dir);
  const err = (r: ReturnType<typeof load>): string => ("error" in r ? r.error : "(loaded)");
  put("tokens.dtcg.json", { color: { $type: "color", bg: { $value: "#ffffff" } }, type: { $type: "typography", body: { $value: { fontFamily: "Inter", fontSize: "16px" } } } });
  const r = load([{ op: "seedTokens", file: "tokens.dtcg.json", collection: "Theme" }, { op: "createTree", tree: { name: "S" } }]);
  check("seedTokens becomes its tables in place, the op after it kept", "ops" in r && same(r.ops.map((o) => o.op), ["createVariables", "createStyles", "createTree"])
    && same(r.seeds, [{ index: 0, file: "tokens.dtcg.json", first: 0, count: 2, unmapped: [], partly: [], tables: [{ collection: "Theme", names: ["color/bg"] }, { collection: null, names: ["type/body"] }] }]));
  put("tokens.resolver.json", { version: "2025.10", sets: { Core: { sources: [{ $ref: "tokens/core.json" }] } }, resolutionOrder: [{ $ref: "#/sets/Core" }] });
  put("tokens/core.json", { gap: { $type: "number", $value: 4 } });
  const rr = load([{ op: "seedTokens", file: "tokens.resolver.json" }]);
  check("a resolver is told by its content, its $ref read relative to it", "ops" in rr && same(rr.ops, [{ op: "createVariables", collection: "Core", variables: [["gap", "number", 4]] }]));
  put("named.json", { version: "2025.10", sets: { Core: { sources: [{ $ref: "tokens/core.json" }] } }, resolutionOrder: [{ $ref: "#/sets/Core" }] });
  check("…whatever the file is called", "ops" in load([{ op: "seedTokens", file: "named.json" }]));
  put("sets-group.json", { sets: { base: { $type: "color", $value: "#ffffff" } } });
  put("sets-token.json", { sets: { $type: "color", $value: "#ffffff" } });
  const sg = load([{ op: "seedTokens", file: "sets-group.json" }]), stk = load([{ op: "seedTokens", file: "sets-token.json" }]);
  check(`a token tree with a top-level 'sets' group or token is a token tree, not a resolver (${err(sg)}; ${err(stk)})`,
    "ops" in sg && same(sg.ops, [{ op: "createVariables", collection: "Tokens", variables: [["sets/base", "color", "#ffffff"]] }])
    && "ops" in stk && same(stk.ops, [{ op: "createVariables", collection: "Tokens", variables: [["sets", "color", "#ffffff"]] }]));
  check("a resolver: a resolutionOrder list, or a set with a `sources` list", isResolverDoc({ resolutionOrder: [] }) && isResolverDoc({ sets: { A: { sources: [] } } })
    && !isResolverDoc({ sets: { A: { $type: "number", $value: 1 } } }) && !isResolverDoc({ sets: {} }));
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
  // A symbolic link inside the directory to a file outside it is refused too (the path check alone is by name).
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "dt-seed-out-"));
  fs.writeFileSync(path.join(out, "outside.json"), JSON.stringify({ secret: { $type: "number", $value: 7 } }));
  fs.symlinkSync(path.join(out, "outside.json"), path.join(dir, "link.json"));
  fs.symlinkSync(out, path.join(dir, "shared"));
  check(`a token file that is a link to a file outside the directory is refused (${err(load([{ op: "seedTokens", file: "link.json" }]))})`,
    /ops\[0\]\.file: \S*link\.json leads, through a symbolic link, to .*outside\.json, outside the directory this server was started in/.test(err(load([{ op: "seedTokens", file: "link.json" }]))));
  check("…and one under a linked directory", /leads, through a symbolic link, to .*outside\.json, outside the directory/.test(err(load([{ op: "seedTokens", file: "shared/outside.json" }]))));
  put("link.resolver.json", { sets: { A: { sources: [{ $ref: "link.json" }] } } });
  put("dirlink.resolver.json", { sets: { A: { sources: [{ $ref: "shared/outside.json" }] } } });
  check(`…and so is a $ref that is one (${err(load([{ op: "seedTokens", file: "link.resolver.json" }]))})`,
    /\$ref 'link\.json': .*link\.json leads, through a symbolic link, to .*outside\.json, outside the directory/.test(err(load([{ op: "seedTokens", file: "link.resolver.json" }])))
    && /\$ref 'shared\/outside\.json': .*leads, through a symbolic link/.test(err(load([{ op: "seedTokens", file: "dirlink.resolver.json" }]))));
  fs.symlinkSync(path.join(dir, "tokens.dtcg.json"), path.join(dir, "inner.json"));
  check(`a link to a file inside the directory is read (${err(load([{ op: "seedTokens", file: "inner.json" }]))})`, "ops" in load([{ op: "seedTokens", file: "inner.json" }]));
  const rootLink = path.join(out, "root-link");
  fs.symlinkSync(dir, rootLink);
  check("…and so is a file when the directory itself is reached through a link", "ops" in loadSeedTokens([{ op: "seedTokens", file: "tokens.dtcg.json" }], (p) => path.resolve(rootLink, p), rootLink));
  // The bytes read are the file opened, and that file is the one whose real path was checked (the same device and
  // inode): a path swapped for a link to a file outside between the check and the read cannot be read.
  check("sameFile: one file is the same device and inode, another file is not", sameFile({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }) && !sameFile({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }) && !sameFile({ dev: 1, ino: 2 }, { dev: 2, ino: 2 })
    && sameFile(fs.statSync(path.join(dir, "inner.json")), fs.statSync(path.join(dir, "tokens.dtcg.json"))) && !sameFile(fs.statSync(path.join(dir, "tokens.dtcg.json")), fs.statSync(path.join(out, "outside.json"))));
  const realDir = fs.realpathSync(dir);
  const outsidePath = path.join(out, "outside.json");
  /** The descriptors opened and closed (Node's calls, counted). */
  let opened = 0, closed = 0;
  const swapIo: SeedIo = {
    ...nodeSeedIo,
    // The path is a link to a file outside when it is opened, and the inside file again when its real path is read.
    open: (p) => { opened++; return nodeSeedIo.open(p.endsWith("tokens.dtcg.json") ? outsidePath : p); },
    close: (fd) => { closed++; nodeSeedIo.close(fd); },
  };
  const swapped = readSeedJson(path.join(dir, "tokens.dtcg.json"), "ops[0].file", realDir, swapIo);
  check(`a file swapped for a link to one outside between the open and the check is refused, nothing of it read (${"error" in swapped ? swapped.error : JSON.stringify(swapped.json)})`,
    "error" in swapped && /tokens\.dtcg\.json changed while it was read \(the file opened is not the one at .*tokens\.dtcg\.json\); seed again/.test(swapped.error) && !JSON.stringify(swapped).includes("secret") && opened === 1 && closed === 1);
  opened = 0; closed = 0;
  const kept = readSeedJson(path.join(dir, "tokens.dtcg.json"), "ops[0].file", realDir, { ...swapIo, open: (p) => { opened++; return nodeSeedIo.open(p); } });
  check("…the same file read with nothing swapped is read, its descriptor closed", "json" in kept && opened === 1 && closed === 1);
  closed = 0;
  const outRead = readSeedJson(path.join(dir, "link.json"), "ops[0].file", realDir, swapIo);
  check("…and a refused link closes its descriptor too", "error" in outRead && /leads, through a symbolic link/.test(outRead.error) && closed === 1);
  const noOpen = readSeedJson(path.join(dir, "tokens"), "ops[0].file", realDir, { ...nodeSeedIo, open: () => { throw new Error("EISDIR"); } });
  check(`a path that cannot be opened (a directory on Windows) says what is there (${"error" in noOpen ? noOpen.error : "read"})`, "error" in noOpen && /tokens is not a file$/.test(noOpen.error));
  fs.rmSync(out, { recursive: true, force: true });
  // The dry run's sentence counts the tokens seeded in part apart from the ones not seeded.
  put("moded.json", { t: { $type: "typography", $value: { fontFamily: "Inter", fontSize: "16px" }, $extensions: { "figma.com": { defaultMode: "Light",
    modes: { Dark: { fontFamily: "Inter", fontSize: "18px" }, Light: { fontFamily: "Inter", fontSize: "16px" } } } } } });
  const md = load([{ op: "seedTokens", file: "moded.json" }]);
  const mdChange = "seeds" in md ? String((seededPreview({ dryRun: true, creates: 1, invalid: 0, steps: [{ index: 0, op: "createStyles", effect: "creates", target: null }] }, md.seeds).steps as Array<Record<string, unknown>>)[0]?.change) : "";
  check(`a style seeded from its default mode only: the dry run says 'seeded in part', not 'not seeded' (${mdChange})`,
    mdChange === "seeds from 'moded.json': 1 style; 1 token is seeded in part (`partly`)");
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
    partly: [{ token: "Body", reason: "a style has no modes; only the 'Light' value was seeded ('Dark' differs)" }],
    tables: [{ collection: "Theme", names: ["a", "b", "c"] }, { collection: null, names: ["Body"] }] }];
  const r: WriteResult = { ok: true, applied: [
    { id: "C:1", result: "unchanged", rows: [["V:1", "unchanged"], ["V:2", "updated"], ["V:3", "created"]] },
    { rows: [["S:1", "unchanged"]] },
    { id: "9:1", created: { frames: 1, texts: 0 } },
  ] };
  const out = seededReply(r, seeds);
  check("a seed's tables are one entry at its op's index: only the created and updated rows, by name, and a count of the rest",
    same(out.applied, [
      { seeded: "t.json", tables: [{ collection: "Theme", id: "C:1", result: "unchanged", created: [["c", "V:3"]], updated: [["b", "V:2"]], unchanged: 1 }, { styles: true, unchanged: 1 }], unmapped: seeds[0]?.unmapped, partly: seeds[0]?.partly },
      { id: "9:1", created: { frames: 1, texts: 0 } },
    ]));
  const fail = seededReply({ ok: false, applied: [], failedAt: 1, failedOp: "createStyles", error: "ops[1] (createStyles): boom" }, seeds);
  check("a failure inside a seed's tables is that op's, and says which tables it became", fail.failedAt === 0 && fail.failedOp === "seedTokens" && /ops\[0\] \(seedTokens 't\.json'\) became ops\[0–1\] of the batch: createVariables 'Theme', createStyles/.test(fail.error ?? ""));
  check("a failure after it is given at the agent's own index", seededReply({ ok: false, applied: [], failedAt: 2, error: "x" }, seeds).failedAt === 1 && inputIndex(seeds, 2) === 1 && inputIndex(seeds, 1) === 0);
  // 'Allow edits' turned off once the create tables ran: no failedAt, and the tables stay applied.
  const off = seededReply({ ok: false, refused: "edits-off", error: "off", applied: [{ id: "C:1", result: "created", rows: [["V:1", "created"], ["V:2", "created"], ["V:3", "created"]] }, { rows: [["S:1", "created"]] }] }, seeds);
  check("a failure with no failedAt (edits turned off partway): the tables that stay are folded like a success's",
    off.failedAt === undefined && off.error === "off" && same(off.applied, [{ seeded: "t.json", tables: [
      { collection: "Theme", id: "C:1", result: "created", created: [["a", "V:1"], ["b", "V:2"], ["c", "V:3"]], unchanged: 0 }, { styles: true, created: [["Body", "S:1"]], unchanged: 0 }], unmapped: seeds[0]?.unmapped, partly: seeds[0]?.partly }]));
  const late = seededReply({ ok: false, failedAt: 2, failedOp: "createTree", error: "x", applied: [{ id: "C:1", result: "unchanged", rows: [["V:1", "unchanged"], ["V:2", "unchanged"], ["V:3", "updated"]] }] }, seeds);
  check("a failure with a failedAt, and a seed's first table staying: folded too (only the tables that stay)",
    late.failedAt === 1 && same(late.applied, [{ seeded: "t.json", tables: [{ collection: "Theme", id: "C:1", result: "unchanged", updated: [["c", "V:3"]], unchanged: 2 }], unmapped: seeds[0]?.unmapped, partly: seeds[0]?.partly }]));
  const step = (index: number, op: WritePreviewStep["op"], extra: Partial<WritePreviewStep> = {}): WritePreviewStep => ({ index, op, effect: "creates", target: null, ...extra });
  const p = seededPreview({ dryRun: true, creates: 3, invalid: 0, steps: [step(0, "createVariables", { plan: { create: ["a"], update: [] } }), step(1, "createStyles"), step(2, "createTree")] }, seeds);
  const steps = Array.isArray(p.steps) ? (p.steps as Array<Record<string, unknown>>) : [];
  check("the dry run: one step for the seed (its tables' steps under it, the plan kept, the unmapped and the partly listed), the next at index 1",
    steps.length === 2 && steps[0]?.op === "seedTokens" && same(steps[0]?.unmapped, seeds[0]?.unmapped) && same(steps[0]?.partly, seeds[0]?.partly) && same((steps[0]?.tables as unknown[])[0], { op: "createVariables", effect: "creates", target: null, plan: { create: ["a"], update: [] } })
    && /seeds from 't\.json': collection 'Theme' \(3 variables\), 1 style; 1 token is seeded in part \(`partly`\); 1 token is not seeded \(`unmapped`\)$/.test(String(steps[0]?.change)) && steps[1]?.index === 1 && p.creates === 2);
  check("nothing seeded: the reply and the preview are as they were", seededReply(r, []) === r);
}

const unclean = [...looked].filter((o) => !clean(o));
check(`every outcome above: each token in a table (perhaps with a \`partly\` note) or in \`unmapped\`, never both (${looked.size} looked at; ${unclean.length} not: ${JSON.stringify(unclean.slice(0, 1))})`, looked.size > 20 && unclean.length === 0);

report();
