// verify-sets.ts — the verify-set name grammar and the sets a verify dir holds (which stem a node's files take: node-artefacts.ts).
//
// A verify set is the files that share one name in the verify dir (SET_FILE: `<name>.expected.json`, `.report.json`,
// `.measured.json`, `.report.md`, `.status.json`, `.diff.png`, …, and screenshots: `<name>.png`, a state's `<name>-<state>.png`).
// Every tool spells a set's files through setFile, and which of them only the tools write through isToolOwned. Its name is the stem, or the stem
// and a variant: `<stem>.<slug>` (a dark theme, a narrow width), slug = runs of [a-z0-9] joined by single "-", at most
// MAX_SLUG long, never a RESERVED_SLUGS word. A stem is safe() output and the id after its last "__", so it never holds
// a "." — the part before the first "." is always the stem. Any other name (a nickname, `<Screen>@320`, `<Screen>-r1`)
// is legacy: `verify-screen --migrate` renames it (verify-migrate.ts).
//
// A module of its own, under node-artefacts.ts (which names a node's stem from these sets) and screen-key.ts (which
// resolves a query to a node first, through resolve-screen.ts).
import fs from "node:fs";
import path from "node:path";
import { nodeIdFromStem } from "../bridge/src/pages-layout.ts";
import { VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { readJsonOrNull } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import { liveStatusFile, readStatusFile, runCommands } from "./verify-status.ts";

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

/** The variant among `others` that `slug` overlaps by "-" — one extends the other (`w320` and `w320-dialog`) — or null. A
 *  state screenshot is `<set>-<state>.png`, so variant w320's `-dialog` shot IS variant w320-dialog's screenshot: two such
 *  variants of one stem would share files. */
export function variantOverlap(slug: string, others: Iterable<string>): string | null {
  for (const o of others) if (o !== slug && (slug.startsWith(o + "-") || o.startsWith(slug + "-"))) return o;
  return null;
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

/** Each file of a set, by kind: its suffix after the set's name (setFile). */
export const SET_FILE = {
  /** the expectation (verify-screen --expect) — what names the set */
  expected: ".expected.json",
  /** the expectation --expect replaced, kept beside it */
  expectedPrev: ".expected.prev.json",
  /** the report and its markdown (verify-screen --compare) */
  report: ".report.json",
  reportMd: ".report.md",
  /** what the probe (or the verifier) measured */
  measured: ".measured.json",
  /** the run's status (verify-run.ts: the live one is in the run cache, the final one published here) */
  status: ".status.json",
  /** the interactions the verifier drove (--interactions) */
  evidence: ".evidence.json",
  /** the probe's visual diff and forced-colors screenshot */
  diff: ".diff.png",
  forcedColors: ".forced-colors.png",
  /** an expectation moved aside: history, never a live set (allSets) */
  retired: ".expected.json.retired",
} as const;
export type SetFileKind = keyof typeof SET_FILE;
/** File `kind` of the set whose path without suffix is `base` (`<dir>/<set name>`). */
export const setFile = (base: string, kind: SetFileKind): string => base + SET_FILE[kind];
/** `file` without the suffix of `kind` (its set's base, or its name for a bare file name), or null when it is no such file. */
export const setBaseOf = (file: string, kind: SetFileKind): string | null => (file.endsWith(SET_FILE[kind]) ? file.slice(0, -SET_FILE[kind].length) : null);
/** The same set's file of kind `to`, from `file` of kind `from` (a report → its markdown); `file` as it is when it is not of kind `from`. */
export const siblingFile = (file: string, from: SetFileKind, to: SetFileKind): string => { const b = setBaseOf(file, from); return b === null ? file : setFile(b, to); };
export const EXPECTED_SUFFIX = SET_FILE.expected;

/** A --migrate journal: `<verifyDir>/.migrate-<set>.json`, kept from before a rename's first move until its post-check
 *  passes (verify-migrate.ts). */
export const journalFile = (verifyDir: string, set: string): string => path.join(verifyDir, `.migrate-${set}.json`);
const JOURNAL_RE = /^\.migrate-.+\.json$/i;
export const isJournalFile = (fileName: string): boolean => JOURNAL_RE.test(fileName);

/** The kinds only the verify tools write: verify-screen's expectation (and the one it replaced), report and markdown, the
 *  run status. Not the measured file, the evidence or the probe's images — the verifier writes or stages those. */
const TOOL_OWNED_KINDS: readonly SetFileKind[] = ["expected", "expectedPrev", "report", "reportMd", "status"];
/** Whether file name `fileName` is one only the verify tools write — a tool-owned kind of any set, or a --migrate journal
 *  — so it is never written by hand (verifier-guard.ts) nor copied in by --publish (verify-run.ts). Case is ignored:
 *  macOS and Windows file names ignore it. */
export function isToolOwned(fileName: string): boolean {
  const f = fileName.toLowerCase();
  return isJournalFile(f) || TOOL_OWNED_KINDS.some((k) => f.endsWith(SET_FILE[k]));
}

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
/** Trailing path separators: "/", and "\" only where it is one (Windows) — on POSIX "\" is a file name character. */
const TRAILING_SEP = path.sep === "\\" ? /[\\/]+$/ : /\/+$/;
/** Whether `p` ends in a path separator (TRAILING_SEP): `--out <dir>/` names a directory that may not exist yet. */
export const endsInSep = (p: string): boolean => TRAILING_SEP.test(p);
/** `p` without its trailing separators (TRAILING_SEP), or `p` itself when nothing else is left (a root). */
export const trimSep = (p: string): string => p.replace(TRAILING_SEP, "") || p;

/** Where a set's files go for `--out`: the base `<dir>/<set>`, its dir, and whether --out was the older spelling (the base
 *  itself, `<dir>/<set>`) — or why --out names no place for this set. */
export type OutBase = { base: string; dir: string; deprecated: boolean } | { error: string };
/**
 * `--out` read as the verify directory. In order: none → `<defaultDir>/<set>`; an existing directory → `<out>/<set>`; an
 * existing file → refused; a path ending in a separator (endsInSep: "/", and "\" on Windows) or the project's verify dir
 * (design/verify) → that directory (the writer creates it); a path whose basename is the set's name, exact case → the base itself (the older spelling,
 * `deprecated`); anything else → refused: a basename that is not the set's would name a second set for one node.
 */
export function outBaseOf(out: string | undefined, setName: string, defaultDir: string): OutBase {
  if (out === undefined) return { base: path.join(defaultDir, setName), dir: defaultDir, deprecated: false };
  const why = `--out takes the verify directory; this set is ${setName}`;
  let st: fs.Stats | null = null;
  try { st = fs.statSync(out); } catch { /* not there */ }
  if (st?.isDirectory()) return { base: path.join(out, setName), dir: out, deprecated: false };
  if (st) return { error: `--out ${out} is a file — ${why}` };
  if (endsInSep(out) || path.resolve(out) === path.resolve(VERIFY_DIR)) return { base: path.join(out, setName), dir: trimSep(out), deprecated: false };
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

/** The files whose names give a set its name: its expectation, report and measured file. */
const NAMING_KINDS: readonly SetFileKind[] = ["expected", "report", "measured"];
const namedBy = (f: string): string | null => { for (const k of NAMING_KINDS) if (f.endsWith(SET_FILE[k])) return f.slice(0, -SET_FILE[k].length); return null; };

/** Every set name in `verifyDir` (top level), sorted, with whether it is retired — its expectation moved aside as
 *  `<name>.expected.json.retired` and none in its place: history, never a live set. */
export function allSets(verifyDir: string): Array<{ name: string; retired: boolean }> {
  let files: string[];
  try { files = fs.readdirSync(verifyDir); } catch { return []; }
  const have = new Set(files);
  const names = new Set<string>();
  for (const f of files) {
    const named = namedBy(f);
    if (named !== null) names.add(named);
    else if (f.endsWith(SET_FILE.retired)) names.add(f.slice(0, -SET_FILE.retired.length));
  }
  return [...names].sort().map((name) => ({ name, retired: !have.has(setFile(name, "expected")) && have.has(setFile(name, "retired")) }));
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
  const exp = readJsonOrNull(setFile(path.join(verifyDir, name), "expected"), isJsonObject);
  const frame = exp && isJsonObject(exp.frame) ? exp.frame : null;
  const rep = readJsonOrNull(setFile(path.join(verifyDir, name), "report"), isJsonObject);
  return { expectedId: str(frame && frame.nodeId), expectedName: str(frame && frame.name), reportId: str(rep && rep.nodeId), reportScreen: str(rep && rep.screen) };
}

/** How a refusal names the stems `stems` of `verifyDir`'s sets (node-artefacts.ts's), joined by ", ": a stem with files
 *  there as itself; one whose only trace is a run open in the run cache (`open`) as that run — the user finds no file of
 *  it in the verify dir — with the command that ends it. */
export function stemHolders(verifyDir: string, stems: readonly string[], open: readonly string[]): string {
  const onDisk = new Set(verifySets(verifyDir).map((n) => parseSetName(n)?.stem));
  return stems.map((stem) => {
    const set = onDisk.has(stem) ? undefined : open.find((n) => parseSetName(n)?.stem === stem);
    const st = set !== undefined ? readStatusFile(liveStatusFile(path.join(verifyDir, set))) : null;
    if (set === undefined || st === null || st === "v1") return stem;
    return `an open run ${st.runId} under ${set} (no file of it yet; end it: ${runCommands(path.join(verifyDir, set), st).endIt})`;
  }).join(", ");
}

/** The variant slugs of `stem` among the live sets of `verifyDir`, sorted. */
export function variantsOf(verifyDir: string, stem: string): string[] {
  return verifySets(verifyDir).flatMap((name) => { const p = parseSetName(name); return p !== null && p.stem === stem && p.variant !== null ? [p.variant] : []; });
}
