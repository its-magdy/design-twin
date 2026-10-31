// One version for everything a release ships: the `dtwin` CLI and MCP server (bridge/package.json — the npm package,
// and the tag a release is cut from), the Figma plugin (figma-plugin/package.json, baked into code.js as the version its
// hello reports — staleness.ts compares the two) and the Claude Code plugin (claude-plugin/.claude-plugin/plugin.json).
// test/version-sync.test.ts and release.yml's preflight refuse a tree where they differ.
//
//   bun run release:bump <x.y.z>   (from the repo root)
//
// sets all three, rebuilds the plugin (code.js carries the version) and refreshes bun.lock (it records the
// workspaces' versions). Then: commit, merge, tag the merged commit v<x.y.z> and push the tag (release.yml).
import fs from "node:fs";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");
/** Every file whose top-level "version" is the release version. */
export const VERSION_FILES: readonly string[] = ["bridge/package.json", "figma-plugin/package.json", "claude-plugin/.claude-plugin/plugin.json"];
const VERSION_RE = /^(\s*"version"\s*:\s*")[^"]*(")/m;

export function readVersion(rel: string): string | null {
  const v: unknown = (JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8")) as Record<string, unknown>)["version"];
  return typeof v === "string" ? v : null;
}

function bump(version: string): void {
  for (const rel of VERSION_FILES) {
    const file = path.join(REPO, rel);
    const text = fs.readFileSync(file, "utf8");
    if (!VERSION_RE.test(text)) throw new Error(`${rel} has no "version" line to set`);
    fs.writeFileSync(file, text.replace(VERSION_RE, `$1${version}$2`));
    console.log(`[release:bump] ${rel} → ${version}`);
  }
  const run = (args: string[]): void => {
    console.log("[release:bump] bun " + args.join(" "));
    const r = Bun.spawnSync(["bun", ...args], { cwd: REPO, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`bun ${args.join(" ")} exited ${String(r.exitCode)}`);
  };
  run(["figma-plugin/build.ts"]);
  run(["install"]);
}

if (import.meta.main) {
  const version = process.argv[2] ?? "";
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error("usage: bun run release:bump <x.y.z> (or x.y.z-alpha.N)");
    process.exit(1);
  }
  bump(version);
  console.log(`[release:bump] done — commit, merge, then tag the merged commit v${version} and push the tag`);
}
