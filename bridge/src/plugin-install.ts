// plugin-install.ts — the Figma plugin's per-user copy, and `dtwin plugin install|update|status|path|uninstall`.
//
// The plugin cannot be listed on Figma Community, so it is imported as a development plugin: Plugins → Development →
// Import plugin from manifest…. Figma remembers the manifest's PATH, so the folder it was imported from must not move —
// and then replacing the files there is the whole update. With Plugins → Development → Hot reload plugin ON,
// reopening the plugin runs the new code and picks up a changed manifest's permissions too (seen live, Figma
// desktop 126); with it OFF, Figma kept running the code it had loaded. A path inside the npm package does move (Bun's and npm's global
// folders differ, a Node version manager gives every Node its own prefix, a bunx cache is replaced whenever Bun likes,
// an uninstall deletes it), so an install copies the plugin to ONE per-user folder, next to the bridge token:
// <configDir>/figma-plugin (token-store.ts: ~/.config/design-twin, %APPDATA%\design-twin on Windows,
// DESIGNTWIN_CONFIG_DIR overriding both). That is the path to import, once.
//
// A copy whose manifest.json changed (permissions, networkAccess) says so, with re-importing as the fallback for when
// reopening does not pick the change up.
//
// The copy is refreshed — never created — whenever this process is about to bind a bridge (refreshInstalledPlugin,
// from bridge-holder.ts): an upgraded package brings its plugin along with no command to remember, and at that moment
// no plugin is connected to this process, so no export of ours is mid-run when the files change. A dtwin running from
// a repo checkout never refreshes it: a developer imports figma-plugin/ itself, and their copy is theirs.
//
// Each file is written atomically (atomic-write.ts: a tmp file and a rename — the folder itself is never swapped,
// since the path Figma holds must stay the one it imported), ui.html and code.js before manifest.json, install.json
// last, all under one lock (file-lock.ts), so two processes refreshing at once write each file once and a reader
// never sees half a file.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeFileAtomic } from "./atomic-write.ts";
import { errMsg } from "./errmsg.ts";
import { withFileLock } from "./file-lock.ts";
import { sha256Hex } from "./hash.ts";
import { BRIDGE_VERSION } from "./staleness.ts";
import { exitCli } from "./stdio.ts";
import { configDir } from "./token-store.ts";
import { installOf, PLUGIN_FILES, type PluginSource } from "./install-layout.ts";

export { PLUGIN_FILES };
export type { PluginSource };
type PluginFile = (typeof PLUGIN_FILES)[number];
// The manifest last: a manifest that names code.js / ui.html is never on disk before they are.
const WRITE_ORDER: readonly PluginFile[] = ["ui.html", "code.js", "manifest.json"];
const RECORD = "install.json";

/** Where the plugin is installed for this user: <configDir>/figma-plugin. */
export const pluginHome = (): string => path.join(configDir(), "figma-plugin");
const lockOf = (home: string): string => home + ".lock";

/** Where this dtwin's plugin files are: a repo checkout's figma-plugin/ (told apart by the ui.template.html no package
 *  ships), else the copy the npm package carries (install-layout.ts installOf). null: neither (a package packed
 *  without it). */
export function pluginSource(here: string = import.meta.dirname): PluginSource | null {
  return installOf(here).pluginSource;
}

/** What install.json records: the version installed, each file's sha256, from where, when. */
export interface InstallRecord { version: string | null; files: Record<string, string>; from: PluginSource["kind"]; installedAt: string }

function readRecord(home: string): InstallRecord | null {
  try {
    const r: unknown = JSON.parse(fs.readFileSync(path.join(home, RECORD), "utf8"));
    if (typeof r !== "object" || r === null || !("files" in r) || typeof r.files !== "object" || r.files === null) return null;
    return r as InstallRecord; // shape checked above; every other field is only printed
  } catch { return null; }
}
const shaOf = (file: string): string | null => {
  try { return sha256Hex(fs.readFileSync(file)); } catch { return null; }
};
const shas = (dir: string): Record<PluginFile, string | null> =>
  Object.fromEntries(PLUGIN_FILES.map((f) => [f, shaOf(path.join(dir, f))])) as Record<PluginFile, string | null>;

/** The per-user copy as it is now, against this dtwin's own plugin files. */
export interface PluginState {
  home: string;
  /** the manifest to import into Figma: the checkout's own when this dtwin runs from one, else the installed copy's */
  importPath: string;
  source: PluginSource | null;
  /** every plugin file is in the home folder */
  installed: boolean;
  record: InstallRecord | null;
  /** the installed files are byte-for-byte this dtwin's (null: not installed, or nothing to compare with) */
  current: boolean | null;
}
export function pluginState(source: PluginSource | null = pluginSource(), home: string = pluginHome()): PluginState {
  const have = shas(home);
  const installed = PLUGIN_FILES.every((f) => have[f] !== null);
  const want = source ? shas(source.dir) : null;
  const current = installed && want ? PLUGIN_FILES.every((f) => have[f] === want[f]) : null;
  const importPath = source?.kind === "checkout" ? path.join(source.dir, "manifest.json") : path.join(home, "manifest.json");
  return { home, importPath, source, installed, record: readRecord(home), current };
}

export interface InstallResult {
  status: "installed" | "updated" | "current";
  home: string;
  manifest: string;
  version: string | null;
  /** the files rewritten, in the order written */
  written: PluginFile[];
  /** an earlier copy's manifest.json differed (permissions / network access): if reopening does not pick it up, re-import */
  manifestChanged: boolean;
}

/** Copy `source`'s plugin files into `home`, writing only the ones that differ. Idempotent: an up-to-date copy is
 *  left untouched ("current"). */
export function installPlugin(source: PluginSource, home: string = pluginHome(), now: () => Date = () => new Date()): InstallResult {
  fs.mkdirSync(path.dirname(home), { recursive: true });
  return withFileLock(lockOf(home), () => {
    const have = shas(home);
    const fresh = !PLUGIN_FILES.some((f) => have[f] !== null);
    const bytes = Object.fromEntries(PLUGIN_FILES.map((f) => [f, fs.readFileSync(path.join(source.dir, f))])) as Record<PluginFile, Buffer>;
    const want = Object.fromEntries(PLUGIN_FILES.map((f) => [f, sha256Hex(bytes[f])])) as Record<PluginFile, string>;
    const written = WRITE_ORDER.filter((f) => have[f] !== want[f]);
    for (const f of written) writeFileAtomic(path.join(home, f), bytes[f]);
    const record = readRecord(home);
    const recordStale = !record || record.version !== BRIDGE_VERSION || PLUGIN_FILES.some((f) => record.files[f] !== want[f]);
    if (written.length || recordStale) {
      const next: InstallRecord = { version: BRIDGE_VERSION, files: want, from: source.kind, installedAt: now().toISOString() };
      writeFileAtomic(path.join(home, RECORD), JSON.stringify(next, null, 2) + "\n");
    }
    return {
      status: fresh ? "installed" : written.length ? "updated" : "current",
      home,
      manifest: path.join(home, "manifest.json"),
      version: BRIDGE_VERSION,
      written,
      manifestChanged: !fresh && have["manifest.json"] !== null && have["manifest.json"] !== want["manifest.json"],
    };
  });
}

/** Remove the files an install wrote (and the folder, once empty). Anything else in it is left alone. */
export function uninstallPlugin(home: string = pluginHome()): string[] {
  if (!fs.existsSync(home)) return [];
  return withFileLock(lockOf(home), () => {
    const removed: string[] = [];
    for (const f of [...PLUGIN_FILES, RECORD]) {
      const p = path.join(home, f);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(f); }
    }
    try { fs.rmdirSync(home); } catch { /* not empty, or gone: left as it is */ }
    return removed;
  });
}

// Reopening runs replaced files only while Figma's hot reload is on; with it off, Figma kept the old code.
const REOPEN = "reopen the plugin in Figma (Plugins → Development → Design Twin) with Plugins → Development → Hot reload plugin on, to run the new code";
/** The one-time import step, naming `manifest` (init prints it too). */
export const importStep = (manifest: string): string => "Plugins → Development → Import plugin from manifest… → " + manifest;
/** The manifest's folder is hidden in a file picker (a dot folder, or AppData on Windows): how to get there anyway. */
export function hiddenHint(manifest: string): string | null {
  if (process.platform === "darwin" && manifest.split(path.sep).some((s) => s.startsWith("."))) return "the folder is hidden in Finder: in the file picker press ⌘⇧G and paste the path";
  if (process.platform === "win32") return "the folder is hidden in Explorer: paste the path into the file picker's File name box";
  return null;
}
/** What to do in Figma after an install, an update or nothing (empty: nothing to do). */
export function nextSteps(r: InstallResult): string[] {
  if (r.status === "installed") {
    const hint = hiddenHint(r.manifest);
    return ["once, in Figma DESKTOP: " + importStep(r.manifest), ...(hint ? [hint] : []),
      "imported the plugin from somewhere else before (a clone, the package folder)? Remove that one: Plugins → Manage plugins"];
  }
  if (r.manifestChanged) return [REOPEN + "; its manifest (permissions / network access) changed too — if a new permission still does not work, re-import once: " + importStep(r.manifest)];
  if (r.status === "updated") return [REOPEN + " — no re-import needed"];
  return [];
}

let refreshed = false;
/** Bring an EXISTING per-user copy up to this dtwin's plugin files — once per process, never from a checkout, never
 *  creating one. Failures are logged, never thrown: a refresh must not stop a bridge from starting. */
export function refreshInstalledPlugin(log: (m: string) => void, source: PluginSource | null = pluginSource(), home: string = pluginHome()): InstallResult | null {
  if (refreshed) return null;
  refreshed = true;
  if (source?.kind !== "package" || !fs.existsSync(path.join(home, RECORD))) return null;
  try {
    const r = installPlugin(source, home);
    if (r.status !== "current") log(`updated the Figma plugin at ${home} to v${r.version ?? "?"} — ` + (nextSteps(r)[0] ?? ""));
    return r;
  } catch (e) {
    log(`could not refresh the Figma plugin at ${home}: ${errMsg(e)} — run \`dtwin plugin update\``);
    return null;
  }
}
/** Test seam: let refreshInstalledPlugin run again in this process. */
export const resetRefreshForTests = (): void => { refreshed = false; };

/** One line on the state, for `dtwin plugin status` and doctor. */
export function describeState(s: PluginState): { ok: boolean; detail: string; next?: string } {
  if (s.source?.kind === "checkout") return { ok: true, detail: `this dtwin runs from a repo checkout — import ${s.importPath} itself (the per-user copy is not refreshed from here)` };
  if (!s.installed) {
    if (!s.source) return { ok: false, detail: "this dtwin carries no Figma plugin files", next: "reinstall it: bun add -g @design-twin/dtwin" };
    return { ok: false, detail: `not installed in ${s.home}`, next: `dtwin plugin install, then (once) in Figma DESKTOP: ${importStep(s.importPath)}` };
  }
  const v = s.record?.version ? `v${s.record.version} ` : "";
  if (s.current === false) return { ok: false, detail: `${v}at ${s.home} differs from this dtwin's (v${BRIDGE_VERSION ?? "?"})`, next: "dtwin plugin update" };
  return { ok: true, detail: `${v}installed at ${s.home} — import ${s.importPath}` };
}

function reveal(manifest: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", ["-R", manifest]]
    : process.platform === "win32" ? ["explorer", ["/select," + manifest]]
    : ["xdg-open", [path.dirname(manifest)]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => { /* no file manager: the path is printed anyway */ });
    p.unref();
  } catch { /* the path is printed anyway */ }
}

export const PLUGIN_HELP =
  "dtwin plugin [install|update|status|path|uninstall] [--json] [--open]\n\n" +
  "  The Figma plugin is imported into Figma DESKTOP as a development plugin, from a folder that must not move.\n" +
  "  install    copy this dtwin's plugin to a per-user folder (" + path.join("<config dir>", "figma-plugin") + ", beside the bridge\n" +
  "             token; DESIGNTWIN_CONFIG_DIR moves it) and print the one-time import step. Writes only what differs.\n" +
  "  update     the same, then says to reopen the plugin (with Plugins → Development → Hot reload plugin on)\n" +
  "  status     (default) where it is installed, and whether it matches this dtwin\n" +
  "  path       print the manifest to import (stdout): a checkout's own figma-plugin/manifest.json, else the copy's\n" +
  "  uninstall  remove the copied files (then remove the plugin in Figma: Plugins → Manage plugins)\n\n" +
  "  --json     machine output on stdout\n" +
  "  --open     show the manifest in Finder / Explorer (install, update, path)\n\n" +
  "  Once installed, the copy is kept current by itself: every dtwin that starts a bridge refreshes it from its own\n" +
  "  package, so after upgrading @design-twin/dtwin you only reopen the plugin (hot reload on). Never from a checkout.\n" +
  "  Needs no bridge, no plugin and no token; never touches the network.";

const SUBS = ["install", "update", "status", "path", "uninstall"] as const;
type Sub = (typeof SUBS)[number];
const isSub = (s: string | undefined): s is Sub => SUBS.some((x) => x === s);

export function main(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(PLUGIN_HELP); exitCli(0); }
  const json = argv.includes("--json"), open = argv.includes("--open");
  const rest = argv.filter((a) => a !== "--json" && a !== "--open");
  const word = rest[0] ?? "status";
  if (!isSub(word) || rest.length > 1) {
    console.error(`[dtwin plugin] error: unknown \`dtwin plugin ${rest.join(" ")}\` — use: dtwin plugin [${SUBS.join("|")}] [--json] [--open]`);
    exitCli(1);
  }
  const log = (m: string): void => console.error("[dtwin plugin] " + m);
  const source = pluginSource();

  if (word === "status" || word === "path") {
    const s = pluginState(source);
    if (word === "path") {
      console.log(json ? JSON.stringify({ importPath: s.importPath, installed: s.installed || s.source?.kind === "checkout" }) : s.importPath);
      if (!s.installed && s.source?.kind !== "checkout") log("not installed yet — run `dtwin plugin install`");
      if (open) reveal(s.importPath);
      return;
    }
    const d = describeState(s);
    if (json) console.log(JSON.stringify({ ...s, version: BRIDGE_VERSION, ok: d.ok, detail: d.detail, ...(d.next ? { next: d.next } : {}) }, null, 2));
    else {
      log(`${d.ok ? "✓" : "!"} ${d.detail}`);
      if (d.next) log("  → " + d.next);
    }
    return;
  }

  if (word === "uninstall") {
    const removed = uninstallPlugin();
    if (json) console.log(JSON.stringify({ home: pluginHome(), removed }));
    else log(removed.length ? `removed ${removed.join(", ")} from ${pluginHome()} — now remove the plugin in Figma too: Plugins → Manage plugins` : `nothing installed in ${pluginHome()}`);
    return;
  }

  if (!source) {
    log("error: this dtwin carries no Figma plugin files to install — reinstall it: bun add -g @design-twin/dtwin");
    exitCli(1);
  }
  let r: InstallResult;
  try { r = installPlugin(source); } catch (e) {
    log(`error: could not install the Figma plugin into ${pluginHome()}: ${errMsg(e)}`);
    exitCli(1);
  }
  const steps = nextSteps(r);
  if (json) console.log(JSON.stringify({ ...r, next: steps }, null, 2));
  else {
    const what = r.status === "current" ? "already up to date" : r.status;
    log(`✓ Figma plugin v${r.version ?? "?"} ${what} at ${r.home}`);
    for (const s of steps) log("  → " + s);
    if (source.kind === "checkout") log("  note: this dtwin runs from a repo checkout — you can import figma-plugin/manifest.json there directly");
  }
  if (open) reveal(r.manifest);
}
