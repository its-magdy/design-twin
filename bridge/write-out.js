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
// because snapshot-meta.js and design-to-code/drift-lint.js both read that stamp back off disk.
const fs = require("fs");
const path = require("path");
const { buildPageLayout, screenPaths, mergeScreenIndex, mergeRootIndex, deriveTitle, collectTexts, safe } = require("./pages-layout.js");
const { buildDesignSystemLayout } = require("./design-system-layout.js");
const { buildLibraryLayout, mergeLibrariesIndex, ROOT, INDEX } = require("./library-layout.js");
const { mergeVariablesDoc } = require("./variables-merge.js");
const { sha1Hex, normalizeForCompare } = require("./asset-compare.js");

// outDir is resolved against the CURRENT WORKING DIRECTORY on purpose: for the MCP server that is
// the project Claude Code was started in, so an export lands in the project you are building — not
// next to the bridge's own source. FIGMA_EXPORT_DIR is the same env var snapshot-meta.js already
// reads, so figma_status looks for the snapshot exactly where this wrote it.
//
// The default is design/EXPORT, not design/. design/ had become two kinds of file under one name:
// what a pull writes and may overwrite (pages/, design-system/, assets/, variables.json) and what a
// human or a build step owns and cannot regenerate (target.json, the component map, plan/, audit/,
// verify/). "Delete design/ and re-pull" is the obvious recovery move and it silently destroyed the
// second kind. One subdirectory draws the line where it can be seen: everything dtwin writes is under
// design/export/, and nothing else is.
const { EXPORT_DIR: DEFAULT_OUT_DIR } = require("./project-layout.js");
function resolveOutDir(outDir) {
  return path.resolve(process.cwd(), outDir || process.env.FIGMA_EXPORT_DIR || DEFAULT_OUT_DIR);
}

// The CLI's outDir is a positional the USER typed — an absolute path or a sibling directory there is
// a legitimate choice. The MCP's outDir is a tool argument the MODEL supplies, and `path.resolve`
// happily honours "../../.." or "/tmp/anything", so an export could land anywhere the process can
// write. Confine that side to the directory the server was started in — which is also exactly what
// the option promises ("relative to your project"). Trust boundary, not a filesystem subtlety:
// applied where the value is untrusted, not inside resolveOutDir, so the CLI keeps its freedom.
// `what` names the ARGUMENT in the message: this guards exportDir and map too, and telling a model its
// `outDir` is wrong when it never passed one sends it looking for the wrong thing.
function assertInsideCwd(outDir, what = "outDir") {
  const dir = resolveOutDir(outDir);
  const root = path.resolve(process.cwd());
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(
      `${what} must stay inside the directory this server was started in (${root}) — got '${outDir}' -> ${dir}. ` +
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
  // COMPONENT_SET detail files land one level deeper, at manifest.files.componentsDir — only created
  // when at least one entry actually produced a detail file (variantVisuals opt-in).
  // Present only when a detail file was actually produced (design-system-layout.js omits the pointer
  // otherwise, so `files` never names a directory that does not exist).
  const componentsDir = built.manifest.files.componentsDir;
  if (componentsDir && built.files.some((f) => f.path.startsWith(componentsDir + "/"))) {
    fs.mkdirSync(path.join(dir, componentsDir), { recursive: true });
  }
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

// A flattened illustration arrives as one SVG with thousands of <path> elements. The live run hit a
// 2.47 MB empty-state graphic that inlined into a 2.71 MB JS bundle — moving that ONE file to a URL
// import cut the bundle 11x (finding 72). The export is faithful; the problem is that nothing said so
// until a bundler did, hours later. Flag it here, where the bytes are in hand and the answer is still
// "ask the designer to re-export it as a PNG", not "redraw it".
const BIG_ASSET_BYTES = 250 * 1024;
const BUSY_SVG_PATHS = 400;

// assets/ is SHARED and CUMULATIVE across pulls (design/README.md; finding 20 — accumulate, don't
// replace, is deliberate and stays). What is NOT acceptable is a later pull silently overwriting an
// earlier screen's file under the same name (finding 23/104/125) — including a same-name collision
// that differs only in CASE, which is one path on macOS's default case-insensitive filesystem (finding
// 124: `angle-left.svg` vs `Angle-left.svg`). So every write here is refuse-or-version, never clobber:
// if a file already on disk (matched case-INSENSITIVELY, since that is the filesystem's own rule)
// has different bytes than what this pull is about to write, the NEW one gets a content-hash suffix
// instead of overwriting — mirroring exactly the suffixing the plugin's own `register()` does for a
// same-run collision (figma-plugin/src/assets.ts). Identical bytes are left alone (no-op, not a
// rewrite) so an unrelated re-pull doesn't touch a file's mtime for nothing.
//
// `a.file` (and therefore anything that reads it afterwards — writeScreenAssets, called right after
// this on the same array, and the `entry.assets`/`root.reference` pointers in writeScreen) is mutated
// in place to the name ACTUALLY written, so nothing downstream can point at a name this function
// decided not to use.
function readExistingDirCaseFold(adir) {
  const map = new Map(); // lowercased basename -> real basename on disk
  let names = [];
  try { names = fs.readdirSync(adir); } catch (e) { /* doesn't exist yet */ }
  for (const n of names) map.set(n.toLowerCase(), n);
  return map;
}

// The CONTENT half of dedup, keyed independent of name — the gap the name-only check above cannot
// close. A name-only check reuses `angle-left.svg` only when the NEW asset is ALSO named
// `angle-left.svg` (mod case); it writes a second copy of the exact same icon under a name the plugin
// (or a different screen's pull) happened to pick instead, which is finding 24/live evidence: a real
// three-screen pull with this fix already live still produced `Ellipse_2327.svg`,
// `Ellipse_2327-e9af26.svg`, `Ellipse_2327-51bd18.svg` AND `Ellipse_2327-51bd18_1.svg` — four files,
// one icon — because each pull's own suffix (assigned by the PLUGIN's per-run `byName`, or by an
// earlier version of this file) was a different, equally-valid-looking name, and writeAssets only ever
// asked "is anything ALREADY WRITTEN under THIS exact name" instead of "does this content already
// exist ANYWHERE in the shared directory". Built once per writeAssets() call over the files ALREADY on
// disk (sharedAssetHashes() does the identical scan for the duplicates report — same map, same
// semantics, so a file this function reuses can never show up as a `duplicates` entry afterwards).
function readExistingDirByContent(adir) {
  const map = new Map(); // normalised sha1 -> real basename on disk
  let names = [];
  try { names = fs.readdirSync(adir); } catch (e) { return map; }
  for (const name of names) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(adir, name)); } catch (e) { continue; }
    const hash = sha1Hex(normalizeForCompare(name, bytes));
    if (!map.has(hash)) map.set(hash, name); // first (alphabetically-readdir'd) name wins ties
  }
  return map;
}

function shortHashOf(a, bytes) {
  // Prefer the plugin's own contentHash (already normalised for SVG-export noise); fall back to a
  // fresh sha1 of the bytes for an asset that somehow has no `.hash` (manifest-only / older plugin).
  if (typeof a.hash === "string" && a.hash) return a.hash.replace(/[^a-z0-9]/gi, "").slice(0, 6);
  return require("crypto").createHash("sha1").update(bytes).digest("hex").slice(0, 6);
}

// Reuse `existingName`'s bytes for `a`: point `a.file` at it, and replace `a.text`/`a.base64` with the
// ACTUAL on-disk bytes so the manifest (writeScreenAssets, called right after this on the same array)
// hashes what is really there — a normalised-equal-but-byte-different re-pull must never record a hash
// for content that was never written (findings 23/104's "recorded hash matches nothing on disk", just
// introduced by a naive fix instead of closed by one).
function reuseExisting(a, dirPrefix, existingName, priorBytes) {
  a.file = dirPrefix + "/" + existingName;
  if (a.text != null) a.text = priorBytes.toString("utf8");
  else if (a.base64 != null) a.base64 = priorBytes.toString("base64");
}

function writeAssets(dir, assets, log, subdir) {
  if (!assets || !assets.length) return 0;
  const adir = path.join(dir, subdir || "assets");
  fs.mkdirSync(adir, { recursive: true });
  const existing = readExistingDirCaseFold(adir); // lower -> real name already on disk
  const claimed = new Map(); // lower -> real name this call has written/claimed so far (this batch)
  for (const [k, v] of existing) claimed.set(k, v);
  // normalised sha1 -> real name, seeded from disk and updated as THIS call writes new content, so two
  // assets in the SAME pull that happen to share content (not just two pulls) also collapse to one file.
  const byContent = readExistingDirByContent(adir);
  const heavy = [];
  let n = 0;
  for (const a of assets) {
    let bytes;
    if (a.text != null) bytes = Buffer.from(a.text, "utf8");
    else if (a.base64 != null) bytes = Buffer.from(a.base64, "base64");
    else continue; // manifest-only entry (e.g. an asset the plugin skipped) — nothing to write

    let baseName = path.basename(a.file);
    const dirPrefix = path.dirname(a.file); // usually "assets"

    // CONTENT check FIRST, independent of what name this asset arrived under (finding 24/25/27): a
    // name-only check only ever catches "this pull picked the SAME name as something already there".
    // It has no way to see that `Ellipse_2327-e9af26.svg`'s bytes are already on disk as
    // `Ellipse_2327.svg`, or that a drifted `arrow-down-<hash>.svg` is already there under a different
    // hash suffix from an earlier pull — which is exactly the shape a live three-screen pull produced
    // (4 Ellipse_2327* files, 6 arrow-down* files, 3 angle-left* files for what should be 1/1/2 real
    // icons) even with the name-only reuse path already in place.
    const contentHash = sha1Hex(normalizeForCompare(baseName, bytes));
    const byContentName = byContent.get(contentHash);
    if (byContentName !== undefined) {
      let priorBytes = null;
      try { priorBytes = fs.readFileSync(path.join(adir, byContentName)); } catch (e) { /* fall through as new */ }
      if (priorBytes) {
        reuseExisting(a, dirPrefix, byContentName, priorBytes);
        n++; // counted as written even though the on-disk file was left untouched
        continue;
      }
    }

    let key = baseName.toLowerCase();
    const priorName = claimed.get(key);
    if (priorName !== undefined) {
      // Reaching here means the CONTENT check above already ruled out "this is the same asset under
      // any name" — so a name collision at this point is a same-name (mod case) DIFFERENT asset, full
      // stop. It never fires for a content-duplicate any more, which is also the fix for the `_1` guard
      // bug: `Ellipse_2327-51bd18_1.svg` used to happen because a genuinely identical asset reached this
      // branch (the content check didn't exist yet) with a hash-suffixed name that ALSO already existed
      // (both suffix attempts were the exact same 6 hex chars, since both were hashes of the SAME
      // content) — the guard's `_N` was masking a content-dedup failure, not resolving a real 6-hex
      // collision. With content checked first, the guard can now only ever fire on a genuine collision
      // between two DIFFERENT assets' hash suffixes, which is the vanishingly-unlikely case its comment
      // always claimed it was.
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      baseName = stem + "-" + shortHashOf(a, bytes) + ext;
      key = baseName.toLowerCase();
      let guard = 0;
      while (claimed.has(key) && guard++ < 5) { baseName = stem + "-" + shortHashOf(a, bytes) + "_" + guard + ext; key = baseName.toLowerCase(); }
    }
    const file = path.join(adir, baseName);
    fs.writeFileSync(file, bytes);
    claimed.set(key, baseName);
    byContent.set(contentHash, baseName); // so a LATER asset in this same call also dedups against it
    a.file = dirPrefix + "/" + baseName; // downstream (writeScreenAssets, index entries) reads this
    const paths = a.text != null ? (a.text.match(/<path\b/g) || []).length : 0;
    // Finding 324: the whole-frame reference PNG (a.kind === "reference") is never inlined or shipped
    // — writeScreenAssets already excludes it from `count`/`totalBytes` and its own `heavy` list for
    // exactly this reason (finding 28's comment). This pull-time warning must agree: a "20174_143363_
    // ref.png 0.25 MB is too heavy to inline" is pure noise about a file the app never inlines.
    if (a.kind !== "reference" && (bytes.length >= BIG_ASSET_BYTES || paths >= BUSY_SVG_PATHS)) heavy.push({ file: baseName, node: a.id, bytes: bytes.length, paths });
    n++;
  }
  if (log) log("wrote " + n + " asset(s) to " + adir);
  if (log && heavy.length) {
    heavy.sort((x, y) => y.bytes - x.bytes);
    log(
      "warn  " + heavy.length + " asset(s) are too heavy to inline — " +
        heavy.slice(0, 3).map((h) => `${h.file} ${(h.bytes / 1048576).toFixed(2)} MB${h.paths ? ` / ${h.paths} <path> elements` : ""}`).join(", ") +
        (heavy.length > 3 ? ", …" : "")
    );
    log(
      "      A flattened texture or illustration exports as thousands of vector paths. Inlining one of these " +
        "can dominate your whole bundle. Import it by URL, or ask the designer to re-export it as a PNG — do not redraw or simplify it yourself."
    );
  }
  return n;
}

// A high `assetsGeometry` count means a large share of this screen's icons could not be exported as
// SVG and were recovered as raw path data instead (figma-plugin/src/assets.ts geometryOf) — usable,
// but a strictly worse asset than a real export. Finding 30: 40% of a screen's nodes fell back this
// way with `manifest.warnings: []` and no pull-time signal at all — the tool warned unprompted about a
// heavy SVG (see BIG_ASSET_BYTES above) but stayed silent about degraded icon exports an order of
// magnitude more consequential. Exported for the caller that has the manifest in hand (writeScreen —
// owned outside this file; not called from here so as not to reach into that function) to log
// alongside its other per-screen output.
const ASSETS_GEOMETRY_WARN_RATIO = 0.1; // 10%+ of nodes recovered as raw geometry is worth a line
function assetsGeometryWarning(manifest) {
  const nodes = manifest && typeof manifest.nodes === "number" ? manifest.nodes : 0;
  const geo = manifest && typeof manifest.assetsGeometry === "number" ? manifest.assetsGeometry : 0;
  if (!nodes || !geo) return null;
  const ratio = geo / nodes;
  if (ratio < ASSETS_GEOMETRY_WARN_RATIO) return null;
  return `warn  ${geo} of ${nodes} nodes (${Math.round(ratio * 100)}%) fell back to raw geometry instead of an SVG export — ` +
    `usable, but check a sample of these icons; a bulk fallback like this usually means the source vectors have an ` +
    `unusual paint/blend setup Figma's exporter can't rasterize.`;
}

// Reference PNGs land in assets/, the same place a --node pull puts the frame's own reference.
//
// They used to get their own screenshots/ subdir on the theory that a discovery screenshot is not a
// shipped asset. In practice (live-test findings 20/31/34) that produced three different answers to
// "where is the PNG?" — the skill said screenshots/, `dtwin help` said assets/, the success message
// and the `reference` field both printed assets/ while the byte landed in screenshots/ — and when
// the node was later pulled, the pull wrote a byte-identical copy into assets/ anyway. One
// directory, one name, no duplicate: shoot a node during discovery and the PNG is already in the
// place build-screen reads, whether or not you go on to pull it.
const REF_DIR = "assets";
function writeScreenshot(outDir, r, log) {
  const dir = resolveOutDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const assets = writeAssets(dir, r.assets, log, REF_DIR);
  // The path the caller should PRINT. `r.reference` is the plugin's own relative name; recomputing it
  // here from the file actually written is what keeps the message and the file in agreement.
  const first = (r.assets || []).find((a) => a && a.file);
  const reference = first ? REF_DIR + "/" + path.basename(first.file) : r.reference;
  return { outDir: dir, reference, wrote: { screenshot: true, assets, reference } };
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
  // P4 #33: figma-pull.js resolves which connected Figma file this pull talked to and stamps it as
  // `r.sourceFile`/`r.sourceFileKey` (the plugin itself has no reason to know its own bridge-side
  // connection id). Forward it onto layersDoc so buildPageLayout can carry it onto every per-page
  // layer file/index row — the same field writeScreen below stamps for a single-screen pull.
  if (r.layersDoc && r.sourceFile && r.layersDoc.sourceFile === undefined) {
    r.layersDoc.sourceFile = r.sourceFile;
    if (r.sourceFileKey) r.layersDoc.sourceFileKey = r.sourceFileKey;
  }
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
// writeExport.
//
// It files into the SAME pages/ tree a --page pull writes: pages/<Page>/<Name>__<id>.json, with the
// pull's token slice and its asset index as siblings. Flat design/<Screen>.json is gone — it named
// files from the layer alone, so two frames called "Popup" overwrote each other, and it left a
// --node project with no index, no page context and nothing sync-design or verify could address
// (live findings 47/50/63). Screens ARRIVE one pull at a time, so both indexes merge with what is
// already on disk rather than being recomputed in one pass like buildPageLayout's.
//
// Asset filenames are still NOT sanitised here: the plugin owns them (see writeAssets).
function writeScreen(outDir, r, log) {
  const dir = resolveOutDir(outDir);
  const paths = screenPaths(r, "/");
  fs.mkdirSync(path.join(dir, "pages", paths.dir), { recursive: true });

  // P4 #33: stamp which Figma file this pull actually talked to, straight onto the screen doc's own
  // top level — the ONE thing doctor.js's exportSourceCounts() can read without opening a second file, and
  // the reason a project pulled before this field existed is told apart from one whose source is
  // simply unknown (undefined, never a guess). figma-pull.js resolves it; this is just where it lands.
  const screenDoc = r.sourceFile
    ? Object.assign({}, r.screen, { sourceFile: r.sourceFile }, r.sourceFileKey ? { sourceFileKey: r.sourceFileKey } : {})
    : r.screen;
  writeJson(dir, paths.screen, screenDoc, false, log);
  const variables = r.variables ? writeScreenVariables(dir, paths, r.variables, log) : null;
  const assets = writeAssets(dir, r.assets, log);
  const assetIndex = writeScreenAssets(dir, paths, r.assets);
  // Finding 30 / acceptance criterion 10: a screen whose icons largely fell back to raw geometry
  // (figma-plugin/src/assets.ts geometryOf) instead of a real SVG export gets a warning AT PULL TIME,
  // not only if someone happens to go looking in manifest.assetsGeometry later.
  if (log) { const gw = assetsGeometryWarning(r.screen && r.screen.manifest); if (gw) log(gw); }

  // The entry a consumer reads instead of guessing filenames. Every sibling this pull produced is a
  // POINTER here, for the same reason buildPageLayout emits real relative paths: a consumer that
  // reassembles `pages/<dir>/<base>.vars.json` from parts is right until the day one part changes.
  const root = (r.screen && r.screen.nodes && r.screen.nodes[0]) || {};
  // title/texts: findings 16/17/70/90/120 — the visible title a user types is a TEXT node inside the
  // frame, not the Figma layer name (`root.name`/`entry.name` below); see pages-layout.js deriveTitle.
  const title = deriveTitle(root);
  const texts = collectTexts(root);
  const entry = {
    name: (r.screen && r.screen.screen) || r.screenName,
    id: paths.nodeId || root.id,
    type: root.type,
    page: paths.page,
    pageId: paths.pageId,
    title,
    texts,
    exportedAt: r.screen && r.screen.exportedAt,
    sourceFile: r.sourceFile || undefined,
    file: paths.screen,
    variables: r.variables ? paths.variables : undefined,
    assets: assetIndex ? paths.assets : undefined,
    reference: root.reference,
    nodes: (r.screen && r.screen.manifest && r.screen.manifest.nodes) || undefined,
    w: root.box && root.box.w,
    h: root.box && root.box.h,
  };
  const pageIndex = mergeScreenIndex(readJsonOr(path.join(dir, paths.index), null), Object.assign({}, entry, { page: paths.page, pageId: paths.pageId }));
  writeJson(dir, paths.index, pageIndex, true);
  writeJson(dir, paths.rootIndex, mergeRootIndex(readJsonOr(path.join(dir, paths.rootIndex), null), paths, pageIndex.layers.length, entry), true);
  if (log) log(`indexed ${paths.screen} in ${paths.rootIndex} (page '${paths.page || "unfiled"}' now holds ${pageIndex.layers.length} screen(s))`);

  return {
    outDir: dir,
    wrote: {
      screen: path.join(dir, paths.screen),
      page: paths.page,
      index: path.join(dir, paths.rootIndex),
      variables: !!r.variables,
      variablesMerge: variables || undefined,
      assets,
      assetIndex: assetIndex || undefined,
      assetsSkipped: Array.isArray(r.assets) ? r.assets.length - assets : 0,
    },
  };
}

// Which colours an exported SVG hard-codes.
//
// Figma exports the frame as it LOOKS, so a Dark-mode icon arrives with `stroke="#D4D4D4"` baked in
// and the same file cannot serve a Light theme (live finding 73). Editing the asset is the wrong fix
// — the producer owns these files and a re-pull overwrites them — so the right move is to swap the
// colour for `currentColor` at RENDER time. But that is only safe for a glyph whose colour is purely
// thematic: a red trash icon and a green tick carry meaning, and recolouring those is a bug.
//
// One colour throughout = thematic, safe to recolour. More than one = semantic, leave it alone. The
// builder gets the answer per file instead of having to open each SVG.
function svgPalette(text) {
  const colors = new Set();
  for (const m of String(text).matchAll(/(?:fill|stroke)\s*=\s*"([^"]+)"/g)) {
    const v = m[1].trim().toLowerCase();
    if (v === "none" || v === "transparent" || v === "currentcolor" || v.startsWith("url(")) continue;
    colors.add(v);
  }
  const paths = (String(text).match(/<path\b/g) || []).length;
  return { colors: [...colors], monochrome: colors.size === 1, paths };
}

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback; // absent or corrupt — this pull is the first, or the last one was interrupted
  }
}

// Which assets belong to THIS screen, and which of them are byte-identical to each other.
//
// design/assets/ is flat, shared and cumulative: after three pulls it held 98 files and the only way
// to answer "which of these does THIS screen use" was to walk the screen JSON (live findings 50/97).
// This index answers it directly, and the content hash makes the duplication visible — the same
// sidebar icon exported once per instance path shows up as several names under one hash, so a
// consumer can import one file instead of five without diffing bytes itself.
// Every file's NORMALISED content hash (bridge/svg-normalize.js), over the WHOLE shared assets/
// directory — not just this pull's own array. `assets/` is explicitly shared and cumulative (see
// writeAssets' header), so a duplicate between this screen's icon and one a DIFFERENT screen's pull
// wrote is exactly as real as one within this pull, and finding 27 is precisely that a per-pull-array
// computation could never see it: "it cannot see the byte-identical Ellipse_2327 pair or the eight
// chevrons... it is computed from hashes that are already stale for four of the five screens." The
// clobber-avoidance fix in writeAssets means a NEW duplicate of this shape mostly can't be created
// going forward (a re-pull of an unchanged icon now reuses the existing file), but files already on
// disk from before that fix — or two independently-named layers that just happen to render the same
// icon — still need catching, hence a real directory scan rather than trusting the write history.
function sharedAssetHashes(assetsDir) {
  const out = new Map(); // normalised hash -> ["assets/<file>", ...]
  let names = [];
  try { names = fs.readdirSync(assetsDir); } catch (e) { return out; }
  for (const name of names) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(assetsDir, name)); } catch (e) { continue; }
    const hash = sha1Hex(normalizeForCompare(name, bytes));
    if (!out.has(hash)) out.set(hash, []);
    out.get(hash).push("assets/" + name);
  }
  return out;
}

function writeScreenAssets(dir, paths, assets) {
  if (!Array.isArray(assets) || !assets.length) return null;
  const shared = sharedAssetHashes(path.join(dir, "assets"));
  const files = [];
  const reference = []; // the frame's own screenshot — see note below on why it's split out
  const dupHashes = new Set();
  for (const a of assets) {
    if (!a || !a.file) continue;
    const bytes = a.text != null ? Buffer.from(a.text, "utf8") : a.base64 != null ? Buffer.from(a.base64, "base64") : null;
    const hash = bytes ? sha1Hex(bytes) : null; // exact bytes-on-disk hash (writeAssets keeps a.text/a.base64 in sync with disk on reuse)
    const file = "assets/" + path.basename(a.file);
    const entry = { file, node: a.id, bytes: bytes ? bytes.length : 0, hash };
    if (Array.isArray(a.from) && a.from.length > 1) entry.from = a.from; // one file, several nodes reached it
    if (a.text != null && /\.svg$/i.test(a.file)) Object.assign(entry, svgPalette(a.text));
    // The whole-frame reference PNG (a.kind === "reference", <id>_ref.png — see figma-plugin/src/assets.ts)
    // is a discovery/self-check aid, not a shippable UI asset: on one real screen it was 196,049 of
    // 312,234 total bytes (63%) and headed the `heavy` list purely because of its own size (finding 28).
    // It still gets a manifest ROW (build-screen looks it up), just not counted into `count`/`totalBytes`,
    // which exist to answer "how much of this do I actually ship".
    if (a.kind === "reference") { reference.push(entry); continue; }
    files.push(entry);
    const normHash = bytes ? sha1Hex(normalizeForCompare(a.file, bytes)) : null;
    if (normHash && (shared.get(normHash) || []).length > 1) dupHashes.add(normHash);
  }
  const duplicates = [...dupHashes].map((hash) => {
    const group = shared.get(hash);
    const first = files.find((f) => group.includes(f.file));
    return { hash, bytes: first ? first.bytes : undefined, files: group };
  });
  const monochrome = files.filter((f) => f.monochrome).map((f) => f.file);
  const heavy = files.filter((f) => f.bytes >= BIG_ASSET_BYTES || f.paths >= BUSY_SVG_PATHS).map((f) => ({ file: f.file, bytes: f.bytes, paths: f.paths }));
  const doc = {
    screen: paths.base,
    count: files.length,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    duplicates,
    monochrome,
    heavy,
    reference: reference.length ? reference : undefined,
    note:
      "Every SHIPPABLE asset this screen references, with a content hash. `duplicates` is computed over " +
      "the WHOLE shared assets/ directory (every screen ever pulled), not just this screen's own files, " +
      "and treats two SVGs as the same asset when they agree modulo Figma's own sub-pixel export noise " +
      "(bridge/svg-normalize.js) — so it also catches the same icon exported under two different names or " +
      "in two different pulls. `monochrome` lists the SVGs whose every fill/stroke is one colour — those " +
      "are the ones safe to recolour to currentColor at render time; the rest carry semantic colour (a red " +
      "trash, a green tick) and must keep it. `heavy` lists assets too large to inline. `reference` (if " +
      "present) is the frame's own whole-screen screenshot — useful for visual comparison, not something " +
      "the app ships, so it is excluded from `count`/`totalBytes`. Never edit an exported asset in place: " +
      "the producer owns these filenames and a re-pull will overwrite them.",
    files,
  };
  writeJson(dir, paths.assets, doc, true);
  return { count: files.length, duplicates: duplicates.length, totalBytes: doc.totalBytes };
}

// variables.json is the ONE file two single-screen pulls share, and it used to be replaced wholesale
// — so pulling screen B deleted screen A's tokens (live-test findings 35/64). It now accumulates:
// the raw per-pull slice is kept verbatim under variables/<Screen>.json, and variables.json is the
// union of every slice, keyed on each variable's Figma key. See variables-merge.js for the rules.
function writeScreenVariables(dir, paths, slice, log) {
  writeJson(dir, paths.variables, slice, true);

  const target = path.join(dir, "variables.json");
  let prev = readJsonOr(target, null);
  const { doc, stats } = mergeVariablesDoc(prev, slice, { screen: paths.base, file: paths.screen });
  writeJson(dir, "variables.json", doc, true);

  if (log) {
    const sliceN = Array.isArray(slice.variables) ? slice.variables.length : 0;
    if (stats.first) {
      log(`wrote ${target} — ${sliceN} variable(s) from this screen (later pulls MERGE into this file, they do not replace it)`);
    } else {
      log(
        `merged ${target} — ${sliceN} from this screen -> ${doc.variables.length} total across ${doc._slices.length} screen(s) ` +
          `(+${stats.added} new, ${stats.kept} already known)`
      );
    }
    if (stats.conflicts.length) {
      log(
        `warn  ${stats.conflicts.length} variable(s) resolve DIFFERENTLY in this screen than in an earlier pull — newest kept, all listed under _conflicts: ` +
          stats.conflicts.slice(0, 3).map((c) => `'${c.name}'`).join(", ") +
          (stats.conflicts.length > 3 ? ", …" : "")
      );
    }
    log(`wrote ${path.join(dir, paths.variables)} — this screen's slice on its own`);
  }
  return { total: doc.variables.length, fromThisScreen: Array.isArray(slice.variables) ? slice.variables.length : 0, added: stats.added, conflicts: stats.conflicts.length, screens: doc._slices.length };
}

// Dispatch on the RESULT shape, so each export tool forwards whatever the plugin sent without
// having to know which writer its own command implies.
function writeAny(outDir, r, log) {
  if (r && r.screen) return writeScreen(outDir, r, log);
  // A screenshot result has none of designSystem/layersDoc/screen, only id/name/type/reference/assets
  // — `reference` is the tell that distinguishes it from a real export.
  if (r && r.reference && !r.designSystem && !r.layersDoc) return writeScreenshot(outDir, r, log);
  return writeExport(outDir, r, log);
}

// How many characters an INLINE tool result may be before the MCP client truncates it. Claude Code caps
// tool output at MAX_MCP_OUTPUT_TOKENS (default 25,000); ~4 characters per token, and 20% headroom
// because that ratio is an estimate and indented JSON tokenizes worse than prose.
function inlineLimitChars(env = process.env) {
  const tokens = Number(env.MAX_MCP_OUTPUT_TOKENS);
  return Math.floor((tokens > 0 ? tokens : 25000) * 4 * 0.8);
}

module.exports = { DEFAULT_OUT_DIR, inlineLimitChars, resolveOutDir, assertInsideCwd, writeJson, writePages, writeDesignSystem, writeLibrary, writeAssets, writeScreenAssets, assetsGeometryWarning, writeScreenshot, writeScreenVariables, writeExport, writeScreen, writeAny };
