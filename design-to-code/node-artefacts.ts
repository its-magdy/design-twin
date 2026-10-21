// node-artefacts.ts — a project's artefacts by node: which plan, verify sets and audit report belong to node N, which
// node an artefact is of, and the one "one node, one X" refusal. Rooted at the project (design/plan, design/verify,
// design/audit; a caller may name other dirs). Every CLI that names, finds or refuses a node's artefacts asks this.
//
// The node an artefact is of:
//   - a plan: its `nodeId`, else the id its own `<Layer>__<id>` file name carries (planNode). Never its `screen`, its
//     `file` header or the export they lead to — a name is no identity, and `nodeId` wins when the two disagree;
//   - a verify set: the one id its name, its expectation's frame and its report's nodeId carry (setNode); when they
//     carry two, none — and it holds each of them, so neither node can be claimed past it;
//   - an audit report: its `nodeIds[]`, else (none recorded: an older report) the id its file name carries.
// Who holds node N is every artefact of a kind whose node is N; a verify set also by a run open in the run cache.
//
// Nothing is cached: each question reads the dir it is about, so a caller that writes (plan-skeleton --out, --migrate)
// and asks again sees what it wrote.
import fs from "node:fs";
import path from "node:path";
import { nodeIdFromStem, screenStem } from "../bridge/src/pages-layout.ts";
import { AUDIT_DIR, PLAN_DIR, VERIFY_DIR, listPlans } from "../bridge/src/project-layout.ts";
import { parsePlan } from "./doc-guards.ts";
import { alnumKey } from "./map-util.ts";
import { anyJson, readJson, readJsonOrNull } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import type { Plan } from "./types.ts";
import { nodeIdFromSetName, parseSetName, setFacts, stemHolders, verifySets } from "./verify-sets.ts";
import { openRunSets } from "./verify-status.ts";

export type ArtefactKind = "plan" | "verify set" | "audit report";

/** The node a plan is of: its `nodeId`, else the id its own file name (`<Layer>__<id>.json`) carries; null when neither
 *  (a plan known by no file: its `nodeId` alone). */
export function planNode(plan: Plan, file: string | undefined): string | null {
  return plan.nodeId || (file !== undefined ? nodeIdFromStem(path.basename(file).replace(/\.json$/i, "")) : null);
}

/** A plan file on disk, parsed and checked (doc-guards.ts parsePlan): plan-skeleton.ts writes it, a model fills it. */
export interface PlanFile { file: string; plan: Plan }
/** A plan file that could not be used, and why (one line). */
export interface BadPlan { file: string; error: string }
/** A plan of the plan dir and the node it is of. */
export interface PlanEntry extends PlanFile { nodeId: string | null }

export function readPlan(file: string): PlanFile | BadPlan {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { file, error: r.error };
  const p = parsePlan(r.doc);
  return "plan" in p ? { file, plan: p.plan } : { file, error: p.error };
}
export const isPlanFile = (p: PlanFile | BadPlan): p is PlanFile => "plan" in p;

/** What a claim gives: the name node N's artefact of that kind takes (`existing`: an artefact holds it already;
 *  `legacy`: the node's legacy-named verify sets), or why there is none — `holders` the artefacts in the way, `reason`
 *  which refusal: several hold the node, one holds it and the caller named another, or a new artefact misnamed. */
export type Claim = { ok: true; name: string; existing: boolean; legacy: string[] } | { ok: false; why: string; holders: string[]; reason: "several" | "held" | "misnamed" };

/** The one refusal: several artefacts of a kind hold the node, or one does and the caller named another. */
const article = (kind: ArtefactKind): string => (kind === "audit report" ? "an" : "a");
const several = (kind: ArtefactKind, nodeId: string, holders: string[], shown = holders.join(", ")): Claim =>
  ({ ok: false, why: `node ${nodeId} has ${holders.length} ${kind}s (${shown}) — one node, one ${kind}: keep one`, holders, reason: "several" });
const already = (kind: ArtefactKind, nodeId: string, holders: string[], shown = holders.join(", ")): Claim =>
  ({ ok: false, why: `node ${nodeId} already has ${article(kind)} ${kind} (${shown}) — one node, one ${kind}`, holders, reason: "held" });

export interface NodeArtefactDirs {
  /** default design/plan; a file is spelt as the dir is (relative to the root, or absolute) */
  planDir?: string | undefined;
  verifyDir?: string | undefined;
  auditDir?: string | undefined;
  /** the verify dir's sets with a run open (verify-status.ts openRunSets); default: read from its run cache */
  openSets?: readonly string[] | undefined;
}

export interface ClaimOpts {
  /** the node's layer name: a new stem is screenStem(layerName, id) */
  layerName?: string | undefined;
  /** the name the caller is about to write: refused when another artefact holds the node */
  target?: string | undefined;
}

export interface NodeArtefacts {
  readonly root: string;
  readonly planDir: string;
  readonly verifyDir: string;
  readonly auditDir: string;
  /** every plan of the plan dir (sorted), and — separately — the ones that could not be read */
  plans(): { plans: PlanEntry[]; bad: BadPlan[] };
  /** the readable plans of node `nodeId` */
  plansOf(nodeId: string): PlanEntry[];
  /** the readable plans that name no node */
  idlessPlans(): string[];
  /** every node id verify set `name` carries — its name's, its expectation's frame, its report's nodeId — sorted */
  setIds(name: string): string[];
  /** the node verify set `name` is of: the one id it carries (none, or two: null) */
  setNode(name: string): string | null;
  /** the sets holding node `nodeId` (carrying its id: setNode's rule): grammar-named stems (a run open in the run cache
   *  included) and legacy-named sets */
  setsOf(nodeId: string): { stems: string[]; legacy: string[] };
  /** node `nodeId`'s audit reports (sidecars are never reports) */
  auditsOf(nodeId: string): string[];
  /** the audit the build gate reads for a node: the screen file's own name, else the node's report, else — for a
   *  report that names no node (or a caller that knows none) — the screen name's exact slug */
  auditFor(nodeId: string | null | undefined, hints?: { screenFile?: string | null | undefined; screenName?: string | null | undefined }): string | null;
  /** the name node `nodeId`'s artefact of `kind` takes, or the refusal */
  claim(kind: "audit report", nodeId: string, o: { target: string }): Claim;
  claim(kind: "plan" | "verify set", nodeId: string, o?: ClaimOpts): Claim;
}

const slash = (p: string): string => p.split(path.sep).join("/");

export function nodeArtefacts(root: string, dirs: NodeArtefactDirs = {}): NodeArtefacts {
  const planDir = dirs.planDir ?? PLAN_DIR;
  const verifyDir = dirs.verifyDir ?? VERIFY_DIR;
  const auditDir = dirs.auditDir ?? AUDIT_DIR;
  const abs = (p: string): string => path.resolve(root, p);
  // a file as its dir is spelt: project-relative with "/" (as reports and plans record paths), absolute as the OS does
  const spell = (dir: string, name: string): string => (path.isAbsolute(dir) ? path.join(dir, name) : slash(path.join(dir, name)));
  const verifyAbs = abs(verifyDir);
  const open = (): readonly string[] => dirs.openSets ?? openRunSets(verifyAbs);

  function plans(): { plans: PlanEntry[]; bad: BadPlan[] } {
    const out: PlanEntry[] = [], bad: BadPlan[] = [];
    for (const f of listPlans(abs(planDir))) {
      const file = spell(planDir, f);
      const r = readPlan(abs(file));
      if (isPlanFile(r)) out.push({ file, plan: r.plan, nodeId: planNode(r.plan, f) });
      else bad.push({ file, error: r.error });
    }
    return { plans: out, bad };
  }
  const plansOf = (nodeId: string): PlanEntry[] => plans().plans.filter((p) => p.nodeId === nodeId);

  // every id a set carries: its name's (a grammar name), its expectation's frame, its report's nodeId — a run open in the
  // run cache with no file yet carries its name's only
  function setIds(name: string): string[] {
    const f = setFacts(verifyAbs, name);
    return [...new Set([nodeIdFromSetName(name), f.expectedId, f.reportId].filter((x): x is string => x !== null))].sort();
  }
  function setNode(name: string): string | null {
    const ids = setIds(name);
    return ids.length === 1 ? ids[0] ?? null : null;
  }
  // the sets holding `nodeId` (every set carrying its id): grammar-named stems — a variant's is its stem's — sorted, with
  // the ones that carry another id too, and the legacy-named sets
  function setHolders(nodeId: string, runs: readonly string[]): { stems: string[]; conflicted: Array<{ name: string; ids: string[] }>; legacy: string[] } {
    const stems = new Set<string>(), conflicted: Array<{ name: string; ids: string[] }> = [], legacy: string[] = [];
    for (const name of [...new Set([...verifySets(verifyAbs), ...runs])].sort()) {
      const ids = setIds(name);
      if (!ids.includes(nodeId)) continue;
      const p = parseSetName(name);
      if (p === null) { legacy.push(name); continue; }
      stems.add(p.stem);
      if (ids.length > 1) conflicted.push({ name, ids });
    }
    return { stems: [...stems].sort(), conflicted, legacy };
  }

  // design/audit/'s report files: `<stem>.json` with no "." in the stem (a sidecar — <screen>.cross.json — has one;
  // safe() folds every other character of a report name to "_") and the node ids each records (null: none recorded)
  function auditReports(): Array<{ f: string; stem: string; nodeIds: string[] | null }> {
    let files: string[];
    try { files = fs.readdirSync(abs(auditDir)).filter((f) => f.endsWith(".json") && !f.slice(0, -5).includes(".")).sort(); } catch { return []; }
    return files.map((f) => {
      const doc = readJsonOrNull(path.join(abs(auditDir), f), isJsonObject);
      const ids = doc && Array.isArray(doc.nodeIds) ? doc.nodeIds.filter((x): x is string => typeof x === "string") : [];
      // an empty or absent nodeIds[] records no node: the file name's id stands in
      return { f, stem: f.slice(0, -5), nodeIds: ids.length ? ids : null };
    });
  }
  const auditNodeIs = (r: { stem: string; nodeIds: string[] | null }, nodeId: string): boolean => (r.nodeIds ? r.nodeIds.includes(nodeId) : nodeIdFromStem(r.stem) === nodeId);
  const auditNamesNode = (r: { stem: string; nodeIds: string[] | null }): boolean => r.nodeIds !== null || nodeIdFromStem(r.stem) !== null;
  const auditsOf = (nodeId: string): string[] => auditReports().filter((r) => auditNodeIs(r, nodeId)).map((r) => spell(auditDir, r.f));

  function auditFor(nodeId: string | null | undefined, hints: { screenFile?: string | null | undefined; screenName?: string | null | undefined } = {}): string | null {
    if (!fs.existsSync(abs(auditDir))) return null;
    // audit.ts names its default output after the input file, itself `<Layer>__<id>` (write-out.ts)
    if (hints.screenFile) {
      const own = path.basename(hints.screenFile, ".json") + ".json";
      if (fs.existsSync(path.join(abs(auditDir), own))) return spell(auditDir, own);
    }
    if (nodeId) { const held = auditsOf(nodeId)[0]; if (held !== undefined) return held; }
    const want = alnumKey(hints.screenName);
    if (!want) return null;
    // older runs wrote a plain slug (`positions.json`): the EXACT slug, also with the `__<id>` suffix stripped (split at
    // the LAST "__": a safe() layer name may hold "__", a safe() id never does) — never a prefix either way ("Jet Roles"
    // must not take "Jet Roles Detail"'s blockers). Knowing the node, a report of another node is never taken by name.
    const pool = auditReports().filter((r) => !nodeId || !auditNamesNode(r));
    const nameOf = (s: string): string | null => { const i = s.lastIndexOf("__"); return i > 0 ? s.slice(0, i) : null; };
    const hit = pool.find((r) => alnumKey(r.stem) === want) ?? pool.find((r) => { const n = nameOf(r.stem); return n !== null && alnumKey(n) === want; });
    return hit ? spell(auditDir, hit.f) : null;
  }

  function claimSet(nodeId: string, o: ClaimOpts): Claim {
    const runs = open();
    const { stems, conflicted, legacy } = setHolders(nodeId, runs);
    // how a refusal names the stems: one whose only trace is an open run as that run (stemHolders)
    const shown = (names: string[]): string => stemHolders(verifyAbs, names, runs);
    // a set that carries two ids is no node's, and its name cannot be another set's: which files are whose is a person's call
    const mixed = conflicted[0];
    if (mixed !== undefined) {
      return { ok: false, why: `node ${nodeId}'s verify set ${mixed.name} also carries node ${mixed.ids.filter((x) => x !== nodeId).join(", ")} (its name, expectation and report disagree) — one node, one verify set: keep one node's files`,
        holders: conflicted.map((c) => c.name), reason: "held" };
    }
    // a legacy-named set never refuses: verify-screen --migrate renames it, so it is listed (`legacy`) for a note
    if (o.target !== undefined) {
      const others = stems.filter((s) => s !== o.target);
      if (others.length) return already("verify set", nodeId, others, shown(others));
      return { ok: true, name: o.target, existing: stems.includes(o.target), legacy };
    }
    if (stems.length > 1) return several("verify set", nodeId, stems, shown(stems));
    const have = stems[0];
    return { ok: true, name: have ?? screenStem(o.layerName ?? "", nodeId), existing: have !== undefined, legacy };
  }

  function claimPlan(nodeId: string, o: ClaimOpts): Claim {
    const held = plansOf(nodeId).map((p) => p.file);
    if (held.length > 1) return several("plan", nodeId, held);
    const target = o.target !== undefined ? abs(o.target) : undefined;
    const have = held[0];
    if (have !== undefined) return target === undefined || abs(have) === target ? { ok: true, name: have, existing: true, legacy: [] } : already("plan", nodeId, held);
    // a new plan is named by its node: the stem its verify set has (or will have)
    const s = claimSet(nodeId, { layerName: o.layerName });
    if (!s.ok) return s;
    const name = spell(planDir, s.name + ".json");
    if (target !== undefined && path.basename(target) !== path.basename(name)) return { ok: false, why: `a new plan of node ${nodeId} is named by its node: ${name}, not ${path.basename(target)}`, holders: [], reason: "misnamed" };
    return { ok: true, name, existing: false, legacy: [] };
  }

  function claimAudit(nodeId: string, target: string): Claim {
    const t = abs(target);
    const own = path.basename(t, ".json");
    // the target itself, or the report a sidecar target sits beside (`<stem>.cross.json` beside `<stem>.json`), is not in the way
    const held = auditsOf(nodeId).filter((f) => abs(f) !== t && !own.startsWith(path.basename(f, ".json") + "."));
    return held.length ? already("audit report", nodeId, held) : { ok: true, name: target, existing: false, legacy: [] };
  }

  function claim(kind: ArtefactKind, nodeId: string, o: ClaimOpts = {}): Claim {
    if (kind === "plan") return claimPlan(nodeId, o);
    if (kind === "verify set") return claimSet(nodeId, o);
    if (o.target === undefined) throw new Error("claim('audit report') takes the target it is about to write");
    return claimAudit(nodeId, o.target);
  }

  return {
    root, planDir, verifyDir, auditDir,
    plans, plansOf, idlessPlans: () => plans().plans.filter((p) => p.nodeId === null).map((p) => p.file),
    setIds, setNode, setsOf: (nodeId) => { const h = setHolders(nodeId, open()); return { stems: h.stems, legacy: h.legacy }; },
    auditsOf, auditFor, claim,
  };
}
