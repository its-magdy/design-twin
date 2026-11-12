// A writable fake Figma file for the write-cost suite: pages of frames, text, components and instances that the
// plugin's real write code (figma-plugin/src/writes.ts, run in fake-figma's VM) can add to and change, and its real
// read code can export.
//
//   const c = canvas();
//   const brand = c.variable("color/brand", "#4f46e5");
//   const home = c.frame(c.page("Screens"), { name: "Home", w: 390, h: 844, layoutMode: "VERTICAL" });
//   c.text(home, { name: "Title", text: "Welcome", fill: { variable: brand } });
//   const w = c.world();            // a fake-figma world over this file ("Allow edits" not ticked yet)
//
// Every node, made by a fixture or by the plugin's figma.createFrame()/createText(), gets the next id of one sequence
// and lands in one live table, so getNodeByIdAsync finds it, a later op can name it as a parent, and an export of it
// walks its children. Ids depend only on the order things are made, so every run of a job reads the same text.
//
// An instance is what Figma makes: its sublayers are its own nodes (ids `I<instance>;<main sublayer>`) that read
// through to the main component's sublayers until one is set on the instance (an override). So a fix to the main
// component shows in every instance, and a fix made through an instance's sublayer id changes that instance only.
import { fakeWorld, type FakeCollection, type FakeNode, type FakeVariable, type Scene, type World } from "../fake-figma.ts";

export interface Rgb { r: number; g: number; b: number }
interface Alias { type: "VARIABLE_ALIAS"; id: string }
interface Paint { type: "SOLID"; visible: boolean; color: Rgb; opacity?: number; boundVariables?: { color?: Alias } }
/** A node the canvas made: mutable, with a live `children` list and a `parent`. */
export interface CNode extends FakeNode {
  id: string;
  type: string;
  name: string;
  children?: CNode[];
  parent?: CNode | null;
  fills?: Paint[];
  characters?: string;
}
/** A page: a node with the selection Figma keeps per page. */
export type CPage = CNode & { selection: FakeNode[] };
/** A fill: a colour, or a colour variable of this file (the paint is bound to it, as a designer's would be). */
export type Fill = Rgb | { variable: string };
export interface FrameSpec { name: string; w?: number; h?: number; layoutMode?: "HORIZONTAL" | "VERTICAL"; gap?: number; padding?: readonly [number, number, number, number]; fill?: Fill }
export interface TextSpec { name?: string; text: string; size?: number; fill?: Fill }

export const rgb = (hex: string): Rgb => {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
};
const FONT = { family: "Inter", style: "Regular" };
const COLLECTION: FakeCollection = { id: "VariableCollectionId:1:1", name: "Tokens", modes: [{ modeId: "1:0", name: "Default" }], defaultModeId: "1:0" };

export interface Canvas {
  /** a page of the file (the first one made is the current page) */
  page(name: string): CPage;
  frame(parent: CNode, spec: FrameSpec): CNode;
  text(parent: CNode, spec: TextSpec): CNode;
  /** a main component (a frame of type COMPONENT); give it its children before making instances of it */
  component(parent: CNode, spec: FrameSpec): CNode;
  /** an instance of `main`, its sublayers read through to the main component's */
  instance(parent: CNode, main: CNode, spec: { name?: string }): CNode;
  /** a colour variable of this file; returns its id */
  variable(name: string, hex: string): string;
  /** every node by id, made by a fixture or by a write */
  readonly nodes: Record<string, CNode>;
  readonly pages: CPage[];
  /** the fake-figma world over this file; the plugin's createFrame/createText add to it */
  world(): World;
}

export function canvas(): Canvas {
  const nodes: Record<string, CNode> = {};
  const pages: CPage[] = [];
  const variables: Record<string, FakeVariable> = {};
  let seq = 0;
  const nextId = (): string => `${Math.floor(seq / 1000) + 10}:${(seq++ % 1000) + 1}`;

  const paintOf = (f: Fill): Paint => {
    if ("variable" in f) {
      const v = variables[f.variable];
      if (!v) throw new Error(`canvas: no variable ${f.variable}`);
      return { type: "SOLID", visible: true, color: v.valuesByMode["1:0"] as Rgb, opacity: 1, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } };
    }
    return { type: "SOLID", visible: true, color: f, opacity: 1 };
  };
  const adopt = (parent: CNode, child: CNode): void => {
    if (child.parent?.children) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent;
    (parent.children ??= []).push(child);
  };
  const box = (n: CNode) => ({ x: Number(n.x), y: Number(n.y), width: Number(n.width), height: Number(n.height) });
  // What every node carries for the read: no dev resources, and a reference render that is one fixed tiny byte string.
  const common = { visible: true, strokes: [], effects: [], opacity: 1, rotation: 0, blendMode: "NORMAL", isMask: false, x: 0, y: 0,
    getDevResourcesAsync: async () => [], exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
  // An auto-layout frame resizes with its content in Figma; the fake keeps the numbers it was given (no layout
  // engine), which is all a read needs.
  const frameLike = (type: string, spec: FrameSpec): CNode => {
    const id = nextId();
    const n: CNode = {
      ...common, id, type, name: spec.name, children: [], parent: null,
      width: spec.w ?? 100, height: spec.h ?? 100,
      fills: spec.fill ? [paintOf(spec.fill)] : [],
      clipsContent: true, layoutMode: spec.layoutMode ?? "NONE", itemSpacing: spec.gap ?? 0,
      paddingTop: spec.padding?.[0] ?? 0, paddingRight: spec.padding?.[1] ?? 0, paddingBottom: spec.padding?.[2] ?? 0, paddingLeft: spec.padding?.[3] ?? 0,
      primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
      resize(w: number, h: number) { n.width = w; n.height = h; },
      appendChild(c: CNode) { adopt(n, c); },
      get absoluteBoundingBox() { return box(n); },
    };
    nodes[id] = n;
    return n;
  };
  const textNode = (spec: TextSpec): CNode => {
    const id = nextId();
    const n: CNode = {
      ...common, id, type: "TEXT", name: spec.name ?? spec.text, parent: null,
      characters: spec.text, width: 100, height: 20,
      fontSize: spec.size ?? 16, fontName: FONT, fills: [paintOf(spec.fill ?? { r: 0, g: 0, b: 0 })],
      textAutoResize: "WIDTH_AND_HEIGHT", textAlignHorizontal: "LEFT", textAlignVertical: "TOP",
      lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE",
      getRangeAllFontNames: () => [FONT],
      get absoluteBoundingBox() { return box(n); },
      remove() { if (n.parent?.children) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; delete nodes[id]; },
    };
    nodes[id] = n;
    return n;
  };
  // An instance sublayer: its own id and parent, every other field read through to the main component's sublayer
  // until it is set here (the prototype chain is exactly "inherit until overridden").
  const sublayer = (instanceId: string, main: CNode, parent: CNode): CNode => {
    const s = Object.create(main) as CNode;
    Object.defineProperty(s, "id", { value: `I${instanceId};${main.id}`, enumerable: true });
    Object.defineProperty(s, "parent", { value: parent, writable: true, enumerable: true });
    Object.defineProperty(s, "absoluteBoundingBox", { get: () => box(s) });
    if (main.children) {
      const kids = main.children.map((k) => sublayer(instanceId, k, s));
      Object.defineProperty(s, "children", { value: kids, enumerable: true });
    }
    nodes[s.id] = s;
    return s;
  };

  const c: Canvas = {
    nodes, pages,
    page(name) {
      const id = nextId();
      const p: CPage = { id, type: "PAGE", name, children: [], parent: null, selection: [], appendChild(ch: CNode) { adopt(p, ch); }, loadAsync: async () => {} };
      nodes[id] = p;
      pages.push(p);
      return p;
    },
    frame(parent, spec) { const f = frameLike("FRAME", spec); adopt(parent, f); return f; },
    text(parent, spec) { const t = textNode(spec); adopt(parent, t); return t; },
    component(parent, spec) { const f = frameLike("COMPONENT", spec); f.key = `key-${f.id}`; f.remote = false; adopt(parent, f); return f; },
    instance(parent, main, spec) {
      const f = frameLike("INSTANCE", { name: spec.name ?? main.name, w: Number(main.width), h: Number(main.height), ...(main.layoutMode !== "NONE" ? { layoutMode: main.layoutMode as "HORIZONTAL" | "VERTICAL" } : {}) });
      f.fills = main.fills ?? [];
      f.getMainComponentAsync = async () => main;
      f.componentProperties = {};
      f.overrides = [];
      f.children = (main.children ?? []).map((k) => sublayer(f.id, k, f));
      adopt(parent, f);
      return f;
    },
    variable(name, hex) {
      const id = `VariableID:1:${Object.keys(variables).length + 1}`;
      variables[id] = { id, name, resolvedType: "COLOR", variableCollectionId: COLLECTION.id, scopes: ["ALL_FILLS"], codeSyntax: {}, remote: false, valuesByMode: { "1:0": rgb(hex) } };
      return id;
    },
    world() {
      const current = pages[0] ?? c.page("Page 1");
      const scene: Scene = { file: { name: "Sample App" }, pages, currentPage: current, nodes, variables, collections: { [COLLECTION.id]: COLLECTION } };
      return fakeWorld(scene, {}, {
        createFrame: () => frameLike("FRAME", { name: "Frame" }),
        createText: () => textNode({ text: "" }),
        loadFontAsync: async () => {},
        // the live table, not the copy fakeWorld made: a node a write creates is found by the next op that names it
        getNodeByIdAsync: async (id: string) => nodes[id] ?? null,
      });
    },
  };
  return c;
}

/** The hex of a node's first solid fill, lower case (`null` when it has none). */
export function fillHex(n: CNode): string | null {
  const p = n.fills?.[0];
  if (!p) return null;
  const h = (v: number): string => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(p.color.r)}${h(p.color.g)}${h(p.color.b)}`;
}
/** The variable id a node's first fill is bound to (`null` when it is a raw colour). */
export const fillVariable = (n: CNode): string | null => n.fills?.[0]?.boundVariables?.color?.id ?? null;
