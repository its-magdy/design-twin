// kinds.js — the single authoritative Figma-property-type -> transform-kind vocabulary.
//
// This mapping is the contract shared by map-bootstrap (which WRITES a prop's `kind`) and drift-lint
// (which VALIDATES it against the live component). Defining it once here keeps those two tools from
// drifting — a new Figma property type or a renamed kind is edited in exactly one place, so bootstrap
// can never scaffold a kind that drift-lint then rejects.
const TYPE_TO_KIND = { VARIANT: "enum", BOOLEAN: "boolean", TEXT: "string", INSTANCE_SWAP: "instance" };

module.exports = { TYPE_TO_KIND };
