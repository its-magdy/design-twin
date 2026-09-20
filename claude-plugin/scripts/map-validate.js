// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.

// design-to-code/map-validate.js
var STATUSES = ["active", "deprecated", "needs-review"];
var KEYS = {
  root: ["version", "figmaFileKey", "components"],
  entry: ["figma", "code", "props", "variantOverrides", "childrenByLayer", "status"],
  figma: ["key", "id", "name", "unstable"],
  code: ["module", "export", "targets"],
  target: ["module", "export"],
  vo: ["when", "code"],
  voCode: ["module", "export"],
  children: ["layerNamePattern", "slot"],
  prop: Object.assign(/* @__PURE__ */ Object.create(null), {
    enum: ["kind", "codeProp", "values", "default", "omitDefault"],
    boolean: ["kind", "codeProp", "default", "omitDefault"],
    string: ["kind", "codeProp"],
    instance: ["kind", "codeProp", "slot"]
  })
};
var PROP_KINDS = Object.keys(KEYS.prop);
var isStr = (v) => typeof v === "string";
var isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
var isBool = (v) => typeof v === "boolean";
var noExtra = (obj, allowed, at, err) => {
  if (!Array.isArray(allowed)) return;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${at}.${k}`, "unknown property (additionalProperties:false)");
};
var optStrings = (obj, keys, at, err) => {
  for (const k of keys) if (obj[k] !== void 0 && !isStr(obj[k])) err(`${at}.${k}`, "must be a string");
};
function validateMap(map) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!isObj(map)) return { ok: false, errors: [{ path: "", message: "map must be an object" }] };
  noExtra(map, KEYS.root, "", err);
  if (map.version !== 1) err("version", "must be 1");
  if (map.figmaFileKey !== void 0 && !isStr(map.figmaFileKey)) err("figmaFileKey", "must be a string");
  if (!isObj(map.components)) {
    err("components", "must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(map.components)) {
    const e = map.components[key];
    const at = `components.${key}`;
    if (!isObj(e)) {
      err(at, "entry must be an object");
      continue;
    }
    noExtra(e, KEYS.entry, at, err);
    if (!isObj(e.figma)) err(`${at}.figma`, "required object");
    else {
      noExtra(e.figma, KEYS.figma, `${at}.figma`, err);
      if (!isStr(e.figma.name)) err(`${at}.figma.name`, "required string");
      optStrings(e.figma, ["key", "id"], `${at}.figma`, err);
      if (e.figma.unstable !== void 0 && !isBool(e.figma.unstable)) err(`${at}.figma.unstable`, "must be a boolean");
    }
    if (!isObj(e.code)) err(`${at}.code`, "required object");
    else {
      noExtra(e.code, KEYS.code, `${at}.code`, err);
      if (!isStr(e.code.module)) err(`${at}.code.module`, "required string");
      if (!isStr(e.code.export)) err(`${at}.code.export`, "required string");
      if (e.code.targets !== void 0) {
        if (!isObj(e.code.targets)) err(`${at}.code.targets`, "must be an object");
        else for (const t of Object.keys(e.code.targets)) {
          const tv = e.code.targets[t], ta = `${at}.code.targets.${t}`;
          if (!isObj(tv)) err(ta, "must be an object");
          else {
            noExtra(tv, KEYS.target, ta, err);
            optStrings(tv, ["module", "export"], ta, err);
          }
        }
      }
    }
    if (e.status !== void 0 && !STATUSES.includes(e.status)) err(`${at}.status`, `must be one of ${STATUSES.join("|")}`);
    if (e.props !== void 0) {
      if (!isObj(e.props)) err(`${at}.props`, "must be an object");
      else for (const pn of Object.keys(e.props)) validateProp(e.props[pn], `${at}.props.${pn}`, err);
    }
    if (e.variantOverrides !== void 0) {
      if (!Array.isArray(e.variantOverrides)) err(`${at}.variantOverrides`, "must be an array");
      else e.variantOverrides.forEach((vo, i) => {
        const va = `${at}.variantOverrides[${i}]`;
        if (!isObj(vo)) {
          err(va, "must be an object");
          return;
        }
        noExtra(vo, KEYS.vo, va, err);
        if (!isObj(vo.when)) err(`${va}.when`, "required object");
        else for (const wk of Object.keys(vo.when)) if (!isStr(vo.when[wk])) err(`${va}.when.${wk}`, "value must be a string");
        if (!isObj(vo.code)) err(`${va}.code`, "required object");
        else {
          noExtra(vo.code, KEYS.voCode, `${va}.code`, err);
          if (!isStr(vo.code.module)) err(`${va}.code.module`, "required string");
          if (!isStr(vo.code.export)) err(`${va}.code.export`, "required string");
        }
      });
    }
    if (e.childrenByLayer !== void 0) {
      if (!isObj(e.childrenByLayer)) err(`${at}.childrenByLayer`, "must be an object");
      else {
        noExtra(e.childrenByLayer, KEYS.children, `${at}.childrenByLayer`, err);
        optStrings(e.childrenByLayer, ["layerNamePattern", "slot"], `${at}.childrenByLayer`, err);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
function validateProp(p, at, err) {
  if (!isObj(p)) {
    err(at, "prop must be an object");
    return;
  }
  const allowed = typeof p.kind === "string" ? KEYS.prop[p.kind] : void 0;
  if (!Array.isArray(allowed)) {
    err(`${at}.kind`, `must be one of ${PROP_KINDS.join("|")}`);
    return;
  }
  noExtra(p, allowed, at, err);
  if (p.kind !== "instance" && !isStr(p.codeProp)) err(`${at}.codeProp`, "required string");
  if (p.kind === "instance" && p.codeProp !== void 0 && !isStr(p.codeProp)) err(`${at}.codeProp`, "must be a string");
  if (p.kind === "instance" && p.slot !== void 0 && !isStr(p.slot)) err(`${at}.slot`, "must be a string");
  if (p.kind === "enum") {
    if (p.values !== void 0 && !isObj(p.values)) err(`${at}.values`, "must be an object (VARIANT option -> code value)");
    else if (isObj(p.values)) for (const k of Object.keys(p.values)) {
      const t = typeof p.values[k];
      if (p.values[k] !== null && !["string", "number", "boolean"].includes(t)) err(`${at}.values.${k}`, "value must be string|number|boolean|null");
    }
    if (p.default !== void 0 && !["string", "number", "boolean"].includes(typeof p.default)) err(`${at}.default`, "must be string|number|boolean");
  }
  if (p.kind === "boolean" && p.default !== void 0 && !isBool(p.default)) err(`${at}.default`, "must be a boolean");
  if ((p.kind === "enum" || p.kind === "boolean") && p.omitDefault !== void 0 && !isBool(p.omitDefault)) err(`${at}.omitDefault`, "must be a boolean");
}
module.exports = { validateMap };
if (require.main === module) {
  const fs = require("fs");
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node design-to-code/map-validate.js <map.json>");
    process.exit(1);
  }
  const res = validateMap(JSON.parse(fs.readFileSync(file, "utf8")));
  if (res.ok) {
    console.log("map valid");
    process.exit(0);
  }
  res.errors.forEach((e) => console.error(`  ${e.path || "(root)"}: ${e.message}`));
  console.error(`
${res.errors.length} error(s)`);
  process.exit(1);
}
