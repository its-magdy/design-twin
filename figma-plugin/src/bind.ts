// Binding a createTree spec's raw values to the file (writes: createTree with `bind: true`; docs/write-plane-spec.md,
// "From an existing app to Figma" step 3). The matching itself is pure and lives in bridge/src/bind-values.ts; this module
// gathers what it matches against — the file's local colour and number variables, each by its collection's default mode
// (an alias followed through the file, a library variable it reaches included), their scopes, the file's local text
// styles, and what the create tables earlier in the batch make or change (creates.ts: their rows' default-mode values,
// a new name only when nothing else is called that) — and runs it on each `bind: true` spec, BEFORE the batch's names
// resolve (tree.ts resolveTreeOps) and before a keyed re-send compares the spec with its last one (keyed.ts), so a
// re-send binds the same way and only a real change shows. A variable or style is named by its name whenever that name
// is its alone (in the file and the batch's tables; tree-refs.ts finds one the batch makes in the batch's plan), else
// by its id: so one the batch makes is named the same on the send that makes it and on every re-send after, when the
// file has it (a keyed re-send of a seed-and-capture batch is unchanged).
//
// It reads only, and it adds no Figma call to the build (binding uses the fields a spec could carry anyway), so the batch
// stays one Undo step and all-or-nothing, as every createTree is.
import type { WriteImpactStep, WriteOp } from "../../bridge/src/commands.ts";
import { bindCounts, bindSpec, canonicalHex, textStyleEntry, type BindOutcome, type BindTable, type BindTextStyle, type BindVariable } from "../../bridge/src/bind-values.ts";
import { formatHex } from "../../bridge/src/hex-color.ts";
import { checkTree } from "../../bridge/src/tree-check.ts";
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import type { CreateResolution, CreateTarget } from "./creates";

/** A `bind: true` createTree op's spec as it is built (bound), and what the binding did. */
export interface BoundSpec { spec: TreeNodeSpec; outcome: BindOutcome }

/** The ops of a batch that ask for binding (a valid spec only: an invalid one is refused by resolveTreeOps as before). */
const bindsOf = (ops: readonly WriteOp[]): Array<[number, TreeNodeSpec]> => {
  const out: Array<[number, TreeNodeSpec]> = [];
  ops.forEach((op, i) => {
    if (op.op !== "createTree" || op.bind !== true) return;
    const c = checkTree(op.tree);
    if (!c.problems.length && c.expanded) out.push([i, c.expanded]);
  });
  return out;
};

/** Each `bind: true` createTree spec of `ops`, bound against the file and what `creates` (the batch's create tables,
 *  resolved) makes. Reads only. */
export async function bindTreeOps(ops: readonly WriteOp[], creates: CreateResolution | null): Promise<Map<number, BoundSpec>> {
  const out = new Map<number, BoundSpec>();
  const todo = bindsOf(ops);
  if (!todo.length) return out;
  const table = await bindTable(creates);
  for (const [i, spec] of todo) out.set(i, bindSpec(spec, table));
  return out;
}

/** The dry run's half of binding (the `writeImpact` command): for each `bind: true` createTree, what the file would bind,
 *  instance and leave raw. Reads only. */
export async function bindImpact(ops: readonly WriteOp[], creates: CreateResolution | null): Promise<WriteImpactStep[]> {
  const steps: WriteImpactStep[] = [];
  for (const [index, b] of await bindTreeOps(ops, creates)) {
    const { summary } = checkTree(b.spec);
    steps.push({ index, op: "createTree", bind: bindCounts(b.outcome, summary.instances, summary.unbound) });
  }
  return steps;
}

const getF = (o: object, k: string): unknown => Reflect.get(o, k);
/** The id a value aliases, or null. */
function aliasId(x: unknown): string | null {
  if (!x || typeof x !== "object" || getF(x, "type") !== "VARIABLE_ALIAS") return null;
  const id = getF(x, "id");
  return typeof id === "string" ? id : null;
}
/** A Figma colour (0–1 channels) as the read's hex. */
function hexOfRgba(x: unknown): string | null {
  if (!x || typeof x !== "object") return null;
  const r = getF(x, "r"), g = getF(x, "g"), b = getF(x, "b"), a = getF(x, "a");
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return null;
  return formatHex({ r: r * 255, g: g * 255, b: b * 255, a: typeof a === "number" ? a : 1 });
}

/** What the table holds for one variable value in its default mode: its own value, or the id it aliases. */
function entryOf(ref: string, name: string, type: VariableResolvedDataType, x: unknown, scopes: readonly string[], candidate: boolean): BindVariable | null {
  const base: BindVariable = candidate ? { ref, name, scopes } : { ref, name, scopes, candidate: false };
  const to = aliasId(x);
  if (to !== null) return { ...base, aliasOf: to };
  if (type === "COLOR") { const hex = hexOfRgba(x); return hex === null ? null : { ...base, value: hex }; }
  return typeof x === "number" ? { ...base, value: x } : null;
}

/** The table the binder matches against: the file's, with the batch's create tables laid over it. */
async function bindTable(creates: CreateResolution | null): Promise<BindTable> {
  const colors = new Map<string, BindVariable>();
  const numbers = new Map<string, BindVariable>();
  const listFor = (t: VariableResolvedDataType): Map<string, BindVariable> | null => (t === "COLOR" ? colors : t === "FLOAT" ? numbers : null);
  const defaults = new Map<string, string>();
  const defaultModeOf = async (collectionId: string): Promise<string | null> => {
    const known = defaults.get(collectionId);
    if (known !== undefined) return known;
    let c: VariableCollection | null = null;
    try { c = await figma.variables.getVariableCollectionByIdAsync(collectionId); } catch { c = null; }
    if (!c) return null;
    defaults.set(collectionId, c.defaultModeId);
    return c.defaultModeId;
  };
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) defaults.set(c.id, c.defaultModeId);
  const locals = await figma.variables.getLocalVariablesAsync();
  const pending: string[] = [];
  const add = async (v: Variable, candidate: boolean): Promise<void> => {
    const list = listFor(v.resolvedType);
    if (!list || list.has(v.id)) return;
    const mode = await defaultModeOf(v.variableCollectionId);
    if (mode === null) return;
    const e = entryOf(v.id, v.name, v.resolvedType, v.valuesByMode[mode], v.scopes, candidate);
    if (!e) return;
    list.set(v.id, e);
    if (e.aliasOf !== undefined) pending.push(e.aliasOf);
  };
  for (const v of locals) await add(v, !v.remote && !readsAsRef(v.name, "VariableID:"));

  // ---- the batch's create tables: a row's value in its collection's default mode replaces what the file holds
  const localNames = new Map<string, number>();
  for (const v of locals) localNames.set(v.name, (localNames.get(v.name) || 0) + 1);
  const targets: CreateTarget[] = creates ? [...creates.targets.values()] : [];
  const plannedNames = new Map<string, number>();
  for (const t of targets) if (t.kind === "variables") for (const r of t.rows) if (!r.existing) plannedNames.set(r.name, (plannedNames.get(r.name) || 0) + 1);
  for (const t of targets) {
    if (t.kind !== "variables") continue;
    const coll = t.collection;
    const j = coll ? t.modes.findIndex((m) => m.modeId === coll.defaultModeId) : 0;
    for (const r of t.rows) {
      const list = listFor(r.type);
      if (!list) continue;
      // a new variable in a collection whose default mode the table leaves out takes its first value there
      const cell = j >= 0 ? r.values[j] : r.existing ? undefined : r.values[0];
      const at = j >= 0 ? j : 0;
      if (cell === undefined) continue;
      // A new name that reads as an id or a key is left out altogether (as its ref it could even stand for another
      // variable's id in this table).
      if (!r.existing && readsAsRef(r.name, "VariableID:")) continue;
      const ref = r.existing ? r.existing.id : r.name;
      // A new name the file or another table also has would match several things once the batch runs: never bound to.
      const unique = (r.existing !== null || (!localNames.get(r.name) && plannedNames.get(r.name) === 1)) && !readsAsRef(r.name, "VariableID:");
      const scopes = r.existing ? r.existing.scopes : ["ALL_SCOPES"];
      const base: BindVariable = unique ? { ref, name: r.name, scopes } : { ref, name: r.name, scopes, candidate: false };
      let e: BindVariable | null = null;
      if (typeof cell === "object") {
        const target = r.targets[at];
        // (an alias of a new row whose name reads as a ref: no value here, never bound)
        if (target && "row" in target) e = target.row.existing ? { ...base, aliasOf: target.row.existing.id } : readsAsRef(target.row.name, "VariableID:") ? null : { ...base, aliasOf: target.row.name };
        else if (target && creates) {
          const v = creates.refs.variables.get(target.ref);
          if (v) { e = { ...base, aliasOf: v.id }; pending.push(v.id); }
        }
      } else if (r.type === "COLOR") {
        const hex = canonicalHex(cell);
        if (hex !== null) e = { ...base, value: hex };
      } else if (typeof cell === "number") e = { ...base, value: cell };
      if (e) list.set(ref, e);
      else list.delete(ref);
    }
  }
  // A local variable whose name is its alone is named by it (the form a new one has: the same before and after it is made).
  const named = new Map<string, string>();
  for (const v of locals) if (!v.remote && byName(v.name, "VariableID:", localNames.get(v.name), plannedNames.get(v.name))) named.set(v.id, v.name);
  // ---- the variables an alias reaches outside the local ones (a library's): followed, never bound to themselves
  for (let hops = 0; pending.length && hops < 200; hops++) {
    const id = pending.shift();
    if (id === undefined || colors.has(id) || numbers.has(id)) continue;
    let v: Variable | null = null;
    try { v = await figma.variables.getVariableByIdAsync(id); } catch { v = null; }
    if (v) await add(v, false);
  }

  // ---- text styles: the file's, then what a createStyles table makes or changes
  const styles = new Map<string, BindTextStyle>();
  // A captured text has no paragraph settings (the tree spec writes none): a style with an indent, paragraph or list
  // spacing, or a leading trim would add them, so it is never matched.
  const plainParagraph = (st: TextStyle): boolean =>
    !st.paragraphIndent && !st.paragraphSpacing && !st.listSpacing && (st.leadingTrim === undefined || st.leadingTrim === "NONE");
  const fileStyles = await figma.getLocalTextStylesAsync();
  const styleNames = new Map<string, number>();
  for (const st of fileStyles) {
    styleNames.set(st.name, (styleNames.get(st.name) || 0) + 1);
    // every field a style has in Figma; one that cannot be read leaves the style out (it is never matched half-known)
    if (!st.fontName || typeof st.fontSize !== "number" || !st.lineHeight || !st.letterSpacing || typeof st.textCase !== "string" || typeof st.textDecoration !== "string") continue;
    if (readsAsRef(st.name, "S:") || !plainParagraph(st)) continue;
    styles.set(st.id, textStyleEntry(st.id, st.name, {
      family: st.fontName.family, style: st.fontName.style, size: st.fontSize,
      lineHeight: st.lineHeight, letterSpacing: st.letterSpacing, textCase: st.textCase, textDecoration: st.textDecoration,
    }));
  }
  const plannedStyles = new Map<string, number>();
  for (const t of targets) if (t.kind === "styles") for (const s of t.rows) if (s.row.kind === "text" && !s.existing) plannedStyles.set(s.row.name, (plannedStyles.get(s.row.name) || 0) + 1);
  for (const t of targets) {
    if (t.kind !== "styles") continue;
    for (const s of t.rows) {
      if (s.row.kind !== "text") continue;
      const set = s.row.set;
      // a name that reads as an id or a key: never bound to (a new one left out, an existing one taken out by its id)
      if (readsAsRef(s.row.name, "S:")) { if (s.existing) styles.delete(s.existing.id); continue; }
      const ref = s.existing ? s.existing.id : s.row.name;
      // A field bound to a variable shows the variable's value, which the table may be changing: such a style is left out.
      const tokens = set.tokens || {};
      const boundAny = Object.keys(tokens).some((k) => Reflect.get(tokens, k) !== undefined && Reflect.get(tokens, k) !== null);
      const unique = s.existing !== null || (!styleNames.get(s.row.name) && plannedStyles.get(s.row.name) === 1);
      if (boundAny || !unique) { styles.delete(ref); continue; }
      const was = s.existing && s.existing.type === "TEXT" ? s.existing : null;
      // its paragraph settings once the row has run: the row's paragraph spacing and indent, else the style's own (list
      // spacing and leading trim a table cannot set)
      const paraSpacing = set.paragraphSpacing !== undefined ? set.paragraphSpacing : was ? was.paragraphSpacing : 0;
      const paraIndent = set.paragraphIndent !== undefined ? set.paragraphIndent : was ? was.paragraphIndent : 0;
      const restPlain = !was || (!was.listSpacing && (was.leadingTrim === undefined || was.leadingTrim === "NONE"));
      if (paraSpacing || paraIndent || !restPlain) { styles.delete(ref); continue; }
      const lh = set.lineHeight;
      const ls = set.letterSpacing;
      styles.set(ref, textStyleEntry(ref, s.row.name, {
        family: set.font !== undefined ? set.font : was ? was.fontName.family : "Inter",
        style: set.weight !== undefined ? set.weight : was ? was.fontName.style : "Regular",
        size: set.size !== undefined ? set.size : was ? was.fontSize : 12,
        lineHeight: lh ? (lh.unit === "auto" || lh.value === undefined ? { unit: "AUTO" } : { unit: lh.unit === "px" ? "PIXELS" : "PERCENT", value: lh.value }) : was ? was.lineHeight : { unit: "AUTO" },
        letterSpacing: ls ? { unit: ls.unit === "px" ? "PIXELS" : "PERCENT", value: ls.value } : was ? was.letterSpacing : { unit: "PERCENT", value: 0 },
        textCase: set.case !== undefined ? set.case : was ? was.textCase : "ORIGINAL",
        textDecoration: set.decoration !== undefined ? set.decoration : was ? was.textDecoration : "NONE",
      }));
    }
  }
  for (const st of fileStyles) if (byName(st.name, "S:", styleNames.get(st.name), plannedStyles.get(st.name))) named.set(st.id, st.name);
  const out = (ref: string): string => { const n = named.get(ref); return n === undefined ? ref : n; };
  const renamed = (e: BindVariable): BindVariable => (e.aliasOf === undefined ? { ...e, ref: out(e.ref) } : { ...e, ref: out(e.ref), aliasOf: out(e.aliasOf) });
  return {
    colors: [...colors.values()].map(renamed),
    numbers: [...numbers.values()].map(renamed),
    textStyles: [...styles.values()].map((s) => ({ ...s, ref: out(s.ref) })),
  };
}

/** A local variable or style is named by its name when the name resolves to it alone (tree-refs.ts): no other local one
 *  has it (`inFile` 1), no create table of the batch makes one (`planned`), and it reads as neither an id (`idPrefix`)
 *  nor a 40-hex key. */
function byName(name: string, idPrefix: string, inFile: number | undefined, planned: number | undefined): boolean {
  return inFile === 1 && !planned && !readsAsRef(name, idPrefix);
}
/** A name the resolver would read as an id (`idPrefix`) or a 40-hex key, not as a name: a variable or style called that
 *  is never bound to (named, it could resolve to another one, or to a library's), new or not, so a re-send stays raw too. */
function readsAsRef(name: string, idPrefix: string): boolean {
  return name.indexOf(idPrefix) === 0 || /^[0-9a-f]{40}$/i.test(name);
}
