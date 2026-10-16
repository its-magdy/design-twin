// screen-key.ts — the ONE key a screen's verify files are named by, and how a query becomes it.
//
// Identity is the Figma node id. A screen's files share one stem, `<Layer>__<id>` (bridge/src/pages-layout.ts
// screenStem: safe(name) + "__" + safe(id)), and nodeIdFromStem reads the id back. The stem is FIXED once a verify set
// exists: a set already in the verify dir for the node keeps its name (existingStem), so a frame renamed in Figma never
// forks a second set — and its run cache key and status lock stay the same files.
//
// A verify set is the files that share one name in the verify dir (`<name>.expected.json`, `.report.json`,
// `.measured.json`, `.report.md`, `.status.json`, `<name>.png`, `<name>-diff.png`, …). Its name is the stem, or the stem
// and a variant: `<stem>.<slug>` (a dark theme, a narrow width), slug [a-z0-9-]+. A stem is safe() output and the id
// after its last "__", so it never holds a "." — the part before the first "." is always the stem. Any other name (a
// nickname, `<Screen>@320`, `<Screen>-r1`) is legacy: `verify-screen --migrate` renames it (verify-migrate.ts).
//
// screenKey resolves a query to (node id, stem) through resolve-screen's exact stages only — node id (1), the exact
// union of layer name / title / plan header (2–4) and an id the query carries (4b). A whitespace-insensitive (4c) or a
// text-search (5) hit never names a set: a writer that took one could write a screen's evidence under another screen.
import fs from "node:fs";
import path from "node:path";
import { nodeIdFromStem, screenStem } from "../bridge/src/pages-layout.ts";
import { isNodeId } from "../bridge/src/node-id.ts";
import { resolveScreen } from "./resolve-screen.ts";
import { readJsonOrNull } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import type { ScreenCandidate } from "./types.ts";

/** A variant slug: what follows the stem's "." in a set name. */
const VARIANT_RE = /^[a-z0-9-]+$/;
/** A stem: safe() output only (letters, digits, "_"). */
const STEM_RE = /^[A-Za-z0-9_]+$/;

export const isVariantSlug = (s: string): boolean => VARIANT_RE.test(s);

/** Text → a variant slug: lower case, every run of other characters one "-", none at either end ("" when nothing is left). */
export function variantSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
  if (!isVariantSlug(variant)) throw new Error(`variant '${variant}' is not a slug ([a-z0-9-]+)`);
  return `${stem}.${variant}`;
}

/** The node id a set name's stem carries — nodeIdFromStem on the part before the first "." — or null. */
export function nodeIdFromSetName(name: string): string | null {
  const dot = name.indexOf(".");
  return nodeIdFromStem(dot < 0 ? name : name.slice(0, dot));
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

// ---------------------------------------------------------------- query → key

export interface ScreenKeyOpts {
  /** the export root (holds pages/index.json); without an index only a canonical stem (or a node id with a set) is taken */
  exportDir?: string | null | undefined;
  /** the plan dir, for the plan screenName/route stage */
  planDir?: string | null | undefined;
  /** the verify dir: an existing set keeps its stem */
  verifyDir?: string | null | undefined;
}
export type ScreenKey =
  | {
      status: "resolved"; nodeId: string; stem: string; via: string;
      /** the layer name the index gives the node (null without an index) */
      name: string | null;
      /** the stem is an existing set's (fixed), not derived from the name now */
      existing: boolean;
      /** legacy-named sets of the same node (verify-screen --migrate renames them) */
      legacy: string[];
    }
  | { status: "unresolved"; why: string; candidates: ScreenCandidate[] };

/** A whitespace-insensitive (4c) stage — resolveScreen's stage names for it all say so. */
const FOLD_STAGE = /ignoring spaces/;
/** A file tail a stem may be passed with (an artefact or export file name). */
const FILE_TAIL_RE = /\.(?:expected|report|measured|status|evidence|vars|assets)\.json$|\.json$/;

/**
 * The (node id, stem) a query names, or why it names none. With an export index: resolveScreen's exact stages only
 * (node id, the exact layer-name / title / plan-header union, an id the query carries) — a whitespace-insensitive or a
 * text-search hit is unresolved, listed as candidates. The stem is the verify dir's existing one for the node, else
 * screenStem(the indexed name, id); several grammar-named sets for one node is unresolved. Without an index: a
 * canonical stem (`<Layer>__<id>`, a file tail allowed) is taken as written — unless another set in the verify dir
 * holds that node under a different name — and a node id only when the verify dir already names it.
 */
export function screenKey(query: unknown, opts: ScreenKeyOpts = {}): ScreenKey {
  const q = String(query ?? "").trim();
  const verifyDir = opts.verifyDir ?? null;
  const stemsOf = (id: string): string[] => (verifyDir ? canonicalStemsFor(verifyDir, id) : []);
  const legacyOf = (id: string): string[] => (verifyDir ? legacySetsFor(verifyDir, id) : []);
  const exportDir = opts.exportDir ?? null;
  if (exportDir && fs.existsSync(path.join(exportDir, "pages", "index.json"))) {
    const r = resolveScreen(exportDir, q, { planDir: opts.planDir ?? null });
    if (r.status !== "resolved") {
      const why = r.status === "ambiguous" ? `'${q}' matches ${r.candidates.length} screens at the '${r.stage}' stage — pass the node id`
        : r.status === "needs-confirmation" ? `'${q}' matched only by text search — pass the node id`
        : `'${q}' matches no screen in ${exportDir}`;
      return { status: "unresolved", why, candidates: r.candidates };
    }
    if (FOLD_STAGE.test(r.stage)) {
      return { status: "unresolved", why: `'${q}' matches ${r.row.name} (${r.row.id}) only ignoring spaces, "-" and "_" — pass the node id or the exact name`, candidates: [] };
    }
    const id = r.row.id;
    const stems = stemsOf(id);
    if (stems.length > 1) return { status: "unresolved", why: `node ${id} has ${stems.length} verify sets under different names (${stems.join(", ")}) — keep one`, candidates: [] };
    const have = stems[0];
    return { status: "resolved", nodeId: id, stem: have ?? screenStem(r.row.name, id), via: r.stage, name: r.row.name, existing: have !== undefined, legacy: legacyOf(id) };
  }
  // no export index: only what names its node by itself
  const lit = (q.split(/[\\/]/).pop() ?? q).replace(FILE_TAIL_RE, "");
  const fromStem = STEM_RE.test(lit) ? nodeIdFromStem(lit) : null;
  if (fromStem !== null) {
    const others = [...stemsOf(fromStem).filter((s) => s !== lit), ...legacyOf(fromStem)];
    if (others.length) return { status: "unresolved", why: `node ${fromStem} already has a verify set under another name (${others.join(", ")}) — pass that name, or run verify-screen --migrate`, candidates: [] };
    return { status: "resolved", nodeId: fromStem, stem: lit, via: "canonical stem", name: null, existing: stemsOf(fromStem).includes(lit), legacy: [] };
  }
  if (isNodeId(q)) {
    const stems = stemsOf(q);
    const only = stems.length === 1 ? stems[0] : undefined;
    if (only !== undefined) return { status: "resolved", nodeId: q, stem: only, via: "node id (existing verify set)", name: null, existing: true, legacy: legacyOf(q) };
    return { status: "unresolved", why: stems.length > 1 ? `node ${q} has ${stems.length} verify sets under different names (${stems.join(", ")}) — keep one`
      : `no export index to name node ${q} by — pass its stem (<Layer>__<id>) or the export dir`, candidates: [] };
  }
  return { status: "unresolved", why: `no export index to resolve '${q}' against — pass the stem (<Layer>__<id>), or the export dir`, candidates: [] };
}
