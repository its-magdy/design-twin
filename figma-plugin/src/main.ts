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
import { ifDefined } from "../../bridge/src/json-util.ts";
// The pages/ layout is defined ONCE, in a dependency-free CJS module the Node CLI requires and
// esbuild inlines here — see bridge/src/pages-layout.ts.
import { buildPageLayout } from "../../bridge/src/pages-layout.ts";
import { buildDesignSystemLayout } from "../../bridge/src/design-system-layout.ts";
import { cancelBridgeRequest, cancelBridgeRuns, releaseAssets, serializeRun, type Asset } from "./state";
import { requestCancel } from "./progress";
import { collectSelection, collectFull, collectDesignSystemOnly, collectLibraryFile, collectNode, collectScreenshot, listPages, listChildren, type ScreenResult, type FullResult } from "./collect";
import { serialize } from "./serialize";
import { buildDesignSystem } from "./components";
import { listLibraries, collectLibraryComponents } from "./libraries";
import { handleBridge } from "./bridge";
import { applyWrites } from "./writes";
import { isUIToMain, type ExportFile, type ExportLayerFile } from "./messages";

// Test surface: the bundle is an IIFE, so internals aren't global. Expose the read AND write APIs
// under one namespaced global so the VM test harness (test/harness.ts) can drive them. Harmless in
// the isolated plugin realm; not referenced by the UI or bridge.
// serializeRun/requestCancel ride along because progress + cancellation only exist INSIDE a bracketed
// run (see progress.ts): a harness that called a collector directly would see neither, so the test
// surface has to be the same entry point main.ts and bridge.ts use.
globalThis.__designExport = { serialize, collectSelection, collectNode, collectScreenshot, collectFull, collectDesignSystemOnly, collectLibraryFile, listPages, listChildren, buildDesignSystem, applyWrites, listLibraries, collectLibraryComponents, serializeRun, requestCancel };

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
interface ExportFilesOut { files: ExportFile[]; layerFiles?: ExportLayerFile[]; summary: string; warnings?: string[]; }

async function runExport<T extends { assets: Asset[] }>(
  label: string,
  collect: () => Promise<T>,
  toFiles: (r: T) => ExportFilesOut
): Promise<void> {
  let r: T;
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
  runExport<ScreenResult>("current selection", () => collectSelection(), (r) => ({
    files: [
      { name: `${r.screenName}.json`, content: JSON.stringify(r.screen, null, 2), copyable: true },
      { name: "variables.json", content: JSON.stringify(r.variables, null, 2) },
    ],
    summary: `${r.screenName} — ${r.assets.length} asset(s)`,
    warnings: r.screen.manifest && r.screen.manifest.warnings,
  }));

// The browser-download twin of bridge/src/write-out.ts's writePages: same pages/ layout, built by the
// same module (pages-layout.ts) so the two shapes cannot drift. The ONE difference is the separator —
// a browser download cannot create directories, so the hierarchy is encoded in the filename instead
// (rationale in pages-layout.ts's header, where the layout lives).
const SEP = "__";
const runFull = (): Promise<void> =>
  runExport<FullResult>("design system + page frames", () => collectFull(), (r) => {
    const { meta, layerFiles, indexFiles, rootIndex } = buildPageLayout(r.layersDoc, SEP);
    // Per-page index.json files ride in `layerFiles` (the batch bucket), NOT `files` — `files` gets
    // one download BUTTON per entry, and 19+ pages would mean 19+ buttons, the exact non-scaling this
    // split was meant to avoid. Only the two whole-run docs get their own button.
    // Same for the design-system split (tokens/styles/components.local/components.library/hygiene):
    // built by the same module the disk writer uses, and the five parts ride in the batch bucket while
    // only the slim design-system.json manifest — the file a consumer opens FIRST to find the rest —
    // gets its own button.
    const ds = buildDesignSystemLayout(r.designSystem, SEP);
    const dsParts = ds.files.filter((f) => f.path !== "design-system.json");
    const batch = [...layerFiles, ...indexFiles, ...dsParts].map((f) => ({ name: f.path, content: JSON.stringify(f.data, null, 2) }));
    return {
      files: [
        { name: "design-system.json", content: JSON.stringify(ds.manifest, null, 2) },
        { name: rootIndex, content: JSON.stringify(meta, null, 2) },
      ],
      layerFiles: batch,
      summary: `${layerFiles.length} layer(s) across ${meta.pageDirs.length} page(s), ${(r.designSystem.variables || []).length} vars, ${(r.designSystem.components || []).length} components, ${r.assets.length} asset(s)`,
      ...ifDefined("warnings", r.layersDoc.manifest && r.layersDoc.manifest.warnings),
    };
  });

function notifySelection(): void {
  const sel = figma.currentPage.selection;
  const first = sel[0]; // undefined exactly when the selection is empty
  figma.ui.postMessage({ type: "selection", count: sel.length, name: first ? first.name : null });
}

figma.ui.onmessage = async (raw: unknown) => {
  if (!isUIToMain(raw)) return;
  switch (raw.type) {
    case "get-token": {
      // The bridge token is persisted per-user via clientStorage (never leaves the file).
      const token: unknown = await figma.clientStorage.getAsync("bridgeToken");
      figma.ui.postMessage({ type: "token", token: typeof token === "string" ? token : "" });
      break;
    }
    case "set-token": {
      await figma.clientStorage.setAsync("bridgeToken", raw.token || "");
      break;
    }
    case "get-identity": {
      // Who is this file? The UI iframe asks on every socket open so it can announce itself to the
      // bridge, which routes commands per file. It has to ask US because `figma.*` exists only on the
      // main thread — the iframe has no access to the document at all. Reuses the `whoami` handler so
      // the announcement and the --whoami probe can never report different identities.
      let identity: unknown = {};
      try {
        identity = await handleBridge("whoami", {});
      } catch (e) {
        identity = { error: errMsg(e) };
      }
      figma.ui.postMessage({ type: "identity", identity });
      break;
    }
    case "run-selection": {
      await runSelection();
      break;
    }
    case "run-full": {
      await runFull();
      break;
    }
    case "cancel": {
      // The BRIDGE gave up (ui.html forwards a socket `{ type: "cancel", id }` frame, or reports the
      // socket closed as `scope: "bridge"`). No work anyone can collect should keep the file busy and
      // queue every later command behind it, so: an executing matching run aborts at its next safe
      // point, a queued one fails without ever executing (state.ts). Deliberately NO cancel-ack: the
      // window's ack handling is the Cancel BUTTON's ("Nothing to cancel…" + tearing down the run
      // chrome on a miss), and a bridge-side cancel must never drive it.
      if (raw.id !== undefined) { cancelBridgeRequest(raw.id); break; }
      if (raw.scope === "bridge") { cancelBridgeRuns(); break; }
      // The designer pressed Cancel. All this does is SET a flag: there is no way to interrupt an
      // in-flight exportAsync, so the walk aborts itself at its next safe point (progress.ts
      // checkCancelled) by throwing — which is also what guarantees no partial doc is ever delivered,
      // since every caller's error path posts an error instead of files.
      // Acknowledged either way: a click that hit nothing (the run finished a moment earlier) must read
      // as a no-op in the UI rather than leave a Cancel button spinning forever.
      const hit = requestCancel();
      figma.ui.postMessage({ type: "cancel-ack", accepted: !!hit, label: hit ? hit.label : null });
      break;
    }
    case "bridge": {
      let result: unknown;
      let error: string | undefined;
      try {
        result = await handleBridge(raw.cmd, raw.args, raw.id);
      } catch (e) {
        // A CANCELLED bridge run lands here like any other failure, which is exactly what we want: the
        // cancellation message (progress.ts CANCELLED_MESSAGE) rides out as `error`, the iframe forwards
        // it to the socket, and the CLI/MCP fails FAST with "export cancelled by the designer in Figma"
        // instead of sitting out its request timeout wondering whether Figma is still working. A run the
        // bridge itself abandoned fails the same way with ABANDONED_MESSAGE (usually to nobody).
        error = errMsg(e);
      }
      figma.ui.postMessage({ type: "bridge-result", id: raw.id, ok: !error, result, error });
      releaseAssets(); // the result carries its own assets.slice() — don't hold the bytes past the reply
      break;
    }
    default: {
      const _exhaustive: never = raw;
      void _exhaustive;
    }
  }
};

figma.on("selectionchange", notifySelection);
try { notifySelection(); } catch (e) { console.error("[export] notifySelection failed:", e); }
console.log("[export] main thread ready — onmessage registered");
