// write-out.ts — the ONE place an export lands on disk.
//
// Both read clients write through this module: the figma-pull CLI (which writes to disk)
// and the MCP export tools (which strip asset bytes from their replies to keep megabytes out of the
// agent's context — without a disk path an MCP-only session could never produce assets/, and the CLI
// could not be run to fill the gap because both bind port 8787 and the second one to start exits on
// EADDRINUSE). Writing here and returning a compact INDEX is what makes
// the MCP path complete on its own.
//
// The freshness stamp (`exportedAt`/`file`) is stamped by the PLUGIN (collect.ts/components.ts).
// Nothing here adds, strips or re-derives it — writeJson writes what it was handed, byte for byte,
// because snapshot-meta.ts and design-to-code/drift-lint.ts both read that stamp back off disk.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { buildPageLayout, screenPaths, mergeScreenIndex, mergeRootIndex, deriveTitle, collectTexts } from "./pages-layout.ts";
import type { ScreenPaths, ScreenIndexRow } from "./pages-layout.ts";
import { buildDesignSystemLayout } from "./design-system-layout.ts";
import type { DesignSystemLayout } from "./design-system-layout.ts";
import { buildLibraryLayout, mergeLibrariesIndex, ROOT, INDEX } from "./library-layout.ts";
import { mergeVariablesDoc } from "./variables-merge.ts";
import { sha1Hex, normalizeForCompare, ContentIndex, contentKey, fileKeyCache } from "./asset-compare.ts";
import { isRasterShell } from "./svg-normalize.ts";
import { collectGraphics, reuseHiddenAssets, usesByPointer } from "./asset-owners.ts";
import type { AssetContext, AssetOwner, Graphic, ReuseResult } from "./asset-owners.ts";
import { EXPORT_DIR as DEFAULT_OUT_DIR } from "./project-layout.ts";
import { ifDefined, isRecord } from "./json-util.ts";
import { errMsg, errCode } from "./errmsg.ts";
import { QUICK_KEYS, SCHEMA_DOC_NAME, SCHEMA_MARKER } from "./quick-keys.ts";
import type { Asset, DesignSystemDoc, IrNode, LayersDoc, Manifest, PagesRootIndex, VariablesDoc, LibraryCounts } from "./doc-types.ts";
import type { DesignSystemReply, ExportReply, FullExportReply, ScreenReply, ScreenshotReply } from "./commands.ts";

// ---- what the plugin hands this module (the `r` of every writer below): the per-command replies of
// commands.ts. writeAny tells them apart by the field only that reply carries (`screen`, `reference`),
// which is a real narrowing of the union, not a guess over one optional bag.

/** `sourceFile`/`sourceFileKey` are stamped by figma-pull.ts onto the reply before it reaches a
 *  writer — never by the plugin. */
export type Stamped<R> = R & { sourceFile?: string; sourceFileKey?: string };

export type Log = (m: string) => void;

// outDir is resolved against the CURRENT WORKING DIRECTORY on purpose: for the MCP server that is
// the project Claude Code was started in, so an export lands in the project you are building — not
// next to the bridge's own source. FIGMA_EXPORT_DIR is the same env var snapshot-meta.ts already
// reads, so figma_status looks for the snapshot exactly where this wrote it.
//
// The default is design/EXPORT, not design/. design/ had become two kinds of file under one name:
// what a pull writes and may overwrite (pages/, design-system/, assets/, variables.json) and what a
// human or a build step owns and cannot regenerate (target.json, the component map, plan/, audit/,
// verify/). "Delete design/ and re-pull" is the obvious recovery move and it silently destroyed the
// second kind. One subdirectory draws the line where it can be seen: everything dtwin writes is under
// design/export/, and nothing else is.
function resolveOutDir(outDir?: string | null): string {
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
//
// Inside LEXICALLY, or inside once both sides are resolved through symlinks. On macOS /tmp, /var and
// /etc are symlinks into /private, and process.cwd() is getcwd() (already resolved) while a path the model
// builds from PWD or os.tmpdir() is not — so `/tmp/proj/design` was refused for a server started in
// /tmp/proj. The returned path stays the lexical one (path.resolve has already folded every `..`, so a
// `..` after a symlink cannot steer the write). A link inside the project that points outside is accepted,
// as it always was lexically; a path whose real location is outside (`<alias>/x`, alias → elsewhere) is not.
//
// A server started in the filesystem root (`/`, or a drive root on Windows — some MCP hosts launch stdio
// servers there) accepts only the root itself: every path is "inside" `/`, so treating it like any other
// cwd would let a model-chosen outDir/exportDir/map reach anywhere. So nothing below the root is accepted there.
const isFsRoot = (p: string): boolean => path.parse(p).root === p;
function isInside(dir: string, root: string): boolean {
  if (dir === root) return true;
  return !isFsRoot(root) && dir.startsWith(root + path.sep);
}
// realpath of the longest EXISTING prefix with the not-yet-existing tail re-appended: a fresh outDir does
// not exist yet, and realpath of a missing path throws.
function realish(p: string): string {
  const tail: string[] = [];
  let head = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return p;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}
function assertInsideCwd(outDir?: string | null, what = "outDir"): string {
  const dir = resolveOutDir(outDir);
  const root = path.resolve(process.cwd());
  if (isInside(dir, root)) return dir;
  const real = realish(dir);
  if (isInside(real, realish(root))) return dir;
  throw new Error(
    `${what} must stay inside the directory this server was started in (${root}) — got '${outDir}' -> ${dir}` +
      (real !== dir ? ` (real path ${real})` : "") + ". " +
      (isFsRoot(root)
        ? `This server was started in the filesystem root, where no ${what} is accepted — start it in your project directory.`
        : "Pass a relative path like 'design' or 'src/design'.")
  );
}

// quiet: layer files are written by the hundred and get ONE summary line instead of one line each.
//
// Written through atomic-write.ts (a tmp file beside the target, then a rename): a run killed mid-write
// (Ctrl-C, OOM on a big export) leaves the PREVIOUS file intact instead of a truncated JSON that every later
// reader fails on.
//
// `keep`: when passed, the file this write replaces is first copied to `<file>.prev` if its content
// differs (keepPrevCopy's rule: one level, stamps ignored) and the .prev path is pushed onto `keep`.
function writeJson(dir: string, name: string, obj: unknown, quiet?: boolean, log?: Log, keep?: string[]): void {
  const file = path.join(dir, name);
  const text = JSON.stringify(obj, null, 2);
  if (keep) { const prev = keepPrevCopy(file, text); if (prev) keep.push(prev); }
  writeFileAtomic(file, text);
  if (!quiet && log) log("wrote " + file);
}

// SCHEMA.md (scripting quick keys) beside the data: the field names a script needs, where a script-writing
// agent looks for them (the full reference, ir-fields.md, lives in the plugin and was never opened). The
// text is quick-keys.ts's QUICK_KEYS — one source with the ir-fields.md copy. The note names the reference
// by NAME, never a path: written files carry no filesystem paths.
//   absent → written; marked + identical → left alone (no mtime change, so a dev server's file watcher
//   sees nothing); marked + different → rewritten (info line); no marker → the user's own file, never touched.
// A failure here (read-only dir, SCHEMA.md is a directory) is a warning, never a failed pull.
const SCHEMA_NOTE = "<!-- Generated by dtwin, rewritten only when its text changes — do not edit. The full field reference is ir-fields.md in the designtwin plugin's build-screen skill. -->";
export const SCHEMA_DOC_TEXT = SCHEMA_MARKER + "\n" + SCHEMA_NOTE + "\n\n" + QUICK_KEYS;
function writeSchemaDoc(dir: string, log?: Log): void {
  const file = path.join(dir, SCHEMA_DOC_NAME);
  try {
    let prev: string | null = null;
    try { prev = fs.readFileSync(file, "utf8"); } catch (e) { if (errCode(e) !== "ENOENT") throw e; }
    if (prev !== null) {
      if (!prev.startsWith(SCHEMA_MARKER)) {
        if (log) log(`warn  ${SCHEMA_DOC_NAME} is not dtwin's (no generated marker on its first line) — the scripting quick keys were not written`);
        return;
      }
      if (prev === SCHEMA_DOC_TEXT) return;
    }
    writeFileAtomic(file, SCHEMA_DOC_TEXT);
    if (log && prev !== null) log(`info  updated ${SCHEMA_DOC_NAME} (scripting quick keys)`);
  } catch (e) {
    if (log) log(`warn  could not write ${SCHEMA_DOC_NAME}: ${errMsg(e)}`);
  }
}

// Materialise the shared pages/ layout as real nested directories. The layout itself — bucketing,
// page-dir disambiguation, layer filenames, index shape, pageDirs — lives in pages-layout.ts, which
// the plugin's browser-download twin builds from too (with "__" instead of "/"), so the two writers
// cannot drift. This function only creates directories and writes bytes.
function writePages(dir: string, layersDoc: LayersDoc | null | undefined, log?: Log, keep?: string[]): { meta: PagesRootIndex; layerFiles: number; pageDirs: number; rootIndex: string } {
  const pdir = path.join(dir, "pages");
  fs.mkdirSync(pdir, { recursive: true }); // guarantee pages/ exists even for a zero-layer run
  const { meta, layerFiles, indexFiles, rootIndex } = buildPageLayout(layersDoc, "/");
  for (const p of meta.pageDirs) fs.mkdirSync(path.join(pdir, p.dir), { recursive: true }); // once per PAGE, not per layer
  for (const f of layerFiles) writeJson(dir, f.path, f.data, true, undefined, keep);
  for (const f of indexFiles) writeJson(dir, f.path, f.data, false, log, keep);
  writeJson(dir, rootIndex, meta, false, log, keep);
  if (log) log("wrote " + layerFiles.length + " layer file(s) across " + meta.pageDirs.length + " page dir(s) under " + pdir);
  return { meta, layerFiles: layerFiles.length, pageDirs: meta.pageDirs.length, rootIndex };
}

// The design-system twin of writePages: the SPLIT (which keys land in which file, the local/library
// component partition, the slim manifest) lives in design-system-layout.ts, which the plugin's
// browser-download path builds from too, so the two writers cannot drift. This only writes bytes.
function writeDesignSystem(dir: string, designSystem: DesignSystemDoc | null | undefined, log?: Log, keep?: string[]): DesignSystemLayout["counts"] {
  const built = buildDesignSystemLayout(designSystem, "/");
  fs.mkdirSync(path.join(dir, built.dir), { recursive: true });
  // COMPONENT_SET detail files land one level deeper, at manifest.files.componentsDir — only created
  // when at least one entry actually produced a detail file (variantVisuals opt-in).
  // Present only when a detail file was actually produced (design-system-layout.ts omits the pointer
  // otherwise, so `files` never names a directory that does not exist).
  const componentsDir = built.manifest.files.componentsDir;
  if (componentsDir && built.files.some((f) => f.path.startsWith(componentsDir + "/"))) {
    fs.mkdirSync(path.join(dir, componentsDir), { recursive: true });
  }
  for (const f of built.files) writeJson(dir, f.path, f.data, false, log, keep);
  const counts = built.counts;
  return counts;
}

// The library twin of writeDesignSystem. Writes into libraries/<slug>-<fileKey8>/ — a tree that by
// construction never intersects design-system/ or pages/, so a library pull cannot overwrite the design
// file's own catalog (they are separate Figma files answering separate questions; see library-layout.ts).
//
// Re-export is idempotent — every file is rewritten in place with a fresh stamp — but writeJson only
// ever WRITES, so a file a previous export produced and this one did not stays on disk, stale yet
// carrying a believable old timestamp. Rather than delete files a read command did not create, we diff
// this run's pointer map against the previous index and REPORT what is now orphaned. The user decides.
function writeLibrary(dir: string, designSystem: DesignSystemDoc | null | undefined, log?: Log, keep?: string[]): { dir: string; counts: LibraryCounts; publish: Record<string, number> | undefined; orphans: string[] } {
  const built = buildLibraryLayout(designSystem, "/");
  const ldir = path.join(dir, built.dir);

  let prevIndexDoc: { files?: unknown } | null = null;
  try { prevIndexDoc = JSON.parse(fs.readFileSync(path.join(ldir, INDEX), "utf8")) as { files?: unknown }; } catch { /* absent/corrupt = first export */ }

  fs.mkdirSync(ldir, { recursive: true });
  for (const f of built.files) writeJson(dir, f.path, f.data, false, log, keep);

  const orphans: string[] = [];
  // `files` is the pointer map ({kind: path}); anything else (a string, an array) is a corrupt index —
  // walking it would report its characters/entries as orphans.
  const prevFiles = prevIndexDoc && prevIndexDoc.files;
  if (prevFiles && typeof prevFiles === "object" && !Array.isArray(prevFiles)) {
    const now = new Set(built.files.map((f) => f.path));
    for (const p of Object.values(prevFiles)) {
      if (typeof p === "string" && !now.has(p) && fs.existsSync(path.join(dir, p))) orphans.push(p);
    }
  }
  if (orphans.length && log) {
    log("STALE: " + orphans.length + " file(s) from a previous export are no longer produced and were NOT deleted: " + orphans.join(", "));
  }

  // Merge, never overwrite: each library is its own plugin run in its own file, so exporting library B
  // must not erase library A's row.
  const rootIndex = path.join(dir, ROOT, INDEX);
  let prevRoot: unknown = null;
  try { prevRoot = JSON.parse(fs.readFileSync(rootIndex, "utf8")) as unknown; } catch { /* first export */ }
  writeJson(dir, ROOT + "/" + INDEX, mergeLibrariesIndex(prevRoot, built), false, log, keep);

  return { dir: built.dir, counts: built.counts, publish: built.manifest.publish, orphans };
}

// A flattened illustration arrives as one SVG with thousands of <path> elements. The live run hit a
// 2.47 MB empty-state graphic that inlined into a 2.71 MB JS bundle — moving that ONE file to a URL
// import cut the bundle 11x. The export is faithful; the problem is that nothing said so
// until a bundler did, hours later. Flag it here, where the bytes are in hand and the answer is still
// "ask the designer to re-export it as a PNG", not "redraw it".
const BIG_ASSET_BYTES = 250 * 1024;
const BUSY_SVG_PATHS = 400;

// assets/ is SHARED and CUMULATIVE across pulls (design/README.md — accumulate, don't
// replace, is deliberate). What is NOT acceptable is a later pull silently overwriting an
// earlier screen's file under the same name — including a same-name collision
// that differs only in CASE, which is one path on macOS's default case-insensitive filesystem
// (`angle-left.svg` vs `Angle-left.svg`). So every write here is refuse-or-version, never clobber:
// if a file already on disk (matched case-INSENSITIVELY, since that is the filesystem's own rule)
// has different bytes than what this pull is about to write, the NEW one gets a content-hash suffix
// instead of overwriting — mirroring exactly the suffixing the plugin's own `register()` does for a
// same-run collision (figma-plugin/src/assets.ts). Identical bytes are left alone (no-op, not a
// rewrite) so an unrelated re-pull doesn't touch a file's mtime for nothing.
//
// `a.file` is mutated in place to the name ACTUALLY written. That alone does NOT move the node tree's
// pointers (`asset` on each node, `reference` on the root), which the plugin built from its own names:
// callers run writeAssets BEFORE writing the tree and then rewireAssetPointers() (otherwise
// nodes point at names never written, and on a case-insensitive disk at the wrong file).
function readExistingDirCaseFold(adir: string): Map<string, string> {
  const map = new Map<string, string>(); // lowercased basename -> real basename on disk
  let names: string[] = [];
  try { names = fs.readdirSync(adir); } catch { /* doesn't exist yet */ }
  for (const n of names) map.set(n.toLowerCase(), n);
  return map;
}

// The CONTENT half of dedup, keyed independent of name — the gap the name-only check above cannot
// close. A name-only check reuses `angle-left.svg` only when the NEW asset is ALSO named
// `angle-left.svg` (mod case); it writes a second copy of the exact same icon under a name the plugin
// (or a different screen's pull) happened to pick instead: a real
// three-screen pull showed that, with the name check in place, it still produced `Ellipse_2327.svg`,
// `Ellipse_2327-e9af26.svg`, `Ellipse_2327-51bd18.svg` AND `Ellipse_2327-51bd18_1.svg` — four files,
// one icon — because each pull's own suffix (assigned by the PLUGIN's per-run `byName`, or by an
// earlier version of this file) was a different, equally-valid-looking name, and writeAssets only ever
// asked "is anything ALREADY WRITTEN under THIS exact name" instead of "does this content already
// exist ANYWHERE in the shared directory".
//
// "The same content" is asset-compare.ts ContentIndex: an SVG fingerprint — def ids
// canonical, every number within SVG_TOL — or the exact bytes for anything else. A hash of v1's rounded
// text split real re-exports on three gaps (ids that embed the node id, `12` vs `11.9999`, a value either
// side of a 0.1 rounding boundary), so 11 copies of one icon stayed 11 files. Built ONCE per writeScreen /
// writeExport over the files ALREADY on disk, updated as writeAssets writes, and handed on to
// writeScreenAssets' `duplicates` — one scan, one rule, so a file writeAssets reuses can never show up
// as a `duplicates` entry it did not also see. A file unchanged since an earlier pull in this process is
// not read again (asset-compare.ts fileKeyCache says when a cached key may be used).
function buildContentIndex(adir: string): ContentIndex {
  const index = new ContentIndex();
  let names: string[] = [];
  try { names = fs.readdirSync(adir); } catch { return index; }
  for (const name of names) {
    const key = fileKeyCache.keyOf(path.join(adir, name), name);
    if (key) index.addKey(name, key);
  }
  return index;
}

// A file of THIS asset's own name family — `baseName` itself or `<stem>-<6 hex>[_N]<ext>`, the only names
// writeAssets ever gives it (matched case-insensitively, the disk's own rule) — whose content hashes to
// `hash`, or undefined. `names` maps lower-cased name → real name for everything on disk or claimed.
function ownCopyWithContent(adir: string, names: ReadonlyMap<string, string>, baseName: string, hash: string): string | undefined {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length).toLowerCase();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const family = new RegExp("^" + esc(stem) + "(-[0-9a-z]{6}(_\\d+)?)?" + esc(ext.toLowerCase()) + "$");
  const candidates = [...names.entries()].filter(([lower]) => family.test(lower)).map(([, real]) => real)
    .sort((x, y) => x.length - y.length || (x < y ? -1 : 1)); // the plain name first, then the oldest-looking suffix
  for (const name of candidates) {
    try { if (sha1Hex(normalizeForCompare(name, fs.readFileSync(path.join(adir, name)))) === hash) return name; } catch { /* unreadable: not a match */ }
  }
  return undefined;
}

function shortHashOf(a: Asset, bytes: Buffer): string {
  // Prefer the plugin's own contentHash (already normalised for SVG-export noise); fall back to a
  // fresh sha1 of the bytes for an asset that somehow has no `.hash` (manifest-only / older plugin).
  if (typeof a.hash === "string" && a.hash) return a.hash.replace(/[^a-z0-9]/gi, "").slice(0, 6);
  return sha1Hex(bytes).slice(0, 6);
}

// Reuse `existingName`'s bytes for `a`: point `a.file` at it, and replace `a.text`/`a.base64` with the
// ACTUAL on-disk bytes so the manifest (writeScreenAssets, called right after this on the same array)
// hashes what is really there — a normalised-equal-but-byte-different re-pull must never record a hash
// for content that was never written (a "recorded hash matches nothing on disk", just
// introduced by a naive fix instead of closed by one).
function reuseExisting(a: Asset, dirPrefix: string, existingName: string, priorBytes: Buffer): void {
  a.file = dirPrefix + "/" + existingName;
  if (a.text != null) a.text = priorBytes.toString("utf8");
  else if (a.base64 != null) a.base64 = priorBytes.toString("base64");
}

// The pointer the plugin puts in the tree for an asset: `assets/` + the file's base name. `Asset.file` itself
// is the BARE name (figma-plugin/src/assets.ts register() returns ASSET_DIR + file), and writeAssets turns
// it into `./<name>` or `<dir>/<name>` — so the base name is the one stable part to match on.
const assetPointer = (file: string): string => "assets/" + path.basename(file);

// The names writeAssets actually used, as tree pointers: `before` is each asset's `file` captured before
// the call (same order), so a content-reused or collision-suffixed asset maps
// `assets/<plugin name>` → `assets/<name on disk>`. Unchanged names are left out.
function renamedAssets(assets: Asset[] | null | undefined, before: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  (assets || []).forEach((a, i) => {
    const was = before[i];
    if (was === undefined || !a || !a.file) return;
    const from = assetPointer(was), to = assetPointer(a.file);
    if (from !== to && !map.has(from)) map.set(from, to);
  });
  return map;
}

// Point every `asset`/`reference` string in a written tree (screen nodes, a page walk's layersDoc) at the
// file writeAssets really wrote. A deep walk over plain JSON, so it covers every node of every root and
// the root-level `reference` of a layer file alike. Returns how many pointers moved.
function rewireAssetPointers(tree: unknown, renamed: ReadonlyMap<string, string>): number {
  if (!renamed.size) return 0;
  let moved = 0;
  const seen = new Set<object>();
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
  const visit = (v: unknown): void => {
    if (!isObj(v) || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    const rec = v;
    for (const k of Object.keys(rec)) {
      const val = rec[k];
      if ((k === "asset" || k === "reference") && typeof val === "string") {
        const to = renamed.get(val);
        if (to !== undefined) { rec[k] = to; moved++; }
      } else visit(val);
    }
  };
  visit(tree);
  return moved;
}

// Width/height from a PNG's IHDR chunk (bytes 16–23, big-endian); null for anything that isn't a PNG.
function pngSize(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

// Every `asset`/`reference` pointer in `tree` that names no file under `dir` — checked by EXACT name (a
// case-insensitive disk would otherwise "find" a different-case file, which would ship the wrong
// chevron). A pull should never produce one; if it does, say so instead of leaving a silent hole.
// `exactExists(dir)` is that check on its own — also the hidden-reuse guard's (`fs.existsSync` would say
// yes to `assets/Angle-left.svg` when only `angle-left.svg`, a different icon, was on disk). One listing
// per directory, read on first use: call it after the pull's assets are written.
function exactExists(dir: string): (rel: string) => boolean {
  const listings = new Map<string, Set<string>>();
  return (rel: string): boolean => {
    const d = path.join(dir, path.dirname(rel));
    let names = listings.get(d);
    if (!names) { try { names = new Set(fs.readdirSync(d)); } catch { names = new Set(); } listings.set(d, names); }
    return names.has(path.basename(rel));
  };
}
function danglingPointers(dir: string, tree: unknown): string[] {
  const exists = exactExists(dir);
  const out = new Set<string>();
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
  const visit = (v: unknown): void => {
    if (!isObj(v)) return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    for (const [k, val] of Object.entries(v)) {
      if ((k === "asset" || k === "reference") && typeof val === "string") { if (!exists(val)) out.add(val); }
      else visit(val);
    }
  };
  visit(tree);
  return [...out];
}

// An SVG with an embedded `<image>` and almost no paths is a PHOTO in an SVG shell — the rule is
// svg-normalize.ts isRasterShell, shared with the audit so both say the same thing about one file.
const countTag = (text: string, re: RegExp): number => (text.match(re) || []).length;
const PATH_TAG_RE = /<path\b/g;
const IMAGE_TAG_RE = /<image\b/g;

// `index` is the directory's ContentIndex when the caller already built one (writeScreen, writeExport —
// so assets/ is scanned once per pull, not once here and again for `duplicates`); it is updated in place
// with every file this call writes.
function writeAssets(dir: string, assets: Asset[] | null | undefined, log?: Log, subdir?: string, index?: ContentIndex): number {
  if (!assets || !assets.length) return 0;
  const adir = path.join(dir, subdir || "assets");
  fs.mkdirSync(adir, { recursive: true });
  const existing = readExistingDirCaseFold(adir); // lower -> real name already on disk
  const claimed = new Map<string, string>(); // lower -> real name this call has written/claimed so far (this batch)
  for (const [k, v] of existing) claimed.set(k, v);
  // Seeded from disk and updated as THIS call writes new content, so two assets in the SAME pull that
  // happen to share content (not just two pulls) also collapse to one file.
  const byContent = index || buildContentIndex(adir);
  const heavy: Array<{ file: string; node: string | undefined; bytes: number; paths: number; rasters: number }> = [];
  let n = 0;
  for (const a of assets) {
    let bytes: Buffer;
    if (a.text != null) bytes = Buffer.from(a.text, "utf8");
    else if (a.base64 != null) bytes = Buffer.from(a.base64, "base64");
    else continue; // manifest-only entry (e.g. an asset the plugin skipped) — nothing to write

    let baseName = path.basename(a.file);
    const dirPrefix = path.dirname(a.file); // usually "assets"

    // CONTENT check FIRST, independent of what name this asset arrived under: a
    // name-only check only ever catches "this pull picked the SAME name as something already there".
    // It has no way to see that `Ellipse_2327-e9af26.svg`'s bytes are already on disk as
    // `Ellipse_2327.svg`, or that a drifted `arrow-down-<hash>.svg` is already there under a different
    // hash suffix from an earlier pull — which is exactly the shape a live three-screen pull produced
    // (4 Ellipse_2327* files, 6 arrow-down* files, 3 angle-left* files for what should be 1/1/2 real
    // icons) even with the name-only reuse path already in place.
    const key = contentKey(baseName, bytes);
    // A reference PNG belongs to ONE frame (the plugin never dedups it — assets.ts register()): two frames
    // that render identically must keep their own `<id>_ref.png`, or both `reference`s would name one of
    // them. So a reference reuses only a file of its OWN: its name, or a suffixed copy an earlier pull of
    // the same frame wrote (`<id>_ref-<hash>[_N].png`, when the plain name held other bytes) — without the
    // second, every re-pull over an old thumbnail added another `_1`, `_2`, … copy.
    // That own-copy check stays EXACT bytes (a PNG; the tolerance is for SVG coordinates only).
    const byContentName = a.kind === "reference" ? ownCopyWithContent(adir, claimed, baseName, sha1Hex(normalizeForCompare(baseName, bytes))) : byContent.findKey(key);
    if (byContentName !== undefined) {
      let priorBytes: Buffer | null = null;
      try { priorBytes = fs.readFileSync(path.join(adir, byContentName)); } catch { /* fall through as new */ }
      if (priorBytes) {
        reuseExisting(a, dirPrefix, byContentName, priorBytes);
        n++; // counted as written even though the on-disk file was left untouched
        continue;
      }
    }

    let lower = baseName.toLowerCase();
    const priorName = claimed.get(lower);
    if (priorName !== undefined) {
      // Reaching here means the CONTENT check above already ruled out "this is the same asset under
      // any name" — so a name collision at this point is a same-name (mod case) DIFFERENT asset, full
      // stop. It never fires for a content-duplicate, which is also what keeps the `_1` guard from
      // producing `Ellipse_2327-51bd18_1.svg`: a genuinely identical asset reaching this branch with a
      // hash-suffixed name that ALSO already existed (both suffix attempts being the exact same 6 hex
      // chars, since both were hashes of the SAME content) would make the guard's `_N` mask a
      // content-dedup failure instead of resolving a real 6-hex collision. With content checked first,
      // the guard can only fire on a genuine collision between two DIFFERENT assets' hash suffixes,
      // which is the vanishingly-unlikely case it is for.
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      baseName = stem + "-" + shortHashOf(a, bytes) + ext;
      lower = baseName.toLowerCase();
      let guard = 0;
      while (claimed.has(lower) && guard++ < 5) { baseName = stem + "-" + shortHashOf(a, bytes) + "_" + guard + ext; lower = baseName.toLowerCase(); }
    }
    const file = path.join(adir, baseName);
    fs.writeFileSync(file, bytes);
    claimed.set(lower, baseName);
    byContent.addKey(baseName, key); // so a LATER asset in this same call also dedups against it
    a.file = dirPrefix + "/" + baseName; // downstream (writeScreenAssets, index entries) reads this
    const paths = a.text != null ? countTag(a.text, PATH_TAG_RE) : 0;
    const rasters = a.text != null ? countTag(a.text, IMAGE_TAG_RE) : 0;
    // The whole-frame reference PNG (a.kind === "reference") is never inlined or shipped
    // — writeScreenAssets already excludes it from `count`/`totalBytes` and its own `heavy` list for
    // exactly this reason (see there). This pull-time warning must agree: a "20174_143363_
    // ref.png 0.25 MB is too heavy to inline" is pure noise about a file the app never inlines.
    if (a.kind !== "reference" && (bytes.length >= BIG_ASSET_BYTES || paths >= BUSY_SVG_PATHS)) heavy.push({ file: baseName, node: a.id, bytes: bytes.length, paths, rasters });
    n++;
  }
  if (log) log("wrote " + n + " asset(s) to " + adir);
  heavy.sort((x, y) => y.bytes - x.bytes);
  const shells = heavy.filter((h) => isRasterShell(h.rasters, h.paths));
  const vectors = heavy.filter((h) => !shells.includes(h));
  if (log) for (const h of shells) {
    log(
      `warn  ${h.file} ${(h.bytes / 1048576).toFixed(2)} MB is a raster image embedded in an SVG shell — use it as an image ` +
        "(`<img src>`/URL import), or ask the designer for a PNG/JPG export of that layer; do not inline it"
    );
  }
  if (log && vectors.length) {
    log(
      "warn  " + vectors.length + " asset(s) are too heavy to inline — " +
        vectors.slice(0, 3).map((h) => `${h.file} ${(h.bytes / 1048576).toFixed(2)} MB${h.paths ? ` / ${h.paths} <path> elements` : ""}`).join(", ") +
        (vectors.length > 3 ? ", …" : "")
    );
    log(
      "      A flattened texture or illustration exports as thousands of vector paths. Inlining one of these " +
        "can dominate your whole bundle. Import it by URL, or ask the designer to re-export it as a PNG — do not redraw or simplify it yourself."
    );
  }
  return n;
}

// `assetsGeometry` counts graphics Figma's exporter returned no SVG for, recovered as raw path data
// instead (figma-plugin/src/assets.ts geometryOf) — usable, but a strictly worse asset than a real export.
// A real pull had 40% of a screen's nodes fall back this way with `manifest.warnings: []` and no pull-time
// signal at all. Warning only at a share of nodes, or blaming "unusual paint/blend", misses the cause: on
// the real exports every one of those fallbacks was a HIDDEN node, which the plugin does not export at
// all (`assetSkipped:"hidden"`), or an icon container's own background rectangle, which is a
// failure instead. What is left is a real degraded vector, so ANY fallback warns, and the line
// names up to five of them, `name (id)`, read from the tree as written. Exported for writeScreen and tests.
const GEOMETRY_WARN_LIST = 5;
function assetsGeometryWarning(manifest: Partial<Manifest> | null | undefined, tree?: unknown): string | null {
  const nodes = manifest && typeof manifest.nodes === "number" ? manifest.nodes : 0;
  const geo = manifest && typeof manifest.assetsGeometry === "number" ? manifest.assetsGeometry : 0;
  if (!geo) return null;
  const named: string[] = [];
  let found = 0;
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    const rec: Record<string, unknown> = Object.fromEntries(Object.entries(v));
    if (rec.geometry && typeof rec.geometry === "object") {
      found++;
      if (named.length < GEOMETRY_WARN_LIST) named.push(`${typeof rec.name === "string" ? rec.name : "?"} (${typeof rec.id === "string" ? rec.id : "?"})`);
    }
    visit(rec.children);
  };
  visit(tree);
  return `warn  ${geo}${nodes ? ` of ${nodes}` : ""} node(s) fell back to raw geometry — Figma's exporter returned no SVG for these ` +
    "visible vectors, so their outlines were inlined as `geometry`; check them against the reference" +
    (named.length ? ": " + named.join(", ") + (found > named.length || geo > named.length ? ", …" : "") : "");
}

// The hidden graphics the plugin did not export, and how many the bridge pointed at a visible
// twin's file. One info line, only when the manifest counted any (an older export has no counter).
function assetsHiddenLine(manifest: Partial<Manifest> | null | undefined, reuse?: ReuseResult): string | null {
  const n = manifest && typeof manifest.assetsHidden === "number" ? manifest.assetsHidden : 0;
  if (!n) return null;
  const m = reuse ? reuse.reused : 0;
  return `info  ${n} hidden graphic(s) not exported (\`assetSkipped:"hidden"\`); ${m} reuse a visible twin's file` +
    (reuse && reuse.crossScreen ? ` (${reuse.crossScreen} from another screen)` : "");
}

// The hidden nodes the tree keeps — hidden themselves (`hidden:true`) or under a hidden ancestor (no flag
// of their own; the plugin counts both) — designed states a builder wires up, not noise to drop. One
// info line, only when the manifest counted any (an older export has no counter).
function hiddenNodesLine(manifest: Partial<Manifest> | null | undefined): string | null {
  const n = manifest && typeof manifest.hiddenNodes === "number" ? manifest.hiddenNodes : 0;
  return n ? `info  ${n} node(s) hidden (themselves or under a hidden ancestor) kept in the tree (conditional UI)` : null;
}

// Reference PNGs land in assets/, the same place a --node pull puts the frame's own reference.
//
// They do not get a screenshots/ subdir of their own. The case for one — a discovery screenshot is not a
// shipped asset — does not survive practice: a separate subdir produced three different answers to
// "where is the PNG?" — the skill said screenshots/, `dtwin help` said assets/, the success message
// and the `reference` field both printed assets/ while the byte landed in screenshots/ — and when
// the node was later pulled, the pull wrote a byte-identical copy into assets/ anyway. One
// directory, one name, no duplicate: shoot a node during discovery and the PNG is already in the
// place build-screen reads, whether or not you go on to pull it.
const REF_DIR = "assets";
//
// An explicit `scale` (a discovery thumbnail, e.g. 0.25) is NOT the frame's reference: it gets its own
// name, `<id>_shot@<scale>x.png`, so it never takes the `<id>_ref.png` slot a later pull's full-size
// reference is written to (otherwise a 360 px thumbnail holds the slot, the 2048 px export is suffixed, and
// the index points at the thumbnail). The default scale renders exactly what a pull would, so it keeps
// the shared name and a later pull reuses the same file.
//
// `png`: the reference PNG's own pixel size, read from its bytes — absent when no reference asset
// carried PNG bytes.
function writeScreenshot(outDir: string | null | undefined, r: ScreenshotReply, log?: Log, opts?: { scale?: number | undefined }): { outDir: string; reference: string; png?: { w: number; h: number }; wrote: { screenshot: true; assets: number; reference: string } } {
  const dir = resolveOutDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const scale = opts && typeof opts.scale === "number" && opts.scale > 0 ? opts.scale : undefined;
  if (scale !== undefined) for (const a of r.assets) {
    if (a && a.kind === "reference" && a.file) a.file = path.dirname(a.file) + "/" + path.basename(a.file).replace(/_ref\.png$/i, "").replace(/\.png$/i, "") + `_shot@${Number(scale.toPrecision(4))}x.png`;
  }
  const refAsset = r.assets.find((a) => a && a.kind === "reference" && a.base64 != null);
  const png = refAsset && refAsset.base64 != null ? pngSize(Buffer.from(refAsset.base64, "base64")) : null;
  const assets = writeAssets(dir, r.assets, log, REF_DIR);
  // The path the caller should PRINT. `r.reference` is the plugin's own relative name; recomputing it
  // here from the file actually written is what keeps the message and the file in agreement.
  const first = r.assets.find((a) => a && a.file);
  const reference = first ? REF_DIR + "/" + path.basename(first.file) : r.reference;
  return { outDir: dir, reference, ...(png ? { png } : {}), wrote: { screenshot: true as const, assets, reference } };
}

// The whole-export write, shared by the CLI's default path and the MCP export tools' writeToDisk
// path. Returns the COMPACT INDEX — counts and paths, never node payloads — which is precisely what
// an MCP tool should hand back in place of the export itself: the agent then Reads/Greps the files
// at whatever granularity it actually needs, instead of paying for the whole tree in context.
// `r` is a full/page pull (designSystem + layersDoc + assets) or a catalog-only one (designSystem alone).
// `opts.keepPrev` (the MCP server's implicit spill only): every JSON under pages/, design-system/ or
// libraries/ this write replaces with DIFFERENT content (exportedAt/generatedAt ignored) is first copied to
// `<file>.prev` — one level, the next such spill replaces it — and `wrote.prevKept` lists those .prev
// paths (absolute), present only when non-empty. The CLI and an explicit writeToDisk keep nothing.
// Assets need nothing: writeAssets never overwrites a file with different bytes.
function writeExport(outDir: string | null | undefined, r: Stamped<FullExportReply | DesignSystemReply>, log?: Log, opts?: { keepPrev?: boolean | undefined }) {
  const dir = resolveOutDir(outDir);
  const keep: string[] | undefined = opts && opts.keepPrev ? [] : undefined;
  const kept = (): { prevKept?: string[] } => (keep && keep.length ? { prevKept: keep } : {});
  fs.mkdirSync(dir, { recursive: true });
  writeSchemaDoc(dir, log);
  // A library catalog is routed by the PRODUCER's own flag (`source.role`), not by a CLI-side guess:
  // the plugin is the only thing that knows which file it ran in, and misrouting would overwrite the
  // design file's catalog with a library's.
  const isLib = !!(r.designSystem.source && r.designSystem.source.role === "library");
  if (isLib) {
    const lib = writeLibrary(dir, r.designSystem, log, keep);
    return { outDir: dir, wrote: { library: lib.dir, libraryCounts: lib.counts, publish: lib.publish, orphans: lib.orphans, ...kept() } };
  }
  const ds = writeDesignSystem(dir, r.designSystem, log, keep);
  // On a file that CONSUMES a library, the variables flagged `remote` are only the library ones something
  // here references — not that library's catalog. Say so while the pull's log is being read.
  const vars = r.designSystem.variables || [];
  const remoteVars = vars.filter((v) => v && v.remote === true).length;
  if (log && remoteVars) log(`info  ${remoteVars} of ${vars.length} variables come from a library this file consumes — not that library's catalog: open the library file and run \`dtwin pull --as-library "<name>"\` (CLI) to pull the catalog itself`);
  // The page walk half, present on a full pull only — narrowed on the field that IS the walk.
  const full: Stamped<FullExportReply> | null = "layersDoc" in r ? r : null;
  // figma-pull.ts resolves which connected Figma file this pull talked to and stamps it as
  // `r.sourceFile`/`r.sourceFileKey` (the plugin itself has no reason to know its own bridge-side
  // connection id). Forward it onto layersDoc so buildPageLayout can carry it onto every per-page
  // layer file/index row — the same field writeScreen below stamps for a single-screen pull.
  if (full && full.sourceFile && full.layersDoc.sourceFile === undefined) {
    full.layersDoc.sourceFile = full.sourceFile;
    if (full.sourceFileKey) full.layersDoc.sourceFileKey = full.sourceFileKey;
  }
  // Assets FIRST, then the layer files: writeAssets may reuse or rename a file, and the trees must name
  // what it actually wrote.
  const before = full ? full.assets.map((a) => a.file) : [];
  const assets = full ? writeAssets(dir, full.assets, log) : 0;
  if (full) {
    const moved = rewireAssetPointers(full.layersDoc, renamedAssets(full.assets, before));
    if (log && moved) log(`rewired ${moved} asset pointer(s) to the names written (content-reused or collision-renamed files)`);
    // A page walk reuses a visible twin within its own walk only (no per-screen .assets.json to read).
    const roots = (full.layersDoc.layers || []).map((l) => l.tree).filter((t): t is IrNode => !!t && typeof t === "object");
    const reuse = reuseHiddenAssets(roots, { pointerExists: exactExists(dir) });
    if (log && reuse.hidden) log(`info  ${reuse.hidden} hidden graphic(s) not exported (\`assetSkipped:"hidden"\`); ${reuse.reused} reuse a visible twin's file`);
    const hn = hiddenNodesLine(full.layersDoc.manifest);
    if (log && hn) log(hn);
  }
  const pages = full ? writePages(dir, full.layersDoc, log, keep) : null;
  if (full && log) { const d = danglingPointers(dir, full.layersDoc); if (d.length) log(`warn  ${d.length} asset pointer(s) name a file that is not on disk: ${d.slice(0, 3).join(", ")}${d.length > 3 ? ", …" : ""}`); }
  return {
    outDir: dir,
    wrote: {
      designSystem: true,
      designSystemCounts: ds,
      layerFiles: pages ? pages.layerFiles : 0,
      pageDirs: pages ? pages.pageDirs : 0,
      assets,
      assetsSkipped: full ? full.assets.length - assets : 0,
      ...kept(),
    },
    index: pages ? pages.meta : undefined,
  };
}

// The other screens' trees that may hold a visible twin for one of `keys`: every pages/**/<base>.assets.json
// in this export (except this screen's own) with a row whose `reuseKey` is wanted and whose owner carries no
// paint override, then its sibling <base>.json — read only for those, and re-checked there by
// reuseHiddenAssets (size, transform, overrides), since one row's key says nothing about the rest. A sibling
// whose roots include one of `ownRoots` (this pull's root ids) is this frame's own stale JSON — skipped.
function otherScreenTrees(dir: string, ownAssets: string, keys: ReadonlySet<string>, ownRoots: ReadonlySet<string> = new Set()): IrNode[][] {
  const out: IrNode[][] = [];
  const own = path.join(dir, ownAssets);
  const files: string[] = [];
  const walk = (d: string): void => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".assets.json") && p !== own) files.push(p);
    }
  };
  walk(path.join(dir, "pages"));
  for (const f of files) {
    const doc = readJsonOr(f, null);
    const rows = doc && typeof doc === "object" && "files" in doc && Array.isArray(doc.files) ? doc.files : [];
    const wanted = rows.some((row: unknown) => {
      if (!row || typeof row !== "object") return false;
      const key = "reuseKey" in row ? row.reuseKey : undefined;
      const owner = "owner" in row ? row.owner : undefined;
      const blocked = !!owner && typeof owner === "object" && "paintOverrides" in owner && owner.paintOverrides === true;
      return typeof key === "string" && keys.has(key) && !blocked;
    });
    if (!wanted) continue;
    const screen = readJsonOr(f.slice(0, -".assets.json".length) + ".json", null);
    const nodes = screen && typeof screen === "object" && "nodes" in screen && Array.isArray(screen.nodes) ? screen.nodes : null;
    // The same frame under an older name or page (renamed): its stale JSON is no twin of itself.
    const roots = nodes ? nodes.filter((n: unknown): n is IrNode => !!n && typeof n === "object") : [];
    if (roots.some((n) => ownRoots.has(n.id))) continue;
    if (roots.length) out.push(roots);
  }
  return out;
}

// The selection/single-node export has a different SHAPE than the full one — one `screen` tree plus
// `variables`, no designSystem/layersDoc — so it gets its own writer rather than a branch inside
// writeExport.
//
// It files into the SAME pages/ tree a --page pull writes: pages/<Page>/<Name>__<id>.json, with the
// pull's token slice and its asset index as siblings. There is no flat design/<Screen>.json: naming
// files from the layer alone makes two frames called "Popup" overwrite each other, and leaves a
// --node project with no index, no page context and nothing sync-design or verify could address
// Screens ARRIVE one pull at a time, so both indexes merge with what is
// already on disk rather than being recomputed in one pass like buildPageLayout's.
//
// Asset filenames are still NOT sanitised here: the plugin owns them (see writeAssets).
//
// `opts.keepPrev`: when set and the screen JSON already exists with a DIFFERENT design (the top-level
// `exportedAt` stamp aside), the old file is
// kept as `<screen>.json.prev` (one level, replaced by the next one) and `wrote.prev` names it. The MCP server
// sets it only on an implicit spill — an explicit pull overwriting its own file is the point of the pull.
function writeScreen(outDir: string | null | undefined, r: Stamped<ScreenReply>, log?: Log, opts?: { keepPrev?: boolean | undefined }) {
  const dir = resolveOutDir(outDir);
  const paths = screenPaths(r, "/");
  fs.mkdirSync(path.join(dir, "pages", paths.dir), { recursive: true });
  writeSchemaDoc(dir, log);

  // Stamp which Figma file this pull actually talked to, straight onto the screen doc's own
  // top level — the ONE thing doctor.ts's exportSourceCounts() can read without opening a second file, and
  // the reason a project pulled before this field existed is told apart from one whose source is
  // simply unknown (undefined, never a guess). figma-pull.ts resolves it; this is just where it lands.
  // Assets FIRST: writeAssets reuses a byte-identical file already on disk under another name, and
  // version-suffixes a same-name (or same-name-but-case) different file. The plugin built every node's
  // `asset` and the root's `reference` from ITS names, so they are rewired to the names written before the
  // screen JSON is — otherwise nodes point at files that were never written, or (case-insensitive disk) at
  // a different icon, and the index's `reference` at whatever thumbnail held the plain name.
  const before = (r.assets || []).map((a) => a.file);
  const contentIndex = buildContentIndex(path.join(dir, "assets"));
  const assets = writeAssets(dir, r.assets, log, undefined, contentIndex);
  const moved = rewireAssetPointers(r.screen.nodes, renamedAssets(r.assets, before));
  if (log && moved) log(`rewired ${moved} asset pointer(s) to the names written (content-reused or collision-renamed files)`);
  // A hidden graphic the plugin did not export points at a visible twin's file — this pull's tree
  // first, then the screens already on disk (their .assets.json `reuseKey`, re-checked on their tree).
  const reuse = reuseHiddenAssets(r.screen.nodes, {
    otherTrees: (keys) => otherScreenTrees(dir, paths.assets, keys, new Set((r.screen.nodes || []).map((n) => n.id))),
    pointerExists: exactExists(dir),
  });
  const screenDoc = r.sourceFile
    ? Object.assign({}, r.screen, { sourceFile: r.sourceFile }, r.sourceFileKey ? { sourceFileKey: r.sourceFileKey } : {})
    : r.screen;
  // writeJson serialises once and keeps the replaced file through `keep`; quiet, so the kept line can come before the wrote line
  const keep: string[] | undefined = opts && opts.keepPrev ? [] : undefined;
  writeJson(dir, paths.screen, screenDoc, true, undefined, keep);
  const prev = keep && keep[0];
  if (log) {
    if (prev) log(`kept the previous ${paths.screen} as ${path.basename(prev)} (it differed from this export)`);
    log("wrote " + path.join(dir, paths.screen));
  }
  if (log) { const d = danglingPointers(dir, r.screen.nodes); if (d.length) log(`warn  ${d.length} asset pointer(s) name a file that is not on disk: ${d.slice(0, 3).join(", ")}${d.length > 3 ? ", …" : ""}`); }
  // `variables` is always on a real screen reply; a hand-built one (the tests) may omit it.
  const variables = r.variables ? writeScreenVariables(dir, paths, r.variables, log) : null;
  const assetIndex = writeScreenAssets(dir, paths, r.assets, r.screen.nodes, contentIndex);
  // A screen whose icons largely fell back to raw geometry
  // (figma-plugin/src/assets.ts geometryOf) instead of a real SVG export gets a warning AT PULL TIME,
  // not only if someone happens to go looking in manifest.assetsGeometry later.
  if (log) {
    const gw = assetsGeometryWarning(r.screen.manifest, r.screen.nodes);
    if (gw) log(gw);
    const hl = assetsHiddenLine(r.screen.manifest, reuse);
    if (hl) log(hl);
    const hn = hiddenNodesLine(r.screen.manifest);
    if (hn) log(hn);
  }

  // The entry a consumer reads instead of guessing filenames. Every sibling this pull produced is a
  // POINTER here, for the same reason buildPageLayout emits real relative paths: a consumer that
  // reassembles `pages/<dir>/<base>.vars.json` from parts is right until the day one part changes.
  const root: Partial<IrNode> = (Array.isArray(r.screen.nodes) && r.screen.nodes[0]) || {};
  // title/texts: the visible title a user types is a TEXT node inside the
  // frame, not the Figma layer name (`root.name`/`entry.name` below); see pages-layout.ts deriveTitle.
  const title = deriveTitle(root);
  // How the reference PNG maps onto the design's coordinates. The plugin renders it at an auto scale
  // over the node's RENDER bounds (shadows, outside strokes), so a popup with a 21 px shadow is cropped
  // differently from its box. referenceScale = PNG px per design px; referenceOffset = where the PNG's
  // top-left sits relative to the box's top-left (design px, usually <= 0).
  const refAsset = (r.assets || []).find((a) => a && a.kind === "reference" && a.file && assetPointer(a.file) === root.reference);
  const refSize = refAsset && refAsset.base64 != null ? pngSize(Buffer.from(refAsset.base64, "base64")) : null;
  const refBox = root.renderBox || root.box;
  const referenceScale = refSize && refBox && refBox.w ? Math.round((refSize.w / refBox.w) * 10000) / 10000 : undefined;
  const referenceOffset = referenceScale !== undefined && root.box && typeof root.box.x === "number" && typeof root.box.y === "number"
    ? (root.renderBox ? { x: root.renderBox.x - root.box.x, y: root.renderBox.y - root.box.y } : { x: 0, y: 0 })
    : undefined;
  const texts = collectTexts(root);
  // The index row's join keys. A screen with no id at all (no nodeId on the reply, no root node) could
  // only be indexed as a row nothing can ever address again — refuse it, loudly, rather than write it.
  const name = r.screen.screen || r.screenName;
  const id = paths.nodeId || root.id;
  if (!id) throw new Error(`screen '${name}' has no id — cannot index it (the reply carried no nodeId and no root node)`);
  const entry: ScreenIndexRow = {
    name,
    id,
    ...ifDefined("type", root.type),
    page: paths.page,
    pageId: paths.pageId,
    title,
    texts,
    ...ifDefined("exportedAt", r.screen && r.screen.exportedAt),
    ...ifDefined("sourceFile", r.sourceFile || undefined),
    file: paths.screen,
    ...ifDefined("variables", r.variables ? paths.variables : undefined),
    ...ifDefined("assets", assetIndex ? paths.assets : undefined),
    ...ifDefined("reference", root.reference),
    ...ifDefined("referenceScale", referenceScale),
    ...ifDefined("referenceOffset", referenceOffset),
    ...ifDefined("nodes", (r.screen.manifest && r.screen.manifest.nodes) || undefined),
    ...ifDefined("w", root.box && root.box.w),
    ...ifDefined("h", root.box && root.box.h),
  };
  const pageIndex = mergeScreenIndex(readJsonOr(path.join(dir, paths.index), null), Object.assign({}, entry, { page: paths.page, pageId: paths.pageId }));
  writeJson(dir, paths.index, pageIndex, true);
  writeJson(dir, paths.rootIndex, mergeRootIndex(readJsonOr(path.join(dir, paths.rootIndex), null), paths, pageIndex.layers.length, entry), true);
  if (log) log(`indexed ${paths.screen} in ${paths.rootIndex} (page '${paths.page || "unfiled"}' now holds ${pageIndex.layers.length} screen(s))`);

  return {
    outDir: dir,
    wrote: {
      screen: path.join(dir, paths.screen),
      ...ifDefined<"prev", string>("prev", prev),
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

// Copy `file` to `<file>.prev` before it is replaced, when it exists and differs from `next` (the
// bytes about to be written). The `.prev` suffix is not `*.json`, so no screen glob, index or snapshot reader
// picks it up. A copy, not a rename: the target stays intact until writeJson's own atomic rename replaces it.
// Returns the .prev path, or undefined when nothing was kept (no file, identical, or unreadable).
function keepPrevCopy(file: string, next: string): string | undefined {
  let old: string;
  try { old = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  if (old === next) return undefined;
  // The plugin stamps a fresh exportedAt on every reply, so compare the documents without it: an unchanged
  // design re-spilled must not replace the .prev that holds what the FIRST spill displaced.
  const a = unstampedJson(old);
  if (a !== null && a === unstampedJson(next)) return undefined;
  const prev = file + ".prev";
  fs.copyFileSync(file, prev);
  return prev;
}

// A JSON document re-serialised without its stamps, or null when it is not a JSON object: the top-level
// exportedAt/generatedAt, and the per-library exportedAt on libraries/index.json's rows. That index carries
// generatedAt plus one stamp per row (library-layout.ts mergeLibrariesIndex), so without these every re-spill
// of an unchanged library would keep a pointless .prev.
function withoutExportedAt(x: unknown): unknown {
  if (!isRecord(x)) return x;
  const { exportedAt: _drop, ...rest } = x;
  void _drop;
  return rest;
}
function unstampedJson(s: string): string | null {
  let o: unknown;
  try { o = JSON.parse(s) as unknown; } catch { return null; }
  if (!isRecord(o)) return null;
  const { exportedAt: _drop, generatedAt: _gen, ...rest } = o;
  void _drop;
  void _gen;
  if (Array.isArray(rest.libraries)) rest.libraries = rest.libraries.map(withoutExportedAt);
  return JSON.stringify(rest);
}

// Which colours an exported SVG hard-codes.
//
// Figma exports the frame as it LOOKS, so a Dark-mode icon arrives with `stroke="#D4D4D4"` baked in
// and the same file cannot serve a Light theme. Editing the asset is the wrong fix
// — the producer owns these files and a re-pull overwrites them — so the right move is to swap the
// colour for `currentColor` at RENDER time. But that is only safe for a glyph whose colour is purely
// thematic: a red trash icon and a green tick carry meaning, and recolouring those is a bug.
//
// One colour throughout = thematic, safe to recolour. More than one = semantic, leave it alone. The
// builder gets the answer per file instead of having to open each SVG.
function svgPalette(text: unknown): { colors: string[]; monochrome: boolean; paths: number; embeddedRaster?: number } {
  const colors = new Set<string>();
  for (const m of String(text).matchAll(/(?:fill|stroke)\s*=\s*"([^"]+)"/g)) {
    const raw = m[1];
    if (raw === undefined) continue; // cannot happen: group 1 is not optional
    const v = raw.trim().toLowerCase();
    if (v === "none" || v === "transparent" || v === "currentcolor" || v.startsWith("url(")) continue;
    colors.add(v);
  }
  const paths = countTag(String(text), PATH_TAG_RE);
  // An `<image>` inside the SVG (a photo in a vector shell) — only written when there is one.
  const rasters = countTag(String(text), IMAGE_TAG_RE);
  return rasters ? { colors: [...colors], monochrome: colors.size === 1, paths, embeddedRaster: rasters } : { colors: [...colors], monochrome: colors.size === 1, paths };
}

function readJsonOr(file: string, fallback: unknown): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return fallback; // absent or corrupt — this pull is the first, or the last one was interrupted
  }
}

// Which assets belong to THIS screen, and which of them are byte-identical to each other.
//
// design/assets/ is flat, shared and cumulative: after three pulls it held 98 files, and the only way
// to answer "which of these does THIS screen use" is to walk the screen JSON.
// This index answers it directly, and the content hash makes the duplication visible — the same
// sidebar icon exported once per instance path shows up as several names under one hash, so a
// consumer can import one file instead of five without diffing bytes itself.
// `duplicates` is computed over the WHOLE shared assets/ directory — not just this pull's own array.
// `assets/` is explicitly shared and cumulative (see writeAssets' header), so a duplicate between this
// screen's icon and one a DIFFERENT screen's pull wrote is exactly as real as one within this pull, and
// a per-pull-array computation could never see that. The clobber-avoidance in
// writeAssets means a NEW duplicate of this shape mostly can't be created (a re-pull of an
// unchanged icon reuses the existing file), but files already on disk from an earlier export — or two
// independently-named layers that just happen to render the same icon — still need catching, hence the
// directory's ContentIndex (the same one writeAssets reused with) rather than trusting the write history.
// Files are never deleted or merged: a re-pull points at the representative, the rest stay listed.

export type { AssetOwner, AssetContext } from "./asset-owners.ts";
/** One row of <Screen>.assets.json `files[]` / `reference[]`. The palette fields are present on SVGs only;
 *  the owner fields on rows the screen's tree points at. */
export interface AssetIndexEntry {
  file: string;
  node: string | undefined;
  bytes: number;
  hash: string | null;
  from?: string[];
  colors?: string[];
  monochrome?: boolean;
  paths?: number;
  /** Asset.name — the layer name of `node` */
  name?: string;
  /** the owner of `node` (else of the first use that has one) */
  owner?: AssetOwner;
  /** the instance above the owner */
  context?: AssetContext;
  /** every node id in THIS screen whose `asset` is this file, tree order, capped at USED_BY_CAP */
  usedBy?: string[];
  /** the full count, present only when `usedBy` was capped */
  usedByCount?: number;
  /** how many of those uses are hidden (the node or an ancestor); absent when none */
  hiddenUses?: number;
  /** the hidden-reuse key of the use `owner` describes (asset-owners.ts reuseKeyOf) — what another screen's
   *  hidden graphic matches on; absent when that use is hidden */
  reuseKey?: string;
  /** how many `<image>` elements the SVG embeds; absent when none */
  embeddedRaster?: number;
  /** a file this pull did not export: a hidden node here reuses it from a visible twin in ANOTHER screen
   *  — the twin's node id (`assetFrom` of the row's `node`); absent on every file this pull wrote */
  reusedFrom?: string;
}
const USED_BY_CAP = 50;

// The owner half of a row: `uses` are the tree's nodes pointing at the row's file, in tree order.
function ownerFields(entry: AssetIndexEntry, uses: readonly Graphic[] | undefined): void {
  if (!uses || !uses.length) return;
  const primary = uses.find((g) => g.node.id === entry.node && g.owner) || uses.find((g) => g.owner);
  if (primary && primary.owner) {
    entry.owner = primary.owner;
    if (primary.context) entry.context = primary.context;
    if (primary.reuseKey !== undefined && !primary.hidden) entry.reuseKey = primary.reuseKey;
  }
  entry.usedBy = uses.slice(0, USED_BY_CAP).map((g) => g.node.id);
  if (uses.length > USED_BY_CAP) entry.usedByCount = uses.length;
  const hidden = uses.filter((g) => g.hidden).length;
  if (hidden) entry.hiddenUses = hidden;
}

// `tree` is the screen's nodes as written (after rewiring and hidden reuse) — the owner fields come from it;
// `index` the directory's ContentIndex writeAssets already used (built here when absent).
function writeScreenAssets(dir: string, paths: ScreenPaths, assets: Asset[] | null | undefined, tree?: readonly IrNode[] | null, index?: ContentIndex): { count: number; duplicates: number; totalBytes: number } | null {
  const uses = usesByPointer(collectGraphics(tree));
  // No index for a pull that exported nothing — unless a hidden node reuses another screen's file.
  const reusesAny = [...uses.values()].some((list) => list.some((u) => typeof u.node.assetFrom === "string"));
  if (!Array.isArray(assets) || (!assets.length && !reusesAny)) return null;
  const groups = (index || buildContentIndex(path.join(dir, "assets"))).groups().filter((g) => g.files.length > 1);
  const groupOf = new Map<string, { hash: string; files: string[] }>(); // basename -> its duplicate group
  for (const g of groups) for (const f of g.files) groupOf.set(f, g);
  const files: AssetIndexEntry[] = [];
  const reference: AssetIndexEntry[] = []; // the frame's own screenshot — see note below on why it's split out
  const dupHashes = new Set<string>();
  for (const a of assets) {
    if (!a || !a.file) continue;
    const bytes = a.text != null ? Buffer.from(a.text, "utf8") : a.base64 != null ? Buffer.from(a.base64, "base64") : null;
    const hash = bytes ? sha1Hex(bytes) : null; // exact bytes-on-disk hash (writeAssets keeps a.text/a.base64 in sync with disk on reuse)
    const file = "assets/" + path.basename(a.file);
    const entry: AssetIndexEntry = { file, node: a.id, bytes: bytes ? bytes.length : 0, hash };
    if (typeof a.name === "string" && a.name) entry.name = a.name;
    if (Array.isArray(a.from) && a.from.length > 1) entry.from = a.from; // one file, several nodes reached it
    if (a.text != null && /\.svg$/i.test(a.file)) Object.assign(entry, svgPalette(a.text));
    if (a.kind !== "reference") ownerFields(entry, uses.get(file));
    // The whole-frame reference PNG (a.kind === "reference", <id>_ref.png — see figma-plugin/src/assets.ts)
    // is a discovery/self-check aid, not a shippable UI asset: on one real screen it was 196,049 of
    // 312,234 total bytes (63%) and headed the `heavy` list purely because of its own size.
    // It still gets a manifest ROW (build-screen looks it up), just not counted into `count`/`totalBytes`,
    // which exist to answer "how much of this do I actually ship".
    if (a.kind === "reference") { reference.push(entry); continue; }
    files.push(entry);
    const g = groupOf.get(path.basename(a.file));
    if (g) dupHashes.add(g.hash);
  }
  // A hidden node that reuses a file from ANOTHER screen's pull (reuseHiddenAssets' cross-screen step)
  // points at a file this pull never exported — still one this screen references, so it gets a row too,
  // its bytes read from disk, `reusedFrom` naming the twin. A pointer that names no file on disk (by exact
  // name) gets no row: danglingPointers already warned about it.
  const listed = new Set([...files, ...reference].map((f) => f.file));
  const onDisk = exactExists(dir);
  for (const [pointer, list] of uses) {
    const reused = list.find((u) => typeof u.node.assetFrom === "string");
    if (listed.has(pointer) || !reused || !onDisk(pointer)) continue;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(path.join(dir, pointer)); } catch { continue; }
    const entry: AssetIndexEntry = { file: pointer, node: reused.node.id, bytes: bytes.length, hash: sha1Hex(bytes) };
    if (typeof reused.node.name === "string" && reused.node.name) entry.name = reused.node.name;
    if (/\.svg$/i.test(pointer)) Object.assign(entry, svgPalette(bytes.toString("utf8")));
    ownerFields(entry, list);
    if (typeof reused.node.assetFrom === "string") entry.reusedFrom = reused.node.assetFrom;
    files.push(entry);
    listed.add(pointer);
    const g = groupOf.get(path.basename(pointer));
    if (g) dupHashes.add(g.hash);
  }
  const duplicates = groups.filter((g) => dupHashes.has(g.hash)).map((g) => {
    const group = g.files.map((f) => "assets/" + f); // the representative first
    const first = files.find((f) => group.includes(f.file));
    return { hash: g.hash, bytes: first ? first.bytes : undefined, files: group };
  });
  const monochrome = files.filter((f) => f.monochrome).map((f) => f.file);
  // `f.paths` is undefined on a non-SVG row, and `undefined >= n` is false.
  const heavy = files.filter((f) => f.bytes >= BIG_ASSET_BYTES || (f.paths !== undefined && f.paths >= BUSY_SVG_PATHS)).map((f) => ({ file: f.file, bytes: f.bytes, paths: f.paths, ...ifDefined("embeddedRaster", f.embeddedRaster) }));
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
      "the WHOLE shared assets/ directory (every screen ever pulled), not just this screen's own files: two " +
      "SVGs are the same asset when they differ only in def ids and in numbers by at most 0.01 (Figma's own " +
      "re-export noise, bridge/src/svg-normalize.ts svgFingerprint) — the numbers of a transform on <use>/<image> " +
      "and of a <pattern>'s x/y/width/height (an embedded image's scale, offset and tile) relatively, by at most " +
      "1 % of their size; other files must be byte-identical. Each " +
      "group lists its representative first — the file a re-pull points at; the others are never deleted. " +
      "`owner`/`context`/`name` say what each file IS (the component and variant that own it) — search those, " +
      "not file names; `usedBy` lists this screen's nodes that point at it; `reusedFrom` marks a file another " +
      "screen's pull exported that a hidden node here reuses. `monochrome` lists the SVGs whose every fill/stroke is one colour — those " +
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

// variables.json is the ONE file two single-screen pulls share, and it must not be replaced wholesale
// — pulling screen B would delete screen A's tokens. It accumulates:
// the raw per-pull slice is kept verbatim under variables/<Screen>.json, and variables.json is the
// union of every slice, keyed on each variable's Figma key. See variables-merge.ts for the rules.
function writeScreenVariables(dir: string, paths: ScreenPaths, slice: VariablesDoc, log?: Log): { total: number; fromThisScreen: number; added: number; conflicts: number; screens: number } {
  writeJson(dir, paths.variables, slice, true);

  const target = path.join(dir, "variables.json");
  let prev: unknown = readJsonOr(target, null);
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
    // A token/theme file generated from variables.json before this pull does not cover it. Bridge
    // text only (no design-to-code import); the tokens script's --check is what compares the two.
    if (!stats.first && stats.added > 0) {
      log(`info  ${stats.added} new variable(s) merged into variables.json — a token/theme file generated from it is now behind (the tokens script's --check says)`);
    }
  }
  return { total: doc.variables.length, fromThisScreen: Array.isArray(slice.variables) ? slice.variables.length : 0, added: stats.added, conflicts: stats.conflicts.length, screens: doc._slices.length };
}

// Dispatch on the RESULT shape, so each export tool forwards whatever the plugin sent without
// having to know which writer its own command implies. Each member of ExportReply carries a field
// the others do not — `screen` (a screen pull), `reference` (a screenshot), otherwise a catalog with
// or without a page walk — so `in` narrows the union to the writer's own reply type.
function writeAny(outDir: string | null | undefined, r: Stamped<ExportReply>, log?: Log, opts?: { scale?: number | undefined; keepPrev?: boolean | undefined }) {
  if ("screen" in r) return writeScreen(outDir, r, log, opts && opts.keepPrev !== undefined ? { keepPrev: opts.keepPrev } : undefined);
  if ("reference" in r) return writeScreenshot(outDir, r, log, opts);
  return writeExport(outDir, r, log, opts && opts.keepPrev !== undefined ? { keepPrev: opts.keepPrev } : undefined);
}

// How many characters an INLINE tool result may be before the MCP client truncates it. Claude Code caps
// tool output at MAX_MCP_OUTPUT_TOKENS (default 25,000); ~4 characters per token, and 20% headroom
// because that ratio is an estimate and indented JSON tokenizes worse than prose. Capped at 48,000:
// Claude Code also saves any text result longer than 50,000 characters to a file instead of showing it,
// whatever MAX_MCP_OUTPUT_TOKENS says — so past that the inline result is not inline anyway, and our own
// spill (files + a compact index) is the better answer. MAX_MCP_OUTPUT_TOKENS can still LOWER the limit.
const INLINE_CHAR_CAP = 48000;
function inlineLimitChars(env: NodeJS.ProcessEnv = process.env): number {
  const tokens = Number(env.MAX_MCP_OUTPUT_TOKENS);
  return Math.min(Math.floor((tokens > 0 ? tokens : 25000) * 4 * 0.8), INLINE_CHAR_CAP);
}

export { DEFAULT_OUT_DIR, inlineLimitChars, resolveOutDir, assertInsideCwd, writeJson, writePages, writeDesignSystem, writeLibrary, writeAssets, writeScreenAssets, assetsGeometryWarning, assetsHiddenLine, writeScreenshot, writeScreenVariables, writeExport, writeScreen, writeAny };
