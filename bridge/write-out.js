// write-out.js — the ONE place an export lands on disk.
//
// Both read clients write through this module: the figma-pull CLI (which has always written to disk)
// and the MCP export tools (which used to have no disk path at all — they stripped asset bytes to
// keep megabytes out of the agent's context, which also meant an MCP-only session could never
// produce assets/, and the CLI could not be run to fill the gap because both bind port 8787 and the
// second one to start exits on EADDRINUSE). Writing here and returning a compact INDEX is what makes
// the MCP path complete on its own.
//
// The freshness stamp (`exportedAt`/`file`) is stamped by the PLUGIN (collect.ts/components.ts).
// Nothing here adds, strips or re-derives it — writeJson writes what it was handed, byte for byte,
// because snapshot-meta.js and tooling/drift-lint.js both read that stamp back off disk.
const fs = require("fs");
const path = require("path");
const { buildPageLayout, safe } = require("./pages-layout.js");
const { buildDesignSystemLayout } = require("./design-system-layout.js");
const { buildLibraryLayout, mergeLibrariesIndex, ROOT, INDEX } = require("./library-layout.js");

// outDir is resolved against the CURRENT WORKING DIRECTORY on purpose: for the MCP server that is
// the project Claude Code was started in, so an export lands in the project you are building — not
// next to the bridge's own source. FIGMA_EXPORT_DIR is the same env var snapshot-meta.js already
// reads, so figma_status looks for the snapshot exactly where this wrote it.
function resolveOutDir(outDir) {
  return path.resolve(process.cwd(), outDir || process.env.FIGMA_EXPORT_DIR || "design");
}

// The CLI's outDir is a positional the USER typed — an absolute path or a sibling directory there is
// a legitimate choice. The MCP's outDir is a tool argument the MODEL supplies, and `path.resolve`
// happily honours "../../.." or "/tmp/anything", so an export could land anywhere the process can
// write. Confine that side to the directory the server was started in — which is also exactly what
// the option promises ("relative to your project"). Trust boundary, not a filesystem subtlety:
// applied where the value is untrusted, not inside resolveOutDir, so the CLI keeps its freedom.
function assertInsideCwd(outDir) {
  const dir = resolveOutDir(outDir);
  const root = path.resolve(process.cwd());
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(
      `outDir must stay inside the directory this server was started in (${root}) — got '${outDir}' -> ${dir}. ` +
        "Pass a relative path like 'design' or 'src/design'."
    );
  }
  return dir;
}

// quiet: layer files are written by the hundred and get ONE summary line instead of one line each.
function writeJson(dir, name, obj, quiet, log) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
  if (!quiet && log) log("wrote " + path.join(dir, name));
}

// Materialise the shared pages/ layout as real nested directories. The layout itself — bucketing,
// page-dir disambiguation, layer filenames, index shape, pageDirs — lives in pages-layout.js, which
// the plugin's browser-download twin builds from too (with "__" instead of "/"), so the two writers
// cannot drift. This function only creates directories and writes bytes.
function writePages(dir, layersDoc, log) {
  const pdir = path.join(dir, "pages");
  fs.mkdirSync(pdir, { recursive: true }); // guarantee pages/ exists even for a zero-layer run
  const { meta, layerFiles, indexFiles, rootIndex } = buildPageLayout(layersDoc, "/");
  for (const p of meta.pageDirs) fs.mkdirSync(path.join(pdir, p.dir), { recursive: true }); // once per PAGE, not per layer
  for (const f of layerFiles) writeJson(dir, f.path, f.data, true);
  for (const f of indexFiles) writeJson(dir, f.path, f.data, false, log);
  writeJson(dir, rootIndex, meta, false, log);
  if (log) log("wrote " + layerFiles.length + " layer file(s) across " + meta.pageDirs.length + " page dir(s) under " + pdir);
  return { meta, layerFiles: layerFiles.length, pageDirs: meta.pageDirs.length, rootIndex };
}

// The design-system twin of writePages: the SPLIT (which keys land in which file, the local/library
// component partition, the slim manifest) lives in design-system-layout.js, which the plugin's
// browser-download path builds from too, so the two writers cannot drift. This only writes bytes.
function writeDesignSystem(dir, designSystem, log) {
  const built = buildDesignSystemLayout(designSystem, "/");
  fs.mkdirSync(path.join(dir, built.dir), { recursive: true });
  for (const f of built.files) writeJson(dir, f.path, f.data, false, log);
  const counts = built.counts;
  return counts;
}

// The library twin of writeDesignSystem. Writes into libraries/<slug>-<fileKey8>/ — a tree that by
// construction never intersects design-system/ or pages/, so a library pull cannot overwrite the design
// file's own catalog (they are separate Figma files answering separate questions; see library-layout.js).
//
// Re-export is idempotent — every file is rewritten in place with a fresh stamp — but writeJson only
// ever WRITES, so a file a previous export produced and this one did not stays on disk, stale yet
// carrying a believable old timestamp. Rather than delete files a read command did not create, we diff
// this run's pointer map against the previous index and REPORT what is now orphaned. The user decides.
function writeLibrary(dir, designSystem, log) {
  const built = buildLibraryLayout(designSystem, "/");
  const ldir = path.join(dir, built.dir);

  let prevIndexDoc = null;
  try { prevIndexDoc = JSON.parse(fs.readFileSync(path.join(ldir, INDEX), "utf8")); } catch (e) {} // absent/corrupt = first export

  fs.mkdirSync(ldir, { recursive: true });
  for (const f of built.files) writeJson(dir, f.path, f.data, false, log);

  const orphans = [];
  if (prevIndexDoc && prevIndexDoc.files) {
    const now = new Set(built.files.map((f) => f.path));
    for (const p of Object.values(prevIndexDoc.files)) {
      if (typeof p === "string" && !now.has(p) && fs.existsSync(path.join(dir, p))) orphans.push(p);
    }
  }
  if (orphans.length && log) {
    log("STALE: " + orphans.length + " file(s) from a previous export are no longer produced and were NOT deleted: " + orphans.join(", "));
  }

  // Merge, never overwrite: each library is its own plugin run in its own file, so exporting library B
  // must not erase library A's row.
  const rootIndex = path.join(dir, ROOT, INDEX);
  let prevRoot = null;
  try { prevRoot = JSON.parse(fs.readFileSync(rootIndex, "utf8")); } catch (e) {}
  writeJson(dir, ROOT + "/" + INDEX, mergeLibrariesIndex(prevRoot, built), false, log);

  return { dir: built.dir, counts: built.counts, publish: built.manifest.publish, orphans };
}

function writeAssets(dir, assets, log) {
  if (!assets || !assets.length) return 0;
  const adir = path.join(dir, "assets");
  fs.mkdirSync(adir, { recursive: true });
  let n = 0;
  for (const a of assets) {
    // a.file is the name the plugin already put in the tree's `asset` path — write exactly that.
    const file = path.join(adir, path.basename(a.file));
    if (a.text != null) fs.writeFileSync(file, a.text);
    else if (a.base64 != null) fs.writeFileSync(file, Buffer.from(a.base64, "base64"));
    else continue; // manifest-only entry (e.g. an asset the plugin skipped) — nothing to write
    n++;
  }
  if (log) log("wrote " + n + " asset(s) to " + adir);
  return n;
}

// The whole-export write, shared by the CLI's default path and the MCP export tools' writeToDisk
// path. Returns the COMPACT INDEX — counts and paths, never node payloads — which is precisely what
// an MCP tool should hand back in place of the export itself: the agent then Reads/Greps the files
// at whatever granularity it actually needs, instead of paying for the whole tree in context.
function writeExport(outDir, r, log) {
  const dir = resolveOutDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  // A library catalog is routed by the PRODUCER's own flag (`source.role`), not by a CLI-side guess:
  // the plugin is the only thing that knows which file it ran in, and misrouting would overwrite the
  // design file's catalog with a library's.
  const isLib = !!(r.designSystem && r.designSystem.source && r.designSystem.source.role === "library");
  if (isLib) {
    const lib = writeLibrary(dir, r.designSystem, log);
    return { outDir: dir, wrote: { library: lib.dir, libraryCounts: lib.counts, publish: lib.publish, orphans: lib.orphans } };
  }
  const ds = r.designSystem ? writeDesignSystem(dir, r.designSystem, log) : null;
  const pages = r.layersDoc ? writePages(dir, r.layersDoc, log) : null;
  const assets = writeAssets(dir, r.assets, log);
  return {
    outDir: dir,
    wrote: {
      designSystem: !!r.designSystem,
      designSystemCounts: ds || undefined,
      layerFiles: pages ? pages.layerFiles : 0,
      pageDirs: pages ? pages.pageDirs : 0,
      assets,
      assetsSkipped: Array.isArray(r.assets) ? r.assets.length - assets : 0,
    },
    index: pages ? pages.meta : undefined,
  };
}

// The selection/single-node export has a different SHAPE than the full one — one `screen` tree plus
// `variables`, no designSystem/layersDoc — so it gets its own writer rather than a branch inside
// writeExport. The screen filename comes from safe(screenName), the same sanitiser the CLI's
// --selection path has always used, so an MCP-written screen file is named identically to a
// CLI-written one. Asset filenames are NOT sanitised here: the plugin owns them (see writeAssets).
function writeScreen(outDir, r, log) {
  const dir = resolveOutDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = safe(r.screenName || "screen") + ".json";
  writeJson(dir, name, r.screen, false, log);
  if (r.variables) writeJson(dir, "variables.json", r.variables, false, log);
  const assets = writeAssets(dir, r.assets, log);
  return {
    outDir: dir,
    wrote: { screen: path.join(dir, name), variables: !!r.variables, assets, assetsSkipped: Array.isArray(r.assets) ? r.assets.length - assets : 0 },
  };
}

// Dispatch on the RESULT shape, so each export tool forwards whatever the plugin sent without
// having to know which writer its own command implies.
function writeAny(outDir, r, log) {
  return r && r.screen ? writeScreen(outDir, r, log) : writeExport(outDir, r, log);
}

module.exports = { resolveOutDir, assertInsideCwd, writeJson, writePages, writeDesignSystem, writeLibrary, writeAssets, writeExport, writeScreen, writeAny };
