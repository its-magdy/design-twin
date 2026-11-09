// map-props.ts — prop names as the component map, the catalog and an instance spell them. A catalog or a map may
// carry Figma's "#id" suffix ("Label#2:0") while an export has it stripped, so props are compared by base name. Two
// distinct keys with one base name cannot be told apart: each reader is told and must not pick one.
import { nullProto } from "../bridge/src/json-util.ts";

const propBase = (k: string): string => String(k).split("#")[0] ?? ""; // "Size#12:3" -> "Size"; ?? "": split() always returns at least one piece

export interface BaseProp<T> { orig: string; value: T }
/** Two distinct keys that collapse to one base name; the later one holds `props[base]`. */
export interface PropCollision { base: string; first: string; second: string }
export interface PropsByBase<T> { props: Record<string, BaseProp<T>>; collisions: PropCollision[]; ambiguous: Set<string> }

// null-prototype: a prop whose base name is literally "__proto__"/"constructor" is indexed like any other.
function propsByBase<T>(raw: Record<string, T> | null | undefined): PropsByBase<T> {
  const props: Record<string, BaseProp<T>> = nullProto(), collisions: PropCollision[] = [];
  for (const [orig, value] of Object.entries(raw || {})) {
    const base = propBase(orig), prev = props[base];
    if (prev !== undefined && prev.orig !== orig) collisions.push({ base, first: prev.orig, second: orig });
    props[base] = { orig, value };
  }
  return { props, collisions, ambiguous: new Set(collisions.map((c) => c.base)) };
}

export { propBase, propsByBase };
