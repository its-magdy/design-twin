#!/usr/bin/env node
// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.

// design-to-code/design-diff.js
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { execFileSync } = require("child_process");
var CATEGORY = {
  text: ["text", "runs", "truncate", "maxLines", "autoResize"],
  typography: ["font", "textTokens", "missingFont"],
  paint: ["fills", "strokes", "effects", "opacity", "blendMode", "mask", "maskType"],
  layout: [
    "layout",
    "widthMode",
    "heightMode",
    "sizeLimits",
    "aspectRatio",
    "grow",
    "alignSelf",
    "absolute",
    "pin",
    "clip",
    "fixedChildren",
    "strokesInLayout",
    "layoutGrids",
    "gridColumnSpan",
    "gridRowSpan",
    "gridColumnStart",
    "gridRowStart",
    "gridJustifySelf",
    "gridAlignSelf",
    "size"
  ],
  shape: ["radius", "cornerSmoothing", "rotation", "flipped", "skew", "arc", "shape", "booleanOp"],
  tokens: ["tokens", "styles", "variableModes", "propTokens"],
  component: ["component", "mainComponent", "props", "propRefs", "overrides", "exposedInstances", "detachedFrom", "tableCells"],
  visibility: ["hidden"],
  asset: ["asset", "geometry", "assetSkipped", "exportSettings"],
  interaction: ["reactions", "overlay", "motion"],
  handoff: ["annotations", "devStatus", "devStatusNote", "name", "type"]
};
var CATEGORY_OF = new Map(Object.entries(CATEGORY).flatMap(([cat, fields]) => fields.map((f) => [f, cat])));
var IGNORED = /* @__PURE__ */ new Set(["children", "box", "renderBox", "id", "css", "measurements", "pluginData", "sharedData"]);
var roots = (doc) => Array.isArray(doc.nodes) ? doc.nodes : doc.tree && typeof doc.tree === "object" ? [doc.tree] : [];
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var brief = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === void 0 ? void 0 : s.length > 160 ? s.slice(0, 157) + "\u2026" : s;
};
var MAX_LEAVES = 12;
var isObj = (v) => v !== null && typeof v === "object";
function leaves(before, after, at, out = []) {
  if (same(before, after)) return out;
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) {
    out.push({ at, before, after });
    return out;
  }
  const keys = Array.isArray(before) ? Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i) : [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const k of keys) leaves(before[k], after[k], typeof k === "number" ? `${at}[${k}]` : `${at}.${k}`, out);
  return out;
}
function fieldDiffs(key, before, after, category) {
  const all = leaves(before, after, key);
  const out = all.slice(0, MAX_LEAVES).map((l) => ({ field: l.at, category, before: brief(l.before), after: brief(l.after) }));
  if (all.length > MAX_LEAVES) out.push({ field: key, category, before: void 0, after: `\u2026 and ${all.length - MAX_LEAVES} more difference(s) under \`${key}\`` });
  return out;
}
function index(doc) {
  const out = /* @__PURE__ */ new Map();
  const walk = (node, parentId, trail) => {
    if (!node || typeof node !== "object" || node.id === void 0) return;
    const here = [...trail, node.name || node.type || node.id];
    const kids = Array.isArray(node.children) ? node.children : [];
    out.set(String(node.id), { node, parentId, path: here.join(" > "), childIds: kids.map((k) => String(k && k.id)) });
    for (const k of kids) walk(k, String(node.id), here);
  };
  for (const r of roots(doc)) walk(r, null, []);
  return out;
}
var ROOT_IGNORED = /* @__PURE__ */ new Set(["tree", "nodes", "exportedAt", "manifest", "snapshot", "assets", "screen", "file", "reference"]);
var nameOf = (idx, id) => {
  const e = idx.get(id);
  return e ? e.node.name || e.node.type || id : id;
};
var describe = (e) => ({ id: String(e.node.id), name: e.node.name, type: e.node.type, path: e.path, parentId: e.parentId });
function nodeFields(before, after) {
  const fields = [];
  for (const key of /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key) || same(before[key], after[key])) continue;
    fields.push(...fieldDiffs(key, before[key], after[key], CATEGORY_OF.get(key) || "other"));
  }
  const fixedW = !after.widthMode && !before.widthMode, fixedH = !after.heightMode && !before.heightMode;
  const b = before.box || {}, a = after.box || {};
  if (fixedW && b.w !== a.w || fixedH && b.h !== a.h) fields.push({ field: "size", category: "layout", before: `${b.w}\xD7${b.h}`, after: `${a.w}\xD7${a.h}` });
  return fields;
}
function diffScreens(oldDoc, newDoc, opts = {}) {
  const redrawn = opts.redrawn || /* @__PURE__ */ new Set();
  const A = index(oldDoc), B = index(newDoc);
  const added = [], removed = [], changed = [], reordered = [];
  let positionOnly = 0;
  const swapped = /* @__PURE__ */ new Map();
  for (const [id, b] of B) {
    const a = A.get(id);
    if (a && !same(a.node.mainComponent, b.node.mainComponent)) swapped.set(id, { gone: 0, came: 0 });
  }
  const underSwap = (idx, e) => {
    for (let p = e.parentId; p !== null && p !== void 0; p = (idx.get(p) || {}).parentId) if (swapped.has(p)) return swapped.get(p);
    return null;
  };
  for (const [id, e] of B) if (!A.has(id)) {
    const sw = underSwap(B, e);
    if (sw) sw.came++;
    else if (e.parentId === null || A.has(e.parentId)) added.push(describe(e));
  }
  for (const [id, e] of A) if (!B.has(id)) {
    const sw = underSwap(A, e);
    if (sw) sw.gone++;
    else if (e.parentId === null || B.has(e.parentId)) removed.push(describe(e));
  }
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const fields = nodeFields(a.node, b.node);
    if (a.parentId !== b.parentId) fields.push({ field: "parent", category: "layout", before: a.path, after: b.path });
    if (typeof b.node.asset === "string" && b.node.asset === a.node.asset && redrawn.has(b.node.asset)) fields.push({ field: "asset bytes", category: "asset", before: "the previous render", after: `re-drawn \u2014 ${b.node.asset} has different contents under the same node id` });
    const sw = swapped.get(id);
    if (sw && (sw.gone || sw.came)) fields.push({ field: "sublayers", category: "component", before: `${sw.gone} from the old main component`, after: `${sw.came} from the new one (regenerated by the swap \u2014 not listed)` });
    if (fields.length) changed.push({ ...describe(b), categories: [...new Set(fields.map((f) => f.category))], fields });
    else if (!same(a.node.box, b.node.box)) positionOnly++;
    const keptBefore = a.childIds.filter((c) => b.childIds.includes(c)), keptAfter = b.childIds.filter((c) => a.childIds.includes(c));
    if (!same(keptBefore, keptAfter)) reordered.push({ ...describe(b), before: keptBefore.map((c) => nameOf(A, c)), after: keptAfter.map((c) => nameOf(B, c)) });
  }
  const document = [];
  for (const key of /* @__PURE__ */ new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)])) {
    if (!ROOT_IGNORED.has(key)) document.push(...fieldDiffs(key, oldDoc[key], newDoc[key], "document"));
  }
  const warnings = [];
  const trunc = newDoc.manifest && newDoc.manifest.truncated;
  if (trunc) warnings.push(`the NEW export is truncated (${trunc === true ? "some" : trunc} subtree(s) past the depth limit) \u2014 anything under "Removed" may simply not have been exported. Re-pull a narrower scope before acting on removals.`);
  return { kind: "screen", summary: { added: added.length, removed: removed.length, changed: changed.length + (document.length ? 1 : 0), reordered: reordered.length, positionOnly }, warnings, added, removed, reordered, changed, document };
}
function diffTokens(oldDoc, newDoc) {
  const keyed = (doc) => new Map((doc.variables || []).map((v) => [JSON.stringify([v.collection || "", v.name]), v]));
  const label = (v, clash2) => clash2.has(v.name) && v.collection ? `${v.collection} / ${v.name}` : v.name;
  const A = keyed(oldDoc), B = keyed(newDoc);
  const counts = /* @__PURE__ */ new Map();
  for (const v of [...A.values(), ...B.values()]) counts.set(v.name, (counts.get(v.name) || /* @__PURE__ */ new Set()).add(v.collection || ""));
  const clash = new Set([...counts].filter(([, c]) => c.size > 1).map(([n]) => n));
  const added = [...B].filter(([k]) => !A.has(k)).map(([, v]) => label(v, clash)), removed = [...A].filter(([k]) => !B.has(k)).map(([, v]) => label(v, clash)), changed = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const modes = [.../* @__PURE__ */ new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])].filter((m) => !same((a.values || {})[m], (b.values || {})[m]));
    if (modes.length) changed.push({ name: label(b, clash), collection: b.collection, modes: modes.map((m) => ({ mode: m, before: brief((a.values || {})[m]), after: brief((b.values || {})[m]) })) });
  }
  const cols = (doc) => new Map((doc.collections || []).map((c) => [c.name, { modes: c.modes, default: c.default }]));
  const CA = cols(oldDoc), CB = cols(newDoc), collections = [];
  for (const name of /* @__PURE__ */ new Set([...CA.keys(), ...CB.keys()])) collections.push(...fieldDiffs(name, CA.get(name), CB.get(name), "collection"));
  return { kind: "tokens", summary: { added: added.length, removed: removed.length, changed: changed.length + (collections.length ? 1 : 0) }, warnings: [], added, removed, changed, collections };
}
function diffCatalog(oldDoc, newDoc) {
  const keyed = (doc) => new Map((doc.components || []).map((c) => [String(c.key || c.id), c]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  const brief1 = (c) => ({ key: c.key, id: c.id, name: c.name, type: c.type });
  const added = [...B].filter(([k]) => !A.has(k)).map(([, c]) => brief1(c)), removed = [...A].filter(([k]) => !B.has(k)).map(([, c]) => brief1(c)), changed = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const fields = [];
    for (const key of /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])) if (!CATALOG_IGNORED.has(key)) fields.push(...fieldDiffs(key, a[key], b[key], "component"));
    if (fields.length) changed.push({ ...brief1(b), fields });
  }
  return { kind: "catalog", summary: { added: added.length, removed: removed.length, changed: changed.length }, warnings: [], added, removed, changed };
}
var CATALOG_IGNORED = /* @__PURE__ */ new Set(["page", "pageId", "box", "renderBox"]);
var isTokens = (doc) => Array.isArray(doc && doc.variables);
var isCatalog = (doc) => Array.isArray(doc && doc.components);
var isScreen = (doc) => !!doc && (Array.isArray(doc.nodes) || doc.tree && typeof doc.tree === "object");
function diffDocs(oldDoc, newDoc, opts) {
  if (isTokens(newDoc)) return diffTokens(oldDoc, newDoc);
  if (isCatalog(newDoc)) return diffCatalog(oldDoc, newDoc);
  if (isScreen(newDoc)) return diffScreens(oldDoc, newDoc, opts);
  throw new Error("not a screen export, a token file or a component catalog (no `tree`/`nodes`, `variables` or `components` at the top level) \u2014 nothing here can be diffed");
}
function markdown(d, label) {
  const s = d.summary, L = [`# What changed \u2014 ${label}`, ""];
  for (const w of d.warnings || []) L.push(`> **Warning:** ${w}`, "");
  const total = s.added + s.removed + s.changed + (s.reordered || 0);
  if (!total) return L.concat(d.kind === "screen" && s.positionOnly ? `Nothing changed (${s.positionOnly} node(s) only moved with their surroundings).` : "Nothing changed.").join("\n") + "\n";
  const line = (f) => `  - \`${f.field}\`: ${f.before === void 0 ? "\u2014" : f.before} \u2192 ${f.after === void 0 ? "\u2014" : f.after}`;
  if (d.kind === "tokens") {
    if (d.changed.length) L.push("## Token values changed", ...d.changed.map((c) => `- \`${c.name}\` \u2014 ${c.modes.map((m) => `${m.mode}: ${m.before} \u2192 ${m.after}`).join("; ")}`), "");
    if (d.collections.length) L.push("## Collections / modes changed", ...d.collections.map(line), "");
    if (d.added.length) L.push("## Tokens added", ...d.added.map((n) => `- \`${n}\``), "");
    if (d.removed.length) L.push("## Tokens removed", ...d.removed.map((n) => `- \`${n}\``), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "catalog") {
    const one = (c) => `- **${c.name}** (${c.type || "component"}, key \`${c.key || c.id}\`)`;
    L.push("_A catalog change affects every built screen that uses the component \u2014 check each `design/plan/*.json` `components[]`, not only the screen in hand._", "");
    if (d.changed.length) L.push("## Components changed", ...d.changed.flatMap((c) => [one(c), ...c.fields.map(line)]), "");
    if (d.added.length) L.push("## Components added", ...d.added.map(one), "");
    if (d.removed.length) L.push("## Components removed", ...d.removed.map(one), "");
    return L.join("\n") + "\n";
  }
  if (d.changed.length) L.push("## Changed", ...d.changed.flatMap((c) => [`- **${c.path}** (\`${c.id}\`, ${c.categories.join(" + ")})`, ...c.fields.map(line)]), "");
  if (d.document && d.document.length) L.push("## Beside the tree (flows, modes, dev resources)", ...d.document.map(line), "");
  if (d.added.length) L.push("## Added (each stands for its whole subtree)", ...d.added.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.removed.length) L.push("## Removed (each stands for its whole subtree)", ...d.removed.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.reordered.length) L.push("## Reordered children", ...d.reordered.map((r) => `- **${r.path}**: ${r.before.join(", ")} \u2192 ${r.after.join(", ")}`), "");
  if (s.positionOnly) L.push(`_${s.positionOnly} other node(s) only moved with their surroundings \u2014 not listed._`, "");
  return L.join("\n") + "\n";
}
function snapshotPath(file, cwd = process.cwd()) {
  const rel = path.relative(path.join(cwd, "design"), path.resolve(cwd, file));
  const flat = (rel.startsWith("..") ? path.basename(file) : rel).split(path.sep).join("__");
  return path.join(cwd, "design", ".sync", flat);
}
var sha = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
function assetPaths(doc) {
  const out = /* @__PURE__ */ new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.asset === "string") out.add(n.asset);
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k);
  };
  for (const r of roots(doc)) walk(r);
  return [...out];
}
function assetRoot(file, assets) {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) if (assets.some((a) => fs.existsSync(path.join(dir, a)))) return dir;
  return null;
}
function assetHashes(file, doc) {
  const assets = assetPaths(doc), root = assets.length ? assetRoot(file, assets) : null, out = {};
  if (root) for (const a of assets) {
    try {
      out[a] = sha(fs.readFileSync(path.join(root, a)));
    } catch {
    }
  }
  return { root, hashes: out };
}
function redrawnAssets(file, newDoc, prev, cwd) {
  const now = assetHashes(file, newDoc), out = /* @__PURE__ */ new Set();
  if (!now.root) return out;
  for (const [a, h] of Object.entries(now.hashes)) {
    let before;
    if (prev.kind === "snapshot") before = (prev.assets || {})[a];
    else if (prev.kind === "git") {
      try {
        before = sha(execFileSync("git", ["show", "HEAD:./" + path.relative(cwd, path.join(now.root, a)).split(path.sep).join("/")], { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }));
      } catch {
      }
    }
    if (before && before !== h) out.add(a);
  }
  return out;
}
function previous(file, against, cwd = process.cwd(), current = null) {
  if (against) return { doc: JSON.parse(fs.readFileSync(against, "utf8")), source: against, kind: "file", notes: [] };
  const found = [];
  const snap = snapshotPath(file, cwd);
  if (fs.existsSync(snap)) {
    let assets = null;
    try {
      assets = JSON.parse(fs.readFileSync(snap + ".assets.json", "utf8"));
    } catch {
    }
    found.push({ doc: JSON.parse(fs.readFileSync(snap, "utf8")), source: path.relative(cwd, snap), kind: "snapshot", assets });
  }
  try {
    const rel = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/");
    const text = execFileSync("git", ["show", "HEAD:./" + rel], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    found.push({ doc: JSON.parse(text), source: "git HEAD", kind: "git" });
  } catch {
  }
  if (!found.length) return null;
  const at = (d) => d && typeof d.exportedAt === "string" ? d.exportedAt : null;
  const now = at(current), notes = [];
  const useful = found.filter((c) => !(now && at(c.doc) === now));
  for (const c of found) if (!useful.includes(c)) notes.push(`${c.source} is the SAME export as ${file} (exportedAt ${now}) \u2014 ${c.kind === "snapshot" ? "the snapshot was taken after the re-pull" : "the new export is already committed"}, so it was not used as the baseline.`);
  if (!useful.length) return { ...found[0], notes: [...notes, `There is no OLDER export to compare against, so this says nothing about what the designer changed. Pass --against <an older copy>.`], same: true };
  useful.sort((x, y) => String(at(y.doc) || "").localeCompare(String(at(x.doc) || "")));
  if (useful.length > 1 && at(useful[0].doc) !== at(useful[1].doc)) notes.push(`${useful[1].source} is older than ${useful[0].source} \u2014 used the newer one, so changes already applied are not listed again.`);
  return { ...useful[0], notes };
}
function main(argv) {
  const USAGE = "usage: node design-diff.js --snapshot <file.json>...\n       node design-diff.js <file.json> [--against <old.json>] [--json] [--out <file>]";
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE);
    process.exit(argv.length ? 0 : 2);
  }
  const KNOWN = ["--snapshot", "--against", "--out", "--json", "--help"];
  const unknown = argv.filter((a) => a.startsWith("-") && !KNOWN.includes(a));
  if (unknown.length) {
    console.error(`design-diff: unknown flag ${unknown.join(", ")} (known: ${KNOWN.join(" ")})
${USAGE}`);
    process.exit(2);
  }
  if (argv[0] === "--snapshot") {
    const files = argv.slice(1);
    if (!files.length) {
      console.error(USAGE);
      process.exit(2);
    }
    for (const f of files) {
      if (!fs.existsSync(f)) {
        console.error(`design-diff: ${f} not found \u2014 nothing to snapshot (first pull?)`);
        continue;
      }
      const dest = snapshotPath(f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      let n = 0;
      try {
        const h = assetHashes(f, JSON.parse(fs.readFileSync(f, "utf8"))).hashes;
        n = Object.keys(h).length;
        fs.writeFileSync(dest + ".assets.json", JSON.stringify(h, null, 2) + "\n");
      } catch {
      }
      console.log(`snapshot: ${f} -> ${path.relative(process.cwd(), dest)}${n ? ` (+ ${n} asset hash(es))` : ""}`);
    }
    return;
  }
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return void 0;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const against = take("--against"), out = take("--out");
  const json = argv.includes("--json");
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error(USAGE);
    process.exit(2);
  }
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  const prev = previous(file, against, process.cwd(), current);
  if (!prev) {
    console.error(`design-diff: nothing to compare ${file} against \u2014 no snapshot in design/.sync/, and it is not committed in git.
Next time run \`design-diff.js --snapshot ${file}\` BEFORE re-pulling; for now pass --against <an older copy>.`);
    process.exit(2);
  }
  let diff;
  try {
    diff = diffDocs(prev.doc, current, { redrawn: isScreen(current) ? redrawnAssets(file, current, prev, process.cwd()) : /* @__PURE__ */ new Set() });
  } catch (e) {
    console.error(`design-diff: ${file}: ${e.message}`);
    process.exit(2);
  }
  diff.warnings = [...prev.notes, ...diff.warnings || []];
  const result = { file, against: prev.source, ...diff };
  const text = json ? JSON.stringify(result, null, 2) + "\n" : markdown(result, `${file} vs ${prev.source}`);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    console.log(`wrote ${out} \u2014 ${JSON.stringify(result.summary)}${result.warnings.length ? ` \u2014 ${result.warnings.length} warning(s), read them` : ""}`);
  } else process.stdout.write(text);
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { diffScreens, diffTokens, diffCatalog, diffDocs, markdown, snapshotPath, previous };
