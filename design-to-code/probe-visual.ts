// probe-visual.ts — the visual diff's probe side: capture the built frame at the reference's
// scale, then — after the browser is closed — diff it against the Figma reference in Node (visual-diff.ts) and draw the diff
// image. Informational only: never the fidelity verdict, never an exit 4, never a reason to lose measured.json — every
// failure is measured.visual = {ran:false, why}.
//
// Order in verify-probe: measurement → the interaction drive → THIS capture → the behaviour checks → closeCapped →
// finishVisual. After the drive so it can never cut verdict-affecting rows; before behaviour so a big screen does not
// starve it (it is one load, capped at VISUAL_CAP_MS; behaviour's budget is computed afterwards from what is left). It never
// touches the measurement page, and it acts on nothing: no click, no key, the mouse never moves (no hover state).
//
// The capture (captureVisual): a fresh context at deviceScaleFactor = the reference's scale (PNG px per design px — the index's
// referenceScale, else recomputed from the export's renderBox at --expect). Chromium accepts a factor below 1 too
// (0.1–0.5 render exactly), so the build is always rendered on the reference's own pixel grid. The screen is
// reached like the measurement pass (--steps / plan.navigate replayed, --ready). The clip is the DESIGN-size window at the built
// frame's top-left, in whole CSS px (a taller or shorter built frame is compared only within the design window, with a
// note — its size is already a numeric delta); fullPage:true so a clip below the viewport is not trimmed to it.
//
// The reference (prepareVisual): expectation.referenceImage (--expect wrote it, bound by the expectation's sha256). The probe
// re-hashes the PNG and refuses one that changed since --expect. It never reads the export index itself. Its path
// (design/export/…) is resolved from the project that OWNS the expectation (referenceRoot): the directory above
// design/verify/ when --expected sits in one — a monorepo whose design/ is at the repo root while the probe runs from the web
// app's package (--project apps/web) — else --project. It must stay inside <that root>/design/export. --project is
// still the Playwright / project root for everything else.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, Page } from "playwright";
import { StepError, holdContext, openReached, raceBudget, raf2 } from "./probe-drive.ts";
import type { Held } from "./probe-drive.ts";
import { BEHAVIOUR_RESERVE_MS } from "./probe-behaviour.ts";
import { PngError, decodePng, encodePng } from "./png.ts";
import type { Rgba } from "./png.ts";
import { attribute, crop, diffOptionsFor, diffPixels, planGrid, referenceCrop, renderDiff, resampleBox } from "./visual-diff.ts";
import type { MeasuredVisual, ProbeFrame, Rect4, VerifyExpectation, VerifyReferenceImage } from "./types.ts";
import { isVerifyReferenceImage } from "./doc-guards.ts";
import { pctText, resolveInside } from "./verify-shared.ts";
import { errMsg, firstLine } from "../bridge/src/errmsg.ts";
import { EXPORT_DIR, VERIFY_DIR } from "../bridge/src/project-layout.ts";

// ---------------------------------------------------------------- budget
/** The capture's own cap; what --max-time leaves is shared with behaviour, whose reserve (settle, capped close, write) it keeps. */
export const VISUAL_CAP_MS = 30_000;
/** min(30 s, what is left of --max-time less the behaviour reserve) — never < 0. */
export function visualBudget(now: number, deadline: number, cap = VISUAL_CAP_MS, reserve = BEHAVIOUR_RESERVE_MS): number {
  return Math.max(0, Math.min(cap, deadline - now - reserve));
}
const FONTS_CAP_MS = 5_000;
/** built rects measured for attribution, at most */
const BUILT_CAP = 2_000;

// ---------------------------------------------------------------- the reference (before the browser work)
export type VisualPrep =
  | { ok: true; ref: VerifyReferenceImage; bytes: Buffer; frameSize: { w: number; h: number }; notes: string[] }
  | { ok: false; why: string };
/** The project root whose design/export the expectation's reference path is relative to: the directory above
 *  design/verify/ when the expectation file sits in one, else `project` (--project / cwd). */
export function referenceRoot(expected: string, project: string): string {
  const dir = path.resolve(path.dirname(expected));
  return dir.endsWith(path.sep + VERIFY_DIR) ? path.dirname(path.dirname(dir)) : project;
}
export const REFERENCE_MALFORMED = "the expectation's referenceImage is malformed — re-run --expect";
/** Is there a usable, unchanged reference for the expectation's first frame? Reads the PNG under `root` (referenceRoot; no
 *  write). Never throws: a malformed referenceImage (null, a string, a field missing) is {ok:false}. */
export function prepareVisual(exp: Partial<Pick<VerifyExpectation, "referenceImage" | "reference" | "frame" | "frames">>, root: string): VisualPrep {
  const ri: unknown = exp.referenceImage;
  if (ri === undefined) {
    return { ok: false, why: typeof exp.reference === "string" && exp.reference ? "the expectation predates the visual diff (no referenceImage) — re-run --expect" : "the export has no reference image for this screen" };
  }
  if (!isVerifyReferenceImage(ri)) return { ok: false, why: REFERENCE_MALFORMED };
  if (!ri.usable) return { ok: false, why: ri.why };
  const fw = exp.frame?.w, fh = exp.frame?.h;
  if (typeof fw !== "number" || typeof fh !== "number" || fw < 1 || fh < 1) return { ok: false, why: "the expectation states no frame size" };
  const file = resolveInside(root, ri.path, path.join(root, EXPORT_DIR));
  if (file === null) return { ok: false, why: `the reference path ${ri.path} is outside design/export — re-run --expect` };
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); } catch { return { ok: false, why: `the reference PNG ${ri.path} is missing — re-pull the screen, then re-run --expect` }; }
  if (sha256Hex(bytes) !== ri.sha256) return { ok: false, why: `the reference PNG changed since --expect (${ri.path}) — re-run --expect` };
  const notes: string[] = [];
  if (exp.frames && exp.frames.length > 1) notes.push(`the expectation has ${exp.frames.length} frames — only the first (${exp.frame?.nodeId ?? "?"}) is diffed`);
  if (ri.colorProfile !== undefined) notes.push(`the reference's colour profile is ${ri.colorProfile} — colours are compared as raw samples, without colour management (a colour difference may be the profile's)`);
  return { ok: true, ref: ri, bytes, frameSize: { w: fw, h: fh }, notes };
}

// ---------------------------------------------------------------- the capture (page side)
interface VRect { left: number; top: number; width: number; height: number }
interface VElement { getBoundingClientRect(): VRect }
interface VDocument {
  querySelectorAll(sel: string): { length: number; item(i: number): VElement | null };
  documentElement: { scrollWidth: number; scrollHeight: number };
  body: { scrollWidth: number; scrollHeight: number } | null;
  fonts: { ready: Promise<unknown> };
}
declare const document: VDocument;
declare const scrollX: number;
declare const scrollY: number;
declare const window: { __dtProbeDoc?: string };

interface FrameRead { count: number; rect: Rect4 | null; doc: { w: number; h: number }; token: string }
/** The frame's document rect (when its selector matches exactly one element), the document's scroll size, the doc token. */
function readFrame(arg: { selector: string | null }): FrameRead {
  let count = 0, rect: Rect4 | null = null;
  if (arg.selector !== null) {
    try {
      const list = document.querySelectorAll(arg.selector);
      count = list.length;
      const el = list.item(0);
      if (count === 1 && el) { const r = el.getBoundingClientRect(); rect = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }
    } catch { count = 0; }
  }
  const de = document.documentElement, b = document.body;
  return { count, rect, doc: { w: Math.max(de.scrollWidth, b ? b.scrollWidth : 0), h: Math.max(de.scrollHeight, b ? b.scrollHeight : 0) }, token: String(window.__dtProbeDoc || "") };
}
/** Frame-relative CSS rects of the measured nodes whose selector still matches exactly one element. */
function readBuilt(arg: { nodes: Array<{ id: string; selector: string }>; frame: { x: number; y: number } }): Array<{ id: string; rect: Rect4 }> {
  const out: Array<{ id: string; rect: Rect4 }> = [];
  for (const n of arg.nodes) {
    try {
      const list = document.querySelectorAll(n.selector), el = list.item(0);
      if (list.length !== 1 || !el) continue;
      const r = el.getBoundingClientRect();
      out.push({ id: n.id, rect: { x: r.left + scrollX - arg.frame.x, y: r.top + scrollY - arg.frame.y, w: r.width, h: r.height } });
    } catch { /* an invalid selector: skipped */ }
  }
  return out;
}

export interface VisualCapture {
  png: Buffer;
  dsf: number;
  /** the design-size window, CSS px, document coordinates */
  clip: Rect4;
  /** the part of the clip inside the document (what was shot), CSS px */
  shot: Rect4;
  frame: { nodeId: string; via: string; selector: string | null };
  built: Array<{ id: string; rect: Rect4 }>;
  notes: string[];
}
export interface CaptureOptions {
  ref: VerifyReferenceImage;
  /** the measurement pass's first frame (null: none resolved) */
  frame: ProbeFrame | null;
  /** the design frame size (expectation.frame) */
  frameSize: { w: number; h: number };
  /** the measured nodes (selector + count from the measurement pass) */
  nodes: Array<{ nodeId: string; selector?: string; selectorCount?: number }>;
  viewport: { w: number; h: number };
  timeout: number;
  initScript: string;
  reach(page: Page): Promise<void>;
  budgetMs: number;
}

/** One capped capture on a fresh page at the reference's scale. Never throws: a failure, a load or the budget is {why}. */
export async function captureVisual(browser: Browser, o: CaptureOptions): Promise<VisualCapture | { why: string }> {
  if (o.budgetMs <= 0) return { why: "no time left within --max-time after measuring and driving" };
  const held: Held = {};
  const work = (async (): Promise<VisualCapture | { why: string }> => {
    let reached: Awaited<ReturnType<typeof openReached>>;
    try {
      reached = await openReached(browser, { viewport: o.viewport, timeout: o.timeout, initScript: o.initScript, reach: o.reach }, { dsf: o.ref.scale, onContext: holdContext(held) });
    } catch (e) {
      return { why: e instanceof StepError ? `the steps failed — ${e.message}` : `could not reach the screen — ${firstLine(e)}` };
    }
    const { context, page, loads } = reached;
    try {
      const loads0 = loads();
      await Promise.race([page.evaluate("document.fonts.ready.then(() => true)"), sleep(FONTS_CAP_MS, undefined, { ref: false })]);
      await raf2(page);
      const notes: string[] = [];
      const fr = o.frame;
      const sel = fr && fr.via !== "viewport" ? fr.selector : null;
      const read = await page.evaluate(readFrame, { selector: sel });
      let origin: { x: number; y: number };
      if (!fr) { origin = { x: 0, y: 0 }; notes.push("no frame root was measured — the capture starts at the page's origin"); }
      else if (fr.via === "viewport") origin = { x: 0, y: 0 };
      else if (read.rect !== null) origin = { x: read.rect.x, y: read.rect.y };
      else { origin = { x: fr.rect.x, y: fr.rect.y }; notes.push(`the frame's selector matched ${read.count} element(s) on the capture page — the measurement pass's position was used`); }
      const built0 = fr && fr.via !== "viewport" && read.rect !== null ? read.rect : fr ? fr.rect : null;
      if (built0 !== null && fr && fr.via !== "viewport" && (Math.abs(built0.h - o.frameSize.h) > 1 || Math.abs(built0.w - o.frameSize.w) > 1)) {
        notes.push(`the built frame is ${Math.round(built0.w)}×${Math.round(built0.h)} CSS px and the design ${o.frameSize.w}×${o.frameSize.h} — only the design-size window at the built frame's top-left is compared`);
      }
      const clip: Rect4 = { x: Math.round(origin.x), y: Math.round(origin.y), w: Math.floor(o.frameSize.w), h: Math.floor(o.frameSize.h) };
      // fullPage: the clip is trimmed to the DOCUMENT (not the viewport); what lies outside it is not compared
      const x0 = Math.max(0, clip.x), y0 = Math.max(0, clip.y);
      const shot: Rect4 = { x: x0, y: y0, w: Math.max(0, Math.min(clip.x + clip.w, read.doc.w) - x0), h: Math.max(0, Math.min(clip.y + clip.h, read.doc.h) - y0) };
      if (shot.w < 1 || shot.h < 1) return { why: `the frame's window (${clip.w}×${clip.h} at ${clip.x},${clip.y}) lies outside the ${read.doc.w}×${read.doc.h} document` };
      const nodes: Array<{ id: string; selector: string }> = [];
      for (const n of o.nodes) if (n.selectorCount === 1 && typeof n.selector === "string" && n.selector && nodes.length < BUILT_CAP) nodes.push({ id: n.nodeId, selector: n.selector });
      const built = await page.evaluate(readBuilt, { nodes, frame: origin });
      const png = await page.screenshot({ clip: { x: shot.x, y: shot.y, width: shot.w, height: shot.h }, fullPage: true, animations: "disabled", caret: "hide", scale: "device" });
      const after = await page.evaluate(readFrame, { selector: null });
      if (loads() !== loads0 || after.token !== read.token) return { why: "the page loaded a new document during the visual capture" };
      return { png, dsf: o.ref.scale, clip, shot, frame: fr ? { nodeId: fr.nodeId, via: fr.via, selector: fr.selector } : { nodeId: "", via: "none", selector: null }, built, notes };
    } finally {
      await context.close().catch(() => undefined);
    }
  })().catch((e: unknown): { why: string } => ({ why: /Execution context was destroyed|frame was detached|navigation/i.test(errMsg(e)) ? "the page loaded a new document during the visual capture" : `the visual capture failed — ${firstLine(e)}` }));
  // the context exists from before the screen was reached: closing it ends whatever the capture waits on — ≤ CUT_SETTLE_MS
  const r = await raceBudget(work, o.budgetMs, held);
  if (!r.cut) return r.value;
  return { why: `the visual capture did not finish within its budget (${Math.round(o.budgetMs / 1000)} s)` };
}

// ---------------------------------------------------------------- after the browser is closed: diff + diff image (Node)
const pct = (n: number, of: number): number => (of > 0 ? Math.round((n / of) * 10000) / 100 : 0);
/** The design rects of the expectation's specs in the first frame (frame-relative x/y/width/height, design px = CSS px); a
 *  spec with no y (a TEXT the export placed by auto layout) has none. */
export function designedRects(exp: Partial<Pick<VerifyExpectation, "nodes" | "frame">>): Array<{ id: string; rect: Rect4 }> {
  const first = exp.frame?.nodeId;
  const out: Array<{ id: string; rect: Rect4 }> = [];
  for (const s of exp.nodes ?? []) {
    if (first !== undefined && s.frameId !== undefined && s.frameId !== first) continue;
    if (s.nodeId === first) continue;
    // a TEXT spec carries no height: one line (its line height, else 1.2 × its size) stands in for it
    const h = typeof s.height === "number" ? s.height : typeof s.lineHeight === "number" ? s.lineHeight : typeof s.fontSize === "number" ? s.fontSize * 1.2 : null;
    if (typeof s.x !== "number" || typeof s.y !== "number" || typeof s.width !== "number" || h === null) continue;
    out.push({ id: s.nodeId, rect: { x: s.x, y: s.y, w: s.width, h } });
  }
  return out;
}

/** Decode, align, diff, attribute and draw — bounded CPU, run after closeCapped. Never throws: a failure is {ran:false}.
 *  elapsedMs = the capture's own time (captureMs) + this step's — never the behaviour battery run in between. */
export function finishVisual(o: { expectation: Partial<Pick<VerifyExpectation, "nodes" | "frame">>; prep: Extract<VisualPrep, { ok: true }>; capture: VisualCapture | { why: string }; diffPath: string; captureMs: number }): { visual: MeasuredVisual; diffPng: Buffer | null } {
  const t0 = Date.now(), cap = o.capture;
  if ("why" in cap) return { visual: { version: 1, ran: false, why: cap.why }, diffPng: null };
  try {
    const { ref } = o.prep, s = ref.scale;
    const notes = [...o.prep.notes, ...cap.notes];
    // Not handled: a positive offset — the render bounds inside the frame box (a fill-less root?) — is clamped to 0, so the
    // reference is placed at the frame's top-left; whether Figma exports such a root at its render bounds is unverified
    if (ref.offset.x > 0 || ref.offset.y > 0) notes.push(`the reference's render bounds lie inside the frame box (offset ${ref.offset.x},${ref.offset.y}) — alignment unverified`);
    const refImg = decodePng(o.prep.bytes);
    const full = referenceCrop(refImg, s, ref.offset, o.prep.frameSize);
    if (full.x !== ref.crop.x || full.y !== ref.crop.y || full.w !== ref.crop.w || full.h !== ref.crop.h) notes.push(`the expectation's reference crop ${JSON.stringify(ref.crop)} differs from the one recomputed from its scale and offset ${JSON.stringify(full)} — the recomputed one is used`);
    // the part of the design window that was shot (a window past the document's end is not compared)
    const dx = cap.shot.x - cap.clip.x, dy = cap.shot.y - cap.clip.y;
    const sub: Rect4 = { x: full.x + Math.round(dx * s), y: full.y + Math.round(dy * s), w: cap.shot.w === cap.clip.w ? full.w : Math.round(cap.shot.w * s), h: cap.shot.h === cap.clip.h ? full.h : Math.round(cap.shot.h * s) };
    const notCompared = cap.shot.w * cap.shot.h < cap.clip.w * cap.clip.h
      ? { pct: Math.round((1 - (cap.shot.w * cap.shot.h) / (cap.clip.w * cap.clip.h)) * 1000) / 10, why: `the design window ${cap.clip.w}×${cap.clip.h} at ${cap.clip.x},${cap.clip.y} reaches past the built page's end (${cap.shot.w}×${cap.shot.h} of it exists)` }
      : null;
    const refCrop = crop(refImg, sub);
    const shotImg = decodePng(cap.png);
    const plan = planGrid(refCrop, shotImg);
    if (plan.grid === "none") return { visual: { version: 1, ran: false, why: plan.why }, diffPng: null };
    let a: Rgba, b: Rgba, k: number, resampled: "none" | "both";
    if (plan.grid === "reference") {
      a = crop(refCrop, { x: 0, y: 0, w: plan.w, h: plan.h }); b = crop(shotImg, { x: 0, y: 0, w: plan.w, h: plan.h }); k = s; resampled = "none";
      if (plan.note !== null) notes.push(plan.note);
    } else {
      a = resampleBox(refCrop, cap.shot.w, cap.shot.h); b = resampleBox(shotImg, cap.shot.w, cap.shot.h); k = 1; resampled = "both";
      notes.push(plan.why);
    }
    const opts = diffOptionsFor(k);
    const d = diffPixels(a, b, opts);
    // the frame root overlaps every region: it names nothing
    const regions = attribute(d.hot, k, cap.built.filter((n) => n.id !== cap.frame.nodeId), designedRects(o.expectation));
    const diffPng = encodePng(renderDiff(b, d));
    const visual: MeasuredVisual = {
      version: 1, ran: true,
      reference: { path: ref.path, sha256: ref.sha256, scale: s, offset: ref.offset, from: ref.from, crop: sub, ...(ref.colorProfile !== undefined ? { colorProfile: ref.colorProfile } : {}) },
      capture: { dsf: cap.dsf, clip: cap.clip, frame: cap.frame, size: { w: shotImg.w, h: shotImg.h } },
      grid: plan.grid, resampled,
      compared: { w: a.w, h: a.h, k },
      ...(notCompared !== null ? { notCompared } : {}),
      threshold: opts.threshold, shiftPx: opts.shiftPx, cellPx: opts.cellPx, hotFraction: opts.hotFraction, hotMinPx: opts.hotMinPx,
      differingPct: pct(d.differing, d.compared), shiftTolerantPct: pct(d.shiftTolerant, d.compared), aaPct: pct(d.aa, d.compared),
      regions, regionsTotal: d.hotTotal,
      diff: o.diffPath, elapsedMs: o.captureMs + (Date.now() - t0), notes,
    };
    return { visual, diffPng };
  } catch (e) {
    return { visual: { version: 1, ran: false, why: `the visual diff failed (${e instanceof PngError ? e.message : firstLine(e)})` }, diffPng: null };
  }
}

/** The probe's one stderr line — never the verdict. It leads with the number the report's VISUAL headline leads with
 *  (the shift-tolerant one), in the same words. */
export function visualLine(v: MeasuredVisual): string {
  if (!v.ran) return `visual not run (${v.why})`;
  return `visual (informational — never the verdict) ${pctText(v.shiftTolerantPct)}% of pixels differ (${pctText(v.differingPct)}% before ${v.shiftPx}-px shift tolerance) · ${v.regionsTotal} hot region(s)` +
    ` · at the reference's ${v.reference.scale}x (${v.reference.from}) · grid ${v.grid}${v.diff !== null ? ` · ${v.diff}` : ""}`;
}
