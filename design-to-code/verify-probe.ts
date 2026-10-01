// verify-probe.ts — the shipped web probe: render the built screen, measure every expectation row the same
// way every time, write <Screen>.measured.json for `verify-screen.js --compare`.
//
// Why it exists (field tests DT-23, F-57, F-63, F-71, F-101, F-120, DT-39, DT-44): every verifier used to
// write its own Playwright script. Each one matched elements differently (first element with the text; the
// <li> instead of the <button>; the <h2> of a CLOSED dialog), left keys out (`fill` in 0 of 185 measurements),
// read a text's font off its container, crashed on a dev-server reload, and was patched mid-run — so the same
// unchanged screen measured 185 nodes one round and 42 the next, and nothing said why. This probe fixes the
// method: one matching order (probe-match.ts), every STYLE_KEY on every node with a reason for every null,
// the probe's own identity (version, sha256 of this file, Playwright + browser versions) in the output, and
// a reload during measurement answered by ONE full re-run, then exit 4 with nothing written (D19).
//
//   verify-probe.js --expected design/verify/<S>.expected.json --url <url> [--out design/verify/<S>]
//                   [--ready <selector>] [--viewport WxH] [--project <dir>] [--position] [--timeout <ms>]
//                   [--run <id>] [--max-time <ms>] [--steps <steps.json | plan.json>]
//   verify-probe.js --check [--project <dir>]
//
// Playwright is the PROJECT's (D2): resolved with createRequire(<project>/package.json) — playwright, then
// @playwright/test, then playwright-core — never bundled, never installed, and no browser is ever
// downloaded by this script. Its types are `import type` only (erased from the bundle).
//
// Exit: 0 wrote · 2 usage · 3 renderer unavailable (nothing written) · 4 the page kept navigating, reloaded
// twice during measurement, was unreachable or timed out, or the whole run passed --max-time (nothing written).
//
// Group 10: the whole run is bounded (--max-time, F-107: a page whose script never yields used to hang the
// verifier for good); with --run <id> the probe writes the run's status itself — `measuring` before the browser
// starts, `measured` + the measured file's sha256 after it is closed, and nothing while a page is open (F-72,
// F-91); files are written atomically, the screenshot first and measured.json last (a reader that sees the
// measured file sees its picture); measured.build records what was served (DT-81: a stale preview).
//
// Group 12a: a screen that is a section of a single-page app (chosen by component state, not by the URL) is reached
// with --steps — a closed, navigation-only list (click / waitFor / goto, probe-steps.ts) replayed after every page
// load (L-1); a step that fails in the measurement pass is exit 4 with nothing written. The measurement pass also
// reads the page's horizontal overflow (measured.page, D43). After it, the overlay interactions are DRIVEN, each on a
// fresh page (probe-drive.ts, F-70/F-95/F-117) — evidence only, never a reason to exit 4 (measured.interactions).
//
// Navigation accounting (D19, facts-12a §1): a navigation is a main-frame document LOAD (a reload, a cross-document
// link) — never a `framenavigated`, which also fires for same-document history changes (pushState, a hash). Loads the
// probe causes itself (the goto, a step that loads a page) are not "after the initial load". A click step owns the
// navigation it causes however late it starts, as long as it goes to ANOTHER URL (a reload of the same URL is never a
// step's); a reload after a click changed the page in place loses that state — the pass is re-run once (D19).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserType, Page } from "playwright";
import { spawnSync } from "node:child_process";
import { collectCandidates, focusablePath, focusInfo, measureElements } from "./probe-page.ts";
import type { Candidate, CollectOutput, MeasureItem, Rect } from "./probe-page.ts";
import { buildPool, census, chooseMatch, claimOnce, isMatch, isPaintSpec, positionBoxes, resolveFrame, shapeNode, specText } from "./probe-match.ts";
import type { Match, NoMatch, ResolvedFrame } from "./probe-match.ts";
import { STYLE_KEYS } from "./verify-screen.ts";
import { isVerifyExpectation } from "./doc-guards.ts";
import { anyJson, readJson, readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd, shellArg } from "./cli-args.ts";
import { isJsonObject } from "./types.ts";
import type { BuildIdentity, InteractionEvidence, MeasuredComponent, MeasuredNode, PageOverflow, ProbeFrame, ProbeIdentity, ProbeNavigation, ProbeNotMeasured, ProbeStep, VerifyMeasured, VerifySpec } from "./types.ts";
import { describeStep, parseSteps, stepsSha256 } from "./probe-steps.ts";
import { StepError, drivable, driveBudget, driveInteractions, readPageOverflow, submitGuard } from "./probe-drive.ts";
import { gitHead } from "./content-hash.ts";
import { RunCacheUnwritable, liveStatusFile, sha256Of, stageDirOf, writeFileAtomic, writeStatus } from "./verify-run.ts";
import type { StatusWrite } from "./verify-run.ts";
import type { Expectation } from "./verify-screen.ts";
import { errMsg } from "../bridge/src/errmsg.ts";
import { isMainFallback } from "../bridge/src/is-main.ts";

// ---------------------------------------------------------------- resolving the project's Playwright (D2)
export const PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"] as const;
/** The part of a Playwright package this probe uses. */
export interface PlaywrightModule { chromium: BrowserType }
export function isPlaywrightModule(x: unknown): x is PlaywrightModule {
  if (typeof x !== "object" || x === null || !("chromium" in x)) return false;
  const c = x.chromium;
  return typeof c === "object" && c !== null && "launch" in c && typeof c.launch === "function";
}
export type Resolution =
  | { ok: true; pkg: string; version: string; mod: PlaywrightModule; file: string }
  | { ok: false; reason: string; hint: string };

/** The install command for the project's package manager (from its lockfile) — PRINTED for the user, never run. */
export function installHint(dir: string): string {
  const has = (f: string): boolean => fs.existsSync(path.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm add -D playwright && pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn add -D playwright && yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bun add -d playwright && bunx playwright install chromium";
  return "npm i -D playwright && npx playwright install chromium";
}
/** The browser-only install command (the package resolved; the browser binary is missing). */
function browserHint(dir: string): string {
  const has = (f: string): boolean => fs.existsSync(path.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bunx playwright install chromium";
  return "npx playwright install chromium";
}

export function resolvePlaywright(dir: string): Resolution {
  const abs = path.resolve(dir);
  const req = createRequire(path.join(abs, "package.json"));
  const tried: string[] = [];
  for (const name of PLAYWRIGHT_PACKAGES) {
    let file: string;
    try { file = req.resolve(name); } catch { tried.push(`${name}: not installed`); continue; }
    let mod: unknown;
    try { mod = req(name); } catch (e) { tried.push(`${name}: failed to load (${errMsg(e).split("\n")[0]})`); continue; }
    if (!isPlaywrightModule(mod)) { tried.push(`${name}: has no chromium launcher`); continue; }
    let version = "unknown";
    try { const pj: unknown = req(`${name}/package.json`); if (isJsonObject(pj) && typeof pj.version === "string") version = pj.version; } catch { /* exports without ./package.json */ }
    return { ok: true, pkg: name, version, mod, file };
  }
  const pnp = fs.existsSync(path.join(abs, ".pnp.cjs")) ? " — this project uses Yarn Plug'n'Play: retry the probe as `yarn node <this script> …`" : "";
  return { ok: false, reason: `no playwright package resolvable from ${path.join(abs, "package.json")} (${tried.join("; ")})${pnp}`, hint: installHint(abs) };
}

function rendererUnavailable(reason: string, hint: string): number {
  console.error(`verify-probe: renderer unavailable — ${reason}\n` +
    `  nothing was measured or written. Ask the user to run:  ${hint}\n` +
    "  (verify-probe never installs a package or downloads a browser itself.)");
  return 3;
}

async function launch(r: Extract<Resolution, { ok: true }>, dir: string): Promise<{ browser: Browser } | { error: string; hint: string }> {
  try { return { browser: await r.mod.chromium.launch({ headless: true }) }; } catch (e) {
    const first = (errMsg(e).split("\n").find((l) => l.trim()) || "launch failed").trim();
    return { error: `${r.pkg} ${r.version} resolved, but chromium did not launch: ${first}`, hint: browserHint(dir) };
  }
}

// ---------------------------------------------------------------- identity
const SELF = fileURLToPath(import.meta.url);
function probeVersion(): string | null {
  // scripts/verify-probe.js → ../.claude-plugin/plugin.json; design-to-code/verify-probe.ts → ../claude-plugin/.claude-plugin/plugin.json
  for (const p of [path.join(path.dirname(SELF), "..", ".claude-plugin", "plugin.json"), path.join(path.dirname(SELF), "..", "claude-plugin", ".claude-plugin", "plugin.json")]) {
    const doc = readJsonOrNull(p, isJsonObject);
    if (doc && typeof doc.version === "string") return doc.version;
  }
  return null;
}
const selfSha256 = (): string => crypto.createHash("sha256").update(fs.readFileSync(SELF)).digest("hex");

// DT-81: what was SERVED. Every same-origin document/script/stylesheet response body is hashed (by path, the
// query dropped: Vite's ?v=/?t= stamps change without the code changing), so two runs against an unchanged
// `vite preview` of a stale dist carry the same assetsSha256 whatever the source tree says.
type ServedBuild = Omit<BuildIdentity, "gitHead" | "gitDirty">;
const BUILD_TYPES = new Set(["document", "script", "stylesheet"]);
export function buildFrom(url: string, served: ReadonlyMap<string, string>, viteClient: boolean): ServedBuild {
  const lines = [...served].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, h]) => `${p} ${h}`);
  return { url, mode: viteClient ? "vite-dev" : served.size ? "static" : "unknown", assets: served.size, assetsSha256: sha256Of(lines.join("\n")) };
}
/** The project's git state — null when it is not a git work tree. Changes under design/ (the verifier's own files) do not count. */
function gitState(dir: string): { gitHead: string | null; gitDirty: boolean | null } {
  const head = gitHead(dir);
  if (!head) return { gitHead: null, gitDirty: null };
  try {
    const r = spawnSync("git", ["status", "--porcelain", "--", ".", ":(exclude)design"], { cwd: dir, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return { gitHead: head, gitDirty: r.status === 0 ? String(r.stdout || "").trim() !== "" : null };
  } catch { return { gitHead: head, gitDirty: null }; }
}

// ---------------------------------------------------------------- readiness + navigation (DT-39, D19)
// Injected before any page script, on every navigation: no transitions, no animations, no caret — so what
// is measured and screenshotted is the resting state — plus a per-document token, which is how a reload
// (a NEW document) is told apart from a same-document history change.
const INIT_SCRIPT = `(() => {
  try { Object.defineProperty(window, "__dtProbeDoc", { value: Math.random().toString(36).slice(2), configurable: true }); } catch (e) {}
  const css = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";
  const add = () => { const s = document.createElement("style"); s.setAttribute("data-dt-probe", ""); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true }); else add();
})();`;
const QUIET_MS = 500, QUIET_CAP_MS = 10_000, POLL_MS = 100;
/** Playwright errors that mean the document went away under an evaluate/locator call. */
const NAV_ERROR = /Execution context was destroyed|frame was detached|Cannot find context with specified id|interrupted by another navigation/i;
/** Playwright errors that mean the browser or page itself is gone (a crash, a kill) — not a reload. */
const CLOSED_ERROR = /Target closed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;

/** What a Playwright error during measurement means: the document was replaced (a reload → re-run), the
 *  browser/page is gone (a crash → exit 4, never read as a reload), or something else. */
export function errorKind(message: string, pageClosed: boolean): "gone" | "navigated" | "other" {
  if (pageClosed || CLOSED_ERROR.test(message)) return "gone";
  return NAV_ERROR.test(message) ? "navigated" : "other";
}

class NavigatedError extends Error {}
/** H-a: a reload replaced the document after a click step had changed it in place — the steps' state is gone (D19's one
 *  re-run replays them; a second time is exit 4 with this step named, not the dev-server hint). */
class StepStateLostError extends NavigatedError {}
class BrowserGoneError extends Error {}
const gone = (e: unknown): BrowserGoneError => new BrowserGoneError(`the browser closed or crashed during measurement (${errMsg(e).split("\n")[0]})`);
class KeptNavigatingError extends Error {}
class UnreachableError extends Error {}

/** A URL without its fragment (a hash change never makes a new document). */
const docUrl = (u: string): string => { const i = u.indexOf("#"); return i < 0 ? u : u.slice(0, i); };
/** H-a: a main-frame navigation request to ANOTHER document URL than the one the page shows as it is issued is a
 *  navigation; to the same URL it is a reload. (Chromium 153: page.url() when the request is issued is still the current
 *  document's URL, a pushState included — so a reload of a pushed URL is a reload.) */
export function isNavigationAway(requestUrl: string, pageUrl: string): boolean {
  return docUrl(requestUrl) !== docUrl(pageUrl);
}

/** The navigation log of a page (facts-12a §1: main-frame document LOADS count, framenavigated never does).
 *  navs = loads; gotos = the loads the probe started itself (its goto, a goto step's, a click step's own navigation). */
interface NavLog {
  events: ProbeNavigation["events"];
  navs: number;
  gotos: number;
  t0: number;
  /** the step that owns main-frame navigations right now: a goto step while it loads (any URL: its load is the step's);
   *  a click step from its click until the next goto/click step or the end of the steps — only a navigation that leaves
   *  the page's URL (M-2: a same-URL request is a reload, never the click's, even while the click runs) */
  owner: { kind: "goto" | "click" } | null;
  /** the newest main-frame navigation request was a step's own: its load is the probe's, not "after the initial load" */
  pendingOwned: boolean;
  /** the document may hold state a click built in place: the step that clicked (set from the click on; null: a fresh
   *  document — any load clears it) */
  live: string | null;
  /** set when a load no step owned replaced a live document: the steps' state is gone (→ StepStateLostError) */
  lost: string | null;
  /** M-1: documents (by token) whose load already timed out in a settle, with that settle's note — later settles on the
   *  same document (the next step's, the final --ready one) do not wait for its load again: the cap is per document */
  loadTimedOut: Map<string, string>;
}

/** The current document's token (INIT_SCRIPT) — null while a navigation has no document to evaluate in. */
async function docTokenOrNull(page: Page): Promise<string | null> {
  try { const v: unknown = await page.evaluate("window.__dtProbeDoc || ''"); return String(v); } catch (e) {
    if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
    if (errorKind(errMsg(e), false) === "navigated") return null;
    throw e;
  }
}

/** What settle() found: a note for the measured file (or null), and the token of the document it saw quiet (L-a: the
 *  measurement compares against THIS token, so a document that replaced it after settling is never measured as settled). */
interface Settled { note: string | null; token: string | null }

/**
 * Wait until the page is ready (its load, fonts, --ready) and its DOM has been quiet for QUIET_MS (≤ 10 s).
 * M-a: a document still loading (a step's navigation committed before settling began) is waited for — its load first —
 * so a quiet but half-loaded document is never taken as settled (past the cap it is measured anyway, with a note).
 * H1 (D19): a NEW document — told by the per-document token changing between two quiet polls, or by a main-frame load
 * — is waited for (its load) and settling starts over on it; a load event alone is not enough, because a reloaded
 * document can sit quiet, half-loaded, for longer than the quiet window before its load fires. H-a: when that load was a
 * reload replacing a document a click step had changed in place (NavLog.lost), the steps' state is gone →
 * StepStateLostError (the pass is re-run once and the steps replayed, D19); a step's own navigation is settled on.
 */
async function settle(page: Page, log: NavLog, ready: string | undefined, timeout: number): Promise<Settled> {
  const cap = Math.min(QUIET_CAP_MS, timeout);
  const deadline = Date.now() + cap;
  const navAtStart = log.navs;
  let newDocs = 0;
  let loadNote: string | null = null;
  const moved = (): boolean => log.navs !== navAtStart || newDocs > 0;
  const kept = (): KeptNavigatingError => new KeptNavigatingError(`the page kept navigating for ${Math.round(cap / 1000)}s after load (${Math.max(log.navs - navAtStart, newDocs)} navigation(s)) and never settled`);
  const stateLost = (): void => { if (log.lost !== null) throw new StepStateLostError(log.lost); };
  stateLost();
  let token = await docTokenOrNull(page);
  /** a new document replaced the one settling began on: wait for its load, then start over (or end the pass: lost state) */
  const newDocument = async (): Promise<void> => {
    newDocs++;
    await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined);
    stateLost();
    if (Date.now() >= deadline) throw kept();
    token = await docTokenOrNull(page);
  };
  for (;;) {
    try {
      // M-a: its load first (a document whose load is still pending can be quiet and half drawn)
      // M-1: a document whose load already timed out (in this settle or an earlier one) is not waited for again
      const known = token !== null ? log.loadTimedOut.get(token) : undefined;
      if (known !== undefined) loadNote = known;
      else {
        const state: unknown = await page.evaluate("document.readyState");
        if (state !== "complete") {
          try {
            await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) });
          } catch (e) {
            if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
            if (errorKind(errMsg(e), false) === "navigated") throw e;
            loadNote = `the document had not finished loading after ${Math.round(cap / 1000)}s (document.readyState "${String(state)}") — measured anyway`;
            // remembered for THIS document (the token it has now): no later settle waits for its load again
            const now = await docTokenOrNull(page);
            if (now !== null && (token === null || now === token)) { token = now; log.loadTimedOut.set(now, loadNote); }
          }
          stateLost();
        }
      }
      await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
      // the full --timeout for a page that has not navigated since load; what is left of the quiet cap otherwise
      if (ready) await page.locator(ready).first().waitFor({ state: "visible", timeout: moved() ? Math.max(1, deadline - Date.now()) : timeout });
    } catch (e) {
      if (e instanceof StepStateLostError || e instanceof BrowserGoneError) throw e;
      if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
      const now = await docTokenOrNull(page);
      if (now !== null && token !== null && now !== token) { await newDocument(); continue; }
      if (token === null && now !== null) token = now;
      if (moved() && Date.now() < deadline) { await sleep(POLL_MS); continue; }
      if (moved()) throw kept();
      if (errorKind(errMsg(e), false) === "navigated" && Date.now() < deadline) { await sleep(POLL_MS); continue; }
      throw new UnreachableError(ready ? `--ready '${ready}' never became visible: ${errMsg(e).split("\n")[0]}` : errMsg(e).split("\n")[0]);
    }
    let mark = log.navs;
    let last = "", since = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      let tok: string, sig: string;
      try {
        const v: unknown = await page.evaluate("[window.__dtProbeDoc || '', document.getElementsByTagName('*').length + ':' + (document.body && document.body.textContent || '').length]");
        if (!Array.isArray(v)) throw new Error("the page returned no settle signature");
        tok = String(v[0]); sig = String(v[1]);
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
        if (errorKind(errMsg(e), false) !== "navigated") throw e;
        if (Date.now() >= deadline) throw kept();
        continue;
      }
      if (token === null) token = tok;
      // a load with the token unchanged is this document's own late load event (no token to tell by: count it as new)
      if (tok !== token || (log.navs !== mark && tok === "")) { await newDocument(); break; } // restart: load, fonts, --ready, a fresh quiet window
      stateLost();
      mark = log.navs;
      if (sig !== last) { last = sig; since = Date.now(); }
      if (Date.now() - since >= QUIET_MS) return { note: loadNote, token: tok };
      if (Date.now() >= deadline) {
        if (moved()) throw kept();
        return { note: loadNote ?? `the DOM was still changing after ${Math.round(cap / 1000)}s (no navigation) — measured anyway`, token: tok };
      }
    }
  }
}

// ---------------------------------------------------------------- one full measurement pass
export interface ProbeOptions {
  expectation: Expectation;
  url: string;
  ready?: string;
  viewport: { w: number; h: number };
  position: boolean;
  timeout: number;
  /** L-1: replayed after every load, before --ready is waited for */
  steps?: ProbeStep[];
}

// ---------------------------------------------------------------- L-1: reaching the screen (goto, --steps, --ready)
const STEP_WAIT_CAP_MS = 5_000;

/** The visible element a step's selector names, waiting ≤ min(--timeout, 5 s): a click needs EXACTLY one (it must be
 *  unambiguous what was clicked); a waitFor is met by one or more (B2: "the list has rows"). Returns the first's index. */
async function oneVisible(page: Page, sel: string, wait: number, name: string, atLeastOne = false): Promise<number> {
  const deadline = Date.now() + wait;
  let last = { visible: 0, all: 0 };
  for (;;) {
    try {
      const loc = page.locator(sel);
      const all = await loc.count();
      const vis: number[] = [];
      for (let i = 0; i < all; i++) if (await loc.nth(i).isVisible()) vis.push(i);
      const only = vis[0];
      if (only !== undefined && (vis.length === 1 || atLeastOne)) return only;
      last = { visible: vis.length, all };
    } catch (e) {
      const kind = errorKind(errMsg(e), page.isClosed());
      if (kind === "gone") throw gone(e);
      if (kind === "other") throw new StepError(`${name}: ${errMsg(e).split("\n")[0]}`);
    }
    if (Date.now() >= deadline) {
      throw new StepError(`${name} matched ${last.visible} visible element(s)${last.all !== last.visible ? ` (${last.all} in the document)` : ""} after ${Math.round(wait / 1000)}s — ${atLeastOne ? "a waitFor needs at least one" : "a click needs exactly one"}`);
    }
    await sleep(POLL_MS);
  }
}

/** Replay the steps (each settles after it). Which loads are the steps' own (added to log.gotos, never "after the initial
 *  load") is judged per navigation request (attachNavLog): a goto step's load; a click step's navigation — one that goes
 *  to another URL than the page shows, issued while the click runs or LATER (H-a: an app that awaits a request, then sets
 *  location), until the next goto/click step or the end of the steps (M-2: a same-URL request never, not even one the
 *  click's handler issues at once). Any other load is the page's own and
 *  counts; a reload (same URL) that replaces a document a click changed in place loses that state → StepStateLostError,
 *  D19's one re-run, which replays the steps. */
async function runSteps(page: Page, log: NavLog, o: ProbeOptions): Promise<void> {
  const steps = o.steps || [];
  let origin = "";
  try { origin = new URL(o.url).origin; } catch { /* the goto reported it */ }
  for (const [i, s] of steps.entries()) {
    const name = describeStep(s, i);
    const wait = Math.min(o.timeout, STEP_WAIT_CAP_MS);
    if ("goto" in s) {
      let target: URL;
      try { target = new URL(s.goto, o.url); } catch { throw new StepError(`${name} is not a path`); }
      if (target.origin !== origin) throw new StepError(`${name} leaves the origin ${origin} — a goto step is a same-origin path`);
      log.owner = { kind: "goto" }; // the goto's load is the step's own (even at the URL the page is on)
      try {
        await page.goto(target.href, { waitUntil: "load", timeout: o.timeout });
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
        if (!/interrupted by another navigation/i.test(errMsg(e))) throw new StepError(`${name} could not load ${target.href}: ${errMsg(e).split("\n")[0]}`);
      } finally {
        log.owner = null; // a goto ends the previous click's ownership too
      }
      log.live = null; // a fresh document the probe loaded
    } else {
      const sel = "click" in s ? s.click : s.waitFor;
      const idx = await oneVisible(page, sel, wait, name, "waitFor" in s);
      if ("click" in s) {
        const loc = page.locator(sel).nth(idx);
        try {
          // L-2: where Playwright will click — it scrolls the element into view first, then clicks the middle of what shows
          await loc.scrollIntoViewIfNeeded({ timeout: wait }).catch(() => undefined);
          const submits = await loc.evaluate(submitGuard, undefined, { timeout: wait });
          if (submits !== null) throw new StepError(`${name} would submit a form (${submits}) — a step must navigate, never submit`);
          // its navigations to ANOTHER URL are its own from here on, however late (H-a); M-2: from the click on the document
          // may hold what the click builds in place, so a reload (a same-URL load, never the click's — even one its handler
          // starts at once: `draw(); location.reload()`) loses that state; the click's own navigation clears it on load
          log.owner = { kind: "click" };
          log.live = name;
          await loc.click({ timeout: wait });
        } catch (e) {
          if (e instanceof StepError) throw e;
          const kind = errorKind(errMsg(e), page.isClosed());
          if (kind === "gone") throw gone(e);
          // a click that started a document load is a step's navigation (settled below); anything else failed the step
          if (kind === "other") throw new StepError(`${name} could not be clicked: ${errMsg(e).split("\n")[0]}`);
        }
      }
    }
    await settle(page, log, undefined, o.timeout);
    // a reload between two steps (no settle saw it) lost the state too
    if (log.lost !== null) throw new StepStateLostError(log.lost);
  }
}

/** goto → settle (with --ready only when there are no steps) → the steps → settle with --ready. */
async function reachPage(page: Page, log: NavLog, o: ProbeOptions): Promise<Settled> {
  // a fresh start (the D19 re-run reuses the log): no step owns anything, the document holds no step's state
  log.owner = null; log.pendingOwned = false; log.live = null; log.lost = null;
  log.gotos++;
  try {
    await page.goto(o.url, { waitUntil: "load", timeout: o.timeout });
  } catch (e) {
    if (!/interrupted by another navigation/i.test(errMsg(e))) throw new UnreachableError(`could not load ${o.url}: ${errMsg(e).split("\n")[0]}`);
  }
  const steps = o.steps || [];
  if (!steps.length) return settle(page, log, o.ready, o.timeout);
  try {
    const first = await settle(page, log, undefined, o.timeout);
    await runSteps(page, log, o);
    // the last click still owns its late navigation while --ready is waited for
    const last = await settle(page, log, o.ready, o.timeout);
    if (log.lost !== null) throw new StepStateLostError(log.lost);
    return { note: last.note ?? first.note, token: last.token };
  } finally {
    log.owner = null; // measuring: no load is the steps' own from here
  }
}

/** The navigation log of a page: main-frame document loads (facts-12a §1); framenavigated is logged, never counted;
 *  each main-frame navigation request is judged as it is issued — a step's own (NavLog.owner) or not — and its load
 *  credited accordingly; a load no step owned that replaces a document a click changed in place sets `lost`. */
function attachNavLog(page: Page): NavLog {
  const log: NavLog = { events: [], navs: 0, gotos: 0, t0: Date.now(), owner: null, pendingOwned: false, live: null, lost: null, loadTimedOut: new Map() };
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) log.events.push({ type: "framenavigated", url: f.url(), at: Date.now() - log.t0 }); });
  page.on("request", (r) => {
    try {
      if (!r.isNavigationRequest() || r.frame() !== page.mainFrame() || r.redirectedFrom() !== null) return;
      const o = log.owner;
      log.pendingOwned = o !== null && (o.kind === "goto" || isNavigationAway(r.url(), page.url()));
    } catch { /* a service worker's request has no frame */ }
  });
  page.on("load", () => {
    log.navs++;
    const url = page.url();
    if (log.pendingOwned) log.gotos++;
    else if (log.live !== null && log.lost === null) log.lost = `the page reloaded (${docUrl(url)} again, not a navigation) after ${log.live} had changed it in place — the steps' state is gone`;
    log.events.push({ type: "load", url, at: Date.now() - log.t0 });
    log.pendingOwned = false;
    log.live = null; // a fresh document
  });
  return log;
}
interface PassResult {
  nodes: MeasuredNode[];
  notMeasured: ProbeNotMeasured[];
  frames: ResolvedFrame[];
  components: MeasuredComponent[];
  png: Buffer;
  notes: string[];
  tagsNotInExpectation: NonNullable<VerifyMeasured["tagsNotInExpectation"]>;
  /** D43: the page's horizontal overflow, read in this pass */
  page: PageOverflow;
  /** where the page was when it was measured (after the steps) */
  url: string;
}

/** DT-47: every data-dt-node on a VISIBLE element that names no expected spec/instance/hidden id and no frame —
 *  a stale prefix, another screen's id, a typo. {count, ids: the first 50 sorted, elements = how many carry it}. */
export function foreignTags(tagged: Candidate[], expectedIds: ReadonlySet<string>, frameIds: ReadonlySet<string>): NonNullable<VerifyMeasured["tagsNotInExpectation"]> {
  const n = new Map<string, number>();
  for (const c of tagged) {
    if (c.dt === null || expectedIds.has(c.dt) || frameIds.has(c.dt) || !(c.flags.box && c.flags.visible && !c.flags.inClosedDialog)) continue;
    n.set(c.dt, (n.get(c.dt) || 0) + 1);
  }
  const ids = [...n.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 50).map((id) => ({ id, elements: n.get(id) ?? 0 }));
  return { count: n.size, ids };
}

const raf2 = (page: Page): Promise<unknown> => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
const docToken = async (page: Page): Promise<string> => { const v: unknown = await page.evaluate("window.__dtProbeDoc || ''"); return String(v); };

async function pass(page: Page, log: NavLog, o: ProbeOptions): Promise<PassResult> {
  const exp = o.expectation;
  const hiddenIds = new Set((exp.hidden && exp.hidden.ids) || []);
  const specs: VerifySpec[] = (exp.nodes || []).filter((s) => !hiddenIds.has(s.nodeId));
  const frameRows = (exp.frames && exp.frames.length ? exp.frames : [exp.frame || {}]).filter((f) => typeof f.nodeId === "string");
  const frameIn = frameRows.map((f) => ({ nodeId: String(f.nodeId), w: typeof f.w === "number" ? f.w : null, h: typeof f.h === "number" ? f.h : null }));

  const reached = await reachPage(page, log, o);
  const settleNote = reached.note;

  try {
    // L-a: the document settle saw quiet (after the steps: a step's own load is not a reload during measurement) —
    // one that replaced it since is caught by the check after the screenshot, never measured as the settled one
    const token = reached.token ?? await docToken(page);
    const reachedUrl = page.url();
    const texts = [...new Set(specs.map(specText).filter((t) => t !== null).map((t) => t.text))];
    const collected: CollectOutput = await page.evaluate(collectCandidates, { frames: frameIn, texts, positions: [] });
    const frames = new Map<string, ResolvedFrame | null>();
    frameIn.forEach((f, i) => {
      const tagged = collected.tagged.filter((c) => c.dt === f.nodeId);
      frames.set(f.nodeId, resolveFrame(f, tagged, (collected.frames[f.nodeId] || { sized: [] }).sized, collected.viewport, i === 0));
    });
    const expectedIds = new Set<string>([...specs.map((s) => s.nodeId), ...(exp.instances || []).map((i) => i.nodeId), ...hiddenIds]);
    const pool = buildPool(collected, specs, expectedIds, frames, frameIn[0]?.nodeId ?? null);
    if (o.position) {
      const boxes = positionBoxes(specs.filter((s) => !(pool.byTag.get(s.nodeId) || []).length), pool);
      if (boxes.length) {
        const more: CollectOutput = await page.evaluate(collectCandidates, { frames: [], texts: [], positions: boxes });
        pool.collect = { ...pool.collect, positions: more.positions };
      }
    }

    const matches: Array<{ spec: VerifySpec; m: Match | NoMatch }> = specs.map((spec) => ({ spec, m: chooseMatch(spec, pool, { position: o.position }) }));
    // one element, one spec (H1: five rows' identical dates all landed on one cell)
    const claimed = claimOnce(matches.map(({ m }) => m));
    matches.forEach((x, i) => { const c = claimed[i]; if (c) x.m = c; });
    const item = (spec: VerifySpec, m: Match): MeasureItem => ({ nodeId: spec.nodeId, path: m.path, isText: spec.type === "TEXT", isPaint: isPaintSpec(spec), isPlaceholder: spec.placeholder === true, sharesWith: m.sharesWith ?? null });
    const frameRectOf = (spec: VerifySpec): Rect => { const f = frames.get(spec.frameId ?? frameIn[0]?.nodeId ?? ""); return f ? f.rect : { x: 0, y: 0, w: o.viewport.w, h: o.viewport.h }; };

    // measure, one evaluate per frame (x/y/textBox are relative to that frame's root)
    const nodes = new Map<string, MeasuredNode>();
    const byFrame = new Map<string, Array<{ spec: VerifySpec; m: Match }>>();
    for (const { spec, m } of matches) if (isMatch(m)) { const k = spec.frameId ?? ""; byFrame.set(k, [...(byFrame.get(k) || []), { spec, m }]); }
    for (const group of byFrame.values()) {
      const first = group[0];
      if (!first) continue;
      const raw = await page.evaluate(measureElements, { frameRect: frameRectOf(first.spec), keys: STYLE_KEYS, items: group.map(({ spec, m }) => item(spec, m)) });
      group.forEach(({ spec, m }, i) => { const r = raw[i]; if (r) nodes.set(spec.nodeId, shapeNode(spec, m, r, STYLE_KEYS)); });
    }

    const stateNotes = new Set<string>();
    // D16: a minimal hover / focus for specs drawn in that state (pressed stays with the agent)
    for (const { spec, m } of matches) {
      const node = nodes.get(spec.nodeId);
      const state = spec.drawnState;
      if (!node || !isMatch(m) || (state !== "hover" && state !== "focus")) continue;
      const target = m.hoverVia ?? hoverTarget(m.cand, pool.byTag) ?? m.path;
      let focusPath: string | null = null;
      try {
        if (state === "hover") { await page.mouse.move(0, 0); await page.locator(target).first().hover({ timeout: 2000 }); }
        else {
          // focus lands on the element or its closest focusable ancestor — or nowhere (then no state is written)
          focusPath = await page.evaluate(focusablePath, m.path);
          if (focusPath === null) { node.note = "focus state not measured: the element is not focusable (nor is any ancestor)"; continue; }
          // keyboard first (programmatic focus, then Shift+Tab, Tab) so :focus-visible applies as for a user;
          // programmatic focus() alone when the Tab order does not come back to it
          await page.locator(focusPath).first().focus({ timeout: 2000 });
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          let info = await page.evaluate(focusInfo, focusPath);
          node.focusVia = "keyboard";
          if (!info.focused) {
            await page.locator(focusPath).first().focus({ timeout: 2000 });
            info = await page.evaluate(focusInfo, focusPath);
            node.focusVia = "programmatic";
            stateNotes.add("a focus state was measured after a programmatic focus(), which Chromium may not match to :focus-visible");
          }
          if (!info.focused) { delete node.focusVia; node.note = "focus state not measured: the element would not take focus"; continue; }
        }
        await raf2(page);
        const [r] = await page.evaluate(measureElements, { frameRect: frameRectOf(spec), keys: STYLE_KEYS, items: [item(spec, m)] });
        if (r) {
          // nulls stay (with their reasons): a value the probe could not read in the state is not the resting one
          const shaped = shapeNode(spec, m, r, STYLE_KEYS);
          node.states = { [state]: { styles: shaped.styles || {}, ...(shaped.unmeasured ? { unmeasured: shaped.unmeasured } : {}) } };
        }
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) !== "other") throw e;
        node.note = `${state} state not measured: ${errMsg(e).split("\n")[0]}`;
      } finally {
        if (state === "hover") await page.mouse.move(0, 0).catch(() => undefined);
        else if (focusPath !== null) await page.locator(focusPath).first().blur({ timeout: 2000 }).catch(() => undefined);
      }
    }
    if (matches.some(({ spec }) => spec.drawnState === "hover")) await raf2(page);

    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    // D43: the page's sideways overflow at this viewport — before the token check, so a reload re-runs it too
    const { compatMode, ...overflow } = await page.evaluate(readPageOverflow, null);
    const pageOverflow: PageOverflow = { ...overflow, compatMode };
    if ((await docToken(page)) !== token) throw new NavigatedError("the page loaded a new document during measurement");
    if (compatMode !== "CSS1Compat") stateNotes.add(`the page renders in quirks mode (document.compatMode ${compatMode}: no <!doctype html>) — its layout and page overflow measure differently from a standards-mode build`);

    const components: MeasuredComponent[] = [];
    for (const i of exp.instances || []) {
      if (hiddenIds.has(i.nodeId)) continue;
      if ((pool.byTag.get(i.nodeId) || []).some((c) => c.flags.box && c.flags.visible)) components.push({ nodeId: i.nodeId, ...(i.setName !== undefined ? { setName: i.setName } : {}) });
    }
    const notes = [settleNote, ...[...frames.values()].map((f) => f?.note ?? null), ...stateNotes].filter((n): n is string => typeof n === "string");
    return {
      nodes: specs.map((s) => nodes.get(s.nodeId)).filter((n): n is MeasuredNode => n !== undefined),
      notMeasured: matches.flatMap(({ m }) => (isMatch(m) ? [] : [{ nodeId: m.nodeId, why: m.why }])),
      frames: [...frames.values()].filter((f): f is ResolvedFrame => f !== null),
      components,
      png,
      notes,
      tagsNotInExpectation: foreignTags(collected.tagged, expectedIds, new Set(frameIn.map((f) => f.nodeId))),
      page: pageOverflow,
      url: reachedUrl,
    };
  } catch (e) {
    if (e instanceof NavigatedError || e instanceof UnreachableError || e instanceof BrowserGoneError || e instanceof StepError) throw e;
    if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
    if (errorKind(errMsg(e), false) === "navigated") throw new NavigatedError(errMsg(e).split("\n")[0]);
    throw e;
  }
}

/** The element to hover for a drawn hover state: the matched one, or — when it has no size at rest (hover-only
 *  content) — its nearest visible tagged ancestor. */
function hoverTarget(c: Candidate | null, byTag: Map<string, Candidate[]>): string | null {
  if (!c || (c.flags.visible && !c.flags.zeroSize)) return null;
  for (const a of c.taggedAncestors) {
    const hit = (byTag.get(a) || []).find((x) => x.flags.box && x.flags.visible && !x.flags.zeroSize);
    if (hit) return hit.path;
  }
  return null;
}

export type ProbeRun =
  | { kind: "ok"; result: PassResult; navigation: ProbeNavigation; consoleErrors: string[]; build: ServedBuild }
  | { kind: "navigation"; why: string; navigation: ProbeNavigation }
  /** H-a: a reload lost what a click step built in place, on the first pass and again on the re-run */
  | { kind: "step-state"; why: string; navigation: ProbeNavigation }
  | { kind: "browser-gone"; why: string; navigation: ProbeNavigation }
  | { kind: "steps"; why: string; navigation: ProbeNavigation };

/** DT-81 build identity: one same-origin response body being read (H-1). */
interface BodyRead { path: string; state: "pending" | "hashed" | "no body" | "failed"; done: Promise<unknown> }
/** H-1: how long the end of a pass waits for its response bodies (each normally lands within milliseconds). */
export const BODY_WAIT_MS = 2_000;
/** Wait ≤ BODY_WAIT_MS for this pass's bodies; a note naming the paths left out of assetsSha256 (unread or failed, and
 *  not hashed from another response of the same path), or null. */
async function bodiesRead(reads: readonly BodyRead[], served: ReadonlyMap<string, string>): Promise<string | null> {
  await Promise.race([Promise.allSettled(reads.map((r) => r.done)), sleep(BODY_WAIT_MS, undefined, { ref: false })]);
  const missed = new Map<string, string>();
  for (const r of reads) {
    if (served.has(r.path) || (r.state !== "pending" && r.state !== "failed")) continue;
    missed.set(r.path, r.state === "failed" ? "the request failed" : `not received within ${BODY_WAIT_MS / 1000} s — a load cut short by another navigation`);
  }
  if (!missed.size) return null;
  const list = [...missed].slice(0, 5).map(([p, why]) => `${p} (${why})`).join(", ");
  return `build identity: ${missed.size} same-origin response body(ies) not hashed — ${list}${missed.size > 5 ? ", …" : ""}; measured.build.assetsSha256 leaves them out`;
}

/** Measure with one automatic full re-run after a reload; a second one is D19's exit 4. */
export async function runProbe(browser: Browser, o: ProbeOptions): Promise<ProbeRun> {
  const context = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  // F-107: every Playwright action waits at most --timeout (the default is 30 s, but only for some calls)
  page.setDefaultTimeout(o.timeout);
  await page.addInitScript({ content: INIT_SCRIPT });
  // DT-81: same-origin responses of the current pass (a re-run starts a new generation)
  let origin = "";
  try { origin = new URL(o.url).origin; } catch { /* goto reports the bad url */ }
  const served = new Map<string, string>();
  // H-1: the bodies of THIS pass only (a re-run starts a new list). In Playwright the body of a response whose headers
  // arrived but whose load another navigation cut short (the re-run's goto aborting a slow reload) never settles, and
  // no requestfailed/finished fires for it either — so the wait for them is bounded (BODY_WAIT_MS) and what is left
  // unread is named in a note instead of hanging the run until --max-time.
  let bodies: BodyRead[] = [];
  let gen = 0, viteClient = false;
  page.on("response", (res) => {
    if (!BUILD_TYPES.has(res.request().resourceType())) return;
    let u: URL;
    try { u = new URL(res.url()); } catch { return; }
    if (u.origin !== origin) return;
    if (u.pathname === "/@vite/client") viteClient = true;
    const g = gen;
    const read: BodyRead = { path: u.pathname, state: "pending", done: Promise.resolve() };
    const body = res.body().then((b) => { if (g === gen) served.set(u.pathname, sha256Of(b)); read.state = "hashed"; }, () => { read.state = "no body"; }); // a redirect has no body
    // a request that failed (aborted, refused) says so here — its body is never waited for
    const failed = res.finished().then((err) => { if (!err) return body; read.state = "failed"; return undefined; }, () => { read.state = "failed"; });
    read.done = Promise.race([body, failed]);
    bodies.push(read);
  });
  const log = attachNavLog(page);
  const consoleErrors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error" && consoleErrors.length < 20) consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => { if (consoleErrors.length < 20) consoleErrors.push(err.message); });
  const nav = (reruns: number): ProbeNavigation => ({ events: log.events, afterInitialLoad: Math.max(0, log.navs - log.gotos), reruns });
  let reruns = 0;
  try {
    for (;;) {
      try {
        gen++; served.clear(); viteClient = false; bodies = [];
        const result = await pass(page, log, o);
        const unread = await bodiesRead(bodies, served);
        if (unread !== null) result.notes.push(unread);
        // facts-12a §9: the re-run reloads in the SAME context — session/local storage set by the first pass stays
        if (reruns && o.steps && o.steps.length) result.notes.push("the re-run replayed the steps in the same browser context (session and local storage from the first pass kept)");
        return { kind: "ok", result, navigation: nav(reruns), consoleErrors, build: buildFrom(o.url, served, viteClient) };
      } catch (e) {
        if (e instanceof BrowserGoneError) return { kind: "browser-gone", why: e.message, navigation: nav(reruns) };
        if (e instanceof KeptNavigatingError) return { kind: "navigation", why: e.message, navigation: nav(reruns) };
        if (e instanceof StepError) return { kind: "steps", why: e.message, navigation: nav(reruns) };
        if (!(e instanceof NavigatedError)) throw e;
        if (reruns >= 1) {
          if (e instanceof StepStateLostError) return { kind: "step-state", why: e.message, navigation: nav(reruns) };
          return { kind: "navigation", why: `the page reloaded during measurement twice (${e.message})`, navigation: nav(reruns) };
        }
        reruns++;
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- CLI
const USAGE =
  "usage:\n" +
  `  ${scriptCmd("verify-probe")} --expected design/verify/<Screen>.expected.json --url <url> [--out design/verify/<Screen>]\n` +
  "      [--ready <selector>] [--viewport WxH] [--project <dir>] [--position] [--timeout <ms>] [--run <id>] [--max-time <ms>]\n" +
  "      [--steps <steps.json | plan.json>]\n" +
  "      renders <url> in the PROJECT's Playwright (chromium), matches every expectation row (tag → shared path → alias →\n" +
  "      text → text-ordinal → --position), and writes <out>.measured.json + <out>.png for verify-screen --compare.\n" +
  "      --out defaults to the .expected.json path minus `.expected`; --viewport to the frame's w×h; --project to cwd.\n" +
  "      --run <id> (from verify-screen --status … --new-run): writes the run's LIVE status (the run cache,\n" +
  "      node_modules/.cache/designtwin-verify/<Screen>.status.json — never the project tree a dev server watches) — `measuring`\n" +
  "      before the browser starts, `measured` (+ the measured file's sha256) after it is closed; an exit 3/4 bumps its rev.\n" +
  "      --max-time bounds the whole run (default 180000 ms): past it the browser is closed and nothing is written (exit 4).\n" +
  "      --steps: a JSON list of steps (or a plan whose `navigate` holds them) replayed after every page load, before --ready,\n" +
  "      to reach a screen that is a section of the app (not a URL): {\"click\": \"<selector>\"} | {\"waitFor\": \"<selector>\"} |\n" +
  "      {\"goto\": \"/same-origin/path\"}. A click's selector must match exactly one visible element (a waitFor's at least one);\n" +
  "      a click never submits a form. A click's navigation to another URL is the step's own, however late; a reload after a\n" +
  "      click changed the page in place re-runs the pass once (twice: exit 4). A step that fails while measuring is exit 4\n" +
  "      (nothing written). Recorded as measured.reach.\n" +
  "      After measuring, the expectation's overlay interactions (on_click/on_press overlay/swap, plan expect:\"dialog\") are\n" +
  "      driven, each on a fresh page: measured.interactions (evidence; ok:true or ok:null, never false).\n" +
  `  ${scriptCmd("verify-probe")} --check [--project <dir>]\n` +
  "      resolves the project's Playwright and launches chromium once — nothing measured, nothing written.\n" +
  "exit: 0 wrote · 2 usage · 3 renderer unavailable (ask the user to install; never installed here) · 4 the page kept\n" +
  "      navigating / reloaded twice during measurement / was unreachable / timed out / passed --max-time / a --steps step\n" +
  "      failed (nothing written).";

const MAX_TIME_DEFAULT = 180_000, CLOSE_CAP_MS = 10_000;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  if (!argv.length) { console.error(USAGE); return 2; }
  const OPTIONS = {
    expected: { type: "string" }, url: { type: "string" }, out: { type: "string" }, ready: { type: "string" }, viewport: { type: "string" },
    project: { type: "string" }, position: { type: "boolean" }, timeout: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" },
    run: { type: "string" }, "max-time": { type: "string" }, steps: { type: "string" },
  } as const;
  const { values: f } = cliParse("verify-probe", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: false }));
  const project = path.resolve(f.project ?? ".");
  const timeout = f.timeout === undefined ? 30_000 : Number(f.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) { console.error(`verify-probe: --timeout must be a positive number of milliseconds\n${USAGE}`); return 2; }
  const maxTime = f["max-time"] === undefined ? MAX_TIME_DEFAULT : Number(f["max-time"]);
  if (!Number.isFinite(maxTime) || maxTime <= 0) { console.error(`verify-probe: --max-time must be a positive number of milliseconds\n${USAGE}`); return 2; }
  if (f.run !== undefined && (f.check || !/^[\w.:-]+$/.test(f.run))) { console.error(`verify-probe: ${f.check ? "--run does not apply to --check" : `--run must be a run id (letters, digits, . : _ -), got '${f.run}'`}\n${USAGE}`); return 2; }

  if (!f.check) {
    if (!f.expected || !f.url) { console.error(`verify-probe: --expected and --url are both required\n${USAGE}`); return 2; }
  } else if (f.steps !== undefined) { console.error(`verify-probe: --steps does not apply to --check\n${USAGE}`); return 2; }
  // L-1: the steps — a JSON list, or a plan's navigate[]; refused whole when any step is outside the vocabulary
  let steps: ProbeStep[] = [];
  let stepsSource: string | null = null;
  if (f.steps !== undefined) {
    const r = readJson(f.steps, anyJson);
    if ("error" in r) { console.error(`verify-probe: --steps '${f.steps}' ${r.error}`); return 2; }
    const parsed = parseSteps(r.doc);
    if ("error" in parsed) { console.error(`verify-probe: --steps '${f.steps}' ${parsed.error}\n${USAGE}`); return 2; }
    steps = parsed.steps;
    stepsSource = `--steps ${(path.relative(process.cwd(), path.resolve(f.steps)) || f.steps).split(path.sep).join("/")}`;
  }
  let expectation: Expectation | null = null, expBytes: Buffer | null = null;
  let viewport = { w: 1280, h: 800 };
  const notes: string[] = [];
  if (!f.check && f.expected) {
    const r = readJson(f.expected, isVerifyExpectation);
    if ("error" in r) { console.error(`verify-probe: '${f.expected}' ${r.error}`); return 2; }
    expectation = r.doc;
    expBytes = fs.readFileSync(f.expected);
    const fr = expectation.frame || {};
    if (f.viewport !== undefined) {
      const m = /^(\d+)x(\d+)$/i.exec(f.viewport.trim());
      if (!m) { console.error(`verify-probe: --viewport must be WxH (e.g. 1440x900), got '${f.viewport}'\n${USAGE}`); return 2; }
      viewport = { w: Number(m[1]), h: Number(m[2]) };
    } else if (typeof fr.w === "number" && typeof fr.h === "number") viewport = { w: Math.round(fr.w), h: Math.round(fr.h) };
    else notes.push("the expectation states no frame size — measured at 1280x800; pass --viewport");
  }

  const outBase = f.out ?? (f.expected ? path.join(path.dirname(f.expected), path.basename(f.expected, ".json").replace(/\.expected$/, "")) : "");
  // F-72: the run's status is the one of the expectation's verify dir (design/verify/<S>), even when --out stages
  // the files elsewhere; H1: it is written to the run cache (liveStatusFile), never into the watched project tree
  const statusBase = f.expected ? path.join(path.dirname(f.expected), path.basename(outBase)) : "";
  const expSha = expBytes ? sha256Of(expBytes) : undefined;
  const runId = f.run !== undefined && !f.check && statusBase ? f.run : undefined;
  // M-a: a status write the run cache refuses (the sandbox's write scope) is a warning — the probe keeps its exit
  // contract (0/2/3/4) and never crashes on it. Returns false when the write was refused.
  const status = (w: StatusWrite): boolean => {
    try { writeStatus(statusBase, w); return true; } catch (e) {
      if (!(e instanceof RunCacheUnwritable)) throw e;
      console.error(`warning  ${e.message}`);
      return false;
    }
  };
  // an exit 3/4 with --run: the status says so (rev bumped, phase stays measuring — the one allowed re-run follows)
  const ended = (code: number): number => {
    if (runId !== undefined && (code === 3 || code === 4)) {
      status({ runId, phase: "measuring", by: "verify-probe", detail: `probe exit ${code} — nothing written`, ...(expSha ? { expectationSha256: expSha } : {}) });
    }
    return code;
  };
  const res = resolvePlaywright(project);
  if (!res.ok) return ended(rendererUnavailable(res.reason, res.hint));
  // written BEFORE the browser starts, and outside the project tree (F-91/H1); false when refused (or no --run)
  const measuringRecorded = runId !== undefined && status({ runId, phase: "measuring", by: "verify-probe", detail: `verify-probe measuring ${f.url ?? ""}`, ...(expSha ? { expectationSha256: expSha } : {}) });
  if (measuringRecorded) console.error(`status ${shellArg(liveStatusFile(statusBase))}`);

  // F-107: one bound over launch → measure → close. Past it the browser is closed (at most 10 s more) and nothing is written.
  const held: { browser?: Browser; timedOut?: boolean } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runDeadline = Date.now() + maxTime;
  const watchdog = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), maxTime); });
  const work = (async (): Promise<number | { run: Extract<ProbeRun, { kind: "ok" }>; identity: ProbeIdentity; driven: InteractionEvidence[] | null; driveNote: string | null }> => {
    const launched = await launch(res, project);
    if ("error" in launched) return rendererUnavailable(launched.error, launched.hint);
    const browser = launched.browser;
    held.browser = browser;
    const identity: ProbeIdentity = { name: "verify-probe", version: probeVersion(), sha256: selfSha256(), playwright: { package: res.pkg, version: res.version }, browser: { name: "chromium", version: browser.version() } };

    if (f.check || !expectation || !expBytes || !f.expected || !f.url) {
      await browser.close();
      console.log(`ok  ${res.pkg} ${res.version} (from ${path.relative(project, res.file) || res.file}) · chromium ${identity.browser.version} · verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}…)`);
      return 0;
    }

    let run: ProbeRun;
    const probeOpts: ProbeOptions = { expectation, url: f.url, ...(f.ready !== undefined ? { ready: f.ready } : {}), viewport, position: !!f.position, timeout, ...(steps.length ? { steps } : {}) };
    try {
      run = await runProbe(browser, probeOpts);
    } catch (e) {
      await browser.close().catch(() => undefined);
      if (e instanceof UnreachableError) { console.error(`verify-probe: ${e.message} — nothing written.`); return 4; }
      if (/Timeout .*exceeded/i.test(errMsg(e))) { console.error(`verify-probe: timed out — ${errMsg(e).split("\n")[0]} — nothing written.`); return 4; }
      throw e;
    }
    // F-70/F-95: drive the overlay interactions, each on a fresh page, after the measurement pass and before the
    // browser closes — within min(60 s, what --max-time leaves less 15 s). Never blocks the measured file, never exit 4.
    let driven: InteractionEvidence[] | null = null, driveNote: string | null = null;
    const rows = run.kind === "ok" ? drivable(expectation) : [];
    if (rows.length) {
      try {
        driven = await driveInteractions(browser, {
          rows, viewport, timeout, initScript: INIT_SCRIPT, budgetMs: driveBudget(Date.now(), runDeadline),
          reach: async (page) => { await reachPage(page, attachNavLog(page), probeOpts); },
        });
      } catch (e) {
        driveNote = `driving the interactions failed (${errMsg(e).split("\n")[0]}) — none recorded`;
      }
    }
    await browser.close().catch(() => undefined);

    if (held.timedOut) return 4; // the watchdog closed it — its own message says so
    if (run.kind === "browser-gone") {
      console.error(`verify-probe: ${run.why} — nothing written. This is not a page reload: re-run the probe; if it recurs, run --check.`);
      return 4;
    }
    if (run.kind === "navigation") {
      console.error(`verify-probe: ${run.why} — nothing written.\n` +
        "  the page reloaded during measurement: move writes out of the dev-server watch tree (see verify.md), or serve a production build.\n" +
        "  navigation log:\n" + run.navigation.events.map((ev) => `    +${ev.at}ms ${ev.type} ${ev.url}`).join("\n"));
      return 4;
    }
    if (run.kind === "step-state") {
      // H-a: not the dev-server hint — on the replay the same click was followed by a reload again, so the click (or the
      // app's answer to it) most likely reloads the page itself
      console.error(`verify-probe: ${run.why}, on the first pass and again on the re-run (the steps replayed) — nothing written.\n` +
        `  a reload brings the page back without what the click built in place, so the --steps (${stepsSource ?? "?"}) cannot hold the screen: ${steps.map((s, i) => describeStep(s, i)).join(" → ")}\n` +
        "  if that click reloads the page itself (location.reload(), or a navigation to the URL the page is already on), it is not a\n" +
        "  navigation step: reach the screen by its own URL (--url, or a {\"goto\": \"/path\"} step) or by a click that navigates to\n" +
        "  another URL. A click whose navigation goes to another URL is the step's own, however late it starts.\n" +
        "  navigation log:\n" + run.navigation.events.map((ev) => `    +${ev.at}ms ${ev.type} ${ev.url}`).join("\n"));
      return 4;
    }
    if (run.kind === "steps") {
      console.error(`verify-probe: ${run.why} — nothing written.\n` +
        `  the --steps (${stepsSource ?? "?"}) did not reach the screen: ${steps.map((s, i) => describeStep(s, i)).join(" → ")}\n` +
        "  navigation log:\n" + run.navigation.events.map((ev) => `    +${ev.at}ms ${ev.type} ${ev.url}`).join("\n"));
      return 4;
    }
    return { run, identity, driven, driveNote };
  })();
  const first = await Promise.race([work, watchdog]);
  clearTimeout(timer);
  if (first === "timeout") {
    held.timedOut = true;
    work.catch(() => undefined); // it rejects once its browser is gone
    const b = held.browser;
    // browser.close() closes each page first, and a page whose script never yields does not close — so ask the
    // browser PROCESS to quit (CDP Browser.close, Chromium), then close the handle; each step capped
    if (b) {
      // (unref'd caps: a pending cap must not keep the process alive once the browser is gone)
      const cap = (): Promise<void> => sleep(CLOSE_CAP_MS, undefined, { ref: false });
      await Promise.race([b.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => undefined), cap()]);
      await Promise.race([b.close().catch(() => undefined), cap()]);
    }
    console.error(`verify-probe: timed out after ${maxTime / 1000}s (--max-time) — the browser was closed, nothing written.\n` +
      "  a page that never settles (a script that does not yield, a request that never ends): re-run the probe once; if it times out again, report it (status failed).");
    return ended(4);
  }
  if (typeof first === "number") return ended(first);
  const { run, identity, driven, driveNote } = first;
  if (!expectation || !expBytes || !f.expected || !f.url) return 2; // (--check returned above)

  // Everything below runs after browser.close(): nothing is written while the page is live (a write into the
  // dev server's watch tree is what reloaded it mid-measurement, F-91).
  const png = outBase + ".png";
  const r = run.result;
  const frameOut = (fr: ResolvedFrame): ProbeFrame => ({ nodeId: fr.nodeId, selector: fr.selector, via: fr.via, rect: fr.rect });
  const firstFrame = r.frames[0];
  const measured: VerifyMeasured = {
    measuredAt: new Date().toISOString(),
    renderer: "playwright-chromium",
    viewport: `${viewport.w}x${viewport.h}`,
    artifacts: [png.split(path.sep).join("/")],
    expectationSha256: sha256Of(expBytes),
    probe: identity,
    ...(firstFrame ? { frame: frameOut(firstFrame) } : {}),
    ...(r.frames.length > 1 ? { frames: r.frames.map(frameOut) } : {}),
    navigation: run.navigation,
    matchedByCensus: { ...census(r.nodes, r.notMeasured) },
    nodes: r.nodes,
    notMeasured: r.notMeasured,
    components: r.components,
    tagsNotInExpectation: r.tagsNotInExpectation,
    ...(run.consoleErrors.length ? { consoleErrors: run.consoleErrors } : {}),
    ...(f.run !== undefined ? { runId: f.run } : {}),
    build: { ...run.build, ...gitState(project) },
    ...(stepsSource !== null ? { reach: { steps, sha256: stepsSha256(steps), source: stepsSource, url: r.url } } : {}),
    page: r.page,
    ...(driven ? { interactions: driven } : {}),
  };
  const allNotes = [...notes, ...r.notes, ...(driveNote !== null ? [driveNote] : [])];
  // F-72: atomic, the picture first — a reader that sees measured.json sees the screenshot it lists
  const measuredText = JSON.stringify(allNotes.length ? { ...measured, notes: allNotes } : measured, null, 2) + "\n";
  writeFileAtomic(png, r.png);
  writeFileAtomic(outBase + ".measured.json", measuredText);
  // the measured file stays when this write is refused: the run's status still says measuring, so say what records it
  const statusRefused = runId !== undefined && !status({ runId, phase: "measured", by: "verify-probe", detail: `measured ${r.nodes.length} of ${r.nodes.length + r.notMeasured.length} spec(s)`,
    ...(expSha ? { expectationSha256: expSha } : {}), measuredSha256: sha256Of(measuredText) });
  const c = census(r.nodes, r.notMeasured);
  console.error(`wrote ${outBase}.measured.json and ${png}`);
  console.error(`measured ${r.nodes.length} of ${r.nodes.length + r.notMeasured.length} spec(s) — tag ${c.tag} · shared path ${c.sharedPath} · alias ${c.tagAlias} · text ${c.text} · ordinal ${c.textOrdinal} · position ${c.position} · frame ${c.frame} · not measured ${c.notMeasured}` +
    ` · frame root via ${firstFrame ? firstFrame.via : "none"} · navigations after load ${run.navigation.afterInitialLoad}, re-runs ${run.navigation.reruns}`);
  const tn = r.tagsNotInExpectation;
  if (tn.count) console.error(`note  ${tn.count} data-dt-node value(s) on visible elements are not in the expectation (e.g. ${tn.ids.slice(0, 5).map((x) => x.id).join(", ")}) — --compare classifies them`);
  if (stepsSource !== null) console.error(`reach ${steps.length} step(s) from ${stepsSource} (sha ${stepsSha256(steps).slice(0, 12)}…) → ${r.url}`);
  const pg = r.page;
  console.error(`page  scrollWidth ${pg.scrollWidth} at clientWidth ${pg.clientWidth} (overflow-x ${pg.overflowX})${pg.scrollWidth > pg.clientWidth + 1 ? (pg.scrollable ? ` — scrolls sideways (widest: ${pg.offenders.slice(0, 3).map((o) => o.dt ? `data-dt-node="${o.dt}"` : o.path).join(", ") || "?"})` : " — overflows but clipped") : ""}`);
  for (const ev of driven || []) console.error(`drive ${ev.nodeId} ${ev.trigger ?? ""} → ${ev.ok === true ? "ok" : "ok:null"} · ${ev.detail ?? ""}`);
  for (const n of allNotes) console.error(`note  ${n}`);
  console.error(`probe verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}…) · ${res.pkg} ${res.version} · chromium ${identity.browser.version}`);
  if (statusRefused && runId !== undefined) {
    // M-1: say which write was refused and what --compare will make of it; the recovery records the measured file's
    // sha after the same checks `done` applies (it reads <verify dir>/<S>.measured.json, else the run's stage dir)
    const outDir = path.resolve(path.dirname(outBase)), verifyDir = path.resolve(path.dirname(statusBase));
    const findable = outDir === verifyDir || outDir === path.resolve(stageDirOf(statusBase, runId));
    console.error(`warning  ${outBase}.measured.json is written, but the run cache refused the probe's \`measured\` status write for run ${runId}` +
      (measuringRecorded ? " — the live status still says measuring, so --compare reports the run incomplete"
        : " (its `measuring` write was refused too) — no live status of the run exists, so --compare will report the run as unrecorded") +
      `. Record it, from where the run cache takes writes, with: ${scriptCmd("verify-screen")} --status ${shellArg(path.basename(statusBase))} --phase measured --run ${runId} --dir ${shellArg(verifyDir)}` +
      (findable ? "" : ` — after moving ${outBase}.measured.json to ${statusBase}.measured.json (it reads the verify dir or the run's stage dir)`));
  }
  console.error(`next  ${scriptCmd("verify-screen")} --compare ${shellArg(f.expected)} ${shellArg(outBase + ".measured.json")} --out ${shellArg(outBase)}`);
  return 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => { console.error(`verify-probe: ${errMsg(e)}`); process.exitCode = 1; });
}
