// The Figma plugin's per-user copy (bridge/src/plugin-install.ts): where this dtwin's plugin files are, an
// idempotent install that writes only what differs, the manifest-changed signal, the refresh a bridge start makes
// (once, existing copies only, never from a checkout), uninstall, and `dtwin plugin` as a real child. Temp dirs only;
// binds no port; the user's own config dir is never touched (DESIGNTWIN_CONFIG_DIR for the children).
// Run with:  bun test/plugin-install.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import {
  PLUGIN_FILES, copyToClipboard, describeState, importGuide, installPlugin, nextSteps, openFigmaDesktop, pluginSetup, pluginSource,
  pluginState, refreshInstalledPlugin, resetRefreshForTests, uninstallPlugin,
} from "../bridge/src/plugin-install.ts";
import type { Desktop, PluginSource } from "../bridge/src/plugin-install.ts";
import { PLUGIN_MENU } from "../bridge/src/hints.ts";
import { BRIDGE_VERSION } from "../bridge/src/staleness.ts";

const REPO = path.join(import.meta.dirname, "..");
const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  check(name, v);
};
const roots: string[] = [];
const mk = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-plugin-")); roots.push(d); return d; };
const read = (p: string): string => fs.readFileSync(p, "utf8");
/** A fake package's plugin folder with the three files. */
function fakeSource(kind: PluginSource["kind"] = "package"): PluginSource {
  const dir = path.join(mk(), "figma-plugin");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), "{\"main\":\"code.js\",\"ui\":\"ui.html\"}\n");
  fs.writeFileSync(path.join(dir, "code.js"), "// code v1\n");
  fs.writeFileSync(path.join(dir, "ui.html"), "<!-- ui v1 -->\n");
  return { dir, kind };
}

console.log("pluginSource — a checkout's figma-plugin/ first, else the package's copy:");
{
  const real = pluginSource(path.join(REPO, "bridge", "src"));
  t("this repo's bridge/src finds the checkout's figma-plugin/", () => real?.kind === "checkout" && real.dir === path.join(REPO, "figma-plugin"));
  const pkg = mk();
  fs.mkdirSync(path.join(pkg, "src"));
  fs.mkdirSync(path.join(pkg, "figma-plugin"));
  t("a package without the files has no source", () => pluginSource(path.join(pkg, "src")) === null);
  for (const f of PLUGIN_FILES) fs.writeFileSync(path.join(pkg, "figma-plugin", f), "x");
  const found = pluginSource(path.join(pkg, "src"));
  t("an installed package finds its packed figma-plugin/", () => found?.kind === "package" && found.dir === path.join(pkg, "figma-plugin"));
  const manifest: unknown = JSON.parse(read(path.join(REPO, "figma-plugin", "manifest.json")));
  t("PLUGIN_FILES holds the manifest and the main/ui it names", () =>
    typeof manifest === "object" && manifest !== null && "main" in manifest && "ui" in manifest &&
    PLUGIN_FILES.some((f) => f === manifest.main) && PLUGIN_FILES.some((f) => f === manifest.ui) && PLUGIN_FILES.includes("manifest.json"));
}

console.log("installPlugin — idempotent, only what differs, the manifest last:");
{
  const src = fakeSource();
  const home = path.join(mk(), "cfg", "figma-plugin");
  const first = installPlugin(src, home, () => new Date("2026-01-02T03:04:05Z"));
  t("a first install says installed and writes ui.html, code.js, then manifest.json", () =>
    first.status === "installed" && first.written.join() === "ui.html,code.js,manifest.json" && !first.manifestChanged);
  t("the copies are byte-for-byte the source's", () => PLUGIN_FILES.every((f) => read(path.join(home, f)) === read(path.join(src.dir, f))));
  const rec: unknown = JSON.parse(read(path.join(home, "install.json")));
  t("install.json records the version, the source kind and when", () =>
    typeof rec === "object" && rec !== null && "version" in rec && rec.version === BRIDGE_VERSION && "from" in rec && rec.from === "package" &&
    "installedAt" in rec && rec.installedAt === "2026-01-02T03:04:05.000Z");
  t("the next-steps name the one-time import of the copy's manifest", () => nextSteps(first).some((s) => s.includes("Import plugin from manifest") && s.includes(path.join(home, "manifest.json"))));
  t("no lock or tmp file is left beside it", () => fs.readdirSync(path.dirname(home)).join() === "figma-plugin" && !fs.readdirSync(home).some((n) => n.includes(".tmp-")));

  const recBefore = read(path.join(home, "install.json"));
  const again = installPlugin(src, home);
  t("again: current, nothing written, install.json untouched", () => again.status === "current" && again.written.length === 0 && read(path.join(home, "install.json")) === recBefore);
  t("…and nothing to do in Figma", () => nextSteps(again).length === 0);

  fs.writeFileSync(path.join(src.dir, "code.js"), "// code v2\n");
  t("pluginState sees the copy is not this dtwin's", () => pluginState(src, home).current === false);
  const code = installPlugin(src, home);
  t("a code change: updated, only code.js written, no re-import", () => code.status === "updated" && code.written.join() === "code.js" && !code.manifestChanged);
  t("…the next step is reopening the plugin with hot reload on, not re-importing", () => (nextSteps(code)[0] ?? "").includes("reopen") && (nextSteps(code)[0] ?? "").includes("Hot reload plugin on") && !(nextSteps(code)[0] ?? "").includes("re-import once"));
  t("pluginState: installed and current again", () => { const s = pluginState(src, home); return s.installed && s.current === true; });

  fs.writeFileSync(path.join(src.dir, "manifest.json"), "{\"main\":\"code.js\",\"ui\":\"ui.html\",\"permissions\":[\"teamlibrary\"]}\n");
  const man = installPlugin(src, home);
  t("a manifest change says so: reopen first, re-import once as the fallback", () => man.status === "updated" && man.manifestChanged && (nextSteps(man)[0] ?? "").startsWith("reopen") && (nextSteps(man)[0] ?? "").includes("re-import once"));
}

console.log("pluginState / describeState:");
{
  const src = fakeSource();
  const home = path.join(mk(), "figma-plugin");
  const none = pluginState(src, home);
  t("not installed: the import path is still the copy's, and the next step is dtwin plugin install", () =>
    !none.installed && none.current === null && none.importPath === path.join(home, "manifest.json") && (describeState(none).next ?? "").startsWith("dtwin plugin install"));
  const co = pluginState({ ...src, kind: "checkout" }, home);
  t("from a checkout: import the checkout's own manifest, which is fine", () => co.importPath === path.join(src.dir, "manifest.json") && describeState(co).ok);
  t("no source and nothing installed: not ok, says to reinstall", () => { const d = describeState(pluginState(null, home)); return !d.ok && (d.next ?? "").includes("bun add -g"); });
  installPlugin(src, home);
  t("installed and current: ok", () => describeState(pluginState(src, home)).ok);
}

console.log("refreshInstalledPlugin — what a bridge start does:");
{
  const logs: string[] = [];
  const log = (m: string): void => { logs.push(m); };
  const src = fakeSource();
  const home = path.join(mk(), "figma-plugin");
  resetRefreshForTests();
  t("no copy installed: creates nothing", () => refreshInstalledPlugin(log, src, home) === null && !fs.existsSync(home));
  installPlugin(src, home);
  fs.writeFileSync(path.join(src.dir, "ui.html"), "<!-- ui v2 -->\n");
  resetRefreshForTests();
  t("from a checkout: never refreshed", () => refreshInstalledPlugin(log, { ...src, kind: "checkout" }, home) === null && read(path.join(home, "ui.html")) === "<!-- ui v1 -->\n");
  resetRefreshForTests();
  const r = refreshInstalledPlugin(log, src, home);
  t("an installed copy behind its package is brought up to date, and the log says reopen", () =>
    r?.status === "updated" && read(path.join(home, "ui.html")) === "<!-- ui v2 -->\n" && logs.some((l) => l.includes("updated the Figma plugin") && l.includes("reopen")));
  fs.writeFileSync(path.join(src.dir, "ui.html"), "<!-- ui v3 -->\n");
  t("once per process", () => refreshInstalledPlugin(log, src, home) === null && read(path.join(home, "ui.html")) === "<!-- ui v2 -->\n");
  resetRefreshForTests();
  fs.rmSync(path.join(src.dir, "code.js"));
  const n = logs.length;
  t("a failure is logged, never thrown", () => refreshInstalledPlugin(log, src, home) === null && logs.length === n + 1 && (logs[n] ?? "").includes("dtwin plugin update"));
}

console.log("uninstallPlugin:");
{
  const src = fakeSource();
  const home = path.join(mk(), "figma-plugin");
  installPlugin(src, home);
  fs.writeFileSync(path.join(home, "notes.txt"), "mine");
  const removed = uninstallPlugin(home);
  t("removes the plugin files and install.json, keeps anything else", () =>
    removed.length === 4 && fs.readdirSync(home).join() === "notes.txt");
  fs.rmSync(path.join(home, "notes.txt"));
  installPlugin(src, home);
  uninstallPlugin(home);
  t("an emptied folder goes too", () => !fs.existsSync(home));
  t("nothing installed: nothing removed", () => uninstallPlugin(home).length === 0);
}

console.log("importGuide / pluginSetup — the clicks left in Figma:");
{
  const m = "/Users/someone/.config/design-twin/figma-plugin/manifest.json";
  const mac = importGuide(m, true, "darwin");
  t("four steps: the menu, the picker, run it, the token", () => mac.length === 4 && (mac[0] ?? "").includes("Import plugin from manifest") &&
    (mac[2] ?? "").includes(PLUGIN_MENU) && (mac[3] ?? "").includes("dtwin --show-token"));
  t("macOS: ⌘⇧G, says the path is on the clipboard, and names it", () => (mac[1] ?? "").includes("⌘⇧G") && (mac[1] ?? "").includes("on your clipboard") && (mac[1] ?? "").endsWith(m));
  t("not copied: no clipboard claim, the path still named", () => { const s = importGuide(m, false, "darwin")[1] ?? ""; return !s.includes("clipboard") && s.endsWith(m); });
  const win = importGuide("C:\\Users\\x\\AppData\\Roaming\\design-twin\\figma-plugin\\manifest.json", true, "win32")[1] ?? "";
  t("Windows: the File name box and Ctrl+V", () => win.includes("File name box") && win.includes("Ctrl+V"));
  t("Linux: a plain pick, the path named", () => (importGuide(m, false, "linux")[1] ?? "").endsWith(m));

  const src = fakeSource();
  const home = path.join(mk(), "figma-plugin");
  const before = pluginSetup(pluginState(src, home));
  t("pluginSetup, nothing installed: installed false, the copy's manifest, steps naming it, the note points at dtwin plugin import", () =>
    !before.installed && before.importPath === path.join(home, "manifest.json") && before.steps.some((s) => s.includes(before.importPath)) && before.note.includes("dtwin plugin import"));
  t("…and it creates nothing", () => !fs.existsSync(home));
  installPlugin(src, home);
  t("pluginSetup once installed: installed true", () => pluginSetup(pluginState(src, home)).installed);
  t("pluginSetup from a checkout: installed true, the checkout's manifest", () => {
    const s = pluginSetup(pluginState({ ...src, kind: "checkout" }, mk()));
    return s.installed && s.importPath === path.join(src.dir, "manifest.json");
  });
}

console.log("copyToClipboard / openFigmaDesktop — per platform, against a fake desktop:");
{
  type Call = { cmd: string; args: string[]; input?: string };
  const desk = (platform: NodeJS.Platform, ok: (c: Call) => boolean, files: string[] = [], env: NodeJS.ProcessEnv = {}): { d: Desktop; calls: Call[] } => {
    const calls: Call[] = [];
    const d: Desktop = {
      platform, env, exists: (p) => files.includes(p),
      run: (cmd, args, input) => { const c = input === undefined ? { cmd, args } : { cmd, args, input }; calls.push(c); return ok(c); },
      launch: (cmd, args) => { const c = { cmd, args }; calls.push(c); return ok(c); },
    };
    return { d, calls };
  };
  const p = "/a/b/manifest.json";
  const mac = desk("darwin", () => true);
  t("macOS: pbcopy with the path on stdin", () => copyToClipboard(p, mac.d) && mac.calls[0]?.cmd === "pbcopy" && mac.calls[0].input === p);
  t("macOS: open -a Figma", () => openFigmaDesktop(mac.d) && mac.calls[1]?.cmd === "open" && mac.calls[1].args.join(" ") === "-a Figma");
  const noFigma = desk("darwin", (c) => c.cmd !== "open");
  t("macOS without Figma: false, not thrown", () => !openFigmaDesktop(noFigma.d));

  const wp = "C:\\Users\\O'Neil\\AppData\\Roaming\\design-twin\\figma-plugin\\manifest.json";
  const win = desk("win32", () => true, ["C:\\L\\Figma\\Figma.exe".replaceAll("\\", path.sep)], { LOCALAPPDATA: "C:\\L".replaceAll("\\", path.sep) });
  t("Windows: Set-Clipboard with the path as a quoted argument, ' doubled", () =>
    copyToClipboard(wp, win.d) && win.calls[0]?.cmd === "powershell.exe" && win.calls[0].input === undefined &&
    (win.calls[0].args.at(-1) ?? "") === "Set-Clipboard -Value 'C:\\Users\\O''Neil\\AppData\\Roaming\\design-twin\\figma-plugin\\manifest.json'");
  t("Windows: launches %LOCALAPPDATA%\\Figma\\Figma.exe", () => openFigmaDesktop(win.d) && win.calls[1]?.cmd === path.join("C:\\L".replaceAll("\\", path.sep), "Figma", "Figma.exe"));
  const winNo = desk("win32", () => true, [], { LOCALAPPDATA: "C:\\L" });
  t("Windows without Figma.exe: false, nothing launched", () => !openFigmaDesktop(winNo.d) && winNo.calls.length === 0);
  t("Windows without LOCALAPPDATA: false", () => !openFigmaDesktop(desk("win32", () => true, [path.join("", "Figma", "Figma.exe")]).d));

  const lin = desk("linux", (c) => c.cmd === "xclip");
  t("Linux: wl-copy, then xclip — the first that works", () => copyToClipboard(p, lin.d) && lin.calls.map((c) => c.cmd).join() === "wl-copy,xclip");
  const linNone = desk("linux", () => false);
  t("Linux with no clipboard tool: false after trying all three", () => !copyToClipboard(p, linNone.d) && linNone.calls.length === 3);
  t("Linux: no Figma desktop app to open", () => !openFigmaDesktop(desk("linux", () => true).d));
}

console.log("dtwin plugin — the CLI, as a real child:");
{
  const cfg = mk();
  const env: NodeJS.ProcessEnv = { ...process.env, DESIGNTWIN_CONFIG_DIR: cfg };
  const dtwin = (args: string[]) => {
    const r = Bun.spawnSync(["bun", "--no-install", "--no-env-file", path.join(REPO, "bridge", "src", "figma-pull.ts"), "plugin", ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const help = dtwin(["--help"]);
  t("--help prints the page, exit 0", () => help.code === 0 && help.out.startsWith("dtwin plugin ["));
  const bad = dtwin(["frobnicate"]);
  t("an unknown subcommand is exit 1, naming the ones there are", () => bad.code === 1 && bad.err.includes("install|update|status|path|uninstall"));
  const p = dtwin(["path"]);
  t("path from this checkout: the checkout's own manifest on stdout", () => p.code === 0 && p.out.trim() === path.join(REPO, "figma-plugin", "manifest.json"));
  const inst = dtwin(["install", "--json"]);
  const home = path.join(cfg, "figma-plugin");
  const res: unknown = (() => { try { const v: unknown = JSON.parse(inst.out); return v; } catch { return null; } })();
  t("install --json copies the plugin into <config dir>/figma-plugin", () =>
    inst.code === 0 && typeof res === "object" && res !== null && "status" in res && res.status === "installed" &&
    PLUGIN_FILES.every((f) => read(path.join(home, f)) === read(path.join(REPO, "figma-plugin", f))));
  const again = dtwin(["install"]);
  t("install again: already up to date, and a checkout note", () => again.code === 0 && again.err.includes("already up to date") && again.err.includes("repo checkout"));
  const st = dtwin(["status", "--json"]);
  const sj: unknown = (() => { try { const v: unknown = JSON.parse(st.out); return v; } catch { return null; } })();
  t("status --json: installed, and the checkout is what to import", () =>
    st.code === 0 && typeof sj === "object" && sj !== null && "installed" in sj && sj.installed === true && "importPath" in sj && sj.importPath === path.join(REPO, "figma-plugin", "manifest.json"));
  // import touches the clipboard and opens Figma unless --print-only: the children here never do either.
  const imp = dtwin(["import", "--print-only"]);
  const repoManifest = path.join(REPO, "figma-plugin", "manifest.json");
  t("import --print-only from a checkout: the checkout's manifest, four numbered steps, no clipboard/Figma lines", () =>
    imp.code === 0 && imp.err.includes(repoManifest) && imp.err.includes("  1. ") && imp.err.includes("  4. ") &&
    !imp.err.includes("clipboard —") && !imp.err.includes("opened Figma") && !imp.err.includes("could not open"));
  const ij = dtwin(["import", "--print-only", "--json"]);
  const ijv: unknown = (() => { try { const v: unknown = JSON.parse(ij.out); return v; } catch { return null; } })();
  t("import --print-only --json: manifest, from, copied/figmaOpened false, steps", () =>
    ij.code === 0 && typeof ijv === "object" && ijv !== null && "manifest" in ijv && ijv.manifest === repoManifest && "from" in ijv && ijv.from === "checkout" &&
    "copied" in ijv && ijv.copied === false && "figmaOpened" in ijv && ijv.figmaOpened === false && "steps" in ijv && Array.isArray(ijv.steps) && ijv.steps.length === 4);
  const po = dtwin(["install", "--print-only"]);
  t("--print-only on another subcommand is exit 1", () => po.code === 1 && po.err.includes("--print-only is for"));
  const un = dtwin(["uninstall"]);
  t("uninstall removes it and says to remove it in Figma too", () => un.code === 0 && !fs.existsSync(home) && un.err.includes("Manage plugins"));
}

for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
report();
