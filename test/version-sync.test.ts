// One version across what a release ships (bridge/release-bump.ts): the CLI/MCP package, the Figma plugin and the
// Claude Code plugin. A tree where they differ would publish a plugin whose hello reports another version than the
// bridge beside it (staleness.ts would call a fresh install stale, or a stale one fresh). No ports, no temp files.
// Run with:  bun test/version-sync.test.ts
import { check, report } from "./assert.ts";
import fs from "node:fs";
import path from "node:path";
import { CHANGELOG, VERSION_FILES, changelogEntry, promoteUnreleased, releaseNotes, readVersion } from "../bridge/release-bump.ts";

console.log("one release version:");
const versions = VERSION_FILES.map((f) => ({ f, v: readVersion(f) }));
for (const { f, v } of versions) check(`${f} has a version (${String(v)})`, typeof v === "string" && /^\d+\.\d+\.\d+/.test(v));
const first = versions[0]?.v;
check(`all equal bridge/package.json's (${String(first)}): ` + versions.map(({ f, v }) => `${f}=${String(v)}`).join(", "),
  versions.every(({ v }) => v === first));

// The release's GitHub notes are its CHANGELOG.md entry (release.yml's preflight refuses a tag without one).
console.log("CHANGELOG.md:");
const log = fs.readFileSync(path.join(import.meta.dirname, "..", CHANGELOG), "utf8");
check(`has a "## [${String(first)}]" entry with notes`, changelogEntry(log, String(first)) !== null);
check(`links ${String(first)}'s compare view`, log.includes(`[${String(first)}]: https://github.com/its-magdy/design-twin/`));

console.log("promoteUnreleased:");
const base = "https://github.com/its-magdy/design-twin/compare";
const before = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a fix\n\n## [1.0.0] - 2026-01-01\n\n- first\n\n[Unreleased]: ${base}/v1.0.0...HEAD\n[1.0.0]: x\n`;
const after = promoteUnreleased(before, "1.0.1", "2026-02-02");
check("moves the Unreleased notes into the new entry", changelogEntry(after, "1.0.1") === "### Fixed\n\n- a fix");
check("leaves an empty Unreleased above it", after.includes("## [Unreleased]\n\n## [1.0.1] - 2026-02-02\n") && changelogEntry(after, "Unreleased") === null);
check("keeps the older entry", changelogEntry(after, "1.0.0") === "- first");
check("updates the compare links", after.includes(`[Unreleased]: ${base}/v1.0.1...HEAD\n[1.0.1]: ${base}/v1.0.0...v1.0.1\n[1.0.0]: x`));
check("leaves a changelog that already has the entry alone", promoteUnreleased(after, "1.0.1", "2027-01-01") === after);
let threw = false;
try { promoteUnreleased(after, "1.0.2", "2026-03-03"); } catch { threw = true; }
check("refuses a release with no Unreleased notes", threw);
check("release notes join a list item's wrapped lines", releaseNotes("### Added\n\n- one\n  two\n- three") === "### Added\n\n- one two\n- three");

report();
