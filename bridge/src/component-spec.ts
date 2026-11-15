// component-spec.ts — a tree spec that makes a local component (docs/write-plane-spec.md, "Components"): the parts of
// the spec only a component has, shared by the check (tree-spec.ts), the variant table's expansion (tree-expand.ts),
// the dry run and the plugin (figma-plugin/src/component-build.ts).
//
//   * The root's `type: "COMPONENT"` makes a main component instead of a frame; `type: "COMPONENT_SET"` a set of
//     variants, from a table (tree-expand.ts) of a base `variant` and one row of values per variant.
//   * The root's `props` are the component's property DEFINITIONS (on an instance they stay values): a TEXT, BOOLEAN or
//     INSTANCE_SWAP property by its bare name, with its default (and, for a swap, the components it suggests). A
//     VARIANT property is a column of the table, never declared here.
//   * A layer inside takes `propRefs` (the read's own field, holding a property's bare name): `characters` on a TEXT,
//     `visible` on any layer, `mainComponent` on an INSTANCE.
//   * A component's name is its key: sending a spec with the same name again updates the component in place, so its
//     instances follow. The plugin stamps what it builds with componentKey(name) (keyed-store.ts), which no `key` a spec
//     carries can be (tree-spec.ts refuses a key with the RESERVED_KEY_PREFIX).
//
// Pure and dependency-free (bar a pure sibling): the plugin bundle imports it, so it must type-check under
// figma-plugin/tsconfig.json (ES2019 lib, no Node types), and use no `??` or `?.`.
import { nearestNames, quoteList } from "./name-match.ts";

export type ComponentRootType = "COMPONENT" | "COMPONENT_SET";
export type PropDefType = "TEXT" | "BOOLEAN" | "INSTANCE_SWAP";
/** A property definition as a spec declares it: its type, its default (a TEXT's string, a BOOLEAN's boolean, an
 *  INSTANCE_SWAP's component by name, key or id) and, for a swap, the components it suggests. */
export interface TreePropDef {
  type: PropDefType;
  default: string | boolean;
  preferredValues?: string[];
}
/** Which layer field a property drives, and the type of property it takes. */
export const PROP_REF_TYPES: Readonly<Record<"characters" | "visible" | "mainComponent", PropDefType>> = {
  characters: "TEXT", visible: "BOOLEAN", mainComponent: "INSTANCE_SWAP",
};
export type PropRefField = keyof typeof PROP_REF_TYPES;
export const PROP_REF_FIELDS: readonly PropRefField[] = ["characters", "visible", "mainComponent"];

/** The prefix of the stamp a component carries (keyed-store.ts): a spec's own `key` may not start with it. */
export const RESERVED_KEY_PREFIX = "dtwin/";
/** The key a component built from a spec is stamped with: its name. */
export const componentKey = (name: string): string => RESERVED_KEY_PREFIX + "component:" + name;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const at = (path: string, name: string): string => path + "[" + JSON.stringify(name) + "]";

/** The component a spec's root makes (its type and name), or null when the root is a frame or a copy. */
export function componentRootOf(spec: unknown): { type: ComponentRootType; name: string } | null {
  if (!isObj(spec) || (spec.type !== "COMPONENT" && spec.type !== "COMPONENT_SET")) return null;
  return { type: spec.type, name: typeof spec.name === "string" ? spec.name : "" };
}

/** A component root's property definitions, in the order the spec gives them (own keys only: a property may be called
 *  "constructor"). Only for a spec the check accepted. */
export function propDefsOf(spec: { props?: unknown }): Array<[string, TreePropDef]> {
  const p = spec.props;
  if (!isObj(p)) return [];
  const out: Array<[string, TreePropDef]> = [];
  for (const k of Object.keys(p)) {
    const d = p[k];
    if (!isObj(d) || (d.type !== "TEXT" && d.type !== "BOOLEAN" && d.type !== "INSTANCE_SWAP")) continue;
    const def: TreePropDef = { type: d.type, default: typeof d.default === "boolean" ? d.default : String(d.default) };
    if (Array.isArray(d.preferredValues)) def.preferredValues = d.preferredValues.filter((x): x is string => typeof x === "string");
    out.push([k, def]);
  }
  return out;
}

/** The components a component root's definitions name (swap defaults and suggestions), first-use order. */
export function propDefComponents(spec: { props?: unknown }): string[] {
  const out: string[] = [];
  const add = (n: string): void => { if (out.indexOf(n) < 0) out.push(n); };
  for (const [, d] of propDefsOf(spec)) {
    if (d.type !== "INSTANCE_SWAP") continue;
    if (typeof d.default === "string") add(d.default);
    for (const p of d.preferredValues || []) add(p);
  }
  return out;
}

const DEF_FIELDS = ["type", "default", "preferredValues"];
/** Why "__proto__" cannot name a property or a variant column: Figma's own main-thread → UI message copy drops a key of
 *  that name (seen live, as for a `handle`), so the reply would lose it. */
export const PROTO_NAME = "'__proto__' cannot be a property name (Figma's message passing drops that key); pick another name";

/** Every problem with a component root's `props` (its definitions), each starting with `path`. `columns` are the set's
 *  VARIANT properties (a definition may not take one's name). */
export function propDefsProblems(v: unknown, path: string, columns: readonly string[]): string[] {
  const out: string[] = [];
  if (!isObj(v)) return [path + ": on a component, `props` declares its properties — an object of property name → {type, default}"];
  for (const name of Object.keys(v)) {
    const d = v[name];
    if (d === undefined) continue;
    const p = at(path, name);
    if (!name.trim()) { out.push(path + ": has an empty property name"); continue; }
    if (name === "__proto__") { out.push(p + ": " + PROTO_NAME); continue; }
    if (name.trim() !== name || !name) { out.push(p + ": a property's name cannot be empty or start or end with a space"); continue; }
    if (name.indexOf("#") >= 0) { out.push(p + ": a property's name cannot hold '#' (Figma keeps it for the property's id)"); continue; }
    if (columns.indexOf(name) >= 0) { out.push(p + ": '" + name + "' is a column of the variant table (a VARIANT property) already; give this property another name"); continue; }
    if (!isObj(d)) { out.push(p + ": must be a definition {type, default} (TEXT, BOOLEAN or INSTANCE_SWAP)"); continue; }
    for (const k of Object.keys(d)) {
      if (d[k] === undefined || DEF_FIELDS.indexOf(k) >= 0) continue;
      const near = nearestNames(k, DEF_FIELDS);
      out.push(p + "." + k + ": not a field of a property definition" + (near.length ? "; closest: " + quoteList(near) : "") + " (it takes type, default, preferredValues)");
    }
    const t = d.type;
    if (t === "VARIANT") { out.push(p + ".type: a VARIANT property comes from the variant table (a COMPONENT_SET root's `columns` and `rows`), never from `props`"); continue; }
    if (t === "SLOT") { out.push(p + ".type: a SLOT property cannot be written yet (TEXT, BOOLEAN and INSTANCE_SWAP can)"); continue; }
    if (t !== "TEXT" && t !== "BOOLEAN" && t !== "INSTANCE_SWAP") { out.push(p + ".type: must be one of TEXT | BOOLEAN | INSTANCE_SWAP"); continue; }
    const def = d.default;
    if (def === undefined) out.push(p + ": is missing default (" + (t === "TEXT" ? "the text an instance shows unless it sets its own" : t === "BOOLEAN" ? "true or false" : "the component an instance shows: its name, key or id") + ")");
    else if (t === "TEXT" && typeof def !== "string") out.push(p + ".default: a TEXT property's default is a string");
    else if (t === "BOOLEAN" && typeof def !== "boolean") out.push(p + ".default: a BOOLEAN property's default is true or false");
    else if (t === "INSTANCE_SWAP" && (typeof def !== "string" || !def.trim())) out.push(p + ".default: an INSTANCE_SWAP property's default is a component (its exact name, key or id)");
    const pv = d.preferredValues;
    if (pv !== undefined) {
      if (t !== "INSTANCE_SWAP") out.push(p + ".preferredValues: only an INSTANCE_SWAP property suggests components");
      else if (!Array.isArray(pv) || !pv.length || !pv.every((x) => typeof x === "string" && x.trim().length > 0)) out.push(p + ".preferredValues: must be a non-empty list of components (each its exact name, key or id)");
    }
  }
  return out;
}

/** `propRefs`'s shape: an object of characters / visible / mainComponent → a property's bare name. */
export function propRefsShape(v: unknown): string | null {
  if (!isObj(v)) return "must be an object {characters?, visible?, mainComponent?} of the property each field follows";
  const fields: readonly string[] = PROP_REF_FIELDS;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x === undefined) continue;
    if (fields.indexOf(k) < 0) {
      const near = nearestNames(k, fields);
      return "." + k + ": not a field a property drives" + (near.length ? "; closest: " + quoteList(near) : "") + " (characters, visible, mainComponent)";
    }
    if (typeof x !== "string" || !x.trim()) return "." + k + " must be a property's name (as the component root's `props` declares it)";
  }
  return null;
}

/** The VARIANT properties a variant's name holds ("Size=md, State=default" → Size, State), in order. */
export function variantColumns(name: string): string[] {
  return name.split(", ").map((part) => { const i = part.indexOf("="); return i > 0 ? part.slice(0, i) : part; });
}

/** `o[k]` when `o` holds `k` itself (never a prototype's field: a name may be "constructor"). */
export function ownField(o: unknown, k: string): unknown {
  return isObj(o) && own(o, k) ? o[k] : undefined;
}
