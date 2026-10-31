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
  PLUGIN_FILES, describeState, installPlugin, nextSteps, pluginSource, pluginState, refreshInstalledPlugin,
  resetRefreshForTests, uninstallPlugin,
} from "../bridge/src/plugin-install.ts";
import type { PluginSource } from "../bridge/src/plugin-install.ts";
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
  const un = dtwin(["uninstall"]);
  t("uninstall removes it and says to remove it in Figma too", () => un.code === 0 && !fs.existsSync(home) && un.err.includes("Manage plugins"));
}

for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
report();
