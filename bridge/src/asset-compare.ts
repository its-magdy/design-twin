// asset-compare.ts — Node-side byte comparison built on svg-normalize.ts's two definitions: the v1
// normalised hash (normalizeForCompare/sameAsset — design-diff's, unchanged) and the fingerprint index
// the shared assets/ directory dedups with (ContentIndex, below).
//
// Split out of svg-normalize.ts (rather than living there) because this needs `crypto`, which the
// Figma plugin sandbox does not have — and svg-normalize.ts must type-check under the plugin's
// tsconfig (no Node types) and bundle into the plugin, so an `import … from "node:crypto"` anywhere
// in a file the plugin bundle imports breaks that build, even for a function the bundle never calls.
// svg-normalize.ts stays crypto-free so figma-plugin/src/util.ts can safely re-export it; this file
// is imported only from Node (bridge/src/write-out.ts, design-to-code/design-diff.ts — the latter
// bundled by claude-plugin/build-scripts.ts the same way it already bundles bridge/src/snapshot-meta.ts).
import crypto from "node:crypto";
import { normalizeSvgText, isSvgName, svgFingerprint, numsWithin, relWithin, SVG_TOL } from "./svg-normalize.ts";

// `content` may be a Buffer (bytes on disk / about to be written) or a string (an SVG the plugin just
// produced, before it's ever touched a filesystem) — normalised either way. Always returns a Buffer.
export function normalizeForCompare(fileName: unknown, content: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (!isSvgName(fileName)) return buf;
  return Buffer.from(normalizeSvgText(buf.toString("utf8")), "utf8");
}

export function sha1Hex(buf: Buffer | string): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

// The comparison every "is this the same asset" decision should use: true if the two byte strings are
// the same asset MODULO Figma's own export noise (SVG coordinate rounding only; PNG/other bytes are
// compared exactly — a changed pixel there is real signal, not noise).
export function sameAsset(fileName: unknown, a: Buffer | string, b: Buffer | string): boolean {
  return Buffer.compare(normalizeForCompare(fileName, a), normalizeForCompare(fileName, b)) === 0;
}

// ---- ContentIndex: "is this content already in assets/, under ANY name" (DT-18, D61)
//
// A hash cannot express "within a tolerance", so the index is two-level: the KEY is exact — sha1 of the
// SVG's fingerprint skeleton (ids canonical, numbers out), or sha1 of the bytes for anything that is not an
// SVG (a changed pixel is real signal) — and inside one key's bucket the members are compared on their
// numbers, every one within SVG_TOL (a `<use>`/`<image>` transform's relatively — svg-normalize.ts M-5). Members are kept in REPRESENTATIVE order — the plain name before a
// `-<6 hex>[_N]` suffixed copy, then the shortest, then alphabetical (ownCopyWithContent's order in
// write-out.ts) — so `find` names the same file whichever order the directory listed them in.

/** The exact half of an asset's content identity, plus the numbers its tolerance applies to (`rel`: the
 *  relatively compared ones). */
export interface ContentKey { key: string; nums: Float64Array; rel: Float64Array }
interface Member { name: string; nums: Float64Array; rel: Float64Array }
/** One cluster of files the index treats as the same asset; `files[0]` is its representative. */
export interface ContentGroup { hash: string; files: string[] }

const EMPTY_NUMS = new Float64Array(0);
const SUFFIXED_RE = /-[0-9a-z]{6}(_\d+)?\.[^.]+$/i;

/** Representative order: plain name first, then shortest, then alphabetical. */
export function representativeOrder(x: string, y: string): number {
  const sx = SUFFIXED_RE.test(x) ? 1 : 0, sy = SUFFIXED_RE.test(y) ? 1 : 0;
  return sx - sy || x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

export function contentKey(fileName: unknown, content: Buffer | string): ContentKey {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (!isSvgName(fileName)) return { key: "b:" + sha1Hex(buf), nums: EMPTY_NUMS, rel: EMPTY_NUMS };
  const fp = svgFingerprint(buf.toString("utf8"));
  return { key: "s:" + sha1Hex(fp.skeleton), nums: fp.nums, rel: fp.rel };
}

// A stable id for a cluster: its key plus its representative's numbers rounded to 2 places (`-0.00` folded
// into `0.00`), and its `rel` numbers to 3 significant digits (two clusters of one key may differ only
// there). Reported as `duplicates[].hash` — it names the group, it is not a hash of any one file.
function groupHash(key: string, m: Member): string {
  let text = key + "|";
  for (const n of m.nums) { const f = n.toFixed(2); text += (f === "-0.00" ? "0.00" : f) + ","; }
  if (m.rel.length) { text += "|"; for (const n of m.rel) text += (n === 0 ? "0" : n.toPrecision(3)) + ","; }
  return sha1Hex(text);
}
const within = (a: Member | ContentKey, b: Member | ContentKey, tol: number): boolean => numsWithin(a.nums, b.nums, tol) && relWithin(a.rel, b.rel, tol);

export class ContentIndex {
  private readonly buckets = new Map<string, Member[]>();
  private readonly tol: number;
  constructor(tol: number = SVG_TOL) { this.tol = tol; }

  /** The first member (representative order) the same as `k`, or undefined. */
  findKey(k: ContentKey): string | undefined {
    const bucket = this.buckets.get(k.key);
    if (!bucket) return undefined;
    for (const m of bucket) if (within(m, k, this.tol)) return m.name;
    return undefined;
  }
  find(fileName: string, content: Buffer | string): string | undefined { return this.findKey(contentKey(fileName, content)); }

  /** Add a file under `name` (a name already present is replaced, so a rewrite never leaves a stale member). */
  addKey(name: string, k: ContentKey): void {
    for (const [key, members] of this.buckets) {
      const i = members.findIndex((m) => m.name === name);
      if (i >= 0) { members.splice(i, 1); if (!members.length) this.buckets.delete(key); break; }
    }
    let bucket = this.buckets.get(k.key);
    if (!bucket) { bucket = []; this.buckets.set(k.key, bucket); }
    bucket.push({ name, nums: k.nums, rel: k.rel });
    bucket.sort((x, y) => representativeOrder(x.name, y.name));
  }
  add(name: string, content: Buffer | string): void { this.addKey(name, contentKey(name, content)); }

  /** Every cluster, singletons included. Each member joins the first cluster (representative order) whose
   *  representative is within tolerance of it. `find` answers "the first member within tolerance", which is
   *  that same representative unless members chain apart by more than the tolerance (never seen: the real
   *  drift is 0.004, the tolerance 0.01). */
  groups(): ContentGroup[] {
    const out: ContentGroup[] = [];
    for (const [key, members] of this.buckets) {
      const clusters: Member[][] = [];
      for (const m of members) {
        const c = clusters.find((cl) => { const rep = cl[0]; return rep !== undefined && within(rep, m, this.tol); });
        if (c) c.push(m); else clusters.push([m]);
      }
      for (const cl of clusters) {
        const rep = cl[0];
        if (rep) out.push({ hash: groupHash(key, rep), files: cl.map((m) => m.name) });
      }
    }
    return out;
  }
}
