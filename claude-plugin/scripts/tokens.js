// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// design-to-code/catalog-input.js
var require_catalog_input = __commonJS({
  "design-to-code/catalog-input.js"(exports2, module2) {
    function isManifest(doc, payloadKey) {
      return !!(doc && doc.files && typeof doc.files === "object" && !Array.isArray(doc.files) && !Array.isArray(doc[payloadKey]));
    }
    function assertNotManifest(doc, givenPath, payloadKey, wantFile) {
      if (isManifest(doc, payloadKey)) {
        console.error(
          `error  '${givenPath}' is the design-system MANIFEST (a pointer map), not the '${payloadKey}' catalog.
       Since the design-system split it carries only a stamp, a \`files\` map and \`counts\`.
       Pass the split file instead \u2014 e.g. ${doc.files[payloadKey === "variables" ? "tokens" : "componentsLocal"] || wantFile} (relative to the export dir that holds ${givenPath}).`
        );
        process.exit(2);
      }
    }
    module2.exports = { assertNotManifest, isManifest };
  }
});

// design-to-code/tokens.js
var round = (x) => Math.round(x * 1e4) / 1e4;
var segsCache = /* @__PURE__ */ new Map();
function segs(name) {
  const key = String(name || "");
  let v = segsCache.get(key);
  if (v === void 0) {
    v = key.split("/").map((s) => s.trim().replace(/[.{}$]/g, "").replace(/\s+/g, "-")).filter(Boolean);
    segsCache.set(key, v);
  }
  return v;
}
var dtcgRef = (tokenName) => "{" + segs(tokenName).join(".") + "}";
var varNameCache = /* @__PURE__ */ new Map();
var cssVarName = (tokenName) => {
  const key = String(tokenName || "");
  let v = varNameCache.get(key);
  if (v === void 0) varNameCache.set(key, v = "--" + segs(key).join("-").replace(/[^A-Za-z0-9-]/g, "-"));
  return v;
};
function normHex(v) {
  if (typeof v !== "string") return null;
  const h = v.replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  const e = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  return e.length === 6 || e.length === 8 ? e.toLowerCase() : null;
}
var isHexish = (v) => typeof v === "string" && /^#/.test(v);
var isAlias = (v) => v && typeof v === "object" && typeof v.aliasOf === "string";
var CSS_UNSAFE = /[\\\n\r\f;{}]/g;
var hexEsc = (c) => "\\" + c.codePointAt(0).toString(16) + " ";
function cssUnbalanced(s) {
  let depth = 0, dq = 0, sq = 0;
  for (const ch of String(s)) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return true;
    } else if (ch === '"') dq++;
    else if (ch === "'") sq++;
  }
  return depth !== 0 || dq % 2 !== 0 || sq % 2 !== 0;
}
var cssNeedsEscape = (s) => typeof s === "string" && cssEscapeText(s) !== s;
var CSS_ATTR_UNSAFE = /["\\]/g;
var cssAttrEscape = (s) => String(s).replace(CSS_ATTR_UNSAFE, hexEsc);
var cssAttrNeedsEscape = (s) => cssAttrEscape(s) !== String(s);
function cssEscapeText(s) {
  const raw = String(s);
  let out = raw.replace(CSS_UNSAFE, hexEsc);
  out = out.replace(/\/\*/g, "/" + hexEsc("*")).replace(/\*\//g, hexEsc("*") + "/");
  if (cssUnbalanced(raw)) out = out.replace(/[()"']/g, hexEsc);
  return out;
}
function hexToColorValue(hex, colorProfile) {
  const e = normHex(hex);
  if (!e) return null;
  const n = (i) => parseInt(e.slice(i, i + 2), 16) / 255;
  const value = { colorSpace: colorProfile === "display-p3" ? "display-p3" : "srgb", components: [round(n(0)), round(n(2)), round(n(4))] };
  if (e.length === 8) value.alpha = round(n(6));
  value.hex = "#" + e.slice(0, 6);
  return value;
}
var DTCG_TYPE = { COLOR: "color", FLOAT: "number", STRING: "string" };
function defaultModeName(variable, collections) {
  const c = (collections || []).find((x) => x.name === variable.collection);
  const modes = variable.values ? Object.keys(variable.values) : [];
  if (c && c.default && modes.includes(c.default)) return c.default;
  return modes[0];
}
function baseValue(variable, collections, def) {
  const values = variable.values || {};
  if (def === void 0) def = defaultModeName(variable, collections);
  if (values[def] !== void 0) return values[def];
  const firstDefined = Object.keys(values).find((m) => values[m] !== void 0);
  return firstDefined !== void 0 ? values[firstDefined] : void 0;
}
function dtcgValue(raw, colorProfile, dimension) {
  if (isAlias(raw)) return dtcgRef(raw.aliasOf);
  if (dimension) {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? { value: n, unit: "px" } : raw;
  }
  const c = isHexish(raw) ? hexToColorValue(raw, colorProfile) : null;
  return c || raw;
}
var SKIP = /* @__PURE__ */ Symbol("resolver-set omits this token");
function buildTree(designSystem, warn, opts, pick, withExtensions) {
  const root = {};
  const { collections, colorProfile } = designSystem || {};
  for (const v of designSystem && designSystem.variables || []) {
    const path = segs(v.name);
    if (!path.length) {
      warn(`variable with empty/degenerate name skipped: '${v.name}'`);
      continue;
    }
    if (path.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
      warn(`token '${v.name}' uses a reserved key (__proto__/constructor/prototype) \u2014 skipped`);
      continue;
    }
    const bv = pick(v);
    if (bv === SKIP) continue;
    if (bv === void 0) {
      warn(`token '${v.name}' has no value in any mode \u2014 skipped`);
      continue;
    }
    let node = root, collided = false;
    for (let i = 0; i < path.length - 1; i++) {
      if (node[path[i]] === void 0) node[path[i]] = {};
      else if (node[path[i]] && node[path[i]].$value !== void 0) {
        warn(`token '${v.name}' collides with token '${path.slice(0, i + 1).join("/")}' (a name is used as both a value and a group) \u2014 skipped`);
        collided = true;
        break;
      }
      node = node[path[i]];
    }
    if (collided) continue;
    const leafKey = path[path.length - 1];
    if (node[leafKey] !== void 0 && node[leafKey].$value === void 0) {
      warn(`token '${v.name}' collides with a group of the same name \u2014 skipped`);
      continue;
    }
    if (node[leafKey] !== void 0) warn(`duplicate token name '${v.name}' \u2014 later definition wins`);
    const leaf = {};
    let type = DTCG_TYPE[v.type];
    if (v.type === "COLOR" && isHexish(bv) && !normHex(bv)) warn(`token '${v.name}' has malformed hex '${bv}'`);
    const dimension = v.type === "FLOAT" && unitDecision(v, opts) === "px";
    if (dimension) type = "dimension";
    let value = dtcgValue(bv, colorProfile, dimension);
    if (v.type === "BOOLEAN") {
      type = "string";
      if (!isAlias(bv)) value = String(value);
      warn(`token '${v.name}' is BOOLEAN \u2014 DTCG has no boolean type; emitted as $type:"string" (origin kept in $extensions)`);
    }
    if (!type) {
      warn(`token '${v.name}' (type ${v.type}) maps to no DTCG $type \u2014 skipped (a typeless token is invalid per DTCG 2025.10)`);
      continue;
    }
    leaf.$type = type;
    leaf.$value = value;
    if (v.description) leaf.$description = v.description;
    if (!withExtensions) {
      node[leafKey] = leaf;
      continue;
    }
    const values = v.values || {};
    const modeKeys = Object.keys(values);
    const ext = {};
    if (modeKeys.length > 1) {
      ext.modes = /* @__PURE__ */ Object.create(null);
      for (const m of modeKeys) if (values[m] !== void 0) ext.modes[m] = dtcgValue(values[m], colorProfile, dimension);
    }
    if (v.scopes && v.scopes.length) ext.scopes = v.scopes;
    if (v.codeSyntax && Object.keys(v.codeSyntax).length) ext.codeSyntax = v.codeSyntax;
    if (v.type === "BOOLEAN") ext.originalType = "boolean";
    if (Object.keys(ext).length) leaf.$extensions = { "figma.com": ext };
    node[leafKey] = leaf;
  }
  return root;
}
function toDTCG(designSystem, warnings, opts) {
  const warn = (m) => {
    if (warnings) warnings.push(m);
  };
  const collections = (designSystem || {}).collections;
  return buildTree(designSystem, warn, opts, (v) => baseValue(v, collections), true);
}
var UNITLESS_SCOPES = /* @__PURE__ */ new Set(["OPACITY", "FONT_WEIGHT"]);
var UNITLESS_NAME_SEGMENTS = /* @__PURE__ */ new Set(["opacity", "fontweight"]);
function unitlessName(name) {
  return segs(name).some((seg) => UNITLESS_NAME_SEGMENTS.has(seg.replace(/[-_ ]/g, "").toLowerCase()));
}
function scopesSayUnitless(scopes) {
  return !!scopes.length && scopes.every((s) => UNITLESS_SCOPES.has(s));
}
function unitDecision(variable, opts) {
  if (opts && opts.unitless && opts.unitless.has && opts.unitless.has(variable.name)) return "override";
  const scopes = variable.scopes || [];
  if (scopesSayUnitless(scopes)) return "scopes";
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (!narrowed && unitlessName(variable.name)) return "name";
  return "px";
}
function numberUnit(variable, opts) {
  return unitDecision(variable, opts) === "px" ? "px" : "";
}
function cssValue(raw, unit) {
  if (isAlias(raw)) return "var(" + cssVarName(raw.aliasOf) + ")";
  const e = isHexish(raw) ? normHex(raw) : null;
  if (e) return "#" + e;
  const fmtNum = (s) => s === "0" ? "0" : unit ? s + unit : s;
  if (typeof raw === "number") return fmtNum(String(raw));
  if (typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw)) return fmtNum(raw);
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "string") return cssEscapeText(raw);
  return String(raw);
}
function toCSS(designSystem, opts) {
  const collections = designSystem && designSystem.collections || [];
  const vars = designSystem && designSystem.variables || [];
  const selectorFor = (mode) => opts && opts.selector ? opts.selector(mode) : `[data-theme="${cssAttrEscape(mode)}"]`;
  const rootLines = [];
  const perMode = /* @__PURE__ */ Object.create(null);
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    const values = v.values || {};
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === void 0) continue;
    const baseStr = JSON.stringify(base);
    const unit = numberUnit(v, opts);
    const varName = cssVarName(v.name);
    rootLines.push(`  ${varName}: ${cssValue(base, unit)};`);
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === void 0) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      (perMode[m] || (perMode[m] = [])).push(`  ${varName}: ${cssValue(values[m], unit)};`);
    }
  }
  let out = rootLines.length ? ":root {\n" + rootLines.join("\n") + "\n}\n" : "";
  for (const m of Object.keys(perMode)) out += `
${selectorFor(m)} {
` + perMode[m].join("\n") + "\n}\n";
  return out;
}
var RESOLVER_VERSION = "2025.10";
var RESOLVER_SCHEMA = "https://www.designtokens.org/schemas/2025.10/resolver.json";
var RESOLVER_DIR = "tokens";
var ptrEsc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
function fileSlug(s, fallback) {
  const out = String(s == null ? "" : s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return out || fallback;
}
function toResolver(designSystem, warnings, opts) {
  const seen = new Set(warnings || []);
  const warn = (m) => {
    if (warnings && !seen.has(m)) {
      seen.add(m);
      warnings.push(m);
    }
  };
  const ds = designSystem || {};
  const collections = ds.collections || [];
  const vars = ds.variables || [];
  const groups = /* @__PURE__ */ new Map();
  for (const v of vars) {
    const key = String(v && v.collection || "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const declared = /* @__PURE__ */ new Map();
  for (const c of collections) if (c && c.name != null && !declared.has(String(c.name))) declared.set(String(c.name), c);
  const takenFiles = /* @__PURE__ */ new Map();
  function reserveFile(base, ext, owner) {
    let candidate = `${RESOLVER_DIR}/${base}${ext}`, n = 1;
    while (takenFiles.has(candidate.toLowerCase())) {
      n += 1;
      const next = `${RESOLVER_DIR}/${base}-${n}${ext}`;
      warn(`resolver file '${candidate}' for ${owner} collides with ${takenFiles.get(candidate.toLowerCase())} after sanitizing the name \u2014 wrote '${next}' instead`);
      candidate = next;
    }
    takenFiles.set(candidate.toLowerCase(), owner);
    return candidate;
  }
  const takenKeys = { set: /* @__PURE__ */ new Set(), modifier: /* @__PURE__ */ new Set() };
  function reserveKey(name, kind) {
    let candidate = name, n = 1;
    while (takenKeys[kind].has(candidate)) {
      n += 1;
      const next = `${name} ${n}`;
      warn(`resolver ${kind} name '${candidate}' is already used \u2014 renamed to '${next}'`);
      candidate = next;
    }
    takenKeys[kind].add(candidate);
    return candidate;
  }
  const sets = /* @__PURE__ */ Object.create(null);
  const modifiers = /* @__PURE__ */ Object.create(null);
  const files = /* @__PURE__ */ Object.create(null);
  const resolutionOrder = [];
  const modifierRefs = [];
  for (const [collName, groupVars] of groups) {
    const c = declared.get(collName);
    const label = collName || "tokens";
    const sub = { colorProfile: ds.colorProfile, collections, variables: groupVars };
    const base = buildTree(sub, warn, opts, (v) => baseValue(v, collections), false);
    if (!Object.keys(base).length) continue;
    const setName = reserveKey(label, "set");
    const setFile = reserveFile(fileSlug(label, "tokens"), ".json", `set '${label}'`);
    files[setFile] = base;
    sets[setName] = { description: `${label} (default mode values)`, sources: [{ $ref: setFile }], $extensions: { "figma.com": { collection: collName || null } } };
    resolutionOrder.push({ $ref: `#/sets/${ptrEsc(setName)}` });
    const modes = [];
    for (const m of c && c.modes || []) if (!modes.includes(m)) modes.push(m);
    for (const v of groupVars) for (const m of Object.keys(v && v.values || {})) if (!modes.includes(m)) modes.push(m);
    if (modes.length < 2) continue;
    const contexts = /* @__PURE__ */ Object.create(null);
    let nonEmpty = 0;
    for (const m of modes) {
      const tree = buildTree(sub, warn, opts, (v) => {
        const values = v && v.values || {};
        const def2 = defaultModeName(v, collections);
        if (m === def2 || values[m] === void 0) return SKIP;
        const bv = baseValue(v, collections, def2);
        return JSON.stringify(values[m]) === JSON.stringify(bv) ? SKIP : values[m];
      }, false);
      if (!Object.keys(tree).length) {
        contexts[m] = [];
        continue;
      }
      const file = reserveFile(`${fileSlug(label, "tokens")}.${fileSlug(m, "mode")}`, ".json", `collection '${label}' mode '${m}'`);
      files[file] = tree;
      contexts[m] = [{ $ref: file }];
      nonEmpty += 1;
    }
    if (!nonEmpty) continue;
    const modName = reserveKey(label, "modifier");
    const def = c && c.default != null && modes.includes(c.default) ? c.default : modes[0];
    modifiers[modName] = { description: `${label} mode`, contexts, default: def, $extensions: { "figma.com": { collection: collName || null, defaultMode: def } } };
    modifierRefs.push({ $ref: `#/modifiers/${ptrEsc(modName)}` });
  }
  for (const r of modifierRefs) resolutionOrder.push(r);
  const resolver = { $schema: RESOLVER_SCHEMA };
  if (ds.file) resolver.name = String(ds.file);
  resolver.version = RESOLVER_VERSION;
  resolver.sets = sets;
  if (Object.keys(modifiers).length) resolver.modifiers = modifiers;
  resolver.resolutionOrder = resolutionOrder;
  return { resolver, files };
}
function lintTokens(designSystem, opts) {
  const warnings = [];
  toDTCG(designSystem, warnings, opts);
  lintNames(designSystem, opts, warnings);
  return warnings;
}
function lintNames(designSystem, opts, warnings) {
  const vars = designSystem && designSystem.variables || [];
  const names = new Set(vars.map((v) => segs(v.name).join(".")).filter(Boolean));
  for (const v of vars) for (const m of Object.keys(v.values || {})) {
    const val = v.values[m];
    if (isAlias(val) && !names.has(segs(val.aliasOf).join("."))) warnings.push(`token '${v.name}' (mode ${m}) references undefined token '${val.aliasOf}'`);
  }
  for (const v of vars) {
    if (v.type !== "STRING") continue;
    for (const m of Object.keys(v.values || {})) {
      if (cssNeedsEscape(v.values[m])) {
        warnings.push(`token '${v.name}' (mode ${m}) contains CSS-structural characters; escaped for safety in tokens.css`);
        break;
      }
    }
  }
  const modeNames = /* @__PURE__ */ new Set();
  for (const c of designSystem && designSystem.collections || []) for (const m of c.modes || []) modeNames.add(m);
  for (const v of vars) for (const m of Object.keys(v.values || {})) modeNames.add(m);
  for (const m of modeNames) {
    if (cssAttrNeedsEscape(m)) warnings.push(`mode '${m}' contains a quote or backslash; escaped in its tokens.css selector`);
  }
  const byVar = /* @__PURE__ */ new Map();
  for (const v of vars) {
    if (v.type === "FLOAT" && unitDecision(v, opts) === "name") {
      warnings.push(`token '${v.name}' has no narrowed scopes (Figma's ALL_SCOPES default); emitted UNITLESS because its name reads as an opacity/font-weight \u2014 scope it in Figma to make this explicit`);
    }
    const s = segs(v.name);
    if (!s.length) continue;
    const folded = cssVarName(v.name);
    if (folded !== "--" + s.join("-")) {
      warnings.push(`token '${v.name}' contains characters that are illegal in a CSS custom property; emitted as ${folded}`);
    }
    (byVar.get(folded) || byVar.set(folded, /* @__PURE__ */ new Set()).get(folded)).add(v.name);
  }
  for (const [k, set] of byVar) if (set.size > 1) warnings.push(`CSS variable ${k} produced by multiple tokens: ${[...set].join(", ")}`);
  return warnings;
}
function emitTokens(designSystem, opts) {
  const warnings = [];
  const dtcg = toDTCG(designSystem, warnings, opts);
  const css = toCSS(designSystem, opts);
  const { resolver, files } = toResolver(designSystem, warnings, opts);
  lintNames(designSystem, opts, warnings);
  return { dtcg, css, resolver, resolverFiles: files, warnings };
}
module.exports = { toDTCG, toCSS, toResolver, lintTokens, emitTokens, hexToColorValue, cssVarName };
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const { assertNotManifest } = require_catalog_input();
  const input = process.argv[2];
  const outDir = process.argv[3] || ".";
  if (!input) {
    console.error("usage: node design-to-code/tokens.js <design-system/tokens.json> [outDir]");
    process.exit(1);
  }
  const ds = JSON.parse(fs.readFileSync(input, "utf8"));
  assertNotManifest(ds, input, "variables", "design-system/tokens.json");
  fs.mkdirSync(outDir, { recursive: true });
  const { dtcg, css, resolver, resolverFiles, warnings } = emitTokens(ds);
  fs.writeFileSync(path.join(outDir, "tokens.dtcg.json"), JSON.stringify(dtcg, null, 2));
  fs.writeFileSync(path.join(outDir, "tokens.css"), css);
  fs.writeFileSync(path.join(outDir, "tokens.resolver.json"), JSON.stringify(resolver, null, 2));
  for (const rel of Object.keys(resolverFiles)) {
    const dest = path.join(outDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(resolverFiles[rel], null, 2));
  }
  warnings.forEach((w) => console.error("warn  " + w));
  console.log(`wrote tokens.dtcg.json + tokens.css + tokens.resolver.json (+${Object.keys(resolverFiles).length} set files under ${RESOLVER_DIR}/) (${(ds.variables || []).length} variables)`);
}
