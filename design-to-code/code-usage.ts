// code-usage.ts — one Figma instance's props, translated through its component-map entry into how the code component
// is used: which module and export, which code props with which values, which slots. Platform-neutral on purpose (the
// map serves six stacks), and nothing is guessed: what the entry cannot translate is left out and named in a warning,
// so a builder never reads a value the map did not give. drift-lint checks the map against the catalog (shape); this
// reads the map for one instance (use), with the same warning codes where the two say the same thing.
import type { CodeUsage, CodeUsageValue, CodeUsageWarning, ComponentPropValues, MapEntry, PropMap } from "./types.ts";
import { propsByBase, type PropsByBase } from "./map-props.ts";
import { ifDefined, nullProto } from "../bridge/src/json-util.ts";

/** Stubs from map-bootstrap carry "TODO: import path": no code target yet. */
const isPlaceholderModule = (module: string | null | undefined): boolean => !module || /^TODO/.test(module);

export interface InstanceProps { variant?: Record<string, string> | null; props?: ComponentPropValues | null }
export interface CodeUsageResult { usage: CodeUsage | null; warnings: CodeUsageWarning[] }

// The module and export this instance renders: a variantOverride whose whole `when` holds, else the entry's own.
// Overrides that hold and name different targets are a tie this module does not break.
function resolveTarget(entry: MapEntry, instance: PropsByBase<CodeUsageValue>, warn: (w: CodeUsageWarning) => void): Pick<CodeUsage, "module" | "export" | "targets"> | null {
  const values = instance.props;
  const holds = (entry.variantOverrides || []).filter((o) => {
    const when = Object.entries(propsByBase(o.when).props);
    return when.length > 0 && when.every(([base, w]) => !instance.ambiguous.has(base) && values[base] !== undefined && String(values[base].value) === w.value);
  });
  const distinct = new Map(holds.map((o) => [`${o.code.module}\0${o.code.export}`, o.code]));
  if (distinct.size > 1) {
    warn({ code: "ambiguous-variant-override", message: `${distinct.size} variantOverrides hold for this instance with different code targets (${[...distinct.values()].map((c) => `${c.module}#${c.export}`).join(", ")}): choose one in the map` });
    return null;
  }
  const [override] = distinct.values();
  const target = override ?? entry.code;
  if (isPlaceholderModule(target.module)) {
    warn({ code: "no-code-target", message: `'${entry.figma.name}' has no import path yet (module '${target.module}'): fill it in the map` });
    return null;
  }
  return { module: target.module, export: target.export, ...ifDefined("targets", override ? undefined : entry.code.targets) };
}

function codeUsageOf(entry: MapEntry, instance: InstanceProps): CodeUsageResult {
  const warnings: CodeUsageWarning[] = [];
  const warn = (w: CodeUsageWarning): void => { warnings.push(w); };
  const name = entry.figma.name;
  const mapIdx = propsByBase<PropMap>(entry.props);
  // Figma lists variant axes in `props` too; `variant` covers an instance whose props were not exported.
  const instIdx = propsByBase<CodeUsageValue>({ ...(instance.variant || {}), ...(instance.props || {}) });
  for (const c of [...mapIdx.collisions, ...instIdx.collisions]) warn({ code: "ambiguous-prop", prop: c.base, message: `'${name}' has two props with base name '${c.base}' ('${c.first}', '${c.second}'): not translated` });

  const target = resolveTarget(entry, instIdx, warn);
  type Assigned = Map<string, Array<{ figma: string; value: CodeUsageValue }>>;
  const assigned: Assigned = new Map(), assignedSlots: Assigned = new Map();
  const assign = (to: Assigned, key: string, figma: string, value: CodeUsageValue): void => { to.set(key, [...(to.get(key) ?? []), { figma, value }]); };
  const mismatch = (p: string, kind: string, value: CodeUsageValue): void =>
    warn({ code: "prop-value-mismatch", prop: p, message: `'${name}'.${p} is mapped as ${kind} but this instance's value is ${JSON.stringify(value)}: not translated` });

  for (const [base, inst] of Object.entries(instIdx.props)) {
    if (mapIdx.ambiguous.has(base) || instIdx.ambiguous.has(base)) continue; // warned above
    const mapped = mapIdx.props[base];
    if (!mapped) { warn({ code: "uncovered-prop", prop: base, message: `'${name}': Figma prop '${base}' is not mapped: its value ${JSON.stringify(inst.value)} is not translated` }); continue; }
    const p = mapped.value, value = inst.value;
    let out: CodeUsageValue;
    if (p.kind === "enum") {
      if (typeof value !== "string") { mismatch(base, "an enum", value); continue; }
      const table = p.values || {};
      if (!Object.hasOwn(table, value)) { warn({ code: "unmapped-variant-value", prop: base, message: `'${name}'.${base}: option '${value}' has no code mapping: add it to the map's values` }); continue; }
      const code = table[value];
      if (code === null || code === undefined || (p.omitDefault && p.default === value)) continue; // null: the map says no code prop for this option
      out = code;
    } else if (p.kind === "boolean") {
      if (typeof value !== "boolean") { mismatch(base, "a boolean", value); continue; }
      if (p.omitDefault && p.default === value) continue;
      out = value;
    } else if (p.kind === "string") {
      if (typeof value !== "string") { mismatch(base, "a string", value); continue; }
      out = value;
    } else {
      if (typeof value !== "string") { mismatch(base, "an instance swap", value); continue; }
      const slot = p.slot ?? p.codeProp;
      if (slot) assign(assignedSlots, slot, base, value);
      else warn({ code: "no-slot-name", prop: base, message: `'${name}'.${base} is an instance prop with neither slot nor codeProp: not translated` });
      continue;
    }
    assign(assigned, p.codeProp, base, out);
  }

  // One code prop or slot fed by several Figma props: kept only when they agree.
  const settle = <V extends CodeUsageValue>(from: Assigned, what: string): Record<string, V> => {
    const out: Record<string, V> = nullProto();
    for (const [key, list] of from) {
      const first = list[0];
      if (first && list.every((x) => x.value === first.value)) { out[key] = first.value as V; continue; }
      warn({ code: "conflicting-code-prop", prop: key, message: `'${name}': ${list.map((x) => `${x.figma}=${JSON.stringify(x.value)}`).join(", ")} all map to ${what} '${key}' with different values: not translated` });
    }
    return out;
  };
  const props = settle<CodeUsageValue>(assigned, "code prop"), slots = settle<string>(assignedSlots, "slot");
  return { usage: target ? { ...target, status: entry.status ?? null, props, slots } : null, warnings };
}

// ---------------------------------------------------------------- the write direction
// A rendered code component (a captured page's element: capture-page.ts) as the Figma instance its map entry names: the
// component, and its properties' values read back through the same entry — enum `values` inverted, a boolean as it is, a
// string as it is (a `children` string the element's rendered text when the code passed none), a variantOverride whose
// code target is the element's own component giving its `when` values. Nothing is guessed: a value the entry cannot read
// back is left out (the component's default shows) and named in a warning, with the read direction's codes where the two
// say the same thing.

/** A code value as the element rendered it: its props are strings, numbers and booleans only. */
export type CodePropValues = Record<string, CodeUsageValue>;
export interface FigmaUsage {
  /** the component, as a tree spec names it: its 40-hex key, else its id, else its name (tree-refs.ts takes all three) */
  component: string;
  /** Figma property (bare name) → value: a variant's option, a text, a boolean */
  props: Record<string, string | boolean>;
  warnings: CodeUsageWarning[];
}

const KEY_40_HEX = /^[0-9a-f]{40}$/i;
/** The reference a tree spec gives `entry`'s component. */
export function componentRef(entry: MapEntry): string {
  const f = entry.figma;
  if (f.key && KEY_40_HEX.test(f.key)) return f.key;
  return f.id || f.name;
}

/**
 * The Figma instance a code component of `entry` renders as, from its props as rendered (`codeProps`) and its rendered
 * text (`text`, for a `children` string prop the code did not pass). `codeName` is the element's component ("Export" or
 * "module#Export"): a variantOverride whose code target it names gives its `when` variant values.
 */
function figmaUsageOf(entry: MapEntry, codeProps: CodePropValues, text?: string, codeName?: string): FigmaUsage {
  const warnings: CodeUsageWarning[] = [];
  const warn = (w: CodeUsageWarning): void => { warnings.push(w); };
  const name = entry.figma.name;
  const props: Record<string, string | boolean> = nullProto();
  const mapIdx = propsByBase<PropMap>(entry.props);
  for (const c of mapIdx.collisions) warn({ code: "ambiguous-prop", prop: c.base, message: `'${name}' has two props with base name '${c.base}' ('${c.first}', '${c.second}'): not written` });
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(codeProps, k);
  for (const [base, { value: p }] of Object.entries(mapIdx.props)) {
    if (mapIdx.ambiguous.has(base)) continue; // warned above
    if (p.kind === "instance") { warn({ code: "slot-not-written", prop: base, message: `'${name}'.${base} is an instance prop (a slot): a capture does not write what fills it yet` }); continue; }
    const given = has(p.codeProp) ? codeProps[p.codeProp] : undefined;
    if (p.kind === "enum") {
      const table = p.values || {};
      const options = Object.keys(table);
      if (given === undefined) {
        // Absent: the options the read direction writes no code prop for — the ones mapped to null, and the default when
        // the map omits it. One: that option; several: warned, left to the component's default; none: left out.
        const silent = options.filter((o) => table[o] === null || (p.omitDefault === true && p.default !== undefined && String(p.default) === o));
        const one = silent[0];
        if (silent.length === 1 && one !== undefined) props[base] = one;
        else if (silent.length > 1) warn({ code: "ambiguous-variant-value", prop: base, message: `'${name}'.${base}: no code prop ${p.codeProp} is what ${silent.length} options stand for (${silent.slice(0, 3).join(", ")}): not written, the component's default shows` });
        continue;
      }
      const hits = options.filter((o) => table[o] === given);
      if (hits.length === 1 && hits[0] !== undefined) { props[base] = hits[0]; continue; }
      if (hits.length > 1) { warn({ code: "ambiguous-variant-value", prop: base, message: `'${name}'.${base}: the code value ${JSON.stringify(given)} is what ${hits.length} options map to (${hits.slice(0, 3).join(", ")}): not written, the component's default shows` }); continue; }
      warn({ code: "unmapped-variant-value", prop: base, message: `'${name}'.${base}: the code value ${JSON.stringify(given)} is in none of the map's values: not written, the component's default shows` });
      continue;
    }
    if (p.kind === "boolean") {
      // absent: the default, when the map omits it (the read direction writes no code prop for it); else left out
      if (given === undefined) { if (p.omitDefault === true && p.default !== undefined) props[base] = p.default; continue; }
      if (typeof given !== "boolean") { warn({ code: "prop-value-mismatch", prop: base, message: `'${name}'.${base} is mapped as a boolean but the code's ${p.codeProp} is ${JSON.stringify(given)}: not written` }); continue; }
      props[base] = given;
      continue;
    }
    // a string: the code's, else a `children` prop's rendered text
    if (given === undefined) { if (p.codeProp === "children" && text !== undefined && text !== "") props[base] = text; continue; }
    if (typeof given === "boolean") { warn({ code: "prop-value-mismatch", prop: base, message: `'${name}'.${base} is mapped as a string but the code's ${p.codeProp} is ${JSON.stringify(given)}: not written` }); continue; }
    props[base] = String(given);
  }
  // A variantOverride whose code target is this component: its `when` variant values say which variant it is.
  if (codeName !== undefined) {
    const bare = codeName.indexOf("#") >= 0 ? codeName.slice(codeName.lastIndexOf("#") + 1) : codeName;
    const mod = codeName.indexOf("#") >= 0 ? codeName.slice(0, codeName.lastIndexOf("#")) : null;
    const hits = (entry.variantOverrides || []).filter((o) => o.code.export === bare && (mod === null || o.code.module === mod));
    const first = hits[0];
    if (hits.length > 1) warn({ code: "ambiguous-variant-override", message: `${hits.length} variantOverrides of '${name}' name the code target ${codeName}: their variant values are not written` });
    else if (first) for (const [k, v] of Object.entries(propsByBase(first.when).props)) props[k] = v.value;
  }
  return { component: componentRef(entry), props, warnings };
}

/** The map's entries by the code component that renders them: by export ("Button") and by module#export. */
export interface CodeIndex {
  /** the entry `name` (an export or module#export) names: one, several (ambiguous: none is chosen), or none */
  get(name: string): { entry: MapEntry } | { ambiguous: MapEntry[] } | null;
  /** every name that names exactly one entry */
  names: string[];
}
/**
 * Index `map` by code target, for the write direction: each entry under its own target's export and module#export, and
 * under each variantOverride's. An entry with no import path yet (a placeholder "TODO" module) or a deprecated one is
 * left out; a name several entries have is ambiguous.
 */
function mapEntriesByCode(map: { components: Record<string, MapEntry> }): CodeIndex {
  const by = new Map<string, MapEntry[]>();
  const put = (k: string, e: MapEntry): void => { const list = by.get(k) ?? []; if (list.indexOf(e) < 0) list.push(e); by.set(k, list); };
  for (const e of Object.values(map.components || {})) {
    if (e.status === "deprecated") continue;
    for (const t of [e.code, ...(e.variantOverrides || []).map((o) => o.code)]) {
      if (isPlaceholderModule(t.module) || !t.export) continue;
      put(t.export, e);
      put(`${t.module}#${t.export}`, e);
    }
  }
  return {
    get(name) {
      const list = by.get(name);
      const one = list && list.length === 1 ? list[0] : undefined;
      if (one) return { entry: one };
      return list && list.length > 1 ? { ambiguous: list } : null;
    },
    names: [...by].filter(([, l]) => l.length === 1).map(([k]) => k).sort(),
  };
}

export { codeUsageOf, figmaUsageOf, mapEntriesByCode };
