// screen-key.ts — the ONE key a screen's verify files are named by, and how a query becomes it.
//
// Identity is the Figma node id. A screen's files share one stem, `<Layer>__<id>` (bridge/src/pages-layout.ts
// screenStem: safe(name) + "__" + safe(id)), and nodeIdFromStem reads the id back. The stem is FIXED once a verify set
// exists: a set already in the verify dir for the node keeps its name (existingStem), so a frame renamed in Figma never
// forks a second set — and its run cache key and status lock stay the same files.
//
// A verify set is the files that share one name in the verify dir: its name is the stem, or `<stem>.<slug>` for a
// variant; any other name is legacy. That grammar and the verify dir's sets are verify-sets.ts (re-exported here).
//
// screenKey resolves a query to (node id, stem) through resolve-screen's exact stages only — node id (1), the exact
// union of layer name / title / plan header (2–4) and an id the query carries (4b). A whitespace-insensitive (4c) or a
// text-search (5) hit never names a set: a writer that took one could write a screen's evidence under another screen.
import fs from "node:fs";
import path from "node:path";
import { nodeIdFromStem } from "../bridge/src/pages-layout.ts";
import { isNodeId } from "../bridge/src/node-id.ts";
import { resolveScreen } from "./resolve-screen.ts";
import { STEM_RE, canonicalStemsFor, legacySetsFor, nodeStem } from "./verify-sets.ts";
import type { ScreenCandidate } from "./types.ts";

export {
  allSets, canonicalStemsFor, existingStem, formatSetName, isVariantSlug, legacySetsFor, nodeIdFromSetName, nodeStem, parseSetName, setFacts, setNodeId,
  variantSlug, verifySets,
} from "./verify-sets.ts";
export type { SetFacts, SetName } from "./verify-sets.ts";

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
    if (r.kind === "folded") {
      return { status: "unresolved", why: `'${q}' matches ${r.row.name} (${r.row.id}) only ignoring spaces, "-" and "_" — pass the node id or the exact name`, candidates: [] };
    }
    const k = nodeStem(verifyDir, r.row.id, r.row.name);
    if ("why" in k) return { status: "unresolved", why: k.why, candidates: [] };
    return { status: "resolved", nodeId: r.row.id, stem: k.stem, via: r.stage, name: r.row.name, existing: k.existing, legacy: k.legacy };
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
