// The npm package's bun.lock (bridge/pack.ts): derived from the root lock, then held to it entry by entry, so a
// `bun install --frozen-lockfile` of the tarball (the Homebrew formula) installs exactly what the suites ran against,
// every tarball checked against its sha512. lockProblems is the guard; these are the ways a lock gets past bun
// unpinned. The root lock is the repo's own; the derived ones are edits of a copy of it. No ports, no network.
// Run with:  bun test/pack-lock.test.ts
import fs from "node:fs";
import { check, report } from "./assert.ts";
import { ROOT_LOCK, lockProblems } from "../bridge/pack.ts";

const root: unknown = Bun.JSONC.parse(fs.readFileSync(ROOT_LOCK, "utf8"));
const rootPackages = (root as { packages: Record<string, unknown[]> }).packages;
const ZOD = rootPackages["zod"];
if (!Array.isArray(ZOD)) throw new Error("the root bun.lock has no zod entry — pick another pinned package for this suite");

/** A lock as the derivation writes it: the package as the only workspace, and `packages` (default: zod alone). */
const lockOf = (packages: Record<string, unknown>, workspaces: Record<string, unknown> = { "": { name: "@design-twin/dtwin" } }): unknown => ({ lockfileVersion: 2, workspaces, packages });
const withIntegrity = (integrity: unknown): unknown[] => [ZOD[0], ZOD[1], ZOD[2], integrity];

console.log("the package's bun.lock holds the root lock's pins:");
check("an entry identical to the root's passes", lockProblems(root, lockOf({ zod: ZOD })).length === 0);
check("every root registry entry passes against itself (the root lock pins all with a sha512)",
  lockProblems(root, lockOf(Object.fromEntries(Object.entries(rootPackages).filter(([, e]) => typeof e[1] === "string" && e[1] === "" && typeof e[3] === "string")))).length === 0);

const otherVersion = [String(ZOD[0]).replace(/@[^@]+$/, "@0.0.1"), ZOD[1], ZOD[2], ZOD[3]];
check("a different version is refused", lockProblems(root, lockOf({ zod: otherVersion })).some((p) => p.includes("differs from the root")));
check("a different integrity is refused", lockProblems(root, lockOf({ zod: withIntegrity("sha512-" + "A".repeat(86) + "==") })).some((p) => p.includes("differs from the root")));
check("a package the root lock does not have is refused", lockProblems(root, lockOf({ zod: ZOD, "left-pad": ["left-pad@1.3.0", "", {}, "sha512-" + "A".repeat(86) + "=="] })).some((p) => p.includes("left-pad is not in the root")));
check("an empty lock is refused", lockProblems(root, lockOf({})).some((p) => p.includes("pins no packages")));
check("a lock that still lists the repo's workspaces is refused",
  lockProblems(root, lockOf({ zod: ZOD }, { "": {}, bridge: {}, "figma-plugin": {} })).some((p) => p.includes("workspaces")));
check("something that is not a lock is refused", lockProblems(root, { packages: [] }).length > 0 && lockProblems({}, lockOf({ zod: ZOD })).length > 0);

// bun installs these unchecked (an empty integrity silently; a malformed one with a warning), so they must not pass —
// even if the root lock itself had them.
console.log("an entry bun would install unchecked is refused, even when the root lock has it too:");
for (const [label, integrity] of [["empty", ""], ["malformed", "sha512-notbase64!!"], ["a sha1", "sha1-" + "A".repeat(27) + "="], ["missing", undefined]] as const) {
  const entry = integrity === undefined ? ZOD.slice(0, 3) : withIntegrity(integrity);
  const rootWith = { ...(root as object), packages: { ...rootPackages, zod: entry } };
  check(`${label} integrity`, lockProblems(rootWith, lockOf({ zod: entry })).some((p) => p.includes("no sha512 integrity")));
}

report();
