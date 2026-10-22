// The core selection read: collectSelection() on the representative file's scroll frame — the manifest, clip/scroll,
// sizeLimits, ids, the reference render and its asset naming, and that reply written to disk by the real bridge writer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { IrNode, ScreenExport } from "../../bridge/src/doc-types.ts";
import type { ScreenReply } from "../../bridge/src/commands.ts";
import { writeScreen } from "../../bridge/src/write-out.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

/** The base selection read, made per case: `collectSelection()` with no args on a fresh copy of the
 *  representative file (its selection is the scroll frame), and the frame's three children — the mixed text, the
 *  gradient rect, the reacting instance. A single small selection, so the CSS oracle auto-enables (collect.ts
 *  autoCss) and runOpts.css is left on afterwards. */
export async function selection() {
  const w = world();
  const sel = await w.api.collectSelection();
  const tree = must(sel.screen.nodes[0], "the screen's root node");
  const treeChildren = must(tree.children, "tree.children");
  const txt = must(treeChildren[0], "tree.children[0]");
  const rect = must(treeChildren[1], "tree.children[1]");
  const btn = must(treeChildren[2], "tree.children[2]");
  return { w, sel, tree, txt, rect, btn };
}

export const cases: Case[] = [{
  name: "selection: manifest, scroll frame clip/scroll/sizeLimits, flex layout",
  async run() {
    const { sel, tree } = await selection();
    ok("manifest present", sel.screen.manifest && typeof sel.screen.manifest.nodes === "number");
    ok("manifest counted nodes (>=4)", sel.screen.manifest.nodes >= 4);
    ok("scroll frame -> clip", tree.clip === true);
    ok("scroll frame -> scroll:vertical", tree.scroll === "vertical");
    ok("scroll frame -> sizeLimits.maxWidth", !!(tree.sizeLimits && tree.sizeLimits.maxWidth === 400));
    ok("layout flex column + gap + padding", !!(tree.layout && tree.layout.flexDirection === "column" && tree.layout.gap === 12 && Array.isArray(tree.layout.padding)));
  },
}, {
  name: "Tier 1 read additions: variable modes, reference render, asset naming",
  async run() {
    const { sel, tree } = await selection();
    // --- new READ additions (Tier 1: variable modes, prop-driven wiring, reference render, token bindings) ---
    ok("variable mode pin resolved to names", !!(tree.variableModes && tree.variableModes.Semantic === "Dark"));
    // Effective/inherited theme at the export root (resolvedVariableModes) — the fix for ancestor/page
    // pins on single-node exports. Multi-mode collection reported by name; single-mode one filtered out.
    ok("resolved (inherited) modes at root", !!(tree.resolvedModes && tree.resolvedModes.Semantic === "Dark"));
    ok("resolvedModes filters single-mode collections", !!(tree.resolvedModes && tree.resolvedModes.Primitives === undefined));
    ok("reference screenshot path on tree", typeof tree.reference === "string" && tree.reference.indexOf("assets/") === 0 && tree.reference.indexOf("ref") !== -1);
    ok("reference asset flagged kind:reference", sel.assets.some((a) => a.kind === "reference" && a.format === "png"));
    // The asset-naming contract: the producer names the file ONCE, and every `asset:`/`reference:` path
    // in the tree is "assets/" + that name. Consumers (figma-pull, the UI download) write a.file rather
    // than re-deriving it, so a drift here would silently point every path at a file that isn't on disk.
    ok("every asset record carries its filename", sel.assets.length > 0 && sel.assets.every((a) => typeof a.file === "string" && a.file.length > 0));
    ok("asset filename has no path separators", sel.assets.every((a) => a.file.indexOf("/") === -1));
    ok("asset filename ends in its declared format", sel.assets.every((a) => a.file.endsWith("." + a.format)));
    ok(
      "tree reference path == assets/ + the record's file",
      sel.assets.some((a) => a.kind === "reference" && "assets/" + a.file === tree.reference)
    );
    // Named from the LAYER, not from the node-id path. An app importing 41 icons would otherwise import 41
    // filenames like `I10970_111374_1910_23337_1902_19173.svg` while the layer name
    // sat unused right beside it in the tree.
    ok("the reference PNG keeps its <id>_ref.png name — build-screen looks it up by id",
      sel.assets.some((a) => a.kind === "reference" && /_ref\.png$/.test(a.file)));
    ok("every asset carries a content hash, so a consumer can spot duplicates without diffing bytes",
      sel.assets.every((a) => typeof a.hash === "string" && a.hash.length > 0));
  },
}, {
  name: "[e2e] the plugin's selection reply written by the real bridge writer",
  async run() {
    const { sel, tree } = await selection();
    // End to end: the REAL plugin reply above, written by the REAL bridge writer over an
    // assets/ dir that already holds (a) a different image under the reference's own name — a discovery
    // thumbnail — and (b) the first SVG's exact bytes under another name. Every pointer the written screen
    // JSON carries must name a file on disk (exact case), and the reference must be this pull's render.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-assets-"));
    fs.mkdirSync(path.join(dir, "assets"));
    const refAsset = must(sel.assets.find((a) => a.kind === "reference"), "the reply's reference asset");
    fs.writeFileSync(path.join(dir, "assets", refAsset.file), Buffer.from([137, 80, 78, 71, 1, 2, 3])); // a different PNG under the same name
    const reply = JSON.parse(JSON.stringify({ ...sel, screenName: sel.screen.screen || "Harness screen", nodeId: tree.id, page: "Harness page", pageId: "0:1" })) as ScreenReply;
    const res = writeScreen(dir, reply, undefined);
    const written = JSON.parse(fs.readFileSync(res.wrote.screen, "utf8")) as ScreenExport;
    const ptrs: string[] = [];
    const visit = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      for (const [k, val] of Object.entries(v)) (k === "asset" || k === "reference") && typeof val === "string" ? ptrs.push(val) : visit(val);
    };
    visit(written.nodes);
    const onDisk = new Set(fs.readdirSync(path.join(dir, "assets")));
    // This fixture's reply carries one asset, the reference (the SVG/content-reuse cases run with the
    // plugin's asset shape in bridge.test.ts). With a thumbnail pre-seeded under its name, the check that
    // tells a working writer from a broken one is the next: the pointer must MOVE to this pull's render.
    ok("[e2e] every pointer the plugin's reply produces names a file on disk (exact case)",
      ptrs.length >= 1 && ptrs.every((p) => p.startsWith("assets/") && onDisk.has(p.slice("assets/".length))));
    ok("[e2e] the root reference is this pull's render, not the file that already held its name",
      written.nodes[0]?.reference !== "assets/" + refAsset.file && fs.readFileSync(path.join(dir, must(written.nodes[0]?.reference, "reference"))).equals(Buffer.from(must(refAsset.base64, "base64"), "base64")));
    fs.rmSync(dir, { recursive: true, force: true });
  },
}, {
  name: "READ additions (HIGH tier + MED): the root's resolved box, strokes in layout, dev resources",
  async run() {
    const { tree } = await selection();
    ok("resolved box on auto-layout root", !!(tree.box && tree.box.w === 375));
    ok("strokesIncludedInLayout flagged", tree.strokesInLayout === true);
    const treeDevResource0 = tree.devResources?.[0];
    ok("dev-resource links batched at root", Array.isArray(tree.devResources) && treeDevResource0 !== undefined && treeDevResource0.url === "https://sb.example.com/list");
  },
}, {
  name: "Tier-1 read additions: no inferred tokens; css / measurements / pluginData are opt-in",
  async run() {
    const { w, tree } = await selection();
    // inferredVariables is NOT emitted as `inferredTokens` for every unbound field: it
    // would measure 20.5% of a real payload (2,151 occurrences) with zero consumers, and the matches are
    // value-coincidence. The mock still SUPPLIES inferredVariables on scrollFrame, so this pins that the
    // extractor ignores it rather than that the fixture stopped providing it.
    ok("inferredTokens is not emitted", (tree as IrNode & { inferredTokens?: unknown }).inferredTokens === undefined);
    ok("and no inferred* key leaks under another name", !Object.keys(tree).some((k) => /^inferred/.test(k)));
    // css / measurements / pluginData are OPT-IN — off by default.
    // css AUTO-ENABLES for a small single selection (the "inspect one component" path). scrollFrame
    // is tiny (4 nodes), so the CSS oracle comes back without an explicit opt-in.
    ok("css auto-on for small single selection", !!(tree.css && tree.css.display === "flex" && tree.css.padding === "16px"));
    ok("pluginData still off by default (not auto-enabled)", tree.pluginData === undefined);
    const sel2 = await w.api.collectSelection({ css: true, measurements: true, pluginData: true });
    const tree2 = must(sel2.screen.nodes[0], "sel2.screen.nodes[0]");
    ok("getCSSAsync -> css oracle (opt-in)", !!(tree2.css && tree2.css.display === "flex" && tree2.css.padding === "16px"));
    ok("own-scope plugin data captured (opt-in)", !!(tree2.pluginData && tree2.pluginData.codeConnect === "Button/Primary"));
    ok("measurements captured via sync getMeasurements (opt-in)", Array.isArray(sel2.screen.measurements) && sel2.screen.measurements[0]?.text === "16" && sel2.screen.measurements[0]?.start?.side === "LEFT");
  },
}];
