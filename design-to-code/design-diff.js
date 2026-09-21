#!/usr/bin/env node
// design-diff.js — what CHANGED between two exports of the same screen (or the same token file).
//
// A re-pull overwrites the export in place, and "the designer changed the header" then has no answer
// except rebuilding the screen — which discards every hand edit made since the first build. This is
// the deterministic half of the alternative: keep the previous export, diff the two by node id, and
// hand the agent a short list of what actually moved so it can patch only that.
//
//   node design-diff.js --snapshot <file.json>...        keep a copy BEFORE re-pulling (design/.sync/)
//   node design-diff.js <file.json> [--against <old>]    diff against the snapshot (else git HEAD)
//        [--json] [--out <file>]
//
// Nodes are matched by `id` — stable across exports of one Figma file; a name is not (renaming a layer
// must read as "renamed", not "deleted + added"). Exit 0 = compared (changes or not), 2 = usage /
// nothing to compare against.
//
// What is deliberately NOT reported as a change:
//   - `box.x` / `box.y` / `renderBox`: page-space positions. Insert one row and every node below it
//     "moves" — hundreds of changes describing none. Size (`box.w`/`box.h`) IS reported, but only on a
//     node whose own size is fixed; a hug/fill node's size is a consequence of something else in the list.
//   - `exportedAt`, `manifest`, `snapshot`: facts about the export run, not the design.
//   - descendants of an added/removed node: the top-most node stands for its subtree.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CATEGORY = {
  text: ["text", "runs", "truncate", "maxLines", "autoResize"],
  typography: ["font", "textTokens", "missingFont"],
  paint: ["fills", "strokes", "effects", "opacity", "blendMode", "mask", "maskType"],
  layout: ["layout", "widthMode", "heightMode", "sizeLimits", "aspectRatio", "grow", "alignSelf", "absolute", "pin", "clip", "fixedChildren", "strokesInLayout", "layoutGrids",
    "gridColumnSpan", "gridRowSpan", "gridColumnStart", "gridRowStart", "gridJustifySelf", "gridAlignSelf", "size"],
  shape: ["radius", "cornerSmoothing", "rotation", "flipped", "skew", "arc", "shape", "booleanOp"],
  tokens: ["tokens", "styles", "variableModes", "propTokens"],
  component: ["component", "mainComponent", "props", "propRefs", "overrides", "exposedInstances", "detachedFrom", "tableCells"],
  visibility: ["hidden"],
  asset: ["asset", "geometry", "assetSkipped", "exportSettings"],
  interaction: ["reactions", "overlay", "motion"],
  handoff: ["annotations", "devStatus", "devStatusNote", "name", "type"],
};
const CATEGORY_OF = new Map(Object.entries(CATEGORY).flatMap(([cat, fields]) => fields.map((f) => [f, cat])));
const IGNORED = new Set(["children", "box", "renderBox", "id", "css", "measurements", "pluginData", "sharedData"]);

const roots = (doc) => (Array.isArray(doc.nodes) ? doc.nodes : doc.tree && typeof doc.tree === "object" ? [doc.tree] : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const brief = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s === undefined ? undefined : s.length > 160 ? s.slice(0, 157) + "…" : s; };

// id -> { node, parentId, path, childIds }
function index(doc) {
  const out = new Map();
  const walk = (node, parentId, trail) => {
    if (!node || typeof node !== "object" || node.id === undefined) return;
    const here = [...trail, node.name || node.type || node.id];
    const kids = Array.isArray(node.children) ? node.children : [];
    out.set(String(node.id), { node, parentId, path: here.join(" > "), childIds: kids.map((k) => String(k && k.id)) });
    for (const k of kids) walk(k, String(node.id), here);
  };
  for (const r of roots(doc)) walk(r, null, []);
  return out;
}

const describe = (e) => ({ id: String(e.node.id), name: e.node.name, type: e.node.type, path: e.path, parentId: e.parentId });

function nodeFields(before, after) {
  const fields = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key) || same(before[key], after[key])) continue;
    fields.push({ field: key, category: CATEGORY_OF.get(key) || "other", before: brief(before[key]), after: brief(after[key]) });
  }
  // A fixed-size node's own size is a design decision; a hug/fill node's size only echoes other changes.
  const fixedW = !after.widthMode && !before.widthMode, fixedH = !after.heightMode && !before.heightMode;
  const b = before.box || {}, a = after.box || {};
  if ((fixedW && b.w !== a.w) || (fixedH && b.h !== a.h)) fields.push({ field: "size", category: "layout", before: `${b.w}×${b.h}`, after: `${a.w}×${a.h}` });
  return fields;
}

function diffScreens(oldDoc, newDoc) {
  const A = index(oldDoc), B = index(newDoc);
  const added = [], removed = [], changed = [], reordered = [];
  let positionOnly = 0;
  // Top-most only: a node whose parent is ALSO new/gone is covered by that parent's entry.
  for (const [id, e] of B) if (!A.has(id) && (e.parentId === null || A.has(e.parentId))) added.push(describe(e));
  for (const [id, e] of A) if (!B.has(id) && (e.parentId === null || B.has(e.parentId))) removed.push(describe(e));
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const fields = nodeFields(a.node, b.node);
    if (a.parentId !== b.parentId) fields.push({ field: "parent", category: "layout", before: a.path, after: b.path });
    if (fields.length) changed.push({ ...describe(b), categories: [...new Set(fields.map((f) => f.category))], fields });
    else if (!same(a.node.box, b.node.box)) positionOnly++;
    const keptBefore = a.childIds.filter((c) => b.childIds.includes(c)), keptAfter = b.childIds.filter((c) => a.childIds.includes(c));
    if (!same(keptBefore, keptAfter)) reordered.push({ ...describe(b), before: keptBefore.map((c) => A.get(c).node.name), after: keptAfter.map((c) => B.get(c).node.name) });
  }
  return { kind: "screen", summary: { added: added.length, removed: removed.length, changed: changed.length, reordered: reordered.length, positionOnly }, added, removed, reordered, changed };
}

function diffTokens(oldDoc, newDoc) {
  const A = new Map((oldDoc.variables || []).map((v) => [v.name, v])), B = new Map((newDoc.variables || []).map((v) => [v.name, v]));
  const added = [...B.keys()].filter((n) => !A.has(n)), removed = [...A.keys()].filter((n) => !B.has(n)), changed = [];
  for (const [name, b] of B) {
    const a = A.get(name);
    if (!a) continue;
    const modes = [...new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])].filter((m) => !same((a.values || {})[m], (b.values || {})[m]));
    if (modes.length) changed.push({ name, collection: b.collection, modes: modes.map((m) => ({ mode: m, before: brief((a.values || {})[m]), after: brief((b.values || {})[m]) })) });
  }
  return { kind: "tokens", summary: { added: added.length, removed: removed.length, changed: changed.length }, added, removed, changed };
}

const isTokens = (doc) => Array.isArray(doc && doc.variables);
const diffDocs = (oldDoc, newDoc) => (isTokens(newDoc) ? diffTokens(oldDoc, newDoc) : diffScreens(oldDoc, newDoc));

function markdown(d, label) {
  const s = d.summary, L = [`# What changed — ${label}`, ""];
  const total = s.added + s.removed + s.changed + (s.reordered || 0);
  if (!total) return L.concat(d.kind === "screen" && s.positionOnly ? `Nothing changed (${s.positionOnly} node(s) only moved with their surroundings).` : "Nothing changed.").join("\n") + "\n";
  if (d.kind === "tokens") {
    if (d.changed.length) L.push("## Token values changed", ...d.changed.map((c) => `- \`${c.name}\` — ${c.modes.map((m) => `${m.mode}: ${m.before} → ${m.after}`).join("; ")}`), "");
    if (d.added.length) L.push("## Tokens added", ...d.added.map((n) => `- \`${n}\``), "");
    if (d.removed.length) L.push("## Tokens removed", ...d.removed.map((n) => `- \`${n}\``), "");
    return L.join("\n") + "\n";
  }
  if (d.changed.length) L.push("## Changed", ...d.changed.flatMap((c) => [`- **${c.path}** (\`${c.id}\`, ${c.categories.join(" + ")})`, ...c.fields.map((f) => `  - \`${f.field}\`: ${f.before === undefined ? "—" : f.before} → ${f.after === undefined ? "—" : f.after}`)]), "");
  if (d.added.length) L.push("## Added (each stands for its whole subtree)", ...d.added.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.removed.length) L.push("## Removed (each stands for its whole subtree)", ...d.removed.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.reordered.length) L.push("## Reordered children", ...d.reordered.map((r) => `- **${r.path}**: ${r.before.join(", ")} → ${r.after.join(", ")}`), "");
  if (s.positionOnly) L.push(`_${s.positionOnly} other node(s) only moved with their surroundings — not listed._`, "");
  return L.join("\n") + "\n";
}

// design/pages/home/login.json -> design/.sync/pages__home__login.json (relative to the project root)
function snapshotPath(file, cwd = process.cwd()) {
  const rel = path.relative(path.join(cwd, "design"), path.resolve(cwd, file));
  const flat = (rel.startsWith("..") ? path.basename(file) : rel).split(path.sep).join("__");
  return path.join(cwd, "design", ".sync", flat);
}

function previous(file, against, cwd = process.cwd()) {
  if (against) return { doc: JSON.parse(fs.readFileSync(against, "utf8")), source: against };
  const snap = snapshotPath(file, cwd);
  if (fs.existsSync(snap)) return { doc: JSON.parse(fs.readFileSync(snap, "utf8")), source: path.relative(cwd, snap) };
  try {
    const rel = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/");
    const text = execFileSync("git", ["show", "HEAD:./" + rel], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    return { doc: JSON.parse(text), source: "git HEAD" };
  } catch { return null; }
}

function main(argv) {
  const USAGE = "usage: node design-diff.js --snapshot <file.json>...\n       node design-diff.js <file.json> [--against <old.json>] [--json] [--out <file>]";
  if (!argv.length || argv.includes("--help")) { console.error(USAGE); process.exit(argv.length ? 0 : 2); }
  if (argv[0] === "--snapshot") {
    const files = argv.slice(1);
    if (!files.length) { console.error(USAGE); process.exit(2); }
    for (const f of files) {
      if (!fs.existsSync(f)) { console.error(`design-diff: ${f} not found — nothing to snapshot (first pull?)`); continue; }
      const dest = snapshotPath(f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      console.log(`snapshot: ${f} -> ${path.relative(process.cwd(), dest)}`);
    }
    return;
  }
  const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const against = take("--against"), out = take("--out");
  const json = argv.includes("--json");
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) { console.error(USAGE); process.exit(2); }
  const prev = previous(file, against);
  if (!prev) {
    console.error(`design-diff: nothing to compare ${file} against — no snapshot in design/.sync/, and it is not committed in git.\nNext time run \`design-diff.js --snapshot ${file}\` BEFORE re-pulling; for now pass --against <an older copy>.`);
    process.exit(2);
  }
  const result = { file, against: prev.source, ...diffDocs(prev.doc, JSON.parse(fs.readFileSync(file, "utf8"))) };
  const text = json ? JSON.stringify(result, null, 2) + "\n" : markdown(result, `${file} vs ${prev.source}`);
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, text); console.log(`wrote ${out} — ${JSON.stringify(result.summary)}`); }
  else process.stdout.write(text);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { diffScreens, diffTokens, diffDocs, markdown, snapshotPath };
