// project-layout.ts — the ONE definition of where a Design Twin project keeps things.
//
// The layout is not "everything under design/", which would put two incompatible kinds of file in one
// directory: what a pull WRITES and may overwrite without asking (pages/, design-system/, assets/,
// variables.json), and what a human or a build step OWNS and cannot regenerate (target.json, the
// component map, the plan, the audit, the verification evidence). "Delete design/ and re-pull" is the
// obvious recovery move for a bad export, and it would silently destroy the second kind — including a
// component map that can represent hours of hand-mapping. Moving the component map to
// the repo root would only draw the line in two different places.
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

import fs from "node:fs";
import path from "node:path";

export const DESIGN_DIR = "design";
export const EXPORT_SUBDIR = "export";
export const EXPORT_DIR = path.join(DESIGN_DIR, EXPORT_SUBDIR);
export const TARGET_FILE = path.join(DESIGN_DIR, "target.json");
export const MAP_FILE = path.join(DESIGN_DIR, "codeconnect.local.json");
export const LEGACY_MAP_FILE = "codeconnect.local.json"; // the repo-root map of projects that predate design/
export const PLAN_DIR = path.join(DESIGN_DIR, "plan");
export const AUDIT_DIR = path.join(DESIGN_DIR, "audit");
export const VERIFY_DIR = path.join(DESIGN_DIR, "verify");

// Tailwind v4's automatic source detection scans every file git does not ignore — Markdown
// included (tailwindcss.com/docs/detecting-classes-in-source-files) — so class names quoted in design/
// notes, audits and plans are generated into the shipped CSS. The exclusion is `@source not "<path
// relative to the stylesheet>";` (Tailwind v4.1+). Only SUGGESTED: the path depends on where the
// CSS entry lives, and the user's stylesheet is theirs. One wording for `dtwin init` and tokens.ts.
export const TAILWIND_SOURCE_NOT_NOTE =
  `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. ` +
  `Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` ` +
  `(e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) — Tailwind v4.1+`;

// Suggest only. What was proven on a real Vite + Tailwind v4 app: with Tailwind's automatic source
// detection, rewriting an existing text file under design/ makes Vite fully reload the page — the reload that aborted
// a measurement. Either Vite's `server.watch.ignored` (chokidar options, vite.dev/config/server-options) or Tailwind's
// `@source not` stops it. Only emitted when the project lists BOTH vite and Tailwind v4: without Tailwind scanning
// design/, Vite reloads only for files in its module graph, which design/ is not — so the note would be noise there.
// (The verify tools themselves write nothing under design/ while a page is open: live status + staging live in
// node_modules/.cache/designtwin-verify/.) Never edited for the user: vite.config is theirs.
export const VITE_WATCH_IGNORED_NOTE =
  `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. ` +
  `Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above — both stop it`;

// design/verify/ is regenerated on every verify run (measurements, screenshots, reports); the
// plan's waivers and descopes live in design/plan/, so ignoring it loses no decision. Spelt with `/` on every OS: a
// .gitignore pattern takes only `/` (a `\` there escapes the next character, so `design\verify/` ignores nothing).
const slashed = (p: string): string => p.split(path.sep).join("/");
export const VERIFY_GITIGNORE_NOTE =
  `${slashed(VERIFY_DIR)}/ is regenerated on every verify run (measurements, screenshots, reports) — consider adding \`${slashed(VERIFY_DIR)}/\` to .gitignore; decisions live in ${slashed(PLAN_DIR)}/ and are not affected`;

// The marks of an export directory, in the order a pull creates them. Used to tell "this project uses
// the old flat layout" from "this project has no export yet", which are different problems with
// different fixes.
const EXPORT_MARKERS = ["pages", "design-system", "design-system.json", "variables.json", "assets", "libraries"];

export function looksLikeExportDir(dir: string): boolean {
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
/** Where findExportDir found (or would put) the export. `parallelLegacy` only on the modern layout. */
export type ExportDirInfo =
  | { dir: string; layout: "export-subdir"; rel: string; parallelLegacy: boolean }
  | { dir: string; layout: "legacy-flat" | "none"; rel: string; parallelLegacy?: undefined };

export function findExportDir(cwd: string): ExportDirInfo {
  const modern = path.join(cwd, EXPORT_DIR);
  const legacy = path.join(cwd, DESIGN_DIR);
  const modernExists = looksLikeExportDir(modern);
  const legacyExists = looksLikeExportDir(legacy);
  // Both layouts present at once: a stray `dtwin pull design …` wrote a
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
export interface MapFileInfo {
  file: string;
  rel: string;
  legacy: boolean;
  /** Present (true) only when neither location holds a map; `file` is then where a new one goes. */
  missing?: true;
}

export function findMapFile(cwd: string): MapFileInfo {
  const modern = path.join(cwd, MAP_FILE);
  if (fs.existsSync(modern)) return { file: modern, rel: MAP_FILE, legacy: false };
  const legacy = path.join(cwd, LEGACY_MAP_FILE);
  if (fs.existsSync(legacy)) return { file: legacy, rel: LEGACY_MAP_FILE, legacy: true };
  return { file: modern, rel: MAP_FILE, legacy: false, missing: true };
}

// The plan files in a plan directory (PLAN_DIR, or one a caller names): every `*.json` name, sorted so every
// reader walks them in the same order. A directory that does not exist holds none.
export function listPlans(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

// Shipped into design/ by `dtwin init`, because the one thing this layout has to communicate is which
// half of it a re-pull is allowed to destroy — and a comment in a source file cannot do that.
export const README = `# design/

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
    export/SCHEMA.md                               scripting quick keys (generated)
    export/assets/                                 shared and cumulative across screens

## design/.sync/ — a working snapshot, not an export

\`design-diff.ts --snapshot <file>\` copies a file here BEFORE you re-pull it, so the sync-design skill
can diff the old export against the new one afterwards. It is non-destructive by default (a snapshot
that would replace an existing, DIFFERENT one is refused unless you pass \`--force\`, which keeps the
old copy as \`<name>.prev\`) — see \`claude-plugin/skills/sync-design/SKILL.md\`. It is not part of the
Figma-owned export above and not something a re-pull ever writes to; delete it any time, it only
affects what the next diff compares against.

## design/sync/ — where a diff report lands

\`design-diff.ts ... --out design/sync/<screen>.md\` writes its human-readable report here, per the
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
