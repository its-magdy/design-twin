// One version for everything a release ships: the `dtwin` CLI and MCP server (bridge/package.json — the npm package,
// and the tag a release is cut from), the Figma plugin (figma-plugin/package.json, baked into code.js as the version its
// hello reports — staleness.ts compares the two) and the Claude Code plugin (claude-plugin/.claude-plugin/plugin.json).
// test/version-sync.test.ts and release.yml's preflight refuse a tree where they differ.
//
//   bun run release:bump <x.y.z>   (from the repo root)
//
// sets all three, rebuilds the plugin (code.js carries the version), refreshes bun.lock (it records the workspaces'
// versions) and turns CHANGELOG.md's "## [Unreleased]" notes into the "## [x.y.z] - <date>" entry (refusing a release
// with no notes). Then: commit, merge, tag the merged commit v<x.y.z> and push the tag (release.yml).
//
//   bun bridge/release-bump.ts --notes <x.y.z>   prints that version's CHANGELOG.md entry (release.yml's GitHub Release
//                                                 notes); exits 1 if it has none.
import fs from "node:fs";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");
/** Every file whose top-level "version" is the release version. */
export const VERSION_FILES: readonly string[] = ["bridge/package.json", "figma-plugin/package.json", "claude-plugin/.claude-plugin/plugin.json"];
const VERSION_RE = /^(\s*"version"\s*:\s*")[^"]*(")/m;
export const CHANGELOG = "CHANGELOG.md";
const COMPARE = "https://github.com/its-magdy/design-twin/compare";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where `## [<name>]`'s body starts and ends (the next `## ` heading or the link block), or null. */
function section(text: string, name: string): { start: number; end: number } | null {
  const m = new RegExp(`^## \\[${escape(name)}\\][^\\n]*\\n`, "m").exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^(## |\[[^\]]+\]: )/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}

/** The body of `## [<version>]` in a changelog, trimmed; null when it has no such entry or the entry is empty. */
export function changelogEntry(text: string, version: string): string | null {
  const s = section(text, version);
  const body = s ? text.slice(s.start, s.end).trim() : "";
  return body === "" ? null : body;
}

/** A changelog entry as GitHub Release notes: a list item's wrapped lines joined (GitHub renders a newline as a break). */
export function releaseNotes(entry: string): string {
  return entry.replace(/\n {2}(?=\S)/g, " ");
}

/**
 * The changelog with its `## [Unreleased]` notes moved into a new `## [<version>] - <date>` entry, an empty Unreleased
 * left above it, and the compare links updated. Unchanged when `version` already has an entry. Throws when there is
 * nothing to release: no Unreleased section, or an empty one.
 */
export function promoteUnreleased(text: string, version: string, date: string): string {
  if (changelogEntry(text, version) !== null) return text;
  const u = section(text, "Unreleased");
  const notes = u ? text.slice(u.start, u.end).trim() : "";
  if (!u || notes === "") throw new Error(`${CHANGELOG} has no notes under "## [Unreleased]" — write what ${version} changes there first`);
  let out = text.slice(0, u.start) + `\n## [${version}] - ${date}\n\n${notes}\n\n` + text.slice(u.end);
  const link = /^\[Unreleased\]: \S+\/compare\/(\S+)\.\.\.HEAD$/m.exec(out);
  if (link) {
    out = out.replace(link[0], `[Unreleased]: ${COMPARE}/v${version}...HEAD\n[${version}]: ${COMPARE}/${link[1] ?? ""}...v${version}`);
  }
  return out;
}

export function readVersion(rel: string): string | null {
  const v: unknown = (JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8")) as Record<string, unknown>)["version"];
  return typeof v === "string" ? v : null;
}

function bump(version: string): void {
  // First, so a release with no notes stops before any version file changes.
  const log = path.join(REPO, CHANGELOG);
  const notes = promoteUnreleased(fs.readFileSync(log, "utf8"), version, new Date().toISOString().slice(0, 10));
  fs.writeFileSync(log, notes);
  console.log(`[release:bump] ${CHANGELOG} → ## [${version}]`);
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

if (import.meta.main && process.argv[2] === "--notes") {
  const version = process.argv[3] ?? "";
  const entry = changelogEntry(fs.readFileSync(path.join(REPO, CHANGELOG), "utf8"), version);
  if (entry === null) {
    console.error(`${CHANGELOG} has no "## [${version}]" entry. Run bun run release:bump ${version}, or write one.`);
    process.exit(1);
  }
  console.log(releaseNotes(entry));
} else if (import.meta.main) {
  const version = process.argv[2] ?? "";
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error("usage: bun run release:bump <x.y.z> (or x.y.z-alpha.N)");
    process.exit(1);
  }
  bump(version);
  console.log(`[release:bump] done — commit, merge, then tag the merged commit v${version} and push the tag`);
}
