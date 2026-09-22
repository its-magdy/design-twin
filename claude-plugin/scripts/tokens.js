// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// design-to-code/tokens-native.js
var require_tokens_native = __commonJS({
  "design-to-code/tokens-native.js"(exports2, module2) {
    module2.exports = function nativeEmitter({ segs: segs2, isAlias: isAlias2, normHex: normHex2, defaultModeName: defaultModeName2, baseValue: baseValue2, unitDecision: unitDecision2 }) {
      const PLATFORMS = {
        swiftui: { file: "DesignTokens.swift" },
        compose: { file: "DesignTokens.kt" },
        flutter: { file: "design_tokens.dart" },
        "react-native": { file: "designTokens.ts" }
      };
      const PROFILE_ALIASES = { "android-compose": "compose", ios: "swiftui", swift: "swiftui", android: "compose", rn: "react-native", dart: "flutter" };
      const RESERVED = new Set("default,class,object,in,is,as,do,if,else,for,while,return,var,val,let,func,fun,import,package,switch,case,break,continue,true,false,null,nil,self,super,this,new,static,final,const,enum,struct,extension,protocol,init,internal,public,private,open,operator,typealias,interface,when,try,catch,throw,void,with,get,set,dynamic,external,factory,mixin,part,required,show,hide,on,type,function,delete,export,yield,await,async,inout,repeat,guard,defer,where,any,some,lerp,copyWith,hashCode,toString,description".split(","));
      const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
      function camel(parts) {
        const w = parts.flatMap(words);
        let id = w.map((x, i) => i === 0 ? x.charAt(0).toLowerCase() + x.slice(1) : x.charAt(0).toUpperCase() + x.slice(1)).join("");
        if (!id) id = "token";
        if (/^[0-9]/.test(id)) id = "n" + id;
        if (RESERVED.has(id)) id += "Token";
        return id;
      }
      const pascal = (parts) => {
        const c = camel(parts);
        return c.charAt(0).toUpperCase() + c.slice(1);
      };
      function isFontSize(v) {
        const scopes = v.scopes || [];
        if (scopes.length && !scopes.every((s) => s === "ALL_SCOPES")) return scopes.includes("FONT_SIZE");
        return /font.?size|text.?size|type.?size/i.test(v.collection + "/" + v.name);
      }
      function kindOf(v, opts) {
        if (v.type === "COLOR") return "color";
        if (v.type === "BOOLEAN") return "bool";
        if (v.type === "STRING") return "string";
        if (v.type === "FLOAT") return unitDecision2(v, opts) === "px" ? isFontSize(v) ? "fontSize" : "dimension" : "number";
        return null;
      }
      function resolve(byName, collections, v, mode, seen) {
        const values = v.values || {};
        let raw = values[mode];
        if (raw === void 0) raw = baseValue2(v, collections, defaultModeName2(v, collections));
        if (!isAlias2(raw)) return raw;
        const target = byName.get(raw.aliasOf);
        if (!target || seen && seen.has(target.name)) return void 0;
        const next = new Set(seen || []).add(v.name);
        const tMode = target.values && target.values[mode] !== void 0 ? mode : defaultModeName2(target, collections);
        return resolve(byName, collections, target, tMode, next);
      }
      function model(designSystem, warnings, opts) {
        const collections = designSystem && designSystem.collections || [];
        const vars = designSystem && designSystem.variables || [];
        const byName = new Map(vars.map((v) => [v.name, v]));
        const typeNames = /* @__PURE__ */ new Set();
        const out = [];
        for (const c of collections) {
          const mine = vars.filter((v) => v.collection === c.name);
          const modeNames = (c.modes && c.modes.length ? c.modes : [...new Set(mine.flatMap((v) => Object.keys(v.values || {})))]).map(String);
          if (!mine.length || !modeNames.length) continue;
          let type = pascal([c.name]) + "Tokens";
          for (let n = 2; typeNames.has(type); n++) type = pascal([c.name]) + "Tokens" + n;
          typeNames.add(type);
          const ids = /* @__PURE__ */ new Set();
          const fields = [];
          for (const v of mine) {
            const kind = kindOf(v, opts);
            if (!kind || !segs2(v.name).length) continue;
            const values = {};
            let ok = true;
            for (const m of modeNames) {
              const r = resolve(byName, collections, v, m);
              if (r === void 0 || kind === "color" && !normHex2(r)) {
                ok = false;
                break;
              }
              values[m] = r;
            }
            if (!ok) {
              warnings.push(`${v.name}: skipped \u2014 its value could not be resolved inside this file (an alias to a library variable that was not exported?)`);
              continue;
            }
            let id = camel(segs2(v.name));
            if (ids.has(id)) {
              let n = 2;
              while (ids.has(id + n)) n++;
              warnings.push(`${v.name}: "${id}" is already taken in ${type} \u2014 emitted as "${id + n}"`);
              id += n;
            }
            ids.add(id);
            fields.push({ id, kind, source: v.name, values });
          }
          if (!fields.length) continue;
          const units = fields.reduce((n, f) => n + (f.kind === "color" || f.kind === "fontSize" ? 2 : 1), 0) + Math.ceil(fields.length / 32) + 2;
          if (modeNames.length > 1 && units > 255) warnings.push(`${c.name}: ${fields.length} tokens in one multi-mode collection need ${units} JVM parameter units (Color and TextUnit count double) \u2014 over the 255 limit, so the Compose data class will not compile; split the collection in Figma`);
          const modeIds = /* @__PURE__ */ new Set();
          const modes = modeNames.map((name) => {
            let id = camel([name]);
            if (ids.has(id)) id += "Mode";
            for (let n = 2, base = id; modeIds.has(id); n++) id = base + n;
            modeIds.add(id);
            return { name, id };
          });
          const def = modeNames.includes(String(c.default)) ? String(c.default) : modeNames[0];
          out.push({ name: c.name, type, modes, default: def, defaultId: modes.find((m) => m.name === def).id, fields });
        }
        return out;
      }
      const num = (raw) => {
        const n = Number(raw);
        return Number.isFinite(n) ? String(Math.round(n * 1e4) / 1e4) : "0";
      };
      const str = (raw) => JSON.stringify(String(raw));
      const bool = (raw) => String(raw === true || raw === "true");
      const argb = (raw) => {
        const h = normHex2(raw);
        return "0x" + (h.length === 8 ? h.slice(6) + h.slice(0, 6) : "ff" + h).toUpperCase();
      };
      const HEADER = "GENERATED by Design Twin (tokens.js --native) from design-system/tokens.json \u2014 do not edit by hand; re-run after a token pull.";
      function compose(cols, opts) {
        const T = { color: "Color", dimension: "Dp", fontSize: "TextUnit", number: "Float", bool: "Boolean", string: "String" };
        const lit = (k, r) => k === "color" ? `Color(${argb(r)})` : k === "dimension" ? `${num(r)}.dp` : k === "fontSize" ? `${num(r)}.sp` : k === "number" ? `${num(r)}f` : k === "bool" ? bool(r) : str(r).replace(/\$/g, "\\$");
        const L = [
          `// ${HEADER}`,
          `package ${opts && opts.package || "design.tokens"}`,
          "",
          "import androidx.compose.runtime.Immutable",
          "import androidx.compose.runtime.staticCompositionLocalOf",
          "import androidx.compose.ui.graphics.Color",
          "import androidx.compose.ui.unit.Dp",
          "import androidx.compose.ui.unit.TextUnit",
          "import androidx.compose.ui.unit.dp",
          "import androidx.compose.ui.unit.sp"
        ];
        for (const c of cols) {
          L.push("", `// Figma collection "${c.name}"`);
          if (c.modes.length === 1) {
            L.push(`object ${c.type} {`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]} = ${lit(f.kind, f.values[c.modes[0].name])} // ${f.source}`), "}");
            continue;
          }
          L.push("@Immutable", `data class ${c.type}(`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]}, // ${f.source}`), ")");
          for (const m of c.modes) L.push("", `val ${c.type}${pascal([m.id])} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id} = ${lit(f.kind, f.values[m.name])},`), ")");
          L.push(
            "",
            `// Provide the active mode once, near the root: CompositionLocalProvider(Local${c.type} provides ${c.type}${pascal([c.modes.find((m) => m.name !== c.default).id])}) { \u2026 }`,
            `val Local${c.type} = staticCompositionLocalOf { ${c.type}${pascal([c.defaultId])} }`
          );
        }
        return L.join("\n") + "\n";
      }
      function swiftModeHint(c) {
        const ids = c.modes.map((m) => m.id);
        if (ids.includes("light") && ids.includes("dark")) return "colorScheme == .dark ? .dark : .light" + (ids.length > 2 ? ` /* also: ${ids.filter((i) => i !== "light" && i !== "dark").map((i) => "." + i).join(", ")} */` : "");
        return `.${(c.modes.find((m) => m.name !== c.default) || c.modes[0]).id} /* one of: ${ids.map((i) => "." + i).join(", ")} \u2014 the app picks */`;
      }
      function swiftui(cols) {
        const T = { color: "Color", dimension: "CGFloat", fontSize: "CGFloat", number: "Double", bool: "Bool", string: "String" };
        const chan = (h, i) => num(parseInt(h.slice(i, i + 2), 16) / 255);
        const lit = (k, r) => {
          if (k === "color") {
            const h = normHex2(r);
            return `Color(.sRGB, red: ${chan(h, 0)}, green: ${chan(h, 2)}, blue: ${chan(h, 4)}, opacity: ${h.length === 8 ? chan(h, 6) : "1"})`;
          }
          return k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}") : num(r);
        };
        const L = [`// ${HEADER}`, "import SwiftUI"];
        for (const c of cols) {
          L.push("", `// Figma collection "${c.name}"`);
          if (c.modes.length === 1) {
            L.push(`public enum ${c.type} {`, ...c.fields.map((f) => `    public static let ${f.id}: ${T[f.kind]} = ${lit(f.kind, f.values[c.modes[0].name])} // ${f.source}`), "}");
            continue;
          }
          L.push(
            `public struct ${c.type}: Sendable, Equatable {`,
            ...c.fields.map((f) => `    public let ${f.id}: ${T[f.kind]} // ${f.source}`),
            "",
            `    public init(${c.fields.map((f) => `${f.id}: ${T[f.kind]}`).join(", ")}) {`,
            ...c.fields.map((f) => `        self.${f.id} = ${f.id}`),
            "    }"
          );
          for (const m of c.modes) L.push("", `    public static let ${m.id} = ${c.type}(`, c.fields.map((f) => `        ${f.id}: ${lit(f.kind, f.values[m.name])}`).join(",\n"), "    )");
          const env = c.type.charAt(0).toLowerCase() + c.type.slice(1);
          const defId = c.defaultId;
          L.push(
            "}",
            "",
            `private struct ${c.type}Key: EnvironmentKey { static let defaultValue = ${c.type}.${defId} }`,
            "public extension EnvironmentValues {",
            `    // Set once near the root: .environment(\\.${env}, ${swiftModeHint(c)}); read with @Environment(\\.${env}).`,
            `    var ${env}: ${c.type} {`,
            `        get { self[${c.type}Key.self] }`,
            `        set { self[${c.type}Key.self] = newValue }`,
            "    }",
            "}"
          );
        }
        return L.join("\n") + "\n";
      }
      function flutter(cols) {
        const T = { color: "Color", dimension: "double", fontSize: "double", number: "double", bool: "bool", string: "String" };
        const lit = (k, r) => k === "color" ? `Color(${argb(r)})` : k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\$/g, "\\$") : num(r);
        const lerp = (f) => f.kind === "color" ? `Color.lerp(${f.id}, other.${f.id}, t)!` : T[f.kind] === "double" ? `lerpDouble(${f.id}, other.${f.id}, t)!` : `t < 0.5 ? ${f.id} : other.${f.id}`;
        const L = [`// ${HEADER}`, "// ignore_for_file: constant_identifier_names", "import 'dart:ui' show lerpDouble;", "", "import 'package:flutter/material.dart';"];
        for (const c of cols) {
          L.push("", `/// Figma collection "${c.name}"`);
          if (c.modes.length === 1) {
            L.push(`abstract final class ${c.type} {`, ...c.fields.map((f) => `  static const ${T[f.kind]} ${f.id} = ${lit(f.kind, f.values[c.modes[0].name])}; // ${f.source}`), "}");
            continue;
          }
          L.push(
            `/// Register per theme: ThemeData(extensions: [${c.type}.${c.modes[0].id}]); read: Theme.of(context).extension<${c.type}>()!`,
            "@immutable",
            `class ${c.type} extends ThemeExtension<${c.type}> {`,
            `  const ${c.type}({`,
            ...c.fields.map((f) => `    required this.${f.id},`),
            "  });",
            "",
            ...c.fields.map((f) => `  final ${T[f.kind]} ${f.id}; // ${f.source}`)
          );
          for (const m of c.modes) L.push("", `  static const ${m.id} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id}: ${lit(f.kind, f.values[m.name])},`), "  );");
          L.push(
            "",
            "  @override",
            `  ${c.type} copyWith({`,
            ...c.fields.map((f) => `    ${T[f.kind]}? ${f.id},`),
            "  }) {",
            `    return ${c.type}(`,
            ...c.fields.map((f) => `      ${f.id}: ${f.id} ?? this.${f.id},`),
            "    );",
            "  }",
            "",
            "  @override",
            `  ${c.type} lerp(ThemeExtension<${c.type}>? other, double t) {`,
            `    if (other is! ${c.type}) return this;`,
            `    return ${c.type}(`,
            ...c.fields.map((f) => `      ${f.id}: ${lerp(f)},`),
            "    );",
            "  }",
            "}"
          );
        }
        return L.join("\n") + "\n";
      }
      function reactNative(cols) {
        const T = { color: "string", dimension: "number", fontSize: "number", number: "number", bool: "boolean", string: "string" };
        const lit = (k, r) => k === "color" ? str("#" + normHex2(r)) : k === "bool" ? bool(r) : k === "string" ? str(r) : num(r);
        const L = [`// ${HEADER}`, "// Numbers are density-independent units, as React Native styles expect. Pick a mode with useColorScheme()."];
        for (const c of cols) {
          const v = c.type.charAt(0).toLowerCase() + c.type.slice(1);
          L.push("", `/** Figma collection "${c.name}" */`);
          if (c.modes.length === 1) {
            L.push(`export const ${v} = {`, ...c.fields.map((f) => `  ${f.id}: ${lit(f.kind, f.values[c.modes[0].name])}, // ${f.source}`), "} as const;");
            continue;
          }
          L.push(
            `export interface ${c.type} {`,
            ...c.fields.map((f) => `  ${f.id}: ${T[f.kind]}; // ${f.source}`),
            "}",
            "",
            `export type ${c.type}Mode = ${c.modes.map((m) => str(m.id)).join(" | ")};`,
            `export const ${v}DefaultMode: ${c.type}Mode = ${str(c.defaultId)};`,
            "",
            `export const ${v}: Record<${c.type}Mode, ${c.type}> = {`
          );
          for (const m of c.modes) L.push(`  ${m.id}: {`, ...c.fields.map((f) => `    ${f.id}: ${lit(f.kind, f.values[m.name])},`), "  },");
          L.push("};");
        }
        return L.join("\n") + "\n";
      }
      const EMIT = { compose, swiftui, flutter, "react-native": reactNative };
      function platformOf(name) {
        const key = String(name || "").toLowerCase();
        const p = PROFILE_ALIASES[key] || key;
        return PLATFORMS[p] ? p : null;
      }
      function toNative(designSystem, platform, opts) {
        const p = platformOf(platform);
        if (!p) throw new Error(`unknown native platform "${platform}" \u2014 use one of: ${Object.keys(PLATFORMS).join(", ")}`);
        const warnings = [];
        const cols = model(designSystem, warnings, opts);
        return { file: PLATFORMS[p].file, text: EMIT[p](cols, opts), warnings };
      }
      return { toNative, platformOf, PLATFORMS };
    };
  }
});

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
    function readJsonFile(file, what, hint) {
      const fs = require("fs");
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (e) {
        const why = e && e.code === "ENOENT" ? "does not exist" : e && e.code === "EISDIR" ? "is a directory, not a file" : e && e.code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${e && e.code || e})`;
        console.error(`error  ${what}: '${file}' ${why}.` + (hint ? `
       ${hint}` : ""));
        process.exit(2);
      }
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error(`error  ${what}: '${file}' is not valid JSON \u2014 ${e && e.message || e}`);
        process.exit(2);
      }
    }
    var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull design --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull design --design-system` to create it.";
    module2.exports = { assertNotManifest, isManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT };
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
  const rootLines = /* @__PURE__ */ new Map();
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
    rootLines.set(varName, `  ${varName}: ${cssValue(base, unit)};`);
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === void 0) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      (perMode[m] || (perMode[m] = /* @__PURE__ */ new Map())).set(varName, `  ${varName}: ${cssValue(values[m], unit)};`);
    }
  }
  let out = rootLines.size ? ":root {\n" + [...rootLines.values()].join("\n") + "\n}\n" : "";
  for (const m of Object.keys(perMode)) out += `
${selectorFor(m)} {
` + [...perMode[m].values()].join("\n") + "\n}\n";
  return out;
}
var TW_NAMESPACE = { color: "--color-", dimension: "--spacing-", radius: "--radius-", fontSize: "--text-", fontFamily: "--font-" };
function twSlug(name) {
  const slug = segs(name).join("-").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug || "token";
}
var RADIUS_SCOPES = /* @__PURE__ */ new Set(["CORNER_RADIUS"]);
function twKind(v, opts) {
  if (v.type === "COLOR") return "color";
  if (v.type === "STRING") return /font.?family|typeface/i.test(String(v.collection) + "/" + v.name) ? "fontFamily" : null;
  if (v.type !== "FLOAT") return null;
  if (unitDecision(v, opts) !== "px") return null;
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (narrowed && scopes.some((x) => RADIUS_SCOPES.has(x))) return "radius";
  if (narrowed && scopes.includes("FONT_SIZE")) return "fontSize";
  if (!narrowed && /radius|corner|rounded/i.test(v.name)) return "radius";
  if (!narrowed && /font.?size|text.?size|type.?size/i.test(String(v.collection) + "/" + v.name)) return "fontSize";
  return "dimension";
}
function toTailwind(designSystem, opts) {
  const collections = designSystem && designSystem.collections || [];
  const vars = designSystem && designSystem.variables || [];
  const theme = /* @__PURE__ */ new Map();
  const perMode = /* @__PURE__ */ Object.create(null);
  let utilities = 0;
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === void 0) continue;
    const kind = twKind(v, opts);
    const name = (kind ? TW_NAMESPACE[kind] : "--") + twSlug(v.name);
    if (kind) utilities++;
    const unit = numberUnit(v, opts);
    const val = (raw) => isAlias(raw) ? aliasVar(raw, vars, opts) : cssValue(raw, unit);
    const baseStr = JSON.stringify(base);
    theme.set(name, `  ${name}: ${val(base)};`);
    const values = v.values || {};
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === void 0) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      (perMode[m] || (perMode[m] = /* @__PURE__ */ new Map())).set(name, `  ${name}: ${val(values[m])};`);
    }
  }
  let out = '@import "tailwindcss";\n';
  if (theme.size) out += "\n@theme {\n" + [...theme.values()].join("\n") + "\n}\n";
  for (const m of Object.keys(perMode)) out += `
[data-theme="${cssAttrEscape(m)}"] {
` + [...perMode[m].values()].join("\n") + "\n}\n";
  return { text: out, utilities, tokens: theme.size };
}
function aliasVar(raw, vars, opts) {
  const target = vars.find((x) => x.name === raw.aliasOf);
  const kind = target ? twKind(target, opts) : null;
  return "var(" + (kind ? TW_NAMESPACE[kind] : "--") + twSlug(raw.aliasOf) + ")";
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
module.exports = { toDTCG, toCSS, toResolver, toTailwind, lintTokens, emitTokens, hexToColorValue, cssVarName };
Object.assign(module.exports, require_tokens_native()({ segs, isAlias, normHex, defaultModeName, baseValue, unitDecision }));
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const { assertNotManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT } = require_catalog_input();
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return void 0;
    const v = args[i + 1];
    args.splice(i, 2);
    return v === void 0 ? "" : v;
  };
  const native = flag("--native");
  const web = flag("--web");
  const kotlinPackage = flag("--package");
  const input = args[0];
  const outDir = args[1] || ".";
  const USAGE = "usage: node design-to-code/tokens.js <design-system/tokens.json | design/variables.json> [outDir]\n       [--native swiftui|compose|flutter|react-native] [--package <kotlin.package>] [--web tailwind]";
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const stray = args.filter((a) => a.startsWith("-"));
  if (stray.length) {
    console.error(`tokens: unknown flag ${stray.join(", ")}
${USAGE}`);
    process.exit(1);
  }
  if (!input) {
    console.error(USAGE);
    process.exit(1);
  }
  const { toNative, platformOf } = module.exports;
  if (native !== void 0 && !platformOf(native)) {
    console.error(`--native: unknown platform "${native}"
${USAGE}`);
    process.exit(1);
  }
  const WEB_TARGETS = { tailwind: "theme.css", "web-tailwind": "theme.css" };
  if (web !== void 0 && !WEB_TARGETS[web]) {
    console.error(`--web: unknown target "${web}" (known: tailwind)
${USAGE}`);
    process.exit(1);
  }
  const ds = readJsonFile(input, "token catalog", NO_DESIGN_SYSTEM_HINT + "\n       A single-screen pull DOES write design/variables.json \u2014 pass that instead.");
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
  let nativeNote = "";
  if (web !== void 0) {
    const { toTailwind: toTailwind2 } = module.exports;
    const tw = toTailwind2(ds);
    const file = WEB_TARGETS[web];
    fs.writeFileSync(path.join(outDir, file), tw.text);
    nativeNote += ` + ${file}`;
    if (tw.tokens && !tw.utilities) warnings.push(`--web ${web}: no variable mapped to a Tailwind namespace, so ${file} generates no utilities \u2014 every token is a plain custom property you must reference with var()`);
    else if (tw.tokens > tw.utilities) warnings.push(`--web ${web}: ${tw.tokens - tw.utilities} of ${tw.tokens} token(s) match no Tailwind namespace (unitless FLOATs like opacity/font-weight) \u2014 emitted unprefixed, usable via var() but generating no utility`);
  }
  if (native !== void 0) {
    const n = toNative(ds, native, { package: kotlinPackage || void 0 });
    fs.writeFileSync(path.join(outDir, n.file), n.text);
    warnings.push(...n.warnings);
    nativeNote = ` + ${n.file}`;
  }
  warnings.forEach((w) => console.error("warn  " + w));
  console.log(`wrote tokens.dtcg.json + tokens.css + tokens.resolver.json (+${Object.keys(resolverFiles).length} set files under ${RESOLVER_DIR}/)${nativeNote} (${(ds.variables || []).length} variables)`);
}
