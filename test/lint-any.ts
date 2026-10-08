#!/usr/bin/env node
// lint:any — the "no `any` in hand-written TypeScript" gate (owner rule).
//
// Scans test/, design-to-code/, bridge/src/ and figma-plugin/src/ (recursively, node_modules skipped), plus the
// hand-written TypeScript outside them (the two build scripts, figma-augment.d.ts), and exits 1 with
// file:line for every hit of any rule:
//
//  1. LITERAL `any` — `: any`, `as any`, `<any>`, `any[]`, `Record<string, any>` anywhere in any file
//     (the same regex the old grep gate used; this script itself is skipped — its own patterns match).
//
//  2. IMPLICIT `any` from JSON.parse — lib.d.ts types `JSON.parse(...)` as `any`, so a bare call leaks
//     an untyped value. In .ts/.mts/.cts files, every `JSON.parse(` call must be typed IN PLACE, i.e.:
//       a. the call's matching `)` is followed by `as <Type>` (possibly on a later line), e.g.
//          `JSON.parse(s) as PagesRootIndex`, `JSON.parse(s) as unknown`, `JSON.parse(s) as T`; or
//       b. the call is the direct right-hand side of a typed declaration on the same line —
//          `const x: T = JSON.parse(...)` / `let x: T = JSON.parse(...)` (heuristic: the text before
//          the call on that line matches `: <no = or ;> =`).
//     Everything else is a hit — including `x = JSON.parse(...)` into a variable declared elsewhere,
//     `return JSON.parse(...)`, and object-literal values; write `as T` there.
//     Heuristic limits: the matching-paren scan understands '…', "…" and `…` strings (with escapes)
//     but not regex literals, so a regex argument must have balanced parens; an occurrence with `//`
//     anywhere before it on its line (a line comment — or, the known blind spot, a URL in an earlier
//     string) and one on a ` * ` / `/*` block-comment line are ignored; a JSON.parse spelled inside a
//     string literal (e.g. a generated child script) is treated like code, so type it too.
//
//  3. IMPLICIT `any` from a computed dynamic import — `import(x)` with a non-literal specifier is
//     `Promise<any>`. In .ts/.mts/.cts files, an `import(` whose argument is NOT one plain '…'/"…"
//     string literal (i.e. contains `+`, a template literal, or an identifier/call) must be typed in
//     place: the `(await import(...))` it sits in, or the call itself, is followed by `as <Type>`
//     (checked after the call's matching `)`, and after one enclosing `)` for the `(await import(x))`
//     form). A literal specifier is typed by TypeScript from the module and is not checked. Same
//     comment heuristic as rule 2; `typeof import("…")` type queries are literal, so exempt. Unlike
//     rule 2, an `import(` preceded on its line by an ODD number of backticks is skipped: it is text
//     inside a template literal — the source of a generated plain-JS child script (bridge.test.ts's
//     drain.mjs), which cannot carry `as T`.
//
//  4. DOUBLE ASSERTION — `as unknown as T` (whitespace/newlines between the words allowed) anywhere in
//     a .ts/.mts/.cts file. It forces any value into any type with no check at all, which is how test
//     fixtures drifted from the IR while the types said otherwise (test/assert.ts). Build the value
//     properly instead: a test/fixtures.ts builder, a complete literal, `satisfies`, or a type guard
//     that checks at runtime; a deliberately MALFORMED test input goes through fixtures.ts
//     `malformed()`. There is no exception marker. Comments are skipped like rule 2's (so prose that
//     names the pattern, like this, is fine), except that a `//` inside an earlier string on the line
//     (a URL) does not count as one. Text inside a string literal is treated as code — over-flagging,
//     never a miss.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIRS = ["test", "design-to-code", "bridge/src", "figma-plugin/src"];
const FILES = ["claude-plugin/build-scripts.ts", "figma-plugin/build.ts", "figma-plugin/figma-augment.d.ts"];
const SELF = path.resolve(import.meta.filename);
const LITERAL = /: any|as any|<any>|any\[\]|Record<string, any>/;
const TS = /\.(ts|mts|cts)$/;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Index just past the `)` matching the `(` at `open`, or -1. Skips quoted strings. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Whether `before` (a line's text up to a match) opens a `//` line comment OUTSIDE a quoted string —
 *  so a URL in an earlier string literal does not hide the match. Used by rule 4 only. */
function inLineComment(before: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && before[i + 1] === "/") return true;
  }
  return false;
}

function* sources(): Generator<string> {
  for (const dir of DIRS) yield* walk(path.join(ROOT, dir));
  for (const f of FILES) yield path.join(ROOT, f);
}

const hits: string[] = [];
for (const file of sources()) {
  if (path.resolve(file) === SELF) continue;
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  const lines = src.split("\n");
  lines.forEach((l, i) => { if (LITERAL.test(l)) hits.push(`${rel}:${i + 1}: literal any: ${l.trim()}`); });
  if (!TS.test(file)) continue;
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (off: number): number => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; const start = lineStarts[m]; if (start !== undefined && start <= off) lo = m; else hi = m - 1; } return lo; };
  for (const m of src.matchAll(/JSON\.parse\(/g)) {
    const ln = lineOf(m.index);
    const before = src.slice(lineStarts[ln], m.index);
    if (before.includes("//") || /^\s*(\*|\/\*)/.test(before)) continue; // comment
    const end = matchParen(src, m.index + "JSON.parse".length);
    const typedAfter = end > 0 && /^\s*as\s/.test(src.slice(end, end + 200));
    const typedDecl = /:[^=;]*[^=!<>]=\s*$/.test(before);
    if (!typedAfter && !typedDecl) hits.push(`${rel}:${ln + 1}: untyped JSON.parse: ${(lines[ln] ?? "").trim().slice(0, 140)}`);
  }
  for (const m of src.matchAll(/(?<![\w.$])import\(/g)) {
    const ln = lineOf(m.index);
    const before = src.slice(lineStarts[ln], m.index);
    if (before.includes("//") || /^\s*(\*|\/\*)/.test(before)) continue; // comment
    if ((before.match(/`/g) || []).length % 2 === 1) continue; // inside a template literal (generated JS source)
    const open = m.index + "import".length;
    const end = matchParen(src, open);
    if (end < 0) continue;
    const arg = src.slice(open + 1, end - 1).trim();
    if (/^("[^"\\]*"|'[^'\\]*')$/.test(arg)) continue; // plain string literal: typed from the module
    let after = src.slice(end, end + 200);
    if (/^\s*\)/.test(after)) after = after.replace(/^\s*\)/, ""); // `(await import(x)) as T`
    if (!/^\s*as\s/.test(after)) hits.push(`${rel}:${ln + 1}: untyped computed import(): ${(lines[ln] ?? "").trim().slice(0, 140)}`);
  }
  for (const m of src.matchAll(/\bas\s+unknown\s+as\b/g)) {
    const ln = lineOf(m.index);
    const before = src.slice(lineStarts[ln], m.index);
    if (inLineComment(before) || /^\s*(\*|\/\*)/.test(before)) continue; // comment
    hits.push(`${rel}:${ln + 1}: double assertion (as unknown as): ${(lines[ln] ?? "").trim().slice(0, 140)}`);
  }
}
if (hits.length) {
  console.error(hits.join("\n"));
  console.error(`lint:any — ${hits.length} hit(s). Type JSON.parse results in place (\`as T\` / \`const x: T = …\`), never \`any\`; cast a computed \`import()\` result with \`as T\`; never \`as unknown as T\` — build the value (test/fixtures.ts) or narrow it with a runtime check.`);
  process.exit(1);
}
console.log("lint:any — 0 hits");
