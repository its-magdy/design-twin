#!/usr/bin/env -S bun --no-install --no-env-file
// design-diff.ts — what CHANGED between two exports of the same screen (or the same token file).
//
// A re-pull overwrites the export in place, and "the designer changed the header" then has no answer
// except rebuilding the screen — which discards every hand edit made since the first build. This is
// the deterministic half of the alternative: keep the previous export, diff the two by node id, and
// hand the agent a short list of what actually moved so it can patch only that. Usage: --help.
//
// Nodes are matched by `id` — stable across exports of one Figma file; a name is not (renaming a layer
// must read as "renamed", not "deleted + added"). Exit 0 = compared (changes or not), 2 = usage /
// nothing to compare against.
//
// Given an export DIRECTORY instead of a file, it diffs the merged variables.json and every
// design-system file present there (the set bridge/src/design-system-layout.ts defines) into one
// report, and `--snapshot <dir>` snapshots that same set — so a caller names the export, not ten files.
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
//   - the exporter's FORMAT noise (`formatNoise` below): an export from an older plugin carried
//     `gridColumnStart/RowStart: -1` on every node (and `gridAlignSelf/gridJustifySelf` off a grid),
//     `layout: {mode:"absolute"}` on every text/shape/other leaf and a `layout` on asset leaves, so
//     re-pulling an unchanged screen would otherwise list EVERY node as changed. Both sides are
//     normalised before comparing; a node whose only differences were that noise, present on ONE side
//     only, is counted as `formatOnly`, not listed. Permanent: old snapshots live in git for months.
//   - sublayers of an instance whose main component was swapped: their ids (`I<instance>;<child>`)
//     are derived from the main component, so every one of them "disappears" and "appears". The swap
//     is the change; the sublayers are counted on it, not listed.
import { hasExportIndex, pagesRootOfScreen, rootIndexFile, screenSiblingFile } from "./export-index.ts";
import fs from "node:fs";
import path from "node:path";
import type {
  AnyStyle, Box, CatalogBrief, CatalogComponent, CatalogDiff, ComponentsCatalog, DesignSystemManifest, DiffCategory, DiffNodeRef, DiffReport, DiffResult,
  DirDiffResult, FieldDiff, HygieneDiff, HygieneDoc, IrNode, ManifestDiff, ScreenDiff, ScreenDoc, StyleBrief, StylesDiff, StylesDoc, TokensDiff, TokensDoc,
  Variable, VariableCollection,
} from "./types.ts";
import { bag, isJsonObject } from "./types.ts";
import { isLayerFile, isScreenExport, manifestOf, screenRoots } from "./export-shape.ts";
import { readJsonFile } from "./catalog-input.ts";
import { walkWithHidden } from "./visible-tree.ts";
import { isComponentsCatalog, isStringRecord, isTokensDoc } from "./doc-guards.ts";
import type { DocGuard } from "./doc-guards.ts";
import { anyJson, readJson, readJsonOrNull } from "./read-json.ts";
import { ifDefined, isStringArray } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { normalizeForCompare, sha1Hex } from "../bridge/src/asset-compare.ts";
import { isSvgName } from "../bridge/src/svg-normalize.ts";
import { DESIGN_SYSTEM_DIR, DESIGN_SYSTEM_FILE_NAMES, DESIGN_SYSTEM_FILES } from "../bridge/src/design-system-layout.ts";
import { DESIGN_DIR, EXPORT_DIR, MERGED_VARIABLES_FILE, SNAPSHOT_DIR, looksLikeExportDir } from "../bridge/src/project-layout.ts";
import { LIBRARY_FILE_NAMES, ROOT as LIBRARIES_DIR } from "../bridge/src/library-layout.ts";
import { runCli, runSync } from "./proc.ts";

// The generic key loops below compare WHATEVER a document or node carries, named field or not; they
// read through types.ts `bag()` (the interfaces there name SOME keys and have no string index).

const CATEGORY: Partial<Record<DiffCategory, string[]>> = {
  text: ["text", "runs", "truncate", "maxLines", "autoResize"],
  typography: ["font", "textTokens", "missingFont", "textStyleOverrides"], // overrides sit over the text STYLE the font came from
  paint: ["fills", "strokes", "effects", "opacity", "blendMode", "mask", "maskType"],
  layout: ["layout", "widthMode", "heightMode", "sizeLimits", "aspectRatio", "grow", "alignSelf", "absolute", "pin", "clip", "fixedChildren", "strokesInLayout", "layoutGrids",
    "gridColumnSpan", "gridRowSpan", "gridColumnStart", "gridRowStart", "gridJustifySelf", "gridAlignSelf", "size", "scroll"],
  shape: ["radius", "cornerSmoothing", "rotation", "flipped", "skew", "sourceTransform", "arc", "shape", "booleanOp"],
  tokens: ["tokens", "styles", "variableModes", "propTokens"],
  component: ["component", "mainComponent", "props", "propRefs", "overrides", "exposedInstances", "detachedFrom", "tableCells"],
  visibility: ["hidden"],
  asset: ["asset", "assetFrom", "geometry", "assetSkipped", "exportSettings"],
  interaction: ["reactions", "overlay", "motion"],
  handoff: ["annotations", "devStatus", "devStatusNote", "name", "type"],
};
// Object.keys widens CATEGORY's keys to string; the guard narrows them back (each IS a key of CATEGORY).
const isDiffCategory = (k: string): k is DiffCategory => Object.hasOwn(CATEGORY, k);
const CATEGORY_OF = new Map<string, DiffCategory>();
for (const cat of Object.keys(CATEGORY)) if (isDiffCategory(cat)) for (const f of CATEGORY[cat] || []) CATEGORY_OF.set(f, cat);
const IGNORED = new Set(["children", "box", "renderBox", "id", "css", "measurements", "pluginData", "sharedData"]);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const brief = (v: unknown): string | undefined => { const s = typeof v === "string" ? v : JSON.stringify(v); return s === undefined ? undefined : s.length > 160 ? s.slice(0, 157) + "…" : s; };

// Every differing LEAF under a field, as `fills[0].stops[2].color`. Reporting a nested value whole
// meant a one-stop gradient edit printed as two blobs truncated to the same 157 characters — "paint
// changed", with nothing to say what. A value that changes TYPE (object ↔ scalar, array ↔ object) is a leaf.
const MAX_LEAVES = 12;
interface Leaf { at: string; before: unknown; after: unknown }
const isObj = (v: unknown): v is object => v !== null && typeof v === "object";
function leaves(before: unknown, after: unknown, at: string, out: Leaf[] = []): Leaf[] {
  if (same(before, after)) return out;
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) { out.push({ at, before, after }); return out; }
  // Past the guard above both sides are arrays or neither is.
  const keys: Array<string | number> = Array.isArray(before) && Array.isArray(after) ? Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i) : [...new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const k of keys) leaves(bag(before)[k], bag(after)[k], typeof k === "number" ? `${at}[${k}]` : `${at}.${k}`, out);
  return out;
}
function fieldDiffs(key: string, before: unknown, after: unknown, category: DiffCategory): FieldDiff[] {
  const all = leaves(before, after, key);
  const out: FieldDiff[] = all.slice(0, MAX_LEAVES).map((l) => ({ field: l.at, category, before: brief(l.before), after: brief(l.after) }));
  if (all.length > MAX_LEAVES) out.push({ field: key, category, before: undefined, after: `… and ${all.length - MAX_LEAVES} more difference(s) under \`${key}\`` });
  return out;
}

// id -> { node, parentId, path, childIds }
// `parent`: the parent NODE (null on a root) — the format normaliser decides grid-child noise by it.
interface IndexEntry { node: IrNode; parent: IrNode | null; parentId: string | null; path: string; childIds: string[] }
function index(doc: ScreenDoc): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  const walk = (node: IrNode, parent: IrNode | null, trail: string[]): void => {
    if (!node || typeof node !== "object" || node.id === undefined) return;
    const here = [...trail, node.name || node.type || node.id];
    const kids = Array.isArray(node.children) ? node.children : [];
    out.set(String(node.id), { node, parent, parentId: parent ? String(parent.id) : null, path: here.join(" > "), childIds: kids.map((k) => String(k && k.id)) });
    for (const k of kids) walk(k, node, here);
  };
  for (const r of screenRoots(doc)) walk(r, null, []);
  return out;
}

const ROOT_IGNORED = new Set(["tree", "nodes", "exportedAt", "manifest", "snapshot", "assets", "screen", "file", "reference"]);
const nameOf = (idx: Map<string, IndexEntry>, id: string): string => { const e = idx.get(id); return e ? e.node.name || e.node.type || id : id; };
const describe = (e: IndexEntry): DiffNodeRef => ({ id: String(e.node.id), name: e.node.name, type: e.node.type, path: e.path, parentId: e.parentId });

// The node types that hold children (Figma's ChildrenMixin) — `layout` describes how a node lays out ITS
// OWN children, so a newer plugin writes it only on these. An ALLOW-list: every other type (text, shapes,
// vectors, SLICE, STICKY, any type added later) counts as a leaf, so its `{mode:"absolute"}` is noise.
const CONTAINERS = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "BOOLEAN_OPERATION", "SECTION", "TRANSFORM_GROUP",
  "SLOT", "SLIDE", "SLIDE_ROW", "SLIDE_GRID", "PAGE"]);
const GRID_CHILD_KEYS = ["gridColumnStart", "gridRowStart", "gridColumnSpan", "gridRowSpan", "gridJustifySelf", "gridAlignSelf"] as const;
const ABSOLUTE_ONLY = new Set(["mode", "width", "height"]);
// What an older plugin wrote and a newer one does not, decided exactly as the plugin decides it:
//   - the six grid-child keys on a node that is NOT an in-flow child of a grid: a root (its parent is not
//     exported), an `absolute` child, or a child of a parent whose layout is not `display:"grid"` (the old
//     plugin wrote anchors -1 on every node and `gridAlignSelf/gridJustifySelf:"start"` off a grid). On an
//     in-flow grid child only an anchor of -1 (not a track index) is noise; a real anchor/span/self-align compares.
//   - `layout` that is the bare `{mode:"absolute",width,height}` record on a type that is not a container,
//     and any `layout` on an asset/geometry/assetSkipped leaf (the inset is baked into the picture). A node
//     that HAS children keeps its layout whatever its type. Everything else compares.
// Returns `n` itself when there is nothing to strip, else a shallow copy.
function formatNoise(n: IrNode, parent: IrNode | null): IrNode {
  const lay = n.layout, isAssetLeaf = n.asset !== undefined || n.geometry !== undefined || n.assetSkipped !== undefined;
  const gridItem = !!parent && !n.absolute && parent.layout?.display === "grid";
  const dropGrid = GRID_CHILD_KEYS.filter((k) => n[k] !== undefined && (!gridItem || ((k === "gridColumnStart" || k === "gridRowStart") && n[k] === -1)));
  const dropLayout = !!lay && !n.children && (isAssetLeaf || (!CONTAINERS.has(n.type) && lay.mode === "absolute" && Object.keys(lay).every((k) => ABSOLUTE_ONLY.has(k))));
  if (!dropGrid.length && !dropLayout) return n;
  const out: IrNode = { ...n };
  for (const k of dropGrid) delete out[k];
  if (dropLayout) delete out.layout;
  return out;
}
const hasNoise = (e: IndexEntry): boolean => formatNoise(e.node, e.parent) !== e.node;

function nodeFields(old: IndexEntry, neu: IndexEntry, raw = false): FieldDiff[] {
  const before = raw ? old.node : formatNoise(old.node, old.parent), after = raw ? neu.node : formatNoise(neu.node, neu.parent);
  const fields: FieldDiff[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key) || same(bag(before)[key], bag(after)[key])) continue;
    fields.push(...fieldDiffs(key, bag(before)[key], bag(after)[key], CATEGORY_OF.get(key) || "other"));
  }
  // A fixed-size node's own size is a design decision; a hug/fill node's size only echoes other changes.
  const fixedW = !after.widthMode && !before.widthMode, fixedH = !after.heightMode && !before.heightMode;
  const b: Partial<Box> = before.box || {}, a: Partial<Box> = after.box || {};
  if ((fixedW && b.w !== a.w) || (fixedH && b.h !== a.h)) fields.push({ field: "size", category: "layout", before: `${b.w}×${b.h}`, after: `${a.w}×${a.h}` });
  return fields;
}

interface SwapCount { gone: number; came: number }
// Older export spelling, still read: the producer (run.ts) writes `truncated` as a count; an older
// export wrote `true`, and the message below still spells that case out.
interface LegacyManifest { truncated?: number | boolean }
const truncatedOf = (m: LegacyManifest | undefined): number | boolean | undefined => m && m.truncated;
function diffScreens(oldDoc: ScreenDoc, newDoc: ScreenDoc, opts: { redrawn?: Set<string> } = {}): ScreenDiff {
  const redrawn = opts.redrawn || new Set<string>();
  const A = index(oldDoc), B = index(newDoc);
  const added: DiffNodeRef[] = [], removed: DiffNodeRef[] = [], changed: ScreenDiff["changed"] = [], reordered: ScreenDiff["reordered"] = [];
  let positionOnly = 0, formatOnly = 0;
  // Instances whose main component was swapped: their sublayer ids are regenerated (see the header).
  const swapped = new Map<string, SwapCount>(); // instance id -> { gone, came }
  for (const [id, b] of B) { const a = A.get(id); if (a && !same(a.node.mainComponent, b.node.mainComponent)) swapped.set(id, { gone: 0, came: 0 }); }
  const underSwap = (idx: Map<string, IndexEntry>, e: IndexEntry): SwapCount | null => {
    for (let p: string | null | undefined = e.parentId; p !== null && p !== undefined; p = idx.get(p)?.parentId) { const sw = swapped.get(p); if (sw) return sw; }
    return null;
  };
  // Top-most only: a node whose parent is ALSO new/gone is covered by that parent's entry.
  for (const [id, e] of B) if (!A.has(id)) { const sw = underSwap(B, e); if (sw) sw.came++; else if (e.parentId === null || A.has(e.parentId)) added.push(describe(e)); }
  for (const [id, e] of A) if (!B.has(id)) { const sw = underSwap(A, e); if (sw) sw.gone++; else if (e.parentId === null || B.has(e.parentId)) removed.push(describe(e)); }
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const fields = nodeFields(a, b);
    if (a.parentId !== b.parentId) fields.push({ field: "parent", category: "layout", before: a.path, after: b.path });
    if (typeof b.node.asset === "string" && b.node.asset === a.node.asset && redrawn.has(b.node.asset)) fields.push({ field: "asset bytes", category: "asset", before: "the previous render", after: `re-drawn — ${b.node.asset} has different contents under the same node id` });
    const sw = swapped.get(id);
    if (sw && (sw.gone || sw.came)) fields.push({ field: "sublayers", category: "component", before: `${sw.gone} from the old main component`, after: `${sw.came} from the new one (regenerated by the swap — not listed)` });
    if (fields.length) changed.push({ ...describe(b), categories: [...new Set(fields.map((f) => f.category))], fields });
    // Only the old plugin's format noise differed, and it sits on ONE side (a re-pull with a newer plugin):
    // neither a change nor a move. Two exports from one plugin (noise on both or neither) never count here.
    else if (hasNoise(a) !== hasNoise(b) && nodeFields(a, b, true).length) formatOnly++;
    else if (!same(a.node.box, b.node.box)) positionOnly++;
    const keptBefore = a.childIds.filter((c) => b.childIds.includes(c)), keptAfter = b.childIds.filter((c) => a.childIds.includes(c));
    if (!same(keptBefore, keptAfter)) reordered.push({ ...describe(b), before: keptBefore.map((c) => nameOf(A, c)), after: keptAfter.map((c) => nameOf(B, c)) });
  }
  // Facts that live beside the tree, not in it: prototype flows, the modes the frame resolves in,
  // dev resources. A new flow changes what has to be built as surely as a new layer does.
  const document: FieldDiff[] = [];
  for (const key of new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)])) {
    if (!ROOT_IGNORED.has(key)) document.push(...fieldDiffs(key, bag(oldDoc)[key], bag(newDoc)[key], "document"));
  }
  const warnings: string[] = [];
  const trunc = truncatedOf(manifestOf(newDoc));
  if (trunc) warnings.push(`the NEW export is truncated (${trunc === true ? "some" : trunc} subtree(s) past the depth limit) — anything under "Removed" may simply not have been exported. Re-pull a narrower scope before acting on removals.`);
  if (formatOnly) warnings.push(`${formatOnly} node(s) differ only by the exporter's format (an export from an older plugin: grid-child fields off a grid, layout on text/shapes/leaves or asset leaves) — not listed. The export's content hash changed, so verification reopens once: re-run verify-screen --expect and --compare.`);
  return { kind: "screen", summary: { added: added.length, removed: removed.length, changed: changed.length + (document.length ? 1 : 0), reordered: reordered.length, positionOnly, formatOnly }, warnings, added, removed, reordered, changed, document };
}

// Tokens are keyed by their Figma KEY — the one thing that identifies a variable. Names are not
// unique: a merged variables.json can hold two `Spacing / Space 4` (24 and 16, distinct keys)
// in the SAME collection, and a `[collection, name]` key would let a Map keep the last of them, so a
// real change to the other would be invisible and merely re-ordering the rows would report a false `24 → 16`.
// `[collection, name]` is only the fallback for a row with no key (hand-written
// or very old files), and the human LABEL: a name shared by several variables is labelled with its
// collection and its key, so the report says WHICH one changed.
function diffTokens(oldDoc: TokensDoc, newDoc: TokensDoc): TokensDiff {
  const idOf = (v: Variable): string => (typeof v.key === "string" && v.key ? "k:" + v.key : "n:" + JSON.stringify([v.collection || "", v.name]));
  const keyed = (doc: TokensDoc): Map<string, Variable> => new Map((doc.variables || []).map((v): [string, Variable] => [idOf(v), v]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  // A row that carries a key on one side only (an export from before keys were written) still pairs
  // with its keyless twin when [collection, name] names exactly one variable on each side.
  const byName = (m: Map<string, Variable>): Map<string, string | null> => { const o = new Map<string, string | null>(); for (const [id, v] of m) { const n = JSON.stringify([v.collection || "", v.name]); o.set(n, o.has(n) ? null : id); } return o; };
  const nA = byName(A), nB = byName(B), pairs = new Map<string, string>(); // B id -> A id
  for (const [id, v] of B) {
    if (A.has(id)) { pairs.set(id, id); continue; }
    const n = JSON.stringify([v.collection || "", v.name]), aId = nA.get(n);
    if (aId && nB.get(n) === id && !B.has(aId) && (aId.startsWith("n:") || id.startsWith("n:"))) pairs.set(id, aId);
  }
  const pairedA = new Set(pairs.values());
  // Which names need more than the name to say which variable they are.
  const identities = new Map<string, Map<string, string>>();
  for (const v of [...A.values(), ...B.values()]) {
    getOrInit(identities, v.name, () => new Map<string, string>()).set(idOf(v), v.collection || "");
  }
  const label = (v: Variable): string => {
    const ids = identities.get(v.name);
    if (!ids || ids.size < 2) return v.name;
    const sameColl = [...ids.values()].filter((c) => c === (v.collection || "")).length > 1;
    return (v.collection ? `${v.collection} / ${v.name}` : v.name) + (sameColl && typeof v.key === "string" && v.key ? ` (key ${v.key.slice(0, 8)}…)` : "");
  };
  const added = [...B].filter(([k]) => !pairs.has(k)).map(([, v]) => label(v));
  const removed = [...A].filter(([k]) => !pairedA.has(k)).map(([, v]) => label(v));
  const changed: TokensDiff["changed"] = [];
  for (const [k, b] of B) {
    const pk = pairs.get(k); // every paired B id maps to an A id
    const a = pk !== undefined ? A.get(pk) : null;
    if (!a) continue;
    const modes = [...new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])].filter((m) => !same((a.values || {})[m], (b.values || {})[m]));
    if (modes.length) changed.push({ name: label(b), ...ifDefined("collection", b.collection), ...ifDefined("key", b.key), modes: modes.map((m) => ({ mode: m, before: brief((a.values || {})[m]), after: brief((b.values || {})[m]) })) });
  }
  // A new or renamed MODE changes every themed token at once, yet no single variable says so.
  // Collections too are keyed by key where there is one: the same export holds TWO collections called
  // `Spacing`, and a name-keyed Map compared whichever came last on each side.
  const collNames = new Map<string, Set<string>>();
  for (const c of [...(oldDoc.collections || []), ...(newDoc.collections || [])]) collNames.set(c.name, (collNames.get(c.name) || new Set<string>()).add(c.key || c.name));
  // colLabel only sees collections of oldDoc/newDoc, all registered just above, so `?? 0` is inert.
  const colLabel = (c: VariableCollection): string => ((collNames.get(c.name)?.size ?? 0) > 1 && c.key ? `${c.name} (key ${String(c.key).slice(0, 8)}…)` : c.name);
  const cols = (doc: TokensDoc) => new Map((doc.collections || []).map((c): [string, { label: string; v: { modes: string[]; default?: string } }] => [c.key ? "k:" + c.key : "n:" + c.name, { label: colLabel(c), v: { modes: c.modes, ...ifDefined("default", c.default) } }]));
  const CA = cols(oldDoc), CB = cols(newDoc), collections: FieldDiff[] = [];
  // new Map([...CA, ...CB]): CA's ids then CB's new ones (Set insertion order), each holding CB's entry else CA's.
  for (const [id, e] of new Map([...CA, ...CB])) collections.push(...fieldDiffs(e.label, CA.get(id)?.v, CB.get(id)?.v, "collection"));
  return { kind: "tokens", summary: { added: added.length, removed: removed.length, changed: changed.length + (collections.length ? 1 : 0) }, warnings: [], added, removed, changed, collections };
}

// The component catalog (components.local.json / components.library.json). Keyed by the component
// `key` (what codeconnect.local.json maps), else id. This is where a new "Loading" variant or a
// deleted component shows up — and it ripples to every screen that uses it, not just the one in hand.
function diffCatalog(oldDoc: ComponentsCatalog, newDoc: ComponentsCatalog): CatalogDiff {
  const keyed = (doc: ComponentsCatalog): Map<string, CatalogComponent> => new Map((doc.components || []).map((c): [string, CatalogComponent] => [String(c.key || c.id), c]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  const brief1 = (c: CatalogComponent): CatalogBrief => ({ ...ifDefined("key", c.key), ...ifDefined("id", c.id), name: c.name, type: c.type });
  const added = [...B].filter(([k]) => !A.has(k)).map(([, c]) => brief1(c)), removed = [...A].filter(([k]) => !B.has(k)).map(([, c]) => brief1(c)), changed: CatalogDiff["changed"] = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const fields: FieldDiff[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!CATALOG_IGNORED.has(key)) fields.push(...fieldDiffs(key, bag(a)[key], bag(b)[key], "component"));
    if (fields.length) changed.push({ ...brief1(b), fields });
  }
  return { kind: "catalog", summary: { added: added.length, removed: removed.length, changed: changed.length }, warnings: [], added, removed, changed };
}
const CATALOG_IGNORED = new Set(["page", "pageId", "box", "renderBox"]);

// The style files (one per style kind, bridge/src/design-system-layout.ts STYLE_KINDS) share one
// shape: `{ exportedAt, file, colorProfile, styles: [{ name, key, id, ...fields }] }`.
// The export-directory diff (sync-design) covers each of these (and hygiene.json below), so every one
// must be diffable rather than exit 2 with "nothing here can be diffed" — otherwise a typography-only or
// effect-only design-system change would be undetectable. Keyed
// by `key` (Figma's style key — stable across pulls; every style kind has one), falling back to `name`
// for a style that somehow has none.
function styleKey(s: { key?: string; name?: string } | null | undefined): string {
  return (s && typeof s.key === "string" && s.key) ? "k:" + s.key : "n:" + String((s && s.name) || "");
}
const STYLE_IGNORED = new Set(["key", "id"]);
function diffStyles(oldDoc: StylesDoc, newDoc: StylesDoc): StylesDiff {
  const keyed = (doc: StylesDoc): Map<string, AnyStyle> => new Map((doc.styles || []).map((s): [string, AnyStyle] => [styleKey(s), s]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  const brief = (s: AnyStyle): StyleBrief => ({ ...ifDefined("key", s.key), ...ifDefined("id", s.id), name: s.name });
  const added = [...B].filter(([k]) => !A.has(k)).map(([, s]) => brief(s));
  const removed = [...A].filter(([k]) => !B.has(k)).map(([, s]) => brief(s));
  const changed: StylesDiff["changed"] = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const fields: FieldDiff[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!STYLE_IGNORED.has(key)) fields.push(...fieldDiffs(key, bag(a)[key], bag(b)[key], "style"));
    if (fields.length) changed.push({ ...brief(b), fields });
  }
  return { kind: "styles", summary: { added: added.length, removed: removed.length, changed: changed.length }, warnings: [], added, removed, changed };
}

// hygiene.json is `{ ..., hygiene: [<sentence>, ...] }` — a flat list of lint-style lines, not keyed
// records, so the diff is by LINE: a sentence present in one and not the other is added/removed. Order
// doesn't carry meaning here (collect.ts appends as it walks), so it's compared as a set.
function diffHygiene(oldDoc: HygieneDoc, newDoc: HygieneDoc): HygieneDiff {
  const A = new Set((oldDoc.hygiene || []).map(String)), B = new Set((newDoc.hygiene || []).map(String));
  const added = [...B].filter((h) => !A.has(h));
  const removed = [...A].filter((h) => !B.has(h));
  return { kind: "hygiene", summary: { added: added.length, removed: removed.length, changed: 0 }, warnings: [], added, removed, changed: [] };
}

// The design-system MANIFEST (design-system.json — bridge/src/design-system-layout.ts's MANIFEST file):
// `{ exportedAt, file, colorProfile, files: {<key>: <path>}, counts: {<key>: <number>} }`. Not an
// array of records like every other design-system file, so it gets a flat field diff rather than a
// keyed one. The export-directory diff covers it with the other design-system files, so it must not
// be the one file left exiting 2 with "nothing here can be diffed". `exportedAt` is ignored (a timestamp, not a design
// fact); everything else — `file` (which Figma file this design system came from), `colorProfile`,
// every `files.*` pointer and every `counts.*` number — is a real, if coarse, signal: `counts.hygiene`
// climbing is "more lint warnings appeared" without opening hygiene.json, `counts.components` dropping
// is components removed, etc.
const MANIFEST_IGNORED = new Set(["exportedAt"]);
function diffManifest(oldDoc: DesignSystemManifest | null | undefined, newDoc: DesignSystemManifest | null | undefined): ManifestDiff {
  const fields: FieldDiff[] = [];
  for (const key of new Set([...Object.keys(oldDoc || {}), ...Object.keys(newDoc || {})])) {
    if (MANIFEST_IGNORED.has(key)) continue;
    fields.push(...fieldDiffs(key, bag(oldDoc || {})[key], bag(newDoc || {})[key], "manifest"));
  }
  return { kind: "manifest", summary: { added: 0, removed: 0, changed: fields.length ? 1 : 0 }, warnings: [], fields };
}

// Which kind of file is this? Each sniffer is the same "has the payload array" test the JS ran; the
// matching doc-guards.ts guard then checks the payload, so a token file with a broken row is reported as
// exactly that — not as "nothing here can be diffed" and not as a TypeError inside the diff.
const hasArray = (doc: unknown, key: string): boolean => isJsonObject(doc) && Array.isArray(doc[key]);
// Checked AFTER tokens/catalog/styles/hygiene (none of which this can also match — none of THEM carry
// both `counts` and `files` as plain objects) so ordering is safe either way, but kept last among the
// design-system kinds since it is the least specific shape (an object with two nested objects).
const isManifest = (doc: unknown): doc is DesignSystemManifest => isJsonObject(doc) && isJsonObject(doc.counts) && isJsonObject(doc.files);
const isStyles = (doc: unknown): doc is StylesDoc => isJsonObject(doc) && Array.isArray(doc.styles) && doc.styles.every((st) => isJsonObject(st) && typeof st.name === "string");
isStyles.expected = "a style sheet: an object with a `styles` array of {name, key?, …}";
const isHygiene = (doc: unknown): doc is HygieneDoc => isJsonObject(doc) && isStringArray(doc.hygiene);
isHygiene.expected = "hygiene.json: an object with a `hygiene` array of strings";
// A screen export or a layer file — NOT a bare node tree: every other kind here is also "an object with
// an id and a type" often enough (a catalog variant's node) that a bare tree is not diffed as a screen.
const isScreen = (doc: unknown): doc is ScreenDoc => isScreenExport(doc) || isLayerFile(doc);
isScreen.expected = "a screen export: an object whose `nodes` is an array of nodes {id, type, …}, or a layer file whose `tree` is one";
// The sniffed kind's guard, or a one-line reason.
function checked<T>(doc: unknown, guard: DocGuard<T>): T {
  if (guard(doc)) return doc;
  throw new Error(`is not ${guard.expected || "a document of that kind"}`);
}
function diffDocs(oldDoc: unknown, newDoc: unknown, opts?: { redrawn?: Set<string> }): DiffReport {
  // The baseline is read as the kind the CURRENT file proved to be. A baseline of another kind (or none
  // at all — a null, a truncated file) diffs as "everything added", as the header promises: each branch
  // hands the diff an EMPTY document of the current kind rather than casting whatever the baseline was.
  if (hasArray(newDoc, "variables")) return diffTokens(isTokensDoc(oldDoc) ? oldDoc : {}, checked(newDoc, isTokensDoc));
  if (hasArray(newDoc, "components")) return diffCatalog(isComponentsCatalog(oldDoc) ? oldDoc : { components: [] }, checked(newDoc, isComponentsCatalog));
  if (hasArray(newDoc, "styles")) return diffStyles(isStyles(oldDoc) ? oldDoc : { styles: [] }, checked(newDoc, isStyles));
  if (hasArray(newDoc, "hygiene")) return diffHygiene(isHygiene(oldDoc) ? oldDoc : { hygiene: [] }, checked(newDoc, isHygiene));
  if (hasArray(newDoc, "nodes") || (isJsonObject(newDoc) && isJsonObject(newDoc.tree))) return diffScreens(isScreen(oldDoc) ? oldDoc : { nodes: [] }, checked(newDoc, isScreen), opts);
  if (isManifest(newDoc)) return diffManifest(isManifest(oldDoc) ? oldDoc : null, newDoc);
  throw new Error("not a screen export, a token file, a component catalog, a style sheet, hygiene.json or the design-system manifest (no `tree`/`nodes`, `variables`, `components`, `styles`, `hygiene` or `counts`+`files` at the top level) — nothing here can be diffed");
}
function markdown(d: DiffReport, label: string): string {
  const s = d.summary, L = [`# What changed — ${label}`, ""];
  for (const w of d.warnings || []) L.push(`> **Warning:** ${w}`, "");
  const total = s.added + s.removed + s.changed + (s.reordered || 0);
  if (!total) {
    const why = d.kind === "screen" ? [s.positionOnly ? `${s.positionOnly} node(s) only moved with their surroundings` : "", s.formatOnly ? `${s.formatOnly} node(s) differ only by the exporter's format` : ""].filter(Boolean) : [];
    return L.concat(why.length ? `Nothing changed (${why.join("; ")}).` : "Nothing changed.").join("\n") + "\n";
  }
  const line = (f: FieldDiff): string => `  - \`${f.field}\`: ${f.before === undefined ? "—" : f.before} → ${f.after === undefined ? "—" : f.after}`;
  if (d.kind === "tokens") {
    if (d.changed.length) L.push("## Token values changed", ...d.changed.map((c) => `- \`${c.name}\` — ${c.modes.map((m) => `${m.mode}: ${m.before} → ${m.after}`).join("; ")}`), "");
    if (d.collections.length) L.push("## Collections / modes changed", ...d.collections.map(line), "");
    if (d.added.length) L.push("## Tokens added", ...d.added.map((n) => `- \`${n}\``), "");
    if (d.removed.length) L.push("## Tokens removed", ...d.removed.map((n) => `- \`${n}\``), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "catalog") {
    const one = (c: CatalogBrief): string => `- **${c.name}** (${c.type || "component"}, key \`${c.key || c.id}\`)`;
    L.push("_A catalog change affects every built screen that uses the component — check each `design/plan/*.json` `components[]`, not only the screen in hand._", "");
    if (d.changed.length) L.push("## Components changed", ...d.changed.flatMap((c) => [one(c), ...c.fields.map(line)]), "");
    if (d.added.length) L.push("## Components added", ...d.added.map(one), "");
    if (d.removed.length) L.push("## Components removed", ...d.removed.map(one), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "styles") {
    const one = (s: StyleBrief): string => `- **${s.name}** (key \`${s.key || s.id}\`)`;
    if (d.changed.length) L.push("## Styles changed", ...d.changed.flatMap((s) => [one(s), ...s.fields.map(line)]), "");
    if (d.added.length) L.push("## Styles added", ...d.added.map(one), "");
    if (d.removed.length) L.push("## Styles removed", ...d.removed.map(one), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "hygiene") {
    if (d.added.length) L.push("## New warning(s)", ...d.added.map((h) => `- ${h}`), "");
    if (d.removed.length) L.push("## Resolved warning(s)", ...d.removed.map((h) => `- ${h}`), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "manifest") {
    L.push("## Design system summary changed", ...d.fields.map(line), "");
    return L.join("\n") + "\n";
  }
  if (d.changed.length) L.push("## Changed", ...d.changed.flatMap((c) => [`- **${c.path}** (\`${c.id}\`, ${c.categories.join(" + ")})`, ...c.fields.map(line)]), "");
  if (d.document && d.document.length) L.push("## Beside the tree (flows, modes, dev resources)", ...d.document.map(line), "");
  if (d.added.length) L.push("## Added (each stands for its whole subtree)", ...d.added.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.removed.length) L.push("## Removed (each stands for its whole subtree)", ...d.removed.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.reordered.length) L.push("## Reordered children", ...d.reordered.map((r) => `- **${r.path}**: ${r.before.join(", ")} → ${r.after.join(", ")}`), "");
  if (s.positionOnly) L.push(`_${s.positionOnly} other node(s) only moved with their surroundings — not listed._`, "");
  if (s.formatOnly) L.push(`_${s.formatOnly} other node(s) differ only by the exporter's format — not listed._`, "");
  return L.join("\n") + "\n";
}

// The on-disk spelling of `p` (a symlinked /tmp and its /private/tmp target are one directory), resolving
// the deepest part that exists for a path that does not.
function realOf(p: string): string {
  try { return fs.realpathSync(p); } catch { const d = path.dirname(p); return d === p ? p : path.join(realOf(d), path.basename(p)); }
}
const escapes = (rel: string): boolean => rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
// `abs` relative to `base` as typed (a symlinked design/export keeps its own name), else through real paths
// (an absolute path spelt through a symlinked /tmp while the cwd is its target); null when it is under neither.
function relUnder(base: string, abs: string): string | null {
  const logical = path.relative(base, abs);
  if (!escapes(logical)) return logical;
  const real = path.relative(realOf(base), realOf(abs));
  return escapes(real) ? null : real;
}
const ancestorsOf = (from: string): string[] => { const out: string[] = []; for (let d = from; ; d = path.dirname(d)) { out.push(d); if (path.dirname(d) === d) return out; } };
// A directory whose design/ is a project's: it holds an export (the current layout's or the flat one) or a snapshot already.
const hasProjectDesign = (d: string): boolean => looksLikeExportDir(path.join(d, DESIGN_DIR)) || looksLikeExportDir(path.join(d, EXPORT_DIR)) || fs.existsSync(path.join(d, SNAPSHOT_DIR));
// design/export/pages/Home/Login__1_2.json -> design/.sync/export__pages__Home__Login__1_2.json, under the
// project whose design/ holds the file: the nearest of the cwd and its ancestors that has one (run from the
// project root, from design/ or below, or from a source folder beside it), else the nearest ancestor of the
// FILE (an absolute path from outside the project, or an inner project addressed from an outer one). A file
// under no project's design/ has no snapshot place (null): a bare name in the cwd's design/.sync would be
// found by no run from anywhere else. A design/export symlinked elsewhere is found by the path through
// design/, not by its real target.
function snapshotPath(file: string, cwd: string = process.cwd()): string | null {
  const abs = path.resolve(cwd, file);
  const placeUnder = (d: string): string | null => { const rel = relUnder(path.join(d, DESIGN_DIR), abs); return rel === null ? null : path.join(d, SNAPSHOT_DIR, rel.split(path.sep).join("__")); };
  const fromCwd = ancestorsOf(cwd);
  for (const d of [...fromCwd.filter(hasProjectDesign), ...ancestorsOf(path.dirname(abs)).filter(hasProjectDesign), ...fromCwd]) {
    const p = placeUnder(d);
    if (p !== null) return p;
  }
  return null;
}

// ---- asset bytes. A node's `asset` path is derived from its id, so a re-drawn icon keeps the same
// path and the JSON is identical — only the file on disk differs. The snapshot records a hash per
// asset beside it; against git HEAD the committed blob is hashed instead.
//
// Figma's SVG export is not bit-reproducible: re-exporting the SAME icon with
// NOTHING changed in the design comes back with different floating-point path coordinates, ≤0.002px
// apart. Hashing the raw bytes reported 27 "changed" assets on a byte-identical re-pull.
// `normalizeForCompare`/`sha1Hex` (bridge/src/asset-compare.ts, built on bridge/src/svg-normalize.ts) are the
// SAME shared implementation figma-plugin/src/assets.ts's content-hash and bridge/src/write-out.ts's
// clobber-avoidance both use — one definition of "same SVG, modulo export noise", not three that could
// silently disagree. See svg-normalize.ts for why the tolerance is 1 decimal place (~0.1px), not 2:
// two legitimately identical re-exports can straddle a 2-decimal rounding boundary (4.97401 -> 4.97 vs
// 4.97596 -> 4.98, only 0.00195 apart) and split into different hashes anyway — verified against the
// real eight arrow-down*.svg variants in test/fixtures/livetest3/arrow-down/, which are the fixture
// for this exact tolerance choice.
function hashAssetBytes(fileName: string, buf: Buffer | string): string {
  return sha1Hex(normalizeForCompare(fileName, buf));
}
function assetPaths(doc: ScreenDoc): string[] {
  const out = new Set<string>();
  // every layer's file, a hidden one's too: the diff compares what the export wrote, not what renders
  for (const r of screenRoots(doc)) walkWithHidden(r, (n) => { if (typeof n.asset === "string") out.add(n.asset); });
  return [...out];
}
// Asset paths are relative to the export root (design/), which may be several directories above a page file.
function assetRoot(file: string, assets: string[]): string | null {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) if (assets.some((a) => fs.existsSync(path.join(dir, a)))) return dir;
  return null;
}
function assetHashes(file: string, doc: ScreenDoc): { root: string | null; hashes: Record<string, string> } {
  const assets = assetPaths(doc), root = assets.length ? assetRoot(file, assets) : null, out: Record<string, string> = {};
  if (root) for (const a of assets) { try { out[a] = hashAssetBytes(a, fs.readFileSync(path.join(root, a))); } catch { /* not exported (--no-assets) */ } }
  return { root, hashes: out };
}

/** The baseline previous() picked: the parsed older document, where it came from, and its asset-hash sidecar. */
export interface Baseline {
  doc: unknown;
  source: string;
  kind: "file" | "snapshot" | "git";
  assets?: Record<string, string> | null;
  notes: string[];
  /** every candidate was the SAME export as the current file — the diff says nothing */
  same?: true;
}

function redrawnAssets(file: string, newDoc: ScreenDoc, prev: Baseline, cwd: string): Set<string> {
  const now = assetHashes(file, newDoc), out = new Set<string>();
  if (!now.root) return out;
  const root = now.root, entries = Object.entries(now.hashes);
  const headHashes = prev.kind === "git" ? gitHeadAssetHashes(cwd, entries.map(([a]) => a), (a) => (relUnder(cwd, path.join(root, a)) ?? path.relative(cwd, path.join(root, a))).split(path.sep).join("/")) : null;
  for (const [a, h] of entries) {
    const before = prev.kind === "snapshot" ? (prev.assets || {})[a] : headHashes?.get(a);
    if (before && before !== h) out.add(a);
  }
  return out;
}

// The HEAD copy of every asset is read through ONE `git cat-file --batch -Z` child, not a `git show` each (one child
// per asset was most of a diff's time). A blob's normalised hash is remembered by blob id and kind (SVG or not — all
// normalizeForCompare looks at), so an asset that several screens share is normalised once per process.
const headHashMemo = new Map<string, string>();
/** asset -> hashAssetBytes of its HEAD blob, for the assets committed with bytes (a missing or empty one has none). */
function gitHeadAssetHashes(cwd: string, assets: readonly string[], relOf: (a: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  const rels = assets.map(relOf), blobs = gitHeadBlobs(cwd, rels);
  assets.forEach((a, i) => {
    const b = blobs === null ? undefined : blobs[i];
    if (b === undefined) { const bytes = gitShowHead(cwd, rels[i] ?? ""); if (bytes) out.set(a, hashAssetBytes(a, bytes)); return; } // the batch could not answer: the one-by-one read
    if (b === null || b.bytes.length === 0) return; // not in HEAD; or committed empty, never an asset's copy (as gitShowHead says)
    const key = (isSvgName(a) ? "svg:" : "raw:") + b.oid;
    out.set(a, getOrInit(headHashMemo, key, () => hashAssetBytes(a, b.bytes)));
  });
  return out;
}

/** One answer of a `git cat-file --batch -Z` run per request: the blob (an empty one is an empty Buffer), null when
 *  the request names nothing in HEAD, or undefined when it names something that is not a blob (a directory: the caller
 *  asks `git show`, as before). The whole result is null when the batch cannot answer at all: not a repository, a git
 *  without -Z (2.43+), or a path outside the repository (fatal to the whole batch) — the caller then reads each the old
 *  way. A batch that times out is null too: the 60 s limit was each read's own, so a batch of many blobs that runs
 *  past it says nothing about any one of them — each is read the old way, under its own limit, so no comparison is
 *  silently skipped. */
function gitHeadBlobs(cwd: string, rels: readonly string[]): Array<{ oid: string; bytes: Buffer } | null | undefined> | null {
  if (!rels.length) return [];
  // -Z: requests and replies are NUL-terminated, so a path with a newline is one request; every reply is size-framed
  // (`<oid> <type> <size>\0<bytes>\0`) or in-band (`<request> missing\0`), parsed on the bytes, never decoded text.
  const reqs = rels.map((rel) => "HEAD:./" + rel);
  const input = Buffer.from(reqs.map((q) => q + "\0").join(""), "utf8");
  const r = runSync("git", ["cat-file", "--batch", "-Z"], { cwd, input, binary: true, expect: (x) => parseCatFileBatch(x.stdoutBytes, reqs) !== null, quiet: true, timeoutMs: 60_000 });
  return !r.timedOut && r.status === 0 ? parseCatFileBatch(r.stdoutBytes, reqs) : null;
}
function parseCatFileBatch(out: Buffer | undefined, reqs: readonly string[]): Array<{ oid: string; bytes: Buffer } | null | undefined> | null {
  if (!out) return null;
  const got: Array<{ oid: string; bytes: Buffer } | null | undefined> = [];
  let at = 0;
  for (const req of reqs) {
    const end = out.indexOf(0, at);
    if (end < 0) return null;
    const head = out.toString("utf8", at, end);
    at = end + 1;
    if (head === req + " missing" || head === req + " ambiguous") { got.push(null); continue; }
    const m = /^([0-9a-f]{40,64}) ([a-z]+) (\d+)$/.exec(head);
    if (!m) return null;
    const size = Number(m[3]);
    if (at + size >= out.length || out[at + size] !== 0) return null;
    got.push(m[2] === "blob" ? { oid: m[1] ?? "", bytes: out.subarray(at, at + size) } : undefined);
    at += size + 1;
  }
  return at === out.length ? got : null;
}

/** The bytes `rel` (relative to cwd, `/`-separated) has in HEAD, or null: not a repo, not committed, no git. Captured
 *  through a file (proc.ts runSync): an exit-0 run with no bytes (Bun #46142) is run once more before it counts, and a
 *  blob that is still empty then is not taken for a committed copy — an export or an asset is never an empty file. That
 *  re-run is expected here (a committed empty file is ordinary), so it is quiet: no `[spawn-helper]` line on the user's stderr. */
function gitShowHead(cwd: string, rel: string): Buffer | null {
  const r = runSync("git", ["show", "HEAD:./" + rel], { cwd, binary: true, expect: "stdout", quiet: true, timeoutMs: 60_000 });
  return r.status === 0 && !r.lost && r.stdoutBytes ? r.stdoutBytes : null;
}

// See the header: drop a baseline that IS the current export, then the most recent one wins.
function previous(file: string, against: string | undefined, cwd: string = process.cwd(), current: unknown = null): Baseline | null {
  if (against) {
    // A baseline the user NAMED must be there and be JSON: exit-2 one-liner otherwise (catalog-input.ts).
    return { doc: readJsonFile(against, "baseline (--against)"), source: against, kind: "file", notes: [] };
  }
  const found: Array<Omit<Baseline, "notes">> = [];
  const snap = snapshotPath(file, cwd);
  if (snap !== null && fs.existsSync(snap)) {
    const assets = readJsonOrNull(snap + ".assets.json", isStringRecord); // null: an older snapshot, or no assets
    const r = readJson(snap, anyJson);
    // The snapshot is the baseline this command exists for: a corrupt one is said, not diffed as "no baseline".
    // The advice depends on when it is read: before the re-pull --force re-takes the snapshot, after it
    // that copy would be the new export, so the diff has git HEAD or --against left.
    if (!("doc" in r)) throw new Error(`the snapshot ${path.relative(cwd, snap)} ${r.error} — re-take it with --snapshot --force if the export has not been re-pulled yet; after the re-pull the snapshot would be the new export, so the diff then uses git HEAD or --against <an older copy>`);
    found.push({ doc: r.doc, source: path.relative(cwd, snap), kind: "snapshot", assets });
  }
  // `--snapshot --force` keeps the baseline it is about to replace as `<name>.prev`
  // (design-to-code/design-diff.ts's own --snapshot handler) specifically so it stays available as a
  // diff baseline; `previous()` looks for it. The shape this covers: snapshot taken
  // (B0) -> re-pull (E1) -> a MISTAKEN second `--snapshot` refused (dest still B0) -> `--force` (dest
  // becomes E1, B0 saved as dest.prev) -> the current export IS E1, so the primary snapshot is now the
  // SAME export as the file on disk and gets filtered out below exactly like any other same-export
  // baseline — leaving `.prev` (B0) as the only genuinely older copy; without it the diff would say
  // "There is no OLDER export to compare against" while it sat right there.
  // A `.prev` with a `.prev.diffed` beside it is the other kind: a SPENT snapshot a later sync replaced,
  // kept only so someone can diff against it by hand (--against). It is history, never a baseline.
  if (snap !== null && fs.existsSync(snap + ".prev") && !fs.existsSync(snap + ".prev" + DIFFED)) {
    const assets = readJsonOrNull(snap + ".assets.json.prev", isStringRecord); // null: no assets sidecar was kept
    const r = readJson(snap + ".prev", anyJson);
    if ("doc" in r) found.push({ doc: r.doc, source: path.relative(cwd, snap) + ".prev", kind: "snapshot", assets }); // a corrupt .prev is ignored rather than failing the whole diff
  }
  try {
    const rel = (relUnder(cwd, path.resolve(cwd, file)) ?? path.relative(cwd, path.resolve(cwd, file))).split(path.sep).join("/");
    const bytes = gitShowHead(cwd, rel);
    if (bytes) found.push({ doc: JSON.parse(bytes.toString("utf8")) as unknown, source: "git HEAD", kind: "git" });
  } catch { /* committed, but not JSON */ }
  const firstFound = found[0];
  if (firstFound === undefined) return null;
  // The freshness signal for a screen export is `exportedAt`, stamped once by the plugin. A merged
  // `variables.json` (bridge/src/variables-merge.ts) has no single `exportedAt` that means anything — it is
  // the union of every screen ever pulled into this project — so without a fallback `at()` would be `null`
  // for it, `previous()`'s "this baseline is the SAME export, don't use it" check could never fire, and
  // a diff against a stale variables.json baseline that has since been re-pulled with a genuinely
  // identical export would report nothing wrong to warn about... but also could never tell "same" from
  // "different" this way. `_slices[]` (one per pulled screen) each carry their own `at`
  // timestamp that DOES change meaningfully — this reads the MAX of them as the document's freshness,
  // falling back to `exportedAt` for every other doc kind. This is a freshness signal only: the actual
  // value comparison in diffTokens() is still by variable key (`keyed()`/`diffTokens`), so a
  // `_slices[].at` that re-appends on every re-pull does not, by itself, manufacture a
  // fake "changed" token — it only lets `previous()` recognise which baseline is newer.
  const at = (d: unknown): string | null => {
    if (!d || typeof d !== "object") return null;
    if ("exportedAt" in d && typeof d.exportedAt === "string") return d.exportedAt;
    if ("_slices" in d && Array.isArray(d._slices) && d._slices.length) {
      const times = d._slices.map((s: unknown) => s && typeof s === "object" && "at" in s && typeof s.at === "string" ? s.at : null).filter((t): t is string => !!t);
      if (times.length) return times.reduce((mx, t) => (t > mx ? t : mx));
    }
    return null;
  };
  const now = at(current), notes: string[] = [];
  const useful = found.filter((c) => !(now && at(c.doc) === now));
  for (const c of found) if (!useful.includes(c)) notes.push(`${c.source} is the SAME export as ${file} (exportedAt ${now}) — ${c.kind === "snapshot" ? "the snapshot was taken after the re-pull" : "the new export is already committed"}, so it was not used as the baseline.`);
  useful.sort((x, y) => String(at(y.doc) || "").localeCompare(String(at(x.doc) || ""))); // (a no-op when empty)
  const [newest, older] = useful;
  if (newest === undefined) return { ...firstFound, notes: [...notes, `There is no OLDER export to compare against, so this says nothing about what the designer changed. Pass --against <an older copy>.`], same: true };
  if (older !== undefined && at(newest.doc) !== at(older.doc)) notes.push(`${older.source} is older than ${newest.source} — used the newer one, so changes already applied are not listed again.`);
  if (snap !== null && newest.source === path.relative(cwd, snap) && diffedSince(file, snap)) notes.push(`${newest.source} was already diffed against an earlier export of ${file}, and the file was re-pulled since — this lists everything since that diff, including changes the earlier sync already applied.`);
  return { ...newest, notes };
}

// The design-system files a --design-system pull writes, as bridge/src/design-system-layout.ts names
// them (the per-component detail files are not diffed): every part under design-system/ and the
// manifest, design-system.json, which stays at the export root beside it.
const DS_FILE_NAMES = DESIGN_SYSTEM_FILE_NAMES;
const dsFilePath = (exportRoot: string, name: string): string => name === DESIGN_SYSTEM_FILES.MANIFEST ? path.join(exportRoot, name) : path.join(exportRoot, DESIGN_SYSTEM_DIR, name);
// Every file under an export root this tool diffs as a set: the merged variables.json, every
// design-system file, and every file of each --as-library export (libraries/<dir>/, as
// bridge/src/library-layout.ts names them — not libraries/index.json, which only lists the libraries).
function exportSetCandidates(exportRoot: string): string[] {
  const libRoot = path.join(exportRoot, LIBRARIES_DIR);
  const onDisk = fs.existsSync(libRoot) ? fs.readdirSync(libRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const libDirs = [...new Set([...onDisk, ...snapshotLibraryDirs(libRoot)])].sort();
  return [
    path.join(exportRoot, MERGED_VARIABLES_FILE),
    ...DS_FILE_NAMES.map((n) => dsFilePath(exportRoot, n)),
    ...libDirs.flatMap((d) => LIBRARY_FILE_NAMES.map((n) => path.join(libRoot, d, n))),
  ];
}
// The libraries a snapshot was taken of, read from the snapshot names (export__libraries__<dir>__<file>): a
// library export removed or renamed since has no directory left to list, and its snapshot is what says so.
function snapshotLibraryDirs(libRoot: string): string[] {
  const probe = snapshotPath(path.join(libRoot, "d", "f.json"));
  if (probe === null) return [];
  const prefix = path.basename(probe).slice(0, -"d__f.json".length);
  let names: string[];
  try { names = fs.readdirSync(path.dirname(probe)); } catch { return []; }
  const dirs = new Set<string>();
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    for (const f of LIBRARY_FILE_NAMES) if (n.endsWith("__" + f) && n.length > prefix.length + f.length + 2) dirs.add(n.slice(prefix.length, -(f.length + 2)));
  }
  return [...dirs];
}
// …keeping only those on disk: a screen-only project has no design-system/, and an export from an
// older plugin may lack a part, so a missing one is not something to report.
function exportSetFiles(exportRoot: string): string[] {
  return exportSetCandidates(exportRoot).filter((f) => fs.existsSync(f));
}

// Which OTHER files belong to the same export as `f`, read-only and only those on disk: a sibling
// this assumes is not something the caller asked for, so its absence is not reported.
function siblingFilesOf(f: string): string[] {
  const abs = path.resolve(f);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const out: string[] = [];
  if (DS_FILE_NAMES.includes(base)) {
    // The other design-system files: the manifest sits at the export root, the parts one level down.
    const exportRoot = path.relative(process.cwd(), base === DESIGN_SYSTEM_FILES.MANIFEST ? dir : path.dirname(dir));
    for (const name of DS_FILE_NAMES) {
      const p = dsFilePath(exportRoot, name);
      if (name !== base && fs.existsSync(p)) out.push(p);
    }
    return out;
  }
  // A screen export: pages/<Page>/<Screen>__<id>.json, with .vars.json / .assets.json siblings of the
  // exact same stem (export-index.ts screenSiblingFile — bridge/src/pages-layout.ts's naming).
  if (/\.json$/i.test(base)) {
    for (const kind of ["vars", "assets"] as const) {
      const p = screenSiblingFile(abs, kind);
      if (fs.existsSync(p)) out.push(path.relative(process.cwd(), p));
    }
  }
  // pages/index.json — the root index of the pages/ tree the screen file lives in (export-index.ts).
  // Read-only evidence for the diff to consult, never a diff TARGET on its own, but worth having a
  // baseline for so a future consumer can tell whether this screen is indexed differently than in the baseline.
  const pagesRoot = pagesRootOfScreen(abs);
  if (pagesRoot !== null && hasExportIndex(pagesRoot)) out.push(path.relative(process.cwd(), rootIndexFile(pagesRoot)));
  return out;
}

// A snapshot a diff has already compared against is spent: the sidecar `<snapshot>.diffed` records the
// content hash of the export it was diffed against, written once the report is out. `--snapshot`
// replaces a spent snapshot without --force as long as the export is still that one — the next sync's
// step 2, before its re-pull — and keeps the old one as `.prev` for a diff by hand (--against), never as a
// baseline (a `.prev.diffed` beside it says so). A snapshot no diff has used yet, or one whose export was
// re-pulled again after the diff, still needs --force: replacing it would lose the only copy older than
// the export on disk. A snapshot whose bytes ARE the export it was diffed against was never spent: that
// diff listed nothing for a sync to apply, so the mark says only that a diff ran.
const DIFFED = ".diffed";
const fileHash = (f: string): string | null => { try { return sha1Hex(fs.readFileSync(f)); } catch { return null; } };
function markDiffed(file: string, cwd: string): void {
  const snap = snapshotPath(file, cwd), h = fileHash(file);
  if (h && snap !== null && fs.existsSync(snap)) { try { fs.writeFileSync(snap + DIFFED, h + "\n"); } catch { /* unmarked: the next --snapshot asks for --force, as before */ } }
}
const diffedHash = (snap: string): string | null => { try { return fs.readFileSync(snap + DIFFED, "utf8").trim() || null; } catch { return null; } };
// (A snapshot with the export's own bytes never reaches isSpent: --snapshot treats that as the no-op.)
const isSpent = (file: string, snap: string): boolean => { const m = diffedHash(snap); return m !== null && m === fileHash(file); };
// Diffed once, and the export re-pulled after that diff: the snapshot is older than what the last sync applied.
const diffedSince = (file: string, snap: string): boolean => { const m = diffedHash(snap); return m !== null && m !== fileHash(file) && m !== fileHash(snap); };

// One file against its baseline: the diff, no baseline at all, or why it could not be compared.
type Compared = { result: DiffResult; same: boolean } | { none: true } | { error: string };
// `${e.message}` verbatim: a thrown non-Error prints "undefined".
const errorText = (e: unknown): string => String(e && typeof e === "object" && "message" in e ? e.message : undefined);
function compareFile(file: string, current: unknown, against: string | undefined, cwd: string): Compared {
  let prev: Baseline | null;
  try { prev = previous(file, against, cwd, current); } catch (e) { return { error: errorText(e) }; }
  if (!prev) return { none: true };
  let diff: DiffReport;
  try { diff = diffDocs(prev.doc, current, { redrawn: isScreen(current) ? redrawnAssets(file, current, prev, cwd) : new Set() }); }
  catch (e) { return { error: errorText(e) }; }
  diff.warnings = [...prev.notes, ...(diff.warnings || [])];
  // `warned`/`baseline` let a script decide "should I trust this diff" without re-parsing the markdown
  // or counting `warnings.length` itself — the same two facts `tokens.json`'s human-readable warnings
  // already convey (so a variables.json diff has the same, not a bare "zero warnings").
  return { result: { file, against: prev.source, baseline: prev.kind, warned: diff.warnings.length > 0, ...diff }, same: !!prev.same };
}
// The report to --out (with a one-line summary) or stdout. A write that fails is one line naming it, and
// false — the caller then spends no snapshot, since nobody has seen the diff.
function writeReport(out: string | undefined, text: string, summary: () => string): boolean {
  if (!out) { process.stdout.write(text); return true; }
  try { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, text); }
  catch (e) { console.error(`design-diff: cannot write ${out}: ${errorText(e)}`); return false; }
  console.log(`wrote ${out} — ${summary()}`);
  return true;
}
const changeCount = (r: DiffResult): number => r.summary.added + r.summary.removed + r.summary.changed + (r.summary.reordered || 0);
const noBaselineHint = (what: string): string => `no snapshot in ${SNAPSHOT_DIR.split(path.sep).join("/")}/, and it is not committed in git.\nNext time run \`${scriptCmd("design-diff")} --snapshot ${what}\` BEFORE re-pulling`;

// The export-directory report: one section per file that changed or carries a warning, then one line
// for the files that did not change and one per file that was not compared (with the reason), so the
// whole design-system + variables sync reads as one report.
const SAME_EXPORT_NOTE = / is the SAME export as /;
function directoryMarkdown(d: DirDiffResult): string {
  const L = [`# What changed — ${d.dir}`, ""];
  const quiet: string[] = [], viaOther: string[] = [];
  for (const r of d.results) {
    if (!changeCount(r) && !r.warnings.length) { quiet.push(r.file); continue; }
    // Unchanged, and the only notes say a same-export snapshot was skipped for an older copy: one line, not a section each.
    if (!changeCount(r) && r.warnings.every((w) => SAME_EXPORT_NOTE.test(w))) { viaOther.push(`\`${r.file}\` (vs ${r.against})`); continue; }
    // each file's own report, its headings one level down under the file's own
    L.push(markdown(r, `${r.file} vs ${r.against}`).replace(/^(#+) /gm, "#$1 ").replace(/\n+$/, ""), "");
  }
  if (quiet.length) L.push(`Nothing changed: ${quiet.map((f) => `\`${f}\``).join(", ")}.`, "");
  if (viaOther.length) L.push(`Nothing changed against an older copy (each snapshot was the same export, so it was skipped): ${viaOther.join(", ")}.`, "");
  if (d.notCompared.length) L.push("## Not compared", ...d.notCompared.map((n) => `- \`${n.file}\`: ${n.reason}`), "");
  return L.join("\n").replace(/\n+$/, "") + "\n";
}

function diffDirectory(dir: string, json: boolean, out: string | undefined): number {
  const files = exportSetFiles(dir);
  // A set member with a snapshot but no file any more left the export after the snapshot (a library
  // export removed, a part an older plugin wrote): said, not silently dropped.
  const gone = exportSetCandidates(dir).filter((f) => { const snap = snapshotPath(f); return !fs.existsSync(f) && snap !== null && fs.existsSync(snap); });
  if (!files.length && !gone.length) { console.error(`design-diff: ${dir} holds no ${MERGED_VARIABLES_FILE}, design-system or library files — pass the export directory (the one with ${MERGED_VARIABLES_FILE}, ${DESIGN_SYSTEM_FILES.MANIFEST} and ${DESIGN_SYSTEM_DIR}/), or one file.`); return 2; }
  const d: DirDiffResult = { dir, results: [], notCompared: [] };
  const failed: string[] = [];
  const compared: string[] = [];
  let missing = 0;
  for (const file of files) {
    const r = readJson(file, anyJson);
    const c: Compared = "doc" in r ? compareFile(file, r.doc, undefined, process.cwd()) : { error: r.error };
    if ("error" in c) { failed.push(`design-diff: ${file}: ${c.error}`); d.notCompared.push({ file, reason: c.error }); }
    else if ("none" in c) { missing++; d.notCompared.push({ file, reason: `no snapshot and not committed in git — nothing older to compare against` }); }
    else {
      compared.push(file);
      // Every baseline is this same export: the file was not re-pulled (or was snapshotted after it was).
      if (c.same) d.notCompared.push({ file, reason: `the same export as ${c.result.against} — not re-pulled since it was snapshotted (or snapshotted after the re-pull)` });
      else d.results.push(c.result);
    }
  }
  for (const file of gone) d.notCompared.push({ file, reason: "in the snapshot, no longer in the export" });
  if (files.length && missing === files.length) { console.error(`design-diff: nothing to compare the files in ${dir} against — ${noBaselineHint(dir)}.`); return 2; }
  const text = json ? JSON.stringify(d, null, 2) + "\n" : directoryMarkdown(d);
  const wrote = writeReport(out, text, () => {
    const changed = d.results.filter((r) => changeCount(r)).length, warned = d.results.filter((r) => r.warnings.length).length;
    return `${d.results.length} file(s) compared, ${changed} changed, ${d.notCompared.length} not compared${warned ? ` — ${warned} with warning(s), read them` : ""}`;
  });
  if (!wrote) return 1;
  for (const file of compared) markDiffed(file, process.cwd());
  for (const line of failed) console.error(line); // the report names them too; the exit code says the set is incomplete
  return failed.length ? 2 : 0;
}

const isDirectory = (p: string): boolean => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

export function main(argv: string[]): number {
  const USAGE = `usage: ${scriptCmd("design-diff")} --snapshot <file.json | export dir>... [--force]\n       ${scriptCmd("design-diff")} <file.json> [--against <old.json>] [--json] [--out <file>]\n       ${scriptCmd("design-diff")} <export dir> [--json] [--out <file>]   (${MERGED_VARIABLES_FILE} + every design-system file present, one report)`;
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.error(USAGE); return argv.length ? 0 : 2; }
  const OPTIONS = { snapshot: { type: "boolean" }, against: { type: "string" }, out: { type: "string" }, json: { type: "boolean" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;
  const { values: flags, positionals } = cliParse("design-diff", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.snapshot) {
    const force = !!flags.force;
    const requested = positionals;
    if (!requested.length) { console.error(USAGE); return 2; }
    // A snapshot of ONE file (e.g. design-system/tokens.json, or a screen's own
    // <Screen>__<id>.json) is not a copy of the export it belongs to — no .vars.json, no
    // .assets.json, no pages/index.json, and for a design-system snapshot none of its other 9
    // sibling files, so a diff run later against it can't see a change that landed in a sibling (a
    // token that moved collection, an asset that changed) and the asset sidecar covered "36 of 39
    // entries" on a real run because assetPaths() only walks the tree, missing anything a sibling
    // file alone would have recorded. Snapshotting a file therefore also snapshots its whole sibling set:
    //   - a screen export -> its .vars.json, its OWN .assets.json (the real per-screen manifest,
    //     not the synthetic asset-hash sidecar this function writes below), and the pages/index.json
    //     it is indexed under (read-only evidence, never a diff target itself).
    //   - any of the 10 design-system/ files -> the other 9 (bridge/src/design-system-layout.ts is the
    //     one definition of that set, so this can never drift from what a --design-system pull
    //     actually writes).
    // An export directory is the set the directory diff reads: variables.json and every
    // design-system file present.
    // Each file to copy, and for a screen's own siblings (.vars.json, .assets.json, pages/index.json — never
    // diffed themselves) the screen whose decision they follow: they are replaced whenever it is.
    // Every other file is a diff target and decides for itself. A file met twice is copied once, as a
    // target if it is one anywhere ("./a.json" and "a.json" are one file).
    const entries = new Map<string, { file: string; follows?: string }>();
    const add = (file: string, follows?: string): void => {
      const key = path.resolve(file), had = entries.get(key);
      if (!had) entries.set(key, { file, ...ifDefined("follows", follows) });
      else if (had.follows !== undefined && follows === undefined) entries.set(key, { file: had.file });
    };
    for (const r of requested) {
      if (isDirectory(r)) { for (const f of exportSetFiles(r)) add(f); continue; }
      add(r);
      const screenSiblings = !DS_FILE_NAMES.includes(path.basename(r));
      for (const f of siblingFilesOf(r)) add(f, screenSiblings ? path.resolve(r) : undefined);
    }
    for (const r of requested) if (isDirectory(r) && !exportSetFiles(r).length) console.error(`design-diff: ${r} holds no ${MERGED_VARIABLES_FILE}, design-system or library files — nothing to snapshot there (first pull?)`);
    // A refusal, or a named file that is not there, must not exit 0 — indistinguishable, to a script, from every file being
    // snapshotted successfully. sync-design's own step 2 is meant to run unattended before a re-pull;
    // a refusal it can't see means the user finds out only later, when the diff is wrong.
    // A file under no project's design/ has no place for its snapshot: said once, before any file is copied.
    for (const { file: f } of entries.values()) {
      if (fs.existsSync(f) && snapshotPath(f) === null) { console.error(`design-diff: ${f} is not under a design/ directory that holds an export (looked above the file and above ${process.cwd()}) — run this from the project root, or name the file by its path inside design/export/`); return 2; }
    }
    let refused = 0, missing = 0;
    const refusedKeys = new Set<string>();
    for (const [key, { file: f, follows }] of entries) {
      if (!fs.existsSync(f)) { console.error(`design-diff: ${f} not found — nothing to snapshot (first pull?)`); missing++; continue; }
      const dest = snapshotPath(f);
      if (dest === null) continue; // refused above
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Non-destructive: a snapshot is the only copy older than the export once the re-pull lands, so a
      // snapshot that would CHANGE an existing one is refused — unless the old one is spent (a diff
      // already compared against it and the export is still the one it was compared with: the next
      // sync's step 2), or the caller says --force. A snapshot identical to what's already there is a
      // no-op, so re-running a step twice in a row does not complain.
      let identical = false;
      if (fs.existsSync(dest)) { try { identical = Buffer.compare(fs.readFileSync(dest), fs.readFileSync(f)) === 0; } catch { /* treat as different */ } }
      const replacing = fs.existsSync(dest) && !identical;
      const rel = path.relative(process.cwd(), dest), prevOf = (p: string): string => p + ".prev";
      let spent = false, demoted = false;
      if (identical && follows === undefined) {
        // The export IS the snapshot, so a mark left by the diff that used it is over and goes. History stays: a
        // `.prev` that diff compared against (a forced snapshot's) becomes a recovery copy like a spent one —
        // the sync may have been stopped before its report was applied — and one already marked is left alone.
        const mark = diffedHash(dest);
        if (mark !== null && fs.existsSync(prevOf(dest)) && !fs.existsSync(prevOf(dest) + DIFFED)) {
          try { fs.writeFileSync(prevOf(dest) + DIFFED, mark + "\n"); demoted = true; } catch { /* best effort: it stays a baseline */ }
        }
        fs.rmSync(dest + DIFFED, { force: true });
      }
      if (replacing) {
        spent = follows === undefined && isSpent(f, dest);
        if (follows !== undefined ? refusedKeys.has(follows) : !force && !spent) {
          if (follows === undefined) {
            const unreadable = readJson(dest, anyJson);
            const shared = path.basename(f) === MERGED_VARIABLES_FILE ? ` (every screen and design-system pull merges into ${MERGED_VARIABLES_FILE}, so a pull for another screen changes it too)` : "";
            console.error(!("doc" in unreadable)
              ? `design-diff: ${rel} ${unreadable.error} — there is nothing in it to protect, and no diff can use it: re-take it with --snapshot --force.`
              : diffedSince(f, dest)
              ? `design-diff: ${rel} was already diffed against an earlier export, and ${f} was re-pulled since${shared} — refusing to overwrite it. Run the diff now (its report lists the earlier sync's changes again), then snapshot again.`
              : `design-diff: ${rel} already exists, would change, and no diff has used it yet${shared} — refusing to overwrite it. Run the diff now, then snapshot again (--force replaces it without a diff, the old one is kept as .prev).`);
            refused++;
            refusedKeys.add(key);
          }
          continue;
        }
        // The old copy of a diff target is kept as `<name>.prev`, overwriting the one before. After a forced
        // replacement of a snapshot no diff has used it stays a baseline: previous() falls back to it when
        // that forced copy turns out to be the re-pulled export itself. A SPENT snapshot's copy carries its
        // `.diffed` as `.prev.diffed` — history that previous() never reads, there so a sync that was
        // abandoned after its diff can still be diffed against (--against). A screen's siblings (never
        // diffed) keep none, and drop an older one.
        const keepPrev = follows === undefined;
        for (const [from, to] of [[dest, prevOf(dest)], [dest + ".assets.json", prevOf(dest + ".assets.json")]] as const) {
          try { if (keepPrev && fs.existsSync(from)) fs.copyFileSync(from, to); else if (!keepPrev) fs.rmSync(to, { force: true }); } catch { /* best effort */ }
        }
        try { if (spent) fs.copyFileSync(dest + DIFFED, prevOf(dest) + DIFFED); else fs.rmSync(prevOf(dest) + DIFFED, { force: true }); } catch { /* best effort */ }
      }
      if (!identical) { fs.copyFileSync(f, dest); fs.rmSync(dest + DIFFED, { force: true }); }
      let n = 0;
      // Only a screen doc ({tree}/{nodes}) has asset paths worth hashing — a sibling like
      // pages/index.json or a .vars.json/.assets.json copy is JSON but has none, and would otherwise
      // get a spurious empty "<name>.assets.json" sidecar written beside its own real content.
      try {
        const parsed = readJsonOrNull(f, isScreen); // not a screen, or not JSON we understand: no sidecar
        if (parsed) {
          const h = assetHashes(f, parsed).hashes;
          n = Object.keys(h).length;
          fs.writeFileSync(dest + ".assets.json", JSON.stringify(h, null, 2) + "\n");
        }
      } catch { /* the sidecar could not be written — the copy is still the snapshot */ }
      console.log(`snapshot: ${f} -> ${path.relative(process.cwd(), dest)}${n ? ` (+ ${n} asset hash(es))` : ""}${identical ? " (unchanged)" : replacing ? " (replaced)" : ""}`);
      if (spent || demoted) console.log(`  the old snapshot (spent by the last diff) is kept as ${rel}.prev, never used as a baseline — if the last sync was stopped before its report was applied, diff against it: --against ${rel}.prev`);
    }
    return refused || missing ? 1 : 0; // a returned code, not exit(): main's caller sets process.exitCode so every already-printed line flushes first
  }
  const { against, out } = flags;
  const json = !!flags.json;
  const file = positionals[0];
  if (!file) { console.error(USAGE); return 2; }
  if (isDirectory(file)) {
    if (against) { console.error(`design-diff: --against takes one file — a directory diffs each file against its own snapshot or git HEAD copy.\n${USAGE}`); return 2; }
    return diffDirectory(file, json, out);
  }
  const current = readJsonFile(file, "export");
  const c = compareFile(file, current, against, process.cwd());
  if ("error" in c) { console.error(`design-diff: ${file}: ${c.error}`); return 2; }
  if ("none" in c) {
    console.error(`design-diff: nothing to compare ${file} against — ${noBaselineHint(file)}; for now pass --against <an older copy>.`);
    return 2;
  }
  const result = c.result;
  const text = json ? JSON.stringify(result, null, 2) + "\n" : markdown(result, `${file} vs ${result.against}`);
  if (!writeReport(out, text, () => `${JSON.stringify(result.summary)}${result.warnings.length ? ` — ${result.warnings.length} warning(s), read them` : ""}`)) return 1;
  if (!against) markDiffed(file, process.cwd());
  return 0;
}

if (import.meta.main) runCli(main, { name: "design-diff" }); // exitCode, never exit(): every printed line drains first (proc.ts)

export { diffScreens, diffTokens, diffCatalog, diffStyles, diffHygiene, diffManifest, diffDocs, markdown, directoryMarkdown, exportSetFiles, snapshotPath, previous, redrawnAssets, assetHashes };
