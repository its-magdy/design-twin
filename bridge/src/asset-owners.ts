// asset-owners.ts — who owns an exported graphic, and which hidden graphic can reuse a visible twin's file.
//
// Pure: plain IR trees in, plain answers out (no fs) — write-out.ts does the reading and writing, so every
// rule here is testable offline on hand-built trees.
//
// 1. Owners. An asset file is named after its layer, and a layer is very often called
//    `Vector`, `Icon` or `Group_N`. What it IS lives on the nearest component instance above it (or on the
//    node itself): `Checkbox / Status=Checked`. One walk gives every `asset` pointer its uses — node id,
//    layer name, hidden or not, owner, the instance above the owner (`context`, which names a self-owned
//    icon component such as `Glyph 12` inside `Nav item / Type=Settings`) — and the `.assets.json`
//    row carries them, so a builder searches by component instead of by file name. File names never change.
//
// 2. Hidden reuse. The plugin does not export a hidden graphic (`assetSkipped:"hidden"`): its
//    exporter has nothing to render. When a VISIBLE node in the same pull (or in another screen already
//    pulled) is the same graphic — the same main component, the same source node inside it, the same
//    chain of components and variants above the owner, the same non-boolean props, the same effective
//    variable modes, the same size and transform, and no paint override (nor a shape/visibility override
//    on a sublayer of the graphic) on either side — the hidden
//    node points at that file instead (`asset` + `assetFrom`). An owner's booleans are left out of the key
//    because they are the visibility toggles that hid the node; a SELF-owned icon's own booleans are its
//    internal toggles (`Show badge`), so they stay in. Variant props are covered by the main
//    component id. The modes are in because a bound colour renders per mode.
//    The chain is in the key because a parent variant may recolour a nested icon in its own DEFINITION
//    (`Button / Type=Danger` drawing its icon red), and Figma's `overrides` list only what is overridden
//    directly on an instance, never what it inherits — so no override would block that twin.
import type { InstanceOverride, IrNode } from "./doc-types.ts";
import { OVERRIDE_CAP } from "./instance-overrides.ts";

/** The nearest INSTANCE ancestor-or-self that names its main component. */
export interface AssetOwner {
  /** the component set's name, else the component's own */
  component: string;
  variant?: string;
  componentId?: string;
  componentKey?: string;
  /** the owning instance's node id */
  instance: string;
  /** the node IS the owning instance (a self-owned icon component) */
  self: boolean;
  /** a paint override, a shape/visibility override on a sublayer (or a truncated override list) on this
   *  use — never reused across, either way */
  paintOverrides?: true;
}
/** The next INSTANCE above the owner. */
export interface AssetContext { component: string; variant?: string }

/** One node in a tree that holds an exported graphic (`asset`) or a hidden one that was not (`assetSkipped:"hidden"`). */
export interface Graphic {
  node: IrNode;
  /** the node or an ancestor is hidden */
  hidden: boolean;
  owner?: AssetOwner;
  context?: AssetContext;
  /** see reuseKeyOf; absent without an owner that names a component id or key */
  reuseKey?: string;
  /** a paint override, a sublayer shape/visibility override or a truncated override list blocks reuse */
  blocked: boolean;
}

// Figma's overriddenFields that change how a graphic LOOKS. Anything else (a text, a swapped instance's
// visibility, a name) leaves the exported pixels of an icon alone.
const PAINT_FIELD_RE = /^(?:fills|strokes|strokeWeight|sto?ke\w*Weight|opacity|effects|effectStyleId|blendMode|fillStyleId|strokeStyleId|boundVariables|explicitVariableModes|vectorNetwork)$/;
// On a SUBLAYER of the graphic (inside the exported file), any field but these changes the drawing: a
// `visible` override drops a layer, a size/corner/transform one reshapes it.
const INERT_SUBLAYER_FIELD_RE = /^(?:name|locked|pluginData|reactions|description|exportSettings|expanded|autoRename|hyperlink|characters|styledTextSegments|textStyleId|fontName)$/;

const lastSegment = (id: string): string => { const i = id.lastIndexOf(";"); return i >= 0 ? id.slice(i + 1) : id; };
const isOwnerInstance = (n: IrNode): boolean => n.type === "INSTANCE" && !!n.mainComponent;
const overridesOf = (n: IrNode): readonly InstanceOverride[] => (Array.isArray(n.overrides) ? n.overrides : []);
// The plugin cuts the list at OVERRIDE_CAP (and warns): at that length, what was cut is unknown.
const truncated = (n: IrNode): boolean => overridesOf(n).length >= OVERRIDE_CAP;
const paintEntry = (o: InstanceOverride): boolean => !!o && Array.isArray(o.fields) && o.fields.some((f) => typeof f === "string" && PAINT_FIELD_RE.test(f));

// (iii) of the reuse guard. On every instance from the root down to the graphic, a paint entry ABOUT the
// graphic or one of its sublayers counts (a sublayer id is `<id>;…`, or `I<id>;…` under a top-level
// instance): an outer instance records a recolour of a nested vector on ITS own `overrides`, not on the
// vector's owner. For a graphic that is not itself an instance, each paint entry on its owner counts
// as well — the override's target cannot always be tied to the node more precisely than that from the tree.
// On a STRICT sublayer (`<id>;…`, inside the exported file) any field but an inert one blocks: a `visible`
// override drops a layer, a size/corner one reshapes it. The graphic's own `visible` is what hid it.
// A truncated list on any of those instances blocks too: what was cut is unknown.
function hasPaintOverride(node: IrNode, instances: readonly IrNode[], owner: IrNode | undefined): boolean {
  const id = typeof node.id === "string" ? node.id : "";
  const prefixes = [id + ";", "I" + id + ";"];
  const about = (o: InstanceOverride): boolean => !!o && typeof o.id === "string" && (o.id === id || prefixes.some((p) => o.id.startsWith(p)));
  const sub = (o: InstanceOverride): boolean => !!o && typeof o.id === "string" && o.id !== id && prefixes.some((p) => o.id.startsWith(p));
  const reshapes = (o: InstanceOverride): boolean => Array.isArray(o.fields) && o.fields.some((f) => typeof f === "string" && !INERT_SUBLAYER_FIELD_RE.test(f));
  if (instances.some((inst) => truncated(inst) || overridesOf(inst).some((o) => (about(o) && paintEntry(o)) || (sub(o) && reshapes(o))))) return true;
  if (node.type === "INSTANCE" || !owner) return false;
  return overridesOf(owner).some(paintEntry);
}

const sortedProps = (n: IrNode, booleans: boolean): Array<[string, unknown]> => {
  const props = n.props && typeof n.props === "object" ? Object.entries(n.props) : [];
  return props.filter(([, v]) => booleans || typeof v !== "boolean").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};

/** `<componentKey||componentId>|<self|last id segment>|<sorted props JSON>|<chain JSON>[|<modes JSON>]`, or
 *  undefined. The props drop booleans unless the node IS the owner; `modes` is the effective
 *  `[collection, mode]` list, sorted (collectGraphics), left off when empty. `chain` is the main component (key, else id — which names the variant; `?` when unnamed) of
 *  every INSTANCE above the owner, outermost first: `instances` is the root-down list of instances above
 *  `node` (the owner included, when it is an ancestor). The whole chain, not only the next instance up: an
 *  outer component's definition can recolour the nested icon just as the parent variant's can.
 *  Not in the key: WHERE in the parent the owner sits. The full id path would keep a leading and a trailing
 *  icon of one button variant apart, but on the real exports it refused every same-screen reuse — list
 *  rows inside an instance carry document ids in that path, different per row for the very same icon. */
export function reuseKeyOf(node: IrNode, owner: IrNode | undefined, instances: readonly IrNode[] = [], modes = ""): string | undefined {
  const mc = owner && owner.mainComponent;
  const comp = mc && (mc.key || mc.id);
  if (!owner || !comp || typeof node.id !== "string") return undefined;
  const at = instances.indexOf(owner);
  const above = at >= 0 ? instances.slice(0, at) : instances.filter((i) => i !== owner);
  const chain = above.map((i) => (i.mainComponent && (i.mainComponent.key || i.mainComponent.id)) || "?");
  return comp + "|" + (node === owner ? "self" : lastSegment(node.id)) + "|" + JSON.stringify(sortedProps(owner, node === owner)) + "|" + JSON.stringify(chain) + (modes ? "|" + modes : "");
}

function ownerRef(inst: IrNode, node: IrNode, blocked: boolean): AssetOwner | undefined {
  const mc = inst.mainComponent;
  if (!mc) return undefined;
  const o: AssetOwner = { component: mc.setName ?? mc.name, instance: inst.id, self: inst === node };
  if (mc.variant) o.variant = mc.variant;
  if (mc.id) o.componentId = mc.id;
  if (mc.key) o.componentKey = mc.key;
  if (blocked) o.paintOverrides = true;
  return o;
}

/** Every graphic node (`asset` string, or `assetSkipped:"hidden"`) in tree order, with its owner and reuse key. */
export function collectGraphics(roots: readonly IrNode[] | null | undefined): Graphic[] {
  const out: Graphic[] = [];
  // instances: every INSTANCE from the root down (paint-override scope); owners: the ones naming a main component.
  // modes: the effective variable mode per collection (the root's resolvedModes, then every variableModes
  // pinned on the way down) — a bound colour renders per mode, so a Dark section never reuses a Light file.
  const visit = (n: IrNode, instances: readonly IrNode[], owners: readonly IrNode[], hiddenAbove: boolean, modesAbove: ReadonlyMap<string, string>): void => {
    if (!n || typeof n !== "object") return;
    let modes = modesAbove;
    for (const pinned of [n.resolvedModes, n.variableModes]) {
      if (!pinned || typeof pinned !== "object") continue;
      const next = new Map(modes);
      for (const [c, m] of Object.entries(pinned)) if (typeof m === "string") next.set(c, m);
      modes = next;
    }
    const insts = n.type === "INSTANCE" ? [...instances, n] : instances;
    const owns = isOwnerInstance(n) ? [...owners, n] : owners;
    const hidden = hiddenAbove || n.hidden === true;
    if (typeof n.asset === "string" || n.assetSkipped === "hidden") {
      const owner = owns[owns.length - 1];
      const above = owns[owns.length - 2];
      const blocked = hasPaintOverride(n, insts, owner);
      const g: Graphic = { node: n, hidden, blocked };
      const o = owner && ownerRef(owner, n, blocked);
      if (o) g.owner = o;
      const ac = above && above.mainComponent;
      if (ac) g.context = ac.variant ? { component: ac.setName ?? ac.name, variant: ac.variant } : { component: ac.setName ?? ac.name };
      const mk = [...modes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const key = reuseKeyOf(n, owner, insts, mk.length ? JSON.stringify(mk) : "");
      if (key !== undefined) g.reuseKey = key;
      out.push(g);
    }
    // An unrelated screen's JSON on disk may be malformed (`children: {}`): skipped, never a throw.
    if (Array.isArray(n.children)) for (const c of n.children) visit(c, insts, owns, hidden, modes);
  };
  for (const r of roots || []) visit(r, [], [], false, new Map());
  return out;
}

/** pointer (`assets/<name>`) → its uses in tree order. */
export function usesByPointer(graphics: readonly Graphic[]): Map<string, Graphic[]> {
  const map = new Map<string, Graphic[]>();
  for (const g of graphics) {
    const p = g.node.asset;
    if (typeof p !== "string") continue;
    let list = map.get(p);
    if (!list) { list = []; map.set(p, list); }
    list.push(g);
  }
  return map;
}

// (ii): the transform Figma drew into the file. A visible asset leaf carries it as `sourceTransform`; an older
// export, and the hidden node before reuse, carry it bare.
function transformOf(n: IrNode): { rotation: number; flipped: boolean; skew: number } {
  const t = n.sourceTransform;
  return t
    ? { rotation: t.rotation ?? 0, flipped: t.flipped === true, skew: t.skew ?? 0 }
    : { rotation: n.rotation ?? 0, flipped: n.flipped === true, skew: n.skew ?? 0 };
}
const BOX_TOL = 0.5;
const ANGLE_TOL = 0.01;
function sameLook(hidden: IrNode, twin: IrNode): boolean {
  const a = hidden.box, b = twin.box;
  // `!(d <= tol)`, not `d > tol`: a non-number size (a malformed tree on disk) is NaN and must refuse.
  if (!a || !b || !(Math.abs(a.w - b.w) <= BOX_TOL) || !(Math.abs(a.h - b.h) <= BOX_TOL)) return false;
  const x = transformOf(hidden), y = transformOf(twin);
  return x.flipped === y.flipped && Math.abs(x.rotation - y.rotation) <= ANGLE_TOL && Math.abs(x.skew - y.skew) <= ANGLE_TOL;
}

// A twin's pointer must be the plugin's own shape, `assets/<name>`: a hand-edited or foreign sibling JSON
// naming `../x.svg` or another dir would hand that path on, and the reusing screen's `.assets.json` would
// read the file's bytes.
const ASSET_POINTER_RE = /^assets\/(?!\.\.?$)[^/\\]+$/;
const twinOk = (g: Graphic): boolean => !g.hidden && !g.blocked && typeof g.node.asset === "string" && ASSET_POINTER_RE.test(g.node.asset) && g.node.assetFrom === undefined && g.reuseKey !== undefined;

export interface ReuseOptions {
  /** Trees of OTHER screens that may hold a twin for one of `keys` (writeScreen: from their `.assets.json`
   *  `reuseKey`). Called at most once, and only when a candidate is left unmatched in its own tree. */
  otherTrees?: (keys: ReadonlySet<string>) => Iterable<readonly IrNode[]>;
  /** The twin's pointer names a file on disk — a reuse must never create a dangling pointer. */
  pointerExists?: (pointer: string) => boolean;
}
export interface ReuseResult {
  /** `assetSkipped:"hidden"` nodes seen */
  hidden: number;
  /** of which now point at a twin's file */
  reused: number;
  /** of which the twin was in another screen */
  crossScreen: number;
}

// The transform move: the reused file already has the twin's transform drawn in, so the bare fields go under
// `sourceTransform` — a builder that applies `rotation` would otherwise rotate it twice.
function moveTransform(n: IrNode): void {
  const t: NonNullable<IrNode["sourceTransform"]> = {};
  if (typeof n.rotation === "number") t.rotation = n.rotation;
  if (n.flipped === true) t.flipped = true;
  if (typeof n.skew === "number") t.skew = n.skew;
  delete n.rotation; delete n.flipped; delete n.skew;
  if (Object.keys(t).length) n.sourceTransform = t;
}

/** Point every hidden graphic that has a visible twin at the twin's file. Mutates `roots` in place. */
export function reuseHiddenAssets(roots: readonly IrNode[] | null | undefined, opts: ReuseOptions = {}): ReuseResult {
  const graphics = collectGraphics(roots);
  const candidates = graphics.filter((g) => g.node.assetSkipped === "hidden");
  const result: ReuseResult = { hidden: candidates.length, reused: 0, crossScreen: 0 };
  if (!candidates.length) return result;
  const exists = opts.pointerExists || (() => true);
  const pool = (list: readonly Graphic[]): Map<string, Graphic[]> => {
    const m = new Map<string, Graphic[]>();
    for (const g of list) {
      if (!twinOk(g) || g.reuseKey === undefined) continue;
      let l = m.get(g.reuseKey);
      if (!l) { l = []; m.set(g.reuseKey, l); }
      l.push(g);
    }
    return m;
  };
  const pick = (c: Graphic, twins: Map<string, Graphic[]>): Graphic | undefined =>
    c.reuseKey === undefined ? undefined : (twins.get(c.reuseKey) || []).find((t) => typeof t.node.asset === "string" && exists(t.node.asset) && sameLook(c.node, t.node));
  const apply = (c: Graphic, t: Graphic): void => {
    const n = c.node, file = t.node.asset;
    if (typeof file !== "string") return; // pick() only returns twins with a pointer
    n.asset = file;
    n.assetFrom = t.node.id;
    delete n.assetSkipped;
    moveTransform(n);
  };

  const local = pool(graphics);
  const left: Graphic[] = [];
  for (const c of candidates) {
    if (c.blocked || c.reuseKey === undefined) continue;
    const t = pick(c, local);
    if (t) { apply(c, t); result.reused++; } else left.push(c);
  }
  if (left.length && opts.otherTrees) {
    const keys = new Set<string>();
    for (const c of left) if (c.reuseKey !== undefined) keys.add(c.reuseKey);
    const other: Graphic[] = [];
    for (const tree of opts.otherTrees(keys)) {
      try { other.push(...collectGraphics(tree)); } catch { /* a malformed other screen holds no twin */ }
    }
    const far = pool(other);
    for (const c of left) {
      const t = pick(c, far);
      if (t) { apply(c, t); result.reused++; result.crossScreen++; }
    }
  }
  return result;
}
