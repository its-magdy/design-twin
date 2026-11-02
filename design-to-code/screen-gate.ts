// The probe's screen gate: what every page load waits for before it is measured (--ready, by default the frame's tag),
// how a wait that ran out is judged (the default's way out for a screen root that carries no tag: the expectation's own
// tags), and what the run says about it (the start line, the exit-4 hint, the measured file's note). The gate owns its
// state — whether an untagged root was taken for the screen, and how long the frame's tag was waited for — so no caller
// shares or mutates it; a miss comes back typed (ScreenMiss), never as a message to match.
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { screenTags } from "./probe-page.ts";
import type { ForeignRoot, ScreenTags } from "./probe-page.ts";
import { attrSelector } from "./probe-match.ts";
import type { ResolvedFrame } from "./probe-match.ts";
import type { Expectation } from "./verify-shared.ts";
import { firstLine } from "../bridge/src/errmsg.ts";
import { pwErrorKind } from "./pw-errors.ts";

/** How often a wait on the own tags looks at the page again. */
const POLL_MS = 100;
/** How long the look after the frame's wait ran out may take: one page.evaluate, which a hung main thread never answers. */
export const SCREEN_LOOK_CAP_MS = 2_000;

/** --ready's value that waits for nothing. */
export const READY_NONE = "none";
/** What the probe waits for after every load (and after the steps): --ready's selector; without --ready the frame's
 *  tag `[data-dt-node="<frame id>"]` — a page that shows something else (a login redirect, the app's default section)
 *  is then an exit 4, not a measurement of the wrong page; `--ready none` waits for nothing. With no frame id in the
 *  expectation, or a --steps plan that opts out of tagging, there is no default (the note says so). */
export function readyOf(flag: string | undefined, frameId: string | undefined, taggingOff = false): { ready?: string; note: string } {
  if (flag === READY_NONE) return { note: "ready  none (--ready none): the page is measured once it is quiet" };
  if (flag !== undefined) return { ready: flag, note: `ready  ${flag}` };
  if (taggingOff) return { note: "note  the --steps plan opts out of tagging (tagging.off), so there is no --ready default — the page is measured once it is quiet (pass --ready <root selector>)" };
  if (frameId === undefined || frameId === "") return { note: "note  the expectation names no frame node id, so there is no --ready default — the page is measured once it is quiet (pass --ready <selector>)" };
  const ready = attrSelector(frameId);
  return { ready, note: `ready  ${ready} (the frame's tag, the default; --ready <selector> or --ready none to change it)` };
}

/** What the untagged-root rule reads of the expectation: `ids` — the screen root's own node ids, the frame's excepted;
 *  `known` — every id the expectation names (so a tag outside it is another screen's); `alias` — an own node's alias →
 *  its id; `frame` — the frame's size, when it states one (ownTagsOf). */
export interface OwnTags { ids: string[]; known: string[]; alias: Record<string, string>; frame: { w: number; h: number } | null }

/** The own tags of the expectation's screen root: its visible nodes (a multi-root export's other roots — a dialog, an
 *  overlay — carry a frameId and are left out, as are those roots themselves) and its instances that are no other
 *  root's (an instance row's frameId, else a spec's); `known` — every id the expectation names (any root, hidden ones,
 *  the frames, every spec's aliases); `alias` — an own node's alias → its id (a shared shell tagged with a sibling
 *  screen's ids shows this screen's nodes, as the measurement's tag-alias match reads them; an alias that is itself one
 *  of the expectation's ids is that node's); `frame` — the frame's size, when it states one. Null when the root names
 *  no node. */
export function ownTagsOf(exp: Expectation, frameId: string): OwnTags | null {
  const hidden = new Set((exp.hidden && exp.hidden.ids) || []);
  const ids = new Set<string>(), others = new Set<string>(), known = new Set<string>([frameId, ...hidden]);
  const otherRoot = (f: string | undefined): boolean => f !== undefined && f !== frameId;
  for (const s of exp.nodes || []) {
    known.add(s.nodeId);
    if (otherRoot(s.frameId)) others.add(s.nodeId);
    else if (!hidden.has(s.nodeId)) ids.add(s.nodeId);
  }
  for (const i of exp.instances || []) {
    known.add(i.nodeId);
    if (otherRoot(i.frameId)) others.add(i.nodeId);
    else if (!hidden.has(i.nodeId) && !others.has(i.nodeId)) ids.add(i.nodeId);
  }
  for (const fr of exp.frames || []) if (typeof fr.nodeId === "string") known.add(fr.nodeId);
  ids.delete(frameId);
  const alias = new Map<string, string>();
  const named = new Set(known);
  for (const s of exp.nodes || []) {
    for (const a of s.aliases || []) {
      known.add(a);
      if (ids.has(s.nodeId) && !named.has(a) && !alias.has(a)) alias.set(a, s.nodeId);
    }
  }
  const w = exp.frame?.w, h = exp.frame?.h;
  return ids.size ? { ids: [...ids], known: [...known], alias: Object.fromEntries(alias), frame: typeof w === "number" && typeof h === "number" ? { w, h } : null } : null;
}

/** Whether a page whose frame tag never showed is the screen: it shows at least half of the expectation's own tags. */
export const takesForScreen = (shown: number, total: number): boolean => total > 0 && shown * 2 >= total;
/** The untagged-root rule on what the page shows: at least half of the own tags (a shell that keeps this frame's ids
 *  shows a few on every section of the app, so a few are not enough), and no other screen's tagged root. */
export const screenTagsMet = (s: ScreenTags, total: number): boolean => takesForScreen(s.shown, total) && s.foreign === null;
/** The other screen's tagged root that refused a page, if any: only on a page that shows enough of the own tags (fewer
 *  is the reason on its own). */
export const refusingRoot = (s: ScreenTags, total: number): ForeignRoot | null => (takesForScreen(s.shown, total) ? s.foreign : null);

/** A page the gate reads: what the page shows of the own tags, and the frame tag's locator wait. */
export interface GatePage extends Pick<Page, "evaluate" | "isClosed"> {
  locator(selector: string): { first(): { waitFor(o: { state: "visible"; timeout: number }): Promise<void> } };
}
/** What the page shows of the expectation's tags now (no wait); a page mid-navigation shows none; null when the page
 *  does not answer within `capMs` (a hung main thread never answers a page.evaluate). A page or browser gone rethrows
 *  its error (the caller names it). */
export async function screenTagsNow(page: Pick<Page, "evaluate" | "isClosed">, own: OwnTags, capMs: number): Promise<ScreenTags | null> {
  const look = (async (): Promise<ScreenTags> => {
    try { return await page.evaluate(screenTags, { ids: own.ids, known: own.known, alias: own.alias, frame: own.frame }); } catch (e) {
      if (pwErrorKind(e, page) === "gone") throw e;
      return { shown: 0, foreign: null };
    }
  })();
  look.catch(() => undefined); // a page gone after the race ended is the next call's to find
  return Promise.race([look, sleep(Math.max(1, capMs), null, { ref: false })]);
}
/** A wait that ran out, named and worded as Playwright's (pwErrorKind reads it as a timeout). */
class WaitTimeoutError extends Error {
  constructor(what: string, ms: number) { super(`${what}: Timeout ${ms}ms exceeded.`); this.name = "TimeoutError"; }
}
/** The --ready wait of every load after an untagged root was seen: met once the page shows at least half of the
 *  expectation's own tags and no other screen's tagged root (screenTagsMet), polled every POLL_MS, each look bounded by
 *  the time left; past `timeout` a TimeoutError, as the frame tag's locator wait would throw. */
export async function waitForScreenTags(page: Pick<Page, "evaluate" | "isClosed">, own: OwnTags, timeout: number): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    const look = await screenTagsNow(page, own, end - Date.now());
    if (look !== null && screenTagsMet(look, own.ids.length)) return;
    const left = end - Date.now();
    if (left <= 0) throw new WaitTimeoutError("waiting for at least half of the expectation's own tags", timeout);
    await sleep(Math.min(POLL_MS, left));
  }
}
/** The parenthesis of a default --ready miss: what the page showed of the expectation's own tags — fewer than half (and
 *  how many more it carries only ambiguously: by ids this expectation does not name — an alias or the same component
 *  path — on several elements each), else another screen's tagged root. */
export function screenTagsWhy(s: ScreenTags, total: number): string {
  const f = refusingRoot(s, total);
  if (f !== null) {
    return ` (another screen's tagged root is on the page: a visible element tagged data-dt-node="${f.id}", an id this expectation does not name, ` +
      `${f.by === "size" ? "has the frame's size (±2 px)" : `encloses ${f.encloses} of the ${s.shown} own tags the page shows`})`;
  }
  const amb = s.ambiguous ?? 0;
  return ` (the page shows ${s.shown} of the expectation's ${total} own tags — fewer than half${amb > 0
    ? `; +${amb} carried only by ids this expectation does not name (an alias or the same component path), on several elements each, ` +
      "which do not count — tag them with their own ids" : ""})`;
}

/** What settle() does when its load / fonts / --ready wait threw on a document that is still the current one (a
 *  replaced document is settled again first): "unreachable" — the --ready wait ran out on a document that stayed, so
 *  the page is not the screen (a redirect to a login page or another origin, a section the steps did not reach),
 *  whether or not a navigation came before; "retry" — a navigation is still within its document's window; "kept" — a
 *  navigation left no settled document by then (the page kept navigating). */
export function settleMiss(s: { readyWait: boolean; navigated: boolean; sameDocument: boolean; moved: boolean; pastDocDeadline: boolean }): "unreachable" | "retry" | "kept" {
  if (s.readyWait && !s.navigated && s.sameDocument) return "unreachable";
  if (s.moved) return s.pastDocDeadline ? "kept" : "retry";
  if (s.navigated && !s.pastDocDeadline) return "retry";
  return "unreachable";
}

/** How the measurement found a screen root that carries no tag (resolveFrame's `via`). */
const untaggedRootFound = (via: ResolvedFrame["via"] | undefined): string =>
  via === "size-and-fill" ? "its root found as the outermost element with the frame's size (±2 px) and a fill"
    : via === "viewport" ? "no element has the frame's size and a fill, so the viewport stands in for its root (positions are relative to the viewport)"
      : "its root not found";
/** The measured file's note when the frame's tag never showed but at least half of the expectation's own tags did:
 *  `waitedMs` — how long the frame's tag was waited for (the --timeout, or what was left of a navigation's ≤ 10 s
 *  window); `via` — how the measurement found the root. Null when the measurement found the root by its tag (it
 *  showed after a wait a navigation cut short): the root is tagged, and the measurement is the usual one. */
export function untaggedRootNote(ready: string, waitedMs: number, via: ResolvedFrame["via"] | undefined): string | null {
  if (via === "tag") return null;
  return `the screen root is not tagged: ${ready} (the default --ready) never showed within ${Math.round(waitedMs / 100) / 10}s, but the page shows at least ` +
    `half of the expectation's own tags and no other screen's tagged root, so it was measured as the screen, ${untaggedRootFound(via)} — tag the root ` +
    `${ready.slice(1, -1)}, or pass --ready <root selector>`;
}
/** The exit-4 hint when the default --ready (the frame's tag) never showed, and too few of the expectation's own tags did. */
export function defaultReadyMissed(ready: string, withSteps: boolean): string {
  return `${ready} is the default --ready (the frame's tag), and the page shows too few of the expectation's own tags to be the screen: the page ` +
    `the probe reached is not the screen — a redirect (a login page, another origin) or another section (${withSteps
      ? "the --steps ended somewhere else: check the plan's navigate list"
      : "a screen that is a section of the app is reached with --steps <plan.json>"}) — or nothing on it is tagged (a tagging ` +
    `opt-out: pass --ready <root selector>, or --ready none to wait for nothing) — or the root is untagged and most of its tags are not visible ` +
    `at load: tag the root ${ready.slice(1, -1)} or pass --ready <root selector>`;
}
/** The exit-4 hint when the default --ready (the frame's tag) never showed on a page that shows another screen's tagged root. */
export function foreignRootHint(ready: string, f: ForeignRoot, withSteps: boolean): string {
  return `${ready} is the default --ready (the frame's tag), and the page shows another screen's tagged root (data-dt-node="${f.id}" ` +
    `${f.by === "size" ? "has this frame's size" : "encloses most of this screen's visible tags"}): the probe reached another screen — check ` +
    `${withSteps ? "the --steps plan's navigate list" : "the --url, or reach the screen with --steps <plan.json>"}; if that element is a wrapper of ` +
    `this screen tagged with another id, tag this screen's root ${ready.slice(1, -1)} or pass --ready <root selector>`;
}

/** A selector's visible matches only (Playwright's `visible=true` engine): a wait on it is met by ANY visible match,
 *  so a hidden first copy (a responsive duplicate) never hides a visible one. */
export const visibleOnly = (sel: string): string => `${sel} >> visible=true`;

/** A --ready wait that ran out on a document that stayed, judged: `byDefault` — the selector was the default (the frame's
 *  tag), so the exit-4 hint says what the page is instead; `foreign` — another screen's tagged root refused the page;
 *  `look` — what the page showed of the own tags (null: not looked at, or it did not answer). */
export interface ScreenMiss { byDefault: boolean; foreign: ForeignRoot | null; look: ScreenTags | null }
/** judge()'s answer: "screen" — the page is the screen with an untagged root (measure it); "miss" — not the screen, with
 *  the exit-4 message (the run's own wording) and the typed miss. */
export type ScreenJudgement = { kind: "screen" } | { kind: "miss"; message: string; miss: ScreenMiss };

/**
 * The --ready gate of one probe run. `ready` — the selector every load waits for (undefined: no wait); `startNote` —
 * the run's `ready …` / `note …` line. With the default (no --ready flag, the frame's tag) and an expectation that
 * names own tags, a page whose frame tag never showed but that shows at least half of them and no other screen's tagged
 * root is the screen with an untagged root: judge() takes it, and every later wait() (the re-run, the driven pages, a new
 * document) waits for the same rule instead of the frame's tag; note() then says so in the measured file.
 */
export class ScreenGate {
  readonly ready: string | undefined;
  readonly startNote: string;
  readonly #byDefault: boolean;
  readonly #own: OwnTags | null;
  /** how long the frame's tag was waited for when the untagged root was first taken for the screen (null: never) */
  #waitedMs: number | null = null;

  constructor(o: { flag: string | undefined; frameId: string | undefined; expectation: Expectation | null; taggingOff?: boolean }) {
    const pick = readyOf(o.flag, o.frameId, o.taggingOff ?? false);
    this.ready = pick.ready;
    this.startNote = pick.note;
    this.#byDefault = o.flag === undefined && pick.ready !== undefined;
    this.#own = this.#byDefault && o.expectation !== null && o.frameId !== undefined ? ownTagsOf(o.expectation, o.frameId) : null;
  }

  /** Whether an untagged root was taken for the screen (every later wait() is on the own tags). */
  get untaggedRootSeen(): boolean { return this.#waitedMs !== null; }

  /** Wait (≤ `timeoutMs`) for the page to show the screen: a visible match of `ready` (the first visible one counts), or — once an untagged root was
   *  taken for the screen — at least half of the own tags and no other screen's tagged root. Throws what the wait threw
   *  (a Playwright TimeoutError on a run out wait); a no-op without a selector. */
  async wait(page: GatePage, timeoutMs: number): Promise<void> {
    if (this.ready === undefined) return;
    if (this.#own !== null && this.#waitedMs !== null) return waitForScreenTags(page, this.#own, timeoutMs);
    await page.locator(visibleOnly(this.ready)).first().waitFor({ state: "visible", timeout: timeoutMs });
  }

  /** Judge a load / fonts / wait() failure `e` on a document that stayed (settleMiss's "unreachable"); `readyWait` — it was
   *  wait() that threw, given `waitedMs`. Only a wait() that ran out (a timeout) on the default gate looks at the page
   *  (≤ SCREEN_LOOK_CAP_MS); it is the screen when the look meets the untagged-root rule. A page or browser gone during
   *  the look rethrows its error. Without a selector there is no gate to judge: the miss is the error's own line. */
  async judge(page: Pick<Page, "evaluate" | "isClosed">, e: unknown, readyWait: boolean, waitedMs: number): Promise<ScreenJudgement> {
    const own = this.#own;
    const asked = readyWait && own !== null && pwErrorKind(e) === "timeout";
    const look = asked ? await screenTagsNow(page, own, SCREEN_LOOK_CAP_MS) : null;
    if (own !== null && look !== null && screenTagsMet(look, own.ids.length)) {
      this.#waitedMs ??= waitedMs;
      return { kind: "screen" };
    }
    if (this.ready === undefined) return { kind: "miss", message: firstLine(e), miss: { byDefault: false, foreign: null, look: null } };
    const why = look === null || own === null
      ? (asked ? ` (the page did not answer within ${SCREEN_LOOK_CAP_MS / 1000}s when its tags were counted)` : "")
      : screenTagsWhy(look, own.ids.length);
    return { kind: "miss", message: `--ready '${this.ready}' never became visible${why}: ${firstLine(e)}`,
      miss: { byDefault: this.#byDefault, foreign: look !== null && own !== null ? refusingRoot(look, own.ids.length) : null, look } };
  }

  /** The exit-4 hint of a miss: what the page is instead, for a miss of the default (the frame's tag); "" otherwise. */
  hint(miss: ScreenMiss, withSteps: boolean): string {
    if (!miss.byDefault || this.ready === undefined) return "";
    return miss.foreign !== null ? foreignRootHint(this.ready, miss.foreign, withSteps) : defaultReadyMissed(this.ready, withSteps);
  }

  /** The measured file's note once an untagged root was taken for the screen (`via` — how the measurement found the
   *  root); null when none was, or the measurement found the root by its tag after all. */
  note(via: ResolvedFrame["via"] | undefined): string | null {
    if (this.#waitedMs === null || this.ready === undefined) return null;
    return untaggedRootNote(this.ready, this.#waitedMs, via);
  }
}
