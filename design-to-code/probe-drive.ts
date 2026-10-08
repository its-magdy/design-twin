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
// The page-side functions (readPageOverflow, openerState, armDetector, pollDetector, saveScroll, restoreScroll, scrollHeld, syntheticClick, submitGuard,
// clickPointControl, and D52's ownMark / ownShot / ownClear)
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
import { inflateSync } from "node:zlib";
import type { Browser, BrowserContext, Page } from "playwright";
import type { InteractionEvidence, InteractionOutcome, PageOverflow, ProbeActivation, VerifyExpectation, VerifyInteraction } from "./types.ts";
import { errMsg } from "../bridge/src/errmsg.ts";

// ---------------------------------------------------------------- the page, as far as these functions use it
interface DRect { x: number; y: number; width: number; height: number; right: number; bottom: number }
interface DStyle { getPropertyValue(prop: string): string }
/** a child node, as far as D51's own-content check reads it (nodeType 3 = text) */
interface DNode { nodeType: number; nodeValue: string | null; assignedSlot?: DElement | null }
/** an open shadow root, as far as the click point (review 5 H-1) and D51's own-content check read it */
interface DShadow { children: ArrayLike<DElement>; childNodes: ArrayLike<DNode>; elementFromPoint?(x: number, y: number): DElement | null;
  /** D53: the probe's hiding sheet is adopted into each open shadow root inside the container */
  adoptedStyleSheets: DSheet[] }
interface DElement {
  tagName: string;
  children: ArrayLike<DElement>;
  childNodes: ArrayLike<DNode>;
  parentElement: DElement | null;
  /** the slot a slotted element is shown in (the flat tree a click's event path follows) */
  assignedSlot?: DElement | null;
  shadowRoot?: DShadow | null;
  getRootNode?(): { host?: DElement } | null;
  /** a <label>'s control (HTMLLabelElement.control) */
  control?: DElement | null;
  form?: unknown;
  scrollLeft: number;
  scrollTop: number;
  scrollTo(opts: { left: number; top: number; behavior: "instant" }): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): DRect;
  getClientRects(): ArrayLike<DRect>;
  closest(selector: string): DElement | null;
  matches(selector: string): boolean;
  contains(other: DElement): boolean;
  checkVisibility(opts?: { visibilityProperty?: boolean; checkVisibilityCSS?: boolean; opacityProperty?: boolean; contentVisibilityAuto?: boolean }): boolean;
  querySelectorAll(selector: string): ArrayLike<DElement>;
  click(): void;
  /** D52's pixel check (ownMark / ownShot / ownClear) */
  isConnected: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  scrollIntoView(opts: { block: string; inline: string; behavior: string }): void;
  focus(opts: { preventScroll: boolean }): void;
}
interface DDocument {
  activeElement: DElement | null;
  /** D52: the probe's own constructed sheet (a page's CSP style-src blocks an injected <style>, never CSSOM) */
  adoptedStyleSheets: DSheet[];
  body: DElement | null;
  documentElement: DElement & { scrollWidth: number; clientWidth: number; clientHeight: number };
  compatMode: string;
  elementFromPoint(x: number, y: number): DElement | null;
  /** D54(b): the hit stack at a point (is a label from outside the container laid over it, or under it?) */
  elementsFromPoint(x: number, y: number): DElement[];
  querySelector(selector: string): DElement | null;
  querySelectorAll(selector: string): ArrayLike<DElement>;
  createRange(): { selectNodeContents(node: DNode): void; getClientRects(): ArrayLike<DRect> };
}
interface DriveState { before: DElement[]; destBefore: DElement[]; destPaths: string[]; roots?: DElement[] }
/** review 5 M-1: the scroll the drive had before its click (saveScroll / restoreScroll) */
interface DriveScroll { x: number; y: number; boxes: Array<{ el: DElement; left: number; top: number }> }
/** D52: the container and the control the pixel check compares (set by clickPointControl's and markOpener's D47 path), and the
 *  scroll ownMark had before it brought the container into view */
interface OwnPair { box: DElement; ctl: DElement; saved?: DriveScroll; focus?: DElement; sheet?: DSheet;
  /** D53: the open shadow roots inside the container (inCtl: the control's own), and the sheet adopted into them */
  roots?: Array<{ root: DShadow; inCtl: boolean }>; rootSheet?: DSheet;
  /** every element of the container's flat tree (open shadow roots included) and whether it is the control's (review 8 L-2) */
  els?: Array<{ e: DElement; inCtl: boolean }> }
interface DSheet { replaceSync(text: string): void }
declare const document: DDocument;
declare const window: { __dtDrive?: DriveState; __dtDriveScroll?: DriveScroll; __dtOwn?: OwnPair | null; __dtOwnWhy?: string | null;
  /** D56 (tipPreMark): the [role=tooltip] elements and the elements with an id already shown before the probe acted on the page */
  __dtTipPre?: WeakSet<DElement> | null };
declare const scrollX: number;
declare const scrollY: number;
declare const innerWidth: number;
declare const innerHeight: number;
declare function getComputedStyle(el: DElement, pseudo?: string | null): DStyle;
declare function scrollTo(opts: { left: number; top: number; behavior: "instant" }): void;
declare const CSSStyleSheet: new () => DSheet;

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
  // 12b M-3: every OPEN modal root rendered now, whatever its box (Headless UI's root is 0 px, so `before` never has it) — the
  // behaviour battery never climbs to one of these as "what opened"; the detector itself does not read it (12a unchanged)
  const roots = Array.from(document.querySelectorAll("dialog[open], [aria-modal=\"true\" i]")).filter((el) => el.getClientRects().length > 0);
  // L-b: where each was, too — a wrapper the app re-mounts in the same place is a new element but not a newly shown one
  window.__dtDrive = { before, destBefore, destPaths: destBefore.map(pathOf), roots };
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

/** Review 5 M-1, in the page: the scroll the drive has before its mouse click — the window's and every ancestor box's of the
 *  opener — kept for restoreScroll. SELF-CONTAINED. */
export function saveScroll(el: DElement): void {
  const boxes: DriveScroll["boxes"] = [];
  for (let p = el.parentElement; p; p = p.parentElement) boxes.push({ el: p, left: p.scrollLeft, top: p.scrollTop });
  window.__dtDriveScroll = { x: scrollX, y: scrollY, boxes };
}
/** Review 5 M-1, in the page: back to saveScroll's scroll before the synthetic click — a failed mouse click leaves the page where
 *  Playwright's last retry scrolled the opener in (each retry with another alignment; how many fit in its 2 s depends on load),
 *  so the opened element's rect and scrollY would depend on timing. SELF-CONTAINED. */
export function restoreScroll(): void {
  const s = window.__dtDriveScroll;
  if (!s) return;
  // review 6 H-4 (D4): instant — a scroll-behavior:smooth box (an app shell's scroller) would otherwise animate back while the
  // synthetic click lands and the detector reads (MDN: scrollTop / scrollTo(x, y) use the box's computed scroll-behavior)
  for (const b of s.boxes) if (b.el.scrollLeft !== b.left || b.el.scrollTop !== b.top) b.el.scrollTo({ left: b.left, top: b.top, behavior: "instant" });
  scrollTo({ left: s.x, top: s.y, behavior: "instant" });
}

/** Review 6 H-4 follow-up (D4), in the page: whether restoreScroll's positions still hold — Playwright's last click retry can
 *  leave a smooth scroll (a page's own !important scroll-behavior beats the probe's init CSS) running after the restore, so
 *  driveRow restores, waits two frames and looks again until it holds twice in a row. SELF-CONTAINED. */
export function scrollHeld(): boolean {
  const s = window.__dtDriveScroll;
  if (!s) return true;
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1;
  return near(scrollX, s.x) && near(scrollY, s.y) && s.boxes.every((b) => near(b.el.scrollLeft, b.left) && near(b.el.scrollTop, b.top));
}

// ---------------------------------------------------------------- D52 / D53: the container's own content, by pixels
// D51 (owner): a container's sole centred control is the opener's own only when the container shows nothing of its own outside
// it. D52 (owner): that is decided by PIXELS, as a union with the DOM check (clickPointControl / markOpener's ownContent: content
// when EITHER says so — a label not painted yet, an in-flow opacity-0 reveal, still counts). Shot A: the container with only its
// control hidden; shot B: with all its content hidden — every descendant, the content of every open shadow root inside it (the
// container itself as a host too: D53), the container's own ::before / ::after and its own ::marker (D53). Any pixel that differs
// is content of its own → the control is not the opener's (the drive does not click, the battery presses no key).
// D53 (owner): in every shot everything OUTSIDE the container's subtree is hidden too, so a foreign overlay or toast repainting
// over the cell between the two shots never decides the result (D4); D54(c) (owner, review 9 M-1): its ancestors too (their own
// background, border, text, pseudo-elements — a parent repainted by script never decides), their backgrounds off (the root's
// would still paint the canvas), the container shown again by its own rule (what it holds keeps the visibility it had); the
// focused element outside it stays shown on its own (hiding it would blur it — Chromium keeps the focus of an element shown under
// hidden ancestors). Review 9 L-1: the pseudo-elements beyond ::before / ::after (::first-letter, ::placeholder,
// ::file-selector-button, ::details-content, ::scroll-button(*), ::scroll-marker, ::scroll-marker-group) are hidden too, each by
// its own rule, and checked to have taken.
// Hidden by the probe's own constructed style sheets (document.adoptedStyleSheets, and adopted into each open shadow root inside
// the container — a page's CSP blocks an injected <style>; by experiment it does not block a constructed sheet: CSP3 §6.1.13
// names CSSOM's insertRule / cssText as gated on 'unsafe-eval', MDN says no browser enforces that, and a sheet whose rules did
// not take refuses) with visibility:hidden !important and transition:none (no layout change; `*` also covers descendants that
// set visibility:visible themselves; a transition on visibility would keep it showing), on marker attributes; the sheets and
// the markers are removed afterwards, and a rule that did not take refuses — every element a shot hides (and its ::before /
// ::after with content) is checked, so a page's inline !important, or an !important inside a cascade layer (which beats any
// unlayered one, whatever its specificity: review 8 L-2), refuses instead of showing in both shots.
// Kept in BOTH shots — decoration, but only when the pixels show it PLAIN (D53): the container's own background colour, border
// in one colour, box-shadow and outline (D54(a): its own background image, a border in two colours or a stripe are content — the
// DOM rule, ownContent); a descendant painting only a background colour over the container's whole padding box (a hover tint —
// the container's own background drawn by a child) and a wrapper of the control within 8 px of it on every side (a filled
// wrapper — the control's own chrome; what else it holds is still hidden in shot B). CSS pre-filter for those two: not a
// replaced or form element (img, svg, canvas, video, audio, picture, object, embed, iframe, frame, fencedframe, progress, meter,
// input, select, textarea), no clip-path, background-clip border-box or padding-box, not a list item, no shadow root (the
// covering one also: no image, mask, shadow, filter, border or outline). Then the PIXEL test (plainKept): with the container and
// all its content hidden — and the filters, clip-paths and masks of the container and its ancestors off (D54(c), review 9 H-2: a
// drop-shadow list or a rounded clip-path never decides) — the kept boxes alone must paint ONE uniform colour inside each filled
// box's real outline (its own rounded corners, elliptical ones too, cut by every box up to the container that clips it — review
// 9 H-1: a 50%-radius progress ring has a core) and nothing outside it — only a band 1.5 px either side of that outline may hold
// a blend of that colour and what is behind (anti-aliasing). A wrapper with its own shadow or a frame in another colour is not
// plain: refused (D54, accepted cost). A progress bar, a clip-path flag, a background-clip stripe, a shadow ring, text in a kept box: not
// plain → content. Anything else that paints counts: text, images, icons, generated content, swatches, dots, borders and
// shadows of children, form widgets, stripes and 1-px dividers.
// Not seen by the pixels: the container's own bare text (the DOM's text rule reads it), a label laid over it from outside its
// subtree (hidden as the outside: the DOM rule reads it, D54(b)), a part of the container outside the viewport once scrolled in, a
// closed shadow root, foreign content inside an ANCESTOR's shadow root (the probe's document sheet cannot reach it), an open
// shadow root attached after ownMark that forces visibility:visible in its own sheet (review 9 L-2: roots are collected once — a
// late root without that inherits the hidden host), and content revealed only later (a delayed out-of-flow reveal after the
// check) — the pointer is parked away (the drive) so a hover tint is not counted, and a hover-revealed control is then hidden in
// both shots (a control the page unmounts once the pointer leaves counts as hidden: the page hid it). Review 10 H-1: an element
// the page mounts in the container after a shot's marks (a re-render inside the screenshot's own frame) would be hidden as
// "outside" — checked before shots B / K / N: refused. Review 10 L-2: a container inside a shadow root is refused
// (the document sheet cannot show it again). Review 10 M-2: the extra pseudo-element rules are put on the container's subtree
// only, never on "everything outside" (that cost a style pass over every element of the page in every shot).

/** D52, in the page: mark the pair clickPointControl / markOpener left in window.__dtOwn — the container [data-dt-own], its
 *  control [data-dt-own-ctl], the boxes kept in both shots [data-dt-own-keep] (CSS pre-filter), what stays on screen outside
 *  it [data-dt-own-up] (its ancestors in the flat tree, the focused element and its ancestors), the open shadow roots inside it
 *  — bring the container into view when part of it is off screen (the scroll is put back by ownClear), and say which control it
 *  is and how many boxes are kept. null = no pair (nothing to check). SELF-CONTAINED. */
export function ownMark(_arg: null): { ctl: string; keep: number; why: string | null; scrolled: boolean } | null {
  const o = window.__dtOwn;
  if (!o || !o.box.isConnected || !o.ctl.isConnected) return null;
  const { box, ctl } = o;
  // review 10 L-2: the hiding sheet lives in the document and the container is shown again by a document rule — a container inside
  // a shadow root would inherit the hidden host in every shot (A equals B whatever it shows): refused (openers are found by
  // document.querySelectorAll today, so none is in a shadow root — a guard for a later lookup)
  if ((box.getRootNode?.()?.host ?? null) !== null) return { ctl: "its sole control", keep: 0, why: "the opener lies inside a shadow root, where its pixels cannot be compared", scrolled: false };
  const up = (n: DElement): DElement | null => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
  // Chromium blurs a focused element once it is hidden: ownClear focuses it again (inside the container); one outside stays shown
  const active = document.activeElement;
  if (active && active !== document.body) o.focus = active;
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  const r0 = box.getBoundingClientRect();
  if (r0.x < 0 || r0.y < 0 || r0.right > vw || r0.bottom > vh) {
    const boxes: DriveScroll["boxes"] = [];
    for (let p = box.parentElement; p; p = p.parentElement) boxes.push({ el: p, left: p.scrollLeft, top: p.scrollTop });
    o.saved = { x: scrollX, y: scrollY, boxes };
    box.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }
  const css = (e: DElement, prop: string): string => getComputedStyle(e).getPropertyValue(prop).trim();
  const px = (v: string): number => parseFloat(v) || 0;
  const b = box.getBoundingClientRect(), c = ctl.getBoundingClientRect();
  // the container's padding box: what a child covering it all hides of the container's own background
  const x0 = b.x + px(css(box, "border-left-width")), y0 = b.y + px(css(box, "border-top-width"));
  const x1 = b.right - px(css(box, "border-right-width")), y1 = b.bottom - px(css(box, "border-bottom-width"));
  // D53's CSS pre-filter (review 8 H-1): never a replaced or form element, a clip-path, a background clipped to its content box
  // (or to text), a list item (its marker) or a shadow host
  const plainBox = (e: DElement): boolean => !/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|FRAME|FENCEDFRAME|PROGRESS|METER|INPUT|SELECT|TEXTAREA)$/.test(e.tagName.toUpperCase())
    && (css(e, "clip-path") === "" || css(e, "clip-path") === "none")
    && css(e, "background-clip").split(",").every((v) => /^(border-box|padding-box)$/.test(v.trim()))
    && !/list-item/.test(css(e, "display")) && !e.shadowRoot;
  // only a background colour: no image, mask, border, shadow, outline or filter of its own
  const plainFill = (e: DElement): boolean => ["background-image", "mask-image", "box-shadow", "filter", "backdrop-filter"].every((k) => { const v = css(e, k); return v === "" || v === "none"; })
    && ["top", "right", "bottom", "left"].every((side) => px(css(e, `border-${side}-width`)) === 0 || css(e, `border-${side}-style`) === "none")
    && (px(css(e, "outline-width")) === 0 || css(e, "outline-style") === "none");
  box.setAttribute("data-dt-own", "");
  ctl.setAttribute("data-dt-own-ctl", "");
  // D54(c): the container's ancestors in the flat tree [data-dt-own-up] — hidden in every shot like the rest of the outside (the
  // container is shown again by its own rule), their filters / clip-paths / masks off in K and N; the focused element outside the
  // container [data-dt-own-foc] stays shown on its own (hiding it would blur it: Chromium keeps the focus of an element shown
  // under hidden ancestors — by experiment, no blur / focusout)
  for (let p = up(box); p; p = up(p)) p.setAttribute("data-dt-own-up", "");
  if (active && active !== document.body && !box.contains(active)) active.setAttribute("data-dt-own-foc", "");
  // D53 (review 8 H-2): every open shadow root inside the container (the container itself as a host too), and whether its host
  // is the control or inside it (shot A hides those)
  const roots: Array<{ root: DShadow; inCtl: boolean }> = [];
  const els: Array<{ e: DElement; inCtl: boolean }> = [];
  const todo: Array<{ e: DElement; inCtl: boolean }> = [{ e: box, inCtl: false }];
  for (let t = todo.pop(); t; t = todo.pop()) {
    if (els.length >= 20_000) { o.roots = roots; return { ctl: "", keep: 0, why: "more than 20000 boxes to hide", scrolled: !!o.saved }; }
    const inCtl = t.inCtl || t.e === ctl;
    if (t.e !== box) els.push({ e: t.e, inCtl });
    const sr = t.e.shadowRoot;
    if (sr) { roots.push({ root: sr, inCtl }); for (const k of Array.from(sr.children)) todo.push({ e: k, inCtl }); }
    for (const k of Array.from(t.e.children)) todo.push({ e: k, inCtl });
  }
  o.roots = roots;
  o.els = els;
  const all = Array.from(box.querySelectorAll("*"));
  let keep = 0;
  // bounded: past 2000 descendants nothing more is kept (more counts as content — the safe side)
  for (let i = 0; i < all.length && i < 2000; i++) {
    const e = all[i];
    if (!e || e === ctl || ctl.contains(e) || css(e, "visibility") !== "visible" || !plainBox(e)) continue;
    const r = e.getBoundingClientRect();
    const hugs = e.contains(ctl) && r.x >= c.x - 8 && r.y >= c.y - 8 && r.right <= c.right + 8 && r.bottom <= c.bottom + 8;
    const covers = r.x <= x0 + 1 && r.y <= y0 + 1 && r.right >= x1 - 1 && r.bottom >= y1 - 1 && plainFill(e);
    if (hugs || covers) { e.setAttribute("data-dt-own-keep", ""); keep++; }
  }
  const label = ctl.getAttribute("aria-label");
  return { ctl: `<${ctl.tagName.toLowerCase()}${ctl.getAttribute("type") ? ` type="${ctl.getAttribute("type") ?? ""}"` : ""}${ctl.getAttribute("role") ? ` role="${ctl.getAttribute("role") ?? ""}"` : ""}${label ? ` aria-label="${label}"` : ""}>`, keep, why: null, scrolled: !!o.saved };
}
/** A rounded rect (viewport CSS px) with its corner radii [top-left x, y, top-right x, y, bottom-right x, y, bottom-left x, y],
 *  already scaled down as CSS does when adjacent radii overlap (CSS Backgrounds 3 §5.5). */
export interface KeptShape { x: number; y: number; right: number; bottom: number; r: number[] }
/** A kept box as the plain-paint test reads it (viewport CSS px): its border box, whether it paints a background colour, and
 *  the shapes that bound what it paints — its own rounded border box, then the rounded padding box of every box from its parent
 *  up to the container that clips (overflow not visible) — review 9 H-1. */
export interface KeptRect { x: number; y: number; right: number; bottom: number; filled: boolean; shapes: KeptShape[] }
/** D52 / D53, in the page: put up a shot's rules and say where the container is on screen (clipped to the layout viewport).
 *  A: only the control hidden. B: all the container's content hidden (the kept boxes stay). K: the container itself hidden too
 *  (only the kept boxes paint). N: nothing of it painted. In every shot what lies outside the container's subtree is hidden
 *  ([data-dt-own-up] stays). The :is() with an id that never matches lifts the rules over a page's own !important ones of lower
 *  specificity. `why`: nothing of it on screen, or a rule that did not take (a page's inline / layered !important). K also
 *  returns the kept boxes' rects. SELF-CONTAINED. */
export function ownShot(arg: { shot: "A" | "B" | "K" | "N" }): { clip: { x: number; y: number; width: number; height: number } | null; why: string | null; keep: KeptRect[] } {
  const o = window.__dtOwn;
  const no = (why: string): { clip: null; why: string; keep: KeptRect[] } => ({ clip: null, why, keep: [] });
  if (!o) return no("the probe lost the opener it compares");
  const hi = "#dt-own-0#dt-own-0#dt-own-0";
  const lift = (sel: string): string => `:is(${sel}, ${hi})`;
  const H = "{ visibility: hidden !important; transition: none !important; }";
  const pseudos = (sel: string): string => [sel, `${sel}::before`, `${sel}::after`].join(", ");
  // review 9 L-1: the pseudo-elements beyond ::before / ::after that a page may force visible inside the container — hidden each by
  // its own rule (an unknown one would void a whole list); Chromium 153 hides all of them by visibility (by experiment; MDN lists
  // no visibility for ::placeholder, so it also gets a transparent colour, which MDN allows). ::first-letter is only CHECKED (in
  // the "rules took" loop below), never given a rule: a ::first-letter rule rebuilds the page's text boxes, and the element under
  // the parked pointer then gets mouseout / mouseleave (by experiment) — a page side effect; its text is the DOM rule's anyway
  const EXTRA_PSEUDOS = ["::placeholder", "::file-selector-button", "::details-content", "::scroll-button(*)", "::scroll-marker", "::scroll-marker-group"];
  const extra = (sel: string): string => EXTRA_PSEUDOS.map((ps) => `${sel}${ps} { visibility: hidden !important; transition: none !important;${ps === "::placeholder" ? " color: transparent !important;" : ""} }`).join("\n");
  // D53 (review 8 M-2) + D54(c): everything outside the container's subtree hidden, its ancestors too (their own paint never
  // decides — review 9 M-1), and their backgrounds off (the root's would still paint the canvas); the container shown again (its
  // content inherits what it had: the page's own hidden stays hidden); the focused element outside it stays shown
  // review 9 L-3 / fix 10: the container's light descendants [data-dt-own-in] and the control's [data-dt-own-cin] are MARKED
  // (again at every shot: what the page mounted since counts) — compound attribute selectors cost the page's style recalc O(1)
  // per element, where `[data-dt-own] *` inside :is() / :not() walked every element's ancestors (an 8000-deep chain elsewhere on
  // the page: seconds per shot)
  // review 10 H-1: an element the page mounted in the container since the last shot's marks (a re-render inside the screenshot's
  // own frame — Page.captureScreenshot runs rAF callbacks) was hidden as "outside" in that shot, so the shots compared different
  // content: refuse — checked before B / K / N re-mark (one mounted during shot B is hidden in B either way, as outside or as
  // content, and K / N check again). Not inside the control: what it holds is hidden in every shot anyway (a hover icon swapped
  // once the pointer is parked changes nothing)
  if (arg.shot !== "A" && Array.from(o.box.querySelectorAll(":not([data-dt-own-in])")).some((e) => !o.ctl.contains(e))) return no("the opener's content changed while it was compared (an element mounted in it during the screenshots)");
  for (const e of Array.from(o.box.querySelectorAll("*"))) if (!e.hasAttribute("data-dt-own-in")) e.setAttribute("data-dt-own-in", "");
  for (const e of Array.from(o.ctl.querySelectorAll("*"))) if (!e.hasAttribute("data-dt-own-cin")) e.setAttribute("data-dt-own-cin", "");
  const notOwn = lift(":not([data-dt-own], [data-dt-own-in], [data-dt-own-foc])");
  const own = lift("[data-dt-own]");
  const inner = lift("[data-dt-own-in]");
  const foc = lift("[data-dt-own-foc]");
  const SHOW = "{ visibility: visible !important; transition: none !important; }";
  // review 10 M-2: the extra pseudo-element rules are NOT put on the outside — on "every element outside" they made the browser
  // resolve those pseudo-elements for the whole page in every shot (4× slower per pair on a 75k-element page); outside, they
  // inherit the hidden visibility, and one a page forces visible paints the same in every shot (it never decides A against B)
  const outside = [`${pseudos(notOwn)} ${H}`, `${foc} ${SHOW}`, `${foc}::before, ${foc}::after ${H}`, extra(foc),
    `${lift("[data-dt-own-up]")} { background: none !important; }`].join("\n");
  const shown = `${own} ${SHOW}`;
  const content = [`${[inner, `${own}::before`, `${own}::after`, `${inner}::before`, `${inner}::after`].join(", ")} ${H}`, extra(inner), extra(own)].join("\n");
  const kept = `:is([data-dt-own-keep], ${hi}#dt-own-0) { visibility: visible !important; transition: none !important; }`;
  // D54(c) (review 9 H-2): in K and N a filter (a drop-shadow list, a blur), clip-path or mask on the container or an ancestor is
  // off — the kept boxes alone are judged, not what an ancestor's effect makes of them (no layout change: what a filter makes a
  // containing block for — fixed boxes — is hidden in K and N)
  const flat = `${lift(":is([data-dt-own-up], [data-dt-own])")} { filter: none !important; clip-path: none !important; mask: none !important; backdrop-filter: none !important; }`;
  const ctl = lift("[data-dt-own-ctl]"), ctlIn = lift("[data-dt-own-cin]");
  const text = arg.shot === "A" ? `${outside}\n${shown}\n${[ctl, ctlIn].map(pseudos).join(", ")} ${H}\n${extra(ctl)}\n${extra(ctlIn)}`
    // review 8 M-3: the container's own ::marker (its colour: no layout change; a marker image stays and counts)
    : arg.shot === "B" ? `${outside}\n${shown}\n${content}\n${own}::marker { color: transparent !important; }\n${kept}`
    : arg.shot === "K" ? `${outside}\n${content}\n${own} ${H}\n${kept}\n${flat}`
    : `${outside}\n${content}\n${own} ${H}\n${flat}`;
  // constructed sheets: a page's CSP (style-src without 'unsafe-inline') blocks an injected <style>, not CSSOM
  if (!o.sheet) { o.sheet = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, o.sheet]; }
  o.sheet.replaceSync(text);
  // D53 (review 8 H-2): every open shadow root inside the container hides all it holds in B / K / N; in A only those of the control
  const roots = o.roots ?? [];
  if (roots.length && !o.rootSheet) { o.rootSheet = new CSSStyleSheet(); o.rootSheet.replaceSync(`${pseudos(lift("*"))} ${H}`); }
  const rootSheet = o.rootSheet;
  for (const { root, inCtl } of roots) {
    if (!rootSheet) break;
    const rest = root.adoptedStyleSheets.filter((x) => x !== rootSheet);
    root.adoptedStyleSheets = arg.shot !== "A" || inCtl ? [...rest, rootSheet] : rest;
  }
  // the rules took (nothing of the page's beat them). Review 8 M-1: a control the page took out (unmounted, or no box, once the
  // pointer left) is hidden — by the page. Review 8 L-2: every element the shot hides is checked, and its ::before / ::after when
  // they have content — a page's inline !important, or an !important inside a cascade layer (which beats any unlayered one,
  // whatever its specificity), refuses instead of showing in both shots
  const vis = (e: DElement, pseudo: string | null = null): string => getComputedStyle(e, pseudo).getPropertyValue("visibility");
  const name = (e: DElement): string => `<${e.tagName.toLowerCase()}>`;
  const beat = "against the probe's hiding rule (an inline or cascade-layer !important)";
  if (o.ctl.isConnected && o.ctl.getClientRects().length > 0 && vis(o.ctl) !== "hidden") return no(`the page kept its control showing ${beat}`);
  if (arg.shot !== "A" && vis(o.box, "::before") !== "hidden") return no(`the page kept the opener's own ::before showing ${beat}`);
  if (arg.shot !== "A" && vis(o.box, "::after") !== "hidden") return no(`the page kept the opener's own ::after showing ${beat}`);
  if ((arg.shot === "K" || arg.shot === "N") && vis(o.box) !== "hidden") return no(`the page kept the opener showing ${beat}`);
  // review 9 L-1: the other pseudo-elements, where they can exist (a first letter of a box's own text, a field's placeholder, a
  // file input's button, a <details>' content, a scroll container's buttons, a scroll marker and its group)
  const st = (e: DElement, prop: string, pseudo: string | null = null): string => getComputedStyle(e, pseudo).getPropertyValue(prop).trim();
  const generated = (e: DElement, ps: string): boolean => !/^(none|normal)?$/.test(st(e, "content", ps));
  const others = (e: DElement): string[] => ["::first-letter", ...EXTRA_PSEUDOS].filter((ps) => ps === "::first-letter" ? Array.from(e.childNodes).some((t) => t.nodeType === 3 && /\S/.test(t.nodeValue ?? ""))
    : ps === "::placeholder" ? /^(INPUT|TEXTAREA)$/.test(e.tagName.toUpperCase()) && e.hasAttribute("placeholder")
    : ps === "::file-selector-button" ? e.tagName.toUpperCase() === "INPUT" && (e.getAttribute("type") ?? "").toLowerCase() === "file"
    : ps === "::details-content" ? e.tagName.toUpperCase() === "DETAILS"
    : ps === "::scroll-marker-group" ? !/^(none)?$/.test(st(e, "scroll-marker-group"))
    : generated(e, ps));
  if (arg.shot !== "A") for (const ps of others(o.box)) if (vis(o.box, ps) !== "hidden") return no(`the page kept the opener's own ${ps} showing ${beat}`);
  for (const { e, inCtl } of o.els ?? []) {
    if (!e.isConnected || (arg.shot === "A" && !inCtl) || (arg.shot !== "A" && arg.shot !== "N" && e.hasAttribute("data-dt-own-keep"))) continue;
    if (vis(e) !== "hidden") return no(`the page kept ${name(e)} inside the opener showing ${beat}`);
    for (const ps of ["::before", "::after"]) {
      const c = getComputedStyle(e, ps).getPropertyValue("content");
      if (c !== "none" && c !== "normal" && vis(e, ps) !== "hidden") return no(`the page kept a ${ps} inside the opener showing ${beat}`);
    }
    for (const ps of others(e)) if (vis(e, ps) !== "hidden") return no(`the page kept a ${ps} inside the opener showing ${beat}`);
  }
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  const r = o.box.getBoundingClientRect();
  const cx0 = Math.max(0, Math.floor(r.x)), cy0 = Math.max(0, Math.floor(r.y)), cx1 = Math.min(vw, Math.ceil(r.right)), cy1 = Math.min(vh, Math.ceil(r.bottom));
  if (cx1 - cx0 < 1 || cy1 - cy0 < 1) return no("nothing of the opener is on screen to compare");
  const keep: KeptRect[] = [];
  if (arg.shot === "K") {
    // review 9 H-1: each kept box's real rounded shape — its own corner radii (elliptical: "50%" is half the width across and
    // half the height down), and the rounded padding box of every box up to the container that clips it (overflow not visible;
    // in K the container's and its ancestors' clip-paths are off)
    const len = (t: string, size: number): number => (t.endsWith("%") ? ((parseFloat(t) || 0) / 100) * size : parseFloat(t) || 0);
    const shape = (p: DElement, inner: boolean): KeptShape => {
      const pr = p.getBoundingClientRect();
      const w = pr.width, h = pr.height;
      const r: number[] = [];
      for (const k of ["top-left", "top-right", "bottom-right", "bottom-left"]) { const v = st(p, `border-${k}-radius`).split(/\s+/); r.push(len(v[0] ?? "0", w), len(v[1] ?? v[0] ?? "0", h)); }
      const f = Math.min(1, ...[[0, 2, w], [6, 4, w], [1, 7, h], [3, 5, h]].map(([i = 0, j = 0, side = 0]) => { const sum = (r[i] ?? 0) + (r[j] ?? 0); return sum > 0 ? side / sum : 1; }));
      const sc = r.map((v) => v * f);
      if (!inner) return { x: pr.x, y: pr.y, right: pr.right, bottom: pr.bottom, r: sc };
      const bt = parseFloat(st(p, "border-top-width")) || 0, brw = parseFloat(st(p, "border-right-width")) || 0, bb = parseFloat(st(p, "border-bottom-width")) || 0, bl = parseFloat(st(p, "border-left-width")) || 0;
      const cut = [bl, bt, brw, bt, brw, bb, bl, bb];
      return { x: pr.x + bl, y: pr.y + bt, right: pr.right - brw, bottom: pr.bottom - bb, r: sc.map((v, i) => Math.max(0, v - (cut[i] ?? 0))) };
    };
    for (const e of Array.from(document.querySelectorAll("[data-dt-own-keep]"))) {
      const q = e.getBoundingClientRect();
      const shapes: KeptShape[] = [shape(e, false)];
      for (let p: DElement | null = e === o.box ? null : e.parentElement; p; p = p === o.box ? null : p.parentElement) {
        if (st(p, "overflow-x") !== "visible" || st(p, "overflow-y") !== "visible") shapes.push(shape(p, true));
      }
      const bg = st(e, "background-color");
      const filled = !(bg === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(bg));
      keep.push({ x: q.x, y: q.y, right: q.right, bottom: q.bottom, filled, shapes });
    }
  }
  return { clip: { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 }, why: null, keep };
}
/** Review 10 L-5, in the page: why clickPointControl's DOM rule refused a container's sole control (null: it did not). SELF-CONTAINED. */
export function ownWhy(_arg: null): string | null {
  return window.__dtOwnWhy ?? null;
}
/** D56 (review 11 H-1), in the page: before the probe first hovers (or presses anything) on this page, remember every
 *  [role=tooltip] element and every element with an id that is ALREADY shown — not display:none, not at opacity 0 (itself or an
 *  ancestor), and visible (or holding a visible descendant: a visibility:hidden wrapper around a visible label counts as shown).
 *  ownContent's foreign walk exempts as the sole control's tooltip only one NOT remembered: a tooltip the probe's own hover (or
 *  focus) revealed. A label that was on screen before is the card's own and still refuses. Kept in a WeakSet on window, not as an
 *  attribute: a page that patches attributes (morphdom-style) could strip a mark and turn it into an exemption, and a page's
 *  MutationObserver never sees it. Once per page document (a reload starts over at the next call); no set (never run, or past
 *  500,000 elements) = no tooltip is exempt. SELF-CONTAINED. */
export function tipPreMark(_arg: null): boolean {
  if (window.__dtTipPre) return false;
  const pre = new WeakSet<DElement>();
  const vis = (e: DElement): boolean => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const todo: DElement[] = [document.documentElement];
  let n = 0;
  for (let e = todo.pop(); e; e = todo.pop()) {
    if (++n > 500_000) { window.__dtTipPre = null; return false; }
    for (const k of Array.from(e.children)) todo.push(k);
    const sr = e.shadowRoot;
    if (sr) for (const k of Array.from(sr.children)) todo.push(k);
    if ((e.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() !== "tooltip" && !e.getAttribute("id")) continue;
    if (!e.checkVisibility({ opacityProperty: true })) continue;
    if (vis(e)) { pre.add(e); continue; }
    const d = e.querySelectorAll("*");
    if (d.length > 2000 || Array.from(d).some(vis)) pre.add(e);
  }
  window.__dtTipPre = pre;
  return true;
}
/** D52, in the page: remove the probe's sheets and every marker, put back the scroll ownMark changed (instant), focus again what
 *  was focused, forget the pair. Always run (try/finally). SELF-CONTAINED. */
export function ownClear(_arg: null): boolean {
  const o = window.__dtOwn;
  if (o && o.sheet) { const sheet = o.sheet; document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet); }
  if (o && o.rootSheet && o.roots) { const sheet = o.rootSheet; for (const { root } of o.roots) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((x) => x !== sheet); }
  for (const e of Array.from(document.querySelectorAll("[data-dt-own], [data-dt-own-ctl], [data-dt-own-keep], [data-dt-own-up], [data-dt-own-foc], [data-dt-own-in], [data-dt-own-cin]"))) {
    e.removeAttribute("data-dt-own-foc");
    e.removeAttribute("data-dt-own-in");
    e.removeAttribute("data-dt-own-cin");
    e.removeAttribute("data-dt-own");
    e.removeAttribute("data-dt-own-ctl");
    e.removeAttribute("data-dt-own-keep");
    e.removeAttribute("data-dt-own-up");
  }
  if (o && o.saved) {
    for (const b of o.saved.boxes) if (b.el.scrollLeft !== b.left || b.el.scrollTop !== b.top) b.el.scrollTo({ left: b.left, top: b.top, behavior: "instant" });
    scrollTo({ left: o.saved.x, top: o.saved.y, behavior: "instant" });
  }
  if (o && o.focus && o.focus.isConnected && document.activeElement !== o.focus) o.focus.focus({ preventScroll: true });
  window.__dtOwn = null;
  return true;
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

/** 12b review 3 L-2 (D40(8)): the drive clicks the opener where Playwright does (as submitGuard finds the point). When that point
 *  is an ACTIVATING control inside the opener — button-like (a role=button without tabindex too), a checkbox / radio / switch /
 *  option, a file / submit / reset input, a <label>'s control, a nested browsing context (<iframe> / <frame> / <object> /
 *  <embed> / <fencedframe>), also inside an open shadow root (review 5 H-1), also under a focusable glyph or editable label inside
 *  it (review 6 H-2) — that is not the opener's own control, the click would press that control (a card's centred Delete),
 *  and the drive has no write block: its description, so the row is not driven. The opener's own control is D47's, narrowed by D51: a container's
 *  ONLY focusable, button-like, under its centre (a cell around its icon button), and the container shows nothing of its own
 *  outside it — the same rule the behaviour battery presses keys on (probe-behaviour.ts markOpener); D52: by its DOM here and by
 *  its pixels after ({ mark: true } leaves the pair in window.__dtOwn for ownPixels; driveRow hovers the opener first, so a
 *  control shown only on :hover is at the point — review 7 H-1). An opener that is itself
 *  focusable (a role=button tabindex=0 card, an <a href> card) has no such inner control: an activating control at its point is
 *  refused (review 4 H-1). A text field there (a picker's readonly input) is clicked as before. null = nothing in the way.
 *  SELF-CONTAINED. */
export function clickPointControl(el: DElement, arg?: { mark: boolean }): string | null {
  // D52: the drive asks for the pair its pixel check compares (ownPixels) — left in window.__dtOwn only on the D47 exemption
  const mark = !!arg && arg.mark;
  if (mark) { window.__dtOwn = null; window.__dtOwnWhy = null; }
  const FOC = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  const BTN = "button, a[href], summary, [role=button i], [role=link i], [role=menuitem i], [role=tab i]";
  const ACT = `${BTN}, [role=checkbox i], [role=switch i], [role=radio i], [role=option i], [role=menuitemcheckbox i], [role=menuitemradio i], input[type=checkbox i], input[type=radio i], input[type=submit i], input[type=button i], input[type=image i], input[type=reset i], input[type=file i]`;
  // review 4 H-1: a focusable opener is never exempt — its inner control at the point is another control, not its own
  const self = el.matches(FOC);
  // D51 — the same check as markOpener's in probe-behaviour.ts (keep the two in step: test/verify-probe.test.ts runs both on the
  // same fake DOMs, the e2e tests on real pages): what the container shows of its OWN outside its one control, walked through the
  // flat tree (open shadow roots and their slots) with an explicit stack, each ancestor test memoised per element (review 6 L-1:
  // an 8000-deep DOM is linear work, never a stack overflow). An element is SHOWN when the nearest box at or above it (a
  // display:contents wrapper has none) passes checkVisibility with visibility and content-visibility (hidden, and auto while
  // skipped), it is not visibility:hidden itself, and no OUT-OF-FLOW box (position absolute / fixed) from that box up to the
  // container has opacity 0 — a hover tooltip or popover shows nothing; an in-flow opacity-0 box keeps its place and is about to
  // show (a reveal-on-scroll or staggered entrance: the drive has just scrolled it in), so it counts (review 6 H-1). The
  // container's own opacity is the opener's visibility, judged before this. An AREA counts after the clipping on the element's
  // containing-block chain up to the container (CSS 2.1 §11.1.1; review 6 H-3): each box's overflow on that axis — an absolute
  // box skips the static ancestors that make no containing block, a fixed one every ancestor without a transform / translate /
  // rotate / scale / perspective / filter / backdrop-filter / preserve-3d / will-change of those / contain layout|paint|strict|
  // content / content-visibility auto|hidden — and, on every ancestor, a clip-path inset() and an absolute box's clip rect()
  // (another clip-path shape is not read: what it covers counts), overflow:clip on both axes widened by its overflow-clip-margin
  // (review 7 L-2); what lies past the document's top edge, or its left edge in a left-to-right document (an sr-only label at
  // left:-9999px), is never on screen nor scrolled to (review 6 L-2) — that edge moved out by the scroll of the container and
  // every box above it (review 7 L-1: an app shell's scroller reaches what lies above its top). SHOWN CONTENT:
  // a non-blank text node whose clipped Range rects cover more than 1 px² (an sr-only label — 1 × 1 px overflow:hidden, clip
  // rect(0,0,0,0), clip-path inset(50%), off the document's start edge — and whitespace show nothing); an img / svg / canvas /
  // video / audio / picture / object / embed / iframe / input / progress / meter (review 8 H-1) with a clipped box over 1 px²; a list
  // item's marker — a list-style type or image, or ::marker content (the container's own too: review 8 M-3); a ::before / ::after (not display:none, not
  // hidden, not an out-of-flow opacity 0) whose content is not none / normal and that paints — a non-blank string (an icon font's
  // glyph, a generated label), an image, counter or attr(), a background-image or mask-image under any content, "" included (a
  // CSS logo or icon), a background colour under a blank string, or under "" unless its element holds the control or lies over
  // the control's centre — with its element's clipped box over 1 px²; on a DESCENDANT with a clipped box over 1 px²: a
  // background-image (an avatar, a logo), a mask-image (a CSS-mask icon) unless it holds the control, a non-transparent
  // background colour (a swatch, a status dot: D51's "other visible content") unless it holds the control or lies over the
  // control's centre (a filled wrapper, a hover tint: the cell's own chrome). The container's own background colour, a border in
  // one colour (a 1-px divider on one side too) and padding are decoration, as is a clearfix's empty content — D54(a): its own
  // background image (a gradient, a url), border image, border sides in different colours or widths 2 px or more apart (a stripe)
  // are content; D55 (review 10 M-3): so are its own inset box-shadow offset 2 px or more or blurred, sharp box-shadow rings in
  // more than one colour (its border's included), and its own paint under a mask or a clip-path other than a rounded inset(0).
  // Review 9 L-1: a scroll container's ::scroll-button (focusable, pressed like a button) and a scroll-marker group
  // are a second control: content. D54(b): a label laid over the container from outside its subtree (see the walk at the end).
  // Not seen: a closed shadow root, the inside of an iframe
  // (the iframe itself counts). Bounded (review 7 L-4): past 20000 steps (elements walked, ancestor steps of the areas) it
  // answers "content". null = nothing of its own as far as the DOM shows — D52: the caller's pixel check (probe-drive.ts
  // ownPixels) has the last word, content when EITHER says so; else what shows.
  const ownContent = (box: DElement, ctl: DElement): string | null => {
    const up = (n: DElement): DElement | null => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
    const css = (e: DElement, prop: string, pseudo: string | null = null): string => getComputedStyle(e, pseudo).getPropertyValue(prop).trim();
    const set = (e: DElement, prop: string, pseudo: string | null = null): boolean => { const v = css(e, prop, pseudo); return v !== "" && v !== "none"; };
    // does `test` hold for the element or an ancestor below the container? memoised per element (review 6 L-1)
    const chain = (test: (p: DElement) => boolean): ((e: DElement | null) => boolean) => {
      const memo = new Map<DElement, boolean>();
      return (e: DElement | null): boolean => {
        const seen: DElement[] = [];
        let hit = false;
        for (let p = e; p && p !== box; p = up(p)) {
          const m = memo.get(p);
          if (m !== undefined) { hit = m; break; }
          seen.push(p);
          if (test(p)) { hit = true; break; }
        }
        for (const s of seen) memo.set(s, hit);
        return hit;
      };
    };
    // review 7 L-4: bounded — every element walked and every ancestor step of an area counts; past OWN_WORK_CAP the check answers
    // "content" (the control is not the opener's: the safe side) instead of spending seconds on a huge or deep container
    let work = 0;
    const OWN_WORK_CAP = 20_000;
    const tick = (): boolean => ++work > OWN_WORK_CAP;
    const inCtl = chain((p) => p === ctl);
    const outOfFlow = (e: DElement, pseudo: string | null = null): boolean => /^(absolute|fixed)$/.test(css(e, "position", pseudo));
    const faded = chain((p) => css(p, "opacity") === "0" && outOfFlow(p));
    const boxed = (e: DElement): DElement | null => { let p: DElement | null = e; while (p && css(p, "display") === "contents") p = up(p); return p; };
    const shown = (e: DElement): boolean => {
      const b = boxed(e);
      return !!b && b.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && !/^(hidden|collapse)$/.test(css(e, "visibility")) && !faded(b);
    };
    // a containing block for fixed (and absolute) descendants
    const holdsFixed = (p: DElement): boolean => ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => set(p, k))
      || css(p, "transform-style") === "preserve-3d" || /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(css(p, "will-change"))
      || /\b(layout|paint|strict|content)\b/.test(css(p, "contain")) || /^(auto|hidden)$/.test(css(p, "content-visibility"));
    const de = document.documentElement;
    const horizontal = !/^(vertical|sideways)/.test(css(de, "writing-mode"));
    // review 7 L-1: the start edge moves out by the scroll of the container and every box above it — in an app shell (a fixed
    // inset:0 scroller) what lies above the shell's top is reached by scrolling the shell, not the window
    let sx = scrollX, sy = scrollY;
    for (let p: DElement | null = box; p && p !== de; p = up(p)) { sx += Math.abs(p.scrollLeft || 0); sy += Math.abs(p.scrollTop || 0); }
    const startX = horizontal && css(de, "direction") !== "rtl" ? -sx : -Infinity, startY = horizontal ? -sy : -Infinity;
    // the part of q (a box or text rect of e) left after that clipping (null: out of work — the caller answers "content")
    const clipped = (e: DElement, q: DRect): { x0: number; y0: number; x1: number; y1: number } | null => {
      let x0 = Math.max(q.x, startX), y0 = Math.max(q.y, startY), x1 = q.right, y1 = q.bottom;
      let flow: "in" | "absolute" | "fixed" = "in";
      for (let p: DElement | null = e; p; p = p === box ? null : up(p)) {
        if (tick()) return null;
        if (css(p, "display") === "contents") continue;
        const pr = p.getBoundingClientRect();
        const pos = css(p, "position");
        // not on the containing-block chain: its overflow does not clip what escapes it
        const skip = p !== e && (flow === "fixed" ? !holdsFixed(p) : flow === "absolute" && !/^(relative|absolute|fixed|sticky)$/.test(pos) && !holdsFixed(p));
        if (!skip) {
          const ox = css(p, "overflow-x"), oy = css(p, "overflow-y");
          // review 7 L-2: overflow:clip on both axes paints overflow-clip-margin past the box (from the border box here: an upper bound)
          const cm = ox === "clip" && oy === "clip" ? parseFloat(/(-?[\d.]+)px/.exec(css(p, "overflow-clip-margin"))?.[1] ?? "0") || 0 : 0;
          if (ox !== "visible") { x0 = Math.max(x0, pr.x - cm); x1 = Math.min(x1, pr.right + cm); }
          if (oy !== "visible") { y0 = Math.max(y0, pr.y - cm); y1 = Math.min(y1, pr.bottom + cm); }
          flow = pos === "fixed" ? "fixed" : pos === "absolute" ? "absolute" : "in";
        }
        const ins = /^inset\((.*)\)$/.exec(css(p, "clip-path"));
        if (ins) {
          const [t = "0", r = t, b = t, l = r] = (ins[1] ?? "").split(/\s+round\s+/)[0]?.trim().split(/\s+/) ?? [];
          const len = (s: string, size: number): number => (s.endsWith("%") ? (parseFloat(s) / 100) * size : parseFloat(s));
          const T = len(t, pr.height), R = len(r, pr.width), B = len(b, pr.height), L = len(l, pr.width);
          if (![T, R, B, L].some(Number.isNaN)) { x0 = Math.max(x0, pr.x + L); x1 = Math.min(x1, pr.right - R); y0 = Math.max(y0, pr.y + T); y1 = Math.min(y1, pr.bottom - B); }
        }
        const rc = /^rect\((.*)\)$/.exec(css(p, "clip"));
        if (rc && /^(absolute|fixed)$/.test(pos)) {
          const v = (rc[1] ?? "").split(/[\s,]+/).filter(Boolean);
          const at = (s: string | undefined, auto: number): number => (s === undefined || s === "auto" ? auto : parseFloat(s));
          const T = at(v[0], 0), R = at(v[1], pr.width), B = at(v[2], pr.height), L = at(v[3], 0);
          if (v.length === 4 && ![T, R, B, L].some(Number.isNaN)) { x0 = Math.max(x0, pr.x + L); x1 = Math.min(x1, pr.x + R); y0 = Math.max(y0, pr.y + T); y1 = Math.min(y1, pr.y + B); }
        }
      }
      return { x0, y0, x1, y1 };
    };
    const area = (e: DElement, q: DRect): number => { const c = clipped(e, q); return c ? Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0) : Infinity; };
    const els: DElement[] = [];
    const texts: Array<{ t: DNode; e: DElement }> = [];
    // review 6 L-1: an explicit stack, the same order as the recursion it replaces (an element, its text, its shadow root's
    // text and elements, then its light children)
    const todo: DElement[] = [box];
    for (let e = todo.pop(); e; e = todo.pop()) {
      if (tick()) return `more than ${OWN_WORK_CAP} boxes to check`;
      els.push(e);
      for (const t of Array.from(e.childNodes)) if (t.nodeType === 3) texts.push({ t, e });
      const sr = e.shadowRoot;
      let kids = Array.from(e.children);
      if (sr) {
        for (const t of Array.from(sr.childNodes)) if (t.nodeType === 3) texts.push({ t, e });
        kids = Array.from(sr.children).concat(kids);
      }
      for (let i = kids.length - 1; i >= 0; i--) { const k = kids[i]; if (k) todo.push(k); }
    }
    // the cell's own chrome: a box holding the control, or over its centre (a filled wrapper, a hover tint)
    const cr = ctl.getBoundingClientRect(), mx = cr.x + cr.width / 2, my = cr.y + cr.height / 2;
    const chrome = (e: DElement): boolean => { if (e.contains(ctl)) return true; const r = e.getBoundingClientRect(); return mx >= r.x && mx <= r.right && my >= r.y && my <= r.bottom; };
    const clear = (v: string): boolean => v === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(v);
    for (const e of els) {
      if (inCtl(e) || !shown(e)) continue;
      if (/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|INPUT|PROGRESS|METER)$/.test(e.tagName.toUpperCase()) && area(e, e.getBoundingClientRect()) > 1) return `<${e.tagName.toLowerCase()}>`;
      const host = boxed(e) ?? e;
      for (const ps of ["::before", "::after"]) {
        const c = css(e, "content", ps);
        if (!c || c === "none" || c === "normal" || css(e, "display", ps) === "none" || /^(hidden|collapse)$/.test(css(e, "visibility", ps)) || (css(e, "opacity", ps) === "0" && outOfFlow(e, ps))) continue;
        const str = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        const s = str ? str[1] ?? "" : null;
        const fill = !clear(css(e, "background-color", ps));
        const paints = s === null || /\S/.test(s) || set(e, "background-image", ps) || set(e, "mask-image", ps) || (fill && (s !== "" || !chrome(host)));
        if (paints && area(host, host.getBoundingClientRect()) > 1) return `${ps} content`;
      }
      // review 8 M-3: a list item's marker (the container's own too) — a list-style type or image, or a ::marker content
      if (/list-item/.test(css(e, "display")) && (!/^(none)?$/.test(css(e, "list-style-type")) || set(e, "list-style-image") || !/^(normal|none)?$/.test(css(e, "content", "::marker")))
        && area(e, e.getBoundingClientRect()) > 1) return "a list marker";
      // review 9 L-1: a scroll container's ::scroll-button (generated when its content is set — focusable and pressed like a
      // button: a second control) and a scroll-marker group (its markers are focusable too), the container's own included
      if ((!/^(visible|clip)$/.test(css(e, "overflow-x")) || !/^(visible|clip)$/.test(css(e, "overflow-y"))) && !/^(none|normal)?$/.test(css(e, "content", "::scroll-button(*)"))
        && area(e, e.getBoundingClientRect()) > 1) return "a scroll button";
      if (!/^(none)?$/.test(css(e, "scroll-marker-group")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll-marker group";
      if (e === box) {
        // D54(a): the container's OWN paint is decoration only when plain — a background image (a gradient, a url: a progress fill),
        // a border image, border sides in different colours or widths 2 px or more apart (a status stripe) are content; one colour
        // all round, or a 1-px divider on one side, stays decoration
        if (/\b(url|image|image-set|cross-fade|element|paint|[a-z-]*gradient)\(/i.test(css(e, "background-image"))) return "its own background image";
        if (set(e, "border-image-source")) return "its own border image";
        const sides = ["top", "right", "bottom", "left"].map((k) => ({ w: /^(none|hidden)$/.test(css(e, `border-${k}-style`)) ? 0 : parseFloat(css(e, `border-${k}-width`)) || 0, c: css(e, `border-${k}-color`) }));
        const painted = sides.filter((d) => d.w > 0 && !clear(d.c));
        if (new Set(painted.map((d) => d.c)).size > 1) return "its own border in more than one colour";
        const ws = sides.map((d) => (d.w > 0 && !clear(d.c) ? d.w : 0));
        if (painted.length > 0 && Math.max(...ws) - Math.min(...ws) >= 2) return "its own border stripe";
        // D55 (review 10 M-3): its own box-shadow and mask paint too — an inset layer offset 2 px or more (a stripe, a progress
        // fill) or blurred (an inner glow), sharp ring layers (blur 0) in more than one colour (D56: the ring layers only — not its
        // border; a layer in its own background colour where that cannot show — an outer one (a ring-offset), or an inset one over
        // its own opaque border-box / padding-box background (D57) — and a transparent one do not count), and a mask or a
        // clip-path other than a rounded inset(0) over its own paint (a progress band) are content; one sharp ring colour (a
        // focus / hover ring, a ring-inset frame, a Tailwind ring-offset + ring) stays decoration, as a uniform border does
        const layers: Array<{ c: string; n: number[]; inset: boolean }> = [];
        let depth = 0, cur = "";
        for (const ch of `${css(e, "box-shadow")},`) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch !== "," || depth > 0) { cur += ch; continue; }
          const n = Array.from(cur.matchAll(/(-?[\d.]+)px/g), (m) => parseFloat(m[1] ?? "0") || 0);
          const c = cur.replace(/-?[\d.]+px/g, "").replace(/\binset\b/, "").trim();
          if (n.length >= 2 && c !== "" && c !== "none" && !clear(c)) layers.push({ c, n, inset: /\binset\b/.test(cur) });
          cur = "";
        }
        if (layers.some((l) => l.inset && (Math.max(Math.abs(l.n[0] ?? 0), Math.abs(l.n[1] ?? 0)) >= 2 || (l.n[2] ?? 0) > 0))) return "its own inset box-shadow (a stripe, a fill or a glow)";
        const ownBg = css(e, "background-color");
        const rings = layers.filter((l) => !((l.n[2] ?? 0) > 0) && (l.n[0] !== 0 || l.n[1] !== 0 || (l.n[3] ?? 0) !== 0) && !(l.c === ownBg && (!l.inset || /^rgb\(/.test(ownBg) && /^(border|padding)-box$/.test(css(e, "background-clip")))));
        if (new Set(rings.map((l) => l.c)).size > 1) return "its own box-shadow ring in more than one colour";
        const paints = !clear(css(e, "background-color")) || painted.length > 0 || layers.length > 0;
        if (paints && set(e, "mask-image")) return "its own paint under a mask";
        const cp = css(e, "clip-path");
        if (paints && cp !== "" && cp !== "none" && !/^inset\(0(px)?( 0(px)?){0,3}( round .*)?\)$/.test(cp)) return "its own paint under a clip-path";
        continue;
      }
      if (css(e, "display") === "contents") continue;
      if (set(e, "background-image") && area(e, e.getBoundingClientRect()) > 1) return "a background image";
      if (set(e, "mask-image") && !e.contains(ctl) && area(e, e.getBoundingClientRect()) > 1) return "a mask image";
      if (!clear(css(e, "background-color")) && !chrome(e) && area(e, e.getBoundingClientRect()) > 1) return "a filled box";
    }
    for (const { t, e } of texts) {
      const text = (t.nodeValue || "").trim();
      if (!text || inCtl(e) || !shown(e)) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const q of Array.from(range.getClientRects())) if (area(e, q) > 1) return `text "${text.slice(0, 40)}"`;
    }
    // D54(b): a label laid over the container from OUTSIDE its subtree — a positioned sibling, an ancestor's ::before / ::after —
    // is its content too when it is in the page's flow or absolute (an element with a fixed or sticky box between it and the root
    // that does not also hold the container — a toast, a banner, a sticky header — is foreign, D4). Read: text (its clipped Range
    // rects; bare text in its open shadow root too), an img / svg / canvas / video / audio / picture / object / embed / iframe /
    // input / progress / meter, a background image, and a ::before / ::after that paints a label or an image (its box: the
    // element's, or for an absolute one its offsets in its containing block) — over the container when the part of it left after
    // clipping is over 1 px² and at least HALF of it lies inside the container's box, and it is not proven to lie under it
    // (proven: it is hit-testable — pointer-events not none — and at the middle of that overlap the container's subtree is hit
    // first, and the container's own background colour is opaque rgb() / rgba(…, 1) with no opacity below 1 or blend mode on it
    // or above it). D55: never foreign content — the sole control's own tooltip ([role=tooltip], or what its aria-describedby
    // names; a role-less one still counts), D56: only when the probe's hover revealed it (not shown before: tipPreMark), and a
    // label at effective opacity 0. Not seen: an element whose box does not meet the
    // container's (a relative ::before shifted over it from a sibling lying elsewhere), an in-flow box under a parent that does not
    // meet it (text overflowing a 0-height wrapper). Bounded: past FOREIGN_CAP elements it answers "content".
    const br = box.getBoundingClientRect();
    const anc = new Set<DElement>();
    for (let p = up(box); p; p = up(p)) anc.add(p);
    const bg = css(box, "background-color");
    // review 10 M-4: "under it" is proven only when nothing of it shows through — its background opaque, and no opacity below 1
    // or blend mode on it or above it
    let opaque = /^rgb\(/.test(bg) || /^rgba\(.*,\s*1\)$/.test(bg);
    for (let p: DElement | null = box; p && opaque; p = up(p)) {
      const op = css(p, "opacity"), bm = css(p, "mix-blend-mode");
      if ((op !== "" && parseFloat(op) < 1) || (bm !== "" && bm !== "normal")) opaque = false;
    }
    const meets = (q: DRect): boolean => q.right > br.x && q.x < br.right && q.bottom > br.y && q.y < br.bottom;
    const over = (f: DElement, c: { x0: number; y0: number; x1: number; y1: number } | null, events: string): boolean => {
      if (!c) return true;
      const a = Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0);
      const ix0 = Math.max(c.x0, br.x), iy0 = Math.max(c.y0, br.y), ix1 = Math.min(c.x1, br.right), iy1 = Math.min(c.y1, br.bottom);
      if (a <= 1 || ix1 <= ix0 || iy1 <= iy0 || (ix1 - ix0) * (iy1 - iy0) < a / 2) return false;
      if (events === "none" || !opaque) return true;
      const hits = Array.from(document.elementsFromPoint((ix0 + ix1) / 2, (iy0 + iy1) / 2));
      const iF = hits.indexOf(f), iB = hits.findIndex((h) => h === box || box.contains(h));
      return iF < 0 || iB < 0 || iF < iB;
    };
    const pinned = chain((p) => !anc.has(p) && /^(fixed|sticky)$/.test(css(p, "position")));
    // D55 (review 10 H-2): the sole control's own tooltip — [role=tooltip] (MUI, Radix, Tippy, Bootstrap, Floating UI set it) or
    // what its aria-describedby names, shown by the drive's hover — is never foreign content (its subtree is skipped). D56
    // (review 11 H-1): only one the probe's hover revealed — not shown before the probe acted on the page (tipPreMark); a label
    // already on screen with role=tooltip, or that the control's aria-describedby names, is the card's own; no set, no exemption
    const tipIds = new Set((ctl.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    const tipPre = window.__dtTipPre;
    const tip = (f: DElement): boolean => !!tipPre && !tipPre.has(f) && !anc.has(f) && ((f.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "tooltip" || tipIds.has(f.getAttribute("id") ?? ""));
    // D55 (review 10 L-1): a foreign label at effective opacity 0 (itself or an ancestor) shows nothing — never foreign content
    const gone = chain((p) => css(p, "opacity") === "0");
    // review 10 M-1: bounded at 500000 elements (a 150000-element table: about 0.3 s per check) — past it, "content" (refused)
    const FOREIGN_CAP = 500_000;
    let walked = 0;
    // a box is measured only when its parent's box meets the container, it holds the container, or it is moved out of its
    // parent's flow (positioned or transformed) — an in-flow box under a parent that does not meet the container is taken not to
    // meet it either (nested inline boxes make every getBoundingClientRect walk all below it: 8000 of them cost seconds)
    // (one computed style read per element: the walk visits every element of the page — review 10 M-2)
    const moved = (f: DElement): boolean => { const s = getComputedStyle(f); return s.getPropertyValue("position") !== "static" || ["transform", "translate", "rotate", "scale"].some((k) => { const v = s.getPropertyValue(k); return v !== "" && v !== "none"; }); };
    const ftodo: Array<{ f: DElement; near: boolean }> = [{ f: de, near: true }];
    for (let t = ftodo.pop(); t; t = ftodo.pop()) {
      if (++walked > FOREIGN_CAP) return `more than ${FOREIGN_CAP} boxes on the page to check for a label laid over it`;
      const f = t.f;
      if (f === box || tip(f)) continue;
      const isAnc = anc.has(f);
      const fr = t.near || isAnc || moved(f) ? f.getBoundingClientRect() : null;
      const near = isAnc || (fr !== null && meets(fr));
      const sr = f.shadowRoot;
      for (const k of Array.from(f.children ?? [])) ftodo.push({ f: k, near });
      if (sr) for (const k of Array.from(sr.children)) ftodo.push({ f: k, near });
      if (!fr || !near || pinned(f) || !shown(f) || gone(f)) continue;
      const events = css(f, "pointer-events");
      // review 10 M-4: its text, and bare text in its open shadow root
      for (const t of [...Array.from(f.childNodes), ...(sr ? Array.from(sr.childNodes) : [])]) {
        const text = t.nodeType === 3 ? (t.nodeValue || "").trim() : "";
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const q of Array.from(range.getClientRects())) if (over(f, clipped(f, q), events)) return `text "${text.slice(0, 40)}" laid over it from outside it`;
      }
      if (!isAnc && /^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|INPUT|PROGRESS|METER)$/.test(f.tagName.toUpperCase()) && over(f, clipped(f, fr), events)) return `<${f.tagName.toLowerCase()}> laid over it from outside it`;
      if (!isAnc && set(f, "background-image") && over(f, clipped(f, fr), events)) return "a background image laid over it from outside it";
      for (const ps of ["::before", "::after"]) {
        const c = css(f, "content", ps);
        const pos = css(f, "position", ps);
        if (!c || c === "none" || c === "normal" || pos === "fixed" || css(f, "display", ps) === "none" || /^(hidden|collapse)$/.test(css(f, "visibility", ps)) || css(f, "opacity", ps) === "0") continue;
        const str = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        if (!(str === null || /\S/.test(str[1] ?? "") || set(f, "background-image", ps) || set(f, "mask-image", ps))) continue;
        let q: DRect = fr;
        if (pos === "absolute") {
          // its containing block: the closest box at or above it that is positioned or holds fixed boxes (its padding box), else the page
          let cb: DElement | null = f;
          while (cb && css(cb, "position") === "static" && !holdsFixed(cb)) cb = up(cb);
          const cr0 = cb ? cb.getBoundingClientRect() : null;
          const n = (k: string): number => parseFloat(css(f, k, ps)) || 0;
          const x = (cr0 && cb ? cr0.x + (parseFloat(css(cb, "border-left-width")) || 0) : -scrollX) + n("left") + n("margin-left");
          const y = (cr0 && cb ? cr0.y + (parseFloat(css(cb, "border-top-width")) || 0) : -scrollY) + n("top") + n("margin-top");
          const extra = css(f, "box-sizing", ps) === "border-box" ? [0, 0] : [n("padding-left") + n("padding-right") + n("border-left-width") + n("border-right-width"), n("padding-top") + n("padding-bottom") + n("border-top-width") + n("border-bottom-width")];
          const w = n("width") + (extra[0] ?? 0), h = n("height") + (extra[1] ?? 0);
          q = { x, y, width: w, height: h, right: x + w, bottom: y + h };
        } else if (isAnc) continue;
        if (over(f, clipped(f, q), css(f, "pointer-events", ps))) return `a generated ${ps} label laid over it from outside it`;
      }
    }
    return null;
  };
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  // Playwright's point: the middle of the first client rect's part on screen (submitGuard, fixes 4–6)
  let onScreen = false, cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  for (const q of Array.from(el.getClientRects())) {
    const x0 = Math.min(Math.max(q.x, 0), vw), x1 = Math.min(Math.max(q.right, 0), vw);
    const y0 = Math.min(Math.max(q.y, 0), vh), y1 = Math.min(Math.max(q.bottom, 0), vh);
    if ((x1 - x0) * (y1 - y0) > 0.99) { onScreen = true; cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; break; }
  }
  const inner = Array.from(el.querySelectorAll(FOC));
  // review 5 H-1: what the mouse presses at the point — the deepest element there, through open shadow roots (a web
  // component's own <button>; text slotted into a shadow control starts at its <slot>), then up the flat tree (a slotted node's
  // slot, a shadow root's host — the path the click's event takes) to the opener: the first focusable or activating element (a
  // role=button span without tabindex too), or a <label> with a control (its click toggles that control). Review 6 H-2: an
  // ACTIVATING element anywhere on that path wins over a merely focusable one below it (a tabindex=-1 glyph or a contenteditable
  // label inside a Delete is focusable, but the click still bubbles to the Delete) — the innermost activating one is named. A
  // nested browsing context there — <iframe>, <frame>, <object>, <embed>, <fencedframe> — is a control (what is inside it cannot
  // be seen). Not seen: a closed shadow root, a bare listener (an <svg onclick>, no role).
  const up = (n: DElement): DElement | null => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
  const framed = (e: DElement): boolean => /^(IFRAME|FRAME|OBJECT|EMBED|FENCEDFRAME)$/.test(e.tagName.toUpperCase());
  const pick = (e: DElement): DElement | null => (e.tagName.toUpperCase() === "LABEL" ? e.control ?? null : e.matches(FOC) || e.matches(ACT) || framed(e) ? e : null);
  const presses = (e: DElement | null): e is DElement => !!e && (e.matches(ACT) || framed(e));
  let at: DElement | null = null;
  if (onScreen) {
    let hit = document.elementFromPoint(cx, cy), from = hit;
    for (let i = 0; hit && hit.shadowRoot && i < 32; i++) {
      const host: DElement = hit, sr = hit.shadowRoot;
      const deeper = sr.elementFromPoint ? sr.elementFromPoint(cx, cy) : null;
      let under = false;
      for (let p = deeper; p; p = up(p)) if (p === host) { under = true; break; }
      if (deeper && deeper !== host && under) { hit = deeper; from = deeper; continue; }
      const slotted = Array.from(host.childNodes).find((t) => {
        if (t.nodeType !== 3 || !t.assignedSlot) return false;
        const rg = document.createRange();
        rg.selectNodeContents(t);
        return Array.from(rg.getClientRects()).some((q) => cx >= q.x && cx <= q.right && cy >= q.y && cy <= q.bottom);
      });
      from = slotted && slotted.assignedSlot ? slotted.assignedSlot : host;
      break;
    }
    let found: DElement | null = null;
    for (let p = from; p; p = up(p)) {
      if (p === el) { at = found; break; }
      if (presses(found)) continue;
      const k = pick(p);
      if (k && (!found || presses(k))) found = k;
    }
  } else {
    // off screen (Playwright scrolls it in first): of the controls (or labels) inside whose box holds the point, the innermost
    // activating one, else the innermost
    const holds = Array.from(el.querySelectorAll(`${FOC}, ${ACT}, label, frame, object, embed, fencedframe`)).filter((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && b.height > 0 && cx >= b.x && cx <= b.right && cy >= b.y && cy <= b.bottom; });
    for (const h of holds) { const k = pick(h); if (k && (!presses(at) || presses(k))) at = k; }
  }
  if (!presses(at)) return null;
  // D47 + D51: the container's only focusable, button-like, under its centre, with nothing of the container's own outside it —
  // the opener's own control (never for a focusable opener, H-1)
  if (!self && inner.length === 1 && inner[0] === at && at.matches(BTN)) {
    const own = ownContent(el, at);
    // D52: the DOM sees nothing of the container's own — the caller's pixel check (ownPixels) has the last word
    if (own === null) { if (mark) window.__dtOwn = { box: el, ctl: at }; return null; }
    // review 10 L-5: why the DOM rule refused it (ownWhy reads it for the row's detail)
    if (mark) window.__dtOwnWhy = `its own content: ${own}`;
  }
  const label = at.getAttribute("aria-label");
  return `<${at.tagName.toLowerCase()}${at.getAttribute("type") ? ` type="${at.getAttribute("type") ?? ""}"` : ""}${at.getAttribute("role") ? ` role="${at.getAttribute("role") ?? ""}"` : ""}${label ? ` aria-label="${label}"` : ""}>`;
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

/** D53: a Playwright screenshot as RGBA pixels — PNG colour type 2 (RGB) or 6 (RGBA), depth 8, not interlaced (what Chromium
 *  writes; W3C PNG 3 §9 filters, §11.2.2 IHDR); anything else throws (the caller refuses). */
export function decodePng(buf: Buffer): { w: number; h: number; data: Uint8Array } {
  let o = 8, w = 0, h = 0, ct = -1, depth = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString("latin1", o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8] ?? 0; ct = d[9] ?? -1; interlace = d[12] ?? 0; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (depth !== 8 || (ct !== 2 && ct !== 6) || interlace !== 0) throw new Error(`unsupported PNG (colour type ${ct}, depth ${depth}${interlace ? ", interlaced" : ""})`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error("truncated PNG");
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] ?? 0, s = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[s + i] ?? 0, a = i >= ch ? px[dst + i - ch] ?? 0 : 0, b = y ? px[prev + i] ?? 0 : 0, c = y && i >= ch ? px[prev + i - ch] ?? 0 : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[dst + i] = v & 255;
    }
  }
  if (ch === 4) return { w, h, data: px };
  const data = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { data[j] = px[i] ?? 0; data[j + 1] = px[i + 1] ?? 0; data[j + 2] = px[i + 2] ?? 0; data[j + 3] = 255; }
  return { w, h, data };
}

/** Review 9 H-1: the signed distance (CSS px; < 0 inside) from (px, py) to a rounded rect — its rect, or by the corner's
 *  quadrant the ellipse of that corner (first-order: the implicit function over its gradient — exact at the edge, more negative
 *  deeper inside, which only keeps a pixel in the core). */
export function shapeDistance(q: KeptShape, px: number, py: number): number {
  const hw = (q.right - q.x) / 2, hh = (q.bottom - q.y) / 2, dx = px - (q.x + hw), dy = py - (q.y + hh);
  const i = dy < 0 ? (dx < 0 ? 0 : 1) : dx < 0 ? 3 : 2;
  const rx = q.r[2 * i] ?? 0, ry = q.r[2 * i + 1] ?? 0;
  const ax = Math.abs(dx), ay = Math.abs(dy), qx = ax - (hw - rx), qy = ay - (hh - ry);
  if (rx > 0 && ry > 0 && qx > 0 && qy > 0) {
    const f = (qx / rx) ** 2 + (qy / ry) ** 2 - 1, g = 2 * Math.hypot(qx / (rx * rx), qy / (ry * ry));
    return g > 0 ? f / g : -Math.min(rx, ry);
  }
  return Math.max(ax - hw, ay - hh);
}
/** D53: do the kept boxes paint PLAIN? `k`: only the kept boxes painted, `n`: nothing of the container painted (the same clip, CSS
 *  px). Each pixel's centre is placed against each filled box's shapes (its own rounded rect and the clipping ones up to the
 *  container — review 9 H-1: the real rounded outline, not whole corner squares): the CORE (more than 1.5 px inside all of them)
 *  must be one colour C (the first filled box's centre pixel in `k`) within 1 per channel; the BAND (within 1.5 px of the edge)
 *  `n`'s pixel, C or a blend of the two (the same mix on every channel, within 3); anywhere else `k` equals `n` within 1. A box
 *  with no background colour paints nothing (it only holds the control). null = plain; else why. */
export const KEPT_EDGE_PX = 1.5;
export function plainKept(k: { w: number; h: number; data: Uint8Array }, n: { w: number; h: number; data: Uint8Array }, clip: { x: number; y: number }, keep: KeptRect[]): string | null {
  if (k.w !== n.w || k.h !== n.h) return "the two screenshots differ in size";
  const filled = keep.filter((r) => r.filled).map((r) => ({
    // pixel columns / rows, clip-relative, that can hold a part of it: [ox0, ox1) × [oy0, oy1)
    ox0: Math.floor(r.x - clip.x) - 2, ox1: Math.ceil(r.right - clip.x) + 2, oy0: Math.floor(r.y - clip.y) - 2, oy1: Math.ceil(r.bottom - clip.y) + 2,
    shapes: r.shapes, mx: Math.floor((r.x + r.right) / 2 - clip.x), my: Math.floor((r.y + r.bottom) / 2 - clip.y),
  }));
  const at = (img: { data: Uint8Array }, x: number, y: number, c: number): number => img.data[(y * k.w + x) * 4 + c] ?? 0;
  const near = (x: number, y: number, col: number[], tol: number): boolean => [0, 1, 2].every((c) => Math.abs(at(k, x, y, c) - (col[c] ?? 0)) <= tol);
  const f0 = filled[0];
  const C = f0 ? [0, 1, 2].map((c) => at(k, Math.min(k.w - 1, Math.max(0, f0.mx)), Math.min(k.h - 1, Math.max(0, f0.my)), c)) : [];
  for (let y = 0; y < k.h; y++) {
    for (let x = 0; x < k.w; x++) {
      const N = [0, 1, 2].map((c) => at(n, x, y, c));
      let zone: "core" | "band" | "out" = "out";
      for (const f of filled) {
        if (x < f.ox0 || x >= f.ox1 || y < f.oy0 || y >= f.oy1) continue;
        const px = x + 0.5 + clip.x, py = y + 0.5 + clip.y;
        let sd = -Infinity;
        for (const q of f.shapes) sd = Math.max(sd, shapeDistance(q, px, py));
        if (sd <= -KEPT_EDGE_PX) { zone = "core"; break; }
        if (sd < KEPT_EDGE_PX) zone = "band";
      }
      if (zone === "out") { if (!near(x, y, N, 1)) return `a kept box paints outside itself (at ${x}, ${y} of the opener)`; continue; }
      if (zone === "core") { if (!near(x, y, C, 1)) return `a kept box does not paint one plain colour (at ${x}, ${y} of the opener)`; continue; }
      // the band: n's pixel, C, or one mix t of the two on every channel (anti-aliasing)
      const d = [0, 1, 2].map((c) => (C[c] ?? 0) - (N[c] ?? 0));
      const big = [0, 1, 2].reduce((m, c) => (Math.abs(d[c] ?? 0) > Math.abs(d[m] ?? 0) ? c : m), 0);
      const db = d[big] ?? 0;
      if (Math.abs(db) <= 3) { if (!near(x, y, N, 3)) return `a kept box's edge is not a blend of its colour (at ${x}, ${y} of the opener)`; continue; }
      const t = (at(k, x, y, big) - (N[big] ?? 0)) / db;
      if (t < -0.02 || t > 1.02 || ![0, 1, 2].every((c) => Math.abs((N[c] ?? 0) + t * (d[c] ?? 0) - at(k, x, y, c)) <= 3)) return `a kept box's edge is not a blend of its colour (at ${x}, ${y} of the opener)`;
    }
  }
  return null;
}

/** D52 / D53 (shared by the 12a drive and the behaviour battery's markOpener): the pixel half of "the container shows nothing of
 *  its own" for the pair clickPointControl / markOpener left in window.__dtOwn — shot A (only the control hidden) against shot B
 *  (all the container's content hidden), everything outside the container — its ancestors too — hidden in both (D53, D54(c)),
 *  clipped to the container's box on screen, animations:"disabled", caret hidden, CSS pixels; two frames before shot A only (the
 *  later shots change nothing but the probe's sheet, which a screenshot paints first — review 9 L-3). The PNGs are compared byte
 *  for byte: equal pixels encode the same, and anything that differs (a video, a canvas animation) refuses — the safe side. When
 *  boxes were kept as decoration and A equals B, two more shots (K: only the kept boxes painted; N: nothing of the container)
 *  must show them plain (plainKept, D53). `park`: the pointer goes to (0, 0) first, so a hover tint is not counted (the caller
 *  restores the hover a click needs). null = no pair (nothing to check); else the control and why it is not the opener's own
 *  (null = nothing of the container's own: it is). Never throws: an error refuses. The markers, the sheets and any scroll
 *  ownMark made are always removed. */
export const OWN_SHOT_MS = 5_000;
export async function ownPixels(page: Page, o: { park: boolean }): Promise<{ ctl: string; why: string | null } | null> {
  let ctl = "its sole control";
  try {
    const m = await page.evaluate(ownMark, null);
    if (m === null) return null;
    if (m.why !== null) return { ctl, why: m.why };
    ctl = m.ctl;
    if (o.park) await page.mouse.move(0, 0);
    const shot = async (s: "A" | "B" | "K" | "N", want?: { x: number; y: number; width: number; height: number }): Promise<{ png: Buffer; clip: { x: number; y: number; width: number; height: number }; keep: KeptRect[] } | string> => {
      const arg: { shot: "A" | "B" | "K" | "N" } = { shot: s };
      const r = await page.evaluate(ownShot, arg);
      if (r.clip === null) return r.why ?? "nothing of the opener is on screen to compare";
      if (want && JSON.stringify(r.clip) !== JSON.stringify(want)) return "the opener moved between the screenshots";
      // review 9 L-3: two frames only before the first shot, and only after the park or the scroll into view (so a hover or an
      // IntersectionObserver reveal has run); the later shots change nothing but the probe's own sheet, and a screenshot paints
      // the pending style first (Page.captureScreenshot runs the whole rendering update — by experiment 0 stale out of 200,
      // under a page repainting every 5 ms) — about 90 ms less per pair with kept boxes, 30 ms without
      if (s === "A" && (o.park || m.scrolled)) await raf2(page);
      return { png: await page.screenshot({ clip: r.clip, animations: "disabled", caret: "hide", scale: "css", timeout: OWN_SHOT_MS }), clip: r.clip, keep: r.keep };
    };
    const a = await shot("A");
    if (typeof a === "string") return { ctl, why: a };
    const b = await shot("B", a.clip);
    if (typeof b === "string") return { ctl, why: b };
    if (!a.png.equals(b.png)) return { ctl, why: "the opener paints something of its own beside it (D52: its screenshot with only that control hidden differs from the one with all its content hidden)" };
    if (m.keep === 0) return { ctl, why: null };
    const k = await shot("K", a.clip);
    if (typeof k === "string") return { ctl, why: k };
    const n = await shot("N", a.clip);
    if (typeof n === "string") return { ctl, why: n };
    const plain = plainKept(decodePng(k.png), decodePng(n.png), k.clip, k.keep);
    return { ctl, why: plain === null ? null : `a box kept as the opener's decoration is not a plain fill — ${plain} (D53: alone it must paint one uniform colour)` };
  } catch (e) {
    return { ctl, why: `its own content could not be compared by pixels (${firstLine(e)})` };
  } finally {
    await page.evaluate(ownClear, null).catch(() => undefined);
  }
}

/** Review 6 H-4 follow-up (D4): restoreScroll, two frames, scrollHeld — again until it holds twice in a row (≤ RESTORE_CAP_MS). */
export const RESTORE_CAP_MS = 3_000;
async function restoreSettled(page: Page): Promise<void> {
  const t0 = Date.now();
  let held = 0;
  while (held < 2 && Date.now() - t0 < RESTORE_CAP_MS) {
    await page.evaluate(restoreScroll);
    await raf2(page);
    held = (await page.evaluate(scrollHeld)) ? held + 1 : 0;
  }
}

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
    // D56 (review 11 H-1): what is on screen before the probe's first hover — a tooltip shown before it is not the control's
    await page.evaluate(tipPreMark, null).catch(() => false);
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
    // 12b review 7 H-1 (D52): the pointer goes where the click will put it FIRST — a row action revealed on :hover (by visibility,
    // display or pointer-events) is under the click point only then, and Playwright's click would land on it. force: no 2 s
    // actionability wait (a covered opener); two frames for the hover styles; the submit guard looks again
    await page.locator(openerPath).first().hover({ timeout: 2000, force: true }).catch(() => undefined);
    await raf2(page);
    const submitsHovered = await page.locator(openerPath).first().evaluate(submitGuard);
    if (submitsHovered !== null) return { ...base, ok: null, ...(revealedBy !== undefined ? { revealedBy } : {}), detail: `opener would submit a form (${submitsHovered}) — not driven` };
    // 12b review 3 L-2: nor one whose click point is another control inside it (a card's centred Delete) — the drive has no
    // write block
    const notOwn = (ctl: string, why?: string): InteractionEvidence => ({ ...base, ok: null, ...(revealedBy !== undefined ? { revealedBy } : {}),
      detail: `the opener's click point is another control inside it (${ctl}) — tag that control or the opener's own clickable element — not driven${why !== undefined ? ` (${why})` : ""}` });
    const inner = await page.locator(openerPath).first().evaluate(clickPointControl, { mark: true });
    if (inner !== null) return notOwn(inner, (await page.evaluate(ownWhy, null).catch(() => null)) ?? undefined);
    // D52: a container's sole control the DOM check let through — the pixels decide (the pointer parked away, unless the opener
    // only shows while its ancestor is hovered: D16 keeps that hover)
    const px = await ownPixels(page, { park: revealedBy === undefined });
    if (px !== null && px.why !== null) return notOwn(px.ctl, px.why);
    const contract = [...DIALOG_CONTRACT];
    await page.evaluate(armDetector, { destId, contract });
    const tokenBefore = String(await page.evaluate("window.__dtProbeDoc || ''"));
    const loadsBefore = loads();
    let activation: ProbeActivation = "mouse", clickWhy = "";
    await page.locator(openerPath).first().evaluate(saveScroll);
    try {
      await page.locator(openerPath).first().click({ timeout: 2000 });
    } catch (e) {
      const m = errMsg(e);
      if (CLOSED.test(m)) throw e;
      if (!NAVIGATED.test(m)) {
        // hidden or covered (TimeoutError after the full 2 s): click in the page — never a user activation
        clickWhy = (/intercepts pointer events|not visible|not enabled|not stable|outside of the viewport/.exec(m) || [firstLine(e)])[0] ?? "";
        activation = "synthetic";
        // review 5 M-1: from the scroll the drive had, never from where the retries left the page — and (review 6 H-4, D4) still
        // there two frames later, twice in a row: a smooth scroll Playwright's last retry started can outlive one restore
        await restoreSettled(page);
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
