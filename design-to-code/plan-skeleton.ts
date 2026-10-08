// plan-skeleton.ts — generate design/plan/<screen>.json's skeleton FROM THE EXPORT, so the model fills
// in only what is genuinely a decision (the fields and flags are in --help).
//
// Why: a model that hand-transcribes the whole plan — the token table, the component inventory, the
// anchors — is how hidden nodes, mis-typed token names and wrong values entered the plan and then
// passed the Stop hook, because code and plan agreed with each other. Every fact is DERIVED from the
// export; the model fills only `codeToken`, `mapModule`, `verdict`, `decision`, `route` and
// `deviations[]` (plus `files[]`, `architecture` and `verification` as it builds).
//
//   tokens[]      one row per bound NAME, carrying the Figma KEY it resolves to in the screen's own
//                 .vars.json. The design-system definition is matched by key; by name only as a labelled
//                 fallback — a name match with a different value is exactly the `Space 4` 24-vs-16 trap.
//                 A token bound only by hidden layers is pre-marked `verdict:"hidden-only"`.
//   components[]  every VISIBLE instance (hidden layers are not built, so they are not planned) with its
//                 identity: the catalog entry it matches — by key, or by the name+prop-signature matcher
//                 (component-match.ts) when a duplicated file re-keyed everything. Component identity
//                 comes from here, never from a hand-placed attribute. A name that component-match calls
//                 ambiguous (nameVerdict — the rule cross-check uses too) gets
//                 `catalog: {by:"ambiguous", candidates}`: never a match, the entries to choose from.
//   anchors{}     a node whose own mapModule is empty is covered by its nearest mapped ancestor, so a
//                 12-row `.map()` or a reused shell needs one entry, not twelve.
//   anchorsSuggested[]  where to put those entries: the screen frame itself first ("screen"; when it is an
//                 INSTANCE, that is all), the root's direct children ("section"), every outermost INSTANCE
//                 ("instance"), and each container whose children are mostly rows of one shape, >= 3 (a list:
//                 "repeat", its rows and the dividers between them are covered by it; its other children are still
//                 suggested). Every visible anchor is a suggestion or under one. Not part of counts; refreshed
//                 on every merge.
//
// Hidden predicate — the ONE rule (design-to-code/hidden.ts, shared with verify-screen/audit/drift-lint
// and, through visibility() below, verify-build.ts): a node is hidden when it or any ancestor carries
// `"hidden": true`. Never `visible === false`: `"visible"` is also a component PROPERTY
// name in this export (`"visible": "Show Breadcrumb"`).
//
// Output is deterministic (no timestamps of its own), so a re-run diffs cleanly. With --out on an
// existing plan it MERGES: every model-filled field and every top-level field the skeleton does not own
// (files, architecture, verification, deviations, status, …) is kept; rows that no longer exist in the
// export are dropped and counted on stderr. --seed-from fills what is still empty from a sibling plan,
// only for a row with the same identity, marked `seededFrom` for review.

import fs from "node:fs";
import path from "node:path";
import { matchByNameAndSignature, nameVerdict, parseVariant } from "./component-match.ts";
import { walkWithHidden } from "./hidden.ts";
import { auditGateStatus } from "./audit-gate.ts";
import { isJsonObject } from "./types.ts";
import { isScreenDoc, screenExportOf, screenRoots } from "./export-shape.ts";
import { isAlias, isComponentsCatalog, isPageIndex, isPagesRootIndex, isTokensDoc, parsePlan } from "./doc-guards.ts";
import type { DocGuard } from "./doc-guards.ts";
import { anyJson, readJson, readJsonOrNull } from "./read-json.ts";
import { isCodeConnectMap } from "./map-validate.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import type {
  AnchorSuggestion, CodeConnectMap, ComponentsCatalog, IndexRow, IrNode, JsonObject, JsonValue, MapStatus, MatchRow, ModeMap, PageIndex, PagesRootIndex, Plan,
  PlanAnchor, PlanAuditGate, PlanComponentMatch, PlanComponentRow, PlanHiddenRoot, PlanTokenRow, PlanTokenVerdict, ScreenDoc, TokenKind, TokensDoc, Variable,
  MatchInstance, VariableType,
} from "./types.ts";
import { parseHex, formatHex, composeAlpha } from "./color.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";
import { writePlan } from "./plan-record.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2
import { findMapFile } from "../bridge/src/project-layout.ts";
import { DESIGN_SYSTEM_FILES } from "../bridge/src/design-system-layout.ts";

const USAGE = [
  `usage: ${scriptCmd("plan-skeleton")} <screen.json> <screen.vars.json> <design-system dir> [--out <plan.json>] [--map <codeconnect.local.json>] [--route <route>] [--seed-from <plan.json>]...`,
  "",
  "  Emits the build-screen plan skeleton for one screen, derived from the export:",
  "    tokens[]      every bound variable (keyed by Figma key, value in the frame's mode, design-system match)",
  "    components[]  every VISIBLE instance (key/setKey/name/props + catalog match / codeconnect mapping)",
  "    anchors{}     every VISIBLE node id, mapModule empty — fill it on sections and instances",
  "    anchorsSuggested[]  the few anchors worth filling first (the screen frame, root sections, outermost instances, repeated lists)",
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
  "  --seed-from <plan>   a sibling screen's plan (repeatable; the first that has an answer wins). A row still",
  "                       empty here takes that plan's answer when it is the SAME thing: a token with the same",
  "                       key (or, both keyless, the same Figma name) AND the same value → codeToken/verdict/",
  "                       decision; a component with the same setKey (else key) → mapModule/verdict/decision.",
  "                       Nothing filled is ever overwritten. Seeded rows carry `seededFrom` — review them.",
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
      if (ctx.hiddenRoot) { const root: PlanHiddenRoot = { id: n.id, name: n.name, type: n.type, nodes: 0 }; hiddenRoots.push(root); count.set(n.id, root); }
    } else visible.set(n.id, { node: n, parentId: ctx.parent ? ctx.parent.id : null, insideInstance: ctx.insideInstance });
  });
  // how many nodes each hidden root hides (itself included)
  const tally = (n: IrNode | null | undefined, root: string | null): void => {
    if (!n || typeof n !== "object") return;
    const r = root || (count.has(n.id) ? n.id : null);
    const entry = r ? count.get(r) : undefined; // r is always a key of count (root, or n.id when count has it)
    if (entry) entry.nodes++;
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

// mode is undefined for a variable with no values at all (no mode to name), as it always was at runtime
interface Resolved { value: JsonValue | null; mode: string | null | undefined; via?: string }

// A variable's value in the mode this frame renders. The frame's `resolvedModes` names a mode per
// COLLECTION; an alias hops to another collection, whose own mode is looked up the same way.
function resolver(sources: ReadonlyArray<TokensDoc | null | undefined>, resolvedModes: ModeMap): (v: Variable | null | undefined) => Resolved {
  const byName = new Map<string, Variable>();
  const collections = new Map<string, NonNullable<TokensDoc["collections"]>[number]>();
  for (const src of sources) {
    for (const v of (src && src.variables) || []) if (v && v.name && !byName.has(v.name)) byName.set(v.name, v);
    for (const c of (src && src.collections) || []) if (c && c.name && !collections.has(c.name)) collections.set(c.name, c);
  }
  const modeFor = (v: Variable): string | undefined => {
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
    const raw = mode === undefined ? undefined : (v.values || {})[mode]; // no mode: no values to read
    if (isAlias(raw)) {
      const target = byName.get(raw.aliasOf);
      const r = resolve(target, depth + 1);
      return { value: r.value, mode, via: raw.aliasOf };
    }
    // A composed colour (doc-types ComposedColor): the colour half (alias -> resolved, hex as is) and
    // the opacity half (a number, or an alias -> that FLOAT's resolved number) folded into ONE hex.
    // Either half unresolvable -> null.
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

// A producer-mismatch read, kept as-is — a COLOR value spelled as {r,g,b,a} (the producer
// writes a hex string; variables.ts). Declared as a JSON object so it stays a JsonValue on the way out.
type LegacyRgba = JsonObject & { r: number; g: number; b: number };
const isLegacyRgba = (v: object): v is LegacyRgba => "r" in v;

function normValue(type: VariableType | undefined, raw: string | number | boolean | LegacyRgba | null | undefined): JsonValue | null {
  if (raw === undefined || raw === null) return null;
  // One spelling per colour (color.ts: "#rrggbb", or "#rrggbbaa" below opaque), so the JSON compare of a
  // screen's value with the design system's says "agrees" for #abc and #AABBCCFF alike; a string that is
  // not a hex colour is kept, trimmed and lowercased.
  if (type === "COLOR" && typeof raw === "string") {
    const c = parseHex(raw);
    return c ? formatHex(c) : raw.trim().toLowerCase();
  }
  if (type === "COLOR" && typeof raw === "object" && isLegacyRgba(raw)) {
    const a = raw.a === undefined ? 1 : Number(raw.a);
    return formatHex({ r: raw.r * 255, g: raw.g * 255, b: raw.b * 255, a: Number.isNaN(a) ? 1 : a });
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
      const u = getOrInit(uses, b.name, () => ({ fields: new Set<string>(), visible: 0, hidden: 0 }));
      u.fields.add(b.field);
      if (ctx.hidden) u.hidden++; else u.visible++;
    }
  });
  const own = new Map<string, Variable[]>();
  for (const v of (vars && vars.variables) || []) getOrInit(own, v.name, () => []).push(v);
  const dsByKey = new Map<string, Variable>(), dsByName = new Map<string, Variable[]>();
  for (const v of (ds && ds.variables) || []) {
    if (v.key) dsByKey.set(v.key, v);
    getOrInit(dsByName, v.name, () => []).push(v);
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
      key: cands.length === 1 && v ? v.key || null : null, // v is cands[0] here
      collection: (v && v.collection) ?? null, // null: no variable, or the export could not name its collection
      kind: kindOf(v, fields),
      value: r.value,
      ...ifDefined("mode", r.mode),
      bindings: fields,
      sites: { visible: u.visible, hidden: u.hidden },
    };
    if (r.via) row.aliasOf = r.via;
    if (cands.length > 1) {
      // Two variables with ONE name in the screen's own slice: the node JSON binds by name only, so the
      // key cannot be derived. Say so rather than pick one.
      const vals = cands.map((c) => ({ ...ifDefined("key", c.key), ...ifDefined("collection", c.collection), value: ownResolve(c).value }));
      row.keyCandidates = vals;
      row.note = `${cands.length} variables in this screen's .vars.json are named '${name}'` +
        (new Set(vals.map((x) => JSON.stringify(x.value))).size > 1 ? " WITH DIFFERENT VALUES — decide which one the design means before mapping it" : " (same value) — either key describes it");
    }
    if (!v) row.note = `'${name}' is bound on the frame but not defined in the screen's .vars.json — re-pull the screen`;
    // Design-system definition: by KEY; a name-only match is a labelled fallback, never silently the value.
    let dv: Variable | null = null, how: "key" | "name" | null = null;
    for (const c of cands) {
      const hit = c.key ? dsByKey.get(c.key) : undefined;
      if (hit) { dv = hit; how = "key"; break; }
    }
    const named = dv ? undefined : dsByName.get(name);
    if (named) {
      const same = named.filter((x) => !v || x.collection === v.collection);
      dv = (same.length ? same : named)[0] ?? null; // ?? null: every dsByName list has an entry (built by push), and dv is only tested for truthiness
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
    // the first of key / setKey the catalog has (catalog entries are objects, so `??` = first hit)
    const c = (i.key ? catKeys.get(i.key) : undefined) ?? (i.setKey ? catKeys.get(i.setKey) : undefined);
    const r = byName.get(i.name);
    // A name match is component-match's nameVerdict — the one rule cross-check uses too. A tie
    // between different signatures, or several same-named entries none of which agrees, is `ambiguous`:
    // never a match, but the candidates are listed so the builder sees why and what to choose from.
    const verdict = !c && r ? nameVerdict(r).status : null;
    if (c) match = { by: "key", ...ifDefined("id", c.id), ...ifDefined("key", c.key), name: c.name };
    else if (r && r.match && verdict === "matched") {
      match = { by: r.evidence || "name+signature", ...ifDefined("id", r.match.id), ...ifDefined("key", r.match.key), name: r.match.name, confirmed: false };
    } else if (r && verdict === "ambiguous") match = { by: "ambiguous", candidates: r.candidates || [] };
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
  /** skeleton-owned, refreshed on merge, not in counts */
  anchorsSuggested: AnchorSuggestion[];
  tokens: SkeletonTokenRow[]; components: PlanComponentRow[]; anchors: Record<string, PlanAnchor>; hidden: PlanHiddenRoot[];
  counts: NonNullable<Plan["counts"]>;
  /** the skeleton writes every auditGate field (a person edits them later) */
  auditGate: Required<PlanAuditGate> | null;
}

// The boundaries a builder should name, so 12-291 anchor slots need not be filled one by one. Tree order.
// The screen frame comes first (it has no ancestor to cover it; a frame that is an INSTANCE is the whole
// suggestion, its internals belong to the component). Each suggestion covers its subtree: a root section, an outermost instance (its internals belong to the component),
// or a list — a `.map()`: a container whose most frequent child shape occurs >= 3 times, when those rows are the
// MAJORITY of its SHAPED visible children (a row variant that keeps the rows' layer name — a "Table row" with a badge where
// the others have none — counts as a row). Found by sibling signature, not by code structure. A childless leaf (a
// TEXT, a vector, a rectangle) has no shape to repeat — a title + description + note is no list — and three fields
// among six children are a form, not a list. Leaves do not vote (a title above the rows, a LINE divider), and a
// shaped child sitting between two rows (a divider instance) is their separator: it rides along with the repeat
// and does not vote either. A list's other children (a search bar above the rows) are still
// visited and suggested by the same rules.
const REPEAT_MIN = 3;
function suggestAnchors(doc: ScreenDoc | null | undefined, vis: Visibility): AnchorSuggestion[] {
  const out: AnchorSuggestion[] = [];
  const kids = (n: IrNode): IrNode[] => (n.children || []).filter((c) => !!c.id && vis.visible.has(c.id));
  const size = (n: IrNode): number => 1 + kids(n).reduce((a, c) => a + size(c), 0);
  const sig = (n: IrNode): string | null => {
    if (n.type === "INSTANCE") { const mc = n.mainComponent; return "I:" + ((mc && (mc.setKey || mc.key || mc.setName || mc.name)) || n.name); }
    const k = kids(n);
    return k.length ? n.type + ":" + k.map((c) => c.type).join(",") : null; // a childless leaf: no shape
  };
  // a list's rows (the most frequent shape, >= REPEAT_MIN, plus same-named variants of it) when they are the majority
  const listRows = (n: IrNode): Set<IrNode> | null => {
    const all = kids(n);
    const seen = new Map<string, IrNode[]>();
    for (const c of all) { const g = sig(c); if (g !== null) getOrInit(seen, g, () => []).push(c); }
    let best: IrNode[] | null = null, bestSig: string | null = null;
    for (const [g, l] of seen) if (l.length >= REPEAT_MIN && (!best || l.length > best.length)) { best = l; bestSig = g; }
    if (!best) return null;
    const names = new Set(best.map((c) => c.type + ":" + c.name));
    const rows = all.filter((c) => { const g = sig(c); return g !== null && (g === bestSig || names.has(c.type + ":" + c.name)); });
    // childless leaves (a title, a LINE divider) have no shape, so they do not vote; shaped children between rows are
    // the rows' separators (divider instances) only when they share ONE shape and fill every gap — a form's mixed
    // fields between its text fields are not separators
    const rowSet = new Set(rows);
    const isRow = (c: IrNode | undefined): boolean => c !== undefined && rowSet.has(c);
    const between = all.filter((c, i) => !rowSet.has(c) && sig(c) !== null && isRow(all[i - 1]) && isRow(all[i + 1]));
    const sepSigs = new Set(between.map(sig));
    // …and nothing of that shape sits outside the gaps ([Q, A, Q, A, Q, A] is pairs, not rows with separators)
    const seps = between.length === rows.length - 1 && sepSigs.size === 1 && !all.some((c) => !between.includes(c) && sepSigs.has(sig(c))) ? between : [];
    const shaped = all.filter((c) => sig(c) !== null).length - seps.length;
    return rows.length * 2 > shaped ? new Set([...rows, ...seps]) : null;
  };
  const visit = (n: IrNode, section: boolean): void => {
    const instance = n.type === "INSTANCE";
    const rows = instance ? null : listRows(n);
    const why = section ? "section" : instance ? "instance" : rows ? "repeat" : null;
    if (why) out.push({ id: n.id, name: n.name, why, covers: size(n) });
    if (instance) return;
    for (const c of kids(n)) if (!rows || !rows.has(c)) visit(c, false);
  };
  for (const r of screenRoots(doc)) {
    if (!r.id || !vis.visible.has(r.id)) continue; // a hidden frame is never built
    out.push({ id: r.id, name: r.name, why: "screen", covers: size(r) });
    if (r.type === "INSTANCE") continue; // the frame is a template instance: its internals belong to the component
    for (const c of kids(r)) visit(c, true);
  }
  return out;
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
  // Pre-fill a first-class auditGate from an existing audit with blockers, so the model
  // (or a person) has somewhere to record "acknowledged and overridden, here is why" instead of the
  // build silently proceeding past a Blocked verdict. overridden/reason/decidedBy/decidedAt are left
  // for a person to fill; a re-run of this script never clears what was already decided (see merge()).
  // Blockers are the audit's finding ids (`code` / `code@nodeId`), and crossCheckFile points at the
  // cross-check report beside it (`<audit stem>.cross.json`, where cross-file findings carry the same ids).
  let auditGate: Required<PlanAuditGate> | null = null;
  try {
    const base = cwd || process.cwd();
    const g = auditGateStatus(base, screenFile, screenName);
    if (g.auditFile && g.blockers.length) {
      const cross = g.auditFile.replace(/\.json$/, ".cross.json");
      const crossCheckFile = cross !== g.auditFile && fs.existsSync(path.join(base, cross)) ? cross : null;
      auditGate = { auditFile: g.auditFile, crossCheckFile, verdict: "blocked", blockers: g.blockers, overridden: [], reason: null, decidedBy: null, decidedAt: null };
    }
  } catch { /* the auditGate pre-fill is best-effort: plan-skeleton must never fail on reading an audit */ }
  // (audit-gate.ts is a static import, which cannot fail at this point. The try/catch is around the CALL:
  // a malformed audit file must not fail the skeleton.)
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
    anchorsSuggested: suggestAnchors(doc, vis),
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
const FILLED_TOKEN = ["codeToken", "verdict", "decision", "acknowledged", "seededFrom"] as const;
const FILLED_COMPONENT = ["mapModule", "verdict", "decision", "matchedByName", "seededFrom"] as const;

// The skeleton owns what it READ — auditFile, crossCheckFile, blockers (the audit's current ids) — and a
// person owns the decision: overridden / reason / decidedBy / decidedAt / verdict are never touched. (Keeping
// the whole old gate would freeze its blockers at the ids of the first run.) With no fresh gate (no audit
// file now, or no blockers left in it) the old one stays as it was: a decision is never cleared.
function mergeAuditGate(prev: PlanAuditGate | null | undefined, fresh: Required<PlanAuditGate> | null): PlanAuditGate | null {
  if (!prev || typeof prev !== "object") return fresh;
  if (!fresh) return prev;
  return { ...prev, auditFile: fresh.auditFile, crossCheckFile: fresh.crossCheckFile, blockers: fresh.blockers };
}
function merge(fresh: SkeletonPlan, prev: Plan | null | undefined): MergeResult {
  if (!prev || typeof prev !== "object") return { plan: fresh, dropped: { tokens: 0, components: 0, anchors: 0 } };
  const out: Plan = Object.assign({}, prev, {
    anchorsSuggested: fresh.anchorsSuggested, // skeleton-owned: refreshed, like hidden[]
    schema: fresh.schema,
    screenName: prev.screenName || fresh.screenName,
    nodeId: fresh.nodeId,
    route: prev.route || fresh.route,
    file: fresh.file,
    exportedAt: fresh.exportedAt,
    hidden: fresh.hidden,
    auditGate: mergeAuditGate(prev.auditGate, fresh.auditGate),
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
    const p = c.nodeId ? prevComp.get(c.nodeId) : undefined; // prevComp has no falsy-id keys
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

// ---------------------------------------------------------------- --seed-from

/** What seed() copied from one sibling plan. */
export interface SeedCount { tokens: number; components: number }

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "";
const SEED_TOKEN = ["codeToken", "verdict", "decision"] as const;
const SEED_COMPONENT = ["mapModule", "verdict", "decision"] as const;

// Fill what is still EMPTY in `plan` from a sibling screen's plan, in place. Only the same thing is seeded:
//   * a token row with the same key — or, when both rows are keyless, the same Figma name — AND the same
//     value (JSON-equal): a same-named token with a different value is exactly the trap a mapping must not
//     carry over. A row the skeleton marked hidden-only needs no code token and is left alone, and so is a
//     sibling row that is hidden-only there;
//   * a component row with the same setKey, else the same key.
// A field already filled (by the skeleton, the merge, or an earlier --seed-from) is never overwritten. A
// row that took anything is marked `seededFrom: <seed basename>` (the decision was made on another screen —
// review it); seeded rows then count as filled like any other answer, so a re-run keeps them.
function seed(plan: Plan, from: Plan, label: string): SeedCount {
  const n: SeedCount = { tokens: 0, components: 0 };
  const sameValue = (a: PlanTokenRow, b: PlanTokenRow): boolean => JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null);
  const sameToken = (a: PlanTokenRow, b: PlanTokenRow): boolean =>
    (a.key ? a.key === b.key : !b.key && !!a.figmaName && a.figmaName === b.figmaName) && sameValue(a, b);
  const answered = <R extends object, K extends keyof R>(r: R, fields: readonly K[]): boolean => fields.some((f) => !isEmpty(r[f]));
  for (const row of plan.tokens || []) {
    if (row.seededFrom || row.verdict === "hidden-only" || !SEED_TOKEN.some((f) => isEmpty(row[f]))) continue;
    const src = (from.tokens || []).find((t) => t.verdict !== "hidden-only" && sameToken(row, t) && answered(t, SEED_TOKEN));
    if (!src) continue;
    let took = false;
    for (const f of SEED_TOKEN) if (isEmpty(row[f]) && !isEmpty(src[f])) { Object.assign(row, { [f]: src[f] }); took = true; }
    if (took) { row.seededFrom = label; n.tokens++; }
  }
  const sameComponent = (a: PlanComponentRow, b: PlanComponentRow): boolean => a.setKey ? a.setKey === b.setKey : !!a.key && a.key === b.key;
  for (const row of plan.components || []) {
    if (row.seededFrom || !SEED_COMPONENT.some((f) => isEmpty(row[f]))) continue;
    const src = (from.components || []).find((c) => sameComponent(row, c) && answered(c, SEED_COMPONENT));
    if (!src) continue;
    let took = false;
    for (const f of SEED_COMPONENT) if (isEmpty(row[f]) && !isEmpty(src[f])) { Object.assign(row, { [f]: src[f] }); took = true; }
    if (took) { row.seededFrom = label; n.components++; }
  }
  return n;
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
  const OPTIONS = { out: { type: "string" }, map: { type: "string" }, route: { type: "string" }, "seed-from": { type: "string", multiple: true }, help: { type: "boolean", short: "h" } } as const;
  const { values: flags, positionals } = cliParse("plan-skeleton", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; }
  const { out, map: mapFlag, route } = flags;
  const seedFiles = flags["seed-from"] || [];
  const [screenFile, varsFile, dsDir] = positionals;
  // (three positionals means all three are set; the undefined tests only let the type see it)
  if (positionals.length !== 3 || screenFile === undefined || varsFile === undefined || dsDir === undefined || [out, mapFlag, route, ...seedFiles].some((v) => v === "")) { console.error(USAGE); return 2; }
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
  const { TOKENS, COMPONENTS_LOCAL, COMPONENTS_LIBRARY } = DESIGN_SYSTEM_FILES;
  const dsRead = optional(TOKENS, isTokensDoc), catRead = optional(COMPONENTS_LOCAL, isComponentsCatalog), libRead = optional(COMPONENTS_LIBRARY, isComponentsCatalog);
  if ("error" in dsRead) return cannotRead("the design system's tokens", path.join(dsDir, TOKENS), dsRead.error);
  if ("error" in catRead) return cannotRead("the component catalog", path.join(dsDir, COMPONENTS_LOCAL), catRead.error);
  if ("error" in libRead) return cannotRead("the library component catalog", path.join(dsDir, COMPONENTS_LIBRARY), libRead.error);
  const mapAt = findMapFile(process.cwd());
  const mapFile = mapFlag || (mapAt.missing ? undefined : mapAt.rel);
  let mapKeys = new Map<string, MapKeyEntry>();
  if (mapFile) {
    const m = readJson(mapFile, isCodeConnectMap);
    if (!("doc" in m)) return cannotRead("the component map", mapFile, m.error);
    mapKeys = mapKeysOf(m.doc);
  }
  // Every seed is read up front: one that cannot be read (or is not a plan) refuses the run before anything is written.
  const seeds: Array<{ file: string; plan: Plan }> = [];
  for (const f of seedFiles) {
    const r = readJson(f, anyJson);
    const parsed = "doc" in r ? parsePlan(r.doc) : null;
    if (!parsed || "error" in parsed) return cannotRead("the --seed-from plan", f, !("doc" in r) ? r.error : parsed && "error" in parsed ? parsed.error : "is not a plan");
    seeds.push({ file: f, plan: parsed.plan });
  }
  const seedAll = (plan: Plan): void => {
    for (const sd of seeds) {
      const n = seed(plan, sd.plan, path.basename(sd.file));
      console.error(`plan-skeleton: seeded ${n.tokens} token row(s), ${n.components} component row(s) from ${sd.file}` + (n.tokens || n.components ? " — review them (seededFrom)" : ""));
    }
  };
  const nodeId = screenExportOf(doc)?.nodeId || screenRoots(doc)[0]?.id;
  const fresh = skeleton({ doc, vars, ds: dsRead.doc, catalog: catRead.doc, library: libRead.doc, mapKeys, screenFile, cwd: process.cwd(), ...ifDefined("route", route), indexRow: findIndexRow(screenFile, nodeId) });
  const c = fresh.counts;
  if (!out) {
    seedAll(fresh);
    process.stdout.write(JSON.stringify(fresh, null, 2) + "\n");
  } else {
    // An existing plan is MERGED into — so one that cannot be read (or is not a plan) is refused, untouched.
    const prevRead = readJson(out, anyJson);
    const parsed = "doc" in prevRead ? parsePlan(prevRead.doc) : null; // parsePlan names the field that is wrong
    const why = !("doc" in prevRead) ? (prevRead.missing ? null : prevRead.error) : parsed && "error" in parsed ? parsed.error : null;
    if (why) { console.error(`plan-skeleton: ${out} exists but ${why} — refusing to overwrite it`); return 1; }
    const prev = parsed && "plan" in parsed ? parsed.plan : null;
    const { plan, dropped } = merge(fresh, prev);
    seedAll(plan); // after the own-plan merge: this plan's own answers always win
    // the one plan writer (plan-record.ts): atomic, so a kill mid-write cannot truncate a hand-answered plan, and in
    // the file's own format (indent, CRLF, BOM), so a merge is not a whole-file diff. It skips identical bytes, so an
    // unchanged plan is touched: verify-build treats a plan untouched for 12 h as a leftover and skips it.
    if (!writePlan(out, plan)) { const now = new Date(); fs.utimesSync(out, now, now); }
    console.error(`plan-skeleton: ${prev ? "merged into" : "wrote"} ${out}` + (prev ? ` (kept every filled field; dropped ${dropped.tokens} token row(s), ${dropped.components} component row(s), ${dropped.anchors} anchor(s) no longer in the export)` : ""));
  }
  console.error(`plan-skeleton: ${c.tokens} bound token(s) (${c.tokensVisible} on visible nodes), ${c.instances} visible instance(s), ${c.anchors} visible node anchor slot(s), ${c.hiddenNodes} hidden node(s) excluded, ${fresh.anchorsSuggested.length} suggested anchor root(s) (anchorsSuggested)`);
  return 0;
}

export { skeleton, merge, seed, visibility, walkNodes, bindingsOf, buildTokens, buildComponents, USAGE };

// exitCode, not exit(): exit() would cut a large plan off mid-write when stdout is a pipe.
if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
