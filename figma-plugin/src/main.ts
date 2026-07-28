// Design Export for AI — plugin main thread (entry point).
// Two manual export modes:
//   1) Export current selection      -> <screen>.json + variables.json
//   2) Export design system + page   -> design-system.json + screens.json (+ assets)
// In production the plugin has NO network (manifest allowedDomains:["none"]) — data leaves only via
// the clipboard / file download YOU trigger. A Development build additionally opts into a localhost-only
// bridge (devAllowedDomains, ignored once published) that can also apply the enumerated writes in
// writes.ts. See ARCHITECTURE.md "Verified extraction API surface".
//
// Extraction surface is grounded in the verified Figma Plugin API (dynamic-page async reads,
// figma.mixed guards, defensive `in` checks). See ARCHITECTURE.md "Verified extraction API surface".
import { errMsg } from "./util";
import { releaseAssets, serializeRun } from "./state";
import { collectSelection, collectFull, collectNode } from "./collect";
import { serialize } from "./serialize";
import { buildDesignSystem } from "./components";
import { handleBridge } from "./bridge";
import { applyWrites } from "./writes";

// Test surface: the bundle is an IIFE, so internals aren't global. Expose the read AND write APIs
// under one namespaced global so the VM test harness (test/harness.js) can drive them. Harmless in
// the isolated plugin realm; not referenced by the UI or bridge.
(globalThis as any).__designExport = { serialize, collectSelection, collectNode, collectFull, buildDesignSystem, applyWrites };

figma.showUI(__html__, { width: 360, height: 380 });
console.log("[export] main.ts loaded (main thread)"); // visible with Plugins > Development > Use Developer VM

// ---------- messaging ----------
// Run a collector under serializeRun, then post its files — or an error message if it throws.
async function runExport(collect: () => Promise<any>, toFiles: (r: any) => { files: Array<{ name: string; content: string; copyable?: boolean }>; summary: string }): Promise<void> {
  let r: any;
  try {
    r = await serializeRun(collect);
  } catch (e) {
    figma.ui.postMessage({ type: "error", message: errMsg(e) });
    return;
  }
  const { files, summary } = toFiles(r);
  // Post the collector's OWN asset list (it already returned a copy), then drop the module-level one.
  // Otherwise every base64 PNG/SVG of this export stays resident until the next run's resetRun().
  figma.ui.postMessage({ type: "files", files, assets: r.assets, summary });
  releaseAssets();
}

const runSelection = (): Promise<void> =>
  runExport(collectSelection, (r) => ({
    files: [
      { name: `${r.screenName}.json`, content: JSON.stringify(r.screen, null, 2), copyable: true },
      { name: "variables.json", content: JSON.stringify(r.variables, null, 2) },
    ],
    summary: `${r.screenName} — ${r.assets.length} asset(s)`,
  }));

const runFull = (): Promise<void> =>
  runExport(collectFull, (r) => ({
    files: [
      { name: "design-system.json", content: JSON.stringify(r.designSystem, null, 2) },
      { name: "screens.json", content: JSON.stringify(r.screensDoc, null, 2) },
    ],
    summary: `${r.screensDoc.screens.length} screen(s), ${r.designSystem.variables.length} vars, ${r.designSystem.components.length} components, ${r.assets.length} asset(s)`,
  }));

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
  } else if (msg.type === "run-selection") {
    await runSelection();
  } else if (msg.type === "run-full") {
    await runFull();
  } else if (msg.type === "bridge") {
    let result: any;
    let error: string | undefined;
    try {
      result = await handleBridge(msg.cmd, msg.args);
    } catch (e) {
      error = errMsg(e);
    }
    figma.ui.postMessage({ type: "bridge-result", id: msg.id, ok: !error, result, error });
    releaseAssets(); // the result carries its own assets.slice() — don't hold the bytes past the reply
  }
};

figma.on("selectionchange", notifySelection);
try { notifySelection(); } catch (e) { console.error("[export] notifySelection failed:", e); }
console.log("[export] main thread ready — onmessage registered");
