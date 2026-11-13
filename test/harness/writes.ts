// The WRITE plane (writes.ts) and parentId.
import { argsShapeError, EDITS_OFF_MESSAGE, WRITE_OP_NAMES, WRITE_OPS, writeOpPreview, type WriteOp, type WriteOpName, type WriteResult } from "../../bridge/src/commands.ts";
import { checkPatch } from "../../bridge/src/patch-spec.ts";
import { MAX_TREE_NODES, NUMBER_TOKEN_FIELDS } from "../../bridge/src/tree-spec.ts";
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import { MIXED, TEXT_RANGE_DEFAULTS, TEXT_RANGE_METHODS, textRuns, type FakeCollection, type FakeNode, type FakeVariable, type Scene } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

// The write targets the plane edits.
const targetsOf = () => {
  const textTarget: FakeNode = textRuns({ id: "t:1", type: "TEXT", name: "Label", characters: "old", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }] });
  const rectTarget: FakeNode & { fills: Array<{ color: { g: number } }> } = { id: "r:1", type: "RECTANGLE", name: "Box", fills: [] };
  const groupTarget: FakeNode = { id: "g:1", type: "GROUP", name: "Wrap" }; // no `fills`
  const screenTarget = modeNode("f:1", "Screen");
  return { textTarget, rectTarget, groupTarget, screenTarget };
};

/** A node with ExplicitVariableModesMixin: `explicitVariableModes` keyed by collection id, set and cleared with the
 *  collection OBJECT. The deprecated id-string form throws, as it does under the manifest's documentAccess
 *  "dynamic-page"; a modeId the collection does not have throws, as Figma's does. */
function modeNode(id: string, name: string, start: Record<string, string> = {}): FakeNode & { explicitVariableModes: Record<string, string> } {
  const n = {
    id, type: "FRAME", name, explicitVariableModes: { ...start },
    setExplicitVariableModeForCollection(c: unknown, modeId: string) {
      if (typeof c !== "object" || c === null) throw new Error("setExplicitVariableModeForCollection: pass the collection object (the id string throws under dynamic-page)");
      const coll = c as FakeCollection;
      if (!coll.modes.some((m) => m.modeId === modeId)) throw new Error("invalid mode " + modeId);
      n.explicitVariableModes = { ...n.explicitVariableModes, [coll.id]: modeId };
    },
    clearExplicitVariableModeForCollection(c: unknown) {
      if (typeof c !== "object" || c === null) throw new Error("clearExplicitVariableModeForCollection: pass the collection object");
      const { [(c as FakeCollection).id]: _gone, ...rest } = n.explicitVariableModes;
      n.explicitVariableModes = rest;
    },
  };
  return n;
}

/** The file's variable collections for the mode cases, on top of the base file's ("Primitives", "Semantic"): a Theme
 *  with Light/Dark, two collections both named "Spacing", one whose modes share a name, a library collection the
 *  file already uses (reachable by id only), and one the team library offers but the file does not use. */
const THEME: FakeCollection = { id: "VariableCollectionId:7:1", key: "theme-key", name: "Theme", modes: [{ modeId: "7:0", name: "Light" }, { modeId: "7:1", name: "Dark" }], defaultModeId: "7:0" };
const modeScene = (): Scene => ({
  collections: {
    [THEME.id]: THEME,
    "VariableCollectionId:8:1": { id: "VariableCollectionId:8:1", name: "Spacing", modes: [{ modeId: "8:0", name: "Compact" }], defaultModeId: "8:0" },
    "VariableCollectionId:9:1": { id: "VariableCollectionId:9:1", name: "Spacing", modes: [{ modeId: "9:0", name: "Roomy" }], defaultModeId: "9:0" },
    "VariableCollectionId:10:1": { id: "VariableCollectionId:10:1", name: "Density", modes: [{ modeId: "10:0", name: "Same" }, { modeId: "10:1", name: "Same" }], defaultModeId: "10:0" },
  },
  remote: { collections: { "VariableCollectionId:abc/1:1": { id: "VariableCollectionId:abc/1:1", name: "Shared Theme", modes: [{ modeId: "1:0", name: "Day" }, { modeId: "1:1", name: "Night" }], defaultModeId: "1:0" } } },
  teamLibrary: {
    getAvailableLibraryVariableCollectionsAsync: async () => [{ name: "Brand Colors", key: "lib-brand", libraryName: "Core Library" }],
    getVariablesInLibraryCollectionAsync: async () => [],
  },
});

/** A file the plugin can write to: createFrame/createText record what they made in `created` (a node a failed batch
 *  removes again leaves it), fonts load, and the open page accepts children. `editorType`, when given, is the editor
 *  the file is open in. "Allow edits" is still OFF (its default): a case that applies writes ticks it, the way the
 *  window does (`writableOn`). */
function writableWorld(nodes: Record<string, FakeNode>, editorType?: string, clientStorage?: Record<string, unknown>, extra: Scene = modeScene()) {
  const created: FakeNode[] = [];
  const made = (n: FakeNode): FakeNode => {
    n.remove = () => { const i = created.indexOf(n); if (i >= 0) created.splice(i, 1); n.removed = true; };
    created.push(n);
    return n;
  };
  const w = world({ ...extra, nodes, ...(editorType !== undefined ? { file: { editorType } } : {}), ...(clientStorage ? { clientStorage } : {}) }, {
    createFrame: () => made({ id: "new:frame", type: "FRAME", name: "", fills: [], resize() {}, appendChild() {} }),
    createText: () => made(textRuns({ id: "new:text", type: "TEXT", characters: "", fills: [], fontName: { family: "Inter", style: "Regular" } })),
    loadFontAsync: async () => {},
  });
  w.figma.currentPage.appendChild = () => {};
  w.figma.currentPage.loadAsync = async () => {};
  w.figma.currentPage.children = [];
  w.figma.root.children = [w.figma.currentPage];
  return { ...w, created };
}
/** writableWorld with "Allow edits" ticked. */
async function writableOn(nodes: Record<string, FakeNode>, editorType?: string) {
  const w = writableWorld(nodes, editorType);
  await w.allowEdits();
  return w;
}

// ---- tree specs (createTree): a file whose nodes behave like Figma's where a tree build leans on it.

const AVAILABLE_FONTS = [["Inter", "Regular"], ["Inter", "Bold"], ["Inter", "Semi Bold"], ["Roboto", "Regular"]] as const;
/** Inter is a variable family here, Roboto a static one (getFontFamilyVariationAxes: null); any other family throws. */
const fontAxes = (family: string): string[] | null => {
  if (family === "Inter") return ["wght", "opsz"];
  if (family === "Roboto") return null;
  throw new Error("in Figma: unknown font family " + family);
};
const isNode = (v: unknown): v is FakeNode => typeof v === "object" && v !== null;
/** A fake node's field, read back as what tree.ts set. */
const num = (n: FakeNode | undefined, k: string): number => { const v = n?.[k]; return typeof v === "number" ? v : NaN; };
const parentOf = (n: FakeNode | undefined): FakeNode | null => { const p = n?.parent; return isNode(p) ? p : null; };
const kids = (n: FakeNode | undefined): readonly FakeNode[] => n?.children ?? [];

/**
 * A writable file for tree specs: "Page 1" (current, with two frames), "Screens" (empty), and two pages both named
 * "Archive". createFrame/createText make nodes that land on the current page like Figma's, move on appendChild, go on
 * remove(), and refuse what Figma refuses: FILL on a node whose parent has no auto-layout, HUG on a frame without one,
 * a text change before its font is loaded. A property named in `trap` throws when set (a value Figma refuses partway
 * through a build). "Allow edits" is ticked.
 *
 * With `kit`, the file also has a design system (KIT below): a "Components" page, variables, text styles, and a team
 * library to import from. Every node can bind a variable (setBoundVariable), a text can take a text style
 * (setTextStyleIdAsync, which needs the style's font loaded), and a component's createInstance makes an INSTANCE that
 * records the properties set on it. `imports` lists every import the plugin ran; `onStyle` runs inside each
 * setTextStyleIdAsync (to untick "Allow edits" there).
 */
async function treeWorld(opts: { kit?: boolean; extra?: Scene } = {}) {
  let seq = 0;
  // getNodeByIdAsync's live table (the world's own): every node made here is found by id until it is removed.
  const reg: { nodes: Record<string, FakeNode> | null } = { nodes: null };
  const register = (n: FakeNode): void => { if (reg.nodes && typeof n.id === "string") reg.nodes[n.id] = n; };
  const unregister = (n: FakeNode): void => { if (reg.nodes && typeof n.id === "string") delete reg.nodes[n.id]; for (const c of kids(n)) unregister(c); };
  const made: FakeNode[] = [];
  const imports: string[] = [];
  const hooks: { onStyle?: (() => Promise<void>) | undefined; onImport?: (() => Promise<void>) | undefined } = {};
  const loadedFonts = new Set<string>();
  const trap = new Set<string>();
  const pageLoads: string[] = [];
  const fontKey = (f: unknown): string => (isNode(f) ? String(f.family) + "|" + String(f.style) : "?");

  const insertInto = (n: FakeNode) => (at: number, c: FakeNode): void => {
    if (n.type === "INSTANCE" || String(n.id).startsWith("I")) throw new Error("in Figma: cannot add a child to an instance");
    const old = parentOf(c);
    if (old) old.children = kids(old).filter((k) => k !== c);
    const list = [...kids(n)];
    list.splice(Math.min(at, list.length), 0, c);
    n.children = list;
    c.parent = n;
    // Out of auto-layout, a FILL child becomes fixed (as in Figma).
    if (n.layoutMode === undefined || n.layoutMode === "NONE") for (const k of ["layoutSizingHorizontal", "layoutSizingVertical"]) if (c[k] === "FILL") c[k] = "FIXED";
  };
  const appendTo = (n: FakeNode) => (c: FakeNode): void => {
    const old = parentOf(c);
    if (old) old.children = kids(old).filter((k) => k !== c);
    n.children = [...kids(n), c];
    c.parent = n;
    // Out of auto-layout, a FILL child becomes fixed (as in Figma).
    if (old && (n.layoutMode === undefined || n.layoutMode === "NONE")) for (const k of ["layoutSizingHorizontal", "layoutSizingVertical"]) if (c[k] === "FILL") c[k] = "FIXED";
  };
  const page = (id: string, name: string, existing: FakeNode[] = []): FakeNode & { selection: FakeNode[] } => {
    const pg: FakeNode & { selection: FakeNode[] } = { id, type: "PAGE", name, selection: [], children: [], loadAsync: async () => { pageLoads.push(id); } };
    pg.appendChild = appendTo(pg);
    pg.insertChild = insertInto(pg);
    for (const k of existing) appendTo(pg)(k);
    return pg;
  };
  const current = page("0:1", "Page 1", [
    { id: "1:1", type: "FRAME", name: "Existing A", x: 0, y: 40, width: 390, height: 844 },
    { id: "1:2", type: "FRAME", name: "Existing B", x: 500, y: -20, width: 390, height: 844 },
  ]);
  const screens = page("0:2", "Screens");
  const node = (type: "FRAME" | "TEXT" | "INSTANCE", main?: FakeNode): FakeNode => {
    // What each kind has (a text has no auto-layout or corner radius, as in Figma), so a write that names a field
    // the node lacks is caught as it would be there.
    const box: FakeNode = type === "TEXT"
      ? { characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12, textAutoResize: "WIDTH_AND_HEIGHT", lineHeight: { unit: "AUTO" },
          letterSpacing: { unit: "PERCENT", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", textStyleId: "", fillStyleId: "",
          leadingTrim: "NONE", hangingPunctuation: false, hangingList: false }
      : { layoutMode: main ? main.layoutMode : "NONE", clipsContent: true, itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
          primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", layoutWrap: "NO_WRAP", counterAxisSpacing: 0, counterAxisAlignContent: "AUTO", itemReverseZIndex: false,
          minWidth: null, maxWidth: null, minHeight: null, maxHeight: null,
          cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0,
          strokeTopWeight: 1, strokeRightWeight: 1, strokeBottomWeight: 1, strokeLeftWeight: 1 };
    const fields: FakeNode = {
      id: "n:" + ++seq, type, name: type === "FRAME" ? "Frame" : main ? String(main.name) : "", visible: true, parent: null, removed: false,
      x: 0, y: 0, width: 100, height: 100, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
      layoutPositioning: "AUTO", layoutGrow: 0, layoutAlign: "INHERIT", opacity: 1, strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", ...box,
      fills: type === "FRAME" ? [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] : type === "TEXT" ? [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] : [],
      boundVariables: {},
    };
    // null unbinds (the value stays), as Figma's does.
    fields.setBoundVariable = (field: string, v: unknown) => {
      const bound = isNode(fields.boundVariables) ? { ...fields.boundVariables } : {};
      if (v === null) { delete bound[field]; fields.boundVariables = bound; return; }
      if (!isNode(v) || typeof v.id !== "string") throw new Error("in Figma: setBoundVariable takes a Variable object");
      fields.boundVariables = { ...bound, [field]: { type: "VARIABLE_ALIAS", id: v.id } };
      // A bound size limit takes the variable's value, and the node grows or shrinks to meet it (as Figma's layout does).
      const value = isNode(v.valuesByMode) ? Object.values(v.valuesByMode)[0] : undefined;
      if (typeof value === "number" && (field === "minWidth" || field === "maxWidth")) {
        fields[field] = value;
        const width = num(fields, "width");
        if ((field === "minWidth" && width < value) || (field === "maxWidth" && width > value)) fields.width = value;
      }
    };
    if (type === "TEXT") {
      textRuns(fields);
      fields.getRangeAllFontNames = () => [fields.fontName];
    }
    if (main) {
      fields.mainComponent = main;
      fields.getMainComponentAsync = async () => fields.mainComponent;
      // Each property's current value under the key setProperties takes: a set or plain component's definitions, the
      // variant's own value for a VARIANT property, else what was set (or the default).
      Object.defineProperty(fields, "componentProperties", {
        enumerable: true,
        get() {
          const owner = parentOf(main)?.type === "COMPONENT_SET" ? parentOf(main) : main;
          const defs = (owner?.componentPropertyDefinitions ?? {}) as Record<string, { type: string; defaultValue: unknown }>;
          const set = isNode(fields.props) ? fields.props : {};
          const vp = isNode(fields.mainComponent) && isNode(fields.mainComponent.variantProperties) ? fields.mainComponent.variantProperties : {};
          const bound = isNode(fields.propBound) ? fields.propBound : {};
          return Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, { type: d.type, value: d.type === "VARIANT" ? vp[k] : k in set ? set[k] : d.defaultValue,
            ...(isNode(bound[k]) ? { boundVariables: { value: bound[k] } } : {}) }]));
        },
      });
      fields.props = {};
      fields.setProperties = (given: Record<string, unknown>) => {
        // A VariableAlias binds the property (it shows the variable's value); a plain value unbinds it.
        const bound: Record<string, unknown> = isNode(fields.propBound) ? { ...fields.propBound } : {};
        const p: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(given)) {
          if (isNode(v) && v.type === "VARIABLE_ALIAS") { bound[k] = v; p[k] = "(" + String(v.id) + ")"; } else { delete bound[k]; p[k] = v; }
        }
        fields.propBound = bound;
        fields.props = { ...(isNode(fields.props) ? fields.props : {}), ...p };
        // A variant value switches the instance to that variant, and to its layout (as Figma's does).
        const set = parentOf(main);
        const was = isNode(fields.mainComponent) && isNode(fields.mainComponent.variantProperties) ? fields.mainComponent.variantProperties : {};
        if (set?.type === "COMPONENT_SET") {
          const want = { ...was, ...Object.fromEntries(Object.entries(p).filter(([k]) => !k.includes("#"))) };
          const v = kids(set).find((c) => isNode(c.variantProperties) && Object.entries(want).every(([k, x]) => isNode(c.variantProperties) && c.variantProperties[k] === x));
          if (v) { fields.mainComponent = v; fields.layoutMode = v.layoutMode; }
        }
      };
    }
    if (type === "TEXT") {
      fields.setTextStyleIdAsync = async (id: string) => {
        const st = KIT_STYLES.find((x) => x.id === id) ?? imported.find((x) => x.id === id);
        if (!st) throw new Error("in Figma: no style " + id);
        if (!loadedFonts.has(fontKey(st.fontName))) throw new Error("in Figma: font " + fontKey(st.fontName) + " is not loaded (setting a text style)");
        fields.textStyleId = id;
        fields.fontName = st.fontName;
        fields.lineHeight = { unit: "AUTO" }; // a style replaces the formatting it sets, per node ones included
        Object.assign(fields, { leadingTrim: "CAP_HEIGHT", hangingPunctuation: true, hangingList: true });
        if (hooks.onStyle) await hooks.onStyle();
      };
    }
    const quiet = new Set(["parent", "removed", "x", "y", "visible", "name", "children", "boundVariables"]);
    const numberFields: readonly string[] = NUMBER_TOKEN_FIELDS;
    const n = new Proxy<FakeNode>(fields, {
      set(t, k, v) {
        const key = String(k);
        if (trap.has(key)) throw new Error("in Figma: cannot set " + key + " to " + JSON.stringify(v));
        // Every corner follows cornerRadius (as Figma's do).
        if (key === "cornerRadius" && typeof v === "number") for (const c of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]) t[c] = v;
        // A raw value unbinds the variable bound to the field (as Figma's does).
        if (numberFields.includes(key) && isNode(t.boundVariables) && key in t.boundVariables) { const b = { ...t.boundVariables }; delete b[key]; t.boundVariables = b; }
        if (type === "TEXT" && !quiet.has(key) && !loadedFonts.has(fontKey(key === "fontName" ? v : t.fontName))) {
          throw new Error("in Figma: font " + fontKey(key === "fontName" ? v : t.fontName) + " is not loaded (setting " + key + ")");
        }
        if (key === "fontName" && isNode(v) && isNode(v.variationSettings)) {
          const axes = fontAxes(String(v.family));
          for (const tag of Object.keys(v.variationSettings)) if (!axes || !axes.includes(tag)) throw new Error("in Figma: '" + String(v.family) + "' has no axis " + tag);
        }
        if (key === "layoutSizingHorizontal" || key === "layoutSizingVertical") {
          const parent = parentOf(t);
          if (v === "FILL" && (!parent || parent.layoutMode === "NONE" || parent.layoutMode === undefined)) throw new Error("in Figma: FILL can only be set on children of auto-layout frames");
          if (v === "HUG" && type !== "TEXT" && t.layoutMode === "NONE") throw new Error("in Figma: HUG can only be set on auto-layout frames and text");
        }
        t[key] = v;
        return true;
      },
    });
    fields.resize = (w: number, h: number) => {
      if (trap.has("resize")) throw new Error("in Figma: cannot resize to " + w + "×" + h);
      fields.width = w; fields.height = h;
      if (isNode(fields.boundVariables)) { const b = { ...fields.boundVariables }; delete b.width; delete b.height; fields.boundVariables = b; }
    };
    fields.remove = () => {
      const parent = parentOf(fields);
      if (parent) parent.children = kids(parent).filter((k) => k !== n);
      fields.parent = null;
      fields.removed = true;
      unregister(n);
    };
    // An instance has the children API too, and refuses a new child (insertInto), as Figma's does.
    if (type !== "TEXT") { fields.children = []; fields.appendChild = type === "FRAME" ? appendTo(n) : (c: FakeNode) => insertInto(n)(0, c); fields.insertChild = insertInto(n); }
    made.push(n);
    register(n);
    appendTo(current)(n); // Figma puts a new node on the current page
    return n;
  };
  // ---- the design system (opts.kit)
  const imported: FakeNode[] = [];
  const kit = opts.kit ? designKit((m) => node("INSTANCE", m)) : null;
  const pages = [current, screens, page("0:3", "Archive"), page("0:4", "Archive"), ...(kit ? [kit.page] : [])];
  const w = world({ ...opts.extra, pages, currentPage: current, ...(kit ? kit.scene : {}), ...(opts.extra?.nodes ? { nodes: opts.extra.nodes } : {}) }, {
    createFrame: () => node("FRAME"),
    createText: () => node("TEXT"),
    loadFontAsync: async (f) => {
      if (!AVAILABLE_FONTS.some(([fam, st]) => fam === f.family && st === f.style)) throw new Error("font not found");
      loadedFonts.add(fontKey(f));
    },
    listAvailableFontsAsync: async () => AVAILABLE_FONTS.map(([family, style]) => ({ fontName: { family, style } })),
    getFontFamilyVariationAxes: fontAxes,
    ...(kit ? {
      importComponentByKeyAsync: async (key: string) => { imports.push("component " + key); if (hooks.onImport) await hooks.onImport(); const c = kit.library.components[key]; if (!c) throw new Error("not published"); return c; },
      importComponentSetByKeyAsync: async (key: string) => { imports.push("component set " + key); throw new Error("not published"); },
      importStyleByKeyAsync: async (key: string) => { imports.push("style " + key); const st = kit.library.styles[key]; if (!st) throw new Error("not published"); imported.push(st); return st; },
      variables: {
        importVariableByKeyAsync: async (key: string) => { imports.push("variable " + key); if (hooks.onImport) await hooks.onImport(); const v = kit.library.variables[key]; if (!v) throw new Error("not published"); return v; },
        setBoundVariableForPaint: (paint: FakeNode, field: string, v: FakeVariable | null) => ({ ...paint, boundVariables: v ? { [field]: { type: "VARIABLE_ALIAS", id: v.id } } : {} }),
      },
    } : {}),
  });
  reg.nodes = w.scene.nodes;
  for (const pg of pages) { register(pg); for (const k of kids(pg)) register(k); }
  await w.allowEdits();
  /** the nodes any batch made that are still in the file: their parent chain reaches a page (a removed node's
   *  parent is null, so everything below it is gone with it, as in Figma) */
  const onPage = (n: FakeNode | null): boolean => (n === null ? false : n.type === "PAGE" ? true : onPage(parentOf(n)));
  const alive = (): FakeNode[] => made.filter((n) => onPage(n));
  return { ...w, made, alive, trap, pageLoads, imports, hooks, pages: { current, screens }, fontLoaded: (f: unknown) => loadedFonts.has(fontKey(f)) };
}

// ---- the design system a kit world has: components, variables, text styles, and a library

const KEY = (c: string): string => c.repeat(40); // a key as Figma writes one: 40 hex digits
const variable = (id: string, name: string, resolvedType: string, key: string): FakeVariable =>
  ({ id, name, key, resolvedType, variableCollectionId: "VariableCollectionId:30:1", scopes: ["ALL_SCOPES"], codeSyntax: {}, remote: false, valuesByMode: { "30:0": resolvedType === "COLOR" ? { r: 0, g: 0, b: 0, a: 1 } : 8 } });
const KIT_VARS: Record<string, FakeVariable> = {
  "VariableID:30:1": variable("VariableID:30:1", "color/brand", "COLOR", "local-brand"),
  "VariableID:30:2": variable("VariableID:30:2", "space/md", "FLOAT", "local-space-md"),
  "VariableID:30:3": variable("VariableID:30:3", "radius/md", "FLOAT", "local-radius-md"),
  "VariableID:30:4": variable("VariableID:30:4", "color/text", "COLOR", "local-text-a"),
  "VariableID:31:4": variable("VariableID:31:4", "color/text", "COLOR", "local-text-b"),
  "VariableID:30:5": { ...variable("VariableID:30:5", "size/min", "FLOAT", "local-size-min"), valuesByMode: { "30:0": 300 } },
};
const style = (id: string, name: string, key: string, family: string, weight: string): FakeNode => ({ id, name, key, type: "TEXT", fontName: { family, style: weight }, fontSize: 24 });
const KIT_STYLES: FakeNode[] = [
  style("S:h1,", "Heading/H1", "local-h1", "Inter", "Bold"),
  style("S:body,", "Body", "local-body", "Inter", "Regular"),
  style("S:fancy,", "Fancy", "local-fancy", "Papyrus", "Regular"),
];
/** The kit: a "Components" page with a Button set (variants by Size; Label text, Icon boolean, Glyph swap), a Badge
 *  without auto-layout, two components both named Card; and a library with a colour and a number variable (listed by
 *  name), an Avatar component and a Caption text style (by key only). */
function designKit(instanceOf: (main: FakeNode) => FakeNode) {
  const comp = (id: string, name: string, extra: FakeNode): FakeNode => {
    const c: FakeNode = { id, type: "COMPONENT", name, key: "local-" + id, layoutMode: "HORIZONTAL", parent: null, ...extra };
    c.createInstance = () => instanceOf(c);
    return c;
  };
  const set: FakeNode = { id: "5:1", type: "COMPONENT_SET", name: "Button", key: "local-button", parent: null, componentPropertyDefinitions: {
    Size: { type: "VARIANT", defaultValue: "Medium", variantOptions: ["Small", "Medium", "Large"] },
    "Label#1:0": { type: "TEXT", defaultValue: "Button" },
    "Icon#1:1": { type: "BOOLEAN", defaultValue: false },
    "Glyph#1:2": { type: "INSTANCE_SWAP", defaultValue: "9:9" },
  } };
  const medium = comp("5:2", "Size=Medium", { parent: set, variantProperties: { Size: "Medium" } });
  Object.defineProperty(medium, "componentPropertyDefinitions", { get() { throw new Error("in Figma: componentPropertyDefinitions can only be read on a component set or a non-variant component"); } });
  const large = comp("5:6", "Size=Large", { parent: set, variantProperties: { Size: "Large" } });
  set.defaultVariant = medium;
  set.children = [medium, large];
  const badge = comp("5:3", "Badge", { layoutMode: "NONE", componentPropertyDefinitions: {} });
  const cards = [comp("5:4", "Card", { componentPropertyDefinitions: {} }), comp("5:5", "Card", { componentPropertyDefinitions: {} })];
  // A Chip set whose default variant has no auto-layout and whose Large one has; a local component named like a key.
  // Its two variants are Small/Off and Large/On: a sparse set, so Large/Off does not exist.
  const chip: FakeNode = { id: "6:1", type: "COMPONENT_SET", name: "Chip", key: "local-chip", parent: null, componentPropertyDefinitions: {
    Size: { type: "VARIANT", defaultValue: "Small", variantOptions: ["Small", "Large"] },
    Tone: { type: "VARIANT", defaultValue: "Off", variantOptions: ["Off", "On"] },
  } };
  const chipSmall = comp("6:2", "Size=Small, Tone=Off", { parent: chip, layoutMode: "NONE", variantProperties: { Size: "Small", Tone: "Off" } });
  const chipLarge = comp("6:3", "Size=Large, Tone=On", { parent: chip, variantProperties: { Size: "Large", Tone: "On" } });
  chip.defaultVariant = chipSmall;
  chip.children = [chipSmall, chipLarge];
  const lookalike = comp("6:4", KEY("e"), { componentPropertyDefinitions: {} });
  // A conflicting set (Figma allows it): two variants with the same values, the first without auto-layout.
  const twin: FakeNode = { id: "7:1", type: "COMPONENT_SET", name: "Twin", key: "local-twin", parent: null, componentPropertyDefinitions: {
    Kind: { type: "VARIANT", defaultValue: "A", variantOptions: ["A"] },
  } };
  const twinFlat = comp("7:2", "Kind=A", { parent: twin, layoutMode: "NONE", variantProperties: { Kind: "A" } });
  const twinFlex = comp("7:3", "Kind=A", { parent: twin, variantProperties: { Kind: "A" } });
  twin.defaultVariant = twinFlat;
  twin.children = [twinFlat, twinFlex];
  const all = [set, medium, large, badge, ...cards, chip, chipSmall, chipLarge, lookalike, twin, twinFlat, twinFlex];
  const page: FakeNode = { id: "0:5", type: "PAGE", name: "Components", selection: [], children: [set, badge, ...cards, chip, lookalike, twin], loadAsync: async () => {},
    findAllWithCriteria: (c: { types: string[] }) => all.filter((n) => c.types.includes(String(n.type))) };
  const avatar = comp("9:1", "Avatar", { layoutMode: "NONE", remote: true, componentPropertyDefinitions: { "Initials#2:0": { type: "TEXT", defaultValue: "AB" } } });
  const library = {
    components: { [KEY("e")]: avatar } as Record<string, FakeNode>,
    styles: { [KEY("f")]: style("S:caption,", "Caption", KEY("f"), "Inter", "Regular") } as Record<string, FakeNode>,
    variables: {
      [KEY("c")]: variable("VariableID:lib/1:1", "color/accent", "COLOR", KEY("c")),
      [KEY("d")]: variable("VariableID:lib/1:2", "space/lg", "FLOAT", KEY("d")),
    } as Record<string, FakeVariable>,
  };
  const scene: Scene = {
    variables: KIT_VARS,
    localStyles: { text: KIT_STYLES },
    styles: Object.fromEntries(KIT_STYLES.map((st) => [String(st.id), st])), // getStyleByIdAsync finds them too

    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async () => [{ name: "Core tokens", key: "lib-core", libraryName: "Core Library" }],
      getVariablesInLibraryCollectionAsync: async () => Object.values(library.variables).map((v) => ({ name: v.name, key: String(v.key), resolvedType: v.resolvedType })),
    },
  };
  return { page, scene, library };
}

/** A sign-in screen: a column of a title, a form of two fields and a button; three handles. */
const signIn = (): Record<string, unknown> => ({
  name: "Sign in", handle: "screen", box: { w: 390, h: 844 }, fills: [{ type: "solid", color: "#ffffff" }],
  layout: { display: "flex", flexDirection: "column", gap: 24, padding: [48, 24, 48, 24] },
  children: [
    { text: "Welcome back", handle: "title", font: { family: "Inter", weight: "Bold", size: 28, color: "#111111" }, widthMode: "fill" },
    { name: "Form", widthMode: "fill", heightMode: "hug", layout: { display: "flex", flexDirection: "column", gap: 12 }, children: [
      { name: "Email", widthMode: "fill", box: { w: 342, h: 48 }, radius: 8, strokes: { colors: ["#d0d0d0"], weight: 1, align: "inside" },
        layout: { display: "flex", flexDirection: "row", padding: [0, 16, 0, 16], alignItems: "center" },
        children: [{ text: "you@example.com", font: { size: 16, color: "#888888" } }] },
      { name: "Password", widthMode: "fill", box: { w: 342, h: 48 }, radius: 8, layout: { display: "flex", padding: [0, 16, 0, 16], alignItems: "center" },
        children: [{ text: "Password", font: { size: 16 } }] },
    ] },
    { name: "Submit", handle: "submit", widthMode: "fill", box: { w: 342, h: 52 }, radius: { tl: 12, tr: 12, br: 12, bl: 12 }, fills: [{ type: "solid", color: "#3355ff" }],
      layout: { display: "flex", justifyContent: "center", alignItems: "center" },
      children: [{ text: "Sign in", font: { family: "Inter", weight: "Semi Bold", size: 16, color: "#ffffff", align: "center" } }] },
  ],
});
const byName = (n: FakeNode | undefined, name: string): FakeNode | undefined => kids(n).find((c) => c.name === name);

export const cases: Case[] = [{
  name: "WRITE plane (writes.ts)",
  async run() {
    // ---- WRITE plane (writes.ts) ----
    // The two contracts that matter to an agent driving figma_write:
    // a write that didn't happen must NOT report success, and a failed batch must still surface what
    // it already applied (Figma gives no transaction, so the earlier ops are committed for good).
    const { textTarget, rectTarget, groupTarget } = targetsOf();
    const w = await writableOn({ "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget });
    const { api, created } = w;

    const wOk = await api.applyWrites([{ op: "createFrame", name: "Card", fill: "#ff0000" }, { op: "setText", nodeId: "t:1", text: "new" }]);
    ok("write: successful batch -> ok:true + applied ids", wOk.ok === true && wOk.applied.length === 2 && wOk.applied[0]?.id === "new:frame");
    ok("write: setText actually mutated the node", textTarget.characters === "new");
    ok("write: setFill applies a parsed hex", (await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#00ff00" }])).ok === true && Math.round(rectTarget.fills[0]?.color.g ?? NaN) === 1);

    // A missing node must FAIL, not silently report {id} (which would tell the agent it worked).
    const wMissing = await api.applyWrites([{ op: "setFill", nodeId: "nope:1", color: "#fff" }]);
    ok("write: setFill on a missing node fails (not silent success)", wMissing.ok === false && /no node with id/.test(must(wMissing.error, "wMissing.error")));
    const wWrongType = await api.applyWrites([{ op: "setText", nodeId: "r:1", text: "x" }]);
    ok("write: setText on a non-TEXT node fails", wWrongType.ok === false && /not TEXT/.test(must(wWrongType.error, "wWrongType.error")));
    const wNoFills = await api.applyWrites([{ op: "setFill", nodeId: "g:1", color: "#fff" }]);
    ok("write: setFill on a node without fills fails", wNoFills.ok === false && /has no fills/.test(must(wNoFills.error, "wNoFills.error")));

    // A colour that is not hex fails the op (the schema in front of the MCP tool is not the only way in): "red" does not
    // paint #rreedd, an unparseable channel is not 0, and a missing setFill color is not black.
    const fillBefore = created.length;
    const rectFillBefore = rectTarget.fills;
    const wRedFrame = await api.applyWrites([{ op: "createFrame", name: "Red", fill: "red" }]);
    ok("write: createFrame with a colour name fails and names the expected form",
      wRedFrame.ok === false && wRedFrame.failedOp === "createFrame" && /not a valid colour/.test(must(wRedFrame.error, "wRedFrame.error")) && /#1A2B3C/.test(must(wRedFrame.error, "wRedFrame.error")));
    const wBadText = await api.applyWrites([{ op: "createText", text: "x", fill: "#12345" }]);
    ok("write: createText with a malformed fill fails", wBadText.ok === false && /not a valid colour/.test(must(wBadText.error, "wBadText.error")));
    ok("write: a bad fill leaves no node behind", created.length === fillBefore && wRedFrame.applied.length === 0 && wBadText.applied.length === 0);
    const wBadFill = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#gg0000" }]);
    ok("write: setFill with non-hex digits fails and leaves the fills alone", wBadFill.ok === false && /not a valid colour/.test(must(wBadFill.error, "wBadFill.error")) && rectTarget.fills === rectFillBefore);
    const wNoColor = await api.applyWrites([{ op: "setFill", nodeId: "r:1" }]);
    ok("write: setFill without a color fails rather than painting black", wNoColor.ok === false && /missing color/.test(must(wNoColor.error, "wNoColor.error")) && rectTarget.fills === rectFillBefore);
    const wBare = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "ff0000" }]);
    ok("write: a colour without the # fails", wBare.ok === false);
    const wAlpha = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#0000ff80" }]);
    const alphaPaint = rectTarget.fills[0] as { color: { b: number }; opacity?: number } | undefined;
    ok("write: #rrggbbaa still paints the colour with alpha as opacity", wAlpha.ok === true && Math.round(alphaPaint?.color.b ?? NaN) === 1 && Math.abs((alphaPaint?.opacity ?? NaN) - 128 / 255) < 1e-9);
    const wShort = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#0f0" }]);
    ok("write: #rgb still paints", wShort.ok === true && Math.round(rectTarget.fills[0]?.color.g ?? NaN) === 1);

    // Dev Mode is read-only for plugins (manifest editorType now includes "dev"): the batch is refused
    // up front with the fix, not left to throw an opaque Plugin-API error partway through.
    w.figma.editorType = "dev";
    const wDev = await api.applyWrites([{ op: "createFrame", name: "X" }]);
    const wDevErr = must(wDev.error, "wDev.error");
    ok("write: refused as a whole in Dev Mode, with the fix in the error", wDev.ok === false && wDev.applied.length === 0 && wDev.failedAt === 0 && /Dev Mode/.test(wDevErr) && /Design mode/.test(wDevErr));
    w.figma.editorType = "figma";

    // Partial failure: ops 0-1 are already committed, so their ids must come back with the error.
    const wPartial = await api.applyWrites([
      { op: "createFrame", name: "A" },
      { op: "createText", text: "B" },
      { op: "setFill", nodeId: "missing:9", color: "#fff" },
      { op: "createFrame", name: "never" },
    ]);
    ok("write: partial failure reports ok:false", wPartial.ok === false);
    ok("write: partial failure puts the batch back: the two nodes it made are removed and listed as restored, nothing stays applied",
      wPartial.applied.length === 0 && (wPartial.restored ?? []).length === 2 && created.every((n) => n.name !== "A" && n.name !== "B"));
    ok("write: partial failure reports the failing index + op", wPartial.failedAt === 2 && wPartial.failedOp === "setFill");
    ok("write: ops after the failure are not applied", created.filter((n) => n.name === "never").length === 0);
    ok("write: unknown op is rejected, naming every op", must((await api.applyWrites([{ op: "nope" }])).error, "write nope error") === "`ops[0].op` is not one of createFrame | createText | setFill | setText | setVariableMode | clearVariableMode | createTree | patch | move | delete");
    // setFill and setText keep what they replace too: a later failure puts the fill and the text back.
    const fillsBefore = rectTarget.fills, textBefore = textTarget.characters;
    const wBack = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#123456" }, { op: "setText", nodeId: "t:1", text: "temporary" }, { op: "setFill", nodeId: "nope:2", color: "#fff" }]);
    ok("write: a failed batch puts setFill's fill and setText's text back, and lists both as restored",
      wBack.ok === false && rectTarget.fills === fillsBefore && textTarget.characters === textBefore && (wBack.restored ?? []).length === 2 && wBack.applied.length === 0);
    ok("write: empty/omitted batch is a no-op success", (await api.applyWrites(undefined)).ok === true);

    // One batch is one Cmd-Z step: an undo checkpoint before and after every non-empty batch (a failed one included,
    // since its applied prefix stays in the file), none for an empty one. Without them Figma keeps every plugin
    // action in one undo step, and the designer's first Cmd-Z undid every batch since the plugin started.
    const commitsBefore = w.undo.commits;
    await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#00f" }]);
    ok("write: a batch ends its own undo step (checkpoint before and after)", w.undo.commits === commitsBefore + 2);
    await api.applyWrites([{ op: "createFrame", name: "C" }, { op: "setFill", nodeId: "missing:9", color: "#fff" }]);
    ok("write: a failed batch is its own undo step too", w.undo.commits === commitsBefore + 4);
    await api.applyWrites([]);
    ok("write: an empty batch sets no undo checkpoint", w.undo.commits === commitsBefore + 4);

    // A dry run refuses a createText with no `text` ("missing text"), so applying it must refuse it too — not
    // create an empty text node the preview said would never be made.
    const beforeNoText = created.length;
    const wNoText = await api.applyWrites([{ op: "createFrame", name: "first" }, { op: "createText" }]);
    ok("write: createText without text is refused up front, before any op lands",
      wNoText.ok === false && wNoText.failedAt === 1 && wNoText.failedOp === "createText" && /missing text/.test(must(wNoText.error, "wNoText.error"))
      && wNoText.applied.length === 0 && created.length === beforeNoText);
  },
}, {
  name: "one write-op table: the dry run's invalid == the plugin's refusal == the wire's",
  async run() {
    // Every op, complete and then short of each field it sets, through all three readers of commands.ts WRITE_OPS:
    // figma_write's dry-run step (writeOpPreview), the wire check (argsShapeError) and the plugin's applyWrites in the
    // VM. A dry run that refuses what applying accepts (or the reverse) is the drift this table exists to stop.
    const { textTarget, rectTarget, groupTarget, screenTarget } = targetsOf();
    const w = await treeWorld({ extra: { ...modeScene(), nodes: { "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget, "f:1": screenTarget } } });
    const { api } = w;
    const created = { get length() { return w.alive().length; } };
    // A move and a delete need nodes this session created: a frame holding two.
    const made = await api.applyWrites([{ op: "createTree", tree: { handle: "a", children: [{ handle: "b" }, { handle: "c" }] } }]);
    const h = made.applied[0]?.handles ?? {};
    const complete: { [K in WriteOpName]: WriteOp } = {
      createFrame: { op: "createFrame", name: "F", width: 10, height: 10, fill: "#fff" },
      createText: { op: "createText", text: "T", fontSize: 12, fill: "#000" },
      createTree: { op: "createTree", tree: { name: "S", children: [{ text: "Hi" }] }, page: "Page 1" },
      setFill: { op: "setFill", nodeId: "r:1", color: "#00f" },
      setText: { op: "setText", nodeId: "t:1", text: "x" },
      setVariableMode: { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      clearVariableMode: { op: "clearVariableMode", nodeId: "f:1", collection: "Theme" },
      patch: { op: "patch", nodeId: "r:1", set: { fills: [{ type: "solid", color: "#00ff00" }] } },
      move: { op: "move", nodeId: h.c ?? "", parentId: h.b ?? "", index: 0 },
      delete: { op: "delete", nodeId: h.b ?? "" },
    };
    for (const name of WRITE_OP_NAMES) {
      const full = complete[name];
      const fields = Object.keys(full).filter((k) => k !== "op");
      const variants: WriteOp[] = [full, { op: name }, ...fields.map((k) => Object.fromEntries(Object.entries(full).filter(([f]) => f !== k)) as WriteOp)];
      let refusedSome = false;
      for (const v of variants) {
        const step = writeOpPreview(v, 0);
        const before = created.length;
        const applied = await api.applyWrites([{ ...v }]); // spread: the VM api takes the loose fake-figma op shape
        const wire = argsShapeError("write", { ops: [v] });
        const previewValid = step.invalid === undefined;
        refusedSome ||= !previewValid;
        ok(`[WRITE-OPS] ${JSON.stringify(v)}: preview ${previewValid ? "valid" : step.invalid} == plugin ${applied.ok ? "applied" : applied.error} == wire ${wire ?? "ok"}`,
          previewValid === applied.ok && previewValid === (wire === null)
          && (previewValid || (applied.applied.length === 0 && created.length === before && /missing/.test(applied.error ?? ""))));
        ok(`[WRITE-OPS] ${name}: the preview's effect is its row's`, step.effect === WRITE_OPS[name].effect);
      }
      ok(`[WRITE-OPS] ${name}: some variant is refused exactly when the row requires a field`, refusedSome === WRITE_OPS[name].required.length > 0);
    }
  },
}, {
  name: "variable modes (setVariableMode / clearVariableMode): names resolved up front, never guessed, put back on failure",
  async run() {
    const { rectTarget, textTarget } = targetsOf();
    const screen = modeNode("f:1", "Screen");
    const card = modeNode("f:2", "Card", { [THEME.id]: "7:0" });
    const doc: FakeNode = { id: "0:0", type: "DOCUMENT", name: "Document" }; // no ExplicitVariableModesMixin
    const w = await writableOn({ "f:1": screen, "f:2": card, "r:1": rectTarget, "t:1": textTarget, "0:0": doc });
    const { api, created } = w;
    const theme = (): string | undefined => screen.explicitVariableModes[THEME.id];

    // Set by names: the mode lands on the node, and the reply names the mode it replaced.
    const byName = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" }]);
    ok("[MODES] set by names: the explicit mode is set and the reply says inherited -> Dark",
      byName.ok === true && theme() === "7:1" && JSON.stringify(byName.applied) === JSON.stringify([{ id: "f:1", collection: "Theme", from: "inherited", to: "Dark" }]));
    // Exact identifiers: the collection's id or key, the mode's modeId.
    const byId = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: THEME.id, mode: "7:0" }]);
    ok("[MODES] set by exact collection id + modeId: Dark -> Light", byId.ok === true && theme() === "7:0" && byId.applied[0]?.from === "Dark" && byId.applied[0]?.to === "Light");
    const byKey = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "theme-key", mode: "Dark" }]);
    ok("[MODES] set by the collection's key", byKey.ok === true && theme() === "7:1");
    // Clear: back to inherited (the collection leaves explicitVariableModes).
    const cleared = await api.applyWrites([{ op: "clearVariableMode", nodeId: "f:1", collection: "Theme" }]);
    ok("[MODES] clear: the explicit mode is gone, the reply says Dark -> inherited",
      cleared.ok === true && !(THEME.id in screen.explicitVariableModes) && cleared.applied[0]?.from === "Dark" && cleared.applied[0]?.to === "inherited");
    // A library collection the file already uses is a VariableCollection, reachable by its exact id.
    const remote = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "VariableCollectionId:abc/1:1", mode: "Night" }]);
    ok("[MODES] a library collection already in the file works by its exact id", remote.ok === true && screen.explicitVariableModes["VariableCollectionId:abc/1:1"] === "1:1");

    // Names that do not resolve refuse the whole batch before anything runs.
    const refused = async (ops: Array<Record<string, unknown>>, label: string, re: RegExp, failedAt = 0): Promise<void> => {
      const before = { ...screen.explicitVariableModes }, made = created.length;
      const r = await api.applyWrites(ops.map((o) => ({ op: "setVariableMode", nodeId: "f:1", ...o })));
      const err = r.error ?? "";
      ok(`[MODES] ${label}: refused whole, nothing changed (${err.split("\n")[0]})`,
        r.ok === false && re.test(err) && r.failedAt === failedAt && r.applied.length === 0 && created.length === made
        && JSON.stringify(screen.explicitVariableModes) === JSON.stringify(before) && /nothing was changed/i.test(err));
    };
    await refused([{ collection: "Them", mode: "Dark" }], "unknown collection, with candidates", /collection 'Them' matches no local variable collection; closest: 'Theme'/);
    const unknownErr = must((await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "Zzzzzzzz", mode: "x" }])).error, "unknown");
    ok("[MODES] candidates are at most three", (unknownErr.match(/closest: (.*?)\. Nothing/)?.[1] ?? "").split(", ").length === 3);
    await refused([{ collection: "Spacing", mode: "Compact" }], "ambiguous collection name, listing each with its id",
      /collection 'Spacing' matches 2 local collections — pass one's id: 'Spacing' \(VariableCollectionId:8:1\), 'Spacing' \(VariableCollectionId:9:1\)/);
    await refused([{ collection: "Theme", mode: "Darkk" }], "unknown mode, with candidates", /mode 'Darkk' is not in collection 'Theme'; closest: 'Dark'/);
    await refused([{ collection: "Density", mode: "Same" }], "ambiguous mode name", /mode 'Same' appears 2 times in collection 'Density' — pass its modeId: 'Same' \(10:0\), 'Same' \(10:1\)/);
    await refused([{ collection: "theme", mode: "dark" }], "a case-only match is not taken", /collection 'theme' matches no local variable collection; closest: 'Theme'/);
    await refused([{ collection: "Brand Colors", mode: "Default" }], "a library collection not in the file is refused by name, naming its library",
      /collection 'Brand Colors' is in the library 'Core Library'.*a write cannot import one yet.*bind one of its variables in this file first/);
    await refused([{ nodeId: "gone:1", collection: "Theme", mode: "Dark" }], "missing node", /no node with id 'gone:1'/);
    await refused([{ nodeId: "0:0", collection: "Theme", mode: "Dark" }], "a node type without variable modes, named", /node 'Document' is a DOCUMENT, which cannot carry a variable mode/);
    // Every bad name in the batch, at once; ops before the first bad one are not run either.
    const many = await api.applyWrites([
      { op: "createFrame", name: "never" },
      { op: "setVariableMode", nodeId: "f:1", collection: "Them", mode: "Dark" },
      { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      { op: "clearVariableMode", nodeId: "gone:2", collection: "Spacing" },
      { op: "setVariableMode", nodeId: "f:2", collection: "Theme", mode: "Dusk" },
    ]);
    const manyErr = must(many.error, "many.error");
    ok("[MODES] every bad name is listed at once and nothing runs, not even the createFrame before them",
      many.ok === false && many.failedAt === 1 && many.failedOp === "setVariableMode" && /^4 problems — nothing was changed:/.test(manyErr)
      && /ops\[1\] \(setVariableMode\): collection 'Them'/.test(manyErr) && /ops\[3\] \(clearVariableMode\): no node with id 'gone:2'/.test(manyErr)
      && /ops\[3\] \(clearVariableMode\): collection 'Spacing' matches 2/.test(manyErr) && /ops\[4\] \(setVariableMode\): mode 'Dusk'/.test(manyErr)
      && !/ops\[2\]/.test(manyErr) && created.every((n) => n.name !== "never") && theme() === undefined);

    // All or nothing: a later op failing puts the mode changes back — to an explicit mode and to inherited alike.
    const madeBefore = created.length;
    const failing = await api.applyWrites([
      { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      { op: "createFrame", name: "Kept" },
      { op: "setVariableMode", nodeId: "f:2", collection: "Theme", mode: "Dark" },
      { op: "setVariableMode", nodeId: "f:2", collection: "Theme", mode: "Light" },
      { op: "clearVariableMode", nodeId: "f:2", collection: "Theme" },
      { op: "setFill", nodeId: "missing:9", color: "#fff" },
    ]);
    ok("[MODES] a later op failing: every mode change in the batch is put back (inherited stays inherited, Light stays Light)",
      failing.ok === false && failing.failedAt === 5 && theme() === undefined && card.explicitVariableModes[THEME.id] === "7:0");
    ok("[MODES] …the reply lists them as restored, in batch order, with the createFrame removed too; nothing stays applied",
      failing.applied.length === 0 && created.length === madeBefore
      && JSON.stringify((failing.restored ?? []).map((r) => [r.id, r.from, r.to])) === JSON.stringify([["f:1", "inherited", "Dark"], ["new:frame", undefined, undefined], ["f:2", "Light", "Dark"], ["f:2", "Dark", "Light"], ["f:2", "Light", "inherited"]]));
    ok("[MODES] …and the toast says what happened", w.notified.some((t) => /undid 5 earlier changes after an edit failed/.test(t)));

    // The same gates as every overwrite: Dev Mode refuses the batch whole, and so does Allow edits off.
    w.figma.editorType = "dev";
    const dev = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" }]);
    ok("[MODES] Dev Mode: refused whole, mode unchanged", dev.ok === false && /Dev Mode/.test(dev.error ?? "") && theme() === undefined);
    w.figma.editorType = "figma";
    await w.allowEdits(false);
    const off = await api.applyWrites([{ op: "clearVariableMode", nodeId: "f:2", collection: "Theme" }]);
    ok("[MODES] Allow edits off: refused as edits-off, mode unchanged", off.refused === "edits-off" && off.error === EDITS_OFF_MESSAGE && card.explicitVariableModes[THEME.id] === "7:0");

    // Unticked mid-batch, then a later op fails for its own reason (a font load that rejects after the box was
    // unticked): the put-back is a write too, so it does not run — the mode change stays and the reply says so.
    await w.allowEdits(true);
    let reject: (e: Error) => void = () => {};
    w.figma.loadFontAsync = () => new Promise<void>((_res, rej) => { reject = rej; });
    const racing = api.applyWrites([
      { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      { op: "setText", nodeId: "t:1", text: "late" },
    ]);
    await new Promise((r) => setTimeout(r, 0)); // setText is now waiting on its font
    await w.allowEdits(false);
    const writesBefore = JSON.stringify(screen.explicitVariableModes);
    reject(new Error("font failed to load"));
    const raced = await racing;
    ok("[MODES] unticked, then a later op fails: no put-back runs after consent is off (the mode change stays)",
      raced.ok === false && raced.failedAt === 1 && theme() === "7:1" && JSON.stringify(screen.explicitVariableModes) === writesBefore
      && raced.restored === undefined && raced.applied.length === 1 && raced.applied[0]?.to === "Dark");
    ok("[MODES] …and the error says the earlier mode change stays applied because Allow edits was turned off",
      /font failed to load/.test(raced.error ?? "") && /'Allow edits' was turned off before the batch could put back its 1 earlier variable mode change, so they stay applied/.test(raced.error ?? ""));
    w.figma.loadFontAsync = async () => {};

    // The dry run (built offline by figma_write) says plainly what changes.
    const setStep = writeOpPreview({ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" }, 0);
    const clearStep = writeOpPreview({ op: "clearVariableMode", nodeId: "f:1", collection: "Theme" }, 1);
    ok("[MODES] dry-run row for a set: an overwrite of the node, collection, new mode and the change in words",
      setStep.effect === "overwrites" && setStep.target === "f:1" && setStep.collection === "Theme" && setStep.newMode === "Dark"
      && /^node f:1: the 'Theme' variable mode goes from its current mode to 'Dark' — the reply names the mode it replaced/.test(setStep.change ?? ""));
    ok("[MODES] dry-run row for a clear: the new mode is 'inherited'",
      clearStep.effect === "overwrites" && clearStep.newMode === "inherited" && /goes from its current mode to inherited/.test(clearStep.change ?? ""));
    // A mode can itself be named "inherited": a set to it is still a set, never described as a clear.
    const namedInherited = writeOpPreview({ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "inherited" }, 0);
    ok("[MODES] dry-run row for a set to a mode NAMED 'inherited' describes a set, not a clear",
      /goes from its current mode to 'inherited' — /.test(namedInherited.change ?? "") && !/whatever its parent uses/.test(namedInherited.change ?? ""));
    ok("[MODES] the other ops' rows carry no mode fields", !("change" in writeOpPreview({ op: "setFill", nodeId: "r:1", color: "#fff" }, 0)));
  },
}, {
  name: "parentId (a silent reparent must not slip through)",
  async run() {
    // ---- parentId (a silent reparent must not slip through) ----
    // The contract mirrors setFill/setText: if the node did NOT land where it was asked to go, the op
    // must fail. Falling back to currentPage and still returning {id} would leave an agent composing a
    // tree with ok:true and a flat pile of nodes on the canvas.
    const parentKids: FakeNode[] = [];
    const containerTarget = { id: "c:1", type: "FRAME", name: "Root", appendChild: (n: FakeNode) => parentKids.push(n) };
    const pageLoads = [];
    const pageTarget = { id: "pg:1", type: "PAGE", name: "Page 2", loadAsync: async () => pageLoads.push("pg:1"), appendChild: (n: FakeNode) => parentKids.push(n) };
    const leafTarget = { id: "lf:1", type: "TEXT", name: "Leaf" }; // no appendChild — cannot hold children
    const { textTarget, rectTarget, groupTarget } = targetsOf();
    // The parentId checks run in the Figma editor with the create/font stubs installed.
    const { api, created } = await writableOn(
      { "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget, "c:1": containerTarget, "pg:1": pageTarget, "lf:1": leafTarget }, "figma");

    const pOk = await api.applyWrites([{ op: "createFrame", name: "Child", parentId: "c:1" }]);
    ok("write: valid parentId -> ok:true and the node lands on that parent", pOk.ok === true && parentKids.length === 1 && parentKids[0]?.id === "new:frame");
    ok("write: valid parentId did NOT fall through to currentPage", parentKids[0] === created[created.length - 1]);

    const beforeOrphan = created.length;
    const pMissing = await api.applyWrites([{ op: "createFrame", name: "Orphan", parentId: "gone:99" }]);
    ok("write: unresolvable parentId fails (not silent reparent)", pMissing.ok === false && /not found/.test(must(pMissing.error, "pMissing.error")));
    ok("write: failed parent leaves NO orphan node behind", created.length === beforeOrphan);
    ok("write: failed parent reports nothing as applied", pMissing.applied.length === 0);

    const pLeaf = await api.applyWrites([{ op: "createFrame", parentId: "lf:1" }]);
    ok("write: parent that cannot have children fails", pLeaf.ok === false && /cannot have children/.test(must(pLeaf.error, "pLeaf.error")));

    const pText = await api.applyWrites([{ op: "createText", text: "hi", parentId: "gone:99" }]);
    ok("write: createText honours parentId failure too", pText.ok === false && /not found/.test(must(pText.error, "pText.error")));

    // documentAccess:"dynamic-page" — appendChild on a PageNode throws unless the page is loaded first.
    const pPage = await api.applyWrites([{ op: "createFrame", parentId: "pg:1" }]);
    ok("write: PAGE parent is loadAsync'd before appendChild", pPage.ok === true && pageLoads.length === 1);
  },
}, {
  name: "Allow edits (edits.ts): off by default, refused while off, applied while on, persisted",
  async run() {
    const { textTarget, rectTarget, groupTarget } = targetsOf();
    const nodes = { "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget };
    const w = writableWorld(nodes);
    const batch = [{ op: "createFrame", name: "Card" }, { op: "setText", nodeId: "t:1", text: "changed" }];

    // Default: off — nothing saved, the window is told "off", and whoami (what the dry run reads) says so.
    const asked = await w.send({ type: "get-allow-edits" });
    ok("[EDITS] default is OFF: nothing saved, the window is told allowed:false",
      !w.storage.has("allowEdits") && asked.length === 1 && asked[0]?.type === "allow-edits" && (asked[0] as { allowed?: unknown }).allowed === false);
    const who = await w.send({ type: "bridge", id: "who1", cmd: "whoami", args: {} });
    ok("[EDITS] whoami reports editsAllowed:false by default", (who.find((m) => m.type === "bridge-result")?.result as { editsAllowed?: unknown } | undefined)?.editsAllowed === false);

    // Off: refused whole before any op runs, with the typed refusal and the actionable sentence — through the
    // __designExport surface AND through the bridge's own `write` command (no bypass either way).
    const direct = await w.api.applyWrites(batch);
    ok("[EDITS] refused while off (direct applyWrites): refused:'edits-off', the fix in the error, nothing applied",
      direct.ok === false && direct.refused === "edits-off" && direct.error === EDITS_OFF_MESSAGE && direct.applied.length === 0 && direct.failedAt === undefined);
    const viaBridge = await w.send({ type: "bridge", id: "w1", cmd: "write", args: { ops: batch } });
    const reply = viaBridge.find((m) => m.type === "bridge-result");
    ok("[EDITS] refused while off (bridge `write`): the reply carries the same refusal",
      reply?.ok === true && (reply.result as { refused?: unknown } | undefined)?.refused === "edits-off");
    ok("[EDITS] …and the document was not touched", w.created.length === 0 && textTarget.characters === "old");
    ok("[EDITS] …and the refusal is not silent: a Figma toast and a window notice",
      w.notified.some((t) => /refused an edit request/.test(t) && /Allow edits/.test(t)) && w.posted.some((m) => m.type === "writes" && m.ok === false));
    // A forged value is not consent: only a literal true turns edits on.
    await w.send({ type: "set-allow-edits", allowed: "yes" });
    ok("[EDITS] set-allow-edits with a non-boolean leaves edits off", (await w.api.applyWrites(batch)).refused === "edits-off" && w.created.length === 0);

    // On: applied, saved for next time, and announced.
    w.notified.length = 0;
    const ticked = await w.send({ type: "set-allow-edits", allowed: true });
    ok("[EDITS] ticking it is echoed to the window and saved in clientStorage",
      (ticked[0] as { allowed?: unknown } | undefined)?.allowed === true && w.storage.get("allowEdits") === true);
    const applied = await w.api.applyWrites(batch);
    ok("[EDITS] applied while on", applied.ok === true && applied.refused === undefined && applied.applied.length === 2 && textTarget.characters === "changed");
    ok("[EDITS] …and announced (toast + window notice naming the count)",
      w.notified.some((t) => /applied 2 edits/.test(t)) && w.posted.some((m) => m.type === "writes" && m.ok === true));

    // Cleared again: refused again, and the saved value follows.
    await w.allowEdits(false);
    ok("[EDITS] clearing it refuses the next write and saves false", (await w.api.applyWrites(batch)).refused === "edits-off" && w.storage.get("allowEdits") === false);

    // Unticked WHILE a batch runs (the window's message lands during a font load): the batch stops before the
    // next mutation, keeps the prefix it already applied, and reports the refusal.
    await w.allowEdits(true);
    const textBefore = textTarget.characters;
    let release: () => void = () => {};
    w.figma.loadFontAsync = () => new Promise<void>((res) => { release = res; });
    const racing = w.api.applyWrites([{ op: "createFrame", name: "First" }, { op: "setText", nodeId: "t:1", text: "late" }]);
    await new Promise((r) => setTimeout(r, 0)); // setText is now waiting on its font
    await w.allowEdits(false);
    release();
    const raced = await racing;
    ok("[EDITS] unticked mid-batch: the next mutation is refused, the applied prefix is reported",
      raced.ok === false && raced.refused === "edits-off" && raced.failedAt === 1 && raced.applied.length === 1 && textTarget.characters === textBefore);
    w.figma.loadFontAsync = async () => {};

    // Saved last session: a fresh plugin run reads it before its first write (no tick needed, no start-up race).
    const again = writableWorld(nodes, undefined, { allowEdits: true });
    const first = await again.api.applyWrites([{ op: "createFrame", name: "Next" }]);
    ok("[EDITS] an 'on' saved last session is honoured from the first write", first.ok === true && again.created.length === 1);
    // Anything but a stored `true` reads as off.
    const odd = writableWorld(nodes, undefined, { allowEdits: "true" });
    ok("[EDITS] a stored non-boolean reads as off", (await odd.api.applyWrites(batch)).refused === "edits-off");
  },
}, {
  name: "tree spec (createTree): one call creates a whole screen, beside the existing frames, all or nothing",
  async run() {
    const w = await treeWorld();
    const { api, alive, pages } = w;
    const commits = w.undo.commits;

    // ---- one call, the whole tree
    const r = await api.applyWrites([{ op: "createTree", tree: signIn() }]);
    const a = r.applied[0];
    ok("[TREE] one createTree op lands the whole screen: ok, one applied entry", r.ok === true && r.applied.length === 1 && r.error === undefined);
    ok("[TREE] the reply is the root id, the counts, the handles and the unbound count only (no tree)",
      JSON.stringify(Object.keys(a ?? {}).sort()) === JSON.stringify(["created", "handles", "id", "unbound"])
      && JSON.stringify(a?.created) === JSON.stringify({ frames: 5, texts: 4 }) && a?.unbound === 31 && r.warnings === undefined);
    const root = alive().find((n) => n.id === a?.id);
    ok("[TREE] ids come back only for the nodes the spec gave a handle",
      JSON.stringify(Object.keys(a?.handles ?? {})) === JSON.stringify(["screen", "title", "submit"]) && a?.handles?.screen === a?.id
      && a?.handles?.title === kids(root)[0]?.id && a?.handles?.submit === byName(root, "Submit")?.id);
    ok("[TREE] one batch is one Cmd-Z step", w.undo.commits === commits + 2);
    ok("[TREE] the root is on the current page, shown, named, sized", parentOf(root) === pages.current && root?.visible === true
      && root?.name === "Sign in" && num(root, "width") === 390 && num(root, "height") === 844);
    ok("[TREE] placed right of the rightmost frame (500+390+100), top-aligned with the topmost (-20)", num(root, "x") === 990 && num(root, "y") === -20);
    ok("[TREE] the auto-layout reads back as written (column, gap, padding, fixed size)",
      root?.layoutMode === "VERTICAL" && num(root, "itemSpacing") === 24 && num(root, "paddingTop") === 48 && num(root, "paddingLeft") === 24
      && root.layoutSizingHorizontal === "FIXED" && root.clipsContent === false);
    const form = byName(root, "Form"), email = byName(form, "Email"), submit = byName(root, "Submit");
    ok("[TREE] children nest in spec order, and fill / hug land on them",
      JSON.stringify(kids(root).map((c) => c.type + ":" + String(c.name))) === JSON.stringify(["TEXT:", "FRAME:Form", "FRAME:Submit"])
      && form?.layoutSizingHorizontal === "FILL" && form.layoutSizingVertical === "HUG" && email?.layoutSizingHorizontal === "FILL");
    ok("[TREE] a frame without fills has none (not Figma's white default); a solid fill is parsed",
      JSON.stringify(form?.fills) === "[]" && JSON.stringify(submit?.fills) === JSON.stringify([{ type: "SOLID", color: { r: 0.2, g: 1 / 3, b: 1 } }]));
    ok("[TREE] radius, per-corner radius and strokes land",
      num(email, "cornerRadius") === 8 && num(submit, "topLeftRadius") === 12 && num(email, "strokeWeight") === 1 && email?.strokeAlign === "INSIDE"
      && JSON.stringify(email.strokes) === JSON.stringify([{ type: "SOLID", color: { r: 208 / 255, g: 208 / 255, b: 208 / 255 } }]));
    ok("[TREE] justify / align read back as Figma's enums", submit?.primaryAxisAlignItems === "CENTER" && submit.counterAxisAlignItems === "CENTER" && email?.layoutMode === "HORIZONTAL");
    const title = kids(root)[0], label = kids(submit)[0];
    ok("[TREE] text: characters, font, size, colour, fill width",
      title?.characters === "Welcome back" && JSON.stringify(title.fontName) === JSON.stringify({ family: "Inter", style: "Bold" }) && num(title, "fontSize") === 28
      && title.layoutSizingHorizontal === "FILL" && label?.textAlignHorizontal === "CENTER" && JSON.stringify(label.fontName) === JSON.stringify({ family: "Inter", style: "Semi Bold" }));
    ok("[TREE] a text with no font gets Inter Regular", JSON.stringify(kids(byName(form, "Password"))[0]?.fontName) === JSON.stringify({ family: "Inter", style: "Regular" }));
    ok("[TREE] nothing else was left on the page (every node is inside the root)", alive().filter((n) => parentOf(n) === pages.current).length === 1);
    ok("[TREE] and announced", w.notified.some((t) => /applied 1 edit to this file/.test(t)));

    // ---- placement: a named page, explicit coordinates
    const onScreens = await api.applyWrites([{ op: "createTree", page: "Screens", tree: { name: "Empty state", box: { w: 200, h: 100 } } }]);
    const second = alive().find((n) => n.id === onScreens.applied[0]?.id);
    ok("[TREE] page by name: lands on 'Screens' (loaded first), at 0,0 on an empty page, and no handles key without handles",
      onScreens.ok === true && parentOf(second) === pages.screens && w.pageLoads.includes("0:2") && num(second, "x") === 0 && num(second, "y") === 0
      && onScreens.applied[0]?.handles === undefined);
    const byId = await api.applyWrites([{ op: "createTree", page: "0:2", tree: { name: "At", x: -400, y: 1200 } }]);
    const third = alive().find((n) => n.id === byId.applied[0]?.id);
    ok("[TREE] page by id, with explicit x/y", byId.ok === true && parentOf(third) === pages.screens && num(third, "x") === -400 && num(third, "y") === 1200);
    const xOnly = await api.applyWrites([{ op: "createTree", page: "Screens", tree: { name: "X only", x: 5 } }]);
    const fourth = alive().find((n) => n.id === xOnly.applied[0]?.id);
    ok("[TREE] only x given: y still comes from placement (the topmost frame on 'Screens' is at 0)", xOnly.ok === true && num(fourth, "x") === 5 && num(fourth, "y") === 0);

    // ---- warnings: accepted, no effect
    const warned = await api.applyWrites([{ op: "createTree", tree: { layout: { display: "flex" }, children: [{ name: "Pinned", x: 10, y: 10 }] } }]);
    ok("[TREE] x/y inside auto-layout: applied, with a warning naming the node", warned.ok === true
      && JSON.stringify(warned.warnings) === JSON.stringify(["ops[0].tree.children[0]: `x`/`y` have no effect inside auto-layout (add `absolute: true` to place it)"]));
  },
}, {
  name: "tree spec (createTree): everything is checked before the file is touched; every problem listed",
  async run() {
    const w = await treeWorld();
    const { api, alive, made } = w;
    const refused = async (label: string, ops: WriteOp[], re: RegExp, failedAt = 0): Promise<string> => {
      const before = made.length, commits = w.undo.commits;
      const r = await api.applyWrites(ops.map((o) => ({ ...o })));
      const err = r.error ?? "";
      ok(`[TREE-REFUSE] ${label}: refused whole, nothing made (${err.split("\n")[0]})`,
        r.ok === false && re.test(err) && r.failedAt === failedAt && r.applied.length === 0 && made.length === before && w.undo.commits === commits + 2);
      return err;
    };
    // Spec problems (the shared check): read fields refused by name, unknown keys with candidates, rules of the tree.
    const many = await refused("read fields refused by name, unknown keys with candidates, every problem at once", [{ op: "createTree", tree: {
      name: "S", effects: [], children: [
        { text: "Hi", font: { size: 14, colour: "#000" } },
        { type: "RECTANGLE" },
        { name: "Pill", widthMode: "hug", mainComponent: { name: "Pill" } },
        { text: "Mixed", runs: [] },
      ] } }], /^6 problems in the tree spec — nothing was changed:\n/);
    ok("[TREE-REFUSE] …each named by its path, read fields with the reason",
      many.includes("ops[0].tree.effects: a read field a write cannot set yet")
      && many.includes("ops[0].tree.children[0].font.colour: not a field the write accepts; closest: 'color'")
      && many.includes("ops[0].tree.children[1].type: 'RECTANGLE' cannot be written yet (FRAME, TEXT and INSTANCE can)")
      && many.includes("ops[0].tree.children[2].mainComponent: a read field a write cannot set yet — name the component in `component`")
      && many.includes("ops[0].tree.children[2]: `widthMode: \"hug\"` needs the node itself to have auto-layout")
      && many.includes("ops[0].tree.children[3].runs: a read field a write cannot set yet — mixed-format text comes in a later write step"));
    await refused("a fill on the root (no auto-layout parent)", [{ op: "createTree", tree: { widthMode: "fill" } }], /`widthMode: "fill"` needs a parent with auto-layout \(this is the root\)/);
    await refused("a TEXT root", [{ op: "createTree", tree: { text: "Lonely" } }], /the root must be a FRAME/);
    await refused("a handle used twice", [{ op: "createTree", tree: { handle: "a", children: [{ handle: "a" }] } }], /handle 'a' is used twice/);
    await refused("an id in the spec", [{ op: "createTree", tree: { id: "1:2" } }], /tree\.id: a read field a write cannot set yet — a new node gets its id from Figma; give it a `handle`/);
    await refused("a grid layout", [{ op: "createTree", tree: { layout: { display: "grid", columns: 2 } } }], /layout\.display 'grid' cannot be written yet/);
    await refused("a bad colour", [{ op: "createTree", tree: { fills: [{ type: "solid", color: "red" }] } }], /tree\.fills\[0\]\.color is not a hex colour/);
    const big = { name: "Big", children: Array.from({ length: MAX_TREE_NODES }, () => ({ name: "n" })) };
    await refused("more nodes than the cap", [{ op: "createTree", tree: big }], new RegExp("more than " + MAX_TREE_NODES + " nodes"));
    // Values Figma refuses only once it is building: refused up front, with an earlier op in the batch, so nothing lands.
    const tooSmall = await refused("a box under Figma's 0.01 minimum, a column baseline, a half-made letterSpacing, a text's per-side stroke, an empty font name, a min above its max", [
      { op: "createFrame", name: "never" },
      { op: "createTree", tree: { name: "S", box: { w: 0.001, h: 100 }, layout: { display: "flex", flexDirection: "column", alignItems: "baseline" }, children: [
        { text: "a", font: { letterSpacing: {} } },
        { text: "b", strokes: { colors: ["#000"], weights: { top: 4 } } },
        { text: "c", font: { family: "" } },
        { name: "L", sizeLimits: { minWidth: 200, maxWidth: 100 } },
        { name: "W", layout: { display: "flex", rowGap: 4 } },
      ] } },
    ], /^bad|problems in the tree spec/, 1);
    ok("[TREE-REFUSE] …each by path",
      tooSmall.includes("ops[1].tree.box.w must be a number ≥ 0.01") && tooSmall.includes("`layout.alignItems: \"baseline\"` works only in a row")
      && tooSmall.includes("ops[1].tree.children[0].font.letterSpacing is missing unit") && tooSmall.includes("ops[1].tree.children[1]: `strokes.weights` (per side) is not on a TEXT node")
      && tooSmall.includes("ops[1].tree.children[2].font.family must be a non-empty string") && tooSmall.includes("`sizeLimits.minWidth` is above `maxWidth`")
      && tooSmall.includes("ops[1].tree.children[4]: `layout.rowGap` needs `flexWrap: \"wrap\"`"));
    // The live check's gaps: values the pre-check passed that Figma then refused mid-build (an earlier createFrame stayed).
    const outOfFlow = await refused("an absolute child that fills, grows or stretches, a 0 size limit", [
      { op: "createFrame", name: "never" },
      { op: "createTree", tree: { name: "S", layout: { display: "flex" }, children: [
        { name: "Badge", absolute: true, widthMode: "fill", heightMode: "fill" },
        { name: "Grow", absolute: true, grow: 1, alignSelf: "stretch" },
        { name: "Min", sizeLimits: { minWidth: 0 } },
        { name: "Max", sizeLimits: { maxHeight: 0 } },
      ] } },
    ], /problems in the tree spec/, 1);
    ok("[TREE-REFUSE] …an absolute child cannot fill, grow or stretch, and a size limit must be above 0",
      outOfFlow.includes("ops[1].tree.children[0]: `widthMode: \"fill\"` is not on an `absolute` child")
      && outOfFlow.includes("ops[1].tree.children[0]: `heightMode: \"fill\"` is not on an `absolute` child")
      && outOfFlow.includes("ops[1].tree.children[1]: `grow: 1` is not on an `absolute` child")
      && outOfFlow.includes("ops[1].tree.children[1]: `alignSelf: \"stretch\"` is not on an `absolute` child")
      && outOfFlow.includes("ops[1].tree.children[2].sizeLimits.minWidth must be a number > 0")
      && outOfFlow.includes("ops[1].tree.children[3].sizeLimits.maxHeight must be a number > 0"));
    // Inputs that would be dropped are refused instead: auto-layout fields with no auto-layout, extras on an auto line height.
    const dropped = await refused("auto-layout fields under mode absolute, extra keys on an auto line height", [{ op: "createTree", tree: {
      name: "S", layout: { mode: "absolute", width: 200, gap: 8, padding: [1, 2, 3, 4] }, children: [{ text: "x", font: { lineHeight: { unit: "auto", value: 20 } } }],
    } }], /problems in the tree spec/);
    ok("[TREE-REFUSE] …each named",
      dropped.includes("ops[0].tree: `layout.gap` is an auto-layout field; `mode: \"absolute\"` has none")
      && dropped.includes("ops[0].tree: `layout.padding` is an auto-layout field") && !dropped.includes("layout.width")
      && dropped.includes("ops[0].tree.children[0].font.lineHeight.value: not a field of an `auto` line height"));
    await refused("a handle named __proto__ (Figma's message passing would drop it from the reply)", [{ op: "createTree", tree: { handle: "__proto__" } }],
      /tree\.handle '__proto__' cannot be a handle/);
    await refused("a tapered stroke (only the default uniform width)", [{ op: "createTree", tree: { strokes: { colors: ["#000"], variableWidth: { profile: "taper" } } } }],
      /tree\.strokes\.variableWidth only the default \{profile:"uniform"\} can be written yet/);
    // A variable-font axis is checked against the family before the build (Figma throws on one it lacks).
    const axes = await refused("an axis the family lacks, axes on a static family", [
      { op: "createFrame", name: "never" },
      { op: "createTree", tree: { children: [
        { text: "a", font: { variationSettings: { wght: 600, slnt: -10 } } },
        { text: "b", font: { family: "Roboto", variationSettings: { wght: 600 } } },
      ] } },
    ], /^2 problems — nothing was changed:/, 1);
    ok("[TREE-REFUSE] …with the axes the family has", axes.includes("ops[1] (createTree): tree.children[0].font.variationSettings: 'Inter' has no axis 'slnt'; its axes are 'wght', 'opsz'")
      && axes.includes("tree.children[1].font.variationSettings: 'Roboto' is not a variable font"));
    // File problems (resolved before the first op): page names and fonts, with candidates, together.
    const fileErr = await refused("an unknown page and a missing font, both listed, with candidates", [
      { op: "createFrame", name: "never" },
      { op: "createTree", page: "Screen", tree: { children: [{ text: "x", font: { family: "Inter", weight: "Semibold" } }] } },
    ], /^2 problems — nothing was changed:/, 1);
    ok("[TREE-REFUSE] …the page with its closest names, the font with the file's nearest",
      /ops\[1\] \(createTree\): page 'Screen' matches no page in this file; closest: 'Screens'/.test(fileErr)
      && /ops\[1\] \(createTree\): font 'Inter Semibold' is not available in this file; closest: 'Inter Semi Bold'/.test(fileErr));
    await refused("an ambiguous page name", [{ op: "createTree", page: "Archive", tree: {} }], /page 'Archive' matches 2 pages — pass one's id: 'Archive' \(0:3\), 'Archive' \(0:4\)/);

    // A value Figma refuses partway through the build: the root (and so every node under it) is removed.
    w.trap.add("textCase");
    const partway = await api.applyWrites([{ op: "createTree", tree: signIn() }, { op: "createTree", tree: { name: "Never", children: [{ text: "x", font: { case: "upper" } }] } }]);
    ok("[TREE-ATOMIC] Figma refusing a value deep in the tree: ok:false at that op, the first tree removed too, nothing alive",
      partway.ok === false && partway.failedAt === 1 && /cannot set textCase/.test(partway.error ?? "") && partway.applied.length === 0
      && alive().length === 0 && (partway.restored ?? []).length === 1 && partway.restored?.[0]?.created?.frames === 5);
    ok("[TREE-ATOMIC] …and the toast says the earlier change was undone", w.notified.some((t) => /undid 1 earlier change after an edit failed/.test(t)));
    w.trap.clear();
    // A later op of the batch failing takes the tree back, and the createFrame after it.
    const later = await api.applyWrites([{ op: "createTree", tree: signIn() }, { op: "createFrame", name: "Kept" }, { op: "setFill", nodeId: "gone:1", color: "#fff" }]);
    ok("[TREE-ATOMIC] a later op failing removes the tree and the frame, and lists both as restored",
      later.ok === false && later.failedAt === 2 && alive().length === 0
      && later.applied.length === 0 && later.restored?.[0]?.handles?.title !== undefined && later.restored.length === 2);

    // A handle is the agent's own string: names on Object.prototype come back as own keys like any other.
    const proto = await api.applyWrites([{ op: "createTree", tree: { handle: "constructor", children: [{ handle: "toString" }] } }]);
    const handles = proto.applied[0]?.handles ?? {};
    ok("[TREE] the handles 'constructor' and 'toString' come back as own keys with their ids",
      proto.ok === true && JSON.stringify(Object.keys(handles)) === JSON.stringify(["constructor", "toString"]) && Object.getOwnPropertyDescriptor(handles, "constructor")?.value === proto.applied[0]?.id);
    // A read node fed back in: what the read writes on an ordinary frame and text is accepted (and set where it means something).
    const roundTrip = await api.applyWrites([{ op: "createTree", page: "0:3", tree: {
      name: "Read", reference: "assets/3_2_ref.png", x: 3000, y: 0, box: { w: 390, h: 844, x: 3000, y: 0 }, layout: { display: "flex", flexDirection: "column" }, strokesInLayout: true,
      strokes: { colors: ["#e5e5e5"], weight: 1, align: "inside", variableWidth: { profile: "uniform" } },
      children: [
        { text: "Title", font: { size: 24, family: "Inter", weight: "Bold", weightValue: 5000, variationSettings: { wght: 5000, opsz: 32 }, lineHeight: { unit: "auto" } }, renderBox: { x: 3000, y: 2, w: 50, h: 20 } },
        { name: "Plain", strokesInLayout: true },
        { text: "Clamp", maxLines: 2 },
      ],
    } }]);
    const rtRoot = alive().find((n) => n.id === roundTrip.applied[0]?.id);
    const rtTitle = kids(rtRoot)[0];
    ok("[TREE] a read frame and text round-trip (reference, a wght past 1000 as Figma takes it): accepted, strokesInLayout set, the axes on the font",
      roundTrip.ok === true && rtRoot?.strokesIncludedInLayout === true
      && JSON.stringify(rtTitle?.fontName) === JSON.stringify({ family: "Inter", style: "Bold", variationSettings: { wght: 5000, opsz: 32 } }));
    ok("[TREE] …and what has no effect is not set, with a warning naming the node",
      kids(rtRoot)[1]?.strokesIncludedInLayout === undefined && kids(rtRoot)[2]?.maxLines === undefined
      && JSON.stringify(roundTrip.warnings) === JSON.stringify([
        "ops[0].tree.children[1]: `strokesInLayout` has no effect without auto-layout on the frame, so it is not set",
        "ops[0].tree.children[2]: `maxLines` has no effect without `truncate: true`, so it is not set",
      ]));
    // Placement reads what a frame occupies on the page, rotation included (its bounding box), not its x + width.
    const rotated: FakeNode = { id: "1:9", type: "FRAME", name: "Rotated", x: 2000, y: 0, width: 100, height: 1000, absoluteBoundingBox: { x: 1300, y: 0, width: 1400, height: 1000 } };
    (w.pages.current.appendChild as (c: FakeNode) => void)(rotated);
    const beside = await api.applyWrites([{ op: "createTree", tree: { name: "Beside" } }]);
    ok("[TREE] a rotated frame's bounding box is what the new frame is placed beside (1300+1400+100)",
      num(alive().find((n) => n.id === beside.applied[0]?.id), "x") === 2800);

    // The same gates as every write: Allow edits off, Dev Mode.
    const before = made.length;
    w.figma.editorType = "dev";
    const dev = await api.applyWrites([{ op: "createTree", tree: signIn() }]);
    w.figma.editorType = "figma";
    await w.allowEdits(false);
    const off = await api.applyWrites([{ op: "createTree", tree: signIn() }]);
    ok("[TREE-GATES] Dev Mode and Allow edits off refuse a tree whole, nothing made",
      dev.ok === false && /Dev Mode/.test(dev.error ?? "") && off.refused === "edits-off" && made.length === before);
  },
}, {
  name: "tree spec (createTree): the dry run describes the change, and agrees with the wire check and the plugin",
  async run() {
    const step = writeOpPreview({ op: "createTree", tree: signIn() }, 0);
    ok("[TREE-DRY] a plain description: the frame, its size and layout, the counts, where, the handles, the fonts",
      step.effect === "creates" && step.target === "new frame on the current page" && step.invalid === undefined
      && step.change === "creates frame 'Sign in' 390×844, vertical auto-layout with 9 nodes (5 frames, 4 texts) on the current page, placed beside the existing frames; "
        + "ids come back for 'screen', 'title', 'submit'; fonts 'Inter Bold', 'Inter Regular', 'Inter Semi Bold'; 31 raw values left unbound — the page and fonts are checked against the file when applied, and nothing lands unless all of it does");
    const onPage = writeOpPreview({ op: "createTree", page: "Screens", tree: { name: "A", x: 0, y: 0, layout: { display: "flex" }, children: [{ name: "B", x: 1 }] } }, 3);
    ok("[TREE-DRY] a named page and explicit coordinates are said; warnings are carried",
      onPage.target === "new frame on page 'Screens'" && /on page 'Screens' at 0,0/.test(onPage.change ?? "") && onPage.warnings?.length === 1);
    const bad = writeOpPreview({ op: "createTree", tree: { effects: [] } }, 0);
    ok("[TREE-DRY] an invalid spec: the same problem the plugin refuses with", bad.invalid === "tree.effects: a read field a write cannot set yet" && bad.change === undefined);
    // The wire check (handleBridge's gate) refuses what the dry run calls invalid, with the op's path.
    ok("[TREE-DRY] the wire check refuses the same spec, by path", argsShapeError("write", { ops: [{ op: "createTree", tree: { effects: [] } }] })
      === "bad write args: ops[0].tree.effects: a read field a write cannot set yet. Nothing was changed.");
    ok("[TREE-DRY] …and passes a valid one", argsShapeError("write", { ops: [{ op: "createTree", tree: signIn() }] }) === null);
    ok("[TREE-DRY] a non-object tree is refused", /tree: must be a node object/.test(argsShapeError("write", { ops: [{ op: "createTree", tree: "screen" }] }) ?? ""));
  },
}, {
  name: "design-system references (createTree): instances, variables and text styles by name, bound in one call",
  async run() {
    const w = await treeWorld({ kit: true });
    const { api, alive } = w;
    const r = await api.applyWrites([{ op: "createTree", tree: {
      name: "Checkout", handle: "root", layout: { display: "flex", flexDirection: "column", padding: [16, 16, 16, 16] },
      fills: [{ type: "solid", tokens: { color: "color/brand" } }],
      tokens: { itemSpacing: "space/md", paddingTop: "space/md", paddingRight: "space/md", paddingBottom: "space/md", paddingLeft: "space/md" },
      children: [
        { text: "Order summary", handle: "title", styles: { text: "Heading/H1" }, font: { size: 40, family: "Inter", align: "center" } },
        { text: "Free delivery", tokens: { fills: "color/brand" } },
        { name: "Card", radius: 4, tokens: { topLeftRadius: "radius/md" }, strokes: { colors: ["#cccccc"], weight: 1 } },
        { component: "Button", handle: "pay", props: { Size: "Large", Label: "Pay now", Icon: true }, widthMode: "fill" },
        { type: "INSTANCE", component: "local-5:3", name: "New" },
      ] } }]);
    const a = r.applied[0];
    const root = alive().find((n) => n.id === a?.id);
    const [title, note, card, pay, badge] = kids(root);
    ok("[REFS] one call: ok, instances counted, handles back, nothing imported", r.ok === true
      && JSON.stringify(a?.created) === JSON.stringify({ frames: 2, texts: 2, instances: 2 }) && a?.handles?.pay === pay?.id && w.imports.length === 0);
    ok("[REFS] a paint names a variable: bound, with no raw colour given",
      JSON.stringify(root?.fills) === JSON.stringify([{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:30:1" } } }]));
    ok("[REFS] spacing fields name a number variable: bound after the raw values",
      JSON.stringify(root?.boundVariables) === JSON.stringify(Object.fromEntries(["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => [k, { type: "VARIABLE_ALIAS", id: "VariableID:30:2" }]))));
    ok("[REFS] a text names a text style: set, in the style's font; the font fields it sets are not set, the rest are",
      title?.textStyleId === "S:h1," && JSON.stringify(title.fontName) === JSON.stringify({ family: "Inter", style: "Bold" }) && title.fontSize === 12 && title.textAlignHorizontal === "CENTER");
    ok("[REFS] …and the reply warns that the style sets them", JSON.stringify(r.warnings) === JSON.stringify(["ops[0].tree.children[0]: `font.family`, `font.size` are set by the text style, so they are not set"]));
    ok("[REFS] `tokens.fills` on a text with no fills: one bound paint", JSON.stringify((note?.fills as unknown[] | undefined)?.map((p) => isNode(p) ? p.boundVariables : null)) === JSON.stringify([{ color: { type: "VARIABLE_ALIAS", id: "VariableID:30:1" } }]));
    ok("[REFS] a corner names a variable; the raw radius stays on the others", num(card, "cornerRadius") === 4 && JSON.stringify(card?.boundVariables) === JSON.stringify({ topLeftRadius: { type: "VARIABLE_ALIAS", id: "VariableID:30:3" } }));
    ok("[REFS] an instance of a component set: made from its default variant, switched to the variant its props pick, properties keyed as Figma takes them",
      pay?.type === "INSTANCE" && isNode(pay.mainComponent) && pay.mainComponent.id === "5:6" && pay.layoutSizingHorizontal === "FILL"
      && JSON.stringify(pay.props) === JSON.stringify({ Size: "Large", "Label#1:0": "Pay now", "Icon#1:1": true }));
    ok("[REFS] a component by its key, renamed", badge?.type === "INSTANCE" && isNode(badge.mainComponent) && badge.mainComponent.id === "5:3" && badge.name === "New" && badge.props !== undefined);
    ok("[REFS] raw values are counted as unbound (the card's stroke colour, weight and the note's raw font)", a?.unbound === 4);
    // Hug follows the variant the props pick: the default Chip has no auto-layout, the Large one has.
    const chips = await api.applyWrites([{ op: "createTree", tree: { layout: { display: "flex" }, children: [{ component: "Chip", props: { Size: "Large", Tone: "On" }, widthMode: "hug" }] } }]);
    const flat = await api.applyWrites([{ op: "createTree", tree: { layout: { display: "flex" }, children: [{ component: "Chip", widthMode: "hug" }] } }]);
    ok("[REFS] an instance may hug when the variant its props pick has auto-layout, not when the default it stays on has none",
      chips.ok === true && flat.ok === false && /component 'Chip' has no auto-layout, so its instance cannot `widthMode: "hug"`/.test(flat.error ?? ""));
    // A combination of variant values the set does not have is refused (Figma would leave the instance on another one).
    const sparse = await api.applyWrites([{ op: "createTree", tree: { children: [{ component: "Chip", props: { Size: "Large" } }] } }]);
    ok("[REFS] a variant combination the set lacks is refused, with the variants it has",
      sparse.ok === false && /tree\.children\[0\]\.component: component 'Chip' has no variant Size=Large, Tone=Off; closest: /.test(sparse.error ?? ""));
    // A variant picked by id, with no variant values given, is the one checked (not a twin with the same values).
    const picked = await api.applyWrites([{ op: "createTree", tree: { layout: { display: "flex" }, children: [{ component: "7:3", widthMode: "hug" }] } }]);
    ok("[REFS] a variant picked by id and given no variant values is checked as itself", picked.ok === true);
    // A styled text's own font axes set nothing, so a family the file lacks is not checked for them.
    const axes = await api.applyWrites([{ op: "createTree", tree: { children: [{ text: "Hello", styles: { text: "Body" }, font: { family: "Ignored Font", variationSettings: { wght: 600 } } }] } }]);
    ok("[REFS] a styled text's font axes are not checked (the style sets the font)", axes.ok === true);
  },
}, {
  name: "design-system references (createTree): every bad name refused in one reply, with candidates; nothing imported",
  async run() {
    const w = await treeWorld({ kit: true });
    const { api, alive } = w;
    const before = alive().length;
    const r = await api.applyWrites([{ op: "createTree", tree: { layout: { display: "flex" }, children: [
      { component: "Buton" },
      { component: "Card" },
      { component: "Button", props: { Sise: "Large", Size: "Huge", Icon: "yes", Glyph: "9:9" } },
      { component: "Badge", widthMode: "hug" },
      { fills: [{ type: "solid", tokens: { color: "color/brnd" } }] },
      { fills: [{ type: "solid", tokens: { color: "color/text" } }] },
      { fills: [{ type: "solid", tokens: { color: "space/md" } }] },
      { text: "a", styles: { text: "Heading/H2" } },
      { text: "b", styles: { text: "Fancy" } },
      { component: KEY("e") },
      { fills: [{ type: "solid", tokens: { color: "color/brnd" } }] },
    ] } }]);
    const err = r.error ?? "";
    const has = (line: string): boolean => err.split("\n").includes(line);
    ok("[REFS-REFUSE] refused whole, nothing made, nothing imported (a library item waits for the whole batch)",
      r.ok === false && r.failedAt === 0 && alive().length === before && w.imports.length === 0);
    ok("[REFS-REFUSE] a component that matches nothing: the nearest names", has("ops[0] (createTree): tree.children[0].component: component 'Buton' matches no component in this file (a library component is named by its key); closest: 'Button', 'Badge', 'Twin'"));
    ok("[REFS-REFUSE] a component that matches two: pass a key or id", has("ops[0] (createTree): tree.children[1].component: component 'Card' matches 2 components — pass one's key or id: 'Card' (5:4), 'Card' (5:5)"));
    ok("[REFS-REFUSE] property names and values checked against the component, every one at once",
      has("ops[0] (createTree): tree.children[2].component: component 'Button' has no property 'Sise'; closest: 'Size', 'Label', 'Icon'; property 'Size' of 'Button' has no value \"Huge\"; closest: 'Large', 'Small', 'Medium'; "
        + "property 'Icon' of 'Button' is a boolean: give true or false; property 'Glyph' of 'Button' swaps a nested instance, which a write cannot set yet"));
    ok("[REFS-REFUSE] an instance cannot hug when its component has no auto-layout", has("ops[0] (createTree): tree.children[3].component: component 'Badge' has no auto-layout, so its instance cannot `widthMode: \"hug\"`"));
    ok("[REFS-REFUSE] a variable that matches nothing: candidates from the file and the library, reported once with how many more places",
      has("ops[0] (createTree): tree.children[4].fills[0].tokens.color: variable 'color/brnd' matches no variable in this file or an enabled library; closest: 'color/brand', 'color/text', 'color/accent' (and 1 more place in this spec)"));
    ok("[REFS-REFUSE] a variable that matches two", has("ops[0] (createTree): tree.children[5].fills[0].tokens.color: variable 'color/text' matches 2 variables — pass one's key or id: 'color/text' (VariableID:30:4), 'color/text' (VariableID:31:4)"));
    ok("[REFS-REFUSE] a number variable on a paint", has("ops[0] (createTree): tree.children[6].fills[0].tokens.color: variable 'space/md' holds a float, and this field takes a color variable"));
    ok("[REFS-REFUSE] a text style that matches nothing, and one whose font the file lacks",
      has("ops[0] (createTree): tree.children[7].styles.text: text style 'Heading/H2' matches no text style in this file (a library style is named by its key); closest: 'Heading/H1', 'Fancy', 'Body'")
      && has("ops[0] (createTree): tree.children[8].styles.text: text style 'Fancy': its font 'Papyrus Regular' is not available in this file; closest: 'Inter Regular', 'Roboto Regular', 'Inter Bold'"));
    ok("[REFS-REFUSE] one refusal lists them all", /^9 problems — nothing was changed:\n/.test(err));
  },
}, {
  name: "design-system references (createTree): library items import only once the batch resolved, under Allow edits",
  async run() {
    const w = await treeWorld({ kit: true });
    const { api, alive } = w;
    const spec = { layout: { display: "flex" }, tokens: { itemSpacing: "space/lg" }, fills: [{ type: "solid", tokens: { color: "color/accent" } }], children: [
      { component: KEY("e"), props: { Initials: "JD" } },
      { text: "Hi", styles: { text: KEY("f") } },
      { text: "Again", styles: { text: KEY("f") } },
    ] };
    const r = await api.applyWrites([{ op: "createTree", tree: spec }]);
    const root = alive().find((n) => n.id === r.applied[0]?.id);
    const [avatar, hi] = kids(root);
    ok("[REFS-LIB] library variables by name and a component and style by key: each imported once, then used", r.ok === true
      && JSON.stringify(w.imports) === JSON.stringify(["variable " + KEY("c"), "variable " + KEY("d"), "component " + KEY("e"), "style " + KEY("f")])
      && isNode(avatar?.mainComponent) && avatar.mainComponent.id === "9:1" && JSON.stringify(avatar.props) === JSON.stringify({ "Initials#2:0": "JD" })
      && hi?.textStyleId === "S:caption," && JSON.stringify(root?.boundVariables) === JSON.stringify({ itemSpacing: { type: "VARIABLE_ALIAS", id: "VariableID:lib/1:2" } }));
    // A key no library publishes: tried (it may be a library's), and the refusal says so — nothing built.
    const before = alive().length;
    const missing = await api.applyWrites([{ op: "createTree", tree: { children: [{ component: KEY("a") }] } }]);
    ok("[REFS-LIB] a key no library has: refused after the import is tried, nothing built",
      missing.ok === false && alive().length === before && w.imports.includes("component " + KEY("a")) && w.imports.includes("component set " + KEY("a"))
      && /tree\.children\[0\]\.component: no component in this file or an enabled library has the key 'a{40}'/.test(missing.error ?? ""));
    // A batch with any other problem imports nothing (a bad page here), and Allow edits off imports nothing either.
    const n = w.imports.length;
    const badPage = await api.applyWrites([{ op: "createTree", page: "Nowhere", tree: spec }]);
    ok("[REFS-LIB] another problem in the batch: nothing is imported", badPage.ok === false && w.imports.length === n);
    // Unticked while a text style is being set: the build stops and the hidden root is removed.
    w.hooks.onStyle = async () => { await w.allowEdits(false); };
    const mid = await api.applyWrites([{ op: "createTree", tree: { children: [{ text: "x", styles: { text: "Body" } }] } }]);
    w.hooks.onStyle = undefined;
    ok("[REFS-LIB] Allow edits turned off while a text style is set: refused as edits-off, the half-built tree removed",
      mid.ok === false && mid.refused === "edits-off" && alive().length === before);
    // Unticked during the first of two imports: the second never runs.
    await w.allowEdits(true);
    w.hooks.onImport = async () => { await w.allowEdits(false); };
    const m = w.imports.length;
    const raced = await api.applyWrites([{ op: "createTree", tree: { fills: [{ type: "solid", tokens: { color: KEY("c") } }], tokens: { itemSpacing: KEY("d") }, layout: { display: "flex" } } }]);
    w.hooks.onImport = undefined;
    ok("[REFS-LIB] unticked during an import: no further import runs, refused as edits-off, nothing built",
      raced.ok === false && raced.refused === "edits-off" && w.imports.length === m + 1 && alive().length === before);
    await w.allowEdits(true);
    // A key is exact: it imports the keyed component even though a local one is named exactly like the key.
    const k = w.imports.length;
    const keyed = await api.applyWrites([{ op: "createTree", tree: { children: [{ component: KEY("e") }] } }]);
    const keyedInst = kids(alive().find((n) => n.id === keyed.applied[0]?.id))[0];
    ok("[REFS-LIB] a key beats a local component named like it", keyed.ok === true && w.imports.length === k + 1
      && isNode(keyedInst?.mainComponent) && keyedInst.mainComponent.id === "9:1");
    // An unpublished key used twice: one problem, with how many more places.
    const twice = await api.applyWrites([{ op: "createTree", tree: { children: [{ fills: [{ type: "solid", tokens: { color: KEY("b") } }] }, { fills: [{ type: "solid", tokens: { color: KEY("b") } }] }] } }]);
    ok("[REFS-LIB] a failed import is reported once per name, with the other places counted",
      twice.ok === false && /^ops\[0\] \(createTree\): tree\.children\[0\]\.fills\[0\]\.tokens\.color: no variable in this file or an enabled library has the key 'b{40}'.* \(and 1 more place in this spec\)\. Nothing was changed\.$/.test(twice.error ?? ""));
  },
}, {
  name: "design-system references (createTree): the shape is checked by the dry run, the wire check and the plugin alike",
  async run() {
    const bad = { layout: { display: "flex" }, tokens: { counterAxisSpacing: "space/md", cornerRadius: "radius/md" }, styles: { text: "Body", fill: "Brand" }, children: [
      { component: "Button", children: [{ text: "x" }], fills: [] },
      { name: "Box", props: { a: "b" }, tokens: { itemSpacing: "space/md", fills: "color/brand" }, fills: [{ type: "solid", color: "#fff" }] },
      { text: "t", tokens: { itemSpacing: "space/md" }, strokes: { colors: ["#000", "#111"] }, styles: {} },
      { text: "u", tokens: { strokes: ["a"] }, strokes: { colors: ["#000", "#111"] } },
      { fills: [{ type: "solid" }] },
      { type: "INSTANCE" },
    ] };
    const step = writeOpPreview({ op: "createTree", tree: bad }, 0);
    const lines = (step.invalid ?? "").split("\n");
    const want = [
      "tree.tokens.cornerRadius: a read field a write cannot set yet — bind each corner: topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius",
      "tree.styles.fill: a read field a write cannot set yet — bind the paint to a colour variable instead: `fills[].tokens.color`",
      "tree: `styles.text` is only on a TEXT node",
      "tree: `tokens.counterAxisSpacing` is the gap between wrapped tracks: it needs `layout.flexWrap: \"wrap\"`",
      "tree.children[0]: `children` is not on an INSTANCE node (its content comes from its component; set its `props`)",
      "tree.children[0]: `fills` is not on an INSTANCE node (its content comes from its component; set its `props`)",
      "tree.children[1]: `props` is only on an INSTANCE node",
      "tree.children[1]: `tokens.itemSpacing` needs auto-layout on the node (layout.display \"flex\")",
      "tree.children[1]: `tokens.fills` names 'color/brand', which no paint in `fills` is bound to; bind the paint instead: `fills[i].tokens.color`",
      "tree.children[2]: `tokens.itemSpacing` is not on a TEXT node",
      "tree.children[3]: `tokens.strokes` names 1 variable for 2 stroke colours; give one per colour, in order (or leave `strokes.colors` out)",
      "tree.children[4].fills[0] is missing color (a hex colour, or a colour variable in `tokens.color`)",
      "tree.children[5]: an INSTANCE node needs `component` (a component's name, key or id)",
    ];
    const missing = want.filter((l) => !lines.includes(l));
    ok("[REFS-SHAPE] every shape problem, by path" + (missing.length ? " (missing: " + missing.join(" | ") + "; got: " + lines.join(" | ") + ")" : ""), missing.length === 0 && lines.length === want.length);
    ok("[REFS-SHAPE] the wire check refuses the same spec", (argsShapeError("write", { ops: [{ op: "createTree", tree: bad }] }) ?? "").includes(want[0] ?? "?"));
    const good = writeOpPreview({ op: "createTree", tree: { name: "Pay", layout: { display: "flex" }, tokens: { itemSpacing: "space/md" }, fills: [{ type: "solid", tokens: { color: "color/brand" } }], children: [
      { component: "Button", props: { Size: "Large" } }, { component: "Button" }, { text: "Hi", styles: { text: "Body" } }, { text: "Raw", font: { color: "#000000" } },
    ] } }, 0);
    ok("[REFS-SHAPE] the dry run names every component, variable and text style, and the unbound count",
      good.invalid === undefined && good.change === "creates frame 'Pay', horizontal auto-layout with 5 nodes (1 frame, 2 texts, 2 instances) on the current page, placed beside the existing frames; "
        + "fonts 'Inter Regular'; components 'Button'; variables 'color/brand', 'space/md'; text styles 'Body'; 2 raw values left unbound — "
        + "the page, fonts and names are checked against the file when applied (a library item is imported only then), and nothing lands unless all of it does");
  },
}, {
  name: "patch by id: every field set on an existing node, design-system names resolved, one undo step",
  async run() {
    const p = await patchWorld();
    const { w, h, node } = p;
    const commits = w.undo.commits;
    const r = await w.api.applyWrites([
      { op: "patch", nodeId: h.email, set: { text: "jane@example.com", fills: [{ type: "solid", tokens: { color: "color/brand" } }], styles: { text: "Body" } } },
      { op: "patch", nodeId: h.card, set: { name: "Card 2", opacity: 0.5, radius: { tl: 2 }, layout: { gap: 6, justifyContent: "center" }, box: { w: 300 },
        strokes: { colors: ["#000000"], weight: 2, align: "outside" }, tokens: { paddingTop: "space/md" } } },
      { op: "patch", nodeId: h.btn, set: { props: { Size: "Large", Label: "Pay" } } },
      { op: "patch", nodeId: h.spare, set: { hidden: true, widthMode: "fill" } },
      { op: "patch", nodeId: h.screen, set: { layout: { gap: 24 } } },
    ]);
    const email = node("email"), card = node("card"), btn = node("btn"), spare = node("spare"), screen = node("screen");
    ok("[PATCH] one batch: ok, one row per op with the node's id, and the raw values counted as unbound",
      r.ok === true && JSON.stringify(r.applied) === JSON.stringify([{ id: h.email }, { id: h.card, unbound: 4 }, { id: h.btn }, { id: h.spare }, { id: h.screen, unbound: 1 }]));
    ok("[PATCH] text: the characters, a paint bound to a colour variable, the text style (in its font)",
      email?.characters === "jane@example.com" && email.textStyleId === "S:body," && boundColor(email) === "VariableID:30:1");
    ok("[PATCH] frame: name, opacity, one corner, gap and alignment (the padding untouched), width fixed, strokes",
      card?.name === "Card 2" && card.opacity === 0.5 && card.topLeftRadius === 2 && card.topRightRadius === 8 && card.itemSpacing === 6
      && card.primaryAxisAlignItems === "CENTER" && card.paddingLeft === 8 && card.width === 300 && card.height === 80 && card.strokeWeight === 2 && card.strokeAlign === "OUTSIDE"
      && JSON.stringify(card.strokes) === JSON.stringify([{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]));
    ok("[PATCH] a number field bound to a variable by name", JSON.stringify(card?.boundVariables) === JSON.stringify({ paddingTop: { type: "VARIABLE_ALIAS", id: "VariableID:30:2" } }));
    ok("[PATCH] instance: a variant value and a text property, keyed as Figma takes them",
      isNode(btn?.mainComponent) && btn.mainComponent.id === "5:6" && isNode(btn.props) && btn.props.Size === "Large" && btn.props["Label#1:0"] === "Pay" && Object.keys(btn.props).length === 2);
    ok("[PATCH] visibility and sizing", spare?.visible === false && spare.layoutSizingHorizontal === "FILL");
    ok("[PATCH] a raw value where a variable was bound replaces it (the binding goes, as in Figma)",
      screen?.itemSpacing === 24 && JSON.stringify(screen.boundVariables) === "{}");
    ok("[PATCH] the batch is one undo step", w.undo.commits === commits + 2);

    // `null` in tokens unbinds and keeps the value; a library variable named in a patch is imported only once the
    // batch resolved, and then bound.
    const lib = await w.api.applyWrites([
      { op: "patch", nodeId: h.card, set: { tokens: { paddingTop: null, itemSpacing: "space/lg" } } },
      { op: "patch", nodeId: h.email, set: { tokens: { fills: null } } },
    ]);
    ok("[PATCH] tokens: null unbinds (the value stays), a library variable by name is imported and bound",
      lib.ok === true && JSON.stringify(node("card")?.boundVariables) === JSON.stringify({ itemSpacing: { type: "VARIABLE_ALIAS", id: "VariableID:lib/1:2" } })
      && node("card")?.paddingTop === 8 && JSON.stringify(w.imports) === JSON.stringify(["variable " + KEY("d")]) && boundColor(node("email")) === null);
    // Turning auto-layout off and back on, and fixing a size the other way round.
    const off = await w.api.applyWrites([{ op: "patch", nodeId: h.card, set: { layout: { mode: "absolute" } } }]);
    ok("[PATCH] layout {mode: absolute} removes auto-layout", off.ok === true && node("card")?.layoutMode === "NONE");
    const on = await w.api.applyWrites([{ op: "patch", nodeId: h.card, set: { layout: { display: "flex", flexDirection: "column" }, heightMode: "hug" } }]);
    ok("[PATCH] layout display flex turns it on in the given direction; hug then applies", on.ok === true && node("card")?.layoutMode === "VERTICAL" && node("card")?.layoutSizingVertical === "HUG");
  },
}, {
  name: "patch by id: a failing op puts back every value the batch changed (patches, fills, texts, created and moved nodes)",
  async run() {
    const p = await patchWorld();
    const { w, h, state } = p;
    const before = state();
    const commits = w.undo.commits;
    w.trap.add("cornerRadius"); // Figma refuses this value partway through the last op
    const r = await w.api.applyWrites([
      { op: "patch", nodeId: h.email, set: { text: "changed", fills: [{ type: "solid", color: "#ff0000" }], styles: { text: "Heading/H1" } } },
      { op: "patch", nodeId: h.card, set: { name: "Renamed", opacity: 0.2, layout: { mode: "absolute" }, box: { w: 10, h: 10 }, radius: { tl: 1, br: 3 }, strokes: { colors: ["#00ff00"], weight: 4 } } },
      { op: "patch", nodeId: h.btn, set: { props: { Size: "Large", Label: "Pay" } } },
      { op: "patch", nodeId: h.screen, set: { layout: { gap: 40, padding: [1, 2, 3, 4] }, hidden: true } },
      { op: "setFill", nodeId: h.card, color: "#123456" },
      { op: "setText", nodeId: h.inside, text: "moved text" },
      { op: "createFrame", name: "Temp", parentId: h.screen },
      { op: "move", nodeId: h.spare, parentId: h.card, index: 0 },
      { op: "patch", nodeId: h.spare, set: { name: "Never", radius: 3 } },
    ]);
    w.trap.clear();
    const after = state();
    const diff = Object.keys(before).filter((k) => before[k] !== after[k]);
    ok("[ROLLBACK] the batch fails at the op Figma refused, nothing stays applied, the eight earlier changes are listed as restored",
      r.ok === false && r.failedAt === 8 && r.failedOp === "patch" && /cannot set cornerRadius/.test(r.error ?? "") && r.applied.length === 0 && (r.restored ?? []).length === 8);
    ok(`[ROLLBACK] every node is exactly as it was: text, style, fills, layout, size, corners, strokes, variant, binding, parent and place (differs: ${diff.join(", ") || "none"})`, diff.length === 0);
    ok("[ROLLBACK] the frame the batch created is gone", !w.alive().some((n) => n.name === "Temp"));
    ok("[ROLLBACK] a failed batch is still one undo step", w.undo.commits === commits + 2);
    ok("[ROLLBACK] the toast says the changes were undone", w.notified.some((t) => /undid 8 earlier changes after an edit failed/.test(t)));
  },
}, {
  name: "patch by id: every problem refused up front, names resolved like the tree spec, nothing changed or imported",
  async run() {
    const p = await patchWorld();
    const { w, h, state } = p;
    const before = state();
    const r = await w.api.applyWrites([
      { op: "patch", nodeId: h.email, set: { fills: [{ type: "solid", tokens: { color: "color/brnad" } }], styles: { text: "Bdy" } } },
      { op: "patch", nodeId: h.email, set: { tokens: { itemSpacing: "space/md" } } },
      { op: "patch", nodeId: h.card, set: { text: "x", props: { a: "b" } } },
      { op: "patch", nodeId: h.spare, set: { layout: { gap: 4 }, heightMode: "hug" } },
      { op: "patch", nodeId: h.btn, set: { props: { Size: "Huge", Labl: "x" } } },
      { op: "patch", nodeId: "gone:1", set: { name: "x" } },
      { op: "patch", nodeId: h.card, set: { fills: [{ type: "solid", tokens: { color: "space/md" } }, { type: "solid", tokens: { color: "color/text" } }], tokens: { itemSpacing: "space/lg" } } },
      { op: "createFrame", name: "never" },
    ]);
    const err = r.error ?? "";
    const has = (re: RegExp, what: string): void => { ok("[PATCH-REFUSE] " + what, re.test(err)); };
    ok("[PATCH-REFUSE] refused whole before anything ran: nothing changed, nothing made, nothing imported",
      r.ok === false && r.failedAt === 0 && r.applied.length === 0 && /nothing was changed/i.test(err) && JSON.stringify(state()) === JSON.stringify(before)
      && !w.alive().some((n) => n.name === "never") && w.imports.length === 0);
    has(/ops\[0\] \(patch\): set\.fills\[0\]\.tokens\.color: variable 'color\/brnad' matches no variable in this file or an enabled library; closest: 'color\/brand'/, "a variable that matches nothing, with candidates");
    has(/ops\[0\] \(patch\): set\.styles\.text: text style 'Bdy' matches no text style in this file .*closest: 'Body'/, "a text style that matches nothing, with candidates");
    has(/ops\[1\] \(patch\): set\.tokens\.itemSpacing: 'email' is a TEXT, which has no `itemSpacing` to bind/, "a field the node does not have");
    has(/ops\[2\] \(patch\): set\.text: only on a TEXT node; 'Card' is a FRAME/, "a text field on a frame");
    has(/ops\[2\] \(patch\): set\.props: only on an INSTANCE node/, "props on a frame");
    // A check that reads the file's state (auto-layout here) runs up front for the first op that could see it; after an
    // op that could change it, right before the op applies (below).
    ok("[PATCH-REFUSE] after other ops, a state check is not made up front", !/ops\[3\]/.test(err));
    const alone = (await w.api.applyWrites([{ op: "patch", nodeId: h.spare, set: { layout: { gap: 4 }, heightMode: "hug" } }])).error ?? "";
    ok("[PATCH-REFUSE] a gap on a frame without auto-layout", /ops\[0\] \(patch\): set\.layout: 'Spare' has no auto-layout, so `layout\.gap` would do nothing; add `display: "flex"`/.test(alone));
    ok("[PATCH-REFUSE] hug without auto-layout", /ops\[0\] \(patch\): set\.heightMode: "hug" needs auto-layout on the node/.test(alone));
    const late = await w.api.applyWrites([{ op: "patch", nodeId: h.card, set: { name: "First" } }, { op: "patch", nodeId: h.spare, set: { layout: { gap: 4 } } }]);
    ok("[PATCH-REFUSE] …and after another op, the same check right before the op runs: the batch fails there and is put back",
      late.ok === false && late.failedAt === 1 && /has no auto-layout/.test(late.error ?? "") && /checked right before this op ran/.test(late.error ?? "")
      && (late.restored ?? []).length === 1 && p.node("card")?.name === "Card");
    has(/ops\[4\] \(patch\): set\.props: property 'Size' of 'Button' has no value "Huge"/, "a variant value the component lacks");
    has(/ops\[4\] \(patch\): set\.props: component 'Button' has no property 'Labl'; closest: 'Label'/, "a property the component lacks");
    has(/ops\[5\] \(patch\): no node with id 'gone:1'/, "a missing node");
    has(/ops\[6\] \(patch\): set\.fills\[0\]\.tokens\.color: variable 'space\/md' holds a float, and this field takes a color variable/, "a number variable on a paint");
    has(/ops\[6\] \(patch\): set\.fills\[1\]\.tokens\.color: variable 'color\/text' matches 2 variables/, "a variable name that matches two");
    ok("[PATCH-REFUSE] the library variable a refused batch names is not imported", w.imports.length === 0 && !/ops\[7\]/.test(err));

    // The shape: checked the same by the dry run, the wire and the plugin.
    const shape = checkPatch({ font: { size: 3 }, fills: "red", box: { w: 10 }, widthMode: "fill", colour: "#fff", x: 4 });
    ok("[PATCH-SHAPE] read fields refused by name, bad values and unknown keys with the nearest names",
      shape.problems.some((m) => /^set\.font: a patch cannot set it — a text's font cannot be patched yet/.test(m))
      && shape.problems.some((m) => /^set\.x: a patch cannot set it/.test(m))
      && shape.problems.some((m) => /^set\.colour: not a field a patch sets/.test(m))
      && shape.problems.some((m) => /^set\.fills must be a list of paints/.test(m)));
    ok("[PATCH-SHAPE] contradicting fields refused", checkPatch({ box: { w: 10 }, widthMode: "fill" }).problems.some((m) => /`box\.w` gives a fixed width, which `widthMode: "fill"` contradicts/.test(m)));
    ok("[PATCH-SHAPE] an empty patch sets nothing", checkPatch({}).problems.some((m) => /sets nothing/.test(m)));
    const bad = { op: "patch" as const, nodeId: "1:2", set: { box: { w: 10 }, widthMode: "fill" } };
    const step = writeOpPreview(bad, 0);
    const applied = await w.api.applyWrites([{ ...bad }]);
    ok("[PATCH-SHAPE] the dry run, the wire check and the plugin refuse the same patch",
      step.invalid !== undefined && argsShapeError("write", { ops: [bad] }) !== null && applied.ok === false && /contradicts/.test(applied.error ?? ""));
    const good = writeOpPreview({ op: "patch", nodeId: "1:2", set: { text: "Hi", fills: [{ type: "solid", tokens: { color: "color/brand" } }], radius: 4 } }, 2);
    ok("[PATCH-PREVIEW] the dry run: an overwrite of the node, one row per field (in the order applied), the change in words",
      good.effect === "overwrites" && good.target === "1:2" && good.invalid === undefined
      && JSON.stringify(good.fields) === JSON.stringify([{ field: "radius", to: "4" }, { field: "fills", to: '[{"type":"solid","tokens":{"color":"color/brand"}}]' }, { field: "text", to: '"Hi"' }])
      && good.change === "node 1:2: sets radius, fills, text; variables 'color/brand'; 1 raw value left unbound — the node, its kind and the names are checked against the file when applied; the values it replaces are kept, and put back if a later op of the batch fails");
  },
}, {
  name: "move and delete: only nodes this session created; deletes run last; a move is put back on failure",
  async run() {
    const p = await patchWorld();
    const { w, h, node } = p;
    const made = await w.api.applyWrites([{ op: "createTree", tree: { name: "Box", handle: "box", layout: { display: "flex" }, children: [
      { name: "A", handle: "a", children: [{ text: "a1", handle: "a1" }] }, { name: "B", handle: "b" }, { component: "Badge", handle: "badge" },
    ] } }]);
    const m = made.applied[0]?.handles ?? {};
    const id = (k: string): string => m[k] ?? "?";
    const refused = async (ops: Array<{ op: string } & Record<string, unknown>>, re: RegExp, what: string): Promise<void> => {
      const r = await w.api.applyWrites(ops);
      ok("[STRUCTURE] " + what + " (" + (r.error ?? "").split("\n")[0] + ")", r.ok === false && r.applied.length === 0 && re.test(r.error ?? ""));
    };
    await refused([{ op: "delete", nodeId: "1:1" }], /node 'Existing A' \(1:1\): this plugin session did not create it/, "a node the session did not create cannot be deleted");
    await refused([{ op: "move", nodeId: "1:1", parentId: id("box") }], /node 'Existing A' \(1:1\): this plugin session did not create it/, "…or moved");
    await refused([{ op: "move", nodeId: id("a"), parentId: id("a") }], /is the node itself/, "a node cannot move into itself");
    await refused([{ op: "move", nodeId: id("box"), parentId: id("a") }], /is inside the node/, "…or below itself");
    await refused([{ op: "move", nodeId: id("b"), parentId: id("a1") }], /is a TEXT, which cannot have children/, "a text cannot take children");
    await refused([{ op: "move", nodeId: id("b"), parentId: id("badge") }], /is an instance, which cannot take new children/, "an instance cannot take children");
    await refused([{ op: "move", nodeId: id("b"), parentId: id("a"), index: 5 }], /index 5 is past the end/, "an index past the end");
    await refused([{ op: "patch", nodeId: id("a1"), set: { text: "x" } }, { op: "delete", nodeId: id("a") }], /ops\[0\] \(patch\): `nodeId` '.*' is deleted by ops\[1\]/, "an op on a node a delete in the same batch removes");
    await refused([{ op: "delete", nodeId: id("a") }, { op: "createFrame", parentId: id("a") }], /ops\[1\] \(createFrame\): `parentId` '.*' is deleted by ops\[0\]/, "a create into a node the batch deletes");

    // Valid: deletes run after the rest, and the reply keeps op order.
    const ok1 = await w.api.applyWrites([{ op: "delete", nodeId: id("a1") }, { op: "move", nodeId: id("b"), parentId: id("a"), index: 0 }]);
    ok("[STRUCTURE] delete and move a session's nodes: ok, rows in op order", ok1.ok === true
      && JSON.stringify(ok1.applied) === JSON.stringify([{ id: id("a1"), deleted: true }, { id: id("b"), parentId: id("a") }]));
    ok("[STRUCTURE] …the text is gone and B is A's first child", (await w.figma.getNodeByIdAsync(id("a1"))) === null && kids(node("a", m)).map((k) => k.id).join() === id("b"));
    // A move is put back when a later op fails.
    w.trap.add("cornerRadius");
    const back = await w.api.applyWrites([{ op: "move", nodeId: id("b"), parentId: id("box"), index: 0 }, { op: "patch", nodeId: id("b"), set: { radius: 2 } }]);
    w.trap.clear();
    ok("[STRUCTURE] a failed batch returns a moved node to its parent and place", back.ok === false && back.restored?.[0]?.parentId === id("box")
      && parentOf(node("b", m))?.id === id("a") && kids(node("a", m))[0]?.id === id("b"));
    // A node the designer put inside one the session created: the delete would take it too, so it is refused.
    const existing = w.alive().length;
    const foreign = await w.figma.getNodeByIdAsync("1:2");
    const a = node("a", m);
    if (foreign && a && typeof a.appendChild === "function") (a.appendChild as (c: FakeNode) => void)(foreign);
    await refused([{ op: "delete", nodeId: id("a") }], /holds 'Existing B' \(1:2\), which this plugin session did not create/, "a delete that would take a node the session did not create");
    // A frame created into a node the same batch deletes would conflict; a frame created earlier is the session's own.
    const late = await w.api.applyWrites([{ op: "delete", nodeId: id("badge") }]);
    ok("[STRUCTURE] an instance the session created is deleted whole", late.ok === true && (await w.figma.getNodeByIdAsync(id("badge"))) === null && w.alive().length === existing - 1);
    ok("[STRUCTURE] the dry run says what a move and a delete do",
      writeOpPreview({ op: "delete", nodeId: "1:2" }, 0).effect === "deletes" && /only a node this plugin session created/.test(writeOpPreview({ op: "delete", nodeId: "1:2" }, 0).change ?? "")
      && writeOpPreview({ op: "move", nodeId: "1:2", parentId: "1:3" }, 0).effect === "moves" && writeOpPreview({ op: "move", nodeId: "1:2" }, 0).invalid === "missing parentId");
    void h;
  },
}, {
  name: "patch rollback: shapes with one radius, mixed and styled text with overrides and bindings, paint styles, empty styled text",
  async run() {
    const RED = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }], STYLE_PAINTS = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }];
    // A rectangle linked to a fill and a stroke style: setting paints detaches the style, as in Figma.
    const swatch: FakeNode = {
      id: "sw:1", type: "RECTANGLE", name: "Swatch", _fills: STYLE_PAINTS, fillStyleId: "S:paint", _strokes: STYLE_PAINTS, strokeStyleId: "S:line", strokeWeight: 1, strokeAlign: "INSIDE",
      get fills() { return swatch._fills; }, set fills(v: unknown) { swatch._fills = v; swatch.fillStyleId = ""; },
      get strokes() { return swatch._strokes; }, set strokes(v: unknown) { swatch._strokes = v; swatch.strokeStyleId = ""; },
      setFillStyleIdAsync: async (id: string) => { swatch.fillStyleId = id; swatch._fills = STYLE_PAINTS; },
      setStrokeStyleIdAsync: async (id: string) => { swatch.strokeStyleId = id; swatch._strokes = STYLE_PAINTS; },
    };
    const hex: FakeNode = { id: "pl:1", type: "POLYGON", name: "Hex", cornerRadius: 3 };
    const path: FakeNode = { id: "vc:1", type: "VECTOR", name: "Path", cornerRadius: 0 };
    const rich = runText("rx:1", [
      { text: "Hello ", fontSize: 22, fills: RED, boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "VariableID:30:2" } } },
      { text: "World", textStyleId: "S:h1,", fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 30, fills: STYLE_PAINTS, textDecoration: "UNDERLINE",
        textDecorationStyle: "WAVY", hyperlink: { type: "URL", value: "https://example.com" }, listOptions: { type: "UNORDERED" }, indentation: 1, listSpacing: 4 },
    ]);
    // Two runs with the same paints from two different paint styles: the links are kept run by run.
    const twins = runText("rx:3", [{ text: "ab", fills: STYLE_PAINTS, fillStyleId: "S:a" }, { text: "cd", fills: STYLE_PAINTS, fillStyleId: "S:b" }]);
    // A run whose text style uses one font while the run overrides it with another: putting the style back needs the
    // style's font, which nothing else in the batch loads.
    const font = { loaded: (_f: unknown): boolean => true };
    const overridden = runText("rx:4", [{ text: "Title", textStyleId: "S:h1,", fontName: { family: "Roboto", style: "Regular" } }], async () => {}, (f) => font.loaded(f));
    const p = await patchWorld({ "sw:1": swatch, "pl:1": hex, "vc:1": path, "rx:1": rich, "rx:3": twins, "rx:4": overridden });
    font.loaded = p.w.fontLoaded;
    const { w, h } = p;
    const fail = { op: "patch", nodeId: h.card, set: { radius: 1 } };
    const richBefore = runsOf(rich), twinsBefore = runsOf(twins), overriddenBefore = runsOf(overridden);
    const cardWidth = p.node("card")?.width;
    w.trap.add("cornerRadius");
    const r = await w.api.applyWrites([
      { op: "patch", nodeId: "pl:1", set: { radius: 9 } },
      { op: "patch", nodeId: "sw:1", set: { fills: [{ type: "solid", color: "#00ff00" }], strokes: { colors: ["#00ff00"] } } },
      { op: "setFill", nodeId: "sw:1", color: "#ffff00" },
      { op: "patch", nodeId: "rx:1", set: { text: "Bye", styles: { text: "Body" } } },
      { op: "patch", nodeId: "rx:3", set: { fills: [{ type: "solid", color: "#ff0000" }] } },
      { op: "patch", nodeId: "rx:4", set: { styles: { text: "Body" } } },
      { op: "patch", nodeId: h.card, set: { tokens: { minWidth: "size/min" } } },
      fail,
    ]);
    w.trap.clear();
    ok("[ROLLBACK-2] the batch fails and puts back all seven earlier changes (" + (r.error ?? "") + ")", r.ok === false && r.failedAt === 7 && (r.restored ?? []).length === 7 && r.applied.length === 0);
    ok("[ROLLBACK-2] runs with the same paints from two paint styles: each run's style link is put back", runsOf(twins) === twinsBefore);
    const legacy = await w.api.applyWrites([{ op: "setFill", nodeId: "rx:3", color: "#00ff00" }, { op: "setFill", nodeId: "gone:5", color: "#fff" }]);
    ok("[ROLLBACK-2] …and so does setFill on that text", legacy.ok === false && (legacy.restored ?? []).length === 1 && runsOf(twins) === twinsBefore);
    // An unstyled text given a style: the per-node properties the style replaced (leading trim, hanging punctuation and
    // list) go back with the rest.
    const email = p.node("email");
    const node3 = (): string => JSON.stringify([email?.leadingTrim, email?.hangingPunctuation, email?.hangingList, email?.textStyleId]);
    const was = node3();
    w.trap.add("cornerRadius");
    const styled = await w.api.applyWrites([{ op: "patch", nodeId: h.email, set: { styles: { text: "Heading/H1" } } }, fail]);
    w.trap.clear();
    ok("[ROLLBACK-2] a text style's per-node properties are put back too (" + node3() + ")", styled.ok === false && node3() === was);
    ok("[ROLLBACK-2] a style whose font a run overrides: the style's font was loaded up front, so the style and the override both go back", runsOf(overridden) === overriddenBefore);
    ok("[ROLLBACK-2] a size limit bound to a variable that grew the frame: the limit, the binding and the width go back",
      p.node("card")?.width === cardWidth && p.node("card")?.minWidth === null && !(isNode(p.node("card")?.boundVariables) && "minWidth" in (p.node("card")?.boundVariables as object)));
    ok("[ROLLBACK-2] a polygon's single corner radius is put back", hex.cornerRadius === 3);
    ok("[ROLLBACK-2] paints linked to a fill and a stroke style: the paints and the style links are put back",
      swatch.fillStyleId === "S:paint" && swatch.strokeStyleId === "S:line" && swatch.fills === STYLE_PAINTS && swatch.strokes === STYLE_PAINTS);
    ok("[ROLLBACK-2] a text of two runs (one unstyled with its size bound to a variable, one styled with overrides, a link, a list and a wavy underline) is put back run by run, bindings included",
      runsOf(rich) === richBefore);
    const vec = await w.api.applyWrites([{ op: "patch", nodeId: "vc:1", set: { radius: 4 } }]);
    ok("[ROLLBACK-2] a vector's per-vertex radius is refused (it could not be put back)", vec.ok === false && /a vector's corner radius is set per vertex/.test(vec.error ?? "") && path.cornerRadius === 0);

    // An empty text with a text style: its style stays when the batch puts the text back.
    const made = await w.api.applyWrites([{ op: "createTree", tree: { name: "Holder", children: [{ text: "", handle: "empty", styles: { text: "Body" } }] } }]);
    const empty = made.applied[0]?.handles?.empty ?? "";
    const emptyNode = w.alive().find((n) => n.id === empty);
    if (emptyNode) emptyNode.lineHeight = { unit: "PIXELS", value: 30 }; // an override on top of its style
    w.trap.add("cornerRadius");
    const e = await w.api.applyWrites([{ op: "patch", nodeId: empty, set: { text: "now full", styles: { text: "Heading/H1" } } }, fail]);
    w.trap.clear();
    ok("[ROLLBACK-2] an empty styled text gets its style back, and the override on top of it",
      e.ok === false && emptyNode?.characters === "" && emptyNode.textStyleId === "S:body," && JSON.stringify(emptyNode.lineHeight) === JSON.stringify({ unit: "PIXELS", value: 30 }));
  },
}, {
  name: "patch: bound instance properties, creates that fail partway, and a patch that depends on an earlier one",
  async run() {
    const p = await patchWorld();
    const { w, h, node } = p;
    const fail = { op: "patch", nodeId: h.card, set: { radius: 1 } };
    // An instance's text property bound to a variable: the binding goes back, not only the text it showed.
    const btn = node("btn");
    if (btn && typeof btn.setProperties === "function") (btn.setProperties as (p: Record<string, unknown>) => void)({ "Label#1:0": { type: "VARIABLE_ALIAS", id: "VariableID:30:9" } });
    const propsBefore = JSON.stringify(btn?.componentProperties);
    w.trap.add("cornerRadius");
    const r = await w.api.applyWrites([{ op: "patch", nodeId: h.btn, set: { props: { Label: "Pay" } } }, fail]);
    w.trap.clear();
    ok("[PATCH-MORE] a text property bound to a variable is bound again when the batch is put back",
      r.ok === false && JSON.stringify(btn?.componentProperties) === propsBefore && /VariableID:30:9/.test(propsBefore));

    // A create that fails after its node exists leaves no node behind, and nothing is reported as applied.
    const alive = w.alive().length;
    const intoInstance = await w.api.applyWrites([{ op: "createFrame", name: "Orphan", parentId: h.btn }]);
    ok("[PATCH-MORE] a parent that is an instance is refused before anything is made",
      intoInstance.ok === false && /is an instance, which cannot take new children/.test(intoInstance.error ?? "") && w.alive().length === alive);
    w.trap.add("layoutMode");
    const midway = await w.api.applyWrites([{ op: "createFrame", name: "Half", layoutMode: "VERTICAL", parentId: h.screen }]);
    w.trap.clear();
    ok("[PATCH-MORE] Figma refusing a value on a frame just made: the frame is removed, nothing applied",
      midway.ok === false && midway.applied.length === 0 && !w.made.some((n) => n.name === "Half" && !n.removed));
    const load = w.figma.loadFontAsync;
    w.figma.loadFontAsync = async () => { throw new Error("font failed to load"); };
    const noFont = await w.api.applyWrites([{ op: "createText", text: "x", parentId: h.screen }]);
    if (load) w.figma.loadFontAsync = load;
    ok("[PATCH-MORE] a text whose font fails to load: the empty text is removed, nothing applied", noFont.ok === false && noFont.applied.length === 0 && w.alive().length === alive);

    // A patch checked against what an earlier op of the batch leaves: auto-layout turned on, then a child fills it.
    const made = await w.api.applyWrites([{ op: "createTree", tree: { name: "Outer", handle: "outer", children: [{ name: "Inner", handle: "inner" }] } }]);
    const m = made.applied[0]?.handles ?? {};
    const dep = await w.api.applyWrites([{ op: "patch", nodeId: m.outer ?? "", set: { layout: { display: "flex" } } }, { op: "patch", nodeId: m.inner ?? "", set: { widthMode: "fill" } }]);
    ok("[PATCH-MORE] auto-layout turned on, then a child set to fill in the same batch: accepted and applied (" + (dep.error ?? "") + ")",
      dep.ok === true && node("inner", m)?.layoutSizingHorizontal === "FILL");
    const reversed = await w.api.applyWrites([{ op: "patch", nodeId: m.outer ?? "", set: { layout: { mode: "absolute" } } }, { op: "patch", nodeId: m.inner ?? "", set: { heightMode: "fill" } }]);
    // A move earlier in the batch gives the node its parent for the checks: moved into an auto-layout frame, then fill.
    const pair = await w.api.applyWrites([{ op: "createTree", tree: { name: "Flex", handle: "flex", layout: { display: "flex" } } }, { op: "createTree", tree: { name: "Loose", handle: "loose" } }]);
    const flexId = pair.applied[0]?.handles?.flex ?? "", looseId = pair.applied[1]?.handles?.loose ?? "";
    const moveFill = await w.api.applyWrites([{ op: "move", nodeId: looseId, parentId: flexId }, { op: "patch", nodeId: looseId, set: { widthMode: "fill" } }]);
    const loose = w.alive().find((n) => n.id === looseId);
    ok("[PATCH-MORE] moved into an auto-layout frame, then set to fill, in one batch: accepted (" + (moveFill.error ?? "") + ")",
      moveFill.ok === true && loose?.layoutSizingHorizontal === "FILL" && parentOf(loose)?.id === flexId);
    // Two moves into one empty parent in a batch: the second sees the first there.
    const trio = await w.api.applyWrites([{ op: "createTree", tree: { name: "Dest", handle: "d" } }, { op: "createTree", tree: { name: "A", handle: "a" } }, { op: "createTree", tree: { name: "B", handle: "b" } }]);
    const dId = trio.applied[0]?.handles?.d ?? "", aId = trio.applied[1]?.handles?.a ?? "", bId = trio.applied[2]?.handles?.b ?? "";
    const two = await w.api.applyWrites([{ op: "move", nodeId: aId, parentId: dId, index: 0 }, { op: "move", nodeId: bId, parentId: dId, index: 1 }]);
    ok("[PATCH-MORE] two moves into one empty parent: the second's index counts the first (" + (two.error ?? "") + ")",
      two.ok === true && kids(w.alive().find((n) => n.id === dId)).map((k) => k.id).join() === aId + "," + bId);
    // A child moved out of its parent, then the parent moved into it: valid in that order.
    const nest = await w.api.applyWrites([{ op: "createTree", tree: { name: "Outer2", handle: "o", children: [{ name: "Inner2", handle: "i" }] } }]);
    const oId = nest.applied[0]?.handles?.o ?? "", iId = nest.applied[0]?.handles?.i ?? "";
    const swap = await w.api.applyWrites([{ op: "move", nodeId: iId, parentId: w.pages.current.id ?? "" }, { op: "move", nodeId: oId, parentId: iId }]);
    ok("[PATCH-MORE] a child moved out, then its old parent moved into it, in one batch: accepted (" + (swap.error ?? "") + ")",
      swap.ok === true && parentOf(w.alive().find((n) => n.id === oId))?.id === iId);
    // A child moved out of a frame, then the frame deleted: the child is not deleted with it, so nothing conflicts.
    const keepKid = await w.api.applyWrites([{ op: "createTree", tree: { name: "Box3", handle: "x", children: [{ name: "Kid3", handle: "k" }] } }]);
    const xId = keepKid.applied[0]?.handles?.x ?? "", kId = keepKid.applied[0]?.handles?.k ?? "";
    const saved = await w.api.applyWrites([{ op: "move", nodeId: kId, parentId: w.pages.current.id ?? "" }, { op: "delete", nodeId: xId }, { op: "patch", nodeId: kId, set: { name: "Kept" } }]);
    ok("[PATCH-MORE] a child moved out, then its old parent deleted (and the child patched): accepted, the child survives (" + (saved.error ?? "") + ")",
      saved.ok === true && (await w.figma.getNodeByIdAsync(xId)) === null && w.alive().find((n) => n.id === kId)?.name === "Kept");
    // Moved back out (a later op fails): its parent, size and sizing go back as they were.
    const sizeBefore = JSON.stringify([loose?.width, loose?.layoutSizingHorizontal, parentOf(loose)?.id]);
    w.trap.add("cornerRadius");
    const out = await w.api.applyWrites([{ op: "move", nodeId: looseId, parentId: h.spare }, fail]);
    w.trap.clear();
    ok("[PATCH-MORE] a move put back restores the node's parent, size and sizing (" + JSON.stringify([loose?.width, loose?.layoutSizingHorizontal, parentOf(loose)?.id]) + ")",
      out.ok === false && JSON.stringify([loose?.width, loose?.layoutSizingHorizontal, parentOf(loose)?.id]) === sizeBefore);
    ok("[PATCH-MORE] …and auto-layout turned off, then a child set to fill: refused up front", reversed.ok === false && /"fill" needs a parent with auto-layout/.test(reversed.error ?? "") && reversed.failedAt === 1);
  },
}, {
  name: "a batch is checked as it runs: an op that depends on an earlier one is checked against what that op left",
  async run() {
    const RED = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }], BLUE = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }];
    const mixed = runText("mx:1", [{ text: "ab", fills: RED }, { text: "cd", fills: BLUE }]);
    const p = await patchWorld({ "mx:1": mixed });
    const { w, h } = p;
    const made = await w.api.applyWrites([
      { op: "createTree", tree: { name: "Empty", handle: "empty" } },
      { op: "createTree", tree: { name: "Mover", handle: "mover" } },
      { op: "createTree", tree: { name: "A", handle: "a", children: [{ name: "B", handle: "b" }] } },
      { op: "createTree", tree: { name: "Chips", handle: "chips", layout: { display: "flex" }, children: [{ component: "Chip", handle: "chip" }] } },
      { op: "createTree", tree: { name: "Wrapper", handle: "wrap", layout: { display: "flex" } } },
    ]);
    const id = (i: number, k: string): string => made.applied[i]?.handles?.[k] ?? "?";
    const step = async (what: string, ops: Array<{ op: string } & Record<string, unknown>>): Promise<WriteResult> => {
      const r = await w.api.applyWrites(ops);
      ok("[SEQUENCE] " + what + " (" + (r.error ?? "ok") + ")", r.ok === true);
      return r;
    };
    await step("a create into an empty frame, then a move to index 1 of it", [{ op: "createFrame", name: "First", parentId: id(0, "empty") }, { op: "move", nodeId: id(1, "mover"), parentId: id(0, "empty"), index: 1 }]);
    // B, which holds a node the session did not make, moved out of A; then A deleted (nothing foreign is below it then).
    const foreign = await w.figma.getNodeByIdAsync("1:2");
    const b = w.alive().find((n) => n.id === id(2, "b"));
    if (foreign && b && typeof b.appendChild === "function") (b.appendChild as (c: FakeNode) => void)(foreign);
    await step("a child holding a foreign node moved out, then its old parent deleted", [{ op: "move", nodeId: id(2, "b"), parentId: w.pages.current.id ?? "" }, { op: "delete", nodeId: id(2, "a") }]);
    await step("a text's mixed paints replaced, then unbound", [{ op: "patch", nodeId: "mx:1", set: { fills: [{ type: "solid", color: "#00ff00" }] } }, { op: "patch", nodeId: "mx:1", set: { tokens: { fills: null } } }]);
    await step("a sparse variant set: Large/On, then Size Large again (checked from Large/On, not the file's Small/Off)",
      [{ op: "patch", nodeId: id(3, "chip"), set: { props: { Size: "Large", Tone: "On" } } }, { op: "patch", nodeId: id(3, "chip"), set: { props: { Size: "Large" } } }]);
    await step("a variant with auto-layout picked, then hug", [{ op: "patch", nodeId: id(3, "chip"), set: { props: { Size: "Large", Tone: "On" } } }, { op: "patch", nodeId: id(3, "chip"), set: { widthMode: "hug" } }]);
    const back = await w.api.applyWrites([{ op: "patch", nodeId: id(3, "chip"), set: { props: { Size: "Small", Tone: "Off" } } }, { op: "patch", nodeId: id(3, "chip"), set: { widthMode: "hug" } }]);
    ok("[SEQUENCE] …and the flat variant picked, then hug: refused right before it runs, the variant put back",
      back.ok === false && back.failedAt === 1 && /"hug" needs auto-layout/.test(back.error ?? "") && (back.restored ?? []).length === 1);
    await step("wrapping turned on, then a row gap given with display", [{ op: "patch", nodeId: id(4, "wrap"), set: { layout: { flexWrap: "wrap" } } }, { op: "patch", nodeId: id(4, "wrap"), set: { layout: { display: "flex", rowGap: 10 } } }]);
    const single = await w.api.applyWrites([{ op: "patch", nodeId: id(4, "wrap"), set: { layout: { display: "flex", columnGap: 4 } } }]);
    ok("[SEQUENCE] a wrapping row given display and a cross-axis gap alone: the wrap it has counts", single.ok === false && /columnGap: is the main-axis gap in a wrapping row/.test(single.error ?? ""));
    // Two moves that nest nodes in each other, beside a delete: the second move is refused when it runs, the first put back.
    const loop = await w.api.applyWrites([{ op: "createTree", tree: { name: "LA", handle: "la" } }, { op: "createTree", tree: { name: "LB", handle: "lb" } }, { op: "createTree", tree: { name: "LD", handle: "ld" } }]);
    const la = loop.applied[0]?.handles?.la ?? "", lb = loop.applied[1]?.handles?.lb ?? "", ld = loop.applied[2]?.handles?.ld ?? "";
    const cyc = await w.api.applyWrites([{ op: "move", nodeId: la, parentId: lb }, { op: "move", nodeId: lb, parentId: la }, { op: "delete", nodeId: ld }]);
    ok("[SEQUENCE] two moves nesting nodes in each other: refused at the second, the first put back, nothing deleted (" + (cyc.error ?? "") + ")",
      cyc.ok === false && cyc.failedAt === 1 && /inside the node/.test(cyc.error ?? "") && parentOf(w.alive().find((n) => n.id === la))?.id === w.pages.current.id
      && (await w.figma.getNodeByIdAsync(ld)) !== null);
    void h;
  },
}, {
  name: "patch: 'Allow edits' turned off partway — a stopped patch is still reported, and a put-back stops where it was",
  async run() {
    // Unticked during the patch's own text-style await: it stops there, nothing is put back, and the reply still lists it.
    const p = await patchWorld();
    const { w, h, node } = p;
    w.hooks.onStyle = async () => { await w.allowEdits(false); };
    const r = await w.api.applyWrites([{ op: "patch", nodeId: h.email, set: { name: "Renamed", styles: { text: "Heading/H1" } } }]);
    w.hooks.onStyle = undefined;
    ok("[PATCH-CONSENT] stopped mid-patch: refused as edits-off, and the patch's row stays in `applied` (its name did change)",
      r.ok === false && r.refused === "edits-off" && JSON.stringify(r.applied) === JSON.stringify([{ id: h.email }]) && node("email")?.name === "Renamed");

    // Unticked while the batch is being put back: the restore stops before its next mutation and says what stayed.
    let calls = 0;
    let q: Awaited<ReturnType<typeof patchWorld>> | null = null;
    const rich = runText("rx:2", [{ text: "Hi ", fontSize: 20 }, { text: "there", textStyleId: "S:h1,", fontName: { family: "Inter", style: "Bold" } }], async () => {
      if (++calls === 2 && q) await q.w.allowEdits(false); // the first call is the patch's own; the second is the put-back's
    });
    q = await patchWorld({ "rx:2": rich });
    q.w.trap.add("cornerRadius");
    const stopped = await q.w.api.applyWrites([{ op: "patch", nodeId: "rx:2", set: { styles: { text: "Body" } } }, { op: "patch", nodeId: q.h.card, set: { radius: 1 } }]);
    q.w.trap.clear();
    ok("[PATCH-CONSENT] unticked during the put-back: it stops there, the error says what stayed, and the patch is still in `applied`",
      stopped.ok === false && /'Allow edits' was turned off while the batch was being put back/.test(stopped.error ?? "")
      && JSON.stringify(stopped.applied) === JSON.stringify([{ id: "rx:2" }]) && stopped.restored === undefined);
  },
}];

/** A tree world with a screen to patch: a column (its gap bound to space/md) holding an email text, a card frame with
 *  auto-layout and a text, a Button instance and a spare frame. `h` maps each handle to its id; `node` reads a node by
 *  handle; `state` is every patchable field of every node, by id, to compare before and after a batch. */
async function patchWorld(extra: Record<string, FakeNode> = {}) {
  const w = await treeWorld({ kit: true, extra: { nodes: extra } });
  const r: WriteResult = await w.api.applyWrites([{ op: "createTree", tree: {
    name: "Profile", handle: "screen", box: { w: 390, h: 844 }, layout: { display: "flex", flexDirection: "column", gap: 16 }, tokens: { itemSpacing: "space/md" },
    fills: [{ type: "solid", color: "#ffffff" }],
    children: [
      { text: "jane@exmaple.com", name: "email", handle: "email", font: { size: 16 } },
      { name: "Card", handle: "card", box: { w: 200, h: 80 }, radius: 8, layout: { display: "flex", padding: [8, 8, 8, 8] }, children: [{ text: "Inside", handle: "inside" }] },
      { component: "Button", handle: "btn", props: { Label: "Go" } },
      { name: "Spare", handle: "spare" },
    ],
  } }]);
  if (!r.ok) throw new Error("patchWorld: the screen did not build: " + String(r.error));
  const h: Record<string, string> = r.applied[0]?.handles ?? {};
  const node = (handle: string, map: Record<string, string> = h): FakeNode | undefined => w.alive().find((n) => n.id === map[handle]);
  const FIELDS = ["name", "visible", "opacity", "fills", "strokes", "strokeWeight", "strokeAlign", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius",
    "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "width", "height", "layoutSizingHorizontal", "layoutSizingVertical",
    "characters", "textStyleId", "fontName", "fontSize", "boundVariables", "componentProperties", "textAutoResize"];
  const state = (): Record<string, string> => Object.fromEntries(w.alive().flatMap((n) => [
    ...FIELDS.map((f): [string, string] => [n.id + "." + f, JSON.stringify(n[f])]),
    [n.id + ".parent", String(parentOf(n)?.id) + "@" + kids(parentOf(n) ?? undefined).indexOf(n)],
    [n.id + ".main", isNode(n.mainComponent) ? String(n.mainComponent.id) : ""],
  ]));
  return { w, h, node, state };
}
/** The variable a node's first paint is bound to, or null. */
function boundColor(n: FakeNode | undefined): string | null {
  const p = Array.isArray(n?.fills) ? (n.fills as unknown[])[0] : undefined;
  const bv = isNode(p) && isNode(p.boundVariables) && isNode(p.boundVariables.color) ? p.boundVariables.color.id : null;
  return typeof bv === "string" ? bv : null;
}

/** A TEXT with several runs, formatted per character the way Figma keeps it: getStyledTextSegments groups equal
 *  characters, getRange* answers one value or figma.mixed, setRange* sets (a raw size, height, spacing or font unbinds
 *  its variable on those characters), a text style replaces the formatting and bindings of its range (overrides set
 *  after it stay), and setting `characters` gives the new text the first character's formatting. `onStyle` runs inside
 *  each style call (to untick "Allow edits" there). */
function runText(id: string, runs: ReadonlyArray<{ text: string } & Record<string, unknown>>, onStyle: () => Promise<void> = async () => {},
  fontLoaded: (f: unknown) => boolean = () => true): FakeNode {
  const base = { ...TEXT_RANGE_DEFAULTS, fontName: { family: "Inter", style: "Regular" }, fontSize: 16, textStyleId: "", fills: [], fillStyleId: "", lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PERCENT", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", boundVariables: {} };
  let chars: Array<Record<string, unknown>> = runs.flatMap((r) => { const { text, ...f } = r; return Array.from(text, () => ({ ...base, ...f })); });
  let text = runs.map((r) => r.text).join("");
  const UNBINDS: Record<string, readonly string[]> = { fontSize: ["fontSize"], lineHeight: ["lineHeight"], letterSpacing: ["letterSpacing"], paragraphSpacing: ["paragraphSpacing"],
    paragraphIndent: ["paragraphIndent"], fontName: ["fontFamily", "fontStyle", "fontWeight"] };
  const uniform = (f: string, s = 0, e = chars.length): unknown => {
    const vals = chars.slice(s, e).map((c) => JSON.stringify(c[f]));
    return vals.every((v) => v === vals[0]) ? chars[s]?.[f] : MIXED;
  };
  const setRange = (f: string) => (s: number, e: number, v: unknown): void => {
    for (const c of chars.slice(s, e)) {
      c[f] = v;
      if (f === "fills") c.fillStyleId = ""; // new paints detach the paint style, as in Figma
      const b = isNode(c.boundVariables) ? { ...c.boundVariables } : {};
      for (const k of UNBINDS[f] ?? []) delete b[k];
      c.boundVariables = b;
    }
  };
  const styleRange = async (s: number, e: number, sid: string): Promise<void> => {
    await onStyle();
    const st = KIT_STYLES.find((x) => x.id === sid);
    if (st && !fontLoaded(st.fontName)) throw new Error("in Figma: the style's font " + JSON.stringify(st.fontName) + " is not loaded");
    for (const c of chars.slice(s, e)) {
      c.textStyleId = sid;
      if (st) Object.assign(c, { fontName: st.fontName, fontSize: typeof st.fontSize === "number" ? st.fontSize : 16, lineHeight: base.lineHeight, letterSpacing: base.letterSpacing, textCase: "ORIGINAL", textDecoration: "NONE", boundVariables: {} });
    }
  };
  const RANGE = TEXT_RANGE_METHODS;
  const lower = (f: string): string => f.charAt(0).toLowerCase() + f.slice(1);
  const n: FakeNode = {
    id, type: "TEXT", name: "Rich", visible: true, width: 100, height: 20, textAutoResize: "WIDTH_AND_HEIGHT",
    get characters() { return text; },
    set characters(v: string) { const first = { ...(chars[0] ?? base) }; text = v; chars = Array.from(v, () => ({ ...first, boundVariables: { ...(isNode(first.boundVariables) ? first.boundVariables : {}) } })); },
    get fontName() { return uniform("fontName"); },
    get fontSize() { return uniform("fontSize"); },
    get textStyleId() { return uniform("textStyleId"); },
    get fillStyleId() { return uniform("fillStyleId"); },
    get fills() { return uniform("fills"); },
    set fills(v: unknown) { setRange("fills")(0, chars.length, v); },
    getRangeAllFontNames: (s: number, e: number) => [...new Set(chars.slice(s, e).map((c) => JSON.stringify(c.fontName)))].map((f) => JSON.parse(f) as unknown),
    getStyledTextSegments: (fields: readonly string[]) => {
      const out: Array<Record<string, unknown>> = [];
      chars.forEach((c, i) => {
        const pick = Object.fromEntries(fields.map((f) => [f, c[f]]));
        const last = out.at(-1);
        if (last && fields.every((f) => JSON.stringify(last[f]) === JSON.stringify(pick[f]))) { last.end = i + 1; last.characters = text.slice(Number(last.start), i + 1); }
        else out.push({ characters: text[i], start: i, end: i + 1, ...pick });
      });
      return out;
    },
    getRangeTextStyleId: (s: number, e: number) => uniform("textStyleId", s, e),
    getRangeFillStyleId: (s: number, e: number) => uniform("fillStyleId", s, e),
    setRangeTextStyleIdAsync: styleRange,
    setTextStyleIdAsync: (sid: string) => styleRange(0, chars.length, sid),
    setRangeFillStyleIdAsync: async (s: number, e: number, sid: string) => { setRange("fillStyleId")(s, e, sid); },
    getRangeBoundVariable: (s: number, e: number, f: string) => {
      const vals = chars.slice(s, e).map((c) => (isNode(c.boundVariables) ? c.boundVariables[f] ?? null : null));
      return vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0])) ? vals[0] ?? null : MIXED;
    },
    setRangeBoundVariable: (s: number, e: number, f: string, v: { id: string } | null) => {
      for (const c of chars.slice(s, e)) {
        const b = isNode(c.boundVariables) ? { ...c.boundVariables } : {};
        if (v === null) delete b[f]; else b[f] = { type: "VARIABLE_ALIAS", id: v.id };
        c.boundVariables = b;
      }
    },
    ...Object.fromEntries(RANGE.map((f) => ["getRange" + f, (s: number, e: number) => uniform(lower(f), s, e)])),
    ...Object.fromEntries(RANGE.map((f) => ["setRange" + f, setRange(lower(f))])),
    resize(w: number, h: number) { n.width = w; n.height = h; },
  };
  return n;
}
const ALL_SEGMENT_FIELDS = [...TEXT_RANGE_METHODS.map((f) => f.charAt(0).toLowerCase() + f.slice(1)), "textStyleId", "fillStyleId", "boundVariables"];
const runsOf = (n: FakeNode): string => JSON.stringify([n.characters, (n.getStyledTextSegments as (f: readonly string[]) => unknown)(ALL_SEGMENT_FIELDS)]);

