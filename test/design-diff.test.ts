// Offline tests for design-to-code/design-diff.ts (the sync-design skill's change list).
//   node test/design-diff.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { diffScreens, diffTokens, diffCatalog, diffStyles, diffHygiene, diffDocs, markdown, snapshotPath } from "../design-to-code/design-diff.ts";
import { check, report } from "./assert.ts";
import { malformed, manifest, must, parseAs, readFixture, tokens, variable } from "./fixtures.ts";
import type { DocGuard } from "../design-to-code/doc-guards.ts";
import { isTextStylesDoc } from "../design-to-code/doc-guards.ts";
// design-diff --json: the diff result; only its kind/summary/warnings/against/changed are read here.
const isDiffResult = (x: unknown): x is DiffResult => isJsonObject(x) && typeof x.kind === "string" && isJsonObject(x.summary) && Array.isArray(x.warnings);
import { DESIGN_SYSTEM_FILES } from "../bridge/src/design-system-layout.ts";
import { buildLibraryLayout, LIBRARY_FILE_NAMES } from "../bridge/src/library-layout.ts";
import { bag, isJsonObject } from "../design-to-code/types.ts";
import type {
  Box, CatalogComponent, DesignSystemManifest, DiffResult, DirDiffResult, EffectStylesDoc, HygieneDoc, IrNode, LayerFile, Manifest, Paint,
  StylesDoc, TokensDoc, Variable,
} from "../design-to-code/types.ts";

const CLI = path.join(import.meta.dirname, "..", "design-to-code", "design-diff.ts");
const clone = <T,>(o: T): T => structuredClone(o);
// The hand-built screen, as the checks below index into it: a page-walk layer file ({tree}) whose every
// node has a full box and whose root has children (the checks mutate them in place). Two test-local
// additions a real layer file does not carry: `exportedAt` (the freshness stamp the CLI's baseline choice
// reads) and, in one check, a root-level `flows` fact.
interface FxNode extends IrNode { box: Required<Box>; children?: FxNode[] }
interface FxScreen extends LayerFile { exportedAt: string; tree: FxNode & { children: FxNode[] }; manifest: Manifest; flows?: Array<{ name: string; startNodeId: string }> }
const screen = (): FxScreen => ({ name: "Login", id: "1:1", exportedAt: "2026-01-01", manifest: manifest({ nodes: 5 }), tree: { id: "1:1", name: "Login", type: "FRAME", box: { w: 390, h: 844, x: 0, y: 0 }, layout: { display: "flex", gap: 16 }, children: [
  { id: "1:2", name: "Title", type: "TEXT", text: "Welcome", font: { size: 24 }, widthMode: "hug", heightMode: "hug", box: { w: 120, h: 32, x: 24, y: 80 } },
  { id: "1:3", name: "Card", type: "FRAME", box: { w: 342, h: 200, x: 24, y: 128 }, fills: [{ type: "solid", color: "#ffffff" }], children: [
    { id: "1:4", name: "Label", type: "TEXT", text: "Email", widthMode: "hug", heightMode: "hug", box: { w: 40, h: 16, x: 40, y: 144 } }] },
  { id: "1:5", name: "Button", type: "INSTANCE", props: { Variant: "primary" }, box: { w: 342, h: 48, x: 24, y: 344 } },
] } });

console.log("screen diff:");
check("identical exports → nothing, even with a new exportedAt/manifest", (() => { const b = screen(); b.exportedAt = "2026-09-21"; b.manifest.nodes = 9; const s = diffScreens(screen(), b).summary; return s.added + s.removed + s.changed + must(s.reordered, "summary.reordered") + must(s.positionOnly, "summary.positionOnly") === 0; })());
check("a text edit is ONE change, categorised, with before → after", (() => {
  const b = screen(); must(b.tree.children[0], "b.tree.children[0]").text = "Welcome back";
  const d = diffScreens(screen(), b);
  const c0 = d.changed[0];
  return d.changed.length === 1 && c0?.id === "1:2" && c0?.categories[0] === "text" && c0?.fields[0]?.before === "Welcome" && c0?.fields[0]?.after === "Welcome back" && c0?.path === "Login > Title";
})());
check("inserting a row reports the row, NOT every node that moved down because of it", (() => {
  const b = screen();
  b.tree.children.splice(1, 0, { id: "9:9", name: "Banner", type: "FRAME", box: { w: 342, h: 40, x: 24, y: 128 }, children: [{ id: "9:10", name: "Banner text", type: "TEXT", text: "New", box: { w: 30, h: 16, x: 30, y: 140 } }] });
  const card = must(b.tree.children[2], "b.tree.children[2]");
  const cardChildren = must(card.children, "b.tree.children[2].children");
  const cardChild0 = must(cardChildren[0], "b.tree.children[2].children[0]");
  const sibling3 = must(b.tree.children[3], "b.tree.children[3]");
  for (const n of [card, cardChild0, sibling3]) n.box.y += 56;
  const d = diffScreens(screen(), b);
  return d.added.length === 1 && d.added[0]?.id === "9:9" && d.changed.length === 0 && d.summary.positionOnly === 3 && d.reordered.length === 0;
})());
check("removing a subtree reports its top-most node only", (() => { const b = screen(); b.tree.children.splice(1, 1); const d = diffScreens(screen(), b); return d.removed.length === 1 && d.removed[0]?.id === "1:3"; })());
check("a rename is a change on the same id, not delete + add", (() => {
  const b = screen(); must(b.tree.children[2], "b.tree.children[2]").name = "Submit";
  const d = diffScreens(screen(), b);
  return d.added.length === 0 && d.removed.length === 0 && d.changed[0]?.fields[0]?.field === "name";
})());
check("size counts on a FIXED node, not on a hug node (whose size only echoes its text)", (() => {
  const b = screen();
  must(b.tree.children[2], "b.tree.children[2]").box.h = 56;
  must(b.tree.children[0], "b.tree.children[0]").box.w = 180;
  const d = diffScreens(screen(), b);
  const c0 = d.changed[0];
  return d.changed.length === 1 && c0?.id === "1:5" && c0?.fields[0]?.field === "size" && c0?.fields[0]?.after === "342×56";
})());
check("reordered children and a variant swap are both caught", (() => {
  const b = screen(); b.tree.children.reverse();
  must(must(b.tree.children[0], "b.tree.children[0]").props, "b.tree.children[0].props").Variant = "secondary";
  const d = diffScreens(screen(), b);
  return d.reordered.length === 1 && d.reordered[0]?.after[0] === "Button" && d.changed.some((c) => c.id === "1:5" && c.categories.includes("component"));
})());
check("a sourceTransform change on an asset leaf is a `shape` change", (() => {
  const a = screen(), b = screen();
  must(a.tree.children[1], "a card").children = [{ id: "1:6", name: "chevron", type: "VECTOR", asset: "assets/chevron.svg", sourceTransform: { rotation: 90 }, box: { w: 18, h: 10 } }] as FxNode[];
  must(b.tree.children[1], "b card").children = [{ id: "1:6", name: "chevron", type: "VECTOR", asset: "assets/chevron.svg", sourceTransform: { rotation: 90, flipped: true }, box: { w: 18, h: 10 } }] as FxNode[];
  const f = diffScreens(a, b).changed.flatMap((c) => c.fields);
  return f.length === 1 && f[0]?.field === "sourceTransform.flipped" && f[0]?.category === "shape";
})());
check("assetFrom (a hidden node reusing a visible twin's file) is an `asset` change", (() => {
  const a = screen(), b = screen();
  must(a.tree.children[1], "a card").children = [{ id: "1:6", name: "chevron", type: "VECTOR", assetSkipped: "hidden", box: { w: 18, h: 10 } }] as FxNode[];
  must(b.tree.children[1], "b card").children = [{ id: "1:6", name: "chevron", type: "VECTOR", assetSkipped: "hidden", asset: "assets/twin.svg", assetFrom: "1:9", box: { w: 18, h: 10 } }] as FxNode[];
  const f = diffScreens(a, b).changed.flatMap((c) => c.fields);
  return f.some((x) => x.field === "assetFrom" && x.category === "asset") && f.every((x) => x.category === "asset");
})());
check("a node-level `scroll` change is a `layout` change (not `other`)", (() => {
  const b = screen(); must(b.tree.children[1], "b card").scroll = "vertical";
  const d = diffScreens(screen(), b);
  const f = d.changed.flatMap((c) => c.fields);
  return f.length === 1 && f[0]?.field === "scroll" && f[0]?.category === "layout" && d.changed[0]?.categories.join() === "layout";
})());
check("a {nodes:[…]} multi-root document is walked too", diffScreens({ nodes: [screen().tree] }, { nodes: [Object.assign(screen().tree, { opacity: 0.5 })] }).changed[0]?.fields[0]?.field === "opacity");
check("markdown: says so when nothing changed; lists fields when something did", /Nothing changed/.test(markdown(diffScreens(screen(), screen()), "x")) && (() => { const b = screen(); must(b.tree.children[0], "b.tree.children[0]").text = "Hi"; return /`text`: Welcome → Hi/.test(markdown(diffScreens(screen(), b), "x")); })());

console.log("screen diff — the exporter's format (an older plugin's noise):");
{
  // The same screen exported by an older plugin (-1 grid anchors on every node, `layout` on text/shape/asset
  // leaves) and by a newer one (none of them). Plus one asset leaf that carries a layout only in the old export.
  const withAsset = (): FxScreen => { const s = screen(); s.tree.children.push({ id: "1:6", name: "Icon", type: "VECTOR", asset: "assets/icon.svg", box: { w: 16, h: 16, x: 24, y: 400 } }); return s; };
  const inGrid = (s: FxScreen): FxScreen => { s.tree.layout = { display: "grid", columns: 2 }; return s; };
  const oldFormat = (): FxScreen => {
    const s = withAsset();
    const walk = (n: FxNode): void => {
      n.gridColumnStart = -1; n.gridRowStart = -1;
      if (n.type === "TEXT") n.layout = { mode: "absolute", width: n.box.w, height: n.box.h };
      if (n.id === "1:6") n.layout = { display: "flex", padding: [4, 4, 4, 4] };
      for (const k of n.children || []) walk(k);
    };
    walk(s.tree);
    return s;
  };
  const d = diffScreens(oldFormat(), withAsset());
  check("old-format export vs the same screen from a newer plugin: nothing changed, every node counted formatOnly",
    d.changed.length === 0 && d.summary.changed === 0 && d.summary.formatOnly === 6 && d.summary.positionOnly === 0);
  check("the warning names the exporter's format and the one-time reopen", d.warnings.length === 1 && /6 node\(s\) differ only by the exporter's format/.test(d.warnings[0] ?? "") && /re-run verify-screen --expect and --compare/.test(d.warnings[0] ?? ""));
  check("markdown: \"Nothing changed (… exporter's format …)\"", /Nothing changed \(6 node\(s\) differ only by the exporter's format\)\./.test(markdown(d, "x")));
  check("the other direction (new -> old) is format-only too", diffScreens(withAsset(), oldFormat()).summary.formatOnly === 6);
  check("two old-format exports of one unchanged screen: not format-only (nothing differs at all)", (() => { const r = diffScreens(oldFormat(), oldFormat()); return r.summary.formatOnly === 0 && r.changed.length === 0 && r.warnings.length === 0; })());
  check("a real text change under the noise is still exactly one change, and the rest stay format-only", (() => {
    const b = withAsset(); must(b.tree.children[0], "b.tree.children[0]").text = "Welcome back";
    const r = diffScreens(oldFormat(), b);
    return r.changed.length === 1 && r.changed[0]?.id === "1:2" && r.changed[0].fields.length === 1 && r.changed[0].fields[0]?.field === "text" && r.summary.formatOnly === 5;
  })());
  check("a grid child's anchor 1 -> 2 is a change (only -1 is noise)", (() => {
    const a = inGrid(withAsset()), b = inGrid(withAsset());
    must(a.tree.children[1], "a.tree.children[1]").gridColumnStart = 1;
    must(b.tree.children[1], "b.tree.children[1]").gridColumnStart = 2;
    const r = diffScreens(a, b);
    return r.changed.length === 1 && r.changed[0]?.id === "1:3" && r.changed[0].fields[0]?.field === "gridColumnStart" && r.changed[0].fields[0].before === "1" && r.changed[0].fields[0].after === "2";
  })());
  check("a container's real layout change still compares (only absolute-on-a-childless-type and asset-leaf layouts are noise)", (() => {
    const b = withAsset(); must(b.tree, "b.tree").layout = { display: "flex", gap: 24 };
    const r = diffScreens(withAsset(), b);
    return r.changed.length === 1 && r.changed[0]?.id === "1:1" && r.changed[0].fields[0]?.field === "layout.gap";
  })());
  check("a TEXT whose layout is not the bare absolute record keeps it as a difference", (() => {
    const a = withAsset(), b = withAsset();
    must(a.tree.children[0], "a.tree.children[0]").layout = { mode: "absolute", width: 120, height: 32 };
    must(b.tree.children[0], "b.tree.children[0]").layout = { display: "flex", gap: 4 };
    return diffScreens(a, b).changed.length === 1;
  })());
  // the normaliser decides as the plugin does — by the PARENT. Grid-child fields belong only to an
  // in-flow child of a grid; `layout` only to a container type (an allow-list: SLICE, STICKY, … are leaves).
  const gridKids = (s: FxScreen, extra: (n: FxNode) => void): FxScreen => { for (const k of s.tree.children) extra(k); return s; };
  check("an older plugin's gridAlignSelf/gridJustifySelf \"start\" (and spans) off a grid are format noise", (() => {
    const old = gridKids(screen(), (n) => { n.gridAlignSelf = "start"; n.gridJustifySelf = "start"; n.gridColumnSpan = 2; n.gridRowSpan = 2; });
    const r = diffScreens(old, screen());
    return r.changed.length === 0 && r.summary.formatOnly === 3 && r.warnings.length === 1;
  })());
  check("on an in-flow grid child the self-align and span still compare (absent -> set is a change)", (() => {
    const r = diffScreens(inGrid(screen()), inGrid(gridKids(screen(), (n) => { n.gridAlignSelf = "end"; n.gridColumnSpan = 2; })));
    return r.changed.length === 3 && r.changed.every((c) => c.fields.map((f) => f.field).join() === "gridAlignSelf,gridColumnSpan") && r.summary.formatOnly === 0;
  })());
  check("an in-flow grid child's -1 anchor is noise; its real anchor stays", (() => {
    const a = inGrid(gridKids(screen(), (n) => { n.gridColumnStart = -1; n.gridRowStart = 0; })), b = inGrid(gridKids(screen(), (n) => { n.gridRowStart = 0; }));
    const r = diffScreens(a, b), r2 = diffScreens(b, inGrid(gridKids(screen(), (n) => { n.gridRowStart = 1; })));
    return r.changed.length === 0 && r.summary.formatOnly === 3 && r2.changed.length === 3 && r2.changed[0]?.fields[0]?.field === "gridRowStart";
  })());
  check("an ABSOLUTE child of a grid is not a grid item: its anchors are noise", (() => {
    const a = inGrid(screen()), b = inGrid(screen());
    Object.assign(must(a.tree.children[1], "a card"), { absolute: true, gridColumnStart: 0, gridRowStart: 1, gridAlignSelf: "start" });
    must(b.tree.children[1], "b card").absolute = true;
    const r = diffScreens(a, b);
    return r.changed.length === 0 && r.summary.formatOnly === 1;
  })());
  check("a ROOT's grid fields are noise (its parent is not exported; an older plugin wrote a --node grid item's anchors)",
    (() => { const a = screen(); Object.assign(a.tree, { gridColumnStart: 2, gridRowStart: 0, gridColumnSpan: 2 }); const r = diffScreens(a, screen()); return r.changed.length === 0 && r.summary.formatOnly === 1; })());
  check("`layout` {mode:\"absolute\"} on STICKY / SLICE (no children in Figma) is noise; on a node WITH children it compares", (() => {
    const leaf = (type: string, w: number, lay: boolean): FxNode => ({ id: "9:" + type, name: type, type, box: { w, h: 40, x: 0, y: 0 }, ...(lay ? { layout: { mode: "absolute", width: w, height: 40 } } : {}) });
    const host = (lay: boolean, w: number): FxScreen => { const s = screen(); s.tree.children.push(leaf("STICKY", 240, lay), leaf("SLICE", 100, lay),
      { ...leaf("FUTURE_HOLDER", w, true), widthMode: "hug", children: [leaf("TEXT", 10, false)] }); return s; };
    const r = diffScreens(host(true, 50), host(false, 50)), r2 = diffScreens(host(false, 50), host(false, 80));
    return r.changed.length === 0 && r.summary.formatOnly === 2 && r2.changed.length === 1 && r2.changed[0]?.id === "9:FUTURE_HOLDER" && r2.changed[0].fields[0]?.field === "layout.width";
  })());
  check("a leaf's layout with more than the bare absolute record still compares", (() => {
    const a = screen(), b = screen();
    must(a.tree.children[0], "a title").layout = { mode: "absolute", width: 120, height: 32, inferred: true };
    return diffScreens(a, b).changed.length === 1;
  })());
  check("two OLD exports (noise on both sides) whose only raw difference sits in the noise: not formatOnly, no plugin warning", (() => {
    const hug = (w: number): FxScreen => { const s = screen(); s.tree.gridColumnStart = -1; s.tree.gridRowStart = -1;
      Object.assign(must(s.tree.children[0], "title"), { gridColumnStart: -1, gridRowStart: -1, box: { w, h: 32, x: 24, y: 80 }, layout: { mode: "absolute", width: w, height: 32 } }); return s; };
    const r = diffScreens(hug(80), hug(120));
    return r.summary.formatOnly === 0 && r.warnings.length === 0 && r.changed.length === 0 && r.summary.positionOnly === 1;
  })());
  check("--json carries summary.formatOnly", (() => { const r = diffScreens(oldFormat(), withAsset()); return JSON.stringify(r.summary).includes('"formatOnly":6'); })());
}

console.log("token diff:");
type FxTokens = TokensDoc & { variables: Variable[] };
const tok = (): FxTokens => ({ variables: [variable({ name: "color/primary", type: "COLOR", collection: "Theme", values: { Light: "#111111", Dark: { aliasOf: "blue/200" } } }), variable({ name: "space/md", type: "FLOAT", collection: "Space", values: { M: 16 } })] });
check("a value change names the token and the MODE that changed", (() => {
  const b = tok(); must(b.variables[0], "b.variables[0]").values.Dark = { aliasOf: "blue/300" }; b.variables.push(variable({ name: "space/lg", type: "FLOAT", values: { M: 24 } })); b.variables.splice(1, 1);
  const d = diffTokens(tok(), b);
  const c0 = d.changed[0];
  return d.changed.length === 1 && c0?.name === "color/primary" && c0?.modes.length === 1 && c0?.modes[0]?.mode === "Dark" && d.added[0] === "space/lg" && d.removed[0] === "space/md";
})());

console.log("CLI — snapshot, then diff after an in-place re-pull:");
check("snapshot → overwrite → diff finds the change; no snapshot and no git → exit 2 with the remedy", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-"));
  const rel = path.join("design", "pages", "home", "login.json");
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify(screen()));
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const none = run(rel);
  const snap = run("--snapshot", rel);
  const b = screen(); must(b.tree.children[0], "b.tree.children[0]").text = "Welcome back";
  fs.writeFileSync(path.join(root, rel), JSON.stringify(b));
  const d = run(rel, "--json");
  return none.status === 2 && /--snapshot/.test(none.stderr) && snap.status === 0 && fs.existsSync(path.join(root, "design", ".sync", "pages__home__login.json"))
    && (snapshotPath(rel, root) ?? "").endsWith("pages__home__login.json") && d.status === 0 && parseAs(d.stdout, isDiffResult, "design-diff --json").summary.changed === 1;
})());

// `--snapshot` used to be an unconditional fs.copyFileSync — running step 2 of the
// sync-design skill twice (once before each of two later re-pulls) silently replaced the FIRST
// baseline with whatever was on disk by the second call, which by then could already be a post-re-pull
// export. Non-destructive by default; --force is required to replace a baseline that would actually change.
console.log("CLI — --snapshot is non-destructive:");
check("a second --snapshot of DIFFERENT content is refused without --force, and the first baseline survives", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-force-"));
  const rel = path.join("design", "export", "design-system", "tokens.json");
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, rel), JSON.stringify({ variables: [{ name: "a", values: { M: 1 } }] }));
  const first = run("--snapshot", rel);
  const snapFile = must(snapshotPath(rel, root), "snapshotPath");
  const firstBytes = fs.readFileSync(snapFile, "utf8");
  // Simulate a re-pull that changed the export, then a MISTAKEN second `--snapshot` call (should have
  // been run BEFORE this re-pull, not after).
  fs.writeFileSync(path.join(root, rel), JSON.stringify({ variables: [{ name: "a", values: { M: 2 } }] }));
  const second = run("--snapshot", rel);
  const stillFirst = fs.readFileSync(snapFile, "utf8") === firstBytes;
  const forced = run("--snapshot", rel, "--force");
  const nowChanged = fs.readFileSync(snapFile, "utf8") !== firstBytes;
  const prevKept = fs.existsSync(snapFile + ".prev") && fs.readFileSync(snapFile + ".prev", "utf8") === firstBytes;
  // a refusal exits 1 — a script driving `--snapshot` (sync-design step 2) must be able
  // to see that it didn't get the baseline it asked for, not just a human reading stderr. It still
  // does not hard-fail the WHOLE `--snapshot a b c` batch just because one of several files needed
  // --force — every file is still attempted, and this is a single-file batch either way.
  return first.status === 0 && second.status === 1 && /refusing to overwrite/.test(second.stderr) && stillFirst && forced.status === 0 && nowChanged && prevKept;
})());
check("re-running --snapshot with UNCHANGED content is a silent no-op, not an error", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-force-noop-"));
  const rel = path.join("design", "export", "design-system", "tokens.json");
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify({ variables: [] }));
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const first = run("--snapshot", rel);
  const second = run("--snapshot", rel); // same bytes, no --force needed
  return first.status === 0 && second.status === 0 && /unchanged/.test(second.stdout);
})());

// a snapshot of ONE file is not a copy of the export it belongs to. --snapshot now also
// copies the sibling set: a design-system file's other 8 siblings (bridge/design-system-layout.js is
// the one definition of that 9-file set), and a screen's .vars.json/.assets.json plus the shared
// pages/index.json it is indexed under.
console.log("CLI — --snapshot copies the sibling set:");
check("snapshotting ONE design-system file also snapshots its 8 siblings", (() => {
  // the MANIFEST (design-system.json) lives at the export ROOT, one level ABOVE the
  // design-system/ subdirectory that holds the other 8 files (bridge/design-system-layout.js's own
  // header comment) — not flat alongside them, which is what this fixture used to (wrongly) assume.
  const names = Object.values<string>(DESIGN_SYSTEM_FILES).filter((v) => typeof v === "string" && /\.json$/.test(v));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-ds-siblings-"));
  const dsDir = path.join(root, "design", "export", "design-system");
  fs.mkdirSync(dsDir, { recursive: true });
  for (const n of names) {
    const at = n === DESIGN_SYSTEM_FILES.MANIFEST ? path.join(root, "design", "export", n) : path.join(dsDir, n);
    fs.writeFileSync(at, JSON.stringify({ file: n }));
  }
  const rel = path.join("design", "export", "design-system", "tokens.json");
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const r = run("--snapshot", rel);
  const syncDir = path.join(root, "design", ".sync");
  const gotAll = names.every((n) => {
    const flat = n === DESIGN_SYSTEM_FILES.MANIFEST ? "export__" + n : "export__design-system__" + n;
    return fs.existsSync(path.join(syncDir, flat));
  });
  return r.status === 0 && !/not found/.test(r.stderr) && gotAll;
})());
check("snapshotting a screen file also snapshots its .vars.json/.assets.json and pages/index.json", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-screen-siblings-"));
  const pageDir = path.join(root, "design", "export", "pages", "home");
  fs.mkdirSync(pageDir, { recursive: true });
  const stem = "Login__1_23";
  fs.writeFileSync(path.join(pageDir, stem + ".json"), JSON.stringify(screen()));
  fs.writeFileSync(path.join(pageDir, stem + ".vars.json"), JSON.stringify({ variables: [] }));
  fs.writeFileSync(path.join(pageDir, stem + ".assets.json"), JSON.stringify({ files: [] }));
  fs.writeFileSync(path.join(root, "design", "export", "pages", "index.json"), JSON.stringify({ pageDirs: [] }));
  const rel = path.join("design", "export", "pages", "home", stem + ".json");
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
  const r = run("--snapshot", rel);
  const syncDir = path.join(root, "design", ".sync");
  return r.status === 0
    && fs.existsSync(path.join(syncDir, "export__pages__home__" + stem + ".vars.json"))
    && fs.existsSync(path.join(syncDir, "export__pages__home__" + stem + ".assets.json"))
    && fs.existsSync(path.join(syncDir, "export__pages__index.json"));
})());

console.log("regressions from the 2026-09-21 execution audit:");
check("a change deep inside a long nested value names the LEAF — never two identical truncated blobs", (() => {
  const grad = (c: string): Paint[] => malformed<Paint[]>([{ type: "gradient", gradientType: "linear", angle: 90, opacity: 1, blendMode: "normal", visible: true, transform: [[1, 0, 0], [0, 1, 0]], stops: [{ pos: 0, color: "#112233ff" }, { pos: 0.25, color: "#223344ff" }, { pos: 0.5, color: "#445566ff" }, { pos: 0.75, color: "#556677ff" }, { pos: 1, color: c }] }]); // `gradientType`, no `kind`: not a producer paint, on purpose
  const a = screen(), b = screen(); must(a.tree.children[1], "a.tree.children[1]").fills = grad("#778899ff"); must(b.tree.children[1], "b.tree.children[1]").fills = grad("#ff0000ff");
  const f = must(diffScreens(a, b).changed[0], "changed[0]").fields;
  const f0 = f[0];
  return f.length === 1 && f0?.field === "fills[0].stops[4].color" && f0?.before === "#778899ff" && f0?.after === "#ff0000ff" && f0?.category === "paint";
})());
check("a variant swap is ONE change — the regenerated I…;… sublayers are counted on it, not listed as added/removed", (() => {
  const inst = (v: string, p: number) => { const s = screen(); Object.assign(must(s.tree.children[2], "s.tree.children[2]"), { mainComponent: { key: "k-" + v }, props: { Variant: v }, children: [{ id: `I1:5;${p}:1`, name: "Label", type: "TEXT", text: "Go" }, { id: `I1:5;${p}:2`, name: "Icon", type: "VECTOR" }] }); return s; };
  const d = diffScreens(inst("primary", 10), inst("secondary", 11));
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 1 && must(d.changed[0], "d.changed[0]").fields.some((f) => f.field === "sublayers" && /^2 /.test(String(f.before)) && /^2 /.test(String(f.after)));
})());
check("a truncated NEW export warns that removals may be false", (() => { const b = screen(); b.manifest.truncated = 2; b.tree.children.pop(); const d = diffScreens(screen(), b); return d.removed.length === 1 && d.warnings.length === 1 && /truncated/.test(markdown(d, "x")); })());
check("root-level facts beside the tree (a new prototype flow) are a change", (() => { const b = screen(); b.flows = [{ name: "Onboarding", startNodeId: "1:1" }]; const d = diffScreens(screen(), b); return d.summary.changed === 1 && d.document[0]?.field === "flows" && /Beside the tree/.test(markdown(d, "x")); })());
const anon = (): FxNode => malformed<FxNode>({ name: "anon" }); // deliberately id-less (and type-less)
check("children without ids don't crash the reorder report", (() => { const a = screen(), b = screen(); a.tree.children.push(anon()); b.tree.children.unshift(anon()); try { diffScreens(a, b); return true; } catch { return false; } })());
check("tokens: the same NAME in two collections is two tokens", (() => {
  const t = (v: number) => tokens({ variables: [{ name: "size/md", type: "FLOAT", collection: "Space", values: { M: v } }, { name: "size/md", type: "FLOAT", collection: "Type", values: { M: 14 } }] });
  const d = diffTokens(t(16), t(20));
  const c0 = d.changed[0];
  return d.changed.length === 1 && c0?.name === "Space / size/md" && c0?.modes[0]?.after === "20";
})());
check("tokens: a new MODE on a collection is reported", (() => {
  const t = (modes: string[]) => tokens({ collections: [{ name: "Theme", modes, default: "Light" }], variables: [] });
  const d = diffTokens(t(["Light", "Dark"]), t(["Light", "Dark", "High contrast"]));
  return d.summary.changed === 1 && d.collections[0]?.field === "Theme.modes[2]" && /Collections \/ modes/.test(markdown(d, "x"));
})());
check("catalog: removed / added components and a new variant option are all seen (it used to say 'Nothing changed')", (() => {
  const cat = (): { components: Array<CatalogComponent & { variantProps?: Record<string, string[]> }> } => ({ components: [{ key: "k1", id: "1:1", name: "Button", type: "COMPONENT_SET", page: "DS", variantProps: { State: ["default", "pressed"] } }, { key: "k2", id: "1:2", name: "Chip", type: "COMPONENT" }] });
  const b = cat();
  const b0 = must(b.components[0], "b.components[0]");
  b0.variantProps?.State?.push("loading"); b0.page = "Moved"; b.components.splice(1, 1); b.components.push({ key: "k3", id: "1:3", name: "Badge", type: "COMPONENT" });
  const d = diffDocs(cat(), b);
  if (d.kind !== "catalog") return false;
  const dc0 = d.changed[0];
  return d.removed[0]?.name === "Chip" && d.added[0]?.name === "Badge" && d.changed.length === 1 && dc0?.fields.length === 1 && dc0?.fields[0]?.field === "variantProps.State[2]" && /every built screen/.test(markdown(d, "x"));
})());
check("a catalog-sized catalog: dropping 3 components is 3 removals", (() => { const real: { components: Array<CatalogComponent & { variantProps?: Record<string, string[]> }> } = { components: Array.from({ length: 40 }, (_, i) => ({ key: "k" + i, id: "1:" + i, name: "Component " + i, type: i % 3 ? "COMPONENT" : "COMPONENT_SET", page: "DS", ...(i % 3 ? {} : { variantProps: { State: ["default", "pressed"] } }) })) }; const b = clone(real); b.components = b.components.slice(3); return diffCatalog(real, b).removed.length === 3; })());
check("[baseline] a baseline that is null / of another kind diffs as 'everything added' — never a TypeError", (() => {
  const now = tokens({ variables: [{ name: "a", type: "COLOR", values: { v: "#000000" } }] });
  try {
    const d1 = diffDocs(null, now), d2 = diffDocs({ components: [] }, now);
    return d1.kind === "tokens" && d1.summary.added === 1 && d2.kind === "tokens" && d2.summary.added === 1;
  } catch { return false; }
})());
check("[shape] a token file whose variable has no values is refused with the token-file shape, not diffed into a crash", (() => {
  try { diffDocs(null, { variables: [{ name: "a" }] }); return false; } catch (e) { return e instanceof Error && /is not a token catalog/.test(e.message) && !(e instanceof TypeError); }
})());
check("a file that is none of the three kinds is refused, not reported as unchanged", (() => { try { diffDocs({ a: 1 }, { a: 2 }); return false; } catch (e) { return e instanceof Error && /nothing here can be diffed/.test(e.message); } })());

console.log("CLI — baseline choice, asset bytes, flags:");
check("[shape] a corrupt snapshot is ONE line naming it (exit 2), not a SyntaxError stack", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-corrupt-"));
  fs.mkdirSync(path.join(root, "design", ".sync"), { recursive: true });
  fs.writeFileSync(path.join(root, "design", "login.json"), JSON.stringify(screen()));
  fs.writeFileSync(path.join(root, "design", ".sync", "login.json"), "{ truncated");
  const r = spawnSync(process.execPath, [CLI, "design/login.json"], { cwd: root, encoding: "utf8" });
  return r.status === 2 && r.stderr.includes(`the snapshot ${path.join("design", ".sync", "login.json")} is not valid JSON`) && !/\n {4}at /.test(r.stderr);
})());
check("[args] `--out --json` is '--out needs a value', not a diff written to a file named --json", (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-args-"));
  const r = spawnSync(process.execPath, [CLI, "x.json", "--out", "--json"], { cwd: root, encoding: "utf8" });
  return r.status === 2 && /design-diff: --out needs a value/.test(r.stderr) && !fs.existsSync(path.join(root, "--json"));
})());
const git = (root: string, ...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
const project = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-")); fs.mkdirSync(path.join(root, "design", "assets"), { recursive: true }); return root; };
const put = (root: string, text: string, at: string, extra?: Partial<IrNode>) => { const s = screen(); s.exportedAt = at; must(s.tree.children[0], "s.tree.children[0]").text = text; Object.assign(must(s.tree.children[2], "s.tree.children[2]"), extra || {}); fs.writeFileSync(path.join(root, "design", "login.json"), JSON.stringify(s)); };
type ScreenResult = Extract<DiffResult, { kind: "screen" }>;
const isScreenResult = (x: unknown): x is ScreenResult => isDiffResult(x) && x.kind === "screen";
const cli = (root: string, ...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: "utf8" });
check("a snapshot taken AFTER the re-pull is recognised as the same export; git HEAD is used instead", (() => {
  const root = project(); git(root, "init", "-q"); put(root, "v1", "2026-01-01T00:00:00Z"); git(root, "add", "-A"); git(root, "commit", "-qm", "v1");
  put(root, "v2", "2026-02-01T00:00:00Z"); cli(root, "--snapshot", "design/login.json");
  const d = parseAs(cli(root, "design/login.json", "--json").stdout, isDiffResult, "design-diff --json");
  return d.against === "git HEAD" && d.summary.changed === 1 && d.warnings.some((w) => /SAME export/.test(w));
})());
check("…and with no older copy anywhere it says so instead of a bare 'Nothing changed'", (() => {
  const root = project(); put(root, "v2", "2026-02-01T00:00:00Z"); cli(root, "--snapshot", "design/login.json");
  const r = cli(root, "design/login.json");
  return r.status === 0 && /no OLDER export/.test(r.stdout);
})());
check("a stale snapshot does not shadow a newer committed export (v1 snapshot, v2 HEAD, v3 on disk → v2 → v3)", (() => {
  const root = project(); git(root, "init", "-q"); put(root, "v1", "2026-01-01T00:00:00Z"); cli(root, "--snapshot", "design/login.json");
  put(root, "v2", "2026-02-01T00:00:00Z"); git(root, "add", "-A"); git(root, "commit", "-qm", "v2"); put(root, "v3", "2026-03-01T00:00:00Z");
  const d = parseAs(cli(root, "design/login.json", "--json").stdout, isScreenResult, "design-diff --json");
  const dc0 = d.changed[0]?.fields[0];
  return d.against === "git HEAD" && dc0?.before === "v2" && dc0?.after === "v3";
})());
check("a re-drawn icon (same node id, same path, different bytes) is a change", (() => {
  const root = project(); const icon = path.join(root, "design", "assets", "1_5.svg");
  fs.writeFileSync(icon, "<svg>old</svg>"); put(root, "v1", "2026-01-01T00:00:00Z", { asset: "assets/1_5.svg" });
  const snap = cli(root, "--snapshot", "design/login.json");
  fs.writeFileSync(icon, "<svg>new</svg>"); put(root, "v1", "2026-02-01T00:00:00Z", { asset: "assets/1_5.svg" });
  const d = parseAs(cli(root, "design/login.json", "--json").stdout, isScreenResult, "design-diff --json");
  const c0 = d.changed[0];
  return /1 asset hash/.test(snap.stdout) && d.summary.changed === 1 && c0?.fields[0]?.field === "asset bytes" && c0?.categories[0] === "asset";
})());
check("an unknown flag is an error, not a silently different command", (() => { const root = project(); put(root, "v1", "2026-01-01T00:00:00Z"); const r = cli(root, "design/login.json", "--agains", "x.json"); return r.status === 2 && /unknown flag --agains/.test(r.stderr); })());
check("a file of an unknown kind exits 2 with the reason", (() => { const root = project(); fs.writeFileSync(path.join(root, "a.json"), "{}"); fs.writeFileSync(path.join(root, "b.json"), "{}"); const r = cli(root, "a.json", "--against", "b.json"); return r.status === 2 && /nothing here can be diffed/.test(r.stderr); })());

// ---------------------------------------------------------------- style + hygiene diffs
// The export-directory diff (sync-design) reads EVERY design-system file a --design-system pull writes,
// including the four styles.*.json and hygiene.json — and all five used to exit 2 with "nothing here
// can be diffed", so a typography-only or effect-only design-system change (or a new/resolved hygiene
// warning) was exactly as undetectable as the skill warns it would be without them. Fixtures are the
// REAL design-system files from a real export (test/fixtures/livetest4/design-system/).
console.log("style + hygiene diffs (real design-system fixtures):");
const FIX_DS = path.join(import.meta.dirname, "fixtures", "livetest4", "design-system");
// Real design-system files this repo's exporter wrote — checked against the guard for their kind.
const readFix = <T,>(n: string, guard: DocGuard<T>): T => readFixture(path.join(FIX_DS, n), guard);
const isStyleSheet = (x: unknown): x is StylesDoc & EffectStylesDoc => isJsonObject(x) && Array.isArray(x.styles) && x.styles.every((st) => isJsonObject(st) && typeof st.name === "string");
const isHygieneDoc = (x: unknown): x is HygieneDoc => isJsonObject(x) && Array.isArray(x.hygiene) && x.hygiene.every((h) => typeof h === "string");
const isDsManifest = (x: unknown): x is DesignSystemManifest => isJsonObject(x) && isJsonObject(x.files) && isJsonObject(x.counts);
check("styles.text.json: a real design-system file is recognised and diffs cleanly (isStyles)", (() => {
  const a = readFix("styles.text.json", isTextStylesDoc), b = clone(a);
  const d = diffDocs(a, b);
  return d.kind === "styles" && d.summary.added === 0 && d.summary.removed === 0 && d.summary.changed === 0;
})());
check("styles.text.json: a changed field on an existing style is reported, keyed by style key", (() => {
  const a = readFix("styles.text.json", isTextStylesDoc), b = clone(a);
  const style0 = must(b.styles[0], "b.styles[0]");
  style0.size = must(style0.size, "b.styles[0].size") + 8;
  const d = diffStyles(a, b);
  return d.summary.changed === 1 && d.changed[0]?.key === a.styles[0]?.key && (d.changed[0]?.fields.some((f) => f.field === "size") ?? false);
})());
check("styles.text.json: a removed style and an added one are both seen", (() => {
  const a = readFix("styles.text.json", isTextStylesDoc), b = clone(a);
  const removedName = b.styles.pop()?.name;
  b.styles.push({ name: "Brand New Style", size: 12, font: "Poppins", weight: "Regular", key: "brandnewkey123", id: "S:brandnewkey123," });
  const d = diffStyles(a, b);
  return d.removed.length === 1 && d.removed[0]?.name === removedName && d.added.length === 1 && d.added[0]?.name === "Brand New Style";
})());
check("styles.effect.json: an effect array change is a field diff, not a blob", (() => {
  const a = readFix("styles.effect.json", isStyleSheet), b = clone(a);
  const effects = must(must(b.styles[0], "b.styles[0]").effects, "b.styles[0].effects");
  bag(must(effects[0], "effects[0]")).radius = 999;
  const d = diffStyles(a, b);
  return d.summary.changed === 1 && (d.changed[0]?.fields.some((f) => /effects/.test(f.field)) ?? false);
})());
check("styles.paint.json / styles.grid.json (empty `styles: []` in this real export): recognised, 'Nothing changed'", (() => {
  const paint = readFix("styles.paint.json", isStyleSheet), grid = readFix("styles.grid.json", isStyleSheet);
  const dp = diffDocs(paint, clone(paint)), dg = diffDocs(grid, clone(grid));
  return dp.kind === "styles" && /Nothing changed/.test(markdown(dp, "x")) && dg.kind === "styles" && /Nothing changed/.test(markdown(dg, "x"));
})());
check("hygiene.json: a real hygiene file is recognised (isHygiene) and 'nothing changed' when identical", (() => {
  const a = readFix("hygiene.json", isHygieneDoc);
  const d = diffDocs(a, clone(a));
  return d.kind === "hygiene" && d.summary.added === 0 && d.summary.removed === 0;
})());
check("hygiene.json: a new warning line is 'added', a resolved one is 'removed' — order doesn't matter", (() => {
  const a = readFix("hygiene.json", isHygieneDoc), b = clone(a);
  const resolved = b.hygiene.shift(); // the first line is no longer a problem
  b.hygiene.push("ALL_SCOPES on 'Brand New Variable' (pollutes every picker)"); // a new one appeared
  b.hygiene.reverse(); // order is not meaningful — must not read as N changes
  const d = diffHygiene(a, b);
  return d.added.length === 1 && (d.added[0]?.includes("Brand New Variable") ?? false) && d.removed.length === 1 && d.removed[0] === resolved;
})());
check("markdown renders styles/hygiene kinds without throwing, and names the right sections", (() => {
  const a = readFix("styles.text.json", isTextStylesDoc), b = clone(a);
  const style0 = must(b.styles[0], "b.styles[0]");
  style0.size = must(style0.size, "b.styles[0].size") + 1;
  const md1 = markdown(diffStyles(a, b), "styles.text.json");
  const h = readFix("hygiene.json", isHygieneDoc), hb = clone(h); hb.hygiene.push("new line");
  const md2 = markdown(diffHygiene(h, hb), "hygiene.json");
  return /Styles changed/.test(md1) && /New warning/.test(md2);
})());
check("CLI end to end: ALL NINE design-system files diff one by one on the real fixtures (incl. the manifest)", (() => {
  const root = project();
  const dsDir = path.join(root, "design", "export", "design-system");
  fs.mkdirSync(dsDir, { recursive: true });
  // The 8 files that live INSIDE design-system/ (bridge/design-system-layout.js's DESIGN_SYSTEM_FILES,
  // minus the manifest, which lives one level up). tokens.json/components.*.json aren't
  // in the trimmed real-fixture set (tokens.json is already covered by the tokens tests above,
  // components.*.json by the catalog tests) — minimal stand-ins are enough here, since this check is
  // about ALL NINE names resolving and diffing, not re-proving each format's own logic again.
  const inDsDir = ["tokens.json", "styles.text.json", "styles.paint.json", "styles.effect.json", "styles.grid.json", "components.local.json", "components.library.json", "hygiene.json"];
  fs.writeFileSync(path.join(dsDir, "tokens.json"), JSON.stringify({ variables: [] }));
  fs.writeFileSync(path.join(dsDir, "components.local.json"), JSON.stringify({ components: [] }));
  fs.writeFileSync(path.join(dsDir, "components.library.json"), JSON.stringify({ components: [] }));
  for (const f of ["styles.text.json", "styles.paint.json", "styles.effect.json", "styles.grid.json", "hygiene.json"]) {
    fs.writeFileSync(path.join(dsDir, f), fs.readFileSync(path.join(FIX_DS, f)));
  }
  // The manifest (design-system.json) at the export ROOT — real fixture, from the same export.
  fs.writeFileSync(path.join(root, "design", "export", "design-system.json"), fs.readFileSync(path.join(import.meta.dirname, "fixtures", "livetest4", "design-system.json")));
  const allNine = [...inDsDir.map((f) => path.join("design", "export", "design-system", f)), path.join("design", "export", "design-system.json")];

  let allOk = true;
  for (const rel of allNine) {
    const r = cli(root, rel);
    if (r.status !== 0 && !(r.status === 2 && /no snapshot/.test(r.stderr))) allOk = false; // first run has no baseline yet — that's a separate, already-tested exit 2
  }
  // Snapshot ONLY the manifest (mirrors a real repro: "on a copy of a real export,
  // after --snapshot of all nine files") — siblingFilesOf() must pull in the other 8 on its own, and
  // must never print a spurious "not found" for any of them, since every one of them is
  // right there on disk.
  const snap = cli(root, "--snapshot", path.join("design", "export", "design-system.json"));
  const spuriousNotFound = /not found — nothing to snapshot/.test(snap.stderr);

  let allDiffOk = true;
  for (const rel of allNine) {
    const r = cli(root, rel);
    if (r.status !== 0) allDiffOk = false;
  }
  return allOk && snap.status === 0 && !spuriousNotFound && allDiffOk;
})());
check("diffManifest: a counts/files change is a keyed field diff, exportedAt is ignored", (() => {
  const a = readFixture(path.join(import.meta.dirname, "fixtures", "livetest4", "design-system.json"), isDsManifest);
  const b = clone(a);
  b.exportedAt = "2099-01-01T00:00:00Z"; // must NOT show up as a change on its own
  b.counts.hygiene = a.counts.hygiene + 3;
  const d = diffDocs(a, b);
  return d.kind === "manifest" && d.summary.changed === 1 && d.fields.length === 1 && d.fields[0]?.field === "counts.hygiene";
})());

// ---------------------------------------------------------------- export-directory mode
// `design-diff <export dir>` diffs variables.json, every design-system file and every library export
// present as one report, and `--snapshot <export dir>` snapshots that same set.
console.log("CLI — an export directory:");
// A partial export: variables.json, tokens.json, styles.text.json and hygiene.json — no manifest, no
// other design-system part (a screen-only project, or an export from an older plugin).
const dirProject = (): { root: string; exp: string } => {
  const root = project(), exp = path.join(root, "design", "export"), ds = path.join(exp, "design-system");
  fs.mkdirSync(ds, { recursive: true });
  const at = "2026-01-01T00:00:00Z";
  fs.writeFileSync(path.join(exp, "variables.json"), JSON.stringify(tokens({ exportedAt: at, variables: [{ name: "brand", type: "COLOR", values: { Light: "#111111" } }] })));
  fs.writeFileSync(path.join(ds, "tokens.json"), JSON.stringify(tokens({ exportedAt: at, variables: [{ name: "space/md", type: "FLOAT", values: { M: 16 } }] })));
  fs.writeFileSync(path.join(ds, "styles.text.json"), JSON.stringify({ exportedAt: at, ...readFix("styles.text.json", isTextStylesDoc) }));
  fs.writeFileSync(path.join(ds, "hygiene.json"), JSON.stringify({ exportedAt: at, hygiene: ["first warning"] }));
  return { root, exp: path.join("design", "export") };
};
const rewrite = (root: string, rel: string, edit: (doc: Record<string, unknown>) => void): void => {
  const f = path.join(root, rel), raw: unknown = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!isJsonObject(raw)) throw new Error(`${rel} is not a JSON object`);
  edit(raw); fs.writeFileSync(f, JSON.stringify(raw));
};
const isDirResult = (x: unknown): x is DirDiffResult => isJsonObject(x) && typeof x.dir === "string" && Array.isArray(x.results) && x.results.every(isDiffResult) && Array.isArray(x.notCompared);
check("--snapshot <export dir> copies variables.json and every design-system file present, and says nothing about the absent ones", (() => {
  const { root, exp } = dirProject();
  const r = cli(root, "--snapshot", exp);
  const sync = path.join(root, "design", ".sync");
  const got = fs.readdirSync(sync).sort().join(",");
  return r.status === 0 && r.stderr === "" && got === "export__design-system__hygiene.json,export__design-system__styles.text.json,export__design-system__tokens.json,export__variables.json";
})());
check("--snapshot of ONE design-system file in a partial export prints no 'not found' for a sibling that is not there", (() => {
  const { root } = dirProject();
  const r = cli(root, "--snapshot", path.join("design", "export", "design-system", "tokens.json"));
  return r.status === 0 && !/not found/.test(r.stderr) && /styles\.text\.json/.test(r.stdout) && /hygiene\.json/.test(r.stdout);
})());
check("a file named twice (a file AND its export dir, `./x` and `x`) is snapshotted once", (() => {
  const { root, exp } = dirProject();
  const r = cli(root, "--snapshot", "." + path.sep + path.join(exp, "design-system", "tokens.json"), exp);
  const lines = r.stdout.trim().split("\n");
  return r.status === 0 && lines.length === 4 && lines.filter((l) => /tokens\.json ->/.test(l)).length === 1;
})());
check("a file the caller NAMES that is not there is still reported, and the exit is 1 (no snapshot was taken of it)", (() => {
  const { root } = dirProject();
  const r = cli(root, "--snapshot", path.join("design", "export", "design-system", "styles.grid.json"));
  return r.status === 1 && /styles\.grid\.json not found/.test(r.stderr);
})());
check("<export dir> diff: one report — a section per changed file, one line for the unchanged, a file not re-pulled is 'not compared' with the reason", (() => {
  const { root, exp } = dirProject();
  cli(root, "--snapshot", exp);
  const later = "2026-02-01T00:00:00Z";
  rewrite(root, path.join(exp, "variables.json"), (d) => { d.exportedAt = later; d.variables = [variable({ name: "brand", type: "COLOR", values: { Light: "#222222" } })]; });
  rewrite(root, path.join(exp, "design-system", "hygiene.json"), (d) => { d.exportedAt = later; d.hygiene = ["first warning", "a new warning"]; });
  rewrite(root, path.join(exp, "design-system", "tokens.json"), (d) => { d.exportedAt = later; }); // re-pulled, nothing changed
  // styles.text.json is left as snapshotted: the design system's styles were not re-pulled
  const out = path.join("design", "changes", "shared.md");
  const r = cli(root, exp, "--out", out);
  const md = fs.readFileSync(path.join(root, out), "utf8");
  const j = parseAs(cli(root, exp, "--json").stdout, isDirResult, "design-diff <dir> --json");
  return r.status === 0 && /2 changed/.test(r.stdout)
    && md.startsWith(`# What changed — ${exp}\n`)
    && /^## What changed — .*variables\.json vs /m.test(md) && /^### Token values changed/m.test(md) && /#111111 → #222222/.test(md)
    && /^### New warning\(s\)/m.test(md) && /a new warning/.test(md)
    && /^Nothing changed: `[^`]*tokens\.json`\.$/m.test(md)
    && /^## Not compared\n- `[^`]*styles\.text\.json`: the same export as /m.test(md)
    && j.results.length === 3 && j.notCompared.length === 1 && j.results.filter((x) => x.summary.changed + x.summary.added).length === 2;
})());
check("<export dir> diff with no baseline for any file exits 2 with the --snapshot hint, and writes nothing", (() => {
  const { root, exp } = dirProject();
  const out = path.join(root, "design", "changes", "shared.md");
  const r = cli(root, exp, "--out", out);
  return r.status === 2 && /--snapshot design[\\/]export` BEFORE re-pulling/.test(r.stderr) && !fs.existsSync(out);
})());
check("<export dir> diff: a file that cannot be read is named in the report and on stderr, and the exit is 2", (() => {
  const { root, exp } = dirProject();
  cli(root, "--snapshot", exp);
  fs.writeFileSync(path.join(root, exp, "design-system", "hygiene.json"), "{ truncated");
  const r = cli(root, exp);
  return r.status === 2 && /hygiene\.json: .*not valid JSON/.test(r.stderr) && /^## Not compared\n(- .*\n)*- `[^`]*hygiene\.json`: .*not valid JSON/m.test(r.stdout);
})());
check("<export dir> refuses --against, and a directory with none of the files is said, not reported as unchanged", (() => {
  const { root, exp } = dirProject();
  const a = cli(root, exp, "--against", "x.json");
  const empty = cli(root, path.join("design", "assets"));
  return a.status === 2 && /--against takes one file/.test(a.stderr) && empty.status === 2 && /holds no variables\.json, design-system or library files/.test(empty.stderr);
})());


// Two syncs in a row: the second sync's step 2 must replace the snapshot the first sync's diff used
// (no --force), so the second diff lists only the second change.
console.log("CLI — a second sync:");
const LOGIN = path.join("design", "export", "pages", "home", "Login__1_1.json");
const putScreen = (root: string, text: string, at: string): void => {
  const s = screen(); s.exportedAt = at; must(s.tree.children[0], "s.tree.children[0]").text = text;
  fs.mkdirSync(path.join(root, "design", "export", "pages", "home"), { recursive: true });
  fs.writeFileSync(path.join(root, LOGIN), JSON.stringify(s));
  fs.writeFileSync(path.join(root, LOGIN.replace(/\.json$/, ".vars.json")), JSON.stringify({ exportedAt: at, variables: [] }));
  fs.writeFileSync(path.join(root, "design", "export", "pages", "index.json"), JSON.stringify({ generatedAt: at, pageDirs: [] })); // rewritten by every pull
};
check("a screen synced twice: step 2 replaces the spent snapshot (and its siblings) without --force, and the 2nd diff shows only the 2nd change", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  const s1 = cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  const d1 = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  const s2 = cli(root, "--snapshot", LOGIN);
  putScreen(root, "v3", "2026-03-01T00:00:00Z");
  const d2 = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  const f1 = d1.changed[0]?.fields[0], f2 = d2.changed[0]?.fields[0];
  return s1.status === 0 && s2.status === 0 && !/refusing/.test(s2.stderr) && (s2.stdout.match(/replaced/g) ?? []).length === 3
    && f1?.before === "v1" && f1?.after === "v2" && d2.changed.length === 1 && f2?.before === "v2" && f2?.after === "v3" && !d2.warned;
})());
check("…but a snapshot whose export was re-pulled AGAIN after the diff still refuses without --force (that copy is the only older one)", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, LOGIN);
  putScreen(root, "v3", "2026-03-01T00:00:00Z"); // re-pulled before step 2
  const s2 = cli(root, "--snapshot", LOGIN);
  return s2.status === 1 && /refusing to overwrite/.test(s2.stderr) && !/index\.json ->/.test(s2.stdout);
})());
check("…and a new snapshot is unspent: its old spent mark does not carry over (a --force snapshot, then the export reverts to the diffed bytes)", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, LOGIN); // spends the v1 snapshot against v2
  const v2 = fs.readFileSync(path.join(root, LOGIN));
  putScreen(root, "v3", "2026-03-01T00:00:00Z");
  cli(root, "--snapshot", "--force", LOGIN); // the snapshot is now v3, never diffed
  fs.writeFileSync(path.join(root, LOGIN), v2);
  const s = cli(root, "--snapshot", LOGIN);
  return s.status === 1 && /refusing to overwrite/.test(s.stderr);
})());
check("…and a --against diff does not spend the snapshot", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  fs.copyFileSync(path.join(root, LOGIN), path.join(root, "old.json"));
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, LOGIN, "--against", "old.json");
  const s2 = cli(root, "--snapshot", LOGIN);
  return s2.status === 1 && /refusing to overwrite/.test(s2.stderr);
})());
check("an export directory synced twice: the 2nd report lists only the 2nd change, not the 1st again", (() => {
  const { root, exp } = dirProject();
  cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "design-system", "tokens.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.variables = [variable({ name: "space/md", type: "FLOAT", values: { M: 20 } })]; });
  rewrite(root, path.join(exp, "design-system", "styles.text.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.styles = []; });
  const first = cli(root, exp).stdout;
  const s2 = cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "design-system", "tokens.json"), (d) => { d.exportedAt = "2026-03-01T00:00:00Z"; d.variables = [variable({ name: "space/md", type: "FLOAT", values: { M: 24 } })]; });
  rewrite(root, path.join(exp, "design-system", "styles.text.json"), (d) => { d.exportedAt = "2026-03-01T00:00:00Z"; });
  const second = cli(root, exp).stdout;
  return /M: 16 → 20/.test(first) && /Styles removed/.test(first) && s2.status === 0 && !/refusing/.test(s2.stderr)
    && /M: 20 → 24/.test(second) && !/16/.test(second) && !/Styles removed/.test(second) && /^Nothing changed: .*styles\.text\.json/m.test(second);
})());

console.log("CLI — an export directory, edges:");
check("a set member in the snapshot that left the export is 'Not compared', not dropped", (() => {
  const { root, exp } = dirProject();
  cli(root, "--snapshot", exp);
  fs.rmSync(path.join(root, exp, "design-system", "hygiene.json"));
  const r = cli(root, exp);
  return r.status === 0 && /^- `[^`]*hygiene\.json`: in the snapshot, no longer in the export$/m.test(r.stdout);
})());
check("LIBRARY_FILE_NAMES is exactly the file set buildLibraryLayout writes", (() => {
  const names = buildLibraryLayout({ file: "Lib", source: { role: "library", libraryName: "Lib", fileKey: "abcdefgh123" } }, "/").files.map((f) => path.basename(f.path));
  return JSON.stringify(names) === JSON.stringify(LIBRARY_FILE_NAMES);
})());
check("an --as-library export (libraries/<dir>/) is part of the export directory's set — snapshotted and diffed; libraries/index.json is not", (() => {
  const { root, exp } = dirProject();
  const lib = path.join(root, exp, "libraries", "lib-abcdefgh");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "tokens.json"), JSON.stringify(tokens({ exportedAt: "2026-01-01T00:00:00Z", variables: [{ name: "radius", type: "FLOAT", values: { M: 4 } }] })));
  fs.writeFileSync(path.join(root, exp, "libraries", "index.json"), JSON.stringify({ libraries: [], generatedAt: "x" }));
  const s = cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "libraries", "lib-abcdefgh", "tokens.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.variables = [variable({ name: "radius", type: "FLOAT", values: { M: 8 } })]; });
  const r = cli(root, exp);
  return s.status === 0 && fs.existsSync(path.join(root, "design", ".sync", "export__libraries__lib-abcdefgh__tokens.json")) && !/libraries[\\/]index\.json/.test(s.stdout)
    && r.status === 0 && /^## What changed — .*lib-abcdefgh[\\/]tokens\.json vs /m.test(r.stdout) && /M: 4 → 8/.test(r.stdout);
})());
check("the report has no doubled blank lines, and files unchanged against git HEAD (each snapshot the same export) fold into one line", (() => {
  const { root, exp } = dirProject();
  git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "v1");
  for (const f of ["tokens.json", "hygiene.json"]) rewrite(root, path.join(exp, "design-system", f), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; });
  rewrite(root, path.join(exp, "variables.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.variables = [variable({ name: "brand", type: "COLOR", values: { Light: "#222222" } })]; });
  cli(root, "--snapshot", exp); // taken AFTER the re-pull
  const md = cli(root, exp).stdout;
  return !/\n\n\n/.test(md) && /^Nothing changed against an older copy .*tokens\.json` \(vs git HEAD\), `[^`]*hygiene\.json` \(vs git HEAD\)\.$/m.test(md)
    && (md.match(/^## What changed — /gm) ?? []).length === 1 && /#111111 → #222222/.test(md);
})());


console.log("CLI — where the snapshot lands:");
check("an absolute path through a symlinked directory finds the same snapshot (real paths on both sides)", (() => {
  const root = project();
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-link-")), "proj");
  fs.symlinkSync(root, link, "junction"); // a junction needs no privilege on Windows; elsewhere the type is ignored
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  const viaLink = path.join(link, LOGIN);
  const s = cli(root, "--snapshot", viaLink);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  const d = cli(root, viaLink, "--json");
  return s.status === 0 && fs.existsSync(path.join(root, "design", ".sync", "export__pages__home__Login__1_1.json"))
    && d.status === 0 && parseAs(d.stdout, isScreenResult, "design-diff --json").baseline === "snapshot";
})());
check("run from inside design/, a snapshot still lands in <project>/design/.sync/ (not design/design/.sync/) and a diff from the root finds it", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  const s = cli(path.join(root, "design"), "--snapshot", path.join("export", "pages", "home", "Login__1_1.json"));
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  const d = cli(root, LOGIN, "--json");
  return s.status === 0 && !fs.existsSync(path.join(root, "design", "design")) && fs.existsSync(path.join(root, "design", ".sync", "export__pages__home__Login__1_1.json"))
    && parseAs(d.stdout, isScreenResult, "design-diff --json").baseline === "snapshot";
})());


console.log("CLI — a second sync, more:");
check("a file changed in sync 1 and NOT re-pulled in sync 2 is 'not re-pulled' in the 2nd report — the spent snapshot's recovery copy is not a baseline to re-report it from", (() => {
  const { root, exp } = dirProject();
  cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "design-system", "styles.text.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.styles = []; });
  cli(root, exp);
  const s2 = cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "variables.json"), (d) => { d.exportedAt = "2026-03-01T00:00:00Z"; d.variables = [variable({ name: "brand", type: "COLOR", values: { Light: "#333333" } })]; }); // only this is re-pulled
  const second = cli(root, exp).stdout;
  const sync = fs.readdirSync(path.join(root, "design", ".sync"));
  const prevs = sync.filter((f) => /\.json\.prev$/.test(f));
  return s2.status === 0 && prevs.length > 0 && prevs.every((f) => sync.includes(f + ".diffed")) && !/Styles removed/.test(second) && !/\.prev/.test(second)
    && /^- `[^`]*styles\.text\.json`: the same export as .* not re-pulled/m.test(second) && /#111111 → #333333/.test(second);
})());
check("replacing a spent snapshot keeps it as .prev over the one an earlier --force left, and that copy never resurfaces as a baseline", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, "--snapshot", "--force", LOGIN); // .prev = v1, a baseline (no diff had used it)
  putScreen(root, "v3", "2026-03-01T00:00:00Z");
  cli(root, LOGIN); // spends the v2 snapshot
  const s = cli(root, "--snapshot", LOGIN);
  putScreen(root, "v4", "2026-04-01T00:00:00Z");
  const d = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  const prev = path.join(root, "design", ".sync", "export__pages__home__Login__1_1.json.prev");
  return s.status === 0 && fs.readFileSync(prev, "utf8").includes('"v2"') && fs.existsSync(prev + ".diffed") && !d.warned && d.changed[0]?.fields[0]?.before === "v3";
})());
check("re-pulled OUTSIDE a sync (spent at E1, now E2): step 2 says it was already diffed and re-pulled since, and the diff warns that the earlier sync's changes are listed again", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, LOGIN);
  putScreen(root, "v3", "2026-03-01T00:00:00Z");
  const s = cli(root, "--snapshot", LOGIN);
  const d = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  return s.status === 1 && /already diffed against an earlier export, and .* was re-pulled since/.test(s.stderr) && !/no diff has used it yet/.test(s.stderr)
    && d.warnings.some((w) => /already diffed against an earlier export .* including changes the earlier sync already applied/.test(w));
})());
check("a report that cannot be written is one line (exit 1, no stack) and spends nothing", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  const vars = path.join(root, "design", "export", "variables.json");
  fs.writeFileSync(vars, JSON.stringify(tokens({ exportedAt: "2026-01-01T00:00:00Z", variables: [] })));
  cli(root, "--snapshot", LOGIN, path.join("design", "export"));
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  fs.writeFileSync(vars, JSON.stringify(tokens({ exportedAt: "2026-02-01T00:00:00Z", variables: [] })));
  fs.mkdirSync(path.join(root, "design", "changes", "login.md"), { recursive: true }); // a directory where the report goes
  const r = cli(root, LOGIN, "--out", path.join("design", "changes", "login.md"));
  const dr = cli(root, path.join("design", "export"), "--out", path.join("design", "changes", "login.md"));
  const marks = fs.readdirSync(path.join(root, "design", ".sync")).filter((f) => f.endsWith(".diffed"));
  return r.status === 1 && /^design-diff: cannot write .*login\.md: /m.test(r.stderr) && !/\n {4}at /.test(r.stderr)
    && dr.status === 1 && /cannot write/.test(dr.stderr) && marks.length === 0;
})());
check("a symlinked design/export holding a library: snapshot names keep their path (design-system/ and libraries/<dir>/ tokens.json do not collide)", (() => {
  const { root, exp } = dirProject();
  const lib = path.join(root, exp, "libraries", "lib-abcdefgh");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "tokens.json"), JSON.stringify(tokens({ exportedAt: "2026-01-01T00:00:00Z", variables: [{ name: "radius", type: "FLOAT", values: { M: 4 } }] })));
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-real-export-")), "export");
  fs.renameSync(path.join(root, exp), elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, exp), "junction");
  const s = cli(root, "--snapshot", exp);
  const sync = fs.readdirSync(path.join(root, "design", ".sync"));
  rewrite(root, path.join(exp, "libraries", "lib-abcdefgh", "tokens.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.variables = [variable({ name: "radius", type: "FLOAT", values: { M: 8 } })]; });
  const r = cli(root, exp);
  return s.status === 0 && sync.includes("export__design-system__tokens.json") && sync.includes("export__libraries__lib-abcdefgh__tokens.json") && !sync.includes("tokens.json")
    && r.status === 0 && /M: 4 → 8/.test(r.stdout) && !/space\/md/.test(r.stdout);
})());
check("an unreadable snapshot: the diff names it (exit 2), step 2 refuses it, and --force (the documented way out) replaces it", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  const snap = path.join(root, "design", ".sync", "export__pages__home__Login__1_1.json");
  fs.writeFileSync(snap, "{ not json");
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  const bad = cli(root, LOGIN);
  const refused = cli(root, "--snapshot", LOGIN);
  const forced = cli(root, "--snapshot", "--force", LOGIN);
  return bad.status === 2 && /after the re-pull the snapshot would be the new export, so the diff then uses git HEAD or --against/.test(bad.stderr) && refused.status === 1 && /refusing to overwrite/.test(refused.stderr)
    && forced.status === 0 && fs.readFileSync(snap, "utf8") === fs.readFileSync(path.join(root, LOGIN), "utf8");
})());
check("a project nested under another design/ (…/design/proj), run from proj/src: the snapshot lands in proj/design/.sync/, not the outer one", (() => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-nested-"));
  const proj = path.join(outer, "design", "proj");
  fs.mkdirSync(path.join(proj, "design", "export"), { recursive: true });
  fs.mkdirSync(path.join(proj, "src"));
  fs.writeFileSync(path.join(proj, "design", "export", "variables.json"), JSON.stringify(tokens({ variables: [] })));
  const s = cli(path.join(proj, "src"), "--snapshot", path.join("..", "design", "export", "variables.json"));
  return s.status === 0 && fs.existsSync(path.join(proj, "design", ".sync", "export__variables.json")) && !fs.existsSync(path.join(outer, "design", ".sync"));
})());


// A snapshot is spent only by a diff that had something to compare it against.
console.log("CLI — spent and fresh snapshots:");
const SNAP_LOGIN = path.join("design", ".sync", "export__pages__home__Login__1_1.json");
check("a snapshot that IS the export it was diffed against is not spent: the later re-pull is neither 'already diffed' in the diff nor in the refusal", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  cli(root, LOGIN); // diffed with nothing re-pulled: the snapshot is the export
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  const s = cli(root, "--snapshot", LOGIN);
  const d = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  return !d.warnings.some((w) => /already diffed/.test(w)) && d.changed[0]?.fields[0]?.before === "v1" && s.status === 1 && /no diff has used it yet/.test(s.stderr) && !/already diffed/.test(s.stderr);
})());
check("the next sync's identical snapshot clears the diff mark (a later re-pull is not 'since the earlier diff')", (() => {
  const { root, exp } = dirProject();
  cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "variables.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.variables = []; });
  cli(root, exp); // the design-system files were not re-pulled: each is its own snapshot, marked all the same
  const marked = fs.readdirSync(path.join(root, "design", ".sync")).filter((f) => f.endsWith(".diffed")).length;
  const s2 = cli(root, "--snapshot", exp);
  const left = fs.readdirSync(path.join(root, "design", ".sync")).filter((f) => f.endsWith("tokens.json.diffed"));
  rewrite(root, path.join(exp, "design-system", "tokens.json"), (d) => { d.exportedAt = "2026-03-01T00:00:00Z"; d.variables = [variable({ name: "space/md", type: "FLOAT", values: { M: 20 } })]; });
  const j = parseAs(cli(root, exp, "--json").stdout, isDirResult, "design-diff <dir> --json");
  const tok = j.results.find((r) => /design-system[\\/]tokens\.json$/.test(r.file));
  return marked === 4 && s2.status === 0 && left.length === 0 && tok !== undefined && tok.warnings.length === 0 && !tok.warned;
})());
check("a late snapshot (taken after the re-pull, baseline from git), then the next sync: that diff has no 'already diffed' warning", (() => {
  const root = project(); git(root, "init", "-q");
  putScreen(root, "v1", "2026-01-01T00:00:00Z"); git(root, "add", "-A"); git(root, "commit", "-qm", "v1");
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN); // too late: the export is already v2
  const first = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  git(root, "add", "-A"); git(root, "commit", "-qm", "v2");
  const s2 = cli(root, "--snapshot", LOGIN);
  const marked = fs.existsSync(path.join(root, SNAP_LOGIN + ".diffed"));
  putScreen(root, "v3", "2026-03-01T00:00:00Z");
  const d = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  return first.against === "git HEAD" && s2.status === 0 && /unchanged/.test(s2.stdout) && !marked
    && !d.warnings.some((w) => /already diffed/.test(w)) && d.changed[0]?.fields[0]?.before === "v2" && d.changed[0]?.fields[0]?.after === "v3";
})());
check("a --force snapshot (its .prev was the diff's baseline), then the next sync's identical snapshot drops that .prev: no 'older than' note after the next re-pull", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, "--snapshot", "--force", LOGIN);
  const first = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json"); // snapshot == export, so .prev (v1) is the baseline
  const s2 = cli(root, "--snapshot", LOGIN);
  const left = fs.readdirSync(path.join(root, "design", ".sync")).filter((f) => /\.prev$/.test(f));
  putScreen(root, "v3", "2026-03-01T00:00:00Z");
  const d = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  return first.against.endsWith(".prev") && first.changed[0]?.fields[0]?.before === "v1" && s2.status === 0 && left.length === 0 && !d.warned && d.changed[0]?.fields[0]?.before === "v2";
})());
check("a forced .prev that no diff has used survives an identical re-run of step 2 (it is still the only older copy)", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, "--snapshot", "--force", LOGIN);
  cli(root, "--snapshot", LOGIN); // step 2 run twice
  const d = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  return fs.existsSync(path.join(root, SNAP_LOGIN + ".prev")) && d.changed[0]?.fields[0]?.before === "v1";
})());

console.log("CLI — the spent snapshot a sync replaces stays recoverable:");
check("step 2 over a spent snapshot prints where the old copy is and how to diff against it; --against it lists the changes the stopped sync never applied", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, LOGIN); // the report was shown, then the sync stopped
  const s2 = cli(root, "--snapshot", LOGIN);
  const prev = SNAP_LOGIN + ".prev";
  const against = parseAs(cli(root, LOGIN, "--against", prev, "--json").stdout, isScreenResult, "design-diff --json");
  return s2.status === 0 && s2.stdout.includes(`kept as ${prev}`) && s2.stdout.includes(`--against ${prev}`) && fs.existsSync(path.join(root, prev + ".diffed"))
    && against.changed[0]?.fields[0]?.before === "v1" && against.changed[0]?.fields[0]?.after === "v2";
})());
check("…and that .prev is never a baseline on its own: no 'older than' note, and an export that was not re-pulled says there is no older copy", (() => {
  const root = project();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  cli(root, "--snapshot", LOGIN);
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  cli(root, LOGIN);
  cli(root, "--snapshot", LOGIN);
  const notRepulled = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  putScreen(root, "v3", "2026-03-01T00:00:00Z");
  const d = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  return notRepulled.warnings.some((w) => /no OLDER export/.test(w)) && !notRepulled.against.endsWith(".prev") && !d.warnings.some((w) => /older than/.test(w)) && !d.warned && d.changed[0]?.fields[0]?.before === "v2";
})());
check("a re-pulled variables.json is refused with its name, the reason a pull for another screen counts, and the command's answer", (() => {
  const { root, exp } = dirProject();
  cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "variables.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.variables = []; });
  cli(root, exp);
  rewrite(root, path.join(exp, "variables.json"), (d) => { d.exportedAt = "2026-03-01T00:00:00Z"; d.variables = [variable({ name: "brand", type: "COLOR", values: { Light: "#444444" } })]; });
  const s = cli(root, "--snapshot", exp);
  return s.status === 1 && /export__variables\.json was already diffed against an earlier export, and [^\n]*variables\.json was re-pulled since \(every screen and design-system pull merges into variables\.json, so a pull for another screen changes it too\)/.test(s.stderr)
    && /Run the diff now \(its report lists the earlier sync's changes again\), then snapshot again\./.test(s.stderr);
})());

console.log("CLI — where the snapshot lands, from outside the project:");
const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-cwd-"));
check("an absolute path from a directory outside the project: --snapshot lands in the project's design/.sync/ (no design/ in the cwd) and a diff from anywhere finds it", (() => {
  const root = project(), outside = tmpDir();
  putScreen(root, "v1", "2026-01-01T00:00:00Z");
  const s = cli(outside, "--snapshot", path.join(root, LOGIN));
  putScreen(root, "v2", "2026-02-01T00:00:00Z");
  const fromOutside = parseAs(cli(outside, path.join(root, LOGIN), "--json").stdout, isScreenResult, "design-diff --json");
  const fromRoot = parseAs(cli(root, LOGIN, "--json").stdout, isScreenResult, "design-diff --json");
  return s.status === 0 && fs.existsSync(path.join(root, SNAP_LOGIN)) && !fs.existsSync(path.join(outside, "design"))
    && fromOutside.baseline === "snapshot" && fromRoot.baseline === "snapshot" && fromOutside.changed[0]?.fields[0]?.before === "v1";
})());
check("an inner project (…/design/proj/design/export) addressed from the outer directory finds the snapshot taken from inside it", (() => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-nested-")), inner = path.join(outer, "design", "proj");
  const rel = path.join("design", "export", "variables.json");
  fs.mkdirSync(path.join(inner, "design", "export"), { recursive: true });
  const write = (at: string): void => fs.writeFileSync(path.join(inner, rel), JSON.stringify(tokens({ exportedAt: at, variables: [variable({ name: "brand", type: "COLOR", values: { Light: at.startsWith("2026-01") ? "#111111" : "#222222" } })] })));
  write("2026-01-01T00:00:00Z");
  const s = cli(inner, "--snapshot", rel);
  write("2026-02-01T00:00:00Z");
  const d = parseAs(cli(outer, path.join("design", "proj", rel), "--json").stdout, isDiffResult, "design-diff --json");
  return s.status === 0 && d.baseline === "snapshot" && d.summary.changed === 1 && !fs.existsSync(path.join(outer, "design", ".sync"));
})());
check("a file under no project's design/ is refused (exit 2, one line), writing nothing into the cwd; a diff of it has no snapshot to find", (() => {
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, "loose.json"), JSON.stringify(tokens({ variables: [] })));
  const s = cli(outside, "--snapshot", "loose.json");
  const d = cli(outside, "loose.json");
  return s.status === 2 && /loose\.json is not under a design\/ directory that holds an export/.test(s.stderr) && s.stderr.trim().split("\n").length === 1
    && !fs.existsSync(path.join(outside, "design")) && d.status === 2 && /nothing to compare/.test(d.stderr);
})());
check("a library export removed after the snapshot is 'in the snapshot, no longer in the export', not dropped", (() => {
  const { root, exp } = dirProject();
  const lib = path.join(root, exp, "libraries", "lib-abcdefgh");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "tokens.json"), JSON.stringify(tokens({ exportedAt: "2026-01-01T00:00:00Z", variables: [{ name: "radius", type: "FLOAT", values: { M: 4 } }] })));
  cli(root, "--snapshot", exp);
  fs.rmSync(lib, { recursive: true });
  const r = cli(root, exp);
  return r.status === 0 && /^- `[^`]*lib-abcdefgh[\\/]tokens\.json`: in the snapshot, no longer in the export$/m.test(r.stdout);
})());
check("a symlinked design/export addressed by its real directory has no snapshot to find (the documented limit); through design/ it does", (() => {
  const { root, exp } = dirProject();
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-diff-real-export-")), "export");
  fs.renameSync(path.join(root, exp), elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, exp), "junction");
  cli(root, "--snapshot", exp);
  rewrite(root, path.join(exp, "variables.json"), (d) => { d.exportedAt = "2026-02-01T00:00:00Z"; d.variables = []; });
  const viaDesign = cli(root, path.join(exp, "variables.json"), "--json");
  const viaReal = cli(root, path.join(elsewhere, "variables.json"), "--json");
  return viaDesign.status === 0 && parseAs(viaDesign.stdout, isDiffResult, "design-diff --json").baseline === "snapshot" && viaReal.status === 2;
})());

report();
