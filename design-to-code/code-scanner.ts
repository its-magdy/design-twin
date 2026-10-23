// code-scanner.ts — what the Stop hook (verify-build.ts) reads out of a build's source files: the text that is code
// (comments and prose strings blanked), the colour literals and Tailwind arbitrary values in it, whether a literal sits
// on a token's own definition line, what a file imports, and the project graph (every plan's files, their import edges,
// the stylesheets) that says which files can render a screen. No plan policy lives here: verify-build decides what
// blocks and what warns; this module only reads code. Token names are token-naming.ts's.
import fs from "node:fs";
import path from "node:path";
import { colorKey, formatHex, parseCssColor } from "./color.ts";
import { getOrInit } from "./map-util.ts";
import { namesToken } from "./token-naming.ts";

/** One file with its text (rel is project-relative). */
export interface FileText { rel: string; text: string }

// ================================================================ the text that is code

// Files whose text is CODE. Everything else in files[] (exported .svg artwork, .json data, docs,
// images, Dockerfiles) is not scanned for literals: a colour there is data, not a styling decision.
const SOURCE_EXT = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "astro", "css", "scss", "sass", "less", "styl", "html", "htm",
  "swift", "kt", "kts", "java", "dart", "xml", "m", "mm", "h", "cs", "xaml"]);
// split() always returns at least one element, so pop() is never undefined: `?? ""` is inert.
const extOf = (rel: string): string => String(rel).toLowerCase().split(".").pop() ?? "";
export const isSourceFile = (rel: string): boolean => SOURCE_EXT.has(extOf(rel));
const STYLESHEET_EXT = new Set(["css", "scss", "sass", "less", "styl"]);
const isStylesheet = (rel: string): boolean => STYLESHEET_EXT.has(extOf(rel));

// A string literal that is prose — a provenance note like "bound to Neutrals/Neutral 0, #121319 in
// Dark" — rather than a style value. Three plain words in a row is prose; `1px solid #fff`,
// `bg-[#fff] px-4` and `#fff` are not.
const PROSE = /\b[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}\b/;
const isProse = (s: string): boolean => PROSE.test(s) && !/-\[|\[#/.test(s);

/** The text the literal scan looks at: comments removed; prose strings blanked. Keeps line structure (newlines
 *  survive) so per-line definition detection still works. */
export function scanText(rel: string, text: string): string {
  const ext = extOf(rel);
  const lineComments = !["css", "html", "htm", "xml", "xaml"].includes(ext);
  const htmlComments = ["html", "htm", "xml", "xaml", "vue", "svelte", "astro"].includes(ext);
  const strings = !["html", "htm", "xml", "xaml"].includes(ext);
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "*") { const j = text.indexOf("*/", i + 2); const end = j === -1 ? n : j + 2; out += text.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (lineComments && c === "/" && d === "/" && text[i - 1] !== ":") { const j = text.indexOf("\n", i); const end = j === -1 ? n : j; out += " ".repeat(end - i); i = end; continue; }
    if (htmlComments && text.startsWith("<!--", i)) { const j = text.indexOf("-->", i + 4); const end = j === -1 ? n : j + 3; out += text.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (strings && (c === '"' || c === "'" || c === "`")) {
      let j = i + 1;
      while (j < n && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      const body = text.slice(i + 1, j);
      out += isProse(body) ? c + body.replace(/[^\n]/g, " ") + (text[j] === c ? c : "") : text.slice(i, end);
      i = end;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** The source files among `files`, each as its scanText (the text the literal checks read). */
export const codeOf = (files: readonly FileText[]): FileText[] => files.filter((f) => isSourceFile(f.rel)).map((f) => ({ rel: f.rel, text: scanText(f.rel, f.text) }));

// ================================================================ literals

/** Every raw colour literal in the source, keyed by colorKey ("#rrggbbaa", color.ts) -> the spelling found.
 *  Alpha is part of the key (live run #25): `#ffffff` and `#ffffff1a` are different colours bound to
 *  different tokens, and folding them together cross-contaminated both directions. */
export function colorLiterals(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const add = (h: string | null, lit: string): void => { if (h && !found.has(h)) found.set(h, lit); };
  for (const m of source.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g)) add(colorKey(m[1]), m[0]);
  // Compose / Flutter `Color(0xFF5B5FC7)` — AARRGGBB (alpha FIRST), or bare 0xRRGGBB.
  for (const m of source.matchAll(/\b0x([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) {
    const g = m[1];
    if (g === undefined) continue; // the group is not optional: set whenever the regex matched
    const h = g.toLowerCase();
    add("#" + (h.length === 8 ? h.slice(2) + h.slice(0, 2) : h + "ff"), m[0]);
  }
  // rgb()/rgba() in either CSS syntax, read by color.ts parseCssColor (the probe's own reader); a call it
  // cannot read (a var(), a template placeholder) is not a literal.
  for (const m of source.matchAll(/rgba?\([^()]*\)/g)) {
    const c = parseCssColor(m[0]);
    if (c) add(colorKey(formatHex(c)), m[0]);
  }
  return found;
}

// Tailwind arbitrary dimensions: the utility PREFIX says which kind the number is (seen in a live run:
// `rounded-[20px]` is not the 20px a fontSize token resolves to).
const UTILITY_KIND: Array<[RegExp, string]> = [
  [/^rounded(-[a-z]+)?$/, "radius"],
  [/^text$/, "fontSize"],
  [/^leading$/, "lineHeight"],
  [/^tracking$/, "letterSpacing"],
  [/^(gap|gap-x|gap-y|space-x|space-y)$/, "spacing"],
  [/^([pm][trblxy]?)$/, "spacing"],
  [/^(top|right|bottom|left|inset(-[xy])?|start|end)$/, "spacing"],
  [/^(w|h|min-w|min-h|max-w|max-h|size|basis)$/, "size"],
  [/^border(-[trblxyse]+)?$/, "borderWidth"],
];
const KIND_MATCHES: Record<string, string[]> = {
  radius: ["radius", "borderradius", "cornerradius"],
  fontSize: ["fontsize", "font-size", "type", "typography"],
  lineHeight: ["lineheight", "line-height"],
  letterSpacing: ["letterspacing", "letter-spacing", "tracking"],
  spacing: ["spacing", "space", "gap", "padding", "margin", "size", "dimension"],
  size: ["size", "spacing", "space", "dimension", "width", "height"],
  borderWidth: ["borderwidth", "border-width", "border", "stroke"],
};
function utilityKind(utility: string | null | undefined): string | null {
  const u = String(utility || "").replace(/^-/, "");
  for (const [re, kind] of UTILITY_KIND) if (re.test(u)) return kind;
  return null;
}
/** Could an arbitrary value on `utility` (`rounded`, `gap-x`, null = unknown) be a token of `rowKind`? Unknown on
 *  either side keeps the check. */
export function kindsCompatible(utility: string | null | undefined, rowKind: unknown): boolean {
  const uk = utilityKind(utility);
  if (!uk) return true;
  const rk = String(rowKind || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!rk) return true;
  return (KIND_MATCHES[uk] || []).some((k) => k.replace(/[^a-z]/g, "") === rk);
}
/** An arbitrary value: its spelling (`[16px]`) and the utility it was on (null when none). */
export interface PxHit { literal: string; utility: string | null }
/** Every Tailwind arbitrary `[Npx]` / `[Nrem]` value, keyed by its px number. */
export function arbitraryPx(source: string): Map<number, PxHit[]> {
  const found = new Map<number, PxHit[]>();
  for (const m of source.matchAll(/(?:^|[\s"'`{(])([a-z-]+)-\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[2]) * (m[3] === "rem" ? 16 : 1);
    const entry: PxHit = { literal: `[${m[2]}${m[3]}]`, utility: m[1] ?? null }; // ?? null: the group is not optional, so it never applies
    const list = found.get(px) || [];
    if (!list.some((e) => e.utility === entry.utility)) list.push(entry);
    found.set(px, list);
  }
  for (const m of source.matchAll(/\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
    if (!found.has(px)) found.set(px, [{ literal: m[0], utility: null }]);
  }
  return found;
}

// ================================================================ definition lines

// Token definitions are not token usages. A DEFINITION line declares the code token itself:
// `--color-figma-brand-600: #5b5fc7` (web-tailwind's `figma-` namespace, profile web-tailwind.md),
// `--brand-600: #5b5fc7`, `brand600: "#5b5fc7"`, `val brand600 = Color(0xFF5B5FC7)`. The declared
// name must be the TOKEN's (token-naming.ts namesToken) — `color: #5b5fc7` inside a component declares a CSS property.
const DECLARATION = /(^|[\s;{,(])(--[\w-]+|[\w$][\w$-]*)\s*[:=]\s*[^;,}\n]*$/;

// The bracketed blocks of a text — `{…}`, `(…)`, `[…]` — each with its HEAD: the text of its opening line up to the
// bracket (`data class ColorsTokens(`, `export const colorsTokens = {`, `val ColorsTokensLight = ColorsTokens(`).
// Memoised per text: literalUses asks once per occurrence. An unclosed block runs to the end of the text.
interface Block { open: number; close: number; head: string }
const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const blockCache = new Map<string, Block[]>();
function blocksOf(text: string): Block[] {
  const have = blockCache.get(text);
  if (have) return have;
  const out: Block[] = [], stack: Array<{ open: number; want: string }> = [];
  const headOf = (open: number): string => text.slice(text.lastIndexOf("\n", open) + 1, open);
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    // a bracket inside a string is not one: skip a quoted string — to its closing quote on the same line (a lone `'` in
    // prose, `don't`, is no string), a template literal to its closing backtick, a `"""`/`'''` string to its closing triple
    if ((c === '"' || c === "'") && text.startsWith(c + c + c, i)) {
      const end = text.indexOf(c + c + c, i + 3);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== c && (c === "`" || text.charAt(j) !== "\n")) j += text.charAt(j) === "\\" ? 2 : 1;
      if (j < text.length && text.charAt(j) === c) i = j;
      continue;
    }
    const want = CLOSER[c];
    if (want !== undefined) { stack.push({ open: i, want }); continue; }
    if (c !== ")" && c !== "]" && c !== "}") continue;
    // a closer closes the nearest block it matches (any unclosed ones inside it end with it); one matching none is stray
    let k = stack.length - 1;
    while (k >= 0 && stack[k]?.want !== c) k--;
    if (k < 0) continue;
    for (const s of stack.splice(k).reverse()) out.push({ open: s.open, close: i, head: headOf(s.open) });
  }
  for (const s of stack) out.push({ open: s.open, close: text.length, head: headOf(s.open) });
  if (blockCache.size > 64) blockCache.clear();
  blockCache.set(text, out);
  return out;
}
/** The heads of every block that encloses position `index` of `text`, innermost last. */
export const enclosingHeads = (text: string, index: number): string[] =>
  blocksOf(text).filter((b) => b.open < index && index <= b.close).sort((a, b) => a.open - b.open).map((b) => b.head);

/** Is the value at `index` of `file` (scanText'd) — the start of a literal — the value of a declaration of `codeToken`? */
export function isDefinitionAt(file: FileText, index: number, codeToken: string): boolean {
  const lineStart = file.text.lastIndexOf("\n", index - 1) + 1;
  const m = DECLARATION.exec(file.text.slice(lineStart, index));
  // group 2 is not optional: set whenever the regex matched
  return !!m && namesToken(m[2] ?? "", codeToken, { stylesheet: isStylesheet(file.rel), enclosing: () => enclosingHeads(file.text, index) });
}
// A line is a DEFINITION line for `literal` when EVERY occurrence of it on the line is the value of
// a declaration of one of `codeTokens` — every plan token that resolves to this literal, not only the
// row being checked: `--color-surface: #1d1d1f; --color-canvas: #1d1d1f;` defines two tokens that share
// a value, and neither definition is a "usage" of the other.
function definesAny(file: FileText, lineStart: number, line: string, literal: string, codeTokens: readonly string[]): boolean {
  let at = line.indexOf(literal);
  if (at === -1) return false;
  while (at !== -1) {
    const index = lineStart + at;
    if (!codeTokens.some((t) => isDefinitionAt(file, index, t))) return false;
    at = line.indexOf(literal, at + literal.length);
  }
  return true;
}

/** Where `literal` occurs in `code` (scanText'd source): `found` — in any file; `usedIn` — the files with an occurrence
 *  that is not on a definition line of one of `codeTokens` (every plan token that resolves to this value). A file in
 *  `exempt` (a token file a plan names in allowedLiterals) counts as found, never as a use. */
export function literalUses(code: readonly FileText[], literal: string, codeTokens: readonly string[], exempt: readonly string[] = []): { found: boolean; usedIn: string[] } {
  let found = false;
  const usedIn: string[] = [];
  if (!literal) return { found, usedIn };
  for (const f of code) {
    if (!f.text.includes(literal)) continue;
    found = true;
    if (exempt.includes(f.rel)) continue;
    let lineStart = 0;
    for (const line of f.text.split("\n")) {
      if (line.includes(literal) && !definesAny(f, lineStart, line, literal, codeTokens)) { usedIn.push(f.rel); break; }
      lineStart += line.length + 1;
    }
  }
  return { found, usedIn };
}

/** Every CSS custom property DECLARED in the files (`--color-x:`, lower-cased), comments stripped. */
export function declaredCustomProps(files: readonly FileText[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const text = isSourceFile(f.rel) ? scanText(f.rel, f.text) : f.text;
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) { const n = m[1]; if (n !== undefined) out.add(n.toLowerCase()); }
  }
  return out;
}

// ================================================================ imports

/** Module specifiers a source file imports: ES `import … from`, bare `import "x"`, `export … from`, dynamic
 *  `import("x")`, CommonJS `require("x")`, CSS `@import`. */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  const re = /\bimport\s+(?:[^'"`;]*?\sfrom\s+)?["'`]([^"'`]+)["'`]|\bexport\s+[^'"`;]*?\sfrom\s+["'`]([^"'`]+)["'`]|\b(?:require|import)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|@import\s+(?:url\()?["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1] || m[2] || m[3] || m[4]; // each alternative captures a non-empty specifier, so one is always set
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

const SRC_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|css|scss|swift|kt|dart)$/i;
// "app/src/components/PageTitle.tsx" / "@/components/PageTitle" / "../../../components/PageTitle/index"
// → ["components", "PageTitle"] style segments, extension and trailing /index dropped, alias
// prefixes (`@/`, `~/`, `#/`, `@alias/`) and `.`/`..` removed.
function moduleSegments(spec: unknown): string[] {
  let s = String(spec || "").trim().replace(/\\/g, "/").replace(SRC_EXT_RE, "").replace(/\/index$/i, "");
  const segs = s.split("/").filter((x) => x && x !== "." && x !== "..");
  const [first] = segs;
  if (first !== undefined && /^[@~#]$/.test(first)) segs.shift();
  return segs;
}

// importsOf per file text, memoised: the import graph below asks the same file about every other file.
const importCache = new Map<string, string[]>();
const cachedImports = (text: string): string[] => getOrInit(importCache, text, () => importsOf(text));

/** Does any of `files` import `mapModule`? Relative specifiers are resolved against the importing file, then compared
 *  with mapModule by path SUFFIX; alias / bare specifiers are compared by suffix directly. A `mapModule` written as a repo
 *  path (`app/src/components/PageTitle.tsx`) therefore matches `'../../../components/PageTitle'` and
 *  `'@/components/PageTitle'` alike (a plain substring test would be unsatisfiable). Non-JS stacks (Swift/Kotlin/Dart
 *  import modules, not files): the component's own name used as an identifier counts. */
export function moduleImported(mapModule: string, files: readonly FileText[], cwd: string): boolean {
  const want = moduleSegments(mapModule);
  if (!want.length) return true;
  const suffixMatch = (have: string[]): boolean => {
    const k = Math.min(have.length, want.length);
    if (!k) return false;
    for (let i = 1; i <= k; i++) {
      const h = have[have.length - i], w = want[want.length - i]; // i <= k <= both lengths, so both are set
      if (h === undefined || w === undefined || h.toLowerCase() !== w.toLowerCase()) return false;
    }
    return true;
  };
  const wantAbs = moduleSegments(path.relative(cwd, path.resolve(cwd, String(mapModule))));
  for (const f of files) {
    for (const spec of cachedImports(f.text)) {
      if (spec.startsWith(".")) {
        const resolved = moduleSegments(path.relative(cwd, path.resolve(cwd, path.dirname(f.rel), spec)));
        if (resolved.join("/").toLowerCase() === wantAbs.join("/").toLowerCase() || suffixMatch(resolved)) return true;
      } else if (suffixMatch(moduleSegments(spec))) return true;
    }
    if (!/\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i.test(f.rel)) {
      const name = want[want.length - 1];
      if (name && new RegExp(`\\b${name.replace(/[^A-Za-z0-9_]/g, "")}\\b`).test(f.text)) return true;
    }
  }
  return false;
}

// ================================================================ the project graph

// `bytes` (when given) receives each file's raw bytes, which the text is decoded from.
function readFiles(rels: readonly string[], cwd: string, bytes?: Map<string, Buffer>): FileText[] {
  const out: FileText[] = [];
  for (const rel of rels) {
    const abs = path.join(cwd, rel);
    try {
      if (!fs.statSync(abs).isFile()) continue;
      const buf = fs.readFileSync(abs);
      out.push({ rel, text: buf.toString("utf8") });
      bytes?.set(rel, buf);
    } catch { /* absent: reported for its own plan */ }
  }
  return out;
}

// Every plan's files[], read once per hook run: their texts, how many plans list each file, and the import graph
// between the script files (each file's imports parsed once, then resolved through a path-suffix index — linear in
// files + imports, not files²).
const SCRIPT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i;
/** The project's stylesheets, and whether it has a Tailwind v3 config (its colours live there, not in CSS vars). */
export interface StyleScan { css: FileText[]; tailwindConfig: boolean }
export interface ProjectGraph {
  files: FileText[];
  /** how many file lists (plans) name each file */
  listCount: Map<string, number>;
  byRel: Map<string, FileText>;
  /** the project's .css files and whether it has a tailwind.config.* (walked on first use) */
  scan: () => StyleScan;
  /** the bytes the graph read for `rel` — undefined when it did not read it, or the run has since rewritten it */
  cached: (rel: string) => Buffer | undefined;
  /** records that the run wrote `file` (a plan), so cached() no longer answers for it */
  rewrote: (file: string) => void;
  /** the files whose imports count for a screen whose own files are `own` (see reachable below) */
  reachable: (own: readonly string[]) => FileText[];
}
/** The graph over every file in `lists` (each plan's files[]) plus `extra`, read now. */
export function projectGraph(cwd: string, lists: Iterable<readonly string[]>, extra: readonly string[] = []): ProjectGraph {
  const listCount = new Map<string, number>();
  for (const list of lists) for (const f of new Set(list)) listCount.set(f, (listCount.get(f) || 0) + 1);
  const bytes = new Map<string, Buffer>();
  const files = readFiles([...new Set([...listCount.keys(), ...extra])], cwd, bytes);
  const byRel = new Map(files.map((f): [string, FileText] => [f.rel, f]));
  const rewritten = new Set<string>();
  const cached = (rel: string): Buffer | undefined => (rewritten.has(path.resolve(cwd, rel)) ? undefined : bytes.get(rel));
  const rewrote = (file: string): void => { rewritten.add(path.resolve(cwd, file)); };
  const scripts = files.filter((f) => SCRIPT_RE.test(f.rel));
  const lower = (segs: string[]): string => segs.map((x) => x.toLowerCase()).join("/");
  const bySuffix = new Map<string, string[]>(), byFull = new Map<string, string[]>();
  for (const f of scripts) {
    const segs = moduleSegments(f.rel);
    getOrInit(byFull, lower(segs), () => []).push(f.rel);
    for (let i = 0; i < segs.length; i++) getOrInit(bySuffix, lower(segs.slice(i)), () => []).push(f.rel);
  }
  const kids = new Map<string, string[]>(), parents = new Map<string, string[]>();
  for (const f of scripts) {
    const found = new Set<string>();
    for (const spec of cachedImports(f.text)) {
      const segs = spec.startsWith(".") ? moduleSegments(path.relative(cwd, path.resolve(cwd, path.dirname(f.rel), spec))) : moduleSegments(spec);
      if (!segs.length) continue;
      for (const r of bySuffix.get(lower(segs)) || []) found.add(r); // spec is a suffix of the file's path
      for (let i = 1; i < segs.length; i++) for (const r of byFull.get(lower(segs.slice(i))) || []) found.add(r); // the file's path is a suffix of the spec
    }
    found.delete(f.rel);
    kids.set(f.rel, [...found]);
    for (const r of found) getOrInit(parents, r, () => []).push(f.rel);
  }
  let scanned: StyleScan | null = null;
  // a Tailwind config is looked for directly at the root and at each listed file's package root, not
  // only by the (capped) walk
  const scan = (): StyleScan => {
    if (scanned) return scanned;
    const walked = projectScan(cwd);
    const dirs = new Set([path.resolve(cwd), ...files.map((f) => packageDirOf(cwd, f.rel))]);
    return (scanned = { css: walked.css, tailwindConfig: walked.tailwindConfig || [...dirs].some(hasTwConfig) });
  };
  // The files whose imports count for a screen whose files are `own`: its own files; the files they
  // import (one hop — the shell a screen renders in); every ANCESTOR (a file that transitively imports one of
  // them: App → router → routes → this page); and the files an ancestor imports — except another screen's
  // own file (listed by exactly one plan, not this one): App → Page → {ScreenA, ScreenB} must not let plan A
  // borrow ScreenB's imports, while App → AppShell (listed by several plans) → Sidebar does count. The reverse
  // walk keeps a visited set, so an import cycle cannot loop.
  const reachable = (own: readonly string[]): FileText[] => {
    const mine = new Set(own);
    const ancestors = new Set<string>();
    const queue = own.filter((r) => kids.has(r));
    for (let i = 0; i < queue.length; i++) {
      for (const par of parents.get(queue[i] ?? "") || []) if (!mine.has(par) && !ancestors.has(par)) { ancestors.add(par); queue.push(par); }
    }
    const out = new Set<string>([...mine, ...ancestors]);
    for (const r of mine) for (const k of kids.get(r) || []) out.add(k);
    const steppable = (r: string): boolean => mine.has(r) || (listCount.get(r) || 0) !== 1;
    for (const r of ancestors) for (const k of kids.get(r) || []) if (steppable(k)) out.add(k);
    return [...out].map((r) => byRel.get(r)).filter((f): f is FileText => !!f);
  };
  return { files, listCount, byRel, scan, cached, rewrote, reachable };
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "design", ".next", "out", "coverage", ".turbo", ".svelte-kit", ".nuxt", ".output",
  "Pods", ".venv", "venv", "vendor", "target", "tmp"]);
const TW_CONFIG = /^tailwind\.config\.(js|cjs|mjs|ts|mts|cts)$/i;
const hasTwConfig = (dir: string): boolean => { try { return fs.readdirSync(dir).some((n) => TW_CONFIG.test(n)); } catch { return false; } };
// The package root a file belongs to: the nearest directory up from it (not above cwd) with a package.json.
function packageDirOf(cwd: string, rel: string): string {
  const root = path.resolve(cwd);
  for (let d = path.dirname(path.resolve(cwd, rel)); d.startsWith(root); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, "package.json"))) return d;
    if (d === root) break;
  }
  return root;
}
// The project's stylesheets, and whether it has a Tailwind v3 config (its colours live there, not in CSS vars).
function projectScan(cwd: string, limit = 2000): StyleScan {
  const css: FileText[] = [];
  let tailwindConfig = false;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (css.length >= limit) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); }
      else if (e.isFile() && TW_CONFIG.test(e.name)) tailwindConfig = true;
      else if (e.isFile() && /\.css$/i.test(e.name)) {
        try { css.push({ rel: path.relative(cwd, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "utf8") }); } catch { /* unreadable: skip */ }
      }
    }
  };
  walk(cwd);
  return { css, tailwindConfig };
}
