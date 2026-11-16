// capture-page.ts — the shipped page capture: open a page URL in the PROJECT's Playwright (chromium), read what it
// rendered with the probe the verify step uses, and write a tree spec per viewport width that
// `figma_write {op:"createTree", treeFile}` lands (docs/write-plane-spec.md, "From an existing app to Figma"). The model
// types no node. Flags and exit codes: --help.
//
// How: one fresh browser context per width (the probe's context options and init script: no animations, the page
// runtime window.__dt). The page is loaded, its fonts, --ready and a quiet DOM waited for, its lazy images made eager.
// The walker (probe-capture.ts) gives the visible element tree with its layout facts; the probe's reader (probe-page.ts
// measureElements) gives every visual value; Chromium says, over CDP, which font family it actually drew each text with.
// Images the page loaded are saved as they are when Figma takes them (PNG, JPEG, GIF, ≤ 8 MB, ≤ 4096 px), anything else
// (WebP, AVIF, SVG, an inline <svg>, a <canvas>, a <video>) as a PNG screenshot of that element alone; files go to
// <out>/images/<sha256>.<ext>, named by their bytes. The converter (capture-spec.ts) turns it into a spec, which must pass
// the tree spec's own check before anything is written. Nothing is written unless every width converted.
//
// The component map (design/codeconnect.local.json, or --map) is read in the write direction (code-usage.ts
// figmaUsageOf): an element whose code component it names (data-component, else a React dev build's fibers: the walker
// reads them) lands as an instance with its props. The ops it prints carry `bind: true` (the plugin binds raw values to
// the file's variables and text styles), and every part repeated with no component is written as a candidate
// component spec beside the screen's.
//
// Writes stay on the MCP server: this script writes files only (the specs, their images, a report); it is not a write
// command. A font the Figma file lacks is never swapped: the plugin's createTree check refuses the batch, listing every
// missing font with the closest names the file has, and the report lists every family and style up front.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { INIT_SCRIPT, browserPathError, launch, rendererUnavailable, resolvePlaywright } from "./probe-browser.ts";
import { eagerImages, hideChildren, walkCapture, type WalkEl, type WalkOutput, type WalkRun } from "./probe-capture.ts";
import { measureElements, type MeasureItem, type MeasureResult, type PValue } from "./probe-page.ts";
import { byPath } from "./page-runtime.ts";
import { contextOptions } from "./probe-session.ts";
import { STYLE_KEYS } from "./verify-shared.ts";
import { captureSpec, checkCaptured, firstFamily, type CapBorder, type CapEl, type CapFont, type CapImage, type CapText, type Candidate, type CaptureDoc, type CaptureStats } from "./capture-spec.ts";
import { figmaUsageOf, mapEntriesByCode, type CodeIndex } from "./code-usage.ts";
import { isCodeConnectMap } from "./map-validate-core.ts";
import { readJson } from "../bridge/src/read-json.ts";
import { findMapFile } from "../bridge/src/project-layout.ts";
import { sniffImage, MAX_BATCH_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from "../bridge/src/image-file.ts";
import { MAX_TREE_NODES } from "../bridge/src/tree-spec.ts";
import type { TreeNodeSpec } from "../bridge/src/tree-spec.ts";
import { sha256Hex } from "../bridge/src/hash.ts";
import { writeFileAtomic } from "../bridge/src/atomic-write.ts";
import { errMsg, firstLine } from "../bridge/src/errmsg.ts";
import { pwErrorKind } from "./pw-errors.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { runCli } from "./proc.ts";

const TOOL = "capture-page";
const USAGE =
  "usage:\n" +
  `  ${scriptCmd(TOOL)} --url <url> [--width 1280[,390,…]] [--height 800] [--root <css selector>] [--name <slug>]\n` +
  "      [--out design/capture] [--project <dir>] [--ready <selector> | none] [--timeout <ms>] [--browser-path <executable>]\n" +
  "      [--map <codeconnect.local.json>] [--no-instances] [--no-bind]\n" +
  "      opens <url> (local or remote) in the PROJECT's Playwright (chromium) at each --width (px; default 1280) with a\n" +
  "      --height px viewport (default 800), waits for its load, its fonts, --ready (a selector that must be visible; default\n" +
  "      none) and a quiet DOM, and captures the whole document's height — or only the --root element's box. It writes, under\n" +
  "      --out (default design/capture, inside --project, the directory the MCP server is started in; default cwd):\n" +
  "        <name>@<width>.json   a tree spec per width, for figma_write {op:\"createTree\", treeFile:\"…\"}\n" +
  "        images/<sha256>.<ext> every image the spec paints (PNG, JPEG or GIF as the page loaded it; anything else as a PNG\n" +
  "                              screenshot of that element)\n" +
  "        <name>.capture.json   the report: per width the node count, frames / texts / instances / images, every font\n" +
  "                              (family + style) the spec uses, what was dropped or approximated (counts and sample paths),\n" +
  "                              the instances by component (and what their props could not say), the code components the\n" +
  "                              map does not name, the candidate components, and the ops\n" +
  "        <name>@<width>.candidates/<n>-<tag>.tree.json   a COMPONENT spec per part repeated with no component (a card, a\n" +
  "                              row), a TEXT property per text that differs; making it does not replace the occurrences (map\n" +
  "                              the new component to its code, then capture again)\n" +
  "      and prints one summary line, then the figma_write ops as JSON (several widths: one batch, all or nothing).\n" +
  "      --name: the files' slug (letters, digits, . _ -; default from the URL's path, else its host). The root of each spec\n" +
  "      is the frame '<name> @<width>' keyed capture:<name>@<width>, so sending it again updates that frame in place.\n" +
  "      Flex and grid become auto-layout, text real text in the font Chromium drew it with (a font the Figma file lacks is\n" +
  "      refused when the spec lands, never swapped). An element the component map names (its data-component, \"Export\" or\n" +
  "      \"module#Export\" with its props in data-props JSON, else a React dev build's component) lands as an instance of the\n" +
  "      Figma component, its props read back through the map. --map: the map (default design/codeconnect.local.json, then\n" +
  "      ./codeconnect.local.json; none: no instances); --no-instances reads none. The ops carry bind:true, so the file's\n" +
  "      variables and text styles that equal a raw value are bound when the spec lands; --no-bind leaves it off.\n" +
  "      Shadows, gradients, pseudo-element content, transforms and filters are not written (the tree spec has no effects).\n" +
  `      A capture over ${MAX_TREE_NODES} nodes is refused (exit 5): capture part of the page with --root <selector>.\n` +
  "      --browser-path: launch this Chromium executable instead of the one Playwright installed (a cached browser).\n" +
  `  ${scriptCmd(TOOL)} --check [--project <dir>] [--browser-path <executable>]\n` +
  "      resolves the project's Playwright and launches chromium once — nothing captured, nothing written.\n" +
  "exit: 0 wrote · 2 usage · 3 renderer unavailable (ask the user to install; never installed here) · 4 the page could\n" +
  "      not be loaded or captured (unreachable, timed out, --ready or --root not found, the browser closed) · 5 the capture\n" +
  `      is too large (over ${MAX_TREE_NODES} nodes or the nesting limit, or more than 32 MB of images over all widths: they are one\n` +
  "      batch) — nothing written. --timeout (default 30000) bounds the page's load, fonts, --ready, images and quiet DOM together,\n" +
  "      then reading what it rendered (its elements, fonts drawn and image bytes) together.";

/** The most elements the walk keeps: far past a spec's node cap, so a refused capture still says how big the page is. */
const MAX_WALK = 5000;
const QUIET_MS = 500, QUIET_CAP_MS = 10_000, IMAGE_WAIT_MS = 5_000, CLOSE_MS = 5_000;

/** Why a capture stopped (exit 4 or 5), with nothing written. */
export class CaptureError extends Error {
  readonly exit: 4 | 5;
  constructor(message: string, exit: 4 | 5) { super(message); this.exit = exit; }
}

/** `p`, or a CaptureError (exit 4) once `deadline` (epoch ms) passes: a page.evaluate has no timeout of its own (a font
 *  load that never ends would hang the capture past --timeout, its browser never closed). The timer is cleared either
 *  way; a late rejection of `p` (the context closed under it) is swallowed. */
export async function within<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CaptureError(`${what} did not finish within --timeout`, 4)), Math.max(0, deadline - Date.now())); });
  p.catch(() => undefined);
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/** The images of one batch — every width's, since all widths land in one figma_write — by sha-256: each counted once,
 *  refused past MAX_BATCH_IMAGE_BYTES (what the MCP server would refuse) before anything is written. */
export class ImageBudget {
  private readonly seen = new Map<string, number>();
  total = 0;
  readonly max: number;
  constructor(max = MAX_BATCH_IMAGE_BYTES) { this.max = max; }
  /** Counts the image in; the refusal's reason when it would take the batch past the cap (it is then not counted). */
  add(sha: string, size: number): string | null {
    if (this.seen.has(sha)) return null;
    if (this.total + size > this.max) return `the images of the capture are more than ${this.max / (1024 * 1024)} MB together (every width is one figma_write batch): capture fewer widths, or part of the page with --root <selector>`;
    this.seen.set(sha, size);
    this.total += size;
    return null;
  }
}

/** The exit-4 refusal once `deadline` (epoch ms) has passed, else null: a failure past it is the read running out of
 *  --timeout (a canvas that never holds still, a body that never ends), never an image quietly dropped. */
export function pastDeadline(deadline: number, what: string): CaptureError | null {
  return Date.now() >= deadline ? new CaptureError(`${what} did not finish within --timeout`, 4) : null;
}

/** A screenshot's bytes, kept: a screenshot that cannot be taken is null (the caller notes the image dropped); a refusal
 *  of what was taken (the batch's image cap, a CaptureError) is not swallowed, nor is a failure once `deadline` passed. */
export async function keptShot(take: () => Promise<Buffer>, keep: (b: Buffer) => Kept | null, deadline = Infinity): Promise<Kept | null> {
  let b: Buffer;
  try { b = await take(); } catch (e) {
    if (e instanceof CaptureError) throw e;
    const late = pastDeadline(deadline, "taking an element's screenshot");
    if (late) throw late;
    return null;
  }
  return keep(b);
}

/**
 * Why writing under `project` would leave it on disk, or null. Lexically inside is not enough: a symlinked --out, its
 * images/ or any directory above them inside the project can lead out of it. Every directory in `dirs` that exists (or
 * its nearest existing ancestor) must resolve (realpath) inside the project's own realpath; a file in `files` that
 * exists as a symlink is refused (writeFileAtomic's rename would replace the link, but the MCP server reads through it).
 */
export function outputEscape(project: string, dirs: readonly string[], files: readonly string[]): string | null {
  const real = fs.realpathSync(project);
  const inside = (p: string): boolean => { const r = path.relative(real, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const lexists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };
  for (const d of dirs) {
    let at = path.resolve(d);
    while (!lexists(at) && path.dirname(at) !== at) at = path.dirname(at);
    let r: string;
    try { r = fs.realpathSync(at); } catch { return `${at} is a link that leads nowhere`; }
    if (!inside(r)) return `${at} leads out of --project (${project}) to ${r}`;
    if (lexists(d) && !fs.statSync(d).isDirectory()) return `${d} is not a directory`;
  }
  for (const f of files) {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(f); } catch { st = null; }
    if (st && st.isSymbolicLink()) return `${f} is a symbolic link (never written through)`;
    if (st && !st.isFile()) return `${f} is not a file`;
  }
  return null;
}

/** A slug for the files from the URL: its path's segments, else its host; generic, lower case. */
export function nameFromUrl(url: string): string {
  let u: URL | null = null;
  try { u = new URL(url); } catch { u = null; }
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const noExt = (s: string): string => s.replace(/\.[a-z0-9]+$/i, "");
  if (!u) return clean(noExt(url)).slice(0, 60) || "page";
  const segs = u.pathname.split("/").filter((s) => s !== "" && !/^index\.html?$/i.test(s)).map((s) => clean(noExt(s))).filter((s) => s !== "");
  const host = clean(u.hostname.replace(/^www\./, ""));
  return (segs.length ? segs.join("-") : host || "page").slice(0, 60) || "page";
}

// ---------------------------------------------------------------- loading the page
// Every wait is bounded by one deadline, --timeout from the start: Playwright's own waits get what is left of it, a
// page.evaluate (no timeout of its own) races it (within).
async function settle(page: Page, url: string, ready: string | null, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  // never 0: to Playwright a 0 timeout is none
  const left = (): number => Math.max(1, deadline - Date.now());
  const fonts = async (): Promise<unknown> => await within(page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true").catch(() => undefined), deadline, `the page's fonts (document.fonts.ready, ${timeout} ms)`);
  try { await page.goto(url, { waitUntil: "load", timeout: left() }); } catch (e) {
    const kind = pwErrorKind(e, page);
    throw new CaptureError(kind === "timeout" ? `${url} did not finish loading within ${timeout} ms` : `${url} could not be loaded (${firstLine(e)})`, 4);
  }
  await fonts();
  if (ready !== null) {
    try { await page.locator(ready).first().waitFor({ state: "visible", timeout: left() }); } catch (e) {
      throw new CaptureError(`--ready ${ready} was not visible within ${timeout} ms (${firstLine(e)})`, 4);
    }
  }
  // the whole height is captured, not the first screen: lazy images load now
  const end = Math.min(deadline, Date.now() + IMAGE_WAIT_MS);
  const eager = async (): Promise<number> => await within(page.evaluate(eagerImages), deadline, `making the page's images load (${timeout} ms)`);
  for (let loading = await eager(); loading > 0 && Date.now() < end; loading = await eager()) await sleep(100);
  // a quiet DOM: no mutation for QUIET_MS (at most QUIET_CAP_MS)
  await within(page.evaluate(`new Promise((done) => {
    let last = Date.now();
    const o = new MutationObserver(() => { last = Date.now(); });
    o.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const start = Date.now();
    const tick = () => { if (Date.now() - last >= ${QUIET_MS} || Date.now() - start >= ${QUIET_CAP_MS}) { o.disconnect(); done(true); } else setTimeout(tick, 50); };
    tick();
  })`).catch(() => undefined), deadline, `waiting for a quiet DOM (${timeout} ms)`);
  await fonts();
}

// ---------------------------------------------------------------- reading the values
const num = (v: PValue | undefined, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: PValue | undefined): string => (typeof v === "string" ? v : "");
const sides = (v: PValue | undefined): [number, number, number, number] => {
  const a = Array.isArray(v) ? v : [];
  return [num(a[0]), num(a[1]), num(a[2]), num(a[3])];
};
const TRANSPARENT = /^(transparent|rgba\([^)]*,\s*0(?:\.0+)?\s*\))$/;
const paint = (v: PValue | undefined): string | null => { const c = str(v).trim(); return c && !TRANSPARENT.test(c) ? c : null; };

/** The face Chromium drew a text with: its family, and its PostScript name (which names its style). */
interface Rendered { family: string; face: string }
/** The weight and italic a face's PostScript name says (`Arial-BoldMT`, `Inter-SemiBoldItalic`), or null when it names
 *  none it knows. */
export function faceStyle(face: string): { weight: number | null; italic: boolean } {
  const i = face.lastIndexOf("-");
  const tail = (i < 0 ? "" : face.slice(i + 1)).replace(/(MT|PS)$/, "").toLowerCase();
  const italic = /italic|oblique/.test(tail);
  const w = tail.replace(/italic|oblique/g, "");
  const table: Array<[RegExp, number]> = [[/^(thin|hairline)$/, 100], [/^(extra|ultra)light$/, 200], [/^light$/, 300], [/^(regular|roman|book|normal|)$/, 400],
    [/^medium$/, 500], [/^(semi|demi)bold$/, 600], [/^bold$/, 700], [/^(extra|ultra)bold$/, 800], [/^(black|heavy)$/, 900]];
  const hit = i < 0 ? undefined : table.find(([re]) => re.test(w));
  return { weight: hit ? hit[1] : null, italic };
}
/** The family Chromium drew each element's text with (CDP CSS.getPlatformFontsForNode: the face with the most glyphs), by
 *  path; an element CDP cannot find (inside a shadow root) is left out — its computed stack's first family is used. */
async function renderedFamilies(context: BrowserContext, page: Page, paths: readonly string[]): Promise<Map<string, Rendered>> {
  const out = new Map<string, Rendered>();
  if (!paths.length) return out;
  const s = await context.newCDPSession(page);
  try {
    await s.send("DOM.enable");
    await s.send("CSS.enable");
    const doc = await s.send("DOM.getDocument", { depth: 0 });
    for (const p of paths) {
      try {
        const q = await s.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: p });
        if (!q.nodeId) continue;
        const f = await s.send("CSS.getPlatformFontsForNode", { nodeId: q.nodeId });
        const best = [...f.fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
        if (best && best.familyName) out.set(p, { family: best.familyName, face: best.postScriptName });
      } catch { /* not a CSS selector CDP resolves (a shadow root path): the computed stack is used */ }
    }
  } finally {
    await s.detach().catch(() => undefined);
  }
  return out;
}

// ---------------------------------------------------------------- images
export interface Kept { bytes: Buffer; ext: "png" | "jpg" | "gif"; sha: string; w: number; h: number }
const EXT = { PNG: "png", JPEG: "jpg", GIF: "gif" } as const;
/** The bytes of a data: URL, or null. */
function dataUrlBytes(u: string): Buffer | null {
  const m = /^data:([^,]*),(.*)$/s.exec(u);
  if (!m) return null;
  const meta = m[1] || "", body = m[2] || "";
  try { return /;base64$/i.test(meta) ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8"); } catch { return null; }
}

/** One width's images: what the page loaded (by URL), what was kept (by sha-256), counted into the batch's budget. */
class Images {
  readonly kept = new Map<string, Kept>();
  private readonly page: Page;
  private readonly loaded: Map<string, Promise<Buffer | null>>;
  private readonly outRel: string;
  private readonly timeout: number;
  private readonly budget: ImageBudget;
  /** epoch ms: every wait while the images are collected (a body that never ends, a page stuck in a script) stops here */
  private readonly deadline: number;
  constructor(page: Page, loaded: Map<string, Promise<Buffer | null>>, outRel: string, timeout: number, budget: ImageBudget, deadline: number) {
    this.page = page; this.loaded = loaded; this.outRel = outRel; this.timeout = timeout; this.budget = budget; this.deadline = deadline;
  }
  /** What is left of the deadline, for Playwright's own timeouts (never 0: to Playwright that is none). */
  private left(): number { return Math.max(1, this.deadline - Date.now()); }
  /** Bytes Figma takes, kept; null when they are not (a format it does not take, too big, too many pixels). */
  private keep(b: Buffer): Kept | null {
    if (b.length > MAX_IMAGE_BYTES) return null;
    const s = sniffImage(b);
    if ("error" in s || s.w < 1 || s.h < 1 || s.w > MAX_IMAGE_SIDE || s.h > MAX_IMAGE_SIDE) return null;
    const sha = sha256Hex(b);
    const had = this.kept.get(sha);
    if (had) return had;
    const over = this.budget.add(sha, b.length);
    if (over !== null) throw new CaptureError(over, 5);
    const k: Kept = { bytes: b, ext: EXT[s.format], sha, w: s.w, h: s.h };
    this.kept.set(sha, k);
    return k;
  }
  fileOf(k: Kept): string { return this.outRel + "/images/" + k.sha + "." + k.ext; }
  /** The image at `url` as the page loaded it, when Figma takes it. */
  async source(url: string): Promise<Kept | null> {
    if (!url) return null;
    let b: Buffer | null = null;
    if (/^data:/i.test(url)) b = dataUrlBytes(url);
    else if (/^https?:/i.test(url)) {
      // the body the page received: a response whose headers came but whose body never ends is bounded too
      b = await within(this.loaded.get(url) ?? Promise.resolve(null), this.deadline, `reading the image ${url.slice(0, 120)}`);
      if (!b) {
        try {
          const r = await this.page.request.get(url, { timeout: this.left() });
          b = r.ok() ? await r.body() : null;
        } catch {
          const late = pastDeadline(this.deadline, `reading the image ${url.slice(0, 120)}`);
          if (late) throw late;
          b = null;
        }
      }
    }
    return b ? this.keep(b) : null;
  }
  /** A PNG of the element alone (its children hidden when `hide`), or null when it cannot be taken or is too big. */
  async screenshot(p: string, hide: boolean): Promise<Kept | null> {
    try {
      return await keptShot(async () => {
        if (hide) await within(this.page.evaluate(hideChildren, { path: p, hide: true }), this.deadline, "hiding an element's content for its screenshot");
        return await byPath(this.page, p).screenshot({ timeout: Math.min(this.timeout, this.left()), animations: "disabled", scale: "css" });
      }, (b) => this.keep(b), this.deadline);
    } finally {
      // a restore that fails in time leaves only this element's styles changed (the page is read, not kept); one that
      // runs out of --timeout is the read's timeout
      if (hide) {
        await within(this.page.evaluate(hideChildren, { path: p, hide: false }), this.deadline, "restoring an element after its screenshot").catch((e: unknown) => {
          if (e instanceof CaptureError) throw e;
          const late = pastDeadline(this.deadline, "restoring an element after its screenshot");
          if (late) throw late;
        });
      }
    }
  }
}

/** object-fit as an image paint's scale mode, with the note when it is not exact. */
function fitOf(fit: string, img: Kept, box: { w: number; h: number }): { scaleMode: CapImage["scaleMode"]; note?: string } {
  if (fit === "cover") return { scaleMode: "fill" };
  if (fit === "contain") return { scaleMode: "fit" };
  if (fit === "none" || fit === "scale-down") return { scaleMode: "fit", note: `object-fit ${fit} → fit` };
  // `fill` (the default) stretches; Figma has no stretch: exact when the box has the image's proportions
  const same = box.w > 0 && box.h > 0 && Math.abs(img.w / img.h - box.w / box.h) < 0.01 * (img.w / img.h);
  return same ? { scaleMode: "fill" } : { scaleMode: "fill", note: "a stretched image (object-fit fill) → fill (cropped)" };
}
function bgFitOf(size: string, repeat: string, img: Kept, box: { w: number; h: number }): { scaleMode: CapImage["scaleMode"]; scale?: number; note?: string } {
  const s = size.split(",")[0]?.trim() || "auto";
  const r = repeat.split(",")[0]?.trim() || "repeat";
  if (s === "cover") return { scaleMode: "fill" };
  if (s === "contain") return { scaleMode: "fit" };
  if (!/no-repeat/.test(r) && (s === "auto" || s === "auto auto")) return { scaleMode: "tile", scale: 1 };
  const exact = Math.abs(img.w - box.w) < 1 && Math.abs(img.h - box.h) < 1;
  return exact ? { scaleMode: "fill" } : { scaleMode: "fill", note: `background-size ${s} / ${r} → fill` };
}

// ---------------------------------------------------------------- one width
/** What one width's instances say: how many by component, and what their props could not say (the first few). */
export interface InstanceReport { count: number; byComponent: Record<string, number>; warnings: string[]; moreWarnings: number }
export interface WidthResult {
  doc: CaptureDoc; spec: TreeNodeSpec; stats: CaptureStats; images: Kept[]; skipped: Record<string, number>; notes: string[]; outRel: string;
  instances: InstanceReport; namedUnmapped: Record<string, number>; candidates: Candidate[];
}
export interface CaptureOptions {
  url: string; name: string; root: string | null; height: number; ready: string | null; timeout: number; outRel: string; budget: ImageBudget;
  /** the component map by code component (null: no instances) */
  map: CodeIndex | null;
}
/** How many instance warnings a report keeps per width (the rest are counted). */
const MAX_INSTANCE_WARNINGS = 10;

export async function captureWidth(browser: Browser, width: number, o: CaptureOptions): Promise<WidthResult> {
  const context = await browser.newContext(contextOptions({ w: width, h: o.height }));
  try {
    await context.addInitScript({ content: INIT_SCRIPT });
    const page = await context.newPage();
    page.setDefaultTimeout(o.timeout);
    const loaded = new Map<string, Promise<Buffer | null>>();
    page.on("response", (r) => {
      if (r.request().resourceType() === "image" && r.ok()) loaded.set(r.url(), r.body().catch(() => null));
    });
    await settle(page, o.url, o.ready, o.timeout);
    // reading it — the walk, the measurement, the fonts drawn, the images — gets one --timeout of its own
    const deadline = Date.now() + o.timeout;
    const walked: WalkOutput = await within(page.evaluate(walkCapture, { root: o.root, maxElements: MAX_WALK, identity: o.map !== null, components: o.map ? o.map.names : [] }), deadline, `reading the page's elements (${o.timeout} ms)`);
    if (!walked.root) throw new CaptureError(walked.missing ?? "nothing to capture", 4);
    if (walked.elements > MAX_WALK) throw new CaptureError(`the page at ${width} px shows more than ${MAX_WALK} elements (${walked.elements}); one spec holds ${MAX_TREE_NODES} nodes — capture part of it with --root <selector>`, 5);

    // every element, and the page's background (body, else html)
    const els: WalkEl[] = [];
    const collect = (e: WalkEl): void => { els.push(e); for (const c of e.children) if (c.kind === "el") collect(c); };
    collect(walked.root);
    const items: MeasureItem[] = els.map((e) => ({ nodeId: e.path, path: e.path, isText: e.text !== null, isPaint: false, isPlaceholder: e.control !== null && e.control.placeholder, sharesWith: null, assetSpec: e.media === "img" }));
    for (const p of [walked.htmlPath, walked.bodyPath]) if (p) items.push({ nodeId: "page:" + p, path: p, isText: false, isPaint: false, isPlaceholder: false, sharesWith: null });
    const rootRect = walked.root.rect;
    const measured: MeasureResult[] = await within(page.evaluate(measureElements, { frameRect: rootRect, framePath: walked.root.path, keys: STYLE_KEYS, items, capture: true }), deadline, `measuring the page's elements (${o.timeout} ms)`);
    const byPathM = new Map<string, MeasureResult>(measured.map((m) => [m.nodeId, m]));
    const notes: string[] = [];
    const gone = measured.filter((m) => !m.found).length;
    if (gone) notes.push(`${gone} element(s) were gone by the time they were measured (the page changed while it was read)`);

    // the family Chromium drew each text with: a text element's own, a run's parent's
    const textPaths = new Set<string>();
    for (const e of els) if (e.text || e.control || e.children.some((c) => c.kind === "run")) textPaths.add(e.path);
    const families = await within(renderedFamilies(context, page, [...textPaths]), deadline, `reading the fonts the page drew (${o.timeout} ms)`);

    const images = new Images(page, loaded, o.outRel, o.timeout, o.budget, deadline);
    const styleOf = (e: WalkEl): Record<string, PValue> => byPathM.get(e.path)?.styles ?? {};
    const fontOf = (e: WalkEl, placeholder = false): CapFont => {
      const s = styleOf(e);
      const stack = str(s.fontFamily);
      const drawn = families.get(e.path);
      // the face drawn names the style when it is at least as bold as asked (a heavier face is what shows; a lighter one is
      // a variable font's default instance, or a bold the browser made up — the asked weight then)
      const asked = num(s.fontWeight, 400);
      const face = drawn ? faceStyle(drawn.face) : { weight: null, italic: false };
      return {
        family: drawn ? drawn.family : firstFamily(stack),
        size: num(s.fontSize, 16), weight: face.weight !== null && face.weight >= Math.round(asked / 100) * 100 ? face.weight : asked,
        italic: face.italic || /italic|oblique/.test(str(s.fontStyle) || e.fontStyle),
        lineHeight: typeof s.lineHeight === "number" ? s.lineHeight : null, letterSpacing: num(s.letterSpacing),
        color: (placeholder ? str(s.placeholderColor) : "") || str(s.color) || "rgb(0, 0, 0)",
        textAlign: e.textAlign, direction: e.direction, textTransform: str(s.textTransform), textDecoration: str(s.textDecoration) || e.textDecoration,
      };
    };
    const borderOf = (s: Record<string, PValue>): CapBorder | null => {
      const from = str(s.strokeFrom);
      const widths = sides(s.borderWidths);
      const color = paint(s.borderColor);
      if (!color || !widths.some((w) => w > 0) || (from !== "border" && from !== "box-shadow" && from !== "outline")) return null;
      const align = str(s.strokeAlign);
      return { widths, color, from, align: align === "outside" || align === "center" ? align : "inside" };
    };
    const runText = (r: WalkRun, parent: WalkEl): CapText => ({ kind: "text", text: r.text, rect: r.rect, lines: r.lines, font: fontOf(parent) });
    // the instances: the component map read in the write direction (code-usage.ts figmaUsageOf)
    const instances: InstanceReport = { count: 0, byComponent: {}, warnings: [], moreWarnings: 0 };
    const namedUnmapped: Record<string, number> = {};
    const noteInstance = (msg: string): void => { if (instances.warnings.length < MAX_INSTANCE_WARNINGS) instances.warnings.push(msg); else instances.moreWarnings++; };

    const convert = async (e: WalkEl, isRoot: boolean): Promise<CapEl> => {
      const s = styleOf(e);
      const radius = s.borderRadius;
      const border = borderOf(s);
      const dropped = e.dropped.filter((d) => !(d === "shadow" && border !== null && border.from === "box-shadow"));
      const el: CapEl = {
        kind: "el", path: e.path, tag: e.tag, name: e.name, rect: e.rect,
        display: e.display, position: e.position, zIndex: e.zIndex,
        flexDirection: e.flexDirection, flexWrap: e.flexWrap, justifyContent: e.justifyContent, alignItems: e.alignItems, alignSelf: e.alignSelf, flexGrow: e.flexGrow, order: e.order,
        gridColumns: e.gridColumns, gridRows: e.gridRows, gridPlaced: e.gridPlaced, rowGap: e.rowGap, columnGap: e.columnGap,
        padding: sides(s.padding),
        background: isRoot && o.root === null ? null : paint(s.backgroundColor),
        border, radius: typeof radius === "number" ? (radius > 0 ? radius : null) : Array.isArray(radius) ? sides(radius) : null,
        opacity: num(s.opacity, 1), clip: e.clip,
        media: e.media, image: null, backgroundImage: null, text: null, dropped, children: [],
      };
      if (e.component && o.map) {
        const hit = o.map.get(e.component.name);
        if (hit && "entry" in hit) {
          const u = figmaUsageOf(hit.entry, e.component.props, e.component.text, e.component.name);
          el.instance = { component: u.component, props: u.props, name: hit.entry.figma.name };
          instances.count++;
          instances.byComponent[hit.entry.figma.name] = (instances.byComponent[hit.entry.figma.name] ?? 0) + 1;
          for (const w of u.warnings) noteInstance(`${e.path}: ${w.message}`);
          return el;
        }
      }
      if (e.codeName !== undefined && o.map) {
        const hit = o.map.get(e.codeName);
        if (hit && "ambiguous" in hit) noteInstance(`${e.path}: ${e.codeName} is the code target of ${hit.ambiguous.length} map entries (${hit.ambiguous.slice(0, 3).map((x) => x.figma.name).join(", ")}): captured as plain layers, not an instance; give each its own export in the map`);
        else namedUnmapped[e.codeName] = (namedUnmapped[e.codeName] ?? 0) + 1;
      }
      if (e.text) {
        // the walk's drawn characters when part of the content is not drawn (the measured text counts it), else the measured text
        el.text = { kind: "text", text: e.text.drawn ?? (str(s.text) || ""), rect: e.text.rect, lines: e.text.lines, font: fontOf(e), ...(e.text.mixed ? { mixed: true } : {}) };
        if (!el.text.text) el.text = null;
      }
      if (e.control && e.control.text) el.text = { kind: "text", text: e.control.text.replace(/\s+/g, " ").trim(), rect: e.rect, lines: 1, font: fontOf(e, e.control.placeholder), control: true };
      // what the element draws itself: an <img> as the page loaded it (else a screenshot), anything else a screenshot
      if (e.media) {
        let k: Kept | null = null, from: CapImage["from"] = "source";
        if (e.media === "img") {
          const a = s.assetIdentity;
          const src = a && typeof a === "object" && !Array.isArray(a) && typeof a.src === "string" ? a.src : e.src ?? "";
          k = await images.source(src);
        }
        if (!k) { k = await images.screenshot(e.path, false); from = "screenshot"; }
        if (k) el.image = { file: images.fileOf(k), sha256: k.sha, w: k.w, h: k.h, from, ...(from === "source" ? fitOf(e.objectFit, k, e.rect) : { scaleMode: "fill" as const }) };
      }
      const bgUrl = e.backgroundImages[0];
      if (bgUrl && !e.media) {
        const k = await images.source(bgUrl);
        if (k) el.backgroundImage = { file: images.fileOf(k), sha256: k.sha, w: k.w, h: k.h, from: "source", ...bgFitOf(e.backgroundSize, e.backgroundRepeat, k, e.rect) };
        else {
          const shot = await images.screenshot(e.path, e.children.length > 0 || e.text !== null);
          if (shot) el.backgroundImage = { file: images.fileOf(shot), sha256: shot.sha, w: shot.w, h: shot.h, from: "screenshot", scaleMode: "fill" };
          else el.dropped.push("image");
        }
      }
      for (const c of e.children) el.children.push(c.kind === "el" ? await convert(c, false) : runText(c, e));
      return el;
    };
    const root = await convert(walked.root, true);
    // a read that ran past --timeout is refused, whatever it collected on the way
    const late = pastDeadline(deadline, `reading the page at ${width} px (${o.timeout} ms)`);
    if (late) throw late;
    const htmlBg = paint(byPathM.get("page:" + walked.htmlPath)?.styles.backgroundColor);
    const bodyBg = walked.bodyPath ? paint(byPathM.get("page:" + walked.bodyPath)?.styles.backgroundColor) : null;
    const doc: CaptureDoc = { name: o.name, width, url: o.url, document: o.root === null, background: bodyBg ?? htmlBg, root };
    const r = captureSpec(doc);
    if (!r.ok) throw new CaptureError(`${r.error} — capture part of the page with --root <selector> (a section, the main column)`, 5);
    const ids = new Map<string, string>([...images.kept.values()].map((k) => [images.fileOf(k), k.sha]));
    const problems = checkCaptured(r.spec, (f) => ids.get(f) ?? null);
    if (problems.length) throw new Error(`the spec for ${width} px fails the tree spec's own check — a bug in the capture, nothing written:\n${problems.slice(0, 10).join("\n")}`);
    for (const c of r.candidates) {
      const bad = checkCaptured(c.spec, (f) => ids.get(f) ?? null);
      if (bad.length) throw new Error(`the candidate component ${c.name} for ${width} px fails the tree spec's own check — a bug in the capture, nothing written:\n${bad.slice(0, 10).join("\n")}`);
    }
    return { doc, spec: r.spec, stats: r.stats, images: [...images.kept.values()], skipped: walked.skipped, notes, outRel: o.outRel, instances, namedUnmapped, candidates: r.candidates };
  } finally {
    // bounded too: a page stuck in a script must not keep the capture from returning
    await within(context.close(), Date.now() + CLOSE_MS, "closing the page").catch(() => undefined);
  }
}

// ---------------------------------------------------------------- the CLI
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  if (!argv.length) { console.error(USAGE); return 2; }
  const OPTIONS = {
    url: { type: "string" }, width: { type: "string" }, height: { type: "string" }, root: { type: "string" }, name: { type: "string" },
    out: { type: "string" }, project: { type: "string" }, ready: { type: "string" }, timeout: { type: "string" }, "browser-path": { type: "string" },
    map: { type: "string" }, "no-instances": { type: "boolean" }, "no-bind": { type: "boolean" },
    check: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } as const;
  const { values: f } = cliParse(TOOL, argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: false }));
  const usage = (msg: string): number => { console.error(`${TOOL}: ${msg}\n${USAGE}`); return 2; };
  const project = path.resolve(f.project ?? ".");
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) return usage(`--project ${project} is not a directory`);
  const timeout = f.timeout === undefined ? 30_000 : Number(f.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return usage("--timeout must be a positive number of milliseconds");
  if (f.check) {
    for (const k of ["url", "width", "height", "root", "name", "out", "ready", "map", "no-instances", "no-bind"] as const) if (f[k] !== undefined) return usage(`--${k} does not apply to --check`);
  } else if (!f.url) return usage("--url is required");
  const widths = (f.width ?? "1280").split(",").map((w) => w.trim());
  if (!widths.every((w) => /^\d+$/.test(w) && Number(w) >= 100 && Number(w) <= 4096)) return usage(`--width must be one width or a comma list, each a whole number of px from 100 to 4096 (got '${f.width ?? ""}')`);
  const widthList = [...new Set(widths.map(Number))];
  const height = f.height === undefined ? 800 : Number(f.height);
  if (!Number.isInteger(height) || height < 100 || height > 4096) return usage("--height must be a whole number of px from 100 to 4096");
  if (f.ready !== undefined && f.ready.trim() === "") return usage("--ready must be a selector or none");
  if (f.root !== undefined && f.root.trim() === "") return usage("--root must be a CSS selector");
  const name = f.name ?? nameFromUrl(f.url ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(name)) return usage(`--name must be letters, digits, . _ - (at most 80, starting with a letter or digit), got '${name}'`);
  const outAbs = path.resolve(project, f.out ?? path.join("design", "capture"));
  const outRel = path.relative(project, outAbs).split(path.sep).join("/");
  if (outRel === "" || outRel.startsWith("..") || path.isAbsolute(outRel)) return usage(`--out must be a directory inside --project (${project}), where the MCP server reads it from`);
  // inside on disk too, checked before anything is captured (the image files once they are known, before any is written)
  const fileOf = (rel: string): string => path.join(project, ...rel.split("/"));
  const specRel = (w: number): string => `${outRel}/${name}@${w}.json`;
  const reportRel = `${outRel}/${name}.capture.json`;
  const outDirs = [outAbs, path.join(outAbs, "images")];
  const escaped = f.check ? null : outputEscape(project, outDirs, [...widthList.map((w) => fileOf(specRel(w))), fileOf(reportRel)]);
  if (escaped !== null) return usage(`--out must stay inside --project on disk: ${escaped} — nothing written`);
  let url = f.url ?? "";
  if (!f.check && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    // a path on disk: as a file: URL
    const file = path.resolve(url);
    if (!fs.existsSync(file)) return usage(`--url ${url} is not a URL, and no file is there`);
    url = "file://" + file.split(path.sep).join("/").replace(/^([A-Za-z]):/, "/$1:");
  }

  if (f.map !== undefined && f["no-instances"]) return usage("--map and --no-instances: give one (--no-instances reads no component)");
  // The component map, read in the write direction: --map, else the project's own (design/, then the legacy root file).
  let map: CodeIndex | null = null;
  let mapRel: string | null = null;
  if (!f.check && !f["no-instances"]) {
    const found = findMapFile(project);
    const file = f.map !== undefined ? path.resolve(project, f.map) : found.missing ? null : found.file;
    if (file !== null) {
      if (!fs.existsSync(file)) return usage(`--map ${f.map ?? file} is not a file`);
      const m = readJson(file, isCodeConnectMap);
      if (!("doc" in m)) return usage(`cannot read the component map ${file}: ${m.error}`);
      map = mapEntriesByCode(m.doc);
      mapRel = path.relative(project, file).split(path.sep).join("/");
    }
  }

  const browserPath = f["browser-path"];
  if (browserPath !== undefined) { const bad = browserPathError(browserPath); if (bad !== null) return rendererUnavailable(bad, null, TOOL, "captured or written"); }
  const res = resolvePlaywright(project);
  if (!res.ok) return rendererUnavailable(res.reason, res.hint, TOOL, "captured or written");
  const launched = await launch(res, project, browserPath);
  if ("error" in launched) return rendererUnavailable(launched.error, launched.hint, TOOL, "captured or written");
  const browser = launched.browser;
  const results: WidthResult[] = [];
  const budget = new ImageBudget();
  try {
    if (f.check) {
      console.log(`ok  ${res.pkg} ${res.version} (from ${path.relative(project, res.file) || res.file}) · chromium ${browser.version()}${browserPath !== undefined ? ` (--browser-path ${browserPath})` : ""} — ready to capture`);
      return 0;
    }
    const ready = f.ready === undefined || f.ready === "none" ? null : f.ready;
    for (const w of widthList) results.push(await captureWidth(browser, w, { url, name, root: f.root ?? null, height, ready, timeout, outRel, budget, map }));
  } catch (e) {
    if (e instanceof CaptureError) { console.error(`${TOOL}: ${e.message} — nothing written.`); return e.exit; }
    if (pwErrorKind(e) === "gone") { console.error(`${TOOL}: the page or browser closed or crashed (${firstLine(e)}) — nothing written. Run again; if it recurs, run --check.`); return 4; }
    if (pwErrorKind(e) === "timeout") { console.error(`${TOOL}: timed out — ${firstLine(e)} — nothing written.`); return 4; }
    throw e;
  } finally {
    await within(browser.close(), Date.now() + CLOSE_MS, "closing the browser").catch(() => undefined);
  }

  // every width converted: write the images, the specs, the report — once the files are checked again, all of them
  const images = new Map<string, Kept>();
  for (const r of results) for (const k of r.images) images.set(r.outRel + "/images/" + k.sha + "." + k.ext, k);
  // bind: the file's variables and text styles that equal a raw value are bound when the spec lands (bind-values.ts)
  const ops = results.map((r) => ({ op: "createTree", treeFile: specRel(r.doc.width), ...(f["no-bind"] ? {} : { bind: true }) }));
  const candidateRel = (w: number, c: Candidate): string => `${outRel}/${name}@${w}.candidates/${c.slug}.tree.json`;
  const candidateDirs = results.map((r) => path.join(outAbs, `${name}@${r.doc.width}.candidates`));
  const candidateFiles = results.flatMap((r) => r.candidates.map((c) => candidateRel(r.doc.width, c)));
  const late = outputEscape(project, [...outDirs, ...candidateDirs], [...[...images.keys(), ...ops.map((o) => o.treeFile), ...candidateFiles, reportRel].map(fileOf)]);
  if (late !== null) return usage(`--out must stay inside --project on disk: ${late} — nothing written`);
  fs.mkdirSync(path.join(outAbs, "images"), { recursive: true });
  for (const [rel, k] of images) if (!fs.existsSync(fileOf(rel))) writeFileAtomic(fileOf(rel), k.bytes);
  const imageFiles = new Set(images.keys());
  results.forEach((r, i) => writeFileAtomic(fileOf(ops[i]?.treeFile ?? ""), JSON.stringify(r.spec, null, 1) + "\n"));
  // each width's candidate components, in a directory of their own: one an earlier capture wrote is not left beside them
  results.forEach((r, i) => {
    const dirAbs = candidateDirs[i] ?? "";
    for (const old of fs.existsSync(dirAbs) ? fs.readdirSync(dirAbs) : []) if (old.endsWith(".tree.json")) fs.rmSync(path.join(dirAbs, old), { force: true });
    if (!r.candidates.length) return;
    fs.mkdirSync(dirAbs, { recursive: true });
    for (const c of r.candidates) writeFileAtomic(fileOf(candidateRel(r.doc.width, c)), JSON.stringify(c.spec, null, 1) + "\n");
  });
  const fonts: Array<{ family: string; style: string }> = [];
  for (const r of results) for (const ft of r.stats.fonts) if (!fonts.some((x) => x.family === ft.family && x.style === ft.style)) fonts.push(ft);
  const report = {
    url: f.url, name,
    fonts,
    fontsNote: "every family and style the specs use; a font the Figma file lacks is refused when the spec lands (with the closest names it has), never swapped",
    map: mapRel,
    widths: results.map((r, i) => ({
      width: r.doc.width, height: r.doc.root.rect.h, spec: ops[i]?.treeFile,
      nodes: r.stats.nodes, frames: r.stats.frames, texts: r.stats.texts, images: r.stats.images, depth: r.stats.depth,
      fonts: r.stats.fonts, dropped: r.stats.dropped, approximated: r.stats.approximated, skipped: r.skipped, notes: r.notes,
      instances: { count: r.instances.count, byComponent: r.instances.byComponent, warnings: r.instances.warnings, ...(r.instances.moreWarnings ? { moreWarnings: r.instances.moreWarnings } : {}) },
      namedUnmapped: r.namedUnmapped,
      candidates: r.candidates.map((c) => ({ name: c.name, count: c.count, nodes: c.nodes, paths: c.paths, specFile: candidateRel(r.doc.width, c) })),
    })),
    candidatesNote: "a candidate is a part repeated with no component: send its specFile as figma_write {op:\"createTree\", treeFile} to make it a component. That does not replace its occurrences in the screen: map the new component to its code component (design/codeconnect.local.json), then capture again",
    images: [...imageFiles],
    notWritten: "shadows, gradients, pseudo-element content (::before/::after), transforms and filters: the tree spec has no effects",
    ops,
  };
  writeFileAtomic(fileOf(reportRel), JSON.stringify(report, null, 2) + "\n");
  const per = results.map((r) => `${r.doc.width}: ${r.stats.nodes} nodes (${r.stats.frames} frames, ${r.stats.texts} texts, ${r.stats.instances} instances, ${r.stats.images} images, ${r.candidates.length} candidate components)`).join(" · ");
  console.log(`${TOOL}: ${name} — ${per}; ${fonts.length} font${fonts.length === 1 ? "" : "s"} → ${reportRel}`);
  console.log(JSON.stringify({ ops }));
  return 0;
}

if (import.meta.main) runCli(main, { name: TOOL, errorLine: (e) => `${TOOL}: ${errMsg(e)}` });
