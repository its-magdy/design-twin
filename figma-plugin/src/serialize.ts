// The recursive node serializer: one SceneNode -> compact JSON. Orchestrates the typed helper
// modules. Reads are defensive (`"x" in node` guards) because it runs over the whole SceneNode
// union; per-property values are typed inside the helpers it calls.
import type {
  IrNode, Box, SizeLimits, RadiusCorners, LayoutGridSpec, TableCell, ComponentPropValues, TokenMap,
  Annotation as IrAnnotation, ExportSetting as IrExportSetting, Overlay as IrOverlay,
} from "../../bridge/src/doc-types.ts";
import { round, lower, propName, rgbaToHex, nonEmpty, putNonEmpty, xy, numProp, isList } from "./util";
import { stats, warn, runOpts } from "./state";
import { layout, GRID_SELF, simplifyGrid } from "./layout";
import { simplifyFills, simplifyStrokes } from "./paint";
import { simplifyEffects } from "./effects";
import { serializeText } from "./text";
import { boundTokens, nodeStyles, variableModes, resolveBoundMap } from "./variables";
import { simplifyReactions } from "./prototype";
import { collectAsset } from "./assets";
import { instanceComponentRef, componentPropRefs, instanceOverrides } from "./components";
import { collectMotion } from "./motion";

const MAX_DEPTH = 60;

// Hoisted: these were fresh arrays allocated on EVERY node, the vast majority of which have neither
// size limits nor mixed corner radii.
const SIZE_LIMIT_KEYS: Array<keyof SizeLimits> = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
const CORNER_KEYS: Array<[string, keyof RadiusCorners]> = [
  ["topLeftRadius", "tl"],
  ["topRightRadius", "tr"],
  ["bottomRightRadius", "br"],
  ["bottomLeftRadius", "bl"],
];

// A corner radius, made safe to transcribe.
//
// Two things reach this field that must not land verbatim in generated code. Figma's "fully rounded"
// corner exports as a literal 1000000000 — a sentinel, not a measurement, and `border-radius:
// 1000000000px` is nobody's intent (live finding 30). And an unrounded float arrives as
// 60.00000762939453 / 34.000003814697266, float dust from a resize that a builder then copies into
// CSS (finding 45).
//
// So: round to 2dp like every other number this serializer emits, and replace the sentinel with what
// Figma ACTUALLY renders — half the shorter side — while setting `radiusFull` so the builder can emit
// the platform's own idiom (CSS 9999px or 50%, SwiftUI .infinity, Compose CircleShape) instead of a
// number. The value stays faithful to the render; the intent stays recoverable.
const RADIUS_SENTINEL = 10000;
function radiusOut(out: IrNode, raw: number): number {
  if (raw < RADIUS_SENTINEL) return round(raw);
  out.radiusFull = true;
  const box = out.box;
  const w = box && typeof box.w === "number" ? box.w : undefined;
  const h = box && typeof box.h === "number" ? box.h : undefined;
  if (w === undefined && h === undefined) return round(raw); // no box to clamp against — keep it honest and let the flag carry the meaning
  return round(Math.min(w === undefined ? Infinity : w, h === undefined ? Infinity : h) / 2);
}

// Own-scope plugin data (getPluginData) written by THIS plugin — round-trip metadata (e.g. a future
// Code-Connect mapping our write plane stamps). Shared namespaces can't be enumerated by the API, so
// only own-scope keys are read. Opt-in via runOpts.pluginData.
// getPluginData(Keys) is declared on PluginDataMixin, which every BaseNode extends (verified: plugin-api.d.ts
// PluginDataMixin ~6380, BaseNodeMixin extends it ~6220) — real methods, not a beta surface, so no cast.
function pluginData(node: BaseNode): Record<string, string> | undefined {
  let keys: string[] = [];
  try { keys = node.getPluginDataKeys(); } catch (e) { return undefined; }
  if (!keys || !keys.length) return undefined;
  const out: Record<string, string> = {};
  for (const k of keys) {
    try { const v = node.getPluginData(k); if (v) out[k] = v; } catch (e) {}
  }
  return nonEmpty(out);
}

// Cross-plugin SHARED plugin data (getSharedPluginData) — distinct from getPluginData, which only
// reads OUR own plugin's storage. The "tokens" namespace is where Tokens Studio persists the semantic
// token applied per-node (property -> token name); on files that predate/forgo native Figma Variables
// this is the ONLY place the token layer lives. Values are small uncompressed strings, so this is a
// cheap sync read. (The document-level compressed+chunked `values`/`themes` blob needs an lz-string
// decode and is deferred.) Opt-in via runOpts.sharedData. Namespaces must be known ahead of time — the
// API can't enumerate them — so we probe the well-known ones.
const SHARED_NAMESPACES = ["tokens"];
function sharedData(node: BaseNode): Record<string, Record<string, string>> | undefined {
  const out: Record<string, Record<string, string>> = {};
  for (const ns of SHARED_NAMESPACES) {
    let keys: string[] = [];
    try { keys = node.getSharedPluginDataKeys(ns) || []; } catch (e) { continue; }
    const bucket: Record<string, string> = {};
    for (const k of keys) {
      try { const v = node.getSharedPluginData(ns, k); if (v) bucket[k] = v; } catch (e) {}
    }
    putNonEmpty(out, ns, bucket);
  }
  return nonEmpty(out);
}

// Figma's OWN computed CSS for the node — the oracle the paid get_design_context leans on. One async
// call per node, so opt-in via runOpts.css. Ground truth for a codegen self-correction loop.
// getCSSAsync is declared directly on BaseNodeMixin (plugin-api.d.ts ~6367), i.e. every SceneNode has
// it — the original `typeof n.getCSSAsync === "function"` guard predates that and is now unreachable
// (kept as a try/catch instead, in case a given node type still rejects at runtime).
async function nodeCss(node: SceneNode): Promise<Record<string, string> | undefined> {
  try {
    const css = await node.getCSSAsync();
    return css && Object.keys(css).length ? css : undefined;
  } catch (e) {
    return undefined;
  }
}

export async function serialize(node: SceneNode, depth: number, parentControlsLayout?: boolean): Promise<IrNode | null> {
  if (depth > MAX_DEPTH) {
    stats.truncated++;
    if (stats.truncated === 1) warn("depth limit " + MAX_DEPTH + " reached — deep subtrees truncated (first: " + node.name + ")");
    return null;
  }
  stats.nodes++;
  // Hidden nodes are KEPT (flagged) — hidden variant states (error toasts, tooltips, empty states)
  // are part of the design and must be implementable; codegen decides render vs display:none.
  const out: IrNode = { type: node.type, name: node.name, id: node.id };
  if ("visible" in node && node.visible === false) out.hidden = true;

  if (node.type === "INSTANCE" && node.componentProperties) {
    const props: ComponentPropValues = {};
    const propTokens: TokenMap = {}; // a BOOLEAN/TEXT prop whose value is driven by a variable (token link)
    const componentProperties = node.componentProperties;
    const keys = Object.keys(componentProperties);
    // One await for the whole prop set rather than one per property — the bindings are independent.
    const bound = await Promise.all(keys.map((k) => resolveBoundMap(componentProperties[k].boundVariables)));
    keys.forEach((k, i) => {
      props[propName(k)] = componentProperties[k].value;
      const bv = bound[i];
      if (bv && bv.value) propTokens[propName(k)] = bv.value;
    });
    putNonEmpty(out, "props", props);
    putNonEmpty(out, "propTokens", propTokens);
  }
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") out.component = node.name;

  const lay = layout(node);
  if (lay) out.layout = lay;

  // Child-in-parent layout role (out of auto-layout flow / grows to fill).
  const absoluteInParent = "layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE";
  if (absoluteInParent) out.absolute = true;
  if ("layoutGrow" in node && node.layoutGrow) out.grow = node.layoutGrow;

  // Enum reads that are all "if present and not the default, emit lowercased". The fields span many
  // SceneNode-union members (layoutAlign/layoutSizing* only exist on auto-layout children,
  // overflowDirection only on scroll frames), hence the `in` guard on each.
  // Child sizing intent (FILL/HUG/FIXED), counter-axis alignment, scroll direction.
  if ("layoutAlign" in node && node.layoutAlign && node.layoutAlign !== "INHERIT") out.alignSelf = lower(node.layoutAlign);
  // FIXED is the default on nearly every node — two keys of pure noise per node. Only FILL/HUG
  // (the values that actually change the generated CSS) are worth emitting.
  if ("layoutSizingHorizontal" in node && node.layoutSizingHorizontal && node.layoutSizingHorizontal !== "FIXED") out.widthMode = lower(node.layoutSizingHorizontal);
  if ("layoutSizingVertical" in node && node.layoutSizingVertical && node.layoutSizingVertical !== "FIXED") out.heightMode = lower(node.layoutSizingVertical);
  if ("overflowDirection" in node && node.overflowDirection && node.overflowDirection !== "NONE") out.scroll = lower(node.overflowDirection);

  // Grid child placement — span across tracks AND the starting (anchor) cell.
  if ("gridColumnSpan" in node && typeof node.gridColumnSpan === "number" && node.gridColumnSpan !== 1) out.gridColumnSpan = node.gridColumnSpan;
  if ("gridRowSpan" in node && typeof node.gridRowSpan === "number" && node.gridRowSpan !== 1) out.gridRowSpan = node.gridRowSpan;
  if ("gridColumnAnchorIndex" in node && typeof node.gridColumnAnchorIndex === "number") out.gridColumnStart = node.gridColumnAnchorIndex; // 0-based track index
  if ("gridRowAnchorIndex" in node && typeof node.gridRowAnchorIndex === "number") out.gridRowStart = node.gridRowAnchorIndex;
  // Grid child cell alignment, mapped through GRID_SELF (MIN/CENTER/MAX -> start/center/end).
  if ("gridChildHorizontalAlign" in node && node.gridChildHorizontalAlign && node.gridChildHorizontalAlign !== "AUTO") out.gridJustifySelf = GRID_SELF[node.gridChildHorizontalAlign];
  if ("gridChildVerticalAlign" in node && node.gridChildVerticalAlign && node.gridChildVerticalAlign !== "AUTO") out.gridAlignSelf = GRID_SELF[node.gridChildVerticalAlign];

  // Position — only when the parent does NOT auto-position this node.
  if ((!parentControlsLayout || absoluteInParent) && "x" in node && typeof node.x === "number") {
    out.x = round(node.x);
    out.y = round(node.y);
  }

  // Resolved page-space box — the ground-truth pixel size. `renderBox` adds stroke/shadow/blur extent,
  // emitted only when it actually differs from the layout box.
  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    const b = node.absoluteBoundingBox;
    // w/h always; x/y only under the SAME rule as the `x`/`y` fields above. These are PAGE-space
    // coordinates: inside an auto-layout or grid parent the container decides placement, so codegen
    // must never use them — and emitting them invites exactly that (absolutely-positioned children
    // reconstructed from page coords). An absolutely-positioned child still needs them, and so does
    // any child of a non-auto-layout parent.
    const box: Box = { w: round(b.width), h: round(b.height) };
    out.box = box;
    if (!parentControlsLayout || absoluteInParent) { box.x = round(b.x); box.y = round(b.y); }
    const rb = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null;
    if (rb && (rb.x !== b.x || rb.y !== b.y || rb.width !== b.width || rb.height !== b.height)) {
      out.renderBox = { ...xy(rb), w: round(rb.width), h: round(rb.height) };
    }
  }

  // Per-frame layout grids (responsive column/row grids).
  if ("layoutGrids" in node && Array.isArray(node.layoutGrids) && node.layoutGrids.length) {
    out.layoutGrids = node.layoutGrids.map(simplifyGrid).filter((g): g is LayoutGridSpec => !!g);
  }

  // Dev Mode handoff — FREE via the Plugin API and NOT surfaced by the paid REST/get_design_context.
  if ("annotations" in node && isList(node.annotations) && node.annotations.length) {
    out.annotations = node.annotations.map((a) => {
      const o: IrAnnotation = {};
      if (a.label) o.label = a.label;
      if (a.labelMarkdown) o.markdown = a.labelMarkdown;
      if (a.categoryId) o.categoryId = a.categoryId; // groups annotations by Dev-Mode category
      if (isList(a.properties) && a.properties.length) o.props = a.properties.map((p: AnnotationProperty) => p.type);
      return o;
    });
  }
  if ("devStatus" in node && node.devStatus && node.devStatus.type) {
    out.devStatus = lower(node.devStatus.type); // ready_for_dev | completed
    if (node.devStatus.description) out.devStatusNote = node.devStatus.description; // free-text handoff note
  }

  // Min/max size (responsive auto-layout constraints). Allocated lazily — most nodes have none.
  let sizeLimits: SizeLimits | undefined;
  for (const k of SIZE_LIMIT_KEYS) {
    const v = numProp(node, k);
    if (k in node && typeof v === "number") (sizeLimits || (sizeLimits = {}))[k] = round(v);
  }
  if (sizeLimits) out.sizeLimits = sizeLimits;

  // Pin constraints (how a non-auto-layout child resizes with its parent).
  if ("constraints" in node && node.constraints && (node.constraints.horizontal !== "MIN" || node.constraints.vertical !== "MIN")) {
    out.pin = { h: lower(node.constraints.horizontal), v: lower(node.constraints.vertical) };
  }

  // Sticky children: the first N children of a scrolling frame are PINNED (Figma's "fixed position
  // when scrolling"). Without this a sticky header / bottom nav / FAB serializes as a plain flow
  // child and codegen emits a header that scrolls away with the content.
  if ("numberOfFixedChildren" in node && typeof node.numberOfFixedChildren === "number" && node.numberOfFixedChildren > 0) {
    out.fixedChildren = node.numberOfFixedChildren;
  }

  // Clip — the difference between a ScrollView and a fixed frame (critical on mobile). The matching
  // `scroll` (overflowDirection) read is table-driven above.
  if ("clipsContent" in node && node.clipsContent) out.clip = true;

  // Three INDEPENDENT paint reads that each end in resolveBoundMap (a getVariableByIdAsync round trip
  // on a cache miss), awaited one after another for no reason — none consumes another's result, and
  // they write distinct keys. Same treatment as the fan-out at the end of this function.
  const [fills, strokes, effects] = await Promise.all([
    simplifyFills("fills" in node ? node.fills : undefined),
    simplifyStrokes(node),
    simplifyEffects("effects" in node ? node.effects : undefined),
  ]);
  if (fills) out.fills = fills;
  if (strokes) out.strokes = strokes;
  // Whether stroke weight counts toward auto-layout size (border-box vs content-box).
  if ("strokesIncludedInLayout" in node && node.strokesIncludedInLayout) out.strokesInLayout = true;
  if (effects) out.effects = effects;

  if ("cornerRadius" in node) {
    if (node.cornerRadius !== figma.mixed && node.cornerRadius) out.radius = radiusOut(out, node.cornerRadius);
    else if (node.cornerRadius === figma.mixed) {
      // Per-corner fallback (pills/cards with asymmetric corners).
      const corners: RadiusCorners = {};
      for (const [k, s] of CORNER_KEYS) {
        const v = numProp(node, k);
        if (k in node && typeof v === "number" && v) corners[s] = radiusOut(out, v);
      }
      putNonEmpty(out, "radius", corners);
    }
  }
  if ("opacity" in node && node.opacity < 1) out.opacity = round(node.opacity);
  if ("rotation" in node && node.rotation) out.rotation = round(node.rotation);
  // Transform decomposition. `rotation` above covers the rotation term; this recovers the two parts
  // of relativeTransform that were being thrown away.
  if ("relativeTransform" in node && Array.isArray(node.relativeTransform) && node.relativeTransform.length === 2) {
    const m = node.relativeTransform;
    // [[a c e],[b d f]] — column-major 2x3 affine, per developers.figma.com.
    const a = m[0][0], c = m[0][1], b = m[1][0], d = m[1][1];
    // Mirror (negative-scale flip): the sign of the determinant.
    if (a * d - c * b < 0) out.flipped = true;
    // Shear (QR decomposition): after factoring out rotation+scale, a non-zero shear term is a SKEW.
    // Emitted in degrees, matching CSS `transform: skewX()`. A pure flip/rotation shears by 0, so
    // this stays absent on the overwhelming majority of nodes.
    const sx = Math.sqrt(a * a + b * b);
    if (sx > 1e-6) {
      const skewDeg = (Math.atan2(a * c + b * d, sx * sx) * 180) / Math.PI;
      if (Math.abs(skewDeg) > 0.01) out.skew = round(skewDeg);
    }
  }
  if ("blendMode" in node && node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") out.blendMode = node.blendMode.toLowerCase();
  if ("isMask" in node && node.isMask) out.mask = true;
  if (out.mask && "maskType" in node && node.maskType && node.maskType !== "ALPHA") out.maskType = String(node.maskType).toLowerCase(); // vector(clip-path) | luminance
  if ("cornerSmoothing" in node && typeof node.cornerSmoothing === "number" && node.cornerSmoothing) out.cornerSmoothing = round(node.cornerSmoothing); // squircle -> iOS "continuous" corners
  if ("targetAspectRatio" in node && node.targetAspectRatio && node.targetAspectRatio.y) out.aspectRatio = round(node.targetAspectRatio.x / node.targetAspectRatio.y); // locked ratio -> CSS aspect-ratio

  // Parametric shape intent. These node types flatten to SVG for rendering (assets.ts), but the raw
  // parameters preserve editable design intent codegen can act on (SVG arc/conic-gradient/dasharray,
  // clip-path, boolean mask). Read BEFORE the asset early-return below so they survive on asset leaves.
  if (node.type === "ELLIPSE" && node.arcData) {
    const a = node.arcData; // radians; innerRadius 0..1 (donut ratio)
    const isFull = (!a.startingAngle || a.startingAngle === 0) && Math.abs((a.endingAngle || 0) - Math.PI * 2) < 1e-4 && !a.innerRadius;
    if (!isFull) {
      const arc: NonNullable<IrNode["arc"]> = {};
      if (typeof a.startingAngle === "number") arc.start = round(a.startingAngle);
      if (typeof a.endingAngle === "number") arc.end = round(a.endingAngle);
      if (typeof a.innerRadius === "number" && a.innerRadius) arc.innerRadius = round(a.innerRadius); // >0 => donut/ring
      putNonEmpty(out, "arc", arc);
    }
  }
  if (node.type === "STAR") {
    const shape: NonNullable<IrNode["shape"]> = {};
    if (typeof node.pointCount === "number") shape.points = node.pointCount; // spikes, integer >= 3
    if (typeof node.innerRadius === "number") shape.innerRadius = round(node.innerRadius); // 0..1 acuteness
    putNonEmpty(out, "shape", shape);
  }
  if (node.type === "POLYGON" && typeof node.pointCount === "number") out.shape = { points: node.pointCount }; // 3=triangle, 6=hexagon
  if (node.type === "BOOLEAN_OPERATION" && node.booleanOperation) out.booleanOp = lower(node.booleanOperation); // union|intersect|subtract|exclude

  // The designer's OWN export presets — @2x/@3x/SVG and the intended asset filename suffix. This is
  // explicit intent about which nodes ship as assets and at what density, which nothing else in the
  // export carries. Compacted to format/suffix/scale; omitted entirely when the node has none.
  if ("exportSettings" in node && isList(node.exportSettings) && node.exportSettings.length) {
    out.exportSettings = node.exportSettings.map((es) => {
      const o: IrExportSetting = { format: String(es.format || "").toLowerCase() };
      if ("suffix" in es && es.suffix) o.suffix = es.suffix;
      const con = "constraint" in es ? es.constraint : undefined; // PDF settings carry none
      // SCALE 1 is the default and says nothing; WIDTH/HEIGHT constraints carry a pixel target.
      if (con && typeof con.value === "number" && !(con.type === "SCALE" && con.value === 1)) {
        o.constraint = { type: String(con.type || "").toLowerCase(), value: round(con.value) };
      }
      return o;
    });
  }

  // Node detached from a component — codegen should map it back rather than treat it as bespoke markup.
  if ("detachedInfo" in node && node.detachedInfo) {
    out.detachedFrom = node.detachedInfo.type === "library" ? { key: node.detachedInfo.componentKey } : { componentId: node.detachedInfo.componentId };
  }
  // Nested instances whose component props surface at THIS instance's top level (distinct wiring).
  if (node.type === "INSTANCE" && "exposedInstances" in node) {
    try {
      if (Array.isArray(node.exposedInstances) && node.exposedInstances.length) out.exposedInstances = node.exposedInstances.map((i) => i.id);
    } catch (e) {}
  }
  // Overlay frame settings — emit when the frame carries any non-default overlay configuration.
  if ("overlayPositionType" in node) {
    const hasScrim = node.overlayBackground && node.overlayBackground.type === "SOLID_COLOR" && node.overlayBackground.color;
    const closeOutside = node.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE";
    const posSet = node.overlayPositionType && node.overlayPositionType !== "CENTER";
    if (hasScrim || closeOutside || posSet) {
      const ov: IrOverlay = {};
      if (node.overlayPositionType) ov.position = node.overlayPositionType.toLowerCase();
      if (closeOutside) ov.closeOnClickOutside = true;
      if (hasScrim && node.overlayBackground.type === "SOLID_COLOR") ov.background = rgbaToHex(node.overlayBackground.color);
      out.overlay = ov;
    }
  }

  // TEXT_PATH (text on a curve) shares the TEXT characters/font surface.
  if (node.type === "TEXT" || node.type === "TEXT_PATH") Object.assign(out, await serializeText(node));

  // Which component prop drives this sublayer + how it diverges from its main component (sync reads).
  const propRefs = componentPropRefs(node);
  if (propRefs) out.propRefs = propRefs;
  const overrides = instanceOverrides(node);
  if (overrides) out.overrides = overrides;

  // Own-scope plugin data (opt-in).
  if (runOpts.pluginData) {
    const pd = pluginData(node);
    if (pd) out.pluginData = pd;
  }
  // Motion/animation keyframes & timelines (opt-in) — new free read plane (Plugin API Update 130).
  if (runOpts.motion) {
    const m = await collectMotion(node);
    if (m) out.motion = m;
  }
  // Cross-plugin shared data (opt-in) — e.g. Tokens Studio applied tokens.
  if (runOpts.sharedData) {
    const sd = sharedData(node);
    if (sd) out.sharedData = sd;
  }

  // These hit the Plugin API independently and write distinct keys — resolve concurrently.
  const [mainRef, tokens, styles, asset, reactions, varModes, css] = await Promise.all([
    instanceComponentRef(node),
    boundTokens(node),
    nodeStyles(node),
    collectAsset(node),
    simplifyReactions(node),
    variableModes(node),
    runOpts.css ? nodeCss(node) : Promise.resolve(undefined),
  ]);
  // out.component stays the bare name (byte-identical to before) for every existing consumer;
  // mainComponent is purely additive — the join keys (id/key/setId/setKey) back to the catalog.
  if (mainRef) { out.component = mainRef.name; out.mainComponent = mainRef; }
  if (tokens) out.tokens = tokens;
  if (styles) out.styles = styles;
  if (reactions) out.reactions = reactions;
  if (varModes) out.variableModes = varModes;
  // `resolvedModes` (the EFFECTIVE theme inherited from ancestors/page) is root-only, so it lives
  // with the other per-root enrichment in collect.ts — not behind a `depth === 0` branch in here.
  if (css) out.css = css;
  // NOTE: `inferredVariables` (Figma's guess at which token COULD apply to an unbound value) was
  // emitted here as `inferredTokens` and has been REMOVED. A live export measured it at 20.5% of the
  // whole payload — 2,151 occurrences — while the matches are pure value-coincidence (line-width
  // tokens suggested for `opacity`), and a repo-wide audit found ZERO consumers in profiles/, skills
  // or design-to-code/. Explicit bindings are in `tokens`; guesses are the codegen agent's job, not ours.
  // --no-assets suppressed a render that WOULD have produced an asset. Still a LEAF: the normal run
  // flattens this node to one SVG/PNG, so descending here would hand back a DIFFERENT tree than the
  // default export — the structural drift --no-assets promises not to cause. Flagged per-node (not
  // just counted in the manifest) so a consumer can tell "graphic omitted here" from "no graphic".
  if (asset && "skipped" in asset) {
    out.assetSkipped = true;
    return out;
  }
  if (asset && "geometry" in asset) {
    // exportAsync refused a node that genuinely paints something, so its resolved outlines stand in.
    // Still a LEAF, exactly as a successful export would be — the paths ARE the whole subtree.
    out.geometry = asset.geometry;
    return out;
  }
  if (asset) {
    out.asset = asset.path;
    return out; // asset nodes are leaves — skip children
  }

  // Tables expose NO `children` — cells are reached only via cellAt(r,c).
  if (node.type === "TABLE" && typeof node.numRows === "number" && typeof node.numColumns === "number") {
    // EVERY cell is an independent read, so the whole table resolves in one fan-out — row by row, a
    // 20x5 table still cost 20 serialized round-trip batches (and cell by cell, 200). The per-cell
    // try/catch keeps its exact scope: one unreadable cell is still dropped alone, not the row.
    // Nested Promise.all is still ONE fan-out: every cell promise is created before the first await.
    const grid = await Promise.all(
      Array.from({ length: node.numRows }, (_: unknown, r: number) => Promise.all(
        Array.from({ length: node.numColumns }, async (__: unknown, cc: number) => {
        try {
          const cell = node.cellAt(r, cc);
          if (!cell) return undefined;
          const co: TableCell = { row: r, col: cc };
          // Delegate the cell's text to serializeText rather than reading .characters by hand — a
          // hand-rolled read here would be a second, permanently-lagging copy of the text surface
          // (runs, font, per-run tokens and styles all silently missing inside tables).
          if (cell.text) Object.assign(co, await serializeText(cell.text));
          const cfills = await simplifyFills(cell.fills);
          if (cfills) co.fills = cfills;
          // NOTE: TableCellNode has NO rowSpan/columnSpan — Figma table cells cannot merge via the API.
          return co;
        } catch (e) { return undefined; }
        })
      ))
    );
    // Drop unreadable cells, then empty rows — exactly as the row-at-a-time version did.
    const rows = grid.map((row) => row.filter((c): c is TableCell => !!c)).filter((row) => row.length);
    if (rows.length) out.tableCells = rows;
  }

  // node.children is a Plugin-API getter that materializes a fresh array on each read — take it once.
  const children: readonly SceneNode[] | undefined = "children" in node ? node.children : undefined;
  if (children && children.length) {
    // An auto-layout or grid container positions its own children → they don't need x/y.
    const controlsChildren = "layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE";
    const kids: IrNode[] = [];
    for (const c of children) {
      const s = await serialize(c, depth + 1, controlsChildren);
      if (s) kids.push(s);
    }
    if (kids.length) out.children = kids;
  }
  return out;
}
