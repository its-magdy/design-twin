// Auto Layout / Grid -> flex/grid intent. Reads either a real frame OR node.inferredAutoLayout.
import type { LayoutSpec, LayoutGridSpec, GridTrack, FlexAlign } from "../../bridge/src/doc-types.ts";
import { round, lower } from "./util";
import { ifDefined } from "../../bridge/src/json-util.ts";

// Build flex intent from any auto-layout-shaped source (a real frame OR node.inferredAutoLayout —
// both carry the same fields via AutoLayoutMixin, so a small structural interface covers either).
// The four paddings are required, as they are on AutoLayoutMixin.
interface FlexLike {
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  itemSpacing?: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAxisAlignItems?: "MIN" | "MAX" | "CENTER" | "SPACE_BETWEEN" | "SPACE_EVENLY" | "SPACE_AROUND";
  counterAxisAlignItems?: "MIN" | "MAX" | "CENTER" | "BASELINE";
  layoutWrap?: "NO_WRAP" | "WRAP";
  counterAxisSpacing?: number | null;
  counterAxisAlignContent?: "AUTO" | "SPACE_BETWEEN";
}

// Every value the three Figma alignment enums (primaryAxisAlignItems / counterAxisAlignItems /
// counterAxisAlignContent) can take, keyed as a Record so a future member added to any of the three
// enums is a compile error here rather than a silent `ALIGN[...]` -> undefined drop.
type AlignKey =
  | NonNullable<FlexLike["primaryAxisAlignItems"]>
  | NonNullable<FlexLike["counterAxisAlignItems"]>
  | NonNullable<FlexLike["counterAxisAlignContent"]>;
const ALIGN: Record<AlignKey, FlexAlign> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
  SPACE_EVENLY: "space-evenly",
  SPACE_AROUND: "space-around",
  BASELINE: "baseline",
  // AUTO is never looked up (counterAxisAlignContent skips it via the `!== "AUTO"` check below); the
  // value exists only to make this Record total over AlignKey.
  AUTO: "flex-start",
};
function flexIntent(src: FlexLike): LayoutSpec {
  const l: LayoutSpec = { display: "flex", flexDirection: src.layoutMode === "VERTICAL" ? "column" : "row" };
  // Figma Help Center, "Guide to auto layout" (article 31289464393751): gap can be a number, or
  // "Auto — choose from Between, Around, and Evenly auto spacing options", which "match CSS property
  // values space-between, space-evenly and space-around respectively." Under those three modes the
  // stored itemSpacing is unused slack Figma keeps around, not a real gap, so we drop it here.
  const isAutoSpacing =
    src.primaryAxisAlignItems === "SPACE_BETWEEN" ||
    src.primaryAxisAlignItems === "SPACE_EVENLY" ||
    src.primaryAxisAlignItems === "SPACE_AROUND";
  if (src.itemSpacing && !isAutoSpacing) l.gap = src.itemSpacing;
  const pad = [src.paddingTop, src.paddingRight, src.paddingBottom, src.paddingLeft];
  if (pad.some((p) => p)) l.padding = pad;
  if (src.primaryAxisAlignItems && src.primaryAxisAlignItems !== "MIN") l.justifyContent = ALIGN[src.primaryAxisAlignItems];
  if (src.counterAxisAlignItems && src.counterAxisAlignItems !== "MIN") l.alignItems = ALIGN[src.counterAxisAlignItems];
  if (src.layoutWrap === "WRAP") {
    l.flexWrap = "wrap";
    // The counter-axis twin of the rule above. plugin-api.d.ts (1.139) on `counterAxisAlignContent`:
    // "`counterAxisSpacing` is respected when `counterAxisAlignContent` is set to `"AUTO"`", and under
    // `"SPACE_BETWEEN"` "the free space within the auto-layout frame is divided up evenly between each
    // track" — so the stored counterAxisSpacing is slack there too, and rowGap must not be emitted.
    if (src.counterAxisSpacing && src.counterAxisAlignContent !== "SPACE_BETWEEN") l.rowGap = src.counterAxisSpacing;
    // align-content for wrapped rows (AUTO = packed = default; SPACE_BETWEEN spreads them).
    if (src.counterAxisAlignContent && src.counterAxisAlignContent !== "AUTO") l.alignContent = ALIGN[src.counterAxisAlignContent];
  }
  return l;
}

// A Figma LayoutGrid (column/row grid or uniform grid) -> a compact descriptor.
export function simplifyGrid(g: LayoutGrid): LayoutGridSpec | undefined {
  if (!g) return undefined;
  const o: LayoutGridSpec = { ...ifDefined("pattern", g.pattern ? lower(g.pattern) : undefined) };
  // sectionSize is the cell size of a uniform GRID and the column/row width of ROWS/COLUMNS (there it is
  // ignored by Figma only when alignment is STRETCH — RowsColsLayoutGrid in the typings) — read it for all.
  if (typeof g.sectionSize === "number") o.size = round(g.sectionSize);
  if (g.pattern !== "GRID") {
    if (typeof g.gutterSize === "number") o.gutter = round(g.gutterSize);
    if (typeof g.count === "number" && g.count !== Infinity) o.count = g.count;
    if (typeof g.offset === "number") o.offset = round(g.offset);
    if (g.alignment) o.alignment = lower(g.alignment);
  }
  if (g.visible === false) o.visible = false;
  return o;
}

// A GridTrackSize ({ type:'FLEX'|'FIXED'|'HUG', value?:number }) -> compact track descriptor.
function simplifyTrack(t: GridTrackSize): GridTrack {
  const o: GridTrack = { ...ifDefined("type", t.type ? lower(t.type) : undefined) };
  if (typeof t.value === "number") o.value = round(t.value);
  return o;
}

// Grid child cell alignment (justify-self / align-self analog): MIN|CENTER|MAX|AUTO.
export const GRID_SELF: { [k: string]: "start" | "center" | "end" } = { MIN: "start", CENTER: "center", MAX: "end" };

// The auto-layout/grid-shaped fields layout() reads, on top of a real SceneNode — the plugin manifest
// targets `documentAccess: "dynamic-page"`, so not every SceneNode variant carries these (hence the
// `in node` guards below), but the ones that do are typed exactly per AutoLayoutMixin/GridLayoutMixin.
interface LayoutNode extends FlexLike {
  inferredAutoLayout?: InferredAutoLayoutResult | null;
  width?: number;
  height?: number;
  gridColumnCount?: number;
  gridRowCount?: number;
  gridColumnGap?: number;
  gridRowGap?: number;
  gridColumnSizes?: GridTrackSize[];
  gridRowSizes?: GridTrackSize[];
  gridItemsPositioning?: "MANUAL" | "ROW_AUTO_FLOW";
  gridAutoTracks?: "NONE" | "ROWS";
  itemReverseZIndex?: boolean;
}

// Auto Layout -> flex intent. NONE with an inferred layout -> flex (flagged). NONE otherwise -> absolute.
export function layout(node: SceneNode): LayoutSpec | undefined {
  const n = node as SceneNode & LayoutNode;
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
    const g: LayoutSpec = { display: "grid" };
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
