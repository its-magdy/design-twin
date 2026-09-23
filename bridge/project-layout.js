// project-layout.js — the ONE definition of where a Design Twin project keeps things.
//
// The layout used to be "everything under design/", which put two incompatible kinds of file in one
// directory: what a pull WRITES and may overwrite without asking (pages/, design-system/, assets/,
// variables.json), and what a human or a build step OWNS and cannot regenerate (target.json, the
// component map, the plan, the audit, the verification evidence). "Delete design/ and re-pull" is the
// obvious recovery move for a bad export, and it silently destroyed the second kind — including a
// component map that can represent hours of hand-mapping. The component map dodged that by living at
// the repo root instead, which only meant the line was drawn in two different places.
//
// So the line is drawn once, and where it can be seen:
//
//   design/
//     export/                  <- dtwin writes ONLY here. Safe to delete and re-pull.
//       pages/<Page>/<Screen>__<id>.json      the screen tree, its .vars.json and .assets.json
//       pages/index.json                      every screen pulled, whatever the pull shape
//       design-system/                        tokens, styles, component catalogs
//       libraries/<slug>/                     a --as-library export
//       assets/                               shared, cumulative
//       variables.json                        the union of every screen slice
//     target.json              <- the stack. Written by init, confirmed by build-screen.
//     codeconnect.local.json   <- the component map. HAND-OWNED; a re-pull must never touch it.
//     plan/<Screen>.json       <- build-screen's plan and decisions
//     audit/<Screen>.{md,json} <- audit-design
//     verify/<Screen>.{expected,report}.json  <- verify's machine-readable evidence
//
// Projects created before this split have their export directly in design/. Nothing rewrites them:
// findExportDir() recognises the old shape and every consumer keeps working, while doctor says which
// layout it found so the difference is never a silent surprise.

const fs = require("fs");
const path = require("path");

const DESIGN_DIR = "design";
const EXPORT_SUBDIR = "export";
const EXPORT_DIR = path.join(DESIGN_DIR, EXPORT_SUBDIR);
const TARGET_FILE = path.join(DESIGN_DIR, "target.json");
const MAP_FILE = path.join(DESIGN_DIR, "codeconnect.local.json");
const PLAN_DIR = path.join(DESIGN_DIR, "plan");
const AUDIT_DIR = path.join(DESIGN_DIR, "audit");
const VERIFY_DIR = path.join(DESIGN_DIR, "verify");

// The marks of an export directory, in the order a pull creates them. Used to tell "this project uses
// the old flat layout" from "this project has no export yet", which are different problems with
// different fixes.
const EXPORT_MARKERS = ["pages", "design-system", "design-system.json", "variables.json", "assets", "libraries"];

function looksLikeExportDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return EXPORT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

// Where THIS project's export actually is. Prefers the current layout; falls back to the legacy one
// only when that directory really holds an export, so a fresh `design/` with nothing but target.json
// in it is reported as "no export yet" rather than as a legacy project.
function findExportDir(cwd) {
  const modern = path.join(cwd, EXPORT_DIR);
  const legacy = path.join(cwd, DESIGN_DIR);
  const modernExists = looksLikeExportDir(modern);
  const legacyExists = looksLikeExportDir(legacy);
  // Both layouts present at once (P4 #14/#33/#203's fallout): a stray `dtwin pull design …` wrote a
  // second, parallel export tree directly in design/ beside the real design/export/. The modern one
  // still wins (it is where every tool looks), but the caller must be told the legacy one exists too
  // — picking one silently is exactly what a project in this state cannot afford, since the two trees
  // can disagree (e.g. two different `variables.json`).
  if (modernExists) return { dir: modern, layout: "export-subdir", rel: EXPORT_DIR, parallelLegacy: legacyExists };
  if (legacyExists) return { dir: legacy, layout: "legacy-flat", rel: DESIGN_DIR };
  return { dir: modern, layout: "none", rel: EXPORT_DIR };
}

// The component map moved from the repo root into design/. An existing project's root copy is still
// the real one — finding it and saying so beats writing a second map beside it and linting the wrong one.
function findMapFile(cwd) {
  const modern = path.join(cwd, MAP_FILE);
  if (fs.existsSync(modern)) return { file: modern, rel: MAP_FILE, legacy: false };
  const legacy = path.join(cwd, "codeconnect.local.json");
  if (fs.existsSync(legacy)) return { file: legacy, rel: "codeconnect.local.json", legacy: true };
  return { file: modern, rel: MAP_FILE, legacy: false, missing: true };
}

// Shipped into design/ by `dtwin init`, because the one thing this layout has to communicate is which
// half of it a re-pull is allowed to destroy — and a comment in a source file cannot do that.
const README = `# design/

Two kinds of file live here, and the difference matters.

## design/export/ — dtwin owns this

Everything \`dtwin pull\` writes lands under \`export/\` and nowhere else. It is a snapshot of Figma:
delete the whole directory and re-pull and you lose nothing.

    export/pages/<Page>/<Screen>__<node-id>.json   one exported screen
    export/pages/<Page>/<Screen>__<node-id>.vars.json    the tokens THAT screen binds
    export/pages/<Page>/<Screen>__<node-id>.assets.json  which assets it uses, with content hashes
    export/pages/index.json                        every screen pulled, whatever the pull shape
    export/design-system/                          tokens.json, styles.*.json, components.*.json
    export/variables.json                          the union of every screen's slice (merged, never replaced)
    export/assets/                                 shared and cumulative across screens

## design/.sync/ — a working snapshot, not an export

\`design-diff.js --snapshot <file>\` copies a file here BEFORE you re-pull it, so the sync-design skill
can diff the old export against the new one afterwards. It is non-destructive by default (a snapshot
that would replace an existing, DIFFERENT one is refused unless you pass \`--force\`, which keeps the
old copy as \`<name>.prev\`) — see \`claude-plugin/skills/sync-design/SKILL.md\`. It is not part of the
Figma-owned export above and not something a re-pull ever writes to; delete it any time, it only
affects what the next diff compares against.

## design/sync/ — where a diff report lands

\`design-diff.js ... --out design/sync/<screen>.md\` writes its human-readable report here, per the
sync-design skill's step 4. Also yours: it is evidence of what changed on a given sync, not something
\`dtwin pull\` regenerates.

## Everything else here — you own it

These are decisions and evidence. They are not regenerable, and a re-pull never touches them.

    target.json              which stack you are building for
    codeconnect.local.json   Figma component key -> your code component. Hand-maintained.
    plan/<Screen>.json       what build-screen decided, and why
    audit/<Screen>.{md,json} the pre-build design review
    verify/<Screen>.report.json  the measured per-node comparison behind any "pass"

Commit both halves. If your .gitignore ignores \`design/\`, un-ignore this half —
\`!design/target.json\`, \`!design/codeconnect.local.json\`, \`!design/plan/\` — or the work is lost
with the next clone.
`;

module.exports = {
  DESIGN_DIR,
  EXPORT_SUBDIR,
  EXPORT_DIR,
  TARGET_FILE,
  MAP_FILE,
  PLAN_DIR,
  AUDIT_DIR,
  VERIFY_DIR,
  README,
  looksLikeExportDir,
  findExportDir,
  findMapFile,
};
