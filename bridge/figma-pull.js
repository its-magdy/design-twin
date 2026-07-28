#!/usr/bin/env node
// figma-pull — READ plane CLI.
// Connects to the running Figma plugin over the localhost bridge, pulls the full
// design system + all page frames (or the current selection), and writes them to
// disk. The agent then Reads those files selectively (context-economical).
//
// Usage:
//   node figma-pull.js [outDir]              # full: design-system.json + current-page frames + assets
//   node figma-pull.js [outDir] --all-pages  # like full, but frame trees from EVERY page
//   node figma-pull.js [outDir] --selection  # just the current selection
//
// Optional Tier-1 reads (opt-in — extra work / Dev-Mode-only):
//   --css            # Figma's own computed CSS per node (getCSSAsync) — the design-to-code oracle
//   --measurements   # Dev-Mode measurement redlines for the current page
//   --plugin-data    # own-scope plugin data stamped on nodes
//   --motion         # motion/animation reads (timelines, keyframe tracks, animations, styles)
//   --shared-data    # cross-plugin shared data (Tokens Studio applied tokens via getSharedPluginData)
//
// The Figma file must be open with the "Design Export for AI" plugin running.

const fs = require("fs");
const path = require("path");
const { createBridge } = require("./server-core");

const args = process.argv.slice(2);
const selection = args.includes("--selection");
const allPages = args.includes("--all-pages");
const readOpts = { css: args.includes("--css"), measurements: args.includes("--measurements"), pluginData: args.includes("--plugin-data"), motion: args.includes("--motion"), sharedData: args.includes("--shared-data") };
const outDir = args.find((a) => !a.startsWith("--")) || "design";

// Filesystem-boundary sanitiser for names that become paths. Asset filenames are NOT derived here —
// the plugin names each asset (assets.ts) and the node tree's `asset` path is built from that same
// string, so re-deriving the convention on this side could silently point every path at a missing
// file. basename() below is the only guard those need.
function safe(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "_");
}

function writeJson(dir, name, obj) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
  console.error("[figma-pull] wrote " + path.join(dir, name));
}

function writeAssets(dir, assets) {
  if (!assets || !assets.length) return;
  const adir = path.join(dir, "assets");
  fs.mkdirSync(adir, { recursive: true });
  for (const a of assets) {
    // a.file is the name the plugin already put in the tree's `asset` path — write exactly that.
    const file = path.join(adir, path.basename(a.file));
    if (a.text != null) fs.writeFileSync(file, a.text);
    else if (a.base64 != null) fs.writeFileSync(file, Buffer.from(a.base64, "base64"));
  }
  console.error("[figma-pull] wrote " + assets.length + " asset(s) to " + adir);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const bridge = createBridge();

  console.error("[figma-pull] listening on ws://localhost:" + bridge.port);
  console.error('[figma-pull] Open your Figma file and run "Design Export for AI" (it auto-connects)…');

  await bridge.waitForConnection(600000); // 10 min — generous window for an interactive connect
  const mode = selection ? "selection" : allPages ? "all pages" : "current page";
  console.error("[figma-pull] plugin connected — pulling " + mode + "…");

  if (selection) {
    const r = await bridge.request("exportSelection", { ...readOpts });
    writeJson(outDir, safe(r.screenName || "screen") + ".json", r.screen);
    writeJson(outDir, "variables.json", r.variables);
    writeAssets(outDir, r.assets);
  } else {
    const r = await bridge.request("exportFull", { allPages, ...readOpts });
    writeJson(outDir, "design-system.json", r.designSystem);
    writeJson(outDir, "screens.json", r.screensDoc);
    writeAssets(outDir, r.assets);
  }

  console.error("[figma-pull] done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("[figma-pull] error:", e.message);
  process.exit(1);
});
