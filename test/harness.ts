// Offline validation harness for the Figma plugin's main thread (figma-plugin/src, built in memory).
// Each case builds its own fake-figma world (test/fake-figma.ts) over the representative file in
// test/harness/scene.ts — a fresh VM, so no case sees another's file or the plugin's run state — then
// drives serialize()/collect*/buildDesignSystem()/the bridge handler and asserts the emitted JSON.
// This needs NO Figma app — run it with:  bun test/harness.ts [area…]   (the areas are the files in test/harness/)
import fs from "node:fs";
import path from "node:path";
import { ok, report } from "./assert.ts";
import { committedBundleFresh } from "./fake-figma.ts";
import { thrown, type Case } from "./harness/helpers.ts";

// In run order. Every file in test/harness/ is an area and must be listed, apart from the two shared modules.
const AREAS: readonly string[] = [
  // the selection read and what serialize() emits per node
  "screen-read", "layout", "paint-effects", "text", "instances-reactions", "design-system", "motion", "read-misc",
  "assets", "library-variables", "pages", "writes",
  "vectors", "manifest-warnings", "geometry", "quick-keys", "page-docs", "library",
  // the bridge side: the run chain, the wire guard, cancel / abandon / liveness
  "progress-cancel", "run-order", "wire-args", "args-shape", "unread", "abandon", "live", "screenshot",
  "hidden-graphics", "same-name-children", "run-context",
];
const SHARED = ["helpers", "scene"];

// A new area file that is not listed would run nothing and fail nothing, so a mismatch stops the run (as run-suites.ts
// does for SUITES).
const onDisk = fs.readdirSync(path.join(import.meta.dirname, "harness")).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
const problems = [
  ...onDisk.filter((a) => !AREAS.includes(a) && !SHARED.includes(a)).map((a) => `test/harness/${a}.ts is not in AREAS (test/harness.ts) — add it`),
  ...AREAS.filter((a) => !onDisk.includes(a)).map((a) => `AREAS lists ${a} but test/harness/${a}.ts does not exist`),
];
const asked = process.argv.slice(2);
const unknown = asked.filter((a) => !AREAS.includes(a));
if (unknown.length > 0) problems.push(`unknown harness area: ${unknown.join(", ")} (one of: ${AREAS.join(", ")})`);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(2);
}

// The cases run against src/, so a committed code.js that is not what src/ builds to would otherwise pass here and
// only fail CI's diff after a push.
ok("figma-plugin/code.js is what figma-plugin/src builds to (else run `bun figma-plugin/build.ts`)", committedBundleFresh);
for (const area of asked.length > 0 ? asked : AREAS) {
  const mod = (await import(`./harness/${area}.ts`)) as { cases: Case[] };
  for (const c of mod.cases) {
    // A case that throws fails by name and the rest still run (its world is its own, so nothing is left half-patched).
    try { await c.run(); } catch (e) { ok(`[${area}] ${c.name}: ran to the end (threw: ${thrown(e).message})`, false); }
  }
}
report();
