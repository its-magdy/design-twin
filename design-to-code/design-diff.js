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
// Three kinds of file are understood: a screen export ({tree} / {nodes}), the token file ({variables})
// and a component catalog ({components}). Anything else is refused — "Nothing changed" about a file
// this script cannot read would be a lie, not a result.
//
// The baseline is picked, not assumed: of the snapshot and the git HEAD copy, any that is the SAME
// export as the file on disk (equal `exportedAt` — a snapshot taken after the re-pull) is useless and
// dropped, and of the rest the most recent wins (a snapshot left over from an earlier sync must not
// shadow a newer committed export, or changes already applied get listed again).
//
// What is deliberately NOT reported as a change:
//   - `box.x` / `box.y` / `renderBox`: page-space positions. Insert one row and every node below it
//     "moves" — hundreds of changes describing none. Size (`box.w`/`box.h`) IS reported, but only on a
//     node whose own size is fixed; a hug/fill node's size is a consequence of something else in the list.
//   - `exportedAt`, `manifest`, `snapshot`: facts about the export run, not the design.
//   - descendants of an added/removed node: the top-most node stands for its subtree.
//   - sublayers of an instance whose main component was swapped: their ids (`I<instance>;<child>`)
//     are derived from the main component, so every one of them "disappears" and "appears". The swap
//     is the change; the sublayers are counted on it, not listed.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

// Every differing LEAF under a field, as `fills[0].stops[2].color`. Reporting a nested value whole
// meant a one-stop gradient edit printed as two blobs truncated to the same 157 characters — "paint
// changed", with nothing to say what. A value that changes TYPE (object ↔ scalar, array ↔ object) is a leaf.
const MAX_LEAVES = 12;
const isObj = (v) => v !== null && typeof v === "object";
function leaves(before, after, at, out = []) {
  if (same(before, after)) return out;
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) { out.push({ at, before, after }); return out; }
  const keys = Array.isArray(before) ? Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i) : [...new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const k of keys) leaves(before[k], after[k], typeof k === "number" ? `${at}[${k}]` : `${at}.${k}`, out);
  return out;
}
function fieldDiffs(key, before, after, category) {
  const all = leaves(before, after, key);
  const out = all.slice(0, MAX_LEAVES).map((l) => ({ field: l.at, category, before: brief(l.before), after: brief(l.after) }));
  if (all.length > MAX_LEAVES) out.push({ field: key, category, before: undefined, after: `… and ${all.length - MAX_LEAVES} more difference(s) under \`${key}\`` });
  return out;
}

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

const ROOT_IGNORED = new Set(["tree", "nodes", "exportedAt", "manifest", "snapshot", "assets", "screen", "file", "reference"]);
const nameOf = (idx, id) => { const e = idx.get(id); return e ? e.node.name || e.node.type || id : id; };
const describe = (e) => ({ id: String(e.node.id), name: e.node.name, type: e.node.type, path: e.path, parentId: e.parentId });

function nodeFields(before, after) {
  const fields = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key) || same(before[key], after[key])) continue;
    fields.push(...fieldDiffs(key, before[key], after[key], CATEGORY_OF.get(key) || "other"));
  }
  // A fixed-size node's own size is a design decision; a hug/fill node's size only echoes other changes.
  const fixedW = !after.widthMode && !before.widthMode, fixedH = !after.heightMode && !before.heightMode;
  const b = before.box || {}, a = after.box || {};
  if ((fixedW && b.w !== a.w) || (fixedH && b.h !== a.h)) fields.push({ field: "size", category: "layout", before: `${b.w}×${b.h}`, after: `${a.w}×${a.h}` });
  return fields;
}

function diffScreens(oldDoc, newDoc, opts = {}) {
  const redrawn = opts.redrawn || new Set();
  const A = index(oldDoc), B = index(newDoc);
  const added = [], removed = [], changed = [], reordered = [];
  let positionOnly = 0;
  // Instances whose main component was swapped: their sublayer ids are regenerated (see the header).
  const swapped = new Map(); // instance id -> { gone, came }
  for (const [id, b] of B) { const a = A.get(id); if (a && !same(a.node.mainComponent, b.node.mainComponent)) swapped.set(id, { gone: 0, came: 0 }); }
  const underSwap = (idx, e) => { for (let p = e.parentId; p !== null && p !== undefined; p = (idx.get(p) || {}).parentId) if (swapped.has(p)) return swapped.get(p); return null; };
  // Top-most only: a node whose parent is ALSO new/gone is covered by that parent's entry.
  for (const [id, e] of B) if (!A.has(id)) { const sw = underSwap(B, e); if (sw) sw.came++; else if (e.parentId === null || A.has(e.parentId)) added.push(describe(e)); }
  for (const [id, e] of A) if (!B.has(id)) { const sw = underSwap(A, e); if (sw) sw.gone++; else if (e.parentId === null || B.has(e.parentId)) removed.push(describe(e)); }
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const fields = nodeFields(a.node, b.node);
    if (a.parentId !== b.parentId) fields.push({ field: "parent", category: "layout", before: a.path, after: b.path });
    if (typeof b.node.asset === "string" && b.node.asset === a.node.asset && redrawn.has(b.node.asset)) fields.push({ field: "asset bytes", category: "asset", before: "the previous render", after: `re-drawn — ${b.node.asset} has different contents under the same node id` });
    const sw = swapped.get(id);
    if (sw && (sw.gone || sw.came)) fields.push({ field: "sublayers", category: "component", before: `${sw.gone} from the old main component`, after: `${sw.came} from the new one (regenerated by the swap — not listed)` });
    if (fields.length) changed.push({ ...describe(b), categories: [...new Set(fields.map((f) => f.category))], fields });
    else if (!same(a.node.box, b.node.box)) positionOnly++;
    const keptBefore = a.childIds.filter((c) => b.childIds.includes(c)), keptAfter = b.childIds.filter((c) => a.childIds.includes(c));
    if (!same(keptBefore, keptAfter)) reordered.push({ ...describe(b), before: keptBefore.map((c) => nameOf(A, c)), after: keptAfter.map((c) => nameOf(B, c)) });
  }
  // Facts that live beside the tree, not in it: prototype flows, the modes the frame resolves in,
  // dev resources. A new flow changes what has to be built as surely as a new layer does.
  const document = [];
  for (const key of new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)])) {
    if (!ROOT_IGNORED.has(key)) document.push(...fieldDiffs(key, oldDoc[key], newDoc[key], "document"));
  }
  const warnings = [];
  const trunc = newDoc.manifest && newDoc.manifest.truncated;
  if (trunc) warnings.push(`the NEW export is truncated (${trunc === true ? "some" : trunc} subtree(s) past the depth limit) — anything under "Removed" may simply not have been exported. Re-pull a narrower scope before acting on removals.`);
  return { kind: "screen", summary: { added: added.length, removed: removed.length, changed: changed.length + (document.length ? 1 : 0), reordered: reordered.length, positionOnly }, warnings, added, removed, reordered, changed, document };
}

// Tokens are keyed by their Figma KEY — the one thing that identifies a variable. Names are not
// unique: livetest-3's merged variables.json held two `Spacing / Space 4` (24 and 16, distinct keys)
// in the SAME collection, and the old `[collection, name]` key let a Map keep the last of them, so a
// real change to the other was invisible and merely re-ordering the rows reported a false `24 → 16`
// (livetest-3 #211). `[collection, name]` is only the fallback for a row with no key (hand-written
// or very old files), and the human LABEL: a name shared by several variables is labelled with its
// collection and its key, so the report says WHICH one changed.
function diffTokens(oldDoc, newDoc) {
  const idOf = (v) => (typeof v.key === "string" && v.key ? "k:" + v.key : "n:" + JSON.stringify([v.collection || "", v.name]));
  const keyed = (doc) => new Map((doc.variables || []).map((v) => [idOf(v), v]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  // A row that carries a key on one side only (an export from before keys were written) still pairs
  // with its keyless twin when [collection, name] names exactly one variable on each side.
  const byName = (m) => { const o = new Map(); for (const [id, v] of m) { const n = JSON.stringify([v.collection || "", v.name]); o.set(n, o.has(n) ? null : id); } return o; };
  const nA = byName(A), nB = byName(B), pairs = new Map(); // B id -> A id
  for (const [id, v] of B) {
    if (A.has(id)) { pairs.set(id, id); continue; }
    const n = JSON.stringify([v.collection || "", v.name]), aId = nA.get(n);
    if (aId && nB.get(n) === id && !B.has(aId) && (aId.startsWith("n:") || id.startsWith("n:"))) pairs.set(id, aId);
  }
  const pairedA = new Set(pairs.values());
  // Which names need more than the name to say which variable they are.
  const identities = new Map();
  for (const v of [...A.values(), ...B.values()]) {
    if (!identities.has(v.name)) identities.set(v.name, new Map());
    identities.get(v.name).set(idOf(v), v.collection || "");
  }
  const label = (v) => {
    const ids = identities.get(v.name);
    if (!ids || ids.size < 2) return v.name;
    const sameColl = [...ids.values()].filter((c) => c === (v.collection || "")).length > 1;
    return (v.collection ? `${v.collection} / ${v.name}` : v.name) + (sameColl && typeof v.key === "string" && v.key ? ` (key ${v.key.slice(0, 8)}…)` : "");
  };
  const added = [...B].filter(([k]) => !pairs.has(k)).map(([, v]) => label(v));
  const removed = [...A].filter(([k]) => !pairedA.has(k)).map(([, v]) => label(v));
  const changed = [];
  for (const [k, b] of B) {
    const a = pairs.has(k) ? A.get(pairs.get(k)) : null;
    if (!a) continue;
    const modes = [...new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])].filter((m) => !same((a.values || {})[m], (b.values || {})[m]));
    if (modes.length) changed.push({ name: label(b), collection: b.collection, key: b.key, modes: modes.map((m) => ({ mode: m, before: brief((a.values || {})[m]), after: brief((b.values || {})[m]) })) });
  }
  // A new or renamed MODE changes every themed token at once, yet no single variable says so.
  // Collections too are keyed by key where there is one: the same export holds TWO collections called
  // `Spacing`, and a name-keyed Map compared whichever came last on each side.
  const collNames = new Map();
  for (const c of [...(oldDoc.collections || []), ...(newDoc.collections || [])]) collNames.set(c.name, (collNames.get(c.name) || new Set()).add(c.key || c.name));
  const colLabel = (c) => (collNames.get(c.name).size > 1 && c.key ? `${c.name} (key ${String(c.key).slice(0, 8)}…)` : c.name);
  const cols = (doc) => new Map((doc.collections || []).map((c) => [c.key ? "k:" + c.key : "n:" + c.name, { label: colLabel(c), v: { modes: c.modes, default: c.default } }]));
  const CA = cols(oldDoc), CB = cols(newDoc), collections = [];
  for (const id of new Set([...CA.keys(), ...CB.keys()])) collections.push(...fieldDiffs((CB.get(id) || CA.get(id)).label, (CA.get(id) || {}).v, (CB.get(id) || {}).v, "collection"));
  return { kind: "tokens", summary: { added: added.length, removed: removed.length, changed: changed.length + (collections.length ? 1 : 0) }, warnings: [], added, removed, changed, collections };
}

// The component catalog (components.local.json / components.library.json). Keyed by the component
// `key` (what codeconnect.local.json maps), else id. This is where a new "Loading" variant or a
// deleted component shows up — and it ripples to every screen that uses it, not just the one in hand.
function diffCatalog(oldDoc, newDoc) {
  const keyed = (doc) => new Map((doc.components || []).map((c) => [String(c.key || c.id), c]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  const brief1 = (c) => ({ key: c.key, id: c.id, name: c.name, type: c.type });
  const added = [...B].filter(([k]) => !A.has(k)).map(([, c]) => brief1(c)), removed = [...A].filter(([k]) => !B.has(k)).map(([, c]) => brief1(c)), changed = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const fields = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!CATALOG_IGNORED.has(key)) fields.push(...fieldDiffs(key, a[key], b[key], "component"));
    if (fields.length) changed.push({ ...brief1(b), fields });
  }
  return { kind: "catalog", summary: { added: added.length, removed: removed.length, changed: changed.length }, warnings: [], added, removed, changed };
}
const CATALOG_IGNORED = new Set(["page", "pageId", "box", "renderBox"]);

const isTokens = (doc) => Array.isArray(doc && doc.variables);
const isCatalog = (doc) => Array.isArray(doc && doc.components);
const isScreen = (doc) => !!doc && (Array.isArray(doc.nodes) || (doc.tree && typeof doc.tree === "object"));
function diffDocs(oldDoc, newDoc, opts) {
  if (isTokens(newDoc)) return diffTokens(oldDoc, newDoc);
  if (isCatalog(newDoc)) return diffCatalog(oldDoc, newDoc);
  if (isScreen(newDoc)) return diffScreens(oldDoc, newDoc, opts);
  throw new Error("not a screen export, a token file or a component catalog (no `tree`/`nodes`, `variables` or `components` at the top level) — nothing here can be diffed");
}
function markdown(d, label) {
  const s = d.summary, L = [`# What changed — ${label}`, ""];
  for (const w of d.warnings || []) L.push(`> **Warning:** ${w}`, "");
  const total = s.added + s.removed + s.changed + (s.reordered || 0);
  if (!total) return L.concat(d.kind === "screen" && s.positionOnly ? `Nothing changed (${s.positionOnly} node(s) only moved with their surroundings).` : "Nothing changed.").join("\n") + "\n";
  const line = (f) => `  - \`${f.field}\`: ${f.before === undefined ? "—" : f.before} → ${f.after === undefined ? "—" : f.after}`;
  if (d.kind === "tokens") {
    if (d.changed.length) L.push("## Token values changed", ...d.changed.map((c) => `- \`${c.name}\` — ${c.modes.map((m) => `${m.mode}: ${m.before} → ${m.after}`).join("; ")}`), "");
    if (d.collections.length) L.push("## Collections / modes changed", ...d.collections.map(line), "");
    if (d.added.length) L.push("## Tokens added", ...d.added.map((n) => `- \`${n}\``), "");
    if (d.removed.length) L.push("## Tokens removed", ...d.removed.map((n) => `- \`${n}\``), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "catalog") {
    const one = (c) => `- **${c.name}** (${c.type || "component"}, key \`${c.key || c.id}\`)`;
    L.push("_A catalog change affects every built screen that uses the component — check each `design/plan/*.json` `components[]`, not only the screen in hand._", "");
    if (d.changed.length) L.push("## Components changed", ...d.changed.flatMap((c) => [one(c), ...c.fields.map(line)]), "");
    if (d.added.length) L.push("## Components added", ...d.added.map(one), "");
    if (d.removed.length) L.push("## Components removed", ...d.removed.map(one), "");
    return L.join("\n") + "\n";
  }
  if (d.changed.length) L.push("## Changed", ...d.changed.flatMap((c) => [`- **${c.path}** (\`${c.id}\`, ${c.categories.join(" + ")})`, ...c.fields.map(line)]), "");
  if (d.document && d.document.length) L.push("## Beside the tree (flows, modes, dev resources)", ...d.document.map(line), "");
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

// ---- asset bytes. A node's `asset` path is derived from its id, so a re-drawn icon keeps the same
// path and the JSON is identical — only the file on disk differs. The snapshot records a hash per
// asset beside it; against git HEAD the committed blob is hashed instead.
const sha = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
function assetPaths(doc) {
  const out = new Set();
  const walk = (n) => { if (!n || typeof n !== "object") return; if (typeof n.asset === "string") out.add(n.asset); for (const k of Array.isArray(n.children) ? n.children : []) walk(k); };
  for (const r of roots(doc)) walk(r);
  return [...out];
}
// Asset paths are relative to the export root (design/), which may be several directories above a page file.
function assetRoot(file, assets) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) if (assets.some((a) => fs.existsSync(path.join(dir, a)))) return dir;
  return null;
}
function assetHashes(file, doc) {
  const assets = assetPaths(doc), root = assets.length ? assetRoot(file, assets) : null, out = {};
  if (root) for (const a of assets) { try { out[a] = sha(fs.readFileSync(path.join(root, a))); } catch { /* not exported (--no-assets) */ } }
  return { root, hashes: out };
}
function redrawnAssets(file, newDoc, prev, cwd) {
  const now = assetHashes(file, newDoc), out = new Set();
  if (!now.root) return out;
  for (const [a, h] of Object.entries(now.hashes)) {
    let before;
    if (prev.kind === "snapshot") before = (prev.assets || {})[a];
    else if (prev.kind === "git") { try { before = sha(execFileSync("git", ["show", "HEAD:./" + path.relative(cwd, path.join(now.root, a)).split(path.sep).join("/")], { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 })); } catch { /* not committed */ } }
    if (before && before !== h) out.add(a);
  }
  return out;
}

// See the header: drop a baseline that IS the current export, then the most recent one wins.
function previous(file, against, cwd = process.cwd(), current = null) {
  if (against) return { doc: JSON.parse(fs.readFileSync(against, "utf8")), source: against, kind: "file", notes: [] };
  const found = [];
  const snap = snapshotPath(file, cwd);
  if (fs.existsSync(snap)) {
    let assets = null; try { assets = JSON.parse(fs.readFileSync(snap + ".assets.json", "utf8")); } catch { /* older snapshot, or no assets */ }
    found.push({ doc: JSON.parse(fs.readFileSync(snap, "utf8")), source: path.relative(cwd, snap), kind: "snapshot", assets });
  }
  try {
    const rel = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/");
    const text = execFileSync("git", ["show", "HEAD:./" + rel], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    found.push({ doc: JSON.parse(text), source: "git HEAD", kind: "git" });
  } catch { /* not a repo, or not committed */ }
  if (!found.length) return null;
  const at = (d) => (d && typeof d.exportedAt === "string" ? d.exportedAt : null);
  const now = at(current), notes = [];
  const useful = found.filter((c) => !(now && at(c.doc) === now));
  for (const c of found) if (!useful.includes(c)) notes.push(`${c.source} is the SAME export as ${file} (exportedAt ${now}) — ${c.kind === "snapshot" ? "the snapshot was taken after the re-pull" : "the new export is already committed"}, so it was not used as the baseline.`);
  if (!useful.length) return { ...found[0], notes: [...notes, `There is no OLDER export to compare against, so this says nothing about what the designer changed. Pass --against <an older copy>.`], same: true };
  useful.sort((x, y) => String(at(y.doc) || "").localeCompare(String(at(x.doc) || "")));
  if (useful.length > 1 && at(useful[0].doc) !== at(useful[1].doc)) notes.push(`${useful[1].source} is older than ${useful[0].source} — used the newer one, so changes already applied are not listed again.`);
  return { ...useful[0], notes };
}

function main(argv) {
  const USAGE = "usage: node design-diff.js --snapshot <file.json>...\n       node design-diff.js <file.json> [--against <old.json>] [--json] [--out <file>]";
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.error(USAGE); process.exit(argv.length ? 0 : 2); }
  const KNOWN = ["--snapshot", "--against", "--out", "--json", "--help"];
  const unknown = argv.filter((a) => a.startsWith("-") && !KNOWN.includes(a));
  if (unknown.length) { console.error(`design-diff: unknown flag ${unknown.join(", ")} (known: ${KNOWN.join(" ")})\n${USAGE}`); process.exit(2); }
  if (argv[0] === "--snapshot") {
    const files = argv.slice(1);
    if (!files.length) { console.error(USAGE); process.exit(2); }
    for (const f of files) {
      if (!fs.existsSync(f)) { console.error(`design-diff: ${f} not found — nothing to snapshot (first pull?)`); continue; }
      const dest = snapshotPath(f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      let n = 0;
      try { const h = assetHashes(f, JSON.parse(fs.readFileSync(f, "utf8"))).hashes; n = Object.keys(h).length; fs.writeFileSync(dest + ".assets.json", JSON.stringify(h, null, 2) + "\n"); } catch { /* not JSON we understand — the copy is still the snapshot */ }
      console.log(`snapshot: ${f} -> ${path.relative(process.cwd(), dest)}${n ? ` (+ ${n} asset hash(es))` : ""}`);
    }
    return;
  }
  const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const against = take("--against"), out = take("--out");
  const json = argv.includes("--json");
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) { console.error(USAGE); process.exit(2); }
  const { readJsonFile } = require("./catalog-input.js");
  const current = readJsonFile(file, "export");
  const prev = previous(file, against, process.cwd(), current);
  if (!prev) {
    console.error(`design-diff: nothing to compare ${file} against — no snapshot in design/.sync/, and it is not committed in git.\nNext time run \`design-diff.js --snapshot ${file}\` BEFORE re-pulling; for now pass --against <an older copy>.`);
    process.exit(2);
  }
  let diff;
  try { diff = diffDocs(prev.doc, current, { redrawn: isScreen(current) ? redrawnAssets(file, current, prev, process.cwd()) : new Set() }); }
  catch (e) { console.error(`design-diff: ${file}: ${e.message}`); process.exit(2); }
  diff.warnings = [...prev.notes, ...(diff.warnings || [])];
  const result = { file, against: prev.source, ...diff };
  const text = json ? JSON.stringify(result, null, 2) + "\n" : markdown(result, `${file} vs ${prev.source}`);
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, text); console.log(`wrote ${out} — ${JSON.stringify(result.summary)}${result.warnings.length ? ` — ${result.warnings.length} warning(s), read them` : ""}`); }
  else process.stdout.write(text);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { diffScreens, diffTokens, diffCatalog, diffDocs, markdown, snapshotPath, previous };
