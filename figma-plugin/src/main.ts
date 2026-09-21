// Design Twin — plugin main thread (entry point).
// Two manual export modes:
//   1) Export current selection      -> <screen>.json + variables.json
//   2) Export design system + page   -> design-system.json + pages/<page>/ (one file per layer) + assets
// The plugin reaches NO internet domain, published or not: manifest allowedDomains lists only
// ws://localhost:{8787,8788,8789}. Data leaves either via the clipboard / file download YOU trigger,
// or over the loopback bridge to a server YOU run, which can also apply the enumerated writes in
// writes.ts. Figma blocks any other destination before it leaves the iframe.
//
// Extraction surface is grounded in the verified Figma Plugin API (dynamic-page async reads,
// figma.mixed guards, defensive `in` checks). See ARCHITECTURE.md "Verified extraction API surface".
import { errMsg } from "./util";
// The pages/ layout is defined ONCE, in a dependency-free CJS module the Node CLI requires and
// esbuild inlines here — see bridge/pages-layout.js.
import { buildPageLayout } from "../../bridge/pages-layout.js";
import { buildDesignSystemLayout } from "../../bridge/design-system-layout.js";
import { releaseAssets, serializeRun } from "./state";
import { requestCancel } from "./progress";
import { collectSelection, collectFull, collectDesignSystemOnly, collectLibraryFile, collectNode, collectScreenshot, listPages, listChildren } from "./collect";
import { serialize } from "./serialize";
import { buildDesignSystem } from "./components";
import { listLibraries, collectLibraryComponents } from "./libraries";
import { handleBridge } from "./bridge";
import { applyWrites } from "./writes";

// Test surface: the bundle is an IIFE, so internals aren't global. Expose the read AND write APIs
// under one namespaced global so the VM test harness (test/harness.js) can drive them. Harmless in
// the isolated plugin realm; not referenced by the UI or bridge.
// serializeRun/requestCancel ride along because progress + cancellation only exist INSIDE a bracketed
// run (see progress.ts): a harness that called a collector directly would see neither, so the test
// surface has to be the same entry point main.ts and bridge.ts use.
(globalThis as any).__designExport = { serialize, collectSelection, collectNode, collectScreenshot, collectFull, collectDesignSystemOnly, collectLibraryFile, listPages, listChildren, buildDesignSystem, applyWrites, listLibraries, collectLibraryComponents, serializeRun, requestCancel };

// themeColors: Figma injects its --figma-color-* variables and a figma-light/figma-dark class into the
// iframe, which is what lets ui.html follow the user's theme instead of being a white box in dark mode.
figma.showUI(__html__, { width: 360, height: 380, themeColors: true });
console.log("[export] main.ts loaded (main thread)"); // visible with Plugins > Development > Use Developer VM

// ---------- messaging ----------
// Run a collector under serializeRun, then post its files — or an error message if it throws.
// `layerFiles` is a SEPARATE bucket from `files`, downloaded in one batch the same way `assets` is
// (see ui.html's "Download layers" button) rather than one download button per layer — a real
// design-system export has dozens of top-level layers, and a button-per-layer list doesn't scale the UI.
// Exclusive to runFull — runSelection never populates it (a hand-picked selection is a "screen", singular).
// `label` names the run in the plugin window while it walks (and is what the Cancel button reports
// back), so the designer can always tell a manual click from a CLI/MCP pull.
async function runExport(
  label: string,
  collect: () => Promise<any>,
  toFiles: (r: any) => { files: Array<{ name: string; content: string; copyable?: boolean }>; layerFiles?: Array<{ name: string; content: string }>; summary: string; warnings?: string[] }
): Promise<void> {
  let r: any;
  try {
    r = await serializeRun(collect, { source: "ui", label });
  } catch (e) {
    figma.ui.postMessage({ type: "error", message: errMsg(e) });
    return;
  }
  const { files, layerFiles, summary, warnings } = toFiles(r);
  // The warning COUNT, not the warnings themselves. They already ride to disk inside the doc's own
  // manifest and a real export produces dozens, so the plugin window's job is only to say the list is
  // non-empty and name where to read it — otherwise "Ready: …" reads as a clean export and nobody looks.
  // Post the collector's OWN asset list (it already returned a copy), then drop the module-level one.
  // Otherwise every base64 PNG/SVG of this export stays resident until the next run's resetRun().
  figma.ui.postMessage({ type: "files", files, layerFiles, assets: r.assets, summary, warnings: warnings ? warnings.length : 0 });
  releaseAssets();
}

const runSelection = (): Promise<void> =>
  runExport("current selection", collectSelection, (r) => ({
    files: [
      { name: `${r.screenName}.json`, content: JSON.stringify(r.screen, null, 2), copyable: true },
      { name: "variables.json", content: JSON.stringify(r.variables, null, 2) },
    ],
    summary: `${r.screenName} — ${r.assets.length} asset(s)`,
    warnings: r.screen.manifest && r.screen.manifest.warnings,
  }));

// The browser-download twin of bridge/figma-pull.js's writePages: same pages/ layout, built by the
// same module (pages-layout.js) so the two shapes cannot drift. The ONE difference is the separator —
// a browser download cannot create directories, so the hierarchy is encoded in the filename instead
// (rationale in pages-layout.js's header, where the layout lives).
const SEP = "__";
const runFull = (): Promise<void> =>
  runExport("design system + page frames", collectFull, (r) => {
    const { meta, layerFiles, indexFiles, rootIndex } = buildPageLayout(r.layersDoc, SEP);
    // Per-page index.json files ride in `layerFiles` (the batch bucket), NOT `files` — `files` gets
    // one download BUTTON per entry, and 19+ pages would mean 19+ buttons, the exact non-scaling this
    // split was meant to avoid. Only the two whole-run docs get their own button.
    // Same for the design-system split (tokens/styles/components.local/components.library/hygiene):
    // built by the same module the disk writer uses, and the five parts ride in the batch bucket while
    // only the slim design-system.json manifest — the file a consumer opens FIRST to find the rest —
    // gets its own button.
    const ds = buildDesignSystemLayout(r.designSystem, SEP);
    const dsParts = ds.files.filter((f: any) => f.path !== "design-system.json");
    const batch = [...layerFiles, ...indexFiles, ...dsParts].map((f) => ({ name: f.path, content: JSON.stringify(f.data, null, 2) }));
    return {
      files: [
        { name: "design-system.json", content: JSON.stringify(ds.manifest, null, 2) },
        { name: rootIndex, content: JSON.stringify(meta, null, 2) },
      ],
      layerFiles: batch,
      summary: `${layerFiles.length} layer(s) across ${meta.pageDirs.length} page(s), ${r.designSystem.variables.length} vars, ${r.designSystem.components.length} components, ${r.assets.length} asset(s)`,
      warnings: r.layersDoc.manifest && r.layersDoc.manifest.warnings,
    };
  });

function notifySelection(): void {
  const sel = figma.currentPage.selection;
  figma.ui.postMessage({ type: "selection", count: sel.length, name: sel.length ? sel[0].name : null });
}

figma.ui.onmessage = async (msg: any) => {
  if (!msg) return;
  if (msg.type === "get-token") {
    // The bridge token is persisted per-user via clientStorage (never leaves the file).
    const token = await figma.clientStorage.getAsync("bridgeToken");
    figma.ui.postMessage({ type: "token", token: token || "" });
  } else if (msg.type === "set-token") {
    await figma.clientStorage.setAsync("bridgeToken", msg.token || "");
  } else if (msg.type === "get-identity") {
    // Who is this file? The UI iframe asks on every socket open so it can announce itself to the
    // bridge, which routes commands per file. It has to ask US because `figma.*` exists only on the
    // main thread — the iframe has no access to the document at all. Reuses the `whoami` handler so
    // the announcement and the --whoami probe can never report different identities.
    let identity: any = {};
    try {
      identity = await handleBridge("whoami", {});
    } catch (e) {
      identity = { error: errMsg(e) };
    }
    figma.ui.postMessage({ type: "identity", identity });
  } else if (msg.type === "run-selection") {
    await runSelection();
  } else if (msg.type === "run-full") {
    await runFull();
  } else if (msg.type === "cancel") {
    // The designer pressed Cancel. All this does is SET a flag: there is no way to interrupt an
    // in-flight exportAsync, so the walk aborts itself at its next safe point (progress.ts
    // checkCancelled) by throwing — which is also what guarantees no partial doc is ever delivered,
    // since every caller's error path posts an error instead of files.
    // Acknowledged either way: a click that hit nothing (the run finished a moment earlier) must read
    // as a no-op in the UI rather than leave a Cancel button spinning forever.
    const hit = requestCancel();
    figma.ui.postMessage({ type: "cancel-ack", accepted: !!hit, label: hit ? hit.label : null });
  } else if (msg.type === "bridge") {
    let result: any;
    let error: string | undefined;
    try {
      result = await handleBridge(msg.cmd, msg.args);
    } catch (e) {
      // A CANCELLED bridge run lands here like any other failure, which is exactly what we want: the
      // cancellation message (progress.ts CANCELLED_MESSAGE) rides out as `error`, the iframe forwards
      // it to the socket, and the CLI/MCP fails FAST with "export cancelled by the designer in Figma"
      // instead of sitting out its request timeout wondering whether Figma is still working.
      error = errMsg(e);
    }
    figma.ui.postMessage({ type: "bridge-result", id: msg.id, ok: !error, result, error });
    releaseAssets(); // the result carries its own assets.slice() — don't hold the bytes past the reply
  }
};

figma.on("selectionchange", notifySelection);
try { notifySelection(); } catch (e) { console.error("[export] notifySelection failed:", e); }
console.log("[export] main thread ready — onmessage registered");
