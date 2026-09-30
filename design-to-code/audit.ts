// audit.ts — pre-implementation review of a Figma export: the checks a senior frontend/mobile
// engineer runs BEFORE writing code, computed deterministically so the agent doesn't do contrast
// math or walk 5,000 nodes by eye.
//
// It reports what the export can PROVE (unbound values, off-grid spacing, small touch targets, low
// contrast, fixed-height text, drawn system chrome, missing component states, risky effects for the
// target platform) and lists what it CANNOT know (loading/empty/error screens that were never drawn),
// so the skill can turn those into designer questions. It never fails a build: findings are advice.
//
// Inputs are the plugin's own shapes, read as-is:
//   screen doc   design/<screen>.json            { exportedAt, screen, nodes:[tree], manifest }
//   layer file   design/pages/<dir>/<layer>.json  a bare node tree (or { tree })
//   catalog      design/design-system/components.local.json  { components:[{type,name,props}] }
//                (a --as-library export's libraries/<dir>/components.json is the same shape)
//   assets       design/pages/<dir>/<layer>.assets.json  { heavy:[{file,bytes,paths}], files:[{file,node}] }
// Returns ONE object, whose full shape is (this is also what --out writes to <out>.json, and the
// only schema for it — live run #11 hit an agent guessing at the top level because the prose cited
// fields like `exportedAt`/`manifest`/`screen`, which belong to the INPUT export and are not
// re-exposed here):
//   platform          "web"|"ios"|"android"|"react-native"|"flutter" — what the findings assume
//   platformAssumed   true when no platform was given and "web" was guessed
//   grid              the spacing step the off-grid check used (px)
//   screenStatesScope { rootsAudited, singleFrame } — how much was looked at, so "not-found" below
//                     can be read correctly ("not in this frame" vs "nowhere")
//   screens           [label] — one per audited root, from the input's label/filename
//   summary           { blockers, warnings, info } — counts by severity
//   hiddenLayers      { nodesSkipped, crossFileFindingsOmitted } — layers switched off in Figma
//                     (`hidden: true` on the node or an ancestor): no finding cites one
//   tokenBinding      { color|typography|spacing|radius|effects: { bound, total, pct|null } }
//   components        [{ name, kind, known, present[], missing[], note?, sampled?, catalog?, matchedBy? }]
//   screenStates      { loading, empty, error, validation? }: "designed"|"not-found"|"not-applicable"
//                     (validation only when an input was audited; empty is not-applicable for a dialog)
//   annotations       [{ nodeId, nodeName, label }] — what the designer wrote in the file
//   questions         [string] — plain prose, one decision the export cannot answer per entry
//   findings          [{ severity, code, message, nodeId?, nodeName?, screen?, path?, ...extra }]
//                     where `extra` is per-code (e.g. { component, missing } on
//                     missing-component-states, { category } on low-token-binding)
// There is no `exportedAt`/`manifest`/`screen` at this level; those stay on the export document.

import fs from "node:fs";
import path from "node:path";
import { isHidden, hiddenSelf } from "./hidden.ts";
import { parseHex, contrastRatio, compositeOver } from "./color.ts";
import { isLayerFile, isScreenDoc, isScreenExport, screenRoots } from "./export-shape.ts";
import type { Rgba } from "./color.ts";
import { crossCheck } from "./cross-check.ts";
import { readDocFile, readSplitFile } from "./catalog-input.ts";
import { findLibraryExports, readDesignSystemDir } from "./design-system-dir.ts";
import type { LibraryExport } from "./design-system-dir.ts";
import { isComponentsCatalog, isScreenAssetsDoc } from "./doc-guards.ts";
import { readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { variablesContext } from "./slice-sources.ts";
import type { SliceSources } from "./slice-sources.ts";
import { isJsonObject } from "./types.ts";
import type {
  AuditAnnotation, AuditCategory, AuditComponentRow, AuditFinding, AuditFindingCode, AuditPlatform, AuditReport, Box, CatalogComponent, ComponentsCatalog,
  AuditCrossFile, AuditScreenStates, ControlKind, ControlState, FindingExtras, FontSpec, IrNode, MainComponentRef, Manifest, Paint, ScreenAssetsDoc, ScreenDoc,
  ScreenStateKey, ScreenStateValue, Severity, TextStylesDoc, TokenMap, TokensDoc, Variable,
} from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, warning: 1, info: 2 };


// Minimum hit-area per platform. web = WCAG 2.5.8 AA (24 CSS px); 44 is the recommended AAA target.
const TOUCH_MIN: Record<AuditPlatform, number> = { web: 24, ios: 44, android: 48, "react-native": 44, flutter: 48 };
const PLATFORMS = Object.keys(TOUCH_MIN);
const AUDIT_CATEGORIES: readonly AuditCategory[] = ["color", "typography", "spacing", "radius", "effects"];
const isPlatform = (p: unknown): p is AuditPlatform => typeof p === "string" && PLATFORMS.includes(p);

// ---------------------------------------------------------------- color math (WCAG 2.2)
type Lab = [number, number, number];
// Source-over compositing lives in color.ts (`compositeOver`) since 350deb2; `over` is the local name.
const over = compositeOver;
// CIE76 ΔE in Lab — a coarse "these two raw colors are probably meant to be one token" signal.
function toLab(c: Rgba): Lab {
  const lin = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(c.r), G = lin(c.g), B = lin(c.b);
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labDist = (p: Lab, q: Lab): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const deltaE = (a: Rgba, b: Rgba): number => labDist(toLab(a), toLab(b));

// ---------------------------------------------------------------- vocab
const INTERACTIVE_NAME = /\b(button|btn|cta|link|tab|chip|toggle|switch|checkbox|check box|radio|input|text ?field|textfield|search|select|dropdown|menu item|icon ?button|close|back|segmented|stepper|slider)\b/i;
const TAP_TRIGGER = /click|press|tap|drag/;
const CHROME_TOP = /status ?bar|9:41|battery|signal|dynamic island|notch/i;
const CHROME_BOTTOM = /home ?indicator|gesture ?bar|navigation ?handle/i;
const STATE_KEYS = ["loading", "empty", "error"] as const;
const STATE_WORDS: Record<ScreenStateKey, RegExp> = {
  loading: /\b(loading|skeleton|spinner|shimmer|placeholder)\b/i,
  // F-23: an empty state is usually a SENTENCE ("No items added yet.", "Add your first project"), not a
  // layer called "Empty" — `no … yet/added/created/found/available` within one clause (a non-breaking
  // space counts: `\s`/`[^…]` both match U+00A0, which designers' copy often carries).
  empty: /\b(empty|no results?|no data|nothing (here|found|to show|yet)|zero ?state|(add|create) your first)\b|\bno\b[^.!?\n]{0,40}?\b(yet|added|created|found|available)\b/i,
  error: /\b(error|failed|failure|offline|retry|something went wrong|not found|404|500)\b/i,
};
// Form-validation copy (DT-14(4)): evidence that a validation state was drawn for a screen with inputs.
const VALIDATION_WORDS = /\b((is|are) required|required field|invalid|is not valid|must (be|contain|include|match)|please (enter|select|provide|fill)|too (short|long)|already (exists|taken|in use))\b/i;
// A root that is a dialog, not a page: it has no data LIST, so "what shows when there's no data" does not
// apply, and "loading" means its action in flight (DT-14(4)). Read off the root's layer name.
// "sheet"/"drawer"/"confirmation" alone are too common in page names ("Time Sheet", "Order confirmation").
const DIALOG_NAME = /\b(dialog|modal|pop-?ups?|popover|bottom ?sheet|action ?sheet|side ?drawer)s?\b/i;
// A text finding cites the layer's own words beside its name — the name is often a component default
// ("Option 1") while the text is what a reader can find on screen (DT-14(2), F-25).
function textOf(node: IrNode): string | null {
  const t = typeof node.text === "string" ? node.text.replace(/\s+/g, " ").trim() : "";
  if (!t || t === (node.name || "").trim()) return null;
  return t.length > 40 ? t.slice(0, 39) + "…" : t;
}
// An icon's paint, not a surface: an asset leaf (figma-plugin/src/assets.ts) that is a path (VECTOR,
// BOOLEAN_OPERATION, LINE) or a flattened icon container (FRAME/INSTANCE/GROUP/COMPONENT), with no
// image/gradient fill. RECTANGLE/ELLIPSE/STAR/POLYGON leaves are shapes and can sit under text.
const INK_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "LINE", "FRAME", "INSTANCE", "GROUP", "COMPONENT"]);
function isIconInk(n: IrNode): boolean {
  if (!(n.asset || n.geometry || n.assetSkipped) || !INK_TYPES.has(String(n.type))) return false;
  return !(Array.isArray(n.fills) && n.fills.some((f) => f.type === "image" || f.type === "gradient"));
}
// Whether two page-space boxes intersect. Unknown when either lacks x/y (a flow child's box is only w/h —
// serialize.ts writes x/y only where the parent does not lay the child out): then assume they do, which
// is what the walk did before it read positions.
function overlaps(a: Box | undefined, b: Box | undefined): boolean {
  if (!a || !b || typeof a.x !== "number" || typeof a.y !== "number" || typeof b.x !== "number" || typeof b.y !== "number") return true;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
const CONTROL_WORD = /\b(button|btn|checkbox|check box|radio|switch|toggle|input|text ?field|textfield|textarea)\b/i;
const cite = (node: IrNode): string => { const t = textOf(node); return `'${node.name}'${t ? ` ("${t}")` : ""}`; };
const textExtra = (node: IrNode): { text?: string } => ifDefined("text", textOf(node) ?? undefined);
// State synonyms, matched against VARIANT option values and BOOLEAN prop names (real files name the
// property "Property 1" and put the state in the value, so the value is what carries the meaning).
const CONTROL_STATES = ["hover", "pressed", "focus", "disabled", "error", "selected", "loading"] as const;
const STATE_SYNONYMS: Record<ControlState, RegExp> = {
  hover: /^(hover|hovered|mouse ?over)$/,
  pressed: /^(pressed|press|active|tapped|down)$/,
  focus: /^(focus|focused|focus[- ]visible|keyboard ?focus)$/,
  disabled: /^(disabled|inactive|is ?disabled)$/,
  // Not "danger"/"destructive": those are button STYLE variants (a red button), not an error state.
  error: /^(error|invalid|has ?error|is ?invalid)$/,
  selected: /^(selected|checked|on|active|current|is ?selected)$/,
  loading: /^(loading|busy|in ?progress|is ?loading)$/,
};
// Which states each kind of control needs. `hover` only matters where there is a pointer.
function requiredStates(kind: ControlKind, platform: AuditPlatform): ControlState[] {
  const pointer = platform === "web";
  switch (kind) {
    case "button": return pointer ? ["hover", "pressed", "focus", "disabled"] : ["pressed", "disabled"];
    case "input": return ["focus", "error", "disabled"];
    case "toggle": return ["selected", "disabled"];
    case "tab": return ["selected"];
    case "link": return pointer ? ["hover", "focus"] : ["pressed"];
    default: return [];
  }
}
function controlKind(name: unknown): ControlKind | null {
  const s = String(name || "");
  if (/\b(input|text ?field|textfield|search|select|dropdown|textarea)\b/i.test(s)) return "input";
  if (/\b(checkbox|check box|radio|switch|toggle)\b/i.test(s)) return "toggle";
  if (/\b(tab|tabs|segmented|nav ?item|navigation item)\b/i.test(s)) return "tab";
  if (/\blink\b/i.test(s)) return "link";
  if (/\b(button|btn|cta|icon ?button|chip)\b/i.test(s)) return "button";
  return null;
}

// ---------------------------------------------------------------- input normalisation
/** One audited root and the label its findings cite. */
interface Root { tree: IrNode; label: string; manifest?: Manifest }

// Every document shape the export writes (export-shape.ts screenRoots: a screen doc ({nodes}), a layer
// file ({tree}) or a bare node tree). Each root keeps a label so findings say which screen they're in:
// the export's `screen`, else the root's own name, else the caller's label.
function labelledRoots(doc: unknown, label: string): Root[] {
  const exp = isScreenExport(doc) ? doc : null;
  const manifest = exp ? exp.manifest : isLayerFile(doc) ? doc.manifest : undefined;
  return screenRoots(doc).map((tree) => ({ tree, label: (exp && exp.screen) || tree.name || label, ...ifDefined("manifest", manifest) }));
}

const r1 = (v: number): number => Math.round(v * 100) / 100;
const hasTok = (node: IrNode, ...keys: string[]): boolean => {
  const t = node.tokens;
  return !!(t && keys.some((k) => t[k] != null));
};

/**
 * One audit input: a screen document, optionally wrapped as `{ doc, label, vars }` (the wrapper's
 * `label` names the screen in findings; `vars` is its own <Screen>.vars.json slice for the cross-file
 * pass). An unwrapped document is read as itself, exactly as the JS did (`d.doc !== undefined ? d.doc : d`).
 */
export interface AuditInput { doc?: ScreenDoc | null; label?: string; vars?: TokensDoc | null; assets?: ScreenAssetsDoc | null }
/** One argument of audit(): a wrapped input, or a screen document on its own. */
export type AuditArg = AuditInput | ScreenDoc;
// A bare document is its own `doc`; a wrapper is read field by field.
const unwrap = (d: AuditArg | null | undefined, i: number): { doc: ScreenDoc | null; label: string; vars: TokensDoc | null; assets: ScreenAssetsDoc | null } =>
  !d || isScreenDoc(d) ? { doc: d || null, label: `input${i}`, vars: null, assets: null } : { doc: d.doc || null, label: d.label || `input${i}`, vars: d.vars || null, assets: d.assets || null };
/** The design-system split files audit() joins the screen against (all optional). */
export interface AuditDesignSystem { tokens?: TokensDoc | null; components?: ComponentsCatalog | null; componentsLibrary?: ComponentsCatalog | null; stylesText?: TextStylesDoc | null }
export interface AuditOptions {
  platform?: string;
  grid?: number;
  catalog?: ComponentsCatalog | null;
  designSystem?: AuditDesignSystem;
  /** where `designSystem` was read from, as the user passed it (named in the library hint) */
  designSystemDir?: string;
  /** the --as-library exports beside the export (design-system-dir.ts findLibraryExports) */
  libraries?: LibraryExport[];
  variables?: TokensDoc | null;
  sliceSources?: SliceSources | null;
}

// What the walk carries about an ancestor: only what descendants read off it.
interface Ancestor { name: string; hidden?: boolean; fills?: Paint[]; __tappable: boolean; __beneath: Paint[] }
// An earlier sibling that may paint under a later one: its fills, and its page-space box when known.
interface Layer { fills: Paint[]; box?: Box }
interface WalkCtx { label: string; rootBox?: Box }
interface Here { label: string; path?: string }
// `icon`: the instance exported as an asset (an SVG icon) — "search-normal" names an icon, not a search field.
interface UsedComponent { name: string | undefined; key?: string; variantKey?: string; remote?: boolean; nodeId?: string; icon?: true }
interface StateHit { nodeId: string; nodeName: string; screen: string; hidden: boolean }
// A text run as the binding tally reads it: a real `runs[]` entry, or the node's own font/tokens/style.
interface RunLike { font?: FontSpec; tokens?: TokenMap; textStyle?: string; fillStyle?: string }

// F-16: the spacing step a design system's own tokens use — the gcd of every positive numeric value of a
// FLOAT variable in a spacing collection or scoped to GAP. The real tokens.json shape is a flat
// `variables[]` whose rows name their `collection` and carry `values: { <mode>: number | {aliasOf} }`
// (aliases add no new value — they point at another row, which is counted itself). The old reader
// looked for `collections[].variables`, a shape no export has, so the step was never found. Null when
// fewer than two values, or when the gcd is below 2 (a 1px "grid" says nothing).
function spacingStep(tokens: TokensDoc | null | undefined): number | null {
  const values: number[] = [];
  const isSpacing = (v: Variable): boolean => v.type === "FLOAT" && (/spac/i.test(v.collection || "") || (Array.isArray(v.scopes) && v.scopes.includes("GAP")));
  for (const v of (tokens && tokens.variables) || []) {
    if (!isSpacing(v)) continue;
    for (const mv of Object.values(v.values)) if (typeof mv === "number" && Number.isFinite(mv) && Math.round(Math.abs(mv)) > 0) values.push(Math.round(Math.abs(mv)));
  }
  if (values.length < 2) return null;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const step = values.reduce((a, b) => gcd(a, b));
  return step >= 2 ? step : null;
}

// ---------------------------------------------------------------- the audit
function audit(input: AuditArg | Array<AuditArg | null | undefined> | null | undefined, opts: AuditOptions = {}): AuditReport {
  // Live run #10: with no --platform the audit quietly picked "web" and the assumption surfaced only
  // as one designer question buried in a list of thirteen. Every touch-target size, shadow-spread
  // note and blur warning below depends on this value, so a wrong guess silently mis-audits the
  // whole screen. The guess still happens (refusing to run is worse), but it is now recorded as a
  // guess and printed at the TOP of the report rather than left for the reader to notice.
  const givenPlatform = opts.platform;
  const platformAssumed = !isPlatform(givenPlatform);
  const platform: AuditPlatform = isPlatform(givenPlatform) ? givenPlatform : "web";
  const gridAssumed = !(opts.grid !== undefined && opts.grid > 0);
  const grid: number = gridAssumed || opts.grid === undefined ? 4 : opts.grid;
  // P4 #43: the 4px default silently under-flags an 8px-grid system (77 → 124 off-grid violations on
  // the live run) and nothing said the run used the weaker default. When the design system's own
  // tokens have a spacing scale whose step differs from the grid used, say so and name the real step —
  // never raise the default itself (a different wrong default is not an improvement; the fix is to
  // PASS the real one). F-16: a GIVEN grid is checked too — the agent passed a frame's 8px layoutGrid
  // (column guides, not a spacing scale) for a 4-step system and got 61 false off-grid notes.
  const dsStep = spacingStep(opts.designSystem && opts.designSystem.tokens);
  const gridMismatch: number | null = dsStep !== null && dsStep !== grid ? dsStep : null;
  const docs = (Array.isArray(input) ? input : [input]).map(unwrap);
  const roots = docs.flatMap((d) => labelledRoots(d.doc, d.label));
  const catalog: CatalogComponent[] = (opts.catalog && Array.isArray(opts.catalog.components)) ? opts.catalog.components : [];

  const findings: AuditFinding[] = [];
  // typed on its own: spread inline in the Object.assign below, oxlint-tsgolint reads the result as `any`
  const placeOf = (ctx: Here): Pick<AuditFinding, "screen" | "path"> => ({ screen: ctx.label, ...ifDefined("path", ctx.path) });
  const add = (severity: Severity, code: AuditFindingCode, message: string, node: IrNode | null, ctx: Here | null, extra?: FindingExtras): number => findings.push(Object.assign(
    { severity, code, message },
    node ? { nodeId: node.id, nodeName: node.name } : {},
    ctx ? placeOf(ctx) : {},
    extra || {}
  ));

  const binding: Record<AuditCategory, [number, number]> = { color: [0, 0], typography: [0, 0], spacing: [0, 0], radius: [0, 0], effects: [0, 0] };
  const tally = (cat: AuditCategory, bound: boolean): void => { binding[cat][1]++; if (bound) binding[cat][0]++; };
  const rawColors = new Map<string, { count: number; nodeId: string; nodeName: string; rgb: Rgba }>(); // hex -> { count, sample node, channels }
  const usedComponents = new Map<string, UsedComponent>(); // setKey|key|name -> { name, kind }
  const stateHits: Record<ScreenStateKey, StateHit[]> = { loading: [], empty: [], error: [] };
  const validationHits: StateHit[] = [];
  let inputsSeen = 0; // visible input controls — whether a validation state applies at all
  const annotations: AuditAnnotation[] = [];
  const hiddenIds = new Set<string>(); // every node skipped by the hidden predicate — cross-file findings are filtered by it too
  const nodesById = new Map<string, IrNode>(); // visible nodes, so a finding raised off-tree (a heavy asset) can cite one
  // Prototype links out of this screen, one row per destination (DT-14(5)): the export has them, and a
  // link copied along with a layer ("every row opens the Details screen") is invisible until clicked.
  const navigations = new Map<string, { destination: string | undefined; destinationId: string | undefined; navigation: string; count: number; node: IrNode; label: string }>();

  for (const root of roots) {
    const m: Partial<Manifest> = root.manifest || {};
    if (m.truncated) add("blocker", "export-truncated", `export of '${root.label}' was truncated (${m.truncated} subtree(s) past the depth limit) — the tree is incomplete; re-export a narrower scope before building`, null, { label: root.label });
    if (m.assetsFailed) add("blocker", "assets-failed", `${m.assetsFailed} asset export(s) failed in '${root.label}' — those nodes have no file (look for \`geometry\` fallbacks)`, null, { label: root.label });
    if (root.tree.devStatus && root.tree.devStatus !== "ready_for_dev" && root.tree.devStatus !== "completed") {
      add("warning", "not-ready-for-dev", `'${root.label}' dev status is '${String(root.tree.devStatus)}' — confirm the design is final before building`, root.tree, { label: root.label, path: root.tree.name });
    }
    walk(root.tree, [], { label: root.label, ...ifDefined("rootBox", root.tree.box) });
  }

  function walk(node: IrNode | null | undefined, ancestors: Ancestor[], ctx: WalkCtx): void {
    if (!node || typeof node !== "object") return;
    const path = [...ancestors.map((a) => a.name), node.name].join(" > ");
    const here: Here = { label: ctx.label, path };
    // hidden.ts's one predicate: the node or any ancestor carries `hidden: true`.
    const hiddenBranch = isHidden(node, ancestors.some((a) => hiddenSelf(a)));

    // Designer intent the agent must read, collected verbatim.
    if (Array.isArray(node.annotations)) for (const a of node.annotations) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, ...ifDefined("label", a.label || a.markdown) });
    if (node.devStatusNote) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: `dev note: ${node.devStatusNote}` });

    // Drawn states (a layer called "Loading" or a hidden "Error toast") — evidence the state was designed.
    // Text is read only near the top for loading/error (a "Failed" status chip deep in a table row is data,
    // not an error screen); an empty-state sentence is specific enough to count at any depth (F-23: the
    // real one sat 7 levels down, inside the illustration's card).
    for (const state of STATE_KEYS) {
      const re = STATE_WORDS[state];
      if (re.test(node.name || "") || (node.type === "TEXT" && (state === "empty" || ancestors.length <= 6) && re.test(node.text || ""))) {
        stateHits[state].push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
      }
    }
    // Validation evidence: error copy, or an input instance drawn in its error variant ("Status=Error").
    const variantValues = String((node.mainComponent && node.mainComponent.name) || "").split(",").map((p) => (p.split("=")[1] || "").trim().toLowerCase());
    if ((node.type === "TEXT" && VALIDATION_WORDS.test(node.text || "")) || VALIDATION_WORDS.test(node.name || "")
      || (controlKind((node.mainComponent && node.mainComponent.setName) || node.component) === "input" && variantValues.some((v) => STATE_SYNONYMS.error.test(v)))) {
      validationHits.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
    }

    // A layer the designer switched off renders nothing, so nothing about it is a finding: the audit
    // used to hand a builder "use paddingTop=2 EXACTLY" for a hidden selected-state icon (finding 74 —
    // 44 of Job Roles' 119 findings cited hidden nodes). It is still WALKED, only for the two
    // collections above: a hidden "Error toast" is evidence the error state was designed, and an
    // annotation is designer intent wherever it sits. Token-binding tallies, component usage and every
    // emitter below see visible layers only.
    if (hiddenBranch) {
      if (node.id) hiddenIds.add(node.id);
      const self: Ancestor = { name: node.name, hidden: true, fills: [], __tappable: false, __beneath: [] };
      for (const child of Array.isArray(node.children) ? node.children : []) walk(child, [...ancestors, self], ctx);
      return;
    }

    if (node.id) nodesById.set(node.id, node);
    // Component usage → state coverage later.
    if (node.mainComponent || node.component) {
      const mc: Partial<MainComponentRef> = node.mainComponent || {};
      const name = mc.setName || node.component;
      const key = mc.setKey || mc.key || name;
      // An icon exported as an asset ("search-normal") is not a control; an "Icon Button" asset still is.
      const icon = !!(node.asset || node.geometry || node.assetSkipped) && !CONTROL_WORD.test(String(name || ""));
      if (key && !usedComponents.has(key)) usedComponents.set(key, { name, ...ifDefined("key", mc.setKey || mc.key), ...ifDefined("variantKey", mc.key), remote: !!mc.remote, nodeId: node.id, ...(icon ? { icon: true as const } : {}) });
      // A search box or a filter on a list page has no validation state to ask about (M1 of the review).
      if (!icon && controlKind(name) === "input" && !/\b(search|filter)/i.test(String(name || ""))) inputsSeen++;
    }
    for (const r of Array.isArray(node.reactions) ? node.reactions : []) {
      for (const a of Array.isArray(r.actions) ? r.actions : []) {
        // A move to another screen/overlay. `change_to` is a variant swap (hover/pressed), `scroll_to` stays put.
        if (a.type !== "node" || !(a.destination || a.destinationId) || a.navigation === "change_to" || a.navigation === "scroll_to") continue;
        const nav = a.navigation || "navigate";
        const id = nav + "|" + (a.destinationId || a.destination); // two frames can share a name
        const row = navigations.get(id);
        if (row) row.count++;
        else navigations.set(id, { destination: a.destination, destinationId: a.destinationId, navigation: nav, count: 1, node, label: ctx.label });
      }
    }
    if (node.detachedFrom) add("warning", "detached-instance", `'${node.name}' is a detached component instance — map it back to the component unless the detach was deliberate`, node, here);
    if (node.missingFont) add("blocker", "missing-font", `'${node.name}' uses a font Figma couldn't load — the recorded family/weight may not match the render; confirm the font files and license`, node, here);
    if (node.layout && node.layout.mode === "absolute" && Array.isArray(node.children) && node.children.length > 1 && node.type !== "GROUP" && ancestors.length > 0) {
      add("info", "no-auto-layout", `'${node.name}' has no auto layout (${node.children.length} children placed by coordinates) — infer a flow layout and ask how it should resize`, node, here);
    }

    // finding 172 (round 2 correction): the export can state a box.h that its own layout.padding +
    // children's box.h cannot produce (the real case: header padding [16,32,16,32] with a 24-high
    // text child declares box.h=44, but 16+24+16=56 — content genuinely overflows a FIXED box).
    // First cut over-fired on ordinary auto-layout: a FIXED-height row (heightMode absent/"fixed")
    // whose children are simply SHORTER than the box (e.g. a 40-high sidebar row, padding [0,4,0,12],
    // a 24-high icon centred in it) is normal — content fitting inside a fixed box is not a
    // contradiction. The export's own sizing-mode field (figma-plugin/src/serialize.ts:
    // layoutSizingVertical -> node.heightMode, default "fixed", also "hug"/"fill") tells the two
    // cases apart: a FIXED/FILL box only contradicts itself when content OVERFLOWS it; a HUG box's
    // declared size is supposed to equal the content exactly, so any mismatch (over OR under) is a
    // contradiction (the table row 20173:142081 is heightMode:"hug", declares 48, computes 56).
    // DT-13/DT-17/F-14: only children that take part in the flow add height. A hidden child renders
    // nothing and takes no space (Figma skips it in auto layout), and an `absolute: true` child
    // (layoutPositioning ABSOLUTE) is placed over the flow, not in it — counting either made a hug row
    // with a hidden 24px child "compute 56, not 48" and a dialog with an absolute close icon "318, not 270".
    const flow = Array.isArray(node.children) ? node.children.filter((c) => c && !hiddenSelf(c) && !c.absolute) : [];
    if (node.layout && Array.isArray(node.layout.padding) && node.layout.padding.length === 4 && node.box && flow.length) {
      const [padTop, , padBottom] = node.layout.padding;
      const kids = flow.filter((c): c is IrNode & { box: Box } => !!(c.box && typeof c.box.h === "number"));
      // (length 4 above, so both pads are set; a missing one would have made expectedH NaN and reported nothing)
      if (kids.length === flow.length && padTop !== undefined && padBottom !== undefined) {
        const direction = node.layout.flexDirection || (node.layout.display === "flex" ? "row" : null);
        const gap = typeof node.layout.gap === "number" ? node.layout.gap : 0;
        let expectedH: number | null = null;
        if (direction === "row") expectedH = padTop + padBottom + Math.max(...kids.map((c) => c.box.h));
        else if (direction === "column") expectedH = padTop + padBottom + kids.reduce((s, c) => s + c.box.h, 0) + gap * (kids.length - 1);
        const heightMode = node.heightMode || "fixed"; // absent = FIXED (the emitter's own default)
        const delta = expectedH === null ? 0 : expectedH - node.box.h;
        const overflow = expectedH !== null && delta > 1; // content genuinely does not fit a fixed/fill box
        const hugMismatch = expectedH !== null && heightMode === "hug" && Math.abs(delta) > 1; // hug must equal content, either direction
        // `expectedH !== null` is implied by both overflow and hugMismatch; spelling it out narrows the type
        if (expectedH !== null && (overflow || hugMismatch)) {
          const how = direction === "row" ? "max child " + Math.max(...kids.map((c) => c.box.h)) : "children sum " + (expectedH - padTop - padBottom);
          const why = heightMode === "hug"
            ? `heightMode:"hug" means this box's height IS the content height, but its own padding + children compute ${expectedH}, not the declared ${node.box.h}`
            : `content (padding + children) computes ${expectedH}, which OVERFLOWS the declared box.h=${node.box.h} by ${delta}px`;
          add("warning", "self-inconsistent-geometry", `'${node.name}' declares box.h=${node.box.h} (heightMode:${JSON.stringify(heightMode)}) — ${why}: ${padTop}+${how}+${padBottom} = ${expectedH}. The export contradicts itself — decide which number to trust before building.`, node, here, { statedH: node.box.h, expectedH, heightMode });
        }
      }
    }

    // ---- system chrome drawn into a mobile frame (top-level-ish only)
    if (ancestors.length <= 2 && node.box && ctx.rootBox && platform !== "web") {
      const label = `${node.name || ""} ${node.component || ""} ${(node.mainComponent && node.mainComponent.setName) || ""}`;
      if (CHROME_TOP.test(label) && node.box.h <= 64) add("warning", "fake-status-bar", `'${node.name}' looks like a drawn status bar — don't build it; apply the system safe-area/status-bar inset instead`, node, here);
      else if (CHROME_BOTTOM.test(label) && node.box.h <= 40) add("warning", "fake-home-indicator", `'${node.name}' looks like a drawn home indicator/gesture bar — use the bottom safe-area inset instead`, node, here);
    }

    // ---- colors: fills, strokes, text
    const isAssetLeaf = !!(node.asset || node.geometry);
    // A TEXT node's `fills` ARE its glyph color — already counted via font.color below.
    if (!isAssetLeaf && node.type !== "TEXT" && Array.isArray(node.fills)) {
      for (const f of node.fills) {
        if (f.type === "solid") {
          const bound = !!(f.tokens || hasTok(node, "fills") || (node.styles && node.styles.fill));
          tally("color", bound);
          if (!bound) noteRaw(f.color, node);
        }
        if (f.type === "gradient" && /DIAMOND/.test(f.kind || "") && platform !== "flutter") add("info", "diamond-gradient", `'${node.name}' uses a diamond gradient — no native equivalent; use the exported asset or approximate`, node, here);
        if (f.type === "image" && (f.scaleMode === "crop" || f.scaleMode === "tile")) add("info", "image-scale-mode", `'${node.name}' image fill uses scaleMode '${f.scaleMode}' — not a plain cover/contain; read the crop transform / tile scale`, node, here);
      }
    }
    if (!isAssetLeaf && node.strokes && (node.strokes.align === "outside" || node.strokes.align === "center") && (node.strokes.weight || node.strokes.weights)) {
      const how: Record<AuditPlatform, string> = { web: "a CSS border is inside the box — use outline/box-shadow (no layout) or grow the box", ios: "SwiftUI .strokeBorder is inside, .stroke is centered — pad an overlay for outside", android: "Modifier.border draws inside — compensate with padding or drawBehind", "react-native": "borderWidth is inside — wrap or add padding", flutter: "use BorderSide.strokeAlign outside/center" };
      add("info", "stroke-align", `'${node.name}' has a ${node.strokes.align} stroke — ${how[platform]}; the rendered size differs from box`, node, here);
    }
    if (!isAssetLeaf && node.strokes && Array.isArray(node.strokes.colors)) {
      for (const c of node.strokes.colors) {
        const bound = !!(hasTok(node, "strokes") || (node.styles && node.styles.stroke) || (node.strokes.paints || []).some((p) => p.tokens));
        tally("color", bound);
        if (!bound) noteRaw(c, node);
      }
    }
    if (node.type === "TEXT") {
      const runs: RunLike[] = Array.isArray(node.runs) && node.runs.length ? node.runs : [{ ...ifDefined("font", node.font), ...ifDefined("tokens", node.textTokens), ...ifDefined("textStyle", node.styles && node.styles.text) }];
      for (const r of runs) {
        const typoBound = !!(r.textStyle || (node.styles && node.styles.text) || (r.tokens && (r.tokens.fontSize || r.tokens.fontFamily || r.tokens.lineHeight)) || (node.textTokens && (node.textTokens.fontSize || node.textTokens.fontFamily)));
        tally("typography", typoBound);
        if (r.font && r.font.color) {
          const cBound = !!((r.tokens && r.tokens.fills) || r.fillStyle || (node.textTokens && node.textTokens.fills) || hasTok(node, "fills") || (node.styles && node.styles.fill));
          tally("color", cBound);
          if (!cBound) noteRaw(r.font.color, node);
        }
      }
      if (!hiddenBranch) textChecks(node, ancestors, here);
    }

    // ---- spacing / radius
    if (node.layout) {
      const L = node.layout;
      const spacing: Array<[string, number, boolean]> = [];
      if (typeof L.gap === "number") spacing.push(["gap", L.gap, hasTok(node, "itemSpacing")]);
      if (typeof L.rowGap === "number") spacing.push(["rowGap", L.rowGap, hasTok(node, "counterAxisSpacing")]);
      if (typeof L.columnGap === "number") spacing.push(["columnGap", L.columnGap, hasTok(node, "gridColumnGap")]);
      if (Array.isArray(L.padding)) {
        const pad = L.padding;
        ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k, j) => { if (pad[j]) spacing.push([k, pad[j], hasTok(node, k)]); });
      }
      const offGrid: string[] = [];
      for (const [k, v, bound] of spacing) {
        tally("spacing", bound);
        if (v < 0) add("info", "negative-spacing", `'${node.name}' ${k} is ${v} (overlap) — Compose Arrangement.spacedBy rejects negatives; use offset/overlay`, node, here);
        else if (!bound && (v % grid !== 0 || !Number.isInteger(v))) offGrid.push(`${k}=${v}`);
      }
      // "snap to the nearest token" was the old wording and it contradicted build-screen's rule 5,
      // which forbids resolving a value to an approximately-matching token (silent hardcoding by
      // proxy). The audit reports the DESIGN problem; fixing it is a change to the Figma file or a
      // new token, never a rounding the build performs on its own.
      if (offGrid.length) add("info", "off-grid-spacing", `'${node.name}' has unbound spacing off the ${grid}px grid (${offGrid.join(", ")}) — likely drift; fix it in Figma or bind a token. Until then the build uses these values EXACTLY — it must not round them to the grid`, node, here);
    }
    if (node.radius != null) {
      const vals = typeof node.radius === "number" ? [node.radius] : Object.values(node.radius);
      const bound = hasTok(node, "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius");
      vals.forEach(() => tally("radius", bound));
      if (node.cornerSmoothing && (platform === "android" || platform === "web" || platform === "react-native")) {
        add("info", "corner-smoothing", `'${node.name}' uses corner smoothing ${node.cornerSmoothing} (squircle) — ${platform} has no native continuous corners; plain radius or a custom shape`, node, here);
      }
    }

    // ---- effects
    if (Array.isArray(node.effects)) {
      for (const e of node.effects) {
        tally("effects", !!(e.tokens || (node.styles && node.styles.effect)));
        if ((e.type === "drop_shadow" || e.type === "inner_shadow") && e.spread && (platform === "ios" || platform === "android")) {
          add("info", "shadow-spread", `'${node.name}' shadow has spread ${e.spread} — ${platform === "ios" ? "SwiftUI .shadow/CALayer have no spread (use shadowPath or a padded shape)" : "Modifier.shadow can't express it (use Compose 1.9+ Modifier.dropShadow)"}`, node, here);
        }
        if (e.type === "background_blur" && (platform === "android" || platform === "react-native")) add("info", "background-blur", `'${node.name}' uses a background blur — ${platform === "android" ? "no backdrop blur below API 31 / needs window blur or a library" : "needs expo-blur or a native blur view"}`, node, here);
        if ("blurType" in e && e.blurType === "progressive") add("info", "progressive-blur", `'${node.name}' uses a progressive blur — no direct equivalent on any platform; mask a blur with a gradient or use the asset`, node, here);
        if (["noise", "glass", "texture", "shader"].includes(e.type)) add("info", "exotic-effect", `'${node.name}' uses a '${e.type}' effect — no code equivalent; rasterize via the exported asset if it's load-bearing`, node, here);
      }
    }
    if (node.blendMode && (platform === "android" || platform === "react-native")) add("info", "blend-mode", `'${node.name}' uses blend mode '${node.blendMode}' — limited support on ${platform}; flag or bake into an asset`, node, here);

    // ---- touch targets
    const tappable = !hiddenBranch && isTappable(node);
    if (tappable && node.box && !ancestors.some((a) => a.__tappable)) {
      const min = TOUCH_MIN[platform];
      if (node.box.w < min || node.box.h < min) {
        add("warning", "small-touch-target", `'${node.name}' is ${node.box.w}×${node.box.h} — below the ${min}×${min} ${platform} minimum; expand the hit area (padding/hitSlop/contentShape) even if the visual stays small`, node, here, { size: { w: node.box.w, h: node.box.h }, min });
      }
    }

    if (Array.isArray(node.children)) {
      // In a parent that doesn't flow its children (no auto layout), earlier siblings paint BENEATH
      // later ones — a caption laid over a photo gets its backdrop from a sibling, not an ancestor.
      const stacks = !node.layout || node.layout.mode === "absolute";
      const earlier: Layer[] = [];
      // Only what descendants read off an ancestor. The walk is synchronous and nothing keeps
      // `ancestors`, so `self` is reused — `__beneath` is set per child before that child is walked.
      const self: Ancestor = { name: node.name, ...ifDefined("hidden", node.hidden), ...ifDefined("fills", node.fills), __tappable: tappable, __beneath: [] };
      const chain = [...ancestors, self];
      for (const child of node.children) {
        self.__beneath = stacks || child.absolute ? earlier.filter((l) => overlaps(l.box, child.box)).flatMap((l) => l.fills) : [];
        walk(child, chain, ctx);
        // F-15: a TEXT sibling's `fills` are its GLYPH colour and an icon's are its ink — neither paints a
        // backdrop. Stacking three white header labels made the 2nd and 3rd "white on white, 1:1". A
        // SHAPE the plugin also exports as an asset (an ELLIPSE avatar disc, a photo RECTANGLE) still does.
        if (!hiddenSelf(child) && child.type !== "TEXT" && !isIconInk(child) && Array.isArray(child.fills) && child.fills.length) {
          earlier.push({ fills: child.fills, ...ifDefined("box", child.box) });
        }
      }
    }
  }

  function isTappable(node: IrNode): boolean {
    if (Array.isArray(node.reactions) && node.reactions.some((r) => TAP_TRIGGER.test(r.trigger || ""))) return true;
    const compName = (node.mainComponent && node.mainComponent.setName) || node.component || "";
    if (node.type === "INSTANCE" && controlKind(compName)) return true;
    return (node.type === "INSTANCE" || node.type === "FRAME" || node.type === "COMPONENT") && INTERACTIVE_NAME.test(node.name || "") && !/\b(group|container|list|bar|section|row)s?\b/i.test(node.name || "");
  }

  function noteRaw(hex: unknown, node: IrNode): void {
    const h = String(hex || "").toLowerCase();
    const rgb = parseHex(h);
    if (!rgb) return;
    const e = rawColors.get(h) || { count: 0, nodeId: node.id, nodeName: node.name, rgb };
    e.count++;
    rawColors.set(h, e);
  }

  function textChecks(node: IrNode, ancestors: Ancestor[], here: Here): void {
    const font: FontSpec = node.font || {};
    // Fixed text box: no autoResize means Figma's "fixed size" — it will clip once text grows
    // (localization +30–40%, Dynamic Type / font scale up to 200–310%).
    if (!node.autoResize && !node.truncate && !node.maxLines) {
      add("warning", "fixed-size-text", `${cite(node)} is a fixed-size text box with no truncation rule — it will clip under font scaling or longer translations; decide wrap / truncate / grow`, node, here, textExtra(node));
    }
    // Contrast against the composited ancestor background.
    const fg = parseHex(font.color);
    if (!fg) return;
    let bg: Rgba | null = null, complex = false;
    for (const a of ancestors) {
      // The ancestor's own fills, then any earlier siblings stacked under the next level down.
      const layers = [...(Array.isArray(a.fills) ? a.fills : []), ...(a.__beneath || [])];
      for (const f of layers) {
        if (f.type === "solid") {
          const c = parseHex(f.color);
          if (!c) continue;
          bg = bg ? over(c, bg) : (c.a >= 1 ? c : over(c, { r: 255, g: 255, b: 255, a: 1 }));
          if (c.a >= 1) complex = false;
        } else if (f.type === "gradient" || f.type === "image" || f.type === "video") {
          complex = true;
        }
      }
    }
    const size = typeof font.size === "number" ? font.size : null;
    const bold = (font.weightValue || 0) >= 700 || /bold|black|heavy/i.test(font.weight || "");
    const large = size != null && (size >= 24 || (size >= 18.66 && bold));
    const need = large ? 3 : 4.5;
    if (complex) { add("info", "contrast-manual", `${cite(node)} sits on a gradient/image — check text contrast manually (needs ${need}:1)`, node, here, textExtra(node)); return; }
    const assumed = !bg;
    const base = bg || { r: 255, g: 255, b: 255, a: 1 };
    const ratio = contrastRatio(over(fg, base), base);
    if (ratio < need) {
      add(assumed ? "info" : "warning", "low-contrast", `${cite(node)} text contrast ${r1(ratio)}:1 is below WCAG AA ${need}:1 (${large ? "large" : "normal"} text, ${font.color} on ${assumed ? "an assumed white page" : "its background"})`, node, here, { ratio: r1(ratio), required: need, ...textExtra(node) });
    }
  }

  // ---- near-duplicate raw colors (likely one token typed twice)
  const raws = [...rawColors.entries()].map(([hex, e]) => ({ hex, ...e })).filter((x) => x.rgb.a >= 1);
  const labs = raws.map((x) => ({ x, lab: toLab(x.rgb) })); // once per color, not once per pair
  const seen = new Set<string>();
  for (const [a, { x: ra, lab: la }] of labs.entries()) {
    if (seen.has(ra.hex)) continue;
    const cluster = [ra];
    for (const { x: rb, lab: lb } of labs.slice(a + 1)) {
      if (!seen.has(rb.hex) && labDist(la, lb) < 3) { cluster.push(rb); seen.add(rb.hex); }
    }
    if (cluster.length > 1) add("info", "near-duplicate-colors", `unbound colors ${cluster.map((c) => `${c.hex}×${c.count}`).join(", ")} are visually indistinguishable (ΔE<3) — probably one token`, null, null, { colors: cluster.map((c) => c.hex) });
  }

  // ---- component state coverage
  // DT-80: the check read only `--catalog`, so with `--design-system` alone it had nothing to look states
  // up in, marked every control "not in the catalog" in a table note, and raised no finding — a file
  // whose whole library lacked a pressed state audited clean. Every catalog the run has is now a source,
  // most authoritative first: --catalog, the design system's own catalog (components.local.json, or a
  // library dir's components.json), each --as-library export beside it (its FULL definitions), and last
  // components.library.json — sampled from instances, so it knows only the states some screen uses.
  // Name matching is the weak half: a library can hold several rows under one name (a bare COMPONENT
  // beside two COMPONENT_SETs), and an auto-discovered library may be unrelated to this screen. So a KEY
  // match in a full catalog wins; a discovered library is name-matched only when it shares a variable
  // collection with the screen — or, when either side's keys are unknown, only if the sampled catalog has
  // no key match for the set; and among same-name rows, the ones with variants are read together.
  interface StateCatalog { label: string; components: CatalogComponent[]; byName: boolean; unproven?: boolean }
  const screenCollKeys = new Set(docs.flatMap((d) => ((d.vars && d.vars.collections) || []).map((c) => c.key)).filter((k): k is string => !!k));
  const fullCatalogs: StateCatalog[] = [];
  if (catalog.length) fullCatalogs.push({ label: "--catalog", components: catalog, byName: true });
  const dsCatalog = opts.designSystem && opts.designSystem.components;
  if (dsCatalog && dsCatalog !== opts.catalog && Array.isArray(dsCatalog.components)) fullCatalogs.push({ label: opts.designSystemDir || "the design system", components: dsCatalog.components, byName: true });
  const sameDir = (a: string, b: string | undefined): boolean => b !== undefined && path.resolve(a) === path.resolve(b);
  for (const lib of opts.libraries || []) {
    if (!lib.components || sameDir(lib.rel, opts.designSystemDir)) continue;
    const unknown = !screenCollKeys.size || !lib.collectionKeys.length;
    fullCatalogs.push({ label: lib.rel, components: lib.components.components, byName: unknown || lib.collectionKeys.some((k) => screenCollKeys.has(k)), unproven: unknown });
  }
  const sampledCatalog: CatalogComponent[] = (opts.designSystem && opts.designSystem.componentsLibrary && opts.designSystem.componentsLibrary.components) || [];
  interface StateDef { def: CatalogComponent; values: Array<string | boolean>; label: string; matchedBy: "key" | "name"; sampled: boolean }
  const valuesOf = (c: CatalogComponent): Array<string | boolean> => {
    const values: Array<string | boolean> = [];
    for (const p of Object.values(c.props || {})) {
      // A sampled row lists the values SEEN (`observed`), a definition the option list (`options`).
      if (p.type === "VARIANT") values.push(...(Array.isArray(p.options) ? p.options : Array.isArray(p.observed) ? p.observed : []));
      if (p.type === "BOOLEAN") values.push(String(p.key || "").split("#")[0] ?? ""); // ?? "": split() always returns at least one piece, so it never applies
    }
    // A sampled variant row also names its own combination ("Type=Primary, Status=Hover").
    if (c.variant) for (const part of c.variant.split(",")) { const v = part.split("=")[1]; if (v) values.push(v.trim()); }
    return values;
  };
  const isSampled = (c: CatalogComponent): boolean => !!(c.remote || c.derivedFrom === "instances");
  const hasVariants = (c: CatalogComponent): boolean => !!c.variant || Object.values(c.props || {}).some((p) => p.type === "VARIANT");
  // Several rows under one name: read the ones with variants together; say how many were merged.
  const merged = (rows: CatalogComponent[], label: string, matchedBy: "key" | "name", sampled: boolean): StateDef | null => {
    const withVariants = rows.filter(hasVariants);
    const use = withVariants.length ? withVariants : rows;
    const first = use[0];
    if (!first) return null;
    const distinct = new Set(use.map((c) => c.key || c.id || c)).size;
    return { def: first, values: use.flatMap(valuesOf), label: distinct > 1 && !sampled ? `${label} — ${distinct} rows named '${first.name}', read together` : label, matchedBy, sampled };
  };
  function stateDefOf(u: UsedComponent): StateDef | null {
    const keys = [u.key, u.variantKey].filter((k): k is string => !!k);
    const keyHit = (c: CatalogComponent): boolean => !!c.key && keys.includes(c.key);
    for (const cat of fullCatalogs) {
      const def = cat.components.find(keyHit);
      if (def) return { def, values: valuesOf(def), label: cat.label, matchedBy: "key", sampled: isSampled(def) };
    }
    // Sampled rows are one per VARIANT in use: a key hit names the set, then every row of that set is read.
    // They prove which states EXIST (something uses them), never which are missing — so a full definition
    // found by name gives the list, and the sampled values are added to it (a state seen in use is real).
    const sampledKey = sampledCatalog.find(keyHit);
    const sampledDef = sampledKey ? merged(sampledCatalog.filter((c) => keyHit(c) || c.name === sampledKey.name), "components.library.json", "key", true) : null;
    if (u.name !== undefined) {
      for (const cat of fullCatalogs) {
        if (!cat.byName || (cat.unproven && sampledDef)) continue;
        const found = merged(cat.components.filter((c) => c.name === u.name), cat.label, "name", false);
        if (found) return { ...found, values: [...found.values, ...(sampledDef ? sampledDef.values : [])], sampled: isSampled(found.def) };
      }
    }
    return sampledDef || (u.name === undefined ? null : merged(sampledCatalog.filter((c) => c.name === u.name), "components.library.json", "name", true));
  }
  const components: AuditComponentRow[] = [];
  const unchecked: string[] = [];
  const candidates: Array<{ use: UsedComponent; found: StateDef | null }> = usedComponents.size
    ? [...usedComponents.values()].filter((u) => !u.icon).map((u) => ({ use: u, found: stateDefOf(u) }))
    : catalog.filter((c) => c.type === "COMPONENT_SET" || c.type === "COMPONENT").map((c) => ({ use: { name: c.name }, found: { def: c, values: valuesOf(c), label: "--catalog", matchedBy: "name", sampled: isSampled(c) } }));
  for (const { use, found } of candidates) {
    const kind = controlKind(use.name) || (found && controlKind(found.def.name));
    if (!kind) continue;
    const need = requiredStates(kind, platform);
    if (!found) {
      // `kind` came from controlKind(use.name) here (no def), so use.name IS a string; `?? ""` only satisfies the type.
      components.push({ name: use.name ?? "", kind, known: false, present: [], missing: [], note: "in no component catalog — states unknown" });
      if (need.length) unchecked.push(use.name ?? "");
      continue;
    }
    const { def, values, label, matchedBy, sampled } = found;
    const norm = values.map((v) => String(v).trim().toLowerCase());
    const present = CONTROL_STATES.filter((s) => norm.some((v) => STATE_SYNONYMS[s].test(v)));
    const missing = need.filter((s) => !present.includes(s));
    components.push({ name: def.name, kind, known: true, sampled, present, missing, catalog: label, matchedBy });
    if (missing.length) {
      const where = `${label}${matchedBy === "name" ? ", matched by NAME only" : ""}`;
      add(sampled ? "info" : "warning", "missing-component-states", `${kind} '${def.name}' has no ${missing.join("/")} state${missing.length > 1 ? "s" : ""} in its variants (${where})${sampled ? " — sampled from instances, so this may be incomplete rather than missing" : ""} — ask the designer or derive from tokens, and say so`, null, null, { component: def.name, missing });
    }
  }
  // A check that could not run says so (DT-80): the table note alone read as "fine".
  if (unchecked.length) {
    const tried = [...fullCatalogs.map((c) => c.label), ...(sampledCatalog.length ? ["components.library.json"] : [])];
    add("warning", "component-states-unchecked",
      `states could not be checked for ${unchecked.length} control(s) — ${unchecked.slice(0, 6).map((n) => `'${n}'`).join(", ")}${unchecked.length > 6 ? ", …" : ""} — ` +
        (tried.length ? `none of the catalogs this run read (${tried.join(", ")}) defines them` : "no component catalog was given") +
        `. Missing hover/pressed/focus/disabled designs are invisible here: pass the catalog that defines them (a library export: --design-system <export>/libraries/<dir>), or ask the designer`,
      null, null, { controls: unchecked });
  }

  // ---- screen-level states: what was drawn vs what must be asked
  // "not-found" is a statement about the FRAMES THAT WERE AUDITED, not about the Figma file. Audit
  // one frame and every state but the drawn one is "not-found" by construction — which read as "the
  // designer forgot these" and needed a human to reinterpret (live run #9). The count of roots is
  // the missing context, so it ships with the verdict instead of being inferred from it.
  const stateOf = (s: ScreenStateKey): ScreenStateValue => stateHits[s].length ? "designed" : "not-found";
  // DT-14(4): a dialog has no data list, so its "empty" question is noise; a screen with inputs has a
  // validation state nobody asked about. Dialog = every audited root is named like one.
  const allDialogs = roots.length > 0 && roots.every((r) => DIALOG_NAME.test(r.tree.name || ""));
  const screenStates: AuditScreenStates = {
    loading: stateOf("loading"),
    empty: allDialogs && !stateHits.empty.length ? "not-applicable" : stateOf("empty"),
    error: stateOf("error"),
    ...(inputsSeen ? { validation: validationHits.length ? "designed" as const : "not-found" as const } : {}),
  };
  const screenStatesScope = { rootsAudited: roots.length, singleFrame: roots.length === 1 };

  // ---- heavy assets (<Screen>.assets.json `heavy`) — the pull warns once on stderr; the audit is what
  // the build reads (F-25: a 2.4 MB, 1523-path illustration never reached the report).
  for (const d of docs) {
    const a = d.assets;
    if (!a || !Array.isArray(a.heavy)) continue;
    const label = labelledRoots(d.doc, d.label)[0]?.label ?? d.label;
    for (const h of a.heavy) {
      const nodeId = (Array.isArray(a.files) ? a.files : []).find((f) => f.file === h.file)?.node;
      if (nodeId && hiddenIds.has(nodeId)) continue; // a hidden layer's asset is not built (finding 74)
      const node = nodeId ? nodesById.get(nodeId) : undefined;
      add("info", "heavy-asset",
        `'${h.file}' is ${(h.bytes / 1048576).toFixed(2)} MB${h.paths ? ` / ${h.paths} <path> elements` : ""} — too heavy to inline; import it by URL, or ask the designer for a raster export. Do not redraw or simplify it`,
        node || null, { label }, { file: h.file, bytes: h.bytes, ...ifDefined("paths", h.paths) });
    }
  }

  // ---- prototype links (DT-14(5)) — one info per destination, so a reader can spot one that doesn't belong
  for (const n of navigations.values()) {
    add("info", "prototype-navigation",
      `${n.count} layer(s) (e.g. '${n.node.name}') ${n.navigation === "overlay" ? "open" : n.navigation === "swap" ? "swap to" : "go to"} '${n.destination ?? "an unnamed frame"}'${n.destinationId ? ` (${n.destinationId})` : ""} in the prototype — confirm this is the intended behaviour before wiring it (a link copied along with a layer looks the same as a designed one)`,
      n.node, { label: n.label }, { ...ifDefined("destination", n.destination), ...ifDefined("destinationId", n.destinationId), navigation: n.navigation, sources: n.count });
  }

  const bindingOf = (k: AuditCategory): { bound: number; total: number; pct: number | null } => { const [b, t] = binding[k]; return { bound: b, total: t, pct: t ? Math.round((b / t) * 100) : null }; };
  const tokenBinding: AuditReport["tokenBinding"] = { color: bindingOf("color"), typography: bindingOf("typography"), spacing: bindingOf("spacing"), radius: bindingOf("radius"), effects: bindingOf("effects") };
  for (const k of AUDIT_CATEGORIES) {
    const v = tokenBinding[k];
    if (v.total >= 5 && v.pct !== null && v.pct < 50) add("warning", "low-token-binding", `only ${v.pct}% of ${k} values are bound to tokens/styles (${v.bound}/${v.total}) — expect to carry raw values through EXACTLY and report each as unbound; do not snap them to the nearest token`, null, null, { category: k });
  }

  // ---- questions the export cannot answer (always asked; the skill trims ones already answered)
  const questions: string[] = [];
  const STATE_QUESTION: Record<ScreenStateKey, string> = {
    loading: allDialogs ? "what shows while the dialog's action runs (disabled buttons, spinner, can it be dismissed)?" : "what shows while data loads (skeleton vs spinner, delay before showing)?",
    empty: "what shows when there's no data (first use vs no results vs cleared)?",
    error: "what shows when a request fails (inline vs full-screen, retry, offline)?",
  };
  for (const s of STATE_KEYS) if (screenStates[s] === "not-found") questions.push(`No ${s} state was found in the exported layers — ${STATE_QUESTION[s]}`);
  if (screenStates.validation === "not-found") questions.push("No validation state was found for this screen's inputs — how do field errors show (inline message, when: on blur or on submit, and what does each field require)?");
  if (unchecked.length) questions.push(`The states of ${unchecked.slice(0, 6).map((n) => `'${n}'`).join(", ")}${unchecked.length > 6 ? ", …" : ""} could not be checked (no catalog defines them) — are hover/pressed/focus/disabled designed somewhere?`);
  for (const c of components.filter((c) => c.missing && c.missing.length)) questions.push(`'${c.name}' has no ${c.missing.join("/")} design — use the design-system default, or is there a spec?`);
  if (findings.some((f) => f.code === "fixed-size-text")) questions.push("Several text boxes are fixed-size — at 200% font scale or in a longer language, should they wrap, truncate (how many lines), or grow?");

  // ---- the cross-FILE pass
  // Everything above reasons inside one screen's own JSON, which is why the live run's audit reported
  // "96% of colors bound" on a screen whose tokens came from an entirely different library than the
  // design system beside it (finding 56). "Bound" meant "resolves to some variable in its own file",
  // never "matches what you exported" — and a reader reasonably read it as the latter. The join lives
  // in cross-check.ts; its findings are merged in here so one report answers both questions.
  let crossFile: AuditCrossFile;
  let hiddenFindingsOmitted = 0;
  if (opts.designSystem || opts.variables) {
    crossFile = crossCheck({
      // Each screen's OWN variables (d.vars — its <Screen>.vars.json) travel with it: the collision
      // check is about the variables THIS screen carries, not the merged union's (livetest-3 #311 —
      // without them this gate raised another screen's `Space 4` blocker against Job Roles).
      screens: docs,
      variables: opts.variables || null,
      sliceSources: opts.sliceSources || null,
      tokens: (opts.designSystem && opts.designSystem.tokens) || null,
      components: (opts.designSystem && opts.designSystem.components) || opts.catalog || null,
      componentsLibrary: (opts.designSystem && opts.designSystem.componentsLibrary) || null,
      stylesText: (opts.designSystem && opts.designSystem.stylesText) || null,
    });
    for (const f of crossFile.findings) {
      if (f.severity === "info") continue; // the coverage table below carries the informational half
      if (f.nodeId && hiddenIds.has(f.nodeId)) { hiddenFindingsOmitted++; continue; } // same rule as the walk (finding 74)
      const { severity, code, message, ...rest } = f; // key order kept: severity, code, message, crossFile, the rest
      findings.push({ severity, code, message, crossFile: true, ...rest });
    }
  } else {
    crossFile = {
      summary: { blockers: 0, warnings: 0, info: 0 },
      findings: [],
      coverage: null,
      notChecked: [
        "the whole cross-FILE pass — no design system was given. Every token-binding percentage below means " +
          "\"resolves to some variable in this screen's own file\", NOT \"matches your design system\". " +
          "Re-run with --design-system design/export/design-system to tell the two apart.",
      ],
      inputs: {},
    };
  }

  // DT-11: a --as-library export beside the design system is where the screen's library tokens and full
  // component definitions usually are, and nothing pointed at it. Its components already feed the state
  // check above; checking tokens against it changes what the cross-file pass compares, so that stays the
  // caller's choice — named here with the command, and with how much of this screen it covers by key.
  for (const lib of opts.libraries || []) {
    if (sameDir(lib.rel, opts.designSystemDir)) continue;
    const shared = lib.collectionKeys.filter((k) => screenCollKeys.has(k)).length;
    crossFile.notChecked.push(
      `the library export ${lib.rel} ('${lib.name}') — the cross-file pass did not compare this screen against it` +
        (screenCollKeys.size ? ` (the screen binds ${shared} of its ${screenCollKeys.size} variable collection(s) from it by key)` : "") +
        `. Its components.json ${lib.components ? "WAS" : "could not be"} read for the component-state check. To check tokens, text styles and components against it, re-run with --design-system ${lib.rel}.`
    );
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const count = (s: Severity): number => findings.filter((f) => f.severity === s).length;
  return {
    platform,
    platformAssumed,
    crossFile,
    grid,
    gridAssumed,
    gridMismatch,
    screenStatesScope,
    screens: roots.map((r) => r.label),
    // The root node id(s) audited — additive, read only by the CLI's finding-315 duplicate-artefact
    // check (P3 round 3): it lets a re-run find an EARLIER report for the same screen under a
    // different name without re-parsing every screen export in the directory.
    nodeIds: roots.map((r) => r.tree && r.tree.id).filter((id): id is string => !!id),
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    hiddenLayers: { nodesSkipped: hiddenIds.size, crossFileFindingsOmitted: hiddenFindingsOmitted },
    tokenBinding,
    components,
    screenStates,
    annotations,
    questions,
    findings,
  };
}

// ---------------------------------------------------------------- markdown report
function toMarkdown(res: AuditReport): string {
  const L: string[] = [];
  L.push(`# Design audit — ${res.screens.join(", ") || "(no screens)"}`, "");
  const gridNote = res.gridMismatch
    ? ` *(${res.gridAssumed ? "DEFAULT — not given" : "as given"}; this system's own spacing tokens step by ${res.gridMismatch}px, not ${res.grid}px — pass \`--grid ${res.gridMismatch}\`)*`
    : res.gridAssumed ? " *(default — not given)*" : "";
  L.push(`Platform: **${res.platform}**${res.platformAssumed ? " *(ASSUMED — not given)*" : ""} · grid ${res.grid}px${gridNote} · **${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info`, "");
  if (res.hiddenLayers && res.hiddenLayers.nodesSkipped) L.push(`*${res.hiddenLayers.nodesSkipped} node(s) on hidden layers (switched off in Figma) were skipped — they are not built, and no finding below cites one.*`, "");
  if (res.platformAssumed) {
    L.push(`> ⚠️ **No platform was given, so this audit assumed \`web\`.** Touch-target minimums, shadow`,
      `> spread, blur and blend-mode support all differ per platform — on the wrong one, every one of`,
      `> those findings is wrong. Confirm it, then re-run with \`--platform ios|android|react-native|flutter\``,
      `> (or write \`design/target.json\`, which both this audit and build-screen read).`, "");
  }
  const cf = res.crossFile;
  if (cf) {
    L.push("## Does this screen come from that design system?", "");
    if (cf.coverage && cf.coverage.distinct) {
      const c = cf.coverage;
      L.push(
        `**${c.matchedByLocalKey}/${c.distinct} (${c.localPct}%)** of the components on this screen resolve to ` +
          `the design system's component catalog **by key**` +
          (c.matchedByName ? `; ${c.matchedByName} more match by NAME only and are unverified` : "") +
          (c.ambiguousName ? `; ${c.ambiguousName} share a name with several catalog entries and were left unmatched` : "") + ".",
        ""
      );
      // 0% by key is ALSO what a duplicated file looks like (livetest-3 #226): say which case this is.
      if (c.rekey && c.rekey.rekeyed) {
        L.push(
          `**This is the re-keyed-copy case, not a foreign library:** ${c.rekey.proposed} of the ${c.rekey.withCandidates} component(s) whose name is in the ` +
            `catalog also match it by prop signature. The proposed matches are listed under \`crossFile.componentProposals\` — confirm them with the ` +
            `user, then the map-bootstrap script with \`--from-proposals\` stubs exactly those.`,
          ""
        );
      }
    }
    // The union's token collision that belongs to ANOTHER screen stays visible here as a note, so a
    // reader does not "fix" this screen's correct value to match it (livetest-3 #40/#311).
    const cfBlock = cf.findings.filter((f) => f.severity !== "info" || f.code === "token-name-collision-elsewhere");
    if (cfBlock.length) {
      for (const f of cfBlock) L.push(`- **${f.severity}** \`${f.code}\` ${f.message}`);
      L.push("");
    } else if (cf.inputs && cf.inputs.tokens) {
      L.push("No cross-file problem found: the screen's tokens, text styles and components all trace to the design system you exported.", "");
    }
    if (cf.notChecked && cf.notChecked.length) {
      L.push("*Not checked — these are gaps in the INPUT, not clean results:*", "");
      for (const n of cf.notChecked) L.push(`- ${n}`);
      L.push("");
    }
  }
  L.push("## Token binding", "");
  L.push(
    "*\"Bound\" means the node binds SOME variable — read it together with the section above, which says whether",
    "that variable is one the design system defines.*",
    "",
    "| Category | Bound | Total | % |", "|---|---|---|---|"
  );
  for (const [k, v] of Object.entries(res.tokenBinding)) L.push(`| ${k} | ${v.bound} | ${v.total} | ${v.pct == null ? "–" : v.pct + "%"} |`);
  L.push("", "## Screen states", "");
  const scope: Partial<AuditReport["screenStatesScope"]> = res.screenStatesScope || {};
  if (scope.singleFrame) {
    L.push(`*Scope: **one frame** was audited. "not found" below means "not in this frame" — it does not`,
      `mean the state is missing from the Figma file. Export the other frames to tell the two apart.*`, "");
  } else if (scope.rootsAudited !== undefined && scope.rootsAudited > 1) {
    L.push(`*Scope: ${scope.rootsAudited} frames audited — "not found" means none of them drew it.*`, "");
  }
  for (const [k, v] of Object.entries(res.screenStates)) {
    L.push(`- ${k}: ${v === "designed" ? "designed" : v === "not-applicable" ? "not applicable (a dialog has no data list)" : scope.singleFrame ? "**not in this frame — ask**" : "**not found — ask**"}`);
  }
  if (res.components.length) {
    L.push("", "## Component states", "", "| Component | Kind | Present | Missing | Catalog |", "|---|---|---|---|---|");
    for (const c of res.components) L.push(`| ${c.name} | ${c.kind} | ${c.present.join(", ") || "–"} | ${c.known ? (c.missing.join(", ") || "none") : c.note}${c.sampled ? " (sampled)" : ""} | ${c.catalog ? `${c.catalog}${c.matchedBy === "name" ? " (by name)" : ""}` : "–"} |`);
  }
  for (const sev of ["blocker", "warning", "info"] as const) {
    const fs = res.findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    L.push("", `## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs.length})`, "");
    for (const f of fs) L.push(`- \`${f.code}\` ${f.message}${f.nodeId ? ` — node \`${f.nodeId}\`${f.screen ? ` in ${f.screen}` : ""}` : ""}`);
  }
  if (res.annotations.length) {
    L.push("", "## Designer annotations", "");
    for (const a of res.annotations) L.push(`- **${a.nodeName}** (\`${a.nodeId}\`): ${a.label}`);
  }
  if (res.questions.length) {
    L.push("", "## Questions for the designer", "");
    res.questions.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  }
  return L.join("\n") + "\n";
}

// finding 136: a stable id per blocker finding, so a plan's `auditGate.overridden` can name exactly
// which blocker(s) the user decided to build past. Findings carry no id of their own; `<code>#<i>`
// (i = position among this doc's blockers, in report order) is stable for a given audit run and is
// what plan-skeleton.ts pre-fills and verify-build.ts checks against.
// Takes anything (an audit report, or whatever a caller read off disk): only `findings[]` is looked at.
function blockerIds(auditDoc: unknown): string[] {
  const findings: unknown[] = (auditDoc && typeof auditDoc === "object" && "findings" in auditDoc && Array.isArray(auditDoc.findings)) ? auditDoc.findings : [];
  return findings.filter((f): f is Partial<AuditFinding> => !!f && typeof f === "object" && "severity" in f && f.severity === "blocker").map((f, i) => `${f.code || "blocker"}#${i}`);
}

// P3 round 3, finding 315's sibling in audit.ts: an explicit `--out <nickname>` still wrote a second
// complete report pair for a screen that already has one under its default name. Scans a directory's
// own `*.json` audit reports (never a subdirectory — one screen, one flat design/audit/) for one
// whose `nodeIds` already includes this run's root node, at a DIFFERENT basename than the one about
// to be written. Returns that file's path, or null.
function findExistingAuditFor(dir: string, nodeId: string | undefined, ownTarget: string): string | null {
  if (!nodeId || !fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(dir, f);
    if (path.resolve(full) === path.resolve(ownTarget)) continue;
    // design/audit/ also holds cross-check reports; only an object with a nodeIds[] counts.
    const doc = readJsonOrNull(full, isJsonObject);
    if (doc && Array.isArray(doc.nodeIds) && doc.nodeIds.includes(nodeId)) return full;
  }
  return null;
}

export { audit, toMarkdown, contrastRatio, parseHex, deltaE, controlKind, TOUCH_MIN, blockerIds, findExistingAuditFor };

// CLI: node design-to-code/audit.ts <screen.json|layer.json>... [--platform web|ios|android|react-native|flutter]
//        [--catalog design/design-system/components.local.json] [--grid 4] [--out design/audit] [--json] [--gate]
// --gate: exit 1 if any blocker was found (default is always exit 0 — findings are advice unless --gate is set).
// Every input is checked as it is read (doc-guards.ts / export-shape.ts): a file that is not the kind of
// document its flag names is a one-line error and exit 2, never an audit of nothing.
function main(argv: string[]): number {
  const USAGE =
    `usage: ${scriptCmd("audit")} <screen.json>... [--platform web|ios|android|react-native|flutter]\n` +
    "       [--design-system design/export/design-system] [--variables design/export/variables.json]\n" +
    "       [--catalog components.local.json] [--grid 4] [--out design/audit] [--json] [--gate] [--force]\n" +
    "  --design-system turns on the cross-FILE pass (does this screen come from that design system?).\n" +
    "  It takes design/export/design-system or a library export, design/export/libraries/<dir>.\n" +
    "  Without it every token-binding % below means \"binds SOME variable\", not \"matches your design system\".\n" +
    "  --out defaults to design/audit/<input file's own basename> — the same <LayerName>__<node-id>\n" +
    "  name write-out.js gave the screen file, so re-auditing the same screen always lands on the same\n" +
    "  report pair instead of a new name each run. Refuses (exit 1) if an existing report in the same\n" +
    "  directory already covers this node under a DIFFERENT name — pass --force to write a second one.";
  const OPTIONS = {
    platform: { type: "string" }, catalog: { type: "string" }, "design-system": { type: "string" }, variables: { type: "string" },
    grid: { type: "string" }, out: { type: "string" }, json: { type: "boolean" }, gate: { type: "boolean" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } as const;
  const { values: flags, positionals: files } = cliParse("audit", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; }
  const firstFile = files[0];
  if (firstFile === undefined) { console.error(USAGE); return 2; }
  const { platform, catalog: catalogFile, "design-system": dsDir, variables: varsFile, grid: gridArg, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate, force = !!flags.force;
  if (platform && !PLATFORMS.includes(platform)) { console.error(`--platform must be one of ${PLATFORMS.join(", ")}`); return 2; }
  // `--grid abc` used to become NaN and fall back to the 4px default without a word.
  const grid = gridArg === undefined ? undefined : Number(gridArg);
  if (grid !== undefined && !(Number.isFinite(grid) && grid > 0)) { console.error(`--grid must be a positive number of px, got ${JSON.stringify(gridArg)}`); return 2; }
  // Variables discovery is shared with cross-check.ts (slice-sources.ts variablesContext): the union
  // at the export root (or --variables), and each screen's own slice beside it.
  const ctx = variablesContext(files, varsFile, { sliceFallback: true });
  for (const bad of ctx.invalid) console.error(`error  variables: '${bad.file}' ${bad.error}`);
  if (ctx.invalid.length) return 2;
  // Each screen's <Screen>.assets.json beside it (heavy assets); optional, and never fatal — it is advice.
  const inputs: AuditInput[] = files.map((f, i) => ({
    doc: readDocFile(f, "screen export", isScreenDoc), label: path.basename(f, ".json"), ...ifDefined("vars", ctx.own[i]), // own[i] is set: own is files.map(...)
    assets: readJsonOrNull(f.replace(/\.json$/, ".assets.json"), isScreenAssetsDoc),
  }));
  const catalog = catalogFile ? readSplitFile(catalogFile, "component catalog", isComponentsCatalog, "components", "design-system/components.local.json") : undefined;
  // Optional by design: a project that only ever pulled one screen has no design-system/ at all, and
  // the audit must still run there — it just says which checks it could not do (crossFile.notChecked).
  // A split file that IS there but is not what it should be fails loud (readOptionalDoc).
  // readDesignSystemDir reads either layout: design-system/ or a --as-library export's libraries/<dir>/.
  const dsRead = dsDir ? readDesignSystemDir(dsDir) : null;
  const designSystem: AuditDesignSystem | undefined = dsRead
    ? { tokens: dsRead.tokens, ...ifDefined("components", dsRead.components || catalog), componentsLibrary: dsRead.componentsLibrary, stylesText: dsRead.stylesText }
    : undefined;
  // DT-11: the --as-library exports beside the export (libraries/index.json), found from the screen's own
  // path or the design-system dir's — never a directory the user did not already pull into.
  const libraries = findLibraryExports(firstFile, dsDir);
  // `variables` is the merged union (what the screen's collections are checked against); each input
  // also carries its own slice (inputs[].vars), which is what token collisions are judged on.
  const variables = ctx.variablesDoc;
  if (ctx.staleLegacy) console.error(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) — remove it or re-pull into design/export/.`);
  const res = audit(inputs, {
    ...ifDefined("platform", platform), ...ifDefined("catalog", catalog), ...ifDefined("designSystem", designSystem), ...ifDefined("designSystemDir", dsDir),
    libraries, variables, sliceSources: ctx.sliceSources, ...ifDefined("grid", grid),
  });
  const md = jsonOnly ? "" : toMarkdown(res);
  // P3 #72/#73: one screen ended up under FIVE different report basenames across runs because the
  // skill invented one each time (`positions`/`job-roles`/`global-policies`/`System_Configurations`
  // for the SAME node). `--out`'s default is derived from the input FILE, which is itself already
  // named `<LayerName>__<node-id>` by write-out.js/pages-layout.js — the one artefact-naming rule —
  // so two runs on the same screen land on the same report pair without either caller having to
  // agree on a name out of band. Only the first input names it when several are given at once.
  const outBase = out || path.join("design", "audit", path.basename(firstFile, ".json"));
  // Finding 315's sibling / P3 c6: refuse an explicit --out under a different name than an existing
  // report already covering this node, unless --force.
  if (!jsonOnly && outBase && res.nodeIds && res.nodeIds.length) {
    const dup = findExistingAuditFor(path.dirname(outBase) || ".", res.nodeIds[0], outBase + ".json");
    if (dup && !force) {
      console.error(
        `error  node ${res.nodeIds[0]} already has an audit report at ${dup} — refusing to also write ${outBase}.json/.md ` +
          "(one screen, one report pair). Use that existing name, or pass --force to write this one anyway."
      );
      return 1;
    }
  }
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (outBase) {
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    fs.writeFileSync(outBase + ".json", JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(outBase + ".md", md);
    console.error(`wrote ${outBase}.json and ${outBase}.md`);
  } else {
    process.stdout.write(md);
  }
  // On stderr too: --json callers never render the markdown, and a piped run shows only this line.
  if (res.platformAssumed) console.error("warn  no --platform given — assumed 'web'. Touch targets, shadow spread and blur support differ per platform; pass --platform or write design/target.json.");
  if (!jsonOnly) console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of (res.crossFile && res.crossFile.notChecked) || []) console.error(`note  not checked: ${n}`);
  return gate && res.summary.blockers > 0 ? 1 : 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
