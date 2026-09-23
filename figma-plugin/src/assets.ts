// Rendering nodes to assets: vector/icon -> SVG, image-fill -> PNG, whole-frame reference PNG,
// and Dev-Mode resource links.
import { Obj, safe, toBase64, errMsg, round, normalizeSvgText } from "./util";
import { Asset, assets, stats, warn, warnKind, imageSizeCache, runOpts } from "./state";
import { checkCancelled, progress } from "./progress";

// The ONE place an asset filename is decided. `register` returns the path that goes into the node
// tree, and stores the identical basename on the asset record — so figma-pull / the UI download write
// exactly the name the tree points at instead of each re-deriving the convention.
//
// It used to be `safe(node.id) + "." + format`, which produced two problems a real build could not
// work around:
//
//   * Every file was named after a node-id PATH. A layer named `icons/linear/arrow-down` landed as
//     `I10970_111374_1910_23337_1902_19173.svg`, and an app importing 41 icons imported 41 of those
//     (live finding 96). The layer name was sitting right beside it in the tree, unused.
//   * The id path includes the whole INSTANCE chain, so one shared sidebar icon was re-exported under
//     a different name for every screen and every instance that used it — five identical avatar
//     placeholders on one frame became five files (finding 97).
//
// So: name from the LAYER, dedupe on CONTENT. Two registrations whose bytes are identical return the
// same path and produce one file; the second one records its node id on the first's `from` list, so
// nothing about provenance is lost. Two different assets that sanitize to the same name are told
// apart by a short content hash, never by silently overwriting one another.
//
// The node id remains the reference PNG's name (`<id>_ref.png`): a reference belongs to one frame by
// definition, build-screen looks it up by id, and every doc names that shape.
const ASSET_DIR = "assets/";

// Figma's own SVG export is not bit-reproducible: re-exporting the SAME icon, with NOTHING changed in
// the design, comes back with different floating-point path coordinates (measured ≤0.002px drift —
// findings 25/222). Hashing the raw SVG text made every re-pull with zero design changes report a
// fresh batch of "changed" assets, and made two genuinely identical icons dedupe-fail (finding 24).
// `normalizeSvgText` (bridge/svg-normalize.js, re-exported via ./util — see its header for why 1
// decimal place, not 2) is the ONE shared definition of "same SVG, modulo export noise", used here AND
// by bridge/write-out.js AND design-to-code/design-diff.js so the three cannot silently disagree.
// PNG/base64 assets are untouched: they have no textual coordinate space to normalise, and their
// pixels really do change when Figma recompresses them, which is legitimate signal, not noise.

// FNV-1a, 32-bit. Not a cryptographic hash and does not need to be — it decides whether two byte
// strings in ONE export are the same, and a collision would at worst reuse one icon for another
// (which the length check below makes vanishingly unlikely). The Figma plugin sandbox has no
// crypto.subtle, so this is also the only option that does not cost a round trip.
function contentHash(a: { base64?: string; text?: string }): string {
  const src = a.text != null ? normalizeSvgText(a.text) : a.base64 != null ? a.base64 : "";
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0") + "-" + src.length.toString(36);
}

// Per-run, reset by resetRun() via releaseAssets(): content hash -> the file already written for it,
// and taken basename -> the hash that owns it.
const byContent = new Map<string, { file: string; asset: Asset }>();
const byName = new Map<string, string>();
export function resetAssetNames(): void {
  byContent.clear();
  byName.clear();
}

// A Figma layer name is often a path (`icons/linear/arrow-down`, `Linear / School / Award`) and may be
// empty, emoji-laden or whitespace-padded. Take the LAST segment — that is the icon's actual name —
// and fall back to the node id when nothing usable survives.
// safe() is the FILESYSTEM-boundary sanitiser shared with the pages/ layout, and it folds every
// non-alphanumeric to "_" — including the hyphen, which is the single most common character in an
// icon name (`element-4`, `calendar-tick`, `arrow-down`). Turning those into `element_4` would swap
// one unreadable convention for another, so asset names keep `-` and `.` is dropped (an extension is
// appended by the caller and a second dot in the stem confuses every bundler).
function assetSafe(x: string): string {
  return String(x).replace(/[^a-zA-Z0-9-]+/g, "_").replace(/_+/g, "_");
}

function baseNameFor(a: { id: string; name: string; kind?: string }): string {
  if (a.kind === "reference") return safe(a.id.replace(/:ref$/, "")) + "_ref";
  if (a.kind === "source") return safe(a.id); // img:<hash> -> img_<hash>: the join back to a fill's `hash`
  const last = String(a.name || "").split("/").pop() || "";
  const cleaned = assetSafe(last.trim()).replace(/^[-_]+|[-_]+$/g, "");
  return cleaned || safe(a.id);
}

function register(a: { id: string; name: string; format: string; base64?: string; text?: string; kind?: string }): string {
  const fmt = safe(a.format);
  // A reference PNG is per-frame and keyed by id; deduping it against an identical-looking frame
  // would point two screens' `reference` at one file, which is exactly the confusion it exists to
  // resolve. Source images are already content-addressed by Figma's own hash.
  const dedupable = a.kind !== "reference";
  const hash = contentHash(a);

  if (dedupable) {
    const hit = byContent.get(hash + "." + fmt);
    if (hit) {
      // Same bytes, already on disk. Record who else points at it rather than writing a copy.
      (hit.asset.from || (hit.asset.from = [hit.asset.id])).push(a.id);
      return ASSET_DIR + hit.file;
    }
  }

  const base = baseNameFor(a);
  let file = base + "." + fmt;
  // Fold case for the UNIQUENESS check, not for the name written to disk: `angle-left.svg` and
  // `Angle-left.svg` are two different Figma layers that collide into ONE path on a case-insensitive
  // filesystem (macOS default) — write-out.js writes both into the same shared assets/ dir, so
  // whichever pull ran second silently clobbered the first (finding 124). Comparing case-folded keys
  // here means the SECOND name is treated as "taken" even though it differs only in case, so it gets
  // the same content-hash suffix a same-name-different-content collision gets — both files end up with
  // distinct, filesystem-safe names.
  const key = file.toLowerCase();
  const taken = byName.get(key);
  if (taken !== undefined && taken !== hash) {
    // Same human name (case-insensitively), different bytes — two distinct icons that happen to share
    // a leaf name, or differ only in case. Keep both, tell them apart by content, and never let the
    // second silently replace the first.
    file = base + "-" + hash.split("-")[0].slice(0, 6) + "." + fmt;
  }
  byName.set(file.toLowerCase(), hash);

  const asset: Asset = { ...a, file, hash };
  assets.push(asset);
  if (dedupable) byContent.set(hash + "." + fmt, { file, asset });
  return ASSET_DIR + file;
}

// Original uploaded image bytes + intrinsic size, resolved from an image-fill hash via
// figma.getImageByHash(). Distinct from collectAsset's PNG, which RE-rasterizes the node box (crop /
// filters / DPR baked in) — here we ship the un-re-encoded source at native resolution, and the
// intrinsic size gives the true aspect ratio (so codegen never upscales past native). Registered once
// per hash into the asset manifest (kind:"source"); returns the intrinsic size for the paint record.
// The real container format of an uploaded image, from its magic bytes. Figma re-encodes nothing here
// (these are the ORIGINAL bytes), so the extension has to come from the content — writing every source
// image as "<hash>.img" left files no viewer or bundler could open by name.
function imageFormat(b: Uint8Array): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  return "bin";
}

export function collectSourceImage(hash: string | undefined | null): Promise<{ w: number; h: number } | undefined> {
  const f = figma as any;
  if (!hash || typeof f.getImageByHash !== "function") return Promise.resolve(undefined);
  let p = imageSizeCache.get(hash);
  if (!p) {
    p = readSourceImage(f, hash);
    imageSizeCache.set(hash, p); // set BEFORE awaiting, so a concurrent fill joins this fetch
  }
  return p;
}

async function readSourceImage(f: any, hash: string): Promise<{ w: number; h: number } | undefined> {
  let size: { w: number; h: number } | undefined;
  try {
    const img = f.getImageByHash(hash);
    if (img) {
      if (typeof img.getSizeAsync === "function") {
        const s = await img.getSizeAsync();
        if (s && typeof s.width === "number") size = { w: s.width, h: s.height };
      }
      // The promise cache above already guarantees one pass per hash, so no dedupe scan is needed.
      if (typeof img.getBytesAsync === "function") {
        try {
          const bytes = await img.getBytesAsync();
          if (bytes && bytes.length) register({ id: "img:" + hash, name: hash, format: imageFormat(bytes), base64: toBase64(bytes), kind: "source" });
        } catch (e) { /* bytes optional — intrinsic size alone is still useful */ }
      }
    }
  } catch (e) {
    warn("source image unavailable for hash " + hash + " (" + errMsg(e) + ")");
  }
  return size;
}

// Sets, not arrays: both are tested once per serialized node, so the membership test runs thousands
// of times per export.
const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON", "ELLIPSE"]);
const ICON_CONTAINER_TYPES = new Set(["FRAME", "INSTANCE", "GROUP", "COMPONENT"]);

// Four outcomes, four shapes — NOT a magic string smuggled through the path channel: `undefined`
// (this node renders no asset), a path, `geometry` (the export failed but the node's own vector paths
// were recovered), or `skipped` when --no-assets suppressed a render that WOULD have happened
// (serialize.ts keeps the node a leaf — see the note on assetSkipped there). A caller that treats the
// result as a path can't accidentally write the sentinel into the exported tree.
export type AssetResult = { path: string } | { geometry: Obj } | { skipped: true } | undefined;

// Does this node paint ANYTHING? A live export reported 807 "failed" asset exports; the overwhelming
// majority were vector nodes with every fill and stroke invisible (or emptied), which Figma refuses to
// rasterize because there is genuinely nothing there. Those are not failures and must not be warned —
// warning on them buried the handful of real ones. `fills` can be figma.mixed, hence the Array guard.
function paints(v: unknown): ReadonlyArray<Paint> | null {
  return Array.isArray(v) ? (v as ReadonlyArray<Paint>) : null;
}
// `fills` is passed in rather than re-read: collectAsset already paid for that getter (see the note
// there — every read crosses the sandbox bridge and materializes fresh paint wrappers).
function hasVisiblePaint(n: any, fills: ReadonlyArray<Paint> | null): boolean {
  if (fills && fills.some((p) => p.visible !== false)) return true;
  const s = paints(n.strokes);
  return !!s && s.some((p) => p.visible !== false);
}
function hasArea(n: any): boolean {
  if (typeof n.width !== "number" || typeof n.height !== "number") return true; // unknown -> don't skip
  return n.width > 0 && n.height > 0;
}

// Last-resort icon recovery when exportAsync genuinely fails on a node that DOES paint something.
// `fillGeometry`/`strokeGeometry` are the RESOLVED outlines Figma renders (VectorNetwork-derived);
// `vectorPaths` is documented as "simple, but incomplete", so it is deliberately not used here. The
// node's own w/h come along so a consumer can drop the `d` strings straight into an inline
// <svg viewBox="0 0 w h"> — otherwise the paths have no coordinate space to be interpreted in.
function geometryOf(n: any): Obj | undefined {
  const ds = (g: unknown): string[] =>
    Array.isArray(g) ? g.map((p: any) => p && p.data).filter((d: unknown): d is string => typeof d === "string" && !!d) : [];
  const fills = ds(n.fillGeometry);
  const strokes = ds(n.strokeGeometry);
  if (!fills.length && !strokes.length) return undefined;
  const out: Obj = {};
  if (fills.length) out.fills = fills;
  if (strokes.length) out.strokes = strokes;
  if (typeof n.width === "number") { out.w = round(n.width); out.h = round(n.height); }
  return out;
}

export async function collectAsset(node: SceneNode): Promise<AssetResult> {
  const isVector = VECTOR_TYPES.has(node.type);
  const n = node as any;
  // node.fills / node.children are Plugin-API GETTERS — each read crosses the sandbox bridge and
  // materializes a fresh array of paint/node wrappers. Read each once per node, not three times.
  const fills: Paint[] | null = "fills" in node && Array.isArray(n.fills) ? n.fills : null;
  const kids: SceneNode[] | null = "children" in node && Array.isArray(n.children) ? n.children : null;
  // A visible image fill makes a LEAF (rectangle/shape) exportable as a PNG. But a CONTAINER that
  // merely uses an image as its BACKGROUND and has children (a hero/cover-card/banner/profile-header)
  // must NOT be flattened — doing so silently drops its text/buttons/nested layout and their tokens.
  // The image itself is already carried in the node's `fills`, so keep the structure and recurse;
  // only rasterize when there are no children to lose. (Mirrors the `iconLike` no-text guard below.)
  const hasImage = !!fills && fills.some((f) => f.type === "IMAGE" && f.visible !== false) && !(kids && kids.length > 0);
  // exportAsync flattens the WHOLE subtree into one SVG, so only treat a container as an icon/asset
  // when it's genuinely graphic: name matches AND it's icon-sized AND has no text descendant.
  let iconLike = false;
  if (
    ICON_CONTAINER_TYPES.has(node.type) &&
    node.name &&
    /icon|logo|illustration|avatar/i.test(node.name) &&
    "width" in node &&
    Math.max(n.width, n.height) <= 96
  ) {
    try {
      iconLike = !n.findOne((x: SceneNode) => x.type === "TEXT");
    } catch (e) {
      iconLike = false; // when unsure, keep the structure rather than flatten it
    }
  }
  // Figma's own asset heuristic (icon or raster image) — a free cross-check alongside the name/size
  // rule above, for containers our regex misses (unconventional names) as long as there's no text to lose.
  if (!iconLike && ICON_CONTAINER_TYPES.has(node.type) && n.isAsset === true) {
    try {
      iconLike = !n.findOne((x: SceneNode) => x.type === "TEXT");
    } catch (e) {
      iconLike = false;
    }
  }
  // --no-assets: bail out HERE — after the full export decision (isVector / iconLike / hasImage) is
  // known, but before any exportAsync. Deciding earlier, off a hand-rolled copy of the predicate, got
  // both halves wrong: it missed `iconLike` containers, so the count undercounted the real exports,
  // and returning `undefined` for them let serialize recurse into an icon's vector guts instead of
  // stopping at the leaf the normal run produces. That expanded the tree (measured 4.3x larger and
  // 41 -> 161 nodes on a 40-icon sheet), breaking this flag's documented promise that structure is
  // unaffected — and inflating the very payload it exists to shrink. One decision, both paths.
  if (runOpts.skipAssets && (isVector || iconLike || hasImage)) {
    stats.assetsSkipped++;
    return { skipped: true };
  }
  // The finest safe abort point, and the only one INSIDE a single frame. exportAsync is the one
  // per-node await in the whole walk, so a dense screen of 600 icons is otherwise a multi-minute
  // stretch with no page/frame boundary to check at — a Cancel pressed there would appear ignored.
  // Gated on "this node really is going to render something" so the phase label isn't a lie and the
  // throttle isn't consumed by the thousands of plain layout nodes that pass through here.
  if (isVector || iconLike || hasImage) {
    checkCancelled();
    progress("assets", { nodes: stats.nodes, assets: assets.length });
  }
  if (isVector || iconLike) {
    // The paint pre-check is for VECTOR-ish LEAVES only: an icon CONTAINER paints nothing itself —
    // its children do — so asking it the same question would skip every real icon frame.
    if (!hasArea(n) || (isVector && !hasVisiblePaint(n, fills))) {
      stats.assetsSkippedInvisible++;
      return undefined; // silent by design — see RunStats.assetsSkippedInvisible
    }
    let svg: string | null = null;
    let reason = "empty/invalid SVG";
    try {
      svg = await (node as any).exportAsync({ format: "SVG_STRING" });
    } catch (e) {
      reason = errMsg(e);
    }
    if (svg && svg.indexOf("<svg") !== -1) {
      return { path: register({ id: node.id, name: node.name, format: "svg", text: svg }) };
    }
    // The node DOES paint something and still would not render — recover its outlines rather than
    // emit a node with no graphic at all, which is what left 663 icons unimplementable.
    const geo = geometryOf(n);
    if (geo) {
      stats.assetsGeometry++;
      return { geometry: geo };
    }
    stats.assetsFailed++;
    warnKind("asset export failed (no geometry to fall back on)", node.name + " (" + node.id + "): " + reason);
    return undefined;
  }
  try {
    if (hasImage) {
      // useAbsoluteBounds:true exports the node's full dimensions rather than the cropped/clipped box,
      // so overhanging content isn't clipped out of the raster. (Verified: developers.figma.com ExportSettings.)
      const bytes = await (node as any).exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 }, useAbsoluteBounds: true });
      if (!bytes || !bytes.length) {
        stats.assetsFailed++;
        warnKind("image asset export empty", node.name + " (" + node.id + ")");
        return undefined;
      }
      return { path: register({ id: node.id, name: node.name, format: "png", base64: toBase64(bytes) }) };
    }
  } catch (e) {
    stats.assetsFailed++;
    warnKind("image asset export failed", node.name + " (" + node.id + "): " + errMsg(e));
  }
  return undefined;
}

// Render a whole top-level frame to a PNG the codegen agent can self-correct against. Also the
// on-demand single-node screenshot op (collectScreenshot in collect.ts) reuses this unchanged — same
// render, just called on a component/instance instead of a root. `opts.scale` lets that caller override
// the auto-capped default (a small icon rendered at the same 2048px cap as a full page would come out
// tiny); root callers never pass it, so their behavior is untouched.
export async function collectReference(node: SceneNode, opts?: { scale?: number }): Promise<string | undefined> {
  const n = node as any;
  if (!node || !("exportAsync" in node) || !("width" in node)) return undefined;
  try {
    const value = opts && typeof opts.scale === "number" && opts.scale > 0
      ? opts.scale
      : Math.min(2, 2048 / (Math.max(n.width || 0, n.height || 0) || 1));
    const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value } });
    if (!bytes || !bytes.length) {
      warn("reference screenshot empty: " + node.name);
      return undefined;
    }
    return register({ id: node.id + ":ref", name: node.name + " (reference)", format: "png", base64: toBase64(bytes), kind: "reference" });
  } catch (e) {
    warn("reference screenshot failed: " + node.name + " (" + errMsg(e) + ")");
    return undefined;
  }
}

// Dev-Mode resource links (Jira / GitHub / Storybook URLs pinned to nodes). Node-level + async, so
// call ONCE per exported root with includeChildren (never per-node — that would be O(nodes) round-trips).
export async function devResources(node: BaseNode): Promise<Obj[] | undefined> {
  const n = node as any;
  if (!node || typeof n.getDevResourcesAsync !== "function") return undefined;
  try {
    const rs = await n.getDevResourcesAsync({ includeChildren: true });
    if (!Array.isArray(rs) || !rs.length) return undefined;
    // Keep the owning node (r.nodeId) distinct from inheritedNodeId (a link inherited from the main
    // component), so a link on a specific child can be attributed rather than collapsed.
    return rs.map((r: any) => {
      const o: Obj = { name: r.name, url: r.url };
      if (r.nodeId) o.nodeId = r.nodeId;
      if (r.inheritedNodeId) o.inheritedNodeId = r.inheritedNodeId;
      return o;
    });
  } catch (e) {
    warn("dev resources unavailable for '" + node.name + "' (" + errMsg(e) + ")");
    return undefined;
  }
}
