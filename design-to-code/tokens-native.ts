// tokens-native.ts — Figma variables → ONE checked-in native token file per platform.
//
// Why this exists: tokens.ts emits DTCG + CSS, which is all a web build needs. A native build had
// nothing — so the agent hand-mapped "color/primary" to a Swift/Kotlin/Dart symbol per screen, and two
// screens built in separate sessions could disagree about what that symbol is. One generated file that
// every screen imports turns "map every time" into "map once".
//
// Why not Style Dictionary / Terrazzo: checked 2026-09 — Style Dictionary (v5.5) does not read DTCG
// 2025.10 or the Resolver module yet (style-dictionary#1590, open), and its native formats are one
// file per theme; Terrazzo has a Swift plugin but none for Compose or Dart. This emitter reads the same
// design-system/tokens.json tokens.ts does, so modes survive into the output.
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
//
// Opacity. Figma's opacity numbers are PERCENTAGES, 0–100 (REST API variables types,
// https://developers.figma.com/docs/rest-api/variables-types/: VariableComposedColor.opacity is "An
// opacity percentage from 0 to 100, or an alias to a FLOAT variable"; VariableScope "OPACITY corresponds
// to layer opacity, while COLOR_OPACITY corresponds to the opacity channel of a color"). Every platform
// below takes opacity as a 0–1 fraction, so an OPACITY / COLOR_OPACITY-scoped FLOAT (tokens.ts
// percentOpacity — the same test that gives it `N%` in tokens.css and unit "percent" in DTCG) is written
// as clamp(N)/100 (clamp: color.ts clampOpacityPct, as Figma clamps):
//   swiftui       Double   — View.opacity(_ opacity: Double) / Color.opacity(_:), 0…1 (developer.apple.com/documentation/swiftui/view/opacity(_:))
//   compose       Float    — Modifier.alpha(alpha: Float) / Color.copy(alpha = …), 0f…1f (developer.android.com/reference/kotlin/androidx/compose/ui/draw/package-summary#(androidx.compose.ui.Modifier).alpha(kotlin.Float))
//   flutter       double   — Opacity(opacity: …) and Color.withValues(alpha: …) (Color.withOpacity(double) before Flutter 3.27), 0.0…1.0 (api.flutter.dev/flutter/widgets/Opacity/opacity.html)
//   react-native  number   — the `opacity` style prop, 0…1 (reactnative.dev/docs/view-style-props#opacity)
// A name-heuristic or opts.unitless FLOAT carries no evidence of Figma's scale and stays verbatim, as it
// does in tokens.css. A COMPOSED colour is folded into one colour literal: the colour half's alpha ×
// clamp(opacity)/100 (color.ts composeAlpha — the multiply is an inference, see there), each half
// resolved through the same alias resolution as a plain colour.
import type { TokensDoc, Variable, VariableAlias, VariableCollection, VariableValue } from "./types.ts";
import { normHex, parseHex, formatHex, composeAlpha, clampOpacityPct } from "./color.ts";

/** The px-vs-unitless override every emitter honours (tokens.ts unitDecision): the names a caller declared unitless. */
export interface UnitOpts {
  unitless?: { has: (name: string) => boolean };
}
/** tokens.ts unitDecision(): WHO decided a FLOAT's unit. */
export type UnitDecision = "override" | "scopes" | "name" | "px";
/** What toNative takes beside the design system. */
export interface NativeOpts extends UnitOpts {
  /** Kotlin package of the Compose file (default `design.tokens`). */
  package?: string;
}

// tokens.ts hands its helpers in (names, default modes, aliases, units must agree with the DTCG/CSS
// output) rather than this file importing tokens.ts back: an import cycle makes the bundler wrap
// tokens.ts as an inner module, and its `import.meta.main` CLI guard then never fires.
// (Colour parsing is NOT one of them: color.ts imports nothing, so it is imported directly.)
/** The seven tokens.ts helpers this emitter is built from — typed from their definitions there. */
export interface NativeHelpers {
  segs: (name: string | null | undefined) => string[];
  isAlias: (v: unknown) => v is VariableAlias;
  defaultModeName: (variable: Variable, collections: VariableCollection[] | undefined) => string | undefined;
  baseValue: (variable: Variable, collections: VariableCollection[] | undefined, def?: string) => VariableValue | undefined;
  unitDecision: (variable: Variable, opts?: UnitOpts) => UnitDecision;
  isSentinel: (v: Variable | null | undefined, raw: unknown) => boolean;
  /** an OPACITY / COLOR_OPACITY-scoped FLOAT (Figma's 0–100 percentage) — tokens.ts percentOpacity */
  percentOpacity: (variable: Variable, opts?: UnitOpts) => boolean;
}

type NativeKind = "color" | "bool" | "string" | "fontSize" | "dimension" | "number";
/** A resolved (alias-free) per-mode value, or the "fully rounded" marker. */
type Concrete = string | number | boolean | typeof FULL;
interface NativeMode { name: string; id: string }
interface NativeField { id: string; kind: NativeKind; source: string; values: Record<string, Concrete> }
/** The generated type's name: `<Collection>Tokens`, or `<Collection>Tokens<n>` when two collections fold onto one. */
type NativeTypeName = `${string}Tokens` | `${string}Tokens${number}`;
interface NativeCollection { name: string; type: NativeTypeName; modes: [NativeMode, ...NativeMode[]]; default: string; defaultId: string; fields: NativeField[] }
interface Candidate { v: Variable; kind: NativeKind; values: Record<string, Concrete>; id: string; final?: string }
type Emit = (cols: NativeCollection[], opts?: NativeOpts) => string;
export interface NativeFile { file: string; text: string; warnings: string[] }

// Figma's "fully rounded" corner exports as 1e9 (see isSentinel in tokens.ts). A field holding it is
// written as each platform's own idiom — never as the literal (livetest-3 #96).
const FULL = Object.freeze({ fullyRounded: true });

export default function nativeEmitter({ segs, isAlias, defaultModeName, baseValue, unitDecision, isSentinel, percentOpacity }: NativeHelpers) {

// A plain string-keyed object on purpose (as the JS was): `platformOf` looks a caller's word up in it
// with a truthiness test, so an inherited name behaves exactly as it did.
const PLATFORMS: Record<string, { file: string }> = {
  swiftui: { file: "DesignTokens.swift" },
  compose: { file: "DesignTokens.kt" },
  flutter: { file: "design_tokens.dart" },
  "react-native": { file: "designTokens.ts" },
};
// build-screen profile names → the platform key above.
const PROFILE_ALIASES: Record<string, string> = { "android-compose": "compose", ios: "swiftui", swift: "swiftui", android: "compose", rn: "react-native", dart: "flutter" };

// Union of the four languages' reserved words that a token path can realistically spell.
const RESERVED = new Set(("default,class,object,in,is,as,do,if,else,for,while,return,var,val,let,func,fun,import,package,switch,case,break," +
  "continue,true,false,null,nil,self,super,this,new,static,final,const,enum,struct,extension,protocol,init,internal,public,private,open,operator," +
  "typealias,interface,when,try,catch,throw,void,with,get,set,dynamic,external,factory,mixin,part,required,show,hide,on,type,function,delete," +
  "export,yield,await,async,inout,repeat,guard,defer,where,any,some,lerp,copyWith,hashCode,toString,description").split(","));

const words = (s: string): string[] => String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
function camel(parts: string[]): string {
  const w = parts.flatMap(words);
  let id = w.map((x, i) => (i === 0 ? x.charAt(0).toLowerCase() + x.slice(1) : x.charAt(0).toUpperCase() + x.slice(1))).join("");
  if (!id) id = "token";
  if (/^[0-9]/.test(id)) id = "n" + id;
  if (RESERVED.has(id)) id += "Token";
  return id;
}
const pascal = (parts: string[]): string => { const c = camel(parts); return c.charAt(0).toUpperCase() + c.slice(1); };

// A font size must scale with the user's setting on Android (sp), a spacing must not (dp). Scopes say
// so when the designer narrowed them; Figma's default is ALL_SCOPES, so fall back to the name.
function isFontSize(v: Variable): boolean {
  const scopes = v.scopes || [];
  if (scopes.length && !scopes.every((s) => s === "ALL_SCOPES")) return scopes.includes("FONT_SIZE");
  return /font.?size|text.?size|type.?size/i.test((v.collection ?? "") + "/" + v.name);
}

function kindOf(v: Variable, opts?: NativeOpts): NativeKind | null {
  if (v.type === "COLOR") return "color";
  if (v.type === "BOOLEAN") return "bool";
  if (v.type === "STRING") return "string";
  if (v.type === "FLOAT") return unitDecision(v, opts) === "px" ? (isFontSize(v) ? "fontSize" : "dimension") : "number";
  return null;
}

const isComposed = (x: unknown): boolean => !!x && typeof x === "object" && "composed" in x;
const isNativeScalar =(x: unknown): x is string | number | boolean => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
function resolve(byName: Map<string, Variable>, collections: VariableCollection[], v: Variable, mode: string, seen?: Set<string>): string | number | boolean | undefined {
  const values = v.values || {};
  let raw: VariableValue | undefined = values[mode];
  if (raw === undefined) raw = baseValue(v, collections, defaultModeName(v, collections));
  const next = new Set(seen || []).add(v.name);
  // One alias hop: into the target's same-named mode when it has one, else its default mode.
  const follow = (a: VariableAlias): string | number | boolean | undefined => {
    const target = byName.get(a.aliasOf);
    if (!target || (seen && seen.has(target.name))) return undefined;
    const tMode = target.values && target.values[mode] !== undefined ? mode : defaultModeName(target, collections);
    // no mode at all: the target has no values, so resolving it yields undefined, as it always did
    if (tMode === undefined) return undefined;
    return resolve(byName, collections, target, tMode, next);
  };
  // A composed colour (doc-types ComposedColor) folds into ONE hex: each half a literal or an alias
  // resolved like any other, the opacity a 0–100 percentage applied by color.ts composeAlpha (see the
  // header). Either half unresolved -> undefined, and model() reports the token as skipped.
  if (raw && typeof raw === "object" && "composed" in raw) {
    const { color, opacity } = raw.composed;
    const c = typeof color === "string" ? color : isAlias(color) ? follow(color) : undefined;
    const o = typeof opacity === "number" ? opacity : isAlias(opacity) ? follow(opacity) : undefined;
    const rgba = parseHex(c);
    if (!rgba || typeof o !== "number" || !Number.isFinite(o)) return undefined;
    return formatHex({ ...rgba, a: composeAlpha(rgba.a, o) });
  }
  if (!isAlias(raw)) return isNativeScalar(raw) ? raw : undefined; // a motion OBJECT (EASING/TIMING) has no native literal
  return follow(raw);
}
// An opacity FLOAT's resolved number (a number, or a string-number FLOAT); null when it is neither.
const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;
function opacityNumber(r: string | number | boolean): number | null {
  const n = typeof r === "number" ? r : typeof r === "string" && NUMERIC_TEXT.test(r) ? Number(r) : NaN;
  return Number.isFinite(n) ? n : null;
}

// → [{ name, type, modes:[{name,id}], default, fields:[{id, kind, source, values:{modeName: concrete}}] }]
function model(designSystem: TokensDoc | null | undefined, warnings: string[], opts?: NativeOpts): NativeCollection[] {
  const collections = (designSystem && designSystem.collections) || [];
  const vars = (designSystem && designSystem.variables) || [];
  const byName = new Map(vars.map((v): [string, Variable] => [v.name, v]));
  const typeNames = new Set<string>();
  const out: NativeCollection[] = [];
  for (const c of collections) {
    const mine = vars.filter((v) => v.collection === c.name);
    const modeNames = (c.modes && c.modes.length ? c.modes : [...new Set(mine.flatMap((v) => Object.keys(v.values || {})))]).map(String);
    const [firstModeName, ...otherModeNames] = modeNames;
    if (!mine.length || firstModeName === undefined) continue;
    let type: NativeTypeName = `${pascal([c.name])}Tokens`;
    for (let n = 2; typeNames.has(type); n++) type = `${pascal([c.name])}Tokens${n}`;
    typeNames.add(type);
    const ids = new Set<string>();
    const fields: NativeField[] = [];
    const cands: Candidate[] = [];
    for (const v of mine) {
      const kind = kindOf(v, opts);
      if (!segs(v.name).length) continue;
      if (!kind) { warnings.push(`${v.name}: skipped — a ${v.type} variable has no native token form (only COLOR, FLOAT, STRING and BOOLEAN are emitted)`); continue; }
      // An opacity FLOAT is written as a 0–1 fraction (see the header); every other value verbatim.
      const pct = kind === "number" && percentOpacity(v, opts);
      const values: Record<string, Concrete> = {};
      let ok = true;
      for (const m of modeNames) {
        const r = resolve(byName, collections, v, m);
        if (r === undefined || (kind === "color" && !normHex(r))) { ok = false; break; }
        if (pct) {
          const n = opacityNumber(r);
          if (n === null) { ok = false; break; }
          const clamped = clampOpacityPct(n);
          if (clamped !== n) warnings.push(`${v.name} (mode ${m}): opacity ${n} is outside Figma's 0–100 range; clamped to ${clamped} (as Figma does) and written as ${clamped / 100}`);
          values[m] = clamped / 100;
          continue;
        }
        values[m] = isSentinel && isSentinel(v, r) ? FULL : r;
      }
      // A composed colour (colour + separate opacity) whose halves did not both resolve to a hex and a
      // number here (an alias to a variable that was not exported?) has no native literal.
      if (!ok && Object.values(v.values || {}).some(isComposed)) {
        warnings.push(`${v.name}: skipped — a composed colour (colour + separate opacity) whose colour or opacity could not be resolved inside this file has no native literal; tokens.dtcg.json carries it (colour reference in $value, opacity in $extensions["figma.com"].opacity)`);
        continue;
      }
      if (!ok) { warnings.push(`${v.name}: skipped — its value could not be resolved inside this file (an alias to a library variable that was not exported?)`); continue; }
      cands.push({ v, kind, values, id: camel(segs(v.name)) });
    }
    // Two variables on one identifier (livetest-3 #44: two `Space 4`, 24 and 16, distinct keys).
    // Identical in every mode → one field, nothing lost. Otherwise BOTH are real, and neither may win by
    // arriving first: every one of them carries its key (`space4_e26d506e`), so the identifier says which
    // Figma variable it is. A bare counter (`space42`) said nothing and read as a number.
    const tag = (v: Variable): string | null => (v.key ? String(v.key).slice(0, 8).toLowerCase() : null);
    const label = (x: Candidate): string => `${x.v.name}${x.v.key ? ` (key ${tag(x.v)}…)` : ""} = ${JSON.stringify(x.v.values || {})}`;
    const byId = new Map<string, [Candidate, ...Candidate[]]>();
    for (const x of cands) { const list = byId.get(x.id); if (list) list.push(x); else byId.set(x.id, [x]); }
    for (const [id, list] of byId) {
      const distinct: [Candidate, ...Candidate[]] = [list[0]]; // the first is always distinct
      for (const x of list.slice(1)) if (!distinct.some((d) => JSON.stringify(d.values) === JSON.stringify(x.values))) distinct.push(x);
      if (list.length > distinct.length) warnings.push(`${list.map(label).join(" and ")}: identical in every mode, so "${id}" in ${type} is emitted once`);
      if (distinct.length === 1) { distinct[0].final = id; continue; }
      // Different NAMES on one identifier (`Space 3` vs `(Space 3)`): the name that spells the identifier
      // with nothing folded away keeps it (else the first, as before); the SAME name twice has no
      // rightful owner, so every copy carries its key.
      const sameName = distinct.every((x) => x.v.name === distinct[0].v.name);
      const lossless = distinct.filter((x) => /^[A-Za-z0-9 /_-]+$/.test(String(x.v.name)));
      const keeper = sameName ? null : lossless.length === 1 ? lossless[0] : distinct[0];
      const names: string[] = [];
      distinct.forEach((x, i) => {
        if (x === keeper) { x.final = id; ids.add(id); names.push(`${label(x)} → "${id}"`); return; }
        let next = tag(x.v) ? `${id}_${tag(x.v)}` : `${id}${i + 1}`;
        for (let n = 2; ids.has(next) || byId.has(next); n++) next = (tag(x.v) ? `${id}_${tag(x.v)}` : id) + n;
        ids.add(next);
        x.final = next;
        names.push(`${label(x)} → "${next}"`);
      });
      warnings.push(`${distinct.length} different variables fold onto "${id}" in ${type} and DIFFER — none is dropped: ${names.join("; ")}`);
    }
    for (const x of cands) {
      if (!x.final) continue;
      if (ids.has(x.final) && fields.some((f) => f.id === x.final)) continue;
      ids.add(x.final);
      fields.push({ id: x.final, kind: x.kind, source: x.v.name, values: x.values });
    }
    if (!fields.length) continue;
    // The JVM caps a constructor at 255 parameters; a multi-mode collection becomes a data class.
    // The JVM caps a method at 255 parameter UNITS, not parameters (JVMS §4.3.3): long/double take two,
    // and Compose's Color (a value class over ULong) and TextUnit (over Long) compile to long. The
    // tightest method is the data class's synthetic copy$default: every field + one Int mask per 32
    // fields + the receiver + a marker. An all-Color collection therefore tops out near 120 fields.
    const units = fields.reduce((n, f) => n + (f.kind === "color" || f.kind === "fontSize" ? 2 : 1), 0) + Math.ceil(fields.length / 32) + 2;
    if (modeNames.length > 1 && units > 255) warnings.push(`${c.name}: ${fields.length} tokens in one multi-mode collection need ${units} JVM parameter units (Color and TextUnit count double) — over the 255 limit, so the Compose data class will not compile; split the collection in Figma`);
    const modeIds = new Set<string>();
    const modeOf = (name: string): NativeMode => {
      let id = camel([name]);
      if (ids.has(id)) id += "Mode"; // a token literally named "light" must not collide with the Light instance
      for (let n = 2, base = id; modeIds.has(id); n++) id = base + n;
      modeIds.add(id);
      return { name, id };
    };
    const modes: [NativeMode, ...NativeMode[]] = [modeOf(firstModeName), ...otherModeNames.map(modeOf)];
    // modes[i].name === modeNames[i] (built just above), so "the first mode named c.default, else the first
    // mode" is the mode whose name is `modeNames.includes(c.default) ? c.default : firstModeName`.
    const defMode = modes.find((m) => m.name === String(c.default)) ?? modes[0];
    out.push({ name: c.name, type, modes, default: defMode.name, defaultId: defMode.id, fields });
  }
  return out;
}

const num = (raw: unknown): string => { const n = Number(raw); return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : "0"; };
const str = (raw: unknown): string => JSON.stringify(String(raw));
const bool = (raw: unknown): string => String(raw === true || raw === "true"); // every target spells it true/false
// Only ever called on a "color" field, whose every value model() has already passed through normHex
// (a value that fails it drops the whole field) — so a null here is a bug in this file, said loudly.
const hexOf = (raw: unknown): string => { const h = normHex(raw); if (h === null) throw new Error(`tokens-native: colour value ${JSON.stringify(raw)} was not validated`); return h; };
const argb = (raw: unknown): string => { const h = hexOf(raw); return "0x" + (h.length === 9 ? h.slice(7) + h.slice(1, 7) : "ff" + h.slice(1)).toUpperCase(); };
// model() drops any field that fails to resolve in one of its collection's modes, so every field has a
// value for every mode — a miss here is a bug in this file, said loudly (as hexOf does).
const valueIn = (f: NativeField, mode: string): Concrete => { const r = f.values[mode]; if (r === undefined) throw new Error(`tokens-native: field ${f.id} has no value for mode ${JSON.stringify(mode)}`); return r; };
const HEADER = "GENERATED by Design Twin (tokens.js --native) from design-system/tokens.json — do not edit by hand; re-run after a token pull.";

// ------------------------------------------------------------------------------------ compose
function compose(cols: NativeCollection[], opts?: NativeOpts): string {
  const T: Record<NativeKind, string> = { color: "Color", dimension: "Dp", fontSize: "TextUnit", number: "Float", bool: "Boolean", string: "String" };
  const lit = (k: NativeKind, r: Concrete): string => r === FULL ? (k === "fontSize" ? "9999.sp" : k === "number" ? "9999f" : "9999.dp /* Figma 'fully rounded' — use CircleShape */") : k === "color" ? `Color(${argb(r)})` : k === "dimension" ? `${num(r)}.dp` : k === "fontSize" ? `${num(r)}.sp` : k === "number" ? `${num(r)}f` : k === "bool" ? bool(r) : str(r).replace(/\$/g, "\\$");
  const L = [`// ${HEADER}`, `package ${(opts && opts.package) || "design.tokens"}`, "",
    "import androidx.compose.runtime.Immutable", "import androidx.compose.runtime.staticCompositionLocalOf", "import androidx.compose.ui.graphics.Color",
    "import androidx.compose.ui.unit.Dp", "import androidx.compose.ui.unit.TextUnit", "import androidx.compose.ui.unit.dp", "import androidx.compose.ui.unit.sp"];
  for (const c of cols) {
    L.push("", `// Figma collection "${c.name}"`);
    const [m0, m1] = c.modes;
    if (m1 === undefined) {
      L.push(`object ${c.type} {`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]} = ${lit(f.kind, valueIn(f, m0.name))} // ${f.source}`), "}");
      continue;
    }
    L.push("@Immutable", `data class ${c.type}(`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]}, // ${f.source}`), ")");
    for (const m of c.modes) L.push("", `val ${c.type}${pascal([m.id])} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id} = ${lit(f.kind, valueIn(f, m.name))},`), ")");
    // The first mode whose NAME is not the default's (the hint names a theme the way a designer would). If
    // every mode shares the default's name — a shape doc-guards.ts does not reject — fall back to the
    // second mode by id (ids are unique, modeIds above) instead of the TypeError this used to be.
    const active = c.modes.find((m) => m.name !== c.default) ?? m1;
    L.push("", `// Provide the active mode once, near the root: CompositionLocalProvider(Local${c.type} provides ${c.type}${pascal([active.id])}) { … }`,
      `val Local${c.type} = staticCompositionLocalOf { ${c.type}${pascal([c.defaultId])} }`);
  }
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------ swiftui
// Only a light/dark pair follows the system color scheme. Any other axis (desktop/mobile, brand,
// contrast) is the app's decision — name a real member instead of `.dark`, which would not compile.
function swiftModeHint(c: NativeCollection): string {
  const ids = c.modes.map((m) => m.id);
  if (ids.includes("light") && ids.includes("dark")) return "colorScheme == .dark ? .dark : .light" + (ids.length > 2 ? ` /* also: ${ids.filter((i) => i !== "light" && i !== "dark").map((i) => "." + i).join(", ")} */` : "");
  return `.${(c.modes.find((m) => m.name !== c.default) || c.modes[0]).id} /* one of: ${ids.map((i) => "." + i).join(", ")} — the app picks */`;
}

function swiftui(cols: NativeCollection[]): string {
  const T: Record<NativeKind, string> = { color: "Color", dimension: "CGFloat", fontSize: "CGFloat", number: "Double", bool: "Bool", string: "String" };
  const chan = (h: string, i: number): string => num(parseInt(h.slice(i, i + 2), 16) / 255);
  const lit = (k: NativeKind, r: Concrete): string => {
    if (r === FULL) return ".infinity";
    if (k === "color") { const h = hexOf(r); return `Color(.sRGB, red: ${chan(h, 1)}, green: ${chan(h, 3)}, blue: ${chan(h, 5)}, opacity: ${h.length === 9 ? chan(h, 7) : "1"})`; }
    // Swift spells a unicode escape \u{1F}, not JSON's \u001f — the only escape the two disagree on.
    return k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}") : num(r);
  };
  const L = [`// ${HEADER}`, "import SwiftUI"];
  for (const c of cols) {
    L.push("", `// Figma collection "${c.name}"`);
    if (c.modes.length === 1) {
      L.push(`public enum ${c.type} {`, ...c.fields.map((f) => `    public static let ${f.id}: ${T[f.kind]} = ${lit(f.kind, valueIn(f, c.modes[0].name))} // ${f.source}`), "}");
      continue;
    }
    // Sendable: the `static let` modes below are globals, which Swift 6 rejects for a non-Sendable type
    // (a PUBLIC struct is never inferred Sendable). Equatable: lets SwiftUI skip work when the
    // environment value did not change. The explicit init is public because the synthesized one is
    // internal — a DesignSystem package's consumer could not build a variant theme (preview, white-label).
    L.push(`public struct ${c.type}: Sendable, Equatable {`, ...c.fields.map((f) => `    public let ${f.id}: ${T[f.kind]} // ${f.source}`), "",
      `    public init(${c.fields.map((f) => `${f.id}: ${T[f.kind]}`).join(", ")}) {`, ...c.fields.map((f) => `        self.${f.id} = ${f.id}`), "    }");
    for (const m of c.modes) L.push("", `    public static let ${m.id} = ${c.type}(`, c.fields.map((f) => `        ${f.id}: ${lit(f.kind, valueIn(f, m.name))}`).join(",\n"), "    )");
    const env = c.type.charAt(0).toLowerCase() + c.type.slice(1);
    const defId = c.defaultId;
    L.push("}", "", `private struct ${c.type}Key: EnvironmentKey { static let defaultValue = ${c.type}.${defId} }`,
      "public extension EnvironmentValues {", `    // Set once near the root: .environment(\\.${env}, ${swiftModeHint(c)}); read with @Environment(\\.${env}).`,
      `    var ${env}: ${c.type} {`, `        get { self[${c.type}Key.self] }`, `        set { self[${c.type}Key.self] = newValue }`, "    }", "}");
  }
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------ flutter
function flutter(cols: NativeCollection[]): string {
  const T: Record<NativeKind, string> = { color: "Color", dimension: "double", fontSize: "double", number: "double", bool: "bool", string: "String" };
  const lit = (k: NativeKind, r: Concrete): string => r === FULL ? "double.infinity" : k === "color" ? `Color(${argb(r)})` : k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\$/g, "\\$") : num(r);
  const lerp = (f: NativeField): string => f.kind === "color" ? `Color.lerp(${f.id}, other.${f.id}, t)!` : T[f.kind] === "double" ? `lerpDouble(${f.id}, other.${f.id}, t)!` : `t < 0.5 ? ${f.id} : other.${f.id}`;
  const L = [`// ${HEADER}`, "// ignore_for_file: constant_identifier_names", "import 'dart:ui' show lerpDouble;", "", "import 'package:flutter/material.dart';"];
  for (const c of cols) {
    L.push("", `/// Figma collection "${c.name}"`);
    if (c.modes.length === 1) {
      L.push(`abstract final class ${c.type} {`, ...c.fields.map((f) => `  static const ${T[f.kind]} ${f.id} = ${lit(f.kind, valueIn(f, c.modes[0].name))}; // ${f.source}`), "}");
      continue;
    }
    L.push(`/// Register per theme: ThemeData(extensions: [${c.type}.${c.modes[0].id}]); read: Theme.of(context).extension<${c.type}>()!`, "@immutable",
      `class ${c.type} extends ThemeExtension<${c.type}> {`, `  const ${c.type}({`, ...c.fields.map((f) => `    required this.${f.id},`), "  });", "",
      ...c.fields.map((f) => `  final ${T[f.kind]} ${f.id}; // ${f.source}`));
    for (const m of c.modes) L.push("", `  static const ${m.id} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id}: ${lit(f.kind, valueIn(f, m.name))},`), "  );");
    L.push("", "  @override", `  ${c.type} copyWith({`, ...c.fields.map((f) => `    ${T[f.kind]}? ${f.id},`), "  }) {", `    return ${c.type}(`,
      ...c.fields.map((f) => `      ${f.id}: ${f.id} ?? this.${f.id},`), "    );", "  }", "", "  @override",
      `  ${c.type} lerp(ThemeExtension<${c.type}>? other, double t) {`, `    if (other is! ${c.type}) return this;`, `    return ${c.type}(`,
      ...c.fields.map((f) => `      ${f.id}: ${lerp(f)},`), "    );", "  }", "}");
  }
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------ react-native
function reactNative(cols: NativeCollection[]): string {
  const T: Record<NativeKind, string> = { color: "string", dimension: "number", fontSize: "number", number: "number", bool: "boolean", string: "string" };
  const lit = (k: NativeKind, r: Concrete): string => r === FULL ? "9999" : k === "color" ? str(hexOf(r)) : k === "bool" ? bool(r) : k === "string" ? str(r) : num(r);
  const L = [`// ${HEADER}`, "// Numbers are density-independent units, as React Native styles expect. Pick a mode with useColorScheme()."];
  for (const c of cols) {
    const v = c.type.charAt(0).toLowerCase() + c.type.slice(1);
    L.push("", `/** Figma collection "${c.name}" */`);
    if (c.modes.length === 1) {
      L.push(`export const ${v} = {`, ...c.fields.map((f) => `  ${f.id}: ${lit(f.kind, valueIn(f, c.modes[0].name))}, // ${f.source}`), "} as const;");
      continue;
    }
    L.push(`export interface ${c.type} {`, ...c.fields.map((f) => `  ${f.id}: ${T[f.kind]}; // ${f.source}`), "}", "",
      `export type ${c.type}Mode = ${c.modes.map((m) => str(m.id)).join(" | ")};`, `export const ${v}DefaultMode: ${c.type}Mode = ${str(c.defaultId)};`, "",
      `export const ${v}: Record<${c.type}Mode, ${c.type}> = {`);
    for (const m of c.modes) L.push(`  ${m.id}: {`, ...c.fields.map((f) => `    ${f.id}: ${lit(f.kind, valueIn(f, m.name))},`), "  },");
    L.push("};");
  }
  return L.join("\n") + "\n";
}

const EMIT: Record<string, Emit> = { compose, swiftui, flutter, "react-native": reactNative };

function platformOf(name: unknown): string | null {
  const key = String(name || "").toLowerCase();
  const p = PROFILE_ALIASES[key] || key;
  return PLATFORMS[p] ? p : null;
}

// → { file, text, warnings[] }. `platform` accepts a build-screen profile name too (android-compose).
function toNative(designSystem: TokensDoc | null | undefined, platform: unknown, opts?: NativeOpts): NativeFile {
  const p = platformOf(platform);
  if (!p) throw new Error(`unknown native platform "${String(platform)}" — use one of: ${Object.keys(PLATFORMS).join(", ")}`);
  const warnings: string[] = [];
  const cols = model(designSystem, warnings, opts);
  // platformOf accepted p by a truthiness test on PLATFORMS, and EMIT has the same keys (and the same
  // inherited ones), so this never fires
  const target = PLATFORMS[p], emit = EMIT[p];
  if (target === undefined || emit === undefined) throw new Error(`tokens-native: platform "${p}" has no emitter`);
  return { file: target.file, text: emit(cols, opts), warnings };
}

return { toNative, platformOf, PLATFORMS };
}
