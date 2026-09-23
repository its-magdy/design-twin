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
    module2.exports = function nativeEmitter({ segs: segs2, isAlias: isAlias2, normHex: normHex2, defaultModeName: defaultModeName2, baseValue: baseValue2, unitDecision: unitDecision2, isSentinel: isSentinel2 }) {
      const FULL = Object.freeze({ fullyRounded: true });
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
          const cands = [];
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
              values[m] = isSentinel2 && isSentinel2(v, r) ? FULL : r;
            }
            if (!ok) {
              warnings.push(`${v.name}: skipped \u2014 its value could not be resolved inside this file (an alias to a library variable that was not exported?)`);
              continue;
            }
            cands.push({ v, kind, values, id: camel(segs2(v.name)) });
          }
          const tag = (v) => v.key ? String(v.key).slice(0, 8).toLowerCase() : null;
          const label = (x) => `${x.v.name}${x.v.key ? ` (key ${tag(x.v)}\u2026)` : ""} = ${JSON.stringify(x.v.values || {})}`;
          const byId = /* @__PURE__ */ new Map();
          for (const x of cands) {
            if (!byId.has(x.id)) byId.set(x.id, []);
            byId.get(x.id).push(x);
          }
          for (const [id, list] of byId) {
            const distinct = [];
            for (const x of list) if (!distinct.some((d) => JSON.stringify(d.values) === JSON.stringify(x.values))) distinct.push(x);
            if (list.length > distinct.length) warnings.push(`${list.map(label).join(" and ")}: identical in every mode, so "${id}" in ${type} is emitted once`);
            if (distinct.length === 1) {
              distinct[0].final = id;
              continue;
            }
            const sameName = distinct.every((x) => x.v.name === distinct[0].v.name);
            const lossless = distinct.filter((x) => /^[A-Za-z0-9 /_-]+$/.test(String(x.v.name)));
            const keeper = sameName ? null : lossless.length === 1 ? lossless[0] : distinct[0];
            const names = [];
            distinct.forEach((x, i) => {
              if (x === keeper) {
                x.final = id;
                ids.add(id);
                names.push(`${label(x)} \u2192 "${id}"`);
                return;
              }
              let next = tag(x.v) ? `${id}_${tag(x.v)}` : `${id}${i + 1}`;
              for (let n = 2; ids.has(next) || byId.has(next); n++) next = (tag(x.v) ? `${id}_${tag(x.v)}` : id) + n;
              ids.add(next);
              x.final = next;
              names.push(`${label(x)} \u2192 "${next}"`);
            });
            warnings.push(`${distinct.length} different variables fold onto "${id}" in ${type} and DIFFER \u2014 none is dropped: ${names.join("; ")}`);
          }
          for (const x of cands) {
            if (!x.final) continue;
            if (ids.has(x.final) && fields.some((f) => f.id === x.final)) continue;
            ids.add(x.final);
            fields.push({ id: x.final, kind: x.kind, source: x.v.name, values: x.values });
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
        const lit = (k, r) => r === FULL ? k === "fontSize" ? "9999.sp" : k === "number" ? "9999f" : "9999.dp /* Figma 'fully rounded' \u2014 use CircleShape */" : k === "color" ? `Color(${argb(r)})` : k === "dimension" ? `${num(r)}.dp` : k === "fontSize" ? `${num(r)}.sp` : k === "number" ? `${num(r)}f` : k === "bool" ? bool(r) : str(r).replace(/\$/g, "\\$");
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
          if (r === FULL) return ".infinity";
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
        const lit = (k, r) => r === FULL ? "double.infinity" : k === "color" ? `Color(${argb(r)})` : k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\$/g, "\\$") : num(r);
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
        const lit = (k, r) => r === FULL ? "9999" : k === "color" ? str("#" + normHex2(r)) : k === "bool" ? bool(r) : k === "string" ? str(r) : num(r);
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

// design-to-code/slice-sources.js
var require_slice_sources = __commonJS({
  "design-to-code/slice-sources.js"(exports2, module2) {
    function sourcesOf(doc, docPath, fs, path) {
      const out = /* @__PURE__ */ new Map();
      const add = (key, screen) => {
        if (typeof key !== "string" || !key || !screen) return;
        if (!out.has(key)) out.set(key, []);
        if (!out.get(key).includes(screen)) out.get(key).push(screen);
      };
      const base = docPath ? path.dirname(docPath) : ".";
      for (const sl of Array.isArray(doc && doc._slices) ? doc._slices : []) {
        if (!sl) continue;
        let read = false;
        if (typeof sl.file === "string" && fs && path) {
          try {
            const slice = JSON.parse(fs.readFileSync(path.join(base, sl.file.replace(/\.json$/, ".vars.json")), "utf8"));
            for (const v of slice.variables || []) add(v && v.key, sl.screen);
            read = true;
          } catch (_) {
          }
        }
        if (!read) for (const k of Array.isArray(sl.keys) ? sl.keys : []) add(k, sl.screen);
      }
      for (const c of Array.isArray(doc && doc._conflicts) ? doc._conflicts : []) {
        for (const vr of c && c.variants || []) for (const sc of vr.screens || []) add(vr.key, sc);
      }
      if (!out.size && docPath && /\.vars\.json$/.test(docPath)) {
        for (const v of doc && doc.variables || []) add(v && v.key, path.basename(docPath, ".vars.json"));
      }
      return out;
    }
    module2.exports = { sourcesOf };
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
var KEY_SUFFIX_LEN = 8;
function identityOf(v) {
  if (v && typeof v.key === "string" && v.key) return "k:" + v.key;
  return "n:" + String(v && v.collection || "") + "\0" + String(v && v.name || "");
}
var shortKey = (v) => v && typeof v.key === "string" && v.key ? v.key.slice(0, KEY_SUFFIX_LEN).toLowerCase() : null;
var suffixSlug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function equivalentVars(a, b, collections) {
  if (a.type !== b.type) return false;
  const ba = JSON.stringify(baseValue(a, collections)), bb = JSON.stringify(baseValue(b, collections));
  if (ba !== bb) return false;
  const at = (v, base, m) => {
    const x = (v.values || {})[m];
    return x === void 0 ? base : JSON.stringify(x);
  };
  for (const m of /* @__PURE__ */ new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])) if (at(a, ba, m) !== at(b, bb, m)) return false;
  return true;
}
function planIds(vars, idOf, suffix, collections, output, exact) {
  const groups = /* @__PURE__ */ new Map();
  for (const v of vars) {
    const id = idOf(v);
    if (id == null) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(v);
  }
  const ids = /* @__PURE__ */ new Map(), canonical = /* @__PURE__ */ new Set(), notes = [];
  const taken = new Set(groups.keys());
  for (const [id, list] of groups) {
    const byIdent = /* @__PURE__ */ new Map();
    for (const v of list) byIdent.set(identityOf(v), v);
    const members = [...byIdent.values()];
    const clusters = [];
    for (const v of members) {
      const c = clusters.find((cl) => equivalentVars(cl[0], v, collections));
      if (c) c.push(v);
      else clusters.push([v]);
    }
    if (clusters.length === 1) {
      for (const v of list) ids.set(v, id);
      canonical.add(members[0]);
      if (members.length > 1) notes.push({ output, id, differ: false, members: members.map((v) => ({ v, id })) });
      continue;
    }
    const assigned = /* @__PURE__ */ new Map();
    const exactOnes = exact ? members.filter((v) => exact(v)) : [];
    const keeper = exactOnes.length === 1 && members.filter((v) => v.name === exactOnes[0].name).length === 1 ? exactOnes[0] : null;
    for (const v of members) {
      if (v === keeper) {
        assigned.set(identityOf(v), id);
        canonical.add(v);
        continue;
      }
      const s = shortKey(v) || suffixSlug(v.collection) || "alt";
      let nid = suffix(id, s);
      for (let n = 2; taken.has(nid); n++) nid = suffix(id, s + "-" + n);
      taken.add(nid);
      assigned.set(identityOf(v), nid);
      canonical.add(v);
    }
    for (const v of list) ids.set(v, assigned.get(identityOf(v)));
    notes.push({ output, id, differ: true, members: members.map((v) => ({ v, id: assigned.get(identityOf(v)) })) });
  }
  const byName = /* @__PURE__ */ new Map();
  for (const v of vars) {
    if (!byName.has(v.name)) byName.set(v.name, []);
    byName.get(v.name).push(v);
  }
  return { id: (v) => ids.get(v), canonical, notes, byName };
}
function aliasTarget(plan, name, referrer, warn) {
  const cands = (plan.byName.get(name) || []).filter((c) => plan.id(c) != null);
  if (!cands.length) return null;
  if (new Set(cands.map((c) => plan.id(c))).size === 1) return cands[0];
  const sameColl = cands.filter((c) => referrer && c.collection === referrer.collection);
  const pool = (sameColl.length && new Set(sameColl.map((c) => plan.id(c))).size === 1 ? sameColl : cands).slice().sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")));
  const pick = pool[0];
  if (warn) {
    warn(`alias '${referrer ? referrer.name : "?"}' -> '${name}' is AMBIGUOUS: the export names an alias target by name, and ${cands.length} different variables are called '${name}' (${cands.map((c) => (shortKey(c) ? "key " + shortKey(c) + "\u2026" : "'" + c.collection + "'") + " " + JSON.stringify(c.values)).join(", ")}) \u2014 pointed at ${plan.id(pick)}; confirm in Figma which one it really aliases`);
  }
  return pick;
}
function collisionMessages(notes, opts) {
  const sources = opts && opts.sources || null;
  const bySet = /* @__PURE__ */ new Map();
  for (const n of notes) {
    const k = (n.differ ? "D" : "S") + n.members.map((m) => identityOf(m.v)).sort().join("|");
    if (!bySet.has(k)) bySet.set(k, []);
    bySet.get(k).push(n);
  }
  const out = [];
  for (const group of bySet.values()) {
    const first = group[0];
    const members = first.members.map((m) => m.v);
    const names = [...new Set(members.map((v) => v.name))];
    const who = (v) => {
      const k = shortKey(v);
      const where2 = k && sources && sources.get(v.key);
      return (k ? `key ${k}\u2026` : `'${v.collection || ""}'`) + ` = ${JSON.stringify(v.values || {})}` + (where2 && where2.length ? ` (from ${where2.join(", ")})` : "");
    };
    const oneColl = members.every((v) => v.collection === members[0].collection) && members[0].collection;
    const subject = names.length === 1 ? `${members.length} different Figma variables share the name '${names[0]}'${oneColl ? ` (collection '${members[0].collection}')` : ""}` : `${members.length} different Figma variables (${names.map((n) => `'${n}'`).join(", ")}) fold onto one identifier`;
    const where = group.map((n) => `${n.output} ${n.members.map((m) => m.id).join(" / ")}`).join("; ");
    if (first.differ) {
      out.push(`${subject} and resolve DIFFERENTLY \u2014 none is dropped, each keeps its own name: ${members.map(who).join(" vs ")}. Emitted as: ${where}. ` + (names.length === 1 ? `Pick by key, never by name. A screen's own .vars.json usually carries only one of them under the plain name \u2014 generate that screen's theme from it (or from design-system/tokens.json), not from the merged variables.json.` : `The name spelled exactly as the identifier keeps it; a name that only reached it by folding punctuation carries its key.`));
    } else {
      out.push(`${subject} but resolve identically in every mode \u2014 emitted ONCE: ${members.map(who).join(" and ")} \u2192 ${where}.`);
    }
  }
  return out;
}
var SENTINEL_MIN = 1e4;
var WEB_FULL_ROUND = 9999;
function isRadiusVar(v) {
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (narrowed) return scopes.includes("CORNER_RADIUS");
  return /radius|corner|round/i.test(String(v.collection || "") + "/" + v.name);
}
function isSentinel(v, raw) {
  if (!v || v.type !== "FLOAT" || isAlias(raw)) return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && Math.abs(n) >= SENTINEL_MIN && isRadiusVar(v);
}
var webNumber = (v, raw) => isSentinel(v, raw) ? WEB_FULL_ROUND : raw;
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
function dtcgValue(raw, colorProfile, dimension, ref) {
  if (isAlias(raw)) return ref ? ref(raw.aliasOf) : dtcgRef(raw.aliasOf);
  if (dimension) {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? { value: n, unit: "px" } : raw;
  }
  const c = isHexish(raw) ? hexToColorValue(raw, colorProfile) : null;
  return c || raw;
}
var SKIP = /* @__PURE__ */ Symbol("resolver-set omits this token");
var DTCG_SEP = "\0";
function dtcgPlan(designSystem) {
  const ds = designSystem || {};
  return planIds(
    ds.variables || [],
    (v) => {
      const p = segs(v.name);
      return p.length ? p.join(DTCG_SEP) : null;
    },
    (id, s) => id + "-" + s,
    ds.collections,
    "tokens.dtcg.json",
    (v) => !/[.{}$]/.test(String(v.name))
  );
}
function buildTree(designSystem, warn, opts, pick, withExtensions, plan) {
  const root = {};
  const { collections, colorProfile } = designSystem || {};
  plan = plan || dtcgPlan(designSystem);
  const ref = (referrer) => (name) => {
    const t = aliasTarget(plan, name, referrer, warn);
    return t ? "{" + plan.id(t).split(DTCG_SEP).join(".") + "}" : dtcgRef(name);
  };
  for (const v of designSystem && designSystem.variables || []) {
    if (!segs(v.name).length) {
      warn(`variable with empty/degenerate name skipped: '${v.name}'`);
      continue;
    }
    if (!plan.canonical.has(v)) continue;
    const path = plan.id(v).split(DTCG_SEP);
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
    if (node[leafKey] !== void 0) {
      warn(`token '${v.name}' lands on '${path.join("/")}', which another token already holds \u2014 skipped, nothing overwritten`);
      continue;
    }
    const leaf = {};
    let type = DTCG_TYPE[v.type];
    if (v.type === "COLOR" && isHexish(bv) && !normHex(bv)) warn(`token '${v.name}' has malformed hex '${bv}'`);
    const dimension = v.type === "FLOAT" && unitDecision(v, opts) === "px";
    if (dimension) type = "dimension";
    const aliasRef = ref(v);
    let value = dtcgValue(webNumber(v, bv), colorProfile, dimension, aliasRef);
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
      for (const m of modeKeys) if (values[m] !== void 0) ext.modes[m] = dtcgValue(webNumber(v, values[m]), colorProfile, dimension, aliasRef);
    }
    if (typeof v.key === "string" && v.key) ext.key = v.key;
    if (isSentinel(v, bv)) ext.sentinel = { figmaValue: bv, meaning: "fully rounded \u2014 emitted as the platform idiom" };
    if (v.scopes && v.scopes.length) ext.scopes = v.scopes;
    if (v.codeSyntax && Object.keys(v.codeSyntax).length) ext.codeSyntax = v.codeSyntax;
    if (v.type === "BOOLEAN") ext.originalType = "boolean";
    if (Object.keys(ext).length) leaf.$extensions = { "figma.com": ext };
    node[leafKey] = leaf;
  }
  return root;
}
function toDTCG(designSystem, warnings, opts, notes) {
  const warn = (m) => {
    if (warnings) warnings.push(m);
  };
  const collections = (designSystem || {}).collections;
  const plan = dtcgPlan(designSystem);
  const tree = buildTree(designSystem, warn, opts, (v) => baseValue(v, collections), true, plan);
  if (notes) notes.push(...plan.notes);
  else for (const m of collisionMessages(plan.notes, opts)) warn(m);
  return tree;
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
function cssValue(raw, unit, ref) {
  if (isAlias(raw)) return "var(" + (ref ? ref(raw.aliasOf) : cssVarName(raw.aliasOf)) + ")";
  const e = isHexish(raw) ? normHex(raw) : null;
  if (e) return "#" + e;
  const fmtNum = (s) => s === "0" ? "0" : unit ? s + unit : s;
  if (typeof raw === "number") return fmtNum(String(raw));
  if (typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw)) return fmtNum(raw);
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "string") return cssEscapeText(raw);
  return String(raw);
}
function cssPlan(designSystem) {
  const ds = designSystem || {};
  return planIds(
    ds.variables || [],
    (v) => segs(v.name).length ? cssVarName(v.name) : null,
    (id, s) => id + "-" + s,
    ds.collections,
    "tokens.css",
    (v) => cssVarName(v.name) === "--" + segs(v.name).join("-")
  );
}
function toCSS(designSystem, opts, notes) {
  const collections = designSystem && designSystem.collections || [];
  const vars = designSystem && designSystem.variables || [];
  const selectorFor = (mode) => opts && opts.selector ? opts.selector(mode) : `[data-theme="${cssAttrEscape(mode)}"]`;
  const plan = cssPlan(designSystem);
  if (notes) notes.push(...plan.notes);
  const ref = (referrer) => (name) => {
    const t = aliasTarget(plan, name, referrer);
    return t ? plan.id(t) : cssVarName(name);
  };
  const rootLines = /* @__PURE__ */ new Map();
  const perMode = /* @__PURE__ */ Object.create(null);
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    if (!plan.canonical.has(v)) continue;
    const values = v.values || {};
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === void 0) continue;
    const baseStr = JSON.stringify(base);
    const unit = numberUnit(v, opts);
    const varName = plan.id(v);
    const r = ref(v);
    rootLines.set(varName, `  ${varName}: ${cssValue(webNumber(v, base), unit, r)};`);
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === void 0) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      (perMode[m] || (perMode[m] = /* @__PURE__ */ new Map())).set(varName, `  ${varName}: ${cssValue(webNumber(v, values[m]), unit, r)};`);
    }
  }
  let out = rootLines.size ? ":root {\n" + [...rootLines.values()].join("\n") + "\n}\n" : "";
  for (const m of Object.keys(perMode)) out += `
${selectorFor(m)} {
` + [...perMode[m].values()].join("\n") + "\n}\n";
  return out;
}
var TW_NAMESPACE = { color: "--color-", dimension: "--spacing-", radius: "--radius-", fontSize: "--text-", fontFamily: "--font-" };
var TW_PREFIX = "figma-";
function twSlug(name) {
  const slug = segs(name).join("-").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug || "token";
}
function twName(v, opts) {
  const kind = twKind(v, opts);
  return (kind ? TW_NAMESPACE[kind] : "--") + TW_PREFIX + twSlug(v.name);
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
function toTailwind(designSystem, opts, notes) {
  const collections = designSystem && designSystem.collections || [];
  const vars = designSystem && designSystem.variables || [];
  const plan = planIds(
    vars,
    (v) => segs(v.name).length ? twName(v, opts) : null,
    (id, s) => id + "-" + s,
    collections,
    "theme.css",
    (v) => /^[A-Za-z0-9-]+$/.test(segs(v.name).join("-"))
  );
  const warnings = [];
  if (notes) notes.push(...plan.notes);
  else warnings.push(...collisionMessages(plan.notes, opts));
  const theme = /* @__PURE__ */ new Map();
  const perMode = /* @__PURE__ */ Object.create(null);
  let utilities = 0;
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    if (!plan.canonical.has(v)) continue;
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === void 0) continue;
    const name = plan.id(v);
    if (twKind(v, opts)) utilities++;
    const unit = numberUnit(v, opts);
    const ref = (n) => {
      const t = aliasTarget(plan, n, v);
      return t ? plan.id(t) : "--" + TW_PREFIX + twSlug(n);
    };
    const val = (raw) => cssValue(webNumber(v, raw), unit, ref);
    const baseStr = JSON.stringify(base);
    theme.set(name, `  ${name}: ${val(base)};`);
    const values = v.values || {};
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === void 0) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      (perMode[m] || (perMode[m] = /* @__PURE__ */ new Map())).set(name, `  ${name}: ${val(values[m])};`);
    }
  }
  let out = '@import "tailwindcss";\n/* GENERATED by Design Twin (tokens.js --web tailwind) \u2014 do not edit by hand; re-run after a token pull.\n   Every design-system variable sits under a `figma-` name (rounded-figma-xl, p-figma-space-4, bg-figma-\u2026),\n   so Tailwind\'s own scale (rounded-xl, p-4, \u2026) keeps its framework meaning. */\n';
  if (theme.size) out += "\n@theme {\n" + [...theme.values()].join("\n") + "\n}\n";
  for (const m of Object.keys(perMode)) out += `
[data-theme="${cssAttrEscape(m)}"] {
` + [...perMode[m].values()].join("\n") + "\n}\n";
  return { text: out, utilities, tokens: theme.size, warnings };
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
  const plan = dtcgPlan(ds);
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
    const base = buildTree(sub, warn, opts, (v) => baseValue(v, collections), false, plan);
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
      }, false, plan);
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
  const notes = [];
  toDTCG(designSystem, warnings, opts, notes);
  notes.push(...cssPlan(designSystem).notes);
  warnings.push(...collisionMessages(notes, opts));
  lintNames(designSystem, opts, warnings);
  return dedupe(warnings);
}
var dedupe = (list) => [...new Set(list)];
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
  }
  return warnings;
}
function emitTokens(designSystem, opts) {
  const warnings = [];
  const notes = [];
  const dtcg = toDTCG(designSystem, warnings, opts, notes);
  const css = toCSS(designSystem, opts, notes);
  const tailwind = opts && opts.tailwind ? toTailwind(designSystem, opts, notes) : void 0;
  const { resolver, files } = toResolver(designSystem, warnings, opts);
  const collisions = collisionMessages(notes, opts);
  lintNames(designSystem, opts, warnings);
  return { dtcg, css, tailwind, resolver, resolverFiles: files, warnings: dedupe(collisions.concat(warnings)), collisions };
}
module.exports = { toDTCG, toCSS, toResolver, toTailwind, lintTokens, emitTokens, hexToColorValue, cssVarName, TW_PREFIX, WEB_FULL_ROUND };
Object.assign(module.exports, require_tokens_native()({ segs, isAlias, normHex, defaultModeName, baseValue, unitDecision, isSentinel }));
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
  const { dtcg, css, tailwind, resolver, resolverFiles, warnings } = emitTokens(ds, { tailwind: web !== void 0, sources: require_slice_sources().sourcesOf(ds, input, fs, path) });
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
    const tw = tailwind;
    const file = WEB_TARGETS[web];
    fs.writeFileSync(path.join(outDir, file), tw.text);
    nativeNote += ` + ${file}`;
    if (tw.tokens && !tw.utilities) warnings.push(`--web ${web}: no variable mapped to a Tailwind namespace, so ${file} generates no utilities \u2014 every token is a plain custom property you must reference with var()`);
    else if (tw.tokens > tw.utilities) warnings.push(`--web ${web}: ${tw.tokens - tw.utilities} of ${tw.tokens} token(s) match no Tailwind namespace (unitless FLOATs like opacity/font-weight, non-font strings) \u2014 emitted as plain --figma-* properties, usable via var() but generating no utility`);
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
