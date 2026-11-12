// plugin-install.ts — the Figma plugin's per-user copy, and `dtwin plugin import|install|update|status|path|uninstall`.
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
import { spawn, spawnSync } from "node:child_process";
import { writeFileAtomic } from "./atomic-write.ts";
import { errMsg } from "./errmsg.ts";
import { withFileLock } from "./file-lock.ts";
import { sha256Hex } from "./hash.ts";
import { BRIDGE_VERSION } from "./staleness.ts";
import { exitCli } from "./stdio.ts";
import { configDir } from "./token-store.ts";
import { installOf, PLUGIN_FILES, type PluginSource } from "./install-layout.ts";
import { PLUGIN_MENU, pasteToken } from "./hints.ts";

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
const REOPEN = `reopen the plugin in Figma (${PLUGIN_MENU}) with Plugins → Development → Hot reload plugin on, to run the new code`;
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

// ---- `dtwin plugin import`: the one-time import, made as short as Figma allows ----
// Figma has no API, command line or link that adds a development plugin: the import is its menu and a file picker,
// clicked by the person. So `import` does every step around that click — installs the copy, puts the manifest's path
// on the clipboard, opens Figma desktop — and prints the clicks that are left, numbered. The MCP server's
// figma_status hands an agent the same steps (pluginSetup) when nothing is connected, so it can walk the user through.

/** The clicks left in Figma, for `manifest` on `platform`. `copied`: the path is on the clipboard already. */
export function importGuide(manifest: string, copied: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const onClip = copied ? ", the path is on your clipboard" : "";
  const pick = platform === "darwin" ? `in the file picker press ⌘⇧G, paste the path (⌘V${onClip}), press Return, then Open: ${manifest}`
    : platform === "win32" ? `paste the path into the file picker's File name box (Ctrl+V${onClip}), then Open: ${manifest}`
    : `pick this file in the file picker${copied ? " (its path is on your clipboard)" : ""}, then Open: ${manifest}`;
  return [
    "in Figma DESKTOP (the browser cannot import plugins): Plugins → Development → Import plugin from manifest…",
    pick,
    `run it: ${PLUGIN_MENU} — it stays in that menu from now on, no re-import after updates`,
    `once, ${pasteToken}`,
  ];
}

/** Runs `cmd` to completion (stdin: `input`); true when it exited 0. Never throws. */
export type RunSync = (cmd: string, args: string[], input?: string) => boolean;
/** Starts `cmd` detached, not waiting for it; true when it started. Never throws. */
export type Launch = (cmd: string, args: string[]) => boolean;
export interface Desktop { run: RunSync; launch: Launch; exists: (p: string) => boolean; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }

const runSync: RunSync = (cmd, args, input) => {
  try {
    const r = spawnSync(cmd, args, { input, stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"], timeout: 10_000, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
};
const launchDetached: Launch = (cmd, args) => {
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => { /* reported as not opened by the caller's own check */ });
    p.unref();
    return true;
  } catch { return false; }
};
const realDesktop = (): Desktop => ({ run: runSync, launch: launchDetached, exists: (p) => fs.existsSync(p), env: process.env, platform: process.platform });

/** Put `text` on the system clipboard; false when no clipboard tool worked (the caller prints the text anyway). */
export function copyToClipboard(text: string, d: Desktop = realDesktop()): boolean {
  if (d.platform === "darwin") return d.run("pbcopy", [], text);
  // clip.exe reads stdin in the console's code page and garbles a non-ASCII user name; Set-Clipboard takes the
  // string as an argument instead (a single-quoted PowerShell literal: only ' needs escaping, by doubling it).
  if (d.platform === "win32") return d.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${text.replaceAll("'", "''")}'`]);
  return d.run("wl-copy", [], text) || d.run("xclip", ["-selection", "clipboard"], text) || d.run("xsel", ["--clipboard", "--input"], text);
}

/** Open (or bring forward) the Figma desktop app; false when it could not be found. Figma ships no Linux app. */
export function openFigmaDesktop(d: Desktop = realDesktop()): boolean {
  if (d.platform === "darwin") return d.run("open", ["-a", "Figma"]);
  if (d.platform === "win32") {
    const exe = path.join(d.env.LOCALAPPDATA ?? "", "Figma", "Figma.exe");
    return d.env.LOCALAPPDATA !== undefined && d.exists(exe) && d.launch(exe, []);
  }
  return false;
}

/** For the MCP server's figma_status when no plugin is connected: whether the copy is there, what to import, and
 *  the clicks — no side effects (an MCP call must not touch the user's clipboard or open apps by itself). */
export function pluginSetup(s: PluginState = pluginState()): { installed: boolean; importPath: string; note: string; steps: string[] } {
  return {
    installed: s.installed || s.source?.kind === "checkout",
    importPath: s.importPath,
    note: "If Design Twin is not in Figma's Plugins → Development menu yet, it was never imported: a one-time step only the user can " +
      "click, in Figma desktop. `dtwin plugin import` (in a terminal) installs the copy, puts its path on the clipboard and opens Figma; " +
      "then walk the user through `steps`. Already imported? Only the run step is needed.",
    steps: importGuide(s.importPath, false),
  };
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
  "dtwin plugin [import|install|update|status|path|uninstall] [--json] [--open] [--print-only]\n\n" +
  "  The Figma plugin is imported into Figma DESKTOP as a development plugin, from a folder that must not move.\n" +
  "  import     the one-time setup, walked through: install (as below), put the manifest's path on the clipboard, open\n" +
  "             Figma desktop, and print the clicks left (Figma lets no program do the import itself).\n" +
  "             --print-only: print the steps, touch neither the clipboard nor Figma\n" +
  "  install    copy this dtwin's plugin to a per-user folder (" + path.join("<config dir>", "figma-plugin") + ", beside the bridge\n" +
  "             token; DESIGNTWIN_CONFIG_DIR moves it) and print the one-time import step. Writes only what differs.\n" +
  "  update     the same, then says to reopen the plugin (with Plugins → Development → Hot reload plugin on)\n" +
  "  status     (default) where it is installed, and whether it matches this dtwin\n" +
  "  path       print the manifest to import (stdout): a checkout's own figma-plugin/manifest.json, else the copy's\n" +
  "  uninstall  remove the copied files (then remove the plugin in Figma: Plugins → Manage plugins)\n\n" +
  "  --json     machine output on stdout\n" +
  "  --open     show the manifest in Finder / Explorer (import, install, update, path)\n\n" +
  "  Once installed, the copy is kept current by itself: every dtwin that starts a bridge refreshes it from its own\n" +
  "  package, so after upgrading @design-twin/dtwin you only reopen the plugin (hot reload on). Never from a checkout.\n" +
  "  Needs no bridge, no plugin and no token; never touches the network.";

const SUBS = ["import", "install", "update", "status", "path", "uninstall"] as const;
type Sub = (typeof SUBS)[number];
const isSub = (s: string | undefined): s is Sub => SUBS.some((x) => x === s);

/** `dtwin plugin import`. A checkout imports its own figma-plugin/ (nothing is installed); a package installs (or
 *  refreshes) the per-user copy first, exactly as `install` does. */
function importCmd(source: PluginSource, o: { json: boolean; open: boolean; printOnly: boolean; log: (m: string) => void }): void {
  let r: InstallResult | null = null;
  if (source.kind === "package") {
    try { r = installPlugin(source); } catch (e) {
      o.log(`error: could not install the Figma plugin into ${pluginHome()}: ${errMsg(e)}`);
      exitCli(1);
    }
  }
  const manifest = r ? r.manifest : path.join(source.dir, "manifest.json");
  const copied = !o.printOnly && copyToClipboard(manifest);
  const figmaOpened = !o.printOnly && openFigmaDesktop();
  const steps = importGuide(manifest, copied);
  if (o.json) console.log(JSON.stringify({ manifest, from: source.kind, install: r, copied, figmaOpened, steps }, null, 2));
  else {
    o.log(r ? `✓ Figma plugin v${r.version ?? "?"} ${r.status === "current" ? "already up to date" : r.status} at ${r.home}`
      : `✓ this dtwin runs from a repo checkout — import its own ${manifest}`);
    if (!o.printOnly) {
      o.log(copied ? "✓ the manifest's path is on your clipboard" : "! could not reach the clipboard — copy the path from step 2");
      o.log(figmaOpened ? "✓ opened Figma desktop" : "! could not open Figma desktop — open it yourself");
    }
    if (r && r.status !== "installed") {
      for (const s of nextSteps(r)) o.log("  → " + s);
      o.log("  imported it before? Then skip to step 3: Figma remembers it, and updates need no re-import");
    }
    o.log("Now, in Figma:");
    steps.forEach((s, i) => { o.log(`  ${i + 1}. ${s}`); });
    if (r?.status === "installed") o.log("  imported the plugin from somewhere else before (a clone, the package folder)? Remove that one: Plugins → Manage plugins");
  }
  if (o.open) reveal(manifest);
}

export function main(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(PLUGIN_HELP); exitCli(0); }
  const json = argv.includes("--json"), open = argv.includes("--open"), printOnly = argv.includes("--print-only");
  const rest = argv.filter((a) => a !== "--json" && a !== "--open" && a !== "--print-only");
  const word = rest[0] ?? "status";
  if (!isSub(word) || rest.length > 1) {
    console.error(`[dtwin plugin] error: unknown \`dtwin plugin ${rest.join(" ")}\` — use: dtwin plugin [${SUBS.join("|")}] [--json] [--open] [--print-only]`);
    exitCli(1);
  }
  if (printOnly && word !== "import") {
    console.error("[dtwin plugin] error: --print-only is for `dtwin plugin import`");
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
  if (word === "import") { importCmd(source, { json, open, printOnly, log }); return; }
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
    if (r.status === "installed") log("  tip: `dtwin plugin import` puts that path on your clipboard and opens Figma for you");
    if (source.kind === "checkout") log("  note: this dtwin runs from a repo checkout — you can import figma-plugin/manifest.json there directly");
  }
  if (open) reveal(r.manifest);
}
