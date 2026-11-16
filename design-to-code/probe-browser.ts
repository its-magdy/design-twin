// probe-browser.ts — the project's Playwright and its chromium, for every script that renders a page: the web probe
// (verify-probe.ts) and the page capture (capture-page.ts). Resolving the package, launching the browser, a
// --browser-path, the init script every page gets, and the line a script prints when there is no renderer.
//
// Playwright is the PROJECT's: resolved with createRequire(<project>/package.json) — playwright, then
// @playwright/test, then playwright-core — never bundled, never installed, and no browser is ever downloaded here. Its
// types are `import type` only (erased from the bundle). A package is only resolved once a node_modules/<name>/package.json
// of the project or an ancestor is on disk (packageDirInProject): asked for a package the project does not have, Bun's
// resolver installs it from npm into its global cache (auto-install) — a download, before any check on the answer could
// refuse it. What does resolve must still be inside that node_modules/<name> (installedInProject), or it is not loaded.
//
// A library: no CLI guard (claude-plugin/build-scripts.ts, the seam rule).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Browser, BrowserType, Selectors } from "playwright";
import { PAGE_RUNTIME, registerPathEngine } from "./page-runtime.ts";
import { errMsg, firstLine } from "../bridge/src/errmsg.ts";
import { isJsonObject } from "./types.ts";

// ---------------------------------------------------------------- resolving the project's Playwright
export const PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"] as const;
/** The part of a Playwright package this probe uses (its selectors: the probe's path engine — page-runtime.ts byPath). */
export interface PlaywrightModule { chromium: BrowserType; selectors?: Pick<Selectors, "register"> }
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
export function browserHint(dir: string): string {
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

/** The first <d>/node_modules/<name> holding a package.json, for the project dir and then each ancestor — the directories
 *  the resolution walks (a workspace root's hoisted copy counts) — or null: the project does not have `name`. Asked BEFORE
 *  the project's require resolves `name`, because resolving is what downloads: Bun answers a package that no node_modules
 *  of the project has by installing it from npm into its global cache (auto-install) unless it runs with --no-install, so
 *  a resolve that is only allowed once this finds the package can never fetch it. Only a look at the disk: nothing loaded. */
export function packageDirInProject(dir: string, name: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const pkg = path.join(d, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(pkg, "package.json"))) return pkg;
    if (path.dirname(d) === d) return null;
  }
}

/** Whether `file` (what the project's require resolved `name` to) is that package as the PROJECT has it installed: inside
 *  <d>/node_modules/<name> for the project dir or one of its ancestors — compared as real paths, so a pnpm symlink into
 *  node_modules/.pnpm/ counts too. The second line of defence, after packageDirInProject: the resolution may still
 *  answer from elsewhere (NODE_PATH, a global folder, an exports map pointing out of the package), and that is not the
 *  project's — refused BEFORE it is loaded (loading runs its code). */
export function installedInProject(dir: string, name: string, file: string): boolean {
  const real = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
  const target = real(file) ?? path.resolve(file);
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const pkg = real(path.join(d, "node_modules", ...name.split("/")));
    if (pkg !== null && (target === pkg || target.startsWith(pkg + path.sep))) return true;
    if (path.dirname(d) === d) return false;
  }
}
const notInProject = (name: string, file: string): string => `${name}: resolved outside the project's node_modules (${file}) — not loaded`;

export function resolvePlaywright(dir: string): Resolution {
  const abs = path.resolve(dir);
  const req = projectRequire(abs);
  const tried: string[] = [];
  for (const name of PLAYWRIGHT_PACKAGES) {
    if (packageDirInProject(abs, name) === null) { tried.push(`${name}: not installed`); continue; } // never resolved: no download
    let file: string;
    try { file = req.resolve(name); } catch { tried.push(`${name}: not installed`); continue; }
    if (!installedInProject(abs, name, file)) { tried.push(notInProject(name, file)); continue; }
    let mod: unknown;
    try { mod = req(name); } catch (e) { tried.push(`${name}: failed to load (${firstLine(e)})`); continue; }
    if (!isPlaywrightModule(mod)) { tried.push(`${name}: has no chromium launcher`); continue; }
    let version = "unknown";
    try { const pj: unknown = req(`${name}/package.json`); if (isJsonObject(pj) && typeof pj.version === "string") version = pj.version; } catch { /* exports without ./package.json */ }
    return { ok: true, pkg: name, version, mod, file };
  }
  // Bun does not read Yarn's .pnp.cjs (and `yarn node` would run Node, which is not supported): a PnP project has no
  // node_modules to resolve Playwright from until it installs with the node-modules linker — the user's call, like any install
  const pnp = fs.existsSync(path.join(abs, ".pnp.cjs"))
    ? " — this project uses Yarn Plug'n'Play, which Bun cannot resolve packages through: ask the user to set `nodeLinker: node-modules` in .yarnrc.yml and run `yarn install`, then re-run the probe" : "";
  return { ok: false, reason: `no playwright package resolvable from ${path.join(abs, "package.json")} (${tried.join("; ")})${pnp}`, hint: installHint(abs) };
}

/** the PROJECT's axe-core — never bundled, never installed; absent → the a11y.axe check is not-run. */
export type AxeResolution = { ok: true; source: string; version: string; file: string } | { ok: false; why: string };
export function resolveAxe(dir: string): AxeResolution {
  // not on disk in the project → absent, without resolving it (a resolve is what would download it: packageDirInProject)
  if (packageDirInProject(dir, "axe-core") === null) return { ok: false, why: "axe-core not installed in the project (optional)" };
  const req = projectRequire(dir);
  let file: string;
  try { file = req.resolve("axe-core"); } catch { return { ok: false, why: "axe-core not installed in the project (optional)" }; }
  // a copy from anywhere else (NODE_PATH, a global folder) is not the project's: as absent, and never loaded
  if (!installedInProject(dir, "axe-core", file)) return { ok: false, why: "axe-core not installed in the project (optional)" };
  let mod: unknown;
  try { mod = req("axe-core"); } catch (e) { return { ok: false, why: `axe-core failed to load (${firstLine(e)})` }; }
  if (typeof mod !== "object" || mod === null || !("source" in mod) || typeof mod.source !== "string") return { ok: false, why: "axe-core resolved, but it exports no source" };
  let version = "version" in mod && typeof mod.version === "string" ? mod.version : "unknown";
  try { const pj: unknown = req("axe-core/package.json"); if (isJsonObject(pj) && typeof pj.version === "string") version = pj.version; } catch { /* exports without ./package.json */ }
  return { ok: true, source: mod.source, version, file };
}

/** hint null (a --browser-path that is no executable) → one line: there is nothing to install. */
/** `tool` names the script in the message; `nothing` says what it did not do ("measured or written"). */
export function rendererUnavailable(reason: string, hint: string | null, tool = "verify-probe", nothing = "measured or written"): number {
  if (hint === null) { console.error(`${tool}: renderer unavailable — ${reason} — nothing was ${nothing}.`); return 3; }
  console.error(`${tool}: renderer unavailable — ${reason}\n` +
    `  nothing was ${nothing}. Ask the user to run:  ${hint}\n` +
    `  (${tool} never installs a package or downloads a browser itself.)`);
  return 3;
}

/** The chromium flags the probe launches with; the tests that render a reference or a page for the probe use the same ones. */
export const LAUNCH_ARGS: readonly string[] = ["--disable-lcd-text"];

/** `executablePath` = --browser-path (validated by browserPathError first); absent → Playwright's own chromium. */
export async function launch(r: Extract<Resolution, { ok: true }>, dir: string, executablePath?: string): Promise<{ browser: Browser } | { error: string; hint: string }> {
  // --disable-lcd-text: no layout or measured geometry; only how text is rasterised (and which layers Chromium may composite) —
  // grayscale AA, which Figma's PNG exports use and macOS Chromium uses by default. Linux chromium's default LCD (subpixel RGB)
  // text has colour fringes that depend on each glyph's sub-pixel phase, so unchanged text at the reference's 4-decimal scale
  // came out as hot regions in the visual diff (the e2e's correct twin, on CI).
  // the probe's path engine (page-runtime.ts byPath), on this Playwright's selectors before any context opens
  if (r.mod.selectors) await registerPathEngine(r.mod.selectors);
  try { return { browser: await r.mod.chromium.launch({ headless: true, args: [...LAUNCH_ARGS], ...(executablePath !== undefined ? { executablePath } : {}) }) }; } catch (e) {
    const first = (errMsg(e).split("\n").find((l) => l.trim()) || "launch failed").trim();
    return { error: `${r.pkg} ${r.version} resolved, but chromium did not launch${executablePath !== undefined ? ` from --browser-path ${executablePath} (only guaranteed with the bundled Chromium)` : ""}: ${first}`,
      hint: browserHint(dir) };
  }
}

/** why a --browser-path cannot be launched (not a file, not executable), or null. A macOS .app is a directory:
 *  the binary is inside it. */
export function browserPathError(p: string): string | null {
  let ok = false;
  try { ok = fs.statSync(p).isFile(); if (ok) fs.accessSync(p, fs.constants.X_OK); } catch { ok = false; }
  return ok ? null : `--browser-path ${p} is not an executable file (on macOS pass the binary inside the .app: …/Contents/MacOS/…)`;
}


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
// First of all it installs the probe's page runtime (page-runtime.ts, window.__dt) — the readers every page-side function
// calls — on its own: a runtime that failed to install never stops the rest.
export const INIT_SCRIPT = `try { ${PAGE_RUNTIME} } catch (e) {}
(() => {
  try { Object.defineProperty(window, "__dtProbeDoc", { value: Math.random().toString(36).slice(2), configurable: true }); } catch (e) {}
  const css = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";
  let sheet = null;
  const adopt = () => { try { if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(css); } if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } catch (e) {} };
  adopt();
  const add = () => { adopt(); const s = document.createElement("style"); s.setAttribute("data-dt-probe", ""); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true }); else add();
  addEventListener("load", adopt, { once: true });
})();`;
