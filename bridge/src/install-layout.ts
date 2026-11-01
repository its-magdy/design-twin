// install-layout.ts — where this dtwin is installed, and where its plugin files and design-to-code layer are.
//
// One dtwin runs from four layouts, and the paths it hands out (the plugin manifest Figma remembers, the server script
// and the bun a .mcp.json names) must survive each one's upgrades:
//
//   checkout  a clone of the repo: bridge/src/ sits beside figma-plugin/ and design-to-code/ (the sources).
//   package   the npm package: bridge/ is the package root and carries copies — layer/ (the committed design-to-code
//             bundles) and figma-plugin/ (the built plugin) — that bridge/pack.ts puts there at `prepack`.
//   keg       the same package inside a Homebrew keg, `<prefix>/Cellar/<formula>/<version>/…`: Bun resolves the
//             `<prefix>/opt/<formula>` symlink, so import.meta.dirname is the versioned folder the next
//             `brew upgrade` deletes. stable() spells a path through opt instead.
//   bunx      the package in a bunx cache, which Bun replaces or deletes on its own schedule: nothing may point at it.
//
// The directory names below are the one place both sides agree: bridge/pack.ts writes a package with them and
// installOf reads one with them. Everything is asked of an injected file system, so each layout is a table test.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The files Figma loads: the manifest and the two it names (bridge/pack.ts ships exactly these). */
export const PLUGIN_FILES = ["manifest.json", "code.js", "ui.html"] as const;

/** What the npm package carries from outside bridge/, relative to the package root (bridge/). */
export const PACKAGE_DIRS = { layer: "layer", plugin: "figma-plugin", lock: "bun.lock" } as const;
/** A repo checkout's own sources, relative to the repo root (the package root's parent). */
export const CHECKOUT_DIRS = { layer: "design-to-code", plugin: "figma-plugin" } as const;
// A file only a checkout's figma-plugin/ has (the template ui.html is built from); no package ships it.
const CHECKOUT_MARK = "ui.template.html";

/** The two questions the layout asks of a file system (seams for the suites). realpath throws for a missing path. */
export interface LayoutFs {
  exists(p: string): boolean;
  realpath(p: string): string;
}
export const realFs: LayoutFs = { exists: (p) => fs.existsSync(p), realpath: (p) => fs.realpathSync(p) };

/** Where this dtwin's plugin files are: a checkout's figma-plugin/, else the copy the package carries. */
export interface PluginSource { dir: string; kind: "checkout" | "package" }

export type InstallKind = "checkout" | "package" | "keg" | "bunx";

export interface InstallLayout {
  kind: InstallKind;
  /** the plugin files to import or copy from, or null: neither (a package packed without them) */
  pluginSource: PluginSource | null;
  /** the design-to-code module `mod` to import: a checkout's source first, else the package's bundle; null: neither */
  layerUrl(mod: string): URL | null;
  /** `p` spelt so it survives this install's upgrades (through opt under Homebrew); else `p` unchanged */
  stable(p: string): string;
  /** the bunx cache this install sits in, or null */
  bunxCache: string | null;
}

/** The upgrade-proof spelling of a path inside a Homebrew keg. Homebrew installs a formula into a versioned folder,
 *  `<prefix>/Cellar/<formula>/<version>/…`, that the next `brew upgrade` deletes, and keeps `<prefix>/opt/<formula>` as a
 *  symlink to whichever version is current. Bun resolves symlinks, so a file run through that opt link still sees its
 *  Cellar path (import.meta.dirname, process.execPath) — and an absolute path written from it (.mcp.json's server and
 *  bun, the plugin manifest Figma remembers) would stop working after one upgrade. Returns the opt spelling when it
 *  resolves to the very same file, else `p` unchanged (not in a Cellar, or a layout where opt is elsewhere). */
export function stableKegPath(p: string, fsx: LayoutFs = realFs): string {
  const m = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+(?:[\\/](.*))?$/.exec(p);
  if (!m || m[1] === undefined || m[2] === undefined) return p;
  const opt = path.join(m[1], "opt", m[2], m[3] ?? "");
  try { return fsx.realpath(opt) === fsx.realpath(p) ? opt : p; } catch { return p; }
}

/** The bunx cache directory `dir` sits in, or null. `bunx @design-twin/dtwin …` installs the package into a cache tree
 *  (`<tmp or install cache>/.bunx-<uid>/<pkg>`, `<tmp>/bunx-<uid>-<pkg>` on Windows and older Bun) that Bun refreshes
 *  and deletes on its own schedule, so a .mcp.json path into it is a server that one day does not start. */
export function bunxCacheOf(dir: string): string | null {
  const m = /^(.*?[\\/]\.?bunx-[^\\/]+)(?:[\\/]|$)/.exec(dir);
  return m?.[1] ?? null;
}

/** The bun to name in .mcp.json: the one on PATH (Bun.which) when it IS the bun running now — a stable spelling such as
 *  ~/.bun/bin/bun or Homebrew's /opt/homebrew/bin/bun, which survives an upgrade — else this process's own executable.
 *  process.execPath alone is the resolved file, and for a Homebrew (or any versioned) install that is a versioned path
 *  (…/Cellar/bun/1.4.2/bin/bun) the next `brew upgrade` deletes, leaving Claude Code a server it cannot start. */
export function stableBunPath(execPath: string = process.execPath, onPath: string | null = Bun.which("bun"), fsx: LayoutFs = realFs): string {
  if (!onPath) return stableKegPath(execPath, fsx);
  try { return fsx.realpath(onPath) === fsx.realpath(execPath) ? onPath : stableKegPath(execPath, fsx); } catch { return stableKegPath(execPath, fsx); }
}

/** The layout of the install whose bridge/src/ is `here` (default: this file's own folder). */
export function installOf(here: string = import.meta.dirname, fsx: LayoutFs = realFs): InstallLayout {
  const pkg = path.join(here, "..");
  const repo = path.join(pkg, "..");
  const checkoutPlugin = path.join(repo, CHECKOUT_DIRS.plugin);
  const isCheckout = fsx.exists(path.join(checkoutPlugin, CHECKOUT_MARK));
  const packagedPlugin = path.join(pkg, PACKAGE_DIRS.plugin);
  const pluginSource: PluginSource | null =
    isCheckout && fsx.exists(path.join(checkoutPlugin, "manifest.json")) ? { dir: checkoutPlugin, kind: "checkout" }
    : PLUGIN_FILES.every((f) => fsx.exists(path.join(packagedPlugin, f))) ? { dir: packagedPlugin, kind: "package" }
    : null;
  const bunxCache = bunxCacheOf(here);
  const stable = (p: string): string => stableKegPath(p, fsx);
  const kind: InstallKind = bunxCache ? "bunx" : stable(here) !== here ? "keg" : isCheckout ? "checkout" : "package";
  const layerUrl = (mod: string): URL | null => {
    const file = [path.join(repo, CHECKOUT_DIRS.layer, mod + ".ts"), path.join(pkg, PACKAGE_DIRS.layer, mod + ".js")].find((f) => fsx.exists(f));
    return file === undefined ? null : pathToFileURL(file);
  };
  return { kind, pluginSource, layerUrl, stable, bunxCache };
}
