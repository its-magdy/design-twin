// How an export is spelled as text, and a bounded measure of that text. Pretty-printing cost about 3.2x the bytes and
// 1.5x the tokens of the same JSON, and put a 324-node screen on 11,770 lines, so a default Read saw about 17% of it.
//
// exportJsonText is the text on disk: compact JSON with a line break before each row of a top-level array and each
// `children` element, so one node sits on one line. One unbroken line would be smaller by 0.3%, but it cannot be paged
// with a line offset and one grep hit would print the whole file.
//
// The rest is a bounded measure of `JSON.stringify(value).length`: answers "does the compact text fit in
// `limit` UTF-16 code units?" without building the text, and stops walking the moment the running total passes
// the limit. The inline-vs-spill decision for an MCP export reply needs only that answer, and a real export is
// tens of megabytes — serialising it just to learn it is over a ~48 KB cap costs seconds of CPU and a
// second copy of the export in memory, for a string that is then thrown away.
//
// The length is the one JSON.stringify produces (ECMA-262 SerializeJSONProperty / QuoteJSONString;
// https://tc39.es/ecma262/#sec-serializejsonproperty): numbers print as Number::toString (non-finite → null),
// strings escape `"`, `\`, control characters (< 0x20) and lone surrogates (a well-formed surrogate pair is
// left as is), a property whose value is undefined / a function / a symbol is skipped (null inside an array),
// an empty object or array prints as `{}` / `[]`, and members are separated by `,` with `:` after a key and no whitespace.
//
// Anything whose size JSON.stringify decides through code this walker does not mirror (a toJSON method, a
// bigint, a boxed primitive, a class instance, a very deep or cyclic value) is reported as "unsupported" so the
// caller measures it the old way; the answer is never a guess.

export type JsonSize =
  | { kind: "fits"; length: number }
  | { kind: "over" }
  | { kind: "unsupported" };

// Deeper than any real export (an IR tree is a few dozen levels); past it the recursion could overflow the
// stack, so the value is measured by JSON.stringify itself, which reports a cycle or a too-deep value its own way.
const MAX_DEPTH = 200;

// Characters that make a string's quoted form longer than its length + 2.
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** Length of `JSON.stringify(s)`. */
function quotedLength(s: string): number {
  if (!NEEDS_ESCAPE.test(s)) return s.length + 2;
  let n = s.length + 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) n += 1; // \" \\
    else if (c < 0x20) n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 1 : 5; // \b \t \n \f \r, else \u00XX
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++; // a pair is written raw
      else n += 5; // a lone high surrogate becomes \udXXX
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 5; // a lone low surrogate
  }
  return n;
}

// The three kinds JSON.stringify drops from an object and turns into null inside an array. (At the top level
// they have no JSON text at all; walk() reports them as unsupported there.)
const isOmitted = (v: unknown): boolean => v === undefined || typeof v === "function" || typeof v === "symbol";

/** Whether `JSON.stringify(value)` is at most `limit` characters long — and its exact length when it is. */
export function compactJsonSize(value: unknown, limit: number): JsonSize {
  let total = 0;
  let unsupported = false;
  // Adds to the running total; false once the limit is passed or the value is unsupported, which unwinds the walk.
  const add = (n: number): boolean => { total += n; return total <= limit; };

  const walk = (v: unknown, depth: number): boolean => {
    if (v === null) return add(4);
    if (typeof v === "string") return add(quotedLength(v));
    if (typeof v === "number") return add(Number.isFinite(v) ? String(v).length : 4);
    if (typeof v === "boolean") return add(v ? 4 : 5);
    if (typeof v !== "object") { unsupported = true; return false; } // a bigint (stringify throws), or a top-level undefined / function / symbol
    if (depth > MAX_DEPTH) { unsupported = true; return false; }
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) { unsupported = true; return false; }
      if (v.length === 0) return add(2);
      if (!add(2 + (v.length - 1))) return false; // [ ] and the commas between items
      for (let i = 0; i < v.length; i++) {
        const item: unknown = v[i];
        if (isOmitted(item)) { if (!add(4)) return false; } else if (!walk(item, depth + 1)) return false;
      }
      return true;
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) { unsupported = true; return false; }
    const rec = v as Record<string, unknown>;
    if (typeof rec["toJSON"] === "function") { unsupported = true; return false; }
    let members = 0;
    if (!add(2)) return false; // { }
    for (const key of Object.keys(rec)) {
      const member = rec[key];
      if (isOmitted(member)) continue;
      // the quoted key, ":", and a "," before every member but the first
      if (!add(quotedLength(key) + 1 + (members ? 1 : 0))) return false;
      members++;
      if (!walk(member, depth + 1)) return false;
    }
    return true;
  };

  const done = walk(value, 0);
  if (unsupported) return { kind: "unsupported" };
  return done ? { kind: "fits", length: total } : { kind: "over" };
}

/** `JSON.stringify(value)` when its text is at most `limit` characters, else null — the same answer as
 *  stringifying first and comparing `.length`, without serialising a value that is over the limit. */
export function compactJsonWithin(value: unknown, limit: number): string | null {
  const size = compactJsonSize(value, limit);
  if (size.kind === "over") return null;
  const text = JSON.stringify(value);
  // Unsupported shapes were not measured: the text is the measure.
  return size.kind === "fits" || text.length <= limit ? text : null;
}

const isRow = (v: unknown): boolean => typeof v === "object" && v !== null;

function spell(v: unknown, key: string | null, depth: number): string | undefined {
  if (!isRow(v)) return JSON.stringify(v);
  if (Array.isArray(v)) {
    const items = Array.from(v, (x: unknown) => { const t = spell(x, null, depth + 1); return t === undefined ? "null" : t; });
    return (depth <= 1 || key === "children") && v.some(isRow) ? "[\n" + items.join(",\n") + "\n]" : "[" + items.join(",") + "]";
  }
  const proto: unknown = Object.getPrototypeOf(v);
  const rec = v as Record<string, unknown>;
  if ((proto !== Object.prototype && proto !== null) || typeof rec["toJSON"] === "function") return JSON.stringify(v);
  const members: string[] = [];
  for (const k of Object.keys(rec)) {
    const text = spell(rec[k], k, depth + 1);
    if (text !== undefined) members.push(JSON.stringify(k) + ":" + text);
  }
  return "{" + members.join(",") + "}";
}

/** The text of an export file: JSON.stringify(doc) with a line break before each row of a top-level array and each
 *  `children` element. String values escape their own newlines, so removing every line break gives the compact text. */
export function exportJsonText(doc: unknown): string {
  const text = spell(doc, null, 0);
  return text === undefined ? "null" : text;
}

/** Characters per token of compact export JSON, measured with cl100k on two real screens (2.82 and 2.90; pretty-printed
 *  JSON was 6.03). An estimate: the inline limit keeps headroom on top of it. */
export const COMPACT_CHARS_PER_TOKEN = 2.8;
