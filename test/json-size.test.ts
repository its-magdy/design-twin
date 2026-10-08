// The bounded size check behind the MCP inline-vs-spill decision (bridge/src/json-size.ts): it must answer exactly
// what `JSON.stringify(value, null, 2).length <= limit` answers, return byte-identical text when it fits, and stop
// walking once the limit is passed. No port, no bridge: pure functions.
// Run with:  node test/json-size.test.ts
import { ok, report } from "./assert.ts";
import { prettyJsonSize, prettyJsonWithin } from "../bridge/src/json-size.ts";

// The formula the MCP server used before: serialise, then compare the length.
const oldDecision = (v: unknown, limit: number): string | null => {
  const text = JSON.stringify(v, null, 2);
  return text.length <= limit ? text : null;
};
const same = (v: unknown, limit: number): boolean => prettyJsonWithin(v, limit) === oldDecision(v, limit);
// All limits around the true length: exactly at, -1, +1, plus the extremes.
const aroundCap = (v: unknown): boolean => {
  const len = JSON.stringify(v, null, 2).length;
  return [0, 1, len - 2, len - 1, len, len + 1, len + 2, len * 2 + 10].every((l) => l < 0 || same(v, l));
};

// ---- the threshold, on a realistic export shape
const node = (i: number) => ({ id: `1:${i}`, name: `Row ${i}`, type: "TEXT", box: { x: 0, y: i * 40, w: 390, h: 40 }, characters: `Row label ${i}`, visible: true, opacity: 0.5, children: [] as unknown[] });
const exp = { screen: "Home", nodes: Array.from({ length: 300 }, (_, i) => node(i)), assets: [], durationMs: { total: 12, request: 10, write: 0 } };
const expLen = JSON.stringify(exp, null, 2).length;
ok("fixture: an export of a few tens of KB", expLen > 20000 && expLen < 200000);
ok("exactly at the cap: fits, and the text is the stringified text", prettyJsonWithin(exp, expLen) === JSON.stringify(exp, null, 2));
ok("one under the cap: over", prettyJsonWithin(exp, expLen - 1) === null);
ok("one over the cap: fits", prettyJsonWithin(exp, expLen + 1) === JSON.stringify(exp, null, 2));
ok("prettyJsonSize reports the exact length when it fits", JSON.stringify(prettyJsonSize(exp, expLen)) === JSON.stringify({ kind: "fits", length: expLen }));
ok("prettyJsonSize reports over at cap-1", prettyJsonSize(exp, expLen - 1).kind === "over");
ok("around the cap, the export gives the old answer", aroundCap(exp));
const DEFAULT_CAP = 48000;
ok("at the real inline cap, a payload on either side agrees with the old formula", [10, 400, 700].every((n) => same({ nodes: Array.from({ length: n }, (_, i) => node(i)) }, DEFAULT_CAP)));

// ---- value shapes: each compared with JSON.stringify around its own length
const shapes: Array<[string, unknown]> = [
  ["empty object", {}], ["empty array", []], ["nested empties", { a: {}, b: [], c: [[]], d: [{}] }],
  ["null / booleans", { a: null, b: true, c: false }],
  ["numbers", [0, -0, 1.5, -2, 1e21, 1e-7, 123456789012345680000, Number.MAX_VALUE, Number.MIN_VALUE]],
  ["non-finite numbers", [NaN, Infinity, -Infinity, { n: NaN }]],
  ["undefined / function / symbol members", { a: undefined, b: () => 1, c: Symbol("x"), d: 1 }],
  ["undefined / function / symbol items", [undefined, () => 1, Symbol("x"), 1]],
  ["only omitted members", { a: undefined }],
  ["a sparse array", [, 1, , ]],
  ["escapes", ["\"", "\\", "\b", "\t", "\n", "\f", "\r", "\u0000", "\u001f", "\u007f", "/", " ", " "]],
  ["escaped keys", { 'a"b': 1, "c\nd": 2, "": 3, "ключ": 4, "\u0001": 5 }],
  ["non-ASCII text", { name: "Überschrift – 日本語 – العربية – ñ", emoji: "😀👍🏽 family 👨‍👩‍👧" }],
  ["lone surrogates", ["\ud800", "\udc00", "a\ud800b", "\ud800\ud800", "\udc00\ud800", "😀\ud83d", "\ud83d😀"]],
  ["numeric-looking keys (order is not length)", { 2: "b", 1: "a", x: "c" }],
  ["deep nesting", Array.from({ length: 150 }).reduce<unknown>((acc) => ({ k: [acc] }), "leaf")],
  ["a null-prototype object", Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: [2] })],
];
for (const [name, v] of shapes) ok(`${name}: the same answer as the old formula around its length`, aroundCap(v));

// ---- shapes the walker does not mirror are measured by their text, still with the old answer
const exotic: Array<[string, unknown]> = [
  ["a Date", { when: new Date(0) }],
  ["a toJSON method", { x: { toJSON: () => ({ replaced: "yes" }) }, y: 1 }],
  ["a boxed number / string / boolean", [new Number(5), new String("s"), new Boolean(true)]],
  ["a class instance", new (class Box { w = 1; h = [2]; })()],
  ["a Map", { m: new Map([[1, 2]]) }],
  ["a typed array", { b: new Uint8Array([1, 2, 3]) }],
];
for (const [name, v] of exotic) {
  ok(`${name}: reported unsupported and decided like the old formula`, prettyJsonSize(v, 1e9).kind === "unsupported" && aroundCap(v));
}
ok("a too-deep value is measured by stringify, not by recursion", prettyJsonSize(Array.from({ length: 500 }).reduce<unknown>((acc) => [acc], 1), 1e9).kind === "unsupported");
ok("a bigint throws as before", (() => { try { prettyJsonWithin({ n: 1n }, 100); return false; } catch { return true; } })());
ok("a cycle throws as before", (() => { const c: Record<string, unknown> = {}; c["self"] = c; try { prettyJsonWithin(c, 1e9); return false; } catch { return true; } })());

// ---- a seeded fuzz: random JSON-like values, every limit around the length
let seed = 20240607;
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const CHARS = ["a", "Z", " ", "\"", "\\", "\n", "\t", "\u0000", "\u001f", "é", "日", "😀", "\ud800", "\udc00", "/", "{", "]"];
const rndStr = (): string => Array.from({ length: Math.floor(rnd() * 8) }, () => pick(CHARS)).join("");
const rndVal = (d: number): unknown => {
  const k = Math.floor(rnd() * (d > 4 ? 6 : 9));
  if (k === 0) return null;
  if (k === 1) return rnd() < 0.5;
  if (k === 2) return pick([0, -0, 1, -1.5, 1e21, 1e-9, NaN, Infinity, 42]);
  if (k === 3) return rndStr();
  if (k === 4) return rnd() < 0.5 ? undefined : pick([0.1, 7]);
  if (k === 5) return rndStr();
  if (k === 6) return Array.from({ length: Math.floor(rnd() * 5) }, () => rndVal(d + 1));
  return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, () => [rndStr(), rndVal(d + 1)]));
};
let fuzzOk = true, fuzzed = 0;
for (let i = 0; i < 3000 && fuzzOk; i++) {
  const v = { root: rndVal(0) };
  if (!aroundCap(v)) { fuzzOk = false; console.log("   fuzz mismatch: " + JSON.stringify(v)); }
  fuzzed++;
}
ok(`fuzz: ${fuzzed} random values agree with the old formula at every limit around their length`, fuzzOk && fuzzed === 3000);

// ---- the walk stops at the cap
let visited = 0;
// Many members, each a getter that counts its reads (an array's fixed overhead is added up front, so it would trip the cap before any read).
const counted: Record<string, string> = {};
for (let i = 0; i < 100000; i++) Object.defineProperty(counted, "k" + i, { enumerable: true, get: () => { visited++; return "some text to fill the row"; } });
ok("an over-the-cap value is not walked to the end", prettyJsonSize(counted, 1000).kind === "over" && visited > 0 && visited < 100);
visited = 0;
ok("an over-the-cap value is not serialised either", prettyJsonWithin(counted, 1000) === null && visited < 100);

report();
