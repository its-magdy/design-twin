// Where a dtwin is installed (bridge/src/install-layout.ts installOf): one table row per layout — a repo checkout, the
// npm package, the package in a Homebrew keg, the package in a bunx cache, a package packed without its copies —
// over a fake file system, plus the constants bridge/pack.ts and bridge/package.json must agree with, and init's
// Claude Code plugin check over a temp home. Binds no port; reads no real HOME.
// Run with:  bun test/install-layout.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, report } from "./assert.ts";
import { CHECKOUT_DIRS, PACKAGE_DIRS, PLUGIN_FILES, installOf, stableBunPath, stableKegPath, type InstallKind, type LayoutFs } from "../bridge/src/install-layout.ts";
import { OUT } from "../bridge/pack.ts";
import { claudePluginInstalled } from "../bridge/src/init.ts";
import { importStep, pluginSource } from "../bridge/src/plugin-install.ts";

const REPO = path.join(import.meta.dirname, "..");
const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  check(name, v);
};

/** A file system of `files` (every parent folder exists too) and `links` (a path → what it resolves to, prefix-wise). */
function fakeFs(files: readonly string[], links: Record<string, string> = {}): LayoutFs {
  const all = new Set<string>();
  for (const f of files) for (let p = f; p !== path.dirname(p); p = path.dirname(p)) all.add(p);
  const resolve = (p: string): string => {
    for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(from + path.sep)) return to + p.slice(from.length);
    return p;
  };
  return {
    exists: (p) => all.has(resolve(p)),
    realpath: (p) => { const r = resolve(p); if (!all.has(r)) throw new Error("ENOENT " + p); return r; },
  };
}
const under = (root: string, rel: readonly string[]): string[] => rel.map((r) => path.join(root, r));
const pluginFiles = (dir: string): string[] => PLUGIN_FILES.map((f) => path.join(dir, PACKAGE_DIRS.plugin, f));
const layerFiles = (dir: string): string[] => ["get-component.js", "drift-lint.js"].map((f) => path.join(dir, PACKAGE_DIRS.layer, f));

const ROOT = path.join(path.sep, "x");
const clone = path.join(ROOT, "src", "design-twin");
const npmPkg = path.join(ROOT, "lib", "node_modules", "@design-twin", "dtwin");
const prefix = path.join(ROOT, "brew");
const keg = path.join(prefix, "Cellar", "dtwin", "0.1.5", "libexec");
const opt = path.join(prefix, "opt", "dtwin", "libexec");
const bunx = path.join(ROOT, "tmp", ".bunx-501", "@design-twin", "dtwin@0.1.5", "node_modules", "@design-twin", "dtwin");
const bare = path.join(ROOT, "lib", "bare");

interface Row {
  what: string;
  pkg: string;
  fsx: LayoutFs;
  kind: InstallKind;
  plugin: { dir: string; kind: "checkout" | "package" } | null;
  layer: string | null;
  stableHere: string;
}
const ROWS: Row[] = [
  {
    what: "a repo checkout",
    pkg: path.join(clone, "bridge"),
    fsx: fakeFs([
      ...under(path.join(clone, CHECKOUT_DIRS.plugin), ["ui.template.html", "manifest.json", "code.js", "ui.html"]),
      path.join(clone, CHECKOUT_DIRS.layer, "get-component.ts"),
      path.join(clone, "bridge", "src", "figma-pull.ts"),
    ]),
    kind: "checkout",
    plugin: { dir: path.join(clone, CHECKOUT_DIRS.plugin), kind: "checkout" },
    layer: path.join(clone, CHECKOUT_DIRS.layer, "get-component.ts"),
    stableHere: path.join(clone, "bridge", "src"),
  },
  {
    what: "the npm package",
    pkg: npmPkg,
    fsx: fakeFs([...pluginFiles(npmPkg), ...layerFiles(npmPkg), path.join(npmPkg, "src", "figma-pull.ts")]),
    kind: "package",
    plugin: { dir: path.join(npmPkg, PACKAGE_DIRS.plugin), kind: "package" },
    layer: path.join(npmPkg, PACKAGE_DIRS.layer, "get-component.js"),
    stableHere: path.join(npmPkg, "src"),
  },
  {
    what: "the package in a Homebrew keg (opt links to the version folder)",
    pkg: keg,
    fsx: fakeFs([...pluginFiles(keg), ...layerFiles(keg), path.join(keg, "src", "figma-pull.ts")], { [path.join(prefix, "opt", "dtwin")]: path.join(prefix, "Cellar", "dtwin", "0.1.5") }),
    kind: "keg",
    plugin: { dir: path.join(keg, PACKAGE_DIRS.plugin), kind: "package" },
    layer: path.join(keg, PACKAGE_DIRS.layer, "get-component.js"),
    stableHere: path.join(opt, "src"),
  },
  {
    what: "the package in a bunx cache",
    pkg: bunx,
    fsx: fakeFs([...pluginFiles(bunx), ...layerFiles(bunx), path.join(bunx, "src", "figma-pull.ts")]),
    kind: "bunx",
    plugin: { dir: path.join(bunx, PACKAGE_DIRS.plugin), kind: "package" },
    layer: path.join(bunx, PACKAGE_DIRS.layer, "get-component.js"),
    stableHere: path.join(bunx, "src"),
  },
  {
    what: "a package packed without its copies",
    pkg: bare,
    fsx: fakeFs([path.join(bare, "src", "figma-pull.ts"), path.join(bare, PACKAGE_DIRS.plugin, "manifest.json")]),
    kind: "package",
    plugin: null,
    layer: null,
    stableHere: path.join(bare, "src"),
  },
];

console.log("installOf — one row per layout (fake file system):");
for (const r of ROWS) {
  const here = path.join(r.pkg, "src");
  const l = installOf(here, r.fsx);
  const url = l.layerUrl("get-component");
  t(`${r.what}: kind ${r.kind}`, () => l.kind === r.kind);
  t(`${r.what}: plugin source ${r.plugin ? r.plugin.kind + " " + path.relative(ROOT, r.plugin.dir) : "none"}`, () =>
    JSON.stringify(l.pluginSource) === JSON.stringify(r.plugin));
  t(`${r.what}: layer module ${r.layer ? path.relative(ROOT, r.layer) : "none"}`, () => (url === null ? null : fileURLToPath(url)) === r.layer);
  t(`${r.what}: a module neither side has is null`, () => l.layerUrl("no-such-module") === null);
  t(`${r.what}: stable(bridge/src) is ${path.relative(ROOT, r.stableHere)}`, () => l.stable(here) === r.stableHere);
  t(`${r.what}: bunx cache ${r.kind === "bunx" ? "named" : "none"}`, () => (l.bunxCache !== null) === (r.kind === "bunx"));
}

console.log("installOf — edge rows:");
t("a checkout's figma-plugin/ without manifest.json falls back to the package's copy", () => {
  const p = path.join(clone, "bridge");
  const l = installOf(path.join(p, "src"), fakeFs([path.join(clone, CHECKOUT_DIRS.plugin, "ui.template.html"), ...pluginFiles(p)]));
  return l.kind === "checkout" && l.pluginSource?.kind === "package" && l.pluginSource.dir === path.join(p, PACKAGE_DIRS.plugin);
});
t("a checkout prefers its design-to-code/ source over a stale layer/ bundle beside it", () => {
  const p = path.join(clone, "bridge");
  const l = installOf(path.join(p, "src"), fakeFs([path.join(clone, CHECKOUT_DIRS.layer, "drift-lint.ts"), ...layerFiles(p)]));
  const u = l.layerUrl("drift-lint");
  return u !== null && fileURLToPath(u) === path.join(clone, CHECKOUT_DIRS.layer, "drift-lint.ts");
});
t("a Cellar path whose opt link points elsewhere is not a keg, and stays as it is", () => {
  const fsx = fakeFs([path.join(keg, "src", "figma-pull.ts"), path.join(prefix, "Cellar", "dtwin", "0.1.6", "libexec", "src", "figma-pull.ts")],
    { [path.join(prefix, "opt", "dtwin")]: path.join(prefix, "Cellar", "dtwin", "0.1.6") });
  const l = installOf(path.join(keg, "src"), fsx);
  return l.kind === "package" && l.stable(path.join(keg, "src")) === path.join(keg, "src");
});
t("stableKegPath / stableBunPath take the same fake file system", () => {
  const cellarBun = path.join(prefix, "Cellar", "bun", "1.4.3", "bin", "bun");
  const optBun = path.join(prefix, "opt", "bun", "bin", "bun");
  const fsx = fakeFs([cellarBun], { [path.join(prefix, "opt", "bun")]: path.join(prefix, "Cellar", "bun", "1.4.3") });
  return stableKegPath(cellarBun, fsx) === optBun && stableBunPath(cellarBun, null, fsx) === optBun && stableBunPath(cellarBun, optBun, fsx) === optBun;
});

console.log("installOf — this repo, on the real file system:");
t("this repo is a checkout, with its own figma-plugin/ and design-to-code/", () => {
  const l = installOf(path.join(REPO, "bridge", "src"));
  const u = l.layerUrl("get-component");
  return l.kind === "checkout" && l.pluginSource?.dir === path.join(REPO, "figma-plugin") && u !== null && fileURLToPath(u) === path.join(REPO, "design-to-code", "get-component.ts");
});
t("plugin-install's pluginSource is installOf's", () => JSON.stringify(pluginSource()) === JSON.stringify(installOf().pluginSource));

console.log("the package's shape — pack.ts and package.json agree with the layout:");
const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO, "bridge", "package.json"), "utf8")) as { files: string[] };
t("pack.ts writes layer/, figma-plugin/ and bun.lock where installOf reads them", () =>
  OUT.layer === path.join(REPO, "bridge", PACKAGE_DIRS.layer) && OUT.plugin === path.join(REPO, "bridge", PACKAGE_DIRS.plugin) && OUT.lock === path.join(REPO, "bridge", PACKAGE_DIRS.lock));
t("package.json `files` ships every one of them", () => Object.values(PACKAGE_DIRS).every((d) => pkgJson.files.includes(d)));
t("the checkout's folders are this repo's", () => Object.values(CHECKOUT_DIRS).every((d) => fs.existsSync(path.join(REPO, d))));

console.log("init — the import step and the Claude Code plugin check:");
t("importStep is the one init prints after \"In Figma DESKTOP, once: \"", () =>
  "In Figma DESKTOP, once: " + importStep("/m/manifest.json") === "In Figma DESKTOP, once: Plugins → Development → Import plugin from manifest… → /m/manifest.json");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-layout-"));
try {
  const home = (name: string): string => { const h = path.join(tmp, name); fs.mkdirSync(path.join(h, ".claude", "plugins"), { recursive: true }); return h; };
  const none = home("none");
  const record = home("record");
  fs.writeFileSync(path.join(record, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "designtwin@designtwin-marketplace": [] } }));
  const dir = home("dir");
  fs.mkdirSync(path.join(dir, ".claude", "plugins", "repos", "designtwin-marketplace"), { recursive: true });
  const other = home("other");
  fs.writeFileSync(path.join(other, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "something-else@m": [] } }));
  t("no home: not installed", () => !claudePluginInstalled(""));
  t("a home without Claude Code plugins: not installed", () => !claudePluginInstalled(path.join(tmp, "missing")) && !claudePluginInstalled(none));
  t("installed_plugins.json naming designtwin: installed", () => claudePluginInstalled(record));
  t("an older layout's designtwin folder: installed", () => claudePluginInstalled(dir));
  t("other plugins only: not installed", () => !claudePluginInstalled(other));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

report();
