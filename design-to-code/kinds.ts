// kinds.ts — the single authoritative Figma-property-type -> transform-kind vocabulary.
//
// This mapping is the contract shared by map-bootstrap (which WRITES a prop's `kind`) and drift-lint
// (which VALIDATES it against the live component). Defining it once here keeps those two tools from
// drifting — a new Figma property type or a renamed kind is edited in exactly one place, so bootstrap
// can never scaffold a kind that drift-lint then rejects.
import type { ComponentPropType, MapPropKind } from "./types.ts";

// SLOT (a component's slot property — Figma's ComponentPropertyType includes it and the plugin emits it)
// maps to "instance": what fills a slot is other layers/instances, and an instance PropMap is exactly
// {kind:"instance", slot} (map-bootstrap stubs it that way).
const TYPE_TO_KIND: Record<ComponentPropType, MapPropKind> = { VARIANT: "enum", BOOLEAN: "boolean", TEXT: "string", INSTANCE_SWAP: "instance", SLOT: "instance" };

export { TYPE_TO_KIND };
