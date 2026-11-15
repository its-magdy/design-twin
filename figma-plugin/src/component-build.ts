// Components from a tree spec (writes: createTree with a COMPONENT or COMPONENT_SET root; bridge/src/component-spec.ts).
//
// A component's name is its key. Before the batch runs (keyed.ts resolveKeyed), the file's local main components and
// sets are searched for the spec's name (existingComponent):
//   * none: the spec builds a new one (tree.ts buildComponent) and stamps what it built with componentKey(name);
//   * one, stamped by a write: it is updated in place through the keyed re-send machinery (keyed.ts), so its id and its
//     variants' and layers' ids stay and every instance follows; this module brings its property definitions to the
//     spec (planDefs → syncComponent: added, edited, and — after the batch's removals, last of all — deleted) and wires
//     each layer whose `propRefs` changed (planWiring: unwired before the patches, wired after them; a field that stays
//     bound is never patched, since Figma keeps it bound and it follows the property's default);
//   * one made by hand, or several: refused, nothing runs.
//
// The properties live on the component, or on the set for a set (a variant's componentPropertyDefinitions throws). A
// layer is wired with componentPropertyReferences, which takes the property's real key ("Label#12:0", what
// addComponentProperty returns), not its bare name. Every step is a Change the batch can put back.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * addComponentProperty(name, type, defaultValue, {preferredValues}) returns the new key; an INSTANCE_SWAP default
//     is a component's id, a preferred value {type: "COMPONENT" | "COMPONENT_SET", key}.
//   * editComponentProperty(key, {defaultValue, preferredValues}) returns the key (a new one only for a new name);
//     deleteComponentProperty(key) removes it, and every reference to it.
//   * figma.combineAsVariants(components, parent) makes a COMPONENT_SET of them in `parent`; a variant's VARIANT
//     properties are read from its name ("Size=md, State=default").
import { componentKey, componentRootOf, propDefsOf, PROP_REF_FIELDS, type ComponentRootType, type PropDefType, type PropRefField } from "../../bridge/src/component-spec.ts";
import type { AppliedWrite, WriteImpactStep, WriteOp } from "../../bridge/src/commands.ts";
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import { checkTree } from "../../bridge/src/tree-check.ts";
import { KEY_DATA, readOld } from "./keyed-store";
import { planUpdate } from "../../bridge/src/tree-diff.ts";
import { resolveRefs, treeUses, type ResolvedRefs } from "./tree-refs";
import { setPlannedComponents } from "./batch-plan";
import type { Change } from "./write-batch";

export type Owner = ComponentNode | ComponentSetNode;
const label = (n: BaseNode): string => "'" + n.name + "' (" + n.id + ")";
const kindWord = (t: string): string => (t === "COMPONENT_SET" ? "a component set (variants)" : "a single component");

/** Every local main component and component set named exactly `name` (a variant inside a set is not one; nor is a
 *  library's), each page loaded before it is searched. */
export async function localComponentsNamed(name: string): Promise<Owner[]> {
  const out: Owner[] = [];
  for (const page of figma.root.children) {
    try {
      await page.loadAsync(); // dynamic-page: before it is walked
      for (const c of page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) {
        if (c.name !== name || c.remote) continue;
        if (c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET") continue;
        out.push(c);
      }
    } catch { /* a page that will not load holds no component a name could match */ }
  }
  return out;
}

/** What the file has under a component spec's name: nothing (build it), the one a write made (update it), or why the
 *  spec is refused. */
export async function existingComponent(type: ComponentRootType, name: string): Promise<{ none: true } | { ours: Owner } | { problem: string }> {
  const found = await localComponentsNamed(name);
  const one = found[0];
  if (!one) return { none: true };
  if (found.length > 1) return { problem: "component '" + name + "' matches " + found.length + " components in this file (" + found.slice(0, 3).map(label).join(", ") + "); a spec names its component by name — rename all but one, or give this one another name" };
  if (one.getPluginData(KEY_DATA) !== componentKey(name)) return { problem: "a component named '" + name + "' exists " + label(one) + " that a write did not make; patch it (a source edit: `patch` with its id) or choose another name" };
  if (one.type !== type) return { problem: "component '" + name + "' " + label(one) + " is " + kindWord(one.type) + ", and this spec makes " + kindWord(type) + "; a re-send cannot turn one into the other — give the new one another name" };
  return { ours: one };
}

/** A definition as addComponentProperty takes it. */
export interface FileDef {
  name: string;
  type: PropDefType;
  defaultValue: string | boolean;
  preferredValues?: InstanceSwapPreferredValue[];
}
/** A spec's definitions with every component they name resolved (resolveRefs: `refs.components`). */
export function fileDefs(spec: TreeNodeSpec, refs: ResolvedRefs): FileDef[] {
  return propDefsOf(spec).map(([name, d]) => {
    if (d.type !== "INSTANCE_SWAP") return { name, type: d.type, defaultValue: d.default };
    const main = refs.components.get(String(d.default));
    if (!main) throw new Error("component '" + String(d.default) + "' was not resolved before the batch ran");
    const out: FileDef = { name, type: d.type, defaultValue: main.type === "COMPONENT_SET" ? main.defaultVariant.id : main.id };
    if (d.preferredValues) {
      out.preferredValues = d.preferredValues.map((ref) => {
        const c = refs.components.get(ref);
        if (!c) throw new Error("component '" + ref + "' was not resolved before the batch ran");
        return { type: c.type, key: c.key };
      });
    }
    return out;
  });
}

/** Declare `defs` on a component (or set) the build just made: the key each got, by name. */
export function addDefs(owner: Owner, defs: readonly FileDef[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const d of defs) keys.set(d.name, owner.addComponentProperty(d.name, d.type, d.defaultValue, d.preferredValues ? { preferredValues: d.preferredValues } : undefined));
  return keys;
}

/** The references a spec node's `propRefs` make, keyed as componentPropertyReferences takes them (null: none). */
function refsFor(s: TreeNodeSpec, keys: ReadonlyMap<string, string>): { [k in PropRefField]?: string } | null {
  const r = s.propRefs;
  if (!r) return null;
  const out: { [k in PropRefField]?: string } = {};
  for (const f of PROP_REF_FIELDS) {
    const name = r[f];
    if (name === undefined) continue;
    const key = keys.get(name);
    if (key === undefined) throw new Error("property '" + name + "' was not declared on the component");
    out[f] = key;
  }
  return out;
}

/** Wire every layer a build made that names properties (`pairs`: each node with its spec). */
export function wireAll(pairs: ReadonlyArray<readonly [SceneNode, TreeNodeSpec]>, keys: ReadonlyMap<string, string>): void {
  for (const [n, s] of pairs) {
    const r = refsFor(s, keys);
    if (r && "componentPropertyReferences" in n) n.componentPropertyReferences = r;
  }
}

/** The reply's record of properties: bare name → key (own properties all: a name may be "__proto__"). */
export function propRecord(keys: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of keys) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

const bareName = (key: string): string => { const i = key.lastIndexOf("#"); return i > 0 ? key.slice(0, i) : key; };
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

/** What a re-send changes in a component's property definitions so they equal the spec's. */
export interface DefsPlan {
  owner: Owner;
  /** the definitions the spec declares */
  defs: FileDef[];
  /** the key of each definition the component keeps, by name */
  keys: Map<string, string>;
  add: FileDef[];
  edit: Array<{ key: string; def: FileDef; was: { defaultValue: string | boolean; preferredValues?: InstanceSwapPreferredValue[] } }>;
  /** deleted last of all, once every other step of the batch has landed (its references are unwired before) */
  remove: Array<{ key: string; name: string }>;
  /** what each kept layer's wiring needs (planWiring, filled in once the plan is made) */
  wiring: WiringStep[];
  /** the definitions declareDefs added or edited, by name (their keys): set once it has run */
  declared?: Map<string, string>;
}

/** Plan the definitions of the component a re-send updates; `bad` hears what cannot change in place. */
export function planDefs(owner: Owner, spec: TreeNodeSpec, refs: ResolvedRefs, bad: (m: string) => void): DefsPlan | null {
  // A swap default that did not resolve throws here; resolveRefs already reported it, so the batch is refused cleanly.
  let defs: FileDef[];
  try { defs = fileDefs(spec, refs); } catch { return null; }
  let current: ComponentPropertyDefinitions;
  try { current = owner.componentPropertyDefinitions; } catch { current = {}; }
  const have = new Map<string, { key: string; type: string; defaultValue: string | boolean; preferredValues?: InstanceSwapPreferredValue[] }>();
  for (const key of Object.keys(current)) {
    const d = current[key];
    if (!d || d.type === "VARIANT") continue;
    const name = bareName(key);
    if (!have.has(name)) have.set(name, { key, type: d.type, defaultValue: d.defaultValue, ...(d.preferredValues ? { preferredValues: d.preferredValues } : {}) });
  }
  const plan: DefsPlan = { owner, defs, keys: new Map(), add: [], edit: [], remove: [], wiring: [] };
  const wanted = new Set<string>();
  let ok = true;
  for (const d of defs) {
    wanted.add(d.name);
    const h = have.get(d.name);
    if (!h) { plan.add.push(d); continue; }
    if (h.type !== d.type) { bad("tree.props[" + JSON.stringify(d.name) + "]: '" + d.name + "' is a " + h.type + " property on " + label(owner) + "; its type cannot change in place — give it a new name (or drop it in one call and declare it again in the next)"); ok = false; continue; }
    plan.keys.set(d.name, h.key);
    const prefs = d.type === "INSTANCE_SWAP" ? d.preferredValues || [] : undefined;
    const hadPrefs = d.type === "INSTANCE_SWAP" ? h.preferredValues || [] : undefined;
    if (h.defaultValue !== d.defaultValue || !sameJson(prefs, hadPrefs)) plan.edit.push({ key: h.key, def: d, was: { defaultValue: h.defaultValue, ...(h.preferredValues ? { preferredValues: h.preferredValues } : {}) } });
  }
  for (const [name, h] of have) if (!wanted.has(name)) plan.remove.push({ key: h.key, name });
  return ok ? plan : null;
}

type Refs = { [k in PropRefField]?: string };
/** A kept layer's wiring on a re-send: the fields unwired before the patches run (their property changes or goes), the
 *  ones wired after them (a property it names anew), and the ones that stay bound to the same property (a patch never
 *  writes their field: Figma keeps it bound, and it follows the property's default). */
export interface WiringStep { ref: SceneNode; spec: TreeNodeSpec; unwire: PropRefField[]; wire: PropRefField[]; stays: PropRefField[] }

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** A layer's references as the file has them now ({} when none, or unreadable). */
function refsNow(n: SceneNode): Refs {
  let r: unknown;
  try { r = "componentPropertyReferences" in n ? n.componentPropertyReferences : null; } catch { r = null; }
  const out: Refs = {};
  if (typeof r !== "object" || r === null) return out;
  for (const f of PROP_REF_FIELDS) { const v: unknown = own(r, f) ? Reflect.get(r, f) : undefined; if (typeof v === "string") out[f] = v; }
  return out;
}
/** `refs` without the ones whose property `owner` no longer has: a restore never points a layer at a deleted key. */
function liveRefs(owner: Owner, refs: Refs): Refs {
  let defs: ComponentPropertyDefinitions;
  try { defs = owner.componentPropertyDefinitions; } catch { return refs; }
  const out: Refs = {};
  for (const f of PROP_REF_FIELDS) { const k = refs[f]; if (k !== undefined && own(defs, k)) out[f] = k; }
  return out;
}
const sameRefs = (a: Refs, b: Refs): boolean => PROP_REF_FIELDS.every((f) => a[f] === b[f]);

/** Plan the wiring of every layer a re-send keeps. Only a field whose `propRefs` changed since the last send (or whose
 *  property this send drops or declares anew) is touched: wiring the designer changed by hand otherwise stays. */
export function planWiring(p: DefsPlan, kept: ReadonlyArray<{ ref: SceneNode; spec: TreeNodeSpec; old: TreeNodeSpec }>): WiringStep[] {
  const dropped = new Set(p.remove.map((r) => r.key));
  const out: WiringStep[] = [];
  for (const k of kept) {
    if (!("componentPropertyReferences" in k.ref)) continue;
    const cur = refsNow(k.ref);
    const step: WiringStep = { ref: k.ref, spec: k.spec, unwire: [], wire: [], stays: [] };
    for (const f of PROP_REF_FIELDS) {
      const was = k.old.propRefs ? k.old.propRefs[f] : undefined;
      const now = k.spec.propRefs ? k.spec.propRefs[f] : undefined;
      const changed = was !== now || (now !== undefined && !p.keys.has(now));
      const has = cur[f];
      if (has !== undefined && (changed || dropped.has(has))) step.unwire.push(f);
      else if (has !== undefined) step.stays.push(f);
      if (now !== undefined && changed) step.wire.push(f);
    }
    if (step.unwire.length || step.wire.length || step.stays.length) out.push(step);
  }
  return out;
}

/** The kept texts still bound to a TEXT property whose default this re-send edits: Figma rewrites their characters, so
 *  their fonts are loaded before the batch runs. */
export function textsFollowing(p: DefsPlan): TextNode[] {
  const edited = new Set(p.edit.filter((e) => e.def.type === "TEXT").map((e) => e.key));
  const out: TextNode[] = [];
  for (const w of p.wiring) {
    const k = refsNow(w.ref).characters;
    if (w.ref.type === "TEXT" && w.stays.indexOf("characters") >= 0 && k !== undefined && edited.has(k)) out.push(w.ref);
  }
  return out;
}

/** Before a re-send's patches: unwire every field whose property changes or goes (so a patch can write it, and a
 *  deleted property leaves no reference a restore could bring back). Each layer is a Change. Returns the layers. */
export function unwireGoing(p: DefsPlan, consent: () => void, changes: Change[]): SceneNode[] {
  const out: SceneNode[] = [];
  for (const w of p.wiring) {
    if (!w.unwire.length) continue;
    const n = w.ref;
    const was = refsNow(n);
    const next: Refs = {};
    for (const f of PROP_REF_FIELDS) { const v = was[f]; if (v !== undefined && w.unwire.indexOf(f) < 0) next[f] = v; }
    if (sameRefs(was, next)) continue;
    consent();
    changes.push({ applied: { id: n.id }, kind: "unwired layer", what: "the property wiring of " + label(n), restore() { if ("componentPropertyReferences" in n) n.componentPropertyReferences = liveRefs(p.owner, was); } });
    if ("componentPropertyReferences" in n) n.componentPropertyReferences = next;
    out.push(n);
  }
  return out;
}

/** A re-send's definitions added and edited (a field still bound to an edited property follows its new default), each a
 *  Change on `changes` as it lands. A batch runs this for every component it updates before its other ops (writes.ts):
 *  Figma ends an undo step at each addComponentProperty and editComponentProperty, so nothing the batch shows may come
 *  before one. Kept on the plan (`declared`) for syncComponent. Returns how many calls it made. */
export function declareDefs(p: DefsPlan, consent: () => void, changes: Change[]): number {
  const owner = p.owner;
  const changed = new Map<string, string>();
  p.declared = changed;
  for (const d of p.add) {
    consent();
    const key = owner.addComponentProperty(d.name, d.type, d.defaultValue, d.preferredValues ? { preferredValues: d.preferredValues } : undefined);
    changes.push({ applied: { id: owner.id }, kind: "added property", what: "the property '" + d.name + "' of " + label(owner), restore() { owner.deleteComponentProperty(key); } });
    changed.set(d.name, key);
  }
  for (const e of p.edit) {
    consent();
    const next: { defaultValue: string | boolean; preferredValues?: InstanceSwapPreferredValue[] } = { defaultValue: e.def.defaultValue };
    if (e.def.type === "INSTANCE_SWAP") next.preferredValues = e.def.preferredValues || [];
    const key = owner.editComponentProperty(e.key, next);
    // A swap that had no suggestions gets none back (an empty list clears the ones this edit added).
    const back: { defaultValue: string | boolean; preferredValues?: InstanceSwapPreferredValue[] } = { defaultValue: e.was.defaultValue };
    if (e.def.type === "INSTANCE_SWAP") back.preferredValues = e.was.preferredValues || [];
    changes.push({ applied: { id: owner.id }, kind: "edited property", what: "the property '" + e.def.name + "' of " + label(owner), restore() { owner.editComponentProperty(key, back); } });
    changed.set(e.def.name, key);
  }
  return p.add.length + p.edit.length;
}

/** A re-send's component work, once its nodes are updated and built: the definitions declareDefs added and edited (it
 *  runs here if the batch has not run it), then the wiring each kept layer gains and every layer the re-send built
 *  wired. `unwired` are the layers unwireGoing changed. Each step is on `changes` as it lands. Returns what it changed,
 *  for the reply. */
export function syncComponent(p: DefsPlan, unwired: readonly SceneNode[], built: ReadonlyArray<readonly [SceneNode, TreeNodeSpec]>,
  consent: () => void, changes: Change[]): { props: Map<string, string>; rewired: number } {
  const owner = p.owner;
  if (!p.declared) declareDefs(p, consent, changes);
  const changed = new Map<string, string>(p.declared || []);
  const keys = new Map(p.keys);
  for (const [name, key] of changed) keys.set(name, key);
  const touched = new Set<SceneNode>(unwired);
  const wire = (n: SceneNode, r: Refs): void => {
    if (!("componentPropertyReferences" in n)) return;
    const was = refsNow(n);
    if (sameRefs(was, r)) return;
    consent();
    changes.push({ applied: { id: n.id }, kind: "wired layer", what: "the property wiring of " + label(n), restore() { n.componentPropertyReferences = liveRefs(owner, was); } });
    n.componentPropertyReferences = r;
    touched.add(n);
  };
  for (const w of p.wiring) {
    if (!w.wire.length) continue;
    const r = refsNow(w.ref);
    const all = refsFor(w.spec, keys) || {};
    for (const f of w.wire) { const k = all[f]; if (k !== undefined) r[f] = k; }
    wire(w.ref, r);
  }
  for (const [n, s] of built) if (s.propRefs) wire(n, refsFor(s, keys) || {});
  return { props: changed, rewired: touched.size };
}

/** Delete the definitions a re-send dropped: the very last step of the batch, once every node it removes is gone (a
 *  deleted property cannot be brought back). `gone` hears each as it is deleted. Returns their names. */
export function removeDefs(p: DefsPlan, consent: () => void, gone: (name: string) => void): string[] {
  const out: string[] = [];
  let current: ComponentPropertyDefinitions;
  try { current = p.owner.componentPropertyDefinitions; } catch { current = {}; }
  for (const r of p.remove) {
    if (!own(current, r.key)) continue;
    consent();
    p.owner.deleteComponentProperty(r.key);
    out.push(r.name);
    gone(r.name);
  }
  return out;
}

/** The variants among `removed` (a set's COMPONENT children) whose instances lose their main component, each as a
 *  warning: "removing variant 'Size=sm' leaves 3 instances without a main component". */
export async function orphanWarnings(removed: readonly SceneNode[]): Promise<string[]> {
  const out: string[] = [];
  for (const n of removed) {
    if (n.removed || n.type !== "COMPONENT" || !n.parent || n.parent.type !== "COMPONENT_SET") continue;
    let count = 0;
    try { count = (await n.getInstancesAsync()).length; } catch { continue; }
    if (count) out.push("removing variant '" + n.name + "' of '" + n.parent.name + "' leaves " + count + " instance" + (count === 1 ? "" : "s") + " without a main component");
  }
  return out;
}

/** The space around and between the variants of a set without auto-layout, laid out in one column. */
const VARIANT_GAP = 20;
/** Lay out the variants of a set without auto-layout that the spec gives no place (`only`: just these, below the
 *  others), and size the set to hold them all when the spec gives it no size; a set with auto-layout hugs them unless the
 *  spec sizes it. */
export function arrangeVariants(set: ComponentSetNode, spec: TreeNodeSpec, only: readonly ComponentNode[] | null): void {
  const sized = spec.box !== undefined || (spec.layout !== undefined && (spec.layout.width !== undefined || spec.layout.height !== undefined));
  if (set.layoutMode !== "NONE") {
    if (!sized && spec.widthMode === undefined) set.layoutSizingHorizontal = "HUG";
    if (!sized && spec.heightMode === undefined) set.layoutSizingVertical = "HUG";
    return;
  }
  const byNode = new Map<SceneNode, TreeNodeSpec>();
  (spec.children || []).forEach((c) => { const n = set.children.filter((k) => k.name === c.name)[0]; if (n) byNode.set(n, c); });
  let y = VARIANT_GAP;
  for (const c of set.children) {
    const s = byNode.get(c);
    const placed = s !== undefined && (s.x !== undefined || s.y !== undefined);
    if ((only === null || only.indexOf(c as ComponentNode) >= 0) && !placed) { c.x = VARIANT_GAP; c.y = y; }
    y = Math.max(y, c.y + c.height + VARIANT_GAP);
  }
  if (sized) return;
  let w = 0;
  let h = 0;
  for (const c of set.children) { w = Math.max(w, c.x + c.width + VARIANT_GAP); h = Math.max(h, c.y + c.height + VARIANT_GAP); }
  if (w > 0 && h > 0) set.resize(w, h);
}

/** The reply of a re-send's component work, merged into the keyed update's reply. */
export function componentReply(applied: AppliedWrite, name: string, props: ReadonlyMap<string, string>, rewired: number): void {
  delete applied.key;
  applied.component = name;
  if (props.size) applied.props = propRecord(props);
  if (rewired) applied.rewired = rewired;
}

/** The dry run's file-side half for the component specs of a batch: whether each would be made or updated in place (and
 *  how many instances follow), or why the file refuses it. */
export async function componentImpact(ops: readonly WriteOp[]): Promise<WriteImpactStep[]> {
  const steps: WriteImpactStep[] = [];
  // A batch that makes or updates a component: the component names its specs use are resolved as the write would
  // resolve them, so a name the same batch makes or updates is refused here too (a copy's and a patch's swap values
  // are not: they need their nodes resolved).
  const planned = new Map<string, number>();
  const specs = new Map<number, { spec: TreeNodeSpec; labels: ReadonlyMap<object, string> }>();
  for (const [index, op] of ops.entries()) {
    if (op.op !== "createTree") continue;
    const c = componentRootOf(op.tree);
    if (c && !planned.has(c.name)) planned.set(c.name, index);
    const checked = checkTree(op.tree);
    if (!checked.problems.length && checked.expanded) specs.set(index, { spec: checked.expanded, labels: checked.labels });
  }
  if (planned.size) {
    setPlannedComponents(planned);
    try {
      const uses = treeUses(specs).filter((u) => u.kind === "component");
      const r = await resolveRefs(uses, async () => null);
      for (const p of r.problems) steps.push({ index: p.index, op: "createTree", problem: p.message });
    } finally {
      setPlannedComponents(new Map());
    }
  }
  for (const [index, op] of ops.entries()) {
    if (op.op !== "createTree") continue;
    const c = componentRootOf(op.tree);
    const checked = c ? checkTree(op.tree) : null;
    if (!c || !checked || checked.problems.length || !checked.expanded) continue;
    const found = await existingComponent(c.type, c.name);
    const what = (c.type === "COMPONENT_SET" ? "component set '" : "component '") + c.name + "'";
    if ("problem" in found) { steps.push({ index, op: op.op, problem: found.problem }); continue; }
    if ("none" in found) { steps.push({ index, op: op.op, plan: { create: [what], update: [] }, change: "would create " + what }); continue; }
    let instances = 0;
    const mains = found.ours.type === "COMPONENT_SET" ? found.ours.children.filter((k): k is ComponentNode => k.type === "COMPONENT") : [found.ours];
    for (const m of mains) { try { instances += (await m.getInstancesAsync()).length; } catch { /* not counted */ } }
    // The variants the new table no longer has (its rows dropped), and the instances each leaves without a main.
    const old = readOld(found.ours, componentKey(c.name));
    const orphans = old ? await orphanWarnings(planUpdate(old, checked.expanded).removals) : [];
    steps.push({ index, op: op.op, plan: { create: [], update: [what] }, affects: { instances }, change: "would update " + what + " in place (" + instances + " instance" + (instances === 1 ? "" : "s") + " follow)" + orphans.map((w) => "; " + w).join("") });
  }
  return steps;
}
