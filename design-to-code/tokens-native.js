// tokens-native.js — Figma variables → ONE checked-in native token file per platform.
//
// Why this exists: tokens.js emits DTCG + CSS, which is all a web build needs. A native build had
// nothing — so the agent hand-mapped "color/primary" to a Swift/Kotlin/Dart symbol per screen, and two
// screens built in separate sessions could disagree about what that symbol is. One generated file that
// every screen imports turns "map every time" into "map once".
//
// Why not Style Dictionary / Terrazzo: checked 2026-09 — Style Dictionary (v5.5) does not read DTCG
// 2025.10 or the Resolver module yet (style-dictionary#1590, open), and its native formats are one
// file per theme; Terrazzo has a Swift plugin but none for Compose or Dart. This emitter reads the same
// design-system/tokens.json tokens.js does, so modes survive into the output.
//
// The shape of each file follows that platform's own documented pattern for a custom design system:
//   compose       @Immutable data class + one instance per mode + staticCompositionLocalOf
//                 (developer.android.com/develop/ui/compose/designsystems/custom)
//   flutter       ThemeExtension<T> with copyWith + lerp (api.flutter.dev ThemeExtension)
//   swiftui       struct + static instance per mode + an EnvironmentValues entry
//   react-native  plain typed objects keyed by mode (RN has no token API; useColorScheme picks the key)
// A collection with ONE mode has nothing to switch, so it becomes plain constants instead.
//
// Aliases are RESOLVED per mode (a native constant cannot reference "whatever the theme says"), into
// the alias target's same-named mode when it has one, else its default mode. An alias that leaves the
// file (a library variable that was not exported) is skipped with a warning, never guessed.

// tokens.js hands its helpers in (names, default modes, aliases, units must agree with the DTCG/CSS
// output) rather than this file requiring tokens.js back: a require cycle makes the bundler wrap
// tokens.js as an inner module, and its `require.main === module` CLI guard then never fires.
module.exports = function nativeEmitter({ segs, isAlias, normHex, defaultModeName, baseValue, unitDecision }) {

const PLATFORMS = {
  swiftui: { file: "DesignTokens.swift" },
  compose: { file: "DesignTokens.kt" },
  flutter: { file: "design_tokens.dart" },
  "react-native": { file: "designTokens.ts" },
};
// build-screen profile names → the platform key above.
const PROFILE_ALIASES = { "android-compose": "compose", ios: "swiftui", swift: "swiftui", android: "compose", rn: "react-native", dart: "flutter" };

// Union of the four languages' reserved words that a token path can realistically spell.
const RESERVED = new Set(("default,class,object,in,is,as,do,if,else,for,while,return,var,val,let,func,fun,import,package,switch,case,break," +
  "continue,true,false,null,nil,self,super,this,new,static,final,const,enum,struct,extension,protocol,init,internal,public,private,open,operator," +
  "typealias,interface,when,try,catch,throw,void,with,get,set,dynamic,external,factory,mixin,part,required,show,hide,on,type,function,delete," +
  "export,yield,await,async,inout,repeat,guard,defer,where,any,some,lerp,copyWith,hashCode,toString,description").split(","));

const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
function camel(parts) {
  const w = parts.flatMap(words);
  let id = w.map((x, i) => (i === 0 ? x.charAt(0).toLowerCase() + x.slice(1) : x.charAt(0).toUpperCase() + x.slice(1))).join("");
  if (!id) id = "token";
  if (/^[0-9]/.test(id)) id = "n" + id;
  if (RESERVED.has(id)) id += "Token";
  return id;
}
const pascal = (parts) => { const c = camel(parts); return c.charAt(0).toUpperCase() + c.slice(1); };

// A font size must scale with the user's setting on Android (sp), a spacing must not (dp). Scopes say
// so when the designer narrowed them; Figma's default is ALL_SCOPES, so fall back to the name.
function isFontSize(v) {
  const scopes = v.scopes || [];
  if (scopes.length && !scopes.every((s) => s === "ALL_SCOPES")) return scopes.includes("FONT_SIZE");
  return /font.?size|text.?size|type.?size/i.test(v.collection + "/" + v.name);
}

function kindOf(v, opts) {
  if (v.type === "COLOR") return "color";
  if (v.type === "BOOLEAN") return "bool";
  if (v.type === "STRING") return "string";
  if (v.type === "FLOAT") return unitDecision(v, opts) === "px" ? (isFontSize(v) ? "fontSize" : "dimension") : "number";
  return null;
}

function resolve(byName, collections, v, mode, seen) {
  const values = v.values || {};
  let raw = values[mode];
  if (raw === undefined) raw = baseValue(v, collections, defaultModeName(v, collections));
  if (!isAlias(raw)) return raw;
  const target = byName.get(raw.aliasOf);
  if (!target || (seen && seen.has(target.name))) return undefined;
  const next = new Set(seen || []).add(v.name);
  const tMode = target.values && target.values[mode] !== undefined ? mode : defaultModeName(target, collections);
  return resolve(byName, collections, target, tMode, next);
}

// → [{ name, type, modes:[{name,id}], default, fields:[{id, kind, source, values:{modeName: concrete}}] }]
function model(designSystem, warnings, opts) {
  const collections = (designSystem && designSystem.collections) || [];
  const vars = (designSystem && designSystem.variables) || [];
  const byName = new Map(vars.map((v) => [v.name, v]));
  const typeNames = new Set();
  const out = [];
  for (const c of collections) {
    const mine = vars.filter((v) => v.collection === c.name);
    const modeNames = (c.modes && c.modes.length ? c.modes : [...new Set(mine.flatMap((v) => Object.keys(v.values || {})))]).map(String);
    if (!mine.length || !modeNames.length) continue;
    let type = pascal([c.name]) + "Tokens";
    for (let n = 2; typeNames.has(type); n++) type = pascal([c.name]) + "Tokens" + n;
    typeNames.add(type);
    const ids = new Set();
    const fields = [];
    for (const v of mine) {
      const kind = kindOf(v, opts);
      if (!kind || !segs(v.name).length) continue;
      const values = {};
      let ok = true;
      for (const m of modeNames) {
        const r = resolve(byName, collections, v, m);
        if (r === undefined || (kind === "color" && !normHex(r))) { ok = false; break; }
        values[m] = r;
      }
      if (!ok) { warnings.push(`${v.name}: skipped — its value could not be resolved inside this file (an alias to a library variable that was not exported?)`); continue; }
      let id = camel(segs(v.name));
      if (ids.has(id)) { let n = 2; while (ids.has(id + n)) n++; warnings.push(`${v.name}: "${id}" is already taken in ${type} — emitted as "${id + n}"`); id += n; }
      ids.add(id);
      fields.push({ id, kind, source: v.name, values });
    }
    if (!fields.length) continue;
    // The JVM caps a constructor at 255 parameters; a multi-mode collection becomes a data class.
    // The JVM caps a method at 255 parameter UNITS, not parameters (JVMS §4.3.3): long/double take two,
    // and Compose's Color (a value class over ULong) and TextUnit (over Long) compile to long. The
    // tightest method is the data class's synthetic copy$default: every field + one Int mask per 32
    // fields + the receiver + a marker. An all-Color collection therefore tops out near 120 fields.
    const units = fields.reduce((n, f) => n + (f.kind === "color" || f.kind === "fontSize" ? 2 : 1), 0) + Math.ceil(fields.length / 32) + 2;
    if (modeNames.length > 1 && units > 255) warnings.push(`${c.name}: ${fields.length} tokens in one multi-mode collection need ${units} JVM parameter units (Color and TextUnit count double) — over the 255 limit, so the Compose data class will not compile; split the collection in Figma`);
    const modeIds = new Set();
    const modes = modeNames.map((name) => {
      let id = camel([name]);
      if (ids.has(id)) id += "Mode"; // a token literally named "light" must not collide with the Light instance
      for (let n = 2, base = id; modeIds.has(id); n++) id = base + n;
      modeIds.add(id);
      return { name, id };
    });
    const def = modeNames.includes(String(c.default)) ? String(c.default) : modeNames[0];
    out.push({ name: c.name, type, modes, default: def, defaultId: modes.find((m) => m.name === def).id, fields });
  }
  return out;
}

const num = (raw) => { const n = Number(raw); return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : "0"; };
const str = (raw) => JSON.stringify(String(raw));
const bool = (raw) => String(raw === true || raw === "true"); // every target spells it true/false
const argb = (raw) => { const h = normHex(raw); return "0x" + (h.length === 8 ? h.slice(6) + h.slice(0, 6) : "ff" + h).toUpperCase(); };
const HEADER = "GENERATED by Design Twin (tokens.js --native) from design-system/tokens.json — do not edit by hand; re-run after a token pull.";

// ------------------------------------------------------------------------------------ compose
function compose(cols, opts) {
  const T = { color: "Color", dimension: "Dp", fontSize: "TextUnit", number: "Float", bool: "Boolean", string: "String" };
  const lit = (k, r) => k === "color" ? `Color(${argb(r)})` : k === "dimension" ? `${num(r)}.dp` : k === "fontSize" ? `${num(r)}.sp` : k === "number" ? `${num(r)}f` : k === "bool" ? bool(r) : str(r).replace(/\$/g, "\\$");
  const L = [`// ${HEADER}`, `package ${(opts && opts.package) || "design.tokens"}`, "",
    "import androidx.compose.runtime.Immutable", "import androidx.compose.runtime.staticCompositionLocalOf", "import androidx.compose.ui.graphics.Color",
    "import androidx.compose.ui.unit.Dp", "import androidx.compose.ui.unit.TextUnit", "import androidx.compose.ui.unit.dp", "import androidx.compose.ui.unit.sp"];
  for (const c of cols) {
    L.push("", `// Figma collection "${c.name}"`);
    if (c.modes.length === 1) {
      L.push(`object ${c.type} {`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]} = ${lit(f.kind, f.values[c.modes[0].name])} // ${f.source}`), "}");
      continue;
    }
    L.push("@Immutable", `data class ${c.type}(`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]}, // ${f.source}`), ")");
    for (const m of c.modes) L.push("", `val ${c.type}${pascal([m.id])} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id} = ${lit(f.kind, f.values[m.name])},`), ")");
    L.push("", `// Provide the active mode once, near the root: CompositionLocalProvider(Local${c.type} provides ${c.type}${pascal([c.modes.find((m) => m.name !== c.default).id])}) { … }`,
      `val Local${c.type} = staticCompositionLocalOf { ${c.type}${pascal([c.defaultId])} }`);
  }
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------ swiftui
// Only a light/dark pair follows the system color scheme. Any other axis (desktop/mobile, brand,
// contrast) is the app's decision — name a real member instead of `.dark`, which would not compile.
function swiftModeHint(c) {
  const ids = c.modes.map((m) => m.id);
  if (ids.includes("light") && ids.includes("dark")) return "colorScheme == .dark ? .dark : .light" + (ids.length > 2 ? ` /* also: ${ids.filter((i) => i !== "light" && i !== "dark").map((i) => "." + i).join(", ")} */` : "");
  return `.${(c.modes.find((m) => m.name !== c.default) || c.modes[0]).id} /* one of: ${ids.map((i) => "." + i).join(", ")} — the app picks */`;
}

function swiftui(cols) {
  const T = { color: "Color", dimension: "CGFloat", fontSize: "CGFloat", number: "Double", bool: "Bool", string: "String" };
  const chan = (h, i) => num(parseInt(h.slice(i, i + 2), 16) / 255);
  const lit = (k, r) => {
    if (k === "color") { const h = normHex(r); return `Color(.sRGB, red: ${chan(h, 0)}, green: ${chan(h, 2)}, blue: ${chan(h, 4)}, opacity: ${h.length === 8 ? chan(h, 6) : "1"})`; }
    // Swift spells a unicode escape \u{1F}, not JSON's \u001f — the only escape the two disagree on.
    return k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}") : num(r);
  };
  const L = [`// ${HEADER}`, "import SwiftUI"];
  for (const c of cols) {
    L.push("", `// Figma collection "${c.name}"`);
    if (c.modes.length === 1) {
      L.push(`public enum ${c.type} {`, ...c.fields.map((f) => `    public static let ${f.id}: ${T[f.kind]} = ${lit(f.kind, f.values[c.modes[0].name])} // ${f.source}`), "}");
      continue;
    }
    // Sendable: the `static let` modes below are globals, which Swift 6 rejects for a non-Sendable type
    // (a PUBLIC struct is never inferred Sendable). Equatable: lets SwiftUI skip work when the
    // environment value did not change. The explicit init is public because the synthesized one is
    // internal — a DesignSystem package's consumer could not build a variant theme (preview, white-label).
    L.push(`public struct ${c.type}: Sendable, Equatable {`, ...c.fields.map((f) => `    public let ${f.id}: ${T[f.kind]} // ${f.source}`), "",
      `    public init(${c.fields.map((f) => `${f.id}: ${T[f.kind]}`).join(", ")}) {`, ...c.fields.map((f) => `        self.${f.id} = ${f.id}`), "    }");
    for (const m of c.modes) L.push("", `    public static let ${m.id} = ${c.type}(`, c.fields.map((f) => `        ${f.id}: ${lit(f.kind, f.values[m.name])}`).join(",\n"), "    )");
    const env = c.type.charAt(0).toLowerCase() + c.type.slice(1);
    const defId = c.defaultId;
    L.push("}", "", `private struct ${c.type}Key: EnvironmentKey { static let defaultValue = ${c.type}.${defId} }`,
      "public extension EnvironmentValues {", `    // Set once near the root: .environment(\\.${env}, ${swiftModeHint(c)}); read with @Environment(\\.${env}).`,
      `    var ${env}: ${c.type} {`, `        get { self[${c.type}Key.self] }`, `        set { self[${c.type}Key.self] = newValue }`, "    }", "}");
  }
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------ flutter
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
    L.push(`/// Register per theme: ThemeData(extensions: [${c.type}.${c.modes[0].id}]); read: Theme.of(context).extension<${c.type}>()!`, "@immutable",
      `class ${c.type} extends ThemeExtension<${c.type}> {`, `  const ${c.type}({`, ...c.fields.map((f) => `    required this.${f.id},`), "  });", "",
      ...c.fields.map((f) => `  final ${T[f.kind]} ${f.id}; // ${f.source}`));
    for (const m of c.modes) L.push("", `  static const ${m.id} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id}: ${lit(f.kind, f.values[m.name])},`), "  );");
    L.push("", "  @override", `  ${c.type} copyWith({`, ...c.fields.map((f) => `    ${T[f.kind]}? ${f.id},`), "  }) {", `    return ${c.type}(`,
      ...c.fields.map((f) => `      ${f.id}: ${f.id} ?? this.${f.id},`), "    );", "  }", "", "  @override",
      `  ${c.type} lerp(ThemeExtension<${c.type}>? other, double t) {`, `    if (other is! ${c.type}) return this;`, `    return ${c.type}(`,
      ...c.fields.map((f) => `      ${f.id}: ${lerp(f)},`), "    );", "  }", "}");
  }
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------ react-native
function reactNative(cols) {
  const T = { color: "string", dimension: "number", fontSize: "number", number: "number", bool: "boolean", string: "string" };
  const lit = (k, r) => k === "color" ? str("#" + normHex(r)) : k === "bool" ? bool(r) : k === "string" ? str(r) : num(r);
  const L = [`// ${HEADER}`, "// Numbers are density-independent units, as React Native styles expect. Pick a mode with useColorScheme()."];
  for (const c of cols) {
    const v = c.type.charAt(0).toLowerCase() + c.type.slice(1);
    L.push("", `/** Figma collection "${c.name}" */`);
    if (c.modes.length === 1) {
      L.push(`export const ${v} = {`, ...c.fields.map((f) => `  ${f.id}: ${lit(f.kind, f.values[c.modes[0].name])}, // ${f.source}`), "} as const;");
      continue;
    }
    L.push(`export interface ${c.type} {`, ...c.fields.map((f) => `  ${f.id}: ${T[f.kind]}; // ${f.source}`), "}", "",
      `export type ${c.type}Mode = ${c.modes.map((m) => str(m.id)).join(" | ")};`, `export const ${v}DefaultMode: ${c.type}Mode = ${str(c.defaultId)};`, "",
      `export const ${v}: Record<${c.type}Mode, ${c.type}> = {`);
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

// → { file, text, warnings[] }. `platform` accepts a build-screen profile name too (android-compose).
function toNative(designSystem, platform, opts) {
  const p = platformOf(platform);
  if (!p) throw new Error(`unknown native platform "${platform}" — use one of: ${Object.keys(PLATFORMS).join(", ")}`);
  const warnings = [];
  const cols = model(designSystem, warnings, opts);
  return { file: PLATFORMS[p].file, text: EMIT[p](cols, opts), warnings };
}

return { toNative, platformOf, PLATFORMS };
};
