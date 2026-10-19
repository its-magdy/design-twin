// verify-sets.ts — the verify-set name grammar, the sets a verify dir holds, and the stem a known node's files take.
//
// A verify set is the files that share one name in the verify dir (`<name>.expected.json`, `.report.json`,
// `.measured.json`, `.report.md`, `.status.json`, `<name>.png`, `<name>-diff.png`, …). Its name is the stem, or the stem
// and a variant: `<stem>.<slug>` (a dark theme, a narrow width), slug = runs of [a-z0-9] joined by single "-", at most
// MAX_SLUG long, never a RESERVED_SLUGS word. A stem is safe() output and the id after its last "__", so it never holds
// a "." — the part before the first "." is always the stem. Any other name (a nickname, `<Screen>@320`, `<Screen>-r1`)
// is legacy: `verify-screen --migrate` renames it (verify-migrate.ts).
//
// A module of its own, under screen-key.ts (which resolves a query to a node first, through resolve-screen.ts): so
// resolve-screen's CLI can name a node's stem the way screenKey does without importing screen-key.
import fs from "node:fs";
import path from "node:path";
import { nodeIdFromStem, screenStem } from "../bridge/src/pages-layout.ts";
import { VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { readJsonOrNull } from "./read-json.ts";
import { isJsonObject } from "./types.ts";

/** Slugs a variant never takes: a file tail of the set (`<S>.diff.png` is the base set's diff, `<S>.forced-colors.png` its
 *  forced-colors screenshot; `<S>.report.json` its report) or a word the tools read as one. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["expected", "report", "measured", "status", "evidence", "prev", "retired", "diff", "forced-colors", "json", "md", "png", "tmp"]);
/** The longest variant slug. */
export const MAX_SLUG = 32;
/** A variant slug: what follows the stem's "." in a set name — runs of [a-z0-9] joined by single "-". */
const VARIANT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A stem: safe() output only (letters, digits, "_"). */
export const STEM_RE = /^[A-Za-z0-9_]+$/;

export const isVariantSlug = (s: string): boolean => s.length <= MAX_SLUG && VARIANT_RE.test(s) && !RESERVED_SLUGS.has(s);

/** Text → a variant slug: lower case, every run of other characters one "-", none at either end ("" when nothing is left). */
export function variantSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Why `s` is refused as a variant slug (`--variant s`), or null when it is one. Suggests variantSlug(s) when that is a slug. */
export function variantProblem(s: string): string | null {
  if (isVariantSlug(s)) return null;
  if (RESERVED_SLUGS.has(s)) return `variant '${s}' is reserved — it names a file of the set (${[...RESERVED_SLUGS].join(", ")} are never slugs); pick another`;
  if (s.length > MAX_SLUG) return `variant '${s}' is ${s.length} characters long — a slug is at most ${MAX_SLUG}`;
  const fixed = variantSlug(s);
  return `variant '${s}' is not a slug (lower-case letters and digits, words joined by single "-")${fixed !== s && isVariantSlug(fixed) ? ` — use '${fixed}'` : ""}`;
}

/** A set name read by the grammar: its stem, the node id the stem carries, and its variant (null for the base set). */
export interface SetName { stem: string; nodeId: string; variant: string | null }

/** `<stem>` or `<stem>.<slug>` → its parts; null for any other name (a legacy one). */
export function parseSetName(name: string): SetName | null {
  const dot = name.indexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const variant = dot < 0 ? null : name.slice(dot + 1);
  if (!STEM_RE.test(stem)) return null;
  const nodeId = nodeIdFromStem(stem);
  if (nodeId === null) return null;
  if (variant !== null && !isVariantSlug(variant)) return null;
  return { stem, nodeId, variant };
}

/** The set name of a stem and an optional variant slug (throws on a slug outside the grammar). */
export function formatSetName(stem: string, variant?: string | null): string {
  if (variant === undefined || variant === null) return stem;
  const why = variantProblem(variant);
  if (why !== null) throw new Error(why);
  return `${stem}.${variant}`;
}

/** The node id a set name's stem carries — nodeIdFromStem on the part before the first "." — or null. */
export function nodeIdFromSetName(name: string): string | null {
  const dot = name.indexOf(".");
  return nodeIdFromStem(dot < 0 ? name : name.slice(0, dot));
}

// ---------------------------------------------------------------- a set's files and where they go

export const EXPECTED_SUFFIX = ".expected.json";

/** The set name an expectation file gives: its basename without ".expected.json" (else without ".json"). */
export function setNameOfFile(file: string): string {
  const b = path.basename(file);
  return b.endsWith(EXPECTED_SUFFIX) ? b.slice(0, -EXPECTED_SUFFIX.length) : b.endsWith(".json") ? b.slice(0, -".json".length) : b;
}

/** THE status base of the set an expectation names: `<its dir>/<set name>` — the run cache key and the status lock every
 *  writer and reader of that set's run status uses (verify-run.ts), wherever a run writes its other files. */
export function statusBaseOf(expectedFile: string): string {
  return path.join(path.dirname(expectedFile), setNameOfFile(expectedFile));
}

/** Where a set's files go for `--out`: the base `<dir>/<set>`, its dir, and whether --out was the older spelling (the base
 *  itself, `<dir>/<set>`) — or why --out names no place for this set. */
export type OutBase = { base: string; dir: string; deprecated: boolean } | { error: string };
/**
 * `--out` read as the verify directory. In order: none → `<defaultDir>/<set>`; an existing directory → `<out>/<set>`; an
 * existing file → refused; a path ending in "/" (or "\") or the project's verify dir (design/verify) → that directory
 * (the writer creates it); a path whose basename is the set's name, exact case → the base itself (the older spelling,
 * `deprecated`); anything else → refused: a basename that is not the set's would name a second set for one node.
 */
export function outBaseOf(out: string | undefined, setName: string, defaultDir: string): OutBase {
  if (out === undefined) return { base: path.join(defaultDir, setName), dir: defaultDir, deprecated: false };
  const why = `--out takes the verify directory; this set is ${setName}`;
  let st: fs.Stats | null = null;
  try { st = fs.statSync(out); } catch { /* not there */ }
  if (st?.isDirectory()) return { base: path.join(out, setName), dir: out, deprecated: false };
  if (st) return { error: `--out ${out} is a file — ${why}` };
  if (/[\\/]$/.test(out) || path.resolve(out) === path.resolve(VERIFY_DIR)) return { base: path.join(out, setName), dir: out.replace(/[\\/]+$/, "") || out, deprecated: false };
  if (path.basename(out) === setName) return { base: out, dir: path.dirname(out), deprecated: true };
  return { error: `--out ${out} is not a directory (a new one ends in "/") — ${why}` };
}

/** Why an expectation file cannot be compared or probed under its name, or null: a legacy name (not `<stem>` /
 *  `<stem>.<slug>`), or a name whose node id is not the expectation's frame's. */
export function expectationSetProblem(expectedFile: string, frameNodeId: string | undefined, verifyDir: string): string | null {
  const name = setNameOfFile(expectedFile);
  const p = parseSetName(name);
  if (p === null) return `${expectedFile} is a legacy-named verify set — run verify-screen --migrate --dir ${verifyDir}, then use ${path.join(verifyDir, "<the new name it prints>")}${EXPECTED_SUFFIX}`;
  if (frameNodeId !== undefined && p.nodeId !== frameNodeId) return `${expectedFile} is named for node ${p.nodeId}, its frame is ${frameNodeId} — re-run --expect for the frame (it names the set)`;
  return null;
}

// ---------------------------------------------------------------- the verify dir's sets

/** The files whose names give a set its name. */
const SET_FILE_RE = /\.(?:expected|report|measured)\.json$/;
const RETIRED = ".expected.json.retired";

/** Every set name in `verifyDir` (top level), sorted, with whether it is retired — its expectation moved aside as
 *  `<name>.expected.json.retired` and none in its place: history, never a live set. */
export function allSets(verifyDir: string): Array<{ name: string; retired: boolean }> {
  let files: string[];
  try { files = fs.readdirSync(verifyDir); } catch { return []; }
  const have = new Set(files);
  const names = new Set<string>();
  for (const f of files) {
    if (SET_FILE_RE.test(f)) names.add(f.replace(SET_FILE_RE, ""));
    else if (f.endsWith(RETIRED)) names.add(f.slice(0, -RETIRED.length));
  }
  return [...names].sort().map((name) => ({ name, retired: !have.has(name + ".expected.json") && have.has(name + RETIRED) }));
}

/** The live (not retired) set names in `verifyDir`. */
export function verifySets(verifyDir: string): string[] {
  return allSets(verifyDir).filter((s) => !s.retired).map((s) => s.name);
}

/** What a set's own files say about its node: the expectation's frame (`nodeId`, `name`) and the report's `nodeId` /
 *  `screen`. Each null when that file is absent or says nothing. */
export interface SetFacts { expectedId: string | null; expectedName: string | null; reportId: string | null; reportScreen: string | null }
export function setFacts(verifyDir: string, name: string): SetFacts {
  const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
  const exp = readJsonOrNull(path.join(verifyDir, name + ".expected.json"), isJsonObject);
  const frame = exp && isJsonObject(exp.frame) ? exp.frame : null;
  const rep = readJsonOrNull(path.join(verifyDir, name + ".report.json"), isJsonObject);
  return { expectedId: str(frame && frame.nodeId), expectedName: str(frame && frame.name), reportId: str(rep && rep.nodeId), reportScreen: str(rep && rep.screen) };
}

/** The node id a set is of, from its own files: the expectation's frame, else the report; null when neither names one
 *  or when they name two. */
export function setNodeId(verifyDir: string, name: string): string | null {
  const f = setFacts(verifyDir, name);
  if (f.expectedId !== null && f.reportId !== null && f.expectedId !== f.reportId) return null;
  return f.expectedId ?? f.reportId;
}

/** The stems of the grammar-named sets (base or variant) in `verifyDir` that carry `nodeId`, sorted. */
export function canonicalStemsFor(verifyDir: string, nodeId: string): string[] {
  const stems = new Set<string>();
  for (const name of verifySets(verifyDir)) {
    const p = parseSetName(name);
    if (p && p.nodeId === nodeId) stems.add(p.stem);
  }
  return [...stems].sort();
}

/** The stem the verify dir already names `nodeId` by — the ONE grammar-named set's stem — or null (none, or several). */
export function existingStem(verifyDir: string, nodeId: string): string | null {
  const stems = canonicalStemsFor(verifyDir, nodeId);
  return stems.length === 1 ? stems[0] ?? null : null;
}

/** The legacy-named live sets in `verifyDir` whose own files say they are of `nodeId` (setNodeId), sorted. */
export function legacySetsFor(verifyDir: string, nodeId: string): string[] {
  return verifySets(verifyDir).filter((name) => parseSetName(name) === null && setNodeId(verifyDir, name) === nodeId);
}

/** The stem a known node's files take — the verify dir's existing one for it (fixed once a set exists), else
 *  screenStem(its layer name, id) — with its legacy-named sets; or why none (several grammar-named sets for the node).
 *  screenKey's answer once a query has named the node. */
export function nodeStem(verifyDir: string | null, nodeId: string, layerName: string): { stem: string; existing: boolean; legacy: string[] } | { why: string } {
  const stems = verifyDir ? canonicalStemsFor(verifyDir, nodeId) : [];
  if (stems.length > 1) return { why: `node ${nodeId} has ${stems.length} verify sets under different names (${stems.join(", ")}) — keep one` };
  const have = stems[0];
  return { stem: have ?? screenStem(layerName, nodeId), existing: have !== undefined, legacy: verifyDir ? legacySetsFor(verifyDir, nodeId) : [] };
}
