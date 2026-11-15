// image-spec.ts — an image fill in a write (docs/write-plane-spec.md decision 12): what it looks like, and where one
// can be in a batch.
//
// An image is a path on disk (`file`, read by the MCP server: image-file.ts) or the hash of an image already in the file
// (`hash`, the read's own field). Its bytes never go in a spec: the server reads the file, puts the sha-256 of its bytes
// in the paint as `image`, and sends the bytes once per image beside the ops (`images`, id → base64), so the plugin
// makes each image once (figma.createImage) and a keyed re-send stores only `file` and `image` (a changed file is a
// changed spec; an unchanged one is no change).
//
// Pure and dependency-free: the plugin bundle imports it (tree-spec.ts's fill check, the plugin's images.ts), so it must
// type-check under figma-plugin/tsconfig.json (ES2019 lib, no Node types) and use no `??` or `?.`.

/** The hash Figma gives an image (Image.hash, ImagePaint.imageHash): 40 lowercase hex characters (a SHA-1). */
export const IMAGE_HASH = /^[0-9a-f]{40}$/;
/** The id the server gives an image it read from disk: the sha-256 of its bytes, 64 lowercase hex characters. */
export const IMAGE_ID = /^[0-9a-f]{64}$/;
/** Why an image's bytes (or a link to them) are refused in a spec. */
export const IMAGE_BYTES_REASON = "an image is a path on disk (`file`, read by the server) or the hash of an image already in the file (`hash`); its bytes never go in a spec";
/** The keys under which a spec might carry an image's bytes or a link to them: each is refused with IMAGE_BYTES_REASON. */
export const IMAGE_BYTES_KEYS: readonly string[] = ["data", "bytes", "base64", "src", "url"];
/** The batch's images as the server sends them to the plugin: an image's id → its bytes in base64. */
export type ImageTable = Record<string, string>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A `data:` URI, or a URL with a scheme (`https://…`, `file://…`): not a path on disk, nor a hash. */
export const isInlineOrUrl = (v: string): boolean => /^\s*data:/i.test(v) || /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(v);
/** The longest `file` taken as a path: a longer one is refused unread and unquoted (it may be bytes). */
export const MAX_IMAGE_PATH = 1024;
/** Bare base64 given as a path: the start of a PNG, JPEG or GIF in base64, or a long run of base64 text with no `.` (a
 *  picture's path has an extension). */
export const isBareBase64 = (v: string): boolean => {
  const s = v.trim();
  return /^(iVBORw0KGgo|\/9j\/|R0lGOD)/.test(s) || (s.length >= 64 && s.indexOf(".") < 0 && /^[A-Za-z0-9+/\s]+={0,2}$/.test(s));
};

/** Is `v` a paint with `type: "image"`? */
export const isImagePaint = (v: unknown): v is Record<string, unknown> => isObj(v) && v.type === "image";

/** The keys of a write whose lists hold paints: a node's `fills`, a paint style's `paints`. */
const PAINT_LISTS = ["fills", "paints"];

/** Every image paint in `v` (an op, a spec, a part of one), with its path below `at` (`ops[0].tree.children[1].fills[0]`),
 *  in document order: every paint of a `fills` or `paints` list, at every depth (a node, a fragment, a row's or an edit's
 *  fields, a patch's `set`, a style's `set`). */
export function imagePaintsIn(v: unknown, at: string): Array<{ paint: Record<string, unknown>; path: string }> {
  const out: Array<{ paint: Record<string, unknown>; path: string }> = [];
  const walk = (x: unknown, p: string): void => {
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) walk(x[i], p + "[" + i + "]"); return; }
    if (!isObj(x)) return;
    for (const k of Object.keys(x)) {
      const val = x[k];
      const kp = p + "." + k;
      if (PAINT_LISTS.indexOf(k) >= 0 && Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          const paint: unknown = val[i];
          if (isImagePaint(paint)) out.push({ paint, path: kp + "[" + i + "]" });
        }
        continue;
      }
      walk(val, kp);
    }
  };
  walk(v, at);
  return out;
}

/** `v` with every image paint `fn` returns a new paint for replaced by it (in the places imagePaintsIn finds them); the
 *  objects and lists on the way to one are copied, and the rest is shared. `fn` gets the paint and its path below `at`,
 *  and returns null to keep it. */
export function mapImagePaints(v: unknown, at: string, fn: (paint: Record<string, unknown>, path: string) => Record<string, unknown> | null): unknown {
  const map = (x: unknown, p: string): unknown => {
    if (Array.isArray(x)) {
      let copy: unknown[] | null = null;
      for (let i = 0; i < x.length; i++) {
        const y = map(x[i], p + "[" + i + "]");
        if (y !== x[i]) { if (!copy) copy = x.slice(); copy[i] = y; }
      }
      return copy || x;
    }
    if (!isObj(x)) return x;
    let copy: Record<string, unknown> | null = null;
    for (const k of Object.keys(x)) {
      const val = x[k];
      const kp = p + "." + k;
      let next: unknown = val;
      if (PAINT_LISTS.indexOf(k) >= 0 && Array.isArray(val)) {
        let list: unknown[] | null = null;
        for (let i = 0; i < val.length; i++) {
          const paint: unknown = val[i];
          const r = isImagePaint(paint) ? fn(paint, kp + "[" + i + "]") : null;
          if (r !== null) { if (!list) list = val.slice(); list[i] = r; }
        }
        next = list || val;
      } else next = map(val, kp);
      if (next !== val) { if (!copy) copy = { ...x }; copy[k] = next; }
    }
    return copy || x;
  };
  return map(v, at);
}

/** What an image paint carries that is an image's bytes (or a link to them), as "<key>: <reason>", or null. Checked by the
 *  server before it reads anything, and by the fill check. */
export function inlineImageProblem(p: Record<string, unknown>): string | null {
  for (const k of IMAGE_BYTES_KEYS) if (p[k] !== undefined) return "." + k + ": " + IMAGE_BYTES_REASON;
  for (const k of ["file", "hash"]) {
    const v = p[k];
    if (typeof v === "string" && isInlineOrUrl(v)) return "." + k + ": is " + (/^\s*data:/i.test(v) ? "a data: URI" : "a URL") + "; " + IMAGE_BYTES_REASON; // never echoed: it may hold the bytes
  }
  const f = p.file;
  if (typeof f === "string" && isBareBase64(f)) return ".file: is base64 text, not a path; " + IMAGE_BYTES_REASON;
  if (typeof f === "string" && f.length > MAX_IMAGE_PATH) return ".file: is " + f.length + " characters, longer than a path (" + MAX_IMAGE_PATH + "); " + IMAGE_BYTES_REASON;
  return null;
}

/** What is wrong with a batch's image table (`images`), or null: an object of image id → base64 text. */
export function imageTableError(v: unknown): string | null {
  if (v === undefined) return null;
  if (!isObj(v)) return "`images` is not an object of image id → base64 bytes";
  for (const k of Object.keys(v)) {
    if (!IMAGE_ID.test(k)) return "`images` has a key that is not an image id (the sha-256 of its bytes, 64 lowercase hex characters)"; // not quoted: it may be bytes
    const b = v[k];
    if (typeof b !== "string" || !b.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(b)) return "`images." + k + "` is not base64 text";
  }
  return null;
}
