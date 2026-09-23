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
//   node bridge/src/seed-components.ts [codeRoot=.] [outDir=design]
//
// Merges into design/components.json fill-missing-only (never clobbers hand-authored fields) and, for
// forms that carry only a node-id, resolves it to the Figma component NAME via design/design-system.json.

import fs from "node:fs";
import path from "node:path";
import { ID, parseNodeId } from "./node-id.ts";

const codeRoot = process.argv[2] || ".";
const outDir = process.argv[3] || "design";

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
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
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
interface Mapping { identifier?: string; url: string; source?: string }

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
    push({ identifier: comp, url: m[1], source: src });
  }

  // 2) Legacy React call form.
  while ((m = JS_CONNECT_RE.exec(text))) push({ identifier: m[1], url: m[2] });

  // 3) SwiftUI / Compose: the real component is `component = X.self` / `X::class`, NOT the wrapper type.
  if (/FigmaConnect/.test(text)) {
    const comps: Array<{ name: string; index: number }> = [];
    let c: RegExpExecArray | null;
    while ((c = NATIVE_COMP_RE.exec(text))) comps.push({ name: c[1], index: c.index });
    while ((m = NATIVE_URL_RE.exec(text))) {
      // nearest `component = X.self` to this URL; fall back to the enclosing type name.
      let best: string | undefined, bestD = Infinity;
      for (const cc of comps) { const d = Math.abs(cc.index - m.index); if (d < bestD) { bestD = d; best = cc.name; } }
      if (!best) {
        const before = text.slice(Math.max(0, m.index - 500), m.index);
        const t = (before.match(/(?:struct|class|object)\s+([A-Za-z0-9_]+)/g) || []).pop();
        if (t) best = t.split(/\s+/).pop();
      }
      push({ identifier: best, url: m[1] });
    }
  }
  return out;
}

function loadJson(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as unknown; } catch (e) { return undefined; }
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
// from disk, so every read below is guarded exactly as it was in plain JS.
interface DsJson { components?: unknown; files?: { componentsLocal?: unknown } }
interface CatalogRow { id?: unknown; name?: unknown }

function loadIdToName(dir: string): Map<unknown, unknown> {
  const idToName = new Map<unknown, unknown>();
  const ds = loadJson(path.join(dir, "design-system.json")) as DsJson | null | undefined;
  if (!ds) return idToName;
  const inline = Array.isArray(ds.components) ? ds.components : null;
  const pointer = ds.files && typeof ds.files === "object" ? ds.files.componentsLocal : null;
  // ts-port: path.join throws on a non-string pointer, exactly as it did before (String() is not applied).
  const rows = inline || (pointer ? ((loadJson(path.join(dir, pointer as string)) || {}) as DsJson).components : null);
  if (Array.isArray(rows)) for (const c of rows as CatalogRow[]) if (c && c.id) idToName.set(c.id, c.name);
  return idToName;
}

/** One components.json entry (hand-authored or seeded). */
export interface ComponentsEntry { component?: unknown; source?: unknown; nodeId?: unknown; import?: unknown; props?: unknown }

function main(): void {
  const idToName = loadIdToName(outDir);

  const files: string[] = [];
  walk(codeRoot, files);

  const found: Array<{ name: string; identifier: string | undefined; nodeId: string | undefined; source: string }> = [];
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    // Gate: a Code Connect signal of any kind — a node-id URL, the call form, or the native marker.
    if (text.indexOf("node-id=") === -1 && text.indexOf("figma.connect") === -1 && text.indexOf("FigmaConnect") === -1) continue;
    for (const mp of extractMappings(text)) {
      const nodeId = parseNodeId(mp.url);
      // ts-port: a catalog `name` is untyped JSON; the cast only names the type it is used as — it is an
      // object key below, where plain JS already coerced it to a string.
      const name = ((nodeId && idToName.get(nodeId)) || mp.identifier) as string | undefined;
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
  const existing: Record<string, ComponentsEntry | undefined> = Object.assign(Object.create(null), loadJson(outPath) || {});
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

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));
  console.error(`[seed-components] ${found.length} mapping(s) from ${files.length} scanned file(s) → ${outPath}`);
  console.error(`[seed-components] ${added} new entr(ies), ${filled} field(s) filled. Fill in each entry's "import" and "props".`);
  if (!idToName.size) console.error("[seed-components] tip: export design-system.json first so node-id-only mappings resolve to real component names.");
}

// Only when RUN (it is a CLI, driven by the tests as a subprocess). Nothing imports this module, so
// the guard changes nothing for the subprocess; it only keeps an import from scanning the tree.
if (import.meta.main) main();
