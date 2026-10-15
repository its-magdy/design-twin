// verify-probe.ts — the shipped web probe: render the built screen, measure every expectation row the same
// way every time, write <Screen>.measured.json for `verify-screen.js --compare`. Flags and exit codes: --help.
//
// Why it exists: a verifier left to write its own Playwright script matches elements differently each time
// (first element with the text; the <li> instead of the <button>; the <h2> of a CLOSED dialog), leaves keys
// out (`fill` in 0 of 185 measurements), reads a text's font off its container, crashes on a dev-server
// reload, and is patched mid-run — so the same unchanged screen measured 185 nodes one round and 42 the
// next, and nothing said why. This probe fixes the method: one matching order (probe-match.ts), every
// STYLE_KEY on every node with a reason for every null, the probe's own identity (version, sha256 of this
// file, Playwright + browser versions) in the output, and a reload during measurement answered by ONE full
// re-run, then exit 4 with nothing written.
//
// Playwright is the PROJECT's: resolved with createRequire(<project>/package.json) — playwright, then
// @playwright/test, then playwright-core — never bundled, never installed, and no browser is ever
// downloaded by this script. Its types are `import type` only (erased from the bundle).
//
// The whole run is bounded (--max-time: a page whose script never yields would hang the verifier for good).
// Every measurement belongs to a run, named in the measured file: --run <id>'s, else one the probe starts itself and
// ends (`done`, or `failed` on an exit 3/4) — never beside another open run of the screen (a verifier's writes the same
// files). The probe writes the run's status itself — `measuring` before the browser starts, `measured` (its own run:
// `done`) + the measured file's sha256 after it is closed, and nothing while a page is open; with --run it counts its
// own failed attempts (exit 3/4) and ends the run `failed` at the second. Every load waits for --ready, by default
// the frame's tag, so a redirect or another section is never measured as the screen (a page that shows at
// least half of the expectation's own tags but not the frame's, and no other screen's tagged root, is the screen with
// an untagged root, measured with a note; every later load of the run waits for the same). Files are
// written atomically, the screenshot first and measured.json last (a reader that sees the measured file
// sees its picture); measured.build records what was served (to expose a stale preview).
//
// After the measurement pass come three evidence-only stages, none of them the fidelity verdict, none an
// exit 4 (a failure is {ran:false, why}): the overlay interactions are DRIVEN, each on a fresh page
// (probe-drive.ts → measured.interactions); the built frame is captured once more at the reference's scale
// (probe-visual.ts; a reference-less expectation skips it; `--behaviour off` does not) and diffed against the Figma
// reference in Node after the browser is closed (visual-diff.ts → measured.visual, <out>.diff.png); and the
// behaviour/accessibility checks run (probe-behaviour.ts → measured.behaviour; `--behaviour off`, test-only, skips them; the
// browser is closed capped — CDP Browser.close, then close — because the units run arbitrary page code). The
// reference PNG is read from the project that owns the expectation (the directory above design/verify/ of
// --expected, else --project — a monorepo).
//
// Navigation accounting: a navigation is a main-frame document LOAD (a reload, a cross-document
// link) — never a `framenavigated`, which also fires for same-document history changes (pushState, a hash). Loads the
// probe causes itself (the goto, a step that loads a page) are not "after the initial load". A click step owns the
// navigation it causes however late it starts, as long as it goes to ANOTHER URL (a reload of the same URL is never a
// step's — except the load of a click on a link to the URL the page already shows: a refresh step, owned like a goto's);
// a reload after a click changed the page in place loses that state — the pass is re-run once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserType, Page, Request, Response } from "playwright";
import { spawnSync } from "node:child_process";
import { PROC_HOST, killChildTree, parentPid, taskkillCapped, type ProcHost } from "./kill-tree.ts";
import { collectCandidates, focusablePath, focusInfo, freeHoverPoint, measureElements, screenTags } from "./probe-page.ts";
import type { Candidate, CollectOutput, ForeignRoot, MeasureInput, MeasureItem, Rect, ScreenTags } from "./probe-page.ts";
import { attrSelector, buildPool, census, chooseMatch, claimOnce, isMatch, isPaintSpec, ownerHover, positionBoxes, resolveFrame, shapeNode, specText } from "./probe-match.ts";
import type { Match, NoMatch, ResolvedFrame } from "./probe-match.ts";
import { STYLE_KEYS } from "./verify-shared.ts";
import { isVerifyExpectation } from "./doc-guards.ts";
import { anyJson, readJson, readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd, shellArg } from "./cli-args.ts";
import { isJsonObject } from "./types.ts";
import type { BuildIdentity, InteractionEvidence, MeasuredBehaviour, MeasuredComponent, MeasuredVisual, MeasuredNode, PageOverflow, ProbeFrame, ProbeIdentity, ProbeNavigation, ProbeNotMeasured, ProbeStep, VerifyMeasured,
  VerifySpec } from "./types.ts";
import { describeStep, parseSteps, stepsSha256 } from "./probe-steps.ts";
import { StepError, drivable, driveBudget, driveInteractions, raf2, readPageOverflow, submitGuard } from "./probe-drive.ts";
import type { DriveResult } from "./probe-drive.ts";
import { CLOSE_STEP_CAP_MS, KILL_STEP_CAP_MS, behaviourBudget, runBehaviour } from "./probe-behaviour.ts";
import { captureVisual, finishVisual, prepareVisual, referenceRoot, visualBudget, visualLine } from "./probe-visual.ts";
import type { VisualCapture, VisualPrep } from "./probe-visual.ts";
import { gitHead } from "./content-hash.ts";
import { RunCacheUnwritable, RunEnded, RunOpen, RunReplaced, endedRun, liveStatusFile, newRunId, openRun, probeAttemptNote, publishStatus, readStatus, replacedRun, stageDirOf, statusFile, writeStatus } from "./verify-run.ts";
import { LockBusy, LockLost, thisProcess } from "../bridge/src/file-lock.ts";
import { writeFileAtomic } from "../bridge/src/atomic-write.ts";
import type { StatusWrite, StatusWriteHooks, VerifyStatusV2 } from "./verify-run.ts";
import type { Expectation } from "./verify-shared.ts";
import { errMsg, firstLine } from "../bridge/src/errmsg.ts";
import { pwErrorKind, pwFirstLine } from "./pw-errors.ts";
import { isMainFallback } from "../bridge/src/is-main.ts";

// ---------------------------------------------------------------- resolving the project's Playwright
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

/** The project's require: the ONE createRequire call site — Playwright and axe-core both resolve through it,
 *  never from this script's own location (the bundle test allows exactly one). */
export function projectRequire(dir: string): ReturnType<typeof createRequire> {
  return createRequire(path.join(path.resolve(dir), "package.json"));
}

export function resolvePlaywright(dir: string): Resolution {
  const abs = path.resolve(dir);
  const req = projectRequire(abs);
  const tried: string[] = [];
  for (const name of PLAYWRIGHT_PACKAGES) {
    let file: string;
    try { file = req.resolve(name); } catch { tried.push(`${name}: not installed`); continue; }
    let mod: unknown;
    try { mod = req(name); } catch (e) { tried.push(`${name}: failed to load (${firstLine(e)})`); continue; }
    if (!isPlaywrightModule(mod)) { tried.push(`${name}: has no chromium launcher`); continue; }
    let version = "unknown";
    try { const pj: unknown = req(`${name}/package.json`); if (isJsonObject(pj) && typeof pj.version === "string") version = pj.version; } catch { /* exports without ./package.json */ }
    return { ok: true, pkg: name, version, mod, file };
  }
  const pnp = fs.existsSync(path.join(abs, ".pnp.cjs")) ? " — this project uses Yarn Plug'n'Play: retry the probe as `yarn node <this script> …`" : "";
  return { ok: false, reason: `no playwright package resolvable from ${path.join(abs, "package.json")} (${tried.join("; ")})${pnp}`, hint: installHint(abs) };
}

/** the PROJECT's axe-core — never bundled, never installed; absent → the a11y.axe check is not-run. */
export type AxeResolution = { ok: true; source: string; version: string; file: string } | { ok: false; why: string };
export function resolveAxe(dir: string): AxeResolution {
  const req = projectRequire(dir);
  let file: string;
  try { file = req.resolve("axe-core"); } catch { return { ok: false, why: "axe-core not installed in the project (optional)" }; }
  let mod: unknown;
  try { mod = req("axe-core"); } catch (e) { return { ok: false, why: `axe-core failed to load (${firstLine(e)})` }; }
  if (typeof mod !== "object" || mod === null || !("source" in mod) || typeof mod.source !== "string") return { ok: false, why: "axe-core resolved, but it exports no source" };
  let version = "version" in mod && typeof mod.version === "string" ? mod.version : "unknown";
  try { const pj: unknown = req("axe-core/package.json"); if (isJsonObject(pj) && typeof pj.version === "string") version = pj.version; } catch { /* exports without ./package.json */ }
  return { ok: true, source: mod.source, version, file };
}

/** hint null (a --browser-path that is no executable) → one line: there is nothing to install. */
function rendererUnavailable(reason: string, hint: string | null): number {
  if (hint === null) { console.error(`verify-probe: renderer unavailable — ${reason} — nothing was measured or written.`); return 3; }
  console.error(`verify-probe: renderer unavailable — ${reason}\n` +
    `  nothing was measured or written. Ask the user to run:  ${hint}\n` +
    "  (verify-probe never installs a package or downloads a browser itself.)");
  return 3;
}

/** The chromium flags the probe launches with; the tests that render a reference or a page for the probe use the same ones. */
export const LAUNCH_ARGS: readonly string[] = ["--disable-lcd-text"];

/** `executablePath` = --browser-path (validated by browserPathError first); absent → Playwright's own chromium. */
async function launch(r: Extract<Resolution, { ok: true }>, dir: string, executablePath?: string): Promise<{ browser: Browser } | { error: string; hint: string }> {
  // --disable-lcd-text: no layout or measured geometry; only how text is rasterised (and which layers Chromium may composite) —
  // grayscale AA, which Figma's PNG exports use and macOS Chromium uses by default. Linux chromium's default LCD (subpixel RGB)
  // text has colour fringes that depend on each glyph's sub-pixel phase, so unchanged text at the reference's 4-decimal scale
  // came out as hot regions in the visual diff (the e2e's correct twin, on CI).
  try { return { browser: await r.mod.chromium.launch({ headless: true, args: [...LAUNCH_ARGS], ...(executablePath !== undefined ? { executablePath } : {}) }) }; } catch (e) {
    const first = (errMsg(e).split("\n").find((l) => l.trim()) || "launch failed").trim();
    return { error: `${r.pkg} ${r.version} resolved, but chromium did not launch${executablePath !== undefined ? ` from --browser-path ${executablePath} (only guaranteed with the bundled Chromium)` : ""}: ${first}`,
      hint: browserHint(dir) };
  }
}

/** The pid of each browser this process launched — what closeCapped ends when the browser does not go. */
const launchPids = new WeakMap<object, number>();
/** Records the launched browser's pid (launchPid) for closeCapped. Called once the browser is held where the --max-time
 *  watchdog closes it, so a watchdog firing during this ≤ LAUNCH_PID_CAP_MS wait still closes the browser (its pid then
 *  unknown: closeCapped ends this process's direct children). */
async function recordLaunchPid(browser: Browser): Promise<void> {
  const pid = await launchPid(browser);
  if (pid !== undefined) launchPids.set(browser, pid);
}
/** What launchPid asks of a browser CDP session (a Playwright CDPSession is one). */
interface ProcessInfoSession {
  send(method: "SystemInfo.getProcessInfo"): Promise<{ processInfo: Array<{ type: string; id: number }> }>;
  detach(): Promise<void>;
}
/** How long launchPid waits for the browser's answer. */
const LAUNCH_PID_CAP_MS = 2_000;
/** The browser's own pid, as it reports it (CDP SystemInfo.getProcessInfo, the entry of type "browser" — the process
 *  Playwright launched; an experimental domain), or undefined when it does not answer within capMs (closeCapped then ends
 *  this process's direct children instead). On Linux the reported pid must be a child of this process (/proc/<pid>/stat):
 *  a --browser-path wrapper that runs the browser in its own pid namespace reports a pid from that namespace, which here
 *  names another process — so a pid whose parent is not this process, or cannot be read, counts as unknown. `host` is for
 *  the tests. Never throws. */
export async function launchPid(b: { newBrowserCDPSession(): Promise<ProcessInfoSession> }, capMs = LAUNCH_PID_CAP_MS,
  host: Pick<ProcHost, "platform" | "self" | "readFile"> = PROBE_HOST): Promise<number | undefined> {
  const ask = (async (): Promise<number | undefined> => {
    const cdp = await b.newBrowserCDPSession();
    try {
      const id = (await cdp.send("SystemInfo.getProcessInfo")).processInfo.find((p) => p.type === "browser")?.id;
      if (id === undefined || !Number.isInteger(id) || id <= 1) return undefined;
      return host.platform !== "linux" || parentPid(id, host) === host.self ? id : undefined;
    } finally { cdp.detach().catch(() => undefined); }
  })().catch(() => undefined);
  return Promise.race([ask, sleep(capMs, undefined, { ref: false })]);
}

/** why a --browser-path cannot be launched (not a file, not executable), or null. A macOS .app is a directory:
 *  the binary is inside it. */
export function browserPathError(p: string): string | null {
  let ok = false;
  try { ok = fs.statSync(p).isFile(); if (ok) fs.accessSync(p, fs.constants.X_OK); } catch { ok = false; }
  return ok ? null : `--browser-path ${p} is not an executable file (on macOS pass the binary inside the .app: …/Contents/MacOS/…)`;
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
const selfSha256 = (): string => sha256Hex(fs.readFileSync(SELF));

// what was SERVED. Every same-origin document/script/stylesheet response body is hashed (by path, the
// query dropped: Vite's ?v=/?t= stamps change without the code changing), so two runs against an unchanged
// `vite preview` of a stale dist carry the same assetsSha256 whatever the source tree says.
type ServedBuild = Omit<BuildIdentity, "gitHead" | "gitDirty">;
const BUILD_TYPES = new Set(["document", "script", "stylesheet"]);
/** `unhashed` (LOW a): same-origin bodies left out of assetsSha256 (unread or failed) — recorded when > 0: a partial hash,
 *  which verify-screen never calls the same build as another. */
export function buildFrom(url: string, served: ReadonlyMap<string, string>, viteClient: boolean, unhashed = 0): ServedBuild {
  const lines = [...served].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, h]) => `${p} ${h}`);
  return { url, mode: viteClient ? "vite-dev" : served.size ? "static" : "unknown", assets: served.size, assetsSha256: sha256Hex(lines.join("\n")), ...(unhashed > 0 ? { unhashed } : {}) };
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

// ---------------------------------------------------------------- readiness + navigation
// Injected before any page script, on every navigation: no transitions, no animations, no caret — so what
// is measured and screenshotted is the resting state — and no smooth scrolling (a scroll-behavior:smooth
// box animates every scroll the probe or Playwright makes — scrollTop, scrollTo, scrollIntoView without a behavior; MDN
// scroll-behavior — so a rect read after one would depend on timing; scroll-behavior changes no layout), plus a per-document
// token, which is how a reload (a NEW document) is told apart from a same-document history change.
// The CSS goes in twice — as a <style> (what a page without a CSP sees) and as a constructed sheet in
// document.adoptedStyleSheets from the document's start (a page whose CSP style-src has no 'unsafe-inline' blocks the injected
// <style>; by experiment, Chromium does not block a constructed sheet — CSP3 §6.1.13 gates CSSOM's insertRule / cssText on
// 'unsafe-eval', and MDN notes no browser enforces that). Put back at DOMContentLoaded and load when the page replaced the
// array by then; a page replacing it later drops it (and under such a CSP then has its own transitions).
export const INIT_SCRIPT = `(() => {
  try { Object.defineProperty(window, "__dtProbeDoc", { value: Math.random().toString(36).slice(2), configurable: true }); } catch (e) {}
  const css = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";
  let sheet = null;
  const adopt = () => { try { if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(css); } if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } catch (e) {} };
  adopt();
  const add = () => { adopt(); const s = document.createElement("style"); s.setAttribute("data-dt-probe", ""); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true }); else add();
  addEventListener("load", adopt, { once: true });
})();`;
const QUIET_MS = 500, QUIET_CAP_MS = 10_000, POLL_MS = 100;

/** What a Playwright error during measurement means: the document was replaced (a reload → re-run), the
 *  browser/page is gone (a crash → exit 4, never read as a reload), or something else — a timeout included (the
 *  callers that wait on one ask pwErrorKind). `page` given: a closed page is gone whatever the message says. */
export function errorKind(e: unknown, page?: { isClosed(): boolean }): "gone" | "navigated" | "other" {
  const kind = pwErrorKind(e, page);
  return kind === "timeout" ? "other" : kind;
}

class NavigatedError extends Error {}
/** a reload replaced the document after a click step had changed it in place — the steps' state is gone (the one
 *  re-run replays them; a second time is exit 4 with this step named, not the dev-server hint). */
class StepStateLostError extends NavigatedError {}
class BrowserGoneError extends Error {}
const gone = (e: unknown): BrowserGoneError => new BrowserGoneError(`the page or browser closed or crashed during measurement (${pwFirstLine(e)})`);
class KeptNavigatingError extends Error {}
class UnreachableError extends Error {
  /** the default --ready missed on a page that shows another screen's tagged root (its exit-4 hint is foreignRootHint) */
  readonly foreign: ForeignRoot | null;
  constructor(m: string, foreign: ForeignRoot | null = null) { super(m); this.foreign = foreign; }
}

/** A URL without its fragment (a hash change never makes a new document). */
const docUrl = (u: string): string => { const i = u.indexOf("#"); return i < 0 ? u : u.slice(0, i); };
/** H-a: a main-frame navigation request to ANOTHER document URL than the one the page shows as it is issued is a
 *  navigation; to the same URL it is a reload. (Chromium 153: page.url() when the request is issued is still the current
 *  document's URL, a pushState included — so a reload of a pushed URL is a reload.) */
export function isNavigationAway(requestUrl: string, pageUrl: string): boolean {
  return docUrl(requestUrl) !== docUrl(pageUrl);
}

/** The navigation log of a page (main-frame document LOADS count, framenavigated never does).
 *  navs = loads; gotos = the loads the probe started itself (its goto, a goto step's, a click step's own navigation). */
interface NavLog {
  events: ProbeNavigation["events"];
  navs: number;
  gotos: number;
  t0: number;
  /** the step that owns main-frame navigations right now: a goto step while it loads (any URL: its load is the step's);
   *  a click step from its click until the next goto/click step or the end of the steps — only a navigation that leaves
   *  the page's URL (a same-URL request is a reload, never the click's, even while the click runs); "reload": a click on
   *  a link to the URL the page already shows — while that click runs (Playwright issues the link's own request
   *  before click() resolves) it owns any main-frame navigation request, like a goto step; then it is a "click" again
   *  (a later same-URL load is a reload, a later navigation away still the step's) */
  owner: { kind: "goto" | "click" | "reload" } | null;
  /** a main-frame navigation request was issued since the last load (or since the probe's own goto gave up waiting
   *  for its committed document's load) — a load without one is the CURRENT document's own late load: never a new document,
   *  never a reload that loses the steps' state */
  requested: boolean;
  /** loads a navigation request brought in (navs minus the current documents' own late loads) — what settle() and
   *  the measurement count as "the page navigated" */
  docLoads: number;
  /** the newest main-frame navigation request was a step's own: its load is the probe's, not "after the initial load" */
  pendingOwned: boolean;
  /** the document may hold state a click built in place: the step that clicked (set from the click on; null: a fresh
   *  document — any load clears it) */
  live: string | null;
  /** set when a load no step owned replaced a live document: the steps' state is gone (→ StepStateLostError) */
  lost: string | null;
  /** documents (by token) whose load already timed out in a settle, with that settle's note — later settles on the
   *  same document (the next step's, the final --ready one) do not wait for its load again: the cap is per document */
  loadTimedOut: Map<string, string>;
}

/** The current document's token (INIT_SCRIPT) — null while a navigation has no document to evaluate in. */
async function docTokenOrNull(page: Page): Promise<string | null> {
  try { const v: unknown = await page.evaluate("window.__dtProbeDoc || ''"); return String(v); } catch (e) {
    if (errorKind(e, page) === "gone") throw gone(e);
    if (errorKind(e) === "navigated") return null;
    throw e;
  }
}

/** What settle() found: a note for the measured file (or null), and the token of the document it saw quiet (the
 *  measurement compares against THIS token, so a document that replaced it after settling is never measured as settled). */
interface Settled { note: string | null; token: string | null }

/** A selector's visible matches only (Playwright's `visible=true` engine): a wait on it is met by ANY visible match,
 *  so a hidden first copy (a responsive duplicate) never hides a visible one. */
export const visibleOnly = (sel: string): string => `${sel} >> visible=true`;

/** The default --ready's way out for a screen root that carries no tag: `ids` are the expectation's own node ids (its
 *  first root's nodes and instances), `known` every id it names, `frame` its size (ownTagsOf). Once the frame's tag
 *  misses on a page that shows at least half of them and no other screen's tagged root (screenTagsMet — a shell that
 *  keeps this frame's ids shows a few on every section of the app, so a few are not enough), `seen` is set and
 *  `waitedMs` is how long the frame's tag was waited for: that page is measured as the screen (the root found as an
 *  untagged one), and every later load (the re-run, the driven pages, a new document) waits for the same rule
 *  (waitForScreenTags) instead of the frame's tag. */
export interface UntaggedRoot { ids: string[]; known: string[]; frame: { w: number; h: number } | null; seen: boolean; waitedMs?: number }
/** Whether a page whose frame tag never showed is the screen: it shows at least half of the expectation's own tags. */
export const takesForScreen = (shown: number, total: number): boolean => total > 0 && shown * 2 >= total;
/** The untagged-root rule on what the page shows: at least half of the own tags, and no other screen's tagged root. */
export const screenTagsMet = (s: ScreenTags, total: number): boolean => takesForScreen(s.shown, total) && s.foreign === null;
/** What the page shows of the expectation's tags now (no wait); a page mid-navigation shows none. */
async function screenTagsNow(page: Page, root: UntaggedRoot): Promise<ScreenTags> {
  try { return await page.evaluate(screenTags, { ids: root.ids, known: root.known, frame: root.frame }); } catch (e) {
    if (errorKind(e, page) === "gone") throw gone(e);
    return { shown: 0, foreign: null };
  }
}
/** A wait that ran out, named and worded as Playwright's (pwErrorKind reads it as a timeout). */
class WaitTimeoutError extends Error {
  constructor(what: string, ms: number) { super(`${what}: Timeout ${ms}ms exceeded.`); this.name = "TimeoutError"; }
}
/** The --ready wait of every load after an untagged root was seen: met once the page shows at least half of the
 *  expectation's own tags and no other screen's tagged root (screenTagsMet), polled every POLL_MS; past `timeout` a
 *  TimeoutError, as the frame tag's locator wait would throw. */
async function waitForScreenTags(page: Page, root: UntaggedRoot, timeout: number): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    if (screenTagsMet(await screenTagsNow(page, root), root.ids.length)) return;
    const left = end - Date.now();
    if (left <= 0) throw new WaitTimeoutError("waiting for at least half of the expectation's own tags", timeout);
    await sleep(Math.min(POLL_MS, left));
  }
}
/** The other screen's tagged root that refused a page, if any: only on a page that shows enough of the own tags (fewer
 *  is the reason on its own). */
export const refusingRoot = (s: ScreenTags, total: number): ForeignRoot | null => (takesForScreen(s.shown, total) ? s.foreign : null);
/** The parenthesis of a default --ready miss: what the page showed of the expectation's own tags — fewer than half, else
 *  another screen's tagged root. */
export function screenTagsWhy(s: ScreenTags, total: number): string {
  const f = refusingRoot(s, total);
  if (f !== null) {
    return ` (another screen's tagged root is on the page: a visible element tagged data-dt-node="${f.id}", an id this expectation does not name, ` +
      `${f.by === "size" ? "has the frame's size (±2 px)" : `encloses ${f.encloses} of the ${s.shown} own tags the page shows`})`;
  }
  return ` (the page shows ${s.shown} of the expectation's ${total} own tags — fewer than half)`;
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

/**
 * Wait until the page is ready (its load, fonts, --ready) and its DOM has been quiet for QUIET_MS (≤ 10 s).
 * M-a: a document still loading (a step's navigation committed before settling began) is waited for — its load first —
 * so a quiet but half-loaded document is never taken as settled (past the cap it is measured anyway, with a note).
 * a NEW document — told by the per-document token changing between two quiet polls, or by a main-frame load
 * — is waited for (its load) and settling starts over on it; a load event alone is not enough, because a reloaded
 * document can sit quiet, half-loaded, for longer than the quiet window before its load fires. when that load was a
 * reload replacing a document a click step had changed in place (NavLog.lost), the steps' state is gone →
 * StepStateLostError (the pass is re-run once and the steps replayed); a step's own navigation is settled on.
 * A --ready wait that runs out on a document that stays — after a navigation too (a redirect to a login page or another
 * origin) — is UnreachableError (settleMiss), never "kept navigating"; with `root` (the default --ready) a page that
 * shows at least half of the expectation's own tags and no other screen's tagged root is the screen with an untagged
 * root instead (and, once seen, that rule is what every later settle waits for).
 */
async function settle(page: Page, log: NavLog, ready: string | undefined, timeout: number, root?: UntaggedRoot): Promise<Settled> {
  const cap = Math.min(QUIET_CAP_MS, timeout);
  /** the settle-wide bound on navigation churn: a NEW document after it is "kept navigating" */
  const deadline = Date.now() + cap;
  /** the current document's own bound — at most `cap` per document (its load, --ready, the quiet window), then it
   *  is measured anyway with a note; a new document gets a fresh one */
  let docDeadline = deadline;
  const started = Date.now();
  const navAtStart = log.docLoads;
  let newDocs = 0;
  let loadNote: string | null = null;
  const moved = (): boolean => log.docLoads !== navAtStart || newDocs > 0;
  const kept = (): KeptNavigatingError => new KeptNavigatingError(`the page kept navigating for ${Math.round((Date.now() - started) / 1000)}s${log.navs > 0 ? " after load" : ""} ` +
    `(${Math.max(log.docLoads - navAtStart, newDocs)} navigation(s)) and never settled`);
  const stateLost = (): void => { if (log.lost !== null) throw new StepStateLostError(log.lost); };
  stateLost();
  let token = await docTokenOrNull(page);
  /** a new document replaced the one settling began on: start over on it with its own per-document bound (its load is
   *  waited for at the top of the loop, ≤ the cap, then measured with the note) — or end the pass: lost state, or
   *  ANOTHER new document seen after the settle-wide bound (the page keeps navigating; the first one is seen whenever the
   *  --ready wait ends, which can be after the bound for a navigation made well within it) */
  const newDocument = async (): Promise<void> => {
    newDocs++;
    // a document no step's request made replaced one a click changed in place — lost already at its commit (its load
    // may never come: no load wait decides it)
    if (log.live !== null && !log.pendingOwned && log.lost === null) log.lost = lostState(page.url(), log.live);
    stateLost();
    if (Date.now() >= deadline && newDocs > 1) throw kept();
    docDeadline = Date.now() + cap;
    loadNote = null; // the previous document's
    token = await docTokenOrNull(page);
  };
  /** LOW b: the load note only while the document is still not complete (one that finished since is not "measured anyway") */
  const noteNow = async (tok: string): Promise<string | null> => {
    if (loadNote === null) return null;
    let state: unknown = null;
    try { state = await page.evaluate("document.readyState"); } catch (e) {
      if (errorKind(e, page) === "gone") throw gone(e);
      return loadNote;
    }
    if (state !== "complete") return loadNote;
    if (tok !== "") log.loadTimedOut.delete(tok);
    return null;
  };
  for (;;) {
    /** the wait that threw was the --ready one (not the load or the fonts) */
    let readyWait = false;
    /** how long that wait was given */
    let readyMs = timeout;
    try {
      // M-a: its load first (a document whose load is still pending can be quiet and half drawn)
      // a document whose load already timed out (in this settle or an earlier one) is not waited for again
      // LOW c: an empty token (INIT_SCRIPT could not define one) is never a known document
      const known = token !== null && token !== "" ? log.loadTimedOut.get(token) : undefined;
      // LOW b: a remembered note is attached only while that document is still loading
      const state: unknown = await page.evaluate("document.readyState");
      if (state === "complete") { if (known !== undefined && token !== null) log.loadTimedOut.delete(token); }
      else if (known !== undefined) loadNote = known;
      else {
        try {
          await page.waitForLoadState("load", { timeout: Math.max(1, docDeadline - Date.now()) });
        } catch (e) {
          if (errorKind(e, page) === "gone") throw gone(e);
          if (errorKind(e) === "navigated") throw e;
          loadNote = `the document had not finished loading after ${Math.round(cap / 1000)}s (document.readyState "${String(state)}") — measured anyway`;
          // remembered for THIS document (the token it has now): no later settle waits for its load again
          const now = await docTokenOrNull(page);
          if (now !== null && now !== "" && (token === null || now === token)) {
            token = now;
            log.loadTimedOut.set(now, loadNote);
            // this document (measured anyway) is the current one — its late load is its own, never a reload (a request
            // still pending now brings a new document, caught by the token change in newDocument)
            log.requested = false;
          }
        }
        stateLost();
      }
      await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
      // the full --timeout for a page that has not navigated since load; what is left of the quiet cap otherwise —
      // for any visible match (a hidden first copy does not count); an untagged root seen once: the same rule that took
      // the first page for the screen (at least half of the expectation's own tags, no other screen's tagged root)
      if (ready) {
        readyWait = true;
        readyMs = moved() ? Math.max(1, docDeadline - Date.now()) : timeout;
        if (root?.seen === true) await waitForScreenTags(page, root, readyMs);
        else await page.locator(visibleOnly(ready)).first().waitFor({ state: "visible", timeout: readyMs });
      }
    } catch (e) {
      if (e instanceof StepStateLostError || e instanceof BrowserGoneError) throw e;
      if (errorKind(e, page) === "gone") throw gone(e);
      const now = await docTokenOrNull(page);
      if (now !== null && token !== null && now !== token) { await newDocument(); continue; }
      // the document the wait ran on is still the current one (an empty token tells no documents apart)
      const sameDocument = token !== null && token !== "" && now === token;
      if (token === null && now !== null) token = now;
      const next = settleMiss({ readyWait, navigated: errorKind(e) === "navigated", sameDocument, moved: moved(), pastDocDeadline: Date.now() >= docDeadline });
      if (next === "retry") { await sleep(POLL_MS); continue; }
      if (next === "kept") throw kept();
      // the default --ready's wait ran out (a timeout only — a selector or any other error is not a page to judge) on a
      // page that shows at least half of the expectation's own tags and no other screen's tagged root: the screen, with
      // an untagged root — measured (the root found as an untagged one) and said in a note; else not the screen
      const look = readyWait && root !== undefined && pwErrorKind(e) === "timeout" ? await screenTagsNow(page, root) : null;
      if (root === undefined || look === null || !screenTagsMet(look, root.ids.length)) {
        const why = look === null || root === undefined ? "" : screenTagsWhy(look, root.ids.length);
        throw new UnreachableError(ready ? `--ready '${ready}' never became visible${why}: ${firstLine(e)}` : firstLine(e), look !== null && root !== undefined ? refusingRoot(look, root.ids.length) : null);
      }
      if (!root.seen) root.waitedMs = readyMs;
      root.seen = true;
      // the frame's wait used up this document's window: its quiet window gets one of its own
      docDeadline = Date.now() + cap;
    }
    let mark = log.docLoads;
    let last = "", since = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      let tok: string, sig: string;
      try {
        const v: unknown = await page.evaluate("[window.__dtProbeDoc || '', document.getElementsByTagName('*').length + ':' + (document.body && document.body.textContent || '').length]");
        if (!Array.isArray(v)) throw new Error("the page returned no settle signature");
        tok = String(v[0]); sig = String(v[1]);
      } catch (e) {
        if (errorKind(e, page) === "gone") throw gone(e);
        if (errorKind(e) !== "navigated") throw e;
        if (Date.now() >= docDeadline) throw kept();
        continue;
      }
      if (token === null) token = tok;
      // a load with the token unchanged is this document's own late load event (no token to tell by: count it as new)
      if (tok !== token || (log.docLoads !== mark && tok === "")) { await newDocument(); break; } // restart: load, fonts, --ready, a fresh quiet window
      stateLost();
      mark = log.docLoads;
      if (sig !== last) { last = sig; since = Date.now(); }
      if (Date.now() - since >= QUIET_MS) return { note: await noteNow(tok), token: tok };
      if (Date.now() >= docDeadline) {
        // a new document had its own full window (per document); a navigation that never made one never settled
        if (moved() && newDocs === 0) throw kept();
        return { note: (await noteNow(tok)) ?? `the DOM was still changing after ${Math.round(cap / 1000)}s${newDocs ? " on the document a navigation loaded" : " (no navigation)"} — measured anyway`, token: tok };
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
  /** replayed after every load, before --ready is waited for */
  steps?: ProbeStep[];
  /** with the default --ready (the frame's tag): the expectation's own tags, for a screen whose root is untagged */
  untaggedRoot?: UntaggedRoot;
}

// ---------------------------------------------------------------- reaching the screen (goto, --steps, --ready)
const STEP_WAIT_CAP_MS = 5_000;

/** The visible element a step's selector names, waiting ≤ min(--timeout, 5 s): a click needs EXACTLY one (it must be
 *  unambiguous what was clicked); a waitFor is met by one or more (e.g. "the list has rows"). Returns the first's index. */
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
      const kind = errorKind(e, page);
      if (kind === "gone") throw gone(e);
      if (kind === "other") throw new StepError(`${name}: ${firstLine(e)}`);
    }
    if (Date.now() >= deadline) {
      throw new StepError(`${name} matched ${last.visible} visible element(s)${last.all !== last.visible ? ` (${last.all} in the document)` : ""} after ${Math.round(wait / 1000)}s — ` +
        `${atLeastOne ? "a waitFor needs at least one" : "a click needs exactly one"}`);
    }
    await sleep(POLL_MS);
  }
}

/** In the page (Locator.evaluate): the absolute URL a click on this element follows in the main frame — its own href or
 *  its closest a[href]'s — or null: another tab/window (its target, or the document's <base target>), a download, an SVG
 *  <a> (its href is not a string). _top / _parent are the main frame here (steps run in it). SELF-CONTAINED. */
export interface LinkElement {
  closest(selector: string): { href?: unknown; target?: unknown; hasAttribute(name: string): boolean } | null;
  ownerDocument: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
}
export function linkHref(el: LinkElement): string | null {
  const a = el.closest("a[href], area[href]");
  if (a === null || typeof a.href !== "string" || a.hasAttribute("download")) return null;
  const own = typeof a.target === "string" ? a.target : "";
  const base = el.ownerDocument.querySelector("base[target]");
  const target = (own || (base ? base.getAttribute("target") || "" : "")).toLowerCase();
  if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") return null;
  return a.href;
}

/** the probe's OWN load (the --url goto, a goto step): waited for up to --timeout. Past it a document
 *  that committed (its response arrived) is measured anyway — the "had not finished loading" note, remembered for that
 *  document (log.loadTimedOut: no settle waits for it again) and its load, when it comes, is its own late load; one that
 *  never answered rethrows (the caller's "could not load"). An interrupting navigation is left to the settle. */
async function ownGoto(page: Page, log: NavLog, url: string, timeout: number): Promise<void> {
  let committed = false;
  const onResponse = (r: Response): void => {
    try {
      const st = r.status();
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame() && (st < 300 || st >= 400)) committed = true;
    } catch { /* a service worker's response has no frame */ }
  };
  // committed = the NEWEST main-frame navigation was answered — a page that arrives, then (before its load) goes on
  // to a server that never answers is "could not load", not measured (its evaluates would wait on that request for good)
  // a newest navigation the browser cancelled (net::ERR_ABORTED — the page's own `location.href = …; window.stop()`)
  // brought no new document: the one before it (committed or not) is still the page — restore its state. A 204 or a
  // download commits (response < 300) and then fails ERR_ABORTED, so it goes back to the state before it: no document.
  let newest: Request | null = null;
  let before = false;
  const onRequest = (r: Request): void => {
    try {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame() && r.redirectedFrom() === null) { newest = r; before = committed; committed = false; }
    } catch { /* no frame */ }
  };
  const onFailed = (r: Request): void => {
    // a cancelled navigation that was redirected fails on its LAST hop: compare the chain's first request
    let root: Request = r;
    for (let up = root.redirectedFrom(); up !== null; up = up.redirectedFrom()) root = up;
    if (root === newest && /net::ERR_ABORTED/.test(r.failure()?.errorText ?? "")) committed = before;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  try {
    await page.goto(url, { waitUntil: "load", timeout });
  } catch (e) {
    if (errorKind(e, page) === "gone") throw gone(e);
    if (/interrupted by another navigation/i.test(errMsg(e))) return;
    if (!committed || pwErrorKind(e) !== "timeout") throw e;
    let state: unknown = "unknown";
    try { state = await page.evaluate("document.readyState"); } catch { /* the settle reads it again */ }
    // what happened — the goto stopped waiting (the document measured may have arrived later in a chain); the
    // note is dropped again by the settle once that document is complete (it was then measured fully loaded)
    const note = `the page had not finished loading when the goto gave up after ${Math.round(timeout / 1000)}s (document.readyState "${String(state)}") — measured anyway`;
    const tok = await docTokenOrNull(page);
    if (tok !== null && tok !== "") log.loadTimedOut.set(tok, note);
    log.requested = false; // its committed document is the current one: its late load is its own
  } finally {
    page.off("response", onResponse);
    page.off("request", onRequest);
    page.off("requestfailed", onFailed);
  }
}

/** a plain-language cause for a failed load (Playwright's first line otherwise). A 204 and a download both end
 *  net::ERR_ABORTED as a request; only the goto's thrown message tells them apart ("Download is starting"). */
export function loadFailureWhy(message: string): string {
  const first = message.split("\n")[0] ?? "";
  if (/Download is starting/i.test(first)) return "the URL started a file download, not a page — point it at the page that renders the screen";
  if (/net::ERR_ABORTED/.test(first)) {
    return "the browser cancelled the navigation before any page arrived (net::ERR_ABORTED) — the URL answered with no document (e.g. 204 No Content) or the page stopped its own load; " +
      "point it at the page that renders the screen";
  }
  return first;
}

/** Replay the steps (each settles after it). Which loads are the steps' own (added to log.gotos, never "after the initial
 *  load") is judged per navigation request (attachNavLog): a goto step's load; a click step's navigation — one that goes
 *  to another URL than the page shows, issued while the click runs or LATER (an app that awaits a request, then sets
 *  location), until the next goto/click step or the end of the steps (a same-URL request never, not even one the
 *  click's handler issues at once). Any other load is the page's own and
 *  counts; a reload (same URL) that replaces a document a click changed in place loses that state → StepStateLostError,
 *  the one re-run, which replays the steps. */
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
        // its load up to --timeout; a committed document that never finishes loading is measured with the note
        await ownGoto(page, log, target.href, o.timeout);
      } catch (e) {
        if (e instanceof BrowserGoneError) throw e;
        throw new StepError(`${name} could not load ${target.href}: ${loadFailureWhy(errMsg(e))}`);
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
          // where Playwright will click — it scrolls the element into view first, then clicks the middle of what shows
          await loc.scrollIntoViewIfNeeded({ timeout: wait }).catch(() => undefined);
          const submits = await loc.evaluate(submitGuard, undefined, { timeout: wait });
          if (submits !== null) throw new StepError(`${name} would submit a form (${submits}) — a step must navigate, never submit`);
          // a link (the element or its closest a[href]) to the document the page already shows is a refresh step — its
          // load is the step's own, like a goto's (a URL-tab link to the tab --url shows): it owns the navigation requests
          // issued while the click runs (only then)
          const href = await loc.evaluate(linkHref, undefined, { timeout: wait });
          const refresh = href !== null && !href.includes("#") && docUrl(href) === docUrl(page.url());
          // its navigations to ANOTHER URL are its own from here on, however late; from the click on, the document
          // may hold what the click builds in place, so a reload (a same-URL load, never the click's — even one its handler
          // starts at once: `draw(); location.reload()`) loses that state; the click's own navigation clears it on load (a
          // refresh link's too; one an app intercepts in place keeps it)
          log.owner = { kind: refresh ? "reload" : "click" };
          log.live = name;
          try {
            await loc.click({ timeout: wait });
          } finally {
            log.owner = { kind: "click" }; // a later same-URL load is a reload; a later navigation away the step's
          }
        } catch (e) {
          if (e instanceof StepError) throw e;
          const kind = errorKind(e, page);
          if (kind === "gone") throw gone(e);
          // a click that started a document load is a step's navigation (settled below); anything else failed the step
          if (kind === "other") throw new StepError(`${name} could not be clicked: ${firstLine(e)}`);
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
  // a fresh start (the re-run reuses the log): no step owns anything, the document holds no step's state
  log.owner = null; log.pendingOwned = false; log.live = null; log.lost = null;
  log.gotos++;
  try {
    // its load up to --timeout (the settles then start on a loaded document: its own load never reads as "moved");
    // a committed document that never finishes loading is measured with the note, not "could not load"
    await ownGoto(page, log, o.url, o.timeout);
  } catch (e) {
    if (e instanceof BrowserGoneError) throw e;
    throw new UnreachableError(`could not load ${o.url}: ${loadFailureWhy(errMsg(e))}`);
  }
  const steps = o.steps || [];
  if (!steps.length) return settle(page, log, o.ready, o.timeout, o.untaggedRoot);
  try {
    await settle(page, log, undefined, o.timeout);
    await runSteps(page, log, o);
    // the last click still owns its late navigation while --ready is waited for
    const last = await settle(page, log, o.ready, o.timeout, o.untaggedRoot);
    if (log.lost !== null) throw new StepStateLostError(log.lost);
    // LOW b: the last settle's note only — the first one's may be about a document the steps replaced, or one that has
    // finished loading since (the last settle re-checks that document's readyState)
    return { note: last.note, token: last.token };
  } finally {
    log.owner = null; // measuring: no load is the steps' own from here
  }
}

const lostState = (url: string, live: string): string => `the page reloaded (${docUrl(url)} again, not a navigation) after ${live} had changed it in place — the steps' state is gone`;

/** The navigation log of a page: main-frame document loads; framenavigated is logged, never counted;
 *  each main-frame navigation request is judged as it is issued — a step's own (NavLog.owner) or not — and its load
 *  credited accordingly; a load no step owned that replaces a document a click changed in place sets `lost`. */
function attachNavLog(page: Page): NavLog {
  const log: NavLog = { events: [], navs: 0, gotos: 0, t0: Date.now(), owner: null, pendingOwned: false, live: null, lost: null, loadTimedOut: new Map(), requested: false, docLoads: 0 };
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) log.events.push({ type: "framenavigated", url: f.url(), at: Date.now() - log.t0 }); });
  page.on("request", (r) => {
    try {
      if (!r.isNavigationRequest() || r.frame() !== page.mainFrame() || r.redirectedFrom() !== null) return;
      const o = log.owner;
      log.requested = true;
      log.pendingOwned = o !== null && (o.kind !== "click" || isNavigationAway(r.url(), page.url()));
    } catch { /* a service worker's request has no frame */ }
  });
  page.on("load", () => {
    log.navs++;
    const url = page.url();
    // no navigation request since the last load — the current document's own late load (measured "anyway" before
    // it): no new document, nothing the steps built is lost
    const fresh = log.requested;
    log.requested = false;
    if (fresh) log.docLoads++;
    if (log.pendingOwned) log.gotos++;
    else if (fresh && log.live !== null && log.lost === null) log.lost = lostState(url, log.live);
    log.events.push({ type: "load", url, at: Date.now() - log.t0 });
    log.pendingOwned = false;
    if (fresh) log.live = null; // a fresh document
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
  /** the page's horizontal overflow, read in this pass */
  page: PageOverflow;
  /** where the page was when it was measured (after the steps) */
  url: string;
  /** the data-dt-node ids on a visible element with a box at rest (outside closed dialogs) — the fingerprint the
   *  behaviour units' pages are compared with; never written to the measured file */
  visibleTags: string[];
}

/** every data-dt-node on a VISIBLE element that names no expected spec/instance/hidden id and no frame —
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
    // LOW c: an empty token ("" — the init script defined none) is shared by every document: a load decides then
    const navsAtReach = log.docLoads;
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
    // one element, one spec (five rows' identical dates all landed on one cell)
    const claimed = claimOnce(matches.map(({ m }) => m));
    matches.forEach((x, i) => { const c = claimed[i]; if (c) x.m = c; });
    const item = (spec: VerifySpec, m: Match): MeasureItem =>
      ({ nodeId: spec.nodeId, path: m.path, isText: spec.type === "TEXT", isPaint: isPaintSpec(spec), isPlaceholder: spec.placeholder === true, sharesWith: m.sharesWith ?? null,
      ...(typeof spec.backgroundColor === "string" ? { backgroundSpec: true } : {}) });
    const frameOf = (spec: VerifySpec): ResolvedFrame | null | undefined => frames.get(spec.frameId ?? frameIn[0]?.nodeId ?? "");
    const frameRectOf = (spec: VerifySpec): Rect => { const f = frameOf(spec); return f ? f.rect : { x: 0, y: 0, w: o.viewport.w, h: o.viewport.h }; };
    const measureIn = (spec: VerifySpec, items: MeasureItem[]): MeasureInput => ({ frameRect: frameRectOf(spec), framePath: frameOf(spec)?.path ?? null, keys: STYLE_KEYS, items });

    // measure, one evaluate per frame (x/y/textBox are relative to that frame's root)
    const nodes = new Map<string, MeasuredNode>();
    const byFrame = new Map<string, Array<{ spec: VerifySpec; m: Match }>>();
    for (const { spec, m } of matches) if (isMatch(m)) { const k = spec.frameId ?? ""; byFrame.set(k, [...(byFrame.get(k) || []), { spec, m }]); }
    for (const group of byFrame.values()) {
      const first = group[0];
      if (!first) continue;
      const raw = await page.evaluate(measureElements, measureIn(first.spec, group.map(({ spec, m }) => item(spec, m))));
      group.forEach(({ spec, m }, i) => { const r = raw[i]; if (r) nodes.set(spec.nodeId, shapeNode(spec, m, r, STYLE_KEYS)); });
    }

    const stateNotes = new Set<string>();
    // a minimal hover / focus for specs drawn in that state (pressed stays with the agent)
    for (const { spec, m } of matches) {
      const node = nodes.get(spec.nodeId);
      const state = spec.drawnState;
      if (!node || !isMatch(m) || (state !== "hover" && state !== "focus")) continue;
      const own = m.hoverVia ?? hoverTarget(m.cand, pool.byTag) ?? m.path;
      let focusPath: string | null = null;
      try {
        if (state === "hover") {
          await page.mouse.move(0, 0);
          const via = await hoverDrawnState(page, spec, m, own, pool.byTag);
          if (via.hovered !== m.path) node.hoverVia = via.hovered;
          if (via.note !== null) node.note = node.note ? `${node.note}; ${via.note}` : via.note;
        } else {
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
        const [r] = await page.evaluate(measureElements, measureIn(spec, [item(spec, m)]));
        if (r) {
          // nulls stay (with their reasons): a value the probe could not read in the state is not the resting one
          const shaped = shapeNode(spec, m, r, STYLE_KEYS);
          node.states = { [state]: { styles: shaped.styles || {}, ...(shaped.unmeasured ? { unmeasured: shaped.unmeasured } : {}) } };
        }
      } catch (e) {
        if (errorKind(e, page) !== "other") throw e;
        node.note = `${state} state not measured: ${firstLine(e)}`;
      } finally {
        if (state === "hover") await page.mouse.move(0, 0).catch(() => undefined);
        else if (focusPath !== null) await page.locator(focusPath).first().blur({ timeout: 2000 }).catch(() => undefined);
      }
    }
    if (matches.some(({ spec }) => spec.drawnState === "hover")) await raf2(page);

    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    // the page's sideways overflow at this viewport — before the token check, so a reload re-runs it too
    const { compatMode, ...overflow } = await page.evaluate(readPageOverflow, null);
    const pageOverflow: PageOverflow = { ...overflow, compatMode };
    const tokenNow = await docToken(page);
    if (tokenNow !== token || (token === "" && log.docLoads !== navsAtReach)) throw new NavigatedError("the page loaded a new document during measurement");
    if (compatMode !== "CSS1Compat") stateNotes.add(`the page renders in quirks mode (document.compatMode ${compatMode}: no <!doctype html>) — ` +
      `its layout and page overflow measure differently from a standards-mode build`);

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
      visibleTags: [...new Set(collected.tagged.flatMap((c) => (c.dt !== null && c.flags.box && c.flags.visible && !c.flags.inClosedDialog ? [c.dt] : [])))],
    };
  } catch (e) {
    if (e instanceof NavigatedError || e instanceof UnreachableError || e instanceof BrowserGoneError || e instanceof StepError) throw e;
    if (errorKind(e, page) === "gone") throw gone(e);
    if (errorKind(e) === "navigated") throw new NavigatedError(firstLine(e));
    throw e;
  }
}

/** hover for a drawn hover state. A spec whose state is its owner's (drawnStateFrom — a control in a row drawn
 *  hovered) hovers the OWNER's tagged element at a free point (outside the control, not over another control — freeHoverPoint),
 *  so the row's :hover is on and the control's own is not; no free point, or no tagged owner → the element itself
 *  (`own`), with a note. Returns the path hovered. */
async function hoverDrawnState(page: Page, spec: VerifySpec, m: Match, own: string, byTag: Map<string, Candidate[]>): Promise<{ hovered: string; note: string | null }> {
  const oh = ownerHover(spec, m, byTag);
  let note: string | null = null;
  if (oh.kind === "untagged") note = `hovered the element itself: its drawn-hovered container ${oh.owner} has no visible tagged element (tag it with data-dt-node="${oh.owner}")`;
  if (oh.kind === "owner") {
    // the owner's element first, then the other tagged candidates below it — a same-box wrapper has no free point
    const tried: string[] = [];
    let covered: string | null = null;
    for (const c of [{ id: oh.id, path: oh.path }, ...oh.next]) {
      const loc = page.locator(c.path).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      const position = await page.evaluate(freeHoverPoint, { owner: c.path, avoid: m.path });
      tried.push(c.id);
      if (position === null) continue;
      // a covered point is retried until the timeout — elementFromPoint said it is free, so a short one
      try { await loc.hover({ position, timeout: 1000 }); return { hovered: c.path, note: null }; } catch (e) {
        if (errorKind(e, page) !== "other") throw e;
        covered ??= `the free point on ${c.id} was covered (${firstLine(e)})`;
        await page.mouse.move(0, 0);
      }
    }
    const on = `its drawn-hovered container ${tried[0]}${tried.length > 1 ? ` (nor on ${tried.slice(1).join(", ")})` : ""}`;
    note = covered !== null ? `hovered the element itself: no usable free point on ${on} — ${covered}` : `hovered the element itself: no free point on ${on}`;
  }
  await page.locator(own).first().hover({ timeout: 2000 });
  return { hovered: own, note };
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

/** Build identity: one same-origin response body being read. */
interface BodyRead { path: string; state: "pending" | "hashed" | "no body" | "failed"; done: Promise<unknown> }
/** how long the end of a pass waits for its response bodies (each normally lands within milliseconds). */
export const BODY_WAIT_MS = 2_000;
/** Wait ≤ BODY_WAIT_MS for this pass's bodies; a note naming the paths left out of assetsSha256 (unread or failed, and
 *  not hashed from another response of the same path), or null. */
async function bodiesRead(reads: readonly BodyRead[], served: ReadonlyMap<string, string>): Promise<{ note: string; unhashed: number } | null> {
  await Promise.race([Promise.allSettled(reads.map((r) => r.done)), sleep(BODY_WAIT_MS, undefined, { ref: false })]);
  const missed = new Map<string, string>();
  for (const r of reads) {
    if (served.has(r.path) || (r.state !== "pending" && r.state !== "failed")) continue;
    missed.set(r.path, r.state === "failed" ? "the request failed" : `not received within ${BODY_WAIT_MS / 1000} s — a load cut short by another navigation`);
  }
  if (!missed.size) return null;
  const list = [...missed].slice(0, 5).map(([p, why]) => `${p} (${why})`).join(", ");
  return { note: `build identity: ${missed.size} same-origin response body(ies) not hashed — ${list}${missed.size > 5 ? ", …" : ""}; measured.build.assetsSha256 leaves them out (build.unhashed)`,
    unhashed: missed.size };
}

/** Measure with one automatic full re-run after a reload; a second one is exit 4. */
export async function runProbe(browser: Browser, o: ProbeOptions): Promise<ProbeRun> {
  const context = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  // every Playwright action waits at most --timeout (the default is 30 s, but only for some calls)
  page.setDefaultTimeout(o.timeout);
  await page.addInitScript({ content: INIT_SCRIPT });
  // same-origin responses of the current pass (a re-run starts a new generation)
  let origin = "";
  try { origin = new URL(o.url).origin; } catch { /* goto reports the bad url */ }
  const served = new Map<string, string>();
  // the bodies of THIS pass only (a re-run starts a new list). In Playwright the body of a response whose headers
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
    const body = res.body().then((b) => { if (g === gen) served.set(u.pathname, sha256Hex(b)); read.state = "hashed"; }, () => { read.state = "no body"; }); // a redirect has no body
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
        if (unread !== null) result.notes.push(unread.note);
        // the re-run reloads in the SAME context — session/local storage set by the first pass stays
        if (reruns && o.steps && o.steps.length) result.notes.push("the re-run replayed the steps in the same browser context (session and local storage from the first pass kept)");
        return { kind: "ok", result, navigation: nav(reruns), consoleErrors, build: buildFrom(o.url, served, viteClient, unread !== null ? unread.unhashed : 0) };
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

/** What the probe keeps of a drive: its evidence, or — when the browser stopped answering — none, a note, and
 *  wedged (no visual capture or behaviour; the browser is killed at once). */
export function driveOutcome(r: DriveResult): { driven: InteractionEvidence[] | null; driveNote: string | null; wedged: boolean } {
  if (r.wedged) return { driven: null, driveNote: "driving the interactions did not finish within its budget (the browser stopped answering) — none recorded", wedged: true };
  return { driven: r.evidence, driveNote: null, wedged: false };
}

/** The probe's one-line behaviour summary (stderr) — never the verdict. */
export function behaviourLine(b: MeasuredBehaviour): string {
  if (!b.ran) return `behaviour not run (${b.why})`;
  const n = (st: string): number => b.checks.filter((c) => c.status === st).length;
  return `behaviour (not the fidelity verdict) ${n("fail")} fail · ${n("warn")} warn · ${n("pass")} pass · ${n("not-run")} not run${n("unsupported") ? ` · ${n("unsupported")} unsupported` : ""}` +
    ` · axe ${b.axe.ran ? `axe-core ${b.axe.version}` : `not run (${b.axe.why})`} · ${Math.round(b.elapsedMs / 1000)}s of ${Math.round(b.budgetMs / 1000)}s${b.cut ? " — CUT by the time budget" : ""}` +
    (b.artifacts.length ? ` · ${b.artifacts.join(", ")}` : "");
}

// ---------------------------------------------------------------- CLI
/** The test-only switch that lets --behaviour off through: a run without the behaviour checks is no verification. */
export const BEHAVIOUR_OFF_ENV = "DESIGNTWIN_TEST_BEHAVIOUR_OFF";
const USAGE =
  "usage:\n" +
  `  ${scriptCmd("verify-probe")} --expected design/verify/<Screen>.expected.json --url <url> [--out design/verify/<Screen>]\n` +
  "      [--ready <selector> | none] [--viewport WxH] [--project <dir>] [--position] [--timeout <ms>] [--run <id>] [--max-time <ms>]\n" +
  "      [--steps <steps.json | plan.json>] [--behaviour on|off] [--browser-path <executable>]\n" +
  "      renders <url> in the PROJECT's Playwright (chromium), matches every expectation row (tag → shared path → alias →\n" +
  "      text → text-ordinal → --position), and writes <out>.measured.json + <out>.png for verify-screen --compare.\n" +
  "      --out defaults to the .expected.json path minus `.expected`; --viewport to the frame's w×h; --project to cwd.\n" +
  "      Every measurement belongs to a run, and measured.runId names it. --run <id> (from verify-screen --status … --new-run):\n" +
  "      that run. Without --run the probe starts a run of its own (`run <id>` on stderr) and ends it — `done` with the files\n" +
  "      (published as <Screen>.status.json beside the expectation), `failed` on an exit 3/4 (a re-run is a new run); refused\n" +
  "      before anything starts (exit 2) while another run of the screen is open — a verifier's writes the same files: wait for\n" +
  "      it, or end one nobody runs any more. Every other non-zero exit, an error or SIGINT/SIGTERM/SIGHUP (exit 128+n) ends\n" +
  "      its own run `failed`. One left at measuring — a SIGKILL, or an exit whose last status write was refused — names the\n" +
  "      probe's pid and host and a deadline (start + --max-time + 120 s): the next probe without --run ends it `failed` once\n" +
  "      that pid is gone (same machine) or, on any host, the deadline has passed, and goes on; before the deadline it refuses\n" +
  "      when it cannot tell (another host, or the pid runs). A probe that finds its own run replaced by such a later one\n" +
  "      (it was stopped or slept past its deadline) writes nothing more (exit 2; 128+n after a stop signal, 1 after an\n" +
  "      error). The probe writes the run's LIVE status (the run cache,\n" +
  "      node_modules/.cache/designtwin-verify/<Screen>.status.json — never the project tree a dev server watches) — `measuring`\n" +
  "      before the browser starts, `measured` (its own run: `done`) + the measured file's sha256 after it is closed. With --run an\n" +
  "      exit 3/4 is a failed attempt the status counts (probeFailures): the first leaves the run at measuring for one re-run\n" +
  "      (after an exit 3, once the user has fixed the renderer), the second ends the run `failed` — the probe writes it (a\n" +
  "      `status run <id> …` line on stderr says which; an attempt the run cache would not count says how to end the run). A --run that\n" +
  "      already ended (done/failed/blocked) is refused before anything starts, and a run that\n" +
  "      ends (or, its own run, another run that opens or replaces it) while the page is measured gets no files (exit 2 both ways).\n" +
  "      --max-time bounds the whole run (default 180000 ms, at most 2147483647): past it the browser is closed and nothing is written (exit 4).\n" +
  "      --ready: after every page load (and the steps) the probe waits for this selector to be visible before measuring —\n" +
  "      by default the frame's tag [data-dt-node=\"<frame id>\"] (expectation.frame.nodeId), so a page that is not the screen\n" +
  "      (a login redirect, another section) is an exit 4, never measured — unless it shows at least half of the expectation's own\n" +
  "      tags and no other screen's tagged root: then the root is untagged and the page is measured, with a note (later loads\n" +
  "      wait for the same); --ready none waits for nothing. With no frame\n" +
  "      id in the expectation, or a --steps plan with tagging.off, there is no default (a note says so). Not visible within\n" +
  "      --timeout → exit 4.\n" +
  "      --steps: a JSON list of steps (or a plan whose `navigate` holds them; a plan with none is no steps — a note says so)\n" +
  "      replayed after every page load, before --ready,\n" +
  "      to reach a screen that is a section of the app (not a URL): {\"click\": \"<selector>\"} | {\"waitFor\": \"<selector>\"} |\n" +
  "      {\"goto\": \"/same-origin/path\"}. A click's selector must match exactly one visible element (a waitFor's at least one);\n" +
  "      a click never submits a form. A click's navigation to another URL is the step's own, however late; a reload after a\n" +
  "      click changed the page in place re-runs the pass once (twice: exit 4); a click on a link to the URL the page shows is\n" +
  "      a refresh (its load is the step's own). A step that fails while measuring is exit 4\n" +
  "      (nothing written). Recorded as measured.reach.\n" +
  "      After measuring, the expectation's overlay interactions (on_click/on_press overlay/swap, plan expect:\"dialog\") are\n" +
  "      driven, each on a fresh page: measured.interactions (evidence; ok:true or ok:null, never false).\n" +
  "      Then the behaviour/accessibility checks run, each unit on a fresh page within min(90 s, what --max-time leaves less\n" +
  "      20 s): landmarks, axe-core (when the project has it), a Tab walk (reachable, visible focus, names), forced colours,\n" +
  "      1024/320 px widths, and the keyboard/scroll battery on modal overlays — measured.behaviour (+ <out>.forced-colors.png),\n" +
  "      never the fidelity verdict and never an exit 4. --behaviour off skips them (measured.behaviour says so) — for the\n" +
  `      probe's own tests only: it needs ${BEHAVIOUR_OFF_ENV}=1 in the environment, else exit 2.\n` +
  "      Before them, when the expectation carries a usable referenceImage (--expect), the frame is captured once more at the\n" +
  "      reference's scale and diffed against the Figma reference after the browser closes: measured.visual + <out>.diff.png\n" +
  "      (informational — never the verdict, never an exit 4; not skipped by --behaviour off). Its design/export/… PNG is read\n" +
  "      from the project that owns the expectation (the folder above design/verify/), else from --project.\n" +
  "      --browser-path: launch this Chromium executable instead of the one Playwright installed (a cached browser) — only\n" +
  "      guaranteed with the bundled Chromium; on macOS the binary inside the .app (…/Contents/MacOS/…). Not an executable\n" +
  "      file → exit 3. measured.probe.browser.executable says \"custom\"; the path is printed, never written to a file.\n" +
  `  ${scriptCmd("verify-probe")} --check [--project <dir>] [--browser-path <executable>]\n` +
  "      resolves the project's Playwright and launches chromium once — nothing measured, nothing written.\n" +
  "exit: 0 wrote · 2 usage, or (--run) the run already ended / ended while the probe ran, or (no --run) another run of the\n" +
  "      screen is open, or replaced its own — also instead of a 3 or 4 · 3\n" +
  "      renderer unavailable (ask the user to install; never installed here; with --run, re-run once in the run after they\n" +
  "      do) · 4 the page kept navigating / reloaded twice\n" +
  "      during measurement / was unreachable / timed out / passed --max-time / a --steps step failed /\n" +
  "      the page or browser closed or crashed (re-run once; if it recurs, run --check) (nothing written; with --run the\n" +
  "      second failed attempt has ended the run `failed`).";

const MAX_TIME_DEFAULT = 180_000;
/** The largest --max-time: setTimeout's own bound (a 32-bit signed delay; a longer one fires at once). */
const MAX_TIME_LIMIT = 2_147_483_647;
/** What its own run's deadline allows past --max-time — the steps after the watchdog that are bounded, with room to
 *  spare: closing a browser that does not yield (closeCapped: two CLOSE_STEP_CAP_MS steps + the kill within KILL_STEP_CAP_MS, ~13 s),
 *  the git state (2 s + 5 s), two status-lock waits (the `measuring`/`done` writes, 15 s each), and the visual diff in
 *  Node. Past it the next probe without --run takes the run for abandoned; this probe's later writes then find the
 *  status naming the run that replaced it, and write nothing (RunReplaced). */
const OWN_RUN_GRACE_MS = 120_000;

/** Close the browser even when a page never yields: browser.close() closes each page first, and a page whose script never
 *  yields does not close — so ask the browser PROCESS to quit (CDP Browser.close, Chromium), then close the handle; each
 *  step capped at CLOSE_STEP_CAP_MS (unref'd caps: a pending cap must not keep the process alive once the browser is gone).
 *  Then the browser is ended with what it started if it is still running (killBrowser) — a wedged one (it answers nothing,
 *  still connected), and on POSIX one that is merely slow to go: after Browser.close the handle is disconnected at once, but
 *  under load the process can take seconds to minutes to exit, and this process waits on its pipes past --max-time. The probe
 *  launched it and the browser was told to quit, so no page can be live after that and measured.json may be written.
 *  On Windows `exited` (killBrowser) is: the close resolved, or the browser reads disconnected (its CDP pipe has closed). Then
 *  no taskkill runs here: the exit has happened, so the pid may already be another process's and taskkill /T would end that
 *  one's tree, or the pid is still held by this process and the browser is only slow to go, which is left to Playwright's own
 *  kill (exitWhenDone ends the process, and Playwright's exit hook runs taskkill for a browser it has not seen close). Neither
 *  a resolved close nor a disconnect proves the process exited (the pipe can close first; a close after the dispatcher is
 *  gone resolves on the disconnect alone). A close that hits its cap can follow an exit (Playwright's cleanup after the
 *  process closes, e.g. a profile directory it cannot remove, takes seconds): the disconnect covers it. A wedged browser stays
 *  connected and keeps its taskkill; so does one whose close rejects while connected. What remains is a still-connected
 *  browser that exits between that check and the taskkill.
 *  `pid` is the browser's (launchPid, recorded at launch); `host` is for the tests. */
export async function closeCapped(b: Pick<Browser, "newBrowserCDPSession" | "close" | "isConnected">, capMs = CLOSE_STEP_CAP_MS, pid: number | undefined = launchPids.get(b),
  host: ProcHost = PROBE_HOST): Promise<void> {
  const cap = (): Promise<false> => sleep(capMs, false, { ref: false });
  await Promise.race([b.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => undefined), cap()]);
  const closed = await Promise.race([b.close().then(() => true, () => false), cap()]);
  await killBrowser(pid, host, KILL_GRACE_MS, closed || !b.isConnected());
}
/** How long the kill waits for the browser to go on its own before it is killed. */
const KILL_GRACE_MS = 1_000;
/** The cap on the kill's one command: the wait and the command together fit in KILL_STEP_CAP_MS. */
const KILL_CMD_CAP_MS = KILL_STEP_CAP_MS - KILL_GRACE_MS;
/** The host the probe's kill runs on: the real one, its taskkill capped like its pgrep/ps. */
const PROBE_HOST: ProcHost = { ...PROC_HOST, taskkill: taskkillCapped(KILL_CMD_CAP_MS) };
/** End the browser this process launched and what it started — the last step of closeCapped, best-effort, never throws, by
 *  pid only (never by name: never the user's own browser). It first waits up to `graceMs` (KILL_GRACE_MS; 0 for a browser
 *  that stopped answering) for the browser to go on its own. The browser's pid known (launchPid): POSIX SIGKILLs its process
 *  group (Playwright spawns it detached, so it leads one; that also reaches descendants the browser left after it exited),
 *  no command run; Windows runs `taskkill /T /F /PID` (hidden) while that pid exists, and not at all when `exited` (the
 *  close resolved or the browser is disconnected: it may have exited and its pid be another process's by now — see
 *  killChildTree). Unknown: each direct
 *  child of this process is ended — its only children are its browsers (its other commands are synchronous) — found by a
 *  /proc scan (Linux) or `pgrep -P` (else `ps` when pgrep is missing); Windows then leaves the browser to Playwright's exit
 *  hook (exitWhenDone). The wait and at most one command (pgrep, ps or taskkill, capped at KILL_CMD_CAP_MS) fit in
 *  KILL_STEP_CAP_MS, which the behaviour reserve includes. */
async function killBrowser(pid: number | undefined, host: ProcHost = PROBE_HOST, graceMs = KILL_GRACE_MS, exited = false): Promise<void> {
  await killChildTree(pid, host, { capMs: KILL_CMD_CAP_MS, graceMs, exited }).catch(() => undefined);
}

/** Why a status write was refused: the run cache refused it, another status write held the lock for the whole wait,
 *  or the lock was taken over from this write (it held it past the stale age). */
export type StatusRefusal = "cache" | "busy" | "lost";
export const statusRefusalOf = (e: RunCacheUnwritable | LockBusy): StatusRefusal => e instanceof LockLost ? "lost" : e instanceof LockBusy ? "busy" : "cache";
/** The closing warning's account of a refused `measured` status write of run `runId` (`done`, the probe's own run's). */
export function measuredRefusedWhy(by: StatusRefusal, runId: string, phase: "measured" | "done" = "measured"): string {
  if (by === "lost") return `another writer took over the status lock of run ${runId} while the probe's \`${phase}\` status write held it, so that write was not made`;
  if (by === "busy") return `another status write held the status lock of run ${runId} for the whole wait, so the probe's \`${phase}\` status write was not made`;
  return `the run cache refused the probe's \`${phase}\` status write for run ${runId}`;
}

/** The stderr line after a failed probe attempt (exit 3/4) of a --run run was counted in its status: after an exit 3
 *  (no renderer) the user fixes the renderer before the one re-run; after an exit 4 the re-run follows at once. */
export function probeAttemptLine(doc: Pick<VerifyStatusV2, "runId" | "phase" | "probeFailures">, exit: number): string {
  const note = probeAttemptNote(doc.probeFailures ?? 0, exit);
  return doc.phase === "failed" ? `status run ${doc.runId} failed — ${note} (a retry is a new run: --new-run)`
    : `status run ${doc.runId} ${doc.phase} — ${note} (--run ${doc.runId}); the next failed attempt ends it failed`;
}
/** The stderr line when a failed probe attempt of a --run run could NOT be counted (the run cache refused the write, or
 *  another writer held its lock): the run stays where it was, so the line says how the agent ends it. */
export function probeAttemptUncounted(o: { runId: string; exit: number; by: StatusRefusal; screen: string; verifyDir: string }): string {
  const why = o.by === "lost" ? "another writer took over the status lock while the probe held it"
    : o.by === "busy" ? "another status write held the status lock for the whole wait" : "the run cache refused the write";
  const rerun = `${o.exit === 3 ? "Ask the user to make a renderer available, then re-run" : "Re-run"} the probe once in this run (--run ${o.runId})`;
  const head = `status run ${o.runId} not counted — this failed attempt (exit ${o.exit}) is not in the run's status (${why}). `;
  // an unwritable run cache refuses every status write of the run, a verify-screen --status one too: no command to run now
  if (o.by === "cache") {
    return head + `Until the run cache takes writes (the warning above says how), no status write of this run is recorded — a verify-screen ` +
      `--status write that ends it would be refused the same way. ${rerun} once it does; if that attempt fails too, end the run failed ` +
      `(verify-screen --status … --phase failed --run ${o.runId}) whatever its own line says`;
  }
  return head + `${rerun}; ` +
    `if that attempt fails too, whatever its own line says, end the run: ${scriptCmd("verify-screen")} --status ${shellArg(o.screen)} --phase failed ` +
    `--run ${o.runId} --detail ${shellArg(`probe exit ${o.exit} twice`)} --dir ${shellArg(o.verifyDir)}`;
}

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
/** Whether a --steps document is a plan that opts out of tagging — `"tagging": {"off": true, "reason": "…"}` (no
 *  reason, no opt-out, as the Stop hook reads it). */
export function planTaggingOff(doc: unknown): boolean {
  if (!isJsonObject(doc) || !isJsonObject(doc.tagging)) return false;
  const { off, reason } = doc.tagging;
  return off === true && typeof reason === "string" && reason.trim() !== "";
}
/** What the untagged-root rule reads of the expectation (UntaggedRoot): `ids` — the screen root's own node ids, the
 *  frame's excepted: its visible nodes (a multi-root export's other roots — a dialog, an overlay — carry a frameId and
 *  are left out, as are those roots themselves) and its instances that are no other root's; `known` — every id the
 *  expectation names (any root, hidden ones, the frames), so a tag outside it is another screen's; `frame` — the frame's
 *  size, when it states one. Null when the root names no node. */
export function ownTagsOf(exp: Expectation, frameId: string): { ids: string[]; known: string[]; frame: { w: number; h: number } | null } | null {
  const hidden = new Set((exp.hidden && exp.hidden.ids) || []);
  const ids = new Set<string>(), others = new Set<string>(), known = new Set<string>([frameId, ...hidden]);
  for (const s of exp.nodes || []) {
    known.add(s.nodeId);
    if (s.frameId !== undefined && s.frameId !== frameId) others.add(s.nodeId);
    else if (!hidden.has(s.nodeId)) ids.add(s.nodeId);
  }
  for (const i of exp.instances || []) {
    known.add(i.nodeId);
    if (!hidden.has(i.nodeId) && !others.has(i.nodeId)) ids.add(i.nodeId);
  }
  for (const fr of exp.frames || []) if (typeof fr.nodeId === "string") known.add(fr.nodeId);
  ids.delete(frameId);
  const w = exp.frame?.w, h = exp.frame?.h;
  return ids.size ? { ids: [...ids], known: [...known], frame: typeof w === "number" && typeof h === "number" ? { w, h } : null } : null;
}
/** How the measurement found a screen root that carries no tag (resolveFrame's `via`). */
const untaggedRootFound = (via: ResolvedFrame["via"] | undefined): string =>
  via === "size-and-fill" ? "its root found as the outermost element with the frame's size (±2 px) and a fill"
    : via === "viewport" ? "no element has the frame's size and a fill, so the viewport stands in for its root (positions are relative to the viewport)"
      : via === "tag" ? "its root found by its tag after all (the tag showed after the wait)"
        : "its root not found";
/** The measured file's note when the frame's tag never showed but at least half of the expectation's own tags did:
 *  `waitedMs` — how long the frame's tag was waited for (the --timeout, or what was left of a navigation's ≤ 10 s
 *  window); `via` — how the measurement found the root. */
export function untaggedRootNote(ready: string, waitedMs: number, via: ResolvedFrame["via"] | undefined): string {
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

/** The probe's own run (no --run) while it is open: armed once its `measuring` write is recorded (with how to end it),
 *  disarmed once a write ends it or says the run is over for this probe. */
interface OwnRunGuard { arm(end: (detail: string) => void): void; disarm(): void }
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/**
 * Run the probe. On every non-zero exit (1 included), a throw, or SIGINT / SIGTERM / SIGHUP (then exit 128 + the
 * signal's number) an armed own run is ended `failed`. A SIGKILL cannot be answered, and a refused last write leaves the
 * run at measuring: the run records its probe's pid, host and deadline (ownRun), and the next probe without --run ends
 * it once that pid is gone or the deadline has passed (verify-run.ts abandonedRun).
 */
export async function main(argv: string[]): Promise<number> {
  // (an object: set inside the closures)
  const armed: { end: ((detail: string) => void) | null } = { end: null };
  const onSignal = (sig: (typeof STOP_SIGNALS)[number]): void => {
    // taken once: a second signal (or main's own ender) before the exit lands writes nothing more; the listeners stay,
    // so that signal does not fall back to Node's default unflushed kill
    const end = armed.end;
    armed.end = null;
    end?.(`probe stopped by ${sig} — nothing written`);
    process.exitCode = 128 + os.constants.signals[sig];
    exitFlushed(process.exitCode);
  };
  const own: OwnRunGuard = {
    arm: (e) => { armed.end = e; for (const s of STOP_SIGNALS) process.on(s, onSignal); },
    disarm: () => { armed.end = null; for (const s of STOP_SIGNALS) process.off(s, onSignal); },
  };
  let code = 1;
  try {
    code = await probeMain(argv, own);
    return code;
  } catch (e) {
    armed.end?.(`probe error: ${firstLine(e)} — nothing written`);
    own.disarm();
    throw e;
  } finally {
    if (code !== 0) armed.end?.(`probe exit ${code} — nothing written`);
    own.disarm();
  }
}

async function probeMain(argv: string[], own: OwnRunGuard): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  if (!argv.length) { console.error(USAGE); return 2; }
  const OPTIONS = {
    expected: { type: "string" }, url: { type: "string" }, out: { type: "string" }, ready: { type: "string" }, viewport: { type: "string" },
    project: { type: "string" }, position: { type: "boolean" }, timeout: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" },
    run: { type: "string" }, "max-time": { type: "string" }, steps: { type: "string" }, behaviour: { type: "string" }, "browser-path": { type: "string" },
  } as const;
  const { values: f } = cliParse("verify-probe", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: false }));
  const project = path.resolve(f.project ?? ".");
  const timeout = f.timeout === undefined ? 30_000 : Number(f.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) { console.error(`verify-probe: --timeout must be a positive number of milliseconds\n${USAGE}`); return 2; }
  const maxTime = f["max-time"] === undefined ? MAX_TIME_DEFAULT : Number(f["max-time"]);
  if (!Number.isFinite(maxTime) || maxTime <= 0 || maxTime > MAX_TIME_LIMIT) {
    console.error(`verify-probe: --max-time must be a positive number of milliseconds, at most ${MAX_TIME_LIMIT}\n${USAGE}`); return 2;
  }
  // a switch for the probe's own tests only (the env var) — the measured file then says behaviour did not run and why
  if (f.behaviour !== undefined && f.behaviour !== "on" && f.behaviour !== "off") { console.error(`verify-probe: --behaviour must be on or off, got '${f.behaviour}'\n${USAGE}`); return 2; }
  if (f.behaviour !== undefined && f.check) { console.error(`verify-probe: --behaviour does not apply to --check\n${USAGE}`); return 2; }
  if (f.behaviour === "off" && process.env[BEHAVIOUR_OFF_ENV] !== "1") {
    console.error(`verify-probe: --behaviour off is for the probe's own tests (${BEHAVIOUR_OFF_ENV}=1) — a run without the behaviour checks is not a verification\n${USAGE}`); return 2;
  }
  if (f.ready !== undefined && f.ready.trim() === "") { console.error(`verify-probe: --ready must be a selector or none, got '${f.ready}'\n${USAGE}`); return 2; }
  const behaviourOn = f.behaviour !== "off";
  if (f.run !== undefined && (f.check || !/^[\w.:-]+$/.test(f.run))) {
    console.error(`verify-probe: ${f.check ? "--run does not apply to --check" : `--run must be a run id (letters, digits, . : _ -), got '${f.run}'`}\n${USAGE}`); return 2;
  }

  if (!f.check) {
    if (!f.expected || !f.url) { console.error(`verify-probe: --expected and --url are both required\n${USAGE}`); return 2; }
  } else if (f.steps !== undefined) { console.error(`verify-probe: --steps does not apply to --check\n${USAGE}`); return 2; }
  // the steps — a JSON list, or a plan's navigate[]; refused whole when any step is outside the vocabulary
  let steps: ProbeStep[] = [];
  let stepsSource: string | null = null;
  /** the --steps plan opts out of tagging: there is no frame tag to wait for by default */
  let taggingOff = false;
  if (f.steps !== undefined) {
    const r = readJson(f.steps, anyJson);
    if ("error" in r) { console.error(`verify-probe: --steps '${f.steps}' ${r.error}`); return 2; }
    taggingOff = planTaggingOff(r.doc);
    const parsed = parseSteps(r.doc);
    if ("error" in parsed) { console.error(`verify-probe: --steps '${f.steps}' ${parsed.error}\n${USAGE}`); return 2; }
    // a plan with no navigate list: the screen is reached by --url alone — no steps, no reach recorded
    if (parsed.noNavigate) console.error(`note  --steps '${f.steps}' is a plan with no \`navigate\` list — no steps run: the screen is measured where --url lands`);
    else {
      steps = parsed.steps;
      stepsSource = `--steps ${(path.relative(process.cwd(), path.resolve(f.steps)) || f.steps).split(path.sep).join("/")}`;
    }
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
  // what every load waits for: --ready, else the frame's tag (--check measures nothing: no wait)
  const readyPick = f.check ? null : readyOf(f.ready, expectation?.frame?.nodeId, taggingOff);
  // the default's way out for an untagged screen root: the expectation's own tags
  const frameNodeId = expectation?.frame?.nodeId;
  const ownTags = f.ready === undefined && readyPick?.ready !== undefined && expectation && frameNodeId !== undefined ? ownTagsOf(expectation, frameNodeId) : null;
  const untaggedRoot: UntaggedRoot | undefined = ownTags !== null ? { ...ownTags, seen: false } : undefined;

  const outBase = f.out ?? (f.expected ? path.join(path.dirname(f.expected), path.basename(f.expected, ".json").replace(/\.expected$/, "")) : "");
  // the run's status is the one of the expectation's verify dir (design/verify/<S>), even when --out stages
  // the files elsewhere; it is written to the run cache (liveStatusFile), never into the watched project tree
  const statusBase = f.expected ? path.join(path.dirname(f.expected), path.basename(outBase)) : "";
  const expSha = expBytes ? sha256Hex(expBytes) : undefined;
  // the run this measurement belongs to (none for --check): --run's, else a run of its own, started with the probe's
  // first status write and ended by its last — so every measured file the probe writes names its run
  // (without --check, --expected and --url are required above: statusBase is set, so runId is undefined only for --check)
  const runId = f.check || !statusBase ? undefined : f.run ?? newRunId();
  const ownRun = runId !== undefined && f.run === undefined;
  // an ended run (done/failed/blocked) takes no more writes — a probe with its --run would reopen it
  // (phase back to measuring) and lose the verifier's `blocked` the same way a --status write would. A run of its own
  // starts only when no other run of the screen is open: a verifier's live run writes the same files. Both said before
  // anything is resolved; every later status write checks again under its lock (writeStatus), and the files are
  // written inside the `measured` (own run: `done`) one — a run ended, or opened beside its own, while the page was
  // measured gets none of them.
  const refusedAtStart = runId === undefined ? null : ownRun ? openRun(statusBase, readStatus(statusBase), runId) : endedRun(readStatus(statusBase), runId);
  if (refusedAtStart) { console.error(`verify-probe: ${refusedAtStart.message}`); return 2; }
  // A status write the run cache refuses (the sandbox's write scope), that another write keeps waiting past its lock's
  // wait, or whose lock another writer took over, is a warning — the probe keeps its exit contract (0/2/3/4) and never
  // crashes on it. A run ended meanwhile (the orchestrator's failed/blocked), or another run opened beside its own, keeps
  // its status and exits 2 ("over"): no files, no next step.
  // why the last refused write was refused — the closing warning names it (an object: set inside the closure)
  const refusal: { by: StatusRefusal } = { by: "cache" };
  // its own run: another probe's own run left open by a probe that is gone is ended `failed` by this run's first write
  const abandoned = (d: VerifyStatusV2): void => { console.error(`note  run ${d.runId} — ${d.detail}`); };
  // set once the `measuring` write is recorded (read by `ended`, which runs before it too): every later write of its own
  // run continues it — refused once the status names another run (it was replaced: this probe was late)
  let measuringRecorded = false;
  const status = (w: StatusWrite, hooks: Pick<StatusWriteHooks, "before" | "after"> = {}): "ok" | "refused" | "over" => {
    try { writeStatus(statusBase, w, { ...hooks, ...(ownRun ? { alone: true, abandoned, ...(measuringRecorded ? { continues: true } : {}) } : {}) }); return "ok"; } catch (e) {
      if (e instanceof RunEnded) { console.error(`verify-probe: ${e.message} — it ended while this probe ran; its status is left as it is`); own.disarm(); return "over"; }
      if (e instanceof RunOpen) { console.error(`verify-probe: ${e.message} — it opened while this probe ran; nothing is written`); own.disarm(); return "over"; }
      if (e instanceof RunReplaced) { console.error(`verify-probe: ${e.message}`); own.disarm(); return "over"; }
      if (!(e instanceof RunCacheUnwritable) && !(e instanceof LockBusy)) throw e;
      console.error(`warning  ${e.message}`);
      refusal.by = statusRefusalOf(e);
      return "refused";
    }
  };
  // an exit 3/4: with --run the status counts it as a failed probe attempt of that run (writeStatus, under the lock) —
  // the first leaves the run at measuring for the one re-run, the PROBE_ATTEMPTS-th ends it `failed`; a run of its own
  // that started ends `failed` at once (a re-run starts a new one). Any other non-zero exit, a throw or a stop signal
  // ends its own run in main.
  const ended = (code: number): number => {
    if (runId !== undefined && (code === 3 || code === 4) && (!ownRun || measuringRecorded)) {
      const w: StatusWrite = { runId, phase: ownRun ? "failed" : "measuring", by: "verify-probe", detail: `probe exit ${code} — nothing written`,
        ...(expSha ? { expectationSha256: expSha } : {}), ...(ownRun ? {} : { probeFailed: code }) };
      const rec: { doc?: VerifyStatusV2 } = {};
      const wrote = status(w, { after: (d) => { rec.doc = d; } });
      if (ownRun) own.disarm();
      if (wrote === "over") return 2;
      if (!ownRun) {
        if (rec.doc?.probeFailures !== undefined) console.error(probeAttemptLine(rec.doc, code));
        // not counted: the run sits at its last phase — say how the agent ends it
        else if (wrote === "refused") console.error(probeAttemptUncounted({ runId, exit: code, by: refusal.by, screen: path.basename(statusBase), verifyDir: path.resolve(path.dirname(statusBase)) }));
      }
    }
    return code;
  };
  // checked before anything else is resolved or launched (a flag, no env var: shell state does not persist between calls)
  const browserPath = f["browser-path"];
  if (browserPath !== undefined) { const bad = browserPathError(browserPath); if (bad !== null) return ended(rendererUnavailable(bad, null)); }
  const res = resolvePlaywright(project);
  if (!res.ok) return ended(rendererUnavailable(res.reason, res.hint));
  // written BEFORE the browser starts, and outside the project tree; not recorded when refused (or no run: --check)
  // (its own run records who started it: this process — its pid tells a run left open by a killed probe from a live one)
  const measuring = runId !== undefined ? status({ runId, phase: "measuring", by: "verify-probe", detail: `verify-probe measuring ${f.url ?? ""}`, ...(expSha ? { expectationSha256: expSha } : {}),
    ...(ownRun ? { ownRun: { ...thisProcess(), startedAt: new Date().toISOString(), deadline: new Date(Date.now() + maxTime + OWN_RUN_GRACE_MS).toISOString() } } : {}) }) : "refused";
  // ended (or, its own run, another opened) between the check above and this write: launch nothing
  if (measuring === "over") return 2;
  measuringRecorded = measuring === "ok";
  if (ownRun) console.error(`run    ${runId} — this probe's own (no --run): it ends it, done with the files or failed on an exit 3/4`);
  if (ownRun && measuringRecorded) {
    const id = runId;
    own.arm((detail) => {
      try { status({ runId: id, phase: "failed", by: "verify-probe", detail, ...(expSha ? { expectationSha256: expSha } : {}) }); } catch (e) { console.error(`warning  run ${id} is not ended: ${firstLine(e)}`); }
    });
  }
  if (measuringRecorded) console.error(`status ${shellArg(liveStatusFile(statusBase))}`);
  if (readyPick) console.error(readyPick.note);

  // one bound over launch → measure → close. Past it the browser is closed (at most 10 s more) and nothing is written.
  const held: { browser?: Browser; timedOut?: boolean } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runDeadline = Date.now() + maxTime;
  const watchdog = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), maxTime); });
  const work = (async (): Promise<number | { run: Extract<ProbeRun, { kind: "ok" }>; identity: ProbeIdentity; driven: InteractionEvidence[] | null; driveNote: string | null; behaviour: MeasuredBehaviour;
    forcedPng: Buffer | null; prep: VisualPrep; visualCap: VisualCapture | { why: string }; captureMs: number }> => {
    const launched = await launch(res, project, browserPath);
    if ("error" in launched) return rendererUnavailable(launched.error, launched.hint);
    const browser = launched.browser;
    held.browser = browser;
    await recordLaunchPid(browser);
    const identity: ProbeIdentity = { name: "verify-probe", version: probeVersion(), sha256: selfSha256(), playwright: { package: res.pkg, version: res.version },
      browser: { name: "chromium", version: browser.version(), ...(browserPath !== undefined ? { executable: "custom" as const } : {}) } };
    // the path is printed (stdout/stderr), never written into a file
    const browserLine = `chromium ${identity.browser.version}${browserPath !== undefined ? ` (--browser-path ${browserPath})` : ""}`;

    if (f.check || !expectation || !expBytes || !f.expected || !f.url) {
      await browser.close();
      console.log(`ok  ${res.pkg} ${res.version} (from ${path.relative(project, res.file) || res.file}) · ${browserLine} · verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}…)`);
      return 0;
    }

    let run: ProbeRun;
    const ready = readyPick?.ready;
    const probeOpts: ProbeOptions = { expectation, url: f.url, ...(ready !== undefined ? { ready } : {}), viewport, position: !!f.position, timeout, ...(steps.length ? { steps } : {}),
      ...(untaggedRoot !== undefined ? { untaggedRoot } : {}) };
    try {
      run = await runProbe(browser, probeOpts);
    } catch (e) {
      await browser.close().catch(() => undefined);
      if (e instanceof UnreachableError) {
        // the default --ready that never showed, nor enough of the expectation's tags: the page is not the screen (a
        // redirect, another section, another screen's tagged root), or nothing on it is tagged
        const byDefault = f.ready === undefined && ready !== undefined && e.message.startsWith(`--ready '${ready}'`);
        const hint = !byDefault ? "" : e.foreign !== null ? foreignRootHint(ready, e.foreign, steps.length > 0) : defaultReadyMissed(ready, steps.length > 0);
        console.error(`verify-probe: ${e.message} — nothing written.` + (hint ? `\n  ${hint}` : ""));
        return 4;
      }
      // runProbe answers a page gone during measurement with browser-gone itself; this is one gone outside it (the context
      // or page could not be opened) — the same exit 4. After the watchdog's close it is that close, which said so itself.
      if (pwErrorKind(e) === "gone") {
        if (!held.timedOut) console.error(`verify-probe: the page or browser closed or crashed (${pwFirstLine(e)}) — nothing written. This is not a page reload: re-run the probe; if it recurs, run --check.`);
        return 4;
      }
      if (pwErrorKind(e) === "timeout") { console.error(`verify-probe: timed out — ${firstLine(e)} — nothing written.`); return 4; }
      throw e;
    }
    // the frame's tag never showed, but the page showed the expectation's own tags: measured as the screen
    if (untaggedRoot?.seen === true && ready !== undefined) notes.push(untaggedRootNote(ready, untaggedRoot.waitedMs ?? timeout, run.kind === "ok" ? run.result.frames[0]?.via : undefined));
    // drive the overlay interactions, each on a fresh page, after the measurement pass and before the
    // browser closes — within min(60 s, what --max-time leaves less 15 s). Never blocks the measured file, never exit 4.
    let driven: InteractionEvidence[] | null = null, driveNote: string | null = null;
    /** the browser stopped answering while driving: no behaviour, and it is killed at once (no capped close steps to wait for) */
    let wedged = false;
    const rows = run.kind === "ok" ? drivable(expectation) : [];
    if (rows.length) {
      try {
        // The drive's own budget (its evidence never depends on the behaviour checks). The drive returns by its budget +
        // a cut row's settle (CUT_SETTLE_MS); a cut row whose close and wind-down did not fit that settle means the browser
        // stopped answering: the finished measurement is still written (exit 0), with no interaction evidence and a note
        ({ driven, driveNote, wedged } = driveOutcome(await driveInteractions(browser, {
          rows, viewport, timeout, initScript: INIT_SCRIPT, budgetMs: driveBudget(Date.now(), runDeadline),
          reach: async (page) => { await reachPage(page, attachNavLog(page), probeOpts); },
        })));
      } catch (e) {
        driveNote = `driving the interactions failed (${firstLine(e)}) — none recorded`;
      }
    }
    // The visual capture — after the drive (it can never cut verdict-affecting rows), before behaviour (one capped
    // load: behaviour's budget is computed afterwards from what is left). No reference → skipped at once. Never exit 4.
    // the reference is read from the project that owns the expectation; prepareVisual never throws, and the try keeps it
    // so (a throw here would leave the browser open and the process hanging)
    let prep: VisualPrep = { ok: false, why: "not measured" };
    if (run.kind === "ok") {
      try { prep = prepareVisual(expectation, referenceRoot(f.expected, project)); } catch (e) { prep = { ok: false, why: `the reference could not be read (${firstLine(e)})` }; }
    }
    const visualAt = Date.now();
    let visualCap: VisualCapture | { why: string } = { why: prep.ok ? "not captured" : prep.why };
    if (run.kind === "ok" && prep.ok) {
      const fr0 = run.result.frames[0];
      if (wedged) visualCap = { why: "the browser stopped answering while the interactions were driven" };
      else {
        visualCap = await captureVisual(browser, {
          ref: prep.ref, frame: fr0 ? { nodeId: fr0.nodeId, selector: fr0.selector, via: fr0.via, rect: fr0.rect } : null,
          frameSize: prep.frameSize, nodes: run.result.nodes, viewport, timeout, initScript: INIT_SCRIPT,
          reach: async (page) => { await reachPage(page, attachNavLog(page), probeOpts); },
          budgetMs: visualBudget(Date.now(), runDeadline),
        });
      }
    }
    // the capture's own time — the behaviour battery runs between it and finishVisual, so it is not counted
    const captureMs = Date.now() - visualAt;
    // The behaviour/a11y checks — after the measurement pass and the drive, each unit on a fresh page, within
    // min(90 s, what --max-time leaves less 20 s). Never exit 4, never blocks the measured file: a failure is {ran:false, why}.
    let behaviour: MeasuredBehaviour = { version: 1, ran: false, why: "--behaviour off" };
    let forcedPng: Buffer | null = null;
    if (wedged && behaviourOn) behaviour = { version: 1, ran: false, why: "the browser stopped answering while the interactions were driven" };
    else if (run.kind === "ok" && behaviourOn) {
      const budgetMs = behaviourBudget(Date.now(), runDeadline);
      if (budgetMs <= 0) behaviour = { version: 1, ran: false, why: "no time left within --max-time after measuring and driving" };
      else {
        try {
          const axe = resolveAxe(project);
          const r = await runBehaviour(browser, {
            expectation, driven, viewport, timeout, initScript: INIT_SCRIPT, budgetMs, measuredTags: run.result.visibleTags,
            reach: async (page) => { await reachPage(page, attachNavLog(page), probeOpts); },
            axe: axe.ok ? { source: axe.source, version: axe.version } : { why: axe.why },
            forcedPng: (outBase + ".forced-colors.png").split(path.sep).join("/"),
          });
          behaviour = r.behaviour;
          forcedPng = r.forcedPng;
        } catch (e) {
          behaviour = { version: 1, ran: false, why: `the behaviour checks failed (${firstLine(e)})` };
        }
      }
    }
    // capped (a page that never yields does not close): the behaviour units run arbitrary page code
    if (wedged) { await killBrowser(launchPids.get(browser), PROBE_HOST, 0); await Promise.race([browser.close().catch(() => undefined), sleep(1000, undefined, { ref: false })]); }
    else await closeCapped(browser);

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
    return { run, identity, driven, driveNote, behaviour, forcedPng, prep, visualCap, captureMs };
  })().catch(async (e: unknown): Promise<never> => {
    // every throw after the launch closes the browser first (a connected browser keeps the process alive forever)
    const b = held.browser;
    if (b && !held.timedOut) await closeCapped(b);
    throw e;
  });
  // the watchdog's timer is cleared however the race ends (a rejected work must not keep the process up to --max-time)
  const first = await Promise.race([work, watchdog]).finally(() => clearTimeout(timer));
  if (first === "timeout") {
    held.timedOut = true;
    work.catch(() => undefined); // it rejects once its browser is gone
    const b = held.browser;
    if (b) await closeCapped(b);
    console.error(`verify-probe: timed out after ${maxTime / 1000}s (--max-time) — the browser was closed, nothing written.\n` +
      "  a page that never settles (a script that does not yield, a request that never ends): re-run the probe once; if it times out again, report it —\n" +
      "  the probe writes the run's `failed` status itself (with --run at the second failed attempt; its own run at once).");
    return ended(4);
  }
  if (typeof first === "number") return ended(first);
  const { run, identity, driven, driveNote, behaviour, forcedPng, prep, visualCap, captureMs } = first;
  if (!expectation || !expBytes || !f.expected || !f.url || runId === undefined) return 2; // (--check returned above)

  // Everything below runs after browser.close(): nothing is written while the page is live (a write into the
  // dev server's watch tree is what reloaded it mid-measurement).
  const png = outBase + ".png";
  const r = run.result;
  const frameOut = (fr: ResolvedFrame): ProbeFrame => ({ nodeId: fr.nodeId, selector: fr.selector, via: fr.via, rect: fr.rect });
  const firstFrame = r.frames[0];
  // Decode, diff and draw in Node (the browser is closed). The diff image is written BEFORE the measured text is built: a
  // failed write leaves visual.diff null (the measured file never names a missing file). A run that drew none removes an earlier
  // run's diff. Never in measured.artifacts (compare's artifact check stays verdict-neutral).
  const diffPath = outBase + ".diff.png";
  let visual: MeasuredVisual = { version: 1, ran: false, why: prep.ok ? "not captured" : prep.why };
  let diffPng: Buffer | null = null;
  if (prep.ok) ({ visual, diffPng } = finishVisual({ expectation, prep, capture: visualCap, diffPath: diffPath.split(path.sep).join("/"), captureMs }));
  const allNotes = [...notes, ...r.notes, ...(driveNote !== null ? [driveNote] : [])];
  // The measured file but its visual part (which says whether the diff image got written), built before the status
  // lock is taken: the git state spawns git (up to its timeout), and the lock is held only for the writes.
  const measuredBase: Omit<VerifyMeasured, "visual"> = {
    measuredAt: new Date().toISOString(),
    renderer: "playwright-chromium",
    viewport: `${viewport.w}x${viewport.h}`,
    artifacts: [png.split(path.sep).join("/")],
    expectationSha256: sha256Hex(expBytes),
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
    runId,
    build: { ...run.build, ...gitState(project) },
    ...(stepsSource !== null ? { reach: { steps, sha256: stepsSha256(steps), source: stepsSource, url: r.url } } : {}),
    page: r.page,
    ...(driven ? { interactions: driven } : {}),
    behaviour,
  };
  // Every file of this measurement, written (or an earlier run's removed) in one step: inside the `measured` (own run:
  // `done`) status write's lock after its ended-run (own run: open-run) check, so a run ended while the page was
  // measured gets none. Returns the measured file's sha for that record; `written` says it got that far.
  let written = false, statusRefused = false;
  const writeFiles = (): Pick<StatusWrite, "measuredSha256"> => {
    try {
      if (diffPng !== null) writeFileAtomic(diffPath, diffPng);
      else if (fs.existsSync(diffPath)) fs.rmSync(diffPath, { force: true });
    } catch (e) {
      console.error(`warning  ${diffPath}: ${firstLine(e)} — the visual diff image is not written`);
      if (visual.ran) visual = { ...visual, diff: null, notes: [...visual.notes, `the diff image could not be written (${firstLine(e)})`] };
    }
    const measured: VerifyMeasured = { ...measuredBase, visual };
    // atomic, the picture first — a reader that sees measured.json sees the screenshot it lists
    const measuredText = JSON.stringify(allNotes.length ? { ...measured, notes: allNotes } : measured, null, 2) + "\n";
    writeFileAtomic(png, r.png);
    // Listed in behaviour.artifacts only (never measured.artifacts: compare's artifact check stays verdict-neutral). A run
    // that takes none removes an earlier run's (that exact path) — it would sit unlisted next to a measured file that never saw
    // it. Never a reason to lose measured.json: a failure here is a note on stderr.
    const forcedPath = outBase + ".forced-colors.png";
    try {
      if (forcedPng !== null) writeFileAtomic(forcedPath, forcedPng);
      else if (fs.existsSync(forcedPath)) fs.rmSync(forcedPath, { force: true });
    } catch (e) { console.error(`warning  ${forcedPath}: ${firstLine(e)} — the behaviour screenshot is not written`); }
    writeFileAtomic(outBase + ".measured.json", measuredText);
    written = true;
    return { measuredSha256: sha256Hex(measuredText) };
  };
  // --run: `measured` (the verifier's run goes on); its own run: `done`, published as the durable record beside the
  // expectation (the page is closed) — a failed publish is a warning, the live `done` stands
  const lastPhase = ownRun ? "done" : "measured";
  const publish = (d: VerifyStatusV2): void => {
    try { publishStatus(statusBase, d); } catch (e) { console.error(`warning  ${statusFile(statusBase)}: ${firstLine(e)} — the durable status is not written (the live one says done)`); }
  };
  const wrote = status({ runId, phase: lastPhase, by: "verify-probe", detail: `measured ${r.nodes.length} of ${r.nodes.length + r.notMeasured.length} spec(s)`,
    ...(expSha ? { expectationSha256: expSha } : {}) }, { before: writeFiles, ...(ownRun ? { after: publish } : {}) });
  // its own run is `done` now — or, refused, the files are written and the warning below says how to record them (a
  // run left at measuring by a probe that has exited is ended by the next probe without --run: abandonedRun)
  own.disarm();
  if (wrote === "over") return 2; // ended (or another run opened beside its own) while the page was measured: no files, no next step
  if (wrote === "refused") {
    // the measured file stays when the status write is refused: the run's status still says measuring, so say what
    // records it. Refused before the files (the lock itself): checked without the lock for an ended run (own run: a
    // status naming another run once its `measuring` was recorded — it was replaced —, else another open run), then written
    statusRefused = true;
    const now = written ? null : readStatus(statusBase);
    const endedNow = written ? null : !ownRun ? endedRun(now, runId) : measuringRecorded ? replacedRun(now, runId) : openRun(statusBase, now, runId);
    if (endedNow) { console.error(`verify-probe: ${endedNow.message}`); return 2; }
    if (!written) writeFiles();
  }
  const c = census(r.nodes, r.notMeasured);
  console.error(`wrote ${outBase}.measured.json and ${png}`);
  console.error(`measured ${r.nodes.length} of ${r.nodes.length + r.notMeasured.length} spec(s) — tag ${c.tag} · shared path ${c.sharedPath} · alias ${c.tagAlias} · text ${c.text} · ordinal ${c.textOrdinal} · ` +
    `position ${c.position} · frame ${c.frame} · not measured ${c.notMeasured}` +
    ` · frame root via ${firstFrame ? firstFrame.via : "none"} · navigations after load ${run.navigation.afterInitialLoad}, re-runs ${run.navigation.reruns}`);
  const tn = r.tagsNotInExpectation;
  if (tn.count) console.error(`note  ${tn.count} data-dt-node value(s) on visible elements are not in the expectation (e.g. ${tn.ids.slice(0, 5).map((x) => x.id).join(", ")}) — --compare classifies them`);
  if (stepsSource !== null) console.error(`reach ${steps.length} step(s) from ${stepsSource} (sha ${stepsSha256(steps).slice(0, 12)}…) → ${r.url}`);
  const pg = r.page;
  console.error(`page  scrollWidth ${pg.scrollWidth} at clientWidth ${pg.clientWidth} (overflow-x ${pg.overflowX})` +
    `${pg.scrollWidth > pg.clientWidth + 1 ? (pg.scrollable ? ` — scrolls sideways (widest: ` +
      `${pg.offenders.slice(0, 3).map((o) => o.dt ? `data-dt-node="${o.dt}"` : o.path).join(", ") || "?"})` : " — overflows but clipped") : ""}`);
  for (const ev of driven || []) console.error(`drive ${ev.nodeId} ${ev.trigger ?? ""} → ${ev.ok === true ? "ok" : "ok:null"} · ${ev.detail ?? ""}`);
  console.error(behaviourLine(behaviour));
  console.error(visualLine(visual));
  for (const n of allNotes) console.error(`note  ${n}`);
  console.error(`probe verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}…) · ${res.pkg} ${res.version} · chromium ` +
    `${identity.browser.version}${browserPath !== undefined ? ` (--browser-path ${browserPath})` : ""}`);
  if (statusRefused) {
    // say which write was refused and what --compare will make of it; the recovery records the measured file's
    // sha after the same checks `done` applies — `measured` reads <verify dir>/<S>.measured.json, else the run's stage
    // dir; `done` (the probe's own run, which it ends) reads the verify dir
    const outDir = path.resolve(path.dirname(outBase)), verifyDir = path.resolve(path.dirname(statusBase));
    const findable = outDir === verifyDir || (!ownRun && outDir === path.resolve(stageDirOf(statusBase, runId)));
    console.error(`warning  ${outBase}.measured.json is written, but ${measuredRefusedWhy(refusal.by, runId, lastPhase)}` +
      (measuringRecorded ? " — the live status still says measuring, so --compare reports the run incomplete"
        : " (its `measuring` write was refused too) — no live status of the run exists, so --compare will report the run as unrecorded") +
      `. Record it${refusal.by === "cache" ? ", from where the run cache takes writes," : ""} with: ${scriptCmd("verify-screen")} --status ${shellArg(path.basename(statusBase))} ` +
      `--phase ${lastPhase} --run ${runId} --dir ${shellArg(verifyDir)}` +
      (findable ? "" : ` — after moving ${outBase}.measured.json to ${statusBase}.measured.json (it reads the verify dir${ownRun ? "" : " or the run's stage dir"})`));
  }
  console.error(`next  ${scriptCmd("verify-screen")} --compare ${shellArg(f.expected)} ${shellArg(outBase + ".measured.json")} --out ${shellArg(outBase)}`);
  return 0;
}

/** A browser told to quit can be slow to go, and Playwright's browser.close() then waits up to 30 s for it (a ref'd timer and
 *  the browser's pipes), keeping this process up past --max-time — where killBrowser kills nothing (Windows, with the
 *  browser's pid unknown, its taskkill failed, or `exited`: the close resolved or the browser disconnected). So a process still up EXIT_GRACE_MS after main is done exits, stdio
 *  flushed first (process.exit drops what an async pipe has not written yet): Playwright's exit hook then kills each
 *  browser this process launched that is still running (taskkill /T /F on Windows, its process group on POSIX). A process that drains on its own never reaches the timer. */
const EXIT_GRACE_MS = 1_000;
function exitWhenDone(code: number): void {
  process.exitCode = code;
  setTimeout(() => exitFlushed(code), EXIT_GRACE_MS).unref();
}
/** exit once stderr and stdout have flushed, or after FLUSH_CAP_MS when a reader never drains them — the grace timer
 *  above, and a stop signal (its listener replaces Node's default exit; Playwright's SIGTERM/SIGHUP listeners only close
 *  the browser, and its SIGINT one exits 130 only after a browser has launched) */
const FLUSH_CAP_MS = 2_000;
function exitFlushed(code: number): void {
  const exit = (): never => process.exit(code);
  setTimeout(exit, FLUSH_CAP_MS).unref(); // a pending write keeps the loop up, so this still fires
  process.stderr.write("", () => process.stdout.write("", exit));
}

if (import.meta.main ?? isMainFallback(import.meta.url)) {
  main(process.argv.slice(2)).then(exitWhenDone, (e: unknown) => { console.error(`verify-probe: ${errMsg(e)}`); exitWhenDone(1); });
}
