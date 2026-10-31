// What the npm package carries from OUTSIDE bridge/: npm's `files` cannot reach past the package root, so `prepack`
// copies it in and `postpack` takes it out again (both gitignored; a checkout never reads these copies — the repo's
// own design-to-code/ and figma-plugin/ come first, see figma-mcp.ts loadLayer and init.ts).
//
//   layer/         the design-to-code bundles design_get_component / design_drift_lint load in an installed package.
//                  The committed claude-plugin/scripts/*.js, not design-to-code/*.ts: each bundle is self-contained
//                  (node: builtins only — its ../bridge/src imports are inlined), where the sources import
//                  ../bridge/src/*.ts, a path an installed package does not have. test/verify-build.test.ts fails
//                  when a committed bundle is stale, so a tagged commit's are its sources'.
//   figma-plugin/  the built Figma plugin (manifest.json + the committed code.js / ui.html it names), so an install
//                  can "Import plugin from manifest" — `dtwin init` prints the path.
//   bun.lock       the package's own lockfile, holding every dependency (transitive ones too) at the version and
//                  integrity the repo's root bun.lock pins — what the suites ran against. An install from the tarball
//                  with `bun install --production --frozen-lockfile` (the Homebrew formula) gets exactly those, each
//                  tarball checked against its sha512, instead of whatever npm serves that day. The root lock cannot
//                  ship as is: it lists the workspaces, and a frozen install in the package refuses it. So it is
//                  derived (deriveLock) and then held to the root's pins entry by entry (lockProblems).
//                  npx / bunx / `bun add -g` never read a package's own lockfile; this pins the Homebrew install.
//
// Run from bridge/ (npm runs lifecycle scripts in the package dir):  bun pack.ts [--clean]
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PLUGIN_FILES } from "./src/plugin-install.ts";
import { errMsg } from "./src/errmsg.ts";

const PKG = import.meta.dirname;
const REPO = path.join(PKG, "..");
const BUNDLES = path.join(REPO, "claude-plugin", "scripts");
// The two the MCP server loads, and every script their printed hints name (scriptCmd — cli-args.ts makes it a path
// beside the bundle itself, so a hint naming a script not shipped here would be a command that cannot run).
// pack() holds this list to that (missingHints).
export const LAYER: readonly string[] = ["get-component", "drift-lint", "map-bootstrap", "map-validate", "cross-check"];
// The files Figma loads — one list with the per-user install that copies them on (`dtwin plugin install`).
const PLUGIN: readonly string[] = PLUGIN_FILES;
export const OUT = { layer: path.join(PKG, "layer"), plugin: path.join(PKG, "figma-plugin"), lock: path.join(PKG, "bun.lock") } as const;
export const ROOT_LOCK = path.join(REPO, "bun.lock");

/** The scripts a bundle's printed hints name (`scriptCmd("<name>")`) that `shipped` does not hold. */
export function missingHints(source: string, shipped: readonly string[]): string[] {
  return [...source.matchAll(/scriptCmd\("([\w-]+)"\)/g)].map((m) => m[1] ?? "").filter((n) => !shipped.includes(n));
}

// A registry package's entry in bun.lock is [ "name@version", registry, { deps… }, "sha512-…" ]. Bun checks a
// downloaded tarball against that last field — but skips the check, with at most a warning, when the field is empty or
// not a hash it can parse. So an entry is only pinned if the field is a whole sha512 (64 bytes, base64).
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `derived` (the package's lock) is not exactly `root`'s pins, as messages; [] when it is. Every package entry must
 *  appear in the root lock, identical (same version, same integrity), and carry a full sha512; the only workspace is
 *  the package itself. Both are parsed bun.lock (JSONC) values. */
export function lockProblems(root: unknown, derived: unknown): string[] {
  if (!isRecord(root) || !isRecord(root.packages)) return ["the root bun.lock has no packages"];
  if (!isRecord(derived) || !isRecord(derived.packages) || !isRecord(derived.workspaces)) return ["the package's bun.lock has no packages/workspaces"];
  const problems: string[] = [];
  const workspaces = Object.keys(derived.workspaces);
  if (workspaces.length !== 1 || workspaces[0] !== "") problems.push(`the package's bun.lock lists workspaces ${JSON.stringify(workspaces)} — expected only the package itself`);
  const entries = Object.entries(derived.packages);
  if (!entries.length) problems.push("the package's bun.lock pins no packages");
  for (const [key, entry] of entries) {
    const pinned = root.packages[key];
    if (pinned === undefined) { problems.push(`${key} is not in the root bun.lock`); continue; }
    if (JSON.stringify(entry) !== JSON.stringify(pinned)) { problems.push(`${key} differs from the root bun.lock (${JSON.stringify(entry).slice(0, 80)}… vs ${JSON.stringify(pinned).slice(0, 80)}…)`); continue; }
    const integrity: unknown = Array.isArray(entry) ? (entry as unknown[])[3] : undefined;
    if (typeof integrity !== "string" || !SHA512.test(integrity)) problems.push(`${key} has no sha512 integrity (${JSON.stringify(integrity)}), so bun would install it unchecked`);
  }
  return problems;
}

/** The package's bun.lock, from the root one: bridge/package.json alone in a scratch folder, seeded with the root lock,
 *  `bun install --lockfile-only`. Bun drops the workspaces and keeps every locked version that still satisfies the
 *  package's ranges; it does fetch the direct dependencies' manifests (network), which is why lockProblems then holds
 *  the result to the root's pins rather than trusting the resolve. Returns the lock's text. */
export function deriveLock(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-lock-"));
  try {
    fs.copyFileSync(path.join(PKG, "package.json"), path.join(tmp, "package.json"));
    fs.copyFileSync(ROOT_LOCK, path.join(tmp, "bun.lock"));
    const r = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts", "--no-progress"], { cwd: tmp, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`[pack] bun install --lockfile-only failed (exit ${r.exitCode}): ${r.stderr.toString().trim().slice(-600)}`);
    return fs.readFileSync(path.join(tmp, "bun.lock"), "utf8");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function clean(): void {
  for (const p of Object.values(OUT)) fs.rmSync(p, { recursive: true, force: true });
}

export function pack(): void {
  clean();
  fs.mkdirSync(OUT.layer, { recursive: true });
  fs.mkdirSync(OUT.plugin, { recursive: true });
  const problems: string[] = [];
  for (const n of LAYER) {
    const src = path.join(BUNDLES, n + ".js");
    const dangling = missingHints(fs.readFileSync(src, "utf8"), LAYER);
    if (dangling.length) problems.push(`${n}.js names ${dangling.join(", ")}, which the package does not ship — add it to LAYER`);
    fs.copyFileSync(src, path.join(OUT.layer, n + ".js"));
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(REPO, "figma-plugin", "manifest.json"), "utf8"));
  // The manifest names the files Figma loads; ship exactly those, so a renamed bundle cannot leave a manifest
  // pointing at nothing.
  if (typeof manifest !== "object" || manifest === null || !("main" in manifest) || !("ui" in manifest) ||
    !PLUGIN.includes(String(manifest.main)) || !PLUGIN.includes(String(manifest.ui))) {
    problems.push("figma-plugin/manifest.json's main/ui are not among the files shipped — update PLUGIN");
  }
  for (const f of PLUGIN) fs.copyFileSync(path.join(REPO, "figma-plugin", f), path.join(OUT.plugin, f));
  try {
    const lock = deriveLock();
    const wrong = lockProblems(Bun.JSONC.parse(fs.readFileSync(ROOT_LOCK, "utf8")), Bun.JSONC.parse(lock));
    if (wrong.length) problems.push("bun.lock is not the root bun.lock's pins: " + wrong.join("; "));
    else fs.writeFileSync(OUT.lock, lock);
  } catch (e) {
    problems.push(errMsg(e));
  }
  if (problems.length) {
    clean();
    throw new Error("[pack] " + problems.join("; "));
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--clean") clean();
  else {
    pack();
    console.log(`[pack] copied ${LAYER.length} design-to-code bundles to layer/, the Figma plugin to figma-plugin/, and wrote bun.lock (the root lock's pins)`);
  }
}
