// One version across what a release ships (bridge/release-bump.ts): the CLI/MCP package, the Figma plugin and the
// Claude Code plugin. A tree where they differ would publish a plugin whose hello reports another version than the
// bridge beside it (staleness.ts would call a fresh install stale, or a stale one fresh). No ports, no temp files.
// Run with:  bun test/version-sync.test.ts
import { check, report } from "./assert.ts";
import { VERSION_FILES, readVersion } from "../bridge/release-bump.ts";

console.log("one release version:");
const versions = VERSION_FILES.map((f) => ({ f, v: readVersion(f) }));
for (const { f, v } of versions) check(`${f} has a version (${String(v)})`, typeof v === "string" && /^\d+\.\d+\.\d+/.test(v));
const first = versions[0]?.v;
check(`all equal bridge/package.json's (${String(first)}): ` + versions.map(({ f, v }) => `${f}=${String(v)}`).join(", "),
  versions.every(({ v }) => v === first));

report();
