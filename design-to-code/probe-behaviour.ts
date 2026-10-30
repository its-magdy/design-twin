// probe-behaviour.ts — the shipped probe's behaviour/accessibility checks. They run AFTER the measurement pass and the drive,
// each unit a session unit (probe-session.ts: a fresh page in a fresh browser context, plus the write block below), on their own time budget
// (a battery unit: its own share of it) — and they never change the fidelity verdict:
// what they find goes to measured.behaviour, which verify-screen --compare copies into a second headline.
//
// Why: verifier agents drove keyboard, focus and forced-colour checks by hand, differently every round (or not at all), and
// focus that fell to <body> after closing a dialog opened from a hover-revealed row action, a listbox whose Escape also closed
// its dialog, focus rings removed by a utility class and mask icons that vanish under forced colours shipped as "verified".
// These are measurable; this module measures them the same way every run.
//
// Run shape (verify-probe.ts calls runBehaviour after driving the overlays; check ids are BehaviourCheckId):
//   P1 (a11y): landmarks, axe-core (when the PROJECT has it), one Tab walk from a focused sentinel.
//   P2 (render): forced colours (mask icons), then design / 1024 / 320 widths by a live viewport change.
//   per battery row (a driven overlay whose drive evidence opened a modal by a real mouse click):
//      R-key: keyboard activation, focus on open, focus trap, Escape closes, focus return, nested Escape — one Escape
//      per open (a second Escape on the same open is not independent);
//      R-scroll: scroll-open (y = 0 / 150 / max), scrim, click-outside.
//   A unit the budget does not reach (or cuts) reports its checks `not-run: time budget` and sets behaviour.cut; a document
//   load inside a unit makes its remaining checks `not-run: the page loaded a new document`; a unit whose page, once reached,
//   shows materially other tagged elements than the measured page (an error / empty state) reports them all not-run.
//
// Never destructive: nothing that submits is clicked (submitGuard), a dialog is closed only by Escape, a click
// outside it on a non-control point, or a visible control named Cancel / Close / Dismiss / No / Not now / × (safe close);
// nothing is typed. The safety net under all of it is the write block (openWriteBlock / openUnitPage): from a unit's first
// key press / click / scroll / hover / resize on, no request but GET/HEAD/OPTIONS leaves the browser, no WebSocket message
// leaves the page and no WebSocket opened then reaches the server; the checks the write is charged to are not-run. A write
// the page defers past the unit's end is never sent and never seen (WRITE_BLOCK_SCOPE). The drive has no write block, and its
// afterOpen hook is NOT used: battery time inside driveRow's cut timer could cut a drive row and change interaction evidence,
// i.e. the verdict.
//
// The page-side functions below are handed to page.evaluate, so — as in probe-page.ts / probe-drive.ts — each one is
// SELF-CONTAINED (no outer reference but the page runtime, window.__dt — page-runtime.ts; plain JSON in and out), typed by
// the DOM types of page-dom.ts; the e2e test runs
// the BUILT bundle in a real browser. Platform facts (Chromium 153 / Playwright 1.63, verified):
// a focused sentinel is required for a Tab walk (Chromium starts sequential focus at the last click) and the walk stops at the
// sentinel OR body; :hover matching is unreliable (computed style only); ::backdrop is read only while :modal; clip
// screenshots with animations:"disabled" are byte-stable; Chromium forces every background colour to Canvas under forced
// colours, so CSS-mask icons painted with background-color vanish (SVG fill/stroke, <img>, url() backgrounds do not).
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BehaviourAxe, BehaviourCheck, BehaviourCheckId, BehaviourLandmark, BehaviourStatus, BehaviourWidth, InteractionEvidence, JsonObject, MeasuredBehaviour, PageOverflow, VerifyExpectation, VerifyInteraction } from "./types.ts";
import { DIALOG_CONTRACT, armDetector, drivable, openerState, ownPixels, pollDetector, raf2, readPageOverflow, submitGuard, tipPreMark } from "./probe-drive.ts";
import type { DetectorRead } from "./probe-drive.ts";
import { unitCap } from "./probe-session.ts";
import type { ProbeSession } from "./probe-session.ts";
import { firstLine } from "../bridge/src/errmsg.ts";
import { pwErrorKind, pwFirstLine } from "./pw-errors.ts";
import { parseCssColor } from "./color.ts";
import { byPath } from "./page-runtime.ts";
import type { BehState, PageDocument, PageElement, PageStyle, PageWindow } from "./page-dom.ts";

// ---------------------------------------------------------------- the page, as far as these functions use it (page-dom.ts)
declare const document: PageDocument;
declare const window: PageWindow;
declare const scrollX: number;
declare const scrollY: number;
declare const innerWidth: number;
declare const innerHeight: number;
declare function getComputedStyle(el: PageElement, pseudo?: string | null): PageStyle;
declare function requestAnimationFrame(cb: () => void): number;

// ---------------------------------------------------------------- pure helpers (unit-tested in test/verify-probe.test.ts)

/** The write block's scope, one line: measured.behaviour.writeBlock → report.behaviour.writeBlock and its md. */
export const WRITE_BLOCK_SCOPE = "per unit, from its first key press, click, scroll, hover or resize on, no request but GET/HEAD/OPTIONS leaves the browser " +
  "(the page, its frames, workers, shared workers and service workers alike), no WebSocket message leaves the page and a WebSocket the page " +
  "opens then never reaches the server — a blocked write makes every check of that unit from its first action on not-run; not blocked: " +
  "the page's load and --steps, a GET with a side effect, a WebSocket opened inside a worker, and the drive of the interactions " +
  "(no write block there: it never clicks an opener that would submit, nor one whose click point is another activating control (also under a " +
  "focusable glyph or editable label inside it), a label's control or a nested page (an iframe, object or embed) — open shadow roots included — " +
  "unless it is the sole button-like control of a container showing nothing of its own (no text, image, icon, CSS mask, generated content, " +
  "filled block, progress bar, meter or list marker; a label at opacity 0 in flow counts, an out-of-flow tooltip at opacity 0 does not) by " +
  "its DOM nor by its pixels (the container with only that control hidden against it with all its content hidden — the content of " +
  "its open shadow roots, its own marker and its other pseudo-elements (a first letter, a placeholder, a file button, a details' content, scroll " +
  "buttons and markers) too — everything outside it, its ancestors included, hidden in both, the opener hovered first so a control shown on hover " +
  "is at its click point — any painted difference counts, a stripe or a 1-px divider too; decoration: its own background colour, a border in one " +
  "colour (a 1-px divider on one side too) and its shadow, and a fill over all of it or a wrapper within 8 px of the control only when, alone " +
  "(ancestor and own filters, clip-paths and masks off), they paint one plain colour (pixel-verified against their real rounded outline, a " +
  "1.5-px anti-aliased edge allowed; a progress ring, a wrapper with its own shadow or a frame in another colour is not plain, so refused); " +
  "content too: its own background image (a gradient, a url), a border in two colours or a stripe, a scroll button, and a label, image or " +
  "generated label laid at least half over it from outside its element (a sibling, an ancestor's ::after) unless fixed or sticky (a toast, a " +
  "banner: ignored) or proven to lie under its opaque background; an ancestor's own paint (a row's gradient behind a transparent cell) is not " +
  "its own; a page rule keeping something showing against the probe's (an inline or cascade-layer !important) refuses; not seen: the inside of " +
  "an iframe, a closed shadow root, foreign content inside an ancestor's shadow root, a shadow root attached after the check starts, a part of " +
  "the container still outside the viewport once scrolled in, content revealed after a delay, a generated label of an element lying elsewhere; " +
  "the probe's init CSS is lost when a page replaces document.adoptedStyleSheets after load under a strict style CSP; an sr-only label at " +
  "right:-9999px in a right-to-left page counts, so that cell is refused; the hover runs on every opener, so a mouseenter side effect also " +
  "fires on one it then refuses); the same exemption, content too — its own inset box-shadow offset 2 px or more or blurred (a stripe, a fill, a glow), sharp " +
  "box-shadow ring layers in more than one colour (not its border, not a layer in its own background colour where that cannot show — an " +
  "outer one, a ring-offset, or an inset one over an opaque border-box / padding-box background) and its own " +
  "paint under a mask or a clip-path other than a rounded inset(0); never foreign — a tooltip revealed by the probe's hover (a " +
  "[role=tooltip] element, or the control's aria-describedby target, not shown before the hover; one already on screen is its own label and " +
  "refuses) and a label at effective opacity 0; " +
  "under it only with no opacity below 1 or blend mode on it or above it; an element the page mounts in it during the screenshots refuses; " +
  "refused by rule: a page of more than 500,000 elements, an opener whose content is re-created while it is compared (an empty spacer a " +
  "framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on mouseleave; it can differ between runs), an opener " +
  "inside a shadow root, a role-less tooltip or other popover laid over it " +
  "(with a show delay the result can differ between runs), a cell whose sole control has a tooltip pre-mounted but hidden by transform " +
  "scale(0) or moved off-screen (it counts as shown before the hover), a label under an oklch() / lab() / color() background (never " +
  "proven opaque); not seen (known misses, the drive can write): a sibling's relative ::before shifted over it from elsewhere, text " +
  "overflowing a 0-height wrapper beside it, a display: contents [role=tooltip] or aria-describedby target laid over it, a label the page " +
  "re-creates as a new element on the hover with tooltip semantics (role=tooltip, or the control's aria-describedby target), and a page " +
  "that defines window.__dtTipPre itself first turns the record of what was shown before the hover off (an adversarial page); the focused element " +
  "outside it stays shown in both shots; a refusal names its reason; " +
  "it does not see a control in a closed shadow root or one that is only a click listener with no role (a bare svg onclick), and clicks those); not seen: a write the " +
  "page defers past the unit's end (an undo window over about 1 s) — it never leaves (the unit's context is closed first), but the check " +
  "that caused it is judged as if nothing was written and the scroll unit may press that key again";
/** a unit's page stays open WRITE_SETTLE_MS after its last action, so a write deferred that long (an undo window) is still
 *  seen and charged; a later one never leaves — the context is closed first — and is never seen (a known miss,
 *  stated in WRITE_BLOCK_SCOPE and the verify SKILL's Limits). */
export const WRITE_SETTLE_MS = 500;
/** What a unit did, in order: the checks it entered (seq increasing) and its actions (each in the check then in progress). */
export interface UnitTrace { phases: Array<{ seq: number; keys: string[] }>; actions: Array<{ at: number; seq: number }> }
/** the phase keys ("id|variant") a blocked write taints — every check of the unit from its FIRST action on.
 *  A write is only blocked once the unit has acted, and the action that caused it can be any of them: a commit deferred
 *  by an undo window lands while a later check runs, and how late is the page's choice (a unit is one opener's battery, so one
 *  more not-run row per write is the price of never leaving the cause judged). */
export function taintedPhases(trace: UnitTrace): string[] {
  const first = trace.actions[0];
  const from = first ? first.seq : 0;
  return [...new Set(trace.phases.filter((p) => p.seq >= from).flatMap((p) => p.keys))];
}
/** does a unit's page differ MATERIALLY from the measured one? Both sides are the data-dt-node ids on a visible
 *  element with a box, outside closed dialogs, once the screen is reached and settled (verify-probe's pass, visibleTags here).
 *  Material: the unit's page shows none of the measured tags, or more than max(5, 20 % of every tag seen on either page) are on
 *  one side only — a handful of hover-only, animated or late nodes never trips it; an error, empty or signed-out screen
 *  does. Also material when a tag the unit is about to use (`uses`: a battery row's opener and destination) was
 *  visible on the measured page and is not now — on a real-size screen an empty table or a missing row stays under the
 *  threshold, and its opener would be judged missing ("matched 0 element(s)"). null = the same page (or nothing measured to
 *  compare); else what differs, for the not-run reason. */
export function fingerprintDiff(measured: readonly string[], unit: readonly string[], uses: readonly string[] = []): string | null {
  const m = new Set(measured), u = new Set(unit);
  if (!m.size) return null;
  const missing = [...m].filter((x) => !u.has(x)), extra = [...u].filter((x) => !m.has(x));
  const seen = new Set([...m, ...u]).size;
  const list = (xs: string[]): string => `${xs.slice(0, 5).join(", ")}${xs.length > 5 ? ` +${xs.length - 5} more` : ""}`;
  if (missing.length < m.size && missing.length + extra.length <= Math.max(5, 0.2 * seen)) {
    const gone = [...new Set(uses)].filter((x) => m.has(x) && !u.has(x));
    return gone.length ? `${list(gone)} — used by this check, shown on the measured page — not shown` : null;
  }
  return `${missing.length} of ${m.size} measured tag(s) not shown${missing.length ? `: ${list(missing)}` : ""}${extra.length ? `; ${extra.length} not on the measured page: ${list(extra)}` : ""}`;
}

export const NAMES_COMPUTED_BY = "Playwright (Chromium) — computed, not screen-reader verified";
const LANDMARK_ROLES = new Set(["banner", "main", "navigation", "complementary", "contentinfo", "region", "form", "search"]);
const unescapeQuoted = (s: string): string => s.replace(/\\(.)/g, "$1");

/** Landmarks of a locator("body").ariaSnapshot() YAML, with the index of each one's nearest enclosing landmark (null at
 *  the top). Lenient (the format is unversioned): a line is `<indent>- role "name"…`, depth = indent / 2; lines that
 *  are not list items are skipped. null = unparseable (non-empty text with no list item at all). */
export function parseAriaLandmarkTree(yaml: string): { landmarks: BehaviourLandmark[]; parent: Array<number | null> } | null {
  if (typeof yaml !== "string") return null;
  const lines = yaml.split("\n");
  if (!lines.some((l) => /^\s*- /.test(l))) return yaml.trim() === "" ? { landmarks: [], parent: [] } : null;
  const landmarks: BehaviourLandmark[] = [];
  const parent: Array<number | null> = [];
  /** open landmarks (index into landmarks) */
  const stack: number[] = [];
  for (const line of lines) {
    const item = /^(\s*)- /.exec(line);
    if (!item) continue;
    const depth = Math.floor((item[1] ?? "").length / 2);
    for (let top = stack.at(-1); top !== undefined && (landmarks[top]?.depth ?? -1) >= depth; top = stack.at(-1)) stack.pop();
    const m = /^(\s*)- (banner|main|navigation|complementary|contentinfo|region|form|search)(?: "((?:[^"\\]|\\.)*)")?(?=$|[:\s[])/.exec(line);
    if (!m || !LANDMARK_ROLES.has(m[2] ?? "")) continue;
    const name = m[3] !== undefined ? unescapeQuoted(m[3]) : null;
    landmarks.push({ role: m[2] ?? "", name: name === "" ? null : name, depth });
    parent.push(stack.at(-1) ?? null);
    stack.push(landmarks.length - 1);
  }
  return { landmarks, parent };
}
/** The landmarks alone (behaviour.landmarks), or null when unparseable. */
export function parseAriaLandmarks(yaml: string): BehaviourLandmark[] | null {
  const t = parseAriaLandmarkTree(yaml);
  return t ? t.landmarks : null;
}
const lmName = (l: BehaviourLandmark): string => `${l.role}${l.name !== null ? ` "${l.name}"` : ""}`;
/** a11y.landmarks rows: >1 main fail; 0 main, >6 regions, a nested region repeating its parent's name, duplicate
 *  role+name, >1 navigation with an unnamed one, an unnamed explicit [role=region] → warn; nothing → one pass row. */
export function landmarkFindings(tree: { landmarks: BehaviourLandmark[]; parent: Array<number | null> } | null, unnamedRegions: string[] = []): BehaviourCheck[] {
  const id: BehaviourCheckId = "a11y.landmarks";
  if (tree === null) return [{ id, status: "not-run", detail: "the accessibility snapshot could not be parsed (Playwright's aria snapshot format is unversioned)" }];
  const lms = tree.landmarks;
  const rows: BehaviourCheck[] = [];
  const mains = lms.filter((l) => l.role === "main");
  if (mains.length > 1) rows.push({ id, status: "fail", detail: `${mains.length} main landmarks — a page has one <main> (the others: section / div)`, evidence: { count: mains.length } });
  if (mains.length === 0) rows.push({ id, status: "warn", detail: "no main landmark — wrap the screen's primary content in <main>" });
  const regions = lms.filter((l) => l.role === "region");
  if (regions.length > 6) rows.push({ id, status: "warn", detail: `${regions.length} region landmarks — named <section>s become landmarks; keep the few a screen-reader user jumps to`, evidence: { count: regions.length } });
  lms.forEach((l, i) => {
    if (l.role !== "region" || l.name === null) return;
    // the nearest enclosing REGION
    let p = tree.parent[i] ?? null;
    while (p !== null && lms[p]?.role !== "region") p = tree.parent[p] ?? null;
    const pl = p !== null ? lms[p] : undefined;
    if (pl && pl.name !== null && l.name.toLowerCase().startsWith(pl.name.toLowerCase())) {
      rows.push({ id, status: "warn", target: lmName(l), detail: `region "${l.name}" sits inside region "${pl.name}" and repeats its name — one landmark is enough (drop the inner section's name or role)` });
    }
  });
  const seen = new Map<string, number>();
  for (const l of lms) {
    if (l.role === "main" || (l.role === "navigation" && l.name === null)) continue; // own rules
    const k = `${l.role}|${l.name ?? ""}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n < 2) continue;
    const [role, name] = k.split("|");
    rows.push({ id, status: "warn", target: `${role ?? ""}${name ? ` "${name}"` : ""}`, detail: `${n} ${role ?? ""} landmarks named ${name ? `"${name}"` : "nothing"} — give each a distinct name (aria-label)`, evidence: { count: n } });
  }
  const navs = lms.filter((l) => l.role === "navigation");
  if (navs.length > 1 && navs.some((l) => l.name === null)) rows.push({ id, status: "warn", detail: `${navs.length} navigation landmarks, ${navs.filter((l) => l.name === null).length} unnamed — name each (aria-label) so they can be told apart` });
  if (unnamedRegions.length) rows.push({ id, status: "warn", target: unnamedRegions[0] ?? "", detail: `${unnamedRegions.length} element(s) with role="region" and no accessible name — a region needs a name (aria-label / aria-labelledby), or drop the role`, evidence: { count: unnamedRegions.length, paths: unnamedRegions.slice(0, 5) } });
  if (!rows.length) rows.push({ id, status: "pass", detail: `${lms.length} landmark(s): ${lms.map(lmName).join(", ") || "none"}` });
  return rows;
}

/** The role and accessible name on the FIRST line of locator(el).ariaSnapshot() `- button "Save"`,
 *  `- button` (no name), `- link "x":`, `- text: …` and "" (no role). Escaped quotes/backslashes are unescaped. */
export function parseAriaName(snapshot: string): { role: string | null; name: string | null } {
  const line = (typeof snapshot === "string" ? snapshot.split("\n")[0] : "") ?? "";
  const m = /^- (\w+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
  if (!m || m[1] === "text") return { role: null, name: null };
  const name = m[2] !== undefined ? unescapeQuoted(m[2]) : null;
  return { role: m[1] ?? null, name: name !== null && name.trim() !== "" ? name : null };
}

/** Roles whose accessible name is REQUIRED (ARIA 1.2 "name required" / interactive widgets): a stop with one of these and no
 *  name fails. Others (group, region, list, row, …) pass unnamed — their name is optional. */
const NAME_REQUIRED = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "listbox",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "treeitem", "img", "dialog", "alertdialog", "iframe", "tree", "grid", "menu", "tablist", "radiogroup", "scrollbar", "meter", "progressbar"]);
/** a11y.name for one Tab stop: its snapshot's first line, plus what the snapshot does not show — an iframe's name
 *  (title / aria-label / aria-labelledby, read from the DOM: `- iframe` never carries it) and a <summary>'s role (its line is
 *  `- text: …`; it is a disclosure named by its text). */
export function nameStatus(snapshot: string, stop: { tag: string; domName: string | null }): { status: BehaviourStatus; role: string | null; name: string | null } {
  const n = parseAriaName(snapshot);
  if (stop.tag === "iframe" || stop.tag === "frame") return { status: stop.domName ? "pass" : "fail", role: "iframe", name: stop.domName };
  if (stop.tag === "summary" && (n.role === null || n.role === "summary")) return { status: stop.domName ? "pass" : "fail", role: "summary", name: stop.domName };
  if (n.role === null) return { status: "warn", role: null, name: null };
  if (n.name === null && NAME_REQUIRED.has(n.role)) return { status: "fail", role: n.role, name: null };
  return { status: "pass", role: n.role, name: n.name };
}
/** dialog.scrim: the built scrim vs the overlay's designed background (null = no scrim). Channels ±8, alpha ±0.05;
 *  a (near-)transparent colour is "no scrim" on either side. */
export function scrimMatches(expected: string | null, actual: string | null): boolean {
  const e = expected === null ? null : parseCssColor(expected);
  const a = actual === null ? null : parseCssColor(actual);
  const none = (c: { a: number } | null): boolean => c === null || c.a <= 0.05;
  if (expected !== null && e === null) return false; // an unreadable design colour never "matches"
  if (none(e)) return none(a);
  if (none(a) || e === null || a === null) return false;
  return Math.abs(e.r - a.r) <= 8 && Math.abs(e.g - a.g) <= 8 && Math.abs(e.b - a.b) <= 8 && Math.abs(e.a - a.a) <= 0.05;
}
/** Is the rect (viewport coordinates) centred in the viewport, ±tol px per axis? The vertical axis is skipped (null) when the
 *  rect is (nearly) as tall as the viewport. */
export function centredIn(rect: { x: number; y: number; w: number; h: number }, vp: { w: number; h: number }, tol = 1): { h: boolean; v: boolean | null; centred: boolean } {
  const h = Math.abs(rect.x + rect.w / 2 - vp.w / 2) <= tol;
  const v = rect.h >= vp.h - 2 ? null : Math.abs(rect.y + rect.h / 2 - vp.h / 2) <= tol;
  return { h, v, centred: h && v !== false };
}
/** dialog.scroll-open: does the design centre this overlay? position center — or no overlay block in the export (from:
 *  "default" = Figma's default, which is centred; audit MED5). No overlay at all (a plan row) → only "inside the viewport". */
export function overlayCentred(ov: { position: string; from: string } | undefined): boolean {
  return !!ov && (ov.from === "default" || String(ov.position).toLowerCase() === "center");
}
/** A control that closes a dialog without doing anything: its accessible name is Cancel / Close / Dismiss / No /
 *  Not now / × / x / ✕, or its aria-label is a close label — "Close", or "Close … dialog/modal/panel/…" (tighter than "contains
 *  close": aria-label="Close account" is an action, never clicked). Never Save / Delete / Submit. */
export function safeCloseName(name: string, ariaLabel: string | null): boolean {
  if (/^(cancel|close|dismiss|no|not now|×|x|✕)$/i.test(name.trim())) return true;
  const l = (ariaLabel ?? "").trim();
  return /^(close|dismiss)$/i.test(l) || /^(close|dismiss)\b.*\b(dialog|modal|panel|popup|pop-up|window|drawer|sheet|overlay|form)$/i.test(l);
}
/** critical/serious → fail, moderate/minor only → warn, none → pass. */
export function axeStatus(violations: ReadonlyArray<{ impact: string | null }>): BehaviourStatus {
  if (violations.some((v) => v.impact === "critical" || v.impact === "serious")) return "fail";
  return violations.length ? "warn" : "pass";
}
/** What the page said after a dialog closed (focusReturnRead). */
export interface FocusReturnRead {
  /** the opener element that opened it is still in the document */
  connected: boolean;
  /** checkVisibility({visibilityProperty, checkVisibilityCSS}) and a box */
  openerVisible: boolean;
  /** it (or an ancestor) has computed opacity 0 */
  opacity0: boolean;
  /** activeElement is the opener, inside it, or its closest focusable ancestor */
  onOpener: boolean;
  activeIsBody: boolean;
  activeVisible: boolean;
  activeDesc: string;
}
/** dialog.focus-return: back on a visible opener → pass; on it while it is invisible by opacity → warn; opener gone →
 *  pass only when focus is on a visible non-body element; anything else (BODY, a hidden opener) → fail. */
export function focusReturnStatus(r: FocusReturnRead): { status: BehaviourStatus; detail: string } {
  if (!r.connected) {
    return !r.activeIsBody && r.activeVisible
      ? { status: "pass", detail: `the opener left the document on close; focus went to ${r.activeDesc} (a visible element) — note: not the opener` }
      : { status: "fail", detail: `the opener left the document on close and focus fell to ${r.activeIsBody ? "<body>" : `${r.activeDesc} (not visible)`} — move focus to a sensible visible element` };
  }
  if (r.onOpener && r.openerVisible && !r.opacity0) return { status: "pass", detail: "focus returned to the opener" };
  if (r.onOpener && r.openerVisible) return { status: "warn", detail: "focus returned to the opener, but it is invisible (opacity 0) while focused with the pointer away — reveal it on focus too (e.g. group-focus-within:opacity-100), never only on hover" };
  if (r.onOpener) return { status: "fail", detail: "focus returned to the opener, but it is hidden (visibility/display) with the pointer away — a keyboard user sees no focus; reveal hover-only actions with opacity + :focus-within, never visibility:hidden" };
  return { status: "fail", detail: `focus went to ${r.activeIsBody ? "<body>" : r.activeDesc}, not back to the opener${r.openerVisible ? "" : " (the opener is hidden with the pointer away — hover-only visibility:hidden)"}` };
}

const STATUS_ORDER: Record<BehaviourStatus, number> = { fail: 0, warn: 1, "not-run": 2, unsupported: 3, pass: 4 };
export const PER_ELEMENT_CAP = 20;
/** Per-element rows: every non-pass element (most severe first, ≤ 20, then one "+N more" row per remaining status with
 *  evidence.count and evidence.more: true — the structured marker a reader counts on, never the English detail) + one aggregate pass row ("k of n …") when k > 0. */
export function perElement(id: BehaviourCheckId, nonPass: BehaviourCheck[], passCount: number, total: number, what: string, variant?: string): BehaviourCheck[] {
  const sorted = [...nonPass].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const rows = sorted.slice(0, PER_ELEMENT_CAP);
  const rest = sorted.slice(PER_ELEMENT_CAP);
  for (const st of ["fail", "warn", "not-run", "unsupported"] as const) {
    const n = rest.filter((r) => r.status === st).length;
    if (n) rows.push({ id, status: st, ...(variant !== undefined ? { variant } : {}), detail: `+${n} more ${st} — the first ${PER_ELEMENT_CAP} are listed`, evidence: { count: n, more: true } });
  }
  if (passCount > 0) rows.push({ id, status: "pass", ...(variant !== undefined ? { variant } : {}), detail: `${passCount} of ${total} ${what}`, evidence: { count: passCount, of: total } });
  return rows;
}

/** The overlay rows the battery runs on: drivable rows whose drive evidence opened something by a REAL mouse click
 *  without a document load; the rest get every dialog.* check not-run with the reason. The modality itself (:modal /
 *  dialog[open] / aria-modal) is checked on the page when the battery opens it again. */
export function batteryRows(exp: Pick<VerifyExpectation, "interactions" | "hidden">, driven: readonly InteractionEvidence[] | null): { battery: VerifyInteraction[]; skipped: Array<{ row: VerifyInteraction; why: string }> } {
  const battery: VerifyInteraction[] = [], skipped: Array<{ row: VerifyInteraction; why: string }> = [];
  for (const row of drivable(exp)) {
    const ev = (driven || []).find((e) => e.nodeId === row.nodeId && e.trigger === row.trigger);
    let why: string | null = null;
    if (!ev) why = "the overlay was not driven (no drive evidence)";
    else if (ev.cut === "budget") why = "the drive was cut by its time budget";
    else if (ev.activation === "synthetic") why = "the opener opened only on a synthetic click (headless) — never used for the battery";
    else if (!ev.opened) why = `the drive opened nothing (${(ev.detail ?? "").replace(/^not-run: /, "") || "no detail"})`;
    else if ((ev.navEvents ?? 0) !== 0) why = "the drive saw a document load";
    // a destination-tag detection is NOT skipped — the tagged panel may sit inside a 0-px modal root (Headless UI); the
    // battery's own modality check (markDialog, through ancestors) decides. A popover is never a modal dialog.
    else if (ev.detectedBy === ":popover-open") why = `the drive opened a popover, not a modal dialog — ${NOT_MODAL}`;
    if (why === null) battery.push(row); else skipped.push({ row, why });
  }
  return { battery, skipped };
}
const NOT_MODAL = "the battery runs only on a modal dialog (:modal / dialog[open] / aria-modal=true)";
export const DIALOG_IDS: readonly BehaviourCheckId[] = ["dialog.focus-on-open", "dialog.focus-trap", "dialog.escape-closes", "dialog.focus-return", "dialog.nested-escape", "dialog.scroll-open", "dialog.scrim", "dialog.click-outside"];

// ---------------------------------------------------------------- page-side functions (SELF-CONTAINED)
/** P1/R-key: start inside the active modal, whose inert background cannot receive focus, else body.
 *  The sequential focus starting point must be known — after a click Chromium starts at the click point. SELF-CONTAINED. */
export function sentinelInsert(_arg: null): boolean {
  const prev = window.__dtBeh;
  const st: BehState = prev ?? { stops: [], stopVisible: [], sentinel: null, opener: null, dialog: null, dialogModal: false, expander: null, masks: [], maskInline: [] };
  window.__dtBeh = st;
  st.stops = []; st.stopVisible = [];
  if (st.sentinel && st.sentinel.isConnected) st.sentinel.remove();
  const body = document.body;
  if (!body) return false;
  const s = document.createElement("div");
  s.setAttribute("tabindex", "0");
  s.setAttribute("data-dt-sentinel", "");
  s.setAttribute("style", "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;overflow:hidden;outline:none;z-index:-1");
  let host: PageElement | null = null;
  try {
    host = document.activeElement?.closest('dialog:modal, [aria-modal="true" i]') ?? null;
    if (!host) {
      const modals = Array.from(document.querySelectorAll("dialog:modal"));
      host = modals[modals.length - 1] ?? null;
    }
  } catch { /* older hosts without :modal retain the body fallback */ }
  (host ?? body).prepend(s);
  st.sentinel = s;
  s.focus({ preventScroll: true });
  const focused = document.activeElement === s;
  if (!focused) { s.remove(); st.sentinel = null; }
  return focused;
}
/** SELF-CONTAINED. */
function sentinelRemove(_arg: null): boolean {
  const st = window.__dtBeh;
  if (st && st.sentinel) { st.sentinel.remove(); st.sentinel = null; }
  return true;
}
/** After a Tab press: where focus is — the DEEP active element (through open shadow roots; an iframe is one stop: focus inside
 *  it leaves the iframe active). end = back on the sentinel, or on body after at least one stop (a repeated element —
 *  the fields of a date input, a shadow host, an iframe — is a duplicate, skipped, never a loop: the walk goes on to the cap).
 *  `opener` = it is the marked opener's control (markOpener); `ancestor` = it holds the opener (a focusable row/card, never pressed).
 *  Otherwise the stop is recorded (element reference + visible while focused). SELF-CONTAINED. */
function walkStep(arg: { record: boolean }): { end: "sentinel" | "body" | null; opener: boolean; ancestor: string | null; inside: string | null; dup: boolean } {
  const st = window.__dtBeh;
  const dt = window.__dt;
  const a = dt.active();
  if (!st) return { end: "body", opener: false, ancestor: null, inside: null, dup: false };
  if (a !== null && a === st.sentinel) return { end: "sentinel", opener: false, ancestor: null, inside: null, dup: false };
  if (a === null || a === document.body || a === document.documentElement) return st.stops.length ? { end: "body", opener: false, ancestor: null, inside: null, dup: false } : { end: null, opener: false, ancestor: null, inside: null, dup: true };
  const o = st.opener;
  // "the opener" as a control is markOpener's (computed once) — never another control inside a container opener,
  // never a row/card around it
  const ctrl = st.control && st.control.isConnected ? st.control : null;
  const descOf = (e: PageElement): string => dt.describe(e, ["tabindex", "role", "aria-label"]);
  const opener = !!ctrl && a === ctrl;
  const inside = !opener && !!o && o !== a && o.contains(a) ? descOf(a) : null;
  const ancestor = !opener && !!o && a.contains(o) ? descOf(a) : null;
  if (st.stops.includes(a)) return { end: null, opener, ancestor, inside, dup: true };
  if (arg.record) {
    st.stops.push(a);
    st.stopVisible.push(dt.visible(a, { sized: true, opacity: true }));
  }
  return { end: null, opener, ancestor, inside, dup: false };
}
/** may Enter/Space be pressed now? Only when the DEEP active element IS the marked opener's control (markOpener),
 *  and is a button-like control (button, a[href], summary, role=button|link|menuitem|tab) — never a text field (even readonly:
 *  Enter submits its form), a select, or an ancestor row/card. (The caller runs submitGuard on it too.) SELF-CONTAINED. */
export function keyTarget(_arg: null): { ok: boolean; desc: string; why: string } {
  const st = window.__dtBeh;
  const o = st ? st.opener : null;
  const a = window.__dt.active();
  if (!a || a === document.body || a === document.documentElement) return { ok: false, desc: "<body>", why: "focus is on <body>" };
  const desc = window.__dt.describe(a, ["type", "readonly", "tabindex", "role"]);
  if (!o) return { ok: false, desc, why: "the opener is gone" };
  // the opener's control as markOpener found it — re-checked to be still in the document
  const ctrl = st && st.control && st.control.isConnected ? st.control : null;
  if (a !== ctrl) return { ok: false, desc, why: o.contains(a) ? "the opener is a container; its focusable child is not pressed" : a.contains(o) ? "an ancestor of the opener" : "not the opener" };
  const tag = a.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea" || a.isContentEditable === true) return { ok: false, desc, why: "a form field — Enter in it can submit its form" };
  if (!a.matches("button, a[href], summary, [role=button i], [role=link i], [role=menuitem i], [role=tab i]")) return { ok: false, desc, why: "not a button-like control" };
  return { ok: true, desc, why: "" };
}

/** How many stops the walk recorded, and which were visible while focused. SELF-CONTAINED. */
function stopsCount(_arg: null): { n: number; visible: boolean[] } {
  const st = window.__dtBeh;
  return st ? { n: st.stops.length, visible: st.stopVisible.slice() } : { n: 0, visible: [] };
}
/** The recorded stops, described (after the sentinel is gone: paths are the page's own). SELF-CONTAINED. */
function stopsInfo(_arg: null): Array<{ path: string; dt: string | null; tag: string; connected: boolean; domName: string | null }> {
  const st = window.__dtBeh;
  if (!st) return [];
  // (a path Playwright's css engine resolves through open shadow roots — dt.path)
  const pathOf = window.__dt.paths();
  // an iframe's name is not in its aria snapshot (`- iframe`): read title / aria-label / aria-labelledby from the DOM
  const domName = (el: PageElement): string | null => {
    const label = (el.getAttribute("aria-label") || "").trim();
    if (label) return label;
    const by = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter((x) => x !== "").map((x) => document.getElementById(x)).filter((x): x is PageElement => x !== null).map((x) => (x.textContent || "").trim()).join(" ").trim();
    if (by) return by;
    const title = (el.getAttribute("title") || "").trim();
    return title || null;
  };
  return st.stops.map((el) => ({ path: pathOf(el), dt: el.getAttribute("data-dt-node"), tag: el.tagName.toLowerCase(), connected: el.isConnected,
    domName: el.tagName.toLowerCase() === "iframe" || el.tagName.toLowerCase() === "frame" ? domName(el) : el.tagName.toLowerCase() === "summary" ? ((el.textContent || "").trim() || null) : null }));
}
interface SubjectRead {
  id: string;
  /** inside a closed disclosure — an ancestor with display:none, a closed <details>, [hidden], or a region an
   *  [aria-expanded=false] control names in aria-controls (its description), else null */
  closedIn: string | null;
  /** tagged elements outside a closed <dialog> (several → those with a layout box) */
  count: number;
  hasBox: boolean;
  disabled: boolean;
  /** index of the stop that reaches it (the element, its control — markOpener's — or its closest focusable ancestor), or -1 */
  stop: number;
  /** when no stop reaches it, the first stop INSIDE it (a container's focusable that is not its control), described */
  inside: string | null;
  visibility: string;
  tabindex: string | null;
  tag: string;
}
/** keyboard.reachable: one subject (a tagged opener, marked by markOpener just before) against the recorded stops. A stop
 *  inside a container opener reaches it only when it is the opener's control — a card's own Delete reaches the
 *  Delete, not the card. SELF-CONTAINED. */
function subjectRead(arg: { id: string }): SubjectRead {
  const st = window.__dtBeh;
  const stops = st ? st.stops : [];
  const FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  const id = arg.id;
  const dt = window.__dt;
  const els = dt.tagged(id);
  const el = els.length === 1 ? els[0] : undefined;
  if (!el) return { id, count: els.length, closedIn: null, hasBox: false, disabled: false, stop: -1, inside: null, visibility: "", tabindex: null, tag: "" };
  let closedIn: string | null = null;
  for (let p = el.parentElement; p && p !== document.body && closedIn === null; p = p.parentElement) {
    const desc = dt.describe(p, ["id"]);
    if (p.tagName.toLowerCase() === "details" && !p.hasAttribute("open") && el.closest("summary") === null) closedIn = `a closed <details>`;
    else if (p.hasAttribute("hidden")) closedIn = `${desc} [hidden]`;
    else if (getComputedStyle(p).getPropertyValue("display") === "none") closedIn = `${desc} (display:none)`;
    else if (p.id) {
      const ctl = Array.from(document.querySelectorAll("[aria-controls]")).find((c) => (c.getAttribute("aria-controls") || "").split(/\s+/).includes(p.id) && (c.getAttribute("aria-expanded") || "").toLowerCase() === "false");
      if (ctl) closedIn = `${desc}, which its [aria-expanded=false] control ${ctl.id ? `#${ctl.id}` : `<${ctl.tagName.toLowerCase()}>`} keeps closed`;
    }
  }
  const f = el.closest(FOCUSABLE);
  const ctrl = st && st.opener === el && st.control && st.control.isConnected ? st.control : null;
  const stop = stops.findIndex((s) => s === el || s === f || s === ctrl);
  const inner = stop < 0 ? stops.find((s) => s !== el && el.contains(s)) : undefined;
  return {
    id, count: 1, closedIn, hasBox: el.getClientRects().length > 0,
    disabled: el.closest(":disabled, [disabled], [aria-disabled=\"true\" i]") !== null,
    stop, inside: inner ? dt.describe(inner, ["aria-label"]) : null,
    visibility: getComputedStyle(el).getPropertyValue("visibility"), tabindex: el.getAttribute("tabindex"), tag: el.tagName.toLowerCase(),
  };
}
/** keyboard.focus-visible: focus the stop before `i` (the sentinel for 0) programmatically, so a real Tab lands on i. SELF-CONTAINED. */
function focusBefore(arg: { i: number }): boolean {
  const st = window.__dtBeh;
  if (!st) return false;
  const prev = arg.i === 0 ? st.sentinel : st.stops[arg.i - 1];
  if (!prev || !prev.isConnected) return false;
  prev.focus({ preventScroll: false });
  return window.__dt.active() === prev;
}
/** Is stop i focused now, where is it (viewport), and what draws on it. SELF-CONTAINED. */
function focusedStop(arg: { i: number }): { ok: boolean; onPrev: boolean; visible: boolean; rect: { x: number; y: number; w: number; h: number }; vw: number; vh: number; outlineStyle: string; outlineWidth: string; boxShadow: string; focusVisible: boolean } {
  const st = window.__dtBeh;
  const el = st ? st.stops[arg.i] : undefined;
  const act = window.__dt.active();
  const ok = !!el && act === el;
  const prev = st ? (arg.i === 0 ? st.sentinel : st.stops[arg.i - 1]) : null;
  const onPrev = !!prev && act === prev;
  if (!el) return { ok: false, onPrev, visible: false, rect: { x: 0, y: 0, w: 0, h: 0 }, vw: innerWidth, vh: innerHeight, outlineStyle: "", outlineWidth: "", boxShadow: "", focusVisible: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  let fv = false;
  try { fv = el.matches(":focus-visible"); } catch { /* unsupported */ }
  return {
    ok, onPrev, visible: window.__dt.visible(el, { sized: true, opacity: true }),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height }, vw: innerWidth, vh: innerHeight,
    outlineStyle: cs.getPropertyValue("outline-style"), outlineWidth: cs.getPropertyValue("outline-width"), boxShadow: cs.getPropertyValue("box-shadow"), focusVisible: fv,
  };
}
/** SELF-CONTAINED. */
function blurActive(_arg: null): boolean {
  const a = document.activeElement;
  if (a && a !== document.body) a.blur();
  return true;
}
/** Explicit [role=region] elements with no accessible name (a snapshot drops them). SELF-CONTAINED. */
function unnamedRegions(_arg: null): string[] {
  const dt = window.__dt;
  const pathOf = dt.paths();
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll("[role=region i]"))) {
    if (!dt.visible(el)) continue;
    const label = (el.getAttribute("aria-label") || "").trim();
    const by = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter((x) => x !== "").map((x) => document.getElementById(x)).filter((x): x is PageElement => x !== null);
    const byText = by.map((x) => (x.textContent || "").trim()).join(" ").trim();
    const title = (el.getAttribute("title") || "").trim();
    if (!label && !byText && !title) out.push(pathOf(el));
  }
  return out;
}
/** visible td/th and elements with their own non-blank text, rendered under 1 px wide (and > 0 tall). SELF-CONTAINED. */
function subpixelRead(_arg: null): Array<{ path: string; dt: string | null; tag: string; width: number; text: string }> {
  const dt = window.__dt;
  const pathOf = dt.paths();
  const out: Array<{ path: string; dt: string | null; tag: string; width: number; text: string }> = [];
  const body = document.body;
  if (!body) return out;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (el.getAttribute("data-dt-sentinel") !== null) continue;
    const tag = el.tagName.toLowerCase();
    const cell = tag === "td" || tag === "th";
    const ownText = dt.ownText(el).trim();
    if (!cell && ownText === "") continue;
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "title") continue;
    if (el.closest("dialog:not([open])") !== null) continue;
    if (!dt.visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height > 0) {
      const tagged = el.closest("[data-dt-node]");
      out.push({ path: pathOf(el), dt: tagged ? tagged.getAttribute("data-dt-node") : null, tag, width: Math.round(r.width * 100) / 100, text: (ownText || (el.textContent || "").trim()).slice(0, 40) });
    }
  }
  return out.slice(0, 50);
}
/** overflow.narrow: is every offender inside 2-D content (WCAG 1.4.10's exception)? SELF-CONTAINED. */
function offendersAre2D(arg: { paths: string[] }): boolean {
  if (!arg.paths.length) return false;
  return arg.paths.every((p) => {
    const el = window.__dt.find(p);
    return !!el && el.closest("table, pre, figure, img, canvas, svg, video, [role=grid], [role=table]") !== null;
  });
}
/** the data-dt-node ids on a visible element with a box, outside closed dialogs — the same rule as the measurement
 *  pass's tagged candidates (box && checkVisibility, not in a closed <dialog>): the unit's page fingerprint. SELF-CONTAINED. */
function visibleTags(_arg: null): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll("[data-dt-node]"))) {
    if (el.closest("dialog:not([open])") !== null || !window.__dt.visible(el)) continue;
    const v = el.getAttribute("data-dt-node");
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}
/** The page's size now (the live-resize settle polls it). SELF-CONTAINED. */
function docSize(_arg: null): { sw: number; sh: number; scrollY: number; vh: number; vw: number } {
  const de = document.documentElement;
  return { sw: de.scrollWidth, sh: de.scrollHeight, scrollY, vh: innerHeight, vw: innerWidth };
}
/** forced-colors.visible candidates: visible elements whose computed mask-image is not none (≤ cap). SELF-CONTAINED. */
function maskCandidates(arg: { cap: number }): Array<{ dt: string | null; tag: string }> {
  const st: BehState = window.__dtBeh ?? { stops: [], stopVisible: [], sentinel: null, opener: null, dialog: null, dialogModal: false, expander: null, masks: [], maskInline: [] };
  window.__dtBeh = st;
  st.masks = []; st.maskInline = [];
  const body = document.body;
  if (!body) return [];
  const out: Array<{ dt: string | null; tag: string }> = [];
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (out.length >= arg.cap) break;
    const cs = getComputedStyle(el);
    const m = cs.getPropertyValue("mask-image"), wm = cs.getPropertyValue("-webkit-mask-image");
    if ((m === "" || m === "none") && (wm === "" || wm === "none")) continue;
    if (!window.__dt.visible(el, { sized: true, opacity: true })) continue;
    st.masks.push(el);
    st.maskInline.push({ value: el.style.getPropertyValue("visibility"), priority: el.style.getPropertyPriority("visibility") });
    const tagged = el.closest("[data-dt-node]");
    out.push({ dt: tagged ? tagged.getAttribute("data-dt-node") : null, tag: el.tagName.toLowerCase() });
  }
  return out;
}
/** Bring mask candidate i into view; its viewport rect (null when gone). SELF-CONTAINED. */
function maskShow(arg: { i: number }): { x: number; y: number; w: number; h: number; vw: number; vh: number } | null {
  const st = window.__dtBeh;
  const el = st ? st.masks[arg.i] : undefined;
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
}
/** Hide (inline visibility:hidden !important) or restore mask candidate i. SELF-CONTAINED. */
function maskHide(arg: { i: number; hide: boolean }): boolean {
  const st = window.__dtBeh;
  const el = st ? st.masks[arg.i] : undefined;
  const prev = st ? st.maskInline[arg.i] : undefined;
  if (!el || !prev) return false;
  if (arg.hide) el.style.setProperty("visibility", "hidden", "important");
  else if (prev.value) el.style.setProperty("visibility", prev.value, prev.priority);
  else el.style.removeProperty("visibility");
  return true;
}
/** Scroll the window to y at once; the scrollY it got. SELF-CONTAINED. */
function scrollToY(arg: { y: number }): number {
  window.scrollTo({ top: arg.y, left: 0, behavior: "instant" });
  return scrollY;
}
export interface OpenerRead {
  found: boolean;
  visible: boolean;
  /** the click point (viewport) and whether it is on screen and lands on the opener (or inside it) */
  x: number; y: number; inViewport: boolean; hits: boolean;
  /** when not visible: the nearest visible ancestor's centre (the reveal), viewport */
  hover: { x: number; y: number; inViewport: boolean } | null;
  /** the control is a container's sole one the DOM check let through, not judged by pixels in this page yet — the pair is in
   *  window.__dtOwn for ownPixels (markOpenerSeen runs it, then ownDecide) */
  sole: boolean;
  /** why a container's sole control is not the opener's own (its own content, by the DOM or the pixels), or null */
  why: string | null;
}
/** Find the opener by its tag (outside a closed dialog; several → the ones with a box), remember it and its control
 *  (window.__dtBeh.opener / .control) and say where a mouse would click it without scrolling. SELF-CONTAINED. */
export function markOpener(arg: { id: string }): OpenerRead {
  const st: BehState = window.__dtBeh ?? { stops: [], stopVisible: [], sentinel: null, opener: null, dialog: null, dialogModal: false, expander: null, masks: [], maskInline: [] };
  window.__dtBeh = st;
  window.__dtOwn = null;
  const none: OpenerRead = { found: false, visible: false, x: 0, y: 0, inViewport: false, hits: false, hover: null, sole: false, why: null };
  const dt = window.__dt;
  const els = dt.tagged(arg.id);
  const el = els.length === 1 ? els[0] : undefined;
  if (!el) { st.opener = null; st.control = null; return none; }
  st.opener = el;
  const sees = (e: PageElement, opacity: boolean): boolean => dt.visible(e, { sized: true, opacity });
  const { w: vw, h: vh } = dt.viewport();
  const visible = sees(el, true);
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const inViewport = x >= 0 && y >= 0 && x < vw && y < vh;
  const hit = inViewport ? document.elementFromPoint(x, y) : null;
  // computed ONCE, here (walkStep / keyTarget / focusOpener / subjectRead use it): the opener's own control —
  // the tagged element when it is focusable; else the closest button-like ancestor of a non-focusable tag (a label inside its
  // <button>) holding no other focusable; else a container's ONLY focusable when it is button-like, not a field, and under the
  // container's centre — the point the mouse open clicks (elementFromPoint there when it is on screen, else that control's
  // box holding it) — and the container shows nothing of its own outside it: a cell around its icon button (judged by its DOM
  // here, by its pixels in markOpenerSeen — the drive's ownPixels — once per pair per page). Never another
  // control inside a container (a card's Delete off to the side, or a 2nd focusable, or a card with its own text around a
  // centred Delete), never a row/card around it.
  const FOC = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  const BTN = "button, a[href], summary, [role=button i], [role=link i], [role=menuitem i], [role=tab i]";
  let control: PageElement | null = null, sole = false, why: string | null = null;
  if (el.matches(FOC)) control = el;
  else {
    const anc = el.parentElement ? el.parentElement.closest(BTN) : null;
    if (anc && anc.matches(FOC) && Array.from(anc.querySelectorAll(FOC)).length === 0) control = anc;
    else {
      const inner = Array.from(el.querySelectorAll(FOC));
      const one = inner.length === 1 ? inner[0] : undefined;
      if (one && one.matches(BTN) && !one.matches("input, select, textarea, [contenteditable]")) {
        const b = one.getBoundingClientRect();
        const own = (inViewport ? !!hit && (hit === one || one.contains(hit)) : x >= b.x && x <= b.right && y >= b.y && y <= b.bottom) ? dt.ownContent(el, one) : undefined;
        if (own === null) {
          // the pixels have the last word (markOpenerSeen → ownPixels → ownDecide); a pair this page already judged is not
          // shot again
          const seen = (st.ownSeen ?? []).find((p) => p.box === el && p.ctl === one);
          if (seen) { control = seen.own ? null : one; why = seen.why ?? null; }
          else { control = one; sole = true; window.__dtOwn = { box: el, ctl: one }; }
        } else if (own !== undefined) why = `its own content: ${own}`;
      }
    }
  }
  st.control = control;
  let hover: OpenerRead["hover"] = null;
  if (!visible) {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (!sees(p, false)) continue;
      const pr = p.getBoundingClientRect();
      // a point of the ancestor that is not over the opener itself (its centre, or its left edge area)
      const hx = pr.x + Math.min(8, pr.width / 2), hy = pr.y + pr.height / 2;
      hover = { x: hx, y: hy, inViewport: hx >= 0 && hy >= 0 && hx < vw && hy < vh };
      break;
    }
  }
  return { found: true, visible, x, y, inViewport, hits: !!hit && (hit === el || el.contains(hit)), hover, sole, why };
}
/** After markOpener's sole control was judged by pixels (markOpenerSeen): remember the verdict for this page and drop the
 *  control when the container shows content of its own (no key is pressed on it, Tab reaching it does not reach the opener).
 *  SELF-CONTAINED. */
export function ownDecide(arg: { own: boolean; why?: string | null }): boolean {
  const st = window.__dtBeh;
  if (!st || !st.opener || !st.control) return false;
  const seen = st.ownSeen ?? [];
  seen.push({ box: st.opener, ctl: st.control, own: arg.own, why: arg.why ?? null });
  st.ownSeen = seen;
  if (arg.own) st.control = null;
  return true;
}
/** Focus the marked opener's control (markOpener) without scrolling; false when it has none (or it left the
 *  document). SELF-CONTAINED. */
function focusOpener(arg: { preventScroll: boolean }): boolean {
  const st = window.__dtBeh;
  const f = st && st.opener && st.control && st.control.isConnected ? st.control : null;
  if (!f) return false;
  f.focus({ preventScroll: arg.preventScroll });
  return window.__dt.active() === f;
}
interface DialogRead { found: boolean; modal: boolean; dialogOpen: boolean; ariaModal: boolean; native: boolean }
/** Remember the opened element (by the detector's path) and say what kind of dialog it is. SELF-CONTAINED. */
function markDialog(arg: { path: string }): DialogRead {
  const st = window.__dtBeh;
  const dt = window.__dt;
  const el = dt.find(arg.path);
  if (!st || !el) return { found: false, modal: false, dialogOpen: false, ariaModal: false, native: false };
  // the modal root may be an ANCESTOR of what opened (Headless UI: <div role=dialog aria-modal=true> with a 0-px box holding
  // a fixed backdrop and the panel — the drive's detector sees the panel); the root decides modality and "inside", the panel is the box.
  // only when the opened element has no dialog role of its own, and never an ancestor that was already open before the
  // click (armDetector's snapshot — its visible dialog-likes, and every rendered open modal root whatever its box: Headless UI's
  // root is 0 px): a non-modal picker opened inside an open modal sheet is the picker — non-modal
  const before = window.__dtDrive ? [...window.__dtDrive.before, ...(window.__dtDrive.roots ?? [])] : [];
  const own = el.matches("dialog, [role=dialog i], [role=alertdialog i]");
  const anc = own ? null : el.closest("dialog[open], [aria-modal=\"true\" i]");
  const root = anc && !before.includes(anc) ? anc : el;
  let modal = false;
  try { modal = root.matches(":modal"); } catch { /* no :modal */ }
  const ariaModal = (root.getAttribute("aria-modal") || "").toLowerCase() === "true";
  const sized = (e: PageElement): boolean => dt.visible(e, { sized: true });
  let box: PageElement | null = root;
  if (!sized(root)) {
    box = el !== root && sized(el) ? el : Array.from(root.querySelectorAll("[role=dialog i], [role=alertdialog i], [data-dt-node], [class*=panel i]")).find(sized) ?? null;
  }
  st.dialog = root;
  st.box = box;
  st.dialogModal = modal || ariaModal;
  return { found: true, modal, dialogOpen: root.matches("dialog[open]"), ariaModal, native: root.tagName.toLowerCase() === "dialog" };
}
/** Is the remembered dialog still open: in the document, with a box, visible, and (when it opened as :modal) still :modal. SELF-CONTAINED. */
function dialogOpenNow(_arg: null): boolean {
  const st = window.__dtBeh;
  const root = st ? st.dialog : null;
  if (!root || !root.isConnected) return false;
  // a 0-px modal root is open while its box (the panel) shows
  const el = st && st.box ? st.box : root;
  if (!el.isConnected || !window.__dt.visible(el, { sized: true, opacity: true })) return false;
  if (root.tagName.toLowerCase() === "dialog") {
    let modal = false;
    try { modal = root.matches(":modal"); } catch { /* no :modal */ }
    return root.matches("dialog[open]") && (modal || !st?.dialogModal);
  }
  return true;
}
/** Where focus is relative to the remembered dialog (and the destination-tagged element). SELF-CONTAINED. */
function focusVsDialog(arg: { destId: string | null }): { inside: boolean; body: boolean; desc: string; name: string } {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  const a = document.activeElement;
  const dt = window.__dt;
  const desc = (el: PageElement | null): string => dt.describe(el, ["data-dt-node", "id"], true);
  const body = a === null || a === document.body || a === document.documentElement;
  let inside = !body && !!d && !!a && (d === a || d.contains(a));
  if (!inside && !body && a && arg.destId !== null) {
    const tagged = a.closest(dt.tagSel(arg.destId));
    if (tagged) inside = true;
  }
  return { inside, body, desc: desc(body ? null : a), name: a && !body ? (a.getAttribute("aria-label") || (a.textContent || "").trim().slice(0, 40)) : "" };
}
/** Tabbable elements inside the remembered dialog (cap 30). SELF-CONTAINED. */
function dialogTabbables(_arg: null): number {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  if (!d) return 0;
  const FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  // counts to 31 — more than 30 is "too many to prove a trap" (the caller reports not-run, never a pass)
  let n = 0;
  for (const el of Array.from(d.querySelectorAll(FOCUSABLE))) {
    if (n > 30) break;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) < 0) continue;
    if (el.matches(":disabled")) continue;
    if (!window.__dt.visible(el)) continue;
    n++;
  }
  return n;
}
/** dialog.nested-escape: the first visible [aria-expanded="false"] inside the dialog (remembered), else whether the dialog
 *  holds only a native picker (select / date-like input). SELF-CONTAINED. */
function expanderFind(_arg: null): { path: string | null; nativePicker: boolean; desc: string } {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  if (!st || !d) return { path: null, nativePicker: false, desc: "" };
  const dt = window.__dt;
  const ok = (el: PageElement): boolean => dt.visible(el, { opacity: true }) && !el.matches(":disabled");
  const x = Array.from(d.querySelectorAll("[aria-expanded=\"false\" i]")).find(ok);
  st.expander = x ?? null;
  if (x) return { path: dt.path(x), nativePicker: false, desc: dt.describe(x, ["role"], true) };
  const native = Array.from(d.querySelectorAll("select, input[type=date i], input[type=time i], input[type=datetime-local i], input[type=month i], input[type=week i], input[type=color i]")).some(ok);
  return { path: null, nativePicker: native, desc: "" };
}
/** The remembered expander's aria-expanded now. SELF-CONTAINED. */
function expanderState(_arg: null): string | null {
  const st = window.__dtBeh;
  const x = st ? st.expander : null;
  return x && x.isConnected ? x.getAttribute("aria-expanded") : null;
}
/** Visible clickable controls inside the remembered dialog with their accessible names (safe-close candidates). SELF-CONTAINED. */
function closeCandidates(_arg: null): Array<{ path: string; name: string; ariaLabel: string | null; button: boolean }> {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  if (!d) return [];
  const dt = window.__dt;
  const pathOf = dt.paths();
  const out: Array<{ path: string; name: string; ariaLabel: string | null; button: boolean }> = [];
  // a button or [role=button] only — a link only when it goes nowhere (href "#", "" or javascript:): a router link
  // navigates, which the probe never does
  for (const el of Array.from(d.querySelectorAll("button, [role=button i], a[href]"))) {
    if (out.length >= 50) break;
    if (el.tagName.toLowerCase() === "a") {
      const href = (el.getAttribute("href") || "").trim();
      if (!(href === "" || href === "#" || /^javascript:/i.test(href))) continue;
    }
    if (!dt.visible(el, { opacity: true }) || el.matches(":disabled")) continue;
    const label = el.getAttribute("aria-label");
    const by = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter((x) => x !== "").map((x) => document.getElementById(x)).filter((x): x is PageElement => x !== null).map((x) => (x.textContent || "").trim()).join(" ").trim();
    const value = el.tagName.toLowerCase() === "input" ? el.getAttribute("value") || "" : "";
    const name = (label && label.trim()) || by || (el.textContent || "").trim().replace(/\s+/g, " ") || value || el.getAttribute("title") || "";
    out.push({ path: pathOf(el), name, ariaLabel: label, button: el.tagName.toLowerCase() === "button" });
  }
  return out;
}
/** dialog.focus-return: the opener and focus after a close (mouse parked by the caller). SELF-CONTAINED. */
export function focusReturnRead(_arg: null): { connected: boolean; openerVisible: boolean; opacity0: boolean; onOpener: boolean; activeIsBody: boolean; activeVisible: boolean; activeDesc: string } {
  const st = window.__dtBeh;
  const o = st ? st.opener : null;
  const a = document.activeElement;
  const activeIsBody = a === null || a === document.body || a === document.documentElement;
  const dt = window.__dt;
  const desc = (el: PageElement | null): string => dt.describe(el, ["data-dt-node", "id"], true);
  const vis = (el: PageElement): boolean => dt.visible(el, { sized: true });
  let opacity0 = false;
  for (let p: PageElement | null = o; p; p = p.parentElement) if (Number(getComputedStyle(p).getPropertyValue("opacity")) === 0) { opacity0 = true; break; }
  const FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]";
  const onOpener = !!o && !!a && !activeIsBody && (a === o || o.contains(a) || a === o.closest(FOCUSABLE));
  return {
    connected: !!o && o.isConnected, openerVisible: !!o && o.isConnected && vis(o), opacity0, onOpener, activeIsBody,
    activeVisible: !!a && !activeIsBody && vis(a) && a.checkVisibility({ opacityProperty: true, checkOpacity: true }), activeDesc: desc(activeIsBody ? null : a),
  };
}
/** dialog.scroll-open: where the dialog (its destination-tagged element inside, else itself) is, in viewport coordinates. SELF-CONTAINED. */
function dialogGeometry(arg: { destId: string | null }): { rect: { x: number; y: number; w: number; h: number }; vw: number; vh: number; position: string; scrollY: number; via: string } {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  let el: PageElement | null = st && st.box ? st.box : d;
  let via = el !== d ? "the dialog's panel (its modal root has no box)" : "the opened element";
  if (d && arg.destId !== null) {
    const sel = window.__dt.tagSel(arg.destId);
    const inner = d.matches(sel) ? d : Array.from(d.querySelectorAll(sel)).find((e) => e.getClientRects().length > 0) ?? null;
    if (inner) { el = inner; via = `the destination-tagged element (data-dt-node="${arg.destId}")`; }
  }
  const { w: vw, h: vh } = window.__dt.viewport();
  // the effective scroll — a position:fixed body/html (a scroll lock) keeps the page where it was at top:-y
  let eff = scrollY;
  for (const e of [document.body, document.documentElement]) {
    if (!e || getComputedStyle(e).getPropertyValue("position") !== "fixed") continue;
    const t = parseFloat(e.style.getPropertyValue("top") || getComputedStyle(e).getPropertyValue("top"));
    if (Number.isFinite(t)) { eff = -t; break; }
  }
  if (!el) return { rect: { x: 0, y: 0, w: 0, h: 0 }, vw, vh, position: "", scrollY: eff, via };
  const r = el.getBoundingClientRect();
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, vw, vh, position: getComputedStyle(st && st.box ? st.box : el).getPropertyValue("position"), scrollY: eff, via };
}
/** the page's effective scroll — window.scrollY, or −top of a position:fixed body/html (a scroll lock). SELF-CONTAINED. */
function effScroll(_arg: null): number {
  for (const e of [document.body, document.documentElement]) {
    if (!e || getComputedStyle(e).getPropertyValue("position") !== "fixed") continue;
    const t = parseFloat(e.style.getPropertyValue("top") || getComputedStyle(e).getPropertyValue("top"));
    if (Number.isFinite(t)) return -t;
  }
  return scrollY;
}
/** wait until the remembered dialog has settled — every running animation on its subtree finished (Web Animations keep
 *  running under the probe's CSS animation:none; cap 1 s), then its box unchanged over 2 consecutive frames (cap 1 s).
 *  SELF-CONTAINED. */
async function settleDialog(_arg: null): Promise<{ animations: number; stable: boolean }> {
  const st = window.__dtBeh;
  const root = st ? st.dialog : null;
  const box = st && st.box ? st.box : root;
  if (!root || !box) return { animations: 0, stable: false };
  const frame = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => r()); });
  const cap = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
  const running = (root.getAnimations ? root.getAnimations({ subtree: true }) : []).filter((a) => a.playState === "running");
  if (running.length) await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => undefined))), cap(1000)]);
  const sig = (): string => { const r = box.getBoundingClientRect(); return `${r.x},${r.y},${r.width},${r.height}`; };
  const t = Date.now();
  let last = sig(), same = 0;
  while (Date.now() - t < 1000) {
    await frame();
    const now = sig();
    same = now === last ? same + 1 : 0;
    last = now;
    if (same >= 2) return { animations: running.length, stable: true };
  }
  return { animations: running.length, stable: false };
}
/** dialog.scrim / click-outside: the scrim colour (a native modal's ::backdrop — read only while :modal — else the
 *  background of a fixed element covering the viewport at the point), and what a click at (x, y) would hit. SELF-CONTAINED. */
interface BackdropRead {
  /** a native modal's ::backdrop colour (read only while :modal) */
  backdrop: string | null;
  /** the background colour of the scrim found (a fixed element covering ≥ 90% of the viewport) */
  cover: string | null;
  /** where a click outside lands on the backdrop itself (the native dialog, or the scrim with no control under it) —
   *  the point furthest from the dialog's box; null: no such point ("no backdrop to click") */
  point: { x: number; y: number } | null;
  /** what the furthest candidate hit when no point qualified */
  hitDesc: string;
  /** a covering layer's background whose alpha the probe cannot read (an unknown colour space) — then no point is taken
   *  and the scrim is not judged (never a guess) */
  unreadable: string | null;
}
/** dialog.scrim / click-outside: the scrim colour and a SAFE point outside the dialog. Each candidate point's
 *  whole hit stack (document.elementsFromPoint — pointer-events:none layers are not in it) is read top down: near-transparent
 *  (alpha ≤ 0.05) LAYERS covering ≥ 90% of the viewport — fixed, or absolute inside a fixed container (a Headless UI centring
 *  wrapper, a CDK overlay wrapper) — are passed through; the first covering layer with a background (alpha > 0.05) is the scrim
 *  — or the native <dialog> itself is hit (its ::backdrop). The point is safe only when nothing above that is interactive (a,
 *  button, input, [role=button], [onclick], [tabindex], …) and every element above it is such a layer: page content that
 *  covers the viewport (a static app container, a transparent <body>), a toast, anything not layered makes it unsafe;
 *  never inside the dialog's box. Alpha is read from rgb()/rgba() and the `/ a` of oklab() / oklch() / lab() / lch() / color()
 *  (Tailwind v4's bg-black/0 computes to oklab(0 0 0 / 0)); another colour space is unreadable — no point, and the caller
 *  reports not-run. No such point: null ("no backdrop to click"). SELF-CONTAINED. */
function scrimRead(_arg: null): BackdropRead {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  const box = st && st.box ? st.box : d;
  let backdrop: string | null = null;
  const native = !!d && d.tagName.toLowerCase() === "dialog";
  if (d && native) {
    let modal = false;
    try { modal = d.matches(":modal"); } catch { /* no :modal */ }
    if (modal) backdrop = getComputedStyle(d, "::backdrop").getPropertyValue("background-color");
  }
  const de = document.documentElement;
  const { w: vw, h: vh } = window.__dt.viewport();
  const br = box ? box.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const dist = (x: number, y: number): number => Math.hypot(Math.max(br.x - x, 0, x - br.right), Math.max(br.y - y, 0, y - br.bottom));
  // [tabindex="-1"] is a programmatic focus target (a focus-lock container), not a control
  const CONTROL = "a[href], button, input, select, textarea, summary, label, [role=button i], [role=link i], [role=menuitem i], [role=option i], [role=checkbox i], [role=tab i], [onclick], [tabindex]:not([tabindex^=\"-\"])";
  const covers = (e: PageElement): boolean => {
    const r = e.getBoundingClientRect();
    return Math.max(0, Math.min(r.right, vw) - Math.max(r.x, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.y, 0)) >= 0.9 * vw * vh;
  };
  const layered = (e: PageElement): boolean => {
    const pos = getComputedStyle(e).getPropertyValue("position");
    if (pos === "fixed") return true;
    if (pos !== "absolute") return false;
    for (let p = e.parentElement; p && p !== de; p = p.parentElement) if (getComputedStyle(p).getPropertyValue("position") === "fixed") return true;
    return false;
  };
  // the computed background's alpha, or null when the probe cannot read it (never a guess)
  const alpha = (c: string): number | null => {
    const t = c.trim().toLowerCase();
    if (t === "transparent") return 0;
    const m = /^(rgba?|oklab|oklch|lab|lch|color)\(([^)]*)\)$/.exec(t);
    if (!m) return null;
    const body = m[2] ?? "";
    const slash = body.lastIndexOf("/");
    const a = slash >= 0 ? body.slice(slash + 1).trim() : m[1] === "rgba" || m[1] === "rgb" ? (body.split(",")[3] ?? "").trim() : "";
    if (a === "") return 1;
    if (a === "none") return 0;
    const n = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
    return Number.isFinite(n) ? n : null;
  };
  const pts: Array<{ x: number; y: number }> = [];
  for (const x of [4, Math.round(vw / 2), vw - 5]) for (const y of [4, Math.round(vh / 2), vh - 5]) if (!(x === Math.round(vw / 2) && y === Math.round(vh / 2))) pts.push({ x, y });
  pts.sort((a, b) => dist(b.x, b.y) - dist(a.x, a.y));
  let cover: string | null = null, point: { x: number; y: number } | null = null, hitDesc = "nothing", unreadable: string | null = null;
  for (const pt of pts) {
    if (dist(pt.x, pt.y) <= 0) continue;
    const stack = document.elementsFromPoint(pt.x, pt.y);
    const top = stack[0];
    if (top && hitDesc === "nothing") hitDesc = window.__dt.describe(top, ["id"]);
    let safe = true, found = false;
    for (const e of stack) {
      if (native && e === d) { found = true; break; }
      if (box && (e === box || box.contains(e))) { safe = false; break; }
      if (e.matches(CONTROL) || e.closest(CONTROL) !== null) { safe = false; break; }
      // only a covering LAYER is passed through or taken as the scrim — page content that happens to cover the viewport
      // (a static app container, a transparent body) and a toast are never "outside the dialog"
      if (!covers(e) || !layered(e)) { safe = false; break; }
      const bg = getComputedStyle(e).getPropertyValue("background-color");
      const a = alpha(bg);
      if (a === null) { unreadable = unreadable ?? bg; safe = false; break; }
      if (a > 0.05) { found = true; if (cover === null) cover = bg; break; }
      // a near-transparent covering layer: passed through (its own click is "outside" — it holds no control at this point)
    }
    if (found && safe) { point = pt; break; }
  }
  return { backdrop, cover, point, hitDesc, unreadable };
}

// ---------------------------------------------------------------- running units on their own budget
export interface BehaviourOptions {
  expectation: Pick<VerifyExpectation, "interactions" | "hidden">;
  /** the drive's evidence (measured.interactions) — which rows opened a modal by a real click */
  driven: readonly InteractionEvidence[] | null;
  /** behaviour's share (session.budget("behaviour")), in ms from now */
  budgetMs: number;
  /** the measurement pass's visible tags (its fingerprint) — a unit whose page differs materially is not-run; absent = no check */
  measuredTags?: readonly string[];
  /** the PROJECT's axe-core, or why there is none */
  axe: { source: string; version: string } | { why: string };
  /** where verify-probe writes the forced-colours screenshot (listed in behaviour.artifacts when one is taken) */
  forcedPng: string;
  browserName?: string;
}
export interface BehaviourResult { behaviour: MeasuredBehaviour; forcedPng: Buffer | null }

/** the most Tab presses one walk makes (duplicates included) */
const WALK_CAP = 150;
class UnitNavigated extends Error {}
class AxeTimeout extends Error {}
const AXE_CAP_MS = 20_000;
const AXE_TIMED_OUT = Symbol("axe timed out");
/** A battery unit that cannot go on: its remaining checks are not-run with this reason. */
class BatteryStop extends Error {}
/** A replaced document or a closed / crashed page ends the unit: no later check can run on this page, so a step that
 *  otherwise records its own not-run row rethrows these. */
const endsUnit = (e: unknown, page: Page): boolean => { const k = pwErrorKind(e, page); return k === "navigated" || k === "gone"; };
/** Why a unit ended early, from what it threw — the reason its unfinished checks are not-run with. The page is not asked:
 *  once the unit is over its context is closed, so the error alone says what happened. */
const unitEndWhy = (e: unknown): string => {
  const kind = pwErrorKind(e);
  if (e instanceof UnitNavigated || kind === "navigated") return "the page loaded a new document";
  if (e instanceof BatteryStop) return e.message;
  if (kind === "gone") return `the page or browser closed or crashed — ${pwFirstLine(e)}`;
  return `the check could not run — ${firstLine(e)}`;
};
const park = async (page: Page): Promise<void> => { await page.mouse.move(0, 0); await raf2(page); };
/** markOpener, then — when it took a container's sole control that this page has not judged yet — the SAME
 *  pixel check as the drive's (probe-drive.ts ownPixels): content of the container's own drops the control (no key is
 *  pressed on it). The pointer stays where it is (a hover-revealed opener stays revealed); the check may scroll the container
 *  into view and back, so `act` (the unit's first action arms the write block) runs before it. An error refuses. */
async function markOpenerSeen(page: Page, id: string, act: () => void): Promise<OpenerRead> {
  // the unit runner took it before the unit's first action; again only after a reload (what is shown then counts as before)
  await page.evaluate(tipPreMark, null).catch(() => false);
  const r = await page.evaluate(markOpener, { id });
  if (!r.sole) return r;
  act();
  const px = await ownPixels(page, { park: false });
  const own = px === null || px.why !== null;
  const why = own ? (px === null ? "its pixels could not be compared" : px.why) : null;
  await page.evaluate(ownDecide, { own, why });
  return { ...r, why };
}
/** Close the open dialog with its SAFE close control (a button / [role=button] named Cancel, Close, ×…, never a
 *  navigating link, never a submit) — by a mouse click (an Enter on it would also fire a dialog's own "Enter =
 *  confirm" handler; known miss: an opener revealed only on its own :focus-visible then reads as invisible after this close).
 *  A close that changed the URL is reported as navigated, never as closed. */
async function safeCloseOn(page: Page, closedAfter: () => Promise<boolean>, act: () => void): Promise<{ closed: boolean; name: string; why: string }> {
  const cands = await page.evaluate(closeCandidates, null);
  for (const c of cands) {
    if (!safeCloseName(c.name, c.ariaLabel)) continue;
    const loc = byPath(page, c.path).first();
    if ((await loc.evaluate(submitGuard)) !== null) continue;
    const before = page.url();
    act();
    await loc.click({ timeout: 2000 });
    const closed = await closedAfter();
    if (page.url() !== before) return { closed: false, name: c.name, why: `the close control "${c.name}" navigated (${before} → ${page.url()})` };
    return closed ? { closed: true, name: c.name, why: "" } : { closed: false, name: c.name, why: `the close control "${c.name}" did not close it` };
  }
  return { closed: false, name: "", why: "no visible Cancel / Close / Dismiss / No / Not now / × button in the dialog (the probe never clicks Save, Delete, a submit or a link)" };
}
/** press Enter/Space on the opener — only when focus is the opener's control (keyTarget, markOpener's) and that
 *  control would not submit a form (submitGuard). Returns why it was NOT pressed, or null when pressed. */
async function pressOnOpener(page: Page, key: "Enter" | " ", act: () => void): Promise<string | null> {
  const k = await page.evaluate(keyTarget, null);
  if (!k.ok) return `${k.desc}: ${k.why}`;
  // the deep focused element: Playwright's CSS pierces open shadow roots, and a focused shadow descendant's host matches :focus
  // too — the last :focus in document order is the innermost
  const submits = await page.locator(":focus").last().evaluate(submitGuard, undefined, { timeout: 2000 }).catch(() => "the focused element could not be checked");
  if (submits !== null) return `${k.desc} would submit a form (${submits})`;
  act();
  await page.keyboard.press(key === " " ? "Space" : key);
  return null;
}

// ---------------------------------------------------------------- the write block (the safety net)
/** A write the page tried during a behaviour unit: method ("WebSocket" for a message), origin + path (no query), and the checks
 *  it is charged to (taintedPhases); `more`: the attempts after the unit's first TRIED_CAP that were blocked but not kept. */
export interface BlockedWrite { method: string; url: string; phases: string[]; more?: number }
/** A unit keeps its first TRIED_CAP write attempts and counts the rest (a page that reopens its WebSocket on every
 *  close tries again at once, without end) — and from then on leaves a new WebSocket unclosed (never connected to the server
 *  either), so such a page stops looping. */
export const TRIED_CAP = 20;
export interface TriedLog { list: Array<{ method: string; url: string }>; more: number }
/** Keep one write attempt (true) or only count it (false: the log is full). */
export function logTried(log: TriedLog, method: string, url: string, cap = TRIED_CAP): boolean {
  if (log.list.length < cap) { log.list.push({ method, url }); return true; }
  log.more++;
  return false;
}
/** The unit's blocked writes, each charged to `phases`; the uncounted rest rides on the last one. */
export function blockedOf(log: TriedLog, phases: string[]): BlockedWrite[] {
  return log.list.map((w, i) => ({ method: w.method, url: w.url, phases, ...(i === log.list.length - 1 && log.more > 0 ? { more: log.more } : {}) }));
}
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** The phase key of a row: its id, and its variant when it has one. */
const phaseOf = (c: Pick<BehaviourCheck, "id" | "variant">): string => `${c.id}|${c.variant ?? ""}`;
/** A check charged with a write the page tried is never judged: pass and fail both become not-run, naming the write.
 *  A write charged to a variant-less phase of the same id counts for every variant of it. */
export function judgeWrites(rows: BehaviourCheck[], blocked: readonly BlockedWrite[]): BehaviourCheck[] {
  return rows.map((c) => {
    const hits = blocked.filter((b) => b.phases.includes(phaseOf(c)) || b.phases.includes(`${c.id}|`));
    if (!hits.length) return c;
    const first = hits[0];
    const extra = hits.length - 1 + hits.reduce((n, b) => n + (b.more ?? 0), 0);
    return { ...c, status: "not-run", detail: `not-run: the page tried to write (${first ? `${first.method} ${new URL(first.url).pathname}` : "?"}${extra > 0 ? ` +${extra} more` : ""}) — blocked; not judged`,
      evidence: { ...(c.evidence ?? {}), blockedWrites: hits.slice(0, 5).map((b) => ({ method: b.method, url: b.url })), was: c.status } };
  });
}
/** The unit the write block reports to: whether it has acted yet (nothing is blocked before), and where a blocked write goes
 *  (false: the unit's log is full). */
interface UnitNet { armed: boolean; write(method: string, url: string): boolean }
const originPath = (url: string): string => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url; } };
/**
 * the write block, browser-wide — one CDP session on the BROWSER target with Fetch.enable for every URL at the request stage
 * (https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#method-enable; Playwright's Browser.newBrowserCDPSession). It
 * sees what a context's route never does: a SharedWorker's requests, and a service worker's — also one registered through
 * ServiceWorkerContainer.prototype.register, which Playwright's serviceWorkers:"block" (an init script replacing the instance's
 * register) lets through. Verified (Chromium 153, Playwright 1.63): fetch / XHR / sendBeacon / keepalive / PUT / DELETE /
 * PATCH / a custom method / form POSTs (self, _blank, an iframe target) / <a ping> / a popup / dedicated, blob and shared
 * workers / same- and cross-origin iframes / a service worker's install, message and pass-through fetches — none reaches the
 * server; GETs go on. Service workers are NOT blocked (an MSW-style app renders as measured). Every request
 * not GET/HEAD/OPTIONS is failed (BlockedByClient) and reported once the unit has acted; before (its load and --steps) it
 * goes on. Opened only after the measurement pass and the drive (verify-probe runs them first; none of their contexts is
 * open then), and detached when the units end — on a cut or a throw too (runBehaviour's finally).
 */
async function openWriteBlock(browser: Browser): Promise<{ unit(n: UnitNet | null): void; close(): void }> {
  const cdp = await browser.newBrowserCDPSession();
  let current: UnitNet | null = null;
  cdp.on("Fetch.requestPaused", (ev) => {
    const method = ev.request.method.toUpperCase();
    if (READ_METHODS.has(method) || current === null || !current.armed) { cdp.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => undefined); return; }
    current.write(method, originPath(ev.request.url));
    cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  });
  try {
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  } catch (e) {
    await cdp.detach().catch(() => undefined);
    throw e;
  }
  // never awaited: a wedged browser would not answer the detach (it is killed / closed right after the units)
  return { unit: (n) => { current = n; }, close: () => { cdp.detach().catch(() => undefined); } };
}
/**
 * What a unit's context needs beyond the session's (probe-session.ts: a fresh page reached like the measurement pass): its
 * WebSockets go through Playwright's routeWebSocket (https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket:
 * "only WebSockets created after this method was called will be routed" — it is set before the page exists, in prepare): server → page
 * messages always pass; page → server ones pass until the unit acts, then each is dropped and reported as a write (verified:
 * the server gets none, the page still receives); a socket opened once the unit has acted never reaches the server
 * (reported as a write, closed). Known miss: a WebSocket opened inside a worker is not routed. `failed` collects
 * the requests that failed while the screen was reached (named when the page differs from the measured one).
 */
function unitPageHooks(net: UnitNet, failed: string[]): { prepare(context: BrowserContext): Promise<void>; onPage(page: Page): void } {
  return {
    prepare: async (context) => {
      await context.routeWebSocket(/.*/, (ws) => {
        const url = originPath(ws.url());
        // a socket the page opens once the unit has acted is never connected — its handshake (a URL like
        // ?op=delete) is itself the action's side effect. A route that does not call connectToServer is a mock with no server
        // (https://playwright.dev/docs/api/class-websocketroute: "By default, routed WebSocket does not connect to the server");
        // it is reported as a write and closed (its messages, if any, are recorded too)
        // once the unit's log is full the socket is left open as an unconnected mock (not closed), so a page that
        // reopens on close stops looping
        if (net.armed) {
          const kept = net.write("WebSocket", url);
          ws.onMessage(() => { net.write("WebSocket", url); });
          if (kept) ws.close().catch(() => undefined);
          return;
        }
        const server = ws.connectToServer();
        ws.onMessage((m) => { if (net.armed) net.write("WebSocket", url); else server.send(m); });
        server.onMessage((m) => { ws.send(m); });
      });
    },
    onPage: (page) => {
      page.on("requestfailed", (r) => { if (!net.armed && failed.length < 5) failed.push(`${r.method()} ${new URL(originPath(r.url()), "http://x").pathname} (${r.failure()?.errorText ?? "failed"})`); });
    },
  };
}

type Declared = Pick<BehaviourCheck, "id" | "nodeId" | "trigger" | "variant">;
interface UnitApi {
  page: Page;
  add(c: BehaviourCheck): void;
  /** the check(s) now in progress ("id" or "id|variant") — a blocked write is charged to every check from the unit's first
   *  action on (taintedPhases) */
  phase(...keys: string[]): void;
  /** a key press / click / scroll / hover / resize is about to happen: from the first one on the unit's page cannot write */
  act(): void;
  /** throws when a document loaded since the screen was reached */
  guard(): void;
}
/** `battery`: a battery unit — its own share of the budget; `uses`: the tags it acts on (its row's opener and destination) —
 *  one shown on the measured page and missing from the unit's makes the unit not-run */
interface Unit { name: string; declared: Declared[]; battery?: boolean; uses?: string[]; run(u: UnitApi): Promise<void> }

/** a produced row answers a declared check: same id, and the same row / variant where the declaration names one */
const sameKey = (d: Declared, p: Declared): boolean => d.id === p.id && (d.nodeId === undefined || d.nodeId === p.nodeId) && (d.trigger === undefined || d.trigger === p.trigger) && (d.variant === undefined || d.variant === p.variant);

/** Fill every declared check the unit did not produce with a not-run row. */
function fill(out: BehaviourCheck[], produced: BehaviourCheck[], declared: Declared[], why: string): void {
  for (const d of declared) {
    if (produced.some((p) => sameKey(d, p))) continue;
    out.push({ id: d.id, status: "not-run", ...(d.nodeId !== undefined ? { nodeId: d.nodeId } : {}), ...(d.trigger !== undefined ? { trigger: d.trigger } : {}), ...(d.variant !== undefined ? { variant: d.variant } : {}), detail: `not-run: ${why}` });
  }
}

/**
 * Run the behaviour checks (module header). Never throws for a unit: a unit that throws, loads a document or is cut fills
 * its checks not-run with the reason. The caller still wraps it (a throw here — the write block could not be set up — is
 * {ran:false, why}). The write block lives exactly as long as the units: opened first, detached when they end.
 */
export async function runBehaviour(session: ProbeSession<Browser>, o: BehaviourOptions): Promise<BehaviourResult> {
  const t0 = Date.now();
  // inside the budget, and bounded: a browser that stopped answering never holds the probe here (one that answers late gets
  // its session detached at once)
  const opening = openWriteBlock(session.browser);
  const late = Symbol("no answer");
  const block = await Promise.race([opening, sleep(Math.min(WRITE_BLOCK_SETUP_MS, o.budgetMs), late, { ref: false })]);
  if (block === late) {
    opening.then((b) => { b.close(); }, () => undefined);
    throw new Error(`the write block could not be set up (the browser did not answer within ${Math.round(Math.min(WRITE_BLOCK_SETUP_MS, o.budgetMs) / 1000)} s)`);
  }
  try {
    return await runUnits(session, o, block, t0);
  } finally {
    block.close();
  }
}
const WRITE_BLOCK_SETUP_MS = 5_000;
type WriteBlock = Awaited<ReturnType<typeof openWriteBlock>>;
/** What the units of one runBehaviour share: the run's handles and budget (fixed for the run), what the units report (the
 *  checks and the run's landmarks / axe / widths / forced-colours shot, plus `cut`), and what a battery row's R-key unit tells
 *  its R-scroll unit. A unit reads it when it runs, so a later unit sees what an earlier one wrote. */
interface UnitCtx {
  readonly session: ProbeSession<Browser>;
  readonly o: BehaviourOptions;
  readonly block: WriteBlock;
  /** the behaviour budget's end (t0 + budgetMs) */
  readonly end: number;
  readonly checks: BehaviourCheck[];
  cut: boolean;
  landmarks: BehaviourLandmark[] | null;
  axe: BehaviourAxe;
  readonly widths: BehaviourWidth[];
  forced: Buffer | null;
  /** keyboard.activation per battery row (R-scroll opens by keyboard only when it passed) */
  readonly keyOpens: Map<string, "Enter" | " " | null>;
  /** rows whose opened element R-key found not modal: R-scroll does not run on them */
  readonly nonModal: Set<string>;
  /** battery units not yet run (each gets unitCap of what is left) */
  batteryLeft: number;
}
async function runUnits(session: ProbeSession<Browser>, o: BehaviourOptions, block: WriteBlock, t0: number): Promise<BehaviourResult> {
  const ctx: UnitCtx = {
    session, o, block, end: t0 + o.budgetMs, checks: [], cut: false, landmarks: null,
    axe: "why" in o.axe ? { ran: false, why: o.axe.why } : { ran: false, why: "axe did not run (the a11y unit was not reached)" },
    widths: [], forced: null, keyOpens: new Map(), nonModal: new Set(), batteryLeft: 0,
  };

  // ---- P1: landmarks, axe, the Tab walk
  await runUnit(ctx, a11yUnit(ctx));

  // ---- P2: forced colours, then the widths (live viewport changes)
  await runUnit(ctx, renderUnit(ctx));

  // ---- the battery: overlay rows opened as a modal by a real click in the drive
  await runBattery(ctx);

  return {
    behaviour: {
      version: 1, ran: true, browser: { name: o.browserName ?? "chromium", version: session.browser.version() }, namesComputedBy: NAMES_COMPUTED_BY,
      budgetMs: o.budgetMs, elapsedMs: Date.now() - t0, cut: ctx.cut, checks: ctx.checks, landmarks: ctx.landmarks, axe: ctx.axe, widths: ctx.widths, artifacts: ctx.forced ? [o.forcedPng] : [], writeBlock: WRITE_BLOCK_SCOPE,
    },
    forcedPng: ctx.forced,
  };
}
/** One unit on its own page, its own context and its share of the budget; what it produced (or the reason it did not) goes
 *  to ctx.checks, a cut sets ctx.cut. */
async function runUnit(ctx: UnitCtx, unit: Unit): Promise<void> {
  const tu = Date.now();
  try { await runUnitInner(ctx, unit); } finally { if (process.env.DT_BEHAVIOUR_DEBUG) console.error(`[behaviour] ${unit.name} ${Date.now() - tu}ms`); }
}
async function runUnitInner(ctx: UnitCtx, unit: Unit): Promise<void> {
  const { session, o, block, end, checks } = ctx;
  const produced: BehaviourCheck[] = [];
  const budgetLeft = end - Date.now();
  const left = unit.battery ? unitCap(budgetLeft, ctx.batteryLeft) : budgetLeft;
  if (unit.battery) ctx.batteryLeft--;
  if (left <= 0) { ctx.cut = true; fill(checks, [], unit.declared, "time budget"); return; }
  const unitEnd = Date.now() + left;
  let closed = false;
  let loadsAt = 0;
  let loadsNow: () => number = () => 0;
  // what the unit did, and the writes the block stopped (charged to checks once the unit is over)
  const trace: UnitTrace = { phases: [{ seq: 0, keys: ["reach|"] }], actions: [] };
  const tried: TriedLog = { list: [], more: 0 };
  const net: UnitNet = { armed: false, write: (method, url) => {
    const kept = logTried(tried, method, url);
    if (kept && process.env.DT_BEHAVIOUR_DEBUG) console.error(`[behaviour] ${unit.name}: blocked ${method} ${url} (in ${trace.phases.at(-1)?.keys.join(" ") ?? "?"})`);
    return kept;
  } };
  const api = (page: Page): UnitApi => ({
    page,
    add: (c) => { if (!closed) produced.push(c); },
    phase: (...keys) => { trace.phases.push({ seq: trace.phases.length, keys: keys.map((k) => (k.includes("|") ? k : `${k}|`)) }); },
    act: () => { net.armed = true; trace.actions.push({ at: Date.now(), seq: trace.phases.length - 1 }); },
    guard: () => { if (loadsNow() !== loadsAt) throw new UnitNavigated("the page loaded a new document"); },
  });
  const blocked = (): BlockedWrite[] => blockedOf(tried, taintedPhases(trace));
  block.unit(net);
  const loadFailures: string[] = [];
  const raced = await session.unit<string | null>({
    ms: left,
    ...unitPageHooks(net, loadFailures),
    act: async ({ page, loads }) => {
      loadsAt = loads(); loadsNow = loads;
      // the screen this unit reached must be the measured one — never judge an error / empty state instead
      if (o.measuredTags && o.measuredTags.length) {
        const diff = fingerprintDiff(o.measuredTags, await page.evaluate(visibleTags, null), unit.uses);
        if (diff !== null) throw new BatteryStop(`the page reached for this check differs from the measured page (${diff}${loadFailures.length ? `; failed while loading: ${loadFailures.slice(0, 3).join(", ")}` : ""})`);
      }
      // what is on screen before the unit's first action — a tooltip shown before it is not the control's
      await page.evaluate(tipPreMark, null).catch(() => false);
      await unit.run(api(page));
      return null;
    },
    // a write deferred a little after the unit's last action (an undo window) is still seen and charged — bounded by
    // the unit's own time
    beforeClose: async () => {
      const last = trace.actions.at(-1);
      const wait = last ? Math.min(WRITE_SETTLE_MS - (Date.now() - last.at), unitEnd - Date.now()) : 0;
      if (wait > 0) await sleep(wait, undefined, { ref: false });
    },
    unreached: (f) => f.why,
    failed: unitEndWhy,
    onCut: () => { closed = true; ctx.cut = true; },
  });
  if (raced.cut) {
    block.unit(null);
    checks.push(...judgeWrites(produced, blocked()));
    fill(checks, produced, unit.declared, left < budgetLeft ? `time budget (this unit's share: ${Math.round(left / 1000)} s)` : "time budget");
    return;
  }
  const r = raced.value;
  block.unit(null);
  closed = true;
  checks.push(...judgeWrites(produced, blocked()));
  if (r !== null) fill(checks, produced, unit.declared, r);
  else fill(checks, produced, unit.declared, "the unit ended before this check");
}

/** P1 (a11y): landmarks, axe, the Tab walk. */
function a11yUnit(ctx: UnitCtx): Unit {
  const { o, end } = ctx;
  const exp = o.expectation;
  const hidden = new Set((exp.hidden && exp.hidden.ids) || []);
  const subjectIds = [...new Set((exp.interactions || []).filter((r) => !hidden.has(r.nodeId) && /^on_(click|press)$/i.test(String(r.trigger))).map((r) => r.nodeId))];
  return {
    name: "a11y",
    declared: [{ id: "a11y.landmarks" }, { id: "a11y.axe" }, { id: "keyboard.reachable" }, { id: "keyboard.focus-visible" }, { id: "a11y.name" }],
    run: async (u) => {
      const { page } = u;
      await park(page);
      u.phase("a11y.landmarks");
      let yaml: string | null = null;
      try { yaml = await page.locator("body").ariaSnapshot({ timeout: Math.min(ctx.session.timeout, 10_000) }); } catch (e) { if (endsUnit(e, page)) throw e; }
      const tree = yaml === null ? null : parseAriaLandmarkTree(yaml);
      ctx.landmarks = tree ? tree.landmarks : null;
      for (const c of landmarkFindings(tree, tree ? await page.evaluate(unnamedRegions, null) : [])) u.add(c);
      u.guard();
      // axe
      u.phase("a11y.axe");
      if ("why" in o.axe) u.add({ id: "a11y.axe", status: "not-run", detail: `not-run: ${o.axe.why}` });
      else {
        try {
          await page.evaluate(o.axe.source);
          // its own bound — min(20 s, what is left of the budget): a huge DOM or an app's own axe run must not take the unit
          const axeCap = Math.max(1000, Math.min(AXE_CAP_MS, end - Date.now()));
          const res: unknown = await Promise.race([page.evaluate(`(async () => { const r = await axe.run(document, { resultTypes: ["violations"], iframes: false }); return { version: axe.version, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact == null ? null : String(v.impact), nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 3).map((n) => Array.isArray(n.target) ? n.target.map(String).join(" ") : String(n.target)) })) }; })()`),
            sleep(axeCap, AXE_TIMED_OUT, { ref: false })]);
          if (res === AXE_TIMED_OUT) throw new AxeTimeout(`axe timed out after ${Math.round(axeCap / 1000)} s`);
          const parsed = readAxeResult(res, o.axe.version);
          ctx.axe = parsed;
          if (parsed.ran) {
            const st = axeStatus(parsed.violations);
            const list = parsed.violations.map((v) => `${v.id} (${v.impact ?? "?"}, ${v.nodes} node${v.nodes === 1 ? "" : "s"})`).join(", ");
            u.add({ id: "a11y.axe", status: st, detail: st === "pass" ? `axe-core ${parsed.version}: no violations (main frame; iframes not scanned)` : `axe-core ${parsed.version}: ${parsed.violations.length} violation(s) — ${list} (critical/serious = fail, moderate/minor = warn; main frame; iframes not scanned)`, evidence: { version: parsed.version, violations: parsed.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes, help: v.help, targets: v.targets })) } });
          }
        } catch (e) {
          if (endsUnit(e, page)) throw e;
          ctx.axe = { ran: false, why: e instanceof AxeTimeout ? e.message : `axe-core ${o.axe.version} failed in the page: ${firstLine(e)}` };
          u.add({ id: "a11y.axe", status: "not-run", detail: `not-run: ${ctx.axe.why}` });
        }
      }
      u.guard();
      // the Tab walk from a focused sentinel: it ends back on the sentinel, on body after a stop, or at 150 Tab
      // presses (a repeated element — a date input's fields, a shadow host, an iframe's content — is skipped, never a loop)
      await park(page);
      u.phase("keyboard.reachable", "keyboard.focus-visible", "a11y.name");
      const walkStarted = await page.evaluate(sentinelInsert, null);
      let walkEnd: "sentinel" | "body" | "cap" | "start" = walkStarted ? "cap" : "start";
      for (let i = 0; walkStarted && i < WALK_CAP; i++) {
        u.act();
        await page.keyboard.press("Tab");
        const s = await page.evaluate(walkStep, { record: true });
        if (s.end !== null) { walkEnd = s.end; break; }
      }
      u.guard();
      const { n: nStops, visible: stopVisible } = await page.evaluate(stopsCount, null);
      const visibleAt = (i: number): boolean => stopVisible[i] === true;
      // keyboard.reachable
      // each subject marked (markOpener: its control) and read against the recorded stops
      const subs: Array<SubjectRead & { why: string | null }> = [];
      for (const id of subjectIds) { const mo = await markOpenerSeen(page, id, u.act); subs.push({ ...(await page.evaluate(subjectRead, { id })), why: mo.why }); }
      const reachRows: BehaviourCheck[] = [];
      let reachedOk = 0, reachTotal = 0;
      for (const s of subs) {
        if (s.count !== 1) continue; // not tagged exactly once: not a subject
        reachTotal++;
        const ev: JsonObject = { visibility: s.visibility, tabindex: s.tabindex, tag: s.tag };
        if (!s.hasBox) { reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: "not-run: display:none at rest (no layout box) — nothing to reach", evidence: ev }); continue; }
        if (s.disabled) { reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: "not-run: disabled", evidence: ev }); continue; }
        if (s.stop < 0) {
          if (s.closedIn !== null) { reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: `not-run: inside a closed container (${s.closedIn}) — reachable once it is opened`, evidence: ev }); continue; }
          if (walkEnd === "start") { reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: "not-run: the Tab walk could not establish its focus starting point", evidence: ev }); continue; }
          if (walkEnd === "cap") { reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: `not-run: the Tab walk stopped at ${WALK_CAP} Tab presses (${nStops} stops) before reaching it`, evidence: ev }); continue; }
          // Tab reaches a control INSIDE a container opener that is not the opener's own control (a card's Delete,
          // one of two buttons in a cell) — that control is reached, the opener is not known to be (never a fail on a guess)
          if (s.inside !== null) { reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: `not-run: the opener is a container; Tab reaches ${s.inside} inside it, which is not the opener's own control${s.why !== null ? ` — ${s.why}` : ""} (keyboard.activation reports it)`, evidence: ev }); continue; }
          reachRows.push({ id: "keyboard.reachable", status: "fail", nodeId: s.id, detail: `not reached by Tab (computed visibility ${s.visibility || "?"}, tabindex ${s.tabindex ?? "none"}, <${s.tag}>) — a keyboard user cannot reach this control; hover-only actions must stay focusable (opacity + :focus-within, never visibility:hidden), and a clickable non-button needs tabindex="0" or a <button>`, evidence: ev });
          continue;
        }
        if (!visibleAt(s.stop)) { reachRows.push({ id: "keyboard.reachable", status: "warn", nodeId: s.id, detail: "reached by Tab but invisible while focused (opacity 0 / hidden) — reveal it on focus too (e.g. group-focus-within:opacity-100)", evidence: { ...ev, stop: s.stop } }); continue; }
        reachedOk++;
      }
      for (const c of perElement("keyboard.reachable", reachRows, reachedOk, reachTotal, "interactive element(s) reached by Tab and visible while focused")) u.add(c);
      if (reachTotal === 0) u.add({ id: "keyboard.reachable", status: "not-run", detail: "not-run: the expectation lists no click/press interaction tagged exactly once on the screen" });
      // keyboard.focus-visible: the first 60 stops
      const fvRows: BehaviourCheck[] = [];
      let fvOk = 0;
      const fvN = Math.min(nStops, 60);
      const shot = (clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> => page.screenshot({ clip, animations: "disabled", caret: "hide" });
      u.phase("keyboard.focus-visible");
      const fvRes: Array<{ i: number; status: BehaviourStatus; detail: string; evidence?: JsonObject }> = [];
      for (let i = 0; i < fvN; i++) {
        u.guard();
        if (!(await page.evaluate(focusBefore, { i }))) { fvRes.push({ i, status: "not-run", detail: "not-run: could not focus the stop before it" }); continue; }
        u.act();
        await page.keyboard.press("Tab");
        await raf2(page);
        let f = await page.evaluate(focusedStop, { i });
        // a stop Tab moves INSIDE (a date input's fields, an iframe's content) keeps focus: Tab on until it leaves (≤ 10)
        for (let k = 0; k < 10 && !f.ok && f.onPrev; k++) { u.act(); await page.keyboard.press("Tab"); await raf2(page); f = await page.evaluate(focusedStop, { i }); }
        if (!f.ok) { fvRes.push({ i, status: "not-run", detail: "not-run: a Tab from the previous stop did not land on it again" }); continue; }
        if (!f.visible) { fvRes.push({ i, status: "not-run", detail: "not-run: invisible while focused (keyboard.reachable reports it when it is an interaction)" }); continue; }
        const M = 8;
        const x0 = Math.max(0, Math.floor(f.rect.x - M)), y0 = Math.max(0, Math.floor(f.rect.y - M));
        const x1 = Math.min(f.vw, Math.ceil(f.rect.x + f.rect.w + M)), y1 = Math.min(f.vh, Math.ceil(f.rect.y + f.rect.h + M));
        if (x1 - x0 < 1 || y1 - y0 < 1) { fvRes.push({ i, status: "not-run", detail: "not-run: off screen while focused" }); continue; }
        const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const focusedPng = await shot(clip);
        await page.evaluate(blurActive, null);
        await raf2(page);
        const blurredPng = await shot(clip);
        const evidence: JsonObject = { outlineStyle: f.outlineStyle, outlineWidth: f.outlineWidth, boxShadow: f.boxShadow, focusVisible: f.focusVisible };
        if (focusedPng.equals(blurredPng)) fvRes.push({ i, status: "fail", detail: `no visible focus indicator: focused and unfocused look identical (±8 px around it) — outline-style ${f.outlineStyle || "?"}, box-shadow ${f.boxShadow || "?"}; a utility that hides the outline needs a visible replacement on :focus-visible (e.g. Tailwind v4 focus-visible:outline-solid, or a ring)`, evidence });
        else { fvRes.push({ i, status: "pass", detail: "", evidence }); fvOk++; }
      }
      await page.evaluate(sentinelRemove, null);
      const info = await page.evaluate(stopsInfo, null);
      for (const r of fvRes) {
        if (r.status === "pass") continue;
        const s = info[r.i];
        fvRows.push({ id: "keyboard.focus-visible", status: r.status, ...(s && s.dt !== null ? { nodeId: s.dt } : {}), ...(s ? { target: s.path } : {}), detail: r.detail, ...(r.evidence ? { evidence: r.evidence } : {}) });
      }
      if (nStops > 60) fvRows.push({ id: "keyboard.focus-visible", status: "not-run", detail: `not-run: ${nStops - 60} Tab stop(s) after the first 60`, evidence: { count: nStops - 60 } });
      for (const c of perElement("keyboard.focus-visible", fvRows, fvOk, fvN, "Tab stop(s) show a visible focus indicator")) u.add(c);
      if (nStops === 0) u.add({ id: "keyboard.focus-visible", status: "not-run", detail: "not-run: Tab reached no focusable element" });
      // a11y.name: the first line of each stop's aria snapshot
      u.phase("a11y.name");
      const nameRows: BehaviourCheck[] = [];
      let nameOk = 0, judged = 0;
      const nameWhat = `Tab stop(s) have a role and an accessible name (${NAMES_COMPUTED_BY})`;
      try {
        for (const [i, s] of info.entries()) {
          judged = i;
          u.guard();
          if (!s.connected) { nameRows.push({ id: "a11y.name", status: "not-run", ...(s.dt !== null ? { nodeId: s.dt } : {}), target: s.path, detail: "not-run: left the document during the walk" }); continue; }
          let snap = "";
          try { snap = await byPath(page, s.path).first().ariaSnapshot({ timeout: 2000 }); } catch (e) {
            if (endsUnit(e, page)) throw e;
            nameRows.push({ id: "a11y.name", status: "not-run", ...(s.dt !== null ? { nodeId: s.dt } : {}), target: s.path, detail: `not-run: no accessibility snapshot (${firstLine(e)})` });
            continue;
          }
          const n = nameStatus(snap, s);
          const ev: JsonObject = { snapshot: (snap.split("\n")[0] ?? "").slice(0, 120), tag: s.tag, stop: i, ...(s.domName !== null ? { domName: s.domName } : {}) };
          if (n.status === "warn") nameRows.push({ id: "a11y.name", status: "warn", ...(s.dt !== null ? { nodeId: s.dt } : {}), target: s.path, detail: `a focusable <${s.tag}> with no role — give it a role (or use a native control) and a name; names computed by ${NAMES_COMPUTED_BY}`, evidence: ev });
          else if (n.status === "fail") nameRows.push({ id: "a11y.name", status: "fail", ...(s.dt !== null ? { nodeId: s.dt } : {}), target: s.path, detail: `${n.role} with no accessible name — an icon-only control needs aria-label (or visible text); names computed by ${NAMES_COMPUTED_BY}`, evidence: ev });
          else nameOk++;
        }
      } catch (e) {
        // the unit ends here (a reload, a closed or crashed page): the stops judged so far keep their rows, the rest are
        // one not-run row with the unit's reason — the unit's own fill then adds nothing more for a11y.name
        for (const c of perElement("a11y.name", nameRows, nameOk, judged, nameWhat)) u.add(c);
        u.add({ id: "a11y.name", status: "not-run", detail: `not-run: ${info.length - judged} of ${info.length} Tab stop(s) not checked — ${unitEndWhy(e)}`, evidence: { count: info.length - judged, of: info.length } });
        throw e;
      }
      for (const c of perElement("a11y.name", nameRows, nameOk, info.length, nameWhat)) u.add(c);
      if (info.length === 0) u.add({ id: "a11y.name", status: "not-run", detail: "not-run: Tab reached no focusable element" });
    },
  };
}

/** P2 (render): forced colours, then the widths (live viewport changes). */
function renderUnit(ctx: UnitCtx): Unit {
  const { o, widths } = ctx;
  const designW = ctx.session.viewport.w, designH = ctx.session.viewport.h;
  const mid = designW >= 1280, narrow = designW > 320;
  return {
    name: "render",
    declared: [{ id: "forced-colors.visible" }, { id: "layout.subpixel", variant: "design" }, ...(mid ? [{ id: "overflow.mid" as const }, { id: "layout.subpixel" as const, variant: `1024x${designH}` }] : []),
      ...(narrow ? [{ id: "overflow.narrow" as const }, { id: "layout.subpixel" as const, variant: `320x${designH}` }] : [])],
    run: async (u) => {
      const { page } = u;
      await park(page);
      // forced-colors.visible
      u.phase("forced-colors.visible");
      if ((o.browserName ?? "chromium") !== "chromium") u.add({ id: "forced-colors.visible", status: "unsupported", detail: "forced colours are emulated in Chromium only" });
      else {
        const cands = await page.evaluate(maskCandidates, { cap: 40 });
        const pairs: Array<{ normalDiffers: boolean; clip: { x: number; y: number; width: number; height: number } | null }> = [];
        const toggle = async (i: number): Promise<{ differs: boolean; clip: { x: number; y: number; width: number; height: number } } | null> => {
          u.act();
          const r = await page.evaluate(maskShow, { i });
          if (!r) return null;
          await raf2(page);
          const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(r.vw, Math.ceil(r.x + r.w)), y1 = Math.min(r.vh, Math.ceil(r.y + r.h));
          if (x1 - x0 < 1 || y1 - y0 < 1) return null;
          const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
          const a = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
          await page.evaluate(maskHide, { i, hide: true });
          await raf2(page);
          const b = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
          await page.evaluate(maskHide, { i, hide: false });
          return { differs: !a.equals(b), clip };
        };
        for (let i = 0; i < cands.length; i++) { u.guard(); const t = await toggle(i); pairs.push({ normalDiffers: t ? t.differs : false, clip: t ? t.clip : null }); }
        u.act();
        await page.emulateMedia({ forcedColors: "active" });
        await page.evaluate(scrollToY, { y: 0 });
        await raf2(page);
        ctx.forced = await page.screenshot({ animations: "disabled", caret: "hide" });
        const rows: BehaviourCheck[] = [];
        let okN = 0, total = 0;
        for (let i = 0; i < cands.length; i++) {
          u.guard();
          const c = cands[i];
          const p = pairs[i];
          if (!c || !p) continue;
          const nodeId = c.dt !== null ? { nodeId: c.dt } : {};
          if (!p.normalDiffers) { rows.push({ id: "forced-colors.visible", status: "not-run", ...nodeId, detail: "not-run: hiding it changes nothing even in normal colours (covered or blank)" }); continue; }
          total++;
          const t = await toggle(i);
          if (t === null) { rows.push({ id: "forced-colors.visible", status: "not-run", ...nodeId, detail: "not-run: not on screen under forced colours" }); continue; }
          if (!t.differs) rows.push({ id: "forced-colors.visible", status: "fail", ...nodeId, detail: `a CSS-mask icon (<${c.tag}>${c.dt !== null ? ` in data-dt-node="${c.dt}"` : ""}) vanishes under forced colours: its background-color is forced to Canvas — add forced-color-adjust:none, or background-color:CanvasText inside @media (forced-colors: active) (an inline SVG with fill=currentColor needs nothing)` });
          else okN++;
        }
        await page.emulateMedia({ forcedColors: "none" });
        await raf2(page);
        for (const c of perElement("forced-colors.visible", rows, okN, total, "CSS-mask icon(s) stay visible under forced colours")) u.add(c);
        if (!cands.length) u.add({ id: "forced-colors.visible", status: "not-run", detail: "not-run: no CSS-mask icon on the screen (the only kind this check tests: SVG fill/stroke, <img> and url() backgrounds are not forced; plain background-colour boxes become Canvas by design)" });
      }
      u.phase("layout.subpixel", "overflow.mid", "overflow.narrow");
      const subRows = (variant: string, list: BehaviourWidth["subpixel"]): void => {
        const rows: BehaviourCheck[] = list.map((s) => ({ id: "layout.subpixel" as const, status: "warn" as const, variant, ...(s.dt !== null ? { nodeId: s.dt } : {}), target: s.path, detail: `<${s.tag}>${s.text ? ` "${s.text}"` : ""} renders ${s.width}px wide — a collapsed ${s.tag === "td" || s.tag === "th" ? "table column" : "text box"} (a behaviour warning, not a fidelity delta)`, evidence: { width: s.width } }));
        if (rows.length) for (const c of perElement("layout.subpixel", rows, 0, 0, "", variant)) u.add(c);
        else u.add({ id: "layout.subpixel", status: "pass", variant, detail: "no table cell or text renders under 1px wide" });
      };
      const overflowOf = (ov: PageOverflow & { compatMode: string }): PageOverflow => {
        const { compatMode, ...rest } = ov;
        return { ...rest, ...(compatMode !== "CSS1Compat" ? { compatMode } : {}) };
      };
      u.act();
      await page.evaluate(scrollToY, { y: 0 });
      const designSub = await page.evaluate(subpixelRead, null);
      widths.push({ role: "design", overflow: overflowOf(await page.evaluate(readPageOverflow, null)), subpixel: designSub });
      subRows("design", designSub);
      const settleResize = async (w: number): Promise<void> => {
        u.act();
        await page.setViewportSize({ width: w, height: designH });
        await raf2(page);
        const t = Date.now();
        let last = "", stable = 0;
        // poll until the size is unchanged twice 100 ms apart (min 300 ms, max 1.5 s)
        for (;;) {
          await sleep(100);
          const s = await page.evaluate(docSize, null);
          const sig = `${s.sw}x${s.sh}`;
          stable = sig === last ? stable + 1 : 0;
          last = sig;
          if ((stable >= 2 && Date.now() - t >= 300) || Date.now() - t >= 1500) break;
        }
      };
      const at = async (role: "mid" | "narrow", w: number): Promise<void> => {
        u.guard();
        await settleResize(w);
        u.guard();
        const ov = overflowOf(await page.evaluate(readPageOverflow, null));
        const sub = await page.evaluate(subpixelRead, null);
        widths.push({ role, overflow: ov, subpixel: sub });
        const variant = `${w}x${designH}`;
        const id: BehaviourCheckId = role === "mid" ? "overflow.mid" : "overflow.narrow";
        const note = "live resize: load-time-only layouts not reproduced";
        const evidence: JsonObject = { viewport: variant, scrollWidth: ov.scrollWidth, clientWidth: ov.clientWidth, overflowX: ov.overflowX, offenders: ov.offenders.map((x) => ({ path: x.path, dt: x.dt, right: x.right })), note };
        if (ov.scrollable) {
          const twoD = role === "narrow" && await page.evaluate(offendersAre2D, { paths: ov.offenders.map((x) => x.path) });
          const names = ov.offenders.slice(0, 3).map((x) => x.dt !== null ? `data-dt-node="${x.dt}"` : x.path).join(", ");
          u.add({ id, status: "warn", variant, detail: `at ${w}px the page scrolls sideways (scrollWidth ${ov.scrollWidth} > ${ov.clientWidth}; widest: ${names || "?"})${role === "narrow" ? " — WCAG 1.4.10 reflow" : ""}${twoD ? "; WCAG 1.4.10 2-D content exception may apply (every offender is inside a table/pre/figure/media/grid)" : ""} (${note})`, evidence });
        } else u.add({ id, status: "pass", variant, detail: `no sideways scroll at ${w}px (${note})`, evidence });
        subRows(variant, sub);
      };
      if (mid) await at("mid", 1024);
      if (narrow) await at("narrow", 320);
      if (!mid) u.add({ id: "overflow.mid", status: "not-run", detail: `not-run: the design is ${designW}px wide (the 1024px check runs for designs ≥ 1280px)` });
      if (!narrow) u.add({ id: "overflow.narrow", status: "not-run", detail: `not-run: the design is ${designW}px wide (not wider than 320px)` });
    },
  };
}

/** One battery row as its two units see it: `key` (nodeId|trigger) names it in keyOpens / nonModal, `base` is what each of
 *  its checks carries, `contract` the detector's dialog selectors, `uses` the tags it acts on. */
interface BatteryRow { row: VerifyInteraction; key: string; base: { nodeId: string; trigger: string }; destId: string | null; contract: string[]; uses: string[] }
/** The battery: per overlay row opened as a modal by a real click in the drive, R-key then R-scroll (each its own share of
 *  the budget). */
async function runBattery(ctx: UnitCtx): Promise<void> {
  const { o, checks, keyOpens } = ctx;
  const exp = o.expectation;
  const { battery, skipped } = batteryRows(exp, o.driven);
  for (const { row, why } of skipped) for (const id of DIALOG_IDS) checks.push({ id, status: "not-run", nodeId: row.nodeId, trigger: row.trigger, detail: `not-run: ${why}` });
  ctx.batteryLeft = battery.length * 2;
  for (const row of battery) {
    const key = `${row.nodeId}|${row.trigger}`;
    const base = { nodeId: row.nodeId, trigger: row.trigger };
    const destId = row.destinationId ?? null;
    const contract = [...DIALOG_CONTRACT];
    const uses = destId === null ? [row.nodeId] : [row.nodeId, destId];
    const b: BatteryRow = { row, key, base, destId, contract, uses };
    await runUnit(ctx, keyUnit(ctx, b));
    // a key that opened the dialog but was charged with a write is not pressed again to open it without scrolling
    if (keyOpens.get(key) !== null && checks.some((c) => c.id === "keyboard.activation" && c.nodeId === row.nodeId && c.trigger === row.trigger && c.status === "not-run")) keyOpens.set(key, null);
    await runUnit(ctx, scrollUnit(ctx, b));
  }
}
/** R-key: keyboard activation, focus on open, focus trap, Escape closes, focus return, nested Escape. */
function keyUnit(ctx: UnitCtx, b: BatteryRow): Unit {
  const { keyOpens, nonModal } = ctx;
  const { row, key, base, destId, contract, uses } = b;
  return {
    name: `keyboard ${key}`, battery: true, uses,
    declared: [{ id: "keyboard.activation", ...base }, { id: "dialog.focus-on-open", ...base }, { id: "dialog.focus-trap", ...base }, { id: "dialog.escape-closes", ...base },
      { id: "dialog.focus-return", ...base, variant: "escape" }, { id: "dialog.focus-return", ...base, variant: "close" }, { id: "dialog.nested-escape", ...base }],
    run: async (u) => {
      const { page } = u;
      const add = (c: Omit<BehaviourCheck, "nodeId" | "trigger">): void => u.add({ ...c, ...base });
      await park(page);
      const detect = async (): Promise<DetectorRead["opened"]> => {
        const t = Date.now();
        for (;;) {
          const r = await page.evaluate(pollDetector, { destId, contract });
          if (r.lost) throw new UnitNavigated("the page loaded a new document");
          if (r.opened && (destId === null || (r.dest !== null && r.dest.inside) || Date.now() - t >= 500)) return r.opened;
          if (Date.now() - t >= 2000) return r.opened;
          await sleep(100);
        }
      };
      /** null opened + blocked: the key was never pressed */
      const keyOpen = async (key: "Enter" | " "): Promise<{ opened: DetectorRead["opened"]; blocked: string | null }> => {
        await page.evaluate(armDetector, { destId, contract });
        const blocked = await pressOnOpener(page, key, u.act);
        return blocked !== null ? { opened: null, blocked } : { opened: await detect(), blocked: null };
      };
      /** the drive's mouse path: reveal a hover-hidden opener (pointer parked, hover its nearest visible ancestor), real click */
      const mouseOpen = async (): Promise<{ opened: DetectorRead["opened"]; why?: string }> => {
        let st = await page.evaluate(openerState, { id: row.nodeId });
        if (st.count !== 1 || st.path === null) return { opened: null, why: `the opener matched ${st.count} element(s)` };
        if (st.disabled) return { opened: null, why: "the opener is disabled" };
        if (!st.visible && st.hoverPath !== null) {
          await page.mouse.move(0, 0);
          u.act();
          await byPath(page, st.hoverPath).first().hover({ timeout: 2000 }).catch(() => undefined);
          await raf2(page);
          st = await page.evaluate(openerState, { id: row.nodeId });
        }
        if (!st.visible || st.path === null) return { opened: null, why: "the opener is not visible even on hover" };
        const loc = byPath(page, st.path).first();
        if ((await loc.evaluate(submitGuard)) !== null) return { opened: null, why: "the opener would submit a form" };
        await markOpenerSeen(page, row.nodeId, u.act);
        await page.evaluate(armDetector, { destId, contract });
        u.act();
        await loc.click({ timeout: 2000 });
        return { opened: await detect() };
      };
      // keyboard.activation: Tab from a sentinel to the opener, Enter (then Space)
      u.phase("keyboard.activation");
      const marked = await markOpenerSeen(page, row.nodeId, u.act);
      const walkStarted = await page.evaluate(sentinelInsert, null);
      let reachedOpener = false;
      let ancestorStop: string | null = null, insideStop: string | null = null;
      for (let i = 0; walkStarted && i < WALK_CAP; i++) {
        u.act();
        await page.keyboard.press("Tab");
        const s = await page.evaluate(walkStep, { record: true });
        if (s.opener) { reachedOpener = true; break; }
        if (s.ancestor !== null && ancestorStop === null) ancestorStop = s.ancestor;
        if (s.inside !== null && insideStop === null) insideStop = s.inside;
        if (s.end !== null) break;
      }
      // gone before anything opens: the detector's paths are the page's own (focus stays where the walk left it)
      await page.evaluate(sentinelRemove, null);
      u.guard();
      let opened: DetectorRead["opened"] = null;
      let via: "Enter" | " " | null = null;
      const notSelf = (what: string): string => `not-run: the Tab stop at the opener is not the opener itself (${what}) — no key is pressed there`;
      if (!reachedOpener) add({ id: "keyboard.activation", status: "not-run", detail: insideStop !== null ? notSelf(`the opener is a container; its focusable child ${insideStop} is not pressed${marked.why !== null ? ` — ${marked.why}` : ""}`)
        : ancestorStop !== null ? notSelf(`${ancestorStop}, an ancestor of it`) : !walkStarted ? "not-run: the Tab walk could not establish its focus starting point" : "not-run: Tab never reaches the opener (keyboard.reachable reports it)" });
      else {
        const e1 = await keyOpen("Enter");
        if (e1.blocked !== null) add({ id: "keyboard.activation", status: "not-run", detail: notSelf(e1.blocked) });
        else {
          opened = e1.opened;
          let spaceBlocked: string | null = null;
          if (opened) via = "Enter";
          else {
            u.guard();
            // nothing opened (detect waited 2 s): Space only on the opener again (keyTarget re-checks where focus is)
            const e2 = await keyOpen(" ");
            spaceBlocked = e2.blocked;
            opened = e2.opened;
            if (opened) via = " ";
          }
          add(via === "Enter" ? { id: "keyboard.activation", status: "pass", detail: "Tab reaches the opener and Enter opens the dialog" }
            : via === " " ? { id: "keyboard.activation", status: "warn", detail: "only Space opens it, Enter does not — a button opens on both (a <button> does this by itself)" }
            : { id: "keyboard.activation", status: "fail", detail: `Tab reaches the opener but ${spaceBlocked === null ? "neither Enter nor Space opens" : `Enter does not open (Space not pressed: ${spaceBlocked})`} the dialog — a div with only onclick? use <button> (or handle Enter and Space)` });
        }
      }
      keyOpens.set(key, via);
      u.guard();
      const open = async (): Promise<{ opened: DetectorRead["opened"]; why?: string }> => {
        if (via !== null) {
          await markOpenerSeen(page, row.nodeId, u.act);
          await page.evaluate(focusOpener, { preventScroll: false });
          const r = await keyOpen(via);
          if (r.blocked === null) return { opened: r.opened };
        }
        return mouseOpen();
      };
      if (!opened) {
        u.phase("dialog.focus-on-open");
        const m = await mouseOpen();
        opened = m.opened;
        if (!opened) throw new BatteryStop(`the dialog did not open in the battery's page (${m.why ?? "nothing opened within 2 s"})`);
      }
      const kind = await page.evaluate(markDialog, { path: opened.selector });
      if (!kind.found) throw new BatteryStop("the opened element could not be found again");
      if (!(kind.modal || kind.dialogOpen || kind.ariaModal)) { nonModal.add(key); throw new BatteryStop(`the opened element is not a modal dialog — ${NOT_MODAL}`); }
      const modal = kind.modal || kind.ariaModal;
      // dialog.focus-on-open
      u.phase("dialog.focus-on-open");
      await park(page);
      const f0 = await page.evaluate(focusVsDialog, { destId });
      add(f0.inside ? { id: "dialog.focus-on-open", status: "pass", detail: `focus moved into the dialog (initial target ${f0.desc}; recorded, not graded)`, evidence: { initial: f0.desc } }
        : { id: "dialog.focus-on-open", status: "fail", detail: `focus stayed ${f0.body ? "on <body>" : `on ${f0.desc}, outside the dialog`} when it opened — move focus into the dialog (its first control or its heading)`, evidence: { active: f0.desc } });
      u.guard();
      // dialog.focus-trap (modal only)
      u.phase("dialog.focus-trap");
      if (!modal) add({ id: "dialog.focus-trap", status: "not-run", detail: "not-run: a non-modal dialog[open] (show()) does not trap focus" });
      else {
        const n = await page.evaluate(dialogTabbables, null);
        if (n > 30) add({ id: "dialog.focus-trap", status: "not-run", detail: "not-run: too many tabbables to prove a trap (more than 30 in the dialog)" });
        let escaped: string | null = n > 30 ? "" : null;
        for (const k of ["Tab", "Shift+Tab"]) {
          for (let i = 0; i < n + 2 && escaped === null; i++) {
            u.act();
            await page.keyboard.press(k);
            const f = await page.evaluate(focusVsDialog, { destId });
            if (!f.inside && !f.body) escaped = `${k} ×${i + 1} moved focus to ${f.desc}`;
          }
        }
        if (n <= 30) add(escaped === null ? { id: "dialog.focus-trap", status: "pass", detail: `Tab and Shift+Tab ×${n + 2} each stay inside the dialog (${n} tabbable element(s))` }
          : { id: "dialog.focus-trap", status: "fail", detail: `focus left the modal dialog: ${escaped} — trap Tab inside a modal (showModal() does, a div needs a focus trap)` });
      }
      u.guard();
      // dialog.escape-closes + dialog.focus-return (escape): one Escape on this open
      u.phase("dialog.escape-closes", "dialog.focus-return|escape");
      u.act();
      await page.keyboard.press("Escape");
      const closedAfter = async (): Promise<boolean> => {
        const t = Date.now();
        for (;;) {
          await raf2(page);
          if (!(await page.evaluate(dialogOpenNow, null))) return true;
          if (Date.now() - t >= 1000) return false;
          await sleep(100);
        }
      };
      const escClosed = await closedAfter();
      add(escClosed ? { id: "dialog.escape-closes", status: "pass", detail: "Escape closes the dialog" }
        : { id: "dialog.escape-closes", status: modal ? "fail" : "warn", detail: `Escape left the ${modal ? "modal " : ""}dialog open — close it on Escape (showModal() does; a div dialog needs a keydown handler)` });
      let closedBy = "";
      const focusReturn = async (variant: "escape" | "close"): Promise<void> => {
        await park(page);
        const r = await page.evaluate(focusReturnRead, null);
        const s = focusReturnStatus(r);
        add({ id: "dialog.focus-return", status: s.status, variant, detail: `after ${variant === "escape" ? "Escape" : `the close control "${closedBy}"`}: ${s.detail}`,
          evidence: { active: r.activeDesc, openerVisible: r.openerVisible, opacity0: r.opacity0, connected: r.connected, ...(variant === "close" ? { closedBy } : {}) } });
      };
      const safeClose = async (): Promise<{ closed: boolean; why: string }> => {
        const r = await safeCloseOn(page, closedAfter, u.act);
        closedBy = r.name;
        return r;
      };
      let closeDone = false;
      if (escClosed) await focusReturn("escape");
      else {
        add({ id: "dialog.focus-return", status: "not-run", variant: "escape", detail: "not-run: Escape did not close the dialog" });
        u.phase("dialog.focus-return|close");
        const c = await safeClose();
        if (!c.closed) {
          add({ id: "dialog.focus-return", status: "not-run", variant: "close", detail: `not-run: ${c.why ?? "the dialog stayed open"}` });
          throw new BatteryStop(`the dialog could not be closed for a fresh open (${c.why ?? "?"})`);
        }
        await focusReturn("close");
        closeDone = true;
      }
      u.guard();
      // dialog.nested-escape on its own open
      u.phase("dialog.nested-escape");
      const o2 = await open();
      if (!o2.opened) throw new BatteryStop(`the dialog did not open again (${o2.why ?? "nothing opened within 2 s"})`);
      await page.evaluate(markDialog, { path: o2.opened.selector });
      const x = await page.evaluate(expanderFind, null);
      let stillOpen = true;
      if (x.path === null) {
        add(x.nativePicker ? { id: "dialog.nested-escape", status: "not-run", synthetic: true, detail: "not-run: native picker: synthetic (headless), not a real-browser observation — the dialog holds only a native <select>/date control, whose popup headless Chromium does not open" }
          : { id: "dialog.nested-escape", status: "not-run", detail: "not-run: no expandable control ([aria-expanded]) in the dialog" });
      } else {
        const loc = byPath(page, x.path).first();
        if ((await loc.evaluate(submitGuard)) !== null) add({ id: "dialog.nested-escape", status: "not-run", detail: "not-run: the expandable control would submit a form" });
        else {
          u.act();
          await loc.click({ timeout: 2000 });
          let expanded = false;
          const t = Date.now();
          while (Date.now() - t < 1000) { if ((await page.evaluate(expanderState, null)) === "true") { expanded = true; break; } await sleep(100); }
          if (!expanded) add({ id: "dialog.nested-escape", status: "not-run", detail: `not-run: ${x.desc} never reported aria-expanded="true" within 1 s of a click` });
          else {
            u.act();
            await page.keyboard.press("Escape");
            await raf2(page);
            await sleep(150);
            await raf2(page);
            const dlgOpen = await page.evaluate(dialogOpenNow, null);
            const ctl = await page.evaluate(expanderState, null);
            stillOpen = dlgOpen;
            add(!dlgOpen ? { id: "dialog.nested-escape", status: "fail", detail: `Escape on the open ${x.desc} closed the whole dialog — the inner control must handle Escape (collapse it, preventDefault + stopPropagation) so the dialog stays open` }
              : ctl === "true" ? { id: "dialog.nested-escape", status: "warn", detail: `Escape left ${x.desc} expanded (the dialog stayed open) — Escape should collapse it first` }
              : { id: "dialog.nested-escape", status: "pass", detail: `Escape collapsed ${x.desc} and the dialog stayed open` });
          }
        }
      }
      u.guard();
      if (closeDone) return;
      // dialog.focus-return (close): the open dialog (or a fresh open), its safe close control
      u.phase("dialog.focus-return|close");
      if (!stillOpen || !(await page.evaluate(dialogOpenNow, null))) {
        const o3 = await open();
        if (!o3.opened) { add({ id: "dialog.focus-return", status: "not-run", variant: "close", detail: `not-run: the dialog did not open again (${o3.why ?? "nothing opened"})` }); return; }
        await page.evaluate(markDialog, { path: o3.opened.selector });
      }
      const c = await safeClose();
      if (!c.closed) { add({ id: "dialog.focus-return", status: "not-run", variant: "close", detail: `not-run: ${c.why ?? "the dialog stayed open"}` }); return; }
      await focusReturn("close");
    },
  };
}
/** R-scroll: scroll-open (y = 0 / 150 / max), scrim, click-outside. */
function scrollUnit(ctx: UnitCtx, b: BatteryRow): Unit {
  const { keyOpens, nonModal } = ctx;
  const { row, key, base, destId, contract, uses } = b;
  return {
    name: `scroll ${key}`, battery: true, uses,
    declared: [{ id: "dialog.scroll-open", ...base }, { id: "dialog.scrim", ...base }, { id: "dialog.click-outside", ...base }],
    run: async (u) => {
      if (nonModal.has(key)) throw new BatteryStop(`the opened element is not a modal dialog — ${NOT_MODAL}`);
      const { page } = u;
      const add = (c: Omit<BehaviourCheck, "nodeId" | "trigger">): void => u.add({ ...c, ...base });
      const ov = row.overlay;
      const centre = overlayCentred(ov);
      const keyVia = keyOpens.get(key) ?? null;
      await park(page);
      const detect = async (): Promise<DetectorRead["opened"]> => {
        const t = Date.now();
        for (;;) {
          const r = await page.evaluate(pollDetector, { destId, contract });
          if (r.lost) throw new UnitNavigated("the page loaded a new document");
          if (r.opened && (destId === null || (r.dest !== null && r.dest.inside) || Date.now() - t >= 500)) return r.opened;
          if (Date.now() - t >= 2000) return r.opened;
          await sleep(100);
        }
      };
      /** open WITHOUT scrolling: a mouse click at the opener's on-screen point (a hover-hidden one revealed by moving the
       *  pointer to its ancestor's point — never locator.hover, which scrolls), else focus({preventScroll})+the key that
       *  opened it in keyboard.activation */
      const openStill = async (): Promise<{ opened: DetectorRead["opened"]; how: string } | { why: string }> => {
        await page.mouse.move(0, 0);
        let p = await markOpenerSeen(page, row.nodeId, u.act);
        if (!p.found) return { why: "the opener is not on the page" };
        if (!p.visible && p.hover && p.hover.inViewport) {
          u.act();
          await page.mouse.move(p.hover.x, p.hover.y);
          await raf2(page);
          p = await markOpenerSeen(page, row.nodeId, u.act);
        }
        if (p.visible && p.inViewport && p.hits) {
          await page.evaluate(armDetector, { destId, contract });
          u.act();
          await page.mouse.click(p.x, p.y);
          return { opened: await detect(), how: "a mouse click at its on-screen point" };
        }
        if (keyVia !== null) {
          await page.evaluate(focusOpener, { preventScroll: true });
          await page.evaluate(armDetector, { destId, contract });
          const blocked = await pressOnOpener(page, keyVia, u.act);
          if (blocked !== null) return { why: `the opener is off screen at this scroll and the key is not pressed there (${blocked})` };
          return { opened: await detect(), how: `focus({preventScroll}) + ${keyVia === " " ? "Space" : "Enter"}` };
        }
        return { why: "the opener is off screen at this scroll and opens only by mouse (keyboard.activation did not pass)" };
      };
      const closedAfter = async (): Promise<boolean> => {
        const t = Date.now();
        for (;;) {
          await raf2(page);
          if (!(await page.evaluate(dialogOpenNow, null))) return true;
          if (Date.now() - t >= 1000) return false;
          await sleep(100);
        }
      };
      const closeAny = async (): Promise<boolean> => (await safeCloseOn(page, closedAfter, u.act)).closed;
      // dialog.scroll-open
      const size = await page.evaluate(docSize, null);
      const max = Math.max(0, size.sh - size.vh);
      const ys: Array<{ y: number; variant: string }> = max > 1 ? (max > 150 ? [{ y: 150, variant: "y=150" }, { y: max, variant: "y=max" }] : [{ y: max, variant: "y=max" }]) : [{ y: 0, variant: "y=0" }];
      let stuck = false;
      for (const { y, variant } of ys) {
        u.phase(`dialog.scroll-open|${variant}`);
        u.guard();
        if (stuck) { add({ id: "dialog.scroll-open", status: "not-run", variant, detail: "not-run: the dialog did not close after the previous scroll position" }); continue; }
        u.act();
        await page.evaluate(scrollToY, { y });
        await raf2(page);
        const y0 = await page.evaluate(effScroll, null);
        const op = await openStill();
        if ("why" in op) { add({ id: "dialog.scroll-open", status: "not-run", variant, detail: `not-run: ${op.why}` }); continue; }
        if (!op.opened) { add({ id: "dialog.scroll-open", status: "not-run", variant, detail: `not-run: nothing opened after ${op.how}` }); continue; }
        const k = await page.evaluate(markDialog, { path: op.opened.selector });
        if (k.found && !(k.modal || k.dialogOpen || k.ariaModal)) throw new BatteryStop(`the opened element is not a modal dialog — ${NOT_MODAL}`);
        // an entrance animation (Web Animations run under the probe's CSS animation:none) ends before the rect is read
        const settled = await page.evaluate(settleDialog, null);
        const g = await page.evaluate(dialogGeometry, { destId });
        const problems: string[] = [];
        if (Math.abs(g.scrollY - y0) > 1) problems.push(`opening it scrolled the page from y=${Math.round(y0)} to y=${Math.round(g.scrollY)}`);
        const rect = { x: Math.round(g.rect.x), y: Math.round(g.rect.y), w: Math.round(g.rect.w), h: Math.round(g.rect.h) };
        if (centre) {
          const c = centredIn(g.rect, { w: g.vw, h: g.vh });
          if (!c.centred) problems.push(`it is not centred in the viewport (${g.via} at ${rect.x},${rect.y} ${rect.w}×${rect.h} in ${g.vw}×${g.vh}; position ${g.position || "?"}) — the design centres it (overlay ${ov?.from === "default" ? "default = center" : "position center"}); a fixed / top-layer dialog stays centred at any scroll`);
        } else if (g.rect.x < -1 || g.rect.y < -1 || g.rect.x + g.rect.w > g.vw + 1 || g.rect.y + g.rect.h > g.vh + 1) problems.push(`it leaves the viewport (${g.via} at ${rect.x},${rect.y} ${rect.w}×${rect.h} in ${g.vw}×${g.vh})`);
        u.act();
        await page.keyboard.press("Escape");
        const closed = await closedAfter();
        await raf2(page);
        const after = await page.evaluate(effScroll, null);
        if (closed && Math.abs(after - y0) > 1) problems.push(`closing it scrolled the page from y=${Math.round(y0)} to y=${Math.round(after)}`);
        if (!closed && !(await closeAny())) stuck = true;
        const evidence: JsonObject = { y: Math.round(y0), afterOpen: Math.round(g.scrollY), afterClose: closed ? Math.round(after) : null, rect, viewport: { w: g.vw, h: g.vh }, position: g.position, openedBy: op.how,
          animations: settled.animations, stable: settled.stable };
        add(problems.length ? { id: "dialog.scroll-open", status: "fail", variant, detail: `opened at scroll y=${Math.round(y0)} by ${op.how}: ${problems.join("; ")}`, evidence }
          : { id: "dialog.scroll-open", status: "pass", variant, detail: `opened at scroll y=${Math.round(y0)} by ${op.how}: the page did not move${centre ? ", the dialog is centred" : ", the dialog is inside the viewport"}`, evidence });
      }
      u.guard();
      // dialog.scrim + dialog.click-outside, at y=0
      u.phase("dialog.scrim", "dialog.click-outside");
      if (!ov) {
        add({ id: "dialog.scrim", status: "not-run", detail: "not-run: the expectation has no overlay settings for this row (a plan row, or the destination was not exported)" });
        add({ id: "dialog.click-outside", status: "not-run", detail: "not-run: the expectation has no overlay settings for this row" });
        return;
      }
      if (stuck) { for (const id of ["dialog.scrim", "dialog.click-outside"] as const) add({ id, status: "not-run", detail: "not-run: the dialog could not be closed for a fresh open" }); return; }
      u.act();
      await page.evaluate(scrollToY, { y: 0 });
      await raf2(page);
      const op = await openStill();
      if ("why" in op || !op.opened) { for (const id of ["dialog.scrim", "dialog.click-outside"] as const) add({ id, status: "not-run", detail: `not-run: ${"why" in op ? op.why : "nothing opened"}` }); return; }
      const kd = await page.evaluate(markDialog, { path: op.opened.selector });
      await page.evaluate(settleDialog, null);
      const sr = await page.evaluate(scrimRead, null);
      const built = sr.backdrop ?? sr.cover;
      const want = ov.background;
      // a colour the probe cannot read (a colour space it does not convert) is not-run, never a false warn
      const unread = sr.backdrop === null && sr.unreadable !== null ? sr.unreadable : built !== null && parseCssColor(built) === null ? built : want !== null && parseCssColor(want) === null ? want : null;
      if (unread !== null) {
        add({ id: "dialog.scrim", status: "not-run", detail: `not-run: the scrim colour ${unread} is in a colour space the probe does not read`, evidence: { built, designed: want } });
      } else {
        const match = scrimMatches(want, built);
        add({ id: "dialog.scrim", status: match ? "pass" : "warn", detail: match ? `the scrim matches the design (${want ?? "no scrim"} vs ${built ?? "none"})` : `the scrim is ${built ?? "none"}${sr.backdrop !== null ? " (::backdrop)" : ""}, the design's overlay background is ${want ?? "none (no scrim)"}${ov.from === "default" ? " (Figma's default)" : ""}`, evidence: { built: built ?? null, designed: want, via: sr.backdrop !== null ? "::backdrop" : sr.cover !== null ? "fixed cover" : "none" } });
      }
      const pt = sr.point;
      // only the backdrop itself is clicked — the native dialog's ::backdrop, or a scrim with no control under the point
      if (pt === null) add({ id: "dialog.click-outside", status: "not-run", detail: sr.unreadable !== null ? `not-run: a layer over the page has a colour the probe does not read (${sr.unreadable}) — no point is known to be the backdrop`
        : `not-run: no backdrop to click — nothing covers the page outside the dialog (the furthest point hits ${sr.hitDesc}); a click there would land on the page` });
      else {
        u.phase("dialog.click-outside");
        u.act();
        await page.mouse.click(pt.x, pt.y);
        const closed = await closedAfter();
        const want2 = ov.closeOnClickOutside;
        const hint = closed ? "" : kd.native ? " (a native <dialog>: close it on a click whose event.target is the dialog)" : " (close it from the scrim's click)";
        add(closed === want2 ? { id: "dialog.click-outside", status: "pass", detail: `a click on the backdrop (${pt.x},${pt.y}) ${closed ? "closed" : "did not close"} it, as designed (closeOnClickOutside ${String(want2)})` }
          : { id: "dialog.click-outside", status: "warn", detail: `a click on the backdrop (${pt.x},${pt.y}) ${closed ? "closed" : "did not close"} it — the design says closeOnClickOutside ${String(want2)}${ov.from === "default" ? " (Figma's default)" : ""}${hint}`, evidence: { x: pt.x, y: pt.y, closed, designed: want2 } });
      }
    },
  };
}
/** Type the axe result the page returned (lint:any: nothing untyped crosses back). */
export function readAxeResult(x: unknown, fallbackVersion: string): BehaviourAxe {
  if (typeof x !== "object" || x === null || !("violations" in x) || !Array.isArray(x.violations)) return { ran: false, why: "axe-core returned no result" };
  const version = "version" in x && typeof x.version === "string" ? x.version : fallbackVersion;
  const violations: Extract<BehaviourAxe, { ran: true }>["violations"] = [];
  for (const v of x.violations as unknown[]) {
    if (typeof v !== "object" || v === null) continue;
    const id = "id" in v && typeof v.id === "string" ? v.id : "?";
    const impact = "impact" in v && typeof v.impact === "string" ? v.impact : null;
    const nodes = "nodes" in v && typeof v.nodes === "number" ? v.nodes : 0;
    const help = "help" in v && typeof v.help === "string" ? v.help : "";
    const targets = "targets" in v && Array.isArray(v.targets) ? (v.targets as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 3) : [];
    violations.push({ id, impact, nodes, help, targets });
  }
  return { ran: true, package: "axe-core", version, violations };
}
