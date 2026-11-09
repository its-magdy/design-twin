// outline.ts — a screen export as one line per node, small enough to read inline.
//
// The interface is one function: screenOutline(source, { limit, more }) → the richest level that fits `limit`,
// or null when not even the section list does. The levels, the hoisted tables and what each level may leave out are
// all decided here; a caller only says how much room there is and how a reader gets more.
//
//   full      every node on a line: identity, size, layout, component, text, fonts, paints, tokens, styles
//   layout    structure only: identity, size, layout, component, the first characters of the text
//   sections  the screen's top-level sections with their ids, to read one at a time
//
// The JSON export stays the source of truth, and this view must never read as if it were all of it. So:
//   - NODE_FIELDS names, for every IrNode field, the level from which it is on the line. It is a Record over
//     `keyof IrNode`, so a field added to the IR fails to compile here until someone decides;
//   - whatever a level leaves out is counted per field in the "Not shown" line, an unknown field from a newer
//     plugin included, so a binding is either on the line or named as missing;
//   - the manifest's truncation counts and warnings are in the header at every level.
//
// Pure: no filesystem, no clock, no bridge. Dependency-free but for the IR types.
import type { IrNode, LayoutSpec, Paint, ScreenExport, Strokes, FontSpec, TextRun } from "./doc-types.ts";

export type OutlineLevel = "full" | "layout" | "sections";
const LADDER: readonly OutlineLevel[] = ["full", "layout", "sections"];

export interface OutlineSource {
  screen: Pick<ScreenExport, "nodes"> & Partial<ScreenExport>;
  screenName?: string | undefined;
  sourceFile?: string | undefined;
  /** How many variables the export's token slice holds (their values are not in the outline). */
  variableCount?: number | undefined;
  /** How many assets the reply lists. */
  assetCount?: number | undefined;
}

export interface OutlineOptions {
  /** The most characters the text may take (UTF-16 code units, the unit inlineLimitChars is in). */
  limit: number;
  /** The sentence that tells a reader how to get more, for the level returned. */
  more: (level: OutlineLevel) => string;
  /** How long the read took, for the header. */
  durationMs?: number | undefined;
}

export interface Outline { level: OutlineLevel; text: string }

// From which level a field is on the line: "layout" (layout and full), "full" (full only), "never" (counted in the
// "Not shown" line at every level). Heavy or per-renderer fields are "never": they are the JSON's job.
type Shown = "layout" | "full" | "never";
const NODE_FIELDS: Record<keyof IrNode, Shown> = {
  type: "layout", name: "layout", id: "layout", children: "layout", hidden: "layout",
  // identity
  props: "layout", propTokens: "full", component: "layout", mainComponent: "layout", propRefs: "full", overrides: "never",
  exposedInstances: "full", detachedFrom: "full",
  // geometry + layout
  x: "layout", y: "layout", box: "layout", renderBox: "never", layout: "layout", layoutGrids: "never", absolute: "layout",
  grow: "layout", alignSelf: "layout", widthMode: "layout", heightMode: "layout", scroll: "layout",
  gridColumnSpan: "layout", gridRowSpan: "layout", gridColumnStart: "layout", gridRowStart: "layout",
  gridJustifySelf: "layout", gridAlignSelf: "layout", sizeLimits: "layout", pin: "layout", fixedChildren: "layout", clip: "layout",
  // visuals
  fills: "full", strokes: "full", strokesInLayout: "full", effects: "full", radius: "full", radiusFull: "full", opacity: "full",
  rotation: "full", flipped: "full", skew: "full", blendMode: "full", mask: "full", maskType: "full", cornerSmoothing: "full",
  aspectRatio: "full", arc: "full", shape: "full", booleanOp: "full", exportSettings: "full", overlay: "full",
  // bindings + handoff
  tokens: "full", styles: "full", reactions: "never", variableModes: "full", resolvedModes: "full", annotations: "full",
  devStatus: "full", devStatusNote: "full",
  // opt-in reads
  css: "never", pluginData: "never", sharedData: "never", motion: "never",
  // assets
  asset: "full", assetSkipped: "layout", assetFrom: "full", sourceTransform: "full", geometry: "never", tableCells: "never",
  reference: "full", devResources: "never",
  // text
  text: "layout", runs: "full", font: "full", textTokens: "full", href: "full", linkNode: "full", list: "full", indent: "full",
  textStyleOverrides: "full", autoResize: "full", truncate: "full", maxLines: "full", missingFont: "full",
};

// The fields with a renderer of their own below; every other shown field prints as `key=value`.
const SPECIAL = new Set(["type", "name", "id", "children", "x", "y", "box", "widthMode", "heightMode", "layout", "component", "mainComponent", "props",
  "text", "runs", "font", "fills", "strokes", "effects", "tokens", "styles", "radius", "opacity", "asset"]);
// Fields a section row shows itself, so its "Not shown" line does not list them.
const SECTION_ROW = new Set(["type", "name", "id", "children", "box", "text"]);
const LAYOUT_TEXT_CHARS = 40;
const AUTO_NAME = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Text|Instance|Component|Polygon|Star|Slice|Section) \d+$/;

const isShownAt = (key: string, level: OutlineLevel): boolean => {
  const at = (NODE_FIELDS as Record<string, Shown | undefined>)[key];
  return at === "layout" ? level !== "sections" : at === "full" ? level === "full" : false;
};

/** A value on one line: bare where that is unambiguous, quoted otherwise. */
function flow(v: unknown): string {
  // `:` separates an object's key from its value, and a bare true / 12 would read as a boolean or a number.
  if (typeof v === "string") return /^[\w#./%-]+$/.test(v) && !/^(true|false|null|-?[\d.]+)$/.test(v) ? v : JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(flow).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => flow(k) + ":" + flow(x)).join(",") + "}";
  return String(v);
}

// One piece of a line: plain text, or a value worth hoisting into a table when it repeats.
type Part = string | { kind: string; value: string };
interface Row { depth: number; parts: Part[] }

function layoutValue(l: LayoutSpec, box: IrNode["box"]): string {
  const { display, flexDirection, gap, padding, justifyContent, alignItems, mode, width, height, ...sized } = l;
  // An absolute frame's own width/height repeat its box, which is already on the line.
  const rest = { ...sized, ...(width !== undefined && width !== box?.w ? { width } : {}), ...(height !== undefined && height !== box?.h ? { height } : {}) };
  const out: string[] = [];
  if (mode === "absolute") out.push("abs");
  if (display === "grid") out.push("grid");
  else if (display === "flex") out.push(flexDirection === "column" ? "col" : "row");
  if (gap !== undefined) out.push("gap=" + gap);
  if (padding) out.push("p=" + (padding.every((p) => p === padding[0]) ? String(padding[0]) : padding.join(",")));
  if (justifyContent) out.push("jc=" + justifyContent);
  if (alignItems) out.push("ai=" + alignItems);
  const more = Object.entries(rest).filter(([, x]) => x !== undefined);
  if (more.length) out.push(flow(Object.fromEntries(more)));
  return out.join(" ");
}

function fontValue(f: FontSpec, dropColor: string | undefined): string {
  const { family, weight, size, lineHeight, letterSpacing, color, ...rest } = f;
  const out = [[family, weight, size].filter((x) => x !== undefined).map((x) => (typeof x === "string" && x.includes(" ") ? JSON.stringify(x) : x)).join("/")];
  if (lineHeight) out.push("lh=" + (lineHeight.value ?? "") + lineHeight.unit);
  if (letterSpacing) out.push("ls=" + (letterSpacing.value ?? "") + letterSpacing.unit);
  if (color !== undefined && color !== dropColor) out.push("color=" + color);
  if (Object.keys(rest).length) out.push(flow(rest));
  return out.join(" ");
}

function paintValue(p: Paint): string {
  if (p.type !== "solid") return flow(p);
  const { color, tokens, type: _solid, ...rest } = p;
  return color + (tokens ? flow(tokens) : "") + (Object.keys(rest).length ? flow(rest) : "");
}

const firstSolid = (paints: Paint[] | undefined): string | undefined => {
  const p = paints && paints[0];
  return p && p.type === "solid" ? p.color : undefined;
};

// The node's own `tokens`, less what a paint on this line already says (`tokens.fills` beside the fill's own token).
function tokensValue(n: IrNode): string | null {
  if (!n.tokens) return null;
  const { fills, ...rest } = n.tokens;
  const first = n.fills && n.fills[0];
  const said = first && first.tokens ? first.tokens["color"] : undefined;
  const keep = fills !== undefined && fills !== said ? { fills, ...rest } : rest;
  return Object.keys(keep).length ? flow(keep) : null;
}

function strokesValue(s: Strokes): string {
  const { colors, weight, align, ...rest } = s;
  const out: string[] = [];
  if (colors) out.push(colors.join("+"));
  if (weight !== undefined) out.push("w" + weight);
  if (align) out.push(align);
  if (Object.keys(rest).length) out.push(flow(rest));
  return out.join(" ");
}

const runPart = (run: TextRun, dropColor: string | undefined): Part[] => {
  const { text, font, ...rest } = run;
  return [JSON.stringify(text), { kind: "F", value: fontValue(font, dropColor) }, ...(Object.keys(rest).length ? [flow(rest)] : [])];
};

const countNodes = (n: IrNode): number => 1 + (n.children ?? []).reduce((a, c) => a + countNodes(c), 0);
const sizeOf = (n: IrNode): string => (n.box ? `${n.box.w}x${n.box.h}` : "");

function nameOf(n: IrNode): string | null {
  if (!n.name || AUTO_NAME.test(n.name) || (n.type === "TEXT" && n.name === n.text)) return null;
  return JSON.stringify(n.name);
}

function nodeParts(n: IrNode, level: OutlineLevel): Part[] {
  const parts: Part[] = ["[" + n.type + "]"];
  const name = nameOf(n);
  if (name) parts.push(name);
  parts.push("#" + n.id);
  if (n.box) parts.push(sizeOf(n));
  if (n.x !== undefined || n.y !== undefined) parts.push(`@${n.x ?? 0},${n.y ?? 0}`);
  if (n.widthMode) parts.push("w=" + n.widthMode);
  if (n.heightMode) parts.push("h=" + n.heightMode);
  if (n.layout) parts.push({ kind: "L", value: layoutValue(n.layout, n.box) });

  if (n.mainComponent) {
    // The layout form keeps the publish keys: they are what joins this instance back to the component catalog.
    const { name, setName, key, setKey } = n.mainComponent;
    parts.push("→", { kind: "M", value: level === "full" ? flow(n.mainComponent) : flow(name) + (setName ? " of " + flow(setName) : "") + (key ? " key=" + key : "") + (setKey ? " setKey=" + setKey : "") });
  }
  // `component` repeats mainComponent.name on an instance; on a COMPONENT it is the only place it is said.
  if (n.component !== undefined && n.component !== n.mainComponent?.name) parts.push("component=" + flow(n.component));
  if (n.props) parts.push(flow(n.props));

  if (level === "full") {
    const color = firstSolid(n.fills);
    if (n.runs) parts.push("runs:", ...n.runs.flatMap((r, i) => [...(i ? ["|"] : []), ...runPart(r, undefined)]));
    else if (n.text !== undefined) parts.push(JSON.stringify(n.text));
    if (n.font) parts.push({ kind: "F", value: fontValue(n.font, n.type === "TEXT" ? color : undefined) });
    if (n.fills && n.fills.length) parts.push("fill=", { kind: "C", value: n.fills.map(paintValue).join("+") });
    if (n.strokes) parts.push("stroke=", { kind: "S", value: strokesValue(n.strokes) });
    if (n.effects && n.effects.length) parts.push("fx=", { kind: "E", value: flow(n.effects) });
    if (n.radius !== undefined) parts.push("r=" + flow(n.radius));
    if (n.opacity !== undefined) parts.push("o=" + n.opacity);
    const tokens = tokensValue(n);
    if (tokens) parts.push("tokens=", { kind: "T", value: tokens });
    if (n.styles) parts.push("styles=", { kind: "Y", value: flow(n.styles) });
    if (n.asset !== undefined) parts.push("asset=" + flow(n.asset));
  } else if (n.text !== undefined) {
    const more = n.text.length - LAYOUT_TEXT_CHARS;
    parts.push(JSON.stringify(more > 0 ? n.text.slice(0, LAYOUT_TEXT_CHARS) : n.text) + (more > 0 ? `…+${more}` : ""));
  }

  for (const [key, value] of Object.entries(n)) {
    if (SPECIAL.has(key) || value === undefined || !isShownAt(key, level)) continue;
    parts.push(value === true ? key : key + "=" + flow(value));
  }
  return parts;
}

/** Every field of `n` not on its line at this level, added to `missing`. */
function countMissing(n: IrNode, level: OutlineLevel, missing: Map<string, number>): void {
  for (const [key, value] of Object.entries(n)) {
    if (value === undefined || isShownAt(key, level) || (level === "sections" && SECTION_ROW.has(key))) continue;
    missing.set(key, (missing.get(key) ?? 0) + 1);
  }
}

// Replaces a value that repeats with a table row, when that is shorter overall. A value used once stays on its line.
function hoist(rows: Row[]): { table: string[]; lines: string[] } {
  const counts = new Map<string, { kind: string; value: string; n: number }>();
  for (const r of rows) {
    for (const p of r.parts) {
      if (typeof p === "string") continue;
      const k = p.kind + "\0" + p.value;
      const had = counts.get(k);
      if (had) had.n++;
      else counts.set(k, { kind: p.kind, value: p.value, n: 1 });
    }
  }
  const perKind = new Map<string, number>();
  const refs = new Map<string, string>();
  const table: string[] = [];
  for (const [k, e] of [...counts].sort((a, b) => b[1].n - a[1].n)) {
    const ref = "$" + e.kind + ((perKind.get(e.kind) ?? 0) + 1);
    // Inline costs n * value; hoisted costs one table row plus n refs.
    if (e.n < 2 || e.n * e.value.length <= e.value.length + (e.n + 1) * ref.length + 2) continue;
    perKind.set(e.kind, (perKind.get(e.kind) ?? 0) + 1);
    refs.set(k, ref);
    table.push(ref + " " + e.value);
  }
  const lines = rows.map((r) => {
    let line = "  ".repeat(r.depth);
    let glue = false;
    for (const p of r.parts) {
      const s = typeof p === "string" ? p : (refs.get(p.kind + "\0" + p.value) ?? p.value);
      // `fill=` and its value are one token on the line.
      line += (glue ? "" : line.trimEnd() === "" ? "" : " ") + s;
      glue = typeof p === "string" && p.endsWith("=");
    }
    return line;
  });
  return { table, lines };
}

// The section list's parents: the roots, or, while a root is only a wrapper around one child, that child.
function sectionsOf(roots: IrNode[]): IrNode[] {
  let list = roots;
  while (list.length === 1 && list[0]?.children?.length) list = list[0].children;
  return list;
}

function firstText(n: IrNode): string | null {
  if (n.text) return n.text;
  for (const c of n.children ?? []) {
    const t = firstText(c);
    if (t) return t;
  }
  return null;
}

function header(src: OutlineSource, level: OutlineLevel, opts: OutlineOptions, capWarnings: boolean): string[] {
  const s = src.screen;
  const root = s.nodes[0];
  const m = s.manifest;
  const id = s.nodeId ?? root?.id;
  const out = [
    `OUTLINE level=${level} (of ${LADDER.join(" > ")})` + (src.screenName ? ` screen=${JSON.stringify(src.screenName)}` : "") + (id ? ` #${id}` : "") +
      (s.page ? ` page=${JSON.stringify(s.page)}` : "") + (src.sourceFile ? ` file=${JSON.stringify(src.sourceFile)}` : "") +
      (m ? ` nodes=${m.nodes}` : "") + (opts.durationMs !== undefined ? ` durationMs=${opts.durationMs}` : ""),
    "More: " + opts.more(level),
  ];
  if (root?.reference) out.push("Reference image: " + root.reference);
  if (m) {
    const counted = ([["truncated", m.truncated], ["assetsFailed", m.assetsFailed], ["assetsGeometry", m.assetsGeometry], ["assetsSkipped", m.assetsSkipped],
      ["assetsSkippedInvisible", m.assetsSkippedInvisible], ["assetsHidden", m.assetsHidden ?? 0], ["hiddenNodes", m.hiddenNodes ?? 0]] as const).filter(([, n]) => n > 0);
    if (counted.length) out.push("Truncation and failures: " + counted.map(([k, n]) => `${k}=${n}`).join(" ") + (m.truncated > 0 ? " (subtrees past the depth limit are cut in the JSON too)" : ""));
    const budget = capWarnings ? Math.floor(opts.limit / 4) : Infinity;
    let used = 0;
    let listed = 0;
    const warnings = m.warnings ?? []; // a thin reply from an older plugin has none
    for (const w of warnings) {
      const line = "Warning: " + w;
      if (used + line.length > budget) break;
      out.push(line);
      used += line.length;
      listed++;
    }
    if (listed < warnings.length) out.push(`Warnings not listed: ${warnings.length - listed} more, in the JSON's manifest.warnings.`);
  }
  const extras: string[] = [];
  if (src.variableCount) extras.push(`${src.variableCount} variables (token names are on the nodes; values are in the JSON)`);
  if (src.assetCount) extras.push(`${src.assetCount} assets (no bytes here; writeToDisk:true or a CLI pull writes them)`);
  if (s.measurements && s.measurements.length) extras.push(`${s.measurements.length} measurements`);
  if (extras.length) out.push("Also in the export: " + extras.join("; ") + ".");
  return out;
}

const notShownLine = (missing: Map<string, number>): string[] =>
  missing.size ? ["Not shown (field: nodes carrying it; each is in the JSON): " + [...missing].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(" ")] : [];

function treeLevel(src: OutlineSource, level: "full" | "layout", opts: OutlineOptions): string {
  const rows: Row[] = [];
  const missing = new Map<string, number>();
  const walk = (n: IrNode, depth: number): void => {
    rows.push({ depth, parts: nodeParts(n, level) });
    countMissing(n, level, missing);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const r of src.screen.nodes) walk(r, 0);
  const { table, lines } = hoist(rows);
  const legend = level === "full"
    ? "Legend: [TYPE] \"name\" #id WxH @x,y w=/h= sizing, layout, → component, text, font, fill=#hex{token}, stroke=, fx=, r=, tokens=, styles=. No name = Figma's default layer name. $X = a value in the table."
    : "Legend: [TYPE] \"name\" #id WxH @x,y w=/h= sizing, layout, → component, the first characters of the text (…+N more). No name = Figma's default layer name. $X = a value in the table.";
  return [...header(src, level, opts, false), legend, ...notShownLine(missing), ...table, "---", ...lines].join("\n");
}

function sectionsLevel(src: OutlineSource, opts: OutlineOptions): string | null {
  const sections = sectionsOf(src.screen.nodes);
  const missing = new Map<string, number>();
  const count = (n: IrNode): void => { countMissing(n, "sections", missing); (n.children ?? []).forEach(count); };
  src.screen.nodes.forEach(count);
  const head = [...header(src, "sections", opts, true), ...notShownLine(missing), "---"];
  let used = head.join("\n").length;
  if (used > opts.limit) return null;
  const rows: string[] = [];
  const reserve = 60; // room for the "not listed" line
  for (const n of sections) {
    const t = firstText(n);
    const line = `#${n.id} [${n.type}] ${JSON.stringify(n.name)} ${sizeOf(n)} nodes=${countNodes(n)}` + (t ? ` text=${JSON.stringify(t.slice(0, LAYOUT_TEXT_CHARS))}` : "");
    if (used + line.length + 1 + reserve > opts.limit) break;
    rows.push(line);
    used += line.length + 1;
  }
  if (rows.length < sections.length) {
    const notListed = `${sections.length - rows.length} more sections not listed.`;
    if (used + notListed.length + 1 > opts.limit) return null; // only with no row listed: a listed row left `reserve` free
    rows.push(notListed);
  }
  return [...head, ...rows].join("\n");
}

/** The richest outline of `src` that fits `opts.limit`, or null when even the section list does not. */
export function screenOutline(src: OutlineSource, opts: OutlineOptions): Outline | null {
  for (const level of ["full", "layout"] as const) {
    const text = treeLevel(src, level, opts);
    if (text.length <= opts.limit) return { level, text };
  }
  const text = sectionsLevel(src, opts);
  return text === null ? null : { level: "sections", text };
}
