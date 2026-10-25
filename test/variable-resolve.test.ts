// test/variable-resolve.test.ts — "what value does this variable have in mode M" (design-to-code/variable-resolve.ts):
// the duplicate-name rule, the mode rule, the cycle rule and the composed-colour fold, table-driven through the
// module's interface; then the same inputs read through every caller (tokens.css, the native emitters, the plan
// skeleton, cross-check's contrast, tokens --lookup), which used to disagree and now give one answer.
// Run with:  bun test/variable-resolve.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { variableResolver, defaultModeName, baseValue, readColour, type ModeRequest, type VariableSource } from "../design-to-code/variable-resolve.ts";
import { toCSS, main as tokensMain } from "../design-to-code/tokens.ts";
import { toNative } from "../design-to-code/tokens-native.ts";
import { buildTokens } from "../design-to-code/plan-skeleton.ts";
import { crossCheck } from "../design-to-code/cross-check.ts";
import { malformed, screenExport, tokens, variable, type CollectionInput, type NodeInput, type VariableInput } from "./fixtures.ts";
import type { ScreenDoc, TokensDoc, Variable } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

const doc = (variables: VariableInput[], collections: CollectionInput[] = []): TokensDoc => tokens({ variables, collections });
const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-9;
const keyOf = (v: Variable | null): string | null => (v ? v.key ?? `(${v.collection})` : null);

// ---------------------------------------------------------------- the duplicate-name rule
console.log("target — which variable an alias to a shared name means:");
{
  const lib = { name: "Brand/600", type: "COLOR" as const, collection: "Library", key: "bbbb", values: { M: "#111111" } };
  const local = { name: "Brand/600", type: "COLOR" as const, collection: "Local", key: "aaaa", values: { M: "#222222" } };
  const libKeyed = { ...lib, collectionKey: "k-lib" };
  const localSameName = { ...local, collection: "Library", collectionKey: "k-local" };
  const referrerIn = (collection: string, extra: Partial<VariableInput> = {}): Variable =>
    variable({ name: "Action", type: "COLOR", collection, key: "ref", values: { M: { aliasOf: "Brand/600" } }, ...extra });
  const rows: Array<{ what: string; sources: VariableSource[]; referrer: Variable | null; want: string | null }> = [
    { what: "one candidate is the target", sources: [doc([lib])], referrer: referrerIn("Semantic"), want: "bbbb" },
    { what: "no candidate: null", sources: [doc([lib])], referrer: null, want: null },
    { what: "the referrer's own collection first (by name), over a lower key", sources: [doc([local, lib])], referrer: referrerIn("Library"), want: "bbbb" },
    { what: "by collectionKey when both carry one: same-named collections are told apart",
      sources: [doc([libKeyed, localSameName])], referrer: referrerIn("Library", { collectionKey: "k-lib" }), want: "bbbb" },
    { what: "no collection match: the lowest key, whatever the listing order", sources: [doc([lib, local])], referrer: referrerIn("Semantic"), want: "aaaa" },
    { what: "…the same with the order reversed", sources: [doc([local, lib])], referrer: referrerIn("Semantic"), want: "aaaa" },
    { what: "source precedence before the key: the first source's variable", sources: [doc([lib]), doc([local])], referrer: referrerIn("Semantic"), want: "bbbb" },
    { what: "a keyless candidate sorts before a keyed one", sources: [doc([lib, { name: local.name, type: local.type, collection: local.collection, values: local.values }])], referrer: referrerIn("Semantic"), want: "(Local)" },
    { what: "never the referrer itself: a local variable aliasing the library's same-named one means the library's",
      sources: [doc([lib, { ...local, values: { M: { aliasOf: "Brand/600" } } }])], referrer: null, want: "bbbb" },
  ];
  for (const r of rows) {
    const vars = variableResolver(r.sources);
    // the self-alias row asks from the aliasing variable as it sits in the source
    const referrer = r.referrer ?? vars.candidates("Brand/600").find((v) => v.collection === "Local") ?? null;
    check(`[target] ${r.what}`, keyOf(vars.target(r.what.startsWith("no candidate") ? "Gone" : "Brand/600", referrer)) === r.want);
  }
  const twoCopies = variableResolver([doc([local]), doc([lib, local])]);
  const self = twoCopies.candidates("Brand/600")[0] ?? null;
  check("[target] the same key in another source IS the referrer (a variable read twice), so it is not a candidate",
    keyOf(twoCopies.target("Brand/600", self)) === "bbbb" && twoCopies.candidates("Brand/600", self).length === 1);
}

// ---------------------------------------------------------------- the mode rule
console.log("modeOf — which mode a variable is read in:");
{
  const colls: CollectionInput[] = [
    { name: "Theme", key: "k-sys", modes: ["Light", "Dark"], default: "Light" },
    { name: "Theme", key: "k-lib", modes: ["Light", "Dark"], default: "Dark" },
    { name: "Size", modes: ["Desktop", "Mobile"] },
  ];
  const theme = (extra: Partial<VariableInput> = {}): VariableInput => ({ name: "T", type: "COLOR", collection: "Theme", values: { Light: "#fff", Dark: "#000" }, ...extra });
  const rows: Array<{ what: string; v: VariableInput; req: ModeRequest; want: string | undefined }> = [
    { what: "the frame's mode for its collection", v: theme(), req: { byCollection: { Theme: "Dark" } }, want: "Dark" },
    { what: "…matched without case", v: theme(), req: { byCollection: { Theme: "dark" } }, want: "Dark" },
    { what: "the one mode asked for every collection", v: theme(), req: { mode: "Dark" }, want: "Dark" },
    { what: "…matched without case", v: theme(), req: { mode: "DARK" }, want: "Dark" },
    { what: "the frame's mode before the one mode name", v: theme(), req: { byCollection: { Theme: "Light" }, mode: "Dark" }, want: "Light" },
    { what: "a mode it lacks: its collection's default", v: theme(), req: { mode: "Sepia" }, want: "Light" },
    { what: "the default by collectionKey (same-named collections)", v: theme({ collectionKey: "k-lib" }), req: {}, want: "Dark" },
    { what: "its only mode stands in for any mode, even under fallback none", v: { name: "O", type: "COLOR", collection: "Theme", values: { Only: "#fff" } }, req: { mode: "Dark", fallback: "none" }, want: "Only" },
    { what: "no default: the first mode", v: { name: "S", type: "FLOAT", collection: "Size", values: { Desktop: 2, Mobile: 1 } }, req: { mode: "Tablet" }, want: "Desktop" },
    { what: "fallback default: no default is no mode, never the first", v: { name: "S", type: "FLOAT", collection: "Size", values: { Desktop: 2, Mobile: 1 } }, req: { mode: "Tablet", fallback: "default" }, want: undefined },
    { what: "fallback none: a mode it lacks is no mode, never the default", v: theme(), req: { mode: "Sepia", fallback: "none" }, want: undefined },
    { what: "no values at all: no mode", v: { name: "E", type: "COLOR", collection: "Theme", values: {} }, req: {}, want: undefined },
  ];
  const vars = variableResolver(doc([], colls));
  for (const r of rows) check(`[mode] ${r.what}`, vars.modeOf(variable(r.v), r.req) === r.want);
  const collections = doc([], colls).collections;
  check("[mode] defaultModeName / baseValue (the :root value): the collection default, else the first mode",
    defaultModeName(variable(theme()), collections) === "Light" && baseValue(variable(theme({ collectionKey: "k-lib" })), collections) === "#000"
    && defaultModeName(variable({ name: "S", type: "FLOAT", collection: "Size", values: { Desktop: 2, Mobile: 1 } }), collections) === "Desktop"
    && baseValue(variable({ name: "E", type: "COLOR", values: {} }), collections) === undefined);
}

// ---------------------------------------------------------------- aliases into modes
console.log("resolve — an alias lands in its TARGET's mode:");
{
  const ds = doc([
    { name: "Text", type: "COLOR", collection: "Semantic", key: "t", values: { Light: { aliasOf: "Ink/900" }, Dark: { aliasOf: "Ink/100" } } },
    { name: "Ink/900", type: "COLOR", collection: "Palette", key: "i9", values: { Day: "#111111", Night: "#222222" } },
    { name: "Ink/100", type: "COLOR", collection: "Palette", key: "i1", values: { Day: "#eeeeee", Night: "#dddddd" } },
    { name: "Gap", type: "FLOAT", collection: "Semantic", key: "g", values: { Light: { aliasOf: "Space/4" }, Dark: { aliasOf: "Space/4" } } },
    { name: "Space/4", type: "FLOAT", collection: "Space", key: "s", values: { Light: 16, Dark: 24 } },
  ], [{ name: "Semantic", modes: ["Light", "Dark"], default: "Light" }, { name: "Palette", modes: ["Day", "Night"], default: "Night" },
    { name: "Space", modes: ["Light", "Dark"], default: "Light" }]);
  const vars = variableResolver(ds);
  const v = (name: string): Variable | null => vars.target(name);
  const rows: Array<{ what: string; name: string; req: ModeRequest; value: unknown; mode: string; via: string[] }> = [
    { what: "the frame's modes: Semantic Dark → Ink/100 in the frame's Palette mode (Day)", name: "Text", req: { byCollection: { Semantic: "Dark", Palette: "Day" } }, value: "#eeeeee", mode: "Dark", via: ["Ink/100"] },
    { what: "no frame mode for Palette: Ink/100 in Palette's default (Night)", name: "Text", req: { byCollection: { Semantic: "Dark" } }, value: "#dddddd", mode: "Dark", via: ["Ink/100"] },
    { what: "one mode name: the target's same-named mode", name: "Gap", req: { mode: "Dark" }, value: 24, mode: "Dark", via: ["Space/4"] },
    { what: "one mode name the target lacks: its default", name: "Text", req: { mode: "Light" }, value: "#222222", mode: "Light", via: ["Ink/900"] },
  ];
  for (const r of rows) {
    const got = vars.resolve(v(r.name), r.req);
    check(`[alias] ${r.what}`, got.value === r.value && got.mode === r.mode && JSON.stringify(got.via) === JSON.stringify(r.via));
  }
  check("[alias] the value's variable is the end of the chain", vars.resolve(v("Gap"), { mode: "Dark" }).variable?.name === "Space/4");
  check("[alias] a dangling alias is unresolved, not a guess", (() => {
    const r = variableResolver(doc([{ name: "A", type: "COLOR", values: { M: { aliasOf: "Gone" } } }]));
    const got = r.resolve(r.target("A"));
    return got.value === undefined && got.variable === null && got.mode === "M" && got.via.join() === "Gone";
  })());
}

// ---------------------------------------------------------------- the cycle rule
console.log("cycles — a chain that comes back is unresolved; a long one is not:");
{
  const chain = (n: number, last: VariableInput["values"][string]): VariableInput[] =>
    Array.from({ length: n }, (_, i) => ({ name: `C${i}`, type: "COLOR" as const, key: `k${i}`, values: { M: i === n - 1 ? last : { aliasOf: `C${i + 1}` } } }));
  const rows: Array<{ what: string; vars: VariableInput[]; value: unknown }> = [
    { what: "a 50-hop chain resolves (no depth cap)", vars: chain(50, "#ff0000"), value: "#ff0000" },
    { what: "A → B → A is a cycle", vars: [{ name: "C0", type: "COLOR", values: { M: { aliasOf: "C1" } } }, { name: "C1", type: "COLOR", values: { M: { aliasOf: "C0" } } }], value: undefined },
    { what: "a variable aliasing only its own name has no target", vars: [{ name: "C0", type: "COLOR", values: { M: { aliasOf: "C0" } } }], value: undefined },
    { what: "a 50-hop chain back to its start is a cycle", vars: chain(50, { aliasOf: "C0" }), value: undefined },
  ];
  for (const r of rows) {
    const vars = variableResolver(doc(r.vars));
    check(`[cycle] ${r.what}`, vars.resolve(vars.target("C0")).value === r.value);
  }
  const closureOf = (vs: VariableInput[]) => { const vars = variableResolver(doc(vs)); const c = vars.closure(vars.target("A") ?? variable(vs[0] ?? { name: "?", type: "FLOAT", values: {} })); return { names: c.vars.map((v) => v.name).join(), complete: c.complete }; };
  const diamond = closureOf([
    { name: "A", type: "FLOAT", values: { L: { aliasOf: "B" }, D: { aliasOf: "C" } } },
    { name: "B", type: "FLOAT", values: { L: { aliasOf: "D" } } }, { name: "C", type: "FLOAT", values: { L: { aliasOf: "D" } } }, { name: "D", type: "FLOAT", values: { L: 1 } }]);
  check("[closure] every mode's aliases, each variable once; a diamond is no cycle", diamond.names === "A,B,D,C" && diamond.complete);
  check("[closure] a 40-link chain whose four modes all alias the next link is walked once per variable (not once per path)", (() => {
    const modes = ["Desktop", "Tablet", "Mobile", "Compact"];
    const links: VariableInput[] = Array.from({ length: 40 }, (_, i) => ({ name: i === 0 ? "A" : `L${i}`, type: "STRING" as const,
      values: Object.fromEntries(modes.map((m) => [m, i === 39 ? "Inter" : { aliasOf: `L${i + 1}` }])) }));
    const started = performance.now();
    const c = closureOf(links);
    return c.complete && c.names.split(",").length === 40 && performance.now() - started < 1000;
  })());
  check("[closure] a cycle is incomplete", !closureOf([{ name: "A", type: "FLOAT", values: { L: { aliasOf: "B" } } }, { name: "B", type: "FLOAT", values: { L: { aliasOf: "A" } } }]).complete);
  check("[closure] a dangling alias (here a composed colour's opacity half) is incomplete",
    !closureOf([{ name: "A", type: "COLOR", values: { L: { composed: { color: "#fff", opacity: { aliasOf: "Gone" } } } } }]).complete);
}

// ---------------------------------------------------------------- composed colours
console.log("composed — a colour plus a separate 0–100 opacity is ONE colour:");
{
  const ds = doc([
    { name: "Red", type: "COLOR", key: "r", values: { M: "#ff0000" } },
    { name: "Half", type: "COLOR", key: "h", values: { M: "#ff000080" } },
    { name: "Op60", type: "FLOAT", key: "o", scopes: ["COLOR_OPACITY"], values: { M: 60 } },
    { name: "OpText", type: "FLOAT", key: "ot", values: { M: "40" } },
    { name: "A", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: 60 } } } },
    { name: "B", type: "COLOR", values: { M: { composed: { color: "#ff000080", opacity: { aliasOf: "Op60" } } } } },
    { name: "Over", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: 120 } } } },
    { name: "Under", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: -5 } } } },
    { name: "Text", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: { aliasOf: "OpText" } } } } },
    { name: "Nested", type: "COLOR", values: { M: { composed: { color: { aliasOf: "B" }, opacity: 50 } } } },
    { name: "Lost", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: { aliasOf: "Gone" } } } } },
    { name: "Loop", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Loop2" }, opacity: 50 } } } },
    { name: "Loop2", type: "COLOR", values: { M: { aliasOf: "Loop" } } },
  ]);
  // a hand-written file can hold what the type cannot: doc-guards' isComposed refuses it
  (ds.variables || []).push(variable({ name: "Literal", type: "COLOR", values: { M: malformed({ composed: { color: "#ff0000", opacity: 50 } }) } }));
  const vars = variableResolver(ds);
  const rows: Array<{ what: string; name: string; alpha: number | null; hex: string | undefined }> = [
    { what: "colour alias + opacity 60: alpha 0.6, channels kept", name: "A", alpha: 0.6, hex: "#ff000099" },
    { what: "a colour with alpha 128/255 + opacity alias 60: multiplied", name: "B", alpha: (128 / 255) * 0.6, hex: "#ff00004d" },
    { what: "opacity 120 clamps to 100: opaque", name: "Over", alpha: 1, hex: "#ff0000" },
    { what: "opacity -5 clamps to 0: transparent", name: "Under", alpha: 0, hex: "#ff000000" },
    { what: "a string-number FLOAT opacity reads as its number", name: "Text", alpha: 0.4, hex: "#ff000066" },
    { what: "a colour half aliasing a composed colour folds both, unrounded", name: "Nested", alpha: (128 / 255) * 0.6 * 0.5, hex: "#ff000026" },
    { what: "an opacity half that does not resolve: unresolved", name: "Lost", alpha: null, hex: undefined },
    { what: "a colour half that cycles back: unresolved", name: "Loop", alpha: null, hex: undefined },
    { what: "a malformed composed value (two literals — a plain colour is never composed) is unresolved, not folded", name: "Literal", alpha: null, hex: undefined },
  ];
  for (const r of rows) {
    const v = vars.target(r.name);
    const c = vars.colour(v);
    check(`[composed] ${r.what}`, (r.alpha === null ? c === null : near(c?.a, r.alpha) && c?.r === 255 && c.g === 0) && vars.resolve(v).value === r.hex);
  }
  check("[number] a number, or a string-number FLOAT; null for anything else", vars.number(vars.target("Op60")) === 60 && vars.number(vars.target("OpText")) === 40 && vars.number(vars.target("Red")) === null);
  check("[colour] the legacy {r,g,b,a} spelling (0–1 channels) is a colour too", (() => { const c = readColour({ r: 1, g: 0.5, b: 0, a: 0.5 }); return !!c && c.r === 255 && c.g === 127.5 && c.a === 0.5; })());
}

// ---------------------------------------------------------------- every caller gives the same answer
// The inputs the characterization commit pinned as disagreeing, read through each caller's own surface.
const nativeLine = (ds: TokensDoc, field: string): string | undefined =>
  toNative(ds, "react-native").text.split("\n").find((l) => l.trimStart().startsWith(field + ":"))?.trim();
// the first collection's `dark: {` block (a multi-mode collection), that field's literal
const nativeModeValue = (ds: TokensDoc, field: string, mode = "dark"): string | undefined => {
  const lines = toNative(ds, "react-native").text.split("\n");
  const at = lines.findIndex((l) => l.trim() === mode + ": {");
  const hit = lines.slice(at + 1).find((l) => l.trim().startsWith(field + ":"));
  return at < 0 || hit === undefined ? undefined : /"([^"]*)"/.exec(hit)?.[1];
};
const cssLine = (ds: TokensDoc, prop: string): string | undefined => toCSS(ds).split("\n").find((l) => l.trimStart().startsWith(prop + ":"))?.trim();
// one frame that binds `fg` on text and `bg` on its own fill, so the plan skeleton and cross-check both read them
const bindingDoc = (fg: string, bg: string, resolvedModes?: Record<string, string>): ScreenDoc => {
  const label: NodeInput = { type: "TEXT", id: "2:1", name: "Label", text: "Hello", font: { family: "Inter", size: 14 }, tokens: { fills: fg } };
  return screenExport([{ type: "FRAME", id: "1:1", name: "Screen", ...(resolvedModes ? { resolvedModes } : {}), tokens: { fills: bg }, children: [label] }], { screen: "Screen" });
};
const planValue = (ds: TokensDoc, name: string, resolvedModes: Record<string, string> = {}): unknown =>
  buildTokens(bindingDoc(name, name, resolvedModes), ds, ds, resolvedModes).find((r) => r.figmaName === name)?.value;
const pairRows = (ds: TokensDoc, fg: string, bg: string) =>
  crossCheck({ screens: [{ doc: bindingDoc(fg, bg), label: "Screen" }], variables: ds }).findings.find((f) => f.code === "token-pair-contrast")?.tokenPairs ?? [];
const lookup = (ds: TokensDoc, hex: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-var-resolve-"));
  try {
    fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify(ds));
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { tokensMain([path.join(dir, "tokens.json"), "--lookup", hex]); } finally { console.log = log; }
    return lines.join("\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

console.log("callers — one alias, two variables called 'Brand/600':");
{
  // Neither candidate shares the referrer's collection; the lower key (aaaa…) is the near-white one. Before: tokens.css
  // and the plan skeleton said #eeeeee, the native emitters and cross-check #111111.
  const ds = tokens({
    collections: [{ name: "Screen", modes: ["Mode 1"], default: "Mode 1" }, { name: "Primitives", modes: ["Mode 1"], default: "Mode 1" },
      { name: "Semantic", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Brand/600", type: "COLOR", collection: "Screen", key: "aaaa1111aaaa", values: { "Mode 1": "#eeeeee" } },
      { name: "Brand/600", type: "COLOR", collection: "Primitives", key: "bbbb2222bbbb", values: { "Mode 1": "#111111" } },
      { name: "Action", type: "COLOR", collection: "Semantic", key: "cccc3333cccc", values: { "Mode 1": { aliasOf: "Brand/600" } } },
      { name: "Bg", type: "COLOR", collection: "Semantic", key: "dddd4444dddd", values: { "Mode 1": "#ffffff" } },
    ],
  });
  check("[callers/dup] tokens.css points the alias at the lowest key (aaaa…)", cssLine(ds, "--Action") === "--Action: var(--Brand-600-aaaa1111);");
  check("[callers/dup] the plan skeleton reads #eeeeee", planValue(ds, "Action") === "#eeeeee");
  check("[callers/dup] the native emitters write #eeeeee", nativeLine(ds, "action") === "action: \"#eeeeee\", // Action");
  check("[callers/dup] cross-check judges #eeeeee on white (a failing row)", pairRows(ds, "Action", "Bg").some((r) => r.fg === "Action"));
}

console.log("callers — a screen-local variable aliasing the library variable of the SAME name:");
{
  // Before: tokens.css wrote `--Space-4-aaaa1111: var(--Space-4-aaaa1111);` (itself) and the native emitters skipped it as a cycle.
  const ds = tokens({
    collections: [{ name: "Library", modes: ["Mode 1"], default: "Mode 1" }, { name: "Local", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Space/4", type: "FLOAT", collection: "Library", key: "bbbb2222bbbb", values: { "Mode 1": 24 } },
      { name: "Space/4", type: "FLOAT", collection: "Local", key: "aaaa1111aaaa", values: { "Mode 1": { aliasOf: "Space/4" } } },
    ],
  });
  check("[callers/self] the plan skeleton reads the library's 24", planValue(ds, "Space/4") === 24);
  check("[callers/self] tokens.css points the local variable at the library's", cssLine(ds, "--Space-4-aaaa1111") === "--Space-4-aaaa1111: var(--Space-4-bbbb2222);");
  check("[callers/self] the native emitters write the library's 24", toNative(ds, "react-native").text.includes("export const localTokens = {\n  space4: 24, // Space/4\n"));
}

console.log("callers — a 12-hop alias chain:");
{
  // Before: the native emitters and --lookup followed it; the plan skeleton (depth 10) and cross-check (depth 8) gave up.
  const hops = 12;
  const chain = Array.from({ length: hops }, (_, i) => ({
    name: `C${i}`, type: "COLOR" as const, collection: "Theme", key: `k${String(i).padStart(4, "0")}`,
    values: { "Mode 1": i === hops - 1 ? "#ff0000" : { aliasOf: `C${i + 1}` } },
  }));
  const ds = tokens({
    collections: [{ name: "Theme", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [...chain, { name: "Bg", type: "COLOR", collection: "Theme", key: "kbg", values: { "Mode 1": "#ff0000" } }],
  });
  check("[callers/depth] the native emitters follow it to the end", nativeLine(ds, "c0") === "c0: \"#ff0000\", // C0");
  check("[callers/depth] tokens --lookup follows it", /C0 .*Mode 1/.test(lookup(ds, "#ff0000")));
  check("[callers/depth] the plan skeleton follows it", planValue(ds, "C0") === "#ff0000");
  check("[callers/depth] cross-check follows it (red on red: a 1:1 row)", pairRows(ds, "C0", "Bg").some((r) => r.fg === "C0"));
}

console.log("callers — an alias into a collection whose modes differ by case:");
{
  // Before: the plan skeleton matched 'dark' for 'Dark'; native Dark and --lookup fell to Ink's default (light).
  const ds = tokens({
    collections: [{ name: "Semantic", modes: ["Light", "Dark"], default: "Light" }, { name: "Palette", modes: ["light", "dark"], default: "light" }],
    variables: [
      { name: "Text", type: "COLOR", collection: "Semantic", key: "t1", values: { Light: { aliasOf: "Ink" }, Dark: { aliasOf: "Ink" } } },
      { name: "Ink", type: "COLOR", collection: "Palette", key: "i1", values: { light: "#000000", dark: "#ffffff" } },
    ],
  });
  check("[callers/mode] the plan skeleton reads 'dark' for 'Dark'", planValue(ds, "Text", { Semantic: "Dark", Palette: "Dark" }) === "#ffffff");
  check("[callers/mode] native Dark lands in Ink's dark", nativeModeValue(ds, "text") === "#ffffff");
  check("[callers/mode] tokens --lookup #ffffff finds Text in Dark", /Text .*Dark/.test(lookup(ds, "#ffffff")));
}

report();
