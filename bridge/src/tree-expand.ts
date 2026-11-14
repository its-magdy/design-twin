// tree-expand.ts — repetition in a tree spec (docs/write-plane-spec.md decision 7): named fragments and instance rows,
// expanded into the plain tree the rest of the write path already knows.
//
//   * A fragment is a node spec defined once under the root's `fragments` (name → spec) and placed by name: a node
//     `{use: "card", ...fields, edits?}` is a copy of the fragment, its own fields laid over the fragment's root and
//     `edits` (a layer name inside the fragment → fields) over the named layers. A field set to null in an edit is
//     dropped. A fragment may use another; one that uses itself is refused.
//   * An instance may take a table of rows: `{component, props?, rows: [{prop: value}, …]}`, or with `columns: [prop, …]`
//     each row a list of values in that order. It is one instance per row, each with the node's `props` and its row's.
//
// The expanded tree is what checkTree (tree-spec.ts) checks, the dry run describes and the plugin builds, so a spec
// using either is held to every rule a spelled-out one is, the all-or-nothing rule included: a problem anywhere refuses
// the whole spec before anything is built. Problems name the path as the agent wrote it (`tree.children[2]`, a row as
// `tree.children[1].rows[3]`, a fragment's layers below the node that uses it), through `labels`.
//
// Pure and dependency-free (bar a pure sibling): the plugin bundle imports it, so it must type-check under
// figma-plugin/tsconfig.json (ES2019 lib, no Node types), and use no `??` or `?.`.
import { nearestNames, quoteList } from "./name-match.ts";

/** A row of an instance's table: property name → value, or (with `columns`) the values in column order. */
export type TreeRow = Record<string, string | boolean> | Array<string | boolean>;

export interface Expansion {
  /** the spec with every fragment placed and every row table spread (the spec itself when it uses neither) */
  tree: unknown;
  /** what is wrong with the fragments or rows, each starting with its path; the tree is not usable when there are any */
  problems: string[];
  /** what is accepted but does nothing (a fragment no node uses) */
  warnings: string[];
  /** the path each expanded node has in the spec as written (a node not in it keeps the path its place gives it) */
  labels: Map<object, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** The fields only repetition reads: none survives expansion. */
const REPEAT_FIELDS = ["use", "fragments", "rows", "columns"] as const;
/** Fields an edit of a fragment's layer cannot set: they would change what the fragment is, not a value in it. */
const NOT_EDITED = ["use", "fragments", "edits", "key"];

/** `v` (a JSON value) copied, so an expansion never shares an object with the spec or with another copy. */
function copy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(copy);
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = copy(v[k]);
  return out;
}

/** `spec` names a fragment or a row table anywhere (a spec without either is passed through untouched). */
function repeats(v: unknown, depth: number): boolean {
  if (depth > 200) return true; // the walk below reports it
  if (Array.isArray(v)) return v.some((x) => repeats(x, depth + 1));
  if (!isObj(v)) return false;
  for (const k of REPEAT_FIELDS) if (v[k] !== undefined) return true;
  return Array.isArray(v.children) && v.children.some((c) => repeats(c, depth + 1));
}

/** Every node object of a fragment's own tree (not inside the fragments it uses), for its edits. */
function layersOf(n: unknown, out: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (!isObj(n)) return out;
  out.push(n);
  if (Array.isArray(n.children)) for (const c of n.children) layersOf(c, out);
  return out;
}

const propValue = (v: unknown): v is string | boolean => typeof v === "string" || typeof v === "boolean";

/**
 * Expand `spec`'s fragments and row tables. `maxNodes` caps the expanded tree (a fragment used inside a fragment used
 * many times multiplies), so a runaway is refused while it is being expanded, not after.
 */
export function expandTree(spec: unknown, maxNodes: number): Expansion {
  const labels = new Map<object, string>();
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isObj(spec) || !repeats(spec, 0)) return { tree: spec, problems, warnings, labels };
  const say = (m: string): void => { problems.push(m); };

  const fragments: Record<string, unknown> = {};
  const defs = spec.fragments;
  if (defs !== undefined) {
    if (!isObj(defs)) say("tree.fragments: must be an object of fragment name → node spec");
    else for (const name of Object.keys(defs)) {
      const f = defs[name];
      const at = "tree.fragments[" + JSON.stringify(name) + "]";
      if (!name.trim()) say("tree.fragments: a fragment name must be a non-empty string");
      else if (!isObj(f)) say(at + ": must be a node spec");
      else if (f.key !== undefined) say(at + ".key: a key names a whole result, so only the spec's root carries it");
      else fragments[name] = f;
    }
  }
  const used = new Set<string>();
  let count = 0;
  let tooMany = false;

  /** `n` expanded: the nodes it stands for (a row table stands for several). `path` is where it is in the spec as
   *  written; `stack` the fragments being placed around it (a fragment met again inside itself is a loop). */
  const expand = (n: unknown, path: string, stack: readonly string[], isRoot: boolean): unknown[] => {
    if (tooMany) return [];
    if (!isObj(n)) return [n];
    if (!isRoot && n.fragments !== undefined) say(path + ".fragments: fragments are defined once, on the spec's root");
    if (n.use !== undefined) return place(n, path, stack, isRoot);
    if (n.rows !== undefined) return spread(n, path);
    if (n.columns !== undefined) say(path + ".columns: names the values of each row in `rows`, which this node does not have");
    if (++count > maxNodes) { tooMany = true; return []; }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(n)) if (k !== "fragments" && k !== "children") out[k] = copy(n[k]);
    if (Array.isArray(n.children)) {
      const kids: unknown[] = [];
      n.children.forEach((c, i) => { for (const x of expand(c, path + ".children[" + i + "]", stack, false)) kids.push(x); });
      out.children = kids;
    } else if (n.children !== undefined) out.children = copy(n.children);
    labels.set(out, path);
    return [out];
  };

  /** A `use` node: a copy of the fragment, its edits and own fields laid over it, then expanded in turn. */
  const place = (n: Record<string, unknown>, path: string, stack: readonly string[], isRoot: boolean): unknown[] => {
    const name = n.use;
    if (typeof name !== "string" || !name.trim()) { say(path + ".use: must be a fragment's name"); return []; }
    if (!own(fragments, name)) {
      const near = nearestNames(name, Object.keys(fragments));
      say(path + ".use: no fragment '" + name + "'" + (near.length ? "; closest: " + quoteList(near) : "; define it under the root's `fragments`"));
      return [];
    }
    if (stack.indexOf(name) >= 0) { say(path + ".use: fragment '" + name + "' uses itself (" + stack.concat(name).map((s) => "'" + s + "'").join(" → ") + ")"); return []; }
    used.add(name);
    if (n.children !== undefined) say(path + ".children: a fragment's layers come from the fragment; change one with `edits` (its layer name → fields)");
    if (n.rows !== undefined || n.columns !== undefined) say(path + ": `rows` is on an instance (a node with `component`), not on a fragment");
    const body = copy(fragments[name]);
    if (!isObj(body)) return [];
    if (n.edits !== undefined) {
      if (!isObj(n.edits)) say(path + ".edits: must be an object of a layer name in the fragment → the fields it changes");
      else {
        const layers = layersOf(body, []);
        for (const layer of Object.keys(n.edits)) {
          const fields = n.edits[layer];
          const at = path + ".edits[" + JSON.stringify(layer) + "]";
          if (!isObj(fields)) { say(at + ": must be an object of the fields to change"); continue; }
          const hits = layers.filter((l) => l.name === layer);
          if (hits.length !== 1) {
            const names = layers.map((l) => l.name).filter((x): x is string => typeof x === "string");
            say(at + ": " + (hits.length ? "matches " + hits.length + " layers of fragment '" + name + "'; give them different names"
              : "no layer of fragment '" + name + "' has that name" + (nearestNames(layer, names).length ? "; closest: " + quoteList(nearestNames(layer, names)) : "")));
            continue;
          }
          const target = hits[0];
          if (!target) continue;
          for (const k of Object.keys(fields)) {
            if (NOT_EDITED.indexOf(k) >= 0) { say(at + "." + k + ": an edit changes a layer's fields; `" + k + "` cannot be edited"); continue; }
            const v = fields[k];
            if (v === null) delete target[k];
            else if (v !== undefined) target[k] = copy(v);
          }
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === "use" || k === "edits" || k === "children" || (k === "fragments" && isRoot)) continue;
      if (n[k] !== undefined) body[k] = copy(n[k]);
    }
    return expand(body, path + " (fragment '" + name + "')", stack.concat(name), isRoot);
  };

  /** An instance with a row table: one instance per row, each with the node's props and the row's. */
  const spread = (n: Record<string, unknown>, path: string): unknown[] => {
    const at = path + ".rows";
    if (n.component === undefined || (n.type !== undefined && n.type !== "INSTANCE")) { say(at + ": a row table is on an instance (a node with `component`); repeat other parts with a fragment (`use`)"); return []; }
    if (n.handle !== undefined) say(path + ".handle: a handle names one node, and a row table makes several; leave it out");
    if (n.children !== undefined) say(path + ".children: an instance's layers come from its component");
    const cols = n.columns;
    if (cols !== undefined && (!Array.isArray(cols) || !cols.length || !cols.every((c) => typeof c === "string" && c.trim().length > 0))) {
      say(path + ".columns: must be a non-empty list of property names"); return [];
    }
    if (Array.isArray(cols) && new Set(cols).size !== cols.length) { say(path + ".columns: names a property twice"); return []; }
    const rows = n.rows;
    if (!Array.isArray(rows) || !rows.length) { say(at + ": must be a non-empty list of rows" + (Array.isArray(cols) ? " (each a list of values, one per column)" : " (each an object of property name → value)")); return []; }
    const base = isObj(n.props) ? n.props : {};
    const out: unknown[] = [];
    rows.forEach((row, i) => {
      const r = at + "[" + i + "]";
      let props: Record<string, unknown> | null = null;
      if (Array.isArray(cols)) {
        if (!Array.isArray(row) || row.length !== cols.length) { say(r + ": must be a list of " + cols.length + " value" + (cols.length === 1 ? "" : "s") + ", one per column (" + quoteList(cols.map(String)) + ")"); return; }
        const bad = row.findIndex((v) => !propValue(v));
        if (bad >= 0) { say(r + "[" + bad + "]: must be a string (a variant's value, a text) or a boolean"); return; }
        props = {};
        for (const [j, c] of cols.entries()) props[String(c)] = row[j];
      } else {
        if (!isObj(row)) { say(r + ": must be an object of property name → value (or give `columns` and a list of values)"); return; }
        const bad = Object.keys(row).find((k) => !propValue(row[k]) || !k.trim());
        if (bad !== undefined) { say(r + (bad.trim() ? "." + bad + ": must be a string (a variant's value, a text) or a boolean" : ": has an empty property name")); return; }
        props = row;
      }
      if (++count > maxNodes) { tooMany = true; return; }
      const inst: Record<string, unknown> = {};
      for (const k of Object.keys(n)) if (k !== "rows" && k !== "columns" && k !== "props" && k !== "handle") inst[k] = copy(n[k]);
      inst.props = Object.assign({}, copy(base), copy(props));
      labels.set(inst, r);
      out.push(inst);
    });
    return out;
  };

  const [root] = expand(spec, "tree", [], true);
  if (tooMany) say("tree: more than " + maxNodes + " nodes once its fragments and rows are expanded — send a large screen as several trees");
  for (const name of Object.keys(fragments)) if (!used.has(name)) warnings.push("tree.fragments[" + JSON.stringify(name) + "]: no node uses it, so it is not built");
  return { tree: root === undefined ? {} : root, problems, warnings, labels };
}
