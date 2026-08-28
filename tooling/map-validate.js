// map-validate.js — structural validation of a codeconnect.local.json map.
//
// No runtime dependency (matches this repo's zero-dep style). This file IS the source of truth for the
// map shape: the KEYS/PROP tables below encode additionalProperties:false, the per-kind prop field
// sets and the required/type rules, and `tooling/README.md` documents that shape in prose for humans.
//
// There used to be a parallel map-schema.json that hand-mirrored these tables and that nothing read —
// two representations kept in sync by hand, which is the exact drift this directory builds tools to
// catch. It was deleted rather than wired up: the map's only consumers are this validator, drift-lint
// and an agent reading JSON, none of which want a JSON Schema document. If a published schema is ever
// needed, GENERATE it from these tables so there is still one source.
//
// Returns { ok, errors:[{path,message}] }; never throws on bad data.

const STATUSES = ["active", "deprecated", "needs-review"];
// Allowed key sets per object (mirrors additionalProperties:false in the schema).
// `prop` is keyed by UNTRUSTED input (a map's `kind` value), so it MUST be null-prototype: a plain
// object literal would resolve kind:"constructor"/"toString"/"valueOf"/"__proto__" to an inherited
// Object.prototype member, which is truthy and then blows up on `.includes` — turning a validation
// error into an uncaught TypeError and breaking this file's "never throws on bad data" contract.
const KEYS = {
  root: ["version", "figmaFileKey", "components"],
  entry: ["figma", "code", "props", "variantOverrides", "childrenByLayer", "status"],
  figma: ["key", "id", "name", "unstable"],
  code: ["module", "export", "targets"],
  target: ["module", "export"],
  vo: ["when", "code"],
  voCode: ["module", "export"],
  children: ["layerNamePattern", "slot"],
  prop: Object.assign(Object.create(null), {
    enum: ["kind", "codeProp", "values", "default", "omitDefault"],
    boolean: ["kind", "codeProp", "default", "omitDefault"],
    string: ["kind", "codeProp"],
    instance: ["kind", "codeProp", "slot"],
  }),
};
const PROP_KINDS = Object.keys(KEYS.prop);

// Pure predicates — module scope, not rebuilt per validateMap call and not threaded into validateProp
// as a helper bag just to cross a function boundary.
const isStr = (v) => typeof v === "string";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isBool = (v) => typeof v === "boolean";
// additionalProperties:false — flag any key not in the allowed list.
// `allowed` is always one of the KEYS lists; the Array.isArray guard is belt-and-braces so a
// non-list can never turn a validation error into a thrown TypeError (see KEYS.prop above).
const noExtra = (obj, allowed, at, err) => { if (!Array.isArray(allowed)) return; for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${at}.${k}`, "unknown property (additionalProperties:false)"); };
// "present but not a string" — the schema's most repeated rule, spelled once next to noExtra.
const optStrings = (obj, keys, at, err) => { for (const k of keys) if (obj[k] !== undefined && !isStr(obj[k])) err(`${at}.${k}`, "must be a string"); };

function validateMap(map) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!isObj(map)) return { ok: false, errors: [{ path: "", message: "map must be an object" }] };
  noExtra(map, KEYS.root, "", err);
  if (map.version !== 1) err("version", "must be 1");
  if (map.figmaFileKey !== undefined && !isStr(map.figmaFileKey)) err("figmaFileKey", "must be a string");
  if (!isObj(map.components)) { err("components", "must be an object"); return { ok: false, errors }; }

  for (const key of Object.keys(map.components)) {
    const e = map.components[key];
    const at = `components.${key}`;
    if (!isObj(e)) { err(at, "entry must be an object"); continue; }
    noExtra(e, KEYS.entry, at, err);

    if (!isObj(e.figma)) err(`${at}.figma`, "required object");
    else {
      noExtra(e.figma, KEYS.figma, `${at}.figma`, err);
      if (!isStr(e.figma.name)) err(`${at}.figma.name`, "required string");
      optStrings(e.figma, ["key", "id"], `${at}.figma`, err);
      if (e.figma.unstable !== undefined && !isBool(e.figma.unstable)) err(`${at}.figma.unstable`, "must be a boolean");
    }

    if (!isObj(e.code)) err(`${at}.code`, "required object");
    else {
      noExtra(e.code, KEYS.code, `${at}.code`, err);
      if (!isStr(e.code.module)) err(`${at}.code.module`, "required string");
      if (!isStr(e.code.export)) err(`${at}.code.export`, "required string");
      if (e.code.targets !== undefined) {
        if (!isObj(e.code.targets)) err(`${at}.code.targets`, "must be an object");
        else for (const t of Object.keys(e.code.targets)) {
          const tv = e.code.targets[t], ta = `${at}.code.targets.${t}`;
          if (!isObj(tv)) err(ta, "must be an object");
          else { noExtra(tv, KEYS.target, ta, err); optStrings(tv, ["module", "export"], ta, err); }
        }
      }
    }

    if (e.status !== undefined && !STATUSES.includes(e.status)) err(`${at}.status`, `must be one of ${STATUSES.join("|")}`);

    if (e.props !== undefined) {
      if (!isObj(e.props)) err(`${at}.props`, "must be an object");
      else for (const pn of Object.keys(e.props)) validateProp(e.props[pn], `${at}.props.${pn}`, err);
    }

    if (e.variantOverrides !== undefined) {
      if (!Array.isArray(e.variantOverrides)) err(`${at}.variantOverrides`, "must be an array");
      else e.variantOverrides.forEach((vo, i) => {
        const va = `${at}.variantOverrides[${i}]`;
        if (!isObj(vo)) { err(va, "must be an object"); return; }
        noExtra(vo, KEYS.vo, va, err);
        if (!isObj(vo.when)) err(`${va}.when`, "required object");
        else for (const wk of Object.keys(vo.when)) if (!isStr(vo.when[wk])) err(`${va}.when.${wk}`, "value must be a string");
        if (!isObj(vo.code)) err(`${va}.code`, "required object");
        else { noExtra(vo.code, KEYS.voCode, `${va}.code`, err); if (!isStr(vo.code.module)) err(`${va}.code.module`, "required string"); if (!isStr(vo.code.export)) err(`${va}.code.export`, "required string"); }
      });
    }

    if (e.childrenByLayer !== undefined) {
      if (!isObj(e.childrenByLayer)) err(`${at}.childrenByLayer`, "must be an object");
      else { noExtra(e.childrenByLayer, KEYS.children, `${at}.childrenByLayer`, err); optStrings(e.childrenByLayer, ["layerNamePattern", "slot"], `${at}.childrenByLayer`, err); }
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateProp(p, at, err) {
  if (!isObj(p)) { err(at, "prop must be an object"); return; }
  const allowed = typeof p.kind === "string" ? KEYS.prop[p.kind] : undefined;
  if (!Array.isArray(allowed)) { err(`${at}.kind`, `must be one of ${PROP_KINDS.join("|")}`); return; }
  noExtra(p, allowed, at, err); // enforce the per-kind oneOf field set
  if (p.kind !== "instance" && !isStr(p.codeProp)) err(`${at}.codeProp`, "required string");
  if (p.kind === "instance" && p.codeProp !== undefined && !isStr(p.codeProp)) err(`${at}.codeProp`, "must be a string");
  if (p.kind === "instance" && p.slot !== undefined && !isStr(p.slot)) err(`${at}.slot`, "must be a string");
  if (p.kind === "enum") {
    if (p.values !== undefined && !isObj(p.values)) err(`${at}.values`, "must be an object (VARIANT option -> code value)");
    else if (isObj(p.values)) for (const k of Object.keys(p.values)) { const t = typeof p.values[k]; if (p.values[k] !== null && !["string", "number", "boolean"].includes(t)) err(`${at}.values.${k}`, "value must be string|number|boolean|null"); }
    if (p.default !== undefined && !["string", "number", "boolean"].includes(typeof p.default)) err(`${at}.default`, "must be string|number|boolean");
  }
  if (p.kind === "boolean" && p.default !== undefined && !isBool(p.default)) err(`${at}.default`, "must be a boolean");
  if ((p.kind === "enum" || p.kind === "boolean") && p.omitDefault !== undefined && !isBool(p.omitDefault)) err(`${at}.omitDefault`, "must be a boolean");
}

module.exports = { validateMap };

// CLI: node tooling/map-validate.js <codeconnect.local.json>
if (require.main === module) {
  const fs = require("fs");
  const file = process.argv[2];
  if (!file) { console.error("usage: node tooling/map-validate.js <map.json>"); process.exit(1); }
  const res = validateMap(JSON.parse(fs.readFileSync(file, "utf8")));
  if (res.ok) { console.log("map valid"); process.exit(0); }
  res.errors.forEach((e) => console.error(`  ${e.path || "(root)"}: ${e.message}`));
  console.error(`\n${res.errors.length} error(s)`);
  process.exit(1);
}
