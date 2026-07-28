// Auto Layout / Grid -> flex/grid intent. Reads either a real frame OR node.inferredAutoLayout.
import { Obj, round } from "./util";

const ALIGN: { [k: string]: string } = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
  BASELINE: "baseline",
};

// Build flex intent from any auto-layout-shaped source (a real frame OR node.inferredAutoLayout —
// both carry the same fields, so this stays structurally typed as `any`).
function flexIntent(src: any): Obj {
  const l: Obj = { display: "flex", flexDirection: src.layoutMode === "VERTICAL" ? "column" : "row" };
  if (src.itemSpacing) l.gap = src.itemSpacing;
  const pad = [src.paddingTop, src.paddingRight, src.paddingBottom, src.paddingLeft];
  if (pad.some((p) => p)) l.padding = pad;
  if (src.primaryAxisAlignItems && src.primaryAxisAlignItems !== "MIN") l.justifyContent = ALIGN[src.primaryAxisAlignItems];
  if (src.counterAxisAlignItems && src.counterAxisAlignItems !== "MIN") l.alignItems = ALIGN[src.counterAxisAlignItems];
  if (src.layoutWrap === "WRAP") {
    l.flexWrap = "wrap";
    if (src.counterAxisSpacing) l.rowGap = src.counterAxisSpacing;
    // align-content for wrapped rows (AUTO = packed = default; SPACE_BETWEEN spreads them).
    if (src.counterAxisAlignContent && src.counterAxisAlignContent !== "AUTO") l.alignContent = ALIGN[src.counterAxisAlignContent];
  }
  return l;
}

// A Figma LayoutGrid (column/row grid or uniform grid) -> a compact descriptor.
export function simplifyGrid(g: LayoutGrid): Obj | undefined {
  if (!g) return undefined;
  const gg = g as any;
  const o: Obj = { pattern: gg.pattern ? String(gg.pattern).toLowerCase() : undefined };
  if (typeof gg.sectionSize === "number") o.size = round(gg.sectionSize);
  if (typeof gg.gutterSize === "number") o.gutter = round(gg.gutterSize);
  if (typeof gg.count === "number" && gg.count !== Infinity) o.count = gg.count;
  if (typeof gg.offset === "number") o.offset = round(gg.offset);
  if (gg.alignment) o.alignment = String(gg.alignment).toLowerCase();
  if (gg.visible === false) o.visible = false;
  return o;
}

// A GridTrackSize ({ type:'FLEX'|'FIXED'|'HUG', value?:number }) -> compact track descriptor.
function simplifyTrack(t: any): any {
  if (!t || typeof t !== "object") return t;
  const o: Obj = { type: t.type ? String(t.type).toLowerCase() : undefined };
  if (typeof t.value === "number") o.value = round(t.value);
  return o;
}

// Grid child cell alignment (justify-self / align-self analog): MIN|CENTER|MAX|AUTO.
export const GRID_SELF: { [k: string]: string } = { MIN: "start", CENTER: "center", MAX: "end" };

// Auto Layout -> flex intent. NONE with an inferred layout -> flex (flagged). NONE otherwise -> absolute.
export function layout(node: SceneNode): Obj | undefined {
  const n = node as any;
  if (!("layoutMode" in node) || n.layoutMode === "NONE") {
    // inferredAutoLayout upgrades a non-auto-layout frame to flex intent (better than raw coords).
    if ("inferredAutoLayout" in node && n.inferredAutoLayout) {
      const l = flexIntent(n.inferredAutoLayout);
      l.inferred = true;
      return l;
    }
    if (!("width" in node)) return undefined;
    return { mode: "absolute", width: round(n.width), height: round(n.height) };
  }
  if (n.layoutMode === "GRID") {
    // Real grid geometry — track counts + per-axis gaps (itemSpacing is NOT the grid gap).
    // Padding is derived here rather than above the branch: the flex path never used this copy —
    // flexIntent builds its own from the same four fields — so two expressions had to stay in step.
    const g: Obj = { display: "grid" };
    const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft]; // [top, right, bottom, left]
    if (pad.some((p) => p)) g.padding = pad;
    if ("gridColumnCount" in node && typeof n.gridColumnCount === "number") g.columns = n.gridColumnCount;
    if ("gridRowCount" in node && typeof n.gridRowCount === "number") g.rows = n.gridRowCount;
    if ("gridColumnGap" in node && typeof n.gridColumnGap === "number") g.columnGap = n.gridColumnGap;
    if ("gridRowGap" in node && typeof n.gridRowGap === "number") g.rowGap = n.gridRowGap;
    // Per-track sizing (grid-template-columns/rows) — FLEX (fr) vs FIXED (px). Uniform grids omit these.
    if ("gridColumnSizes" in node && Array.isArray(n.gridColumnSizes) && n.gridColumnSizes.length) g.columnSizes = n.gridColumnSizes.map(simplifyTrack);
    if ("gridRowSizes" in node && Array.isArray(n.gridRowSizes) && n.gridRowSizes.length) g.rowSizes = n.gridRowSizes.map(simplifyTrack);
    // Flow strategy: ROW_AUTO_FLOW places children into the next free cell by layer order
    // (grid-auto-flow: row) vs MANUAL anchor placement.
    if ("gridItemsPositioning" in node && n.gridItemsPositioning && n.gridItemsPositioning !== "MANUAL") g.autoFlow = String(n.gridItemsPositioning).toLowerCase();
    // Whether the grid grows implicit rows as children are added (grid-auto-rows).
    if ("gridAutoTracks" in node && n.gridAutoTracks && n.gridAutoTracks !== "NONE") g.autoTracks = String(n.gridAutoTracks).toLowerCase();
    return g;
  }
  const l = flexIntent(n);
  // Reverses child paint/stack order (last child on top) — changes overlapping z-order.
  if ("itemReverseZIndex" in node && n.itemReverseZIndex) l.reverseZ = true;
  return l;
}
