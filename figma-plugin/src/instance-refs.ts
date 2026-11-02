// What an INSTANCE (or any sublayer) says about the component it comes from: its main component's join
// keys, the component properties that drive its sublayers, and its overrides. Read per node by the page
// walk (serialize.ts). Kept apart from components.ts (the catalog) so the catalog can call serialize()
// without an import cycle.
import type { IrNode, MainComponentRef, InstanceOverride } from "../../bridge/src/doc-types.ts";
import { OVERRIDE_CAP } from "../../bridge/src/instance-overrides.ts";
import { propName, nonEmpty } from "./util";
import { run } from "./run";

// INSTANCE -> its main component, resolved via getMainComponentAsync (mainComponent itself is
// write-only in the Plugin API's typings). Returns the join keys needed to resolve back to the
// component catalog (buildDesignSystem below), not just the display name a bare INSTANCE swap
// override happens to carry.
export async function instanceComponentRef(node: SceneNode): Promise<MainComponentRef | undefined> {
  if (node.type !== "INSTANCE") return undefined;
  try {
    const main = await node.getMainComponentAsync();
    if (!main) return undefined;
    const ref: MainComponentRef = { name: main.name };
    if (main.id) ref.id = main.id;
    if (main.key) ref.key = main.key;
    if (main.remote) ref.remote = true;
    // A REMOTE main's `.parent` may be null (plugin-api.d.ts) — this is documented shape, not a bug.
    const parent = main.parent;
    if (parent && parent.type === "COMPONENT_SET") {
      ref.setId = parent.id;
      if (parent.key) ref.setKey = parent.key;
      ref.setName = parent.name;
      ref.variant = main.name;
    }
    return ref;
  } catch (e) {
    return undefined;
  }
}

// componentPropertyReferences: which component property drives this sublayer's visibility / text /
// swapped instance — lets codegen wire a nested layer to a prop instead of hardcoding.
const PROP_REF_KEYS: Array<"visible" | "characters" | "mainComponent"> = ["visible", "characters", "mainComponent"];
export function componentPropRefs(node: SceneNode): IrNode["propRefs"] {
  if (!("componentPropertyReferences" in node)) return undefined;
  const refs = node.componentPropertyReferences;
  if (!refs) return undefined;
  const out: NonNullable<IrNode["propRefs"]> = {};
  for (const k of PROP_REF_KEYS) {
    const ref = refs[k];
    if (ref) out[k] = propName(ref);
  }
  return nonEmpty(out);
}

// Instance overrides — the fields directly changed on an instance vs its main component, cut to
// OVERRIDE_CAP (the consumers read a list that long as possibly incomplete).
export function instanceOverrides(node: SceneNode): InstanceOverride[] | undefined {
  if (node.type !== "INSTANCE") return undefined;
  const overrides = node.overrides;
  if (!Array.isArray(overrides) || !overrides.length) return undefined;
  const list = overrides
    .filter((o) => o && Array.isArray(o.overriddenFields) && o.overriddenFields.length)
    .map((o): InstanceOverride => ({ id: o.id, fields: o.overriddenFields }));
  if (!list.length) return undefined;
  if (list.length > OVERRIDE_CAP) {
    run().warn("instance '" + node.name + "' has " + list.length + " overrides — truncated to " + OVERRIDE_CAP);
    return list.slice(0, OVERRIDE_CAP);
  }
  return list;
}
