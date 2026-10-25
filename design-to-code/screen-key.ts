// screen-key.ts — the ONE key a screen's verify files are named by, and how a query becomes it.
//
// Identity is the Figma node id. A screen's files share one stem, `<Layer>__<id>` (bridge/src/pages-layout.ts
// screenStem: safe(name) + "__" + safe(id)), and nodeIdFromStem reads the id back. The stem is FIXED once a verify set
// exists: a set already in the verify dir for the node — or a run of it open in the run cache (opts.openSets) — keeps its
// name (node-artefacts.ts claim), so a frame renamed in Figma never forks a second set — and its run cache key and status lock stay the same files.
//
// A verify set is the files that share one name in the verify dir: its name is the stem, or `<stem>.<slug>` for a
// variant; any other name is legacy. That grammar and the verify dir's sets are verify-sets.ts (re-exported here).
//
// screenKey resolves a query to (node id, stem) through resolve-screen's exact stages only — node id (1), the exact
// union of layer name / title / plan header (2–4) and an id the query carries (4b). A whitespace-insensitive (4c) or a
// text-search (5) hit never names a set: a writer that took one could write a screen's evidence under another screen.
import { nodeIdFromStem, screenStem } from "../bridge/src/pages-layout.ts";
import { isNodeId } from "../bridge/src/node-id.ts";
import { resolveScreen } from "./resolve-screen-core.ts";
import { hasExportIndex } from "../bridge/src/export-reader.ts";
import { STEM_RE, parseSetName, verifySets } from "./verify-sets.ts";
import { nodeArtefacts } from "./node-artefacts.ts";
import type { Claim, ClaimOpts } from "./node-artefacts.ts";
import type { ScreenCandidate } from "./types.ts";

export {
  EXPECTED_SUFFIX, MAX_SLUG, RESERVED_SLUGS, allSets, expectationSetProblem, formatSetName, isVariantSlug,
  nodeIdFromSetName, outBaseOf, parseSetName, setFacts, setNameOfFile, statusBaseOf, variantOverlap, variantProblem, variantSlug, variantsOf, verifySets,
} from "./verify-sets.ts";
export type { OutBase, SetFacts, SetName } from "./verify-sets.ts";

// ---------------------------------------------------------------- query → key

/** The stem claim of opts' verify dir (node-artefacts.ts claim "verify set"); with no verify dir a node has no sets. */
function claimSet(opts: ScreenKeyOpts): (nodeId: string, o: ClaimOpts) => Claim {
  const verifyDir = opts.verifyDir ?? null;
  if (verifyDir === null) return (nodeId, o) => ({ ok: true, name: o.target ?? screenStem(o.layerName ?? "", nodeId), existing: false, legacy: [] });
  const art = nodeArtefacts(process.cwd(), { verifyDir, openSets: opts.openSets ?? [] });
  return (nodeId, o) => art.claim("verify set", nodeId, o);
}

export interface ScreenKeyOpts {
  /** the export root (holds pages/index.json); without an index only a canonical stem (or a node id with a set) is taken */
  exportDir?: string | null | undefined;
  /** the plan dir, for the plan screenName/route stage */
  planDir?: string | null | undefined;
  /** the verify dir: an existing set keeps its stem */
  verifyDir?: string | null | undefined;
  /** the verify dir's sets with a run open in the run cache (verify-status.ts openRunSets): a run opened before any of its
   *  set's files exist fixes the stem too */
  openSets?: readonly string[] | undefined;
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

/** A file tail a stem may be passed with (an artefact or export file name). */
const FILE_TAIL_RE = /\.(?:expected\.prev|expected|report|measured|status|evidence|vars|assets)\.json$|\.json$/;

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
  const claim = claimSet(opts);
  const exportDir = opts.exportDir ?? null;
  if (exportDir && hasExportIndex(exportDir)) {
    const r = resolveScreen(exportDir, q, { planDir: opts.planDir ?? null });
    if (r.status !== "resolved") {
      const why = r.status === "ambiguous" ? `'${q}' matches ${r.candidates.length} screens at the '${r.stage}' stage — pass the node id`
        : r.status === "needs-confirmation" ? `'${q}' matched only ${r.stage === "text search" ? "by text search" : 'ignoring spaces, "-" and "_"'} — pass the node id or the exact name`
        : `'${q}' matches no screen in ${exportDir}`;
      return { status: "unresolved", why, candidates: r.candidates };
    }
    const k = claim(r.row.id, { layerName: r.row.name });
    if (!k.ok) return { status: "unresolved", why: k.why, candidates: [] };
    return { status: "resolved", nodeId: r.row.id, stem: k.name, via: r.stage, name: r.row.name, existing: k.existing, legacy: k.legacy };
  }
  // no export index: only what names its node by itself
  const lit = (q.split(/[\\/]/).pop() ?? q).replace(FILE_TAIL_RE, "");
  const fromStem = STEM_RE.test(lit) ? nodeIdFromStem(lit) : null;
  if (fromStem !== null) {
    const k = claim(fromStem, { target: lit });
    if (!k.ok) return { status: "unresolved", why: `${k.why}: pass that name`, candidates: [] };
    return { status: "resolved", nodeId: fromStem, stem: lit, via: "canonical stem", name: null, existing: k.existing, legacy: k.legacy };
  }
  if (isNodeId(q)) {
    const k = claim(q, {});
    if (!k.ok) return { status: "unresolved", why: k.why, candidates: [] };
    if (k.existing) return { status: "resolved", nodeId: q, stem: k.name, via: "node id (existing verify set)", name: null, existing: true, legacy: k.legacy };
    return { status: "unresolved", why: `no export index to name node ${q} by — pass its stem (<Layer>__<id>) or the export dir`, candidates: [] };
  }
  return { status: "unresolved", why: `no export index to resolve '${q}' against — pass the stem (<Layer>__<id>), or the export dir`, candidates: [] };
}

// ---------------------------------------------------------------- query → set

/** The verify set a query names, as `--status` / `--wait` key a run by it: a valid set name taken as written (its variant
 *  kept), else the screen's base set (screenKey). `name` is the set name, `existing` whether the node's stem is an existing
 *  set's, `legacy` the node's legacy-named sets. */
export type SetKey =
  | { status: "resolved"; nodeId: string; stem: string; variant: string | null; name: string; via: string; existing: boolean; legacy: string[] }
  | { status: "unresolved"; why: string; candidates: ScreenCandidate[]; legacySet?: string };

/**
 * The set a query names, or why it names none. In order: the basename without a file tail (an artefact path or name) is
 * 1) a set name (`<stem>` / `<stem>.<slug>`, parseSetName) → that set, as written — unless another grammar-named stem in
 *    the verify dir holds its node (a second name for one node); 2) a legacy-named set in the verify dir → unresolved,
 *    with --migrate, `legacySet` its name; 3) else screenKey (the base set: variant null) on the query — on that basename when the query named
 *    a file. A set name goes first: screenKey would drop its `.<slug>`.
 */
export function setKey(query: string, opts: ScreenKeyOpts = {}): SetKey {
  const q = String(query ?? "").trim();
  const verifyDir = opts.verifyDir ?? null;
  const base = q.split(/[\\/]/).pop() ?? q;
  const lit = base.replace(FILE_TAIL_RE, "");
  const p = parseSetName(lit);
  if (p !== null) {
    const k = claimSet(opts)(p.nodeId, { target: p.stem });
    if (!k.ok) return { status: "unresolved", why: `${k.why}: pass that name`, candidates: [] };
    return { status: "resolved", nodeId: p.nodeId, stem: p.stem, variant: p.variant, name: lit, via: "set name", existing: k.existing, legacy: k.legacy };
  }
  if (verifyDir && lit && verifySets(verifyDir).includes(lit)) {
    return { status: "unresolved", why: `${lit} is a legacy-named verify set — run verify-screen --migrate --apply --dir ${verifyDir}, then pass the name it prints (<Layer>__<id>)`, candidates: [], legacySet: lit };
  }
  const k = screenKey(lit !== base ? lit : q, opts);
  if (k.status !== "resolved") return k;
  return { status: "resolved", nodeId: k.nodeId, stem: k.stem, variant: null, name: k.stem, via: k.via, existing: k.existing, legacy: k.legacy };
}
