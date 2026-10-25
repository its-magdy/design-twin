// test/variable-resolve.test.ts — "what value does this variable have in mode M".
// Characterization: the same inputs read through each resolver that exists today (tokens.css, the native
// emitters, the plan skeleton, cross-check's contrast and tokens --lookup), pinned where they DISAGREE.
// Run with:  bun test/variable-resolve.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toCSS } from "../design-to-code/tokens.ts";
import { toNative } from "../design-to-code/tokens-native.ts";
import { buildTokens } from "../design-to-code/plan-skeleton.ts";
import { crossCheck } from "../design-to-code/cross-check.ts";
import { main as tokensMain } from "../design-to-code/tokens.ts";
import { screenExport, tokens } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import type { ScreenDoc, TokensDoc } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

// --- the readers, each through its caller's own surface
const nativeLine = (ds: TokensDoc, field: string): string | undefined =>
  toNative(ds, "react-native").text.split("\n").find((l) => l.trimStart().startsWith(field + ":"))?.trim();
// the first collection's `dark: {` block (a multi-mode collection), that field's literal
const nativeModeValue = (ds: TokensDoc, field: string, mode = "dark"): string | undefined => {
  const lines = toNative(ds, "react-native").text.split("\n");
  const at = lines.findIndex((l) => l.trim() === mode + ": {");
  const hit = lines.slice(at + 1).find((l) => l.trim().startsWith(field + ":"));
  return at < 0 || hit === undefined ? undefined : /"([^"]*)"/.exec(hit)?.[1];
};
const cssLine =(ds: TokensDoc, prop: string): string | undefined => toCSS(ds).split("\n").find((l) => l.trimStart().startsWith(prop + ":"))?.trim();
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

console.log("characterization — duplicate names (one alias, two variables called 'Brand/600'):");
{
  // Neither candidate shares the referrer's collection. The lower key (aaaa…) is the near-white one.
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
  check("[dup] tokens.css points the alias at the lowest key (aaaa…, #eeeeee)", cssLine(ds, "--Action") === "--Action: var(--Brand-600-aaaa1111);");
  check("[dup] the plan skeleton takes the first listed (aaaa…, #eeeeee)", planValue(ds, "Action") === "#eeeeee");
  check("[dup] DISAGREES: the native emitters take the last listed (bbbb…, #111111)", nativeLine(ds, "action") === "action: \"#111111\", // Action");
  check("[dup] DISAGREES: cross-check's contrast takes the last listed (#111111 on white passes — no row)", pairRows(ds, "Action", "Bg").length === 0);
}

console.log("characterization — a screen-local variable aliasing the library variable of the SAME name:");
{
  const ds = tokens({
    collections: [{ name: "Library", modes: ["Mode 1"], default: "Mode 1" }, { name: "Local", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [
      { name: "Space/4", type: "FLOAT", collection: "Library", key: "bbbb2222bbbb", values: { "Mode 1": 24 } },
      { name: "Space/4", type: "FLOAT", collection: "Local", key: "aaaa1111aaaa", values: { "Mode 1": { aliasOf: "Space/4" } } },
    ],
  });
  check("[self] the plan skeleton reads the library's 24", planValue(ds, "Space/4") === 24);
  check("[self] DISAGREES: tokens.css points the local variable at ITSELF (its own collection is preferred)",
    cssLine(ds, "--Space-4-aaaa1111") === "--Space-4-aaaa1111: var(--Space-4-aaaa1111);");
  check("[self] DISAGREES: the native emitters see a cycle and skip it", !toNative(ds, "react-native").text.includes("space4_aaaa1111"));
}

console.log("characterization — alias chain length (12 hops to a literal):");
{
  const hops = 12;
  const chain = Array.from({ length: hops }, (_, i) => ({
    name: `C${i}`, type: "COLOR" as const, collection: "Theme", key: `k${String(i).padStart(4, "0")}`,
    values: { "Mode 1": i === hops - 1 ? "#ff0000" : { aliasOf: `C${i + 1}` } },
  }));
  const ds = tokens({
    collections: [{ name: "Theme", modes: ["Mode 1"], default: "Mode 1" }],
    variables: [...chain, { name: "Bg", type: "COLOR", collection: "Theme", key: "kbg", values: { "Mode 1": "#ff0000" } }],
  });
  check("[depth] the native emitters follow it to the end (a seen set, no cap)", nativeLine(ds, "c0") === "c0: \"#ff0000\", // C0");
  check("[depth] tokens --lookup follows it (cap: 20 hops)", /C0 .*Mode 1/.test(lookup(ds, "#ff0000")));
  check("[depth] DISAGREES: the plan skeleton gives up (cap: depth 10)", planValue(ds, "C0") === null);
  // red on red is 1:1 — a row only if the fg resolved
  check("[depth] DISAGREES: cross-check gives up (cap: depth 8 — no row)", pairRows(ds, "C0", "Bg").length === 0);
}

console.log("characterization — mode fallback (an alias into a collection whose modes differ by case):");
{
  const ds = tokens({
    collections: [{ name: "Semantic", modes: ["Light", "Dark"], default: "Light" }, { name: "Palette", modes: ["light", "dark"], default: "light" }],
    variables: [
      { name: "Text", type: "COLOR", collection: "Semantic", key: "t1", values: { Light: { aliasOf: "Ink" }, Dark: { aliasOf: "Ink" } } },
      { name: "Ink", type: "COLOR", collection: "Palette", key: "i1", values: { light: "#000000", dark: "#ffffff" } },
    ],
  });
  check("[mode] the plan skeleton reads a case-only match ('dark' for 'Dark')", planValue(ds, "Text", { Semantic: "Dark", Palette: "Dark" }) === "#ffffff");
  check("[mode] DISAGREES: native Dark hops into Ink's DEFAULT (light, #000000)", nativeModeValue(ds, "text") === "#000000");
  check("[mode] DISAGREES: tokens --lookup #ffffff misses Text in Dark", !/Text/.test(lookup(ds, "#ffffff")));
}

report();
