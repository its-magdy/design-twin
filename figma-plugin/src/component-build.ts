// Components from a tree spec (writes: createTree with a COMPONENT or COMPONENT_SET root; bridge/src/component-spec.ts).
//
// A component's name is its key. Before the batch runs (keyed.ts resolveKeyed), the file's local main components and
// sets are searched for the spec's name (existingComponent):
//   * none: the spec builds a new one (tree.ts buildComponent) and stamps what it built with componentKey(name);
//   * one, stamped by a write: it is updated in place through the keyed re-send machinery (keyed.ts), so its id and its
//     variants' and layers' ids stay and every instance follows; this module brings its property definitions to the
//     spec (planDefs → syncComponent: added, edited, and — with the batch's removals, once everything else has landed —
//     deleted) and wires each layer whose `propRefs` changed;
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
import { componentKey, componentRootOf, propDefsOf, PROP_REF_FIELDS, type ComponentRootType, type PropDefType } from "../../bridge/src/component-spec.ts";
import type { AppliedWrite, WriteImpactStep, WriteOp } from "../../bridge/src/commands.ts";
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import { checkTree } from "../../bridge/src/tree-check.ts";
import { KEY_DATA } from "./keyed-store";
import type { ResolvedRefs } from "./tree-refs";
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
function refsFor(s: TreeNodeSpec, keys: ReadonlyMap<string, string>): { [k in "characters" | "visible" | "mainComponent"]?: string } | null {
  const r = s.propRefs;
  if (!r) return null;
  const out: { [k in "characters" | "visible" | "mainComponent"]?: string } = {};
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
  /** run with the batch's removals, once everything else has landed (a deleted property takes its references along) */
  remove: Array<{ key: string; name: string }>;
}

/** Plan the definitions of the component a re-send updates; `bad` hears what cannot change in place. */
export function planDefs(owner: Owner, spec: TreeNodeSpec, refs: ResolvedRefs, bad: (m: string) => void): DefsPlan | null {
  const defs = fileDefs(spec, refs);
  let current: ComponentPropertyDefinitions;
  try { current = owner.componentPropertyDefinitions; } catch { current = {}; }
  const have = new Map<string, { key: string; type: string; defaultValue: string | boolean; preferredValues?: InstanceSwapPreferredValue[] }>();
  for (const key of Object.keys(current)) {
    const d = current[key];
    if (!d || d.type === "VARIANT") continue;
    const name = bareName(key);
    if (!have.has(name)) have.set(name, { key, type: d.type, defaultValue: d.defaultValue, ...(d.preferredValues ? { preferredValues: d.preferredValues } : {}) });
  }
  const plan: DefsPlan = { owner, defs, keys: new Map(), add: [], edit: [], remove: [] };
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

/** A re-send's component work, once its nodes are updated and built: the definitions added and edited, then every layer
 *  whose wiring changed wired again. `kept` are the nodes the update kept (with their old and new spec), `built` the
 *  ones it built. Each step is on `changes` as it lands. Returns what it changed, for the reply. */
export function syncComponent(p: DefsPlan, kept: ReadonlyArray<{ ref: SceneNode; spec: TreeNodeSpec; old: TreeNodeSpec }>, built: ReadonlyArray<readonly [SceneNode, TreeNodeSpec]>,
  consent: () => void, changes: Change[]): { props: Map<string, string>; rewired: number } {
  const owner = p.owner;
  const changed = new Map<string, string>();
  const keys = new Map(p.keys);
  for (const d of p.add) {
    consent();
    const key = owner.addComponentProperty(d.name, d.type, d.defaultValue, d.preferredValues ? { preferredValues: d.preferredValues } : undefined);
    changes.push({ applied: { id: owner.id }, kind: "added property", what: "the property '" + d.name + "' of " + label(owner), restore() { owner.deleteComponentProperty(key); } });
    keys.set(d.name, key);
    changed.set(d.name, key);
  }
  for (const e of p.edit) {
    consent();
    const next: { defaultValue: string | boolean; preferredValues?: InstanceSwapPreferredValue[] } = { defaultValue: e.def.defaultValue };
    if (e.def.type === "INSTANCE_SWAP") next.preferredValues = e.def.preferredValues || [];
    const key = owner.editComponentProperty(e.key, next);
    changes.push({ applied: { id: owner.id }, kind: "edited property", what: "the property '" + e.def.name + "' of " + label(owner), restore() { owner.editComponentProperty(key, e.was.preferredValues ? { defaultValue: e.was.defaultValue, preferredValues: e.was.preferredValues } : { defaultValue: e.was.defaultValue }); } });
    keys.set(e.def.name, key);
    changed.set(e.def.name, key);
  }
  // A layer is wired again when its spec's wiring changed, or names a property this re-send declared anew.
  let rewired = 0;
  const fresh = new Set(p.add.map((d) => d.name));
  const wire = (n: SceneNode, s: TreeNodeSpec, force: boolean): void => {
    if (!("componentPropertyReferences" in n)) return;
    const r = refsFor(s, keys) || {};
    const names = s.propRefs ? PROP_REF_FIELDS.map((f) => (s.propRefs ? s.propRefs[f] : undefined)).filter((x): x is string => x !== undefined) : [];
    if (!force && !names.some((x) => fresh.has(x))) return;
    const was = n.componentPropertyReferences;
    if (sameJson(was || {}, r)) return;
    consent();
    changes.push({ applied: { id: n.id }, kind: "wired layer", what: "the property wiring of " + label(n), restore() { n.componentPropertyReferences = was || {}; } });
    n.componentPropertyReferences = r;
    rewired++;
  };
  for (const k of kept) wire(k.ref, k.spec, !sameJson(k.old.propRefs, k.spec.propRefs));
  for (const [n, s] of built) if (s.propRefs) wire(n, s, true);
  return { props: changed, rewired };
}

/** Delete the definitions a re-send dropped (after the rest of the batch). Returns their names. */
export function removeDefs(p: DefsPlan, consent: () => void): string[] {
  const out: string[] = [];
  let current: ComponentPropertyDefinitions;
  try { current = p.owner.componentPropertyDefinitions; } catch { current = {}; }
  for (const r of p.remove) {
    if (!Object.prototype.hasOwnProperty.call(current, r.key)) continue;
    consent();
    p.owner.deleteComponentProperty(r.key);
    out.push(r.name);
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
  for (const [index, op] of ops.entries()) {
    if (op.op !== "createTree") continue;
    const c = componentRootOf(op.tree);
    if (!c || checkTree(op.tree).problems.length) continue;
    const found = await existingComponent(c.type, c.name);
    const what = (c.type === "COMPONENT_SET" ? "component set '" : "component '") + c.name + "'";
    if ("problem" in found) { steps.push({ index, op: op.op, problem: found.problem }); continue; }
    if ("none" in found) { steps.push({ index, op: op.op, plan: { create: [what], update: [] }, change: "would create " + what }); continue; }
    let instances = 0;
    const mains = found.ours.type === "COMPONENT_SET" ? found.ours.children.filter((k): k is ComponentNode => k.type === "COMPONENT") : [found.ours];
    for (const m of mains) { try { instances += (await m.getInstancesAsync()).length; } catch { /* not counted */ } }
    steps.push({ index, op: op.op, plan: { create: [], update: [what] }, affects: { instances }, change: "would update " + what + " in place (" + instances + " instance" + (instances === 1 ? "" : "s") + " follow)" });
  }
  return steps;
}
