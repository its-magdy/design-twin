// probe-drive.ts — what the shipped probe does beyond measuring the resting screen:
//
//   * reads the page's horizontal overflow in the measurement pass (`measured.page`), and
//   * DRIVES the overlay interactions the expectation lists: each one on a fresh page in a
//     fresh browser context, after the measurement pass — reach the screen (goto, the --steps), reveal a hover-hidden
//     opener (hover its nearest visible ancestor), click it with the real mouse, and watch for an element of the dialog
//     contract to appear.
//
// Why: without this an overlay's opener is "not-probed" on every run — the agent would drive it by hand (or not at all), with
// evidence nothing could check, and a row-action button that only shows when its table row is hovered could
// not be clicked at all. What the probe records here is evidence, never a verdict: a row is ok:true only when exactly
// one opener was clicked with the real mouse, something of the dialog contract opened (or the destination frame's tag
// appeared), the destination's tag is inside what opened, and no document loaded — otherwise ok:null with the
// missing piece named. The probe never writes ok:false ("nothing detected" is not-probed, never fail).
//
// The page-side functions (readPageOverflow, openerState, armDetector, pollDetector, saveScroll, restoreScroll, scrollHeld, syntheticClick, submitGuard,
// clickPointControl, pointOn, and ownMark / ownShot / ownClear)
// are handed to page.evaluate, so — as in probe-page.ts — each one is SELF-CONTAINED: no reference to anything
// outside its own body but the page's globals and the probe's page runtime (window.__dt, page-runtime.ts), plain JSON in and out. The DOM is typed by page-dom.ts (types only; this layer
// has no DOM lib); test/verify-probe-drive-e2e.test.ts runs the BUILT bundle in a real browser to prove it.
//
// Platform facts this relies on (Chromium 153 / Playwright 1.63, verified):
//   - Playwright counts opacity:0 as visible and clicks it, so the opener's opacity is judged in the page.
//   - locator.click on a hidden or covered target fails with a TimeoutError after its whole timeout; the probe then
//     clicks in the page (el.click()) and says "synthetic" — never a user activation, so the row stays ok:null.
//   - (hover: hover) matches in a default desktop context — never set hasTouch / isMobile (the reveal would fail).
//   - React commits a dialog opened from a click within a frame or two: the detector polls every 100 ms for 2 s.
//   - :modal and :popover-open parse in Chromium; an unknown selector throws, so each contract selector is tried alone.
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { ProbeSession, Reached } from "./probe-session.ts";
import type { InteractionEvidence, InteractionOutcome, PageOverflow, ProbeActivation, VerifyExpectation, VerifyInteraction } from "./types.ts";
import { errMsg, firstLine } from "../bridge/src/errmsg.ts";
import { pwErrorKind, pwFirstLine } from "./pw-errors.ts";
import { decodePng } from "../bridge/src/png.ts";
import { byPath } from "./page-runtime.ts";
import type { DriveScroll, PageDocument, PageElement, PageShadowRoot, PageSheet, PageStyle, PageWindow } from "./page-dom.ts";

// ---------------------------------------------------------------- the page, as far as these functions use it (page-dom.ts)
declare const document: PageDocument;
declare const window: PageWindow;
declare const scrollX: number;
declare const scrollY: number;
declare const innerWidth: number;
declare const innerHeight: number;
declare function getComputedStyle(el: PageElement, pseudo?: string | null): PageStyle;
declare function scrollTo(opts: { left: number; top: number; behavior: "instant" }): void;
declare const CSSStyleSheet: new () => PageSheet;

// ---------------------------------------------------------------- the page's horizontal overflow
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
    const pathOf = window.__dt.path;
    // An element does not widen the page when an ancestor ON ITS CONTAINING-BLOCK CHAIN clips or scrolls its overflow, or
    // when it is fixed to the viewport. An absolutely positioned element escapes every ancestor that is static and
    // creates no containing block. L-d (Chromium 153, verified): transform / translate / rotate / scale / perspective /
    // filter / backdrop-filter / transform-style:preserve-3d / will-change of one of them create a containing block for
    // absolute AND fixed descendants — so a position:fixed element under one scrolls with the page like an absolute one;
    // contain: layout / paint / strict / content and content-visibility (not visible) keep everything inside.
    const createsBlock = (cs: PageStyle): boolean => {
      const v = (k: string): string => cs.getPropertyValue(k);
      if (["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => { const x = v(k); return x !== "" && x !== "none"; })) return true;
      if (v("transform-style") === "preserve-3d") return true;
      return /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(v("will-change"));
    };
    const containsAll = (cs: PageStyle): boolean => /\b(layout|paint|strict|content)\b/.test(cs.getPropertyValue("contain"))
      || ["auto", "hidden"].includes(cs.getPropertyValue("content-visibility"));
    const contained = (el: PageElement): boolean => {
      const own = getComputedStyle(el).getPropertyValue("position");
      let mode = own === "fixed" ? "fixed" : own === "absolute" ? "absolute" : "flow";
      for (let p: PageElement | null = el.parentElement; p && p !== body && p !== de; p = p.parentElement) {
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
    const past: Array<{ el: PageElement; right: number }> = [];
    for (const el of Array.from(body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      const right = r.right + scrollX;
      if (r.width > 0 && right > clientWidth + 1 && !contained(el)) past.push({ el, right });
    }
    past.sort((a, b) => b.right - a.right);
    const chosen: PageElement[] = [];
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

// ---------------------------------------------------------------- the opener (hover-reveal path)
export interface OpenerState {
  /** elements tagged with the opener's id, outside a closed <dialog> (several → those with a layout box) */
  count: number;
  path: string | null;
  /** has a box, a size, and is not hidden by visibility/display/opacity (Playwright calls opacity:0 visible) */
  visible: boolean;
  /** disabled — :disabled / [disabled] / aria-disabled="true", on it or an ancestor (never clicked: a click on an
   *  aria-disabled control still runs the app's handler) */
  disabled: boolean;
  /** what to hover to reveal it: the nearest visible tagged ancestor, else the nearest visible ancestor */
  hoverPath: string | null;
  hoverDt: string | null;
}
/** In the page: find the opener, say whether a person can see it, and what to hover when not. SELF-CONTAINED. */
export function openerState(arg: { id: string }): OpenerState {
  const dt = window.__dt;
  const pathOf = dt.path;
  const sees = (el: PageElement, opacity: boolean): boolean => dt.visible(el, { sized: true, opacity });
  const els = dt.tagged(arg.id);
  const el = els.length === 1 ? els[0] : undefined;
  if (!el) return { count: els.length, path: null, visible: false, disabled: false, hoverPath: null, hoverDt: null };
  const visible = sees(el, true);
  const disabled = el.closest(":disabled, [disabled], [aria-disabled=\"true\" i]") !== null;
  let hoverPath: string | null = null, hoverDt: string | null = null;
  if (!visible) {
    let plain: PageElement | null = null;
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

// ---------------------------------------------------------------- the detector
/** The dialog contract, in the order a match is named (detectedBy). */
export const DIALOG_CONTRACT = [":modal", "dialog[open]", "[role=dialog]", "[role=alertdialog]", "[aria-modal=\"true\"]", ":popover-open"] as const;

/** In the page, BEFORE the click: remember every visible dialog-like element and destination tag. SELF-CONTAINED. */
export function armDetector(arg: { destId: string | null; contract: readonly string[] }): boolean {
  const dt = window.__dt;
  const pathOf = dt.path;
  const seen = (el: PageElement): boolean => dt.visible(el, { sized: true, opacity: true });
  const before: PageElement[] = [];
  for (const s of arg.contract) {
    try { for (const el of Array.from(document.querySelectorAll(s))) if (seen(el)) before.push(el); } catch { /* a selector this browser does not parse */ }
  }
  const destBefore = arg.destId === null ? [] : Array.from(document.querySelectorAll(dt.tagSel(arg.destId))).filter(seen);
  // every OPEN modal root rendered now, whatever its box (Headless UI's root is 0 px, so `before` never has it) — the
  // behaviour battery never climbs to one of these as "what opened"; the detector itself does not read it
  const roots = Array.from(document.querySelectorAll("dialog[open], [aria-modal=\"true\" i]")).filter((el) => el.getClientRects().length > 0);
  // where each was, too — a wrapper the app re-mounts in the same place is a new element but not a newly shown one
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
  const dt = window.__dt;
  const pathOf = dt.path;
  const seen = (el: PageElement): boolean => dt.visible(el, { sized: true, opacity: true });
  let opened: PageElement | null = null, detectedBy: string | null = null;
  for (const s of arg.contract) {
    let hits: PageElement[] = [];
    try { hits = Array.from(document.querySelectorAll(s)).filter((el) => seen(el) && !st.before.includes(el)); } catch { continue; }
    const first = hits[0];
    if (first) { opened = first; detectedBy = s; break; }
  }
  let dest: DetectorRead["dest"] = null;
  if (arg.destId !== null) {
    const tags = Array.from(document.querySelectorAll(dt.tagSel(arg.destId))).filter(seen);
    // newly visible: not one seen before the click — nor a re-mounted copy in the same place (L-b; same path)
    const fresh = tags.filter((t) => !st.destBefore.includes(t) && !st.destPaths.includes(pathOf(t)));
    // planner default 1: the destination tag newly appearing with no contract match IS what opened
    const firstFresh = fresh[0];
    if (opened === null && firstFresh) opened = firstFresh;
    const o = opened;
    // the tag on the opened element or inside it — or on an ancestor of it that this click made visible (a
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

/** In the page: the scroll the drive has before its mouse click — the window's and every ancestor box's of the
 *  opener — kept for restoreScroll. SELF-CONTAINED. */
export function saveScroll(el: PageElement): void {
  const boxes: DriveScroll["boxes"] = [];
  for (let p = el.parentElement; p; p = p.parentElement) boxes.push({ el: p, left: p.scrollLeft, top: p.scrollTop });
  window.__dtDriveScroll = { x: scrollX, y: scrollY, boxes };
}
/** In the page: back to saveScroll's scroll before the synthetic click — a failed mouse click leaves the page where
 *  Playwright's last retry scrolled the opener in (each retry with another alignment; how many fit in its 2 s depends on load),
 *  so the opened element's rect and scrollY would depend on timing. SELF-CONTAINED. */
export function restoreScroll(): void {
  const s = window.__dtDriveScroll;
  if (!s) return;
  // instant — a scroll-behavior:smooth box (an app shell's scroller) would otherwise animate back while the
  // synthetic click lands and the detector reads (MDN: scrollTop / scrollTo(x, y) use the box's computed scroll-behavior)
  for (const b of s.boxes) if (b.el.scrollLeft !== b.left || b.el.scrollTop !== b.top) b.el.scrollTo({ left: b.left, top: b.top, behavior: "instant" });
  scrollTo({ left: s.x, top: s.y, behavior: "instant" });
}

/** In the page: whether restoreScroll's positions still hold — Playwright's last click retry can
 *  leave a smooth scroll (a page's own !important scroll-behavior beats the probe's init CSS) running after the restore, so
 *  driveRow restores, waits two frames and looks again until it holds twice in a row. SELF-CONTAINED. */
export function scrollHeld(): boolean {
  const s = window.__dtDriveScroll;
  if (!s) return true;
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1;
  return near(scrollX, s.x) && near(scrollY, s.y) && s.boxes.every((b) => near(b.el.scrollLeft, b.left) && near(b.el.scrollTop, b.top));
}

// ---------------------------------------------------------------- the container's own content, by pixels
// A container's sole centred control is the opener's own only when the container shows nothing of its own outside
// it. That is decided by PIXELS, as a union with the DOM check (clickPointControl / markOpener's ownContent: content
// when EITHER says so — a label not painted yet, an in-flow opacity-0 reveal, still counts). Shot A: the container with only its
// control hidden; shot B: with all its content hidden — every descendant, the content of every open shadow root inside it (the
// container itself as a host too), and the container's own ::before / ::after / ::marker and other pseudo-elements, each by its
// own rule and checked to have taken. Any pixel that differs is content of its own → the control is not the opener's (the drive
// does not click, the battery presses no key).
// In every shot everything OUTSIDE the container's subtree is hidden too (so a foreign overlay or toast repainting over the
// cell between the two shots never decides the result), and so are its ancestors' own background, border, text and
// pseudo-elements; the container is shown again by its own rule. The focused element outside it stays shown on its own:
// hiding it would blur it, and Chromium keeps the focus of an element shown under hidden ancestors.
// Hidden by the probe's own constructed style sheets (document.adoptedStyleSheets, and adopted into each open shadow root inside
// the container) with visibility:hidden !important and transition:none (no layout change; `*` also covers descendants that
// set visibility:visible themselves; a transition on visibility would keep it showing), on marker attributes; the sheets and
// the markers are removed afterwards. A constructed sheet because a page's CSP blocks an injected <style> and, by experiment,
// does not block a constructed sheet (CSP3 §6.1.13 names insertRule / cssText as gated on 'unsafe-eval', MDN says no browser
// enforces that). A rule that did not take refuses: every element a shot hides (and its ::before / ::after with content) is
// checked, so a page's inline !important, or an !important inside a cascade layer (which beats any unlayered one, whatever its
// specificity), refuses instead of showing in both shots.
// Kept in BOTH shots — decoration, but only when the pixels show it PLAIN: the container's own background colour, border
// in one colour, box-shadow and outline (its own background image, a border in two colours or a stripe are content — the
// DOM rule, ownContent); a descendant painting only a background colour over the container's whole padding box (a hover tint —
// the container's own background drawn by a child) and a wrapper of the control within 8 px of it on every side (a filled
// wrapper — the control's own chrome; what else it holds is still hidden in shot B). The CSS pre-filter is plainBox / plainFill
// in ownMark. Then the PIXEL test (plainKept): with the container and all its content hidden — and the filters, clip-paths and
// masks of the container and its ancestors off (a drop-shadow list or a rounded clip-path never decides) — the kept boxes alone
// must paint ONE uniform colour inside each filled box's real outline (its own rounded corners, elliptical ones too, cut by every
// box up to the container that clips it: a 50%-radius progress ring has a core) and nothing outside it — only a band 1.5 px either
// side of that outline may hold a blend of that colour and what is behind (anti-aliasing). A wrapper with its own shadow or a frame
// in another colour is not plain: refused (an accepted cost). Anything else that paints counts as content.
// Not seen by the pixels: the container's own bare text and a label laid over it from outside its subtree (the DOM rule reads
// both), a part of the container outside the viewport once scrolled in, a closed shadow root, foreign content inside an ANCESTOR's
// shadow root (the probe's document sheet cannot reach it), an open shadow root attached after ownMark that forces
// visibility:visible in its own sheet (roots are collected once — a late root without that inherits the hidden host), and
// content revealed only later (a delayed out-of-flow reveal after the check). The pointer is parked away (the drive) so a hover
// tint is not counted, and a hover-revealed control is then hidden in both shots (a control the page unmounts once the pointer
// leaves counts as hidden: the page hid it). An element the page mounts in the container after a shot's marks (a re-render inside
// the screenshot's own frame) would be hidden as "outside" — checked before shots B / K / N: refused. A container inside a
// shadow root is refused (the document sheet cannot show it again). The extra pseudo-element rules are put on the container's
// subtree only, never on "everything outside" (that cost a style pass over every element of the page in every shot).

/** In the page: mark the pair clickPointControl / markOpener left in window.__dtOwn — the container [data-dt-own], its
 *  control [data-dt-own-ctl], the boxes kept in both shots [data-dt-own-keep] (CSS pre-filter), what stays on screen outside
 *  it [data-dt-own-up] (its ancestors in the flat tree, the focused element and its ancestors), the open shadow roots inside it
 *  — bring the container into view when part of it is off screen (the scroll is put back by ownClear), and say which control it
 *  is and how many boxes are kept. null = no pair (nothing to check). SELF-CONTAINED. */
export function ownMark(_arg: null): { ctl: string; keep: number; why: string | null; scrolled: boolean } | null {
  const o = window.__dtOwn;
  if (!o || !o.box.isConnected || !o.ctl.isConnected) return null;
  const { box, ctl } = o;
  // the hiding sheet lives in the document and the container is shown again by a document rule — a container inside
  // a shadow root would inherit the hidden host in every shot (A equals B whatever it shows): refused (openers are found by
  // document.querySelectorAll today, so none is in a shadow root — a guard for a later lookup)
  if ((box.getRootNode?.()?.host ?? null) !== null) return { ctl: "its sole control", keep: 0, why: "the opener lies inside a shadow root, where its pixels cannot be compared", scrolled: false };
  const dt = window.__dt;
  const up = dt.parent;
  // Chromium blurs a focused element once it is hidden: ownClear focuses it again (inside the container); one outside stays shown
  const active = document.activeElement;
  if (active && active !== document.body) o.focus = active;
  const { w: vw, h: vh } = dt.viewport();
  const r0 = box.getBoundingClientRect();
  if (r0.x < 0 || r0.y < 0 || r0.right > vw || r0.bottom > vh) {
    const boxes: DriveScroll["boxes"] = [];
    for (let p = box.parentElement; p; p = p.parentElement) boxes.push({ el: p, left: p.scrollLeft, top: p.scrollTop });
    o.saved = { x: scrollX, y: scrollY, boxes };
    box.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }
  const css = (e: PageElement, prop: string): string => getComputedStyle(e).getPropertyValue(prop).trim();
  const px = (v: string): number => parseFloat(v) || 0;
  const b = box.getBoundingClientRect(), c = ctl.getBoundingClientRect();
  // the container's padding box: what a child covering it all hides of the container's own background
  const x0 = b.x + px(css(box, "border-left-width")), y0 = b.y + px(css(box, "border-top-width"));
  const x1 = b.right - px(css(box, "border-right-width")), y1 = b.bottom - px(css(box, "border-bottom-width"));
  // the CSS pre-filter: never a replaced or form element, a clip-path, a background clipped to its content box
  // (or to text), a list item (its marker) or a shadow host
  const plainBox = (e: PageElement): boolean => !/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|FRAME|FENCEDFRAME|PROGRESS|METER|INPUT|SELECT|TEXTAREA)$/.test(e.tagName.toUpperCase())
    && (css(e, "clip-path") === "" || css(e, "clip-path") === "none")
    && css(e, "background-clip").split(",").every((v) => /^(border-box|padding-box)$/.test(v.trim()))
    && !/list-item/.test(css(e, "display")) && !e.shadowRoot;
  // only a background colour: no image, mask, border, shadow, outline or filter of its own
  const plainFill = (e: PageElement): boolean => ["background-image", "mask-image", "box-shadow", "filter", "backdrop-filter"].every((k) => { const v = css(e, k); return v === "" || v === "none"; })
    && ["top", "right", "bottom", "left"].every((side) => px(css(e, `border-${side}-width`)) === 0 || css(e, `border-${side}-style`) === "none")
    && (px(css(e, "outline-width")) === 0 || css(e, "outline-style") === "none");
  box.setAttribute("data-dt-own", "");
  ctl.setAttribute("data-dt-own-ctl", "");
  // the container's ancestors in the flat tree [data-dt-own-up] — hidden in every shot like the rest of the outside (the
  // container is shown again by its own rule), their filters / clip-paths / masks off in K and N; the focused element outside the
  // container [data-dt-own-foc] stays shown on its own (hiding it would blur it: Chromium keeps the focus of an element shown
  // under hidden ancestors — by experiment, no blur / focusout)
  for (let p = up(box); p; p = up(p)) p.setAttribute("data-dt-own-up", "");
  if (active && active !== document.body && !box.contains(active)) active.setAttribute("data-dt-own-foc", "");
  // every open shadow root inside the container (the container itself as a host too), and whether its host
  // is the control or inside it (shot A hides those)
  const roots: Array<{ root: PageShadowRoot; inCtl: boolean }> = [];
  const els: Array<{ e: PageElement; inCtl: boolean }> = [];
  const todo: Array<{ e: PageElement; inCtl: boolean }> = [{ e: box, inCtl: false }];
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
  return { ctl: dt.describe(ctl, ["type", "role", "aria-label"]), keep, why: null, scrolled: !!o.saved };
}
/** A rounded rect (viewport CSS px) with its corner radii [top-left x, y, top-right x, y, bottom-right x, y, bottom-left x, y],
 *  already scaled down as CSS does when adjacent radii overlap (CSS Backgrounds 3 §5.5). */
export interface KeptShape { x: number; y: number; right: number; bottom: number; r: number[] }
/** A kept box as the plain-paint test reads it (viewport CSS px): its border box, whether it paints a background colour, and
 *  the shapes that bound what it paints — its own rounded border box, then the rounded padding box of every box from its parent
 *  up to the container that clips (overflow not visible). */
export interface KeptRect { x: number; y: number; right: number; bottom: number; filled: boolean; shapes: KeptShape[] }
/** In the page: put up a shot's rules and say where the container is on screen (clipped to the layout viewport).
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
  // the pseudo-elements beyond ::before / ::after that a page may force visible inside the container — hidden each by
  // its own rule (an unknown one would void a whole list); Chromium 153 hides all of them by visibility (by experiment; MDN lists
  // no visibility for ::placeholder, so it also gets a transparent colour, which MDN allows). ::first-letter is only CHECKED (in
  // the "rules took" loop below), never given a rule: a ::first-letter rule rebuilds the page's text boxes, and the element under
  // the parked pointer then gets mouseout / mouseleave (by experiment) — a page side effect; its text is the DOM rule's anyway
  const EXTRA_PSEUDOS = ["::placeholder", "::file-selector-button", "::details-content", "::scroll-button(*)", "::scroll-marker", "::scroll-marker-group"];
  const extra = (sel: string): string => EXTRA_PSEUDOS.map((ps) => `${sel}${ps} { visibility: hidden !important; transition: none !important;${ps === "::placeholder" ? " color: transparent !important;" : ""} }`).join("\n");
  // everything outside the container's subtree hidden, its ancestors too (their own paint never
  // decides), and their backgrounds off (the root's would still paint the canvas); the container shown again (its
  // content inherits what it had: the page's own hidden stays hidden); the focused element outside it stays shown
  // the container's light descendants [data-dt-own-in] and the control's [data-dt-own-cin] are MARKED
  // (again at every shot: what the page mounted since counts) — compound attribute selectors cost the page's style recalc O(1)
  // per element, where `[data-dt-own] *` inside :is() / :not() walked every element's ancestors (an 8000-deep chain elsewhere on
  // the page: seconds per shot)
  // an element the page mounted in the container since the last shot's marks (a re-render inside the screenshot's
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
  // the extra pseudo-element rules are NOT put on the outside — on "every element outside" they made the browser
  // resolve those pseudo-elements for the whole page in every shot (4× slower per pair on a 75k-element page); outside, they
  // inherit the hidden visibility, and one a page forces visible paints the same in every shot (it never decides A against B)
  const outside = [`${pseudos(notOwn)} ${H}`, `${foc} ${SHOW}`, `${foc}::before, ${foc}::after ${H}`, extra(foc),
    `${lift("[data-dt-own-up]")} { background: none !important; }`].join("\n");
  const shown = `${own} ${SHOW}`;
  const content = [`${[inner, `${own}::before`, `${own}::after`, `${inner}::before`, `${inner}::after`].join(", ")} ${H}`, extra(inner), extra(own)].join("\n");
  const kept = `:is([data-dt-own-keep], ${hi}#dt-own-0) { visibility: visible !important; transition: none !important; }`;
  // in K and N a filter (a drop-shadow list, a blur), clip-path or mask on the container or an ancestor is
  // off — the kept boxes alone are judged, not what an ancestor's effect makes of them (no layout change: what a filter makes a
  // containing block for — fixed boxes — is hidden in K and N)
  const flat = `${lift(":is([data-dt-own-up], [data-dt-own])")} { filter: none !important; clip-path: none !important; mask: none !important; backdrop-filter: none !important; }`;
  const ctl = lift("[data-dt-own-ctl]"), ctlIn = lift("[data-dt-own-cin]");
  const text = arg.shot === "A" ? `${outside}\n${shown}\n${[ctl, ctlIn].map(pseudos).join(", ")} ${H}\n${extra(ctl)}\n${extra(ctlIn)}`
    // the container's own ::marker (its colour: no layout change; a marker image stays and counts)
    : arg.shot === "B" ? `${outside}\n${shown}\n${content}\n${own}::marker { color: transparent !important; }\n${kept}`
    : arg.shot === "K" ? `${outside}\n${content}\n${own} ${H}\n${kept}\n${flat}`
    : `${outside}\n${content}\n${own} ${H}\n${flat}`;
  // constructed sheets: a page's CSP (style-src without 'unsafe-inline') blocks an injected <style>, not CSSOM
  if (!o.sheet) { o.sheet = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, o.sheet]; }
  o.sheet.replaceSync(text);
  // every open shadow root inside the container hides all it holds in B / K / N; in A only those of the control
  const roots = o.roots ?? [];
  if (roots.length && !o.rootSheet) { o.rootSheet = new CSSStyleSheet(); o.rootSheet.replaceSync(`${pseudos(lift("*"))} ${H}`); }
  const rootSheet = o.rootSheet;
  for (const { root, inCtl } of roots) {
    if (!rootSheet) break;
    const rest = root.adoptedStyleSheets.filter((x) => x !== rootSheet);
    root.adoptedStyleSheets = arg.shot !== "A" || inCtl ? [...rest, rootSheet] : rest;
  }
  // the rules took (nothing of the page's beat them). A control the page took out (unmounted, or no box, once the
  // pointer left) is hidden — by the page. Every element the shot hides is checked, and its ::before / ::after when
  // they have content — a page's inline !important, or an !important inside a cascade layer (which beats any unlayered one,
  // whatever its specificity), refuses instead of showing in both shots
  const vis = (e: PageElement, pseudo: string | null = null): string => getComputedStyle(e, pseudo).getPropertyValue("visibility");
  const name = (e: PageElement): string => `<${e.tagName.toLowerCase()}>`;
  const beat = "against the probe's hiding rule (an inline or cascade-layer !important)";
  if (o.ctl.isConnected && o.ctl.getClientRects().length > 0 && vis(o.ctl) !== "hidden") return no(`the page kept its control showing ${beat}`);
  if (arg.shot !== "A" && vis(o.box, "::before") !== "hidden") return no(`the page kept the opener's own ::before showing ${beat}`);
  if (arg.shot !== "A" && vis(o.box, "::after") !== "hidden") return no(`the page kept the opener's own ::after showing ${beat}`);
  if ((arg.shot === "K" || arg.shot === "N") && vis(o.box) !== "hidden") return no(`the page kept the opener showing ${beat}`);
  // the other pseudo-elements, where they can exist (a first letter of a box's own text, a field's placeholder, a
  // file input's button, a <details>' content, a scroll container's buttons, a scroll marker and its group)
  const st = (e: PageElement, prop: string, pseudo: string | null = null): string => getComputedStyle(e, pseudo).getPropertyValue(prop).trim();
  const generated = (e: PageElement, ps: string): boolean => !/^(none|normal)?$/.test(st(e, "content", ps));
  const others = (e: PageElement): string[] => ["::first-letter", ...EXTRA_PSEUDOS].filter((ps) => ps === "::first-letter" ? Array.from(e.childNodes).some((t) => t.nodeType === 3 && /\S/.test(t.nodeValue ?? ""))
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
    // each kept box's real rounded shape — its own corner radii (elliptical: "50%" is half the width across and
    // half the height down), and the rounded padding box of every box up to the container that clips it (overflow not visible;
    // in K the container's and its ancestors' clip-paths are off)
    const len = (t: string, size: number): number => (t.endsWith("%") ? ((parseFloat(t) || 0) / 100) * size : parseFloat(t) || 0);
    const shape = (p: PageElement, inner: boolean): KeptShape => {
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
      for (let p: PageElement | null = e === o.box ? null : e.parentElement; p; p = p === o.box ? null : p.parentElement) {
        if (st(p, "overflow-x") !== "visible" || st(p, "overflow-y") !== "visible") shapes.push(shape(p, true));
      }
      const bg = st(e, "background-color");
      const filled = !(bg === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(bg));
      keep.push({ x: q.x, y: q.y, right: q.right, bottom: q.bottom, filled, shapes });
    }
  }
  return { clip: { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 }, why: null, keep };
}
/** In the page: why clickPointControl's DOM rule refused a container's sole control (null: it did not). SELF-CONTAINED. */
export function ownWhy(_arg: null): string | null {
  return window.__dtOwnWhy ?? null;
}
/** In the page: before the probe first hovers (or presses anything) on this page, remember every
 *  [role=tooltip] element and every element with an id that is ALREADY shown — not display:none, not at opacity 0 (itself or an
 *  ancestor), and visible (or holding a visible descendant: a visibility:hidden wrapper around a visible label counts as shown).
 *  ownContent's foreign walk exempts as the sole control's tooltip only one NOT remembered: a tooltip the probe's own hover (or
 *  focus) revealed. A label that was on screen before is the card's own and still refuses. Kept in a WeakSet on window, not as an
 *  attribute: a page that patches attributes (morphdom-style) could strip a mark and turn it into an exemption, and a page's
 *  MutationObserver never sees it. Once per page document (a reload starts over at the next call); no set (never run, or past
 *  500,000 elements) = no tooltip is exempt. SELF-CONTAINED. */
export function tipPreMark(_arg: null): boolean {
  if (window.__dtTipPre) return false;
  const pre = new WeakSet<PageElement>();
  const vis = (e: PageElement): boolean => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const todo: PageElement[] = [document.documentElement];
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
/** In the page: remove the probe's sheets and every marker, put back the scroll ownMark changed (instant), focus again what
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
  const el = window.__dt.find(path);
  if (!el) return false;
  el.click();
  return true;
}

/** In the page (Locator.evaluate): why clicking this element would SUBMIT a form, or null. A step must navigate,
 *  never submit: a [type=submit] / input[type=image] control, or a typeless <button> that belongs to a
 *  form (its `form` property — the closest <form>, or the one its form attribute names). The click lands on the
 *  element at its click point, which can be a submitting control INSIDE a tagged wrapper — that one is checked too.
 *  Playwright's click point (its _clickablePoint) is the middle of the element's FIRST content quad (one per box /
 *  line fragment — getClientRects) whose part inside the viewport has an area (> 0.99 px²), clipped to the viewport, after
 *  scrolling it into view (the caller runs scrollIntoViewIfNeeded first) — so an oversized wrapper is clicked at the middle
 *  of what shows, and an inline element wrapping over lines on its first line, never at the middle of its bounding box
 *  — what the mouse presses there (window.__dt.hitAt, through open shadow roots); when nothing of it is on screen, the visible controls whose box holds the full centre.
 *  (Playwright uses the true transformed quad; for a rotated/skewed element partly off screen this axis-aligned rect's
 *  centre can differ slightly.)
 *  SELF-CONTAINED. */
export function submitGuard(el: PageElement): string | null {
  const why = (target: PageElement): string | null => {
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
  const dt = window.__dt;
  const pt = dt.clickPoint(el);
  if (!pt) return null;
  const { onScreen, x: cx, y: cy } = pt;
  const at: PageElement[] = [];
  // what the mouse presses there, through open shadow roots (a web component's own submit button)
  const hit = onScreen ? dt.hitAt(cx, cy) : null;
  if (hit && hit !== el && dt.within(hit, el)) at.push(hit);
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

/** The drive clicks the opener where Playwright does (as submitGuard finds the point). When that point
 *  is an ACTIVATING control inside the opener — button-like (a role=button without tabindex too), a checkbox / radio / switch /
 *  option, a file / submit / reset input, a <label>'s control, a nested browsing context (<iframe> / <frame> / <object> /
 *  <embed> / <fencedframe>), also inside an open shadow root, also under a focusable glyph or editable label inside
 *  it — that is not the opener's own control, the click would press that control (a card's centred Delete),
 *  and the drive has no write block: its description, so the row is not driven. The opener's own control is a container's
 *  ONLY focusable, button-like, under its centre (a cell around its icon button), and the container shows nothing of its own
 *  outside it — the same rule the behaviour battery presses keys on (probe-behaviour.ts markOpener): by its DOM here and by
 *  its pixels after ({ mark: true } leaves the pair in window.__dtOwn for ownPixels; driveRow hovers the opener first, so a
 *  control shown only on :hover is at the point). An opener that is itself
 *  focusable (a role=button tabindex=0 card, an <a href> card) has no such inner control: an activating control at its point is
 *  refused. A text field there (a picker's readonly input) is clicked. null = nothing in the way.
 *  SELF-CONTAINED. */
export function clickPointControl(el: PageElement, arg?: { mark: boolean }): string | null {
  // the drive asks for the pair its pixel check compares (ownPixels) — left in window.__dtOwn only on the own-control exemption
  const mark = !!arg && arg.mark;
  if (mark) { window.__dtOwn = null; window.__dtOwnWhy = null; }
  const FOC = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  const BTN = "button, a[href], summary, [role=button i], [role=link i], [role=menuitem i], [role=tab i]";
  const ACT = `${BTN}, [role=checkbox i], [role=switch i], [role=radio i], [role=option i], [role=menuitemcheckbox i], [role=menuitemradio i], input[type=checkbox i], input[type=radio i], input[type=submit i], input[type=button i], input[type=image i], input[type=reset i], input[type=file i]`;
  // a focusable opener is never exempt — its inner control at the point is another control, not its own
  const self = el.matches(FOC);
  const dt = window.__dt;
  // Playwright's point: the middle of the first client rect's part on screen (submitGuard, fixes 4–6)
  const pt = dt.clickPoint(el);
  if (!pt) return null;
  const { onScreen, x: cx, y: cy } = pt;
  const inner = Array.from(el.querySelectorAll(FOC));
  // what the mouse presses at the point — the deepest element there, through open shadow roots (dt.hitAt: a web
  // component's own <button>; text slotted into a shadow control starts at its <slot>), then up the flat tree (a slotted node's
  // slot, a shadow root's host — the path the click's event takes) to the opener: the first focusable or activating element (a
  // role=button span without tabindex too), or a <label> with a control (its click toggles that control). An
  // ACTIVATING element anywhere on that path wins over a merely focusable one below it (a tabindex=-1 glyph or a contenteditable
  // label inside a Delete is focusable, but the click still bubbles to the Delete) — the innermost activating one is named. A
  // nested browsing context there — <iframe>, <frame>, <object>, <embed>, <fencedframe> — is a control (what is inside it cannot
  // be seen). Not seen: a closed shadow root, a bare listener (an <svg onclick>, no role).
  const up = dt.parent;
  const framed = (e: PageElement): boolean => /^(IFRAME|FRAME|OBJECT|EMBED|FENCEDFRAME)$/.test(e.tagName.toUpperCase());
  const pick = (e: PageElement): PageElement | null => (e.tagName.toUpperCase() === "LABEL" ? e.control ?? null : e.matches(FOC) || e.matches(ACT) || framed(e) ? e : null);
  const presses = (e: PageElement | null): e is PageElement => !!e && (e.matches(ACT) || framed(e));
  let at: PageElement | null = null;
  if (onScreen) {
    const from = dt.hitAt(cx, cy);
    let found: PageElement | null = null;
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
  // the container's only focusable, button-like, under its centre, with nothing of the container's own outside it —
  // the opener's own control (never for a focusable opener)
  if (!self && inner.length === 1 && inner[0] === at && at.matches(BTN)) {
    const own = dt.ownContent(el, at);
    // the DOM sees nothing of the container's own — the caller's pixel check (ownPixels) has the last word
    if (own === null) { if (mark) window.__dtOwn = { box: el, ctl: at }; return null; }
    // why the DOM rule refused it (ownWhy reads it for the row's detail)
    if (mark) window.__dtOwnWhy = `its own content: ${own}`;
  }
  return dt.describe(at, ["type", "role", "aria-label"]);
}

// ---------------------------------------------------------------- which rows are driven, the budget, the outcome
const OVERLAY_ACTIONS = new Set(["overlay", "swap"]);
const CLICK_TRIGGERS = new Set(["on_click", "on_press"]);
/**
 * The expectation rows the probe drives: visible-layer overlay/swap interactions with an on_click/on_press
 * trigger, and plan rows that expect a dialog with one of those triggers. One row per nodeId + trigger (the compare key); designed destinations
 * first — an undesigned one (destinationExported false) only when the budget allows.
 */
export function drivable(exp: Pick<VerifyExpectation, "interactions" | "hidden">): VerifyInteraction[] {
  const hidden = new Set((exp.hidden && exp.hidden.ids) || []);
  const keys = new Set<string>();
  const rows = (exp.interactions || []).filter((r) => {
    if (hidden.has(r.nodeId)) return false;
    const trigger = String(r.trigger).toLowerCase();
    // a plan dialog row is driven only for a click/press trigger too (a hover- or key-opened dialog is not clicked)
    const ok = CLICK_TRIGGERS.has(trigger) && (OVERLAY_ACTIONS.has(String(r.action).toLowerCase()) || (r.source === "plan" && r.expect === "dialog"));
    const key = `${r.nodeId}|${trigger}`;
    if (!ok || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return [...rows.filter((r) => r.destinationExported !== false), ...rows.filter((r) => r.destinationExported === false)];
}

/** What the probe saw, as an outcome for the row's action. */
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

/** ok:true only with every piece of evidence; otherwise ok:null and the missing pieces in words. Never false. */
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
export interface DriveOptions {
  rows: VerifyInteraction[];
  /** the drive's share (session.budget("drive")), in ms from now */
  budgetMs: number;
}
export interface DriveHooks {
  /** seam for the behaviour checks: called with the page while the opened element is open */
  afterOpen?(page: Page, row: VerifyInteraction, opened: NonNullable<DetectorRead["opened"]>): Promise<void>;
}

/** Two animation frames: whatever the last action changed has been laid out and painted. The expression is a string, so
 *  nothing from this module's scope is serialised into the page. */
export const raf2 = (page: Page): Promise<unknown> => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
const notRun = (row: VerifyInteraction, detail: string, extra?: Partial<InteractionEvidence>): InteractionEvidence => ({ nodeId: row.nodeId, trigger: row.trigger, ok: null, detail: `not-run: ${detail}`, ...extra });

/** The signed distance (CSS px; < 0 inside) from (px, py) to a rounded rect — its rect, or by the corner's
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
/** Do the kept boxes paint PLAIN? `k`: only the kept boxes painted, `n`: nothing of the container painted (the same clip, CSS
 *  px). Each pixel's centre is placed against each filled box's shapes (its own rounded rect and the clipping ones up to the
 *  container: the real rounded outline, not whole corner squares): the CORE (more than 1.5 px inside all of them)
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

/** Shared by the drive and the behaviour battery's markOpener: the pixel half of "the container shows nothing of
 *  its own" for the pair clickPointControl / markOpener left in window.__dtOwn — shot A (only the control hidden) against shot B
 *  (all the container's content hidden), everything outside the container — its ancestors too — hidden in both,
 *  clipped to the container's box on screen, animations:"disabled", caret hidden, CSS pixels; two frames before shot A only (the
 *  later shots change nothing but the probe's sheet, which a screenshot paints first). The PNGs are compared byte
 *  for byte: equal pixels encode the same, and anything that differs (a video, a canvas animation) refuses — the safe side. When
 *  boxes were kept as decoration and A equals B, two more shots (K: only the kept boxes painted; N: nothing of the container)
 *  must show them plain (plainKept). `park`: the pointer goes to (0, 0) first, so a hover tint is not counted (the caller
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
      // two frames only before the first shot, and only after the park or the scroll into view (so a hover or an
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
    if (!a.png.equals(b.png)) return { ctl, why: "the opener paints something of its own beside it (its screenshot with only that control hidden differs from the one with all its content hidden)" };
    if (m.keep === 0) return { ctl, why: null };
    const k = await shot("K", a.clip);
    if (typeof k === "string") return { ctl, why: k };
    const n = await shot("N", a.clip);
    if (typeof n === "string") return { ctl, why: n };
    const plain = plainKept(decodePng(k.png), decodePng(n.png), k.clip, k.keep);
    return { ctl, why: plain === null ? null : `a box kept as the opener's decoration is not a plain fill — ${plain} (alone it must paint one uniform colour)` };
  } catch (e) {
    return { ctl, why: `its own content could not be compared by pixels (${firstLine(e)})` };
  } finally {
    await page.evaluate(ownClear, null).catch(() => undefined);
  }
}

/** restoreScroll, two frames, scrollHeld — again until it holds twice in a row (≤ RESTORE_CAP_MS). */
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

// ---------------------------------------------------------------- opening an overlay: one protocol
// The drive (driveRow) and the behaviour battery (its key unit's mouse and key opens, its scroll unit's open at a scroll)
// open an overlay the same way, here: find the opener, scroll it in (or not), the submit guard, the hover reveal, the
// pointer on the click point, the guard again, the click point's own control (DOM, then pixels), arm the detector, activate
// (a real click with a synthetic fallback, a click at the point without scrolling, or a key the caller presses), and poll.
// The callers only judge what came back.

/** In the page: where the mouse would press the element at `path` without scrolling — Playwright's click point
 *  (window.__dt.clickPoint), whether it is on screen, and whether what the mouse presses there (window.__dt.hitAt, through
 *  open shadow roots) is the element or inside it. null: it is gone or has no size. SELF-CONTAINED. */
export function pointOn(path: string): { x: number; y: number; onScreen: boolean; hits: boolean } | null {
  const dt = window.__dt;
  const el = dt.find(path);
  const pt = el ? dt.clickPoint(el) : null;
  if (!el || !pt) return null;
  return { x: pt.x, y: pt.y, onScreen: pt.onScreen, hits: pt.onScreen && dt.within(dt.hitAt(pt.x, pt.y), el) };
}

/** Why openOverlay did not activate the opener. */
export type OpenRefusal =
  | { kind: "count"; count: number }
  | { kind: "disabled" }
  | { kind: "submits"; what: string }
  | { kind: "hidden" }
  | { kind: "not-own"; ctl: string; why?: string }
  /** scroll:false — its click point is off screen at this scroll, or something else is on top there */
  | { kind: "off-screen" }
  /** synthetic:false — the real click could not land */
  | { kind: "click"; what: string }
  /** the key was not pressed (the caller's press said why) */
  | { kind: "key"; what: string };
/** How the opener was activated: the real mouse, a synthetic click in the page (never a user activation), or a key. */
export type OpenActivation = ProbeActivation | "key";
export interface OpenOverlayOptions {
  activation: "mouse" | "key";
  /** key: press the key on the opener (the caller focused it) — why it was NOT pressed, or null when it was */
  press?: () => Promise<string | null>;
  /** mouse: false — open at the page's current scroll: the pointer moves to the points (a locator action would scroll the
   *  opener in), and the click lands only where the opener is on top at its on-screen click point. Default true. */
  scroll?: boolean;
  /** mouse: when the real click cannot land (hidden, covered), a synthetic click in the page. Default true; false refuses
   *  instead. */
  synthetic?: boolean;
  /** before each page action (the behaviour unit arms its write block and records the action) */
  act?: () => void;
  /** after every guard, just before the detector is armed (the drive reads its load count, the battery marks the opener) */
  beforeActivate?: () => Promise<void>;
}
export interface OverlayOpen {
  /** what opened (null: nothing within OPEN_POLL_MS, a document load, or not activated) */
  opened: DetectorRead["opened"];
  /** why the opener was not activated (refused, in words), or null */
  why: string | null;
  refused: OpenRefusal | null;
  /** null when not activated */
  activation: OpenActivation | null;
  detectedBy: string | null;
  /** the detector's last read (dest, lost) */
  read: DetectorRead;
  /** elements tagged with the opener's id (outside a closed dialog) */
  selectorCount: number;
  /** the ancestor hovered to reveal it */
  revealedBy?: string;
  /** a synthetic click: why the real one could not land */
  clickWhy?: string;
}
/** The detector polls every 100 ms for ≤ OPEN_POLL_MS after the activation; once something opened, ≤ OPEN_GRACE_MS more
 *  (from that first detection) for the destination tag to land inside it. */
export const OPEN_POLL_MS = 2_000;
export const OPEN_GRACE_MS = 500;
const NO_READ: DetectorRead = { lost: false, detectedBy: null, opened: null, dest: null };
/** The refusal in words (the behaviour battery's not-run reasons; the drive words its own). */
export function refusalWhy(r: OpenRefusal, selector: string, revealedBy?: string): string {
  switch (r.kind) {
    case "count": return `the opener ${selector} matched ${r.count} element(s) outside a closed dialog`;
    case "disabled": return "the opener is disabled";
    case "submits": return `the opener would submit a form (${r.what})`;
    case "hidden": return `the opener is not visible even on hover${revealedBy !== undefined ? ` (hovered ${revealedBy})` : " (no visible ancestor to hover)"}`;
    case "not-own": return `the opener's click point is another control inside it (${r.ctl}) — tag that control or the opener's own clickable element${r.why !== undefined ? ` (${r.why})` : ""}`;
    case "off-screen": return "the opener's click point is off screen at this scroll, or something else is on top there";
    case "click": return `the real click could not land (${r.what})`;
    case "key": return r.what;
  }
}
/** Poll the armed detector: ≤ OPEN_POLL_MS, and ≤ OPEN_GRACE_MS after the first detection for the destination tag. A
 *  replaced document is read as lost; a closed or crashed page, or any other failure, throws. */
async function detectOpen(page: Page, destId: string | null, contract: readonly string[]): Promise<DetectorRead> {
  const t0 = Date.now();
  let read: DetectorRead = NO_READ;
  let detectedAt: number | null = null;
  for (;;) {
    try { read = await page.evaluate(pollDetector, { destId, contract }); } catch (e) {
      if (pwErrorKind(e, page) !== "navigated") throw e;
      return { lost: true, detectedBy: null, opened: null, dest: null };
    }
    if (read.lost) return read;
    if (read.opened !== null && detectedAt === null) detectedAt = Date.now();
    if (read.opened !== null && (destId === null || (read.dest !== null && read.dest.inside))) return read;
    if (detectedAt !== null && Date.now() - detectedAt >= OPEN_GRACE_MS) return read;
    if (Date.now() - t0 >= OPEN_POLL_MS) return read;
    await sleep(100);
  }
}
/**
 * Open the row's overlay: the one sequence the drive and the behaviour battery share. Mouse: the opener (exactly one,
 * enabled), scrolled into view as Playwright's click does it (scroll:false: not), the submit guard, a hover-hidden opener
 * revealed by hovering its nearest visible (tagged) ancestor, the pointer on the click point first (a control revealed on
 * :hover is under it only then), the submit guard again, the click point's own control (clickPointControl, then ownPixels),
 * then the detector armed and the click — a real one with a synthetic fallback (synthetic:false: refused), or with
 * scroll:false a mouse click at the on-screen point only where the opener is on top. Key: the detector armed and the
 * caller's press. Then the poll (OPEN_POLL_MS, OPEN_GRACE_MS after the first detection). Never judges what opened.
 */
export async function openOverlay(page: Page, row: VerifyInteraction, o: OpenOverlayOptions): Promise<OverlayOpen> {
  const act = o.act ?? ((): void => undefined);
  const destId = row.destinationId ?? null;
  const contract = [...DIALOG_CONTRACT];
  const selector = `[data-dt-node="${row.nodeId.replace(/["\\]/g, "\\$&")}"]`;
  let selectorCount = 1;
  let revealedBy: string | undefined;
  const refuse = (r: OpenRefusal): OverlayOpen => ({ opened: null, why: refusalWhy(r, selector, revealedBy), refused: r, activation: null, detectedBy: null, read: NO_READ, selectorCount,
    ...(revealedBy !== undefined ? { revealedBy } : {}) });
  const finish = async (activation: OpenActivation, clickWhy?: string): Promise<OverlayOpen> => {
    const read = await detectOpen(page, destId, contract);
    return { opened: read.lost ? null : read.opened, why: null, refused: null, activation, detectedBy: read.lost ? null : read.detectedBy, read, selectorCount,
      ...(revealedBy !== undefined ? { revealedBy } : {}), ...(clickWhy !== undefined ? { clickWhy } : {}) };
  };
  if (o.activation === "key") {
    if (o.beforeActivate) await o.beforeActivate();
    await page.evaluate(armDetector, { destId, contract });
    const blocked = o.press ? await o.press() : "no key to press";
    return blocked !== null ? refuse({ kind: "key", what: blocked }) : finish("key");
  }
  const scroll = o.scroll !== false;
  let st = await page.evaluate(openerState, { id: row.nodeId });
  selectorCount = st.count;
  if (st.count !== 1 || st.path === null) return refuse({ kind: "count", count: st.count });
  // a disabled opener is not clicked (an aria-disabled one would still run the app's handler — a real write)
  if (st.disabled) return refuse({ kind: "disabled" });
  // nor one whose click submits a form (the probe navigates and opens, never submits) — judged where the click will land,
  // scrolled into view the way Playwright's click does it first
  if (scroll && st.visible) { act(); await byPath(page, st.path).first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined); }
  const submits = await byPath(page, st.path).first().evaluate(submitGuard);
  if (submits !== null) return refuse({ kind: "submits", what: submits });
  // what is on screen before the probe's first hover — a tooltip shown before it is not the control's
  await page.evaluate(tipPreMark, null).catch(() => false);
  if (!st.visible) {
    // hover-reveal path: park the pointer, hover the nearest visible (tagged) ancestor, two frames, look again
    if (st.hoverPath !== null) {
      revealedBy = st.hoverDt !== null ? `[data-dt-node="${st.hoverDt}"]` : st.hoverPath;
      act();
      await page.mouse.move(0, 0);
      if (scroll) await byPath(page, st.hoverPath).first().hover({ timeout: 2000 }).catch(() => undefined);
      else {
        const hp = await page.evaluate(pointOn, st.hoverPath);
        if (hp !== null && hp.onScreen) await page.mouse.move(hp.x, hp.y);
      }
      await raf2(page);
      st = await page.evaluate(openerState, { id: row.nodeId });
    }
    if (!st.visible || st.path === null) return refuse({ kind: "hidden" });
  }
  const openerPath = st.path;
  const loc = byPath(page, openerPath).first();
  // the pointer goes where the click will put it FIRST — a row action revealed on :hover (by visibility, display or
  // pointer-events) is under the click point only then, and the click would land on it. force: no 2 s actionability wait
  // (a covered opener); two frames for the hover styles; the submit guard looks again
  act();
  if (scroll) await loc.hover({ timeout: 2000, force: true }).catch(() => undefined);
  else {
    const p = await page.evaluate(pointOn, openerPath);
    if (p === null || !p.onScreen) return refuse({ kind: "off-screen" });
    await page.mouse.move(p.x, p.y);
  }
  await raf2(page);
  const submitsHovered = await loc.evaluate(submitGuard);
  if (submitsHovered !== null) return refuse({ kind: "submits", what: submitsHovered });
  // nor one whose click point is another control inside it (a card's centred Delete)
  const inner = await loc.evaluate(clickPointControl, { mark: true });
  if (inner !== null) {
    const why = await page.evaluate(ownWhy, null).catch(() => null);
    return refuse({ kind: "not-own", ctl: inner, ...(why !== null ? { why } : {}) });
  }
  // a container's sole control the DOM check let through — the pixels decide (the pointer parked away, unless the opener
  // only shows while its ancestor is hovered: the hover-reveal path keeps that hover). It may scroll the container in and back.
  act();
  const px = await ownPixels(page, { park: revealedBy === undefined });
  if (px !== null && px.why !== null) return refuse({ kind: "not-own", ctl: px.ctl, why: px.why });
  if (o.beforeActivate) await o.beforeActivate();
  await page.evaluate(armDetector, { destId, contract });
  if (!scroll) {
    // the pointer back on the point (the pixel check may have parked it), two frames, and the opener must be on top there
    let p = await page.evaluate(pointOn, openerPath);
    if (p !== null && p.onScreen) {
      act();
      await page.mouse.move(p.x, p.y);
      await raf2(page);
      p = await page.evaluate(pointOn, openerPath);
    }
    if (p === null || !p.hits) return refuse({ kind: "off-screen" });
    act();
    await page.mouse.click(p.x, p.y);
    return finish("mouse");
  }
  await loc.evaluate(saveScroll);
  act();
  try {
    await loc.click({ timeout: 2000 });
  } catch (e) {
    const kind = pwErrorKind(e, page);
    if (kind === "gone") throw e;
    if (kind !== "navigated") {
      // hidden or covered (TimeoutError after the full 2 s)
      const what = (/intercepts pointer events|not visible|not enabled|not stable|outside of the viewport/.exec(errMsg(e)) || [firstLine(e)])[0] ?? "";
      // from the scroll the probe had, never from where the retries left the page — and still there two frames later,
      // twice in a row: a smooth scroll Playwright's last retry started can outlive one restore
      await restoreSettled(page);
      if (o.synthetic === false) return refuse({ kind: "click", what });
      // a click in the page — never a user activation
      await page.evaluate(syntheticClick, openerPath);
      return finish("synthetic", what);
    }
  }
  return finish("mouse");
}

/** One row on the screen its unit reached (the session closes the context after it). */
async function driveRow({ page, loads }: Reached, row: VerifyInteraction, hooks: DriveHooks | undefined): Promise<InteractionEvidence> {
  const action = row.source === "plan" && row.expect === "dialog" ? "overlay" : String(row.action ?? "overlay").toLowerCase();
  const destId = row.destinationId ?? null;
  const selector = `[data-dt-node="${row.nodeId.replace(/["\\]/g, "\\$&")}"]`;
  let tokenBefore = "", loadsBefore = 0;
  const r = await openOverlay(page, row, { activation: "mouse", beforeActivate: async () => {
    tokenBefore = String(await page.evaluate("window.__dtProbeDoc || ''"));
    loadsBefore = loads();
  } });
  const base: InteractionEvidence = { nodeId: row.nodeId, trigger: row.trigger, selector, selectorCount: r.selectorCount };
  const revealedBy = r.revealedBy;
  const revealed = revealedBy !== undefined ? { revealedBy } : {};
  if (r.refused !== null) {
    const f = r.refused;
    const detail = f.kind === "count" ? `the opener ${selector} matched ${f.count} element(s) outside a closed dialog — not driven`
      : f.kind === "disabled" ? "opener is disabled — not driven"
      : f.kind === "submits" ? `opener would submit a form (${f.what}) — not driven`
      : f.kind === "hidden" ? `opener not visible even on hover${revealedBy !== undefined ? ` (hovered ${revealedBy})` : " (no visible ancestor to hover)"} — not driven`
      // the drive has no write block
      : f.kind === "not-own" ? `the opener's click point is another control inside it (${f.ctl}) — tag that control or the opener's own clickable element — not driven${f.why !== undefined ? ` (${f.why})` : ""}`
      : `${r.why ?? "not activated"} — not driven`;
    return { ...base, ok: null, ...(f.kind === "count" || f.kind === "disabled" ? {} : revealed), detail };
  }
  const read = r.read;
  const activation: ProbeActivation = r.activation === "synthetic" ? "synthetic" : "mouse";
  if (read.lost) await page.waitForLoadState("load", { timeout: 2000 }).catch(() => undefined);
  let tokenAfter = "";
  try { tokenAfter = String(await page.evaluate("window.__dtProbeDoc || ''")); } catch { tokenAfter = ""; }
  const navEvents = Math.max(loads() - loadsBefore, tokenAfter !== tokenBefore || read.lost ? 1 : 0);
  const { outcome, detectedBy } = read.lost ? { outcome: "none" as const, detectedBy: undefined } : classifyOutcome(action, read);
  const ev: InteractionEvidence = {
    ...base, outcome, navEvents, activation,
    ...(detectedBy !== undefined ? { detectedBy } : {}),
    ...revealed,
    ...(destId !== null ? { destination: { nodeId: destId, inside: !read.lost && !!read.dest && read.dest.inside, count: read.dest ? read.dest.count : 0 } } : {}),
    ...(read.opened && !read.lost ? { opened: read.opened } : {}),
  };
  const j = judge(action, ev);
  const how = `${activation === "mouse" ? "clicked" : `synthetic click (${r.clickWhy ?? ""})`}${revealedBy !== undefined ? ` after hovering ${revealedBy}` : ""}`;
  const saw = read.lost ? "the page loaded a new document" : detectedBy !== undefined ? `${detectedBy === "destination-tag" ? "the destination tag appeared" : `${detectedBy} opened`}` : "nothing opened";
  ev.ok = j.ok;
  ev.detail = j.ok ? `${how}: ${saw}, destination ${destId} inside` : `${how}: ${saw} — ${j.missing.join("; ")}`;
  if (hooks && hooks.afterOpen && read.opened && !read.lost) await hooks.afterOpen(page, row, read.opened);
  return ev;
}

/** What driveInteractions returns: a row each, and whether the browser stopped answering (a cut row's context
 *  close and the row did not wind down within CUT_SETTLE_MS) — then the rows after it are not driven. */
export interface DriveResult { evidence: InteractionEvidence[]; wedged: boolean }
/**
 * Drive every row (drivable()), each as a session unit (a fresh page in a fresh context), within the drive's share. A row
 * the budget does not reach is {ok:null, cut:"budget"}; a row that throws is ok:null with why. Never throws for a row.
 * Returns by about budgetMs + CUT_SETTLE_MS even when the browser stops answering.
 */
export async function driveInteractions(session: ProbeSession<unknown>, o: DriveOptions, hooks?: DriveHooks): Promise<DriveResult> {
  const out: InteractionEvidence[] = [];
  const end = Date.now() + o.budgetMs;
  let wedged = false;
  for (const row of o.rows) {
    if (wedged) { out.push(notRun(row, "the browser stopped answering")); continue; }
    const left = end - Date.now();
    if (left <= 0) { out.push(notRun(row, "time budget", { cut: "budget" })); continue; }
    const r = await session.unit<InteractionEvidence>({
      ms: left,
      act: (reached) => driveRow(reached, row, hooks),
      unreached: (f) => notRun(row, f.why, f.steps !== undefined ? { stepsFailed: f.steps } : undefined),
      failed: (e) => {
        if (pwErrorKind(e) === "gone") return notRun(row, `the page or browser closed or crashed while driving — ${pwFirstLine(e)}`);
        return { nodeId: row.nodeId, trigger: row.trigger, ok: null, detail: `driving failed: ${firstLine(e)}` };
      },
    });
    if (r.cut) {
      out.push(notRun(row, "time budget", { cut: "budget" }));
      if (!r.settled) wedged = true;
      continue;
    }
    out.push(r.value);
  }
  return { evidence: out, wedged };
}
