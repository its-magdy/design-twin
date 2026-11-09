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

export { codeUsageOf };
