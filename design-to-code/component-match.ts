// component-match.ts — which design-system component is this instance, when the KEYS cannot say?
//
// A component's identity is its publish `key`, and every tool here resolves by key first. But
// duplicating a Figma file re-mints every key in the copy (livetest-3 finding 226: `TeamSmart (Copy)`
// and `Design System - NERA (Copy)`), so a screen's instances then match the pulled catalog by key
// 0 times out of 51 — while 26 of its 41 distinct components are plainly the catalog's own `Button`,
// `Header`, `Pagination`… by name AND by prop signature. Three tools concluded "the catalog is not
// this screen's library", the build made every component `verdict:"new"`, and none of the design
// system's variant matrices reached the app.
//
// This module is the fallback, and it is deliberately strict:
//   * a NAME is only ever a candidate. `Component 1`, `Component 2`, `Header` are real names that
//     several catalog entries share, and a name alone would collide across unrelated systems;
//   * a candidate is PROPOSED only when its prop signature agrees with the instance: every variant
//     axis the instance sets is a VARIANT prop of the candidate and its value is one of that axis's
//     options; every other prop the instance carries exists on the candidate with a compatible type
//     (BOOLEAN ↔ boolean, TEXT/INSTANCE_SWAP ↔ string); an instance with no variant only matches a
//     plain COMPONENT;
//   * same-named candidates are ranked by that evidence, then by living on a shared page, then by
//     catalog order; candidates with identical signatures are reported as harmless ties;
//   * NOTHING here is ever auto-accepted. The result is a confirmation list: cross-check.ts reports
//     it (`catalog-rekeyed`), and map-bootstrap.ts stubs only the entries a person marked confirmed.
//
// The reference this was checked against is livetest-3's hand-written scripts-test/map-components.mjs:
// same visible-instance walk, same name rule, same variant/prop evidence and tie-breaks.
import type {
  CatalogComponent, ComponentPropDef, ComponentsCatalog, IrNode, MatchAlternative, MatchInstance, MatchResult, MatchRow, ScreenDoc, VisibleInstance,
} from "./types.ts";
import { screenRoots } from "./export-shape.ts";
import { isJsonObject } from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";

// Hidden layers are not built, so they are not mapped either (and a hidden subtree's instances are
// skipped with it).
function visibleInstances(doc: ScreenDoc | null | undefined, label: string): VisibleInstance[] {
  const out: VisibleInstance[] = [];
  const roots = screenRoots(doc); // the three shapes the export writes (export-shape.ts)
  const walk = (n: IrNode): void => {
    // `hidden` is the export's ONLY visibility flag (serialize.ts writes it; there is no `visible`).
    if (!n || typeof n !== "object" || n.hidden === true) return;
    if (n.type === "INSTANCE" && n.mainComponent) {
      const mc = n.mainComponent;
      out.push({
        screen: label,
        nodeId: n.id,
        layer: n.name,
        name: mc.setName || mc.name || n.name,
        ...ifDefined("key", mc.key),
        ...ifDefined("setKey", mc.setKey),
        remote: mc.remote === true,
        variant: parseVariant(n.component) || parseVariant(mc.variant),
        props: n.props && typeof n.props === "object" ? n.props : {},
      });
    }
    for (const c of n.children || []) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

// The export spells the variant either as a string ("Type=Primary, Status=Default") or, when the
// instance carries per-prop overrides, as an object ({ Dashboard: "default" }).
function parseVariant(s: unknown): Record<string, string> | null {
  // (only string values are kept: a variant axis's value is its option name)
  if (isJsonObject(s)) { const out = Object.fromEntries(Object.entries(s).filter((e): e is [string, string] => typeof e[1] === "string")); return Object.keys(out).length ? out : null; }
  if (!s || typeof s !== "string" || !s.includes("=")) return null;
  const out: Record<string, string> = {};
  for (const part of s.split(/,\s*(?=[^,=]+=)/)) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

const baseProp = (p: string): string => String(p).split("#")[0] ?? ""; // ?? "": split() always returns at least one piece, so it never applies
const SHARED_PAGE = /shared|style ?guide|foundation|core|global|design.?system|librar|banner|badge/i;

interface Signature { verified: boolean; score: number; reasons: string[] }

// Evidence that `cand` is the definition `inst` was made from. `verified` is the gate; `score` only
// ranks candidates that share a name.
function signature(inst: MatchInstance, cand: CatalogComponent): Signature {
  const props: Record<string, ComponentPropDef> = {};
  for (const [k, v] of Object.entries(cand.props || {})) props[baseProp(k)] = v;
  const reasons: string[] = [];
  let score = 40, verified = true;
  reasons.push("name matches catalog entry verbatim");
  const variant = inst.variant;
  if (variant) {
    const axes = Object.keys(variant);
    const known = axes.filter((k) => props[k] && props[k].type === "VARIANT");
    if (known.length === axes.length) { score += 25; reasons.push(`all ${axes.length} variant prop name(s) exist as VARIANT props`); }
    else { verified = false; score += known.length ? 10 : -15; reasons.push(known.length ? `${known.length}/${axes.length} variant prop names exist` : "variant prop names are NOT on this candidate"); }
    // `known` in the same order, with each axis's value: the axes whose value is not in the option list
    const bad = Object.entries(variant).filter(([k, val]) => { const d = props[k]; return d && d.type === "VARIANT" && !(d.options || []).includes(val); }).map(([k]) => k);
    if (known.length && !bad.length) { score += 25; reasons.push(`variant value(s) ${known.map((k) => `${k}=${variant[k]}`).join(", ")} are in the option list`); }
    else if (bad.length) { verified = false; score -= 20; reasons.push(`variant value(s) not in option list (${bad.map((k) => `${k}=${variant[k]}`).join(", ")})`); }
  } else if (cand.type === "COMPONENT") {
    score += 15; reasons.push("instance has no variant string and the catalog entry is a plain COMPONENT");
  } else {
    verified = false; reasons.push(`instance sets no variant but the catalog entry is a ${cand.type}`);
  }
  const own = Object.keys(inst.props || {}).filter((k) => !variant || !(baseProp(k) in variant));
  if (own.length) {
    const typed = own.filter((k) => {
      const d = props[baseProp(k)], v = inst.props[k];
      if (!d) return false;
      if (typeof v === "boolean") return d.type === "BOOLEAN";
      return d.type === "TEXT" || d.type === "INSTANCE_SWAP" || d.type === "VARIANT";
    });
    if (typed.length === own.length) { score += 15; reasons.push(`all ${own.length} non-variant prop name(s) exist on the definition`); }
    else { verified = false; score += typed.length ? 5 : -10; reasons.push(typed.length ? `${typed.length}/${own.length} non-variant prop names exist with a matching type` : "none of the instance prop names exist on this definition"); }
  }
  if (SHARED_PAGE.test(String(cand.page || ""))) { score += 5; reasons.push(`lives on a shared page (${cand.page})`); }
  return { verified, score, reasons };
}

const sigOf = (c: CatalogComponent): string => JSON.stringify(Object.entries(c.props || {}).map(([k, v]) => [baseProp(k), v.type, v.options || null]).sort());

// A catalog entry with its position in the catalog (the last tie-break).
type OrderedComponent = CatalogComponent & { _order: number };
interface Scored { c: OrderedComponent; verified: boolean; score: number; reasons: string[]; failing: Signature | undefined }

// instances: visibleInstances() output (any number of screens). catalog: components.local.json.
// library: components.library.json (optional) — only used to say WHY a residual did not match.
// Returns one row per distinct instance NAME (a screen using six Button variants proposes Button once),
// in first-seen order.
function matchByNameAndSignature(instances: readonly MatchInstance[], catalog: ComponentsCatalog | null | undefined, library?: ComponentsCatalog | null): MatchResult {
  const comps = (catalog && catalog.components) || [];
  const byName = new Map<string, OrderedComponent[]>();
  comps.forEach((c, i) => { if (!byName.has(c.name)) byName.set(c.name, []); byName.get(c.name)!.push(Object.assign({ _order: i }, c)); });
  const catKeys = new Set(comps.map((c) => c.key).filter((k): k is string => !!k));
  const libKeys = new Set(((library && library.components) || []).map((c) => c.key).filter((k): k is string => !!k));
  const libNames = new Set(((library && library.components) || []).map((c) => c.name));

  const groups = new Map<string, [MatchInstance, ...MatchInstance[]]>();
  for (const inst of instances) {
    const group = groups.get(inst.name);
    if (group) group.push(inst); else groups.set(inst.name, [inst]);
  }
  const rows: MatchRow[] = [];
  for (const [name, list] of groups) {
    const byKey = list.some((i) => catKeys.has(i.key ?? "") || catKeys.has(i.setKey ?? ""));
    const row: MatchRow = {
      name,
      instances: list.length,
      nodeIds: list.map((i) => i.nodeId),
      screens: [...new Set(list.map((i) => i.screen).filter((s): s is string => !!s))],
      instanceKeys: [...new Set(list.map((i) => i.setKey || i.key).filter((k): k is string => !!k))],
      remote: list.every((i) => i.remote),
      byKey,
      match: null,
      alternatives: [],
      reasons: [],
    };
    const cands = byName.get(name) || [];
    if (!cands.length) {
      const inLibrary = list.some((i) => libKeys.has(i.key ?? "") || libKeys.has(i.setKey ?? ""));
      row.reasons.push(`no catalog entry named ${JSON.stringify(name)}`);
      row.reasons.push(inLibrary
        ? "its key IS in components.library.json — a third-party library both files consume, not the design system's own component"
        : libNames.has(name)
          ? "the name appears in components.library.json — a third-party library the design system consumes, not one of its own components"
          : "not a component of the exported design system (typically an external icon library) — expected, not a miss");
      rows.push(row);
      continue;
    }
    // Every instance of the name must agree with the winner — one mismatching variant is enough to
    // refuse the proposal, since a mapping is per component, not per instance.
    const [firstInst, ...otherInsts] = list;
    const scored: Scored[] = cands.map((c) => {
      const first = signature(firstInst, c);
      const per = [first, ...otherInsts.map((i) => signature(i, c))];
      return { c, verified: per.every((p) => p.verified), score: Math.min(...per.map((p) => p.score)), reasons: first.reasons, failing: per.find((p) => !p.verified) };
    }).sort((a, b) => (Number(b.verified) - Number(a.verified)) || (b.score - a.score) || (a.c._order - b.c._order));
    const best = scored[0];
    if (best === undefined) throw new Error("component-match: a non-empty candidate list scored to nothing"); // cands is non-empty here (the `!cands.length` branch above continued)
    if (!best.verified) {
      row.reasons.push(`${cands.length} catalog entr${cands.length === 1 ? "y is" : "ies are"} named ${JSON.stringify(name)}, but no prop signature agrees: ` +
        (best.failing ? best.failing.reasons.filter((r) => /NOT|not in|none of|\d+\/\d+|sets no variant/.test(r)).join("; ") : "signature mismatch") +
        " — a name alone is not a match");
      rows.push(row);
      continue;
    }
    const verifiedOnes = scored.filter((s) => s.verified);
    const runnerUp = verifiedOnes[1]; // set exactly when verifiedOnes.length > 1
    const ties = verifiedOnes.filter((s) => s.score === best.score && s !== best);
    row.match = { ...ifDefined("id", best.c.id), ...ifDefined("key", best.c.key), name: best.c.name, type: best.c.type, ...ifDefined("page", best.c.page) };
    // How much the signature actually proved: an instance with variants or props proved it; one with
    // neither only proved "a plain component of that name with no props", which is weaker — shown as
    // such on the confirmation list, and not counted towards the re-key verdict.
    row.evidence = list.some((i) => i.variant || Object.keys(i.props || {}).length) ? "name+signature" : "name+no-props";
    row.reasons = best.reasons.slice();
    if (ties.length) {
      const identical = ties.every((t) => sigOf(t.c) === sigOf(best.c));
      row.reasons.push(identical
        ? `${ties.length + 1} catalog entries named "${name}" score identically — they are duplicates of one definition (same props, same variants); the first in the catalog is used`
        : `${ties.length + 1} catalog entries named "${name}" score identically with DIFFERENT signatures — the first in the catalog is used; confirm which one`);
      row.tie = identical ? "duplicate-definitions" : "different-signatures";
    } else if (scored.length > 1) {
      row.reasons.push(`beat ${scored.length - 1} same-named candidate(s)${runnerUp ? ` by ${best.score - runnerUp.score} pts` : " (their prop signatures do not agree)"}`);
    }
    row.alternatives = verifiedOnes.filter((s) => s !== best).map((s): MatchAlternative => ({ ...ifDefined("id", s.c.id), ...ifDefined("key", s.c.key), ...ifDefined("page", s.c.page), score: s.score }));
    row.reasons.push("key lookup: " + (byKey ? "matched" : "NO MATCH (the instance's key is not in the catalog — re-keyed)"));
    rows.push(row);
  }
  const proposals = rows.filter((r) => r.match && !r.byKey);
  return {
    rows,
    proposals,
    summary: {
      instances: instances.length,
      names: rows.length,
      byKey: rows.filter((r) => r.byKey).length,
      proposed: proposals.length,
      proposedWithSignature: proposals.filter((r) => r.evidence === "name+signature").length,
      withCandidates: rows.filter((r) => (byName.get(r.name) || []).length).length,
      unmatched: rows.filter((r) => !r.match).length,
      remote: instances.filter((i) => i.remote).length,
    },
  };
}

// The copy/re-key verdict, in ONE place so cross-check, audit and drift-lint cannot disagree:
// (almost) nothing resolves by key, yet most names that DO exist in the catalog agree on signature.
const REKEY_MIN_PROPOSALS = 3;
const REKEY_MIN_SHARE = 0.5;
function isRekeyed(result: MatchResult): boolean {
  const s = result.summary;
  return s.names > 0 && s.byKey / s.names <= 0.05 && s.proposedWithSignature >= REKEY_MIN_PROPOSALS &&
    s.withCandidates > 0 && s.proposedWithSignature / s.withCandidates >= REKEY_MIN_SHARE;
}

export { visibleInstances, parseVariant, matchByNameAndSignature, isRekeyed, REKEY_MIN_PROPOSALS, REKEY_MIN_SHARE };
