// The images of a write batch (docs/write-plane-spec.md decision 12; bridge/src/image-spec.ts). A paint from disk arrives
// as `{type:"image", file, image}`, its bytes once per image in the batch's `images` table (image id → base64), which the
// MCP server read from the file; a paint naming an image already in the file arrives as `{type:"image", hash}`.
//
// Before anything touches the document, with the names and fonts: every image of the table a paint uses is made
// (figma.createImage, which adds the image to the file and creates no node), and every `hash` must name an image the
// file has (getImageByHash, then getSizeAsync: a handle can come back for a hash the file does not hold). A table image
// Figma cannot open, or a hash it does not have, refuses the whole batch with the file or the hash named. The build then
// reads the made images' hashes from here (setBatchImages), as it reads the batch's planned names from batch-plan.ts.
import type { TreeImageFill } from "../../bridge/src/tree-spec.ts";
import type { WriteOp } from "../../bridge/src/commands.ts";
import { imagePaintsIn, type ImageTable } from "../../bridge/src/image-spec.ts";
import type { OpProblem } from "./write-batch";
import { errMsg } from "./util";

/** An image the batch made from a file: the reply's `images` row, so the next spec can reuse it by `hash`. */
export interface MadeImage { file: string; hash: string; w: number; h: number }

/** The batch's made images: image id → Figma's hash. Set while one batch resolves and runs (writes run one at a time). */
let made = new Map<string, string>();
export function setBatchImages(m: Map<string, string> | null): void {
  made = m || new Map<string, string>();
}

const SCALE = { fill: "FILL", fit: "FIT", tile: "TILE" } as const;

/** The ImagePaint an image fill makes: its image (made from the table, or the file's own by `hash`), how it fills the
 *  node, and its opacity. */
export function imagePaint(f: TreeImageFill): ImagePaint {
  const hash = f.hash !== undefined ? f.hash : f.image !== undefined ? made.get(f.image) : undefined;
  if (!hash) throw new Error("the image" + (f.file !== undefined ? " '" + f.file + "'" : "") + " was not made before the batch ran");
  const p: { type: "IMAGE"; imageHash: string; scaleMode: "FILL" | "FIT" | "TILE"; scalingFactor?: number; opacity?: number } = {
    type: "IMAGE", imageHash: hash, scaleMode: SCALE[f.scaleMode || "fill"],
  };
  if (f.scaleMode === "tile" && f.scale !== undefined) p.scalingFactor = f.scale;
  if (f.opacity !== undefined && f.opacity < 1) p.opacity = f.opacity;
  return p;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Make every image of the table a paint of the batch uses, and check every `hash` a paint names: the id → hash map the
 * build reads, the reply's rows for the made ones, and a problem for each op that names an image that could not be made
 * or a hash the file does not have.
 */
export async function resolveImages(list: readonly WriteOp[], table: ImageTable | undefined): Promise<{ problems: OpProblem[]; made: Map<string, string>; images: MadeImage[] }> {
  const ids = new Map<string, { file: string; uses: Array<{ index: number; op: string; path: string }> }>();
  const hashes = new Map<string, Array<{ index: number; op: string; path: string }>>();
  for (const [index, op] of list.entries()) {
    for (const { paint, path } of imagePaintsIn(op, "")) {
      const use = { index, op: op.op, path: path.slice(1) };
      const id = str(paint.image), hash = str(paint.hash);
      if (id !== undefined) {
        let e = ids.get(id);
        if (!e) { e = { file: str(paint.file) || id, uses: [] }; ids.set(id, e); }
        e.uses.push(use);
      } else if (hash !== undefined) {
        let e = hashes.get(hash);
        if (!e) { e = []; hashes.set(hash, e); }
        e.push(use);
      }
    }
  }
  const problems: OpProblem[] = [];
  /** One problem per op for a bad image, naming the first of its paints. */
  const refuse = (uses: ReadonlyArray<{ index: number; op: string; path: string }>, message: string): void => {
    const seen = new Set<number>();
    for (const u of uses) {
      if (seen.has(u.index)) continue;
      seen.add(u.index);
      problems.push({ index: u.index, op: u.op, message: u.path + ": " + message });
    }
  };
  const out = new Map<string, string>();
  const images: MadeImage[] = [];
  for (const [id, e] of ids) {
    const b64 = table && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
    if (b64 === undefined) { refuse(e.uses, "the image '" + e.file + "' came without its bytes (figma_write on the MCP server reads the file and sends them with the batch)"); continue; }
    let img: Image;
    try { img = figma.createImage(figma.base64Decode(b64)); } catch (err) {
      refuse(e.uses, "'" + e.file + "' is not an image Figma can open (" + errMsg(err) + ")");
      continue;
    }
    let size: { width: number; height: number };
    try { size = await img.getSizeAsync(); } catch (err) {
      refuse(e.uses, "'" + e.file + "' is not an image Figma can open (" + errMsg(err) + ")");
      continue;
    }
    out.set(id, img.hash);
    images.push({ file: e.file, hash: img.hash, w: size.width, h: size.height });
  }
  for (const [hash, uses] of hashes) {
    const img = figma.getImageByHash(hash);
    let ok = img !== null;
    if (img) { try { await img.getSizeAsync(); } catch { ok = false; } }
    if (!ok) refuse(uses, "the file has no image with hash '" + hash + "' (a `hash` names an image already in the file: the `hash` of an image fill in the read, or one a write's reply gave in `images`)");
  }
  return { problems, made: out, images };
}
