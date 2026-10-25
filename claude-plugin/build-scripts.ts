// Bundles design-to-code/*.ts -> claude-plugin/scripts/*.js (committed; the skills call them as
// ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js).
//
// Why a bundle and not a copy or a symlink: an installed plugin is ONLY the claude-plugin/ directory.
// Many design-to-code modules import ../bridge/src/*.ts, which does not exist there, and a symlink
// pointing outside the plugin directory is not installed at all — so either one ships a plugin whose
// Stop hook and every scripts/ call fail. bundle:true inlines those imports, so each output file is
// self-contained (node: builtins only, which Bun provides). The hooks and skills run each one as
// `bun --no-install --no-env-file <script>.js`.
//
// Why one esbuild build PER ENTRY, and the seam rule it checks: every entry ends in an
// `if (import.meta.main) { …CLI… }` block, and in an ESM bundle every inlined module's `import.meta` IS the bundle's
// own — so an entry inlined into another bundle would run its CLI there (verify-build.js would run cross-check's CLI,
// then exit, instead of its own, silently no-op'ing the Stop hook). The rule that keeps that from happening: NO ENTRY
// MODULE IMPORTS ANOTHER ENTRY MODULE, and no other module carries a CLI guard. What a second module needs from a
// CLI lives in a library module (`<entry>-core.ts` when it is the CLI's own engine). seamViolations() reads each
// build's metafile and the build fails on a breach, so each bundle holds exactly one live guard: its entry's.
//
// Run from the repo root:  bun claude-plugin/build-scripts.ts [outDir]
// (esbuild, not Bun's bundler: Bun's turns import.meta.main into an always-true constant when it targets node+esm, and
// esbuild's output is what the committed files have always been — the byte-for-byte gate below stays meaningful.)
// test/verify-build.test.ts rebuilds into a temp dir and fails if scripts/ is stale — the same
// committed-artifact gate figma-plugin/code.js has.
import path from "node:path";
import fs from "node:fs";
// esbuild is a devDependency of the bridge/ and figma-plugin/ workspaces, hoisted to the repo-root
// node_modules — the bare specifier resolves there.
import esbuild, { type BuildResult } from "esbuild";

const SRC = path.join(import.meta.dirname, "..", "design-to-code");
// The CLI entry points. kinds.ts / catalog-input.ts are libraries — they get inlined, not shipped.
const ENTRIES: readonly string[] = ["audit", "cross-check", "design-diff", "drift-lint", "get-component", "map-bootstrap", "map-validate", "plan-skeleton", "resolve-screen", "tokens", "verifier-guard", "verify-build", "verify-probe", "verify-screen"];

// A CLI guard in code (a mention in a `//` comment is not one).
const CLI_GUARD = /^(?!\s*\/\/).*\bimport\.meta\.main\b/m;

/** Why the bundle of `entry` breaks the seam rule (see the header), from the files its build read (`inputs`: paths
 *  relative to the repo root, as esbuild's metafile names them) and a reader of their source: every OTHER entry it
 *  inlines, and every other inlined source of this repo (bridge/src's included) that carries a CLI guard. Empty when it holds. */
function seamViolations(entry: string, inputs: readonly string[], source: (input: string) => string): string[] {
  const own = `design-to-code/${entry}.ts`;
  const out: string[] = [];
  for (const input of inputs) {
    // every source of this repo the bundle inlines — design-to-code's and bridge/src's alike (a bridge CLI module carries a
    // guard of its own); a dependency under node_modules is not ours to hold to the rule
    if (input === own || !/\.ts$/.test(input) || input.split("/").includes("node_modules")) continue;
    const entryOf = /^design-to-code\/([^/]+)\.ts$/.exec(input)?.[1];
    if (entryOf !== undefined && ENTRIES.includes(entryOf)) out.push(`${own} imports the entry module ${input} — move what it needs into a library module`);
    else if (CLI_GUARD.test(source(input))) out.push(`${input} carries an import.meta.main guard but is no entry — only an entry runs a CLI`);
  }
  return out;
}

// The file mode is part of the output too: a bundle whose source starts with a shebang (esbuild keeps it on line 1 —
// design-diff's `#!/usr/bin/env -S bun --no-install --no-env-file`) is executable (0755), every other one is not (0644),
// whatever mode a previous build or a checkout left — so the committed scripts/ and a rebuild agree on the exec bit
// (test/verify-build.test.ts compares both). Not on Windows, which has no such bit.
function setMode(file: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(2);
  try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, head.toString("latin1") === "#!" ? 0o755 : 0o644);
}

function build(outDir: string): Promise<BuildResult[]> {
  fs.mkdirSync(outDir, { recursive: true });
  return Promise.all(ENTRIES.map(async (n) => {
    const entry = path.resolve(SRC, n + ".ts");
    const result = await esbuild.build({
      entryPoints: [entry],
      outdir: outDir,
      // esbuild writes each inlined module's path (relative to the working dir) into the output as a
      // comment — pin it to the repo root so the bytes don't depend on where the build was run from.
      absWorkingDir: path.join(import.meta.dirname, ".."),
      bundle: true,
      format: "esm",
      platform: "node", // node: builtins stay imports — Bun implements them
      // the runtime is Bun, which runs current syntax as is: nothing is lowered (and the output does not move with a
      // Node version table)
      target: "esnext",
      // Part of every committed scripts/*.js, so it still names build-scripts.js (the pre-TS name).
      banner: { js: "// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.\n" },
      metafile: true,
      logLevel: "silent",
    });
    const root = path.join(import.meta.dirname, "..");
    const breaches = seamViolations(n, Object.keys(result.metafile.inputs), (input) => fs.readFileSync(path.join(root, input), "utf8"));
    if (breaches.length) throw new Error(`[build-scripts] ${n}: ${breaches.join("; ")}`);
    setMode(path.join(outDir, n + ".js"));
    return result;
  }));
}

export { build, seamViolations, ENTRIES };

if (import.meta.main) {
  // argv[2] is the output dir, so a flag must not be taken for one (`--help` used to write bundles into ./--help).
  const arg = process.argv[2];
  if (arg?.startsWith("-")) {
    const help = arg === "--help" || arg === "-h";
    (help ? console.log : console.error)("usage: bun claude-plugin/build-scripts.ts [outDir]\n  bundles design-to-code/*.ts into outDir (default: claude-plugin/scripts)");
    process.exitCode = help ? 0 : 2; // exitCode, not exit(): the line above drains first
  } else {
    const outDir = path.resolve(arg || path.join(import.meta.dirname, "scripts"));
    build(outDir)
      .then(() => console.log(`[build-scripts] wrote ${ENTRIES.length} scripts to ${outDir}`))
      .catch((e: unknown) => { console.error(e); process.exitCode = 1; });
  }
}
