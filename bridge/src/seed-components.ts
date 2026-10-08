#!/usr/bin/env node
// seed-components — pre-populate design/components.json from Code Connect files in the codebase.
//
// Code Connect files ARE the Figma-component -> code-component mapping you'd otherwise hand-author,
// and they're plain source files, so reading them is FREE (no MCP, no REST, no paid plan). This turns
// components.json from fully hand-authored into mostly-generated; you only fill prop maps by hand.
//
// It recognizes all three shapes Code Connect uses:
//   1) Template files (.figma.js/.ts) — `// url=` + `// component=` + `// source=` header comments
//      (the format the current Figma CLI/MCP emit; gives component + source DIRECTLY, most reliable).
//   2) Legacy React    — `figma.connect(Component, "https://…node-id=1-2", {…})`.
//   3) SwiftUI/Compose — `FigmaConnect` with `let component = Button.self` / `component = Button::class`.
//
// Usage:
//   dtwin seed [codeRoot=.] [outDir=design] [--dry-run]              (routed by figma-pull.ts)
//   node bridge/src/seed-components.ts [codeRoot=.] [outDir=design] [--dry-run]   (the same, run directly)
//
// Merges into design/components.json fill-missing-only (never clobbers hand-authored fields) and, for
// forms that carry only a node-id, resolves it to the Figma component NAME via design/design-system.json.

import fs from "node:fs";
import path from "node:path";
import { ID, parseNodeId } from "./node-id.ts";
import { ifDefined, nullProto } from "./json-util.ts";
import { writeJsonLike } from "./json-file.ts";
import { isMainFallback } from "./is-main.ts"; // import.meta.main is undefined before Node 24.2
import { SEED_HELP } from "./verbs.ts"; // the one help text, shared with `dtwin seed --help`

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "vendor", "Pods", ".build"]);
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|swift|kt|kts)$/;

// Hoisted: extractMappings runs once per candidate file and `walk` enumerates the whole repo tree, so
// building these per call recompiled three regexes thousands of times. Safe to share — every one is
// driven by a `while ((m = re.exec(text)))` loop that runs until exec returns null, which resets
// lastIndex to 0.
const URL_COMMENT_RE = new RegExp("\\/\\/\\s*url=(\\S*node-id=" + ID + "\\S*)", "g");
const JS_CONNECT_RE = new RegExp("figma\\.connect\\(\\s*([A-Za-z0-9_$.]+)?\\s*,?\\s*[\"'`]([^\"'`]*node-id=" + ID + "[^\"'`]*)[\"'`]", "g");
const NATIVE_URL_RE = new RegExp("[\"'`]([^\"'`]*node-id=" + ID + "[^\"'`]*)[\"'`]", "g");
const NATIVE_COMP_RE = /component\s*=\s*([A-Za-z0-9_]+)\s*(?:\.self|::class)/g;

function walk(dir: string, hits: string[]): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, hits);
    } else if (CODE_EXT.test(e.name)) {
      hits.push(full);
    }
  }
}

/** One Code Connect mapping found in a source file. */
// `| undefined`: an optional regex capture (JS_CONNECT_RE's identifier) or a `(match || [])[1]` read is
// assigned straight in; every reader tests these fields for truthiness, so undefined and absent read alike.
interface Mapping { identifier?: string | undefined; url: string; source?: string | undefined }

// Extract { identifier?, url, source? } mappings from one file's text, across all three shapes.
function extractMappings(text: string): Mapping[] {
  const out: Mapping[] = [];
  const seen = new Set<string>();
  const push = (o: Mapping) => { if (o.url && !seen.has(o.url)) { seen.add(o.url); out.push(o); } };

  // 1) Template files: header comments. `url=` may be a placeholder (documentUrlSubstitutions),
  //    so key off node-id, not scheme. component/source are declared right there — no name lookup needed.
  let m: RegExpExecArray | null;
  while ((m = URL_COMMENT_RE.exec(text))) {
    const win = text.slice(Math.max(0, m.index - 600), m.index + 600); // comments cluster together
    const comp = (win.match(/\/\/\s*component=([^\s]+)/) || [])[1];
    const src = (win.match(/\/\/\s*source=([^\s]+)/) || [])[1];
    const url = m[1];
    if (url === undefined) continue; // cannot happen: group 1 is not optional, so a match always sets it
    push({ identifier: comp, url, source: src });
  }

  // 2) Legacy React call form.
  while ((m = JS_CONNECT_RE.exec(text))) {
    const url = m[2];
    if (url === undefined) continue; // cannot happen: group 2 is not optional (group 1, the identifier, is)
    push({ identifier: m[1], url });
  }

  // 3) SwiftUI / Compose: the real component is `component = X.self` / `X::class`, NOT the wrapper type.
  if (/FigmaConnect/.test(text)) {
    const comps: Array<{ name: string; index: number }> = [];
    let c: RegExpExecArray | null;
    while ((c = NATIVE_COMP_RE.exec(text))) {
      const name = c[1];
      if (name !== undefined) comps.push({ name, index: c.index }); // always set: group 1 is not optional
    }
    while ((m = NATIVE_URL_RE.exec(text))) {
      // nearest `component = X.self` to this URL; fall back to the enclosing type name.
      let best: string | undefined, bestD = Infinity;
      for (const cc of comps) { const d = Math.abs(cc.index - m.index); if (d < bestD) { bestD = d; best = cc.name; } }
      if (!best) {
        const before = text.slice(Math.max(0, m.index - 500), m.index);
        const t = (before.match(/(?:struct|class|object)\s+([A-Za-z0-9_]+)/g) || []).pop();
        if (t) best = t.split(/\s+/).pop();
      }
      const url = m[1];
      if (url === undefined) continue; // cannot happen: group 1 is not optional
      push({ ...ifDefined("identifier", best), url });
    }
  }
  return out;
}

function loadJson(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as unknown; } catch { return undefined; }
}

// id -> component name, from an existing export (optional; only needed for Code Connect forms that
// give a node-id URL but no component identifier).
//
// Since the design-system split (bridge/src/design-system-layout.ts) `design-system.json` is a slim
// pointer manifest with NO `components` array — reading `ds.components` off it silently yields an
// empty map, and every node-id-only mapping is then dropped at the `if (!name) continue` below. That
// reads as a clean run that just "found fewer mappings", which is the silent-wrong-answer failure
// design-to-code/catalog-input.ts exists to prevent. So follow the `files.componentsLocal` pointer instead,
// and keep accepting an inline array for pre-split exports.
// The fields read off design-system.json (either shape) and off a components catalog. Untyped JSON
// from disk: only a row whose `id` AND `name` are strings can be a lookup entry, so the map is filled
// under that guard and typed by it.
interface DsJson { components?: unknown; files?: { componentsLocal?: unknown } }
const isDsJson = (x: unknown): x is DsJson => typeof x === "object" && x !== null && !Array.isArray(x);

function loadIdToName(dir: string): Map<string, string> {
  const idToName = new Map<string, string>();
  const ds = loadJson(path.join(dir, "design-system.json"));
  if (!isDsJson(ds)) return idToName;
  const inline = Array.isArray(ds.components) ? ds.components : null;
  const pointer = ds.files && typeof ds.files === "object" ? ds.files.componentsLocal : null;
  // A pointer that is not a string is a corrupt manifest — nothing to follow.
  const pointed = typeof pointer === "string" ? loadJson(path.join(dir, pointer)) : null;
  const rows: unknown[] | null = inline ?? (isDsJson(pointed) && Array.isArray(pointed.components) ? pointed.components : null);
  if (rows) {
    for (const c of rows) {
      if (typeof c !== "object" || c === null) continue;
      const { id, name } = c as { id?: unknown; name?: unknown };
      if (typeof id === "string" && id && typeof name === "string") idToName.set(id, name);
    }
  }
  return idToName;
}

/** One components.json entry (hand-authored or seeded). */
export interface ComponentsEntry { component?: unknown; source?: unknown; nodeId?: unknown; import?: unknown; props?: unknown }

interface SeedOptions { codeRoot: string; outDir: string; dryRun: boolean }

// argv is everything AFTER the command: `process.argv.slice(2)` when run directly, `argv.slice(1)` of
// `dtwin seed …`. Positions are unchanged from the original script: [codeRoot=.] [outDir=design], with
// an empty string falling back to the default exactly as `argv[n] || default` always did. A help probe
// wins over everything else and has no side effects; an unknown flag is refused instead of being taken
// as a codeRoot spelled `--something`.
export function main(argv: string[]): void {
  if (argv.some((a) => a === "--help" || a === "-h")) {
    console.log(SEED_HELP);
    process.exit(0);
  }
  let dryRun = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("-") && a !== "-") {
      console.error(`[seed-components] error: unknown flag ${a} — use: dtwin seed [codeRoot] [outDir] [--dry-run]`);
      process.exit(2);
    } else positional.push(a);
  }
  run({ codeRoot: positional[0] || ".", outDir: positional[1] || "design", dryRun });
}

function run({ codeRoot, outDir, dryRun }: SeedOptions): void {
  const idToName = loadIdToName(outDir);

  const files: string[] = [];
  walk(codeRoot, files);

  const found: Array<{ name: string; identifier: string | undefined; nodeId: string | undefined; source: string }> = [];
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    // Gate: a Code Connect signal of any kind — a node-id URL, the call form, or the native marker.
    if (text.indexOf("node-id=") === -1 && text.indexOf("figma.connect") === -1 && text.indexOf("FigmaConnect") === -1) continue;
    for (const mp of extractMappings(text)) {
      const nodeId = parseNodeId(mp.url);
      const name = (nodeId && idToName.get(nodeId)) || mp.identifier;
      if (!name) continue;
      found.push({ name, identifier: mp.identifier, nodeId, source: mp.source || path.relative(codeRoot, f) });
    }
  }

  if (!found.length) {
    console.error("[seed-components] no Code Connect mappings found under " + path.resolve(codeRoot) + ".");
    console.error("[seed-components] (looked for `// url=`+`// component=` templates, `figma.connect(...)`, and `@FigmaConnect`.)");
    process.exit(0);
  }

  const outPath = path.join(outDir, "components.json");
  // Null-prototype: this map is keyed by UNTRUSTED component names. On a plain object a component
  // named "__proto__" (or "constructor"/"toString") resolves to an inherited Object.prototype member,
  // so the entry looks like it already exists — it is silently dropped from components.json AND the
  // `cur.x = ...` backfills below land on Object.prototype, after which every OTHER entry's
  // `=== undefined` check is false and its source/nodeId are never filled either. Object.assign onto
  // a null-prototype target turns those names back into ordinary own keys. JSON.stringify is unaffected.
  const existing: Record<string, ComponentsEntry | undefined> = Object.assign(nullProto<ComponentsEntry | undefined>(), loadJson(outPath) || {});
  let added = 0, filled = 0;
  for (const m of found) {
    const cur = existing[m.name];
    if (!cur) {
      existing[m.name] = {
        component: m.identifier || m.name,
        source: m.source,
        nodeId: m.nodeId,
        import: "", // yours to fill — codegen reuses the component once you do
        props: {},
      };
      added++;
    } else {
      if (cur.source === undefined) { cur.source = m.source; filled++; }
      if (cur.nodeId === undefined && m.nodeId) { cur.nodeId = m.nodeId; filled++; }
      if (cur.component === undefined) cur.component = m.identifier || m.name;
    }
  }

  // --dry-run: everything above only READ; the merge result is computed in memory and dropped here.
  const dry = dryRun ? "(dry run, nothing written) " : "";
  if (!dryRun) {
    writeJsonLike(outPath, existing); // a person's hand-edited map: atomic, in its own format
  }
  console.error(`[seed-components] ${dry}${found.length} mapping(s) from ${files.length} scanned file(s) → ${outPath}`);
  console.error(`[seed-components] ${dry}${added} new entr(ies), ${filled} field(s) filled. Fill in each entry's "import" and "props".`);
  if (!idToName.size) console.error("[seed-components] tip: export design-system.json first so node-id-only mappings resolve to real component names.");
}

// Only when RUN directly (it is a CLI, driven by the tests as a subprocess). `dtwin seed` imports this
// module and calls main() itself, so the guard is what keeps that import from also scanning the tree.
if (import.meta.main ?? isMainFallback(import.meta.url)) main(process.argv.slice(2));
