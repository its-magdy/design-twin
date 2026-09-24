// plan-skeleton.ts — generate design/plan/<screen>.json's skeleton FROM THE EXPORT, so the model fills
// in only what is genuinely a decision. P2b (livetest-3 §2.9 f; findings 79, 151, 155, 156, 196).
//
// Why: build-screen used to have the model hand-transcribe the whole plan — the token table, the
// component inventory, the anchors. That is how hidden nodes, mis-typed token names and wrong values
// entered the plan and then passed the Stop hook, because code and plan agreed with each other. Every
// fact below is DERIVED from the export; the model fills only `codeToken`, `mapModule`, `verdict`,
// `decision`, `route` and `deviations[]` (plus `files[]`, `architecture` and `verification` as it
// builds).
//
//   tokens[]      every variable the screen binds (node `tokens` maps, incl. fills/strokes/effects),
//                 one row per bound NAME, carrying the Figma KEY it resolves to in the screen's own
//                 .vars.json, its value in the mode this frame renders, the design-system definition
//                 (matched by key; by name only as a labelled fallback — a name match with a different
//                 value is exactly the `Space 4` 24-vs-16 trap), and how many VISIBLE / hidden nodes
//                 bind it. A token bound only by hidden layers is pre-marked `verdict:"hidden-only"`.
//   components[]  every VISIBLE instance (hidden layers are not built, so they are not planned), with
//                 key/setKey/name/variant/props and its identity: the design-system catalog entry it
//                 matches — by key, or by P1's name+prop-signature matcher (component-match.ts) when a
//                 duplicated file re-keyed everything — and the codeconnect.local.json mapping when one
//                 exists. Component identity comes from here, never from a hand-placed attribute.
//   anchors{}     every VISIBLE node id → {name, type, parent, mapModule:""}. Fill `mapModule` on
//                 sections and instances; a node whose own mapModule is empty is covered by its nearest
//                 mapped ancestor, so a 12-row `.map()` or a reused shell needs one entry, not twelve.
//   hidden[]      the roots of every hidden subtree (`hidden: true`), with how many nodes each hides.
//
// Hidden predicate — the ONE rule (design-to-code/hidden.ts, shared with verify-screen/audit/drift-lint
// and, through visibility() below, verify-build.ts): a node is hidden when it or any ancestor carries
// `"hidden": true`. Never `visible === false`: `"visible"` is also a component PROPERTY
// name in this export (`"visible": "Show Breadcrumb"`), finding 34.
//
// Output is deterministic (no timestamps of its own), so a re-run diffs cleanly. With --out on an
// existing plan it MERGES: every model-filled field (codeToken, mapModule, verdict, decision, …) and
// every top-level field the skeleton does not own (files, architecture, verification, deviations,
// status, …) is kept; rows that no longer exist in the export are dropped and counted on stderr.

import fs from "node:fs";
import path from "node:path";
import { matchByNameAndSignature, parseVariant } from "./component-match.ts";
import { walkWithHidden } from "./hidden.ts";
import { auditGateStatus } from "./audit-gate.ts";
import { isJsonObject } from "./types.ts";
import { isScreenDoc, screenExportOf, screenRoots } from "./export-shape.ts";
import { isComponentsCatalog, isPageIndex, isPagesRootIndex, isTokensDoc, parsePlan } from "./doc-guards.ts";
import type { DocGuard } from "./doc-guards.ts";
import { anyJson, readJson, readJsonOrNull } from "./read-json.ts";
import { isCodeConnectMap } from "./map-validate.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import type {
  CodeConnectMap, ComponentsCatalog, IndexRow, IrNode, JsonObject, JsonValue, MapStatus, MatchRow, ModeMap, PageIndex, PagesRootIndex, Plan,
  PlanAnchor, PlanAuditGate, PlanComponentMatch, PlanComponentRow, PlanHiddenRoot, PlanTokenRow, PlanTokenVerdict, ScreenDoc, TokenKind, TokensDoc, Variable, VariableAlias,
  MatchInstance, VariableType,
} from "./types.ts";
import { parseHex, formatHex, composeAlpha } from "./color.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2

const USAGE = [
  `usage: ${scriptCmd("plan-skeleton")} <screen.json> <screen.vars.json> <design-system dir> [--out <plan.json>] [--map <codeconnect.local.json>] [--route <route>]`,
  "",
  "  Emits the build-screen plan skeleton for one screen, derived from the export:",
  "    tokens[]      every bound variable (keyed by Figma key, value in the frame's mode, design-system match)",
  "    components[]  every VISIBLE instance (key/setKey/name/props + catalog match / codeconnect mapping)",
  "    anchors{}     every VISIBLE node id, mapModule empty — fill it on sections and instances",
  "    hidden[]      roots of hidden subtrees (hidden: true or a hidden ancestor) — never built, never anchored",
  "    screenName / nodeId / file / route   the header every skill resolves a plan by",
  "",
  "  You fill in: codeToken, mapModule, verdict, decision, route, deviations[] (and files[], architecture,",
  "  verification as you build).",
  "",
  "  <design-system dir>  design/export/design-system (tokens.json, components.local.json). A missing",
  "                       directory is allowed (single-screen pull): values then come from the screen's",
  "                       own .vars.json and no catalog match is attempted — stderr says so.",
  "  --out <file>         write the plan there (default: stdout). An existing plan is MERGED, never",
  "                       overwritten: every field you filled is kept.",
  "  --map <file>         codeconnect.local.json (default: design/codeconnect.local.json or",
  "                       codeconnect.local.json in the current directory, when present).",
  "  --route <route>      the app route this screen will live at (else left null for you to fill).",
].join("\n");

/** What walkNodes hands its visitor beside the node. */
export interface NodeContext { parent: IrNode | null; hidden: boolean; hiddenRoot: boolean; insideInstance: string | null }

// Walk every node with its ancestry and hidden state, through the ONE shared predicate (hidden.ts:
// the node or an ancestor carries `hidden`; never `visible`). `insideInstance` is the nearest INSTANCE
// above the node — its internals belong to that component.
function walkNodes(doc: ScreenDoc | null | undefined, visit: (n: IrNode, ctx: NodeContext) => void): void {
  const instAbove = new Map<IrNode, string | null>();
  for (const r of screenRoots(doc)) {
    walkWithHidden(r, (n, c) => {
      const above = c.parent ? (c.parent.type === "INSTANCE" ? c.parent.id : instAbove.get(c.parent) || null) : null;
      instAbove.set(n, above);
      visit(n, { parent: c.parent, hidden: c.hidden, hiddenRoot: c.hidden && !c.parentHidden, insideInstance: above });
    });
  }
}

export interface VisibleEntry { node: IrNode; parentId: string | null; insideInstance: string | null }
export interface Visibility { visible: Map<string, VisibleEntry>; hidden: Set<string>; hiddenRoots: PlanHiddenRoot[] }

// { visible: Map(id -> {node, parentId}), hidden: Set(id), hiddenRoots: [...] }
function visibility(doc: ScreenDoc | null | undefined): Visibility {
  const visible = new Map<string, VisibleEntry>(), hidden = new Set<string>(), hiddenRoots: PlanHiddenRoot[] = [];
  const count = new Map<string, PlanHiddenRoot>();
  walkNodes(doc, (n, ctx) => {
    if (!n.id) return;
    if (ctx.hidden) {
      hidden.add(n.id);
      if (ctx.hiddenRoot) { hiddenRoots.push({ id: n.id, name: n.name, type: n.type, nodes: 0 }); count.set(n.id, hiddenRoots[hiddenRoots.length - 1]); }
    } else visible.set(n.id, { node: n, parentId: ctx.parent ? ctx.parent.id : null, insideInstance: ctx.insideInstance });
  });
  // how many nodes each hidden root hides (itself included)
  const tally = (n: IrNode | null | undefined, root: string | null): void => {
    if (!n || typeof n !== "object") return;
    const r = root || (count.has(n.id) ? n.id : null);
    if (r) count.get(r)!.nodes++;
    for (const c of n.children || []) tally(c, r);
  };
  for (const r of screenRoots(doc)) tally(r, null);
  return { visible, hidden, hiddenRoots };
}

// ---------------------------------------------------------------- tokens

export interface Binding { name: string; field: string }

// Every (name, field) a node binds: its own `tokens` map, and `tokens` maps nested in fills / strokes /
// effects / textRangeFills … (NOT in children — those are other nodes).
function bindingsOf(node: IrNode): Binding[] {
  const out: Binding[] = [];
  // `o` is whatever sits under a node field (a paint, an effect, a run…): walked as plain JSON.
  const collect = (o: unknown, where: string): void => {
    if (Array.isArray(o)) { for (const x of o) collect(x, where); return; }
    if (!isJsonObject(o)) return;
    if (o.tokens && typeof o.tokens === "object") {
      for (const [field, v] of Object.entries(o.tokens)) for (const name of Array.isArray(v) ? v : [v]) if (typeof name === "string") out.push({ name, field: where ? `${where}.${field}` : field });
    }
    for (const [k, v] of Object.entries(o)) if (k !== "tokens" && k !== "children" && v && typeof v === "object") collect(v, where || k);
  };
  collect(Object.assign({}, node, { children: undefined }), "");
  return out;
}

function kindOf(variable: Variable | null | undefined, fields: string[]): TokenKind {
  const t = variable && variable.type;
  if (t === "COLOR") return "color";
  if (t === "STRING") return /fontStyle|fontFamily|fontName/.test(fields.join(" ")) ? "fontStyle" : "string";
  if (t === "BOOLEAN") return "boolean";
  const f = fields.join(" ");
  if (/Radius/i.test(f)) return "radius";
  if (/fontSize/.test(f)) return "fontSize";
  if (/fontWeight/.test(f)) return "fontWeight";
  if (/lineHeight/.test(f)) return "lineHeight";
  if (/letterSpacing/.test(f)) return "letterSpacing";
  if (/padding|itemSpacing|counterAxisSpacing|gap/i.test(f)) return "spacing";
  if (/strokeWeight|strokeTopWeight|strokeWidth/i.test(f)) return "borderWidth";
  if (/width|height/i.test(f)) return "size";
  if (/opacity/i.test(f)) return "opacity";
  return "number";
}

const isAlias = (v: unknown): v is VariableAlias => !!v && typeof v === "object" && "aliasOf" in v && typeof v.aliasOf === "string";

interface Resolved { value: JsonValue | null; mode: string | null; via?: string }

// A variable's value in the mode this frame renders. The frame's `resolvedModes` names a mode per
// COLLECTION; an alias hops to another collection, whose own mode is looked up the same way.
function resolver(sources: ReadonlyArray<TokensDoc | null | undefined>, resolvedModes: ModeMap): (v: Variable | null | undefined) => Resolved {
  const byName = new Map<string, Variable>();
  const collections = new Map<string, NonNullable<TokensDoc["collections"]>[number]>();
  for (const src of sources) {
    for (const v of (src && src.variables) || []) if (v && v.name && !byName.has(v.name)) byName.set(v.name, v);
    for (const c of (src && src.collections) || []) if (c && c.name && !collections.has(c.name)) collections.set(c.name, c);
  }
  const modeFor = (v: Variable): string => {
    const vals = v.values || {};
    const keys = Object.keys(vals);
    // A variable whose collection the export could not name has no frame mode and no collection default.
    const want: string | undefined = v.collection === undefined ? undefined : resolvedModes[v.collection];
    if (want !== undefined && want in vals) return want;
    // case-only differences ("desktop" vs "Desktop") are the same mode
    if (want !== undefined) { const k = keys.find((x) => x.toLowerCase() === String(want).toLowerCase()); if (k) return k; }
    const c = v.collection === undefined ? undefined : collections.get(v.collection);
    if (c && c.default && c.default in vals) return c.default;
    return keys[0];
  };
  function resolve(v: Variable | null | undefined, depth: number): Resolved {
    if (!v || depth > 10) return { value: null, mode: null };
    const mode = modeFor(v);
    const raw = (v.values || {})[mode];
    if (isAlias(raw)) {
      const target = byName.get(raw.aliasOf);
      const r = resolve(target, depth + 1);
      return { value: r.value, mode, via: raw.aliasOf };
    }
    // A composed colour (doc-types ComposedColor): the colour half (alias -> resolved, hex as is) and
    // the opacity half (a number, or an alias -> that FLOAT's resolved number) folded into ONE hex.
    // Either half unresolvable -> null, as before.
    if (raw && typeof raw === "object" && "composed" in raw) {
      const { color, opacity } = raw.composed;
      const c = typeof color === "string" ? color : resolve(byName.get(color.aliasOf), depth + 1).value;
      const o = typeof opacity === "number" ? opacity : resolve(byName.get(opacity.aliasOf), depth + 1).value;
      return { value: composedHex(c, o), mode };
    }
    return { value: normValue(v.type, raw), mode };
  }
  return (v) => resolve(v, 0);
}

// A composed colour's one colour, as the "#rrggbb[aa]" normValue writes (opaque -> 6 digits); null when
// either half did not resolve to a colour / a finite number. The opacity is a 0–100 percentage (REST API
// variables types, VariableComposedColor.opacity: https://developers.figma.com/docs/rest-api/variables-types/),
// clamped and multiplied into the colour's alpha by color.ts composeAlpha (Help Center 14506821864087 for
// the clamp; the multiply is an inference — see composeAlpha).
function composedHex(color: JsonValue | null, opacity: JsonValue | null): string | null {
  const c = parseHex(color);
  if (!c || typeof opacity !== "number" || !Number.isFinite(opacity)) return null;
  return formatHex({ ...c, a: composeAlpha(c.a, opacity) });
}

// ts-port: legacy/producer-mismatch read kept as-is — a COLOR value spelled as {r,g,b,a} (the producer
// writes a hex string; variables.ts). Declared as a JSON object so it stays a JsonValue on the way out.
type LegacyRgba = JsonObject & { r: number; g: number; b: number };
const isLegacyRgba = (v: object): v is LegacyRgba => "r" in v;

function normValue(type: VariableType | undefined, raw: string | number | boolean | LegacyRgba | null | undefined): JsonValue | null {
  if (raw === undefined || raw === null) return null;
  if (type === "COLOR" && typeof raw === "string") {
    const h = raw.trim().toLowerCase();
    return /^#[0-9a-f]{8}$/.test(h) && h.endsWith("ff") ? h.slice(0, 7) : h;
  }
  if (type === "COLOR" && typeof raw === "object" && isLegacyRgba(raw)) {
    const to = (x: number): string => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
    const a = raw.a === undefined ? 1 : Number(raw.a);
    return "#" + to(raw.r) + to(raw.g) + to(raw.b) + (a < 1 ? to(a) : "");
  }
  return raw;
}

/** A token row as the skeleton writes it: `sites` is always present here (PlanTokenRow leaves it optional). */
export interface SkeletonTokenRow extends PlanTokenRow { figmaName: string; sites: { visible: number; hidden: number } }
/** The same row while buildTokens is still filling it (codeToken/verdict come last). */
type TokenRowDraft = Omit<SkeletonTokenRow, "codeToken" | "verdict"> & { codeToken?: string | null; verdict?: PlanTokenVerdict | null };

function buildTokens(doc: ScreenDoc | null | undefined, vars: TokensDoc | null | undefined, ds: TokensDoc | null | undefined, resolvedModes: ModeMap): SkeletonTokenRow[] {
  const uses = new Map<string, { fields: Set<string>; visible: number; hidden: number }>(); // name -> { fields:Set, visible, hidden }
  walkNodes(doc, (n, ctx) => {
    for (const b of bindingsOf(n)) {
      if (!uses.has(b.name)) uses.set(b.name, { fields: new Set(), visible: 0, hidden: 0 });
      const u = uses.get(b.name)!;
      u.fields.add(b.field);
      if (ctx.hidden) u.hidden++; else u.visible++;
    }
  });
  const own = new Map<string, Variable[]>();
  for (const v of (vars && vars.variables) || []) { if (!own.has(v.name)) own.set(v.name, []); own.get(v.name)!.push(v); }
  const dsByKey = new Map<string, Variable>(), dsByName = new Map<string, Variable[]>();
  for (const v of (ds && ds.variables) || []) {
    if (v.key) dsByKey.set(v.key, v);
    if (!dsByName.has(v.name)) dsByName.set(v.name, []);
    dsByName.get(v.name)!.push(v);
  }
  const ownResolve = resolver([vars, ds], resolvedModes);
  const dsResolve = resolver([ds], resolvedModes);

  const rows: SkeletonTokenRow[] = [];
  for (const [name, u] of uses) {
    const fields = [...u.fields].sort();
    const cands = own.get(name) || [];
    const v = cands[0] || null;
    const r = v ? ownResolve(v) : { value: null, mode: null };
    // Built in the order the plan file shows its keys; codeToken/verdict are filled last (below).
    const row: TokenRowDraft = {
      figmaName: name,
      key: cands.length === 1 ? v.key || null : null,
      collection: (v && v.collection) ?? null, // null: no variable, or the export could not name its collection
      kind: kindOf(v, fields),
      value: r.value,
      mode: r.mode,
      bindings: fields,
      sites: { visible: u.visible, hidden: u.hidden },
    };
    if (r.via) row.aliasOf = r.via;
    if (cands.length > 1) {
      // Two variables with ONE name in the screen's own slice: the node JSON binds by name only, so the
      // key cannot be derived. Say so rather than pick one.
      const vals = cands.map((c) => ({ key: c.key, collection: c.collection, value: ownResolve(c).value }));
      row.keyCandidates = vals;
      row.note = `${cands.length} variables in this screen's .vars.json are named '${name}'` +
        (new Set(vals.map((x) => JSON.stringify(x.value))).size > 1 ? " WITH DIFFERENT VALUES — decide which one the design means before mapping it" : " (same value) — either key describes it");
    }
    if (!v) row.note = `'${name}' is bound on the frame but not defined in the screen's .vars.json — re-pull the screen`;
    // Design-system definition: by KEY; a name-only match is a labelled fallback, never silently the value.
    let dv: Variable | null = null, how: "key" | "name" | null = null;
    for (const c of cands) if (c.key && dsByKey.has(c.key)) { dv = dsByKey.get(c.key)!; how = "key"; break; }
    if (!dv && dsByName.has(name)) {
      const same = dsByName.get(name)!.filter((x) => !v || x.collection === v.collection);
      dv = (same.length ? same : dsByName.get(name)!)[0];
      how = "name";
    }
    if (dv && how) {
      const dr = dsResolve(dv);
      row.designSystem = { match: how, key: dv.key || null, value: dr.value, agrees: JSON.stringify(dr.value) === JSON.stringify(r.value) };
    } else row.designSystem = null;
    row.codeToken = null;
    if (!u.visible) {
      row.verdict = "hidden-only";
      row.decision = "bound only by hidden layers — not built, so no code token is needed";
    } else row.verdict = null;
    rows.push({ ...row, codeToken: row.codeToken ?? null, verdict: row.verdict ?? null });
  }
  rows.sort((a, b) => Number(b.sites.visible > 0) - Number(a.sites.visible > 0) || a.figmaName.localeCompare(b.figmaName));
  return rows;
}

// ---------------------------------------------------------------- components

/** One codeconnect.local.json entry as loadMap() flattens it, keyed by figma.key and by map key. */
export interface MapKeyEntry { name: string; module: string | null; export: string | null; status: MapStatus | null }

function mapKeysOf(map: CodeConnectMap): Map<string, MapKeyEntry> {
  const keys = new Map<string, MapKeyEntry>();
  for (const [name, e] of Object.entries(map.components)) {
    const entry: MapKeyEntry = { name: e.figma.name, module: e.code.module, export: e.code.export, status: e.status || null };
    if (e.figma.key) keys.set(e.figma.key, entry);
    if (!keys.has(name)) keys.set(name, entry);
  }
  return keys;
}

// A visible instance as the plan lists it: keys are `null` (not absent) when the export has none, no
// screen label (one screen), and the instance it sits inside.
interface SkeletonInstance extends MatchInstance { key: string | null; setKey: string | null; insideInstance: string | null }

function buildComponents(doc: ScreenDoc | null | undefined, catalog: ComponentsCatalog | null | undefined, library: ComponentsCatalog | null | undefined, mapKeys: Map<string, MapKeyEntry>): PlanComponentRow[] {
  const insts: SkeletonInstance[] = [];
  walkNodes(doc, (n, ctx) => {
    if (ctx.hidden || n.type !== "INSTANCE") return;
    const mc: Partial<NonNullable<IrNode["mainComponent"]>> = n.mainComponent || {};
    insts.push({
      nodeId: n.id,
      layer: n.name,
      name: mc.setName || mc.name || n.name,
      key: mc.key || null,
      setKey: mc.setKey || null,
      remote: mc.remote === true,
      variant: parseVariant(n.component) || parseVariant(mc.variant),
      props: n.props && typeof n.props === "object" ? n.props : {},
      insideInstance: ctx.insideInstance || null,
    });
  });
  const catKeys = new Map<string, ComponentsCatalog["components"][number]>();
  for (const c of (catalog && catalog.components) || []) if (c.key) catKeys.set(c.key, c);
  const byName = new Map<string, MatchRow>();
  if (catalog) for (const r of matchByNameAndSignature(insts, catalog, library).rows) byName.set(r.name, r);

  return insts.map((i) => {
    let match: PlanComponentMatch | null = null;
    const k = [i.key, i.setKey].find((x) => x && catKeys.has(x));
    if (k) { const c = catKeys.get(k)!; match = { by: "key", id: c.id, key: c.key, name: c.name }; }
    else if (byName.has(i.name) && byName.get(i.name)!.match) {
      const r = byName.get(i.name)!;
      match = { by: r.evidence || "name+signature", id: r.match!.id, key: r.match!.key, name: r.match!.name, confirmed: false };
    }
    const mapped = [i.key, i.setKey].map((x) => x && mapKeys.get(x)).find(Boolean) || null;
    const row: PlanComponentRow = {
      nodeId: i.nodeId,
      name: i.name,
      layer: i.layer,
      key: i.key,
      setKey: i.setKey,
      variant: i.variant,
      props: i.props,
      catalog: match,
      mapped: mapped ? { module: mapped.module, export: mapped.export, status: mapped.status } : null,
      mapModule: mapped && mapped.module && !/^TODO/.test(mapped.module) ? mapped.module : "",
      verdict: null,
    };
    if (i.insideInstance) row.insideInstance = i.insideInstance;
    return row;
  });
}

// ---------------------------------------------------------------- the plan

/** skeleton()'s input bag. */
export interface SkeletonInput {
  doc: ScreenDoc; vars?: TokensDoc | null; ds?: TokensDoc | null; catalog?: ComponentsCatalog | null; library?: ComponentsCatalog | null;
  mapKeys?: Map<string, MapKeyEntry>; screenFile?: string | null; cwd?: string; route?: string | null; indexRow?: IndexRow | null;
}
/** The plan as this file writes it: every skeleton-owned field is present (Plan leaves them optional). */
export interface SkeletonPlan extends Plan {
  tokens: SkeletonTokenRow[]; components: PlanComponentRow[]; anchors: Record<string, PlanAnchor>; hidden: PlanHiddenRoot[];
  counts: NonNullable<Plan["counts"]>;
  /** the skeleton writes every auditGate field (a person edits them later) */
  auditGate: Required<PlanAuditGate> | null;
}

function skeleton({ doc, vars, ds, catalog, library, mapKeys, screenFile, cwd, route, indexRow }: SkeletonInput): SkeletonPlan {
  const vis = visibility(doc);
  const roots = screenRoots(doc);
  const root: IrNode | undefined = roots[0];
  const exp = screenExportOf(doc);
  const resolvedModes = (root && root.resolvedModes) || {};
  const tokens = buildTokens(doc, vars, ds, resolvedModes);
  const components = buildComponents(doc, catalog, library, mapKeys || new Map<string, MapKeyEntry>());
  const anchors: Record<string, PlanAnchor> = {};
  for (const [id, v] of vis.visible) anchors[id] = { name: v.node.name, type: v.node.type, parent: v.parentId, mapModule: "" };
  const nodeId = (exp && exp.nodeId) || (root && root.id) || null;
  const title = indexRow && indexRow.title;
  const rel = screenFile ? path.relative(cwd || process.cwd(), path.resolve(screenFile)).split(path.sep).join("/") : null;
  const screenName = String(title || (exp && exp.screen) || (root && root.name) || "").trim() || null;
  // finding 136: pre-fill a first-class auditGate from an existing audit with blockers, so the model
  // (or a person) has somewhere to record "acknowledged and overridden, here is why" instead of the
  // build silently proceeding past a Blocked verdict. overridden/reason/decidedBy/decidedAt are left
  // for a person to fill; a re-run of this script never clears what was already decided (see merge()).
  let auditGate: Required<PlanAuditGate> | null = null;
  try {
    const g = auditGateStatus(cwd || process.cwd(), screenFile, screenName);
    if (g.auditFile && g.blockers.length) {
      auditGate = { auditFile: g.auditFile, verdict: "blocked", blockers: g.blockers, overridden: [], reason: null, decidedBy: null, decidedAt: null };
    }
  } catch { /* the auditGate pre-fill is best-effort: plan-skeleton must never fail on reading an audit */ }
  // (audit-gate.ts is a static import now; the CJS version's lazy require — and its "could not load →
  // skip" fallback — is gone, since a static import cannot fail at this point. The try/catch stays
  // around the CALL: a malformed audit file must not fail the skeleton.)
  return {
    schema: "designtwin/plan@2",
    screen: screenFile ? path.basename(screenFile).replace(/\.json$/, "") : null,
    screenName,
    nodeId,
    route: route || null,
    file: rel,
    exportedAt: (exp && exp.exportedAt) || null,
    status: "pending",
    target: null,
    architecture: null,
    files: [],
    tokens,
    components,
    anchors,
    hidden: vis.hiddenRoots,
    deviations: [],
    auditGate,
    counts: {
      tokens: tokens.length,
      tokensVisible: tokens.filter((t) => t.sites.visible > 0).length,
      instances: components.length,
      anchors: Object.keys(anchors).length,
      hiddenNodes: vis.hidden.size,
    },
  };
}

export interface MergeResult { plan: Plan; dropped: { tokens: number; components: number; anchors: number } }

// Merge a fresh skeleton into an existing plan without losing anything a person or the model wrote.
const FILLED_TOKEN = ["codeToken", "verdict", "decision"] as const;
const FILLED_COMPONENT = ["mapModule", "verdict", "decision", "matchedByName"] as const;
function merge(fresh: SkeletonPlan, prev: Plan | null | undefined): MergeResult {
  if (!prev || typeof prev !== "object") return { plan: fresh, dropped: { tokens: 0, components: 0, anchors: 0 } };
  const out: Plan = Object.assign({}, prev, {
    schema: fresh.schema,
    screenName: prev.screenName || fresh.screenName,
    nodeId: fresh.nodeId,
    route: prev.route || fresh.route,
    file: fresh.file,
    exportedAt: fresh.exportedAt,
    hidden: fresh.hidden,
    // Never clear a decided auditGate; only fill one in if the plan never had one.
    auditGate: prev.auditGate || fresh.auditGate,
    counts: fresh.counts,
  });
  const dropped = { tokens: 0, components: 0, anchors: 0 };
  // A row's identity: its key, else its Figma name. A hand-written row with neither matches nothing
  // (identity "") and is counted as dropped — no fresh row has an empty identity.
  const tk = (t: PlanTokenRow): string => t.key || t.figmaName || "";
  const prevTok = new Map((prev.tokens || []).map((t): [string, PlanTokenRow] => [tk(t), t]));
  out.tokens = fresh.tokens.map((t) => {
    const p = prevTok.get(tk(t)) || prevTok.get(t.figmaName);
    const row: PlanTokenRow = Object.assign({}, t);
    if (p) for (const f of FILLED_TOKEN) if (p[f] !== undefined && p[f] !== null && p[f] !== "") Object.assign(row, { [f]: p[f] });
    return row;
  });
  dropped.tokens = [...prevTok.keys()].filter((k) => !fresh.tokens.some((t) => tk(t) === k || t.figmaName === k)).length;
  const prevComp = new Map((prev.components || []).filter((c): c is PlanComponentRow & { nodeId: string } => !!(c && c.nodeId)).map((c): [string, PlanComponentRow] => [c.nodeId, c]));
  out.components = fresh.components.map((c) => {
    const p = prevComp.get(c.nodeId!);
    const row: PlanComponentRow = Object.assign({}, c);
    if (p) for (const f of FILLED_COMPONENT) if (p[f] !== undefined && p[f] !== null && p[f] !== "") Object.assign(row, { [f]: p[f] });
    return row;
  });
  dropped.components = [...prevComp.keys()].filter((id) => !fresh.components.some((c) => c.nodeId === id)).length;
  const pa: Record<string, PlanAnchor> = prev.anchors || {};
  out.anchors = {};
  for (const [id, a] of Object.entries(fresh.anchors)) {
    const p = pa[id];
    out.anchors[id] = Object.assign({}, a, p && typeof p === "object" ? Object.fromEntries(Object.entries(p).filter(([k, v]) => !["name", "type", "parent"].includes(k) && v !== "" && v != null)) : {});
  }
  dropped.anchors = Object.keys(pa).filter((id) => !(id in fresh.anchors)).length;
  return { plan: out, dropped };
}

const isIndexDoc = (x: unknown): x is PagesRootIndex | PageIndex => isPagesRootIndex(x) || isPageIndex(x);
function findIndexRow(screenFile: string, nodeId: string | undefined): IndexRow | null {
  // pages/<Page>/<Screen>__id.json → ../../pages/index.json or ../index.json (best effort: the title only)
  const dir = path.dirname(path.resolve(screenFile));
  for (const idx of [path.join(dir, "..", "index.json"), path.join(dir, "index.json")]) {
    const d = readJsonOrNull(idx, isIndexDoc);
    const hit = ((d && d.layers) || []).find((r) => r.id === nodeId);
    if (hit) return hit;
  }
  return null;
}

// One line for a file that is there but cannot be used; `what` names it the way the messages always have.
const cannotRead = (what: string, file: string, error: string): number => { console.error(`plan-skeleton: cannot read ${what} ${file}: ${error}`); return 1; };

function main(argv: string[]): number {
  const OPTIONS = { out: { type: "string" }, map: { type: "string" }, route: { type: "string" }, help: { type: "boolean", short: "h" } } as const;
  const { values: flags, positionals } = cliParse("plan-skeleton", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; }
  const { out, map: mapFlag, route } = flags;
  if (positionals.length !== 3 || [out, mapFlag, route].some((v) => v === "")) { console.error(USAGE); return 2; }
  const [screenFile, varsFile, dsDir] = positionals;
  const screen = readJson(screenFile, isScreenDoc);
  if (!("doc" in screen)) return cannotRead("the screen JSON", screenFile, screen.error);
  const varsRead = readJson(varsFile, isTokensDoc);
  if (!("doc" in varsRead)) return cannotRead("the screen's variables", varsFile, varsRead.error);
  const doc = screen.doc, vars = varsRead.doc;
  const hasDs = dsDir && fs.existsSync(dsDir) && fs.statSync(dsDir).isDirectory();
  if (!hasDs) console.error(`plan-skeleton: no design-system directory at ${dsDir} — token values come from the screen's own .vars.json, and no catalog match was attempted (components[].catalog is null)`);
  // A split file that is absent is fine (a partial design system); one that is there but broken is not.
  const optional = <T,>(file: string, guard: DocGuard<T>): { doc: T | null } | { error: string } => {
    if (!hasDs) return { doc: null };
    const r = readJson(path.join(dsDir, file), guard);
    return "doc" in r ? r : r.missing ? { doc: null } : { error: r.error };
  };
  const dsRead = optional("tokens.json", isTokensDoc), catRead = optional("components.local.json", isComponentsCatalog), libRead = optional("components.library.json", isComponentsCatalog);
  if ("error" in dsRead) return cannotRead("the design system's tokens", path.join(dsDir, "tokens.json"), dsRead.error);
  if ("error" in catRead) return cannotRead("the component catalog", path.join(dsDir, "components.local.json"), catRead.error);
  if ("error" in libRead) return cannotRead("the library component catalog", path.join(dsDir, "components.library.json"), libRead.error);
  const mapFile = mapFlag || ["design/codeconnect.local.json", "codeconnect.local.json"].find((f) => fs.existsSync(f));
  let mapKeys = new Map<string, MapKeyEntry>();
  if (mapFile) {
    const m = readJson(mapFile, isCodeConnectMap);
    if (!("doc" in m)) return cannotRead("the component map", mapFile, m.error);
    mapKeys = mapKeysOf(m.doc);
  }
  const nodeId = screenExportOf(doc)?.nodeId || screenRoots(doc)[0]?.id;
  const fresh = skeleton({ doc, vars, ds: dsRead.doc, catalog: catRead.doc, library: libRead.doc, mapKeys, screenFile, cwd: process.cwd(), route, indexRow: findIndexRow(screenFile, nodeId) });
  const c = fresh.counts;
  if (!out) {
    process.stdout.write(JSON.stringify(fresh, null, 2) + "\n");
  } else {
    // An existing plan is MERGED into — so one that cannot be read (or is not a plan) is refused, untouched.
    const prevRead = readJson(out, anyJson);
    const parsed = "doc" in prevRead ? parsePlan(prevRead.doc) : null; // parsePlan names the field that is wrong
    const why = !("doc" in prevRead) ? (prevRead.missing ? null : prevRead.error) : parsed && "error" in parsed ? parsed.error : null;
    if (why) { console.error(`plan-skeleton: ${out} exists but ${why} — refusing to overwrite it`); return 1; }
    const prev = parsed && "plan" in parsed ? parsed.plan : null;
    const { plan, dropped } = merge(fresh, prev);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
    console.error(`plan-skeleton: ${prev ? "merged into" : "wrote"} ${out}` + (prev ? ` (kept every filled field; dropped ${dropped.tokens} token row(s), ${dropped.components} component row(s), ${dropped.anchors} anchor(s) no longer in the export)` : ""));
  }
  console.error(`plan-skeleton: ${c.tokens} bound token(s) (${c.tokensVisible} on visible nodes), ${c.instances} visible instance(s), ${c.anchors} visible node anchor slot(s), ${c.hiddenNodes} hidden node(s) excluded`);
  return 0;
}

export { skeleton, merge, visibility, walkNodes, bindingsOf, buildTokens, buildComponents, USAGE };

// exitCode, not exit(): exit() would cut a large plan off mid-write when stdout is a pipe.
if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
