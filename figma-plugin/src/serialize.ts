// The recursive node serializer: one SceneNode -> compact JSON. Orchestrates the typed helper
// modules. Reads are defensive (`"x" in node` guards) because it runs over the whole SceneNode
// union; per-property values are typed inside the helpers it calls.
import { Obj, round, propName, rgbaToHex, nonEmpty } from "./util";
import { stats, warn, runOpts } from "./state";
import { layout, GRID_SELF, simplifyGrid } from "./layout";
import { simplifyFills, simplifyStrokes } from "./paint";
import { simplifyEffects } from "./effects";
import { serializeText } from "./text";
import { boundTokens, nodeStyles, variableModes, resolveVar, resolveBoundMap } from "./variables";
import { simplifyReactions } from "./prototype";
import { collectAsset } from "./assets";
import { instanceComponent, componentPropRefs, instanceOverrides } from "./components";
import { collectMotion } from "./motion";

const MAX_DEPTH = 60;

// Enum reads that are all "if present and not the default, emit lowercased" — table-driven so a new
// Figma enum property is one row rather than another hand-derived guard line.
// [ node field, output key, value to treat as the default and skip ]
const LOWER_ENUMS: Array<[string, string, string?]> = [
  ["layoutAlign", "alignSelf", "INHERIT"],
  ["layoutSizingHorizontal", "widthMode"],
  ["layoutSizingVertical", "heightMode"],
  ["overflowDirection", "scroll", "NONE"],
];
// Same shape, but mapped through GRID_SELF (MIN/CENTER/MAX -> start/center/end) instead of lowercased.
const GRID_SELF_ENUMS: Array<[string, string]> = [
  ["gridChildHorizontalAlign", "gridJustifySelf"],
  ["gridChildVerticalAlign", "gridAlignSelf"],
];
// Hoisted: these were fresh arrays allocated on EVERY node, the vast majority of which have neither
// size limits nor mixed corner radii.
const SIZE_LIMIT_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
const CORNER_KEYS: Array<[string, string]> = [
  ["topLeftRadius", "tl"],
  ["topRightRadius", "tr"],
  ["bottomRightRadius", "br"],
  ["bottomLeftRadius", "bl"],
];

// inferredVariables: Figma's own suggestions of which token COULD apply to a raw value. Only emit
// for fields with no explicit binding (explicit wins) — otherwise it's pure noise. Free tokenization
// hints for design-to-code (map a hardcoded #3B82F6 back to color/primary).
async function resolveInferred(node: SceneNode, alreadyBound: Obj | undefined): Promise<Obj | undefined> {
  const inf = (node as any).inferredVariables;
  if (!inf || typeof inf !== "object") return undefined;
  const out: Obj = {};
  for (const field of Object.keys(inf)) {
    if (alreadyBound && field in alreadyBound) continue; // explicit binding wins
    let candidates: any = inf[field];
    // fills/strokes are VariableAlias[][] (per-paint arrays of candidates); flatten one level.
    if (Array.isArray(candidates) && Array.isArray(candidates[0])) candidates = candidates.flat();
    if (!Array.isArray(candidates)) candidates = [candidates];
    const names = (await Promise.all(candidates.map((a: any) => resolveVar(a)))).filter(Boolean);
    if (names.length) out[field] = names.length === 1 ? names[0] : names;
  }
  return nonEmpty(out);
}

// Own-scope plugin data (getPluginData) written by THIS plugin — round-trip metadata (e.g. a future
// Code-Connect mapping our write plane stamps). Shared namespaces can't be enumerated by the API, so
// only own-scope keys are read. Opt-in via runOpts.pluginData.
function pluginData(node: BaseNode): Obj | undefined {
  const n = node as any;
  if (typeof n.getPluginDataKeys !== "function") return undefined;
  let keys: string[] = [];
  try { keys = n.getPluginDataKeys(); } catch (e) { return undefined; }
  if (!keys || !keys.length) return undefined;
  const out: Obj = {};
  for (const k of keys) {
    try { const v = n.getPluginData(k); if (v) out[k] = v; } catch (e) {}
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
function sharedData(node: BaseNode): Obj | undefined {
  const n = node as any;
  if (typeof n.getSharedPluginDataKeys !== "function" || typeof n.getSharedPluginData !== "function") return undefined;
  const out: Obj = {};
  for (const ns of SHARED_NAMESPACES) {
    let keys: string[] = [];
    try { keys = n.getSharedPluginDataKeys(ns) || []; } catch (e) { continue; }
    const bucket: Obj = {};
    for (const k of keys) {
      try { const v = n.getSharedPluginData(ns, k); if (v) bucket[k] = v; } catch (e) {}
    }
    if (Object.keys(bucket).length) out[ns] = bucket;
  }
  return nonEmpty(out);
}

// Figma's OWN computed CSS for the node — the oracle the paid get_design_context leans on. One async
// call per node, so opt-in via runOpts.css. Ground truth for a codegen self-correction loop.
async function nodeCss(node: SceneNode): Promise<Obj | undefined> {
  const n = node as any;
  if (typeof n.getCSSAsync !== "function") return undefined;
  try {
    const css = await n.getCSSAsync();
    return css && Object.keys(css).length ? css : undefined;
  } catch (e) {
    return undefined;
  }
}

export async function serialize(node: SceneNode, depth: number, parentControlsLayout?: boolean): Promise<Obj | null> {
  if (depth > MAX_DEPTH) {
    stats.truncated++;
    if (stats.truncated === 1) warn("depth limit " + MAX_DEPTH + " reached — deep subtrees truncated (first: " + node.name + ")");
    return null;
  }
  stats.nodes++;
  const n = node as any;
  // Hidden nodes are KEPT (flagged) — hidden variant states (error toasts, tooltips, empty states)
  // are part of the design and must be implementable; codegen decides render vs display:none.
  const out: Obj = { type: node.type, name: node.name, id: node.id };
  if (n.visible === false) out.hidden = true;

  if (node.type === "INSTANCE" && node.componentProperties) {
    const props: Obj = {};
    const propTokens: Obj = {}; // a BOOLEAN/TEXT prop whose value is driven by a variable (token link)
    const keys = Object.keys(node.componentProperties);
    // One await for the whole prop set rather than one per property — the bindings are independent.
    const bound = await Promise.all(keys.map((k) => resolveBoundMap((node.componentProperties as any)[k].boundVariables)));
    keys.forEach((k, i) => {
      props[propName(k)] = (node.componentProperties as any)[k].value;
      const bv = bound[i];
      if (bv && bv.value) propTokens[propName(k)] = bv.value;
    });
    if (Object.keys(props).length) out.props = props;
    if (Object.keys(propTokens).length) out.propTokens = propTokens;
  }
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") out.component = node.name;

  const lay = layout(node);
  if (lay) out.layout = lay;

  // Child-in-parent layout role (out of auto-layout flow / grows to fill).
  const absoluteInParent = "layoutPositioning" in node && n.layoutPositioning === "ABSOLUTE";
  if (absoluteInParent) out.absolute = true;
  if ("layoutGrow" in node && n.layoutGrow) out.grow = n.layoutGrow;

  // Child sizing intent (FILL/HUG/FIXED), counter-axis alignment, scroll direction — see LOWER_ENUMS.
  for (const [field, key, skip] of LOWER_ENUMS) {
    const v = n[field];
    if (typeof v === "string" && v && v !== skip) out[key] = v.toLowerCase();
  }

  // Grid child placement — span across tracks AND the starting (anchor) cell.
  if ("gridColumnSpan" in node && typeof n.gridColumnSpan === "number" && n.gridColumnSpan !== 1) out.gridColumnSpan = n.gridColumnSpan;
  if ("gridRowSpan" in node && typeof n.gridRowSpan === "number" && n.gridRowSpan !== 1) out.gridRowSpan = n.gridRowSpan;
  if ("gridColumnAnchorIndex" in node && typeof n.gridColumnAnchorIndex === "number") out.gridColumnStart = n.gridColumnAnchorIndex; // 0-based track index
  if ("gridRowAnchorIndex" in node && typeof n.gridRowAnchorIndex === "number") out.gridRowStart = n.gridRowAnchorIndex;
  for (const [field, key] of GRID_SELF_ENUMS) {
    const v = n[field];
    if (v && v !== "AUTO") out[key] = GRID_SELF[v];
  }

  // Position — only when the parent does NOT auto-position this node.
  if ((!parentControlsLayout || absoluteInParent) && "x" in node && typeof n.x === "number") {
    out.x = round(n.x);
    out.y = round(n.y);
  }

  // Resolved page-space box — the ground-truth pixel size. `renderBox` adds stroke/shadow/blur extent,
  // emitted only when it actually differs from the layout box.
  if ("absoluteBoundingBox" in node && n.absoluteBoundingBox) {
    const b = n.absoluteBoundingBox;
    out.box = { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height) };
    const rb = n.absoluteRenderBounds;
    if (rb && (rb.x !== b.x || rb.y !== b.y || rb.width !== b.width || rb.height !== b.height)) {
      out.renderBox = { x: round(rb.x), y: round(rb.y), w: round(rb.width), h: round(rb.height) };
    }
  }

  // Per-frame layout grids (responsive column/row grids).
  if ("layoutGrids" in node && Array.isArray(n.layoutGrids) && n.layoutGrids.length) {
    out.layoutGrids = n.layoutGrids.map(simplifyGrid).filter(Boolean);
  }

  // Dev Mode handoff — FREE via the Plugin API and NOT surfaced by the paid REST/get_design_context.
  if ("annotations" in node && Array.isArray(n.annotations) && n.annotations.length) {
    out.annotations = n.annotations.map((a: any) => {
      const o: Obj = {};
      if (a.label) o.label = a.label;
      if (a.labelMarkdown) o.markdown = a.labelMarkdown;
      if (a.categoryId) o.categoryId = a.categoryId; // groups annotations by Dev-Mode category
      if (Array.isArray(a.properties) && a.properties.length) o.props = a.properties.map((p: any) => p.type);
      return o;
    });
  }
  if ("devStatus" in node && n.devStatus && n.devStatus.type) {
    out.devStatus = n.devStatus.type.toLowerCase(); // ready_for_dev | completed
    if (n.devStatus.description) out.devStatusNote = n.devStatus.description; // free-text handoff note
  }

  // Min/max size (responsive auto-layout constraints). Allocated lazily — most nodes have none.
  let sizeLimits: Obj | undefined;
  for (const k of SIZE_LIMIT_KEYS) {
    if (k in node && typeof n[k] === "number") (sizeLimits || (sizeLimits = {}))[k] = round(n[k]);
  }
  if (sizeLimits) out.sizeLimits = sizeLimits;

  // Pin constraints (how a non-auto-layout child resizes with its parent).
  if ("constraints" in node && n.constraints && (n.constraints.horizontal !== "MIN" || n.constraints.vertical !== "MIN")) {
    out.pin = { h: n.constraints.horizontal.toLowerCase(), v: n.constraints.vertical.toLowerCase() };
  }

  // Clip — the difference between a ScrollView and a fixed frame (critical on mobile). The matching
  // `scroll` (overflowDirection) read is table-driven above.
  if ("clipsContent" in node && n.clipsContent) out.clip = true;

  const fills = await simplifyFills("fills" in node ? n.fills : undefined);
  if (fills) out.fills = fills;

  const strokes = await simplifyStrokes(node);
  if (strokes) out.strokes = strokes;
  // Whether stroke weight counts toward auto-layout size (border-box vs content-box).
  if ("strokesIncludedInLayout" in node && n.strokesIncludedInLayout) out.strokesInLayout = true;

  const effects = await simplifyEffects("effects" in node ? n.effects : undefined);
  if (effects) out.effects = effects;

  if ("cornerRadius" in node) {
    if (n.cornerRadius !== figma.mixed && n.cornerRadius) out.radius = n.cornerRadius;
    else if (n.cornerRadius === figma.mixed) {
      // Per-corner fallback (pills/cards with asymmetric corners).
      const corners: Obj = {};
      for (const [k, s] of CORNER_KEYS) {
        if (k in node && typeof n[k] === "number" && n[k]) corners[s] = n[k];
      }
      if (Object.keys(corners).length) out.radius = corners;
    }
  }
  if ("opacity" in node && n.opacity < 1) out.opacity = round(n.opacity);
  if ("rotation" in node && n.rotation) out.rotation = round(n.rotation);
  // Mirror (negative-scale flip): detect from the sign of the relativeTransform determinant.
  if ("relativeTransform" in node && Array.isArray(n.relativeTransform) && n.relativeTransform.length === 2) {
    const m = n.relativeTransform;
    const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    if (det < 0) out.flipped = true;
  }
  if ("blendMode" in node && n.blendMode && n.blendMode !== "NORMAL" && n.blendMode !== "PASS_THROUGH") out.blendMode = n.blendMode.toLowerCase();
  if ("isMask" in node && n.isMask) out.mask = true;
  if (out.mask && "maskType" in node && n.maskType && n.maskType !== "ALPHA") out.maskType = String(n.maskType).toLowerCase(); // vector(clip-path) | luminance
  if ("cornerSmoothing" in node && typeof n.cornerSmoothing === "number" && n.cornerSmoothing) out.cornerSmoothing = round(n.cornerSmoothing); // squircle -> iOS "continuous" corners
  if ("targetAspectRatio" in node && n.targetAspectRatio && n.targetAspectRatio.y) out.aspectRatio = round(n.targetAspectRatio.x / n.targetAspectRatio.y); // locked ratio -> CSS aspect-ratio

  // Parametric shape intent. These node types flatten to SVG for rendering (assets.ts), but the raw
  // parameters preserve editable design intent codegen can act on (SVG arc/conic-gradient/dasharray,
  // clip-path, boolean mask). Read BEFORE the asset early-return below so they survive on asset leaves.
  if (node.type === "ELLIPSE" && n.arcData) {
    const a = n.arcData; // radians; innerRadius 0..1 (donut ratio)
    const isFull = (!a.startingAngle || a.startingAngle === 0) && Math.abs((a.endingAngle || 0) - Math.PI * 2) < 1e-4 && !a.innerRadius;
    if (!isFull) {
      const arc: Obj = {};
      if (typeof a.startingAngle === "number") arc.start = round(a.startingAngle);
      if (typeof a.endingAngle === "number") arc.end = round(a.endingAngle);
      if (typeof a.innerRadius === "number" && a.innerRadius) arc.innerRadius = round(a.innerRadius); // >0 => donut/ring
      if (Object.keys(arc).length) out.arc = arc;
    }
  }
  if (node.type === "STAR") {
    const shape: Obj = {};
    if (typeof n.pointCount === "number") shape.points = n.pointCount; // spikes, integer >= 3
    if (typeof n.innerRadius === "number") shape.innerRadius = round(n.innerRadius); // 0..1 acuteness
    if (Object.keys(shape).length) out.shape = shape;
  }
  if (node.type === "POLYGON" && typeof n.pointCount === "number") out.shape = { points: n.pointCount }; // 3=triangle, 6=hexagon
  if (node.type === "BOOLEAN_OPERATION" && n.booleanOperation) out.booleanOp = String(n.booleanOperation).toLowerCase(); // union|intersect|subtract|exclude

  // Node detached from a component — codegen should map it back rather than treat it as bespoke markup.
  if ("detachedInfo" in node && n.detachedInfo) {
    out.detachedFrom = n.detachedInfo.type === "library" ? { key: n.detachedInfo.componentKey } : { componentId: n.detachedInfo.componentId };
  }
  // Nested instances whose component props surface at THIS instance's top level (distinct wiring).
  if (node.type === "INSTANCE" && "exposedInstances" in node) {
    try {
      if (Array.isArray(n.exposedInstances) && n.exposedInstances.length) out.exposedInstances = n.exposedInstances.map((i: any) => i.id);
    } catch (e) {}
  }
  // Overlay frame settings — emit when the frame carries any non-default overlay configuration.
  if ("overlayPositionType" in node) {
    const hasScrim = n.overlayBackground && n.overlayBackground.type === "SOLID_COLOR" && n.overlayBackground.color;
    const closeOutside = n.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE";
    const posSet = n.overlayPositionType && n.overlayPositionType !== "CENTER";
    if (hasScrim || closeOutside || posSet) {
      const ov: Obj = {};
      if (n.overlayPositionType) ov.position = n.overlayPositionType.toLowerCase();
      if (closeOutside) ov.closeOnClickOutside = true;
      if (hasScrim) ov.background = rgbaToHex(n.overlayBackground.color);
      out.overlay = ov;
    }
  }

  // TEXT_PATH (text on a curve) shares the TEXT characters/font surface.
  if (node.type === "TEXT" || node.type === "TEXT_PATH") Object.assign(out, await serializeText(node as TextNode | TextPathNode));

  // Which component prop drives this sublayer + how it diverges from its main component (sync reads).
  const propRefs = componentPropRefs(node);
  if (propRefs) out.propRefs = propRefs;
  const overrides = instanceOverrides(node);
  if (overrides) out.overrides = overrides;

  // Own-scope plugin data (opt-in) + inferred token suggestions.
  if (runOpts.pluginData) {
    const pd = pluginData(node);
    if (pd) out.pluginData = pd;
  }
  // Motion/animation keyframes & timelines (opt-in) — new free read plane (Plugin API Update 130).
  if (runOpts.motion) {
    const m = collectMotion(node);
    if (m) out.motion = m;
  }
  // Cross-plugin shared data (opt-in) — e.g. Tokens Studio applied tokens.
  if (runOpts.sharedData) {
    const sd = sharedData(node);
    if (sd) out.sharedData = sd;
  }

  // These hit the Plugin API independently and write distinct keys — resolve concurrently.
  const [componentName, tokens, styles, asset, reactions, varModes, css] = await Promise.all([
    instanceComponent(node),
    boundTokens(node),
    nodeStyles(node),
    collectAsset(node),
    simplifyReactions(node),
    variableModes(node),
    runOpts.css ? nodeCss(node) : Promise.resolve(undefined),
  ]);
  if (componentName) out.component = componentName;
  if (tokens) out.tokens = tokens;
  if (styles) out.styles = styles;
  if (reactions) out.reactions = reactions;
  if (varModes) out.variableModes = varModes;
  // `resolvedModes` (the EFFECTIVE theme inherited from ancestors/page) is root-only, so it lives
  // with the other per-root enrichment in collect.ts — not behind a `depth === 0` branch in here.
  if (css) out.css = css;
  // Inferred token suggestions for fields with no explicit binding (after `tokens` is known).
  const inferred = await resolveInferred(node, tokens);
  if (inferred) out.inferredTokens = inferred;
  if (asset) {
    out.asset = asset;
    return out; // asset nodes are leaves — skip children
  }

  // Tables expose NO `children` — cells are reached only via cellAt(r,c).
  if (node.type === "TABLE" && typeof n.numRows === "number" && typeof n.numColumns === "number") {
    const rows: Obj[][] = [];
    for (let r = 0; r < n.numRows; r++) {
      const row: Obj[] = [];
      for (let cc = 0; cc < n.numColumns; cc++) {
        try {
          const cell = n.cellAt(r, cc);
          if (!cell) continue;
          const co: Obj = { row: r, col: cc };
          // Delegate the cell's text to serializeText rather than reading .characters by hand — a
          // hand-rolled read here would be a second, permanently-lagging copy of the text surface
          // (runs, font, per-run tokens and styles all silently missing inside tables).
          if (cell.text) Object.assign(co, await serializeText(cell.text as TextNode));
          const cfills = await simplifyFills(cell.fills);
          if (cfills) co.fills = cfills;
          // NOTE: TableCellNode has NO rowSpan/columnSpan — Figma table cells cannot merge via the API.
          row.push(co);
        } catch (e) {}
      }
      if (row.length) rows.push(row);
    }
    if (rows.length) out.tableCells = rows;
  }

  // node.children is a Plugin-API getter that materializes a fresh array on each read — take it once.
  const children: SceneNode[] | undefined = "children" in node ? n.children : undefined;
  if (children && children.length) {
    // An auto-layout or grid container positions its own children → they don't need x/y.
    const controlsChildren = "layoutMode" in node && n.layoutMode && n.layoutMode !== "NONE";
    const kids: Obj[] = [];
    for (const c of children) {
      const s = await serialize(c, depth + 1, controlsChildren);
      if (s) kids.push(s);
    }
    if (kids.length) out.children = kids;
  }
  return out;
}
