// Rendering nodes to assets: vector/icon -> SVG, image-fill -> PNG, whole-frame reference PNG,
// and Dev-Mode resource links.
import { Obj, safe, toBase64, errMsg } from "./util";
import { assets, stats, warn, imageSizeCache } from "./state";

// The ONE place an asset filename is decided. `register` returns the path that goes into the node
// tree, and stores the identical basename on the asset record — so figma-pull / the UI download write
// exactly the name the tree points at instead of each re-deriving `safe(id) + "." + format`.
const ASSET_DIR = "assets/";
function register(a: { id: string; name: string; format: string; base64?: string; text?: string; kind?: string }): string {
  const file = safe(a.id) + "." + safe(a.format);
  assets.push({ ...a, file });
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

const VECTOR_TYPES = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON", "ELLIPSE"];
const ICON_CONTAINER_TYPES = ["FRAME", "INSTANCE", "GROUP", "COMPONENT"];

export async function collectAsset(node: SceneNode): Promise<string | undefined> {
  const isVector = VECTOR_TYPES.includes(node.type);
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
    ICON_CONTAINER_TYPES.includes(node.type) &&
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
  try {
    if (isVector || iconLike) {
      const svg = await (node as any).exportAsync({ format: "SVG_STRING" });
      if (!svg || svg.indexOf("<svg") === -1) {
        warn("asset export empty/invalid: " + node.name);
        stats.assetsFailed++;
        return undefined;
      }
      return register({ id: node.id, name: node.name, format: "svg", text: svg });
    }
    if (hasImage) {
      // useAbsoluteBounds:true exports the node's full dimensions rather than the cropped/clipped box,
      // so overhanging content isn't clipped out of the raster. (Verified: developers.figma.com ExportSettings.)
      const bytes = await (node as any).exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 }, useAbsoluteBounds: true });
      if (!bytes || !bytes.length) {
        warn("asset export empty: " + node.name);
        stats.assetsFailed++;
        return undefined;
      }
      return register({ id: node.id, name: node.name, format: "png", base64: toBase64(bytes) });
    }
  } catch (e) {
    warn("asset export failed: " + node.name + " (" + errMsg(e) + ")");
    stats.assetsFailed++;
  }
  return undefined;
}

// Render a whole top-level frame to a PNG the codegen agent can self-correct against.
export async function collectReference(node: SceneNode): Promise<string | undefined> {
  const n = node as any;
  if (!node || !("exportAsync" in node) || !("width" in node)) return undefined;
  try {
    const maxDim = Math.max(n.width || 0, n.height || 0) || 1;
    const value = Math.min(2, 2048 / maxDim);
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
