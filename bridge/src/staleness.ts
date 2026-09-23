// staleness.ts — the plugin/daemon version-staleness notes, split out of server-core.ts so the CLI's
// pure, test-driven helpers (figma-pull.ts formatClients) and doctor.ts can use them WITHOUT loading
// server-core, whose module load resolves the bridge token and exits the process on a bad
// FIGMA_BRIDGE_PORT. This module's only load-time effect is reading bridge/package.json for
// BRIDGE_VERSION. server-core.ts re-exports all three public names, so its surface is unchanged.
import fs from "node:fs";

// Finding 327: the plugin used to report no version at all, so a stale bundle in Figma (several fixes
// live only in figma-plugin/code.js — SVG normalisation, case-folded asset names) could not be told
// apart from a fresh one — a plugin instance's startedAt and code.js's own mtime can land in the same
// minute either way. `BRIDGE_VERSION` is this PACKAGE's version (bridge/package.json — the CLI/MCP the
// user is actually running); `pluginStalenessNote` compares it against whatever the connected plugin
// announced in its `hello`. A simple numeric [major,minor,patch] compare, not semver ranges: this is an
// internal tool with one version number moving in one repo, not a published dependency graph.
export const BRIDGE_VERSION: string | null = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch (e) { return null; }
})();
type Version = [number, number, number];
function parseVersion(v: unknown): Version | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function versionOlder(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}
// `null` means "nothing to warn about" — the plugin reported a version, and it isn't older than this
// CLI/MCP. Everything else IS worth a warn, including a MISSING version: the first live check of this
// exact feature found a real daemon + a real Figma plugin both still running pre-327 code, and doctor
// said nothing — `list clients --json` printed `pluginVersion: null, pluginStale: null` for both
// files, because the old logic only ever compared two REAL version strings and treated "didn't report
// one" as "nothing to check," which is backwards: no version at all is the ONE case we can be certain
// predates this feature, so it is unconditionally worth a warning, not a silent pass.
export function pluginStalenessNote(pluginVersion: unknown): string | null {
  if (typeof pluginVersion !== "string" || !pluginVersion) {
    return "plugin bundle predates version reporting (or the daemon was started before this bridge was updated) — " +
      "re-run Plugins → Development → Design Twin in Figma and restart `dtwin serve`";
  }
  const p = parseVersion(pluginVersion), b = parseVersion(BRIDGE_VERSION);
  if (!p || !b || !versionOlder(p, b)) return null;
  return `plugin v${pluginVersion} is older than this ${BRIDGE_VERSION} bridge — reload the plugin in Figma (Plugins → Development → Design Twin) to pick up recent fixes`;
}

// Distinct from the above: this fires when the CLIENT ROW ITSELF has no `pluginVersion` KEY at all
// (`"pluginVersion" in row` is false), which is not the same as the key being present and `null`.
// `describe()` in server-core.ts always sets the key — to a string or explicitly to `null` — for any bridge
// running this code, so a row with the key entirely absent can only have come from an OLDER daemon's
// own (pre-327) `describe()`, read back over its status socket by a NEWER `dtwin` CLI. That is a
// second, independent kind of staleness this tool can detect: not just "the Figma plugin is old" but
// "the long-running `dtwin serve` process itself predates this bridge version and needs restarting" —
// which reloading the Figma plugin alone will not fix, since the daemon in front of it is what's stale.
export function daemonRowStalenessNote(row: unknown): string | null {
  if (row && typeof row === "object" && !("pluginVersion" in row)) {
    return "the `dtwin serve` daemon in front of this connection predates plugin-version reporting — restart it (`dtwin serve --stop` then `dtwin serve`) to pick up recent fixes";
  }
  return null;
}
