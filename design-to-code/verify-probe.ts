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
//                   [--run <id>] [--max-time <ms>]
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
import { readJson, readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd, shellArg } from "./cli-args.ts";
import { isJsonObject } from "./types.ts";
import type { BuildIdentity, MeasuredComponent, MeasuredNode, ProbeFrame, ProbeIdentity, ProbeNavigation, ProbeNotMeasured, VerifyMeasured, VerifySpec } from "./types.ts";
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
class BrowserGoneError extends Error {}
const gone = (e: unknown): BrowserGoneError => new BrowserGoneError(`the browser closed or crashed during measurement (${errMsg(e).split("\n")[0]})`);
class KeptNavigatingError extends Error {}
class UnreachableError extends Error {}

interface NavLog { events: ProbeNavigation["events"]; navs: number; gotos: number; t0: number }

async function settle(page: Page, log: NavLog, ready: string | undefined, timeout: number): Promise<string | null> {
  const cap = Math.min(QUIET_CAP_MS, timeout);
  const deadline = Date.now() + cap;
  const navAtStart = log.navs;
  const kept = (): KeptNavigatingError => new KeptNavigatingError(`the page kept navigating for ${Math.round(cap / 1000)}s after load (${log.navs - navAtStart} navigation(s)) and never settled`);
  for (;;) {
    try {
      await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
      // the full --timeout for a page that has not navigated since load; what is left of the quiet cap otherwise
      if (ready) await page.locator(ready).first().waitFor({ state: "visible", timeout: log.navs === navAtStart ? timeout : Math.max(1, deadline - Date.now()) });
    } catch (e) {
      if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
      if (log.navs !== navAtStart && Date.now() < deadline) { await sleep(POLL_MS); continue; }
      if (log.navs !== navAtStart) throw kept();
      if (errorKind(errMsg(e), false) === "navigated" && Date.now() < deadline) { await sleep(POLL_MS); continue; }
      throw new UnreachableError(ready ? `--ready '${ready}' never became visible: ${errMsg(e).split("\n")[0]}` : errMsg(e).split("\n")[0]);
    }
    const mark = log.navs;
    let last = "", since = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      if (log.navs !== mark) {
        await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined);
        if (Date.now() >= deadline) throw kept();
        break; // restart: fonts, --ready, a fresh quiet window
      }
      let sig: string;
      try {
        const v: unknown = await page.evaluate("[document.getElementsByTagName('*').length, (document.body && document.body.textContent || '').length].join(':')");
        sig = String(v);
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
        if (errorKind(errMsg(e), false) !== "navigated") throw e;
        if (Date.now() >= deadline) throw kept();
        continue;
      }
      if (sig !== last) { last = sig; since = Date.now(); }
      if (Date.now() - since >= QUIET_MS) return null;
      if (Date.now() >= deadline) {
        if (log.navs !== navAtStart) throw kept();
        return `the DOM was still changing after ${Math.round(cap / 1000)}s (no navigation) — measured anyway`;
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
}
interface PassResult {
  nodes: MeasuredNode[];
  notMeasured: ProbeNotMeasured[];
  frames: ResolvedFrame[];
  components: MeasuredComponent[];
  png: Buffer;
  notes: string[];
  tagsNotInExpectation: NonNullable<VerifyMeasured["tagsNotInExpectation"]>;
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

  log.gotos++;
  try {
    await page.goto(o.url, { waitUntil: "load", timeout: o.timeout });
  } catch (e) {
    if (!/interrupted by another navigation/i.test(errMsg(e))) throw new UnreachableError(`could not load ${o.url}: ${errMsg(e).split("\n")[0]}`);
  }
  const settleNote = await settle(page, log, o.ready, o.timeout);

  try {
    const token = await docToken(page);
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
    if ((await docToken(page)) !== token) throw new NavigatedError("the page loaded a new document during measurement");

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
    };
  } catch (e) {
    if (e instanceof NavigatedError || e instanceof UnreachableError || e instanceof BrowserGoneError) throw e;
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
  | { kind: "browser-gone"; why: string; navigation: ProbeNavigation };

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
  const bodies: Array<Promise<void>> = [];
  let gen = 0, viteClient = false;
  page.on("response", (res) => {
    if (!BUILD_TYPES.has(res.request().resourceType())) return;
    let u: URL;
    try { u = new URL(res.url()); } catch { return; }
    if (u.origin !== origin) return;
    if (u.pathname === "/@vite/client") viteClient = true;
    const g = gen;
    bodies.push(res.body().then((b) => { if (g === gen) served.set(u.pathname, sha256Of(b)); }, () => undefined)); // a redirect has no body
  });
  const log: NavLog = { events: [], navs: 0, gotos: 0, t0: Date.now() };
  const consoleErrors: string[] = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) { log.navs++; log.events.push({ type: "framenavigated", url: f.url(), at: Date.now() - log.t0 }); } });
  page.on("load", () => { log.events.push({ type: "load", url: page.url(), at: Date.now() - log.t0 }); });
  page.on("console", (msg) => { if (msg.type() === "error" && consoleErrors.length < 20) consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => { if (consoleErrors.length < 20) consoleErrors.push(err.message); });
  const nav = (reruns: number): ProbeNavigation => ({ events: log.events, afterInitialLoad: Math.max(0, log.navs - log.gotos), reruns });
  let reruns = 0;
  try {
    for (;;) {
      try {
        gen++; served.clear(); viteClient = false;
        const result = await pass(page, log, o);
        await Promise.allSettled(bodies);
        return { kind: "ok", result, navigation: nav(reruns), consoleErrors, build: buildFrom(o.url, served, viteClient) };
      } catch (e) {
        if (e instanceof BrowserGoneError) return { kind: "browser-gone", why: e.message, navigation: nav(reruns) };
        if (e instanceof KeptNavigatingError) return { kind: "navigation", why: e.message, navigation: nav(reruns) };
        if (!(e instanceof NavigatedError)) throw e;
        if (reruns >= 1) return { kind: "navigation", why: `the page reloaded during measurement twice (${e.message})`, navigation: nav(reruns) };
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
  "      renders <url> in the PROJECT's Playwright (chromium), matches every expectation row (tag → shared path → alias →\n" +
  "      text → text-ordinal → --position), and writes <out>.measured.json + <out>.png for verify-screen --compare.\n" +
  "      --out defaults to the .expected.json path minus `.expected`; --viewport to the frame's w×h; --project to cwd.\n" +
  "      --run <id> (from verify-screen --status … --new-run): writes the run's LIVE status (the run cache,\n" +
  "      node_modules/.cache/designtwin-verify/<Screen>.status.json — never the project tree a dev server watches) — `measuring`\n" +
  "      before the browser starts, `measured` (+ the measured file's sha256) after it is closed; an exit 3/4 bumps its rev.\n" +
  "      --max-time bounds the whole run (default 180000 ms): past it the browser is closed and nothing is written (exit 4).\n" +
  `  ${scriptCmd("verify-probe")} --check [--project <dir>]\n` +
  "      resolves the project's Playwright and launches chromium once — nothing measured, nothing written.\n" +
  "exit: 0 wrote · 2 usage · 3 renderer unavailable (ask the user to install; never installed here) · 4 the page kept\n" +
  "      navigating / reloaded twice during measurement / was unreachable / timed out / passed --max-time (nothing written).";

const MAX_TIME_DEFAULT = 180_000, CLOSE_CAP_MS = 10_000;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  if (!argv.length) { console.error(USAGE); return 2; }
  const OPTIONS = {
    expected: { type: "string" }, url: { type: "string" }, out: { type: "string" }, ready: { type: "string" }, viewport: { type: "string" },
    project: { type: "string" }, position: { type: "boolean" }, timeout: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" },
    run: { type: "string" }, "max-time": { type: "string" },
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
  const watchdog = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), maxTime); });
  const work = (async (): Promise<number | { run: Extract<ProbeRun, { kind: "ok" }>; identity: ProbeIdentity }> => {
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
    try {
      run = await runProbe(browser, { expectation, url: f.url, ...(f.ready !== undefined ? { ready: f.ready } : {}), viewport, position: !!f.position, timeout });
    } catch (e) {
      await browser.close().catch(() => undefined);
      if (e instanceof UnreachableError) { console.error(`verify-probe: ${e.message} — nothing written.`); return 4; }
      if (/Timeout .*exceeded/i.test(errMsg(e))) { console.error(`verify-probe: timed out — ${errMsg(e).split("\n")[0]} — nothing written.`); return 4; }
      throw e;
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
    return { run, identity };
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
  const { run, identity } = first;
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
  };
  const allNotes = [...notes, ...r.notes];
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
