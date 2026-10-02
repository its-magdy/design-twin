// probe-drive.ts — what the shipped probe does beyond measuring the resting screen (group 12a):
//
//   * reads the page's horizontal overflow in the measurement pass (D43: `measured.page`), and
//   * DRIVES the overlay interactions the expectation lists (F-70/F-95/F-117, D40(1)): each one on a fresh page in a
//     fresh browser context, after the measurement pass — reach the screen (goto, the --steps), reveal a hover-hidden
//     opener the D16 way, click it with the real mouse, and watch for an element of the dialog contract to appear.
//
// Why: an overlay's opener used to be "not-probed" on every run — the agent drove it by hand (or not at all), with
// evidence nothing could check (F-70), and a row-action button that only shows when its table row is hovered could
// not be clicked at all. What the probe records here is evidence, never a verdict: a row is ok:true only when exactly
// one opener was clicked with the real mouse, something of the dialog contract opened (or the destination frame's tag
// appeared), the destination's tag is inside what opened (D41), and no document loaded — otherwise ok:null with the
// missing piece named. The probe never writes ok:false (D40(1): "nothing detected" is not-probed, never fail).
//
// The page-side functions (readPageOverflow, openerState, armDetector, pollDetector, syntheticClick, submitGuard)
// are handed to page.evaluate, so — as in probe-page.ts — each one is SELF-CONTAINED: no reference to anything
// outside its own body, plain JSON in and out. The DOM is typed by the module-local declarations below (this layer
// has no DOM lib); test/verify-probe-drive-e2e.test.ts runs the BUILT bundle in a real browser to prove it.
//
// Platform facts this relies on (Chromium 153 / Playwright 1.63, verified for group 12a):
//   - Playwright counts opacity:0 as visible and clicks it, so the opener's opacity is judged in the page.
//   - locator.click on a hidden or covered target fails with a TimeoutError after its whole timeout; the probe then
//     clicks in the page (el.click()) and says "synthetic" — never a user activation, so the row stays ok:null.
//   - (hover: hover) matches in a default desktop context — never set hasTouch / isMobile (the reveal would fail).
//   - React commits a dialog opened from a click within a frame or two: the detector polls every 100 ms for 2 s.
//   - :modal and :popover-open parse in Chromium; an unknown selector throws, so each contract selector is tried alone.
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import type { InteractionEvidence, InteractionOutcome, PageOverflow, ProbeActivation, VerifyExpectation, VerifyInteraction } from "./types.ts";
import { errMsg } from "../bridge/src/errmsg.ts";

// ---------------------------------------------------------------- the page, as far as these functions use it
interface DRect { x: number; y: number; width: number; height: number; right: number; bottom: number }
interface DStyle { getPropertyValue(prop: string): string }
interface DElement {
  tagName: string;
  children: ArrayLike<DElement>;
  parentElement: DElement | null;
  form?: unknown;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): DRect;
  getClientRects(): ArrayLike<DRect>;
  closest(selector: string): DElement | null;
  matches(selector: string): boolean;
  contains(other: DElement): boolean;
  checkVisibility(opts?: { visibilityProperty?: boolean; checkVisibilityCSS?: boolean; opacityProperty?: boolean }): boolean;
  querySelectorAll(selector: string): ArrayLike<DElement>;
  click(): void;
}
interface DDocument {
  body: DElement | null;
  documentElement: DElement & { scrollWidth: number; clientWidth: number; clientHeight: number };
  compatMode: string;
  elementFromPoint(x: number, y: number): DElement | null;
  querySelector(selector: string): DElement | null;
  querySelectorAll(selector: string): ArrayLike<DElement>;
}
interface DriveState { before: DElement[]; destBefore: DElement[]; destPaths: string[] }
declare const document: DDocument;
declare const window: { __dtDrive?: DriveState };
declare const scrollX: number;
declare const scrollY: number;
declare const innerWidth: number;
declare const innerHeight: number;
declare function getComputedStyle(el: DElement): DStyle;

// ---------------------------------------------------------------- D43: the page's horizontal overflow
/**
 * In the page: documentElement.scrollWidth vs clientWidth, and the VIEWPORT's overflow-x — the html element's,
 * unless html is `visible` on both axes, then body's (CSS Overflow 3 propagation). scrollable = it overflows by more
 * than 1px and that overflow-x is not hidden/clip (a user can scroll sideways). Offenders: the ≤5 outermost elements
 * reaching furthest past clientWidth (position:fixed ones — unless a transformed/filtered ancestor holds them — and those
 * clipped by a scrolling/clipping ancestor on their containing-block chain never widen the page, so they are left out).
 * SELF-CONTAINED.
 */
export function readPageOverflow(_arg: null): PageOverflow & { compatMode: string } {
  const de = document.documentElement, body = document.body;
  const hs = getComputedStyle(de);
  const hx = hs.getPropertyValue("overflow-x"), hy = hs.getPropertyValue("overflow-y");
  const overflowX = hx === "visible" && hy === "visible" && body ? getComputedStyle(body).getPropertyValue("overflow-x") : hx;
  const scrollWidth = de.scrollWidth, clientWidth = de.clientWidth;
  const scrollable = scrollWidth > clientWidth + 1 && overflowX !== "hidden" && overflowX !== "clip";
  const offenders: PageOverflow["offenders"] = [];
  if (scrollWidth > clientWidth + 1 && body) {
    const pathOf = (el: DElement): string => {
      const parts: string[] = [];
      let cur: DElement | null = el;
      while (cur && cur !== document.documentElement) {
        const parent: DElement | null = cur.parentElement;
        if (!parent) break;
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
        cur = parent;
      }
      parts.unshift("html");
      return parts.join(" > ");
    };
    // An element does not widen the page when an ancestor ON ITS CONTAINING-BLOCK CHAIN clips or scrolls its overflow, or
    // when it is fixed to the viewport. L7: an absolutely positioned element escapes every ancestor that is static and
    // creates no containing block. L-d (Chromium 153, verified): transform / translate / rotate / scale / perspective /
    // filter / backdrop-filter / transform-style:preserve-3d / will-change of one of them create a containing block for
    // absolute AND fixed descendants — so a position:fixed element under one scrolls with the page like an absolute one;
    // contain: layout / paint / strict / content and content-visibility (not visible) keep everything inside.
    const createsBlock = (cs: DStyle): boolean => {
      const v = (k: string): string => cs.getPropertyValue(k);
      if (["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => { const x = v(k); return x !== "" && x !== "none"; })) return true;
      if (v("transform-style") === "preserve-3d") return true;
      return /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(v("will-change"));
    };
    const containsAll = (cs: DStyle): boolean => /\b(layout|paint|strict|content)\b/.test(cs.getPropertyValue("contain"))
      || ["auto", "hidden"].includes(cs.getPropertyValue("content-visibility"));
    const contained = (el: DElement): boolean => {
      const own = getComputedStyle(el).getPropertyValue("position");
      let mode = own === "fixed" ? "fixed" : own === "absolute" ? "absolute" : "flow";
      for (let p: DElement | null = el.parentElement; p && p !== body && p !== de; p = p.parentElement) {
        const cs = getComputedStyle(p);
        const pos = cs.getPropertyValue("position");
        const block = createsBlock(cs), all = containsAll(cs);
        // not on the chain: a fixed element skips every ancestor that makes no containing block; an absolute one, static ones too
        if (mode === "fixed" && !block && !all) continue;
        if (mode === "absolute" && pos === "static" && !block && !all) continue;
        if (all || cs.getPropertyValue("overflow-x") !== "visible") return true;
        mode = pos === "fixed" ? "fixed" : pos === "absolute" ? "absolute" : "flow";
      }
      // fixed to the viewport (no ancestor, body or html included, makes it a containing block) never widens the page
      if (mode !== "fixed") return false;
      return ![body, de].some((x) => { const cs = getComputedStyle(x); return createsBlock(cs) || containsAll(cs); });
    };
    const past: Array<{ el: DElement; right: number }> = [];
    for (const el of Array.from(body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      const right = r.right + scrollX;
      if (r.width > 0 && right > clientWidth + 1 && !contained(el)) past.push({ el, right });
    }
    past.sort((a, b) => b.right - a.right);
    const chosen: DElement[] = [];
    for (const p of past) {
      if (chosen.length >= 5) break;
      if (chosen.some((c) => c.contains(p.el))) continue;
      chosen.push(p.el);
      const tagged = p.el.closest("[data-dt-node]");
      offenders.push({ path: pathOf(p.el), dt: tagged ? tagged.getAttribute("data-dt-node") : null, right: Math.round(p.right) });
    }
  }
  return { viewport: { w: innerWidth, h: innerHeight }, scrollWidth, clientWidth, overflowX, scrollable, offenders, compatMode: document.compatMode };
}

// ---------------------------------------------------------------- the opener (D16 reveal path)
export interface OpenerState {
  /** elements tagged with the opener's id, outside a closed <dialog> (several → those with a layout box) */
  count: number;
  path: string | null;
  /** has a box, a size, and is not hidden by visibility/display/opacity (Playwright calls opacity:0 visible) */
  visible: boolean;
  /** B3: disabled — :disabled / [disabled] / aria-disabled="true", on it or an ancestor (never clicked: a click on an
   *  aria-disabled control still runs the app's handler) */
  disabled: boolean;
  /** what to hover to reveal it: the nearest visible tagged ancestor, else the nearest visible ancestor */
  hoverPath: string | null;
  hoverDt: string | null;
}
/** In the page: find the opener, say whether a person can see it, and what to hover when not. SELF-CONTAINED. */
export function openerState(arg: { id: string }): OpenerState {
  const pathOf = (el: DElement): string => {
    const parts: string[] = [];
    let cur: DElement | null = el;
    while (cur && cur !== document.documentElement) {
      const parent: DElement | null = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const hasBox = (el: DElement): boolean => el.getClientRects().length > 0;
  const sees = (el: DElement, opacity: boolean): boolean => {
    if (!hasBox(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: opacity });
  };
  const sel = `[data-dt-node="${arg.id.replace(/["\\]/g, "\\$&")}"]`;
  let els = Array.from(document.querySelectorAll(sel)).filter((e) => e.closest("dialog:not([open])") === null);
  if (els.length > 1) els = els.filter(hasBox);
  const el = els.length === 1 ? els[0] : undefined;
  if (!el) return { count: els.length, path: null, visible: false, disabled: false, hoverPath: null, hoverDt: null };
  const visible = sees(el, true);
  const disabled = el.closest(":disabled, [disabled], [aria-disabled=\"true\" i]") !== null;
  let hoverPath: string | null = null, hoverDt: string | null = null;
  if (!visible) {
    let plain: DElement | null = null;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (!sees(p, false)) continue;
      const dt = p.getAttribute("data-dt-node");
      if (dt !== null) { hoverPath = pathOf(p); hoverDt = dt; break; }
      if (!plain) plain = p;
    }
    if (hoverPath === null && plain) hoverPath = pathOf(plain);
  }
  return { count: 1, path: pathOf(el), visible, disabled, hoverPath, hoverDt };
}

// ---------------------------------------------------------------- the detector (F-70)
/** The dialog contract, in the order a match is named (detectedBy). */
export const DIALOG_CONTRACT = [":modal", "dialog[open]", "[role=dialog]", "[role=alertdialog]", "[aria-modal=\"true\"]", ":popover-open"] as const;

/** In the page, BEFORE the click: remember every visible dialog-like element and destination tag. SELF-CONTAINED. */
export function armDetector(arg: { destId: string | null; contract: readonly string[] }): boolean {
  const pathOf = (el: DElement): string => {
    const parts: string[] = [];
    let cur: DElement | null = el;
    while (cur && cur !== document.documentElement) {
      const parent: DElement | null = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const seen = (el: DElement): boolean => {
    if (el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true });
  };
  const before: DElement[] = [];
  for (const s of arg.contract) {
    try { for (const el of Array.from(document.querySelectorAll(s))) if (seen(el)) before.push(el); } catch { /* a selector this browser does not parse */ }
  }
  const destBefore = arg.destId === null ? [] : Array.from(document.querySelectorAll(`[data-dt-node="${arg.destId.replace(/["\\]/g, "\\$&")}"]`)).filter(seen);
  // L-b: where each was, too — a wrapper the app re-mounts in the same place is a new element but not a newly shown one
  window.__dtDrive = { before, destBefore, destPaths: destBefore.map(pathOf) };
  return true;
}

export interface DetectorRead {
  /** the document that armed the detector is gone (a load happened) */
  lost: boolean;
  /** the first contract selector a NEWLY visible element matches */
  detectedBy: string | null;
  opened: { selector: string; modal: boolean; position: string; rect: { x: number; y: number; w: number; h: number }; scrollY: number } | null;
  /** visible destination tags: how many, whether one is the opened element / inside it / a NEWLY visible ancestor of it, and whether one is new */
  dest: { count: number; inside: boolean; newly: boolean } | null;
}
/** In the page, after the click: what newly opened. SELF-CONTAINED. */
export function pollDetector(arg: { destId: string | null; contract: readonly string[] }): DetectorRead {
  const st = window.__dtDrive;
  if (!st) return { lost: true, detectedBy: null, opened: null, dest: null };
  const pathOf = (el: DElement): string => {
    const parts: string[] = [];
    let cur: DElement | null = el;
    while (cur && cur !== document.documentElement) {
      const parent: DElement | null = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const seen = (el: DElement): boolean => {
    if (el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true });
  };
  let opened: DElement | null = null, detectedBy: string | null = null;
  for (const s of arg.contract) {
    let hits: DElement[] = [];
    try { hits = Array.from(document.querySelectorAll(s)).filter((el) => seen(el) && !st.before.includes(el)); } catch { continue; }
    const first = hits[0];
    if (first) { opened = first; detectedBy = s; break; }
  }
  let dest: DetectorRead["dest"] = null;
  if (arg.destId !== null) {
    const tags = Array.from(document.querySelectorAll(`[data-dt-node="${arg.destId.replace(/["\\]/g, "\\$&")}"]`)).filter(seen);
    // newly visible: not one seen before the click — nor a re-mounted copy in the same place (L-b; same path)
    const fresh = tags.filter((t) => !st.destBefore.includes(t) && !st.destPaths.includes(pathOf(t)));
    // planner default 1: the destination tag newly appearing with no contract match IS what opened
    const firstFresh = fresh[0];
    if (opened === null && firstFresh) opened = firstFresh;
    const o = opened;
    // M2: the tag on the opened element or inside it — or on an ancestor of it that this click made visible (a
    // destination wrapper that appeared with its dialog); a tagged wrapper already on screen holds anything that opens in it
    dest = { count: tags.length, inside: o !== null && tags.some((t) => t === o || o.contains(t) || (t.contains(o) && fresh.includes(t))), newly: fresh.length > 0 };
  }
  if (!opened) return { lost: false, detectedBy: null, opened: null, dest };
  let modal = false;
  try { modal = opened.matches(":modal"); } catch { /* no :modal here */ }
  const r = opened.getBoundingClientRect();
  return {
    lost: false, detectedBy, dest,
    opened: { selector: pathOf(opened), modal, position: getComputedStyle(opened).getPropertyValue("position"),
      rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) }, scrollY: Math.round(scrollY) },
  };
}

/** In the page: the fallback activation — a synthetic click event (never a user activation). SELF-CONTAINED. */
export function syntheticClick(path: string): boolean {
  const el = document.querySelector(path);
  if (!el) return false;
  el.click();
  return true;
}

/** In the page (Locator.evaluate): why clicking this element would SUBMIT a form, or null. A step must navigate,
 *  never submit (D40(7)): a [type=submit] / input[type=image] control, or a typeless <button> that belongs to a
 *  form (its `form` property — the closest <form>, or the one its form attribute names). L-c: the click lands on the
 *  element at its click point, which can be a submitting control INSIDE a tagged wrapper — that one is checked too.
 *  L-2: Playwright's click point (its _clickablePoint) is the middle of the element's FIRST content quad (one per box /
 *  line fragment — getClientRects) whose part inside the viewport has an area (> 0.99 px²), clipped to the viewport, after
 *  scrolling it into view (the caller runs scrollIntoViewIfNeeded first) — so an oversized wrapper is clicked at the middle
 *  of what shows, and an inline element wrapping over lines on its first line, never at the middle of its bounding box
 *  (fix 4): elementFromPoint there; when nothing of it is on screen, the visible controls whose box holds the full centre.
 *  (Playwright uses the true transformed quad; for a rotated/skewed element partly off screen this axis-aligned rect's
 *  centre can differ slightly.)
 *  SELF-CONTAINED. */
export function submitGuard(el: DElement): string | null {
  const why = (target: DElement): string | null => {
    const ctl = target.closest("button, input") || target;
    const tag = ctl.tagName.toLowerCase();
    const type = (ctl.getAttribute("type") || "").toLowerCase();
    if (type === "submit") return `<${tag} type=submit>`;
    if (tag === "input" && type === "image") return "<input type=image>";
    if (tag === "button" && !ctl.hasAttribute("type") && ctl.form) return "a <button> without a type inside a <form> (it submits)";
    return null;
  };
  const own = why(el);
  if (own !== null) return own;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  let onScreen = false, cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  // fix 5: Playwright clips to the layout viewport — without the scrollbars (documentElement.clientWidth/Height); fix 6: never
  // more than the window (in quirks mode documentElement.clientHeight is the PAGE's height)
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  for (const q of Array.from(el.getClientRects())) {
    const x0 = Math.min(Math.max(q.x, 0), vw), x1 = Math.min(Math.max(q.right, 0), vw);
    const y0 = Math.min(Math.max(q.y, 0), vh), y1 = Math.min(Math.max(q.bottom, 0), vh);
    if ((x1 - x0) * (y1 - y0) > 0.99) { onScreen = true; cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; break; }
  }
  const at: DElement[] = [];
  const hit = onScreen ? document.elementFromPoint(cx, cy) : null;
  if (hit && hit !== el && el.contains(hit)) at.push(hit);
  else if (!hit) {
    // off screen (Playwright scrolls it in first): the controls inside whose box holds the centre
    for (const c of Array.from(el.querySelectorAll("button, input"))) {
      const b = c.getBoundingClientRect();
      if (b.width > 0 && b.height > 0 && cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height && c.checkVisibility({ visibilityProperty: true })) at.push(c);
    }
  }
  for (const t of at) {
    const w = why(t);
    if (w !== null) return `${w} at its click point`;
  }
  return null;
}

// ---------------------------------------------------------------- which rows are driven, the budget, the outcome
const OVERLAY_ACTIONS = new Set(["overlay", "swap"]);
const CLICK_TRIGGERS = new Set(["on_click", "on_press"]);
/**
 * The expectation rows the probe drives (D40(1)): visible-layer overlay/swap interactions with an on_click/on_press
 * trigger, and plan rows that expect a dialog with one of those triggers. One row per nodeId + trigger (the compare key); designed destinations
 * first — an undesigned one (destinationExported false) only when the budget allows.
 */
export function drivable(exp: Pick<VerifyExpectation, "interactions" | "hidden">): VerifyInteraction[] {
  const hidden = new Set((exp.hidden && exp.hidden.ids) || []);
  const keys = new Set<string>();
  const rows = (exp.interactions || []).filter((r) => {
    if (hidden.has(r.nodeId)) return false;
    const trigger = String(r.trigger).toLowerCase();
    // L2: a plan dialog row is driven only for a click/press trigger too (a hover- or key-opened dialog is not clicked)
    const ok = CLICK_TRIGGERS.has(trigger) && (OVERLAY_ACTIONS.has(String(r.action).toLowerCase()) || (r.source === "plan" && r.expect === "dialog"));
    const key = `${r.nodeId}|${trigger}`;
    if (!ok || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return [...rows.filter((r) => r.destinationExported !== false), ...rows.filter((r) => r.destinationExported === false)];
}

export const DRIVE_CAP_MS = 60_000, DRIVE_RESERVE_MS = 15_000;
/** The driving sub-budget: min(60 s, what is left of --max-time less 15 s for writing up and closing) — never < 0. */
export function driveBudget(now: number, deadline: number, capMs = DRIVE_CAP_MS, reserveMs = DRIVE_RESERVE_MS): number {
  return Math.max(0, Math.min(capMs, deadline - now - reserveMs));
}

/** What the probe saw, as an outcome (F-102 words) for the row's action. */
export function classifyOutcome(action: string, read: Pick<DetectorRead, "detectedBy" | "dest" | "opened">): { outcome: InteractionOutcome; detectedBy?: string } {
  const destNew = !!(read.dest && read.dest.newly);
  if (String(action).toLowerCase() === "swap") {
    if (destNew) return { outcome: "selector-appeared", detectedBy: read.detectedBy ?? "destination-tag" };
    return read.detectedBy ? { outcome: "dialog-opened", detectedBy: read.detectedBy } : { outcome: "none" };
  }
  if (read.detectedBy) return { outcome: "dialog-opened", detectedBy: read.detectedBy };
  if (destNew && read.opened) return { outcome: "selector-appeared", detectedBy: "destination-tag" };
  return { outcome: "none" };
}
/** The outcomes an overlay / swap may produce (verify-screen OUTCOMES_FOR_ACTION). */
const ALLOWED: Readonly<Record<string, readonly string[]>> = { overlay: ["dialog-opened", "selector-appeared"], swap: ["state-changed", "selector-appeared"] };

/** ok:true only with every piece of D24/D41 evidence; otherwise ok:null and the missing pieces in words. Never false. */
export function judge(action: string, e: Pick<InteractionEvidence, "selectorCount" | "outcome" | "navEvents" | "destination" | "activation">): { ok: true | null; missing: string[] } {
  const missing: string[] = [];
  const allowed = ALLOWED[String(action).toLowerCase()] ?? ALLOWED.overlay ?? [];
  if (e.selectorCount !== 1) missing.push(`the opener matched ${e.selectorCount ?? 0} element(s)`);
  if (e.outcome === undefined || !allowed.includes(e.outcome)) missing.push(e.outcome === "none" || e.outcome === undefined ? "nothing of the dialog contract opened within 2 s" : `outcome ${e.outcome} is not one a ${action} produces`);
  if (e.navEvents !== 0) missing.push(`${e.navEvents ?? "?"} document load(s) during the interaction`);
  if (!e.destination) missing.push("no destination frame id to look for");
  else if (!e.destination.inside) missing.push(e.destination.count ? `the destination tag data-dt-node="${e.destination.nodeId}" is not inside the opened element` : `no visible element is tagged with the destination data-dt-node="${e.destination.nodeId}" — tag the dialog's root with it`);
  if (e.activation !== "mouse") missing.push("synthetic click (headless) — not a user activation");
  return { ok: missing.length ? null : true, missing };
}

// ---------------------------------------------------------------- driving
/** A step replay failed in a driving page (thrown by the reach function). */
export class StepError extends Error {}

export interface DriveOptions {
  rows: VerifyInteraction[];
  viewport: { w: number; h: number };
  /** per-action timeout (the probe's --timeout) */
  timeout: number;
  /** the probe's init script (no transitions/animations; the per-document token window.__dtProbeDoc) */
  initScript: string;
  /** goto → settle → steps → settle(--ready) on a fresh page; throws StepError when a step fails */
  reach(page: Page): Promise<void>;
  /** the sub-budget (driveBudget), in ms from now */
  budgetMs: number;
}
export interface DriveHooks {
  /** 12b seam: called with the page while the opened element is open */
  afterOpen?(page: Page, row: VerifyInteraction, opened: NonNullable<DetectorRead["opened"]>): Promise<void>;
}

const raf2 = (page: Page): Promise<unknown> => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
const CLOSED = /Target closed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;
const NAVIGATED = /Execution context was destroyed|frame was detached|Cannot find context with specified id|interrupted by another navigation/i;
const firstLine = (e: unknown): string => errMsg(e).split("\n")[0] ?? "";
const notRun = (row: VerifyInteraction, detail: string, extra?: Partial<InteractionEvidence>): InteractionEvidence => ({ nodeId: row.nodeId, trigger: row.trigger, ok: null, detail: `not-run: ${detail}`, ...extra });

/** 12b seam: a fresh context + page (no hasTouch/isMobile — facts §7) reached like the measurement pass. The caller
 *  closes the context. `loads` counts main-frame document loads from the moment the page exists. `onContext` gets the
 *  context BEFORE the screen is reached (M1): a budget cut can then close it while reach is still waiting. */
export async function openReached(browser: Browser, o: Pick<DriveOptions, "viewport" | "timeout" | "initScript" | "reach">, extra?: { dsf?: number; onContext?: (c: BrowserContext) => void }): Promise<{ context: BrowserContext; page: Page; loads: () => number }> {
  const context = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, deviceScaleFactor: extra?.dsf ?? 1, reducedMotion: "reduce" });
  if (extra && extra.onContext) extra.onContext(context);
  let loads = 0;
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(o.timeout);
    await page.addInitScript({ content: o.initScript });
    page.on("load", () => { loads++; });
    await o.reach(page);
    return { context, page, loads: () => loads };
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
}

async function driveRow(browser: Browser, o: DriveOptions, row: VerifyInteraction, hooks: DriveHooks | undefined, onContext: (c: BrowserContext) => void): Promise<InteractionEvidence> {
  const action = row.source === "plan" && row.expect === "dialog" ? "overlay" : String(row.action ?? "overlay").toLowerCase();
  const destId = row.destinationId ?? null;
  let opened: Awaited<ReturnType<typeof openReached>>;
  try {
    opened = await openReached(browser, { viewport: o.viewport, timeout: o.timeout, initScript: o.initScript, reach: o.reach }, { onContext });
  } catch (e) {
    if (e instanceof StepError) return notRun(row, `the steps failed — ${e.message}`, { stepsFailed: e.message });
    return notRun(row, `could not reach the screen — ${firstLine(e)}`);
  }
  const { context, page, loads } = opened;
  const selector = `[data-dt-node="${row.nodeId.replace(/["\\]/g, "\\$&")}"]`;
  try {
    let st = await page.evaluate(openerState, { id: row.nodeId });
    const base: InteractionEvidence = { nodeId: row.nodeId, trigger: row.trigger, selector, selectorCount: st.count };
    if (st.count !== 1 || st.path === null) return { ...base, ok: null, detail: `the opener ${selector} matched ${st.count} element(s) outside a closed dialog — not driven` };
    // B3: a disabled opener is not clicked (an aria-disabled one would still run the app's handler — a real write)
    if (st.disabled) return { ...base, ok: null, detail: "opener is disabled — not driven" };
    // L3: nor one whose click submits a form (D40(7): the probe navigates and opens, never submits)
    // L-2: judged where the click will land — scrolled into view the way Playwright's click does it first
    if (st.visible) await page.locator(st.path).first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
    const submits = await page.locator(st.path).first().evaluate(submitGuard);
    if (submits !== null) return { ...base, ok: null, detail: `opener would submit a form (${submits}) — not driven` };
    let revealedBy: string | undefined;
    if (!st.visible) {
      // D16 path: park the pointer, hover the nearest visible (tagged) ancestor, two frames, look again
      if (st.hoverPath !== null) {
        revealedBy = st.hoverDt !== null ? `[data-dt-node="${st.hoverDt}"]` : st.hoverPath;
        await page.mouse.move(0, 0);
        await page.locator(st.hoverPath).first().hover({ timeout: 2000 }).catch(() => undefined);
        await raf2(page);
        st = await page.evaluate(openerState, { id: row.nodeId });
      }
      if (!st.visible || st.path === null) return { ...base, ok: null, ...(revealedBy !== undefined ? { revealedBy } : {}), detail: `opener not visible even on hover${revealedBy !== undefined ? ` (hovered ${revealedBy})` : " (no visible ancestor to hover)"} — not driven` };
    }
    const openerPath = st.path;
    const contract = [...DIALOG_CONTRACT];
    await page.evaluate(armDetector, { destId, contract });
    const tokenBefore = String(await page.evaluate("window.__dtProbeDoc || ''"));
    const loadsBefore = loads();
    let activation: ProbeActivation = "mouse", clickWhy = "";
    try {
      await page.locator(openerPath).first().click({ timeout: 2000 });
    } catch (e) {
      const m = errMsg(e);
      if (CLOSED.test(m)) throw e;
      if (!NAVIGATED.test(m)) {
        // hidden or covered (TimeoutError after the full 2 s): click in the page — never a user activation
        clickWhy = (/intercepts pointer events|not visible|not enabled|not stable|outside of the viewport/.exec(m) || [firstLine(e)])[0] ?? "";
        activation = "synthetic";
        await page.evaluate(syntheticClick, openerPath);
      }
    }
    // poll ≤ 2 s; once a contract element opened, wait ≤ 0.5 s more for the destination tag to land inside it
    const t0 = Date.now();
    let read: DetectorRead = { lost: false, detectedBy: null, opened: null, dest: null };
    let detectedAt: number | null = null;
    for (;;) {
      try { read = await page.evaluate(pollDetector, { destId, contract }); } catch (e) {
        if (CLOSED.test(errMsg(e))) throw e;
        if (!NAVIGATED.test(errMsg(e))) throw e;
        read = { lost: true, detectedBy: null, opened: null, dest: null };
      }
      if (read.lost) break;
      if (read.detectedBy !== null && detectedAt === null) detectedAt = Date.now();
      const destDone = destId === null || (read.dest !== null && read.dest.inside);
      if (read.opened && destDone) break;
      if (detectedAt !== null && Date.now() - detectedAt >= 500) break;
      if (Date.now() - t0 >= 2000) break;
      await sleep(100);
    }
    if (read.lost) await page.waitForLoadState("load", { timeout: 2000 }).catch(() => undefined);
    let tokenAfter = "";
    try { tokenAfter = String(await page.evaluate("window.__dtProbeDoc || ''")); } catch { tokenAfter = ""; }
    const navEvents = Math.max(loads() - loadsBefore, tokenAfter !== tokenBefore || read.lost ? 1 : 0);
    const { outcome, detectedBy } = read.lost ? { outcome: "none" as const, detectedBy: undefined } : classifyOutcome(action, read);
    const ev: InteractionEvidence = {
      ...base, outcome, navEvents, activation,
      ...(detectedBy !== undefined ? { detectedBy } : {}),
      ...(revealedBy !== undefined ? { revealedBy } : {}),
      ...(destId !== null ? { destination: { nodeId: destId, inside: !read.lost && !!read.dest && read.dest.inside, count: read.dest ? read.dest.count : 0 } } : {}),
      ...(read.opened && !read.lost ? { opened: read.opened } : {}),
    };
    const j = judge(action, ev);
    const how = `${activation === "mouse" ? "clicked" : `synthetic click (${clickWhy})`}${revealedBy !== undefined ? ` after hovering ${revealedBy}` : ""}`;
    const saw = read.lost ? "the page loaded a new document" : detectedBy !== undefined ? `${detectedBy === "destination-tag" ? "the destination tag appeared" : `${detectedBy} opened`}` : "nothing opened";
    ev.ok = j.ok;
    ev.detail = j.ok ? `${how}: ${saw}, destination ${destId} inside` : `${how}: ${saw} — ${j.missing.join("; ")}`;
    if (hooks && hooks.afterOpen && read.opened && !read.lost) await hooks.afterOpen(page, row, read.opened);
    return ev;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Drive every row (drivable()), each on a fresh page in a fresh context, within the sub-budget. A row the budget
 * does not reach is {ok:null, cut:"budget"}; a row that throws is ok:null with why. Never throws for a row.
 */
const CUT_SETTLE_MS = 5_000;
export async function driveInteractions(browser: Browser, o: DriveOptions, hooks?: DriveHooks): Promise<InteractionEvidence[]> {
  const out: InteractionEvidence[] = [];
  const end = Date.now() + o.budgetMs;
  for (const row of o.rows) {
    const left = end - Date.now();
    if (left <= 0) { out.push(notRun(row, "time budget", { cut: "budget" })); continue; }
    const held: { ctx?: BrowserContext } = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cut = new Promise<"cut">((resolve) => { timer = setTimeout(() => resolve("cut"), left); });
    const work = driveRow(browser, o, row, hooks, (c) => { held.ctx = c; }).catch((e: unknown): InteractionEvidence => {
      if (CLOSED.test(errMsg(e))) return notRun(row, `the browser closed while driving — ${firstLine(e)}`);
      return { nodeId: row.nodeId, trigger: row.trigger, ok: null, detail: `driving failed: ${firstLine(e)}` };
    });
    const r = await Promise.race([work, cut]);
    clearTimeout(timer);
    if (r === "cut") {
      // the context exists from before the screen was reached (M1): closing it ends whatever the row was waiting on
      if (held.ctx) await held.ctx.close().catch(() => undefined);
      await Promise.race([work, sleep(CUT_SETTLE_MS, undefined, { ref: false })]);
      out.push(notRun(row, "time budget", { cut: "budget" }));
      continue;
    }
    out.push(r);
  }
  return out;
}
