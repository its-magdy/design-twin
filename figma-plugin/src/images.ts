// The images of a write batch (docs/write-plane-spec.md decision 12; bridge/src/image-spec.ts). A paint from disk arrives
// as `{type:"image", file, image}`, its bytes once per image in the batch's `images` table (image id → base64), which the
// MCP server read from the file; a paint naming an image already in the file arrives as `{type:"image", hash}`.
//
// Checked first, with the names and fonts and adding nothing to the file (checkImages): every `hash` must name an image
// the file has (getImageByHash, then getSizeAsync: a handle can come back for a hash the file does not hold), and every
// image of the table a paint uses must have its bytes. Only once the whole batch resolved — and, for a batch that waits
// for the designer, once it was approved — is each of those images made (makeImages: figma.createImage, which hands
// the bytes to Figma and creates no node), so a batch refused or rejected before it runs loads no image (#206). A table
// image Figma cannot open, or a hash it does not have, refuses the whole batch with the file or the hash named. The
// build then reads the made images' hashes from here (setBatchImages), as it reads the batch's planned names from
// batch-plan.ts.
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

/** An image of the table a paint of the batch uses, checked but not yet made: its id, its file and bytes, and its uses. */
export interface PendingImage { id: string; file: string; b64: string; uses: Use[] }
type Use = { index: number; op: string; path: string };

/** One problem per op for a bad image, naming the first of its paints. */
function refuser(problems: OpProblem[]): (uses: readonly Use[], message: string) => void {
  return (uses, message) => {
    const seen = new Set<number>();
    for (const u of uses) {
      if (seen.has(u.index)) continue;
      seen.add(u.index);
      problems.push({ index: u.index, op: u.op, message: u.path + ": " + message });
    }
  };
}

/**
 * Check every image a paint of the batch names, without adding anything to the file: every `hash` must name an image
 * the file has, and every image of the table a paint uses must have come with its bytes. A problem for each op that
 * names a hash the file does not have (or one Figma could not look up) or an image without its bytes; the table's
 * images to make (makeImages) once the whole batch resolved.
 */
export async function checkImages(list: readonly WriteOp[], table: ImageTable | undefined): Promise<{ problems: OpProblem[]; pending: PendingImage[] }> {
  const ids = new Map<string, { file: string; uses: Use[] }>();
  const hashes = new Map<string, Use[]>();
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
  const refuse = refuser(problems);
  const pending: PendingImage[] = [];
  for (const [id, e] of ids) {
    const b64 = table && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
    if (b64 === undefined) { refuse(e.uses, "the image '" + e.file + "' came without its bytes (figma_write on the MCP server reads the file and sends them with the batch)"); continue; }
    pending.push({ id, file: e.file, b64, uses: e.uses });
  }
  for (const [hash, uses] of hashes) {
    let img: Image | null;
    try { img = figma.getImageByHash(hash); } catch (err) {
      refuse(uses, "Figma could not look up the image with hash '" + hash + "' (" + errMsg(err) + ")");
      continue;
    }
    let ok = img !== null;
    if (img) { try { await img.getSizeAsync(); } catch { ok = false; } }
    if (!ok) refuse(uses, "the file has no image with hash '" + hash + "' (a `hash` names an image already in the file: the `hash` of an image fill in the read, or one a write's reply gave in `images`)");
  }
  return { problems, pending };
}

/**
 * Make the checked images (figma.createImage hands each one's bytes to Figma and creates no node): the id → hash map
 * the build reads, the reply's rows for the made ones, the problem of the first image Figma cannot open, and how many
 * images were loaded (one per distinct hash; made ones stay whatever the batch comes to: nothing removes an image).
 * `allowed` is asked before each image (the designer can untick "Allow edits" while an image's size is read): once it
 * is false, no more images are made and `revoked` is set (also when it turned false while the last one's size was
 * read; it outranks a problem). The first image Figma cannot open stops it too: the batch is
 * refused then, so the images after it are not made.
 *
 * `loaded` counts the images this batch handed to Figma, not new ones: Figma's image table is content-addressed, so
 * bytes the file already holds come back as the hash it has, and nothing here can tell the two apart (getImageByHash
 * needs the hash, which createImage is what gives). The sentences that say it never call it added (writes.ts).
 */
export async function makeImages(pending: readonly PendingImage[], allowed: () => boolean): Promise<{ problems: OpProblem[]; made: Map<string, string>; images: MadeImage[]; loaded: number; revoked: boolean }> {
  const problems: OpProblem[] = [];
  const refuse = refuser(problems);
  const out = new Map<string, string>();
  const images: MadeImage[] = [];
  const hashes = new Set<string>();
  const result = (revoked: boolean) => ({ problems, made: out, images, loaded: hashes.size, revoked });
  for (const e of pending) {
    if (!allowed()) return result(true);
    let img: Image;
    try { img = figma.createImage(figma.base64Decode(e.b64)); } catch (err) {
      refuse(e.uses, "'" + e.file + "' is not an image Figma can open (" + errMsg(err) + ")");
      break;
    }
    hashes.add(img.hash);
    let size: { width: number; height: number };
    try { size = await img.getSizeAsync(); } catch (err) {
      refuse(e.uses, "'" + e.file + "' is not an image Figma can open (" + errMsg(err) + ")");
      break;
    }
    out.set(e.id, img.hash);
    images.push({ file: e.file, hash: img.hash, w: size.width, h: size.height });
  }
  // Unticked while the last one's size was read: said as that, before any problem.
  return result(!allowed());
}
